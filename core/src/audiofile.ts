// Reading audio files into stored PCM (pcm.ts): WAV (PCM 8/16/24/32-bit, float 32 and 64, extensible), AIFF and
// AIFF-C (`none`, `sowt`, `fl32`) and FLAC, all decoded here in plain TypeScript. Only integers and the file's own
// bytes are involved, so a file decodes to the same stored audio on every machine. Compressed formats (OGG, MP3, M4A)
// are not read here: the server turns them into a WAV with ffmpeg at import and the WAV is what is stored.
//
// What a file says about itself besides its audio is read too (`smpl`, `acid`, `cue ` and `LIST/INFO` of a WAV, `INST`,
// `MARK` and the text chunks of an AIFF, the comment block of a FLAC) and handed back as `meta` and as sentences in `notes`.

import { noteLabel } from './music.ts';
import { FORMAT_BYTES, SAMPLE_LIMITS, limitProblem, type PcmAudio, type PcmFormat } from './pcm.ts';

export type Container = 'wav' | 'aiff' | 'flac';

/** What a file says about its audio. Positions are in frames. */
export interface AudioMeta {
  /** MIDI note number of the pitch the audio is recorded at, and a tuning offset from it in cents. */
  root?: number;
  tune?: number;
  loop?: { start: number; end: number; type: 'forward' | 'alternate' | 'backward' };
  oneShot?: boolean;
  tempo?: number;
  /** Cue points. */
  cues?: number[];
  /** Text tags (title, comment, copyright, author, software). */
  info?: Record<string, string>;
}

export interface Decoded {
  audio: PcmAudio;
  container: Container;
  /** The file's own sample format, like `16-bit`, `24-bit`, `float 32`, `FLAC 16-bit`. */
  sourceFormat: string;
  meta: AudioMeta;
  /** What was read, and what was changed on the way in (one sentence each). */
  notes: string[];
}

/** Which container the bytes are, from their first bytes. */
export function sniffContainer(b: Uint8Array): Container | null {
  const t = (o: number, n = 4) => String.fromCharCode(...Array.from(b.subarray(o, o + n)));
  if (b.length >= 12 && t(0) === 'RIFF' && t(8) === 'WAVE') return 'wav';
  if (b.length >= 12 && t(0) === 'FORM' && (t(8) === 'AIFF' || t(8) === 'AIFC')) return 'aiff';
  if (b.length >= 4 && t(0) === 'fLaC') return 'flac';
  return null;
}

export interface DecodeOptions {
  /** Read under the looser rules of 0.1.x projects (rates from 3 kHz, files up to the 120 s a layer plays). */
  lenient?: boolean;
}

/** Decode WAV, AIFF or FLAC bytes. Throws a plain Error saying what is wrong. */
export function decodeAudio(bytes: Uint8Array, o: DecodeOptions = {}): Decoded {
  if (bytes.length > SAMPLE_LIMITS.maxFileBytes) throw new Error(`the file is ${(bytes.length / 1048576).toFixed(0)} MB (at most ${SAMPLE_LIMITS.maxFileBytes / 1048576} MB)`);
  const c = sniffContainer(bytes);
  if (!c) throw new Error('not a WAV, AIFF or FLAC file (OGG, MP3 and M4A are read through ffmpeg when it is installed; or convert the file to WAV)');
  const d = c === 'wav' ? decodeWav(bytes, o) : c === 'aiff' ? decodeAiff(bytes, o) : decodeFlac(bytes, o);
  return d;
}

const tagAt = (b: Uint8Array, o: number): string => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

function checkLimits(a: { rate: number; channels: number; frames: number }, what: string, o: DecodeOptions): void {
  const p = limitProblem(a, o.lenient);
  if (p) throw new Error(`${what}: ${p}`);
}

function textOf(b: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to && b[i] !== 0; i++) s += String.fromCharCode(b[i]!);
  return s.trim();
}

// ---- WAV ---------------------------------------------------------------------------------------------------------

