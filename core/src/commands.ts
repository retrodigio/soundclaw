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
//   sound layer-up <id>                         a classic sound becomes layered (the classic voice is layer 1)
//   sound classic <id> on|off                   keep a sound one classic voice (refuses layer-up)
//   layer add <id> <kind> [<param>=<value> ...] [at=<n>]     kind: classic, osc, fm, ks, sample
//   layer set <id> <n> <param>=<value> ...      (also source=<kind>)
//   layer remove|move|mute|solo <id> <n> [to=<m>|on|off]
//   env <id> <target> "<breakpoints>"|adsr(a,d,s,r[,hold])|clear
//   fx add|set|remove|move <id> [layer=<n>] ...
//   undo [group=<group>] [by=<author>]
//   redo [group=<group>] [by=<author>]

import { CLASSIC_FIELDS, ClassicError, WAVE_NAMES, formatPatchNamed, parsePatch, type ClassicPatch } from './classic.ts';
import { GENERATOR_NAMES, MUTATE_AMOUNT, defaultGenSeed, defaultMutateSeed, generate, isGenerator, mutate, type GeneratorName } from './generators.ts';
import { SOUND_SPECS, checkNumber, classicLayer, FX_KINDS, FX_SPECS, SOURCE_KINDS, adsr, formatEnv, layerSpecs, newLayeredSound, parseTarget, paramNames, parseEnv, parseValue, specOf, type Env, type FxKind, type SourceKind, type LayeredSound } from './layered.ts';
import { RECIPE_NAMES, defaultRecipeSeed, isRecipe, type RecipeName } from './recipes.ts';
import { applyLayerCommand, applyRecipe } from './layer-ops.ts';
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

/** `name=value` words of a layer or effect command, the values still as text (the layer decides what they mean). */
export type Raw = [string, string][];

export type Command =
  | { op: 'new'; id: string; voice: VoiceKind; preset: string | null; seed: number | null; text: string }
  | { op: 'set'; id: string; values: [string, SetValue][]; text: string }
  | { op: 'patch'; id: string; patch: ClassicPatch; text: string }
  | { op: 'generate'; id: string; category: string; seed: number; text: string }
  | { op: 'mutate'; id: string; amount: number; seed: number | null; as: string | null; text: string }
  | { op: 'mark'; id: string; status: SoundStatus; note: string; text: string }
  | { op: 'layer-up'; id: string; seed: number; text: string }
  | { op: 'classic'; id: string; on: boolean; text: string }
  | { op: 'layer-add'; id: string; kind: SourceKind; values: Raw; at: number | null; text: string }
  | { op: 'layer-set'; id: string; n: number; values: Raw; text: string }
  | { op: 'layer-remove'; id: string; n: number; text: string }
  | { op: 'layer-move'; id: string; n: number; to: number; text: string }
  | { op: 'layer-flag'; id: string; n: number; flag: 'mute' | 'solo'; on: boolean; text: string }
  | { op: 'env'; id: string; target: string; env: Env | null; text: string }
  | { op: 'fx-add'; id: string; layer: number | null; kind: FxKind; values: Raw; at: number | null; text: string }
  | { op: 'fx-set'; id: string; layer: number | null; k: number; values: Raw; text: string }
  | { op: 'fx-remove'; id: string; layer: number | null; k: number; text: string }
  | { op: 'fx-move'; id: string; layer: number | null; k: number; to: number; text: string }
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

/** A whole positive number (a layer or effect number, a position). */
function countOf(t: Token | undefined, line: number, what: string): number {
  const n = t ? numberOf(t.v) : null;
  if (!t || n === null || !Number.isInteger(n) || n < 1) throw new DiagError(line, (t ?? { col: 1 }).col, `${what}: give a whole number from 1${t ? ` (got '${t.v}')` : ''}`);
  return n;
}

