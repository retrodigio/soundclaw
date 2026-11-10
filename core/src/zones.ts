// Sampled instruments: the zones of an instrument. A zone plays a sample (or a slice of it) for the keys and
// velocities it covers, at `note - root + tune` semitones; loops, release samples, round robins, velocity
// crossfades and choke groups are settings of the zones and the instrument. At a note, the zones that apply are
// made into ordinary sample layers of the note's sound (the same reader, interpolation, envelope and effects as
// any sample layer), so a zone is heard exactly as the layer it stands for would be.
//
// This module renders: only + - * / sqrt and the engine's own functions (exp2, sineCycles); no platform maths.

import { exp2, sineCycles } from './mathx.ts';
import { resample } from './resample.ts';
import { hashText } from './generators.ts';
import { newLayer, type Env, type Layer } from './layered.ts';
import { SAMPLE_RATE } from './sound.ts';
import type { SampleBank, SampleData } from './synth.ts';

const SR = SAMPLE_RATE;

export const ZONE_LOOP_MODES = ['none', 'sustain', 'continuous', 'oneshot'] as const;
export type ZoneLoopMode = (typeof ZONE_LOOP_MODES)[number];
export const ZONE_TRIGGERS = ['attack', 'release'] as const;
export type ZoneTrigger = (typeof ZONE_TRIGGERS)[number];
export const ZONE_INTERPS = ['linear', 'cubic', 'sinc'] as const;
export const MAX_ZONES = 512;
/** The most a zone's `choke` group may be. */
export const MAX_CHOKE = 99;
/** A choked note fades out over this long, seconds. */
export const CHOKE_FADE = 0.005;
export const HIT_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export interface Zone {
  /** The sample (a name in the project) this zone plays. */
  sample: string;
  /** Play only slice n of the sample (0: the whole sample). */
  slice: number;
  /** The MIDI note at which the sample, with `tune`, sounds as it was recorded. */
  root: number;
  /** Cents added to the playback pitch (a sample recorded 12 cents sharp has tune 12 ... with root at its own note). */
  tune: number;
  keys: [number, number];
  vel: [number, number];
  /** dB. */
  gain: number;
  pan: number;
  /** Where in what plays (the slice or the sample) to start and stop, seconds; end 0 is the end. */
  start: number;
  end: number;
  /** Loop points: seconds from the start of what plays; `sample` (the default) for the sample's own loop points, if it has any; null for none. */
  loop: [number, number] | 'sample' | null;
  loopmode: ZoneLoopMode;
  /** Loop crossfade, seconds. */
  xfade: number;
  trigger: ZoneTrigger;
  /** Round robin: this is take i of n. */
  rr: [number, number] | null;
  /** Choke group (0: none): a note of the group stops the earlier sounding notes of the group on its channel. */
  choke: number;
  /** A drum hit this zone is for (a kit); null for a zone played by key. */
  hit: string | null;
  /** Release zones: dB lower for each second the note was held. */
  releaseDecay: number;
  interp: 'linear' | 'cubic' | 'sinc';
}

export function newZone(sample: string, root: number): Zone {
  return { sample, slice: 0, root, tune: 0, keys: [0, 127], vel: [1, 127], gain: 0, pan: 0, start: 0, end: 0, loop: 'sample', loopmode: 'sustain', xfade: 0.01, trigger: 'attack', rr: null, choke: 0, hit: null, releaseDecay: 0, interp: 'sinc' };
}

export const cloneZone = (z: Zone): Zone => ({ ...z, keys: [...z.keys], vel: [...z.vel], loop: Array.isArray(z.loop) ? ([...z.loop] as [number, number]) : z.loop, rr: z.rr ? [...z.rr] : null });

// ---- the text form ---------------------------------------------------------------------------------------------

const r6 = (n: number): string => String(Math.round(n * 1e6) / 1e6 || 0);

