import { describe, expect, it } from 'vitest';
import { channelEvents, formatPattern, parsePattern, noteLabel, parseNote, parseKey, parseRange } from '../src/index.ts';

const EXAMPLE = `pattern verse1 steps=16 tpb=4
  lead: C5 . E5 . G5 - - . | A4 . . . G4 . E4 .
  bass: C3 . . . C3 . . . | A2 . . . G2 . . .
  drum: k . h . s . h . | k k h . s . h h
`;

const ok = (text: string) => {
  const r = parsePattern(text);
  expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
  return r.pattern!;
};
const err = (text: string) => parsePattern(text).errors[0]!;

describe('the pattern text', () => {
  it('parses the reference example: steps, bars from the | groups, three channels', () => {
    const p = ok(EXAMPLE);
    expect(p.name).toBe('verse1');
    expect([p.steps, p.tpb, p.bar]).toEqual([16, 4, 8]);
    expect(p.channels.map((c) => c.name)).toEqual(['lead', 'bass', 'drum']);
    const ev = channelEvents(p.channels[0]!);
    // C5 at step 0, E5 at 2, G5 at 4 held for 3 steps (G5 - -)
    expect(ev.map((e) => [e.step, e.len])).toEqual([[0, 1], [2, 1], [4, 3], [8, 1], [12, 1], [14, 1]]);
    expect(ev[2]!.notes![0]!.midi).toBe(parseNote('G5'));
    expect(channelEvents(p.channels[2]!).map((e) => e.drum)).toEqual(['k', 'h', 's', 'h', 'k', 'k', 'h', 's', 'h', 'h']);
  });

  it('the normal form is aligned, writes bar in the header, and is stable: format(parse(format(parse(x)))) = format(parse(x))', () => {
    const once = formatPattern(ok(EXAMPLE));
    expect(once.split('\n')[0]).toBe('pattern verse1 steps=16 tpb=4 bar=8');
    expect(formatPattern(ok(once))).toBe(once);
    // every row has the same width: the columns line up
    const rows = once.trimEnd().split('\n').slice(1);
    expect(new Set(rows.map((r) => r.length)).size).toBe(1);
  });

  it('notes carry velocity, an accidental mark and effects; the normal form drops the default velocity', () => {
    const p = ok('pattern x steps=4 tpb=4\n  lead: C5v100 E5v80~slide G#4!~vib(6,0.5) A3~arp(0,4,7)\n');
    const [a, b, c, d] = channelEvents(p.channels[0]!).map((e) => e.notes![0]!);
    expect(a!.vel).toBe(100);
    expect([b!.vel, b!.fx.slide]).toEqual([80, true]);
    expect([c!.accidental, c!.fx.vib]).toEqual([true, { rate: 6, depth: 0.5 }]);
    expect(d!.fx.arp).toEqual([0, 4, 7]);
    expect(formatPattern(p)).toContain('C5 E5v80~slide G#4!~vib(6,0.5) A3~arp(0,4,7)');
  });

  it('~vib alone is the default vibrato and keeps its short form; a flat stays a flat in the normal form, a sharp a sharp', () => {
    const p = ok('pattern x steps=2 tpb=4\n  lead: Db4~vib Bb3\n');
    expect(formatPattern(p)).toContain('Db4~vib Bb3');
    expect(formatPattern(ok('pattern x steps=2 tpb=4\n  lead: C#4~vib A#3\n'))).toContain('C#4~vib A#3');
  });

  it('a chord joins notes with +, and a slide knows the note it comes from', () => {
    const p = ok('pattern x steps=4 tpb=4\n  pad: C4+E4+G4 - . .\n  lead: C5 E5~slide . G5~slide\n');
    const chord = channelEvents(p.channels[0]!)[0]!;
    expect(chord.notes!.map((n) => noteLabel(n.midi))).toEqual(['C4', 'E4', 'G4']);
    expect(chord.len).toBe(2);
    const lead = channelEvents(p.channels[1]!);
    expect(lead[1]!.slideFrom).toBe(parseNote('C5'));
    expect(lead[2]!.slideFrom).toBeNull(); // a rest came between
  });

  it('a note list is another way to write the same grid, and prints as the grid', () => {
    const grid = ok('pattern x steps=8 tpb=4\n  lead: C5 - . . E5v90 . G5 .\n');
    const list = ok('pattern x steps=8 tpb=4\n  lead= 0:C5*2 4:E5v90 6:G5\n');
    expect(formatPattern(list)).toBe(formatPattern(grid));
  });

  it('drum hits are lower-case words with their own velocity', () => {
    const p = ok('pattern x steps=3 tpb=4\n  d: k hat sv60\n');
    expect(channelEvents(p.channels[0]!).map((e) => [e.drum, e.vel])).toEqual([['k', 100], ['hat', 100], ['s', 60]]);
  });

  it('comments and blank lines are ignored; # inside a note (C#5) is not a comment', () => {
    const p = ok('# the verse\n\npattern x steps=2 tpb=4\n  # a comment\n  lead: C#5 D#5 # trailing\n');
    expect(formatPattern(p)).toContain('C#5 D#5');
  });

  it.each([
    ['a row of the wrong length', 'pattern x steps=4 tpb=4\n  lead: C5 . E5\n', 2, /3 steps but the pattern has steps=4 \(1 missing\)/],
    ['too many steps', 'pattern x steps=2 tpb=4\n  lead: C5 . E5\n', 2, /1 too many/],
    ['a bad note name', 'pattern x steps=2 tpb=4\n  lead: C5 H5\n', 2, /'H5' is not a drum hit|not a note/],
    ['a bad note', 'pattern x steps=2 tpb=4\n  lead: C5 Q5\n', 2, /'Q5' is not a note/],
    ['velocity 0', 'pattern x steps=2 tpb=4\n  lead: C5v0 .\n', 2, /velocity is 1 to 127/],
    ['velocity too high', 'pattern x steps=2 tpb=4\n  lead: C5v200 .\n', 2, /velocity is 1 to 127/],
    ['a hold with nothing before it', 'pattern x steps=2 tpb=4\n  lead: - C5\n', 2, /holds the note before it, and there is none/],
    ['a hold after a rest', 'pattern x steps=3 tpb=4\n  lead: C5 . -\n', 2, /a rest comes before it/],
    ['a hold after a drum', 'pattern x steps=2 tpb=4\n  d: k -\n', 2, /drum hit is one step/],
    ['a bad effect', 'pattern x steps=2 tpb=4\n  lead: C5~wobble .\n', 2, /no effect '~wobble'/],
    ['a bad arp', 'pattern x steps=2 tpb=4\n  lead: C5~arp(0) .\n', 2, /2 to 8 whole semitone offsets/],
    ['a | with no space', 'pattern x steps=4 tpb=4\n  lead: C5 .| E5 .\n', 2, /space on both sides of \|/],
    ['unequal bars', 'pattern x steps=6 tpb=4\n  lead: C5 . | E5 . . .\n', 2, /different lengths/],
    ['no length', 'pattern x tpb=4\n  lead: C5 .\n', 1, /give the length: steps=<n>/],
    ['two rows of one channel', 'pattern x steps=1 tpb=4\n  lead: C5\n  lead: D5\n', 3, /twice/],
    ['a note list step outside', 'pattern x steps=4 tpb=4\n  lead= 9:C5\n', 2, /outside the pattern/],
    ['overlapping list notes', 'pattern x steps=4 tpb=4\n  lead= 0:C5*3 2:E5\n', 2, /taken by another note/],
    ['a note past the end', 'pattern x steps=4 tpb=4\n  lead= 3:C5*3\n', 2, /runs past the end/],
  ])('reports %s with its line and column', (_n, text, line, msg) => {
    const e = err(text);
    expect(e.line).toBe(line);
    expect(e.col).toBeGreaterThanOrEqual(1);
    expect(e.message).toMatch(msg);
  });

  it('the column points at the bad word', () => {
    const e = err('pattern x steps=3 tpb=4\n  lead: C5 . Q5\n');
    expect([e.line, e.col]).toEqual([2, 14]);
  });
});

describe('notes and scales', () => {
  it('note names and MIDI numbers agree (C4 = 60, A4 = 69, C-1 = 0)', () => {
    expect([parseNote('C4'), parseNote('A4'), parseNote('C-1'), parseNote('G9'), parseNote('Db3')]).toEqual([60, 69, 0, 127, 49]);
    expect(parseNote('H4')).toBeNull();
    expect(noteLabel(61)).toBe('C#4');
  });

  it('keys and ranges', () => {
    expect(parseKey('A:minor').classes).toEqual([9, 11, 0, 2, 4, 5, 7]);
    expect(() => parseKey('A:wobble')).toThrow(/no mode/);
    expect(parseRange('C3-C6')).toEqual([48, 84]);
    expect(parseRange('C6-C3')).toBeNull();
  });
});
