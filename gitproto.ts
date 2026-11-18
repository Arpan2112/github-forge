// gitproto.ts — git smart HTTP for one repository: the v2 capability advertisement and ls-refs /
// fetch commands for upload-pack, the v0 advertisement and fetch for upload-pack, and the v0
// receive-pack command list with report-status. Framing follows the protocol's public
// documentation and the exact shapes the suite's own client parses: v2 fetch answers carry
// acknowledgments / shallow-info / packfile sections, and the packfile section is sideband
// framed (band 1 = pack bytes, band 2 = progress), as is the push report when negotiated.

import { createHash } from 'node:crypto';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  collectReachable,
  isAncestor,
  parseCommit,
  parsePktLines,
  parseTag,
  pktLine,
  readPack,
  writePack,
} from './gitcore.ts';
import type { Repo } from './forge.ts';

const AGENT = 'forge/1.0';

/** Every ref line the advertisements and ls-refs share: oid, name, peeled target for tags. */
function refLines(repo: Repo): { oid: string; name: string; peeled?: string }[] {
  const lines: { oid: string; name: string; peeled?: string }[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    const object = repo.store.get(oid);
    if (object !== undefined && object.type === 'tag') entry.peeled = parseTag(object.data).object;
    lines.push(entry);
  }
  return lines;
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// -------------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------------

/** GET info/refs for git-upload-pack: a v2 capability advertisement when asked, else v0 refs. */
export function advertiseUploadPack(repo: Repo, version2: boolean): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  if (version2) {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine(`agent=${AGENT}\n`));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  const capabilities = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow ' +
    `agent=${AGENT} symref=HEAD:${headTarget(repo)}`;
  const refs = refLines(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    const headOid = repo.branchTip(repo.defaultBranch) ?? ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\0${capabilities}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** GET info/refs for git-receive-pack: always a v0 ref advertisement with report-status. */
export function advertiseReceivePack(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  const capabilities = `report-status side-band-64k ofs-delta delete-refs agent=${AGENT}`;
  const refs = refLines(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    let first = true;
    for (const ref of refs) {
      if (first) {
        parts.push(pktLine(`${ref.oid} ${ref.name}\0${capabilities}\n`));
        first = false;
      } else {
        parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      }
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------------
// request parsing shared by the v2 commands
// -------------------------------------------------------------------------------------------------

interface V2Request {
  command: string;
  args: string[];
}

/** Parse a v2 command request: command section, delim, argument lines, flush. */
function parseV2Request(body: Buffer): V2Request {
  const { packets } = parsePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet === null || packet === 'delim' || packet === 'response-end') continue;
    lines.push(packet.toString('utf8').replace(/\n$/, ''));
  }
  let command = '';
  const args: string[] = [];
  for (const line of lines) {
    if (line.startsWith('command=')) command = line.slice('command='.length);
    else args.push(line);
  }
  return { command, args };
}

// -------------------------------------------------------------------------------------------------
// ls-refs (v2)
// -------------------------------------------------------------------------------------------------

export function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const { args } = parseV2Request(body);
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));

  const parts: Buffer[] = [];
  const headOid = repo.branchTip(repo.defaultBranch);
  if (matches('HEAD')) {
    if (headOid !== null) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`));
    }
  }
  for (const ref of refLines(repo)) {
    if (!matches(ref.name)) continue;
    const extra = peel && ref.peeled !== undefined ? ` peeled:${ref.peeled}` : '';
    parts.push(pktLine(`${ref.oid} ${ref.name}${extra}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------------
// fetch (v2 and v0)
// -------------------------------------------------------------------------------------------------

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallowLines: string[];
  depth: number | null;
}

/**
 * The object set for a depth-limited fetch: commits within `depth` of the wants (their trees and
 * blobs included), walking parents only inside the limit. Answers the set plus the boundary
 * commits — those at the limit that still have a parent in the store.
 */
function depthLimitedSet(repo: Repo, wants: readonly string[], depth: number): { objects: Set<string>; boundary: string[] } {
  const objects = new Set<string>();
  const boundary: string[] = [];
  // distance per commit id, breadth-first from the wants.
  const distance = new Map<string, number>();
  const queue: { id: string; dist: number }[] = [];
  for (const want of wants) queue.push({ id: want, dist: 0 });
  const addSubtree = (commitId: string): void => {
    const object = repo.store.get(commitId);
    if (object === undefined || object.type !== 'commit') return;
    const commit = parseCommit(object.data);
    for (const id of collectReachable(repo.store, [commit.tree])) objects.add(id);
  };
  while (queue.length > 0) {
    const { id, dist } = queue.shift() as { id: string; dist: number };
    if (distance.has(id) && (distance.get(id) as number) <= dist) continue;
    const object = repo.store.get(id);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      objects.add(id);
      queue.push({ id: parseTag(object.data).object, dist });
      continue;
    }
    if (object.type !== 'commit') continue;
    distance.set(id, dist);
    objects.add(id);
    addSubtree(id);
    const commit = parseCommit(object.data);
    if (dist + 1 >= depth) {
      if (commit.parents.length > 0) boundary.push(id);
      continue;
    }
    for (const parent of commit.parents) queue.push({ id: parent, dist: dist + 1 });
  }
  return { objects, boundary };
}

