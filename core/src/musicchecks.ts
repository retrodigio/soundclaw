// Checks and measurements for songs. They read the written song (key, range), the rendered channels
// (render-match, masking) or the mix (clip, loudness, dc, loop-music). Rendering is deterministic;
// these measure, so they may use platform maths.
//
//   key           written notes outside the song's scale (unless marked with !)
//   range         written notes outside an instrument's declared range
//   render-match  each written note against the channel rendered alone: onset within 20 ms, the right pitch
//   loop-music    the loop's seam: a click, or a step in level
//   masking       two channels with most of their energy in the same band at the same time (advisory)
//   voice-leading parallel fifths and octaves between the voices of the harmony parts (advisory)
//   style         the project's music style guide and the song's music bible entry
//   layers        each game layer alone and the base with each mix of the others: in key, loudness, seams
//   clip, loudness, dc   the mix

import { SAMPLE_RATE } from './sound.ts';
import { integratedLoudness, stft, truePeak, yinPitch, type PitchFrame } from './analysis.ts';
import { SEAM_STEP_FACTOR, classTable, seamNumbers, type CheckRange, type Style } from './checks.ts';
import { builtinInstruments, pitchCheckOf, type Instrument } from './instrument.ts';
import { inKey, midiFreq, noteLabel, parseKey, pitchClassName } from './music.ts';
import { arrange, channelNotes, layerOrder, type Channel, type NoteEv, type SongDoc } from './song.ts';
import { parallelPairs } from './theory.ts';
import { styleCheck, type MusicGuide } from './musicstyle.ts';
import type { ChannelAudio, SongRender } from './songrender.ts';

export type MusicCheckName = 'key' | 'range' | 'render-match' | 'loop-music' | 'masking' | 'clip' | 'loudness' | 'dc' | 'voice-leading' | 'style' | 'layers';
export const MUSIC_CHECK_NAMES: readonly MusicCheckName[] = ['clip', 'loudness', 'dc', 'key', 'range', 'render-match', 'loop-music', 'masking', 'voice-leading', 'style', 'layers'];

export interface MusicRange extends CheckRange {
  channel?: string;
}

export interface MusicCheck {
  name: MusicCheckName;
  pass: boolean;
  /** Advisory checks (masking) never block `work done`. */
  advisory: boolean;
  /** Not applicable to this song (no key set, no loop region). */
  skipped: boolean;
  score: number;
  value: string;
  threshold: string;
  ranges: MusicRange[];
}

const SR = SAMPLE_RATE;
const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : v > 0 ? 'inf' : '-inf');
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const MATCH_TIMING_MS = 20;
export const MATCH_PITCH_SEMITONES = 0.6;
/** A note whose level is this far under the channel's loudest counts as not heard. */
export const NOT_HEARD_DB = 40;
export const MASK_MIN_SECONDS = 0.5;
export const MASK_MAX_FRACTION = 0.25;
/** Two channels are close in a band when the second is within this many dB of the first. */
export const MASK_CLOSE_DB = 4;

/**
 * Where the measurements of a song are kept between checks (and, for the server, between processes): the numbers of one
 * channel, of the mix, of the layers, each under a key that holds everything they depend on. The values are plain data.
 */
export interface Memo {
  get(key: string): unknown;
  put(key: string, value: unknown): void;
}

/** Bump when a measurement changes: the kept ones are then ignored. */
export const ANALYSIS_VERSION = 3;

function memoized<T>(memo: Memo | undefined, key: string, make: () => T): T {
  if (!memo) return make();
  const hit = memo.get(key) as T | undefined;
  if (hit !== undefined) return hit;
  const v = make();
  memo.put(key, v);
  return v;
}

type InstLookup = (id: string) => Instrument | undefined;
export const withBuiltins = (own: InstLookup): InstLookup => (id) => own(id) ?? builtinInstruments()[id];

// ---- loudness ---------------------------------------------------------------------------------------------------

export interface SongLoudnessRule {
  class: string;
  target: number;
  tolerance: number;
  basis: string;
}

/** What the mix's loudness is held to: the song's own `loudness`, else its class (default `music`). */
export function songLoudnessRule(song: SongDoc, style: Style): SongLoudnessRule {
  const table = classTable(style);
  const cls = song.loudClass ?? 'music';
  const c = table[cls] ?? table.music ?? table.standard!;
  if (song.loudness !== undefined) return { class: cls, target: song.loudness, tolerance: c.tolerance, basis: `own loudness ${song.loudness} LUFS` };
  return { class: cls, target: c.target, tolerance: c.tolerance, basis: `class ${cls}` };
}

// ---- key and range (the written notes) -----------------------------------------------------------------------------

function describeAt(e: NoteEv): string {
  return `${e.at.section}/${e.at.pattern} step ${e.at.step}`;
}

export function keyCheck(song: SongDoc, arr: { instances: import('./song.ts').Instance[] }): MusicCheck {
  const base = { name: 'key' as const, advisory: false };
  if (!song.key) return { ...base, pass: true, skipped: true, score: 1, value: 'the song has no key set', threshold: 'song set <id> key=C:major to check the notes against a scale', ranges: [] };
  const key = parseKey(song.key);
  const ranges: MusicRange[] = [];
  let total = 0;
  const seen = new Set<string>();
  for (const ch of song.channels) {
    if (!ch.inst) continue;
    for (const e of channelNotes(song, arr, ch.name)) {
      if (e.midi === null) continue;
      total++;
      if (inKey(key, e.midi) || e.accidental) continue;
      ranges.push({ from: r4(e.t), to: r4(e.t + e.len), channel: ch.name, note: `${noteLabel(e.midi)} in ${ch.name} (${describeAt(e)}) is not in ${song.key}; mark it ${noteLabel(e.midi)}! if it is meant` });
      seen.add(pitchClassName(e.midi));
    }
  }
  const pass = ranges.length === 0;
  return {
    ...base, pass, skipped: false, score: total ? clamp01(1 - ranges.length / total * 4) : 1,
    value: pass ? `all ${total} notes are in ${song.key}` : `${ranges.length} of ${total} notes are outside ${song.key} (${[...seen].join(', ')})`,
    threshold: `every written note in ${song.key} (scale: ${key.classes.map((c) => pitchClassName(c)).join(' ')}), or marked !`, ranges: ranges.slice(0, 40),
  };
}

