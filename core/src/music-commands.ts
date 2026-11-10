// The music commands: `instrument …`, `pattern …` and `song …`. They parse (with line and column)
// and apply to the library like the sound commands, and have a normal form that goes on the tape.
//
//   instrument new <id> [from=<instrument>] [kind=osc|fm|ks|classic|sample] [seed=<n>]
//   instrument from-sound <id> <sound> [root=<note>]
//   instrument set <id> <key>=<value> ...     root pitched attack decay sustain release adsr velocity range pitchenv pitch-check legato gain seed
//   instrument layer|fx|env <…> <id> …        the layer, fx and env commands, on the instrument's template
//   instrument copy|rename <id> <to>   instrument remove <id>
//   pattern set <song>.<name> "<pattern text>"  (a block under `pattern <song>.<name> steps=.. tpb=..` in scripts)
//   pattern note add|remove|move|len|set <song>.<name> <channel> <step> …   one note at a time (songedit.ts)
//   pattern remove|copy|rename <song>.<name> [<new name>]
//   song new <id> [tempo=] [swing=] [time=4/4] [key=C:major] [class=] ...    song set <id> <key>=<value> ...
//   song channel add|set <song> <name> inst=<instrument> | kit=<k:instrument,…>|default  [gain=] [pan=] [layer=]
//   song channel remove <song> <name>
//   song channel add <song> <name> audio [gain=] [pan=] [layer=] [reverb=] [delay=] [convolve=]     an audio channel, which plays clips
//   song clip add <song> <channel> <sample> at=<bar>[.<beat>] [len=<bars>|full] [stretch=tempo|none] [from-tempo=<bpm>] [method=wsola|pv] [pitch=] [gain=] [fade=] [slice=] [nudge=<ms>]
//   song clip set <song> <channel> <clip> <key>=<value> ...     song clip remove <song> <channel> <clip>
//   song section add|set <song> <name> <pattern>… [x<n>]    song section remove <song> <name>    song order <song> <section>…
//   song intro|ending <song> <section>|none     song loop <song> <from>[..<to>]|auto|off
//   song fx add|set|remove|move <song> …        the master chain
//   song copy|rename <id> <to>   song remove <id>   song mark <id> approved|rejected|draft

import { CLASS_NAME_RE } from './checks.ts';
import { DiagError, quote, type Command, type Token } from './commands.ts';
import {
  INSTRUMENT_ID_RE, INSTRUMENT_PARAMS, PITCH_CHECKS, builtinInstruments, cloneInstrument, fromBuiltin, guessRoot, instrumentFromSound, newInstrument, type Instrument, type PitchCheck,
} from './instrument.ts';
import { SOURCE_KINDS, newLayer, parseEnv, parseValue, type Env, type SourceKind, formatEnv } from './layered.ts';
import type { Library } from './sets.ts';
import { noteLabel, parseKey, parseNote, parseRange } from './music.ts';
import { formatPattern, parsePattern, PATTERN_NAME_RE, type Pattern } from './pattern.ts';
import { CLIP_ID_RE, MAX_CLIPS, beatsPerBar, parseAt } from './clips.ts';
import {
  MAX_CHANNELS, DEFAULT_LAYER, LAYER_NAME_RE, SECTION_RE, SONG_ID_RE, SWING, TEMPO, cloneSong, newSong, songProblems, type AudioClip, type Channel, type SongDoc,
} from './song.ts';
import { applyLayerCommand } from './layer-ops.ts';
import { applyNoteEdit, noteEditText, parseNoteEdit, type NoteEdit } from './songedit.ts';
import { applyCommand, parse } from './commands.ts';
import { bibleCommands, projectKey } from './musicstyle.ts';
import { STINGER_TEMPLATES, stingerCommands } from './stingers.ts';
import { SEND_KINDS, SONG_KINDS, TAG_RE, type SendKind, type SongKind } from './song.ts';
import { idClash } from './sound.ts';
import { KIT_ALL, kitText } from './song.ts';
import { SAMPLE_NAME_RE } from './samples.ts';
import { MAX_ZONES, ZONE_KEYS, cloneZone, newZone, setZoneValue, zoneWords, type Zone } from './zones.ts';
import { FX_SPECS, defaultsOf, newLayeredSound, type Fx, type LayeredSound } from './layered.ts';

export type InstValue = number | boolean | string | [number, number] | Env | null;

export type MusicCommand =
  | { op: 'inst-new'; id: string; from: string | null; kind: SourceKind | null; seed: number; text: string }
  | { op: 'inst-from-sound'; id: string; sound: string; root: number | null; text: string }
  | { op: 'inst-set'; id: string; values: [string, InstValue][]; text: string }
  | { op: 'inst-edit'; id: string; inner: Command; text: string }
  | { op: 'inst-zone'; id: string; verb: 'add' | 'set' | 'remove' | 'clear'; n: number; values: [string, string][]; text: string }
  | { op: 'inst-zones'; id: string; how: 'from-samples' | 'from-slices'; names: string[]; root: 'detect' | null; vel: [number, number] | null; start: number | null; text: string }
  | { op: 'inst-from-sample'; id: string; sample: string; loop: 'find' | null; text: string }
  | { op: 'inst-copy' | 'inst-rename'; id: string; to: string; text: string }
  | { op: 'inst-remove'; id: string; text: string }
  | { op: 'pattern-set'; song: string; name: string; pattern: Pattern; text: string }
  | { op: 'pattern-remove'; song: string; name: string; text: string }
  | { op: 'pattern-note'; song: string; name: string; edit: NoteEdit; text: string }
  | { op: 'pattern-copy' | 'pattern-rename'; song: string; name: string; to: string; text: string }
  | { op: 'song-new'; id: string; values: [string, SongValue][]; fromBible: string | null; template: string | null; text: string }
  | { op: 'song-set'; id: string; values: [string, SongValue][]; text: string }
  | { op: 'song-clip'; verb: 'add' | 'set' | 'remove'; id: string; channel: string; clip: number | null; fields: ClipFields; text: string }
  | { op: 'song-channel'; verb: 'add' | 'set'; id: string; name: string; audio: boolean; inst: string | null; kit: Record<string, string> | null; gain: number | null; pan: number | null; layer: string | null; harmony: boolean | null; reverb: number | null; delay: number | null; convolve: number | null; text: string }
  | { op: 'song-send'; id: string; kind: SendKind; off: boolean; values: [string, number | string][]; text: string }
  | { op: 'song-channel-remove'; id: string; name: string; text: string }
  | { op: 'song-section'; verb: 'add' | 'set'; id: string; name: string; patterns: string[]; repeat: number; text: string }
  | { op: 'song-section-remove'; id: string; name: string; text: string }
  | { op: 'song-order'; id: string; names: string[]; text: string }
  | { op: 'song-role'; id: string; role: 'intro' | 'ending'; section: string | null; text: string }
  | { op: 'song-loop'; id: string; loop: null | false | { from: string; to: string }; text: string }
  | { op: 'song-fx'; id: string; inner: Command; text: string }
  | { op: 'song-copy' | 'song-rename'; id: string; to: string; text: string }
  | { op: 'song-remove'; id: string; text: string }
  | { op: 'song-mark'; id: string; status: 'approved' | 'rejected' | 'draft'; text: string };

export type SongValue = number | string | null;

/** What a `song clip add|set` gives (each key only when given). `at` is the bar and beat as written; it is turned into beats by the song's time signature when the command runs. */
export interface ClipFields {
  sample?: string;
  at?: string;
  nudge?: number;
  len?: number | 'full';
  stretch?: 'none' | 'tempo';
  fromTempo?: number | 'none';
  method?: 'wsola' | 'pv';
  pitch?: number;
  gain?: number;
  fade?: number;
  slice?: number;
}

const CLIP_KEYS = ['sample', 'at', 'nudge', 'len', 'stretch', 'from-tempo', 'method', 'pitch', 'gain', 'fade', 'slice'] as const;

function clipField(key: string, v: string): ClipFields {
  switch (key) {
    case 'sample': if (!SAMPLE_NAME_RE.test(v)) throw new Error(`'${v}' is not a sample name (letters, digits, _ and -)`); return { sample: v };
    case 'at': if (!/^\d{1,4}(\.\d{1,2})?$/.test(v)) throw new Error(`at is a bar, or a bar and a beat: 3 (the start of bar 3) or 3.2 (beat 2 of bar 3); got '${v}'`); return { at: v };
    case 'nudge': return { nudge: numIn('nudge', v, -500, 500, 'ms') };
    case 'len': return { len: v === 'full' ? 'full' : numIn('len', v, 0.0625, 512, 'bars') };
    case 'stretch': if (v !== 'none' && v !== 'tempo') throw new Error(`stretch is tempo (fit the clip to the song's tempo, from from-tempo) or none (got '${v}')`); return { stretch: v };
    case 'from-tempo': return { fromTempo: v === 'none' ? 'none' : numIn('from-tempo', v, 30, 300, 'bpm') };
    case 'method': if (v !== 'wsola' && v !== 'pv') throw new Error(`method is wsola (hits, drums, voices) or pv (tones, pads) (got '${v}')`); return { method: v };
    case 'pitch': return { pitch: numIn('pitch', v, -48, 48, 'semitones') };
    case 'gain': return { gain: numIn('gain', v, 0, 4) };
    case 'fade': return { fade: numIn('fade', v, 0, 10, 's') };
    case 'slice': { const n = numIn('slice', v, 0, 1024); if (!Number.isInteger(n)) throw new Error(`slice is a whole number (got '${v}')`); return { slice: n }; }
    default: throw new Error(`a clip has ${CLIP_KEYS.join(', ')} (got '${key}')`);
  }
}

