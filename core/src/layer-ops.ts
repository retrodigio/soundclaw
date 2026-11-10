// Applying the layered voice's commands to a sound. Each function returns the command's normal
// form (the text the tape holds): values typed, in the order of the parameter table.

import type { Command } from './commands.ts';
import { generate, hashText, type GeneratorName } from './generators.ts';
import { parsePatch } from './classic.ts';
import {
  FX_SPECS, MAX_FX, MAX_LAYERS, MAX_SOURCE_DURATION, checkNumber, classicLayer, fmtValue, formatEnv, showValue, formatTarget, layerSpecs, newFx, newLayer, paramNames, parseTarget, parseValue, specOf,
  type Env, type Fx, type Layer, type LayeredSound, type PSpec,
} from './layered.ts';
import { recipeBody, type RecipeName } from './recipes.ts';
import { cloneSound, type Sound } from './sound.ts';

type Raw = [string, string][];

export function layeredOf(lib: Map<string, Sound>, id: string, what: string): LayeredSound {
  const s = lib.get(id);
  if (!s) throw new Error(`no sound '${id}'`);
  if (s.voice === 'layered') return s;
  throw new Error(`${id} is a ${s.voice} sound; ${what} works on a layered sound (${s.voice === 'classic' ? `sound layer-up ${id} makes this one layered` : `sound new <id> voice=layered`})`);
}

function layerAt(s: LayeredSound, n: number): Layer {
  const l = s.layers[n - 1];
  if (!l) throw new Error(`${s.id} has no layer ${n}${s.layers.length ? ` (layers 1 to ${s.layers.length})` : ' (add one with layer add)'}`);
  return l;
}

function chainOf(s: LayeredSound, layer: number | null): { fx: Fx[]; where: string; l: Layer | null } {
  if (layer === null) return { fx: s.master, where: 'the master chain', l: null };
  const l = layerAt(s, layer);
  return { fx: l.fx, where: `layer ${layer}`, l };
}

/** Set values on a layer, in the order of its parameter table; a fixed value replaces any envelope on that parameter. */
function setLayerValues(l: Layer, values: Raw, what: string): void {
  for (const [name, raw] of values) {
    const spec = specOf(layerSpecs(l.kind), name);
    if (!spec) throw new Error(`${what}: a ${l.kind} layer has no parameter '${name}' (parameters: ${paramNames(layerSpecs(l.kind))})`);
    l.p[name] = parseValue(spec, raw, what);
    delete l.envs[name];
  }
}

function layerText(l: Layer, extra = ''): string {
  const specs = layerSpecs(l.kind);
  const given = specs.filter((sp) => l.p[sp.name] !== undefined && (sp.optional || l.p[sp.name] !== sp.default));
  return `${given.map((sp) => `${sp.name}=${showValue(l.kind, sp.name, l.p[sp.name]!)}`).join(' ')}${extra}`.trim();
}

/** The values a command sets, in table order, as text. */
function valuesText(specs: readonly PSpec[], p: Record<string, number | string>, names: string[], kind = ''): string {
  return specs.filter((sp) => names.includes(sp.name)).map((sp) => `${sp.name}=${showValue(kind, sp.name, p[sp.name]!)}`).join(' ');
}

