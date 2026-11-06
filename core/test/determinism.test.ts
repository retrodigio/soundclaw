// The renderer is deterministic: the same document gives the same samples, every time, in a fresh
// process, with no dependence on Math.sin or any state.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE, levels, newSound, peaks, renderKey, renderSound, samplesHash, sineCycles, type Sound } from '../src/index.ts';

const tone = (o: Partial<Sound> = {}): Sound => ({ ...newSound('t'), ...o });

describe('renderSound', () => {
  it('renders 44,100 Hz mono: duration x rate samples, in range', () => {
    const s = renderSound(tone({ duration: 0.25 }));
    expect(s).toBeInstanceOf(Float32Array);
    expect(s.length).toBe(Math.round(0.25 * SAMPLE_RATE));
    expect(levels(s).peak).toBeLessThanOrEqual(0.5);
    expect(levels(s).peak).toBeGreaterThan(0.499);
  });

  it('the same document renders identical samples twice', () => {
    const a = renderSound(tone({ frequency: 523.25, volume: 0.8, duration: 0.3 }));
    const b = renderSound(tone({ frequency: 523.25, volume: 0.8, duration: 0.3 }));
    expect(samplesHash(a)).toBe(samplesHash(b));
    expect(Buffer.compare(Buffer.from(a.buffer), Buffer.from(b.buffer))).toBe(0);
  });

  it('a fresh process renders the same samples', () => {
    const doc = tone({ frequency: 1234.5, volume: 0.9, duration: 0.4 });
    const script = `
      import { renderSound, samplesHash, newSound } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'index.ts'))};
      process.stdout.write(samplesHash(renderSound({ ...newSound('t'), frequency: 1234.5, volume: 0.9, duration: 0.4 })));`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(out).toBe(samplesHash(renderSound(doc)));
  });

  it('keeps its golden samples (a change here changes every cached and exported sound)', () => {
    expect(samplesHash(renderSound(tone()))).toBe('877fc91299a390546019da5381fa9cd79ecdd4a4cff5d24fb64a178a0b114370');
    expect(samplesHash(renderSound(tone({ frequency: 880, duration: 0.1, volume: 1 })))).toBe('cb0dbaa6fc3139396f5dc27f9d07e4377c8aa88d809afee35e242458c504040c');
  });

  it('a different parameter renders different samples, and a status mark does not change the key', () => {
    expect(samplesHash(renderSound(tone({ frequency: 441 })))).not.toBe(samplesHash(renderSound(tone())));
    expect(renderKey(tone({ status: 'approved' }))).toBe(renderKey(tone()));
    expect(renderKey(tone({ volume: 0.51 }))).not.toBe(renderKey(tone()));
    expect(renderKey(tone({ id: 'other' }))).toBe(renderKey(tone()));
  });
});

describe('sineCycles', () => {
  it('is a sine to better than 1e-10 over many phases, including negative and large ones', () => {
    let worst = 0;
    for (let i = -4000; i <= 4000; i++) {
      const c = i / 997;
      worst = Math.max(worst, Math.abs(sineCycles(c) - Math.sin(2 * Math.PI * c)));
    }
    expect(worst).toBeLessThan(1e-10);
    expect(sineCycles(0)).toBe(0);
    expect(sineCycles(0.25)).toBeCloseTo(1, 10);
    expect(sineCycles(0.75)).toBeCloseTo(-1, 10);
  });
});

describe('peaks', () => {
  it('gives the min and max of each column', () => {
    const p = peaks(Float32Array.from([0, 1, -1, 0.5, 0.25, -0.25, 0, 0]), 4);
    expect([...p.max]).toEqual([1, 0.5, 0.25, 0]);
    expect([...p.min]).toEqual([0, -1, -0.25, 0]);
  });
});
