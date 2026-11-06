// The command language. One command per line (or separated by `;`), `#` starts a comment, words
// separated by spaces, text in "double quotes". Every command has a normal form, which is what
// goes on the history tape, so a tape replays exactly.
//
//   sound new <id>
//   sound set <id> <param>=<value> [<param>=<value> ...]
//   sound mark <id> approved|rejected|draft ["note"]
//   undo [group=<group>] [by=<author>]
//   redo [group=<group>] [by=<author>]

import { SOUND_ID_RE, TONE_PARAMS, cloneSound, fmtNumber, newSound, paramProblem, type ParamName, type Sound, type SoundStatus } from './sound.ts';

export interface Diag {
  line: number;
  col: number;
  message: string;
}

export class DiagError extends Error {
  readonly line: number;
  readonly col: number;
  constructor(line: number, col: number, message: string) {
    super(message);
    this.line = line;
    this.col = col;
  }
}

export interface Token {
  /** The word, with quotes removed. */
  v: string;
  quoted: boolean;
  col: number;
}

export interface RawLine {
  line: number;
  tokens: Token[];
}

/** Split text into commands: lines and `;`, comments dropped, quotes honoured. */
export function tokenize(text: string): { lines: RawLine[]; errors: Diag[] } {
  const lines: RawLine[] = [];
  const errors: Diag[] = [];
  text.split(/\r?\n/).forEach((src, i) => {
    const line = i + 1;
    let tokens: Token[] = [];
    const flush = () => {
      if (tokens.length) lines.push({ line, tokens });
      tokens = [];
    };
    let k = 0;
    while (k < src.length) {
      const ch = src[k]!;
      if (ch === ' ' || ch === '\t') { k++; continue; }
      if (ch === '#') break;
      if (ch === ';') { flush(); k++; continue; }
      const col = k + 1;
      if (ch === '"') {
        let v = '';
        k++;
        let closed = false;
        while (k < src.length) {
          const c = src[k]!;
          if (c === '\\' && (src[k + 1] === '"' || src[k + 1] === '\\')) { v += src[k + 1]; k += 2; continue; }
          if (c === '"') { closed = true; k++; break; }
          v += c;
          k++;
        }
        if (!closed) errors.push({ line, col, message: 'a quoted text is not closed' });
        tokens.push({ v, quoted: true, col });
        continue;
      }
      let v = '';
      while (k < src.length && !' \t;#'.includes(src[k]!)) v += src[k++];
      tokens.push({ v, quoted: false, col });
    }
    flush();
  });
  return { lines, errors };
}

/** A text as it is written on the tape: bare when safe, else quoted. */
export function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
}

export const AUTHOR_RE = /^(agent|human):[A-Za-z0-9_.-]{1,32}$/;
export const HUMAN_RE = /^human:[A-Za-z0-9_.-]{1,32}$/;
export const GROUP_RE = /^g\d+$/;

export type Command =
  | { op: 'new'; id: string; text: string }
  | { op: 'set'; id: string; values: [ParamName, number][]; text: string }
  | { op: 'mark'; id: string; status: SoundStatus; note: string; text: string }
  | { op: 'undo' | 'redo'; group: string | null; by: string | null; text: string };

function checkId(t: Token | undefined, line: number, what: string): string {
  if (!t) throw new DiagError(line, 1, `${what}: give the sound's id`);
  if (!SOUND_ID_RE.test(t.v)) throw new DiagError(line, t.col, `'${t.v}' is not a sound id (a-z, 0-9, _ and -, starting with a letter, at most 48 characters)`);
  return t.v;
}

