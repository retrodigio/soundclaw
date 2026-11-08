// How the classic voice's parameters read in units. The stored numbers are sfxr's 0..1 curves; a
// knob shows what they mean (seconds, Hz, %, dB, semitones) using the formulas the parameters'
// help text gives, and typed text in those units is turned back into the stored number. The
// stored number is what a command writes, rounded to three decimals as every slider does.

import { classicField, type ClassicKey } from '@soundclaw/core';
import { formatValue, midiToHz, noteToMidi, parseValue, type ValueSpec } from '../studio/values.ts';

const RATE = 44100;
const MINUS = '−';
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Seconds of a length parameter (a² · 10⁵ samples), and back. */
export const lengthSeconds = (v: number): number => (v * v * 1e5) / RATE;
export const lengthParam = (s: number): number => Math.sqrt(Math.max(0, (s * RATE) / 1e5));
/** Hz of a frequency parameter (period 100 / (f² + 0.001) supersamples, eight to a sample), and back. */
export const freqHz = (v: number): number => (RATE * 8 * (v * v + 0.001)) / 100;
export const freqParam = (hz: number): number => Math.sqrt(Math.max(0, (hz * 100) / (RATE * 8) - 0.001));
/** The pitch jump of `changeAmount` in semitones (the period × 1 − a²·0.9 for a ≥ 0, × 1 + a²·10 for a < 0). */
export const changeSemitones = (a: number): number => -12 * Math.log2(a >= 0 ? 1 - a * a * 0.9 : 1 + a * a * 10);
/** The seconds between repeats / the pitch change for a speed parameter ((1 − v)² · 20000 + 32 samples). */
export const speedSeconds = (v: number): number => ((1 - v) * (1 - v) * 20000 + 32) / RATE;

