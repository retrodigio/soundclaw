// Bringing a sampled instrument into a project from an SFZ file or a SoundFont 2 file: the files are read and their audio
// decoded once, here; the tape then holds `sample add` lines (hashes and the facts that were read) and the plain `instrument
// zone add` lines of the zones, as one undo group. A replay or a render never reads an SFZ or a SoundFont again.
//
// All or nothing: a sample that cannot be read names its region (or zone) and stops the import before anything is written.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  INSTRUMENT_ID_RE, InstrumentImportError, SAMPLE_LIMITS, SAMPLE_NAME_RE, findSf2Preset, lossLines, parseSf2, parseSfz, pcmHash, planCommands,
  sampleAddText, sf2PresetListText, sf2ToPlan, sfzSamples, sfzToPlan, sha256Hex,
  type InstrumentPlan, type Sf2Plan, type SampleEntry,
} from '@soundclaw/core';
import { ProjectError } from './project.ts';
import { commitImports, prepareImport, type Prepared } from './sampleimport.ts';
import type { Writer } from './writer.ts';

export interface InstrumentImportOptions {
  /** The instrument's id (default: the file's name, or the preset's). */
  id?: string;
  licence?: string;
  attribution?: string;
  terms?: string;
  tags?: string;
  /** SoundFont: `<bank>:<program>` or a name. */
  preset?: string;
  /** Put this in front of every sample's name (default: the instrument's id and `_`). */
  prefix?: string;
  force?: boolean;
  by: string;
}

export interface InstrumentImportResult {
  id: string;
  format: 'sfz' | 'sf2';
  /** Regions (SFZ) or zones (SoundFont) read, and the zones written. */
  read: number;
  zones: number;
  samples: { name: string; created: boolean }[];
  group: string | null;
  lost: ReturnType<typeof lossLines>;
  notes: string[];
  warnings: string[];
}

const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_SF2_BYTES = 1024 * 1024 * 1024;

const stem = (file: string): string => basename(file, extname(file));

/** A valid id from a file's or a preset's name. */
function idFrom(text: string): string {
  const s = text.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^[^A-Za-z]+/, '').replace(/_+$/, '').slice(0, 48);
  return s || 'imported';
}

function checkId(w: Writer, id: string): void {
  if (!INSTRUMENT_ID_RE.test(id)) throw new ProjectError(`'${id}' is not an instrument id (a letter, then letters, digits, _ and -, at most 48 characters): give --id <id>`);
  if (w.has(id) || w.hasSong(id) || w.hasSet(id)) throw new ProjectError(`'${id}' is a sound, set or song of the project; give another --id`);
  if (w.instruments().some((i) => i.id === id)) throw new ProjectError(`instrument '${id}' exists already; give another --id (or instrument remove ${id} first)`);
}

/** The file at a path inside a folder, matching names ignoring case where the exact name is not there (SFZ files are written on systems that do not care). */
function findFile(base: string, rel: string): string | null {
  const exact = join(base, rel);
  if (existsSync(exact) && statSync(exact).isFile()) return exact;
  let dir = base;
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    const want = parts[i]!;
    if (want === '..') { dir = dirname(dir); continue; }
    let names: string[];
    try { names = readdirSync(dir); } catch { return null; }
    const hit = names.includes(want) ? want : names.find((n) => n.toLowerCase() === want.toLowerCase());
    if (!hit) return null;
    dir = join(dir, hit);
  }
  return existsSync(dir) && statSync(dir).isFile() ? dir : null;
}

/** Sample names for an import: the prefix and the file's stem, unique among the project's samples and this batch. */
class Namer {
  private readonly used = new Set<string>();
  private readonly prefix: string;
  constructor(w: Writer, prefix: string) {
    this.prefix = prefix;
    for (const n of w.sampleEntries().keys()) this.used.add(n.toLowerCase());
    for (const n of w.samples.names()) this.used.add(n.toLowerCase());
  }
  name(label: string): string {
    const base = (this.prefix + label.replace(/[^A-Za-z0-9_-]+/g, '_')).replace(/^[^A-Za-z0-9]+/, '').replace(/_+$/, '');
    let n = base.slice(0, 48) || 'sample';
    for (let k = 2; this.used.has(n.toLowerCase()); k++) n = `${base.slice(0, 48 - String(k).length - 1)}_${k}`;
    if (!SAMPLE_NAME_RE.test(n)) throw new ProjectError(`cannot make a sample name from '${label}'`);
    this.used.add(n.toLowerCase());
    return n;
  }
}

function readLimited(file: string, max: number, what: string): Uint8Array {
  if (!existsSync(file) || !statSync(file).isFile()) throw new ProjectError(`no file ${file}`);
  const st = statSync(file);
  if (st.size > max) throw new ProjectError(`${basename(file)}: ${(st.size / 1048576).toFixed(0)} MB; ${what} files are read up to ${max / 1048576} MB`);
  return new Uint8Array(readFileSync(file));
}

