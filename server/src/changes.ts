// `changes`: what other hands (people, usually) did to the sounds, songs and instruments since an agent last looked.
// Each group on the tape after the agent's cursor is shown with the parameters before and after,
// the numbers before and after, and a before/after compare view saved as a PNG; for a song, the
// notes that went and came in each pattern and a before/after view of the written notes. The cursor is
// kept per agent in the project (.cache/changes-seen.json, ignored by git), the way `await`
// remembers what an agent has seen.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTHOR_RE, TIMED_CHECKS, songToJson, type SongJson, type CheckResult, CLASSIC_FIELDS, TONE_PARAMS, WAVE_NAMES, activeGroups, compareView, groupsOf, patternChangeView, patternNoteDiff, replay, serializeInstrument, serializeSong, serializeSound, songText, type Library, type SongDoc, type Sound, type TapeEntry } from '@soundclaw/core';
import { ProjectError } from './project.ts';
import type { Review, ReviewCheck, ReviewRow, ReviewSide } from './protocol.ts';

export type { Review, ReviewCheck, ReviewRow, ReviewSide };
import { readRequests } from './requests.ts';
import type { Writer } from './writer.ts';

export const CHANGES_FILE = join('.cache', 'changes-seen.json');

/** The most changes shown in detail (the newest); older ones are counted. */
export const MAX_DETAILED = 12;

type Cursors = Record<string, number>;

function readCursors(w: Writer): Cursors {
  const f = join(w.project.dir, CHANGES_FILE);
  if (!existsSync(f)) return {};
  try {
    const v = JSON.parse(readFileSync(f, 'utf8')) as Cursors;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function writeCursor(w: Writer, agent: string, seq: number): void {
  const c = readCursors(w);
  c[agent] = seq;
  const f = join(w.project.dir, CHANGES_FILE);
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, JSON.stringify(c, null, 2) + '\n');
}

/** The tape number an agent has looked up to (0: never). */
export function changesCursor(w: Writer, agent: string): number {
  return readCursors(w)[agent] ?? 0;
}

export interface ChangesOptions {
  /** The agent asking: `agent:<name>`. Its own groups are left out unless `by` names it. */
  agent: string;
  /** A command number or a time; with it the agent's cursor is neither read nor moved. */
  since?: string;
  /** `human`, `agent`, or one author (`human:ana`); default: everyone but the asking agent. */
  by?: string;
  /** Look without moving the cursor. */
  peek?: boolean;
}

export interface SoundChange {
  id: string;
  /** `new`, `removed` or `edited`. */
  kind: 'new' | 'removed' | 'edited';
  /** `name old → new` lines. */
  params: string[];
  /** The numbers before and after, as text (empty for a new or removed sound). */
  numbers: string[];
  /** The compare view PNG, when both sides exist. */
  view: string | null;
}

export interface SongChange {
  id: string;
  kind: 'new' | 'removed' | 'edited';
  /** The song's settings, channels and sections that differ: `− line` then `+ line`. */
  settings: string[];
  /** Per pattern, the notes that went and came (`verse.lead: − C5 at 4; + E5 at 6 (2 steps)`). */
  notes: string[];
  /** The written notes before and after, one PNG per changed pattern (at most three). */
  views: string[];
}

export interface GroupChange {
  group: string;
  first: number;
  last: number;
  by: string;
  at?: string;
  commands: string[];
  /** The group is out of effect now (undone later). */
  undone: boolean;
  sounds: SoundChange[];
  songs: SongChange[];
  /** Instruments made, removed or changed: `− line` then `+ line` of their files. */
  instruments: { id: string; kind: 'new' | 'removed' | 'edited'; lines: string[] }[];
}

function lineDiff(a: string, b: string, max = 14): string[] {
  const la = a.split('\n').filter(Boolean), lb = b.split('\n').filter(Boolean);
  const had = new Set(la), has = new Set(lb);
  const lines = [...la.filter((l) => !has.has(l)).map((l) => `− ${l.trim()}`), ...lb.filter((l) => !had.has(l)).map((l) => `+ ${l.trim()}`)];
  return [...lines.slice(0, max), ...(lines.length > max ? [`… ${lines.length - max} more lines differ`] : [])];
}

/** What a group did to a song: its settings, the notes of each pattern, and a before/after view of the patterns whose notes changed. */
function songChange(w: Writer, id: string, a: SongDoc | undefined, b: SongDoc | undefined, group: string): SongChange {
  const kind = !a ? 'new' : !b ? 'removed' : 'edited';
  const sc: SongChange = { id, kind, settings: [], notes: [], views: [] };
  if (!a || !b) return sc;
  sc.settings = lineDiff(serializeSong(a), serializeSong(b));
  const names = [...new Set([...a.patterns.keys(), ...b.patterns.keys()])];
  for (const n of names) {
    const pa = a.patterns.get(n), pb = b.patterns.get(n);
    if (!pa) { sc.notes.push(`${n}: new pattern (${pb!.steps} steps)`); }
    else if (!pb) { sc.notes.push(`${n}: removed`); continue; }
    const d = patternNoteDiff(pa, pb);
    if (!d.length) continue;
    if (pa) sc.notes.push(...d.map((x) => `${n}.${x}`));
    if (sc.views.length < 3) {
      const img = patternChangeView(pa, pb, `${id}.${n} before and after ${group}`);
      const file = join(w.project.dir, '.cache', 'views', `change-${group}-${id}-${n}.png`);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, img.png);
      sc.views.push(file);
    }
  }
  return sc;
}

