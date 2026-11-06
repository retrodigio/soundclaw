// Export: sounds as WAV files (16-bit PCM, 44,100 Hz mono), rendered through the cache.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { encodeWav, levels, samplesHash } from '@soundclaw/core';
import { ProjectError } from './project.ts';
import type { Writer } from './writer.ts';

export interface ExportedSound {
  id: string;
  file: string;
  bytes: number;
  seconds: number;
  /** Hash of the float samples (what tests and caches compare). */
  samples: string;
  peak: number;
  cached: boolean;
}

/** Write WAVs for the named sounds (all when none are named) into `out` (default <project>/exports). */
export function exportSounds(w: Writer, ids: string[], out?: string): ExportedSound[] {
  const names = ids.length ? ids : w.sounds().map((s) => s.id);
  if (!names.length) throw new ProjectError('there are no sounds to export');
  const dir = resolve(out ?? join(w.project.dir, 'exports'));
  mkdirSync(dir, { recursive: true });
  return names.map((id) => {
    const r = w.render(id);
    const wav = encodeWav(r.samples);
    const file = join(dir, `${id}.wav`);
    writeFileSync(file, wav);
    return { id, file, bytes: wav.length, seconds: r.samples.length / 44100, samples: samplesHash(r.samples), peak: levels(r.samples).peak, cached: r.cached };
  });
}
