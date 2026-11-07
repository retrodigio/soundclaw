// Rendering a song. Every channel is rendered on its own (a sum of notes, each note one cached render
// of its instrument), then the channels are summed with the song's gain and sent through the master
// chain. Channels are the cached parts: a channel's key is the notes it plays, its instruments and
// its gain and pan, so changing one channel renders that channel again and nothing else.
//
// Only + - * / and the renderer's own functions are used, so a song renders to the same bytes in
// Node and in the browser.
//
// A loop is rendered as the loop region folded onto itself: every note is rendered with its tail, and
// what runs past the end of the region is added to its start. The sum is what a player hears when the
// region repeats, so the seam has no click and no dip. The master chain then runs over the region twice
// and the second pass is kept, so a compressor or limiter starts the loop in the state it ends it in.

import { drumInstrument, channelNotes, DEFAULT_LAYER, SEND_KINDS, type Arrangement, type Channel, type Instance, type NoteEv, type SongDoc, arrange } from './song.ts';
import { instrumentKey, noteLength, renderNote, velocityGain, type Instrument } from './instrument.ts';
import { sha256Text } from './sha256.ts';
import { RENDER_VERSION, SAMPLE_RATE } from './sound.ts';
import { applyFxChain, fxTail, panGains, type LimiterMemo, type SampleBank } from './synth.ts';
import type { Fx } from './layered.ts';

export interface PartStore {
  get(key: string): Float32Array | null;
  put(key: string, samples: Float32Array): void;
}

export interface SongRenderOptions {
  instruments: (id: string) => Instrument | undefined;
  bank?: SampleBank;
  store?: PartStore;
  /** `full`: intro, the body (its loop region `loops` times) and the ending. `loop`: the loop region alone, folded onto itself. */
  mode?: 'full' | 'loop';
  loops?: number;
  /** Render only these channels (the others are silent): for looking at one part alone. */
  only?: readonly string[];
  /**
   * Rendered notes kept between renders (by instrument, pitch, length and effects), so a channel whose
   * notes changed is summed again from the notes it already had, rendering only the new ones. The page
   * keeps one; the samples are the same with or without it.
   */
  notes?: Map<string, Float32Array[]>;
  /** What a limiter at the head of the master chain worked out last render (left, right): kept by the page per song and mode. */
  limiter?: { value: LimiterMemo | null }[];
}

export interface ChannelAudio {
  name: string;
  layer: string;
  /** What the channel's samples depend on (its notes, instruments, gain, pan and length): the same key, the same samples. */
  key: string;
  /** Left and right, the same length as the song. */
  channels: [Float32Array, Float32Array];
}

export interface SongRender {
  mode: 'full' | 'loop';
  /** Samples in the song (the loop region's length in loop mode). */
  length: number;
  /** The span of the arrangement that was rendered, seconds. */
  window: { start: number; end: number };
  /** After the master chain. */
  mix: [Float32Array, Float32Array];
  /** The sum of the channels before the master chain. */
  pre: [Float32Array, Float32Array];
  parts: ChannelAudio[];
  stems: { layer: string; channels: [Float32Array, Float32Array] }[];
  /** The notes each channel plays in this render, times relative to the start of the window. */
  events: Map<string, NoteEv[]>;
  key: string;
  /** Channels served from the store rather than rendered. */
  cached: number;
}

const SR = SAMPLE_RATE;
const MAX_TAIL = 4;

/** The instances a mode plays: `full` repeats the loop region `loops` times. */
export function playlist(arr: Arrangement, loops = 1): { instances: Instance[]; total: number } {
  if (!arr.loop || loops === 1) return { instances: arr.instances, total: arr.total };
  const region = arr.instances.filter((i) => i.inLoop);
  const len = arr.loop.end - arr.loop.start;
  const out: Instance[] = [];
  for (const i of arr.instances) {
    if (i.t0 + 1e-9 < arr.loop.start) out.push(i);
    else if (i.inLoop) {
      if (i === region[0]) for (let k = 0; k < loops; k++) for (const r of region) out.push({ ...r, t0: r.t0 + k * len });
    } else out.push({ ...i, t0: i.t0 + (loops - 1) * len });
  }
  out.forEach((i, k) => { i.index = k; });
  return { instances: out, total: arr.total + (loops - 1) * len };
}

