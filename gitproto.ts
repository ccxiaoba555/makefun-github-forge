// Git smart-HTTP protocol: pkt-line framing, packfile v2 read/write (with OFS/REF delta
// resolution), v2 + v0 upload-pack advertisements and fetch, and v0 receive-pack push.
// Written against the kit's public git-client.ts behavior.
import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Forge, ZERO_OID, hashObject, parseCommit, parseTag, parseTree, type GitObject, type GitObjectType } from './store.ts';

// ---------------------------------------------------------------- pkt-line
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}
export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export function pktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}
export interface Pkt { kind: 'data' | 'flush' | 'delim' | 'response-end'; payload: Buffer; }
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line');
    const hex = buf.subarray(off, off + 4).toString('ascii');
    const len = parseInt(hex, 16);
    if (Number.isNaN(len)) break; // raw trailing bytes (pack data after flush)
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (off + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}
/** Decode pkt-lines until the first flush; return packets + byte offset just past the flush. */
export function decodeUntilFlush(buf: Buffer): { packets: Pkt[]; offset: number } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const hex = buf.subarray(off, off + 4).toString('ascii');
    const len = parseInt(hex, 16);
    if (Number.isNaN(len) || len < 0) break;
    if (len === 0) { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); return { packets, offset: off + 4 }; }
    if (len === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { packets.push({ kind: 'response-end', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, offset: off };
}

// ---------------------------------------------------------------- packfile
const TYPE_NUM: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function writePack(objects: Array<{ type: GitObjectType; data: Buffer }>): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0);
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of objects) {
    const typeNum = TYPE_NUM[obj.type];
    const size = obj.data.length;
    // varint header: first byte holds type (bits 4-6) + low 4 size bits
    const headerBytes: number[] = [];
    let s = size;
    let first = (typeNum << 4) | (s & 0x0f);
    s >>>= 4;
    if (s > 0) first |= 0x80;
    headerBytes.push(first);
    while (s > 0) {
      let b = s & 0x7f;
      s >>>= 7;
      if (s > 0) b |= 0x80;
      headerBytes.push(b);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

interface RawEntry { typeNum: number; data: Buffer; oid: string; baseOid?: string; baseOffset?: number; }
function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = buf[off] & 0x7f;
  let shift = 7;
  let i = off + 1;
  while (buf[i - 1] & 0x80) { value |= (buf[i] & 0x7f) << shift; shift += 7; i += 1; }
  return { value, next: i };
}
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const count = pack.readUInt32BE(8);
  let off = 12;
  const entries: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  for (let i = 0; i < count; i += 1) {
    const start = off;
    const typeNum = (pack[off] >> 4) & 0x07;
    let size = pack[off] & 0x0f;
    let shift = 4;
    let b = pack[off];
    off += 1;
    while (b & 0x80) { b = pack[off]; size |= (b & 0x7f) << shift; shift += 7; off += 1; }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeNum === 6) { // OFS_DELTA
      const { value, next } = readVarint(pack, off);
      off = next;
      baseOffset = start - value;
    } else if (typeNum === 7) { // REF_DELTA
      baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const { data, next } = inflateWithLength(pack, off);
    off = next;
    const entry: RawEntry = { typeNum, data, oid: '', baseOid, baseOffset };
    entries.push(entry);
    byOffset.set(start, entry);
  }
  // resolve deltas
  const out = new Map<string, GitObject>();
  const resolve = (entry: RawEntry, depth: number): GitObject => {
    if (depth > 64) throw new Error('delta chain too deep');
    if (entry.typeNum >= 1 && entry.typeNum <= 4) {
      const type = NUM_TYPE[entry.typeNum];
      const oid = hashObject(type, entry.data);
      return { type, data: entry.data };
    }
    let base: GitObject;
    if (entry.typeNum === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base not in pack');
      base = resolve(baseEntry, depth + 1);
    } else {
      const fromPack = [...entries].find((e) => e.typeNum >= 1 && e.typeNum <= 4 && hashObject(NUM_TYPE[e.typeNum], e.data) === entry.baseOid);
      if (fromPack) base = resolve(fromPack, depth + 1);
      else if (resolveBase) {
        const b = resolveBase(entry.baseOid!);
        if (!b) throw new Error(`ref-delta base ${entry.baseOid} not found`);
        base = b;
      } else throw new Error(`ref-delta base ${entry.baseOid} not found`);
    }
    const data = applyDelta(base.data, entry.data);
    return { type: base.type, data };
  };
  for (const entry of entries) {
    const obj = resolve(entry, 0);
    out.set(hashObject(obj.type, obj.data), obj);
  }
  return out;
}
function inflateWithLength(buf: Buffer, off: number): { data: Buffer; next: number } {
  // inflateSync ignores trailing bytes and throws on a truncated stream, and success is monotone
  // in the slice length, so binary-search the first length that inflates. The pack trailer (20
  // bytes) is not part of any stream, so cap the search there.
  const hi = buf.length - 20;
  let lo = off + 1;
  let end = hi;
  let found = -1;
  while (lo <= end) {
    const mid = (lo + end) >> 1;
    try {
      inflateSync(buf.subarray(off, mid));
      found = mid;
      end = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (found < 0) throw new Error('incomplete deflate stream in pack');
  return { data: inflateSync(buf.subarray(off, found)), next: found };
}
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++];
      value |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return value;
  };
  const baseSize = readDeltaVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readDeltaVarint();
  const parts: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) cpOff |= delta[off++] << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) cpSize |= delta[off++] << (8 * i);
      if (cpSize === 0) cpSize = 0x10000;
      parts.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op > 0) {
      parts.push(delta.subarray(off, off + op));
      off += op;
      total += op;
    } else throw new Error('delta op 0');
  }
  const out = Buffer.concat(parts);
  if (out.length !== resultSize || total !== resultSize) throw new Error('delta result size mismatch');
  return out;
}
export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return actual === expected;
}

