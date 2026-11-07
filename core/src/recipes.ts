// Generators for the layered voice: recipes for sounds that are several layers (a footstep, a UI
// click, a door, a magic sparkle). Like the classic categories, a recipe's ranges are DATA
// (RECIPES below): what a "door" is, is written down, printed in docs/commands.md and changeable.
// Everything is seeded (the same name and seed always give the same sound, on every machine).

import { Rng, hashText } from './generators.ts';
import {
  FX_SPECS, MAX_LAYERS, layerSpecs, newFx, newLayer, specOf, type Curve, type Env, type Fx, type FxKind, type Layer, type LayeredSound, type LoopSpec, type PSpec, type SourceKind, type Value,
} from './layered.ts';

/** A value rule: fixed, uniform in a range, or one of a list. */
export type LRule = number | string | readonly [number, number] | { readonly pick: readonly (number | string)[] };
type Pt = readonly [LRule, LRule] | readonly [LRule, LRule, Curve];

export interface FxRecipe {
  kind: FxKind;
  p: Readonly<Record<string, LRule>>;
  chance?: number;
  envs?: Readonly<Record<string, readonly Pt[]>>;
}

/** A slow random wander of a parameter that comes back to where it started after one loop length (so a looped bed has no seam in it): `points` breakpoints with values in `range`. */
export interface WobbleRule {
  points: readonly [number, number];
  range: readonly [number, number];
  curve?: Curve;
}

/** Short random bursts of level on the amplitude envelope (raindrops, crackles), none across the loop seam: `count` of them, each `width` seconds long, peaking at `level`. */
export interface BurstRule {
  count: readonly [number, number];
  width: readonly [number, number];
  level: readonly [number, number];
}

export interface LayerRecipe {
  kind: Exclude<SourceKind, 'classic' | 'sample'>;
  /** Periodic wanders on envelope-capable parameters (only for a recipe with a `loop`). */
  wobble?: Readonly<Record<string, WobbleRule>>;
  /** Bursts on the amplitude envelope (only for a recipe with a `loop`). */
  bursts?: BurstRule;
  /** The chance this layer is there at all (default 1). */
  chance?: number;
  /** Make several copies: `count` of them, each starting `step` seconds after the last and `falloff` times as loud. */
  repeat?: { count: readonly [number, number]; step: readonly [number, number]; falloff: number };
  p: Readonly<Record<string, LRule>>;
  envs?: Readonly<Record<string, readonly Pt[]>>;
  amp?: readonly Pt[];
  fx?: readonly FxRecipe[];
}

export interface Recipe {
  help: string;
  /** A bed: the sound loops, `length` drawn from this range (seconds), the seam crossfaded over `fade` seconds. */
  loop?: { length: readonly [number, number]; fade: number };
  /** The sound's gain (default 1): set so a recipe lands near the style's loudness. */
  gain?: number;
  layers: readonly LayerRecipe[];
  master?: readonly FxRecipe[];
}

const decay = (a: number | readonly [number, number]): Pt[] => [[0, 0], [0.003, 1], [a, 0, 'exp']];

