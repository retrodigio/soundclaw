// export: --loops with --loop and with stems, refused combinations, stems through the master chain's filters.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeWav } from '@soundclaw/core';
import { exportSong, formatSongExport } from '../src/index.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
beforeEach(() => { f = fixture(); run(SONG); });
afterEach(() => f.clean());

const SONG = `song new demo tempo=120 key=C:major class=music
song channel add demo lead inst=square_lead gain=0.8 layer=tension
song channel add demo bass inst=triangle_bass layer=base
song channel add demo drums kit=default layer=base
pattern demo.verse steps=16 tpb=4 bar=8
  lead: C5 . E5 . G5 - - . | A4 . . . G4 . E4 .
  bass: C3 . . . C3 . . . | A2 . . . G2 . . .
  drums: k . h . s . h . | k k h . s . h h
song section add demo A verse x2
`;
const run = (cmds: string) => { const r = f.w.run({ commands: cmds, by: 'agent:claude' }); if (!r.ok) throw new Error(r.errors.map((e) => `${e.line}: ${e.message}`).join('; ')); return r; };
const wav = (file: string) => decodeWav(new Uint8Array(readFileSync(file)));

describe('export --loops', () => {
  it('--loop --loops 3 is the loop three times over, end to end', () => {
    const one = exportSong(f.w, 'demo', { format: 'wav', loop: true, out: join(f.root, 'a') })[0]!;
    const three = exportSong(f.w, 'demo', { format: 'wav', loop: true, loops: 3, out: join(f.root, 'b') })[0]!;
    const a = wav(one.file), b = wav(three.file);
    expect(b.frames).toBe(3 * a.frames);
    expect(three.kind).toBe('loop x3');
    for (const k of [0, 1, 2]) for (const i of [0, 12345, a.frames - 1]) expect(b.data[2 * (k * a.frames + i)]).toBe(a.data[2 * i]);
  });
  it('stems take --loops too, and stay aligned', () => {
    const files = exportSong(f.w, 'demo', { format: 'wav', stems: true, loops: 2, out: join(f.root, 'c') });
    const frames = files.map((x) => wav(x.file).frames);
    expect(frames).toEqual([8 * 44100, 8 * 44100]);
    expect(files[0]!.kind).toMatch(/x2/);
  });
  it('--loops with a full export repeats the loop region, as before', () => {
    const [file] = exportSong(f.w, 'demo', { format: 'wav', loops: 2, out: join(f.root, 'd') });
    expect(wav(file!.file).frames).toBeGreaterThanOrEqual(8 * 44100);
  });
  it('--loops where there is no loop to repeat is refused, not ignored', () => {
    run('song loop demo off');
    expect(() => exportSong(f.w, 'demo', { format: 'wav', loops: 2, out: join(f.root, 'e') })).toThrow(/no loop region, so --loops 2 has nothing to repeat/);
    expect(() => exportSong(f.w, 'demo', { format: 'wav', stems: true, loops: 2, out: join(f.root, 'e') })).toThrow(/no loop region/);
    expect(() => exportSong(f.w, 'demo', { format: 'wav', loop: true, out: join(f.root, 'e') })).toThrow(/no loop region/);
    expect(exportSong(f.w, 'demo', { format: 'wav', loops: 1, out: join(f.root, 'e') })).toHaveLength(1);
  });
});

describe('export refuses what means nothing', () => {
  const out = () => join(f.root, 'x');
  it('midi takes no audio options; audio takes no pattern; quality is for ogg; the flag that needs another says so', () => {
    for (const [o, re] of [
      [{ format: 'midi', loop: true }, /--loop is for wav and ogg/],
      [{ format: 'midi', stems: true }, /--stems is for wav and ogg/],
      [{ format: 'midi', loops: 2 }, /--loops is for wav and ogg/],
      [{ format: 'midi', quality: 0.5 }, /--quality is for wav and ogg/],
      [{ format: 'wav', pattern: 'verse' }, /--pattern is for --format midi/],
      [{ format: 'wav', quality: 0.5 }, /--quality is for --format ogg/],
      [{ format: 'wav', stemsThroughMaster: true }, /goes with --stems/],
      [{ format: 'wav', loops: 0 }, /--loops is a whole number from 1 to 16/],
      [{ format: 'wav', loops: 99 }, /--loops is a whole number from 1 to 16/],
    ] as const) expect(() => exportSong(f.w, 'demo', { ...o, out: out() }), JSON.stringify(o)).toThrow(re);
    // nothing was written by the refused ones
    expect(() => readFileSync(join(out(), 'demo.wav'))).toThrow();
  });
});

describe('stems through the master chain', () => {
  const ready = () => run('song fx remove demo 1\nsong fx add demo filter type=lp cutoff=600\nsong set demo gain=0.4');
  it('the master filter reaches the stems, and the stems sum to the mix', () => {
    ready();
    const plain = exportSong(f.w, 'demo', { format: 'wav', stems: true, out: join(f.root, 'p') });
    const through = exportSong(f.w, 'demo', { format: 'wav', stems: true, stemsThroughMaster: true, out: join(f.root, 't') });
    const [mix] = exportSong(f.w, 'demo', { format: 'wav', loop: true, out: join(f.root, 'm') });
    const m = wav(mix!.file);
    const sum = (files: typeof plain): number => {
      const st = files.map((x) => wav(x.file));
      let worst = 0;
      for (let i = 0; i < m.data.length; i++) worst = Math.max(worst, Math.abs(st.reduce((s, x) => s + x.data[i]!, 0) - m.data[i]!));
      return worst;
    };
    expect(sum(through)).toBeLessThanOrEqual(4);
    expect(sum(plain)).toBeGreaterThan(200);
    expect(through[0]!.kind).toMatch(/through the master filters/);
    expect(formatSongExport(through)).toMatch(/note: stems through the master chain: applied filter type=lp cutoff=600/);
    expect(formatSongExport(through)).toMatch(/the stems sum to the mix$/);
  });
  it('a compressor and limiter are not applied, and the notes and the manifest say so', () => {
    run('song fx add demo filter type=hp cutoff=200\nsong fx add demo compress threshold=-30 ratio=4');
    const files = exportSong(f.w, 'demo', { format: 'wav', stems: true, stemsThroughMaster: true, out: join(f.root, 'q') });
    const text = formatSongExport(files);
    expect(text).toMatch(/not applied: limit: a limiter follows the level of the whole mix/);
    expect(text).toMatch(/not applied: compress: a compressor follows the level of the whole mix/);
    expect(text).toMatch(/louder than the exported mix, and not limited/);
    const man = JSON.parse(readFileSync(join(f.root, 'q', 'demo-manifest.json'), 'utf8'));
    expect(man.stems).toEqual({ throughMaster: true, applied: ['filter'], notApplied: ['limit', 'compress'] });
    // without the option the stems are what they were: the manifest says they are not through the chain
    exportSong(f.w, 'demo', { format: 'wav', stems: true, out: join(f.root, 'r') });
    expect(JSON.parse(readFileSync(join(f.root, 'r', 'demo-manifest.json'), 'utf8')).stems.throughMaster).toBe(false);
  });
});
