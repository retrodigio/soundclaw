// Generators, mutate and the classic commands: seeded, deterministic, ranges written down in data.

import { describe, expect, it } from 'vitest';
import {
  CATEGORIES, CATEGORY_NAMES, CLASSIC_FIELDS, Rng, applyCommand, categoriesTable, classicField, formatPatchNamed, generate, makePatch, mutate, parse, renderClassic, replay, samplesHash,
  serializeSound, sha256Hex, type ClassicSound, type Library, type Rule, type Rules, type TapeEntry,
} from '../src/index.ts';

const hash = (x: Float64Array) => sha256Hex(new Uint8Array(x.buffer)).slice(0, 16);

describe('the PRNG', () => {
  it('is a fixed integer sequence: the same seed gives the same numbers, in [0, 1)', () => {
    const a = new Rng(1), b = new Rng(1);
    const xs = Array.from({ length: 5 }, () => a.next());
    expect(xs).toEqual(Array.from({ length: 5 }, () => b.next()));
    expect(xs.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(new Rng(2).next()).not.toBe(xs[0]);
    expect(xs[0]).toBe(0.6270739405881613); // mulberry32(1): pinned
  });
});

describe('generators by category', () => {
  const ranges = (r: Rule): [number, number] => (typeof r === 'number' ? [r, r] : Array.isArray(r) ? [r[0]!, r[1]!] : [Math.min(...(r as { pick: number[] }).pick), Math.max(...(r as { pick: number[] }).pick)]);

  it('has the seven categories, each with its ranges written down as data', () => {
    expect(CATEGORY_NAMES).toEqual(['pickup', 'laser', 'explosion', 'powerup', 'hit', 'jump', 'blip']);
    for (const n of CATEGORY_NAMES) expect(CATEGORIES[n].help.length).toBeGreaterThan(5);
    const t = categoriesTable();
    for (const n of CATEGORY_NAMES) expect(t).toContain(`\`${n}\``);
  });

  it('the same category and seed give the same patch; another seed another one; every value inside the written ranges', () => {
    for (const cat of CATEGORY_NAMES) {
      const a = generate(cat, 7), b = generate(cat, 7);
      expect(a).toEqual(b);
      expect(formatPatchNamed(generate(cat, 8))).not.toBe(formatPatchNamed(a));
      const c = CATEGORIES[cat];
      const alternatives: Rules[] = [c.always, ...((c as { one?: { rules: Rules }[] }).one ?? []).map((o) => o.rules), ...((c as { maybe?: { rules: Rules }[] }).maybe ?? []).map((m) => m.rules)];
      for (let seed = 0; seed < 120; seed++) {
        const p = generate(cat, seed);
        for (const f of CLASSIC_FIELDS) {
          const rules = alternatives.map((r) => (r as Record<string, Rule | undefined>)[f.name]).filter((r): r is Rule => r !== undefined);
          if (!rules.length) { expect(p[f.name], `${cat} seed ${seed} ${f.name} keeps its default`).toBe(f.default); continue; }
          const lo = Math.min(...rules.map((r) => ranges(r)[0])) - 0.0006, hi = Math.max(...rules.map((r) => ranges(r)[1])) + 0.0006;
          // a parameter some branch leaves out may also stay at its default
          expect(p[f.name] >= lo && p[f.name] <= hi || p[f.name] === f.default, `${cat} seed ${seed} ${f.name}=${p[f.name]}`).toBe(true);
        }
      }
    }
  });

  it('are pinned: the patch and the samples a category and seed make today', () => {
    const got = Object.fromEntries(CATEGORY_NAMES.map((c) => [c, hash(renderClassic(generate(c, 1)))]));
    expect(formatPatchNamed(generate('laser', 1))).toBe(PINNED.laser);
    expect(formatPatchNamed(generate('explosion', 1))).toBe(PINNED.explosion);
    expect(formatPatchNamed(generate('blip', 1))).toBe(PINNED.blip);
    expect(got).toEqual(PINNED.hashes);
  });

  it('values are rounded to three decimals, so they survive the single-patch text exactly', () => {
    for (const cat of CATEGORY_NAMES) for (let s = 0; s < 20; s++) for (const f of CLASSIC_FIELDS) {
      const v = generate(cat, s)[f.name];
      expect(Math.round(v * 1000) / 1000).toBe(v);
    }
  });

  it('explosions are noise; pickups are square; lasers fall (a negative slide)', () => {
    for (let s = 0; s < 30; s++) {
      expect(generate('explosion', s).wave).toBe(3);
      expect(generate('pickup', s).wave).toBe(0);
      expect(generate('laser', s).slide).toBeLessThan(0);
      expect(generate('powerup', s).slide).toBeGreaterThan(0);
    }
  });
});

const PINNED = {
  laser: "wave=2,attack=0,sustain=0.225,punch=0.298,decay=0.001,freq=0.984,minFreq=0.228,slide=-0.227,deltaSlide=0,vibratoDelay=0,vibratoDepth=0,vibratoSpeed=0,changeAmount=0,changeSpeed=0,duty=0,dutySweep=0,repeatSpeed=0,phaserOffset=0,phaserSweep=0,lowPass=1,lowPassSweep=0,resonance=0,highPass=0.042,highPassSweep=0,volume=0.5",
  explosion: "wave=3,attack=0,sustain=0.288,punch=0.202,decay=0.264,freq=0.786,minFreq=0,slide=-0.344,deltaSlide=0,vibratoDelay=0,vibratoDepth=0.696,vibratoSpeed=0.273,changeAmount=0,changeSpeed=0,duty=0,dutySweep=0,repeatSpeed=0,phaserOffset=0,phaserSweep=0,lowPass=1,lowPassSweep=0,resonance=0,highPass=0,highPassSweep=0,volume=0.5",
  blip: "wave=1,attack=0,sustain=0.1,punch=0,decay=0.105,freq=0.592,minFreq=0,slide=0,deltaSlide=0,vibratoDelay=0,vibratoDepth=0,vibratoSpeed=0,changeAmount=0,changeSpeed=0,duty=0,dutySweep=0,repeatSpeed=0,phaserOffset=0,phaserSweep=0,lowPass=1,lowPassSweep=0,resonance=0,highPass=0.1,highPassSweep=0,volume=0.5",
  hashes: {
    "pickup": "1c08c3724e870ba8",
    laser: "be64f626936fc64a",
    explosion: "c2c05795b7e9bb1b",
    "powerup": "a65364080ebc5a41",
    "hit": "435bc09a4c72b677",
    "jump": "91a9d49df9f6f975",
    blip: "5a6fa8162cddd044"
  }
};

describe('mutate', () => {
  const base = generate('pickup', 4);

  it('is deterministic for a patch, an amount and a seed, and moves each parameter by at most the amount, inside its range', () => {
    const a = mutate(base, 0.05, 9), b = mutate(base, 0.05, 9);
    expect(a).toEqual(b);
    expect(formatPatchNamed(mutate(base, 0.05, 10))).not.toBe(formatPatchNamed(a));
    for (const f of CLASSIC_FIELDS) {
      expect(Math.abs(a[f.name] - base[f.name])).toBeLessThanOrEqual(0.05 + 0.0001);
      expect(a[f.name]).toBeGreaterThanOrEqual(f.min);
      expect(a[f.name]).toBeLessThanOrEqual(f.max);
    }
  });

  it('never touches the wave or the volume, always changes something, and keeps the seed', () => {
    for (let s = 0; s < 50; s++) {
      const m = mutate({ ...base, seed: 5 }, 0.01, s);
      expect(m.wave).toBe(base.wave);
      expect(m.volume).toBe(base.volume);
      expect(m.seed).toBe(5);
      expect(formatPatchNamed(m)).not.toBe(formatPatchNamed({ ...base, seed: 5 }));
    }
  });

  it('a larger amount moves further on average', () => {
    const dist = (amt: number) => { let d = 0; for (let s = 0; s < 40; s++) { const m = mutate(base, amt, s); for (const f of CLASSIC_FIELDS) d += Math.abs(m[f.name] - base[f.name]); } return d; };
    expect(dist(0.3)).toBeGreaterThan(dist(0.02) * 3);
  });

  it('stays within range at the edges', () => {
    const edge = makePatch({ freq: 1, sustain: 0.01, slide: -1, decay: 0 });
    for (let s = 0; s < 30; s++) {
      const m = mutate(edge, 0.5, s);
      expect(m.freq).toBeLessThanOrEqual(1);
      expect(m.sustain).toBeGreaterThanOrEqual(0.01);
      expect(m.slide).toBeGreaterThanOrEqual(-1);
      expect(m.decay).toBeGreaterThanOrEqual(0);
    }
    expect(classicField('sustain')!.min).toBe(0.01);
  });
});

describe('the classic commands', () => {
  const run = (text: string, lib: Library = new Map()): { lib: Library; texts: string[] } => {
    const r = parse(text);
    expect(r.errors).toEqual([]);
    const texts: string[] = [];
    for (const c of r.commands) texts.push(applyCommand(lib, c) ?? c.text);
    return { lib, texts };
  };

  it('sound new … voice=classic makes a default patch; preset= and seed= make a generated one', () => {
    const { lib } = run('sound new a voice=classic\nsound new b voice=classic preset=laser seed=3');
    expect((lib.get('a') as ClassicSound).patch).toEqual(makePatch({}));
    expect((lib.get('b') as ClassicSound).patch).toEqual(generate('laser', 3));
    expect(lib.get('b')!.voice).toBe('classic');
  });

  it('a preset without a seed takes a seed from the category and the id, written into the normal form', () => {
    const c = parse('sound new zap voice=classic preset=laser').commands[0]!;
    expect(c.text).toMatch(/^sound new zap voice=classic preset=laser seed=\d+$/);
    const again = parse('sound new zap voice=classic preset=laser').commands[0]!;
    expect(again.text).toBe(c.text);
    expect(parse('sound new zip voice=classic preset=laser').commands[0]!.text).not.toBe(c.text);
    // preset alone means classic
    expect(parse('sound new z preset=hit seed=1').commands[0]).toMatchObject({ voice: 'classic', preset: 'hit', seed: 1 });
  });

  it('sets classic parameters, with wave names, clamping never (it refuses out-of-range values), and seed=auto', () => {
    const { lib } = run('sound new a voice=classic\nsound set a wave=saw freq=0.6 decay=0.25 seed=42');
    expect((lib.get('a') as ClassicSound).patch).toMatchObject({ wave: 1, freq: 0.6, decay: 0.25, seed: 42 });
    run('sound set a seed=auto', lib);
    expect((lib.get('a') as ClassicSound).patch.seed).toBeUndefined();
    expect(parse('sound set a sustain=0').errors[0]!.message).toMatch(/sustain must be between 0.01 and 1/);
    expect(parse('sound set a wave=1.5').errors[0]!.message).toMatch(/wave must be 0, 1, 2 or 3/);
    expect(parse('sound set a wave=triangle').errors[0]!.message).toMatch(/not a number \(or square, saw, sine, noise\)/);
    expect(parse('sound set a slide=2').errors[0]!.message).toMatch(/slide must be between -1 and 1/);
    expect(() => run('sound set a frequency=440', lib)).toThrow(/no parameter 'frequency' on a classic sound/);
    const tone: Library = new Map();
    run('sound new t', tone);
    expect(() => run('sound set t freq=0.3', tone)).toThrow(/no parameter 'freq' on a tone sound/);
    expect(() => run('sound set t seed=3', tone)).toThrow(/classic-voice parameter/);
  });

  it('sound patch takes single-patch text (positional or named, with \\n for a new line) and writes the exact named form', () => {
    const { lib, texts } = run('sound new a voice=classic\nsound patch a "1\\n2,0.1,,0.5"\nsound patch a "wave=noise,freq=0.4"');
    expect((lib.get('a') as ClassicSound).patch).toEqual(makePatch({ wave: 3, freq: 0.4 }));
    expect(texts[1]).toBe(`sound patch a "${formatPatchNamed(makePatch({ wave: 2, attack: 0.1, punch: 0.5 }))}"`);
    // the normal form replays to the same sound
    const lib2: Library = new Map();
    run(`sound new a voice=classic\n${texts[1]}`, lib2);
    expect((lib2.get('a') as ClassicSound).patch).toEqual(makePatch({ wave: 2, attack: 0.1, punch: 0.5 }));
    expect(parse('sound patch a "0,abc"').errors[0]!.message).toMatch(/field 2 is not a number/);
    expect(parse('sound patch a').errors[0]!.message).toMatch(/give the patch text in quotes/);
    expect(() => run('sound patch t "0,1"', (() => { const l: Library = new Map(); run('sound new t', l); return l; })())).toThrow(/is a tone/);
  });

  it('sound mutate (also written mutate) records its seed in the normal form, and as= makes a new sound', () => {
    const lib: Library = new Map();
    const { texts } = run('sound new a voice=classic preset=pickup seed=2\nmutate a amount=0.1 as=b\nsound mutate a', lib);
    expect(texts[1]).toMatch(/^sound mutate a amount=0.1 seed=\d+ as=b$/);
    expect(texts[2]).toMatch(/^sound mutate a amount=0.05 seed=\d+$/);
    expect((lib.get('b') as ClassicSound).patch).not.toEqual((generate('pickup', 2)));
    expect((lib.get('b') as ClassicSound).patch.wave).toBe(0);
    expect(() => run('sound mutate a as=b', lib)).toThrow(/'b' exists already/);
    expect(parse('mutate a amount=0').errors[0]!.message).toMatch(/above 0 and at most 1/);
    expect(parse('mutate a seed=-1').errors[0]!.message).toMatch(/whole number/);
    expect(parse('mutate a speed=1').errors[0]!.message).toMatch(/unexpected 'speed=1'/);
  });

  it('a tape with generators and mutations replays to the same sounds', () => {
    const cmds = ['sound new a voice=classic preset=explosion', 'sound mutate a amount=0.2', 'sound set a volume=0.3', 'sound mutate a as=b'];
    const lib: Library = new Map();
    const entries: TapeEntry[] = cmds.map((c, i) => {
      const cmd = parse(c).commands[0]!;
      const text = applyCommand(lib, cmd) ?? cmd.text;
      return { seq: i + 1, by: 'agent:claude', group: `g${i + 1}`, cmd: text };
    });
    const r = replay(entries);
    expect(r.problems).toEqual([]);
    for (const id of ['a', 'b']) expect(serializeSound(r.library.get(id)!)).toBe(serializeSound(lib.get(id)!));
    expect(samplesHash(new Float32Array(renderClassic((r.library.get('b') as ClassicSound).patch)))).toBe(samplesHash(new Float32Array(renderClassic((lib.get('b') as ClassicSound).patch))));
  });
});
