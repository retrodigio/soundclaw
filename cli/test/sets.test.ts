// Sets, families and loops through the CLI: the example script (a footstep set of six, far and muffled
// versions of an impact, a rain bed), the set and loop views, check on a set, export --all / --set / --pack
// to a folder in OGG or WAV with a manifest, import of jsfxr and bfxr strings, and --help.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type Io } from '../src/main.ts';

let tmp: string;
let proj: string;
let clock = 0;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'soundclaw-cli-sets-'));
  proj = join(tmp, 'demo.sclaw');
  clock = 0;
  sc(['new', proj]);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function sc(args: string[], stdin = ''): { code: number; out: string; err: string } {
  let out = '', err = '';
  const io: Io = { out: (s) => { out += s; }, err: (s) => { err += s; }, stdin: () => stdin, now: () => `2026-11-06T10:00:${String(clock++ % 60).padStart(2, '0')}Z` };
  return { code: main(args, io), out, err };
}
const EXAMPLE = join(import.meta.dirname, '..', '..', 'docs', 'examples', 'sets-demo.txt');

describe('the example script', () => {
  it('makes a footstep set of six, far and muffled versions of an impact, and a rain bed; the set and the bed pass their checks', () => {
    const r = sc(['run', proj, EXAMPLE]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/set footsteps: 6 members/);
    const c = sc(['check', proj, 'footsteps', 'rain', 'impact_far', 'impact_muffled', 'impact']);
    expect(c.code, c.out).toBe(0);
    expect(c.out).toMatch(/set footsteps: PASS/);
    expect(c.out).toMatch(/click\s+pass .*loop seam/);
    expect(c.out).toMatch(/4 sounds of 4 pass/);
    expect(c.out).toMatch(/1 set of 1 pass set-spread/);
    const list = sc(['list', proj]).out;
    expect(list).toMatch(/\d+ sounds:/);
    expect(list).toMatch(/1 set:\n\s+set footsteps/);
  });
});

describe('views and check', () => {
  beforeEach(() => { sc(['run', proj, EXAMPLE]); });
  it('draws the set view and the loop view as PNG files', () => {
    const out = join(tmp, 'set.png');
    const s = sc(['view', proj, 'footsteps', 'set', '--out', out]);
    expect(s.code, s.err).toBe(0);
    expect([...readFileSync(out).subarray(0, 4)]).toEqual([137, 80, 78, 71]);
    expect(s.out).toMatch(/distance matrix \(dB\):/);
    const lp = join(tmp, 'loop.png');
    const l = sc(['view', proj, 'rain', 'loop', '--out', lp]);
    expect(l.code, l.err).toBe(0);
    expect(l.out).toMatch(/loop: [\d.]+ s, crossfade/);
    expect(sc(['view', proj, 'impact', 'loop']).code).toBe(1);
    expect(sc(['view', proj, 'footsteps', 'wave', '--out', join(tmp, 'x.png')]).err).toMatch(/no sound 'footsteps'/);
  });
  it('check exits 1 for a set that fails, with the member and the reason', () => {
    sc(['run', proj, '-e', 'sound set footsteps_2 gain=0.05']);
    const c = sc(['check', proj, 'footsteps']);
    expect(c.code).toBe(1);
    expect(c.out).toMatch(/footsteps_2 is -\d+\.\d LUFS/);
  });
});

