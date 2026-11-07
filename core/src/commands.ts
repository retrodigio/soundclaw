// The command language. One command per line (or separated by `;`), `#` starts a comment, words
// separated by spaces, text in "double quotes". Every command has a normal form, which is what
// goes on the history tape, so a tape replays exactly.
//
//   sound new <id> [voice=tone|classic] [preset=<category>] [seed=<n>]
//   sound set <id> <param>=<value> [<param>=<value> ...]
//   sound patch <id> "<single-patch text>"
//   sound generate <id> <category|random> [seed=<n>]
//   sound mutate <id> [amount=<0..1>] [seed=<n>] [as=<new id>]      (also written `mutate <id> ...`)
//   sound mark <id> approved|rejected|draft ["note"]
//   undo [group=<group>] [by=<author>]
//   redo [group=<group>] [by=<author>]

import { CLASSIC_FIELDS, ClassicError, WAVE_NAMES, formatPatchNamed, parsePatch, type ClassicPatch } from './classic.ts';
import { GENERATOR_NAMES, MUTATE_AMOUNT, defaultGenSeed, defaultMutateSeed, generate, isGenerator, mutate, type GeneratorName } from './generators.ts';
import { SOUND_ID_RE, TONE_PARAMS, cloneSound, fmtNumber, isParamName, newClassicSound, newSound, paramProblem, voiceParams, type Sound, type SoundStatus, type VoiceKind } from './sound.ts';

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

/** A value in `sound set`: a number, or `auto` for the seed (back to the hash of the values). */
export type SetValue = number | 'auto';

export type Command =
  | { op: 'new'; id: string; voice: VoiceKind; preset: string | null; seed: number | null; text: string }
  | { op: 'set'; id: string; values: [string, SetValue][]; text: string }
  | { op: 'patch'; id: string; patch: ClassicPatch; text: string }
  | { op: 'generate'; id: string; category: string; seed: number; text: string }
  | { op: 'mutate'; id: string; amount: number; seed: number | null; as: string | null; text: string }
  | { op: 'mark'; id: string; status: SoundStatus; note: string; text: string }
  | { op: 'undo' | 'redo'; group: string | null; by: string | null; text: string };

function checkId(t: Token | undefined, line: number, what: string): string {
  if (!t) throw new DiagError(line, 1, `${what}: give the sound's id`);
  if (!SOUND_ID_RE.test(t.v)) throw new DiagError(line, t.col, `'${t.v}' is not a sound id (a-z, 0-9, _ and -, starting with a letter, at most 48 characters)`);
  return t.v;
}

/** A number as written in commands (not hex, not 'inf'): null when it is not one. */
function numberOf(s: string): number | null {
  return /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) ? Number(s) : null;
}

function parseMutate(args: Token[], col: number, line: number): Command {
  const id = checkId(args[0], line, 'mutate');
  let amount = MUTATE_AMOUNT;
  let seed: number | null = null;
  let as: string | null = null;
  for (const t of args.slice(1)) {
    const m = /^(amount|seed|as)=(.*)$/.exec(t.v);
    if (!m) throw new DiagError(line, t.col, `mutate: unexpected '${t.v}' (amount=<0..1>, seed=<n>, as=<new id>)`);
    if (m[1] === 'as') {
      if (!SOUND_ID_RE.test(m[2]!)) throw new DiagError(line, t.col, `'${m[2]}' is not a sound id`);
      as = m[2]!;
    } else {
      const n = numberOf(m[2]!);
      if (n === null) throw new DiagError(line, t.col, `${m[1]}: '${m[2]}' is not a number`);
      if (m[1] === 'amount') {
        if (n <= 0 || n > 1) throw new DiagError(line, t.col, `amount is above 0 and at most 1 (got ${n})`);
        amount = n;
      } else {
        if (!Number.isInteger(n) || n < 0 || n > 4294967295) throw new DiagError(line, t.col, `seed is a whole number from 0 to 4294967295 (got '${m[2]}')`);
        seed = n;
      }
    }
  }
  void col;
  return { op: 'mutate', id, amount, seed, as, text: `sound mutate ${id} amount=${fmtNumber(amount)}${seed !== null ? ` seed=${seed}` : ''}${as ? ` as=${as}` : ''}` };
}

