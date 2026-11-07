// Drum pattern templates: a handful per feel, one bar each, written as three lanes (kick, snare,
// hats) of one character per step:
//   X accent (velocity 120)   x hit (100)   m medium (80)   g ghost (50)   o open hat (90)   . nothing
// `drumBars` writes a number of bars of a template with a fill every N bars and seeded variation
// (ghost snares, extra kicks, an opened or dropped hat). All of it is table lookups and a seeded
// integer stream, so the same seed writes the same hits.

import { seededRandom } from './theory.ts';
import type { Cell } from './pattern.ts';

export interface DrumTemplate {
  feel: string;
  /** Beats in a bar (quarter notes) and steps per beat. */
  beats: number;
  tpb: number;
  kick: string;
  snare: string;
  hat: string;
  about: string;
}

export const DRUM_TEMPLATES: Readonly<Record<string, DrumTemplate>> = {
  rock: { feel: 'straight rock', beats: 4, tpb: 4, kick: 'x.......x.x.....', snare: '....X.......X...', hat: 'x.m.x.m.x.m.x.m.', about: 'kick 1 and 3, snare 2 and 4, eighth hats' },
  'rock-16': { feel: 'straight rock', beats: 4, tpb: 4, kick: 'x.....x.x.......', snare: '....X.......X...', hat: 'xgmgxgmgxgmgxgmg', about: 'sixteenth hats, a pushed kick' },
  'rock-push': { feel: 'straight rock', beats: 4, tpb: 4, kick: 'x.....x...x..x..', snare: '....X.......X...', hat: 'x.m.x.m.x.m.x.o.', about: 'syncopated kick, an open hat into the next bar' },
  halftime: { feel: 'half-time', beats: 4, tpb: 4, kick: 'x......x..x.....', snare: '........X.......', hat: 'x.m.x.m.x.m.x.m.', about: 'the snare on 3 only: heavy, slow' },
  'halftime-ghost': { feel: 'half-time', beats: 4, tpb: 4, kick: 'x.....x...x.....', snare: '..g.....X..g..g.', hat: 'x.m.x.m.x.m.x.m.', about: 'half-time with ghost snares' },
  shuffle: { feel: 'shuffle', beats: 4, tpb: 3, kick: 'x.....x.....', snare: '...X.....X..', hat: 'x.mx.mx.mx.m', about: 'triplet swing: hats on the beat and the last triplet' },
  'shuffle-half': { feel: 'shuffle', beats: 4, tpb: 3, kick: 'x....x...x..', snare: '..g...X....g', hat: 'x.mx.mx.mx.m', about: 'half-time shuffle with ghosts' },
  march: { feel: 'march', beats: 4, tpb: 4, kick: 'x.......x.......', snare: '..x.Xgx...x.Xgx.', hat: '................', about: 'bass drum on 1 and 3, snare figures, no hats' },
  'march-roll': { feel: 'march', beats: 4, tpb: 4, kick: 'x...x...x...x...', snare: '.gmx.gmx.gmx.gmX', hat: '................', about: 'four on the floor under a running snare' },
  waltz: { feel: 'waltz', beats: 3, tpb: 4, kick: 'x...........', snare: '....m...m...', hat: 'x...x...x...', about: '3/4: kick on 1, snare on 2 and 3' },
  'waltz-light': { feel: 'waltz', beats: 3, tpb: 4, kick: 'm...........', snare: '............', hat: '....m...m...', about: '3/4: a soft kick on 1, hats on 2 and 3' },
  pulse: { feel: 'ambient pulse', beats: 4, tpb: 4, kick: 'm.......m.......', snare: '................', hat: '....g.......g...', about: 'a soft heartbeat' },
  'pulse-sparse': { feel: 'ambient pulse', beats: 4, tpb: 4, kick: 'm...............', snare: '................', hat: '........o.......', about: 'one kick a bar and an open hat' },
  chip: { feel: 'chiptune', beats: 4, tpb: 4, kick: 'x.....x.x.......', snare: '....X.......X...', hat: 'mgmgmgmgmgmgmgmg', about: 'driving sixteenth noise hats' },
  'chip-gallop': { feel: 'chiptune', beats: 4, tpb: 4, kick: 'x..x..x.x..x..x.', snare: '....X.......X...', hat: 'm.g.m.g.m.g.m.g.', about: 'galloping kick' },
  'chip-break': { feel: 'chiptune', beats: 4, tpb: 4, kick: 'x.........x.....', snare: '....X.......X..m', hat: 'x.m.x.m.x.mx..m.', about: 'broken beat' },
};

