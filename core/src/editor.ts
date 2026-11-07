// What the sound editor needs that is not drawing: how the parameters are grouped (as sfxr groups
// them), the commands a person's edits are written as (the very text an agent would write), the
// rule that turns a drag into one command, and the tags a person can put on a sound. Pure, so the
// page and the tests use the same code.

import { CLASSIC_FIELDS, WAVE_NAMES, classicField, formatCsv, formatPatch, formatPatchNamed, type ClassicKey, type ClassicPatch } from './classic.ts';
import { FX_SPECS, formatEnv, layerSpecs, showValue, type Env, type FxKind, type PSpec, type SourceKind, type Value } from './layered.ts';
import { fmtNumber } from './sound.ts';

export interface EditorGroup {
  id: string;
  title: string;
  params: readonly ClassicKey[];
}

/** The parameters in the groups sfxr's window shows them in. Every one of the 25 is in exactly one. */
export const EDITOR_GROUPS: readonly EditorGroup[] = [
  { id: 'wave', title: 'Wave', params: ['wave'] },
  { id: 'envelope', title: 'Envelope', params: ['attack', 'sustain', 'punch', 'decay'] },
  { id: 'frequency', title: 'Frequency and slides', params: ['freq', 'minFreq', 'slide', 'deltaSlide'] },
  { id: 'vibrato', title: 'Vibrato', params: ['vibratoDepth', 'vibratoSpeed', 'vibratoDelay'] },
  { id: 'change', title: 'Change', params: ['changeAmount', 'changeSpeed'] },
  { id: 'duty', title: 'Duty (square)', params: ['duty', 'dutySweep'] },
  { id: 'repeat', title: 'Repeat', params: ['repeatSpeed'] },
  { id: 'phaser', title: 'Phaser', params: ['phaserOffset', 'phaserSweep'] },
  { id: 'filters', title: 'Filters', params: ['lowPass', 'lowPassSweep', 'resonance', 'highPass', 'highPassSweep'] },
  { id: 'volume', title: 'Volume', params: ['volume'] },
];

/** A value for `sound set`: a number, or `auto` for the seed. */
export type EditValue = number | 'auto';
export type Edits = Partial<Record<ClassicKey | 'seed', EditValue>>;

const ORDER: readonly string[] = [...CLASSIC_FIELDS.map((f) => f.name), 'seed'];

/** A slider value: three decimals (what the generators write, and what survives the patch text), kept in the parameter's range. The wave is a whole number. */
export function roundParam(name: ClassicKey, v: number): number {
  const f = classicField(name)!;
  if (name === 'wave') return Math.min(f.max, Math.max(f.min, Math.round(v)));
  return Math.min(f.max, Math.max(f.min, Math.round(v * 1000) / 1000));
}

/** `sound set <id> …` in its normal form (parameters in the order of the table, the wave by name): the line an agent would write, and the one the tape holds. */
export function setCommand(id: string, edits: Edits): string {
  const names = Object.keys(edits).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const parts = names.map((n) => {
    const v = edits[n as ClassicKey | 'seed']!;
    return `${n}=${v === 'auto' ? 'auto' : n === 'wave' ? WAVE_NAMES[v] ?? fmtNumber(v) : fmtNumber(v)}`;
  });
  return `sound set ${id} ${parts.join(' ')}`;
}

/** What differs between two patches, as the values to set to get from `from` to `to` (the seed back to `auto` when `to` has none). */
export function diffPatch(from: ClassicPatch, to: ClassicPatch): Edits {
  const out: Edits = {};
  for (const f of CLASSIC_FIELDS) if (from[f.name] !== to[f.name]) out[f.name] = to[f.name];
  if (from.seed !== to.seed) out.seed = to.seed === undefined ? 'auto' : to.seed;
  return out;
}

/** The one command that makes `current` the same as `target` ("Keep A"); null when they already are. */
export function restoreCommand(id: string, current: ClassicPatch, target: ClassicPatch): string | null {
  const d = diffPatch(current, target);
  return Object.keys(d).length ? setCommand(id, d) : null;
}

/** `sound set` resetting parameters to their defaults. */
export function resetCommand(id: string, names: readonly ClassicKey[]): string {
  const e: Edits = {};
  for (const n of names) e[n] = classicField(n)!.default;
  return setCommand(id, e);
}