/** `name=value` words; a value in quotes loses them. */
function pairsOf(tokens: Token[], line: number, what: string, skip: readonly string[] = []): { values: Raw; keys: Map<string, string> } {
  const values: Raw = [];
  const keys = new Map<string, string>();
  for (const t of tokens) {
    const m = /^([A-Za-z][A-Za-z0-9-]*)=(.*)$/s.exec(t.v);
    if (!m) throw new DiagError(line, t.col, `${what}: '${t.v}' is not <name>=<value>`);
    let v = m[2]!;
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (skip.includes(m[1]!)) { keys.set(m[1]!, v); continue; }
    if (values.some(([k]) => k === m[1])) throw new DiagError(line, t.col, `${what}: ${m[1]} is given twice`);
    values.push([m[1]!, v]);
  }
  return { values, keys };
}

const onOff = (t: Token | undefined, line: number, what: string, dflt: boolean | null = null): boolean => {
  if (!t) { if (dflt !== null) return dflt; throw new DiagError(line, 1, `${what}: say on or off`); }
  if (t.v === 'on') return true;
  if (t.v === 'off') return false;
  throw new DiagError(line, t.col, `${what}: say on or off (got '${t.v}')`);
};

function parseLayer(rest: Token[], head: Token, line: number): Command {
  const [verb, ...args] = rest;
  if (!verb) throw new DiagError(line, head.col, 'layer: add, set, remove, move, mute or solo');
  const id = checkId(args[0], line, `layer ${verb.v}`);
  if (verb.v === 'add') {
    const kt = args[1];
    if (!kt || !(SOURCE_KINDS as readonly string[]).includes(kt.v)) throw new DiagError(line, (kt ?? verb).col, `layer add ${id}: give the source (${SOURCE_KINDS.join(', ')})`);
    const kind = kt.v as SourceKind;
    const { values, keys } = pairsOf(args.slice(2), line, `layer add ${id}`, ['at']);
    const specs = layerSpecs(kind);
    for (const [k, v] of values) {
      if (kind === 'classic' && (k === 'preset' || k === 'presetseed' || k === 'patch')) continue;
      const spec = specOf(specs, k);
      if (!spec) throw new DiagError(line, kt.col, `layer add ${id} ${kind}: no parameter '${k}' (parameters: ${paramNames(specs)}${kind === 'classic' ? '; preset=<category>, patch="<single-patch text>"' : ''})`);
      try { parseValue(spec, v, `layer add ${id}`); } catch (e) { throw new DiagError(line, kt.col, (e as Error).message); }
    }
    const at = keys.has('at') ? countOf({ v: keys.get('at')!, quoted: false, col: kt.col }, line, 'at') : null;
    return { op: 'layer-add', id, kind, values, at, text: `layer add ${id} ${kind}${values.map(([k, v]) => ` ${k}=${v}`).join('')}${at !== null ? ` at=${at}` : ''}` };
  }
  if (verb.v === 'set') {
    const n = countOf(args[1], line, `layer set ${id}`);
    const { values } = pairsOf(args.slice(2), line, `layer set ${id} ${n}`);
    if (!values.length) throw new DiagError(line, verb.col, `layer set ${id} ${n}: give at least one <param>=<value>`);
    return { op: 'layer-set', id, n, values, text: `layer set ${id} ${n}${values.map(([k, v]) => ` ${k}=${v}`).join('')}` };
  }
  if (verb.v === 'remove') return { op: 'layer-remove', id, n: countOf(args[1], line, `layer remove ${id}`), text: `layer remove ${id} ${countOf(args[1], line, 'layer remove')}` };
  if (verb.v === 'move') {
    const n = countOf(args[1], line, `layer move ${id}`);
    const m = args[2] ? /^to=(\d+)$/.exec(args[2].v) : null;
    if (!m) throw new DiagError(line, (args[2] ?? verb).col, `layer move ${id} ${n}: give to=<position>`);
    return { op: 'layer-move', id, n, to: Number(m[1]), text: `layer move ${id} ${n} to=${m[1]}` };
  }
  if (verb.v === 'mute' || verb.v === 'solo') {
    const n = countOf(args[1], line, `layer ${verb.v} ${id}`);
    const on = onOff(args[2], line, `layer ${verb.v} ${id} ${n}`, true);
    return { op: 'layer-flag', id, n, flag: verb.v, on, text: `layer ${verb.v} ${id} ${n} ${on ? 'on' : 'off'}` };
  }
  throw new DiagError(line, verb.col, `unknown layer command '${verb.v}' (add, set, remove, move, mute, solo)`);
}

