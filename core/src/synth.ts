// The layered voice's renderer. Pure functions over typed arrays, deterministic like the rest of
// the renderer: nothing here uses Math.sin, cos, tan, exp, log or pow (their last digit may differ
// between platforms). The sine is `sineCycles`, 2^x and log2 are built from bits and series
// (mathx.ts), the filter coefficient uses an fdlibm sine; everything else is + - * / sqrt floor
// round, which IEEE 754 fixes exactly. So Node and the browser render the same bytes.

import { renderClassic } from './classic.ts';
import {
  BUILTIN_TABLES, MAX_DURATION, audibleLayers, isStereo, layerPatch, parseTable,
  type Env, type Fx, type Layer, type LayeredSound,
} from './layered.ts';
import { TAU, exp2, log2, sineCycles, sinRad, tanPi } from './mathx.ts';
import { hashText } from './generators.ts';
import { resample } from './resample.ts';
import { DIED_AWAY, SAMPLE_RATE } from './sound.ts';

const SR = SAMPLE_RATE;

/** An imported sample, as mono 44,100 Hz-independent data: the renderer resamples it. */
export interface SampleData {
  rate: number;
  /** The mono signal (the channels averaged). */
  data: Float32Array;
  /** A stereo file's channels, for `side=left` and `side=right`. */
  left?: Float32Array;
  right?: Float32Array;
}

/** Where a sample layer finds its audio. The renderer never reads files. */
export interface SampleBank {
  get(name: string): SampleData | undefined;
  /** The SHA-256 of the sample's bytes (part of the render key), or undefined when it is not there. */
  hash(name: string): string | undefined;
}

// ---- envelopes --------------------------------------------------------------------------------------

type Reader = (i: number) => number;

const EXP_STEEP = 8;
const EXP_NORM = 1 - 1 / 256; // 1 - 2^-8
/** An exponential fall to zero is a true exponential that is 60 dB down (a factor of 1000 = 2^9.9658) at the end of its segment, where the envelope then ends: no long run of silence after it. */
const EXP_DECAY_60DB = 9.965784284662087;

/** The value a segment from (value a) to (value b) has at u in [0, 1]. */
export function curveValue(a: number, b: number, u: number, curve: Env[number]['curve']): number {
  switch (curve) {
    case 'hold': return a;
    case 'ease': return a + (b - a) * (u * u * (3 - 2 * u));
    case 'exp':
      // Geometric between two values of one sign (equal steps of musical pitch, say); otherwise the fast-then-slow fall of a decay.
      if ((a > 0 && b > 0) || (a < 0 && b < 0)) return a * exp2(u * log2(b / a));
      if (b === 0 && a !== 0) return a * exp2(-EXP_DECAY_60DB * u);
      return a + (b - a) * ((1 - exp2(-EXP_STEEP * u)) / EXP_NORM);
    default: return a + (b - a) * u;
  }
}

/** An envelope's value at a time in seconds (before the first point it is the first value, after the last, the last). */
export function envAt(e: Env, t: number): number {
  if (t <= e[0]!.t) return e[0]!.v;
  for (let k = 0; k < e.length - 1; k++) {
    const a = e[k]!, b = e[k + 1]!;
    if (t < b.t) return curveValue(a.v, b.v, (t - a.t) / (b.t - a.t), b.curve);
  }
  return e[e.length - 1]!.v;
}

function envReader(e: Env): Reader {
  const n = e.length;
  let k = 0;
  return (i) => {
    const t = i / SR;
    if (t <= e[0]!.t) return e[0]!.v;
    if (t < e[k]!.t) k = 0;
    while (k < n - 1 && t >= e[k + 1]!.t) k++;
    if (k >= n - 1) return e[n - 1]!.v;
    const a = e[k]!, b = e[k + 1]!;
    return curveValue(a.v, b.v, (t - a.t) / (b.t - a.t), b.curve);
  };
}

function param(p: Record<string, number | string>, envs: Record<string, Env>, name: string): Reader {
  const e = envs[name];
  if (e) return envReader(e);
  const v = p[name] as number;
  return () => v;
}

// ---- noise --------------------------------------------------------------------------------------------

class Noise {
  private x: number;
  constructor(seed: number) {
    this.x = (seed >>> 0) | 0;
    if (this.x === 0) this.x = 0x2545f491;
  }
  /** White noise in [-1, 1). */
  next(): number {
    let x = this.x;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.x = x;
    return (x >>> 0) / 2147483648 - 1;
  }
}

/** The seed a layer's noise starts from. */
export function layerSeed(s: LayeredSound, l: Layer): number {
  return l.p.seed !== undefined ? (l.p.seed as number) : hashText(`${s.seed}:${l.salt}`);
}

// ---- wavetables ---------------------------------------------------------------------------------------

const HARMONICS: Record<(typeof BUILTIN_TABLES)[number], number[]> = {
  organ: [1, 0.5, 0.33, 0.25, 0.2],
  bell: [1, 0, 0.5, 0, 0, 0.3, 0, 0, 0.2],
  reed: [1, 0.8, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1],
  hollow: [1, 0, 0.33, 0, 0.2, 0, 0.14],
};
const tableCache = new Map<string, Float64Array>();

export function wavetable(spec: string): Float64Array {
  let t = tableCache.get(spec);
  if (t) return t;
  const parsed = parseTable(spec);
  if (typeof parsed === 'string') {
    t = new Float64Array(64);
    HARMONICS[parsed as keyof typeof HARMONICS].forEach((a, h) => {
      for (let j = 0; j < 64; j++) t![j] = t![j]! + a * sineCycles(((h + 1) * j) / 64);
    });
    let peak = 0;
    for (const v of t) peak = Math.max(peak, Math.abs(v));
    for (let j = 0; j < 64; j++) t[j] = t[j]! / peak;
  } else t = Float64Array.from(parsed);
  tableCache.set(spec, t);
  return t;
}

