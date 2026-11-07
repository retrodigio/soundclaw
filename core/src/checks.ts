// Quality checks (clip, loudness, dc, click, tail). Each has a score from 0 to 1, a threshold from
// the project's style, and the exact time ranges it flags. A sound passes when every check passes;
// `work done` on a request refuses while a check fails.

import { SAMPLE_RATE } from './sound.ts';
import { stft, type Analysis, type Samples } from './analysis.ts';

/** A loudness class: the target a sound of this kind is held to (LUFS) and how far off is allowed (LU). */
export interface LoudnessClass {
  target: number;
  tolerance: number;
}

/**
 * The classes a project starts with (project.json `style.loudnessClasses` adds to or replaces them). A game's sounds are
 * not all equally loud: a UI tick sits far under an explosion, so one target for every sound is wrong. `standard` is the
 * style's own loudnessTarget and loudnessTolerance (the class of a sound that names none, while defaultClass is `standard`).
 */
export const DEFAULT_CLASSES: Readonly<Record<string, LoudnessClass>> = {
  ui: { target: -28, tolerance: 3 },
  foley: { target: -22, tolerance: 2 },
  impact: { target: -14, tolerance: 2 },
  ambience: { target: -26, tolerance: 3 },
  voice: { target: -20, tolerance: 2 },
  'music-sting': { target: -16, tolerance: 2 },
  music: { target: -16, tolerance: 2 },
  stinger: { target: -14, tolerance: 2 },
};

export const CLASS_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** The numbers the checks are held to. A project overrides them in project.json under `style`. */
export interface Style {
  /** Integrated loudness target of the `standard` class, LUFS, and how far off is allowed (LU). */
  loudnessTarget: number;
  loudnessTolerance: number;
  /** The named loudness classes (ui, foley, impact, ...) with their targets and tolerances; `standard` is loudnessTarget/Tolerance. */
  loudnessClasses: Record<string, LoudnessClass>;
  /** The class of a sound that has none (and whose set has none). */
  defaultClass: string;
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
  /** Set-spread: members of a set must be at least this far apart (mean absolute difference of their mel spectrograms, dB)... */
  setSpreadMin: number;
  /** ...and at most this far apart. */
  setSpreadMax: number;
  /** A loop's seam: the level of the last 50 ms may differ from the first 50 ms by at most this much (dB). */
  seamStepMaxDb: number;
}

export const DEFAULT_STYLE: Style = {
  loudnessTarget: -16,
  loudnessTolerance: 1,
  loudnessClasses: { ...DEFAULT_CLASSES },
  defaultClass: 'standard',
  truePeakMax: -0.1,
  dcMax: 0.005,
  clickMax: 0.02,
  silenceMax: 0.05,
  tailFloorDb: -60,
  harshLimitDb: -20,
  harshMinMs: 80,
  setSpreadMin: 1,
  setSpreadMax: 20,
  seamStepMaxDb: 3,
};

/** The style keys and what they mean (for docs and errors). */
export const STYLE_KEYS = Object.keys(DEFAULT_STYLE) as (keyof Style)[];

/** Every loudness class of a style, `standard` included. */
export function classTable(style: Style): Record<string, LoudnessClass> {
  return { standard: { target: style.loudnessTarget, tolerance: style.loudnessTolerance }, ...style.loudnessClasses };
}

/** A style from project.json's `style` object: unknown keys and wrong types are an error. */
export function resolveStyle(given: unknown): Style {
  const style: Style = { ...DEFAULT_STYLE, loudnessClasses: { ...DEFAULT_CLASSES } };
  if (given === undefined || given === null) return style;
  if (typeof given !== 'object' || Array.isArray(given)) throw new Error('style must be an object');
  for (const [k, v] of Object.entries(given as Record<string, unknown>)) {
    if (!STYLE_KEYS.includes(k as keyof Style)) throw new Error(`style: unknown key '${k}' (keys: ${STYLE_KEYS.join(', ')})`);
    if (k === 'defaultClass') {
      if (typeof v !== 'string') throw new Error('style.defaultClass must be a class name');
      style.defaultClass = v;
    } else if (k === 'loudnessClasses') {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('style.loudnessClasses must be an object of { "<name>": { "target": <LUFS>, "tolerance": <LU> } }');
      for (const [name, c] of Object.entries(v as Record<string, unknown>)) {
        if (!CLASS_NAME_RE.test(name)) throw new Error(`style.loudnessClasses: '${name}' is not a class name (a-z, 0-9 and -, starting with a letter)`);
        const o = c as { target?: unknown; tolerance?: unknown } | null;
        if (typeof c !== 'object' || c === null || typeof o!.target !== 'number' || !Number.isFinite(o!.target) || (o!.tolerance !== undefined && (typeof o!.tolerance !== 'number' || !(o!.tolerance >= 0)))) {
          throw new Error(`style.loudnessClasses.${name} must be { "target": <LUFS>, "tolerance": <LU, default 1> }`);
        }
        if (o!.target < -70 || o!.target > 0) throw new Error(`style.loudnessClasses.${name}: the target is LUFS from -70 to 0`);
        style.loudnessClasses[name] = { target: o!.target, tolerance: (o!.tolerance as number | undefined) ?? 1 };
      }
    } else {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`style.${k} must be a number`);
      (style as unknown as Record<string, number>)[k] = v;
    }
  }
  if (!classTable(style)[style.defaultClass]) throw new Error(`style.defaultClass '${style.defaultClass}' is not a class (classes: ${Object.keys(classTable(style)).join(', ')})`);
  return style;
}

