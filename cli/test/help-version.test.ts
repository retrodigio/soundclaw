// `soundclaw --version` and per-command help (`<command> --help`, `help <command>`), also for the
// commands the entry point handles itself (await, serve).

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandHelp, main, type Io } from '../src/main.ts';

const BIN = join(import.meta.dirname, '..', 'bin', 'soundclaw.js');
const COMMANDS = ['init', 'new', 'run', 'list', 'history', 'render', 'view', 'describe', 'check', 'import', 'library', 'export', 'request', 'reply', 'cancel', 'work', 'skill', 'scale', 'style', 'await', 'serve'];

function direct(args: string[]): { code: number; out: string; err: string } {
  let out = '', err = '';
  const io: Io = { out: (s) => { out += s; }, err: (s) => { err += s; }, stdin: () => '', now: () => '2026-11-06T10:00:00Z' };
  return { code: main(args, io), out, err };
}

describe('--version', () => {
  const version = (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }).version;
  it('prints the package version', () => {
    expect(direct(['--version'])).toMatchObject({ code: 0, out: `soundclaw ${version}\n` });
    expect(execFileSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' })).toBe(`soundclaw ${version}\n`);
    expect(execFileSync(process.execPath, [BIN, '-V'], { encoding: 'utf8' })).toBe(`soundclaw ${version}\n`);
  });
});

describe('per-command help', () => {
  it('every command has a usage block, and --help prints it with exit 0 (also for await and serve)', () => {
    for (const c of COMMANDS) {
      expect(commandHelp(c), c).toContain(`soundclaw ${c} `);
      const r = spawnSync(process.execPath, [BIN, c, '--help'], { encoding: 'utf8' });
      expect(r.status, `${c}: ${r.stderr}`).toBe(0);
      expect(r.stdout).toContain(`soundclaw ${c} `);
      // Only that command: not the whole manual.
      expect(r.stdout.length).toBeLessThan(commandHelp('work')!.length + 9000);
    }
  }, 240_000);
  it('shows only the asked command', () => {
    const h = direct(['await', '--help']).out;
    expect(h).toContain('soundclaw await <project-folder | watch-url>');
    expect(h).not.toContain('soundclaw history');
    expect(direct(['export', '-h']).out).toContain('pre-rendered WAVs');
    expect(direct(['help', 'work']).out).toContain('claim');
    expect(direct(['run', '--help']).out).toContain('sound set <id> <param>=<value>');
  });
  it('an unknown command is a usage error, and so is no command at all', () => {
    expect(direct(['help', 'frobnicate']).code).toBe(2);
    expect(direct(['frobnicate', '--help']).code).toBe(2);
    expect(direct(['frobnicate']).code).toBe(2);
    expect(direct([]).code).toBe(1);
    expect(direct(['--help']).out).toContain('soundclaw run <project>');
  });
  it('every command in the usage is documented in the command reference', () => {
    const ref = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'commands.md'), 'utf8');
    for (const c of COMMANDS) expect(ref, c).toContain(`soundclaw ${c}`);
  });
});