describe('export', () => {
  beforeEach(() => { sc(['run', proj, EXAMPLE]); });
  it('--all --format ogg --to writes Vorbis files and a manifest', () => {
    const out = join(tmp, 'ogg');
    const r = sc(['export', proj, '--all', '--format', 'ogg', '--to', out]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/exported \d+ sounds as ogg/);
    expect(readdirSync(out).sort()).toContain('manifest.json');
    expect(readdirSync(out).filter((f) => f.endsWith('.ogg')).length).toBe(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).sounds.length);
    expect(readFileSync(join(out, 'rain.ogg')).subarray(0, 4).toString()).toBe('OggS');
  });
  it('--set exports a set\'s members as WAV, with a manifest; --pack keeps a flat folder', () => {
    const out = join(tmp, 'set');
    const r = sc(['export', proj, '--set', 'footsteps', '--to', out]);
    expect(r.code, r.err).toBe(0);
    expect(readdirSync(out).sort()).toEqual(['footsteps_1.wav', 'footsteps_2.wav', 'footsteps_3.wav', 'footsteps_4.wav', 'footsteps_5.wav', 'footsteps_6.wav', 'manifest.json']);
    const pack = join(tmp, 'pack');
    expect(sc(['export', proj, '--pack', '--to', pack]).code).toBe(0);
    expect(readdirSync(pack).some((f) => f.endsWith('.wav'))).toBe(true);
    expect(JSON.parse(readFileSync(join(pack, 'manifest.json'), 'utf8')).sounds.length).toBeGreaterThan(6);
  });
  it('refuses nonsense: --all with names, --to with --out, a bad quality or format', () => {
    expect(sc(['export', proj, '--all', 'rain']).err).toMatch(/--all is every sound/);
    expect(sc(['export', proj, '--to', tmp, '--out', tmp]).err).toMatch(/--to or --out, not both/);
    expect(sc(['export', proj, '--format', 'ogg', '--quality', '3']).err).toMatch(/--quality is a number from -0\.1 to 1/);
    expect(sc(['export', proj, '--format', 'mp3']).err).toMatch(/--format is wav, ogg, patch, csv/);
  });
});

describe('import', () => {
  const SQUARE = '11111Fc13SajJH62jNe2k3ctPhzkXNYtK16FBV33LAVw7Df46Vas3d7M1XjJEWdoMSJ2cF9JijnogukyoRpEWtFPfVTJHMezGnkBy9Bz8GwwGvnprF9iQFDh';
  it('imports a jsfxr string and a bfxr string, reporting each row', () => {
    const a = sc(['import', proj, 'jsfxr', `https://sfxr.me/#${SQUARE}`, '--id', 'zap']);
    expect(a.code, a.err).toBe(0);
    expect(a.out).toMatch(/imported 1 sound \(zap\)/);
    expect(a.out).toMatch(/row 1 zap: exact \(jsfxr base58\)/);
    const file = join(tmp, 'bfxr.txt');
    writeFileSync(file, '# two\nbuzz 2,0.5,,0.3,,0.4,0.3,0.3,,,,,,,,,,,,,,,,,,1,,,,,,\nclean 0,0.6,,0.3,,0.4,,0.4,,,,,,,,,,,,,,,,,,1,,,,,,\n');
    const b = sc(['import', proj, 'bfxr', file]);
    expect(b.code, b.err).toBe(0);
    expect(b.out).toMatch(/row 1 buzz: approximated \(bfxr\)/);
    expect(b.out).toMatch(/row 2 clean: exact \(bfxr\)/);
    expect(sc(['list', proj]).out).toMatch(/buzz: classic/);
  });
  it('reports a row that cannot be read and imports nothing', () => {
    const r = sc(['import', proj, 'bfxr', '1,2,3', '--id', 'x']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not a Bfxr string/);
    expect(existsSync(join(proj, 'sounds', 'x.sfx'))).toBe(false);
    expect(sc(['import', proj, 'zfxr', 'x']).code).toBe(2);
  });
});

describe('help', () => {
  it('describes sets, family, loop, ogg and the import kinds', () => {
    const h = sc(['--help']).out;
    for (const w of ['set new <set> from=<sound> count=<n>', 'family <sound> near|far|muffled', 'sound loop <id>', '--format wav|ogg|patch|csv', 'sfxr|jsfxr|bfxr', 'view <project> <set> set', 'view <project> <id> loop']) expect(h, w).toContain(w);
    expect(sc(['export', '--help']).out).toContain('--pack');
  });
});
