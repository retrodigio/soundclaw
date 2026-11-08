// The layered voice's document: up to 8 layers, each with one source, a filter, an amplitude
// envelope, effects and envelopes on numeric parameters; a master chain; a few sound-wide values.
// Everything about a parameter (range, default, whether it takes an envelope) is DATA in the
// tables below: the parser, the editor, the docs and the validation all read them.
//
// The order a layer is processed in (and the docs say the same):
//   source -> filter -> amplitude envelope -> effects (in list order) -> gain -> pan -> sum
// then, for the sound:
//   sum of layers -> master gain -> master effects (in list order) -> [limiter, on export]

import { CLASSIC_FIELDS, WAVE_NAMES, formatPatchNamed, makePatch, type ClassicPatch } from './classic.ts';

export const MAX_LAYERS = 8;
export const MAX_FX = 8;
export const MAX_POINTS = 256;
/** The longest a source, a sound or a sample layer is, seconds. */
export const MAX_DURATION = 120;
/** A source may be a little longer than a sound can be: a 120 s loop renders its crossfade past the end (up to 2 s) and needs a source that covers it. */
export const MAX_SOURCE_DURATION = 123;

export type SourceKind = 'classic' | 'osc' | 'fm' | 'ks' | 'sample';
export const SOURCE_KINDS: readonly SourceKind[] = ['classic', 'osc', 'fm', 'ks', 'sample'];
export type FxKind = 'filter' | 'distort' | 'bitcrush' | 'chorus' | 'delay' | 'reverb' | 'compress' | 'limit';
export const FX_KINDS: readonly FxKind[] = ['filter', 'distort', 'bitcrush', 'chorus', 'delay', 'reverb', 'compress', 'limit'];

export type Value = number | string;

/** One parameter: range, default, and whether an envelope may replace its fixed value. */
export interface PSpec {
  name: string;
  /** Numbers: the range. Choices and text: unused. */
  min: number;
  max: number;
  default: Value;
  unit: string;
  help: string;
  /** May a breakpoint envelope replace the fixed value? */
  env: boolean;
  integer?: boolean;
  choices?: readonly string[];
  /** A free text (a sample's name, a wavetable's numbers). */
  text?: boolean;
  /** The parameter may be absent (a seed). */
  optional?: boolean;
}

const num = (name: string, min: number, max: number, def: number, unit: string, help: string, env = false, integer = false): PSpec => ({ name, min, max, default: def, unit, help, env, ...(integer ? { integer } : {}) });
const choice = (name: string, choices: readonly string[], def: string, help: string): PSpec => ({ name, min: 0, max: 0, default: def, unit: '', help, env: false, choices });
const text = (name: string, def: string, help: string): PSpec => ({ name, min: 0, max: 0, default: def, unit: '', help, env: false, text: true });

export const FILTER_TYPES = ['off', 'lp', 'hp', 'bp', 'notch'] as const;
export const OSC_WAVES = ['sine', 'square', 'saw', 'triangle', 'pulse', 'wavetable', 'white', 'pink', 'brown', 'metal'] as const;
export const FM_ALGOS = ['chain', 'fan', 'pairs', 'parallel'] as const;
export const BUILTIN_TABLES = ['organ', 'bell', 'reed', 'hollow'] as const;

/** What every layer has, whatever its source. */
export const LAYER_SPECS: readonly PSpec[] = [
  num('offset', 0, MAX_DURATION, 0, 's', 'when the layer starts, from the start of the sound'),
  num('gain', 0, 4, 1, '', 'level of the layer (1 = as made)', true),
  num('pan', -1, 1, 0, '', '-1 left … 1 right; any layer off centre makes the whole sound stereo', true),
  choice('filter', FILTER_TYPES, 'off', 'the layer\'s own filter: off, lp, hp, bp or notch'),
  num('cutoff', 20, 20000, 1000, 'Hz', 'filter cutoff (centre for bp and notch)', true),
  num('q', 0.5, 20, 0.707, '', 'filter resonance (Q); 0.707 is flat, higher rings at the cutoff', true),
  { ...num('seed', 0, 4294967295, 0, '', 'the noise seed of this layer (default: from the sound\'s seed and the layer)', false, true), optional: true },
];

