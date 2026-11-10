// SFZ import: the text of an SFZ file (headers, opcodes, #define and #include) read into regions, and the regions made into
// the zones of a sampled instrument. Only the subset the zones can carry is read; every other opcode is named, per region,
// in the report. The caller reads the file and its samples (the facts of a sample - its rate, length, root and loop - decide
// a few zone values), and writes the commands.

import { parseNote } from './music.ts';
import {
  Groups, InstrumentImportError, LossReport, checkZoneCount, clampedZone, modeOf, roundTime,
  type InstrumentPlan, type PlanZone,
} from './instrumentimport.ts';
import type { Zone, ZoneLoopMode } from './zones.ts';

export type SfzOpcodes = Map<string, string>;

export interface SfzRegion {
  /** 1-based, in file order (regions with no sample included). */
  index: number;
  /** Every opcode in force for the region, global to region, lower-case names. */
  opcodes: SfzOpcodes;
}

export interface SfzParsed {
  regions: SfzRegion[];
  /** Headers that were read and dropped (`<curve>`, `<effect>`, `<midi>`), with how many. */
  skippedHeaders: Map<string, number>;
  /** Opcodes of `<control>` (default_path, note_offset, octave_offset). */
  control: SfzOpcodes;
}

export interface SfzParseOptions {
  /** The text of an `#include`d file, given its path from the SFZ's folder (`/` separators); undefined when it cannot be read. */
  include?: (path: string) => string | undefined;
}

const MAX_INCLUDE_DEPTH = 8;

/** A path with `\` as `/`, `.` and `..` folded. */
export function normalisePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (p: string): string => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };

/** Comments out, `#include` files in, `#define $NAME value` applied. One text, line by line. */
function preprocess(text: string, o: SfzParseOptions, defs: Map<string, string>, depth: number, file: string): string[] {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, ' ').split(/\r\n|\r|\n/);
  const out: string[] = [];
  for (let raw of stripped) {
    const c = raw.indexOf('//');
    if (c >= 0) raw = raw.slice(0, c);
    let line = raw.trim();
    if (!line) continue;
    const def = /^#define\s+(\$[A-Za-z0-9_]+)\s*(.*)$/.exec(line);
    if (def) { defs.set(def[1]!, def[2]!.trim()); continue; }
    const inc = /^#include\s+"([^"]+)"/.exec(line);
    if (inc) {
      if (depth >= MAX_INCLUDE_DEPTH) throw new InstrumentImportError(`#include "${inc[1]}" is nested more than ${MAX_INCLUDE_DEPTH} deep`);
      const path = normalisePath(dirOf(file) ? `${dirOf(file)}/${inc[1]}` : inc[1]!);
      const body = o.include?.(path);
      if (body === undefined) throw new InstrumentImportError(`#include "${inc[1]}": cannot read ${path}`);
      out.push(...preprocess(body, o, defs, depth + 1, path));
      continue;
    }
    if (line.startsWith('#')) continue;
    if (defs.size && line.includes('$')) {
      for (const k of [...defs.keys()].sort((a, b) => b.length - a.length)) line = line.split(k).join(defs.get(k)!);
    }
    out.push(line);
  }
  return out;
}

/** The headers and opcodes of one preprocessed line, in order. */
function tokensOf(line: string): ({ header: string } | { op: string; value: string })[] {
  const out: ({ header: string } | { op: string; value: string })[] = [];
  const re = /<([A-Za-z_]+)>|([A-Za-z_][A-Za-z0-9_$.]*)=/g;
  const marks: { at: number; end: number; header?: string; op?: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    // an opcode name has to start the text or follow white space (a path such as a=b.wav inside a value is not an opcode)
    if (m[2] !== undefined && m.index > 0 && !/\s/.test(line[m.index - 1]!)) continue;
    marks.push({ at: m.index, end: m.index + m[0].length, ...(m[1] !== undefined ? { header: m[1].toLowerCase() } : { op: m[2]!.toLowerCase() }) });
  }
  for (let i = 0; i < marks.length; i++) {
    const k = marks[i]!;
    if (k.header !== undefined) { out.push({ header: k.header }); continue; }
    const to = i + 1 < marks.length ? marks[i + 1]!.at : line.length;
    out.push({ op: k.op!, value: line.slice(k.end, to).trim() });
  }
  return out;
}

