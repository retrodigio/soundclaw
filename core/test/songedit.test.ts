// The music editor's commands: `pattern note add|remove|move|len|set`, what they do to a row, their
// normal form (the page writes exactly what an agent would), the gesture batch, the note diff
// `changes` prints, and a channel re-rendered after an edit equal to a full render.

import { describe, expect, it } from 'vitest';
import {
  GestureBatch, Library, applyCommand, applyNoteEdit, formatPattern, joinChannels, lookupInstrument, moveCommands, noteEditText, parse, parsePattern, patternNoteDiff, renderSong,
  rollNotes, samplesHash, seededRandom, type NoteEdit, type Pattern, type PartStore,
} from '../src/index.ts';
import { library, SINE } from './music-helpers.ts';

const SONG = `${SINE}song new s tempo=120 key=C:major
song channel add s lead inst=sine
song channel add s bass inst=sine
song channel add s drums kit=default
pattern s.p steps=8 tpb=2
  lead: C5 - . E5 G5+B5 - - .
  drums: k . s . k k s h
song section add s A p
`;

function run(lib: Library, script: string): string[] {
  const p = parse(script);
  if (p.errors.length) throw new Error(p.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join('; '));
  for (const c of p.commands) applyCommand(lib, c);
  return p.commands.map((c) => c.text);
}

const row = (lib: Library, ch: string, pat = 'p'): string => {
  const p = lib.songs.get('s')!.patterns.get(pat)!;
  const text = formatPattern({ ...p, channels: p.channels.filter((c) => c.name === ch) });
  return text.split('\n')[1]!.replace(/^\s*\w+:\s*/, '').replace(/\s+/g, ' ');
};

