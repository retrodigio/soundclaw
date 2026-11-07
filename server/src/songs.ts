// Songs on the server side: the part cache, rendering and measuring a song once for each distinct
// document, the text an agent reads (summary, checks, numbers), the views, export and loudness
// normalising.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  arrange, builtinInstruments, joinChannels, masterChainForStems, type Memo, renderStems, samplesHash, encodeWavChannels, floatBytes, floatsFromBytes, instrumentKey, loopView, mixView, notesView, renderSong, sha256Text, songPasses, songReport, songText, songToMidi, specView, waveView, analyze,
  type MusicCheck, type PartStore, type SongDoc, type SongReport, type SongRender, midiToScript, type Instrument,
} from '@soundclaw/core';
import { ProjectError } from './project.ts';
import { encodeOgg } from './ogg.ts';
import type { Writer } from './writer.ts';

const MEMORY_BYTES = 192 * 1024 * 1024;
const DISK_BYTES = 1536 * 1024 * 1024;

/** The channel renders of songs: in memory up to a size, and on disk (<project>/.cache/parts, ignored by git). */
export class PartCache implements PartStore {
  private readonly dir: string | null;
  private readonly memory = new Map<string, Float32Array>();
  private bytes = 0;
  hits = 0;
  misses = 0;

  constructor(projectDir: string | null) {
    this.dir = projectDir ? join(projectDir, '.cache', 'parts') : null;
    this.prune();
  }

  /** Remove the oldest files when the folder holds more than the cap. */
  private prune(): void {
    if (!this.dir || !existsSync(this.dir)) return;
    try {
      const files = readdirSync(this.dir).map((f) => ({ f, st: statSync(join(this.dir!, f)) }));
      let total = files.reduce((n, x) => n + x.st.size, 0);
      for (const x of files.sort((a, b) => a.st.mtimeMs - b.st.mtimeMs)) {
        if (total <= DISK_BYTES) break;
        rmSync(join(this.dir, x.f), { force: true });
        total -= x.st.size;
      }
    } catch {
      // a cache that cannot be pruned is left alone
    }
  }

  get(key: string): Float32Array | null {
    const m = this.memory.get(key);
    if (m) { this.memory.delete(key); this.memory.set(key, m); this.hits++; return m; }
    const f = this.dir ? join(this.dir, `${key}.f32`) : null;
    if (f && existsSync(f)) {
      try {
        const b = readFileSync(f);
        if (b.length % 4 === 0) {
          const s = floatsFromBytes(new Uint8Array(b.buffer, b.byteOffset, b.length));
          this.remember(key, s);
          this.hits++;
          return s;
        }
      } catch {
        // an unreadable file is a miss
      }
    }
    this.misses++;
    return null;
  }

