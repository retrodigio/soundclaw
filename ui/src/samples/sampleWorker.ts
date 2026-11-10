// The page's side of the sample worker: ask, and get the answer when the worker has it. Answers are kept by what was asked (a sample's audio never
// changes under its hash), so going back to a sample costs nothing.

import type { DiffReply } from '../render.worker.ts';
import type { SampleLensReply, SampleReq, SampleRes, SeamReply } from './sample.worker.ts';

type Ask = SampleReq extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;
type Pending = { resolve(r: SampleLensReply | DiffReply | SeamReply): void; reject(e: Error): void };

class SampleWorkerClient {
  private worker: Worker | null = null;
  private n = 0;
  private readonly waiting = new Map<number, Pending>();
  private readonly lenses = new Map<string, Promise<SampleLensReply>>();

  private start(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./sample.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<SampleRes>) => {
      const m = ev.data;
      const f = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      if (!f) return;
      if (m.ok) f.resolve('lens' in m ? m.lens : 'diff' in m ? m.diff : m.seam);
      else f.reject(new Error(m.error));
    };
    w.onerror = (e) => {
      for (const f of this.waiting.values()) f.reject(new Error(e.message || 'the sample worker failed'));
      this.waiting.clear();
      this.worker = null;
    };
    this.worker = w;
    return w;
  }

  private ask<T extends SampleLensReply | DiffReply | SeamReply>(q: Ask, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.n;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as Pending['resolve'], reject });
      this.start().postMessage({ ...q, id }, transfer);
    });
  }

  /** The lens data of a sample (kept by its hash). */
  lens(token: string, hash: string): Promise<SampleLensReply> {
    let p = this.lenses.get(hash);
    if (!p) {
      p = this.ask<SampleLensReply>({ op: 'lens', token, hash });
      p.catch(() => this.lenses.delete(hash));
      this.lenses.set(hash, p);
      if (this.lenses.size > 8) this.lenses.delete(this.lenses.keys().next().value!);
    }
    return p;
  }

  /** The audio just before a loop's end joined to the audio at its start, and the join's numbers. */
  seam(token: string, hash: string, start: number, end: number): Promise<SeamReply> {
    return this.ask<SeamReply>({ op: 'seam', token, hash, start, end });
  }

  /** The difference of the sample and another sample (by hash) or a rendered signal at 44.1 kHz. */
  diff(token: string, hash: string, against: { hash: string } | { mono: Float32Array }): Promise<DiffReply> {
    if ('hash' in against) return this.ask<DiffReply>({ op: 'diff', token, hash, refHash: against.hash });
    return this.ask<DiffReply>({ op: 'diff', token, hash, refMono: against.mono }, [against.mono.buffer]);
  }
}

export const sampleWorker = new SampleWorkerClient();
