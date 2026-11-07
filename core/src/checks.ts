// Quality checks (clip, loudness, dc, click, tail). Each has a score from 0 to 1, a threshold from
// the project's style, and the exact time ranges it flags. A sound passes when every check passes;
// `work done` on a request refuses while a check fails.

import { SAMPLE_RATE } from './sound.ts';
import { stft, type Analysis, type Samples } from './analysis.ts';

/** The numbers the checks are held to. A project overrides them in project.json under `style`. */
export interface Style {
  /** Integrated loudness target for sounds, LUFS, and how far off is allowed (LU). */
  loudnessTarget: number;
  loudnessTolerance: number;
  /** True peak limit, dBTP. */
  truePeakMax: number;
  /** DC offset limit (fraction of full scale). */
  dcMax: number;
  /** Largest level at the first or last sample (fraction of full scale) before it counts as a click. */
  clickMax: number;
  /** Longest leading or trailing silence, seconds. */
  silenceMax: number;
  /** The last samples must be this far below the peak, dB, for the sound to count as finished rather than cut. */
  tailFloorDb: number;
  /** The 2-5 kHz band's level (dBFS, RMS of the band) above which a stretch of the sound counts as harsh... */
  harshLimitDb: number;
  /** ...when it lasts at least this long (ms). */
  harshMinMs: number;
}

export const DEFAULT_STYLE: Style = {
  loudnessTarget: -16,
  loudnessTolerance: 1,
  truePeakMax: -0.1,
  dcMax: 0.005,
  clickMax: 0.02,
  silenceMax: 0.05,
  tailFloorDb: -60,
  harshLimitDb: -20,
  harshMinMs: 80,
};

/** The style keys and what they mean (for docs and errors). */
export const STYLE_KEYS = Object.keys(DEFAULT_STYLE) as (keyof Style)[];

/** A style from project.json's `style` object: unknown keys and non-numbers are an error. */
export function resolveStyle(given: unknown): Style {
  const style = { ...DEFAULT_STYLE };
  if (given === undefined || given === null) return style;
  if (typeof given !== 'object' || Array.isArray(given)) throw new Error('style must be an object');
  for (const [k, v] of Object.entries(given as Record<string, unknown>)) {
    if (!STYLE_KEYS.includes(k as keyof Style)) throw new Error(`style: unknown key '${k}' (keys: ${STYLE_KEYS.join(', ')})`);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`style.${k} must be a number`);
    style[k as keyof Style] = v;
  }
  return style;
}

export type CheckName = 'clip' | 'loudness' | 'dc' | 'click' | 'tail' | 'harsh';
export const CHECK_NAMES: readonly CheckName[] = ['clip', 'loudness', 'dc', 'click', 'tail', 'harsh'];

export interface CheckRange {
  /** Seconds. */
  from: number;
  to: number;
  note: string;
}

export interface CheckResult {
  name: CheckName;
  pass: boolean;
  /** 1 passes with room; 0 is far off. */
  score: number;
  /** What was measured, as text. */
  value: string;
  /** What it is held to, as text. */
  threshold: string;
  ranges: CheckRange[];
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : v > 0 ? 'inf' : '-inf');
const sec = (n: number): number => Math.round((n / SAMPLE_RATE) * 10000) / 10000;

/** Runs of samples at or above full scale (in any channel), merged when within 1 ms, as time ranges. */
function fullScaleRanges(x: Samples): CheckRange[] {
  const out: CheckRange[] = [];
  let start = -1, last = -1;
  const flush = (): void => {
    if (start >= 0) out.push({ from: sec(start), to: sec(last + 1), note: 'samples at full scale' });
    start = -1;
  };
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]!) >= 0.9999) {
      if (start >= 0 && i - last > 44) flush();
      if (start < 0) start = i;
      last = i;
    }
  }
  flush();
  return out;
}

const HARSH_LO = 2000;
const HARSH_HI = 5000;

/** The 2-5 kHz band's level per STFT frame (dBFS RMS of the band content: a full-scale sine reads -3). */
export function harshBand(x: Samples): { times: Float64Array; db: Float64Array } {
  const s = stft(x, 1024, 256);
  const lo = Math.ceil((HARSH_LO * s.size) / SAMPLE_RATE);
  const hi = Math.floor((HARSH_HI * s.size) / SAMPLE_RATE);
  const db = new Float64Array(s.mags.length);
  s.mags.forEach((m, f) => {
    let e = 0;
    for (let k = lo; k <= hi; k++) e += m[k]! * m[k]!;
    // amplitude-normalised Hann magnitudes: a sine's energy spreads over 1.5 bins of 2x amplitude squared
    const ms = e / 3;
    db[f] = ms > 1e-12 ? (10 * Math.log(ms)) / Math.LN10 : -120;
  });
  return { times: s.times, db };
}

