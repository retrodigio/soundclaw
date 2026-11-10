// Songs: tempo, swing, channels bound to instruments, the patterns, and their order. A song is
//   intro (plays once) · body sections · ending (plays once)
// with an optional loop region inside the body (default: the whole body). Channels carry a game
// layer name (base, tension, combat ...); the stems of a layer are its channels mixed, all the same
// length so that they loop together.

import { clonePattern, channelEvents, formatCell, formatPattern, type Cell, type NoteFx, type Pattern } from './pattern.ts';
import { parseKey } from './music.ts';
import { FX_SPECS, defaultsOf, type Fx } from './layered.ts';

export const SONG_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
export const SECTION_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
export const LAYER_NAME_RE = /^[a-z][a-z0-9_-]{0,23}$/;
export const TEMPO = { min: 30, max: 300 } as const;
export const SWING = { min: 0, max: 0.6 } as const;
export const MAX_CHANNELS = 16;
export const MAX_SECTIONS = 64;
export const MAX_SONG_SECONDS = 600;
export const DEFAULT_LAYER = 'base';

export interface Channel {
  name: string;
  /** The instrument (project or built-in) a pitched channel plays; null for a drum channel. */
  inst: string | null;
  /** A drum channel: hit name -> instrument, over the default kit. */
  kit: Record<string, string> | null;
  gain: number;
  pan: number;
  /** The game layer (stem) the channel belongs to. */
  layer: string;
  /** A harmony part: the voice-leading check looks at it. */
  harmony?: true;
  /** How much of the channel goes to the song's send reverb, send delay and send convolution (0..1; left out when 0). */
  reverb?: number;
  delay?: number;
  convolve?: number;
}

/** The song-level send buses a channel can feed. */
export const SEND_KINDS = ['reverb', 'delay', 'convolve'] as const;
export type SendKind = (typeof SEND_KINDS)[number];

/** A named note list kept in the song (a melody idea), on its own grid. */
export interface Motif {
  name: string;
  /** Steps per beat of its cells. */
  tpb: number;
  /** Notes, holds and rests, as in a pattern row. */
  cells: Cell[];
}

export const MOTIF_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
export const TAG_RE = /^[a-z][a-z0-9_-]{0,23}$/;
export const SONG_KINDS = ['song', 'stinger'] as const;
export type SongKind = (typeof SONG_KINDS)[number];

export interface Section {
  name: string;
  patterns: string[];
  repeat: number;
}

export type SongLoop = null | false | { from: string; to: string };

export interface SongDoc {
  id: string;
  tempo: number;
  swing: number;
  time: [number, number];
  key: string | null;
  gain: number;
  loudClass?: string;
  loudness?: number;
  channels: Channel[];
  sections: Section[];
  intro: string | null;
  ending: string | null;
  /** null: the whole body loops; false: the song does not loop; else the sections from..to. */
  loop: SongLoop;
  master: Fx[];
  /** The send reverb, send delay and send convolution: one shared space for the whole piece. Channels feed them by `reverb=`, `delay=` and `convolve=`. Null: not set up. */
  reverb: Fx | null;
  delay: Fx | null;
  convolve: Fx | null;
  patterns: Map<string, Pattern>;
  status: 'draft' | 'approved' | 'rejected';
  /** A song, or a stinger (a short piece with a fixed ending that never loops). */
  kind: SongKind;
  /** Words the style guide's sections and rules apply by (town, battle ...). */
  tags: string[];
  /** The music bible entry the song was made from. */
  bible: string | null;
  /** The game layers in the order they stack (the first is the base); empty: as the channels first name them. */
  layers: string[];
  motifs: Motif[];
}

export const DEFAULT_KIT: Readonly<Record<string, string>> = { k: 'kick', kick: 'kick', s: 'snare', snare: 'snare', h: 'hat', hat: 'hat', oh: 'hat_open', hat_open: 'hat_open' };

export function newSong(id: string): SongDoc {
  const limit: Fx = { kind: 'limit', p: { ...defaultsOf(FX_SPECS.limit), ceiling: -1 }, envs: {} };
  return { id, tempo: 120, swing: 0, time: [4, 4], key: null, gain: 1, channels: [], sections: [], intro: null, ending: null, loop: null, master: [limit], reverb: null, delay: null, convolve: null, patterns: new Map(), status: 'draft', kind: 'song', tags: [], bible: null, layers: [], motifs: [] };
}

const cloneFx = (f: Fx): Fx => ({ kind: f.kind, p: { ...f.p }, envs: Object.fromEntries(Object.entries(f.envs).map(([k, e]) => [k, e.map((q) => ({ ...q }))])) });

