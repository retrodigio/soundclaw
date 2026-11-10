// An instrument's check for the dashboard's key-map: the same `checkInstrument` the CLI runs, worked out in a worker thread (it measures every
// distinct sample of the zones) and kept for as long as the instrument and the audio under its sample names stay as they are.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { instrumentKey, type Instrument, type InstrumentCheck } from '@soundclaw/core';
import { ProjectError } from './project.ts';
import type { Writer } from './writer.ts';

/** What the worker needs: the instrument, and for every sample name the project has, its hash and slice and loop points. */
export interface InstrumentCheckJob {
  dir: string;
  instrument: Instrument;
  samples: Record<string, { hash: string; slices?: number[]; loop?: [number, number] }>;
}
export type InstrumentCheckReply = { check: InstrumentCheck } | { error: string };

function workerFile(): URL {
  const js = new URL('./instrumentcheck-worker.js', import.meta.url);
  return existsSync(fileURLToPath(js)) ? js : new URL('./instrumentcheck-worker.ts', import.meta.url);
}

function runInWorker(job: InstrumentCheckJob): Promise<InstrumentCheck> {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerFile());
    let done = false;
    const finish = (f: () => void): void => { if (done) return; done = true; void w.terminate(); f(); };
    w.on('message', (m: InstrumentCheckReply) => finish(() => ('error' in m ? reject(new ProjectError(m.error)) : resolve(m.check))));
    w.on('error', (e) => finish(() => reject(new ProjectError(`could not check the instrument: ${e.message}`))));
    w.on('exit', (code) => finish(() => reject(new ProjectError(`the instrument checker stopped (${code})`))));
    w.postMessage(job);
  });
}

const kept = new Map<string, Promise<InstrumentCheck>>();

/** The check of a project instrument: kept by the instrument's key (its zones, layers and the hashes of the audio they name), one worker per distinct key. */
export function instrumentCheckAsync(w: Writer, id: string): Promise<InstrumentCheck & { key: string }> {
  const inst = w.instruments().find((x) => x.id === id);
  if (!inst) return Promise.reject(new ProjectError(`no instrument '${id}' in the project`));
  const lib = w.sampleLibrary();
  const samples: InstrumentCheckJob['samples'] = {};
  for (const [name, e] of lib.samples) samples[name] = { hash: e.hash, ...(e.slices?.length ? { slices: e.slices } : {}), ...(e.loop ? { loop: e.loop } : {}) };
  const key = `${w.project.dir}|${instrumentKey(inst, (n) => samples[n]?.hash ?? 'missing')}`;
  let p = kept.get(key);
  if (!p) {
    p = runInWorker({ dir: w.project.dir, instrument: inst, samples });
    kept.set(key, p);
    p.catch(() => kept.delete(key));
    if (kept.size > 64) kept.delete(kept.keys().next().value!);
  }
  return p.then((c) => ({ ...c, key }));
}
