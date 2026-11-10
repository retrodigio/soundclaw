// The song meters' worker. The page hands it each channel's rendered audio once (only the channels
// that changed), and it keeps a small track per channel: the peak of every 1/60 s block and the
// K-weighted energy of it. While a song plays it reads those tracks at the playhead and posts the
// levels about thirty times a second. The page draws them in requestAnimationFrame without touching
// React state. The send buses are run here too; the room (convolution) bus is given its response's audio.

import { busReturns, kWeighting, type ChannelAudio, type SampleBank, type SampleData, type SongDoc } from '@soundclaw/core';

const RATE = 44100;
const BLOCK = 735; // 60 blocks a second
const HZ = 30;

export interface LoadMessage {
  op: 'load';
  /** The render these belong to, and the played mix's key. */
  key: string;
  mixKey: string;
  song: SongDoc;
  wrap: boolean;
  /** Every channel of the render, in the order the levels come back; `audio` only for the ones the worker does not hold. */
  parts: { name: string; layer: string; key: string; audio?: [Float32Array, Float32Array] }[];
  mix: [Float32Array, Float32Array] | null;
  /** The room bus's response (the sample its `ir` names), or null when the song has no room or the page has not fetched it. */
  ir: { name: string; hash: string; sample: SampleData } | null;
}
export interface PlayMessage {
  op: 'play';
  /** `performance.now()` when the buffer was at `pos` seconds. */
  perf: number;
  pos: number;
  length: number;
  mode: 'full' | 'loop';
  region: { a: number; len: number } | null;
  audible: string[];
}
export type MeterIn = LoadMessage | PlayMessage | { op: 'stop' };
export type MeterOut =
  | { op: 'loaded'; key: string; slots: string[] }
  | { op: 'levels'; at: number; pos: number; values: Float32Array };

interface Track { pk: Float32Array; cum: Float64Array; blocks: number }

const raw = new Map<string, [Float32Array, Float32Array]>();
const tracks = new Map<string, Track>();
let slots: { name: string; track: string | null; part: boolean }[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let play: PlayMessage | null = null;

function biquad(x: ArrayLike<number>, b: number[], out: Float64Array): void {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const [b0, b1, b2, a1, a2] = b as [number, number, number, number, number];
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i]! + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]!; y2 = y1; y1 = v;
    out[i] = v;
  }
}

function trackOf(l: Float32Array, r: Float32Array): Track {
  const n = l.length;
  const blocks = Math.max(1, Math.ceil(n / BLOCK));
  const pk = new Float32Array(blocks * 2);
  const e = new Float64Array(blocks);
  const [s1, s2] = kWeighting(RATE);
  const tmp = new Float64Array(n), w = new Float64Array(n);
  [l, r].forEach((x, c) => {
    biquad(x, s1 as unknown as number[], tmp);
    biquad(tmp, s2 as unknown as number[], w);
    for (let b = 0; b < blocks; b++) {
      let p = 0, s = 0;
      const end = Math.min(n, (b + 1) * BLOCK);
      for (let i = b * BLOCK; i < end; i++) { const a = Math.abs(x[i]!); if (a > p) p = a; s += w[i]! * w[i]!; }
      pk[b * 2 + c] = p;
      e[b] = e[b]! + s / BLOCK;
    }
  });
  const cum = new Float64Array(blocks + 1);
  for (let b = 0; b < blocks; b++) cum[b + 1] = cum[b]! + e[b]!;
  return { pk, cum, blocks };
}

const db = (x: number): number => (x > 1e-6 ? 20 * Math.log10(x) : -120);