// ---------------------------------------------------------------- advertisements
export interface AdvertisedRef { oid: string; name: string; peeled?: string; symrefTarget?: string; unborn?: boolean; }

export function listRefs(forge: Forge, repo: { refs: Map<string, string> }): AdvertisedRef[] {
  const refs: AdvertisedRef[] = [];
  const defaultBranch = 'main';
  const headTip = repo.refs.get(`refs/heads/${defaultBranch}`);
  refs.push({
    oid: headTip ?? ZERO_OID,
    name: 'HEAD',
    symrefTarget: `refs/heads/${defaultBranch}`,
    ...(headTip ? {} : { unborn: true }),
  });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: AdvertisedRef = { oid, name };
    const obj = forge.getObject(oid);
    if (obj?.type === 'tag') {
      const peeled = forge.peelToCommit(oid);
      if (peeled) entry.peeled = peeled;
    }
    refs.push(entry);
  }
  // An unborn repo advertises HEAD only: the clone-empty check requires zero refs/ entries.
  return refs;
}

const UPLOAD_V0_CAPS = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=makefun-forge/1.0 symref=HEAD:refs/heads/main';
const RECEIVE_V0_CAPS = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=makefun-forge/1.0 symref=HEAD:refs/heads/main';

export function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', forge: Forge, repo: { refs: Map<string, string> }): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const refs = listRefs(forge, repo);
  const items: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  refs.forEach((ref, i) => {
    let line = `${ref.oid} ${ref.name}`;
    if (i === 0) line += `\0${caps}`;
    items.push(`${line}\n`);
    if (ref.peeled) items.push(`${ref.peeled} ${ref.name}^{}\n`);
  });
  items.push('flush');
  return pktLines(items as Array<string | Buffer | 'flush' | 'delim'>);
}
export function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
    'agent=makefun-forge/1.0\n',
    'flush',
  ]);
}

// ---------------------------------------------------------------- upload-pack
export interface FetchRequest {
  wants: string[]; haves: string[]; shallow: string[]; depth?: number;
  deepenSince?: number; deepenNot: string[]; filter?: string;
}
export function parseV2Command(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind === 'delim') { seenDelim = true; continue; }
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) {
      if (text.startsWith('command=')) command = text.slice('command='.length);
      continue;
    }
    args.push(text);
  }
  return { command, args };
}