// ---- sources ------------------------------------------------------------------------------------------

const frac = (x: number): number => x - Math.floor(x);

function renderOsc(l: Layer, seed: number): Float64Array {
  const n = Math.round((l.p.dur as number) * SR);
  const out = new Float64Array(n);
  const wave = l.p.wave as string;
  const freq = param(l.p, l.envs, 'freq');
  const duty = param(l.p, l.envs, 'duty');
  let acc = 0;
  if (wave === 'white' || wave === 'pink' || wave === 'brown') {
    const rng = new Noise(seed);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < n; i++) {
      const w = rng.next();
      if (wave === 'white') out[i] = w;
      else if (wave === 'pink') {
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      } else {
        last = (last + 0.02 * w) / 1.02;
        out[i] = last * 3.5;
      }
    }
    return out;
  }
  if (wave === 'metal') {
    // A 15-bit shift register with the short feedback tap: a 93-step pattern, so the noise has a pitch.
    const rng = new Noise(seed);
    let s = 1 + Math.floor((rng.next() + 1) * 16383);
    let v = 1;
    for (let i = 0; i < n; i++) {
      out[i] = v;
      acc += Math.min(4, (freq(i) * 93) / SR);
      while (acc >= 1) {
        acc -= 1;
        const bit = (s ^ (s >> 6)) & 1;
        s = (s >> 1) | (bit << 14);
        v = s & 1 ? 1 : -1;
      }
    }
    return out;
  }
  const table = wave === 'wavetable' ? wavetable(l.p.table as string) : null;
  for (let i = 0; i < n; i++) {
    const ph = frac(acc);
    acc += freq(i) / SR;
    switch (wave) {
      case 'square': out[i] = ph < duty(i) ? 1 : -1; break;
      case 'saw': out[i] = 2 * frac(ph + 0.5) - 1; break;
      case 'triangle': out[i] = ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4; break;
      case 'pulse': {
        const d = duty(i);
        out[i] = ((ph < d ? 1 : 0) - d) / (d > 0.5 ? d : 1 - d);
        break;
      }
      case 'wavetable': {
        const m = table!.length;
        const pos = ph * m;
        const i0 = Math.floor(pos);
        const f = pos - i0;
        out[i] = table![i0]! * (1 - f) + table![(i0 + 1) % m]! * f;
        break;
      }
      default: out[i] = sineCycles(ph);
    }
  }
  return out;
}

function renderFm(l: Layer): Float64Array {
  const n = Math.round((l.p.dur as number) * SR);
  const out = new Float64Array(n);
  const ops = l.p.ops as number;
  const algo = l.p.algo as string;
  const freq = param(l.p, l.envs, 'freq');
  const ratio = [1, 2, 3, 4].map((k) => l.p[`ratio${k}`] as number);
  const index = [0, 2, 3, 4].map((k) => (k ? param(l.p, l.envs, `index${k}`) : () => 0));
  const level = [1, 2, 3, 4].map((k) => param(l.p, l.envs, `level${k}`));
  const ph = [0, 0, 0, 0];
  const o = [0, 0, 0, 0];
  const carriers = algo === 'chain' || algo === 'fan' ? 1 : algo === 'pairs' ? (ops >= 3 ? 2 : 1) : ops;
  for (let i = 0; i < n; i++) {
    const idx = [0, index[1]!(i), index[2]!(i), index[3]!(i)];
    if (algo === 'chain') {
      let m = 0;
      for (let k = ops - 1; k >= 0; k--) {
        o[k] = sineCycles(ph[k]! + m / TAU);
        m = k > 0 ? idx[k]! * o[k]! : 0;
      }
      out[i] = (level[0]!(i) * o[0]!) / carriers;
    } else if (algo === 'fan') {
      let m = 0;
      for (let k = 1; k < ops; k++) m += idx[k]! * sineCycles(ph[k]!);
      out[i] = (level[0]!(i) * sineCycles(ph[0]! + m / TAU)) / carriers;
    } else if (algo === 'pairs') {
      const a = sineCycles(ph[0]! + (ops >= 2 ? (idx[1]! * sineCycles(ph[1]!)) / TAU : 0));
      let sum = level[0]!(i) * a;
      if (ops >= 3) sum += level[2]!(i) * sineCycles(ph[2]! + (ops >= 4 ? (idx[3]! * sineCycles(ph[3]!)) / TAU : 0));
      out[i] = sum / carriers;
    } else {
      let sum = 0;
      for (let k = 0; k < ops; k++) sum += level[k]!(i) * sineCycles(ph[k]!);
      out[i] = sum / carriers;
    }
    const f = freq(i);
    for (let k = 0; k < ops; k++) ph[k] = ph[k]! + (f * ratio[k]!) / SR;
  }
  return out;
}

function renderKs(l: Layer, seed: number): Float64Array {
  const n = Math.round((l.p.dur as number) * SR);
  const out = new Float64Array(n);
  const f = l.p.freq as number;
  const period = SR / f;
  const L = Math.floor(period - 1);
  const dp = period - 0.5 - L; // the allpass supplies this fraction of a sample, in [0.5, 1.5)
  const c = (1 - dp) / (1 + dp);
  const g = exp2(-9.965784284662087 / (f * (l.p.decay as number))); // 0.001^(period / decay)
  const M = L + 2;
  const d = new Float64Array(M);
  const rng = new Noise(seed);
  const a = 0.05 + 0.95 * (l.p.bright as number);
  let e = 0;
  let mean = 0;
  for (let k = 0; k < M; k++) { e += a * (rng.next() - e); d[k] = e; mean += e; }
  mean /= M;
  let peak = 0;
  for (let k = 0; k < M; k++) { d[k] = d[k]! - mean; peak = Math.max(peak, Math.abs(d[k]!)); }
  if (peak > 0) for (let k = 0; k < M; k++) d[k] = (d[k]! / peak) * 0.9;
  let x1 = 0, y1 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = d[(((i - L) % M) + M) % M]!;
    const s1 = d[(((i - L - 1) % M) + M) % M]!;
    const avg = 0.5 * (s0 + s1);
    const ap = c * avg + x1 - c * y1;
    x1 = avg;
    y1 = ap;
    const u = g * ap;
    d[i % M] = u;
    out[i] = u;
  }
  return out;
}

