// In-memory GitHub-compatible forge store, plus the deterministic scenario identity
// derivation ported from the kit's public wire.ts (SCENARIO_SEED, FNV-1a 64, mix64,
// xorshift64*, generateUsers). The suite addresses repos as /repos/{viewer-login}/{name}
// and requires the same token to 404 for the stranger's owner segment, so the viewer /
// teammate / stranger logins must match the kit's derivation exactly.
import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const DEFAULT_BRANCH = 'main';

// ---------------------------------------------------------------- scenario RNG (port of wire.ts)
const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}
function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}
class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}
const FIRST_NAMES = ['ada','bram','cora','dmitri','elena','felix','greta','hugo','iris','jonas','kira','lars','mira','nico','olga','pavel','quinn','rosa','sven','tess','ulla','vito','wren','yara','zane'];
const LAST_NAMES = ['anders','bauer','costa','dahl','eriksen','fischer','garcia','holm','iversen','jansen','keller','lind','moreau','novak','olsen','peters','quist','rossi','sato','turi','ulrich','vega','weber','xu','yilmaz','zimmer'];

export interface ForgeUser { id: number; login: string; name: string; email: string; }
function generateUsers(count: number): ForgeUser[] {
  const rng = new Rng(scenarioSeedFor('users'));
  const used = new Set<string>();
  const users: ForgeUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) { login = `${base}-${suffix}`; suffix += 1; }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}
const USERS = generateUsers(12);
export const VIEWER: ForgeUser = USERS[0];
export const TEAMMATE: ForgeUser = USERS[1];
export const STRANGER: ForgeUser = USERS[2];

// ---------------------------------------------------------------- git object model
export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject { type: GitObjectType; data: Buffer; }

