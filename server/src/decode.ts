// Uploaded files are decoded in a worker thread (decode-worker.ts), one job per worker, so a large file never blocks the server.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { ProjectError } from './project.ts';
import type { DecodeJob, DecodeReply } from './decode-worker.ts';
import type { PcmAudio } from '@soundclaw/core';
import type { Prepared } from './sampleimport.ts';

/** The worker script: next to the bundle (decode-worker.js) or, from the sources, the TypeScript file. */
function workerFile(): URL {
  const js = new URL('./decode-worker.js', import.meta.url);
  return existsSync(fileURLToPath(js)) ? js : new URL('./decode-worker.ts', import.meta.url);
}

/** Read an uploaded file in a worker. Rejects with a ProjectError saying what is wrong with the file. */
export function decodeInWorker(job: DecodeJob & { audioOnly?: undefined }): Promise<Prepared>;
export function decodeInWorker(job: DecodeJob & { audioOnly: true }): Promise<{ audio: PcmAudio }>;
export function decodeInWorker(job: DecodeJob): Promise<Prepared | { audio: PcmAudio }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerFile());
    let done = false;
    const finish = (f: () => void): void => {
      if (done) return;
      done = true;
      void w.terminate();
      f();
    };
    w.on('message', (m: DecodeReply) => finish(() => ('error' in m ? reject(new ProjectError(m.error)) : resolve('audio' in m ? { audio: m.audio } : m.prepared))));
    w.on('error', (e) => finish(() => reject(new ProjectError(`could not read the file: ${e.message}`))));
    w.on('exit', (code) => finish(() => reject(new ProjectError(`the file reader stopped (${code})`))));
    w.postMessage(job);
  });
}
