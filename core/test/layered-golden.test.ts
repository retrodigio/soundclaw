// Goldens for the layered voice: every source kind, every oscillator wave, every FM algorithm,
// every envelope curve, every effect and filter type, stereo, the recipes. Each entry is a small
// command script; its rendered samples (all channels) are hashed and compared with the stored
// hash. A change here changes every exported and cached layered sound: bump RENDER_VERSION and
// regenerate with UPDATE_GOLDEN=1, saying why in the commit.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RENDER_VERSION, Library, applyCommand, joinChannels, parse, renderChannels, samplesHash, type LayeredSound } from '../src/index.ts';
import { BANK } from './layered-helpers.ts';
import { TABLE } from './layered-golden-table.ts';

const GOLDEN = join(import.meta.dirname, 'layered-golden.json');


function build(script: string): LayeredSound {
  const lib = new Library();
  const p = parse(script);
  if (p.errors.length) throw new Error(`${p.errors[0]!.message}`);
  for (const c of p.commands) applyCommand(lib, c);
  return lib.get('s') as LayeredSound;
}

interface Golden { channels: number; samples: number; hash: string }

function measure(script: string): Golden {
  const ch = renderChannels(build(script), BANK);
  return { channels: ch.length, samples: ch[0]!.length, hash: samplesHash(joinChannels(ch)) };
}

if (process.env.UPDATE_GOLDEN) {
  const out: Record<string, Golden & { renderVersion: number }> = {};
  for (const [k, v] of Object.entries(TABLE)) out[k] = { ...measure(v), renderVersion: RENDER_VERSION };
  writeFileSync(GOLDEN, JSON.stringify(out, null, 1) + '\n');
}

const golden: Record<string, Golden & { renderVersion: number }> = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : {};

describe('layered goldens', () => {
  it('covers every source kind, wave, algorithm, curve, filter type, effect and recipe', () => {
    for (const k of ['classic-pickup', 'ks-pluck', 'sample-plain', 'fm-chain-4', 'fm-fan-4', 'fm-pairs-4', 'fm-parallel-3', 'fx-bitcrush', 'fx-chorus', 'fx-delay', 'fx-reverb', 'filter-fx-notch', 'fx-distort-fold', 'curve-hold', 'curve-ease', 'curve-exp', 'curve-lin', 'wave-metal', 'wave-pink', 'wave-brown', 'wave-pulse', 'wave-wavetable']) expect(TABLE[k], k).toBeDefined();
    expect(Object.keys(TABLE).length).toBeGreaterThanOrEqual(60);
  });

  it('every entry has a golden (run with UPDATE_GOLDEN=1 to write them)', () => {
    expect(Object.keys(golden).sort()).toEqual(Object.keys(TABLE).sort());
  });

  for (const [name, script] of Object.entries(TABLE)) {
    it(`renders ${name} to its golden samples`, () => {
      const g = golden[name]!;
      const m = measure(script);
      expect(m).toEqual({ channels: g.channels, samples: g.samples, hash: g.hash });
      expect(g.renderVersion).toBe(RENDER_VERSION);
    });
  }

  it('renders twice to the same bytes, and in a fresh process', () => {
    const name = 'master-chain';
    const a = measure(TABLE[name]!);
    expect(measure(TABLE[name]!)).toEqual(a);
    const src = JSON.stringify(join(import.meta.dirname, '..', 'src', 'index.ts'));
    const script = `import { applyCommand, parse, renderChannels, joinChannels, samplesHash } from ${src};
      const lib = new Map();
      for (const c of parse(${JSON.stringify(TABLE[name])}).commands) applyCommand(lib, c);
      process.stdout.write(samplesHash(joinChannels(renderChannels(lib.get('s')))));`;
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })).toBe(golden[name]!.hash);
  });

  it('stereo entries have two channels, the rest one', () => {
    for (const [name, g] of Object.entries(golden)) {
      const stereo = /pan|recipe-magic/.test(name) || TABLE[name]!.includes('pan=');
      expect(g.channels, name).toBe(stereo ? 2 : 1);
    }
  });
});
