// rest.ts — the REST v3 surface under /api/v3: users, repositories, contents, branches, refs,
// commits, labels, issues, comments and pull requests, all reading and writing forge.ts state.

import {
  commitDistances,
  parseCommit,
  parseTree,
  treeOfCommit,
  type GitObj,
} from './gitcore.ts';
import { encodeGid, type Forge, type IssueRec, type PullRec, type Repo } from './forge.ts';

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  host: string;
}

export interface RestResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function fail(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function notFound(): RestResult {
  return fail(404, 'Not Found');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ----------------------------------------------------------------------------------------------
// serializers
// ----------------------------------------------------------------------------------------------

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const owner = forge.ownerLogin;
  return {
    id: repo.dbId,
    node_id: encodeGid('repo', repo.dbId, 0),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: owner, id: 1, type: 'User' },
    description: repo.description,
    fork: false,
    created_at: forge.iso(repo.createdAtSec),
    updated_at: forge.iso(repo.createdAtSec),
    pushed_at: forge.iso(repo.createdAtSec),
    default_branch: repo.defaultBranch,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

export function issueJson(forge: Forge, repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.restId,
    node_id: encodeGid('issue', repo.dbId, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000', description: label?.description ?? null };
    }),
    comments: issue.comments.length,
    created_at: forge.iso(issue.createdAtSec),
    updated_at: forge.iso(issue.updatedAtSec),
    user: { login: forge.ownerLogin, id: 1, type: 'User' },
  };
}

/** A pull request in the issue shape (the issues API lists pull requests too, as on GitHub). */
export function pullAsIssueJson(forge: Forge, repo: Repo, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.restId,
    node_id: encodeGid('pull', repo.dbId, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    labels: [],
    pull_request: { url: '' },
    comments: 0,
    created_at: forge.iso(pull.createdAtSec),
    updated_at: forge.iso(pull.updatedAtSec),
    user: { login: forge.ownerLogin, id: 1, type: 'User' },
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: PullRec): Record<string, unknown> {
  const owner = forge.ownerLogin;
  return {
    id: pull.restId,
    node_id: encodeGid('pull', repo.dbId, pull.number),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: {
      ref: pull.headRef,
      sha: forge.branchTip(repo, pull.headRef) ?? '',
      label: `${owner}:${pull.headRef}`,
    },
    base: {
      ref: pull.baseRef,
      sha: forge.branchTip(repo, pull.baseRef) ?? '',
      label: `${owner}:${pull.baseRef}`,
    },
    merged: pull.merged,
    merged_at: pull.mergedAtSec === null ? null : forge.iso(pull.mergedAtSec),
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? forge.pullMergeable(repo, pull) : null,
    created_at: forge.iso(pull.createdAtSec),
    updated_at: forge.iso(pull.updatedAtSec),
    user: { login: owner, id: 1, type: 'User' },
  };
}

function commentJson(forge: Forge, repo: Repo, comment: { id: number; body: string; createdAtSec: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: encodeGid('comment', repo.dbId, comment.id),
    body: comment.body,
    created_at: forge.iso(comment.createdAtSec),
    updated_at: forge.iso(comment.createdAtSec),
    user: { login: forge.ownerLogin, id: 1, type: 'User' },
  };
}

// ----------------------------------------------------------------------------------------------
// the router
// ----------------------------------------------------------------------------------------------

export function handleRest(forge: Forge, req: RestRequest): RestResult {
  const seg = req.segments;
  if (seg.length === 0) {
    if (req.method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues?q={query}',
      },
    };
  }
  if (seg[0] === 'meta' && seg.length === 1) {
    if (req.method !== 'GET') return notFound();
    return { status: 200, body: { installed_version: '1.0.0-mini-forge', verifiable_password_authentication: false } };
  }
  if (seg[0] === 'user') return handleUser(forge, req, seg.slice(1));
  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = seg[1];
    forge.learnLogin(owner);
    if (forge.login !== null && owner !== forge.login) return notFound();
    const repo = forge.repoByName(seg[2]);
    if (!repo) return notFound();
    return handleRepo(forge, req, repo, seg.slice(3));
  }
  return notFound();
}

