// Music theory for the composition helpers: scale degrees, chords by roman numeral, voicings with
// smooth voice leading, and a seeded random stream. Whole numbers and table lookups only, so the
// helpers write the same notes on every machine.
//
// A roman numeral names a degree of the song's scale; its case gives the quality (I major, i minor),
// and the rest is written after it:
//   ° or o   diminished        ø   half-diminished (a seventh)     +   augmented
//   7        a seventh: minor seventh on a major or minor triad (V7 is a dominant seventh), ° gives °7
//   maj7     a major seventh    sus2 sus4   the third replaced      add9   a ninth on top
//   6 64     first and second inversion of a triad     65 43 42   inversions of a seventh chord
//   b #      before the numeral: a borrowed root a half step down or up (bVII, bVI, #iv°)
//   /V       a secondary chord: V/V is the dominant of the dominant, vii°7/ii the leading-tone chord of ii
//   :2       after the chord: its own length in bars (:0.5 for half a bar)

import { SCALES, noteLabel, pitchClassName, type Key } from './music.ts';

const MAJOR = SCALES.major!;
const MINOR = SCALES.minor!;
const NUMERALS = ['vii', 'vi', 'v', 'iv', 'iii', 'ii', 'i'] as const;
const DEGREE: Record<string, number> = { i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6 };

/** The scale's steps above the tonic (the mode's table). */
export const scaleOffsets = (key: Key): readonly number[] => SCALES[key.mode]!;

/** The seven steps roman numerals count in: the scale itself when it has seven notes, else major (when it has a major third) or natural minor. */
export function heptatonic(key: Key): readonly number[] {
  const s = scaleOffsets(key);
  if (s.length === 7) return s;
  return s.includes(4) ? MAJOR : MINOR;
}

// ---- scale degrees --------------------------------------------------------------------------------------------------

/** A note as a scale degree (counted from the tonic in octave -1, so it is never negative for MIDI notes) and the semitones it sits above that degree (0 for a note in the scale). */
export function degreeOf(key: Key, midi: number): { deg: number; off: number } {
  const s = scaleOffsets(key);
  const rel = midi - key.tonic;
  const oct = Math.floor(rel / 12);
  const r = rel - oct * 12;
  let idx = 0;
  for (let i = 0; i < s.length; i++) if (s[i]! <= r) idx = i;
  return { deg: oct * s.length + idx, off: r - s[idx]! };
}

/** The note at a scale degree (as degreeOf counts), raised by `off` semitones. */
export function fromDegree(key: Key, deg: number, off = 0): number {
  const s = scaleOffsets(key);
  const oct = Math.floor(deg / s.length);
  return key.tonic + oct * 12 + s[deg - oct * s.length]! + off;
}

/** Move a note by scale steps; a note outside the scale keeps its distance from the degree under it. */
export const stepInScale = (key: Key, midi: number, steps: number): number => {
  const d = degreeOf(key, midi);
  return fromDegree(key, d.deg + steps, d.off);
};

/** The note of a 1-based degree (1 the tonic, 8 the octave, 0 the 7th below) in an octave: degree 1 of octave 4 in C is C4. */
export function degreeNote(key: Key, degree: number, octave: number): number {
  const s = scaleOffsets(key);
  const base = (octave + 1) * 12 + key.tonic;
  const d = degree - 1;
  const oct = Math.floor(d / s.length);
  return base + oct * 12 + s[d - oct * s.length]!;
}

// ---- chords ---------------------------------------------------------------------------------------------------------

export interface ChordSym {
  /** As written. */
  text: string;
  /** The root's pitch class. */
  root: number;
  /** Semitones above the root, root first: [0, 4, 7], [0, 4, 7, 10] ... */
  tones: number[];
  /** Which chord tone is in the bass (0 root, 1 third, 2 fifth, 3 seventh), or null when free. */
  inversion: number | null;
  /** The chord's own length in bars (`:2`), or null. */
  bars: number | null;
  /** The numeral's degree (0 = I), for moving a motif along a progression. */
  degree: number;
}