function renderSample(l: Layer, bank: SampleBank | undefined, channel: 'left' | 'right' | null = null): Float64Array {
  const name = l.p.sample as string;
  const smp = name ? bank?.get(name) : undefined;
  if (!smp) return new Float64Array(Math.round(0.1 * SR)); // a missing sample is silence; the server refuses to write a batch that names one
  const side = channel ?? l.p.side;
  // a file at another rate is converted to 44,100 Hz first (resample.ts), so the trim and the pitch below work on the engine's own rate
  const sig = resample(side === 'left' && smp.left ? smp.left : side === 'right' && smp.right ? smp.right : smp.data, smp.rate, SR);
  const len = sig.length;
  const i0 = Math.min(len, Math.floor((l.p.start as number) * SR));
  const endSec = l.p.end as number;
  const i1 = endSec > 0 ? Math.min(len, Math.floor(endSec * SR)) : len;
  if (i1 - i0 < 2) return new Float64Array(Math.round(0.01 * SR));
  const reverse = l.p.reverse === 1;
  const pitch = param(l.p, l.envs, 'pitch');
  const cap = MAX_DURATION * SR;
  const out = new Float64Array(Math.min(cap, (i1 - i0) * 4 + 4)); // slow enough pitches are cut at the cap
  let pos = 0;
  const span = i1 - i0 - 1;
  let n = 0;
  while (pos <= span && n < out.length) {
    const j = Math.floor(pos);
    const fr = pos - j;
    const a = sig[reverse ? i1 - 1 - j : i0 + j]!;
    const b = sig[reverse ? i1 - 1 - Math.min(span, j + 1) : i0 + Math.min(span, j + 1)]!;
    out[n++] = a * (1 - fr) + b * fr;
    pos += exp2(pitch(n) / 12);
  }
  return out.slice(0, n);
}

/** One layer's source as doubles. */
function renderSource(s: LayeredSound, l: Layer, bank: SampleBank | undefined): Float64Array {
  switch (l.kind) {
    case 'classic': return renderClassic(layerPatch(l));
    case 'osc': return renderOsc(l, layerSeed(s, l));
    case 'fm': return renderFm(l);
    case 'ks': return renderKs(l, layerSeed(s, l));
    case 'sample': return renderSample(l, bank);
  }
}

// ---- the state-variable filter --------------------------------------------------------------------------

/** A zero-delay-feedback state-variable filter (Zavalishin): low-pass, high-pass, band-pass (peak gain 1) and notch from one core. At the cutoff a low-pass has gain Q. */
function runFilter(buf: Float64Array, type: string, cut: Reader, qr: Reader, dynamic: boolean): void {
  let ic1 = 0, ic2 = 0;
  let a1 = 0, a2 = 0, a3 = 0, k = 1;
  const n = buf.length;
  for (let i = 0; i < n; i++) {
    if (i === 0 || (dynamic && (i & 7) === 0)) {
      const fc = Math.min(Math.max(cut(i), 20), 0.45 * SR);
      const g = tanPi(fc / SR);
      k = 1 / qr(i);
      a1 = 1 / (1 + g * (g + k));
      a2 = g * a1;
      a3 = g * a2;
    }
    const x = buf[i]!;
    const v3 = x - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    buf[i] = type === 'lp' ? v2 : type === 'hp' ? x - k * v1 - v2 : type === 'bp' ? k * v1 : x - k * v1;
  }
}

// ---- effects ---------------------------------------------------------------------------------------------

const wetDry = (d: number, w: number, m: number): number => (m >= 1 ? w : m <= 0 ? d : d + (w - d) * m);

function shape(kind: string, v: number): number {
  switch (kind) {
    case 'hard': return v > 1 ? 1 : v < -1 ? -1 : v;
    case 'fold': {
      let w = v + 1;
      w -= 4 * Math.floor(w / 4);
      return w < 2 ? w - 1 : 3 - w;
    }
    case 'cubic': {
      const c = v > 1 ? 1 : v < -1 ? -1 : v;
      return 1.5 * (c - (c * c * c) / 3);
    }
    default: return v / (1 + Math.abs(v));
  }
}

const COMBS = [1116, 1188, 1277, 1356];
const ALLPASS = [556, 441];

/** The longest tail one effect is given room for, seconds. */
const MAX_FX_TAIL = 60;

/**
 * The seconds an effect keeps sounding after its input stops, which is the room the sound is given to hold it (an automatic length then
 * ends the sound where it is 60.3 dB down, so this only has to be long enough; the `tail` check asks for the same 60 dB).
 * A delay: the echoes until the feedback has taken them 66 dB down (an envelope on the feedback counts at its highest point).
 * A reverb: the time its longest comb filter takes to fall 60 dB at the room's feedback (0.7 + 0.28 size), about 0.6 s at size 0,
 * 1.3 s at 0.5 and 11 s at 1. Computed with the bit-built log2, so every machine gets the same length.
 */
