// Stored audio: interleaved little-endian PCM at a rate, a channel count and a sample format. A sample's
// identity is the SHA-256 of a fixed header and those samples (not of a file's bytes), so the extra chunks
// a WAV may carry (LIST, smpl, bext) never change a hash, and the same audio kept in another lossless
// container later keeps its hash and its renders.

import { sha256Hex, utf8 } from './sha256.ts';
import type { SampleData } from './synth.ts';

export type PcmFormat = 'pcm8' | 'pcm16' | 'pcm24' | 'pcm32' | 'f32';
export const PCM_FORMATS: readonly PcmFormat[] = ['pcm8', 'pcm16', 'pcm24', 'pcm32', 'f32'];

export const FORMAT_BYTES: Record<PcmFormat, number> = { pcm8: 1, pcm16: 2, pcm24: 3, pcm32: 4, f32: 4 };
export const FORMAT_BITS: Record<PcmFormat, number> = { pcm8: 8, pcm16: 16, pcm24: 24, pcm32: 32, f32: 32 };

/** Audio as stored. `data` is `frames × channels × bytes` long: 8-bit is unsigned (as a WAV has it), the others are signed or IEEE singles. */
export interface PcmAudio {
  rate: number;
  channels: number;
  format: PcmFormat;
  frames: number;
  data: Uint8Array;
}

/** The limits on a sample, in one place (printed when one is hit; the table is in docs/commands.md). */
export const SAMPLE_LIMITS = {
  /** The longest file, seconds. */
  maxSeconds: 600,
  /** The largest file read, bytes. */
  maxFileBytes: 200 * 1024 * 1024,
  minRate: 8000,
  maxRate: 192000,
  maxChannels: 8,
  /** A sample layer plays at most this many seconds of a sample. */
  playSeconds: 120,
  /** The store warns past this many bytes, and refuses an import past the next without --force. */
  warnStoreBytes: 250 * 1024 * 1024,
  refuseStoreBytes: 1024 * 1024 * 1024,
} as const;

/** The limits as text, for errors and the reference. */
export const SAMPLE_LIMITS_TEXT = `a file is at most ${SAMPLE_LIMITS.maxSeconds} s and ${SAMPLE_LIMITS.maxFileBytes / 1048576} MB; the rate is ${SAMPLE_LIMITS.minRate}-${SAMPLE_LIMITS.maxRate} Hz; 1-${SAMPLE_LIMITS.maxChannels} channels; a sample layer plays at most ${SAMPLE_LIMITS.playSeconds} s of a sample; the store warns past ${SAMPLE_LIMITS.warnStoreBytes / 1048576} MB and refuses an import past ${SAMPLE_LIMITS.refuseStoreBytes / 1048576} MB without --force`;

/** Why this audio is outside the limits (null: it is inside them). `lenient` is for the files of a 0.1.x project, which were read under looser rules. */
export function limitProblem(a: { rate: number; channels: number; frames: number }, lenient = false): string | null {
  if (!Number.isInteger(a.channels) || a.channels < 1 || a.channels > SAMPLE_LIMITS.maxChannels) return `${a.channels} channels (samples have 1-${SAMPLE_LIMITS.maxChannels})`;
  const minRate = lenient ? 3000 : SAMPLE_LIMITS.minRate;
  if (!Number.isInteger(a.rate) || a.rate < minRate || a.rate > SAMPLE_LIMITS.maxRate) return `${a.rate} Hz (samples are ${minRate}-${SAMPLE_LIMITS.maxRate} Hz)`;
  if (a.frames < 2) return 'the file has no audio';
  const max = SAMPLE_LIMITS.maxSeconds;
  if (a.frames / a.rate > max) return `${(a.frames / a.rate).toFixed(1)} s long (at most ${max} s)`;
  return null;
}

/** The fixed header the hash covers. */
export function pcmHeader(a: Pick<PcmAudio, 'rate' | 'channels' | 'format'>): string {
  return `soundclaw-pcm 1\nrate=${a.rate}\nchannels=${a.channels}\nformat=${a.format}\n`;
}

