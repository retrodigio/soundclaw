// Small edits to a pattern's notes: the commands the music editor writes, and an agent can write the
// same way. One note (or chord, or drum hit) at a time, by the step it starts on:
//
//   pattern note add <song>.<pattern> <channel> <step> <note|chord|hit> [len=<steps>]
//   pattern note remove <song>.<pattern> <channel> <step> [<note|hit>]
//   pattern note move <song>.<pattern> <channel> <step> [<note|hit>] [step=<to>] [note=<to>]
//   pattern note len <song>.<pattern> <channel> <step> <steps>
//   pattern note set <song>.<pattern> <channel> <step> [<note|hit>] [vel=<1..127>] [fx=~slide~vib|none] [accidental=yes|no]
//
// A row holds one sounding thing per step: a note, a chord (notes that start and end together) or a
// drum hit, then its holds. So:
//   - add writes the note over whatever it lands on: a note it overlaps is cut short where it begins,
//     a note that starts under it goes. A note added where a chord or note already starts joins it as
//     a chord (the chord takes `len` when given, else keeps its length); the same pitch is replaced.
//   - remove takes a note out of a chord, or the whole note, chord or hit (its holds become rests).
//   - move is a remove and an add, keeping the note's length, velocity and effects.
//   - len sets how many steps a note or chord lasts (what it grows over goes, as with add).
//   - set changes a note's velocity, effects or `!` mark (a hit's velocity).
// The page writes these and nothing else for notes, never the pattern's whole text. Steps count from 0.

import { DiagError, applyCommand, parse, type Token } from './commands.ts';
import { copyLibrary, type Library } from './sets.ts';
import { noteLabel, parseNote } from './music.ts';
import {
  CHANNEL_NAME_RE, DRUM_RE, VEL_DEFAULT, channelEvents, clonePattern, formatCell, formatFx, formatNote, formatPattern, parseCellText, parseFxText,
  type Cell, type NoteFx, type PNote, type Pattern, type PatternChannel,
} from './pattern.ts';
import type { SongDoc } from './song.ts';

export type NoteVerb = 'add' | 'remove' | 'move' | 'len' | 'set';
export const NOTE_VERBS: readonly NoteVerb[] = ['add', 'remove', 'move', 'len', 'set'];

/** Which part of the cell at a step: one pitch, one drum word, or (null) all of it. */
export type NoteSel = { midi: number } | { drum: string } | null;

export interface NoteEdit {
  verb: NoteVerb;
  channel: string;
  step: number;
  /** add: what to write. */
  cell?: Cell;
  /** add: the length in steps (null: 1, or the chord's own length when the note joins one). len: the new length. */
  len?: number | null;
  sel?: NoteSel;
  /** move: where to. */
  toStep?: number | null;
  toNote?: number | string | null;
  /** set. */
  vel?: number | null;
  fx?: NoteFx | null;
  accidental?: boolean | null;
}

const selText = (s: NoteSel | undefined): string => (!s ? '' : 'midi' in s ? ` ${noteLabel(s.midi)}` : ` ${s.drum}`);

/** The normal form of a note edit (the line on the tape). */
export function noteEditText(song: string, pattern: string, e: NoteEdit): string {
  const head = `pattern note ${e.verb} ${song}.${pattern} ${e.channel} ${e.step}`;
  switch (e.verb) {
    case 'add': return `${head} ${formatCell(e.cell!)}${e.len ? ` len=${e.len}` : ''}`;
    case 'remove': return `${head}${selText(e.sel)}`;
    case 'move': return `${head}${selText(e.sel)}${e.toStep !== null && e.toStep !== undefined ? ` step=${e.toStep}` : ''}${e.toNote !== null && e.toNote !== undefined ? ` note=${typeof e.toNote === 'number' ? noteLabel(e.toNote) : e.toNote}` : ''}`;
    case 'len': return `${head} ${e.len}`;
    case 'set': return `${head}${selText(e.sel)}${e.vel ? ` vel=${e.vel}` : ''}${e.fx ? ` fx=${formatFx(e.fx) || 'none'}` : ''}${e.accidental !== null && e.accidental !== undefined ? ` accidental=${e.accidental ? 'yes' : 'no'}` : ''}`;
  }
}