export function fxTail(f: Fx): number {
  const mixOn = f.envs.mix !== undefined || (f.p.mix as number) > 0;
  if (f.kind === 'delay' && mixOn) {
    const fb = f.envs.feedback ? Math.max(...f.envs.feedback.map((p) => p.v)) : (f.p.feedback as number);
    const taps = fb > 0 ? 1 + Math.ceil(-LOG2_LEVEL_66DB / -log2(fb)) : 1;
    return Math.min(MAX_FX_TAIL, (f.p.time as number) * taps);
  }
  if (f.kind === 'reverb' && mixOn) {
    const fb = 0.7 + 0.28 * (f.p.size as number);
    return Math.min(MAX_FX_TAIL, (COMBS[COMBS.length - 1]! + 23) / SR * (EXP_DECAY_60DB / -log2(fb)) + 0.05);
  }
  return 0;
}

// log2 of 10^(-66/20) = 0.0005012: how far down the last echo is when a delay stops being given room
const LOG2_LEVEL_66DB = -10.9487;

const LOG2E = 1.4426950408889634;
const DB_TO_LOG2 = 0.16609640474436813; // 2^(dB * this) = 10^(dB / 20)
const LOG2_TO_DB = 6.020599913279624; // 20 * log10(2)

/**
 * A feed-forward compressor: a peak detector (one pole, `attack` when the level rises and `release` when it falls) in dB, and above
 * `threshold` the level is cut by (1 - 1/ratio) of the excess; `makeup` dB is added after. No look-ahead, so a transient faster than the
 * attack gets through (use `limit` for peaks). Only + - * / and the bit-built exp2 and log2: the same bytes on every machine.
 */
function runCompressor(buf: Float64Array, f: Fx): void {
  const n = buf.length;
  const thr = f.p.threshold as number;
  const slope = 1 - 1 / (f.p.ratio as number);
  const ca = exp2(-LOG2E / ((f.p.attack as number) * 0.001 * SR));
  const cr = exp2(-LOG2E / ((f.p.release as number) * 0.001 * SR));
  const makeup = exp2((f.p.makeup as number) * DB_TO_LOG2);
  let env = 0;
  for (let i = 0; i < n; i++) {
    const x = buf[i]!;
    const ax = x < 0 ? -x : x;
    env = ax > env ? ca * env + (1 - ca) * ax : cr * env + (1 - cr) * ax;
    const over = env > 1e-9 ? LOG2_TO_DB * log2(env) - thr : -1;
    buf[i] = over > 0 ? x * makeup * exp2(-over * slope * DB_TO_LOG2) : x * makeup;
  }
}

/**
 * A look-ahead peak limiter: no sample ends above `ceiling`. The gain that a peak needs is reached `lookahead` ms before the peak (a
 * running minimum over the window, averaged over it so the gain moves smoothly), and comes back with a one-pole `release`. The output has
 * no delay: the gain was already down when the peak arrives. In `mode=true` (the default) the peaks counted are those of the 4x oversampled
 * signal, found with the export limiter's kernel and kept 0.1 dB inside the ceiling; in `mode=sample` only the samples are.
 */
/** The gain each sample needs so that no sample (or, in true-peak mode, no point between samples) passes the ceiling, for samples lo..hi. */
function limiterNeed(buf: Float64Array, f: Fx, need: Float64Array, lo: number, hi: number, bmax: Float64Array | null): void {
  const n = buf.length;
  const ceil = exp2((f.p.ceiling as number) * DB_TO_LOG2);
  if (f.p.mode === 'sample') {
    for (let i = lo; i <= hi; i++) {
      const ax = buf[i]! < 0 ? -buf[i]! : buf[i]!;
      if (ax > ceil && ceil / ax < need[i]!) need[i] = ceil / ax;
    }
    return;
  }
  // true-peak mode: the points between the samples (4x oversampled, the export limiter's kernel) count too, 0.1 dB inside the ceiling;
  // the gain a point between samples i and i+1 needs is asked of both of them
  const c = ceil * LIM_MARGIN;
  const h = kernel();
  // a point between samples is a weighted sum of the 48 around it, so it cannot pass (the largest of them) x (the sum of the weights' sizes):
  // where the blocks around are that far under the ceiling the point is skipped, which leaves the answer exactly as it would be
  let wsum = 0;
  for (const row of h) { let t = 0; for (const w of row) t += w < 0 ? -w : w; if (t > wsum) wsum = t; }
  const nb = Math.ceil(n / 64);
  for (let i = lo; i <= hi; i++) {
    const x0 = buf[i]!;
    let pk = x0 < 0 ? -x0 : x0;
    if (pk > c && c / pk < need[i]!) need[i] = c / pk;
    pk = 0;
    const b = i >> 6;
    if (Math.max(bmax![b]!, b > 0 ? bmax![b - 1]! : 0, b + 1 < nb ? bmax![b + 1]! : 0) * wsum <= c) continue;
    for (let ph = 0; ph < 3; ph++) {
      const hp = h[ph]!;
      let acc = 0;
      if (i - LIM_HALF + 1 >= 0 && i + LIM_HALF < n) {
        // inside the buffer: the same sum without the bounds test
        for (let k = -LIM_HALF + 1; k <= LIM_HALF; k++) acc += buf[i + k]! * hp[k + LIM_HALF - 1]!;
      } else {
        for (let k = -LIM_HALF + 1; k <= LIM_HALF; k++) {
          const j = i + k;
          if (j >= 0 && j < n) acc += buf[j]! * hp[k + LIM_HALF - 1]!;
        }
      }
      const a = acc < 0 ? -acc : acc;
      if (a > pk) pk = a;
    }
    if (pk > c) {
      const g = c / pk;
      if (g < need[i]!) need[i] = g;
      if (i + 1 < n && g < need[i + 1]!) need[i + 1] = g;
    }
  }
}

