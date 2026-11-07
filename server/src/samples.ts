// The project's samples: WAV files in <project>/samples/, imported with `sample import`. A sample
// layer names one; its bytes' SHA-256 is part of the render key, so a changed file renders again.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { readSampleWav, resampleMethod, sha256Hex, type SampleBank, type SampleData } from '@soundclaw/core';
import { ProjectError } from './project.ts';

export interface SampleInfo {
  name: string;
  sha256: string;
  /** The file's own rate and length. */
  rate: number;
  frames: number;
  seconds: number;
  channels: number;
  bytes: number;
}

/** What `sample import` and `sample list` say about one sample: length, rate (and how a rate other than 44,100 Hz is converted), channels and how to use them. */
export function sampleLine(x: SampleInfo, created?: boolean): string {
  const head = `${created === undefined ? '' : created ? 'imported ' : 'already in the project: '}sample ${x.name}: ${x.seconds.toFixed(3)} s, ${x.rate} Hz`;
  const ch = x.channels === 1 ? ', mono' : x.channels === 2 ? ', stereo' : `, ${x.channels} channels`;
  const notes: string[] = [];
  if (x.rate !== 44100) notes.push(`${resampleMethod(x.rate, 44100)} when a layer plays it`);
  if (x.channels === 2) notes.push(`a layer plays the mix of both channels; for stereo use two layers: layer add <sound> sample sample=${x.name} side=left pan=-1 and layer add <sound> sample sample=${x.name} side=right pan=1`);
  else if (x.channels > 2) notes.push(`a layer plays the mix of all channels; side=left and side=right play the first two`);
  return `${head}${ch}${notes.length ? '\n  ' + notes.join('\n  ') : ''}`;
}

/** A sample's name keeps its case, like a sound's id; two names that differ only in case are one name too many (see `import`). */
export const SAMPLE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

interface Entry {
  stamp: string;
  info: SampleInfo;
  /** The decoded audio: read when a render needs it, not when the list is asked for. */
  data?: SampleData;
}

export class SampleStore implements SampleBank {
  readonly dir: string;
  private readonly entries = new Map<string, Entry>();

  /** What was worked out about each file (by its size and time stamp), kept between runs: hashing a hundred files takes seconds. */
  private readonly infoFile: string;
  private known: Record<string, { stamp: string; info: SampleInfo }> | null = null;
  private dirty = false;

  constructor(projectDir: string) {
    this.dir = join(projectDir, 'samples');
    this.infoFile = join(projectDir, '.cache', 'samples.json');
  }

  private knownInfo(name: string, stamp: string): SampleInfo | undefined {
    if (!this.known) {
      try {
        this.known = existsSync(this.infoFile) ? (JSON.parse(readFileSync(this.infoFile, 'utf8')) as typeof this.known) : {};
      } catch {
        this.known = {};
      }
    }
    const k = this.known![name];
    return k && k.stamp === stamp ? k.info : undefined;
  }

  /** Write the info kept for the files, if it changed. */
  flush(): void {
    if (!this.dirty || !this.known) return;
    this.dirty = false;
    try {
      mkdirSync(join(this.dir, '..', '.cache'), { recursive: true });
      writeFileSync(`${this.infoFile}.${process.pid}.tmp`, JSON.stringify(this.known));
      renameSync(`${this.infoFile}.${process.pid}.tmp`, this.infoFile);
    } catch {
      // the cache is only a speed-up
    }
  }

  private file(name: string): string {
    return join(this.dir, `${name}.wav`);
  }

  private load(name: string, withData = false): Entry | undefined {
    if (!SAMPLE_NAME_RE.test(name)) return undefined;
    const f = this.file(name);
    // exact case: on a disk that ignores case `Boom` must not find boom.wav
    if (!existsSync(f) || !this.names().includes(name)) { this.entries.delete(name); return undefined; }
    const st = statSync(f);
    const stamp = `${st.mtimeMs}:${st.size}`;
    const have = this.entries.get(name);
    if (have && have.stamp === stamp && (have.data || !withData)) return have;
    try {
      const known = have?.stamp === stamp ? have.info : this.knownInfo(name, stamp);
      if (known && !withData) {
        const e: Entry = { stamp, info: known };
        this.entries.set(name, e);
        return e;
      }
      const bytes = new Uint8Array(readFileSync(f));
      const w = readSampleWav(bytes);
      const info = known ?? { name, sha256: sha256Hex(bytes), rate: w.rate, frames: w.frames, seconds: w.frames / w.rate, channels: w.channels, bytes: bytes.length };
      const e: Entry = { stamp, info, data: { rate: w.rate, data: w.data, ...(w.left && w.right ? { left: w.left, right: w.right } : {}) } };
      this.entries.set(name, e);
      if (!known) { (this.known ??= {})[name] = { stamp, info }; this.dirty = true; }
      return e;
    } catch {
      return undefined;
    }
  }