/** The zone's keys, in the order they are written; defaults are left out except sample, root and keys. */
export function zoneWords(z: Zone, noteName: (m: number) => string): string[] {
  const w = [`sample=${z.sample}`];
  if (z.slice) w.push(`slice=${z.slice}`);
  w.push(`root=${noteName(z.root)}`);
  if (z.tune) w.push(`tune=${r6(z.tune)}`);
  w.push(`keys=${noteName(z.keys[0])}-${noteName(z.keys[1])}`);
  if (z.vel[0] !== 1 || z.vel[1] !== 127) w.push(`vel=${z.vel[0]}-${z.vel[1]}`);
  if (z.gain) w.push(`gain=${r6(z.gain)}`);
  if (z.pan) w.push(`pan=${r6(z.pan)}`);
  if (z.start) w.push(`start=${r6(z.start)}`);
  if (z.end) w.push(`end=${r6(z.end)}`);
  if (z.loop !== 'sample') w.push(`loop=${z.loop === null ? 'none' : `${r6(z.loop[0])}-${r6(z.loop[1])}`}`);
  if (z.loopmode !== 'sustain') w.push(`loopmode=${z.loopmode}`);
  if (z.xfade !== 0.01) w.push(`xfade=${r6(z.xfade)}`);
  if (z.trigger !== 'attack') w.push(`trigger=${z.trigger}`);
  if (z.rr) w.push(`rr=${z.rr[0]}/${z.rr[1]}`);
  if (z.choke) w.push(`choke=${z.choke}`);
  if (z.hit) w.push(`hit=${z.hit}`);
  if (z.releaseDecay) w.push(`release-decay=${r6(z.releaseDecay)}`);
  if (z.interp !== 'sinc') w.push(`interp=${z.interp}`);
  return w;
}

/** The keys a zone takes, for the docs table and the parser's messages. */
export const ZONE_KEYS = ['sample', 'slice', 'root', 'tune', 'keys', 'vel', 'gain', 'pan', 'start', 'end', 'loop', 'loopmode', 'xfade', 'trigger', 'rr', 'choke', 'hit', 'release-decay', 'interp'] as const;

const numRe = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const num = (v: string, key: string, min: number, max: number, unit = '', whole = false): number => {
  if (!numRe.test(v)) throw new Error(`${key} must be a number from ${min} to ${max}${unit ? ' ' + unit : ''} (got '${v}')`);
  const n = Number(v);
  if (n < min || n > max) throw new Error(`${key} must be a number from ${min} to ${max}${unit ? ' ' + unit : ''} (got '${v}')`);
  if (whole && !Number.isInteger(n)) throw new Error(`${key} must be a whole number (got '${v}')`);
  return n;
};

