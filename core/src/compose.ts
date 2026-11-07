// The composition helpers: commands that write notes into a song's patterns. Each one works out
// its notes from the song (its key, its time, its channels' instruments) and its options, then goes
// on the tape with every option spelled out and the rows it wrote in `written="…"`. Replaying the
// tape puts those rows back as written; it never works the notes out again, so a later version of a
// helper cannot change an old project.
//
//   chords <song> <pattern> <channel> "<progression>" [bars=] [rhythm=] [voices=] [range=] [vel=] [tpb=]
//   bass <song> <pattern> <channel> ["<progression>" | from=<channel>] [style=root|root-fifth|walking|octave] [rate=] ...
//   arp <song> <pattern> <channel> ["<progression>" | from=<channel>] [pattern=up|down|updown|random(<seed>)] [rate=] [octaves=] ...
//   drums <song> <pattern> <channel>[,<hat channel>] <template> [bars=] [fill=<every n bars>] [seed=] [vary=]
//   humanise <song> <pattern> <channel>|all [timing=<ms>] [velocity=<amount>] [seed=]
//   motif set|remove|transpose|invert|retrograde|augment|diminish <song> <name> ...
//   motif write <song> <motif> <pattern> <channel> [at=<step>] [by=<n>] [mode=chromatic|diatonic]
//   motif sequence <song> <motif> <pattern> <channel> "<progression>" [bars=] [mode=diatonic|chromatic]
//   layer-plan <song> <layer>=<channel>,… …    the game layers in the order they stack (the first is the base)

import { DiagError, quote, type Command, type Token } from './commands.ts';
import { DRUM_TEMPLATES, drumRows } from './drums.ts';
import { lookupInstrument } from './music-commands.ts';
import { MIDI_HIGH, MIDI_LOW, SCALE_NOTES, SCALES, inKey, noteLabel, parseKey, parseNote, parseRange, pitchClassName, type Key } from './music.ts';
import { channelEvents, formatCell, formatPattern, parsePattern, PATTERN_NAME_RE, VEL_DEFAULT, type Cell, type PNote, type Pattern, type PatternChannel } from './pattern.ts';
import type { Library } from './sets.ts';
import { CHANNEL_NAME_RE } from './pattern.ts';
import { LAYER_NAME_RE, MOTIF_NAME_RE, SONG_ID_RE, cloneSong, motifText, type Channel, type Motif, type SongDoc } from './song.ts';
import {
  chordClasses, chordName, chordOfNotes, degreeOf, diatonicChords, fromDegree, parseProgression, seededRandom, stepInScale, triangular, voiceChord, type ChordSym,
} from './theory.ts';

export const COMPOSE_HEADS = ['chords', 'bass', 'arp', 'drums', 'humanise', 'humanize', 'motif', 'layer-plan'] as const;
export const BASS_STYLES = ['root', 'root-fifth', 'walking', 'octave'] as const;
export const RHYTHMS = ['hold', 'bar', 'half', 'beats', 'offbeat', 'pulse'] as const;
export const MOTIF_VERBS = ['set', 'remove', 'transpose', 'invert', 'retrograde', 'augment', 'diminish', 'write', 'sequence'] as const;

type Helper = 'chords' | 'bass' | 'arp' | 'drums' | 'humanise' | 'motif-write' | 'motif-sequence';

export type ComposeCommand =
  | { op: 'compose-notes'; helper: Helper; song: string; pattern: string; channels: string[]; motif: string | null; prog: string | null; template: string | null; opts: Map<string, string>; written: Pattern | null; text: string }
  | { op: 'compose-motif'; verb: 'set' | 'remove' | 'transpose' | 'invert' | 'retrograde' | 'augment' | 'diminish'; song: string; name: string; opts: Map<string, string>; written: Motif | null; text: string }
  | { op: 'compose-layer-plan'; song: string; plan: [string, string[]][]; text: string };

export const isComposeOp = (op: string): boolean => op.startsWith('compose-');

// ---- option values ------------------------------------------------------------------------------------------------

const intIn = (v: string, lo: number, hi: number): boolean => /^-?\d+$/.test(v) && Number(v) >= lo && Number(v) <= hi;
const numIn = (v: string, lo: number, hi: number): boolean => /^-?(\d+\.?\d*|\.\d+)$/.test(v) && Number(v) >= lo && Number(v) <= hi;
const RATES = ['chord', '1', '1/2', '1/4', '1/8', '1/16', '1/32'];

