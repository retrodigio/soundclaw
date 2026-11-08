// What the song page draws, worked out from the song document, the server's report and the tape:
// the tracks grouped by layer, the clips with their note sketches, the check flags on lanes and
// bars, which patterns and parameters the agent changed and nobody has approved, and where the
// tokens of the pattern text are. Pure functions (no React, no DOM), so unit tests read them.

import {
  activeGroups, channelEvents, layerOrder, parseCellText, parsePattern, formatPattern, quote,
  type Arrangement, type Channel, type Instance, type Pattern, type SongDoc, type TapeEntry,
} from '@soundclaw/core';

// ---- tracks ---------------------------------------------------------------------------------------------------------

export interface TrackGroup { layer: string; index: number; channels: Channel[] }

/** The channels grouped by game layer (stem), the layers in the order they stack. */
export function trackGroups(song: SongDoc): TrackGroup[] {
  return layerOrder(song).map((layer, index) => ({ layer, index, channels: song.channels.filter((c) => c.layer === layer) }));
}

/** A channel's colour: one of the eight layer-palette tokens, by its place in the song. */
export function channelColour(song: SongDoc, name: string): string {
  const i = song.channels.findIndex((c) => c.name === name);
  return `var(--layer-${(Math.max(0, i) % 8) + 1})`;
}

/** The layers that sound at an intensity: the base up to the layer at that place (null: all of them). */
export function layersAt(song: SongDoc, level: number | null): Set<string> {
  const order = layerOrder(song);
  return new Set(level === null ? order : order.slice(0, level + 1));
}

// ---- clips ----------------------------------------------------------------------------------------------------------

export interface SketchNote { x: number; w: number; y: number }

export interface Clip {
  key: string;
  channel: string;
  pattern: string;
  section: string;
  pass: number;
  instance: number;
  t0: number;
  dur: number;
  part: Instance['part'];
  inLoop: boolean;
  notes: SketchNote[];
}

/** Each placement of a pattern in which the channel plays something, with a sketch of its notes (x and width as fractions of the clip, y from the top). */
export function clipsOf(arr: Arrangement, channel: string): Clip[] {
  const out: Clip[] = [];
  for (const inst of arr.instances) {
    const row = inst.pattern.channels.find((c) => c.name === channel);
    if (!row) continue;
    const ev = channelEvents(row);
    if (!ev.length) continue;
    const steps = inst.pattern.steps;
    const mids = ev.flatMap((e) => e.notes?.map((n) => n.midi) ?? []);
    const lo = mids.length ? Math.min(...mids) : 0, hi = mids.length ? Math.max(...mids) : 0;
    const words = [...new Set(ev.flatMap((e) => (e.drum ? [e.drum] : [])))].sort();
    const notes: SketchNote[] = ev.flatMap((e) => (e.notes
      ? e.notes.map((n) => ({ x: e.step / steps, w: Math.max(e.len / steps, 0.012), y: hi === lo ? 0.5 : 1 - (n.midi - lo) / (hi - lo) }))
      : [{ x: e.step / steps, w: Math.max(1 / steps, 0.012), y: words.length < 2 ? 0.5 : words.indexOf(e.drum!) / (words.length - 1) }]));
    out.push({ key: `${channel}/${inst.index}`, channel, pattern: inst.pattern.name, section: inst.section, pass: inst.pass, instance: inst.index, t0: inst.t0, dur: inst.dur, part: inst.part, inLoop: inst.inLoop, notes });
  }
  return out;
}

/** Seconds in a bar. */
export const barSeconds = (song: SongDoc): number => (song.time[0] * (4 / song.time[1]) * 60) / song.tempo;

