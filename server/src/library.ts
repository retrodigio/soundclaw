// Sample libraries: folders of recordings outside any project, registered per user. `library add` records the folder and what it
// declares about its licence; `library index` reads, hashes and measures every audio file once (in worker threads, and again only
// for files that changed); `library search` and `library similar` rank files by words and by the numbers; `library use` copies one
// file into a project's store with its provenance and the library's licence. Libraries are never copied whole into a project (a
// project holds only the audio it uses), and nothing here reads the network.
//
// Where things live (never in a project):
//   registry   <config>/libraries.json            the libraries, their folders and declared licences
//   tags       <config>/library-tags/<id>.json    tags a person or agent added to files (not regenerable, so not a cache)
//   index      <cache>/library/<id>.index.jsonl   one header line, then one line per file

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  DEFAULT_SHIP_POLICY, LIBRARY_ID_RE, LICENCE_FILES, MANIFEST_FILE, SAMPLE_LIMITS, bandEnergies, decodeMeasure, fileOneLiner, libraryIdFrom, licenceFromText,
  licenceIdOk, licenceState, measureSample, noteLabel, parseLibraryManifest, parseQuery, searchFiles, similarDistance, similarVector, splitLibraryRef,
  type IndexedFile, type IndexedFileView, type LibraryDeclaration, type LibraryHit, type LibraryRef, type SampleLicence, type ShipPolicy,
} from '@soundclaw/core';
import { compareSide, readAudioFile } from './ears.ts';
import { indexOneFile, type IndexJob } from './libraryindex.ts';
import type { IndexBatch, IndexBatchReply } from './library-worker.ts';
import { ProjectError } from './project.ts';
import { commitImports, IMPORT_EXTENSIONS, nameFromFile, prepareImport, type ImportResult } from './sampleimport.ts';
import { licenceGlyph } from './sampleview.ts';
import type { Writer } from './writer.ts';

// ---- where things live ---------------------------------------------------------------------------------------------

/** User settings: SOUNDCLAW_CONFIG_DIR, else $XDG_CONFIG_HOME/soundclaw, else ~/.soundclaw. */
export function configDir(): string {
  const env = process.env.SOUNDCLAW_CONFIG_DIR;
  if (env) return resolve(env);
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, 'soundclaw') : join(homedir(), '.soundclaw');
}

/**
 * Where a platform keeps caches: macOS ~/Library/Caches/soundclaw; Windows %LOCALAPPDATA%\soundclaw\cache; elsewhere $XDG_CACHE_HOME/soundclaw,
 * else ~/.cache/soundclaw.
 */
export function platformCacheDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'soundclaw');
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'soundclaw', 'cache');
  return env.XDG_CACHE_HOME ? join(env.XDG_CACHE_HOME, 'soundclaw') : join(home, '.cache', 'soundclaw');
}

/** The cache folder earlier versions used when nothing was set. */
export const legacyCacheDir = (home: string): string => join(home, '.soundclaw', 'cache');

let movedFrom: string | null = null;

/**
 * Move the cache an earlier version kept in ~/.soundclaw/cache to the platform's cache folder, once: only when the old folder exists and the new
 * one does not. A move that fails (another disk, say) leaves the old folder, and the index is built again where it now lives.
 */
export function moveLegacyCache(home: string, to: string): boolean {
  const from = legacyCacheDir(home);
  if (from === to || !existsSync(from) || existsSync(to)) return false;
  try {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    movedFrom = from;
    return true;
  } catch {
    return false;
  }
}

/** Where the cache was moved from in this process, if it was (for a note). */
export const cacheMovedFrom = (): string | null => movedFrom;

/** Things that can be built again: SOUNDCLAW_CACHE_DIR, else the platform's cache folder (see platformCacheDir). */
export function cacheDir(): string {
  const env = process.env.SOUNDCLAW_CACHE_DIR;
  if (env) return resolve(env);
  const home = homedir();
  const dir = platformCacheDir(process.platform, process.env, home);
  moveLegacyCache(home, dir);
  return dir;
}