function handleUser(forge: Forge, req: RestRequest, rest: string[]): RestResult {
  if (rest.length === 0) {
    if (req.method !== 'GET') return notFound();
    return { status: 200, body: { login: forge.ownerLogin, id: 1, type: 'User', site_admin: false } };
  }
  if (rest[0] === 'repos' && rest.length === 1) {
    if (req.method === 'GET') return listOwnRepos(forge, req);
    if (req.method === 'POST') return createOwnRepo(forge, req);
  }
  return notFound();
}

function listOwnRepos(forge: Forge, req: RestRequest): RestResult {
  const perPageRaw = Number(req.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(req.query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const all = [...forge.repos.values()].sort((a, b) => a.dbId - b.dbId);
  const start = (page - 1) * perPage;
  const slice = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(all.length / perPage));
  if (page < lastPage) {
    const base = `http://${req.host}/api/v3/user/repos`;
    headers.link = `<${base}?page=${page + 1}&per_page=${perPage}>; rel="next", <${base}?page=${lastPage}&per_page=${perPage}>; rel="last"`;
  }
  return { status: 200, body: slice.map((repo) => repoJson(forge, repo)), headers };
}

function createOwnRepo(forge: Forge, req: RestRequest): RestResult {
  const body = req.body ?? {};
  const name = str(body.name);
  if (name === '') return fail(422, 'Repository creation failed.');
  if (forge.repoByName(name)) {
    return {
      status: 422,
      body: {
        message: 'Repository creation failed.',
        errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
      },
    };
  }
  const repo = forge.createRepo(name, str(body.description), body.private === true);
  return { status: 201, body: repoJson(forge, repo) };
}

function handleRepo(forge: Forge, req: RestRequest, repo: Repo, rest: string[]): RestResult {
  if (rest.length === 0) {
    if (req.method === 'GET') return { status: 200, body: repoJson(forge, repo) };
    if (req.method === 'PATCH') {
      const body = req.body ?? {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name && !forge.repoByName(body.name)) {
        forge.repos.delete(repo.name);
        repo.name = body.name;
        forge.repos.set(repo.name, repo);
      }
      return { status: 200, body: repoJson(forge, repo) };
    }
    if (req.method === 'DELETE') {
      forge.deleteRepo(repo.name);
      return { status: 204 };
    }
    return notFound();
  }
  const head = rest[0];
  if (head === 'contents') return handleContents(forge, req, repo, rest.slice(1).join('/'));
  if (head === 'branches') return handleBranches(forge, req, repo, rest.slice(1).join('/'));
  if (head === 'git' && rest[1] === 'refs') return handleGitRefs(forge, req, repo, rest.slice(2));
  if (head === 'commits') return handleCommits(forge, req, repo, rest.slice(1));
  if (head === 'issues') return handleIssues(forge, req, repo, rest.slice(1));
  if (head === 'labels') return handleLabels(forge, req, repo, rest.slice(1));
  if (head === 'pulls') return handlePulls(forge, req, repo, rest.slice(1));
  return notFound();
}

// ----------------------------------------------------------------------------------------------
// contents
// ----------------------------------------------------------------------------------------------

interface TreeHit {
  type: 'file' | 'dir';
  oid: string;
}

/** Walk a tree by path segments; returns what lives there, or null. */
function treeHit(store: Map<string, GitObj>, treeOid: string, segments: string[]): TreeHit | null {
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const tree = store.get(current);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      const target = store.get(entry.oid);
      return { type: target?.type === 'tree' ? 'dir' : 'file', oid: entry.oid };
    }
    current = entry.oid;
  }
  return { type: 'dir', oid: current };
}

function dirListing(repo: Repo, treeOid: string, prefix: string): Record<string, unknown>[] {
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return [];
  return parseTree(tree.data).map((entry) => {
    const isDir = repo.objects.get(entry.oid)?.type === 'tree';
    const item: Record<string, unknown> = {
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      type: isDir ? 'dir' : 'file',
    };
    if (!isDir) {
      const blob = repo.objects.get(entry.oid);
      item.size = blob ? blob.data.length : 0;
    }
    return item;
  });
}

