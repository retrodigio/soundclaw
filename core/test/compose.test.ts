// The composition helpers: the exact notes each writes on known inputs, voice leading, motif
// transforms, drum templates, humanise, and that the tape replays what was written.

import { describe, expect, it } from 'vitest';
import {
  Library, applyCommand, chordClasses, formatCell, formatPattern, parse, parseChord, parseKey, parseProgression, parallelPairs, scaleText, stepInScale, voiceChord, degreeOf, fromDegree,
  DRUM_TEMPLATES, drumRows, motifText, seededRandom, SCALES, parsePattern, channelNotes, arrange, renderSong, lookupInstrument, tapeLineLines,
} from '../src/index.ts';
import { library, SINE, firstAbove } from './music-helpers.ts';

/** Apply a script and return the normal forms the commands put on the tape. */
function tape(lib: Library, script: string): string[] {
  const p = parse(script);
  if (p.errors.length) throw new Error(p.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join('; '));
  return p.commands.flatMap((c) => (applyCommand(lib, c) ?? c.text).split('\n'));
}

const row = (lib: Library, song: string, pat: string, ch: string): string => lib.songs.get(song)!.patterns.get(pat)!.channels.find((c) => c.name === ch)!.cells.map(formatCell).join(' ');

const C_SONG = `${SINE}song new s tempo=120 key=C:major
song channel add s pad inst=sine
song channel add s bass inst=sine
song channel add s lead inst=sine
song channel add s drums kit=default
song channel add s hats kit=default
`;

