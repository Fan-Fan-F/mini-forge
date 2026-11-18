// graphql.ts — a small GraphQL parser and executor for POST /api/graphql: the queries, mutations,
// introspection probes, cursor pagination and operation batching that gh-shaped clients send.
// It executes over the same forge.ts state as REST, so both surfaces always agree.

import { decodeGid, encodeGid, type Forge, type IssueRec, type PullRec, type Repo } from './forge.ts';

// ----------------------------------------------------------------------------------------------
// tokenizer
// ----------------------------------------------------------------------------------------------

interface Tok {
  t: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread';
  v: string;
}

function tokenize(source: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.startsWith('...', i)) {
      toks.push({ t: 'spread', v: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      toks.push({ t: 'punct', v: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const text = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        toks.push({ t: 'string', v: text });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === 'u') {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      toks.push({ t: 'string', v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      toks.push({ t: isFloat ? 'float' : 'int', v: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j])) j += 1;
      toks.push({ t: 'name', v: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return toks;
}

// ----------------------------------------------------------------------------------------------
// parser
// ----------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  varDefaults: Map<string, ValueNode>;
  selection: SelectionNode[];
}

interface FragmentNode {
  typeCondition: string;
  selection: SelectionNode[];
}

class Parser {
  private readonly toks: Tok[];
  private pos = 0;

  constructor(source: string) {
    this.toks = tokenize(source);
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }

  private next(): Tok {
    const tok = this.toks[this.pos];
    if (!tok) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return tok;
  }

  private expectPunct(v: string): void {
    const tok = this.next();
    if (tok.t !== 'punct' || tok.v !== v) throw new Error(`expected '${v}', found '${tok.v}'`);
  }

  private skipPunct(v: string): boolean {
    const tok = this.peek();
    if (tok && tok.t === 'punct' && tok.v === v) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.pos < this.toks.length) {
      const tok = this.peek();
      if (!tok) break;
      if (tok.t === 'punct' && tok.v === '{') {
        operations.push({ type: 'query', name: null, varDefaults: new Map(), selection: this.parseSelectionSet() });
        continue;
      }
      if (tok.t === 'name' && (tok.v === 'query' || tok.v === 'mutation' || tok.v === 'subscription')) {
        this.next();
        let name: string | null = null;
        const nameTok = this.peek();
        if (nameTok && nameTok.t === 'name') name = this.next().v;
        const varDefaults = new Map<string, ValueNode>();
        if (this.peek()?.v === '(') this.parseVariableDefinitions(varDefaults);
        this.skipDirectives();
        operations.push({
          type: tok.v === 'mutation' ? 'mutation' : 'query',
          name,
          varDefaults,
          selection: this.parseSelectionSet(),
        });
        continue;
      }
      if (tok.t === 'name' && tok.v === 'fragment') {
        this.next();
        const fragName = this.next().v;
        const onTok = this.next();
        if (onTok.v !== 'on') throw new Error('fragment without type condition');
        const typeCondition = this.next().v;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token '${tok.v}' in GraphQL document`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(varDefaults: Map<string, ValueNode>): void {
    this.expectPunct('(');
    for (;;) {
      if (this.skipPunct(')')) return;
      this.expectPunct('$');
      const name = this.next().v;
      this.expectPunct(':');
      this.skipType();
      if (this.skipPunct('=')) varDefaults.set(name, this.parseValue());
      this.skipDirectives();
    }
  }

  private skipType(): void {
    const tok = this.peek();
    if (tok && tok.t === 'punct' && tok.v === '[') {
      this.next();
      this.skipType();
      this.expectPunct(']');
    } else {
      this.next();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek()?.v === '@') {
      this.next();
      this.next();
      if (this.peek()?.v === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const tok = this.peek();
      if (!tok) throw new Error('unterminated selection set');
      if (tok.t === 'punct' && tok.v === '}') {
        this.next();
        return selections;
      }
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): SelectionNode {
    const tok = this.peek();
    if (tok && tok.t === 'spread') {
      this.next();
      const nameTok = this.peek();
      if (nameTok && nameTok.t === 'name' && nameTok.v === 'on') {
        this.next();
        const typeCondition = this.next().v;
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      if (nameTok && nameTok.t === 'name') {
        const name = this.next().v;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      return { kind: 'inline', typeCondition: null, selection: this.parseSelectionSet() };
    }
    return { kind: 'field', field: this.parseField() };
  }

  private parseField(): FieldNode {
    let name = this.next().v;
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.next().v;
    }
    const args = this.peek()?.v === '(' ? this.parseArguments() : [];
    this.skipDirectives();
    const selection = this.peek()?.v === '{' ? this.parseSelectionSet() : null;
    return { alias, name, args, selection };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    for (;;) {
      if (this.skipPunct(')')) return args;
      const name = this.next().v;
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
  }

  private parseValue(): ValueNode {
    const tok = this.next();
    if (tok.t === 'punct' && tok.v === '$') return { kind: 'var', name: this.next().v };
    if (tok.t === 'string') return { kind: 'string', value: tok.v };
    if (tok.t === 'int' || tok.t === 'float') return { kind: 'number', value: Number(tok.v) };
    if (tok.t === 'punct' && tok.v === '[') {
      const items: ValueNode[] = [];
      for (;;) {
        if (this.skipPunct(']')) return { kind: 'list', items };
        items.push(this.parseValue());
      }
    }
    if (tok.t === 'punct' && tok.v === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      for (;;) {
        if (this.skipPunct('}')) return { kind: 'object', fields };
        const name = this.next().v;
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
    }
    if (tok.t === 'name') {
      if (tok.v === 'true') return { kind: 'boolean', value: true };
      if (tok.v === 'false') return { kind: 'boolean', value: false };
      if (tok.v === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.v };
    }
    throw new Error(`unexpected value token '${tok.v}'`);
  }
}

// ----------------------------------------------------------------------------------------------
// schema and execution
// ----------------------------------------------------------------------------------------------

type Wrapper = Record<string, unknown> & { __type: string };

function wrap(type: string, props: Record<string, unknown>): Wrapper {
  return { __type: type, ...props };
}

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  varDefaults: Map<string, ValueNode>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function evalValue(ctx: ExecCtx, node: ValueNode): unknown {
  switch (node.kind) {
    case 'var': {
      if (node.name in ctx.variables) return ctx.variables[node.name];
      const fallback = ctx.varDefaults.get(node.name);
      return fallback ? evalValue(ctx, fallback) : null;
    }
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => evalValue(ctx, item));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(ctx, field.value);
      return out;
    }
  }
}

function argsOf(ctx: ExecCtx, field: FieldNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(ctx, arg.value);
  return out;
}

type Resolver = (ctx: ExecCtx, parent: Wrapper, args: Record<string, unknown>) => unknown;

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INTERFACE';
  fields?: Record<string, Resolver>;
  enumValues?: string[];
}

const userWrapper = (forge: Forge): Wrapper => wrap('User', { login: forge.ownerLogin });
const repoWrapper = (repo: Repo): Wrapper => wrap('Repository', { repo });
const issueWrapper = (repo: Repo, issue: IssueRec): Wrapper => wrap('Issue', { repo, issue });
const pullWrapper = (repo: Repo, pull: PullRec): Wrapper => wrap('PullRequest', { repo, pull });
const pageInfo = (hasNext: boolean, hasPrev: boolean, start: string | null, end: string | null): Wrapper =>
  wrap('PageInfo', { hasNextPage: hasNext, hasPreviousPage: hasPrev, startCursor: start, endCursor: end });

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

interface ConnectionSpec<T> {
  items: T[];
  first: unknown;
  after: unknown;
}

function paginate<T>(spec: ConnectionSpec<T>): { slice: T[]; info: Wrapper } {
  const afterIndex = indexOfCursor(spec.after);
  const start = afterIndex >= 0 ? afterIndex + 1 : 0;
  const first = typeof spec.first === 'number' && Number.isFinite(spec.first) ? Math.max(0, Math.trunc(spec.first)) : 100;
  const slice = spec.items.slice(start, start + first);
  const endIndex = start + slice.length - 1;
  const info = pageInfo(
    start + slice.length < spec.items.length,
    start > 0,
    slice.length > 0 ? cursorOf(start) : null,
    slice.length > 0 ? cursorOf(endIndex) : null,
  );
  return { slice, info };
}

function repoIssuesConnection(ctx: ExecCtx, repo: Repo, args: Record<string, unknown>): Wrapper {
  let list = [...repo.issues.values()];
  if (Array.isArray(args.states) && args.states.length > 0) {
    const wanted = new Set(args.states.map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? null) as Record<string, unknown> | null;
  const direction = orderBy && typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
  list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  const { slice, info } = paginate({ items: list, first: args.first, after: args.after });
  return wrap('IssueConnection', { nodes: slice.map((issue) => issueWrapper(repo, issue)), pageInfo: info, totalCount: list.length });
}

function repoPullsConnection(ctx: ExecCtx, repo: Repo, args: Record<string, unknown>): Wrapper {
  const list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
  const { slice, info } = paginate({ items: list, first: args.first, after: args.after });
  return wrap('PullRequestConnection', { nodes: slice.map((pull) => pullWrapper(repo, pull)), pageInfo: info, totalCount: list.length });
}

function pullState(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: (ctx) => userWrapper(ctx.forge),
      repository: (ctx, _parent, args) => {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        ctx.forge.learnLogin(owner);
        if (ctx.forge.login !== null && owner !== ctx.forge.login) return null;
        const repo = ctx.forge.repoByName(name);
        return repo ? repoWrapper(repo) : null;
      },
      node: (ctx, _parent, args) => nodeById(ctx.forge, String(args.id ?? '')),
      __type: (_ctx, _parent, args) => {
        const name = String(args.name ?? '');
        return name in SCHEMA ? wrap('__Type', { name }) : null;
      },
      __schema: () => wrap('__Schema', {}),
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: (ctx, _parent, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoFromGid(ctx.forge, String(input.repositoryId ?? ''));
        if (!repo) throw new Error('Could not resolve the repository for createIssue');
        const issue = ctx.forge.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        return wrap('CreateIssuePayload', { issue: issueWrapper(repo, issue) });
      },
      closeIssue: (ctx, _parent, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueFromGid(ctx.forge, String(input.issueId ?? ''));
        if (!found) throw new Error('Could not resolve the issue for closeIssue');
        found.issue.state = 'closed';
        found.issue.updatedAtSec = ctx.forge.tick();
        return wrap('CloseIssuePayload', { issue: issueWrapper(found.repo, found.issue) });
      },
      createPullRequest: (ctx, _parent, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoFromGid(ctx.forge, String(input.repositoryId ?? ''));
        if (!repo) throw new Error('Could not resolve the repository for createPullRequest');
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        const headTip = ctx.forge.branchTip(repo, head);
        const baseTip = ctx.forge.branchTip(repo, base);
        if (headTip === null || baseTip === null) throw new Error('The head or base branch does not exist');
        if (headTip === baseTip) throw new Error('No commits between the base and the head');
        const pull = ctx.forge.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
        return wrap('CreatePullRequestPayload', { pullRequest: pullWrapper(repo, pull) });
      },
      mergePullRequest: (ctx, _parent, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = pullFromGid(ctx.forge, String(input.pullRequestId ?? ''));
        if (!found) throw new Error('Could not resolve the pull request for mergePullRequest');
        if (found.pull.state !== 'open') throw new Error('Pull request is not mergeable');
        const methodRaw = String(input.mergeMethod ?? 'MERGE');
        const method = methodRaw === 'MERGE' ? 'merge' : 'squash';
        const sha = ctx.forge.mergePull(found.repo, found.pull, method);
        if (sha === null) throw new Error('Pull request is not mergeable');
        return wrap('MergePullRequestPayload', { pullRequest: pullWrapper(found.repo, found.pull) });
      },
      addComment: (ctx, _parent, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueFromGid(ctx.forge, String(input.subjectId ?? ''));
        if (!found) throw new Error('Could not resolve the subject for addComment');
        const comment = ctx.forge.addComment(found.repo, found.issue, String(input.body ?? ''));
        const node = wrap('IssueComment', { repo: found.repo, comment });
        return wrap('AddCommentPayload', { commentEdge: wrap('AddCommentEdge', { node }) });
      },
    },
  },
  User: {
    kind: 'OBJECT',
    fields: {
      login: (_ctx, parent) => parent.login,
      id: () => Buffer.from('user:1', 'utf8').toString('base64url'),
      name: (ctx) => ctx.forge.ownerLogin,
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: (_ctx, parent) => encodeGid('repo', (parent.repo as Repo).dbId, 0),
      databaseId: (_ctx, parent) => (parent.repo as Repo).dbId,
      name: (_ctx, parent) => (parent.repo as Repo).name,
      nameWithOwner: (ctx, parent) => `${ctx.forge.ownerLogin}/${(parent.repo as Repo).name}`,
      owner: (ctx) => userWrapper(ctx.forge),
      description: (_ctx, parent) => (parent.repo as Repo).description,
      isPrivate: (_ctx, parent) => (parent.repo as Repo).isPrivate,
      defaultBranchRef: (ctx, parent) => {
        const repo = parent.repo as Repo;
        return ctx.forge.branchTip(repo, repo.defaultBranch) === null ? null : wrap('Ref', { name: repo.defaultBranch });
      },
      viewerPermission: () => 'ADMIN',
      hasIssuesEnabled: () => true,
      hasPullRequestsEnabled: () => true,
      createdAt: (ctx, parent) => ctx.forge.iso((parent.repo as Repo).createdAtSec),
      updatedAt: (ctx, parent) => ctx.forge.iso((parent.repo as Repo).createdAtSec),
      issue: (_ctx, parent, args) => {
        const repo = parent.repo as Repo;
        const issue = repo.issues.get(Number(args.number));
        return issue ? issueWrapper(repo, issue) : null;
      },
      issues: (ctx, parent, args) => repoIssuesConnection(ctx, parent.repo as Repo, args),
      pullRequest: (_ctx, parent, args) => {
        const repo = parent.repo as Repo;
        const pull = repo.pulls.get(Number(args.number));
        return pull ? pullWrapper(repo, pull) : null;
      },
      pullRequests: (ctx, parent, args) => repoPullsConnection(ctx, parent.repo as Repo, args),
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      name: (_ctx, parent) => parent.name,
      prefix: () => 'refs/heads/',
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: (_ctx, parent) => encodeGid('issue', (parent.repo as Repo).dbId, (parent.issue as IssueRec).number),
      number: (_ctx, parent) => (parent.issue as IssueRec).number,
      title: (_ctx, parent) => (parent.issue as IssueRec).title,
      body: (_ctx, parent) => (parent.issue as IssueRec).body,
      state: (_ctx, parent) => ((parent.issue as IssueRec).state === 'open' ? 'OPEN' : 'CLOSED'),
      createdAt: (ctx, parent) => ctx.forge.iso((parent.issue as IssueRec).createdAtSec),
      updatedAt: (ctx, parent) => ctx.forge.iso((parent.issue as IssueRec).updatedAtSec),
      comments: (_ctx, parent) => {
        const repo = parent.repo as Repo;
        const issue = parent.issue as IssueRec;
        return wrap('IssueCommentConnection', {
          nodes: issue.comments.map((comment) => wrap('IssueComment', { repo, comment })),
          totalCount: issue.comments.length,
        });
      },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: (_ctx, parent) => encodeGid('pull', (parent.repo as Repo).dbId, (parent.pull as PullRec).number),
      number: (_ctx, parent) => (parent.pull as PullRec).number,
      title: (_ctx, parent) => (parent.pull as PullRec).title,
      body: (_ctx, parent) => (parent.pull as PullRec).body,
      state: (_ctx, parent) => pullState(parent.pull as PullRec),
      merged: (_ctx, parent) => (parent.pull as PullRec).merged,
      headRefName: (_ctx, parent) => (parent.pull as PullRec).headRef,
      baseRefName: (_ctx, parent) => (parent.pull as PullRec).baseRef,
      mergeable: (ctx, parent) => {
        const repo = parent.repo as Repo;
        const pull = parent.pull as PullRec;
        if (pull.state !== 'open') return 'UNKNOWN';
        return ctx.forge.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      },
      files: (ctx, parent, args) => {
        const repo = parent.repo as Repo;
        const pull = parent.pull as PullRec;
        const all = ctx.forge.pullFiles(repo, pull);
        const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : all.length;
        return wrap('PullRequestChangedFileConnection', {
          nodes: all.slice(0, first).map((file) => wrap('PullRequestChangedFile', { path: file.filename, additions: file.additions, deletions: file.deletions })),
          totalCount: all.length,
        });
      },
      createdAt: (ctx, parent) => ctx.forge.iso((parent.pull as PullRec).createdAtSec),
      updatedAt: (ctx, parent) => ctx.forge.iso((parent.pull as PullRec).updatedAtSec),
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: (_ctx, parent) => parent.nodes,
      pageInfo: (_ctx, parent) => parent.pageInfo,
      totalCount: (_ctx, parent) => parent.totalCount,
    },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: (_ctx, parent) => parent.nodes,
      pageInfo: (_ctx, parent) => parent.pageInfo,
      totalCount: (_ctx, parent) => parent.totalCount,
    },
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: (_ctx, parent) => parent.nodes,
      totalCount: (_ctx, parent) => parent.totalCount,
    },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: (_ctx, parent) => parent.path,
      additions: (_ctx, parent) => parent.additions,
      deletions: (_ctx, parent) => parent.deletions,
    },
  },
  IssueCommentConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: (_ctx, parent) => parent.nodes,
      totalCount: (_ctx, parent) => parent.totalCount,
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: (_ctx, parent) => encodeGid('comment', (parent.repo as Repo).dbId, (parent.comment as { id: number }).id),
      body: (_ctx, parent) => (parent.comment as { body: string }).body,
      createdAt: (ctx, parent) => ctx.forge.iso((parent.comment as { createdAtSec: number }).createdAtSec),
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: (_ctx, parent) => parent.hasNextPage,
      hasPreviousPage: (_ctx, parent) => parent.hasPreviousPage,
      startCursor: (_ctx, parent) => parent.startCursor,
      endCursor: (_ctx, parent) => parent.endCursor,
    },
  },
  CreateIssuePayload: { kind: 'OBJECT', fields: { issue: (_ctx, parent) => parent.issue } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { issue: (_ctx, parent) => parent.issue } },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: (_ctx, parent) => parent.pullRequest } },
  MergePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: (_ctx, parent) => parent.pullRequest } },
  AddCommentPayload: { kind: 'OBJECT', fields: { commentEdge: (_ctx, parent) => parent.commentEdge } },
  AddCommentEdge: { kind: 'OBJECT', fields: { node: (_ctx, parent) => parent.node } },
  Node: { kind: 'INTERFACE', fields: { id: () => null } },
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: (_ctx, parent) => parent.name,
      kind: (_ctx, parent) => SCHEMA[String(parent.name)]?.kind ?? 'OBJECT',
      description: () => null,
      fields: (_ctx, parent) => {
        const def = SCHEMA[String(parent.name)];
        if (!def || def.kind === 'ENUM' || !def.fields) return null;
        return Object.keys(def.fields).map((name) => wrap('__Field', { name }));
      },
      enumValues: (_ctx, parent) => {
        const def = SCHEMA[String(parent.name)];
        if (!def || def.kind !== 'ENUM' || !def.enumValues) return null;
        return def.enumValues.map((name) => wrap('__EnumValue', { name }));
      },
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: (_ctx, parent) => parent.name,
      description: () => null,
      args: () => [],
      isDeprecated: () => false,
      deprecationReason: () => null,
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: {
      name: (_ctx, parent) => parent.name,
      description: () => null,
      isDeprecated: () => false,
      deprecationReason: () => null,
    },
  },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      queryType: () => wrap('__Type', { name: 'Query' }),
      mutationType: () => wrap('__Type', { name: 'Mutation' }),
    },
  },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
};

function repoFromGid(forge: Forge, gid: string): Repo | null {
  const decoded = decodeGid(gid);
  if (!decoded || decoded.kind !== 'repo') return null;
  return forge.repoByDbId(decoded.dbId) ?? null;
}

function issueFromGid(forge: Forge, gid: string): { repo: Repo; issue: IssueRec } | null {
  const decoded = decodeGid(gid);
  if (!decoded || decoded.kind !== 'issue') return null;
  const repo = forge.repoByDbId(decoded.dbId);
  if (!repo) return null;
  const issue = repo.issues.get(decoded.number);
  return issue ? { repo, issue } : null;
}

function pullFromGid(forge: Forge, gid: string): { repo: Repo; pull: PullRec } | null {
  const decoded = decodeGid(gid);
  if (!decoded || decoded.kind !== 'pull') return null;
  const repo = forge.repoByDbId(decoded.dbId);
  if (!repo) return null;
  const pull = repo.pulls.get(decoded.number);
  return pull ? { repo, pull } : null;
}

function nodeById(forge: Forge, gid: string): Wrapper | null {
  const decoded = decodeGid(gid);
  if (!decoded) return null;
  const repo = forge.repoByDbId(decoded.dbId);
  if (!repo) return null;
  if (decoded.kind === 'repo') return repoWrapper(repo);
  if (decoded.kind === 'issue') {
    const issue = repo.issues.get(decoded.number);
    return issue ? issueWrapper(repo, issue) : null;
  }
  if (decoded.kind === 'pull') {
    const pull = repo.pulls.get(decoded.number);
    return pull ? pullWrapper(repo, pull) : null;
  }
  for (const issue of repo.issues.values()) {
    const comment = issue.comments.find((candidate) => candidate.id === decoded.number);
    if (comment) return wrap('IssueComment', { repo, comment });
  }
  return null;
}

function executeSelectionSet(ctx: ExecCtx, parent: Wrapper, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeDef = SCHEMA[parent.__type];
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === parent.__type) {
        Object.assign(out, executeSelectionSet(ctx, parent, selection.selection));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment && fragment.typeCondition === parent.__type) {
        Object.assign(out, executeSelectionSet(ctx, parent, fragment.selection));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = parent.__type;
      continue;
    }
    const resolver = typeDef?.fields?.[field.name];
    if (!resolver) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${parent.__type}'` });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolver(ctx, parent, argsOf(ctx, field));
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, field.selection);
  }
  return out;
}

function completeValue(ctx: ExecCtx, value: unknown, selection: SelectionNode[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, selection));
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    if (selection === null) return null;
    return executeSelectionSet(ctx, value as Wrapper, selection);
  }
  return value;
}

function executeOne(forge: Forge, body: Record<string, unknown>): Record<string, unknown> {
  const query = String(body.query ?? '');
  let parsed: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    parsed = new Parser(query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (parsed.operations.length === 0) return { errors: [{ message: 'The document holds no operation' }] };
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation = operationName !== null ? parsed.operations.find((op) => op.name === operationName) ?? parsed.operations[0] : parsed.operations[0];
  const ctx: ExecCtx = {
    forge,
    variables: (body.variables ?? {}) as Record<string, unknown>,
    varDefaults: operation.varDefaults,
    fragments: parsed.fragments,
    errors: [],
  };
  const root = wrap(operation.type === 'mutation' ? 'Mutation' : 'Query', {});
  const data = executeSelectionSet(ctx, root, operation.selection);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Handle one POST /api/graphql body (a single operation, or an array for operation batching). */
export function handleGraphql(forge: Forge, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    const results = body.map((entry) => executeOne(forge, (entry ?? {}) as Record<string, unknown>));
    return { status: 200, body: results };
  }
  if (typeof body !== 'object' || body === null) {
    return { status: 400, body: { errors: [{ message: 'The request body is not a GraphQL operation' }] } };
  }
  return { status: 200, body: executeOne(forge, body as Record<string, unknown>) };
}