/** The sections as spans of the arrangement, in the order they play. */
export interface SectionSpan { name: string; start: number; end: number; part: Instance['part']; repeat: number; inLoop: boolean }
export function sectionSpans(song: SongDoc, arr: Arrangement): SectionSpan[] {
  const out: SectionSpan[] = [];
  for (const sec of song.sections) {
    const ins = arr.instances.filter((i) => i.section === sec.name);
    if (!ins.length) continue;
    out.push({ name: sec.name, start: ins[0]!.t0, end: ins[ins.length - 1]!.t0 + ins[ins.length - 1]!.dur, part: ins[0]!.part, repeat: sec.repeat, inLoop: ins.some((i) => i.inLoop) });
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---- the server's report and the flags it draws ---------------------------------------------------------------------

export interface ReportRange { from: number; to: number; note: string; channel?: string; channels?: [string, string]; band?: string }
export interface ReportCheck { name: string; pass: boolean; advisory: boolean; skipped: boolean; score?: number | null; value: string; threshold?: string; ranges?: ReportRange[] }
export interface SongReport {
  id: string;
  playable: boolean;
  problem?: string;
  pass?: boolean;
  numbers?: {
    length: number; loopLength: number | null; tempo: number; time: string; key: string | null; lufs: number | null; truePeakDb: number | null;
    layers: string[]; class: string; target?: number; tolerance?: number; masterReductionDb?: number | null; loudnessRange?: number | null;
    channels?: { name: string; layer: string; lufs: number | null; peakDb: number | null; notes: number }[];
  };
  checks?: ReportCheck[];
}

export interface MaskLink { a: string; b: string; band: string; from: number; to: number; seconds: number; note: string }

/** The pairs of channels the masking check names, each with its longest stretch. */
export function maskLinks(report: SongReport | null): MaskLink[] {
  const c = report?.checks?.find((x) => x.name === 'masking');
  if (!c || c.skipped) return [];
  const best = new Map<string, MaskLink>();
  for (const r of c.ranges ?? []) {
    if (!r.channels) continue;
    const [a, b] = r.channels;
    const key = [a, b].sort().join('|');
    const secs = r.to - r.from;
    const cur = best.get(key);
    if (!cur || secs > cur.seconds) best.set(key, { a, b, band: r.band ?? '', from: r.from, to: r.to, seconds: secs, note: r.note });
  }
  return [...best.values()];
}

/** The bars a stretch touches, counted from 1. A frame's worth of slack at both ends keeps a stretch that starts just before a bar line out of the bar before. */
export function barsOf(from: number, to: number, barSec: number, nBars?: number): { first: number; last: number; text: string } {
  const slack = 0.06;
  let first = Math.floor((from + slack) / barSec) + 1;
  let last = Math.max(first, Math.ceil((to - slack) / barSec));
  if (nBars !== undefined) { first = Math.min(first, nBars); last = Math.min(Math.max(last, first), nBars); }
  return { first, last, text: last > first ? `bars ${first}–${last}` : `bar ${first}` };
}

export interface LaneFlag {
  id: string;
  check: string;
  /** The lanes it sits on. */
  lanes: string[];
  from: number;
  to: number;
  kind: 'masking' | 'check';
  label: string;
  note: string;
}

/** The checks that name a stretch and a lane: masking (two lanes), and any other failing check whose range names a channel. */
export function laneFlags(report: SongReport | null, barSec: number, nBars?: number): LaneFlag[] {
  const out: LaneFlag[] = [];
  for (const c of report?.checks ?? []) {
    if (c.skipped || (c.pass && c.name !== 'masking')) continue;
    (c.ranges ?? []).forEach((r, n) => {
      const bars = barsOf(r.from, r.to, barSec, nBars).text;
      if (c.name === 'masking' && r.channels) {
        out.push({ id: `masking-${r.channels[0]}-${r.channels[1]}-${n}`, check: c.name, lanes: [...r.channels], from: r.from, to: r.to, kind: 'masking', label: `masking: ${r.channels[0]} over ${r.channels[1]}${r.band ? `, ${r.band}` : ''}, ${bars}`, note: r.note });
      } else if (r.channel && c.name !== 'masking') {
        out.push({ id: `${c.name}-${r.channel}-${n}`, check: c.name, lanes: [r.channel], from: r.from, to: r.to, kind: 'check', label: `${c.name}, ${bars}`, note: r.note });
      }
    });
  }
  return out;
}

/** Checks that fail or warn, for the arrangement's count. */
export const flaggedChecks = (report: SongReport | null): ReportCheck[] => (report?.checks ?? []).filter((c) => !c.skipped && !c.pass);

/** The loop seam, as a badge: the check's verdict and the level step it measured. */
export function seamOf(report: SongReport | null): { pass: boolean; text: string } | null {
  const c = report?.checks?.find((x) => x.name === 'loop-music');
  if (!c || c.skipped) return null;
  const step = /level step (-?[\d.]+) dB/.exec(c.value)?.[1];
  return { pass: c.pass, text: `seam${step ? ` ${Number(step) > 0 ? '+' : Number(step) < 0 ? '−' : ''}${Math.abs(Number(step)).toFixed(1)} dB` : ''}` };
}

// ---- who wrote it: the tape --------------------------------------------------------------------------------------------

const isHuman = (by: string): boolean => by.startsWith('human:');
const unquote = (s: string): string => s.slice(1, -1).replace(/\\(n|"|\\)/g, (_, c: string) => (c === 'n' ? '\n' : c));
const words = (s: string): string[] => s.trim().split(/\s+/);

export interface PatternAuthors {
  /** `pattern/channel` rows the agent last changed, with no approval or person's edit since. */
  rows: Set<string>;
  /** Patterns with at least one such row. */
  patterns: Set<string>;
  /** The tape number of the latest approval. */
  approvedSeq: number;
  /** The newest tape number that touched each pattern. */
  touched: Map<string, number>;
}

const HELPERS = new Set(['chords', 'bass', 'arp', 'drums', 'humanise']);

/**
 * Which pattern rows were last written by the agent and not approved. A row is the agent's when the
 * latest command that changed it was the agent's, and neither `song mark … approved` nor a person's
 * edit of that row came after. Undone commands do not count.
 */
export function patternAuthors(tape: readonly TapeEntry[], songId: string): PatternAuthors {
  const live = activeGroups(tape);
  const last = new Map<string, { agent: boolean; seq: number }>();
  const text = new Map<string, string>();
  const touched = new Map<string, number>();
  let approvedSeq = -1;
  const mark = (pattern: string, channel: string, e: TapeEntry): void => {
    last.set(`${pattern}/${channel}`, { agent: !isHuman(e.by), seq: e.seq });
    touched.set(pattern, e.seq);
  };
  const names = (p: string): string[] => [...last.keys()].filter((k) => k.startsWith(`${p}/`)).map((k) => k.slice(p.length + 1));
  for (const e of tape) {
    if (!live.has(e.group)) continue;
    const cmd = e.cmd;
    let m = /^song mark (\S+) approved\b/.exec(cmd);
    if (m) { if (m[1] === songId) approvedSeq = e.seq; continue; }
    m = /^pattern set ([A-Za-z][\w-]*)\.([A-Za-z][\w-]*) ("[\s\S]*")\s*$/.exec(cmd);
    if (m) {
      if (m[1] !== songId) continue;
      const pat = m[2]!;
      const parsed = parsePattern(unquote(m[3]!), pat).pattern;
      if (!parsed) continue;
      const seen = new Set<string>();
      for (const row of parsed.channels) {
        const t = row.cells.map((c) => JSON.stringify(c)).join(' ');
        seen.add(row.name);
        // only a row whose cells differ from what the tape last said about it counts as this author's
        if (text.get(`${pat}/${row.name}`) !== t || !last.has(`${pat}/${row.name}`)) mark(pat, row.name, e);
        text.set(`${pat}/${row.name}`, t);
      }
      for (const k of names(pat)) if (!seen.has(k)) { last.delete(`${pat}/${k}`); text.delete(`${pat}/${k}`); }
      touched.set(pat, e.seq);
      continue;
    }
    m = /^pattern note \S+ ([A-Za-z][\w-]*)\.([A-Za-z][\w-]*) (\S+)/.exec(cmd);
    if (m) { if (m[1] === songId) { mark(m[2]!, m[3]!, e); text.delete(`${m[2]}/${m[3]}`); } continue; }
    m = /^pattern copy ([A-Za-z][\w-]*)\.([A-Za-z][\w-]*) (\S+)/.exec(cmd);
    if (m) {
      if (m[1] !== songId) continue;
      const to = m[3]!.includes('.') ? m[3]!.split('.')[1]! : m[3]!;
      for (const k of names(m[2]!)) mark(to, k, e);
      touched.set(to, e.seq);
      continue;
    }
    m = /^pattern rename ([A-Za-z][\w-]*)\.([A-Za-z][\w-]*) (\S+)/.exec(cmd);
    if (m) {
      if (m[1] !== songId) continue;
      const to = m[3]!.includes('.') ? m[3]!.split('.')[1]! : m[3]!;
      for (const k of names(m[2]!)) { last.set(`${to}/${k}`, last.get(`${m[2]}/${k}`)!); last.delete(`${m[2]}/${k}`); const t = text.get(`${m[2]}/${k}`); if (t !== undefined) text.set(`${to}/${k}`, t); text.delete(`${m[2]}/${k}`); }
      continue;
    }
    m = /^pattern remove ([A-Za-z][\w-]*)\.([A-Za-z][\w-]*)/.exec(cmd);
    if (m) { if (m[1] === songId) for (const k of names(m[2]!)) { last.delete(`${m[2]}/${k}`); text.delete(`${m[2]}/${k}`); } continue; }
    const w = words(cmd.split('\n')[0]!);
    if (HELPERS.has(w[0]!) && w[1] === songId && w[2] && w[3]) {
      const chans = w[3] === 'all' ? names(w[2]) : w[3].split(',');
      for (const c of chans) { mark(w[2], c, e); text.delete(`${w[2]}/${c}`); }
      continue;
    }
    if (w[0] === 'motif' && w[1] === 'write' && w[2] === songId && w[4] && w[5]) { mark(w[4], w[5], e); text.delete(`${w[4]}/${w[5]}`); }
  }
  const rows = new Set<string>(), patterns = new Set<string>();
  for (const [k, v] of last) if (v.agent && v.seq > approvedSeq) { rows.add(k); patterns.add(k.slice(0, k.indexOf('/'))); }
  return { rows, patterns, approvedSeq, touched };
}

export interface ParamTrail { by: 'agent' | 'you'; seq: number; value: number; prev: number | null }

/**
 * The latest change to each mixer parameter, for the agent tick. Keys: `<channel>.gain|pan|reverb|delay`,
 * `bus.<reverb|delay>.<param>`, `master.<k>.<param>` (the chain's k-th effect), `song.gain`. Only
 * parameters whose latest change is the agent's, with no approval or person's edit since, are listed.
 */
export function paramTrails(tape: readonly TapeEntry[], songId: string): Map<string, ParamTrail> {
  const live = activeGroups(tape);
  const hist = new Map<string, { by: 'agent' | 'you'; seq: number; value: number }[]>();
  let approvedSeq = -1;
  const push = (key: string, e: TapeEntry, value: number): void => {
    if (!Number.isFinite(value)) return;
    const h = hist.get(key) ?? [];
    h.push({ by: isHuman(e.by) ? 'you' : 'agent', seq: e.seq, value });
    hist.set(key, h);
  };
  const pairs = (ws: string[]): [string, number][] => ws.flatMap((x) => { const m = /^([a-z]\w*)=(-?[\d.]+)$/.exec(x); return m ? [[m[1]!, Number(m[2])] as [string, number]] : []; });
  for (const e of tape) {
    if (!live.has(e.group)) continue;
    const w = words(e.cmd.split('\n')[0]!);
    if (w[0] !== 'song') continue;
    if (w[1] === 'mark' && w[2] === songId && w[3] === 'approved') { approvedSeq = e.seq; continue; }
    if ((w[1] === 'channel' && (w[2] === 'set' || w[2] === 'add')) && w[3] === songId && w[4]) {
      for (const [k, v] of pairs(w.slice(5))) if (['gain', 'pan', 'reverb', 'delay'].includes(k)) push(`${w[4]}.${k}`, e, v);
    } else if (w[1] === 'send' && w[2] === songId && w[3]) {
      for (const [k, v] of pairs(w.slice(4))) push(`bus.${w[3]}.${k}`, e, v);
    } else if (w[1] === 'fx' && w[2] === 'set' && w[3] === songId && w[4]) {
      for (const [k, v] of pairs(w.slice(5))) push(`master.${w[4]}.${k}`, e, v);
    } else if (w[1] === 'set' && w[2] === songId) {
      for (const [k, v] of pairs(w.slice(3))) if (k === 'gain') push('song.gain', e, v);
    }
  }
  const out = new Map<string, ParamTrail>();
  for (const [key, h] of hist) {
    const l = h[h.length - 1]!;
    if (l.by !== 'agent' || l.seq <= approvedSeq) continue;
    out.set(key, { ...l, prev: h.length > 1 ? h[h.length - 2]!.value : null });
  }
  return out;
}

// ---- the pattern text ---------------------------------------------------------------------------------------------------

export interface TextToken { line: number; col: number; len: number; step: number; channel: string; text: string }

/** Where each step's token sits in the text: grid rows by position (a `|` only splits bars), note-list rows by their `step:` prefix. */
export function textTokens(text: string): TextToken[] {
  const out: TextToken[] = [];
  text.split('\n').forEach((src, line) => {
    const m = /^(\s*)([A-Za-z][A-Za-z0-9_]*)\s*([:=])/.exec(src);
    if (!m) return;
    const hash = /(^|\s)#/.exec(src.slice(m[0].length));
    const end = hash ? m[0].length + hash.index : src.length;
    const body = src.slice(m[0].length, end);
    let step = 0;
    for (const t of body.matchAll(/\S+/g)) {
      const col = m[0].length + t.index!;
      if (m[3] === ':') {
        if (t[0] === '|') continue;
        out.push({ line, col, len: t[0].length, step, channel: m[2]!, text: t[0] });
        step++;
      } else {
        const at = /^(\d+):/.exec(t[0]);
        if (at) out.push({ line, col, len: t[0].length, step: Number(at[1]), channel: m[2]!, text: t[0].slice(at[0].length) });
      }
    }
  });
  return out;
}

/** The pitches a token writes (empty for a rest, a hold or a drum hit). */
export function tokenMidis(text: string): number[] {
  try {
    const c = parseCellText(text.replace(/\*\d+$/, ''));
    return c.kind === 'notes' ? c.notes.map((n) => n.midi) : [];
  } catch { return []; }
}

/** The tokens of a channel's row that hold the selected notes (keys are `step:midi`). */
export function selectedTokens(tokens: readonly TextToken[], channel: string, selected: ReadonlySet<string>): TextToken[] {
  if (!selected.size) return [];
  return tokens.filter((t) => t.channel === channel && tokenMidis(t.text).some((m) => selected.has(`${t.step}:${m}`)));
}

/** The note keys of the tokens a text range touches in a channel's row. */
export function notesAt(tokens: readonly TextToken[], channel: string, offsets: { line: number; col: number }[]): Set<string> {
  const keys = new Set<string>();
  const [a, b] = offsets as [{ line: number; col: number }, { line: number; col: number }];
  for (const t of tokens) {
    if (t.channel !== channel) continue;
    const start = t.line * 1e6 + t.col, end = start + t.len;
    const s = a.line * 1e6 + a.col, e = b.line * 1e6 + b.col;
    if (e < start || s > end) continue;
    for (const m of tokenMidis(t.text)) keys.add(`${t.step}:${m}`);
  }
  return keys;
}

/** The line and column (0-based) of an offset in a text. */
export function lineCol(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, offset);
  const line = before.split('\n').length - 1;
  return { line, col: offset - (before.lastIndexOf('\n') + 1) };
}
/** The offset of a line and column, clamped to the text. */
export function offsetOf(text: string, line: number, col: number): number {
  const ls = text.split('\n');
  const l = Math.min(line, ls.length - 1);
  let off = 0;
  for (let i = 0; i < l; i++) off += ls[i]!.length + 1;
  return off + Math.min(col, ls[l]!.length);
}

export interface TextEdit {
  /** `pattern set …`, or null when the text means what the pattern already is. */
  cmd: string | null;
  /** The pattern the text means (null: it does not parse). */
  pattern: Pattern | null;
  errors: { line: number; col: number; message: string }[];
}

/** What a pattern text means: the same `pattern set` command an agent would write, or the first problem. Nothing is written for a text that does not parse. */
export function textEdit(songId: string, current: Pattern, text: string): TextEdit {
  const r = parsePattern(text, current.name);
  if (r.errors.length || !r.pattern) return { cmd: null, pattern: null, errors: r.errors };
  const p: Pattern = { ...r.pattern, name: current.name };
  const same = formatPattern(p) === formatPattern(current);
  return { cmd: same ? null : `pattern set ${songId}.${current.name} ${quote(formatPattern(p))}`, pattern: p, errors: [] };
}

/** The line a channel's row sits on in a pattern text, by channel name. */
export const rowLines = (text: string): Map<string, number> => {
  const out = new Map<string, number>();
  text.split('\n').forEach((src, i) => { const m = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*[:=]/.exec(src); if (m && !out.has(m[1]!)) out.set(m[1]!, i); });
  return out;
};