const INFO_NAMES: Record<string, string> = { INAM: 'title', ICMT: 'comment', ICOP: 'copyright', IART: 'author', ISFT: 'software', IGNR: 'genre', ICRD: 'date', IPRD: 'product' };
const LOOP_TYPES = ['forward', 'alternate', 'backward'] as const;

function decodeWav(bytes: Uint8Array, o: DecodeOptions): Decoded {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt: { format: number; channels: number; rate: number; bits: number; block: number } | null = null;
  let dataAt = -1, dataLen = 0;
  const meta: AudioMeta = {};
  const notes: string[] = [];
  const cues: number[] = [];
  for (let p = 12; p + 8 <= bytes.length;) {
    const id = tagAt(bytes, p);
    let size = v.getUint32(p + 4, true);
    const body = p + 8;
    if (id === 'data') {
      if (size > bytes.length - body) size = bytes.length - body; // a streamed file, or one cut short
      dataAt = body; dataLen = size;
    } else if (id === 'fmt ' && body + 16 <= bytes.length) {
      let format = v.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE: the sub-format's first two bytes (after cbSize, valid bits, channel mask) say what it really is
      if (format === 0xfffe && size >= 26 && body + 26 <= bytes.length) format = v.getUint16(body + 24, true);
      fmt = { format, channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), block: v.getUint16(body + 12, true), bits: v.getUint16(body + 14, true) };
    } else if (id === 'smpl' && size >= 36 && body + 36 <= bytes.length) {
      const note = v.getUint32(body + 12, true);
      const frac = v.getUint32(body + 16, true);
      if (note > 0 && note < 128) {
        meta.root = note;
        // the fraction is a part of a semitone in 1/2^32; a cent is 1/100 of one. Above half a semitone it is a note lower.
        const cents = Math.round((frac / 4294967296) * 100);
        if (cents !== 0) meta.tune = cents > 50 ? cents - 100 : cents;
        if (cents > 50) meta.root = note + 1;
      }
      const n = v.getUint32(body + 28, true);
      if (n > 0 && body + 36 + 24 <= bytes.length) {
        const type = LOOP_TYPES[v.getUint32(body + 40, true)] ?? 'forward';
        meta.loop = { start: v.getUint32(body + 44, true), end: v.getUint32(body + 48, true), type };
      }
    } else if (id === 'acid' && size >= 24 && body + 24 <= bytes.length) {
      const flags = v.getUint32(body, true);
      if (flags & 1) meta.oneShot = true;
      const root = v.getUint16(body + 4, true);
      if ((flags & 2) && root > 0 && root < 128 && meta.root === undefined) meta.root = root;
      const tempo = v.getFloat32(body + 20, true);
      if (Number.isFinite(tempo) && tempo >= 20 && tempo <= 400) meta.tempo = Math.round(tempo * 100) / 100;
    } else if (id === 'cue ' && size >= 4 && body + 4 <= bytes.length) {
      const n = v.getUint32(body, true);
      for (let k = 0; k < n && body + 4 + (k + 1) * 24 <= bytes.length && k < 4096; k++) cues.push(v.getUint32(body + 4 + k * 24 + 20, true));
    } else if (id === 'LIST' && size >= 4 && tagAt(bytes, body) === 'INFO') {
      for (let q = body + 4; q + 8 <= Math.min(bytes.length, body + size);) {
        const sid = tagAt(bytes, q);
        const sz = v.getUint32(q + 4, true);
        const key = INFO_NAMES[sid];
        if (key) (meta.info ??= {})[key] = textOf(bytes, q + 8, Math.min(bytes.length, q + 8 + sz));
        q += 8 + sz + (sz & 1);
      }
    }
    p = body + size + (size & 1);
    if (size > bytes.length) break;
  }
  if (!fmt || dataAt < 0) throw new Error('not a WAV file this tool reads (no fmt or data chunk)');
  if (cues.length) meta.cues = [...new Set(cues)].sort((a, b) => a - b);
  const { channels, rate, bits } = fmt;
  let format: PcmFormat;
  let sourceFormat: string;
  let convert64 = false;
  if (fmt.format === 1 && bits === 8) { format = 'pcm8'; sourceFormat = '8-bit'; }
  else if (fmt.format === 1 && bits === 16) { format = 'pcm16'; sourceFormat = '16-bit'; }
  else if (fmt.format === 1 && bits === 24) { format = 'pcm24'; sourceFormat = '24-bit'; }
  else if (fmt.format === 1 && bits === 32) { format = 'pcm32'; sourceFormat = '32-bit'; }
  else if (fmt.format === 3 && bits === 32) { format = 'f32'; sourceFormat = 'float 32'; }
  else if (fmt.format === 3 && bits === 64) { format = 'f32'; sourceFormat = 'float 64'; convert64 = true; }
  else throw new Error(`only PCM (8, 16, 24 or 32 bit) and float (32 or 64 bit) WAV files are read (this one is format ${fmt.format}, ${bits} bit)`);
  if (channels < 1 || channels > SAMPLE_LIMITS.maxChannels) throw new Error(`a WAV with ${channels} channels is not supported (1-${SAMPLE_LIMITS.maxChannels})`);
  const bps = bits / 8;
  const frames = Math.floor(dataLen / (bps * channels));
  checkLimits({ rate, channels, frames }, 'the WAV', o);
  let data: Uint8Array;
  if (convert64) {
    data = new Uint8Array(frames * channels * 4);
    const out = new DataView(data.buffer);
    for (let i = 0; i < frames * channels; i++) out.setFloat32(i * 4, v.getFloat64(dataAt + i * 8, true), true);
    notes.push('64-bit float samples are stored as 32-bit float');
  } else data = bytes.slice(dataAt, dataAt + frames * channels * bps);
  describeMeta(meta, notes);
  return { audio: { rate, channels, format, frames, data }, container: 'wav', sourceFormat, meta, notes };
}

