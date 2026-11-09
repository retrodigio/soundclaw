// Test-only audio file writers: WAV (with the extra chunks real files carry), AIFF / AIFF-C and FLAC. The repository holds no
// third-party audio; every fixture is made here from integers and read back by the decoders under test.

import { FORMAT_BYTES, type PcmAudio, type PcmFormat } from '../src/pcm.ts';

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const u32le = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const u16le = (n: number): number[] => [n & 255, (n >>> 8) & 255];
const u32be = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16be = (n: number): number[] => [(n >>> 8) & 255, n & 255];

/** A RIFF chunk (padded to an even length). */
export function riffChunk(id: string, body: number[] | Uint8Array): number[] {
  const b = Array.from(body);
  return [...ascii(id), ...u32le(b.length), ...b, ...(b.length & 1 ? [0] : [])];
}

/** Numbers that are the same on every machine (no Math functions): a linear congruential generator. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** Stored audio of `frames` frames of generated integers. */
export function makeAudio(format: PcmFormat, channels: number, frames: number, rate = 44100, seed = 7): PcmAudio {
  const r = lcg(seed);
  const bps = FORMAT_BYTES[format];
  const data = new Uint8Array(frames * channels * bps);
  const v = new DataView(data.buffer);
  let walk = 0;
  for (let i = 0; i < frames * channels; i++) {
    // a slow random walk, so predictors have something to predict
    walk = Math.max(-0.9, Math.min(0.9, walk + (r() - 0.5) * 0.1));
    const x = walk;
    const o = i * bps;
    if (format === 'pcm8') v.setUint8(o, Math.round(x * 127) + 128);
    else if (format === 'pcm16') v.setInt16(o, Math.round(x * 32767), true);
    else if (format === 'pcm24') { const n = Math.round(x * 8388607); v.setUint8(o, n & 255); v.setUint8(o + 1, (n >> 8) & 255); v.setUint8(o + 2, (n >> 16) & 255); }
    else if (format === 'pcm32') v.setInt32(o, Math.round(x * 2147483647), true);
    else v.setFloat32(o, x, true);
  }
  return { rate, channels, format, frames, data };
}

/** The values of one channel as signed integers at the stored width (8-bit is made signed). */
export function channelInts(a: PcmAudio, c: number): number[] {
  const v = new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength);
  const bps = FORMAT_BYTES[a.format];
  const out: number[] = [];
  for (let i = 0; i < a.frames; i++) {
    const o = (i * a.channels + c) * bps;
    out.push(a.format === 'pcm8' ? v.getUint8(o) - 128 : a.format === 'pcm16' ? v.getInt16(o, true) : a.format === 'pcm24' ? (v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)) : v.getInt32(o, true));
  }
  return out;
}

// ---- WAV ---------------------------------------------------------------------------------------------------------

export interface WavOptions {
  /** Chunks written between `fmt ` and `data`, and after `data`. */
  before?: number[][];
  after?: number[][];
  /** WAVE_FORMAT_EXTENSIBLE with the PCM or float sub-format. */
  extensible?: boolean;
  /** Write 64-bit float samples (from the stored 32-bit floats). */
  float64?: boolean;
}

export function wavBytes(a: PcmAudio, o: WavOptions = {}): Uint8Array {
  const float = a.format === 'f32';
  const bits = o.float64 ? 64 : FORMAT_BYTES[a.format] * 8;
  const tag = float ? 3 : 1;
  const bpf = (bits / 8) * a.channels;
  const fmt = o.extensible
    ? [...u16le(0xfffe), ...u16le(a.channels), ...u32le(a.rate), ...u32le(a.rate * bpf), ...u16le(bpf), ...u16le(bits), ...u16le(22), ...u16le(bits), ...u32le(3), ...u16le(tag), ...ascii('\x00\x00\x00\x00\x10\x00\x80\x00\x00\xaa\x00\x38\x9b\x71')]
    : [...u16le(tag), ...u16le(a.channels), ...u32le(a.rate), ...u32le(a.rate * bpf), ...u16le(bpf), ...u16le(bits)];
  let data: Uint8Array = a.data;
  if (o.float64) {
    data = new Uint8Array(a.frames * a.channels * 8);
    const src = new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength);
    const dst = new DataView(data.buffer);
    for (let i = 0; i < a.frames * a.channels; i++) dst.setFloat64(i * 8, src.getFloat32(i * 4, true), true);
  }
  const body = [...ascii('WAVE'), ...riffChunk('fmt ', fmt), ...(o.before ?? []).flat(), ...riffChunk('data', data), ...(o.after ?? []).flat()];
  return Uint8Array.from([...ascii('RIFF'), ...u32le(body.length), ...body]);
}

