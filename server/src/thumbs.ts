// The card service: a sound's numbers, checks and thumbnails, worked out in worker threads (the
// server's own thread never renders for a card), once for each distinct render and rule, and kept
// in memory and in <project>/.cache/thumbs. A page asks for the cards in view (they go first); a
// quiet pass works through the rest so the list's badges and filters fill in.

import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { soundSamples, type Sound } from '@soundclaw/core';
import { CardFiles, buildCard, liteOf } from './card.ts';
import type { CardJob } from './thumbs-worker.ts';
import type { CardInfo, CardLite } from './protocol.ts';
import type { Writer } from './writer.ts';
import { ProjectError } from './project.ts';
import { RenderCache } from './cache.ts';

interface Job {
  key: string;
  ids: Set<string>;
  job: Omit<CardJob, 'n'>;
  high: boolean;
  waiters: { resolve(c: CardInfo): void; reject(e: Error): void }[];
}

/** The worker script: next to the bundle (thumbs-worker.js) or, from the sources, thumbs-worker.ts. */
function workerFile(): URL {
  const js = new URL('./thumbs-worker.js', import.meta.url);
  return existsSync(fileURLToPath(js)) ? js : new URL('./thumbs-worker.ts', import.meta.url);
}

export class Thumbs {
  private readonly files: CardFiles;
  private readonly lites = new Map<string, CardLite>();
  private readonly cards = new Map<string, CardInfo>();
  private readonly pending = new Map<string, Job>();
  private readonly high: Job[] = [];
  private readonly low: Job[] = [];
  private readonly workers: { w: Worker; busy: Job | null }[] = [];
  private readonly size: number;
  private n = 0;
  private closed = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private fresh: { id: string; key: string; info: CardLite }[] = [];
  /** Cards worked out by a worker or by this thread, as tests read them. */
  built = 0;

  private readonly w: Writer;

  constructor(w: Writer, o: { workers?: number } = {}) {
    this.w = w;
    this.files = new CardFiles(w.project.dir);
    this.size = Math.max(1, o.workers ?? Math.max(2, Math.min(4, cpus().length - 1)));
  }

  /** The numbers of a sound's card if the server already has them (memory or disk), without computing anything. */
  lite(key: string): CardLite | undefined {
    let l = this.lites.get(key);
    if (!l) {
      l = this.files.readLite(key) ?? undefined;
      if (l) this.lites.set(key, l);
    }
    return l;
  }

  private known(key: string): CardInfo | null {
    const c = this.cards.get(key) ?? this.files.read(key);
    if (c) {
      this.cards.set(key, c);
      if (this.cards.size > 128) this.cards.delete(this.cards.keys().next().value!);
    }
    return c;
  }

  /** A sound's card: kept, or worked out by a worker (before any quiet work). */
  card(id: string, urgent = true): Promise<CardInfo> {
    const s = this.w.sound(id);
    return this.cardOf(s, urgent);
  }

  private cardOf(s: Sound, urgent: boolean): Promise<CardInfo> {
    if (this.closed) return Promise.reject(new ProjectError('the server is closing'));
    const spec = this.w.cardSpec(s);
    const have = this.known(spec.key);
    if (have) return Promise.resolve(have);
    let job = this.pending.get(spec.key);
    if (!job) {
      job = { key: spec.key, ids: new Set(), job: { sound: s, key: spec.key, style: spec.style, basis: spec.basis, samples: this.w.samples.refs(soundSamples(s)) }, high: urgent, waiters: [] };
      this.pending.set(spec.key, job);
      (urgent ? this.high : this.low).push(job);
    } else if (urgent && !job.high) {
      job.high = true;
      const i = this.low.indexOf(job);
      if (i >= 0) this.low.splice(i, 1);
      if (!this.workers.some((x) => x.busy === job)) this.high.push(job);
    }
    job.ids.add(s.id);
    const p = new Promise<CardInfo>((resolve, reject) => job!.waiters.push({ resolve, reject }));
    this.pump();
    return p;
  }