function describeMeta(meta: AudioMeta, notes: string[]): void {
  if (meta.root !== undefined) notes.push(`read root note ${noteLabel(meta.root)}${meta.tune ? ` ${meta.tune > 0 ? '+' : ''}${meta.tune} cents` : ''}`);
  if (meta.loop) notes.push(`read a ${meta.loop.type} loop, frames ${meta.loop.start}-${meta.loop.end}`);
  if (meta.oneShot) notes.push('read the one-shot flag');
  if (meta.tempo) notes.push(`read tempo ${meta.tempo} BPM`);
  if (meta.cues?.length) notes.push(`read ${meta.cues.length} cue point${meta.cues.length === 1 ? '' : 's'}`);
  if (meta.info) for (const [k, t] of Object.entries(meta.info)) if (t) notes.push(`read ${k} text "${t.length > 60 ? t.slice(0, 57) + '...' : t}"`);
}

// ---- AIFF --------------------------------------------------------------------------------------------------------

/** The 80-bit extended float an AIFF keeps its rate in, as a number. */
function extended80(b: Uint8Array, o: number): number {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const se = v.getUint16(o);
  const exp = se & 0x7fff;
  const hi = v.getUint32(o + 2);
  const lo = v.getUint32(o + 6);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  if (exp === 0x7fff) return NaN;
  const mant = hi * 4294967296 + lo;
  return Math.round(mant * Math.pow(2, exp - 16383 - 63)) * (se & 0x8000 ? -1 : 1);
}