const registryFile = (): string => join(configDir(), 'libraries.json');
const tagsFile = (id: string): string => join(configDir(), 'library-tags', `${id}.json`);
const indexFile = (id: string): string => join(cacheDir(), 'library', `${id}.index.jsonl`);

/** Write a file whole or not at all. */
function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// ---- the registry --------------------------------------------------------------------------------------------------

export interface LibraryEntry {
  id: string;
  /** The folder, absolute and real. */
  dir: string;
  name?: string;
  description?: string;
  /** The declared licence (an id), with the words it asks for; absent when nothing was declared (then `unknown`). */
  licence?: string;
  attribution?: string;
  terms?: string;
  /** Where the declaration came from. */
  declared: 'flags' | 'manifest' | 'licence-file' | 'none';
  added: string;
}

interface Registry {
  libraries: LibraryEntry[];
}

export function readRegistry(): LibraryEntry[] {
  const f = registryFile();
  if (!existsSync(f)) return [];
  try {
    const j = JSON.parse(readFileSync(f, 'utf8')) as Registry;
    return Array.isArray(j.libraries) ? j.libraries : [];
  } catch (e) {
    throw new ProjectError(`${f} is not readable (${(e as Error).message}); fix it or remove it (the libraries are only folders)`);
  }
}

function writeRegistry(libraries: LibraryEntry[]): void {
  writeAtomic(registryFile(), JSON.stringify({ libraries }, null, 1) + '\n');
}

export function getLibrary(id: string): LibraryEntry {
  const e = readRegistry().find((x) => x.id === id);
  if (!e) {
    const ids = readRegistry().map((x) => x.id);
    throw new ProjectError(`no library '${id}'${ids.length ? ` (libraries: ${ids.join(', ')})` : ' (none registered: soundclaw library add <folder>)'}`);
  }
  return e;
}

export const licenceOf = (e: LibraryEntry): SampleLicence => ({ id: e.licence ?? 'unknown', ...(e.attribution ? { attribution: e.attribution } : {}), ...(e.terms ? { terms: e.terms } : {}) });
const refOf = (e: LibraryEntry): LibraryRef => ({ id: e.id, licence: licenceOf(e) });

export interface AddOptions {
  name?: string;
  licence?: string;
  attribution?: string;
  terms?: string;
  /** Accept a licence read from a licence file's text. */
  yes?: boolean;
}

export interface AddResult {
  entry: LibraryEntry;
  notes: string[];
}