/** The fields as the words that give them, in a fixed order (the normal form of a clip command). */
function clipFieldWords(f: ClipFields): string[] {
  const w: string[] = [];
  if (f.sample !== undefined) w.push(`sample=${f.sample}`);
  if (f.at !== undefined) w.push(`at=${f.at}`);
  if (f.nudge !== undefined) w.push(`nudge=${f.nudge}`);
  if (f.len !== undefined) w.push(`len=${f.len}`);
  if (f.stretch !== undefined) w.push(`stretch=${f.stretch}`);
  if (f.fromTempo !== undefined) w.push(`from-tempo=${f.fromTempo}`);
  if (f.method !== undefined) w.push(`method=${f.method}`);
  if (f.pitch !== undefined) w.push(`pitch=${f.pitch}`);
  if (f.gain !== undefined) w.push(`gain=${f.gain}`);
  if (f.fade !== undefined) w.push(`fade=${f.fade}`);
  if (f.slice !== undefined) w.push(`slice=${f.slice}`);
  return w;
}

function applyClipFields(k: AudioClip, f: ClipFields, time: readonly [number, number]): void {
  if (f.sample !== undefined) k.sample = f.sample;
  if (f.at !== undefined) k.at = parseAt(f.at, time);
  if (f.nudge !== undefined) k.nudge = f.nudge;
  if (f.len !== undefined) k.len = f.len === 'full' ? null : f.len * beatsPerBar(time);
  if (f.fromTempo !== undefined) {
    k.fromTempo = f.fromTempo === 'none' ? null : f.fromTempo;
    if (f.fromTempo !== 'none' && f.stretch === undefined) k.stretch = 'tempo';
  }
  if (f.stretch !== undefined) k.stretch = f.stretch;
  if (f.method !== undefined) k.method = f.method;
  if (f.pitch !== undefined) k.pitch = f.pitch;
  if (f.gain !== undefined) k.gain = f.gain;
  if (f.fade !== undefined) k.fade = f.fade;
  if (f.slice !== undefined) k.slice = f.slice;
  if (k.stretch === 'tempo' && !k.fromTempo) throw new Error('stretch=tempo needs from-tempo=<bpm>, the tempo the recording was made at (run through a project, the command measures one and writes it for you)');
}

const newClip = (id: number, sample: string): AudioClip => ({ id, sample, at: 0, nudge: 0, len: null, stretch: 'none', fromTempo: null, method: 'wsola', pitch: 0, gain: 1, fade: 0, slice: 0 });

/** The number the next clip of a song gets. */
export const nextClipId = (s: Pick<SongDoc, 'channels'>): number => 1 + s.channels.reduce((m, c) => (c.clips ?? []).reduce((n, k) => Math.max(n, k.id), m), 0);

export const MUSIC_HEADS = ['instrument', 'pattern', 'song'] as const;

const numberOf = (s: string): number | null => (/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) ? Number(s) : null);

function checkIn(t: Token | undefined, line: number, what: string, re: RegExp, kind: string): string {
  if (!t) throw new DiagError(line, 1, `${what}: give the ${kind}`);
  if (!re.test(t.v)) throw new DiagError(line, t.col, `'${t.v}' is not ${kind.startsWith('a') || kind.startsWith('e') || kind.startsWith('i') ? 'an' : 'a'} ${kind} (letters, digits, _ and -, starting with a letter)`);
  return t.v;
}

function pairs(tokens: Token[], line: number, what: string): { key: string; value: string; t: Token }[] {
  return tokens.map((t) => {
    const m = /^([A-Za-z][A-Za-z0-9-]*)=(.*)$/s.exec(t.v);
    if (!m) throw new DiagError(line, t.col, `${what}: '${t.v}' is not <name>=<value>`);
    let v = m[2]!;
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    return { key: m[1]!, value: v, t };
  });
}

const yesNo = (v: string): boolean | null => (['yes', 'on', 'true'].includes(v) ? true : ['no', 'off', 'false'].includes(v) ? false : null);

function numIn(key: string, v: string, min: number, max: number, unit = ''): number {
  const n = numberOf(v);
  if (n === null || n < min || n > max) throw new Error(`${key} must be a number from ${min} to ${max}${unit ? ' ' + unit : ''} (got '${v}')`);
  return n;
}

function noteOf(v: string, key: string): number {
  const n = parseNote(v) ?? (/^\d+$/.test(v) && Number(v) <= 127 ? Number(v) : null);
  if (n === null) throw new Error(`${key} is a note like C4 or A3 (got '${v}')`);
  return n;
}

export function parseInstValue(key: string, v: string): [string, InstValue][] {
  switch (key) {
    case 'root': return [['root', noteOf(v, 'root')]];
    case 'pitched': { const b = yesNo(v); if (b === null) throw new Error(`pitched is yes or no (got '${v}')`); return [['pitched', b]]; }
    case 'attack': case 'decay': case 'sustain': case 'release': case 'velocity': case 'gain': case 'seed': {
      const sp = INSTRUMENT_PARAMS[key];
      const n = numIn(key, v, sp.min, sp.max, sp.unit);
      if (key === 'seed' && !Number.isInteger(n)) throw new Error('seed is a whole number');
      return [[key, n]];
    }
    case 'adsr': {
      const xs = v.split(',').map((x) => numberOf(x.trim()));
      if (xs.length !== 4 || xs.some((x) => x === null)) throw new Error('adsr=<attack>,<decay>,<sustain>,<release> (seconds, seconds, level 0 to 1, seconds)');
      return (['attack', 'decay', 'sustain', 'release'] as const).flatMap((k, i) => parseInstValue(k, String(xs[i])));
    }
    case 'pitch-check': {
      if (!(PITCH_CHECKS as readonly string[]).includes(v)) throw new Error(`pitch-check is full (the note, octave included), class (the pitch class, octave ignored: bells and other inharmonic voices) or onset (timing only), got '${v}'`);
      return [['pitch-check', v]];
    }
    case 'velxfade': return [['velxfade', numIn('velxfade', v, 0, 64, 'velocity steps')]];
    case 'rr': {
      if (v !== 'cycle' && v !== 'hash') throw new Error(`rr is cycle (round-robin zones take turns) or hash (picked from the channel, the note's time and its pitch), got '${v}'`);
      return [['rr', v]];
    }
    case 'legato': { const b = yesNo(v); if (b === null) throw new Error(`legato is yes or no (got '${v}')`); return [['legato', b]]; }
    case 'range': {
      if (v === 'none') return [['range', null]];
      const r = parseRange(v);
      if (!r) throw new Error(`range is two notes like C3-C6, or none (got '${v}')`);
      return [['range', r]];
    }
    case 'pitchenv': {
      if (v === 'none') return [['pitchenv', null]];
      const e = parseEnv(v);
      for (const p of e) if (p.v < -60 || p.v > 60) throw new Error(`pitchenv values are semitones from -60 to 60 (got ${p.v})`);
      return [['pitchenv', e]];
    }
    default: throw new Error(`no instrument setting '${key}' (root, pitched, attack, decay, sustain, release, adsr, velocity, range, pitchenv, pitch-check, legato, velxfade, rr, gain, seed; layers have: instrument layer set <id> <n> <param>=<value>)`);
  }
}

// ---- parsing ------------------------------------------------------------------------------------------------------

type ParseLine = (tokens: Token[], line: number) => Command;

/** `instrument …`, `pattern …` or `song …`; `parseSub` parses the sound-command line the forwarding verbs wrap. */
export function parseMusic(head: Token, rest: Token[], line: number, parseSub: ParseLine): Command {
  if (head.v === 'instrument') return parseInstrument(head, rest, line, parseSub) as unknown as Command;
  if (head.v === 'pattern') return parsePatternCmd(head, rest, line) as unknown as Command;
  return parseSong(head, rest, line, parseSub) as unknown as Command;
}

