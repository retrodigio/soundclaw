// Samples as part of the project document. A sample is named audio kept once, by content, in the project's
// store; the tape says which audio a name stands for (`sample add <name> hash=…`), where it came from and
// under what licence. Everything that fetches, decodes or measures happens once, when a command runs, and its
// result is written into the command as plain numbers, so replay never reads a file.
//
//   sample add <name> hash=<sha256> rate= channels= frames= format= [root=C4] [tune=<cents>] [loop=<s>-<e>]
//       [loopmode=none|sustain|continuous|oneshot] [slices=<f>,<f>...] [tags=a,b] [gain=<dB>] [note="…"]
//       [source=file|library|recorded|generated|derived|bounce|instrument-import] [origin="…"] [orig-hash=] [orig-format=]
//       [date=] [author=] [provider=] [endpoint=] [model=] [prompt="…"] [params="…"] [seed=] [take=<n>/<m>]
//       [request=] [credits=] [parents=<hash>,…] [ops="…"] [licence=<id>] [attribution="…"] [terms=<url>]
//   sample set <name> <field>=<value>... (field=none clears an optional field; hash= needs rate, channels, frames, format)
//   sample rename <name> <new name>
//   sample remove <name>

import { DiagError, quote, type Command, type Token } from './commands.ts';
import { noteLabel } from './music.ts';
import { PCM_FORMATS, SAMPLE_LIMITS, type PcmFormat } from './pcm.ts';
import type { Library } from './sets.ts';
import { AUTHOR_RE } from './commands.ts';
import { cloneLayered, fxSamples, layerSamples, type Fx, type LayeredSound } from './layered.ts';
import { cloneSong, type SongDoc } from './song.ts';
import type { Sound } from './sound.ts';

/** A sample's name keeps its case, like a sound's id; two names that differ only in case are one name too many. */
export const SAMPLE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

export const SOURCE_KINDS_OF_SAMPLE = ['file', 'library', 'recorded', 'generated', 'derived', 'bounce', 'instrument-import'] as const;
export type SampleSource = (typeof SOURCE_KINDS_OF_SAMPLE)[number];
export const LOOP_MODES = ['none', 'sustain', 'continuous', 'oneshot'] as const;
export type LoopMode = (typeof LOOP_MODES)[number];

export interface SampleProvenance {
  source: SampleSource;
  /** A file name, or a library id and the path inside it. Never an absolute path from a person's disk. */
  origin?: string;
  origHash?: string;
  origFormat?: string;
  /** The SHA-256 of the SFZ or SoundFont 2 file an instrument import took this sample from (a SoundFont's samples are cut from it). */
  containerHash?: string;
  date?: string;
  author?: string;
  provider?: string;
  endpoint?: string;
  model?: string;
  prompt?: string;
  params?: string;
  seed?: number;
  take?: string;
  /** For a kept take: the name it was generated under (the Takes list and the history survive a tag edit). */
  keptFrom?: string;
  request?: string;
  credits?: number;
  parents?: string[];
  ops?: string;
}

export interface SampleLicence {
  /** An SPDX id (`CC0-1.0`, `CC-BY-4.0`), or `own`, `generated:<provider>:<plan>`, `proprietary:<note>` or `unknown`. */
  id: string;
  attribution?: string;
  terms?: string;
}

export interface SampleEntry {
  name: string;
  /** The canonical hash of the audio (pcm.ts). */
  hash: string;
  rate: number;
  channels: number;
  frames: number;
  format: PcmFormat;
  /** The pitch the audio sounds at, as a MIDI note, and a tuning offset in cents. */
  root?: number;
  tune?: number;
  /** Loop points in frames, and how the loop is played. */
  loop?: [number, number];
  loopMode?: LoopMode;
  /** Slice points in frames, ascending. */
  slices?: number[];
  tags: string[];
  note?: string;
  /** A level (dB) the sample is played at when nothing says otherwise. */
  gain?: number;
  prov: SampleProvenance;
  licence: SampleLicence;
}

export const cloneSample = (e: SampleEntry): SampleEntry => ({
  ...e,
  ...(e.loop ? { loop: [...e.loop] as [number, number] } : {}),
  ...(e.slices ? { slices: [...e.slices] } : {}),
  tags: [...e.tags],
  prov: { ...e.prov, ...(e.prov.parents ? { parents: [...e.prov.parents] } : {}) },
  licence: { ...e.licence },
});

export const seconds = (e: Pick<SampleEntry, 'frames' | 'rate'>): number => e.frames / e.rate;

/**
 * What a render key holds for a sample: its audio's hash and, when it has them, its slice and loop points (a layer's `slice=` and `loop=` read
 * them, and they change without the audio changing). A sample with neither is just its hash, so keys made before slices existed are unchanged.
 */
export function sampleKeyPart(e: { hash: string; slices?: readonly number[]; loop?: readonly number[] }): string {
  const meta = `${e.slices?.length ? 's' + e.slices.join(',') : ''}${e.loop ? 'l' + e.loop.join('-') : ''}`;
  return meta ? `${e.hash}~${meta}` : e.hash;
}

// ---- fields ----------------------------------------------------------------------------------------------------------

/** The keys of `sample add` and `sample set`, in the order they are written. */
export const SAMPLE_FIELDS = [
  'hash', 'rate', 'channels', 'frames', 'format',
  'root', 'tune', 'loop', 'loopmode', 'slices', 'tags', 'gain', 'note',
  'source', 'origin', 'orig-hash', 'orig-format', 'container-hash', 'date', 'author', 'provider', 'endpoint', 'model', 'prompt', 'params', 'seed', 'take', 'kept-from', 'request', 'credits', 'parents', 'ops',
  'licence', 'attribution', 'terms',
] as const;
type Field = (typeof SAMPLE_FIELDS)[number];

