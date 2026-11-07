// Measurements: the numbers an agent that cannot listen reads. Written here with tests against
// known signals, no native dependencies: duration, integrated loudness (ITU-R BS.1770) and true
// peak, crest factor, DC offset, attack time, tail length, spectral centroid over time, pitch
// (YIN), onsets. Pure functions over Float32Array / Float64Array. These are measurements, not part
// of the deterministic render: they may use Math.sin/cos/log, and the last digit may differ
// between platforms (they are printed rounded).

import { DIED_AWAY, SAMPLE_RATE } from './sound.ts';

export type Samples = Float32Array | Float64Array;

const LN10 = Math.LN10;
export const toDb = (x: number): number => (x > 0 ? (20 * Math.log(x)) / LN10 : -Infinity);

// ---- FFT -------------------------------------------------------------------------------------

const twiddles = new Map<number, { cos: Float64Array; sin: Float64Array }>();

function twiddle(n: number): { cos: Float64Array; sin: Float64Array } {
  let t = twiddles.get(n);
  if (!t) {
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    t = { cos, sin };
    twiddles.set(n, t);
  }
  return t;
}

/** In-place radix-2 FFT of `re` + i·`im` (length a power of two). `inverse` scales by 1/n. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!, ti = im[i]!;
      re[i] = re[j]!; im[i] = im[j]!;
      re[j] = tr; im[j] = ti;
    }
  }
  const { cos, sin } = twiddle(n);
  const sgn = inverse ? -1 : 1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step]!;
        const wi = sgn * sin[k * step]!;
        const a = start + k;
        const b = a + half;
        const tr = re[b]! * wr - im[b]! * wi;
        const ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] = re[i]! / n; im[i] = im[i]! / n; }
}

export const nextPow2 = (n: number): number => { let p = 1; while (p < n) p <<= 1; return p; };

// ---- STFT, mel spectrogram ---------------------------------------------------------------------

export interface Stft {
  /** Magnitudes, frames × (size/2 + 1), amplitude-normalised (a full-scale sine peaks near 1). */
  mags: Float32Array[];
  size: number;
  hop: number;
  /** Centre time of each frame, seconds. */
  times: Float64Array;
}

/** Hann-windowed short-time spectra. Frames are centred on t = k·hop (the signal is zero outside). */
export function stft(x: Samples, size = 1024, hop = 256): Stft {
  const win = new Float64Array(size);
  let wsum = 0;
  for (let i = 0; i < size; i++) { win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size); wsum += win[i]!; }
  const nFrames = Math.max(1, Math.ceil(x.length / hop));
  const mags: Float32Array[] = [];
  const times = new Float64Array(nFrames);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let f = 0; f < nFrames; f++) {
    const start = f * hop - size / 2;
    for (let i = 0; i < size; i++) {
      const j = start + i;
      re[i] = j >= 0 && j < x.length ? x[j]! * win[i]! : 0;
      im[i] = 0;
    }
    fft(re, im);
    const m = new Float32Array(size / 2 + 1);
    for (let k = 0; k <= size / 2; k++) m[k] = (2 * Math.hypot(re[k]!, im[k]!)) / wsum;
    mags.push(m);
    times[f] = (f * hop) / SAMPLE_RATE;
  }
  return { mags, size, hop, times };
}

export const hzToMel = (f: number): number => 2595 * Math.log10(1 + f / 700);
export const melToHz = (m: number): number => 700 * (Math.pow(10, m / 2595) - 1);

export interface MelSpec {
  /** Level in dB (full scale sine = about 0 dB) per frame × band. */
  db: Float32Array[];
  /** Band centre frequencies, Hz. */
  freqs: Float64Array;
  times: Float64Array;
  hop: number;
  duration: number;
}