export const SOURCE_SPECS: Record<Exclude<SourceKind, 'classic'>, readonly PSpec[]> = {
  osc: [
    choice('wave', OSC_WAVES, 'sine', 'sine, square (duty), saw, triangle, pulse (unipolar, duty), wavetable, white / pink / brown noise, metal (periodic noise, pitched by freq)'),
    num('freq', 20, 20000, 440, 'Hz', 'pitch (the pitch of metal noise too; noise ignores it)', true),
    num('duty', 0.01, 0.99, 0.5, '', 'square and pulse: the high part of each cycle', true),
    text('table', 'organ', 'wavetable: organ, bell, reed, hollow, or 4 to 64 numbers like "0,0.5,1,0.5,0,-0.5,-1,-0.5"'),
    num('dur', 0.01, MAX_SOURCE_DURATION, 0.3, 's', 'length of the source'),
  ],
  fm: [
    num('freq', 20, 20000, 440, 'Hz', 'base pitch; each operator runs at freq × its ratio', true),
    num('dur', 0.01, MAX_SOURCE_DURATION, 0.3, 's', 'length of the source'),
    num('ops', 2, 4, 2, '', 'how many operators (2 to 4)', false, true),
    choice('algo', FM_ALGOS, 'chain', 'chain: 4→3→2→1; fan: 2, 3 and 4 all modulate 1; pairs: 2→1 and 4→3 added; parallel: all added (no modulation). Operator 1 is always a carrier'),
    num('ratio1', 0.25, 16, 1, '', 'operator 1 frequency ratio'),
    num('ratio2', 0.25, 16, 2, '', 'operator 2 frequency ratio'),
    num('ratio3', 0.25, 16, 3, '', 'operator 3 frequency ratio'),
    num('ratio4', 0.25, 16, 4, '', 'operator 4 frequency ratio'),
    num('index2', 0, 20, 1, 'rad', 'how strongly operator 2 modulates its target (0 = silent modulator)', true),
    num('index3', 0, 20, 0, 'rad', 'operator 3 modulation depth', true),
    num('index4', 0, 20, 0, 'rad', 'operator 4 modulation depth', true),
    num('level1', 0, 1, 1, '', 'operator 1 output level', true),
    num('level2', 0, 1, 1, '', 'operator 2 level when it is a carrier (pairs, parallel)', true),
    num('level3', 0, 1, 1, '', 'operator 3 level when it is a carrier', true),
    num('level4', 0, 1, 1, '', 'operator 4 level when it is a carrier', true),
  ],
  ks: [
    num('freq', 20, 20000, 220, 'Hz', 'pitch of the string'),
    num('dur', 0.01, MAX_SOURCE_DURATION, 1, 's', 'length of the source'),
    num('decay', 0.05, 10, 1, 's', 'time for the string to fall by 60 dB'),
    num('bright', 0, 1, 0.8, '', 'brightness of the pluck (0 dull … 1 bright)'),
  ],
  sample: [
    text('sample', '', 'the name of a sample in the project (sample import <project> <file.wav> as=<name>)'),
    num('start', 0, MAX_DURATION, 0, 's', 'trim: where in the sample to start'),
    num('end', 0, MAX_DURATION, 0, 's', 'trim: where to stop (0 = the end)'),
    num('pitch', -48, 48, 0, 'semitones', 'transposition (the sample\'s length changes with it)', true),
    num('reverse', 0, 1, 0, '', '1 plays it backwards', false, true),
    choice('side', ['mix', 'left', 'right'], 'mix', 'which channel of a stereo file: mix (both averaged), left or right (a mono file is the same in each); for the whole file in stereo use two layers, side=left pan=-1 and side=right pan=1'),
  ],
};

