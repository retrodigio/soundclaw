import { Library, applyCommand, parse, renderChannels, type LayeredSound, type SampleBank } from '../src/index.ts';

/** Run command text against a fresh library; throws the first problem. */
export function build(script: string, lib: Library = new Library()): Library {
  const p = parse(script);
  if (p.errors.length) throw new Error(`${p.errors[0]!.line}:${p.errors[0]!.col} ${p.errors[0]!.message}`);
  for (const c of p.commands) applyCommand(lib, c);
  return lib;
}

export const layered = (script: string, id = 's'): LayeredSound => build(script).get(id) as LayeredSound;
export const render = (s: LayeredSound, bank?: SampleBank): Float32Array => renderChannels(s, bank)[0]!;

/** A small deterministic sample bank: a decaying 220 Hz-ish saw and a click, as mono 22,050 Hz data. */
export const BANK: SampleBank = {
  get(name) {
    if (name !== 'thump' && name !== 'tick') return undefined;
    const n = name === 'thump' ? 11025 : 2205;
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) data[i] = Math.sin(i * (name === 'thump' ? 0.03 : 0.2)) * (1 - i / n) * 0.8;
    return { rate: 22050, data };
  },
  hash: (name) => (name === 'thump' || name === 'tick' ? `test-${name}` : undefined),
};

/** Amplitude of the steady part of a sine of `hz` after `fn`, from the peak of the last quarter. */
export function tailPeak(x: Float32Array): number {
  let p = 0;
  for (let i = Math.floor(x.length * 0.75); i < x.length; i++) p = Math.max(p, Math.abs(x[i]!));
  return p;
}
