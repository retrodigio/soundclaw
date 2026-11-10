// A worker thread of the library index: reads and measures the files it is sent. Message in: the library's folder and a batch of
// files; out: their index entries.

import { parentPort } from 'node:worker_threads';
import type { IndexedFile } from '@soundclaw/core';
import { indexOneFile, type IndexJob } from './libraryindex.ts';

export interface IndexBatch {
  id: number;
  root: string;
  files: IndexJob[];
}

export interface IndexBatchReply {
  id: number;
  entries: IndexedFile[];
}

parentPort!.on('message', (b: IndexBatch) => {
  parentPort!.postMessage({ id: b.id, entries: b.files.map((f) => indexOneFile(b.root, f)) } satisfies IndexBatchReply);
});