const CLASSIC_SPECS: readonly PSpec[] = CLASSIC_FIELDS.map((f) => ({ name: f.name, min: f.min, max: f.max, default: f.default, unit: '', help: f.help, env: false, ...(f.name === 'wave' ? { integer: true } : {}) }));

/** The parameters of a layer with this source: the source's own, then what every layer has. */
export function layerSpecs(kind: SourceKind): readonly PSpec[] {
  return [...(kind === 'classic' ? CLASSIC_SPECS : SOURCE_SPECS[kind]), ...LAYER_SPECS];
}

const fxNum = num;
export const FX_SPECS: Record<FxKind, readonly PSpec[]> = {
  filter: [
    choice('type', ['lp', 'hp', 'bp', 'notch'], 'lp', 'low-pass, high-pass, band-pass or notch'),
    fxNum('cutoff', 20, 20000, 1000, 'Hz', 'cutoff (centre for bp and notch)', true),
    fxNum('q', 0.5, 20, 0.707, '', 'resonance (Q)', true),
  ],
  distort: [
    choice('shape', ['soft', 'hard', 'fold', 'cubic'], 'soft', 'soft: x/(1+|x|); hard: clip at ±1; fold: wavefolder; cubic: smooth clip'),
    fxNum('drive', 1, 50, 4, '', 'gain into the shaper', true),
    fxNum('mix', 0, 1, 1, '', 'dry/wet', true),
  ],
  bitcrush: [
    fxNum('bits', 1, 16, 8, 'bits', 'quantise to this many bits (steps of 2^(1-bits))', false, true),
    fxNum('rate', 200, 44100, 44100, 'Hz', 'sample-rate reduction: hold each sample to this rate (44100 = off)', true),
    fxNum('mix', 0, 1, 1, '', 'dry/wet', true),
  ],
  chorus: [
    fxNum('rate', 0.05, 10, 0.8, 'Hz', 'speed of the sweep'),
    fxNum('depth', 0, 10, 3, 'ms', 'how far the delay sweeps', true),
    fxNum('delay', 5, 30, 15, 'ms', 'centre delay'),
    fxNum('mix', 0, 1, 0.5, '', 'dry/wet', true),
  ],
  delay: [
    fxNum('time', 0.01, 1, 0.25, 's', 'time between echoes'),
    fxNum('feedback', 0, 0.95, 0.4, '', 'how much of each echo is fed back', true),
    fxNum('mix', 0, 1, 0.35, '', 'dry/wet', true),
  ],
  reverb: [
    fxNum('size', 0, 1, 0.5, '', 'room size (0 small … 1 large); the tail is the time to fall 60 dB: about 0.6 s at 0, 1.3 s at 0.5, 11 s at 1'),
    fxNum('damp', 0, 1, 0.5, '', 'how fast the highs die away'),
    fxNum('mix', 0, 1, 0.3, '', 'dry/wet', true),
  ],
  compress: [
    fxNum('threshold', -60, 0, -18, 'dB', 'level above which the sound is turned down (peak level, dBFS)'),
    fxNum('ratio', 1, 20, 4, '', 'how much of the level above the threshold is kept: 4 means 4 dB over becomes 1 dB over'),
    fxNum('attack', 0.1, 200, 5, 'ms', 'how fast the detector follows a rise in level'),
    fxNum('release', 5, 2000, 100, 'ms', 'how fast the detector lets go after the level falls'),
    fxNum('makeup', 0, 24, 0, 'dB', 'gain added after compressing'),
  ],
  limit: [
    fxNum('ceiling', -24, 0, -1, 'dB', 'nothing goes above this level (dBFS, or dBTP in true mode) after the limiter'),
    fxNum('release', 1, 1000, 20, 'ms', 'how fast the gain comes back after a peak (20 ms lets a train of hits each be limited on its own; a long release makes the hits after a loud one quieter)'),
    fxNum('lookahead', 0, 20, 5, 'ms', 'how long before a peak the gain starts to come down (0: it drops at once; in true mode at least 1 ms)'),
    choice('mode', ['true', 'sample'], 'true', 'true: the 4x-oversampled peak between the samples is held under the ceiling (0.1 dB inside it), so the clip check passes; sample: only the samples are'),
  ],
};

