// The project's samples: WAV files in <project>/samples/, imported with `sample import`. A sample
// layer names one; its bytes' SHA-256 is part of the render key, so a changed file renders again.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { readSampleWav, sha256Hex, type SampleBank, type SampleData } from '@soundclaw/core';
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

export const SAMPLE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

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
    if (!existsSync(f)) { this.entries.delete(name); return undefined; }
    const st = statSync(f);
    const stamp = `${st.mtimeMs}:${st.size}`;
    const have = this.entries.get(name);
    if (have && have.stamp === stamp) return have;
    try {
      const bytes = new Uint8Array(readFileSync(f));
      const w = readSampleWav(bytes);
      const e: Entry = { stamp, info: { name, sha256: sha256Hex(bytes), rate: w.rate, frames: w.frames, seconds: w.frames / w.rate, channels: w.channels, bytes: bytes.length }, data: { rate: w.rate, data: w.data } };
      this.entries.set(name, e);
      return e;
    } catch {
      return undefined;
    }
  }

  names(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith('.wav') && SAMPLE_NAME_RE.test(f.slice(0, -4))).map((f) => f.slice(0, -4)).sort();
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

  /** Copy a WAV file into the project's samples folder. */
  import(file: string, as?: string): { info: SampleInfo; created: boolean } {
    const path = resolve(file);
    if (!existsSync(path) || !statSync(path).isFile()) throw new ProjectError(`no file ${file}`);
    const name = as ?? basename(path, extname(path)).toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[^a-z0-9]+/, '').slice(0, 48);
    if (!SAMPLE_NAME_RE.test(name)) throw new ProjectError(`'${name}' is not a sample name (a-z, 0-9, _ and -, at most 48 characters): give as=<name>`);
    const bytes = new Uint8Array(readFileSync(path));
    let w;
    try {
      w = readSampleWav(bytes);
    } catch (e) {
      throw new ProjectError(`${file}: ${(e as Error).message}`);
    }
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