function eventsText(ev: readonly NoteEv[], N: number): string {
  return ev.map((e) => `${Math.round(e.t * SR)}/${Math.round(e.len * SR)}/${e.midi ?? e.drum}/${e.vel}/${e.slideFrom ?? ''}/${e.fx.slide ? 's' : ''}${e.fx.vib ? `v${e.fx.vib.rate},${e.fx.vib.depth}` : ''}${e.fx.arp ? `a${e.fx.arp.join(',')}` : ''}`).join(';') + `#${N}`;
}

function renderChannelAudio(song: SongDoc, ch: Channel, ev: readonly NoteEv[], N: number, wrap: boolean, o: SongRenderOptions, cache: { key: string; hit: boolean }): [Float32Array, Float32Array] {
  const used = new Map<string, Instrument>();
  const instOf = (e: NoteEv): Instrument => {
    const id = e.drum !== null ? drumInstrument(ch, e.drum) : ch.inst;
    const inst = id ? o.instruments(id) : undefined;
    if (!id || !inst) throw new Error(`channel ${ch.name}: ${e.drum !== null ? `no drum '${e.drum}'` : 'no instrument'}${id ? ` '${id}'` : ''}`);
    used.set(id, inst);
    return inst;
  };
  for (const e of ev) instOf(e);
  const hash = (n: string): string => o.bank?.hash(n) ?? 'missing';
  const keys = [...used].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, i]) => `${id}=${instrumentKey(i, hash)}`).join(',');
  const key = sha256Text(`${RENDER_VERSION}|channel|${wrap ? 'wrap' : 'run'}|${ch.gain}|${ch.pan}|${keys}|${eventsText(ev, N)}`);
  cache.key = key;
  const hit = o.store?.get(key);
  if (hit && hit.length === 2 * N) { cache.hit = true; return [hit.subarray(0, N), hit.subarray(N)]; }

  const notes = o.notes ?? new Map<string, Float32Array[]>();
  const placed: { at: number; buf: Float32Array[]; g: number }[] = [];
  let size = N;
  for (const e of ev) {
    const inst = instOf(e);
    const midi = e.midi ?? inst.root;
    const gate = Math.max(0.005, Math.round(e.len * SR) / SR);
    const nk = `${instrumentKey(inst, hash)}|${midi}|${gate}|${e.slideFrom ?? ''}|${e.fx.slide ? 's' : ''}${e.fx.vib ? `v${e.fx.vib.rate},${e.fx.vib.depth}` : ''}${e.fx.arp ? `a${e.fx.arp.join(',')}` : ''}`;
    let buf = notes.get(nk);
    if (!buf) {
      buf = renderNote(inst, { midi, gate, fx: e.fx, slideFrom: e.slideFrom }, o.bank);
      notes.set(nk, buf);
    }
    // a note nudged before the start: in a loop it sounds at the end of the region (it wraps), else at 0
    const raw = Math.round(e.t * SR);
    const at = raw >= 0 ? raw : wrap ? raw + N : 0;
    placed.push({ at, buf, g: velocityGain(inst, e.vel) });
    size = Math.max(size, Math.min(at + buf[0]!.length, at + MAX_TAIL * SR + Math.round(e.len * SR)));
  }
  const L = new Float64Array(size), R = new Float64Array(size);
  const [pl, pr] = panGains(ch.pan);
  for (const p of placed) {
    const a = p.buf[0]!, b = p.buf[1] ?? p.buf[0]!;
    const gl = p.g * ch.gain * pl, gr = p.g * ch.gain * pr;
    const n = Math.min(a.length, size - p.at);
    for (let i = 0; i < n; i++) { L[p.at + i] = L[p.at + i]! + a[i]! * gl; R[p.at + i] = R[p.at + i]! + b[i]! * gr; }
  }
  const out: [Float32Array, Float32Array] = [new Float32Array(N), new Float32Array(N)];
  const src = [L, R];
  for (let c = 0; c < 2; c++) {
    const x = src[c]!;
    if (wrap) {
      const folded = new Float64Array(N);
      for (let i = 0; i < size; i++) { const j = i % N; folded[j] = folded[j]! + x[i]!; }
      for (let i = 0; i < N; i++) out[c]![i] = folded[i]!;
    } else for (let i = 0; i < N; i++) out[c]![i] = x[i]!;
  }
  if (o.store) {
    const joined = new Float32Array(2 * N);
    joined.set(out[0]);
    joined.set(out[1], N);
    o.store.put(key, joined);
  }
  return out;
}