/** Sound-wide values (`sound set <id> …` on a layered sound). */
export const SOUND_SPECS: readonly PSpec[] = [
  { ...num('duration', 0.01, MAX_DURATION, 0, 's', 'length of the sound; `auto` (the default) is as long as the layers and their tails'), optional: true },
  num('gain', 0, 4, 1, '', 'master level (before the master chain)'),
  num('out', -48, 48, 0, 'dB', 'output level in dB, after the master chain (0 = off); `normalize` uses it when gain 4 is not enough'),
  num('seed', 0, 4294967295, 1, '', 'the sound\'s noise seed (layers derive theirs from it)', false, true),
];

// ---- envelopes ------------------------------------------------------------------------------------

export type Curve = 'lin' | 'exp' | 'hold' | 'ease';
export const CURVES: readonly Curve[] = ['lin', 'exp', 'hold', 'ease'];
/** `curve` shapes the segment that arrives at this point from the one before (the first point's is unused): `0:100 0.2:400@exp` glides up exponentially, `0:1 0.5:3@hold` stays at 1 until 0.5 s and then jumps. */
export interface Point {
  t: number;
  v: number;
  curve: Curve;
}
export type Env = Point[];

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
export const fmtNum = (n: number): string => String(round6(n) === 0 ? 0 : n);

/** Breakpoints as text: `0:1 0.1:0.5@exp 0.3:0` (the curve of the segment arriving at a point; linear is not written). */
export function formatEnv(e: Env): string {
  return e.map((p) => `${fmtNum(p.t)}:${fmtNum(p.v)}${p.curve === 'lin' ? '' : '@' + p.curve}`).join(' ');
}

const CURVE_ALIAS: Record<string, Curve> = { lin: 'lin', linear: 'lin', exp: 'exp', exponential: 'exp', hold: 'hold', step: 'hold', ease: 'ease' };

export function parseNumber(s: string): number | null {
  return /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) ? Number(s) : null;
}

/** Parse breakpoints: points `t:v` or `t:v@curve`, times rising from 0 or later. Throws a plain Error. */
export function parseEnv(src: string): Env {
  const words = src.trim().split(/[\s,]+/).filter(Boolean);
  if (!words.length) throw new Error('give breakpoints like "0:1 0.1:0.5@exp 0.3:0" (time in seconds : value, @curve = lin, exp, hold or ease)');
  if (words.length > MAX_POINTS) throw new Error(`an envelope has at most ${MAX_POINTS} breakpoints (got ${words.length})`);
  const out: Env = [];
  for (const w of words) {
    const m = /^([^:@]+):([^:@]+)(?:@([a-z]+))?$/.exec(w);
    if (!m) throw new Error(`'${w}' is not a breakpoint (time:value or time:value@curve)`);
    const t = parseNumber(m[1]!);
    const v = parseNumber(m[2]!);
    if (t === null || v === null) throw new Error(`'${w}': time and value must be numbers`);
    if (t < 0) throw new Error(`'${w}': time cannot be negative`);
    const curve = m[3] ? CURVE_ALIAS[m[3]] : 'lin';
    if (!curve) throw new Error(`'${w}': no curve '${m[3]}' (lin, exp, hold, ease)`);
    if (out.length && t <= out[out.length - 1]!.t) throw new Error(`'${w}': times must rise (after ${fmtNum(out[out.length - 1]!.t)} s)`);
    out.push({ t, v, curve });
  }
  return out;
}

/** The ADSR shorthand: `adsr(attack, decay, sustain, release[, hold])` written as breakpoints (an amplitude envelope, 0..1). */
export function adsr(a: number, d: number, s: number, r: number, hold = 0): Env {
  const pts: Env = [];
  let t = 0;
  if (a > 0) { pts.push({ t: 0, v: 0, curve: 'lin' }); t = a; }
  pts.push({ t: round6(t), v: 1, curve: 'lin' });
  if (d > 0) { t += d; pts.push({ t: round6(t), v: s, curve: 'exp' }); }
  if (hold > 0) { t += hold; pts.push({ t: round6(t), v: s, curve: 'lin' }); }
  if (r > 0) { t += r; pts.push({ t: round6(t), v: 0, curve: 'exp' }); }
  return pts;
}

