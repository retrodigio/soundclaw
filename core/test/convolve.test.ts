// Convolution: the partitioned FFT convolution gives what the term-by-term sum gives, in whole blocks and across them,
// and the same bytes every time.

import { describe, expect, it } from 'vitest';
import { CONVOLVE_BLOCK, convolve, convolveDirect } from '../src/convolve.ts';

function noise(n: number, seed: number): Float64Array {
  const out = new Float64Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out[i] = s / 2147483648 - 1; }
  return out;
}

describe('convolution', () => {
  it('equals the sum term by term for a response of one block, of several blocks, and of a part of a block', () => {
    for (const [nx, nh] of [[900, 300], [5000, CONVOLVE_BLOCK], [6000, 5000], [300, 9000], [1, 1], [CONVOLVE_BLOCK, CONVOLVE_BLOCK + 1]] as const) {
      const x = noise(nx, 1), h = noise(nh, 2);
      const full = nx + nh - 1;
      const a = convolve(x, h, full);
      const b = convolveDirect(x, h, full);
      let worst = 0;
      for (let i = 0; i < full; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
      expect(worst, `${nx} x ${nh}`).toBeLessThan(1e-9);
    }
  });

  it('cuts the result to the length asked for and pads a longer one with zeros', () => {
    const x = noise(3000, 3), h = noise(4500, 4);
    const direct = convolveDirect(x, h, 7499);
    const cut = convolve(x, h, 2500);
    for (let i = 0; i < 2500; i++) expect(cut[i]).toBeCloseTo(direct[i]!, 9);
    const padded = convolve(x, h, 9000);
    expect(padded.length).toBe(9000);
    for (let i = 7499; i < 9000; i++) expect(padded[i]).toBe(0);
  });

  it('a unit impulse leaves the signal as it was, and a delayed one delays it', () => {
    const x = noise(5000, 5);
    const same = convolve(x, Float64Array.of(1), 5000);
    for (let i = 0; i < 5000; i += 7) expect(same[i]).toBeCloseTo(x[i]!, 10);
    const h = new Float64Array(3000);
    h[2500] = 1;
    const late = convolve(x, h, 8000);
    for (let i = 0; i < 5000; i += 11) expect(late[i + 2500]).toBeCloseTo(x[i]!, 10);
    expect(late[100]).toBeCloseTo(0, 10);
  });

  it('gives the same bytes every time', () => {
    const x = noise(8000, 6), h = noise(7000, 7);
    const a = convolve(x, h, 12000), b = convolve(x, h, 12000);
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
  });
});
