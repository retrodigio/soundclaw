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
import { AUTHOR_RE, HUMAN_RE, SAMPLE_LIMITS, floatBytes, joinChannels, pcmToWav, renderExact, type SampleSource } from '@soundclaw/core';
import { decodeInWorker } from './decode.ts';
import { hitJson, libraryAudioFile, loadIndex, readRegistry, searchLibraries, stateUnder, useLibraryFile } from './library.ts';
import { sampleDetail } from './sampledetail.ts';
import { generateBodyFrom, generateFromBody, generationStatus, setProjectCap } from './generate.ts';
import { instrumentCheckAsync } from './instrumentcheck.ts';
import { commitImports } from './sampleimport.ts';
import { songJsonObject } from './songs.ts';
import { reviewOf } from './changes.ts';
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

/**
 * One byte range of a body, from a `Range: bytes=…` header: `a-b`, `a-` or `-n` (one range; a list of several is answered whole). Null for no
 * header or one this does not read (the whole body is sent); 'unsatisfiable' when the range lies outside the body.
 */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

/** Send audio bytes, or the one range of them a `Range` header asks for (206), so a player can seek in a long file. */
function sendAudio(req: IncomingMessage, res: ServerResponse, bytes: Uint8Array, headers: Record<string, string>): void {
  const range = byteRange(req.headers.range, bytes.length);
  const base = { ...HEADERS, 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', ...headers };
  if (range === 'unsatisfiable') { res.writeHead(416, { ...base, 'Content-Range': `bytes */${bytes.length}` }).end(); return; }
  if (!range) { res.writeHead(200, { ...base, 'Content-Length': String(bytes.length) }); res.end(req.method === 'HEAD' ? undefined : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)); return; }
  const part = bytes.subarray(range.start, range.end + 1);
  res.writeHead(206, { ...base, 'Content-Range': `bytes ${range.start}-${range.end}/${bytes.length}`, 'Content-Length': String(part.length) });
  res.end(req.method === 'HEAD' ? undefined : Buffer.from(part.buffer, part.byteOffset, part.byteLength));
}

/** Library files decoded for auditioning, by their ETag: a player asking for ranges of one file decodes it once. */
const auditionCache = new Map<string, Uint8Array>();
const AUDITION_CACHE_BYTES = 96 * 1024 * 1024;