function numeral(s: string, at: number): { acc: number; deg: number; upper: boolean; len: number } | null {
  let k = at;
  let acc = 0;
  if (s[k] === 'b') { acc = -1; k++; } else if (s[k] === '#') { acc = 1; k++; }
  const rest = s.slice(k);
  for (const n of NUMERALS) {
    if (rest.startsWith(n)) return { acc, deg: DEGREE[n]!, upper: false, len: k - at + n.length };
    if (rest.startsWith(n.toUpperCase())) return { acc, deg: DEGREE[n]!, upper: true, len: k - at + n.length };
  }
  return null;
}

/** One chord of a progression. Throws a plain Error naming what is wrong. */
export function parseChord(text: string, key: Key): ChordSym {
  const bad = (why: string): never => { throw new Error(`'${text}': ${why} (chords are roman numerals like I, vi, V7, ii65, bVII, V/V, IVmaj7, Vsus4, vii°7; see docs/commands.md)`); };
  let s = text;
  let bars: number | null = null;
  const colon = s.indexOf(':');
  if (colon >= 0) {
    const b = s.slice(colon + 1);
    if (!/^(\d+(\.\d+)?|\.\d+)$/.test(b) || Number(b) <= 0 || Number(b) > 64) bad('the length after : is a number of bars above 0, like :2 or :0.5');
    bars = Number(b);
    s = s.slice(0, colon);
  }
  let target: string | null = null;
  const slash = s.indexOf('/');
  if (slash >= 0) { target = s.slice(slash + 1); s = s.slice(0, slash); }
  const n = numeral(s, 0);
  if (!n) return bad('it does not start with a roman numeral');
  let k = n.len;
  let quality: 'maj' | 'min' | 'dim' | 'half' | 'aug' = n.upper ? 'maj' : 'min';
  const take = (w: string): boolean => (s.startsWith(w, k) ? ((k += w.length), true) : false);
  if (take('°') || take('o') || take('dim')) quality = 'dim';
  else if (take('ø')) quality = 'half';
  else if (take('+') || take('aug')) quality = 'aug';
  let seventh: 'none' | 'minor' | 'major' = quality === 'half' ? 'minor' : 'none';
  let sus: 2 | 4 | null = null;
  let add9 = false;
  let inversion: number | null = null;
  while (k < s.length) {
    if (take('maj7')) seventh = 'major';
    else if (take('sus2')) sus = 2;
    else if (take('sus4')) sus = 4;
    else if (take('add9')) add9 = true;
    else if (take('64')) inversion = 2;
    else if (take('65')) { inversion = 1; if (seventh === 'none') seventh = 'minor'; }
    else if (take('43')) { inversion = 2; if (seventh === 'none') seventh = 'minor'; }
    else if (take('42')) { inversion = 3; if (seventh === 'none') seventh = 'minor'; }
    else if (take('7')) { if (seventh === 'none') seventh = 'minor'; }
    else if (take('6')) inversion = 1;
    else bad(`'${s.slice(k)}' is not a chord suffix`);
  }
  const third = sus === 4 ? 5 : sus === 2 ? 2 : quality === 'maj' || quality === 'aug' ? 4 : 3;
  const fifth = quality === 'dim' || quality === 'half' ? 6 : quality === 'aug' ? 8 : 7;
  const tones = [0, third, fifth];
  if (seventh !== 'none') tones.push(seventh === 'major' ? 11 : quality === 'dim' ? 9 : 10);
  if (add9) tones.push(14);
  if (inversion !== null && inversion >= tones.length) bad('that inversion needs a seventh');
  if (inversion === 3 && tones.length < 4) bad('42 is the third inversion of a seventh chord');
  const steps = heptatonic(key);
  let root: number;
  if (target !== null) {
    const t = numeral(target, 0);
    if (!t || t.len !== target.length) return bad(`'/${target}' is not a roman numeral to be secondary to`);
    const tRoot = key.tonic + steps[t.deg]! + t.acc;
    root = tRoot + MAJOR[n.deg]! + n.acc;
  } else root = key.tonic + steps[n.deg]! + n.acc;
  return { text, root: ((root % 12) + 12) % 12, tones, inversion, bars, degree: n.deg };
}