function parseSel(t: Token, line: number): NoteSel {
  if (DRUM_RE.test(t.v)) return { drum: t.v };
  const m = parseNote(t.v);
  if (m === null) throw new DiagError(line, t.col, `'${t.v}' is not a note (like C5) or a drum hit (like k)`);
  return { midi: m };
}

const intTok = (t: Token | undefined, line: number, what: string, lo: number, hi: number): number => {
  if (!t || !/^\d+$/.test(t.v) || Number(t.v) < lo || Number(t.v) > hi) throw new DiagError(line, t?.col ?? 1, `${what} is a whole number from ${lo} to ${hi}${t ? ` (got '${t.v}')` : ''}`);
  return Number(t.v);
};

/** `pattern note <verb> <song>.<pattern> <channel> <step> …` after `pattern note`. */
export function parseNoteEdit(args: Token[], line: number, ref: (t: Token | undefined) => { song: string; name: string }): { song: string; name: string; edit: NoteEdit } {
  const [verbT, refT, chT, stepT, ...rest] = args;
  if (!verbT || !(NOTE_VERBS as readonly string[]).includes(verbT.v)) throw new DiagError(line, verbT?.col ?? 1, `pattern note: ${NOTE_VERBS.join(', ')}`);
  const verb = verbT.v as NoteVerb;
  const { song, name } = ref(refT);
  if (!chT || !CHANNEL_NAME_RE.test(chT.v)) throw new DiagError(line, chT?.col ?? refT!.col, `pattern note ${verb} ${song}.${name}: give the channel (like lead)`);
  const step = intTok(stepT, line, 'the step', 0, 255);
  const e: NoteEdit = { verb, channel: chT.v, step };
  const pairsOf = (ts: Token[]): Map<string, Token> => {
    const out = new Map<string, Token>();
    for (const t of ts) {
      const m = /^([a-z]+)=(.*)$/.exec(t.v);
      if (!m) throw new DiagError(line, t.col, `pattern note ${verb}: '${t.v}' is not <name>=<value>`);
      out.set(m[1]!, { ...t, v: m[2]! });
    }
    return out;
  };
  const selAnd = (): Map<string, Token> => {
    let ts = rest;
    if (ts[0] && !ts[0].v.includes('=')) { e.sel = parseSel(ts[0], line); ts = ts.slice(1); } else e.sel = null;
    return pairsOf(ts);
  };
  const only = (m: Map<string, Token>, keys: string[]): void => {
    for (const [k, t] of m) if (!keys.includes(k)) throw new DiagError(line, t.col, `pattern note ${verb}: unexpected '${k}=' (${keys.map((x) => x + '=').join(', ') || 'nothing more'})`);
  };
  if (verb === 'add') {
    const c = rest[0];
    if (!c || c.v.includes('=')) throw new DiagError(line, (c ?? stepT!).col, 'pattern note add: give the note, chord or hit (like C5, C4+E4+G4, E5v80~slide or k)');
    try { e.cell = parseCellText(c.v); } catch (err) { throw new DiagError(line, c.col, (err as Error).message); }
    if (e.cell.kind !== 'notes' && e.cell.kind !== 'drum') throw new DiagError(line, c.col, 'pattern note add writes a note, a chord or a drum hit (remove makes a rest)');
    const m = pairsOf(rest.slice(1));
    only(m, ['len']);
    e.len = m.has('len') ? intTok(m.get('len'), line, 'len', 1, 256) : null;
    if (e.cell.kind === 'drum' && e.len !== null && e.len !== 1) throw new DiagError(line, m.get('len')!.col, 'a drum hit is one step (no len=)');
    if (e.cell.kind === 'drum') e.len = null;
  } else if (verb === 'remove') {
    only(selAnd(), []);
  } else if (verb === 'move') {
    const m = selAnd();
    only(m, ['step', 'note']);
    e.toStep = m.has('step') ? intTok(m.get('step'), line, 'step=', 0, 255) : null;
    const nt = m.get('note');
    e.toNote = null;
    if (nt) {
      if (DRUM_RE.test(nt.v)) e.toNote = nt.v;
      else { const n = parseNote(nt.v); if (n === null) throw new DiagError(line, nt.col, `note= is a note like E5 or a drum hit like s (got '${nt.v}')`); e.toNote = n; }
    }
    if (e.toStep === null && e.toNote === null) throw new DiagError(line, verbT.col, 'pattern note move: give step=<to> and/or note=<to>');
  } else if (verb === 'len') {
    e.len = intTok(rest[0], line, 'the length in steps', 1, 256);
    if (rest.length > 1) throw new DiagError(line, rest[1]!.col, 'pattern note len <song>.<pattern> <channel> <step> <steps>');
  } else {
    const m = selAnd();
    only(m, ['vel', 'fx', 'accidental']);
    e.vel = m.has('vel') ? intTok(m.get('vel'), line, 'vel', 1, 127) : null;
    const fx = m.get('fx');
    e.fx = null;
    if (fx) {
      if (fx.v === 'none') e.fx = {};
      else { try { e.fx = parseFxText(fx.v); } catch (err) { throw new DiagError(line, fx.col, (err as Error).message); } }
    }
    const acc = m.get('accidental');
    e.accidental = acc ? (['yes', 'on', 'true'].includes(acc.v) ? true : ['no', 'off', 'false'].includes(acc.v) ? false : (() => { throw new DiagError(line, acc.col, 'accidental is yes or no'); })()) : null;
    if (!e.vel && !e.fx && e.accidental === null) throw new DiagError(line, verbT.col, 'pattern note set: give vel=, fx= or accidental=');
  }
  return { song, name, edit: e };
}