// ---- the document ---------------------------------------------------------------------------------

export interface Fx {
  kind: FxKind;
  /** Every parameter of the kind, filled in. */
  p: Record<string, Value>;
  /** Envelopes that replace fixed values, by parameter name. */
  envs: Record<string, Env>;
}

export interface Layer {
  /** A number that stays with the layer through moves: the noise seed derives from it. */
  salt: number;
  kind: SourceKind;
  /** Every parameter (the source's and the layer's), filled in; `seed` only when given. */
  p: Record<string, Value>;
  mute: boolean;
  solo: boolean;
  /** The amplitude envelope (null: a 2 ms fade at both ends, none on a classic source). */
  amp: Env | null;
  envs: Record<string, Env>;
  fx: Fx[];
}

/** A loop: the sound is `length` seconds and repeats without a seam (see renderLayered: the part rendered past the end is crossfaded over the start, `fade` seconds). */
export interface LoopSpec {
  length: number;
  fade: number;
}
export const LOOP_LENGTH = { min: 0.1, max: 120 } as const;
export const LOOP_FADE = { min: 0.02, max: 2, default: 0.5 } as const;

export type FamilyKind = 'near' | 'far' | 'muffled';

/** Where a family variant came from: a copy of `of` made by the rules of `kind`; `offsetDb` is how much quieter (or louder) than the sound it is held to be. */
export interface FamilyMark {
  of: string;
  kind: FamilyKind;
  offsetDb: number;
}

export interface LayeredSound {
  id: string;
  voice: 'layered';
  /** null: as long as the layers and their tails. */
  duration: number | null;
  gain: number;
  /** Output level in dB after the master chain; absent: 0. */
  out?: number;
  seed: number;
  /** A looping bed: the sound is loop.length seconds long and its seam is made seamless. */
  loop?: LoopSpec;
  /** Set by `family`: the variant's loudness is held to the style's target plus offsetDb. */
  family?: FamilyMark;
  /** The loudness class (a name in the style's loudnessClasses) the sound is checked against; absent: its set's, else the style's default. */
  loudClass?: string;
  /** A loudness (LUFS) for this sound alone, in place of its class's target. */
  loudness?: number;
  /** The situation in the game the sound is for. Words only: rendering never reads it. */
  moment?: string;
  /** The next layer's salt. */
  nextSalt: number;
  layers: Layer[];
  master: Fx[];
  status: 'draft' | 'approved' | 'rejected';
}

export function defaultsOf(specs: readonly PSpec[]): Record<string, Value> {
  const o: Record<string, Value> = {};
  for (const s of specs) if (!s.optional) o[s.name] = s.default;
  return o;
}

export function newLayeredSound(id: string, seed: number): LayeredSound {
  return { id, voice: 'layered', duration: null, gain: 1, seed, nextSalt: 1, layers: [], master: [], status: 'draft' };
}

export function newLayer(kind: SourceKind, salt: number): Layer {
  return { salt, kind, p: defaultsOf(layerSpecs(kind)), mute: false, solo: false, amp: null, envs: {}, fx: [] };
}

export function newFx(kind: FxKind): Fx {
  return { kind, p: defaultsOf(FX_SPECS[kind]), envs: {} };
}

export function cloneLayered(s: LayeredSound): LayeredSound {
  const fx = (f: Fx): Fx => ({ kind: f.kind, p: { ...f.p }, envs: Object.fromEntries(Object.entries(f.envs).map(([k, e]) => [k, e.map((p) => ({ ...p }))])) });
  return {
    ...s,
    ...(s.loop ? { loop: { ...s.loop } } : {}),
    ...(s.family ? { family: { ...s.family } } : {}),
    layers: s.layers.map((l) => ({ ...l, p: { ...l.p }, amp: l.amp ? l.amp.map((p) => ({ ...p })) : null, envs: Object.fromEntries(Object.entries(l.envs).map(([k, e]) => [k, e.map((p) => ({ ...p }))])), fx: l.fx.map(fx) })),
    master: s.master.map(fx),
  };
}

