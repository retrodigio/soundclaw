// Sample libraries, the pure parts: tags from file and folder names, the licence a library declares, the numbers an
// index keeps for each file, the "sounds like" feature vector and its distance, and the search that ranks hits.
// A library is a folder outside any project; reading it, indexing it and copying a file out are the server's work
// (server/src/library.ts). This module measures (it may use Math.*): its numbers are printed rounded and nothing
// here feeds back into a render.

import { fft, nextPow2 } from './analysis.ts';
import { matchQuery, QUERY_KEYS, type Query, type QueryFacts } from './numquery.ts';
import { DEFAULT_SHIP_POLICY, licenceState, type SampleLicence, type ShipPolicy } from './samples.ts';
import type { SampleMeasure } from './sampleears.ts';

// ---- names -----------------------------------------------------------------------------------------------------

export const LIBRARY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** A library id from a folder name or a title: lower case, letters, digits, `_` and `-`, at most 32 characters. */
export function libraryIdFrom(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+|[-_]+$/g, '').slice(0, 32).replace(/[-_]+$/, '');
  return s || 'library';
}

/** The pieces of a library reference `<library>:<path>`. */
export function splitLibraryRef(ref: string): { library: string; path: string } | null {
  const m = /^([a-z0-9][a-z0-9_-]{0,31}):(.+)$/.exec(ref);
  return m ? { library: m[1]!, path: m[2]! } : null;
}

// ---- tags from file and folder names ---------------------------------------------------------------------------

const STOP = new Set(['wav', 'wave', 'aif', 'aiff', 'aifc', 'flac', 'mp3', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'the', 'an', 'of', 'and', 'copy', 'sample', 'samples']);