function parseLine(l: RawLine): Command {
  const [head, ...rest] = l.tokens;
  const line = l.line;
  if (head!.v === 'sound') {
    const [verb, ...args] = rest;
    if (!verb) throw new DiagError(line, head!.col, 'sound: new, set or mark');
    if (verb.v === 'new') {
      const id = checkId(args[0], line, 'sound new');
      if (args.length > 1) throw new DiagError(line, args[1]!.col, `sound new: unexpected '${args[1]!.v}'`);
      return { op: 'new', id, text: `sound new ${id}` };
    }
    if (verb.v === 'set') {
      const id = checkId(args[0], line, 'sound set');
      const pairs = args.slice(1);
      if (!pairs.length) throw new DiagError(line, verb.col, `sound set ${id}: give at least one <param>=<value> (parameters: ${TONE_PARAMS.map((p) => p.name).join(', ')})`);
      const values: [ParamName, number][] = [];
      for (const t of pairs) {
        const m = /^([A-Za-z]+)=(.*)$/.exec(t.v);
        if (!m) throw new DiagError(line, t.col, `'${t.v}' is not <param>=<value>`);
        if (!/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(m[2]!)) throw new DiagError(line, t.col, `${m[1]}: '${m[2]}' is not a number`);
        const value = Number(m[2]);
        const problem = paramProblem(m[1]!, value);
        if (problem) throw new DiagError(line, t.col, problem);
        if (values.some(([n]) => n === m[1])) throw new DiagError(line, t.col, `${m[1]} is set twice in one command`);
        values.push([m[1] as ParamName, value]);
      }
      return { op: 'set', id, values, text: `sound set ${id} ${values.map(([n, v]) => `${n}=${fmtNumber(v)}`).join(' ')}` };
    }
    if (verb.v === 'mark') {
      const id = checkId(args[0], line, 'sound mark');
      const st = args[1];
      if (!st || !['approved', 'rejected', 'draft'].includes(st.v)) throw new DiagError(line, (st ?? verb).col, 'sound mark: the mark is approved, rejected or draft');
      if (args.length > 3) throw new DiagError(line, args[3]!.col, `sound mark: put the note in quotes (unexpected '${args[3]!.v}')`);
      const note = args[2]?.v ?? '';
      return { op: 'mark', id, status: st.v as SoundStatus, note, text: `sound mark ${id} ${st.v}${note ? ' ' + quote(note) : ''}` };
    }
    throw new DiagError(line, verb.col, `unknown sound command '${verb.v}' (new, set, mark)`);
  }
  if (head!.v === 'undo' || head!.v === 'redo') {
    let group: string | null = null;
    let by: string | null = null;
    for (const t of rest) {
      const m = /^(group|by)=(.+)$/.exec(t.v);
      if (!m) throw new DiagError(line, t.col, `${head!.v}: unexpected '${t.v}' (group=<group> or by=<author>)`);
      if (m[1] === 'group') {
        if (!GROUP_RE.test(m[2]!)) throw new DiagError(line, t.col, `'${m[2]}' is not a group (like g3)`);
        group = m[2]!;
      } else {
        if (!AUTHOR_RE.test(m[2]!)) throw new DiagError(line, t.col, `'${m[2]}' is not an author (agent:<name> or human:<name>)`);
        by = m[2]!;
      }
    }
    if (group && by) throw new DiagError(line, rest[0]!.col, `${head!.v}: give group= or by=, not both`);
    return { op: head!.v as 'undo' | 'redo', group, by, text: `${head!.v}${group ? ` group=${group}` : ''}${by ? ` by=${by}` : ''}` };
  }
  throw new DiagError(line, head!.col, `unknown command '${head!.v}' (sound, undo, redo)`);
}

/** Parse command text. Every problem is reported, with its line and column. */
export function parse(text: string): { commands: Command[]; errors: Diag[] } {
  const t = tokenize(text);
  const errors = [...t.errors];
  const commands: Command[] = [];
  for (const l of t.lines) {
    try {
      commands.push(parseLine(l));
    } catch (e) {
      if (e instanceof DiagError) errors.push({ line: e.line, col: e.col, message: e.message });
      else throw e;
    }
  }
  errors.sort((a, b) => a.line - b.line || a.col - b.col);
  return { commands, errors };
}

/** The sounds of a project, by id. Commands replace a sound's object rather than mutating it. */
export type Library = Map<string, Sound>;

/** Apply a sound command to the library; throws a plain Error saying why it cannot. */
export function applyCommand(lib: Library, c: Command): void {
  switch (c.op) {
    case 'new':
      if (lib.has(c.id)) throw new Error(`sound '${c.id}' exists already`);
      lib.set(c.id, newSound(c.id));
      return;
    case 'set': {
      const s = lib.get(c.id);
      if (!s) throw new Error(`no sound '${c.id}'`);
      const next = cloneSound(s);
      for (const [n, v] of c.values) next[n] = v;
      lib.set(c.id, next);
      return;
    }
    case 'mark': {
      const s = lib.get(c.id);
      if (!s) throw new Error(`no sound '${c.id}'`);
      lib.set(c.id, { ...s, status: c.status });
      return;
    }
    default:
      throw new Error(`${c.op} is applied by the history, not to a sound`);
  }
}