describe('pattern note', () => {
  it('add writes over what it lands on, joins a chord where one starts, and makes the row when there is none', () => {
    const lib = library(SONG);
    run(lib, 'pattern note add s.p lead 1 D5');
    expect(row(lib, 'lead')).toBe('C5 D5 . E5 G5+B5 - - .');
    run(lib, 'pattern note add s.p lead 4 D5');
    expect(row(lib, 'lead')).toBe('C5 D5 . E5 D5+G5+B5 - - .');
    run(lib, 'pattern note add s.p lead 3 A5v90~vib len=2');
    expect(row(lib, 'lead')).toBe('C5 D5 . E5+A5v90~vib - . . .');
    run(lib, 'pattern note add s.p bass 0 C3 len=4');
    expect(row(lib, 'bass')).toBe('C3 - - - . . . .');
    expect(lib.songs.get('s')!.patterns.get('p')!.channels.map((c) => c.name)).toEqual(['lead', 'bass', 'drums']);
    run(lib, 'pattern note add s.p drums 1 h');
    expect(row(lib, 'drums')).toBe('k h s . k k s h');
  });
  it('remove, move, len and set', () => {
    const lib = library(SONG);
    run(lib, 'pattern note remove s.p lead 4 B5');
    expect(row(lib, 'lead')).toBe('C5 - . E5 G5 - - .');
    run(lib, 'pattern note move s.p lead 0 step=1 note=D5');
    expect(row(lib, 'lead')).toBe('. D5 - E5 G5 - - .');
    run(lib, 'pattern note len s.p lead 1 1\npattern note len s.p lead 4 4');
    expect(row(lib, 'lead')).toBe('. D5 . E5 G5 - - -');
    run(lib, 'pattern note set s.p lead 3 vel=70 fx=~slide~arp(0,4,7)');
    expect(row(lib, 'lead')).toBe('. D5 . E5v70~slide~arp(0,4,7) G5 - - -');
    run(lib, 'pattern note set s.p lead 3 E5 fx=none accidental=yes');
    expect(row(lib, 'lead')).toBe('. D5 . E5v70! G5 - - -');
    run(lib, 'pattern note move s.p drums 2 s note=h\npattern note set s.p drums 0 vel=90\npattern note remove s.p drums 7');
    expect(row(lib, 'drums')).toBe('kv90 . h . k k s .');
  });
  it('refuses with a reason', () => {
    const lib = library(SONG);
    const err = (cmd: string) => { try { run(lib, cmd); return ''; } catch (e) { return (e as Error).message; } };
    expect(err('pattern note remove s.p lead 1')).toMatch(/no note starts at step 1 of lead \(the note sounding there, C5, starts at step 0\)/);
    expect(err('pattern note add s.p lead 7 C5 len=2')).toMatch(/runs past the end/);
    expect(err('pattern note add s.p drums 0 C5')).toMatch(/drum channel/);
    expect(err('pattern note add s.p lead 0 k')).toMatch(/plays sine: write a note/);
    expect(err('pattern note add s.p pad 0 C5')).toMatch(/no channel pad/);
    expect(err('pattern note move s.p lead 4 C5 step=5')).toMatch(/no C5 there/);
    expect(parse('pattern note move s.p lead 0').errors[0]!.message).toMatch(/step=<to> and\/or note=<to>/);
    expect(parse('pattern note add s.p drums 0 k len=2').errors[0]!.message).toMatch(/one step/);
    expect(parse('pattern note set s.p lead 0 fx=~wobble').errors[0]!.message).toMatch(/not an effect|no effect/);
  });
  it('the form the page writes is the form an agent writes: random edits round-trip through parse and replay', () => {
    const rnd = seededRandom(7);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    let lib = library(SONG);
    const tape: string[] = [];
    let applied = 0;
    for (let k = 0; k < 400; k++) {
      const song = lib.songs.get('s')!;
      const p = song.patterns.get('p')!;
      const ch = pick(['lead', 'bass', 'drums']);
      const notes = rollNotes(p.channels.find((c) => c.name === ch));
      const n = notes.length ? pick(notes) : null;
      const drum = ch === 'drums';
      const verb = pick(['add', 'add', 'remove', 'move', 'len', 'set'] as const);
      let e: NoteEdit;
      if (verb === 'add' || !n) {
        const step = Math.floor(rnd() * 8);
        e = { verb: 'add', channel: ch, step, cell: drum ? { kind: 'drum', drum: pick(['k', 's', 'h']), vel: pick([100, 80]) } : { kind: 'notes', notes: [{ midi: 55 + Math.floor(rnd() * 24), vel: pick([100, 64, 110]), fx: pick([{}, { slide: true as const }, { vib: { rate: 5, depth: 0.4 } }]) }] }, len: drum ? null : pick([null, 1, 2, 3]) };
      } else if (verb === 'remove') e = { verb, channel: ch, step: n.step, sel: n.chord > 1 ? { midi: n.midi! } : null };
      else if (verb === 'move') e = { verb, channel: ch, step: n.step, sel: n.chord > 1 ? { midi: n.midi! } : null, toStep: Math.floor(rnd() * 8), toNote: drum ? pick(['k', 's', 'h']) : n.midi! + pick([-2, 0, 3]) };
      else if (verb === 'len') e = { verb, channel: ch, step: n.step, len: drum ? 1 : 1 + Math.floor(rnd() * 3) };
      else e = { verb, channel: ch, step: n.step, sel: null, vel: 20 + Math.floor(rnd() * 100), fx: drum ? null : pick([null, {}, { slide: true as const }]), accidental: drum ? null : pick([null, true, false]) };
      const text = noteEditText('s', 'p', e);
      const parsed = parse(text);
      expect(parsed.errors, text).toEqual([]);
      // the normal form is the text itself
      expect(parsed.commands[0]!.text).toBe(text);
      let direct: Pattern;
      try { direct = applyNoteEdit(p, e, song); } catch { expect(() => applyCommand(lib, parsed.commands[0]!)).toThrow(); continue; }
      applyCommand(lib, parsed.commands[0]!);
      expect(formatPattern(lib.songs.get('s')!.patterns.get('p')!)).toBe(formatPattern(direct));
      // what is written is always a valid pattern
      expect(parsePattern(formatPattern(direct)).errors).toEqual([]);
      tape.push(text);
      applied++;
    }
    expect(applied).toBeGreaterThan(250);
    const again = library(SONG);
    run(again, tape.join('\n'));
    expect(formatPattern(again.songs.get('s')!.patterns.get('p')!)).toBe(formatPattern(lib.songs.get('s')!.patterns.get('p')!));
    lib = again;
  });
  it('a move gesture of several notes writes them in an order where none lands on one not yet moved', () => {
    const lib = library(`${SINE}song new s\nsong channel add s lead inst=sine\npattern s.p steps=8 tpb=2\n  lead: C5 D5 E5 F5 . . . .\nsong section add s A p\n`);
    const p = lib.songs.get('s')!.patterns.get('p')!;
    const notes = rollNotes(p.channels[0]);
    const right = moveCommands('s', p, 'lead', notes, 2, 0)!;
    expect(right[0]).toBe('pattern note move s.p lead 3 step=5');
    run(lib, right.join('\n'));
    expect(row(lib, 'lead')).toBe('. . C5 D5 E5 F5 . .');
    expect(moveCommands('s', p, 'lead', notes, 5, 0)).toBeNull();
    expect(moveCommands('s', p, 'lead', notes, 0, 0)).toEqual([]);
  });
  it('a gesture batch writes once, the latest per key; a gesture that changes nothing writes nothing', () => {
    const sent: string[][] = [];
    const g = new GestureBatch((c) => sent.push(c));
    g.push('v:0', 'pattern note set s.p lead 0 vel=90');
    g.push('v:3', 'pattern note set s.p lead 3 vel=40');
    g.push('v:0', 'pattern note set s.p lead 0 vel=70');
    expect(sent).toEqual([]);
    g.flush();
    expect(sent).toEqual([['pattern note set s.p lead 0 vel=70', 'pattern note set s.p lead 3 vel=40']]);
    g.push('m', null);
    g.flush();
    expect(sent.length).toBe(1);
  });
  it('the note diff lists what went and what came per row', () => {
    const a = parsePattern('pattern p steps=8 tpb=2\n  lead: C5 - . E5 . . . .\n  drums: k . s . . . . .').pattern!;
    const b = parsePattern('pattern p steps=8 tpb=2\n  lead: C5 - . . . E5v80 - .\n  drums: k . s . . . . .').pattern!;
    expect(patternNoteDiff(a, b)).toEqual(['lead: − E5 at 3; + E5v80 at 5 (2 steps)']);
  });
});

