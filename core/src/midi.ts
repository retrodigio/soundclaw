// Standard MIDI files. Export writes a type 1 file: a tempo/time track and one track per channel
// (drum channels share MIDI channel 10 with General MIDI note numbers). Import reads type 0 and 1
// files and returns a command script that makes the song: one pattern per few bars, one song channel
// per track and MIDI channel, drums on channel 10 mapped to the drum instruments.
// What MIDI cannot hold is dropped on export (swing, ~slide/~vib/~arp, instruments); what the
// pattern grid cannot hold is rounded on import (timings go to the nearest step).

import { channelEvents, formatPattern, type Cell, type Pattern, type PNote } from './pattern.ts';
import { noteLabel } from './music.ts';
import { arrange, stepSeconds, type SongDoc, DEFAULT_KIT } from './song.ts';

const PPQ = 480;

// ---- bytes -------------------------------------------------------------------------------------------------------

class Out {
  bytes: number[] = [];
  u8(v: number): void { this.bytes.push(v & 0xff); }
  u16(v: number): void { this.u8(v >> 8); this.u8(v); }
  u32(v: number): void { this.u8(v >>> 24); this.u8(v >>> 16); this.u8(v >>> 8); this.u8(v); }
  vlq(v: number): void {
    const parts = [v & 0x7f];
    while ((v >>= 7) > 0) parts.unshift((v & 0x7f) | 0x80);
    for (const p of parts) this.u8(p);
  }
  str(s: string): void { for (const ch of s) this.u8(ch.charCodeAt(0) & 0x7f); }
}

const chunk = (tag: string, body: number[]): number[] => {
  const o = new Out();
  o.str(tag);
  o.u32(body.length);
  return [...o.bytes, ...body];
};

interface TrackEvent {
  tick: number;
  /** Sorted after others at the same tick: note offs before note ons. */
  order: number;
  data: number[];
}

