// gitcore.ts — the git object model, pkt-line framing and packfile codec for the mini forge.
// Pure standard library: SHA-1 from node:crypto, zlib from node:zlib. No deltas are ever produced
// (a pack of plain objects is always legal); deltas received in a push pack are resolved.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** SHA-1 over `<type> <size>\0` + payload: the one identity rule of the whole object store. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ----------------------------------------------------------------------------------------------
// pkt-line framing
// ----------------------------------------------------------------------------------------------

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const prefix = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([prefix, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'respend' };

/** A sequential reader over a pkt-line stream; `rest()` yields whatever follows a flush packet. */
export class PktReader {
  private readonly buf: Buffer;
  private pos = 0;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  next(): Pkt | null {
    if (this.pos + 4 > this.buf.length) return null;
    const hex = this.buf.subarray(this.pos, this.pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      this.pos += 4;
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.pos += 4;
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.pos += 4;
      return { kind: 'respend' };
    }
    if (length < 4 || this.pos + length > this.buf.length) throw new Error('pkt-line overruns the body');
    const payload = this.buf.subarray(this.pos + 4, this.pos + length);
    this.pos += length;
    return { kind: 'data', payload };
  }

  /** All bytes not yet consumed (a receive-pack body keeps its packfile here). */
  rest(): Buffer {
    return this.buf.subarray(this.pos);
  }

  get done(): boolean {
    return this.pos >= this.buf.length;
  }
}

/** Encode a list of text lines (each already \n-terminated) as pkt-line data packets. */
export function pktText(lines: readonly string[]): Buffer {
  return Buffer.concat(lines.map((line) => pktLine(line)));
}

// ----------------------------------------------------------------------------------------------
// packfiles
// ----------------------------------------------------------------------------------------------

function packHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 packfile of plain (undeltified) objects, with its SHA-1 trailer. */
export function writePack(objects: Iterable<GitObj>): Buffer {
  const list = [...objects];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const object of list) {
    parts.push(packHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset: number;
  baseOid: string;
  resolvedType: ObjType | null;
  resolved: Buffer | null;
  oid: string;
}

function readSizeVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buf[offset];
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[offset];
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buf: Buffer, offset: number, limit: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset, limit);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** The git delta instruction stream (copy/insert) applied to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += delta[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += delta[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

/**
 * Read a packfile into an oid → object map, resolving OFS_DELTA and REF_DELTA entries.
 * `resolveBase` supplies objects a thin pack leaves out (the receiving store's own objects).
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readSizeVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = {
      offset: entryOffset,
      typeCode,
      size: header.size,
      data: Buffer.alloc(0),
      baseOffset: 0,
      baseOid: '',
      resolvedType: null,
      resolved: null,
      oid: '',
    };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset, trailerStart);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObj>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolve = (entry: RawEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const inPack = resolvedByOid.get(entry.baseOid);
      if (inPack) {
        const base = resolve(inPack);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(entry.baseOid);
        if (!external) throw new Error('ref-delta base missing');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ----------------------------------------------------------------------------------------------
// trees and commits
// ----------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function isDirMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Git's tree order: by name, with directories compared as if their name ended in `/`. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.name + (isDirMode(a.mode) ? '/' : '');
    const kb = b.name + (isDirMode(b.mode) ? '/' : '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** Unix seconds from the author line, 0 when unparsable. */
  time: number;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const timeMatch = / (\d+) [+-]\d{4}$/.exec(author);
  return { tree, parents, author, committer, message, time: timeMatch ? Number(timeMatch[1]) : 0 };
}

export function buildCommit(info: { tree: string; parents: readonly string[]; author: string; committer: string; message: string }): Buffer {
  let text = `tree ${info.tree}\n`;
  for (const parent of info.parents) text += `parent ${parent}\n`;
  text += `author ${info.author}\ncommitter ${info.committer}\n\n${info.message}`;
  return Buffer.from(text, 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line === '') break;
  }
  return { object, type, tag };
}

/** Peel a tag chain down to the commit it ultimately names (the commit oid, or the input when not a tag). */
export function peelToCommit(store: Map<string, GitObj>, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = store.get(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// ----------------------------------------------------------------------------------------------
// reachability and ancestry over one repository's object map
// ----------------------------------------------------------------------------------------------

/** Every object reachable from `tips` (commits walk to trees and parents; tags to their target). */
export function collectReachable(store: Map<string, GitObj>, tips: Iterable<string>, allowMissing = false): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (!object) {
      if (allowMissing) continue;
      throw new Error(`object ${oid} is missing`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Commit oid → shortest distance (in parent edges) from any of `tips`, breadth-first. */
export function commitDistances(store: Map<string, GitObj>, tips: Iterable<string>, maxDepth = Infinity): Map<string, number> {
  const distance = new Map<string, number>();
  let frontier: string[] = [];
  for (const tip of tips) {
    const commit = peelToCommit(store, tip);
    if (!distance.has(commit)) {
      distance.set(commit, 0);
      frontier.push(commit);
    }
  }
  let depth = 0;
  while (frontier.length > 0 && depth < maxDepth) {
    depth += 1;
    const next: string[] = [];
    for (const oid of frontier) {
      const object = store.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!distance.has(parent)) {
          distance.set(parent, depth);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return distance;
}

/** True when `ancestor` is reachable from `descendant` by parent edges (or equal). Early-exit walk. */
export function isAncestor(store: Map<string, GitObj>, ancestor: string, descendant: string): boolean {
  const target = peelToCommit(store, ancestor);
  const from = peelToCommit(store, descendant);
  if (target === from) return true;
  const seen = new Set<string>([from]);
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const object = store.get(current);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === target) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  return false;
}

/** The best common ancestor of two commits (least total distance), or null when unrelated. */
export function mergeBase(store: Map<string, GitObj>, a: string, b: string): string | null {
  const da = commitDistances(store, [a]);
  const db = commitDistances(store, [b]);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [oid, dist] of da) {
    const other = db.get(oid);
    if (other === undefined) continue;
    const score = dist + other;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

// ----------------------------------------------------------------------------------------------
// flat trees (path → blob) for contents writes, merges and diffs
// ----------------------------------------------------------------------------------------------

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree (recursively) into a path → entry map. */
export function flattenTree(store: Map<string, GitObj>, treeOid: string, prefix = '', out = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
  const tree = store.get(treeOid);
  if (!tree || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isDirMode(entry.mode)) flattenTree(store, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** The tree oid of a commit (empty-tree marker '' when the commit is unknown). */
export function treeOfCommit(store: Map<string, GitObj>, commitOid: string): string {
  const object = store.get(commitOid);
  if (!object || object.type !== 'commit') return '';
  return parseCommit(object.data).tree;
}

/** Materialise a flat path map into tree objects inside the store; returns the root tree oid. */
export function buildTreeFromFlat(store: Map<string, GitObj>, flat: Map<string, FlatEntry>): string {
  interface DirNode {
    files: Map<string, FlatEntry>;
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], entry);
  }
  const emit = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: emit(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!store.has(oid)) store.set(oid, { type: 'tree', data });
    return oid;
  };
  return emit(root);
}

// ----------------------------------------------------------------------------------------------
// line diff (for pull-request file statistics)
// ----------------------------------------------------------------------------------------------

/** Count added/deleted lines between two texts with an LCS walk; large inputs fall back to a scan. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // A trailing newline produces a phantom empty final element on both sides; it cancels out.
  if (oldLines.length > 1500 || newLines.length > 1500) {
    const oldSet = new Map<string, number>();
    for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of newLines) {
      const left = oldSet.get(line) ?? 0;
      if (left > 0) {
        common += 1;
        oldSet.set(line, left - 1);
      }
    }
    return { additions: newLines.length - common, deletions: oldLines.length - common };
  }
  const m = oldLines.length;
  const n = newLines.length;
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = oldLines[i] === newLines[j] ? dp[(i + 1) * (n + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
    }
  }
  const common = dp[0];
  return { additions: n - common, deletions: m - common };
}
