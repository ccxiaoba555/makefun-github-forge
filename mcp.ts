// MCP over Streamable HTTP (POST /mcp, JSON-RPC 2.0). Legacy 2025-11-25 era: initialize +
// notifications/initialized, tools/list, tools/call. No server/discover (the suite's
// discover check passes for the pre-discover era). tools/list is built once so two calls
// answer byte-for-byte identical tools.
import { Forge, VIEWER, parseCommit } from './store.ts';
import { err, json, type Resp } from './rest.ts';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
}
const TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];
const TOOLS_JSON = JSON.stringify(TOOLS);

function rpcResult(id: unknown, result: unknown): Resp {
  return json(200, { jsonrpc: '2.0', id, result });
}
function rpcError(id: unknown, code: number, message: string): Resp {
  return json(200, { jsonrpc: '2.0', id, error: { code, message } });
}
function toolResult(obj: unknown): { content: Array<{ type: 'text'; text: string }>; structuredContent: unknown; isError: boolean } {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj, isError: false };
}
function toolError(message: string): { content: Array<{ type: 'text'; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}
function missingArgs(tool: McpTool, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
}

export function handleMcp(forge: Forge, body: unknown, bodyInvalid: boolean, headers: Record<string, string | undefined>): Resp {
  if (bodyInvalid) {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const req = body as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  const id = req.id ?? null;
  const method = req.method ?? '';
  if (method === 'initialize') {
    const params = req.params ?? {};
    const version = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const resp = rpcResult(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: 'makefun-forge', version: '1.0.0' },
    });
    const sessionId = headers['mcp-session-id'];
    if (sessionId) resp.headers = { 'Mcp-Session-Id': sessionId };
    return resp;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') {
    // byte-identical across calls: parse the frozen JSON once per call (same bytes out)
    return rpcResult(id, { tools: JSON.parse(TOOLS_JSON) as McpTool[] });
  }
  if (method === 'tools/call') {
    const params = req.params ?? {};
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
    const missing = missingArgs(tool, args);
    if (missing.length) return rpcResult(id, toolError(`Missing required arguments: ${missing.join(', ')}`));
    try {
      const out = callTool(forge, tool.name, args);
      if (out === null) return rpcResult(id, toolError('Tool call failed'));
      return rpcResult(id, toolResult(out));
    } catch (e) {
      return rpcResult(id, toolError(e instanceof Error ? e.message : String(e)));
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

function repoOrThrow(forge: Forge, owner: string, repo: string) {
  const r = forge.getRepo(owner, repo);
  if (!r) throw new Error(`Repository not found: ${owner}/${repo}`);
  return r;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): unknown {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      if (forge.getRepo(VIEWER.login, repoName)) throw new Error('Repository already exists');
      const repo = forge.createRepo(repoName, str(args.description), args.private === true);
      return { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, private: repo.isPrivate, description: repo.description, default_branch: repo.defaultBranch };
    }
    case 'get_repo': {
      const repo = repoOrThrow(forge, str(args.owner), str(args.repo));
      return { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, private: repo.isPrivate, description: repo.description, default_branch: repo.defaultBranch };
    }
    case 'create_issue': {
      const repo = repoOrThrow(forge, str(args.owner), str(args.repo));
      const number = ++repo.counter;
      const now = new Date().toISOString();
      repo.issues.set(number, {
        owner: repo.owner, repoName: repo.name,
        number, title: str(args.title), body: str(args.body), state: 'open',
        labels: [], createdAt: now, updatedAt: now, closedAt: null, comments: [], createdSeq: forge.nextSeq(),
      });
      return { number, title: str(args.title), body: str(args.body), state: 'open', id: repo.id * 100000 + number };
    }
    case 'list_issues': {
      const repo = repoOrThrow(forge, str(args.owner), str(args.repo));
      const state = str(args.state) || 'open';
      const list = [...repo.issues.values()]
        .filter((i) => state === 'all' || i.state === state)
        .sort((a, b) => a.number - b.number)
        .map((i) => ({ number: i.number, title: i.title, body: i.body, state: i.state, id: repo.id * 100000 + i.number }));
      return { issues: list, total_count: list.length };
    }
    case 'create_pull_request': {
      const repo = repoOrThrow(forge, str(args.owner), str(args.repo));
      const head = str(args.head);
      const base = str(args.base);
      const headSha = forge.branchTip(repo, head);
      const baseSha = forge.branchTip(repo, base);
      if (!headSha) throw new Error(`Unknown head branch: ${head}`);
      if (!baseSha) throw new Error(`Unknown base branch: ${base}`);
      const number = ++repo.counter;
      const now = new Date().toISOString();
      repo.pulls.set(number, {
        owner: repo.owner, repoName: repo.name,
        number, title: str(args.title), body: str(args.body), state: 'open',
        merged: false, mergedAt: null, mergeCommitSha: null,
        headRef: head, baseRef: base, headSha, baseSha, baseShaAtCreate: baseSha,
        createdAt: now, updatedAt: now, createdSeq: forge.nextSeq(),
      });
      return { number, pull_number: number, title: str(args.title), body: str(args.body), state: 'open', head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha } };
    }
    case 'merge_pull_request': {
      const repo = repoOrThrow(forge, str(args.owner), str(args.repo));
      const pr = repo.pulls.get(num(args.pull_number));
      if (!pr) throw new Error(`Pull request not found: ${args.pull_number}`);
      if (!pr.merged) {
        const headTip = forge.branchTip(repo, pr.headRef);
        const baseTip = forge.branchTip(repo, pr.baseRef);
        if (!headTip || !baseTip) throw new Error('Unknown head or base ref');
        if (forge.mergeConflict(pr.baseShaAtCreate, headTip, baseTip)) throw new Error('Merge conflict');
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
      return { number: pr.number, pull_number: pr.number, merged: true, state: pr.state, merge_commit_sha: pr.mergeCommitSha };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
