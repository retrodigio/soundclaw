// The single writer. Every change to a project goes through one Writer, in the order it arrives
// (a queue), so the history tape has one author at a time: a batch is parsed, checked against a
// copy of the sounds, and only if all of it fits is it appended to the tape as one group. A
// running server owns the Writer; the CLI sends its writing commands to that server.

import { BIBLE_FILE, STYLE_FILE, musicGuide, type MusicGuide } from '@soundclaw/core';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { activeGroups, renderKey, AUTHOR_RE, builtinInstruments, lookupInstrument, songProblems, songText, songToJson, type Instrument, type SongDoc, analyze, applyCommand, copyLibrary, FAMILIES, historyTarget, joinChannels, matchGain, loudnessOf, measuredChannels, fullScaleOf, measureSet, nextGroup, parse, replay, resolveStyle, runChecks, samplesHash, sha256Text, serializeSet, serializeSound, soundExport, soundStyle, classTable, loudnessFor, setTarget, type LoudnessRule, type Command, type Diag, type Parsed, type Library, type SetDoc, type SetMeasure, type Sound, type Style, type TapeEntry } from '@soundclaw/core';
import { Hub } from './await.ts';
import { RenderCache, type Rendered } from './cache.ts';
import { SampleStore } from './samples.ts';
import { expand, MEASURED_OPS, restoreDerived } from './sampleedit.ts';
import { instrumentSamples, isSampleOp, settleSampleAdd, soundSamples, type SampleCommand, type SampleEntry } from '@soundclaw/core';
import type { Measured } from './ears.ts';
import { ProjectError, appendTape, readTape, writeInstruments, writeSamples, writeSets, writeSongs, writeSounds, type Project } from './project.ts';
import { normalizePlan } from './normalize.ts';
import { SongBench, type SongMeasured } from './songs.ts';
import { LEAN_AT, type BatchProgress, type CardLite, type ServerMessage, type Snapshot, type SoundSummary } from './protocol.ts';
import { Thumbs } from './thumbs.ts';
import { readRequestRecords, readRequests } from './requests.ts';

export interface RunRequest {
  commands: string;
  /** The author: `agent:<name>` or `human:<name>`. */
  by: string;
}

export type RunOutcome =
  | { ok: true; group: string | null; added: TapeEntry[]; /** Sounds the batch created or changed (or removed, by an undo). */ touched: string[]; /** Sets it created or changed. */ touchedSets: string[]; /** Songs and instruments it created or changed. */ touchedSongs: string[]; touchedInstruments: string[]; warnings: string[] }
  | { ok: false; errors: Diag[] };

export interface HistoryRequest {
  sound?: string;
  by?: string;
  /** The newest this many entries (default all). */
  limit?: number;
}

export type Listener = (m: ServerMessage) => void;

export interface WriterOptions {
  /** The clock for tape `at` stamps (UTC, whole seconds). */
  now?: () => string;
}

/** The newest tape entries a lean snapshot carries. */
const TAPE_PAGE = 200;

const utcNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The sound a tape command is about (its first argument), if any. */
function soundOf(cmd: string): string | null {
  const sound = /^(?:sound (?:new|set|mark|patch|generate|mutate|layer-up|classic|loop|copy|rename|remove)|layer (?:add|set|remove|move|mute|solo)|fx (?:add|set|remove|move)|env|family) (\S+)/.exec(cmd)?.[1];
  if (sound) return sound;
  // a song's commands name the song (a pattern as <song>.<name>), an instrument's the instrument
  return /^song (?:new|set|order|intro|ending|loop|copy|rename|remove|mark) (\S+)/.exec(cmd)?.[1] ?? /^song (?:channel|section|fx) (?:add|set|remove|move) (\S+)/.exec(cmd)?.[1] ?? /^pattern (?:set|remove|copy|rename) ([^.\s]+)\./.exec(cmd)?.[1]
    ?? /^instrument (?:new|from-sound|set|copy|rename|remove) (\S+)/.exec(cmd)?.[1] ?? /^instrument (?:layer|fx|env) (?:(?:add|set|remove|move|mute|solo) )?(\S+)/.exec(cmd)?.[1] ?? null;
}

export class Writer {
  project: Project;
  readonly hub = new Hub();
  readonly cache: RenderCache;
  /** Renders and measurements of songs. */
  readonly bench: SongBench;
  /** The project's samples: names the tape gives to audio in the store (samples/objects), and 0.1.x files (samples/*.wav) not moved in yet. */
  readonly samples: SampleStore;
  /** The cards (numbers, checks, thumbnails) worked out in worker threads. */
  readonly thumbs: Thumbs;
  /** What the checks are held to: the project's `style`, else the defaults. */
  readonly style: Style;
  private readonly measured = new Map<string, Measured>();
  private entries: TapeEntry[];
  private library: Library;
  private readonly listeners = new Set<Listener>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => string;
  private batchCount = 0;
  private lastBatch: BatchProgress | null = null;

