// app.ts — the HTTP server: routing, bearer auth and body plumbing for the four surfaces
// (git smart HTTP, REST v3, GraphQL, MCP) plus the unauthenticated /healthz probe.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './forge.ts';
import { handleRest, type RestResult } from './rest.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': JSON_TYPE, ...headers });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

export function createApp(): Server {
  const forge = new Forge(process.env.MAKEFUN_SHOP_TOKEN ?? '', process.env.MAKEFUN_TRIAL_NOW);
  const authed = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    return forge.token !== '' && header === `Bearer ${forge.token}`;
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry.local');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authed(req)) {
            sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
            return;
          }
          const outcome = handleMcp(forge, rawBody);
          res.writeHead(outcome.status, { 'content-type': JSON_TYPE });
          res.end(outcome.body);
          return;
        }

        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawBody.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'The request body is not valid JSON' }] });
            return;
          }
          const outcome = handleGraphql(forge, parsed);
          sendJson(res, outcome.status, outcome.body);
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const restHeaders = {
            'x-github-request-id': forge.requestId(),
            'x-oauth-scopes': 'repo, read:org',
            'x-accepted-oauth-scopes': 'repo, read:org',
          };
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Bad credentials' }, restHeaders);
            return;
          }
          let body: Record<string, unknown> | null = null;
          if (rawBody.length > 0) {
            try {
              const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
              if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
              body = parsed as Record<string, unknown>;
            } catch {
              sendJson(res, 400, { message: 'Problems parsing JSON' }, restHeaders);
              return;
            }
          }
          const segments = path
            .slice('/api/v3'.length)
            .split('/')
            .filter((segment) => segment !== '')
            .map((segment) => decodeURIComponent(segment));
          const result: RestResult = handleRest(forge, {
            method,
            segments,
            query: url.searchParams,
            body,
            host: req.headers.host ?? 'localhost',
          });
          sendJson(res, result.status, result.body, { ...restHeaders, ...(result.headers ?? {}) });
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]);
          const repoName = decodeURIComponent(gitMatch[2]);
          const sub = gitMatch[3] ?? '';
          if (!authed(req)) {
            sendRaw(res, 401, 'text/plain; charset=utf-8', Buffer.from('authentication required\n', 'utf8'));
            return;
          }
          forge.learnLogin(owner);
          if (forge.login !== null && owner !== forge.login) {
            sendRaw(res, 404, 'text/plain; charset=utf-8', Buffer.from('repository not found\n', 'utf8'));
            return;
          }
          const repo = forge.repoByName(repoName);
          if (!repo) {
            sendRaw(res, 404, 'text/plain; charset=utf-8', Buffer.from('repository not found\n', 'utf8'));
            return;
          }
          if (sub === '/info/refs' && method === 'GET') {
            const service = url.searchParams.get('service') ?? '';
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendRaw(res, 400, 'text/plain; charset=utf-8', Buffer.from('unknown service\n', 'utf8'));
              return;
            }
            const protocol = req.headers['git-protocol'];
            const v2 = typeof protocol === 'string' && protocol.includes('version=2');
            const result = infoRefs(repo, service, v2);
            sendRaw(res, result.status, result.contentType, result.body);
            return;
          }
          if (sub === '/git-upload-pack' && method === 'POST') {
            const result = uploadPack(repo, rawBody);
            sendRaw(res, result.status, result.contentType, result.body);
            return;
          }
          if (sub === '/git-receive-pack' && method === 'POST') {
            const result = receivePack(repo, rawBody);
            sendRaw(res, result.status, result.contentType, result.body);
            return;
          }
          sendRaw(res, 404, 'text/plain; charset=utf-8', Buffer.from('not found\n', 'utf8'));
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal error' });
        else res.end();
      }
    })();
  });
  server.keepAliveTimeout = 30_000;
  return server;
}
