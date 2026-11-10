// Reading a signal at a fractional position: linear, cubic (Catmull-Rom) and a windowed sinc whose cut-off
// follows the playback ratio, so reading faster than the signal was made does not fold high content back
// below Nyquist. Deterministic like the rest of the renderer: kernels are built with fdlibm's sine and
// + - * / only, and tabulated at 128 phases per input sample.

import { sinRad } from './mathx.ts';

export type Interp = 'sinc' | 'cubic' | 'linear';
export const INTERPS: readonly Interp[] = ['sinc', 'cubic', 'linear'];

const PHASES = 128;
/** Half-width of the sinc kernel, in input samples, when the cut-off is at its widest. */
const HALF = 16;
/** The cut-off is quantised to this many steps between 0 and 1 of its widest. */
const STEPS = 64;

/** `a*(1-fr)+b*fr` at `pos`, with the second neighbour clamped to `last` (the legacy sample layer's edge rule). */
export function linearAt(sig: ArrayLike<number>, pos: number, last: number): number {
  const j = Math.floor(pos);
  const fr = pos - j;
  const a = sig[j]!;
  const b = sig[Math.min(last, j + 1)]!;
  return a * (1 - fr) + b * fr;
}

interface Kernel {
  half: number;
  table: Float64Array;
}

const kernels = new Map<number, Kernel>();

/** The kernel for a cut-off of `step/STEPS` of the widest: sinc(2·fc·x) windowed by a Blackman window, passband gain 1. */
function kernelFor(step: number): Kernel {
  const have = kernels.get(step);
  if (have) return have;
  const f = step / STEPS;
  // At the signal's own pitch or lower (the widest kernel) nothing needs cutting: the kernel is the plain band-limited interpolator, which is exactly 1 at a whole frame and 0 at the others.
  // Above it the cut-off is 95% of the lowered Nyquist, so nothing folds back.
  const fc = step === STEPS ? 0.5 : 0.95 * 0.5 * f; // cycles per input sample
  const half = Math.ceil(HALF / f);
  const size = half * PHASES + 2;
  const table = new Float64Array(size);
  for (let k = 0; k < size; k++) {
    const x = k / PHASES;
    if (x >= half) break;
    const a = 2 * Math.PI * fc * x;
    const sinc = k === 0 ? 2 * fc : (2 * fc * sinRad(a)) / a;
    const u = (x + half) / (2 * half);
    const w = 0.42 - 0.5 * sinRad(2 * Math.PI * u + Math.PI / 2) + 0.08 * sinRad(4 * Math.PI * u + Math.PI / 2);
    table[k] = sinc * w;
  }
  const k: Kernel = { half, table };
  kernels.set(step, k);
  return k;
}

/**
 * The signal's value at a fractional frame, zero outside [0, length). `ratio` is how many input frames one output
 * frame advances at this point; at a ratio of 1 or less the sinc reader is the plain band-limited interpolator (a whole frame reads as the sample
 * itself), above 1 its cut-off is 95% of the lowered Nyquist.
 */
export function readerFor(mode: Interp, sig: Float32Array): (pos: number, ratio: number) => number {
  const len = sig.length;
  if (mode === 'linear') {
    return (pos) => {
      if (pos < 0 || pos > len - 1) return 0;
      return linearAt(sig, pos, len - 1);
    };
  }
  if (mode === 'cubic') {
    return (pos) => {
      if (pos < 0 || pos > len - 1) return 0;
      const j = Math.floor(pos);
      const t = pos - j;
      const p0 = sig[j > 0 ? j - 1 : 0]!;
      const p1 = sig[j]!;
      const p2 = sig[j + 1 < len ? j + 1 : len - 1]!;
      const p3 = sig[j + 2 < len ? j + 2 : len - 1]!;
      return p1 + 0.5 * t * ((p2 - p0) + t * ((2 * p0 - 5 * p1 + 4 * p2 - p3) + t * (3 * (p1 - p2) + p3 - p0)));
    };
  }
  return (pos, ratio) => {
    if (pos < 0 || pos > len - 1) return 0;
    if (ratio <= 1 && pos === Math.floor(pos)) return sig[pos]!;
    const f = ratio > 1 ? 1 / ratio : 1;
    let step = Math.floor(f * STEPS);
    if (step < 1) step = 1;
    const { half, table } = kernelFor(step);
    const j0 = Math.max(0, Math.ceil(pos - half));
    const j1 = Math.min(len - 1, Math.floor(pos + half));
    let acc = 0;
    for (let j = j0; j <= j1; j++) {
      const d = pos - j;
      const e = (d < 0 ? -d : d) * PHASES;
      const k = Math.floor(e);
      const fr = e - k;
      acc += sig[j]! * (table[k]! * (1 - fr) + table[k + 1]! * fr);
    }
    return acc;
  };
}
