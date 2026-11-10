import { describe, expect, it } from 'vitest';
import { readerFor, sinRad } from '../src/index.ts';
import { fftMag } from './helpers-dsp.ts';

const RATE = 44100;

/**
 * Alias measure: two steady tones are read at ratio 2 (an octave up). A 3 kHz tone lands on 6 kHz and is the
 * signal. A 15 kHz tone would land on 30 kHz, past Nyquist, and fold to 44.1 - 30 = 14.1 kHz: that is aliasing.
 * The measure is the power at 14.1 kHz relative to the power at 6 kHz (Hann window, one second of output).
 */
function aliasDb(mode: 'sinc' | 'cubic' | 'linear'): number {
  const n = 2 * RATE + 64;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 3000 * i) / RATE) + 0.5 * Math.sin((2 * Math.PI * 15000 * i) / RATE);
  const rd = readerFor(mode, x);
  const size = 32768;
  const y = new Float64Array(size);
  for (let i = 0; i < size; i++) y[i] = rd((i + 2000) * 2, 2) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  const m = fftMag(y);
  const bin = (hz: number) => Math.round((hz * size) / RATE);
  const peak = (hz: number) => { let p = 0; for (let k = bin(hz) - 3; k <= bin(hz) + 3; k++) p = Math.max(p, m[k]!); return p; };
  return 20 * Math.log10(peak(14100) / peak(6000));
}

describe('interpolation', () => {
  it('sinc pitched up an octave keeps alias energy under -60 dB; linear does not', () => {
    expect(aliasDb('sinc')).toBeLessThan(-60);
    expect(aliasDb('linear')).toBeGreaterThan(-45);
  });

  it('a sine read at ratio 1 comes back at integer positions (sinc, cubic)', () => {
    const x = new Float32Array(2000);
    for (let i = 0; i < x.length; i++) x[i] = 0.7 * sinRad((2 * Math.PI * 440 * i) / RATE);
    for (const mode of ['sinc', 'cubic', 'linear'] as const) {
      const rd = readerFor(mode, x);
      for (let i = 200; i < 1800; i += 37) expect(Math.abs(rd(i, 1) - x[i]!)).toBeLessThan(1e-3);
    }
  });

  it('reads zero outside the signal and the same bytes twice', () => {
    const x = Float32Array.from({ length: 300 }, (_, i) => sinRad(i * 0.3));
    for (const mode of ['sinc', 'cubic', 'linear'] as const) {
      const rd = readerFor(mode, x);
      expect(rd(-1, 1)).toBe(0);
      expect(rd(300.5, 1)).toBe(0);
      const a = Float32Array.from({ length: 200 }, (_, i) => rd(10 + i * 0.731, 1.3));
      const b = Float32Array.from({ length: 200 }, (_, i) => readerFor(mode, x)(10 + i * 0.731, 1.3));
      expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    }
  });
});
