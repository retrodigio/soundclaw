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
//   sound loop <id> <seconds>|off [fade=<seconds>]   a looping bed: seamless at its seam (layered sounds)
//   set new <set> from=<sound> count=<n> [target=<LUFS>] [spread="<param>±<amount> ..."] [seed=<n>]
//   set add|remove <set> <sound>...   set retarget <set> <LUFS>|none   set regen <set> [seed=<n>] [spread="..."]
//   family <sound> near|far|muffled [as=<id>]   the sound as heard near, far away or through a wall
//   layer add <id> <kind> [<param>=<value> ...] [at=<n>]     kind: classic, osc, fm, ks, sample
//   layer set <id> <n> <param>=<value> ...      (also source=<kind>)
//   layer remove|move|mute|solo <id> <n> [to=<m>|on|off]
//   env <id> <target> "<breakpoints>"|adsr(a,d,s,r[,hold])|clear
//   fx add|set|remove|move <id> [layer=<n>] ...
//   undo [group=<group>] [by=<author>]
//   redo [group=<group>] [by=<author>]

import { CLASS_NAME_RE } from './checks.ts';
import { burstsEnv, isBursts } from './bursts.ts';
import { CLASSIC_FIELDS, ClassicError, WAVE_NAMES, formatPatchNamed, parsePatch, type ClassicPatch } from './classic.ts';
import { GENERATOR_NAMES, MUTATE_AMOUNT, defaultGenSeed, defaultMutateSeed, generate, isGenerator, mutate, type GeneratorName } from './generators.ts';
import { SOUND_SPECS, checkNumber, classicLayer, FX_KINDS, FX_SPECS, SOURCE_KINDS, adsr, formatEnv, layerSpecs, newLayeredSound, parseTarget, paramNames, parseEnv, parseValue, specOf, type Env, type FxKind, type SourceKind, type LayeredSound } from './layered.ts';
import { RECIPE_NAMES, RECIPE_UMBRELLAS, defaultRecipeSeed, isRecipe, type RecipeName } from './recipes.ts';
import { applyLayerCommand, applyRecipe, raiseLayersForLoop } from './layer-ops.ts';
import { FAMILY_KINDS, isFamily, makeFamily } from './families.ts';
import { LOOP_FADE, LOOP_LENGTH, MAX_DURATION, type FamilyKind, type LoopSpec } from './layered.ts';
import { Library, MAX_SET_MEMBERS, checkMemberIds, checkSpread, defaultSetSeed, formatSpread, makeMember, memberId, parseSpread, spreadPositions, type SpreadRule } from './sets.ts';
import { hashText } from './generators.ts';
import { SOUND_ID_RE, TONE_PARAMS, cloneSound, idClash, fmtNumber, isParamName, newClassicSound, newSound, paramProblem, voiceParams, type Sound, type SoundStatus, type VoiceKind } from './sound.ts';

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
      while (k < src.length && !' \t;#'.includes(src[k]!)) {
        if (src[k] === '"' && v.endsWith('=')) {
          // name="a quoted value": spaces, ; and # inside the quotes belong to the value
          let q = '';
          let closed = false;
          k++;
          while (k < src.length) {
            const c = src[k]!;
            if (c === '\\' && (src[k + 1] === '"' || src[k + 1] === '\\')) { q += src[k + 1]; k += 2; continue; }
            if (c === '"') { closed = true; k++; break; }
            q += c;
            k++;
          }
          if (!closed) errors.push({ line, col, message: 'a quoted text is not closed' });
          v += `"${q}"`;
          continue;
        }
        v += src[k++];
      }
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

