// WAV (RIFF) encoding: 16-bit PCM, mono or any channel count, little-endian.

import { classicWav } from './classic.ts';
import { renderChannels, renderExact, renderSound } from './render.ts';
import { limitChannels, type SampleBank } from './synth.ts';
import { SAMPLE_RATE, type Sound } from './sound.ts';

/** Float sample to 16-bit: clamped to [-1, 1], scaled by 32767, rounded to nearest (Math.round: ties toward +infinity). */
export function toPcm16(x: number): number {
  const c = x > 1 ? 1 : x < -1 ? -1 : x;
  return Math.round(c * 32767);
}

export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array {
  return encodeWavChannels([samples], sampleRate);
}

/** 16-bit PCM WAV of one or two channels (interleaved). */
export function encodeWavChannels(chs: readonly Float32Array[], sampleRate = SAMPLE_RATE): Uint8Array {
  const nch = chs.length;
  const frames = chs[0]!.length;
  const dataBytes = frames * nch * 2;
  const out = new Uint8Array(44 + dataBytes);
  const v = new DataView(out.buffer);
  const tag = (off: number, s: string) => { for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i); };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2 * nch, true); // byte rate
  v.setUint16(32, 2 * nch, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  tag(36, 'data');
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++) v.setInt16(44 + (i * nch + c) * 2, toPcm16(chs[c]![i]!), true);
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

/** A sound's WAV file as exported: the classic voice as the engine's pre-rendered form (trunc(s × 32000)), a layered sound through the limiter (ceiling in dBTP), others as 16-bit PCM scaled by 32767. */
export function soundWav(s: Sound, samples?: Float32Array, o: { ceilingDb?: number; channels?: Float32Array[]; bank?: SampleBank } = {}): Uint8Array {
  return soundExport(s, samples, o).wav;
}

/** The WAV of a sound and what the export did to it (the limiter's largest gain reduction, dB). */
export function soundExport(s: Sound, samples?: Float32Array, o: { ceilingDb?: number; channels?: Float32Array[]; bank?: SampleBank } = {}): { wav: Uint8Array; reductionDb: number; channels: number } {
  if (s.voice === 'classic') return { wav: classicWav(renderExact(s)), reductionDb: 0, channels: 1 };
  if (s.voice === 'layered') {
    const lim = limitChannels(o.channels ?? renderChannels(s, o.bank), o.ceilingDb ?? -0.1);
    return { wav: encodeWavChannels(lim.channels), reductionDb: lim.reductionDb, channels: lim.channels.length };
  }
  return { wav: encodeWav(samples ?? renderSound(s)), reductionDb: 0, channels: 1 };
}

export interface SampleWav {
  rate: number;
  channels: number;
  frames: number;
  /** All channels averaged to one. */
  data: Float32Array;
}

/** Read a WAV for use as a sample: PCM 8, 16, 24 or 32 bit or 32-bit float, any rate, any channel count (mixed down to mono); other chunks are skipped. Throws a plain Error saying what is wrong. */
export function readSampleWav(bytes: Uint8Array, maxSeconds = 120): SampleWav {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number) => String.fromCharCode(bytes[off]!, bytes[off + 1]!, bytes[off + 2]!, bytes[off + 3]!);
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file (no RIFF/WAVE header)');
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let dataAt = -1, dataLen = 0;
  for (let p = 12; p + 8 <= bytes.length;) {
    const size = v.getUint32(p + 4, true);
    if (tag(p) === 'fmt ' && p + 24 <= bytes.length) fmt = { format: v.getUint16(p + 8, true), channels: v.getUint16(p + 10, true), rate: v.getUint32(p + 12, true), bits: v.getUint16(p + 22, true) };
    else if (tag(p) === 'data') { dataAt = p + 8; dataLen = Math.min(size, bytes.length - dataAt); break; }
    p += 8 + size + (size & 1);
  }
  if (!fmt || dataAt < 0) throw new Error('not a WAV file this tool reads (no fmt or data chunk)');
  let format = fmt.format;
  if (format === 0xfffe && dataAt >= 0) format = v.getUint16(20 + 24, true); // WAVE_FORMAT_EXTENSIBLE: the sub-format's first two bytes
  const { channels, rate, bits } = fmt;
  const isFloat = format === 3 && bits === 32;
  if (!((format === 1 && [8, 16, 24, 32].includes(bits)) || isFloat)) throw new Error(`only PCM (8, 16, 24 or 32 bit) and 32-bit float WAV files are read (this one is format ${format}, ${bits} bit)`);
  if (channels < 1 || channels > 8 || rate < 3000 || rate > 192000) throw new Error(`a WAV with ${channels} channels at ${rate} Hz is not supported`);
  const bpf = (bits / 8) * channels;
  const frames = Math.floor(dataLen / bpf);
  if (frames < 2) throw new Error('the WAV has no audio');
  if (frames / rate > maxSeconds) throw new Error(`the WAV is ${(frames / rate).toFixed(1)} s long; samples are at most ${maxSeconds} s`);
  const data = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const o = dataAt + i * bpf + c * (bits / 8);
      sum += isFloat ? v.getFloat32(o, true) : bits === 8 ? (v.getUint8(o) - 128) / 128 : bits === 16 ? v.getInt16(o, true) / 32768 : bits === 24 ? ((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)) / 8388608) : v.getInt32(o, true) / 2147483648;
    }
    data[i] = sum / channels;
  }
  return { rate, channels, frames, data };
}
