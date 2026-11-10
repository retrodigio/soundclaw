// The agent's ears, server side: a sound's numbers and checks (measured once per distinct render
// and kept), the views as PNG files, describe, check, and the classic voice's export and import.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CHECK_NAMES, SAMPLE_RATE, audibleLayers, readSampleWav, resample, resampleMethod, sha256Hex, checkSummary, isStereo, layerLabel, layersView, mixdown, renderParts, checksPass, classicWav, compareView, describe, formatChecks, formatCsv, formatDistance, formatNumbers, formatPatchNamed, patchFileText, parsePatch, readCsv,
  pitchView, renderExact, specView, waveView, ClassicError, SOUND_ID_RE, fmtStep, loopView, seamNumbers, setView, formatSpread, type Analysis, type CheckResult, type LoudnessRule, type ClassicPatch, type CsvRow, type Sound, type ViewKind,
} from '@soundclaw/core';
import { attributionText, itemSamples, licenceIds, reachedSamples, Library, applyCommand, bindingRules, momentLine, momentOf, classTable, cloneSound, loudnessFor, matchGain, parse, serializeSound, ImportError, importBfxr, importJsfxr, limitChannels, looksLikeJsfxr, splitRows, type ImportedRow } from '@soundclaw/core';
import { encodeOgg } from './ogg.ts';
import { ProjectError } from './project.ts';
import { isRef, isSampleRef, monoAt44, sampleDescribeText, sampleMeasureJson, sampleSide, sampleView } from './sampleview.ts';
import { plural } from './report.ts';
import type { Writer } from './writer.ts';

export interface Measured {
  analysis: Analysis;
  checks: CheckResult[];
  /** The loudness rule the checks used: the class, the target and why. */
  rule: LoudnessRule;
}

/** One line: `checks: 4/5 pass; failing: loudness -22.4 LUFS (6.4 LU too quiet)`. */
export function checkLine(m: Measured): string {
  return checkSummary(m.checks);
}

/** `describe`: the plain-words summary, then the numbers. */
export function describeText(w: Writer, id: string): string {
  if (isRef(w, id)) return sampleDescribeText(w, id);
  const m = w.measure(id);
  const moment = momentOf(w.sound(id), w.sets());
  return `${id}: ${describe(m.analysis)}\n${moment ? `${momentLine(moment)}\n` : ''}${formatNumbers(m.analysis)}\n${checkLine(m)}`;
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
  if (results.length) lines.push(`${plural(results.length - failing.length, 'sound')} of ${results.length} pass all of ${CHECK_NAMES.join(', ')} (${loudnessWords(results.map((r) => r.m.rule), s)}, true peak at most ${s.truePeakMax} dBTP${w.project.json.style ? '; from the project style' : '; the default style'})`);
  if (sets.length) lines.push(`${plural(sets.filter((x) => x.pass).length, 'set')} of ${sets.length} pass set-spread`);
  return { text: lines.join('\n'), pass: !failing.length && sets.every((x) => x.pass) };
}

/** The loudness rules in play, in words: `target -16 LUFS ±1` when every sound is of the standard class, else each class used with its target. */
function loudnessWords(rules: readonly LoudnessRule[], s: { loudnessTarget: number; loudnessTolerance: number }): string {
  const used = new Map<string, string>();
  for (const r of rules) used.set(r.basis, `${r.basis.split(';')[0]!.replace('class ', '')} ${r.target} ±${r.tolerance}`);
  if (used.size <= 1 && (!rules.length || rules[0]!.basis === 'class standard')) return `target ${s.loudnessTarget} LUFS ±${s.loudnessTolerance}`;
  return `loudness by class: ${[...new Set(used.values())].join(', ')} LUFS`;
}

