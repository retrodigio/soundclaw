// HTTP and WebSocket for the dashboard, on localhost only. The page and its scripts are public
// (they hold no sounds), but the project itself (/api/*, /ws, /mcp) needs the token printed at
// start, and so does the page's own URL, so a bare link shows how to get in.

import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpHandler, type McpServerFactory } from '@modelcontextprotocol/server';
import { HUMAN_RE, floatBytes, joinChannels, renderExact } from '@soundclaw/core';
import { ProjectError } from './project.ts';
import type { ClientMessage, PersonRequest, ServerMessage } from './protocol.ts';
import { awaitRequests, personRequest } from './requests.ts';
import type { Writer } from './writer.ts';
import { acceptWebSocket, type WsConnection } from './ws.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.map': 'application/json',
};

/** The built UI: next to the bundle (dist/ui) or, from the sources, ui/dist. */
export function findUiDir(): string | null {
  const candidates = [
    process.env.SOUNDCLAW_UI_DIR,
    fileURLToPath(new URL('./ui/', import.meta.url)),
    fileURLToPath(new URL('../../ui/dist/', import.meta.url)),
  ];
  for (const d of candidates) if (d && existsSync(join(d, 'index.html'))) return d;
  return null;
}

function tokenOk(given: string | null, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'";

function page(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:15px system-ui;background:#16171b;color:#d8dbe0;padding:3em;max-width:40em">
<h1 style="font-size:20px">SoundClaw: ${title}</h1>${body}</body>`);
}

/** Longest command text a page may send in one message. */
const MAX_COMMANDS = 256 * 1024;

/** A person's edit: one batch, through the writer's queue like everything else, written with the page's author name (which must be `human:<name>`). */
export async function runFromPage(w: Writer, m: Extract<ClientMessage, { type: 'run' }>): Promise<ServerMessage> {
  const fail = (message: string): ServerMessage => ({ type: 'result', id: m.id, ok: false, errors: [{ line: 0, col: 0, message }] });
  if (typeof m.by !== 'string' || !HUMAN_RE.test(m.by)) return fail('a page writes as human:<name> (letters, digits, . _ -)');
  if (typeof m.commands !== 'string') return fail('run needs commands');
  if (m.commands.length > MAX_COMMANDS) return fail('too many commands in one message');
  return w.enqueue((): ServerMessage => {
    try {
      const r = w.run({ commands: m.commands, by: m.by });
      if (!r.ok) return { type: 'result', id: m.id, ok: false, errors: r.errors };
      return { type: 'result', id: m.id, ok: true, group: r.group, seq: r.added.at(-1)?.seq ?? null };
    } catch (e) {
      if (e instanceof ProjectError) return fail(e.message);
      return fail(`internal error: ${(e as Error).message}`);
    }
  });
}

/** A request, reply or cancel from a page, written as the page's person. */
export async function requestFromPage(w: Writer, m: Extract<ClientMessage, { type: 'request' }>): Promise<ServerMessage> {
  if (typeof m.by !== 'string' || !HUMAN_RE.test(m.by)) return { type: 'answer', id: m.id, ok: false, error: 'a page writes as human:<name>' };
  return w.enqueue((): ServerMessage => {
    try {
      const request = personRequest(w, m.by, m.body as PersonRequest);
      w.requestsChanged();
      return { type: 'answer', id: m.id, ok: true, request };
    } catch (e) {
      return { type: 'answer', id: m.id, ok: false, error: e instanceof ProjectError ? e.message : `internal error: ${(e as Error).message}` };
    }
  });
}

/** Largest upload (a CLI command's input). */
const MAX_UPLOAD = 32 * 1024 * 1024;

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let n = 0;
    req.on('data', (d: Buffer) => {
      n += d.length;
      if (n > max) { reject(new ProjectError('too large')); req.destroy(); return; }
      parts.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

export interface WatchServer {
  url: string;
  port: number;
  token: string;
  clients(): number;
  close(): Promise<void>;
}

export interface WatchOptions {
  writer: Writer;
  token: string;
  /** The port to try first; 0 picks a free one. */
  port: number;
  /** How many ports after `port` to try when it is taken. */
  tries?: number;
  host?: string;
  /** Serve MCP over HTTP at /mcp, with the token as a bearer. */
  mcp?: () => ReturnType<McpServerFactory>;
  /** Runs a CLI invocation against the writer (POST /api/cli); the CLI supplies it. */
  runCli?: (argv: string[], writer: Writer, cwd: string) => { code: number; stdout: string; stderr: string };
}

/** Commands the CLI may send to the server (the ones that write). */
export const FORWARDED_COMMANDS = ['run', 'export', 'import', 'sample', 'request', 'reply', 'cancel', 'work'];

export async function startWatchServer(o: WatchOptions): Promise<WatchServer> {
  const host = o.host ?? '127.0.0.1';
  const uiDir = findUiDir();
  const sockets = new Set<WsConnection>();
  let port = 0;
  const allowedHosts = (): string[] => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];

  const broadcast = (m: ServerMessage): void => {
    const text = JSON.stringify(m);
    for (const s of sockets) s.send(text);
  };
  const unsubscribe = o.writer.on(broadcast);
  const mcpHandler = o.mcp ? createMcpHandler(() => o.mcp!(), { onerror: () => undefined }) : null;
  const json = (res: ServerResponse, status: number, v: unknown) => {
    res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(v) + '\n');
  };

  /** MCP over HTTP: the web request handed to the SDK's handler, its response streamed back. */
  const serveMcp = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const auth = String(req.headers.authorization ?? '');
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('token');
    if (!mcpHandler || !tokenOk(given, o.token)) {
      res.writeHead(mcpHandler ? 401 : 404, { ...HEADERS, 'Content-Type': 'text/plain' }).end(mcpHandler ? 'token required\n' : 'not found\n');
      return;
    }
    const body = req.method === 'POST' ? await readBody(req, 8 * 1024 * 1024) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v); else if (Array.isArray(v)) headers.set(k, v.join(', '));
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const r = await mcpHandler.fetch(new Request(url, { method: req.method, headers, body: body ? new Uint8Array(body) : undefined, signal: ac.signal }));
    const out: Record<string, string> = {};
    r.headers.forEach((v, k) => { out[k] = v; });
    res.writeHead(r.status, out);
    if (!r.body) { res.end(); return; }
    const reader = r.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      // the client went away
    }
    res.end();
  };

  const bearerOk = (req: IncomingMessage): boolean => {
    const auth = String(req.headers.authorization ?? '');
    return auth.startsWith('Bearer ') && tokenOk(auth.slice(7), o.token);
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    // Only localhost names: a page on another site can't reach us by rebinding a DNS name.
    if (!allowedHosts().includes(String(req.headers.host))) {
      res.writeHead(421, HEADERS).end('wrong host\n');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const authed = tokenOk(url.searchParams.get('token'), o.token);
    if (url.pathname === '/mcp') {
      serveMcp(req, res, url).catch((e: unknown) => { if (!res.headersSent) json(res, 500, { error: (e as Error).message }); else res.end(); });
      return;
    }
    if (url.pathname === '/api/cli' && req.method === 'POST') {
      // A CLI command run in another process, sent here so it goes through the writer's queue.
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      if (!o.runCli) { json(res, 501, { error: 'this server cannot run CLI commands' }); return; }
      readBody(req, MAX_UPLOAD).then(async (b) => {
        const body = JSON.parse(b.toString('utf8')) as { argv?: unknown; cwd?: unknown };
        if (!Array.isArray(body.argv) || !body.argv.every((x) => typeof x === 'string') || typeof body.cwd !== 'string') throw new ProjectError('argv and cwd are needed');
        const argv = body.argv as string[];
        if (!FORWARDED_COMMANDS.includes(argv[0] ?? '')) throw new ProjectError(`'${argv[0]}' is not sent through the server`);
        const cwd = body.cwd;
        const r = await o.writer.enqueue(() => {
          const out = o.runCli!(argv, o.writer, cwd);
          o.writer.requestsChanged();
          return out;
        });
        json(res, 200, r);
      }).catch((e: unknown) => json(res, e instanceof ProjectError || e instanceof SyntaxError ? 400 : 500, { error: (e as Error).message }));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, HEADERS).end();
      return;
    }
    if (url.pathname === '/api/await') {
      // Long poll: events after ?since= (a cursor), or none after ?timeout= seconds. ?as= names the listener.
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      const as = url.searchParams.get('as') ?? 'agent:claude';
      if (!/^agent:[A-Za-z0-9_.-]{1,32}$/.test(as)) { json(res, 400, { error: 'as is agent:<name> (letters, digits, . _ -)' }); return; }
      const timeoutS = Number(url.searchParams.get('timeout') ?? 600);
      if (!Number.isFinite(timeoutS) || timeoutS < 0) { json(res, 400, { error: 'timeout is seconds' }); return; }
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      awaitRequests(o.writer, { cursor: url.searchParams.get('since') ?? undefined, timeoutS, by: as, via: url.searchParams.get('via') === 'mcp' ? 'mcp' : 'cli', signal: ac.signal })
        .then((r) => { if (!res.writableEnded && !ac.signal.aborted) json(res, 200, r); }, (e: unknown) => { if (!res.writableEnded) json(res, 500, { error: (e as Error).message }); });
      return;
    }
    if (url.pathname === '/api/presence') {
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      json(res, 200, o.writer.hub.presence());
      return;
    }
    if (url.pathname === '/api/state') {
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      json(res, 200, o.writer.snapshot());
      return;
    }
    if (url.pathname === '/api/samples') {
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      json(res, 200, o.writer.samples.list());
      return;
    }
    const sm = /^\/api\/samples\/([a-z0-9][a-z0-9_-]*)\.wav$/.exec(url.pathname);
    if (sm) {
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      const bytes = o.writer.samples.bytes(sm[1]!);
      if (!bytes) { json(res, 404, { error: `no sample '${sm[1]}'` }); return; }
      res.writeHead(200, { ...HEADERS, 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', ETag: `"${o.writer.samples.hash(sm[1]!)}"` });
      res.end(Buffer.from(bytes));
      return;
    }
    // A sound as the server renders it: raw little-endian float32 samples (what the browser must match), or a WAV.
    const rm = /^\/api\/render\/([a-z][a-z0-9_-]*)\.(f32|f64|wav)$/.exec(url.pathname);
    if (rm) {
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      void o.writer.enqueue(() => o.writer.render(rm[1]!)).then((r) => {
        // f64: the exact doubles (the classic voice's reference samples); f32: what is played; wav: as exported.
        const body = rm[2] === 'wav' ? o.writer.wavOf(rm[1]!) : rm[2] === 'f64' ? new Uint8Array(renderExact(o.writer.sound(rm[1]!), o.writer.samples).buffer) : floatBytes(joinChannels(r.channels));
        res.writeHead(200, { ...HEADERS, 'Content-Type': rm[2] === 'wav' ? 'audio/wav' : 'application/octet-stream', 'Cache-Control': 'no-store', ETag: `"${r.key}"` });
        res.end(Buffer.from(body));
      }, (e: unknown) => json(res, e instanceof ProjectError ? 404 : 500, { error: (e as Error).message }));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (!authed) {
        page(res, 401, 'token required', `<p>This view needs the link with its token, as printed when the server
          started (<code>soundclaw: watch at http://127.0.0.1:${port}/?token=…</code>). Ask the agent for the
          link, or look in the server's log.</p>`);
        return;
      }
      if (!uiDir) {
        page(res, 503, 'UI not built', '<p>The dashboard has not been built. Run <code>pnpm build</code> in the repo.</p>');
        return;
      }
      res.writeHead(200, { ...HEADERS, 'Content-Security-Policy': CSP, 'Content-Type': TYPES['.html']!, 'Cache-Control': 'no-store' });
      res.end(readFileSync(join(uiDir, 'index.html')));
      return;
    }
    if (uiDir && url.pathname.startsWith('/assets/')) {
      const file = normalize(join(uiDir, decodeURIComponent(url.pathname)));
      if (file.startsWith(join(uiDir, 'assets') + sep) && existsSync(file) && statSync(file).isFile()) {
        res.writeHead(200, {
          ...HEADERS, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
        res.end(readFileSync(file));
        return;
      }
    }
    res.writeHead(404, { ...HEADERS, 'Content-Type': 'text/plain' }).end('not found\n');
  };

  const server: Server = createServer(handle);
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (!allowedHosts().includes(String(req.headers.host)) || url.pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!tokenOk(url.searchParams.get('token'), o.token)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    const ws = acceptWebSocket(req, socket);
    if (!ws) return;
    sockets.add(ws);
    ws.onclose = () => sockets.delete(ws);
    ws.onmessage = (text) => {
      let m: ClientMessage;
      try {
        m = JSON.parse(text) as ClientMessage;
      } catch {
        return;
      }
      if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong' } satisfies ServerMessage));
      else if (m.type === 'run') void runFromPage(o.writer, m).then((r) => ws.send(JSON.stringify(r)));
      else if (m.type === 'request') void requestFromPage(o.writer, m).then((r) => ws.send(JSON.stringify(r)));
    };
    ws.send(JSON.stringify({ type: 'hello', snapshot: o.writer.snapshot() } satisfies ServerMessage));
  });

  const tries = o.port === 0 ? 1 : Math.max(1, o.tries ?? 20);
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(o.port === 0 ? 0 : o.port + i, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') break;
    }
  }
  if (lastErr) {
    unsubscribe();
    throw lastErr;
  }
  port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/?token=${o.token}`;
  return {
    url, port, token: o.token,
    clients: () => sockets.size,
    close: () => new Promise<void>((resolve) => {
      unsubscribe();
      o.writer.hub.close();
      void mcpHandler?.close();
      for (const s of sockets) s.close(1001);
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
