// Bringing audio into a project: reading a file (WAV, AIFF, FLAC here; OGG, MP3, M4A through ffmpeg when it is installed),
// keeping it in the store, and writing `sample add` on the tape. Decoding happens once, here; the tape holds the hash
// and the numbers that were read, and a replay or a render never decodes a compressed file (ffmpeg is an import-time
// convenience, never a render dependency).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import {
  SAMPLE_LIMITS, SAMPLE_LIMITS_TEXT, SAMPLE_NAME_RE, attributionText, sampleUsers, seconds, decodeAudio, itemLicence, noteLabel, pcmHash, pcmToWav, reachedSamples, sampleAddText, sha256Hex, sniffContainer,
  type Decoded, type ItemLicence, type LicenceState, type PcmAudio, type SampleEntry, type SampleSource, type TapeEntry,
} from '@soundclaw/core';
import { ProjectError } from './project.ts';
import { sampleQueryText } from './sampleview.ts';
import type { SampleInfo } from './samples.ts';
import type { Writer } from './writer.ts';

/** Formats ffmpeg reads for us (by the file's extension). */
const FFMPEG_EXT = new Set(['.ogg', '.oga', '.opus', '.mp3', '.m4a', '.aac', '.mp4', '.wma', '.webm']);
/** Formats read here. */
const NATIVE_EXT = new Set(['.wav', '.wave', '.aif', '.aiff', '.aifc', '.flac']);
export const IMPORT_EXTENSIONS: readonly string[] = [...NATIVE_EXT, ...FFMPEG_EXT];

export interface ImportOptions {
  /** The sample's name (one file only; a folder names each by its file). */
  as?: string;
  licence?: string;
  attribution?: string;
  terms?: string;
  /** Comma-separated tags. */
  tags?: string;
  source?: SampleSource;
  /** Where it came from, written as the origin (default: the file's name). */
  origin?: string;
  note?: string;
  /** Import past the store's 1 GB limit. */
  force?: boolean;
  /** The author on the tape. */
  by: string;
}

/** A file read, stored-ready: what `sample add` will say. */
export interface Prepared {
  name: string;
  audio: PcmAudio;
  hash: string;
  /** The `sample add` command text (date and author are settled by the writer). */
  command: string;
  notes: string[];
  file: string;
  /** The sample's facts as `sample add` will say them. */
  entry?: SampleEntry;
}

/** A readable name for a file: its stem with anything but letters, digits, _ and - turned into `_`. */
export function nameFromFile(file: string): string {
  return basename(file, extname(file)).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(0, 48);
}

/** ffmpeg's answer to "is it installed" without running anything long. */
export function ffmpegAvailable(): boolean {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 10000 });
  return !r.error && r.status === 0;
}