function parseLine(l: RawLine): Command {
  const [head, ...rest] = l.tokens;
  const line = l.line;
  if (head!.v === 'sound') {
    const [verb, ...args] = rest;
    if (!verb) throw new DiagError(line, head!.col, 'sound: new, set, patch, generate, mutate or mark');
    if (verb.v === 'new') {
      const id = checkId(args[0], line, 'sound new');
      let voice: VoiceKind | null = null;
      let preset: string | null = null;
      let seed: number | null = null;
      for (const t of args.slice(1)) {
        const m = /^(voice|preset|seed)=(.*)$/.exec(t.v);
        if (!m) throw new DiagError(line, t.col, `sound new: unexpected '${t.v}' (voice=tone|classic, preset=<category>, seed=<n>)`);
        if (m[1] === 'voice') {
          if (m[2] !== 'tone' && m[2] !== 'classic') throw new DiagError(line, t.col, `voice is tone or classic (not '${m[2]}')`);
          voice = m[2];
        } else if (m[1] === 'preset') {
          if (!isGenerator(m[2]!)) throw new DiagError(line, t.col, `no preset '${m[2]}' (presets: ${GENERATOR_NAMES.join(', ')})`);
          preset = m[2]!;
        } else {
          const n = numberOf(m[2]!);
          if (n === null || !Number.isInteger(n) || n < 0 || n > 4294967295) throw new DiagError(line, t.col, `seed is a whole number from 0 to 4294967295 (got '${m[2]}')`);
          seed = n;
        }
      }
      if (preset && voice === 'tone') throw new DiagError(line, args[1]!.col, 'a preset makes a classic sound (voice=classic)');
      if (preset) voice = 'classic';
      if (seed !== null && !preset) throw new DiagError(line, args[1]!.col, 'seed= on sound new goes with preset=<category> (to fix the noise, use sound set <id> seed=<n>)');
      voice ??= 'tone';
      if (preset && seed === null) seed = defaultGenSeed(preset, id);
      const text = voice === 'tone' ? `sound new ${id}` : `sound new ${id} voice=classic${preset ? ` preset=${preset} seed=${seed}` : ''}`;
      return { op: 'new', id, voice, preset, seed, text };
    }
    if (verb.v === 'set') {
      const id = checkId(args[0], line, 'sound set');
      const pairs = args.slice(1);
      if (!pairs.length) throw new DiagError(line, verb.col, `sound set ${id}: give at least one <param>=<value> (tone: ${TONE_PARAMS.map((p) => p.name).join(', ')}; classic: ${CLASSIC_FIELDS.map((p) => p.name).join(', ')}, seed)`);
      const values: [string, SetValue][] = [];
      for (const t of pairs) {
        const m = /^([A-Za-z]+)=(.*)$/.exec(t.v);
        if (!m) throw new DiagError(line, t.col, `'${t.v}' is not <param>=<value>`);
        const name = m[1]!;
        if (!isParamName(name)) throw new DiagError(line, t.col, `no parameter '${name}' (tone: ${TONE_PARAMS.map((p) => p.name).join(', ')}; classic: ${CLASSIC_FIELDS.map((p) => p.name).join(', ')}, seed)`);
        let value: SetValue;
        if (name === 'wave' && (WAVE_NAMES as readonly string[]).includes(m[2]!)) value = (WAVE_NAMES as readonly string[]).indexOf(m[2]!);
        else if (name === 'seed' && m[2] === 'auto') value = 'auto';
        else {
          const n = numberOf(m[2]!);
          if (n === null) throw new DiagError(line, t.col, `${name}: '${m[2]}' is not a number${name === 'wave' ? ' (or square, saw, sine, noise)' : ''}`);
          value = n;
          // A name only one voice has can be checked now; the voice decides the rest when it is applied.
          const voices = (['tone', 'classic'] as const).filter((v) => voiceParams(v).some((p) => p.name === name));
          if (name === 'seed') {
            if (!Number.isFinite(n)) throw new DiagError(line, t.col, 'seed must be a number');
          } else if (voices.length === 1) {
            const problem = paramProblem(name, n, voices[0]);
            if (problem) throw new DiagError(line, t.col, problem);
          } else {
            const problem = paramProblem(name, n, 'tone');
            if (problem) throw new DiagError(line, t.col, problem);
          }
        }
        if (values.some(([n]) => n === name)) throw new DiagError(line, t.col, `${name} is set twice in one command`);
        values.push([name, value]);
      }
      return { op: 'set', id, values, text: `sound set ${id} ${values.map(([n, v]) => `${n}=${v === 'auto' ? 'auto' : n === 'wave' ? WAVE_NAMES[v as number] ?? fmtNumber(v as number) : fmtNumber(v)}`).join(' ')}` };
    }
    if (verb.v === 'patch') {
      const id = checkId(args[0], line, 'sound patch');
      const t = args[1];
      if (!t || args.length > 2) throw new DiagError(line, (t ?? verb).col, `sound patch ${id}: give the patch text in quotes (comma-separated numbers, or name=value pairs)`);
      let patch: ClassicPatch;
      try {
        patch = parsePatch(t.v.replace(/\\n/g, '\n'), 'sound patch').patch;
      } catch (e) {
        if (e instanceof ClassicError) throw new DiagError(line, t.col, e.message);
        throw e;
      }
      return { op: 'patch', id, patch, text: `sound patch ${id} ${quote(formatPatchNamed(patch))}` };
    }
    if (verb.v === 'generate') {
      const id = checkId(args[0], line, 'sound generate');
      const cat = args[1];
      if (!cat || !isGenerator(cat.v)) throw new DiagError(line, (cat ?? verb).col, `sound generate ${id}: give a category (${GENERATOR_NAMES.join(', ')})`);
      let seed: number | null = null;
      for (const t of args.slice(2)) {
        const m = /^seed=(.*)$/.exec(t.v);
        const n = m ? numberOf(m[1]!) : null;
        if (n === null || !Number.isInteger(n) || n < 0 || n > 4294967295) throw new DiagError(line, t.col, `sound generate: unexpected '${t.v}' (seed=<whole number from 0 to 4294967295>)`);
        seed = n;
      }
      seed ??= defaultGenSeed(cat.v, id);
      return { op: 'generate', id, category: cat.v, seed, text: `sound generate ${id} ${cat.v} seed=${seed}` };
    }
    if (verb.v === 'mutate') return parseMutate(args, verb.col, line);
    if (verb.v === 'mark') {
      const id = checkId(args[0], line, 'sound mark');
      const st = args[1];
      if (!st || !['approved', 'rejected', 'draft'].includes(st.v)) throw new DiagError(line, (st ?? verb).col, 'sound mark: the mark is approved, rejected or draft');
      if (args.length > 3) throw new DiagError(line, args[3]!.col, `sound mark: put the note in quotes (unexpected '${args[3]!.v}')`);
      const note = args[2]?.v ?? '';
      return { op: 'mark', id, status: st.v as SoundStatus, note, text: `sound mark ${id} ${st.v}${note ? ' ' + quote(note) : ''}` };
    }
    throw new DiagError(line, verb.col, `unknown sound command '${verb.v}' (new, set, patch, generate, mutate, mark)`);
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
  if (head!.v === 'mutate') return parseMutate(rest, head!.col, line);
  throw new DiagError(line, head!.col, `unknown command '${head!.v}' (sound, mutate, undo, redo)`);
}

/** A command with the line it came from. */
export type Parsed = Command & { line: number };

/** Parse command text. Every problem is reported, with its line and column. */
export function parse(text: string): { commands: Parsed[]; errors: Diag[] } {
  const t = tokenize(text);
  const errors = [...t.errors];
  const commands: Parsed[] = [];
  for (const l of t.lines) {
    try {
      commands.push({ ...parseLine(l), line: l.line });
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

const VOICE_PARAM_HINT = (v: VoiceKind): string => voiceParams(v).map((p) => p.name).join(', ');

/**
 * Apply a sound command to the library; throws a plain Error saying why it cannot. Returns the
 * command's normal form when applying settled something the text left open (a default seed), which
 * is what goes on the tape; otherwise undefined.
 */
export function applyCommand(lib: Library, c: Command): string | undefined {
  switch (c.op) {
    case 'new': {
      if (lib.has(c.id)) throw new Error(`sound '${c.id}' exists already`);
      if (c.voice === 'tone') lib.set(c.id, newSound(c.id));
      else lib.set(c.id, newClassicSound(c.id, c.preset ? generate(c.preset as Parameters<typeof generate>[0], c.seed!) : undefined));
      return undefined;
    }
    case 'set': {
      const s = lib.get(c.id);
      if (!s) throw new Error(`no sound '${c.id}'`);
      const next = cloneSound(s);
      for (const [n, v] of c.values) {
        if (n === 'seed') {
          if (next.voice !== 'classic') throw new Error(`seed is a classic-voice parameter; ${c.id} is a tone (parameters: ${VOICE_PARAM_HINT('tone')})`);
          if (v === 'auto') delete next.patch.seed;
          else next.patch.seed = v as number;
          continue;
        }
        const problem = paramProblem(n, v as number, s.voice);
        if (problem) throw new Error(`${c.id}: ${problem}`);
        if (next.voice === 'tone') (next as unknown as Record<string, number>)[n] = v as number;
        else (next.patch as unknown as Record<string, number>)[n] = v as number;
      }
      lib.set(c.id, next);
      return undefined;
    }
    case 'patch': {
      const s = lib.get(c.id);
      if (!s) throw new Error(`no sound '${c.id}'`);
      if (s.voice !== 'classic') throw new Error(`${c.id} is a tone; a patch is for a classic sound (sound new <id> voice=classic)`);
      lib.set(c.id, { ...s, patch: { ...c.patch } });
      return undefined;
    }
    case 'generate': {
      const s = lib.get(c.id);
      if (!s) throw new Error(`no sound '${c.id}'`);
      if (s.voice !== 'classic') throw new Error(`${c.id} is a tone; generate is for classic sounds`);
      lib.set(c.id, { ...s, patch: generate(c.category as GeneratorName, c.seed) });
      return undefined;
    }
    case 'mutate': {
      const s = lib.get(c.id);
      if (!s) throw new Error(`no sound '${c.id}'`);
      if (s.voice !== 'classic') throw new Error(`${c.id} is a tone; mutate is for classic sounds`);
      const target = c.as ?? c.id;
      if (c.as && lib.has(c.as)) throw new Error(`sound '${c.as}' exists already`);
      const seed = c.seed ?? defaultMutateSeed(s.patch, target);
      const patch = mutate(s.patch, c.amount, seed);
      lib.set(target, c.as ? newClassicSound(c.as, patch) : { ...s, patch });
      return `sound mutate ${c.id} amount=${fmtNumber(c.amount)} seed=${seed}${c.as ? ` as=${c.as}` : ''}`;
    }
    case 'mark': {
      const s = lib.get(c.id);
      if (!s) throw new Error(`no sound '${c.id}'`);
      lib.set(c.id, { ...s, status: c.status });
      return undefined;
    }
    default:
      throw new Error(`${c.op} is applied by the history, not to a sound`);
  }
}