export function runChecks(input: Samples | readonly Samples[], a: Analysis, style: Style = DEFAULT_STYLE): CheckResult[] {
  const chs = Array.isArray(input) ? (input as readonly Samples[]) : [input as Samples];
  let x: Samples = chs[0]!;
  let mix: Samples = chs[0]!;
  if (chs.length > 1) {
    const lvl = new Float32Array(x.length);
    const avg = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      let big = 0, sum = 0;
      for (const c of chs) { big = Math.max(big, Math.abs(c[i]!)); sum += c[i]!; }
      lvl[i] = big;
      avg[i] = sum / chs.length;
    }
    x = lvl;
    mix = avg;
  }
  const out: CheckResult[] = [];
  const d = a.duration;

  // clip
  {
    const all = fullScaleRanges(x);
    const ranges = all.slice(0, 12);
    const over = a.truePeakDb - style.truePeakMax;
    const pass = !a.silent && over <= 0 && !ranges.length;
    if (!pass && !ranges.length && !a.silent) {
      let at = 0;
      for (let i = 0; i < x.length; i++) if (Math.abs(x[i]!) >= a.peak) { at = i; break; }
      ranges.push({ from: sec(Math.max(0, at - 44)), to: sec(Math.min(x.length, at + 44)), note: `true peak ${f1(a.truePeakDb)} dBTP` });
    }
    out.push({
      name: 'clip', pass: pass || a.silent, score: a.silent ? 1 : clamp01(1 - Math.max(over, ranges.length ? 0.5 : 0) / 3),
      value: `true peak ${f1(a.truePeakDb)} dBTP${all.length ? `, ${all.length} run${all.length === 1 ? '' : 's'} at full scale${all.length > ranges.length ? ` (the first ${ranges.length} are listed)` : ''}` : ''}`, threshold: `at most ${f1(style.truePeakMax)} dBTP, no samples at full scale`, ranges: a.silent ? [] : ranges,
    });
  }

  // loudness
  {
    const diff = a.lufs - style.loudnessTarget;
    const off = Math.abs(diff) - style.loudnessTolerance;
    const pass = Number.isFinite(a.lufs) && off <= 0;
    out.push({
      name: 'loudness', pass, score: Number.isFinite(a.lufs) ? clamp01(1 - Math.max(0, off) / 6) : 0,
      value: Number.isFinite(a.lufs) ? `${f1(a.lufs)} LUFS${pass ? '' : ` (${f1(Math.abs(diff))} LU too ${diff < 0 ? 'quiet' : 'loud'})`}` : 'silent',
      threshold: `${f1(style.loudnessTarget)} LUFS ±${style.loudnessTolerance}`, ranges: [],
    });
  }

  // dc
  {
    const over = Math.abs(a.dc) - style.dcMax;
    out.push({
      name: 'dc', pass: over <= 0, score: clamp01(1 - Math.max(0, over) / (style.dcMax * 4)),
      value: `${(a.dc * 100).toFixed(2)} %`, threshold: `at most ±${(style.dcMax * 100).toFixed(2)} %`,
      ranges: over > 0 ? [{ from: 0, to: sec(x.length), note: 'the whole sound is offset' }] : [],
    });
  }

  // click: a jump at the very start or end
  {
    const start = x.length ? Math.abs(x[0]!) : 0;
    const end = x.length ? Math.abs(x[x.length - 1]!) : 0;
    // (for two channels x holds the larger of the two at each sample, so these are the larger channel's levels)
    const ranges: CheckRange[] = [];
    if (start > style.clickMax) ranges.push({ from: 0, to: 0.001, note: `starts at level ${start.toFixed(3)}` });
    if (end > style.clickMax) ranges.push({ from: Math.round(Math.max(0, d - 0.001) * 10000) / 10000, to: Math.round(d * 10000) / 10000, note: `ends at level ${end.toFixed(3)}` });
    const worst = Math.max(start, end);
    out.push({
      name: 'click', pass: !ranges.length, score: clamp01(1 - Math.max(0, worst - style.clickMax) / 0.2),
      value: `start ${start.toFixed(3)}, end ${end.toFixed(3)}`, threshold: `at most ${style.clickMax} at the first and last sample`, ranges,
    });
  }

  // tail: silence padding, and a tail cut before it died away
  {
    const ranges: CheckRange[] = [];
    let penalty = 0;
    if (!a.silent) {
      if (a.leadingSilence > style.silenceMax) {
        ranges.push({ from: 0, to: Math.round(a.leadingSilence * 10000) / 10000, note: `${Math.round(a.leadingSilence * 1000)} ms of silence at the start` });
        penalty += a.leadingSilence / 0.5;
      }
      if (a.trailingSilence > style.silenceMax) {
        ranges.push({ from: Math.round((d - a.trailingSilence) * 10000) / 10000, to: Math.round(d * 10000) / 10000, note: `${Math.round(a.trailingSilence * 1000)} ms of silence at the end` });
        penalty += a.trailingSilence / 0.5;
      }
      if (a.endLevelDb > style.tailFloorDb) {
        ranges.push({ from: Math.round(Math.max(0, d - 0.001) * 10000) / 10000, to: Math.round(d * 10000) / 10000, note: `cut at ${f1(a.endLevelDb)} dB below the peak` });
        penalty += 0.5;
      }
    }
    out.push({
      name: 'tail', pass: !ranges.length, score: clamp01(1 - penalty),
      value: a.silent ? 'silent' : `silence ${Math.round(a.leadingSilence * 1000)} ms before, ${Math.round(a.trailingSilence * 1000)} ms after; ends ${Number.isFinite(a.endLevelDb) ? `${f1(a.endLevelDb)} dB re peak` : 'at zero'}`,
      threshold: `silence at most ${Math.round(style.silenceMax * 1000)} ms; ends below ${f1(style.tailFloorDb)} dB re peak`, ranges,
    });
  }
  // harsh: sustained 2-5 kHz energy
  {
    const { times, db } = harshBand(mix);
    const frames = db.length;
    const hopMs = (256 / SAMPLE_RATE) * 1000;
    const need = Math.max(1, Math.ceil(style.harshMinMs / hopMs));
    // the level that holds for at least harshMinMs: the best (over time) of the least level in a window of `need` frames
    let sustained = -120;
    for (let f = 0; f + need <= frames; f++) {
      let lo = Infinity;
      for (let k = f; k < f + need; k++) lo = Math.min(lo, db[k]!);
      if (lo > sustained) sustained = lo;
    }
    const ranges: CheckRange[] = [];
    let start = -1;
    for (let f = 0; f <= frames; f++) {
      const over = f < frames && db[f]! > style.harshLimitDb;
      if (over && start < 0) start = f;
      if (!over && start >= 0) {
        if (f - start >= need) ranges.push({ from: Math.round(Math.max(0, times[start]! - 512 / SAMPLE_RATE) * 10000) / 10000, to: Math.round(Math.min(d, times[f - 1]! + 512 / SAMPLE_RATE) * 10000) / 10000, note: `2-5 kHz band above ${f1(style.harshLimitDb)} dBFS for ${Math.round((f - start) * hopMs)} ms` });
        start = -1;
      }
    }
    const over = sustained - style.harshLimitDb;
    out.push({
      name: 'harsh', pass: !ranges.length && over <= 0, score: clamp01(1 - Math.max(0, over) / 12),
      value: `sustained 2-5 kHz band ${f1(sustained)} dBFS${ranges.length ? `, ${ranges.length} stretch${ranges.length === 1 ? '' : 'es'} over` : ''}`,
      threshold: `at most ${f1(style.harshLimitDb)} dBFS for ${Math.round(style.harshMinMs)} ms`, ranges: ranges.slice(0, 12),
    });
  }
  return out;
}

