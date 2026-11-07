// The agent's ears, server side: a sound's numbers and checks (measured once per distinct render
// and kept), the views as PNG files, describe, check, and the classic voice's export and import.

import { mkdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CHECK_NAMES, audibleLayers, checkSummary, isStereo, layerLabel, layersView, mixdown, renderParts, checksPass, classicWav, compareView, describe, formatChecks, formatCsv, formatDistance, formatNumbers, formatPatchNamed, patchFileText, parsePatch, readCsv,
  pitchView, renderExact, specView, waveView, ClassicError, SOUND_ID_RE, fmtStep, loopView, seamNumbers, setView, formatSpread, type Analysis, type CheckResult, type ClassicPatch, type CsvRow, type Sound, type ViewKind,
} from '@soundclaw/core';
import { ImportError, importBfxr, importJsfxr, limitChannels, looksLikeJsfxr, splitRows, type ImportedRow } from '@soundclaw/core';
import { encodeOgg } from './ogg.ts';
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

/** The set-spread check of a set, as lines: the verdict, the numbers and where it flags. */
export function setCheckText(w: Writer, id: string): { text: string; pass: boolean } {
  const set = w.set(id);
  if (!set.members.length) return { text: `set ${id}: has no members (set add ${id} <sound>)`, pass: false };
  const m = w.measureSetDoc(id);
  return { text: formatChecks(`set ${id}`, [m.result]), pass: m.result.pass };
}

/** `check`: every named sound or set (all sounds and sets when none), with scores, thresholds and flagged ranges. */
export function checkText(w: Writer, ids: string[]): { text: string; pass: boolean } {
  const soundIds = ids.length ? ids.filter((x) => w.has(x) || !w.hasSet(x)) : w.sounds().map((s) => s.id);
  const setIds = ids.length ? ids.filter((x) => !w.has(x) && w.hasSet(x)) : w.sets().map((s) => s.id);
  if (!soundIds.length && !setIds.length) throw new ProjectError('there are no sounds to check');
  const results = soundIds.map((id) => ({ id, m: w.measure(id) }));
  const failing = results.filter((r) => !checksPass(r.m.checks));
  const lines = results.map((r) => formatChecks(r.id, r.m.checks));
  const sets = setIds.map((id) => setCheckText(w, id));
  lines.push(...sets.map((x) => x.text));
  const s = w.style;
  if (results.length) lines.push(`${plural(results.length - failing.length, 'sound')} of ${results.length} pass all of ${CHECK_NAMES.join(', ')} (target ${s.loudnessTarget} LUFS ±${s.loudnessTolerance}, true peak at most ${s.truePeakMax} dBTP${w.project.json.style ? '; from the project style' : '; the default style'})`);
  if (sets.length) lines.push(`${plural(sets.filter((x) => x.pass).length, 'set')} of ${sets.length} pass set-spread`);
  return { text: lines.join('\n'), pass: !failing.length && sets.every((x) => x.pass) };
}

/** One set in a few lines: members, target, rules, loudness and the set-spread verdict. */
export function setSummary(w: Writer, id: string): string {
  const set = w.set(id);
  const head = `set ${id}: ${plural(set.members.length, 'member')} [${set.members.join(', ')}]${set.from ? ` from ${set.from}` : ''}${set.target !== null ? `, target ${set.target} LUFS` : ', no loudness target'}${set.spread.length ? `, spread "${formatSpread(set.spread)}"` : ''}, seed ${set.seed}`;
  if (set.members.length < 2) return head;
  const m = w.measureSetDoc(id);
  return `${head}\n    set-spread ${m.result.pass ? 'pass' : 'FAIL'}: ${m.result.value}`;
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
export function viewSound(w: Writer, id: string, kind: ViewKind | 'compare' | 'layers' | 'loop' | 'set', o: { other?: string; out?: string } = {}): ViewResult {
  if (kind === 'set') return viewSet(w, id, o.out);
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
  else if (kind === 'layers') {
    const sound = w.sound(id);
    if (sound.voice !== 'layered') throw new ProjectError(`${id} is a ${sound.voice} sound: the layers view is for layered sounds (wave, spec and pitch show any sound)`);
    const parts = renderParts(sound, w.samples);
    const rows = parts.parts.map((p) => ({
      label: `${p.index + 1} ${layerLabel(p.layer)}`,
      offset: p.layer.p.offset as number,
      detail: `gain ${p.layer.p.gain} pan ${p.layer.p.pan}${p.layer.solo ? ' solo' : ''}`,
      samples: mixdown(p.channels),
    }));
    const silent = sound.layers.filter((l) => !audibleLayers(sound).includes(l)).length;
    png = layersView(rows, parts.length / 44100, id).png;
    text += `\nlayers: ${rows.length} sounding${silent ? `, ${silent} muted or not soloed` : ''}${isStereo(sound) ? '; stereo (the layers are drawn as the mix of their two channels)' : ''}`;
  } else if (kind === 'loop') {
    const sound = w.sound(id);
    if (sound.voice !== 'layered' || !sound.loop) throw new ProjectError(`${id} is not a loop (sound loop ${id} <seconds> makes a layered sound one; a bed recipe such as wind, rain, fire or crowd comes looped)`);
    const seam = seamNumbers(r.samples);
    png = loopView(r.samples, m.analysis, seam, id).png;
    text += `\nloop: ${sound.loop.length} s, crossfade ${sound.loop.fade} s; seam jump ${seam.jump.toFixed(3)} against a local step of ${seam.local.toFixed(3)}, level step ${fmtStep(seam.stepDb)} dB between the last and the first 50 ms`;
  } else throw new ProjectError(`no view '${kind}' (wave, spec, pitch, layers, loop, set, compare)`);
  const file = o.out ? resolve(o.out) : join(w.project.dir, '.cache', 'views', `${id}${kind === 'compare' ? `-vs-${o.other}` : ''}-${kind}-${r.key.slice(0, 8)}.png`);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, png);
  return { png, file, text: `${kind} view saved to ${file}\n${text}` };
}

