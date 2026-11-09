// A worker thread that reads an uploaded audio file (decoding, hashing, the numbers the file carries), so the server's
// own thread never does it. Message in: the bytes and the file name; out: what `prepareImport` made of them.

import { parentPort } from 'node:worker_threads';
import { prepareImport, type ImportOptions, type Prepared } from './sampleimport.ts';

export interface DecodeJob {
  bytes: Uint8Array;
  filename: string;
  options: Omit<ImportOptions, 'by'>;
}

export type DecodeReply = { prepared: Prepared } | { error: string };

parentPort!.on('message', (job: DecodeJob) => {
  try {
    const prepared = prepareImport(job.bytes, job.filename, job.options);
    parentPort!.postMessage({ prepared } satisfies DecodeReply, [prepared.audio.data.buffer as ArrayBuffer]);
  } catch (e) {
    parentPort!.postMessage({ error: (e as Error).message } satisfies DecodeReply);
  }
});