/** A mel spectrogram: triangular filters over the power spectrum, `bands` of them from fmin to fmax. */
export function melSpectrogram(x: Samples, o: { bands?: number; fmin?: number; fmax?: number; size?: number; hop?: number } = {}): MelSpec {
  const bands = o.bands ?? 96;
  const fmin = o.fmin ?? 40;
  const fmax = Math.min(o.fmax ?? 16000, SAMPLE_RATE / 2);
  const size = o.size ?? 1024;
  const hop = o.hop ?? 256;
  const s = stft(x, size, hop);
  const bins = size / 2 + 1;
  const binHz = SAMPLE_RATE / size;
  const m0 = hzToMel(fmin);
  const m1 = hzToMel(fmax);
  const centers = new Float64Array(bands + 2);
  for (let i = 0; i < bands + 2; i++) centers[i] = melToHz(m0 + ((m1 - m0) * i) / (bands + 1));
  const filters: { from: number; w: Float64Array }[] = [];
  for (let b = 0; b < bands; b++) {
    const lo = centers[b]!, mid = centers[b + 1]!, hi = centers[b + 2]!;
    const from = Math.max(0, Math.floor(lo / binHz));
    const to = Math.min(bins - 1, Math.ceil(hi / binHz));
    const w = new Float64Array(to - from + 1);
    let sum = 0;
    for (let k = from; k <= to; k++) {
      const f = k * binHz;
      const v = f <= mid ? (f - lo) / (mid - lo) : (hi - f) / (hi - mid);
      w[k - from] = v > 0 ? v : 0;
      sum += w[k - from]!;
    }
    if (sum > 0) for (let i = 0; i < w.length; i++) w[i] = w[i]! / sum;
    filters.push({ from, w });
  }
  const db = s.mags.map((m) => {
    const row = new Float32Array(bands);
    for (let b = 0; b < bands; b++) {
      const { from, w } = filters[b]!;
      let p = 0;
      for (let i = 0; i < w.length; i++) p += w[i]! * m[from + i]! * m[from + i]!;
      row[b] = p > 1e-12 ? (10 * Math.log(p)) / LN10 : -120;
    }
    return row;
  });
  return { db, freqs: centers.slice(1, bands + 1), times: s.times, hop, duration: x.length / SAMPLE_RATE };
}

// ---- Loudness (ITU-R BS.1770-4) -------------------------------------------------------------------

type Biquad = [b0: number, b1: number, b2: number, a1: number, a2: number];

/** The K-weighting filters for any sample rate (the standard's coefficients are for 48 kHz; these come from the same analogue design). */
export function kWeighting(fs: number): [Biquad, Biquad] {
  const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  const g0 = 38.13547087602444, Q2 = 0.5003270373238773;
  K = Math.tan((Math.PI * g0) / fs);
  a0 = 1 + K / Q2 + K * K;
  const rlb: Biquad = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q2 + K * K) / a0];
  return [shelf, rlb];
}

function filter(x: Samples, [b0, b1, b2, a1, a2]: Biquad): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i]! + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]!; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

/**
 * Integrated loudness in LUFS: K-weighted mean square over 400 ms blocks (75 % overlap), gated at
 * −70 LUFS and then 10 LU below the gated mean. A sound shorter than one block is measured as a
 * single block over its whole length (no padding with silence). Silence is −Infinity.
 */
export function integratedLoudness(input: Samples | readonly Samples[]): number {
  const chans = Array.isArray(input) ? (input as readonly Samples[]) : [input as Samples];
  if (!chans[0]!.length) return -Infinity;
  const [s1, s2] = kWeighting(SAMPLE_RATE);
  const ys = chans.map((x) => filter(filter(x, s1), s2));
  const y = ys[0]!;
  const block = Math.round(0.4 * SAMPLE_RATE);
  const step = Math.round(0.1 * SAMPLE_RATE);
  const ms: number[] = [];
  const meanSquare = (from: number, to: number): number => {
    // BS.1770: the channels' mean squares add (left and right each weigh 1)
    let total = 0;
    for (const c of ys) {
      let sum = 0;
      for (let i = from; i < to; i++) sum += c[i]! * c[i]!;
      total += sum / (to - from);
    }
    return total;
  };
  if (y.length < block) ms.push(meanSquare(0, y.length));
  else {
    // a block is four steps: sum the squares of each step once and add four of them for each block
    const steps = Math.floor((y.length - block) / step) + 1 + block / step - 1;
    const sub = new Float64Array(steps);
    for (const c of ys) for (let k = 0; k < steps; k++) { let sum = 0; const to = Math.min(y.length, (k + 1) * step); for (let i = k * step; i < to; i++) sum += c[i]! * c[i]!; sub[k] = sub[k]! + sum; }
    const per = block / step;
    for (let s = 0, k = 0; s + block <= y.length; s += step, k++) { let t = 0; for (let j = 0; j < per; j++) t += sub[k + j]!; ms.push(t / block); }
  }
  const lufs = (z: number): number => (z > 0 ? -0.691 + (10 * Math.log(z)) / LN10 : -Infinity);
  const abs = ms.filter((z) => lufs(z) > -70);
  if (!abs.length) return -Infinity;
  const mean = (zs: number[]): number => zs.reduce((a, b) => a + b, 0) / zs.length;
  const gate = lufs(mean(abs)) - 10;
  const rel = abs.filter((z) => lufs(z) > gate);
  return lufs(mean(rel.length ? rel : abs));
}