/** The set view: the members side by side and the distance matrix. */
function viewSet(w: Writer, id: string, out?: string): ViewResult {
  const set = w.set(id);
  if (set.members.length < 1) throw new ProjectError(`set ${id} has no members`);
  const m = w.measureSetDoc(id);
  const rows = set.members.map((mid, i) => ({ id: mid, samples: w.render(mid).samples, lufs: m.lufs[i]! }));
  const png = setView(rows, m.matrix, { min: w.style.setSpreadMin, max: w.style.setSpreadMax, target: set.target }, id).png;
  const file = out ? resolve(out) : join(w.project.dir, '.cache', 'views', `set-${id}-${w.render(set.members[0]!).key.slice(0, 8)}.png`);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, png);
  const matrix = ['distance matrix (dB):', `  ${''.padEnd(14)}${set.members.map((_, j) => String(j + 1).padStart(6)).join('')}`, ...set.members.map((mid, i) => `  ${`${i + 1} ${mid}`.padEnd(14)}${m.matrix[i]!.map((d, j) => (i === j ? '     -' : d.toFixed(1).padStart(6))).join('')}`)];
  return { png, file, text: `set view saved to ${file}\n${setSummary(w, id)}\n${matrix.join('\n')}\n${formatChecks(`set ${id}`, [m.result])}` };
}

// ---- export ---------------------------------------------------------------------------------------

export type ExportFormat = 'wav' | 'ogg' | 'patch' | 'csv';
export const EXPORT_FORMATS: readonly ExportFormat[] = ['wav', 'ogg', 'patch', 'csv'];

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

export interface ExportOptions {
  /** The folder to write into (default <project>/exports). */
  out?: string;
  /** Export the members of this set. */
  set?: string;
  /** --all: every sound, and a manifest. */
  all?: boolean;
  /** Pack layout: a flat folder, and the sounds marked classic as rows of one synth.csv instead of audio files. */
  pack?: boolean;
  /** OGG quality, -0.1 to 1 (default 0.4). */
  quality?: number;
}

export interface ManifestSound {
  id: string;
  /** The audio file, relative to the manifest (null: the sound is a row of synth.csv). */
  file: string | null;
  format: 'wav' | 'ogg' | null;
  /** Seconds. */
  duration: number;
  samples: number;
  sampleRate: number;
  channels: number;
  /** Integrated loudness, LUFS, of the render (before the export limiter, which only acts above the true-peak ceiling). */
  loudness: number | null;
  truePeak: number | null;
  /** Sample positions where a loop starts and ends (null: not a loop). WAV loops exactly; Vorbis is lossy, so its seam is only as good as the codec. */
  loop: { start: number; end: number; startSeconds: number; endSeconds: number } | null;
  /** The set it belongs to, if any. */
  set: string | null;
  status: string;
  /** True: the sound is a row of synth.csv (a sound marked classic, in the pack layout). */
  synth: boolean;
}

function classicOf(s: Sound, what: string): ClassicPatch {
  if (s.voice !== 'classic') throw new ProjectError(`${s.id} is a ${s.voice} sound: ${what} is for classic sounds${s.voice === 'layered' ? '; a layered sound exports as WAV only (export --format wav; or ogg)' : ' (export it as wav)'}`);
  return s.patch;
}

