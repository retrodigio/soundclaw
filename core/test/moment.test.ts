// The moment: the situation in the game a sound (or a set) is for. It is words on the document, set by
// commands with a normal form, kept through a replay and printed in the files; rendering never reads
// it, so every golden hash stays as it is with a moment added.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Library, applyCommand, classicWav, joinChannels, makePatch, newClassicSound, newSound, parse, renderChannels, renderClassic, renderKey, renderSound, replay, samplesHash, serializeSet, serializeSound, sha256Hex, type LayeredSound, type Sound, type TapeEntry } from '../src/index.ts';
import { TABLE as CLASSIC_TABLE, tablePatch } from './classic-table.ts';
import { TABLE as LAYERED_TABLE } from './layered-golden-table.ts';
import { BANK } from './layered-helpers.ts';

const MOMENT = 'The player walks slowly across a meadow at night. Steps repeat every 0.4 s under quiet music.';

function run(lib: Library, script: string): string[] {
  const p = parse(script);
  if (p.errors.length) throw new Error(p.errors[0]!.message);
  return p.commands.map((c) => applyCommand(lib, c) ?? c.text);
}

describe('the moment field', () => {
  it('is set by sound set and set moment, with a normal form, and cleared with none', () => {
    const p = parse(`sound set step moment="${MOMENT}"\nsound set step moment=none\nset moment steps "a door at the end of a long hall"\nset moment steps none\nsound set step freq=0.3 moment="say \\"hi\\""`);
    expect(p.errors).toEqual([]);
    expect(p.commands.map((c) => c.text)).toEqual([
      `sound set step moment="${MOMENT}"`,
      'sound set step moment=none',
      'set moment steps "a door at the end of a long hall"',
      'set moment steps none',
      'sound set step freq=0.3 moment="say \\"hi\\""',
    ]);
    // the normal form parses to itself
    for (const c of p.commands) expect(parse(c.text).commands[0]!.text).toBe(c.text);
  });

  it('refuses an empty or overlong moment, and a set moment without quotes', () => {
    expect(parse('sound set a moment=""').errors[0]!.message).toMatch(/the moment says what happens in the game/);
    expect(parse(`sound set a moment="${'x'.repeat(401)}"`).errors[0]!.message).toMatch(/at most 400 characters/);
    expect(parse('set moment steps').errors[0]!.message).toMatch(/give the moment in quotes/);
    expect(parse('set moment steps "a" "b"').errors[0]!.message).toMatch(/give the moment in quotes/);
  });

  it('lands on every voice and on a set, is written in the files, and replays from the tape', () => {
    const lib = new Library();
    const cmds = run(lib, `sound new t\nsound new c voice=classic preset=blip seed=2\nsound new l voice=layered preset=footstep seed=3\nset new steps from=l count=2 seed=1
sound set t moment="a menu opens"\nsound set c moment="a coin lands" volume=0.4\nsound set l moment="${MOMENT}"\nset moment steps "walking on grass"`);
    expect(lib.get('t')!.moment).toBe('a menu opens');
    expect(lib.get('c')!.moment).toBe('a coin lands');
    expect((lib.get('c') as Extract<Sound, { voice: 'classic' }>).patch.volume).toBe(0.4);
    expect(lib.get('l')!.moment).toBe(MOMENT);
    expect(lib.sets.get('steps')!.moment).toBe('walking on grass');
    expect(serializeSound(lib.get('l')!)).toContain(`moment "${MOMENT}"\nstatus draft`);
    expect(serializeSet(lib.sets.get('steps')!)).toContain('moment "walking on grass"');
    // the tape replays to the same documents
    const tape: TapeEntry[] = cmds.map((cmd, i) => ({ seq: i + 1, group: 'g1', by: 'agent:claude', cmd }));
    const back = replay(tape);
    expect(back.problems).toEqual([]);
    expect(back.library.get('l')!.moment).toBe(MOMENT);
    expect(back.library.sets.get('steps')!.moment).toBe('walking on grass');
    run(lib, 'sound set l moment=none\nset moment steps none');
    expect(lib.get('l')!.moment).toBeUndefined();
    expect(lib.sets.get('steps')!.moment).toBeUndefined();
    expect(serializeSound(lib.get('l')!)).not.toContain('moment');
  });

  it('leaves every layered golden hash and render key unchanged', () => {
    const golden = JSON.parse(readFileSync(join(import.meta.dirname, 'layered-golden.json'), 'utf8')) as Record<string, { hash: string }>;
    for (const [name, script] of Object.entries(LAYERED_TABLE)) {
      const lib = new Library();
      run(lib, script);
      const before = renderKey(lib.get('s')!);
      run(lib, `sound set s moment="${MOMENT}"`);
      const s = lib.get('s') as LayeredSound;
      expect(s.moment, name).toBe(MOMENT);
      expect(renderKey(s), name).toBe(before);
      expect(samplesHash(joinChannels(renderChannels(s, BANK))), name).toBe(golden[name]!.hash);
    }
  });

  it('leaves every classic golden hash, the tone goldens and the render keys unchanged', () => {
    const golden = JSON.parse(readFileSync(join(import.meta.dirname, 'classic-golden.json'), 'utf8')) as Record<string, { exact: string; wav: string }>;
    const bytes = (x: Float64Array): Uint8Array => new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    for (const t of CLASSIC_TABLE) {
      const lib = new Library([['c', newClassicSound('c', tablePatch(t))]]);
      const key = renderKey(lib.get('c')!);
      run(lib, `sound set c moment="${MOMENT}"`);
      const s = lib.get('c') as Extract<Sound, { voice: 'classic' }>;
      expect(renderKey(s), t.name).toBe(key);
      const x = renderClassic(s.patch);
      expect(sha256Hex(bytes(x)), t.name).toBe(golden[t.name]!.exact);
      expect(sha256Hex(classicWav(x)), t.name).toBe(golden[t.name]!.wav);
    }
    const lib = new Library([['t', newSound('t')]]);
    run(lib, `sound set t moment="${MOMENT}"`);
    expect(samplesHash(renderSound(lib.get('t')!))).toBe('877fc91299a390546019da5381fa9cd79ecdd4a4cff5d24fb64a178a0b114370');
    expect(renderKey(lib.get('t')!)).toBe(renderKey(newSound('t')));
    expect(renderKey({ ...newClassicSound('x', makePatch({})), moment: 'a' })).toBe(renderKey(newClassicSound('x', makePatch({}))));
  });
});
