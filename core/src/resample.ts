// Sample-rate conversion of imported samples to the engine's 44,100 Hz: a windowed-sinc interpolator.
// Deterministic like the rest of the renderer (the kernel is built with fdlibm's sine and + - * /
// only), so Node and the browser resample to the same bytes.
//
// The method (stated to the user on import and in docs/commands.md): each output sample is a sum of
// the input samples around its position, weighted by a Blackman-windowed sinc kernel whose cut-off
// is 95% of the lower of the two Nyquist frequencies (so a 48 or 96 kHz file is low-passed under
// 20.9 kHz before it is read at 44.1 kHz and nothing folds back), a kernel long enough for a
// transition band of 5% of the lower Nyquist rate on each side of the cut-off. The kernel is
// tabulated at 128 phases per input sample and interpolated linearly between them. A passband gain of
// 1 means a tone below the cut-off keeps its level, so the loudness of the file is kept.

import { sinRad } from './mathx.ts';

const PHASES = 128;

/** The method in one line, for the import report. */
export function resampleMethod(from: number, to: number): string {
  return `resampled ${from} -> ${to} Hz with a Blackman-windowed sinc (cut-off 95% of the lower Nyquist, ${(0.95 * Math.min(from, to) / 2 / 1000).toFixed(1)} kHz; passband gain 1)`;
}

interface Kernel {
  /** The half-width, in input samples. */
  half: number;
  table: Float64Array;
}

function buildKernel(from: number, to: number): Kernel {
  const low = Math.min(from, to);
  const f0 = (0.95 * low) / 2 / from; // cut-off, cycles per input sample
  const transition = (0.05 * low) / 2 / from; // cycles per input sample (about)
  const half = Math.max(8, Math.ceil(3.5 / (2 * transition)));
  const size = half * PHASES + 2;
  const table = new Float64Array(size);
  for (let k = 0; k < size; k++) {
    const x = k / PHASES;
    if (x >= half) break;
    const a = 2 * Math.PI * f0 * x;
    const sinc = k === 0 ? 2 * f0 : (2 * f0 * sinRad(a)) / a;
    const u = (x + half) / (2 * half); // 0..1 across the window
    const w = 0.42 - 0.5 * sinRad(2 * Math.PI * u + Math.PI / 2) + 0.08 * sinRad(4 * Math.PI * u + Math.PI / 2);
    table[k] = sinc * w;
  }
  return { half, table };
}

const cache = new WeakMap<Float32Array, Map<number, Float32Array>>();

/** `x`, recorded at `from` Hz, as it sounds at `to` Hz (same duration). Returns `x` itself when the rates are equal. Cached per array. */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  let byRate = cache.get(x);
  if (!byRate) cache.set(x, (byRate = new Map()));
  const have = byRate.get(from * 1e6 + to);
  if (have) return have;
  const { half, table } = buildKernel(from, to);
  const ratio = from / to;
  const n = Math.max(1, Math.round((x.length * to) / from));
  const out = new Float32Array(n);
  const len = x.length;
  for (let m = 0; m < n; m++) {
    const p = m * ratio;
    const j0 = Math.max(0, Math.ceil(p - half));
    const j1 = Math.min(len - 1, Math.floor(p + half));
    let acc = 0;
    for (let j = j0; j <= j1; j++) {
      const d = p - j;
      const e = (d < 0 ? -d : d) * PHASES;
      const k = Math.floor(e);
      const fr = e - k;
      acc += x[j]! * (table[k]! * (1 - fr) + table[k + 1]! * fr);
    }
    out[m] = acc;
  }
  byRate.set(from * 1e6 + to, out);
  return out;
}
