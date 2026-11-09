// Masking names its stretches, notes keep their spelling, and the helpers' gate and legato.

import { describe, expect, it } from 'vitest';
import { Library, applyCommand, formatPattern, keyUsesFlats, parse, parseKey, renderMatch, songReport, DEFAULT_STYLE, lookupInstrument, renderSong, serializeSong } from '../src/index.ts';
import { SINE, library, render } from './music-helpers.ts';

function tape(lib: Library, script: string): void {
  const p = parse(script);
  if (p.errors.length) throw new Error(p.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join('; '));
  for (const c of p.commands) applyCommand(lib, c);
}

function report(lib: Library, id: string) {
  const s = lib.songs.get(id)!;
  const full = render(lib, id);
  return songReport({ song: s, full, loop: null, style: DEFAULT_STYLE, instruments: (i) => lookupInstrument(lib, i) });
}

describe('masking names its stretches', () => {
  const SONG = `${SINE}song new m tempo=120
song channel add m a inst=sine
song channel add m b inst=sine
song channel add m c inst=sine
pattern m.p steps=32 tpb=4
  a: C4 - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
  b: C4 - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
  c: G5 . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .
song section add m x p
`;
  it('lists the stretches longest first: the time range, the two channels and the band', () => {
    const lib = library(SONG);
    const m = report(lib, 'm').checks.find((c) => c.name === 'masking')!;
    expect(m.advisory).toBe(true);
    expect(m.ranges.length).toBeGreaterThan(0);
    const r = m.ranges[0]!;
    expect(r.channels!.slice().sort()).toEqual(['a', 'b']);
    expect(r.band).toBe('low');
    expect(r.to - r.from).toBeGreaterThan(1.5);
    expect(r.note).toMatch(/a and b share the low band \(120-500 Hz\) for [\d.]+ s, [\d.-]+ dB apart/);
    expect(m.value).toMatch(/longest: 0\.\d-\d\.\d s a\+b \(low\)/);
    const lens = m.ranges.map((x) => x.to - x.from);
    expect([...lens].sort((x, y) => y - x)).toEqual(lens);
  });
});

