// Generators and mutation for the classic voice, in the manner of sfxr's category buttons. Each
// category's parameter ranges are DATA (CATEGORIES below), not code: what a "laser" is, is written
// down and can be read, printed (docs/commands.md) and changed. Everything is seeded: the same
// category and seed always give the same patch, on every machine (a small integer PRNG; no
// Math.random).

import { CLASSIC_FIELDS, CLASSIC_KEYS, classicField, makePatch, seedOf, type ClassicKey, type ClassicPatch } from './classic.ts';

/** mulberry32: a 32-bit PRNG from integer operations only. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  /** A number in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }
}

/** FNV-1a of a text, 32 bits: for default seeds. */
export function hashText(s: string): number {
  let h = 2166136261 | 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** How one parameter is set: a fixed value, uniform in a range, or one of a list. */
export type Rule = number | readonly [number, number] | { readonly pick: readonly number[] };
export type Rules = Partial<Record<ClassicKey, Rule>>;

export interface Category {
  help: string;
  /** Always applied. */
  always: Rules;
  /** Exactly one of these, by weight. */
  one?: readonly { readonly weight: number; readonly rules: Rules }[];
  /** Each applied on its own with this chance, in order. */
  maybe?: readonly { readonly chance: number; readonly rules: Rules }[];
}

/**
 * The categories and the ranges they draw from (sfxr's, as published, mapped to the parameter
 * names here). A parameter a category does not mention keeps its default. Drawn in this order:
 * `always`, one of `one`, then each `maybe`.
 */
export const CATEGORIES = {
  pickup: {
    help: 'a short bright blip: coins, items',
    always: { wave: 0, attack: 0, sustain: [0, 0.1], decay: [0.1, 0.5], punch: [0.3, 0.6], freq: [0.4, 0.9] },
    maybe: [{ chance: 0.5, rules: { changeSpeed: [0.5, 0.7], changeAmount: [0.2, 0.6] } }],
  },
  laser: {
    help: 'a falling zap: shots, beams',
    always: { attack: 0, sustain: [0.1, 0.3], decay: [0, 0.4] },
    one: [
      { weight: 2, rules: { wave: { pick: [0, 1, 2] }, freq: [0.5, 1], minFreq: [0.2, 0.3], slide: [-0.35, -0.15] } },
      { weight: 1, rules: { wave: { pick: [0, 1, 2] }, freq: [0.3, 0.9], minFreq: [0, 0.1], slide: [-0.65, -0.35] } },
    ],
    maybe: [
      { chance: 0.5, rules: { duty: [0, 0.5], dutySweep: [0, 0.2] } },
      { chance: 0.5, rules: { punch: [0, 0.3] } },
      { chance: 0.33, rules: { phaserOffset: [0, 0.2], phaserSweep: [-0.2, 0] } },
      { chance: 0.5, rules: { highPass: [0, 0.3] } },
    ],
  },
  explosion: {
    help: 'a noise burst that falls away: blasts, crashes',
    always: { wave: 3, attack: 0, sustain: [0.1, 0.4], decay: [0, 0.5], punch: [0.2, 0.8] },
    one: [
      { weight: 1, rules: { freq: [0.01, 0.25], slide: [-0.1, 0.3] } },
      { weight: 1, rules: { freq: [0.04, 0.81], slide: [-0.4, -0.2] } },
    ],
    maybe: [
      { chance: 0.5, rules: { repeatSpeed: [0.3, 0.8] } },
      { chance: 0.5, rules: { phaserOffset: [-0.3, 0.6], phaserSweep: [-0.3, 0] } },
      { chance: 0.5, rules: { vibratoDepth: [0, 0.7], vibratoSpeed: [0, 0.6] } },
      { chance: 0.33, rules: { changeSpeed: [0.6, 0.9], changeAmount: [-0.8, 0.8] } },
    ],
  },
  powerup: {
    help: 'a rising sweep: power-ups, level-ups',
    always: { attack: 0, sustain: [0, 0.4], decay: [0.1, 0.5], freq: [0.2, 0.5] },
    one: [
      { weight: 1, rules: { slide: [0.1, 0.5], repeatSpeed: [0.4, 0.8] } },
      { weight: 1, rules: { slide: [0.05, 0.25] } },
    ],
    maybe: [
      { chance: 0.5, rules: { wave: 1 } },
      { chance: 0.5, rules: { duty: [0, 0.6] } },
      { chance: 0.25, rules: { vibratoDepth: [0, 0.7], vibratoSpeed: [0, 0.6] } },
    ],
  },
  hit: {
    help: 'a sharp impact: hurt, thud, punch',
    always: { attack: 0, sustain: [0, 0.1], decay: [0.1, 0.3], freq: [0.2, 0.8], slide: [-0.7, -0.3], wave: { pick: [0, 1, 3] } },
    maybe: [
      { chance: 0.5, rules: { highPass: [0, 0.3] } },
      { chance: 0.33, rules: { duty: [0, 0.6] } },
    ],
  },
  jump: {
    help: 'a short upward chirp: jumps, bounces',
    always: { wave: 0, attack: 0, sustain: [0.1, 0.4], decay: [0.1, 0.3], freq: [0.3, 0.6], slide: [0.1, 0.3], duty: [0, 0.6] },
    maybe: [
      { chance: 0.5, rules: { highPass: [0, 0.3] } },
      { chance: 0.5, rules: { lowPass: [0.4, 1] } },
    ],
  },
  blip: {
    help: 'a very short tick: menu moves, selections',
    always: { wave: { pick: [0, 1] }, attack: 0, sustain: [0.1, 0.2], decay: [0, 0.2], freq: [0.2, 0.6], highPass: 0.1 },
    maybe: [{ chance: 0.5, rules: { duty: [0, 0.6] } }],
  },
} as const satisfies Record<string, Category>;

export type CategoryName = keyof typeof CATEGORIES;
export const CATEGORY_NAMES = Object.keys(CATEGORIES) as CategoryName[];

export function isCategory(name: string): name is CategoryName {
  return Object.prototype.hasOwnProperty.call(CATEGORIES, name);
}

/**
 * sfxr's "randomize": any sound, not a kind of sound. Its ranges are data like the categories'
 * (uniform draws, each group of parameters used with the chance written beside it; what is not
 * drawn keeps its default), not sfxr's hidden power-law shaping.
 */
export const RANDOM: Category = {
  help: 'anything: every parameter group used with the chance written here',
  always: { wave: { pick: [0, 1, 2, 3] }, attack: 0, sustain: [0.05, 0.4], decay: [0.05, 0.5], freq: [0.1, 0.9], punch: [0, 0.5] },
  maybe: [
    { chance: 0.3, rules: { attack: [0.02, 0.15] } },
    { chance: 0.6, rules: { slide: [-0.5, 0.5] } },
    { chance: 0.2, rules: { minFreq: [0.05, 0.3] } },
    { chance: 0.2, rules: { deltaSlide: [-0.3, 0.3] } },
    { chance: 0.3, rules: { vibratoDepth: [0, 0.6], vibratoSpeed: [0.1, 0.6], vibratoDelay: [0, 0.4] } },
    { chance: 0.3, rules: { changeSpeed: [0.3, 0.9], changeAmount: [-0.8, 0.8] } },
    { chance: 0.4, rules: { duty: [0, 0.8], dutySweep: [-0.3, 0.3] } },
    { chance: 0.2, rules: { repeatSpeed: [0.3, 0.9] } },
    { chance: 0.25, rules: { phaserOffset: [-0.4, 0.6], phaserSweep: [-0.3, 0.3] } },
    { chance: 0.3, rules: { lowPass: [0.2, 0.9], lowPassSweep: [-0.3, 0.3], resonance: [0, 0.5] } },
    { chance: 0.3, rules: { highPass: [0, 0.4], highPassSweep: [-0.2, 0.2] } },
  ],
};

/** The categories and `random`: what `sound generate` and `preset=` accept. */
export const GENERATOR_NAMES: readonly string[] = [...CATEGORY_NAMES, 'random'];
export type GeneratorName = CategoryName | 'random';
export const isGenerator = (name: string): name is GeneratorName => name === 'random' || isCategory(name);

/** Three decimals: readable, and survives the single-patch text's six significant digits. */
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

function draw(rng: Rng, rule: Rule): number {
  if (typeof rule === 'number') return rule;
  if (Array.isArray(rule)) return rng.range(rule[0]!, rule[1]!);
  return rng.pick((rule as { pick: readonly number[] }).pick);
}

function applyRules(rng: Rng, into: Record<string, number>, rules: Rules): void {
  for (const f of CLASSIC_FIELDS) {
    const r = (rules as Record<string, Rule | undefined>)[f.name];
    if (r === undefined) continue;
    const v = draw(rng, r);
    into[f.name] = f.name === 'wave' ? v : round3(v);
  }
}

/** The default generator seed for a sound: a hash of the category and the id (so two sounds made the same way differ). */
export const defaultGenSeed = (category: string, id: string): number => hashText(`${category}:${id}`);

/** A patch from a category and a seed. The same pair always gives the same patch. */
export function generate(category: GeneratorName, seed: number): ClassicPatch {
  const cat: Category = category === 'random' ? RANDOM : CATEGORIES[category];
  const rng = new Rng(seed);
  const v: Record<string, number> = {};
  applyRules(rng, v, cat.always);
  if (cat.one) {
    const total = cat.one.reduce((n, o) => n + o.weight, 0);
    let x = rng.next() * total;
    let chosen = cat.one[cat.one.length - 1]!;
    for (const o of cat.one) {
      if (x < o.weight) { chosen = o; break; }
      x -= o.weight;
    }
    applyRules(rng, v, chosen.rules);
  }
  for (const m of cat.maybe ?? []) if (rng.next() < m.chance) applyRules(rng, v, m.rules);
  return makePatch(v);
}

/** The default mutation amount. */
export const MUTATE_AMOUNT = 0.05;

/** Four decimals: survives the single-patch text's six significant digits. */
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/**
 * A small seeded change to a patch, as sfxr's mutate button: each parameter except the wave and
 * the volume moves, with a chance of one half, by a uniform amount in ±amount, kept in its range.
 * At least one parameter moves.
 */
export function mutate(p: ClassicPatch, amount: number, seed: number): ClassicPatch {
  const rng = new Rng(seed);
  const next: Record<string, number> = { ...p };
  let moved = 0;
  for (const k of CLASSIC_KEYS) {
    if (k === 'wave' || k === 'volume') continue;
    const f = classicField(k)!;
    const take = rng.next() < 0.5;
    const d = rng.range(-amount, amount);
    if (!take) continue;
    const v = round4(Math.min(f.max, Math.max(f.min, p[k] + d)));
    if (v !== p[k]) moved++;
    next[k] = v;
  }
  if (!moved) {
    const f = classicField('freq')!;
    next.freq = round4(Math.min(f.max, Math.max(f.min, p.freq + (p.freq + amount <= f.max ? amount : -amount))));
  }
  if (p.seed !== undefined) next.seed = p.seed;
  return makePatch(next);
}

/** The default mutate seed: from the patch's own values and the target id, so mutating again (or into another id) gives another change. */
export const defaultMutateSeed = (p: ClassicPatch, target: string): number => hashText(`${seedOf(p)}:${target}`);

/** A markdown table of the categories and their ranges (for the command reference; a test keeps docs/commands.md in step). */
export function categoriesTable(): string {
  const fmt = (r: Rule): string => (typeof r === 'number' ? String(r) : Array.isArray(r) ? `${r[0]}..${r[1]}` : `one of ${(r as { pick: readonly number[] }).pick.join(', ')}`);
  const list = (rules: Rules): string => Object.entries(rules).map(([k, r]) => `${k} ${fmt(r as Rule)}`).join('; ');
  const lines = ['| Category | Meaning | Always | One of (weight) | Maybe (chance) |', '|---|---|---|---|---|'];
  for (const name of GENERATOR_NAMES) {
    const c: Category = name === 'random' ? RANDOM : CATEGORIES[name as CategoryName];
    lines.push(`| \`${name}\` | ${c.help} | ${list(c.always)} | ${(c.one ?? []).map((o) => `${list(o.rules)} (${o.weight})`).join(' / ') || '-'} | ${(c.maybe ?? []).map((m) => `${list(m.rules)} (${m.chance})`).join(' / ') || '-'} |`);
  }
  return lines.join('\n');
}
