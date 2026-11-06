// A real server on a temporary project, driven by `soundclaw` processes the way an agent
// would, for the browser tests. Nothing is left running: close() stops the server and every
// background process, and removes the folder.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REPO = join(import.meta.dirname, '..');
export const BIN = join(REPO, 'cli', 'bin', 'soundclaw.js');

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
  close(): Promise<void>;
}

export async function startAgent(): Promise<Agent> {
  const root = mkdtempSync(join(tmpdir(), 'soundclaw-e2e-'));
  const dir = join(root, 'demo.sclaw');
  const env = { ...process.env, SOUNDCLAW_STATE_DIR: join(root, 'state') };
  execFileSync(process.execPath, [BIN, 'new', dir], { env });
  const server = spawn(process.execPath, [BIN, 'serve', '--project', dir, '--port', '0', '--no-mcp'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const children = new Set<ChildProcess>();
  let stderr = '';
  server.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
  const t0 = Date.now();
  while (!/watch at (\S+)/.test(stderr)) {
    if (Date.now() - t0 > 15_000) { server.kill(); throw new Error(`no URL from the server: ${stderr}`); }
    await new Promise((r) => setTimeout(r, 25));
  }
  const url = /watch at (\S+)/.exec(stderr)![1]!;
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
    cli: (args) => run(args).done,
    background: (args) => { const r = run(args); return { done: r.done, kill: () => r.child.kill('SIGTERM') }; },
    close: async () => {
      for (const c of children) c.kill('SIGTERM');
      server.kill('SIGTERM');
      await new Promise((r) => (server.exitCode !== null ? r(null) : server.once('exit', r)));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
