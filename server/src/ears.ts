// The agent's ears, server side: a sound's numbers and checks (measured once per distinct render
// and kept), the views as PNG files, describe, check, and the classic voice's export and import.

import { mkdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CHECK_NAMES, checkSummary, checksPass, classicWav, compareView, describe, formatChecks, formatCsv, formatDistance, formatNumbers, formatPatch, formatPatchNamed, parseCsv, parsePatch,
  pitchView, renderExact, specView, waveView, ClassicError, SOUND_ID_RE, type Analysis, type CheckResult, type ClassicPatch, type CsvRow, type Sound, type ViewKind,
} from '@soundclaw/core';
import { ProjectError } from './project.ts';
import { plural } from './report.ts';
import type { Writer } from './writer.ts';

export interface Measured {
  analysis: Analysis;
  checks: CheckResult[];
}

/** One line: `checks: 4/5 pass; failing: loudness -22.4 LUFS (6.4 LU too quiet)`. */
export function checkLine(m: Measured): string {
  return checkSummary(m.checks);
}

/** `describe`: the plain-words summary, then the numbers. */
export function describeText(w: Writer, id: string): string {
  const m = w.measure(id);
  return `${id}: ${describe(m.analysis)}\n${formatNumbers(m.analysis)}\n${checkLine(m)}`;
}

/** `check`: every named sound (all when none), with scores, thresholds and flagged ranges. */
export function checkText(w: Writer, ids: string[]): { text: string; pass: boolean } {
  const names = ids.length ? ids : w.sounds().map((s) => s.id);
  if (!names.length) throw new ProjectError('there are no sounds to check');
  const results = names.map((id) => ({ id, m: w.measure(id) }));
  const failing = results.filter((r) => !checksPass(r.m.checks));
  const lines = results.map((r) => formatChecks(r.id, r.m.checks));
  const s = w.style;
  lines.push(`${plural(results.length - failing.length, 'sound')} of ${results.length} pass all of ${CHECK_NAMES.join(', ')} (target ${s.loudnessTarget} LUFS ±${s.loudnessTolerance}, true peak at most ${s.truePeakMax} dBTP${w.project.json.style ? '; from the project style' : '; the default style'})`);
  return { text: lines.join('\n'), pass: !failing.length };
}

/** Why `work done` must wait: the failing checks of a sound, or null when it passes. */
export function failingChecks(w: Writer, id: string): string | null {
  const m = w.measure(id);
  const bad = m.checks.filter((c) => !c.pass);
  return bad.length ? bad.map((c) => `${c.name}: ${c.value} (held to ${c.threshold})`).join('; ') : null;
}

/** The render's numbers, then the description and checks; the last line is the check summary. */
export function renderText(w: Writer, id: string, head: string): string {
  const m = w.measure(id);
  return `${head}\n${describe(m.analysis)}\n${formatNumbers(m.analysis)}\n${checkLine(m)}`;
}

export interface ViewResult {
  png: Uint8Array;
  /** Where the image was saved. */
  file: string;
  /** The numbers printed with the view. */
  text: string;
}

/**
 * A view of a sound as a PNG (saved under <project>/.cache/views, or `out`): wave, spec or pitch;
 * compare takes a second sound and adds the difference spectrogram and distance numbers.
 */
export function viewSound(w: Writer, id: string, kind: ViewKind | 'compare', o: { other?: string; out?: string } = {}): ViewResult {
  const m = w.measure(id);
  const r = w.render(id);
  let png: Uint8Array;
  let text = `${id}: ${describe(m.analysis)}\n${formatNumbers(m.analysis)}\n${checkLine(m)}`;
  if (kind === 'compare') {
    if (!o.other) throw new ProjectError('compare needs a second sound');
    const r2 = w.render(o.other);
    const c = compareView(r.samples, r2.samples, id, o.other);
    png = c.image.png;
    text = `${formatDistance(c.distance, id, o.other)}\n\n${id}: ${describe(c.a)}\n${o.other}: ${describe(c.b)}`;
  } else if (kind === 'wave') png = waveView(r.samples, m.analysis, id).png;
  else if (kind === 'spec') png = specView(r.samples, m.analysis, id).png;
  else if (kind === 'pitch') png = pitchView(m.analysis, id).png;
  else throw new ProjectError(`no view '${kind}' (wave, spec, pitch, compare)`);
  const file = o.out ? resolve(o.out) : join(w.project.dir, '.cache', 'views', `${id}${kind === 'compare' ? `-vs-${o.other}` : ''}-${kind}-${r.key.slice(0, 8)}.png`);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, png);
  return { png, file, text: `${kind} view saved to ${file}\n${text}` };
}

// ---- export ---------------------------------------------------------------------------------------

export type ExportFormat = 'wav' | 'patch' | 'csv';
export const EXPORT_FORMATS: readonly ExportFormat[] = ['wav', 'patch', 'csv'];

export interface ExportedFile {
  id: string;
  file: string;
  bytes: number;
  seconds: number;
  /** wav: a hash of the samples (as the tests compare). */
  samples: string;
  peak: number;
  cached: boolean;
  format: ExportFormat;
}

function classicOf(s: Sound, what: string): ClassicPatch {
  if (s.voice !== 'classic') throw new ProjectError(`${s.id} is a ${s.voice} sound: ${what} is for classic sounds (export it as wav)`);
  return s.patch;
}