// ---- applying ------------------------------------------------------------------------------------------------------

/** The step a note sounding at `step` starts on (itself, or the note its hold belongs to), or -1. */
export function startOf(cells: readonly Cell[], step: number): number {
  for (let s = step; s >= 0; s--) {
    const c = cells[s]!;
    if (c.kind === 'hold') continue;
    return c.kind === 'rest' ? -1 : s;
  }
  return -1;
}

/** How many steps the thing starting at `step` lasts. */
export function lengthAt(cells: readonly Cell[], step: number): number {
  let n = 1;
  while (step + n < cells.length && cells[step + n]!.kind === 'hold') n++;
  return n;
}

/** Make steps a..b-1 rests: a note before `a` holding into them is cut at `a`; holds after `b` left without their note become rests. */
function clear(cells: Cell[], a: number, b: number): void {
  for (let s = a; s < b && s < cells.length; s++) cells[s] = { kind: 'rest' };
  for (let s = b; s < cells.length && cells[s]!.kind === 'hold'; s++) cells[s] = { kind: 'rest' };
}

/** Write a cell lasting `len` steps at `step` (over whatever is there). */
function write(cells: Cell[], step: number, cell: Cell, len: number): void {
  clear(cells, step, step + len);
  cells[step] = cell;
  for (let s = step + 1; s < step + len; s++) cells[s] = { kind: 'hold' };
}

const cloneNote = (n: PNote): PNote => ({ ...n, fx: { ...n.fx, ...(n.fx.arp ? { arp: [...n.fx.arp] } : {}), ...(n.fx.vib ? { vib: { ...n.fx.vib } } : {}) } });

function describeAt(cells: readonly Cell[], step: number, channel: string): string {
  const s = startOf(cells, step);
  if (s >= 0 && s !== step) return `no note starts at step ${step} of ${channel} (the note sounding there, ${formatCell(cells[s]!)}, starts at step ${s})`;
  return `no note starts at step ${step} of ${channel} (it is a rest)`;
}

