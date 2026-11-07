// The layered voice through the CLI: the example script, sample import and list, the layers view,
// describe and check on layered sounds, export (WAV only, with its note), and --help.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeWav, encodeWav } from '@soundclaw/core';
import { main, type Io } from '../src/main.ts';

let tmp: string;
let proj: string;
let clock = 0;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'soundclaw-cli-layered-'));
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
const DEMO = join(import.meta.dirname, '..', '..', 'docs', 'examples', 'layered-demo.txt');

describe('the example script', () => {
  it('builds an impact, a sparkle and a creak, and all three pass every check', () => {
    const r = sc(['run', proj, DEMO]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/impact: layered 3 layers \[1 osc sine \(pitch envelope\); 2 osc brown; 3 osc square 3200 Hz\], master distort\+reverb\+limit → \d+ samples/);
    expect(r.out).toMatch(/sparkle: layered 5 layers .*, master delay\+reverb, stereo → \d+ samples × 2 channels/);
    const c = sc(['check', proj]);
    expect(c.code).toBe(0);
    expect(c.out).toContain('3 sounds of 3 pass all of clip, loudness, dc, click, tail, harsh');
    const d = sc(['describe', proj, 'sparkle']);
    expect(d.out).toMatch(/^sparkle: \d\.\d\d s, stereo, /);
    expect(d.out).toContain('2 channels: stereo');
    expect(d.out.trim().split('\n').at(-1)).toBe('checks: 6/6 pass');
  });
});

describe('samples', () => {
  it('sample import copies a WAV, as=<name> names it, list shows it, a sample layer uses it', () => {
    const file = join(tmp, 'My Click.wav');
    writeFileSync(file, encodeWav(Float32Array.from({ length: 2000 }, (_, i) => Math.sin(i * 0.2) * (1 - i / 2000)), 22050));
    const a = sc(['sample', 'import', proj, file]);
    expect(a.code, a.err).toBe(0);
    expect(a.out).toMatch(/^imported sample My_Click: 0\.091 s, 22050 Hz, mono\n  resampled 22050 -> 44100 Hz with a Blackman-windowed sinc.*\nsha256 [0-9a-f]{12}/);
    expect(existsSync(join(proj, 'samples', 'My_Click.wav'))).toBe(true);
    expect(sc(['sample', 'import', proj, file, 'as=tick']).out).toContain('sample tick:');
    expect(sc(['sample', 'import', proj, file, '--as', 'tock']).out).toContain('sample tock:');
    expect(sc(['sample', 'import', proj, file, 'as=tick']).out).toMatch(/^already in the project: sample tick/);
    expect(sc(['sample', 'list', proj]).out).toMatch(/^My_Click: 0\.091 s, 22050 Hz, mono, \d+ bytes, sha256 [0-9a-f]{12}\ntick:/);
    const r = sc(['run', proj, '-e', 'sound new s voice=layered; layer add s sample sample=tick pitch=7; layer add s sample sample=nope']);
    expect(r.code).toBe(1);
    expect(r.err).toContain("names sample 'nope', which is not in the project");
    const ok = sc(['run', proj, '-e', 'sound new s voice=layered; layer add s sample sample=tick pitch=7']);
    expect(ok.code, ok.err).toBe(0);
    expect(sc(['sample', 'import', proj, join(tmp, 'missing.wav')]).code).toBe(1);
    expect(sc(['sample', 'frob', proj]).code).toBe(2);
    expect(sc(['sample', 'list', join(tmp, 'x')]).code).toBe(1);
  });
});

describe('views and export', () => {
  beforeEach(() => { expect(sc(['run', proj, DEMO]).code).toBe(0); });
  it('view layers writes a PNG and says how many layers sound; the other views work on layered sounds', () => {
    const out = join(tmp, 'l.png');
    const v = sc(['view', proj, 'sparkle', 'layers', '--out', out]);
    expect(v.code, v.err).toBe(0);
    expect(v.out).toMatch(/^layers view saved to /);
    expect(v.out).toContain('layers: 5 sounding');
    expect(v.out).toContain('stereo');
    expect(readFileSync(out).length).toBeGreaterThan(2000);
    expect(sc(['view', proj, 'impact', 'wave', '--out', join(tmp, 'w.png')]).code).toBe(0);
    expect(sc(['view', proj, 'creak', 'frob']).code).toBe(2);
    const c = sc(['run', proj, '-e', 'sound new plain voice=classic']);
    expect(c.code).toBe(0);
    expect(sc(['view', proj, 'plain', 'layers']).err).toMatch(/layers view is for layered sounds/);
  });
  it('export writes a WAV and says it is WAV only; stereo has two channels; csv skips layered sounds', () => {
    const out = join(tmp, 'out');
    const e = sc(['export', proj, 'sparkle', 'impact', '--out', out]);
    expect(e.code, e.err).toBe(0);
    expect(e.out).toMatch(/note: sparkle: layered sound, exported as WAV only \(stereo, 16-bit, 44,100 Hz\)/);
    expect(e.out).toMatch(/note: impact: layered sound, exported as WAV only \(mono/);
    expect(decodeWav(new Uint8Array(readFileSync(join(out, 'sparkle.wav')))).channels).toBe(2);
    expect(decodeWav(new Uint8Array(readFileSync(join(out, 'impact.wav')))).channels).toBe(1);
    sc(['run', proj, '-e', 'sound new plain voice=classic preset=blip seed=1']);
    const csv = sc(['export', proj, '--format', 'csv', '--out', out]);
    expect(csv.out).toContain('note: skipped impact (layered: WAV only)');
    expect(readFileSync(join(out, 'synth.csv'), 'utf8')).toMatch(/plain/);
    const bad = sc(['export', proj, 'impact', '--format', 'patch', '--out', out]);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/layered sound exports as WAV only/);
  });
  it('the usage and --help list the layered commands, and the view and sample commands', () => {
    const h = sc(['run', '--help']).out;
    for (const w of ['sound new <id> voice=layered', 'sound layer-up <id>', 'sound classic <id> on|off', 'layer add <id>', 'env <id> <target>', 'fx add <id> [layer=<n>]']) expect(h, w).toContain(w);
    expect(sc(['view', '--help']).out).toContain('view <project> <id> layers');
    expect(sc(['sample', '--help']).out).toContain('sample import <project> <file.wav | folder> [as=<name>]');
    expect(sc(['check', '--help']).out).toContain('harsh');
  });
});