/** Decode a compressed file by ffmpeg into 16-bit PCM at the file's own rate and channels. */
function viaFfmpeg(bytes: Uint8Array, ext: string, label: string): Decoded {
  const dir = mkdtempSync(join(tmpdir(), 'soundclaw-in-'));
  try {
    const src = join(dir, `in${ext}`);
    const out = join(dir, 'out.wav');
    writeFileSync(src, bytes);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', src, '-map', '0:a:0', '-c:a', 'pcm_s16le', '-f', 'wav', out], { encoding: 'utf8', timeout: 120000, maxBuffer: 1 << 20 });
    if (r.error) {
      if ((r.error as NodeJS.ErrnoException).code === 'ENOENT') throw new ProjectError(`${label}: reading ${ext} files needs ffmpeg, which is not installed; install it, or convert the file to WAV first`);
      throw new ProjectError(`${label}: ffmpeg failed: ${r.error.message}`);
    }
    if (r.status !== 0 || !existsSync(out)) throw new ProjectError(`${label}: ffmpeg could not read the file${r.stderr ? ` (${r.stderr.trim().split('\n')[0]})` : ''}`);
    const d = decodeAudio(new Uint8Array(readFileSync(out)));
    d.notes.unshift(`decoded by ffmpeg to 16-bit PCM at ${d.audio.rate} Hz, ${d.audio.channels === 1 ? 'mono' : `${d.audio.channels} channels`} (the original ${ext} file's hash is kept in the provenance)`);
    return { ...d, sourceFormat: ext.slice(1) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Read audio bytes (WAV, AIFF, FLAC, or a compressed file by its extension) into stored audio and the numbers the file carried. */
export function decodeFileBytes(bytes: Uint8Array, filename: string): Decoded {
  const ext = extname(filename).toLowerCase();
  const label = basename(filename);
  if (sniffContainer(bytes)) {
    try { return decodeAudio(bytes); } catch (e) { throw new ProjectError(`${label}: ${(e as Error).message}`); }
  }
  if (FFMPEG_EXT.has(ext)) return viaFfmpeg(bytes, ext, label);
  throw new ProjectError(`${label}: not a WAV, AIFF or FLAC file${ext ? ` (${ext} is not one of ${IMPORT_EXTENSIONS.join(' ')})` : ''}; OGG, MP3 and M4A are read through ffmpeg when it is installed`);
}

/** Everything about a file that `sample add` will hold, ready to store: no writing yet. */
export function prepareImport(bytes: Uint8Array, filename: string, o: Omit<ImportOptions, 'by'> & { by?: string }): Prepared {
  const name = o.as ?? nameFromFile(filename);
  if (!SAMPLE_NAME_RE.test(name)) throw new ProjectError(`'${name}' is not a sample name (letters, digits, _ and -, at most 48 characters): give as=<name>`);
  const d = decodeFileBytes(bytes, filename);
  const { audio, meta } = d;
  const notes = [...d.notes];
  const hash = pcmHash(audio);
  const tags = (o.tags ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  const entry: SampleEntry = {
    name, hash, rate: audio.rate, channels: audio.channels, frames: audio.frames, format: audio.format, tags: [...new Set(tags)].sort(),
    prov: {
      source: o.source ?? 'file', origin: o.origin ?? basename(filename), origHash: sha256Hex(bytes),
      // a file read natively is described by its container and sample format; one that went through ffmpeg by its extension
      origFormat: sniffContainer(bytes) ? `${d.container} ${d.sourceFormat}` : extname(filename).slice(1).toLowerCase(),
    },
    licence: { id: o.licence ?? 'unknown', ...(o.attribution ? { attribution: o.attribution } : {}), ...(o.terms ? { terms: o.terms } : {}) },
  };
  if (meta.root !== undefined) { entry.root = meta.root; if (meta.tune) entry.tune = meta.tune; }
  if (meta.loop) {
    if (meta.loop.end <= audio.frames && meta.loop.start < meta.loop.end) { entry.loop = [meta.loop.start, meta.loop.end]; entry.loopMode = 'sustain'; }
    else notes.push(`the loop (frames ${meta.loop.start}-${meta.loop.end}) lies outside the audio and was not kept`);
  }
  if (meta.oneShot) entry.loopMode = 'oneshot';
  if (meta.cues?.length) {
    const cues = meta.cues.filter((c) => c < audio.frames).slice(0, 1024);
    if (cues.length) entry.slices = cues;
  }
  const text = [
    ...(o.note ? [o.note] : []),
    ...Object.entries(meta.info ?? {}).filter(([, t]) => t).map(([k, t]) => `${k}: ${t}`),
    ...(meta.tempo ? [`tempo ${meta.tempo} BPM`] : []),
  ].join('; ');
  if (text) entry.note = text.slice(0, 400);
  return { name, audio, hash, command: sampleAddText(entry), notes, file: filename, entry };
}

export interface ImportedItem {
  info: SampleInfo;
  /** False: the name was in the project already with this audio. */
  created: boolean;
  notes: string[];
  /** Other names that stand for the same audio (it is kept once). */
  sameAs: string[];
}

export interface ImportResult {
  items: ImportedItem[];
  problems: string[];
  warnings: string[];
  group: string | null;
}

/**
 * Put prepared files in the store and their names on the tape, as one undo group. A file whose name is in the project with other
 * audio is a problem and the others still go in.
 */
export function commitImports(w: Writer, prepared: Prepared[], o: Pick<ImportOptions, 'by' | 'force'> & { extra?: string[] }): ImportResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const items: ImportedItem[] = [];
  const lib = w.sampleEntries();
  const taken = new Map<string, string>(); // lower-case name -> hash, for names this batch adds
  const todo: Prepared[] = [];
  const already: Prepared[] = [];
  for (const p of prepared) {
    const have = lib.get(p.name) ?? w.samples.entry(p.name);
    const clash = [...lib.keys(), ...taken.keys()].find((k) => k.toLowerCase() === p.name.toLowerCase() && k !== p.name);
    if (clash) { problems.push(`${basename(p.file)}: sample '${p.name}' clashes with the sample '${clash}': names are unique ignoring case; give a different name (as=<name>)`); continue; }
    if (have && have.hash === p.hash) { already.push(p); continue; }
    if (have || taken.has(p.name)) { problems.push(`${basename(p.file)}: sample '${p.name}' exists with other audio; give a different name (as=<name>), or point the name at this audio with sample set ${p.name} hash=${p.hash.slice(0, 12)}… after importing it under another name`); continue; }
    taken.set(p.name, p.hash);
    todo.push(p);
  }
  // the store's size
  const have = w.samples.store.totalBytes();
  const adding = todo.filter((p) => !w.samples.store.has(p.hash)).reduce((n, p) => n + pcmToWav(p.audio).length, 0);
  if (have + adding > SAMPLE_LIMITS.refuseStoreBytes && !o.force) throw new ProjectError(`the sample store is ${(have / 1048576).toFixed(0)} MB and this import adds ${(adding / 1048576).toFixed(0)} MB: past ${SAMPLE_LIMITS.refuseStoreBytes / 1048576} MB an import needs --force (limits: ${SAMPLE_LIMITS_TEXT})`);
  if (have + adding > SAMPLE_LIMITS.warnStoreBytes) warnings.push(`the sample store is ${((have + adding) / 1048576).toFixed(0)} MB (a warning past ${SAMPLE_LIMITS.warnStoreBytes / 1048576} MB); git keeps every object, so see \`soundclaw sample git-lfs\``);
  const sameAs = (hash: string, except: string) => [...lib.values()].filter((e) => e.hash === hash && e.name !== except).map((e) => e.name);
  const created = new Map<string, boolean>();
  for (const p of todo) created.set(p.name, w.samples.store.put(p.audio, p.hash).created);
  let group: string | null = null;
  if (todo.length || o.extra?.length) {
    const r = w.run({ commands: [...todo.map((p) => p.command), ...(o.extra ?? [])].join('\n'), by: o.by });
    if (!r.ok) throw new ProjectError(r.errors.map((e) => e.message).join('\n'));
    group = r.group;
  }
  for (const p of [...todo, ...already]) {
    const info = w.samples.info(p.name)!;
    const same = sameAs(p.hash, p.name);
    const notes = [...p.notes];
    if (same.length && created.get(p.name) === false) notes.push(`the same audio as ${same.map((n) => `'${n}'`).join(', ')}: kept once in the store, this name added`);
    items.push({ info, created: todo.includes(p), notes, sameAs: same });
  }
  return { items, problems, warnings, group };
}

/** The audio files directly in a folder (not its sub-folders), in name order. */
export function audioFilesIn(dir: string): string[] {
  const path = resolve(dir);
  return readdirSync(path).filter((f) => IMPORT_EXTENSIONS.includes(extname(f).toLowerCase()) && statSync(join(path, f)).isFile()).sort().map((f) => join(path, f));
}

function readFileChecked(file: string): Uint8Array {
  const st = statSync(file);
  if (st.size > SAMPLE_LIMITS.maxFileBytes) throw new ProjectError(`${basename(file)}: ${(st.size / 1048576).toFixed(0)} MB; ${SAMPLE_LIMITS_TEXT}`);
  return new Uint8Array(readFileSync(file));
}

/** `sample import`: a file, or every audio file in a folder (one undo group). */
export function importPath(w: Writer, path: string, o: ImportOptions): ImportResult {
  const p = resolve(path);
  if (!existsSync(p)) throw new ProjectError(`no file ${path}`);
  if (statSync(p).isDirectory()) {
    if (o.as) throw new ProjectError('as=<name> names one file, not a folder');
    const files = audioFilesIn(p);
    if (!files.length) throw new ProjectError(`no audio files in ${path} (${IMPORT_EXTENSIONS.join(' ')})`);
    const prepared: Prepared[] = [];
    const problems: string[] = [];
    const names = new Map<string, string>(); // lower-case name -> file, for names that differ only in case
    for (const f of files) {
      try {
        const pr = prepareImport(readFileChecked(f), f, o);
        const clash = names.get(pr.name.toLowerCase());
        if (clash) { problems.push(`${basename(f)}: gets the name '${pr.name}' that ${clash} has too (rename one of the files)`); continue; }
        names.set(pr.name.toLowerCase(), basename(f));
        prepared.push(pr);
      } catch (e) {
        if (e instanceof ProjectError) problems.push(e.message);
        else throw e;
      }
    }
    const r = commitImports(w, prepared, o);
    return { ...r, problems: [...problems, ...r.problems] };
  }
  const r = commitImports(w, [prepareImport(readFileChecked(p), p, o)], o);
  if (r.problems.length) throw new ProjectError(r.problems[0]!);
  return r;
}

/** What an import says: one report per sample, then the problems and warnings. */
export function importReport(r: ImportResult, sampleLine: (x: SampleInfo, created?: boolean, note?: string) => string): string {
  const lines = r.items.map((x) => sampleLine(x.info, x.created, x.notes.join('\n  ')));
  for (const wmsg of r.warnings) lines.push(`warning: ${wmsg}`);
  for (const p of r.problems) lines.push(`warning: ${p}`);
  return lines.join('\n');
}

// ---- gc -------------------------------------------------------------------------------------------------------------

const HASH_IN_TEXT = /\b[0-9a-f]{64}\b/g;

export interface GcPlan {
  /** Objects nothing references (with --drop-history: nothing in the current state references). */
  objects: { hash: string; bytes: number }[];
  /** With --drop-history: the tape entries naming an object that goes, so you can see which versions will no longer render. */
  versions: { seq: number; group: string; by: string; cmd: string }[];
  dropHistory: boolean;
}

/** The objects that can go. By default: those no line of the tape names. With dropHistory: those the current state does not reach. */
export function gcPlan(w: Writer, dropHistory: boolean): GcPlan {
  const keep = new Set<string>();
  if (dropHistory) {
    const lib = w.sampleEntries();
    const byHash = new Map<string, SampleEntry[]>();
    for (const e of lib.values()) byHash.set(e.hash, [...(byHash.get(e.hash) ?? []), e]);
    const visit = (h: string): void => {
      if (keep.has(h)) return;
      keep.add(h);
      for (const e of byHash.get(h) ?? []) for (const p of e.prov.parents ?? []) visit(p);
    };
    for (const e of lib.values()) visit(e.hash);
  } else {
    for (const t of w.tape()) for (const m of t.cmd.match(HASH_IN_TEXT) ?? []) keep.add(m);
  }
  const objects = w.samples.store.list().filter((o) => !keep.has(o.hash));
  const gone = new Set(objects.map((o) => o.hash));
  const versions: GcPlan['versions'] = dropHistory
    ? w.tape().filter((t: TapeEntry) => (t.cmd.match(HASH_IN_TEXT) ?? []).some((h) => gone.has(h))).map((t) => ({ seq: t.seq, group: t.group, by: t.by, cmd: t.cmd.length > 100 ? `${t.cmd.slice(0, 97)}...` : t.cmd }))
    : [];
  return { objects, versions, dropHistory };
}

export function gcApply(w: Writer, plan: GcPlan): void {
  for (const o of plan.objects) w.samples.store.remove(o.hash);
}

export function gcReport(plan: GcPlan, apply: boolean): string {
  const total = plan.objects.reduce((n, o) => n + o.bytes, 0);
  if (!plan.objects.length) return plan.dropHistory ? 'nothing to remove: every object is used by the current state\n' : 'nothing to remove: every object is named on the tape\n';
  const lines = [`${apply ? 'removed' : 'would remove'} ${plan.objects.length} object${plan.objects.length === 1 ? '' : 's'} (${(total / 1024).toFixed(1)} KB)${plan.dropHistory ? ' that only undone or replaced states used' : ' that nothing on the tape names'}`];
  for (const o of plan.objects.slice(0, 20)) lines.push(`  ${o.hash.slice(0, 12)}  ${o.bytes} bytes`);
  if (plan.objects.length > 20) lines.push(`  … and ${plan.objects.length - 20} more`);
  if (plan.versions.length) {
    lines.push(`${apply ? 'These versions no longer render with their audio' : 'These versions will no longer render with their audio'} (the tape lines that name a removed object):`);
    for (const v of plan.versions) lines.push(`  #${v.seq} ${v.group} ${v.by}: ${v.cmd}`);
  }
  if (!apply) lines.push('a dry run: add --apply to remove them');
  return lines.join('\n') + '\n';
}

// ---- upgrade --------------------------------------------------------------------------------------------------------

export interface UpgradeResult {
  moved: string[];
  skipped: string[];
  group: string | null;
}

/** Move a 0.1.x project's samples/<name>.wav files into the store, as one `sample add` group by `system:upgrade`. */
export function upgradeProject(w: Writer): UpgradeResult {
  const dir = join(w.project.dir, 'samples');
  const moved: string[] = [];
  const skipped: string[] = [];
  const prepared: { name: string; file: string; p: Prepared }[] = [];
  const lib = w.sampleEntries();
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith('.wav')) continue;
      const name = f.slice(0, -4);
      const file = join(dir, f);
      if (!SAMPLE_NAME_RE.test(name) || !statSync(file).isFile()) continue;
      if (lib.has(name)) { skipped.push(`${name}: already on the tape; the file is left where it is`); continue; }
      try {
        const bytes = new Uint8Array(readFileSync(file));
        const d = decodeAudio(bytes, { lenient: true });
        const audio = d.audio;
        const hash = pcmHash(audio);
        const e: SampleEntry = {
          name, hash, rate: audio.rate, channels: audio.channels, frames: audio.frames, format: audio.format, tags: [],
          prov: { source: 'file', origin: f, origHash: sha256Hex(bytes), origFormat: `wav ${d.sourceFormat}` }, licence: { id: 'unknown' },
        };
        prepared.push({ name, file, p: { name, audio, hash, command: sampleAddText(e), notes: [], file, entry: e } });
      } catch (err) {
        skipped.push(`${name}: ${(err as Error).message}`);
      }
    }
  }
  let group: string | null = null;
  if (prepared.length) {
    for (const x of prepared) w.samples.store.put(x.p.audio, x.p.hash);
    const r = w.run({ commands: prepared.map((x) => x.p.command).join('\n'), by: 'system:upgrade' });
    if (!r.ok) throw new ProjectError(r.errors.map((e) => e.message).join('\n'));
    group = r.group;
    for (const x of prepared) { unlinkSync(x.file); moved.push(x.name); }
    rmSync(join(w.project.dir, '.cache', 'samples.json'), { force: true });
  }
  return { moved, skipped, group };
}