/** Each option: what it accepts (a check, and the words for the error). */
const OPTION: Record<string, [(v: string) => boolean, string]> = {
  bars: [(v) => v.split(',').every((x) => numIn(x, 0.0001, 64)), 'a number of bars (or one per chord, like 1,1,2)'],
  rhythm: [(v) => (RHYTHMS as readonly string[]).includes(v) || /^[xX.\- ]+$/.test(v), `${RHYTHMS.join(', ')}, or a mask of x (strike) X (accent) - (hold) . (rest) like "x-.x-.x-"`],
  voices: [(v) => intIn(v, 2, 6), 'a whole number from 2 to 6'],
  range: [(v) => parseRange(v) !== null, 'two notes like C3-C5'],
  vel: [(v) => intIn(v, 1, 127), 'a velocity from 1 to 127'],
  tpb: [(v) => intIn(v, 1, 24), 'steps per beat, 1 to 24 (for a pattern the helper makes)'],
  from: [(v) => CHANNEL_NAME_RE.test(v), 'a channel of the same pattern holding the chords'],
  style: [(v) => (BASS_STYLES as readonly string[]).includes(v), BASS_STYLES.join(', ')],
  rate: [(v) => RATES.includes(v), `${RATES.join(', ')} (chord: one note per chord; 1/4: a quarter note)`],
  pattern: [(v) => /^(up|down|updown|random\(\d{1,10}\))$/.test(v), 'up, down, updown or random(<seed>)'],
  octaves: [(v) => intIn(v, 1, 3), '1, 2 or 3'],
  fill: [(v) => intIn(v, 0, 64), 'every how many bars a fill comes (0: none)'],
  seed: [(v) => intIn(v, 0, 4294967295), 'a whole number from 0 to 4294967295'],
  vary: [(v) => numIn(v, 0, 1), 'an amount from 0 to 1'],
  timing: [(v) => intIn(v, 0, 50), 'milliseconds off the grid, 0 to 50'],
  velocity: [(v) => intIn(v, 0, 40), 'velocity steps, 0 to 40'],
  at: [(v) => intIn(v, 0, 255), 'the step to start at'],
  by: [(v) => intIn(v, -48, 48), 'semitones (mode=chromatic) or scale steps (mode=diatonic), -48 to 48'],
  mode: [(v) => v === 'chromatic' || v === 'diatonic', 'chromatic or diatonic'],
  around: [(v) => /^[A-G][#b]?-?\d$/.test(v), 'a note like E5'],
  factor: [(v) => intIn(v, 2, 4), '2, 3 or 4'],
  as: [(v) => MOTIF_NAME_RE.test(v), 'a motif name'],
};

/** The options each helper takes, in the order its normal form writes them. */
const ORDER: Record<string, string[]> = {
  chords: ['bars', 'rhythm', 'voices', 'range', 'vel', 'tpb'],
  bass: ['from', 'style', 'rate', 'bars', 'range', 'vel', 'tpb'],
  arp: ['from', 'pattern', 'rate', 'octaves', 'bars', 'range', 'vel', 'tpb'],
  drums: ['bars', 'fill', 'seed', 'vary'],
  humanise: ['timing', 'velocity', 'seed'],
  'motif-write': ['at', 'by', 'mode', 'vel', 'bars', 'tpb'],
  'motif-sequence': ['bars', 'mode', 'vel', 'tpb'],
  'motif-set': ['tpb'],
  'motif-remove': [],
  'motif-transpose': ['by', 'mode', 'as'],
  'motif-invert': ['around', 'mode', 'as'],
  'motif-retrograde': ['as'],
  'motif-augment': ['factor', 'as'],
  'motif-diminish': ['factor', 'as'],
};

function options(tokens: Token[], line: number, what: string, allowed: string[]): { opts: Map<string, string>; written: Token | null } {
  const opts = new Map<string, string>();
  let written: Token | null = null;
  for (const t of tokens) {
    const m = /^([a-z]+)=(.*)$/s.exec(t.v);
    if (!m) throw new DiagError(line, t.col, `${what}: '${t.v}' is not <name>=<value> (${allowed.map((a) => a + '=').join(' ') || 'no options'})`);
    let v = m[2]!;
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (m[1] === 'written') { written = { ...t, v }; continue; }
    if (!allowed.includes(m[1]!)) throw new DiagError(line, t.col, `${what}: unexpected '${m[1]}' (it takes ${allowed.map((a) => a + '=').join(' ') || 'no options'})`);
    const [ok, words] = OPTION[m[1]!]!;
    if (!ok(v)) throw new DiagError(line, t.col + m[1]!.length + 1, `${m[1]} is ${words} (got '${v}')`);
    opts.set(m[1]!, v);
  }
  return { opts, written };
}

const optText = (helper: string, opts: Map<string, string>): string => ORDER[helper]!.filter((k) => opts.has(k)).map((k) => {
  const v = opts.get(k)!;
  return ` ${k}=${/[\s"]/.test(v) ? quote(v) : v}`;
}).join('');

function need(t: Token | undefined, line: number, what: string, re: RegExp, kind: string): string {
  if (!t) throw new DiagError(line, 1, `${what}: give the ${kind}`);
  if (!re.test(t.v)) throw new DiagError(line, t.col, `'${t.v}' is not a ${kind}`);
  return t.v;
}

function parseWrittenPattern(t: Token, line: number, name: string): Pattern {
  const r = parsePattern(t.v, name);
  if (!r.pattern) throw new DiagError(line, t.col, `written: line ${r.errors[0]!.line} column ${r.errors[0]!.col}: ${r.errors[0]!.message}`);
  return { ...r.pattern, name };
}

/** `tpb=4 D5 F#5 A5 - …`: a motif's grid and cells. Throws a plain Error. */
export function parseMotifCells(text: string, tpb: number, name = 'motif'): Motif {
  let t = tpb;
  let body = text.trim();
  const m = /^tpb=(\d+)\s+/.exec(body);
  if (m) { t = Number(m[1]); body = body.slice(m[0].length); }
  if (!(t >= 1 && t <= 24)) throw new Error('a motif\'s tpb is 1 to 24');
  const cells = body.split(/\s+/).filter((w) => w && w !== '|');
  if (!cells.length) throw new Error('the motif is empty: give notes like "D5 F#5 A5 - B5 . A5 -"');
  if (cells.length > 256) throw new Error('a motif is at most 256 steps');
  const r = parsePattern(`pattern m steps=${cells.length} tpb=${t}\n  m: ${cells.join(' ')}`);
  if (!r.pattern) throw new Error(`motif ${name}: ${r.errors[0]!.message}`);
  const row = r.pattern.channels[0]!.cells;
  if (row.some((c) => c.kind === 'drum')) throw new Error(`motif ${name} holds notes, not drum hits`);
  return { name, tpb: t, cells: row };
}

// ---- parsing ------------------------------------------------------------------------------------------------------

/** `chords …`, `bass …`, `arp …`, `drums …`, `humanise …`, `motif …` or `layer-plan …`. */
export function parseCompose(head: Token, rest: Token[], line: number): Command {
  const h = head.v === 'humanize' ? 'humanise' : head.v;
  if (h === 'layer-plan') return parseLayerPlan(rest, line) as unknown as Command;
  if (h === 'motif') return parseMotif(head, rest, line) as unknown as Command;
  const song = need(rest[0], line, h, SONG_ID_RE, 'song id');
  const pattern = need(rest[1], line, `${h} ${song}`, PATTERN_NAME_RE, 'pattern name');
  const chTok = rest[2];
  if (!chTok) throw new DiagError(line, 1, `${h} ${song} ${pattern}: give the channel to write into`);
  let channels: string[];
  if (h === 'humanise' && chTok.v === 'all') channels = ['all'];
  else {
    channels = chTok.v.split(',');
    if (channels.length > (h === 'drums' ? 2 : h === 'humanise' ? 16 : 1) || new Set(channels).size !== channels.length || channels.some((c) => !CHANNEL_NAME_RE.test(c))) throw new DiagError(line, chTok.col, h === 'drums' ? `'${chTok.v}' is not a drum channel, or two (kick and snare, then hats: drums,hats)` : `'${chTok.v}' is not a channel name`);
  }
  let args = rest.slice(3);
  let prog: string | null = null;
  let template: string | null = null;
  if (h === 'drums') {
    const t = args[0];
    if (!t || t.v.includes('=')) throw new DiagError(line, (t ?? chTok).col, `drums: give a template (${Object.keys(DRUM_TEMPLATES).join(', ')})`);
    if (!DRUM_TEMPLATES[t.v]) throw new DiagError(line, t.col, `no drum template '${t.v}' (${Object.keys(DRUM_TEMPLATES).join(', ')})`);
    template = t.v;
    args = args.slice(1);
  } else if (h === 'chords' || h === 'bass' || h === 'arp') {
    if (args[0] && (args[0].quoted || !args[0].v.includes('='))) { prog = args[0].v; args = args.slice(1); }
    else if (h === 'chords') throw new DiagError(line, (args[0] ?? chTok).col, 'chords: give the progression in quotes, like "I V vi IV"');
  }
  const { opts, written } = options(args, line, h, ORDER[h]!);
  if ((h === 'bass' || h === 'arp') && !prog && !opts.has('from')) throw new DiagError(line, chTok.col, `${h}: give the progression in quotes ("I V vi IV") or from=<channel> to follow the chords a channel plays`);
  if ((h === 'bass' || h === 'arp') && prog && opts.has('from')) throw new DiagError(line, chTok.col, `${h}: give a progression or from=, not both`);
  const w = written ? parseWrittenPattern(written, line, pattern) : null;
  const text = `${h} ${song} ${pattern} ${channels.join(',')}${template ? ' ' + template : ''}${prog !== null ? ' ' + quote(prog) : ''}${optText(h, opts)}${w ? ` written=${quote(formatPattern(w))}` : ''}`;
  return { op: 'compose-notes', helper: h as Helper, song, pattern, channels, motif: null, prog, template, opts, written: w, text } as unknown as Command;
}

function parseMotif(head: Token, rest: Token[], line: number): ComposeCommand {
  const [verb, ...args] = rest;
  if (!verb || !(MOTIF_VERBS as readonly string[]).includes(verb.v)) throw new DiagError(line, (verb ?? head).col, `motif: ${MOTIF_VERBS.join(', ')}`);
  const song = need(args[0], line, `motif ${verb.v}`, SONG_ID_RE, 'song id');
  const name = need(args[1], line, `motif ${verb.v} ${song}`, MOTIF_NAME_RE, 'motif name');
  if (verb.v === 'write' || verb.v === 'sequence') {
    const pattern = need(args[2], line, `motif ${verb.v} ${song} ${name}`, PATTERN_NAME_RE, 'pattern name');
    const channel = need(args[3], line, `motif ${verb.v} ${song} ${name} ${pattern}`, CHANNEL_NAME_RE, 'channel name');
    let more = args.slice(4);
    let prog: string | null = null;
    if (verb.v === 'sequence') {
      if (!more[0] || (!more[0].quoted && more[0].v.includes('='))) throw new DiagError(line, (more[0] ?? args[3]!).col, 'motif sequence: give the progression in quotes, like "I IV V I"');
      prog = more[0].v;
      more = more.slice(1);
    }
    const helper = `motif-${verb.v}` as Helper;
    const { opts, written } = options(more, line, `motif ${verb.v}`, ORDER[helper]!);
    const w = written ? parseWrittenPattern(written, line, pattern) : null;
    const text = `motif ${verb.v} ${song} ${name} ${pattern} ${channel}${prog !== null ? ' ' + quote(prog) : ''}${optText(helper, opts)}${w ? ` written=${quote(formatPattern(w))}` : ''}`;
    return { op: 'compose-notes', helper, song, pattern, channels: [channel], motif: name, prog, template: null, opts, written: w, text };
  }
  const v = verb.v as Exclude<(typeof MOTIF_VERBS)[number], 'write' | 'sequence'>;
  let more = args.slice(2);
  let cells: string | null = null;
  if (v === 'set') {
    if (!more[0] || (!more[0].quoted && more[0].v.includes('='))) throw new DiagError(line, (more[0] ?? args[1]!).col, `motif set ${song} ${name}: give the notes in quotes, like "D5 F#5 A5 - B5 . A5 -"`);
    cells = more[0].v;
    more = more.slice(1);
  }
  const { opts, written } = options(more, line, `motif ${v}`, ORDER[`motif-${v}`]!);
  if (v === 'transpose' && !opts.has('by')) throw new DiagError(line, verb.col, 'motif transpose: give by=<n> (semitones, or scale steps with mode=diatonic)');
  let motif: Motif | null = null;
  try {
    if (cells !== null) motif = parseMotifCells(cells, Number(opts.get('tpb') ?? 4), name);
    else if (written) motif = parseMotifCells(written.v, 4, opts.get('as') ?? name);
  } catch (e) { throw new DiagError(line, (written ?? more[0] ?? verb).col, (e as Error).message); }
  if (v === 'set') opts.set('tpb', String(motif!.tpb));
  const text = v === 'set'
    ? `motif set ${song} ${name} ${quote(motifText(motif!))}${optText('motif-set', opts)}`
    : `motif ${v} ${song} ${name}${optText(`motif-${v}`, opts)}${motif ? ` written=${quote(`tpb=${motif.tpb} ${motifText(motif)}`)}` : ''}`;
  return { op: 'compose-motif', verb: v, song, name, opts, written: motif, text };
}

function parseLayerPlan(rest: Token[], line: number): ComposeCommand {
  const song = need(rest[0], line, 'layer-plan', SONG_ID_RE, 'song id');
  const plan: [string, string[]][] = [];
  const seen = new Set<string>();
  for (const t of rest.slice(1)) {
    const m = /^([a-z][a-z0-9_-]{0,23})=(.+)$/.exec(t.v);
    if (!m || !LAYER_NAME_RE.test(m[1]!)) throw new DiagError(line, t.col, `layer-plan: '${t.v}' is not <layer>=<channel>,<channel> (like base=pad,bass)`);
    const chs = m[2]!.split(',');
    for (const c of chs) {
      if (!CHANNEL_NAME_RE.test(c)) throw new DiagError(line, t.col, `'${c}' is not a channel name`);
      if (seen.has(c)) throw new DiagError(line, t.col, `channel ${c} is in two layers`);
      seen.add(c);
    }
    if (plan.some(([l]) => l === m[1])) throw new DiagError(line, t.col, `layer ${m[1]} is named twice`);
    plan.push([m[1]!, chs]);
  }
  if (!plan.length) throw new DiagError(line, rest[0]!.col, `layer-plan ${song}: give the layers in the order they stack, like base=pad,bass tension=arp combat=drums,lead`);
  return { op: 'compose-layer-plan', song, plan, text: `layer-plan ${song} ${plan.map(([l, c]) => `${l}=${c.join(',')}`).join(' ')}` };
}

// ---- the song, its channels, the grid ------------------------------------------------------------------------------

function songOf(lib: Library, id: string): SongDoc {
  const s = lib.songs.get(id);
  if (!s) throw new Error(`no song '${id}'${lib.songs.size ? ` (songs: ${[...lib.songs.keys()].join(', ')})` : ''}`);
  return cloneSong(s);
}

function keyOf(song: SongDoc): Key {
  if (!song.key) throw new Error(`song ${song.id} has no key: song set ${song.id} key=D:major first (the helpers write in the song's key)`);
  return parseKey(song.key);
}

function channelIn(song: SongDoc, name: string, kind: 'pitched' | 'drums'): Channel {
  const c = song.channels.find((x) => x.name === name);
  if (!c) throw new Error(`song ${song.id} has no channel ${name} (song channel add ${song.id} ${name} ${kind === 'drums' ? 'kit=default' : 'inst=<instrument>'})`);
  if (kind === 'pitched' && !c.inst) throw new Error(`channel ${name} of ${song.id} is a drum channel; notes go in a channel with an instrument`);
  if (kind === 'drums' && !c.kit) throw new Error(`channel ${name} of ${song.id} plays ${c.inst}; drum hits go in a drum channel (kit=default)`);
  return c;
}

/** Steps in a bar of the song's time at a grid. */
function barSteps(song: SongDoc, tpb: number): number {
  const s = (song.time[0] * 4 / song.time[1]) * tpb;
  if (!Number.isInteger(s)) throw new Error(`a bar of ${song.time[0]}/${song.time[1]} is not a whole number of steps at tpb=${tpb}`);
  return s;
}

/** The pattern to write into: the song's (its grid must match tpb= when given) or a new one of `steps`. */
function patternFor(song: SongDoc, name: string, tpb: number | null, steps: (tpb: number) => number): { pat: Pattern; fresh: boolean } {
  const have = song.patterns.get(name);
  if (have) {
    if (tpb !== null && tpb !== have.tpb) throw new Error(`pattern ${name} is on a grid of tpb=${have.tpb}, not ${tpb}`);
    return { pat: { ...have, channels: have.channels.map((c) => ({ name: c.name, cells: [...c.cells] })) }, fresh: false };
  }
  const t = tpb ?? 4;
  const n = steps(t);
  if (n > 256) throw new Error(`that is ${n} steps; a pattern holds at most 256 (write it in two patterns)`);
  const bar = barSteps(song, t);
  return { pat: { name, steps: n, tpb: t, bar: n > bar ? bar : null, channels: [] }, fresh: true };
}

const rests = (n: number): Cell[] => Array.from({ length: n }, () => ({ kind: 'rest' }) as Cell);

function rowOf(pat: Pattern, ch: string): Cell[] {
  return pat.channels.find((c) => c.name === ch)?.cells.slice() ?? rests(pat.steps);
}

/** A note cell. */
const noteCell = (midis: readonly number[], vel: number): Cell => ({ kind: 'notes', notes: midis.map((m): PNote => ({ midi: m, vel, fx: {} })) });

/** The range a part is written in: the asked one, else the default narrowed to the instrument's own range when it declares one. */
function rangeFor(lib: Library, ch: Channel, opts: Map<string, string>, def: [number, number]): [number, number] {
  const given = opts.get('range');
  if (given) return parseRange(given)!;
  const inst = ch.inst ? lookupInstrument(lib, ch.inst) : undefined;
  if (!inst?.range) return def;
  const lo = Math.max(def[0], inst.range[0]), hi = Math.min(def[1], inst.range[1]);
  return hi - lo >= 12 ? [lo, hi] : [inst.range[0], inst.range[1]];
}

const rangeText = (r: readonly [number, number]): string => `${noteLabel(r[0])}-${noteLabel(r[1])}`;

// ---- chord spans ----------------------------------------------------------------------------------------------------

interface Span { chord: Pick<ChordSym, 'root' | 'tones' | 'inversion' | 'degree'> & { text: string }; start: number; len: number }

/** The progression laid out in steps: each chord its bars (its own :n, else bars=, one number or one per chord). */
function progressionSpans(prog: ChordSym[], bars: string | undefined, bar: number): { spans: Span[]; total: number } {
  const list = (bars ?? '1').split(',').map(Number);
  if (list.length !== 1 && list.length !== prog.length) throw new Error(`bars= gives ${list.length} lengths for ${prog.length} chords (give one, or one per chord)`);
  let at = 0;
  const spans = prog.map((c, i) => {
    const b = c.bars ?? (list.length === 1 ? list[0]! : list[i]!);
    const len = b * bar;
    if (!Number.isInteger(len) || len < 1) throw new Error(`${c.text}: ${b} bar${b === 1 ? '' : 's'} is not a whole number of steps (a bar is ${bar} steps)`);
    const s = { chord: c, start: at, len };
    at += len;
    return s;
  });
  return { spans, total: at };
}

/** The progression repeated to fill a pattern (the last time through cut at the end). */
function fillSpans(spans: Span[], total: number, steps: number): Span[] {
  if (total > steps) throw new Error(`the progression is ${total} steps and the pattern ${steps}: shorten it, or write it into a longer pattern`);
  const out: Span[] = [];
  for (let base = 0; base < steps; base += total) for (const s of spans) {
    if (base + s.start >= steps) break;
    out.push({ ...s, start: base + s.start, len: Math.min(s.len, steps - base - s.start) });
  }
  return out;
}

/** The chords a channel plays in a pattern: each note or chord cell lasts until the next one. */
function spansFromChannel(pat: Pattern, ch: string): Span[] {
  const row = pat.channels.find((c) => c.name === ch);
  if (!row) throw new Error(`pattern ${pat.name} has no row for channel ${ch} to follow (write the chords first)`);
  const evs = channelEvents(row).filter((e) => e.notes);
  if (!evs.length) throw new Error(`channel ${ch} plays no notes in pattern ${pat.name}`);
  return evs.map((e, i) => {
    const c = chordOfNotes(e.notes!.map((n) => n.midi));
    const end = i + 1 < evs.length ? evs[i + 1]!.step : pat.steps;
    return { chord: { ...c, inversion: null, degree: 0, text: chordName(c) }, start: e.step, len: end - e.step };
  });
}

/** The chords to follow: a progression, or the chords a channel plays. */
function spansFor(song: SongDoc, pat: Pattern, prog: string | null, from: string | undefined, bars: string | undefined, fresh: boolean): Span[] {
  if (from) {
    if (fresh) throw new Error(`pattern ${pat.name} does not exist yet, so there are no chords in ${from} to follow`);
    return spansFromChannel(pat, from);
  }
  const p = progressionSpans(parseProgression(prog!, keyOf(song)), bars, barSteps(song, pat.tpb));
  return fillSpans(p.spans, p.total, pat.steps);
}

function progressionSteps(song: SongDoc, prog: string | null, bars: string | undefined): (tpb: number) => number {
  return (tpb) => {
    if (prog === null) throw new Error('the pattern does not exist yet: give a progression so the helper knows its length');
    return progressionSpans(parseProgression(prog, keyOf(song)), bars, barSteps(song, tpb)).total;
  };
}

// ---- rhythms --------------------------------------------------------------------------------------------------------

/** What a rhythm does at a step of the pattern: x strike, X accent, - hold, . rest. */
function rhythmAt(rhythm: string, pos: number, tpb: number, bar: number): string {
  switch (rhythm) {
    case 'hold': return '-';
    case 'bar': return pos % bar === 0 ? 'x' : '-';
    case 'half': return pos % (2 * tpb) === 0 ? 'x' : '-';
    case 'beats': return pos % tpb === 0 ? 'x' : '-';
    case 'pulse': return 'x';
    case 'offbeat': {
      if (tpb < 2) return pos % 2 === 1 ? 'x' : '.';
      const h = Math.floor(tpb / 2), k = pos % tpb;
      return k === h ? 'x' : k > h ? '-' : '.';
    }
    default: {
      const mask = rhythm.replace(/\s+/g, '');
      return mask[pos % mask.length]!;
    }
  }
}

/** Write notes over a span following a rhythm: every span starts with a strike; a hold after a rest is a rest. */
function writeSpan(row: Cell[], span: { start: number; len: number }, notes: readonly number[], vel: number, rhythm: string, tpb: number, bar: number): void {
  for (let i = 0; i < span.len; i++) {
    const pos = span.start + i;
    let r = rhythmAt(rhythm, pos, tpb, bar);
    if (i === 0 && r === '-') r = 'x';
    if (r === '-' && row[pos - 1]?.kind === 'rest') r = '.';
    row[pos] = r === 'x' ? noteCell(notes, vel) : r === 'X' ? noteCell(notes, Math.min(127, vel + 20)) : r === '-' ? { kind: 'hold' } : { kind: 'rest' };
  }
}

/** Steps a rate stands for at a grid (null for `chord`). */
function rateSteps(rate: string, tpb: number): number | null {
  if (rate === 'chord') return null;
  const den = rate === '1' ? 1 : Number(rate.slice(2));
  const s = (tpb * 4) / den;
  if (!Number.isInteger(s) || s < 1) throw new Error(`rate=${rate} does not fit a grid of tpb=${tpb} (use a coarser rate, or a pattern with more steps per beat)`);
  return s;
}

/** Notes at a rate over a span, each held until the next. */
function writeRun(row: Cell[], span: { start: number; len: number }, notes: readonly number[], every: number, vel: number): void {
  for (let i = 0; i < span.len; i++) {
    const k = Math.floor(i / every);
    row[span.start + i] = i % every === 0 && k < notes.length ? noteCell([notes[k]!], vel) : { kind: 'hold' };
  }
}

const nearest = (cands: readonly number[], to: number, not?: number): number => {
  let best = cands[0]!;
  for (const c of cands) {
    if (c === not && cands.length > 1) continue;
    if (best === not || Math.abs(c - to) < Math.abs(best - to) || (Math.abs(c - to) === Math.abs(best - to) && c < best)) best = c;
  }
  return best;
};

function inRange(pc: number, r: readonly [number, number]): number[] {
  const out: number[] = [];
  for (let m = r[0]; m <= r[1]; m++) if (m % 12 === pc) out.push(m);
  return out;
}

// ---- the helpers ----------------------------------------------------------------------------------------------------

interface Out { pat: Pattern; rows: Map<string, Cell[]>; resolved: Map<string, string>; note?: string }

function helperChords(lib: Library, song: SongDoc, c: Extract<ComposeCommand, { op: 'compose-notes' }>): Out {
  const ch = channelIn(song, c.channels[0]!, 'pitched');
  const o = c.opts;
  const { pat, fresh } = patternFor(song, c.pattern, o.has('tpb') ? Number(o.get('tpb')) : null, progressionSteps(song, c.prog, o.get('bars')));
  const bar = barSteps(song, pat.tpb);
  const spans = spansFor(song, pat, c.prog, undefined, o.get('bars'), fresh);
  const range = rangeFor(lib, ch, o, [55, 79]);
  const n = o.has('voices') ? Number(o.get('voices')) : Math.max(...spans.map((s) => new Set(chordClasses(s.chord)).size));
  const vel = Number(o.get('vel') ?? VEL_DEFAULT);
  const rhythm = o.get('rhythm') ?? 'hold';
  const row = rowOf(pat, ch.name);
  let prev: number[] | null = null;
  const names: string[] = [];
  for (const s of spans) {
    const v = voiceChord(prev, s.chord, n, range);
    prev = v;
    writeSpan(row, s, v, vel, rhythm, pat.tpb, bar);
    names.push(chordName(s.chord));
  }
  const resolved = new Map([['bars', o.get('bars') ?? '1'], ['rhythm', rhythm], ['voices', String(n)], ['range', rangeText(range)], ['vel', String(vel)], ['tpb', String(pat.tpb)]]);
  return { pat, rows: new Map([[ch.name, row]]), resolved, note: names.join(' ') };
}

function helperBass(lib: Library, song: SongDoc, c: Extract<ComposeCommand, { op: 'compose-notes' }>): Out {
  const ch = channelIn(song, c.channels[0]!, 'pitched');
  const o = c.opts;
  const { pat, fresh } = patternFor(song, c.pattern, o.has('tpb') ? Number(o.get('tpb')) : null, progressionSteps(song, c.prog, o.get('bars')));
  const spans = spansFor(song, pat, c.prog, o.get('from'), o.get('bars'), fresh);
  const style = (o.get('style') ?? 'root') as (typeof BASS_STYLES)[number];
  const rate = o.get('rate') ?? ({ root: 'chord', 'root-fifth': '1/2', walking: '1/4', octave: '1/8' } as const)[style];
  const every = rateSteps(rate, pat.tpb);
  const range = rangeFor(lib, ch, o, [36, 60]);
  const vel = Number(o.get('vel') ?? VEL_DEFAULT);
  const key = song.key ? parseKey(song.key) : null;
  const row = rowOf(pat, ch.name);
  let last: number | null = null;
  spans.forEach((s, i) => {
    const pcs = chordClasses(s.chord);
    const bassPc = s.chord.inversion === null ? s.chord.root : pcs[s.chord.inversion]!;
    const roots = inRange(bassPc, range);
    if (!roots.length) throw new Error(`range ${rangeText(range)} has no ${pitchClassName(bassPc)}`);
    const root = style === 'walking' && last !== null ? nearest(roots, last) : roots[0]!;
    const k = every === null ? 1 : Math.ceil(s.len / every);
    const step = every ?? s.len;
    const fifthPc = (s.chord.root + (s.chord.tones[2] ?? 7)) % 12;
    const notes: number[] = [];
    if (style === 'root') for (let j = 0; j < k; j++) notes.push(root);
    else if (style === 'root-fifth') {
      const f = inRange(fifthPc, range);
      const fifth = f.length ? nearest(f, root + 7) : root;
      for (let j = 0; j < k; j++) notes.push(j % 2 === 0 ? root : fifth);
    } else if (style === 'octave') {
      const lo = root + 12 <= range[1] ? root : root - 12 >= range[0] ? root - 12 : root;
      for (let j = 0; j < k; j++) notes.push(j % 2 === 0 ? lo : lo + 12 <= range[1] ? lo + 12 : lo);
    } else {
      // walking: the root, chord tones heading for the next chord, and a step into its root
      notes.push(root);
      if (k >= 2) {
        const next = spans[i + 1];
        let target: number;
        if (next) {
          const np = chordClasses(next.chord)[next.chord.inversion ?? 0]!;
          const nr = nearest(inRange(np, range).length ? inRange(np, range) : [root], root);
          const below = key ? stepInScale(key, nr, -1) : nr - 1, above = key ? stepInScale(key, nr, 1) : nr + 1;
          target = nr >= root ? (below >= range[0] ? below : above) : (above <= range[1] ? above : below);
        } else {
          const f = inRange(fifthPc, range);
          target = f.length ? nearest(f, root) : root;
        }
        // chord tones on the beat after the root, then chord or scale tones; never the same note twice running
        const tones: number[] = [];
        for (const pc of pcs) tones.push(...inRange(pc, range));
        const scale: number[] = [];
        if (key) for (let m = range[0]; m <= range[1]; m++) if (inKey(key, m)) scale.push(m);
        for (let j = 1; j < k - 1; j++) {
          const ideal = root + ((target - root) * j) / (k - 1);
          const pool = (j === 1 || !scale.length ? tones : [...tones, ...scale]).filter((m) => m !== notes[j - 1] && (j < k - 2 || m !== target));
          notes.push(pool.length ? nearest(pool, ideal) : root);
        }
        notes.push(target);
      }
    }
    writeRun(row, s, notes, step, vel);
    last = notes[notes.length - 1]!;
  });
  const resolved = new Map<string, string>([...(o.has('from') ? [['from', o.get('from')!]] as [string, string][] : []), ['style', style], ['rate', rate], ...(c.prog !== null ? [['bars', o.get('bars') ?? '1']] as [string, string][] : []), ['range', rangeText(range)], ['vel', String(vel)], ['tpb', String(pat.tpb)]]);
  return { pat, rows: new Map([[ch.name, row]]), resolved };
}

function helperArp(lib: Library, song: SongDoc, c: Extract<ComposeCommand, { op: 'compose-notes' }>): Out {
  const ch = channelIn(song, c.channels[0]!, 'pitched');
  const o = c.opts;
  const { pat, fresh } = patternFor(song, c.pattern, o.has('tpb') ? Number(o.get('tpb')) : null, progressionSteps(song, c.prog, o.get('bars')));
  const spans = spansFor(song, pat, c.prog, o.get('from'), o.get('bars'), fresh);
  const order = o.get('pattern') ?? 'up';
  const rate = o.get('rate') ?? '1/16';
  const every = rateSteps(rate, pat.tpb) ?? Infinity;
  const octaves = Number(o.get('octaves') ?? 1);
  const range = rangeFor(lib, ch, o, [60, 84]);
  const vel = Number(o.get('vel') ?? VEL_DEFAULT);
  const rnd = order.startsWith('random') ? seededRandom(Number(/\d+/.exec(order)![0])) : null;
  const row = rowOf(pat, ch.name);
  for (const s of spans) {
    const base = inRange(s.chord.root, range)[0];
    if (base === undefined) throw new Error(`range ${rangeText(range)} has no ${pitchClassName(s.chord.root)}`);
    const seq: number[] = [];
    for (let k = 0; k < octaves; k++) for (const t of s.chord.tones) { const m = base + 12 * k + t; if (m <= range[1]) seq.push(m); }
    const cycle = order === 'down' ? [...seq].reverse() : order === 'updown' ? [...seq, ...seq.slice(1, -1).reverse()] : seq;
    const count = every === Infinity ? 1 : Math.ceil(s.len / every);
    const notes: number[] = [];
    let prevIdx = -1;
    for (let j = 0; j < count; j++) {
      if (rnd) {
        let idx = Math.floor(rnd() * seq.length);
        if (idx === prevIdx && seq.length > 1) idx = (idx + 1) % seq.length;
        prevIdx = idx;
        notes.push(seq[idx]!);
      } else notes.push(cycle[j % cycle.length]!);
    }
    writeRun(row, s, notes, every === Infinity ? s.len : every, vel);
  }
  const resolved = new Map<string, string>([...(o.has('from') ? [['from', o.get('from')!]] as [string, string][] : []), ['pattern', order], ['rate', rate], ['octaves', String(octaves)], ...(c.prog !== null ? [['bars', o.get('bars') ?? '1']] as [string, string][] : []), ['range', rangeText(range)], ['vel', String(vel)], ['tpb', String(pat.tpb)]]);
  return { pat, rows: new Map([[ch.name, row]]), resolved };
}

function helperDrums(song: SongDoc, c: Extract<ComposeCommand, { op: 'compose-notes' }>): Out {
  const chs = c.channels.map((n) => channelIn(song, n, 'drums'));
  const t = DRUM_TEMPLATES[c.template!]!;
  const o = c.opts;
  const bar = barSteps(song, t.tpb);
  if (bar !== t.kick.length) {
    const fit = Object.entries(DRUM_TEMPLATES).filter(([, x]) => x.beats === song.time[0] * 4 / song.time[1]).map(([k]) => k);
    throw new Error(`${c.template} is a bar of ${t.beats} beats; a bar of ${song.id} (${song.time[0]}/${song.time[1]}) is ${bar / t.tpb} (templates that fit: ${fit.join(', ') || 'none'})`);
  }
  const { pat } = patternFor(song, c.pattern, null, () => Number(o.get('bars') ?? 1) * bar);
  if (pat.tpb !== t.tpb) throw new Error(`${c.template} is written at tpb=${t.tpb} and pattern ${pat.name} at tpb=${pat.tpb} (use a template of the same grid, or another pattern)`);
  if (pat.steps % bar !== 0) throw new Error(`pattern ${pat.name} is not a whole number of bars`);
  const bars = pat.steps / bar;
  if (o.has('bars') && Number(o.get('bars')) !== bars) throw new Error(`pattern ${pat.name} is ${bars} bar${bars === 1 ? '' : 's'}, not ${o.get('bars')}`);
  const fill = Number(o.get('fill') ?? 0), seed = Number(o.get('seed') ?? 1), vary = Number(o.get('vary') ?? 0.25);
  const { rows, fills } = drumRows(t, bars, fill, seed, vary, chs.length);
  const resolved = new Map([['bars', String(bars)], ['fill', String(fill)], ['seed', String(seed)], ['vary', String(vary)]]);
  return { pat, rows: new Map(chs.map((ch, i) => [ch.name, rows[i]!] as const)), resolved, note: fills.length ? `fills: ${fills.join(', ')}` : undefined };
}

function helperHumanise(song: SongDoc, c: Extract<ComposeCommand, { op: 'compose-notes' }>): Out {
  const pat0 = song.patterns.get(c.pattern);
  if (!pat0) throw new Error(`song ${song.id} has no pattern '${c.pattern}' (patterns: ${[...song.patterns.keys()].join(', ') || 'none'})`);
  const { pat } = patternFor(song, c.pattern, null, () => 0);
  const names = c.channels[0] === 'all' ? pat.channels.map((x) => x.name) : c.channels;
  for (const n of names) if (!pat.channels.some((x) => x.name === n)) throw new Error(`pattern ${pat.name} has no row for channel ${n}`);
  const o = c.opts;
  const timing = Number(o.get('timing') ?? 8), velocity = Number(o.get('velocity') ?? 6), seed = Number(o.get('seed') ?? 1);
  const r = seededRandom(seed);
  const clampVel = (v: number): number => Math.max(1, Math.min(127, v));
  const nudge = (d: number): number | undefined => { const n = Math.round(d * timing); return n === 0 ? undefined : n; };
  const rows = new Map<string, Cell[]>();
  for (const n of names) {
    const row = rowOf(pat, n).map((cell): Cell => {
      if (cell.kind === 'notes') {
        return { kind: 'notes', notes: cell.notes.map((note) => {
          const dt = triangular(r), dv = triangular(r);
          const out: PNote = { ...note, fx: note.fx };
          if (timing > 0) { const v = nudge(dt); if (v === undefined) delete out.nudge; else out.nudge = v; }
          if (velocity > 0) out.vel = clampVel(note.vel + Math.round(dv * velocity));
          return out;
        }) };
      }
      if (cell.kind === 'drum') {
        const dt = triangular(r), dv = triangular(r);
        const out: Cell = { kind: 'drum', drum: cell.drum, vel: velocity > 0 ? clampVel(cell.vel + Math.round(dv * velocity)) : cell.vel };
        const v = timing > 0 ? nudge(dt) : cell.nudge;
        if (v !== undefined) out.nudge = v;
        return out;
      }
      return cell;
    });
    rows.set(n, row);
  }
  return { pat, rows, resolved: new Map([['timing', String(timing)], ['velocity', String(velocity)], ['seed', String(seed)]]) };
}

// ---- motifs ---------------------------------------------------------------------------------------------------------

interface MEvent { cell: Cell; len: number }

/** A motif as events: a note or chord with its holds, or a run of rests. */
function motifEvents(m: Motif): MEvent[] {
  const out: MEvent[] = [];
  for (const c of m.cells) {
    const last = out[out.length - 1];
    if (c.kind === 'hold' && last) last.len++;
    else if (c.kind === 'rest' && last && last.cell.kind === 'rest') last.len++;
    else out.push({ cell: c, len: 1 });
  }
  return out;
}

function eventsToCells(evs: MEvent[]): Cell[] {
  const out: Cell[] = [];
  for (const e of evs) for (let i = 0; i < e.len; i++) out.push(i === 0 ? e.cell : e.cell.kind === 'rest' ? { kind: 'rest' } : { kind: 'hold' });
  return out;
}

/** Every note of a cell moved by `f`; a note that leaves the key is marked `!`, one that comes back keeps its mark only if it had one. */
function mapNotes(cell: Cell, f: (m: number) => number, key: Key | null): Cell {
  if (cell.kind !== 'notes') return cell;
  return { kind: 'notes', notes: cell.notes.map((n) => {
    const m = f(n.midi);
    if (m < MIDI_LOW || m > MIDI_HIGH) throw new Error(`${noteLabel(n.midi)} would move outside the MIDI range`);
    const out: PNote = { ...n, midi: m };
    delete out.accidental;
    if (key && !inKey(key, m)) out.accidental = true;
    else if (n.accidental && !key) out.accidental = true;
    return out;
  }) };
}

function moveBy(key: Key | null, by: number, mode: string): (m: number) => number {
  if (mode === 'diatonic') {
    if (!key) throw new Error('mode=diatonic moves along the song\'s scale: set the song\'s key first');
    return (m) => stepInScale(key, m, by);
  }
  return (m) => m + by;
}

function motifOf(song: SongDoc, name: string): Motif {
  const m = song.motifs.find((x) => x.name === name);
  if (!m) throw new Error(`song ${song.id} has no motif '${name}' (motifs: ${song.motifs.map((x) => x.name).join(', ') || 'none; motif set <song> <name> "<notes>"'})`);
  return m;
}

/** A motif transformed; the song is not changed. */
function transformMotif(song: SongDoc, c: Extract<ComposeCommand, { op: 'compose-motif' }>): { motif: Motif; resolved: Map<string, string> } {
  const src = motifOf(song, c.name);
  const o = c.opts;
  const key = song.key ? parseKey(song.key) : null;
  const evs = motifEvents(src);
  const as = o.get('as') ?? c.name;
  const resolved = new Map<string, string>();
  let out: Motif;
  switch (c.verb) {
    case 'transpose': {
      const mode = o.get('mode') ?? 'chromatic';
      const f = moveBy(key, Number(o.get('by')), mode);
      out = { name: as, tpb: src.tpb, cells: src.cells.map((x) => mapNotes(x, f, key)) };
      resolved.set('by', o.get('by')!).set('mode', mode);
      break;
    }
    case 'invert': {
      const first = src.cells.find((x) => x.kind === 'notes');
      if (!first || first.kind !== 'notes') throw new Error(`motif ${c.name} has no notes to invert`);
      const around = o.has('around') ? parseNote(o.get('around')!) : first.notes[0]!.midi;
      if (around === null) throw new Error(`'${o.get('around')}' is not a note`);
      const mode = o.get('mode') ?? (key ? 'diatonic' : 'chromatic');
      let f: (m: number) => number;
      if (mode === 'diatonic') {
        if (!key) throw new Error('mode=diatonic mirrors along the song\'s scale: set the song\'s key first');
        const a = degreeOf(key, around);
        f = (m) => { const d = degreeOf(key, m); return fromDegree(key, 2 * a.deg - d.deg, -d.off) + a.off; };
      } else f = (m) => 2 * around - m;
      out = { name: as, tpb: src.tpb, cells: src.cells.map((x) => mapNotes(x, f, key)) };
      resolved.set('around', noteLabel(around)).set('mode', mode);
      break;
    }
    case 'retrograde':
      out = { name: as, tpb: src.tpb, cells: eventsToCells([...evs].reverse()) };
      break;
    case 'augment': {
      const k = Number(o.get('factor') ?? 2);
      out = { name: as, tpb: src.tpb, cells: eventsToCells(evs.map((e) => ({ ...e, len: e.len * k }))) };
      resolved.set('factor', String(k));
      break;
    }
    case 'diminish': {
      const k = Number(o.get('factor') ?? 2);
      // halve the lengths when they all divide; else play the same cells on a finer grid
      if (evs.every((e) => e.len % k === 0)) out = { name: as, tpb: src.tpb, cells: eventsToCells(evs.map((e) => ({ ...e, len: e.len / k }))) };
      else {
        if (src.tpb * k > 24) throw new Error(`diminishing ${c.name} by ${k} needs a grid of ${src.tpb * k} steps per beat (the most is 24)`);
        out = { name: as, tpb: src.tpb * k, cells: src.cells };
      }
      resolved.set('factor', String(k));
      break;
    }
    default: throw new Error(`motif ${c.verb} is not a transform`);
  }
  if (o.has('as')) resolved.set('as', as);
  return { motif: out, resolved };
}

/** A motif's cells at a pattern's grid, moved by `f`. Throws when a note does not land on the grid. */
function motifAt(m: Motif, tpb: number, f: (x: number) => number, key: Key | null, vel: number | null): Cell[] {
  const ratio = tpb / m.tpb;
  const out: Cell[] = [];
  for (const e of motifEvents(m)) {
    const len = e.len * ratio;
    if (!Number.isInteger(len) || len < 1) throw new Error(`motif ${m.name} (tpb=${m.tpb}) does not fit a grid of tpb=${tpb}: write it into a pattern with a finer grid`);
    let cell = mapNotes(e.cell, f, key);
    if (vel !== null && cell.kind === 'notes') cell = { kind: 'notes', notes: cell.notes.map((n) => ({ ...n, vel })) };
    for (let i = 0; i < len; i++) out.push(i === 0 ? cell : cell.kind === 'rest' ? { kind: 'rest' } : { kind: 'hold' });
  }
  return out;
}

function helperMotifWrite(song: SongDoc, c: Extract<ComposeCommand, { op: 'compose-notes' }>): Out {
  const ch = channelIn(song, c.channels[0]!, 'pitched');
  const m = motifOf(song, c.motif!);
  const o = c.opts;
  const key = song.key ? parseKey(song.key) : null;
  const vel = o.has('vel') ? Number(o.get('vel')) : null;
  const defTpb = 4 % m.tpb === 0 ? 4 : m.tpb;
  if (c.helper === 'motif-write') {
    const at = Number(o.get('at') ?? 0), by = Number(o.get('by') ?? 0), mode = o.get('mode') ?? 'chromatic';
    const { pat } = patternFor(song, c.pattern, o.has('tpb') ? Number(o.get('tpb')) : null, (tpb) => {
      const bar = barSteps(song, tpb);
      const need = Math.ceil((m.cells.length * tpb) / m.tpb / bar);
      return Number(o.get('bars') ?? need) * bar;
    });
    const cells = motifAt(m, pat.tpb, moveBy(key, by, mode), key, vel);
    if (at + cells.length > pat.steps) throw new Error(`motif ${m.name} is ${cells.length} steps at tpb=${pat.tpb}; from step ${at} it runs past the pattern's ${pat.steps}`);
    const row = rowOf(pat, ch.name);
    cells.forEach((x, i) => { row[at + i] = x; });
    if (cells[0]!.kind === 'hold' && (at === 0 || row[at - 1]!.kind === 'rest')) row[at] = { kind: 'rest' };
    const resolved = new Map<string, string>([['at', String(at)], ['by', String(by)], ['mode', mode], ...(vel !== null ? [['vel', String(vel)]] as [string, string][] : []), ['tpb', String(pat.tpb)]]);
    return { pat, rows: new Map([[ch.name, row]]), resolved };
  }
  // a sequence: the motif once per chord, moved as the chord's root moves from the first chord's
  const mode = o.get('mode') ?? 'diatonic';
  const k = keyOf(song);
  const { pat, fresh } = patternFor(song, c.pattern, o.has('tpb') ? Number(o.get('tpb')) : defTpb === 4 ? null : defTpb, progressionSteps(song, c.prog, o.get('bars')));
  const spans = spansFor(song, pat, c.prog, undefined, o.get('bars'), fresh);
  const row = rowOf(pat, ch.name);
  const first = spans[0]!.chord;
  for (const s of spans) {
    const shift = mode === 'diatonic' ? s.chord.degree - first.degree : ((((s.chord.root - first.root) % 12) + 18) % 12) - 6;
    const cells = motifAt(m, pat.tpb, moveBy(k, shift, mode), k, vel).slice(0, s.len);
    cells.forEach((x, i) => { row[s.start + i] = x; });
    for (let i = cells.length; i < s.len; i++) row[s.start + i] = { kind: 'rest' };
  }
  const resolved = new Map<string, string>([['bars', o.get('bars') ?? '1'], ['mode', mode], ...(vel !== null ? [['vel', String(vel)]] as [string, string][] : []), ['tpb', String(pat.tpb)]]);
  return { pat, rows: new Map([[ch.name, row]]), resolved };
}

// ---- applying -----------------------------------------------------------------------------------------------------

/** Put rows into a pattern of the song (making it when it is new). */
function mergeRows(song: SongDoc, written: Pattern): void {
  const have = song.patterns.get(written.name);
  if (!have) {
    if (song.patterns.size >= 64) throw new Error('a song has at most 64 patterns');
    song.patterns.set(written.name, written);
    return;
  }
  if (have.steps !== written.steps || have.tpb !== written.tpb) throw new Error(`pattern ${written.name} is ${have.steps} steps at tpb=${have.tpb}; the written rows are ${written.steps} at tpb=${written.tpb}`);
  const channels: PatternChannel[] = have.channels.map((c) => written.channels.find((w) => w.name === c.name) ?? c);
  for (const w of written.channels) if (!channels.some((c) => c.name === w.name)) channels.push(w);
  song.patterns.set(written.name, { ...have, channels });
}

/** The rows a helper wrote, as a pattern of their own (the text in `written=`). */
function writtenPattern(out: Out): Pattern {
  const p: Pattern = { name: out.pat.name, steps: out.pat.steps, tpb: out.pat.tpb, bar: out.pat.bar, channels: [...out.rows].map(([name, cells]) => ({ name, cells })) };
  const check = parsePattern(formatPattern(p), p.name);
  if (!check.pattern) throw new Error(`the helper wrote rows that do not read back (${check.errors[0]!.message}); please report this`);
  return check.pattern;
}

export function applyCompose(lib: Library, c: ComposeCommand): string | undefined {
  const song = songOf(lib, c.song);
  if (c.op === 'compose-layer-plan') {
    const plan = c.plan.map(([l, chs]) => [l, [...chs]] as [string, string[]]);
    for (const [, chs] of plan) for (const n of chs) if (!song.channels.some((x) => x.name === n)) throw new Error(`song ${song.id} has no channel ${n} (channels: ${song.channels.map((x) => x.name).join(', ')})`);
    // a channel the plan leaves out joins the base
    for (const ch of song.channels) if (!plan.some(([, chs]) => chs.includes(ch.name))) plan[0]![1].push(ch.name);
    song.channels = song.channels.map((ch) => ({ ...ch, layer: plan.find(([, chs]) => chs.includes(ch.name))![0] }));
    song.layers = plan.map(([l]) => l);
    lib.songs.set(song.id, song);
    return `layer-plan ${song.id} ${plan.map(([l, chs]) => `${l}=${chs.join(',')}`).join(' ')}`;
  }
  if (c.op === 'compose-motif') {
    if (c.verb === 'set') {
      const m = { ...c.written!, name: c.name };
      const at = song.motifs.findIndex((x) => x.name === c.name);
      if (at >= 0) song.motifs[at] = m;
      else { if (song.motifs.length >= 32) throw new Error('a song keeps at most 32 motifs'); song.motifs.push(m); }
      lib.songs.set(song.id, song);
      return undefined;
    }
    if (c.verb === 'remove') {
      motifOf(song, c.name);
      song.motifs = song.motifs.filter((x) => x.name !== c.name);
      lib.songs.set(song.id, song);
      return undefined;
    }
    let result: Motif;
    let normal: string | undefined;
    if (c.written) { motifOf(song, c.name); result = { ...c.written, name: c.opts.get('as') ?? c.name }; }
    else {
      const t = transformMotif(song, c);
      result = t.motif;
      normal = `motif ${c.verb} ${song.id} ${c.name}${optText(`motif-${c.verb}`, t.resolved)} written=${quote(`tpb=${result.tpb} ${motifText(result)}`)}`;
    }
    const at = song.motifs.findIndex((x) => x.name === result.name);
    if (at >= 0) song.motifs[at] = result;
    else { if (song.motifs.length >= 32) throw new Error('a song keeps at most 32 motifs'); song.motifs.push(result); }
    lib.songs.set(song.id, song);
    return normal;
  }
  if (c.written) {
    for (const n of c.channels) if (n !== 'all' && !c.written.channels.some((w) => w.name === n)) throw new Error(`written= has no row for ${n}`);
    mergeRows(song, c.written);
    lib.songs.set(song.id, song);
    return undefined;
  }
  let out: Out;
  switch (c.helper) {
    case 'chords': out = helperChords(lib, song, c); break;
    case 'bass': out = helperBass(lib, song, c); break;
    case 'arp': out = helperArp(lib, song, c); break;
    case 'drums': out = helperDrums(song, c); break;
    case 'humanise': out = helperHumanise(song, c); break;
    default: out = helperMotifWrite(song, c);
  }
  // a note a helper writes outside the key (V in a minor key, bVII, V/V) is meant: it is marked !
  if (song.key && c.helper !== 'drums' && c.helper !== 'humanise') {
    const key = parseKey(song.key);
    for (const row of out.rows.values()) row.forEach((cell, i) => {
      if (cell.kind === 'notes' && cell.notes.some((n) => !inKey(key, n.midi) && !n.accidental)) row[i] = { kind: 'notes', notes: cell.notes.map((n) => (inKey(key, n.midi) || n.accidental ? n : { ...n, accidental: true })) };
    });
  }
  const w = writtenPattern(out);
  mergeRows(song, w);
  lib.songs.set(song.id, song);
  const head = c.helper === 'motif-write' || c.helper === 'motif-sequence'
    ? `motif ${c.helper.slice(6)} ${song.id} ${c.motif} ${c.pattern} ${c.channels[0]}`
    : `${c.helper} ${song.id} ${c.pattern} ${c.channels.join(',')}${c.template ? ' ' + c.template : ''}`;
  return `${head}${c.prog !== null ? ' ' + quote(c.prog) : ''}${optText(c.helper, out.resolved)} written=${quote(formatPattern(w))}`;
}

// ---- reading the tape ----------------------------------------------------------------------------------------------

/** A tape line for people: a helper's command, then the rows it wrote, one per line. */
export function tapeLineLines(cmd: string): string[] {
  const m = /^(.*?) written="((?:[^"\\]|\\.)*)"$/.exec(cmd);
  if (!m) return [cmd];
  const body = m[2]!.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const lines = body.split('\n').filter((l) => l.trim() && !/^pattern\s/.test(l));
  return [`${m[1]}  (wrote:)`, ...lines.map((l) => (l.startsWith('  ') ? l : `  ${l}`))];
}

