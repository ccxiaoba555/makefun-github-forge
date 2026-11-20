// GitHub REST v3 surface (/api/v3). Every reply is application/json with a non-empty
// X-GitHub-Request-Id. Errors are {message}. Pagination uses Link rel=next/prev/first/last
// with same-origin absolute URLs.
import { randomBytes } from 'node:crypto';
import { Forge, VIEWER, ZERO_OID, b64url, parseCommit, type Issue, type PullRequest, type Repo } from './store.ts';

export interface Ctx {
  forge: Forge;
  baseUrl: string; // e.g. http://127.0.0.1:PORT (for Link headers / urls)
}
export interface Req {
  method: string;
  path: string; // decoded path, no query
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: unknown; // parsed JSON or undefined; bodyRaw for error detection
  bodyInvalid: boolean;
}
export interface Resp {
  status: number;
  headers?: Record<string, string>;
  body: unknown; // object/array to JSON-encode, or Buffer, or null for empty
  rawBody?: Buffer; // pre-serialized JSON: sent as-is, skips stringify
}

/** Request ids only need to be non-empty and unique-ish: a counter avoids a
 *  getrandom syscall on every response (expensive under gVisor). */
let reqCounter = 0;
const reqPrefix = randomBytes(4).toString('hex');
export function reqId(): string { return `${reqPrefix}${(++reqCounter).toString(16).padStart(8, '0')}`; }
export function json(status: number, body: unknown, extra?: Record<string, string>): Resp {
  return { status, headers: extra, body };
}
export function err(status: number, message: string): Resp {
  return { status, body: { message } };
}
const nowIso = (): string => new Date().toISOString();
/** User rows are near-static: one timestamp for the process keeps issue payloads cacheable. */
const USER_UPDATED_AT = new Date().toISOString();

// ---- cached single-issue payloads (bench read hits the same issue 2,000x)
// Keyed owner/repo#number; invalidated on every mutation of that issue (PATCH,
// comment POST), on label creation in the repo (label colours feed issueJson),
// and on repo deletion.
const issuePayloadCache = new Map<string, Buffer>();
const issueCacheKey = (owner: string, repoName: string, number: number): string => `${owner}/${repoName}#${number}`;
function dropIssuePayload(owner: string, repoName: string, number: number): void {
  issuePayloadCache.delete(issueCacheKey(owner, repoName, number));
}
function dropRepoIssuePayloads(owner: string, repoName: string): void {
  const prefix = `${owner}/${repoName}#`;
  for (const key of [...issuePayloadCache.keys()]) if (key.startsWith(prefix)) issuePayloadCache.delete(key);
}
function cachedIssueJson(ctx: Ctx, r: Repo, i: Issue): Resp {
  const key = issueCacheKey(r.owner, r.name, i.number);
  const hit = issuePayloadCache.get(key);
  if (hit) return { status: 200, body: null, rawBody: hit };
  const payload = Buffer.from(JSON.stringify(issueJson(ctx, r, i)), 'utf8');
  issuePayloadCache.set(key, payload);
  return { status: 200, body: null, rawBody: payload };
}

