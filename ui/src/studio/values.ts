// Values with units: how a knob or slider shows a number, and what typed text it accepts
// ("110ms", "0.11", "18%", "−3dB", "C6", "+5st", "1.8k"). Pure functions, no DOM.

export type Unit = 'plain' | 's' | 'hz' | 'pct' | 'db' | 'st' | 'note';
export interface ValueSpec {
  unit: Unit;
  digits?: number;
  /** A parameter whose stored number is not what a person reads (the classic voice's 0..1 curves): how to show it, what typed text means, and what the entry field starts with. */
  custom?: { show(v: number): string; read(text: string): number | null; entry?(v: number): string; hint?: string };
}

const MINUS = '−';
const NOTE_RE = /^([A-Ga-g])([#b♯♭]?)(-?\d)$/;
const NUM_RE = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*(khz|hz|k|ms|s|%|db|st)?$/i;
const SEMI: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** MIDI note number of a name like C6, F#3, Bb2 (C4 = 60), or null. */
export function noteToMidi(text: string): number | null {
  const m = NOTE_RE.exec(text.trim());
  if (!m) return null;
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0;
  return (Number(m[3]) + 1) * 12 + SEMI[m[1]!.toLowerCase()]! + acc;
}
export const midiToNote = (midi: number): string => `${NOTE_NAMES[((Math.round(midi) % 12) + 12) % 12]}${Math.floor(Math.round(midi) / 12) - 1}`;
export const midiToHz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

/** The number a typed text means for this unit, or null when it is not a value. */
export function parseValue(text: string, spec: ValueSpec): number | null {
  if (spec.custom) return spec.custom.read(text);
  const t = text.trim().replace(/−|–|—/g, '-').replace(/\s+/g, ' ');
  if (!t) return null;
  const note = noteToMidi(t);
  if (note !== null) return spec.unit === 'hz' ? midiToHz(note) : spec.unit === 'note' ? note : null;
  const m = NUM_RE.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const u = (m[2] ?? '').toLowerCase();
  switch (spec.unit) {
    case 's': return u === 'ms' ? n / 1000 : u === '' || u === 's' ? n : null;
    case 'hz': return u === 'k' || u === 'khz' ? n * 1000 : u === '' || u === 'hz' ? n : null;
    case 'pct': return u === '%' ? n / 100 : u === '' ? n : null;
    case 'db': return u === '' || u === 'db' ? n : null;
    case 'st': return u === '' || u === 'st' ? n : null;
    case 'note': return u === '' ? n : null;
    default: return u === '%' ? n / 100 : u === 'k' ? n * 1000 : u === '' ? n : null;
  }
}

const sign = (n: number, s: string): string => (n < 0 ? MINUS : '') + s.replace('-', '');

/** A value as the control shows it. The minus sign is U+2212, as on the boards. */
export function formatValue(v: number, spec: ValueSpec): string {
  if (spec.custom) return spec.custom.show(v);
  const d = spec.digits;
  switch (spec.unit) {
    case 's': return v < 0.1 && v > 0 ? `${sign(v, Math.abs(v * 1000).toFixed(d ?? 0))} ms` : `${sign(v, Math.abs(v).toFixed(d ?? 2))} s`;
    case 'hz': return Math.abs(v) >= 1000 ? `${sign(v, (Math.abs(v) / 1000).toFixed(d ?? 2))} kHz` : `${sign(v, Math.abs(v).toFixed(d ?? 0))} Hz`;
    case 'pct': return `${sign(v, Math.abs(v * 100).toFixed(d ?? 0))}%`;
    case 'db': return Number.isFinite(v) && v > -90 ? `${sign(v, Math.abs(v).toFixed(d ?? 1))} dB` : `${MINUS}∞ dB`;
    case 'st': return `${v < 0 ? MINUS : '+'}${Math.abs(v).toFixed(d ?? 0)} st`;
    case 'note': return midiToNote(v);
    default: return sign(v, Math.abs(v).toFixed(d ?? 2));
  }
}

export const clampTo = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Round a value to the control's step (a step of 0 leaves it). */
export function snap(v: number, step: number, min: number): number {
  if (!step) return v;
  const n = Math.round((v - min) / step);
  const out = min + n * step;
  return Number(out.toFixed(10));
}

/** Where the arc starts and ends (0..1 of the sweep) for a value: from the minimum, or from the centre for bipolar controls. */
export function arcSpan(frac: number, bipolar: boolean): [number, number] {
  return bipolar ? (frac >= 0.5 ? [0.5, frac] : [frac, 0.5]) : [0, frac];
}

/** The sweep's fraction for a value, 0..1. */
export const fracOf = (v: number, min: number, max: number): number => (max === min ? 0 : clampTo((v - min) / (max - min), 0, 1));