/** `adsr(a,d,s,r[,hold])` as breakpoints. */
function adsrOf(w: string): Env | null {
  const m = /^adsr\(([^)]*)\)$/.exec(w);
  if (!m) return null;
  const xs = m[1]!.split(',').map((x) => numberOf(x.trim()));
  if ((xs.length !== 4 && xs.length !== 5) || xs.some((x) => x === null || x < 0)) throw new Error('adsr(attack, decay, sustain, release[, hold]) takes 4 or 5 numbers (seconds; sustain is a level, 0 to 1)');
  if ((xs[2] as number) > 1) throw new Error('adsr: the sustain level is 0 to 1');
  return adsr(xs[0]!, xs[1]!, xs[2]!, xs[3]!, xs[4] ?? 0);
}

function parseEnvCommand(rest: Token[], head: Token, line: number): Command {
  const id = checkId(rest[0], line, 'env');
  const target = rest[1];
  const body = rest[2];
  if (!target || !body || rest.length > 3) throw new DiagError(line, (target ?? head).col, `env ${id}: env <id> <target> "<breakpoints>" (or adsr(a,d,s,r), or clear); targets like 1.freq, 2.amp, 1.fx2.mix, master.fx1.mix`);
  let env: Env | null;
  try {
    parseTarget(target.v);
    if (body.v === 'clear') env = null;
    else if (!body.quoted && adsrOf(body.v)) {
      if (!/^\d+\.amp$/.test(target.v)) throw new Error('adsr(…) is for amplitude envelopes (target N.amp); other targets take breakpoints');
      env = adsrOf(body.v);
    } else env = parseEnv(body.v);
  } catch (e) {
    throw new DiagError(line, body.col, (e as Error).message);
  }
  return { op: 'env', id, target: target.v, env, text: `env ${id} ${target.v} ${env ? quote(formatEnv(env)) : 'clear'}` };
}