export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/**
 * The rule that keeps a drag from writing one command per pixel: values pushed while a control
 * moves are kept (the latest per parameter), and written as ONE `sound set` when the control is
 * released (`flush`), or when it has not moved for `pauseMs`. Nothing else sends.
 */
export class Coalescer {
  private pending: Edits = {};
  private timer: unknown = null;
  private readonly send: (edits: Edits) => void;
  private readonly sched: Scheduler;
  readonly pauseMs: number;
  constructor(send: (edits: Edits) => void, sched: Scheduler, pauseMs = 700) {
    this.send = send;
    this.sched = sched;
    this.pauseMs = pauseMs;
  }

  get active(): boolean {
    return Object.keys(this.pending).length > 0;
  }

  /** A control moved to a value. */
  push(name: ClassicKey | 'seed', value: EditValue): void {
    this.pending[name] = value;
    if (this.timer !== null) this.sched.clear(this.timer);
    this.timer = this.sched.set(() => { this.timer = null; this.flush(); }, this.pauseMs);
  }

  /** The control was released: write what is pending, if anything. */
  flush(): void {
    if (this.timer !== null) { this.sched.clear(this.timer); this.timer = null; }
    if (!this.active) return;
    const edits = this.pending;
    this.pending = {};
    this.send(edits);
  }

  /** The pending value for a parameter, if the control is still moving. */
  value(name: ClassicKey | 'seed'): EditValue | undefined {
    return this.pending[name];
  }

  cancel(): void {
    if (this.timer !== null) { this.sched.clear(this.timer); this.timer = null; }
    this.pending = {};
  }
}

/** The quick tags a person can put on a sound's card. `good` praises; the others ask for a change. */
export const FEEDBACK_TAGS = ['too loud', 'too quiet', 'too long', 'too short', 'too harsh', 'too dull', 'too similar to another sound', 'good'] as const;
export type FeedbackTag = (typeof FEEDBACK_TAGS)[number];
export const SIMILAR_TAG: FeedbackTag = 'too similar to another sound';

export function isFeedbackTag(t: string): t is FeedbackTag {
  return (FEEDBACK_TAGS as readonly string[]).includes(t);
}

/** The words a request carries when a person sent tags and no text. */
export function tagsNote(tags: readonly string[], other?: string): string {
  return tags.map((t) => (t === SIMILAR_TAG && other ? `too similar to ${other}` : t)).join(', ');
}

// ---- export forms ---------------------------------------------------------------------------------

/** The text of a sound's patch file (`<id>.sfxr`): the engine's positional form; named pairs when there is a seed, which the positional form cannot carry. */
export function patchFileText(p: ClassicPatch): string {
  return p.seed !== undefined ? `1\n${formatPatchNamed(p)}\n` : formatPatch(p);
}

/** A synth.csv with one row for the sound. */
export function csvFileText(id: string, p: ClassicPatch): string {
  return formatCsv([{ id, patch: p }]);
}

// ---- the layered editor ---------------------------------------------------------------------------


/** A slider for a parameter runs on a log scale when it is a frequency or a time whose range spans a factor of 50 or more (pitches, cutoffs, lengths). */
export const isLogScale = (s: Pick<PSpec, 'min' | 'max' | 'unit' | 'choices' | 'text'>): boolean => !s.choices && !s.text && s.min > 0 && s.max / s.min >= 50 && (s.unit === 'Hz' || s.unit === 's');

/** A slider position in 0..1 to the parameter's value (log or linear), rounded the way the generators round. */
export function sliderValue(s: PSpec, t: number): number {
  const c = Math.min(1, Math.max(0, t));
  const v = isLogScale(s) ? s.min * (s.max / s.min) ** c : s.min + (s.max - s.min) * c;
  return roundSpec(s, v);
}

/** The inverse: the position of a value on its slider. */
export function sliderPosition(s: PSpec, v: number): number {
  const c = isLogScale(s) ? Math.log(v / s.min) / Math.log(s.max / s.min) : (v - s.min) / (s.max - s.min);
  return Math.min(1, Math.max(0, c));
}

/** A value kept in range and rounded: whole numbers for integer parameters, 3 significant digits on a log scale, 3 decimals otherwise. */
export function roundSpec(s: PSpec, v: number): number {
  const c = Math.min(s.max, Math.max(s.min, v));
  if (s.integer) return Math.round(c);
  if (isLogScale(s)) return Number(c.toPrecision(3));
  return Math.round(c * 1000) / 1000;
}

