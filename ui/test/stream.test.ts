// The library audition's streaming helpers: the header of the server's WAV, blocks to floats, the range plan and frames split across chunks.
import { describe, expect, it } from 'vitest';
import { pcmFromFloats, pcmToWav } from '@soundclaw/core';
import { FrameJoiner, STREAM_CHUNK, chunkPlan, framesToFloats, readWavHead, totalOf } from '../src/samples/stream.ts';

const ramp = (n: number): Float32Array => Float32Array.from({ length: n }, (_, i) => Math.sin(i / 20) * 0.5);

describe('the audition stream', () => {
  for (const format of ['pcm16', 'pcm24', 'pcm32', 'f32'] as const) {
    it(`reads a ${format} WAV header and gives back the samples`, () => {
      const l = ramp(500), r = ramp(500).map((v) => -v);
      const wav = pcmToWav(pcmFromFloats([l, r], 32000, format));
      const h = readWavHead(wav)!;
      expect(h).toMatchObject({ channels: 2, rate: 32000, dataOffset: 44 });
      const [a, b] = framesToFloats(wav.subarray(44), h);
      for (let i = 0; i < 500; i += 37) { expect(a![i]).toBeCloseTo(l[i]!, 3); expect(b![i]).toBeCloseTo(r[i]!, 3); }
    });
  }
  it('does not read what is not the server\'s WAV', () => {
    expect(readWavHead(new Uint8Array(10))).toBeNull();
    expect(readWavHead(new Uint8Array(64))).toBeNull();
  });
  it('plans ranges to the last byte', () => {
    const plan = chunkPlan(2_097_152, 5_000_000);
    expect(plan[0]).toEqual([2_097_152, 2_097_152 + STREAM_CHUNK - 1]);
    expect(plan.at(-1)![1]).toBe(4_999_999);
    expect(plan.every(([s, e], i) => e >= s && (i === 0 || s === plan[i - 1]![1] + 1))).toBe(true);
    expect(chunkPlan(10, 10)).toEqual([]);
  });
  it('reads the total of a Content-Range', () => {
    expect(totalOf('bytes 0-2097151/9000044')).toBe(9000044);
    expect(totalOf(null)).toBeNull();
  });
  it('joins frames split across chunks without losing or repeating a byte', () => {
    const wav = pcmToWav(pcmFromFloats([ramp(300), ramp(300)], 44100, 'pcm24'));
    const h = readWavHead(wav)!;
    const data = wav.subarray(44);
    const j = new FrameJoiner(h.channels * h.bytes);
    const parts: Uint8Array[] = [];
    for (let s = 0; s < data.length; s += 1001) parts.push(j.push(data.subarray(s, Math.min(data.length, s + 1001))));
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { joined.set(p, o); o += p.length; }
    expect(joined).toEqual(data);
    expect(parts.every((p) => p.length % 6 === 0)).toBe(true);
  });
});