const TP_HALF = 96; // oversampled taps each side of the centre
let tpFilter: Float64Array | null = null;

/** True peak: the largest absolute value after 4x oversampling (Blackman-windowed sinc interpolation), linear. */
export function truePeak(x: Samples): number {
  if (!tpFilter) {
    tpFilter = new Float64Array(2 * TP_HALF + 1);
    for (let m = -TP_HALF; m <= TP_HALF; m++) {
      const t = m / 4;
      const sinc = m === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const u = (m + TP_HALF) / (2 * TP_HALF);
      tpFilter[m + TP_HALF] = sinc * (0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u));
    }
    // Each of the four phases passes DC with gain exactly 1.
    for (let ph = 0; ph < 4; ph++) {
      let g = 0;
      for (let i = 0; i < tpFilter.length; i++) if ((((i - TP_HALF) % 4) + 4) % 4 === ph) g += tpFilter[i]!;
      for (let i = 0; i < tpFilter.length; i++) if ((((i - TP_HALF) % 4) + 4) % 4 === ph) tpFilter[i] = tpFilter[i]! / g;
    }
  }
  const h = tpFilter;
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]!));
  // An interpolated point is a weighted sum of the 50 samples around it, so it cannot exceed (the largest of them) x (the sum of the weights' magnitudes):
  // a block whose neighbourhood is that far below the peak so far is skipped, which leaves the answer exactly as it was and saves most of the work on a decaying sound.
  let gain = 0;
  for (let ph = 0; ph < 4; ph++) {
    let g = 0;
    for (let i = 0; i < h.length; i++) if ((((i - TP_HALF) % 4) + 4) % 4 === ph) g += Math.abs(h[i]!);
    gain = Math.max(gain, g);
  }
  const B = 64;
  const nb = Math.ceil(x.length / B);
  const bmax = new Float64Array(nb);
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]!); if (a > bmax[(i / B) | 0]!) bmax[(i / B) | 0] = a; }
  // Phases 1..3 between sample i and i+1 (phase 0 is the samples themselves).
  for (let i = 0; i < x.length - 1; i++) {
    if ((i & (B - 1)) === 0 || i === 0) {
      const b = (i / B) | 0;
      const near = Math.max(bmax[b]!, bmax[b - 1] ?? 0, bmax[b + 1] ?? 0);
      if (near * gain <= peak) { i = Math.min(x.length - 2, (b + 1) * B - 1); continue; }
    }
    for (let ph = 1; ph < 4; ph++) {
      let acc = 0;
      for (let j = i - 24; j <= i + 25; j++) {
        if (j < 0 || j >= x.length) continue;
        const m = 4 * i + ph - 4 * j;
        if (m >= -TP_HALF && m <= TP_HALF) acc += x[j]! * h[m + TP_HALF]!;
      }
      const v = Math.abs(acc);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

// ---- Pitch (YIN) ---------------------------------------------------------------------------------

export interface PitchFrame {
  t: number;
  /** Fundamental in Hz, or null when the frame is not clearly pitched. */
  hz: number | null;
  /** 0..1, how clear (1 − the YIN aperiodicity). */
  clarity: number;
}

const YIN_THRESHOLD = 0.15;

/** Pitch track by the YIN method, frames every `hop` samples; unvoiced or quiet frames have hz = null. */
export function yinPitch(x: Samples, o: { hop?: number; fmin?: number; fmax?: number } = {}): PitchFrame[] {
  const hop = o.hop ?? 512;
  const tauMin = Math.max(2, Math.floor(SAMPLE_RATE / (o.fmax ?? 4000)));
  let tauMax = Math.floor(SAMPLE_RATE / (o.fmin ?? 50));
  tauMax = Math.min(tauMax, Math.floor(x.length * 0.4));
  const W = Math.min(1024, x.length - tauMax - 1);
  const out: PitchFrame[] = [];
  if (W < 128 || tauMax <= tauMin + 2) return out;
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]!));
  // the correlation is wanted at lags 0..tauMax only, and b is W + tauMax long: a transform of that size has no wrap-around in those lags
  const N = nextPow2(W + tauMax + 1);
  const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  const cr = new Float64Array(N), ci = new Float64Array(N);
  const d = new Float64Array(tauMax + 1);
  const cm = new Float64Array(tauMax + 1);
  const cum = new Float64Array(W + tauMax + 1);
  for (let start = 0; start + W + tauMax <= x.length + hop; start += hop) {
    const seg = (j: number): number => (start + j < x.length ? x[start + j]! : 0);
    ar.fill(0); ai.fill(0); br.fill(0); bi.fill(0);
    let energy = 0;
    for (let j = 0; j < W; j++) { ar[j] = seg(j); energy += ar[j]! * ar[j]!; }
    for (let j = 0; j < W + tauMax; j++) br[j] = seg(j);
    cum[0] = 0;
    for (let j = 0; j < W + tauMax; j++) cum[j + 1] = cum[j]! + br[j]! * br[j]!;
    const t = (start + W / 2) / SAMPLE_RATE;
    const rms = Math.sqrt(energy / W);
    if (rms < peak * 0.003) { out.push({ t, hz: null, clarity: 0 }); continue; }
    // cross-correlation c(τ) = Σ a[j]·b[j+τ] through the FFT: IFFT(conj(A)·B)
    // both segments are real, so one transform of a + i·b gives both spectra: A[k] = (Z[k] + conj Z[N-k]) / 2, B[k] = (Z[k] - conj Z[N-k]) / 2i
    for (let k = 0; k < N; k++) { cr[k] = ar[k]!; ci[k] = br[k]!; }
    fft(cr, ci);
    for (let k = 0; k < N; k++) {
      const m = (N - k) & (N - 1);
      const aR = (cr[k]! + cr[m]!) / 2, aI = (ci[k]! - ci[m]!) / 2;
      const bR = (ci[k]! + ci[m]!) / 2, bI = -(cr[k]! - cr[m]!) / 2;
      ar[k] = aR * bR + aI * bI;
      ai[k] = aR * bI - aI * bR;
    }
    fft(ar, ai, true);
    for (let tau = 1; tau <= tauMax; tau++) d[tau] = energy + (cum[W + tau]! - cum[tau]!) - 2 * ar[tau]!;
    let run = 0;
    for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]!; cm[tau] = run > 0 ? (d[tau]! * tau) / run : 1; }
    let tau = -1;
    for (let k = tauMin; k < tauMax; k++) {
      if (cm[k]! < YIN_THRESHOLD) {
        while (k + 1 < tauMax && cm[k + 1]! < cm[k]!) k++;
        tau = k;
        break;
      }
    }
    if (tau < 0) { out.push({ t, hz: null, clarity: Math.max(0, 1 - Math.min(...Array.from(cm.subarray(tauMin, tauMax)))) }); continue; }
    // parabolic interpolation around the minimum
    const a = cm[tau - 1]!, b = cm[tau]!, c = cm[tau + 1]!;
    const den = a - 2 * b + c;
    const shift = den !== 0 ? (a - c) / (2 * den) : 0;
    const refined = tau + Math.max(-1, Math.min(1, shift));
    out.push({ t, hz: SAMPLE_RATE / refined, clarity: 1 - b });
  }
  return out;
}