/** One `key=value` of a zone applied to it. `note` reads a note name or a number; `range` reads `C3-C6`. Throws a plain Error. */
export function setZoneValue(z: Zone, key: string, v: string, note: (s: string) => number | null, range: (s: string) => [number, number] | null): void {
  switch (key) {
    case 'sample':
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(v)) throw new Error(`'${v}' is not a sample name (letters, digits, _ and -)`);
      z.sample = v;
      return;
    case 'slice': z.slice = num(v, key, 0, 1024, '', true); return;
    case 'root': { const n = note(v); if (n === null) throw new Error(`root is a note like C4 or A3 (got '${v}')`); z.root = n; return; }
    case 'tune': z.tune = num(v, key, -1200, 1200, 'cents'); return;
    case 'keys': { const r = range(v); if (!r) throw new Error(`keys is two notes like C3-C6, or one note (got '${v}')`); z.keys = r; return; }
    case 'vel': {
      const m = /^(\d+)(?:-(\d+))?$/.exec(v);
      const lo = m ? Number(m[1]) : NaN;
      const hi = m ? (m[2] === undefined ? lo : Number(m[2])) : NaN;
      if (!m || lo < 1 || hi > 127 || lo > hi) throw new Error(`vel is a range of velocities like 1-63 (1 to 127, low first; got '${v}')`);
      z.vel = [lo, hi];
      return;
    }
    case 'gain': z.gain = num(v, key, -60, 24, 'dB'); return;
    case 'pan': z.pan = num(v, key, -1, 1); return;
    case 'start': z.start = num(v, key, 0, 120, 's'); return;
    case 'end': z.end = num(v, key, 0, 120, 's'); return;
    case 'loop': {
      if (v === 'none') { z.loop = null; return; }
      if (v === 'sample') { z.loop = 'sample'; return; }
      const m = /^(\d*\.?\d+)-(\d*\.?\d+)$/.exec(v);
      if (!m || Number(m[2]) <= Number(m[1]) || Number(m[2]) > 120) throw new Error(`loop is <start>-<end> in seconds from the start of what plays, sample (the sample's own loop points) or none (got '${v}')`);
      z.loop = [Number(m[1]), Number(m[2])];
      return;
    }
    case 'loopmode':
      if (!(ZONE_LOOP_MODES as readonly string[]).includes(v)) throw new Error(`loopmode is one of ${ZONE_LOOP_MODES.join(', ')} (got '${v}')`);
      z.loopmode = v as ZoneLoopMode;
      return;
    case 'xfade': z.xfade = num(v, key, 0, 2, 's'); return;
    case 'trigger':
      if (!(ZONE_TRIGGERS as readonly string[]).includes(v)) throw new Error(`trigger is attack or release (got '${v}')`);
      z.trigger = v as ZoneTrigger;
      return;
    case 'rr': {
      if (v === 'none') { z.rr = null; return; }
      const m = /^(\d+)\/(\d+)$/.exec(v);
      if (!m || Number(m[1]) < 1 || Number(m[2]) < 2 || Number(m[2]) > 16 || Number(m[1]) > Number(m[2])) throw new Error(`rr is take/takes like 2/3 (2 to 16 takes; got '${v}')`);
      z.rr = [Number(m[1]), Number(m[2])];
      return;
    }
    case 'choke': z.choke = num(v, key, 0, MAX_CHOKE, '', true); return;
    case 'hit':
      if (v === 'none') { z.hit = null; return; }
      if (!HIT_RE.test(v)) throw new Error(`hit is a drum hit name (letters, digits, _ and -; got '${v}')`);
      z.hit = v;
      return;
    case 'release-decay': z.releaseDecay = num(v, key, 0, 120, 'dB per second'); return;
    case 'interp':
      if (!(ZONE_INTERPS as readonly string[]).includes(v)) throw new Error(`interp is one of ${ZONE_INTERPS.join(', ')} (got '${v}')`);
      z.interp = v as Zone['interp'];
      return;
    default: throw new Error(`no zone setting '${key}' (${ZONE_KEYS.join(', ')})`);
  }
}

/** What a zone adds to an instrument's render key: everything that changes its samples, with the sample's identity from `sampleHash`. */
export function zonesKey(zones: readonly Zone[], sampleHash: (name: string) => string): string {
  return zones.map((z) => `${sampleHash(z.sample)}/${z.slice}/${z.root}/${z.tune}/${z.keys.join('-')}/${z.vel.join('-')}/${z.gain}/${z.pan}/${z.start}/${z.end}/${Array.isArray(z.loop) ? z.loop.join('-') : z.loop ?? '-'}/${z.loopmode}/${z.xfade}/${z.trigger}/${z.rr ? z.rr.join('/') : '-'}/${z.choke}/${z.hit ?? '-'}/${z.releaseDecay}/${z.interp}`).join(';');
}

// ---- which zones a note plays --------------------------------------------------------------------------------

/** What a note tells the zones: its velocity, its drum hit, and where it stands in its round robin. */
export interface ZoneNote {
  midi: number;
  vel?: number;
  hit?: string | null;
  /** The round-robin counter (`cycle`) or hash (`hash`) of this note; zone group g plays take `rr % takes`. */
  rr?: number;
}

export interface Chosen {
  index: number;
  zone: Zone;
  /** 1, or less inside a velocity crossfade. */
  weight: number;
}