function handleContents(forge: Forge, req: RestRequest, repo: Repo, path: string): RestResult {
  const body = req.body ?? {};
  const branch = req.method === 'GET' ? str(req.query.get('ref') ?? '') || repo.defaultBranch : str(body.branch) || repo.defaultBranch;
  if (req.method === 'GET') {
    const tip = forge.branchTip(repo, branch);
    if (tip === null) return notFound();
    const rootTree = treeOfCommit(repo.objects, tip);
    if (path === '') return { status: 200, body: dirListing(repo, rootTree, '') };
    const hit = treeHit(repo.objects, rootTree, path.split('/'));
    if (hit === null) return notFound();
    if (hit.type === 'dir') return { status: 200, body: dirListing(repo, hit.oid, path) };
    const blob = repo.objects.get(hit.oid);
    if (!blob) return notFound();
    return {
      status: 200,
      body: {
        type: 'file',
        name: path.split('/').pop(),
        path,
        sha: hit.oid,
        size: blob.data.length,
        encoding: 'base64',
        content: blob.data.toString('base64'),
      },
    };
  }
  if (req.method === 'PUT') {
    if (path === '') return fail(422, 'Validation Failed: no path');
    const contentBase64 = str(body.content).replace(/\s+/g, '');
    const content = Buffer.from(contentBase64, 'base64');
    const message = str(body.message) || `Update ${path}`;
    const tip = forge.branchTip(repo, branch);
    let flat: Map<string, { oid: string; mode: string }>;
    let parent: string | null | undefined;
    if (tip !== null) {
      flat = forge.flatAt(repo, tip);
      parent = undefined; // commitFlat defaults the parent to the branch tip
    } else if (branch !== repo.defaultBranch && forge.branchTip(repo, repo.defaultBranch) !== null) {
      const baseTip = forge.branchTip(repo, repo.defaultBranch) as string;
      flat = forge.flatAt(repo, baseTip);
      parent = baseTip;
    } else {
      flat = new Map();
      parent = null;
    }
    const existing = flat.get(path);
    if (existing) {
      const givenSha = str(body.sha);
      if (givenSha === '') return fail(422, 'Validation Failed: sha is required to update a file');
      if (givenSha !== existing.oid) return fail(409, 'Conflict: the sha does not match the current file');
    }
    const blobOid = forge.putBlob(repo, content);
    flat.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
    const commitSha = forge.commitFlat(repo, branch, flat, message, parent);
    return {
      status: existing ? 200 : 201,
      body: {
        content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
        commit: { sha: commitSha, message },
      },
    };
  }
  if (req.method === 'DELETE') {
    if (path === '') return fail(422, 'Validation Failed: no path');
    const tip = forge.branchTip(repo, branch);
    if (tip === null) return notFound();
    const flat = forge.flatAt(repo, tip);
    const existing = flat.get(path);
    if (!existing) return notFound();
    const givenSha = str(body.sha);
    if (givenSha !== '' && givenSha !== existing.oid) return fail(409, 'Conflict: the sha does not match the current file');
    flat.delete(path);
    const commitSha = forge.commitFlat(repo, branch, flat, str(body.message) || `Delete ${path}`);
    return { status: 200, body: { content: null, commit: { sha: commitSha } } };
  }
  return notFound();
}

// ----------------------------------------------------------------------------------------------
// branches, refs, commits
// ----------------------------------------------------------------------------------------------

function handleBranches(forge: Forge, req: RestRequest, repo: Repo, name: string): RestResult {
  if (req.method !== 'GET') return notFound();
  if (name === '') {
    return {
      status: 200,
      body: forge.branchNames(repo).map((branch) => ({
        name: branch,
        commit: { sha: forge.branchTip(repo, branch) ?? '' },
        protected: false,
      })),
    };
  }
  const tip = forge.branchTip(repo, name);
  if (tip === null) return notFound();
  return { status: 200, body: { name, commit: { sha: tip }, protected: false } };
}

function handleGitRefs(forge: Forge, req: RestRequest, repo: Repo, rest: string[]): RestResult {
  if (rest.length === 0 && req.method === 'POST') {
    const body = req.body ?? {};
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return fail(422, 'Validation Failed: bad ref or sha');
    if (repo.refs.has(ref)) return fail(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    const object = repo.objects.get(sha);
    return { status: 201, body: { ref, object: { sha, type: object?.type ?? 'commit' } } };
  }
  if (req.method === 'GET' && rest.length >= 2 && rest[0] === 'heads') {
    const branch = rest.slice(1).join('/');
    const tip = forge.branchTip(repo, branch);
    if (tip === null) return notFound();
    return { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } } };
  }
  if (req.method === 'GET' && rest.length === 0) {
    return {
      status: 200,
      body: [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } })),
    };
  }
  return notFound();
}

