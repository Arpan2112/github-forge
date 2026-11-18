// gitcore.ts — the git object model, implemented from the protocol's public specification on
// node:crypto and node:zlib alone: SHA-1 object ids, loose object (de)serialisation, tree and
// commit construction and parsing, pack v2 reading (with OFS/REF delta application) and pack v2
// writing (full objects, no deltas), and the pkt-line framing the smart-HTTP protocol speaks.
//
// The forge keeps every object in memory: a trial is one process with a fresh store, so an
// object Map keyed by hex id is both the database and the index. Objects are stored as their
// raw content bytes (for a blob, the file bytes; for a commit, tree or tag, the exact text the
// id was computed over), which makes hashing, serving and re-packing all the same operation.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_TO_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** SHA-1 over "<type> <length>\0<data>": the object id git assigns. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** The object store: hex id -> object. One store per repository. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  /** Store an object and answer its id (idempotent: the same bytes give the same id). */
  put(type: GitObjectType, data: Buffer): string {
    const id = hashObject(type, data);
    if (!this.objects.has(id)) this.objects.set(id, { type, data });
    return id;
  }

  get(id: string): GitObject | undefined {
    return this.objects.get(id);
  }

  has(id: string): boolean {
    return this.objects.has(id);
  }
}

// -------------------------------------------------------------------------------------------------
// trees
// -------------------------------------------------------------------------------------------------

export interface TreeEntry {
  /** Octal mode as stored, e.g. '100644', '100755', '120000', '40000' (tree), '160000' (gitlink). */
  mode: string;
  name: string;
  sha: string;
}

/** Git's tree sort key: a directory sorts as if its name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialise tree entries to the raw tree object bytes (sorted the git way). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse raw tree object bytes back into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

// -------------------------------------------------------------------------------------------------
// commits and tags
// -------------------------------------------------------------------------------------------------

export interface Identity {
  name: string;
  email: string;
  /** Seconds since the epoch. */
  epochSec: number;
  /** Timezone string as git writes it, e.g. '+0000'. */
  tz: string;
}

export function formatIdentity(identity: Identity): string {
  return `${identity.name} <${identity.email}> ${identity.epochSec} ${identity.tz}`;
}

export interface CommitData {
  tree: string;
  parents: string[];
  author: Identity;
  committer: Identity;
  message: string;
}

/** Serialise a commit to its raw object bytes. */
export function buildCommit(commit: CommitData): Buffer {
  const lines: string[] = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${formatIdentity(commit.author)}`);
  lines.push(`committer ${formatIdentity(commit.committer)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

/** Parse raw commit bytes. Unknown headers are skipped; the message is everything after the blank line. */
export function parseCommit(data: Buffer): CommitData {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let author: Identity = { name: '', email: '', epochSec: 0, tz: '+0000' };
  let committer: Identity = author;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = parseIdentity(line.slice(7));
    else if (line.startsWith('committer ')) committer = parseIdentity(line.slice(10));
  }
  return { tree, parents, author, committer, message };
}

function parseIdentity(text: string): Identity {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(text.trim());
  if (match === null) return { name: text, email: '', epochSec: 0, tz: '+0000' };
  return { name: match[1] as string, email: match[2] as string, epochSec: Number(match[3]), tz: match[4] as string };
}

export interface TagData {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: Identity;
  message: string;
}

/** Serialise an annotated tag object. */
export function buildTag(tag: TagData): Buffer {
  const lines = [
    `object ${tag.object}`,
    `type ${tag.type}`,
    `tag ${tag.tag}`,
    `tagger ${formatIdentity(tag.tagger)}`,
  ];
  return Buffer.from(`${lines.join('\n')}\n\n${tag.message}`, 'utf8');
}

/** Parse raw tag bytes. */
export function parseTag(data: Buffer): TagData {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = ZERO_OID;
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger: Identity = { name: '', email: '', epochSec: 0, tz: '+0000' };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = parseIdentity(line.slice(7));
  }
  return { object, type, tag, tagger, message };
}

// -------------------------------------------------------------------------------------------------
// reachability
// -------------------------------------------------------------------------------------------------

/**
 * Every object id reachable from the given tips (commits walk to their tree, parents and tag
 * targets; trees walk to their entries). `exclude` seeds a second walk whose objects are left
 * out (the have-set of a fetch). Ids not in the store are ignored, so a shallow boundary or a
 * missing parent never breaks the walk.
 */