function trackBytes(events: TrackEvent[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const o = new Out();
  let last = 0;
  for (const e of events) {
    o.vlq(e.tick - last);
    last = e.tick;
    for (const b of e.data) o.u8(b);
  }
  o.vlq(0);
  o.u8(0xff); o.u8(0x2f); o.u8(0);
  return chunk('MTrk', o.bytes);
}

const meta = (type: number, data: number[]): number[] => [0xff, type, ...vlqBytes(data.length), ...data];
const vlqBytes = (v: number): number[] => { const o = new Out(); o.vlq(v); return o.bytes; };
const textBytes = (s: string): number[] => [...s].map((c) => c.charCodeAt(0) & 0x7f);

// ---- General MIDI drums --------------------------------------------------------------------------------------------

const GM_DRUM_OUT: Record<string, number> = { k: 36, kick: 36, s: 38, snare: 38, h: 42, hat: 42, oh: 46, hat_open: 46, t: 45, tom: 45, c: 49, crash: 49, cl: 39, clap: 39 };
const GM_DRUM_IN: Record<number, string> = {
  35: 'k', 36: 'k', 41: 'k', 43: 'k', 45: 'k', 47: 'k', 48: 'k', 50: 'k',
  37: 's', 38: 's', 39: 's', 40: 's',
  42: 'h', 44: 'h', 54: 'h', 56: 'h', 69: 'h', 70: 'h', 80: 'h', 81: 'h',
  46: 'oh', 49: 'oh', 51: 'oh', 52: 'oh', 53: 'oh', 55: 'oh', 57: 'oh', 59: 'oh',
};

// ---- export -------------------------------------------------------------------------------------------------------

/** One pattern of a song, or the whole arrangement (intro, body once, ending), as a MIDI file. */
export function exportMidi(song: SongDoc, instances: { pattern: Pattern; t0: number; stepSec: number }[], title: string): Uint8Array {
  const tempoEv: TrackEvent[] = [
    { tick: 0, order: 0, data: meta(0x03, textBytes(title)) },
    { tick: 0, order: 1, data: meta(0x51, [...(() => { const us = Math.round(60e6 / song.tempo); return [(us >> 16) & 255, (us >> 8) & 255, us & 255]; })()]) },
    { tick: 0, order: 2, data: meta(0x58, [song.time[0], Math.round(Math.log2(song.time[1])), 24, 8]) },
  ];
  const tracks: TrackEvent[][] = [tempoEv];
  const drumEvents: TrackEvent[] = [];
  let melodic = 0;
  const drumNames = new Map<string, number>();
  let nextDrum = 60;
  for (const ch of song.channels) {
    if (ch.clips) continue; // an audio channel has recordings, not notes
    const events: TrackEvent[] = [{ tick: 0, order: 0, data: meta(0x03, textBytes(ch.name)) }];
    const isDrum = !!ch.kit;
    let mch = 0;
    if (!isDrum) { mch = melodic === 9 ? 10 : melodic; melodic++; if (mch > 15) continue; }
    for (const inst of instances) {
      const row = inst.pattern.channels.find((c) => c.name === ch.name);
      if (!row) continue;
      const beats0 = (inst.t0 * song.tempo) / 60;
      const tpb = inst.pattern.tpb;
      for (const e of channelEvents(row)) {
        const on = Math.round((beats0 + e.step / tpb) * PPQ);
        const off = Math.max(on + 1, Math.round((beats0 + (e.step + e.len) / tpb) * PPQ));
        if (e.drum !== null) {
          let n = GM_DRUM_OUT[e.drum];
          if (n === undefined) { if (!drumNames.has(e.drum)) drumNames.set(e.drum, nextDrum++); n = drumNames.get(e.drum)!; }
          const ev = on === off ? off + 1 : on + Math.min(off - on, PPQ / 8);
          const vel = Math.max(1, Math.min(127, e.vel));
          drumEvents.push({ tick: on, order: 1, data: [0x99, n, vel] }, { tick: ev, order: 0, data: [0x89, n, 0] });
        } else {
          for (const n of e.notes!) {
            events.push({ tick: on, order: 1, data: [0x90 | mch, n.midi, Math.max(1, Math.min(127, n.vel))] }, { tick: off, order: 0, data: [0x80 | mch, n.midi, 0] });
          }
        }
      }
    }
    if (!isDrum) tracks.push(events);
  }
  if (drumEvents.length) tracks.push([{ tick: 0, order: 0, data: meta(0x03, textBytes('drums')) }, ...drumEvents]);
  const head = new Out();
  head.u16(1); head.u16(tracks.length); head.u16(PPQ);
  return Uint8Array.from([...chunk('MThd', head.bytes), ...tracks.flatMap(trackBytes)]);
}

// ---- import -------------------------------------------------------------------------------------------------------

export interface MidiNote {
  track: number;
  channel: number;
  start: number;
  end: number;
  midi: number;
  vel: number;
}

export interface MidiFile {
  format: number;
  ppq: number;
  tempo: number;
  tempoChanges: number;
  time: [number, number];
  notes: MidiNote[];
  programs: Map<number, number>;
  trackNames: Map<number, string>;
}

class In {
  p = 0;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) { this.b = b; }
  u8(): number { if (this.p >= this.b.length) throw new Error('the MIDI file ends in the middle of an event'); return this.b[this.p++]!; }
  u16(): number { return (this.u8() << 8) | this.u8(); }
  u32(): number { return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0; }
  vlq(): number { let v = 0; for (let i = 0; i < 4; i++) { const c = this.u8(); v = (v << 7) | (c & 0x7f); if (!(c & 0x80)) return v; } throw new Error('a MIDI delta time is longer than 4 bytes'); }
  tag(): string { return String.fromCharCode(this.u8(), this.u8(), this.u8(), this.u8()); }
}

