// Goldens for sampled sources: sample layers with each interpolation and each edit a layer can make, and every derive
// operation. Renders are hashed like the layered goldens; derived audio by its canonical hash. Documents that never name
// the new layer settings keep every existing golden (layered-golden, classic-golden): this file only adds.
// Regenerate with UPDATE_GOLDEN=1, saying why in the commit.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RENDER_VERSION, deriveAudio, joinChannels, pcmHash, renderChannels, samplesHash, type DeriveContext, type LayeredSound } from '../src/index.ts';
import { build } from './layered-helpers.ts';
import { BANK, DERIVE_TABLE, HITS, RENDER_TABLE, TONE, WIDE } from './sample-golden-table.ts';

const GOLDEN = join(import.meta.dirname, 'sample-golden.json');
const AUDIO = { tone: TONE, hits: HITS, wide: WIDE };
const SLICES = [0, 11025, 22050, 33075];

function ctxFor(from: keyof typeof AUDIO): DeriveContext {
  return {
    slices: from === 'hits' ? SLICES : [],
    byName: (n) => (n in AUDIO ? { hash: pcmHash(AUDIO[n as keyof typeof AUDIO]), audio: AUDIO[n as keyof typeof AUDIO] } : undefined),
    byHash: (h) => Object.values(AUDIO).find((a) => pcmHash(a) === h),
  };
}

interface Entry { hash: string; detail: string }

function renderEntry(script: string): Entry {
  const ch = renderChannels(build(script).get('s') as LayeredSound, BANK);
  return { hash: samplesHash(joinChannels(ch)), detail: `${ch.length} ch, ${ch[0]!.length} samples` };
}

function deriveEntry(from: keyof typeof AUDIO, chain: string): Entry & { settled: string } {
  const r = deriveAudio(AUDIO[from], chain, ctxFor(from));
  return { hash: pcmHash(r.audio), detail: `${r.audio.channels} ch, ${r.audio.frames} frames at ${r.audio.rate} Hz${r.loop ? `, loop ${r.loop[0]}-${r.loop[1]}` : ''}`, settled: r.settled };
}

type Golden = { renders: Record<string, Entry & { renderVersion: number }>; derives: Record<string, Entry & { settled: string }> };

if (process.env.UPDATE_GOLDEN) {
  const g: Golden = { renders: {}, derives: {} };
  for (const [k, v] of Object.entries(RENDER_TABLE)) g.renders[k] = { ...renderEntry(v), renderVersion: RENDER_VERSION };
  for (const [k, v] of Object.entries(DERIVE_TABLE)) g.derives[k] = deriveEntry(v.from, v.chain);
  writeFileSync(GOLDEN, JSON.stringify(g, null, 1) + '\n');
}

const golden: Golden = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : { renders: {}, derives: {} };

describe('sample goldens', () => {
  it('cover the three interpolations, every layer edit and every derive operation', () => {
    for (const k of ['interp-linear-up', 'interp-cubic-up', 'interp-sinc-up', 'edit-slice-2', 'edit-fades', 'edit-stretch-wsola-slower', 'edit-stretch-pv-faster', 'edit-loop-points', 'edit-stereo-stretch']) expect(RENDER_TABLE[k], k).toBeDefined();
    const ops = new Set(Object.values(DERIVE_TABLE).flatMap((d) => d.chain.split(';').map((x) => x.trim().split(/\s+/)[0]!)));
    for (const op of ['trim', 'fade', 'gain', 'normalize', 'silence-trim', 'dc', 'reverse', 'mono', 'left', 'right', 'pitch', 'stretch', 'loop', 'slice', 'mix']) expect(ops.has(op), op).toBe(true);
  });

  it('every entry has a golden (run with UPDATE_GOLDEN=1 to write them)', () => {
    expect(Object.keys(golden.renders).sort()).toEqual(Object.keys(RENDER_TABLE).sort());
    expect(Object.keys(golden.derives).sort()).toEqual(Object.keys(DERIVE_TABLE).sort());
  });

  for (const [name, script] of Object.entries(RENDER_TABLE)) {
    it(`renders ${name} to its golden samples`, () => {
      const g = golden.renders[name]!;
      expect(renderEntry(script)).toEqual({ hash: g.hash, detail: g.detail });
      expect(g.renderVersion).toBe(RENDER_VERSION);
    });
  }

  for (const [name, d] of Object.entries(DERIVE_TABLE)) {
    it(`derives ${name} to its golden audio`, () => {
      expect(deriveEntry(d.from, d.chain)).toEqual(golden.derives[name]);
    });
  }

  it('settles a chain once: settling the settled text gives the same audio and the same text', () => {
    for (const [name, d] of Object.entries(DERIVE_TABLE)) {
      const first = deriveAudio(AUDIO[d.from], d.chain, ctxFor(d.from));
      const again = deriveAudio(AUDIO[d.from], first.settled, ctxFor(d.from));
      expect(again.settled, name).toBe(first.settled);
      expect(pcmHash(again.audio), name).toBe(pcmHash(first.audio));
    }
  });
});