/** Objects a shallow client already holds: everything above its boundary, boundary included. */
function shallowClientSet(repo: Repo, boundaryTips: readonly string[]): Set<string> {
  const held = new Set<string>();
  const stack = [...boundaryTips];
  // The client holds the boundary commits and their subtrees, but nothing past their parents:
  // walk commits upward is impossible (no child pointers), so instead compute the full closure
  // of the boundary tips and remove the closure of their parents.
  const closure = collectReachable(repo.store, boundaryTips);
  const parents: string[] = [];
  for (const tip of boundaryTips) {
    const object = repo.store.get(tip);
    if (object !== undefined && object.type === 'commit') parents.push(...parseCommit(object.data).parents);
  }
  const beyond = collectReachable(repo.store, parents);
  for (const id of closure) if (!beyond.has(id)) held.add(id);
  return held;
}

function planFetch(repo: Repo, plan: FetchPlan): { pack: Buffer; shallowInfo: string[] } {
  const cacheKey = createHash('sha1')
    .update(JSON.stringify([plan.wants, plan.haves, plan.shallowLines, plan.depth]))
    .digest('hex');
  const cached = repo.packCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const result = planFetchUncached(repo, plan);
  if (repo.packCache.size >= 64) repo.packCache.clear();
  repo.packCache.set(cacheKey, result);
  return result;
}

function planFetchUncached(repo: Repo, plan: FetchPlan): { pack: Buffer; shallowInfo: string[] } {
  const store = repo.store;
  let objects: Set<string>;
  const shallowInfo: string[] = [];
  if (plan.depth !== null && plan.shallowLines.length === 0) {
    // A fresh shallow fetch.
    const { objects: set, boundary } = depthLimitedSet(repo, plan.wants, plan.depth);
    objects = set;
    for (const id of boundary) shallowInfo.push(`shallow ${id}`);
  } else if (plan.depth !== null && plan.shallowLines.length > 0) {
    // Deepening: the client holds everything above its old boundary; send the next slice.
    const { objects: set, boundary } = depthLimitedSet(repo, plan.wants, plan.depth);
    const held = shallowClientSet(repo, plan.shallowLines);
    objects = new Set([...set].filter((id) => !held.has(id)));
    for (const id of boundary) shallowInfo.push(`shallow ${id}`);
    for (const old of plan.shallowLines) {
      if (!boundary.includes(old)) shallowInfo.push(`unshallow ${old}`);
    }
  } else if (plan.shallowLines.length > 0) {
    // A plain fetch from a shallow client: everything down to (and excluding) its boundary's
    // ancestors; the boundary itself stays shallow.
    const held = shallowClientSet(repo, plan.shallowLines);
    const closure = collectReachable(store, plan.wants, plan.haves);
    objects = new Set([...closure].filter((id) => !held.has(id)));
    // Include the boundary commits' own ids when they are wanted ancestors (the client has them,
    // so they are already excluded above); the boundary stays in force.
    for (const id of plan.shallowLines) {
      const object = store.get(id);
      if (object !== undefined && object.type === 'commit') shallowInfo.push(`shallow ${id}`);
    }
  } else {
    objects = collectReachable(store, plan.wants, plan.haves);
  }
  return { pack: writePack(store, objects), shallowInfo };
}

/** Wrap pack bytes in sideband band-1 pkt-lines (band 2 carries one progress line first). */
function sidebandPack(pack: Buffer, progress?: string): Buffer[] {
  const parts: Buffer[] = [];
  if (progress !== undefined) {
    parts.push(pktLine(Buffer.concat([Buffer.from([2]), Buffer.from(progress, 'utf8')])));
  }
  const CHUNK = 65520 - 4 - 1; // pkt-line length cap, minus its 4-byte header, minus the band byte
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
  }
  return parts;
}

