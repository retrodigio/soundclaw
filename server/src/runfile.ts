// How a client on this machine finds a running server and its token. The lock file in the
// project folder holds the server's pid and URL but never the token (the folder may be shared or
// committed). The token goes in a file of its own, outside the project folder, that only the
// user can read (mode 0600 in a 0700 folder). The file is removed when the server stops. Being
// outside the project, no SoundClaw tool or view can read it, and the worker's fence holds.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { alive, lockHolder, type LockInfo } from './project.ts';

export interface TokenFile {
  pid: number;
  /** The server's address, without the token. */
  url: string;
  token: string;
  /** The project folder it serves. */
  dir: string;
}

/** The folder token files live in: SOUNDCLAW_STATE_DIR, else $XDG_RUNTIME_DIR/soundclaw, else ~/.soundclaw/run. */
export function stateDir(): string {
  const env = process.env.SOUNDCLAW_STATE_DIR;
  if (env) return resolve(env);
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return join(xdg, 'soundclaw');
  return join(homedir(), '.soundclaw', 'run');
}

function real(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/** Where the token file for a project folder is. */
export function tokenFilePath(dir: string): string {
  return join(stateDir(), createHash('sha256').update(real(dir)).digest('hex').slice(0, 24) + '.json');
}

const POSIX = process.platform !== 'win32';

export function writeTokenFile(dir: string, info: Omit<TokenFile, 'dir' | 'pid'>): void {
  const d = stateDir();
  mkdirSync(d, { recursive: true, mode: 0o700 });
  if (POSIX) chmodSync(d, 0o700);
  const f = tokenFilePath(dir);
  rmSync(f, { force: true });
  writeFileSync(f, JSON.stringify({ pid: process.pid, dir: real(dir), ...info } satisfies TokenFile) + '\n', { mode: 0o600 });
  if (POSIX) chmodSync(f, 0o600);
}

/** Remove this process's token file for the folder (another server's is left alone). */
export function removeTokenFile(dir: string): void {
  const f = tokenFilePath(dir);
  try {
    const t = JSON.parse(readFileSync(f, 'utf8')) as TokenFile;
    if (t.pid === process.pid) rmSync(f, { force: true });
  } catch {
    // none, or not ours
  }
}

/** The token file, when it is this user's alone and its server is alive. */
export function readTokenFile(dir: string): TokenFile | null {
  const f = tokenFilePath(dir);
  if (!existsSync(f)) return null;
  try {
    if (POSIX && (statSync(f).mode & 0o077) !== 0) return null;
    const t = JSON.parse(readFileSync(f, 'utf8')) as TokenFile;
    return typeof t.token === 'string' && typeof t.url === 'string' && alive(t.pid) ? t : null;
  } catch {
    return null;
  }
}

/** How to reach a server: its address (no token in it) and its token. */
export interface ServerRef {
  base: string;
  token: string;
  pid: number | null;
  dir: string | null;
}

/**
 * A running server for a project folder: through its lock (which has the URL and pid) and the
 * token file. Null when no live server holds the folder or its token is not readable.
 */
export function findServer(dir: string): ServerRef | null {
  const lock: LockInfo | null = lockHolder(real(dir)) ?? lockHolder(resolve(dir));
  if (!lock) return null;
  const t = readTokenFile(dir);
  if (!t || t.pid !== lock.pid) return null;
  return { base: new URL(lock.url).origin, token: t.token, pid: lock.pid, dir: t.dir };
}

/** A watch URL with its token (`http://127.0.0.1:7417/?token=…`) as a server reference. */
export function serverFromUrl(text: string): ServerRef | null {
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const token = u.searchParams.get('token');
  return token ? { base: u.origin, token, pid: null, dir: null } : null;
}