function readText(file: string): string | null {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

/** What the folder says about itself: soundclaw-library.json, else a licence file's text (a proposal). */
export function readDeclaration(dir: string): { decl: LibraryDeclaration | null; notes: string[] } {
  const notes: string[] = [];
  const manifest = readText(join(dir, MANIFEST_FILE));
  if (manifest !== null) {
    try { return { decl: parseLibraryManifest(manifest), notes }; } catch (e) { throw new ProjectError((e as Error).message); }
  }
  const files = readdirSync(dir);
  for (const want of LICENCE_FILES) {
    const f = files.find((x) => x.toLowerCase() === want);
    if (!f) continue;
    const text = readText(join(dir, f));
    if (text === null) continue;
    const found = licenceFromText(text);
    if (found) return { decl: { from: 'licence-file', licence: found.id, basis: `${f}: ${found.basis}` }, notes };
    notes.push(`${f} is there but does not name a licence outright (an SPDX-License-Identifier line, CC0 or a Creative Commons title): the licence stays unknown; set it with licence=<id> or a ${MANIFEST_FILE}`);
    break;
  }
  return { decl: null, notes };
}

/** Register a folder as a library. */
export function addLibrary(dirArg: string, o: AddOptions = {}): AddResult {
  const p = resolve(dirArg);
  if (!existsSync(p) || !statSync(p).isDirectory()) throw new ProjectError(`${dirArg} is not a folder`);
  const dir = realpathSync(p);
  const libs = readRegistry();
  const same = libs.find((l) => l.dir === dir);
  if (same) throw new ProjectError(`${dirArg} is already the library '${same.id}'`);
  const { decl, notes } = readDeclaration(dir);
  const id = o.name ?? libraryIdFrom(decl?.name ?? basename(dir));
  if (!LIBRARY_ID_RE.test(id)) throw new ProjectError(`'${id}' is not a library id (lower-case letters, digits, _ and -, at most 32 characters): give --name <id>`);
  if (libs.some((l) => l.id === id)) throw new ProjectError(`there is a library '${id}' already (${libs.find((l) => l.id === id)!.dir}): give --name <id>`);
  if (o.licence !== undefined && !licenceIdOk(o.licence)) throw new ProjectError(`'${o.licence}' is not a licence id (an SPDX id such as CC0-1.0 or CC-BY-4.0, own, unknown, generated:<provider>:<plan> or proprietary:<note>)`);
  const entry: LibraryEntry = { id, dir, declared: 'none', added: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
  if (decl?.name) entry.name = decl.name;
  if (decl?.description) entry.description = decl.description;
  if (o.licence !== undefined) {
    entry.licence = o.licence;
    entry.declared = 'flags';
    if (o.attribution) entry.attribution = o.attribution;
    if (o.terms) entry.terms = o.terms;
    if (decl?.licence && decl.licence !== o.licence) notes.push(`the folder declares ${decl.licence} (${decl.from === 'manifest' ? MANIFEST_FILE : decl.basis}); you gave ${o.licence}, which is used`);
  } else if (decl?.licence) {
    if (decl.from === 'licence-file' && !o.yes) {
      throw new ProjectError(`${decl.basis}\nthe licence file reads as ${decl.licence}; that is a reading of its text, not a declaration. Confirm it with --yes, or give licence=<id> (or write a ${MANIFEST_FILE})`);
    }
    entry.licence = decl.licence;
    entry.declared = decl.from;
    if (decl.attribution || o.attribution) entry.attribution = o.attribution ?? decl.attribution;
    if (decl.terms || o.terms) entry.terms = o.terms ?? decl.terms;
    notes.push(`licence ${decl.licence}, ${decl.from === 'manifest' ? `declared in ${MANIFEST_FILE}` : `read from ${decl.basis} and confirmed`}`);
  } else {
    if (o.attribution) entry.attribution = o.attribution;
    if (o.terms) entry.terms = o.terms;
    notes.push(`no licence declared: every file reads as unknown until you set one (library remove ${id}, then add it again with licence=<id>, or write a ${MANIFEST_FILE})`);
  }
  writeRegistry([...libs, entry]);
  return { entry, notes };
}

/** How many files of a library carry tags added by hand (they cannot be rebuilt). */
export function handTagCount(id: string): number {
  return Object.values(readTags(id)).filter((t) => t.length).length;
}

/**
 * Forget a library: its entry, its index and the tags added to its files by hand. The folder is never touched. Hand tags cannot be rebuilt, so
 * when there are any it needs `yes`, and says how many it drops. Returns the number of files whose hand tags went.
 */
export function removeLibrary(id: string, o: { yes?: boolean } = {}): number {
  getLibrary(id);
  const tagged = handTagCount(id);
  if (tagged && !o.yes) throw new ProjectError(`library ${id} has tags added by hand on ${tagged} file${tagged === 1 ? '' : 's'}; removing it drops them (they cannot be rebuilt from the folder): give --yes to remove it anyway`);
  writeRegistry(readRegistry().filter((l) => l.id !== id));
  rmSync(indexFile(id), { force: true });
  rmSync(tagsFile(id), { force: true });
  loaded.delete(id);
  return tagged;
}

// ---- tags added by hand --------------------------------------------------------------------------------------------

function readTags(id: string): Record<string, string[]> {
  const t = readText(tagsFile(id));
  if (t === null) return {};
  try { return JSON.parse(t) as Record<string, string[]>; } catch { return {}; }
}

const TAG_RE = /^[a-z0-9][a-z0-9 _-]{0,30}$/;

/** Add (or remove) tags on one file of a library; the tags live outside the index, so an index rebuild keeps them. */
export function tagFile(id: string, path: string, tags: string[], remove = false): string[] {
  getLibrary(id);
  const clean = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  for (const t of clean) if (!TAG_RE.test(t)) throw new ProjectError(`'${t}' is not a tag (lower-case letters, digits, space, _ and -, at most 31 characters)`);
  if (!clean.length) throw new ProjectError('give at least one tag');
  const idx = loadIndex(id);
  if (idx && !idx.files.some((f) => f.path === path)) throw new ProjectError(`library ${id} has no indexed file '${path}' (soundclaw library search shows the paths)`);
  const all = readTags(id);
  const have = new Set(all[path] ?? []);
  for (const t of clean) { if (remove) have.delete(t); else have.add(t); }
  if (have.size) all[path] = [...have].sort(); else delete all[path];
  writeAtomic(tagsFile(id), JSON.stringify(all, null, 1) + '\n');
  return all[path] ?? [];
}

// ---- the index -----------------------------------------------------------------------------------------------------

interface LibraryIndex {
  built: string;
  files: IndexedFile[];
}

const loaded = new Map<string, { key: string; idx: LibraryIndex }>();

/** The index of a library, or null when it was never built. Kept in memory while its file stays the same. */
export function loadIndex(id: string): LibraryIndex | null {
  const f = indexFile(id);
  if (!existsSync(f)) { loaded.delete(id); return null; }
  const st = statSync(f);
  const key = `${f}:${st.size}:${Math.floor(st.mtimeMs)}`;
  const have = loaded.get(id);
  if (have?.key === key) return have.idx;
  const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
  let head: { soundclawLibraryIndex?: number; built?: string };
  try { head = JSON.parse(lines[0]!) as typeof head; } catch { head = {}; }
  if (head.soundclawLibraryIndex !== 1) throw new ProjectError(`the index of library ${id} is not one this version reads: rebuild it with soundclaw library index ${id} --rebuild`);
  const idx: LibraryIndex = { built: head.built ?? '', files: lines.slice(1).map((l) => JSON.parse(l) as IndexedFile) };
  loaded.set(id, { key, idx });
  return idx;
}

function writeIndex(id: string, idx: LibraryIndex): void {
  writeAtomic(indexFile(id), `${JSON.stringify({ soundclawLibraryIndex: 1, library: id, built: idx.built, files: idx.files.length })}\n${idx.files.map((f) => JSON.stringify(f)).join('\n')}\n`);
  loaded.delete(id);
}

/** The audio files under a folder (its sub-folders too), as `/` paths, in name order. Hidden files and links are not followed or listed. */
export function scanLibrary(dir: string): IndexJob[] {
  const out: IndexJob[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      if (d.name.startsWith('.') || d.isSymbolicLink()) continue;
      const a = join(abs, d.name);
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(a, r);
      else if (d.isFile() && IMPORT_EXTENSIONS.includes(extname(d.name).toLowerCase())) {
        const st = statSync(a);
        out.push({ path: r, size: st.size, mtime: Math.floor(st.mtimeMs) });
      }
    }
  };
  walk(dir, '');
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The worker script: next to the bundle (library-worker.js) or, from the sources, the TypeScript file. */
function workerFile(): URL {
  const js = new URL('./library-worker.js', import.meta.url);
  return existsSync(fileURLToPath(js)) ? js : new URL('./library-worker.ts', import.meta.url);
}

/** How many worker threads the index uses: SOUNDCLAW_INDEX_WORKERS, else one fewer than the cores, between 1 and 6. */
export function defaultWorkers(): number {
  const env = Number(process.env.SOUNDCLAW_INDEX_WORKERS);
  if (Number.isInteger(env) && env >= 0) return env;
  return Math.min(6, Math.max(1, cpus().length - 1));
}

const BATCH = 8;
/** The error of a compressed file when ffmpeg is not installed: the index tries such a file again next time. */
const NEEDS_FFMPEG = /needs ffmpeg, which is not installed/;

/** Measure files, on `workers` threads (0: in this thread). */
export async function measureFiles(root: string, jobs: IndexJob[], workers: number, onProgress?: (done: number, total: number) => void): Promise<IndexedFile[]> {
  if (!jobs.length) return [];
  if (workers <= 0 || jobs.length <= BATCH) {
    const out: IndexedFile[] = [];
    for (const j of jobs) { out.push(indexOneFile(root, j)); onProgress?.(out.length, jobs.length); }
    return out;
  }
  const batches: IndexBatch[] = [];
  for (let i = 0; i < jobs.length; i += BATCH) batches.push({ id: batches.length, root, files: jobs.slice(i, i + BATCH) });
  const results = new Array<IndexedFile[]>(batches.length);
  let next = 0, done = 0;
  const pool: Worker[] = [];
  return new Promise<IndexedFile[]>((resolveP, reject) => {
    let finished = false;
    const stop = (): void => { finished = true; for (const w of pool) void w.terminate(); };
    const fail = (e: Error): void => { if (finished) return; stop(); reject(new ProjectError(`the index worker failed: ${e.message}`)); };
    for (let i = 0; i < Math.min(workers, batches.length); i++) {
      const w = new Worker(workerFile());
      pool.push(w);
      w.on('message', (m: IndexBatchReply) => {
        if (finished) return;
        results[m.id] = m.entries;
        done += m.entries.length;
        onProgress?.(done, jobs.length);
        if (done === jobs.length) { stop(); resolveP(results.flat()); } else if (next < batches.length) w.postMessage(batches[next++]!);
      });
      w.on('error', fail);
      // a worker that stops on its own (not because the index is finished or failed) is a failure
      w.on('exit', (code) => { if (!finished) fail(new Error(`a worker stopped (${code})`)); });
      w.postMessage(batches[next++]!);
    }
  });
}

export interface IndexStats {
  id: string;
  files: number;
  measured: number;
  reused: number;
  removed: number;
  errors: number;
  /** Files that need ffmpeg, which is not installed. */
  needFfmpeg: number;
  seconds: number;
}

export interface IndexOptions {
  /** Measure every file again. */
  rebuild?: boolean;
  workers?: number;
  onProgress?: (done: number, total: number) => void;
}

/** Build or update a library's index: files whose size and time stamp are as before keep their entry. */
export async function indexLibrary(id: string, o: IndexOptions = {}): Promise<IndexStats> {
  const lib = getLibrary(id);
  if (!existsSync(lib.dir) || !statSync(lib.dir).isDirectory()) throw new ProjectError(`the folder of library ${id} is gone: ${lib.dir} (library remove ${id}, or put it back)`);
  const t0 = Date.now();
  const list = scanLibrary(lib.dir);
  const prev = new Map((o.rebuild ? [] : loadIndex(id)?.files ?? []).map((f) => [f.path, f] as const));
  const stale = (j: IndexJob): boolean => {
    const p = prev.get(j.path);
    return !p || p.size !== j.size || p.mtime !== j.mtime || (!!p.error && NEEDS_FFMPEG.test(p.error));
  };
  const todo = list.filter(stale);
  const fresh = new Map((await measureFiles(lib.dir, todo, o.workers ?? defaultWorkers(), o.onProgress)).map((f) => [f.path, f] as const));
  const files = list.map((j) => fresh.get(j.path) ?? prev.get(j.path)!);
  const kept = new Set(list.map((j) => j.path));
  const removed = [...prev.keys()].filter((p) => !kept.has(p)).length;
  writeIndex(id, { built: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), files });
  return {
    id, files: files.length, measured: todo.length, reused: files.length - todo.length, removed, errors: files.filter((f) => f.error).length,
    needFfmpeg: files.filter((f) => f.error && NEEDS_FFMPEG.test(f.error)).length, seconds: (Date.now() - t0) / 1000,
  };
}

export function indexStatsText(s: IndexStats): string {
  const lines = [`library ${s.id}: ${s.files} file${s.files === 1 ? '' : 's'} indexed in ${s.seconds.toFixed(1)} s (${s.measured} read, ${s.reused} unchanged${s.removed ? `, ${s.removed} gone` : ''})`];
  if (s.needFfmpeg) lines.push(`warning: ${s.needFfmpeg} file${s.needFfmpeg === 1 ? ' needs' : 's need'} ffmpeg, which is not installed: install it and run the index again, or convert them to WAV`);
  if (s.errors - s.needFfmpeg > 0) lines.push(`warning: ${s.errors - s.needFfmpeg} file${s.errors - s.needFfmpeg === 1 ? '' : 's'} could not be read and ${s.errors - s.needFfmpeg === 1 ? 'is' : 'are'} skipped by search (the reason is in the index file)`);
  return lines.join('\n');
}

// ---- listing -------------------------------------------------------------------------------------------------------

export interface LibraryInfo extends LibraryEntry {
  indexed: boolean;
  files: number;
  built?: string;
  errors: number;
}

export function listLibraries(): LibraryInfo[] {
  return readRegistry().map((e) => {
    const idx = loadIndex(e.id);
    return { ...e, indexed: !!idx, files: idx?.files.length ?? 0, ...(idx ? { built: idx.built } : {}), errors: idx?.files.filter((f) => f.error).length ?? 0 };
  });
}

export function listText(libs: LibraryInfo[]): string {
  if (!libs.length) return 'no libraries registered (soundclaw library add <folder> [--name <id>] [licence=<id>])\n';
  return libs.map((l) => `${l.id}  ${l.dir}\n  licence ${l.licence ?? 'unknown'}${l.declared === 'none' ? ' (nothing declared)' : l.declared === 'manifest' ? ` (declared in ${MANIFEST_FILE})` : l.declared === 'licence-file' ? ' (read from its licence file)' : ' (given at add)'}${l.attribution ? `, attribution "${l.attribution}"` : ''}\n  ${l.indexed ? `${l.files} files indexed ${l.built}${l.errors ? `, ${l.errors} unreadable` : ''}` : `not indexed: soundclaw library index ${l.id}`}`).join('\n') + '\n';
}

// ---- search --------------------------------------------------------------------------------------------------------

export interface SearchOptions {
  /** Only this library (default: all that are indexed). */
  library?: string;
  limit?: number;
  /** The ship policy that `licence=shippable` is judged by (default: the built-in one). */
  policy?: ShipPolicy;
}

function entriesOf(libs: LibraryEntry[]): { entries: { lib: LibraryRef; file: IndexedFileView }[]; notIndexed: string[] } {
  const entries: { lib: LibraryRef; file: IndexedFileView }[] = [];
  const notIndexed: string[] = [];
  for (const e of libs) {
    const idx = loadIndex(e.id);
    if (!idx) { notIndexed.push(e.id); continue; }
    const extra = readTags(e.id);
    const lib = refOf(e);
    for (const f of idx.files) entries.push({ lib, file: extra[f.path] ? { ...f, extraTags: extra[f.path]! } : f });
  }
  return { entries, notIndexed };
}

function pickLibraries(library?: string): LibraryEntry[] {
  const all = readRegistry();
  if (library) return [getLibrary(library)];
  if (!all.length) throw new ProjectError('no libraries registered (soundclaw library add <folder> [--name <id>] [licence=<id>])');
  return all;
}

export interface FoundHit {
  hit: LibraryHit;
  /** For `similar`: the distance in the feature space. */
  distance?: number;
}

export interface SearchResult {
  hits: FoundHit[];
  total: number;
  notIndexed: string[];
  query: string;
}

function parse(queryText: string): ReturnType<typeof parseQuery> {
  try { return parseQuery(queryText); } catch (e) { throw new ProjectError(`library: ${(e as Error).message}`); }
}

export function searchLibraries(queryText: string, o: SearchOptions = {}): SearchResult {
  const q = parse(queryText);
  const { entries, notIndexed } = entriesOf(pickLibraries(o.library));
  if (!entries.length && notIndexed.length) throw new ProjectError(`${notIndexed.length === 1 ? `library ${notIndexed[0]} has` : `libraries ${notIndexed.join(', ')} have`} no index: soundclaw library index ${notIndexed.join(' ')}`);
  const hits = searchFiles(entries, q, o.policy);
  return { hits: hits.slice(0, o.limit ?? 20).map((hit) => ({ hit })), total: hits.length, notIndexed, query: queryText };
}

/**
 * Files like a sound, sample or audio file: nearest first by the feature vector (SIMILAR_FEATURES), among those the query keeps. With no project
 * (`w` null) the reference is an audio file.
 */
export function similarLibraries(w: Writer | null, ref: string, queryText: string, o: SearchOptions = {}): SearchResult & { reference: string } {
  const q = parse(queryText);
  const { entries, notIndexed } = entriesOf(pickLibraries(o.library));
  if (!entries.length && notIndexed.length) throw new ProjectError(`no index: soundclaw library index ${notIndexed.join(' ')}`);
  const side = w ? compareSide(w, ref) : readAudioFile(ref);
  const m = measureSample([side.samples], 44100, { maxSeconds: 20 });
  const target = similarVector(m, bandEnergies(side.samples));
  const hits = searchFiles(entries, q, o.policy);
  const ranked: FoundHit[] = [];
  for (const hit of hits) {
    if (!hit.file.measure) continue;
    const v = similarVector(decodeMeasure(hit.file.measure), hit.file.bands ?? []);
    ranked.push({ hit, distance: similarDistance(target, v) });
  }
  ranked.sort((a, b) => a.distance! - b.distance! || (a.hit.file.path < b.hit.file.path ? -1 : 1));
  return { hits: ranked.slice(0, o.limit ?? 10), total: ranked.length, notIndexed, query: queryText, reference: side.label };
}

const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : '-inf');