const HASH_RE = /^[0-9a-f]{64}$/;
const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** `C4`, `F#3`, `Bb2` or a number 0-127: a MIDI note (C4 = 60). */
export function parseRoot(s: string): number | null {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(s);
  if (m) {
    const n = (Number(m[3]) + 1) * 12 + LETTER[m[1]!]! + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    return n >= 0 && n <= 127 ? n : null;
  }
  return /^\d{1,3}$/.test(s) && Number(s) <= 127 ? Number(s) : null;
}

const num = (s: string): number | null => (/^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : null);
const int = (s: string): number | null => (/^\d+$/.test(s) && s.length < 16 ? Number(s) : null);
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const TAG_RE = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
/** An absolute path on a person's disk (or a home folder): never kept in a document that may be committed. */
const ABS_PATH_RE = /^(\/|\\|~|[A-Za-z]:[\\/])/;

/** Fields that can be cleared with `none` in a `sample set`. */
const CLEARABLE = new Set<string>(['root', 'tune', 'loop', 'loopmode', 'slices', 'tags', 'gain', 'note', 'attribution', 'terms']);

/** Check one field's value and give it in its normal form (a plain Error says what is wrong). */
function normField(k: Field, v: string): string {
  const bad = (m: string): never => { throw new Error(`${k}=${v.length > 40 ? v.slice(0, 37) + '...' : v}: ${m}`); };
  switch (k) {
    case 'hash': return HASH_RE.test(v) ? v : bad('a sample hash is 64 lowercase hex digits (the SHA-256 the store printed)');
    case 'rate': { const n = int(v); return n !== null && n >= 3000 && n <= SAMPLE_LIMITS.maxRate ? String(n) : bad(`a rate in Hz, 3000-${SAMPLE_LIMITS.maxRate}`); }
    case 'channels': { const n = int(v); return n !== null && n >= 1 && n <= SAMPLE_LIMITS.maxChannels ? String(n) : bad(`1-${SAMPLE_LIMITS.maxChannels} channels`); }
    case 'frames': { const n = int(v); return n !== null && n >= 2 && n <= SAMPLE_LIMITS.maxSeconds * SAMPLE_LIMITS.maxRate ? String(n) : bad('a whole number of frames, 2 or more'); }
    case 'format': return (PCM_FORMATS as readonly string[]).includes(v) ? v : bad(`the stored format is ${PCM_FORMATS.join(', ')}`);
    case 'root': { const n = parseRoot(v); return n !== null ? noteLabel(n) : bad('a note like C4 or F#3 (or a MIDI number 0-127)'); }
    case 'tune': { const n = num(v); return n !== null && Math.abs(n) <= 100 ? String(n) : bad('cents, -100 to 100'); }
    case 'loop': {
      const m = /^(\d+)-(\d+)$/.exec(v);
      return m && Number(m[1]) < Number(m[2]) ? `${Number(m[1])}-${Number(m[2])}` : bad('<start>-<end> in frames, start before end');
    }
    case 'loopmode': return (LOOP_MODES as readonly string[]).includes(v) ? v : bad(`the loop mode is ${LOOP_MODES.join(', ')}`);
    case 'slices': {
      const xs = v.split(',').map((x) => int(x));
      if (xs.some((x) => x === null) || xs.length > 1024 || xs.some((x, i) => i > 0 && x! <= xs[i - 1]!)) bad('frame numbers, ascending, at most 1024');
      return xs.join(',');
    }
    case 'tags': {
      const ts = [...new Set(v.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
      if (!ts.length || ts.length > 32 || ts.some((t) => !TAG_RE.test(t))) bad('up to 32 tags of letters, digits, _ . and -, comma separated');
      return ts.join(',');
    }
    case 'gain': { const n = num(v); return n !== null && n >= -60 && n <= 24 ? String(n) : bad('dB, -60 to 24'); }
    case 'note': return v.length <= 400 ? v : bad('at most 400 characters');
    case 'source': return (SOURCE_KINDS_OF_SAMPLE as readonly string[]).includes(v) ? v : bad(`the source is ${SOURCE_KINDS_OF_SAMPLE.join(', ')}`);
    case 'origin':
      if (/^https?:\/\//.test(v)) return v.length <= 300 ? v : bad('at most 300 characters');
      if (ABS_PATH_RE.test(v)) bad('a file name (or a library id and the path inside it), not an absolute path from your disk');
      return v.length <= 300 ? v : bad('at most 300 characters');
    case 'orig-hash': case 'container-hash': return HASH_RE.test(v) ? v : bad('64 lowercase hex digits');
    case 'orig-format': return v.length <= 60 ? v : bad('at most 60 characters');
    case 'date': return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/.test(v) ? v : bad('a UTC date like 2026-11-09T10:00:00Z');
    case 'author': return AUTHOR_RE.test(v) || /^system:[A-Za-z0-9_.-]{1,32}$/.test(v) ? v : bad('agent:<name>, human:<name> or system:<name>');
    case 'provider': case 'endpoint': case 'model': case 'request': return TOKEN_RE.test(v) || (k === 'request' && v.length <= 120 && !/\s/.test(v)) ? v : bad('letters, digits and . _ : - (at most 80)');
    case 'prompt': case 'params': return v.length <= 2000 ? v : bad('at most 2000 characters');
    case 'ops': return v.length <= 1000 ? v : bad('at most 1000 characters');
    case 'seed': { const n = int(v); return n !== null ? String(n) : bad('a whole number'); }
    case 'kept-from': return SAMPLE_NAME_RE.test(v) ? v : bad('a sample name');
    case 'take': return /^[1-9]\d?\/[1-9]\d?$/.test(v) && Number(v.split('/')[0]) <= Number(v.split('/')[1]) ? v : bad('<n>/<m>, like 2/3');
    case 'credits': { const n = num(v); return n !== null && n >= 0 ? String(n) : bad('credits, a number of 0 or more'); }
    case 'parents': {
      const hs = v.split(',');
      return hs.length <= 16 && hs.every((h) => HASH_RE.test(h)) ? v : bad('up to 16 sample hashes, comma separated');
    }
    case 'licence': return v.length <= 200 && /^(own|unknown|generated:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+|proprietary:.+|[A-Za-z0-9][A-Za-z0-9.+-]*)$/s.test(v) ? v : bad('an SPDX id (CC0-1.0, CC-BY-4.0), own, unknown, generated:<provider>:<plan> or proprietary:<note>');
    case 'attribution': return v.length <= 400 ? v : bad('at most 400 characters');
    case 'terms': return /^https?:\/\/\S{1,290}$/.test(v) ? v : bad('an http(s) address');
  }
}

/** A value as a tape word: bare when it is safe, else quoted. */
function word(v: string): string {
  return /^[^\s"\\;]+$/.test(v) ? v : quote(v);
}

export type SampleCommand =
  | { op: 'sample-add'; name: string; fields: Partial<Record<Field, string>>; text: string }
  | { op: 'sample-set'; name: string; fields: Partial<Record<Field, string>>; clear: Field[]; text: string }
  | { op: 'sample-rename'; name: string; to: string; text: string }
  | { op: 'sample-remove'; name: string; text: string }
  // measured or computed when the writer runs them, and put on the tape as the plain commands they found (`sample add`, `sample set`)
  | { op: 'sample-derive'; name: string; from: string; chain: string; fields: Partial<Record<Field, string>>; text: string }
  | { op: 'sample-bounce'; name: string; from: string; layer: number | null; channel: string | null; loop: boolean; fields: Partial<Record<Field, string>>; text: string }
  | { op: 'sample-slice'; name: string; how: SliceHow; text: string }
  | { op: 'sample-loop'; name: string; how: LoopHow; text: string };

export type SliceHow =
  | { kind: 'onsets'; sensitivity: number | null; minGap: number | null }
  | { kind: 'at'; times: string[] }
  | { kind: 'grid'; n: number; tempo: number | null };
export type LoopHow =
  | { kind: 'find'; near: [string, string] | null; min: string | null }
  | { kind: 'set'; start: string; end: string };

const isSampleOpName = (op: string): op is SampleCommand['op'] => op.startsWith('sample-');
export const isSampleOp = isSampleOpName;

const fieldsText = (f: Partial<Record<Field, string>>, clear: readonly Field[] = []): string =>
  SAMPLE_FIELDS.flatMap((k) => (f[k] !== undefined ? [` ${k}=${word(f[k]!)}`] : clear.includes(k) ? [` ${k}=none`] : [])).join('');

function checkName(t: Token | undefined, line: number, what: string): string {
  if (!t) throw new DiagError(line, 1, `${what}: give the sample's name`);
  if (!SAMPLE_NAME_RE.test(t.v)) throw new DiagError(line, t.col, `'${t.v}' is not a sample name (letters, digits, _ and -, at most 48 characters)`);
  return t.v;
}

/** An entry as the fields of a `sample add`. */
function entryFields(e: SampleEntry): Partial<Record<Field, string>> {
  return {
    hash: e.hash, rate: String(e.rate), channels: String(e.channels), frames: String(e.frames), format: e.format,
    ...(e.root !== undefined ? { root: noteLabel(e.root) } : {}), ...(e.tune !== undefined ? { tune: String(e.tune) } : {}),
    ...(e.loop ? { loop: `${e.loop[0]}-${e.loop[1]}` } : {}), ...(e.loopMode ? { loopmode: e.loopMode } : {}),
    ...(e.slices?.length ? { slices: e.slices.join(',') } : {}), ...(e.tags.length ? { tags: e.tags.join(',') } : {}),
    ...(e.gain !== undefined ? { gain: String(e.gain) } : {}), ...(e.note ? { note: e.note } : {}),
    source: e.prov.source,
    ...(e.prov.origin ? { origin: e.prov.origin } : {}), ...(e.prov.origHash ? { 'orig-hash': e.prov.origHash } : {}), ...(e.prov.origFormat ? { 'orig-format': e.prov.origFormat } : {}), ...(e.prov.containerHash ? { 'container-hash': e.prov.containerHash } : {}),
    ...(e.prov.date ? { date: e.prov.date } : {}), ...(e.prov.author ? { author: e.prov.author } : {}),
    ...(e.prov.provider ? { provider: e.prov.provider } : {}), ...(e.prov.endpoint ? { endpoint: e.prov.endpoint } : {}), ...(e.prov.model ? { model: e.prov.model } : {}),
    ...(e.prov.prompt ? { prompt: e.prov.prompt } : {}), ...(e.prov.params ? { params: e.prov.params } : {}),
    ...(e.prov.seed !== undefined ? { seed: String(e.prov.seed) } : {}), ...(e.prov.take ? { take: e.prov.take } : {}), ...(e.prov.keptFrom ? { 'kept-from': e.prov.keptFrom } : {}), ...(e.prov.request ? { request: e.prov.request } : {}),
    ...(e.prov.credits !== undefined ? { credits: String(e.prov.credits) } : {}), ...(e.prov.parents?.length ? { parents: e.prov.parents.join(',') } : {}), ...(e.prov.ops ? { ops: e.prov.ops } : {}),
    licence: e.licence.id, ...(e.licence.attribution ? { attribution: e.licence.attribution } : {}), ...(e.licence.terms ? { terms: e.licence.terms } : {}),
  };
}

/** The text of a `sample add` for an entry (the form the tape holds). */
export function sampleAddText(e: SampleEntry): string {
  return `sample add ${e.name}${fieldsText(entryFields(e))}`;
}

/** Parse a `sample …` command. */
export function parseSample(head: Token, rest: Token[], line: number): Command {
  const [verb, ...args] = rest;
  if (!verb) throw new DiagError(line, head.col, 'sample: add, set, rename or remove (importing a file is `soundclaw sample import`, or the sample tool\'s import)');
  if (verb.v === 'add' || verb.v === 'set') {
    const name = checkName(args[0], line, `sample ${verb.v}`);
    const fields: Partial<Record<Field, string>> = {};
    const clear: Field[] = [];
    for (const t of args.slice(1)) {
      const m = /^([A-Za-z][A-Za-z-]*)=(.*)$/s.exec(t.v);
      if (!m) throw new DiagError(line, t.col, `sample ${verb.v} ${name}: '${t.v}' is not <field>=<value>`);
      let k = m[1]!;
      if (k === 'license') k = 'licence';
      if (!(SAMPLE_FIELDS as readonly string[]).includes(k)) throw new DiagError(line, t.col, `sample ${verb.v} ${name}: no field '${k}' (fields: ${SAMPLE_FIELDS.join(', ')})`);
      let v = m[2]!;
      if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      if ((fields as Record<string, string>)[k] !== undefined || clear.includes(k as Field)) throw new DiagError(line, t.col, `sample ${verb.v} ${name}: ${k} is given twice`);
      if (v === 'none' && verb.v === 'set' && CLEARABLE.has(k)) { clear.push(k as Field); continue; }
      try { (fields as Record<string, string>)[k] = normField(k as Field, v); } catch (e) { throw new DiagError(line, t.col, `sample ${verb.v} ${name}: ${(e as Error).message}`); }
    }
    if (verb.v === 'add') {
      for (const k of ['hash', 'rate', 'channels', 'frames', 'format'] as const) if (fields[k] === undefined) throw new DiagError(line, verb.col, `sample add ${name}: ${k}= is needed (\`soundclaw sample import\` works out hash, rate, channels, frames and format from a file)`);
      if (fields.loop && !fields.loopmode) fields.loopmode = 'sustain';
      const loop = fields.loop?.split('-').map(Number);
      if (loop && loop[1]! > Number(fields.frames)) throw new DiagError(line, verb.col, `sample add ${name}: the loop ends at frame ${loop[1]}, past the ${fields.frames} frames`);
      fields.source ??= 'file';
      fields.licence ??= 'unknown';
      return { op: 'sample-add', name, fields, text: `sample add ${name}${fieldsText(fields)}` } as unknown as Command;
    }
    if (!Object.keys(fields).length && !clear.length) throw new DiagError(line, verb.col, `sample set ${name}: give at least one <field>=<value>`);
    if (fields.hash !== undefined) {
      for (const k of ['rate', 'channels', 'frames', 'format'] as const) if (fields[k] === undefined) throw new DiagError(line, verb.col, `sample set ${name}: pointing a name at other audio needs rate=, channels=, frames= and format= too`);
    } else for (const k of ['rate', 'channels', 'frames', 'format'] as const) if (fields[k] !== undefined) throw new DiagError(line, verb.col, `sample set ${name}: ${k}= describes the audio and goes with hash=`);
    return { op: 'sample-set', name, fields, clear, text: `sample set ${name}${fieldsText(fields, clear)}` } as unknown as Command;
  }
  if (verb.v === 'rename') {
    const name = checkName(args[0], line, 'sample rename');
    const to = checkName(args[1], line, `sample rename ${name}`);
    if (args.length > 2) throw new DiagError(line, args[2]!.col, `sample rename: unexpected '${args[2]!.v}'`);
    return { op: 'sample-rename', name, to, text: `sample rename ${name} ${to}` } as unknown as Command;
  }
  if (verb.v === 'remove') {
    const name = checkName(args[0], line, 'sample remove');
    if (args.length > 1) throw new DiagError(line, args[1]!.col, `sample remove: unexpected '${args[1]!.v}'`);
    return { op: 'sample-remove', name, text: `sample remove ${name}` } as unknown as Command;
  }
  if (verb.v === 'derive' || verb.v === 'bounce') return parseDerive(verb, args, line);
  if (verb.v === 'slice') return parseSlice(verb, args, line);
  if (verb.v === 'loop') return parseLoop(verb, args, line);
  throw new DiagError(line, verb.col, `unknown sample command '${verb.v}' (add, set, rename, remove, derive, bounce, slice, loop; \`soundclaw sample import\` brings a file in)`);
}

// ---- derive, bounce, slice, loop (parsed here, worked out by the writer) ------------------------------------------------

/** The fields a derived or bounced sample may be given (the audio's facts and its provenance are worked out). */
const MADE_FIELDS = ['root', 'tune', 'tags', 'gain', 'note', 'licence', 'attribution', 'terms'] as const;

/** `k=v` words: the named options come back apart, the rest must be fields a made sample may be given. */
function madeWords(args: Token[], line: number, what: string, options: readonly string[]): { opts: Map<string, string>; fields: Partial<Record<Field, string>> } {
  const opts = new Map<string, string>();
  const fields: Partial<Record<Field, string>> = {};
  for (const t of args) {
    const m = /^([A-Za-z][A-Za-z-]*)=(.*)$/s.exec(t.v);
    if (!m) throw new DiagError(line, t.col, `${what}: '${t.v}' is not <name>=<value>`);
    let k = m[1]!;
    if (k === 'license') k = 'licence';
    let v = m[2]!;
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (options.includes(k)) { if (opts.has(k)) throw new DiagError(line, t.col, `${what}: ${k} is given twice`); opts.set(k, v); continue; }
    if (!(MADE_FIELDS as readonly string[]).includes(k)) throw new DiagError(line, t.col, `${what}: no option '${k}' (${[...options, ...MADE_FIELDS].join(', ')})`);
    if ((fields as Record<string, string>)[k] !== undefined) throw new DiagError(line, t.col, `${what}: ${k} is given twice`);
    try { (fields as Record<string, string>)[k] = normField(k as Field, v); } catch (e) { throw new DiagError(line, t.col, `${what}: ${(e as Error).message}`); }
  }
  return { opts, fields };
}

function parseDerive(verb: Token, args: Token[], line: number): Command {
  const bounce = verb.v === 'bounce';
  const name = checkName(args[0], line, `sample ${verb.v}`);
  const { opts, fields } = madeWords(args.slice(1), line, `sample ${verb.v} ${name}`, bounce ? ['from', 'layer', 'channel', 'loop'] : ['from', 'op']);
  const from = opts.get('from');
  if (!from) throw new DiagError(line, verb.col, `sample ${verb.v} ${name}: from=<${bounce ? 'sound or song' : 'sample'}> is needed`);
  const tail = fieldsText(fields);
  if (bounce) {
    const layer = opts.has('layer') ? Number(opts.get('layer')) : null;
    if (layer !== null && !(Number.isInteger(layer) && layer >= 1)) throw new DiagError(line, verb.col, `sample bounce ${name}: layer= is a layer number from 1`);
    const loop = opts.get('loop');
    if (loop !== undefined && !['yes', 'no'].includes(loop)) throw new DiagError(line, verb.col, `sample bounce ${name}: loop= is yes or no`);
    const channel = opts.get('channel') ?? null;
    return { op: 'sample-bounce', name, from, layer, channel, loop: loop === 'yes', fields, text: `sample bounce ${name} from=${from}${layer !== null ? ` layer=${layer}` : ''}${channel ? ` channel=${channel}` : ''}${loop === 'yes' ? ' loop=yes' : ''}${tail}` } as unknown as Command;
  }
  const chain = opts.get('op');
  if (!chain || !chain.trim()) throw new DiagError(line, verb.col, `sample derive ${name}: op="<operations>" is needed, like op="silence-trim -50; fade out=80ms"`);
  return { op: 'sample-derive', name, from, chain, fields, text: `sample derive ${name} from=${from} op=${quote(chain)}${tail}` } as unknown as Command;
}

function parseSlice(verb: Token, args: Token[], line: number): Command {
  const name = checkName(args[0], line, 'sample slice');
  const kv = new Map<string, string>();
  for (const t of args.slice(1)) {
    const m = /^([a-z-]+)=(.*)$/.exec(t.v);
    if (!m || !['at', 'sensitivity', 'min-gap', 'grid', 'tempo'].includes(m[1]!)) throw new DiagError(line, t.col, `sample slice ${name}: '${t.v}' is not at=, sensitivity=, min-gap=, grid= or tempo=`);
    kv.set(m[1]!, m[2]!);
  }
  const numOpt = (k: string): number | null => {
    if (!kv.has(k)) return null;
    const n = num(kv.get(k)!);
    if (n === null || n <= 0) throw new DiagError(line, verb.col, `sample slice ${name}: ${k}= is a number above 0`);
    return n;
  };
  const at = kv.get('at');
  if (at === 'onsets') {
    const sensitivity = numOpt('sensitivity');
    if (sensitivity !== null && sensitivity > 1) throw new DiagError(line, verb.col, `sample slice ${name}: sensitivity= is 0 to 1`);
    const minGap = numOpt('min-gap');
    return { op: 'sample-slice', name, how: { kind: 'onsets', sensitivity, minGap }, text: `sample slice ${name} at=onsets${sensitivity !== null ? ` sensitivity=${sensitivity}` : ''}${minGap !== null ? ` min-gap=${minGap}` : ''}` } as unknown as Command;
  }
  if (at !== undefined) {
    const times = at.split(',');
    if (times.some((x) => !/^(\d+f|\d*\.?\d+(ms|s)?)$/.test(x)) || times.length > 1024) throw new DiagError(line, verb.col, `sample slice ${name}: at= is onsets or times like 0,0.25,0.5 (seconds, 250ms or 1234f)`);
    return { op: 'sample-slice', name, how: { kind: 'at', times }, text: `sample slice ${name} at=${times.join(',')}` } as unknown as Command;
  }
  if (kv.has('grid')) {
    const n = numOpt('grid');
    if (n === null || !Number.isInteger(n) || n < 2 || n > 1024) throw new DiagError(line, verb.col, `sample slice ${name}: grid= is a whole number of slices, 2 to 1024`);
    const tempo = numOpt('tempo');
    return { op: 'sample-slice', name, how: { kind: 'grid', n, tempo }, text: `sample slice ${name} grid=${n}${tempo !== null ? ` tempo=${tempo}` : ''}` } as unknown as Command;
  }
  throw new DiagError(line, verb.col, `sample slice ${name}: say how: at=onsets [sensitivity=] [min-gap=], at=<t,t,...>, or grid=<n> [tempo=<bpm>]`);
}

function parseLoop(verb: Token, args: Token[], line: number): Command {
  const name = checkName(args[0], line, 'sample loop');
  const rest = args.slice(1);
  const timeRe = /^(\d+f|\d*\.?\d+(ms|s)?)$/;
  if (rest[0]?.v === 'find') {
    let near: [string, string] | null = null;
    let min: string | null = null;
    for (const t of rest.slice(1)) {
      const m = /^(near|min)=(.*)$/.exec(t.v);
      if (!m) throw new DiagError(line, t.col, `sample loop ${name} find: '${t.v}' is not near=<s>-<e> or min=<s>`);
      if (m[1] === 'near') {
        const r = /^(.+)-(.+)$/.exec(m[2]!);
        if (!r || !timeRe.test(r[1]!) || !timeRe.test(r[2]!)) throw new DiagError(line, t.col, `sample loop ${name} find: near= is <start>-<end> in seconds (or 1234f frames)`);
        near = [r[1]!, r[2]!];
      } else {
        if (!timeRe.test(m[2]!)) throw new DiagError(line, t.col, `sample loop ${name} find: min= is a length in seconds`);
        min = m[2]!;
      }
    }
    return { op: 'sample-loop', name, how: { kind: 'find', near, min }, text: `sample loop ${name} find${near ? ` near=${near[0]}-${near[1]}` : ''}${min ? ` min=${min}` : ''}` } as unknown as Command;
  }
  const [a, b, ...extra] = rest;
  if (!a || !b || !timeRe.test(a.v) || !timeRe.test(b.v)) throw new DiagError(line, verb.col, `sample loop ${name}: \`find [near=<s>-<e>] [min=<s>]\`, or <start> <end> (seconds, or 1234f frames)`);
  if (extra.length) throw new DiagError(line, extra[0]!.col, `sample loop ${name}: a crossfaded loop is made with sample derive (op="loop <start> <end> xfade=<t>"); sample loop only sets the loop points`);
  return { op: 'sample-loop', name, how: { kind: 'set', start: a.v, end: b.v }, text: `sample loop ${name} ${a.v} ${b.v}` } as unknown as Command;
}

// ---- applying ----------------------------------------------------------------------------------------------------------

function applyFields(e: SampleEntry, f: Partial<Record<Field, string>>, clear: readonly Field[] = []): void {
  const g = (k: Field) => f[k];
  if (g('hash') !== undefined) { e.hash = g('hash')!; e.rate = Number(g('rate')); e.channels = Number(g('channels')); e.frames = Number(g('frames')); e.format = g('format') as PcmFormat; }
  if (g('root') !== undefined) e.root = parseRoot(g('root')!)!;
  if (g('tune') !== undefined) e.tune = Number(g('tune'));
  if (g('loop') !== undefined) e.loop = g('loop')!.split('-').map(Number) as [number, number];
  if (g('loopmode') !== undefined) e.loopMode = g('loopmode') as LoopMode;
  if (g('slices') !== undefined) e.slices = g('slices')!.split(',').map(Number);
  if (g('tags') !== undefined) e.tags = g('tags')!.split(',');
  if (g('gain') !== undefined) e.gain = Number(g('gain'));
  if (g('note') !== undefined) e.note = g('note')!;
  const p = e.prov;
  if (g('source') !== undefined) p.source = g('source') as SampleSource;
  if (g('origin') !== undefined) p.origin = g('origin');
  if (g('orig-hash') !== undefined) p.origHash = g('orig-hash');
  if (g('orig-format') !== undefined) p.origFormat = g('orig-format');
  if (g('container-hash') !== undefined) p.containerHash = g('container-hash');
  if (g('date') !== undefined) p.date = g('date');
  if (g('author') !== undefined) p.author = g('author');
  if (g('provider') !== undefined) p.provider = g('provider');
  if (g('endpoint') !== undefined) p.endpoint = g('endpoint');
  if (g('model') !== undefined) p.model = g('model');
  if (g('prompt') !== undefined) p.prompt = g('prompt');
  if (g('params') !== undefined) p.params = g('params');
  if (g('seed') !== undefined) p.seed = Number(g('seed'));
  if (g('take') !== undefined) p.take = g('take');
  if (g('kept-from') !== undefined) p.keptFrom = g('kept-from');
  if (g('request') !== undefined) p.request = g('request');
  if (g('credits') !== undefined) p.credits = Number(g('credits'));
  if (g('parents') !== undefined) p.parents = g('parents')!.split(',');
  if (g('ops') !== undefined) p.ops = g('ops');
  if (g('licence') !== undefined) e.licence.id = g('licence')!;
  if (g('attribution') !== undefined) e.licence.attribution = g('attribution');
  if (g('terms') !== undefined) e.licence.terms = g('terms');
  for (const k of clear) {
    if (k === 'root') delete e.root;
    else if (k === 'tune') delete e.tune;
    else if (k === 'loop') delete e.loop;
    else if (k === 'loopmode') delete e.loopMode;
    else if (k === 'slices') delete e.slices;
    else if (k === 'tags') e.tags = [];
    else if (k === 'gain') delete e.gain;
    else if (k === 'note') delete e.note;
    else if (k === 'attribution') delete e.licence.attribution;
    else if (k === 'terms') delete e.licence.terms;
  }
}

/** The names of the samples a sound's layers play and its effects convolve with. */
export function soundSamples(s: Sound): string[] {
  if (s.voice !== 'layered') return [];
  return [...new Set([...s.layers.flatMap(layerSamples), ...fxSamples(s.master)])];
}

/** The names of the samples a song reads itself, not through its instruments: the impulse responses of its master chain and send buses. */
export function songDirectSamples(s: SongDoc): string[] {
  const fx: Fx[] = [...s.master, ...(s.reverb ? [s.reverb] : []), ...(s.delay ? [s.delay] : []), ...(s.convolve ? [s.convolve] : [])];
  return [...new Set(fxSamples(fx))];
}

/** The names of the samples an instrument plays: its template's sample layers and its zones. */
export function instrumentSamples(i: { voice: LayeredSound; zones?: readonly { sample: string }[] }): string[] {
  return [...new Set([...soundSamples(i.voice), ...(i.zones ?? []).map((z) => z.sample)])];
}

/** Who uses each sample: `sound x`, `instrument y`. */
export function sampleUsers(lib: Library): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (n: string, who: string) => out.set(n, [...(out.get(n) ?? []), who]);
  for (const s of lib.values()) for (const n of soundSamples(s)) add(n, `sound ${s.id}`);
  for (const i of lib.instruments.values()) for (const n of instrumentSamples(i)) add(n, `instrument ${i.id}`);
  for (const s of lib.songs.values()) for (const n of songDirectSamples(s)) add(n, `song ${s.id}`);
  return out;
}

function renameInFx(fx: readonly Fx[], from: string, to: string): void {
  for (const f of fx) if (f.kind === 'convolve' && f.p.ir === from) f.p.ir = to;
}

function renameInLayers(s: LayeredSound, from: string, to: string): LayeredSound {
  const c = cloneLayered(s);
  for (const l of c.layers) {
    if (l.kind === 'sample' && l.p.sample === from) l.p.sample = to;
    renameInFx(l.fx, from, to);
  }
  renameInFx(c.master, from, to);
  return c;
}

function renameInSong(s: SongDoc, from: string, to: string): SongDoc {
  const c = cloneSong(s);
  renameInFx(c.master, from, to);
  for (const f of [c.reverb, c.delay, c.convolve]) if (f) renameInFx([f], from, to);
  return c;
}

export function applySample(lib: Library, cmd: Command): string | undefined {
  const c = cmd as unknown as SampleCommand;
  const samples = lib.samples;
  const clash = (n: string): string | undefined => [...samples.keys()].find((k) => k.toLowerCase() === n.toLowerCase());
  switch (c.op) {
    case 'sample-add': {
      const other = clash(c.name);
      if (other) throw new Error(`sample '${c.name}' exists already${other !== c.name ? ` as '${other}' (names are unique ignoring case)` : ''}: point it at other audio with sample set ${other} hash=…`);
      const e: SampleEntry = { name: c.name, hash: '', rate: 0, channels: 0, frames: 0, format: 'pcm16', tags: [], prov: { source: 'file' }, licence: { id: 'unknown' } };
      applyFields(e, c.fields);
      samples.set(c.name, e);
      return undefined;
    }
    case 'sample-set': {
      const have = samples.get(c.name);
      if (!have) throw new Error(`no sample '${c.name}'${samples.size ? ` (samples: ${[...samples.keys()].sort().join(', ')})` : ''}`);
      const e = cloneSample(have);
      applyFields(e, c.fields, c.clear);
      if (e.loop && e.loop[1] > e.frames) throw new Error(`sample ${c.name}: the loop ends at frame ${e.loop[1]}, past the ${e.frames} frames`);
      samples.set(c.name, e);
      return undefined;
    }
    case 'sample-rename': {
      const have = samples.get(c.name);
      if (!have) throw new Error(`no sample '${c.name}'`);
      const other = clash(c.to);
      if (other && other !== c.name) throw new Error(`sample '${c.to}' exists already${other !== c.to ? ` as '${other}' (names are unique ignoring case)` : ''}`);
      // the same entry under the new name, in the same place in the order
      const entries = [...samples].map(([k, v]) => (k === c.name ? [c.to, { ...v, name: c.to }] as const : [k, v] as const));
      samples.clear();
      for (const [k, v] of entries) samples.set(k, v);
      for (const [id, s] of lib) if (s.voice === 'layered' && soundSamples(s).includes(c.name)) lib.set(id, renameInLayers(s, c.name, c.to));
      for (const [id, s] of lib.songs) if (songDirectSamples(s).includes(c.name)) lib.songs.set(id, renameInSong(s, c.name, c.to));
      for (const [id, i] of lib.instruments) if (instrumentSamples(i).includes(c.name)) lib.instruments.set(id, { ...i, voice: renameInLayers(i.voice, c.name, c.to), ...(i.zones ? { zones: i.zones.map((z) => (z.sample === c.name ? { ...z, sample: c.to } : z)) } : {}) });
      return undefined;
    }
    case 'sample-remove': {
      if (!samples.has(c.name)) throw new Error(`no sample '${c.name}'`);
      const users = sampleUsers(lib).get(c.name);
      if (users?.length) throw new Error(`sample ${c.name} is played by ${users.join(', ')}: change them first`);
      samples.delete(c.name);
      return undefined;
    }
    default:
      throw new Error(`${c.text.split(' ').slice(0, 2).join(' ')} is worked out when it runs (the writer puts the result on the tape as sample add / sample set); it cannot be applied on its own`);
  }
}

/** `sample add` with the date and author of the tape entry written in (the writer settles these, so a replay holds them as numbers and words). */
export function settleSampleAdd(c: Command, by: string, at: string): Command {
  const s = c as unknown as Extract<SampleCommand, { op: 'sample-add' }>;
  if (s.op !== 'sample-add') return c;
  const fields = { ...s.fields };
  fields.date ??= at;
  fields.author ??= by;
  return { ...s, fields, text: `sample add ${s.name}${fieldsText(fields)}` } as unknown as Command;
}

// ---- the .sample file ----------------------------------------------------------------------------------------------------

/** The text of samples/<name>.sample, written from the tape: one `field value` per line, for reading and for diffs. */
export function serializeSample(e: SampleEntry): string {
  const f = entryFields(e);
  const lines = ['soundclaw sample 1', `name ${e.name}`];
  for (const k of SAMPLE_FIELDS) if (f[k] !== undefined) lines.push(`${k} ${/^[^\s"\\]+$/.test(f[k]!) ? f[k] : quote(f[k]!)}`);
  return lines.join('\n') + '\n';
}

// ---- licences -----------------------------------------------------------------------------------------------------------

export type LicenceState = 'shippable' | 'attribution' | 'blocked' | 'unknown';

/** What may ship: patterns (`*` matches anything) over licence ids. `block` is looked at first. */
export interface ShipPolicy {
  allow: string[];
  block: string[];
}

/** The default policy: own, CC0, CC-BY (with attribution) and generated audio from a paid plan ship; unknown, NC, ND, proprietary and free-plan generated audio do not. */
export const DEFAULT_SHIP_POLICY: ShipPolicy = {
  allow: ['own', 'CC0-1.0', 'CC-BY-*', 'generated:*:*'],
  block: ['unknown', '*-NC*', '*-ND*', 'generated:*:free', 'proprietary:*'],
};

const globRe = (p: string): RegExp => new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

/** The policy a project.json asks for (`licences: { allow: [...], block: [...] }`), the defaults for what it leaves out. */
export function shipPolicyOf(json: unknown): ShipPolicy {
  const o = (json && typeof json === 'object' ? (json as { allow?: unknown; block?: unknown }) : {});
  const list = (x: unknown, d: string[]) => (Array.isArray(x) && x.every((s) => typeof s === 'string') ? (x as string[]) : d);
  return { allow: list(o.allow, DEFAULT_SHIP_POLICY.allow), block: list(o.block, DEFAULT_SHIP_POLICY.block) };
}

/** An id with a non-commercial or no-derivatives term (`CC-BY-NC-4.0`, `CC-BY-ND-4.0`, `CC-BY-NC-SA-4.0`). */
const RESTRICTED_RE = /(^|-)N[CD](-|$)/;
/** A policy pattern that names such a term itself. */
const RESTRICTED_PATTERN_RE = /(^|[-*])N[CD]([-*]|$)/;

const SEVERITY: Record<LicenceState, number> = { shippable: 0, attribution: 1, unknown: 2, blocked: 3 };
export const worstState = (a: LicenceState, b: LicenceState): LicenceState => (SEVERITY[b] > SEVERITY[a] ? b : a);

/** How a licence stands under a policy; `allowed` are ids let through for one export (`--allow-licence`). */
export function licenceState(l: SampleLicence, policy: ShipPolicy = DEFAULT_SHIP_POLICY, allowed: readonly string[] = []): { state: LicenceState; reason: string } {
  if (allowed.includes(l.id)) return { state: l.attribution || /^CC-BY/.test(l.id) ? 'attribution' : 'shippable', reason: `${l.id} is let through for this export` };
  if (l.id === 'unknown') return { state: 'unknown', reason: 'the licence is not known: set it with sample set <name> licence=<id>' };
  // Non-commercial and no-derivatives licences ship only when the allow list names one explicitly (`CC-BY-NC-4.0`, `*-NC-*`): a broad pattern such as `CC-BY-*` never admits them.
  const restricted = RESTRICTED_RE.test(l.id);
  const namesRestricted = (p: string): boolean => RESTRICTED_PATTERN_RE.test(p);
  if (restricted && !policy.allow.some((p) => namesRestricted(p) && globRe(p).test(l.id))) return { state: 'blocked', reason: `${l.id} is a non-commercial or no-derivatives licence: it ships only when the project's allow list names it (an NC or ND pattern such as ${l.id})` };
  // an explicit NC or ND allow pattern overrides the default NC / ND block patterns, and nothing else
  const hit = policy.block.find((p) => globRe(p).test(l.id) && !(restricted && DEFAULT_SHIP_POLICY.block.includes(p) && namesRestricted(p)));
  if (hit) return { state: 'blocked', reason: `${l.id} is blocked by the project's policy (${hit})` };
  if (!policy.allow.some((p) => globRe(p).test(l.id) && (!restricted || namesRestricted(p)))) return { state: 'blocked', reason: `${l.id} is not on the project's list of licences that may ship` };
  return /^CC-BY/.test(l.id) || (l.attribution && l.id !== 'own' && l.id !== 'CC0-1.0') ? { state: 'attribution', reason: `${l.id} asks for attribution` } : { state: 'shippable', reason: `${l.id} may ship` };
}

export interface ReachedSample {
  name: string;
  hash: string;
  licence: SampleLicence;
  /** How it is reached: used directly, or as the parent of a derived sample. */
  via: 'used' | 'parent';
}

/** The samples a set of names reaches: themselves and, recursively, the parents of derived and bounced samples (by hash). */
export function reachedSamples(lib: Library, names: Iterable<string>): ReachedSample[] {
  const out = new Map<string, ReachedSample>();
  const byHash = new Map<string, SampleEntry[]>();
  for (const e of lib.samples.values()) byHash.set(e.hash, [...(byHash.get(e.hash) ?? []), e]);
  const visit = (e: SampleEntry, via: 'used' | 'parent', seen: Set<string>): void => {
    if (seen.has(e.name)) return;
    seen.add(e.name);
    if (!out.has(e.name)) out.set(e.name, { name: e.name, hash: e.hash, licence: e.licence, via });
    for (const h of e.prov.parents ?? []) for (const p of byHash.get(h) ?? []) visit(p, 'parent', seen);
  };
  for (const n of names) {
    const e = lib.samples.get(n);
    if (e) visit(e, 'used', new Set());
  }
  return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The samples a song reaches: through the instruments its channels play. */
export function songSamples(lib: Library, songId: string): string[] {
  const song = lib.songs.get(songId);
  if (!song) return [];
  const insts = new Set<string>();
  for (const c of song.channels) {
    if (c.inst) insts.add(c.inst);
    for (const i of Object.values(c.kit ?? {})) insts.add(i);
  }
  return [...new Set([...[...insts].flatMap((i) => (lib.instruments.get(i) ? instrumentSamples(lib.instruments.get(i)!) : [])), ...songDirectSamples(song)])];
}

export type ItemKind = 'sound' | 'instrument' | 'song' | 'sample';

/** The sample names an item (a sound, instrument, song or sample) plays directly. */
export function itemSamples(lib: Library, kind: ItemKind, id: string): string[] {
  if (kind === 'sound') { const s = lib.get(id); return s ? soundSamples(s) : []; }
  if (kind === 'instrument') { const i = lib.instruments.get(id); return i ? instrumentSamples(i) : []; }
  if (kind === 'song') return songSamples(lib, id);
  return lib.samples.has(id) ? [id] : [];
}

export interface ItemLicence {
  kind: ItemKind;
  id: string;
  state: LicenceState;
  samples: (ReachedSample & { state: LicenceState; reason: string })[];
}

/** How an item stands: the worst state of every sample it reaches (an item with no samples is shippable). */
export function itemLicence(lib: Library, kind: ItemKind, id: string, policy: ShipPolicy = DEFAULT_SHIP_POLICY, allowed: readonly string[] = []): ItemLicence {
  const samples = reachedSamples(lib, itemSamples(lib, kind, id)).map((r) => ({ ...r, ...licenceState(r.licence, policy, allowed) }));
  return { kind, id, state: samples.reduce<LicenceState>((s, r) => worstState(s, r.state), 'shippable'), samples };
}

/** The licence ids a set of reached samples carry, sorted. */
export const licenceIds = (rs: readonly ReachedSample[]): string[] => [...new Set(rs.map((r) => r.licence.id))].sort();

/** ATTRIBUTION.txt: one block per sample whose licence asks for attribution (null when none does). */
export function attributionText(rs: readonly ReachedSample[]): string | null {
  const asks = rs.filter((r) => r.licence.attribution || /^CC-BY/.test(r.licence.id));
  if (!asks.length) return null;
  const lines = ['Attribution for the audio used in these files.', ''];
  for (const r of asks) {
    lines.push(`- ${r.name} (${r.licence.id}, ${r.hash.slice(0, 12)})`);
    if (r.licence.attribution) lines.push(`  ${r.licence.attribution.replace(/\n/g, '\n  ')}`);
    if (r.licence.terms) lines.push(`  ${r.licence.terms}`);
  }
  return lines.join('\n') + '\n';
}