export const checksPass = (r: readonly CheckResult[]): boolean => r.every((c) => c.pass);

/** One line that ends every render result: `checks: 4/5 pass; failing: loudness -22.4 LUFS (6.4 LU too quiet)`. */
export function checkSummary(r: readonly CheckResult[]): string {
  const bad = r.filter((c) => !c.pass);
  const n = r.length - bad.length;
  return bad.length ? `checks: ${n}/${r.length} pass; failing: ${bad.map((c) => `${c.name} ${c.value}`).join('; ')}` : `checks: ${n}/${r.length} pass`;
}

/** The checks of one sound, one per line, with scores, thresholds and the exact places flagged. */
export function formatChecks(id: string, r: readonly CheckResult[]): string {
  const lines = [`${id}: ${checksPass(r) ? 'PASS' : 'FAIL'} (${r.filter((c) => c.pass).length}/${r.length} checks pass)`];
  for (const c of r) {
    lines.push(`  ${c.name.padEnd(8)} ${c.pass ? 'pass' : 'FAIL'}  score ${c.score.toFixed(2)}  ${c.value}; held to ${c.threshold}`);
    for (const g of c.ranges) lines.push(`    flagged ${g.from.toFixed(4)}-${g.to.toFixed(4)} s: ${g.note}`);
  }
  return lines.join('\n');
}