export type CheckName = 'clip' | 'loudness' | 'dc' | 'click' | 'tail' | 'harsh' | 'set-spread';
/** The checks of one sound (set-spread is the checks of a set of sounds). */
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
function fullScaleRanges(x: Samples, level = 0.9999): CheckRange[] {
  const out: CheckRange[] = [];
  let start = -1, last = -1;
  const flush = (): void => {
    if (start >= 0) out.push({ from: sec(start), to: sec(last + 1), note: 'samples at full scale' });
    start = -1;
  };
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]!) >= level) {
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

/** What a loop's seam looks like: the jump between the last and the first sample, the local step it is compared with, and the level step over 50 ms. */
export function seamNumbers(x: Samples): { jump: number; local: number; stepDb: number } {
  const n = x.length;
  if (n < 4) return { jump: 0, local: 0, stepDb: 0 };
  const jump = Math.abs(x[0]! - x[n - 1]!);
  const w = Math.min(Math.floor(n / 2) - 1, 220);
  let sq = 0, cnt = 0;
  for (let i = 0; i < w; i++) {
    const d1 = x[i + 1]! - x[i]!;
    const d2 = x[n - 1 - i]! - x[n - 2 - i]!;
    sq += d1 * d1 + d2 * d2;
    cnt += 2;
  }
  const win = Math.min(Math.floor(n / 2), Math.round(0.05 * SAMPLE_RATE));
  let a = 0, b = 0;
  for (let i = 0; i < win; i++) { a += x[i]! * x[i]!; b += x[n - 1 - i]! * x[n - 1 - i]!; }
  const stepDb = a > 1e-12 && b > 1e-12 ? 10 * Math.log10(a / b) : a > 1e-12 || b > 1e-12 ? 60 : 0;
  return { jump, local: Math.sqrt(sq / Math.max(1, cnt)), stepDb };
}

/** A level step in dB for printing: one decimal, never "-0.0". */
export const fmtStep = (v: number): string => (Number(v.toFixed(1)) + 0).toFixed(1);

/** How much louder than a plain click a seam jump has to be to count: it must exceed this many times the local sample-to-sample step. */
export const SEAM_STEP_FACTOR = 4;

/** An exponential decay that reaches -60 dB at its end counts as finished: the cut-off rule has this much slack (dB). */
export const TAIL_SLACK_DB = 1;

export interface CheckOptions {
  /** Which loudness rule applied, as words (`class ui`, `class ui; own loudness`), named in the result. */
  loudnessClass?: string;
  /** The sound is a loop: the click check looks at the seam, and the tail check does not ask for a fade-out. */
  loop?: boolean;
  /** The level that counts as full scale for the clip check's runs (default 0.9999; the classic voice's, measured as exported, is a little lower: see `fullScaleOf`). */
  fullScale?: number;
}

export function runChecks(input: Samples | readonly Samples[], a: Analysis, style: Style = DEFAULT_STYLE, o: CheckOptions = {}): CheckResult[] {
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
    const all = fullScaleRanges(x, o.fullScale);
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
      threshold: `${f1(style.loudnessTarget)} LUFS ±${style.loudnessTolerance} (${o.loudnessClass ?? 'class standard'})`, ranges: [],
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

  // click: a jump at the very start or end (a loop: at the seam, where its end runs into its start)
  if (o.loop && !a.silent) {
    const per = chs.map((c) => seamNumbers(c));
    const worst = per.reduce((m, p) => (p.jump - SEAM_STEP_FACTOR * p.local > m.jump - SEAM_STEP_FACTOR * m.local ? p : m), per[0]!);
    const step = per.reduce((m, p) => Math.max(m, Math.abs(p.stepDb)), 0);
    const ranges: CheckRange[] = [];
    const jumpBad = worst.jump > style.clickMax && worst.jump > SEAM_STEP_FACTOR * worst.local;
    if (jumpBad) ranges.push({ from: Math.round(Math.max(0, d - 0.001) * 10000) / 10000, to: Math.round(d * 10000) / 10000, note: `the seam jumps by ${worst.jump.toFixed(3)} (the local step is ${worst.local.toFixed(3)})` });
    if (step > style.seamStepMaxDb) ranges.push({ from: Math.round(Math.max(0, d - 0.05) * 10000) / 10000, to: Math.round(d * 10000) / 10000, note: `the level steps by ${step.toFixed(1)} dB between the last and the first 50 ms` });
    out.push({
      name: 'click', pass: !ranges.length,
      score: clamp01(1 - Math.max(jumpBad ? Math.min(1, worst.jump / Math.max(1e-9, SEAM_STEP_FACTOR * worst.local)) / 2 : 0, Math.max(0, step - style.seamStepMaxDb) / 12)),
      value: `loop seam: jump ${worst.jump.toFixed(3)} (local step ${worst.local.toFixed(3)}), level step ${step.toFixed(1)} dB`,
      threshold: `seam jump at most ${style.clickMax} or ${SEAM_STEP_FACTOR}× the local step; level step at most ${style.seamStepMaxDb} dB`, ranges,
    });
  } else {
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

  // tail: silence padding, and a tail cut before it died away (a loop has no tail: it runs on into its start)
  if (o.loop) {
    out.push({
      name: 'tail', pass: !a.silent, score: a.silent ? 0 : 1,
      value: a.silent ? 'silent' : 'a loop: it runs on into its start', threshold: 'a loop needs no fade-out', ranges: a.silent ? [{ from: 0, to: Math.round(d * 10000) / 10000, note: 'the loop is silent' }] : [],
    });
  } else {
    const ranges: CheckRange[] = [];
    let penalty = 0;
    if (!a.silent) {
      if (a.leadingSilence > style.silenceMax) {
        ranges.push({ from: 0, to: Math.round(a.leadingSilence * 10000) / 10000, note: `${Math.round(a.leadingSilence * 1000)} ms of silence at the start` });
        penalty += a.leadingSilence / 0.5;
      }
      if (a.trailingSilence > style.silenceMax) {
        ranges.push({ from: Math.round((d - a.trailingSilence) * 10000) / 10000, to: Math.round(d * 10000) / 10000, note: `${Math.round(a.trailingSilence * 1000)} ms of silence at the end (under -60 dB; duration=auto ends the sound where it falls below that, or shorten the layers' dur)` });
        penalty += a.trailingSilence / 0.5;
      }
      if (a.endLevelDb > style.tailFloorDb + TAIL_SLACK_DB) {
        ranges.push({ from: Math.round(Math.max(0, d - 0.001) * 10000) / 10000, to: Math.round(d * 10000) / 10000, note: `cut at ${f1(a.endLevelDb)} dB below the peak (end the amplitude envelope at 0, or lengthen the sound)` });
        penalty += 0.5;
      }
    }
    out.push({
      name: 'tail', pass: !ranges.length, score: clamp01(1 - penalty),
      value: a.silent ? 'silent' : `silence ${Math.round(a.leadingSilence * 1000)} ms before, ${Math.round(a.trailingSilence * 1000)} ms after; ends ${Number.isFinite(a.endLevelDb) ? `${f1(a.endLevelDb)} dB re peak` : 'at zero'}`,
      threshold: `silence at most ${Math.round(style.silenceMax * 1000)} ms; ends below ${f1(style.tailFloorDb)} dB re peak (+${TAIL_SLACK_DB} dB slack, so a decay that reaches -60 dB at its end passes)`, ranges,
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

/**
 * When two failing checks pull against each other, the rule that binds: fix this one first, then the other follows. Fixing them in the
 * wrong order undoes itself (raise the gain to pass loudness and harsh gets worse; lower it for harsh and loudness fails).
 */
export function bindingRules(r: readonly CheckResult[]): string[] {
  const failing = (n: CheckName): CheckResult | undefined => r.find((c) => c.name === n && !c.pass);
  const loudness = failing('loudness');
  const tooQuiet = !!loudness && /too quiet/.test(loudness.value);
  const out: string[] = [];
  if (failing('harsh') && tooQuiet) out.push('harsh and loudness pull against each other (louder is harsher): lower the 2-5 kHz energy first (a low-pass or a lower-gain bright layer), then raise gain');
  if (failing('clip') && tooQuiet) out.push('clip and loudness pull against each other (the peak is at the limit and the sound is still too quiet): shave the peaks first (fx add compress or limit on the master chain, or a softer transient), then raise gain');
  return out;
}

/** The checks of one sound, one per line, with scores, thresholds and the exact places flagged. */
export function formatChecks(id: string, r: readonly CheckResult[]): string {
  const lines = [`${id}: ${checksPass(r) ? 'PASS' : 'FAIL'} (${r.filter((c) => c.pass).length}/${r.length} checks pass)`];
  for (const c of r) {
    lines.push(`  ${c.name.padEnd(8)} ${c.pass ? 'pass' : 'FAIL'}  score ${c.score.toFixed(2)}  ${c.value}; held to ${c.threshold}`);
    for (const g of c.ranges) lines.push(`    flagged ${g.from.toFixed(4)}-${g.to.toFixed(4)} s: ${g.note}`);
  }
  for (const b of bindingRules(r)) lines.push(`  binding rule: ${b}`);
  return lines.join('\n');
}