export function applyLayerCommand(lib: Map<string, Sound>, c: Command): string | undefined {
  switch (c.op) {
    case 'layer-up': {
      const s = lib.get(c.id);
      if (!s) throw new Error(`no sound '${c.id}'`);
      if (s.voice !== 'classic') throw new Error(`${c.id} is a ${s.voice} sound; layer-up makes a classic sound layered`);
      if (s.classicOnly) throw new Error(`${c.id} is marked classic (it must stay one classic voice, so it exports as a synth.csv row); sound classic ${c.id} off lifts the mark`);
      const up: LayeredSound = { id: s.id, voice: 'layered', duration: null, gain: 1, seed: c.seed, nextSalt: 2, layers: [classicLayer(s.patch, 1)], master: [], status: s.status };
      lib.set(c.id, up);
      return `sound layer-up ${c.id} seed=${c.seed}`;
    }
    case 'classic': {
      const s = lib.get(c.id);
      if (!s) throw new Error(`no sound '${c.id}'`);
      if (s.voice !== 'classic') throw new Error(`${c.id} is a ${s.voice} sound; only a classic sound can be marked classic`);
      const next = cloneSound(s);
      if (c.on) next.classicOnly = true;
      else delete next.classicOnly;
      lib.set(c.id, next);
      return undefined;
    }
    case 'layer-add': {
      const s = cloneSound(layeredOf(lib, c.id, 'layer add'));
      if (s.layers.length >= MAX_LAYERS) throw new Error(`${c.id} has ${MAX_LAYERS} layers already (the most a sound has). Repeated hits belong in one layer: give it an amplitude envelope with bursts(...) (env ${c.id} N.amp "bursts(times=0.1,0.3,0.5)"); different sounds at once are separate sounds`);
      const l = newLayer(c.kind, s.nextSalt);
      const values: Raw = [];
      let preset = null as { cat: string; seed: number | null } | null;
      for (const [k, v] of c.values) {
        if (k === 'preset') preset = { cat: v, seed: preset?.seed ?? null };
        else if (k === 'presetseed') preset = { cat: preset?.cat ?? '', seed: Number(v) };
        else if (k === 'patch') {
          const patch = parsePatch(v.replace(/\\n/g, '\n'), 'layer add').patch;
          const cl = classicLayer(patch, l.salt);
          Object.assign(l.p, Object.fromEntries(Object.entries(cl.p)));
        } else values.push([k, v]);
      }
      if (preset) {
        const seed = preset.seed ?? hashText(`${preset.cat}:${c.id}#${l.salt}`);
        const cl = classicLayer(generate(preset.cat as GeneratorName, seed), l.salt);
        Object.assign(l.p, cl.p);
        preset.seed = seed;
      }
      setLayerValues(l, values, `layer add ${c.id}`);
      const at = c.at ?? s.layers.length + 1;
      if (at < 1 || at > s.layers.length + 1) throw new Error(`at=${at}: the new layer goes at 1 to ${s.layers.length + 1}`);
      s.layers.splice(at - 1, 0, l);
      s.nextSalt++;
      lib.set(c.id, s);
      const pre = preset ? ` preset=${preset.cat} presetseed=${preset.seed}` : '';
      const patchText = c.values.some(([k]) => k === 'patch') ? ` patch=${JSON.stringify(c.values.find(([k]) => k === 'patch')![1])}` : '';
      const given = c.kind === 'classic' && (preset || patchText) ? valuesText(layerSpecs(c.kind), l.p, values.map(([k]) => k), c.kind) : layerText(l);
      return `layer add ${c.id} ${c.kind}${pre}${patchText}${given ? ' ' + given : ''}${c.at !== null ? ` at=${at}` : ''}`;
    }
    case 'layer-set': {
      const s = cloneSound(layeredOf(lib, c.id, 'layer set'));
      let l = layerAt(s, c.n);
      const names: string[] = [];
      const rest: Raw = [];
      let source: string | null = null;
      for (const [k, v] of c.values) (k === 'source' ? (source = v) : rest.push([k, v]));
      if (source !== null) {
        if (!['classic', 'osc', 'fm', 'ks', 'sample'].includes(source)) throw new Error(`layer set: source is classic, osc, fm, ks or sample (got '${source}')`);
        if (source !== l.kind) {
          const fresh = newLayer(source as Layer['kind'], l.salt);
          for (const k of ['offset', 'gain', 'pan', 'filter', 'cutoff', 'q', 'seed']) if (l.p[k] !== undefined) fresh.p[k] = l.p[k]!;
          for (const k of ['gain', 'pan', 'cutoff', 'q']) if (l.envs[k]) fresh.envs[k] = l.envs[k]!;
          fresh.mute = l.mute;
          fresh.solo = l.solo;
          fresh.amp = l.amp;
          fresh.fx = l.fx;
          s.layers[c.n - 1] = fresh;
          l = fresh;
        }
      }
      setLayerValues(l, rest, `layer set ${c.id} ${c.n}`);
      for (const [k] of rest) names.push(k);
      lib.set(c.id, s);
      const v = valuesText(layerSpecs(l.kind), l.p, names, l.kind);
      return `layer set ${c.id} ${c.n}${source !== null ? ` source=${source}` : ''}${v ? ' ' + v : ''}`;
    }
    case 'layer-remove': {
      const s = cloneSound(layeredOf(lib, c.id, 'layer remove'));
      layerAt(s, c.n);
      s.layers.splice(c.n - 1, 1);
      lib.set(c.id, s);
      return undefined;
    }
    case 'layer-move': {
      const s = cloneSound(layeredOf(lib, c.id, 'layer move'));
      const l = layerAt(s, c.n);
      if (c.to < 1 || c.to > s.layers.length) throw new Error(`to=${c.to}: ${c.id} has layers 1 to ${s.layers.length}`);
      s.layers.splice(c.n - 1, 1);
      s.layers.splice(c.to - 1, 0, l);
      lib.set(c.id, s);
      return undefined;
    }
    case 'layer-flag': {
      const s = cloneSound(layeredOf(lib, c.id, `layer ${c.flag}`));
      layerAt(s, c.n)[c.flag] = c.on;
      lib.set(c.id, s);
      return undefined;
    }
    case 'env': {
      const s = cloneSound(layeredOf(lib, c.id, 'env'));
      const t = parseTarget(c.target);
      const check = (env: Env, spec: PSpec, what: string): Env => {
        for (const p of env) checkNumber(spec, p.v, `${what} (at ${p.t} s)`);
        return env;
      };
      if (t.kind === 'amp') {
        const l = layerAt(s, t.layer);
        l.amp = c.env ? check(c.env, { name: 'amp', min: 0, max: 4, default: 1, unit: '', help: '', env: true }, `env ${c.id} ${c.target}`) : null;
      } else if (t.kind === 'layer') {
        const l = layerAt(s, t.layer);
        const spec = specOf(layerSpecs(l.kind), t.param);
        if (!spec || !spec.env) throw new Error(`${t.param} of a ${l.kind} layer cannot take an envelope (envelopes: amp, ${layerSpecs(l.kind).filter((x) => x.env).map((x) => x.name).join(', ')})`);
        if (c.env) l.envs[t.param] = check(c.env, spec, `env ${c.id} ${c.target}`);
        else delete l.envs[t.param];
      } else {
        const { fx, where } = chainOf(s, t.layer);
        const f = fx[t.fx - 1];
        if (!f) throw new Error(`${where} has no effect ${t.fx}${fx.length ? ` (effects 1 to ${fx.length})` : ''}`);
        const spec = specOf(FX_SPECS[f.kind], t.param);
        if (!spec || !spec.env) throw new Error(`${t.param} of a ${f.kind} effect cannot take an envelope (envelopes: ${FX_SPECS[f.kind].filter((x) => x.env).map((x) => x.name).join(', ')})`);
        if (c.env) f.envs[t.param] = check(c.env, spec, `env ${c.id} ${c.target}`);
        else delete f.envs[t.param];
      }
      lib.set(c.id, s);
      return `env ${c.id} ${formatTarget(t)} ${c.env ? `"${formatEnv(c.env)}"` : 'clear'}`;
    }
    case 'fx-add': {
      const s = cloneSound(layeredOf(lib, c.id, 'fx add'));
      const { fx, where } = chainOf(s, c.layer);
      if (fx.length >= MAX_FX) throw new Error(`${where} has ${MAX_FX} effects already (the most a chain has)`);
      const f = newFx(c.kind);
      for (const [k, raw] of c.values) {
        const spec = specOf(FX_SPECS[c.kind], k);
        if (!spec) throw new Error(`a ${c.kind} effect has no parameter '${k}' (parameters: ${paramNames(FX_SPECS[c.kind])})`);
        f.p[k] = parseValue(spec, raw, `fx add ${c.id} ${c.kind}`);
      }
      const at = c.at ?? fx.length + 1;
      if (at < 1 || at > fx.length + 1) throw new Error(`at=${at}: the new effect goes at 1 to ${fx.length + 1}`);
      fx.splice(at - 1, 0, f);
      lib.set(c.id, s);
      const v = FX_SPECS[c.kind].filter((sp) => f.p[sp.name] !== sp.default).map((sp) => `${sp.name}=${fmtValue(f.p[sp.name]!)}`).join(' ');
      return `fx add ${c.id}${c.layer !== null ? ` layer=${c.layer}` : ''} ${c.kind}${v ? ' ' + v : ''}${c.at !== null ? ` at=${at}` : ''}`;
    }
    case 'fx-set': {
      const s = cloneSound(layeredOf(lib, c.id, 'fx set'));
      const { fx, where } = chainOf(s, c.layer);
      const f = fx[c.k - 1];
      if (!f) throw new Error(`${where} has no effect ${c.k}${fx.length ? ` (effects 1 to ${fx.length})` : ''}`);
      for (const [k, raw] of c.values) {
        const spec = specOf(FX_SPECS[f.kind], k);
        if (!spec) throw new Error(`a ${f.kind} effect has no parameter '${k}' (parameters: ${paramNames(FX_SPECS[f.kind])})`);
        f.p[k] = parseValue(spec, raw, `fx set ${c.id} ${c.k}`);
        delete f.envs[k];
      }
      lib.set(c.id, s);
      return `fx set ${c.id}${c.layer !== null ? ` layer=${c.layer}` : ''} ${c.k} ${valuesText(FX_SPECS[f.kind], f.p, c.values.map(([k]) => k))}`;
    }
    case 'fx-remove':
    case 'fx-move': {
      const s = cloneSound(layeredOf(lib, c.id, c.op === 'fx-remove' ? 'fx remove' : 'fx move'));
      const { fx, where } = chainOf(s, c.layer);
      const f = fx[c.k - 1];
      if (!f) throw new Error(`${where} has no effect ${c.k}${fx.length ? ` (effects 1 to ${fx.length})` : ''}`);
      fx.splice(c.k - 1, 1);
      if (c.op === 'fx-move') {
        if (c.to < 1 || c.to > fx.length + 1) throw new Error(`to=${c.to}: ${where} has effects 1 to ${fx.length + 1}`);
        fx.splice(c.to - 1, 0, f);
      }
      lib.set(c.id, s);
      return undefined;
    }
    default:
      throw new Error(`${c.op} is not a layered command`);
  }
}