/** The part of a zone's gain a velocity crossfade of this width (velocity steps) leaves at `vel`: equal power across a boundary shared with a neighbour. */
export function velocityWeight(z: Pick<Zone, 'vel'>, vel: number, width: number): number {
  if (width <= 0) return vel >= z.vel[0] && vel <= z.vel[1] ? 1 : 0;
  const half = width / 2;
  let w = 1;
  if (z.vel[0] > 1) {
    const edge = z.vel[0] - 0.5;
    if (vel < edge - half) return 0;
    if (vel < edge + half) w *= sineCycles(((vel - (edge - half)) / width) / 4);
  } else if (vel < 1) return 0;
  if (z.vel[1] < 127) {
    const edge = z.vel[1] + 0.5;
    if (vel > edge + half) return 0;
    if (vel > edge - half) w *= sineCycles(((vel - (edge - half)) / width) / 4 + 0.25);
  } else if (vel > 127) return 0;
  return w;
}

const sigOf = (z: Zone): string => `${z.keys.join('-')}|${z.vel.join('-')}|${z.hit ?? ''}|${z.trigger}`;

/** The zones that candidate a note before round robins decide among takes: by key (or hit), velocity and trigger. */
export function zoneCandidates(zones: readonly Zone[], n: ZoneNote, velxfade: number): Chosen[] {
  const out: Chosen[] = [];
  const vel = n.vel ?? 100;
  zones.forEach((z, index) => {
    if (n.hit != null ? z.hit !== n.hit : z.hit !== null || n.midi < z.keys[0] || n.midi > z.keys[1]) return;
    const weight = velocityWeight(z, vel, velxfade);
    if (weight > 0) out.push({ index, zone: z, weight });
  });
  return out;
}

/** The round-robin group of a note (a text, empty when no candidate has takes): notes of one group take turns. */
export function rrGroupOf(zones: readonly Zone[], n: ZoneNote, velxfade: number): string {
  return zoneCandidates(zones, n, velxfade).filter((c) => c.zone.rr).map((c) => c.index).join(',');
}

/** The zones a note plays: the candidates, with one take chosen of each round-robin set. */
export function chooseZones(zones: readonly Zone[], n: ZoneNote, velxfade: number): Chosen[] {
  const cand = zoneCandidates(zones, n, velxfade);
  const sets = new Map<string, Chosen[]>();
  const out: Chosen[] = [];
  for (const c of cand) {
    if (!c.zone.rr) { out.push(c); continue; }
    const k = sigOf(c.zone);
    sets.set(k, [...(sets.get(k) ?? []), c]);
  }
  for (const set of sets.values()) {
    set.sort((a, b) => a.zone.rr![0] - b.zone.rr![0] || a.index - b.index);
    out.push(set[(n.rr ?? 0) % set.length]!);
  }
  return out.sort((a, b) => a.index - b.index);
}

/** A key for the notes that sound the same: the zones chosen and their weights. */
export function chosenKey(c: readonly Chosen[]): string {
  return c.map((x) => `${x.index}${x.weight === 1 ? '' : ':' + x.weight}`).join(',');
}

/** The round-robin value a note takes under `hash`: from the channel, the note's grid time (samples) and its pitch or hit. */
export function rrHash(channel: string, gridSample: number, midi: number, hit: string | null): number {
  return hashText(`${channel}|${gridSample}|${hit ?? midi}`);
}

// ---- the sound of a zone ---------------------------------------------------------------------------------------

const cap = 120 * SR;
const resampled = new WeakMap<SampleData, { mix: Float32Array; left?: Float32Array; right?: Float32Array }>();

function atEngineRate(s: SampleData): { mix: Float32Array; left?: Float32Array; right?: Float32Array } {
  let r = resampled.get(s);
  if (!r) {
    r = { mix: resample(s.data, s.rate, SR), ...(s.left && s.right ? { left: resample(s.left, s.rate, SR), right: resample(s.right, s.rate, SR) } : {}) };
    resampled.set(s, r);
  }
  return r;
}