/** A value in `sound set`: a number; `auto` (the seed back to the hash of the values, duration automatic, no own loudness); or a class name (`none`: no own class). */
export type SetValue = number | string;

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
  | { op: 'loop'; id: string; loop: LoopSpec | null; text: string }
  | { op: 'copy' | 'rename'; id: string; to: string; text: string }
  | { op: 'remove'; id: string; fromSets: boolean; text: string }
  | { op: 'set-class'; id: string; class: string | null; text: string }
  | { op: 'set-new'; id: string; from: string; count: number; target: number | null; class: string | null; names: string[] | null; spread: SpreadRule[]; seed: number | null; text: string }
  | { op: 'set-add' | 'set-remove'; id: string; sounds: string[]; text: string }
  | { op: 'set-retarget'; id: string; target: number | null; text: string }
  | { op: 'set-regen'; id: string; seed: number | null; spread: SpreadRule[] | null; text: string }
  | { op: 'family'; id: string; kind: FamilyKind; as: string | null; text: string }
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
  let body = rest[2];
  // bursts(times=0.1,0.3 attack=0.002 ...) written without quotes may have spaces in it: take the words up to the closing bracket as one
  if (body && !body.quoted && body.v.startsWith('bursts(') && !body.v.endsWith(')')) {
    let k = 3;
    let v = body.v;
    while (k < rest.length && !v.endsWith(')')) v += ' ' + rest[k++]!.v;
    body = { ...body, v };
    rest = [...rest.slice(0, 2), body, ...rest.slice(k)];
  }
  if (!target || !body || rest.length > 3) throw new DiagError(line, (target ?? head).col, `env ${id}: env <id> <target> "<breakpoints>" (or adsr(a,d,s,r), bursts(times=...), or clear); targets like 1.freq, 2.amp, 1.fx2.mix, master.fx1.mix`);
  let env: Env | null;
  try {
    parseTarget(target.v);
    if (body.v === 'clear') env = null;
    else if (isBursts(body.v)) env = burstsEnv(body.v);
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

/** A loudness target: -20, -20LUFS (case does not matter); in -60 to 0. */
function targetOf(w: string, t: Token, line: number): number {
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(?:lufs)?$/i.exec(w);
  const n = m ? Number(m[1]) : null;
  if (n === null || n < -60 || n > 0) throw new DiagError(line, t.col, `the loudness target is LUFS from -60 to 0, like -20 or -20LUFS (got '${w}')`);
  return n;
}

function seedOf(v: string, t: Token, line: number): number {
  const n = numberOf(v);
  if (n === null || !Number.isInteger(n) || n < 0 || n > 4294967295) throw new DiagError(line, t.col, `seed is a whole number from 0 to 4294967295 (got '${v}')`);
  return n;
}

function spreadOf(v: string, t: Token, line: number): SpreadRule[] {
  try { return parseSpread(v); } catch (e) { throw new DiagError(line, t.col, (e as Error).message); }
}

function parseSet(rest: Token[], head: Token, line: number): Command {
  const [verb, ...args] = rest;
  if (!verb) throw new DiagError(line, head.col, 'set: new, add, remove, retarget, class or regen');
  const id = checkId(args[0], line, `set ${verb.v}`);
  if (verb.v === 'new') {
    let from: string | null = null, count: number | null = null, target: number | null = null, seed: number | null = null;
    let cls: string | null = null, template: string | null = null, listed: string[] | null = null;
    let spread: SpreadRule[] = [];
    for (const t of args.slice(1)) {
      const m = /^(from|count|target|class|names|as|spread|seed)=(.*)$/s.exec(t.v);
      if (!m) throw new DiagError(line, t.col, `set new: unexpected '${t.v}' (from=<sound> count=<n> [target=<LUFS>] [class=<name>] [names="<template with {n}>" | as=<id>,<id>,...] [spread="<param>±<amount> ..."] [seed=<n>])`);
      const v = m[2]!.length >= 2 && m[2]!.startsWith('"') && m[2]!.endsWith('"') ? m[2]!.slice(1, -1) : m[2]!;
      if (m[1] === 'from') { if (!SOUND_ID_RE.test(v)) throw new DiagError(line, t.col, `'${v}' is not a sound id`); from = v; }
      else if (m[1] === 'count') {
        const n = numberOf(v);
        if (n === null || !Number.isInteger(n) || n < 1 || n > MAX_SET_MEMBERS) throw new DiagError(line, t.col, `count is a whole number from 1 to ${MAX_SET_MEMBERS} (got '${v}')`);
        count = n;
      } else if (m[1] === 'target') target = targetOf(v, t, line);
      else if (m[1] === 'class') {
        if (!CLASS_NAME_RE.test(v)) throw new DiagError(line, t.col, `class is a loudness class name (like ui, foley, impact), got '${v}'`);
        cls = v;
      } else if (m[1] === 'names') template = v;
      else if (m[1] === 'as') listed = v.split(',').filter(Boolean);
      else if (m[1] === 'seed') seed = seedOf(v, t, line);
      else spread = spreadOf(v, t, line);
    }
    if (!from || count === null) throw new DiagError(line, verb.col, `set new ${id}: give from=<sound> and count=<n> (the sound the variants are made from, and how many)`);
    if (template !== null && listed !== null) throw new DiagError(line, verb.col, 'set new: give names="<template>" or as=<id>,<id>,..., not both');
    let names: string[] | null = null;
    if (template !== null) {
      if (!template.includes('{n}')) throw new DiagError(line, verb.col, `set new: the names template needs {n} for the member number (like names="step_{n}"), got '${template}'`);
      names = Array.from({ length: count }, (_, k) => template!.replace('{n}', String(k + 1)));
    } else if (listed !== null) {
      if (listed.length !== count) throw new DiagError(line, verb.col, `set new: as= lists ${listed.length} ids but count=${count}`);
      names = listed;
    }
    if (names) {
      for (const n of names) if (!SOUND_ID_RE.test(n)) throw new DiagError(line, verb.col, `set new: '${n}' is not a sound id (a-z, A-Z, 0-9, _ and -, starting with a letter, at most 48 characters)`);
      if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) throw new DiagError(line, verb.col, 'set new: the member ids repeat (ids are unique ignoring case)');
    }
    return { op: 'set-new', id, from, count, target, class: cls, names, spread, seed, text: `set new ${id} from=${from} count=${count}${target !== null ? ` target=${fmtNumber(target)}` : ''}${spread.length ? ` spread=${quote(formatSpread(spread))}` : ''}${seed !== null ? ` seed=${seed}` : ''}` };
  }
  if (verb.v === 'add' || verb.v === 'remove') {
    const sounds = args.slice(1);
    if (!sounds.length) throw new DiagError(line, verb.col, `set ${verb.v} ${id}: name the sounds`);
    for (const t of sounds) if (!SOUND_ID_RE.test(t.v)) throw new DiagError(line, t.col, `'${t.v}' is not a sound id`);
    return { op: verb.v === 'add' ? 'set-add' : 'set-remove', id, sounds: sounds.map((t) => t.v), text: `set ${verb.v} ${id} ${sounds.map((t) => t.v).join(' ')}` };
  }
  if (verb.v === 'class') {
    const t = args[1];
    if (!t || args.length > 2 || (t.v !== 'none' && !CLASS_NAME_RE.test(t.v))) throw new DiagError(line, (t ?? verb).col, `set class ${id}: give a loudness class name (like ui, foley, impact), or none`);
    return { op: 'set-class', id, class: t.v === 'none' ? null : t.v, text: `set class ${id} ${t.v}` };
  }
  if (verb.v === 'retarget') {
    const t = args[1];
    if (!t || args.length > 2) throw new DiagError(line, (t ?? verb).col, `set retarget ${id}: give the loudness in LUFS (like -20), or none`);
    const w = t.v.replace(/^target=/, '');
    if (w === 'none') return { op: 'set-retarget', id, target: null, text: `set retarget ${id} none` };
    const n = targetOf(w, t, line);
    return { op: 'set-retarget', id, target: n, text: `set retarget ${id} ${fmtNumber(n)}` };
  }
  if (verb.v === 'regen') {
    let seed: number | null = null;
    let spread: SpreadRule[] | null = null;
    for (const t of args.slice(1)) {
      const m = /^(seed|spread)=(.*)$/s.exec(t.v);
      if (!m) throw new DiagError(line, t.col, `set regen: unexpected '${t.v}' (seed=<n>, spread="...")`);
      const v = m[2]!.length >= 2 && m[2]!.startsWith('"') && m[2]!.endsWith('"') ? m[2]!.slice(1, -1) : m[2]!;
      if (m[1] === 'seed') seed = seedOf(v, t, line);
      else spread = spreadOf(v, t, line);
    }
    return { op: 'set-regen', id, seed, spread, text: `set regen ${id}${seed !== null ? ` seed=${seed}` : ''}${spread ? ` spread=${quote(formatSpread(spread))}` : ''}` };
  }
  throw new DiagError(line, verb.col, `unknown set command '${verb.v}' (new, add, remove, retarget, class, regen)`);
}