/** What a limiter kept from its last run over a buffer: its input and the gain each sample needed (the page re-renders after small edits). */
export interface LimiterMemo {
  key: string;
  input: Float64Array;
  need: Float64Array;
}

function blockMax(buf: Float64Array): Float64Array {
  const bmax = new Float64Array(Math.ceil(buf.length / 64));
  for (let i = 0; i < buf.length; i++) { const a = buf[i]! < 0 ? -buf[i]! : buf[i]!; if (a > bmax[i >> 6]!) bmax[i >> 6] = a; }
  return bmax;
}

/**
 * A look-ahead peak limiter: no sample ends above `ceiling`. The gain that a peak needs is reached `lookahead` ms before the peak (a
 * running minimum over the window, averaged over it so the gain moves smoothly), and comes back with a one-pole `release`. The output has
 * no delay: the gain was already down when the peak arrives. In `mode=true` (the default) the peaks counted are those of the 4x oversampled
 * signal, found with the export limiter's kernel and kept 0.1 dB inside the ceiling; in `mode=sample` only the samples are.
 * With a memo of an earlier run over a buffer of the same length, the needed gain is worked out again only around the samples that
 * differ (a sample's need depends on the 49 samples around it), which gives the same numbers as working it all out.
 */
function runLimiter(buf: Float64Array, f: Fx, memo?: { value: LimiterMemo | null }): void {
  const n = buf.length;
  const key = `${f.p.ceiling}|${f.p.mode}`;
  const prev = memo?.value && memo.value.key === key && memo.value.input.length === n ? memo.value : null;
  const bmax = f.p.mode === 'sample' ? null : blockMax(buf);
  let need: Float64Array;
  if (prev) {
    need = prev.need;
    const R = LIM_HALF + 2;
    let i = 0;
    while (i < n) {
      if (prev.input[i] === buf[i]) { i++; continue; }
      // a run of changed samples (gaps shorter than the window joined)
      let j = i, last = i;
      while (j < n && j - last <= 2 * R) { if (prev.input[j] !== buf[j]) last = j; j++; }
      const lo = Math.max(0, i - R), hi = Math.min(n - 1, last + R);
      for (let k = lo; k <= hi; k++) need[k] = 1;
      limiterNeed(buf, f, need, Math.max(0, lo - 1), hi, bmax);
      i = last + 1;
    }
  } else {
    need = new Float64Array(n).fill(1);
    limiterNeed(buf, f, need, 0, n - 1, bmax);
  }
  if (memo) memo.value = { key, input: Float64Array.from(buf), need: Float64Array.from(need) };
  let any = false;
  for (let i = 0; i < n; i++) if (need[i]! < 1) { any = true; break; }
  if (!any) return;
  // (in true-peak mode the look-ahead is at least 1 ms, LIM_WINDOW samples: a point between samples depends on the 48 samples around it, so the gain has to be steady over them)
  const W = Math.max(f.p.mode === 'sample' ? 1 : LIM_WINDOW, Math.round((f.p.lookahead as number) * 0.001 * SR));
  // m[j] = the least gain needed in [j, j + W - 1] (a monotonic queue)
  const m = new Float64Array(n);
  const q = new Int32Array(n + W);
  let head = 0, tail = 0;
  for (let j = n - 1; j >= 0; j--) {
    while (tail > head && need[q[tail - 1]!]! >= need[j]!) tail--;
    q[tail++] = j;
    while (q[head]! > j + W - 1) head++;
    m[j] = need[q[head]!]!;
  }
  const cr = exp2(-LOG2E / ((f.p.release as number) * 0.001 * SR));
  let sum = W * m[0]!;
  let r = 1;
  for (let i = 0; i < n; i++) {
    if (i > 0) sum += m[i]! - (i - W >= 0 ? m[i - W]! : m[0]!);
    const a = sum / W;
    const rel = 1 - (1 - r) * cr;
    r = a < rel ? a : rel;
    buf[i] = buf[i]! * r;
  }
}

