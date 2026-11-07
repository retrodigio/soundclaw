// What the layered editor needs that is not drawing: the commands a person's edits are written as
// (the very text an agent would write), slider scales, envelope point moves, and the rule that
// turns a drag into one command.

import { describe, expect, it } from 'vitest';
import {
  FX_SPECS, KeyedCoalescer, LAYER_SPECS, Rng, addPoint, applyCommand, envCommand, flatEnv, fxSetCommand, isLogScale, layerSetCommand, layerSpecs, movePoint, parse, parseEnv, roundSpec, serializeSound,
  sliderPosition, sliderValue, type LayeredSound, type Library, type Scheduler, type Value,
} from '../src/index.ts';
import { build } from './layered-helpers.ts';

const BASE = 'sound new s voice=layered seed=1\nlayer add s osc dur=0.2\nlayer add s fm dur=0.2\nlayer add s ks\nlayer add s classic\nfx add s layer=1 distort\nfx add s layer=1 reverb\nfx add s chorus\nlayer add s sample sample=x\n'.replace('\nlayer add s sample sample=x', '');

/** What the tape would hold for a command: the normal form applying settles on, else the parsed text. */
function normal(lib: Library, text: string): string {
  const p = parse(text);
  if (p.errors.length) throw new Error(p.errors[0]!.message);
  return applyCommand(lib, p.commands[0]!) ?? p.commands[0]!.text;
}

describe('slider scales', () => {
  it('frequencies and cutoffs run on a log scale, the rest linear; position and value invert each other', () => {
    const freq = layerSpecs('osc').find((s) => s.name === 'freq')!;
    const duty = layerSpecs('osc').find((s) => s.name === 'duty')!;
    const gain = LAYER_SPECS.find((s) => s.name === 'gain')!;
    expect(isLogScale(freq)).toBe(true);
    expect(isLogScale(duty)).toBe(false);
    expect(isLogScale(gain)).toBe(false); // starts at 0
    expect(sliderValue(freq, 0)).toBe(20);
    expect(sliderValue(freq, 1)).toBe(20000);
    expect(sliderValue(freq, 0.5)).toBeCloseTo(632, -1);
    expect(sliderValue(gain, 0.25)).toBe(1);
    for (const sp of [freq, duty, gain, FX_SPECS.delay[0]!]) for (const t of [0, 0.13, 0.5, 0.97, 1]) expect(Math.abs(sliderPosition(sp, sliderValue(sp, t)) - t)).toBeLessThan(0.01);
    expect(roundSpec(freq, 440.123)).toBe(440);
    expect(roundSpec(freq, 5)).toBe(20);
    expect(roundSpec(layerSpecs('fm').find((s) => s.name === 'ops')!, 2.6)).toBe(3);
  });
});

describe('the commands a person\'s edits are written as', () => {
  it('layer, effect and envelope edits are in their normal forms: the line the parser settles on is the line written, for 200 random edits', () => {
    const rng = new Rng(7);
    const lib = build(BASE);
    const s0 = lib.get('s') as LayeredSound;
    for (let i = 0; i < 200; i++) {
      const n = 1 + Math.floor(rng.next() * s0.layers.length);
      const l = (lib.get('s') as LayeredSound).layers[n - 1]!;
      const specs = layerSpecs(l.kind);
      const picked = specs.filter(() => rng.next() < 0.3);
      if (!picked.length) continue;
      const vals: Record<string, Value> = {};
      for (const sp of picked) {
        if (sp.choices) vals[sp.name] = rng.pick(sp.choices);
        else if (sp.text) continue;
        else vals[sp.name] = sliderValue(sp, rng.next());
      }
      if (!Object.keys(vals).length) continue;
      const text = layerSetCommand('s', n, l.kind, vals);
      expect(normal(lib, text)).toBe(text);
      // and an effect edit
      const fxs = (lib.get('s') as LayeredSound).layers[0]!.fx;
      const k = 1 + Math.floor(rng.next() * fxs.length);
      const f = fxs[k - 1]!;
      const fv: Record<string, Value> = {};
      for (const sp of FX_SPECS[f.kind]) if (rng.next() < 0.5) fv[sp.name] = sp.choices ? rng.pick(sp.choices) : sliderValue(sp, rng.next());
      if (Object.keys(fv).length) {
        const ft = fxSetCommand('s', 1, k, f.kind, fv);
        expect(normal(lib, ft)).toBe(ft);
      }
    }
    const master = fxSetCommand('s', null, 1, 'chorus', { mix: 0.25, depth: 2 });
    expect(master).toBe('fx set s 1 depth=2 mix=0.25');
    expect(normal(lib, master)).toBe(master);
  });

  it('an envelope edit is the breakpoints, and a cleared envelope says clear', () => {
    const lib = build(BASE);
    const env = parseEnv('0:100 0.1:400@exp 0.3:80');
    const t = envCommand('s', '1.freq', env);
    expect(t).toBe('env s 1.freq "0:100 0.1:400@exp 0.3:80"');
    expect(normal(lib, t)).toBe(t);
    expect(normal(lib, envCommand('s', '1.freq', null))).toBe('env s 1.freq clear');
    expect(normal(lib, envCommand('s', '1.amp', flatEnv(1, 0.25)))).toBe('env s 1.amp "0:1 0.25:1"');
    expect(normal(lib, envCommand('s', '1.fx1.mix', [{ t: 0, v: 0, curve: 'lin' }, { t: 0.2, v: 1, curve: 'ease' }]))).toBe('env s 1.fx1.mix "0:0 0.2:1@ease"');
  });

  it('the page and the parser agree on a whole editing session: replaying the normal forms gives the same sound', () => {
    const lib = build(BASE);
    const lines: string[] = [];
    for (const t of [layerSetCommand('s', 1, 'osc', { wave: 'saw', freq: 220 }), envCommand('s', '1.gain', parseEnv('0:1 0.1:0.25')), fxSetCommand('s', 1, 2, 'reverb', { size: 0.7 })]) lines.push(normal(lib, t));
    const again = build(BASE);
    for (const l of lines) normal(again, l);
    expect(serializeSound(again.get('s')!)).toBe(serializeSound(lib.get('s')!));
  });
});