/** The channels as they are exported: layered sounds through the limiter at the style's true-peak ceiling; a classic sound as its exact samples. */
function exportChannels(w: Writer, id: string): Float32Array[] {
  const s = w.sound(id);
  if (s.voice === 'layered') return limitChannels(w.render(id).channels, w.style.truePeakMax).channels;
  if (s.voice === 'classic') return [Float32Array.from(renderExact(s))];
  return [w.render(id).samples];
}

/**
 * Export sounds. wav: one file per sound (the classic voice as the engine's pre-rendered form,
 * trunc(s × 32000), 16-bit mono; layered sounds through the limiter); ogg: Vorbis, variable bitrate;
 * with --all, a set, the pack layout or OGG, manifest.json is written beside the files (id, file, duration, loudness, channels, loop points, set).
 * patch: one single-patch text per classic sound (`<id>.sfxr`, six significant digits, as the engine
 * reads it); csv: one synth.csv with a row per classic sound (full precision, so reading it back
 * renders the same samples). With a set, its members; with no ids, every sound.
 */
export function exportFormat(w: Writer, ids: string[], format: ExportFormat, outOrOptions?: string | ExportOptions): { files: ExportedFile[]; notes: string[]; manifest: string | null } {
  const o: ExportOptions = typeof outOrOptions === 'string' ? { out: outOrOptions } : outOrOptions ?? {};
  if (o.set && ids.length) throw new ProjectError('export: name sounds or a set, not both');
  const fromSet = o.set ? w.set(o.set).members : null;
  if (fromSet && !fromSet.length) throw new ProjectError(`set ${o.set} has no members to export`);
  const explicit = ids.length > 0 || !!fromSet;
  const names = fromSet ?? (ids.length ? ids : w.sounds().map((s) => s.id));
  if (!names.length) throw new ProjectError('there are no sounds to export');
  const dir = resolve(o.out ?? join(w.project.dir, 'exports'));
  mkdirSync(dir, { recursive: true });
  const notes: string[] = [];
  const base = (id: string, file: string, bytes: number, format: ExportFormat): ExportedFile => {
    const r = w.render(id);
    let peak = 0;
    for (const v of r.samples) peak = Math.max(peak, Math.abs(v));
    return { id, file, bytes, seconds: r.samples.length / 44100, samples: w.samplesHashOf(id), peak, cached: r.cached, format };
  };
  const csvRows = (list: string[], strict: boolean): { rows: CsvRow[]; skipped: string[] } => {
    const rows: CsvRow[] = [];
    const skipped: string[] = [];
    for (const id of list) {
      const s = w.sound(id);
      if (s.voice === 'classic') rows.push({ id, patch: s.patch });
      else if (strict) throw new ProjectError(`${id} is a ${s.voice} sound: csv is for classic sounds${s.voice === 'layered' ? '; a layered sound exports as WAV only (export --format wav; or ogg)' : ''}`);
      else skipped.push(id);
    }
    return { rows, skipped };
  };
  if (format === 'csv') {
    const { rows, skipped } = csvRows(names, explicit);
    if (!rows.length) throw new ProjectError('no classic sounds to write as csv');
    for (const id of skipped) notes.push(`skipped ${id} (${w.sound(id).voice === 'layered' ? 'layered: WAV only' : 'not a classic sound'})`);
    const file = join(dir, 'synth.csv');
    const text = formatCsv(rows);
    writeFileSync(file, text);
    return { files: rows.map((r) => base(r.id, file, Buffer.byteLength(text), 'csv')), notes, manifest: null };
  }
  const files: ExportedFile[] = [];
  const manifest: ManifestSound[] = [];
  const setOf = (id: string): string | null => w.sets().find((x) => x.members.includes(id))?.id ?? null;
  const entry = (id: string, file: string | null, fmt: 'wav' | 'ogg' | null, channels: number, synth: boolean): ManifestSound => {
    const s = w.sound(id);
    const r = w.render(id);
    const a = w.measure(id).analysis;
    const n = r.samples.length;
    return {
      id, file, format: fmt, duration: n / 44100, samples: n, sampleRate: 44100, channels,
      loudness: Number.isFinite(a.lufs) ? Math.round(a.lufs * 100) / 100 : null, truePeak: Number.isFinite(a.truePeakDb) ? Math.round(a.truePeakDb * 100) / 100 : null,
      loop: s.voice === 'layered' && s.loop ? { start: 0, end: n, startSeconds: 0, endSeconds: n / 44100 } : null,
      set: setOf(id), status: s.status, synth,
    };
  };
  const audio: string[] = [];
  // manifest.json beside the files for a whole-project export (--all), a set, the pack layout and OGG
  const wantManifest = !!(o.all || o.set || o.pack || format === 'ogg');
  if (format === 'wav' || format === 'ogg') {
    for (const id of names) {
      const s = w.sound(id);
      if (o.pack && s.voice === 'classic' && s.classicOnly) { audio.push(id); continue; }
      const file = join(dir, `${id}.${format}`);
      let bytes: Uint8Array;
      let channels = 1;
      if (format === 'ogg') {
        const chs = exportChannels(w, id);
        bytes = encodeOgg(chs, 44100, o.quality);
        channels = chs.length;
      } else if (s.voice === 'classic') bytes = classicWav(renderExact(s));
      else if (s.voice === 'layered') {
        const x = w.exportOf(id);
        bytes = x.wav;
        channels = x.channels;
        notes.push(`${id}: layered sound, exported as WAV only (${x.channels === 2 ? 'stereo' : 'mono'}, 16-bit, 44,100 Hz); a synth.csv row or patch text cannot hold layers. Limiter at the style's true-peak ceiling ${w.style.truePeakMax} dBTP: ${x.reductionDb > 0 ? `reduced the loudest part by ${x.reductionDb.toFixed(1)} dB` : 'did not need to act'}`);
      } else bytes = w.wavOf(id);
      writeFileSync(file, bytes);
      files.push(base(id, file, bytes.length, format));
      manifest.push(entry(id, `${id}.${format}`, format, channels, false));
      if (s.voice === 'layered' && s.loop && format === 'ogg') notes.push(`${id}: a loop exported as OGG; Vorbis is lossy, so the seam is only as good as the codec: use WAV where it must be exact`);
    }
    if (audio.length) {
      const { rows } = csvRows(audio, true);
      const file = join(dir, 'synth.csv');
      const text = formatCsv(rows);
      writeFileSync(file, text);
      for (const r of rows) {
        files.push({ ...base(r.id, file, Buffer.byteLength(text), 'csv') });
        manifest.push(entry(r.id, null, null, 1, true));
      }
      notes.push(`${plural(rows.length, 'sound')} marked classic written as rows of synth.csv, not as audio (${rows.map((r) => r.id).join(', ')})`);
    }
    const mf = join(dir, 'manifest.json');
    manifest.sort((a, b) => (a.id < b.id ? -1 : 1));
    if (wantManifest) writeFileSync(mf, JSON.stringify({ format: 'soundclaw-manifest', version: 1, project: w.project.json.name, sounds: manifest, sets: w.sets().filter((x) => manifest.some((m) => x.members.includes(m.id))).map((x) => ({ id: x.id, members: x.members, target: x.target })) }, null, 2) + '\n');
    if (!files.length) throw new ProjectError('nothing to export');
    return { files, notes, manifest: wantManifest ? mf : null };
  }
  for (const id of names) {
    const s = w.sound(id);
    if (s.voice !== 'classic' && !explicit) { notes.push(`skipped ${id} (${s.voice === 'layered' ? 'layered: WAV only' : 'not a classic sound'})`); continue; }
    const p = classicOf(s, 'a patch');
    // A seed cannot ride in the positional form: write the named form, which the engine's parser also reads.
    const body = patchFileText(p);
    const file = join(dir, `${id}.sfxr`);
    writeFileSync(file, body);
    files.push(base(id, file, Buffer.byteLength(body), 'patch'));
  }
  if (!files.length) throw new ProjectError(`no classic sounds to write as ${format}`);
  return { files, notes, manifest: null };
}

