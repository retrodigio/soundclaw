// The key-map's arithmetic: which keys the grid shows, where a key and a velocity sit, what dragging an edge of a zone means, what dropping a sample on
// a key writes, the computer keyboard's notes and a MIDI message's meaning. Pure functions; the page draws and runs the commands.

import { noteLabel, type Zone } from '@soundclaw/core';

export interface Geometry {
  /** The lowest and highest key shown (MIDI). */
  a: number;
  b: number;
  width: number;
  height: number;
  left: number;
  top: number;
  /** Width of one key, and the height of the velocity axis (1..127). */
  keyW: number;
  gridH: number;
}

export const MIN_KEYS = 36;

/** The keys the grid shows: every key a zone covers and the declared range, padded to at least three octaves, never outside 0..127. */
export function keyRange(zones: readonly Pick<Zone, 'keys' | 'hit'>[], range: readonly [number, number] | null): [number, number] {
  const ks = zones.filter((z) => z.hit === null);
  let lo = Math.min(...ks.map((z) => z.keys[0]), range?.[0] ?? 127);
  let hi = Math.max(...ks.map((z) => z.keys[1]), range?.[1] ?? 0);
  if (!ks.length && !range) { lo = 48; hi = 84; }
  if (lo > hi) [lo, hi] = [hi, lo];
  // whole octaves at the ends read better
  lo = Math.max(0, Math.floor(lo / 12) * 12);
  hi = Math.min(127, Math.ceil((hi + 1) / 12) * 12 - 1);
  while (hi - lo + 1 < MIN_KEYS) {
    if (lo > 0) lo = Math.max(0, lo - 12);
    if (hi - lo + 1 < MIN_KEYS && hi < 127) hi = Math.min(127, hi + 12);
    if (lo === 0 && hi === 127) break;
  }
  return [lo, hi];
}

export function geometry(a: number, b: number, width = 1000, height = 350): Geometry {
  const left = 40, top = 14, right = 10, bottom = 46;
  return { a, b, width, height, left, top, keyW: (width - left - right) / (b - a + 1), gridH: height - top - bottom };
}

export const xOfKey = (g: Geometry, m: number): number => g.left + (m - g.a) * g.keyW;
export const keyAtX = (g: Geometry, x: number): number => Math.max(g.a, Math.min(g.b, g.a + Math.floor((x - g.left) / g.keyW)));
/** Velocity 1..127 up the axis: 127 is the top edge of the grid. */
export const yOfVel = (g: Geometry, v: number): number => g.top + g.gridH - (v / 128) * g.gridH;
export const velAtY = (g: Geometry, y: number): number => Math.max(1, Math.min(127, Math.round(((g.top + g.gridH - y) / g.gridH) * 128)));

/** The grid line nearest x, as the key whose left side it is (a zone's right edge sits on the line after its last key). */
export const boundaryAtX = (g: Geometry, x: number): number => Math.max(g.a, Math.min(g.b + 1, Math.round((x - g.left) / g.keyW) + g.a));

export type Edge = 'left' | 'right' | 'top' | 'bottom';
export interface Span { keys: [number, number]; vel: [number, number] }

/** The new keys and velocities of a zone whose edge is let go at (x, y) on the grid. A velocity v fills the band from yOfVel(v-1) up to yOfVel(v). */
export function dragTo(g: Geometry, z: Span, edge: Edge, x: number, y: number): Span {
  const line = boundaryAtX(g, x);
  if (edge === 'left') return moveEdge(z, 'left', line, 0);
  if (edge === 'right') return moveEdge(z, 'right', line - 1, 0);
  if (edge === 'top') return moveEdge(z, 'top', 0, velAtY(g, y));
  return moveEdge(z, 'bottom', 0, velAtY(g, y) + 1);
}

/** A zone's keys and velocities with one edge moved to a key or velocity: the edge stops at the other (a zone is at least one key and one velocity), and at the ends. */
export function moveEdge(z: Span, edge: Edge, key: number, vel: number): Span {
  const keys: [number, number] = [z.keys[0], z.keys[1]];
  const v: [number, number] = [z.vel[0], z.vel[1]];
  if (edge === 'left') keys[0] = Math.max(0, Math.min(keys[1], key));
  else if (edge === 'right') keys[1] = Math.min(127, Math.max(keys[0], key));
  else if (edge === 'top') v[1] = Math.min(127, Math.max(v[0], vel));
  else v[0] = Math.max(1, Math.min(v[1], vel));
  return { keys, vel: v };
}

