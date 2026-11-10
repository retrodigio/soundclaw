// The convolution effect: a sound through a sample used as an impulse response, on a layer, on the master chain and in a song's send bus.

import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE, renderChannels, renderKey, soundSamples, type LayeredSound } from '../src/index.ts';
import { build } from './layered-helpers.ts';
import { AUDIO_BANK, rms } from './audio-material.ts';

const SR = SAMPLE_RATE;
const sound = (script: string): LayeredSound => build(script).get('s') as LayeredSound;
const ONE = (extra: string): string => `sound new s voice=layered seed=1\nsound set s duration=0.4\nlayer add s osc wave=sine freq=440 dur=0.1\n${extra}`;
const closeTo = (a: ArrayLike<number>, b: ArrayLike<number>, n: number, tol: number, shift = 0): void => {
  for (let i = 0; i < n; i += 5) expect(Math.abs((a[i + shift] ?? 0) - (b[i] ?? 0)), `at ${i}`).toBeLessThan(tol);
};

describe('the convolve effect', () => {
  it('a unit impulse as the response leaves the layer as it was, and a late one delays it', () => {
    const plain = renderChannels(sound(ONE('')), AUDIO_BANK)[0]!;
    const same = renderChannels(sound(ONE('fx add s layer=1 convolve ir=spike mix=1 len=0.05')), AUDIO_BANK)[0]!;
    closeTo(same, plain, plain.length, 1e-5);
    const late = renderChannels(sound(ONE('fx add s layer=1 convolve ir=late mix=1 len=0.2')), AUDIO_BANK)[0]!;
    closeTo(late, plain, 4000, 1e-5, 4410);
    expect(rms(late, 0, 4000)).toBe(0);
  });

  it('predelay moves the wet signal later, and the dry part stays where it was at a mix below one', () => {
    const dry = renderChannels(sound(ONE('')), AUDIO_BANK)[0]!;
    const wet = renderChannels(sound(ONE('fx add s layer=1 convolve ir=room mix=1 len=0.3 predelay=0.05')), AUDIO_BANK)[0]!;
    expect(rms(wet, 0, 0.049 * SR)).toBe(0);
    expect(rms(wet, 0.06 * SR, 0.1 * SR)).toBeGreaterThan(0.01);
    const half = renderChannels(sound(ONE('fx add s layer=1 convolve ir=room mix=0.5 len=0.3')), AUDIO_BANK)[0]!;
    const full = renderChannels(sound(ONE('fx add s layer=1 convolve ir=room mix=1 len=0.3')), AUDIO_BANK)[0]!;
    for (let i = 0; i < 4000; i += 37) expect(half[i]!).toBeCloseTo(0.5 * dry[i]! + 0.5 * full[i]!, 5);
  });

  it('rings on after the sound by the length of the response, and no more than `len`', () => {
    const base = ONE('');
    const short = renderChannels(sound(base.replace('duration=0.4', 'duration=auto') + 'fx add s layer=1 convolve ir=room mix=1 len=0.1'), AUDIO_BANK)[0]!;
    const long = renderChannels(sound(base.replace('duration=0.4', 'duration=auto') + 'fx add s layer=1 convolve ir=room mix=1 len=0.5'), AUDIO_BANK)[0]!;
    expect(long.length).toBeGreaterThan(short.length + 0.15 * SR);
    expect(long.length).toBeLessThan(0.1 * SR + 0.55 * SR);
  });

  it('the response is scaled to unit energy: noise through a noise response is about as loud as it was', () => {
    const noise = 'layer add s osc wave=white dur=0.4\n';
    const dry = renderChannels(sound(`sound new s voice=layered seed=1\nsound set s duration=0.6\n${noise}`), AUDIO_BANK)[0]!;
    const wet = renderChannels(sound(`sound new s voice=layered seed=1\nsound set s duration=0.6\n${noise}fx add s layer=1 convolve ir=room mix=1 len=0.5`), AUDIO_BANK)[0]!;
    const ratio = rms(wet, 0.1 * SR, 0.4 * SR) / rms(dry, 0.1 * SR, 0.4 * SR);
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.6);
    const quiet = renderChannels(sound(`sound new s voice=layered seed=1\nsound set s duration=0.6\n${noise}fx add s layer=1 convolve ir=room mix=1 len=0.5 gain=-6`), AUDIO_BANK)[0]!;
    expect(rms(quiet, 0.1 * SR, 0.4 * SR) / rms(wet, 0.1 * SR, 0.4 * SR)).toBeCloseTo(0.5012, 2);
  });

  it('a stereo response on the master chain gives a stereo sound, each side through its own channel; a mono response gives one channel', () => {
    const hall = renderChannels(sound(ONE('fx add s convolve ir=hall mix=1 len=0.3')), AUDIO_BANK);
    expect(hall.length).toBe(2);
    let differ = 0;
    for (let i = 0; i < 6000; i++) if (Math.abs(hall[0]![i]! - hall[1]![i]!) > 1e-4) differ++;
    expect(differ).toBeGreaterThan(1000);
    expect(renderChannels(sound(ONE('fx add s convolve ir=room mix=1 len=0.3')), AUDIO_BANK).length).toBe(1);
  });

  it('a response that is not there leaves the sound as it is, and the same document renders the same bytes every time', () => {
    const doc = ONE('fx add s layer=1 convolve ir=gone mix=1 len=0.3');
    const a = renderChannels(sound(doc), AUDIO_BANK)[0]!;
    closeTo(a, renderChannels(sound(ONE('')), AUDIO_BANK)[0]!, a.length, 1e-7);
    const b = renderChannels(sound(ONE('fx add s layer=1 convolve ir=room mix=0.7 len=0.4')), AUDIO_BANK)[0]!;
    const c = renderChannels(sound(ONE('fx add s layer=1 convolve ir=room mix=0.7 len=0.4')), AUDIO_BANK)[0]!;
    expect(Buffer.from(b.buffer).equals(Buffer.from(c.buffer))).toBe(true);
  });

  it('is part of the render key with the response\'s hash, and the sound reaches the sample', () => {
    const s = sound(ONE('fx add s layer=1 convolve ir=room mix=0.5 len=0.3\nfx add s convolve ir=hall mix=0.2 len=0.3'));
    const a = renderKey(s, (n) => `h-${n}`), b = renderKey(s, (n) => `h2-${n}`);
    expect(a).not.toBe(b);
    expect(a).toBe(renderKey(s, (n) => `h-${n}`));
    expect(soundSamples(s).sort()).toEqual(['hall', 'room']);
  });

  it('checks its settings: a response is a sample name, len is up to 12 s, and the effect is listed with the others', () => {
    expect(() => build(ONE('fx add s layer=1 convolve ir=bad/name'))).toThrow(/sample name/);
    expect(() => build(ONE('fx add s layer=1 convolve ir=room len=30'))).toThrow(/between 0.05 and 12/);
    expect(() => build(ONE('fx add s layer=1 convolve ir=room predelay=2'))).toThrow(/predelay/);
  });
});
