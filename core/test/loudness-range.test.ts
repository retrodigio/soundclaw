// The loudness range of a mix: the spread of its short-term loudness, as the mixer's master strip shows it.

import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE, loudnessRange } from '../src/index.ts';

const tone = (seconds: number, amp: number): Float32Array => Float32Array.from({ length: Math.round(seconds * SAMPLE_RATE) }, (_, i) => amp * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE));
const cat = (...parts: Float32Array[]): Float32Array => { const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };

describe('loudness range', () => {
  it('a steady tone has none', () => {
    expect(loudnessRange([tone(8, 0.1), tone(8, 0.1)])).toBeCloseTo(0, 1);
  });

  it('a quiet half and a loud half are as far apart as their levels', () => {
    // 12 dB between the halves: the range is that, to within the windows that straddle the change
    const lr = loudnessRange(cat(tone(10, 0.05), tone(10, 0.2)))!;
    expect(lr).toBeGreaterThan(11);
    expect(lr).toBeLessThan(12.5);
  });

  it('is null for a piece too short for a 3 s window, and for silence', () => {
    expect(loudnessRange(tone(2, 0.1))).toBeNull();
    expect(loudnessRange(new Float32Array(SAMPLE_RATE * 8))).toBeNull();
  });

  it('ignores a stretch of near silence (the relative gate)', () => {
    const lr = loudnessRange(cat(tone(10, 0.1), tone(10, 0.0001), tone(10, 0.1)))!;
    // without the gates the silence (about -83 LUFS) would make the range 80 LU; what is left is the windows that straddle its edges
    expect(lr).toBeLessThan(6);
  });
});