/**
 * Export sounds. wav: one file per sound (the classic voice as the engine's pre-rendered form,
 * trunc(s × 32000)); patch: one single-patch text per classic sound (`<id>.sfxr`, six significant
 * digits, as the engine reads it); csv: one synth.csv with a row per classic sound (full
 * precision, so reading it back renders the same samples).
 */
export function exportFormat(w: Writer, ids: string[], format: ExportFormat, out?: string): { files: ExportedFile[]; notes: string[] } {
  const names = ids.length ? ids : w.sounds().map((s) => s.id);
  if (!names.length) throw new ProjectError('there are no sounds to export');
  const dir = resolve(out ?? join(w.project.dir, 'exports'));
  mkdirSync(dir, { recursive: true });
  const notes: string[] = [];
  const base = (id: string, file: string, bytes: number, format: ExportFormat): ExportedFile => {
    const r = w.render(id);
    let peak = 0;
    for (const v of r.samples) peak = Math.max(peak, Math.abs(v));
    return { id, file, bytes, seconds: r.samples.length / 44100, samples: w.samplesHashOf(id), peak, cached: r.cached, format };
  };
  if (format === 'csv') {
    const rows: CsvRow[] = [];
    const skipped: string[] = [];
    for (const id of names) {
      const s = w.sound(id);
      if (s.voice === 'classic') rows.push({ id, patch: s.patch });
      else if (ids.length) throw new ProjectError(`${id} is a ${s.voice} sound: csv is for classic sounds`);
      else skipped.push(id);
    }
    if (!rows.length) throw new ProjectError('no classic sounds to write as csv');
    for (const id of skipped) notes.push(`skipped ${id} (not a classic sound)`);
    const file = join(dir, 'synth.csv');
    const text = formatCsv(rows);
    writeFileSync(file, text);
    return { files: rows.map((r) => base(r.id, file, Buffer.byteLength(text), 'csv')), notes };
  }
  const files: ExportedFile[] = [];
  for (const id of names) {
    const s = w.sound(id);
    if (format === 'patch') {
      if (s.voice !== 'classic' && !ids.length) { notes.push(`skipped ${id} (not a classic sound)`); continue; }
      const p = classicOf(s, 'a patch');
      // A seed cannot ride in the positional form: write the named form, which the engine's parser also reads.
      const body = p.seed !== undefined ? `1\n${formatPatchNamed(p)}\n` : formatPatch(p);
      const file = join(dir, `${id}.sfxr`);
      writeFileSync(file, body);
      files.push(base(id, file, Buffer.byteLength(body), 'patch'));
    } else {
      const file = join(dir, `${id}.wav`);
      const wav = s.voice === 'classic' ? classicWav(renderExact(s)) : w.wavOf(id);
      writeFileSync(file, wav);
      files.push(base(id, file, wav.length, 'wav'));
    }
  }
  if (!files.length) throw new ProjectError(`no classic sounds to write as ${format}`);
  return { files, notes };
}

export function formatExportFiles(r: { files: ExportedFile[]; notes: string[] }): string {
  const lines = [`exported ${plural(r.files.length, 'sound')} as ${r.files[0]!.format}`];
  for (const x of r.files) lines.push(`  ${x.id}: ${x.file} (${x.bytes} bytes, ${x.seconds.toFixed(3)} s, peak ${x.peak.toFixed(3)}, samples ${x.samples.slice(0, 12)}${x.cached ? ', from the render cache' : ''})`);
  for (const n of r.notes) lines.push(`  note: ${n}`);
  return lines.join('\n');
}

// ---- import ---------------------------------------------------------------------------------------

/** What `import sfxr` was given: a path to a csv or patch file, or the patch text itself. */
export function readSfxrSource(source: string): { text: string; name: string | null } {
  if (!/[\n,=]/.test(source) && existsSync(source) && statSync(source).isFile()) {
    return { text: readFileSync(source, 'utf8'), name: source.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '') };
  }
  return { text: source, name: null };
}

/** The command text that makes the sounds an sfxr csv, patch file or patch text describes. */
export function importCommands(source: string, id: string | null): { commands: string; ids: string[] } {
  const { text, name } = readSfxrSource(source);
  let rows: CsvRow[];
  try {
    const first = text.split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('#')) ?? '';
    // A csv has a header of names; a patch is numbers or name=value pairs.
    const isCsv = /^[A-Za-z_]+(,[A-Za-z_]+)+/.test(first) && !first.includes('=');
    if (isCsv) {
      rows = parseCsv(text);
      if (id && rows.length === 1) rows = [{ id, patch: rows[0]!.patch }];
      else if (id) throw new ProjectError('--id names one sound; the csv has several rows (their ids are used)');
    } else {
      const sid = id ?? (name && SOUND_ID_RE.test(name.toLowerCase().replace(/[^a-z0-9_-]/g, '_')) ? name.toLowerCase().replace(/[^a-z0-9_-]/g, '_') : null);
      if (!sid) throw new ProjectError('a patch needs a sound id: give --id <id>');
      rows = [{ id: sid, patch: parsePatch(text).patch }];
    }
  } catch (e) {
    if (e instanceof ClassicError) throw new ProjectError(e.message);
    throw e;
  }
  for (const r of rows) if (!SOUND_ID_RE.test(r.id)) throw new ProjectError(`'${r.id}' is not a sound id (a-z, 0-9, _ and -, starting with a letter)`);
  const lines = rows.flatMap((r) => [`sound new ${r.id} voice=classic`, `sound patch ${r.id} "${formatPatchNamed(r.patch)}"`]);
  return { commands: lines.join('\n'), ids: rows.map((r) => r.id) };
}
