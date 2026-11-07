import { describe, expect, it } from 'vitest';
import { Library, applyCommand, arrange, channelNotes, midiToScript, parse, parseMidi, songToMidi, type SongDoc } from '../src/index.ts';
import { library } from './music-helpers.ts';

const SCRIPT = `song new demo tempo=96 key=C:major time=3/4
song channel add demo lead inst=square_lead
song channel add demo bass inst=triangle_bass
song channel add demo drums kit=default
pattern demo.verse steps=12 tpb=4 bar=12
  lead: C5 . E5 . G5v80 - - . C5+E5 - . .
  bass: C3 . . . C3 . . . G2 . . .
  drums: k . h . s . h . k k oh .
song section add demo A verse x2
`;

const events = (s: SongDoc, ch: string) => channelNotes(s, arrange(s), ch).map((e) => `${e.t.toFixed(4)}/${e.len.toFixed(4)}/${e.midi ?? e.drum}/${e.vel}`);

describe('MIDI', () => {
  it('a song exports as a type 1 file with its tempo, time signature, a track per channel and the drums on channel 10', () => {
    const song = library(SCRIPT).songs.get('demo')!;
    const m = parseMidi(songToMidi(song));
    expect(m.format).toBe(1);
    expect(m.tempo).toBe(96);
    expect(m.time).toEqual([3, 4]);
    expect(m.ppq).toBe(480);
    const drums = m.notes.filter((n) => n.channel === 9);
    expect(drums.map((n) => n.midi)).toContain(36); // the kick
    expect(drums.map((n) => n.midi)).toContain(46); // the open hat
    expect(m.notes.filter((n) => n.channel !== 9).length).toBe(2 * (5 + 3));
  });

  it('round trip: song -> MIDI -> script -> song has the same notes at the same times with the same velocities', () => {
    const song = library(SCRIPT).songs.get('demo')!;
    const imp = midiToScript(songToMidi(song), 'again');
    const p = parse(imp.script);
    expect(p.errors).toEqual([]);
    const lib = new Library();
    for (const c of p.commands) applyCommand(lib, c);
    const back = lib.songs.get('again')!;
    expect(back.tempo).toBe(96);
    expect(back.time).toEqual([3, 4]);
    expect(imp.tpb).toBe(4);
    const names = back.channels.map((c) => c.name).sort();
    expect(names).toEqual(['bass', 'drums', 'lead']);
    for (const ch of ['lead', 'bass', 'drums']) expect(events(back, ch)).toEqual(events(song, ch));
    // the drum channel is a kit
    expect(back.channels.find((c) => c.name === 'drums')!.kit).toEqual({});
  });

  it('one pattern exports alone', () => {
    const song = library(SCRIPT).songs.get('demo')!;
    const one = parseMidi(songToMidi(song, 'verse'));
    const all = parseMidi(songToMidi(song));
    expect(one.notes.length).toBe(all.notes.length / 2);
    expect(() => songToMidi(song, 'nope')).toThrow(/no pattern 'nope'/);
  });

  it('reads a type 0 file: tempo, time signature, notes, and splits a polyphonic part into lines', () => {
    // a type 0 file by hand: 120 bpm, 4/4, ppq 96; channel 0 plays C4 for a beat and E4 starting half a beat later (overlapping)
    const bytes: number[] = [];
    const u32 = (v: number) => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    const track = [0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, 0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
      0x00, 0x90, 60, 100, 0x30, 0x90, 64, 100, 0x30, 0x80, 60, 0, 0x30, 0x80, 64, 0, 0x00, 0xff, 0x2f, 0x00];
    bytes.push(...[77, 84, 104, 100], ...u32(6), 0, 0, 0, 1, 0, 96, ...[77, 84, 114, 107], ...u32(track.length), ...track);
    const m = parseMidi(Uint8Array.from(bytes));
    expect([m.format, m.tempo, m.time, m.ppq]).toEqual([0, 120, [4, 4], 96]);
    expect(m.notes.map((n) => [n.midi, n.start, n.end])).toEqual([[60, 0, 96], [64, 48, 144]]);
    const imp = midiToScript(Uint8Array.from(bytes), 'poly');
    expect(imp.channels.length).toBe(2); // two lines: the notes overlap
    const lib = library(imp.script);
    expect(events(lib.songs.get('poly')!, imp.channels[0]!)[0]).toMatch(/\/60\//);
  });

  it('refuses what it cannot read, saying why', () => {
    expect(() => parseMidi(Uint8Array.from([1, 2, 3]))).toThrow(/not a MIDI file/);
    const smpte = Uint8Array.from([77, 84, 104, 100, 0, 0, 0, 6, 0, 0, 0, 1, 0xe7, 0x28]);
    expect(() => parseMidi(smpte)).toThrow(/SMPTE/);
    const t2 = Uint8Array.from([77, 84, 104, 100, 0, 0, 0, 6, 0, 2, 0, 1, 0, 96]);
    expect(() => parseMidi(t2)).toThrow(/type 2/);
  });

  it('notes off the grid are rounded to the nearest step, and the grid is chosen to fit (triplets get 3 or 12 steps per beat)', () => {
    const trip = library(`song new t tempo=120\nsong channel add t l inst=square_lead\npattern t.p steps=12 tpb=3 bar=12\n  l: C5 D5 E5 F5 G5 A5 B5 C6 D6 E6 F6 G6\nsong section add t A p\n`).songs.get('t')!;
    const imp = midiToScript(songToMidi(trip), 'trip');
    expect(imp.tpb).toBe(3);
  });
});