export function rangeCheck(song: SongDoc, arr: { instances: import('./song.ts').Instance[] }, lookup: InstLookup): MusicCheck {
  const ranges: MusicRange[] = [];
  let total = 0, declared = 0;
  for (const ch of song.channels) {
    if (!ch.inst) continue;
    const inst = lookup(ch.inst);
    if (!inst?.range) continue;
    declared++;
    const [lo, hi] = inst.range;
    for (const e of channelNotes(song, arr, ch.name)) {
      if (e.midi === null) continue;
      total++;
      if (e.midi >= lo && e.midi <= hi) continue;
      ranges.push({ from: r4(e.t), to: r4(e.t + e.len), channel: ch.name, note: `${noteLabel(e.midi)} in ${ch.name} (${describeAt(e)}) is outside ${ch.inst}'s range ${noteLabel(lo)}-${noteLabel(hi)}` });
    }
  }
  const pass = ranges.length === 0;
  return {
    name: 'range', advisory: false, pass, skipped: declared === 0, score: total ? clamp01(1 - ranges.length / total * 4) : 1,
    value: declared === 0 ? 'no instrument declares a range' : pass ? `all ${total} notes are inside their instruments' ranges` : `${ranges.length} of ${total} notes are outside their instrument's range`,
    threshold: 'every note inside the range its instrument declares (instrument set <id> range=C3-C6)', ranges: ranges.slice(0, 40),
  };
}

// ---- voice leading ------------------------------------------------------------------------------------------------

/** Parallel fifths and octaves between the voices of the channels marked harmony=yes, from each onset to the next. Advisory. */
export function voiceLeadingCheck(song: SongDoc, arr: { instances: import('./song.ts').Instance[] }): MusicCheck {
  const base = { name: 'voice-leading' as const, advisory: true };
  const marked = song.channels.filter((c) => c.harmony && c.inst);
  if (!marked.length) return { ...base, pass: true, skipped: true, score: 1, value: 'no channel is marked as a harmony part', threshold: 'song channel set <song> <channel> harmony=yes marks the parts to read', ranges: [] };
  const evs = marked.map((ch) => ({ ch: ch.name, ev: channelNotes(song, arr, ch.name).filter((e) => e.midi !== null) }));
  // on the grid: a note humanise moved a few ms still belongs to its step
  const times = [...new Set(evs.flatMap((x) => x.ev.map((e) => Math.round(e.grid * 1000) / 1000)))].sort((a, b) => a - b);
  // the voices sounding at a time: each channel's notes low to high, named channel#n
  const at = (t: number): Map<string, { midi: number; e: NoteEv }> => {
    const out = new Map<string, { midi: number; e: NoteEv }>();
    for (const x of evs) {
      const on = x.ev.filter((e) => e.grid <= t + 0.0005 && e.grid + e.len > t + 0.0005).sort((a, b) => a.midi! - b.midi!);
      on.forEach((e, i) => out.set(`${x.ch}#${i + 1}`, { midi: e.midi!, e }));
    }
    return out;
  };
  const ranges: MusicRange[] = [];
  const seen = new Set<string>();
  let moves = 0;
  let prev = times.length ? at(times[0]!) : new Map();
  for (let k = 1; k < times.length; k++) {
    const cur = at(times[k]!);
    const ids = [...prev.keys()].filter((id) => cur.has(id));
    if (ids.length >= 2) {
      moves++;
      const a = ids.map((id) => prev.get(id)!.midi), b = ids.map((id) => cur.get(id)!.midi);
      for (const [i, j, kind] of parallelPairs(a, b)) {
        const e = cur.get(ids[j]!)!.e;
        const what = `parallel ${kind}: ${ids[i]} and ${ids[j]} (${noteLabel(a[i]!)}-${noteLabel(a[j]!)} to ${noteLabel(b[i]!)}-${noteLabel(b[j]!)}) at ${e.at.pattern} step ${e.at.step}`;
        if (seen.has(what)) continue;
        seen.add(what);
        ranges.push({ from: r4(times[k - 1]!), to: r4(times[k]! + e.len), channel: ids[j]!.split('#')[0], note: what });
      }
    }
    prev = cur;
  }
  const pass = ranges.length === 0;
  return {
    ...base, pass, skipped: false, score: moves ? clamp01(1 - ranges.length / moves) : 1,
    value: pass ? `no parallel fifths or octaves in ${marked.map((c) => c.name).join(', ')} (${moves} chord changes)` : `${ranges.length} parallel fifth${ranges.length === 1 ? '' : 's'} or octave${ranges.length === 1 ? '' : 's'} in ${marked.map((c) => c.name).join(', ')}`,
    threshold: 'no two voices of the harmony parts moving the same way in fifths or octaves (a warning: the style may want them)', ranges: ranges.slice(0, 40),
  };
}

// ---- game layers -------------------------------------------------------------------------------------------------

export interface LayerMix { layers: string[]; lufs: number; truePeakDb: number; seam: MusicCheck | null }

/** The mixes a game plays: the base alone, and the base with each set of the other layers (in stacking order). */
export function layerCombinations(order: readonly string[]): string[][] {
  const [base, ...rest] = order;
  const out: string[][] = [];
  const n = Math.min(rest.length, 5);
  for (let mask = 0; mask < 1 << n; mask++) out.push([base!, ...rest.slice(0, n).filter((_, i) => mask & (1 << i))]);
  return out.sort((a, b) => a.length - b.length);
}

/**
 * The game layers: each layer alone stays in key and is no louder than the loudness class allows;
 * the base with every mix of the others (the stems summed, as a game plays them) is within the
 * class's loudness, under the true-peak limit, and loops without a click or a step.
 */