/** A `smpl` chunk: root note, pitch fraction (1/2^32 of a semitone), and one loop. */
export function smplChunk(o: { note: number; fraction?: number; loop?: { start: number; end: number; type?: number } }): number[] {
  return riffChunk('smpl', [
    ...u32le(0), ...u32le(0), ...u32le(22675), ...u32le(o.note), ...u32le(o.fraction ?? 0), ...u32le(0), ...u32le(0), ...u32le(o.loop ? 1 : 0), ...u32le(0),
    ...(o.loop ? [...u32le(0), ...u32le(o.loop.type ?? 0), ...u32le(o.loop.start), ...u32le(o.loop.end), ...u32le(0), ...u32le(0)] : []),
  ]);
}

export function acidChunk(o: { oneShot?: boolean; root?: number; tempo?: number }): number[] {
  const f = new DataView(new ArrayBuffer(4));
  f.setFloat32(0, o.tempo ?? 0, true);
  return riffChunk('acid', [...u32le((o.oneShot ? 1 : 0) | (o.root !== undefined ? 2 : 0)), ...u16le(o.root ?? 0), ...u16le(0), ...u32le(0), ...u32le(0), ...u16le(4), ...u16le(4), ...Array.from(new Uint8Array(f.buffer))]);
}

export function cueChunk(points: number[]): number[] {
  return riffChunk('cue ', [...u32le(points.length), ...points.flatMap((p, i) => [...u32le(i + 1), ...u32le(p), ...ascii('data'), ...u32le(0), ...u32le(0), ...u32le(p)])]);
}

export function infoChunk(tags: Record<string, string>): number[] {
  return riffChunk('LIST', [...ascii('INFO'), ...Object.entries(tags).flatMap(([k, v]) => riffChunk(k, [...ascii(v), 0]))]);
}

// ---- AIFF --------------------------------------------------------------------------------------------------------

function extended80(n: number): number[] {
  const e = Math.floor(Math.log2(n));
  const mant = BigInt(n) << BigInt(63 - e);
  const out: number[] = [...u16be(16383 + e)];
  for (let i = 7; i >= 0; i--) out.push(Number((mant >> BigInt(i * 8)) & 255n));
  return out;
}

const bechunk = (id: string, body: number[]): number[] => [...ascii(id), ...u32be(body.length), ...body, ...(body.length & 1 ? [0] : [])];

export interface AiffOptions {
  compression?: 'NONE' | 'sowt' | 'fl32';
  /** INST: base note and detune (cents), a sustain loop between two marker positions. */
  inst?: { note: number; detune?: number; loop?: { start: number; end: number } };
  text?: Record<string, string>;
}

export function aiffBytes(a: PcmAudio, o: AiffOptions = {}): Uint8Array {
  const comp = o.compression;
  const bps = FORMAT_BYTES[a.format];
  const little = comp === 'sowt';
  const raw: number[] = [];
  for (let i = 0; i < a.frames * a.channels; i++) {
    const cell = Array.from(a.data.subarray(i * bps, (i + 1) * bps));
    if (a.format === 'pcm8') cell[0] = (cell[0]! + 128) & 255;
    raw.push(...(little ? cell : cell.reverse()));
  }
  const aifc = comp !== undefined;
  const name = comp === 'sowt' ? 'not compressed' : comp === 'fl32' ? '32-bit floating point' : 'not compressed';
  const type = comp === 'sowt' ? 'sowt' : comp === 'fl32' ? 'fl32' : 'NONE';
  const comm = bechunk('COMM', [...u16be(a.channels), ...u32be(a.frames), ...u16be(bps * 8), ...extended80(a.rate), ...(aifc ? [...ascii(type), name.length, ...ascii(name), ...((name.length + 1) & 1 ? [0] : [])] : [])]);
  const ssnd = bechunk('SSND', [...u32be(0), ...u32be(0), ...raw]);
  const extra: number[] = [];
  if (o.inst) {
    const l = o.inst.loop;
    extra.push(...bechunk('MARK', [...u16be(l ? 2 : 0), ...(l ? [...u16be(1), ...u32be(l.start), 1, 65, ...u16be(2), ...u32be(l.end), 1, 66] : [])]));
    extra.push(...bechunk('INST', [o.inst.note, (o.inst.detune ?? 0) & 255, 0, 127, 0, 127, 0, 0, ...u16be(l ? 1 : 0), ...u16be(l ? 1 : 0), ...u16be(l ? 2 : 0), ...u16be(0), ...u16be(0), ...u16be(0)]));
  }
  for (const [k, v] of Object.entries(o.text ?? {})) extra.push(...bechunk(k, ascii(v)));
  const body = [...ascii(aifc ? 'AIFC' : 'AIFF'), ...(aifc ? bechunk('FVER', u32be(0xa2805140)) : []), ...comm, ...extra, ...ssnd];
  return Uint8Array.from([...ascii('FORM'), ...u32be(body.length), ...body]);
}

