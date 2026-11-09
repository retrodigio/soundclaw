// Through the CLI: export flags, stems through the master chain, normalize in a run, a send bus, view compare with a file.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeWav, encodeWavChannels } from '@soundclaw/core';
import { main, USAGE, type Io } from '../src/main.ts';

let tmp: string;
let proj: string;
let clock = 0;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'soundclaw-cli-s6b-'));
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

const SONG = `song new demo tempo=120 key=C:major class=music
song channel add demo lead inst=square_lead gain=0.5 layer=tension
song channel add demo bass inst=triangle_bass gain=0.5 layer=base
pattern demo.verse steps=16 tpb=4
  lead: C5 . E5 . G5 - - . A4 . . . G4 . E4 .
  bass: C3 . . . C3 . . . A2 . . . G2 . . .
song section add demo A verse x2
sound new tone voice=layered
layer add tone osc freq=440 dur=0.4
`;

describe('export through the CLI', () => {
  beforeEach(() => { expect(sc(['run', proj, '-e', SONG]).code).toBe(0); });

  it('--loop --loops 2 writes the loop twice; the output says so', () => {
    const out = join(tmp, 'x');
    const r = sc(['export', proj, 'demo', '--loop', '--loops', '2', '--to', out]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/demo-loop\.wav  loop x2, 8 s/);
    expect(decodeWav(new Uint8Array(readFileSync(join(out, 'demo-loop.wav')))).frames).toBe(8 * 44100);
  });
  it('refuses what means nothing, with exit 2 and the reason', () => {
    for (const [args, re] of [
      [['demo', '--format', 'midi', '--loop'], /--loop is for wav and ogg/],
      [['demo', '--pattern', 'verse'], /--pattern is for --format midi/],
      [['demo', '--quality', '0.5'], /--quality is for --format ogg/],
      [['demo', '--stems-through-master'], /goes with --stems/],
      [['demo', '--all'], /--all is for sounds/],
      [['demo', '--set', 'x'], /--set is for sounds/],
      [['demo', 'tone'], /demo is a song and tone is not: export songs and sounds in separate commands/],
      [['tone', '--loop'], /--loop is for songs/],
      [['tone', '--loops', '2'], /--loops is for songs/],
      [['demo', '--to', 'a', '--out', 'b'], /give --to or --out, not both/],
      [['demo', '--loops', '0'], /--loops is a whole number from 1 to 16/],
    ] as const) {
      const r = sc(['export', proj, ...args]);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err, args.join(' ')).toMatch(re);
    }
    // a song with no loop region: --loops has nothing to repeat
    sc(['run', proj, '-e', 'song loop demo off']);
    const r = sc(['export', proj, 'demo', '--loops', '3']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no loop region, so --loops 3 has nothing to repeat/);
  });
  it('--stems-through-master says what it applied and what it could not', () => {
    sc(['run', proj, '-e', 'song fx add demo filter type=lp cutoff=900']);
    const r = sc(['export', proj, 'demo', '--stems', '--stems-through-master', '--to', join(tmp, 's')]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/demo-stem-tension\.wav  stem tension \(loop, through the master filters\)/);
    expect(r.out).toMatch(/note: stems through the master chain: applied filter type=lp cutoff=900/);
    expect(r.out).toMatch(/note: not applied: limit: a limiter follows the level of the whole mix/);
    expect(r.out).toMatch(/louder than the exported mix, and not limited/);
  });
});

describe('a send bus, normalize in a run, and view compare with a file', () => {
  it('song send and a channel send, then a run with normalize in it', () => {
    const r = sc(['run', proj, '-e', `${SONG}song send demo reverb size=0.5\nsong channel set demo lead reverb=0.4\nnormalize demo\n`]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/song send demo reverb size=0.5/);
    expect(r.out).toMatch(/song channel set demo lead reverb=0.4/);
    expect(r.out).toMatch(/song set demo gain=/);
    expect(r.out).not.toMatch(/\bnormalize demo/);
    const h = sc(['history', proj]);
    expect(h.out).toMatch(/song send demo reverb size=0\.5/);
  });
  it('view compare takes a file for either side', () => {
    sc(['run', proj, '-e', SONG]);
    const ref = join(tmp, 'ref.wav');
    const x = new Float32Array(44100);
    for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / 44100);
    writeFileSync(ref, encodeWavChannels([x]));
    const out = join(tmp, 'c.png');
    const r = sc(['view', proj, 'tone', 'compare', ref, '--out', out]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/ref\.wav: mono, 44100 Hz, 1\.00 s/);
    const r2 = sc(['view', proj, ref, 'compare', 'demo', '--out', out]);
    expect(r2.code, r2.err).toBe(0);
    expect(r2.out).toMatch(/demo: the song's full mix, mono/);
    const bad = sc(['view', proj, 'tone', 'compare', join(tmp, 'nope.wav')]);
    expect(bad.code).not.toBe(0);
    expect(bad.err).toMatch(/no sound, song or audio file/);
  });
  it('the usage names the new flags', () => {
    expect(USAGE).toMatch(/--stems-through-master/);
    expect(USAGE).toMatch(/<id\|file> compare <other\|file>/);
  });
});
