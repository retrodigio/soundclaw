import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE, decodeWav, encodeWav, newSound, renderSound, toPcm16 } from '../src/index.ts';

describe('WAV export', () => {
  it('writes a RIFF header for 16-bit PCM mono at 44,100 Hz, and the data after it', () => {
    const samples = Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2]);
    const b = encodeWav(samples);
    const text = (a: number, n: number) => String.fromCharCode(...b.subarray(a, a + n));
    const v = new DataView(b.buffer);
    expect(b.length).toBe(44 + samples.length * 2);
    expect(text(0, 4)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(b.length - 8);
    expect(text(8, 8)).toBe('WAVEfmt ');
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint32(28, true)).toBe(88200); // byte rate
    expect(v.getUint16(32, true)).toBe(2); // block align
    expect(v.getUint16(34, true)).toBe(16);
    expect(text(36, 4)).toBe('data');
    expect(v.getUint32(40, true)).toBe(samples.length * 2);
    // 0.5 -> 16384 and -0.5 -> -16383 (the halves round toward +infinity), full scale -> 32767, and out-of-range samples are clamped.
    expect([...decodeWav(b).data]).toEqual([0, 16384, -16383, 32767, -32767, 32767, -32767]);
  });

  it('round-trips a rendered tone to within one 16-bit step', () => {
    const s = renderSound({ ...newSound('t'), frequency: 330, duration: 0.05, volume: 0.9 });
    const w = decodeWav(encodeWav(s));
    expect(w).toMatchObject({ channels: 1, sampleRate: SAMPLE_RATE, bitsPerSample: 16, frames: s.length });
    for (let i = 0; i < s.length; i++) expect(Math.abs(w.data[i]! / 32767 - s[i]!)).toBeLessThanOrEqual(1 / 32767);
  });

  it('is byte-identical for the same sound', () => {
    const a = encodeWav(renderSound(newSound('t')));
    const b = encodeWav(renderSound(newSound('t')));
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
    expect(toPcm16(0.25)).toBe(8192);
  });

  it('refuses a file it did not write', () => {
    expect(() => decodeWav(new Uint8Array(10))).toThrow(/not a WAV/);
  });
});
