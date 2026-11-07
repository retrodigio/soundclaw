// The layered generators: footstep, ui-click, door, magic. Ranges are data; same name and seed give
// the same sound; every value stays inside the parameter's own range; every sound renders finite.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STYLE, FX_SPECS, MAX_LAYERS, RECIPES, RECIPE_NAMES, RECIPE_UMBRELLAS, UMBRELLAS, analyze, applyCommand, defaultRecipeSeed, isRecipe, layerSpecs, loudnessFor, parse, recipeBody, recipesTable, renderChannels, replay, resolveRecipe, runChecks, serializeSound, soundStyle, specOf,
  type Library, type LayeredSound, type TapeEntry,
} from '../src/index.ts';

const make = (name: string, seed: number): LayeredSound => {
  const lib: Library = new Map();
  for (const c of parse(`sound new s voice=layered preset=${name} seed=${seed}`).commands) applyCommand(lib, c);
  return lib.get('s') as LayeredSound;
};

describe('layered recipes', () => {
  it('are the one-shots, the variants of metal, glass and voice, and the beds wind, rain, fire and crowd, each with its ranges written as data', () => {
    expect(RECIPE_NAMES).toEqual(['footstep', 'ui-click', 'door', 'magic', 'creak', 'bell', 'metal-chain', 'metal-clank', 'glass-shatter', 'glass-clink', 'voice-vowel', 'voice-cluck', 'voice-giggle', 'wind', 'rain', 'fire', 'crowd']);
    expect(RECIPE_UMBRELLAS).toEqual(['metal', 'glass', 'voice']);
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
      for (const seed of make(n, 1).loop ? [1] : [1, 2, 3]) { // (a bed is seconds long and its analysis takes a while)
        const ch = renderChannels(make(n, seed));
        for (const c of ch) expect(c.every((v) => Number.isFinite(v))).toBe(true);
        const secs = ch[0]!.length / 44100;
        expect(secs, `${n} ${seed}`).toBeGreaterThan(0.05);
        expect(secs).toBeLessThan(make(n, seed).loop ? 8.5 : 3.5);
        expect(runChecks(ch, analyze(ch))).toHaveLength(6);
      }
    }
  });

  it('magic is stereo; the others are mono', () => {
    expect(renderChannels(make('magic', 1))).toHaveLength(2);
    for (const n of ['footstep', 'ui-click', 'door', 'creak', 'bell', 'metal-clank', 'voice-vowel'] as const) expect(renderChannels(make(n, 1))).toHaveLength(1);
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

const ONE_SHOTS = RECIPE_NAMES.filter((n) => !RECIPES[n].loop);
const CLASS_OF: Record<string, string> = {
  footstep: 'foley', 'ui-click': 'ui', door: 'foley', magic: 'impact', creak: 'foley', bell: 'music-sting', 'metal-chain': 'foley', 'metal-clank': 'impact',
  'glass-shatter': 'impact', 'glass-clink': 'foley', 'voice-vowel': 'voice', 'voice-cluck': 'voice', 'voice-giggle': 'voice',
};

describe('the one-shot recipes are tuned to their loudness class', () => {
  it('every one-shot recipe names a class, and the sound carries it', () => {
    for (const n of ONE_SHOTS) {
      expect(RECIPES[n].class, n).toBe(CLASS_OF[n]);
      expect(make(n, 1).loudClass, n).toBe(CLASS_OF[n]);
    }
    for (const n of RECIPE_NAMES.filter((x) => RECIPES[x].loop)) expect(make(n, 1).loudClass, n).toBeUndefined();
  });

  it('seeds 1 to 20 of each pass all six checks at the loudness of their class, with a sensible length and 2 to 8 layers', { timeout: 240000 }, () => {
    for (const n of ONE_SHOTS) {
      for (let seed = 1; seed <= 20; seed++) {
        const s = make(n, seed);
        expect(s.layers.length, `${n} ${seed}`).toBeGreaterThanOrEqual(2);
        expect(s.layers.length).toBeLessThanOrEqual(MAX_LAYERS);
        const ch = renderChannels(s);
        for (const c of ch) expect(c.every((v) => Number.isFinite(v))).toBe(true);
        const a = analyze(ch);
        const rule = loudnessFor(s, []);
        expect(rule.className, `${n} ${seed}`).toBe(CLASS_OF[n]);
        expect(Math.abs(a.lufs - rule.target), `${n} ${seed} lufs ${a.lufs.toFixed(1)} vs ${rule.target}`).toBeLessThanOrEqual(rule.tolerance);
        const checks = runChecks(ch, a, soundStyle(s, [], DEFAULT_STYLE));
        expect(checks).toHaveLength(6);
        expect(checks.filter((c) => !c.pass).map((c) => `${n} ${seed} ${c.name}: ${c.value}`)).toEqual([]);
        expect(a.duration, `${n} ${seed}`).toBeGreaterThan(n === 'ui-click' ? 0.06 : 0.1);
        expect(a.duration).toBeLessThan(n === 'bell' ? 3 : n === 'glass-shatter' ? 3.6 : 2.2);
        if (n === 'ui-click') expect(a.duration).toBeLessThanOrEqual(0.2);
        if (n === 'bell') { expect(a.duration).toBeGreaterThan(1.1); }
      }
    }
  });

  it('a footstep has no silent tail: its layers end where their envelopes do', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const a = analyze(renderChannels(make('footstep', seed)));
      expect(a.trailingSilence, `${seed}`).toBeLessThanOrEqual(0.05);
      expect(runChecks(renderChannels(make('footstep', seed)), a).find((c) => c.name === 'tail')!.pass, `${seed}`).toBe(true);
    }
  });

  it('a layer is no longer than its amplitude envelope (a sound without a loop)', () => {
    for (const n of ONE_SHOTS) {
      for (let seed = 1; seed <= 5; seed++) {
        for (const l of make(n, seed).layers) {
          const last = l.amp?.[l.amp.length - 1];
          if (last && last.v === 0) expect(l.p.dur as number, `${n} ${seed}`).toBeLessThanOrEqual(Math.max(0.01, last.t) + 1e-9);
        }
      }
    }
  });
});

describe('the repeated hits and shared draws', () => {
  it('hits fill an amplitude envelope of at most 256 breakpoints, starting at the layer start, with the layers of a variant hitting together', () => {
    for (const n of ['metal-chain', 'glass-shatter', 'voice-cluck', 'voice-giggle', 'creak'] as const) {
      for (let seed = 1; seed <= 20; seed++) {
        const s = make(n, seed);
        const hits = s.layers.filter((l) => l.amp && l.amp.length > 4);
        expect(hits.length, n).toBeGreaterThan(0);
        for (const l of hits) {
          expect(l.amp!.length).toBeLessThanOrEqual(256);
          expect(l.amp![0]!.t).toBe(0);
        }
      }
    }
    const s = make('metal-chain', 4);
    expect(s.layers[1]!.amp!.length).toBe(s.layers[0]!.amp!.length);
    expect(s.layers[1]!.amp![1]!.t).toBe(s.layers[0]!.amp![1]!.t);
  });

  it('the formants of a voice share one pitch, and a vowel picks all its formants together', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = make('voice-vowel', seed);
      const [a, b, c] = s.layers;
      expect(b!.p.freq).toBe(a!.p.freq);
      expect(c!.p.freq).toBe(a!.p.freq);
      const f1 = [730, 530, 270, 570, 300].indexOf(a!.p.cutoff as number);
      expect(f1, `${seed}`).toBeGreaterThanOrEqual(0);
      expect(b!.p.cutoff).toBe([1090, 1840, 2290, 840, 870][f1]);
      expect(c!.p.cutoff).toBe([2440, 2480, 3010, 2410, 2240][f1]);
    }
  });
});

