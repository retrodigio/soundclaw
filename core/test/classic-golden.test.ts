// Conformance: a table of patches (every parameter at both extremes, every wave, seeds) rendered
// and compared with stored hashes of the exact samples and of the pre-rendered WAV. The hashes come
// from this port; they were also checked sample for sample against the reference synthesiser
// (see docs/design.md). A change here changes every exported and cached classic sound: bump
// RENDER_VERSION and regenerate with UPDATE_GOLDEN=1, saying why in the commit.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLASSIC_FIELDS, classicWav, formatPatchNamed, renderClassic, sha256Hex } from '../src/index.ts';
import { TABLE, tablePatch } from './classic-table.ts';

const GOLDEN = join(import.meta.dirname, 'classic-golden.json');

interface Golden {
  patch: string;
  samples: number;
  /** SHA-256 of the doubles' bytes. */
  exact: string;
  /** SHA-256 of the pre-rendered WAV file. */
  wav: string;
}

const bytes = (x: Float64Array): Uint8Array => new Uint8Array(x.buffer, x.byteOffset, x.byteLength);

function measure(): Record<string, Golden> {
  const out: Record<string, Golden> = {};
  for (const t of TABLE) {
    const p = tablePatch(t);
    const x = renderClassic(p);
    out[t.name] = { patch: formatPatchNamed(p), samples: x.length, exact: sha256Hex(bytes(x)), wav: sha256Hex(classicWav(x)) };
  }
  return out;
}

if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, JSON.stringify(measure(), null, 1) + '\n');

const golden: Record<string, Golden> = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : {};

describe('conformance table', () => {
  it('has at least 40 patches covering every parameter at both extremes, every wave and seeds', () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(40);
    for (const f of CLASSIC_FIELDS) {
      if (f.name === 'wave') continue;
      expect(TABLE.some((t) => t.name === `${f.name}-min`), `${f.name} min`).toBe(true);
      expect(TABLE.some((t) => t.name === `${f.name}-max`), `${f.name} max`).toBe(true);
    }
    for (const w of ['square', 'saw', 'sine', 'noise']) expect(TABLE.some((t) => t.name === `wave-${w}`)).toBe(true);
    expect(TABLE.filter((t) => t.name.startsWith('noise-seed-')).length).toBeGreaterThanOrEqual(4);
  });

  it('every patch has a golden entry (run with UPDATE_GOLDEN=1 to write them)', () => {
    expect(Object.keys(golden).sort()).toEqual(TABLE.map((t) => t.name).sort());
  });

  for (const t of TABLE) {
    it(`renders ${t.name} to its golden samples`, () => {
      const p = tablePatch(t);
      const g = golden[t.name]!;
      const x = renderClassic(p);
      expect(formatPatchNamed(p)).toBe(g.patch);
      expect(x.length).toBe(g.samples);
      expect(sha256Hex(bytes(x))).toBe(g.exact);
      expect(sha256Hex(classicWav(x))).toBe(g.wav);
      for (const v of x) expect(Math.abs(v)).toBeLessThanOrEqual(1);
    });
  }

  it('a fresh process renders the same samples (nothing depends on state or the clock)', () => {
    const t = TABLE.find((x) => x.name === 'wave-noise-filtered')!;
    const src = JSON.stringify(join(import.meta.dirname, '..', 'src', 'index.ts'));
    const script = `import { makePatch, renderClassic, sha256Hex } from ${src};
      const x = renderClassic(makePatch(${JSON.stringify(t.values)}));
      process.stdout.write(sha256Hex(new Uint8Array(x.buffer)));`;
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })).toBe(golden[t.name]!.exact);
  });
});