export const RECIPES = {
  footstep: {
    help: 'a soft thud and a scuff: shoes on a floor',
    layers: [
      { kind: 'osc', p: { wave: 'sine', freq: [90, 150], dur: [0.17, 0.22], gain: [0.7, 1] }, envs: { freq: [[0, [110, 170]], [0.1, [45, 65], 'exp']] }, amp: decay([0.1, 0.16]) },
      { kind: 'osc', p: { wave: { pick: ['brown', 'pink'] }, dur: [0.12, 0.2], filter: 'lp', cutoff: [900, 1800], q: [0.7, 1.5], gain: [0.5, 0.9] }, envs: { cutoff: [[0, [1800, 2600]], [0.12, [300, 500], 'exp']] }, amp: [[0, 0], [0.004, 1], [[0.09, 0.15], 0, 'exp']] },
      { kind: 'osc', chance: 0.6, p: { wave: 'white', offset: [0.02, 0.06], dur: [0.05, 0.1], filter: 'hp', cutoff: [2500, 4500], gain: [0.12, 0.3] }, amp: [[0, 0], [0.004, 1], [[0.04, 0.07], 0, 'exp']] },
    ],
  },
  'ui-click': {
    help: 'a short tick with a bright body: buttons, toggles',
    layers: [
      { kind: 'osc', p: { wave: 'sine', freq: [1800, 3000], dur: [0.05, 0.08], gain: [0.6, 0.9] }, envs: { freq: [[0, [2200, 3200]], [0.04, [1400, 1900], 'exp']] }, amp: [[0, 1], [[0.03, 0.05], 0, 'exp']] },
      { kind: 'osc', p: { wave: 'white', dur: 0.015, filter: 'hp', cutoff: [3000, 6000], gain: [0.2, 0.4] }, amp: [[0, 0], [0.001, 1], [0.012, 0, 'exp']] },
      { kind: 'osc', chance: 0.5, p: { wave: 'triangle', freq: [2400, 4000], offset: [0.025, 0.045], dur: 0.06, gain: [0.3, 0.5] }, amp: [[0, 0], [0.002, 1], [0.05, 0, 'exp']] },
    ],
  },
  door: {
    help: 'a thump, a wooden body, a creak that bends and a latch click',
    layers: [
      { kind: 'osc', p: { wave: 'sine', freq: [80, 110], dur: 0.35, gain: [0.8, 1] }, envs: { freq: [[0, [90, 120]], [0.2, [35, 50], 'exp']] }, amp: decay([0.25, 0.32]) },
      { kind: 'osc', p: { wave: 'brown', dur: 0.3, filter: 'lp', cutoff: [400, 800], gain: [0.5, 0.8] }, amp: decay([0.2, 0.28]) },
      {
        kind: 'osc',
        p: { wave: 'saw', offset: [0.12, 0.3], dur: [0.62, 0.9], filter: 'bp', cutoff: [600, 900], q: [4, 9], gain: [0.35, 0.55] },
        envs: { freq: [[0, [160, 240]], [0.25, [300, 420]], [0.6, [140, 200]]], cutoff: [[0, [500, 800]], [0.6, [900, 1500]]] },
        amp: [[0, 0], [0.12, 1], [[0.3, 0.4], 0.7], [[0.5, 0.6], 0, 'exp']],
        fx: [{ kind: 'distort', p: { shape: 'soft', drive: [3, 8], mix: 0.5 } }],
      },
      { kind: 'osc', chance: 0.7, p: { wave: 'square', freq: [1200, 2000], offset: [0.35, 0.5], dur: 0.02, gain: [0.25, 0.4] }, amp: [[0, 0], [0.001, 1], [0.018, 0, 'exp']] },
    ],
    master: [{ kind: 'reverb', p: { size: [0.15, 0.35], damp: 0.6, mix: [0.08, 0.15] } }],
  },
  magic: {
    help: 'a run of bell tones with a shimmer, spread across the stereo field, with echo and room',
    layers: [
      {
        kind: 'fm', repeat: { count: [3, 5], step: [0.04, 0.09], falloff: 0.8 },
        p: { freq: { pick: [1047, 1319, 1568, 1976, 2349, 2637] }, ops: 2, algo: 'chain', ratio2: [1.5, 3.5], index2: [2, 5], dur: [0.45, 0.8], gain: [0.45, 0.6], pan: [-0.5, 0.5] },
        envs: { index2: [[0, [3, 6]], [0.4, 0, 'exp']] }, amp: [[0, 0], [0.004, 1], [[0.35, 0.44], 0, 'exp']],
      },
      { kind: 'osc', p: { wave: 'white', dur: [0.4, 0.7], filter: 'hp', cutoff: [6000, 8000], gain: [0.08, 0.14] }, amp: [[0, 0], [0.1, 1], [[0.35, 0.39], 0, 'exp']] },
    ],
    master: [
      { kind: 'delay', p: { time: [0.11, 0.19], feedback: [0.3, 0.45], mix: [0.2, 0.3] } },
      { kind: 'reverb', p: { size: [0.5, 0.8], damp: 0.4, mix: [0.2, 0.3] } },
    ],
  },
  wind: {
    help: 'a bed: moving air, a low rush that swells and fades, a thin whistle on top',
    loop: { length: [5, 7], fade: 0.6 },
    gain: 0.45,
    layers: [
      { kind: 'osc', p: { wave: 'brown', dur: 'loop', filter: 'bp', q: [0.8, 1.4], gain: 1 }, wobble: { cutoff: { points: [5, 8], range: [220, 700], curve: 'ease' }, gain: { points: [4, 7], range: [0.45, 1], curve: 'ease' } } },
      { kind: 'osc', p: { wave: 'pink', dur: 'loop', filter: 'bp', q: [2, 4], gain: 0.2 }, wobble: { cutoff: { points: [4, 7], range: [700, 1800], curve: 'ease' }, gain: { points: [4, 7], range: [0.04, 0.35], curve: 'ease' } } },
      { kind: 'osc', p: { wave: 'white', dur: 'loop', filter: 'hp', cutoff: 5000, gain: 0.05 }, wobble: { gain: { points: [4, 6], range: [0.2, 1], curve: 'ease' } } },
    ],
    master: [{ kind: 'reverb', p: { size: [0.4, 0.6], damp: 0.5, mix: 0.12 } }],
  },
  rain: {
    help: 'a bed: a steady patter, a soft body underneath and scattered drops',
    loop: { length: [4, 6], fade: 0.5 },
    gain: 0.65,
    layers: [
      { kind: 'osc', p: { wave: 'white', dur: 'loop', filter: 'bp', cutoff: [4200, 5200], q: 0.5, gain: 0.5 } },
      { kind: 'osc', p: { wave: 'pink', dur: 'loop', filter: 'bp', cutoff: [1100, 1500], q: 0.4, gain: 0.4 }, wobble: { gain: { points: [3, 5], range: [0.2, 0.55], curve: 'ease' } } },
      { kind: 'osc', p: { wave: 'white', dur: 'loop', filter: 'bp', cutoff: [3500, 6000], q: [1.2, 2], gain: 1 }, bursts: { count: [6, 8], width: [0.01, 0.035], level: [0.5, 1] } },
      { kind: 'osc', p: { wave: 'white', dur: 'loop', filter: 'bp', cutoff: [6000, 9000], q: [1.2, 2], gain: 0.7 }, bursts: { count: [6, 8], width: [0.008, 0.03], level: [0.4, 0.9] } },
    ],
    master: [{ kind: 'reverb', p: { size: [0.25, 0.4], damp: 0.5, mix: 0.12 } }],
  },
  fire: {
    help: 'a bed: a low roar that flickers, a hiss, and crackles',
    loop: { length: [4, 6], fade: 0.5 },
    gain: 2.2,
    layers: [
      { kind: 'osc', p: { wave: 'brown', dur: 'loop', filter: 'bp', cutoff: [160, 240], q: 0.4 }, wobble: { gain: { points: [6, 10], range: [0.45, 1], curve: 'ease' } } },
      { kind: 'osc', p: { wave: 'pink', dur: 'loop', filter: 'bp', cutoff: [2500, 3500], q: 0.8 }, wobble: { gain: { points: [6, 10], range: [0.1, 0.45], curve: 'ease' } } },
      { kind: 'osc', p: { wave: 'white', dur: 'loop', filter: 'hp', cutoff: [1800, 2600], gain: 0.3 }, bursts: { count: [6, 9], width: [0.004, 0.02], level: [0.4, 0.8] } },
      { kind: 'osc', p: { wave: 'white', dur: 'loop', filter: 'bp', cutoff: [700, 1400], q: 1.5, gain: 0.2 }, bursts: { count: [3, 5], width: [0.02, 0.06], level: [0.3, 0.7] } },
    ],
    // a soft shaper keeps the crackles from stacking up over the roar into a clip
    master: [{ kind: 'distort', p: { shape: 'soft', drive: 1, mix: 1 } }],
  },
  crowd: {
    help: 'a bed: many voices far enough that none is a word (murmur): three speech-band hums that rise and fall independently',
    loop: { length: [6, 8], fade: 0.8 },
    gain: 2.5,
    layers: [
      { kind: 'osc', p: { wave: 'pink', dur: 'loop', filter: 'bp', cutoff: [380, 520], q: [3, 5], gain: 1 }, wobble: { gain: { points: [12, 18], range: [0.1, 0.8], curve: 'ease' } } },
      { kind: 'osc', p: { wave: 'pink', dur: 'loop', filter: 'bp', cutoff: [800, 1000], q: [3, 5], gain: 0.8 }, wobble: { gain: { points: [12, 18], range: [0.1, 0.8], curve: 'ease' } } },
      { kind: 'osc', p: { wave: 'pink', dur: 'loop', filter: 'bp', cutoff: [1500, 1900], q: [3, 5], gain: 0.5 }, wobble: { gain: { points: [12, 18], range: [0.1, 0.8], curve: 'ease' } } },
      { kind: 'osc', p: { wave: 'brown', dur: 'loop', filter: 'bp', cutoff: 180, q: 0.5, gain: 0.5 } },
    ],
    master: [{ kind: 'reverb', p: { size: [0.45, 0.65], damp: 0.5, mix: 0.25 } }],
  },
} as const satisfies Record<string, Recipe>;

