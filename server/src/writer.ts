// The single writer. Every change to a project goes through one Writer, in the order it arrives
// (a queue), so the history tape has one author at a time: a batch is parsed, checked against a
// copy of the sounds, and only if all of it fits is it appended to the tape as one group. A
// running server owns the Writer; the CLI sends its writing commands to that server.

import { AUTHOR_RE, analyze, applyCommand, historyTarget, nextGroup, parse, replay, resolveStyle, runChecks, samplesHash, serializeSound, soundWav, type Diag, type Library, type Sound, type Style, type TapeEntry } from '@soundclaw/core';
import { Hub } from './await.ts';
import { RenderCache, type Rendered } from './cache.ts';
import type { Measured } from './ears.ts';
import { ProjectError, appendTape, readTape, writeSounds, type Project } from './project.ts';
import type { ServerMessage, Snapshot } from './protocol.ts';
import { readRequestRecords, readRequests } from './requests.ts';

export interface RunRequest {
  commands: string;
  /** The author: `agent:<name>` or `human:<name>`. */
  by: string;
}

export type RunOutcome =
  | { ok: true; group: string | null; added: TapeEntry[]; /** Sounds the batch created or changed (or removed, by an undo). */ touched: string[]; warnings: string[] }
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

const utcNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The sound a tape command is about (its first argument), if any. */
function soundOf(cmd: string): string | null {
  return /^sound (?:new|set|mark|patch|generate|mutate) (\S+)/.exec(cmd)?.[1] ?? null;
}

export class Writer {
  project: Project;
  readonly hub = new Hub();
  readonly cache: RenderCache;
  /** What the checks are held to: the project's `style`, else the defaults. */
  readonly style: Style;
  private readonly measured = new Map<string, Measured>();
  private entries: TapeEntry[];
  private library: Library;
  private readonly listeners = new Set<Listener>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => string;

  constructor(project: Project, o: WriterOptions = {}) {
    this.project = project;
    this.now = o.now ?? utcNow;
    this.cache = new RenderCache(project.dir);
    try {
      this.style = resolveStyle(project.json.style);
    } catch (e) {
      throw new ProjectError(`project.json: ${(e as Error).message}`);
    }
    this.entries = readTape(project);
    this.library = this.replayed(this.entries);
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

  /** The tape as it stands (undone groups included). */
  tape(): readonly TapeEntry[] {
    return this.entries;
  }

  /** Render a sound through the content-hash cache. */
  render(id: string): Rendered {
    return this.cache.render(this.sound(id));
  }

  /** The sound's numbers and checks, measured once for each distinct render. */
  measure(id: string): Measured {
    return this.measureSound(this.sound(id), this.render(id));
  }

  /** The numbers and checks of any sound document (a past state, say), kept by the render's key. */
  measureSound(s: Sound, r: Rendered = this.cache.render(s)): Measured {
    let m = this.measured.get(r.key);
    if (!m) {
      const analysis = analyze(r.samples);
      m = { analysis, checks: runChecks(r.samples, analysis, this.style) };
      this.measured.set(r.key, m);
      if (this.measured.size > 128) this.measured.delete(this.measured.keys().next().value!);
    }
    return m;
  }

  /** Hash of the sound's float samples (what the cards and summaries show the first 12 digits of). */
  samplesHashOf(id: string): string {
    return samplesHash(this.render(id).samples);
  }

  /** The sound's WAV file bytes. */
  wavOf(id: string): Uint8Array {
    return soundWav(this.sound(id), this.render(id).samples);
  }

  history(o: HistoryRequest = {}): TapeEntry[] {
    let es = this.entries.filter((e) => (!o.by || e.by === o.by) && (!o.sound || soundOf(e.cmd) === o.sound));
    if (o.limit !== undefined) es = es.slice(-o.limit);
    return es;
  }

  snapshot(): Snapshot {
    return {
      project: { name: this.project.json.name, dir: this.project.dir },
      sounds: this.sounds(),
      style: this.style,
      tape: [...this.entries],
      requests: [...readRequests(this.project).values()],
      presence: this.hub.presence(),
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
    if (!parsed.commands.length) return { ok: true, group: null, added: [], touched: [], warnings: ['no commands'] };
    const group = nextGroup(this.entries);
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
      next = trial.library;
    } else {
      next = new Map(this.library);
      for (const c of parsed.commands) {
        try {
          const before = c.op === 'set' ? next.get(c.id) : undefined;
          const normal = applyCommand(next, c);
          if (c.op === 'set' && before && serializeSound(before) === serializeSound(next.get(c.id)!)) warnings.push(`line ${c.line}: ${c.id} already had those values; nothing changed`);
          added.push({ seq: ++seq, by: req.by, at, group, cmd: normal ?? c.text });
        } catch (e) {
          errors.push({ line: c.line, col: 1, message: (e as Error).message });
        }
      }
      if (errors.length) return { ok: false, errors };
    }

    // The batch fits: write it. Tape first (the source of truth), then the readable documents.
    const before = this.library;
    appendTape(this.project, added);
    this.entries = [...this.entries, ...added];
    this.library = next;
    writeSounds(this.project, next, before);
    const text = (lib: Library, id: string) => (lib.has(id) ? serializeSound(lib.get(id)!) : null);
    const touched = [...new Set([...before.keys(), ...next.keys()])].filter((id) => text(before, id) !== text(next, id)).sort();
    this.emit({ type: 'batch', by: req.by, group, entries: added, sounds: this.sounds() });
    this.hub.marks(req.by, added, at);
    return { ok: true, group, added, touched, warnings };
  }
}
