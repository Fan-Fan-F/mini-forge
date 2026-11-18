// githttp.ts — the git smart-HTTP surface: ref advertisement (protocol v0 and v2), ls-refs,
// fetch (shallow-aware) and receive-pack with report-status, all over the repo's object map.

import {
  PktReader,
  ZERO_OID,
  collectReachable,
  commitDistances,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  peelToCommit,
  pktDelim,
  pktFlush,
  pktLine,
  pktText,
  readPack,
  writePack,
  type GitObj,
} from './gitcore.ts';
import type { Repo } from './forge.ts';

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'mini-forge/1.0';

function text(status: number, body: string): HttpResult {
  return { status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(body, 'utf8') };
}

/** Every ref line the v0 advertisement and ls-refs share: HEAD first, then refs in name order. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

function peeledOf(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  return peelToCommit(repo.objects, oid);
}

export function infoRefs(repo: Repo, service: string, protocolV2: boolean): HttpResult {
  const isUpload = service === 'git-upload-pack';
  const contentType = `application/x-${service}-advertisement`;
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  const serviceLine = pktLine(`# service=${service}\n`);
  if (isUpload && protocolV2) {
    const body = Buffer.concat([
      serviceLine,
      pktFlush(),
      pktText(['version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n']),
      pktFlush(),
    ]);
    return { status: 200, contentType, body };
  }
  const caps = isUpload
    ? `symref=HEAD:${headRef} side-band-64k multi_ack_detailed ofs-delta shallow agent=${AGENT}`
    : `report-status report-status-v2 delete-refs side-band-64k ofs-delta agent=${AGENT} symref=HEAD:${headRef}`;
  const lines: string[] = [];
  if (headOid !== undefined) {
    lines.push(`${headOid} HEAD\0${caps}`);
  } else {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}`);
  }
  for (const ref of sortedRefs(repo)) {
    lines.push(`${ref.oid} ${ref.name}`);
    const peeled = peeledOf(repo, ref.oid);
    if (peeled !== null && peeled !== ref.oid) lines.push(`${peeled} ${ref.name}^{}`);
  }
  const body = Buffer.concat([serviceLine, pktFlush(), pktText(lines), pktFlush()]);
  return { status: 200, contentType, body };
}

// ----------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// ----------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefs(repo: Repo, args: LsRefsArgs): HttpResult {
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const peeled = peeledOf(repo, ref.oid);
      if (peeled !== null && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: Buffer.concat([pktText(lines), pktFlush()]),
  };
}

// ----------------------------------------------------------------------------------------------
// fetch: which objects to send
// ----------------------------------------------------------------------------------------------

interface FetchPlan {
  objects: GitObj[];
  shallow: string[];
  unshallow: string[];
}

function treeClosure(store: Map<string, GitObj>, commitOid: string): Set<string> {
  const object = store.get(commitOid);
  if (!object || object.type !== 'commit') return new Set();
  const tree = parseCommit(object.data).tree;
  return collectReachable(store, [tree], true);
}

function selectFetchObjects(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowClient: readonly string[],
  depth: number | null,
): FetchPlan {
  const store = repo.objects;
  if (depth === null) {
    const exclude = collectReachable(store, [...haves, ...shallowClient], true);
    const include = collectReachable(store, wants, true);
    const objects: GitObj[] = [];
    const includeSet = new Set<string>();
    for (const oid of include) {
      if (exclude.has(oid)) continue;
      const object = store.get(oid);
      if (object) {
        objects.push(object);
        includeSet.add(oid);
      }
    }
    const shallow: string[] = [];
    if (shallowClient.length > 0) {
      for (const oid of includeSet) {
        const object = store.get(oid);
        if (!object || object.type !== 'commit') continue;
        const parents = parseCommit(object.data).parents;
        if (parents.some((parent) => !includeSet.has(parent) && store.has(parent))) shallow.push(oid);
      }
    }
    return { objects, shallow, unshallow: [] };
  }
  // Shallow: whole generations of commits from the wants, down to `depth`.
  const distances = commitDistances(store, wants, depth - 1);
  const includedCommits = new Set<string>();
  for (const [oid, dist] of distances) {
    if (dist < depth) includedCommits.add(oid);
  }
  // What the client provably holds: the have/boundary commits themselves and their tree
  // closures — never their ancestors, which is exactly what a shallow cut hides from it.
  const clientHas = new Set<string>();
  for (const held of [...haves, ...shallowClient]) {
    clientHas.add(held);
    for (const oid of treeClosure(store, held)) clientHas.add(oid);
  }
  const objectIds = new Set<string>();
  for (const oid of includedCommits) {
    if (!clientHas.has(oid)) objectIds.add(oid);
    for (const treeOid of treeClosure(store, oid)) {
      if (!clientHas.has(treeOid)) objectIds.add(treeOid);
    }
  }
  // A wanted tag object rides along when its commit is inside the shallow cut.
  for (const want of wants) {
    const object = store.get(want);
    if (object && object.type === 'tag' && includedCommits.has(peelToCommit(store, want))) objectIds.add(want);
  }
  const objects: GitObj[] = [];
  for (const oid of objectIds) {
    const object = store.get(oid);
    if (object) objects.push(object);
  }
  const boundary: string[] = [];
  for (const oid of includedCommits) {
    if ((distances.get(oid) ?? 0) !== depth - 1) continue;
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    if (parseCommit(object.data).parents.some((parent) => store.has(parent))) boundary.push(oid);
  }
  const boundarySet = new Set(boundary);
  const unshallow = shallowClient.filter((oid) => includedCommits.has(oid) && !boundarySet.has(oid));
  return { objects, shallow: boundary, unshallow };
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65000;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

function fetchV2(repo: Repo, args: {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}): HttpResult {
  const plan = selectFetchObjects(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  const common = args.haves.find((have) => repo.objects.has(have));
  if (common !== undefined) {
    parts.push(pktLine(`ACK ${common}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(writePack(plan.objects)));
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function fetchV0(repo: Repo, args: {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}): HttpResult {
  const plan = selectFetchObjects(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  const common = args.haves.find((have) => repo.objects.has(have));
  parts.push(pktLine(common !== undefined ? `ACK ${common}\n` : 'NAK\n'));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(writePack(plan.objects)));
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// ----------------------------------------------------------------------------------------------
// upload-pack POST
// ----------------------------------------------------------------------------------------------

export function uploadPack(repo: Repo, body: Buffer): HttpResult {
  let reader: PktReader;
  try {
    reader = new PktReader(body);
  } catch {
    return text(400, 'invalid pkt-line stream');
  }
  const lines: string[] = [];
  try {
    for (;;) {
      const packet = reader.next();
      if (packet === null || packet.kind === 'flush') break;
      if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
      if (packet.kind === 'delim') lines.push('\u0001');
    }
  } catch {
    return text(400, 'invalid pkt-line stream');
  }
  const first = (lines[0] ?? '').replace(/\n$/, '');
  if (first.startsWith('command=')) {
    const command = first.slice('command='.length);
    // v2: argument lines after the delim marker, up to the flush.
    const delimIndex = lines.indexOf('\u0001');
    const argLines = (delimIndex >= 0 ? lines.slice(delimIndex + 1) : lines.slice(1)).map((line) => line.replace(/\n$/, ''));
    if (command === 'ls-refs') {
      const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const line of argLines) {
        if (line === 'peel') args.peel = true;
        else if (line === 'symrefs') args.symrefs = true;
        else if (line === 'unborn') args.unborn = true;
        else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
      }
      return lsRefs(repo, args);
    }
    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | null = null;
      for (const line of argLines) {
        if (line.startsWith('want ')) wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
      }
      return fetchV2(repo, { wants, haves, shallow, depth });
    }
    return text(400, `unknown command ${command}`);
  }
  // v0: want lines (the first carries capabilities), a flush, then have lines and done.
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0];
      if (oid) wants.push(oid);
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  if (wants.length === 0) return text(400, 'no wants in upload-pack request');
  return fetchV0(repo, { wants, haves, shallow, depth });
}

// ----------------------------------------------------------------------------------------------
// receive-pack POST
// ----------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(repo: Repo, body: Buffer): HttpResult {
  const reader = new PktReader(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  try {
    for (;;) {
      const packet = reader.next();
      if (packet === null || packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (commands.length === 0) {
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          capabilities = line.slice(nul + 1);
          line = line.slice(0, nul);
        }
      }
      const parts = line.split(' ');
      if (parts.length === 3 && isOid(parts[0]) && isOid(parts[1])) {
        commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
      }
    }
  } catch {
    return text(400, 'invalid pkt-line stream');
  }
  const rest = reader.rest();
  const wantsPack = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackError: string | null = null;
  if (wantsPack && rest.length > 0) {
    try {
      const objects = readPack(rest, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const sideband = capabilities.split(' ').includes('side-band-64k');
  const report: string[] = [`unpack ${unpackError === null ? 'ok' : unpackError}\n`];
  for (const command of commands) {
    const failure = unpackError !== null ? 'unpacker error' : applyRefUpdate(repo, command);
    report.push(failure === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${failure}\n`);
  }
  const inner = Buffer.concat([pktText(report), pktFlush()]);
  const responseBody = sideband ? Buffer.concat([sidebandRaw(inner), pktFlush()]) : inner;
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}

/** Wrap an already pkt-framed report stream in sideband band-1 packets. */
function sidebandRaw(inner: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65000;
  for (let offset = 0; offset < inner.length; offset += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(offset, offset + CHUNK)])));
  }
  return Buffer.concat(parts);
}

/** Validate and apply one ref update; returns the failure reason for the report, or null on success. */
function applyRefUpdate(repo: Repo, command: PushCommand): string | null {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/') || ref.includes('..') || ref.includes(' ')) return 'invalid ref name';
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    if (current === ZERO_OID) return null;
    if (oldOid !== ZERO_OID && current !== oldOid) return 'stale info';
    repo.refs.delete(ref);
    return null;
  }
  if (!repo.objects.has(newOid)) return 'missing object';
  if (oldOid === ZERO_OID) {
    if (current !== ZERO_OID) return 'reference already exists';
    repo.refs.set(ref, newOid);
    return null;
  }
  if (current !== oldOid) return 'stale info';
  const currentCommit = peelToCommit(repo.objects, current);
  const newCommit = peelToCommit(repo.objects, newOid);
  const currentObject = repo.objects.get(currentCommit);
  const newObject = repo.objects.get(newCommit);
  if (currentObject?.type === 'commit' && newObject?.type === 'commit') {
    if (!isAncestor(repo.objects, currentCommit, newCommit)) return 'non-fast-forward';
  }
  repo.refs.set(ref, newOid);
  return null;
}