/** The canonical SHA-256 of audio: its header, then its samples. */
export function pcmHash(a: PcmAudio): string {
  const head = utf8(pcmHeader(a));
  const all = new Uint8Array(head.length + a.data.length);
  all.set(head);
  all.set(a.data, head.length);
  return sha256Hex(all);
}

/** The audio as a WAV file with nothing but `fmt ` and `data` chunks: the form kept in the store. */
export function pcmToWav(a: PcmAudio): Uint8Array {
  const bps = FORMAT_BYTES[a.format];
  const dataBytes = a.data.length;
  const pad = dataBytes & 1;
  const out = new Uint8Array(44 + dataBytes + pad);
  const v = new DataView(out.buffer);
  const tag = (off: number, s: string) => { for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i); };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes + pad, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, a.format === 'f32' ? 3 : 1, true);
  v.setUint16(22, a.channels, true);
  v.setUint32(24, a.rate, true);
  v.setUint32(28, a.rate * bps * a.channels, true);
  v.setUint16(32, bps * a.channels, true);
  v.setUint16(34, bps * 8, true);
  tag(36, 'data');
  v.setUint32(40, dataBytes, true);
  out.set(a.data, 44);
  return out;
}

/** One stored value as a float in about [-1, 1) (the arithmetic the renderer's sample layers have always used). */
function valueAt(v: DataView, o: number, format: PcmFormat): number {
  switch (format) {
    case 'pcm8': return (v.getUint8(o) - 128) / 128;
    case 'pcm16': return v.getInt16(o, true) / 32768;
    case 'pcm24': return (v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)) / 8388608;
    case 'pcm32': return v.getInt32(o, true) / 2147483648;
    case 'f32': return v.getFloat32(o, true);
  }
}

/**
 * The audio as the renderer reads it: the channels averaged to one signal (`data`), and for two or more channels the first two as
 * they are (`left`, `right`). `maxSeconds` cuts a long sample: a layer plays at most that much of it.
 */
export function pcmToSampleData(a: PcmAudio, maxSeconds: number = SAMPLE_LIMITS.playSeconds): SampleData {
  const v = new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength);
  const frames = Math.min(a.frames, Math.floor(maxSeconds * a.rate));
  const bps = FORMAT_BYTES[a.format];
  const data = new Float32Array(frames);
  const left = a.channels >= 2 ? new Float32Array(frames) : undefined;
  const right = a.channels >= 2 ? new Float32Array(frames) : undefined;
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < a.channels; c++) {
      const x = valueAt(v, (i * a.channels + c) * bps, a.format);
      sum += x;
      if (c === 0 && left) left[i] = x;
      else if (c === 1 && right) right[i] = x;
    }
    data[i] = sum / a.channels;
  }
  return { rate: a.rate, data, ...(left && right ? { left, right } : {}) };
}

/** Float channels as 16-bit stored audio (for tests, bounces and generators that have floats to store). */
export function pcmFromFloats(chs: readonly Float32Array[], rate: number, format: PcmFormat = 'pcm16'): PcmAudio {
  const frames = chs[0]!.length;
  const bps = FORMAT_BYTES[format];
  const data = new Uint8Array(frames * chs.length * bps);
  const v = new DataView(data.buffer);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < chs.length; c++) {
      const x = Math.max(-1, Math.min(1, chs[c]![i]!));
      const o = (i * chs.length + c) * bps;
      if (format === 'pcm8') v.setUint8(o, Math.max(0, Math.min(255, Math.round(x * 128) + 128)));
      else if (format === 'pcm16') v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(x * 32768))), true);
      else if (format === 'pcm24') {
        const n = Math.max(-8388608, Math.min(8388607, Math.round(x * 8388608)));
        v.setUint8(o, n & 255); v.setUint8(o + 1, (n >> 8) & 255); v.setUint8(o + 2, (n >> 16) & 255);
      } else if (format === 'pcm32') v.setInt32(o, Math.max(-2147483648, Math.min(2147483647, Math.round(x * 2147483648))), true);
      else v.setFloat32(o, chs[c]![i]!, true);
    }
  }
  return { rate, channels: chs.length, format, frames, data };
}