/** Render a song (or its loop region). Throws a plain Error when a channel names an instrument that does not exist, or the song cannot be arranged. */
export function renderSong(song: SongDoc, o: SongRenderOptions): SongRender {
  const mode = o.mode ?? 'full';
  const arr = arrange(song);
  let instances: Instance[];
  let window: { start: number; end: number };
  let N: number;
  if (mode === 'loop') {
    if (!arr.loop) throw new Error(`${song.id} has no loop region (${song.loop === false ? 'loop is off' : 'the song has no body sections'}); song loop ${song.id} <from>..<to> sets one`);
    instances = arr.instances.filter((i) => i.inLoop);
    window = { ...arr.loop };
    N = Math.max(1, Math.round((window.end - window.start) * SR));
  } else {
    const pl = playlist(arr, Math.max(1, Math.min(16, Math.floor(o.loops ?? 1))));
    instances = pl.instances;
    window = { start: 0, end: pl.total };
    N = Math.max(1, Math.round(pl.total * SR));
  }
  const only = o.only ? new Set(o.only) : null;
  const events = new Map<string, NoteEv[]>();
  const parts: ChannelAudio[] = [];
  let cached = 0;
  const keys: string[] = [];
  // a full render has room after the end for the last notes to die away: the longest tail among the channels
  const rendered: { ch: Channel; ev: NoteEv[] }[] = [];
  for (const ch of song.channels) {
    const ev = channelNotes(song, { instances }, ch.name).map((e) => ({ ...e, t: e.t - window.start, grid: e.grid - window.start }));
    events.set(ch.name, ev);
    if (!only || only.has(ch.name)) rendered.push({ ch, ev });
  }
  const wrap = mode === 'loop';
  // find the tail first: render the channels with room for it
  let extra = 0;
  if (!wrap) {
    for (const { ch, ev } of rendered) for (const e of ev) {
      const id = e.drum !== null ? drumInstrument(ch, e.drum) : ch.inst;
      const inst = id ? o.instruments(id) : undefined;
      if (!inst) continue;
      extra = Math.max(extra, Math.min(MAX_TAIL, e.t + noteLength(inst, e.len) - N / SR));
    }
    // the send buses ring on after the last note too
    for (const { ch } of rendered) for (const k of SEND_KINDS) if (ch[k] && song[k]) extra = Math.max(extra, Math.min(MAX_TAIL, fxTail(wet(song[k]!))));
    N += Math.max(0, Math.ceil(extra * SR));
  }
  for (const { ch, ev } of rendered) {
    const k = { key: '', hit: false };
    const audio = renderChannelAudio(song, ch, ev, N, wrap, o, k);
    keys.push(k.key);
    if (k.hit) cached++;
    parts.push({ name: ch.name, layer: ch.layer || DEFAULT_LAYER, key: k.key, channels: audio });
  }
  // the mix is worked out when first asked for: a measurement that is already known never needs it
  let mixed: { pre: [Float32Array, Float32Array]; mix: [Float32Array, Float32Array] } | null = null;
  const mixOnce = (): NonNullable<typeof mixed> => (mixed ??= mixParts(song, parts, N, wrap, o.limiter));
  // stems: the channels of each layer, in the order the layers first appear (worked out when first asked for)
  let stems: SongRender['stems'] | null = null;
  return {
    mode, length: N, window, parts, events, key: sha256Text(keys.join(',') + `|${song.gain}|${JSON.stringify([song.master, song.reverb, song.delay, song.channels.map((c) => [c.name, c.reverb, c.delay])])}`), cached,
    get mix() { return mixOnce().mix; },
    get pre() { return mixOnce().pre; },
    get stems() { return (stems ??= renderStems(song, parts, N, wrap)); },
  };
}