/** A classic layer's patch. */
export function layerPatch(l: Layer): ClassicPatch {
  const t: Record<string, unknown> = {};
  for (const f of CLASSIC_FIELDS) t[f.name] = l.p[f.name];
  if (l.p.seed !== undefined) t.seed = l.p.seed;
  return makePatch(t);
}

/** A layer from a classic patch (what `layer-up` and a classic `layer add` make). */
export function classicLayer(patch: ClassicPatch, salt: number): Layer {
  const l = newLayer('classic', salt);
  for (const f of CLASSIC_FIELDS) l.p[f.name] = patch[f.name];
  if (patch.seed !== undefined) l.p.seed = patch.seed;
  return l;
}

// ---- values ---------------------------------------------------------------------------------------

/** Check one value given as text against its spec: the typed value, or a plain Error saying why not. */
export function parseValue(spec: PSpec, raw: string, what: string): Value {
  if (spec.choices) {
    if (!spec.choices.includes(raw)) throw new Error(`${what}: ${spec.name} is one of ${spec.choices.join(', ')} (got '${raw}')`);
    return raw;
  }
  if (spec.text) {
    if (spec.name === 'sample') {
      if (raw !== '' && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(raw)) throw new Error(`${what}: '${raw}' is not a sample name (letters, digits, _ and -)`);
    } else if (spec.name === 'table') {
      parseTable(raw, what);
    }
    return raw;
  }
  if (spec.name === 'wave' && spec.integer && (WAVE_NAMES as readonly string[]).includes(raw)) return (WAVE_NAMES as readonly string[]).indexOf(raw);
  const n = parseNumber(raw);
  if (n === null) throw new Error(`${what}: ${spec.name} must be a number${spec.name === 'wave' && spec.integer ? ' or square, saw, sine, noise' : ''} (got '${raw}')`);
  return checkNumber(spec, n, what);
}

export function checkNumber(spec: PSpec, n: number, what: string): number {
  if (!Number.isFinite(n) || n < spec.min || n > spec.max) throw new Error(`${what}: ${spec.name} must be between ${spec.min} and ${spec.max}${spec.unit ? ' ' + spec.unit : ''} (got ${n})`);
  if (spec.integer && !Number.isInteger(n)) throw new Error(`${what}: ${spec.name} must be a whole number (got ${n})`);
  return n;
}

/** A wavetable given as numbers: 4 to 64 of them in -1..1 (or a built-in name). */
export function parseTable(raw: string, what = 'table'): number[] | string {
  if ((BUILTIN_TABLES as readonly string[]).includes(raw)) return raw;
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  const xs = parts.map((p) => parseNumber(p));
  if (parts.length < 4 || parts.length > 64 || xs.some((x) => x === null || x < -1 || x > 1)) {
    throw new Error(`${what}: the wavetable is ${BUILTIN_TABLES.join(', ')} or 4 to 64 numbers between -1 and 1 (got '${raw.length > 40 ? raw.slice(0, 40) + '…' : raw}')`);
  }
  return xs as number[];
}

export function specOf(specs: readonly PSpec[], name: string): PSpec | undefined {
  return specs.find((s) => s.name === name);
}

export function paramNames(specs: readonly PSpec[]): string {
  return specs.map((s) => s.name).join(', ');
}

// ---- targets (`env` commands) ---------------------------------------------------------------------

export type Target =
  | { kind: 'layer'; layer: number; param: string }
  | { kind: 'amp'; layer: number }
  | { kind: 'fx'; layer: number | null; fx: number; param: string };