export function hashObject(type: GitObjectType, data: Buffer | Uint8Array): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface TreeEntry { mode: string; name: string; oid: string; }
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp);
    const mode = data.subarray(off, sp).toString('utf8');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export interface CommitInfo {
  tree: string; parents: string[]; author: string; committer: string; message: string;
  authorTime: number; committerTime: number;
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
  let authorTime = 0;
  let committerTime = 0;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) { author = line.slice(7); authorTime = parseIdentTime(author); }
    else if (line.startsWith('committer ')) { committer = line.slice(10); committerTime = parseIdentTime(committer); }
  }
  return { tree, parents, author, committer, message, authorTime, committerTime };
}
function parseIdentTime(ident: string): number {
  const m = / (\d+) [+-]\d{4}$/.exec(ident);
  return m ? Number(m[1]) : 0;
}
export function identLine(user: ForgeUser, timeSec: number): string {
  return `${user.name} <${user.email}> ${timeSec} +0000`;
}
export function buildCommit(opts: { tree: string; parents: string[]; author: string; committer: string; message: string }): Buffer {
  const lines = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${opts.author}`);
  lines.push(`committer ${opts.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${opts.message}`, 'utf8');
}
export interface TagInfo { object: string; type: GitObjectType; tag: string; tagger: string; message: string; }
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let object = ''; let type: GitObjectType = 'commit'; let tag = ''; let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- forge store
export interface Issue {
  owner: string; repoName: string;
  number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; createdAt: string; updatedAt: string; closedAt: string | null;
  comments: Array<{ id: number; body: string; user: ForgeUser; createdAt: string }>;
  createdSeq: number;
}
export interface PullRequest {
  owner: string; repoName: string;
  number: number; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  headRef: string; baseRef: string; headSha: string; baseSha: string; baseShaAtCreate: string;
  createdAt: string; updatedAt: string; createdSeq: number;
}
export interface Repo {
  id: number; name: string; owner: string; description: string; isPrivate: boolean;
  defaultBranch: string; createdAt: string; updatedAt: string;
  refs: Map<string, string>; // full refname -> oid
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  counter: number; commentCounter: number;
  labels: Map<string, { name: string; color: string }>;
}

export class Forge {
  objects = new Map<string, GitObject>();
  repos = new Map<string, Repo>(); // key owner/name
  nextRepoId = 5000;
  private seq = 0;
  nextSeq(): number { return ++this.seq; }
  /** Parsed-commit cache: bench push walks the same chain on every update. */
  private commitCache = new Map<string, CommitInfo>();
  private tagCache = new Map<string, TagInfo>();
  commitInfo(oid: string): CommitInfo | null {
    const hit = this.commitCache.get(oid);
    if (hit) return hit;
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    const info = parseCommit(obj.data);
    this.commitCache.set(oid, info);
    return info;
  }
  tagInfo(oid: string): TagInfo | null {
    const hit = this.tagCache.get(oid);
    if (hit) return hit;
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'tag') return null;
    const info = parseTag(obj.data);
    this.tagCache.set(oid, info);
    return info;
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }
  getObject(oid: string): GitObject | undefined { return this.objects.get(oid); }
  hasObject(oid: string): boolean { return this.objects.has(oid); }

  repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
  getRepo(owner: string, name: string): Repo | undefined { return this.repos.get(this.repoKey(owner, name)); }
  listViewerRepos(): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === VIEWER.login).sort((a, b) => a.id - b.id);
  }
  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const now = new Date().toISOString();
    const repo: Repo = {
      id: this.nextRepoId++, name, owner: VIEWER.login, description, isPrivate,
      defaultBranch: DEFAULT_BRANCH, createdAt: now, updatedAt: now,
      refs: new Map(), issues: new Map(), pulls: new Map(),
      counter: 0, commentCounter: 0, labels: new Map(),
    };
    this.repos.set(this.repoKey(VIEWER.login, name), repo);
    return repo;
  }
  deleteRepo(owner: string, name: string): boolean { return this.repos.delete(this.repoKey(owner, name)); }

  // ---- tree helpers (per repo, objects are global by hash)
  flattenTree(treeOid: string, prefix: string, out: Map<string, { mode: string; oid: string }>): void {
    const obj = this.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') this.flattenTree(e.oid, path, out);
      else out.set(path, { mode: e.mode, oid: e.oid });
    }
  }
  buildTreeFromFlat(flat: Map<string, { mode: string; oid: string }>): string {
    // group by first path segment, recurse
    const build = (paths: Array<{ parts: string[]; mode: string; oid: string }>): string => {
      const byFirst = new Map<string, Array<{ parts: string[]; mode: string; oid: string }>>();
      for (const p of paths) {
        const first = p.parts[0];
        const list = byFirst.get(first) ?? [];
        list.push(p);
        byFirst.set(first, list);
      }
      const entries: TreeEntry[] = [];
      for (const [name, list] of byFirst) {
        if (list.length === 1 && list[0].parts.length === 1) {
          entries.push({ mode: list[0].mode, name, oid: list[0].oid });
        } else {
          const sub = list.map((p) => ({ parts: p.parts.slice(1), mode: p.mode, oid: p.oid }));
          entries.push({ mode: '40000', name, oid: build(sub) });
        }
      }
      return this.putObject('tree', buildTree(entries));
    };
    const paths = [...flat.entries()].map(([path, v]) => ({ parts: path.split('/'), mode: v.mode, oid: v.oid }));
    if (paths.length === 0) return this.putObject('tree', Buffer.alloc(0));
    return build(paths);
  }

  commitOnBranch(repo: Repo, branch: string, flat: Map<string, { mode: string; oid: string }>, message: string): string {
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref);
    const treeOid = this.buildTreeFromFlat(flat);
    const nowSec = Math.floor(Date.now() / 1000);
    const ident = identLine(VIEWER, nowSec);
    const commit = buildCommit({ tree: treeOid, parents: parent ? [parent] : [], author: ident, committer: ident, message });
    const oid = this.putObject('commit', commit);
    repo.refs.set(ref, oid);
    repo.updatedAt = new Date().toISOString();
    return oid;
  }

  refTip(repo: Repo, ref: string): string | undefined { return repo.refs.get(ref); }
  branchTip(repo: Repo, branch: string): string | undefined { return repo.refs.get(`refs/heads/${branch}`); }

  isAncestor(ancestor: string, descendant: string): boolean {
    // walk first-parent + all-parent chain from descendant (bounded)
    const seen = new Set<string>();
    const stack = [descendant];
    let steps = 0;
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === ancestor) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const info = this.commitInfo(cur);
      if (!info) continue;
      for (const p of info.parents) stack.push(p);
      if (++steps > 200000) return false;
    }
    return false;
  }
  /** All objects reachable from the given commits (commits+trees+blobs), honoring depth.
   *  `stopAt`: commits whose own objects are included but whose parents are NOT traversed —
   *  the shallow boundary: the client already holds the boundary commit, not its history. */
  reachableObjects(fromOids: readonly string[], depth?: number, stopAt?: ReadonlySet<string>): { objects: Set<string>; shallow: string[] } {
    const objects = new Set<string>();
    const shallow: string[] = [];
    const queue: Array<{ oid: string; d: number }> = fromOids.map((oid) => ({ oid, d: 0 }));
    const seenCommits = new Set<string>();
    for (let qi = 0; qi < queue.length; qi += 1) {
      const { oid, d } = queue[qi];
      const obj = this.objects.get(oid);
      if (!obj) continue;
      if (obj.type === 'commit') {
        if (seenCommits.has(oid)) continue;
        seenCommits.add(oid);
        objects.add(oid);
        const info = this.commitInfo(oid);
        if (!info) continue;
        this.collectTree(info.tree, objects);
        if (stopAt?.has(oid)) continue; // shallow boundary: do not descend past it
        if (depth !== undefined && d + 1 >= depth) {
          // this commit is a shallow boundary: its parents are cut
          if (info.parents.length) shallow.push(oid);
          continue;
        }
        for (const p of info.parents) queue.push({ oid: p, d: d + 1 });
      } else if (obj.type === 'tag') {
        objects.add(oid);
        const tag = this.tagInfo(oid);
        if (tag) queue.push({ oid: tag.object, d });
      } else {
        objects.add(oid);
      }
    }
    return { objects, shallow };
  }
  private collectTree(treeOid: string, out: Set<string>): void {
    const obj = this.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    if (out.has(treeOid)) return;
    out.add(treeOid);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') this.collectTree(e.oid, out);
      else out.add(e.oid);
    }
  }
  /** Peel an annotated tag (or any object) to its commit. */
  peelToCommit(oid: string): string | null {
    let cur = oid;
    for (let i = 0; i < 10; i += 1) {
      const obj = this.objects.get(cur);
      if (!obj) return null;
      if (obj.type === 'commit') return cur;
      if (obj.type === 'tag') { const tag = this.tagInfo(cur); if (!tag) return null; cur = tag.object; continue; }
      return null;
    }
    return null;
  }
  /** Commits reachable from tip, newest first (by committer time desc, then insertion order). */
  listCommits(tip: string): Array<{ sha: string; info: CommitInfo }> {
    const seen = new Set<string>();
    const out: Array<{ sha: string; info: CommitInfo; seq: number }> = [];
    let seq = 0;
    const stack = [tip];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const info = this.commitInfo(cur);
      if (!info) continue;
      out.push({ sha: cur, info, seq: seq++ });
      for (const p of info.parents) stack.push(p);
    }
    out.sort((a, b) => (b.info.committerTime - a.info.committerTime) || (b.seq - a.seq));
    return out;
  }
  /** Line-diff counts between two blob contents (simple LCS on lines). */
  static diffLineCounts(oldText: string, newText: string): { additions: number; deletions: number } {
    const a = oldText.split('\n');
    const b = newText.split('\n');
    if (oldText === '') a.length = 0;
    if (newText === '') b.length = 0;
    // LCS length via DP on line arrays (files here are small)
    const m = a.length, n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const lcs = dp[0][0];
    return { additions: n - lcs, deletions: m - lcs };
  }
  /** Diff between two tree oids: list of {filename, status, additions, deletions}. */
  diffTrees(baseTree: string, headTree: string): Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> {
    const base = new Map<string, { mode: string; oid: string }>();
    const head = new Map<string, { mode: string; oid: string }>();
    if (baseTree) this.flattenTree(baseTree, '', base);
    if (headTree) this.flattenTree(headTree, '', head);
    const out: Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const oldText = this.objects.get(b.oid)?.data.toString('utf8') ?? '';
        const { deletions } = Forge.diffLineCounts(oldText, '');
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (!b && h) {
        const newText = this.objects.get(h.oid)?.data.toString('utf8') ?? '';
        const { additions } = Forge.diffLineCounts('', newText);
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b && h && b.oid !== h.oid) {
        const oldText = this.objects.get(b.oid)?.data.toString('utf8') ?? '';
        const newText = this.objects.get(h.oid)?.data.toString('utf8') ?? '';
        const { additions, deletions } = Forge.diffLineCounts(oldText, newText);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }
  /** Is merging head into base conflicted? Same path changed on both sides vs merge-base, differently. */
  mergeConflict(baseSha: string, headSha: string, currentBaseSha: string): boolean {
    const baseCommit = this.objects.get(baseSha);
    const headCommit = this.objects.get(headSha);
    const curCommit = this.objects.get(currentBaseSha);
    if (!baseCommit || !headCommit || !curCommit) return false;
    const baseTree = parseCommit(baseCommit.data).tree;
    const headTree = parseCommit(headCommit.data).tree;
    const curTree = parseCommit(curCommit.data).tree;
    const baseFlat = new Map<string, { mode: string; oid: string }>();
    const headFlat = new Map<string, { mode: string; oid: string }>();
    const curFlat = new Map<string, { mode: string; oid: string }>();
    this.flattenTree(baseTree, '', baseFlat);
    this.flattenTree(headTree, '', headFlat);
    this.flattenTree(curTree, '', curFlat);
    const paths = new Set([...headFlat.keys(), ...curFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path)?.oid;
      const h = headFlat.get(path)?.oid;
      const c = curFlat.get(path)?.oid;
      const headChanged = h !== b;
      const curChanged = c !== b;
      if (headChanged && curChanged && h !== c) return true;
    }
    return false;
  }
}

export function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64url(input: string): string | null {
  try {
    const norm = input.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(norm, 'base64').toString('utf8');
  } catch { return null; }
}