/** A progression: chords separated by spaces (`|` between bars is allowed and ignored). */
export function parseProgression(text: string, key: Key): ChordSym[] {
  const words = text.split(/\s+/).filter((w) => w && w !== '|');
  if (!words.length) throw new Error('the progression is empty: give roman numerals like "I V vi IV"');
  if (words.length > 64) throw new Error('a progression has at most 64 chords');
  return words.map((w) => parseChord(w, key));
}

/** The chord's pitch classes, root first. */
export const chordClasses = (c: Pick<ChordSym, 'root' | 'tones'>): number[] => c.tones.map((t) => (c.root + t) % 12);

const QUALITY_NAMES: [string, string][] = [
  ['0,4,7', ''], ['0,3,7', 'm'], ['0,3,6', 'dim'], ['0,4,8', 'aug'], ['0,4,7,10', '7'], ['0,4,7,11', 'maj7'], ['0,3,7,10', 'm7'], ['0,3,7,11', 'm(maj7)'],
  ['0,3,6,9', 'dim7'], ['0,3,6,10', 'm7b5'], ['0,2,7', 'sus2'], ['0,5,7', 'sus4'], ['0,5,7,10', '7sus4'], ['0,4,8,10', 'aug7'], ['0,4,7,14', 'add9'], ['0,3,7,14', 'm(add9)'],
];

/** A chord's name as letters: D, Bm, C#dim, A7, Gmaj7, F#m7b5, Esus4. */
export function chordName(c: Pick<ChordSym, 'root' | 'tones'>): string {
  const q = QUALITY_NAMES.find(([k]) => k === c.tones.join(','));
  return `${pitchClassName(c.root)}${q ? q[1] : `(${c.tones.join(',')})`}`;
}

/** The chord a set of notes spells: the root and tones of a known shape (the lowest note preferred as the root), else the lowest note and its intervals. */
export function chordOfNotes(notes: readonly number[]): Pick<ChordSym, 'root' | 'tones'> {
  const sorted = [...notes].sort((a, b) => a - b);
  const pcs = [...new Set(sorted.map((n) => n % 12))];
  const lowest = sorted[0]! % 12;
  const order = [lowest, ...pcs.filter((p) => p !== lowest)];
  for (const r of order) {
    const rel = [...new Set(pcs.map((p) => (p - r + 12) % 12))].sort((a, b) => a - b).join(',');
    const hit = QUALITY_NAMES.find(([k]) => k.split(',').map((x) => Number(x) % 12).sort((a, b) => a - b).join(',') === rel);
    if (hit) return { root: r, tones: hit[0].split(',').map(Number) };
  }
  return { root: lowest, tones: [...new Set(pcs.map((p) => (p - lowest + 12) % 12))].sort((a, b) => a - b) };
}

/** The triads (and sevenths) built on each degree of a seven-note scale, with their numerals. */
export function diatonicChords(key: Key): { numeral: string; triad: number[]; seventh: number[] }[] {
  const s = scaleOffsets(key);
  if (s.length !== 7) return [];
  const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
  return s.map((_, i) => {
    const at = (k: number): number => { const j = i + k; return s[j % 7]! + (j >= 7 ? 12 : 0) - s[i]!; };
    const triad = [0, at(2), at(4)];
    const seventh = [...triad, at(6)];
    const q = triad.join(',');
    const name = q === '0,4,7' ? roman[i]! : q === '0,3,7' ? roman[i]!.toLowerCase() : q === '0,3,6' ? `${roman[i]!.toLowerCase()}°` : q === '0,4,8' ? `${roman[i]}+` : `${roman[i]}?`;
    return { numeral: name, triad: triad.map((t) => (key.tonic + s[i]! + t) % 12), seventh: seventh.map((t) => (key.tonic + s[i]! + t) % 12) };
  });
}

// ---- voicing --------------------------------------------------------------------------------------------------------

