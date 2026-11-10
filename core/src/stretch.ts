// Time stretch and pitch shift, deterministic: a radix-2 FFT with twiddles from fdlibm's sine, an arctangent
// from + - * / and sqrt, fixed order everywhere. Two methods:
//   wsola  - waveform-similarity overlap-add; for transients, speech and noise. Onsets found in the input
//            start a new segment placed exactly where the onset belongs (onset time x ratio), so a click
//            train keeps its attack times.
//   pv     - a phase vocoder with identity phase locking (Laroche and Dolby/Dolson); for tones and pads.
// `ratio` is output length / input length (2: twice as long, the pitch kept). The output has exactly
// round(length x ratio) frames. Multichannel: stretchChannels() keeps the channels aligned with each other.

import { exp2, sinRad } from './mathx.ts';
import { readerFor } from './interp.ts';

export type StretchMethod = 'wsola' | 'pv';
export type PitchMethod = 'resample' | 'stretch';

const PI = 3.141592653589793;
const TAU = 6.283185307179586;

export const semitoneRatio = (semitones: number): number => exp2(semitones / 12);

const cosRad = (x: number): number => sinRad(x + PI / 2);

// ---- arctangent --------------------------------------------------------------------------------------------------

function atanSmall(t: number): number {
  // |t| <= 0.2: the series to t^19 (error below 1e-15)
  const t2 = t * t;
  let term = t;
  let sum = 0;
  for (let k = 1; k <= 19; k += 2) { sum += term / k * (((k - 1) / 2) % 2 === 0 ? 1 : -1); term *= t2; }
  return sum;
}

function atanPos(t: number): number {
  if (t > 1) return PI / 2 - atanPos(1 / t);
  // atan(t) = 2 atan(t / (1 + sqrt(1 + t^2))), twice
  const u = t / (1 + Math.sqrt(1 + t * t));
  const v = u / (1 + Math.sqrt(1 + u * u));
  return 4 * atanSmall(v);
}

/** atan2(y, x) from + - * / and sqrt: the same bits on every platform. */
export function atan2d(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const a = atanPos((y < 0 ? -y : y) / (x < 0 ? -x : x === 0 ? 1e-300 : x));
  const r = x === 0 ? PI / 2 : x > 0 ? a : PI - a;
  return y < 0 ? -r : r;
}

// ---- FFT ---------------------------------------------------------------------------------------------------------

interface FftPlan {
  n: number;
  cos: Float64Array;
  sin: Float64Array;
  rev: Uint32Array;
}
const plans = new Map<number, FftPlan>();

function planFor(n: number): FftPlan {
  const have = plans.get(n);
  if (have) return have;
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) { const a = (TAU * k) / n; cos[k] = cosRad(a); sin[k] = sinRad(a); }
  const rev = new Uint32Array(n);
  let bits = 0;
  while ((1 << bits) < n) bits++;
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); rev[i] = r; }
  const p = { n, cos, sin, rev };
  plans.set(n, p);
  return p;
}

/** In-place forward FFT (e^{-i...}); `inverse` runs the conjugate transform without scaling. */
export function fftInPlace(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const { n, cos, sin, rev } = planFor(re.length);
  for (let i = 0; i < n; i++) {
    const j = rev[i]!;
    if (j > i) { const tr = re[i]!; re[i] = re[j]!; re[j] = tr; const ti = im[i]!; im[i] = im[j]!; im[j] = ti; }
  }
  const sgn = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let s = 0; s < n; s += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step]!;
        const wi = sgn * sin[k * step]!;
        const a = s + k;
        const b = a + half;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr; im[b] = im[a]! - xi;
        re[a] = re[a]! + xr; im[a] = im[a]! + xi;
      }
    }
  }
}

const hannCache = new Map<number, Float64Array>();
/** Periodic Hann window of length n: w[i] + w[i + n/2] = 1. */
function hann(n: number): Float64Array {
  const have = hannCache.get(n);
  if (have) return have;
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * cosRad((TAU * i) / n);
  hannCache.set(n, w);
  return w;
}

const outLength = (n: number, ratio: number): number => Math.max(1, Math.round(n * ratio));

// ---- WSOLA -------------------------------------------------------------------------------------------------------