function parseFx(rest: Token[], head: Token, line: number): Command {
  const [verb, ...args] = rest;
  if (!verb) throw new DiagError(line, head.col, 'fx: add, set, remove or move');
  const id = checkId(args[0], line, `fx ${verb.v}`);
  let layer: number | null = null;
  let i = 1;
  const lm = args[1] ? /^layer=(\d+|master)$/.exec(args[1].v) : null;
  if (lm) { layer = lm[1] === 'master' ? null : Number(lm[1]); i = 2; }
  const where = layer === null ? '' : ` layer=${layer}`;
  if (verb.v === 'add') {
    const kt = args[i];
    if (!kt || !(FX_KINDS as readonly string[]).includes(kt.v)) throw new DiagError(line, (kt ?? verb).col, `fx add ${id}: give the effect (${FX_KINDS.join(', ')})`);
    const kind = kt.v as FxKind;
    const { values, keys } = pairsOf(args.slice(i + 1), line, `fx add ${id} ${kind}`, ['at']);
    for (const [k, v] of values) {
      const spec = specOf(FX_SPECS[kind], k);
      if (!spec) throw new DiagError(line, kt.col, `fx add ${id} ${kind}: no parameter '${k}' (parameters: ${paramNames(FX_SPECS[kind])})`);
      try { parseValue(spec, v, `fx add ${id} ${kind}`); } catch (e) { throw new DiagError(line, kt.col, (e as Error).message); }
    }
    const at = keys.has('at') ? countOf({ v: keys.get('at')!, quoted: false, col: kt.col }, line, 'at') : null;
    return { op: 'fx-add', id, layer, kind, values, at, text: `fx add ${id}${where} ${kind}${values.map(([k, v]) => ` ${k}=${v}`).join('')}${at !== null ? ` at=${at}` : ''}` };
  }
  const k = countOf(args[i], line, `fx ${verb.v} ${id}`);
  if (verb.v === 'set') {
    const { values } = pairsOf(args.slice(i + 1), line, `fx set ${id} ${k}`);
    if (!values.length) throw new DiagError(line, verb.col, `fx set ${id} ${k}: give at least one <param>=<value>`);
    return { op: 'fx-set', id, layer, k, values, text: `fx set ${id}${where} ${k}${values.map(([n, v]) => ` ${n}=${v}`).join('')}` };
  }
  if (verb.v === 'remove') return { op: 'fx-remove', id, layer, k, text: `fx remove ${id}${where} ${k}` };
  if (verb.v === 'move') {
    const m = args[i + 1] ? /^to=(\d+)$/.exec(args[i + 1]!.v) : null;
    if (!m) throw new DiagError(line, (args[i + 1] ?? verb).col, `fx move ${id} ${k}: give to=<position>`);
    return { op: 'fx-move', id, layer, k, to: Number(m[1]), text: `fx move ${id}${where} ${k} to=${m[1]}` };
  }
  throw new DiagError(line, verb.col, `unknown fx command '${verb.v}' (add, set, remove, move)`);
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
    if (!verb) throw new DiagError(line, head!.col, 'sound: new, set, patch, generate, mutate, mark, layer-up or classic');
    if (verb.v === 'new') {
      const id = checkId(args[0], line, 'sound new');
      let voice: VoiceKind | null = null;
      let preset: string | null = null;
      let seed: number | null = null;
      for (const t of args.slice(1)) {
        const m = /^(voice|preset|seed)=(.*)$/.exec(t.v);
        if (!m) throw new DiagError(line, t.col, `sound new: unexpected '${t.v}' (voice=tone|classic|layered, preset=<category>, seed=<n>)`);
        if (m[1] === 'voice') {
          if (m[2] !== 'tone' && m[2] !== 'classic' && m[2] !== 'layered') throw new DiagError(line, t.col, `voice is tone, classic or layered (not '${m[2]}')`);
          voice = m[2];
        } else if (m[1] === 'preset') {
          if (!isGenerator(m[2]!) && !isRecipe(m[2]!)) throw new DiagError(line, t.col, `no preset '${m[2]}' (presets: ${[...GENERATOR_NAMES, ...RECIPE_NAMES].join(', ')})`);
          preset = m[2]!;
        } else {
          const n = numberOf(m[2]!);
          if (n === null || !Number.isInteger(n) || n < 0 || n > 4294967295) throw new DiagError(line, t.col, `seed is a whole number from 0 to 4294967295 (got '${m[2]}')`);
          seed = n;
        }
      }
      const at = args[1] ?? args[0]!;
      if (preset && voice === 'tone') throw new DiagError(line, at.col, 'a preset makes a classic or layered sound (voice=classic or voice=layered)');
      if (preset && isRecipe(preset) && voice !== 'layered') {
        if (voice === 'classic') throw new DiagError(line, at.col, `${preset} is a layered recipe: use voice=layered`);
        voice = 'layered';
      }
      if (preset && !voice) voice = 'classic';
      if (seed !== null && !preset && voice !== 'layered') throw new DiagError(line, at.col, 'seed= on sound new goes with preset=<category> (to fix the noise, use sound set <id> seed=<n>)');
      voice ??= 'tone';
      if (voice === 'classic' && preset && !isGenerator(preset)) throw new DiagError(line, at.col, `no classic preset '${preset}' (presets: ${GENERATOR_NAMES.join(', ')})`);
      if (preset && seed === null) seed = defaultGenSeed(preset, id);
      if (voice === 'layered' && seed === null) seed = defaultRecipeSeed('layered', id);
      const text = voice === 'tone' ? `sound new ${id}` : voice === 'classic' ? `sound new ${id} voice=classic${preset ? ` preset=${preset} seed=${seed}` : ''}` : `sound new ${id} voice=layered${preset ? ` preset=${preset}` : ''} seed=${seed}`;
      return { op: 'new', id, voice, preset, seed, text };
    }
    if (verb.v === 'set') {
      const id = checkId(args[0], line, 'sound set');
      const pairs = args.slice(1);
      if (!pairs.length) throw new DiagError(line, verb.col, `sound set ${id}: give at least one <param>=<value> (tone: ${TONE_PARAMS.map((p) => p.name).join(', ')}; classic: ${CLASSIC_FIELDS.map((p) => p.name).join(', ')}, seed; layered: duration, gain, seed)`);
      const values: [string, SetValue][] = [];
      for (const t of pairs) {
        const m = /^([A-Za-z]+)=(.*)$/.exec(t.v);
        if (!m) throw new DiagError(line, t.col, `'${t.v}' is not <param>=<value>`);
        const name = m[1]!;
        if (!isParamName(name)) throw new DiagError(line, t.col, `no parameter '${name}' (tone: ${TONE_PARAMS.map((p) => p.name).join(', ')}; classic: ${CLASSIC_FIELDS.map((p) => p.name).join(', ')}, seed; layered: duration, gain, seed)`);
        let value: SetValue;
        if (name === 'wave' && (WAVE_NAMES as readonly string[]).includes(m[2]!)) value = (WAVE_NAMES as readonly string[]).indexOf(m[2]!);
        else if ((name === 'seed' || name === 'duration') && m[2] === 'auto') value = 'auto';
        else {
          const n = numberOf(m[2]!);
          if (n === null) throw new DiagError(line, t.col, `${name}: '${m[2]}' is not a number${name === 'wave' ? ' (or square, saw, sine, noise)' : ''}`);
          value = n;
          // A name only one voice has can be checked now; the voice decides the rest when it is applied.
          const voices = (['tone', 'classic', 'layered'] as const).filter((v) => voiceParams(v).some((p) => p.name === name));
          if (name === 'seed') {
            if (!Number.isFinite(n)) throw new DiagError(line, t.col, 'seed must be a number');
          } else if (name === 'gain') {
            const problem = paramProblem(name, n, 'layered');
            if (problem) throw new DiagError(line, t.col, problem);
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
      if (!cat || (!isGenerator(cat.v) && !isRecipe(cat.v))) throw new DiagError(line, (cat ?? verb).col, `sound generate ${id}: give a category (${[...GENERATOR_NAMES, ...RECIPE_NAMES].join(', ')})`);
      let seed: number | null = null;
      for (const t of args.slice(2)) {
        const m = /^seed=(.*)$/.exec(t.v);
        const n = m ? numberOf(m[1]!) : null;
        if (n === null || !Number.isInteger(n) || n < 0 || n > 4294967295) throw new DiagError(line, t.col, `sound generate: unexpected '${t.v}' (seed=<whole number from 0 to 4294967295>)`);
        seed = n;
      }
      seed ??= isRecipe(cat.v) ? defaultRecipeSeed(cat.v, id) : defaultGenSeed(cat.v, id);
      return { op: 'generate', id, category: cat.v, seed, text: `sound generate ${id} ${cat.v} seed=${seed}` };
    }
    if (verb.v === 'mutate') return parseMutate(args, verb.col, line);
    if (verb.v === 'layer-up') {
      const id = checkId(args[0], line, 'sound layer-up');
      let seed: number | null = null;
      for (const t of args.slice(1)) {
        const m = /^seed=(\d+)$/.exec(t.v);
        if (!m || Number(m[1]) > 4294967295) throw new DiagError(line, t.col, `sound layer-up: unexpected '${t.v}' (seed=<n>)`);
        seed = Number(m[1]);
      }
      seed ??= defaultRecipeSeed('layered', id);
      return { op: 'layer-up', id, seed, text: `sound layer-up ${id} seed=${seed}` };
    }
    if (verb.v === 'classic') {
      const id = checkId(args[0], line, 'sound classic');
      const on = onOff(args[1], line, `sound classic ${id}`);
      return { op: 'classic', id, on, text: `sound classic ${id} ${on ? 'on' : 'off'}` };
    }
    if (verb.v === 'mark') {
      const id = checkId(args[0], line, 'sound mark');
      const st = args[1];
      if (!st || !['approved', 'rejected', 'draft'].includes(st.v)) throw new DiagError(line, (st ?? verb).col, 'sound mark: the mark is approved, rejected or draft');
      if (args.length > 3) throw new DiagError(line, args[3]!.col, `sound mark: put the note in quotes (unexpected '${args[3]!.v}')`);
      const note = args[2]?.v ?? '';
      return { op: 'mark', id, status: st.v as SoundStatus, note, text: `sound mark ${id} ${st.v}${note ? ' ' + quote(note) : ''}` };
    }
    throw new DiagError(line, verb.col, `unknown sound command '${verb.v}' (new, set, patch, generate, mutate, mark, layer-up, classic)`);
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
  if (head!.v === 'layer') return parseLayer(rest, head!, line);
  if (head!.v === 'fx') return parseFx(rest, head!, line);
  if (head!.v === 'env') return parseEnvCommand(rest, head!, line);
  throw new DiagError(line, head!.col, `unknown command '${head!.v}' (sound, layer, fx, env, mutate, undo, redo)`);
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
      if (c.voice === 'layered') {
        let up = newLayeredSound(c.id, c.seed!);
        if (c.preset && isRecipe(c.preset)) up = applyRecipe(up, c.preset as RecipeName, c.seed!);
        else if (c.preset) up = { ...up, layers: [classicLayer(generate(c.preset as GeneratorName, c.seed!), 1)], nextSalt: 2 };
        lib.set(c.id, up);
      } else if (c.voice === 'tone') lib.set(c.id, newSound(c.id));
      else lib.set(c.id, newClassicSound(c.id, c.preset ? generate(c.preset as Parameters<typeof generate>[0], c.seed!) : undefined));
      return undefined;
    }
    case 'set': {
      const s = lib.get(c.id);
      if (!s) throw new Error(`no sound '${c.id}'`);
      const next = cloneSound(s);
      if (next.voice === 'layered') {
        for (const [n, v] of c.values) {
          if (n === 'duration') next.duration = v === 'auto' ? null : checkNumber(specOf(SOUND_SPECS, 'duration')!, v as number, c.id);
          else if (n === 'gain' || n === 'seed') {
            if (v === 'auto') throw new Error(`${c.id}: a layered sound's seed is a number (it has no auto)`);
            (next as unknown as Record<string, number>)[n] = checkNumber(specOf(SOUND_SPECS, n)!, v as number, c.id);
          } else throw new Error(`${c.id} is a layered sound: sound set takes duration, gain and seed (layers have layer set, effects have fx set)`);
        }
        lib.set(c.id, next);
        return undefined;
      }
      for (const [n, v] of c.values) {
        if (n === 'duration' && v === 'auto') throw new Error(`${c.id}: duration=auto is for a layered sound`);
        if (n === 'seed') {
          if (next.voice !== 'classic') throw new Error(`seed is a classic-voice parameter; ${c.id} is a ${next.voice} (parameters: ${VOICE_PARAM_HINT(next.voice)})`);
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
      if (s.voice !== 'classic') throw new Error(`${c.id} is a ${s.voice} sound; a patch is for a classic sound (sound new <id> voice=classic)`);
      lib.set(c.id, { ...s, patch: { ...c.patch } });
      return undefined;
    }
    case 'generate': {
      const s = lib.get(c.id);
      if (!s) throw new Error(`no sound '${c.id}'`);
      if (isRecipe(c.category)) {
        if (s.voice !== 'layered') throw new Error(`${c.category} is a layered recipe; ${c.id} is a ${s.voice} sound (make it with sound new <id> voice=layered preset=${c.category})`);
        lib.set(c.id, applyRecipe(s, c.category as RecipeName, c.seed));
        return undefined;
      }
      if (s.voice === 'layered') {
        lib.set(c.id, { ...s, seed: c.seed, duration: null, layers: [classicLayer(generate(c.category as GeneratorName, c.seed), 1)], master: [], nextSalt: 2 });
        return undefined;
      }
      if (s.voice !== 'classic') throw new Error(`${c.id} is a tone; generate is for classic and layered sounds`);
      lib.set(c.id, { ...s, patch: generate(c.category as GeneratorName, c.seed) });
      return undefined;
    }
    case 'mutate': {
      const s = lib.get(c.id);
      if (!s) throw new Error(`no sound '${c.id}'`);
      if (s.voice !== 'classic') throw new Error(`${c.id} is a ${s.voice} sound; mutate is for classic sounds${s.voice === 'layered' ? ' (a layered sound is changed with layer set, or regenerated with sound generate)' : ''}`);
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
    case 'undo':
    case 'redo':
      throw new Error(`${c.op} is applied by the history, not to a sound`);
    default:
      return applyLayerCommand(lib, c);
  }
}