/** Where in the sample, in engine frames, a zone plays from and to (slice, start and end applied). */
export function zoneWindow(z: Zone, s: SampleData): { a: number; b: number; total: number } {
  const total = atEngineRate(s).mix.length;
  const scale = (f: number): number => Math.round((f * SR) / s.rate);
  let a = 0;
  let b = total;
  if (z.slice > 0) {
    const pts = s.slices ?? [];
    if (z.slice > pts.length) return { a: 0, b: 0, total };
    a = Math.min(b, scale(pts[z.slice - 1]!));
    b = z.slice < pts.length ? Math.min(b, scale(pts[z.slice]!)) : b;
  }
  const i0 = Math.min(b, a + Math.floor(z.start * SR));
  const i1 = z.end > 0 ? Math.min(b, a + Math.floor(z.end * SR)) : b;
  return { a: i0, b: Math.max(i0, i1), total };
}

/** The seconds a zone plays at its natural speed (the length of what it plays), for sizing a note. */
export function zoneSeconds(z: Zone, s: SampleData): number {
  const w = zoneWindow(z, s);
  return (w.b - w.a) / SR;
}

/** Loop points in frames of the window, or null when the zone has no usable loop. */
function loopOf(z: Zone, s: SampleData, w: { a: number; b: number }): [number, number] | null {
  if (z.loopmode === 'none' || z.loopmode === 'oneshot' || z.loop === null) return null;
  let S: number, E: number;
  if (z.loop === 'sample') {
    if (!s.loop || s.loop[1] <= s.loop[0]) return null;
    const scale = (f: number): number => Math.round((f * SR) / s.rate);
    S = scale(s.loop[0]) - w.a;
    E = scale(s.loop[1]) - w.a;
  } else {
    S = Math.round(z.loop[0] * SR);
    E = Math.round(z.loop[1] * SR);
  }
  const len = w.b - w.a;
  if (S < 0 || E > len || E - S < 16) return null;
  return [S, E];
}

/**
 * The window played round its loop. The part before the loop, then passes through the loop until `need` frames are covered; each seam
 * fades the last `xf` frames of the loop out as its first `xf` frames fade in (equal power). With `tail`, the last pass runs on past
 * the loop's end to the end of the window; without, it stops at the loop's end.
 */
function loopRun(x: Float32Array, S: number, E: number, xf: number, need: number, tail: boolean): Float32Array {
  const n = E - S;
  const head = S + xf;
  const m = n - xf;
  const passes = need > head ? Math.ceil((need - head) / m) : 0;
  const plainEnd = tail ? x.length : E;
  const length = Math.min(cap, head + passes * m + Math.max(0, plainEnd - head));
  const out = new Float32Array(length);
  let o = 0;
  const put = (v: number): void => { if (o < length) out[o++] = v; };
  for (let i = 0; i < head; i++) put(x[i]!);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < m - xf; i++) put(x[S + xf + i]!);
    for (let j = 0; j < xf; j++) {
      const t = (j + 0.5) / xf;
      put(x[E - xf + j]! * Math.sqrt(1 - t) + x[S + j]! * Math.sqrt(t));
    }
  }
  for (let i = head; i < plainEnd; i++) put(x[i]!);
  return out;
}

export interface ZoneMake {
  /** The sample layers, in zone order, with the extra samples (looped windows) they play. */
  layers: { layer: Layer; zone: Zone; weight: number; index: number }[];
  extra: Map<string, SampleData>;
}

/** The seconds a note needs for what its zones play on their own (a one-shot's whole length, a release sample after the key is let go). */
export function zonesLength(zones: readonly Chosen[], bank: SampleBank | undefined, semis: (z: Zone) => number, gate: number): number {
  let end = 0;
  for (const c of zones) {
    const s = bank?.get(c.zone.sample);
    if (!s) continue;
    const secs = zoneSeconds(c.zone, s) / exp2(semis(c.zone) / 12);
    if (c.zone.trigger === 'release') end = Math.max(end, gate + secs);
    else if (c.zone.loopmode === 'oneshot') end = Math.max(end, secs);
  }
  return end;
}