// ---- licences ---------------------------------------------------------------------------------------------------------

/** Items a `licence check` covers when none is named: every sound, instrument of the project and song. */
export function licenceCheck(w: Writer, ids: string[], allow: readonly string[] = []): ItemLicence[] {
  const lib = w.sampleLibrary();
  const out: ItemLicence[] = [];
  const policy = w.samples.shipPolicy;
  const one = (kind: ItemLicence['kind'], id: string) => out.push(itemLicence(lib, kind, id, policy, allow));
  if (!ids.length) {
    for (const s of w.sounds()) one('sound', s.id);
    for (const i of w.instruments()) one('instrument', i.id);
    for (const s of w.songs()) one('song', s.id);
    return out;
  }
  for (const id of ids) {
    if (w.has(id)) one('sound', id);
    else if (w.hasSet(id)) for (const m of w.set(id).members) one('sound', m);
    else if (w.hasSong(id)) one('song', id);
    else if (lib.instruments.has(id)) one('instrument', id);
    else if (lib.samples.has(id) || w.samples.entry(id)) one('sample', id);
    else throw new ProjectError(`'${id}' is not a sound, set, song, instrument or sample of the project`);
  }
  return out;
}

const GLYPH: Record<string, string> = { shippable: '✓', attribution: '✓', unknown: '?', blocked: '✗' };