// ---- FLAC --------------------------------------------------------------------------------------------------------

class BitWriter {
  bytes: number[] = [];
  private cur = 0;
  private n = 0;
  bits(value: number, count: number): void {
    // value may be negative (two's complement) and up to 33 bits
    const v = value < 0 ? value + 2 ** count : value;
    for (let i = count - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | (Math.floor(v / 2 ** i) & 1);
      if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
    }
  }
  unary(q: number): void { for (let i = 0; i < q; i++) this.bits(0, 1); this.bits(1, 1); }
  align(): void { while (this.n) this.bits(0, 1); }
}

function crc8(b: number[]): number {
  let c = 0;
  for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 255 : (c << 1) & 255; }
  return c;
}
function crc16(b: number[]): number {
  let c = 0;
  for (const x of b) { c ^= x << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff; }
  return c;
}

export type FlacKind = 'verbatim' | 'constant' | 'fixed0' | 'fixed1' | 'fixed2' | 'fixed3' | 'fixed4' | 'lpc';
export type FlacStereo = 'independent' | 'left-side' | 'right-side' | 'mid-side';

export interface FlacOptions {
  blockSize?: number;
  kind?: FlacKind;
  stereo?: FlacStereo;
  /** Rice partition order (0-3), and the 5-bit coding method. */
  partitionOrder?: number;
  riceMethod?: 0 | 1;
  /** Write the first partition's samples raw (the escape code). */
  escape?: boolean;
  comments?: Record<string, string>;
}

function rice(w: BitWriter, res: number[], order: number, n: number, partOrder: number, method: 0 | 1, escape: boolean): void {
  w.bits(method, 2);
  w.bits(partOrder, 4);
  const parts = 1 << partOrder;
  let at = 0;
  for (let p = 0; p < parts; p++) {
    const count = (n >> partOrder) - (p === 0 ? order : 0);
    const part = res.slice(at, at + count);
    at += count;
    const pbits = method === 0 ? 4 : 5;
    if (escape && p === 0 && part.length) {
      const width = Math.max(1, ...part.map((x) => Math.ceil(Math.log2(Math.abs(x) + 1)) + 1));
      w.bits((1 << pbits) - 1, pbits);
      w.bits(width, 5);
      for (const x of part) w.bits(x, width);
      continue;
    }
    const zz = part.map((x) => (x >= 0 ? 2 * x : -2 * x - 1));
    const mean = zz.length ? zz.reduce((s, x) => s + x, 0) / zz.length : 0;
    const k = Math.max(0, Math.min((1 << pbits) - 2, Math.floor(Math.log2(mean + 1))));
    w.bits(k, pbits);
    for (const z of zz) { w.unary(Math.floor(z / 2 ** k)); if (k) w.bits(z % 2 ** k, k); }
  }
}