function decodeAiff(bytes: Uint8Array, o: DecodeOptions): Decoded {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const aifc = tagAt(bytes, 8) === 'AIFC';
  let comm: { channels: number; frames: number; bits: number; rate: number; comp: string } | null = null;
  let ssnd = -1, ssndLen = 0;
  const meta: AudioMeta = {};
  const notes: string[] = [];
  const marks = new Map<number, number>();
  let inst: { base: number; detune: number; sustain: [number, number, number] } | null = null;
  const TEXT: Record<string, string> = { NAME: 'title', AUTH: 'author', '(c) ': 'copyright', ANNO: 'comment' };
  for (let p = 12; p + 8 <= bytes.length;) {
    const id = tagAt(bytes, p);
    const size = v.getUint32(p + 4);
    const body = p + 8;
    if (id === 'COMM' && body + 18 <= bytes.length) {
      comm = { channels: v.getUint16(body), frames: v.getUint32(body + 2), bits: v.getUint16(body + 6), rate: extended80(bytes, body + 8), comp: aifc && body + 22 <= bytes.length ? tagAt(bytes, body + 18) : 'NONE' };
    } else if (id === 'SSND' && body + 8 <= bytes.length) {
      const off = v.getUint32(body);
      ssnd = body + 8 + off;
      ssndLen = Math.max(0, Math.min(size - 8 - off, bytes.length - ssnd));
    } else if (id === 'INST' && size >= 20 && body + 20 <= bytes.length) {
      inst = { base: v.getInt8(body), detune: v.getInt8(body + 1), sustain: [v.getUint16(body + 8), v.getUint16(body + 10), v.getUint16(body + 12)] };
    } else if (id === 'MARK' && body + 2 <= bytes.length) {
      let q = body + 2;
      for (let k = 0, n = v.getUint16(body); k < n && q + 7 <= bytes.length; k++) {
        marks.set(v.getUint16(q), v.getUint32(q + 2));
        const len = bytes[q + 6]!;
        q += 7 + len + ((1 + len) & 1); // the name is a Pascal string, padded to an even length
      }
    } else if (TEXT[id]) (meta.info ??= {})[TEXT[id]!] = textOf(bytes, body, Math.min(bytes.length, body + size));
    p = body + size + (size & 1);
  }
  if (!comm || ssnd < 0) throw new Error('not an AIFF file this tool reads (no COMM or SSND chunk)');
  const { channels, bits, rate } = comm;
  const comp = comm.comp;
  const little = comp === 'sowt';
  const isFloat = comp === 'fl32' || comp === 'FL32';
  if (!['NONE', 'none', 'sowt', 'fl32', 'FL32'].includes(comp)) throw new Error(`only uncompressed AIFF (and AIFF-C none, sowt, fl32) is read, not '${comp}'`);
  const container = Math.ceil(bits / 8);
  if (isFloat ? bits !== 32 : bits < 1 || bits > 32) throw new Error(`an AIFF with ${bits}-bit samples is not supported`);
  const frames = Math.min(comm.frames, Math.floor(ssndLen / (container * channels)));
  checkLimits({ rate, channels, frames }, 'the AIFF', o);
  const format: PcmFormat = isFloat ? 'f32' : container === 1 ? 'pcm8' : container === 2 ? 'pcm16' : container === 3 ? 'pcm24' : 'pcm32';
  const n = frames * channels;
  const data = new Uint8Array(n * container);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < container; k++) {
      const src = bytes[ssnd + i * container + (little ? k : container - 1 - k)]!;
      data[i * container + k] = src;
    }
    if (format === 'pcm8') data[i] = (data[i]! + 128) & 255; // AIFF's 8-bit is signed; a stored 8-bit sample is unsigned
  }
  if (inst) {
    if (inst.base >= 0) { meta.root = inst.base; if (inst.detune) meta.tune = inst.detune; }
    const [mode, b, e] = inst.sustain;
    if (mode !== 0 && marks.has(b) && marks.has(e)) meta.loop = { start: marks.get(b)!, end: marks.get(e)!, type: mode === 2 ? 'alternate' : 'forward' };
  }
  describeMeta(meta, notes);
  return { audio: { rate, channels, format, frames, data }, container: 'aiff', sourceFormat: `${aifc ? 'AIFF-C ' : 'AIFF '}${isFloat ? 'float 32' : `${bits}-bit`}`, meta, notes };
}

// ---- FLAC --------------------------------------------------------------------------------------------------------

const CRC8: Uint8Array = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 255 : (c << 1) & 255; t[i] = c; }
  return t;
})();
const CRC16: Uint16Array = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) { let c = i << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff; t[i] = c; }
  return t;
})();