export function lsRefsResponse(forge: Forge, repo: { refs: Map<string, string> }, args: string[]): Buffer {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const refs = listRefs(forge, repo);
  const lines: string[] = [];
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    if (ref.unborn && !wantUnborn) continue;
    if (ref.unborn) {
      let line = `unborn ${ref.name}`;
      if (wantSymrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
      lines.push(`${line}\n`);
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (wantPeel && ref.peeled) line += ` peeled:${ref.peeled}`;
    if (wantSymrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return pktLines(lines as Array<string | Buffer | 'flush' | 'delim'>);
}

export function fetchResponse(forge: Forge, repo: { refs: Map<string, string> }, req: FetchRequest): Buffer {
  const wants = [...new Set(req.wants)];
  const sections: Buffer[] = [];
  // acknowledgments
  if (req.haves.length) {
    const acks: string[] = [];
    for (const have of req.haves) {
      // ACK if the have is an ancestor of (or equal to) any want
      if (wants.includes(have)) acks.push(`ACK ${have}\n`);
      else {
        for (const w of wants) {
          if (forge.isAncestor(have, w)) { acks.push(`ACK ${have}\n`); break; }
        }
      }
    }
    const lines: Array<string | 'delim'> = ['acknowledgments\n', ...acks, 'ready\n'];
    sections.push(pktLines([...lines, 'delim'] as Array<string | Buffer | 'flush' | 'delim'>));
  }
  // compute the object set
  const { objects, shallow } = forge.reachableObjects(wants, req.depth);
  if (req.haves.length) {
    // exclude objects the client already has — but stop at the previous shallow boundary:
    // the client holds the boundary commit itself, not its history, so the history beyond
    // the boundary is still new to it (deepen).
    const haveReach = forge.reachableObjects(req.haves, undefined, new Set(req.shallow));
    for (const oid of haveReach.objects) objects.delete(oid);
  }
  const nothingNew = objects.size === 0;
  // shallow-info
  const shallowLines: string[] = [];
  if (req.depth !== undefined) {
    for (const s of shallow) shallowLines.push(`shallow ${s}\n`);
    for (const prev of req.shallow) {
      // a previous shallow boundary whose parents are now included becomes unshallow
      if (!shallow.includes(prev)) shallowLines.push(`unshallow ${prev}\n`);
    }
  }
  if (shallowLines.length) {
    sections.push(pktLines(['shallow-info\n', ...shallowLines, 'delim'] as Array<string | Buffer | 'flush' | 'delim'>));
  }
  // packfile
  if (!nothingNew) {
    const objs = [...objects].map((oid) => {
      const o = forge.getObject(oid)!;
      return { type: o.type, data: o.data };
    });
    const pack = writePack(objs);
    const sideband: Buffer[] = [];
    const CHUNK = 65500;
    for (let off = 0; off < pack.length; off += CHUNK) {
      const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
      sideband.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    sections.push(Buffer.concat([pktLine('packfile\n'), ...sideband, FLUSH]));
  } else {
    sections.push(FLUSH);
  }
  return Buffer.concat(sections);
}

export function parseV0Fetch(body: Buffer): FetchRequest {
  const { packets } = decodeUntilFlush(body);
  const lines: string[] = [];
  for (const p of packets) if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepenNot: [] };
  let secondSection = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === '') { secondSection = true; continue; }
    if (line.startsWith('want ')) req.wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) req.depth = Number(line.slice(7));
    else if (line.startsWith('deepen-since ')) req.deepenSince = Number(line.slice(13));
    else if (line.startsWith('deepen-not ')) req.deepenNot.push(line.slice(11));
    else if (line.startsWith('have ')) req.haves.push(line.slice(5));
    else if (line === 'done') { /* end */ }
    void secondSection;
  }
  // v0 bodies have two sections separated by a flush; decodeUntilFlush only read the first.
  // Re-parse the whole body: lines after the first flush belong to section two.
  const all = decodePktLines(body);
  const lines2: string[] = [];
  for (const p of all) if (p.kind === 'data') lines2.push(p.payload.toString('utf8'));
  for (const raw of lines2) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('have ')) { const h = line.slice(5); if (!req.haves.includes(h)) req.haves.push(h); }
  }
  return req;
}

export function v0FetchResponse(forge: Forge, repo: { refs: Map<string, string> }, req: FetchRequest): Buffer {
  const wants = [...new Set(req.wants)];
  const parts: Buffer[] = [];
  // NAK / ACK lines as plain packets
  const acks: string[] = [];
  for (const have of req.haves) {
    if (wants.includes(have)) acks.push(`ACK ${have}\n`);
    else for (const w of wants) if (forge.isAncestor(have, w)) { acks.push(`ACK ${have}\n`); break; }
  }
  if (acks.length) for (const a of acks) parts.push(pktLine(a));
  else parts.push(pktLine('NAK\n'));
  const { objects, shallow } = forge.reachableObjects(wants, req.depth);
  if (req.haves.length) {
    const haveReach = forge.reachableObjects(req.haves, undefined, new Set(req.shallow));
    for (const oid of haveReach.objects) objects.delete(oid);
  }
  if (req.depth !== undefined) for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  if (objects.size) {
    const objs = [...objects].map((oid) => {
      const o = forge.getObject(oid)!;
      return { type: o.type, data: o.data };
    });
    const pack = writePack(objs);
    const CHUNK = 65500;
    for (let off = 0; off < pack.length; off += CHUNK) {
      const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack
export interface PushCommand { oldOid: string; newOid: string; ref: string; }
export function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const { packets, offset } = decodeUntilFlush(body);
  const commands: PushCommand[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const head = nul >= 0 ? text.slice(0, nul) : text;
    const [oldOid, newOid, ref] = head.split(' ');
    if (oldOid && newOid && ref) commands.push({ oldOid, newOid, ref });
  }
  return { commands, pack: body.subarray(offset) };
}
export function pushReportResponse(results: Array<{ ref: string; ok: boolean; reason: string }>, unpackOk: boolean, unpackDetail = 'ok'): Buffer {
  const lines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const r of results) lines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  const inner = pktLines([...lines, 'flush'] as Array<string | Buffer | 'flush' | 'delim'>);
  // wrap the whole report stream in one sideband band-1 packet (chunked if needed)
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let off = 0; off < inner.length; off += CHUNK) {
    const slice = inner.subarray(off, Math.min(inner.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function applyPush(forge: Forge, repo: { refs: Map<string, string> }, commands: PushCommand[], packObjects: Map<string, GitObject>): Array<{ ref: string; ok: boolean; reason: string }> {
  // store the new objects first (unpack)
  for (const [oid, obj] of packObjects) {
    if (!forge.hasObject(oid)) forge.objects.set(oid, obj);
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (!current) { results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' }); continue; }
      repo.refs.delete(cmd.ref);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (!forge.hasObject(cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // create
      if (current) { results.push({ ref: cmd.ref, ok: false, reason: 'already exists' }); continue; }
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    // update: must be fast-forward from current
    if (current !== cmd.oldOid) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!forge.isAncestor(cmd.oldOid, cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  return results;
}
