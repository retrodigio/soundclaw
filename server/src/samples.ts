// The project's samples. Audio lives once per content in samples/objects/<first two hex>/<hash>.wav, named by its
// canonical hash (core/src/pcm.ts); objects are never rewritten or renamed. Names for them live on the tape
// (`sample add <name> hash=…`), so undo brings old audio back. A 0.1.x project keeps working: its
// samples/<name>.wav files read as samples that are not on the tape yet, until `soundclaw upgrade` moves them in.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeAudio, sampleKeyPart, itemLicence, licenceState, pcmHash, pcmToSampleData, pcmToWav, resampleMethod, shipPolicyOf, DEFAULT_SHIP_POLICY, noteLabel,
  SAMPLE_NAME_RE, type Library, type LicenceState, type PcmAudio, type SampleBank, type SampleData, type SampleEntry, type ShipPolicy,
} from '@soundclaw/core';

export { SAMPLE_NAME_RE };

/** What a page, the CLI and the tools are told about one sample. */
export interface SampleInfo {
  name: string;
  /** The canonical hash of the audio (the key of what to hold, and of `GET /api/sample-object/<hash>`). */
  sha256: string;
  /** The file's own rate and length. */
  rate: number;
  frames: number;
  seconds: number;
  channels: number;
  /** The size of the stored object. */
  bytes: number;
  format: string;
  licence: string;
  licenceState: LicenceState;
  source: string;
  tags: string[];
  root?: string;
  /** Slice points and loop points in frames, loop mode, the licence's attribution is not here. */
  slices?: number[];
  loop?: [number, number];
  loopMode?: string;
  /** A 0.1.x file that is not on the tape yet (`soundclaw upgrade` moves it into the store). */
  legacy?: true;
}

/** What `sample import` and `sample list` say about one sample: length, rate (and how a rate other than 44,100 Hz is converted), channels and how to use them. */
export function sampleLine(x: SampleInfo, created?: boolean, note?: string): string {
  const head = `${created === undefined ? '' : created ? 'imported ' : 'already in the project: '}sample ${x.name}: ${x.seconds.toFixed(3)} s, ${x.rate} Hz, ${x.format}`;
  const ch = x.channels === 1 ? ', mono' : x.channels === 2 ? ', stereo' : `, ${x.channels} channels`;
  const notes: string[] = [];
  if (x.rate !== 44100) notes.push(`${resampleMethod(x.rate, 44100)} when a layer plays it`);
  if (x.channels === 2) notes.push(`a layer plays the mix of both channels; side=left and side=right play one, side=stereo plays both (layer add <sound> sample sample=${x.name} side=stereo)`);
  else if (x.channels > 2) notes.push(`a layer plays the mix of all channels; side=left and side=right play the first two`);
  if (note) notes.push(note);
  return `${head}${ch}${notes.length ? '\n  ' + notes.join('\n  ') : ''}`;
}

// ---- the object store ---------------------------------------------------------------------------------------------------

export class ObjectStore {
  readonly dir: string;

  constructor(projectDir: string) {
    this.dir = join(projectDir, 'samples', 'objects');
  }

  path(hash: string): string {
    return join(this.dir, hash.slice(0, 2), `${hash}.wav`);
  }

  has(hash: string): boolean {
    return /^[0-9a-f]{64}$/.test(hash) && existsSync(this.path(hash));
  }

  /** The stored WAV's bytes. */
  read(hash: string): Uint8Array | undefined {
    return this.has(hash) ? new Uint8Array(readFileSync(this.path(hash))) : undefined;
  }

  /**
   * Keep audio under its hash. An object that exists is never touched. The file is written whole under a temporary name and moved into
   * place, so a reader (or a crash) never sees half an object.
   */
  put(audio: PcmAudio, hash: string = pcmHash(audio)): { hash: string; created: boolean; bytes: number } {
    const dest = this.path(hash);
    if (existsSync(dest)) return { hash, created: false, bytes: statSync(dest).size };
    const wav = pcmToWav(audio);
    mkdirSync(join(this.dir, hash.slice(0, 2)), { recursive: true });
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, wav);
    renameSync(tmp, dest);
    return { hash, created: true, bytes: wav.length };
  }

  /** Every object: hash and size. */
  list(): { hash: string; bytes: number }[] {
    if (!existsSync(this.dir)) return [];
    const out: { hash: string; bytes: number }[] = [];
    for (const d of readdirSync(this.dir)) {
      if (!/^[0-9a-f]{2}$/.test(d)) continue;
      for (const f of readdirSync(join(this.dir, d))) {
        const m = /^([0-9a-f]{64})\.wav$/.exec(f);
        if (m) out.push({ hash: m[1]!, bytes: statSync(join(this.dir, d, f)).size });
      }
    }
    return out.sort((a, b) => (a.hash < b.hash ? -1 : 1));
  }

  totalBytes(): number {
    return this.list().reduce((n, o) => n + o.bytes, 0);
  }

  remove(hash: string): void {
    rmSync(this.path(hash), { force: true });
  }

  /** The audio of an object, decoded from its stored WAV. */
  audio(hash: string): PcmAudio | undefined {
    const b = this.read(hash);
    return b ? decodeAudio(b, { lenient: true }).audio : undefined;
  }
}

