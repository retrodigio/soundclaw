// The pattern text. A pattern is a short grid of steps, one row per channel:
//
//   pattern verse1 steps=16 tpb=4 bar=8
//     lead:  C5  .   E5  .   G5v80 -   -   .  | A4  .   .   .   G4~slide .  E4  .
//     bass:  C3  .   .   .   C3    .   .   .  | A2  .   .   .   G2       .  .   .
//     drum:  k   .   h   .   s     .   h   .  | k   k   h   .   s        .  h   h
//
// `.` is a rest, `-` holds the note before it for one more step, `|` only splits the row into bars
// (every group has `bar` steps). A note is a name and an octave (`C5`, `C#5`, `Db3`), then optionally
// `v1`..`v127` (velocity, default 100), `!` (an accidental outside the key, on purpose) and effects
// `~slide` (glide in from the note before), `~vib` or `~vib(rate,depth)`, `~arp(0,4,7)`. `@8` or `@-5`
// after the velocity moves a note off the grid by whole milliseconds (late, or early with -; up to 50 either way: what
// `humanise` writes). A chord joins notes with `+` (`C4+E4+G4`). A lower-case word is a drum hit
// (`k`, `s`, `hat`), with its own `v80` and `@-4`.
// A row can also be a note list: `lead= 0:C5*2 4:E5v90*4` (step, note, `*` length in steps).
// The normal form is the grid, aligned, with `bar` written in the header when there are bars.

import { MIDI_HIGH, noteLabel, parseNote } from './music.ts';

export interface PatternDiag {
  line: number;
  col: number;
  message: string;
}

export interface NoteFx {
  slide?: true;
  vib?: { rate: number; depth: number };
  arp?: number[];
}

export interface PNote {
  midi: number;
  vel: number;
  /** Milliseconds off the grid (late when positive); left out when 0. */
  nudge?: number;
  /** Marked `!`: outside the key on purpose. */
  accidental?: true;
  /** Written with a flat (`Eb4`), not a sharp: kept so the normal form and the messages spell it as it was written. */
  flat?: true;
  fx: NoteFx;
}

export type Cell =
  | { kind: 'rest' }
  | { kind: 'hold' }
  | { kind: 'notes'; notes: PNote[] }
  | { kind: 'drum'; drum: string; vel: number; nudge?: number };

export interface PatternChannel {
  name: string;
  cells: Cell[];
}

export interface Pattern {
  name: string;
  steps: number;
  /** Steps per beat (the grid's resolution). */
  tpb: number;
  /** Steps in a bar, when the text splits bars. */
  bar: number | null;
  channels: PatternChannel[];
}

export const VEL_DEFAULT = 100;
/** The most a note may sit off the grid, ms. */
export const NUDGE_MAX = 50;
export const VIB_DEFAULT = { rate: 5, depth: 0.4 } as const;
export const MAX_STEPS = 256;
export const MAX_PATTERN_CHANNELS = 16;
export const PATTERN_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
export const CHANNEL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,23}$/;
export const DRUM_RE = /^[a-z][a-z0-9_]{0,11}$/;

const num = (s: string): number | null => (/^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : null);

class Fail extends Error {
  col: number;
  constructor(col: number, message: string) {
    super(message);
    this.col = col;
  }
}

/** Split on `sep` outside brackets; returns the pieces with their offsets. */
function splitOutside(s: string, sep: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === sep && depth === 0) {
      out.push({ text: s.slice(from, i), at: from });
      from = i + 1;
    }
  }
  out.push({ text: s.slice(from), at: from });
  return out;
}

function parseFx(body: string, at: number): NoteFx {
  const fx: NoteFx = {};
  if (!body) return fx;
  let off = at;
  for (const piece of body.split('~').slice(1)) {
    const col = off + 1;
    off += piece.length + 1;
    const m = /^([a-z]+)(?:\(([^)]*)\))?$/.exec(piece);
    if (!m) throw new Fail(col, `'~${piece}' is not an effect (~slide, ~vib, ~vib(rate,depth), ~arp(0,4,7))`);
    const [, name, args] = m;
    if (name === 'slide') {
      if (args !== undefined) throw new Fail(col, '~slide takes no arguments');
      fx.slide = true;
    } else if (name === 'vib') {
      if (args === undefined || args === '') fx.vib = { ...VIB_DEFAULT };
      else {
        const [r, d, ...extra] = args.split(',').map((x) => num(x.trim()));
        if (r === null || r === undefined || d === null || d === undefined || extra.length) throw new Fail(col, '~vib(rate,depth): rate in Hz and depth in semitones, like ~vib(6,0.5)');
        if (r < 0.5 || r > 20) throw new Fail(col, `~vib: the rate is 0.5 to 20 Hz (got ${r})`);
        if (d <= 0 || d > 12) throw new Fail(col, `~vib: the depth is above 0 and at most 12 semitones (got ${d})`);
        fx.vib = { rate: r, depth: d };
      }
    } else if (name === 'arp') {
      const xs = (args ?? '').split(',').map((x) => num(x.trim()));
      if (!args || xs.some((x) => x === null || !Number.isInteger(x) || Math.abs(x) > 48) || xs.length < 2 || xs.length > 8) throw new Fail(col, '~arp(a,b,c): 2 to 8 whole semitone offsets from the note, like ~arp(0,4,7)');
      fx.arp = xs as number[];
    } else throw new Fail(col, `no effect '~${name}' (~slide, ~vib, ~arp)`);
  }
  return fx;
}