  constructor(project: Project, o: WriterOptions = {}) {
    this.project = project;
    this.now = o.now ?? utcNow;
    this.cache = new RenderCache(project.dir);
    this.bench = new SongBench(this);
    this.samples = new SampleStore(project.dir, () => this.library.samples, project.json.licences);
    this.thumbs = new Thumbs(this);
    try {
      this.style = resolveStyle(project.json.style);
    } catch (e) {
      throw new ProjectError(`project.json: ${(e as Error).message}`);
    }
    this.entries = readTape(project);
    this.library = this.replayed(this.entries);
    // a derived sample whose audio is not in the store is made again from its parents; the hash must come out the same
    try { restoreDerived(this, this.library); } catch (e) { throw new ProjectError((e as Error).message); }
    this.hub.attach(readRequestRecords(project));
    this.hub.onPresence = () => this.emit({ type: 'presence', presence: this.hub.presence() });
  }

  private replayed(entries: TapeEntry[]): Library {
    const r = replay(entries);
    if (r.problems.length) throw new ProjectError(`history seq ${r.problems[0]!.seq}: ${r.problems[0]!.message} (the tape does not replay)`);
    return r.library;
  }

  /** Tell the watchers requests.jsonl changed. */
  requestsChanged(): void {
    this.hub.syncRequests(readRequestRecords(this.project), readRequests(this.project));
    this.emit({ type: 'requests', requests: [...readRequests(this.project).values()] });
  }

  /** The multi-item batch running now, or the last one that ran. */
  batchProgress(): BatchProgress | null {
    return this.lastBatch;
  }

  /** How many items a command is: a set's members (loudness matched one by one), else one. */
  private itemsOf(c: Command): number {
    if (c.op === 'set-new') return c.count;
    if (c.op === 'set-regen') return this.library.sets.get(c.id)?.generated.length ?? 1;
    return 1;
  }

  /** The writer's clock (UTC, whole seconds), as tape lines are stamped. */
  stamp(): string {
    return this.now();
  }

  /** Listen to applied batches; returns the unsubscribe function. */
  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(m: ServerMessage): void {
    for (const fn of this.listeners) {
      try {
        fn(m);
      } catch {
        // a broken listener must not stop the writer
      }
    }
  }

