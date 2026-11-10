// Material for the tests of audio in sounds and songs: a bank of samples made from integers and the engine's own sine.

import { SAMPLE_RATE, sinRad, type SampleBank, type SampleData } from '../src/index.ts';
import { lcg } from './audio-fixtures.ts';

const SR = SAMPLE_RATE;
const TAU = 6.283185307179586;

/** A steady tone at `hz` for `secs` as sample data at the engine's rate. */
export function tone(hz: number, secs: number, level = 0.5): Float32Array {
  const n = Math.round(secs * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = level * sinRad(TAU * hz * (i / SR));
  return x;
}

/** `count` short noise bursts, `every` seconds apart, from 0 (a recording of a drum loop at a tempo). */
export function clickTrain(count: number, every: number, tail = 0.2): Float32Array {
  const n = Math.round((count * every + tail) * SR);
  const x = new Float32Array(n);
  const r = lcg(5);
  const len = Math.round(0.03 * SR);
  for (let k = 0; k < count; k++) {
    const at = Math.round(k * every * SR);
    for (let i = 0; i < len && at + i < n; i++) x[at + i] = (r() * 2 - 1) * 0.8 * (1 - i / len);
  }
  return x;
}

/** Noise that dies away: an impulse response of a room. */
export function room(secs: number, seed: number, rate = SR): Float32Array {
  const n = Math.round(secs * rate);
  const x = new Float32Array(n);
  const r = lcg(seed);
  for (let i = 0; i < n; i++) { const u = 1 - i / n; x[i] = (r() * 2 - 1) * u * u * u; }
  return x;
}

const DATA: Record<string, SampleData> = {
  tone: { rate: SR, data: tone(440, 1.5) },
  beat: { rate: SR, data: clickTrain(4, 60 / 90) },
  // a tone on the left and nothing on the right
  wide: { rate: SR, data: tone(330, 1, 0.25), left: tone(330, 1, 0.5), right: new Float32Array(SR) },
  room: { rate: SR, data: room(0.5, 3) },
  hall: { rate: SR, data: room(0.6, 4), left: room(0.6, 4), right: room(0.6, 9) },
  spike: { rate: SR, data: Float32Array.of(1, 0, 0, 0, 0, 0, 0, 0) },
  late: { rate: SR, data: (() => { const x = new Float32Array(4411); x[4410] = 1; return x; })() },
  bed: { rate: SR, data: (() => { const x = tone(300, 1.2, 0.3); const y = clickTrain(6, 0.2, 0); for (let i = 0; i < x.length; i++) x[i] = x[i]! + (y[i] ?? 0) * 0.5; return x; })() },
};

export const AUDIO_BANK: SampleBank = {
  get: (n) => DATA[n],
  hash: (n) => (DATA[n] ? `test-${n}` : undefined),
};

export const rms = (x: ArrayLike<number>, from = 0, to = x.length): number => {
  let s = 0;
  const a = Math.max(0, Math.round(from)), b = Math.min(x.length, Math.round(to));
  for (let i = a; i < b; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, b - a));
};

/** The first index at or after `from` where |x| is above `level`. */
export function firstOver(x: ArrayLike<number>, level = 0.01, from = 0): number {
  for (let i = Math.max(0, Math.round(from)); i < x.length; i++) if (Math.abs(x[i]!) > level) return i;
  return -1;
}

/** Hz from the positive-going zero crossings in a stretch of a steady tone. */
export function crossingsHz(x: ArrayLike<number>, from: number, to: number): number {
  const a = Math.round(from), b = Math.round(to);
  const at: number[] = [];
  for (let i = Math.max(1, a); i < Math.min(x.length, b); i++) if (x[i - 1]! <= 0 && x[i]! > 0) at.push(i - 1 + -x[i - 1]! / (x[i]! - x[i - 1]!));
  if (at.length < 3) return 0;
  return (SR * (at.length - 1)) / (at[at.length - 1]! - at[0]!);
}
