// Streaming a library file for auditioning: the server answers byte ranges of the decoded WAV, so a long file starts playing from its first
// megabytes while the rest arrives. Pure helpers here (the header, the blocks to floats, the chunk plan); the store schedules the buffers.

/** A file this long (bytes) or longer is streamed in ranges; shorter ones are fetched whole. */
export const STREAM_OVER = 2 * 1024 * 1024;
/** The size of each range after the first. */
export const STREAM_CHUNK = 1024 * 1024;

export interface WavHead { channels: number; rate: number; bytes: number; float: boolean; dataOffset: number; dataBytes: number }

/** The header of the WAV the server makes for auditions (44 bytes, PCM 8/16/24/32-bit or float 32), or null when the bytes are something else. */
export function readWavHead(b: Uint8Array): WavHead | null {
  if (b.length < 44) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number): string => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ' || v.getUint32(16, true) !== 16 || tag(36) !== 'data') return null;
  const code = v.getUint16(20, true), bits = v.getUint16(34, true);
  const float = code === 3;
  if (!(code === 1 || float) || ![8, 16, 24, 32].includes(bits) || (float && bits !== 32)) return null;
  const channels = v.getUint16(22, true), rate = v.getUint32(24, true);
  if (channels < 1 || channels > 8 || rate < 3000 || rate > 192000) return null;
  return { channels, rate, bytes: bits / 8, float, dataOffset: 44, dataBytes: v.getUint32(40, true) };
}

/** Whole frames of interleaved samples as one float array a channel (the same scaling the renderer's sample layers use for each width). */
export function framesToFloats(raw: Uint8Array, h: WavHead): Float32Array[] {
  const frame = h.channels * h.bytes;
  const n = Math.floor(raw.length / frame);
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out = Array.from({ length: h.channels }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < h.channels; c++) {
      const o = i * frame + c * h.bytes;
      out[c]![i] = h.float ? v.getFloat32(o, true)
        : h.bytes === 1 ? (v.getUint8(o) - 128) / 128
          : h.bytes === 2 ? v.getInt16(o, true) / 32768
            : h.bytes === 3 ? (((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)) | 0) / 8388608)
              : v.getInt32(o, true) / 2147483648;
    }
  }
  return out;
}

/** The ranges to ask for after the first chunk: [start, end] inclusive, STREAM_CHUNK long, up to the last byte of the file. */
export function chunkPlan(from: number, total: number, size = STREAM_CHUNK): [number, number][] {
  const out: [number, number][] = [];
  for (let s = from; s < total; s += size) out.push([s, Math.min(total - 1, s + size - 1)]);
  return out;
}

/** `bytes 0-2097151/9000044` → the total, or null. */
export function totalOf(contentRange: string | null): number | null {
  const m = /\/(\d+)$/.exec(contentRange ?? '');
  return m ? Number(m[1]) : null;
}

/** Carries the bytes of a partial frame from one chunk to the next, so every chunk handed to `framesToFloats` is whole frames. */
export class FrameJoiner {
  private rest = new Uint8Array(0);
  private readonly frameBytes: number;
  constructor(frameBytes: number) { this.frameBytes = frameBytes; }
  push(chunk: Uint8Array): Uint8Array {
    const all = new Uint8Array(this.rest.length + chunk.length);
    all.set(this.rest, 0);
    all.set(chunk, this.rest.length);
    const whole = all.length - (all.length % this.frameBytes);
    this.rest = all.slice(whole);
    return all.subarray(0, whole);
  }
}