function parseInstrument(head: Token, rest: Token[], line: number, parseSub: ParseLine): MusicCommand {
  const [verb, ...args] = rest;
  if (!verb) throw new DiagError(line, head.col, 'instrument: new, from-sound, from-sample, set, layer, fx, env, zone, zones, copy, rename or remove');
  if (verb.v === 'new') {
    const id = checkIn(args[0], line, 'instrument new', INSTRUMENT_ID_RE, 'instrument id');
    let from: string | null = null, kind: SourceKind | null = null, seed: number | null = null, zonesOnly = false;
    for (const p of pairs(args.slice(1), line, 'instrument new')) {
      if (p.key === 'from') from = p.value;
      else if (p.key === 'kind') {
        if (p.value === 'zones') { zonesOnly = true; continue; }
        if (!(SOURCE_KINDS as readonly string[]).includes(p.value)) throw new DiagError(line, p.t.col, `kind is one of ${SOURCE_KINDS.join(', ')}, zones`);
        kind = p.value as SourceKind;
      } else if (p.key === 'seed') {
        const n = numberOf(p.value);
        if (n === null || !Number.isInteger(n) || n < 0 || n > 4294967295) throw new DiagError(line, p.t.col, 'seed is a whole number from 0 to 4294967295');
        seed = n;
      } else throw new DiagError(line, p.t.col, `instrument new: unexpected '${p.key}' (from=<instrument or built-in>, kind=<${SOURCE_KINDS.join('|')}>, seed=<n>)`);
    }
    if (from && (kind || zonesOnly)) throw new DiagError(line, verb.col, 'instrument new: give from= or kind=, not both');
    if (kind && zonesOnly) throw new DiagError(line, verb.col, 'instrument new: give one kind=');
    if (!from && !kind && !zonesOnly) kind = 'osc';
    seed ??= 1;
    return { op: 'inst-new', id, from, kind, seed, text: `instrument new ${id}${from ? ` from=${from}` : zonesOnly ? ' kind=zones' : ` kind=${kind}`} seed=${seed}` };
  }
  if (verb.v === 'from-sound') {
    const id = checkIn(args[0], line, 'instrument from-sound', INSTRUMENT_ID_RE, 'instrument id');
    const sound = args[1];
    if (!sound) throw new DiagError(line, verb.col, `instrument from-sound ${id}: give the sound to make it from`);
    let root: number | null = null;
    for (const p of pairs(args.slice(2), line, 'instrument from-sound')) {
      if (p.key !== 'root') throw new DiagError(line, p.t.col, `instrument from-sound: unexpected '${p.key}' (root=<note>)`);
      try { root = noteOf(p.value, 'root'); } catch (e) { throw new DiagError(line, p.t.col, (e as Error).message); }
    }
    return { op: 'inst-from-sound', id, sound: sound.v, root, text: `instrument from-sound ${id} ${sound.v}${root !== null ? ` root=${noteLabel(root)}` : ''}` };
  }
  if (verb.v === 'set') {
    const id = checkIn(args[0], line, 'instrument set', INSTRUMENT_ID_RE, 'instrument id');
    const ps = pairs(args.slice(1), line, `instrument set ${id}`);
    if (!ps.length) throw new DiagError(line, verb.col, `instrument set ${id}: give at least one <key>=<value> (root, pitched, attack, decay, sustain, release, adsr, velocity, range, pitchenv, pitch-check, legato, velxfade, rr, gain, seed)`);
    const values: [string, InstValue][] = [];
    for (const p of ps) {
      try { values.push(...parseInstValue(p.key, p.value)); } catch (e) { throw new DiagError(line, p.t.col, `${id}: ${(e as Error).message}`); }
    }
    const words = values.map(([k, v]) => `${k}=${k === 'root' ? noteLabel(v as number) : k === 'range' ? (v ? `${noteLabel((v as [number, number])[0])}-${noteLabel((v as [number, number])[1])}` : 'none') : k === 'pitchenv' ? (v ? quote(formatEnv(v as Env)) : 'none') : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v)}`);
    return { op: 'inst-set', id, values, text: `instrument set ${id} ${words.join(' ')}` };
  }
  if (verb.v === 'layer' || verb.v === 'fx' || verb.v === 'env') {
    // the inner command is the sound command with the instrument's id in the sound's place
    const innerTokens: Token[] = [{ ...verb }, ...args];
    const inner = parseSub(innerTokens, line);
    const id = (inner as { id?: string }).id!;
    if (!INSTRUMENT_ID_RE.test(id)) throw new DiagError(line, args[0]?.col ?? verb.col, `'${id}' is not an instrument id`);
    return { op: 'inst-edit', id, inner, text: `instrument ${(inner as { text: string }).text}` };
  }
  if (verb.v === 'zone') return parseZone(verb, args, line);
  if (verb.v === 'zones') return parseZones(verb, args, line);
  if (verb.v === 'from-sample') {
    const id = checkIn(args[0], line, 'instrument from-sample', INSTRUMENT_ID_RE, 'instrument id');
    const sample = args[1];
    if (!sample || !SAMPLE_NAME_RE.test(sample.v)) throw new DiagError(line, (sample ?? verb).col, `instrument from-sample ${id}: give the sample to make it from`);
    let loop: 'find' | null = null;
    for (const p of pairs(args.slice(2), line, 'instrument from-sample')) {
      if (p.key !== 'loop' || p.value !== 'find') throw new DiagError(line, p.t.col, `instrument from-sample: unexpected '${p.t.v}' (loop=find)`);
      loop = 'find';
    }
    return { op: 'inst-from-sample', id, sample: sample.v, loop, text: `instrument from-sample ${id} ${sample.v}${loop ? ' loop=find' : ''}` };
  }
  if (verb.v === 'copy' || verb.v === 'rename') {
    const id = checkIn(args[0], line, `instrument ${verb.v}`, INSTRUMENT_ID_RE, 'instrument id');
    const to = checkIn(args[1], line, `instrument ${verb.v} ${id}`, INSTRUMENT_ID_RE, 'new instrument id');
    return { op: verb.v === 'copy' ? 'inst-copy' : 'inst-rename', id, to, text: `instrument ${verb.v} ${id} ${to}` };
  }
  if (verb.v === 'remove') {
    const id = checkIn(args[0], line, 'instrument remove', INSTRUMENT_ID_RE, 'instrument id');
    return { op: 'inst-remove', id, text: `instrument remove ${id}` };
  }
  throw new DiagError(line, verb.col, `unknown instrument command '${verb.v}' (new, from-sound, from-sample, set, layer, fx, env, zone, zones, copy, rename, remove)`);
}