export interface ChangesResult {
  changes: GroupChange[];
  /** Groups after the cursor that matched but are older than the detailed ones. */
  omitted: number;
  /** Where the agent had looked up to, and where it has now. */
  from: number;
  cursor: number;
  explicit: boolean;
}

function matchesAuthor(by: string, filter: string | undefined, agent: string): boolean {
  if (!filter) return by !== agent;
  if (filter === 'human' || filter === 'agent') return by.startsWith(`${filter}:`);
  return by === filter;
}

/** The tape's seq to start after: a number is a command number; anything else is a time (UTC). */
function sinceSeq(entries: readonly TapeEntry[], since: string): number {
  if (/^#?\d+$/.test(since)) return Number(since.replace('#', ''));
  const t = Date.parse(since);
  if (Number.isNaN(t)) throw new ProjectError(`--since is a command number (like 14) or a time (like 2026-11-06T10:00:00Z), not '${since}'`);
  let last = 0;
  for (const e of entries) {
    if (e.at && Date.parse(e.at) <= t) last = e.seq;
  }
  return last;
}

const num = (v: number, d = 1): string => (Number.isFinite(v) ? v.toFixed(d) : '−∞');

function paramLines(a: Sound | undefined, b: Sound | undefined): string[] {
  const out: string[] = [];
  if (a && b && a.voice === 'classic' && b.voice === 'classic') {
    for (const f of CLASSIC_FIELDS) {
      if (a.patch[f.name] === b.patch[f.name]) continue;
      const show = (v: number) => (f.name === 'wave' ? WAVE_NAMES[v] ?? String(v) : String(v));
      out.push(`${f.name} ${show(a.patch[f.name])} → ${show(b.patch[f.name])}`);
    }
    if (a.patch.seed !== b.patch.seed) out.push(`seed ${a.patch.seed ?? 'auto'} → ${b.patch.seed ?? 'auto'}`);
  } else if (a && b && a.voice === 'layered' && b.voice === 'layered') {
    // The document's lines that differ (a layer is one line, with its envelopes and effects under it): what went, then what came.
    const la = serializeSound(a).split('\n'), lb = serializeSound(b).split('\n');
    const had = new Set(la), has = new Set(lb);
    const lines = [...la.filter((l) => !has.has(l)).map((l) => `− ${l.trim()}`), ...lb.filter((l) => !had.has(l)).map((l) => `+ ${l.trim()}`)];
    out.push(...lines.slice(0, 14), ...(lines.length > 14 ? [`… ${lines.length - 14} more lines differ`] : []));
  } else if (a && b && a.voice === 'tone' && b.voice === 'tone') {
    for (const p of TONE_PARAMS) {
      const k = p.name as 'frequency' | 'duration' | 'volume';
      if (a[k] !== b[k]) out.push(`${k} ${a[k]} → ${b[k]}`);
    }
  }
  if (a && b && a.status !== b.status) out.push(`status ${a.status} → ${b.status}`);
  return out;
}

function libraryAt(entries: readonly TapeEntry[], upTo: number): Library {
  return replay(entries.filter((e) => e.seq <= upTo)).library;
}

/** The changes after the cursor, with the numbers and the compare views worked out. */
export function collectChanges(w: Writer, o: ChangesOptions): ChangesResult {
  if (o.by !== undefined && o.by !== 'human' && o.by !== 'agent' && !AUTHOR_RE.test(o.by)) throw new ProjectError(`--by is human, agent, or one author (human:<name>, agent:<name>), not '${o.by}'`);
  const entries = w.tape();
  const explicit = o.since !== undefined;
  const from = explicit ? sinceSeq(entries, o.since!) : changesCursor(w, o.agent);
  const cursor = entries.reduce((n, e) => Math.max(n, e.seq), 0);
  const active = activeGroups(entries);
  const wanted = [...groupsOf(entries)].filter(([, es]) => es[0]!.seq > from && matchesAuthor(es[0]!.by, o.by, o.agent));
  const shown = wanted.slice(-MAX_DETAILED);
  const changes: GroupChange[] = shown.map(([g, es]) => {
    const first = es[0]!;
    const last = es.at(-1)!;
    const before = libraryAt(entries, first.seq - 1);
    const after = libraryAt(entries, last.seq);
    const sounds: SoundChange[] = [];
    for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const a = before.get(id);
      const b = after.get(id);
      if (a && b && serializeSound(a) === serializeSound(b)) continue;
      const kind = !a ? 'new' : !b ? 'removed' : 'edited';
      const sc: SoundChange = { id, kind, params: paramLines(a, b), numbers: [], view: null };
      if (a && b) {
        const ra = w.cache.render(a, w.samples.bankFor(before));
        const rb = w.cache.render(b, w.samples.bankFor(after));
        const ma = w.measureSound(a, ra);
        const mb = w.measureSound(b, rb);
        const A = ma.analysis;
        const B = mb.analysis;
        const hz = (v: number | null) => (v === null ? 'none' : v.toFixed(0));
        if (ra.key !== rb.key) {
          sc.numbers = [
            `duration ${num(A.duration, 3)} → ${num(B.duration, 3)} s`,
            `loudness ${num(A.lufs)} → ${num(B.lufs)} LUFS`,
            `centroid ${hz(A.centroid.mean)} → ${hz(B.centroid.mean)} Hz`,
            `pitch ${hz(A.pitch.start)} → ${hz(B.pitch.start)} Hz`,
          ];
          const c = compareView(ra.samples, rb.samples, `${id} before ${g}`, `${id} after ${g}`);
          const file = join(w.project.dir, '.cache', 'views', `change-${g}-${id}.png`);
          mkdirSync(join(file, '..'), { recursive: true });
          writeFileSync(file, c.image.png);
          sc.view = file;
        } else sc.numbers = ['the samples are the same'];
      }
      sounds.push(sc);
    }
    const songs: SongChange[] = [];
    for (const id of [...new Set([...before.songs.keys(), ...after.songs.keys()])].sort()) {
      const a = before.songs.get(id), b = after.songs.get(id);
      if (a && b && songText(a) === songText(b)) continue;
      songs.push(songChange(w, id, a, b, g));
    }
    const instruments: GroupChange['instruments'] = [];
    for (const id of [...new Set([...before.instruments.keys(), ...after.instruments.keys()])].sort()) {
      const a = before.instruments.get(id), b = after.instruments.get(id);
      const ta = a ? serializeInstrument(a) : '', tb = b ? serializeInstrument(b) : '';
      if (ta === tb) continue;
      instruments.push({ id, kind: !a ? 'new' : !b ? 'removed' : 'edited', lines: a && b ? lineDiff(ta, tb) : [] });
    }
    return { group: g, first: first.seq, last: last.seq, by: first.by, ...(first.at ? { at: first.at } : {}), commands: es.map((e) => e.cmd), undone: !active.has(g), sounds, songs, instruments };
  });
  if (!o.peek && !explicit) writeCursor(w, o.agent, cursor);
  return { changes, omitted: wanted.length - shown.length, from, cursor, explicit };
}