export function parseMidi(bytes: Uint8Array): MidiFile {
  const r = new In(bytes);
  if (bytes.length < 14 || r.tag() !== 'MThd') throw new Error('not a MIDI file (no MThd header)');
  const hl = r.u32();
  const format = r.u16(), ntracks = r.u16(), division = r.u16();
  r.p = 8 + hl;
  if (format > 1) throw new Error(`MIDI type ${format} files (independent sequences) are not supported; use type 0 or 1`);
  if (division & 0x8000) throw new Error('SMPTE time division is not supported (the file counts frames, not beats)');
  const out: MidiFile = { format, ppq: division, tempo: 120, tempoChanges: 0, time: [4, 4], notes: [], programs: new Map(), trackNames: new Map() };
  let gotTempo = false, gotTime = false;
  for (let t = 0; t < ntracks; t++) {
    if (r.p >= bytes.length) break;
    const tag = r.tag();
    const len = r.u32();
    const end = Math.min(bytes.length, r.p + len);
    if (tag !== 'MTrk') { r.p = end; t--; continue; }
    let tick = 0, status = 0;
    const open = new Map<string, { start: number; vel: number }[]>();
    while (r.p < end) {
      tick += r.vlq();
      let s = r.b[r.p]!;
      if (s & 0x80) { r.p++; status = s; } else s = status;
      if (s === 0xff) {
        const type = r.u8(), l = r.vlq();
        const data = Array.from({ length: l }, () => r.u8());
        if (type === 0x51 && l === 3) {
          const bpm = 60e6 / ((data[0]! << 16) | (data[1]! << 8) | data[2]!);
          if (!gotTempo) { out.tempo = Math.round(bpm * 1000) / 1000; gotTempo = true; } else if (Math.abs(bpm - out.tempo) > 0.01) out.tempoChanges++;
        } else if (type === 0x58 && l >= 2 && !gotTime) { out.time = [data[0]!, 2 ** data[1]!]; gotTime = true; }
        else if (type === 0x03) out.trackNames.set(t, String.fromCharCode(...data));
      } else if (s === 0xf0 || s === 0xf7) { const l = r.vlq(); r.p += l; }
      else {
        const kind = s >> 4, ch = s & 15;
        const a = r.u8();
        const b = kind === 0xc || kind === 0xd ? 0 : r.u8();
        if (kind === 0xc && !out.programs.has(ch)) out.programs.set(ch, a);
        const key = `${ch}:${a}`;
        if (kind === 0x9 && b > 0) { const st = open.get(key) ?? []; st.push({ start: tick, vel: b }); open.set(key, st); }
        else if (kind === 0x8 || (kind === 0x9 && b === 0)) {
          const st = open.get(key);
          const n = st?.shift();
          if (n) out.notes.push({ track: t, channel: ch, start: n.start, end: Math.max(n.start + 1, tick), midi: a, vel: n.vel });
        }
      }
    }
    for (const [key, st] of open) for (const n of st) out.notes.push({ track: t, channel: Number(key.split(':')[0]), start: n.start, end: Math.max(tick, n.start + 1), midi: Number(key.split(':')[1]), vel: n.vel });
    r.p = end;
  }
  out.notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
  return out;
}

const GRIDS = [4, 2, 8, 3, 6, 12, 24];

function bestGrid(notes: readonly MidiNote[], ppq: number): number {
  let best = 4, bestErr = Infinity;
  for (const tpb of GRIDS) {
    const g = ppq / tpb;
    let err = 0;
    for (const n of notes) err += Math.abs(n.start - Math.round(n.start / g) * g) / g;
    err /= Math.max(1, notes.length);
    if (err < bestErr - 1e-9) { bestErr = err; best = tpb; }
  }
  return best;
}

function instrumentForProgram(p: number): string {
  if (p >= 32 && p <= 39) return 'triangle_bass';
  if ((p >= 48 && p <= 55) || (p >= 88 && p <= 103)) return 'saw_pad';
  if ((p >= 8 && p <= 15) || (p >= 112 && p <= 119)) return 'fm_bell';
  if ((p >= 24 && p <= 31) || (p >= 40 && p <= 47) || (p >= 104 && p <= 111)) return 'pluck';
  if (p >= 80 && p <= 87) return 'pulse_lead';
  return 'square_lead';
}

