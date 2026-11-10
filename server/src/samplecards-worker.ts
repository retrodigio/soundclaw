// The worker thread of the sample card service: reads an object of the store by its hash, measures it and keeps the card on disk.

import { parentPort, workerData } from 'node:worker_threads';
import { SampleCardFiles, buildSampleCard, type CardJob, type CardReply } from './samplecards.ts';
import { ObjectStore } from './samples.ts';

const dir = (workerData as { dir: string }).dir;
const objects = new ObjectStore(dir);
const files = new SampleCardFiles(dir);

parentPort!.on('message', (job: CardJob) => {
  try {
    const hit = files.read(job.hash);
    if (hit) { parentPort!.postMessage({ n: job.n, card: hit } satisfies CardReply); return; }
    const audio = objects.audio(job.hash);
    if (!audio) throw new Error(`no sample object ${job.hash.slice(0, 12)}`);
    const card = buildSampleCard(job.hash, audio);
    files.write(card);
    parentPort!.postMessage({ n: job.n, card } satisfies CardReply);
  } catch (e) {
    parentPort!.postMessage({ n: job.n, error: (e as Error).message } satisfies CardReply);
  }
});
