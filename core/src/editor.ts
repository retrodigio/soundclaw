// What the sound editor needs that is not drawing: how the parameters are grouped (as sfxr groups
// them), the commands a person's edits are written as (the very text an agent would write), the
// rule that turns a drag into one command, and the tags a person can put on a sound. Pure, so the
// page and the tests use the same code.

import { CLASSIC_FIELDS, WAVE_NAMES, classicField, formatCsv, formatPatch, formatPatchNamed, type ClassicKey, type ClassicPatch } from './classic.ts';
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