/** `1.freq`, `2.amp`, `1.fx2.mix`, `master.fx1.mix` (layers and effects count from 1). */
export function parseTarget(t: string): Target {
  let m = /^(\d+)\.amp$/.exec(t);
  if (m) return { kind: 'amp', layer: Number(m[1]) };
  m = /^(\d+|master)\.fx(\d+)\.([A-Za-z0-9]+)$/.exec(t);
  if (m) return { kind: 'fx', layer: m[1] === 'master' ? null : Number(m[1]), fx: Number(m[2]), param: m[3]! };
  m = /^(\d+)\.([A-Za-z0-9]+)$/.exec(t);
  if (m) return { kind: 'layer', layer: Number(m[1]), param: m[2]! };
  throw new Error(`'${t}' is not an envelope target (like 1.freq, 2.amp, 1.cutoff, 1.fx2.mix or master.fx1.mix; layers and effects count from 1)`);
}

export function formatTarget(t: Target): string {
  if (t.kind === 'amp') return `${t.layer}.amp`;
  if (t.kind === 'layer') return `${t.layer}.${t.param}`;
  return `${t.layer === null ? 'master' : t.layer}.fx${t.fx}.${t.param}`;
}

// ---- text forms -----------------------------------------------------------------------------------

const q = (s: string): string => `"${s}"`;
/** A value as written in commands (a classic layer's wave by name). */
export const showValue = (kind: string, name: string, v: Value): string => (kind === 'classic' && name === 'wave' && typeof v === 'number' ? WAVE_NAMES[v] ?? String(v) : fmtValue(v));
export const fmtValue = (v: Value): string => (typeof v === 'number' ? String(v) : /^[A-Za-z0-9_.,-]+$/.test(v) ? v : q(v));

/** The text of a layered sound's file: every value, one layer per block. */
export function serializeLayered(s: LayeredSound): string[] {
  const lines = [`seed ${s.seed}`, `duration ${s.duration === null ? 'auto' : fmtNum(s.duration)}`, `gain ${fmtNum(s.gain)}`];
  if (s.out) lines.push(`out ${fmtNum(s.out)}`);
  if (s.loop) lines.push(`loop ${fmtNum(s.loop.length)} fade ${fmtNum(s.loop.fade)}`);
  if (s.family) lines.push(`family ${s.family.kind} of ${s.family.of} offset ${fmtNum(s.family.offsetDb)}`);
  if (s.loudClass) lines.push(`class ${s.loudClass}`);
  if (s.loudness !== undefined) lines.push(`loudness ${fmtNum(s.loudness)}`);
  const fxLines = (fx: Fx[], indent: string, prefix: string): void => {
    fx.forEach((f, i) => {
      lines.push(`${indent}fx ${i + 1} ${f.kind} ${FX_SPECS[f.kind].map((sp) => `${sp.name}=${fmtValue(f.p[sp.name]!)}`).join(' ')}`);
      for (const [k, e] of Object.entries(f.envs)) lines.push(`${indent}  env ${prefix}fx${i + 1}.${k} ${q(formatEnv(e))}`);
    });
  };
  s.layers.forEach((l, i) => {
    const specs = layerSpecs(l.kind);
    const flags = `${l.mute ? ' muted' : ''}${l.solo ? ' solo' : ''}`;
    lines.push(`layer ${i + 1} ${l.kind}${flags} ${specs.filter((sp) => l.p[sp.name] !== undefined).map((sp) => `${sp.name}=${fmtValue(l.p[sp.name]!)}`).join(' ')}`);
    if (l.amp) lines.push(`  env ${i + 1}.amp ${q(formatEnv(l.amp))}`);
    for (const [k, e] of Object.entries(l.envs)) lines.push(`  env ${i + 1}.${k} ${q(formatEnv(e))}`);
    fxLines(l.fx, '  ', `${i + 1}.`);
  });
  if (s.master.length) { lines.push('master'); fxLines(s.master, '  ', 'master.'); }
  return lines;
}

