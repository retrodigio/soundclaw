import { describe, expect, it } from 'vitest';
import { Library, applyCommand, parse, type LayeredSound } from '@soundclaw/core';
import { dropDeviceCommands, envSketch, mainValues, sketch } from '../src/sound/devices.ts';

function build(script: string): LayeredSound {
  const lib = new Library();
  for (const line of script.split('\n')) { const p = parse(line); if (p.errors.length) throw new Error(p.errors[0]!.message); applyCommand(lib, p.commands[0]!); }
  return lib.get('boom') as LayeredSound;
}
const run = (s: LayeredSound, cmds: string[]): LayeredSound => {
  const lib = new Library();
  lib.set(s.id, s);
  for (const c of cmds) applyCommand(lib, parse(c).commands[0]!);
  return lib.get(s.id) as LayeredSound;
};

const BASE = `sound new boom voice=layered
layer add boom osc wave=sine freq=60 dur=0.3
layer add boom osc wave=white dur=0.2
fx add boom layer=1 filter type=lp cutoff=900
fx add boom layer=1 distort drive=8
fx add boom layer=1 reverb
fx add boom layer=2 delay time=0.1
env boom 1.fx1.cutoff "0:4000 0.3:300@exp"`;

describe('device drops', () => {
  it('reordering within a chain is one fx move', () => {
    const s = build(BASE);
    expect(dropDeviceCommands(s, 1, 1, 1, 3, false)).toEqual(['fx move boom layer=1 1 to=3']);
    expect(dropDeviceCommands(s, 1, 2, 1, 2, false)).toEqual([]);
    // dropped on the track itself (past the last card) it goes to the end
    expect(dropDeviceCommands(s, 1, 1, 1, 4, false)).toEqual(['fx move boom layer=1 1 to=3']);
    expect(dropDeviceCommands(s, 1, 3, 1, 4, false)).toEqual([]);
    const after = run(s, dropDeviceCommands(s, 1, 1, 1, 3, false));
    expect(after.layers[0]!.fx.map((x) => x.kind)).toEqual(['distort', 'reverb', 'filter']);
  });

  it('moving to another layer is a remove and an add with the same parameters and envelopes, in order', () => {
    const s = build(BASE);
    const cmds = dropDeviceCommands(s, 1, 1, 2, 1, false);
    expect(cmds[0]).toMatch(/^fx add boom layer=2 filter /);
    expect(cmds.at(-1)).toBe('fx remove boom layer=1 1');
    expect(cmds.some((c) => c.startsWith('env boom 2.fx1.cutoff'))).toBe(true);
    const after = run(s, cmds);
    expect(after.layers[0]!.fx.map((x) => x.kind)).toEqual(['distort', 'reverb']);
    expect(after.layers[1]!.fx.map((x) => x.kind)).toEqual(['filter', 'delay']);
    expect(after.layers[1]!.fx[0]!.p.cutoff).toBe(s.layers[0]!.fx[0]!.p.cutoff);
    expect(after.layers[1]!.fx[0]!.envs.cutoff).toEqual(s.layers[0]!.fx[0]!.envs.cutoff);
  });

  it('copying keeps the original; dropping on the master chain works too', () => {
    const s = build(BASE);
    const copy = run(s, dropDeviceCommands(s, 1, 2, 2, 9, true));
    expect(copy.layers[0]!.fx).toHaveLength(3);
    expect(copy.layers[1]!.fx.map((x) => x.kind)).toEqual(['delay', 'distort']);
    expect(dropDeviceCommands(s, 1, 2, 2, 9, true).some((c) => c.startsWith('fx remove'))).toBe(false);
    const toMaster = run(s, dropDeviceCommands(s, 1, 3, 'M', 1, false));
    expect(toMaster.master.map((x) => x.kind)).toEqual(['reverb']);
    expect(toMaster.layers[0]!.fx).toHaveLength(2);
  });

  it('a copy into the same chain lands where it was dropped', () => {
    const s = build(BASE);
    const after = run(s, dropDeviceCommands(s, 1, 3, 1, 1, true));
    expect(after.layers[0]!.fx.map((x) => x.kind)).toEqual(['reverb', 'filter', 'distort', 'reverb']);
  });
});

describe('device sketches', () => {
  it('every effect draws a finite path and shows up to three values', () => {
    for (const kind of ['filter', 'distort', 'bitcrush', 'chorus', 'delay', 'reverb', 'compress', 'limit'] as const) {
      const d = sketch(kind, {});
      expect(d, kind).toMatch(/^M/);
      expect(d, kind).not.toMatch(/NaN|Infinity/);
      expect(mainValues(kind, {}).length).toBeGreaterThan(1);
    }
    expect(envSketch(null)).toMatch(/^M/);
    expect(envSketch([{ t: 0, v: 0, curve: 'lin' }, { t: 0.1, v: 1, curve: 'lin' }, { t: 0.5, v: 0, curve: 'exp' }])).not.toMatch(/NaN/);
  });
  it('values read in units', () => {
    expect(mainValues('filter', { type: 'lp', cutoff: 1800, q: 0.7 })[1]).toEqual({ k: 'cutoff', v: '1.8 kHz' });
    expect(mainValues('delay', { time: 0.09 })[0]).toEqual({ k: 'time', v: '90 ms' });
  });
});
