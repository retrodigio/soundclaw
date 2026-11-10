// A layered recipe may take a sample: its first moments are laid over the recipe's body as one more layer. No recipe ships audio.

import { describe, expect, it } from 'vitest';
import { RECIPE_NAMES, SAMPLE_RATE, parse, recipeBody, renderChannels, soundSamples, type LayeredSound } from '../src/index.ts';
import { build } from './layered-helpers.ts';
import { AUDIO_BANK, rms } from './audio-material.ts';

const sound = (script: string): LayeredSound => build(script).get('s') as LayeredSound;

describe('recipes that take a sample', () => {
  it('lay the sample over the body as one more layer, and leave the body as it was', () => {
    const plain = sound('sound new s voice=layered preset=door seed=3');
    const withSample = sound('sound new s voice=layered preset=door seed=3 sample=beat');
    expect(withSample.layers.length).toBe(plain.layers.length + 1);
    expect(withSample.layers.slice(0, plain.layers.length)).toEqual(plain.layers);
    const l = withSample.layers.at(-1)!;
    expect(l.kind).toBe('sample');
    expect(l.p).toMatchObject({ sample: 'beat', interp: 'sinc', end: 0.3, 'fade-out': 0.12, gain: 0.8 });
    expect(soundSamples(withSample)).toEqual(['beat']);
    expect(withSample.master).toEqual(plain.master);
  });

  it('are heard: the sample is in the render, and the render is the same every time', () => {
    const a = renderChannels(sound('sound new s voice=layered preset=door seed=3'), AUDIO_BANK)[0]!;
    const b = renderChannels(sound('sound new s voice=layered preset=door seed=3 sample=beat'), AUDIO_BANK)[0]!;
    const c = renderChannels(sound('sound new s voice=layered preset=door seed=3 sample=beat'), AUDIO_BANK)[0]!;
    expect(Buffer.from(b.buffer).equals(Buffer.from(c.buffer))).toBe(true);
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(false);
    // the master chain of the recipe moves levels about, but the sample is plainly there: the two renders differ by a good part of their level
    const diff = new Float32Array(Math.min(a.length, b.length));
    for (let i = 0; i < diff.length; i++) diff[i] = b[i]! - a[i]!;
    expect(rms(diff, 0, 0.1 * SAMPLE_RATE)).toBeGreaterThan(0.2 * rms(a, 0, 0.1 * SAMPLE_RATE));
  });

  it('work with sound generate too, and give their normal form with the sample', () => {
    const lib = build('sound new s voice=layered preset=door seed=3\nsound generate s footstep seed=5 sample=tone');
    const s = lib.get('s') as LayeredSound;
    expect(s.layers.at(-1)!.p.sample).toBe('tone');
    expect(parse('sound new s voice=layered preset=door sample=beat').commands[0]!.text).toMatch(/^sound new s voice=layered preset=door seed=\d+ sample=beat$/);
    expect(parse('sound generate s door seed=7 sample=beat').commands[0]!.text).toBe('sound generate s door seed=7 sample=beat');
  });

  it('are asked for only with a layered recipe, and name a sample', () => {
    expect(() => build('sound new s voice=layered sample=beat')).toThrow(/layered recipe/);
    expect(() => build('sound new s voice=classic preset=hit sample=beat')).toThrow(/layered recipe/);
    expect(() => build('sound new s voice=layered preset=door sample=a/b')).toThrow(/not a sample name/);
    expect(() => build('sound new s voice=layered preset=door\nsound generate s hit sample=beat')).toThrow(/layered recipe/);
  });

  it('every recipe makes room for it with some seed', () => {
    for (const name of RECIPE_NAMES) {
      const body = recipeBody(name, 1);
      expect(body.layers.length, name).toBeLessThan(8);
    }
  });
});
