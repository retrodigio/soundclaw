// What reading an instrument file (SFZ, SoundFont 2) produces: zones in the document's own terms, the instrument's
// note envelope, and a report of everything the format has that the zones cannot say. The readers are pure: the
// caller reads the files and stores the audio; the command text is made from the plan here.
//
// Nothing here renders. Importing may use platform maths (timecents to seconds) because its results are written to the
// tape as plain numbers.

import { MAX_ZONES, newZone, zoneWords, type Zone } from './zones.ts';
import { noteLabel } from './music.ts';

/** A thing the format has that the zones cannot carry whole. */
export interface ImportLoss {
  /** `lost`: not carried at all. `approximated`: carried in a simpler form. */
  kind: 'lost' | 'approximated';
  /** The opcode or generator (or a short phrase). */
  what: string;
  /** The region or zone numbers it was found in (1-based, in file order; empty: the instrument as a whole). */
  where: number[];
  detail?: string;
}

/** Collects losses, merging equal ones across regions. */
export class LossReport {
  private readonly byKey = new Map<string, ImportLoss>();

  add(kind: ImportLoss['kind'], what: string, where: number | null, detail?: string): void {
    const key = `${kind}|${what}|${detail ?? ''}`;
    const have = this.byKey.get(key);
    if (have) { if (where !== null && !have.where.includes(where)) have.where.push(where); return; }
    this.byKey.set(key, { kind, what, where: where === null ? [] : [where], ...(detail ? { detail } : {}) });
  }

  list(): ImportLoss[] {
    return [...this.byKey.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'lost' ? -1 : 1));
  }
}

/** `1-4, 7, 9-10` for region numbers. */
export function rangesText(ns: readonly number[]): string {
  const s = [...new Set(ns)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++;
    out.push(j > i ? `${s[i]}-${s[j]}` : String(s[i]));
    i = j + 1;
  }
  return out.join(', ');
}

/** The report in words, one line per loss, naming the regions (or zones) it was found in. */
export function lossLines(losses: readonly ImportLoss[], noun: 'region' | 'zone'): string[] {
  return losses.map((l) => {
    const where = l.where.length ? ` (${noun}${l.where.length === 1 ? '' : 's'} ${rangesText(l.where)})` : '';
    return `${l.kind}: ${l.what}${where}${l.detail ? `: ${l.detail}` : ''}`;
  });
}

/** One sample an instrument file plays. */
export interface PlanSample {
  /** The key the plan's zones name it by (a path inside the SFZ's folder; `sample <n>` in a SoundFont). */
  key: string;
  /** A name to build the project's sample name from. */
  label: string;
}

/** A zone and the region (or SoundFont zone) it came from. */
export interface PlanZone {
  zone: Zone;
  /** The 1-based region or zone number in the file, for messages. */
  ref: number;
}

export interface InstrumentPlan {
  source: 'sfz' | 'sf2';
  zones: PlanZone[];
  /** attack, decay, sustain (0-1), release, seconds; null: leave the instrument's own. */
  adsr: [number, number, number, number] | null;
  /** The instrument's velocity sensitivity, 0-1; null: leave it. */
  velocity: number | null;
  pitched: boolean;
  rr: 'cycle' | 'hash' | null;
  losses: ImportLoss[];
  /** Other things worth saying (skipped regions, defaults taken). */
  notes: string[];
}

/** An error in a file, naming the region or zone and what is wrong. */
export class InstrumentImportError extends Error {}

const r4 = (n: number): number => Math.round(n * 1e4) / 1e4;
export const roundTime = (n: number): number => Math.round(n * 1e6) / 1e6;
export { r4 };

