// Measuring a song: each channel is analysed once, in this process or a later one, and an edit measures only what it touched.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { songChecksText, songNumbersText } from '../src/index.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
beforeEach(() => { f = fixture(); run(SONG); });
afterEach(() => f.clean());

const SONG = `song new big tempo=120 key=C:major
song channel add big lead inst=square_lead layer=base
song channel add big bass inst=triangle_bass layer=base
song channel add big harp inst=pluck layer=tension
song channel add big drums kit=default layer=tension
pattern big.a steps=16 tpb=4
  lead: C5 . E5 . G5 - - . A4 . . . G4 . E4 .
  bass: C3 . . . C3 . . . A2 . . . G2 . . .
  harp: C4 . E4 . G4 . E4 . C4 . E4 . G4 . E4 .
  drums: k . h . s . h . k k h . s . h h
pattern big.b steps=16 tpb=4
  lead: D5 . F5 . A5 - - . G4 . . . F4 . D4 .
  bass: D3 . . . D3 . . . G2 . . . A2 . . .
  harp: D4 . F4 . A4 . F4 . D4 . F4 . A4 . F4 .
  drums: k . h . s . h . k k h . s . h h
song section add big A a b x2
`;
const run = (cmds: string) => { const r = f.w.run({ commands: cmds, by: 'agent:claude' }); if (!r.ok) throw new Error(r.errors.map((e) => `${e.line}: ${e.message}`).join('; ')); return r; };

describe('measuring a song', () => {
  it('measures every channel once and a later process measures nothing it has measured', () => {
    const first = songNumbersText(f.w, 'big') + songChecksText(f.w, 'big').text;
    const m1 = f.w.bench.memo;
    expect(m1.misses).toBeGreaterThan(8);
    const again = f.reopen();
    const second = songNumbersText(again, 'big') + songChecksText(again, 'big').text;
    expect(second).toBe(first);
    expect(again.bench.memo.misses).toBe(0);
    expect(again.bench.memo.hits).toBeGreaterThan(8);
  });
  it('an edit to one channel measures that channel and the mix, not the others', () => {
    songChecksText(f.w, 'big');
    const w = f.reopen();
    songChecksText(w, 'big');
    expect(w.bench.memo.misses).toBe(0);
    const r = w.run({ commands: 'pattern note add big.a harp 1 D4', by: 'agent:claude' });
    expect(r.ok).toBe(true);
    const before = w.bench.memo.misses;
    const after = songChecksText(w, 'big');
    const misses = w.bench.memo.misses - before;
    // the harp: match, bands, level; the mix: numbers, seam, layers
    expect(misses).toBeLessThanOrEqual(7);
    expect(after.text).toMatch(/render-match/);
    // the same document, measured by a Writer with no memory of it, gives the same text
    const cold = f.reopen();
    expect(songChecksText(cold, 'big').text).toBe(after.text);
  });
  it('a kept measurement is the same as a fresh one, silent channels included', () => {
    run('song channel add big mute inst=square_lead gain=0\npattern big.c steps=16 tpb=4\n  lead: C5 . . . . . . . . . . . . . . .\n  bass: C3 . . . . . . . . . . . . . . .\n  harp: C4 . . . . . . . . . . . . . . .\n  drums: k . . . . . . . . . . . . . . .\n  mute: C5 . . . . . . . . . . . . . . .\nsong section add big B c');
    const fresh = songNumbersText(f.w, 'big');
    expect(fresh).toMatch(/mute\s+-inf LUFS/);
    const kept = songNumbersText(f.reopen(), 'big');
    expect(kept).toBe(fresh);
  });
});
