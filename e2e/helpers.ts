// A real server on a temporary project, driven by `soundclaw` processes the way an agent
// would, for the browser tests. Nothing is left running: close() stops the server and every
// background process, and removes the folder.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REPO = join(import.meta.dirname, '..');
export const BIN = join(REPO, 'cli', 'bin', 'soundclaw.js');

/**
 * Every server this worker starts, so none outlives it. A spec that times out while `startAgent` is still waiting for the URL never
 * gets the Agent back to close, and a worker that is stopped runs no hooks: this set is emptied when the worker exits or is told to stop,
 * and each pid is also written to the file named by SOUNDCLAW_E2E_PIDS, which global-teardown.ts reads when the whole run ends.
 */
const live = new Set<ChildProcess>();
let reaperInstalled = false;
function reapAll(): void {
  for (const c of live) {
    try { c.kill('SIGTERM'); } catch { /* gone already */ }
  }
  live.clear();
}
function installReaper(): void {
  if (reaperInstalled) return;
  reaperInstalled = true;
  process.on('exit', reapAll);
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => { reapAll(); process.exit(sig === 'SIGINT' ? 130 : 143); });
}

export interface Done { code: number | null; out: string; err: string }

export interface Agent {
  dir: string;
  url: string;
  token: string;
  port: number;
  /** Run `soundclaw <args>` to its end. */
  cli(args: string[]): Promise<Done>;
  /** Start `soundclaw <args>` in the background (an await). */
  background(args: string[]): { done: Promise<Done>; kill(): void };
  /** What the server has written to its error output so far. */
  log(): string;
  /** Stop the server (the project and the page stay): the page goes offline. */
  stop(): Promise<void>;
  /** Start the server again on the same port (it keeps its token, so the page reconnects). */
  restart(): Promise<void>;
  close(): Promise<void>;
}

/** A server on a temporary project: made by `new`, or by `build(dir)` (a project made in this process, e.g. a large one). */
export async function startAgent(o: { build?: (dir: string) => void } = {}): Promise<Agent> {
  const root = mkdtempSync(join(tmpdir(), 'soundclaw-e2e-'));
  const dir = join(root, 'demo.sclaw');
  // the server stops on its own if this worker is killed outright (no hook or teardown would run then)
  const env = { ...process.env, SOUNDCLAW_STATE_DIR: join(root, 'state'), SOUNDCLAW_PARENT_PID: String(process.pid) };
  if (o.build) o.build(dir);
  else execFileSync(process.execPath, [BIN, 'new', dir], { env });
  const children = new Set<ChildProcess>();
  let stderr = '';
  let server!: ChildProcess;
  const launch = async (port: number): Promise<string> => {
    stderr = '';
    installReaper();
    server = spawn(process.execPath, [BIN, 'serve', '--project', dir, '--port', String(port), '--no-mcp'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    live.add(server);
    server.once('exit', () => live.delete(server));
    if (process.env.SOUNDCLAW_E2E_PIDS && server.pid) appendFileSync(process.env.SOUNDCLAW_E2E_PIDS, `${server.pid}\n`);
    server.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    const t0 = Date.now();
    while (!/watch at (\S+)/.test(stderr)) {
      if (Date.now() - t0 > 15_000 || server.exitCode !== null) { server.kill(); throw new Error(`no URL from the server: ${stderr}`); }
      await new Promise((r) => setTimeout(r, 25));
    }
    return /watch at (\S+)/.exec(stderr)![1]!;
  };
  const stopServer = async (): Promise<void> => {
    if (server.exitCode !== null || server.signalCode !== null) return;
    server.kill('SIGTERM');
    await new Promise((r) => server.once('exit', r));
  };
  const url = await launch(0);
  const run = (args: string[]): { child: ChildProcess; done: Promise<Done> } => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let out = '';
    let err = '';
    child.stdout!.on('data', (d: Buffer) => { out += d; });
    child.stderr!.on('data', (d: Buffer) => { err += d; });
    return { child, done: new Promise((resolve) => child.on('close', (code) => { children.delete(child); resolve({ code, out, err }); })) };
  };
  return {
    dir, url, token: new URL(url).searchParams.get('token')!, port: Number(new URL(url).port),
    log: () => stderr,
    cli: (args) => run(args).done,
    background: (args) => { const r = run(args); return { done: r.done, kill: () => r.child.kill('SIGTERM') }; },
    stop: stopServer,
    restart: async () => { await stopServer(); await launch(Number(new URL(url).port)); },
    close: async () => {
      for (const c of children) c.kill('SIGTERM');
      await stopServer();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
