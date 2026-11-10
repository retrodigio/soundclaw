// Ears for samples: the numbers of a recording (levels, brightness, pitch with its confidence, onsets, tempo,
// silence, clipping, stereo width), loop-point candidates with their seam numbers, advisory checks and a few
// plain words. This MEASURES: it may use Math.* and its numbers are printed rounded; nothing here feeds a render
// (the loop and slice points it finds are written into commands as plain numbers by the caller).
//
// Everything is a pure function over channels (`Float32Array[]`, each at the sample's own rate) and the rate.

import { analyze, fft, hzToMidi, loudnessRange, midiName, noteName, toDb, type Analysis } from './analysis.ts';
import { FORMAT_BYTES, type PcmAudio, type PcmFormat } from './pcm.ts';
import { resample } from './resample.ts';

// ---- reading stored audio ----------------------------------------------------------------------------------

function valueAt(v: DataView, o: number, format: PcmFormat): number {
  switch (format) {
    case 'pcm8': return (v.getUint8(o) - 128) / 128;
    case 'pcm16': return v.getInt16(o, true) / 32768;
    case 'pcm24': return (v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)) / 8388608;
    case 'pcm32': return v.getInt32(o, true) / 2147483648;
    case 'f32': return v.getFloat32(o, true);
  }
}

/** Each channel of stored audio as floats at the sample's own rate (the arithmetic pcm.ts uses). `maxSeconds` cuts a long sample. */
export function pcmChannels(a: PcmAudio, maxSeconds = Infinity): Float32Array[] {
  const v = new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength);
  const frames = Math.min(a.frames, Math.floor(maxSeconds * a.rate));
  const bps = FORMAT_BYTES[a.format];
  const chs = Array.from({ length: a.channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < a.channels; c++) chs[c]![i] = valueAt(v, (i * a.channels + c) * bps, a.format);
  return chs;
}

const mixOf = (chs: readonly Float32Array[]): Float32Array => {
  if (chs.length === 1) return chs[0]!;
  const n = chs[0]!.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (const c of chs) s += c[i]!; out[i] = s / chs.length; }
  return out;
};

// ---- thresholds (advisory; printed with the checks) -------------------------------------------------------------

/** A seam whose jump is more than this many dB over the signal's own sample-to-sample change clicks. */
export const LOOP_CLICK_OK = 12;
/** A level step across the seam (dB) over this is heard. */
export const LOOP_LEVEL_OK = 3;
/** A spectral jump (0 same … 1 very different) over this is heard. */
export const LOOP_SPECTRAL_OK = 0.3;
/** Silence at an end, ms, over which `sample check` warns. */
export const SILENCE_WARN_MS = 20;
/** A noise floor above this (dBFS) is warned about. */
export const NOISE_FLOOR_WARN_DB = -60;
/** A DC offset over this (fraction of full scale) is warned about. */
export const DC_WARN = 0.01;
/** A slice point further than this (ms) from the nearest onset is "off a transient". */
export const SLICE_OFF_MS = 15;
/** Pitch confidence and harmonic-to-noise ratio above which a sample counts as pitched. */
export const PITCHED_CONFIDENCE = 0.8;
export const PITCHED_HNR_DB = 6;

// ---- onsets -------------------------------------------------------------------------------------------------

export interface OnsetOptions {
  /** 0 (only big jumps) … 1 (small rises count); default 0.5 (a 10 dB rise in 4 ms). */
  sensitivity?: number;
  /** Seconds between two onsets at least; default 0.05. */
  minGap?: number;
}

/**
 * Times (s) where the sound starts: an energy rise over 4 ms windows every 2 ms (at least `18 - 16·sensitivity` dB over the previous
 * window, and the window above −55 dB below full scale), refined back to where the attack really begins.
 */
export function findOnsets(x: Float32Array, rate: number, o: OnsetOptions = {}): number[] {
  const sens = Math.min(1, Math.max(0, o.sensitivity ?? 0.5));
  const minGap = o.minGap ?? 0.05;
  const hop = Math.max(1, Math.round(rate * 0.002));
  const win = hop * 2;
  const nFrames = Math.floor(x.length / hop);
  const e = new Float64Array(nFrames);
  let peak = 0;
  for (let k = 0; k < nFrames; k++) {
    let s = 0;
    const a = k * hop;
    for (let i = a; i < Math.min(x.length, a + win); i++) { const v = x[i]!; s += v * v; if (Math.abs(v) > peak) peak = Math.abs(v); }
    e[k] = Math.sqrt(s / win);
  }
  if (peak < 1e-5) return [];
  const thr = 18 - 16 * sens;
  const floor = Math.max(1e-5, peak * Math.pow(10, -45 / 20));
  const out: number[] = [];
  const lock = Math.max(1, Math.round(minGap / (hop / rate)));
  let last = -1e9;
  for (let k = 0; k < nFrames; k++) {
    const cur = e[k]!;
    // the rise is against the quietest of the last 10 ms, so a hit whose first frame is half attack still counts as a rise from what came before
    let prev = e[k - 1] ?? 1e-5;
    for (let j = 2; j <= 5 && k - j >= 0; j++) prev = Math.min(prev, e[k - j]!);
    if (prev < 1e-5) prev = 1e-5;
    if (cur > floor && cur > (e[k - 1] ?? 0) && 20 * Math.log10((cur + 1e-9) / (prev + 1e-9)) >= thr && k - last >= lock) {
      // refine: the first sample in the neighbourhood that reaches a fraction of the local peak
      const a = Math.max(0, (k - 2) * hop);
      const b = Math.min(x.length, (k + 1) * hop + win);
      let p = 0;
      for (let i = a; i < b; i++) p = Math.max(p, Math.abs(x[i]!));
      let at = a;
      while (at < b && Math.abs(x[at]!) < p * 0.2) at++;
      out.push(at / rate);
      last = k;
    }
  }
  return out;
}