  put(key: string, samples: Float32Array): void {
    this.remember(key, samples);
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${key}.f32`), floatBytes(samples));
  }

  private remember(key: string, s: Float32Array): void {
    if (this.memory.has(key)) this.bytes -= this.memory.get(key)!.byteLength;
    this.memory.set(key, s);
    this.bytes += s.byteLength;
    while (this.bytes > MEMORY_BYTES && this.memory.size > 1) {
      const k = this.memory.keys().next().value!;
      this.bytes -= this.memory.get(k)!.byteLength;
      this.memory.delete(k);
    }
  }
}

const MEMO_DISK_BYTES = 64 * 1024 * 1024;
const MEMO_ENTRIES = 4096;

/** JSON that keeps the infinities a silent channel's loudness is made of. */
const encodeNums = (_k: string, v: unknown): unknown => (typeof v === 'number' && !Number.isFinite(v) ? { $n: Number.isNaN(v) ? 'nan' : v > 0 ? 'inf' : '-inf' } : v);
const decodeNums = (_k: string, v: unknown): unknown => {
  if (v && typeof v === 'object' && '$n' in v) { const n = (v as { $n: string }).$n; return n === 'nan' ? NaN : n === 'inf' ? Infinity : -Infinity; }
  return v;
};

/** The measurements of songs kept under the project's cache folder, so a check in a new process does not measure a channel it has measured before. */
export class AnalysisMemo implements Memo {
  private readonly dir: string | null;
  private readonly memory = new Map<string, unknown>();
  hits = 0;
  misses = 0;

  constructor(projectDir: string | null) {
    this.dir = projectDir ? join(projectDir, '.cache', 'analysis') : null;
    this.prune();
  }

  private prune(): void {
    if (!this.dir || !existsSync(this.dir)) return;
    try {
      const files = readdirSync(this.dir).map((f) => ({ f, st: statSync(join(this.dir!, f)) }));
      let total = files.reduce((n, x) => n + x.st.size, 0);
      for (const x of files.sort((a, b) => a.st.mtimeMs - b.st.mtimeMs)) {
        if (total <= MEMO_DISK_BYTES) break;
        rmSync(join(this.dir, x.f), { force: true });
        total -= x.st.size;
      }
    } catch {
      // a cache that cannot be pruned is left alone
    }
  }

  get(key: string): unknown {
    if (this.memory.has(key)) { this.hits++; return this.memory.get(key); }
    const f = this.dir ? join(this.dir, `${sha256Text(key)}.json`) : null;
    if (f && existsSync(f)) {
      try {
        const v = JSON.parse(readFileSync(f, 'utf8'), decodeNums) as unknown;
        this.remember(key, v);
        this.hits++;
        return v;
      } catch {
        // an unreadable file is a miss
      }
    }
    this.misses++;
    return undefined;
  }

  put(key: string, value: unknown): void {
    this.remember(key, value);
    if (!this.dir) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, `${sha256Text(key)}.json`), JSON.stringify(value, encodeNums));
    } catch {
      // not kept on disk: it is still kept in memory
    }
  }

  private remember(key: string, v: unknown): void {
    this.memory.set(key, v);
    if (this.memory.size > MEMO_ENTRIES) this.memory.delete(this.memory.keys().next().value!);
  }
}

export interface SongMeasured {
  report: SongReport;
  /** The key of the render the numbers are of. */
  key: string;
}

/** Renders and measures songs through the part cache; the measurements are kept for each distinct document. */
export class SongBench {
  readonly parts: PartCache;
  readonly memo: AnalysisMemo;
  private readonly measured = new Map<string, SongMeasured>();

  private readonly w: Writer;

  constructor(w: Writer) {
    this.w = w;
    this.parts = new PartCache(w.project.dir);
    this.memo = new AnalysisMemo(w.project.dir);
  }

  /** Render a song document. */
  render(song: SongDoc, o: { mode?: 'full' | 'loop'; loops?: number; only?: readonly string[] } = {}): SongRender {
    return renderSong(song, { instruments: (id) => this.w.lookupInstrument(id), bank: this.w.samples, store: this.parts, ...o });
  }

  /** A document's key: what the song says and every instrument it plays. */
  docKey(song: SongDoc): string {
    const used = new Set<string>();
    for (const c of song.channels) { if (c.inst) used.add(c.inst); for (const v of Object.values(c.kit ?? {})) used.add(v); }
    for (const d of ['kick', 'snare', 'hat', 'hat_open']) if (song.channels.some((c) => c.kit)) used.add(d);
    const insts = [...used].sort().map((id) => { const i = this.w.lookupInstrument(id); return i ? `${id}:${instrumentKey(i, (n) => this.w.samples.hash(n) ?? 'missing')}:${i.range?.join('-') ?? ''}` : `${id}:missing`; });
    return sha256Text(`${songText(song)}|${insts.join(',')}|${JSON.stringify(this.w.style)}|${this.w.musicGuide().text}`);
  }

  /** The numbers and checks of a song document, measured once for each distinct document. */
  measure(song: SongDoc): SongMeasured {
    const key = this.docKey(song);
    let m = this.measured.get(key);
    if (!m) {
      const full = this.render(song, { mode: 'full' });
      const hasLoop = arrange(song).loop !== null;
      const loop = hasLoop ? this.render(song, { mode: 'loop' }) : null;
      const report = songReport({ song, full, loop, style: this.w.style, instruments: (id) => this.w.lookupInstrument(id), guide: this.w.musicGuide().guide, memo: this.memo });
      m = { report, key };
      this.measured.set(key, m);
      if (this.measured.size > 32) this.measured.delete(this.measured.keys().next().value!);
    }
    return m;
  }
}

// ---- text ---------------------------------------------------------------------------------------------------------

const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : v > 0 ? 'inf' : '-inf');
const secs = (v: number): string => `${Number(v.toFixed(2))} s`;

export function songCheckLine(checks: readonly MusicCheck[]): string {
  const real = checks.filter((c) => !c.skipped);
  const fails = real.filter((c) => !c.pass && !c.advisory);
  const warns = real.filter((c) => !c.pass && c.advisory);
  const pass = real.filter((c) => c.pass).length;
  return `checks: ${pass}/${real.length} pass${fails.length ? `; failing: ${fails.map((c) => `${c.name} (${c.value})`).join('; ')}` : ''}${warns.length ? `; advisory: ${warns.map((c) => c.name).join(', ')}` : ''}`;
}

export function songLine(song: SongDoc): string {
  const arr = arrange(song);
  const layers = [...new Set(song.channels.map((c) => c.layer))];
  return `${song.id}: song, ${song.tempo} bpm ${song.time[0]}/${song.time[1]}${song.swing ? `, swing ${song.swing}` : ''}${song.key ? `, key ${song.key}` : ''}, ${song.channels.length} channel${song.channels.length === 1 ? '' : 's'}${song.channels.length ? ` (${song.channels.map((c) => c.name).join(', ')})` : ''}, ${song.patterns.size} pattern${song.patterns.size === 1 ? '' : 's'}, ${secs(arr.total)}${arr.loop ? `, loop ${secs(arr.loop.end - arr.loop.start)}` : ', no loop'}${layers.length > 1 ? `, layers ${layers.join(' + ')}` : ''}${song.status !== 'draft' ? `, ${song.status}` : ''}`;
}

function playable(w: Writer, id: string): { ok: true } | { ok: false; why: string } {
  const p = w.songProblems(id);
  if (p.errors.length) return { ok: false, why: p.errors.join('; ') };
  if (!w.song(id).channels.length || !w.song(id).sections.length) return { ok: false, why: `${id} has ${w.song(id).channels.length ? 'no sections' : 'no channels'} yet (song channel add …, song section add …)` };
  return { ok: true };
}

/** The line or two that end a result about a song: its description and the one-line check summary. */
export function songSummary(w: Writer, id: string): string {
  if (!w.hasSong(id)) return `${id}: removed`;
  const song = w.song(id);
  const p = playable(w, id);
  if (!p.ok) return `${songLine(song)}\n    not playable yet: ${p.why}`;
  const m = w.measureSong(id);
  const n = m.report.numbers;
  return `${songLine(song)}\n    ${f1(n.lufs)} LUFS (${n.rule.basis}, ${n.rule.target} ±${n.rule.tolerance}), true peak ${f1(n.truePeakDb)} dBTP\n    ${songCheckLine(m.report.checks)}`;
}

export function songNumbersText(w: Writer, id: string): string {
  const m = w.measureSong(id);
  const n = m.report.numbers;
  const lines = [
    songLine(w.song(id)),
    `  length ${secs(n.length)}${n.loopLength !== null ? `, loop ${secs(n.loopLength)}` : ''}; tempo ${n.tempo} bpm, ${n.time}${n.swing ? `, swing ${n.swing}` : ''}${n.key ? `; key ${n.key}` : ''}`,
    `  loudness ${f1(n.lufs)} LUFS (${n.rule.basis}: ${n.rule.target} ±${n.rule.tolerance} LU), true peak ${f1(n.truePeakDb)} dBTP${n.masterReductionDb > 0.05 ? `, the master chain turns the mix down by up to ${f1(n.masterReductionDb)} dB` : ''}`,
    '  channels (alone, before the master chain):',
    ...n.channels.map((c) => `    ${c.name.padEnd(10)} ${f1(c.lufs).padStart(6)} LUFS  peak ${f1(c.peakDb).padStart(6)} dB  ${String(c.notes).padStart(4)} notes  layer ${c.layer}`),
  ];
  return lines.join('\n');
}

export function songChecksText(w: Writer, id: string): { text: string; pass: boolean } {
  const p = playable(w, id);
  if (!p.ok) return { text: `${id}: not playable yet: ${p.why}`, pass: false };
  const m = w.measureSong(id).report;
  const lines = [`${id}: ${songCheckLine(m.checks)}`];
  for (const c of m.checks) {
    const tag = c.skipped ? 'skip' : c.pass ? 'pass' : c.advisory ? 'warn' : 'FAIL';
    lines.push(`  ${tag.padEnd(4)} ${c.name.padEnd(13)} ${c.score.toFixed(2)}  ${c.value}`);
    if (!c.pass && !c.skipped) {
      lines.push(`       held to: ${c.threshold}`);
      for (const r of c.ranges.slice(0, 8)) lines.push(`       ${r.from.toFixed(2)}-${r.to.toFixed(2)} s  ${r.note}`);
      if (c.ranges.length > 8) lines.push(`       … and ${c.ranges.length - 8} more`);
    }
  }
  return { text: lines.join('\n'), pass: songPasses(m.checks) };
}

/** Why a song would not pass for `work done`: the failing checks (advisory ones do not count), or null. */
export function songFailing(w: Writer, id: string): string | null {
  const p = playable(w, id);
  if (!p.ok) return `not playable: ${p.why}`;
  const bad = w.measureSong(id).report.checks.filter((c) => !c.pass && !c.advisory && !c.skipped).map((c) => `${c.name}: ${c.value} (held to ${c.threshold})`);
  return bad.length ? bad.join('; ') : null;
}

const round = (v: number, d = 4): number | null => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

export function songJsonObject(w: Writer, id: string, o: { hashes?: boolean } = {}): object {
  const song = w.song(id);
  const p = playable(w, id);
  if (!p.ok) return { id, playable: false, problem: p.why };
  const r = w.measureSong(id).report;
  const n = r.numbers;
  return {
    id, playable: true, pass: songPasses(r.checks),
    numbers: {
      length: round(n.length), loopLength: n.loopLength === null ? null : round(n.loopLength), tempo: n.tempo, time: n.time, swing: n.swing, key: n.key, lufs: round(n.lufs), truePeakDb: round(n.truePeakDb),
      class: n.rule.class, target: n.rule.target, tolerance: n.rule.tolerance, masterReductionDb: round(n.masterReductionDb), layers: n.layers,
      channels: n.channels.map((c) => ({ name: c.name, layer: c.layer, lufs: round(c.lufs), peakDb: round(c.peakDb), notes: c.notes })),
    },
    checks: r.checks.map((c) => ({ name: c.name, pass: c.pass, advisory: c.advisory, skipped: c.skipped, score: round(c.score, 3), value: c.value, threshold: c.threshold, ranges: c.ranges })),
    patterns: song.patterns.size,
    ...(o.hashes ? { hashes: songHashes(w, id) } : {}),
  };
}

/** Hashes of the samples of the whole song and of its loop (after the master chain), as the dashboard's playback is compared with. */
export function songHashes(w: Writer, id: string): { full: string; loop: string | null } {
  const song = w.song(id);
  const full = w.bench.render(song, { mode: 'full' });
  const loop = arrange(song).loop ? w.bench.render(song, { mode: 'loop' }) : null;
  return { full: samplesHash(joinChannels([full.mix[0], full.mix[1]])), loop: loop ? samplesHash(joinChannels([loop.mix[0], loop.mix[1]])) : null };
}

// ---- views --------------------------------------------------------------------------------------------------------

export type SongViewKind = 'notes' | 'mix' | 'wave' | 'spec' | 'loop';
export const SONG_VIEWS: readonly SongViewKind[] = ['notes', 'mix', 'wave', 'spec', 'loop'];

export interface SongViewOptions {
  from?: number;
  to?: number;
  channels?: string[];
  out?: string;
}

export function viewSong(w: Writer, id: string, kind: SongViewKind, o: SongViewOptions = {}): { png: Uint8Array; file: string; text: string } {
  const song = w.song(id);
  const p = playable(w, id);
  if (!p.ok) throw new ProjectError(`${id} is not playable yet: ${p.why}`);
  if (o.channels) for (const c of o.channels) if (!song.channels.some((x) => x.name === c)) throw new ProjectError(`song ${id} has no channel '${c}' (channels: ${song.channels.map((x) => x.name).join(', ')})`);
  const measured = w.measureSong(id);
  const report = measured.report;
  const full = w.bench.render(song, { mode: 'full' });
  const dur = full.length / 44100;
  if (o.from !== undefined && o.to !== undefined && !(o.from < o.to)) throw new ProjectError('--from must come before --to');
  const range = { from: o.from, to: o.to !== undefined ? Math.min(o.to, dur) : undefined, channels: o.channels };
  let png: Uint8Array;
  let text = songNumbersText(w, id);
  if (kind === 'notes') {
    png = notesView(song, full, report.match, range).png;
    const bad = report.match.notes.filter((n) => !n.ok);
    const measuredOnsets = report.match.notes.filter((n) => n.onset !== null).length;
    text += `\nnotes view: ${report.match.notes.length} written notes, ${measuredOnsets} onsets measured, ${bad.length} differ${bad.length ? ':' : ''}`;
    for (const n of bad.slice(0, 20)) text += `\n  ${n.t.toFixed(2)} s  ${n.channel}: ${n.problem}`;
    if (bad.length > 20) text += `\n  … and ${bad.length - 20} more`;
  } else if (kind === 'mix') {
    png = mixView(song, report.map, dur, range).png;
    const m = report.checks.find((c) => c.name === 'masking')!;
    text += `\nmix view: ${m.value}`;
    for (const r of m.ranges.slice(0, 10)) text += `\n  ${r.from.toFixed(2)}-${r.to.toFixed(2)} s  ${r.note}`;
  } else {
    const mono = new Float32Array(full.length);
    for (let i = 0; i < mono.length; i++) mono[i] = (full.mix[0][i]! + full.mix[1][i]!) / 2;
    const an = analyze([full.mix[0], full.mix[1]]);
    if (kind === 'wave') png = waveView(mono, an, id).png;
    else if (kind === 'spec') png = specView(mono, an, id).png;
    else {
      if (!report.loop) throw new ProjectError(`${id} has no loop region (song loop ${id} <from>..<to>)`);
      const lp = w.bench.render(song, { mode: 'loop' });
      const lm = new Float32Array(lp.length);
      for (let i = 0; i < lm.length; i++) lm[i] = (lp.mix[0][i]! + lp.mix[1][i]!) / 2;
      const seam = report.checks.find((c) => c.name === 'loop-music')!;
      png = loopView(lm, analyze([lp.mix[0], lp.mix[1]]), { jump: 0, local: 0, stepDb: 0 }, id).png;
      text += `\nloop view: ${seam.value}`;
    }
  }
  const file = o.out ? resolve(o.out) : join(w.project.dir, '.cache', 'views', `${id}-${kind}-${measured.key.slice(0, 8)}.png`);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, png);
  return { png, file, text: `${kind} view saved to ${file}\n${text}` };
}

// ---- export -------------------------------------------------------------------------------------------------------

export type SongExportFormat = 'wav' | 'ogg' | 'midi';

export interface SongExportOptions {
  format: SongExportFormat;
  /** The loop region (seamless: the tail wraps into the start) instead of the whole song. */
  loop?: boolean;
  /** One file per game layer, aligned: the loop's stems when the song loops, else the song's. */
  stems?: boolean;
  /** The loop region repeated this many times: in a full export, or in a loop or stem export of the region. */
  loops?: number;
  /** Stems: run the master chain's filters over each stem (the compressor and limiter cannot be split among stems). */
  stemsThroughMaster?: boolean;
  /** MIDI: one pattern instead of the song. */
  pattern?: string;
  out?: string;
  quality?: number;
}

export interface SongExportedFile {
  file: string;
  bytes: number;
  seconds: number;
  kind: string;
  /** What the export did that the file name does not say (for stems through the master chain). */
  notes?: string[];
}

/** Refuse the combinations of export options that mean nothing, each with what to do instead. */
export function checkSongExportOptions(o: SongExportOptions): void {
  const bad = (m: string): never => { throw new ProjectError(`export: ${m}`); };
  if (o.loops !== undefined && !(Number.isInteger(o.loops) && o.loops >= 1 && o.loops <= 16)) bad('--loops is a whole number from 1 to 16');
  if (o.format === 'midi') {
    for (const [on, flag] of [[o.loop, '--loop'], [o.stems, '--stems'], [o.loops !== undefined, '--loops'], [o.stemsThroughMaster, '--stems-through-master'], [o.quality !== undefined, '--quality']] as const) {
      if (on) bad(`${flag} is for wav and ogg audio; a midi export is the written notes (--pattern <name> exports one pattern)`);
    }
  } else {
    if (o.pattern !== undefined) bad('--pattern is for --format midi (an audio export is the whole song, or its loop)');
    if (o.quality !== undefined && o.format !== 'ogg') bad('--quality is for --format ogg (a wav is not compressed)');
  }
  if (o.stemsThroughMaster && !o.stems) bad('--stems-through-master goes with --stems');
}

export function exportSong(w: Writer, id: string, o: SongExportOptions): SongExportedFile[] {
  checkSongExportOptions(o);
  const song = w.song(id);
  const dir = o.out ? resolve(o.out) : join(w.project.dir, 'exports');
  const files: SongExportedFile[] = [];
  if (o.format !== 'midi') {
    const p = playable(w, id);
    if (!p.ok) throw new ProjectError(`${id} is not playable yet: ${p.why}`);
  }
  const loopRegion = o.format === 'midi' ? null : arrange(song).loop;
  const loops = o.loops ?? 1;
  if (o.format !== 'midi') {
    if (o.loop && !loopRegion) throw new ProjectError(`${id} has no loop region (song loop ${id} <from>..<to>)`);
    if (loops > 1 && !o.loop && !o.stems && !loopRegion) throw new ProjectError(`${id} has no loop region, so --loops ${loops} has nothing to repeat (song loop ${id} <from>..<to>)`);
    if (loops > 1 && o.stems && !loopRegion) throw new ProjectError(`${id} has no loop region, so --loops ${loops} has nothing to repeat for its stems (song loop ${id} <from>..<to>)`);
  }
  mkdirSync(dir, { recursive: true });
  const put = (name: string, bytes: Uint8Array, seconds: number, kind: string, notes?: string[]): void => {
    const file = join(dir, name);
    writeFileSync(file, bytes);
    files.push({ file, bytes: bytes.length, seconds, kind, ...(notes?.length ? { notes } : {}) });
  };
  if (o.format === 'midi') {
    const bytes = songToMidi(song, o.pattern);
    put(`${id}${o.pattern ? `-${o.pattern}` : ''}.mid`, bytes, 0, o.pattern ? `pattern ${o.pattern}` : 'song');
    return files;
  }
  const encode = (chs: readonly Float32Array[]): Uint8Array => (o.format === 'ogg' ? encodeOgg(chs, 44100, o.quality ?? 0.4) : encodeWavChannels(chs));
  const ext = o.format;
  // the loop region repeated n times, end to end: what a player hears when it loops
  const tile = (chs: readonly Float32Array[], n: number): Float32Array[] => chs.map((c) => { if (n === 1) return c; const t = new Float32Array(c.length * n); for (let k = 0; k < n; k++) t.set(c, k * c.length); return t; });
  let stemInfo: ReturnType<typeof masterChainForStems> | null = null;
  if (o.stems) {
    const mode = loopRegion ? 'loop' : 'full';
    const r = w.bench.render(song, { mode });
    stemInfo = masterChainForStems(song);
    const stems = o.stemsThroughMaster ? renderStems(song, r.parts, r.length, mode === 'loop', true) : r.stems;
    const notes = o.stemsThroughMaster ? [
      `stems through the master chain: ${stemInfo.applied.length ? `applied ${stemInfo.applied.map((f) => f.kind + ' ' + Object.entries(f.p).map(([k, v]) => `${k}=${v}`).join(' ')).join('; ')}` : 'the chain has no filter to apply'}`,
      ...stemInfo.skipped.map((x) => `not applied: ${x.fx.kind}: ${x.why}`),
      stemInfo.skipped.length ? 'the stems sum to the mix as the filters leave it, before the chain\'s other effects: louder than the exported mix, and not limited' : 'the stems sum to the mix',
    ] : [];
    for (const s of stems) put(`${id}-stem-${s.layer}.${ext}`, encode(tile(s.channels, loops)), (r.length * loops) / 44100, `stem ${s.layer} (${mode}${loops > 1 ? ` x${loops}` : ''}${o.stemsThroughMaster ? ', through the master filters' : ''})`, notes);
  } else if (o.loop) {
    const r = w.bench.render(song, { mode: 'loop' });
    put(`${id}-loop.${ext}`, encode(tile(r.mix, loops)), (r.length * loops) / 44100, loops > 1 ? `loop x${loops}` : 'loop');
  } else {
    const r = w.bench.render(song, { mode: 'full', loops: o.loops });
    put(`${id}.${ext}`, encode(r.mix), r.length / 44100, o.loops && o.loops > 1 ? `full, loop x${o.loops}` : 'full');
  }
  // a manifest: id, files, loop points, loudness, layers
  const rep = w.measureSong(id).report;
  const man = { id, tempo: song.tempo, time: `${song.time[0]}/${song.time[1]}`, loop: loopRegion ? { start: round(loopRegion.start), length: round(loopRegion.end - loopRegion.start) } : null, lufs: round(rep.numbers.lufs), truePeakDb: round(rep.numbers.truePeakDb), class: rep.numbers.rule.class, layers: rep.numbers.layers, ...(stemInfo ? { stems: { throughMaster: !!o.stemsThroughMaster, applied: o.stemsThroughMaster ? stemInfo.applied.map((f) => f.kind) : [], notApplied: o.stemsThroughMaster ? stemInfo.skipped.map((x) => x.fx.kind) : [] } } : {}), files: files.map((f) => ({ file: f.file.slice(dir.length + 1), kind: f.kind, seconds: round(f.seconds) })) };
  writeFileSync(join(dir, `${id}-manifest.json`), JSON.stringify(man, null, 2) + '\n');
  return files;
}

export function formatSongExport(files: readonly SongExportedFile[]): string {
  const notes = [...new Set(files.flatMap((f) => f.notes ?? []))];
  return [...files.map((f) => `${f.file}  ${f.kind}${f.seconds ? `, ${secs(f.seconds)}` : ''}, ${f.bytes} bytes`), ...notes.map((n) => `note: ${n}`)].join('\n');
}

// ---- loudness -----------------------------------------------------------------------------------------------------

/** The `song set <id> gain=…` command that brings the mix to its loudness target, found by rendering with the new gain (the channel renders are cached, so each try is the sum and the master chain). */
export function normalizeSong(w: Writer, id: string, target?: number): { command: string | null; notes: string[]; target: number; gain: number } {
  const song = w.song(id);
  const p = playable(w, id);
  if (!p.ok) throw new ProjectError(`${id} is not playable yet: ${p.why}`);
  const rule = w.measureSong(id).report.numbers.rule;
  const goal = target ?? rule.target;
  const notes: string[] = [];
  let gain = song.gain;
  let lufs = Infinity;
  for (let k = 0; k < 6; k++) {
    const trial = { ...song, gain };
    const r = w.bench.render(trial, { mode: 'full' });
    lufs = analyze([r.mix[0], r.mix[1]]).lufs;
    if (!Number.isFinite(lufs)) throw new ProjectError(`${id} is silent: nothing to normalize`);
    const diff = goal - lufs;
    if (Math.abs(diff) <= 0.05) break;
    const next = Math.min(4, Math.max(0.01, gain * 10 ** (diff / 20)));
    if (Math.abs(next - gain) < 1e-6) break;
    gain = next;
  }
  gain = Math.round(gain * 10000) / 10000;
  if (Math.abs(goal - lufs) > 0.2) notes.push(`${id} stops at ${f1(lufs)} LUFS, ${f1(Math.abs(goal - lufs))} LU ${lufs < goal ? 'short of' : 'over'} ${goal}: ${lufs < goal ? 'the master limiter holds the peak (raise its ceiling with song fx set, or thin the loudest channels)' : 'the gain is at its smallest'}`);
  return { command: gain === song.gain ? null : `song set ${id} gain=${gain}${target !== undefined ? ` loudness=${target}` : ''}`, notes, target: goal, gain };
}

// ---- MIDI import --------------------------------------------------------------------------------------------------

/** The command script for a MIDI file. */
export function midiImportScript(bytes: Uint8Array, id: string): { script: string; notes: string[]; summary: string } {
  const r = midiToScript(bytes, id);
  return { script: r.script, notes: r.notes, summary: `${r.channels.length} channel${r.channels.length === 1 ? '' : 's'} (${r.channels.join(', ')}), ${r.patterns} pattern${r.patterns === 1 ? '' : 's'}, ${r.tpb} steps per beat` };
}

export function listInstruments(w: Writer): string {
  const own = w.instruments();
  const lines = [`${own.length} project instrument${own.length === 1 ? '' : 's'}${own.length ? ':' : ''}`];
  const line = (i: Instrument): string => `  ${i.id.padEnd(16)} ${i.voice.layers.map((l) => l.kind).join('+')}, root ${i.root}, ${i.pitched ? 'pitched' : 'unpitched'}, envelope ${i.attack}/${i.decay}/${i.sustain}/${i.release}${i.range ? `, range ${i.range.join('-')}` : ''}`;
  for (const i of own) lines.push(line(i));
  lines.push('built-in (play them as they are, or instrument new <id> from=<name>):');
  for (const i of Object.values(builtinInstruments())) lines.push(line(i));
  return lines.join('\n');
}
