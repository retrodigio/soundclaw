// The `limit` effect's true-peak mode (the default): the points between samples are held under the ceiling too, so a limited
// sound passes the clip check, and a short release lets a train of hits each be limited on its own.

import { describe, expect, it } from 'vitest';
import { DEFAULT_STYLE, analyze, renderChannels, runChecks } from '../src/index.ts';
import { layered, render } from './layered-helpers.ts';

const TIMES = Array.from({ length: 12 }, (_, i) => (0.05 + i * 0.08).toFixed(3)).join(',');
const TRAIN = `sound new s voice=layered seed=3\nlayer add s osc wave=white dur=1.2\nenv s 1.amp bursts(times=${TIMES} attack=0.001 decay=0.03 level=1)\nsound set s gain=4\n`;
const clip = (script: string) => {
  const ch = renderChannels(layered(script));
  return { a: analyze(ch), check: runChecks(ch, analyze(ch), DEFAULT_STYLE).find((c) => c.name === 'clip')! };
};

describe('limit in true-peak mode', () => {
  it('a burst train that clips unlimited passes the clip check once limited (true is the default mode)', () => {
    expect(clip(TRAIN).check.pass).toBe(false);
    const r = clip(TRAIN + 'fx add s limit ceiling=-0.5\n');
    expect(r.check.pass, r.check.value).toBe(true);
    expect(r.a.truePeakDb).toBeLessThanOrEqual(-0.5);
    expect(layered(TRAIN + 'fx add s limit ceiling=-0.5\n').master[0]!.p.mode).toBe('true');
  });
  it('sample mode holds only the samples: the same train can still be over between them', () => {
    const t = clip(TRAIN + 'fx add s limit ceiling=-0.5 mode=true\n').a;
    const s = clip(TRAIN + 'fx add s limit ceiling=-0.5 mode=sample\n').a;
    expect(s.peakDb).toBeLessThanOrEqual(-0.5 + 1e-6);
    expect(s.truePeakDb).toBeGreaterThan(t.truePeakDb + 0.2);
    expect(s.truePeakDb).toBeGreaterThan(-0.1); // over the clip check's limit
  });
  it('leaves a quiet sound exactly as it was, and is the same bytes every time', () => {
    const quiet = TRAIN.replace('gain=4', 'gain=0.2');
    expect(Array.from(render(layered(quiet + 'fx add s limit ceiling=-1\n')))).toEqual(Array.from(render(layered(quiet))));
    const a = render(layered(TRAIN + 'fx add s limit ceiling=-1\n'));
    expect(Array.from(render(layered(TRAIN + 'fx add s limit ceiling=-1\n')))).toEqual(Array.from(a));
  });
  it('works with no look-ahead, and in a stereo sound each channel is held', () => {
    const r = clip(TRAIN + 'fx add s limit ceiling=-1 lookahead=0\n');
    expect(r.a.truePeakDb).toBeLessThanOrEqual(-0.9);
    const st = clip(TRAIN.replace('dur=1.2', 'dur=1.2 pan=-0.7') + 'fx add s limit ceiling=-1\n');
    expect(st.a.channels).toBe(2);
    expect(st.a.truePeakDb).toBeLessThanOrEqual(-0.9);
  });
  it('a short release (the default 20 ms) limits each hit of a train on its own: a quiet hit after a loud one keeps its level', () => {
    // hits 60 ms apart: loud, quiet, loud, quiet
    const base = (rel: number): string => `sound new s voice=layered seed=3\nlayer add s osc wave=white dur=0.5\nenv s 1.amp bursts(times=0.05,0.11,0.17,0.23 attack=0.001 decay=0.03 level=3,0.4,3,0.4)\nfx add s limit ceiling=-1 release=${rel}\n`;
    const peakAround = (x: Float32Array, t: number): number => { let p = 0; for (let i = Math.round(t * 44100); i < Math.round((t + 0.03) * 44100); i++) p = Math.max(p, Math.abs(x[i]!)); return p; };
    const dry = render(layered(base(20).replace(/fx add.*\n/, '')));
    const fast = render(layered(base(20)));
    const slow = render(layered(base(400)));
    const kept = (x: Float32Array): number => peakAround(x, 0.111) / peakAround(dry, 0.111);
    expect(kept(fast)).toBeGreaterThan(0.9);
    expect(kept(slow)).toBeLessThan(0.7);
  });
});
