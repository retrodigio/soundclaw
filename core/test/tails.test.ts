// `duration=auto` and the `tail` check are one definition: a sound ends where it is 60.3 dB under its peak, and the check's silence
// is measured from the same floor. Delay and reverb tails (which used to be given a made-up length) pass `tail` with auto.

import { describe, expect, it } from 'vitest';
import { DEFAULT_STYLE, DIED_AWAY, analyze, fxTail, renderChannels, runChecks, type Fx } from '../src/index.ts';
import { layered } from './layered-helpers.ts';

const HIT = 'sound new s voice=layered seed=1\nlayer add s osc wave=sine freq=500 dur=0.2\nenv s 1.amp "0:0 0.002:1 0.15:0@exp"\n';
const NOISE = 'sound new s voice=layered seed=1\nlayer add s osc wave=white dur=0.05\nenv s 1.amp "0:0 0.002:1 0.04:0@exp"\n';

function tail(script: string): { pass: boolean; why: string; seconds: number; trailing: number } {
  const ch = renderChannels(layered(script));
  const a = analyze(ch);
  const t = runChecks(ch, a, DEFAULT_STYLE).find((c) => c.name === 'tail')!;
  return { pass: t.pass, why: `${t.value} ${t.ranges.map((r) => r.note).join('; ')}`, seconds: ch[0]!.length / 44100, trailing: a.trailingSilence };
}

describe('automatic length and the tail check agree', () => {
  const cases: [string, string][] = [
    ['a delay on a layer', HIT + 'fx add s layer=1 delay time=0.2 feedback=0.5 mix=0.5'],
    ['a delay on the master chain', HIT + 'fx add s delay time=0.13 feedback=0.7 mix=0.4'],
    ['a long, slow delay', HIT + 'fx add s delay time=0.9 feedback=0.6 mix=0.4'],
    ['a delay with high feedback', HIT + 'fx add s layer=1 delay time=0.1 feedback=0.9 mix=0.5'],
    ['a small reverb', NOISE + 'fx add s reverb size=0.1 damp=0.5 mix=0.4'],
    ['a medium reverb', NOISE + 'fx add s reverb size=0.5 damp=0.5 mix=0.4'],
    ['the largest reverb', HIT + 'fx add s reverb size=1 damp=0.2 mix=0.5'],
    ['a stereo reverb', NOISE.replace('dur=0.05', 'dur=0.05 pan=-0.6') + 'fx add s reverb size=0.8 damp=0.3 mix=0.5'],
    ['a delay into a reverb', HIT + 'fx add s layer=1 delay time=0.15 feedback=0.5 mix=0.4\nfx add s reverb size=0.6 damp=0.5 mix=0.3'],
  ];
  for (const [name, script] of cases) {
    it(`${name} passes tail with duration=auto`, () => {
      const t = tail(script);
      expect(t.pass, t.why).toBe(true);
      expect(t.trailing).toBeLessThan(0.01); // the 3 ms fade, and nothing more
    });
  }

  it('a sound is given room for the real tail: the largest reverb rings for seconds, not for 2.5', () => {
    expect(tail(HIT + 'fx add s reverb size=1 damp=0.2 mix=0.5').seconds).toBeGreaterThan(5);
    expect(tail(HIT + 'fx add s reverb size=0 damp=0.5 mix=0.5').seconds).toBeLessThan(1.5);
  });
  it('fxTail: a delay is given its echoes down to -66 dB, a reverb its 60 dB decay time', () => {
    const fx = (kind: Fx['kind'], p: Record<string, number>): Fx => ({ kind, p, envs: {} });
    expect(fxTail(fx('delay', { time: 0.1, feedback: 0.5, mix: 0.5 }))).toBeCloseTo(1.2, 5); // 1 + ceil(10.95) = 12 echoes
    expect(fxTail(fx('delay', { time: 0.1, feedback: 0, mix: 0.5 }))).toBeCloseTo(0.1, 5);
    expect(fxTail(fx('delay', { time: 0.1, feedback: 0.5, mix: 0 }))).toBe(0);
    expect(fxTail(fx('delay', { time: 0.5, feedback: 0.95, mix: 0.5 }))).toBe(60); // capped
    expect(fxTail(fx('reverb', { size: 0, damp: 0.5, mix: 0.3 }))).toBeGreaterThan(0.5);
    expect(fxTail(fx('reverb', { size: 1, damp: 0.5, mix: 0.3 }))).toBeGreaterThan(10);
    expect(fxTail(fx('reverb', { size: 1, damp: 0.5, mix: 0.3 }))).toBeLessThan(12);
  });
  it('the floor is one number', () => {
    expect(DIED_AWAY).toBeCloseTo(10 ** (-60.3 / 20), 12);
  });
});