/** The canonical text the render key is a hash of: everything the audio depends on, in a fixed order. `sampleHash` says which bytes a sample name stood for. */
export function layeredBody(s: LayeredSound, sampleHash: (name: string) => string): string {
  const fx = (f: Fx): string => `${f.kind}(${FX_SPECS[f.kind].map((sp) => `${sp.name}=${fmtValue(f.p[sp.name]!)}`).join(',')};${Object.keys(f.envs).sort().map((k) => `${k}=${formatEnv(f.envs[k]!)}`).join(',')})`;
  const parts = [`dur=${s.duration ?? 'auto'}`, `gain=${s.gain}`, `seed=${s.seed}`];
  if (s.out) parts.push(`out=${s.out}`);
  if (s.loop) parts.push(`loop=${s.loop.length}/${s.loop.fade}`);
  s.layers.forEach((l) => {
    if (l.mute) { parts.push(`L${l.salt}:muted`); return; }
    const specs = layerSpecs(l.kind);
    const vals = specs.filter((sp) => l.p[sp.name] !== undefined).map((sp) => `${sp.name}=${fmtValue(l.p[sp.name]!)}`);
    const sampleName = l.kind === 'sample' ? String(l.p.sample) : '';
    parts.push(`L${l.salt}:${l.kind}${l.solo ? ':solo' : ''}(${vals.join(',')})${sampleName ? `[${sampleHash(sampleName)}]` : ''}amp=${l.amp ? formatEnv(l.amp) : '-'};${Object.keys(l.envs).sort().map((k) => `${k}=${formatEnv(l.envs[k]!)}`).join(',')};${l.fx.map(fx).join('>')}`);
  });
  parts.push(`master:${s.master.map(fx).join('>')}`);
  return parts.join('|');
}

/** Is any layer panned off centre (so the sound has two channels)? */
export function isStereo(s: LayeredSound): boolean {
  return s.layers.some((l) => l.p.pan !== 0 || l.envs.pan !== undefined);
}

/** Layers that sound: not muted, and if any is soloed, only those. */
export function audibleLayers(s: LayeredSound): Layer[] {
  const solo = s.layers.some((l) => l.solo && !l.mute);
  return s.layers.filter((l) => !l.mute && (!solo || l.solo));
}

/** A one-line description of a layer's source for lists and views: `osc sine 60 Hz`. */
export function layerLabel(l: Layer): string {
  switch (l.kind) {
    case 'classic': return `classic ${['square', 'saw', 'sine', 'noise'][l.p.wave as number] ?? ''}`;
    case 'osc': return `osc ${l.p.wave}${['white', 'pink', 'brown'].includes(l.p.wave as string) ? '' : l.envs.freq ? ' (pitch envelope)' : ` ${l.p.freq} Hz`}`;
    case 'fm': return `fm ${l.p.ops} ops ${l.p.algo} ${l.envs.freq ? '(pitch envelope)' : `${l.p.freq} Hz`}`;
    case 'ks': return `pluck ${l.p.freq} Hz`;
    case 'sample': return `sample ${l.p.sample || '(none)'}`;
  }
}

/** The classic patch text of a layer, for the docs and errors. */
export const classicPatchText = (l: Layer): string => formatPatchNamed(layerPatch(l));

/** A markdown table of parameters (for the command reference; a test keeps docs/commands.md in step). */
export function specsTable(specs: readonly PSpec[]): string {
  const range = (s: PSpec): string => (s.choices ? s.choices.map((c) => `\`${c}\``).join(', ') : s.text ? 'text' : `${s.min} to ${s.max}${s.unit ? ' ' + s.unit : ''}${s.integer ? ' (whole)' : ''}`);
  const def = (s: PSpec): string => (s.optional ? (s.name === 'duration' ? 'auto' : 'from the sound') : s.default === '' ? 'none' : String(s.default));
  const lines = ['| Parameter | Range | Default | Envelope | Meaning |', '|---|---|---|---|---|'];
  for (const s of specs) lines.push(`| \`${s.name}\` | ${range(s)} | ${def(s)} | ${s.env ? 'yes' : '-'} | ${s.help} |`);
  return lines.join('\n');
}
