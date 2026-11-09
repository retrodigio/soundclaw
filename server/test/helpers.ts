// Shared by the server tests: a temporary project and a Writer on it with a fixed clock.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writer, createProject, loadProject } from '../src/index.ts';

export const REPO = join(import.meta.dirname, '..', '..');
export const BIN = join(REPO, 'cli', 'bin', 'soundclaw.js');

export interface Fixture {
  root: string;
  dir: string;
  w: Writer;
  /** A new Writer on the same folder (as a restarted process would have). */
  reopen(): Writer;
  clean(): void;
}

export function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'soundclaw-test-'));
  const dir = join(root, 'demo.sclaw');
  let n = 0;
  const now = () => new Date(Date.UTC(2026, 10, 6, 10, 0, n++)).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const w = new Writer(createProject(dir), { now });
  return { root, dir, w, reopen: () => new Writer(loadProject(dir), { now }), clean: () => rmSync(root, { recursive: true, force: true }) };
}

export async function until(f: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!(await f())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
