// The conformance table: patches that together touch every parameter at both extremes, every wave,
// and several seeds. Names say what is being exercised; the expected hashes live in
// classic-golden.json (regenerate with UPDATE_GOLDEN=1, and say why in the commit).

import { CLASSIC_FIELDS, makePatch, type ClassicPatch } from '../src/classic.ts';

export interface TablePatch {
  name: string;
  /** Values by parameter name (the rest take the defaults). */
  values: Record<string, number | string>;
}

/** A short, audible base so every case renders quickly. */
const BASE = { sustain: 0.12, decay: 0.15, freq: 0.35, volume: 0.6 };

export const TABLE: TablePatch[] = [];

for (const f of CLASSIC_FIELDS) {
  const longStage = f.name === 'sustain' || f.name === 'decay' || f.name === 'attack';
  const base = f.name === 'minFreq' ? { ...BASE, slide: -0.3 } : { ...BASE };
  for (const [label, v] of [['min', f.min], ['max', f.max]] as const) {
    if (f.name === 'wave') continue;
    const values: Record<string, number | string> = { ...base, [f.name]: v };
    // The longest stages are shortened elsewhere so the extreme itself is the only long thing.
    if (longStage && v === f.max) for (const k of ['sustain', 'decay', 'attack']) if (k !== f.name) values[k] = 0.02;
    TABLE.push({ name: `${f.name}-${label}`, values });
  }
}

for (const [i, w] of ['square', 'saw', 'sine', 'noise'].entries()) {
  TABLE.push({ name: `wave-${w}`, values: { ...BASE, wave: i, vibratoDepth: 0.4, vibratoSpeed: 0.5 } });
  TABLE.push({ name: `wave-${w}-filtered`, values: { ...BASE, wave: i, lowPass: 0.5, resonance: 0.7, highPass: 0.2, phaserOffset: 0.3, phaserSweep: -0.2 } });
}
TABLE.push({ name: 'wave-by-name', values: { ...BASE, wave: 'sine', freq: 0.5 } });

for (const seed of [0, 1, 12345, 4294967295, -7, 2.5]) {
  TABLE.push({ name: `noise-seed-${seed}`, values: { ...BASE, wave: 3, freq: 0.45, seed } });
}
TABLE.push({ name: 'noise-default-seed', values: { ...BASE, wave: 3, freq: 0.45 } });
TABLE.push({ name: 'square-seed-ignored', values: { ...BASE, seed: 99 } });

TABLE.push({
  name: 'laser-like',
  values: { wave: 1, sustain: 0.1, punch: 0.4, decay: 0.2, freq: 0.7, minFreq: 0.2, slide: 0.35, deltaSlide: -0.1, duty: 0.3, dutySweep: 0.2, volume: 0.5 },
});
TABLE.push({
  name: 'explosion-like',
  values: { wave: 3, sustain: 0.25, punch: 0.6, decay: 0.45, freq: 0.12, slide: -0.2, deltaSlide: 0.05, repeatSpeed: 0.7, lowPass: 0.4, volume: 0.5 },
});
TABLE.push({
  name: 'pickup-like',
  values: { wave: 0, attack: 0.02, sustain: 0.04, punch: 0.5, decay: 0.2, freq: 0.5, changeSpeed: 0.55, changeAmount: 0.4, duty: 0.5, volume: 0.5 },
});
TABLE.push({ name: 'change-down', values: { ...BASE, changeSpeed: 0.2, changeAmount: -0.6 } });
TABLE.push({ name: 'phaser-negative-offset', values: { ...BASE, wave: 1, phaserOffset: -0.8, phaserSweep: 0.4 } });
TABLE.push({ name: 'vibrato-delayed', values: { ...BASE, wave: 2, vibratoDelay: 0.5, vibratoDepth: -0.7, vibratoSpeed: 0.8 } });
TABLE.push({ name: 'out-of-range-clamped', values: { ...BASE, sustain: -4, decay: 9, freq: 3, volume: 2, punch: -1 } });

export function tablePatch(t: TablePatch): ClassicPatch {
  return makePatch(t.values);
}