export type RecipeName = keyof typeof RECIPES;
export const RECIPE_NAMES = Object.keys(RECIPES) as RecipeName[];
export const isRecipe = (name: string): name is RecipeName => Object.prototype.hasOwnProperty.call(RECIPES, name);

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

function draw(rng: Rng, rule: LRule): Value {
  if (typeof rule === 'number' || typeof rule === 'string') return rule;
  if (Array.isArray(rule)) return round3(rng.range(rule[0] as number, rule[1] as number));
  return rng.pick((rule as { pick: readonly (number | string)[] }).pick);
}

function clampTo(spec: PSpec | undefined, v: Value): Value {
  if (!spec || typeof v !== 'number') return v;
  const c = Math.min(spec.max, Math.max(spec.min, v));
  return spec.integer ? Math.round(c) : c;
}

function drawEnv(rng: Rng, pts: readonly Pt[], spec: PSpec | undefined): Env {
  const out: Env = [];
  for (const p of pts) {
    let t = draw(rng, p[0]) as number;
    const v = clampTo(spec, draw(rng, p[1])) as number;
    if (out.length && t <= out[out.length - 1]!.t) t = round3(out[out.length - 1]!.t + 0.001);
    out.push({ t, v, curve: (p[2] ?? 'lin') as Curve });
  }
  return out;
}