class Bits {
  pos: number; // bit position
  readonly b: Uint8Array;
  readonly end: number;
  constructor(b: Uint8Array, start: number, end: number) { this.b = b; this.end = end; this.pos = start * 8; }
  get byte(): number { return this.pos >> 3; }
  /** Up to 32 bits, unsigned. */
  u(n: number): number {
    let r = 0;
    while (n > 0) {
      if ((this.pos >> 3) >= this.end) throw new Error('the FLAC data ends early');
      const left = 8 - (this.pos & 7);
      const take = Math.min(left, n);
      const byte = this.b[this.pos >> 3]!;
      r = r * (1 << take) + ((byte >> (left - take)) & ((1 << take) - 1));
      this.pos += take;
      n -= take;
    }
    return r;
  }
  s(n: number): number {
    const x = this.u(n);
    return x >= 2 ** (n - 1) ? x - 2 ** n : x;
  }
  unary(): number {
    let n = 0;
    while (this.u(1) === 0) n++;
    return n;
  }
  align(): void { this.pos = (this.pos + 7) & ~7; }
}

/** The number in a FLAC frame header (UTF-8 style, up to 36 bits). */
function utf8Number(r: Bits): number {
  const first = r.u(8);
  if (first < 0x80) return first;
  let n = first >= 0xfe ? 6 : first >= 0xfc ? 5 : first >= 0xf8 ? 4 : first >= 0xf0 ? 3 : first >= 0xe0 ? 2 : 1;
  if (first < 0xc0) throw new Error('corrupt FLAC frame header');
  let x = first & (0x3f >> n);
  while (n-- > 0) x = x * 64 + (r.u(8) & 0x3f);
  return x;
}

const FLAC_RATES = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];