describe('the umbrella names', () => {
  it('metal, glass and voice are recipes: the seed picks a variant, always the same one, and the variants are used by their own names', () => {
    for (const u of RECIPE_UMBRELLAS) {
      expect(isRecipe(u)).toBe(true);
      const picked = new Set<string>();
      for (let seed = 1; seed <= 30; seed++) {
        const v = resolveRecipe(u, seed);
        expect(UMBRELLAS[u] as readonly string[]).toContain(v);
        expect(resolveRecipe(u, seed)).toBe(v);
        picked.add(v);
        expect(recipeBody(u, seed)).toEqual(recipeBody(v, seed));
        expect(recipeBody(u, seed).loudClass).toBe(CLASS_OF[v]);
      }
      expect(picked.size, u).toBe(UMBRELLAS[u].length);
    }
    expect(resolveRecipe('door', 3)).toBe('door');
    expect(defaultRecipeSeed('voice', 'x')).toBe(defaultRecipeSeed('voice', 'x'));
  });

  it('`sound new x voice=layered preset=metal` and `sound generate x glass` make a sound of the variant, with its class', () => {
    const lib: Library = new Map();
    for (const c of parse('sound new x voice=layered preset=metal seed=3\nsound new y voice=layered\nsound generate y glass seed=5').commands) applyCommand(lib, c);
    const x = lib.get('x') as LayeredSound;
    const v = resolveRecipe('metal', 3);
    expect(x.loudClass).toBe(CLASS_OF[v]);
    expect(x.layers).toEqual(make(v, 3).layers);
    const y = lib.get('y') as LayeredSound;
    expect(y.layers).toEqual(make(resolveRecipe('glass', 5), 5).layers);
    expect(parse('sound new z voice=layered preset=nonsense').errors.length).toBeGreaterThan(0);
  });

  it('the umbrellas are named in the generated table', () => {
    for (const u of RECIPE_UMBRELLAS) expect(recipesTable()).toContain(`\`${u}\``);
  });
});

describe('the command reference', () => {
  it('holds the generated tables of the layered voice, word for word (they come from the data)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { LAYER_SPECS, SOURCE_SPECS, FX_SPECS, SOUND_SPECS, FX_KINDS, specsTable } = await import('../src/index.ts');
    const docs = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'commands.md'), 'utf8');
    expect(docs).toContain(recipesTable());
    expect(docs).toContain(specsTable(LAYER_SPECS));
    expect(docs).toContain(specsTable(SOUND_SPECS));
    for (const k of Object.keys(SOURCE_SPECS) as (keyof typeof SOURCE_SPECS)[]) expect(docs, k).toContain(specsTable(SOURCE_SPECS[k]));
    for (const k of FX_KINDS) expect(docs, k).toContain(specsTable(FX_SPECS[k]));
  });
});