/** Take the selected notes out of the cell at `step` (the cell itself must start there). Returns what was taken and its length. */
function take(cells: Cell[], step: number, sel: NoteSel, channel: string): { cell: Cell; len: number } {
  const c = cells[step]!;
  if (c.kind !== 'notes' && c.kind !== 'drum') throw new Error(describeAt(cells, step, channel));
  const len = lengthAt(cells, step);
  if (sel && 'drum' in sel) {
    if (c.kind !== 'drum' || c.drum !== sel.drum) throw new Error(`step ${step} of ${channel} is ${formatCell(c)}, not the hit ${sel.drum}`);
  } else if (sel && 'midi' in sel) {
    if (c.kind !== 'notes' || !c.notes.some((n) => n.midi === sel.midi)) throw new Error(`step ${step} of ${channel} is ${formatCell(c)}: no ${noteLabel(sel.midi)} there`);
    if (c.notes.length > 1) {
      const n = c.notes.find((x) => x.midi === sel.midi)!;
      cells[step] = { kind: 'notes', notes: c.notes.filter((x) => x !== n) };
      return { cell: { kind: 'notes', notes: [cloneNote(n)] }, len };
    }
  }
  clear(cells, step, step + len);
  return { cell: c, len };
}

/** Put a cell at a step: a note joins a chord that starts there (taking `len` when given), the same pitch is replaced; anything else is written over. */
function put(cells: Cell[], step: number, cell: Cell, len: number | null): void {
  const here = cells[step]!;
  if (cell.kind === 'notes' && here.kind === 'notes') {
    const merged = [...here.notes.filter((n) => !cell.notes.some((x) => x.midi === n.midi)), ...cell.notes].sort((a, b) => a.midi - b.midi);
    write(cells, step, { kind: 'notes', notes: merged }, len ?? lengthAt(cells, step));
    return;
  }
  write(cells, step, cell, len ?? 1);
}

/** The row a pattern has for a channel, made (all rests, in the song's channel order) when it has none. */
function rowOf(p: Pattern, song: SongDoc | null, channel: string): PatternChannel {
  let row = p.channels.find((c) => c.name === channel);
  if (row) return row;
  if (song && !song.channels.some((c) => c.name === channel)) throw new Error(`song ${song.id} has no channel ${channel} (channels: ${song.channels.map((c) => c.name).join(', ') || 'none'})`);
  row = { name: channel, cells: Array.from({ length: p.steps }, () => ({ kind: 'rest' }) as Cell) };
  const order = song ? song.channels.map((c) => c.name) : [];
  const at = p.channels.findIndex((c) => order.indexOf(c.name) > order.indexOf(channel));
  if (at < 0) p.channels.push(row);
  else p.channels.splice(at, 0, row);
  return row;
}