function runFx(buf: Float64Array, f: Fx, channel: number): void {
  const n = buf.length;
  const P = (name: string): Reader => param(f.p, f.envs, name);
  const dynamic = (name: string): boolean => f.envs[name] !== undefined;
  switch (f.kind) {
    case 'filter':
      runFilter(buf, f.p.type as string, P('cutoff'), P('q'), dynamic('cutoff') || dynamic('q'));
      return;
    case 'distort': {
      const drive = P('drive'), mix = P('mix');
      const kind = f.p.shape as string;
      for (let i = 0; i < n; i++) buf[i] = wetDry(buf[i]!, shape(kind, buf[i]! * drive(i)), mix(i));
      return;
    }
    case 'bitcrush': {
      const step = exp2(1 - (f.p.bits as number));
      const rate = P('rate'), mix = P('mix');
      let acc = 1, held = 0;
      for (let i = 0; i < n; i++) {
        acc += rate(i) / SR;
        if (acc >= 1) { acc -= 1; held = Math.round(buf[i]! / step) * step; }
        buf[i] = wetDry(buf[i]!, held, mix(i));
      }
      return;
    }
    case 'chorus': {
      const size = 4096;
      const line = new Float64Array(size);
      const depth = P('depth'), mix = P('mix');
      const rate = f.p.rate as number;
      const base = ((f.p.delay as number) / 1000) * SR;
      for (let i = 0; i < n; i++) {
        line[i % size] = buf[i]!;
        const d = base + ((depth(i) / 1000) * SR) * sineCycles((i / SR) * rate);
        const pos = i - d;
        const j = Math.floor(pos);
        const fr = pos - j;
        const a = j >= 0 ? line[((j % size) + size) % size]! : 0;
        const b = j + 1 >= 0 ? line[(((j + 1) % size) + size) % size]! : 0;
        buf[i] = wetDry(buf[i]!, a * (1 - fr) + b * fr, mix(i));
      }
      return;
    }
    case 'delay': {
      const len = Math.max(1, Math.round((f.p.time as number) * SR));
      const line = new Float64Array(len);
      const fb = P('feedback'), mix = P('mix');
      for (let i = 0; i < n; i++) {
        const wet = line[i % len]!;
        const dry = buf[i]!;
        line[i % len] = dry + wet * fb(i);
        buf[i] = wetDry(dry, wet, mix(i));
      }
      return;
    }
    case 'compress': runCompressor(buf, f); return;
    case 'limit': runLimiter(buf, f); return;
    case 'reverb': {
      const size = f.p.size as number;
      const fb = 0.7 + 0.28 * size;
      const damp = 0.4 * (f.p.damp as number);
      const mix = P('mix');
      const spread = channel * 23;
      const inGain = 0.5 * Math.sqrt(1 - fb * fb);
      const combs = COMBS.map((c) => ({ line: new Float64Array(c + spread), pos: 0, filt: 0 }));
      const aps = ALLPASS.map((c) => ({ line: new Float64Array(c + spread), pos: 0 }));
      for (let i = 0; i < n; i++) {
        const dry = buf[i]!;
        const x = dry * inGain;
        let sum = 0;
        for (const c of combs) {
          const y = c.line[c.pos]!;
          c.filt = y * (1 - damp) + c.filt * damp;
          c.line[c.pos] = x + c.filt * fb;
          if (++c.pos === c.line.length) c.pos = 0;
          sum += y;
        }
        for (const a of aps) {
          const y = a.line[a.pos]!;
          a.line[a.pos] = sum + y * 0.5;
          sum = y - sum;
          if (++a.pos === a.line.length) a.pos = 0;
        }
        buf[i] = wetDry(dry, sum, mix(i));
      }
      return;
    }
  }
}

// ---- layers and the sound ----------------------------------------------------------------------------------

const FADE = 88; // 2 ms

interface Built {
  layer: Layer;
  index: number;
  offset: number;
  buf: Float64Array;
  /** Samples of the layer's source (the buffer is longer by the room its effects' tails may need). */
  src: number;
  /** A stereo sample layer (`side=stereo`): the right channel; `buf` is the left. */
  right?: Float64Array;
}

/** A sample layer with no envelope and no trim plays the file as it is: no fade, no cut (so `measure` of a reference equals the file). */
function playsAsIs(l: Layer): boolean {
  return l.kind === 'sample' && !l.amp && l.p.start === 0 && l.p.end === 0;
}

/** A layer's source through its filter, envelope, effects and gain. `channel` is which channel of a stereo layer this is (it decides what the effects hear). */
function buildLayer(s: LayeredSound, l: Layer, bank: SampleBank | undefined, src: Float64Array = renderSource(s, l, bank), channel = 0): { buf: Float64Array; src: number } {
  let tail = 0;
  for (const f of l.fx) tail += fxTail(f);
  const tailSamples = Math.min(MAX_DURATION * SR, Math.round(tail * SR));
  const buf = new Float64Array(src.length + tailSamples);
  buf.set(src);
  const type = l.p.filter as string;
  if (type !== 'off') runFilter(buf, type, param(l.p, l.envs, 'cutoff'), param(l.p, l.envs, 'q'), l.envs.cutoff !== undefined || l.envs.q !== undefined);
  if (l.amp) {
    const r = envReader(l.amp);
    for (let i = 0; i < buf.length; i++) buf[i] = buf[i]! * r(i);
  } else if (l.kind !== 'classic' && !playsAsIs(l)) {
    // No amplitude envelope: a 2 ms fade at both ends of the source, so a layer never clicks.
    const len = src.length;
    for (let i = 0; i < Math.min(FADE, len); i++) buf[i] = buf[i]! * (i / FADE);
    for (let i = Math.max(0, len - FADE); i < len; i++) buf[i] = buf[i]! * ((len - 1 - i) / FADE);
  }
  for (const f of l.fx) runFx(buf, f, channel);
  if (l.envs.gain) {
    const r = envReader(l.envs.gain);
    for (let i = 0; i < buf.length; i++) buf[i] = buf[i]! * r(i);
  } else if (l.p.gain !== 1) {
    const g = l.p.gain as number;
    for (let i = 0; i < buf.length; i++) buf[i] = buf[i]! * g;
  }
  return { buf, src: src.length };
}

/** Constant-power pan gains for a pan position in -1..1. */
export function panGains(pan: number): [number, number] {
  const theta = ((pan + 1) * Math.PI) / 4;
  return [sinRad(theta + Math.PI / 2), sinRad(theta)];
}

/** How many samples a layered sound lasts. */
function totalLength(s: LayeredSound, built: Built[]): number {
  if (s.duration !== null) return Math.round(s.duration * SR);
  let n = built.length ? 1 : 441;
  for (const b of built) n = Math.max(n, b.offset + b.buf.length);
  let tail = 0;
  for (const f of s.master) tail += fxTail(f);
  return Math.min(MAX_DURATION * SR, n + Math.round(tail * SR));
}

function buildOne(s: LayeredSound, layer: Layer, bank: SampleBank | undefined): Omit<Built, 'layer' | 'index' | 'offset'> {
  if (layer.kind === 'sample' && layer.p.side === 'stereo') {
    const left = buildLayer(s, layer, bank, renderSample(layer, bank, 'left'), 0);
    const right = buildLayer(s, layer, bank, renderSample(layer, bank, 'right'), 1);
    return { buf: left.buf, src: left.src, right: right.buf };
  }
  return buildLayer(s, layer, bank);
}