/** A rise to full level and, when the sample is long enough to have an end, a 3 ms fall at the end of what plays. */
function shotEnv(attack: number, secs: number): Env {
  const e: Env = [{ t: 0, v: 0, curve: 'lin' }, { t: attack, v: 1, curve: 'lin' }];
  if (secs > attack + 0.004) { e.push({ t: secs - 0.003, v: 1, curve: 'lin' }); e.push({ t: secs, v: 0, curve: 'lin' }); }
  return e;
}

const DB_LOG2 = 0.1660964047443681;
/** dB as a linear factor, built from exp2 so every machine gets the same number. */
export const dbGain = (db: number): number => exp2(db * DB_LOG2);

/**
 * The sample layers one note's chosen zones make. `semis(z)` is the zone's playback pitch (semitones, before the instrument's pitch effects),
 * `rate` the largest speed the note's pitch effects reach over the zone's pitch (so a loop is long enough), `gate` and `total` the key's hold
 * and the note's length, seconds, and `env` the note envelope.
 */
export function makeZoneLayers(chosen: readonly Chosen[], bank: SampleBank | undefined, o: { semis: (z: Zone) => number; speed: (z: Zone) => number; gate: number; total: number; env: Env; attack: number }): ZoneMake {
  const extra = new Map<string, SampleData>();
  const layers: ZoneMake['layers'] = [];
  for (const c of chosen) {
    const z = c.zone;
    const s = bank?.get(z.sample);
    if (!s) continue;
    const l = newLayer('sample', 1000 + c.index);
    l.p.interp = z.interp;
    l.p.pan = z.pan;
    const stereo = !!(s.left && s.right);
    l.p.side = stereo ? 'stereo' : 'mix';
    let gain = dbGain(z.gain) * c.weight;
    const w = zoneWindow(z, s);
    const lp = loopOf(z, s, w);
    if (lp) {
      const e = atEngineRate(s);
      const cut = (x: Float32Array): Float32Array => x.slice(w.a, w.b);
      const speed = o.speed(z);
      const need = Math.ceil((z.loopmode === 'continuous' ? o.total : o.gate) * SR * speed);
      const n = lp[1] - lp[0];
      const xf = Math.max(0, Math.min(Math.round(z.xfade * SR), Math.floor(n / 2)));
      const build = (x: Float32Array): Float32Array => loopRun(cut(x), lp[0], lp[1], xf, need, z.loopmode === 'sustain');
      const data: SampleData = { rate: SR, data: build(e.mix), ...(e.left && e.right ? { left: build(e.left), right: build(e.right) } : {}) };
      const name = `\u0001zone${c.index}`;
      extra.set(name, data);
      l.p.sample = name;
    } else {
      l.p.sample = z.sample;
      l.p.slice = z.slice;
      l.p.start = z.start;
      l.p.end = z.end;
    }
    if (z.trigger === 'release') {
      l.p.offset = Math.min(120, o.gate);
      gain *= dbGain(-z.releaseDecay * o.gate);
      l.amp = shotEnv(0.002, (w.b - w.a) / SR / exp2(o.semis(z) / 12));
    } else if (z.loopmode === 'oneshot') l.amp = shotEnv(Math.max(0.001, o.attack), (w.b - w.a) / SR / exp2(o.semis(z) / 12));
    else l.amp = o.env.map((p) => ({ ...p }));
    l.p.gain = gain;
    layers.push({ layer: l, zone: z, weight: c.weight, index: c.index });
  }
  return { layers, extra };
}

/** A bank that also knows the extra samples a note's zones made. */
export function withExtra(bank: SampleBank | undefined, extra: Map<string, SampleData>): SampleBank | undefined {
  if (!extra.size) return bank;
  return { get: (n) => extra.get(n) ?? bank?.get(n), hash: (n) => (extra.has(n) ? 'zone' : bank?.hash(n)) };
}