function drawFx(rng: Rng, r: FxRecipe): Fx {
  const f = newFx(r.kind);
  for (const [k, rule] of Object.entries(r.p)) f.p[k] = clampTo(specOf(FX_SPECS[r.kind], k), draw(rng, rule));
  for (const [k, pts] of Object.entries(r.envs ?? {})) f.envs[k] = drawEnv(rng, pts, specOf(FX_SPECS[r.kind], k));
  return f;
}

interface LoopCtx {
  /** Loop length and crossfade, seconds. */
  L: number;
  T: number;
}

/** A wander that is periodic over the loop: n points over one length, back to the first value at L, then the first points again over the crossfade (the render goes T seconds past L, and that part is folded onto the start). */
function wobbleEnv(rng: Rng, ctx: LoopCtx, w: WobbleRule, spec: PSpec | undefined): Env {
  const n = Math.floor(rng.range(w.points[0], w.points[1] + 1));
  const ts = [0];
  for (let i = 1; i < n; i++) ts.push(round3((ctx.L * (i + rng.range(-0.3, 0.3))) / n));
  const vs = ts.map(() => clampTo(spec, round3(rng.range(w.range[0], w.range[1]))) as number);
  const curve = (w.curve ?? 'lin') as Curve;
  const out: Env = ts.map((t, i) => ({ t, v: vs[i]!, curve }));
  out.push({ t: ctx.L, v: vs[0]!, curve });
  for (let i = 1; i < n; i++) {
    out.push({ t: round3(ts[i]! + ctx.L), v: vs[i]!, curve });
    if (ts[i]! > ctx.T) break;
  }
  return out;
}

