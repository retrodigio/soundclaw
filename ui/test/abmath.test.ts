import { describe, expect, it } from 'vitest';
import { gainText, loudKind, matchGains, momentInterval, pairKey, playPlan, sameUpToLevel } from '../src/sets/abmath.ts';

describe('the blind A/B arithmetic', () => {
  it('reads the repeat interval from the moment\'s words', () => {
    expect(momentInterval('The player walks slowly; steps repeat every 0.4 s under quiet music')).toBe(0.4);
    expect(momentInterval('a drip every 750 ms in the cave')).toBe(0.75);
    expect(momentInterval('every 2 seconds a bell')).toBe(2);
    expect(momentInterval('a door opens once')).toBeNull();
    expect(momentInterval(null)).toBeNull();
    expect(playPlan('every .5s')).toEqual({ times: 4, interval: 0.5, gap: 0.5 });
    expect(playPlan('once')).toEqual({ times: 1, interval: 0, gap: 0.5 });
  });

  it('matches levels at the mean, and stays under the ceiling', () => {
    expect(matchGains({ lufs: -21.2, truePeakDb: -9 }, { lufs: -18.8, truePeakDb: -6 })).toEqual({ a: 1.2, b: -1.2 });
    // the louder side would cross -1 dBTP after its gain: both move down together
    expect(matchGains({ lufs: -30, truePeakDb: -2 }, { lufs: -20, truePeakDb: -3 })).toEqual({ a: 1, b: -9 });
    expect(matchGains({ lufs: null, truePeakDb: null }, { lufs: -20, truePeakDb: -3 })).toBeNull();
    expect(gainText(1.25)).toBe('+1.3 dB');
    expect(gainText(-0.3)).toBe('−0.3 dB');
    expect(gainText(0)).toBe('±0.0 dB');
  });

  it('grades a cell\'s loudness against its class', () => {
    expect(loudKind(-20.5, -20, 1)).toBe('pass');
    expect(loudKind(-21.8, -20, 1)).toBe('warn');
    expect(loudKind(-23, -20, 1)).toBe('fail');
    expect(loudKind(undefined, -20, 1)).toBe('checking');
    expect(loudKind(null, -20, 1)).toBe('fail');
  });

  it('two renders that differ only in level are the same pair; any other difference is not', () => {
    const a = [Float32Array.from({ length: 200 }, (_, i) => Math.sin(i / 7) * 0.5)];
    const b = [a[0]!.map((v) => v * 0.63)];
    const c = [a[0]!.map((v, i) => (i === 100 ? v + 0.01 : v))];
    expect(sameUpToLevel(a, b)).toBe(true);
    expect(sameUpToLevel(a, c)).toBe(false);
    expect(sameUpToLevel(a, [a[0]!.map((v) => -v)])).toBe(false);
    expect(sameUpToLevel(a, [a[0]!.slice(1)])).toBe(false);
    expect(pairKey({ id: 'x', seq: 3 }, { id: 'x', seq: 1 })).toBe(pairKey({ id: 'x', seq: 1 }, { id: 'x', seq: 3 }));
  });
});