/** A tempo (bpm, 60-180) from the spacing of onsets, or null when the spacing is not steady enough. */
export function estimateTempo(onsets: readonly number[]): number | null {
  if (onsets.length < 4) return null;
  const gaps: number[] = [];
  for (let i = 1; i < onsets.length; i++) gaps.push(onsets[i]! - onsets[i - 1]!);
  const sorted = [...gaps].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)]!;
  if (med <= 0) return null;
  const steady = gaps.filter((g) => Math.abs(g - med) <= 0.1 * med).length / gaps.length;
  if (steady < 0.6) return null;
  let bpm = 60 / med;
  while (bpm < 60) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return bpm;
}

// ---- the measure --------------------------------------------------------------------------------------------

export interface SampleMeasure {
  duration: number;
  rate: number;
  channels: number;
  frames: number;
  /** Sample peak and an oversampled peak, dBFS / dBTP; RMS, dBFS (over all channels). */
  peakDb: number;
  truePeakDb: number;
  rmsDb: number;
  lufs: number;
  /** Loudness range, LU (null for a sample too short to have one). */
  lra: number | null;
  /** Spectral centroid (brightness) over the sample, Hz, and spectral flatness 0 (tonal) … 1 (noise). */
  centroid: number;
  flatness: number;
  /** Seconds to the first sample within −3 dB of the peak, in ms. */
  attackMs: number;
  /** Estimated time to fall 60 dB after the loudest point (twice the time from −5 to −35 dB), s; null when the sound does not fall that far (sustained). */
  decay60: number | null;
  /** RMS of the quietest tenth of 20 ms frames, dBFS (−120 at digital silence). */
  noiseFloorDb: number;
  /** Harmonic-to-noise ratio of the loudest part from its autocorrelation, dB (negative for noise). */
  hnrDb: number;
  pitch: {
    hz: number; note: string; midi: number; cents: number;
    /** How sure the tracker is: the share of voiced frames times their clarity, lowered when the spectrum is inharmonic (a bell, a layered chord of unrelated tones: the strongest partial is not a note). */
    confidence: number;
    /** Spread of the pitch over time, cents. */
    steadiness: number;
    /** Share of the strongest spectral peaks' energy that sits at whole multiples of `hz`, 0 … 1; 1 when there are too few peaks to say. */
    harmonicity: number;
    /** `harmonicity` under 0.6: the pitch is the strongest partial, not a note to build a scale on. */
    inharmonic: boolean;
  } | null;
  /** Confidence ≥ 0.8 and HNR over 6 dB. */
  pitched: boolean;
  onsets: { count: number; times: number[]; perSecond: number };
  /** For loops: bpm from steady onsets, else null. */
  tempo: number | null;
  /** Milliseconds below 50 dB under the peak at the start and at the end. */
  silenceStartMs: number;
  silenceEndMs: number;
  /** Runs of 3 or more samples at full scale (|x| ≥ 0.999), summed over the channels. */
  fullScaleRuns: number;
  /** Mean sample value over the channels (−1 … 1). */
  dc: number;
  /** Side level over mid level, 0 (mono) … 1; 0 for one channel. */
  stereoWidth: number;
  silent: boolean;
}

export interface MeasureOptions {
  /** Measure at most this much (s); default 120. */
  maxSeconds?: number;
}

const rmsDbOf = (x: Float32Array, a: number, b: number): number => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i]! * x[i]!;
  return b > a ? toDb(Math.sqrt(s / (b - a))) : -Infinity;
};