export function isSoundFont(file: string): boolean {
  return extname(file).toLowerCase() === '.sf2';
}

/** `instrument import <project> <file.sf2> --list`. */
export function soundFontList(file: string): string {
  const f = parseSf2Checked(file);
  return `${f.info.name || basename(file)}${f.info.copyright ? `  ${f.info.copyright}` : ''}  (SoundFont ${f.info.version}, ${f.presets.length} preset${f.presets.length === 1 ? '' : 's'})\n${sf2PresetListText(f)}\n`;
}

function parseSf2Checked(file: string): ReturnType<typeof parseSf2> {
  const bytes = readLimited(file, MAX_SF2_BYTES, 'SoundFont');
  try { return parseSf2(bytes); } catch (e) { if (e instanceof InstrumentImportError) throw new ProjectError(`${basename(file)}: ${e.message}`); throw e; }
}

const tagsOf = (o: InstrumentImportOptions, more: string[]): string => [...(o.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean), ...more].join(',');

function finish(w: Writer, plan: InstrumentPlan, id: string, format: 'sfz' | 'sf2', read: number, prepared: Prepared[], nameOf: (key: string) => string, o: InstrumentImportOptions): InstrumentImportResult {
  const commands = planCommands(plan, id, nameOf);
  const r = commitImports(w, prepared, { by: o.by, force: o.force, extra: commands });
  if (r.problems.length) throw new ProjectError(r.problems.join('\n'));
  return {
    id, format, read, zones: plan.zones.length, samples: r.items.map((x) => ({ name: x.info.name, created: x.created })), group: r.group,
    lost: lossLines(plan.losses, format === 'sfz' ? 'region' : 'zone'), notes: [...plan.notes, ...r.items.flatMap((x) => x.notes)], warnings: r.warnings,
  };
}

/** Import an SFZ file: its regions as zones, its sample files into the store. */
function importSfz(w: Writer, file: string, o: InstrumentImportOptions): InstrumentImportResult {
  const id = o.id ?? idFrom(stem(file));
  checkId(w, id);
  const base = dirname(resolve(file));
  const bytes = readLimited(file, MAX_TEXT_BYTES, 'SFZ');
  const sfzHash = sha256Hex(bytes);
  const parsed = (() => {
    try {
      return parseSfz(new TextDecoder().decode(bytes), {
        include: (p) => { const f = findFile(base, p); return f ? new TextDecoder().decode(readLimited(f, MAX_TEXT_BYTES, 'SFZ')) : undefined; },
      });
    } catch (e) { if (e instanceof InstrumentImportError) throw new ProjectError(`${basename(file)}: ${e.message}`); throw e; }
  })();
  const wanted = (() => { try { return sfzSamples(parsed); } catch (e) { if (e instanceof InstrumentImportError) throw new ProjectError(`${basename(file)}: ${e.message}`); throw e; } })();
  if (!wanted.length) throw new ProjectError(`${basename(file)}: no region plays a sample`);
  const namer = new Namer(w, o.prefix ?? `${id}_`);
  const names = new Map<string, string>();
  const prepared: Prepared[] = [];
  for (const s of wanted) {
    const path = findFile(base, s.path);
    if (!path) throw new ProjectError(`${basename(file)}: region ${s.region}: sample ${s.path} is not there (looked beside the SFZ; paths are relative to its folder)`);
    const name = namer.name(stem(s.path));
    try {
      const p = prepareImport(readLimited(path, SAMPLE_LIMITS.maxFileBytes, 'sample'), path, {
        as: name, source: 'instrument-import', containerHash: sfzHash, origin: `${basename(file)}:${s.path}`, note: `from ${basename(file)} (sha256 ${sfzHash.slice(0, 16)}…)`,
        ...(o.licence ? { licence: o.licence } : {}), ...(o.attribution ? { attribution: o.attribution } : {}), ...(o.terms ? { terms: o.terms } : {}), tags: tagsOf(o, ['sfz']),
      });
      prepared.push(p);
    } catch (e) {
      if (e instanceof ProjectError) throw new ProjectError(`${basename(file)}: region ${s.region}: ${e.message}`);
      throw e;
    }
    names.set(s.path, name);
  }
  const facts = new Map(prepared.map((p, i) => [wanted[i]!.path, p.entry!]));
  let plan: InstrumentPlan;
  try {
    plan = sfzToPlan(parsed, (path) => {
      const e = facts.get(path)!;
      return { rate: e.rate, frames: e.frames, ...(e.root !== undefined ? { root: e.root, tune: e.tune ?? 0 } : {}), ...(e.loop ? { loop: e.loop } : {}) };
    });
  } catch (e) { if (e instanceof InstrumentImportError) throw new ProjectError(`${basename(file)}: ${e.message}`); throw e; }
  // a sample only used by regions that were left out is not imported
  const used = new Set(plan.zones.map((z) => z.zone.sample));
  const keep = prepared.filter((_, i) => used.has(wanted[i]!.path));
  return finish(w, plan, id, 'sfz', parsed.regions.length, keep, (key) => names.get(key)!, o);
}

