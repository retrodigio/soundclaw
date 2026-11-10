// Goldens for audio in sounds and songs: convolution, grains, recipes that take a sample, audio clips and a convolution send. Renders are hashed like the
// layered goldens. Documents that use none of these keep every other golden (layered, classic, sample, music): this file only adds.
// Regenerate with UPDATE_GOLDEN=1, saying why in the commit.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RENDER_VERSION, joinChannels, lookupInstrument, renderChannels, renderSong, samplesHash, type LayeredSound } from '../src/index.ts';
import { build } from './layered-helpers.ts';
import { AUDIO_BANK, RENDER_TABLE, SONG_TABLE } from './audio-golden-table.ts';
import { library } from './music-helpers.ts';

const GOLDEN = join(import.meta.dirname, 'audio-golden.json');

interface Entry { hash: string; detail: string }
type Golden = { renders: Record<string, Entry & { renderVersion: number }>; songs?: Record<string, Entry & { renderVersion: number }> };

function renderEntry(script: string): Entry {
  const ch = renderChannels(build(script).get('s') as LayeredSound, AUDIO_BANK);
  return { hash: samplesHash(joinChannels(ch)), detail: `${ch.length} ch, ${ch[0]!.length} samples` };
}

function songEntry(script: string, mode: 'full' | 'loop'): Entry {
  const lib = library(script);
  const r = renderSong(lib.songs.get('s')!, { instruments: (i) => lookupInstrument(lib, i), bank: AUDIO_BANK, mode });
  return { hash: samplesHash(joinChannels(r.mix)), detail: `2 ch, ${r.length} samples` };
}

if (process.env.UPDATE_GOLDEN) {
  const g: Golden = { renders: {}, songs: {} };
  for (const [k, v] of Object.entries(SONG_TABLE)) g.songs![k] = { ...songEntry(v.script, v.mode), renderVersion: RENDER_VERSION };
  for (const [k, v] of Object.entries(RENDER_TABLE)) g.renders[k] = { ...renderEntry(v), renderVersion: RENDER_VERSION };
  writeFileSync(GOLDEN, JSON.stringify(g, null, 1) + '\n');
}

const golden: Golden = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : { renders: {}, songs: {} };

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

  it('every song has a golden', () => {
    expect(Object.keys(golden.songs ?? {}).sort()).toEqual(Object.keys(SONG_TABLE).sort());
  });

  for (const [name, t] of Object.entries(SONG_TABLE)) {
    it(`renders the song ${name} to its golden samples`, () => {
      const g = golden.songs![name]!;
      expect(songEntry(t.script, t.mode)).toEqual({ hash: g.hash, detail: g.detail });
      expect(g.renderVersion).toBe(RENDER_VERSION);
    });
  }
});