export function licenceReportText(items: ItemLicence[], policyNote: string): string {
  if (!items.length) return 'no sounds, instruments or songs to check\n';
  const lines: string[] = [];
  for (const it of items) {
    const ids = [...new Set(it.samples.map((s) => s.licence.id))];
    lines.push(`${GLYPH[it.state]} ${it.state.padEnd(11)} ${it.kind} ${it.id}${it.samples.length ? `  (${ids.join(', ')})` : '  (no samples)'}`);
    for (const s of it.samples) {
      if (s.state === 'shippable' && items.length > 1) continue;
      lines.push(`    ${GLYPH[s.state]} sample ${s.name} ${s.hash.slice(0, 12)} ${s.licence.id}${s.via === 'parent' ? ' (a parent)' : ''}: ${s.reason}`);
    }
  }
  const worst = items.filter((i) => i.state === 'blocked' || i.state === 'unknown');
  lines.push(`${items.length} item${items.length === 1 ? '' : 's'}: ${items.filter((i) => i.state === 'shippable').length} shippable, ${items.filter((i) => i.state === 'attribution').length} with attribution, ${items.filter((i) => i.state === 'unknown').length} unknown, ${items.filter((i) => i.state === 'blocked').length} blocked`);
  if (worst.length) lines.push('Manifest exports (--all, --set, --pack) refuse these unless --allow-licence <id> is given. SoundClaw records licences; it gives no legal advice.');
  lines.push(policyNote);
  return lines.join('\n') + '\n';
}

