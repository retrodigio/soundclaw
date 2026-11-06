// PNG output without native dependencies: a zlib stream built here (LZ77 matching with the fixed
// Huffman code), and a small RGB canvas with lines, rectangles and a 5×7 bitmap font. Views are
// images an agent can be shown, so they only need to be correct and small, not pretty.

// ---- CRC-32, Adler-32 ----------------------------------------------------------------------------

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array, seed = 0xffffffff): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = seed;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return c >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---- deflate (fixed Huffman, LZ77) -----------------------------------------------------------------

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

class BitWriter {
  bytes: number[] = [];
  private acc = 0;
  private nbits = 0;
  /** Write `n` bits of `v`, least significant first. */
  bits(v: number, n: number): void {
    this.acc |= v << this.nbits;
    this.nbits += n;
    while (this.nbits >= 8) { this.bytes.push(this.acc & 0xff); this.acc >>>= 8; this.nbits -= 8; }
  }
  /** A Huffman code (most significant bit first). */
  code(v: number, n: number): void {
    let r = 0;
    for (let i = 0; i < n; i++) r |= ((v >> i) & 1) << (n - 1 - i);
    this.bits(r, n);
  }
  finish(): number[] {
    if (this.nbits) this.bytes.push(this.acc & 0xff);
    return this.bytes;
  }
}

function fixedLiteral(w: BitWriter, sym: number): void {
  if (sym < 144) w.code(0x30 + sym, 8);
  else if (sym < 256) w.code(0x190 + sym - 144, 9);
  else if (sym < 280) w.code(sym - 256, 7);
  else w.code(0xc0 + sym - 280, 8);
}

/** A zlib stream (RFC 1950) holding `data`, compressed. */
export function zlibCompress(data: Uint8Array): Uint8Array {
  const w = new BitWriter();
  w.bits(1, 1); // final block
  w.bits(1, 2); // fixed Huffman
  const head = new Int32Array(1 << 15).fill(-1);
  const prev = new Int32Array(data.length).fill(-1);
  const hash = (i: number): number => ((data[i]! << 10) ^ (data[i + 1]! << 5) ^ data[i + 2]!) & 0x7fff;
  let i = 0;
  while (i < data.length) {
    let bestLen = 0, bestDist = 0;
    if (i + 2 < data.length) {
      const h = hash(i);
      let cand = head[h]!;
      let chain = 24;
      while (cand >= 0 && i - cand <= 32768 && chain-- > 0) {
        let l = 0;
        while (l < 258 && i + l < data.length && data[cand + l] === data[i + l]) l++;
        if (l > bestLen) { bestLen = l; bestDist = i - cand; if (l === 258) break; }
        cand = prev[cand]!;
      }
      prev[i] = head[h]!;
      head[h] = i;
    }
    if (bestLen >= 3) {
      let lc = LEN_BASE.length - 1;
      while (LEN_BASE[lc]! > bestLen) lc--;
      fixedLiteral(w, 257 + lc);
      if (LEN_EXTRA[lc]) w.bits(bestLen - LEN_BASE[lc]!, LEN_EXTRA[lc]!);
      let dc = DIST_BASE.length - 1;
      while (DIST_BASE[dc]! > bestDist) dc--;
      w.code(dc, 5);
      if (DIST_EXTRA[dc]) w.bits(bestDist - DIST_BASE[dc]!, DIST_EXTRA[dc]!);
      // index the skipped positions too
      for (let k = 1; k < bestLen; k++) {
        const p = i + k;
        if (p + 2 < data.length) { const h = hash(p); prev[p] = head[h]!; head[h] = p; }
      }
      i += bestLen;
    } else {
      fixedLiteral(w, data[i]!);
      i++;
    }
  }
  fixedLiteral(w, 256);
  const body = w.finish();
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  out.set(body, 2);
  const ad = adler32(data);
  out[out.length - 4] = ad >>> 24; out[out.length - 3] = (ad >>> 16) & 0xff; out[out.length - 2] = (ad >>> 8) & 0xff; out[out.length - 1] = ad & 0xff;
  return out;
}

// ---- PNG -------------------------------------------------------------------------------------------

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  const c = crc32(out.subarray(4, 8 + body.length));
  v.setUint32(8 + body.length, (c ^ 0xffffffff) >>> 0);
  return out;
}

