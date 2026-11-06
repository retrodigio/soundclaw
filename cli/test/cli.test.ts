// The CLI against project folders on disk: new, run (from -e, a file and stdin), list, history,
// render, export, and the exit codes.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeWav, newSound, renderSound, samplesHash } from '@soundclaw/core';
import { main, type Io } from '../src/main.ts';

const BIN = join(import.meta.dirname, '..', 'bin', 'soundclaw.js');
let tmp: string;
let proj: string;
let clock = 0;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'soundclaw-cli-'));
  proj = join(tmp, 'demo.sclaw');
  clock = 0;
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function sc(args: string[], stdin = ''): { code: number; out: string; err: string } {
  let out = '', err = '';
  const io: Io = { out: (s) => { out += s; }, err: (s) => { err += s; }, stdin: () => stdin, now: () => `2026-11-06T10:00:${String(clock++).padStart(2, '0')}Z` };
  return { code: main(args, io), out, err };
}

describe('new', () => {
  it('makes the project folder', () => {
    const r = sc(['new', proj]);
    expect(r).toMatchObject({ code: 0 });
    expect(r.out).toContain("created project 'demo'");
    expect(readdirSync(proj).sort()).toEqual(['.gitignore', 'exports', 'history.jsonl', 'instruments', 'project.json', 'requests.jsonl', 'sets', 'songs', 'sounds']);
    expect(sc(['new', proj]).err).toMatch(/already/);
    expect(sc(['new']).code).toBe(2);
  });
  it('--name names the project', () => {
    sc(['new', proj, '--name', 'Cave Sounds']);
    expect(JSON.parse(readFileSync(join(proj, 'project.json'), 'utf8')).name).toBe('Cave Sounds');
  });
});