/** Import one preset of a SoundFont 2 file. */
function importSf2(w: Writer, file: string, o: InstrumentImportOptions): InstrumentImportResult {
  const bytes = readLimited(file, MAX_SF2_BYTES, 'SoundFont');
  const fileHash = sha256Hex(bytes);
  let sf;
  try { sf = parseSf2(bytes); } catch (e) { if (e instanceof InstrumentImportError) throw new ProjectError(`${basename(file)}: ${e.message}`); throw e; }
  let plan: Sf2Plan;
  let id = '';
  try {
    const preset = findSf2Preset(sf, o.preset);
    id = o.id ?? idFrom(preset.name || stem(file));
    checkId(w, id);
    plan = sf2ToPlan(sf, preset.index);
  } catch (e) { if (e instanceof InstrumentImportError) throw new ProjectError(`${basename(file)}: ${e.message}`); throw e; }
  const presetName = plan.presetName;
  const namer = new Namer(w, o.prefix ?? `${id}_`);
  const info = plan.info;
  const note = [`SoundFont ${info.name ? `"${info.name}"` : basename(file)}, preset "${presetName}"`, info.copyright, info.comment].filter(Boolean).join('; ').slice(0, 400);
  const names = new Map<string, string>();
  const prepared: Prepared[] = [];
  for (const s of plan.samples) {
    const name = namer.name(s.label);
    const audio = s.audio;
    const hash = pcmHash(audio);
    const entry: SampleEntry = {
      name, hash, rate: audio.rate, channels: audio.channels, frames: audio.frames, format: audio.format, tags: tagsOf(o, ['soundfont']).split(',').filter(Boolean).sort(),
      prov: { source: 'instrument-import', origin: `${basename(file)}:${s.header.name || `sample ${s.header.index}`}`, origHash: fileHash, containerHash: fileHash, origFormat: `sf2 ${audio.format === 'pcm24' ? '24-bit' : '16-bit'}` },
      licence: { id: o.licence ?? 'unknown', ...(o.attribution ? { attribution: o.attribution } : {}), ...(o.terms ? { terms: o.terms } : {}) },
      root: s.root, ...(s.tune ? { tune: s.tune } : {}), note,
    };
    if (s.loop) { entry.loop = s.loop; entry.loopMode = 'sustain'; }
    prepared.push({ name, audio, hash, command: sampleAddText(entry), notes: [], file: `${basename(file)}:${s.header.name}`, entry });
    names.set(s.key, name);
  }
  return finish(w, plan.plan, id, 'sf2', plan.plan.zones.length, prepared, (key) => names.get(key)!, o);
}

/** `instrument import`: an SFZ or a SoundFont 2 file as a sampled instrument and the samples it plays, one undo group. */
export function importInstrument(w: Writer, file: string, o: InstrumentImportOptions): InstrumentImportResult {
  if (!existsSync(file)) throw new ProjectError(`no file ${file}`);
  const ext = extname(file).toLowerCase();
  if (ext === '.sfz') return importSfz(w, file, o);
  if (ext === '.sf2') return importSf2(w, file, o);
  throw new ProjectError(`${basename(file)}: instrument import reads .sfz and .sf2 files${ext === '.sf3' ? ' (SoundFont 3 is compressed and is not read)' : ''}`);
}

/** The import in words. */
export function formatInstrumentImport(r: InstrumentImportResult, file: string): string {
  const lines = [
    `imported instrument ${r.id} from ${basename(file)} (${r.format === 'sfz' ? 'SFZ' : 'SoundFont 2'}): ${r.read} ${r.format === 'sfz' ? 'region' : 'zone'}${r.read === 1 ? '' : 's'} read, ${r.zones} zone${r.zones === 1 ? '' : 's'} written, ${r.samples.length} sample${r.samples.length === 1 ? '' : 's'}${r.group ? `, as group ${r.group}` : ''}`,
    `  samples: ${r.samples.slice(0, 8).map((s) => s.name).join(', ')}${r.samples.length > 8 ? `, … (${r.samples.length - 8} more)` : ''}`,
    ...r.lost.map((l) => `  ${l}`),
    ...r.notes.map((n) => `  note: ${n}`),
    ...r.warnings.map((n) => `  warning: ${n}`),
    `  the licence of the samples is unknown until you set it (sample set <name> licence=<id>, or import with licence=<id>); inspect: soundclaw instrument zones <project> ${r.id}; check: soundclaw check <project> ${r.id}`,
  ];
  return lines.join('\n');
}