describe('a channel re-rendered after an edit', () => {
  const SIX = `${SINE}instrument new sq from=square_lead
song new big tempo=110 key=A:minor
song channel add big lead inst=sq
song channel add big pad inst=saw_pad gain=0.5
song channel add big bass inst=triangle_bass
song channel add big arp inst=pluck gain=0.6
song channel add big bell inst=fm_bell gain=0.4
song channel add big drums kit=default
pattern big.a steps=32 tpb=4 bar=8
  lead: A4 . C5 . E5 - . D5 | C5 . B4 . A4 - - . | A4 . C5 . E5 - . G5 | A5 - - . G5 . E5 .
  pad: A3+C4+E4 - - - - - - - | - - - - - - - - | F3+A3+C4 - - - - - - - | G3+B3+D4 - - - - - - -
  bass: A2 . A2 . E2 . A2 . | A2 . A2 . E2 . G2 . | F2 . F2 . C3 . F2 . | G2 . G2 . D3 . G2 .
  arp: A4 C5 E5 C5 A4 C5 E5 C5 | A4 C5 E5 C5 A4 C5 E5 C5 | F4 A4 C5 A4 F4 A4 C5 A4 | G4 B4 D5 B4 G4 B4 D5 B4
  bell: . . . . . . . . | E6 . . . . . . . | . . . . . . . . | D6 . . . . . . .
  drums: k . h . s . h . | k . h k s . h h | k . h . s . h . | k . h k s . h oh
song section add big A a x8
`;
  it('equals a full render, rendering only that channel and only its new notes', () => {
    const lib = library(SIX);
    const parts = new Map<string, Float32Array>();
    const store: PartStore = { get: (k) => parts.get(k) ?? null, put: (k, v) => { parts.set(k, v); } };
    const notes = new Map<string, Float32Array[]>();
    const limiter = [{ value: null }, { value: null }];
    const opts = { instruments: (i: string) => lookupInstrument(lib, i), store, notes, limiter };
    const before = renderSong(lib.songs.get('big')!, opts);
    expect(before.cached).toBe(0);
    const noteCount = notes.size;
    run(lib, 'pattern note move big.a lead 0 note=F4');
    const t0 = performance.now();
    const after = renderSong(lib.songs.get('big')!, opts);
    const ms = performance.now() - t0;
    expect(after.cached).toBe(5);
    expect(notes.size).toBe(noteCount + 1);
    const fresh = renderSong(lib.songs.get('big')!, { instruments: (i) => lookupInstrument(lib, i) });
    expect(samplesHash(joinChannels(after.mix))).toBe(samplesHash(joinChannels(fresh.mix)));
    for (let k = 0; k < fresh.parts.length; k++) expect(samplesHash(joinChannels(after.parts[k]!.channels))).toBe(samplesHash(joinChannels(fresh.parts[k]!.channels)));
    expect(samplesHash(joinChannels(after.mix))).not.toBe(samplesHash(joinChannels(before.mix)));
    expect(after.length / 44100).toBeGreaterThan(35);
    // the loop region the same way (its own memo: the limiter runs over the region twice)
    const loopOpts = { ...opts, mode: 'loop' as const, limiter: [{ value: null }, { value: null }] };
    renderSong(lib.songs.get('big')!, loopOpts);
    run(lib, 'pattern note add big.a bass 3 C3');
    const loopAfter = renderSong(lib.songs.get('big')!, loopOpts);
    const loopFresh = renderSong(lib.songs.get('big')!, { instruments: (i) => lookupInstrument(lib, i), mode: 'loop' });
    expect(samplesHash(joinChannels(loopAfter.mix))).toBe(samplesHash(joinChannels(loopFresh.mix)));
    // a note change re-renders in a fraction of the full render (reported, not held to a number here)
    console.log(`one note change in a ${(after.length / 44100).toFixed(1)} s six-channel song: ${ms.toFixed(0)} ms`);
  }, 120_000); // six renders of a 35 s song; slow when every test file runs at once
});