export function collectReachable(store: ObjectStore, tips: readonly string[], exclude: readonly string[] = []): Set<string> {
  const excluded = new Set<string>();
  const walkExcluded = [...exclude];
  while (walkExcluded.length > 0) {
    const id = walkExcluded.pop() as string;
    if (excluded.has(id)) continue;
    excluded.add(id);
    const object = store.get(id);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      walkExcluded.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) walkExcluded.push(entry.sha);
    } else if (object.type === 'tag') {
      walkExcluded.push(parseTag(object.data).object);
    }
  }
  const found = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (found.has(id) || excluded.has(id)) continue;
    const object = store.get(id);
    if (object === undefined) continue;
    found.add(id);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.sha);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return found;
}

/** The commits reachable from a tip, newest first by walk order (tip first, parents after). */
export function commitHistory(store: ObjectStore, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    const object = store.get(id);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(id);
    order.push(id);
    const commit = parseCommit(object.data);
    // Push parents reversed so the first parent is walked first (a linear history stays linear).
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
  }
  return order;
}

/** Is `ancestor` reachable from `descendant` through commit parents? (The fast-forward test.) */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === ancestor) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const object = store.get(id);
    if (object === undefined || object.type !== 'commit') continue;
    stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

/** The first common ancestor of two commits (breadth-first from both), or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOf = (tip: string): Set<string> => {
    const set = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (set.has(id)) continue;
      const object = store.get(id);
      if (object === undefined || object.type !== 'commit') continue;
      set.add(id);
      stack.push(...parseCommit(object.data).parents);
    }
    return set;
  };
  const fromA = ancestorsOf(a);
  // Walk b in history order and return the first commit that is also an ancestor of a.
  for (const id of commitHistory(store, b)) {
    if (fromA.has(id)) return id;
  }
  return null;
}

// -------------------------------------------------------------------------------------------------
// tree flattening (path -> blob) for contents, diffs and merges
// -------------------------------------------------------------------------------------------------

/** Flatten a tree (recursively) into a map of slash path -> {mode, sha}. */
export function flattenTree(store: ObjectStore, treeId: string, prefix = ''): Map<string, { mode: string; sha: string }> {
  const out = new Map<string, { mode: string; sha: string }>();
  const object = store.get(treeId);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [childPath, child] of flattenTree(store, entry.sha, path)) out.set(childPath, child);
    } else {
      out.set(path, { mode: entry.mode, sha: entry.sha });
    }
  }
  return out;
}

/** Build (and store) a tree hierarchy from a flat path -> {mode, sha} map; answers the root tree id. */
export function buildTreeFromFlat(store: ObjectStore, flat: ReadonlyMap<string, { mode: string; sha: string }>): string {
  interface Node {
    files: Map<string, { mode: string; sha: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, file] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      if (!node.dirs.has(part)) node.dirs.set(part, { files: new Map(), dirs: new Map() });
      node = node.dirs.get(part) as Node;
    }
    node.files.set(parts[parts.length - 1] as string, file);
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, sha: emit(dir) });
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, sha: file.sha });
    return store.put('tree', buildTree(entries));
  };
  return emit(root);
}

// -------------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------------

/**
 * Inflate one deflated stream starting at `offset`, answering the data and the offset just past
 * the stream. Node's inflateSync tolerates trailing bytes (verified on this platform), and with
 * {info: true} its engine reports exactly how many input bytes the stream consumed — one call
 * per object. The binary-search fallback stays for a runtime whose engine does not report it:
 * "the slice inflates" is a monotone predicate of the slice end there.
 */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; nextOffset: number } {
  const rest = buffer.subarray(offset);
  try {
    const result = inflateSync(rest, { info: true }) as unknown as { buffer: Buffer; engine?: { bytesWritten?: number } };
    const written = result.engine?.bytesWritten;
    if (typeof written === 'number' && written > 0 && written <= rest.length) {
      return { data: result.buffer, nextOffset: offset + written };
    }
  } catch {
    // fall through to the search
  }
  let lo = offset + 1;
  let hi = buffer.length;
  let found: { data: Buffer; nextOffset: number } | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const data = inflateSync(buffer.subarray(offset, mid));
      found = { data, nextOffset: mid };
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (found !== null) return found;
  throw new Error(`cannot inflate object at pack offset ${offset}`);
}

