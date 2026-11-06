import { describe, expect, it } from 'vitest';
import { parse, applyCommand, type Library } from '../src/index.ts';

const ok = (text: string) => {
  const r = parse(text);
  expect(r.errors, text).toEqual([]);
  return r.commands;
};

describe('the command language', () => {
  it('parses lines and ;, drops comments and blank lines, and writes the normal form', () => {
    const c = ok(`# a comment\n\nsound new beep ; sound set beep frequency=880.50 volume=.25   # tail\nsound mark beep rejected "too harsh; softer"`);
    expect(c.map((x) => x.text)).toEqual([
      'sound new beep',
      'sound set beep frequency=880.5 volume=0.25',
      'sound mark beep rejected "too harsh; softer"',
    ]);
  });

  it('reports every problem with line and column, and says what is allowed', () => {
    const r = parse('sound new Beep\nsound set beep frequency=5\nsound set beep pitch=1\nsound set beep volume=loud\nfrobnicate\nsound set x frequency=440 frequency=450\nsound mark beep liked');
    expect(r.errors.map((e) => `${e.line}:${e.col} ${e.message}`)).toEqual([
      expect.stringMatching(/^1:11 'Beep' is not a sound id/),
      '2:16 frequency must be between 20 and 20000 Hz (got 5)',
      expect.stringMatching(/^3:16 no parameter 'pitch' \(parameters: frequency, duration, volume\)/),
      "4:16 volume: 'loud' is not a number",
      expect.stringMatching(/^5:1 unknown command 'frobnicate'/),
      '6:27 frequency is set twice in one command',
      '7:17 sound mark: the mark is approved, rejected or draft',
    ]);
  });

  it('an unclosed quote is an error', () => {
    expect(parse('sound mark a approved "oops').errors[0]!.message).toMatch(/not closed/);
  });

  it('undo and redo take group= or by=, not both', () => {
    expect(ok('undo')[0]!.text).toBe('undo');
    expect(ok('undo group=g3')[0]!.text).toBe('undo group=g3');
    expect(ok('redo by=human:ana')[0]!.text).toBe('redo by=human:ana');
    expect(parse('undo group=g1 by=agent:claude').errors[0]!.message).toMatch(/not both/);
    expect(parse('undo group=3').errors[0]!.message).toMatch(/not a group/);
    expect(parse('undo by=ana').errors[0]!.message).toMatch(/not an author/);
  });
});

describe('applying commands', () => {
  it('new, set and mark change the library; a bad target is an error', () => {
    const lib: Library = new Map();
    for (const c of ok('sound new a\nsound set a frequency=220\nsound mark a approved')) applyCommand(lib, c);
    expect(lib.get('a')).toMatchObject({ frequency: 220, duration: 0.5, status: 'approved' });
    expect(() => applyCommand(lib, ok('sound new a')[0]!)).toThrow(/exists already/);
    expect(() => applyCommand(lib, ok('sound set b volume=1')[0]!)).toThrow(/no sound 'b'/);
  });
});