  /** Queue the sounds whose card is not known yet, to be worked out when no page is waiting. */
  warm(): void {
    if (this.closed) return;
    for (const { s, spec } of this.w.cardSpecs()) {
      if (this.lite(spec.key) || this.pending.has(spec.key)) continue;
      void this.cardOf(s, false).catch(() => undefined);
    }
  }

  /** Cards still waiting (all of them, urgent or quiet). */
  get queued(): number {
    return this.pending.size;
  }

  private spawn(): { w: Worker; busy: Job | null } {
    const w = new Worker(workerFile(), { workerData: { dir: this.w.project.dir } });
    const slot = { w, busy: null as Job | null };
    w.on('message', (m: { n: number; card?: CardInfo; error?: string }) => {
      const job = slot.busy;
      slot.busy = null;
      if (job) this.finish(job, m.card ?? null, m.error);
      this.pump();
    });
    w.on('error', (e) => {
      const job = slot.busy;
      slot.busy = null;
      this.workers.splice(this.workers.indexOf(slot), 1);
      if (job) this.finish(job, null, e.message);
      this.pump();
    });
    this.workers.push(slot);
    return slot;
  }

  private finish(job: Job, card: CardInfo | null, error?: string): void {
    this.pending.delete(job.key);
    if (!card) {
      for (const x of job.waiters) x.reject(new ProjectError(error ?? 'could not work out the card'));
      return;
    }
    this.built++;
    this.cards.set(card.key, card);
    this.lites.set(card.key, liteOf(card));
    for (const x of job.waiters) x.resolve(card);
    for (const id of job.ids) this.fresh.push({ id, key: card.key, info: liteOf(card) });
    this.flushTimer ??= setTimeout(() => { this.flushTimer = null; this.flush(); }, 150);
  }

  private flush(): void {
    const cards = this.fresh;
    this.fresh = [];
    if (cards.length && !this.closed) this.w.cardsReady(cards);
  }

  private pump(): void {
    if (this.closed) return;
    for (;;) {
      const quiet = !this.high.length;
      const job = this.high.shift() ?? this.low[0];
      if (!job) return;
      // a quiet job runs only if a worker besides it stays free for a page's request
      const idle = this.workers.filter((x) => !x.busy).length + (this.workers.length < this.size ? this.size - this.workers.length : 0);
      if (quiet && idle < 2 && this.size > 1) return;
      if (quiet) this.low.shift();
      let slot = this.workers.find((x) => !x.busy);
      if (!slot && this.workers.length < this.size) slot = this.spawn();
      if (!slot) { if (!quiet) this.high.unshift(job); return; }
      // a quiet job whose sound has changed since is dropped
      if (quiet && !this.stillCurrent(job)) { this.pending.delete(job.key); for (const x of job.waiters) x.reject(new ProjectError('the sound changed')); continue; }
      slot.busy = job;
      slot.w.postMessage({ ...job.job, n: ++this.n } satisfies CardJob);
    }
  }

  private stillCurrent(job: Job): boolean {
    return [...job.ids].some((id) => this.w.has(id) && this.w.cardSpec(this.w.sound(id)).key === job.key);
  }

  /** A card worked out here, on this thread (for the callers that cannot wait: tests and one-off commands). */
  cardNow(id: string): CardInfo {
    const s = this.w.sound(id);
    const spec = this.w.cardSpec(s);
    const have = this.known(spec.key);
    if (have) return have;
    const r = new RenderCache(this.w.project.dir).render(s, this.w.samples);
    const card = buildCard(s, r.channels, spec);
    this.files.write(card);
    this.cards.set(card.key, card);
    this.lites.set(card.key, liteOf(card));
    this.built++;
    return card;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    const err = new ProjectError('the server is closing');
    for (const job of this.pending.values()) for (const x of job.waiters) x.reject(err);
    this.pending.clear();
    this.high.length = 0;
    this.low.length = 0;
    await Promise.all(this.workers.map((x) => x.w.terminate()));
    this.workers.length = 0;
  }
}
