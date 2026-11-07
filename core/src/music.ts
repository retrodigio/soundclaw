// Notes and scales: names, MIDI numbers, frequencies. No platform maths (the frequency uses exp2, bits and a series).

import { exp2 } from './mathx.ts';

export const NOTE_SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** The lowest and highest MIDI notes (C-1 and G9). */
export const MIDI_LOW = 0;
export const MIDI_HIGH = 127;

/** `C5`, `C#5`, `Db5`, `C-1`: the MIDI number (C4 = 60), or null. */
export function parseNote(s: string): number | null {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(s);
  if (!m) return null;
  const n = (Number(m[3]) + 1) * 12 + LETTER[m[1]!]! + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return n < MIDI_LOW || n > MIDI_HIGH ? null : n;
}

/** The note as written in the normal form: sharps, octave after (`C#5`). */
export function noteLabel(midi: number): string {
  return `${NOTE_SHARPS[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/** Pitch class name without an octave. */
export const pitchClassName = (midi: number): string => NOTE_SHARPS[((midi % 12) + 12) % 12]!;

/** Equal temperament, A4 = 440 Hz, in + - * / and exp2 only. */
export function midiFreq(midi: number): number {
  return 440 * exp2((midi - 69) / 12);
}

export const SCALES: Readonly<Record<string, readonly number[]>> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  'harmonic-minor': [0, 2, 3, 5, 7, 8, 11],
  'melodic-minor': [0, 2, 3, 5, 7, 9, 11],
  'pentatonic-major': [0, 2, 4, 7, 9],
  'pentatonic-minor': [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export interface Key {
  tonic: number;
  mode: string;
  /** Pitch classes in the scale. */
  classes: readonly number[];
}

/** `C:major`, `F#:dorian`, `Bb:pentatonic-minor`. Throws a plain Error. */
export function parseKey(s: string): Key {
  const m = /^([A-G][#b]?):([a-z-]+)$/.exec(s);
  if (!m) throw new Error(`a key is <tonic>:<mode> like C:major or A:minor (modes: ${Object.keys(SCALES).join(', ')}), got '${s}'`);
  const mode = SCALES[m[2]!];
  if (!mode) throw new Error(`no mode '${m[2]}' (modes: ${Object.keys(SCALES).join(', ')})`);
  const tonic = parseNote(`${m[1]}4`)! % 12;
  return { tonic, mode: m[2]!, classes: mode.map((d) => (tonic + d) % 12) };
}

export const inKey = (k: Key, midi: number): boolean => k.classes.includes(((midi % 12) + 12) % 12);

/** `C3-C6` as two MIDI numbers, or null. */
export function parseRange(s: string): [number, number] | null {
  const m = /^([A-G][#b]?-?\d)-([A-G][#b]?-?\d)$/.exec(s);
  if (!m) return null;
  const a = parseNote(m[1]!);
  const b = parseNote(m[2]!);
  return a === null || b === null || a > b ? null : [a, b];
}
