// The grain source: a cloud of short windowed pieces of a sample, seeded, level-kept, and cut cleanly when it loops.

import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE, renderChannels, renderKey, soundSamples, layerSamples, type LayeredSound, type SampleBank } from '../src/index.ts';
import { build } from './layered-helpers.ts';
import { AUDIO_BANK, crossingsHz, firstOver, rms, tone } from './audio-material.ts';

const SR = SAMPLE_RATE;
const sound = (script: string): LayeredSound => build(script).get('s') as LayeredSound;
const GRAIN = (args: string, seed = 1): string => `sound new s voice=layered seed=${seed}\nsound set s duration=2\nlayer add s grain sample=bed dur=2 ${args}\n`;
const rend = (script: string, bank: SampleBank = AUDIO_BANK): Float32Array => renderChannels(sound(script), bank)[0]!;

describe('the grain source', () => {
  it('is the same cloud every time, and another cloud with another seed', () => {
    const a = rend(GRAIN('density=30 size=0.05 spread=0.4')), b = rend(GRAIN('density=30 size=0.05 spread=0.4'));
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    const c = rend(GRAIN('density=30 size=0.05 spread=0.4', 2));
    expect(Buffer.from(a.buffer).equals(Buffer.from(c.buffer))).toBe(false);
    expect(rms(a)).toBeGreaterThan(0.01);
  });

  it('starts about `density` grains a second, evenly when the jitter is 0', () => {
    const flat: SampleBank = { get: () => ({ rate: SR, data: new Float32Array(SR).fill(0.5) }), hash: () => 'flat' };
    const x = rend(`sound new s voice=layered seed=1\nsound set s duration=2\nlayer add s grain sample=flat dur=2 density=5 size=0.05 jitter=0 spread=0 position=0.5\n`, flat);
    // a constant sample: each grain is a Hann bump of 50 ms every 200 ms; count the bumps
    let bumps = 0, inside = false;
    for (let i = 0; i < x.length; i++) {
      const on = Math.abs(x[i]!) > 0.05;
      if (on && !inside) bumps++;
      inside = on;
    }
    expect(bumps).toBeGreaterThanOrEqual(9);
    expect(bumps).toBeLessThanOrEqual(11);
  });

  it('takes its grains from around the position: a click far from it is not heard', () => {
    const data = new Float32Array(SR);
    for (let i = 0; i < 400; i++) data[900 + i] = 0.9 * (1 - i / 400);
    const bank: SampleBank = { get: () => ({ rate: SR, data }), hash: () => 'click' };
    const near = rend(`sound new s voice=layered seed=1\nsound set s duration=1\nlayer add s grain sample=click dur=1 density=40 size=0.02 spread=0 position=0.03\n`, bank);
    const far = rend(`sound new s voice=layered seed=1\nsound set s duration=1\nlayer add s grain sample=click dur=1 density=40 size=0.02 spread=0 position=0.8\n`, bank);
    expect(rms(near)).toBeGreaterThan(0.02);
    expect(rms(far)).toBe(0);
  });

  it('pitch moves the grains: a steady 440 Hz tone with pitch=12 is 880 Hz, and the level does not follow the density', () => {
    const bank: SampleBank = { get: () => ({ rate: SR, data: tone(440, 1.5, 0.5) }), hash: () => 'a4' };
    const up = rend(`sound new s voice=layered seed=1\nsound set s duration=1\nlayer add s grain sample=a4 dur=1 density=20 size=0.2 jitter=0 spread=0 position=0.4 pitch=12\n`, bank);
    expect(crossingsHz(up, 0.3 * SR, 0.7 * SR)).toBeGreaterThan(860);
    expect(crossingsHz(up, 0.3 * SR, 0.7 * SR)).toBeLessThan(900);
    const sparse = rend(`sound new s voice=layered seed=1\nsound set s duration=1\nlayer add s grain sample=a4 dur=1 density=10 size=0.1 jitter=0.5 spread=0.3\n`, bank);
    const dense = rend(`sound new s voice=layered seed=1\nsound set s duration=1\nlayer add s grain sample=a4 dur=1 density=100 size=0.1 jitter=0.5 spread=0.3\n`, bank);
    const ratio = rms(dense, 0.2 * SR, 0.9 * SR) / rms(sparse, 0.2 * SR, 0.9 * SR);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(3.2);
  });

  it('keeps every grain inside the sample, even a long one at the very end', () => {
    const x = rend(GRAIN('density=20 size=0.9 position=1 spread=1 pitch=-12'));
    expect(x.every((v) => Number.isFinite(v))).toBe(true);
    expect(rms(x)).toBeGreaterThan(0);
  });

  it('a position that moves follows its envelope', () => {
    const data = new Float32Array(2 * SR);
    for (let i = SR; i < 2 * SR; i++) data[i] = 0.4 * Math.sign(Math.sin(i * 0.05));
    const bank: SampleBank = { get: () => ({ rate: SR, data }), hash: () => 'half' };
    const x = rend(`sound new s voice=layered seed=1\nsound set s duration=2\nlayer add s grain sample=half dur=2 density=60 size=0.03 spread=0 position=0\nenv s 1.position "0:0.1 0.9:0.1 1.1:0.9"\n`, bank);
    expect(rms(x, 0, 0.8 * SR)).toBe(0);
    expect(rms(x, 1.3 * SR, 1.9 * SR)).toBeGreaterThan(0.05);
    expect(firstOver(x, 0.02)).toBeGreaterThan(0.8 * SR);
  });

  it('a bed of grains loops cleanly through `sound loop`', () => {
    const s = sound(GRAIN('density=30 size=0.06 spread=0.4') + 'sound loop s 1.5 fade=0.3\n');
    const x = renderChannels(s, AUDIO_BANK)[0]!;
    expect(x.length).toBe(Math.round(1.5 * SR));
    // the last sample runs into the first as any two neighbours do
    let step = 0;
    for (let i = 1000; i < x.length - 1; i += 7) step = Math.max(step, Math.abs(x[i + 1]! - x[i]!));
    expect(Math.abs(x[0]! - x[x.length - 1]!)).toBeLessThan(Math.max(0.05, 3 * step));
  });

  it('reaches its sample, keys its render by the sample\'s hash, and is a source that takes effects and envelopes like the rest', () => {
    const s = sound(GRAIN('density=30') + 'fx add s layer=1 filter type=lp cutoff=2000\nenv s 1.amp "0:0 0.1:1 1.9:0"\n');
    expect(soundSamples(s)).toEqual(['bed']);
    expect(layerSamples(s.layers[0]!)).toEqual(['bed']);
    expect(renderKey(s, (n) => `a-${n}`)).not.toBe(renderKey(s, (n) => `b-${n}`));
    expect(rms(renderChannels(s, AUDIO_BANK)[0]!)).toBeGreaterThan(0);
  });

  it('checks its settings', () => {
    expect(() => build(GRAIN('density=0'))).toThrow(/density/);
    expect(() => build(GRAIN('size=2'))).toThrow(/size/);
    expect(() => build(GRAIN('side=stereo'))).toThrow(/side/);
  });
});