/** One word without its plural: doors → door, cries → cry, boxes → box; glass, bass, bus and chaos stay. */
export function foldPlural(w: string): string {
  if (w.length <= 3) return w;
  if (/[^aeiou]ies$/.test(w)) return `${w.slice(0, -3)}y`;
  if (/(ss|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w) && !/(ss|us|is|os)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** The words of a name: split on anything but letters and digits and on camelCase, lower-cased, plurals folded; numbers, one-letter words and file extensions dropped. */
export function nameWords(text: string): string[] {
  const spaced = text.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2');
  const out: string[] = [];
  for (const raw of spaced.split(/[^A-Za-z0-9]+/)) {
    const w = raw.toLowerCase();
    if (w.length < 2 || /^\d+$/.test(w) || STOP.has(w)) continue;
    const f = foldPlural(w);
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

export interface PathWords {
  /** Words of the file name (without its extension). */
  name: string[];
  /** Words of the folders above it. */
  folders: string[];
}

export function pathWords(rel: string): PathWords {
  const parts = rel.split('/').filter(Boolean);
  const file = parts.pop() ?? '';
  const name = nameWords(file.replace(/\.[A-Za-z0-9]{1,5}$/, ''));
  const folders: string[] = [];
  for (const p of parts) for (const w of nameWords(p)) if (!folders.includes(w)) folders.push(w);
  return { name, folders };
}

/** The tags an index gives a file from its path: the words of its folders, then those of its name. */
export function tagsFromPath(rel: string): string[] {
  const { name, folders } = pathWords(rel);
  return [...new Set([...folders, ...name])];
}

// ---- what a library declares about itself ---------------------------------------------------------------------

export interface LibraryDeclaration {
  /** Where it was read from: flags the caller gave, `soundclaw-library.json`, or the text of a licence file (a proposal the person confirms). */
  from: 'flags' | 'manifest' | 'licence-file';
  name?: string;
  description?: string;
  licence?: string;
  attribution?: string;
  terms?: string;
  /** For a licence file: the line that decided it. */
  basis?: string;
}

export const MANIFEST_FILE = 'soundclaw-library.json';

/** `soundclaw-library.json`: `{ "name": …, "description": …, "licence": "CC0-1.0", "attribution": …, "terms": … }`. Throws an Error saying what is wrong. */
export function parseLibraryManifest(text: string): LibraryDeclaration {
  let j: unknown;
  try { j = JSON.parse(text); } catch (e) { throw new Error(`${MANIFEST_FILE} is not JSON (${(e as Error).message})`); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error(`${MANIFEST_FILE} must be a JSON object`);
  const o = j as Record<string, unknown>;
  const out: LibraryDeclaration = { from: 'manifest' };
  const str = (k: string, ...alias: string[]): string | undefined => {
    for (const key of [k, ...alias]) {
      const v = o[key];
      if (v === undefined) continue;
      if (typeof v !== 'string' || !v.trim()) throw new Error(`${MANIFEST_FILE}: '${key}' must be a non-empty string`);
      return v.trim();
    }
    return undefined;
  };
  const name = str('name'); if (name) out.name = name;
  const description = str('description'); if (description) out.description = description.slice(0, 400);
  const licence = str('licence', 'license'); if (licence) out.licence = licence;
  const attribution = str('attribution'); if (attribution) out.attribution = attribution;
  const terms = str('terms'); if (terms) out.terms = terms;
  if (out.licence !== undefined && !licenceIdOk(out.licence)) throw new Error(`${MANIFEST_FILE}: '${out.licence}' is not a licence id (an SPDX id such as CC0-1.0 or CC-BY-4.0, own, unknown, generated:<provider>:<plan> or proprietary:<note>)`);
  return out;
}

/** The ids a sample's `licence=` takes (as the tape reads them). */
export const licenceIdOk = (v: string): boolean => v.length <= 200 && /^(own|unknown|generated:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+|proprietary:.+|[A-Za-z0-9][A-Za-z0-9.+-]*)$/s.test(v);

/** The licence files looked for in a library's root, in this order (compared ignoring case). */
export const LICENCE_FILES = ['license', 'license.txt', 'license.md', 'licence', 'licence.txt', 'licence.md', 'copying', 'copying.txt'];

/**
 * The licence a licence file's text names, only when it says so outright: an `SPDX-License-Identifier:` line, "CC0", or a
 * Creative Commons title ("Attribution-NonCommercial 4.0"). Anything else is not guessed (null). The person confirms the answer at `library add`.
 */
export function licenceFromText(text: string): { id: string; basis: string } | null {
  const head = text.slice(0, 20000);
  const spdx = /SPDX-License-Identifier:\s*([A-Za-z0-9.+-]+)/.exec(head);
  if (spdx && licenceIdOk(spdx[1]!)) return { id: spdx[1]!, basis: spdx[0]!.trim() };
  const line = (re: RegExp): string => (head.split('\n').find((l) => re.test(l)) ?? '').trim().slice(0, 160);
  if (/creative commons zero|\bCC0\b|\bCC[ -]?0\b|public domain dedication/i.test(head)) return { id: 'CC0-1.0', basis: line(/creative commons zero|\bCC0\b|\bCC[ -]?0\b|public domain dedication/i) };
  if (!/creative commons|\bCC[ -]BY\b/i.test(head)) return null;
  const ver = /\b(1\.0|2\.0|2\.5|3\.0|4\.0)\b/.exec(head)?.[1] ?? '4.0';
  const kinds: [RegExp, string][] = [
    [/attribution[- ]non[- ]?commercial[- ]share[- ]?alike|\bBY[- ]NC[- ]SA\b/i, 'CC-BY-NC-SA'],
    [/attribution[- ]non[- ]?commercial[- ]no[- ]?deriv|\bBY[- ]NC[- ]ND\b/i, 'CC-BY-NC-ND'],
    [/attribution[- ]non[- ]?commercial|\bBY[- ]NC\b/i, 'CC-BY-NC'],
    [/attribution[- ]no[- ]?deriv|\bBY[- ]ND\b/i, 'CC-BY-ND'],
    [/attribution[- ]share[- ]?alike|\bBY[- ]SA\b/i, 'CC-BY-SA'],
    [/\battribution\b|\bCC[ -]BY\b/i, 'CC-BY'],
  ];
  for (const [re, id] of kinds) if (re.test(head)) return { id: `${id}-${ver}`, basis: line(re) };
  return null;
}

// ---- the numbers an index keeps --------------------------------------------------------------------------------

/** Band edges (Hz) of the energy bands: each octave from 100 Hz up, with everything below 100 Hz and above 8 kHz at the ends. */
export const BAND_EDGES = [0, 100, 250, 500, 1000, 2000, 4000, 8000, 22050] as const;
export const BAND_COUNT = BAND_EDGES.length - 1;
const BAND_FLOOR_DB = -60;

/** Energy per band as dB below the total (0 for all of it; −60 for none), from the average power spectrum of the mono signal at 44.1 kHz. */
export function bandEnergies(mono44: Float32Array, rate = 44100): number[] {
  const size = 2048, hop = 1024;
  const out = new Array<number>(BAND_COUNT).fill(BAND_FLOOR_DB);
  if (mono44.length < 64) return out;
  const n = nextPow2(size);
  const re = new Float64Array(n), im = new Float64Array(n);
  const power = new Float64Array(n / 2);
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  let frames = 0;
  const last = Math.max(1, mono44.length - size + 1);
  for (let a = 0; a < last; a += hop) {
    for (let i = 0; i < n; i++) { re[i] = (a + i < mono44.length ? mono44[a + i]! : 0) * win[i]!; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < n / 2; k++) power[k] = power[k]! + re[k]! * re[k]! + im[k]! * im[k]!;
    frames++;
  }
  if (!frames) return out;
  const hz = (k: number): number => (k * rate) / n;
  const bands = new Array<number>(BAND_COUNT).fill(0);
  let total = 0;
  for (let k = 1; k < n / 2; k++) {
    total += power[k]!;
    const f = hz(k);
    let b = BAND_COUNT - 1;
    for (let i = 0; i < BAND_COUNT; i++) if (f < BAND_EDGES[i + 1]!) { b = i; break; }
    bands[b] = bands[b]! + power[k]!;
  }
  if (total <= 0) return out;
  return bands.map((e) => Math.max(BAND_FLOOR_DB, Math.round(10 * Math.log10(Math.max(1e-12, e / total)) * 10) / 10));
}

/** Non-finite numbers cannot be written as JSON: they are kept as these words and turned back on reading. */
export function encodeMeasure(m: SampleMeasure): unknown {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity';
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk({ ...m, onsets: { ...m.onsets, times: m.onsets.times.slice(0, 16) } });
}

export function decodeMeasure(j: unknown): SampleMeasure {
  const walk = (v: unknown): unknown => {
    if (v === 'NaN') return NaN;
    if (v === 'Infinity') return Infinity;
    if (v === '-Infinity') return -Infinity;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(j) as SampleMeasure;
}

/** What an index holds for one file. */
export interface IndexedFile {
  /** Relative to the library's root, with `/`. */
  path: string;
  size: number;
  /** The file's time stamp (ms); with the size it says whether the entry is still good. */
  mtime: number;
  /** Set when the file could not be read (then nothing below is). */
  error?: string;
  /** The canonical hash of the audio (the hash the project's store will give it). */
  hash?: string;
  /** The container and sample format as the file has them (`wav 16-bit`). */
  format?: string;
  bits?: number;
  rate?: number;
  channels?: number;
  frames?: number;
  /** The measure of the first 20 s, at the file's own rate (SampleMeasure, with non-finite numbers as words: see decodeMeasure). */
  measure?: unknown;
  /** Energy per band (BAND_EDGES), dB below the total. */
  bands?: number[];
  /** What the file's own chunks said. */
  meta?: { root?: number; tune?: number; loop?: [number, number]; oneShot?: boolean; tempo?: number; info?: Record<string, string> };
  /** Tags from the path. */
  tags: string[];
}

export interface IndexedFileView extends IndexedFile {
  /** Tags a person or agent added (kept apart from the index, so a rebuild does not lose them). */
  extraTags?: string[];
}

// ---- feature vector and distance --------------------------------------------------------------------------------

export interface SimilarFeature {
  name: string;
  /** The change that counts as one unit of distance. */
  scale: number;
  weight: number;
  help: string;
}

/** The features of "sounds like", in order; the distance is √Σ weight × ((a − b) / scale)². Data: the docs print this table. */
export const SIMILAR_FEATURES: readonly SimilarFeature[] = [
  { name: 'duration', scale: 0.5, weight: 1, help: 'log10 of the length in seconds (×3 is one unit)' },
  { name: 'loudness', scale: 8, weight: 0.6, help: 'integrated loudness, LUFS (−60 for silence)' },
  { name: 'centroid', scale: 1.2, weight: 1, help: 'log2 of the spectral centroid in kHz (octaves)' },
  { name: 'flatness', scale: 0.3, weight: 1, help: 'spectral flatness, 0 tonal … 1 noise' },
  { name: 'attack', scale: 0.8, weight: 0.8, help: 'log10 of the attack in ms' },
  { name: 'pitched', scale: 1, weight: 0.7, help: '1 when it has a clear pitch, else 0' },
  { name: 'pitch', scale: 1, weight: 0.5, help: 'the pitch in octaves (MIDI note ÷ 12) when pitched, else 0' },
  { name: 'onsetrate', scale: 3, weight: 0.6, help: 'onsets per second' },
  ...['0-100 Hz', '100-250 Hz', '250-500 Hz', '500-1000 Hz', '1-2 kHz', '2-4 kHz', '4-8 kHz', 'above 8 kHz'].map((b) => ({ name: `band ${b}`, scale: 12, weight: 0.35, help: `energy in ${b}, dB below the total (−60 for none)` })),
];

const fin = (v: number, d: number): number => (Number.isFinite(v) ? v : d);

/** The feature vector of a sample from its measure and its band energies. */
export function similarVector(m: SampleMeasure, bands: readonly number[]): number[] {
  const pitched = m.pitched && m.pitch ? 1 : 0;
  return [
    Math.log10(Math.max(0.001, m.duration)),
    fin(m.lufs, -60),
    Math.log2(Math.max(20, fin(m.centroid, 20)) / 1000),
    fin(m.flatness, 1),
    Math.log10(Math.max(0.1, m.attackMs)),
    pitched,
    pitched && m.pitch ? m.pitch.midi / 12 : 0,
    m.onsets.perSecond,
    ...Array.from({ length: BAND_COUNT }, (_, i) => bands[i] ?? BAND_FLOOR_DB),
  ];
}

/** The distance of two feature vectors; `matchLevel` leaves the loudness out, so it is the distance in character and not in how loud each is. */
export function similarDistance(a: readonly number[], b: readonly number[], matchLevel = false): number {
  let s = 0;
  for (let i = 0; i < SIMILAR_FEATURES.length; i++) {
    const f = SIMILAR_FEATURES[i]!;
    if (matchLevel && f.name === 'loudness') continue;
    const d = ((a[i] ?? 0) - (b[i] ?? 0)) / f.scale;
    s += f.weight * d * d;
  }
  return Math.sqrt(s);
}

// ---- facts, words and ranking -----------------------------------------------------------------------------------

/** What the numbers query tests for the numbers a measure holds (the library and the project's samples both use it). */
export function measureFacts(m: SampleMeasure): QueryFacts {
  const f = (v: number): number | null => (Number.isFinite(v) ? v : null);
  return {
    dur: m.duration, lufs: f(m.lufs), peak: f(m.peakDb), rms: f(m.rmsDb), centroid: m.centroid, flatness: m.flatness, attack: m.attackMs, decay: m.decay60,
    noise: m.noiseFloorDb, harmonicity: f(m.hnrDb), pitch: m.pitch ? m.pitch.midi : null, pitched: m.pitched, onsets: m.onsets.count, onsetrate: m.onsets.perSecond,
    tempo: m.tempo, channels: m.channels, samplerate: m.rate, width: m.stereoWidth, 'silence-start': m.silenceStartMs, 'silence-end': m.silenceEndMs, clips: m.fullScaleRuns,
  };
}

/** The library a file belongs to, with the licence it declared. */
export interface LibraryRef {
  id: string;
  licence: SampleLicence;
}

export function fileFacts(lib: LibraryRef, f: IndexedFileView, policy: ShipPolicy = DEFAULT_SHIP_POLICY): QueryFacts {
  const m = f.measure ? decodeMeasure(f.measure) : null;
  const state = licenceState(lib.licence, policy).state;
  const loop = !!f.meta?.loop;
  return {
    ...(m ? measureFacts(m) : {}),
    channels: f.channels, samplerate: f.rate, bits: f.bits, loop,
    tag: [...f.tags, ...(f.extraTags ?? [])], source: 'library', licence: [state, lib.licence.id],
    name: f.path.split('/').pop()!,
  };
}

/** The base score for how the query's words match a file: every word has to match somewhere, else null. File-name words weigh most, then added tags, then folders. */
export function wordScore(words: readonly string[], lib: LibraryRef, f: IndexedFileView): number | null {
  if (!words.length) return 0;
  const { name, folders } = pathWords(f.path);
  const added = (f.extraTags ?? []).map((t) => t.toLowerCase());
  let total = 0;
  for (const raw of words) {
    for (const piece of raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      const w = foldPlural(piece);
      let best = 0;
      const test = (list: readonly string[], eq: number, part: number): void => {
        for (const t of list) { if (t === w) best = Math.max(best, eq); else if (t.includes(w) || w.includes(t) && t.length > 3) best = Math.max(best, part); }
      };
      test(name, 4, 3);
      test(added, 3, 2);
      test(folders, 2, 1);
      test(f.tags, 2, 1);
      if (lib.id === piece) best = Math.max(best, 1);
      if (!best) return null;
      total += best;
    }
  }
  return total;
}

/** How far a file sits from the middle of the query's ranges (each key by its scale): among hits that all fit, the ones nearer the middle come first. */
export function rangeCentre(q: Query, facts: QueryFacts): number {
  let d = 0;
  for (const t of q.terms) {
    if (t.op !== '=' || (t.kind !== 'num' && t.kind !== 'note') || t.lo === undefined || t.hi === undefined || t.lo === t.hi) continue;
    const x = facts[t.key];
    const ky = QUERY_KEYS.find((k) => k.key === t.key);
    if (typeof x !== 'number' || !ky) continue;
    d += Math.abs(x - (t.lo + t.hi) / 2) / ky.scale;
  }
  return d;
}

export interface LibraryHit {
  lib: LibraryRef;
  file: IndexedFileView;
  /** Higher is a better word match. */
  words: number;
  /** 0 when everything is inside its range; then the distance from the ranges' middle is added by `rank`. */
  closeness: number;
}

/** The files of the given libraries that fit the query, best first: word match, then closeness to the ranges. */
export function searchFiles(entries: Iterable<{ lib: LibraryRef; file: IndexedFileView }>, q: Query, policy: ShipPolicy = DEFAULT_SHIP_POLICY): LibraryHit[] {
  const termsOnly: Query = { words: [], terms: q.terms };
  const hits: (LibraryHit & { centre: number })[] = [];
  for (const { lib, file } of entries) {
    if (file.error) continue;
    const words = wordScore(q.words, lib, file);
    if (words === null) continue;
    const facts = fileFacts(lib, file, policy);
    const r = matchQuery(termsOnly, facts, file.path.split('/').pop()!, [...file.tags, ...(file.extraTags ?? [])]);
    if (!r.match) continue;
    hits.push({ lib, file, words, closeness: r.closeness, centre: rangeCentre(q, facts) });
  }
  hits.sort((a, b) => b.words - a.words || a.centre - b.centre || (a.lib.id + ':' + a.file.path < b.lib.id + ':' + b.file.path ? -1 : 1));
  return hits;
}

/** A one-line description of an indexed file from its measure. */
export function fileOneLiner(f: IndexedFile): string {
  if (!f.measure) return f.error ? `not readable: ${f.error}` : '';
  const m = decodeMeasure(f.measure);
  if (m.silent) return 'silence';
  const kind = m.pitched ? 'tonal' : m.flatness > 0.3 || m.hnrDb < 0 ? 'noisy' : 'tone and noise';
  const hits = m.onsets.count <= 1 ? 'one hit' : `${m.onsets.count} hits`;
  const room = m.decay60 === null ? 'sustained' : m.decay60 < 0.3 ? 'dry' : 'roomy';
  const width = m.channels < 2 ? 'mono' : m.stereoWidth < 0.05 ? 'dual mono' : m.stereoWidth < 0.4 ? 'narrow stereo' : 'wide stereo';
  return `${kind}, ${hits}, ${room}, ${width}`;
}