/** One set in a few lines: members, target, rules, loudness and the set-spread verdict. */
export function setSummary(w: Writer, id: string): string {
  const set = w.set(id);
  const head = `set ${id}: ${plural(set.members.length, 'member')} [${set.members.join(', ')}]${set.from ? ` from ${set.from}` : ''}${set.target !== null ? `, target ${set.target} LUFS` : ', no loudness target'}${set.spread.length ? `, spread "${formatSpread(set.spread)}"` : ''}, seed ${set.seed}${set.moment ? `, moment "${set.moment}"` : ''}`;
  if (set.members.length < 2) return head;
  const m = w.measureSetDoc(id);
  return `${head}\n    set-spread ${m.result.pass ? 'pass' : 'FAIL'}: ${m.result.value}`;
}

/** Why `work done` must wait: the failing checks of a sound, or null when it passes. */
export function failingChecks(w: Writer, id: string): string | null {
  const m = w.measure(id);
  const bad = m.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.value} (held to ${c.threshold})`);
  // A sound that belongs to a set (two members or more) is done only when the set holds together too: set-spread passes.
  for (const set of w.sets()) {
    if (!set.members.includes(id) || set.members.length < 2) continue;
    const sm = w.measureSetDoc(set.id).result;
    if (!sm.pass) bad.push(`set-spread of set ${set.id}: ${sm.value} (held to ${sm.threshold})`);
  }
  return bad.length ? bad.join('; ') : null;
}

// ---- machine-readable numbers ------------------------------------------------------------------------

const r4 = (v: number): number | null => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);

/** Every number `describe` and `render` print, as plain JSON (null where the number is not finite: a silent sound has no loudness). Rounded to 4 decimals, as the text is rounded, so the last digit a platform may differ in is not in it. */
export function numbersJson(a: Analysis): Record<string, unknown> {
  return {
    duration: r4(a.duration), samples: a.samples, channels: a.channels, silent: a.silent,
    peak: r4(a.peak), peakDb: r4(a.peakDb), truePeakDb: r4(a.truePeakDb), rmsDb: r4(a.rmsDb), crestDb: r4(a.crestDb), dc: r4(a.dc), lufs: r4(a.lufs),
    attack: r4(a.attack), tail: r4(a.tail), leadingSilence: r4(a.leadingSilence), trailingSilence: r4(a.trailingSilence), endLevelDb: r4(a.endLevelDb),
    centroid: { mean: r4(a.centroid.mean), start: r4(a.centroid.start), mid: r4(a.centroid.mid), end: r4(a.centroid.end) },
    flatness: r4(a.flatness),
    pitch: { start: r4(a.pitch.start ?? NaN), end: r4(a.pitch.end ?? NaN), min: r4(a.pitch.min ?? NaN), max: r4(a.pitch.max ?? NaN), rangeSemitones: r4(a.pitch.rangeSemitones), voiced: r4(a.pitch.voiced) },
    onsets: a.onsets, onsetTimes: a.onsetTimes.map((t) => r4(t)),
  };
}

/** One check as JSON. */
export function checkJson(c: CheckResult): Record<string, unknown> {
  return { name: c.name, pass: c.pass, score: r4(c.score), value: c.value, threshold: c.threshold, ranges: c.ranges.map((g) => ({ from: g.from, to: g.to, note: g.note })) };
}

/** One sound: its loudness class and why, every number, every check's result and the rules that bind when two checks fail together. */
export function soundJson(w: Writer, id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const s = w.sound(id);
  const m = w.measure(id);
  return {
    id, voice: s.voice, status: s.status,
    moment: momentOf(s, w.sets()),
    class: { name: m.rule.className, target: m.rule.target, tolerance: m.rule.tolerance, basis: m.rule.basis },
    pass: checksPass(m.checks), numbers: numbersJson(m.analysis), description: describe(m.analysis),
    checks: m.checks.map(checkJson), binding: bindingRules(m.checks), ...extra,
  };
}

/** A set's set-spread check as JSON. */
export function setJson(w: Writer, id: string): Record<string, unknown> {
  const set = w.set(id);
  if (!set.members.length) return { id, pass: false, members: [], check: null, note: 'the set has no members' };
  const m = w.measureSetDoc(id);
  return { id, pass: m.result.pass, members: set.members, loudness: m.lufs.map((l) => r4(l)), distances: m.matrix.map((row) => row.map((d) => r4(d))), check: checkJson(m.result) };
}

/**
 * `measure`: the numbers and every check of many sounds in one go (a whole project when none is named), as JSON for a script.
 * Sound ids and set names may be mixed; a set is measured as the set-spread check.
 */
export function measureJson(w: Writer, ids: string[]): { json: string; pass: boolean } {
  const soundIds = ids.length ? ids.filter((x) => w.has(x) || !w.hasSet(x)) : w.sounds().map((s) => s.id);
  const setIds = ids.length ? ids.filter((x) => !w.has(x) && w.hasSet(x)) : w.sets().map((s) => s.id);
  const sounds = soundIds.map((id) => soundJson(w, id));
  const sets = setIds.map((id) => setJson(w, id));
  const pass = sounds.every((x) => x.pass) && sets.every((x) => x.pass);
  return { json: JSON.stringify({ format: 'soundclaw-measure', version: 1, pass, sounds, sets }, null, 1), pass };
}

/** `measure` as text: one block per sound, its class, numbers and check line. */
export function measureText(w: Writer, ids: string[]): { text: string; pass: boolean } {
  const soundIds = ids.length ? ids.filter((x) => w.has(x) || !w.hasSet(x)) : w.sounds().map((s) => s.id);
  if (!soundIds.length) throw new ProjectError('there are no sounds to measure');
  let pass = true;
  const blocks = soundIds.map((id) => {
    const m = w.measure(id);
    if (!checksPass(m.checks)) pass = false;
    return `${id} (${m.rule.basis}: ${m.rule.target.toFixed(1)} LUFS ±${m.rule.tolerance})\n${formatNumbers(m.analysis)}\n${checkLine(m)}`;
  });
  return { text: blocks.join('\n\n'), pass };
}

// ---- normalize ---------------------------------------------------------------------------------------

/**
 * `normalize`: the commands that bring sounds (or a set's members) to a loudness. With no spec each sound goes to its own rule's
 * target (its class, its set's, the default); a class name puts them in that class (`sound set <id> class=<name>`) and matches the
 * class's target; `target=<LUFS>` gives them that loudness (`sound set <id> loudness=<LUFS>`) so the checks hold them to it. The
 * matching itself is the gain (a layered sound's `gain`; a classic sound's `volume`, which cannot go above 1: the note says how far it falls short).
 */
export function normalizeCommands(w: Writer, names: string[], spec?: string): { commands: string; notes: string[]; ids: string[]; target: string; failures: string[] } {
  if (!names.length) throw new ProjectError('normalize: name sounds or a set');
  const ids: string[] = [];
  for (const n of names) {
    if (w.has(n)) ids.push(n);
    else if (w.hasSet(n)) ids.push(...w.set(n).members);
    else throw new ProjectError(`no sound or set '${n}'`);
  }
  const unique = [...new Set(ids)];
  let cls: string | null = null;
  let loud: number | null = null;
  if (spec !== undefined) {
    const t = /^target=(.+)$/.exec(spec)?.[1] ?? (/^-?\d/.test(spec) ? spec : null);
    if (t !== null) {
      loud = Number(t.replace(/lufs$/i, ''));
      if (!Number.isFinite(loud) || loud < -60 || loud > 0) throw new ProjectError(`normalize: the target is LUFS from -60 to 0, like target=-20 (got '${t}')`);
    } else {
      const table = classTable(w.style);
      if (!table[spec]) throw new ProjectError(`normalize: '${spec}' is neither a loudness class (${Object.keys(table).join(', ')}) nor target=<LUFS>`);
      cls = spec;
    }
  }
  const lib = new Library();
  for (const s of w.sounds()) lib.set(s.id, cloneSound(s));
  lib.sets = new Map(w.sets().map((x) => [x.id, x] as const));
  const out: string[] = [];
  const notes: string[] = [];
  const failures: string[] = [];
  const done: string[] = [];
  for (const id of unique) {
    const original = cloneSound(lib.get(id)!);
    const mine: string[] = [];
    const pre = cls ? `sound set ${id} class=${cls} loudness=auto` : loud !== null ? `sound set ${id} loudness=${loud}` : null;
    if (pre) {
      const before = serializeSound(lib.get(id)!);
      applyCommand(lib, parse(pre).commands[0]!);
      if (serializeSound(lib.get(id)!) !== before) mine.push(pre);
    }
    const sound = lib.get(id)!;
    const rule = loudnessFor(sound, lib.sets.values(), w.style);
    const m = matchGain(sound, rule.target, w.samples, w.style, rule.tolerance);
    if (m.error) {
      // the ones that can be normalized are; this one is left as it was (even its class)
      failures.push(m.error);
      lib.set(id, original);
      continue;
    }
    if (m.command) mine.push(m.command);
    if (m.note) notes.push(m.note);
    out.push(...mine);
    done.push(id);
  }
  if (failures.length && !done.length) throw new ProjectError(`normalize: ${failures.join('\n  ')}\n  (nothing was changed)`);
  const target = cls ? `class ${cls} (${classTable(w.style)[cls]!.target} LUFS)` : loud !== null ? `${loud} LUFS` : 'each sound\'s own class';
  return { commands: out.join('\n'), notes, ids: done, target, failures };
}

/** `describe --json` and `render --json`: the sound's JSON (class, numbers, description, checks); render adds the key and the samples' hash. */
export function describeJson(w: Writer, id: string, extra: Record<string, unknown> = {}): string {
  if (isRef(w, id)) return JSON.stringify(sampleMeasureJson(w, id), null, 1);
  return JSON.stringify(soundJson(w, id, extra), null, 1);
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
export function viewSound(w: Writer, id: string, kind: ViewKind | 'compare' | 'layers' | 'loop' | 'set' | 'slices', o: { other?: string; out?: string; matchLevel?: boolean } = {}): ViewResult {
  if (isRef(w, id) && kind !== 'compare') return sampleView(w, id, kind, o.out);
  if (kind === 'set') return viewSet(w, id, o.out);
  if (kind === 'compare') return viewCompare(w, id, o.other, o.out, o.matchLevel);
  const m = w.measure(id);
  const r = w.render(id);
  let png: Uint8Array;
  let text = `${id}: ${describe(m.analysis)}\n${formatNumbers(m.analysis)}\n${checkLine(m)}`;
  if (kind === 'wave') png = waveView(r.samples, m.analysis, id).png;
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
  const file = o.out ? resolve(o.out) : join(w.project.dir, '.cache', 'views', `${id}-${kind}-${r.key.slice(0, 8)}.png`);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, png);
  return { png, file, text: `${kind} view saved to ${file}\n${text}` };
}

/** Longest reference audio read for a comparison, seconds. */
const COMPARE_MAX_SECONDS = 120;

export interface CompareSide {
  /** What the picture and the numbers call it. */
  label: string;
  /** Mono, at the project's rate. */
  samples: Float32Array;
  /** Where it came from, when not a sound of the project. */
  note: string | null;
  /** Something that identifies the audio, for the file name of the picture. */
  key: string;
}

/** An audio file outside the project as mono samples at the project's rate: a WAV is read here (any rate, resampled); other formats (OGG) are decoded by ffmpeg when it is installed. */
export function readAudioFile(path: string): CompareSide {
  const file = resolve(path);
  if (!existsSync(file) || !statSync(file).isFile()) throw new ProjectError(`no audio file ${path}`);
  const bytes = new Uint8Array(readFileSync(file));
  const base = file.split(/[\\/]/).pop()!;
  const isWav = bytes.length > 12 && String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) === 'RIFF';
  let samples: Float32Array;
  let note: string;
  if (isWav) {
    let wav;
    try { wav = readSampleWav(bytes, COMPARE_MAX_SECONDS); } catch (e) { throw new ProjectError(`${path}: ${(e as Error).message}`); }
    samples = wav.rate === SAMPLE_RATE ? wav.data : resample(wav.data, wav.rate, SAMPLE_RATE);
    note = `${base}: ${wav.channels === 1 ? 'mono' : `${wav.channels} channels mixed to mono`}, ${wav.rate} Hz${wav.rate === SAMPLE_RATE ? '' : ` (${resampleMethod(wav.rate, SAMPLE_RATE)} to ${SAMPLE_RATE} Hz)`}, ${(wav.frames / wav.rate).toFixed(2)} s`;
  } else {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-t', String(COMPARE_MAX_SECONDS), '-f', 'f32le', '-ac', '1', '-ar', String(SAMPLE_RATE), '-'], { maxBuffer: COMPARE_MAX_SECONDS * SAMPLE_RATE * 4 + 1024, encoding: 'buffer' });
    if (r.error || r.status !== 0) {
      const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
      throw new ProjectError(missing
        ? `${path} is not a WAV file, and reading other formats needs ffmpeg, which is not installed: convert it to a WAV (ffmpeg -i ${path} reference.wav) and compare that`
        : `${path}: ffmpeg could not read it${r.stderr?.length ? ` (${r.stderr.toString().trim().split('\n')[0]})` : ''}; give a WAV or OGG file`);
    }
    const out = r.stdout as Buffer;
    samples = new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.length - (out.length % 4)));
    note = `${base}: decoded by ffmpeg to mono ${SAMPLE_RATE} Hz, ${(samples.length / SAMPLE_RATE).toFixed(2)} s`;
  }
  if (!samples.length) throw new ProjectError(`${path} holds no audio`);
  return { label: base, samples, note, key: sha256Hex(bytes).slice(0, 8) };
}

/** One side of a comparison: a sound or a song of the project, else an audio file. */
export function compareSide(w: Writer, what: string): CompareSide {
  if (isSampleRef(what)) {
    const side = sampleSide(w, what);
    const mono = monoAt44(side.audio);
    return { label: side.label, samples: mono, note: `${side.label}: ${side.audio.channels === 1 ? 'mono' : `${side.audio.channels} channels mixed to mono`}, ${side.audio.rate} Hz${side.audio.rate === 44100 ? '' : ' (resampled to 44100 Hz)'}, ${(side.audio.frames / side.audio.rate).toFixed(2)} s`, key: side.hash.slice(0, 8) };
  }
  if (w.has(what)) return { label: what, samples: w.render(what).samples, note: null, key: w.render(what).key.slice(0, 8) };
  if (w.hasSong(what)) {
    const r = w.bench.render(w.song(what), { mode: 'full' });
    const n = r.mix[0].length, mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = (r.mix[0][i]! + r.mix[1][i]!) / 2;
    return { label: what, samples: mono, note: `${what}: the song's full mix, mono`, key: r.key.slice(0, 8) };
  }
  if (existsSync(what) && statSync(what).isFile()) return readAudioFile(what);
  throw new ProjectError(`no sound, song or audio file '${what}' (a sound or song of the project, sample:<name>, hash:<sha256>, or the path of a WAV or OGG file)`);
}

