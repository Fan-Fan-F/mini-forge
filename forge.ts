// forge.ts — the in-memory state of the whole forge and the domain operations every surface
// (REST, GraphQL, MCP, git) shares, so an object created on one surface is the same object on all.

import {
  ZERO_OID,
  buildCommit,
  buildTreeFromFlat,
  collectReachable,
  flattenTree,
  hashObject,
  isAncestor,
  lineDiff,
  mergeBase,
  parseCommit,
  treeOfCommit,
  type GitObj,
} from './gitcore.ts';

export interface CommentRec {
  id: number;
  body: string;
  createdAtSec: number;
}

export interface IssueRec {
  kind: 'issue';
  restId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAtSec: number;
  updatedAtSec: number;
}

export interface PullRec {
  kind: 'pull';
  restId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAtSec: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  createdAtSec: number;
  updatedAtSec: number;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface Repo {
  dbId: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  nextNumber: number;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  labels: Map<string, LabelRec>;
  createdAtSec: number;
}

/** Parse the trial's logical-clock seed (ISO string or epoch seconds/ms); falls back to a fixed epoch. */
function parseTrialNow(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 1_700_000_000;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    if (asNumber > 1e12) return Math.floor(asNumber / 1000);
    if (asNumber > 1e9) return Math.floor(asNumber);
    return 1_700_000_000 + Math.floor(asNumber);
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  return 1_700_000_000;
}

export class Forge {
  readonly token: string;
  /** The token owner's login, learned from the first owner-addressed request (see learnLogin). */
  login: string | null = null;
  readonly repos = new Map<string, Repo>();
  private readonly reposByDbId = new Map<number, Repo>();
  private nextRepoDbId = 1;
  private nextRestId = 1;
  private nextCommentId = 1;
  private requestSeq = 0;
  private readonly clockBase: number;
  private clockTick = 0;

  constructor(token: string, trialNow: string | undefined) {
    this.token = token;
    this.clockBase = parseTrialNow(trialNow);
  }

  /** One logical second, strictly increasing: every timestamp the API reports derives from this. */
  tick(): number {
    const value = this.clockBase + this.clockTick;
    this.clockTick += 1;
    return value;
  }

  iso(sec: number): string {
    return new Date(sec * 1000).toISOString();
  }

  /** A non-empty, unique-per-request id for the X-GitHub-Request-Id header. */
  requestId(): string {
    this.requestSeq += 1;
    return `FORGE-${this.requestSeq.toString(16).toUpperCase().padStart(8, '0')}`;
  }

  /**
   * The scenario's viewer login is not derivable from the opaque trial token, so the forge adopts
   * the first owner segment it is addressed by (the suite always addresses the token owner's own
   * repositories first) and treats every other owner as a stranger from then on.
   */
  learnLogin(owner: string): void {
    if (this.login === null && owner !== '') this.login = owner;
  }

  get ownerLogin(): string {
    return this.login ?? 'forge-user';
  }

  /** The author/committer identity stamped on commits the forge itself creates. */
  identity(sec: number): string {
    const login = this.ownerLogin;
    return `${login} <${login}@forge.local> ${sec} +0000`;
  }

