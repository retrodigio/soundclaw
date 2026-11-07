// The project's samples: WAV files in <project>/samples/, imported with `sample import`. A sample
// layer names one; its bytes' SHA-256 is part of the render key, so a changed file renders again.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
  data: SampleData;
}

export class SampleStore implements SampleBank {
  readonly dir: string;
  private readonly entries = new Map<string, Entry>();

  constructor(projectDir: string) {
    this.dir = join(projectDir, 'samples');
  }

  private file(name: string): string {
    return join(this.dir, `${name}.wav`);
  }

  private load(name: string): Entry | undefined {
    if (!SAMPLE_NAME_RE.test(name)) return undefined;
    const f = this.file(name);
    // exact case: on a disk that ignores case `Boom` must not find boom.wav
    if (!existsSync(f) || !this.names().includes(name)) { this.entries.delete(name); return undefined; }
    const st = statSync(f);
    const stamp = `${st.mtimeMs}:${st.size}`;
    const have = this.entries.get(name);
    if (have && have.stamp === stamp) return have;
    try {
      const bytes = new Uint8Array(readFileSync(f));
      const w = readSampleWav(bytes);
      const e: Entry = { stamp, info: { name, sha256: sha256Hex(bytes), rate: w.rate, frames: w.frames, seconds: w.frames / w.rate, channels: w.channels, bytes: bytes.length }, data: { rate: w.rate, data: w.data, ...(w.left && w.right ? { left: w.left, right: w.right } : {}) } };
      this.entries.set(name, e);
      return e;
    } catch {
      return undefined;
    }
  }

  names(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith('.wav') && SAMPLE_NAME_RE.test(f.slice(0, -4))).map((f) => f.slice(0, -4)).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : a < b ? -1 : 1));
  }

  list(): SampleInfo[] {
    return this.names().flatMap((n) => { const e = this.load(n); return e ? [e.info] : []; });
  }

  get(name: string): SampleData | undefined {
    return this.load(name)?.data;
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
    return { info: this.load(name)!.info, created };
  }
}