function authorParts(line: string, forge: Forge): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (!match) return { name: line, email: '', date: forge.iso(0) };
  return { name: match[1], email: match[2], date: forge.iso(Number(match[3])) };
}

function commitJson(forge: Forge, repo: Repo, oid: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return {
    sha: oid,
    commit: {
      author: authorParts(commit.author, forge),
      committer: authorParts(commit.committer, forge),
      message: commit.message,
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

function handleCommits(forge: Forge, req: RestRequest, repo: Repo, rest: string[]): RestResult {
  if (req.method !== 'GET') return notFound();
  if (rest.length === 1 && rest[0] !== '') {
    const one = commitJson(forge, repo, rest[0]);
    return one === null ? notFound() : { status: 200, body: one };
  }
  const shaParam = str(req.query.get('sha') ?? '');
  let tip: string | null = null;
  if (shaParam === '') tip = forge.branchTip(repo, repo.defaultBranch);
  else if (repo.objects.has(shaParam)) tip = shaParam;
  else tip = forge.branchTip(repo, shaParam);
  if (tip === null) return { status: 200, body: [] };
  const distances = commitDistances(repo.objects, [tip]);
  const ordered = [...distances.entries()]
    .sort((a, b) => a[1] - b[1] || forge.commitTime(repo, b[0]) - forge.commitTime(repo, a[0]))
    .map(([oid]) => oid);
  const perPageRaw = Number(req.query.get('per_page') ?? '100');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 100;
  const body: Record<string, unknown>[] = [];
  for (const oid of ordered.slice(0, perPage)) {
    const json = commitJson(forge, repo, oid);
    if (json) body.push(json);
  }
  return { status: 200, body };
}

// ----------------------------------------------------------------------------------------------
// labels, issues, comments
// ----------------------------------------------------------------------------------------------

function handleLabels(forge: Forge, req: RestRequest, repo: Repo, rest: string[]): RestResult {
  if (rest.length !== 0) return notFound();
  if (req.method === 'GET') {
    return {
      status: 200,
      body: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description })),
    };
  }
  if (req.method === 'POST') {
    const body = req.body ?? {};
    const name = str(body.name);
    const color = str(body.color) || '000000';
    if (name === '') return fail(422, 'Validation Failed: name is required');
    if (repo.labels.has(name)) return fail(422, 'Validation Failed: the label already exists');
    const label = { name, color, description: typeof body.description === 'string' ? body.description : null };
    repo.labels.set(name, label);
    return { status: 201, body: { name: label.name, color: label.color, description: label.description } };
  }
  return notFound();
}

function labelNamesOf(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.labels)) return [];
  const names: string[] = [];
  for (const entry of body.labels) {
    if (typeof entry === 'string') names.push(entry);
    else if (isRecord(entry) && typeof entry.name === 'string') names.push(entry.name);
  }
  return names;
}