// ---- shapes
function userJson(u: typeof VIEWER) {
  return {
    login: u.login, id: u.id, node_id: b64url(`U:${u.login}`), avatar_url: '',
    type: 'User', site_admin: false, html_url: `https://github.com/${u.login}`,
    url: `/api/v3/users/${u.login}`, created_at: '2025-01-01T00:00:00Z', updated_at: USER_UPDATED_AT,
  };
}
function repoJson(ctx: Ctx, r: Repo) {
  return {
    id: r.id, node_id: b64url(`R:${r.owner}/${r.name}`), name: r.name, full_name: `${r.owner}/${r.name}`,
    owner: userJson(VIEWER), private: r.isPrivate, html_url: `https://github.com/${r.owner}/${r.name}`,
    description: r.description, fork: false, url: `/api/v3/repos/${r.owner}/${r.name}`,
    created_at: r.createdAt, updated_at: r.updatedAt, pushed_at: r.updatedAt,
    git_url: `git://github.com/${r.owner}/${r.name}.git`,
    ssh_url: `git@github.com:${r.owner}/${r.name}.git`,
    clone_url: `https://github.com/${r.owner}/${r.name}.git`,
    homepage: '', size: 0, stargazers_count: 0, watchers_count: 0, language: null,
    has_issues: true, has_projects: true, has_downloads: true, has_wiki: true, has_pages: false,
    has_discussions: false, forks_count: 0, open_issues_count: [...r.issues.values()].filter((i) => i.state === 'open').length,
    license: null, allow_forking: true, is_template: false, topics: [],
    visibility: r.isPrivate ? 'private' : 'public', default_branch: r.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}
function labelJson(l: { name: string; color: string }) {
  return { id: 0, node_id: b64url(`L:${l.name}`), url: '', name: l.name, color: l.color, default: false, description: '' };
}
function issueJson(ctx: Ctx, r: Repo, i: Issue) {
  return {
    id: r.id * 100000 + i.number, node_id: b64url(`I:${r.owner}/${r.name}#${i.number}`),
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}`,
    repository_url: `/api/v3/repos/${r.owner}/${r.name}`,
    html_url: `https://github.com/${r.owner}/${r.name}/issues/${i.number}`,
    number: i.number, title: i.title, body: i.body, state: i.state,
    user: userJson(VIEWER), labels: i.labels.map((name) => labelJson(r.labels.get(name) ?? { name, color: 'ededed' })),
    assignee: null, assignees: [], locked: false, comments: i.comments.length,
    created_at: i.createdAt, updated_at: i.updatedAt, closed_at: i.closedAt,
    author_association: 'OWNER', active_lock_reason: null,
  };
}
function prJson(ctx: Ctx, r: Repo, p: PullRequest) {
  return {
    id: r.id * 100000 + p.number, node_id: b64url(`P:${r.owner}/${r.name}#${p.number}`),
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
    html_url: `https://github.com/${r.owner}/${r.name}/pull/${p.number}`,
    number: p.number, title: p.title, body: p.body, state: p.state,
    user: userJson(VIEWER), locked: false,
    head: { label: `${r.owner}:${p.headRef}`, ref: p.headRef, sha: p.headSha, user: userJson(VIEWER), repo: repoJson(ctx, r) },
    base: { label: `${r.owner}:${p.baseRef}`, ref: p.baseRef, sha: p.baseSha, user: userJson(VIEWER), repo: repoJson(ctx, r) },
    merged: p.merged, mergeable: !p.merged && !ctx.forge.mergeConflict(p.baseShaAtCreate, p.headSha, p.baseSha),
    mergeable_state: p.merged ? 'merged' : 'clean', merged_at: p.mergedAt, merge_commit_sha: p.mergeCommitSha,
    draft: false, created_at: p.createdAt, updated_at: p.updatedAt, closed_at: p.state === 'closed' ? p.updatedAt : null,
    author_association: 'OWNER', auto_merge: null, active_lock_reason: null,
  };
}

