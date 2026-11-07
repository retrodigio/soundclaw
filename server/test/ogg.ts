// A reader for the Ogg container and the Vorbis headers: enough to check that a file is well formed
// (pages in order, every checksum right, the three Vorbis headers, an end-of-stream page) and how
// many samples it holds. There is no permissively licensed Vorbis decoder to hold it against, so
// the encoder's output is checked structurally here and, where ffmpeg is installed, decoded.

/** Ogg's CRC-32: polynomial 0x04C11DB7, no reflection, no final xor. */
function crc32(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 24;
    for (let i = 0; i < 8; i++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    crc >>>= 0;
  }
  return crc >>> 0;
}

export interface OggInfo {
  pages: number;
  channels: number;
  sampleRate: number;
  /** The last page's granule position: the number of samples in the stream. */
  samples: number;
  packets: number;
  /** The packet types of the first three packets (1 identification, 3 comment, 5 setup). */
  headerTypes: number[];
  bos: boolean;
  eos: boolean;
  vendor: string;
}

export function readOgg(bytes: Uint8Array): OggInfo {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  let pages = 0, seq = -1, serial = -1, last = -1n, packets = 0;
  const first: Uint8Array[] = [];
  let carry: number[] = [];
  let bos = false, eos = false;
  while (at < bytes.length) {
    if (String.fromCharCode(...bytes.subarray(at, at + 4)) !== 'OggS') throw new Error(`page ${pages}: no capture pattern at ${at}`);
    if (bytes[at + 4] !== 0) throw new Error('stream structure version is not 0');
    const flags = bytes[at + 5]!;
    const granule = dv.getBigInt64(at + 6, true);
    const s = dv.getUint32(at + 14, true);
    const n = dv.getUint32(at + 18, true);
    const sum = dv.getUint32(at + 22, true);
    const segs = bytes[at + 26]!;
    const table = bytes.subarray(at + 27, at + 27 + segs);
    const body = table.reduce((a, b) => a + b, 0);
    const end = at + 27 + segs + body;
    if (end > bytes.length) throw new Error(`page ${pages}: runs past the end of the file`);
    const page = bytes.slice(at, end);
    page.fill(0, 22, 26);
    if (crc32(page) !== sum) throw new Error(`page ${pages}: bad checksum`);
    if (pages === 0) { serial = s; bos = (flags & 2) !== 0; } else if (s !== serial) throw new Error('serial number changes');
    if (pages > 0 && (flags & 2) !== 0) throw new Error('a second beginning of stream');
    if (n !== seq + 1) throw new Error(`page ${pages}: sequence ${n}, wanted ${seq + 1}`);
    seq = n;
    if (granule !== -1n) { if (granule < last) throw new Error('granule position goes backwards'); last = granule; }
    let off = at + 27 + segs;
    for (const len of table) {
      carry.push(...bytes.subarray(off, off + len));
      off += len;
      if (len < 255) {
        if (first.length < 3) first.push(Uint8Array.from(carry));
        packets++;
        carry = [];
      }
    }
    eos = (flags & 4) !== 0;
    pages++;
    at = end;
  }
  if (!bos) throw new Error('the first page is not marked beginning of stream');
  if (!eos) throw new Error('the last page is not marked end of stream');
  if (carry.length) throw new Error('the last packet is not finished');
  if (first.length < 3) throw new Error('fewer than three header packets');
  const id = first[0]!;
  const tag = (p: Uint8Array) => String.fromCharCode(...p.subarray(1, 7));
  if (id[0] !== 1 || tag(id) !== 'vorbis' || first[1]![0] !== 3 || tag(first[1]!) !== 'vorbis' || first[2]![0] !== 5 || tag(first[2]!) !== 'vorbis') throw new Error('the three headers are not identification, comment and setup');
  const idv = new DataView(id.buffer, id.byteOffset, id.byteLength);
  if (idv.getUint32(7, true) !== 0) throw new Error('vorbis version is not 0');
  const vlen = new DataView(first[1]!.buffer, first[1]!.byteOffset).getUint32(7, true);
  return {
    pages, channels: id[11]!, sampleRate: idv.getUint32(12, true), samples: Number(last), packets, headerTypes: first.map((p) => p[0]!), bos, eos,
    vendor: String.fromCharCode(...first[1]!.subarray(11, 11 + vlen)),
  };
}