  // --------------------------------------------------------------------------------------------
  // repositories
  // --------------------------------------------------------------------------------------------

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      dbId: this.nextRepoDbId,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      nextNumber: 1,
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      createdAtSec: this.tick(),
    };
    this.nextRepoDbId += 1;
    this.repos.set(name, repo);
    this.reposByDbId.set(repo.dbId, repo);
    return repo;
  }

  repoByName(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  repoByDbId(dbId: number): Repo | undefined {
    return this.reposByDbId.get(dbId);
  }

  deleteRepo(name: string): boolean {
    const repo = this.repos.get(name);
    if (!repo) return false;
    this.repos.delete(name);
    this.reposByDbId.delete(repo.dbId);
    return true;
  }

  /** The commit a branch points at (following the ref name), or null for an unborn/missing branch. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** All branch names, sorted. */
  branchNames(repo: Repo): string[] {
    const names: string[] = [];
    for (const ref of repo.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }

  /** The flat path map of a commit's tree (empty map for an unborn tip). */
  flatAt(repo: Repo, commitOid: string | null): Map<string, { oid: string; mode: string }> {
    if (commitOid === null) return new Map();
    const tree = treeOfCommit(repo.objects, commitOid);
    if (tree === '') return new Map();
    return flattenTree(repo.objects, tree);
  }

  /**
   * Commit a whole flat tree onto a branch: builds the commit (parented on the current tip when
   * there is one), moves the ref and returns the commit oid.
   */
  commitFlat(repo: Repo, branch: string, flat: Map<string, { oid: string; mode: string }>, message: string, parent?: string | null): string {
    const tree = buildTreeFromFlat(repo.objects, flat);
    const sec = this.tick();
    const identity = this.identity(sec);
    const tip = parent === undefined ? this.branchTip(repo, branch) : parent;
    const data = buildCommit({
      tree,
      parents: tip === null ? [] : [tip],
      author: identity,
      committer: identity,
      message,
    });
    const oid = hashObject('commit', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'commit', data });
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  /** Store a blob and return its oid. */
  putBlob(repo: Repo, content: Buffer): string {
    const oid = hashObject('blob', content);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'blob', data: content });
    return oid;
  }

  blobText(repo: Repo, oid: string): string {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'blob') return '';
    return object.data.toString('utf8');
  }

  // --------------------------------------------------------------------------------------------
  // issues and pull requests (one shared number sequence per repository, as on GitHub)
  // --------------------------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): IssueRec {
    const sec = this.tick();
    const issue: IssueRec = {
      kind: 'issue',
      restId: this.nextRestId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAtSec: sec,
      updatedAtSec: sec,
    };
    this.nextRestId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: Repo, issue: IssueRec, body: string): CommentRec {
    const comment: CommentRec = { id: this.nextCommentId, body, createdAtSec: this.tick() };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRec {
    const sec = this.tick();
    const pull: PullRec = {
      kind: 'pull',
      restId: this.nextRestId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAtSec: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      createdAtSec: sec,
      updatedAtSec: sec,
    };
    this.nextRestId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** Files changed between a pull request's merge base and its head tip, with line statistics. */
  pullFiles(repo: Repo, pull: PullRec): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return [];
    const base = mergeBase(repo.objects, baseTip, headTip) ?? baseTip;
    const fromFlat = this.flatAt(repo, base);
    const toFlat = this.flatAt(repo, headTip);
    const files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set<string>([...fromFlat.keys(), ...toFlat.keys()]);
    for (const path of [...paths].sort()) {
      const from = fromFlat.get(path);
      const to = toFlat.get(path);
      if (from && to && from.oid === to.oid) continue;
      if (!from && to) {
        const lines = this.blobText(repo, to.oid);
        const count = lines === '' ? 0 : lines.split('\n').length;
        files.push({ filename: path, status: 'added', additions: count, deletions: 0, changes: count });
      } else if (from && !to) {
        const lines = this.blobText(repo, from.oid);
        const count = lines === '' ? 0 : lines.split('\n').length;
        files.push({ filename: path, status: 'removed', additions: 0, deletions: count, changes: count });
      } else if (from && to) {
        const diff = lineDiff(this.blobText(repo, from.oid), this.blobText(repo, to.oid));
        files.push({ filename: path, status: 'modified', additions: diff.additions, deletions: diff.deletions, changes: diff.additions + diff.deletions });
      }
    }
    return files;
  }

  /** Whether the pull request's head still merges cleanly into its base (file-level three-way). */
  pullMergeable(repo: Repo, pull: PullRec): boolean {
    if (pull.state !== 'open') return false;
    return this.tryTreeMerge(repo, pull) !== null;
  }

  /**
   * The merged flat tree for a pull request, or null on a file-level conflict: for every path,
   * a side that changed it relative to the merge base wins; both sides changing it differently
   * (including modify-vs-delete) is a conflict.
   */
  tryTreeMerge(repo: Repo, pull: PullRec): Map<string, { oid: string; mode: string }> | null {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return null;
    if (isAncestor(repo.objects, headTip, baseTip)) return this.flatAt(repo, baseTip);
    const ancestor = mergeBase(repo.objects, baseTip, headTip);
    const baseFlat = this.flatAt(repo, ancestor);
    const oursFlat = this.flatAt(repo, baseTip);
    const theirsFlat = this.flatAt(repo, headTip);
    const merged = new Map<string, { oid: string; mode: string }>();
    const paths = new Set<string>([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
    for (const path of paths) {
      const inBase = baseFlat.get(path);
      const inOurs = oursFlat.get(path);
      const inTheirs = theirsFlat.get(path);
      const oursChanged = (inOurs?.oid ?? null) !== (inBase?.oid ?? null);
      const theirsChanged = (inTheirs?.oid ?? null) !== (inBase?.oid ?? null);
      if (oursChanged && theirsChanged) {
        if ((inOurs?.oid ?? null) === (inTheirs?.oid ?? null)) {
          if (inOurs) merged.set(path, inOurs);
          continue;
        }
        return null;
      }
      const winner = theirsChanged ? inTheirs : inOurs;
      if (winner) merged.set(path, winner);
    }
    return merged;
  }

  /**
   * Merge a pull request. `squash` lands one commit holding the merged tree on the base branch;
   * `merge` lands a two-parent commit. Returns the merge commit oid, or null when conflicting.
   */
  mergePull(repo: Repo, pull: PullRec, method: string): string | null {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return null;
    const mergedFlat = this.tryTreeMerge(repo, pull);
    if (mergedFlat === null) return null;
    const tree = buildTreeFromFlat(repo.objects, mergedFlat);
    const sec = this.tick();
    const identity = this.identity(sec);
    let parents: string[];
    let message: string;
    if (method === 'merge') {
      parents = headTip === baseTip ? [baseTip] : [baseTip, headTip];
      message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
    } else {
      parents = [baseTip];
      message = `${pull.title} (#${pull.number})\n\n${pull.body}\n`;
    }
    const data = buildCommit({ tree, parents, author: identity, committer: identity, message });
    const oid = hashObject('commit', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'commit', data });
    repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAtSec = sec;
    pull.mergeCommitSha = oid;
    pull.updatedAtSec = sec;
    return oid;
  }

  /** Every object reachable from a tip (used by clone/fetch assembly). */
  reachable(repo: Repo, tip: string): Set<string> {
    return collectReachable(repo.objects, [tip], true);
  }

  commitTime(repo: Repo, oid: string): number {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return 0;
    return parseCommit(object.data).time;
  }
}

// ----------------------------------------------------------------------------------------------
// global (Relay) ids: opaque, stable, and decodable by the forge alone
// ----------------------------------------------------------------------------------------------

export type GidKind = 'repo' | 'issue' | 'pull' | 'comment';

export function encodeGid(kind: GidKind, dbId: number, number: number): string {
  return Buffer.from(`${kind}:${dbId}:${number}`, 'utf8').toString('base64url');
}

export function decodeGid(id: string): { kind: GidKind; dbId: number; number: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length !== 3) return null;
    const kind = parts[0] as GidKind;
    if (kind !== 'repo' && kind !== 'issue' && kind !== 'pull' && kind !== 'comment') return null;
    const dbId = Number(parts[1]);
    const number = Number(parts[2]);
    if (!Number.isInteger(dbId) || !Number.isInteger(number)) return null;
    return { kind, dbId, number };
  } catch {
    return null;
  }
}
