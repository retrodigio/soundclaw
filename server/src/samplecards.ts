// A sample's card for the dashboard: its numbers (the same measure `describe` prints) and a small waveform, worked out once for each
// distinct audio in a worker thread (the server's own thread never measures for a row) and kept in <project>/.cache/samplecards.
// Audio never changes under its hash, so a card is good for ever.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { threadId, Worker } from 'node:worker_threads';
import { encodeMeasure, measureSample, mixdown, pcmChannels, peaks, type PcmAudio } from '@soundclaw/core';
import { ProjectError } from './project.ts';
import type { ObjectStore } from './samples.ts';

/** Columns of the row's small waveform. */
export const CARD_COLUMNS = 96;

export interface SampleCard {
  hash: string;
  /** The measure of the first 120 s at the sample's own rate (non-finite numbers as words: see decodeMeasure). */
  measure: unknown;
  /** Peaks of the mono mix, CARD_COLUMNS of them. */
  peaks: { min: number[]; max: number[] };
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** The card of some audio. */
export function buildSampleCard(hash: string, a: PcmAudio): SampleCard {
  const chs = pcmChannels(a, 120);
  const p = peaks(chs.length === 1 ? chs[0]! : mixdown(chs), CARD_COLUMNS);
  return { hash, measure: encodeMeasure(measureSample(chs, a.rate)), peaks: { min: Array.from(p.min, round3), max: Array.from(p.max, round3) } };
}

/** Cards kept on disk, written whole and renamed into place so another thread never reads half a file. */
export class SampleCardFiles {
  private readonly dir: string;
  constructor(projectDir: string) {
    this.dir = join(projectDir, '.cache', 'samplecards');
  }
  private path(hash: string): string {
    return join(this.dir, `${hash}.json`);
  }
  read(hash: string): SampleCard | null {
    try { return existsSync(this.path(hash)) ? (JSON.parse(readFileSync(this.path(hash), 'utf8')) as SampleCard) : null; } catch { return null; }
  }
  write(c: SampleCard): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.path(c.hash)}.${process.pid}.${threadId}.tmp`;
    writeFileSync(tmp, JSON.stringify(c));
    renameSync(tmp, this.path(c.hash));
  }
}

export interface CardJob { n: number; hash: string }
export type CardReply = { n: number; card: SampleCard } | { n: number; error: string };

/** The worker script: next to the bundle (samplecards-worker.js) or, from the sources, the TypeScript file. */
function workerFile(): URL {
  const js = new URL('./samplecards-worker.js', import.meta.url);
  return existsSync(fileURLToPath(js)) ? js : new URL('./samplecards-worker.ts', import.meta.url);
}

interface Waiting { hash: string; waiters: { resolve(c: SampleCard): void; reject(e: Error): void }[] }

/** Cards on request: kept (memory, then disk) or worked out by one worker thread, in the order they were asked for. */
export class SampleCards {
  private readonly dir: string;
  private readonly files: SampleCardFiles;
  private readonly objects: ObjectStore;
  private readonly cards = new Map<string, SampleCard>();
  private readonly pending = new Map<string, Waiting>();
  private readonly queue: Waiting[] = [];
  private worker: Worker | null = null;
  private busy: { job: Waiting; n: number } | null = null;
  private n = 0;
  private closed = false;
  /** Cards worked out by the worker, as tests read them. */
  built = 0;

  /** Audio that is not an object of the store (a 0.1.x file not moved in yet): measured on this thread, which is rare and short. */
  private readonly fallback: (hash: string) => PcmAudio | undefined;

  constructor(projectDir: string, objects: ObjectStore, fallback: (hash: string) => PcmAudio | undefined = () => undefined) {
    this.fallback = fallback;
    this.dir = projectDir;
    this.files = new SampleCardFiles(projectDir);
    this.objects = objects;
  }

  /** The card if it is already known (memory or disk). */
  known(hash: string): SampleCard | null {
    const c = this.cards.get(hash) ?? this.files.read(hash);
    if (c) {
      this.cards.set(hash, c);
      if (this.cards.size > 512) this.cards.delete(this.cards.keys().next().value!);
    }
    return c;
  }

  card(hash: string): Promise<SampleCard> {
    if (this.closed) return Promise.reject(new ProjectError('the server is closing'));
    if (!/^[0-9a-f]{64}$/.test(hash)) return Promise.reject(new ProjectError(`'${hash}' is not a sample hash`));
    const have = this.known(hash);
    if (have) return Promise.resolve(have);
    if (!this.objects.has(hash)) {
      const a = this.fallback(hash);
      if (!a) return Promise.reject(new ProjectError(`no sample object ${hash.slice(0, 12)}`));
      const c = buildSampleCard(hash, a);
      this.cards.set(hash, c);
      return Promise.resolve(c);
    }
    let job = this.pending.get(hash);
    if (!job) {
      job = { hash, waiters: [] };
      this.pending.set(hash, job);
      this.queue.push(job);
    }
    const p = new Promise<SampleCard>((resolve, reject) => job!.waiters.push({ resolve, reject }));
    this.pump();
    return p;
  }

  private spawn(): Worker {
    const w = new Worker(workerFile(), { workerData: { dir: this.dir } });
    w.on('message', (m: CardReply) => {
      const b = this.busy;
      this.busy = null;
      if (b && b.n === m.n) this.finish(b.job, 'card' in m ? m.card : null, 'error' in m ? m.error : undefined);
      this.pump();
    });
    w.on('error', (e) => {
      const b = this.busy;
      this.busy = null;
      this.worker = null;
      if (b) this.finish(b.job, null, e.message);
      this.pump();
    });
    this.worker = w;
    return w;
  }

  private finish(job: Waiting, card: SampleCard | null, error?: string): void {
    this.pending.delete(job.hash);
    if (!card) {
      for (const x of job.waiters) x.reject(new ProjectError(error ?? 'could not work out the sample card'));
      return;
    }
    this.built++;
    this.cards.set(card.hash, card);
    for (const x of job.waiters) x.resolve(card);
  }

  private pump(): void {
    if (this.closed || this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    const w = this.worker ?? this.spawn();
    this.busy = { job, n: ++this.n };
    w.postMessage({ n: this.n, hash: job.hash } satisfies CardJob);
  }

  async close(): Promise<void> {
    this.closed = true;
    const err = new ProjectError('the server is closing');
    for (const job of this.pending.values()) for (const x of job.waiters) x.reject(err);
    this.pending.clear();
    this.queue.length = 0;
    await this.worker?.terminate();
    this.worker = null;
  }
}