export function layersCheck(song: SongDoc, render: SongRender, style: Style, rule: SongLoudnessRule, arr: { instances: import('./song.ts').Instance[] }): { check: MusicCheck; mixes: LayerMix[] } {
  const base = { name: 'layers' as const, advisory: false };
  const order = layerOrder(song);
  if (!song.layers.length || order.length < 2) return { check: { ...base, pass: true, skipped: true, score: 1, value: order.length < 2 ? 'the song has one layer' : `no layer plan (layers ${order.join(', ')})`, threshold: 'layer-plan <song> base=… tension=… combat=… sets the layers and the order they stack in; the check then plays each mix a game can play', ranges: [] }, mixes: [] };
  const stems = new Map(render.stems.map((s) => [s.layer, s.channels] as const));
  const n = render.length;
  const lo = rule.target - rule.tolerance, hi = rule.target + rule.tolerance;
  const ranges: MusicRange[] = [];
  const d = r4(n / SR);
  const key = song.key ? parseKey(song.key) : null;
  const alone: string[] = [];
  for (const l of order) {
    const st = stems.get(l)!;
    const lufs = integratedLoudness([st[0], st[1]]);
    let out = 0;
    if (key) for (const ch of song.channels.filter((c) => c.layer === l && c.inst)) for (const e of channelNotes(song, arr, ch.name)) if (e.midi !== null && !e.accidental && !inKey(key, e.midi)) out++;
    if (out) ranges.push({ from: 0, to: d, note: `layer ${l} alone has ${out} note${out === 1 ? '' : 's'} outside ${song.key}` });
    if (lufs > hi) ranges.push({ from: 0, to: d, note: `layer ${l} alone is ${f1(lufs)} LUFS, louder than the ${rule.class} class allows (${hi})` });
    alone.push(`${l} ${f1(lufs)}`);
  }
  const mixes: LayerMix[] = [];
  for (const combo of layerCombinations(order)) {
    const sum: [Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n)];
    for (const l of combo) { const st = stems.get(l)!; for (let c = 0; c < 2; c++) { const a = st[c]!, o = sum[c]!; for (let i = 0; i < n; i++) o[i] = o[i]! + a[i]!; } }
    const lufs = integratedLoudness(sum);
    const tp = Math.max(...sum.map((c) => 20 * Math.log10(Math.max(1e-9, truePeak(c)))));
    const seam = render.mode === 'loop' ? loopCheck(sum, song.tempo, style) : null;
    mixes.push({ layers: combo, lufs, truePeakDb: tp, seam });
    const name = combo.join('+');
    if (!(lufs >= lo && lufs <= hi)) ranges.push({ from: 0, to: d, note: `${name} is ${f1(lufs)} LUFS, outside ${rule.target} ±${rule.tolerance} (${rule.basis})` });
    if (tp > style.truePeakMax) ranges.push({ from: 0, to: d, note: `${name} peaks at ${f1(tp)} dBTP, over ${style.truePeakMax} (the stems are summed with no limiter)` });
    if (seam && !seam.pass) ranges.push({ from: 0, to: d, note: `${name} at the loop seam: ${seam.ranges.map((r) => r.note).join('; ')}` });
  }
  const pass = ranges.length === 0;
  return {
    check: {
      ...base, pass, skipped: false, score: clamp01(1 - ranges.length / (mixes.length + order.length)),
      value: `${mixes.map((m) => `${m.layers.join('+')} ${f1(m.lufs)}`).join(', ')} LUFS; alone ${alone.join(', ')}; stems ${render.mode === 'loop' ? 'loop' : 'run'} ${r4(n / SR)} s each${render.mode === 'loop' ? `, seams ${mixes.every((m) => m.seam?.pass) ? 'clean' : 'not clean'}` : ''}`,
      threshold: `every mix of the base and other layers within ${rule.target} ±${rule.tolerance} LUFS (${rule.basis}) and under ${style.truePeakMax} dBTP${render.mode === 'loop' ? ' with a clean seam' : ''}; each layer alone in key and at most ${hi} LUFS`,
      ranges: ranges.slice(0, 40),
    },
    mixes,
  };
}

// ---- render-match -------------------------------------------------------------------------------------------------

export interface NoteMatch {
  channel: string;
  /** The written note: time, length, pitch (null for a drum hit). */
  t: number;
  len: number;
  midi: number | null;
  drum: string | null;
  /** Detected onset (s), or null when there was no clear onset to measure. */
  onset: number | null;
  /** Detected pitch (Hz) over the note, or null when it could not be measured. */
  hz: number | null;
  ok: boolean;
  problem: string | null;
}

const HOP = 128;
const WIN = 256;

function monoOf(p: ChannelAudio): Float32Array {
  const n = p.channels[0].length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (p.channels[0][i]! + p.channels[1][i]!) / 2;
  return out;
}

function envDb(x: Float32Array): Float64Array {
  const n = Math.ceil(x.length / HOP);
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0;
    const a = k * HOP, b = Math.min(x.length, a + WIN);
    for (let i = a; i < b; i++) s += x[i]! * x[i]!;
    out[k] = 10 * Math.log10(s / WIN + 1e-12);
  }
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** The steepest rise (frame index and dB over ~9 ms) of the level in a window. */
function steepestRise(env: Float64Array, from: number, to: number): { k: number; rise: number } {
  let best = { k: -1, rise: 0 };
  const at = (k: number): number => (k < 0 ? -120 : env[k]!);
  for (let k = Math.max(0, from); k <= Math.min(env.length - 1, to); k++) {
    const rise = env[k]! - at(k - 3);
    if (rise > best.rise) best = { k, rise };
  }
  return best;
}

/** How alike x and x shifted by `tau` are over `w` samples from `a`: 0 for a signal periodic at tau, about 1 for unrelated ones. */
function lagFit(x: Float32Array, a: number, w: number, tau: number): number {
  let d = 0, e = 0;
  for (let j = a; j < a + w; j++) { const u = x[j]!, v = x[j + tau]!; d += (u - v) * (u - v); e += u * u + v * v; }
  return e > 1e-12 ? d / e : 1;
}

/** The lag near `center` (within `semis` semitones either way) where the signal repeats best, with its fit. */
function bestLag(x: Float32Array, a: number, w: number, center: number, semis: number): { tau: number; fit: number } {
  const lo = Math.max(2, Math.floor(center * 2 ** (-semis / 12))), hi = Math.ceil(center * 2 ** (semis / 12));
  const fits: number[] = [];
  let at = lo;
  for (let t = lo; t <= hi; t++) { const f = lagFit(x, a, w, t); fits.push(f); if (f < fits[at - lo]!) at = t; }
  const k = at - lo;
  let tau = at;
  if (k > 0 && k < fits.length - 1) { const l = fits[k - 1]!, m = fits[k]!, r = fits[k + 1]!, den = l - 2 * m + r; if (den > 0) tau = at + Math.max(-0.5, Math.min(0.5, (l - r) / (2 * den))); }
  return { tau, fit: fits[k]! };
}