/** Read the text of an SFZ file. `path` is where the file is (for relative `#include`s); default none. */
export function parseSfz(text: string, o: SfzParseOptions = {}, path = ''): SfzParsed {
  const lines = preprocess(text, o, new Map(), 0, path);
  const control: SfzOpcodes = new Map();
  const level: Record<'global' | 'master' | 'group', SfzOpcodes> = { global: new Map(), master: new Map(), group: new Map() };
  let current: { kind: 'control' | 'global' | 'master' | 'group' | 'region' | 'other'; ops: SfzOpcodes } | null = null;
  const regions: SfzRegion[] = [];
  const skippedHeaders = new Map<string, number>();
  const closeRegion = (): void => {
    if (current?.kind !== 'region') return;
    const ops: SfzOpcodes = new Map();
    for (const l of [level.global, level.master, level.group, current.ops]) for (const [k, v] of l) ops.set(k, v);
    regions.push({ index: regions.length + 1, opcodes: ops });
  };
  for (const line of lines) {
    for (const t of tokensOf(line)) {
      if ('header' in t) {
        closeRegion();
        const h = t.header;
        if (h === 'control') current = { kind: 'control', ops: control };
        else if (h === 'global') { level.global = new Map(); level.master = new Map(); level.group = new Map(); current = { kind: 'global', ops: level.global }; }
        else if (h === 'master') { level.master = new Map(); level.group = new Map(); current = { kind: 'master', ops: level.master }; }
        else if (h === 'group') { level.group = new Map(); current = { kind: 'group', ops: level.group }; }
        else if (h === 'region') current = { kind: 'region', ops: new Map() };
        else { skippedHeaders.set(h, (skippedHeaders.get(h) ?? 0) + 1); current = { kind: 'other', ops: new Map() }; }
      } else if (current) {
        current.ops.set(t.op, t.value);
      }
    }
  }
  closeRegion();
  return { regions, skippedHeaders, control };
}

// ---- samples -----------------------------------------------------------------------------------------------------

/** The path of a region's sample from the SFZ's folder, or null for a region with no sample. A generator (`*sine`) is an error. */
export function regionSamplePath(r: SfzRegion, control: SfzOpcodes): string | null {
  const s = r.opcodes.get('sample');
  if (s === undefined || s === '') return null;
  if (s.startsWith('*')) throw new InstrumentImportError(`region ${r.index}: sample=${s} is a generator, not a file; SoundClaw imports the files an SFZ plays`);
  const absolute = (x: string): boolean => /^([A-Za-z]:)?[\\/]/.test(x);
  if (absolute(s) || absolute(control.get('default_path') ?? '')) throw new InstrumentImportError(`region ${r.index}: sample=${s} is an absolute path; SoundClaw reads sample files beside the SFZ (relative paths)`);
  const dp = (control.get('default_path') ?? '').replace(/\\/g, '/');
  return normalisePath(`${dp}${dp && !dp.endsWith('/') ? '/' : ''}${s}`);
}

/** The distinct sample files the regions play, in the order they are first met, each with the first region that plays it. */
export function sfzSamples(p: SfzParsed): { path: string; region: number }[] {
  const seen = new Map<string, number>();
  for (const r of p.regions) {
    if (regionHasNoSound(r)) continue;
    const path = regionSamplePath(r, p.control);
    if (path !== null && !seen.has(path)) seen.set(path, r.index);
  }
  return [...seen].map(([path, region]) => ({ path, region }));
}

