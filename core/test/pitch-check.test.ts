// The instrument's pitch rule for render-match: full (the note), class (the pitch class, octave
// ignored: a bell's inharmonic partials make a pitch tracker hear an octave off) or onset (timing only).

import { describe, expect, it } from 'vitest';
import { Library, applyCommand, builtinInstruments, builtinTable, lookupInstrument, parse, pitchCheckOf, renderMatch, renderSong, serializeInstrument, songReport, DEFAULT_STYLE } from '../src/index.ts';

function tape(lib: Library, script: string): void {
  const p = parse(script);
  if (p.errors.length) throw new Error(p.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join('; '));
  for (const c of p.commands) applyCommand(lib, c);
}

const BELL_SONG = (inst: string) => `song new b tempo=120 key=C:major
song channel add b lead inst=${inst}
pattern b.p steps=16 tpb=4
  lead: C5 - - - E5 - - - G5 - - - C6 - - -
song section add b x p
`;

function match(lib: Library) {
  const s = lib.songs.get('b')!;
  const r = renderSong(s, { instruments: (i) => lookupInstrument(lib, i) });
  return renderMatch(s, r, (i) => lookupInstrument(lib, i)).check;
}

describe('pitch-check', () => {
  it('the built-in bell is checked by pitch class; others by the full note', () => {
    expect(pitchCheckOf(builtinInstruments().fm_bell)).toBe('class');
    expect(pitchCheckOf(builtinInstruments().square_lead)).toBe('full');
    expect(builtinTable()).toMatch(/\| `fm_bell` .*\| class \|/);
  });
  it('the bell passes render-match under its class rule and fails as full (heard an octave low)', () => {
    const lib = new Library();
    tape(lib, BELL_SONG('fm_bell'));
    expect(match(lib).pass).toBe(true);
    tape(lib, 'instrument new bell2 from=fm_bell\ninstrument set bell2 pitch-check=full\nsong channel set b lead inst=bell2');
    const full = match(lib);
    expect(full.pass).toBe(false);
    expect(full.ranges[0]!.note).toMatch(/wrong octave/);
    tape(lib, 'instrument set bell2 pitch-check=onset');
    expect(match(lib).pass).toBe(true);
  });
  it('class still catches a wrong pitch class', () => {
    const lib = new Library();
    // an instrument tuned a fifth off (root says A4, the voice sounds E5) is caught by class as by full
    tape(lib, 'instrument new off from=square_lead\ninstrument set off root=D4 pitch-check=class\n' + BELL_SONG('off'));
    const c = match(lib);
    expect(c.pass).toBe(false);
    expect(c.ranges[0]!.note).toMatch(/wrong pitch/);
  });
  it('is written in the normal form and the instrument file, and refused when unknown', () => {
    const lib = new Library();
    const p = parse('instrument new x from=fm_bell\ninstrument set x pitch-check=onset');
    expect(p.commands[1]!.text).toBe('instrument set x pitch-check=onset');
    for (const c of p.commands) applyCommand(lib, c);
    expect(serializeInstrument(lib.instruments.get('x')!)).toMatch(/^pitch-check onset$/m);
    tape(lib, 'instrument set x pitch-check=full');
    expect(serializeInstrument(lib.instruments.get('x')!)).not.toMatch(/pitch-check/);
    expect(parse('instrument set x pitch-check=loose').errors[0]!.message).toMatch(/pitch-check is full .*class .*onset/);
  });
  it('the item-get stinger plays the bell and passes every check in six keys', () => {
    for (const key of ['C:major', 'D:major', 'A:minor', 'F#:dorian', 'G:minor', 'B:major']) {
      const lib = new Library();
      tape(lib, `song new st kind=stinger template=item-get key=${key}`);
      const s = lib.songs.get('st')!;
      expect(s.channels.find((c) => c.name === 'lead')!.inst).toBe('fm_bell');
      const full = renderSong(s, { instruments: (i) => lookupInstrument(lib, i) });
      const rep = songReport({ song: s, full, loop: null, style: DEFAULT_STYLE, instruments: (i) => lookupInstrument(lib, i) });
      const failing = rep.checks.filter((c) => !c.pass && !c.advisory && !c.skipped).map((c) => `${c.name}: ${c.value}`);
      expect(failing, key).toEqual([]);
    }
  });
});
