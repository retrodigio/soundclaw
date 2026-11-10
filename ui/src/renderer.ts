// The page's side of the render worker: ask for a sound's channels, get them when the worker has
// rendered them. The page's own thread does no rendering for playback.

import { soundSamples, type Sound, type Style } from '@soundclaw/core';
import type { SampleInfo } from '@soundclaw/server/protocol';
import type { CellReply, DiffReply, LensReply, MeasureReply, RenderReply, RenderRequest, StripPeaks } from './render.worker.ts';

export interface Rendered { key: string; channels: Float32Array[]; hash: string; ms: number }

/** The samples a sound names (layers that play a file). */
export function samplesNamed(s: Sound, all: readonly SampleInfo[]): SampleInfo[] {
  if (s.voice !== 'layered') return [];
  const names = new Set<string>();
  for (const n of soundSamples(s)) names.add(n);
  return all.filter((x) => names.has(x.name));
}

/** Playing has a worker of its own: it never waits behind a long measurement. */
type Lane = 'play' | 'work';

export class Renderer {
  private workers: Record<Lane, Worker | null> = { play: null, work: null };
  private n = 0;
  private waiting = new Map<number, { resolve(r: Rendered | MeasureReply | StripPeaks[] | LensReply | DiffReply | CellReply): void; reject(e: Error): void }>();

  private start(lane: Lane): Worker {
    if (this.workers[lane]) return this.workers[lane]!;
    const w = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<RenderReply>) => {
      const m = ev.data;
      const f = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      if (!f) return;
      if (m.ok) f.resolve('measure' in m ? m.measure : 'lens' in m ? m.lens : 'diff' in m ? m.diff : 'cell' in m ? m.cell : 'strips' in m ? m.strips : { key: m.key, channels: m.channels, hash: m.hash, ms: m.ms });
      else f.reject(new Error(m.error));
    };
    w.onerror = (e) => {
      for (const f of this.waiting.values()) f.reject(new Error(e.message || 'the render worker failed'));
      this.waiting.clear();
      this.workers[lane] = null;
    };
    this.workers[lane] = w;
    return w;
  }

  private ask(lane: Lane, q: Omit<RenderRequest, 'id' | 'samples' | 'refSamples'>, samples: readonly SampleInfo[]): Promise<Rendered | MeasureReply | StripPeaks[] | LensReply | DiffReply | CellReply> {
    const id = ++this.n;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.start(lane).postMessage({ ...q, id, samples: samplesNamed(q.sound, samples).map((x) => ({ name: x.name, sha256: x.sha256, ...(x.slices ? { slices: x.slices } : {}), ...(x.loop ? { loop: x.loop } : {}) })), ...(q.ref ? { refSamples: samplesNamed(q.ref, samples).map((x) => ({ name: x.name, sha256: x.sha256, ...(x.slices ? { slices: x.slices } : {}), ...(x.loop ? { loop: x.loop } : {}) })) } : {}) } satisfies RenderRequest);
    });
  }

  render(sound: Sound, samples: readonly SampleInfo[], token: string): Promise<Rendered> {
    return this.ask('play', { sound, token, op: 'render' }, samples) as Promise<Rendered>;
  }

  /** Each layer of a layered sound on its own, as peaks (the editor's layer strips). */
  strips(sound: Sound, samples: readonly SampleInfo[], token: string, cols = 360): Promise<StripPeaks[]> {
    return this.ask('work', { sound, token, op: 'strips', cols }, samples) as Promise<StripPeaks[]>;
  }

  /** Everything the analysis lenses draw (peaks, loudness over time, spectrogram, pitch, the numbers and checks), from the measuring worker. */
  lens(sound: Sound, samples: readonly SampleInfo[], token: string, style: Style, basis: string): Promise<LensReply> {
    return this.ask('work', { sound, token, op: 'lens', style, basis }, samples) as Promise<LensReply>;
  }

  /** The difference spectrogram of `sound` against `ref`. */
  diff(sound: Sound, ref: Sound, samples: readonly SampleInfo[], token: string): Promise<DiffReply> {
    return this.ask('work', { sound, token, op: 'diff', ref }, samples) as Promise<DiffReply>;
  }

  /** A clip-grid cell of a version: small peaks, integrated loudness and true peak, from the measuring worker. */
  cell(sound: Sound, samples: readonly SampleInfo[], token: string): Promise<CellReply> {
    return this.ask('work', { sound, token, op: 'cell' }, samples) as Promise<CellReply>;
  }

  /** The numbers, checks and spectrogram of a sound, worked out in the worker (a long sound takes seconds). */
  measure(sound: Sound, samples: readonly SampleInfo[], token: string, style: Style, basis: string): Promise<MeasureReply> {
    return this.ask('work', { sound, token, op: 'measure', style, basis }, samples) as Promise<MeasureReply>;
  }
}