/** One hit as a line. */
export function hitLine(h: FoundHit, policyState?: (l: SampleLicence) => string): string {
  const { lib, file } = h.hit;
  const m = file.measure ? decodeMeasure(file.measure) : null;
  const state = policyState ? policyState(lib.licence) : licenceState(lib.licence, DEFAULT_SHIP_POLICY).state;
  const pitch = m?.pitch && m.pitched ? m.pitch.note : file.meta?.root !== undefined ? noteLabel(file.meta.root) : '-';
  const parts = [
    `${lib.id}:${file.path}`,
    m ? `${m.duration.toFixed(2)} s  ${f1(m.lufs)} LUFS  ${pitch}  centroid ${Math.round(m.centroid)} Hz  attack ${m.attackMs < 10 ? m.attackMs.toFixed(1) : Math.round(m.attackMs)} ms` : 'unreadable',
    `${licenceGlyph(state)} ${state} (${lib.licence.id})`,
    ...(h.distance !== undefined ? [`distance ${h.distance.toFixed(2)}`] : []),
    fileOneLiner(file),
  ];
  return parts.join('  ');
}

export function searchText(r: SearchResult, policyState?: (l: SampleLicence) => string): string {
  const lines = r.hits.map((h) => hitLine(h, policyState));
  if (!lines.length) lines.push(`no file fits ${r.query ? `"${r.query}"` : 'that'}${r.total === 0 ? ' (relax a number, or drop a word)' : ''}`);
  else lines.push(`${r.hits.length}${r.total > r.hits.length ? ` of ${r.total}` : ''} file${r.hits.length === 1 ? '' : 's'}${r.total > r.hits.length ? ' (--limit shows more)' : ''}; use one: soundclaw library use <project> ${r.hits[0]!.hit.lib.id}:<path> [as=<name>]`);
  if (r.notIndexed.length) lines.push(`warning: not indexed, so not searched: ${r.notIndexed.join(', ')} (soundclaw library index ${r.notIndexed.join(' ')})`);
  return lines.join('\n');
}