const FIT_MAX = 0.3;
/** A half-lag that repeats this well (about as well as the written lag) means the sound is an octave above the note. */
const OCTAVE_FIT = 0.15;

/**
 * Is the signal from `a` periodic at the pitch of `midi`, within the pitch tolerance, and at nothing shorter? A cheap
 * look at the lags near the note's own period (and its half, for an octave above): enough to see where a pitch begins.
 * Null when the window is too short to say.
 */
function repeatsNear(x: Float32Array, a: number, w: number, midi: number): boolean | null {
  const c = SR / midiFreq(midi);
  if (w < 2 * c || a < 0 || c < 12 || a + w + c * 1.1 + 2 > x.length) return null;
  const b = bestLag(x, a, w, c, 1.5);
  if (Math.abs(12 * Math.log2(b.tau / c)) > MATCH_PITCH_SEMITONES || b.fit > FIT_MAX) return false;
  const h = bestLag(x, a, w, c / 2, 1.5);
  return !(Math.abs(12 * Math.log2(h.tau / (c / 2))) <= MATCH_PITCH_SEMITONES && h.fit < OCTAVE_FIT && h.fit <= b.fit + 0.05);
}

/**
 * Does the note sound as written? The fundamental period of the signal from `a` is the first lag (after the signal has
 * stopped resembling itself) where it repeats with a fit of at most FIT_MAX; this is YIN's idea with a plain difference
 * and a kinder threshold, over the start of the note only, where a pluck is still clear. The sound is the written note
 * when that period is the written period (the written pitch class at any octave when `octaves`). A pluck whose later
 * cycles drift, so that a tracker finds only the doubled period, still has its fundamental here. Null when the window is
 * too short to say.
 */
function soundsAs(x: Float32Array, a: number, w: number, midi: number, octaves: boolean): boolean | null {
  const t0 = SR / midiFreq(midi);
  const lo = Math.max(6, Math.floor(t0 / 4.2));
  let hi = Math.ceil(t0 * (octaves ? 4.2 : 1.2));
  hi = Math.min(hi, x.length - a - w - 2);
  if (w < 2 * t0 || a < 0 || hi < t0 * 1.1) return null;
  const fits: number[] = [];
  for (let t = lo; t <= hi; t++) fits.push(lagFit(x, a, w, t));
  let apart = false;
  for (let i = 1; i < fits.length - 1; i++) {
    if (fits[i]! > 0.5) apart = true;
    if (!apart || fits[i]! > FIT_MAX || fits[i]! > fits[i - 1]! || fits[i]! >= fits[i + 1]!) continue;
    const l = fits[i - 1]!, m = fits[i]!, r = fits[i + 1]!, den = l - 2 * m + r;
    const tau = lo + i + (den > 0 ? Math.max(-0.5, Math.min(0.5, (l - r) / (2 * den))) : 0);
    const off = 12 * Math.log2(tau / t0);
    return Math.abs(octaves ? off - 12 * Math.round(off / 12) : off) <= MATCH_PITCH_SEMITONES;
  }
  return false;
}

/** The time the pitch becomes `midi` between `from` and `to` seconds (the first window that is wholly the new note), or null. For touching notes that have no rise in level. */
function pitchOnset(x: Float32Array, from: number, to: number, midi: number): number | null {
  const t0 = SR / midiFreq(midi);
  const w = Math.min(1536, Math.max(256, Math.ceil(3 * t0)));
  for (let t = Math.max(0, from); t <= to; t += 0.004) {
    if (repeatsNear(x, Math.round(t * SR), w, midi) === true) return r4(t);
  }
  return null;
}

export interface RenderMatchResult {
  check: MusicCheck;
  notes: NoteMatch[];
  /** Per channel, the detected pitch track (for the view). */
  pitch: Map<string, PitchFrame[]>;
  onsets: Map<string, number[]>;
}