/** `view compare`: two sounds, songs or audio files (a reference outside the project), with the same difference picture and distance numbers. */
function viewCompare(w: Writer, a: string, b: string | undefined, out?: string, matchLevel = false): ViewResult {
  if (!b) throw new ProjectError('compare needs a second sound, song or audio file');
  const A = compareSide(w, a), B = compareSide(w, b);
  const c = compareView(A.samples, B.samples, A.label, B.label);
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '_');
  const file = out ? resolve(out) : join(w.project.dir, '.cache', 'views', `${safe(A.label)}-vs-${safe(B.label)}-compare-${A.key}${B.key}.png`);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, c.image.png);
  const notes = [A.note, B.note].filter((x): x is string => x !== null);
  return { png: c.image.png, file, text: `compare view saved to ${file}\n${formatDistance(c.distance, A.label, B.label, matchLevel)}\n\n${A.label}: ${describe(c.a)}\n${B.label}: ${describe(c.b)}${notes.length ? `\n${notes.join('\n')}` : ''}` };
}

/** `compare`: the distance numbers between two sounds, songs, samples or audio files (no picture). */
export function compareText(w: Writer, a: string, b: string, matchLevel = false): { text: string; json: Record<string, unknown> } {
  const A = compareSide(w, a), B = compareSide(w, b);
  const c = compareView(A.samples, B.samples, A.label, B.label);
  const notes = [A.note, B.note].filter((x): x is string => x !== null);
  return {
    text: `${formatDistance(c.distance, A.label, B.label, matchLevel)}\n\n${A.label}: ${describe(c.a)}\n${B.label}: ${describe(c.b)}${notes.length ? `\n${notes.join('\n')}` : ''}`,
    json: { a: A.label, b: B.label, matchLevel, distance: c.distance, [A.label]: numbersJson(c.a), [B.label]: numbersJson(c.b) },
  };
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
  /** Licence ids let through for this export even though the project's policy blocks them (written into the manifest). */
  allowLicence?: string[];
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
  /** The licences of the samples it reaches, and where it stands under the project's ship policy. */
  licences: string[];
  licence: string;
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
  const notes: string[] = [];
  // Licences: a manifest export (--all, --set, --pack) refuses what reaches a blocked or unknown licence unless it is let through; a single file warns.
  const allow = o.allowLicence ?? [];
  const lic = new Map(names.map((id) => [id, w.itemLicence('sound', id, allow)] as const));
  const bad = [...lic.values()].filter((x) => x.state === 'blocked' || x.state === 'unknown');
  const gated = !!(o.all || o.set || o.pack);
  if (bad.length && gated) {
    throw new ProjectError([
      `export refused: ${bad.length === 1 ? 'a sound reaches' : `${bad.length} sounds reach`} a licence the project does not ship:`,
      ...bad.slice(0, 12).flatMap((x) => [`  ${x.id} (${x.state})`, ...x.samples.filter((s) => s.state === 'blocked' || s.state === 'unknown').map((s) => `    sample ${s.name}: ${s.reason}`)]),
      ...(bad.length > 12 ? [`  … and ${bad.length - 12} more`] : []),
      'Set the licence (sample set <name> licence=<id>), or let it through for this export with --allow-licence <id> (written into the manifest).',
    ].join('\n'));
  }
  if (bad.length) for (const x of bad) notes.push(`${x.id}: ${x.state} licence (${[...new Set(x.samples.filter((s) => s.state === 'blocked' || s.state === 'unknown').map((s) => `${s.name} ${s.licence.id}`))].join(', ')}); a manifest export would refuse it`);
  mkdirSync(dir, { recursive: true });
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
      set: setOf(id), licences: licenceIds(lic.get(id)!.samples), licence: lic.get(id)!.state, status: s.status, synth,
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
    // the samples used (name, hash, licence, attribution, source), and ATTRIBUTION.txt when a licence asks for it
    const reached = reachedSamples(w.sampleLibrary(), manifest.flatMap((m) => itemSamples(w.sampleLibrary(), 'sound', m.id)));
    const attribution = attributionText(reached);
    const atFile = join(dir, 'ATTRIBUTION.txt');
    if (wantManifest) {
      if (attribution) { writeFileSync(atFile, attribution); { const asking = reached.filter((r) => r.licence.attribution || /^CC-BY/.test(r.licence.id)).length; notes.push(`ATTRIBUTION.txt written (${asking} sample${asking === 1 ? ' asks' : 's ask'} for attribution)`); } }
      else rmSync(atFile, { force: true });
    }
    if (wantManifest) writeFileSync(mf, JSON.stringify({ format: 'soundclaw-manifest', version: 1, project: w.project.json.name, ...(allow.length ? { allowedLicences: allow } : {}), samples: reached.map((r) => { const e = w.samples.entry(r.name); return { name: r.name, hash: r.hash, licence: r.licence.id, ...(r.licence.attribution ? { attribution: r.licence.attribution } : {}), ...(r.licence.terms ? { terms: r.licence.terms } : {}), source: e?.prov.source ?? 'file', ...(e?.prov.origin ? { origin: e.prov.origin } : {}) }; }), sounds: manifest, sets: w.sets().filter((x) => manifest.some((m) => x.members.includes(m.id))).map((x) => ({ id: x.id, members: x.members, target: x.target })) }, null, 2) + '\n');
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
