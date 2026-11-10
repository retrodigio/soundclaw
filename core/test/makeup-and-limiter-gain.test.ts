// `compress makeup=auto` (the makeup that brings a full-scale input back to full scale, worked out when the command runs) and the
// limiter's `gain` (added before limiting; absent from a document while it is 0, so older renders and keys are untouched).

import { describe, expect, it } from 'vitest';
import { analyze, layeredBody, serializeLayered } from '../src/index.ts';
import { layered, render } from './layered-helpers.ts';

const BASE = 'sound new s voice=layered seed=3\nlayer add s osc wave=sine freq=300 dur=0.3 gain=0.1\n';

describe('compress makeup=auto', () => {
  it('writes −threshold × (1 − 1/ratio) dB from the threshold and ratio the effect has, to at most 24', () => {
    expect(layered(BASE + 'fx add s compress threshold=-18 ratio=4 makeup=auto\n').master[0]!.p.makeup).toBe(13.5);
    expect(layered(BASE + 'fx add s compress makeup=auto threshold=-24 ratio=8\n').master[0]!.p.makeup).toBe(21);
    expect(layered(BASE + 'fx add s compress threshold=-60 ratio=20 makeup=auto\n').master[0]!.p.makeup).toBe(24);
    expect(layered(BASE + 'fx add s compress threshold=-18 ratio=1 makeup=auto\n').master[0]!.p.makeup).toBe(0);
  });
  it('fx set works the number out from what the effect has then, and the document holds a number', () => {
    const s = layered(BASE + 'fx add s compress threshold=-18 ratio=4\nfx set s 1 threshold=-30 makeup=auto\n');
    expect(s.master[0]!.p.makeup).toBe(22.5);
    expect(serializeLayered(s).join('\n')).toContain('makeup=22.5');
    expect(serializeLayered(s).join('\n')).not.toContain('makeup=auto');
  });
  it('other effects and parameters do not take auto', () => {
    expect(() => layered(BASE + 'fx add s compress threshold=auto\n')).toThrow(/threshold must be a number/);
    expect(() => layered(BASE + 'fx add s limit ceiling=auto\n')).toThrow(/ceiling must be a number/);
  });
});

describe("limit's gain", () => {
  it('is left out of the text and the render key while it is 0, so older documents are unchanged', () => {
    const s = layered(BASE + 'fx add s limit ceiling=-1\n');
    expect(serializeLayered(s).join('\n')).not.toContain('gain=0 ');
    expect(layeredBody(s, () => '')).not.toMatch(/limit\([^)]*gain/);
    const g = layered(BASE + 'fx add s limit ceiling=-1 gain=6\n');
    expect(layeredBody(g, () => '')).toMatch(/limit\([^)]*gain=6/);
  });
  it('raises the level before the limiter, which then holds the peaks: 6 dB more is 6 dB more under the ceiling, and over it is held', () => {
    const quiet = analyze([render(layered(BASE + 'fx add s limit ceiling=-1\n'))]);
    const up = analyze([render(layered(BASE + 'fx add s limit ceiling=-1 gain=6\n'))]);
    expect(up.peakDb - quiet.peakDb).toBeGreaterThan(5.9);
    expect(up.peakDb - quiet.peakDb).toBeLessThan(6.1);
    const loud = analyze([render(layered(BASE + 'fx add s limit ceiling=-1 gain=40\n'))]);
    expect(loud.truePeakDb).toBeLessThanOrEqual(-1);
  });
  it('is the same bytes every time', () => {
    const a = render(layered(BASE + 'fx add s limit ceiling=-2 gain=20\n'));
    expect(Array.from(render(layered(BASE + 'fx add s limit ceiling=-2 gain=20\n')))).toEqual(Array.from(a));
  });
});