function parseFamily(rest: Token[], head: Token, line: number): Command {
  const id = checkId(rest[0], line, 'family');
  const k = rest[1];
  if (!k || !isFamily(k.v)) throw new DiagError(line, (k ?? head).col, `family ${id}: give near, far or muffled`);
  let as: string | null = null;
  for (const t of rest.slice(2)) {
    const m = /^as=(.*)$/.exec(t.v);
    if (!m || !SOUND_ID_RE.test(m[1]!)) throw new DiagError(line, t.col, `family: unexpected '${t.v}' (as=<new sound id>)`);
    as = m[1]!;
  }
  return { op: 'family', id, kind: k.v, as, text: `family ${id} ${k.v}${as ? ` as=${as}` : ''}` };
}

function parseLine(l: RawLine): Command {
  const [head, ...rest] = l.tokens;
  const line = l.line;
  if (head!.v === 'sound') {
    const [verb, ...args] = rest;
    if (!verb) throw new DiagError(line, head!.col, 'sound: new, set, patch, generate, mutate, mark, layer-up, classic, loop, copy, rename or remove');
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
          if (!isGenerator(m[2]!) && !isRecipe(m[2]!)) throw new DiagError(line, t.col, `no preset '${m[2]}' (presets: ${[...GENERATOR_NAMES, ...RECIPE_NAMES, ...RECIPE_UMBRELLAS].join(', ')})`);
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
        if (!isParamName(name)) throw new DiagError(line, t.col, `no parameter '${name}' (tone: ${TONE_PARAMS.map((p) => p.name).join(', ')}; classic: ${CLASSIC_FIELDS.map((p) => p.name).join(', ')}, seed; layered: duration, gain, seed; any sound: class, loudness)`);
        let value: SetValue;
        if (name === 'class') {
          if (m[2] !== 'none' && !CLASS_NAME_RE.test(m[2]!)) throw new DiagError(line, t.col, `class is a loudness class name (like ui, foley, impact) or none (got '${m[2]}')`);
          value = m[2]!;
        } else if (name === 'loudness') value = m[2] === 'auto' || m[2] === 'none' ? 'auto' : targetOf(m[2]!, t, line);
        else if (name === 'wave' && (WAVE_NAMES as readonly string[]).includes(m[2]!)) value = (WAVE_NAMES as readonly string[]).indexOf(m[2]!);
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
          } else if (name === 'duration') {
            // a tone is 0.01 to 10 s and a layered sound up to 120: the voice decides when it is applied
            if (n < 0.01 || n > MAX_DURATION) throw new DiagError(line, t.col, `duration must be between 0.01 and ${MAX_DURATION} s (got ${n})`);
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
      return { op: 'set', id, values, text: `sound set ${id} ${values.map(([n, v]) => `${n}=${typeof v === 'string' ? v : n === 'wave' ? WAVE_NAMES[v] ?? fmtNumber(v) : fmtNumber(v)}`).join(' ')}` };
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
      if (!cat || (!isGenerator(cat.v) && !isRecipe(cat.v))) throw new DiagError(line, (cat ?? verb).col, `sound generate ${id}: give a category (${[...GENERATOR_NAMES, ...RECIPE_NAMES, ...RECIPE_UMBRELLAS].join(', ')})`);
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
    if (verb.v === 'loop') {
      const id = checkId(args[0], line, 'sound loop');
      const len = args[1];
      if (!len) throw new DiagError(line, verb.col, `sound loop ${id}: give the loop length in seconds (${LOOP_LENGTH.min} to ${LOOP_LENGTH.max}), or off`);
      let fade: number = LOOP_FADE.default;
      for (const t of args.slice(2)) {
        const m = /^fade=(.*)$/.exec(t.v);
        const n = m ? numberOf(m[1]!) : null;
        if (n === null) throw new DiagError(line, t.col, `sound loop ${id}: unexpected '${t.v}' (fade=<seconds>, ${LOOP_FADE.min} to ${LOOP_FADE.max})`);
        fade = n;
      }
      if (len.v === 'off') {
        if (args.length > 2) throw new DiagError(line, args[2]!.col, `sound loop ${id} off takes nothing more`);
        return { op: 'loop', id, loop: null, text: `sound loop ${id} off` };
      }
      const L = numberOf(len.v);
      if (L === null || L < LOOP_LENGTH.min || L > LOOP_LENGTH.max) throw new DiagError(line, len.col, `sound loop ${id}: the length is ${LOOP_LENGTH.min} to ${LOOP_LENGTH.max} seconds, or off (got '${len.v}')`);
      if (fade < LOOP_FADE.min || fade > LOOP_FADE.max || fade > L / 2) throw new DiagError(line, len.col, `sound loop ${id}: fade is ${LOOP_FADE.min} to ${LOOP_FADE.max} seconds and at most half the length (got ${fade})`);
      return { op: 'loop', id, loop: { length: L, fade }, text: `sound loop ${id} ${fmtNumber(L)} fade=${fmtNumber(fade)}` };
    }
    if (verb.v === 'copy' || verb.v === 'rename') {
      const id = checkId(args[0], line, `sound ${verb.v}`);
      const to = checkId(args[1], line, `sound ${verb.v} ${id}`);
      if (args.length > 2) throw new DiagError(line, args[2]!.col, `sound ${verb.v}: unexpected '${args[2]!.v}' (sound ${verb.v} <id> <new id>)`);
      return { op: verb.v, id, to, text: `sound ${verb.v} ${id} ${to}` };
    }
    if (verb.v === 'remove') {
      const id = checkId(args[0], line, 'sound remove');
      let fromSets = false;
      for (const t of args.slice(1)) {
        if (t.v === '--from-sets' || t.v === 'from-sets') fromSets = true;
        else throw new DiagError(line, t.col, `sound remove: unexpected '${t.v}' (--from-sets also takes it out of the sets that name it)`);
      }
      return { op: 'remove', id, fromSets, text: `sound remove ${id}${fromSets ? ' --from-sets' : ''}` };
    }
    if (verb.v === 'mark') {
      const id = checkId(args[0], line, 'sound mark');
      const st = args[1];
      if (!st || !['approved', 'rejected', 'draft'].includes(st.v)) throw new DiagError(line, (st ?? verb).col, 'sound mark: the mark is approved, rejected or draft');
      if (args.length > 3) throw new DiagError(line, args[3]!.col, `sound mark: put the note in quotes (unexpected '${args[3]!.v}')`);
      const note = args[2]?.v ?? '';
      return { op: 'mark', id, status: st.v as SoundStatus, note, text: `sound mark ${id} ${st.v}${note ? ' ' + quote(note) : ''}` };
    }
    throw new DiagError(line, verb.col, `unknown sound command '${verb.v}' (new, set, patch, generate, mutate, mark, layer-up, classic, loop, copy, rename, remove)`);
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
  if (head!.v === 'set') return parseSet(rest, head!, line);
  if (head!.v === 'family') return parseFamily(rest, head!, line);
  if (head!.v === 'layer') return parseLayer(rest, head!, line);
  if (head!.v === 'fx') return parseFx(rest, head!, line);
  if (head!.v === 'env') return parseEnvCommand(rest, head!, line);
  throw new DiagError(line, head!.col, `unknown command '${head!.v}' (sound, layer, fx, env, set, family, mutate, undo, redo)`);
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


const VOICE_PARAM_HINT = (v: VoiceKind): string => voiceParams(v).map((p) => p.name).join(', ');

/**
 * Apply a sound command to the library; throws a plain Error saying why it cannot. Returns the
 * command's normal form when applying settled something the text left open (a default seed), which
 * is what goes on the tape; otherwise undefined.
 */
/** Throws when a new sound named `id` would clash with one that exists, ignoring case. */
function checkFree(lib: Library, id: string, hint?: string): void {
  const clash = idClash(lib.keys(), id);
  if (clash) throw new Error(`sound '${id}' exists already${clash !== id ? ` as '${clash}' (ids are unique ignoring case)` : ''}${hint ? ` (${hint})` : ''}`);
}

export function applyCommand(lib: Library, c: Command): string | undefined {
  switch (c.op) {
    case 'new': {
      checkFree(lib, c.id);
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
      const marks = c.values.filter(([n]) => n === 'class' || n === 'loudness');
      for (const [n, v] of marks) {
        if (n === 'class') { if (v === 'none') delete next.loudClass; else next.loudClass = v as string; }
        else if (v === 'auto') delete next.loudness;
        else next.loudness = v as number;
      }
      const values = c.values.filter(([n]) => n !== 'class' && n !== 'loudness');
      if (next.voice === 'layered') {
        for (const [n, v] of values) {
          if (n === 'duration') next.duration = v === 'auto' ? null : checkNumber(specOf(SOUND_SPECS, 'duration')!, v as number, c.id);
          else if (n === 'gain' || n === 'seed') {
            if (v === 'auto') throw new Error(`${c.id}: a layered sound's seed is a number (it has no auto)`);
            (next as unknown as Record<string, number>)[n] = checkNumber(specOf(SOUND_SPECS, n)!, v as number, c.id);
          } else throw new Error(`${c.id} is a layered sound: sound set takes duration, gain, seed, class and loudness (layers have layer set, effects have fx set)`);
        }
        lib.set(c.id, next);
        return undefined;
      }
      for (const [n, v] of values) {
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
        const one: LayeredSound = { ...s, seed: c.seed, duration: null, layers: [classicLayer(generate(c.category as GeneratorName, c.seed), 1)], master: [], nextSalt: 2 };
        delete one.loop;
        delete one.family;
        lib.set(c.id, one);
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
      if (c.as) checkFree(lib, c.as);
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
    case 'loop': {
      const s = lib.get(c.id);
      if (!s) throw new Error(`no sound '${c.id}'`);
      if (s.voice !== 'layered') throw new Error(`${c.id} is a ${s.voice} sound; a loop is for a layered sound${s.voice === 'classic' ? ` (sound layer-up ${c.id} makes this one layered, sample for sample)` : ''}`);
      const next = cloneSound(s);
      if (c.loop) {
        next.loop = { ...c.loop };
        raiseLayersForLoop(next, c.loop);
      } else delete next.loop;
      lib.set(c.id, next);
      return undefined;
    }
    case 'set-new': {
      if (lib.sets.has(c.id)) throw new Error(`set '${c.id}' exists already`);
      const src = lib.get(c.from);
      if (!src) throw new Error(`no sound '${c.from}' to make the set from`);
      if (src.voice === 'tone') throw new Error(`${c.from} is a tone: a set is made from a classic or layered sound`);
      if (!c.names) checkMemberIds(c.id, c.count);
      checkSpread(src, c.spread);
      const seed = c.seed ?? defaultSetSeed(c.id, c.from);
      const ids = c.names ?? Array.from({ length: c.count }, (_, k) => memberId(c.id, k));
      for (const id of ids) checkFree(lib, id, c.names ? undefined : `a set's members are named ${c.id}_1, ${c.id}_2 ... unless names= or as= give them`);
      const pos = spreadPositions(seed, c.spread, c.count);
      ids.forEach((id, k) => lib.set(id, makeMember(src, id, c.spread, seed, k, c.count, pos)));
      lib.sets.set(c.id, { id: c.id, from: c.from, seed, target: c.target, ...(c.class ? { class: c.class } : {}), spread: c.spread, members: ids, generated: [...ids] });
      return `set new ${c.id} from=${c.from} count=${c.count}${c.target !== null ? ` target=${fmtNumber(c.target)}` : ''}${c.class ? ` class=${c.class}` : ''}${c.names ? ` as=${c.names.join(',')}` : ''}${c.spread.length ? ` spread=${quote(formatSpread(c.spread))}` : ''} seed=${seed}`;
    }
    case 'set-add':
    case 'set-remove': {
      const set = lib.sets.get(c.id);
      if (!set) throw new Error(`no set '${c.id}'${lib.sets.size ? ` (sets: ${[...lib.sets.keys()].join(', ')})` : ''}`);
      for (const id of c.sounds) {
        if (c.op === 'set-add') {
          if (!lib.has(id)) throw new Error(`no sound '${id}'`);
          if (set.members.includes(id)) throw new Error(`${id} is in ${c.id} already`);
        } else if (!set.members.includes(id)) throw new Error(`${id} is not in ${c.id}`);
      }
      const members = c.op === 'set-add' ? [...set.members, ...c.sounds] : set.members.filter((m) => !c.sounds.includes(m));
      lib.sets.set(c.id, { ...set, members, generated: set.generated.filter((m) => members.includes(m)) });
      return undefined;
    }
    case 'set-retarget': {
      const set = lib.sets.get(c.id);
      if (!set) throw new Error(`no set '${c.id}'`);
      lib.sets.set(c.id, { ...set, target: c.target });
      return undefined;
    }
    case 'set-class': {
      const set = lib.sets.get(c.id);
      if (!set) throw new Error(`no set '${c.id}'`);
      const next = { ...set };
      if (c.class) next.class = c.class;
      else delete next.class;
      lib.sets.set(c.id, next);
      return undefined;
    }
    case 'copy': {
      const s = lib.get(c.id);
      if (!s) throw new Error(`no sound '${c.id}'`);
      checkFree(lib, c.to, 'name the copy with sound copy <id> <new id>');
      const copy = cloneSound(s);
      copy.id = c.to;
      copy.status = 'draft';
      lib.set(c.to, copy);
      return undefined;
    }
    case 'rename': {
      const s = lib.get(c.id);
      if (!s) throw new Error(`no sound '${c.id}'`);
      if (c.to !== c.id) {
        const clash = idClash(lib.keys(), c.to);
        if (clash && clash !== c.id) throw new Error(`sound '${c.to}' exists already${clash !== c.to ? ` as '${clash}' (ids are unique ignoring case)` : ''}`);
      }
      const moved = cloneSound(s);
      moved.id = c.to;
      lib.delete(c.id);
      lib.set(c.to, moved);
      for (const [k, set] of lib.sets) {
        if (set.from !== c.id && !set.members.includes(c.id) && !set.generated.includes(c.id)) continue;
        const sw = (x: string): string => (x === c.id ? c.to : x);
        lib.sets.set(k, { ...set, from: set.from === null ? null : sw(set.from), members: set.members.map(sw), generated: set.generated.map(sw) });
      }
      for (const [k, other] of lib.entries()) {
        if (other.voice === 'layered' && other.family?.of === c.id) lib.set(k, { ...cloneSound(other), family: { ...other.family, of: c.to } });
      }
      return undefined;
    }
    case 'remove': {
      if (!lib.has(c.id)) throw new Error(`no sound '${c.id}'`);
      const naming = [...lib.sets.values()].filter((set) => set.members.includes(c.id) || set.from === c.id);
      if (naming.length && !c.fromSets) {
        throw new Error(`${c.id} is named by ${naming.map((x) => `set ${x.id}`).join(', ')}: take it out first (set remove ${naming[0]!.id} ${c.id}), or sound remove ${c.id} --from-sets`);
      }
      for (const set of naming) {
        lib.sets.set(set.id, { ...set, from: set.from === c.id ? null : set.from, members: set.members.filter((m) => m !== c.id), generated: set.generated.filter((m) => m !== c.id) });
      }
      lib.delete(c.id);
      return undefined;
    }
    case 'set-regen': {
      const set = lib.sets.get(c.id);
      if (!set) throw new Error(`no set '${c.id}'`);
      if (!set.from) throw new Error(`set ${c.id} was not made from a sound: nothing to regenerate from`);
      const src = lib.get(set.from);
      if (!src) throw new Error(`no sound '${set.from}' to regenerate ${c.id} from`);
      if (!set.generated.length) throw new Error(`set ${c.id} has no generated members (set new makes them; added sounds are not regenerated)`);
      const spread = c.spread ?? set.spread;
      checkSpread(src, spread);
      const seed = c.seed ?? hashText(`regen:${set.seed}`);
      const pos = spreadPositions(seed, spread, set.generated.length);
      set.generated.forEach((id, k) => {
        if (!lib.has(id)) throw new Error(`no sound '${id}' (a generated member of ${c.id})`);
        lib.set(id, makeMember(src, id, spread, seed, k, set.generated.length, pos));
      });
      lib.sets.set(c.id, { ...set, seed, spread });
      return `set regen ${c.id} seed=${seed}${c.spread ? ` spread=${quote(formatSpread(c.spread))}` : ''}`;
    }
    case 'family': {
      const src = lib.get(c.id);
      if (!src) throw new Error(`no sound '${c.id}'`);
      const as = c.as ?? `${c.id}_${c.kind}`;
      if (!SOUND_ID_RE.test(as)) throw new Error(`'${as}' is not a sound id (name the variant with as=<id>)`);
      checkFree(lib, as, 'name the variant with as=<id>');
      lib.set(as, makeFamily(src, c.kind, as, defaultRecipeSeed('layered', as)));
      return `family ${c.id} ${c.kind} as=${as}`;
    }
    case 'undo':
    case 'redo':
      throw new Error(`${c.op} is applied by the history, not to a sound`);
    default:
      return applyLayerCommand(lib, c);
  }
}