describe('run', () => {
  beforeEach(() => { sc(['new', proj]); });

  it('applies commands, prints them as written and the numbers of each changed sound', () => {
    const r = sc(['run', proj, '-e', 'sound new beep; sound set beep frequency=880.0 volume=.4']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('applied 2 commands as group g1 by agent:claude');
    expect(r.out).toContain('  #2 sound set beep frequency=880 volume=0.4');
    const hash = samplesHash(renderSound({ ...newSound('beep'), frequency: 880, volume: 0.4 })).slice(0, 12);
    expect(r.out).toContain(`beep: tone 880 Hz, 0.5 s, volume 0.4 → 22050 samples, peak 0.400, rms 0.283, hash ${hash}`);
    expect(r.out).toContain('warnings: none');
  });

  it('reads a script file or standard input, and --by names the author', () => {
    writeFileSync(join(tmp, 'a.txt'), '# a script\nsound new a\nsound set a duration=0.1\n');
    expect(sc(['run', proj, join(tmp, 'a.txt')]).out).toContain('applied 2 commands');
    const r = sc(['run', proj, '-', '--by', 'human:ana'], 'sound new b\n');
    expect(r.out).toContain('group g2 by human:ana');
    expect(sc(['run', proj, '-e', 'sound new c', '--by', 'bo']).out).toContain('by agent:bo');
    expect(sc(['history', proj]).out).toContain('human:ana');
  });

  it('prints every error with source, line and column, exits 1 and applies nothing', () => {
    sc(['run', proj, '-e', 'sound new a']);
    const before = readFileSync(join(proj, 'history.jsonl'), 'utf8');
    const r = sc(['run', proj, '-e', 'sound set a volume=0.2\nsound set a frequency=1\nsound frob a']);
    expect(r.code).toBe(1);
    expect(r.err).toBe("<-e>:2:13: error: frequency must be between 20 and 20000 Hz (got 1)\n<-e>:3:7: error: unknown sound command 'frob' (new, set, mark)\n2 errors; nothing was applied.\n");
    expect(readFileSync(join(proj, 'history.jsonl'), 'utf8')).toBe(before);
  });

  it('usage errors exit 2', () => {
    expect(sc(['run']).code).toBe(2);
    expect(sc(['run', proj]).err).toMatch(/give a script file, - for standard input, or -e/);
    expect(sc(['run', proj, 'nope.txt']).err).toMatch(/no such script/);
    expect(sc(['run', proj, '-e', 'x', 'file']).err).toMatch(/not both/);
    expect(sc(['run', proj, '-e', 'x', '--bogus']).err).toMatch(/unknown option --bogus/);
    expect(sc(['run', proj, '-e', 'sound new a', '--by', 'a b']).err).toMatch(/--by is agent:<name> or human:<name>/);
    expect(sc(['run', join(tmp, 'missing'), '-e', 'sound new a'])).toMatchObject({ code: 1 });
  });

  it('undo and redo are commands', () => {
    sc(['run', proj, '-e', 'sound new a']);
    expect(sc(['run', proj, '-e', 'undo']).out).toContain('a: removed');
    expect(sc(['list', proj]).out).toBe('no sounds yet\n');
    expect(sc(['run', proj, '-e', 'redo']).out).toContain('a: tone 440 Hz');
    expect(sc(['run', proj, '-e', 'redo']).err).toContain('nothing to redo');
  });
});

describe('list, history, render', () => {
  beforeEach(() => {
    sc(['new', proj]);
    sc(['run', proj, '-e', 'sound new beep; sound new boop; sound set boop frequency=220']);
    sc(['run', proj, '-e', 'sound mark beep approved', '--by', 'human:ana']);
  });
  it('list shows each sound with its status and numbers', () => {
    const r = sc(['list', proj]).out.split('\n');
    expect(r[0]).toBe('2 sounds:');
    expect(r[1]).toMatch(/^ {2}beep: tone 440 Hz, 0.5 s, volume 0.5, approved → 22050 samples/);
    expect(r[2]).toMatch(/^ {2}boop: tone 220 Hz/);
  });
  it('history filters by sound, author and count', () => {
    expect(sc(['history', proj]).out.split('\n')[0]).toBe('4 commands in 2 groups');
    expect(sc(['history', proj, '--by', 'human:ana']).out).toMatch(/#4 g2 human:ana \S+  sound mark beep approved$/m);
    expect(sc(['history', proj, '--sound', 'boop']).out).toContain('showing 2');
    expect(sc(['history', proj, '--limit', '1']).out).toContain('showing 1');
    expect(sc(['history', proj, '--limit', '0']).code).toBe(2);
  });
  it('render prints the numbers and says when the cache served it', () => {
    // `run` rendered it for its numbers, so the cache is warm; with the cache gone the first render is fresh.
    expect(sc(['render', proj, 'beep']).out).toMatch(/\(from the render cache\)\n$/);
    rmSync(join(proj, '.cache'), { recursive: true });
    expect(sc(['render', proj, 'beep']).out).toMatch(/render key [0-9a-f]{12}\n$/);
    expect(sc(['render', proj, 'beep']).out).toMatch(/\(from the render cache\)\n$/);
    expect(sc(['render', proj, 'nope']).err).toMatch(/no sound 'nope'/);
  });
});

describe('export', () => {
  beforeEach(() => {
    sc(['new', proj]);
    sc(['run', proj, '-e', 'sound new beep; sound set beep duration=0.1; sound new boop']);
  });
  it('writes WAV files for the named sounds, or all, into exports/ or --out', () => {
    const r = sc(['export', proj, 'beep']);
    expect(r.out).toContain('exported 1 sound');
    const wav = decodeWav(new Uint8Array(readFileSync(join(proj, 'exports', 'beep.wav'))));
    expect(wav).toMatchObject({ channels: 1, sampleRate: 44100, bitsPerSample: 16, frames: 4410 });
    expect(existsSync(join(proj, 'exports', 'boop.wav'))).toBe(false);
    sc(['export', proj, '--out', join(tmp, 'out')]);
    expect(readdirSync(join(tmp, 'out')).sort()).toEqual(['beep.wav', 'boop.wav']);
    expect(sc(['export', proj, 'nope']).err).toMatch(/no sound 'nope'/);
  });
  it('is byte-identical when exported twice and from a fresh process', () => {
    sc(['export', proj, 'beep']);
    const a = readFileSync(join(proj, 'exports', 'beep.wav'));
    execFileSync(process.execPath, [BIN, 'export', proj, 'beep', '--out', join(tmp, 'again')]);
    expect(Buffer.compare(a, readFileSync(join(tmp, 'again', 'beep.wav')))).toBe(0);
  });
});

describe('request, reply, cancel and work without a server', () => {
  beforeEach(() => {
    sc(['new', proj]);
    sc(['run', proj, '-e', 'sound new beep']);
  });
  it('a request, claim, progress, block, reply, claim and done', () => {
    expect(sc(['request', proj]).out).toBe('no open requests\n');
    expect(sc(['request', proj, 'beep', '--note', 'softer', '--by', 'ana']).out).toMatch(/^r1 change beep: "softer" \(from human:ana at \S+; open\)\n/);
    expect(sc(['request', proj, 'beep']).err).toMatch(/say what should change/);
    expect(sc(['work', proj, 'list']).out).toContain('seen by agent:claude');
    const c = sc(['work', proj, 'claim']);
    expect(c.out).toMatch(/^claimed r1\n/);
    expect(c.out).toContain('soundclaw work ' + proj + ' done r1');
    expect(sc(['work', proj, 'progress', 'working on it']).out).toContain('r1: progress');
    expect(sc(['work', proj, 'block', 'how soft?']).out).toContain('blocked: "how soft?"');
    expect(sc(['reply', proj, 'r1', 'half']).out).toContain('open');
    expect(sc(['work', proj, 'claim', 'r1']).code).toBe(0);
    expect(sc(['work', proj, 'done', 'volume 0.25']).out).toContain('No open requests left.');
    expect(sc(['request', proj]).out).toBe('no open requests\n');
  });
  it('work and reply check their arguments', () => {
    expect(sc(['work', proj, 'frob']).err).toMatch(/the action is list, claim, progress, block, done/);
    expect(sc(['work', proj, 'done']).err).toMatch(/say what changed/);
    expect(sc(['work', proj, 'claim', 'text']).err).toMatch(/unexpected 'text'/);
    expect(sc(['work', proj, 'claim']).out).toBe('no open requests\n');
    expect(sc(['work', proj, 'progress', 'x']).err).toMatch(/no claimed request/);
    expect(sc(['cancel', proj, 'r9']).err).toMatch(/no request r9/);
    expect(sc(['reply', proj]).code).toBe(2);
  });
});

describe('skill', () => {
  it('prints where the skill is and installs it', () => {
    const where = sc(['skill', 'path']).out.trim();
    expect(existsSync(join(where, 'SKILL.md'))).toBe(true);
    const dest = join(tmp, 'skills', 'soundclaw');
    const r = sc(['skill', 'install', '--dest', dest]);
    expect(r.out).toContain('installed the SoundClaw skill');
    expect(readdirSync(dest).sort()).toEqual(['SKILL.md', 'commands.md']);
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toMatch(/^---\nname: soundclaw\n/);
    expect(sc(['skill']).code).toBe(2);
  });
});

describe('the executable', () => {
  it('exits with the command\'s code and keeps stdout and stderr apart', () => {
    const r = spawnSync(process.execPath, [BIN, 'run', join(tmp, 'nope'), '-e', 'sound new a'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/is not a SoundClaw project/);
    expect(spawnSync(process.execPath, [BIN, 'bogus'], { encoding: 'utf8' }).status).toBe(2);
  });
  it('run reads standard input', () => {
    execFileSync(process.execPath, [BIN, 'new', proj]);
    const r = spawnSync(process.execPath, [BIN, 'run', proj, '-'], { encoding: 'utf8', input: 'sound new piped\n' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('applied 1 command as group g1');
  });
});