/** Pairs of voices moving in parallel fifths or octaves (unisons) from one voicing to the next, both moving the same way. */
export function parallelPairs(a: readonly number[], b: readonly number[]): [number, number, 'fifths' | 'octaves'][] {
  const out: [number, number, 'fifths' | 'octaves'][] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const da = b[i]! - a[i]!, db = b[j]! - a[j]!;
    if (da === 0 || db === 0 || Math.sign(da) !== Math.sign(db)) continue;
    const x = Math.abs(a[j]! - a[i]!) % 12, y = Math.abs(b[j]! - b[i]!) % 12;
    if (x === y && (x === 7 || x === 0)) out.push([i, j, x === 7 ? 'fifths' : 'octaves']);
  }
  return out;
}

/**
 * The voicing of a chord: `n` different notes inside `range` that sound every chord tone. The first
 * chord is close and in root position (unless an inversion is asked for) near the middle of the
 * range; each later chord takes the voicing that moves the voices least from the one before
 * (sorted voice to sorted voice), avoiding parallel fifths and octaves and doubled thirds.
 */
export function voiceChord(prev: readonly number[] | null, chord: Pick<ChordSym, 'root' | 'tones' | 'inversion'>, n: number, range: readonly [number, number]): number[] {
  const pcs = chordClasses(chord);
  const want = [...new Set(pcs)];
  if (n < want.length) throw new Error(`voices=${n} cannot hold ${want.length} chord tones`);
  const [lo, hi] = range;
  const pool: number[] = [];
  for (let m = lo; m <= hi; m++) if (want.includes(m % 12)) pool.push(m);
  const bassPc = chord.inversion === null ? null : pcs[chord.inversion]!;
  const centre = (lo + hi) / 2;
  let best: number[] | null = null;
  let bestCost = Infinity;
  const pick: number[] = [];
  const consider = (): void => {
    const covered = new Set(pick.map((m) => m % 12));
    if (covered.size !== want.length) return;
    if (bassPc !== null && pick[0]! % 12 !== bassPc) return;
    const span = pick[n - 1]! - pick[0]!;
    if (span > 24) return;
    // doubling: the root is best, the fifth fine, the third or a seventh worst
    let doubled = 0;
    const count = new Map<number, number>();
    for (const m of pick) count.set(m % 12, (count.get(m % 12) ?? 0) + 1);
    for (const [pc, c] of count) if (c > 1) { const i = pcs.indexOf(pc); doubled += (c - 1) * (i === 0 ? 0 : i === 2 ? 1 / 3 : i === 1 ? 1 : 4 / 3); }
    const mean = pick.reduce((a, b) => a + b, 0) / n;
    let cost: number;
    if (!prev) cost = span + (bassPc === null && pick[0]! % 12 !== chord.root ? 6 : 0) + 0.5 * Math.abs(mean - centre) + 3 * doubled;
    else {
      let motion = 0;
      for (let i = 0; i < n; i++) motion += Math.abs(pick[i]! - (prev[Math.min(i, prev.length - 1)] ?? pick[i]!));
      cost = motion + 10 * parallelPairs(prev, pick).length + 3 * doubled + 0.25 * span + 0.1 * Math.abs(mean - centre);
    }
    if (cost < bestCost - 1e-9) { bestCost = cost; best = [...pick]; }
  };
  const walk = (from: number): void => {
    if (pick.length === n) { consider(); return; }
    for (let k = from; k <= pool.length - (n - pick.length); k++) { pick.push(pool[k]!); walk(k + 1); pick.pop(); }
  };
  walk(0);
  if (!best) throw new Error(`no voicing of ${chordName(chord)} in ${noteLabel(lo)}-${noteLabel(hi)} with ${n} voices${bassPc !== null ? ` and ${pitchClassName(bassPc)} in the bass` : ''}: widen range=`);
  return best;
}

// ---- seeded randomness ----------------------------------------------------------------------------------------------

/** A seeded stream of numbers in [0, 1) (mulberry32: 32-bit integer steps only). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A number in [-1, 1], most often near 0 (the mean of two draws). */
export const triangular = (r: () => number): number => r() + r() - 1;