  private nameList: { stamp: number; names: string[] } | null = null;

  names(): string[] {
    if (!existsSync(this.dir)) return [];
    // the folder's listing is kept until the folder changes (it is asked for once for each sample looked at)
    const stamp = statSync(this.dir).mtimeMs;
    if (this.nameList?.stamp === stamp) return this.nameList.names;
    const names = readdirSync(this.dir).filter((f) => f.endsWith('.wav') && SAMPLE_NAME_RE.test(f.slice(0, -4))).map((f) => f.slice(0, -4)).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : a < b ? -1 : 1));
    this.nameList = { stamp, names };
    return names;
  }

  list(): SampleInfo[] {
    const all = this.names().flatMap((n) => { const e = this.load(n); return e ? [e.info] : []; });
    this.flush();
    return all;
  }

  get(name: string): SampleData | undefined {
    return this.load(name, true)?.data;
  }

  hash(name: string): string | undefined {
    return this.load(name)?.info.sha256;
  }

  info(name: string): SampleInfo | undefined {
    return this.load(name)?.info;
  }

  bytes(name: string): Uint8Array | undefined {
    return this.load(name) ? new Uint8Array(readFileSync(this.file(name))) : undefined;
  }

  /**
   * Import every WAV file in a folder (not its sub-folders), named by file name as `import` does. One file that cannot be read or whose name
   * is taken by other content does not stop the others: it is reported. Returns what was done, in file order.
   */
  importDir(dir: string): { imported: { info: SampleInfo; created: boolean; file: string }[]; problems: string[] } {
    const path = resolve(dir);
    const files = readdirSync(path).filter((f) => /\.wav$/i.test(f) && statSync(join(path, f)).isFile()).sort();
    const imported: { info: SampleInfo; created: boolean; file: string }[] = [];
    const problems: string[] = [];
    const names = new Map<string, string>(); // by lower case: names that differ only in case clash
    for (const f of files) {
      try {
        const r = this.import(join(path, f));
        const clash = names.get(r.info.name.toLowerCase());
        if (clash) problems.push(`${f}: gets the name '${r.info.name}' that ${clash} has too (the later file is the one kept; rename one of them)`);
        names.set(r.info.name.toLowerCase(), f);
        imported.push({ ...r, file: f });
      } catch (e) {
        if (e instanceof ProjectError) problems.push(`${f}: ${e.message}`);
        else throw e;
      }
    }
    if (!files.length) problems.push(`no .wav files in ${dir}`);
    return { imported, problems };
  }

  /** Copy a WAV file into the project's samples folder. */
  import(file: string, as?: string): { info: SampleInfo; created: boolean } {
    const path = resolve(file);
    if (!existsSync(path) || !statSync(path).isFile()) throw new ProjectError(`no file ${file}`);
    const name = as ?? basename(path, extname(path)).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(0, 48);
    if (!SAMPLE_NAME_RE.test(name)) throw new ProjectError(`'${name}' is not a sample name (letters, digits, _ and -, at most 48 characters): give as=<name>`);
    const bytes = new Uint8Array(readFileSync(path));
    let w;
    try {
      w = readSampleWav(bytes);
    } catch (e) {
      throw new ProjectError(`${file}: ${(e as Error).message}`);
    }
    const other = this.names().find((n) => n !== name && n.toLowerCase() === name.toLowerCase());
    if (other) throw new ProjectError(`sample '${name}' clashes with the sample '${other}': names are unique ignoring case; give a different name (as=<name>)`);
    const dest = this.file(name);
    this.nameList = null;
    let created = true;
    if (existsSync(dest)) {
      const old = new Uint8Array(readFileSync(dest));
      if (sha256Hex(old) !== sha256Hex(bytes)) throw new ProjectError(`sample '${name}' exists with other content; give a different name (as=<name>)`);
      created = false;
    } else {
      mkdirSync(this.dir, { recursive: true });
      if (resolve(path) !== resolve(dest)) copyFileSync(path, dest);
      else writeFileSync(dest, bytes);
    }
    void w;
    const info = this.load(name)!.info;
    this.flush();
    return { info, created };
  }
}