/** Apply a git delta (the copy/insert instruction stream) to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: ${sourceSize} != ${base.length}`);
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          copyOffset |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          copySize |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== targetSize || out.length !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

/**
 * Read a pack v2 into the store. Handles full objects plus OFS_DELTA and REF_DELTA chains (the
 * suite's pushes and a real git client's pushes both delta-compress). Answers the ids stored.
 */
export function readPack(store: ObjectStore, pack: Buffer): string[] {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a pack v2 stream');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let offset = 12;
  interface Pending {
    type: GitObjectType;
    data: Buffer;
  }
  const byOffset = new Map<number, Pending>();
  const ids: string[] = [];
  const pendingDeltas: { offset: number; baseOffset?: number; baseId?: string; delta: Buffer }[] = [];

  for (let i = 0; i < count; i += 1) {
    const objectStart = offset;
    let byte = pack[offset] as number;
    offset += 1;
    let typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseId: string | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset to the base object, in git's offset encoding.
      byte = pack[offset] as number;
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset] as number;
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = objectStart - back;
    } else if (typeCode === 7) {
      baseId = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack, offset);
    offset = inflated.nextOffset;
    if (typeCode === 6 || typeCode === 7) {
      pendingDeltas.push({ offset: objectStart, baseOffset, baseId, delta: inflated.data });
    } else {
      const type = CODE_TO_TYPE[typeCode] as GitObjectType;
      byOffset.set(objectStart, { type, data: inflated.data });
      ids.push(store.put(type, inflated.data));
    }
    void size;
    void typeCode;
  }

  // Resolve deltas in dependency order (a delta's base may itself be a delta).
  const resolveOne = (delta: (typeof pendingDeltas)[number]): Pending => {
    let base: Pending | undefined;
    if (delta.baseOffset !== undefined) {
      base = byOffset.get(delta.baseOffset);
      if (base === undefined) {
        const chained = pendingDeltas.find((d) => d.offset === delta.baseOffset);
        if (chained === undefined) throw new Error('delta base offset not in pack');
        base = resolveOne(chained);
      }
    } else if (delta.baseId !== undefined) {
      const existing = store.get(delta.baseId);
      if (existing !== undefined) base = existing;
      else throw new Error('delta base object not available');
    }
    if (base === undefined) throw new Error('delta without a base');
    const data = applyDelta(base.data, delta.delta);
    const resolved: Pending = { type: base.type, data };
    byOffset.set(delta.offset, resolved);
    return resolved;
  };
  for (const delta of pendingDeltas) {
    const resolved = resolveOne(delta);
    ids.push(store.put(resolved.type, resolved.data));
  }
  return ids;
}

/**
 * Write a pack v2 holding the given objects in full (no deltas). A receiving git client (and the
 * suite's own reader) accepts an undeltified pack happily; the trailer is the pack's SHA-1.
 */
export function writePack(store: ObjectStore, ids: Iterable<string>): Buffer {
  const list = [...ids];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const id of list) {
    const object = store.get(id);
    if (object === undefined) continue;
    const code = TYPE_TO_CODE[object.type];
    let size = object.data.length;
    const first = size & 0x0f;
    size >>= 4;
    const bytes: number[] = [];
    let byte = (code << 4) | first | (size > 0 ? 0x80 : 0);
    bytes.push(byte);
    while (size > 0) {
      byte = size & 0x7f;
      size >>= 7;
      bytes.push(size > 0 ? byte | 0x80 : byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// -------------------------------------------------------------------------------------------------
// pkt-line framing
// -------------------------------------------------------------------------------------------------

export const PKT_LINE_MAX = 65520;

/** Frame one pkt-line (4 hex digits of total length + payload). */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const prefix = length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(prefix, 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Parse a buffer of pkt-lines into payloads; 'flush' becomes null, 'delim' becomes 'delim'. */
export function parsePktLines(buffer: Buffer): { packets: (Buffer | null | 'delim' | 'response-end')[]; rest: Buffer } {
  const packets: (Buffer | null | 'delim' | 'response-end')[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const length = Number.parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) break;
    if (length === 0) {
      packets.push(null);
      offset += 4;
    } else if (length === 1) {
      packets.push('delim');
      offset += 4;
    } else if (length === 2) {
      packets.push('response-end');
      offset += 4;
    } else {
      if (offset + length > buffer.length) break;
      packets.push(buffer.subarray(offset + 4, offset + length));
      offset += length;
    }
  }
  return { packets, rest: buffer.subarray(offset) };
}
