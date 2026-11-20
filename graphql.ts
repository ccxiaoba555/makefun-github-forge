// GraphQL v4 subset (/api/graphql): a small tokenizer + recursive-descent parser for the
// query documents the suite sends (operations, variables, aliases, fragments, input objects,
// inline enums, batched arrays), and an executor over the forge store.
// Rules from the checks: unauthenticated -> 401 exactly; unknown field -> HTTP 200 with an
// `errors` array naming it; unknown repository -> data.repository = null with no errors.
// Global ids are opaque but stable (base64url of a typed key).
import { Forge, VIEWER, b64url, unb64url, parseCommit, type Issue, type PullRequest, type Repo } from './store.ts';
import { err, json, type Resp } from './rest.ts';

// ---------------------------------------------------------------- tokenizer
type Tok =
  | { k: 'name'; v: string }
  | { k: 'int'; v: number }
  | { k: 'float'; v: number }
  | { k: 'string'; v: string }
  | { k: 'punct'; v: string }
  | { k: 'eof' };
function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const isNameStart = (c: string) => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '"') {
      if (src[i + 1] === '"' && src[i + 2] === '"') {
        const end = src.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        toks.push({ k: 'string', v: src.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') { const e = src[j + 1]; out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e; j += 2; }
        else { out += src[j]; j += 1; }
      }
      if (j >= src.length) throw new Error('unterminated string');
      toks.push({ k: 'string', v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c) && (c !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      let isFloat = false;
      if (src[j] === '.') { isFloat = true; j += 1; while (j < src.length && /[0-9]/.test(src[j])) j += 1; }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true; j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      const num = src.slice(i, j);
      toks.push(isFloat ? { k: 'float', v: Number(num) } : { k: 'int', v: Number(num) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j])) j += 1;
      toks.push({ k: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('!$&()...:=@[]{|}'.includes(c)) {
      if (c === '.' && src.slice(i, i + 3) === '...') { toks.push({ k: 'punct', v: '...' }); i += 3; continue; }
      toks.push({ k: 'punct', v: c });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in query`);
  }
  toks.push({ k: 'eof' });
  return toks;
}

// ---------------------------------------------------------------- AST
export interface FieldNode {
  alias?: string; name: string; args: Record<string, unknown>; selections?: FieldNode[];
  fragment?: string; inlineType?: string;
}
interface Operation { kind: 'query' | 'mutation'; name?: string; vars: Record<string, { type: string; def?: unknown }>; fields: FieldNode[]; }
interface Document { operations: Operation[]; fragments: Record<string, FieldNode[]>; }

function parseDocument(src: string): Document {
  const toks = tokenize(src);
  let pos = 0;
  const peek = (): Tok => toks[pos];
  const next = (): Tok => toks[pos++];
  const expectPunct = (v: string): void => {
    const t = next();
    if (t.k !== 'punct' || t.v !== v) throw new Error(`expected ${v}`);
  };
  const expectName = (): string => {
    const t = next();
    if (t.k !== 'name') throw new Error('expected name');
    return t.v;
  };
  const parseValue = (variables: Record<string, unknown>): unknown => {
    const t = next();
    if (t.k === 'punct' && t.v === '$') return { __var: expectName() };
    if (t.k === 'string') return t.v;
    if (t.k === 'int' || t.k === 'float') return t.v;
    if (t.k === 'name') {
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'null') return null;
      return { __enum: t.v };
    }
    if (t.k === 'punct' && t.v === '[') {
      const arr: unknown[] = [];
      while (!(peek().k === 'punct' && peek().v === ']')) arr.push(parseValue(variables));
      expectPunct(']');
      return arr;
    }
    if (t.k === 'punct' && t.v === '{') {
      const obj: Record<string, unknown> = {};
      while (!(peek().k === 'punct' && peek().v === '}')) {
        const key = expectName();
        expectPunct(':');
        obj[key] = parseValue(variables);
      }
      expectPunct('}');
      return obj;
    }
    throw new Error('unexpected value token');
  };
  const resolveVars = (v: unknown, vars: Record<string, unknown>): unknown => {
    if (v !== null && typeof v === 'object') {
      if ('__var' in (v as Record<string, unknown>)) {
        const name = (v as { __var: string }).__var;
        return vars[name];
      }
      if ('__enum' in (v as Record<string, unknown>)) return (v as { __enum: string }).__enum;
      if (Array.isArray(v)) return v.map((x) => resolveVars(x, vars));
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = resolveVars(val, vars);
      return out;
    }
    return v;
  };
  const parseArgs = (variables: Record<string, unknown>): Record<string, unknown> => {
    const args: Record<string, unknown> = {};
    expectPunct('(');
    while (!(peek().k === 'punct' && peek().v === ')')) {
      const key = expectName();
      expectPunct(':');
      // Keep variable references unresolved here: they are substituted at execution time
      // (parse time has no values — resolving now would turn every $var into undefined).
      args[key] = parseValue(variables);
    }
    expectPunct(')');
    return args;
  };
  const parseSelectionSet = (variables: Record<string, unknown>): FieldNode[] => {
    expectPunct('{');
    const fields: FieldNode[] = [];
    while (!(peek().k === 'punct' && peek().v === '}')) {
      fields.push(parseField(variables));
    }
    expectPunct('}');
    return fields;
  };
  const parseField = (variables: Record<string, unknown>): FieldNode => {
    const t = peek();
    if (t.k === 'punct' && t.v === '...') {
      next();
      const nt = peek();
      if (nt.k === 'name' && nt.v === 'on') {
        next();
        const typeName = expectName();
        return { name: '', fragment: undefined, inlineType: typeName, args: {}, selections: parseSelectionSet(variables) };
      }
      const fragName = expectName();
      return { name: '', fragment: fragName, args: {} };
    }
    const first = expectName();
    let alias: string | undefined;
    let name = first;
    if (peek().k === 'punct' && peek().v === ':') {
      next();
      alias = first;
      name = expectName();
    }
    let args: Record<string, unknown> = {};
    if (peek().k === 'punct' && peek().v === '(') args = parseArgs(variables);
    let selections: FieldNode[] | undefined;
    if (peek().k === 'punct' && peek().v === '{') selections = parseSelectionSet(variables);
    return { alias, name, args, selections };
  };
  const parseVarDefs = (): Record<string, { type: string; def?: unknown }> => {
    const vars: Record<string, { type: string; def?: unknown }> = {};
    if (!(peek().k === 'punct' && peek().v === '(')) return vars;
    next();
    while (!(peek().k === 'punct' && peek().v === ')')) {
      expectPunct('$');
      const name = expectName();
      expectPunct(':');
      // type: Name, [Name], Name!, [Name!]! etc.
      let type = '';
      const readType = (): void => {
        const t = next();
        if (t.k === 'punct' && t.v === '[') { type += '['; readType(); expectPunct(']'); type += ']'; }
        else if (t.k === 'name') type += t.v;
        if (peek().k === 'punct' && peek().v === '!') { next(); type += '!'; }
      };
      readType();
      let def: unknown;
      if (peek().k === 'punct' && peek().v === '=') { next(); def = parseValue({}); }
      vars[name] = { type, def };
    }
    expectPunct(')');
    return vars;
  };
  const doc: Document = { operations: [], fragments: {} };
  while (peek().k !== 'eof') {
    const t = peek();
    if (t.k === 'punct' && t.v === '{') {
      doc.operations.push({ kind: 'query', vars: {}, fields: parseSelectionSet({}) });
      continue;
    }
    if (t.k === 'name' && (t.v === 'query' || t.v === 'mutation')) {
      const kind = next().v as 'query' | 'mutation';
      let name: string | undefined;
      if (peek().k === 'name') name = expectName();
      const vars = parseVarDefs();
      const fields = parseSelectionSet({});
      doc.operations.push({ kind, name, vars, fields });
      continue;
    }
    if (t.k === 'name' && t.v === 'fragment') {
      next();
      const name = expectName();
      const onTok = next();
      if (onTok.k !== 'name' || onTok.v !== 'on') throw new Error('fragment must have "on"');
      expectName();
      doc.fragments[name] = parseSelectionSet({});
      continue;
    }
    throw new Error(`unexpected token ${JSON.stringify(t)}`);
  }
  return doc;
}

// ---------------------------------------------------------------- execution
const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body'];
const PR_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'];
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ISSUE_FIELDS,
  PullRequest: PR_FIELDS,
  Repository: REPO_FIELDS,
  User: ['login'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  __InputValue: ['name'],
};
const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

interface ExecCtx {
  forge: Forge;
  errors: Array<{ message: string }>;
  fragments: Record<string, FieldNode[]>;
}
function gid(kind: string, key: string): string { return b64url(`${kind}:${key}`); }
export function repoGid(r: Repo): string { return gid('R', `${r.owner}/${r.name}`); }
export function issueGid(r: Repo, i: Issue): string { return gid('I', `${r.owner}/${r.name}#${i.number}`); }
export function prGid(r: Repo, p: PullRequest): string { return gid('P', `${r.owner}/${r.name}#${p.number}`); }
function decodeGid(id: string): { kind: string; key: string } | null {
  const s = unb64url(id);
  if (!s) return null;
  const idx = s.indexOf(':');
  if (idx < 0) return null;
  return { kind: s.slice(0, idx), key: s.slice(idx + 1) };
}
function findRepoByGid(forge: Forge, id: string): Repo | undefined {
  const d = decodeGid(id);
  if (!d || d.kind !== 'R') return undefined;
  const [owner, name] = d.key.split('/');
  return forge.getRepo(owner, name);
}
function findIssueByGid(forge: Forge, id: string): { repo: Repo; issue: Issue } | undefined {
  const d = decodeGid(id);
  if (!d || d.kind !== 'I') return undefined;
  const [ownerRepo, num] = d.key.split('#');
  const [owner, name] = ownerRepo.split('/');
  const repo = forge.getRepo(owner, name);
  if (!repo) return undefined;
  const issue = repo.issues.get(Number(num));
  return issue ? { repo, issue } : undefined;
}
function findPrByGid(forge: Forge, id: string): { repo: Repo; pr: PullRequest } | undefined {
  const d = decodeGid(id);
  if (!d || d.kind !== 'P') return undefined;
  const [ownerRepo, num] = d.key.split('#');
  const [owner, name] = ownerRepo.split('/');
  const repo = forge.getRepo(owner, name);
  if (!repo) return undefined;
  const pr = repo.pulls.get(Number(num));
  return pr ? { repo, pr } : undefined;
}

function issueStateGql(state: 'open' | 'closed'): string { return state === 'open' ? 'OPEN' : 'CLOSED'; }
function prStateGql(p: PullRequest): string { return p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED'; }

function mergeableGql(forge: Forge, repo: Repo, p: PullRequest): string {
  if (p.merged) return 'MERGEABLE';
  const headTip = forge.branchTip(repo, p.headRef);
  const baseTip = forge.branchTip(repo, p.baseRef);
  if (!headTip || !baseTip) return 'UNKNOWN';
  return forge.mergeConflict(p.baseShaAtCreate, headTip, baseTip) ? 'CONFLICTING' : 'MERGEABLE';
}

function resolveFields(ctx: ExecCtx, typeName: string, value: unknown, fields: FieldNode[]): Record<string, unknown> | null {
  if ((value === null || value === undefined) && typeName !== 'Query') return null;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.fragment) {
      const frag = ctx.fragments[f.fragment];
      if (frag) {
        const sub = resolveFields(ctx, typeName, value, frag);
        if (sub) Object.assign(out, sub);
      }
      continue;
    }
    if (f.inlineType) {
      if (f.inlineType === typeName && f.selections) {
        const sub = resolveFields(ctx, typeName, value, f.selections);
        if (sub) Object.assign(out, sub);
      }
      continue;
    }
    const key = f.alias ?? f.name;
    const allowed = TYPE_FIELDS[typeName];
    if (allowed && !allowed.includes(f.name) && f.name !== '__typename') {
      ctx.errors.push({ message: `Cannot query field "${f.name}" on type "${typeName}".` });
      continue;
    }
    const resolved = resolveField(ctx, typeName, value, f);
    if (resolved === undefined) continue;
    out[key] = resolved;
  }
  return out;
}

function resolveField(ctx: ExecCtx, typeName: string, value: unknown, f: FieldNode): unknown {
  if (f.name === '__typename') return typeName;
  const { forge } = ctx;
  if (typeName === 'Query') {
    if (f.name === 'viewer') {
      return f.selections ? resolveFields(ctx, 'User', VIEWER, f.selections) : null;
    }
    if (f.name === 'repository') {
      const owner = String(f.args.owner ?? '');
      const name = String(f.args.name ?? '');
      const repo = forge.getRepo(owner, name);
      if (!repo) return null;
      return f.selections ? resolveFields(ctx, 'Repository', repo, f.selections) : null;
    }
    if (f.name === 'node') {
      const id = String(f.args.id ?? '');
      const repo = findRepoByGid(forge, id);
      if (repo) return f.selections ? resolveFields(ctx, 'Repository', repo, f.selections) : null;
      const issue = findIssueByGid(forge, id);
      if (issue) return f.selections ? resolveFields(ctx, 'Issue', issue.issue, f.selections) : null;
      const pr = findPrByGid(forge, id);
      if (pr) return f.selections ? resolveFields(ctx, 'PullRequest', pr.pr, f.selections) : null;
      return null;
    }
    if (f.name === '__type') {
      const name = String(f.args.name ?? '');
      return f.selections ? resolveFields(ctx, '__Type', { __typeName: name }, f.selections) : null;
    }
    ctx.errors.push({ message: `Cannot query field "${f.name}" on type "Query".` });
    return undefined;
  }
  if (typeName === 'User') {
    const u = value as typeof VIEWER;
    if (f.name === 'login') return u.login;
    return undefined;
  }
  if (typeName === '__Type') {
    const name = (value as { __typeName: string }).__typeName;
    if (f.name === 'name') return name;
    if (f.name === 'kind') return name in ENUM_VALUES ? 'ENUM' : 'OBJECT';
    if (f.name === 'fields') {
      const fields = TYPE_FIELDS[name] ?? [];
      return fields.map((fn) => (f.selections ? resolveFields(ctx, '__Field', { __fieldName: fn }, f.selections) : { name: fn }));
    }
    if (f.name === 'enumValues') {
      const vals = ENUM_VALUES[name] ?? [];
      return vals.map((v) => (f.selections ? resolveFields(ctx, '__EnumValue', { __enumName: v }, f.selections) : { name: v }));
    }
    return undefined;
  }
  if (typeName === '__Field') {
    const n = (value as { __fieldName: string }).__fieldName;
    if (f.name === 'name') return n;
    if (f.name === 'description') return null;
    if (f.name === 'type') return f.selections ? resolveFields(ctx, '__Type', { __typeName: 'String' }, f.selections) : { name: 'String', kind: 'SCALAR' };
    return undefined;
  }
  if (typeName === '__EnumValue') {
    const n = (value as { __enumName: string }).__enumName;
    if (f.name === 'name') return n;
    if (f.name === 'description') return null;
    return undefined;
  }
  if (typeName === 'Repository') {
    const repo = value as Repo;
    switch (f.name) {
      case 'id': return repoGid(repo);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'owner': return f.selections ? resolveFields(ctx, 'User', VIEWER, f.selections) : null;
      case 'defaultBranchRef': {
        const tip = forge.branchTip(repo, repo.defaultBranch);
        if (!tip) return null;
        return f.selections ? resolveFields(ctx, 'Ref', { __refName: repo.defaultBranch, __refOid: tip }, f.selections) : null;
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'issue': {
        const num = Number(f.args.number);
        const issue = repo.issues.get(num);
        if (!issue) return null;
        return f.selections ? resolveFields(ctx, 'Issue', issue, f.selections) : null;
      }
      case 'issues': {
        let list = [...repo.issues.values()];
        const states = f.args.states as string[] | undefined;
        if (states?.length) list = list.filter((i) => states.includes(issueStateGql(i.state)));
        const orderBy = f.args.orderBy as { field?: string; direction?: string } | undefined;
        const field = orderBy?.field ?? 'CREATED_AT';
        const dir = orderBy?.direction ?? 'ASC';
        list.sort((a, b) => {
          let cmp = 0;
          if (field === 'UPDATED_AT') cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
          else if (field === 'COMMENTS') cmp = a.comments.length - b.comments.length;
          else cmp = a.number - b.number; // CREATED_AT ~ creation order
          if (cmp === 0) cmp = a.number - b.number;
          return dir === 'DESC' ? -cmp : cmp;
        });
        return issueConnection(ctx, repo, list, f);
      }
      case 'pullRequests': {
        const list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
        return prConnection(ctx, repo, list, f);
      }
      case 'pullRequest': {
        const num = Number(f.args.number);
        const pr = repo.pulls.get(num);
        if (!pr) return null;
        return f.selections ? resolveFields(ctx, 'PullRequest', pr, f.selections) : null;
      }
      default: return undefined;
    }
  }
  if (typeName === 'Ref') {
    const r = value as { __refName: string; __refOid: string };
    if (f.name === 'name') return r.__refName;
    if (f.name === 'target') return null;
    return undefined;
  }
  if (typeName === 'Issue') {
    const issue = value as Issue;
    switch (f.name) {
      case 'id': return issueGid({ owner: issue.owner, name: issue.repoName } as Repo, issue);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issueStateGql(issue.state);
      case 'body': return issue.body;
      default: return undefined;
    }
  }
  if (typeName === 'PullRequest') {
    const pr = value as PullRequest;
    // need repo for mergeable: find via global lookup by number is ambiguous; store repo on the
    // object through a WeakMap set at creation is overkill — recompute from forge by scanning.
    switch (f.name) {
      case 'id': return prGid({ owner: pr.owner, name: pr.repoName } as Repo, pr);
      case 'number': return pr.number;
      case 'state': return prStateGql(pr);
      case 'merged': return pr.merged;
      case 'headRefName': return pr.headRef;
      case 'baseRefName': return pr.baseRef;
      case 'mergeable': {
        const repo = findRepoContainingPr(forge, pr);
        return repo ? mergeableGql(forge, repo, pr) : 'UNKNOWN';
      }
      case 'files': {
        const repo = findRepoContainingPr(forge, pr);
        if (!repo) return f.selections ? resolveFields(ctx, 'PullRequestChangedFileConnection', { __nodes: [], __pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } }, f.selections) : null;
        const baseCommit = forge.getObject(pr.baseShaAtCreate);
        const headCommit = forge.getObject(pr.headSha);
        const files = baseCommit && headCommit
          ? forge.diffTrees(parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree)
          : [];
        const first = typeof f.args.first === 'number' ? f.args.first : files.length;
        const sliced = files.slice(0, first);
        const conn = {
          __nodes: sliced.map((file) => ({ __kind: 'PullRequestChangedFile', __value: file })),
          __pageInfo: { hasNextPage: files.length > sliced.length, hasPreviousPage: false, startCursor: null, endCursor: null },
        };
        return f.selections
          ? resolveFields(ctx, 'PullRequestChangedFileConnection', conn, f.selections)
          : null;
      }
      default: return undefined;
    }
  }
  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
    const conn = value as { __nodes: unknown[]; __pageInfo: Record<string, unknown> };
    if (f.name === 'nodes') {
      const nodes = conn.__nodes as Array<{ __kind: string; __value: unknown }>;
      return nodes.map((n) => (f.selections ? resolveFields(ctx, n.__kind, n.__value, f.selections) : null));
    }
    if (f.name === 'pageInfo') return f.selections ? resolveFields(ctx, 'PageInfo', conn.__pageInfo, f.selections) : null;
    if (f.name === 'totalCount') return conn.__nodes.length;
    return undefined;
  }
  if (typeName === 'PullRequestChangedFile') {
    const file = value as { filename: string };
    if (f.name === 'path') return file.filename;
    return undefined;
  }
  if (typeName === 'PageInfo') {
    const pi = value as Record<string, unknown>;
    if (f.name === 'hasNextPage') return pi.hasNextPage ?? false;
    if (f.name === 'hasPreviousPage') return pi.hasPreviousPage ?? false;
    if (f.name === 'startCursor') return pi.startCursor ?? null;
    if (f.name === 'endCursor') return pi.endCursor ?? null;
    return undefined;
  }
  return undefined;
}
function findRepoContainingPr(forge: Forge, pr: PullRequest): Repo | undefined {
  for (const repo of forge.repos.values()) if (repo.pulls.get(pr.number) === pr) return repo;
  return undefined;
}
function cursorFor(index: number): string { return b64url(`cursor:${index}`); }
function indexFromCursor(cursor: string | undefined): number {
  if (!cursor) return -1;
  const s = unb64url(cursor);
  if (!s) return -1;
  const m = /^cursor:(\d+)$/.exec(s);
  return m ? Number(m[1]) : -1;
}
function issueConnection(ctx: ExecCtx, repo: Repo, list: Issue[], f: FieldNode) {
  const after = indexFromCursor(typeof f.args.after === 'string' ? f.args.after : undefined);
  const first = typeof f.args.first === 'number' ? f.args.first : list.length;
  const sliced = list.slice(after + 1, after + 1 + first);
  const nodes = sliced.map((i) => ({ __kind: 'Issue', __value: i }));
  const endIndex = after + sliced.length; // index of the last returned item
  const pageInfo = {
    hasNextPage: endIndex + 1 < list.length,
    hasPreviousPage: after >= 0,
    startCursor: sliced.length ? cursorFor(after + 1) : null,
    endCursor: sliced.length ? cursorFor(endIndex) : null,
  };
  const conn = { __nodes: nodes, __pageInfo: pageInfo };
  return f.selections ? resolveFields(ctx, 'IssueConnection', conn, f.selections) : null;
}
function prConnection(ctx: ExecCtx, repo: Repo, list: PullRequest[], f: FieldNode) {
  const after = indexFromCursor(typeof f.args.after === 'string' ? f.args.after : undefined);
  const first = typeof f.args.first === 'number' ? f.args.first : list.length;
  const sliced = list.slice(after + 1, after + 1 + first);
  const nodes = sliced.map((p) => ({ __kind: 'PullRequest', __value: p }));
  const endIndex = after + sliced.length; // index of the last returned item
  const pageInfo = {
    hasNextPage: endIndex + 1 < list.length,
    hasPreviousPage: after >= 0,
    startCursor: sliced.length ? cursorFor(after + 1) : null,
    endCursor: sliced.length ? cursorFor(endIndex) : null,
  };
  const conn = { __nodes: nodes, __pageInfo: pageInfo };
  return f.selections ? resolveFields(ctx, 'PullRequestConnection', conn, f.selections) : null;
}

// ---- mutations
function runMutation(ctx: ExecCtx, f: FieldNode): unknown {
  const { forge } = ctx;
  const key = f.alias ?? f.name;
  void key;
  if (f.name === 'createIssue') {
    const input = (f.args.input ?? f.args) as Record<string, unknown>;
    const repo = findRepoByGid(forge, String(input.repositoryId ?? ''));
    if (!repo) { ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' }); return null; }
    const title = String(input.title ?? '');
    const body = typeof input.body === 'string' ? input.body : '';
    const number = ++repo.counter;
    const now = new Date().toISOString();
    const issue: Issue = { owner: repo.owner, repoName: repo.name, number, title, body, state: 'open', labels: [], createdAt: now, updatedAt: now, closedAt: null, comments: [], createdSeq: forge.nextSeq() };
    repo.issues.set(number, issue);
    const payload = { issue: f.selections?.find((s) => s.name === 'issue')?.selections
      ? resolveFields(ctx, 'Issue', issue, f.selections.find((s) => s.name === 'issue')!.selections!)
      : { number, id: issueGid(repo, issue) } };
    return payload;
  }
  if (f.name === 'closeIssue') {
    const input = (f.args.input ?? f.args) as Record<string, unknown>;
    const found = findIssueByGid(forge, String(input.issueId ?? ''));
    if (!found) { ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' }); return null; }
    found.issue.state = 'closed';
    found.issue.closedAt = new Date().toISOString();
    found.issue.updatedAt = new Date().toISOString();
    const sel = f.selections?.find((s) => s.name === 'issue')?.selections;
    return { issue: sel ? resolveFields(ctx, 'Issue', found.issue, sel) : { number: found.issue.number, id: issueGid(found.repo, found.issue) } };
  }
  if (f.name === 'createPullRequest') {
    const input = (f.args.input ?? f.args) as Record<string, unknown>;
    const repo = findRepoByGid(forge, String(input.repositoryId ?? ''));
    if (!repo) { ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' }); return null; }
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    const headSha = forge.branchTip(repo, head);
    const baseSha = forge.branchTip(repo, base);
    if (!headSha || !baseSha) { ctx.errors.push({ message: `Unknown head or base ref: ${head} / ${base}` }); return null; }
    const number = ++repo.counter;
    const now = new Date().toISOString();
    const pr: PullRequest = {
      owner: repo.owner, repoName: repo.name,
      number, title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '', state: 'open',
      merged: false, mergedAt: null, mergeCommitSha: null,
      headRef: head, baseRef: base, headSha, baseSha, baseShaAtCreate: baseSha,
      createdAt: now, updatedAt: now, createdSeq: forge.nextSeq(),
    };
    repo.pulls.set(number, pr);
    const sel = f.selections?.find((s) => s.name === 'pullRequest')?.selections;
    return { pullRequest: sel ? resolveFields(ctx, 'PullRequest', pr, sel) : { number, id: prGid(repo, pr) } };
  }
  if (f.name === 'mergePullRequest') {
    const input = (f.args.input ?? f.args) as Record<string, unknown>;
    const found = findPrByGid(forge, String(input.pullRequestId ?? ''));
    if (!found) { ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' }); return null; }
    const { repo, pr } = found;
    if (!pr.merged) {
      const headTip = forge.branchTip(repo, pr.headRef);
      const baseTip = forge.branchTip(repo, pr.baseRef);
      if (!headTip || !baseTip) { ctx.errors.push({ message: 'Unknown head or base ref.' }); return null; }
      if (forge.mergeConflict(pr.baseShaAtCreate, headTip, baseTip)) {
        ctx.errors.push({ message: 'Merge conflict' });
        return null;
      }
      const headCommit = forge.getObject(headTip)!;
      const headTree = parseCommit(headCommit.data).tree;
      const flat = new Map<string, { mode: string; oid: string }>();
      forge.flattenTree(headTree, '', flat);
      const mergeSha = forge.commitOnBranch(repo, pr.baseRef, flat, `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}`);
      pr.merged = true;
      pr.mergedAt = new Date().toISOString();
      pr.mergeCommitSha = mergeSha;
      pr.state = 'closed';
      pr.updatedAt = new Date().toISOString();
      pr.baseSha = mergeSha;
    }
    const sel = f.selections?.find((s) => s.name === 'pullRequest')?.selections;
    return { pullRequest: sel ? resolveFields(ctx, 'PullRequest', pr, sel) : { number: pr.number, id: prGid(repo, pr) } };
  }
  if (f.name === 'addComment') {
    const input = (f.args.input ?? f.args) as Record<string, unknown>;
    const found = findIssueByGid(forge, String(input.subjectId ?? ''));
    if (!found) { ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' }); return null; }
    const body = String(input.body ?? '');
    const id = ++found.repo.commentCounter;
    const comment = { id, body, user: VIEWER, createdAt: new Date().toISOString() };
    found.issue.comments.push(comment);
    const sel = f.selections?.find((s) => s.name === 'commentEdge')?.selections;
    const nodeSel = sel?.find((s) => s.name === 'node')?.selections;
    const node = nodeSel
      ? { id: b64url(`CM:${found.repo.owner}/${found.repo.name}#${found.issue.number}/${id}`), body }
      : { id: b64url(`CM:${found.repo.owner}/${found.repo.name}#${found.issue.number}/${id}`), body };
    void nodeSel;
    return { commentEdge: { node } };
  }
  ctx.errors.push({ message: `Cannot query field "${f.name}" on type "Mutation".` });
  return null;
}

// Substitute $variables (and enum literals) in a parsed operation's arguments, in place,
// at execution time when the values are known.
function resolveValueVars(v: unknown, vars: Record<string, unknown>): unknown {
  if (v !== null && typeof v === 'object') {
    if ('__var' in (v as Record<string, unknown>)) return vars[(v as { __var: string }).__var];
    if ('__enum' in (v as Record<string, unknown>)) return (v as { __enum: string }).__enum;
    if (Array.isArray(v)) return v.map((x) => resolveValueVars(x, vars));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = resolveValueVars(val, vars);
    return out;
  }
  return v;
}
function resolveFieldVars(fields: FieldNode[], vars: Record<string, unknown>): void {
  for (const f of fields) {
    for (const k of Object.keys(f.args)) f.args[k] = resolveValueVars(f.args[k], vars);
    if (f.selections) resolveFieldVars(f.selections, vars);
  }
}

function executeOperation(forge: Forge, doc: Document, op: Operation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const ctx: ExecCtx = { forge, errors: [], fragments: doc.fragments };
  // Effective variables: runtime values, falling back to the operation's defaults.
  const effVars: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(op.vars)) if (def.def !== undefined) effVars[name] = def.def;
  Object.assign(effVars, variables);
  resolveFieldVars(op.fields, effVars);
  for (const frag of Object.values(doc.fragments)) resolveFieldVars(frag, effVars);
  const data: Record<string, unknown> = {};
  if (op.kind === 'mutation') {
    for (const f of op.fields) {
      if (f.fragment) continue;
      const key = f.alias ?? f.name;
      data[key] = runMutation(ctx, f);
    }
  } else {
    for (const f of op.fields) {
      if (f.fragment) {
        const frag = doc.fragments[f.fragment];
        if (frag) {
          const sub = resolveFields(ctx, 'Query', null, frag);
          if (sub) Object.assign(data, sub);
        }
        continue;
      }
      const key = f.alias ?? f.name;
      if (f.name === '__typename') { data[key] = 'Query'; continue; }
      if (f.name === '__schema') { data[key] = null; continue; }
      const out = resolveFields(ctx, 'Query', null, [f]);
      if (out && key in out) data[key] = out[key];
    }
  }
  return ctx.errors.length ? { data, errors: ctx.errors } : { data };
}

export function handleGraphql(forge: Forge, body: unknown): Resp {
  let ops: Array<{ query: string; variables?: Record<string, unknown>; operationName?: string }> = [];
  if (Array.isArray(body)) {
    for (const item of body) {
      if (item && typeof item === 'object' && typeof (item as { query?: unknown }).query === 'string') {
        ops.push(item as { query: string; variables?: Record<string, unknown>; operationName?: string });
      }
    }
  } else if (body && typeof body === 'object' && typeof (body as { query?: unknown }).query === 'string') {
    ops.push(body as { query: string; variables?: Record<string, unknown>; operationName?: string });
  } else {
    return err(400, 'Request must include a query string');
  }
  const results = ops.map((op) => {
    let doc: Document;
    try {
      doc = parseDocument(op.query);
    } catch (e) {
      return { errors: [{ message: e instanceof Error ? e.message : String(e) }] };
    }
    const variables = op.variables ?? {};
    const operation = op.operationName
      ? doc.operations.find((o) => o.name === op.operationName)
      : doc.operations[0];
    if (!operation) return { errors: [{ message: `Unknown operation named "${op.operationName}".` }] };
    return executeOperation(forge, doc, operation, variables);
  });
  return json(200, Array.isArray(body) ? results : results[0]);
}
