// Restoring an earlier version with commands: one batch that gives the earlier render exactly, for each
// voice, or a reason when no command can.

import { describe, expect, it } from 'vitest';
import { Library, applyCommand, cloneSound, parse, renderKey, restoreCommands, type Sound } from '../src/index.ts';

function lib(script: string): Library {
  const l = new Library();
  for (const c of parse(script).commands) applyCommand(l, c);
  return l;
}
function apply(l: Library, cmds: string[]): void {
  for (const t of cmds) { const p = parse(t); expect(p.errors, t).toEqual([]); applyCommand(l, p.commands[0]!); }
}
/** The sound after `base`, then after `base` and `edits`; restoring the first onto the second must give the first's render. */
function roundTrip(base: string, edits: string): { cmds: string[]; ok: boolean } {
  const l = lib(base);
  const want = cloneSound(l.get('s')!);
  apply(l, parse(edits).commands.map((c) => c.text));
  const now = l.get('s')!;
  const r = restoreCommands(now, want);
  if ('error' in r) throw new Error(r.error);
  apply(l, r.commands);
  return { cmds: r.commands, ok: renderKey(l.get('s')!) === renderKey(want) };
}

describe('restoreCommands', () => {
  it('a classic sound: one sound set of the values that differ', () => {
    const r = roundTrip('sound new s voice=classic preset=pickup seed=1', 'sound set s freq=0.6 decay=0.4\nsound mutate s seed=5');
    expect(r.ok).toBe(true);
    expect(r.cmds).toHaveLength(1);
    expect(r.cmds[0]).toMatch(/^sound set s /);
  });

  it('a tone: frequency, duration and volume', () => {
    const r = roundTrip('sound new s', 'sound set s frequency=880 volume=0.3');
    expect(r).toEqual({ cmds: ['sound set s frequency=440 volume=0.5'], ok: true });
  });

  it('a layered sound: layer values, envelopes, flags, effects, order and the sound settings', () => {
    const base = 'sound new s voice=layered seed=3\nlayer add s osc wave=saw freq=200 dur=0.3\nlayer add s osc wave=white dur=0.2 seed=4\nfx add s layer=1 filter type=lp cutoff=2000\nfx add s reverb size=0.3 mix=0.2\nenv s 1.amp "0:1 0.3:0@exp"';
    const edits = 'layer set s 1 freq=300\nenv s 2.gain "0:1 0.2:0.2"\nlayer mute s 2\nfx set s layer=1 1 cutoff=900\nfx add s layer=2 distort drive=4\nlayer move s 2 to=1\nfx remove s 1\nfx add s delay time=0.1\nsound set s gain=0.7 duration=0.5\nenv s 2.amp clear';
    const r = roundTrip(base, edits);
    expect(r.ok).toBe(true);
    expect(r.cmds.some((c) => c.startsWith('layer move s'))).toBe(true);
  });

  it('a layered sound with a layer added since: it is removed', () => {
    const r = roundTrip('sound new s voice=layered preset=footstep seed=3', 'layer add s osc wave=sine freq=60 dur=0.2');
    expect(r.ok).toBe(true);
    expect(r.cmds[0]).toMatch(/^layer remove s \d+$/);
  });

  it('gives a reason when a layer was removed since, or the voice changed', () => {
    const l = lib('sound new s voice=layered preset=footstep seed=3');
    const want = cloneSound(l.get('s')!);
    apply(l, ['layer remove s 1']);
    expect(restoreCommands(l.get('s')!, want)).toMatchObject({ error: expect.stringMatching(/removed since/) });
    const c = lib('sound new s voice=classic preset=blip seed=1');
    const was = cloneSound(c.get('s')!);
    apply(c, ['sound layer-up s']);
    expect(restoreCommands(c.get('s')!, was)).toMatchObject({ error: expect.stringMatching(/no command turns it back/) });
  });

  it('nothing to do when the renders are the same (a status or a moment does not count)', () => {
    const l = lib('sound new s voice=classic preset=blip seed=1');
    const was: Sound = cloneSound(l.get('s')!);
    apply(l, ['sound mark s approved', 'sound set s moment="a coin"']);
    expect(restoreCommands(l.get('s')!, was)).toEqual({ commands: [] });
  });
});