/** Seconds -> samples the way events are placed. */
export const sampleAt = (t: number): number => Math.round(t * SR);

/** The channels summed with the song's gain, before and after the master chain. In a loop the chain runs over the region twice and the second pass is kept. */
export function mixParts(song: SongDoc, parts: readonly ChannelAudio[], N: number, wrap: boolean, limiter?: { value: LimiterMemo | null }[]): { pre: [Float32Array, Float32Array]; mix: [Float32Array, Float32Array] } {
  const preD: [Float64Array, Float64Array] = [new Float64Array(N), new Float64Array(N)];
  for (const p of parts) for (let c = 0; c < 2; c++) { const a = p.channels[c]!, d = preD[c]!; for (let i = 0; i < N; i++) d[i] = d[i]! + a[i]!; }
  const ret = busReturns(song, parts, N, wrap);
  if (ret) for (let c = 0; c < 2; c++) { const d = preD[c]!, r = ret[c]!; for (let i = 0; i < N; i++) d[i] = d[i]! + r[i]!; }
  if (song.gain !== 1) for (const d of preD) for (let i = 0; i < N; i++) d[i] = d[i]! * song.gain;
  const pre: [Float32Array, Float32Array] = [Float32Array.from(preD[0]), Float32Array.from(preD[1])];
  let mixD: [Float64Array, Float64Array];
  if (!song.master.length) mixD = preD;
  else if (wrap) {
    const twice: [Float64Array, Float64Array] = [new Float64Array(2 * N), new Float64Array(2 * N)];
    for (let c = 0; c < 2; c++) { twice[c]!.set(preD[c]!); twice[c]!.set(preD[c]!, N); }
    applyFxChain(twice, song.master, limiter);
    mixD = [twice[0]!.subarray(N), twice[1]!.subarray(N)];
  } else {
    mixD = [Float64Array.from(preD[0]), Float64Array.from(preD[1])];
    applyFxChain(mixD, song.master, limiter);
  }
  return { pre, mix: [Float32Array.from(mixD[0]), Float32Array.from(mixD[1])] };
}

// ---- the send buses -----------------------------------------------------------------------------------------------

/** A send bus's effect heard wet only: the bus returns the effect, the channels' send amounts set how much goes in. */
export function wet(f: Fx): Fx {
  const envs = { ...f.envs };
  delete envs.mix;
  return { kind: f.kind, p: { ...f.p, mix: 1 }, envs };
}

/**
 * What the send buses return for these parts: each bus is fed by the parts' (post gain and pan) audio scaled by their
 * send amounts, and the effect runs over the sum, wet only. Both buses are linear, so the return of a group of parts is
 * their share of the whole return and the shares add up to it. In a loop the bus runs over the region twice and the
 * second pass is kept, so a tail wraps to the start as the notes' tails do.
 */