export function cloneSong(s: SongDoc): SongDoc {
  return {
    ...s,
    time: [...s.time],
    channels: s.channels.map((c) => ({ ...c, kit: c.kit ? { ...c.kit } : null })),
    sections: s.sections.map((x) => ({ ...x, patterns: [...x.patterns] })),
    loop: s.loop && typeof s.loop === 'object' ? { ...s.loop } : s.loop,
    master: s.master.map(cloneFx),
    reverb: s.reverb ? cloneFx(s.reverb) : null,
    delay: s.delay ? cloneFx(s.delay) : null,
    convolve: s.convolve ? cloneFx(s.convolve) : null,
    patterns: new Map([...s.patterns].map(([k, v]) => [k, clonePattern(v)] as const)),
    tags: [...s.tags],
    layers: [...s.layers],
    motifs: s.motifs.map((m) => ({ ...m, cells: clonePattern({ name: 'm', steps: m.cells.length, tpb: m.tpb, bar: null, channels: [{ name: 'm', cells: m.cells }] }).channels[0]!.cells })),
  };
}

export function channelOf(s: SongDoc, name: string): Channel | undefined {
  return s.channels.find((c) => c.name === name);
}

/** The instrument id a drum hit in a channel plays, or undefined. */
export function drumInstrument(c: Channel, drum: string): string | undefined {
  return c.kit?.[drum] ?? c.kit?.[KIT_ALL] ?? DEFAULT_KIT[drum];
}

/** In a channel's kit, the hit name that stands for every hit: `kit=<instrument>` maps all hits to one instrument, whose zones are keyed by hit name. */
export const KIT_ALL = '*';

/** The kit as it is written after `kit=`: one instrument (every hit goes to it), `default`, or `hit:instrument` pairs. */
export function kitText(kit: Record<string, string> | null): string {
  const e = Object.entries(kit ?? {});
  if (e.length === 1 && e[0]![0] === KIT_ALL) return e[0]![1];
  return e.map(([k, v]) => `${k}:${v}`).join(',') || 'default';
}

// ---- the arrangement ----------------------------------------------------------------------------------------

export interface Instance {
  /** Position in the arrangement. */
  index: number;
  part: 'intro' | 'body' | 'ending';
  inLoop: boolean;
  section: string;
  /** Which time through its section's repeat (from 0). */
  pass: number;
  pattern: Pattern;
  t0: number;
  dur: number;
  stepSec: number;
}

export interface Arrangement {
  instances: Instance[];
  /** Seconds in all (intro, body once, ending). */
  total: number;
  /** The loop region in seconds, or null when the song does not loop. */
  loop: { start: number; end: number } | null;
}

export const stepSeconds = (tempo: number, tpb: number): number => 60 / (tempo * tpb);

/** The time of a step inside an instance (the second step of each pair is late by swing × a step). */
export function stepTime(i: Pick<Instance, 't0' | 'stepSec'>, step: number, swing: number, steps: number): number {
  return i.t0 + step * i.stepSec + (step % 2 === 1 && step < steps ? swing * i.stepSec : 0);
}

export function sectionOf(s: SongDoc, name: string): Section | undefined {
  return s.sections.find((x) => x.name === name);
}

/** The section order as the song plays it: intro, body, ending. Throws a plain Error when a pattern is missing. */
export function arrange(song: SongDoc): Arrangement {
  const order: { sec: Section; part: Instance['part'] }[] = [];
  const body = song.sections.filter((x) => x.name !== song.intro && x.name !== song.ending);
  const intro = song.intro ? sectionOf(song, song.intro) : undefined;
  const ending = song.ending ? sectionOf(song, song.ending) : undefined;
  if (intro) order.push({ sec: intro, part: 'intro' });
  for (const sec of body) order.push({ sec, part: 'body' });
  if (ending) order.push({ sec: ending, part: 'ending' });
  let from = 0, to = body.length - 1;
  if (song.loop && typeof song.loop === 'object') {
    from = body.findIndex((x) => x.name === (song.loop as { from: string }).from);
    to = body.findIndex((x) => x.name === (song.loop as { to: string }).to);
    if (from < 0 || to < 0 || to < from) throw new Error(`the loop ${(song.loop as { from: string; to: string }).from}..${(song.loop as { to: string }).to} is not a run of body sections (body: ${body.map((x) => x.name).join(', ') || 'none'})`);
  }
  const looped = song.loop !== false && body.length > 0;
  const instances: Instance[] = [];
  let t = 0;
  let loopStart: number | null = null, loopEnd: number | null = null;
  for (const { sec, part } of order) {
    const bodyIndex = part === 'body' ? body.indexOf(sec) : -1;
    const inLoop = looped && part === 'body' && bodyIndex >= from && bodyIndex <= to;
    if (inLoop && loopStart === null) loopStart = t;
    for (let pass = 0; pass < sec.repeat; pass++) {
      for (const pn of sec.patterns) {
        const pat = song.patterns.get(pn);
        if (!pat) throw new Error(`section ${sec.name} names pattern '${pn}', which the song does not have (patterns: ${[...song.patterns.keys()].join(', ') || 'none'})`);
        const stepSec = stepSeconds(song.tempo, pat.tpb);
        const dur = pat.steps * stepSec;
        instances.push({ index: instances.length, part, inLoop, section: sec.name, pass, pattern: pat, t0: t, dur, stepSec });
        t += dur;
      }
    }
    if (inLoop) loopEnd = t;
  }
  if (t > MAX_SONG_SECONDS) throw new Error(`the song is ${Math.round(t)} s long; the most is ${MAX_SONG_SECONDS} s`);
  return { instances, total: t, loop: loopStart !== null && loopEnd !== null ? { start: loopStart, end: loopEnd } : null };
}