/** The pattern after one note edit (a new pattern; the old one is not changed). Throws a plain Error naming what is wrong. */
export function applyNoteEdit(pattern: Pattern, e: NoteEdit, song: SongDoc | null = null): Pattern {
  const p = clonePattern(pattern);
  const ch = song?.channels.find((c) => c.name === e.channel);
  if (e.step >= p.steps) throw new Error(`step ${e.step} is outside pattern ${p.name} (steps 0 to ${p.steps - 1})`);
  const row = rowOf(p, song, e.channel);
  const cells = row.cells;
  const fits = (step: number, len: number): void => { if (step + len > p.steps) throw new Error(`the note runs past the end of pattern ${p.name} (step ${step} + ${len} steps > ${p.steps})`); };
  const kindOk = (c: Cell): void => {
    if (!ch) return;
    if (ch.kit && c.kind === 'notes') throw new Error(`${e.channel} is a drum channel: write a hit like k, s or h`);
    if (ch.inst && c.kind === 'drum') throw new Error(`${e.channel} plays ${ch.inst}: write a note like C5`);
  };
  switch (e.verb) {
    case 'add': {
      kindOk(e.cell!);
      const len = e.cell!.kind === 'drum' ? 1 : e.len ?? (cells[e.step]!.kind === 'notes' && e.cell!.kind === 'notes' ? lengthAt(cells, e.step) : 1);
      fits(e.step, len);
      put(cells, e.step, e.cell!, e.cell!.kind === 'drum' ? 1 : e.len ?? null);
      break;
    }
    case 'remove': take(cells, e.step, e.sel ?? null, e.channel); break;
    case 'move': {
      const { cell, len } = take(cells, e.step, e.sel ?? null, e.channel);
      let moved: Cell = cell;
      if (e.toNote !== null && e.toNote !== undefined) {
        if (typeof e.toNote === 'string') {
          if (cell.kind !== 'drum') throw new Error(`note=${e.toNote} is a drum hit, but step ${e.step} of ${e.channel} is a note`);
          moved = { ...cell, drum: e.toNote };
        } else {
          if (cell.kind !== 'notes') throw new Error(`note=${noteLabel(e.toNote)} is a note, but step ${e.step} of ${e.channel} is a drum hit`);
          // a chord moves as a whole: by the interval that takes its lowest note to note=
          const by = e.toNote - cell.notes[0]!.midi;
          moved = { kind: 'notes', notes: cell.notes.map((n) => ({ ...cloneNote(n), midi: n.midi + by })) };
          if (moved.notes.some((n) => n.midi < 0 || n.midi > 127)) throw new Error('the move takes a note outside the MIDI range');
        }
      }
      const to = e.toStep ?? e.step;
      fits(to, len);
      put(cells, to, moved, moved.kind === 'drum' ? 1 : len);
      break;
    }
    case 'len': {
      const c = cells[e.step]!;
      if (c.kind !== 'notes' && c.kind !== 'drum') throw new Error(describeAt(cells, e.step, e.channel));
      if (c.kind === 'drum' && e.len !== 1) throw new Error('a drum hit is one step');
      fits(e.step, e.len!);
      write(cells, e.step, c, e.len!);
      break;
    }
    case 'set': {
      const c = cells[e.step]!;
      if (c.kind === 'drum') {
        if (e.sel && !('drum' in e.sel && e.sel.drum === c.drum)) throw new Error(`step ${e.step} of ${e.channel} is the hit ${c.drum}`);
        if (e.fx || e.accidental !== null && e.accidental !== undefined) throw new Error('a drum hit has a velocity only (vel=)');
        cells[e.step] = { ...c, vel: e.vel ?? c.vel };
        break;
      }
      if (c.kind !== 'notes') throw new Error(describeAt(cells, e.step, e.channel));
      if (e.sel && 'midi' in e.sel && !c.notes.some((n) => n.midi === (e.sel as { midi: number }).midi)) throw new Error(`step ${e.step} of ${e.channel} is ${formatCell(c)}: no ${noteLabel(e.sel.midi)} there`);
      if (e.sel && 'drum' in e.sel) throw new Error(`step ${e.step} of ${e.channel} is a note, not the hit ${e.sel.drum}`);
      cells[e.step] = {
        kind: 'notes',
        notes: c.notes.map((n) => {
          if (e.sel && 'midi' in e.sel && n.midi !== e.sel.midi) return n;
          const out = cloneNote(n);
          if (e.vel) out.vel = e.vel;
          if (e.fx) out.fx = { ...e.fx };
          if (e.accidental === true) out.accidental = true;
          else if (e.accidental === false) delete out.accidental;
          return out;
        }),
      };
      break;
    }
  }
  return p;
}

// ---- the page's notes ----------------------------------------------------------------------------------------------

/** A note as the piano roll draws it: one pitch (or a hit) of a cell. */
export interface RollNote {
  step: number;
  len: number;
  midi: number | null;
  drum: string | null;
  vel: number;
  fx: NoteFx;
  accidental: boolean;
  /** Notes in its chord (1: a single note). */
  chord: number;
}