const noteOrNumber = (s: string): number | null => parseNote(s) ?? (/^\d{1,3}$/.test(s) && Number(s) <= 127 ? Number(s) : null);
/** `C3-C6`, `0-127`, `0-D#3` (notes or MIDI numbers), or one note. */
const rangeOrNote = (s: string): [number, number] | null => {
  const m = /^(\d{1,3}|[A-G][#b]?-?\d)-(\d{1,3}|[A-G][#b]?-?\d)$/.exec(s);
  if (m) {
    const a = noteOrNumber(m[1]!), b = noteOrNumber(m[2]!);
    return a === null || b === null || a > b ? null : [a, b];
  }
  const one = noteOrNumber(s);
  return one !== null ? [one, one] : null;
};

/** Check the settings of a zone command on a scratch zone, so a bad one is reported at its place. */
function zoneValues(ps: { key: string; value: string; t: Token }[], line: number, scratch: Zone): [string, string][] {
  const out: [string, string][] = [];
  for (const p of ps) {
    try { setZoneValue(scratch, p.key, p.value, noteOrNumber, rangeOrNote); } catch (e) { throw new DiagError(line, p.t.col, (e as Error).message); }
    out.push([p.key, p.value]);
  }
  return out;
}

function parseZone(verb: Token, args: Token[], line: number): MusicCommand {
  const [sub, ...a] = args;
  if (!sub || !['add', 'set', 'remove', 'clear'].includes(sub.v)) throw new DiagError(line, (sub ?? verb).col, 'instrument zone: add, set, remove or clear');
  const id = checkIn(a[0], line, `instrument zone ${sub.v}`, INSTRUMENT_ID_RE, 'instrument id');
  if (sub.v === 'clear') {
    if (a.length > 1) throw new DiagError(line, a[1]!.col, 'instrument zone clear: nothing follows the instrument');
    return { op: 'inst-zone', id, verb: 'clear', n: 0, values: [], text: `instrument zone clear ${id}` };
  }
  let n = 0;
  let rest = a.slice(1);
  if (sub.v !== 'add') {
    const t = rest[0];
    n = t && /^\d+$/.test(t.v) ? Number(t.v) : 0;
    if (n < 1) throw new DiagError(line, (t ?? sub).col, `instrument zone ${sub.v} ${id}: give the zone's number (from 1; instrument zones shows them)`);
    rest = rest.slice(1);
  }
  if (sub.v === 'remove') {
    if (rest.length) throw new DiagError(line, rest[0]!.col, 'instrument zone remove: nothing follows the number');
    return { op: 'inst-zone', id, verb: 'remove', n, values: [], text: `instrument zone remove ${id} ${n}` };
  }
  const ps = pairs(rest, line, `instrument zone ${sub.v} ${id}`);
  if (!ps.length) throw new DiagError(line, sub.col, `instrument zone ${sub.v} ${id}: give ${sub.v === 'add' ? 'sample=<name> and root=<note>' : 'at least one <key>=<value>'} (${ZONE_KEYS.join(', ')})`);
  const values = zoneValues(ps, line, newZone('x', 60));
  if (sub.v === 'add' && !values.some(([k]) => k === 'sample')) throw new DiagError(line, sub.col, `instrument zone add ${id}: sample=<name> is needed`);
  const words = values.map(([k, v]) => `${k}=${/^[^\s"]+$/.test(v) ? v : quote(v)}`).join(' ');
  return { op: 'inst-zone', id, verb: sub.v as 'add' | 'set', n, values, text: `instrument zone ${sub.v} ${id}${sub.v === 'set' ? ' ' + n : ''} ${words}` };
}

function parseZones(verb: Token, args: Token[], line: number): MusicCommand {
  const id = checkIn(args[0], line, 'instrument zones', INSTRUMENT_ID_RE, 'instrument id');
  const how = args[1];
  if (!how || (how.v !== 'from-samples' && how.v !== 'from-slices')) throw new DiagError(line, (how ?? verb).col, `instrument zones ${id}: from-samples <name>… [root=detect] [vel=<lo>-<hi>], or from-slices <sample> [start=C1]`);
  const names: string[] = [];
  let root: 'detect' | null = null, vel: [number, number] | null = null, start: number | null = null;
  for (const t of args.slice(2)) {
    const m = /^([a-z]+)=(.*)$/.exec(t.v);
    if (!m) {
      if (!SAMPLE_NAME_RE.test(t.v)) throw new DiagError(line, t.col, `'${t.v}' is not a sample name`);
      names.push(t.v);
      continue;
    }
    if (m[1] === 'root' && how.v === 'from-samples') {
      if (m[2] !== 'detect') throw new DiagError(line, t.col, 'root=detect measures each sample\'s pitch (without it, the samples\' own roots are used)');
      root = 'detect';
    } else if (m[1] === 'vel' && how.v === 'from-samples') {
      const z = newZone('x', 60);
      try { setZoneValue(z, 'vel', m[2]!, noteOrNumber, rangeOrNote); } catch (e) { throw new DiagError(line, t.col, (e as Error).message); }
      vel = z.vel;
    } else if (m[1] === 'start' && how.v === 'from-slices') {
      const n = noteOrNumber(m[2]!);
      if (n === null) throw new DiagError(line, t.col, `start is a note like C1 (got '${m[2]}')`);
      start = n;
    } else throw new DiagError(line, t.col, `instrument zones ${how.v}: unexpected '${t.v}'${how.v === 'from-samples' ? ' (root=detect, vel=<lo>-<hi>)' : ' (start=<note>)'}`);
  }
  if (!names.length) throw new DiagError(line, how.col, `instrument zones ${id} ${how.v}: name ${how.v === 'from-samples' ? 'the samples' : 'the sample'}`);
  if (how.v === 'from-slices' && names.length !== 1) throw new DiagError(line, how.col, 'instrument zones from-slices: name one sample');
  if (names.length > 64) throw new DiagError(line, how.col, 'instrument zones: at most 64 samples at once');
  const text = `instrument zones ${id} ${how.v} ${names.join(' ')}${root ? ' root=detect' : ''}${vel ? ` vel=${vel[0]}-${vel[1]}` : ''}${start !== null ? ` start=${noteLabel(start)}` : ''}`;
  return { op: 'inst-zones', id, how: how.v, names, root, vel, start, text };
}

const PAT_REF = /^([A-Za-z][A-Za-z0-9_-]{0,47})\.([A-Za-z][A-Za-z0-9_-]{0,47})$/;

function patRef(t: Token | undefined, line: number, what: string): { song: string; name: string } {
  if (!t) throw new DiagError(line, 1, `${what}: give <song>.<pattern>`);
  const m = PAT_REF.exec(t.v);
  if (!m) throw new DiagError(line, t.col, `'${t.v}' is not <song>.<pattern> (like explore.verse1)`);
  return { song: m[1]!, name: m[2]! };
}

/** The marker the script reader puts in front of a pattern block's text: its lines are the script's own lines, so a problem is reported at its place in the script. */
export const BLOCK_MARK = '\u0001';

function parsePatternCmd(head: Token, rest: Token[], line: number): MusicCommand {
  const [verb, ...args] = rest;
  if (!verb) throw new DiagError(line, head.col, 'pattern: set, note, remove, copy or rename (or a block: pattern <song>.<name> steps=16 tpb=4, then indented rows)');
  if (verb.v === 'set') {
    const { song, name } = patRef(args[0], line, 'pattern set');
    const body = args[1];
    if (!body || args.length > 2) throw new DiagError(line, (body ?? verb).col, `pattern set ${song}.${name}: give the pattern text in quotes (steps=16 tpb=4, then one row per channel)`);
    const block = body.v.startsWith(BLOCK_MARK);
    const text = block ? body.v.slice(1) : body.v;
    const r = parsePattern(text, name);
    if (r.errors.length || !r.pattern) {
      const e = r.errors[0]!;
      if (block) throw new DiagError(line + e.line - 1, e.col, e.message);
      throw new DiagError(line, body.col, `pattern ${song}.${name}, line ${e.line} column ${e.col}: ${e.message}`);
    }
    const hm = /^\s*pattern\s+([A-Za-z0-9_.-]+)/.exec(text);
    const named = hm ? (hm[1]!.includes('.') ? hm[1]!.split('.') : [song, hm[1]!]) : [song, name];
    if (named[0] !== song || named[1] !== name) throw new DiagError(line, body.col, `the text is for ${named[0]}.${named[1]}, not ${song}.${name}`);
    const pattern = { ...r.pattern, name };
    return { op: 'pattern-set', song, name, pattern, text: `pattern set ${song}.${name} ${quote(formatPattern(pattern))}` };
  }
  if (verb.v === 'note') {
    const { song, name, edit } = parseNoteEdit(args, line, (t) => patRef(t, line, 'pattern note'));
    return { op: 'pattern-note', song, name, edit, text: noteEditText(song, name, edit) };
  }
  if (verb.v === 'remove') {
    const { song, name } = patRef(args[0], line, 'pattern remove');
    return { op: 'pattern-remove', song, name, text: `pattern remove ${song}.${name}` };
  }
  if (verb.v === 'copy' || verb.v === 'rename') {
    const { song, name } = patRef(args[0], line, `pattern ${verb.v}`);
    const to = checkIn(args[1], line, `pattern ${verb.v} ${song}.${name}`, PATTERN_NAME_RE, 'new pattern name');
    return { op: verb.v === 'copy' ? 'pattern-copy' : 'pattern-rename', song, name, to, text: `pattern ${verb.v} ${song}.${name} ${to}` };
  }
  throw new DiagError(line, verb.col, `unknown pattern command '${verb.v}' (set, note, remove, copy, rename)`);
}

const songValue = (key: string, v: string): [string, SongValue] => {
  switch (key) {
    case 'tempo': return [key, numIn(key, v, TEMPO.min, TEMPO.max, 'bpm')];
    case 'swing': return [key, numIn(key, v, SWING.min, SWING.max)];
    case 'gain': return [key, numIn(key, v, 0, 4)];
    case 'time': {
      const m = /^(\d{1,2})\/(2|4|8|16)$/.exec(v);
      if (!m || Number(m[1]) < 1) throw new Error(`time is like 4/4, 3/4 or 6/8 (got '${v}')`);
      return [key, v];
    }
    case 'key': {
      if (v === 'none') return [key, null];
      parseKey(v);
      return [key, v];
    }
    case 'class': {
      if (v === 'none') return [key, null];
      if (!CLASS_NAME_RE.test(v)) throw new Error(`class is a loudness class name (like music, stinger) or none (got '${v}')`);
      return [key, v];
    }
    case 'tags': {
      if (v === 'none') return [key, null];
      const xs = v.split(',');
      for (const x of xs) if (!TAG_RE.test(x)) throw new Error(`tags are words like town,night (a-z, 0-9, _ and -), or none (got '${x}')`);
      return [key, [...new Set(xs)].join(',')];
    }
    case 'kind': {
      if (!(SONG_KINDS as readonly string[]).includes(v)) throw new Error(`kind is ${SONG_KINDS.join(' or ')} (got '${v}')`);
      return [key, v];
    }
    case 'bible': {
      if (v === 'none') return [key, null];
      if (!SONG_ID_RE.test(v)) throw new Error(`bible names an entry of the music bible (got '${v}')`);
      return [key, v];
    }
    case 'loudness': {
      if (v === 'auto' || v === 'none') return [key, null];
      const m = /^(-?(?:\d+\.?\d*|\.\d+))(?:lufs)?$/i.exec(v);
      if (!m || Number(m[1]) < -60 || Number(m[1]) > 0) throw new Error(`loudness is LUFS from -60 to 0 (got '${v}'), or auto`);
      return [key, Number(m[1])];
    }
    default: throw new Error(`no song setting '${key}' (tempo, swing, time, key, gain, class, loudness, tags, kind, bible)`);
  }
};

const showSongValue = (k: string, v: SongValue): string => `${k}=${v === null ? (k === 'loudness' ? 'auto' : 'none') : v}`;

function parseSong(head: Token, rest: Token[], line: number, parseSub: ParseLine): MusicCommand {
  const [verb, ...args] = rest;
  if (!verb) throw new DiagError(line, head.col, 'song: new, set, channel, section, order, intro, ending, loop, fx, copy, rename, remove or mark');
  const sid = (what: string): string => checkIn(args[0], line, what, SONG_ID_RE, 'song id');
  if (verb.v === 'new' || verb.v === 'set') {
    const id = sid(`song ${verb.v}`);
    const values: [string, SongValue][] = [];
    let fromBible: string | null = null, template: string | null = null;
    for (const p of pairs(args.slice(1), line, `song ${verb.v} ${id}`)) {
      if (verb.v === 'new' && p.key === 'from-bible') {
        if (!SONG_ID_RE.test(p.value)) throw new DiagError(line, p.t.col, `from-bible names an entry of the music bible (got '${p.value}')`);
        fromBible = p.value;
        continue;
      }
      if (verb.v === 'new' && p.key === 'template') {
        if (!STINGER_TEMPLATES[p.value]) throw new DiagError(line, p.t.col, `no stinger template '${p.value}' (${Object.keys(STINGER_TEMPLATES).join(', ')})`);
        template = p.value;
        continue;
      }
      try { values.push(songValue(p.key, p.value)); } catch (e) { throw new DiagError(line, p.t.col, (e as Error).message); }
    }
    if (verb.v === 'set' && !values.length) throw new DiagError(line, verb.col, `song set ${id}: give at least one <key>=<value> (tempo, swing, time, key, gain, class, loudness, tags, kind, bible)`);
    if (template && values.some(([k, v]) => k === 'kind' && v !== 'stinger')) throw new DiagError(line, verb.col, 'template= makes a stinger (kind=stinger)');
    return { op: verb.v === 'new' ? 'song-new' : 'song-set', id, values, fromBible, template, text: `song ${verb.v} ${id}${values.map(([k, v]) => ' ' + showSongValue(k, v)).join('')}${fromBible ? ` from-bible=${fromBible}` : ''}${template ? ` template=${template}` : ''}` } as MusicCommand;
  }
  if (verb.v === 'channel') {
    const [sub, ...a] = args;
    if (!sub || !['add', 'set', 'remove'].includes(sub.v)) throw new DiagError(line, (sub ?? verb).col, 'song channel: add, set or remove');
    const id = checkIn(a[0], line, `song channel ${sub.v}`, SONG_ID_RE, 'song id');
    const name = a[1];
    if (!name || !/^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(name.v)) throw new DiagError(line, (name ?? sub).col, `song channel ${sub.v} ${id}: give the channel's name (letters, digits and _, like lead or bass)`);
    if (sub.v === 'remove') return { op: 'song-channel-remove', id, name: name.v, text: `song channel remove ${id} ${name.v}` };
    let inst: string | null = null, kit: Record<string, string> | null = null, gain: number | null = null, pan: number | null = null, layer: string | null = null, harmony: boolean | null = null, reverb: number | null = null, delay: number | null = null, convolve: number | null = null;
    const audio = a.slice(2).some((t) => t.v === 'audio' || t.v === 'audio=yes');
    for (const p of pairs(a.slice(2).filter((t) => t.v !== 'audio' && t.v !== 'audio=yes'), line, `song channel ${sub.v} ${id} ${name.v}`)) {
      try {
        if (p.key === 'inst') { if (!INSTRUMENT_ID_RE.test(p.value)) throw new Error(`'${p.value}' is not an instrument id`); inst = p.value; }
        else if (p.key === 'kit') {
          kit = {};
          if (p.value !== 'default' && !p.value.includes(':') && !p.value.includes(',')) {
            // one instrument for every hit: its zones are keyed by hit name
            if (!INSTRUMENT_ID_RE.test(p.value)) throw new Error(`kit is default, one instrument, or <hit>:<instrument> pairs like k:kick,s:snare (got '${p.value}')`);
            kit[KIT_ALL] = p.value;
          } else if (p.value !== 'default') for (const w of p.value.split(',')) {
            const m = /^([a-z][a-z0-9_]{0,11}):([A-Za-z][A-Za-z0-9_-]{0,47})$/.exec(w);
            if (!m) throw new Error(`kit is default or <hit>:<instrument> pairs like k:kick,s:snare (got '${w}')`);
            kit[m[1]!] = m[2]!;
          }
        } else if (p.key === 'gain') gain = numIn('gain', p.value, 0, 4);
        else if (p.key === 'pan') pan = numIn('pan', p.value, -1, 1);
        else if (p.key === 'layer') { if (!LAYER_NAME_RE.test(p.value)) throw new Error(`layer is a name like base, tension or combat (a-z, 0-9, _ and -), got '${p.value}'`); layer = p.value; }
        else if (p.key === 'harmony') { harmony = yesNo(p.value); if (harmony === null) throw new Error(`harmony is yes or no (a harmony part is what the voice-leading check reads), got '${p.value}'`); }
        else if (p.key === 'reverb') reverb = numIn('reverb', p.value, 0, 1);
        else if (p.key === 'delay') delay = numIn('delay', p.value, 0, 1);
        else if (p.key === 'convolve') convolve = numIn('convolve', p.value, 0, 1);
        else throw new Error(`song channel: unexpected '${p.key}' (inst=<instrument> or kit=<…>, gain=, pan=, layer=, harmony=, reverb=, delay=, convolve=)`);
      } catch (e) { throw new DiagError(line, p.t.col, (e as Error).message); }
    }
    if (inst && kit) throw new DiagError(line, name.col, 'song channel: give inst= (a pitched channel) or kit= (a drum channel), not both');
    if (audio && (inst || kit)) throw new DiagError(line, name.col, 'song channel: an audio channel plays clips; give audio, or inst= or kit=, not both');
    if (audio && sub.v === 'set') throw new DiagError(line, name.col, `song channel set ${id} ${name.v}: audio is for song channel add (a channel is one kind for good: add a new one)`);
    if (sub.v === 'add' && !inst && !kit && !audio) throw new DiagError(line, name.col, `song channel add ${id} ${name.v}: give inst=<instrument> (or kit=default for drums, or audio for clips)`);
    const words = [audio ? 'audio' : inst ? `inst=${inst}` : kit ? `kit=${kitText(kit)}` : '', gain !== null ? `gain=${gain}` : '', pan !== null ? `pan=${pan}` : '', layer ? `layer=${layer}` : '', harmony !== null ? `harmony=${harmony ? 'yes' : 'no'}` : '', reverb !== null ? `reverb=${reverb}` : '', delay !== null ? `delay=${delay}` : '', convolve !== null ? `convolve=${convolve}` : ''].filter(Boolean);
    if (sub.v === 'set' && !words.length) throw new DiagError(line, name.col, `song channel set ${id} ${name.v}: give what changes (inst=, kit=, gain=, pan=, layer=, harmony=, reverb=, delay=, convolve=)`);
    return { op: 'song-channel', verb: sub.v as 'add' | 'set', id, name: name.v, audio, inst, kit, gain, pan, layer, harmony, reverb, delay, convolve, text: `song channel ${sub.v} ${id} ${name.v} ${words.join(' ')}`.trim() };
  }
  if (verb.v === 'clip') {
    const [sub, ...a] = args;
    if (!sub || !['add', 'set', 'remove'].includes(sub.v)) throw new DiagError(line, (sub ?? verb).col, 'song clip: add, set or remove');
    const id = checkIn(a[0], line, `song clip ${sub.v}`, SONG_ID_RE, 'song id');
    const ch = a[1];
    if (!ch || !/^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(ch.v)) throw new DiagError(line, (ch ?? sub).col, `song clip ${sub.v} ${id}: give the audio channel's name`);
    const fields: ClipFields = {};
    let clip: number | null = null;
    let rest = a.slice(2);
    if (sub.v === 'add') {
      const smp = rest[0];
      if (!smp || !SAMPLE_NAME_RE.test(smp.v)) throw new DiagError(line, (smp ?? ch).col, `song clip add ${id} ${ch.v}: give the sample to place (song clip add ${id} ${ch.v} <sample> at=<bar>[.<beat>])`);
      fields.sample = smp.v;
      rest = rest.slice(1);
    } else {
      const n = rest[0];
      if (!n || !CLIP_ID_RE.test(n.v)) throw new DiagError(line, (n ?? ch).col, `song clip ${sub.v} ${id} ${ch.v}: give the clip's number (song show lists them)`);
      clip = Number(n.v);
      rest = rest.slice(1);
    }
    if (sub.v === 'remove') {
      if (rest.length) throw new DiagError(line, rest[0]!.col, 'song clip remove takes no settings');
      return { op: 'song-clip', verb: 'remove', id, channel: ch.v, clip, fields, text: `song clip remove ${id} ${ch.v} ${clip}` };
    }
    for (const p of pairs(rest, line, `song clip ${sub.v} ${id} ${ch.v}`)) {
      try { Object.assign(fields, clipField(p.key, p.value)); } catch (e) { throw new DiagError(line, p.t.col, (e as Error).message); }
    }
    if (sub.v === 'add' && fields.at === undefined) throw new DiagError(line, ch.col, `song clip add ${id} ${ch.v} ${fields.sample}: give at=<bar>[.<beat>] (bars and beats count from 1)`);
    if (sub.v === 'set' && !Object.keys(fields).length) throw new DiagError(line, sub.col, `song clip set ${id} ${ch.v} ${clip}: give at least one of ${CLIP_KEYS.join(', ')}`);
    const words = clipFieldWords(fields).filter((x) => !(sub.v === 'add' && x.startsWith('sample=')));
    return { op: 'song-clip', verb: sub.v as 'add' | 'set', id, channel: ch.v, clip, fields, text: `song clip ${sub.v} ${id} ${ch.v} ${sub.v === 'add' ? fields.sample : clip} ${words.join(' ')}`.trim() };
  }
  if (verb.v === 'section') {
    const [sub, ...a] = args;
    if (!sub || !['add', 'set', 'remove'].includes(sub.v)) throw new DiagError(line, (sub ?? verb).col, 'song section: add, set or remove');
    const id = checkIn(a[0], line, `song section ${sub.v}`, SONG_ID_RE, 'song id');
    const name = checkIn(a[1], line, `song section ${sub.v} ${id}`, SECTION_RE, 'section name');
    if (sub.v === 'remove') return { op: 'song-section-remove', id, name, text: `song section remove ${id} ${name}` };
    let repeat = 1;
    const patterns: string[] = [];
    for (const t of a.slice(2)) {
      const m = /^x(\d+)$/.exec(t.v);
      if (m) { repeat = Number(m[1]); if (repeat < 1 || repeat > 64) throw new DiagError(line, t.col, 'x<n> repeats the section 1 to 64 times'); continue; }
      if (!PATTERN_NAME_RE.test(t.v)) throw new DiagError(line, t.col, `'${t.v}' is not a pattern name`);
      patterns.push(t.v);
    }
    if (!patterns.length) throw new DiagError(line, a[1]!.col, `song section ${sub.v} ${id} ${name}: name the patterns it plays, in order (and x<n> to repeat)`);
    return { op: 'song-section', verb: sub.v as 'add' | 'set', id, name, patterns, repeat, text: `song section ${sub.v} ${id} ${name} ${patterns.join(' ')}${repeat > 1 ? ` x${repeat}` : ''}` };
  }
  if (verb.v === 'order') {
    const id = sid('song order');
    const names = args.slice(1).map((t) => checkIn(t, line, 'song order', SECTION_RE, 'section name'));
    if (!names.length) throw new DiagError(line, verb.col, `song order ${id}: name the sections in the order they play`);
    return { op: 'song-order', id, names, text: `song order ${id} ${names.join(' ')}` };
  }
  if (verb.v === 'intro' || verb.v === 'ending') {
    const id = sid(`song ${verb.v}`);
    const t = args[1];
    if (!t || args.length > 2) throw new DiagError(line, (t ?? verb).col, `song ${verb.v} ${id}: give a section name, or none`);
    if (t.v !== 'none') checkIn(t, line, `song ${verb.v}`, SECTION_RE, 'section name');
    return { op: 'song-role', id, role: verb.v, section: t.v === 'none' ? null : t.v, text: `song ${verb.v} ${id} ${t.v}` };
  }
  if (verb.v === 'loop') {
    const id = sid('song loop');
    const t = args[1];
    if (!t || args.length > 2) throw new DiagError(line, (t ?? verb).col, `song loop ${id}: give <from>..<to> (sections), a single section, auto or off`);
    if (t.v === 'off') return { op: 'song-loop', id, loop: false, text: `song loop ${id} off` };
    if (t.v === 'auto') return { op: 'song-loop', id, loop: null, text: `song loop ${id} auto` };
    const m = /^([A-Za-z][A-Za-z0-9_-]*?)(?:\.\.([A-Za-z][A-Za-z0-9_-]*))?$/.exec(t.v);
    if (!m) throw new DiagError(line, t.col, `'${t.v}' is not <from>..<to>, a section name, auto or off`);
    return { op: 'song-loop', id, loop: { from: m[1]!, to: m[2] ?? m[1]! }, text: `song loop ${id} ${m[1]}..${m[2] ?? m[1]}` };
  }
  if (verb.v === 'send') {
    const id = checkIn(args[0], line, 'song send', SONG_ID_RE, 'song id');
    const kind = args[1]?.v as SendKind | undefined;
    if (!kind || !(SEND_KINDS as readonly string[]).includes(kind)) throw new DiagError(line, (args[1] ?? args[0] ?? verb).col, `song send ${id}: the bus is ${SEND_KINDS.join(' or ')} (song send ${id} reverb size=0.6 damp=0.5; song send ${id} reverb off)`);
    if (args[2]?.v === 'off' && args.length === 3) return { op: 'song-send', id, kind, off: true, values: [], text: `song send ${id} ${kind} off` };
    const specs = FX_SPECS[kind];
    const values: [string, number | string][] = [];
    for (const p of pairs(args.slice(2), line, `song send ${id} ${kind}`)) {
      try {
        const sp = specs.find((x) => x.name === p.key);
        if (p.key === 'mix') throw new Error('a send bus returns only the effect (its mix is always 1); a channel\'s reverb=, delay= or convolve= says how much of it goes in');
        if (!sp) throw new Error(`the ${kind} bus has ${specs.filter((x) => x.name !== 'mix').map((x) => x.name).join(', ')} (got '${p.key}')`);
        values.push([p.key, sp.text ? (parseValue(sp, p.value, `song send ${id} ${kind}`) as string) : numIn(p.key, p.value, sp.min, sp.max, sp.unit)]);
      } catch (e) { throw new DiagError(line, p.t.col, (e as Error).message); }
    }
    return { op: 'song-send', id, kind, off: false, values, text: `song send ${id} ${kind}${values.map(([k, v]) => ` ${k}=${v}`).join('')}` };
  }
  if (verb.v === 'fx') {
    // song fx add <song> <kind> …  is  fx add <song> <kind> … on the master chain
    const id = checkIn(args[1], line, 'song fx', SONG_ID_RE, 'song id');
    const inner = parseSub([{ ...args[0]!, v: 'fx', col: verb.col }, args[0]!, ...args.slice(1)], line);
    void id;
    return { op: 'song-fx', id: (inner as { id: string }).id, inner, text: `song ${(inner as { text: string }).text}` };
  }
  if (verb.v === 'copy' || verb.v === 'rename') {
    const id = sid(`song ${verb.v}`);
    const to = checkIn(args[1], line, `song ${verb.v} ${id}`, SONG_ID_RE, 'new song id');
    return { op: verb.v === 'copy' ? 'song-copy' : 'song-rename', id, to, text: `song ${verb.v} ${id} ${to}` };
  }
  if (verb.v === 'remove') {
    const id = sid('song remove');
    return { op: 'song-remove', id, text: `song remove ${id}` };
  }
  if (verb.v === 'mark') {
    const id = sid('song mark');
    const st = args[1];
    if (!st || !['approved', 'rejected', 'draft'].includes(st.v)) throw new DiagError(line, (st ?? verb).col, 'song mark: the mark is approved, rejected or draft');
    return { op: 'song-mark', id, status: st.v as 'approved' | 'rejected' | 'draft', text: `song mark ${id} ${st.v}` };
  }
  throw new DiagError(line, verb.col, `unknown song command '${verb.v}' (new, set, channel, section, order, intro, ending, loop, fx, copy, rename, remove, mark)`);
}

// ---- applying -----------------------------------------------------------------------------------------------------

/** Instruments the project has, then the built-in ones. */
export function lookupInstrument(lib: Library, id: string): Instrument | undefined {
  return lib.instruments.get(id) ?? builtinInstruments()[id];
}

function freeInstrument(lib: Library, id: string): void {
  const clash = idClash(lib.instruments.keys(), id);
  if (clash) throw new Error(`instrument '${id}' exists already${clash !== id ? ` as '${clash}' (ids are unique ignoring case)` : ''}`);
}

function freeSong(lib: Library, id: string): void {
  const clash = idClash(lib.songs.keys(), id);
  if (clash) throw new Error(`song '${id}' exists already${clash !== id ? ` as '${clash}' (ids are unique ignoring case)` : ''}`);
}

function inst(lib: Library, id: string): Instrument {
  const i = lib.instruments.get(id);
  if (!i) throw new Error(`no instrument '${id}' in the project${builtinInstruments()[id] ? ` (it is a built-in: instrument new ${id}_2 from=${id} makes one you can change)` : ''}${lib.instruments.size ? ` (instruments: ${[...lib.instruments.keys()].join(', ')})` : ''}`);
  return cloneInstrument(i);
}

function songOf(lib: Library, id: string): SongDoc {
  const s = lib.songs.get(id);
  if (!s) throw new Error(`no song '${id}'${lib.songs.size ? ` (songs: ${[...lib.songs.keys()].join(', ')})` : ': make one with `song new <id>`'}`);
  return cloneSong(s);
}

function usedBy(lib: Library, instId: string): string[] {
  const out: string[] = [];
  for (const s of lib.songs.values()) for (const c of s.channels) if (c.inst === instId || (c.kit && Object.values(c.kit).includes(instId))) out.push(`${s.id}/${c.name}`);
  return out;
}

/** The root note to give an instrument made from a sound. */
function rootFromSound(lib: Library, name: string): number | null {
  const s = lib.get(name);
  return s && s.voice === 'layered' ? guessRoot(s) : null;
}

const zoneWordsOf = (z: Zone): string => zoneWords(z, noteLabel).join(' ');

/** A placeholder sample layer (a sample instrument made before zones existed, with no sample named) goes when the first zone arrives. */
function dropPlaceholder(i: Instrument): void {
  if (i.zones?.length === 1 && i.voice.layers.length === 1 && i.voice.layers[0]!.kind === 'sample' && !i.voice.layers[0]!.p.sample) i.voice.layers = [];
}

function applyZone(lib: Library, c: Extract<MusicCommand, { op: 'inst-zone' }>): string | undefined {
  const i = inst(lib, c.id);
  const zones = (i.zones ??= []).map(cloneZone);
  i.zones = zones;
  const entryRoot = (sample: string): { root: number; tune: number } | null => {
    const e = lib.samples.get(sample);
    return e?.root !== undefined ? { root: e.root, tune: -(e.tune ?? 0) } : null;
  };
  let normal: string | undefined;
  if (c.verb === 'clear') zones.length = 0;
  else if (c.verb === 'remove') {
    if (c.n > zones.length) throw new Error(`instrument ${c.id} has ${zones.length} zone${zones.length === 1 ? '' : 's'}, no zone ${c.n}`);
    zones.splice(c.n - 1, 1);
  } else if (c.verb === 'set') {
    const z = zones[c.n - 1];
    if (!z) throw new Error(`instrument ${c.id} has ${zones.length} zone${zones.length === 1 ? '' : 's'}, no zone ${c.n}`);
    for (const [k, v] of c.values) setZoneValue(z, k, v, noteOrNumber, rangeOrNote);
    checkZone(z, c.id);
  } else {
    if (zones.length >= MAX_ZONES) throw new Error(`an instrument has at most ${MAX_ZONES} zones`);
    const sample = c.values.find(([k]) => k === 'sample')![1];
    const have = c.values.some(([k]) => k === 'root');
    const fromEntry = entryRoot(sample);
    if (!have && !fromEntry) throw new Error(`instrument zone add ${c.id}: root=<note> is needed (sample ${sample} has no root note of its own)`);
    const z = newZone(sample, fromEntry?.root ?? 60);
    if (!have && fromEntry) z.tune = fromEntry.tune;
    for (const [k, v] of c.values) setZoneValue(z, k, v, noteOrNumber, rangeOrNote);
    checkZone(z, c.id);
    zones.push(z);
    normal = `instrument zone add ${c.id} ${zoneWordsOf(z)}`;
  }
  i.zones = zones;
  dropPlaceholder(i);
  lib.instruments.set(c.id, i);
  return normal;
}

function checkZone(z: Zone, id: string): void {
  if (z.keys[0] > z.keys[1]) throw new Error(`instrument ${id}: keys ${noteLabel(z.keys[0])}-${noteLabel(z.keys[1])} run backwards (low note first)`);
  if (z.rr && z.rr[0] > z.rr[1]) throw new Error(`instrument ${id}: rr=${z.rr[0]}/${z.rr[1]}: the take is past the number of takes`);
  if (z.end > 0 && z.end <= z.start) throw new Error(`instrument ${id}: end (${z.end} s) must be after start (${z.start} s)`);
  if (z.trigger === 'release' && z.loopmode === 'continuous') throw new Error(`instrument ${id}: a release zone does not loop on (loopmode=none, sustain or oneshot)`);
}

export function applyMusic(lib: Library, c: MusicCommand): string | undefined {
  switch (c.op) {
    case 'inst-new': {
      freeInstrument(lib, c.id);
      if (c.from) {
        const src = lookupInstrument(lib, c.from);
        if (!src) throw new Error(`no instrument or built-in '${c.from}' to start from (built-ins: ${Object.keys(builtinInstruments()).join(', ')})`);
        const copy = fromBuiltin(c.from, c.id) ?? cloneInstrument(src);
        copy.id = c.id;
        copy.voice.id = c.id;
        delete copy.builtin;
        lib.instruments.set(c.id, copy);
      } else if (c.kind === null) {
        // an instrument of samples: no synth layer, zones come with `instrument zone add`
        const i = newInstrument(c.id, c.seed);
        i.voice.layers = [];
        i.voice.nextSalt = 1;
        i.zones = [];
        i.pitched = true;
        i.attack = 0.002;
        i.decay = 0;
        i.sustain = 1;
        i.release = 0.15;
        lib.instruments.set(c.id, i);
      } else {
        const i = newInstrument(c.id, c.seed);
        i.voice.layers = [newLayer(c.kind!, 1)];
        if (c.kind === 'classic') { i.voice.layers[0]!.p.freq = 0.3; }
        lib.instruments.set(c.id, i);
      }
      return undefined;
    }
    case 'inst-from-sound': {
      freeInstrument(lib, c.id);
      const s = lib.get(c.sound);
      if (!s) throw new Error(`no sound '${c.sound}' to make the instrument from`);
      let voice: LayeredSound;
      if (s.voice === 'layered') voice = s;
      else if (s.voice === 'classic') {
        voice = newLayeredSound(c.sound, 1);
        const l = newLayer('classic', 1);
        for (const [k, v] of Object.entries(s.patch)) l.p[k] = v as number;
        voice.layers = [l];
        voice.nextSalt = 2;
      } else throw new Error(`${c.sound} is a tone: make the instrument from a classic or layered sound`);
      const root = c.root ?? rootFromSound(lib, c.sound) ?? 69;
      lib.instruments.set(c.id, instrumentFromSound(c.id, voice, root));
      return `instrument from-sound ${c.id} ${c.sound} root=${noteLabel(root)}`;
    }
    case 'inst-set': {
      const i = inst(lib, c.id);
      for (const [k, v] of c.values) {
        if (k === 'root') i.root = v as number;
        else if (k === 'pitched') i.pitched = v as boolean;
        else if (k === 'attack' || k === 'decay' || k === 'sustain' || k === 'release' || k === 'velocity') i[k] = v as number;
        else if (k === 'gain') i.voice.gain = v as number;
        else if (k === 'seed') i.voice.seed = v as number;
        else if (k === 'range') i.range = v as [number, number] | null;
        else if (k === 'pitchenv') i.pitchEnv = v as Env | null;
        else if (k === 'legato') { if (v) i.legato = true; else delete i.legato; }
        else if (k === 'velxfade') { if (v) i.velxfade = v as number; else delete i.velxfade; }
        else if (k === 'rr') { if (v === 'hash') i.rr = 'hash'; else delete i.rr; }
        else if (k === 'pitch-check') { if (v === 'full') delete i.pitchCheck; else i.pitchCheck = v as PitchCheck; }
      }
      lib.instruments.set(c.id, i);
      return undefined;
    }
    case 'inst-zone': return applyZone(lib, c);
    case 'inst-zones':
    case 'inst-from-sample':
      throw new Error(`${c.text.split(' ').slice(0, 3).join(' ')} is worked out when it runs (the writer puts the zones it found on the tape as instrument zone add); it cannot be applied on its own`);
    case 'inst-edit': {
      const i = inst(lib, c.id);
      const scratch = new Map<string, LayeredSound>([[c.id, i.voice]]);
      applyLayerCommand(scratch as unknown as Map<string, never>, c.inner);
      i.voice = scratch.get(c.id)!;
      lib.instruments.set(c.id, i);
      return undefined;
    }
    case 'inst-copy': {
      const i = inst(lib, c.id);
      freeInstrument(lib, c.to);
      i.id = c.to;
      i.voice.id = c.to;
      lib.instruments.set(c.to, i);
      return undefined;
    }
    case 'inst-rename': {
      const i = inst(lib, c.id);
      if (c.to !== c.id) {
        const clash = idClash(lib.instruments.keys(), c.to);
        if (clash && clash !== c.id) throw new Error(`instrument '${c.to}' exists already as '${clash}'`);
      }
      i.id = c.to;
      i.voice.id = c.to;
      lib.instruments.delete(c.id);
      lib.instruments.set(c.to, i);
      for (const [k, s] of lib.songs) {
        if (!s.channels.some((ch) => ch.inst === c.id || (ch.kit && Object.values(ch.kit).includes(c.id)))) continue;
        const n = cloneSong(s);
        for (const ch of n.channels) {
          if (ch.inst === c.id) ch.inst = c.to;
          if (ch.kit) for (const key of Object.keys(ch.kit)) if (ch.kit[key] === c.id) ch.kit[key] = c.to;
        }
        lib.songs.set(k, n);
      }
      return undefined;
    }
    case 'inst-remove': {
      inst(lib, c.id);
      const used = usedBy(lib, c.id);
      if (used.length) throw new Error(`instrument ${c.id} is played by ${used.join(', ')}: point those channels at another instrument first (song channel set <song> <channel> inst=<instrument>)`);
      lib.instruments.delete(c.id);
      return undefined;
    }
    case 'pattern-set': {
      const s = songOf(lib, c.song);
      if (!s.patterns.has(c.name) && s.patterns.size >= 64) throw new Error(`a song has at most 64 patterns`);
      s.patterns.set(c.name, c.pattern);
      lib.songs.set(c.song, s);
      return undefined;
    }
    case 'pattern-note': {
      const s = songOf(lib, c.song);
      const p = s.patterns.get(c.name);
      if (!p) throw new Error(`song ${c.song} has no pattern '${c.name}' (patterns: ${[...s.patterns.keys()].join(', ') || 'none'})`);
      s.patterns.set(c.name, applyNoteEdit(p, c.edit, s));
      lib.songs.set(c.song, s);
      return undefined;
    }
    case 'pattern-remove': {
      const s = songOf(lib, c.song);
      if (!s.patterns.has(c.name)) throw new Error(`song ${c.song} has no pattern '${c.name}' (patterns: ${[...s.patterns.keys()].join(', ') || 'none'})`);
      const using = s.sections.filter((x) => x.patterns.includes(c.name)).map((x) => x.name);
      if (using.length) throw new Error(`pattern ${c.name} is played by section ${using.join(', ')}: change the section first (song section set …)`);
      s.patterns.delete(c.name);
      lib.songs.set(c.song, s);
      return undefined;
    }
    case 'pattern-copy':
    case 'pattern-rename': {
      const s = songOf(lib, c.song);
      const p = s.patterns.get(c.name);
      if (!p) throw new Error(`song ${c.song} has no pattern '${c.name}'`);
      if (s.patterns.has(c.to) && c.to !== c.name) throw new Error(`song ${c.song} has a pattern '${c.to}' already`);
      s.patterns.set(c.to, { ...p, name: c.to });
      if (c.op === 'pattern-rename') {
        if (c.to !== c.name) s.patterns.delete(c.name);
        for (const x of s.sections) x.patterns = x.patterns.map((n) => (n === c.name ? c.to : n));
      }
      lib.songs.set(c.song, s);
      return undefined;
    }
    case 'song-new': {
      freeSong(lib, c.id);
      if (c.fromBible || c.template) {
        // written out as the plain commands it stands for, so the tape never needs the bible again
        const lines = songNewLines(lib, c);
        for (const l of lines) {
          const p = parse(l);
          if (p.errors.length) throw new Error(`${l.slice(0, 80)}: ${p.errors[0]!.message}`);
          for (const x of p.commands) applyCommand(lib, x);
        }
        return lines.join('\n');
      }
      const s = newSong(c.id);
      applySongValues(s, c.values);
      lib.songs.set(c.id, s);
      return undefined;
    }
    case 'song-set': {
      const s = songOf(lib, c.id);
      applySongValues(s, c.values);
      lib.songs.set(c.id, s);
      return undefined;
    }
    case 'song-channel': {
      const s = songOf(lib, c.id);
      const at = s.channels.findIndex((x) => x.name === c.name);
      if (c.verb === 'add') {
        if (at >= 0) throw new Error(`song ${c.id} has a channel ${c.name} already (song channel set changes it)`);
        if (s.channels.length >= MAX_CHANNELS) throw new Error(`a song has at most ${MAX_CHANNELS} channels`);
        const ch: Channel = { name: c.name, inst: c.inst, kit: c.kit, gain: c.gain ?? 1, pan: c.pan ?? 0, layer: c.layer ?? DEFAULT_LAYER };
        if (c.audio) ch.clips = [];
        if (c.harmony) ch.harmony = true;
        if (c.reverb) ch.reverb = c.reverb;
        if (c.delay) ch.delay = c.delay;
        if (c.convolve) ch.convolve = c.convolve;
        s.channels.push(ch);
      } else {
        if (at < 0) throw new Error(`song ${c.id} has no channel ${c.name} (channels: ${s.channels.map((x) => x.name).join(', ') || 'none'})`);
        const ch = { ...s.channels[at]! };
        if (ch.clips && (c.inst || c.kit)) throw new Error(`channel ${c.name} of ${c.id} is an audio channel: it plays clips, not an instrument (song channel add makes a channel of the other kind)`);
        if (c.inst) { ch.inst = c.inst; ch.kit = null; }
        if (c.kit) { ch.kit = c.kit; ch.inst = null; }
        if (c.gain !== null) ch.gain = c.gain;
        if (c.pan !== null) ch.pan = c.pan;
        if (c.layer) ch.layer = c.layer;
        if (c.harmony === true) ch.harmony = true;
        else if (c.harmony === false) delete ch.harmony;
        if (c.reverb !== null) { if (c.reverb) ch.reverb = c.reverb; else delete ch.reverb; }
        if (c.delay !== null) { if (c.delay) ch.delay = c.delay; else delete ch.delay; }
        if (c.convolve !== null) { if (c.convolve) ch.convolve = c.convolve; else delete ch.convolve; }
        s.channels[at] = ch;
      }
      lib.songs.set(c.id, s);
      return undefined;
    }
    case 'song-clip': {
      const s = songOf(lib, c.id);
      const ci = s.channels.findIndex((x) => x.name === c.channel);
      if (ci < 0) throw new Error(`song ${c.id} has no channel ${c.channel} (channels: ${s.channels.map((x) => x.name).join(', ') || 'none'})`);
      const ch = { ...s.channels[ci]! };
      if (!ch.clips) throw new Error(`channel ${c.channel} of ${c.id} plays an instrument, and clips go in an audio channel (song channel add ${c.id} <name> audio)`);
      const clips = ch.clips.map((k) => ({ ...k }));
      if (c.verb === 'add') {
        if (s.channels.reduce((n, x) => n + (x.clips?.length ?? 0), 0) >= MAX_CLIPS) throw new Error(`a song has at most ${MAX_CLIPS} clips`);
        if (c.fields.at === undefined) throw new Error(`song clip add ${c.id} ${c.channel}: give at=<bar>[.<beat>] (bars and beats count from 1)`);
        const k = newClip(nextClipId(s), c.fields.sample!);
        applyClipFields(k, c.fields, s.time);
        clips.push(k);
      } else {
        const at = clips.findIndex((k) => k.id === c.clip);
        if (at < 0) throw new Error(`channel ${c.channel} of ${c.id} has no clip ${c.clip} (clips: ${clips.map((k) => k.id).join(', ') || 'none'})`);
        if (c.verb === 'remove') clips.splice(at, 1);
        else applyClipFields(clips[at]!, c.fields, s.time);
      }
      ch.clips = clips;
      s.channels[ci] = ch;
      lib.songs.set(c.id, s);
      return undefined;
    }
    case 'song-channel-remove': {
      const s = songOf(lib, c.id);
      if (!s.channels.some((x) => x.name === c.name)) throw new Error(`song ${c.id} has no channel ${c.name}`);
      s.channels = s.channels.filter((x) => x.name !== c.name);
      lib.songs.set(c.id, s);
      return undefined;
    }
    case 'song-section': {
      const s = songOf(lib, c.id);
      const at = s.sections.findIndex((x) => x.name === c.name);
      if (c.verb === 'add' && at >= 0) throw new Error(`song ${c.id} has a section ${c.name} already (song section set replaces it)`);
      if (c.verb === 'set' && at < 0) throw new Error(`song ${c.id} has no section ${c.name} (song section add makes one)`);
      for (const p of c.patterns) if (!s.patterns.has(p)) throw new Error(`song ${c.id} has no pattern '${p}' (patterns: ${[...s.patterns.keys()].join(', ') || 'none; pattern set ' + c.id + '.' + p + ' "…"'})`);
      const sec = { name: c.name, patterns: c.patterns, repeat: c.repeat };
      if (at >= 0) s.sections[at] = sec;
      else {
        if (s.sections.length >= 64) throw new Error('a song has at most 64 sections');
        // a new body section goes before the ending, if there is one
        const e = s.ending ? s.sections.findIndex((x) => x.name === s.ending) : -1;
        if (e >= 0) s.sections.splice(e, 0, sec);
        else s.sections.push(sec);
      }
      lib.songs.set(c.id, s);
      return undefined;
    }
    case 'song-section-remove': {
      const s = songOf(lib, c.id);
      if (!s.sections.some((x) => x.name === c.name)) throw new Error(`song ${c.id} has no section ${c.name}`);
      s.sections = s.sections.filter((x) => x.name !== c.name);
      if (s.intro === c.name) s.intro = null;
      if (s.ending === c.name) s.ending = null;
      if (s.loop && typeof s.loop === 'object' && (s.loop.from === c.name || s.loop.to === c.name)) s.loop = null;
      lib.songs.set(c.id, s);
      return undefined;
    }
    case 'song-order': {
      const s = songOf(lib, c.id);
      const have = s.sections.map((x) => x.name).sort().join(',');
      if ([...c.names].sort().join(',') !== have || new Set(c.names).size !== c.names.length) throw new Error(`song order must name every section once (sections: ${s.sections.map((x) => x.name).join(', ')})`);
      s.sections = c.names.map((n) => s.sections.find((x) => x.name === n)!);
      lib.songs.set(c.id, s);
      return undefined;
    }
    case 'song-role': {
      const s = songOf(lib, c.id);
      if (c.section !== null) {
        if (!s.sections.some((x) => x.name === c.section)) throw new Error(`song ${c.id} has no section ${c.section} (sections: ${s.sections.map((x) => x.name).join(', ') || 'none'})`);
        if ((c.role === 'intro' ? s.ending : s.intro) === c.section) throw new Error(`section ${c.section} cannot be both intro and ending`);
        // intro first, ending last
        const sec = s.sections.find((x) => x.name === c.section)!;
        s.sections = s.sections.filter((x) => x !== sec);
        if (c.role === 'intro') s.sections.unshift(sec);
        else s.sections.push(sec);
      }
      if (c.role === 'intro') s.intro = c.section;
      else s.ending = c.section;
      lib.songs.set(c.id, s);
      return undefined;
    }
    case 'song-loop': {
      const s = songOf(lib, c.id);
      if (s.kind === 'stinger' && c.loop !== false) throw new Error(`${c.id} is a stinger: it ends on its ending and does not loop (song set ${c.id} kind=song to make it a song)`);
      if (c.loop && typeof c.loop === 'object') {
        const body = s.sections.filter((x) => x.name !== s.intro && x.name !== s.ending).map((x) => x.name);
        const a = body.indexOf(c.loop.from), b = body.indexOf(c.loop.to);
        if (a < 0 || b < 0) throw new Error(`the loop sections must be body sections of ${c.id} (body: ${body.join(', ') || 'none'}; the intro and the ending are not looped)`);
        if (b < a) throw new Error(`the loop ${c.loop.from}..${c.loop.to} runs backwards (the body order is ${body.join(', ')})`);
      }
      s.loop = c.loop;
      lib.songs.set(c.id, s);
      return undefined;
    }
    case 'song-send': {
      const s = songOf(lib, c.id);
      if (c.off) {
        s[c.kind] = null;
        for (const ch of s.channels) delete ch[c.kind];
      } else {
        const fx: Fx = s[c.kind] ?? { kind: c.kind, p: { ...defaultsOf(FX_SPECS[c.kind]), mix: 1 }, envs: {} };
        for (const [k, v] of c.values) fx.p[k] = v;
        s[c.kind] = fx;
      }
      lib.songs.set(c.id, s);
      return undefined;
    }
    case 'song-fx': {
      const s = songOf(lib, c.id);
      const scratch = new Map<string, LayeredSound>([[c.id, { ...newLayeredSound(c.id, 1), master: s.master }]]);
      applyLayerCommand(scratch as unknown as Map<string, never>, c.inner);
      s.master = scratch.get(c.id)!.master;
      lib.songs.set(c.id, s);
      return undefined;
    }
    case 'song-copy':
    case 'song-rename': {
      const s = songOf(lib, c.id);
      if (c.op === 'song-copy') freeSong(lib, c.to);
      else if (c.to !== c.id) {
        const clash = idClash(lib.songs.keys(), c.to);
        if (clash && clash !== c.id) throw new Error(`song '${c.to}' exists already as '${clash}'`);
      }
      s.id = c.to;
      if (c.op === 'song-copy') s.status = 'draft';
      else lib.songs.delete(c.id);
      lib.songs.set(c.to, s);
      return undefined;
    }
    case 'song-remove': {
      songOf(lib, c.id);
      lib.songs.delete(c.id);
      return undefined;
    }
    case 'song-mark': {
      const s = songOf(lib, c.id);
      s.status = c.status;
      lib.songs.set(c.id, s);
      return undefined;
    }
  }
}

function applySongValues(s: SongDoc, values: [string, SongValue][]): void {
  for (const [k, v] of values) {
    if (k === 'tempo') s.tempo = v as number;
    else if (k === 'swing') s.swing = v as number;
    else if (k === 'gain') s.gain = v as number;
    else if (k === 'time') { const [a, b] = (v as string).split('/'); s.time = [Number(a), Number(b)]; }
    else if (k === 'key') s.key = v as string | null;
    else if (k === 'class') { if (v === null) delete s.loudClass; else s.loudClass = v as string; }
    else if (k === 'loudness') { if (v === null) delete s.loudness; else s.loudness = v as number; }
    else if (k === 'tags') s.tags = v === null ? [] : (v as string).split(',');
    else if (k === 'bible') s.bible = v as string | null;
    else if (k === 'kind') {
      s.kind = v as SongKind;
      // a stinger never loops, and is as loud as a stinger unless the song says otherwise
      if (s.kind === 'stinger') { s.loop = false; if (!s.loudClass && !values.some(([x]) => x === 'class')) s.loudClass = 'stinger'; }
    }
  }
}

/** The plain commands `song new … from-bible= | template=` stands for. */
function songNewLines(lib: Library, c: Extract<MusicCommand, { op: 'song-new' }>): string[] {
  const given = new Map(c.values.map(([k, v]) => [k, showSongValue(k, v).slice(k.length + 1)] as [string, string]));
  const entry = c.fromBible ? lib.guide?.bible.get(c.fromBible) : undefined;
  if (c.fromBible && !entry) throw new Error(`no music bible entry '${c.fromBible}'${lib.guide?.bible.size ? ` (entries: ${[...lib.guide.bible.keys()].join(', ')})` : ' (write music-bible.md in the project folder: a ## <entry> heading, then tempo:, key:, instruments:, motif: lines)'}`);
  if (!c.template) return bibleCommands(c.id, entry!, given);
  const from = new Map<string, string>();
  if (entry) {
    if (entry.tempo) from.set('tempo', String(Math.round((entry.tempo[0] + entry.tempo[1]) / 2)));
    if (entry.key) from.set('key', entry.key);
    if (entry.tags.length) from.set('tags', [...new Set(['stinger', ...entry.tags])].join(','));
    from.set('bible', entry.id);
  }
  for (const [k, v] of given) from.set(k, v);
  const key = from.get('key') ?? projectKey(lib.guide) ?? 'C:major';
  from.delete('key');
  return stingerCommands(c.id, c.template, key, from);
}

export function isMusicOp(op: string): boolean {
  return op.startsWith('inst-') || op.startsWith('pattern-') || op.startsWith('song-');
}

/** Whether a song can play: the instruments it names exist and its patterns fit its channels. */
export function checkSongPlayable(lib: Library, id: string): { errors: string[]; warnings: string[] } {
  return songProblems(lib.songs.get(id)!, (i) => !!lookupInstrument(lib, i));
}