function load(m: LoadMessage): void {
  const keep = new Set<string>();
  for (const p of m.parts) {
    keep.add(p.key);
    if (p.audio) raw.set(p.key, p.audio);
    if (!tracks.has(p.key) && raw.has(p.key)) { const a = raw.get(p.key)!; tracks.set(p.key, trackOf(a[0], a[1])); }
  }
  keep.add(m.mixKey);
  if (m.mix && !tracks.has(m.mixKey)) tracks.set(m.mixKey, trackOf(m.mix[0], m.mix[1]));
  const busKeys: { name: string; track: string | null; part: boolean }[] = [];
  const parts: ChannelAudio[] = m.parts.flatMap((p) => { const a = raw.get(p.key); return a ? [{ name: p.name, layer: p.layer, key: p.key, channels: a }] : []; });
  const N = parts[0]?.channels[0].length ?? 0;
  const ir = m.ir;
  const bank: SampleBank | undefined = ir ? { get: (n) => (n === ir.name ? ir.sample : undefined), hash: (n) => (n === ir.name ? ir.hash : undefined) } : undefined;
  for (const kind of ['reverb', 'delay', 'convolve'] as const) {
    const k = `${m.key}|${kind}${kind === 'convolve' && ir ? `|${ir.hash}` : ''}`;
    keep.add(k);
    if (m.song[kind] && N && !tracks.has(k)) {
      const only = { ...m.song, reverb: null, delay: null, convolve: null, [kind]: m.song[kind] } as SongDoc;
      const ret = busReturns(only, parts, N, m.wrap, bank);
      if (ret) tracks.set(k, trackOf(Float32Array.from(ret[0]), Float32Array.from(ret[1])));
    }
    busKeys.push({ name: kind, track: tracks.has(k) ? k : null, part: false });
  }
  // the audio itself is kept only for the buses, which run over all the channels at once
  const keepRaw = !!(m.song.reverb || m.song.delay || m.song.convolve);
  for (const k of [...raw.keys()]) if (!keep.has(k) || !keepRaw) raw.delete(k);
  for (const k of [...tracks.keys()]) if (!keep.has(k)) tracks.delete(k);
  slots = [...m.parts.map((p) => ({ name: p.name, track: p.key, part: true })), { name: 'master', track: m.mixKey, part: false }, ...busKeys];
  (self as unknown as Worker).postMessage({ op: 'loaded', key: m.key, slots: slots.map((s) => s.name) } satisfies MeterOut);
}

function tick(): void {
  const p = play;
  if (!p) return;
  const t = p.pos + (performance.now() - p.perf) / 1000;
  let pos: number;
  if (p.region) pos = t < p.region.a + p.region.len ? t : p.region.a + ((t - p.region.a) % p.region.len);
  else pos = p.mode === 'loop' ? t % p.length : Math.min(t, p.length);
  const block = Math.floor(pos * (RATE / BLOCK));
  const values = new Float32Array(slots.length * 3);
  slots.forEach((s, i) => {
    const tr = s.track ? tracks.get(s.track) : null;
    const on = !s.part || p.audible.includes(s.name);
    if (!tr || !on) { values[i * 3] = -120; values[i * 3 + 1] = -120; values[i * 3 + 2] = -70; return; }
    const b1 = Math.min(tr.blocks - 1, block), b0 = Math.max(0, b1 - 1);
    let l = 0, r = 0;
    for (let b = b0; b <= b1; b++) { l = Math.max(l, tr.pk[b * 2]!); r = Math.max(r, tr.pk[b * 2 + 1]!); }
    const w0 = Math.max(0, b1 + 1 - 180);
    const ms = (tr.cum[b1 + 1]! - tr.cum[w0]!) / Math.max(1, b1 + 1 - w0);
    values[i * 3] = db(l); values[i * 3 + 1] = db(r); values[i * 3 + 2] = ms > 0 ? Math.max(-70, -0.691 + 10 * Math.log10(ms)) : -70;
  });
  (self as unknown as Worker).postMessage({ op: 'levels', at: performance.now(), pos, values } satisfies MeterOut, [values.buffer]);
}

self.onmessage = (ev: MessageEvent<MeterIn>) => {
  const m = ev.data;
  if (m.op === 'load') load(m);
  else if (m.op === 'play') {
    play = m;
    if (!timer) timer = setInterval(tick, 1000 / HZ);
  } else {
    play = null;
    if (timer) { clearInterval(timer); timer = null; }
  }
};
