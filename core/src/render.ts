// The deterministic renderer. Pure functions over Float32Array: no platform APIs, no clock, no
// Math.sin (a sine built from + - * / alone, which IEEE-754 fixes exactly), so Node and the
// browser, now and in a year, produce the same samples bit for bit.

import { renderClassic } from './classic.ts';
import { RENDER_VERSION, SAMPLE_RATE, type Sound } from './sound.ts';

const TAU = 6.283185307179586;

/** sin(2π·cycles) for any phase, from a Taylor polynomial on [-π/2, π/2] (error below 1e-11). */
export function sineCycles(cycles: number): number {
  let p = cycles - Math.floor(cycles); // [0, 1)
  // Fold into [-1/4, 1/4] cycles using the sine's symmetries.
  if (p > 0.75) p -= 1;
  else if (p > 0.25) p = 0.5 - p;
  const x = p * TAU;
  const x2 = x * x;
  return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800 + x2 * (1 / 6227020800 + x2 * (-1 / 1307674368000))))))));
}

/** Number of samples a sound lasts. */
export function sampleCount(s: { duration: number }): number {
  return Math.round(s.duration * SAMPLE_RATE);
}

/** The sound as 44,100 Hz mono doubles: for the classic voice exactly what the reference synth makes (the engine's WAVs quantise these). */
export function renderExact(s: Sound): Float64Array {
  if (s.voice === 'classic') return renderClassic(s.patch);
  const n = sampleCount(s);
  const out = new Float64Array(n);
  const step = s.frequency / SAMPLE_RATE;
  for (let i = 0; i < n; i++) out[i] = Math.fround(s.volume * sineCycles(i * step));
  return out;
}

/** The sound as 44,100 Hz mono samples (what is played, cached and measured). */
export function renderSound(s: Sound): Float32Array {
  if (s.voice === 'classic') return Float32Array.from(renderClassic(s.patch));
  const n = sampleCount(s);
  const out = new Float32Array(n);
  const step = s.frequency / SAMPLE_RATE;
  for (let i = 0; i < n; i++) out[i] = s.volume * sineCycles(i * step);
  return out;
}

export { RENDER_VERSION, SAMPLE_RATE };

/** Peak and RMS of samples (numbers an agent can read, since it cannot listen). */
export function levels(samples: Float32Array): { peak: number; rms: number } {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]!);
    if (a > peak) peak = a;
    sum += samples[i]! * samples[i]!;
  }
  return { peak, rms: samples.length ? Math.sqrt(sum / samples.length) : 0 };
}

/** Min and max of each of `columns` equal slices, for waveform thumbnails. */
export function peaks(samples: Float32Array, columns: number): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(columns);
  const max = new Float32Array(columns);
  for (let c = 0; c < columns; c++) {
    const a = Math.floor((c * samples.length) / columns);
    const b = Math.max(a + 1, Math.floor(((c + 1) * samples.length) / columns));
    let lo = 0;
    let hi = 0;
    for (let i = a; i < b && i < samples.length; i++) {
      const v = samples[i]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[c] = lo;
    max[c] = hi;
  }
  return { min, max };
}
