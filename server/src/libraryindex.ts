// Reading one library file for the index: decode it, hash it, measure it. Shared by the index's worker threads
// (library-worker.ts) and the in-process path. Nothing here writes anywhere.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bandEnergies, encodeMeasure, measureSample, mixdown, pcmChannels, pcmHash, resample, tagsFromPath, FORMAT_BITS,
  type IndexedFile,
} from '@soundclaw/core';
import { decodeFileBytes } from './sampleimport.ts';

/** How much of a file the index measures (seconds): a long loop is described by its first 20 s; its length is always the real one. */
export const INDEX_SECONDS = 20;
/** Files above this are listed but not read (the index would hold their audio in memory, once per worker). */
export const INDEX_MAX_BYTES = 64 * 1048576;

export interface IndexJob {
  path: string;
  size: number;
  mtime: number;
}

/** The index entry for one file; a file that cannot be read gets an entry with `error` set, never an exception. */
export function indexOneFile(root: string, job: IndexJob): IndexedFile {
  const base: IndexedFile = { path: job.path, size: job.size, mtime: job.mtime, tags: tagsFromPath(job.path) };
  if (job.size > INDEX_MAX_BYTES) return { ...base, error: `larger than ${INDEX_MAX_BYTES / 1048576} MB: not indexed` };
  try {
    const abs = join(root, ...job.path.split('/'));
    const d = decodeFileBytes(new Uint8Array(readFileSync(abs)), abs);
    const audio = d.audio;
    const chs = pcmChannels(audio, INDEX_SECONDS);
    const m = measureSample(chs, audio.rate, { maxSeconds: INDEX_SECONDS });
    // the length is the file's, whatever part was measured
    m.duration = audio.frames / audio.rate;
    m.frames = audio.frames;
    const mono = chs.length === 1 ? chs[0]! : mixdown(chs);
    const mono44 = audio.rate === 44100 ? mono : resample(mono, audio.rate, 44100);
    const meta: NonNullable<IndexedFile['meta']> = {};
    if (d.meta.root !== undefined) { meta.root = d.meta.root; if (d.meta.tune) meta.tune = d.meta.tune; }
    if (d.meta.loop && d.meta.loop.start < d.meta.loop.end && d.meta.loop.end <= audio.frames) meta.loop = [d.meta.loop.start, d.meta.loop.end];
    if (d.meta.oneShot) meta.oneShot = true;
    if (d.meta.tempo) meta.tempo = d.meta.tempo;
    const info = Object.fromEntries(Object.entries(d.meta.info ?? {}).filter(([, t]) => t).map(([k, t]) => [k, t.slice(0, 200)]));
    if (Object.keys(info).length) meta.info = info;
    return {
      ...base, hash: pcmHash(audio), format: `${d.container} ${d.sourceFormat}`, bits: FORMAT_BITS[audio.format], rate: audio.rate, channels: audio.channels, frames: audio.frames,
      measure: encodeMeasure(m), bands: bandEnergies(mono44), ...(Object.keys(meta).length ? { meta } : {}),
    };
  } catch (e) {
    return { ...base, error: (e as Error).message.replace(/0x[0-9a-f]{6,}/g, '0x…').slice(0, 300) };
  }
}