const pairs = (specs: readonly PSpec[], kind: string, p: Record<string, Value>, names: readonly string[]): string =>
  specs.filter((sp) => names.includes(sp.name)).map((sp) => `${sp.name}=${showValue(kind, sp.name, p[sp.name]!)}`).join(' ');

/** `layer set <id> <n> …` in its normal form (values in the order of the layer's parameter table). */
export function layerSetCommand(id: string, n: number, kind: SourceKind, values: Record<string, Value>): string {
  return `layer set ${id} ${n} ${pairs(layerSpecs(kind), kind, values, Object.keys(values))}`;
}

/** `fx set <id> [layer=<n>] <k> …` in its normal form. */
export function fxSetCommand(id: string, layer: number | null, k: number, kind: FxKind, values: Record<string, Value>): string {
  return `fx set ${id}${layer === null ? '' : ` layer=${layer}`} ${k} ${pairs(FX_SPECS[kind], '', values, Object.keys(values))}`;
}

/** `env <id> <target> "<breakpoints>"` (or `clear`) in its normal form. */
export function envCommand(id: string, target: string, env: Env | null): string {
  return `env ${id} ${target} ${env ? `"${formatEnv(env)}"` : 'clear'}`;
}

/** Where a breakpoint can go: times rise (a drag cannot cross its neighbours), rounded to a millisecond; the value is kept in range and rounded. */
export function movePoint(env: Env, i: number, t: number, v: number, spec: Pick<PSpec, 'min' | 'max' | 'unit'>): Env {
  const lo = i === 0 ? 0 : env[i - 1]!.t + 0.001;
  const hi = i === env.length - 1 ? Infinity : env[i + 1]!.t - 0.001;
  const time = Math.round(Math.min(hi, Math.max(lo, t)) * 1000) / 1000;
  const val = Math.min(spec.max, Math.max(spec.min, v));
  const rounded = isLogScale(spec) ? Number(val.toPrecision(3)) : Math.round(val * 1000) / 1000;
  return env.map((p, k) => (k === i ? { ...p, t: time, v: rounded } : p));
}

/** A new breakpoint at a time (value read off the curve by the caller), keeping times rising. Null when the time is taken. */
export function addPoint(env: Env, t: number, v: number): Env | null {
  const time = Math.round(t * 1000) / 1000;
  if (time < 0 || env.some((p) => Math.abs(p.t - time) < 0.001)) return null;
  return [...env, { t: time, v, curve: 'lin' as const }].sort((a, b) => a.t - b.t);
}

/** An envelope that holds a value: two flat points, the start of an edit. */
export function flatEnv(v: number, span: number): Env {
  return [{ t: 0, v, curve: 'lin' }, { t: Math.round(span * 1000) / 1000, v, curve: 'lin' }];
}

/**
 * The rule that keeps a drag from writing one command per pixel, for any named control: values
 * pushed while a control moves are kept (the latest per key) and `send` is called ONCE with them
 * when the control is released (`flush`), or when it has not moved for `pauseMs`.
 */
export class KeyedCoalescer<V> {
  private pending = new Map<string, V>();
  private timer: unknown = null;
  private readonly send: (edits: Map<string, V>) => void;
  private readonly sched: Scheduler;
  readonly pauseMs: number;
  constructor(send: (edits: Map<string, V>) => void, sched: Scheduler, pauseMs = 700) {
    this.send = send;
    this.sched = sched;
    this.pauseMs = pauseMs;
  }
  get active(): boolean {
    return this.pending.size > 0;
  }
  push(key: string, value: V): void {
    this.pending.set(key, value);
    if (this.timer !== null) this.sched.clear(this.timer);
    this.timer = this.sched.set(() => { this.timer = null; this.flush(); }, this.pauseMs);
  }
  flush(): void {
    if (this.timer !== null) { this.sched.clear(this.timer); this.timer = null; }
    if (!this.pending.size) return;
    const edits = this.pending;
    this.pending = new Map();
    this.send(edits);
  }
  value(key: string): V | undefined {
    return this.pending.get(key);
  }
  cancel(): void {
    if (this.timer !== null) { this.sched.clear(this.timer); this.timer = null; }
    this.pending = new Map();
  }
}