function subframe(w: BitWriter, x: number[], depth: number, o: FlacOptions): void {
  let wasted = 0;
  if (x.some((v) => v !== 0)) while (x.every((v) => v % 2 ** (wasted + 1) === 0) && wasted < 8) wasted++;
  const s = wasted ? x.map((v) => v / 2 ** wasted) : x;
  const bits = depth - wasted;
  const n = s.length;
  const kind = o.kind ?? 'fixed2';
  const flagWasted = () => { if (wasted) { w.bits(1, 1); w.unary(wasted - 1); } else w.bits(0, 1); };
  const resid = (order: number, pred: (i: number) => number): number[] => { const r: number[] = []; for (let i = order; i < n; i++) r.push(s[i]! - pred(i)); return r; };
  w.bits(0, 1);
  if (kind === 'constant' && s.every((v) => v === s[0])) { w.bits(0, 6); flagWasted(); w.bits(s[0]!, bits); return; }
  if (kind === 'verbatim' || kind === 'constant') { w.bits(1, 6); flagWasted(); for (const v of s) w.bits(v, bits); return; }
  const po = o.partitionOrder ?? 0;
  if (kind === 'lpc') {
    // order 2, coefficients 3 and -1 with a shift of 1: prediction (3a - b) / 2, rounded down
    w.bits(32 + 1, 6); flagWasted();
    w.bits(s[0]!, bits); w.bits(s[1]!, bits);
    w.bits(4 - 1, 4); w.bits(1, 5); w.bits(3, 4); w.bits(-1, 4);
    rice(w, resid(2, (i) => Math.floor((3 * s[i - 1]! - s[i - 2]!) / 2)), 2, n, po, o.riceMethod ?? 0, !!o.escape);
    return;
  }
  const order = Number(kind.slice(5));
  w.bits(8 + order, 6); flagWasted();
  for (let i = 0; i < order; i++) w.bits(s[i]!, bits);
  const at = (i: number, k: number) => s[i - k]!;
  const pred = (i: number): number => order === 0 ? 0 : order === 1 ? at(i, 1) : order === 2 ? 2 * at(i, 1) - at(i, 2) : order === 3 ? 3 * at(i, 1) - 3 * at(i, 2) + at(i, 3) : 4 * at(i, 1) - 6 * at(i, 2) + 4 * at(i, 3) - at(i, 4);
  rice(w, resid(order, pred), order, n, po, o.riceMethod ?? 0, !!o.escape);
}

/** FLAC bytes for per-channel integer samples at `bits` bits. */
export function flacBytes(chs: number[][], bits: number, rate: number, o: FlacOptions = {}): Uint8Array {
  const channels = chs.length;
  const total = chs[0]!.length;
  const block = o.blockSize ?? 1152;
  const out: number[] = [...ascii('fLaC')];
  const si = new BitWriter();
  si.bits(block, 16); si.bits(block, 16); si.bits(0, 24); si.bits(0, 24); si.bits(rate, 20); si.bits(channels - 1, 3); si.bits(bits - 1, 5); si.bits(total, 36);
  for (let i = 0; i < 16; i++) si.bits(0, 8);
  const comments = Object.entries(o.comments ?? {});
  out.push(comments.length ? 0 : 0x80, 0, 0, 34, ...si.bytes);
  if (comments.length) {
    const vendor = ascii('test');
    const body = [...u32le(vendor.length), ...vendor, ...u32le(comments.length), ...comments.flatMap(([k, v]) => { const t = ascii(`${k}=${v}`); return [...u32le(t.length), ...t]; })];
    out.push(0x80 | 4, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255, ...body);
  }
  let frame = 0;
  for (let at = 0; at < total; at += block, frame++) {
    const n = Math.min(block, total - at);
    let parts = chs.map((c) => c.slice(at, at + n));
    let code = channels - 1;
    const depths = parts.map(() => bits);
    const mode = channels === 2 ? o.stereo ?? 'independent' : 'independent';
    if (mode !== 'independent') {
      const [L, R] = parts as [number[], number[]];
      const side = L.map((l, i) => l - R[i]!);
      if (mode === 'left-side') { parts = [L, side]; code = 8; depths[1] = bits + 1; }
      else if (mode === 'right-side') { parts = [side, R]; code = 9; depths[0] = bits + 1; }
      else { parts = [L.map((l, i) => Math.floor((l + R[i]!) / 2)), side]; code = 10; depths[1] = bits + 1; }
    }
    const h: number[] = [0xff, 0xf8];
    const hb = new BitWriter();
    hb.bits(n <= 256 ? 6 : 7, 4); hb.bits(0, 4); hb.bits(code, 4); hb.bits(0, 3); hb.bits(0, 1);
    h.push(...hb.bytes);
    // the frame number, UTF-8 style (frames here stay below 128 or 2048)
    h.push(...(frame < 128 ? [frame] : [0xc0 | (frame >> 6), 0x80 | (frame & 63)]));
    h.push(...(n <= 256 ? [n - 1] : [(n - 1) >> 8, (n - 1) & 255]));
    h.push(crc8(h));
    const bw = new BitWriter();
    parts.forEach((p, i) => subframe(bw, p, depths[i]!, o));
    bw.align();
    const body = [...h, ...bw.bytes];
    for (const x of [...body, ...u16be(crc16(body))]) out.push(x);
  }
  return Uint8Array.from(out);
}