/** Fills: the lanes of the last steps of a bar (the hats are cleared there). */
interface Fill { name: string; tpb: number; kick: string; snare: string }
const FILLS: Fill[] = [
  { name: 'run', tpb: 4, kick: '....', snare: 'gmxX' },
  { name: 'split', tpb: 4, kick: 'x.....x.', snare: '..mx.X.X' },
  { name: 'stop', tpb: 4, kick: '....', snare: 'X.X.' },
  { name: 'run3', tpb: 3, kick: '...', snare: 'mxX' },
  { name: 'split3', tpb: 3, kick: 'x..x..', snare: '.mx.xX' },
];

const VEL: Record<string, number> = { X: 120, x: 100, m: 80, g: 50, o: 90 };

/** The hit names the default kit plays. */
export const KICK = 'k', SNARE = 's', HAT = 'h', OPEN_HAT = 'oh';

interface Lanes { kick: string[]; snare: string[]; hat: string[] }

/**
 * `bars` bars of a template as lanes, with a fill in every `fill`th bar (0: none) and seeded
 * variation of the given amount (0 to 1) in every bar but the first.
 */
function drumLanes(t: DrumTemplate, bars: number, fill: number, seed: number, vary: number): { lanes: Lanes; fills: string[] } {
  const n = t.kick.length;
  const r = seededRandom(seed);
  const lanes: Lanes = { kick: [], snare: [], hat: [] };
  const fills: string[] = [];
  const fitting = FILLS.filter((f) => f.tpb === t.tpb && f.kick.length < n);
  for (let b = 0; b < bars; b++) {
    const kick = t.kick.split(''), snare = t.snare.split(''), hat = t.hat.split('');
    // the same number of draws every bar, whatever they decide, so one bar's choices never shift another's
    const d = [r(), r(), r(), r(), r(), r(), r(), r(), r()];
    const fillHere = fill > 0 && (b + 1) % fill === 0;
    let from = n;
    if (fillHere && fitting.length) {
      const f = fitting[Math.floor(d[8]! * fitting.length)]!;
      from = n - f.kick.length;
      for (let i = 0; i < f.kick.length; i++) { kick[from + i] = f.kick[i]!; snare[from + i] = f.snare[i]!; hat[from + i] = '.'; }
      fills.push(`bar ${b + 1}: ${f.name}`);
    }
    if (b > 0 && vary > 0) {
      const free = (i: number): boolean => i < from && kick[i] === '.' && snare[i] === '.';
      const offs = Array.from({ length: from }, (_, i) => i).filter((i) => i % t.tpb !== 0 && free(i));
      if (d[0]! < vary && offs.length) snare[offs[Math.floor(d[1]! * offs.length)]!] = 'g';
      const half = t.tpb % 2 === 0 ? t.tpb / 2 : 2;
      const late = Array.from({ length: from }, (_, i) => i).filter((i) => i >= n / 2 && i % t.tpb === half && free(i));
      if (d[2]! < vary && late.length) kick[late[Math.floor(d[3]! * late.length)]!] = 'm';
      const offHats = Array.from({ length: from }, (_, i) => i).filter((i) => i % t.tpb !== 0 && hat[i] !== '.');
      if (d[4]! < vary && offHats.length) hat[offHats[offHats.length - 1]!] = 'o';
      const dropHats = offHats.filter((i) => hat[i] !== 'o');
      if (d[5]! < vary && dropHats.length) hat[dropHats[Math.floor(d[6]! * dropHats.length)]!] = '.';
    }
    lanes.kick.push(...kick);
    lanes.snare.push(...snare);
    lanes.hat.push(...hat);
  }
  return { lanes, fills };
}

const hit = (drum: string, ch: string): Cell => {
  const vel = VEL[ch]!;
  return { kind: 'drum', drum: ch === 'o' ? OPEN_HAT : drum, vel };
};

/**
 * The rows a template writes. One channel: kick and snare, and the hats where neither plays (the
 * chip way: one noise channel). Two channels: kick and snare in the first, hats in the second.
 */
export function drumRows(t: DrumTemplate, bars: number, fill: number, seed: number, vary: number, channels: number): { rows: Cell[][]; fills: string[] } {
  const { lanes, fills } = drumLanes(t, bars, fill, seed, vary);
  const steps = lanes.kick.length;
  const main: Cell[] = [];
  const hats: Cell[] = [];
  for (let i = 0; i < steps; i++) {
    const k = lanes.kick[i]!, s = lanes.snare[i]!, h = lanes.hat[i]!;
    const ks: Cell | null = k !== '.' ? hit(KICK, k) : s !== '.' ? hit(SNARE, s) : null;
    const hc: Cell | null = h !== '.' ? hit(HAT, h) : null;
    if (channels === 1) main.push(ks ?? hc ?? { kind: 'rest' });
    else { main.push(ks ?? { kind: 'rest' }); hats.push(hc ?? { kind: 'rest' }); }
  }
  return { rows: channels === 1 ? [main] : [main, hats], fills };
}
