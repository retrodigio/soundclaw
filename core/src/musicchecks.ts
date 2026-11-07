// Checks and measurements for songs. They read the written song (key, range), the rendered channels
// (render-match, masking) or the mix (clip, loudness, dc, loop-music). Rendering is deterministic;
// these measure, so they may use platform maths.
//
//   key           written notes outside the song's scale (unless marked with !)
//   range         written notes outside an instrument's declared range
//   render-match  each written note against the channel rendered alone: onset within 20 ms, the right pitch
//   loop-music    the loop's seam: a click, or a step in level
//   masking       two channels with most of their energy in the same band at the same time (advisory)
//   clip, loudness, dc   the mix

import { SAMPLE_RATE } from './sound.ts';
import { integratedLoudness, stft, truePeak, yinPitch, type PitchFrame } from './analysis.ts';
import { SEAM_STEP_FACTOR, classTable, seamNumbers, type CheckRange, type Style } from './checks.ts';
import { builtinInstruments, type Instrument } from './instrument.ts';
import { inKey, midiFreq, noteLabel, parseKey, pitchClassName } from './music.ts';
import { arrange, channelNotes, type NoteEv, type SongDoc } from './song.ts';
import type { ChannelAudio, SongRender } from './songrender.ts';

export type MusicCheckName = 'key' | 'range' | 'render-match' | 'loop-music' | 'masking' | 'clip' | 'loudness' | 'dc';
export const MUSIC_CHECK_NAMES: readonly MusicCheckName[] = ['clip', 'loudness', 'dc', 'key', 'range', 'render-match', 'loop-music', 'masking'];

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

export interface RenderMatchResult {
  check: MusicCheck;
  notes: NoteMatch[];
  /** Per channel, the detected pitch track (for the view). */
  pitch: Map<string, PitchFrame[]>;
  onsets: Map<string, number[]>;
}