// ---- pagination
function paginate<T>(ctx: Ctx, req: Req, items: T[]): Resp {
  const perPage = Math.max(1, Math.min(100, Number(req.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(req.query.get('page') ?? '1') || 1);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const links: string[] = [];
  const urlFor = (p: number) => {
    const q = new URLSearchParams(req.query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `${ctx.baseUrl}${req.path}?${q.toString()}`;
  };
  if (page < pages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(pages)}>; rel="last"`);
  return { status: 200, headers: links.length ? { Link: links.join(', ') } : undefined, body: slice };
}

// ---- helpers
function getRepoOr404(ctx: Ctx, owner: string, name: string): Repo | null {
  return ctx.forge.getRepo(owner, name) ?? null;
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function resolveRef(forge: Forge, repo: Repo, ref: string): string | undefined {
  if (!ref) return forge.branchTip(repo, repo.defaultBranch);
  if (forge.hasObject(ref)) return ref;
  const tip = forge.branchTip(repo, ref);
  if (tip) return tip;
  const full = repo.refs.get(ref);
  if (full) return full;
  return undefined;
}

export function handleRest(ctx: Ctx, req: Req): Resp {
  const { forge } = ctx;
  const seg = req.path.split('/').filter((s) => s !== '');
  // seg[0] is 'api', seg[1] is 'v3'
  const rest = seg.slice(2);
  if (req.bodyInvalid) return err(400, 'Problems parsing JSON');

  // GET /api/v3/
  if (rest.length === 0) {
    if (req.method !== 'GET') return err(404, 'Not Found');
    return json(200, {
      current_user_url: `${ctx.baseUrl}/api/v3/user`,
      current_user_authorizations_html_url: `${ctx.baseUrl}/api/v3/authorizations`,
      authorizations_url: `${ctx.baseUrl}/api/v3/authorizations`,
      repository_url: `${ctx.baseUrl}/api/v3/repos/{owner}/{repo}`,
      rate_limit_url: `${ctx.baseUrl}/api/v3/rate_limit`,
    }, { 'X-Oauth-Scopes': 'repo, read:org' });
  }
  // GET /api/v3/meta
  if (rest[0] === 'meta' && rest.length === 1) {
    if (req.method !== 'GET') return err(404, 'Not Found');
    return json(200, { installed_version: '1.0.0' });
  }
  // /user
  if (rest[0] === 'user') {
    if (rest.length === 1 && req.method === 'GET') return json(200, userJson(VIEWER));
    if (rest.length === 2 && rest[1] === 'repos') {
      if (req.method === 'GET') return paginate(ctx, req, forge.listViewerRepos().map((r) => repoJson(ctx, r)));
      if (req.method === 'POST') {
        const b = isRecord(req.body) ? req.body : {};
        const name = typeof b.name === 'string' ? b.name : '';
        if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'Invalid repository name');
        if (forge.getRepo(VIEWER.login, name)) return err(422, 'Repository already exists');
        const repo = forge.createRepo(
          name,
          typeof b.description === 'string' ? b.description : '',
          b.private === true,
        );
        return json(201, repoJson(ctx, repo));
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }
  // /repos/{owner}/{repo}/...
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = decodeURIComponent(rest[1]);
    const name = decodeURIComponent(rest[2]);
    const tail = rest.slice(3);
    const repoOr = getRepoOr404(ctx, owner, name);
    if (!repoOr) return err(404, 'Not Found');
    const repo = repoOr;
    // DELETE /repos/{o}/{r}
    if (tail.length === 0) {
      if (req.method === 'GET') return json(200, repoJson(ctx, repo));
      if (req.method === 'PATCH') {
        const b = isRecord(req.body) ? req.body : {};
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.default_branch === 'string') repo.defaultBranch = b.default_branch;
        repo.updatedAt = nowIso();
        return json(200, repoJson(ctx, repo));
      }
      if (req.method === 'DELETE') {
        forge.deleteRepo(owner, name);
        dropRepoIssuePayloads(owner, name);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }
    const sub = tail[0];
    // branches
    if (sub === 'branches' && tail.length === 1 && req.method === 'GET') {
      const list = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref), url: '' }, protected: false }));
      return json(200, list);
    }
    // commits
    if (sub === 'commits' && tail.length === 1 && req.method === 'GET') {
      const refParam = req.query.get('sha') ?? undefined;
      const tip = refParam ? resolveRef(forge, repo, refParam) : forge.branchTip(repo, repo.defaultBranch);
      if (!tip) return json(200, []);
      const commits = forge.listCommits(tip).map(({ sha, info }) => ({
        sha, node_id: b64url(`C:${sha}`), url: '', html_url: '',
        commit: {
          message: info.message,
          author: { name: VIEWER.name, email: VIEWER.email, date: new Date(info.authorTime * 1000).toISOString() },
          committer: { name: VIEWER.name, email: VIEWER.email, date: new Date(info.committerTime * 1000).toISOString() },
          tree: { sha: info.tree },
        },
        author: userJson(VIEWER), committer: userJson(VIEWER),
        parents: info.parents.map((p) => ({ sha: p })),
      }));
      return paginate(ctx, req, commits);
    }
    // git/refs
    if (sub === 'git' && tail[1] === 'refs' && req.method === 'POST' && tail.length === 2) {
      const b = isRecord(req.body) ? req.body : {};
      const ref = typeof b.ref === 'string' ? b.ref : '';
      const sha = typeof b.sha === 'string' ? b.sha : '';
      if (!ref.startsWith('refs/') || !sha || !forge.hasObject(sha)) return err(422, 'Invalid ref or sha');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return json(201, { ref, node_id: b64url(`RF:${ref}`), url: '', object: { sha, type: 'commit', url: '' } });
    }
    // contents
    if (sub === 'contents' && tail.length >= 2) {
      const filePath = tail.slice(1).map((s) => decodeURIComponent(s)).join('/');
      const refParam = req.query.get('ref') ?? undefined;
      if (req.method === 'GET') {
        const tip = resolveRef(forge, repo, refParam ?? '');
        if (!tip) return err(404, 'Not Found');
        const commitObj = forge.getObject(tip);
        if (!commitObj || commitObj.type !== 'commit') return err(404, 'Not Found');
        const treeOid = parseCommit(commitObj.data).tree;
        const flat = new Map<string, { mode: string; oid: string }>();
        forge.flattenTree(treeOid, '', flat);
        const exact = flat.get(filePath);
        if (exact) {
          const blob = forge.getObject(exact.oid);
          const content = blob ? blob.data.toString('base64') : '';
          return json(200, {
            type: 'file', encoding: 'base64', size: blob ? blob.data.length : 0,
            name: filePath.split('/').pop(), path: filePath, content, sha: exact.oid,
            url: '', html_url: '', git_url: '', download_url: '',
          });
        }
        // directory?
        const prefix = `${filePath}/`;
        const children = new Map<string, { type: string; oid: string }>();
        for (const [path, v] of flat) {
          if (!path.startsWith(prefix)) continue;
          const restPath = path.slice(prefix.length);
          const first = restPath.split('/')[0];
          if (restPath.includes('/')) children.set(first, { type: 'dir', oid: '' });
          else children.set(first, { type: 'file', oid: v.oid });
        }
        if (children.size === 0) return err(404, 'Not Found');
        const list = [...children.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, v]) => ({
          type: v.type, size: 0, name, path: `${filePath}/${name}`, sha: v.oid || '',
          url: '', html_url: '', git_url: '', download_url: '',
        }));
        return json(200, list);
      }
      if (req.method === 'PUT' || req.method === 'DELETE') {
        const b = isRecord(req.body) ? req.body : {};
        const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
        let tip = forge.branchTip(repo, branch);
        if (req.method === 'DELETE') {
          if (!tip) return err(404, 'Not Found');
          const commitObj = forge.getObject(tip)!;
          const flat = new Map<string, { mode: string; oid: string }>();
          forge.flattenTree(parseCommit(commitObj.data).tree, '', flat);
          if (!flat.has(filePath)) return err(404, 'Not Found');
          if (typeof b.sha === 'string' && b.sha !== flat.get(filePath)!.oid) return err(409, 'sha does not match');
          flat.delete(filePath);
          const message = typeof b.message === 'string' ? b.message : `Delete ${filePath}`;
          const sha = forge.commitOnBranch(repo, branch, flat, message);
          return json(200, { content: null, commit: { sha, message, url: '' } });
        }
        // PUT
        const contentB64 = typeof b.content === 'string' ? b.content : '';
        let content: Buffer;
        try { content = Buffer.from(contentB64, 'base64'); } catch { return err(422, 'content is not valid base64'); }
        const message = typeof b.message === 'string' ? b.message : `Update ${filePath}`;
        const flat = new Map<string, { mode: string; oid: string }>();
        if (tip) {
          const commitObj = forge.getObject(tip)!;
          forge.flattenTree(parseCommit(commitObj.data).tree, '', flat);
        }
        const existing = flat.get(filePath);
        if (existing) {
          if (typeof b.sha === 'string' && b.sha !== existing.oid) return err(409, 'sha does not match');
          if (typeof b.sha !== 'string') return err(422, 'sha is required to update a file');
        }
        const blobOid = forge.putObject('blob', content);
        flat.set(filePath, { mode: '100644', oid: blobOid });
        const sha = forge.commitOnBranch(repo, branch, flat, message);
        const status = existing ? 200 : 201;
        return json(status, {
          content: {
            type: 'file', encoding: 'base64', size: content.length,
            name: filePath.split('/').pop(), path: filePath, content: contentB64, sha: blobOid,
            url: '', html_url: '', git_url: '', download_url: '',
          },
          commit: { sha, message, url: '' },
        });
      }
      return err(404, 'Not Found');
    }
    // labels
    if (sub === 'labels') {
      if (tail.length === 1 && req.method === 'GET') {
        return json(200, [...repo.labels.values()].map(labelJson));
      }
      if (tail.length === 1 && req.method === 'POST') {
        const b = isRecord(req.body) ? req.body : {};
        const name = typeof b.name === 'string' ? b.name : '';
        const color = typeof b.color === 'string' ? b.color : 'ededed';
        if (!name) return err(422, 'name is required');
        const existing = repo.labels.get(name);
        if (existing) return json(201, labelJson(existing));
        const label = { name, color };
        repo.labels.set(name, label);
        dropRepoIssuePayloads(repo.owner, repo.name);
        return json(201, labelJson(label));
      }
      return err(404, 'Not Found');
    }
    // issues
    if (sub === 'issues') {
      if (tail.length === 1) {
        if (req.method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          const sort = req.query.get('sort') ?? 'created';
          const direction = req.query.get('direction') ?? 'desc';
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          list.sort((a, b) => {
            const cmp = sort === 'created'
              ? (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) || (a.number - b.number)
              : (a.number - b.number);
            return direction === 'asc' ? cmp : -cmp;
          });
          return paginate(ctx, req, list.map((i) => issueJson(ctx, repo, i)));
        }
        if (req.method === 'POST') {
          const b = isRecord(req.body) ? req.body : {};
          const title = typeof b.title === 'string' ? b.title : '';
          if (!title) return err(422, 'title is required');
          const labels: string[] = Array.isArray(b.labels) ? b.labels.filter((x): x is string => typeof x === 'string') : [];
          for (const l of labels) if (!repo.labels.has(l)) return err(422, `unknown label: ${l}`);
          const number = ++repo.counter;
          const now = nowIso();
          const issue: Issue = {
            owner: repo.owner, repoName: repo.name,
            number, title, body: typeof b.body === 'string' ? b.body : '', state: 'open',
            labels, createdAt: now, updatedAt: now, closedAt: null, comments: [], createdSeq: forge.nextSeq(),
          };
          repo.issues.set(number, issue);
          return json(201, issueJson(ctx, repo, issue));
        }
        return err(404, 'Not Found');
      }
      const num = Number(tail[1]);
      if (!Number.isInteger(num)) return err(404, 'Not Found');
      const issue = repo.issues.get(num);
      if (!issue) return err(404, 'Not Found');
      if (tail.length === 2) {
        if (req.method === 'GET') return cachedIssueJson(ctx, repo, issue);
        if (req.method === 'PATCH') {
          const b = isRecord(req.body) ? req.body : {};
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          if (b.state === 'open' || b.state === 'closed') {
            issue.state = b.state;
            issue.closedAt = b.state === 'closed' ? nowIso() : null;
          }
          issue.updatedAt = nowIso();
          dropIssuePayload(repo.owner, repo.name, issue.number);
          return json(200, issueJson(ctx, repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (tail[2] === 'comments') {
        if (req.method === 'GET') {
          const list = issue.comments.map((c) => ({
            id: c.id, node_id: b64url(`CM:${repo.owner}/${repo.name}#${issue.number}/${c.id}`),
            url: '', html_url: '', body: c.body, user: userJson(c.user),
            created_at: c.createdAt, updated_at: c.createdAt, author_association: 'OWNER',
          }));
          return paginate(ctx, req, list);
        }
        if (req.method === 'POST') {
          const b = isRecord(req.body) ? req.body : {};
          const body = typeof b.body === 'string' ? b.body : '';
          if (!body) return err(422, 'body is required');
          const id = ++repo.commentCounter;
          const comment = { id, body, user: VIEWER, createdAt: nowIso() };
          issue.comments.push(comment);
          issue.updatedAt = nowIso();
          dropIssuePayload(repo.owner, repo.name, issue.number);
          return json(201, {
            id, node_id: b64url(`CM:${repo.owner}/${repo.name}#${issue.number}/${id}`),
            url: '', html_url: '', body, user: userJson(VIEWER),
            created_at: comment.createdAt, updated_at: comment.createdAt, author_association: 'OWNER',
          });
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }
    // pulls
    if (sub === 'pulls') {
      if (tail.length === 1) {
        if (req.method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.number - a.number);
          return paginate(ctx, req, list.map((p) => prJson(ctx, repo, p)));
        }
        if (req.method === 'POST') {
          const b = isRecord(req.body) ? req.body : {};
          const title = typeof b.title === 'string' ? b.title : '';
          const head = typeof b.head === 'string' ? b.head : '';
          const base = typeof b.base === 'string' ? b.base : repo.defaultBranch;
          if (!title || !head) return err(422, 'title and head are required');
          const headSha = forge.branchTip(repo, head);
          const baseSha = forge.branchTip(repo, base);
          if (!headSha) return err(422, `unknown head branch: ${head}`);
          if (!baseSha) return err(422, `unknown base branch: ${base}`);
          const number = ++repo.counter;
          const now = nowIso();
          const pr: PullRequest = {
            owner: repo.owner, repoName: repo.name,
            number, title, body: typeof b.body === 'string' ? b.body : '', state: 'open',
            merged: false, mergedAt: null, mergeCommitSha: null,
            headRef: head, baseRef: base, headSha, baseSha, baseShaAtCreate: baseSha,
            createdAt: now, updatedAt: now, createdSeq: forge.nextSeq(),
          };
          repo.pulls.set(number, pr);
          return json(201, prJson(ctx, repo, pr));
        }
        return err(404, 'Not Found');
      }
      const num = Number(tail[1]);
      if (!Number.isInteger(num)) return err(404, 'Not Found');
      const pr = repo.pulls.get(num);
      if (!pr) return err(404, 'Not Found');
      if (tail.length === 2) {
        if (req.method === 'GET') {
          // refresh head/base shas from current branch tips for mergeable computation
          pr.headSha = forge.branchTip(repo, pr.headRef) ?? pr.headSha;
          pr.baseSha = forge.branchTip(repo, pr.baseRef) ?? pr.baseSha;
          return json(200, prJson(ctx, repo, pr));
        }
        return err(404, 'Not Found');
      }
      if (tail[2] === 'files' && req.method === 'GET') {
        const baseCommit = forge.getObject(pr.baseShaAtCreate);
        const headCommit = forge.getObject(pr.headSha);
        if (!baseCommit || !headCommit) return err(404, 'Not Found');
        const files = forge.diffTrees(parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree)
          .map((f) => ({ ...f, sha: '', blob_url: '', raw_url: '', patch: '' }));
        return json(200, files);
      }
      if (tail[2] === 'merge' && req.method === 'PUT') {
        if (pr.merged) return err(405, 'Pull request has already been merged');
        const method = isRecord(req.body) ? req.body.merge_method : undefined;
        if (method !== undefined && method !== 'squash' && method !== 'merge' && method !== 'rebase') {
          return err(405, `unsupported merge method: ${String(method)}`);
        }
        const headTip = forge.branchTip(repo, pr.headRef);
        const baseTip = forge.branchTip(repo, pr.baseRef);
        if (!headTip || !baseTip) return err(404, 'Not Found');
        if (forge.mergeConflict(pr.baseShaAtCreate, headTip, baseTip)) {
          return err(405, 'Merge conflict');
        }
        // squash: one commit on base with head's tree
        const headCommit = forge.getObject(headTip)!;
        const headTree = parseCommit(headCommit.data).tree;
        const flat = new Map<string, { mode: string; oid: string }>();
        forge.flattenTree(headTree, '', flat);
        const message = `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}`;
        const mergeSha = forge.commitOnBranch(repo, pr.baseRef, flat, message);
        pr.merged = true;
        pr.mergedAt = nowIso();
        pr.mergeCommitSha = mergeSha;
        pr.state = 'closed';
        pr.updatedAt = nowIso();
        pr.baseSha = mergeSha;
        return json(200, { merged: true, sha: mergeSha, message: 'Pull request successfully merged' });
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}
