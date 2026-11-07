// Talking to a running server: `soundclaw await` (wait for what people ask for), and the commands
// that write, which are sent to the server that owns the project so they go through its writer
// queue (same undo groups, same history) and the dashboard updates live. The server is found
// through the project's lock and a token file only the user can read (server/src/runfile.ts).

import { realpathSync } from 'node:fs';
import { request } from 'node:http';
import { resolve } from 'node:path';
import {
  agentName, findServer, formatEvents, loadProject, readRequests, serverFromUrl, shellArg, type AgentEvent, type ServerRef, type Writer,
} from '@soundclaw/server';
import { UsageError, WRITE_OPTS, main, one, parseArgs, type Io } from './main.ts';

/** `await` exits with this when the timeout passed with nothing to report. */
export const EXIT_TIMEOUT = 3;

interface Reply {
  status: number;
  body: string;
}

/** One HTTP request to the server, with no timeout of its own (a long poll may take minutes). */
function call(ref: ServerRef, method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<Reply> {
  return new Promise((resolveP, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request(new URL(path, ref.base), {
      method, signal,
      headers: { Authorization: `Bearer ${ref.token}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
    }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (d: Buffer) => parts.push(d));
      res.on('end', () => resolveP({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(data);
  });
}

/** Commands that change the project, given what they were asked to do. */
function writes(cmd: string, p: ReturnType<typeof parseArgs>): boolean {
  switch (cmd) {
    case 'request': return p.pos.length >= 2;
    case 'work': return p.pos[1] !== undefined;
    case 'sample': return p.pos[0] === 'import';
    default: return true;
  }
}

/**
 * Send a command that writes to the server holding the project, when there is one and its token
 * is readable. Returns the command's exit code (its output printed as the direct path prints it),
 * or null when the command should run directly: it does not write, no server holds the folder, or
 * the server could not be reached.
 */
export async function forwardToServer(argv: string[], io: Pick<Io, 'out' | 'err'>): Promise<number | null> {
  const spec = WRITE_OPTS[argv[0] ?? ''];
  if (!spec) return null;
  let p;
  try { p = parseArgs(argv.slice(1), ...spec); } catch { return null; }
  const dir = argv[0] === 'sample' ? p.pos[1] : p.pos[0];
  if (!dir || !writes(argv[0]!, p)) return null;
  const ref = findServer(resolve(dir));
  if (!ref) return null;
  let r: Reply;
  try {
    r = await call(ref, 'POST', '/api/cli', { argv, cwd: process.cwd() });
  } catch {
    return null;
  }
  let j: { code?: number; stdout?: string; stderr?: string; error?: string };
  try { j = JSON.parse(r.body); } catch { return null; }
  // A server that cannot run CLI commands (501): the command takes the direct path, which says why it is refused.
  if (r.status === 501) return null;
  if (r.status !== 200) {
    io.err(`error: the server refused it: ${j.error ?? r.status}\n`);
    return 1;
  }
  if (j.stdout) io.out(j.stdout);
  if (j.stderr) io.err(j.stderr);
  return j.code ?? 1;
}

/** The server side of `forwardToServer`: run the command on the server's writer, capturing its output. */
export function runForwarded(argv: string[], writer: Writer, cwd: string): { code: number; stdout: string; stderr: string } {
  const spec = WRITE_OPTS[argv[0] ?? ''];
  if (!spec) return { code: 2, stdout: '', stderr: `error: '${argv[0]}' is not sent through the server\n` };
  let dir: string | undefined;
  try { const pa = parseArgs(argv.slice(1), ...spec); dir = argv[0] === 'sample' ? pa.pos[1] : pa.pos[0]; } catch { /* main reports it */ }
  const real = (d: string) => { try { return realpathSync(d); } catch { return resolve(d); } };
  if (dir !== undefined && real(resolve(cwd, dir)) !== real(writer.project.dir)) {
    return { code: 1, stdout: '', stderr: `error: this server owns ${writer.project.dir}, not ${dir}\n` };
  }
  let stdout = '';
  let stderr = '';
  const io: Io = {
    out: (s) => { stdout += s; },
    err: (s) => { stderr += s; },
    stdin: () => '',
    now: () => writer.stamp(),
    writer,
  };
  // main resolves paths against the working folder, so it runs in the caller's (synchronously).
  const before = process.cwd();
  process.chdir(cwd);
  try {
    return { code: main(argv, io), stdout, stderr };
  } catch (e) {
    return { code: 1, stdout, stderr: stderr + `error: ${(e as Error).message}\n` };
  } finally {
    process.chdir(before);
  }
}

/** The server a target (a project folder, or a watch URL with its token) names. */
function target(t: string): ServerRef {
  if (/^https?:\/\//.test(t)) {
    const ref = serverFromUrl(t);
    if (!ref) throw new UsageError('await: the watch URL needs its ?token=…');
    return ref;
  }
  const ref = findServer(resolve(t));
  if (!ref) {
    let known = true;
    try { loadProject(t); } catch { known = false; }
    throw new UsageError(known
      ? `await: no soundclaw server is running for ${t} (start one: soundclaw serve --project ${t}), or its token file is not readable by this user`
      : `await: ${t} is not a SoundClaw project folder or a watch URL`);
  }
  return ref;
}

export const AWAIT_USAGE = 'await <project-folder | watch-url> [--timeout <seconds>] [--since <cursor>] [--as <name>] [--json]';

/**
 * `soundclaw await`: block until a person files, answers or withdraws a request, or approves or
 * rejects a sound; print the events and the cursor for the next call; exit. Exits 0 with events,
 * 3 on timeout, 1 if the server cannot be reached.
 */
export async function awaitMain(argv: string[], io: Pick<Io, 'out' | 'err'>): Promise<number> {
  const p = parseArgs(argv, ['timeout', 'since', 'as'], ['json']);
  if (p.pos.length !== 1) throw new UsageError(`await: ${AWAIT_USAGE}`);
  const timeout = Number(one(p, 'timeout') ?? 600);
  if (!Number.isFinite(timeout) || timeout < 0) throw new UsageError('await: --timeout is seconds');
  const as = agentName(one(p, 'as'));
  const ref = target(p.pos[0]!);
  const q = new URLSearchParams({ timeout: String(timeout), as });
  const since = one(p, 'since');
  if (since) q.set('since', since);
  let r: Reply;
  try {
    r = await call(ref, 'GET', `/api/await?${q}`);
  } catch (e) {
    io.err(`error: could not reach the server at ${ref.base}: ${(e as Error).message}\n`);
    return 1;
  }
  let j: { events?: AgentEvent[]; cursor?: string; timedOut?: boolean; error?: string };
  try { j = JSON.parse(r.body); } catch { j = { error: `unexpected answer (${r.status})` }; }
  if (r.status !== 200 || !j.events || !j.cursor) {
    io.err(`error: ${j.error ?? `the server answered ${r.status}`}\n`);
    return 1;
  }
  io.out(p.flags.has('json') ? JSON.stringify({ events: j.events, cursor: j.cursor, timedOut: j.timedOut }) + '\n' : formatEvents(j.events, j.cursor, { cli: /^https?:\/\//.test(p.pos[0]!) ? '<project>' : shellArg(p.pos[0]!) }) + '\n');
  return j.events.length ? 0 : EXIT_TIMEOUT;
}

/** For listings of a project that has open requests: whether anything is waiting for them. */
export async function listenerLine(dir: string): Promise<string> {
  let open = 0;
  try { open = [...readRequests(loadProject(dir)).values()].filter((q) => q.state === 'open').length; } catch { return ''; }
  if (!open) return '';
  const many = `${open} open request${open === 1 ? '' : 's'}`;
  const ref = findServer(resolve(dir));
  if (!ref) return `${many}, and no server is running: start \`soundclaw serve --project ${dir}\`, then keep \`soundclaw await ${dir}\` running in the background so an agent hears of them.\n`;
  try {
    const r = await call(ref, 'GET', '/api/presence');
    const pr = JSON.parse(r.body) as { waiters?: unknown[] };
    if (pr.waiters?.length) return '';
  } catch {
    return '';
  }
  return `${many} and no agent is waiting for them. Keep \`soundclaw await ${dir}\` running in the background (its exit wakes you), and take them with the MCP work tool (without MCP: \`soundclaw work ${shellArg(dir)} claim\`).\n`;
}