function matchPart(part: ChannelAudio, events: readonly NoteEv[], chan: Channel, inst: Instrument | undefined): { notes: NoteMatch[]; track: PitchFrame[]; onsets: number[] } {
  const out: NoteMatch[] = [];
  const x = monoOf(part);
  const env = envDb(x);
  let peakDb = -120;
  for (const v of env) if (v > peakDb) peakDb = v;
  const pitched = events.some((e) => e.midi !== null);
  const track = pitched ? yinPitch(x, { hop: 1024, fmin: 50, fmax: 4200 }) : [];
  const attack = inst?.attack ?? 0;
  // the instrument's declared pitch rule: the note, its pitch class (an inharmonic bell), or timing alone
  const rule = inst ? pitchCheckOf(inst) : 'full';
  const legato = inst?.legato === true;
  const tolerance = MATCH_TIMING_MS / 1000 + 0.5 * attack;
  const onsets: number[] = [];
  // group events that start together (a chord)
  // (notes written at the same step, even when humanise moved them apart by a few ms)
  const byStep = new Map<string, NoteEv[]>();
  for (const e of events) { const k = `${e.at.instance}/${e.at.step}`; byStep.set(k, [...(byStep.get(k) ?? []), e]); }
  const groups = new Map<number, NoteEv[]>();
  for (const g of byStep.values()) { g.sort((a, b) => a.t - b.t); const k = Math.round(g[0]!.t * SR); groups.set(k, [...(groups.get(k) ?? []), ...g]); }
  const keys = [...groups.keys()].sort((a, b) => a - b);
  keys.forEach((key, gi) => {
    const grp = groups.get(key)!;
    const first = grp[0]!;
    const tw = first.t;
    const nextT = gi + 1 < keys.length ? groups.get(keys[gi + 1]!)![0]!.t : Infinity;
    const prevT = gi > 0 ? groups.get(keys[gi - 1]!)![0]!.t : -Infinity;
    const kFrom = Math.floor(((Math.max(tw - 0.04, (tw + prevT) / 2)) * SR) / HOP), kTo = Math.ceil(((Math.min(tw + 0.12, Math.max(tw + 0.03, nextT - 0.03))) * SR) / HOP);
    const { k, rise } = steepestRise(env, kFrom, kTo);
    const prevEnd = gi > 0 ? Math.max(...groups.get(keys[gi - 1]!)!.map((e) => e.t + e.len)) : -1;
    // a note that touches the one before it (no gap, or under 30 ms; under 80 ms for a legato voice) has no rise in level to find
    const touching = prevEnd >= tw - (legato ? 0.08 : 0.03);
    const single = grp.length === 1 && first.midi !== null && !first.fx.arp;
    const prevGrp = gi > 0 ? groups.get(keys[gi - 1]!)! : null;
    const prevMidi = prevGrp && prevGrp.length === 1 && prevGrp[0]!.midi !== null && !prevGrp[0]!.fx.arp ? prevGrp[0]!.midi : null;
    const octaves = rule === 'class';
    const changes = single && prevMidi !== null && rule !== 'onset' && (octaves ? (first.midi! - prevMidi) % 12 !== 0 : first.midi! !== prevMidi);
    let onset: number | null = null;
    let problem: string | null = null;
    // the level around the note, to know whether it is heard at all
    const winLevel = Math.max(...Array.from(env.subarray(Math.max(0, Math.floor((tw * SR) / HOP)), Math.min(env.length, Math.ceil(((tw + Math.max(0.03, first.len)) * SR) / HOP) + 1)), (v) => v), -120);
    const levelOnset = rise >= 6 ? r4(((k * HOP) + WIN / 2 - 3 * HOP / 2) / SR) : null;
    // where the note is written to change pitch, the onset may be the pitch change (always for a legato voice's touching notes)
    const byPitchOnly = legato && touching;
    let pitchAt: number | null = null;
    if (changes && (touching || levelOnset === null || Math.abs(levelOnset - tw) > tolerance)) pitchAt = pitchOnset(x, tw - 0.04, tw + 0.12 + 0.5 * attack, first.midi!);
    // The pitch change vouches for a note whose level gives no onset, and convicts one that begins late; it never calls a
    // note early, for a window that straddles the old and the new note looks like the new one a little too soon.
    const found = (byPitchOnly ? [] : [levelOnset]).filter((v): v is number => v !== null);
    if (pitchAt !== null) found.push(pitchAt < tw - tolerance ? tw : pitchAt);
    if (found.length) onset = found.reduce((m, v) => (Math.abs(v - tw) < Math.abs(m - tw) ? v : m));
    if (onset !== null) onsets.push(onset);
    if (winLevel < peakDb - NOT_HEARD_DB) problem = `not heard: the channel is ${f1(peakDb - winLevel)} dB under its loudest at ${r4(tw)} s`;
    else if (onset !== null && Math.abs(onset - tw) > tolerance) problem = `onset ${onset < tw ? 'early' : 'late'} by ${Math.round(Math.abs(onset - tw) * 1000)} ms (written ${r4(tw)} s, heard ${onset} s)`;
    else if (onset === null && !touching) problem = `no clear onset near ${r4(tw)} s`;
    // pitch
    let hz: number | null = null;
    const pitchedGroup = grp.filter((e) => e.midi !== null);
    if (!problem && rule !== 'onset' && pitchedGroup.length === 1 && !pitchedGroup[0]!.fx.arp && midiFreq(pitchedGroup[0]!.midi!) >= 55) {
      const len = first.len;
      const a = tw + Math.min(0.08, len * 0.3), b = tw + Math.max(Math.min(len, 0.5) * 0.9, 0.05);
      const vals = track.filter((f) => f.hz !== null && f.t >= a && f.t <= b && f.clarity > 0.7).map((f) => f.hz!);
      if (vals.length >= 2) {
        hz = median(vals);
        const diffs = pitchedGroup.map((e) => 12 * Math.log2(hz! / midiFreq(e.midi!)));
        const best = diffs.reduce((m, d) => (Math.abs(d) < Math.abs(m) ? d : m), diffs[0]!);
        const oct = Math.round(best / 12);
        if (Math.abs(best) > MATCH_PITCH_SEMITONES && !(rule === 'class' && Math.abs(best - oct * 12) <= MATCH_PITCH_SEMITONES)) {
          // the track can lock onto a sub-harmonic of a decaying pluck: look for the written pitch in the start of the note before calling it wrong
          const from = tw + 0.5 * attack + 0.012;
          const until = Math.min(tw + len, Number.isFinite(nextT) ? nextT - 0.01 : Infinity, tw + 0.35);
          const w = Math.min(2048, Math.floor((until - from) * SR));
          if (soundsAs(x, Math.round(from * SR), w, pitchedGroup[0]!.midi!, octaves) !== true) {
            const want = noteLabel(pitchedGroup[0]!.midi!);
            const got = noteLabel(Math.round(69 + 12 * Math.log2(hz / 440)));
            problem = Math.abs(best - oct * 12) <= MATCH_PITCH_SEMITONES && oct !== 0
              ? `wrong octave: written ${want}, heard ${got} (${Math.abs(oct)} octave${Math.abs(oct) === 1 ? '' : 's'} ${oct > 0 ? 'high' : 'low'}); check the instrument's root`
              : `wrong pitch: written ${want}, heard ${got} (${best > 0 ? '+' : ''}${best.toFixed(1)} semitones)`;
          }
        }
      }
    }
    for (const e of grp) out.push({ channel: part.name, t: e.t, len: e.len, midi: e.midi, drum: e.drum, onset, hz, ok: !problem, problem });
  });
  return { notes: out, track, onsets };
}

