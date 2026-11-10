// The worker thread of the instrument check: the instrument's zones are measured against the project's stored audio, off the server's own thread.

import { parentPort } from 'node:worker_threads';
import { checkInstrument } from '@soundclaw/core';
import type { InstrumentCheckJob, InstrumentCheckReply } from './instrumentcheck.ts';
import { MapBank, ObjectStore } from './samples.ts';

parentPort!.on('message', (job: InstrumentCheckJob) => {
  try {
    const bank = new MapBank(new ObjectStore(job.dir), (name) => job.samples[name]);
    parentPort!.postMessage({ check: checkInstrument(job.instrument, bank) } satisfies InstrumentCheckReply);
  } catch (e) {
    parentPort!.postMessage({ error: (e as Error).message } satisfies InstrumentCheckReply);
  }
});