/** Bursts on the amplitude envelope, none across the seam; those inside the crossfade are repeated one loop later. */
function burstEnv(rng: Rng, ctx: LoopCtx, b: BurstRule): Env {
  const count = Math.floor(rng.range(b.count[0], b.count[1] + 1));
  const width = (): number => round3(rng.range(b.width[0], b.width[1]));
  const bursts: { t: number; w: number; v: number }[] = [];
  for (let i = 0; i < count; i++) {
    const w = width();
    const t = round3(rng.range(0.01, ctx.L - w - 0.02));
    if (bursts.every((x) => t > x.t + x.w + 0.01 || t + w + 0.01 < x.t)) bursts.push({ t, w, v: round3(rng.range(b.level[0], b.level[1])) });
  }
  bursts.sort((a, c) => a.t - c.t);
  const all = [...bursts, ...bursts.filter((x) => x.t < ctx.T).map((x) => ({ ...x, t: round3(x.t + ctx.L) }))];
  const out: Env = [{ t: 0, v: 0, curve: 'lin' }];
  for (const x of all) {
    const last = out[out.length - 1]!;
    if (x.t - 0.002 > last.t + 0.0005) out.push({ t: round3(x.t - 0.002), v: 0, curve: 'lin' });
    out.push({ t: x.t, v: x.v, curve: 'lin' }, { t: round3(x.t + x.w), v: 0, curve: 'exp' });
  }
  return out.slice(0, 32);
}

function drawLayer(rng: Rng, r: LayerRecipe, salt: number, shift: { offset: number; gain: number }, ctx: LoopCtx | null = null): Layer {
  const l = newLayer(r.kind, salt);
  const specs = layerSpecs(r.kind);
  for (const [k, rule] of Object.entries(r.p)) l.p[k] = rule === 'loop' && ctx ? round3(ctx.L + ctx.T + 0.05) : clampTo(specOf(specs, k), draw(rng, rule));
  l.p.offset = round3((l.p.offset as number) + shift.offset);
  l.p.gain = round3((l.p.gain as number) * shift.gain);
  for (const [k, pts] of Object.entries(r.envs ?? {})) l.envs[k] = drawEnv(rng, pts, specOf(specs, k));
  if (ctx) {
    for (const [k, w] of Object.entries(r.wobble ?? {})) l.envs[k] = wobbleEnv(rng, ctx, w, specOf(specs, k));
    if (r.bursts) l.amp = burstEnv(rng, ctx, r.bursts);
  }
  if (r.amp) l.amp = drawEnv(rng, r.amp, { name: 'amp', min: 0, max: 4, default: 1, unit: '', help: '', env: true });
  l.fx = (r.fx ?? []).map((f) => drawFx(rng, f));
  return l;
}