/** Compact hits for tools: one object per hit. */
export function hitJson(h: FoundHit, policyState?: (l: SampleLicence) => string): Record<string, unknown> {
  const { lib, file } = h.hit;
  const m = file.measure ? decodeMeasure(file.measure) : null;
  const state = policyState ? policyState(lib.licence) : licenceState(lib.licence, DEFAULT_SHIP_POLICY).state;
  const r = (v: number, d = 1): number | null => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
  return {
    ref: `${lib.id}:${file.path}`,
    ...(m ? { dur: r(m.duration, 3), lufs: r(m.lufs), note: m.pitched && m.pitch ? m.pitch.note : file.meta?.root !== undefined ? noteLabel(file.meta.root) : null, centroid: Math.round(m.centroid), attack: r(m.attackMs), onsets: m.onsets.count, channels: m.channels, rate: m.rate } : { error: file.error ?? 'not readable' }),
    licence: lib.licence.id, state,
    ...(h.distance !== undefined ? { distance: r(h.distance, 2) } : {}),
    desc: fileOneLiner(file),
    ...(file.extraTags?.length ? { tags: file.extraTags } : {}),
  };
}

/** The licence state function for a project's ship policy. */
export const stateUnder = (policy: ShipPolicy) => (l: SampleLicence): string => licenceState(l, policy).state;