function keepAudition(etag: string, wav: Uint8Array): void {
  auditionCache.delete(etag);
  auditionCache.set(etag, wav);
  let total = 0;
  for (const v of auditionCache.values()) total += v.length;
  for (const k of auditionCache.keys()) {
    if (total <= AUDITION_CACHE_BYTES || auditionCache.size <= 1) break;
    total -= auditionCache.get(k)!.length;
    auditionCache.delete(k);
  }
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
export const FORWARDED_COMMANDS = ['run', 'export', 'import', 'sample', 'library', 'request', 'reply', 'cancel', 'work', 'normalize', 'midi', 'upgrade', 'instrument'];

export async function startWatchServer(o: WatchOptions): Promise<WatchServer> {
  o.writer.samples.list(); // the samples' hashes are worked out (or read from the cache) now, not when the first page connects
  const host = o.host ?? '127.0.0.1';
  const uiDir = findUiDir();
  const sockets = new Set<WsConnection>();
  let port = 0;
  const allowedHosts = (): string[] => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];

  const broadcast = (m: ServerMessage): void => {
    const text = JSON.stringify(m);
    for (const s of sockets) s.send(text);
    if (m.type === 'batch' && sockets.size) setImmediate(() => o.writer.thumbs.warm());
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
    if (url.pathname === '/api/samples/import' && req.method === 'POST') {
      // An uploaded audio file: the body is the file's bytes; ?name= is its file name, ?as=, licence=, ... as `sample import` takes them, ?by=human:<name> the author.
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      const q = url.searchParams;
      const by = q.get('by') ?? '';
      if (!HUMAN_RE.test(by)) { json(res, 400, { error: 'by is human:<name> (letters, digits, . _ -)' }); return; }
      const tooBig = Number(req.headers['content-length'] ?? 0) > SAMPLE_LIMITS.maxFileBytes;
      if (tooBig) { json(res, 413, { error: `the file is larger than ${SAMPLE_LIMITS.maxFileBytes / 1048576} MB` }); req.destroy(); return; }
      const opt = (k: string): string | undefined => q.get(k) ?? undefined;
      // a file name from a page: only the last part, no path
      const filename = (q.get('name') ?? 'upload.wav').replace(/^.*[\\/]/, '').slice(0, 120) || 'upload.wav';
      readBody(req, SAMPLE_LIMITS.maxFileBytes).then(async (b) => {
        const options = { as: opt('as'), licence: opt('licence'), attribution: opt('attribution'), terms: opt('terms'), tags: opt('tags'), source: opt('source') as SampleSource | undefined, origin: opt('origin'), note: opt('note') };
        const clean = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
        const prepared = await decodeInWorker({ bytes: new Uint8Array(b), filename, options: clean });
        const r = await o.writer.enqueue(() => commitImports(o.writer, [prepared], { by, force: false }));
        if (r.problems.length && !r.items.length) throw new ProjectError(r.problems[0]!);
        json(res, 200, { group: r.group, items: r.items.map((x) => ({ name: x.info.name, hash: x.info.sha256, created: x.created, notes: x.notes, sameAs: x.sameAs })), warnings: r.warnings });
      }).catch((e: unknown) => json(res, e instanceof ProjectError ? 400 : 500, { error: (e as Error).message }));
      return;
    }
    if (url.pathname === '/api/generate' && req.method === 'POST') {
      // generate: the words of the command (kind, prompt, pairs, or again; estimate) and its author. The calls are made here, with the key in
      // this process's environment, and the takes go through the writer.
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      readBody(req, 1024 * 1024).then(async (b) => {
        const body = generateBodyFrom(JSON.parse(b.toString('utf8')));
        if (!AUTHOR_RE.test(body.by)) throw new ProjectError('by is agent:<name> or human:<name>');
        const r = await generateFromBody(o.writer, body, o.writer.project.dir);
        json(res, 200, r);
      }).catch((e: unknown) => json(res, e instanceof ProjectError || e instanceof SyntaxError ? 400 : 500, { error: (e as Error).message }));
      return;
    }
    if (url.pathname === '/api/library/use' && req.method === 'POST') {
      // A file of a registered library copied into the project as a person's action (the same as `library use`): { ref: "<library>:<path>", as?, by: "human:<name>" }.
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      readBody(req, 16384).then(async (b) => {
        const j = JSON.parse(b.toString('utf8')) as { ref?: unknown; as?: unknown; by?: unknown };
        if (typeof j.by !== 'string' || !HUMAN_RE.test(j.by)) throw new ProjectError('by is human:<name> (letters, digits, . _ -)');
        if (typeof j.ref !== 'string') throw new ProjectError('ref is <library>:<path>');
        const as = typeof j.as === 'string' && j.as ? j.as : undefined;
        const r = await o.writer.enqueue(() => useLibraryFile(o.writer, j.ref as string, { by: j.by as string, ...(as ? { as } : {}) }));
        json(res, 200, { group: r.group, items: r.items.map((x) => ({ name: x.info.name, hash: x.info.sha256, created: x.created, notes: x.notes, sameAs: x.sameAs })), warnings: r.warnings });
      }).catch((e: unknown) => json(res, e instanceof ProjectError || e instanceof SyntaxError ? 400 : 500, { error: (e as Error).message }));
      return;
    }
    if (url.pathname === '/api/generation/cap' && req.method === 'POST') {
      // the project's generation cap, set by a person from the page. An agent has no way to this: no MCP tool and no command of the language sets a cap,
      // and this route takes only a human author.
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      readBody(req, 4096).then((b) => {
        const j = JSON.parse(b.toString('utf8')) as { capCredits?: unknown; by?: unknown };
        if (typeof j.by !== 'string' || !/^human:[A-Za-z0-9_.-]{1,32}$/.test(j.by)) { json(res, 403, { error: 'a generation cap is set by a person (by: human:<name>), not by an agent' }); return; }
        if (typeof j.capCredits !== 'number') throw new ProjectError('capCredits is a number of credits');
        json(res, 200, { capCredits: setProjectCap(o.writer.project.dir, j.capCredits) });
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
    if (url.pathname === '/api/review') {
      // What the agent did for a request (?request=r3) or in one tape group (?group=g7): before and after, parameters, numbers, checks.
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      o.writer.enqueue(() => {
        try {
          json(res, 200, reviewOf(o.writer, { ...(url.searchParams.get('request') ? { request: url.searchParams.get('request')! } : {}), ...(url.searchParams.get('group') ? { group: url.searchParams.get('group')! } : {}) }));
        } catch (e) {
          json(res, 404, { error: (e as Error).message });
        }
      }).catch((e: unknown) => json(res, 500, { error: (e as Error).message }));
      return;
    }
    const sm0 = /^\/api\/song\/([A-Za-z][A-Za-z0-9_-]*)\.json$/.exec(url.pathname);
    if (sm0) {
      // A song's numbers and checks (measured on the server, once for each distinct document): the card's badge.
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      o.writer.enqueue(() => {
        if (!o.writer.hasSong(sm0[1]!)) { json(res, 404, { error: `no song '${sm0[1]}'` }); return; }
        json(res, 200, songJsonObject(o.writer, sm0[1]!));
      }).catch((e: unknown) => json(res, 500, { error: (e as Error).message }));
      return;
    }
    const cm = /^\/api\/card\/([A-Za-z][A-Za-z0-9_-]*)\.json$/.exec(url.pathname);
    if (cm) {
      // A sound's card (numbers, checks, thumbnails), worked out by a worker thread and kept by the render's content.
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      if (!o.writer.has(cm[1]!)) { json(res, 404, { error: `no sound '${cm[1]}'` }); return; }
      o.writer.thumbs.card(cm[1]!).then((c) => { if (!res.writableEnded) json(res, 200, c); }, (e: unknown) => { if (!res.writableEnded) json(res, 500, { error: (e as Error).message }); });
      return;
    }
    const dm = /^\/api\/sound\/([A-Za-z][A-Za-z0-9_-]*)\.json$/.exec(url.pathname);
    if (dm) {
      // A sound's document (a lean snapshot carries the list only).
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      if (!o.writer.has(dm[1]!)) { json(res, 404, { error: `no sound '${dm[1]}'` }); return; }
      json(res, 200, o.writer.sound(dm[1]!));
      return;
    }
    if (url.pathname === '/api/tape') {
      // The tape's entries before ?before= (a seq), the newest ?limit= of them.
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      const before = url.searchParams.get('before');
      const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit') ?? 500) || 500));
      json(res, 200, { entries: o.writer.tapePage(before === null ? null : Number(before), limit), total: o.writer.tape().length });
      return;
    }
    const stm = /^\/api\/set\/([A-Za-z][A-Za-z0-9_-]*)\.json$/.exec(url.pathname);
    if (stm) {
      // A set's distance matrix and verdict, measured on the server.
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      o.writer.enqueue(() => {
        if (!o.writer.hasSet(stm[1]!)) { json(res, 404, { error: `no set '${stm[1]}'` }); return; }
        json(res, 200, o.writer.measureSetDoc(stm[1]!));
      }).catch((e: unknown) => json(res, 500, { error: (e as Error).message }));
      return;
    }
    if (url.pathname === '/api/libraries') {
      // the registered sample libraries (outside projects) and how many files each index holds
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      json(res, 200, readRegistry().map((e) => ({ id: e.id, name: e.name ?? e.id, licence: e.licence ?? 'unknown', ...(e.attribution ? { attribution: e.attribution } : {}), declared: e.declared, files: loadIndex(e.id)?.files.length ?? null })));
      return;
    }
    if (url.pathname === '/api/library/search') {
      // ?q= words and a numbers query, ?library= one library, ?offset=&limit= a page (48 rows at a time); hits are the compact form `library search --json` prints
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      try {
        const limit = Math.max(1, Math.min(96, Number(url.searchParams.get('limit') ?? 48) || 48));
        const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
        const library = url.searchParams.get('library') || undefined;
        const policy = o.writer.samples.shipPolicy;
        const r = searchLibraries(url.searchParams.get('q') ?? '', { ...(library ? { library } : {}), limit: offset + limit, policy });
        json(res, 200, { offset, total: r.total, notIndexed: r.notIndexed, hits: r.hits.slice(offset).map((h) => hitJson(h, stateUnder(policy))) });
      } catch (e) { json(res, e instanceof ProjectError ? 400 : 500, { error: (e as Error).message }); }
      return;
    }
    if (url.pathname === '/api/generation') {
      // what the generation panel and the session page show: the budget against the caps, the providers and whether a call could be made now (never a key), the totals and the latest ledger lines
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      try { json(res, 200, generationStatus(o.writer.project.dir, o.writer.stamp())); } catch (e) { json(res, e instanceof ProjectError ? 400 : 500, { error: (e as Error).message }); }
      return;
    }
    const icm = /^\/api\/instrument-check\/([A-Za-z][A-Za-z0-9_-]*)\.json$/.exec(url.pathname);
    if (icm) {
      // an instrument's check (findings and each zone's measured pitch and level) for the key-map, worked out in a worker thread and kept
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      instrumentCheckAsync(o.writer, icm[1]!).then((c) => json(res, 200, c), (e: unknown) => json(res, e instanceof ProjectError ? 404 : 500, { error: (e as Error).message }));
      return;
    }
    const scm = /^\/api\/sample-card\/([0-9a-f]{64})\.json$/.exec(url.pathname);
    if (scm) {
      // a sample's numbers and small waveform, worked out in a worker thread once for these bytes (they never change under a hash)
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      if (req.headers['if-none-match'] === `"${scm[1]}"`) { res.writeHead(304, { ...HEADERS, ETag: `"${scm[1]}"` }).end(); return; }
      o.writer.sampleCards.card(scm[1]!).then((c) => {
        const body = Buffer.from(JSON.stringify(c));
        res.writeHead(200, { ...HEADERS, 'Content-Type': 'application/json', 'Content-Length': body.length, 'Cache-Control': 'private, max-age=31536000, immutable', ETag: `"${scm[1]}"` });
        res.end(body);
      }, (e: unknown) => json(res, e instanceof ProjectError ? 404 : 500, { error: (e as Error).message }));
      return;
    }
    const sdm = /^\/api\/sample-detail\/([A-Za-z0-9][A-Za-z0-9_-]*)\.json$/.exec(url.pathname);
    if (sdm) {
      // everything the sample page shows beyond the list: provenance, licence and why, metadata, and what uses it
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      try { json(res, 200, sampleDetail(o.writer, sdm[1]!)); } catch (e) { json(res, e instanceof ProjectError ? 404 : 500, { error: (e as Error).message }); }
      return;
    }
    if (url.pathname === '/api/samples') {
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      json(res, 200, o.writer.samples.list());
      return;
    }
    // Audio by its hash: the bytes never change, so a page may keep them for ever.
    const om = /^\/api\/sample-object\/([0-9a-f]{64})$/.exec(url.pathname);
    if (om) {
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      const bytes = o.writer.samples.objectBytes2(om[1]!);
      if (!bytes) { json(res, 404, { error: `no sample object ${om[1]!.slice(0, 12)}` }); return; }
      if (req.headers['if-none-match'] === `"${om[1]}"`) { res.writeHead(304, { ...HEADERS, ETag: `"${om[1]}"` }).end(); return; }
      sendAudio(req, res, bytes, { 'Cache-Control': 'private, max-age=31536000, immutable', ETag: `"${om[1]}"` });
      return;
    }
    // A file of a registered sample library, for auditioning without copying it into the project: decoded to a WAV, confined to the library's folder.
    const lm = /^\/api\/library\/([a-z0-9][a-z0-9_-]{0,31})\/audio$/.exec(url.pathname);
    if (lm) {
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      let src: ReturnType<typeof libraryAudioFile>;
      try { src = libraryAudioFile(lm[1]!, url.searchParams.get('path') ?? ''); } catch (e) { json(res, 404, { error: (e as Error).message }); return; }
      if (req.headers['if-none-match'] === src.etag && !req.headers.range) { res.writeHead(304, { ...HEADERS, ETag: src.etag }).end(); return; }
      const headers = { 'Cache-Control': 'private, max-age=3600', ETag: src.etag };
      const have = auditionCache.get(src.etag);
      if (have) { sendAudio(req, res, have, headers); return; }
      decodeInWorker({ bytes: src.bytes, filename: src.filename, options: {}, audioOnly: true }).then((p) => {
        const wav = pcmToWav(p.audio);
        keepAudition(src.etag, wav);
        sendAudio(req, res, wav, headers);
      }).catch((e: unknown) => json(res, e instanceof ProjectError ? 422 : 500, { error: (e as Error).message }));
      return;
    }
    const sm = /^\/api\/samples\/([A-Za-z0-9][A-Za-z0-9_-]*)\.wav$/.exec(url.pathname);
    if (sm) {
      if (!authed && !bearerOk(req)) { json(res, 401, { error: 'token required' }); return; }
      const bytes = o.writer.samples.bytes(sm[1]!);
      if (!bytes) { json(res, 404, { error: `no sample '${sm[1]}'` }); return; }
      res.writeHead(200, { ...HEADERS, 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', ETag: `"${o.writer.samples.hash(sm[1]!)}"` });
      res.end(Buffer.from(bytes));
      return;
    }
    // A sound as the server renders it: raw little-endian float32 samples (what the browser must match), or a WAV.
    const rm = /^\/api\/render\/([A-Za-z][A-Za-z0-9_-]*)\.(f32|f64|wav)$/.exec(url.pathname);
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
    setImmediate(() => o.writer.thumbs.warm());
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
    void o.writer.thumbs.close();
    void o.writer.sampleCards.close();
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
      void o.writer.thumbs.close();
    void o.writer.sampleCards.close();
      void mcpHandler?.close();
      for (const s of sockets) s.close(1001);
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