/** Compare every written note with the channel rendered alone. Notes with ~arp (the pitch moves) are checked for timing only. */
export function renderMatch(song: SongDoc, render: SongRender, lookup: InstLookup = () => undefined, memo?: Memo): RenderMatchResult {
  const notes: NoteMatch[] = [];
  const pitchTracks = new Map<string, PitchFrame[]>();
  const onsetLists = new Map<string, number[]>();
  for (const part of render.parts) {
    const events = render.events.get(part.name) ?? [];
    if (!events.length) continue;
    const chan = song.channels.find((c) => c.name === part.name)!;
    const inst = chan.inst ? lookup(chan.inst) : undefined;
    // everything a channel's match depends on: its samples (the key), what the notes are held to
    const key = `${ANALYSIS_VERSION}|match|${part.key}|${inst?.attack ?? 0}|${inst ? pitchCheckOf(inst) : 'full'}|${inst?.legato === true}|${chan.inst ?? ''}`;
    const one = memoized(memo, key, () => matchPart(part, events, chan, inst));
    notes.push(...one.notes);
    pitchTracks.set(part.name, one.track);
    onsetLists.set(part.name, one.onsets);
  }
  const seenBad = new Set<string>();
  const bad = notes.filter((n) => { if (n.ok) return false; const k = `${n.channel}@${n.t}`; if (seenBad.has(k)) return false; seenBad.add(k); return true; });
  const ranges: MusicRange[] = bad.slice(0, 40).map((n) => ({ from: r4(n.t), to: r4(n.t + Math.max(n.len, 0.05)), channel: n.channel, note: `${n.channel}: ${n.problem}` }));
  const measured = new Set(notes.map((n) => `${n.channel}@${n.t}`)).size;
  return {
    check: {
      name: 'render-match', advisory: false, skipped: measured === 0, pass: bad.length === 0, score: measured ? clamp01(1 - bad.length / measured * 3) : 1,
      value: measured === 0 ? 'no notes' : bad.length === 0 ? `all ${measured} notes sound when and what they are written` : `${bad.length} of ${measured} notes differ from what is written`,
      threshold: `each note's onset within ${MATCH_TIMING_MS} ms (plus half its instrument's attack) and a single note's pitch within ${MATCH_PITCH_SEMITONES} semitones of the written one (chords and ~arp notes: timing only; an instrument's pitch-check may ask for the pitch class only, or timing only)`, ranges,
    },
    notes, pitch: pitchTracks, onsets: onsetLists,
  };
}

// ---- masking ------------------------------------------------------------------------------------------------------

export const BANDS = [
  { name: 'sub', lo: 20, hi: 120 },
  { name: 'low', lo: 120, hi: 500 },
  { name: 'mid', lo: 500, hi: 2000 },
  { name: 'high', lo: 2000, hi: 6000 },
  { name: 'air', lo: 6000, hi: 20000 },
] as const;

export interface BandMap {
  /** Seconds per frame. */
  hop: number;
  channels: { name: string; db: Float64Array[] }[];
  /** Per frame: the pair of channels and the band that mask each other, or null. */
  masked: ({ a: string; b: string; band: string } | null)[];
  frames: number;
}

/** One channel's energy (dB) in each band, one value per frame. */
interface ChannelBands { name: string; db: Float64Array[]; frames: number }

function channelBands(p: ChannelAudio, memo?: Memo): ChannelBands {
  const size = 2048, hop = 2048;
  const stored = memoized(memo, `${ANALYSIS_VERSION}|bands|${p.key}`, () => {
    const s = stft(monoOf(p), size, hop);
    const db = BANDS.map(() => new Array<number>(s.mags.length));
    s.mags.forEach((m, f) => {
      BANDS.forEach((b, bi) => {
        const lo = Math.max(1, Math.ceil((b.lo * size) / SR)), hi = Math.min(size / 2, Math.floor((b.hi * size) / SR));
        let e = 0;
        for (let k = lo; k <= hi; k++) e += m[k]! * m[k]!;
        db[bi]![f] = 10 * Math.log10(e + 1e-12);
      });
    });
    return db;
  });
  return { name: p.name, db: stored.map((r) => Float64Array.from(r)), frames: stored[0]?.length ?? 0 };
}

/** Per-channel band energy (dB) over time, and the frames where two channels share the same loudest band. */
export function bandMap(parts: readonly ChannelAudio[], memo?: Memo): BandMap {
  const size = 2048, hop = 2048;
  const per = parts.map((p) => channelBands(p, memo));
  const frames = Math.max(0, ...per.map((p) => p.frames));
  let top = -200;
  for (const p of per) for (const row of p.db) for (const v of row) if (v > top) top = v;
  const masked: BandMap['masked'] = [];
  for (let f = 0; f < frames; f++) {
    let found: BandMap['masked'][number] = null;
    // the band that holds the most energy in this frame, over all channels; there the two loudest channels are compared
    let best = -1, bestE = 0;
    BANDS.forEach((_, bi) => { let e = 0; for (const p of per) if (f < p.frames) e += 10 ** (p.db[bi]![f]! / 10); if (e > bestE) { bestE = e; best = bi; } });
    if (best >= 0) {
      const ranked = per.filter((p) => f < p.frames).map((p) => ({ name: p.name, db: p.db[best]![f]! })).sort((x, y) => y.db - x.db);
      const a = ranked[0], b = ranked[1];
      if (a && b && a.db >= top - 30 && b.db >= a.db - MASK_CLOSE_DB) found = { a: a.name, b: b.name, band: BANDS[best]!.name };
    }
    masked.push(found);
  }
  return { hop: hop / SR, channels: per.map((p) => ({ name: p.name, db: p.db })), masked, frames };
}

export function maskingCheck(map: BandMap): MusicCheck {
  const ranges: MusicRange[] = [];
  let run: { a: string; b: string; band: string; from: number; to: number } | null = null;
  let maskedFrames = 0, active = 0;
  const flush = (): void => {
    if (run && run.to - run.from >= MASK_MIN_SECONDS) ranges.push({ from: r4(run.from), to: r4(run.to), channel: `${run.a}+${run.b}`, note: `${run.a} and ${run.b} are the two loudest in the ${run.band} band and within ${MASK_CLOSE_DB} dB of each other` });
    run = null;
  };
  for (let f = 0; f < map.frames; f++) {
    const m = map.masked[f]!;
    if (m) {
      maskedFrames++;
      if (run && run.a === m.a && run.b === m.b && run.band === m.band) run.to = (f + 1) * map.hop;
      else { flush(); run = { ...m, from: f * map.hop, to: (f + 1) * map.hop }; }
    } else flush();
    if (map.channels.some((c) => BANDS.some((_, i) => c.db[i]![f]! > -70))) active++;
  }
  flush();
  const frac = active ? maskedFrames / active : 0;
  const pass = frac <= MASK_MAX_FRACTION;
  return {
    name: 'masking', advisory: true, skipped: false, pass, score: clamp01(1 - Math.max(0, frac - MASK_MAX_FRACTION) / 0.4),
    value: `${Math.round(frac * 100)} % of the time the two loudest channels in the main band are within ${MASK_CLOSE_DB} dB of each other${ranges.length ? ` (${ranges.length} stretch${ranges.length === 1 ? '' : 'es'} of ${MASK_MIN_SECONDS} s or more)` : ''}`,
    threshold: `at most ${Math.round(MASK_MAX_FRACTION * 100)} % of the time (advisory: it never blocks work done)`, ranges: ranges.slice(0, 30),
  };
}