function buildAll(s: LayeredSound, bank: SampleBank | undefined): Built[] {
  return audibleLayers(s).map((layer) => ({ layer, index: s.layers.indexOf(layer), offset: Math.round((layer.p.offset as number) * SR), ...buildOne(s, layer, bank) }));
}

/** A built layer placed in the sound's timeline: one array per channel, pan applied, `n` samples long. */
function place(b: Built, n: number, stereo: boolean): Float64Array[] {
  const chans = stereo ? [new Float64Array(n), new Float64Array(n)] : [new Float64Array(n)];
  const panEnv = b.layer.envs.pan ? envReader(b.layer.envs.pan) : null;
  const pan = b.layer.p.pan as number;
  const [gl, gr] = panGains(pan);
  for (let i = 0; i < b.buf.length; i++) {
    const j = b.offset + i;
    if (j >= n) break;
    const v = b.buf[i]!;
    if (b.right) {
      // a stereo sample layer: each channel stays on its side
      chans[0]![j] = v;
      if (stereo) chans[1]![j] = b.right[i]!;
    } else if (!stereo) chans[0]![j] = v;
    else if (panEnv) {
      const [l, r] = panGains(panEnv(i));
      chans[0]![j] = v * l;
      chans[1]![j] = v * r;
    } else {
      chans[0]![j] = v * gl;
      chans[1]![j] = v * gr;
    }
  }
  return chans;
}

/** The sound's channels: one when no layer is panned, else two (left, right). Float32. */
/**
 * A looping sound is rendered `fade` seconds past its length and folded: the part past the end is
 * crossfaded (equal power, so uncorrelated noise keeps its level) over the first `fade` seconds. The
 * last sample then runs straight into the first (sample L of the long render is the natural next
 * sample after L-1), with no click and no dip in level. The fold uses the render's own continuation
 * and not a copy of the start, so reverb and delay tails wrap around too.
 */
function renderLoop(s: LayeredSound, bank: SampleBank | undefined): Float32Array[] {
  const L = Math.round(s.loop!.length * SR);
  const T = Math.min(L, Math.round(s.loop!.fade * SR));
  const raw = renderLayered({ ...s, loop: undefined, duration: (L + T) / SR }, bank);
  return raw.map((ch) => {
    const out = new Float32Array(L);
    for (let i = 0; i < L; i++) {
      if (i >= T) { out[i] = ch[i] ?? 0; continue; }
      const u = i / T;
      out[i] = (ch[i] ?? 0) * sineCycles(u / 4) + (ch[L + i] ?? 0) * sineCycles(u / 4 + 0.25);
    }
    return out;
  });
}

export function renderLayered(s: LayeredSound, bank?: SampleBank): Float32Array[] {
  if (s.loop) return renderLoop(s, bank);
  const built = buildAll(s, bank);
  const stereo = isStereo(s);
  const n = totalLength(s, built);
  const mix = stereo ? [new Float64Array(n), new Float64Array(n)] : [new Float64Array(n)];
  for (const b of built) {
    const placed = place(b, n, stereo);
    for (let c = 0; c < mix.length; c++) for (let i = 0; i < n; i++) mix[c]![i] = mix[c]![i]! + placed[c]![i]!;
  }
  mix.forEach((ch, c) => {
    if (s.gain !== 1) for (let i = 0; i < n; i++) ch[i] = ch[i]! * s.gain;
    for (const f of s.master) runFx(ch, f, c);
    if (s.out) { const g = exp2(s.out * DB_TO_LOG2); for (let i = 0; i < n; i++) ch[i] = ch[i]! * g; } // the output level, after the master chain
  });
  let end = n;
  if (s.duration === null) {
    // An automatic length ends where the sound has died away: the last sample within 60.3 dB of the peak, wherever that is (inside a layer's source too). The layers' lengths and the effects' tails only said how much room to leave.
    let peak = 0;
    for (const ch of mix) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(ch[i]!));
    const floor = peak * DIED_AWAY;
    let last = 0;
    for (const ch of mix) for (let i = n - 1; i > last; i--) if (Math.abs(ch[i]!) >= floor) { last = i; break; }
    // A classic layer is the classic voice as it is (layer-up keeps the very samples), so the sound is never cut inside one.
    let floorEnd = 1;
    for (const b of built) if (b.layer.kind === 'classic' || playsAsIs(b.layer)) floorEnd = Math.max(floorEnd, b.offset + b.src);
    // (a run of less than 1 ms at the end is not worth a cut: the sound keeps the length its layers give it)
    end = Math.max(1, Math.min(n, Math.max(n - last - 1 > 44 ? last + 1 : n, floorEnd)));
    // The 3 ms fade below can leave nothing above the floor in a short piece at the very end (the first part of a late echo or of a reverb's
    // last ripple): the piece is then inaudible and the sound ends where the audible part before it did, so that `trailingSilence` (what the
    // `tail` check measures from the same floor) is the 3 ms of fade and not the gap.
    while (end < n && end > floorEnd + 1) {
      const fade = Math.min(132, end - floorEnd + 1);
      let faded = false;
      let before = -1;
      for (const ch of mix) {
        for (let i = end - 1; i >= end - fade && !faded; i--) if (Math.abs(ch[i]!) * ((end - 1 - i) / fade) >= floor) faded = true;
        for (let i = end - fade - 1; i > before; i--) if (Math.abs(ch[i]!) >= floor) { before = i; break; }
      }
      if (faded || before < floorEnd) break;
      end = before + 1;
    }
    if (end < n && end > floorEnd) {
      // the sound was cut where it is 60 dB down (inside a layer's source too, but not a classic layer's, or where a tail was still just audible): close it with a 3 ms fade, so it ends at zero
      const fade = Math.min(132, end - floorEnd + 1);
      for (const ch of mix) for (let i = 0; i < fade; i++) ch[end - 1 - i] = ch[end - 1 - i]! * (i / fade);
    }
  }
  return mix.map((ch) => Float32Array.from(ch.subarray(0, end)));
}