// ---- scale queries ------------------------------------------------------------------------------------------------

/** What `soundclaw scale` prints: the scale's notes, and for a seven-note scale its chords by degree. */
export function scaleText(keyText: string): string {
  if (keyText === 'list') return ['scales (use them as <tonic>:<scale>, like D:dorian):', ...Object.keys(SCALES).map((n) => `  ${n.padEnd(18)} ${SCALES[n]!.join(' ').padEnd(24)} ${SCALE_NOTES[n] ?? ''}`)].join('\n');
  const key = parseKey(keyText);
  const lines = [`${keyText}: ${key.classes.map((c) => pitchClassName(c)).join(' ')}  (${SCALE_NOTES[key.mode] ?? key.mode})`];
  const chords = diatonicChords(key);
  if (chords.length) {
    lines.push('  degree  triad                 seventh');
    for (const ch of chords) {
      const tri = chordOfNotes(ch.triad.map((pc, i) => pc + 12 * (i > 0 && pc < ch.triad[0]! ? 1 : 0) + 48));
      const sev = chordOfNotes(ch.seventh.map((pc, i) => pc + 12 * (i > 0 && pc < ch.seventh[0]! ? 1 : 0) + 48));
      lines.push(`  ${ch.numeral.padEnd(6)}  ${chordName(tri).padEnd(6)} ${ch.triad.map((x) => pitchClassName(x)).join(' ').padEnd(14)} ${chordName(sev).padEnd(8)} ${ch.seventh.map((x) => pitchClassName(x)).join(' ')}`);
    }
    lines.push('  chords outside the key: bVII, bVI, iv (borrowed), V/V, V7/vi (secondary); suffixes 7 maj7 sus2 sus4 add9 6 64 65 43 42');
  } else lines.push(`  roman numerals count in ${key.classes.length === 7 ? 'this scale' : SCALES[key.mode]!.includes(4) ? 'the major scale' : 'the natural minor scale'} on ${pitchClassName(key.tonic)} (this scale has ${key.classes.length} notes)`);
  return lines.join('\n');
}