const clean = (s: string, fallback: string): string => {
  const t = s.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]+/, '');
  return (t || fallback).slice(0, 20);
};

export interface MidiImport {
  script: string;
  /** What was done, one line each (lanes dropped, tempo changes ignored, rounding). */
  notes: string[];
  tpb: number;
  patterns: number;
  channels: string[];
}

/** A command script that makes a song of this MIDI file. `barsPerPattern` bars go in each pattern. */
export function midiToScript(bytes: Uint8Array, songId: string, o: { barsPerPattern?: number } = {}): MidiImport {
  const m = parseMidi(bytes);
  if (!m.notes.length) throw new Error('the MIDI file has no notes');
  const notes: string[] = [];
  if (m.tempoChanges) notes.push(`${m.tempoChanges} tempo change${m.tempoChanges === 1 ? '' : 's'} after the start ignored (the song has one tempo: ${m.tempo} bpm)`);
  const tpb = bestGrid(m.notes, m.ppq);
  const gridTicks = m.ppq / tpb;
  const beatsPerBar = (m.time[0] * 4) / m.time[1];
  const stepsPerBar = Math.round(beatsPerBar * tpb);
  const bars = o.barsPerPattern ?? 2;
  const patSteps = stepsPerBar * bars;
  const lastStep = Math.max(...m.notes.map((n) => Math.round(n.end / gridTicks)));
  const nChunks = Math.max(1, Math.ceil(lastStep / patSteps));
  // parts: a MIDI channel in a track; drums are channel 10 (index 9)
  const keys = [...new Set(m.notes.map((n) => `${n.track}:${n.channel}`))];
  interface Part { name: string; drum: boolean; inst: string; notes: MidiNote[] }
  const parts: Part[] = [];
  const used = new Set<string>();
  const uniq = (base: string): string => { let n = base, k = 2; while (used.has(n.toLowerCase())) n = `${base}${k++}`; used.add(n.toLowerCase()); return n; };
  for (const key of keys) {
    const [t, c] = key.split(':').map(Number) as [number, number];
    const ns = m.notes.filter((n) => n.track === t && n.channel === c);
    const drum = c === 9;
    const name = uniq(drum ? 'drums' : clean(m.trackNames.get(t) ?? '', `ch${c + 1}`));
    parts.push({ name, drum, inst: drum ? '' : instrumentForProgram(m.programs.get(c) ?? 0), notes: ns });
  }
  // lanes: one row per monophonic line (chords are notes with the same start and length)
  interface Lane { name: string; drum: boolean; inst: string; events: { step: number; len: number; midis: { midi: number; vel: number }[]; drum?: string }[] }
  const lanes: Lane[] = [];
  for (const p of parts) {
    const q = p.notes.map((n) => ({ ...n, step: Math.round(n.start / gridTicks), len: Math.max(1, Math.round((n.end - n.start) / gridTicks)) }));
    if (p.drum) {
      const evs = new Map<string, { step: number; len: number; midis: { midi: number; vel: number }[]; drum: string }>();
      for (const n of q) {
        const d = GM_DRUM_IN[n.midi] ?? 'h';
        const k = `${n.step}:${d}`;
        if (!evs.has(k)) evs.set(k, { step: n.step, len: 1, midis: [{ midi: n.midi, vel: n.vel }], drum: d });
      }
      // one lane per overlapping hit at a step (two different drums at once need two rows)
      const rows: Lane[] = [];
      for (const e of [...evs.values()].sort((a, b) => a.step - b.step)) {
        let row = rows.find((r) => !r.events.some((x) => x.step === e.step));
        if (!row) { row = { name: rows.length ? uniq(`${p.name}${rows.length + 1}`) : p.name, drum: true, inst: '', events: [] }; rows.push(row); }
        row.events.push(e);
      }
      lanes.push(...rows);
      continue;
    }
    const chords = new Map<string, { step: number; len: number; midis: { midi: number; vel: number }[] }>();
    for (const n of q) {
      const k = `${n.step}:${n.len}`;
      const c = chords.get(k) ?? { step: n.step, len: n.len, midis: [] };
      if (!c.midis.some((x) => x.midi === n.midi)) c.midis.push({ midi: n.midi, vel: n.vel });
      chords.set(k, c);
    }
    const rows: Lane[] = [];
    for (const e of [...chords.values()].sort((a, b) => a.step - b.step || b.len - a.len)) {
      let row = rows.find((r) => { const last = r.events[r.events.length - 1]; return !last || last.step + last.len <= e.step; });
      if (!row) {
        if (rows.length >= 4) { notes.push(`${p.name}: more than 4 overlapping lines; a note at step ${e.step} was dropped`); continue; }
        row = { name: rows.length ? uniq(`${p.name}${rows.length + 1}`) : p.name, drum: false, inst: p.inst, events: [] };
        rows.push(row);
      }
      row.events.push(e);
    }
    lanes.push(...rows);
  }
  if (lanes.length > 16) { notes.push(`${lanes.length} lines; the first 16 kept`); lanes.length = 16; }
  // patterns by chunk
  const names: string[] = [];
  const byText = new Map<string, string>();
  const patterns: { name: string; pattern: Pattern }[] = [];
  const order: string[] = [];
  for (let c = 0; c < nChunks; c++) {
    const rows = lanes.map((lane) => {
      const cells: Cell[] = Array.from({ length: patSteps }, () => ({ kind: 'rest' }) as Cell);
      for (const e of lane.events) {
        const local = e.step - c * patSteps;
        if (local < 0 || local >= patSteps) continue;
        if (lane.drum) { cells[local] = { kind: 'drum', drum: e.drum!, vel: e.midis[0]!.vel }; continue; }
        const pn: PNote[] = e.midis.sort((a, b) => a.midi - b.midi).map((x) => ({ midi: x.midi, vel: x.vel, fx: {} }));
        cells[local] = { kind: 'notes', notes: pn };
        for (let s = 1; s < e.len && local + s < patSteps; s++) cells[local + s] = { kind: 'hold' };
      }
      return { name: lane.name, cells };
    });
    const p: Pattern = { name: 'tmp', steps: patSteps, tpb, bar: stepsPerBar < patSteps ? stepsPerBar : null, channels: rows };
    const text = formatPattern({ ...p, name: 'x' });
    let nm = byText.get(text);
    if (!nm) { nm = `p${patterns.length + 1}`; byText.set(text, nm); patterns.push({ name: nm, pattern: { ...p, name: nm } }); }
    order.push(nm);
  }
  void names;
  const lines = [`song new ${songId} tempo=${m.tempo} time=${m.time[0]}/${m.time[1]}`];
  for (const lane of lanes) lines.push(`song channel add ${songId} ${lane.name} ${lane.drum ? 'kit=default' : `inst=${lane.inst}`}${lane.drum ? ' layer=base' : ''}`);
  for (const p of patterns) {
    const text = formatPattern(p.pattern).split('\n');
    lines.push(`pattern ${songId}.${p.name} ${text[0]!.replace(/^pattern \S+ /, '')}`);
    lines.push(...text.slice(1).filter(Boolean));
  }
  lines.push(`song section add ${songId} main ${order.join(' ')}`);
  void noteLabel; void stepSeconds; void DEFAULT_KIT;
  return { script: lines.join('\n') + '\n', notes, tpb, patterns: patterns.length, channels: lanes.map((l) => l.name) };
}

/** A song (or one of its patterns) as a MIDI file. */
export function songToMidi(song: SongDoc, pattern?: string): Uint8Array {
  if (pattern) {
    const p = song.patterns.get(pattern);
    if (!p) throw new Error(`song ${song.id} has no pattern '${pattern}' (patterns: ${[...song.patterns.keys()].join(', ') || 'none'})`);
    return exportMidi(song, [{ pattern: p, t0: 0, stepSec: stepSeconds(song.tempo, p.tpb) }], `${song.id}.${pattern}`);
  }
  return exportMidi(song, arrange(song).instances, song.id);
}
