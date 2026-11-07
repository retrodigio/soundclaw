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
    expect(r.err).toBe("<-e>:2:13: error: frequency must be between 20 and 20000 Hz (got 1)\n<-e>:3:7: error: unknown sound command 'frob' (new, set, patch, generate, mutate, mark, layer-up, classic, loop, copy, rename, remove)\n2 errors; nothing was applied.\n");
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
    expect(r[2]).toMatch(/^ {4}checks: \d\/6 pass/);
    expect(r[3]).toMatch(/^ {2}boop: tone 220 Hz/);
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
    expect(sc(['render', proj, 'beep']).out).toMatch(/\(from the render cache\)\n/);
    rmSync(join(proj, '.cache'), { recursive: true });
    expect(sc(['render', proj, 'beep']).out).toMatch(/render key [0-9a-f]{12}\n/);
    const again = sc(['render', proj, 'beep']).out;
    expect(again).toMatch(/\(from the render cache\)\n/);
    // the numbers, then a description, and the check summary is the last line
    expect(again).toMatch(/duration 0\.500 s \(22050 samples\)\nloudness /);
    expect(again.trim().split('\n').at(-1)).toMatch(/^checks: \d\/6 pass/);
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

describe('changes and tagged requests', () => {
  beforeEach(() => {
    sc(['new', proj]);
    sc(['run', proj, '-e', 'sound new beep voice=classic preset=pickup seed=3; sound new boop voice=classic preset=laser seed=2']);
  });
  it('changes says what a person did since the agent last looked, then nothing; --peek and --since leave the cursor', () => {
    expect(sc(['changes', proj]).out).toMatch(/^no changes by anyone but agent:claude since #0 \(your cursor is now #\d+\)/);
    sc(['run', proj, '-e', 'sound set beep freq=0.7', '--by', 'human:ana']);
    const peek = sc(['changes', proj, '--by', 'human', '--peek']);
    expect(peek.out).toMatch(/^1 change by people since #\d+:/);
    expect(peek.out).toContain('sound set beep freq=0.7');
    expect(peek.out).toMatch(/freq 0\.\d+ → 0\.7/);
    expect(peek.out).toMatch(/compare view \(before above, after below\): \S+change-g2-beep\.png/);
    const png = /: (\S+change-g2-beep\.png)/.exec(peek.out)![1]!;
    expect(readFileSync(png).subarray(1, 4).toString()).toBe('PNG');
    expect(sc(['changes', proj, '--since', '0', '--by', 'agent']).out).toMatch(/^1 change by agent since #0:/);
    expect(sc(['changes', proj]).out).toMatch(/^1 change by anyone but agent:claude since #2/);
    expect(sc(['changes', proj]).out).toMatch(/^no changes/);
    expect(sc(['changes', proj, '--as', 'other', '--by', 'human:ana']).out).toMatch(/^1 change by human:ana/);
    expect(sc(['changes', proj, '--by', 'robot']).err).toMatch(/--by is human, agent/);
    expect(sc(['changes']).code).toBe(2);
  });
  it('request --tag files the tags a card sends; --like names the other sound; the list shows them', () => {
    const r = sc(['request', proj, 'beep', '--tag', 'too loud', '--tag', 'too similar to another sound', '--like', 'boop', '--by', 'ana']);
    expect(r.out).toMatch(/^r1 change beep \[too loud, too similar to another sound\] \(like boop\) \(from human:ana/);
    expect(sc(['request', proj, 'beep', '--tag', 'good', '--by', 'ana']).out).toMatch(/^r2 feedback beep \[good\]/);
    expect(sc(['request', proj, 'beep', '--tag', 'too purple']).err).toMatch(/no tag/);
    expect(sc(['history', proj]).out).toContain('sound mark beep rejected "too loud, too similar to boop"');
  });
  it('import warns about a repeated id and keeps the engine\'s rule', () => {
    const csv = join(tmp, 'synth.csv');
    writeFileSync(csv, 'id,freq\nzip,0.2\nzap,0.3\nzip,0.6\n');
    const r = sc(['import', proj, 'sfxr', csv]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("warning: synth.csv: 'zip' is on line 2 and again on line 4");
    expect(r.out).toContain('imported 2 sounds (zip, zap)');
    expect(sc(['list', proj]).out).toContain('zip: classic freq=0.6');
  });
});

describe('request, reply, cancel and work without a server', () => {
  beforeEach(() => {
    sc(['new', proj]);
    sc(['run', proj, '-e', 'sound new beep voice=classic; sound set beep wave=sine attack=0.05 sustain=0.3 decay=0.4 freq=0.3 volume=0.15']);
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

describe('the classic voice, the ears, import and export', () => {
  const GOOD = 'sound new beep voice=classic; sound set beep wave=sine attack=0.05 sustain=0.3 decay=0.4 freq=0.3 volume=0.15';
  beforeEach(() => {
    sc(['new', proj]);
    expect(sc(['run', proj, '-e', `${GOOD}; sound new zap voice=classic preset=laser seed=1`]).code).toBe(0);
  });

  it('run prints the classic sound and its check summary', () => {
    const r = sc(['run', proj, '-e', 'sound new hit voice=classic preset=hit seed=4; sound mutate hit amount=0.1 seed=5 as=hit2']);
    expect(r.out).toContain('#4 sound new hit voice=classic preset=hit seed=4');
    expect(r.out).toContain('#5 sound mutate hit amount=0.1 seed=5 as=hit2');
    expect(r.out).toMatch(/\nhit: classic wave=\w+ .* → \d+ samples, peak [\d.]+, rms [\d.]+, hash [0-9a-f]{12}\n {4}checks: \d\/6 pass/);
    expect(r.out).toContain('hit2: classic');
  });

  it('render ends with the check summary; describe says it in words', () => {
    const r = sc(['render', proj, 'zap']);
    expect(r.out.trim().split('\n').at(-1)).toMatch(/^checks: \d\/6 pass; failing: /);
    const d = sc(['describe', proj, 'beep']);
    expect(d.code).toBe(0);
    expect(d.out).toMatch(/^beep: 0\.\d\d s, tonal and /);
    expect(d.out.trim().split('\n').at(-1)).toBe('checks: 6/6 pass');
    expect(sc(['describe', proj, 'nope']).err).toMatch(/no sound 'nope'/);
  });

  it('check exits 0 when everything passes and 1 when something fails, listing where', () => {
    const ok = sc(['check', proj, 'beep']);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/^beep: PASS \(6\/6 checks pass\)/);
    const bad = sc(['check', proj]);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/^zap: FAIL/m);
    expect(bad.out).toMatch(/flagged 0\.0000-0\.0010 s: starts at level/);
    expect(bad.out).toMatch(/1 sound of 2 pass all of clip, loudness, dc, click, tail, harsh/);
  });

  it('view writes a PNG (under .cache/views, or --out) and prints the numbers', () => {
    const w = sc(['view', proj, 'zap', 'wave']);
    expect(w.code).toBe(0);
    const file = /view saved to (\S+)/.exec(w.out)![1]!;
    expect(file).toContain(join(proj, '.cache', 'views'));
    expect(Array.from(readFileSync(file).subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);
    expect(w.out).toContain('duration 0.');
    const out = join(tmp, 'spec.png');
    expect(sc(['view', proj, 'zap', 'spec', '--out', out]).code).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(sc(['view', proj, 'zap', 'pitch']).code).toBe(0);
    const c = sc(['view', proj, 'beep', 'compare', 'zap']);
    expect(c.out).toMatch(/zap compared with beep/);
    expect(sc(['view', proj, 'beep', 'compare']).err).toMatch(/give the other sound/);
    expect(sc(['view', proj, 'beep', 'bogus']).err).toMatch(/no view 'bogus'/);
    expect(sc(['view', proj, 'beep']).code).toBe(2);
  });

  it('export --format wav|patch|csv; the wav is the pre-rendered form', () => {
    const wav = sc(['export', proj, 'beep', '--out', join(tmp, 'o')]);
    expect(wav.out).toContain('as wav');
    expect(decodeWav(new Uint8Array(readFileSync(join(tmp, 'o', 'beep.wav')))).sampleRate).toBe(44100);
    expect(sc(['export', proj, '--format', 'patch', '--out', join(tmp, 'p')]).out).toContain('as patch');
    expect(readdirSync(join(tmp, 'p')).sort()).toEqual(['beep.sfxr', 'zap.sfxr']);
    expect(sc(['export', proj, '--format', 'csv', '--out', join(tmp, 'c')]).out).toContain('as csv');
    expect(readFileSync(join(tmp, 'c', 'synth.csv'), 'utf8').split('\n')[0]).toMatch(/^id,wave,attack,sustain,punch,decay,freq,minFreq/);
    expect(sc(['export', proj, '--format', 'mp3']).code).toBe(2);
  });

  it('import sfxr reads a csv exported by export, a patch file, or patch text; one undo group', () => {
    sc(['export', proj, '--format', 'csv', '--out', join(tmp, 'c')]);
    const other = join(tmp, 'other.sclaw');
    sc(['new', other]);
    const r = sc(['import', other, 'sfxr', join(tmp, 'c', 'synth.csv')]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^imported 2 sounds \(beep, zap\) as group g1/);
    // the same samples, hash for hash
    const hashOf = (dir: string, id: string) => /hash ([0-9a-f]{12})/.exec(sc(['list', dir]).out.split('\n').find((l) => l.includes(`${id}: classic`))!)![1];
    expect(hashOf(other, 'zap')).toBe(hashOf(proj, 'zap'));
    expect(hashOf(other, 'beep')).toBe(hashOf(proj, 'beep'));
    const text = sc(['import', other, 'sfxr', '1\n2,0,0.1,0,0.3,0.5', '--id', 'tick']);
    expect(text.err).toBe('');
    expect(text.out).toContain('imported 1 sound (tick)');
    expect(sc(['import', other, 'sfxr', 'wave=1,freq=0.4']).err).toMatch(/needs a sound id/);
    expect(sc(['import', other, 'sfxr', join(tmp, 'c', 'synth.csv')]).err).toMatch(/exists already/);
    expect(sc(['import', other, 'wav', 'x']).code).toBe(2);
  });
});
