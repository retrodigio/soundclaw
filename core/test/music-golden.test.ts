// Goldens for rendered songs and the built-in instruments: every channel, the mix and the loop of a few
// scripts, hashed. A change here changes every cached and exported song: bump RENDER_VERSION and
// regenerate with UPDATE_GOLDEN=1, saying why in the commit.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RENDER_VERSION } from '../src/index.ts';
import { hashes } from './music-golden-table.ts';

const GOLDEN = join(import.meta.dirname, 'music-golden.json');

describe('music goldens', () => {
  const here = hashes();
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(GOLDEN)) writeFileSync(GOLDEN, JSON.stringify({ renderVersion: RENDER_VERSION, hashes: here }, null, 1) + '\n');
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { renderVersion: number; hashes: Record<string, string> };

  it('the stored hashes are for this render version', () => {
    expect(golden.renderVersion).toBe(RENDER_VERSION);
  });

  it.each(Object.keys(golden.hashes))('%s renders to its golden hash', (k) => {
    expect(here[k]).toBe(golden.hashes[k]);
  });

  it('no render is missing a golden, and none is left over', () => {
    expect(Object.keys(here).sort()).toEqual(Object.keys(golden.hashes).sort());
  });

  it('a fresh process renders the same bytes (no platform maths in the song renderer)', () => {
    const out = execFileSync(process.execPath, [join(import.meta.dirname, 'music-golden-run.ts')], { encoding: 'utf8', maxBuffer: 1 << 24 });
    expect(JSON.parse(out)).toEqual(here);
  }, 60_000);
});
