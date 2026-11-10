// A worker thread of the card service: renders a sound (through the shared render cache) and works
// out its card, so the server's own thread never does it. Messages in: a job; out: its card.

import { parentPort, workerData } from 'node:worker_threads';
import type { Sound, Style } from '@soundclaw/core';
import { CardFiles, buildCard } from './card.ts';
import { RenderCache } from './cache.ts';
import { MapBank, ObjectStore, type Resolved } from './samples.ts';

/** `samples`: the audio the sound's sample layers name, by name and hash (a 0.1.x file by its path). */
export interface CardJob { n: number; sound: Sound; key: string; style: Style; basis: string; samples: ({ name: string } & Resolved)[] }

const dir = (workerData as { dir: string }).dir;
const objects = new ObjectStore(dir);
const renders = new RenderCache(dir);
const files = new CardFiles(dir);

parentPort!.on('message', (job: CardJob) => {
  try {
    const hit = files.read(job.key);
    const card = hit ?? buildCard(job.sound, renders.render(job.sound, new MapBank(objects, (n) => job.samples.find((x) => x.name === n))).channels, { key: job.key, style: job.style, basis: job.basis });
    if (!hit) files.write(card);
    parentPort!.postMessage({ n: job.n, card });
  } catch (e) {
    parentPort!.postMessage({ n: job.n, error: (e as Error).message });
  }
});