// ---- reading a file out of a library -------------------------------------------------------------------------------

/** A file of a registered library, by its path inside it. Nothing outside the library's folder can be named, links included. */
export function confinedFile(lib: LibraryEntry, rel: string): string {
  if (!rel || rel.includes('\0') || rel.startsWith('/') || rel.startsWith('\\') || /^[A-Za-z]:/.test(rel) || rel.split(/[\\/]/).some((p) => p === '..')) {
    throw new ProjectError(`'${rel}' is not a path inside library ${lib.id}`);
  }
  const abs = resolve(lib.dir, ...rel.split('/'));
  let real: string;
  try { real = realpathSync(abs); } catch { throw new ProjectError(`library ${lib.id} has no file '${rel}'`); }
  if (real !== lib.dir && !real.startsWith(lib.dir + sep)) throw new ProjectError(`'${rel}' is not a path inside library ${lib.id}`);
  const st = lstatSync(real);
  if (!st.isFile()) throw new ProjectError(`'${rel}' is not a file`);
  if (!IMPORT_EXTENSIONS.includes(extname(real).toLowerCase())) throw new ProjectError(`'${rel}' is not an audio file (${IMPORT_EXTENSIONS.join(' ')})`);
  if (st.size > SAMPLE_LIMITS.maxFileBytes) throw new ProjectError(`'${rel}' is ${(st.size / 1048576).toFixed(0)} MB, past the ${SAMPLE_LIMITS.maxFileBytes / 1048576} MB limit`);
  return real;
}