export { attributionText, reachedSamples, noteLabel };

// ---- listing ------------------------------------------------------------------------------------------------------------

const STATE_WORD: Record<LicenceState, string> = { shippable: '✓ shippable', attribution: '✓ attribution', unknown: '? unknown', blocked: '✗ blocked' };

/** `sample list`: one line per sample. */
export function sampleListText(w: Writer, query?: string, o: { json?: boolean } = {}): string {
  if (query || o.json) return sampleQueryText(w, query, o) + '\n';
  const all = w.samples.all();
  if (!all.length) return 'no samples (soundclaw sample import <project> <file or folder>)\n';
  return all.map((x) => {
    const e = x.entry;
    const info = w.samples.infoOf(x);
    const ch = e.channels === 1 ? 'mono' : e.channels === 2 ? 'stereo' : `${e.channels} ch`;
    return `${e.name}: ${seconds(e).toFixed(3)} s, ${e.rate} Hz, ${ch}, ${e.format}${e.root !== undefined ? `, root ${noteLabel(e.root)}` : ''}, ${STATE_WORD[info.licenceState]} (${e.licence.id}), ${e.prov.source}${e.tags.length ? `, tags ${e.tags.join(',')}` : ''}, hash ${e.hash.slice(0, 12)}${x.legacy ? '  [a 0.1 file: `soundclaw upgrade` moves it into the store]' : ''}`;
  }).join('\n') + '\n';
}