// ---- the mix ------------------------------------------------------------------------------------------------------

export interface MixNumbers {
  samples: number;
  duration: number;
  peak: number;
  truePeakDb: number;
  lufs: number;
  dc: number;
  silent: boolean;
}

/** The numbers the mix checks need (the full analysis of a sound also tracks pitch and brightness, which a mix does not use). */
export function mixNumbers(mix: readonly Float32Array[]): MixNumbers {
  const n = mix[0]!.length;
  let peak = 0, sum = 0;
  for (const c of mix) for (let i = 0; i < n; i++) { const v = c[i]!; const a = Math.abs(v); if (a > peak) peak = a; sum += v; }
  return { samples: n, duration: n / SR, peak, truePeakDb: Math.max(...mix.map((c) => 20 * Math.log10(Math.max(1e-9, truePeak(c))))), lufs: peak < 1e-6 ? -Infinity : integratedLoudness(mix), dc: n ? sum / (n * mix.length) : 0, silent: peak < 1e-6 };
}

export function mixChecks(mix: readonly Float32Array[], a: MixNumbers, style: Style, rule: SongLoudnessRule): MusicCheck[] {
  const out: MusicCheck[] = [];
  const n = a.samples;
  // clip: true peak, and runs at full scale
  const full: MusicRange[] = [];
  let start = -1, last = -1;
  for (let i = 0; i < n; i++) {
    if (mix.some((c) => Math.abs(c[i]!) >= 0.9999)) { if (start >= 0 && i - last > 44) { full.push({ from: r4(start / SR), to: r4((last + 1) / SR), note: 'samples at full scale' }); start = -1; } if (start < 0) start = i; last = i; }
  }
  if (start >= 0) full.push({ from: r4(start / SR), to: r4((last + 1) / SR), note: 'samples at full scale' });
  const over = a.truePeakDb - style.truePeakMax;
  const clipPass = a.silent || (over <= 0 && !full.length);
  out.push({ name: 'clip', advisory: false, skipped: false, pass: clipPass, score: a.silent ? 1 : clamp01(1 - Math.max(over, full.length ? 0.5 : 0) / 3), value: `true peak ${f1(a.truePeakDb)} dBTP${full.length ? `, ${full.length} run${full.length === 1 ? '' : 's'} at full scale` : ''}`, threshold: `at most ${f1(style.truePeakMax)} dBTP, no samples at full scale`, ranges: a.silent ? [] : full.slice(0, 12) });
  // loudness
  const diff = a.lufs - rule.target;
  const off = Math.abs(diff) - rule.tolerance;
  out.push({ name: 'loudness', advisory: false, skipped: false, pass: Number.isFinite(a.lufs) && off <= 0, score: Number.isFinite(a.lufs) ? clamp01(1 - Math.max(0, off) / 6) : 0, value: `${f1(a.lufs)} LUFS${off > 0 && Number.isFinite(a.lufs) ? ` (${f1(Math.abs(diff))} LU too ${diff > 0 ? 'loud' : 'quiet'})` : ''}`, threshold: `${rule.target} LUFS ±${rule.tolerance} (${rule.basis})`, ranges: off > 0 && Number.isFinite(a.lufs) ? [{ from: 0, to: r4(a.duration), note: `the whole song is ${f1(Math.abs(diff))} LU too ${diff > 0 ? 'loud' : 'quiet'}: normalize <project> <song> writes the gain` }] : [] });
  // dc
  const dcOver = Math.abs(a.dc) - style.dcMax;
  out.push({ name: 'dc', advisory: false, skipped: false, pass: dcOver <= 0, score: clamp01(1 - Math.max(0, dcOver) / (style.dcMax * 4)), value: `${(a.dc * 100).toFixed(2)} %`, threshold: `at most ±${(style.dcMax * 100).toFixed(2)} %`, ranges: dcOver > 0 ? [{ from: 0, to: r4(a.duration), note: 'the mix is offset: an instrument has a DC offset (a pulse wave off 50 % duty; add a high-pass filter layer filter=hp cutoff=35)' }] : [] });
  return out;
}

/** The loop's seam, read as music: no jump from the last sample to the first, and no big step in loudness between the last beat and the first. A loop of drums ends quieter than it starts, so the step is allowed twice the style's seamStepMaxDb. */
export function loopCheck(mix: readonly Float32Array[], tempo: number, style: Style): MusicCheck {
  const n = mix[0]!.length;
  const per = mix.map((c) => seamNumbers(c));
  const worst = per.reduce((m, p) => (p.jump - SEAM_STEP_FACTOR * p.local > m.jump - SEAM_STEP_FACTOR * m.local ? p : m), per[0]!);
  const win = Math.min(Math.floor(n / 2), Math.round(SR * Math.min(1, Math.max(0.25, 60 / tempo))));
  let a = 0, b = 0;
  for (const c of mix) for (let i = 0; i < win; i++) { a += c[i]! * c[i]!; b += c[n - 1 - i]! * c[n - 1 - i]!; }
  // a side of digital silence is a gap in the music, not a step in level
  const step = a > 1e-9 && b > 1e-9 ? 10 * Math.log10(a / b) : 0;
  const limit = style.seamStepMaxDb * 2;
  const d = n / SR;
  const ranges: MusicRange[] = [];
  const jumpBad = worst.jump > style.clickMax && worst.jump > SEAM_STEP_FACTOR * worst.local;
  if (jumpBad) ranges.push({ from: r4(Math.max(0, d - 0.001)), to: r4(d), note: `the seam jumps by ${worst.jump.toFixed(3)} (the local step is ${worst.local.toFixed(3)}): a note is cut at the loop end, or starts at a different phase` });
  if (Math.abs(step) > limit) ranges.push({ from: r4(Math.max(0, d - win / SR)), to: r4(d), note: `the last ${r4(win / SR)} s is ${f1(Math.abs(step))} dB ${step > 0 ? 'quieter' : 'louder'} than the first ${r4(win / SR)} s` });
  return {
    name: 'loop-music', advisory: false, skipped: false, pass: !ranges.length,
    score: clamp01(1 - Math.max(jumpBad ? 0.5 : 0, Math.max(0, Math.abs(step) - limit) / 12)),
    value: `seam jump ${worst.jump.toFixed(3)} (local step ${worst.local.toFixed(3)}), level step ${f1(step)} dB over ${r4(win / SR)} s`,
    threshold: `seam jump at most ${style.clickMax} or ${SEAM_STEP_FACTOR}x the local step; level step at most ${limit} dB`, ranges,
  };
}