/** Compare every written note with the channel rendered alone. Notes with ~arp (the pitch moves) are checked for timing only. */
export function renderMatch(song: SongDoc, render: SongRender, lookup: InstLookup = () => undefined): RenderMatchResult {
  const notes: NoteMatch[] = [];
  const pitchTracks = new Map<string, PitchFrame[]>();
  const onsetLists = new Map<string, number[]>();
  for (const part of render.parts) {
    const events = render.events.get(part.name) ?? [];
    if (!events.length) continue;
    const x = monoOf(part);
    const env = envDb(x);
    let peakDb = -120;
    for (const v of env) if (v > peakDb) peakDb = v;
    const pitched = events.some((e) => e.midi !== null);
    const track = pitched ? yinPitch(x, { hop: 1024, fmin: 50, fmax: 4200 }) : [];
    const chan = song.channels.find((c) => c.name === part.name)!;
    const attack = chan.inst ? (lookup(chan.inst)?.attack ?? 0) : 0;
    const tolerance = MATCH_TIMING_MS / 1000 + 0.5 * attack;
    pitchTracks.set(part.name, track);
    const onsets: number[] = [];
    // group events that start together (a chord)
    const groups = new Map<number, NoteEv[]>();
    for (const e of events) { const k = Math.round(e.t * SR); groups.set(k, [...(groups.get(k) ?? []), e]); }
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
      const legato = prevEnd >= tw - 0.03;
      let onset: number | null = null;
      let problem: string | null = null;
      // the level around the note, to know whether it is heard at all
      const winLevel = Math.max(...Array.from(env.subarray(Math.max(0, Math.floor((tw * SR) / HOP)), Math.min(env.length, Math.ceil(((tw + Math.max(0.03, first.len)) * SR) / HOP) + 1)), (v) => v), -120);
      if (rise >= 6) { onset = r4(((k * HOP) + WIN / 2 - 3 * HOP / 2) / SR); onsets.push(onset); }
      if (winLevel < peakDb - NOT_HEARD_DB) problem = `not heard: the channel is ${f1(peakDb - winLevel)} dB under its loudest at ${r4(tw)} s`;
      else if (onset !== null && Math.abs(onset - tw) > tolerance) problem = `onset ${onset < tw ? 'early' : 'late'} by ${Math.round(Math.abs(onset - tw) * 1000)} ms (written ${r4(tw)} s, heard ${onset} s)`;
      else if (onset === null && !legato) problem = `no clear onset near ${r4(tw)} s`;
      // pitch
      let hz: number | null = null;
      const pitchedGroup = grp.filter((e) => e.midi !== null);
      if (!problem && pitchedGroup.length === 1 && !pitchedGroup[0]!.fx.arp && midiFreq(pitchedGroup[0]!.midi!) >= 55) {
        const len = first.len;
        const a = tw + Math.min(0.08, len * 0.3), b = tw + Math.max(Math.min(len, 0.5) * 0.9, 0.05);
        const vals = track.filter((f) => f.hz !== null && f.t >= a && f.t <= b && f.clarity > 0.7).map((f) => f.hz!);
        if (vals.length >= 2) {
          hz = median(vals);
          const diffs = pitchedGroup.map((e) => 12 * Math.log2(hz! / midiFreq(e.midi!)));
          const best = diffs.reduce((m, d) => (Math.abs(d) < Math.abs(m) ? d : m), diffs[0]!);
          const oct = Math.round(best / 12);
          if (Math.abs(best) > MATCH_PITCH_SEMITONES) {
            const want = noteLabel(pitchedGroup[0]!.midi!);
            const got = noteLabel(Math.round(69 + 12 * Math.log2(hz / 440)));
            problem = Math.abs(best - oct * 12) <= MATCH_PITCH_SEMITONES && oct !== 0
              ? `wrong octave: written ${want}, heard ${got} (${Math.abs(oct)} octave${Math.abs(oct) === 1 ? '' : 's'} ${oct > 0 ? 'high' : 'low'}); check the instrument's root`
              : `wrong pitch: written ${want}, heard ${got} (${best > 0 ? '+' : ''}${best.toFixed(1)} semitones)`;
          }
        }
      }
      for (const e of grp) notes.push({ channel: part.name, t: e.t, len: e.len, midi: e.midi, drum: e.drum, onset, hz, ok: !problem, problem });
    });
    onsetLists.set(part.name, onsets);
  }
  const seenBad = new Set<string>();
  const bad = notes.filter((n) => { if (n.ok) return false; const k = `${n.channel}@${n.t}`; if (seenBad.has(k)) return false; seenBad.add(k); return true; });
  const ranges: MusicRange[] = bad.slice(0, 40).map((n) => ({ from: r4(n.t), to: r4(n.t + Math.max(n.len, 0.05)), channel: n.channel, note: `${n.channel}: ${n.problem}` }));
  const measured = new Set(notes.map((n) => `${n.channel}@${n.t}`)).size;
  return {
    check: {
      name: 'render-match', advisory: false, skipped: measured === 0, pass: bad.length === 0, score: measured ? clamp01(1 - bad.length / measured * 3) : 1,
      value: measured === 0 ? 'no notes' : bad.length === 0 ? `all ${measured} notes sound when and what they are written` : `${bad.length} of ${measured} notes differ from what is written`,
      threshold: `each note's onset within ${MATCH_TIMING_MS} ms (plus half its instrument's attack) and a single note's pitch within ${MATCH_PITCH_SEMITONES} semitones of the written one (chords and ~arp notes: timing only)`, ranges,
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

/** Per-channel band energy (dB) over time, and the frames where two channels share the same loudest band. */
export function bandMap(parts: readonly ChannelAudio[]): BandMap {
  const size = 2048, hop = 2048;
  const per = parts.map((p) => {
    const s = stft(monoOf(p), size, hop);
    const db = BANDS.map(() => new Float64Array(s.mags.length));
    s.mags.forEach((m, f) => {
      BANDS.forEach((b, bi) => {
        const lo = Math.max(1, Math.ceil((b.lo * size) / SR)), hi = Math.min(size / 2, Math.floor((b.hi * size) / SR));
        let e = 0;
        for (let k = lo; k <= hi; k++) e += m[k]! * m[k]!;
        db[bi]![f] = 10 * Math.log10(e + 1e-12);
      });
    });
    return { name: p.name, db, frames: s.mags.length };
  });
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
}

export function songReport(i: ReportInput): SongReport {
  const { song, full, style } = i;
  const lookup = withBuiltins(i.instruments);
  const arr = arrange(song);
  const rule = songLoudnessRule(song, style);
  const analysis = mixNumbers(full.mix);
  const match = renderMatch(song, full, lookup);
  const map = bandMap(full.parts);
  const checks: MusicCheck[] = [...mixChecks(full.mix, analysis, style, rule), keyCheck(song, arr), rangeCheck(song, arr, lookup), match.check];
  let loop: SongReport['loop'] = null;
  if (i.loop) {
    const la = { samples: i.loop.length, duration: i.loop.length / SR, peak: 0, truePeakDb: 0, lufs: 0, dc: 0, silent: false } satisfies MixNumbers;
    const seam = loopCheck(i.loop.mix, song.tempo, style);
    loop = { analysis: la, seam };
    checks.push(seam);
  } else checks.push({ name: 'loop-music', advisory: false, pass: true, skipped: true, score: 1, value: song.loop === false ? 'the song does not loop (loop is off)' : 'no loop region', threshold: 'the loop seam has no click and no level step', ranges: [] });
  checks.push(maskingCheck(map));
  const channels = full.parts.map((p) => {
    const events = full.events.get(p.name) ?? [];
    let peak = 0;
    for (const c of p.channels) for (let k = 0; k < c.length; k++) { const v = Math.abs(c[k]!); if (v > peak) peak = v; }
    return { name: p.name, layer: p.layer, lufs: integratedLoudness([p.channels[0], p.channels[1]]), peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity, notes: events.length };
  });
  const numbers: SongNumbers = {
    length: arr.total, loopLength: arr.loop ? arr.loop.end - arr.loop.start : null, tempo: song.tempo, swing: song.swing, time: `${song.time[0]}/${song.time[1]}`, key: song.key,
    lufs: analysis.lufs, truePeakDb: analysis.truePeakDb, rule, channels, layers: [...new Set(full.parts.map((p) => p.layer))], masterReductionDb: reductionDb(full.pre, full.mix),
  };
  return { numbers, checks, match, map, analysis, loop };
}

/** The checks that must pass for `work done`: all but the advisory ones (skipped checks pass). */
export const songPasses = (checks: readonly MusicCheck[]): boolean => checks.every((c) => c.advisory || c.skipped || c.pass);