/** Where a name's audio is: an object of the store, or (a 0.1.x file) a WAV in the samples folder. */
export interface Resolved {
  hash: string;
  /** The sample's slice and loop points (frames at its own rate): a layer can play a slice or loop. */
  slices?: number[];
  loop?: [number, number];
  /** The file of a 0.1.x sample, when the audio is not in the store. */
  file?: string;
}

/** A sample bank over the store: a name is resolved to a hash, the hash to decoded audio (kept by hash). */
export class MapBank implements SampleBank {
  protected readonly decoded = new Map<string, SampleData>();
  protected readonly objects: ObjectStore;
  protected resolver: (name: string) => Resolved | undefined;

  constructor(objects: ObjectStore, resolver: (name: string) => Resolved | undefined = () => undefined) {
    this.objects = objects;
    this.resolver = resolver;
  }

  protected load(r: Resolved): SampleData | undefined {
    const have = this.decoded.get(r.hash);
    if (have) return have;
    try {
      const audio = r.file ? decodeAudio(new Uint8Array(readFileSync(r.file)), { lenient: true }).audio : this.objects.audio(r.hash);
      if (!audio) return undefined;
      const data = pcmToSampleData(audio);
      this.decoded.set(r.hash, data);
      return data;
    } catch {
      return undefined;
    }
  }

  get(name: string): SampleData | undefined {
    const r = this.resolver(name);
    const data = r ? this.load(r) : undefined;
    return data && (r!.slices || r!.loop) ? { ...data, ...(r!.slices ? { slices: r!.slices } : {}), ...(r!.loop ? { loop: r!.loop } : {}) } : data;
  }

  /** What the render key holds for the sample: its audio's hash, with the slice and loop points when it has them. */
  hash(name: string): string | undefined {
    const r = this.resolver(name);
    return r ? sampleKeyPart(r) : undefined;
  }
}

// ---- the project's samples --------------------------------------------------------------------------------------------

interface Legacy {
  file: string;
  stamp: string;
  entry: SampleEntry;
  bytes: number;
}

export class SampleStore extends MapBank {
  readonly dir: string;
  readonly store: ObjectStore;
  private readonly legacyCache = new Map<string, Legacy>();
  private policy: ShipPolicy = DEFAULT_SHIP_POLICY;
  private readonly entries: () => ReadonlyMap<string, SampleEntry>;

  /** `entries` gives the samples the tape names right now (the writer's library). */
  constructor(projectDir: string, entries: () => ReadonlyMap<string, SampleEntry>, shipPolicy?: unknown) {
    const store = new ObjectStore(projectDir);
    super(store);
    this.entries = entries;
    this.resolver = (name) => this.resolve(name);
    this.dir = join(projectDir, 'samples');
    this.store = store;
    this.setPolicy(shipPolicy);
  }

  setPolicy(json: unknown): void {
    this.policy = shipPolicyOf(json);
  }

  get shipPolicy(): ShipPolicy {
    return this.policy;
  }