export function formatChanges(r: ChangesResult, o: ChangesOptions): string {
  const who = o.by ? (o.by === 'human' ? 'people' : o.by) : `anyone but ${o.agent}`;
  if (!r.changes.length) return `no changes by ${who} since #${r.from}${r.explicit || o.peek ? '' : ` (your cursor is now #${r.cursor})`}`;
  const lines = [`${r.changes.length + r.omitted} change${r.changes.length + r.omitted === 1 ? '' : 's'} by ${who} since #${r.from}${r.explicit || o.peek ? '' : ` (your cursor is now #${r.cursor})`}:`];
  if (r.omitted) lines.push(`  (${r.omitted} older ${r.omitted === 1 ? 'one is' : 'ones are'} not detailed; ask for them with --since)`);
  for (const c of r.changes) {
    lines.push('', `${c.group} #${c.first}${c.last > c.first ? `-#${c.last}` : ''} ${c.by}${c.at ? ' ' + c.at : ''}${c.undone ? '  (out of effect: undone)' : ''}`);
    for (const cmd of c.commands) lines.push(`  ${cmd}`);
    for (const s of c.sounds) {
      lines.push(`  ${s.id} (${s.kind}):`);
      for (const p of s.params) lines.push(`    ${p}`);
      if (s.numbers.length) lines.push(`    numbers: ${s.numbers.join('; ')}`);
      if (s.view) lines.push(`    compare view (before above, after below): ${s.view}`);
    }
    for (const s of c.songs) {
      lines.push(`  song ${s.id} (${s.kind}):`);
      for (const p of s.settings) lines.push(`    ${p}`);
      for (const p of s.notes) lines.push(`    ${p}`);
      for (const v of s.views) lines.push(`    notes before/after (red went, green came): ${v}`);
    }
    for (const i of c.instruments) {
      lines.push(`  instrument ${i.id} (${i.kind}):`);
      for (const p of i.lines) lines.push(`    ${p}`);
    }
    if (!c.sounds.length && !c.songs.length && !c.instruments.length) lines.push('  (nothing differs after it)');
  }
  lines.push('', 'These are other hands\' edits: carry on from them, and do not undo or overwrite one silently. If you disagree, say so (reply, or ask the person) before changing it back.');
  return lines.join('\n');
}

export function changesText(w: Writer, o: ChangesOptions): string {
  return formatChanges(collectChanges(w, o), o);
}


const checksOf = (cs: CheckResult[]): ReviewCheck[] => cs.map((c) => ({ name: c.name, pass: c.pass, value: c.value, at: TIMED_CHECKS.includes(c.name) ? c.ranges.map((r) => Math.round(r.from * 1000) / 1000) : [] }));

function sideOf(w: Writer, s: Sound | undefined, lib: Library): ReviewSide | null {
  if (!s) return null;
  // the audio the sample names stood for at that point of the tape
  const r = w.cache.render(s, w.samples.bankFor(lib));
  const m = w.measureSound(s, r);
  return { sound: s, checks: checksOf(m.checks), lufs: Number.isFinite(m.analysis.lufs) ? m.analysis.lufs : null, truePeakDb: Number.isFinite(m.analysis.truePeakDb) ? m.analysis.truePeakDb : null, duration: m.analysis.duration, centroid: m.analysis.centroid.mean || null };
}

/** `name old → new` lines as pairs; the layered voice's differing lines are paired in order (what went, what came). */
function paramPairs(a: Sound | undefined, b: Sound | undefined, by: string): Review['params'] {
  const lines = paramLines(a, b);
  const out: Review['params'] = [];
  const gone: string[] = [], came: string[] = [];
  for (const l of lines) {
    const m = /^(.+?) (.+) → (.+)$/.exec(l);
    if (l.startsWith('− ')) gone.push(l.slice(2));
    else if (l.startsWith('+ ')) came.push(l.slice(2));
    else if (m) out.push({ name: m[1]!, old: m[2]!, new: m[3]!, by });
    else out.push({ name: l, old: '', new: '', by });
  }
  for (let i = 0; i < Math.max(gone.length, came.length); i++) out.push({ name: (came[i] ?? gone[i] ?? '').split(/\s+/).slice(0, 2).join(' '), old: gone[i] ?? '', new: came[i] ?? '', by });
  return out;
}

/** The structured review of a request (the agent's commands for it) or of one tape group. */
export function reviewOf(w: Writer, o: { request?: string; group?: string }): Review {
  const entries = w.tape();
  let picked: TapeEntry[];
  let item: string;
  let note: string | null = null;
  let request: string | null = null;
  if (o.request) {
    const q = readRequests(w.project).get(o.request);
    if (!q) throw new ProjectError(`no request ${o.request}`);
    request = q.id;
    if (q.sound.startsWith('sample:')) throw new ProjectError(`${q.id} is about a sample, which has no review page: ${q.sound.slice(7)}'s page shows the request and what changed`);
    item = q.sound;
    const claim = q.events.find((e) => e.type === 'claim');
    const done = [...q.events].reverse().find((e) => e.type === 'done');
    note = done?.text ?? q.latest;
    const from = claim ? Date.parse(claim.at) : 0;
    const to = done ? Date.parse(done.at) : Date.now();
    picked = w.history({ sound: q.sound }).filter((e) => e.by === q.claimedBy && (!e.at || (Date.parse(e.at) >= from && Date.parse(e.at) <= to)));
    if (!picked.length) throw new ProjectError(`${q.id}: the tape has no commands by ${q.claimedBy ?? 'the agent'} on ${q.sound} between its claim and its done`);
  } else if (o.group) {
    const g = groupsOf(entries).get(o.group);
    if (!g) throw new ProjectError(`no group ${o.group} on the tape`);
    picked = g;
    const first = libraryAt(entries, g[0]!.seq - 1), last = libraryAt(entries, g.at(-1)!.seq);
    const changed = [...new Set([...first.keys(), ...last.keys()])].filter((id) => { const a = first.get(id), b = last.get(id); return !a || !b || serializeSound(a) !== serializeSound(b); });
    const songs = [...new Set([...first.songs.keys(), ...last.songs.keys()])].filter((id) => { const a = first.songs.get(id), b = last.songs.get(id); return !a || !b || songText(a) !== songText(b); });
    item = changed[0] ?? songs[0] ?? '';
    if (!item) throw new ProjectError(`${o.group} changed no sound or song`);
  } else throw new ProjectError('a review is of a request or a group');
  const first = Math.min(...picked.map((e) => e.seq));
  const last = Math.max(...picked.map((e) => e.seq));
  const by = picked[0]!.by;
  const before = libraryAt(entries, first - 1);
  const after = libraryAt(entries, last);
  const now = libraryAt(entries, entries.reduce((n, e) => Math.max(n, e.seq), 0));
  const isSong = after.songs.has(item) || before.songs.has(item);
  const a = isSong ? undefined : before.get(item), b = isSong ? undefined : after.get(item);
  const A = sideOf(w, a, before), B = sideOf(w, b, after);
  const rows: ReviewRow[] = [];
  if (A && B) {
    const fmt = (v: number | null, d: number, unit: string) => (v === null ? '−∞' : `${v.toFixed(d)} ${unit}`);
    const byName = new Map(A.checks.map((c) => [c.name, c]));
    rows.push({ k: 'Integrated', a: fmt(A.lufs, 1, 'LUFS'), b: fmt(B.lufs, 1, 'LUFS'), glyph: B.checks.find((c) => c.name === 'loudness')?.pass === false ? 'fail' : B.checks.some((c) => c.name === 'loudness') ? 'pass' : '' });
    for (const c of B.checks) {
      if (c.name === 'loudness') continue;
      const ca = byName.get(c.name);
      rows.push({ k: c.name, a: ca?.value ?? '', b: c.value, glyph: c.pass ? 'pass' : 'fail', ga: ca ? (ca.pass ? 'pass' : 'fail') : '' });
    }
    rows.push({ k: 'Centroid', a: A.centroid === null ? 'none' : `${(A.centroid / 1000).toFixed(1)} kHz`, b: B.centroid === null ? 'none' : `${(B.centroid / 1000).toFixed(1)} kHz`, glyph: '' });
    rows.push({ k: 'True peak', a: fmt(A.truePeakDb, 1, 'dBTP'), b: fmt(B.truePeakDb, 1, 'dBTP'), glyph: '' });
    rows.push({ k: 'Duration', a: `${A.duration.toFixed(2)} s`, b: `${B.duration.toFixed(2)} s`, glyph: '' });
  }
  const sa = before.songs.get(item), sb = after.songs.get(item);
  const song: Review['song'] = isSong ? (() => {
    const sc = sa && sb ? songChange(w, item, sa, sb, [...new Set(picked.map((e) => e.group))].join('+')) : null;
    return { notes: sc?.notes ?? [], settings: sc?.settings ?? [], before: sa ? songToJson(sa) : null, after: sb ? songToJson(sb) : null, stillThere: now.songs.has(item) };
  })() : null;
  const cur = isSong ? (now.songs.has(item) && sb ? songText(now.songs.get(item)!) === songText(sb) : false) : (now.has(item) && b ? serializeSound(now.get(item)!) === serializeSound(b) : false);
  return { request, groups: [...new Set(picked.map((e) => e.group))], first, last, by, ...(picked[0]!.at ? { at: picked[0]!.at } : {}), item, kind: isSong ? 'song' : 'sound', note, commands: picked.map((e) => e.cmd), params: paramPairs(a, b, by), rows, before: A, after: B, song, current: cur, tapeEnd: entries.at(-1)?.seq ?? 0 };
}