/** The commands that make the instrument: `instrument new`, its settings and one `instrument zone add` per zone. `nameOf` maps a plan sample key to the project's sample name. */
export function planCommands(plan: InstrumentPlan, id: string, nameOf: (key: string) => string): string[] {
  const cmds = [`instrument new ${id} kind=zones`];
  const set: string[] = [];
  if (plan.adsr) set.push(`adsr=${plan.adsr.map((x) => String(r4(x))).join(',')}`);
  if (plan.velocity !== null) set.push(`velocity=${r4(plan.velocity)}`);
  if (!plan.pitched) set.push('pitched=no');
  if (plan.rr) set.push(`rr=${plan.rr}`);
  if (set.length) cmds.push(`instrument set ${id} ${set.join(' ')}`);
  for (const { zone } of plan.zones) cmds.push(`instrument zone add ${id} ${zoneWords({ ...zone, sample: nameOf(zone.sample) }, noteLabel).join(' ')}`);
  return cmds;
}

/** Guard for the number of zones an instrument may hold. */
export function checkZoneCount(n: number, what: string): void {
  if (n > MAX_ZONES) throw new InstrumentImportError(`${what} makes ${n} zones; an instrument holds at most ${MAX_ZONES}${what.startsWith('preset') ? ' (import another preset)' : ' (import a part of it: an SFZ with fewer regions)'}`);
}

/** A zone with these values, each clamped to what a zone allows; the clamped ones are named through `note`. */
export function clampedZone(sample: string, root: number, v: Partial<Zone>, note: (what: string, detail: string) => void): Zone {
  const z = newZone(sample, Math.max(0, Math.min(127, Math.round(root))));
  const clamp = (name: string, x: number, lo: number, hi: number): number => {
    if (x < lo || x > hi) { note(name, `${r4(x)} is outside ${lo} to ${hi}; ${r4(Math.max(lo, Math.min(hi, x)))} is used`); return Math.max(lo, Math.min(hi, x)); }
    return x;
  };
  if (v.keys) z.keys = [Math.max(0, Math.min(127, v.keys[0])), Math.max(0, Math.min(127, v.keys[1]))];
  if (v.vel) z.vel = [Math.max(1, Math.min(127, v.vel[0])), Math.max(1, Math.min(127, v.vel[1]))];
  if (v.tune !== undefined) z.tune = roundTime(clamp('tune', v.tune, -1200, 1200));
  if (v.gain !== undefined) z.gain = r4(clamp('volume', v.gain, -60, 24));
  if (v.pan !== undefined) z.pan = r4(clamp('pan', v.pan, -1, 1));
  if (v.start !== undefined) z.start = roundTime(clamp('offset', v.start, 0, 120));
  if (v.end !== undefined) z.end = roundTime(clamp('end', v.end, 0, 120));
  if (v.loop !== undefined) z.loop = v.loop;
  if (v.loopmode !== undefined) z.loopmode = v.loopmode;
  if (v.xfade !== undefined) z.xfade = roundTime(clamp('loop crossfade', v.xfade, 0, 2));
  if (v.trigger !== undefined) z.trigger = v.trigger;
  if (v.rr !== undefined) z.rr = v.rr;
  if (v.choke !== undefined) z.choke = v.choke;
  if (v.releaseDecay !== undefined) z.releaseDecay = r4(clamp('release decay', v.releaseDecay, 0, 120));
  return z;
}

/** The most common value (ties: the first met) and whether all agreed. */
export function modeOf<T>(values: readonly T[]): { value: T | undefined; unanimous: boolean } {
  const counts = new Map<string, { v: T; n: number }>();
  for (const v of values) {
    const k = String(v);
    const c = counts.get(k);
    if (c) c.n++; else counts.set(k, { v, n: 1 });
  }
  let best: { v: T; n: number } | undefined;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return { value: best?.v, unanimous: counts.size <= 1 };
}

/** Union-find over small integers. */
export class Groups {
  private readonly parent = new Map<number, number>();
  find(x: number): number {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    let c = x;
    while (this.parent.get(c) !== r) { const n = this.parent.get(c)!; this.parent.set(c, r); c = n; }
    return r;
  }
  union(a: number, b: number): void { this.parent.set(this.find(a), this.find(b)); }
}