/** `sample show`: everything about one sample. */
export function sampleShowText(w: Writer, name: string): string {
  const x = w.samples.all().find((y) => y.entry.name === name);
  if (!x) throw new ProjectError(`no sample '${name}'${w.samples.names().length ? ` (samples: ${w.samples.names().join(', ')})` : ''}`);
  const e = x.entry;
  const info = w.samples.infoOf(x);
  const lines = [
    `sample ${e.name}${x.legacy ? ' (a 0.1 file, not on the tape yet)' : ''}`,
    `  audio: ${seconds(e).toFixed(3)} s, ${e.rate} Hz, ${e.channels} channel${e.channels === 1 ? '' : 's'}, ${e.format}, ${e.frames} frames, ${x.bytes} bytes stored`,
    `  hash: ${e.hash}`,
  ];
  const meta: string[] = [];
  if (e.root !== undefined) meta.push(`root ${noteLabel(e.root)}${e.tune ? ` ${e.tune > 0 ? '+' : ''}${e.tune} cents` : ''}`);
  if (e.loop) meta.push(`loop frames ${e.loop[0]}-${e.loop[1]} (${e.loopMode ?? 'sustain'})`);
  else if (e.loopMode) meta.push(`loop mode ${e.loopMode}`);
  if (e.slices?.length) meta.push(`${e.slices.length} slice points`);
  if (e.gain !== undefined) meta.push(`gain ${e.gain} dB`);
  if (e.tags.length) meta.push(`tags ${e.tags.join(', ')}`);
  if (meta.length) lines.push(`  metadata: ${meta.join('; ')}`);
  if (e.note) lines.push(`  note: ${e.note}`);
  const p = e.prov;
  const prov = [`source ${p.source}`, ...(p.origin ? [`origin ${p.origin}`] : []), ...(p.origFormat ? [`was ${p.origFormat}`] : []), ...(p.date ? [`on ${p.date}`] : []), ...(p.author ? [`by ${p.author}`] : [])];
  lines.push(`  provenance: ${prov.join(', ')}`);
  if (p.origHash) lines.push(`    original file hash: ${p.origHash}`);
  if (p.provider) lines.push(`    generated by ${p.provider}${p.endpoint ? ` ${p.endpoint}` : ''}${p.model ? ` (${p.model})` : ''}${p.take ? `, take ${p.take}` : ''}${p.credits !== undefined ? `, ${p.credits} credits` : ''}${p.request ? `, request ${p.request}` : ''}${p.seed !== undefined ? `, seed ${p.seed}` : ''}`);
  if (p.prompt) lines.push(`    prompt: ${p.prompt}`);
  if (p.params) lines.push(`    parameters: ${p.params}`);
  if (p.parents?.length) lines.push(`    parents: ${p.parents.map((h) => h.slice(0, 12)).join(', ')}${p.ops ? `; operations: ${p.ops}` : ''}`);
  lines.push(`  licence: ${e.licence.id} (${STATE_WORD[info.licenceState]})${e.licence.attribution ? `; attribution: ${e.licence.attribution}` : ''}${e.licence.terms ? `; terms ${e.licence.terms}` : ''}`);
  const users = sampleUsers(w.sampleLibrary()).get(name);
  lines.push(`  used by: ${users?.length ? users.join(', ') : 'nothing yet'}`);
  return lines.join('\n') + '\n';
}

/** The lines `.gitattributes` takes to keep the store's objects in Git LFS (nothing requires it). */
export function gitLfsLines(): string {
  return '# optional: keep sample audio in Git LFS (plain git works too)\nsamples/objects/**/*.wav filter=lfs diff=lfs merge=lfs -text\n';
}

/** One line saying which policy a report was made under. */
export function licencePolicyNote(w: Writer): string {
  const p = w.samples.shipPolicy;
  return `policy: ships ${p.allow.join(', ')}; blocks ${p.block.join(', ')} (project.json "licences" changes it)`;
}