  /** The 0.1.x files in samples/ that the tape does not name. */
  private legacyFiles(): Map<string, Legacy> {
    const out = new Map<string, Legacy>();
    if (!existsSync(this.dir)) return out;
    const named = this.entries();
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.wav')) continue;
      const name = f.slice(0, -4);
      if (!SAMPLE_NAME_RE.test(name) || named.has(name)) continue;
      const file = join(this.dir, f);
      const st = statSync(file);
      if (!st.isFile()) continue;
      const stamp = `${st.mtimeMs}:${st.size}`;
      const have = this.legacyCache.get(name);
      if (have && have.stamp === stamp) { out.set(name, have); continue; }
      try {
        const audio = decodeAudio(new Uint8Array(readFileSync(file)), { lenient: true }).audio;
        const hash = pcmHash(audio);
        const entry: SampleEntry = {
          name, hash, rate: audio.rate, channels: audio.channels, frames: audio.frames, format: audio.format, tags: [],
          prov: { source: 'file', origin: f }, licence: { id: 'unknown' },
        };
        const l: Legacy = { file, stamp, entry, bytes: pcmToWav(audio).length };
        this.legacyCache.set(name, l);
        out.set(name, l);
      } catch {
        // a file that is not audio is not a sample
      }
    }
    return out;
  }

  private resolve(name: string): Resolved | undefined {
    const e = this.entries().get(name);
    if (e) return { hash: e.hash, ...(e.slices?.length ? { slices: e.slices } : {}), ...(e.loop ? { loop: e.loop } : {}) };
    const l = this.legacyFiles().get(name);
    return l ? { hash: l.entry.hash, file: l.file } : undefined;
  }

  /** Every sample the project has: those the tape names, and 0.1.x files not yet moved into the store. */
  all(): { entry: SampleEntry; legacy: boolean; bytes: number }[] {
    const out = [...this.entries().values()].map((entry) => ({ entry, legacy: false, bytes: this.objectBytes(entry.hash) }));
    for (const l of this.legacyFiles().values()) out.push({ entry: l.entry, legacy: true, bytes: l.bytes });
    return out.sort((a, b) => (a.entry.name.toLowerCase() < b.entry.name.toLowerCase() ? -1 : a.entry.name.toLowerCase() > b.entry.name.toLowerCase() ? 1 : a.entry.name < b.entry.name ? -1 : 1));
  }

  private readonly sizes = new Map<string, number>();

  /** An object's size: objects never change, so it is looked up once. */
  private objectBytes(hash: string): number {
    const have = this.sizes.get(hash);
    if (have !== undefined) return have;
    try { const n = statSync(this.store.path(hash)).size; this.sizes.set(hash, n); return n; } catch { return 0; }
  }

  names(): string[] {
    return this.all().map((x) => x.entry.name);
  }

  /** The entry for a name (the tape's, else a 0.1.x file's). */
  entry(name: string): SampleEntry | undefined {
    return this.entries().get(name) ?? this.legacyFiles().get(name)?.entry;
  }

  infoOf(x: { entry: SampleEntry; legacy: boolean; bytes: number }): SampleInfo {
    const e = x.entry;
    return {
      name: e.name, sha256: e.hash, rate: e.rate, frames: e.frames, seconds: e.frames / e.rate, channels: e.channels, bytes: x.bytes, format: e.format,
      licence: e.licence.id, licenceState: licenceState(e.licence, this.policy).state, source: e.prov.source, tags: e.tags,
      ...(e.root !== undefined ? { root: noteLabel(e.root) } : {}), ...(e.slices?.length ? { slices: e.slices } : {}), ...(e.loop ? { loop: e.loop } : {}), ...(e.loopMode ? { loopMode: e.loopMode } : {}), ...(x.legacy ? { legacy: true as const } : {}),
    };
  }

  list(): SampleInfo[] {
    return this.all().map((x) => this.infoOf(x));
  }

  info(name: string): SampleInfo | undefined {
    const x = this.all().find((y) => y.entry.name === name);
    return x ? this.infoOf(x) : undefined;
  }

  /** Is the audio for this hash here (an object, or a 0.1.x file)? */
  hasObject(hash: string): boolean {
    return this.store.has(hash) || [...this.legacyFiles().values()].some((l) => l.entry.hash === hash);
  }

  /** The stored WAV of a hash (a 0.1.x file is written out in the stored form). */
  objectBytes2(hash: string): Uint8Array | undefined {
    const o = this.store.read(hash);
    if (o) return o;
    const l = [...this.legacyFiles().values()].find((x) => x.entry.hash === hash);
    return l ? pcmToWav(decodeAudio(new Uint8Array(readFileSync(l.file)), { lenient: true }).audio) : undefined;
  }

  /** The WAV bytes a name stands for. */
  bytes(name: string): Uint8Array | undefined {
    const e = this.entry(name);
    return e ? this.objectBytes2(e.hash) : undefined;
  }

  /** What a worker thread needs to read the audio these names stand for: the name, the hash and (a 0.1.x file) where it is. */
  refs(names: string[]): ({ name: string } & Resolved)[] {
    return names.flatMap((name) => { const r = this.resolve(name); return r ? [{ name, ...r }] : []; });
  }

  /** Kept for callers that flushed the old store's cache. */
  flush(): void {}

  /** How the project's samples stand against the store's size limits: the store's total bytes. */
  storeBytes(): number {
    return this.store.totalBytes();
  }

  /** The decoded audio of a library as the tape names it, for a library other than the writer's current one. */
  bankFor(lib: Library): SampleBank {
    return new MapBank(this.store, (name) => {
      const e = lib.samples.get(name);
      return e ? { hash: e.hash, ...(e.slices?.length ? { slices: e.slices } : {}), ...(e.loop ? { loop: e.loop } : {}) } : this.resolve(name);
    });
  }

  /** How an item (a sound, instrument or song) stands under the project's ship policy. */
  itemLicence(lib: Library, kind: 'sound' | 'instrument' | 'song' | 'sample', id: string, allowed: readonly string[] = []) {
    return itemLicence(lib, kind, id, this.policy, allowed);
  }
}