export const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** `A4` for 440 Hz, nearest note. */
export function noteName(hz: number): string {
  const m = Math.round(hzToMidi(hz));
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}
export const midiName = (m: number): string => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

// ---- The numbers ---------------------------------------------------------------------------------

export interface Analysis {
  /** 1, or 2 for a stereo sound (peaks and loudness count both; spectrum and pitch are measured on the mix of the two). */
  channels: number;
  samples: number;
  /** Seconds. */
  duration: number;
  silent: boolean;
  peak: number;
  peakDb: number;
  /** dBTP. */
  truePeakDb: number;
  rmsDb: number;
  /** Peak over RMS, dB. */
  crestDb: number;
  /** Mean sample value (−1..1). */
  dc: number;
  /** Integrated loudness, LUFS (−Infinity when silent). */
  lufs: number;
  /** Seconds from the start to the first sample within −3 dB of the peak. */
  attack: number;
  /** Seconds from the end of the loud part (last point within −3 dB of the peak level) to the last point above −60 dB below the peak. */
  tail: number;
  /** Seconds before the first point above −60 dB below the peak, and after the last. */
  leadingSilence: number;
  trailingSilence: number;
  /** The larger of the last two samples' magnitudes, relative to the peak, dB (0 = the sound is cut at its loudest; a fade to zero is −Infinity). */
  endLevelDb: number;
  /** Spectral centroid ("brightness"), Hz, energy-weighted over the sound, and near its start, middle and end. */
  centroid: { mean: number; start: number; mid: number; end: number };
  /** Centroid per STFT frame (NaN where the frame is too quiet). */
  centroidTrack: { t: number; hz: number }[];
  /** Spectral flatness 0..1 over the loud frames (near 1 = noise-like, near 0 = tonal). */
  flatness: number;
  pitch: { start: number | null; end: number | null; min: number | null; max: number | null; rangeSemitones: number; voiced: number; track: PitchFrame[] };
  /** Count and times (s) of onsets. */
  onsets: number;
  onsetTimes: number[];
}

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };

/** RMS in `win`-sample windows every `hop` samples; the window starts at k·hop. */
export function rmsEnvelope(x: Samples, win = 220, hop = 110): Float64Array {
  const n = Math.max(1, Math.ceil(x.length / hop));
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const a = k * hop;
    const b = Math.min(x.length, a + win);
    let s = 0;
    for (let i = a; i < b; i++) s += x[i]! * x[i]!;
    out[k] = b > a ? Math.sqrt(s / (b - a)) : 0;
  }
  return out;
}

export function analyze(input: Samples | readonly Samples[]): Analysis {
  const chs = Array.isArray(input) ? (input as readonly Samples[]) : [input as Samples];
  const n = chs[0]!.length;
  // x: what the spectrum and pitch are measured on (the mix); m: the level at each sample (the larger channel), for peaks, attack, silence and tail.
  let x: Samples = chs[0]!;
  let m: Samples;
  if (chs.length === 1) {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = Math.abs(x[i]!);
    m = a;
  } else {
    const mix = new Float32Array(n);
    const lvl = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, big = 0;
      for (const c of chs) { s += c[i]!; big = Math.max(big, Math.abs(c[i]!)); }
      mix[i] = s / chs.length;
      lvl[i] = big;
    }
    x = mix;
    m = lvl;
  }
  const duration = n / SAMPLE_RATE;
  let peak = 0, sum = 0, sq = 0;
  for (const c of chs) {
    let cs = 0;
    for (let i = 0; i < n; i++) {
      const v = c[i]!;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      cs += v;
      sq += v * v;
    }
    if (Math.abs(cs) > Math.abs(sum)) sum = cs;
  }
  const rms = n ? Math.sqrt(sq / (n * chs.length)) : 0;
  const silent = peak < 1e-6;
  const empty = {
    channels: chs.length, samples: n, duration, silent, peak, peakDb: toDb(peak), truePeakDb: toDb(peak), rmsDb: toDb(rms), crestDb: 0, dc: n ? sum / n : 0, lufs: -Infinity,
    attack: 0, tail: 0, leadingSilence: duration, trailingSilence: 0, endLevelDb: -Infinity,
    centroid: { mean: NaN, start: NaN, mid: NaN, end: NaN }, centroidTrack: [], flatness: NaN,
    pitch: { start: null, end: null, min: null, max: null, rangeSemitones: 0, voiced: 0, track: [] }, onsets: 0, onsetTimes: [],
  } satisfies Analysis;
  if (silent) return empty;

  // attack: first sample within −3 dB of the peak
  const thr3 = peak * Math.pow(10, -3 / 20);
  let attackAt = 0;
  while (attackAt < n && m[attackAt]! < thr3) attackAt++;

  // silence and tail, from the RMS envelope
  const win = 220, hop = 110;
  const env = rmsEnvelope(m, win, hop);
  let envMax = 0;
  for (const v of env) envMax = Math.max(envMax, v);
  const floor60 = peak * DIED_AWAY; // the same floor `duration=auto` ends a sound at
  let firstLoud = 0;
  while (firstLoud < n && m[firstLoud]! < floor60) firstLoud++;
  let lastLoud = n - 1;
  while (lastLoud > 0 && m[lastLoud]! < floor60) lastLoud--;
  const env3 = envMax * Math.pow(10, -3 / 20);
  let lastTop = 0;
  for (let k = 0; k < env.length; k++) if (env[k]! >= env3) lastTop = k;
  const topEndSample = Math.min(n - 1, lastTop * hop + win);
  let lastAbove = 0;
  for (let k = 0; k < env.length; k++) if (env[k]! >= envMax * 0.001) lastAbove = k;
  const tailEnd = Math.min(lastLoud, lastAbove * hop + win);
  const tail = Math.max(0, tailEnd - topEndSample) / SAMPLE_RATE;
  let endPeak = 0;
  for (let i = Math.max(0, n - 2); i < n; i++) endPeak = Math.max(endPeak, m[i]!);

  // spectrum: centroid, flatness
  const s = stft(x, 1024, 256);
  const frameE = s.mags.map((m) => { let e = 0; for (let k = 1; k < m.length; k++) e += m[k]! * m[k]!; return e; });
  const maxE = Math.max(...frameE);
  const track: { t: number; hz: number }[] = [];
  let wSum = 0, cSum = 0, flatSum = 0, flatW = 0;
  s.mags.forEach((m, f) => {
    if (frameE[f]! < maxE * 1e-6) { track.push({ t: s.times[f]!, hz: NaN }); return; }
    let num = 0, den = 0, logSum = 0, lin = 0, cnt = 0;
    for (let k = 1; k < m.length; k++) {
      const p = m[k]!;
      num += (k * SAMPLE_RATE / s.size) * p;
      den += p;
      if (k * SAMPLE_RATE / s.size < 16000) { logSum += Math.log(p * p + 1e-20); lin += p * p; cnt++; }
    }
    const hz = den > 0 ? num / den : NaN;
    track.push({ t: s.times[f]!, hz });
    if (Number.isFinite(hz)) { wSum += frameE[f]!; cSum += hz * frameE[f]!; }
    if (lin > 0) { flatSum += Math.exp(logSum / cnt) / (lin / cnt) * frameE[f]!; flatW += frameE[f]!; }
  });
  const valid = track.filter((p) => Number.isFinite(p.hz));
  const avg = (xs: { hz: number }[]): number => (xs.length ? xs.reduce((a, b) => a + b.hz, 0) / xs.length : NaN);
  const centroid = {
    mean: wSum > 0 ? cSum / wSum : NaN,
    start: avg(valid.slice(0, 3)),
    mid: valid.length ? valid[Math.floor(valid.length / 2)]!.hz : NaN,
    end: avg(valid.slice(-3)),
  };

  // pitch
  // (a long sound is tracked at half the resolution: its pitch frames are 12 ms apart instead of 6)
  const frames = yinPitch(x, { hop: x.length > 2 * SAMPLE_RATE ? 512 : 256 });
  const voiced = frames.filter((f) => f.hz !== null);
  const hzs = voiced.map((f) => f.hz!);
  const edge = (xs: number[]): number | null => (xs.length ? median(xs) : null);
  const pitch = {
    start: edge(hzs.slice(0, 3)), end: edge(hzs.slice(-3)),
    min: hzs.length ? Math.min(...hzs) : null, max: hzs.length ? Math.max(...hzs) : null,
    rangeSemitones: hzs.length ? 12 * Math.log2(Math.max(...hzs) / Math.min(...hzs)) : 0,
    voiced: frames.length ? voiced.length / frames.length : 0, track: frames,
  };

  // onsets: a rise of 10 dB over the quietest of the previous 20 ms, above −45 dB of the peak
  const envDb = Array.from(env, (v) => toDb(v));
  const lookback = 8;
  const onsetTimes: number[] = [];
  let lastOnset = -1;
  for (let k = 0; k < env.length; k++) {
    if (envDb[k]! < toDb(envMax) - 45) continue;
    let prevMin = -Infinity;
    if (k > 0) prevMin = Math.min(...envDb.slice(Math.max(0, k - lookback), k));
    if (envDb[k]! - prevMin >= 10 && (lastOnset < 0 || k - lastOnset >= 24)) {
      onsetTimes.push((k * hop) / SAMPLE_RATE);
      lastOnset = k;
    }
  }
  // the very first window counts as an onset when the sound starts at once and it was not caught
  if (!onsetTimes.length) onsetTimes.push((firstLoud) / SAMPLE_RATE);

  return {
    channels: chs.length, samples: n, duration, silent, peak, peakDb: toDb(peak), truePeakDb: toDb(Math.max(...chs.map((c) => truePeak(c)))), rmsDb: toDb(rms), crestDb: toDb(peak) - toDb(rms),
    dc: sum / n, lufs: integratedLoudness(chs), attack: attackAt / SAMPLE_RATE, tail,
    leadingSilence: firstLoud / SAMPLE_RATE, trailingSilence: (n - 1 - lastLoud) / SAMPLE_RATE, endLevelDb: toDb(endPeak) - toDb(peak),
    centroid, centroidTrack: track, flatness: flatW > 0 ? flatSum / flatW : NaN, pitch, onsets: onsetTimes.length, onsetTimes,
  };
}
