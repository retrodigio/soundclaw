// WAV (RIFF) encoding: 16-bit PCM, mono or any channel count, little-endian.

import { SAMPLE_RATE } from './sound.ts';

/** Float sample to 16-bit: clamped to [-1, 1], scaled by 32767, rounded to nearest (Math.round: ties toward +infinity). */
export function toPcm16(x: number): number {
  const c = x > 1 ? 1 : x < -1 ? -1 : x;
  return Math.round(c * 32767);
}

export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const v = new DataView(out.buffer);
  const tag = (off: number, s: string) => { for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i); };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  tag(36, 'data');
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, toPcm16(samples[i]!), true);
  return out;
}

export interface WavInfo {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  frames: number;
  /** The 16-bit samples. */
  data: Int16Array;
}

/** Read back a WAV written by encodeWav (16-bit PCM only); throws on anything else. */
export function decodeWav(bytes: Uint8Array): WavInfo {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number) => String.fromCharCode(bytes[off]!, bytes[off + 1]!, bytes[off + 2]!, bytes[off + 3]!);
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ' || tag(36) !== 'data') throw new Error('not a WAV file this tool wrote');
  const format = v.getUint16(20, true);
  const bitsPerSample = v.getUint16(34, true);
  if (format !== 1 || bitsPerSample !== 16) throw new Error('only 16-bit PCM is read');
  const n = v.getUint32(40, true) >> 1;
  const data = new Int16Array(n);
  for (let i = 0; i < n; i++) data[i] = v.getInt16(44 + i * 2, true);
  const channels = v.getUint16(22, true);
  return { format, channels, sampleRate: v.getUint32(24, true), bitsPerSample, frames: n / channels, data };
}