/** The loudest-region harmonic-to-noise ratio (dB) from the normalised autocorrelation at its best lag. */
function hnrOf(x: Float32Array, rate: number): number {
  const N = Math.min(4096, x.length >> 1);
  if (N < 256) return -Infinity;
  // the loudest N frames
  let best = 0, bestE = -1;
  const step = Math.max(256, N >> 1);
  for (let a = 0; a + 2 * N <= x.length; a += step) {
    let e = 0;
    for (let i = a; i < a + N; i++) e += x[i]! * x[i]!;
    if (e > bestE) { bestE = e; best = a; }
  }
  if (bestE <= 0) return -Infinity;
  const maxLag = Math.min(N, Math.floor(rate / 40));
  const minLag = Math.max(2, Math.floor(rate / 4000));
  let r0 = 0;
  for (let i = best; i < best + N; i++) r0 += x[i]! * x[i]!;
  const acf = (lag: number): number => {
    let s = 0, e2 = 0;
    for (let i = best; i < best + N; i++) { const y = x[i + lag]!; s += x[i]! * y; e2 += y * y; }
    return e2 > 0 ? s / Math.sqrt(r0 * e2) : 0;
  };
  // skip the first lobe (until the correlation first falls under 0), then the highest
  let lag = minLag;
  while (lag < maxLag && acf(lag) > 0) lag++;
  let r = 0;
  for (; lag < maxLag; lag++) r = Math.max(r, acf(lag));
  r = Math.min(0.9999, Math.max(0.0001, r));
  return 10 * Math.log10(r / (1 - r));
}

/** Under this a spectrum counts as inharmonic. */
export const INHARMONIC_BELOW = 0.6;

/**
 * How harmonic a spectrum is around a pitch: of the strongest peaks of the loudest stretch (within 40 dB of the biggest, at most 10), the mean of the share of their
 * energy and the share of their number that lie within 0.06 of a whole multiple of `hz` (as a ratio to it: close for the low partials of a tone, tight for the high ones). A harmonic tone is near 1; a bell, whose partials are not
 * whole multiples, is well under 0.6. With fewer than three peaks there is nothing to compare, and it is 1.
 */