export function rollNotes(row: PatternChannel | undefined): RollNote[] {
  if (!row) return [];
  const out: RollNote[] = [];
  for (const e of channelEvents(row)) {
    if (e.drum !== null) out.push({ step: e.step, len: 1, midi: null, drum: e.drum, vel: e.vel, fx: {}, accidental: false, chord: 1 });
    else for (const n of e.notes!) out.push({ step: e.step, len: e.len, midi: n.midi, drum: null, vel: n.vel, fx: n.fx, accidental: !!n.accidental, chord: e.notes!.length });
  }
  return out;
}

/** The selector that names one roll note in a command: its pitch in a chord, else the whole cell. */
export const selOf = (n: RollNote): NoteSel => (n.drum !== null ? null : n.chord > 1 ? { midi: n.midi! } : null);

/**
 * The commands a move gesture writes: each selected note moved by `dSteps` and `dSemis`, ordered so a
 * note never lands on one that has not moved yet. Notes pushed outside the pattern or the MIDI range
 * stop the whole move (null). A move of nothing is no command.
 */
export function moveCommands(song: string, pattern: Pattern, channel: string, notes: readonly RollNote[], dSteps: number, dSemis: number): string[] | null {
  if (!notes.length || (dSteps === 0 && dSemis === 0)) return [];
  for (const n of notes) {
    if (n.step + dSteps < 0 || n.step + dSteps + n.len > pattern.steps) return null;
    if (n.midi !== null && (n.midi + dSemis < 0 || n.midi + dSemis > 127)) return null;
  }
  const order = [...notes].sort((a, b) => (dSteps > 0 ? b.step - a.step : dSteps < 0 ? a.step - b.step : 0) || (dSemis > 0 ? (b.midi ?? 0) - (a.midi ?? 0) : (a.midi ?? 0) - (b.midi ?? 0)));
  // a whole chord selected moves as one cell
  const seen = new Set<number>();
  const out: string[] = [];
  for (const n of order) {
    const whole = n.chord > 1 && notes.filter((x) => x.step === n.step).length === n.chord;
    if (whole) { if (seen.has(n.step)) continue; seen.add(n.step); }
    const lowest = whole ? Math.min(...notes.filter((x) => x.step === n.step).map((x) => x.midi!)) : n.midi;
    out.push(noteEditText(song, pattern.name, {
      verb: 'move', channel, step: n.step, sel: whole ? null : selOf(n),
      toStep: dSteps ? n.step + dSteps : null, toNote: dSemis && lowest !== null ? lowest + dSemis : null,
    }));
  }
  return out;
}

/** The commands that make a row read like `after` (used where the page edits a whole row at once: a helper preview applies by its own command). */
export function noteAddText(song: string, pattern: string, channel: string, step: number, cell: Cell, len: number | null): string {
  return noteEditText(song, pattern, { verb: 'add', channel, step, cell, len });
}

// ---- coalescing a gesture -----------------------------------------------------------------------------------------

/**
 * One gesture, one batch: the commands a drag produces are kept (the latest per key, in the order the
 * keys first came) and written together when the pointer is released, so a drag across eight
 * velocity bars is one history entry, not eight, and a drag that comes back where it began writes
 * nothing.
 */
export class GestureBatch {
  private pending = new Map<string, string | null>();
  private readonly send: (commands: string[]) => void;
  constructor(send: (commands: string[]) => void) {
    this.send = send;
  }
  get active(): boolean {
    return this.pending.size > 0;
  }
  /** The latest command for a key (null: nothing for that key after all). */
  push(key: string, command: string | null): void {
    this.pending.set(key, command);
  }
  /** The value pending for a key, if any. */
  value(key: string): string | null | undefined {
    return this.pending.get(key);
  }
  flush(): void {
    const cmds = [...this.pending.values()].filter((c): c is string => !!c);
    this.pending.clear();
    if (cmds.length) this.send(cmds);
  }
  cancel(): void {
    this.pending.clear();
  }
}