/** Start positions of transients: blocks of 2 ms whose energy jumps well above the 10 ms before them. */
function findOnsets(g: Float32Array, rate: number): number[] {
  const B = Math.max(8, Math.round(rate * 0.002));
  const nb = Math.floor(g.length / B);
  if (nb < 8) return [];
  const e = new Float64Array(nb);
  let top = 0;
  for (let j = 0; j < nb; j++) {
    let s = 0;
    for (let i = j * B; i < (j + 1) * B; i++) s += g[i]! * g[i]!;
    e[j] = s;
    if (s > top) top = s;
  }
  const out: number[] = [];
  let last = -1e9;
  for (let j = 1; j < nb; j++) {
    let prev = 0;
    for (let k = Math.max(0, j - 5); k < j; k++) prev += e[k]!;
    prev /= Math.min(5, j);
    if (e[j]! > 6 * prev + 1e-9 && e[j]! > 0.02 * top && j - last >= 25) { out.push(j * B); last = j; }
  }
  return out;
}

function wsolaChannels(chs: Float32Array[], ratio: number, rate: number): Float32Array[] {
  const n = chs[0]!.length;
  const M0 = outLength(n, ratio);
  const outs = chs.map(() => new Float32Array(M0));
  const acc = chs.map(() => new Float64Array(M0));
  const guide = new Float32Array(n);
  for (const c of chs) for (let i = 0; i < n; i++) guide[i] = guide[i]! + c[i]!;
  const Hs = Math.max(8, Math.round(rate * 0.0125));
  const W = 2 * Hs;
  const delta = Math.max(2, Math.round(rate * 0.01));
  const win = hann(W);
  const onsets = findOnsets(guide, rate);
  const bounds = [0, ...onsets, n];
  for (let si = 0; si + 1 < bounds.length; si++) {
    const segStart = bounds[si]!;
    const segEnd = bounds[si + 1]!;
    const L = segEnd - segStart;
    const outStart = si + 2 === bounds.length ? Math.round(segStart * ratio) : Math.round(segStart * ratio);
    const outEnd = si + 2 === bounds.length ? M0 : Math.round(segEnd * ratio);
    const M = outEnd - outStart;
    if (L < 1 || M < 1) continue;
    const pad = L + 2 * W + delta;
    const g = new Float64Array(pad);
    for (let i = 0; i < L; i++) g[i] = guide[segStart + i]!;
    const segs = chs.map((c) => { const a = new Float64Array(pad); for (let i = 0; i < L; i++) a[i] = c[segStart + i]!; return a; });
    let prev = 0;
    for (let k = 0; k * Hs < M; k++) {
      const s = k * Hs;
      let c = 0;
      if (k > 0) {
        const nominal = Math.round((s * L) / M);
        const t0 = prev + Hs;
        let best = -Infinity;
        c = Math.min(nominal, L - 1);
        const lo = Math.max(0, nominal - delta);
        const hi = Math.min(L - 1, nominal + delta);
        for (let cand = lo; cand <= hi; cand++) {
          let dot = 0, en = 0;
          for (let i = 0; i < Hs; i += 2) { const v = g[cand + i]!; dot += g[t0 + i]! * v; en += v * v; }
          const sc = dot / Math.sqrt(en + 1e-9);
          if (sc > best) { best = sc; c = cand; }
        }
      }
      for (let ch = 0; ch < chs.length; ch++) {
        const a = acc[ch]!;
        const seg = segs[ch]!;
        for (let i = 0; i < W; i++) {
          const o = outStart + s + i;
          if (o >= M0) break;
          a[o] = a[o]! + (k === 0 && i < Hs ? 1 : win[i]!) * seg[c + i]!;
        }
      }
      prev = c;
    }
  }
  for (let ch = 0; ch < chs.length; ch++) for (let i = 0; i < M0; i++) outs[ch]![i] = acc[ch]![i]!;
  return outs;
}

/** WSOLA stretch of one channel (see the file header). */
export function wsolaStretch(x: Float32Array, ratio: number, rate: number): Float32Array {
  return wsolaChannels([x], ratio, rate)[0]!;
}

// ---- phase vocoder -----------------------------------------------------------------------------------------------

const princarg = (p: number): number => p - TAU * Math.round(p / TAU);