function parseNudge(v: string | undefined, col: number): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (Math.abs(n) > NUDGE_MAX) throw new Fail(col, `@${v}: a note moves at most ${NUDGE_MAX} ms off the grid`);
  return n === 0 ? undefined : n;
}

function parseOneNote(text: string, at: number): PNote {
  const m = /^([A-G][#b]?-?\d)(?:v(\d{1,3}))?(!)?(?:@(-?\d{1,3}))?(!)?((?:~.*)?)$/.exec(text);
  if (!m) throw new Fail(at + 1, `'${text}' is not a note (like C5, C#5, Db3, C5v80, C5@-6, E5~slide, G4!)`);
  const midi = parseNote(m[1]!);
  if (midi === null) throw new Fail(at + 1, `'${m[1]}' is outside the MIDI range C-1 to G9`);
  let vel = VEL_DEFAULT;
  if (m[2] !== undefined) {
    vel = Number(m[2]);
    if (vel < 1 || vel > 127) throw new Fail(at + 1 + m[1]!.length, `velocity is 1 to 127 (got ${vel}; use . for a rest)`);
  }
  const fxAt = at + text.length - m[6]!.length;
  const note: PNote = { midi, vel, fx: parseFx(m[6]!, fxAt) };
  if (m[1]![1] === 'b') note.flat = true;
  const nudge = parseNudge(m[4], at + 1);
  if (nudge !== undefined) note.nudge = nudge;
  if (m[3] || m[5]) note.accidental = true;
  return note;
}

/** One grid token: a rest, a hold, notes (a chord) or a drum hit. */
function parseCell(tok: string, at: number): Cell {
  if (tok === '.') return { kind: 'rest' };
  if (tok === '-') return { kind: 'hold' };
  if (/^[a-z]/.test(tok)) {
    const m = /^([a-z][a-z0-9_]*?)(?:v(\d{1,3}))?(?:@(-?\d{1,3}))?$/.exec(tok);
    if (!m || !DRUM_RE.test(m[1]!)) throw new Fail(at + 1, `'${tok}' is not a drum hit (a lower-case name of up to 12 letters like k, s, hat, then optionally v80 and @-4)`);
    const vel = m[2] === undefined ? VEL_DEFAULT : Number(m[2]);
    if (vel < 1 || vel > 127) throw new Fail(at + 1 + m[1]!.length, `velocity is 1 to 127 (got ${vel})`);
    const nudge = parseNudge(m[3], at + 1);
    return nudge === undefined ? { kind: 'drum', drum: m[1]!, vel } : { kind: 'drum', drum: m[1]!, vel, nudge };
  }
  const notes = splitOutside(tok, '+').map((p) => parseOneNote(p.text, at + p.at));
  const seen = new Set<number>();
  for (const n of notes) {
    if (seen.has(n.midi)) throw new Fail(at + 1, `'${tok}' names ${noteLabel(n.midi)} twice`);
    seen.add(n.midi);
  }
  return { kind: 'notes', notes };
}

/** One grid token (a note, chord, hit, rest or hold) on its own; throws a plain Error. */
export function parseCellText(tok: string): Cell {
  try { return parseCell(tok, 0); } catch (e) { if (e instanceof Fail) throw new Error(e.message); throw e; }
}

/** Effects as written after a note (`~slide~vib(6,0.5)`); throws a plain Error. */
export function parseFxText(text: string): NoteFx {
  try { return parseFx(text.startsWith('~') ? text : `~${text}`, 0); } catch (e) { if (e instanceof Fail) throw new Error(e.message); throw e; }
}

interface Tok {
  text: string;
  col: number;
}

function words(src: string, from: number): Tok[] {
  const out: Tok[] = [];
  const re = /\S+/g;
  re.lastIndex = from;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push({ text: m[0], col: m.index + 1 });
  return out;
}

/**
 * Parse a pattern. The text may start with `pattern <name> steps=.. tpb=..` or with the settings
 * alone; `name` is used when the text has no name. Every problem is returned with its line and column.
 */
export function parsePattern(text: string, name = 'pattern'): { pattern: Pattern | null; errors: PatternDiag[] } {
  const errors: PatternDiag[] = [];
  const fail = (line: number, col: number, message: string): void => { errors.push({ line, col, message }); };
  const lines = text.split(/\r?\n/);
  let k = 0;
  const skippable = (s: string): boolean => /^\s*(#.*)?$/.test(s);
  while (k < lines.length && skippable(lines[k]!)) k++;
  if (k >= lines.length) return { pattern: null, errors: [{ line: 1, col: 1, message: 'the pattern is empty (start with: pattern <name> steps=16 tpb=4)' }] };
  const head = words(lines[k]!, 0);
  const headLine = k + 1;
  k++;
  let pname = name;
  let at = 0;
  if (head[0]?.text === 'pattern') {
    at = 1;
    if (head[1] && !head[1].text.includes('=')) {
      pname = head[1].text.includes('.') ? head[1].text.slice(head[1].text.indexOf('.') + 1) : head[1].text;
      at = 2;
      if (!PATTERN_NAME_RE.test(pname)) fail(headLine, head[1].col, `'${head[1].text}' is not a pattern name (letters, digits, _ and -, starting with a letter)`);
    }
  }
  let steps: number | null = null;
  let tpb = 4;
  let bar: number | null = null;
  for (const t of head.slice(at)) {
    const m = /^(steps|tpb|bar)=(.*)$/.exec(t.text);
    if (!m) { fail(headLine, t.col, `'${t.text}' is not a pattern setting (steps=<n> tpb=<steps per beat> bar=<steps per bar>)`); continue; }
    const n = num(m[2]!);
    if (n === null || !Number.isInteger(n) || n < 1) { fail(headLine, t.col + m[1]!.length + 1, `${m[1]} is a whole number from 1 (got '${m[2]}')`); continue; }
    if (m[1] === 'steps') { if (n > MAX_STEPS) fail(headLine, t.col, `steps is at most ${MAX_STEPS} (got ${n}); split the pattern`); steps = n; }
    else if (m[1] === 'tpb') { if (n > 24) fail(headLine, t.col, `tpb (steps per beat) is at most 24 (got ${n})`); tpb = n; }
    else bar = n;
  }
  if (steps === null) { fail(headLine, 1, 'give the length: steps=<n> (for example steps=16 tpb=4)'); }
  const channels: PatternChannel[] = [];
  const inferredBars = new Set<number>();
  for (; k < lines.length; k++) {
    const src = lines[k]!;
    if (skippable(src)) continue;
    const line = k + 1;
    const m = /^(\s*)([A-Za-z][A-Za-z0-9_]*)\s*([:=])/.exec(src);
    if (!m) { fail(line, (/^\s*/.exec(src)![0].length) + 1, `a channel row is <name>: <steps> (or <name>= <step>:<note> ...), got '${src.trim().slice(0, 30)}'`); continue; }
    const cname = m[2]!;
    const body = m[0].length;
    if (!CHANNEL_NAME_RE.test(cname)) { fail(line, m[1]!.length + 1, `'${cname}' is not a channel name (letters, digits and _, at most 24)`); continue; }
    if (channels.some((c) => c.name === cname)) { fail(line, m[1]!.length + 1, `channel '${cname}' is in this pattern twice`); continue; }
    if (steps === null) continue;
    let cells: Cell[] = [];
    let bad = false;
    const toks = words(src.replace(/(^|\s)#.*$/, ''), body);
    if (m[3] === ':') {
      let groupLen = 0;
      const groups: number[] = [];
      for (const t of toks) {
        if (t.text === '|') { groups.push(groupLen); groupLen = 0; continue; }
        if (t.text.includes('|')) { fail(line, t.col + t.text.indexOf('|'), 'put a space on both sides of | (it only splits bars)'); bad = true; continue; }
        try { cells.push(parseCell(t.text, t.col - 1)); groupLen++; } catch (e) {
          if (e instanceof Fail) { fail(line, e.col, e.message); bad = true; cells.push({ kind: 'rest' }); groupLen++; } else throw e;
        }
      }
      groups.push(groupLen);
      if (groups.length > 1) {
        const sizes = new Set(groups);
        if (bar !== null && groups.some((g, i) => g !== bar && !(i === groups.length - 1 && g === 0))) {
          fail(line, toks[0]?.col ?? body + 1, `bars are ${bar} steps (bar=${bar}) but this row has groups of ${groups.join(', ')}`);
          bad = true;
        } else if (sizes.size === 1) inferredBars.add(groups[0]!);
        else if (bar === null) { fail(line, toks[0]?.col ?? body + 1, `the bars of this row have different lengths (${groups.join(', ')} steps): make them equal, or write bar=<n> in the header`); bad = true; }
      }
      if (!bad && cells.length !== steps) {
        const last = toks[toks.length - 1];
        fail(line, last ? last.col + last.text.length : body + 1, cells.length < steps ? `${cname}: ${cells.length} steps but the pattern has steps=${steps} (${steps - cells.length} missing)` : `${cname}: ${cells.length} steps but the pattern has steps=${steps} (${cells.length - steps} too many)`);
        bad = true;
      }
    } else {
      cells = Array.from({ length: steps }, () => ({ kind: 'rest' }) as Cell);
      const free: boolean[] = Array.from({ length: steps }, () => true);
      for (const t of toks) {
        const e = /^(\d+):([^*]+?)(?:\*(\d+))?$/.exec(t.text);
        if (!e) { fail(line, t.col, `'${t.text}' is not <step>:<note>[*<length>] (like 0:C5*2)`); bad = true; continue; }
        const step = Number(e[1]);
        const len = e[3] === undefined ? 1 : Number(e[3]);
        if (step >= steps) { fail(line, t.col, `step ${step} is outside the pattern (steps 0 to ${steps - 1})`); bad = true; continue; }
        if (len < 1) { fail(line, t.col, 'a length is at least 1 step'); bad = true; continue; }
        let cell: Cell;
        try { cell = parseCell(e[2]!, t.col - 1 + e[1]!.length + 1); } catch (er) {
          if (er instanceof Fail) { fail(line, er.col, er.message); bad = true; continue; }
          throw er;
        }
        if (cell.kind === 'rest' || cell.kind === 'hold') { fail(line, t.col, 'a note list holds notes and drum hits only (leave a step out for a rest)'); bad = true; continue; }
        if (cell.kind === 'drum' && len !== 1) { fail(line, t.col, 'a drum hit is one step (no *length)'); bad = true; continue; }
        const end = Math.min(steps, step + len);
        if (step + len > steps) { fail(line, t.col, `the note runs past the end of the pattern (step ${step} + ${len} > ${steps})`); bad = true; continue; }
        for (let s = step; s < end; s++) {
          if (!free[s]) { fail(line, t.col, `step ${s} is taken by another note of ${cname} (join notes that start together with +, like C4+E4)`); bad = true; break; }
        }
        if (bad) continue;
        for (let s = step; s < end; s++) { free[s] = false; cells[s] = s === step ? cell : { kind: 'hold' }; }
      }
    }
    if (!bad) {
      for (let s = 0; s < cells.length; s++) {
        const c = cells[s]!;
        if (c.kind !== 'hold') continue;
        const prev = s > 0 ? cells[s - 1] : undefined;
        if (!prev || prev.kind === 'rest') { fail(line, toks[s]?.col ?? body + 1, `'-' holds the note before it, and there is none${s === 0 ? ' (it is the first step)' : ' (a rest comes before it)'}`); bad = true; break; }
        if (prev.kind === 'drum') { fail(line, toks[s]?.col ?? body + 1, 'a drum hit is one step: use . after it (- holds notes)'); bad = true; break; }
      }
    }
    if (!bad) channels.push({ name: cname, cells });
  }
  if (!channels.length && !errors.length) fail(headLine, 1, 'the pattern has no channel rows (like: lead: C5 . E5 .)');
  if (channels.length > MAX_PATTERN_CHANNELS) fail(headLine, 1, `a pattern has at most ${MAX_PATTERN_CHANNELS} channels`);
  if (bar === null && inferredBars.size === 1) bar = [...inferredBars][0]!;
  if (bar === null && inferredBars.size > 1) fail(headLine, 1, `the rows split bars differently (${[...inferredBars].join(' and ')} steps): write bar=<n> in the header`);
  if (bar !== null && steps !== null && (bar > steps || steps % bar !== 0)) fail(headLine, 1, `bar=${bar} must divide steps=${steps}`);
  if (errors.length || steps === null) return { pattern: null, errors };
  return { pattern: { name: pname, steps, tpb, bar, channels }, errors };
}

// ---- format -----------------------------------------------------------------------------------------

export function formatFx(fx: NoteFx): string {
  let s = '';
  if (fx.slide) s += '~slide';
  if (fx.vib) s += fx.vib.rate === VIB_DEFAULT.rate && fx.vib.depth === VIB_DEFAULT.depth ? '~vib' : `~vib(${fx.vib.rate},${fx.vib.depth})`;
  if (fx.arp) s += `~arp(${fx.arp.join(',')})`;
  return s;
}

const formatNudge = (n: number | undefined): string => (n ? `@${n}` : '');

export function formatNote(n: PNote): string {
  return `${noteLabel(n.midi, n.flat === true)}${n.vel === VEL_DEFAULT ? '' : 'v' + n.vel}${formatNudge(n.nudge)}${n.accidental ? '!' : ''}${formatFx(n.fx)}`;
}

export function formatCell(c: Cell): string {
  switch (c.kind) {
    case 'rest': return '.';
    case 'hold': return '-';
    case 'drum': return `${c.drum}${c.vel === VEL_DEFAULT ? '' : 'v' + c.vel}${formatNudge(c.nudge)}`;
    default: return c.notes.map(formatNote).join('+');
  }
}

/** The normal form: the header, then the grids aligned, a `|` every `bar` steps. */
export function formatPattern(p: Pattern): string {
  const head = `pattern ${p.name} steps=${p.steps} tpb=${p.tpb}${p.bar !== null && p.bar < p.steps ? ` bar=${p.bar}` : ''}`;
  const toks = p.channels.map((c) => c.cells.map(formatCell));
  const colW = Array.from({ length: p.steps }, (_, s) => Math.max(1, ...toks.map((row) => row[s]!.length)));
  const nameW = Math.max(...p.channels.map((c) => c.name.length), 1);
  const rows = p.channels.map((c, i) => {
    const parts: string[] = [];
    toks[i]!.forEach((t, s) => {
      if (p.bar !== null && p.bar < p.steps && s > 0 && s % p.bar === 0) parts.push('|');
      parts.push(t.padEnd(colW[s]!));
    });
    return `  ${(c.name + ':').padEnd(nameW + 1)} ${parts.join(' ')}`.replace(/\s+$/, '');
  });
  return [head, ...rows].join('\n') + '\n';
}

// ---- events -----------------------------------------------------------------------------------------

/** A sounding thing in a channel: where it starts, how many steps it lasts (holds included). */
export interface StepEvent {
  step: number;
  len: number;
  notes: PNote[] | null;
  drum: string | null;
  vel: number;
  /** A drum hit's milliseconds off the grid (a note's are on the note). */
  nudge: number;
  /** For a note with ~slide: the pitch of the note sounding just before it in the channel, if one ended at this step. */
  slideFrom: number | null;
}

/** The events of a channel's row. A note lasts until the next event or rest, or the end of the pattern. */
export function channelEvents(ch: PatternChannel): StepEvent[] {
  const out: StepEvent[] = [];
  const cells = ch.cells;
  for (let s = 0; s < cells.length; s++) {
    const c = cells[s]!;
    if (c.kind === 'rest' || c.kind === 'hold') continue;
    let len = 1;
    if (c.kind === 'notes') while (s + len < cells.length && cells[s + len]!.kind === 'hold') len++;
    const prev = out[out.length - 1];
    const slideFrom = c.kind === 'notes' && c.notes.some((n) => n.fx.slide) && prev && prev.notes && prev.step + prev.len === s ? prev.notes[prev.notes.length - 1]!.midi : null;
    out.push({ step: s, len, notes: c.kind === 'notes' ? c.notes : null, drum: c.kind === 'drum' ? c.drum : null, vel: c.kind === 'drum' ? c.vel : c.notes[0]!.vel, nudge: c.kind === 'drum' ? c.nudge ?? 0 : 0, slideFrom });
  }
  return out;
}

export function clonePattern(p: Pattern): Pattern {
  return { ...p, channels: p.channels.map((c) => ({ name: c.name, cells: c.cells.map((x) => (x.kind === 'notes' ? { kind: 'notes', notes: x.notes.map((n) => ({ ...n, fx: { ...n.fx, ...(n.fx.arp ? { arp: [...n.fx.arp] } : {}), ...(n.fx.vib ? { vib: { ...n.fx.vib } } : {}) } })) } : { ...x })) })) };
}

export { MIDI_HIGH };