function decodeFlac(bytes: Uint8Array, o: DecodeOptions): Decoded {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 4;
  let info: { rate: number; channels: number; bits: number; total: number } | null = null;
  const meta: AudioMeta = {};
  for (let last = false; !last;) {
    if (p + 4 > bytes.length) throw new Error('the FLAC file ends before its audio');
    const h = bytes[p]!;
    last = (h & 0x80) !== 0;
    const type = h & 0x7f;
    const len = (bytes[p + 1]! << 16) | (bytes[p + 2]! << 8) | bytes[p + 3]!;
    const body = p + 4;
    if (type === 0 && len >= 34) {
      const r = new Bits(bytes, body + 10, bytes.length);
      const rate = r.u(20), channels = r.u(3) + 1, bits = r.u(5) + 1, total = r.u(36);
      info = { rate, channels, bits, total };
    } else if (type === 4 && body + 4 <= bytes.length) {
      // VORBIS_COMMENT: vendor, then NAME=value pairs, little-endian lengths
      let q = body + 4 + v.getUint32(body, true);
      const n = q + 4 <= bytes.length ? v.getUint32(q, true) : 0;
      q += 4;
      const names: Record<string, string> = { TITLE: 'title', COMMENT: 'comment', COPYRIGHT: 'copyright', ARTIST: 'author', DESCRIPTION: 'comment', GENRE: 'genre', DATE: 'date' };
      for (let k = 0; k < n && q + 4 <= bytes.length && k < 256; k++) {
        const l = v.getUint32(q, true);
        const s = textOf(bytes, q + 4, Math.min(bytes.length, q + 4 + l));
        const eq = s.indexOf('=');
        if (eq > 0 && names[s.slice(0, eq).toUpperCase()]) (meta.info ??= {})[names[s.slice(0, eq).toUpperCase()]!] = s.slice(eq + 1);
        q += 4 + l;
      }
    }
    p = body + len;
  }
  if (!info) throw new Error('the FLAC file has no STREAMINFO block');
  if (info.total) checkLimits({ rate: info.rate, channels: info.channels, frames: info.total }, 'the FLAC file', o);
  const out: number[][] = Array.from({ length: info.channels }, () => []);
  let frames = 0;
  const bpsFor = info.bits;
  const store = bpsFor <= 8 ? 8 : bpsFor <= 16 ? 16 : bpsFor <= 24 ? 24 : 32;
  while (p + 6 < bytes.length) {
    if (bytes[p] !== 0xff || (bytes[p + 1]! & 0xfc) !== 0xf8) throw new Error('corrupt FLAC data (no frame where one should start)');
    const r = new Bits(bytes, p, bytes.length);
    r.u(14); r.u(1); const variable = r.u(1);
    const bsCode = r.u(4), srCode = r.u(4), chCode = r.u(4), szCode = r.u(3); r.u(1);
    utf8Number(r);
    void variable;
    let blockSize = bsCode === 1 ? 192 : bsCode >= 2 && bsCode <= 5 ? 576 << (bsCode - 2) : bsCode >= 8 ? 256 << (bsCode - 8) : 0;
    if (bsCode === 6) blockSize = r.u(8) + 1;
    else if (bsCode === 7) blockSize = r.u(16) + 1;
    if (!blockSize) throw new Error('corrupt FLAC frame header (block size)');
    if (srCode === 12) r.u(8); else if (srCode === 13 || srCode === 14) r.u(16);
    else if (srCode === 15) throw new Error('corrupt FLAC frame header (sample rate)');
    void FLAC_RATES;
    const hdrEnd = r.byte;
    const crc8 = r.u(8);
    let c8 = 0;
    for (let i = p; i < hdrEnd; i++) c8 = CRC8[c8 ^ bytes[i]!]!;
    if (c8 !== crc8) throw new Error('corrupt FLAC frame header (checksum)');
    const chans = chCode < 8 ? chCode + 1 : 2;
    if (chans !== info.channels) throw new Error('the FLAC frame has another channel count than the stream');
    const depth = szCode === 0 ? info.bits : [0, 8, 12, 0, 16, 20, 24, 32][szCode]!;
    if (!depth) throw new Error('corrupt FLAC frame header (sample size)');
    const sub: number[][] = [];
    for (let c = 0; c < chans; c++) {
      const side = (chCode === 8 && c === 1) || (chCode === 9 && c === 0) || (chCode === 10 && c === 1);
      sub.push(subframe(r, blockSize, depth + (side ? 1 : 0)));
    }
    r.align();
    const endBody = r.byte;
    const crc16 = r.u(16);
    let c16 = 0;
    for (let i = p; i < endBody; i++) c16 = ((c16 << 8) & 0xffff) ^ CRC16[(c16 >> 8) ^ bytes[i]!]!;
    if (c16 !== crc16) throw new Error('corrupt FLAC frame (checksum)');
    if (chCode === 8) for (let i = 0; i < blockSize; i++) sub[1]![i] = sub[0]![i]! - sub[1]![i]!; // left, side -> right
    else if (chCode === 9) for (let i = 0; i < blockSize; i++) sub[0]![i] = sub[0]![i]! + sub[1]![i]!; // side, right -> left
    else if (chCode === 10) {
      for (let i = 0; i < blockSize; i++) {
        const side = sub[1]![i]!;
        const mid = sub[0]![i]! * 2 + (side & 1);
        sub[0]![i] = Math.floor((mid + side) / 2);
        sub[1]![i] = Math.floor((mid - side) / 2);
      }
    }
    // to the stored width: left-justified, as the container of the stored format holds them
    const shift = store - depth;
    for (let c = 0; c < chans; c++) {
      const dst = out[c]!;
      for (let i = 0; i < blockSize; i++) dst.push(shift >= 0 ? sub[c]![i]! * 2 ** shift : Math.floor(sub[c]![i]! / 2 ** -shift));
    }
    frames += blockSize;
    if (frames / info.rate > SAMPLE_LIMITS.maxSeconds + 1) throw new Error(`the FLAC file is longer than ${SAMPLE_LIMITS.maxSeconds} s`);
    p = r.byte + 0;
  }
  if (info.total && frames > info.total) frames = info.total;
  checkLimits({ rate: info.rate, channels: info.channels, frames }, 'the FLAC file', o);
  const format: PcmFormat = store === 8 ? 'pcm8' : store === 16 ? 'pcm16' : store === 24 ? 'pcm24' : 'pcm32';
  const bps = FORMAT_BYTES[format];
  const data = new Uint8Array(frames * info.channels * bps);
  const dv = new DataView(data.buffer);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < info.channels; c++) {
      const x = out[c]![i]!;
      const off = (i * info.channels + c) * bps;
      if (format === 'pcm8') dv.setUint8(off, x + 128);
      else if (format === 'pcm16') dv.setInt16(off, x, true);
      else if (format === 'pcm24') { dv.setUint8(off, x & 255); dv.setUint8(off + 1, (x >> 8) & 255); dv.setUint8(off + 2, (x >> 16) & 255); }
      else dv.setInt32(off, x | 0, true);
    }
  }
  const notes: string[] = [];
  if (store !== info.bits) notes.push(`${info.bits}-bit samples are stored as ${store}-bit (left-justified)`);
  describeMeta(meta, notes);
  return { audio: { rate: info.rate, channels: info.channels, format, frames, data }, container: 'flac', sourceFormat: `FLAC ${info.bits}-bit`, meta, notes };
}