export function formatExportFiles(r: { files: ExportedFile[]; notes: string[]; manifest?: string | null }): string {
  const lines = [`exported ${plural(r.files.length, 'sound')} as ${[...new Set(r.files.map((f) => f.format))].join(' + ')}`];
  for (const x of r.files) lines.push(`  ${x.id}: ${x.file} (${x.bytes} bytes, ${x.seconds.toFixed(3)} s, peak ${x.peak.toFixed(3)}, samples ${x.samples.slice(0, 12)}${x.cached ? ', from the render cache' : ''})`);
  if (r.manifest) lines.push(`  manifest: ${r.manifest}`);
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

export type ImportKind = 'sfxr' | 'jsfxr' | 'bfxr';
export const IMPORT_KINDS: readonly ImportKind[] = ['sfxr', 'jsfxr', 'bfxr'];

/** What one imported row became. */
export interface ImportReportRow {
  id: string;
  /** exact: every value is in the sound as it means there. approximated: something was changed or lost (see notes). */
  status: 'exact' | 'approximated';
  form: string;
  notes: string[];
}

const slug = (n: string): string => n.toLowerCase().replace(/[^a-z0-9_-]/g, '_');

/**
 * The command text that makes the sounds a source describes: kind sfxr is the engine's synth.csv or single-patch text
 * (and, when the text is a jsfxr string, that), jsfxr is jsfxr's base58 / URL-hash or JSON form, bfxr is Bfxr's settings
 * string. A source with several strings has one per line, each `<id> <string>` (the id optional for a single string).
 * Every row is reported: exact, or approximated with what was lost. A row that cannot be read is an error and nothing is imported.
 */
export function importCommands(source: string, id: string | null, kind: ImportKind = 'sfxr'): { commands: string; ids: string[]; warnings: string[]; report: ImportReportRow[] } {
  const { text, name } = readSfxrSource(source);
  let rows: CsvRow[];
  let warnings: string[] = [];
  let report: ImportReportRow[] = [];
  const first = text.split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('#')) ?? '';
  const other = kind === 'jsfxr' || kind === 'bfxr' || (kind === 'sfxr' && splitRows(text).every((r) => looksLikeJsfxr(r.body)) && splitRows(text).length > 0);
  if (other) {
    const useBfxr = kind === 'bfxr';
    const lines = splitRows(text);
    if (!lines.length) throw new ProjectError('nothing to import: the source has no strings');
    const fileId = name && SOUND_ID_RE.test(slug(name)) ? slug(name) : null;
    const imported: ImportedRow[] = [];
    const problems: string[] = [];
    lines.forEach((ln, i) => {
      const rowId = ln.id ?? (lines.length === 1 ? id ?? fileId : null);
      if (!rowId) { problems.push(`row ${i + 1}: needs an id (--id <id>, or write each line as "<id> <string>")`); return; }
      if (!SOUND_ID_RE.test(rowId)) { problems.push(`row ${i + 1}: '${rowId}' is not a sound id (a-z, 0-9, _ and -, starting with a letter)`); return; }
      try {
        imported.push(useBfxr ? importBfxr(ln.body, rowId) : importJsfxr(ln.body, rowId));
      } catch (e) {
        if (e instanceof ImportError || e instanceof ClassicError) problems.push(`row ${i + 1} (${rowId}): ${e.message}`);
        else throw e;
      }
    });
    if (problems.length) throw new ProjectError(`import ${kind}: ${problems.join('; ')}; nothing was imported`);
    rows = imported.map((r) => ({ id: r.id, patch: r.patch }));
    report = imported.map((r) => ({ id: r.id, status: r.exact ? 'exact' : 'approximated', form: r.form, notes: r.notes }));
  } else {
    try {
      // A csv has a header of names; a patch is numbers or name=value pairs.
      const isCsv = /^[A-Za-z_]+(,[A-Za-z_]+)+/.test(first) && !first.includes('=');
      if (isCsv) {
        ({ rows, warnings } = readCsv(text));
        if (id && rows.length === 1) rows = [{ id, patch: rows[0]!.patch }];
        else if (id) throw new ProjectError('--id names one sound; the csv has several rows (their ids are used)');
      } else {
        const sid = id ?? (name && SOUND_ID_RE.test(slug(name)) ? slug(name) : null);
        if (!sid) throw new ProjectError('a patch needs a sound id: give --id <id>');
        rows = [{ id: sid, patch: parsePatch(text).patch }];
      }
    } catch (e) {
      if (e instanceof ClassicError) throw new ProjectError(e.message);
      throw e;
    }
    report = rows.map((r) => ({ id: r.id, status: 'exact', form: 'sfxr', notes: [] }));
  }
  for (const r of rows) if (!SOUND_ID_RE.test(r.id)) throw new ProjectError(`'${r.id}' is not a sound id (a-z, 0-9, _ and -, starting with a letter)`);
  const lines = rows.flatMap((r) => [`sound new ${r.id} voice=classic`, `sound patch ${r.id} "${formatPatchNamed(r.patch)}"`]);
  return { commands: lines.join('\n'), ids: rows.map((r) => r.id), warnings, report };
}

/** The per-row report of an import, one block per row. */
export function formatImportReport(report: readonly ImportReportRow[]): string {
  return report.map((r, i) => `row ${i + 1} ${r.id}: ${r.status} (${r.form})${r.notes.map((n) => `\n    ${r.status === 'exact' ? 'note' : 'lost or changed'}: ${n}`).join('')}`).join('\n');
}