describe('note spelling', () => {
  it('a flat stays a flat in the normal form and in the messages; a sharp stays a sharp', () => {
    const lib = library(`${SINE}song new s key=C:major\nsong channel add s lead inst=sine\npattern s.p steps=4 tpb=4\n  lead: Eb4 F#4 Bb3+D4 G#4!\nsong section add s x p\n`);
    const text = formatPattern(lib.songs.get('s')!.patterns.get('p')!);
    expect(text).toContain('lead: Eb4 F#4 Bb3+D4 G#4!');
    const k = report(lib, 's').checks.find((c) => c.name === 'key')!;
    expect(k.ranges.map((r) => r.note).join(' ')).toMatch(/Eb4 in lead .* mark it Eb4!/);
    expect(k.ranges.map((r) => r.note).join(' ')).toMatch(/F#4 in lead/);
    expect(k.value).toMatch(/\(Eb?|\(D#/);
  });
  it('the pattern note commands keep it too', () => {
    const lib = library(`${SINE}song new s key=Eb:major\nsong channel add s lead inst=sine\npattern s.p steps=8 tpb=4\n  lead: Eb4 . . . . . . .\nsong section add s x p\n`);
    const p = parse('pattern note add s.p lead 2 Bb4\npattern note move s.p lead 0 Eb4 note=Ab4\npattern note set s.p lead 2 Bb4 vel=90');
    expect(p.errors).toEqual([]);
    expect(p.commands.map((c) => c.text)).toEqual(['pattern note add s.p lead 2 Bb4', 'pattern note move s.p lead 0 Eb4 note=Ab4', 'pattern note set s.p lead 2 Bb4 vel=90']);
    for (const c of p.commands) applyCommand(lib, c);
    expect(formatPattern(lib.songs.get('s')!.patterns.get('p')!)).toContain('lead: Ab4 . Bb4v90');
  });
  it('flat keys use flats, sharp keys sharps, by the key and not the sound of it', () => {
    for (const [k, flats] of [['F:major', true], ['Bb:major', true], ['Eb:major', true], ['D:minor', true], ['G:minor', true], ['C:minor', true], ['A:minor', false], ['C:major', false], ['D:major', false], ['E:minor', false], ['F#:minor', false], ['B:major', false], ['Gb:major', true], ['C:dorian', true], ['A:pentatonic-minor', false]] as const) {
      expect(keyUsesFlats(k), k).toBe(flats);
      expect(parseKey(k).flats, k).toBe(flats);
    }
    expect(keyUsesFlats(null)).toBe(false);
  });
  it('helpers write flats in a flat key and sharps in a sharp one', () => {
    const SONG = (key: string) => `${SINE}song new h key=${key} tempo=100\nsong channel add h pad inst=sine\nsong channel add h bass inst=sine\npattern h.p steps=64 tpb=4\n  pad: ${Array(64).fill('.').join(' ')}\n  bass: ${Array(64).fill('.').join(' ')}\nsong section add h x p\n`;
    for (const [key, prog, black, other] of [['Eb:major', 'I IV V I', 'Bb', 'A#'], ['F:major', 'I IV V I', 'Bb', 'A#'], ['G:major', 'I IV V I', 'F#', 'Gb'], ['D:minor', 'i iv V i', 'Bb', 'A#']] as const) {
      const lib = library(SONG(key));
      tape(lib, `chords h p pad "${prog}"\nbass h p bass "${prog}" style=root-fifth`);
      const text = formatPattern(lib.songs.get('h')!.patterns.get('p')!);
      expect(text, key).toContain(black);
      expect(text, key).not.toContain(other);
      expect(text, key).not.toMatch(key === 'G:major' ? /Gb|Db|Eb|Ab|Bb/ : /[A-G]#/);
    }
  });
});
void renderMatch; void renderSong; void serializeSong;

describe('helpers: gate and legato', () => {
  const SONG = `${SINE}song new g key=C:major tempo=100\nsong channel add g pad inst=sine\nsong channel add g bass inst=sine\nsong channel add g harp inst=sine\npattern g.p steps=64 tpb=4\n  pad: ${Array(64).fill('.').join(' ')}\n  bass: ${Array(64).fill('.').join(' ')}\n  harp: ${Array(64).fill('.').join(' ')}\nsong section add g x p\n`;
  const row = (lib: Library, ch: string): string => formatPattern(lib.songs.get('g')!.patterns.get('p')!).split('\n').find((l) => l.trim().startsWith(`${ch}:`))!.replace(/\s+/g, ' ').trim();
  const lens = (lib: Library, ch: string, ev = 'pad'): number[] => {
    const s = lib.songs.get('g')!;
    const r = render(lib, 'g');
    void ev;
    return (r.events.get(ch) ?? []).map((e) => Math.round((e.len / (60 / s.tempo / 4)) * 100) / 100);
  };
  it('gate=0.5 shortens each chord to half the time to the next, in whole steps; legato=yes holds to the next', () => {
    const a = library(SONG);
    tape(a, 'chords g p pad "I IV V I" bars=1');
    expect(new Set(lens(a, 'pad'))).toEqual(new Set([16])); // the default: held to the next chord
    const b = library(SONG);
    tape(b, 'chords g p pad "I IV V I" bars=1 gate=0.5');
    expect(new Set(lens(b, 'pad'))).toEqual(new Set([8]));
    const c = library(SONG);
    tape(c, 'chords g p pad "I IV V I" bars=1 gate=0.9');
    expect(new Set(lens(c, 'pad'))).toEqual(new Set([14]));
    const d = library(SONG);
    tape(d, 'chords g p pad "I IV V I" bars=1 rhythm="x-.." legato=yes');
    expect(new Set(lens(d, 'pad'))).toEqual(new Set([4]));
    const e = library(SONG);
    tape(e, 'chords g p pad "I IV V I" bars=1 rhythm="x-.."');
    expect(new Set(lens(e, 'pad'))).toEqual(new Set([2]));
    // the rests inside a rhythm are filled by legato
    expect(row(d, 'pad')).not.toMatch(/\. /);
  });
  it('bass and arp take them; a gate cannot make a note shorter than a step; the normal form says what was asked', () => {
    const lib = library(SONG);
    tape(lib, 'chords g p pad "I IV V I" bars=1\nbass g p bass from=pad style=root-fifth gate=0.5\narp g p harp from=pad rate=1/8 gate=0.5');
    expect(new Set(lens(lib, 'bass'))).toEqual(new Set([4]));
    expect(Math.min(...lens(lib, 'harp'))).toBe(1);
    const p = parse('chords g p pad "I IV V I" bars=1 vel=90 gate=0.5\nbass g p bass from=pad legato=yes');
    expect(p.errors).toEqual([]);
    const lib2 = library(SONG);
    for (const c of p.commands) applyCommand(lib2, c);
    expect(row(lib2, 'bass')).toMatch(/C2/);
  });
  it('refuses a gate out of range, legato with a shorter gate, and says which', () => {
    expect(parse('chords g p pad "I" gate=1.5').errors[0]!.message).toMatch(/gate is a fraction from 0 to 1/);
    expect(parse('chords g p pad "I" legato=maybe').errors[0]!.message).toMatch(/legato is yes \(each note holds/);
    const lib = library(SONG);
    expect(() => tape(lib, 'chords g p pad "I" bars=1 gate=0.5 legato=yes')).toThrow(/give one of the two/);
  });
});