  /** Run `fn` after everything queued before it: the order commands arrive is the order applied. */
  enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** The sounds, by id. */
  sounds(): Sound[] {
    return [...this.library.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  sound(id: string): Sound {
    const s = this.library.get(id);
    if (!s) throw new ProjectError(`no sound '${id}'${this.library.size ? ` (sounds: ${[...this.library.keys()].sort().join(', ')})` : ': make one with `sound new <id>`'}`);
    return s;
  }

  has(id: string): boolean {
    return this.library.has(id);
  }

  /** The sets, by name. */
  sets(): SetDoc[] {
    return [...this.library.sets.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  set(id: string): SetDoc {
    const s = this.library.sets.get(id);
    if (!s) throw new ProjectError(`no set '${id}'${this.library.sets.size ? ` (sets: ${[...this.library.sets.keys()].sort().join(', ')})` : ': make one with `set new <set> from=<sound> count=<n>`'}`);
    return s;
  }

  hasSet(id: string): boolean {
    return this.library.sets.has(id);
  }

  /** The project's instruments, by id. */
  instruments(): Instrument[] {
    return [...this.library.instruments.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** An instrument of the project, else a built-in one. */
  lookupInstrument(id: string): Instrument | undefined {
    return lookupInstrument(this.library, id);
  }

  songs(): SongDoc[] {
    return [...this.library.songs.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  song(id: string): SongDoc {
    const s = this.library.songs.get(id);
    if (!s) throw new ProjectError(`no song '${id}'${this.library.songs.size ? ` (songs: ${[...this.library.songs.keys()].sort().join(', ')})` : ': make one with `song new <id>`'}`);
    return s;
  }

  hasSong(id: string): boolean {
    return this.library.songs.has(id);
  }

  /** What stops a song playing (errors) and what is worth saying (warnings). */
  songProblems(id: string): { errors: string[]; warnings: string[] } {
    return songProblems(this.song(id), (i) => !!this.lookupInstrument(i));
  }

  private guideStamp = '';
  private guideCache: { guide: MusicGuide; text: string } | null = null;

  /**
   * The project's music style guide and bible (music-style.md, music-bible.md), read again when a
   * file changes: people edit them by hand.
   */
  musicGuide(): { guide: MusicGuide; text: string } {
    const files = [STYLE_FILE, BIBLE_FILE].map((f) => join(this.project.dir, f));
    const stamp = files.map((f) => { try { const st = statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return '-'; } }).join('|');
    if (stamp !== this.guideStamp || !this.guideCache) {
      const read = (f: string): string | null => (existsSync(f) ? readFileSync(f, 'utf8') : null);
      const [a, b] = files.map(read);
      this.guideCache = { guide: musicGuide(a!, b!), text: `${a ?? ''}\u0000${b ?? ''}` };
      this.guideStamp = stamp;
    }
    return this.guideCache;
  }

  /** A song's numbers and checks, measured once for each distinct document. */
  measureSong(id: string): SongMeasured {
    return this.bench.measure(this.song(id));
  }

  /** A class a command names must be in the style (a replay does not ask: a style may change). */
  private checkClassNames(c: Command): void {
    const names: string[] = [];
    if (c.op === 'set') for (const [n, v] of c.values) if (n === 'class' && typeof v === 'string' && v !== 'none') names.push(v);
    if ((c.op === 'set-new' || c.op === 'set-class') && c.class) names.push(c.class);
    const table = classTable(this.style);
    for (const n of names) if (!table[n]) throw new Error(`no loudness class '${n}' (classes: ${Object.keys(table).join(', ')}; project.json style.loudnessClasses adds more)`);
  }

  /** Run `f` with `lib` as the library the writer reads, so a measurement sees a batch's changes before they are written. */
  private measuring<T>(lib: Library, f: () => T): T {
    const saved = this.library;
    this.library = lib;
    try { return f(); } finally { this.library = saved; }
  }

  /** The commands (and notes) that match the loudness of the sounds a set or family command made or changed, by gain. */
  private matchAfter(lib: Library, c: Command, onItem?: (id: string) => void): { commands: string[]; notes: string[] } {
    const out = { commands: [] as string[], notes: [] as string[] };
    let target: number | null = null;
    let ids: string[] = [];
    if (c.op === 'set-new' || c.op === 'set-retarget' || c.op === 'set-regen' || c.op === 'set-add' || c.op === 'set-class') {
      const set = lib.sets.get(c.id)!;
      target = setTarget(set, this.style);
      ids = c.op === 'set-add' ? c.sounds : c.op === 'set-regen' ? set.generated : set.members;
    } else if (c.op === 'family') {
      const lufs = loudnessOf(lib.get(c.id)!, this.samples);
      // the variant is held to the source's loudness plus the family's offset
      target = Number.isFinite(lufs) ? lufs + FAMILIES[c.kind].gainDb : null;
      const as = c.as ?? `${c.id}_${c.kind}`;
      ids = [as];
    }
    if (target === null) {
      for (const id of ids) onItem?.(id);
      return out;
    }
    for (const id of ids) {
      const m = matchGain(lib.get(id)!, target, this.samples, this.style);
      if (m.command) out.commands.push(m.command);
      if (m.note) out.notes.push(m.note);
      if (m.error) out.notes.push(m.error);
      onItem?.(id);
    }
    return out;
  }

  private readonly setMeasures = new Map<string, SetMeasure>();

  /** A set's distance matrix, loudness of its members and set-spread check, measured once for each distinct set of renders. */
  measureSetDoc(id: string): SetMeasure {
    const set = this.set(id);
    const members = set.members.map((m) => ({ id: m, r: this.render(m), lufs: this.measure(m).analysis.lufs, own: this.sound(m).loudness !== undefined ? this.loudnessRule(this.sound(m)).target : undefined }));
    const target = setTarget(set, this.style);
    const key = `${target}|${JSON.stringify(this.style)}|${members.map((m) => `${m.r.key}@${m.own ?? ''}`).join(',')}`;
    let m = this.setMeasures.get(key);
    if (!m) {
      m = measureSet(members.map((x) => ({ id: x.id, channels: x.r.channels, lufs: x.lufs, ...(x.own !== undefined ? { own: x.own } : {}) })), target, { ...this.style, loudnessTolerance: this.setTolerance(set) });
      this.setMeasures.set(key, m);
      if (this.setMeasures.size > 32) this.setMeasures.delete(this.setMeasures.keys().next().value!);
    }
    return m;
  }

  /** The tape as it stands (undone groups included). */
  tape(): readonly TapeEntry[] {
    return this.entries;
  }

  /** Render a sound through the content-hash cache. */
  render(id: string): Rendered {
    return this.cache.render(this.sound(id), this.samples);
  }

  /** The sound's numbers and checks, measured once for each distinct render. */
  measure(id: string): Measured {
    return this.measureSound(this.sound(id), this.render(id));
  }

  /** The loudness tolerance of a set's members: their set's class, else the default class. */
  private setTolerance(set: SetDoc): number {
    const table = classTable(this.style);
    return (set.class && table[set.class] ? table[set.class]! : table[this.style.defaultClass]!).tolerance;
  }

  /** The loudness rule a sound is held to (its class and target, and why). */
  loudnessRule(s: Sound): LoudnessRule {
    return loudnessFor(s, this.library.sets.values(), this.style);
  }

  /** The numbers and checks of any sound document (a past state, say), kept by the render's key. */
  measureSound(s: Sound, r: Rendered = this.cache.render(s, this.samples)): Measured {
    const rule = loudnessFor(s, this.library.sets.values(), this.style);
    const style = soundStyle(s, this.library.sets.values(), this.style);
    const loop = s.voice === 'layered' && !!s.loop;
    const key = `${r.key}|${rule.target}|${rule.tolerance}|${rule.basis}|${loop ? 'loop' : ''}`;
    let m = this.measured.get(key);
    if (!m) {
      const chs = measuredChannels(s, r.channels); // a classic sound is measured as its exported WAV holds it
      const analysis = analyze(chs);
      m = { analysis, checks: runChecks(chs, analysis, style, { loop, loudnessClass: rule.basis, fullScale: fullScaleOf(s) }), rule };
      this.measured.set(key, m);
      if (this.measured.size > 128) this.measured.delete(this.measured.keys().next().value!);
    }
    return m;
  }

  /** Hash of the sound's float samples (what the cards and summaries show the first 12 digits of). */
  samplesHashOf(id: string): string {
    return samplesHash(joinChannels(this.render(id).channels));
  }

  /** The sound's WAV file bytes, as exported (a layered sound goes through the limiter, its ceiling the style's true-peak limit). */
  wavOf(id: string): Uint8Array {
    return this.exportOf(id).wav;
  }

  /** The WAV and what the export did to the sound: the limiter's largest gain reduction (dB) and the channel count. */
  exportOf(id: string): { wav: Uint8Array; reductionDb: number; channels: number } {
    const r = this.render(id);
    return soundExport(this.sound(id), r.samples, { ceilingDb: this.style.truePeakMax, channels: r.channels, bank: this.samples });
  }

  /** How an item stands under the project's ship policy; `allow` lets licence ids through. */
  itemLicence(kind: 'sound' | 'instrument' | 'song' | 'sample', id: string, allow: readonly string[] = []) {
    return this.samples.itemLicence(this.sampleLibrary(), kind, id, allow);
  }

  /** The samples the tape names right now. */
  sampleEntries(): ReadonlyMap<string, SampleEntry> {
    return this.library.samples;
  }

  /** The library as it is now with the samples of a 0.1.x project that are not on the tape yet (for licence reports: read only). */
  sampleLibrary(): Library {
    const legacy = this.samples.all().filter((x) => x.legacy);
    if (!legacy.length) return this.library;
    const lib = copyLibrary(this.library);
    for (const x of legacy) lib.samples.set(x.entry.name, x.entry);
    return lib;
  }

  /** Tell the watchers the project's samples changed. */
  samplesChanged(): void {
    this.emit({ type: 'samples', samples: this.samples.list() });
  }

  history(o: HistoryRequest = {}): TapeEntry[] {
    let es = this.entries.filter((e) => (!o.by || e.by === o.by) && (!o.sound || soundOf(e.cmd) === o.sound));
    if (o.limit !== undefined) es = es.slice(-o.limit);
    return es;
  }

  private readonly specs = new WeakMap<Sound, { epoch: string; spec: { key: string; style: Style; basis: string } }>();

  /** What a card's key depends on besides the sound: the sets (targets and classes) and the samples' bytes. */
  private specEpoch(): string {
    return `${[...this.library.sets.values()].map(serializeSet).join('\n')}|${this.samples.list().map((i) => i.sha256).join(',')}`;
  }

  /** What a sound's card is held to and kept by: the render, the loudness rule and the style (a set's target or a family's offset included). */
  cardSpec(s: Sound, epoch: string = this.specEpoch()): { key: string; style: Style; basis: string } {
    const have = this.specs.get(s);
    if (have && have.epoch === epoch) return have.spec;
    const rule = loudnessFor(s, this.library.sets.values(), this.style);
    const style = soundStyle(s, this.library.sets.values(), this.style);
    const loop = s.voice === 'layered' && !!s.loop;
    const render = renderKey(s, (n) => this.samples.hash(n) ?? 'missing');
    const spec = { key: sha256Text(`${render}|${JSON.stringify(style)}|${rule.basis}|${loop ? 'loop' : ''}`), style, basis: rule.basis };
    this.specs.set(s, { epoch, spec });
    return spec;
  }

  /** Every sound with its card spec. */
  cardSpecs(): { s: Sound; spec: { key: string; style: Style; basis: string } }[] {
    const epoch = this.specEpoch();
    return this.sounds().map((s) => ({ s, spec: this.cardSpec(s, epoch) }));
  }

  /** The sound list: what the page shows before it has any document, with the numbers the server already knows. */
  index(): SoundSummary[] {
    return this.cardSpecs().map(({ s, spec }) => {
      const info = this.thumbs.lite(spec.key);
      const kinds = s.voice === 'layered' ? s.layers.map((l) => l.kind) : [];
      const label = s.voice === 'layered' ? `${s.layers.length} layer${s.layers.length === 1 ? '' : 's'}${kinds.length ? `: ${kinds.join(', ')}` : ''}${s.loop ? ` · loop ${s.loop.length} s` : ''}` : s.voice;
      return { id: s.id, voice: s.voice, status: s.status, key: spec.key, label, ...(info ? { info } : {}) };
    });
  }

  /** Whether undo and redo would do anything. */
  historyState(): { canUndo: boolean; canRedo: boolean } {
    const active = activeGroups(this.entries);
    return { canUndo: this.entries.some((e) => active.has(e.group) && !/^(undo|redo) /.test(e.cmd)), canRedo: this.entries.some((e) => active.has(e.group) && e.cmd.startsWith('undo ')) };
  }

  /** The tape's entries before `seq` (the newest `limit` of them), for the page's "earlier" button. */
  tapePage(before: number | null, limit: number): TapeEntry[] {
    const upto = before === null ? this.entries : this.entries.filter((e) => e.seq < before);
    return upto.slice(-limit);
  }

  /** Tell the watchers cards are ready (the list's badges). */
  cardsReady(cards: { id: string; key: string; info: CardLite }[]): void {
    this.emit({ type: 'cards', cards });
  }

  /** The sound documents a page gets at once, and the tape entries: all in a small project, the list and the newest entries in a lean one. */
  snapshot(): Snapshot {
    const lean = this.library.size > LEAN_AT;
    return {
      project: { name: this.project.json.name, dir: this.project.dir },
      index: this.index(),
      sounds: lean ? [] : this.sounds(),
      lean,
      history: this.historyState(),
      tapeTotal: this.entries.length,
      sets: this.sets(),
      songs: this.songs().map(songToJson),
      instruments: this.instruments(),
      samples: this.samples.list(),
      style: this.style,
      tape: lean ? this.entries.slice(-TAPE_PAGE) : [...this.entries],
      requests: [...readRequests(this.project).values()],
      presence: this.hub.presence(),
      batch: this.lastBatch,
    };
  }

  /**
   * Parse, check and apply one batch as one undo group. Any error applies nothing: not a line of
   * the tape, not a file. `undo` and `redo` are batches of their own.
   */
  run(req: RunRequest): RunOutcome {
    if (typeof req.by !== 'string' || !AUTHOR_RE.test(req.by)) throw new ProjectError(`the author is agent:<name> or human:<name> (letters, digits, . _ -), not '${req.by}'`);
    const parsed = parse(req.commands);
    if (parsed.errors.length) return { ok: false, errors: parsed.errors };
    if (!parsed.commands.length) return { ok: true, group: null, added: [], touched: [], touchedSets: [], touchedSongs: [], touchedInstruments: [], warnings: ['no commands'] };
    const group = nextGroup(this.entries);
    // A batch of several items (many commands, or a set's members) tells the watchers how far it has got.
    const total = parsed.commands.some((c) => c.op === 'undo' || c.op === 'redo') ? 0 : parsed.commands.reduce((n, c) => n + this.itemsOf(c), 0);
    let progress: BatchProgress | null = null;
    const tell = (phase: 'start' | 'item' | 'end', label = '', state: BatchProgress['state'] = 'running'): void => {
      if (!progress) return;
      if (phase === 'item') progress.done = Math.min(progress.total, progress.done + 1);
      progress.state = state;
      if (phase === 'end' && state === 'done') progress.done = progress.total;
      if (label) progress.label = label;
      this.lastBatch = { ...progress };
      this.emit({ type: 'batchProgress', phase, batch: this.lastBatch });
    };
    if (total >= 2) {
      progress = { id: `b${++this.batchCount}`, by: req.by, total, done: 0, label: '', state: 'running', startedAt: this.stamp() };
      tell('start');
    }
    const outcome = this.runBatch(req, parsed.commands, group, tell, !!progress);
    if (progress) {
      if (outcome.ok) tell('end', '', 'done');
      else tell('end', '', 'failed');
    }
    return outcome;
  }

  private runBatch(req: RunRequest, commands: Parsed[], group: string, tell: (phase: 'item', label?: string) => void, counted: boolean): RunOutcome {
    const parsed = { commands };
    let seq = this.entries.reduce((n, e) => Math.max(n, e.seq), 0);
    const at = this.stamp();
    const added: TapeEntry[] = [];
    const errors: Diag[] = [];
    const warnings: string[] = [];
    let next: Library;

    const history = parsed.commands.filter((c) => c.op === 'undo' || c.op === 'redo');
    if (history.length) {
      const c = history[0]!;
      if (parsed.commands.length > 1) return { ok: false, errors: [{ line: c.line, col: 1, message: `${c.op} runs alone: make it the only command of its batch` }] };
      if (c.op !== 'undo' && c.op !== 'redo') throw new Error('unreachable');
      const target = historyTarget(this.entries, c);
      if ('error' in target) return { ok: false, errors: [{ line: c.line, col: 1, message: target.error }] };
      added.push({ seq: ++seq, by: req.by, at, group, cmd: `${c.op} group=${target.group}` });
      const trial = replay([...this.entries, ...added]);
      if (trial.problems.length) {
        return { ok: false, errors: [{ line: c.line, col: 1, message: `${c.op} ${target.group} would leave a later change without what it works on (${trial.problems[0]!.message}); ${c.op === 'undo' ? 'undo the later changes first' : 'redo the earlier undo first'}` }] };
      }
      // a sound or instrument must not be left playing a sample that this undo takes away
      const gone = new Map<string, string[]>();
      for (const [kind, id, snd] of [...[...trial.library].map(([k, v]) => ['sound', k, v] as const), ...[...trial.library.instruments].map(([k, v]) => ['instrument', k, v] as const)]) {
        for (const n of (kind === 'instrument' ? instrumentSamples(snd as never) : soundSamples(snd as never))) if (!trial.library.samples.has(n) && (this.library.samples.has(n) || this.samples.info(n))) gone.set(n, [...(gone.get(n) ?? []), `${kind} ${id}`]);
      }
      if (gone.size) {
        const list = [...gone].slice(0, 3).map(([n, who]) => `sample '${n}' is still played by ${who.slice(0, 6).join(', ')}${who.length > 6 ? ` and ${who.length - 6} more` : ''}`);
        return { ok: false, errors: [{ line: c.line, col: 1, message: `${c.op} ${target.group} would take away ${gone.size === 1 ? 'a sample' : 'samples'} that ${gone.size === 1 ? 'is' : 'are'} still played: ${list.join('; ')}${gone.size > 3 ? `; and ${gone.size - 3} more` : ''}. Change those first` }] };
      }
      next = trial.library;
    } else {
      next = copyLibrary(this.library);
      next.guide = this.musicGuide().guide;
      for (const c0 of parsed.commands) {
        // a sample's date and author are written into its command, so a replay holds them as words and numbers
        const c: Parsed = isSampleOp(c0.op) ? ({ ...settleSampleAdd(c0, req.by, at), line: c0.line } as Parsed) : c0;
        try {
          if (isSampleOp(c.op)) {
            const sc = c as unknown as SampleCommand;
            const h = sc.op === 'sample-add' || sc.op === 'sample-set' ? sc.fields.hash : undefined;
            if (h && !this.samples.hasObject(h)) throw new Error(`hash ${h} is not in the sample store (samples/objects): import the audio first (soundclaw sample import), then name it`);
          }
          if (c.op === 'normalize') {
            // measured against the batch so far, and put on the tape as the plain commands it found
            const plan = this.measuring(next, () => normalizePlan(this, c.args));
            for (const text of plan.commands.split('\n').filter(Boolean)) {
              applyCommand(next, parse(text).commands[0]!);
              added.push({ seq: ++seq, by: req.by, at, group, cmd: text });
            }
            if (!plan.commands) warnings.push(`line ${c.line}: ${plan.already}: nothing to write`);
            if (plan.info) warnings.push(plan.info);
            warnings.push(...plan.notes);
            continue;
          }
          if (MEASURED_OPS.has(c.op)) {
            // worked out against the batch so far, and put on the tape as the plain commands it found
            const made = expand({ samples: this.samples, cache: this.cache, seq, renderSong: (song, o) => this.bench.render(song, o) }, next, c);
            for (const text of made.commands) {
              const parsedText = parse(text).commands[0]!;
              const fin: Parsed = isSampleOp(parsedText.op) ? ({ ...settleSampleAdd(parsedText, req.by, at), line: c.line } as Parsed) : parsedText;
              applyCommand(next, fin);
              added.push({ seq: ++seq, by: req.by, at, group, cmd: fin.text });
            }
            warnings.push(...made.notes);
            continue;
          }
          const before = c.op === 'set' ? next.get(c.id) : undefined;
          this.checkClassNames(c);
          const loopCmd = c.op === 'loop' && c.loop ? c : undefined;
          const loopBefore = loopCmd ? next.get(loopCmd.id) : undefined;
          // A new sample layer reads its sample with the windowed sinc: the writer adds it, so it is written on the tape. A line without `interp` (a document made before it
          // existed) replays as linear, so every earlier render is unchanged.
          const normal = applyCommand(next, c.op === 'layer-add' && c.kind === 'sample' && !c.values.some(([k]) => k === 'interp') ? { ...c, values: [...c.values, ['interp', 'sinc'] as [string, string]] } : c);
          if (loopCmd && loopBefore && loopBefore.voice === 'layered') {
            const after = next.get(loopCmd.id);
            if (after && after.voice === 'layered') {
              loopBefore.layers.forEach((l, i) => {
                const to = after.layers[i]?.p.dur;
                if (typeof l.p.dur === 'number' && typeof to === 'number' && to !== l.p.dur) warnings.push(`line ${c.line}: ${loopCmd.id} layer ${i + 1} dur ${l.p.dur} -> ${to} s, to cover the loop and its crossfade (a loop renders length + fade seconds)`);
              });
            }
          }
          if (c.op === 'set' && before && serializeSound(before) === serializeSound(next.get(c.id)!)) warnings.push(`line ${c.line}: ${c.id} already had those values; nothing changed`);
          // a command that stands for several (song new from-bible=, template=) goes on the tape as those commands
          for (const line of (normal ?? c.text).split('\n')) added.push({ seq: ++seq, by: req.by, at, group, cmd: line });
          // Loudness matching measures a render; the result goes on the tape as plain `sound set … gain=` commands, so a replay never measures.
          const match = this.matchAfter(next, c, counted && (c.op === 'set-new' || c.op === 'set-regen') ? (id) => tell('item', `${c.text.split(' ').slice(0, 3).join(' ')}: ${id}`) : undefined);
          for (const text of match.commands) {
            applyCommand(next, parse(text).commands[0]!);
            added.push({ seq: ++seq, by: req.by, at, group, cmd: text });
          }
          warnings.push(...match.notes);
          if (counted && c.op !== 'set-new' && c.op !== 'set-regen') tell('item', c.text);
        } catch (e) {
          errors.push({ line: c.line, col: 1, message: (e as Error).message });
        }
      }
      if (errors.length) return { ok: false, errors };
      // A sample layer must name a sample that is in the project.
      for (const [id, snd] of next) {
        if (snd.voice !== 'layered' || snd === this.library.get(id)) continue;
        snd.layers.forEach((l, i) => {
          const name = l.kind === 'sample' ? String(l.p.sample) : '';
          if (l.kind === 'sample' && (!name || !(next.samples.has(name) || this.samples.info(name)))) {
            const at = parsed.commands.filter((c) => 'id' in c && c.id === id).at(-1);
            errors.push({ line: at?.line ?? 1, col: 1, message: `${id} layer ${i + 1} ${name ? `names sample '${name}', which is not in the project` : 'has no sample'} (soundclaw sample import <project> <file> as=<name>${this.samples.names().length ? `; samples: ${this.samples.names().join(', ')}` : ''})` });
          }
        });
      }
      // A layer that plays slice n needs a sample with that many slice points.
      for (const [id, snd] of next) {
        if (snd.voice !== 'layered' || snd === this.library.get(id)) continue;
        snd.layers.forEach((l, i) => {
          const k = l.kind === 'sample' ? (l.p.slice as number) : 0;
          if (!k) return;
          const have = next.samples.get(String(l.p.sample))?.slices?.length ?? 0;
          if (k > have) {
            const at = parsed.commands.filter((c) => 'id' in c && c.id === id).at(-1);
            errors.push({ line: at?.line ?? 1, col: 1, message: `${id} layer ${i + 1} plays slice ${k}, but sample ${String(l.p.sample)} ${have ? `has ${have} slice${have === 1 ? '' : 's'}` : 'has no slice points'} (sample slice ${String(l.p.sample)} at=onsets, or grid=<n>)` });
          }
        });
      }
      // A zone must name a sample that is in the project, with the slice it plays.
      for (const [id, ins] of next.instruments) {
        if (ins === this.library.instruments.get(id)) continue;
        const at = parsed.commands.filter((c) => 'id' in c && c.id === id).at(-1);
        (ins.zones ?? []).forEach((z, k) => {
          const e = next.samples.get(z.sample);
          if (!e && !this.samples.info(z.sample)) {
            errors.push({ line: at?.line ?? 1, col: 1, message: `instrument ${id} zone ${k + 1} names sample '${z.sample}', which is not in the project (soundclaw sample import <project> <file> as=<name>${this.samples.names().length ? `; samples: ${this.samples.names().join(', ')}` : ''})` });
            return;
          }
          const have = (e ?? this.samples.entry(z.sample))?.slices?.length ?? 0;
          if (z.slice > have) errors.push({ line: at?.line ?? 1, col: 1, message: `instrument ${id} zone ${k + 1} plays slice ${z.slice}, but sample ${z.sample} ${have ? `has ${have} slice${have === 1 ? '' : 's'}` : 'has no slice points'} (sample slice ${z.sample} at=onsets, or grid=<n>)` });
        });
      }
      // Slice points that changed under sounds that play a slice past the new count: said, not refused (the slice plays nothing until the points are back).
      for (const [name, e] of next.samples) {
        const was = this.library.samples.get(name);
        if (!was?.slices || (e.slices?.length ?? 0) >= was.slices.length) continue;
        for (const [id, snd] of next) {
          if (snd.voice !== 'layered') continue;
          const past = snd.layers.findIndex((l) => l.kind === 'sample' && l.p.sample === name && (l.p.slice as number) > (e.slices?.length ?? 0));
          if (past >= 0) warnings.push(`${id} layer ${past + 1} plays slice ${(snd.layers[past]!.p.slice as number)} of ${name}, which now has ${e.slices?.length ?? 0}: it plays nothing until the slice points are back`);
        }
      }
      if (errors.length) return { ok: false, errors };
      // A song a batch changed must be able to play: its instruments exist and its patterns fit its channels.
      for (const [id, song] of next.songs) {
        if (song === this.library.songs.get(id)) continue;
        const at = parsed.commands.filter((c) => ('id' in c && c.id === id) || ('song' in c && c.song === id)).at(-1);
        const probs = songProblems(song, (i) => !!lookupInstrument(next, i));
        for (const m of probs.errors) errors.push({ line: at?.line ?? 1, col: 1, message: `song ${id}: ${m}` });
        for (const m of probs.warnings) warnings.push(`song ${id}: ${m}`);
      }
      if (errors.length) return { ok: false, errors };
    }

    // The batch fits: write it. Tape first (the source of truth), then the readable documents.
    const before = this.library;
    appendTape(this.project, added);
    this.entries = [...this.entries, ...added];
    this.library = next;
    writeSounds(this.project, next, before);
    writeSets(this.project, next, before);
    writeInstruments(this.project, next, before);
    writeSongs(this.project, next, before);
    writeSamples(this.project, next, before);
    const text = (lib: Library, id: string) => (lib.has(id) ? serializeSound(lib.get(id)!) : null);
    const touched = [...new Set([...before.keys(), ...next.keys()])].filter((id) => text(before, id) !== text(next, id)).sort();
    const setText = (lib: Library, id: string) => (lib.sets.has(id) ? serializeSet(lib.sets.get(id)!) : null);
    const touchedSets = [...new Set([...before.sets.keys(), ...next.sets.keys()])].filter((id) => setText(before, id) !== setText(next, id)).sort();
    const songText2 = (lib: Library, id: string) => (lib.songs.has(id) ? songText(lib.songs.get(id)!) : null);
    const touchedSongs = [...new Set([...before.songs.keys(), ...next.songs.keys()])].filter((id) => songText2(before, id) !== songText2(next, id)).sort();
    const instText = (lib: Library, id: string) => (lib.instruments.has(id) ? JSON.stringify(lib.instruments.get(id)) : null);
    const touchedInstruments = [...new Set([...before.instruments.keys(), ...next.instruments.keys()])].filter((id) => instText(before, id) !== instText(next, id)).sort();
    if (this.listeners.size) {
      const lean = next.size > LEAN_AT;
      this.emit({ type: 'batch', by: req.by, group, entries: added, index: this.index(), sounds: lean ? touched.filter((id) => next.has(id)).map((id) => next.get(id)!) : this.sounds(), removed: touched.filter((id) => !next.has(id)), lean, history: this.historyState(), sets: this.sets(), songs: this.songs().map(songToJson), instruments: this.instruments() });
    }
    this.hub.marks(req.by, added, at);
    if (this.listeners.size && [...new Set([...before.samples.keys(), ...next.samples.keys()])].some((n) => JSON.stringify(before.samples.get(n)) !== JSON.stringify(next.samples.get(n)))) this.samplesChanged();
    return { ok: true, group, added, touched, touchedSets, touchedSongs, touchedInstruments, warnings };
  }
}
