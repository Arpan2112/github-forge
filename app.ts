// app.ts — the forge's HTTP server: git smart HTTP, REST v3, GraphQL v4 and MCP over one
// shared in-memory model (forge.ts). Every surface answers JSON with GitHub's shapes; every
// request but /healthz carries the trial's bearer token.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './forge.ts';
import { handleApi } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  advertiseReceivePack,
  advertiseUploadPack,
  handleFetchV0,
  handleFetchV2,
  handleLsRefs,
  handleReceivePack,
} from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}-${Date.now().toString(36)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer token this process was given, or null when the environment set none. */
function expectedToken(): string | null {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  return token === undefined || token === '' ? null : token;
}

function authorized(req: IncomingMessage): boolean {
  const expected = expectedToken();
  if (expected === null) return true;
  const header = req.headers.authorization;
  return header === `Bearer ${expected}`;
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

async function route(forge: Forge, req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 400, { message: 'Bad Request' }, { 'x-github-request-id': requestId });
    return;
  }
  const path = url.pathname;

  // The env's boot check: no auth, always the same answer.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Everything else needs the trial's token; a missing or wrong one is a 401 JSON body.
  if (!authorized(req)) {
    const message = req.headers.authorization === undefined ? 'Requires authentication' : 'Bad credentials';
    sendJson(res, 401, { message }, { 'x-github-request-id': requestId });
    return;
  }

  const body = await readBody(req);

  // MCP.
  if (path === '/mcp') {
    if (method !== 'POST' && method !== 'GET') {
      sendJson(res, 405, { message: 'Method Not Allowed' }, { 'x-github-request-id': requestId });
      return;
    }
    if (method === 'GET') {
      sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'GET is not supported' } }, { 'x-github-request-id': requestId });
      return;
    }
    const result = handleMcp(forge, body);
    if (result.body === undefined) {
      res.writeHead(result.status, { 'x-github-request-id': requestId });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, { 'x-github-request-id': requestId });
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }, { 'x-github-request-id': requestId });
      return;
    }
    const result = handleGraphQL(forge, parsed);
    sendJson(res, 200, result, { 'x-github-request-id': requestId });
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const subPath = path.slice('/api/v3'.length) || '/';
    const result = handleApi(forge, {
      method,
      path: subPath,
      query: url.searchParams,
      body,
      host: req.headers.host ?? 'localhost',
    });
    const headers: Record<string, string> = { 'x-github-request-id': requestId, ...(result.headers ?? {}) };
    if (result.status === 204 || result.body === undefined) {
      res.writeHead(result.status, headers);
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, headers);
    return;
  }

  // Git smart HTTP.
  const gitMatch = GIT_PATH.exec(path);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1] as string);
    const repoName = decodeURIComponent(gitMatch[2] as string);
    const rest = gitMatch[3] ?? '';
    const repo = forge.getRepo(owner, repoName);
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
      return;
    }
    if (method === 'GET' && rest === '/info/refs') {
      const service = url.searchParams.get('service');
      if (service === 'git-upload-pack') {
        const protocol = req.headers['git-protocol'];
        const version2 = typeof protocol === 'string' && protocol.includes('version=2');
        sendBuffer(res, 200, advertiseUploadPack(repo, version2), 'application/x-git-upload-pack-advertisement', { 'x-github-request-id': requestId });
        return;
      }
      if (service === 'git-receive-pack') {
        sendBuffer(res, 200, advertiseReceivePack(repo), 'application/x-git-receive-pack-advertisement', { 'x-github-request-id': requestId });
        return;
      }
      sendJson(res, 403, { message: 'Forbidden' }, { 'x-github-request-id': requestId });
      return;
    }
    if (method === 'POST' && rest === '/git-upload-pack') {
      // Protocol v2 commands arrive as pkt-line text (`command=...`); a v0 request starts with
      // `want` lines instead, so the command key is the discriminator.
      if (body.includes(Buffer.from('command=ls-refs'))) {
        sendBuffer(res, 200, handleLsRefs(repo, body), 'application/x-git-upload-pack-result', { 'x-github-request-id': requestId });
        return;
      }
      if (body.includes(Buffer.from('command=fetch'))) {
        sendBuffer(res, 200, handleFetchV2(repo, body), 'application/x-git-upload-pack-result', { 'x-github-request-id': requestId });
        return;
      }
      sendBuffer(res, 200, handleFetchV0(repo, body), 'application/x-git-upload-pack-result', { 'x-github-request-id': requestId });
      return;
    }
    if (method === 'POST' && rest === '/git-receive-pack') {
      sendBuffer(res, 200, handleReceivePack(repo, body), 'application/x-git-receive-pack-result', { 'x-github-request-id': requestId });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
    return;
  }

  // Anything else: GitHub's JSON 404.
  sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = nextRequestId();
    route(forge, req, res, requestId).catch((error: unknown) => {
      process.stderr.write(`[forge] request failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error' }, { 'x-github-request-id': requestId });
      } else {
        res.end();
      }
    });
  });
}
