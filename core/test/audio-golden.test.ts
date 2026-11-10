// Goldens for audio in sounds and songs: convolution, grains, recipes that take a sample, audio clips and a convolution send. Renders are hashed like the
// layered goldens. Documents that use none of these keep every other golden (layered, classic, sample, music): this file only adds.
// Regenerate with UPDATE_GOLDEN=1, saying why in the commit.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RENDER_VERSION, joinChannels, renderChannels, samplesHash, type LayeredSound } from '../src/index.ts';
import { build } from './layered-helpers.ts';
import { AUDIO_BANK, RENDER_TABLE } from './audio-golden-table.ts';

const GOLDEN = join(import.meta.dirname, 'audio-golden.json');

interface Entry { hash: string; detail: string }
type Golden = { renders: Record<string, Entry & { renderVersion: number }> };

function renderEntry(script: string): Entry {
  const ch = renderChannels(build(script).get('s') as LayeredSound, AUDIO_BANK);
  return { hash: samplesHash(joinChannels(ch)), detail: `${ch.length} ch, ${ch[0]!.length} samples` };
}

if (process.env.UPDATE_GOLDEN) {
  const g: Golden = { renders: {} };
  for (const [k, v] of Object.entries(RENDER_TABLE)) g.renders[k] = { ...renderEntry(v), renderVersion: RENDER_VERSION };
  writeFileSync(GOLDEN, JSON.stringify(g, null, 1) + '\n');
}

const golden: Golden = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : { renders: {} };

describe('audio goldens', () => {
  it('every entry has a golden (run with UPDATE_GOLDEN=1 to write them)', () => {
    expect(Object.keys(golden.renders).sort()).toEqual(Object.keys(RENDER_TABLE).sort());
  });

  for (const [name, script] of Object.entries(RENDER_TABLE)) {
    it(`renders ${name} to its golden samples`, () => {
      const g = golden.renders[name]!;
      expect(renderEntry(script)).toEqual({ hash: g.hash, detail: g.detail });
      expect(g.renderVersion).toBe(RENDER_VERSION);
    });
  }
});