/** One FLAC subframe: `n` samples of `depth` bits. */
function subframe(r: Bits, n: number, depth: number): number[] {
  if (r.u(1) !== 0) throw new Error('corrupt FLAC subframe');
  const type = r.u(6);
  let wasted = 0;
  if (r.u(1)) wasted = r.unary() + 1;
  const bits = depth - wasted;
  if (bits < 1 || bits > 33) throw new Error('corrupt FLAC subframe (sample size)');
  const x: number[] = new Array(n);
  if (type === 0) { const c = r.s(bits); for (let i = 0; i < n; i++) x[i] = c; }
  else if (type === 1) { for (let i = 0; i < n; i++) x[i] = r.s(bits); }
  else if (type >= 8 && type <= 12) {
    const order = type - 8;
    for (let i = 0; i < order; i++) x[i] = r.s(bits);
    const res = residual(r, n, order);
    for (let i = order; i < n; i++) {
      const a = x[i - 1] ?? 0, b = x[i - 2] ?? 0, c = x[i - 3] ?? 0, d = x[i - 4] ?? 0;
      const pred = order === 0 ? 0 : order === 1 ? a : order === 2 ? 2 * a - b : order === 3 ? 3 * a - 3 * b + c : 4 * a - 6 * b + 4 * c - d;
      x[i] = res[i - order]! + pred;
    }
  } else if (type >= 32) {
    const order = type - 31;
    for (let i = 0; i < order; i++) x[i] = r.s(bits);
    const prec = r.u(4) + 1;
    if (prec === 16) throw new Error('corrupt FLAC subframe (coefficient precision)');
    const shift = r.s(5);
    const coef: number[] = [];
    for (let i = 0; i < order; i++) coef.push(r.s(prec));
    const res = residual(r, n, order);
    for (let i = order; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < order; j++) sum += coef[j]! * x[i - 1 - j]!;
      x[i] = res[i - order]! + (shift >= 0 ? Math.floor(sum / 2 ** shift) : sum * 2 ** -shift);
    }
  } else throw new Error('corrupt FLAC subframe (type)');
  if (wasted) for (let i = 0; i < n; i++) x[i] = x[i]! * 2 ** wasted;
  return x;
}

function residual(r: Bits, n: number, order: number): number[] {
  const method = r.u(2);
  if (method > 1) throw new Error('corrupt FLAC residual (coding method)');
  const porder = r.u(4);
  const parts = 1 << porder;
  const pbits = method === 0 ? 4 : 5;
  const out: number[] = [];
  for (let k = 0; k < parts; k++) {
    const count = (n >> porder) - (k === 0 ? order : 0);
    if (count < 0) throw new Error('corrupt FLAC residual (partition)');
    const param = r.u(pbits);
    if (param === (1 << pbits) - 1) {
      const raw = r.u(5);
      for (let i = 0; i < count; i++) out.push(raw ? r.s(raw) : 0);
    } else {
      for (let i = 0; i < count; i++) {
        const q = r.unary();
        const m = q * 2 ** param + (param ? r.u(param) : 0);
        out.push(m % 2 === 0 ? m / 2 : -(m + 1) / 2);
      }
    }
  }
  return out;
}