/** The bytes of a library file for auditioning in the page (no copy is made into a project); the caller decodes them (in a worker). */
export function libraryAudioFile(id: string, rel: string): { bytes: Uint8Array; filename: string; etag: string } {
  const lib = getLibrary(id);
  const abs = confinedFile(lib, rel);
  const st = statSync(abs);
  return { bytes: new Uint8Array(readFileSync(abs)), filename: basename(abs), etag: `"${id}-${st.size}-${Math.floor(st.mtimeMs)}"` };
}

export interface UseOptions {
  as?: string;
  licence?: string;
  attribution?: string;
  terms?: string;
  tags?: string;
  note?: string;
  force?: boolean;
  by: string;
}

/** `library use`: copy one file into the project's store, named on the tape with where it came from and the library's licence. */
export function useLibraryFile(w: Writer, ref: string, o: UseOptions): ImportResult {
  const parts = splitLibraryRef(ref);
  if (!parts) throw new ProjectError(`'${ref}' is not <library>:<path> (soundclaw library search shows the references)`);
  const lib = getLibrary(parts.library);
  const abs = confinedFile(lib, parts.path);
  const idx = loadIndex(lib.id);
  const entry = idx?.files.find((f) => f.path === parts.path);
  const tags = [...new Set([...(o.tags ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean), ...(entry?.tags ?? []), ...(readTags(lib.id)[parts.path] ?? [])])].slice(0, 12);
  const declared = licenceOf(lib);
  const prepared = prepareImport(new Uint8Array(readFileSync(abs)), abs, {
    ...(o.as ? { as: o.as } : { as: nameFromFile(parts.path.split('/').pop()!) }),
    licence: o.licence ?? declared.id,
    ...((o.attribution ?? declared.attribution) ? { attribution: o.attribution ?? declared.attribution! } : {}),
    ...((o.terms ?? declared.terms) ? { terms: o.terms ?? declared.terms! } : {}),
    tags: tags.join(','), source: 'library', origin: `${lib.id}:${parts.path}`,
    ...(o.note ? { note: o.note } : {}),
  });
  const r = commitImports(w, [prepared], { by: o.by, force: !!o.force });
  if (r.problems.length && !r.items.length) throw new ProjectError(r.problems[0]!);
  return r;
}