export interface LayerPart {
  index: number;
  layer: Layer;
  /** The layer as it enters the sum (filter, envelope, effects, gain and pan applied), placed in the sound's timeline. */
  channels: Float32Array[];
}

/** Each sounding layer on its own, before the master chain: what the `layers` view draws. */
export function renderParts(s: LayeredSound, bank?: SampleBank): { length: number; stereo: boolean; parts: LayerPart[] } {
  const built = buildAll(s, bank);
  const stereo = isStereo(s);
  const length = renderLayered(s, bank)[0]!.length;
  return { length, stereo, parts: built.map((b) => ({ index: b.index, layer: b.layer, channels: place(b, length, stereo).map((c) => Float32Array.from(c)) })) };
}

export function layeredChannelCount(s: LayeredSound): number {
  return isStereo(s) ? 2 : 1;
}

// ---- the limiter (applied on export) --------------------------------------------------------------------------

const LIM_WINDOW = 48; // about 1 ms of look-ahead and smoothing
const LIM_MARGIN = 0.9885; // 0.1 dB inside the ceiling, for the difference between interpolators
const LIM_HALF = 24;
let limKernel: Float64Array[] | null = null;

function kernel(): Float64Array[] {
  if (limKernel) return limKernel;
  limKernel = [];
  for (let ph = 1; ph <= 3; ph++) {
    const d = ph / 4;
    const h = new Float64Array(2 * LIM_HALF);
    let sum = 0;
    for (let k = -LIM_HALF + 1; k <= LIM_HALF; k++) {
      const x = k - d;
      const px = Math.PI * x;
      const sinc = sinRad(px) / px;
      const u = (x + LIM_HALF) / (2 * LIM_HALF); // 0..1 across the window (Blackman)
      const w = 0.42 - 0.5 * sinRad(2 * Math.PI * u + Math.PI / 2) + 0.08 * sinRad(4 * Math.PI * u + Math.PI / 2);
      h[k + LIM_HALF - 1] = sinc * w;
      sum += sinc * w;
    }
    for (let k = 0; k < h.length; k++) h[k] = h[k]! / sum;
    limKernel.push(h);
  }
  return limKernel;
}

/**
 * A look-ahead peak limiter: no sample, and no point between samples (4x oversampled), goes
 * above the ceiling (dBTP, 0.1 dB of margin inside it). Under the ceiling it changes nothing (the
 * gain is exactly 1). Returns the new channels and the largest gain reduction in dB.
 */
export function limitChannels(chans: readonly Float32Array[], ceilingDb: number): { channels: Float32Array[]; reductionDb: number } {
  const n = chans[0]?.length ?? 0;
  const ceil = exp2(ceilingDb * 0.16609640474436813) * LIM_MARGIN; // 10^(dB/20)
  const need = new Float64Array(n).fill(1);
  const h = kernel();
  let any = false;
  for (const x of chans) {
    for (let i = 0; i < n; i++) {
      let pk = Math.abs(x[i]!);
      if (pk * 1 < ceil * 0.5) continue; // far below the ceiling: the interpolated points cannot reach it
      for (let ph = 0; ph < 3; ph++) {
        let acc = 0;
        for (let k = -LIM_HALF + 1; k <= LIM_HALF; k++) {
          const j = i + k;
          if (j >= 0 && j < n) acc += x[j]! * h[ph]![k + LIM_HALF - 1]!;
        }
        if (Math.abs(acc) > pk) pk = Math.abs(acc);
      }
      if (pk > ceil) { const g = ceil / pk; if (g < need[i]!) need[i] = g; any = true; }
    }
  }
  if (!any) return { channels: chans.map((c) => c.slice()), reductionDb: 0 };
  // M[j] = the least gain needed in [j, j + W - 1]; the gain at i averages M[i - W + 1 .. i], each of which covers i.
  const W = LIM_WINDOW;
  const m = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    let lo = 1;
    for (let k = j; k < Math.min(n, j + W); k++) if (need[k]! < lo) lo = need[k]!;
    m[j] = lo;
  }
  const gain = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0) { for (let k = 0; k < W; k++) sum += m[0]!; } else sum += m[i]! - (i - W >= 0 ? m[i - W]! : m[0]!);
    gain[i] = sum / W;
  }
  let worst = 1;
  for (let i = 0; i < n; i++) if (gain[i]! < worst) worst = gain[i]!;
  return {
    channels: chans.map((x) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = x[i]! * gain[i]!; return o; }),
    reductionDb: worst < 1 ? -20 * (log2(worst) * 0.30102999566398120) : 0,
  };
}


// ---- an effects chain over channels (the master chain of a song) ----------------------------------------------

/** Run an effects chain over channels in place, in list order, each channel on its own (as a sound's master chain does). */
/**
 * Run a chain of effects over each channel. `memo` (one slot per channel) lets a limiter at the head of the
 * chain reuse what it worked out last time over the same length of audio (the same samples come out).
 */
export function applyFxChain(chans: readonly Float64Array[], fx: readonly Fx[], memo?: { value: LimiterMemo | null }[]): void {
  chans.forEach((ch, c) => {
    fx.forEach((f, k) => {
      if (k === 0 && f.kind === 'limit' && memo?.[c]) runLimiter(ch, f, memo[c]);
      else runFx(ch, f, c);
    });
  });
}