/** Phase-locked phase vocoder stretch of one channel. */
export function vocoderStretch(x: Float32Array, ratio: number, rate: number): Float32Array {
  const n = x.length;
  const M = outLength(n, ratio);
  const N = rate >= 88200 ? 4096 : 2048;
  const Hs = N / 4;
  const bins = N / 2 + 1;
  const w = hann(N);
  const out = new Float64Array(M);
  const wsum = new Float64Array(M);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const mag = new Float64Array(bins);
  const ph = new Float64Array(bins);
  const prevPh = new Float64Array(bins);
  const syn = new Float64Array(bins);
  const tf = new Float64Array(bins);
  const peaks: number[] = [];
  let prevA = 0;
  for (let k = 0; k * Hs - N / 2 < M; k++) {
    const c = k * Hs;
    const inCentre = Math.round(c / ratio);
    const a0 = inCentre - N / 2;
    for (let i = 0; i < N; i++) { const p = a0 + i; re[i] = p >= 0 && p < n ? x[p]! * w[i]! : 0; im[i] = 0; }
    fftInPlace(re, im, false);
    for (let b = 0; b < bins; b++) { mag[b] = Math.sqrt(re[b]! * re[b]! + im[b]! * im[b]!); ph[b] = atan2d(im[b]!, re[b]!); }
    if (k === 0) {
      for (let b = 0; b < bins; b++) syn[b] = ph[b]!;
    } else {
      const ha = a0 - prevA;
      for (let b = 0; b < bins; b++) {
        const om = (TAU * b) / N;
        tf[b] = ha > 0 ? om + princarg(ph[b]! - prevPh[b]! - om * ha) / ha : om;
      }
      peaks.length = 0;
      for (let b = 0; b < bins; b++) {
        const m = mag[b]!;
        if (m > 0 && (b < 1 || m > mag[b - 1]!) && (b < 2 || m > mag[b - 2]!) && (b + 1 >= bins || m >= mag[b + 1]!) && (b + 2 >= bins || m >= mag[b + 2]!)) peaks.push(b);
      }
      if (!peaks.length) {
        for (let b = 0; b < bins; b++) syn[b] = syn[b]! + tf[b]! * Hs;
      } else {
        let lo = 0;
        for (let pi = 0; pi < peaks.length; pi++) {
          const p = peaks[pi]!;
          const hi = pi + 1 < peaks.length ? (p + peaks[pi + 1]!) >> 1 : bins - 1;
          const sp = syn[p]! + tf[p]! * Hs;
          const dp = ph[p]!;
          // the region's bins take the peak's synthesis phase and keep their analysis phase relative to it
          for (let b = lo; b <= hi; b++) syn[b] = sp + (ph[b]! - dp);
          lo = hi + 1;
        }
      }
    }
    for (let b = 0; b < bins; b++) prevPh[b] = ph[b]!;
    prevA = a0;
    for (let b = 0; b < bins; b++) {
      const m = mag[b]!;
      re[b] = m * cosRad(syn[b]!);
      im[b] = m * sinRad(syn[b]!);
    }
    for (let b = 1; b < N / 2; b++) { re[N - b] = re[b]!; im[N - b] = -im[b]!; }
    im[0] = 0; im[N / 2] = 0;
    fftInPlace(re, im, true);
    const o0 = c - N / 2;
    for (let i = 0; i < N; i++) {
      const o = o0 + i;
      if (o < 0 || o >= M) continue;
      out[o] = out[o]! + (re[i]! / N) * w[i]!;
      wsum[o] = wsum[o]! + w[i]! * w[i]!;
    }
  }
  const res = new Float32Array(M);
  for (let i = 0; i < M; i++) res[i] = out[i]! / Math.max(wsum[i]!, 0.3);
  return res;
}

// ---- entry points ------------------------------------------------------------------------------------------------

/** Stretch one channel by `ratio` (output length / input length) with the chosen method. */
export function stretchTo(x: Float32Array, ratio: number, rate: number, method: StretchMethod): Float32Array {
  if (ratio === 1) return Float32Array.from(x);
  return method === 'pv' ? vocoderStretch(x, ratio, rate) : wsolaStretch(x, ratio, rate);
}

/** Stretch channels with identical parameters. WSOLA picks its positions from the channels' sum, so they stay aligned; the phase vocoder treats each channel alike (identical channels give identical results). */
export function stretchChannels(chs: Float32Array[], ratio: number, rate: number, method: StretchMethod): Float32Array[] {
  if (ratio === 1) return chs.map((c) => Float32Array.from(c));
  if (method === 'pv') return chs.map((c) => vocoderStretch(c, ratio, rate));
  return wsolaChannels(chs, ratio, rate);
}

/**
 * Shift the pitch by `semitones`. `resample` reads the signal faster or slower (the length changes to round(length / ratio));
 * `stretch` keeps the length: the phase vocoder stretches by the ratio and the result is read back at that ratio.
 */
export function pitchShift(x: Float32Array, semitones: number, rate: number, method: PitchMethod): Float32Array {
  if (semitones === 0) return Float32Array.from(x);
  const r = semitoneRatio(semitones);
  const read = (sig: Float32Array, len: number): Float32Array => {
    const rd = readerFor('sinc', sig);
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) out[i] = rd(i * r, r);
    return out;
  };
  if (method === 'resample') return read(x, Math.max(1, Math.round(x.length / r)));
  return read(vocoderStretch(x, r, rate), x.length);
}
