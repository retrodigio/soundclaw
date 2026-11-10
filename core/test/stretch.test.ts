import { describe, expect, it } from 'vitest';
import { atan2d, pitchShift, sinRad, stretchChannels, stretchTo, vocoderStretch, wsolaStretch } from '../src/index.ts';
import { cents, peakHz } from './helpers-dsp.ts';

const RATE = 44100;
const tone = (hz: number[], seconds: number): Float32Array => {
  const x = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < x.length; i++) { let s = 0; for (const f of hz) s += sinRad((2 * Math.PI * f * i) / RATE); x[i] = (0.6 * s) / hz.length; }
  return x;
};
const same = (a: Float32Array, b: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

describe('atan2d', () => {
  it('matches the platform arctangent in every quadrant', () => {
    for (const [y, x] of [[1, 1], [1, -1], [-1, -1], [-1, 1], [0, 1], [0, -1], [1, 0], [-1, 0], [0.001, 5], [7, 0.3]] as const) expect(Math.abs(atan2d(y, x) - Math.atan2(y, x))).toBeLessThan(1e-12);
  });
});

describe('time stretch', () => {
  it('keeps a tone\'s pitch within 5 cents across x0.5 to x2 (both methods)', () => {
    for (const hz of [[220], [880], [330, 660]]) {
      const x = tone(hz, 2);
      for (const method of ['wsola', 'pv'] as const) {
        for (const r of [0.5, 0.75, 1.5, 2]) {
          const y = stretchTo(x, r, RATE, method);
          expect(Math.abs(cents(peakHz(y, RATE, hz[0]! * 0.7, hz[0]! * 1.4), hz[0]!)), `${method} ${hz} x${r}`).toBeLessThan(5);
        }
      }
    }
  });

  it('the output is exactly round(length x ratio) frames', () => {
    for (const n of [1001, 22051, 44099]) {
      const x = tone([300], n / RATE);
      for (const r of [0.37, 1.001, 1.5, 2.3]) {
        for (const method of ['wsola', 'pv'] as const) expect(stretchTo(x, r, RATE, method).length).toBe(Math.round(n * r));
      }
    }
  });

  it('WSOLA keeps a click train\'s attack times within 5 ms', () => {
    const n = 3 * RATE;
    const x = new Float32Array(n);
    const clicks: number[] = [];
    for (let t = 0.2; t < 2.9; t += 0.25) {
      const p = Math.round(t * RATE) + (clicks.length % 3) * 13;
      clicks.push(p);
      for (let i = 0; i < 200; i++) x[p + i] = 0.9 * Math.exp(-i / 30) * (i % 2 ? -1 : 1);
    }
    for (const r of [1.5, 0.7]) {
      const y = wsolaStretch(x, r, RATE);
      for (const c of clicks) {
        const want = Math.round(c * r);
        let got = -1;
        for (let i = want - Math.round(0.03 * RATE); i < want + Math.round(0.03 * RATE); i++) if (Math.abs(y[i] ?? 0) > 0.3) { got = i; break; }
        expect(got, `click at ${c} x${r}`).toBeGreaterThan(-1);
        expect(Math.abs(got - want) / RATE).toBeLessThan(0.005);
      }
    }
  });

  it('pitch shift by stretch keeps the length and moves a tone +7 semitones within 5 cents', () => {
    const x = tone([300], 2);
    const y = pitchShift(x, 7, RATE, 'stretch');
    expect(y.length).toBe(x.length);
    expect(Math.abs(cents(peakHz(y, RATE, 300, 700), 300 * 2 ** (7 / 12)))).toBeLessThan(5);
    const z = pitchShift(x, 7, RATE, 'resample');
    expect(z.length).toBe(Math.round(x.length / 2 ** (7 / 12)));
    expect(Math.abs(cents(peakHz(z, RATE, 300, 700), 300 * 2 ** (7 / 12)))).toBeLessThan(5);
  });

  it('is deterministic and keeps channels aligned', () => {
    const x = tone([200, 450], 1);
    for (const method of ['wsola', 'pv'] as const) {
      expect(same(stretchTo(x, 1.3, RATE, method), stretchTo(x, 1.3, RATE, method))).toBe(true);
      const [l, r] = stretchChannels([x, Float32Array.from(x)], 1.3, RATE, method);
      expect(same(l!, r!)).toBe(true);
      expect(same(l!, stretchTo(x, 1.3, RATE, method))).toBe(true);
    }
  });

  it('a 5 s mono stretch is fast', () => {
    const x = tone([220, 330], 5);
    const t0 = performance.now();
    wsolaStretch(x, 1.4, RATE);
    vocoderStretch(x, 1.4, RATE);
    expect(performance.now() - t0).toBeLessThan(10_000);
  });
});