/** How much of the start of a sample a recipe lays over its synth body (`preset=<recipe> sample=<name>`), seconds. */
export const RECIPE_SAMPLE_SECONDS = 0.3;

/** Fill a layered sound from a recipe (and, when a sample is named, lay its first moments over it). */
export function applyRecipe(s: LayeredSound, name: RecipeName, seed: number, sample?: string | null): LayeredSound {
  const body = recipeBody(name, seed);
  const out: LayeredSound = { ...s, seed, duration: null, gain: 1, ...body };
  if (sample) {
    // a recording's first moments laid over the synth body: the sample as the transient, the recipe as what carries it
    if (body.layers.length >= MAX_LAYERS) throw new Error(`${name} with seed ${seed} already makes ${body.layers.length} layers, so a sample layer would be one too many (try another seed=)`);
    const l = newLayer('sample', body.nextSalt);
    l.p.sample = sample;
    l.p.interp = 'sinc';
    l.p.end = RECIPE_SAMPLE_SECONDS;
    l.p['fade-out'] = 0.12;
    l.p.gain = 0.8;
    out.layers = [...body.layers, l];
    out.nextSalt = body.nextSalt + 1;
  }
  if (body.gain === undefined) out.gain = 1;
  if (body.loudClass) out.loudClass = body.loudClass;
  // A recipe replaces the whole sound: a bed brings its loop, anything else has none, and a family mark no longer applies.
  if (!body.loop) delete out.loop;
  delete out.family;
  return out;
}


/**
 * A loop renders `length + fade` seconds and folds the part past the end over the start, so a source that stops earlier leaves a hole in
 * the bed. Making a sound a loop therefore lengthens every layer whose source has a `dur` (osc, fm, ks) to cover offset + dur >= length + fade
 * + 50 ms (a layer already long enough is left alone), a recipe's layers included. A classic or sample layer has no `dur`: it plays once
 * inside the loop, which is what a one-shot in a loop is. Returns the layers it lengthened, for the note the writer prints.
 */
export function raiseLayersForLoop(s: LayeredSound, loop: { length: number; fade: number }): { layer: number; from: number; to: number }[] {
  const need = loop.length + loop.fade + 0.05;
  const out: { layer: number; from: number; to: number }[] = [];
  s.layers.forEach((l, i) => {
    const dur = l.p.dur;
    if (typeof dur !== 'number') return;
    const offset = l.p.offset as number;
    if (offset >= loop.length + loop.fade) return;
    const want = Math.min(MAX_SOURCE_DURATION, Math.round((need - offset) * 1000) / 1000);
    if (dur < want - 1e-9) { l.p.dur = want; out.push({ layer: i + 1, from: dur, to: want }); }
  });
  return out;
}