/** An 8-bit RGB PNG from `rgb` (width × height × 3 bytes, row by row). */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const stride = width * 3;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = y === 0 ? 0 : 2; // Up filter after the first row
    for (let x = 0; x < stride; x++) raw[o + 1 + x] = y === 0 ? rgb[x]! : (rgb[y * stride + x]! - rgb[(y - 1) * stride + x]!) & 0xff;
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlibCompress(raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---- 5×7 font ----------------------------------------------------------------------------------------

// Each glyph: seven rows of five pixels ('#' set).
const GLYPHS: Record<string, string> = {
  '0': '.###./#...#/#..##/#.#.#/##..#/#...#/.###.', '1': '..#../.##../..#../..#../..#../..#../.###.', '2': '.###./#...#/....#/...#./..#../.#.../#####',
  '3': '#####/...#./..#../....#/....#/#...#/.###.', '4': '...#./..##./.#.#./#..#./#####/...#./...#.', '5': '#####/#..../####./....#/....#/#...#/.###.',
  '6': '..##./.#.../#..../####./#...#/#...#/.###.', '7': '#####/....#/...#./..#../.#.../.#.../.#...', '8': '.###./#...#/#...#/.###./#...#/#...#/.###.',
  '9': '.###./#...#/#...#/.####/....#/...#./.##..',
  A: '.###./#...#/#...#/#####/#...#/#...#/#...#', B: '####./#...#/#...#/####./#...#/#...#/####.', C: '.###./#...#/#..../#..../#..../#...#/.###.',
  D: '####./#...#/#...#/#...#/#...#/#...#/####.', E: '#####/#..../#..../####./#..../#..../#####', F: '#####/#..../#..../####./#..../#..../#....',
  G: '.###./#...#/#..../#.###/#...#/#...#/.###.', H: '#...#/#...#/#...#/#####/#...#/#...#/#...#', I: '.###./..#../..#../..#../..#../..#../.###.',
  J: '..###/...#./...#./...#./...#./#..#./.##..', K: '#...#/#..#./#.#../##.../#.#../#..#./#...#', L: '#..../#..../#..../#..../#..../#..../#####',
  M: '#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#', N: '#...#/##..#/#.#.#/#..##/#...#/#...#/#...#', O: '.###./#...#/#...#/#...#/#...#/#...#/.###.',
  P: '####./#...#/#...#/####./#..../#..../#....', Q: '.###./#...#/#...#/#...#/#.#.#/#..#./.##.#', R: '####./#...#/#...#/####./#.#../#..#./#...#',
  S: '.####/#..../#..../.###./....#/....#/####.', T: '#####/..#../..#../..#../..#../..#../..#..', U: '#...#/#...#/#...#/#...#/#...#/#...#/.###.',
  V: '#...#/#...#/#...#/#...#/#...#/.#.#./..#..', W: '#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#', X: '#...#/#...#/.#.#./..#../.#.#./#...#/#...#',
  Y: '#...#/#...#/.#.#./..#../..#../..#../..#..', Z: '#####/....#/...#./..#../.#.../#..../#####',
  '.': '...../...../...../...../...../.##../.##..', ',': '...../...../...../...../.##../..#../.#...', '-': '...../...../...../#####/...../...../.....',
  '+': '...../..#../..#../#####/..#../..#../.....', ':': '...../.##../.##../...../.##../.##../.....', '#': '.#.#./.#.#./#####/.#.#./#####/.#.#./.#.#.',
  '/': '....#/....#/...#./..#../.#.../#..../#....', '%': '##..#/##..#/...#./..#../.#.../#..##/#..##', '(': '...#./..#../.#.../.#.../.#.../..#../...#.',
  ')': '.#.../..#../...#./...#./...#./..#../.#...', '=': '...../...../#####/...../#####/...../.....', '<': '...#./..#../.#.../#..../.#.../..#../...#.',
  '>': '.#.../..#../...#./....#/...#./..#../.#...', '?': '.###./#...#/....#/...#./..#../...../..#..', '~': '...../...../.#..#/#.##./...../...../.....',
  '*': '...../#.#.#/.###./#####/.###./#.#.#/.....', "'": '..#../..#../...../...../...../...../.....', '_': '...../...../...../...../...../...../#####',
};

export const GLYPH_W = 5;
export const GLYPH_H = 7;

export type Rgb = readonly [number, number, number];

/** A drawing surface. */
export class Canvas {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number, bg: Rgb = [20, 22, 28]) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) { this.data[i * 3] = bg[0]; this.data[i * 3 + 1] = bg[1]; this.data[i * 3 + 2] = bg[2]; }
  }
  set(x: number, y: number, c: Rgb): void {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const o = (y * this.width + x) * 3;
    this.data[o] = c[0]; this.data[o + 1] = c[1]; this.data[o + 2] = c[2];
  }
  rect(x: number, y: number, w: number, h: number, c: Rgb): void {
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w)), y1 = Math.min(this.height, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.set(xx, yy, c);
  }
  hline(x0: number, x1: number, y: number, c: Rgb, dash = 0): void {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) if (!dash || Math.floor(x / dash) % 2 === 0) this.set(x, y, c);
  }
  vline(x: number, y0: number, y1: number, c: Rgb, dash = 0): void {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) if (!dash || Math.floor(y / dash) % 2 === 0) this.set(x, y, c);
  }
  line(x0: number, y0: number, x1: number, y1: number, c: Rgb): void {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) this.set(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, c);
  }
  /** Text in the 5×7 font (upper case), scale 1 or 2; `align` right/centre use `x` as that edge. Returns the width drawn. */
  text(s: string, x: number, y: number, c: Rgb, o: { scale?: number; align?: 'left' | 'right' | 'center' } = {}): number {
    const sc = o.scale ?? 1;
    const str = s.toUpperCase();
    const w = str.length * (GLYPH_W + 1) * sc - sc;
    let ox = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
    for (const ch of str) {
      const g = GLYPHS[ch];
      if (g) {
        g.split('/').forEach((row, ry) => {
          for (let rx = 0; rx < GLYPH_W; rx++) if (row[rx] === '#') this.rect(ox + rx * sc, y + ry * sc, sc, sc, c);
        });
      }
      ox += (GLYPH_W + 1) * sc;
    }
    return w;
  }
  png(): Uint8Array {
    return encodePng(this.width, this.height, this.data);
  }
}