/** The key range in the command's words: one note, or lo-hi. */
export const keysText = (k: readonly [number, number]): string => (k[0] === k[1] ? noteLabel(k[0]) : `${noteLabel(k[0])}-${noteLabel(k[1])}`);
export const velText = (v: readonly [number, number]): string => (v[0] === v[1] ? String(v[0]) : `${v[0]}-${v[1]}`);

/** The `instrument zone set` a finished drag writes: only what changed, or null when nothing did. */
export function zoneSetCommand(id: string, n: number, before: Span, after: Span): string | null {
  const parts: string[] = [];
  if (before.keys[0] !== after.keys[0] || before.keys[1] !== after.keys[1]) parts.push(`keys=${keysText(after.keys)}`);
  if (before.vel[0] !== after.vel[0] || before.vel[1] !== after.vel[1]) parts.push(`vel=${velText(after.vel)}`);
  return parts.length ? `instrument zone set ${id} ${n} ${parts.join(' ')}` : null;
}

/** Keys a sample dropped on a key covers: that key and one either side. */
export const DROP_SPAN = 1;

export interface DropSample { name: string; /** The note the sample's metadata names (`C4`). */ root?: string | undefined; /** The pitch the card measured: a note and cents (positive: sharp). */ pitch?: { note: string; cents: number } | null | undefined; pitched?: boolean | undefined }

/** `instrument zone add` for a sample dropped on a key. The root is the sample's own (its metadata), else what was measured (with the tuning that makes it sound at the note), else the key it was dropped on, and the note says which. */
export function dropZone(id: string, s: DropSample, key: number, vel?: number): { command: string; note: string } {
  const lo = Math.max(0, key - DROP_SPAN), hi = Math.min(127, key + DROP_SPAN);
  const base = `instrument zone add ${id} sample=${s.name}`;
  const tail = ` keys=${keysText([lo, hi])}${vel !== undefined ? ` vel=${vel}-127` : ''}`;
  if (s.root) return { command: `${base}${tail}`, note: `rooted at ${s.root}, the sample's own root` };
  if (s.pitch && s.pitched !== false) {
    const tune = -Math.round(s.pitch.cents);
    return { command: `${base} root=${s.pitch.note}${tune ? ` tune=${tune}` : ''}${tail}`, note: `rooted at ${s.pitch.note}${tune ? ` ${tune > 0 ? '+' : ''}${tune} cents` : ''}, as measured` };
  }
  return { command: `${base} root=${noteLabel(key)}${tail}`, note: `no steady pitch to measure: rooted at ${noteLabel(key)}, the key it was dropped on` };
}

// ---- playing ----------------------------------------------------------------------------------------------------------------

/** The computer keyboard as a piano: the semitone above the octave's C each key plays (the home row's white keys, the row above's black ones). */
export const COMPUTER_KEYS: Readonly<Record<string, number>> = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16,
};

/** The note a key plays in an octave (octave 4 is C4 = 60 at `a`), or null for a key that plays none. */
export function computerNote(key: string, octave: number): number | null {
  const s = COMPUTER_KEYS[key.toLowerCase()];
  if (s === undefined) return null;
  const m = (octave + 1) * 12 + s;
  return m >= 0 && m <= 127 ? m : null;
}

export interface MidiNote { on: boolean; midi: number; vel: number }

/** A MIDI message as a note on or off (a note on with velocity 0 is an off); null for anything else. */
export function parseMidiMessage(data: ArrayLike<number>): MidiNote | null {
  if (data.length < 3) return null;
  const status = data[0]! & 0xf0;
  const midi = data[1]!, vel = data[2]!;
  if (midi < 0 || midi > 127) return null;
  if (status === 0x90) return { on: vel > 0, midi, vel: vel > 0 ? vel : 0 };
  if (status === 0x80) return { on: false, midi, vel };
  return null;
}

/** How long a rendered key-down lasts when it is held: the page renders this much and fades the note at key-up. */
export const HELD_GATE = 3;