const secs = (v: number): string => (v < 0.1 ? `${(v * 1000).toFixed(v < 0.01 ? 1 : 0)} ms` : `${v.toFixed(2)} s`);
const sgn = (n: number, body: string): string => (n < 0 ? MINUS : '') + body;
const hzText = (hz: number): string => (hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${hz.toFixed(0)} Hz`);

function readSeconds(text: string): number | null {
  const v = parseValue(text, { unit: 's' });
  return v;
}

const lengthSpec: ValueSpec = {
  unit: 's',
  custom: {
    show: (v) => secs(lengthSeconds(v)),
    read: (t) => { const s = readSeconds(t); return s === null ? null : lengthParam(s); },
    entry: (v) => lengthSeconds(v).toFixed(3),
    hint: 'e.g. 110ms or 0.11',
  },
};

const pct = (digits = 0): ValueSpec => ({ unit: 'pct', digits });

const specs: Partial<Record<ClassicKey, ValueSpec>> = {
  attack: lengthSpec, sustain: lengthSpec, decay: lengthSpec,
  punch: pct(),
  freq: {
    unit: 'hz',
    custom: {
      show: (v) => hzText(freqHz(v)),
      read: (t) => { const n = noteToMidi(t.trim()); if (n !== null) return freqParam(midiToHz(n)); const hz = parseValue(t, { unit: 'hz' }); return hz === null ? null : freqParam(hz); },
      entry: (v) => freqHz(v).toFixed(0),
      hint: 'e.g. 880, 1.8k or C6',
    },
  },
  minFreq: {
    unit: 'hz',
    custom: {
      show: (v) => (v <= 0 ? 'off' : hzText(freqHz(v))),
      read: (t) => { if (/^off$/i.test(t.trim())) return 0; const n = noteToMidi(t.trim()); if (n !== null) return freqParam(midiToHz(n)); const hz = parseValue(t, { unit: 'hz' }); return hz === null ? null : freqParam(hz); },
      entry: (v) => (v <= 0 ? 'off' : freqHz(v).toFixed(0)),
      hint: 'off, or e.g. 220 or A3',
    },
  },
  changeAmount: {
    unit: 'st',
    custom: {
      show: (v) => (v === 0 ? '0 st' : `${changeSemitones(v) < 0 ? MINUS : '+'}${Math.abs(changeSemitones(v)).toFixed(1)} st`),
      read: (t) => {
        const st = parseValue(t, { unit: 'st' });
        if (st === null) return null;
        // invert: a ≥ 0 gives 2^(−st/12) = 1 − a²·0.9 (st > 0 up), a < 0 gives 1 + a²·10
        const ratio = 2 ** (-st / 12);
        return clamp(ratio <= 1 ? Math.sqrt((1 - ratio) / 0.9) : -Math.sqrt((ratio - 1) / 10), -1, 1);
      },
      entry: (v) => changeSemitones(v).toFixed(1),
      hint: 'e.g. +5st or −7st',
    },
  },
  changeSpeed: {
    unit: 's',
    custom: {
      show: (v) => (v >= 1 ? 'never' : secs(speedSeconds(v))),
      read: (t) => { if (/^never$/i.test(t.trim())) return 1; const s = readSeconds(t); return s === null ? null : clamp(1 - Math.sqrt(Math.max(0, (s * RATE - 32) / 20000)), 0, 1); },
      entry: (v) => (v >= 1 ? 'never' : speedSeconds(v).toFixed(3)),
      hint: 'never, or e.g. 60ms',
    },
  },
  repeatSpeed: {
    unit: 's',
    custom: {
      show: (v) => (v <= 0 ? 'off' : secs(speedSeconds(v))),
      read: (t) => { if (/^off$/i.test(t.trim())) return 0; const s = readSeconds(t); return s === null ? null : clamp(1 - Math.sqrt(Math.max(0, (s * RATE - 32) / 20000)), 0, 1); },
      entry: (v) => (v <= 0 ? 'off' : speedSeconds(v).toFixed(3)),
      hint: 'off, or e.g. 90ms',
    },
  },
  vibratoDepth: pct(),
  vibratoDelay: pct(),
  duty: pct(),
  resonance: pct(),
  lowPass: {
    unit: 'plain',
    custom: {
      show: (v) => (v >= 1 ? 'open' : `${Math.round(v * 100)}%`),
      read: (t) => { if (/^open$/i.test(t.trim())) return 1; const p = parseValue(t, { unit: 'pct' }); return p === null ? null : p; },
      entry: (v) => (v >= 1 ? 'open' : String(Math.round(v * 100))),
      hint: 'open, or e.g. 40%',
    },
  },
  highPass: {
    unit: 'plain',
    custom: {
      show: (v) => (v <= 0 ? 'off' : `${Math.round(v * 100)}%`),
      read: (t) => { if (/^off$/i.test(t.trim())) return 0; const p = parseValue(t, { unit: 'pct' }); return p === null ? null : p; },
      entry: (v) => (v <= 0 ? 'off' : String(Math.round(v * 100))),
      hint: 'off, or e.g. 12%',
    },
  },
  volume: {
    unit: 'db',
    custom: {
      show: (v) => (v <= 0 ? `${MINUS}∞ dB` : `${sgn(20 * Math.log10(v), Math.abs(20 * Math.log10(v)).toFixed(1))} dB`),
      read: (t) => { const d = parseValue(t, { unit: 'db' }); return d === null ? null : 10 ** (d / 20); },
      entry: (v) => (v <= 0 ? '-60' : (20 * Math.log10(v)).toFixed(1)),
      hint: 'e.g. −6dB',
    },
  },
};

/** How a parameter reads: the plain two-digit number unless it has units. */
export function classicSpec(name: ClassicKey): ValueSpec {
  return specs[name] ?? { unit: 'plain', digits: 2 };
}

/** A short label for a knob. */
export const CLASSIC_LABEL: Record<ClassicKey, string> = {
  wave: 'Wave', attack: 'Attack', sustain: 'Sustain', punch: 'Punch', decay: 'Decay', freq: 'Start', minFreq: 'Floor', slide: 'Slide', deltaSlide: 'Δ slide',
  vibratoDelay: 'Delay', vibratoDepth: 'Depth', vibratoSpeed: 'Rate', changeAmount: 'Arp step', changeSpeed: 'Arp time', duty: 'Duty', dutySweep: 'Duty sweep',
  repeatSpeed: 'Repeat', phaserOffset: 'Phase', phaserSweep: 'Ph sweep', lowPass: 'LP cutoff', lowPassSweep: 'LP sweep', resonance: 'Reso', highPass: 'HP cutoff', highPassSweep: 'HP sweep', volume: 'Volume',
};

export interface ClassicModule { id: number; name: string; note: string; params: ClassicKey[]; /** Parameters that do not make the module "on" when changed. */ passive?: ClassicKey[]; alwaysOn?: boolean }

/** The seven modules in signal order. */
export const CLASSIC_MODULES: ClassicModule[] = [
  { id: 1, name: 'Envelope', note: 'attack · sustain · punch · decay', params: ['attack', 'sustain', 'punch', 'decay'], alwaysOn: true },
  { id: 2, name: 'Pitch', note: 'start · floor · arp', params: ['freq', 'minFreq', 'changeAmount', 'changeSpeed'], alwaysOn: true },
  { id: 3, name: 'Slide', note: 'bipolar', params: ['slide', 'deltaSlide'] },
  { id: 4, name: 'Vibrato', note: 'depth · rate · delay', params: ['vibratoDepth', 'vibratoSpeed', 'vibratoDelay'] },
  { id: 5, name: 'Tone', note: 'wave · duty', params: ['wave', 'duty', 'dutySweep'], alwaysOn: true },
  { id: 6, name: 'Repeat + phaser', note: 'repeat · phase', params: ['repeatSpeed', 'phaserOffset', 'phaserSweep'] },
  { id: 7, name: 'Filters + output', note: 'low · high · volume', params: ['lowPass', 'lowPassSweep', 'resonance', 'highPass', 'highPassSweep', 'volume'], passive: ['volume'] },
];

/** A module is "off" when every parameter that makes it do something is at its default (the vibrato's rate and delay do nothing without depth). */
export function moduleOff(m: ClassicModule, patch: Record<string, number>): boolean {
  if (m.alwaysOn) return false;
  const params = m.id === 4 ? (['vibratoDepth'] as ClassicKey[]) : m.params.filter((p) => !m.passive?.includes(p));
  return params.every((p) => patch[p] === classicField(p)!.default);
}

/** The module a failing check most likely comes from (documented rule): a click or a harsh sound lives in the filters, a long tail in the envelope. */
export const CHECK_MODULE: Record<string, number> = { click: 7, harsh: 7, tail: 1 };

export const isBipolar = (name: ClassicKey): boolean => (classicField(name)?.min ?? 0) < 0;

export { formatValue };
