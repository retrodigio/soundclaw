// OGG Vorbis encoding: libvorbis compiled to plain JavaScript (the `libvorbis.js` package: MIT, with
// the Xiph.org BSD licences of libogg and libvorbis). The encoder is variable bitrate: `quality` runs
// from -0.1 (smallest) to 1 (best); 0.4 is about 128 kbit/s for music. The stream ends with the
// exact number of samples given, so a decoder returns as many samples as were encoded. Vorbis is a
// lossy format: a loop's seam survives to within the codec's error, so keep loops as WAV when the seam
// must be exact.

import { createRequire } from 'node:module';

interface VorbisModule {
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
  _encoder_create_vbr(channels: number, sampleRate: number, quality: number): number;
  _encoder_write_headers(h: number): void;
  _encoder_prepare_analysis_buffers(h: number, samples: number): void;
  _encoder_get_analysis_buffer(h: number, channel: number): number;
  _encoder_encode(h: number): void;
  _encoder_finish(h: number): void;
  _encoder_get_data(h: number): number;
  _encoder_get_data_len(h: number): number;
  _encoder_clear_data(h: number): void;
  _encoder_destroy(h: number): void;
}

let loaded: VorbisModule | null = null;

/**
 * libvorbis.js is a plain script (it is not strict-mode clean), so it cannot be bundled into the
 * ES module: it is a dependency of the package, loaded when the first OGG is made.
 */
function vorbisModule(): VorbisModule {
  if (!loaded) {
    const req = createRequire(import.meta.url);
    loaded = req('libvorbis.js') as VorbisModule;
  }
  return loaded;
}

const BLOCK = 4096;
/** The stream serial number every file gets. libvorbis picks a random one; a fixed one makes the same sound give the same bytes. */
export const OGG_SERIAL = 0x53434c57; // "SCLW"

/** Ogg's CRC-32: polynomial 0x04C11DB7, no reflection, no final xor. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function pageCrc(page: Uint8Array): number {
  let crc = 0;
  for (const b of page) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]!) >>> 0;
  return crc;
}

/** Give every page the fixed serial number and write its checksum again. */
function fixSerial(bytes: Uint8Array): void {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (at + 27 <= bytes.length) {
    const segs = bytes[at + 26]!;
    let body = 0;
    for (let i = 0; i < segs; i++) body += bytes[at + 27 + i]!;
    const end = at + 27 + segs + body;
    dv.setUint32(at + 14, OGG_SERIAL, true);
    dv.setUint32(at + 22, 0, true);
    dv.setUint32(at + 22, pageCrc(bytes.subarray(at, end)), true);
    at = end;
  }
}

export function encodeOgg(channels: readonly Float32Array[], sampleRate = 44100, quality = 0.4): Uint8Array {
  if (!channels.length || channels.length > 2) throw new Error('OGG export takes one or two channels');
  if (!(quality >= -0.1 && quality <= 1)) throw new Error('OGG quality is from -0.1 to 1');
  const M = vorbisModule();
  const out: Uint8Array[] = [];
  const h = M._encoder_create_vbr(channels.length, sampleRate, quality);
  const flush = (): void => {
    const n = M._encoder_get_data_len(h);
    if (n === 0) return;
    const p = M._encoder_get_data(h);
    out.push(new Uint8Array(M.HEAPU8.subarray(p, p + n))); // a copy: the heap is reused
    M._encoder_clear_data(h);
  };
  try {
    M._encoder_write_headers(h);
    flush();
    const total = channels[0]!.length;
    for (let at = 0; at < total; at += BLOCK) {
      const n = Math.min(BLOCK, total - at);
      M._encoder_prepare_analysis_buffers(h, n);
      channels.forEach((c, ch) => {
        const ptr = M._encoder_get_analysis_buffer(h, ch);
        M.HEAPF32.set(c.subarray(at, at + n), ptr >> 2);
      });
      M._encoder_encode(h);
      flush();
    }
    M._encoder_finish(h);
    flush();
  } finally {
    M._encoder_destroy(h);
  }
  const bytes = new Uint8Array(out.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of out) { bytes.set(c, at); at += c.length; }
  fixSerial(bytes);
  return bytes;
}