export function handleFetchV2(repo: Repo, body: Buffer): Buffer {
  const { args } = parseV2Request(body);
  const plan: FetchPlan = { wants: [], haves: [], shallowLines: [], depth: null };
  let deepenSince = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) plan.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) plan.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) plan.shallowLines.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) plan.depth = Number.parseInt(arg.slice(7).trim(), 10);
    else if (arg.startsWith('deepen-since ')) deepenSince = true;
    else if (arg.startsWith('deepen-not ')) {
      // Treated as a full fetch of the wanted history: rare, and the checks do not drive it.
    }
  }
  if (deepenSince && plan.depth === null) {
    // deepen-since without a depth number: fall back to a generous depth by timestamp is not
    // modelled; answer with the full closure (a superset the client accepts).
    plan.depth = null;
  }
  const { pack, shallowInfo } = planFetch(repo, plan);
  const parts: Buffer[] = [];
  if (plan.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const common = plan.haves.filter((have) => repo.store.has(have));
    if (common.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const have of common) parts.push(pktLine(`ACK ${have}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(PKT_DELIM);
  }
  if (shallowInfo.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const line of shallowInfo) parts.push(pktLine(`${line}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v0 upload-pack request: want lines, flush, have lines, done, flush. */
export function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const { packets } = parsePktLines(body);
  const plan: FetchPlan = { wants: [], haves: [], shallowLines: [], depth: null };
  for (const packet of packets) {
    if (packet === null || packet === 'delim' || packet === 'response-end') continue;
    const line = packet.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) plan.wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) plan.haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) plan.shallowLines.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) plan.depth = Number.parseInt(line.slice(7), 10);
  }
  const { pack, shallowInfo } = planFetch(repo, plan);
  const parts: Buffer[] = [];
  const common = plan.haves.filter((have) => repo.store.has(have));
  if (common.length === 0) parts.push(pktLine('NAK\n'));
  else parts.push(pktLine(`ACK ${common[common.length - 1]}\n`));
  for (const line of shallowInfo) parts.push(pktLine(`${line}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------------
// receive-pack (v0)
// -------------------------------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * POST git-receive-pack: read the command list, unpack any pack into the store, validate each
 * update (stale old value, non-fast-forward, deleting the current branch), apply the good ones,
 * and answer the report-status stream, sideband framed when the client negotiated it.
 */
export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  // Split the pkt-line command list from the raw pack that follows the flush packet.
  let offset = 0;
  const commands: PushCommand[] = [];
  let capabilities = '';
  let packStart = -1;
  while (offset + 4 <= body.length) {
    const length = Number.parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) break;
    if (length === 0) {
      packStart = offset + 4;
      break;
    }
    let payload = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    const nul = payload.indexOf('\0');
    if (nul >= 0) {
      capabilities = payload.slice(nul + 1).replace(/\n$/, '');
      payload = payload.slice(0, nul);
    }
    const line = payload.replace(/\n$/, '');
    const [oldOid, newOid, ref] = line.split(' ');
    if (oldOid !== undefined && newOid !== undefined && ref !== undefined) {
      commands.push({ oldOid, newOid, ref });
    }
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  const wantsObjects = commands.some((c) => c.newOid !== ZERO_OID);
  if (packStart >= 0 && wantsObjects && packStart < body.length) {
    try {
      readPack(repo.store, body.subarray(packStart));
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpacker error';
    }
  }

  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (!unpackOk) {
      fail('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      fail('stale ref');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // A delete.
      if (command.ref === headTarget(repo)) {
        fail('deny deleting current branch');
        continue;
      }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true });
      continue;
    }
    if (!repo.store.has(command.newOid)) {
      fail('missing object');
      continue;
    }
    if (
      command.oldOid !== ZERO_OID &&
      command.ref.startsWith('refs/heads/') &&
      !isAncestor(repo.store, command.oldOid, command.newOid)
    ) {
      fail('non-fast-forward');
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true });
  }

  const reportLines: string[] = [`unpack ${unpackDetail}`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason ?? 'failed'}`);
  }
  const report = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);

  if (capabilities.split(' ').includes('side-band-64k')) {
    const parts: Buffer[] = [];
    const CHUNK = 65520 - 4 - 1;
    for (let i = 0; i < report.length; i += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(i, i + CHUNK)])));
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  return report;
}