/** What a region with `end` of 0 or -1 says: it plays nothing. */
function regionHasNoSound(r: SfzRegion): boolean {
  const e = r.opcodes.get('end');
  return e !== undefined && Number(e) <= 0 && e.trim() !== '' && Number.isFinite(Number(e));
}

/** What the plan needs to know about a sample file. */
export interface SampleFacts {
  rate: number;
  frames: number;
  /** The root note and cents the file carries (`smpl`), when it does. */
  root?: number;
  tune?: number;
  /** The loop the file carries, in frames (end exclusive). */
  loop?: [number, number];
}

// ---- opcodes -----------------------------------------------------------------------------------------------------

/** Opcodes that make the zones. */
const USED = new Set([
  'sample', 'lokey', 'hikey', 'key', 'lovel', 'hivel', 'pitch_keycenter', 'pitch_keytrack', 'tune', 'transpose', 'volume', 'pan',
  'amp_veltrack', 'ampeg_attack', 'ampeg_hold', 'ampeg_decay', 'ampeg_sustain', 'ampeg_release', 'loop_mode', 'loopmode', 'loop_start', 'loopstart',
  'loop_end', 'loopend', 'loop_crossfade', 'offset', 'end', 'trigger', 'rt_decay', 'seq_length', 'seq_position', 'lorand', 'hirand', 'group', 'off_by',
]);

/** Opcodes that say something about the file and not the sound. */
const HARMLESS = new Set([
  'region_label', 'group_label', 'master_label', 'global_label', 'sw_label', 'default_path', 'octave_offset', 'note_offset', 'hint_ram_based',
  'hint_stream_only', 'hint_sound_level', 'set_cc', 'label_key', 'label_cc', 'loop_type', 'sample_quality', 'default_switch', 'sw_default',
]);

const num = (r: SfzRegion, op: string): number | undefined => {
  const v = r.opcodes.get(op);
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new InstrumentImportError(`region ${r.index}: ${op}=${v} is not a number`);
  return n;
};