// ---- the notes of a channel ---------------------------------------------------------------------------------

export interface NoteEv {
  /** Seconds from the start of the arrangement. */
  t: number;
  /** Where the grid puts it (t without the note's nudge). */
  grid: number;
  /** Seconds the key is held (to the next step after the note and its holds). */
  len: number;
  midi: number | null;
  drum: string | null;
  vel: number;
  fx: NoteFx;
  slideFrom: number | null;
  accidental: boolean;
  /** Written with a flat. */
  flat: boolean;
  /** Where it is written: arrangement index, pattern, step. */
  at: { instance: number; pattern: string; section: string; step: number };
}

/** Every note and hit a channel plays, in time order (a chord is several events at one time). */
export function channelNotes(song: SongDoc, arr: { instances: Instance[] }, channel: string): NoteEv[] {
  const out: NoteEv[] = [];
  for (const inst of arr.instances) {
    const row = inst.pattern.channels.find((c) => c.name === channel);
    if (!row) continue;
    for (const e of channelEvents(row)) {
      const t = stepTime(inst, e.step, song.swing, inst.pattern.steps);
      const end = stepTime(inst, e.step + e.len, song.swing, inst.pattern.steps);
      const at = { instance: inst.index, pattern: inst.pattern.name, section: inst.section, step: e.step };
      // a nudge moves the whole note off the grid (its length is kept)
      if (e.drum !== null) out.push({ t: t + e.nudge / 1000, grid: t, len: Math.max(0.01, end - t), midi: null, drum: e.drum, vel: e.vel, fx: {}, slideFrom: e.slideFrom, accidental: false, flat: false, at });
      else for (const n of e.notes!) out.push({ t: t + (n.nudge ?? 0) / 1000, grid: t, len: end - t, midi: n.midi, drum: null, vel: n.vel, fx: n.fx, slideFrom: e.slideFrom, accidental: !!n.accidental, flat: !!n.flat, at });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** The layers in the order they stack: the song's plan, then any layer a channel names that the plan leaves out. */
export function layerOrder(song: SongDoc): string[] {
  const out = [...song.layers];
  for (const c of song.channels) if (!out.includes(c.layer)) out.push(c.layer);
  return out.filter((l) => song.channels.some((c) => c.layer === l));
}

/** A motif's cells as text (the form `motif set` takes). */
export const motifText = (m: Motif): string => m.cells.map(formatCell).join(' ');

/** Problems with a song that stop it rendering (errors), and things worth saying (warnings). */
export function songProblems(song: SongDoc, hasInstrument: (id: string) => boolean): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (song.key) { try { parseKey(song.key); } catch (e) { errors.push((e as Error).message); } }
  for (const c of song.channels) {
    if (c.inst && !hasInstrument(c.inst)) errors.push(`channel ${c.name} plays instrument '${c.inst}', which does not exist (instrument new ${c.inst} from=square_lead)`);
    if (c.kit) for (const [k, id] of Object.entries(c.kit)) if (!hasInstrument(id)) errors.push(`channel ${c.name} maps hit '${k}' to instrument '${id}', which does not exist`);
  }
  for (const sec of song.sections) for (const p of sec.patterns) if (!song.patterns.has(p)) errors.push(`section ${sec.name} names pattern '${p}', which the song does not have`);
  if (errors.length) return { errors, warnings };
  let arr: Arrangement;
  try { arr = arrange(song); } catch (e) { return { errors: [(e as Error).message], warnings }; }
  if (song.kind === 'stinger' && !song.ending) warnings.push(`${song.id} is a stinger without an ending section (song ending ${song.id} <section>): a stinger ends on a fixed ending`);
  const beats = song.time[0] * (4 / song.time[1]);
  const seen = new Set<string>();
  for (const inst of arr.instances) {
    const p = inst.pattern;
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    const bars = p.steps / p.tpb / beats;
    if (Math.abs(bars - Math.round(bars)) > 1e-9) warnings.push(`pattern ${p.name} is ${p.steps / p.tpb} beats, not a whole number of ${song.time[0]}/${song.time[1]} bars`);
    for (const row of p.channels) {
      const ch = channelOf(song, row.name);
      if (!ch) { warnings.push(`pattern ${p.name} has a row for channel '${row.name}', which the song does not have (it is not played)`); continue; }
      for (const e of channelEvents(row)) {
        if (ch.inst && e.drum !== null) { errors.push(`pattern ${p.name}: channel ${row.name} plays instrument ${ch.inst}, but step ${e.step} is a drum hit '${e.drum}'`); break; }
        if (ch.kit && e.drum === null) { errors.push(`pattern ${p.name}: channel ${row.name} is a drum channel (kit), but step ${e.step} is a note`); break; }
        if (ch.kit && e.drum !== null && !drumInstrument(ch, e.drum)) { errors.push(`pattern ${p.name}: channel ${row.name} has no drum '${e.drum}' (kit: ${Object.keys({ ...DEFAULT_KIT, ...ch.kit }).join(', ')}; map it with song channel set ${song.id} ${row.name} kit=${e.drum}:<instrument>)`); break; }
      }
    }
  }
  return { errors, warnings };
}

/** The song as text (songs/<id>.song): settings, channels, sections, then each pattern in its normal form. */
export function serializeSongHead(s: SongDoc, fmt: (n: number) => string): string[] {
  const lines = ['soundclaw song 1', `id ${s.id}`, `tempo ${fmt(s.tempo)}`, `swing ${fmt(s.swing)}`, `time ${s.time[0]}/${s.time[1]}`, `key ${s.key ?? 'none'}`, `gain ${fmt(s.gain)}`];
  if (s.loudClass) lines.push(`class ${s.loudClass}`);
  if (s.loudness !== undefined) lines.push(`loudness ${fmt(s.loudness)}`);
  if (s.kind !== 'song') lines.push(`kind ${s.kind}`);
  if (s.tags.length) lines.push(`tags ${s.tags.join(',')}`);
  if (s.bible) lines.push(`bible ${s.bible}`);
  if (s.layers.length) lines.push(`layers ${s.layers.join(' ')}`);
  for (const c of s.channels) lines.push(`channel ${c.name} ${c.inst ? `inst=${c.inst}` : `kit=${kitText(c.kit)}`} gain=${fmt(c.gain)} pan=${fmt(c.pan)} layer=${c.layer}${c.harmony ? ' harmony=yes' : ''}${c.reverb ? ` reverb=${fmt(c.reverb)}` : ''}${c.delay ? ` delay=${fmt(c.delay)}` : ''}${c.convolve ? ` convolve=${fmt(c.convolve)}` : ''}`);
  for (const m of s.motifs) lines.push(`motif ${m.name} tpb=${m.tpb} ${motifText(m)}`);
  for (const x of s.sections) lines.push(`section ${x.name} ${x.patterns.join(' ')}${x.repeat > 1 ? ` x${x.repeat}` : ''}${s.intro === x.name ? ' intro' : ''}${s.ending === x.name ? ' ending' : ''}`);
  lines.push(`loop ${s.loop === false ? 'off' : s.loop ? `${s.loop.from}..${s.loop.to}` : 'auto'}`);
  lines.push(`status ${s.status}`);
  return lines;
}

// ---- documents and JSON ---------------------------------------------------------------------------------------

/** A song as plain JSON (the patterns as a list), for the page and for hashing. */
export interface SongJson extends Omit<SongDoc, 'patterns'> {
  patterns: Pattern[];
}

export const songToJson = (s: SongDoc): SongJson => ({ ...s, patterns: [...s.patterns.values()] });
export const songFromJson = (j: SongJson): SongDoc => ({ ...j, patterns: new Map(j.patterns.map((p) => [p.name, p] as const)) });

/** The song's file (songs/<id>.song): settings, channels, sections. The patterns are files of their own (songs/<id>/patterns/<name>.pat). */
export function serializeSong(s: SongDoc): string {
  const lines = serializeSongHead(s, String);
  for (const k of SEND_KINDS) { const f = s[k]; if (f) lines.push(`send ${k} ${Object.entries(f.p).filter(([n]) => n !== 'mix').map(([n, v]) => `${n}=${v}`).join(' ')}`); }
  for (const f of s.master) lines.push(`master ${f.kind} ${Object.entries(f.p).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  return lines.join('\n') + '\n';
}

/** Everything that decides how the song reads and sounds, as one text: the file, then every pattern in its normal form. */
export function songText(s: SongDoc): string {
  return serializeSong(s) + [...s.patterns.values()].map((p) => formatPattern(p)).join('');
}
