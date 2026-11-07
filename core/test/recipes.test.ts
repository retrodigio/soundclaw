// The layered generators: footstep, ui-click, door, magic. Ranges are data; same name and seed give
// the same sound; every value stays inside the parameter's own range; every sound renders finite.

import { describe, expect, it } from 'vitest';
import {
  FX_SPECS, MAX_LAYERS, RECIPES, RECIPE_NAMES, analyze, applyCommand, layerSpecs, parse, recipeBody, recipesTable, renderChannels, replay, runChecks, serializeSound, specOf,
  type Library, type LayeredSound, type TapeEntry,
} from '../src/index.ts';

const make = (name: string, seed: number): LayeredSound => {
  const lib: Library = new Map();
  for (const c of parse(`sound new s voice=layered preset=${name} seed=${seed}`).commands) applyCommand(lib, c);
  return lib.get('s') as LayeredSound;
};

describe('layered recipes', () => {
  it('are footstep, ui-click, door and magic, each with its ranges written as data', () => {
    expect(RECIPE_NAMES).toEqual(['footstep', 'ui-click', 'door', 'magic']);
    for (const n of RECIPE_NAMES) expect(RECIPES[n].help.length).toBeGreaterThan(5);
    const t = recipesTable();
    for (const n of RECIPE_NAMES) expect(t).toContain(`\`${n}\``);
  });

  it('the same recipe and seed give the same sound; another seed another one', () => {
    for (const n of RECIPE_NAMES) {
      expect(recipeBody(n, 5)).toEqual(recipeBody(n, 5));
      expect(JSON.stringify(recipeBody(n, 6))).not.toBe(JSON.stringify(recipeBody(n, 5)));
    }
  });

  it('every parameter, envelope point and effect of 60 seeds stays inside its own range, and the sound renders', () => {
    for (const n of RECIPE_NAMES) {
      for (let seed = 0; seed < 60; seed++) {
        const s = make(n, seed);
        expect(s.layers.length, `${n} ${seed}`).toBeGreaterThan(0);
        expect(s.layers.length).toBeLessThanOrEqual(MAX_LAYERS);
        for (const l of s.layers) {
          for (const sp of layerSpecs(l.kind)) {
            const v = l.p[sp.name];
            if (typeof v === 'number') { expect(v, `${n} ${seed} ${sp.name}`).toBeGreaterThanOrEqual(sp.min); expect(v).toBeLessThanOrEqual(sp.max); }
          }
          const envs = [...Object.entries(l.envs).map(([k, e]) => [specOf(layerSpecs(l.kind), k)!, e] as const), ...(l.amp ? [[{ min: 0, max: 4 }, l.amp] as const] : [])];
          for (const [sp, e] of envs) {
            e.forEach((p, i) => { expect(p.v).toBeGreaterThanOrEqual(sp.min); expect(p.v).toBeLessThanOrEqual(sp.max); if (i) expect(p.t).toBeGreaterThan(e[i - 1]!.t); });
          }
          for (const f of l.fx) for (const sp of FX_SPECS[f.kind]) { const v = f.p[sp.name]; if (typeof v === 'number') { expect(v).toBeGreaterThanOrEqual(sp.min); expect(v).toBeLessThanOrEqual(sp.max); } }
        }
      }
    }
  });

  it('render finite samples, in a sensible length, with the checks running', () => {
    for (const n of RECIPE_NAMES) {
      for (const seed of [1, 2, 3]) {
        const ch = renderChannels(make(n, seed));
        for (const c of ch) expect(c.every((v) => Number.isFinite(v))).toBe(true);
        const secs = ch[0]!.length / 44100;
        expect(secs, `${n} ${seed}`).toBeGreaterThan(0.05);
        expect(secs).toBeLessThan(3.5);
        expect(runChecks(ch, analyze(ch))).toHaveLength(6);
      }
    }
  });

  it('magic is stereo; the others are mono', () => {
    expect(renderChannels(make('magic', 1))).toHaveLength(2);
    for (const n of ['footstep', 'ui-click', 'door'] as const) expect(renderChannels(make(n, 1))).toHaveLength(1);
  });

  it('`sound generate` re-rolls a layered sound in place, and a classic category gives it one classic layer; a recipe needs a layered sound', () => {
    const lib: Library = new Map();
    const run = (t: string) => { const p = parse(t); if (p.errors.length) throw new Error(p.errors[0]!.message); for (const c of p.commands) applyCommand(lib, c); };
    run('sound new s voice=layered preset=door seed=1\nsound generate s door seed=2');
    expect(serializeSound(lib.get('s')!)).toBe(serializeSound(make('door', 2)));
    run('sound generate s pickup seed=3');
    expect((lib.get('s') as LayeredSound).layers.map((l) => l.kind)).toEqual(['classic']);
    run('sound new c voice=classic');
    expect(() => run('sound generate c door seed=1')).toThrow(/layered recipe/);
    expect(() => run('sound new d voice=classic preset=door')).toThrow();
  });

  it('a recipe sound replays from the tape', () => {
    const entries: TapeEntry[] = [{ seq: 1, by: 'agent:claude', group: 'g1', cmd: 'sound new s voice=layered preset=magic seed=9' }, { seq: 2, by: 'agent:claude', group: 'g2', cmd: 'sound generate s door seed=4' }];
    const r = replay(entries);
    expect(r.problems).toEqual([]);
    expect(serializeSound(r.library.get('s')!)).toBe(serializeSound(make('door', 4)));
  });
});
