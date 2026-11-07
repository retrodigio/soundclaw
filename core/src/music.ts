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

export const NOTE_FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/** Is this a black key (a note with a sharp or flat name)? */
export const isBlackKey = (midi: number): boolean => [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);

/** The note as written in the normal form: sharps unless `flat` (`C#5`, `Db5`), octave after. */
export function noteLabel(midi: number, flat = false): string {
  const pc = ((midi % 12) + 12) % 12;
  return `${(flat ? NOTE_FLATS : NOTE_SHARPS)[pc]}${Math.floor(midi / 12) - 1}`;
}

/** Does a note written as a black key take a flat in this key (F major, Bb major, D minor ...) or a sharp? */
export function keyUsesFlats(key: string | null | undefined): boolean {
  if (!key) return false;
  try { return parseKey(key).flats; } catch { return false; }
}

/** Flats for a key: a tonic written with b or # decides; else the first major scale (C, the flat keys, the sharp keys) that holds every note of the scale does. */
function scaleUsesFlats(tonicText: string, classes: readonly number[]): boolean {
  if (tonicText.endsWith('b')) return true;
  if (tonicText.endsWith('#')) return false;
  for (const t of [0, 5, 10, 3, 8, 1, 7, 2, 9, 4, 11]) {
    const major = [0, 2, 4, 5, 7, 9, 11].map((d) => (t + d) % 12);
    if (classes.every((c) => major.includes(c))) return [5, 10, 3, 8, 1].includes(t);
  }
  return false;
}

/** Pitch class name without an octave. */
export const pitchClassName = (midi: number, flat = false): string => (flat ? NOTE_FLATS : NOTE_SHARPS)[((midi % 12) + 12) % 12]!;

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
  // the same scales under their other names
  ionian: [0, 2, 4, 5, 7, 9, 11],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  'natural-minor': [0, 2, 3, 5, 7, 8, 10],
  // more colours, common in games
  'major-blues': [0, 2, 3, 4, 7, 9],
  'whole-tone': [0, 2, 4, 6, 8, 10],
  'phrygian-dominant': [0, 1, 4, 5, 7, 8, 10],
  'hungarian-minor': [0, 2, 3, 6, 7, 8, 11],
  'double-harmonic': [0, 1, 4, 5, 7, 8, 11],
  'harmonic-major': [0, 2, 4, 5, 7, 8, 11],
  'lydian-dominant': [0, 2, 4, 6, 7, 9, 10],
  hirajoshi: [0, 2, 3, 7, 8],
  octatonic: [0, 2, 3, 5, 6, 8, 9, 11],
};

/** What each scale is, in a few words (for `scale list`). */
export const SCALE_NOTES: Readonly<Record<string, string>> = {
  major: 'bright, settled (= ionian)', minor: 'natural minor (= aeolian, natural-minor)', dorian: 'minor with a raised 6th: folk, adventure',
  phrygian: 'minor with a flat 2nd: dark, Spanish', lydian: 'major with a raised 4th: wonder, floating', mixolydian: 'major with a flat 7th: heroic, rock',
  locrian: 'diminished tonic: unstable, eerie', 'harmonic-minor': 'minor with a raised 7th: drama, the dominant leads home', 'melodic-minor': 'minor with a raised 6th and 7th',
  'pentatonic-major': 'five notes, no half steps: open, cheerful', 'pentatonic-minor': 'five notes: bluesy, open', blues: 'minor pentatonic and the flat 5th',
  chromatic: 'all twelve (no key check to speak of)', ionian: 'the major scale', aeolian: 'the natural minor scale', 'natural-minor': 'the natural minor scale',
  'major-blues': 'major pentatonic and the flat 3rd', 'whole-tone': 'whole steps only: dreams, magic, unresolved', 'phrygian-dominant': 'phrygian with a major 3rd: desert, ancient',
  'hungarian-minor': 'harmonic minor with a raised 4th: exotic, villainous', 'double-harmonic': 'two augmented seconds: ornate, mysterious', 'harmonic-major': 'major with a flat 6th: bittersweet',
  'lydian-dominant': 'lydian with a flat 7th: playful, sci-fi', hirajoshi: 'five notes with half steps: East Asian colour', octatonic: 'half and whole steps: tension, horror',
};

export interface Key {
  tonic: number;
  mode: string;
  /** Pitch classes in the scale. */
  classes: readonly number[];
  /** Black keys are spelled with flats in this key (F major, D minor, Eb major ...), else with sharps. */
  flats: boolean;
}

/** `C:major`, `F#:dorian`, `Bb:pentatonic-minor`. Throws a plain Error. */
export function parseKey(s: string): Key {
  const m = /^([A-G][#b]?):([a-z-]+)$/.exec(s);
  if (!m) throw new Error(`a key is <tonic>:<mode> like C:major or A:minor (modes: ${Object.keys(SCALES).join(', ')}), got '${s}'`);
  const mode = SCALES[m[2]!];
  if (!mode) throw new Error(`no mode '${m[2]}' (modes: ${Object.keys(SCALES).join(', ')})`);
  const tonic = parseNote(`${m[1]}4`)! % 12;
  const classes = mode.map((d) => (tonic + d) % 12);
  return { tonic, mode: m[2]!, classes, flats: scaleUsesFlats(m[1]!, classes) };
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