/** The layers and master chain a recipe makes for a seed (the sound's id, status and seed are the caller's). */
export function recipeBody(name: RecipeName, seed: number): Pick<LayeredSound, 'layers' | 'master' | 'nextSalt'> & { loop?: LoopSpec; gain?: number } {
  const recipe: Recipe = RECIPES[name];
  const rng = new Rng(seed);
  const loop = recipe.loop ? { length: round3(rng.range(recipe.loop.length[0], recipe.loop.length[1])), fade: recipe.loop.fade } : undefined;
  const ctx: LoopCtx | null = loop ? { L: loop.length, T: loop.fade } : null;
  const layers: Layer[] = [];
  let salt = 1;
  for (const r of recipe.layers) {
    if (r.chance !== undefined && rng.next() >= r.chance) continue;
    const count = r.repeat ? Math.floor(rng.range(r.repeat.count[0], r.repeat.count[1] + 1)) : 1;
    let offset = 0;
    let gain = 1;
    for (let i = 0; i < count && layers.length < MAX_LAYERS; i++) {
      layers.push(drawLayer(rng, r, salt++, { offset, gain }, ctx));
      if (r.repeat) { offset += round3(rng.range(r.repeat.step[0], r.repeat.step[1])); gain *= r.repeat.falloff; }
    }
  }
  return { layers, master: (recipe.master ?? []).filter((f) => f.chance === undefined || rng.next() < f.chance).map((f) => drawFx(rng, f)), nextSalt: salt, ...(loop ? { loop } : {}), ...(recipe.gain !== undefined ? { gain: recipe.gain } : {}) };
}

/** The default recipe seed for a sound: a hash of the name and the id. */
export const defaultRecipeSeed = (name: string, id: string): number => hashText(`${name}:${id}`);

const fmtRule = (r: LRule): string => (typeof r === 'number' || typeof r === 'string' ? String(r) : Array.isArray(r) ? `${r[0]}..${r[1]}` : `one of ${(r as { pick: readonly (number | string)[] }).pick.join(', ')}`);
const fmtPts = (pts: readonly Pt[]): string => pts.map((p) => `${fmtRule(p[0])}:${fmtRule(p[1])}${p[2] ? '@' + p[2] : ''}`).join(' ');

/** A markdown table of the recipes and their ranges (for the command reference; a test keeps docs/commands.md in step). */
export function recipesTable(): string {
  const lines = ['| Recipe | Layer | Chance | Parameters | Envelopes | Effects |', '|---|---|---|---|---|---|'];
  for (const name of RECIPE_NAMES) {
    const r: Recipe = RECIPES[name];
    r.layers.forEach((l, i) => {
      const env = [...(l.amp ? [`amp ${fmtPts(l.amp)}`] : []), ...Object.entries(l.envs ?? {}).map(([k, v]) => `${k} ${fmtPts(v)}`),
        ...Object.entries(l.wobble ?? {}).map(([k, w]) => `${k} wanders (${w.points[0]}..${w.points[1]} points in ${w.range[0]}..${w.range[1]}, back to its start at the loop end)`),
        ...(l.bursts ? [`amp bursts (${l.bursts.count[0]}..${l.bursts.count[1]} of ${l.bursts.width[0]}..${l.bursts.width[1]} s, level ${l.bursts.level[0]}..${l.bursts.level[1]})`] : [])].join('; ') || '-';
      const fx = (l.fx ?? []).map((f) => `${f.kind} ${Object.entries(f.p).map(([k, v]) => `${k} ${fmtRule(v)}`).join(' ')}`).join('; ') || '-';
      const rep = l.repeat ? ` ×${l.repeat.count[0]}..${l.repeat.count[1]} every ${l.repeat.step[0]}..${l.repeat.step[1]} s, ${l.repeat.falloff}× as loud` : '';
      lines.push(`| ${i === 0 ? `\`${name}\` ${r.help}${r.loop ? ` (loops, ${r.loop.length[0]}..${r.loop.length[1]} s, fade ${r.loop.fade} s)` : ''}` : ''} | ${l.kind}${rep} | ${l.chance ?? 1} | ${l.kind} ${Object.entries(l.p).map(([k, v]) => `${k} ${fmtRule(v)}`).join('; ')} | ${env} | ${fx} |`);
    });
    for (const f of r.master ?? []) lines.push(`|  | master | ${f.chance ?? 1} | - | - | ${f.kind} ${Object.entries(f.p).map(([k, v]) => `${k} ${fmtRule(v)}`).join(' ')} |`);
  }
  return lines.join('\n');
}