// ---- everything for a song ----------------------------------------------------------------------------------------

export interface SongNumbers {
  /** Seconds in the full song (intro, body, ending) and the loop region (null: does not loop). */
  length: number;
  loopLength: number | null;
  tempo: number;
  swing: number;
  time: string;
  key: string | null;
  lufs: number;
  truePeakDb: number;
  rule: SongLoudnessRule;
  channels: { name: string; layer: string; lufs: number; peakDb: number; notes: number }[];
  layers: string[];
  /** Largest gain reduction of the master chain on the mix, dB. */
  masterReductionDb: number;
}

export interface SongReport {
  numbers: SongNumbers;
  checks: MusicCheck[];
  match: RenderMatchResult;
  map: BandMap;
  analysis: MixNumbers;
  /** The loop render's numbers (null when the song has no loop). */
  loop: { analysis: MixNumbers; seam: MusicCheck } | null;
  /** Each mix of the game layers a game can play. */
  layerMixes: LayerMix[];
}

/** Worst gain reduction the master chain made on the mix: the smallest ratio of mix to pre-master level, dB. */
export function reductionDb(pre: readonly Float32Array[], mix: readonly Float32Array[]): number {
  let worst = 1;
  for (let c = 0; c < pre.length; c++) {
    const p = pre[c]!, m = mix[c]!;
    for (let i = 0; i < p.length; i++) {
      const a = Math.abs(p[i]!);
      if (a > 0.05) { const r = Math.abs(m[i]!) / a; if (r < worst) worst = r; }
    }
  }
  return worst < 1 ? -20 * Math.log10(worst) : 0;
}

export interface ReportInput {
  song: SongDoc;
  full: SongRender;
  loop: SongRender | null;
  style: Style;
  instruments: InstLookup;
  /** The project's music style guide and bible (the style check). */
  guide?: MusicGuide;
  /** Where measurements are kept between calls (and processes): each channel is analysed once, the mix once for each distinct mix. */
  memo?: Memo;
}

export function songReport(i: ReportInput): SongReport {
  const { song, full, style } = i;
  const lookup = withBuiltins(i.instruments);
  const arr = arrange(song);
  const rule = songLoudnessRule(song, style);
  const memo = i.memo;
  const V = ANALYSIS_VERSION;
  const styleKey = JSON.stringify(style);
  // the mix: its numbers, the three checks that read it, and what the master chain took off
  const mixPart = memoized(memo, `${V}|mix|${full.key}|${JSON.stringify(rule)}|${styleKey}`, () => {
    const a = mixNumbers(full.mix);
    return { analysis: a, checks: mixChecks(full.mix, a, style, rule), reduction: reductionDb(full.pre, full.mix) };
  });
  const analysis = mixPart.analysis;
  const match = renderMatch(song, full, lookup, memo);
  const map = bandMap(full.parts, memo);
  const checks: MusicCheck[] = [...mixPart.checks, keyCheck(song, arr), rangeCheck(song, arr, lookup), match.check];
  let loop: SongReport['loop'] = null;
  if (i.loop) {
    const la = { samples: i.loop.length, duration: i.loop.length / SR, peak: 0, truePeakDb: 0, lufs: 0, dc: 0, silent: false } satisfies MixNumbers;
    const seam = memoized(memo, `${V}|seam|${i.loop.key}|${song.tempo}|${styleKey}`, () => loopCheck(i.loop!.mix, song.tempo, style));
    loop = { analysis: la, seam };
    checks.push(seam);
  } else checks.push({ name: 'loop-music', advisory: false, pass: true, skipped: true, score: 1, value: song.loop === false ? 'the song does not loop (loop is off)' : 'no loop region', threshold: 'the loop seam has no click and no level step', ranges: [] });
  checks.push(maskingCheck(map));
  checks.push(voiceLeadingCheck(song, arr));
  checks.push(styleCheck(song, i.guide));
  const layerSource = i.loop ?? full;
  const layers = memoized(memo, `${V}|layers|${layerSource.key}|${JSON.stringify([song.key, song.layers, song.channels.map((c) => [c.name, c.layer]), rule])}|${styleKey}`, () => layersCheck(song, layerSource, style, rule, arrange(song)));
  checks.push(layers.check);
  const channels = full.parts.map((p) => {
    const events = full.events.get(p.name) ?? [];
    const own = memoized(memo, `${V}|channel|${p.key}`, () => {
      let peak = 0;
      for (const c of p.channels) for (let k = 0; k < c.length; k++) { const v = Math.abs(c[k]!); if (v > peak) peak = v; }
      return { lufs: integratedLoudness([p.channels[0], p.channels[1]]), peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity };
    });
    return { name: p.name, layer: p.layer, lufs: own.lufs, peakDb: own.peakDb, notes: events.length };
  });
  const numbers: SongNumbers = {
    length: arr.total, loopLength: arr.loop ? arr.loop.end - arr.loop.start : null, tempo: song.tempo, swing: song.swing, time: `${song.time[0]}/${song.time[1]}`, key: song.key,
    lufs: analysis.lufs, truePeakDb: analysis.truePeakDb, rule, channels, layers: [...new Set(full.parts.map((p) => p.layer))], masterReductionDb: mixPart.reduction,
  };
  return { numbers, checks, match, map, analysis, loop, layerMixes: layers.mixes };
}

/** The checks that must pass for `work done`: all but the advisory ones (skipped checks pass). */
export const songPasses = (checks: readonly MusicCheck[]): boolean => checks.every((c) => c.advisory || c.skipped || c.pass);
