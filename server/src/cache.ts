// The render cache: rendered samples addressed by the content hash of the sound document that
// made them (core's renderKey, which includes the renderer's version). A hit returns exactly the
// samples a fresh render would. Kept in memory and in <project>/.cache/renders (ignored by git).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { floatBytes, floatsFromBytes, renderKey, renderSound, type Sound } from '@soundclaw/core';

const MEMORY_ENTRIES = 64;

export interface Rendered {
  key: string;
  samples: Float32Array;
  /** Served from the cache (memory or disk) rather than rendered now. */
  cached: boolean;
}

export class RenderCache {
  private readonly dir: string | null;
  private readonly memory = new Map<string, Float32Array>();
  hits = 0;
  misses = 0;

  constructor(projectDir: string | null) {
    this.dir = projectDir ? join(projectDir, '.cache', 'renders') : null;
  }

  private file(key: string): string | null {
    return this.dir ? join(this.dir, `${key}.f32`) : null;
  }

  get(key: string): Float32Array | null {
    const m = this.memory.get(key);
    if (m) {
      this.memory.delete(key);
      this.memory.set(key, m);
      return m;
    }
    const f = this.file(key);
    if (f && existsSync(f)) {
      try {
        const bytes = readFileSync(f);
        if (bytes.length % 4 === 0) {
          const samples = floatsFromBytes(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length));
          this.remember(key, samples);
          return samples;
        }
      } catch {
        // an unreadable cache file is a miss
      }
    }
    return null;
  }

  put(key: string, samples: Float32Array): void {
    this.remember(key, samples);
    const f = this.file(key);
    if (!f) return;
    mkdirSync(this.dir!, { recursive: true });
    writeFileSync(f, floatBytes(samples));
  }

  private remember(key: string, samples: Float32Array): void {
    this.memory.set(key, samples);
    if (this.memory.size > MEMORY_ENTRIES) this.memory.delete(this.memory.keys().next().value!);
  }

  /** The sound's samples: from the cache when its document has been rendered before, else rendered and kept. */
  render(s: Sound): Rendered {
    const key = renderKey(s);
    const hit = this.get(key);
    if (hit) {
      this.hits++;
      return { key, samples: hit, cached: true };
    }
    this.misses++;
    const samples = renderSound(s);
    this.put(key, samples);
    return { key, samples, cached: false };
  }
}