export function harmonicityOf(x: Float32Array, rate: number, hz: number): number {
  const N = 1 << Math.max(11, Math.min(14, Math.floor(Math.log2(Math.max(2, x.length)))));
  if (x.length < 2048 || !(hz > 0)) return 1;
  // the loudest stretch of N frames
  let best = 0, bestE = -1;
  const step = Math.max(512, N >> 2);
  for (let a = 0; a + N <= x.length; a += step) {
    let e = 0;
    for (let i = a; i < a + N; i++) e += x[i]! * x[i]!;
    if (e > bestE) { bestE = e; best = a; }
  }
  if (bestE <= 0) return 1;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = (best + i < x.length ? x[best + i]! : 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  fft(re, im);
  const mag = new Float64Array(N / 2);
  let top = 0;
  for (let k = 1; k < N / 2; k++) { mag[k] = Math.hypot(re[k]!, im[k]!); if (mag[k]! > top) top = mag[k]!; }
  const floor = top * 0.01;
  const peaks: { f: number; m: number }[] = [];
  for (let k = 2; k < N / 2 - 1; k++) {
    const m = mag[k]!;
    if (m < floor || m < mag[k - 1]! || m <= mag[k + 1]!) continue;
    const a = mag[k - 1]!, c = mag[k + 1]!;
    const d = a - 2 * m + c;
    const off = d !== 0 ? (0.5 * (a - c)) / d : 0;
    peaks.push({ f: ((k + off) * rate) / N, m });
  }
  peaks.sort((p, q) => q.m - p.m);
  const kept: { f: number; m: number }[] = [];
  for (const p of peaks) {
    if (kept.length >= 10) break;
    if (kept.some((q) => Math.abs(q.f - p.f) < (6 * rate) / N)) continue; // the same partial's skirt
    kept.push(p);
  }
  if (kept.length < 3) return 1;
  let all = 0, fit = 0, nFit = 0;
  for (const p of kept) {
    const e = p.m * p.m;
    all += e;
    const k = Math.round(p.f / hz);
    if (k >= 1 && Math.abs(p.f / hz - k) <= 0.06) { fit += e; nFit++; }
  }
  // (half by energy, half by count: the strongest partial is the one the tracker locked on, so it fits whatever the rest do)
  return all > 0 ? 0.5 * (fit / all) + 0.5 * (nFit / kept.length) : 1;
}

function pitchOf(a: Analysis, x: Float32Array, rate: number): SampleMeasure['pitch'] {
  const frames = a.pitch.track.filter((f) => f.clarity > 0);
  const voiced = frames.filter((f) => f.hz !== null);
  if (!voiced.length) return null;
  const hzs = voiced.map((f) => f.hz!).sort((p, q) => p - q);
  const med = hzs[Math.floor(hzs.length / 2)]!;
  const centsFromMed = voiced.map((f) => 1200 * Math.log2(f.hz! / med)).filter((c) => Math.abs(c) < 600);
  const mean = centsFromMed.reduce((s, c) => s + c, 0) / Math.max(1, centsFromMed.length);
  const steadiness = Math.sqrt(centsFromMed.reduce((s, c) => s + (c - mean) * (c - mean), 0) / Math.max(1, centsFromMed.length));
  const midi = hzToMidi(med);
  const near = Math.round(midi);
  const clarity = voiced.reduce((s, f) => s + f.clarity, 0) / voiced.length;
  const harmonicity = harmonicityOf(x, rate, med);
  const inharmonic = harmonicity < INHARMONIC_BELOW;
  const confidence = (voiced.length / frames.length) * clarity * (inharmonic ? 0.3 + 0.7 * harmonicity : 1);
  return { hz: med, note: midiName(near), midi: near, cents: (midi - near) * 100, confidence, steadiness, harmonicity, inharmonic };
}

/** Everything measurable about a sample. Pure and deterministic; about 0.3 s for 5 s of stereo audio. */
export function measureSample(input: readonly Float32Array[], rate: number, opts: MeasureOptions = {}): SampleMeasure {
  const cap = Math.floor((opts.maxSeconds ?? 120) * rate);
  const chs = input.map((c) => (c.length > cap ? c.subarray(0, cap) : c));
  const frames = chs[0]!.length;
  const x = mixOf(chs);
  const duration = frames / rate;

  let peak = 0, sum = 0, runs = 0;
  for (const c of chs) {
    let run = 0;
    for (let i = 0; i < frames; i++) {
      const v = c[i]!;
      const m = Math.abs(v);
      if (m > peak) peak = m;
      sum += v;
      if (m >= 0.999) { run++; if (run === 3) runs++; } else run = 0;
    }
  }
  const dc = frames ? sum / (frames * chs.length) : 0;
  const silent = peak < 1e-6;

  // the 44,100 Hz view the shared analysis wants (at most two channels, as the sounds' own measuring does)
  const at44 = chs.slice(0, 2).map((c) => resample(c, rate, 44100));
  const a = analyze(at44);
  const mix44 = at44.length === 1 ? at44[0]! : mixOf(at44);

  // noise floor: the quietest tenth of 20 ms frames
  const fl = Math.max(1, Math.round(rate * 0.02));
  const frameRms: number[] = [];
  for (let s = 0; s + fl <= frames; s += fl) frameRms.push(rmsDbOf(x, s, s + fl));
  frameRms.sort((p, q) => p - q);
  const noiseFloorDb = frameRms.length ? Math.max(-120, frameRms[Math.floor((frameRms.length - 1) * 0.1)]!) : toDb(0);

  // silence at each end: below 50 dB under the peak (and never above −45 dBFS)
  const thr = Math.min(peak * Math.pow(10, -50 / 20), Math.pow(10, -45 / 20));
  const level = (i: number): number => { let m = 0; for (const c of chs) m = Math.max(m, Math.abs(c[i]!)); return m; };
  let first = 0;
  while (first < frames && level(first) < thr) first++;
  let last = frames - 1;
  while (last > first && level(last) < thr) last--;
  const silenceStartMs = silent ? duration * 1000 : (first / rate) * 1000;
  const silenceEndMs = silent ? 0 : ((frames - 1 - last) / rate) * 1000;

  // stereo width
  let width = 0;
  if (chs.length >= 2) {
    let mid = 0, side = 0;
    const L = chs[0]!, R = chs[1]!;
    for (let i = 0; i < frames; i++) { const m = (L[i]! + R[i]!) / 2, s = (L[i]! - R[i]!) / 2; mid += m * m; side += s * s; }
    width = mid > 0 ? Math.min(1, Math.sqrt(side / mid)) : side > 0 ? 1 : 0;
  }

  // decay: from the loudest 10 ms frame, twice the time between −5 and −35 dB
  let decay60: number | null = null;
  const df = Math.max(1, Math.round(rate * 0.01));
  const env: number[] = [];
  for (let s = 0; s + df <= frames; s += df) env.push(rmsDbOf(x, s, s + df));
  if (env.length > 3) {
    let p = 0;
    for (let k = 1; k < env.length; k++) if (env[k]! > env[p]!) p = k;
    let k5 = -1, k35 = -1;
    for (let k = p; k < env.length; k++) {
      if (k5 < 0 && env[k]! < env[p]! - 5) k5 = k;
      if (env[k]! < env[p]! - 35) { k35 = k; break; }
    }
    if (k5 >= 0 && k35 >= 0) decay60 = 2 * ((k35 - k5) * df) / rate;
  }

  const times = silent ? [] : findOnsets(x, rate);
  const hnrDb = silent ? -Infinity : hnrOf(mix44, 44100);
  const pitch = silent ? null : pitchOf(a, mix44, 44100);
  const pitched = !!pitch && pitch.confidence >= PITCHED_CONFIDENCE && hnrDb > PITCHED_HNR_DB;
  const lra = duration >= 3 && !a.silent ? loudnessRange(at44) : null;

  return {
    duration, rate, channels: chs.length, frames,
    peakDb: toDb(peak), truePeakDb: a.truePeakDb, rmsDb: a.rmsDb, lufs: a.lufs, lra,
    centroid: a.centroid.mean, flatness: a.flatness, attackMs: a.attack * 1000, decay60,
    noiseFloorDb, hnrDb, pitch, pitched,
    onsets: { count: times.length, times, perSecond: duration > 0 ? times.length / duration : 0 },
    tempo: estimateTempo(times),
    silenceStartMs, silenceEndMs, fullScaleRuns: runs, dc, stereoWidth: width, silent,
  };
}


// ---- loops --------------------------------------------------------------------------------------------------

export interface LoopOptions {
  /** Look near these times (s): the start within ±max(50 ms, 5 % of the length) of the first, the end of the second. */
  near?: [number, number];
  /** The loop is at least this long, s (default 0.1). */
  min?: number;
  /** How many candidates (default 3). */
  top?: number;
}

export interface LoopCandidate {
  /** Frames: the loop plays `start` … `end − 1`, then `start` again. */
  start: number;
  end: number;
  /** Seam numbers. */
  seam: {
    /** The jump at the join over the signal's own sample-to-sample change, dB. */
    clickDb: number;
    /** Level after the seam minus before it (20 ms each), dB. */
    levelStepDb: number;
    /** 0 (same spectrum either side) … 1 (very different). */
    spectralJump: number;
  };
  /** 0 … 1, higher is a better loop. */
  score: number;
}

const BANDS = 24;
/** Log-spaced band levels (dB) of a Hann-windowed 1024 frame starting at `a`. */
function bandLevels(x: Float32Array, a: number, rate: number): Float64Array {
  const N = 1024;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = (x[a + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  fft(re, im);
  const out = new Float64Array(BANDS);
  const fmin = 60, fmax = Math.min(rate / 2, 16000);
  for (let b = 0; b < BANDS; b++) {
    const lo = fmin * Math.pow(fmax / fmin, b / BANDS), hi = fmin * Math.pow(fmax / fmin, (b + 1) / BANDS);
    const k0 = Math.max(1, Math.floor((lo * N) / rate)), k1 = Math.max(k0 + 1, Math.ceil((hi * N) / rate));
    let e = 0;
    for (let k = k0; k < k1 && k < N / 2; k++) e += re[k]! * re[k]! + im[k]! * im[k]!;
    out[b] = 10 * Math.log10(e / (k1 - k0) + 1e-12);
  }
  return out;
}

/** The three seam numbers of a loop `start`…`end` in `x`. */
export function loopSeam(x: Float32Array, rate: number, start: number, end: number): LoopCandidate['seam'] {
  const get = (i: number): number => x[Math.min(x.length - 1, Math.max(0, i))]!;
  // the jump: the first sample after the seam against what the signal's slope before it predicts, over the typical second difference
  const jump = Math.abs(get(start) - (2 * get(end - 1) - get(end - 2)));
  const w = Math.max(8, Math.round(rate * 0.02));
  let d2 = 0, n = 0;
  for (const base of [start, end - w]) for (let i = Math.max(2, base); i < base + w && i < x.length; i++) { const d = x[i]! - 2 * x[i - 1]! + x[i - 2]!; d2 += d * d; n++; }
  const scale = Math.sqrt(d2 / Math.max(1, n));
  const clickDb = 20 * Math.log10((jump + 1e-9) / (scale + 1e-9));
  const levelStepDb = rmsDbOf(x, start, Math.min(x.length, start + w)) - rmsDbOf(x, Math.max(0, end - w), end);
  let spectralJump = 1;
  if (end - 1024 >= 0 && start + 1024 <= x.length) {
    const A = bandLevels(x, end - 1024, rate), B = bandLevels(x, start, rate);
    let d = 0;
    for (let b = 0; b < BANDS; b++) d += Math.abs(A[b]! - B[b]!);
    spectralJump = Math.min(1, d / BANDS / 30);
  }
  return { clickDb, levelStepDb: Number.isFinite(levelStepDb) ? levelStepDb : 0, spectralJump };
}

/**
 * Loop candidates, best first. Starts and ends are positive-going zero crossings; pairs are first ranked by how well the waveform
 * before and after the end matches the waveform before and after the start (so the period is a whole number of cycles), then the
 * best are given their seam numbers and ranked on them.
 */
export function findLoops(x: Float32Array, rate: number, o: LoopOptions = {}): LoopCandidate[] {
  const len = x.length;
  const W = Math.min(1024, Math.max(64, Math.floor(len / 8)));
  const minLen = Math.max(W, Math.round((o.min ?? 0.1) * rate));
  if (len < 2 * W + minLen) return [];
  let sLo = W, sHi = Math.floor(len * 0.5), eLo = Math.floor(len * 0.5), eHi = len - W - 1;
  if (o.near) {
    const slack = Math.round(Math.max(0.05, 0.05 * (len / rate)) * rate);
    const c = (v: number): number => Math.round(v * rate);
    sLo = Math.max(W, c(o.near[0]) - slack); sHi = Math.min(len - 2 * W, c(o.near[0]) + slack);
    eLo = Math.max(sLo + minLen, c(o.near[1]) - slack); eHi = Math.min(len - W - 1, c(o.near[1]) + slack);
  }
  const crossings = (lo: number, hi: number, cap: number): number[] => {
    const all: number[] = [];
    for (let i = Math.max(1, lo); i < hi; i++) if (x[i - 1]! < 0 && x[i]! >= 0) all.push(i);
    if (!all.length) for (let i = lo; i < hi; i += Math.max(1, Math.floor((hi - lo) / cap))) all.push(i);
    if (all.length <= cap) return all;
    return Array.from({ length: cap }, (_, k) => all[Math.floor((k * all.length) / cap)]!);
  };
  const starts = crossings(sLo, sHi, 80), ends = crossings(eLo, eHi, 80);
  const pairs: { s: number; e: number; m: number }[] = [];
  for (const s of starts) {
    for (const e of ends) {
      if (e - s < minLen) continue;
      let diff = 0, en = 0;
      for (let j = 0; j < W; j++) {
        const a = x[e - W + j]!, b = x[s - W + j]!, c = x[e + j]!, d = x[s + j]!;
        diff += (a - b) * (a - b) + (c - d) * (c - d);
        en += a * a + b * b + c * c + d * d;
      }
      pairs.push({ s, e, m: en > 0 ? diff / en : 1 });
    }
  }
  pairs.sort((p, q) => p.m - q.m || p.s - q.s || p.e - q.e);
  const out: LoopCandidate[] = [];
  const top = o.top ?? 3;
  for (const p of pairs.slice(0, 16)) {
    const seam = loopSeam(x, rate, p.s, p.e);
    const cost = Math.max(0, seam.clickDb) / LOOP_CLICK_OK + Math.abs(seam.levelStepDb) / LOOP_LEVEL_OK + seam.spectralJump / LOOP_SPECTRAL_OK + 4 * p.m;
    out.push({ start: p.s, end: p.e, seam, score: 1 / (1 + cost) });
  }
  out.sort((p, q) => q.score - p.score || p.start - q.start);
  // distinct candidates: not within 5 ms of one already kept at both ends
  const kept: LoopCandidate[] = [];
  const near = Math.round(rate * 0.005);
  for (const c of out) {
    if (kept.some((k) => Math.abs(k.start - c.start) < near && Math.abs(k.end - c.end) < near)) continue;
    kept.push(c);
    if (kept.length >= top) break;
  }
  return kept;
}

// ---- checks -------------------------------------------------------------------------------------------------

export interface SampleCheck {
  name: string;
  ok: boolean;
  severity: 'warn' | 'info';
  message: string;
  value?: number;
}

export interface CheckEntry {
  loop?: [number, number];
  slices?: number[];
  frames: number;
  rate: number;
}

/** Advisory checks of a sample as material (a sound's own checks gate work; these never do). */
export function checkSample(m: SampleMeasure, entry: CheckEntry, chs: readonly Float32Array[]): SampleCheck[] {
  const out: SampleCheck[] = [];
  const f1 = (v: number): string => v.toFixed(1);
  out.push(m.fullScaleRuns > 0
    ? { name: 'clipping', ok: false, severity: 'warn', message: `${m.fullScaleRuns} run${m.fullScaleRuns === 1 ? '' : 's'} of 3 or more samples at full scale in the source (peak ${f1(m.peakDb)} dBFS): the recording was clipped`, value: m.fullScaleRuns }
    : { name: 'clipping', ok: true, severity: 'warn', message: `no runs at full scale (peak ${f1(m.peakDb)} dBFS)`, value: 0 });
  out.push(Math.abs(m.dc) > DC_WARN
    ? { name: 'dc', ok: false, severity: 'warn', message: `dc offset ${(m.dc * 100).toFixed(2)} % of full scale (over ${DC_WARN * 100} %): a 10 Hz high-pass (derive op "dc") removes it`, value: m.dc }
    : { name: 'dc', ok: true, severity: 'warn', message: `dc offset ${(m.dc * 100).toFixed(3)} %`, value: m.dc });
  const sil = Math.max(m.silenceStartMs, m.silenceEndMs);
  out.push(sil > SILENCE_WARN_MS && !m.silent
    ? { name: 'silence', ok: false, severity: 'warn', message: `${Math.round(m.silenceStartMs)} ms of silence at the start and ${Math.round(m.silenceEndMs)} ms at the end (over ${SILENCE_WARN_MS} ms at an end): derive op "silence-trim <dB>" cuts it`, value: sil }
    : { name: 'silence', ok: true, severity: 'warn', message: `${Math.round(m.silenceStartMs)} ms of silence at the start, ${Math.round(m.silenceEndMs)} ms at the end`, value: sil });
  out.push(m.noiseFloorDb > NOISE_FLOOR_WARN_DB
    ? { name: 'noise-floor', ok: false, severity: 'warn', message: `noise floor ${f1(m.noiseFloorDb)} dBFS (over ${NOISE_FLOOR_WARN_DB}): the quietest part is not quiet`, value: m.noiseFloorDb }
    : { name: 'noise-floor', ok: true, severity: 'warn', message: `noise floor ${f1(m.noiseFloorDb)} dBFS`, value: m.noiseFloorDb });
  if (entry.loop) {
    const x = mixOf(chs);
    const [s, e] = entry.loop;
    const sm = loopSeam(x, entry.rate, s, e);
    const bad: string[] = [];
    if (sm.clickDb > LOOP_CLICK_OK) bad.push(`a click (${f1(sm.clickDb)} dB over the signal's own change; ok up to ${LOOP_CLICK_OK})`);
    if (Math.abs(sm.levelStepDb) > LOOP_LEVEL_OK) bad.push(`a level step of ${f1(sm.levelStepDb)} dB (ok up to ${LOOP_LEVEL_OK})`);
    if (sm.spectralJump > LOOP_SPECTRAL_OK) bad.push(`a spectral jump of ${sm.spectralJump.toFixed(2)} (ok up to ${LOOP_SPECTRAL_OK})`);
    out.push(bad.length
      ? { name: 'loop-seam', ok: false, severity: 'warn', message: `loop ${s}-${e} has ${bad.join(', ')}: sample loop find looks for a better one`, value: sm.clickDb }
      : { name: 'loop-seam', ok: true, severity: 'warn', message: `loop ${s}-${e} seam: click ${f1(sm.clickDb)} dB, level step ${f1(sm.levelStepDb)} dB, spectral jump ${sm.spectralJump.toFixed(2)}`, value: sm.clickDb });
  }
  if (entry.slices?.length) {
    const ons = m.onsets.times;
    const off = entry.slices.filter((f) => {
      const t = f / entry.rate;
      return !ons.some((o) => Math.abs(o - t) * 1000 <= SLICE_OFF_MS);
    });
    out.push(off.length
      ? { name: 'slices', ok: false, severity: 'info', message: `${off.length} of ${entry.slices.length} slice points are more than ${SLICE_OFF_MS} ms from a transient (at ${off.slice(0, 5).map((f) => (f / entry.rate).toFixed(3)).join(', ')} s)`, value: off.length }
      : { name: 'slices', ok: true, severity: 'info', message: `all ${entry.slices.length} slice points are on a transient`, value: 0 });
  }
  return out;
}

// ---- words --------------------------------------------------------------------------------------------------

const hzText = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);
const secText = (v: number): string => (v < 0.1 ? `${(v * 1000).toFixed(0)} ms` : `${v.toFixed(2)} s`);

/** The measurements in plain words (never opinions). */
export function describeSample(m: SampleMeasure): string[] {
  if (m.silent) return [`${secText(m.duration)} of silence.`];
  const lines: string[] = [];
  lines.push(`${secText(m.duration)}, ${m.rate} Hz, ${m.channels === 1 ? 'mono' : m.channels === 2 ? 'stereo' : `${m.channels} channels`}; peak ${m.peakDb.toFixed(1)} dBFS, ${m.lufs.toFixed(1)} LUFS.`);
  const kind = m.pitched ? 'tonal (pitched)' : m.flatness > 0.3 || m.hnrDb < 0 ? 'noisy' : 'mixed tone and noise';
  lines.push(`${kind}, centroid ${hzText(m.centroid)}, flatness ${m.flatness.toFixed(2)}, harmonic-to-noise ${Number.isFinite(m.hnrDb) ? m.hnrDb.toFixed(1) : '-inf'} dB.`);
  if (m.pitch && (m.pitched || m.pitch.confidence >= 0.5)) {
    const c = Math.round(m.pitch.cents);
    const steady = m.pitch.steadiness < 15 ? 'steady' : m.pitch.steadiness < 50 ? 'wavering' : 'moving';
    lines.push(`pitch ${hzText(m.pitch.hz)} (${m.pitch.note}${c ? ` ${c > 0 ? '+' : ''}${c} cents` : ''}), ${steady} (spread ${Math.round(m.pitch.steadiness)} cents), confidence ${m.pitch.confidence.toFixed(2)}${m.pitch.inharmonic ? '; inharmonic (bell-like): the partials are not whole multiples, so this is the strongest partial and not a note to build on' : ''}.`);
  } else lines.push('no clear pitch.');
  const n = m.onsets.count;
  lines.push(`${n <= 1 ? 'one hit' : `${n} hits (${m.onsets.perSecond.toFixed(1)} per second${m.tempo ? `, about ${Math.round(m.tempo)} bpm` : ''})`}; attack ${m.attackMs < 10 ? m.attackMs.toFixed(1) : Math.round(m.attackMs)} ms.`);
  lines.push(m.decay60 === null ? 'sustained: it does not fall 35 dB.' : `${m.decay60 < 0.3 ? 'dry' : 'roomy'}: falls 60 dB in about ${secText(m.decay60)}.`);
  lines.push(m.channels < 2 ? 'mono.' : m.stereoWidth < 0.05 ? 'two equal channels (mono content).' : `${m.stereoWidth < 0.4 ? 'narrow' : 'wide'} stereo (side over mid ${m.stereoWidth.toFixed(2)}).`);
  return lines;
}

/**
 * A small feature vector for "sounds like": [log10 duration s, loudness LUFS/10 (−6 for silence), log2 centroid Hz/1000, flatness,
 * log10 attack ms, pitch as midi/12 (0 when not pitched), onsets per second, noise floor dBFS/60]. Compare with a weighted distance.
 */
export function sampleFeatureVector(m: SampleMeasure): number[] {
  const fin = (v: number, d: number): number => (Number.isFinite(v) ? v : d);
  return [
    Math.log10(Math.max(0.001, m.duration)),
    fin(m.lufs, -60) / 10,
    Math.log2(Math.max(20, fin(m.centroid, 20)) / 1000),
    fin(m.flatness, 1),
    Math.log10(Math.max(0.1, m.attackMs)),
    m.pitched && m.pitch ? m.pitch.midi / 12 : 0,
    m.onsets.perSecond,
    fin(m.noiseFloorDb, -120) / 60,
  ];
}


// ---- choosing a window of a longer take ----------------------------------------------------------------------------

/** Start frames to try for a window of `win` frames in `total` frames: spread evenly (at most `max`), the first and the last possible included. */
export function windowStarts(total: number, win: number, max = 16): number[] {
  const last = Math.max(0, total - win);
  const n = Math.max(1, Math.min(max, last + 1));
  const out = new Set<number>();
  for (let i = 0; i < n; i++) out.add(n === 1 ? 0 : Math.round((i * last) / (n - 1)));
  return [...out].sort((a, b) => a - b);
}

/** The start frame of the loudest window of `win` frames (the most energy summed over the channels; the first when equal), looking every 256 frames. */
export function loudestWindow(chs: readonly Float32Array[], win: number): number {
  const total = chs[0]?.length ?? 0;
  if (total <= win) return 0;
  const prefix = new Float64Array(total + 1);
  for (let i = 0; i < total; i++) {
    let e = 0;
    for (const c of chs) e += c[i]! * c[i]!;
    prefix[i + 1] = prefix[i]! + e;
  }
  const last = total - win;
  let best = 0, bestE = -1;
  for (let a = 0; ; a = Math.min(last, a + 256)) {
    const e = prefix[a + win]! - prefix[a]!;
    if (e > bestE + 1e-12) { bestE = e; best = a; }
    if (a >= last) break;
  }
  return best;
}


// ---- one summary for sounds and samples -------------------------------------------------------------------------------

/**
 * The same numbers, under the same keys and in the same units, for a sound (`measure` / `describe --json` → `summary`) and for a sample
 * (`sample:<name>` → `summary`), so a script can read either with one reader. Seconds, milliseconds, Hz and dB as the key says; null when the
 * number does not exist (a silent sound has no loudness; an unpitched one no pitch).
 */
export interface MeasureSummary {
  durationS: number;
  lufs: number | null;
  peakDb: number | null;
  truePeakDb: number | null;
  rmsDb: number | null;
  centroidHz: number | null;
  flatness: number | null;
  attackMs: number | null;
  /** The pitch in Hz (a sample: the median of the track; a sound: the middle of its start and end), and its note name. */
  pitchHz: number | null;
  pitchNote: string | null;
  /** How sure the tracker is (a sample; null for a sound, whose tracker does not say). */
  pitchConfidence: number | null;
  /** See SampleMeasure.pitch: 0 … 1 and whether it is under the limit of an inharmonic (bell-like) spectrum; null with no pitch. */
  harmonicity: number | null;
  inharmonic: boolean | null;
  pitched: boolean;
  onsets: number;
  silent: boolean;
}

const fin4 = (v: number): number | null => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);

export function summaryOfSample(m: SampleMeasure): MeasureSummary {
  return {
    durationS: fin4(m.duration)!, lufs: fin4(m.lufs), peakDb: fin4(m.peakDb), truePeakDb: fin4(m.truePeakDb), rmsDb: fin4(m.rmsDb), centroidHz: fin4(m.centroid), flatness: fin4(m.flatness),
    attackMs: fin4(m.attackMs), pitchHz: m.pitch ? fin4(m.pitch.hz) : null, pitchNote: m.pitch ? m.pitch.note : null, pitchConfidence: m.pitch ? fin4(m.pitch.confidence) : null,
    harmonicity: m.pitch ? fin4(m.pitch.harmonicity) : null, inharmonic: m.pitch ? m.pitch.inharmonic : null, pitched: m.pitched, onsets: m.onsets.count, silent: m.silent,
  };
}

/** The summary of a sound's analysis; `harmonicity` (see `harmonicityOf`, measured on the render) is given when the sound has a pitch. */
export function summaryOfAnalysis(a: Analysis, harmonicity: number | null = null): MeasureSummary {
  const { start, end } = a.pitch;
  const hz = start !== null && end !== null ? Math.sqrt(start * end) : start ?? end;
  return {
    durationS: fin4(a.duration)!, lufs: fin4(a.lufs), peakDb: fin4(a.peakDb), truePeakDb: fin4(a.truePeakDb), rmsDb: fin4(a.rmsDb), centroidHz: fin4(a.centroid.mean), flatness: fin4(a.flatness),
    attackMs: fin4(a.attack * 1000), pitchHz: hz === null ? null : fin4(hz), pitchNote: hz === null ? null : noteName(hz), pitchConfidence: null,
    harmonicity: hz === null ? null : harmonicity, inharmonic: hz === null || harmonicity === null ? null : harmonicity < INHARMONIC_BELOW,
    pitched: hz !== null && a.pitch.voiced >= 0.5, onsets: a.onsets, silent: a.silent,
  };
}