// ---- what changed ---------------------------------------------------------------------------------------------------

/** One note as `changes` lists it. */
const evText = (cells: readonly Cell[], step: number): string => {
  const len = lengthAt(cells, step);
  return `${formatCell(cells[step]!)} at ${step}${len > 1 ? ` (${len} steps)` : ''}`;
};

/** The notes that went and came in each row of a pattern, as `changes` prints them (`lead: − C5 at 4; + E5 at 6 (2 steps)`). */
export function patternNoteDiff(before: Pattern | undefined, after: Pattern | undefined): string[] {
  const out: string[] = [];
  const names = [...new Set([...(before?.channels ?? []), ...(after?.channels ?? [])].map((c) => c.name))];
  for (const n of names) {
    const a = before?.channels.find((c) => c.name === n)?.cells ?? [];
    const b = after?.channels.find((c) => c.name === n)?.cells ?? [];
    const starts = (cells: readonly Cell[]): Map<number, string> => new Map(cells.map((c, s) => [s, c]).filter(([, c]) => (c as Cell).kind === 'notes' || (c as Cell).kind === 'drum').map(([s]) => [s as number, evText(cells, s as number)]));
    const sa = starts(a), sb = starts(b);
    const gone = [...sa].filter(([s, t]) => sb.get(s) !== t).map(([, t]) => `− ${t}`);
    const came = [...sb].filter(([s, t]) => sa.get(s) !== t).map(([, t]) => `+ ${t}`);
    if (gone.length || came.length) {
      const all = [...gone, ...came];
      out.push(`${n}: ${all.slice(0, 16).join('; ')}${all.length > 16 ? `; … ${all.length - 16} more` : ''}`);
    }
  }
  if (before && after && (before.steps !== after.steps || before.tpb !== after.tpb)) out.unshift(`steps ${before.steps} tpb ${before.tpb} → steps ${after.steps} tpb ${after.tpb}`);
  return out;
}

export { formatNote, VEL_DEFAULT };

// ---- previewing a helper -------------------------------------------------------------------------------------------

export interface RowsPreview {
  pattern: string;
  /** The rows that change, before and after, in the pattern text (only those rows). */
  channels: string[];
  before: string;
  after: string;
}

/**
 * What a script (a helper's command, usually) would do to a song's patterns, without doing it: run on a
 * copy of the library, then the rows that differ, before and after. The page shows it before the
 * person applies the very same command.
 */
export function previewRows(lib: Library, song: string, script: string): { ok: true; rows: RowsPreview[] } | { ok: false; error: string } {
  const p = parse(script);
  if (p.errors.length) return { ok: false, error: p.errors[0]!.message };
  const scratch = copyLibrary(lib);
  const was = scratch.songs.get(song);
  try { for (const c of p.commands) applyCommand(scratch, c); } catch (e) { return { ok: false, error: (e as Error).message }; }
  const now = scratch.songs.get(song);
  const rows: RowsPreview[] = [];
  for (const name of new Set([...(was?.patterns.keys() ?? []), ...(now?.patterns.keys() ?? [])])) {
    const a = was?.patterns.get(name), b = now?.patterns.get(name);
    const text = (x: Pattern | undefined, chs: string[]): string => (x ? formatPattern({ ...x, channels: x.channels.filter((c) => chs.includes(c.name)) }) : '(no pattern)\n');
    const chans = [...new Set([...(a?.channels ?? []), ...(b?.channels ?? [])].map((c) => c.name))].filter((c) => {
      const ra = a?.channels.find((x) => x.name === c), rb = b?.channels.find((x) => x.name === c);
      return !ra || !rb || ra.cells.map(formatCell).join(' ') !== rb.cells.map(formatCell).join(' ');
    });
    if (chans.length) rows.push({ pattern: name, channels: chans, before: text(a, chans), after: text(b, chans) });
  }
  return { ok: true, rows };
}
