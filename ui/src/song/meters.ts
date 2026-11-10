// The page's side of the song meters. The store tells the hub when a song starts and stops playing;
// the worker computes each channel's level at the playhead about thirty times a second and posts it
// here. Meters read the latest values in requestAnimationFrame (`reader`), so nothing in React
// changes at meter rate. The hub only does work while a mixer is mounted (`want`).

import type { SampleData, SongDoc, SongRender } from '@soundclaw/core';
import type { LoadMessage, MeterIn, MeterOut, PlayMessage } from './meters.worker.ts';

export type MeterMode = 'peak' | 'lufs';

interface Job {
  song: SongDoc;
  render: SongRender;
  mix: [Float32Array, Float32Array];
  mixKey: string;
  wrap: boolean;
  audible: string[];
  /** The room bus's response, for its meter. */
  ir?: { name: string; hash: string; sample: SampleData } | null;
  play: Omit<PlayMessage, 'op' | 'audible'> | null;
}

const DECAY_DB_PER_S = 30;
const FLOOR = -120;

export class MeterHub {
  /** What the meters show: the peak of each block, or the short-term loudness (3 s). */
  mode: MeterMode = 'peak';
  setMode(m: MeterMode): void { if (m !== this.mode) { this.mode = m; this.notify(); } }
  /** Level messages received from the worker (tests read it: about 30 a second while playing). */
  frames = 0;

  private worker: Worker | null = null;
  private wanted = 0;
  private job: Job | null = null;
  private held = new Set<string>();
  private heldRaw = false;
  private latest: Float32Array | null = null;
  private slot = new Map<string, number>();
  private shown = new Map<string, { l: number; r: number; at: number }>();
  private readers = new Map<string, () => number[]>();
  private subs = new Set<() => void>();
  private loadedKey = '';

  subscribe = (f: () => void): (() => void) => { this.subs.add(f); return () => { this.subs.delete(f); }; };
  private notify(): void { for (const f of [...this.subs]) f(); }

  /** A mixer shows (+1) or goes (−1): the worker is only sent audio while one is showing. */
  want(delta: 1 | -1): void {
    this.wanted = Math.max(0, this.wanted + delta);
    if (this.wanted > 0 && this.job) this.send();
    if (this.wanted === 0) this.worker?.postMessage({ op: 'stop' } satisfies MeterIn);
  }

  /** A song starts playing: `anchor` is `performance.now()` at the moment the buffer was at `pos` seconds. */
  begin(job: Omit<Job, 'play'>, play: Omit<PlayMessage, 'op' | 'audible'>): void {
    this.job = { ...job, play };
    this.latest = null;
    this.shown.clear();
    if (this.wanted > 0) this.send();
  }

  /** The song stopped: the meters fall to nothing. */
  end(): void {
    if (this.job) this.job.play = null;
    this.latest = null;
    this.worker?.postMessage({ op: 'stop' } satisfies MeterIn);
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./meters.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<MeterOut>) => {
      const m = ev.data;
      if (m.op === 'levels') { this.latest = m.values; this.frames++; return; }
      this.loadedKey = m.key;
    };
    w.onerror = () => { this.worker = null; this.held.clear(); this.loadedKey = ''; };
    this.worker = w;
    return w;
  }

  /** The most audio the worker is sent (bytes): a very long song with many channels keeps its meters off rather than copy it all. */
  static readonly LIMIT = 300e6;
  /** The song being played is too big to meter live. */
  tooBig = false;

  private send(): void {
    const j = this.job;
    if (!j) return;
    const bytes = j.render.parts.length * (j.render.parts[0]?.channels[0].byteLength ?? 0) * 2;
    if (bytes > MeterHub.LIMIT) { if (!this.tooBig) { this.tooBig = true; this.notify(); } return; }
    if (this.tooBig) { this.tooBig = false; this.notify(); }
    const w = this.start();
    const key = `${j.render.key}|${j.mixKey}`;
    // the worker keeps a channel's audio only when the song has a bus; a song that gained one needs it all again
    const needRaw = !!(j.song.reverb || j.song.delay || j.song.convolve);
    if (needRaw && !this.heldRaw) this.held.clear();
    this.heldRaw = needRaw;
    const parts = j.render.parts.map((p) => ({ name: p.name, layer: p.layer, key: p.key, ...(this.held.has(p.key) ? {} : { audio: p.channels }) }));
    this.held = new Set(j.render.parts.map((p) => p.key));
    this.slot.clear();
    j.render.parts.forEach((p, i) => this.slot.set(`ch:${p.name}`, i));
    const n = j.render.parts.length;
    this.slot.set('master', n);
    this.slot.set('bus:reverb', n + 1);
    this.slot.set('bus:delay', n + 2);
    this.slot.set('bus:convolve', n + 3);
    const load: LoadMessage = { op: 'load', key, mixKey: j.mixKey, song: j.song, wrap: j.wrap, parts, mix: j.mix, ir: j.ir ?? null };
    // the mix is sent once per distinct key
    if (this.loadedKey === key) load.mix = null;
    w.postMessage(load satisfies MeterIn);
    if (j.play) w.postMessage({ op: 'play', ...j.play, audible: j.audible } satisfies MeterIn);
  }

  /** The latest short-term loudness of a slot, or null when nothing is playing. */
  shortTerm(slot: string): number | null {
    const i = this.slot.get(slot);
    if (!this.latest || i === undefined) return null;
    const v = this.latest[i * 3 + 2]!;
    return v > -70 ? v : null;
  }

  /** A function a meter polls every animation frame: the left and right levels in dB (peak, or short-term loudness), falling at a steady rate. Never null: a stopped song reads as silence. */
  reader(slot: string): () => number[] {
    let f = this.readers.get(slot);
    if (!f) {
      f = () => {
        const i = this.slot.get(slot);
        const now = performance.now();
        const prev = this.shown.get(slot) ?? { l: FLOOR, r: FLOOR, at: now };
        const dt = Math.min(0.2, (now - prev.at) / 1000);
        let l = FLOOR, r = FLOOR;
        if (this.latest && i !== undefined) {
          if (this.mode === 'lufs') { l = r = this.latest[i * 3 + 2]! > -70 ? this.latest[i * 3 + 2]! : FLOOR; }
          else { l = this.latest[i * 3]!; r = this.latest[i * 3 + 1]!; }
        }
        const fall = DECAY_DB_PER_S * dt;
        const next = { l: Math.max(l, prev.l - fall), r: Math.max(r, prev.r - fall), at: now };
        this.shown.set(slot, next);
        return [next.l, next.r];
      };
      this.readers.set(slot, f);
    }
    return f;
  }
}
