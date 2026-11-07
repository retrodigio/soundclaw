// The checks and views on constructed songs with known faults.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STYLE, arrange, bandMap, loopCheck, lookupInstrument, notesView, mixView, renderMatch, songReport, songPasses, keyCheck, rangeCheck, maskingCheck, withBuiltins, songLoudnessRule,
} from '../src/index.ts';
import { SINE, library, render } from './music-helpers.ts';

const base = (rows: string, extra = '', tempo = 120) => `${SINE}song new s tempo=${tempo} ${extra}\nsong channel add s lead inst=sine\npattern s.p steps=8 tpb=2\n  lead: ${rows}\nsong section add s A p\nsong fx remove s 1\n`;

const report = (script: string, o: { loop?: boolean } = {}) => {
  const lib = library(script);
  const song = lib.songs.get('s')!;
  const inst = (i: string) => lookupInstrument(lib, i);
  const full = render(lib, 's');
  const loop = o.loop === false ? null : arrange(song).loop ? render(lib, 's', { mode: 'loop' }) : null;
  return { lib, song, full, rep: songReport({ song, full, loop, style: DEFAULT_STYLE, instruments: inst }), inst };
};

describe('key', () => {
  it('flags written notes outside the scale, with their time and place, unless marked with !', () => {
    const { song } = report(base('C4 D4 F#4 G4 A4 C5 . .', 'key=C:major'));
    const k = keyCheck(song, arrange(song));
    expect(k.pass).toBe(false);
    expect(k.ranges.length).toBe(1);
    expect(k.ranges[0]!.note).toMatch(/F#4 in lead \(A\/p step 2\) is not in C:major/);
    expect(k.ranges[0]!.from).toBeCloseTo(0.5, 6); // step 2 at 2 steps per beat and 120 bpm
    const marked = report(base('C4 D4 F#4! G4 A4 C5 . .', 'key=C:major'));
    expect(keyCheck(marked.song, arrange(marked.song)).pass).toBe(true);
  });
  it('is skipped when the song has no key', () => {
    const { song } = report(base('C4 D4 F#4 . . . . .'));
    expect(keyCheck(song, arrange(song)).skipped).toBe(true);
  });
});

describe('range', () => {
  it('flags notes outside what an instrument declares', () => {
    const { song, inst } = report(base('C4 . C7 . . . . .').replace('gain=0.5', 'gain=0.5 range=C3-C6'));
    const r = rangeCheck(song, arrange(song), withBuiltins(inst));
    expect(r.pass).toBe(false);
    expect(r.ranges.map((x) => x.note).join()).toMatch(/C7 in lead .* outside sine's range C2-C6|C7 in lead/);
    const ok = report(base('C4 . C5 . . . . .').replace('gain=0.5', 'gain=0.5 range=C3-C6'));
    expect(rangeCheck(ok.song, arrange(ok.song), withBuiltins(ok.inst)).pass).toBe(true);
  });
});

describe('render-match', () => {
  it('passes when the render is what is written: every note on time and at its pitch', () => {
    const { rep } = report(base('A3 . C4 . E4 . A4 .'));
    expect(rep.match.check.pass, JSON.stringify(rep.match.check.ranges)).toBe(true);
    expect(rep.match.notes.length).toBe(4);
    // the onsets were measured, within 20 ms
    for (const n of rep.match.notes) expect(Math.abs(n.onset! - n.t)).toBeLessThan(0.02);
  });

  it('catches an instrument whose root is an octave off: the written pitch is not what sounds', () => {
    const { rep } = report(base('A3 . C4 . E4 . A4 .').replace('gain=0.5', 'gain=0.5 root=A3'));
    // the root says the template sounds at A3, but it is written at 440 Hz: every note plays an octave high
    expect(rep.match.check.pass).toBe(false);
    expect(rep.match.notes.filter((n) => !n.ok).length).toBe(4);
    expect(rep.match.check.ranges[0]!.note).toMatch(/wrong octave: written A3, heard A4 \(1 octave high\)/);
  });

  it('catches a pitch that is a few semitones off, and says which way', () => {
    const { rep } = report(base('A4 . . . . . . .').replace('gain=0.5', 'gain=0.5 root=C5'));
    const bad = rep.match.notes.find((n) => !n.ok)!;
    expect(bad.problem).toMatch(/wrong pitch: written A4, heard (F#?|F|E)\d \(-?\d/);
  });

  it('the notes view marks the deliberately wrong note, and the image decodes', () => {
    const { song, full, rep } = report(base('A3 . C4 . E4 . A4 .').replace('gain=0.5', 'gain=0.5 root=A3'));
    const png = notesView(song, full, rep.match);
    expect([...png.png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.width).toBe(1000);
    expect(rep.match.notes.every((n) => !n.ok)).toBe(true);
  });

  it('a note that is not heard at all is reported', () => {
    // the second note has velocity 1, 42 dB below the first (velocity follows the level fully)
    const { rep } = report(base('A4v127 . A4v1 . . . . .').replace('velocity=0', 'velocity=1'));
    expect(rep.match.notes.some((n) => /not heard/.test(n.problem ?? ''))).toBe(true);
  });
});

describe('the mix checks', () => {
  it('clip, loudness and dc are checked on the mix, the loudness against the song class (music: -16 LUFS)', () => {
    const { rep } = report(base('A4 - - - - - - -'));
    const by = Object.fromEntries(rep.checks.map((c) => [c.name, c]));
    expect(by.clip!.pass).toBe(true);
    expect(by.loudness!.pass).toBe(false); // a lone quiet sine
    expect(by.loudness!.threshold).toMatch(/-16 LUFS ±2 \(class music\)/);
    expect(by.dc!.pass).toBe(true);
    expect(rep.numbers.rule).toMatchObject({ class: 'music', target: -16 });
  });

  it('a stinger is held to -14, and a song of its own loudness to that', () => {
    const lib = library(base('A4 - - - - - - -', 'class=stinger'));
    expect(songLoudnessRule(lib.songs.get('s')!, DEFAULT_STYLE)).toMatchObject({ class: 'stinger', target: -14 });
    const lib2 = library(base('A4 - - - - - - -', 'class=stinger loudness=-20'));
    expect(songLoudnessRule(lib2.songs.get('s')!, DEFAULT_STYLE)).toMatchObject({ target: -20, basis: 'own loudness -20 LUFS' });
  });

  it('the clip check catches a mix over the ceiling when the master chain is out', () => {
    const { rep } = report(base('A4 - - - - - - -').replace('gain=0.5', 'gain=2'));
    expect(rep.checks.find((c) => c.name === 'clip')!.pass).toBe(false);
  });
});

describe('loop-music', () => {
  const LOOPY = (rows: string) => `${SINE}song new s tempo=120\nsong channel add s lead inst=sine\npattern s.p steps=8 tpb=2\n  lead: ${rows}\nsong section add s A p\nsong fx remove s 1\n`;
  it('passes for a loop whose notes end inside the region', () => {
    const { rep } = report(LOOPY('A4 . . . A4 . . .'));
    const c = rep.checks.find((x) => x.name === 'loop-music')!;
    expect(c.pass, c.value).toBe(true);
  });
  it('a gap at the end is a gap, not a step; a loud end against a quiet start is a step', () => {
    const gap = report(LOOPY('A4 . . . . . . .'));
    expect(gap.rep.checks.find((x) => x.name === 'loop-music')!.pass).toBe(true);
    // the loop ends on a loud held note and starts on a soft one: the level steps by more than 6 dB
    const step = report(LOOPY('A4v20 . . . . A4 - -').replace('velocity=0', 'velocity=1'));
    const c = step.rep.checks.find((x) => x.name === 'loop-music')!;
    expect(c.pass, c.value).toBe(false);
    expect(c.ranges[0]!.note).toMatch(/dB (quieter|louder) than the first/);
  });
  it('catches a jump at the seam in a constructed buffer', () => {
    const n = 4410;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 100 * i) / 44100);
    // end at a different phase from the start: a jump of about 0.28
    for (let i = n - 50; i < n; i++) x[i] = 0.28;
    const c = loopCheck([x, x], 120, DEFAULT_STYLE);
    expect(c.pass).toBe(false);
    expect(c.ranges[0]!.note).toMatch(/seam jumps/);
  });
});

describe('masking', () => {
  const TWO = (inst2: string) => `${SINE}song new s tempo=120\nsong channel add s a inst=sine\nsong channel add s b inst=${inst2}\npattern s.p steps=8 tpb=2\n  a: A4 - - - A4 - - -\n  b: A4 - - - A4 - - -\nsong section add s A p\nsong fx remove s 1\n`;
  it('two channels playing the same band at once are flagged, as an advisory warning that does not block', () => {
    const { rep } = report(TWO('sine'));
    const m = rep.checks.find((c) => c.name === 'masking')!;
    expect(m.advisory).toBe(true);
    expect(m.pass).toBe(false);
    expect(m.ranges[0]!.note).toMatch(/a and b share the (mid|low) band/);
    // advisory: the song passes for work done on the checks that count
    const others = rep.checks.filter((c) => c.name !== 'loudness');
    expect(songPasses(others)).toBe(true);
  });
  it('a bass and a lead in different bands are not', () => {
    const lib = library(`${SINE}song new s tempo=120\nsong channel add s a inst=triangle_bass\nsong channel add s b inst=hat\npattern s.p steps=8 tpb=2\n  a: A2 - - - A2 - - -\n  b: h . h . h . h .\nsong section add s A p\nsong fx remove s 1\n`);
    const r = render(lib, 's');
    const m = maskingCheck(bandMap(r.parts));
    expect(m.pass).toBe(true);
  });
  it('the mix view draws the channels and marks the masked stretches', () => {
    const { song, full, rep } = report(TWO('sine'));
    const img = mixView(song, rep.map, full.length / 44100);
    expect(img.png.length).toBeGreaterThan(500);
  });
});

describe('a song as a whole', () => {
  it('the numbers: length, loop length, per-channel loudness, tempo', () => {
    const { rep } = report(base('A4 - - - A3 - - -'));
    expect(rep.numbers.length).toBe(2);
    expect(rep.numbers.loopLength).toBe(2);
    expect(rep.numbers.tempo).toBe(120);
    expect(rep.numbers.channels.map((c) => [c.name, c.notes])).toEqual([['lead', 2]]);
    expect(Number.isFinite(rep.numbers.channels[0]!.lufs)).toBe(true);
  });
});
