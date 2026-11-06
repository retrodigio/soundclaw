// Quality checks (clip, loudness, dc, click, tail). Each has a score from 0 to 1, a threshold from
// the project's style, and the exact time ranges it flags. A sound passes when every check passes;
// `work done` on a request refuses while a check fails.

import { SAMPLE_RATE } from './sound.ts';
import type { Analysis, Samples } from './analysis.ts';

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
}

export const DEFAULT_STYLE: Style = {
  loudnessTarget: -16,
  loudnessTolerance: 1,
  truePeakMax: -0.1,
  dcMax: 0.005,
  clickMax: 0.02,
  silenceMax: 0.05,
  tailFloorDb: -60,
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

export type CheckName = 'clip' | 'loudness' | 'dc' | 'click' | 'tail';
export const CHECK_NAMES: readonly CheckName[] = ['clip', 'loudness', 'dc', 'click', 'tail'];

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

/** Runs of samples at or above full scale, merged when within 1 ms, as time ranges. */
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

export function runChecks(x: Samples, a: Analysis, style: Style = DEFAULT_STYLE): CheckResult[] {
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
