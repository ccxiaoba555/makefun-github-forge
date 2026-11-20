// HTTP server: routing, bearer auth (MAKEFUN_SHOP_TOKEN), JSON body parsing, git smart-HTTP.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Forge, VIEWER } from './store.ts';
import { handleRest, reqId, type Req } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  v0Advertisement, v2Advertisement, lsRefsResponse, parseV2Command, fetchResponse,
  parseV0Fetch, v0FetchResponse, parsePushBody, applyPush, pushReportResponse,
  readPack, verifyPackChecksum,
} from './gitproto.ts';

/** Shared empty values for the no-query / no-body fast paths: handlers only read them. */
const EMPTY_QUERY = new URLSearchParams();
const EMPTY_BODY = Buffer.alloc(0);

export function createApp(): ReturnType<typeof createServer> {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const baseUrlOf = (req: IncomingMessage): string => {
    const host = req.headers.host ?? '127.0.0.1';
    return `http://${host}`;
  };
  const authorized = (req: IncomingMessage): boolean => {
    if (!token) return true;
    const auth = req.headers.authorization ?? '';
    return auth === `Bearer ${token}`;
  };
  const sendJson = (res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'X-GitHub-Request-Id': reqId(),
      ...extra,
    };
    if (body === null || body === undefined) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
    headers['content-length'] = String(payload.length);
    res.writeHead(status, headers);
    res.end(payload);
  };
  const sendBuffer = (res: ServerResponse, status: number, body: Buffer, contentType: string): void => {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': String(body.length),
      'X-GitHub-Request-Id': reqId(),
    });
    res.end(body);
  };
  const readBody = (req: IncomingMessage): Promise<Buffer> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  return createServer(async (req, res) => {
    try {
      // Manual URL split: `new URL()` per request is measurable at 2,000 req/round.
      const rawUrl = req.url ?? '/';
      const qi = rawUrl.indexOf('?');
      const path = qi < 0 ? rawUrl : rawUrl.slice(0, qi);
      // No query string is the common case (bench read/write): reuse one empty
      // params object instead of building one per request. Handlers only read it.
      const query = qi < 0 ? EMPTY_QUERY : new URLSearchParams(rawUrl.slice(qi + 1));
      const method = req.method ?? 'GET';
      // GET/HEAD carry no body in this protocol: skip the readBody round-trip.
      const noBody = method === 'GET' || method === 'HEAD';

      // healthz: no auth, plain 200
      if (path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      // git smart HTTP: /<owner>/<repo>.git/...
      const gitMatch = path.includes('.git/') ? /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path) : null;
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1]);
        const repoName = decodeURIComponent(gitMatch[2]);
        const rest = gitMatch[3];
        if (!authorized(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
        const repo = forge.getRepo(owner, repoName);
        if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
        const body = noBody ? EMPTY_BODY : await readBody(req);
        if (rest === 'info/refs' && method === 'GET') {
          const service = query.get('service') ?? '';
          if (service === 'git-upload-pack') {
            if ((req.headers['git-protocol'] ?? '') === 'version=2') {
              sendBuffer(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
            } else {
              sendBuffer(res, 200, v0Advertisement('git-upload-pack', forge, repo), 'application/x-git-upload-pack-advertisement');
            }
            return;
          }
          if (service === 'git-receive-pack') {
            sendBuffer(res, 200, v0Advertisement('git-receive-pack', forge, repo), 'application/x-git-receive-pack-advertisement');
            return;
          }
          sendJson(res, 400, { message: 'Unknown service' });
          return;
        }
        if (rest === 'git-upload-pack' && method === 'POST') {
          if ((req.headers['git-protocol'] ?? '') === 'version=2') {
            const { command, args } = parseV2Command(body);
            if (command === 'ls-refs') {
              sendBuffer(res, 200, lsRefsResponse(forge, repo, args), 'application/x-git-upload-pack-result');
              return;
            }
            if (command === 'fetch') {
              const fetchReq = { wants: [] as string[], haves: [] as string[], shallow: [] as string[], deepenNot: [] as string[] };
              for (const a of args) {
                if (a.startsWith('want ')) fetchReq.wants.push(a.slice(5));
                else if (a.startsWith('have ')) fetchReq.haves.push(a.slice(5));
                else if (a.startsWith('shallow ')) fetchReq.shallow.push(a.slice(8));
                else if (a.startsWith('deepen ')) fetchReq.depth = Number(a.slice(7));
                else if (a.startsWith('deepen-since ')) fetchReq.deepenSince = Number(a.slice(13));
                else if (a.startsWith('deepen-not ')) fetchReq.deepenNot.push(a.slice(11));
                else if (a.startsWith('filter ')) fetchReq.filter = a.slice(7);
              }
              sendBuffer(res, 200, fetchResponse(forge, repo, fetchReq), 'application/x-git-upload-pack-result');
              return;
            }
            sendJson(res, 400, { message: `Unknown command: ${command}` });
            return;
          }
          // v0 fetch
          const fetchReq = parseV0Fetch(body);
          sendBuffer(res, 200, v0FetchResponse(forge, repo, fetchReq), 'application/x-git-upload-pack-result');
          return;
        }
        if (rest === 'git-receive-pack' && method === 'POST') {
          const { commands, pack } = parsePushBody(body);
          let unpackOk = true;
          let unpackDetail = 'ok';
          let packObjects = new Map<string, import('./store').GitObject>();
          if (pack.length > 0) {
            try {
              if (!verifyPackChecksum(pack)) throw new Error('pack checksum mismatch');
          packObjects = await readPack(pack, (oid) => forge.getObject(oid));
            } catch (e) {
              unpackOk = false;
              unpackDetail = e instanceof Error ? e.message : String(e);
            }
          }
          if (!unpackOk) {
            sendBuffer(res, 200, pushReportResponse([], false, unpackDetail), 'application/x-git-receive-pack-result');
            return;
          }
          const results = applyPush(forge, repo, commands, packObjects);
          sendBuffer(res, 200, pushReportResponse(results, true), 'application/x-git-receive-pack-result');
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      // API surfaces need auth
      if (path === '/api/graphql' || path === '/mcp' || path.startsWith('/api/v3')) {
        if (!authorized(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
        const body = noBody ? EMPTY_BODY : await readBody(req);
        let parsed: unknown;
        let bodyInvalid = false;
        if (body.length) {
          try { parsed = JSON.parse(body.toString('utf8')); } catch { bodyInvalid = true; }
        }
        if (path === '/api/graphql') {
          if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
          if (bodyInvalid) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
          const out = handleGraphql(forge, parsed);
          sendJson(res, out.status, out.body, out.headers);
          return;
        }
        if (path === '/mcp') {
          if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
          const headers: Record<string, string | undefined> = {};
          for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
          const out = handleMcp(forge, parsed, bodyInvalid, headers);
          sendJson(res, out.status, out.body, out.headers);
          return;
        }
        // /api/v3/* — handleRest never reads headers, so skip copying them.
        const ctxReq: Req = {
          method,
          path,
          query,
          headers: {},
          body: parsed,
          bodyInvalid,
        };
        const out = handleRest({ forge, baseUrl: baseUrlOf(req) }, ctxReq);
        const extra: Record<string, string> = { ...(out.headers ?? {}) };
        if (path === '/api/v3' || path === '/api/v3/') extra['X-Oauth-Scopes'] = 'repo, read:org';
        sendJson(res, out.status, out.rawBody ?? out.body, extra);
        return;
      }
      // anything else: 404 JSON
      sendJson(res, 404, { message: 'Not Found' });
    } catch (e) {
      try { sendJson(res, 500, { message: e instanceof Error ? e.message : String(e) }); } catch { /* socket gone */ }
    }
  });
}