export function busReturns(song: SongDoc, parts: readonly ChannelAudio[], N: number, wrap: boolean): [Float64Array, Float64Array] | null {
  let out: [Float64Array, Float64Array] | null = null;
  for (const kind of SEND_KINDS) {
    const bus = song[kind];
    if (!bus) continue;
    const feed: [Float64Array, Float64Array] = [new Float64Array(wrap ? 2 * N : N), new Float64Array(wrap ? 2 * N : N)];
    let any = false;
    for (const p of parts) {
      const amount = song.channels.find((c) => c.name === p.name)?.[kind] ?? 0;
      if (!amount) continue;
      any = true;
      for (let c = 0; c < 2; c++) {
        const a = p.channels[c]!, d = feed[c]!;
        for (let i = 0; i < N; i++) { d[i] = d[i]! + a[i]! * amount; if (wrap) d[N + i] = d[N + i]! + a[i]! * amount; }
      }
    }
    if (!any) continue;
    applyFxChain(feed, [wet(bus)]);
    out ??= [new Float64Array(N), new Float64Array(N)];
    for (let c = 0; c < 2; c++) { const d = out[c]!, f = feed[c]!, off = wrap ? N : 0; for (let i = 0; i < N; i++) d[i] = d[i]! + f[off + i]!; }
  }
  return out;
}

/** The master chain's linear parts (its filters): the part of the chain that can be applied to one layer's stem and still add up. */
export const STEM_LINEAR_FX = ['filter'] as const;

/** What a stem export does with each effect of the master chain, in words. */
export function masterChainForStems(song: SongDoc): { applied: Fx[]; skipped: { fx: Fx; why: string }[] } {
  const applied: Fx[] = [];
  const skipped: { fx: Fx; why: string }[] = [];
  for (const f of song.master) {
    if ((STEM_LINEAR_FX as readonly string[]).includes(f.kind)) applied.push(f);
    else if (f.kind === 'compress' || f.kind === 'limit') skipped.push({ fx: f, why: `a ${f.kind === 'limit' ? 'limiter' : 'compressor'} follows the level of the whole mix, so it cannot be split among the stems; the stems sum to the mix before it` });
    else skipped.push({ fx: f, why: `${f.kind} is not applied per stem (it is not a filter or an EQ)` });
  }
  return { applied, skipped };
}

/**
 * The stems: each layer's channels (and its share of the send buses) scaled by the song's gain. Without
 * `throughMaster` they are before the master chain, so they sum to the mix before the chain. With it, the master chain's
 * filters are run over each stem, so a tone shaping in the chain reaches the stems; the compressor and limiter cannot be
 * split, so the stems then sum to the mix as the filters leave it, before the compressor and limiter (louder than the mix,
 * and not limited, by what those take off).
 */
export function renderStems(song: SongDoc, parts: readonly ChannelAudio[], N: number, wrap: boolean, throughMaster = false): { layer: string; channels: [Float32Array, Float32Array] }[] {
  const filters = throughMaster ? masterChainForStems(song).applied : [];
  return [...new Set(parts.map((p) => p.layer))].map((layer) => {
    const mine = parts.filter((p) => p.layer === layer);
    const sum: [Float64Array, Float64Array] = [new Float64Array(N), new Float64Array(N)];
    for (const p of mine) for (let c = 0; c < 2; c++) { const a = p.channels[c]!, d = sum[c]!; for (let i = 0; i < N; i++) d[i] = d[i]! + a[i]!; }
    const ret = busReturns(song, mine, N, wrap);
    if (ret) for (let c = 0; c < 2; c++) { const d = sum[c]!, r = ret[c]!; for (let i = 0; i < N; i++) d[i] = d[i]! + r[i]!; }
    for (const d of sum) for (let i = 0; i < N; i++) d[i] = d[i]! * song.gain;
    if (filters.length) {
      if (wrap) {
        const twice: [Float64Array, Float64Array] = [new Float64Array(2 * N), new Float64Array(2 * N)];
        for (let c = 0; c < 2; c++) { twice[c]!.set(sum[c]!); twice[c]!.set(sum[c]!, N); }
        applyFxChain(twice, filters);
        for (let c = 0; c < 2; c++) sum[c]!.set(twice[c]!.subarray(N));
      } else applyFxChain(sum, filters);
    }
    return { layer, channels: [Float32Array.from(sum[0]), Float32Array.from(sum[1])] as [Float32Array, Float32Array] };
  });
}