describe('breakpoint edits', () => {
  const spec = { min: 20, max: 20000, unit: 'Hz' };
  it('a point moves but never past its neighbours, in whole milliseconds, its value kept in range', () => {
    const env = parseEnv('0:100 0.1:400 0.3:80');
    expect(movePoint(env, 1, 0.2, 500, spec)[1]).toMatchObject({ t: 0.2, v: 500 });
    expect(movePoint(env, 1, 0.9, 500, spec)[1]!.t).toBe(0.299);
    expect(movePoint(env, 1, -1, 500, spec)[1]!.t).toBe(0.001);
    expect(movePoint(env, 0, 0.5, 1e9, spec)[0]).toMatchObject({ t: 0.099, v: 20000 });
    expect(movePoint(env, 2, 5, 3, spec)[2]).toMatchObject({ t: 5, v: 20 });
    expect(movePoint(env, 1, 0.12345, 123.456, spec)[1]).toMatchObject({ t: 0.123, v: 123 });
    expect(env[1]).toMatchObject({ t: 0.1, v: 400 }); // the original is not touched
  });
  it('a point can be added between others, not on top of one', () => {
    const env = parseEnv('0:1 1:0');
    expect(addPoint(env, 0.5, 0.5)!.map((p) => p.t)).toEqual([0, 0.5, 1]);
    expect(addPoint(env, 0.9996, 0.5)).toBeNull();
    expect(addPoint(env, 2, 0.5)!.map((p) => p.t)).toEqual([0, 1, 2]);
  });
});

describe('KeyedCoalescer', () => {
  const fake = () => {
    const timers: { fn: () => void; ms: number; id: number }[] = [];
    let id = 0;
    const sched: Scheduler = { set: (fn, ms) => { const t = { fn, ms, id: ++id }; timers.push(t); return t; }, clear: (h) => { const i = timers.indexOf(h as (typeof timers)[number]); if (i >= 0) timers.splice(i, 1); } };
    return { sched, timers };
  };
  it('100 moves of one control are one send, with the last value, when released', () => {
    const { sched } = fake();
    const sent: Map<string, number>[] = [];
    const c = new KeyedCoalescer<number>((e) => sent.push(e), sched);
    for (let i = 0; i < 100; i++) c.push('L:1:gain', i / 100);
    expect(sent).toHaveLength(0);
    expect(c.value('L:1:gain')).toBe(0.99);
    c.flush();
    expect([...sent[0]!]).toEqual([['L:1:gain', 0.99]]);
    c.flush();
    expect(sent).toHaveLength(1);
  });
  it('a rest of 700 ms sends what is pending; two controls move together in one send; cancel sends nothing', () => {
    const { sched, timers } = fake();
    const sent: Map<string, number>[] = [];
    const c = new KeyedCoalescer<number>((e) => sent.push(e), sched);
    c.push('a', 1); c.push('b', 2);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(700);
    timers[0]!.fn();
    expect([...sent[0]!]).toEqual([['a', 1], ['b', 2]]);
    c.push('a', 3);
    c.cancel();
    timers.length = 0;
    c.flush();
    expect(c.active).toBe(false);
    expect(sent).toHaveLength(1); // cancelled: nothing more was sent
  });
});
