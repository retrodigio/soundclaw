// The deterministic renderer. Pure functions over Float32Array: no platform APIs, no clock, no
// Math.sin (a sine built from + - * / alone, which IEEE-754 fixes exactly), so Node and the
// browser, now and in a year, produce the same samples bit for bit.

import { renderClassic } from './classic.ts';
import { sineCycles } from './mathx.ts';
import { RENDER_VERSION, SAMPLE_RATE, type Sound } from './sound.ts';
import { layeredChannelCount, renderLayered, type SampleBank } from './synth.ts';

/** Number of samples a sound lasts. */
export function sampleCount(s: { duration: number }): number {
  return Math.round(s.duration * SAMPLE_RATE);
}

/** The sound as 44,100 Hz mono doubles: for the classic voice exactly what the reference synth makes (the engine's WAVs quantise these). */
export function renderExact(s: Sound, bank?: SampleBank): Float64Array {
  if (s.voice === 'classic') return renderClassic(s.patch);
  if (s.voice === 'layered') return Float64Array.from(renderSound(s, bank));
  const n = sampleCount(s);
  const out = new Float64Array(n);
  const step = s.frequency / SAMPLE_RATE;
  for (let i = 0; i < n; i++) out[i] = Math.fround(s.volume * sineCycles(i * step));
  return out;
}

/** The sound as 44,100 Hz mono samples (what is played, cached and measured). */
export function renderSound(s: Sound, bank?: SampleBank): Float32Array {
  if (s.voice === 'layered') return mixdown(renderLayered(s, bank));
  if (s.voice === 'classic') return Float32Array.from(renderClassic(s.patch));
  const n = sampleCount(s);
  const out = new Float32Array(n);
  const step = s.frequency / SAMPLE_RATE;
  for (let i = 0; i < n; i++) out[i] = s.volume * sineCycles(i * step);
  return out;
}

/** Mono: the channel itself. Stereo: (left + right) / 2, what the views, pitch and spectrum are measured on. */
export function mixdown(chs: readonly Float32Array[]): Float32Array {
  if (chs.length === 1) return chs[0]!;
  const out = new Float32Array(chs[0]!.length);
  for (let i = 0; i < out.length; i++) out[i] = (chs[0]![i]! + chs[1]![i]!) / 2;
  return out;
}

/** How many channels the sound renders to: 1, or 2 when a layer is panned. */
export function channelCount(s: Sound): number {
  return s.voice === 'layered' ? layeredChannelCount(s) : 1;
}

/** A classic sample at the highest the exported file holds: the first quantised step under the voice's full scale of 1 (trunc(0.9999 × 32000) / 32768). */
export const CLASSIC_FULL_SCALE = 31996 / 32768;

/**
 * The channels as the exported file holds them, as floats, which is what `measure` looks at: the classic voice exports as
 * trunc(s × 32000) in 16 bits (a full-scale sample of 1 is 32000 of 32768, 0.2 dB under full scale), so its numbers are taken from
 * those values and agree with the exported WAV; every other voice already exports at the scale it renders (16-bit, × 32767).
 */
export function measuredChannels(s: Sound, chs: Float32Array[]): Float32Array[] {
  if (s.voice !== 'classic') return chs;
  return chs.map((c) => {
    const q = new Float32Array(c.length);
    for (let i = 0; i < c.length; i++) q[i] = Math.trunc(c[i]! * 32000) / 32768;
    return q;
  });
}

/** The level at which a sample counts as full scale in `measuredChannels` of this sound (the clip check's run detection). */
export function fullScaleOf(s: Sound): number | undefined {
  return s.voice === 'classic' ? CLASSIC_FULL_SCALE : undefined;
}

/** The sound's channels (one array each). Every voice but a panned layered sound is one channel. */
export function renderChannels(s: Sound, bank?: SampleBank): Float32Array[] {
  return s.voice === 'layered' ? renderLayered(s, bank) : [renderSound(s)];
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

/** The channels one after the other in one array (the cache's and the server's layout). One channel: the array itself. */
export function joinChannels(chs: readonly Float32Array[]): Float32Array {
  if (chs.length === 1) return chs[0]!;
  const out = new Float32Array(chs.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chs) { out.set(c, at); at += c.length; }
  return out;
}

/** The inverse of joinChannels. */
export function splitChannels(all: Float32Array, count: number): Float32Array[] {
  if (count === 1) return [all];
  const n = Math.floor(all.length / count);
  return Array.from({ length: count }, (_, c) => all.subarray(c * n, (c + 1) * n));
}