function handleIssues(forge: Forge, req: RestRequest, repo: Repo, rest: string[]): RestResult {
  if (rest.length === 0) {
    if (req.method === 'GET') {
      const state = str(req.query.get('state') ?? '') || 'open';
      const direction = str(req.query.get('direction') ?? '') || 'desc';
      const entries: Array<IssueRec | PullRec> = [...repo.issues.values(), ...repo.pulls.values()];
      const filtered = entries.filter((entry) => state === 'all' || entry.state === state);
      filtered.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      return {
        status: 200,
        body: filtered.map((entry) => (entry.kind === 'issue' ? issueJson(forge, repo, entry) : pullAsIssueJson(forge, repo, entry))),
      };
    }
    if (req.method === 'POST') {
      const body = req.body ?? {};
      const title = str(body.title);
      if (title === '') return fail(422, 'Validation Failed: title is required');
      const labels = labelNamesOf(body);
      for (const name of labels) {
        if (!repo.labels.has(name)) return fail(422, `Validation Failed: the label '${name}' does not exist`);
      }
      const issue = forge.createIssue(repo, title, str(body.body), labels);
      return { status: 201, body: issueJson(forge, repo, issue) };
    }
    return notFound();
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number)) return notFound();
  const issue = repo.issues.get(number);
  const pull = repo.pulls.get(number);
  if (rest.length === 1) {
    if (req.method === 'GET') {
      if (issue) return { status: 200, body: issueJson(forge, repo, issue) };
      if (pull) return { status: 200, body: pullAsIssueJson(forge, repo, pull) };
      return notFound();
    }
    if (req.method === 'PATCH') {
      const body = req.body ?? {};
      if (issue) {
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (Array.isArray(body.labels)) {
          const labels = labelNamesOf(body);
          for (const name of labels) {
            if (!repo.labels.has(name)) return fail(422, `Validation Failed: the label '${name}' does not exist`);
          }
          issue.labels = labels;
        }
        issue.updatedAtSec = forge.tick();
        return { status: 200, body: issueJson(forge, repo, issue) };
      }
      if (pull) {
        if (typeof body.title === 'string') pull.title = body.title;
        if (typeof body.body === 'string') pull.body = body.body;
        if ((body.state === 'open' || body.state === 'closed') && !pull.merged) pull.state = body.state;
        pull.updatedAtSec = forge.tick();
        return { status: 200, body: pullAsIssueJson(forge, repo, pull) };
      }
      return notFound();
    }
    return notFound();
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (!issue) return notFound();
    if (req.method === 'GET') {
      return { status: 200, body: issue.comments.map((comment) => commentJson(forge, repo, comment)) };
    }
    if (req.method === 'POST') {
      const body = req.body ?? {};
      const text = str(body.body);
      if (text === '') return fail(422, 'Validation Failed: body is required');
      const comment = forge.addComment(repo, issue, text);
      return { status: 201, body: commentJson(forge, repo, comment) };
    }
  }
  return notFound();
}

// ----------------------------------------------------------------------------------------------
// pull requests
// ----------------------------------------------------------------------------------------------

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

function handlePulls(forge: Forge, req: RestRequest, repo: Repo, rest: string[]): RestResult {
  if (rest.length === 0) {
    if (req.method === 'GET') {
      const state = str(req.query.get('state') ?? '') || 'open';
      const all = [...repo.pulls.values()].filter((pull) => state === 'all' || pull.state === state);
      all.sort((a, b) => b.number - a.number);
      return { status: 200, body: all.map((pull) => pullJson(forge, repo, pull)) };
    }
    if (req.method === 'POST') {
      const body = req.body ?? {};
      const title = str(body.title);
      const head = stripOwnerPrefix(str(body.head));
      const base = stripOwnerPrefix(str(body.base));
      if (title === '' || head === '' || base === '') return fail(422, 'Validation Failed: title, head and base are required');
      const headTip = forge.branchTip(repo, head);
      const baseTip = forge.branchTip(repo, base);
      if (headTip === null || baseTip === null) return fail(422, 'Validation Failed: the head or base branch does not exist');
      if (headTip === baseTip) return fail(422, 'Validation Failed: no commits between the base and the head');
      const existing = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (existing) return fail(422, 'Validation Failed: a pull request already exists for this branch combination');
      const pull = forge.createPull(repo, title, str(body.body), head, base);
      return { status: 201, body: pullJson(forge, repo, pull) };
    }
    return notFound();
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number)) return notFound();
  const pull = repo.pulls.get(number);
  if (rest.length === 1) {
    if (req.method === 'GET') {
      if (!pull) return notFound();
      return { status: 200, body: pullJson(forge, repo, pull) };
    }
    if (req.method === 'PATCH') {
      if (!pull) return notFound();
      const body = req.body ?? {};
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if ((body.state === 'open' || body.state === 'closed') && !pull.merged) pull.state = body.state;
      pull.updatedAtSec = forge.tick();
      return { status: 200, body: pullJson(forge, repo, pull) };
    }
    return notFound();
  }
  if (rest.length === 2 && rest[1] === 'files' && req.method === 'GET') {
    if (!pull) return notFound();
    return { status: 200, body: forge.pullFiles(repo, pull) };
  }
  if (rest.length === 2 && rest[1] === 'merge' && req.method === 'PUT') {
    if (!pull) return notFound();
    if (pull.state !== 'open') return fail(405, 'Pull Request is not mergeable');
    const body = req.body ?? {};
    const method = str(body.merge_method) || 'merge';
    const sha = forge.mergePull(repo, pull, method);
    if (sha === null) return fail(405, 'Pull Request is not mergeable');
    return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
  }
  return notFound();
}