describe('scales and degrees', () => {
  it('knows the modes, the minors, pentatonics, blues, whole-tone and game colours', () => {
    for (const k of ['major', 'minor', 'natural-minor', 'harmonic-minor', 'melodic-minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'pentatonic-major', 'pentatonic-minor', 'blues', 'whole-tone', 'phrygian-dominant', 'hirajoshi', 'octatonic']) expect(SCALES[k], k).toBeDefined();
    expect(parseKey('E:phrygian-dominant').classes).toEqual([4, 5, 8, 9, 11, 0, 2]);
    expect(parseKey('C:whole-tone').classes).toEqual([0, 2, 4, 6, 8, 10]);
  });
  it('moves notes by scale steps; a note off the scale keeps its distance', () => {
    const c = parseKey('C:major');
    expect(stepInScale(c, 64, 2)).toBe(67); // E4 -> G4
    expect(stepInScale(c, 60, -1)).toBe(59); // C4 -> B3
    expect(stepInScale(c, 61, 1)).toBe(63); // C#4 -> D#4
    expect(fromDegree(c, degreeOf(c, 71).deg)).toBe(71);
  });
  it('lists a key\'s chords by degree', () => {
    const t = scaleText('D:major');
    expect(t).toMatch(/^D:major: D E F# G A B C#/);
    expect(t).toMatch(/vii°\s+C#dim\s+C# E G\s+C#m7b5/);
    expect(t).toMatch(/V\s+A\s+A C# E\s+A7/);
    expect(scaleText('list')).toMatch(/whole-tone/);
  });
});

describe('roman numerals', () => {
  const C = parseKey('C:major');
  const ch = (s: string, k = C) => { const x = parseChord(s, k); return [x.root, x.tones, x.inversion]; };
  it('reads quality from case and suffixes, sevenths, sus, add9 and inversions', () => {
    expect(ch('I')).toEqual([0, [0, 4, 7], null]);
    expect(ch('vi')).toEqual([9, [0, 3, 7], null]);
    expect(ch('V7')).toEqual([7, [0, 4, 7, 10], null]);
    expect(ch('IVmaj7')).toEqual([5, [0, 4, 7, 11], null]);
    expect(ch('ii7')).toEqual([2, [0, 3, 7, 10], null]);
    expect(ch('vii°')).toEqual([11, [0, 3, 6], null]);
    expect(ch('vii°7')).toEqual([11, [0, 3, 6, 9], null]);
    expect(ch('viiø7')).toEqual([11, [0, 3, 6, 10], null]);
    expect(ch('III+')).toEqual([4, [0, 4, 8], null]);
    expect(ch('Vsus4')).toEqual([7, [0, 5, 7], null]);
    expect(ch('Isus2')).toEqual([0, [0, 2, 7], null]);
    expect(ch('Iadd9')).toEqual([0, [0, 4, 7, 14], null]);
    expect(ch('I6')).toEqual([0, [0, 4, 7], 1]);
    expect(ch('I64')).toEqual([0, [0, 4, 7], 2]);
    expect(ch('ii65')).toEqual([2, [0, 3, 7, 10], 1]);
    expect(ch('V43')).toEqual([7, [0, 4, 7, 10], 2]);
    expect(ch('V42')).toEqual([7, [0, 4, 7, 10], 3]);
  });
  it('borrows chords and builds secondary dominants', () => {
    expect(ch('bVII')).toEqual([10, [0, 4, 7], null]);
    expect(ch('bVI')).toEqual([8, [0, 4, 7], null]);
    expect(ch('iv')).toEqual([5, [0, 3, 7], null]);
    expect(ch('V/V')).toEqual([2, [0, 4, 7], null]);
    expect(ch('V7/vi')).toEqual([4, [0, 4, 7, 10], null]);
    expect(ch('vii°/V')).toEqual([6, [0, 3, 6], null]);
  });
  it('counts numerals in a minor key\'s own scale', () => {
    const a = parseKey('A:minor');
    expect(parseProgression('i VI III VII', a).map((x) => x.root)).toEqual([9, 5, 0, 7]);
    expect(ch('V', a)).toEqual([4, [0, 4, 7], null]);
    expect(parseProgression('I:2 | V:0.5', C).map((x) => x.bars)).toEqual([2, 0.5]);
  });
  it('says what is wrong with a chord', () => {
    expect(() => parseChord('X', C)).toThrow(/does not start with a roman numeral/);
    expect(() => parseChord('Vq', C)).toThrow(/'q' is not a chord suffix/);
    expect(() => parseChord('I/Z', C)).toThrow(/secondary/);
  });
});

describe('voicing', () => {
  const C = parseKey('C:major');
  const range: [number, number] = [55, 79];
  const motion = (a: number[], b: number[]) => a.reduce((s, x, i) => s + Math.abs(x - b[i]!), 0);
  it('starts close in root position near the middle, then moves the voices least: I IV V I', () => {
    let prev: number[] | null = null;
    const out = parseProgression('I IV V I', C).map((c) => (prev = voiceChord(prev, c, 3, range)));
    expect(out).toEqual([[60, 64, 67], [60, 65, 69], [62, 67, 71], [64, 67, 72]]);
  });
  it('takes the least total motion of all voicings in the range (checked against every voicing)', () => {
    for (const [a, b] of [['I', 'vi'], ['ii7', 'V7'], ['IV', 'V'], ['vi', 'iii'], ['V7', 'I']] as const) {
      const ca = parseChord(a, C), cb = parseChord(b, C);
      const n = Math.max(new Set(chordClasses(ca)).size, new Set(chordClasses(cb)).size);
      const first = voiceChord(null, ca, n, range);
      const next = voiceChord(first, cb, n, range);
      // every voicing of b with each chord tone, n notes, inside the range
      const pool: number[] = [];
      for (let m = range[0]; m <= range[1]; m++) if (chordClasses(cb).includes(m % 12)) pool.push(m);
      let best = Infinity;
      const pick: number[] = [];
      const walk = (k: number): void => {
        if (pick.length === n) { if (new Set(pick.map((x) => x % 12)).size === new Set(chordClasses(cb)).size && pick[n - 1]! - pick[0]! <= 24 && !parallelPairs(first, pick).length) best = Math.min(best, motion(first, pick)); return; }
        for (let i = k; i < pool.length; i++) { pick.push(pool[i]!); walk(i + 1); pick.pop(); }
      };
      walk(0);
      expect(motion(first, next), `${a} -> ${b}`).toBe(best);
    }
  });
  it('keeps an asked-for inversion in the bass', () => {
    const v = voiceChord(null, parseChord('I6', C), 3, range);
    expect(v[0]! % 12).toBe(4);
  });
  it('finds parallel fifths and octaves, not oblique or contrary motion', () => {
    expect(parallelPairs([60, 67], [62, 69])).toEqual([[0, 1, 'fifths']]);
    expect(parallelPairs([60, 72], [62, 74])).toEqual([[0, 1, 'octaves']]);
    expect(parallelPairs([60, 67], [59, 67])).toEqual([]);
    expect(parallelPairs([60, 67], [62, 65])).toEqual([]);
  });
});

describe('chords, bass and arp write exact notes', () => {
  it('chords: a progression voiced and struck on the beats', () => {
    const lib = library(C_SONG);
    const t = tape(lib, 'chords s v pad "I IV" rhythm=beats');
    expect(row(lib, 's', 'v', 'pad')).toBe('C4+E4+G4 - - - C4+E4+G4 - - - C4+E4+G4 - - - C4+E4+G4 - - - C4+F4+A4 - - - C4+F4+A4 - - - C4+F4+A4 - - - C4+F4+A4 - - -');
    expect(t[0]).toMatch(/^chords s v pad "I IV" bars=1 rhythm=beats voices=3 range=G3-G5 vel=100 tpb=4 written="pattern v steps=32 tpb=4 bar=16\\n  pad: C4\+E4\+G4/);
  });
  it('chords: a mask rhythm, per-chord bars, and a progression repeated to fill a pattern', () => {
    const lib = library(C_SONG + 'pattern s.v steps=32 tpb=4\n  lead: ' + '. '.repeat(32) + '\n');
    tape(lib, 'chords s v pad "I V:0.5 IV:0.5" rhythm="x-.x"');
    // the mask runs from the start of the pattern; each chord is struck where it begins
    const bar = (c: string) => `${c} - . ${c}`;
    expect(row(lib, 's', 'v', 'pad')).toBe([...Array(4).fill(bar('C4+E4+G4')), ...Array(2).fill(bar('B3+D4+G4')), ...Array(2).fill(bar('C4+F4+A4'))].join(' '));
  });
  it('chords outside the key are marked ! so the key check passes', () => {
    const lib = library(C_SONG);
    tape(lib, 'chords s v pad "I bVII"');
    expect(row(lib, 's', 'v', 'pad')).toMatch(/A#3!\+D4\+F4|D4\+F4\+A#4!/);
  });
  it('bass styles: root, root-fifth, octave and walking', () => {
    const lib = library(C_SONG);
    tape(lib, 'bass s r bass "I V" style=root');
    expect(row(lib, 's', 'r', 'bass')).toBe(`C2 ${'- '.repeat(15)}G2 ${'- '.repeat(14)}-`);
    tape(lib, 'bass s f bass "I" style=root-fifth');
    expect(row(lib, 's', 'f', 'bass')).toBe('C2 - - - - - - - G2 - - - - - - -');
    tape(lib, 'bass s o bass "I" style=octave');
    expect(row(lib, 's', 'o', 'bass')).toBe('C2 - C3 - C2 - C3 - C2 - C3 - C2 - C3 -');
    tape(lib, 'bass s w bass "I V" style=walking');
    // the root, chord and scale tones heading for G, a step into it from below (F); then the last bar
    expect(row(lib, 's', 'w', 'bass').split(' | ')[0]).toBe('C2 - - - E2 - - - D2 - - - F2 - - - G2 - - - D2 - - - E2 - - - D2 - - -');
  });
  it('bass from= follows the chords a channel plays', () => {
    const lib = library(C_SONG);
    tape(lib, 'chords s v pad "vi IV"\nbass s v bass from=pad style=root');
    expect(row(lib, 's', 'v', 'bass')).toBe(`A2 ${'- '.repeat(15)}F2 ${'- '.repeat(14)}-`);
  });
  it('arp orders: up, down, updown, and a seeded random order', () => {
    const lib = library(C_SONG);
    tape(lib, 'arp s a lead "I" pattern=up rate=1/8');
    expect(row(lib, 's', 'a', 'lead')).toBe('C4 - E4 - G4 - C4 - E4 - G4 - C4 - E4 -');
    tape(lib, 'arp s b lead "I" pattern=down rate=1/8');
    expect(row(lib, 's', 'b', 'lead')).toBe('G4 - E4 - C4 - G4 - E4 - C4 - G4 - E4 -');
    tape(lib, 'arp s c lead "I" pattern=updown rate=1/16 octaves=2');
    expect(row(lib, 's', 'c', 'lead')).toBe('C4 E4 G4 C5 E5 G5 E5 C5 G4 E4 C4 E4 G4 C5 E5 G5');
    tape(lib, 'arp s d lead "I" pattern=random(7) rate=1/16 octaves=2\narp s e lead "I" pattern=random(7) rate=1/16 octaves=2\narp s f lead "I" pattern=random(8) rate=1/16 octaves=2');
    const d = row(lib, 's', 'd', 'lead');
    expect(row(lib, 's', 'e', 'lead')).toBe(d);
    expect(row(lib, 's', 'f', 'lead')).not.toBe(d);
    const notes = d.split(' ');
    for (let i = 1; i < notes.length; i++) expect(notes[i]).not.toBe(notes[i - 1]);
  });
  it('says what is missing', () => {
    const lib = library(C_SONG.replace('key=C:major', ''));
    expect(() => tape(lib, 'chords s v pad "I"')).toThrow(/no key/);
    const lib2 = library(C_SONG);
    expect(() => tape(lib2, 'chords s v drums "I"')).toThrow(/drum channel/);
    expect(() => tape(lib2, 'chords s v nope "I"')).toThrow(/no channel nope/);
    expect(() => tape(lib2, 'bass s v bass from=pad')).toThrow(/does not exist yet/);
  });
});

describe('the tape keeps what a helper wrote', () => {
  it('replays the written rows, never working them out again', () => {
    const lib = library(C_SONG);
    const lines = tape(lib, 'chords s v pad "I V vi IV" rhythm=half\nbass s v bass "I V vi IV" style=walking\nhumanise s v all seed=4');
    const again = library(C_SONG);
    tape(again, lines.join('\n'));
    expect(formatPattern(again.songs.get('s')!.patterns.get('v')!)).toBe(formatPattern(lib.songs.get('s')!.patterns.get('v')!));
    // written= wins over what the helper would write
    const forced = library(C_SONG);
    tape(forced, 'chords s w pad "I" written="pattern w steps=16 tpb=4\\n  pad: D4 - - - - - - - - - - - - - - -"');
    expect(row(forced, 's', 'w', 'pad')).toBe('D4 - - - - - - - - - - - - - - -');
  });
  it('shows a helper line as the command and the rows it wrote', () => {
    const lib = library(C_SONG);
    const [t] = tape(lib, 'arp s a lead "I" rate=1/4');
    expect(tapeLineLines(t!)).toEqual(['arp s a lead "I" pattern=up rate=1/4 octaves=1 bars=1 range=C4-C6 vel=100 tpb=4  (wrote:)', '  lead: C4 - - - E4 - - - G4 - - - C4 - - -']);
  });
});

describe('motifs', () => {
  const M = C_SONG + 'motif set s m "C5 - E5 G5"\n';
  const motif = (lib: Library, name: string) => { const m = lib.songs.get('s')!.motifs.find((x) => x.name === name)!; return `tpb=${m.tpb} ${motifText(m)}`; };
  it('transposes by semitones and by scale steps', () => {
    const lib = library(M);
    tape(lib, 'motif transpose s m by=2 as=up2\nmotif transpose s m by=2 mode=diatonic as=d2');
    expect(motif(lib, 'up2')).toBe('tpb=4 D5 - F#5! A5');
    expect(motif(lib, 'd2')).toBe('tpb=4 E5 - G5 B5');
  });
  it('inverts around the first note, in the scale or by semitones', () => {
    const lib = library(M);
    tape(lib, 'motif invert s m as=i\nmotif invert s m mode=chromatic as=ic\nmotif invert s m around=G5 mode=chromatic as=ig');
    expect(motif(lib, 'i')).toBe('tpb=4 C5 - A4 F4');
    expect(motif(lib, 'ic')).toBe('tpb=4 C5 - G#4! F4');
    expect(motif(lib, 'ig')).toBe('tpb=4 D6 - A#5! G5');
  });
  it('reverses, augments and diminishes', () => {
    const lib = library(M + 'motif set s n "C5 - E5 - G5 - . ."\n');
    tape(lib, 'motif retrograde s m as=r\nmotif augment s m as=a\nmotif augment s m factor=3 as=a3\nmotif diminish s m as=d\nmotif diminish s n as=dn');
    expect(motif(lib, 'r')).toBe('tpb=4 G5 E5 C5 -');
    expect(motif(lib, 'a')).toBe('tpb=4 C5 - - - E5 - G5 -');
    expect(motif(lib, 'a3')).toBe('tpb=4 C5 - - - - - E5 - - G5 - -');
    expect(motif(lib, 'd')).toBe('tpb=8 C5 - E5 G5');
    expect(motif(lib, 'dn')).toBe('tpb=4 C5 E5 G5 .');
  });
  it('writes into a pattern at a step, on the pattern\'s grid', () => {
    const lib = library(M + 'pattern s.p steps=16 tpb=4\n  lead: A4 . . . . . . . . . . . . . . .\n');
    tape(lib, 'motif write s m p lead at=4');
    expect(row(lib, 's', 'p', 'lead')).toBe('A4 . . . C5 - E5 G5 . . . . . . . .');
    tape(lib, 'motif augment s m as=slow\nmotif write s slow p lead at=8 by=-12');
    expect(row(lib, 's', 'p', 'lead')).toBe('A4 . . . C5 - E5 G5 C4 - - - E4 - G4 -');
    expect(() => tape(lib, 'motif write s slow p lead at=12')).toThrow(/runs past/);
    // tpb=8 does not fit a tpb=4 grid note for note
    expect(() => tape(lib, 'motif set s q "C5 E5" tpb=8\nmotif write s q p lead')).toThrow(/does not fit a grid/);
  });
  it('sequences a motif over a progression (diatonic: moved as the roots move)', () => {
    const lib = library(M);
    tape(lib, 'motif sequence s m q lead "I IV V I"');
    const cells = row(lib, 's', 'q', 'lead').split(' ');
    expect([0, 16, 32, 48].map((i) => cells.slice(i, i + 4).join(' '))).toEqual(['C5 - E5 G5', 'F5 - A5 C6', 'G5 - B5 D6', 'C5 - E5 G5']);
    expect(cells.slice(4, 16).every((c) => c === '.')).toBe(true);
  });
});

describe('drum templates', () => {
  it('writes a template exactly: one channel (hats where kick and snare rest) or two', () => {
    const lib = library(C_SONG);
    tape(lib, 'drums s d drums rock vary=0\ndrums s e drums,hats rock vary=0');
    expect(row(lib, 's', 'd', 'drums')).toBe('k . hv80 . sv120 . hv80 . k . k . sv120 . hv80 .');
    expect(row(lib, 's', 'e', 'drums')).toBe('k . . . sv120 . . . k . k . sv120 . . .');
    expect(row(lib, 's', 'e', 'hats')).toBe('h . hv80 . h . hv80 . h . hv80 . h . hv80 .');
  });
  it('every template keeps kick and snare apart, and fits its own bar', () => {
    for (const [name, t] of Object.entries(DRUM_TEMPLATES)) {
      const n = t.beats * t.tpb;
      for (const lane of [t.kick, t.snare, t.hat]) expect(lane.length, name).toBe(n);
      for (let i = 0; i < n; i++) expect(t.kick[i] !== '.' && t.snare[i] !== '.', `${name} step ${i}`).toBe(false);
    }
    expect(new Set(Object.values(DRUM_TEMPLATES).map((t) => t.feel))).toEqual(new Set(['straight rock', 'half-time', 'shuffle', 'march', 'waltz', 'ambient pulse', 'chiptune']));
  });
  it('puts a fill in every nth bar and varies the other bars by seed, the same each time', () => {
    const t = DRUM_TEMPLATES.rock!;
    const a = drumRows(t, 8, 4, 3, 0.5, 2), b = drumRows(t, 8, 4, 3, 0.5, 2), c = drumRows(t, 8, 4, 4, 0.5, 2);
    expect(a).toEqual(b);
    expect(a.rows.map((r) => r.map(formatCell).join(' '))).not.toEqual(c.rows.map((r) => r.map(formatCell).join(' ')));
    expect(a.fills.map((f) => f.split(':')[0])).toEqual(['bar 4', 'bar 8']);
    // bar 1 is the template itself
    expect(a.rows[0]!.slice(0, 16).map(formatCell).join(' ')).toBe('k . . . sv120 . . . k . k . sv120 . . .');
    // the last beat of bar 4 has no hats (the fill)
    expect(a.rows[1]!.slice(60, 64).every((x) => x.kind === 'rest')).toBe(true);
  });
  it('refuses a template whose bar or grid does not fit', () => {
    const lib = library(C_SONG);
    expect(() => tape(lib, 'drums s d drums waltz')).toThrow(/waltz is a bar of 3 beats/);
    tape(lib, 'drums s d drums rock');
    expect(() => tape(lib, 'drums s d drums shuffle')).toThrow(/tpb=3/);
    expect(() => tape(lib, 'drums s d pad rock')).toThrow(/drum hits go in a drum channel/);
  });
});

describe('humanise', () => {
  it('writes seeded nudges and velocities into the notes, within the amounts, the same for the same seed', () => {
    const base = C_SONG + 'chords s v pad "I V" rhythm=beats\ndrums s v drums,hats rock\n';
    const a = library(base), b = library(base), c = library(base);
    const ta = tape(a, 'humanise s v all timing=8 velocity=6 seed=5');
    tape(b, 'humanise s v all timing=8 velocity=6 seed=5');
    tape(c, 'humanise s v all timing=8 velocity=6 seed=6');
    const text = (l: Library) => formatPattern(l.songs.get('s')!.patterns.get('v')!);
    expect(text(b)).toBe(text(a));
    expect(text(c)).not.toBe(text(a));
    expect(ta[0]).toMatch(/^humanise s v all timing=8 velocity=6 seed=5 written=/);
    const p = a.songs.get('s')!.patterns.get('v')!;
    const before = library(base).songs.get('s')!.patterns.get('v')!;
    let moved = 0;
    p.channels.forEach((ch, ci) => ch.cells.forEach((cell, i) => {
      const was = before.channels[ci]!.cells[i]!;
      if (cell.kind === 'notes' && was.kind === 'notes') cell.notes.forEach((n, k) => {
        expect(Math.abs(n.nudge ?? 0)).toBeLessThanOrEqual(8);
        expect(Math.abs(n.vel - was.notes[k]!.vel)).toBeLessThanOrEqual(6);
        if (n.nudge) moved++;
      });
      if (cell.kind === 'drum' && was.kind === 'drum') { expect(Math.abs(cell.nudge ?? 0)).toBeLessThanOrEqual(8); expect(Math.abs(cell.vel - was.vel)).toBeLessThanOrEqual(6); }
    }));
    expect(moved).toBeGreaterThan(10);
  });
  it('timing=0 leaves the grid alone', () => {
    const lib = library(C_SONG + 'chords s v pad "I"\n');
    tape(lib, 'humanise s v pad timing=0 velocity=10 seed=1');
    expect(row(lib, 's', 'v', 'pad')).not.toMatch(/@/);
    expect(row(lib, 's', 'v', 'pad')).toMatch(/v\d+/);
  });
  it('takes a list of channels and leaves the others alone', () => {
    const base = C_SONG + 'chords s v pad "I V" rhythm=beats\ndrums s v drums,hats rock\n';
    const lib = library(base);
    const hats = row(lib, 's', 'v', 'hats');
    expect(tape(lib, 'humanise s v pad,drums seed=2')[0]).toMatch(/^humanise s v pad,drums timing=8 velocity=6 seed=2 written=/);
    expect(row(lib, 's', 'v', 'pad')).toMatch(/@/);
    expect(row(lib, 's', 'v', 'drums')).toMatch(/@/);
    expect(row(lib, 's', 'v', 'hats')).toBe(hats);
    expect(() => tape(library(base), 'humanise s v pad,pad')).toThrow(/not a channel name/);
  });
});

describe('the nudge in the pattern text', () => {
  it('reads and writes @ms on notes, chord notes and drum hits; at most 50 ms', () => {
    const r = parsePattern('pattern p steps=4 tpb=4\n  a: C5v90@-6 C4@3+E4 . G4!@2\n  d: k@4 sv80@-12 . .');
    expect(r.errors).toEqual([]);
    expect(formatPattern(r.pattern!)).toBe('pattern p steps=4 tpb=4\n  a: C5v90@-6 C4@3+E4  . G4@2!\n  d: k@4      sv80@-12 . .\n');
    expect(parsePattern('pattern p steps=1 tpb=4\n  a: C5@60').errors[0]!.message).toMatch(/at most 50 ms/);
  });
  it('moves the note in time when rendered (late by the nudge)', () => {
    const lib = library(`${SINE}song new s tempo=120\nsong channel add s a inst=sine\npattern s.p steps=4 tpb=4\n  a: . C5@10 . .\nsong section add s x p\nsong loop s off\n`);
    const plain = library(`${SINE}song new s tempo=120\nsong channel add s a inst=sine\npattern s.p steps=4 tpb=4\n  a: . C5 . .\nsong section add s x p\nsong loop s off\n`);
    const r = (l: Library) => renderSong(l.songs.get('s')!, { instruments: (i) => lookupInstrument(l, i) });
    expect(firstAbove(r(lib).parts[0]!.channels[0], 0.001) - firstAbove(r(plain).parts[0]!.channels[0], 0.001)).toBe(441);
    const s = lib.songs.get('s')!;
    const ev = channelNotes(s, arrange(s), 'a')[0]!;
    expect(ev.t - ev.grid).toBeCloseTo(0.01, 9);
  });
});

describe('seeded randomness', () => {
  it('is the same stream for the same seed', () => {
    const a = seededRandom(42), b = seededRandom(42);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(xs.map((x) => Math.round(x * 1e6))).toEqual(xs.map((x) => Math.round(x * 1e6)));
  });
});