/** A key opcode: a number, or a note name (c4 is 60). */
function key(r: SfzRegion, op: string, offset: number): number | undefined {
  const v = r.opcodes.get(op);
  if (v === undefined || v === '') return undefined;
  if (/^-?\d+$/.test(v)) return Number(v) + offset;
  const m = /^([a-gA-G])([#b]?)(-?\d)$/.exec(v);
  const n = m ? parseNote(m[1]!.toUpperCase() + m[2]! + m[3]!) : null;
  if (n === null) throw new InstrumentImportError(`region ${r.index}: ${op}=${v} is not a key (a number from 0 to 127 or a note like c4)`);
  return n + offset;
}

const MAX_KEYTRACK0_SPAN = 16;

interface Built {
  region: SfzRegion;
  path: string;
  zone: Zone;
  /** SFZ's group, off_by, lorand and hirand for the passes after. */
  group: number;
  offBy: number | null;
  lorand: number;
  hirand: number;
  random: boolean;
  seq: boolean;
  keytrack0: boolean;
  veltrack: number;
  env: [number, number, number, number];
  envSet: boolean;
}

/** The regions as the plan of an instrument. `facts` finds a sample file's rate, length, root and loop. */
export function sfzToPlan(p: SfzParsed, facts: (path: string) => SampleFacts): InstrumentPlan {
  const losses = new LossReport();
  const notes: string[] = [];
  for (const [h, n] of p.skippedHeaders) losses.add('lost', `<${h}> header${n === 1 ? '' : 's'} (${n})`, null);
  const octave = (num({ index: 0, opcodes: p.control }, 'octave_offset') ?? 0) * 12 + (num({ index: 0, opcodes: p.control }, 'note_offset') ?? 0);
  if (octave) notes.push(`<control> shifts the keys by ${octave} semitones; the keys are written shifted`);
  const built: Built[] = [];
  for (const r of p.regions) {
    const path = regionSamplePath(r, p.control);
    if (path === null) { notes.push(`region ${r.index} has no sample= and plays nothing; it is left out`); continue; }
    if (regionHasNoSound(r)) { notes.push(`region ${r.index} has end=${r.opcodes.get('end')} and plays nothing; it is left out`); continue; }
    // every opcode that is neither used nor harmless is named
    for (const op of r.opcodes.keys()) {
      if (USED.has(op) || HARMLESS.has(op) || /^label_(cc|key)\d+$/.test(op) || /_label$/.test(op)) continue;
      losses.add('lost', op, r.index);
    }
    const f = facts(path);
    const note = (what: string, detail: string): void => losses.add('approximated', what, r.index, detail);
    const k = key(r, 'key', octave);
    const lo = key(r, 'lokey', octave) ?? k ?? 0;
    const hi = key(r, 'hikey', octave) ?? k ?? 127;
    if (lo > hi) { notes.push(`region ${r.index} has lokey above hikey and plays nothing; it is left out`); continue; }
    const lovel = Math.max(1, num(r, 'lovel') ?? 1);
    const hivel = num(r, 'hivel') ?? 127;
    if (lovel > hivel) { notes.push(`region ${r.index} has lovel above hivel and plays nothing; it is left out`); continue; }
    const kc = r.opcodes.get('pitch_keycenter');
    const root = kc === 'sample' ? (f.root ?? 60) : (key(r, 'pitch_keycenter', octave) ?? k ?? 60);
    const keytrack = num(r, 'pitch_keytrack');
    const tune = (num(r, 'tune') ?? 0) + 100 * (num(r, 'transpose') ?? 0);
    const volume = num(r, 'volume') ?? 0;
    const pan = (num(r, 'pan') ?? 0) / 100;
    const offset = Math.max(0, Math.round(num(r, 'offset') ?? 0));
    const endF = num(r, 'end');
    const rate = f.rate;
    // loops
    let loopmode: ZoneLoopMode;
    const lm = r.opcodes.get('loop_mode') ?? r.opcodes.get('loopmode');
    const ls = num(r, 'loop_start') ?? num(r, 'loopstart');
    const le = num(r, 'loop_end') ?? num(r, 'loopend');
    const hasLoop = ls !== undefined || le !== undefined || f.loop !== undefined;
    switch (lm) {
      case 'no_loop': loopmode = 'none'; break;
      case 'one_shot': loopmode = 'oneshot'; break;
      case 'loop_continuous': loopmode = 'continuous'; break;
      case 'loop_sustain': loopmode = 'sustain'; break;
      case undefined: case '': loopmode = hasLoop ? 'continuous' : 'none'; break;
      default: loopmode = 'none'; note('loop_mode', `${lm} is not one of no_loop, one_shot, loop_continuous, loop_sustain; no_loop is used`);
    }
    let loop: Zone['loop'] = 'sample';
    if (loopmode === 'none' || loopmode === 'oneshot') loop = null;
    else if (ls !== undefined || le !== undefined) {
      const a = ls ?? f.loop?.[0] ?? 0;
      const b = le !== undefined ? le + 1 : (f.loop?.[1] ?? f.frames);
      if (a < offset || b <= a) { loop = null; loopmode = 'none'; note('loop_start/loop_end', `the loop ${a}-${b} frames lies before offset=${offset} or is empty; no loop is used`); }
      else loop = [roundTime((a - offset) / rate), roundTime((b - offset) / rate)];
    } else if (!f.loop) { loop = null; loopmode = 'none'; note('loop_mode', `${lm} asks for a loop and the sample has no loop points (no loop_start/loop_end, no smpl loop); no loop is used`); }
    const xf = num(r, 'loop_crossfade');
    // the rest
    const trig = r.opcodes.get('trigger');
    let trigger: Zone['trigger'] = 'attack';
    if (trig === 'release' || trig === 'release_key') trigger = 'release';
    else if (trig === 'first' || trig === 'legato') note('trigger', `${trig} is played as attack`);
    const v = clampedZone('', root, {
      keys: [lo, hi], vel: [lovel, hivel], tune, gain: volume, pan, start: roundTime(offset / rate), end: endF && endF > 0 ? roundTime(endF / rate) : 0,
      loop, loopmode, ...(xf !== undefined && loop !== null ? { xfade: xf } : {}), trigger, releaseDecay: num(r, 'rt_decay') ?? 0,
    }, note);
    v.sample = path;
    const sl = num(r, 'seq_length');
    const sp = num(r, 'seq_position');
    let seq = false;
    if (sl !== undefined && sl > 1) {
      if (sl > 16) note('seq_length', `${sl} takes; at most 16 are kept (this region plays as one take of a group of 16)`);
      v.rr = [Math.max(1, Math.min(sp ?? 1, Math.min(sl, 16))), Math.min(sl, 16)];
      seq = true;
    }
    const lorand = num(r, 'lorand') ?? 0;
    const hirand = num(r, 'hirand') ?? 1;
    const ho = (r.opcodes.get('ampeg_hold'));
    if (ho !== undefined && Number(ho) > 0.01) losses.add('lost', 'ampeg_hold', r.index, 'the hold stage is not carried; the level goes from the attack straight to the decay');
    built.push({
      region: r, path, zone: v, group: num(r, 'group') ?? 0, offBy: num(r, 'off_by') ?? null, lorand, hirand,
      random: lorand > 0 || hirand < 1, seq, keytrack0: keytrack === 0, veltrack: num(r, 'amp_veltrack') ?? 100,
      env: [num(r, 'ampeg_attack') ?? 0, num(r, 'ampeg_decay') ?? 0, (num(r, 'ampeg_sustain') ?? 100) / 100, num(r, 'ampeg_release') ?? 0],
      envSet: ['ampeg_attack', 'ampeg_decay', 'ampeg_sustain', 'ampeg_release'].some((o) => r.opcodes.has(o)),
    });
  }
  const all = losses.list();

  // ---- random round robins: lorand/hirand ranges of regions sharing keys, velocities and trigger become takes
  const groupsOf = new Map<string, Built[]>();
  for (const b of built) {
    if (!b.random) continue;
    const k = `${b.zone.keys.join('-')}|${b.zone.vel.join('-')}|${b.zone.trigger}`;
    groupsOf.set(k, [...(groupsOf.get(k) ?? []), b]);
  }
  const extra = new LossReport();
  for (const g of groupsOf.values()) {
    g.sort((a, b) => a.lorand - b.lorand);
    const n = g.length;
    if (n < 2 || n > 16) { for (const b of g) extra.add('approximated', 'lorand/hirand', b.region.index, `${n} regions share these keys and velocities; ${n < 2 ? 'a single random range plays always' : 'more than 16 takes are not kept'}`); continue; }
    g.forEach((b, i) => { b.zone.rr = [i + 1, n]; });
    const widths = g.map((b) => b.hirand - b.lorand);
    const equal = widths.every((x) => Math.abs(x - 1 / n) < 0.02);
    for (const b of g) extra.add('approximated', 'lorand/hirand', b.region.index, equal ? 'played as round robin takes picked at random from the channel and the note (rr=hash)' : 'the ranges are not equal; the takes are picked with equal chance (rr=hash)');
  }
  const anyRandom = built.some((b) => b.random && b.zone.rr);
  const anySeq = built.some((b) => b.seq);
  const rr: InstrumentPlan['rr'] = anySeq ? 'cycle' : anyRandom ? 'hash' : null;
  if (anySeq && anyRandom) extra.add('approximated', 'lorand/hirand', null, 'the instrument takes turns (seq_position); regions chosen at random (lorand, hirand) take turns too');

  // ---- choke groups: group / off_by
  const uf = new Groups();
  const linked = new Set<number>();
  for (const b of built) {
    if (b.offBy === null || b.offBy === 0) continue;
    if (b.group === 0) { extra.add('lost', 'off_by', b.region.index, 'the region has no group, so nothing can name it'); continue; }
    uf.union(b.group, b.offBy);
    linked.add(b.group); linked.add(b.offBy);
  }
  const ids = new Map<number, number>();
  for (const b of built) {
    if (!linked.has(b.group) || b.group === 0) continue;
    const root = uf.find(b.group);
    if (!ids.has(root)) ids.set(root, ids.size + 1);
    if (ids.size > 99) throw new InstrumentImportError('more than 99 choke groups (group/off_by)');
    b.zone.choke = ids.get(root)!;
  }
  const cutsBack = (b: Built): boolean => built.some((o) => o.group === b.offBy && o.offBy === b.group);
  for (const b of built) {
    if (b.offBy !== null && b.offBy !== 0 && b.group !== 0 && b.offBy !== b.group && !cutsBack(b)) {
      extra.add('approximated', 'group/off_by', b.region.index, `group ${b.group} is cut by group ${b.offBy} only; in SoundClaw a choke group cuts both ways, and a note cuts its own group's earlier notes too`);
    }
  }

  // ---- the instrument's envelope and velocity sensitivity: one for the instrument, the commonest of the regions'
  const setEnvs = built.filter((b) => b.envSet);
  let adsr: InstrumentPlan['adsr'] = null;
  if (setEnvs.length) {
    const { value, unanimous } = modeOf(built.map((b) => b.env.join(',')));
    const e = value!.split(',').map(Number) as [number, number, number, number];
    adsr = [Math.max(0.001, Math.min(4, e[0])), Math.max(0, Math.min(4, e[1])), Math.max(0, Math.min(1, e[2])), Math.max(0.005, Math.min(8, e[3]))];
    if (!unanimous) {
      for (const b of built) if (b.env.join(',') !== value) extra.add('approximated', 'ampeg_attack/decay/sustain/release', b.region.index, `the instrument has one note envelope (${adsr.map((x) => roundTime(x)).join('/')}); this region's differs`);
    }
  }
  let velocity: number | null = null;
  if (built.length) {
    const { value, unanimous } = modeOf(built.map((b) => b.veltrack));
    velocity = Math.max(0, Math.min(1, (value ?? 100) / 100));
    if (velocity === 1) velocity = null;
    if (!unanimous) for (const b of built) if (b.veltrack !== value) extra.add('approximated', 'amp_veltrack', b.region.index, `the instrument has one velocity sensitivity (${value}%); this region's is ${b.veltrack}%`);
  }

  // ---- unpitched regions (pitch_keytrack=0)
  const k0 = built.filter((b) => b.keytrack0);
  let pitched = true;
  const zones: PlanZone[] = [];
  if (k0.length && k0.length === built.length) {
    pitched = false;
    notes.push('every region has pitch_keytrack=0: the instrument is unpitched (pitched=no), so notes play the samples as they are');
  }
  for (const b of built) {
    if (b.keytrack0 && pitched) {
      const [a, z] = b.zone.keys;
      if (z - a + 1 <= MAX_KEYTRACK0_SPAN) {
        for (let n = a; n <= z; n++) zones.push({ zone: { ...b.zone, keys: [n, n], root: n, ...(b.zone.rr ? { rr: [...b.zone.rr] as [number, number] } : {}) }, ref: b.region.index });
        continue;
      }
      extra.add('approximated', 'pitch_keytrack=0', b.region.index, `the region spans ${z - a + 1} keys; the zone is transposed from its root as other zones are`);
    }
    zones.push({ zone: b.zone, ref: b.region.index });
  }
  checkZoneCount(zones.length, `the SFZ (${built.length} regions)`);
  if (!zones.length) throw new InstrumentImportError('the SFZ has no region that plays a sample');
  return { source: 'sfz', zones, adsr, velocity, pitched, rr, losses: [...all, ...extra.list()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'lost' ? -1 : 1)), notes };
}
