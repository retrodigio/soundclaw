// The page's state: the project's sounds as the server streams them, the history tape, requests
// and who is listening, this person's author name, and playback. The page renders sounds with
// core, the same code the agent's renders use, so what plays here is what the agent rendered.
// React reads it via useSyncExternalStore.

import { restoreCommands, arrange, layerOrder, builtinInstruments, renderNote, type LimiterMemo, type PartStore, instrumentKey, mixParts, renderSong, sha256Text, songFromJson, songText, stepTime, type Instance, type Instrument, type SongDoc, type SongRender, DEFAULT_STYLE, HUMAN_RE, analyze, peaks, cloneSound, measuredChannels, fullScaleOf, joinChannels, melSpectrogram, mixdown, readSampleWav, renderChannels, renderExact, renderKey, runChecks, samplesHash, soundExport, soundStyle, classTable, loudnessFor, type LoudnessRule, type Analysis, type CheckResult, type Diag, type MelSpec, type SampleBank, type SampleData, type SetDoc, type SetMeasure, type Sound, type Style, type TapeEntry, type WorkRequest } from '@soundclaw/core';
import type { CardInfo, ClientMessage, PersonRequest, Presence, SampleInfo, ServerMessage, Snapshot, SoundSummary } from '@soundclaw/server/protocol';
import { Renderer, samplesNamed } from './renderer.ts';
import type { CellReply, DiffReply, LensReply } from './render.worker.ts';
import { gridVersions, provenanceMemo, type Provenance, type Version } from './sound/provenance.ts';
import { loadNew, saveNew } from './studio/prefs.ts';
import { sameUpToLevel } from './sets/abmath.ts';
import { MeterHub } from './song/meters.ts';

export interface Measured {
  analysis: Analysis;
  checks: CheckResult[];
  spec: MelSpec;
  /** A long sound is measured in the worker: until the numbers arrive this is a placeholder. */
  pending?: boolean;
}

const PENDING: Measured = { pending: true, analysis: undefined as unknown as Analysis, checks: [], spec: undefined as unknown as MelSpec };

/** Sounds longer than this (samples) are measured in the worker: measuring takes seconds there and would freeze the page. */
const BIG = 44100 * 3;

export type Status = 'connecting' | 'open' | 'closed';
export type Answer = { ok: boolean; error?: string; request?: WorkRequest };
export type RunResult = { ok: true; group: string | null; seq: number | null } | { ok: false; errors: Diag[] };

/** A playback the page started: kept so tests (and curious people) can see what was played. */
export interface Played {
  id: string;
  /** Which side of an A/B comparison was played (absent: the sound itself). */
  slot?: 'A' | 'B';
  /** Played as a loop (repeating until stopped). */
  loop?: boolean;
  /** Only this part of the sound (seconds from, to) was played. */
  region?: [number, number];
  /** Hash of the samples played; the CLI and MCP print its first 12 digits. */
  hash: string;
  samples: number;
  key: string;
  /** A version from the tape (a clip-grid cell): the tape number it stood at. */
  seq?: number;
  /** The level-matching gain it played at (dB), in a blind A/B. */
  gain?: number;
  /** Tab switched to this side while the pair was playing. */
  switched?: boolean;
}

/** One side of a blind A/B: a version of a sound and the gain that matches its level. */
export interface AbSide { id: string; seq: number; doc: Sound; gain: number }
/** The answers a person gave on this page since it loaded. */
export type Tally = Record<'a' | 'b' | 'both' | 'neither', number>;

/** What a sound's A side is: a snapshot of its parameters, or another sound (followed as it changes). */
export type Pin = { kind: 'snapshot'; sound: Sound; label: string } | { kind: 'sound'; id: string };

/** The sound the page's route names (#/sound/<id>, or its analysis view), or null. */
export function routeSound(hash: string): string | null {
  return /^#\/sound\/([A-Za-z][A-Za-z0-9_-]*)(?:\/analysis)?$/.exec(hash)?.[1] ?? null;
}

/** Where the address points. Old links keep working: #/, #/sound/<id>, #/set/<id>, #/song/<id>, #/audition[/<set>]; and the session, a review, a sound's analysis, a song's mixer and the hidden #/kit. */
export type Route =
  | { kind: 'cards' }
  | { kind: 'sound'; id: string; view?: 'analysis' }
  | { kind: 'set'; id: string }
  | { kind: 'song'; id: string; view?: 'mixer' }
  | { kind: 'audition'; set: string | null }
  | { kind: 'session' }
  | { kind: 'review'; id: string }
  | { kind: 'kit' };

const ID = '([A-Za-z][A-Za-z0-9_-]*)';
export function parseRoute(hash: string): Route {
  let m = new RegExp(`^#/sound/${ID}(?:/(analysis))?$`).exec(hash);
  if (m) return { kind: 'sound', id: m[1]!, ...(m[2] ? { view: 'analysis' as const } : {}) };
  m = new RegExp(`^#/set/${ID}$`).exec(hash);
  if (m) return { kind: 'set', id: m[1]! };
  m = new RegExp(`^#/song/${ID}(?:/(mixer))?$`).exec(hash);
  if (m) return { kind: 'song', id: m[1]!, ...(m[2] ? { view: 'mixer' as const } : {}) };
  m = new RegExp(`^#/audition(?:/${ID})?$`).exec(hash);
  if (m) return { kind: 'audition', set: m[1] ?? null };
  m = new RegExp(`^#/review/${ID}$`).exec(hash);
  if (m) return { kind: 'review', id: m[1]! };
  if (hash === '#/session') return { kind: 'session' };
  if (hash === '#/kit') return { kind: 'kit' };
  return { kind: 'cards' };
}

/** The author name this page writes as: ?name=…, else the last one used here, else human:owner. */
function initialAuthor(): string {
  const q = new URLSearchParams(location.search).get('name');
  const stored = (() => {
    try {
      return localStorage.getItem('soundclaw.author');
    } catch {
      return null;
    }
  })();
  for (const c of [q && (q.startsWith('human:') ? q : `human:${q}`), stored]) if (c && HUMAN_RE.test(c)) return c;
  return 'human:owner';
}

export class Store {
  status: Status = 'connecting';
  project: Snapshot['project'] | null = null;
  /** The list: every sound's id, voice, status and the numbers the server last knew (from the snapshot, before any document). */
  index: SoundSummary[] = [];
  /** The sound documents the page holds: all of them in a small project, those it has asked for (or that changed) in a lean one. */
  private docs = new Map<string, Sound>();
  /** The held documents, in list order (what `sounds.find` is for). */
  sounds: Sound[] = [];
  lean = false;
  /** Entries on the server's tape, of which `tape` holds the newest. */
  tapeTotal = 0;
  private historyFlags = { canUndo: false, canRedo: false };
  sets: SetDoc[] = [];
  /** The songs, and the project's instruments (the built-in ones come from core). */
  songs: SongDoc[] = [];
  instruments: Instrument[] = [];
  style: Style = DEFAULT_STYLE;
  tape: TapeEntry[] = [];
  requests: WorkRequest[] = [];
  presence: Presence | null = null;
  me: string = initialAuthor();
  /** Sounds the agent changed that this browser has not played or opened since (the library's "new" dot), kept per browser. */
  agentNew = new Set<string>();
  /** When (ms) the agent last changed each sound: a row pulses once for 900 ms after. */
  pulses = new Map<string, number>();
  error: string | null = null;
  /** The sound playing now (its id; `<id>#A` for the A side of a comparison). */
  playing: string | null = null;
  /** The sound whose editor is open, from the address (#/sound/<id>). */
  editing: string | null = routeSound(location.hash);
  /** The page the address names. */
  route: Route = parseRoute(location.hash);
  /** A play-through of several sounds (the set page, the audition page): which one is sounding. */
  sequence: { ids: string[]; index: number } | null = null;
  private seqToken = 0;
  private playToken = 0;
  /** The key of the sound being rendered in the worker for playback (it is not sounding yet). */
  rendering: string | null = null;
  private readonly renderer = new Renderer();
  private idleWaiters: (() => void)[] = [];
  /** Replay a sound each time it changes in the editor. */
  playOnChange = true;
  /** The A side of each sound's A/B comparison. */
  pins = new Map<string, Pin>();
  played: Played[] = [];
  /** Bumped on every change; React's snapshot. */
  version = 0;
  token = "";
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private nextId = 0;
  private waiting = new Map<number, (r: RunResult) => void>();
  private answers = new Map<number, (r: Answer) => void>();
  /** The project's samples as the server lists them (name and the SHA-256 of the bytes). */
  samples: SampleInfo[] = [];
  private sampleData = new Map<string, { sha: string; data: SampleData }>();
  private fetching = new Map<string, Promise<void>>();
  private renders = new Map<string, Float32Array[]>();
  private measures = new Map<string, Measured>();
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = (): number => this.version;
  /** The list's numbers moved on (the server worked out cards): the library redraws on this even while an editor is open. */
  cardsVersion = 0;
  private cardListeners = new Set<() => void>();
  subscribeCards2 = (fn: () => void): (() => void) => { this.cardListeners.add(fn); return () => this.cardListeners.delete(fn); };
  getCardsVersion = (): number => this.cardsVersion;
  changed(): void {
    this.version++;
    for (const fn of [...this.listeners]) fn();
  }

  connect(token: string): void {
    this.token = token;
    window.addEventListener('hashchange', () => { this.editing = routeSound(location.hash); this.route = parseRoute(location.hash); this.changed(); });
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => { this.status = 'open'; this.changed(); };
    ws.onclose = () => {
      this.status = 'closed';
      this.changed();
      // The server may have restarted: try again.
      setTimeout(() => { if (this.ws === ws) this.connect(this.token); }, 1500);
    };
    ws.onmessage = (ev) => this.receive(JSON.parse(String(ev.data)) as ServerMessage);
  }

  private send(m: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private receive(m: ServerMessage): void {
    switch (m.type) {
      case 'hello':
        this.project = m.snapshot.project;
        this.agentNew = loadNew(m.snapshot.project.name);
        this.lean = m.snapshot.lean;
        this.cardStats.helloAt ??= Math.round(performance.now());
        this.docs = new Map(m.snapshot.sounds.map((x) => [x.id, x]));
        this.setIndex(m.snapshot.index);
        this.tapeTotal = m.snapshot.tapeTotal;
        this.historyFlags = m.snapshot.history;
        this.sets = m.snapshot.sets ?? [];
        this.songs = (m.snapshot.songs ?? []).map(songFromJson);
        this.instruments = m.snapshot.instruments ?? [];
        this.samples = m.snapshot.samples ?? [];
        this.style = m.snapshot.style ?? DEFAULT_STYLE;
        this.tape = m.snapshot.tape;
        this.requests = m.snapshot.requests;
        this.presence = m.snapshot.presence;
        break;
      case 'batch': {
        this.lean = m.lean;
        if (m.lean) {
          for (const x of m.sounds) this.docs.set(x.id, x);
          for (const id of m.removed) this.docs.delete(id);
        } else this.docs = new Map(m.sounds.map((x) => [x.id, x]));
        const prevKeys = new Map(this.index.map((x) => [x.id, x.key]));
        this.setIndex(m.index);
        if (!m.by.startsWith('human:')) this.noteAgentChange(m.index.filter((x) => prevKeys.get(x.id) !== x.key).map((x) => x.id));
        this.historyFlags = m.history;
        this.tapeTotal += m.entries.length;
        this.sets = m.sets ?? this.sets;
        const playingSong = this.songPlay ? this.songs.find((x) => x.id === this.songPlay!.id) : undefined;
        const before = playingSong ? this.songKey(playingSong) : null;
        if (m.songs) this.songs = m.songs.map(songFromJson);
        if (m.instruments) this.instruments = m.instruments;
        this.tape = [...this.tape, ...m.entries];
        // a song playing that the batch changed plays on from where it is, rendered again (only the parts that changed)
        if (this.songPlay && before !== null && this.playOnChange) {
          const now = this.songs.find((x) => x.id === this.songPlay!.id);
          if (now && this.songKey(now) !== before) { this.editStarted = performance.now(); void this.playSong(now.id, this.songPlay.mode, true, this.songPlay.region); }
        }
        break;
      }
      case 'requests':
        this.requests = m.requests;
        break;
      case 'samples':
        this.samples = m.samples;
        break;
      case 'cards': {
        // the server worked out cards: the list's badges and numbers (a card for a key the sound has moved past is of no use)
        const byId = new Map(m.cards.map((c) => [c.id, c]));
        this.index = this.index.map((x) => {
          const c = byId.get(x.id);
          return c && c.key === x.key ? { ...x, info: c.info } : x;
        });
        // an editor shows nothing of the list: leave it alone (the server's quiet work must not make it redraw)
        this.cardsVersion++;
        for (const f of [...this.cardListeners]) f();
        if (this.route.kind === 'sound' || this.route.kind === 'song') return;
        break;
      }
      case 'presence':
        this.presence = m.presence;
        break;
      case 'result': {
        const f = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        this.error = m.ok ? null : m.errors.map((e) => e.message).join('; ');
        f?.(m.ok ? { ok: true, group: m.group, seq: m.seq } : { ok: false, errors: m.errors });
        break;
      }
      case 'answer': {
        const f = this.answers.get(m.id);
        this.answers.delete(m.id);
        this.error = m.ok ? null : m.error ?? 'refused';
        f?.({ ok: m.ok, error: m.error, request: m.request });
        break;
      }
      case 'pong':
        break;
    }
    this.changed();
  }

  /** The agent changed these sounds: they pulse once and carry a "new" dot until played or opened here. */
  private noteAgentChange(ids: string[]): void {
    if (!ids.length) return;
    const now = Date.now();
    for (const id of ids) { this.agentNew.add(id); this.pulses.set(id, now); }
    if (this.project) saveNew(this.project.name, this.agentNew);
  }

  /** The person played or opened a sound: its "new" dot goes. */
  markSeen(id: string): void {
    if (!this.agentNew.delete(id)) return;
    if (this.project) saveNew(this.project.name, this.agentNew);
    this.changed();
  }

  setAuthor(name: string): boolean {
    const full = name.startsWith('human:') ? name : `human:${name}`;
    if (!HUMAN_RE.test(full)) return false;
    this.me = full;
    try {
      localStorage.setItem('soundclaw.author', full);
    } catch {
      // storage may be off
    }
    this.changed();
    return true;
  }

  /** Commands as this person: one undo group. */
  run(commands: string): Promise<RunResult> {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.send({ type: 'run', id, commands, by: this.me });
    });
  }

  request(body: PersonRequest): Promise<Answer> {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.answers.set(id, resolve);
      this.send({ type: 'request', id, by: this.me, body });
    });
  }

  approve(id: string): Promise<RunResult> {
    return this.run(`sound mark ${id} approved`);
  }

  askForChanges(sound: string, note: string): Promise<Answer> {
    return this.request({ action: 'request', kind: 'change', sound, note });
  }

  /** Listening feedback: quick tags and/or a note on a sound, as a request the agent receives through await. */
  feedback(sound: string, tags: string[], note: string, other?: string): Promise<Answer> {
    return this.request({ action: 'request', kind: 'change', sound, note, tags, ...(other ? { other } : {}) });
  }

  /** The A side of a sound's comparison, as a sound document (null: nothing pinned, or the other sound is gone). */
  pinned(id: string): { sound: Sound; label: string } | null {
    const pin = this.pins.get(id);
    if (!pin) return null;
    if (pin.kind === 'snapshot') return { sound: pin.sound, label: pin.label };
    const s = this.sounds.find((x) => x.id === pin.id);
    return s ? { sound: s, label: pin.id } : null;
  }

  pinSnapshot(id: string): void {
    const s = this.sounds.find((x) => x.id === id);
    if (!s) return;
    this.pins.set(id, { kind: 'snapshot', sound: cloneSound(s), label: `${id} as it was at #${this.tape.at(-1)?.seq ?? 0}` });
    this.changed();
  }

  pinOther(id: string, other: string): void {
    this.pins.set(id, { kind: 'sound', id: other });
    this.changed();
  }

  unpin(id: string): void {
    this.pins.delete(id);
    this.changed();
  }

  undo(): Promise<RunResult> {
    return this.run('undo');
  }

  redo(): Promise<RunResult> {
    return this.run('redo');
  }

  /** Whether an undo or a redo would do anything (the page's buttons). */
  canUndo(): boolean {
    return this.historyFlags.canUndo;
  }

  canRedo(): boolean {
    return this.historyFlags.canRedo;
  }

  /** The tape's earlier entries (the page holds the newest ones of a long tape). */
  async loadEarlier(): Promise<void> {
    const first = this.tape[0]?.seq;
    if (first === undefined || this.tape.length >= this.tapeTotal) return;
    const r = await fetch(`/api/tape?before=${first}&limit=500&token=${encodeURIComponent(this.token)}`);
    if (!r.ok) return;
    const body = (await r.json()) as { entries: TapeEntry[] };
    if (body.entries.length) this.tape = [...body.entries, ...this.tape];
    this.changed();
  }

  private setIndex(index: SoundSummary[]): void {
    this.index = index;
    this.rebuildSounds();
  }

  private rebuildSounds(): void {
    this.sounds = this.index.flatMap((x) => { const d = this.docs.get(x.id); return d ? [d] : []; });
  }

  /** A sound's document: held, or (in a lean project) asked for; undefined until it is here. */
  doc(id: string): Sound | undefined {
    const d = this.docs.get(id);
    if (!d && this.lean && this.index.some((x) => x.id === id)) void this.fetchDoc(id);
    return d;
  }

  private docFetching = new Set<string>();
  private async fetchDoc(id: string): Promise<void> {
    if (this.docFetching.has(id)) return;
    this.docFetching.add(id);
    try {
      const r = await fetch(`/api/sound/${id}.json?token=${encodeURIComponent(this.token)}`);
      if (r.ok && !this.docs.has(id)) {
        this.docs.set(id, (await r.json()) as Sound);
        this.rebuildSounds();
        this.changed();
      }
    } catch {
      // the connection is gone; the page says so
    } finally {
      this.docFetching.delete(id);
    }
  }

  /** The documents of several sounds (set pages, audition), asked for as needed. */
  docsOf(ids: string[]): Sound[] {
    return ids.flatMap((id) => { const d = this.doc(id); return d ? [d] : []; });
  }

  /** The samples sample layers can use: the page fetches the bytes of a sample when a sound that names it is opened (playing renders in the worker, which fetches its own). */
  readonly sampleBank: SampleBank = {
    get: (name) => {
      const info = this.samples.find((x) => x.name === name);
      const have = this.sampleData.get(name);
      return info && have && have.sha === info.sha256 ? have.data : undefined;
    },
    // the server's list says what a sample is; the render key does not wait for the bytes
    hash: (name) => this.samples.find((x) => x.name === name)?.sha256,
  };

  /** Are the samples these names are here (so a render on this thread is whole)? */
  samplesReadyFor(names: string[]): boolean {
    return names.every((n) => !!this.sampleBank.get(n) || !this.samples.some((x) => x.name === n));
  }

  /** Fetch the samples a sound names (the editor renders on this thread, so it needs the bytes). */
  ensureSamples(s: Sound): Promise<void> {
    return this.ensureSampleNames(samplesNamed(s, this.samples).map((x) => x.name));
  }

  ensureSampleNames(names: string[]): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const info of this.samples) {
      if (!names.includes(info.name)) continue;
      const have = this.sampleData.get(info.name);
      if (have && have.sha === info.sha256) continue;
      const key = `${info.name}:${info.sha256}`;
      let p = this.fetching.get(key);
      if (!p) {
        p = fetch(`/api/samples/${info.name}.wav?token=${encodeURIComponent(this.token)}`)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
          .then((buf) => {
            const w = readSampleWav(new Uint8Array(buf));
            this.sampleData.set(info.name, { sha: info.sha256, data: { rate: w.rate, data: w.data, ...(w.left && w.right ? { left: w.left, right: w.right } : {}) } });
          })
          .catch(() => undefined)
          .finally(() => { this.fetching.delete(key); this.renders.clear(); this.measures.clear(); this.changed(); });
        this.fetching.set(key, p);
      }
      jobs.push(p);
    }
    return Promise.all(jobs).then(() => undefined);
  }

  /** The names of the samples a song's instruments name. */
  samplesOfSong(song: SongDoc): string[] {
    const used = new Set<string>();
    for (const c of song.channels) { if (c.inst) used.add(c.inst); for (const v of Object.values(c.kit ?? {})) used.add(v); }
    const text = [...used].map((id) => JSON.stringify(this.lookupInstrument(id) ?? '')).join('|');
    return this.samples.filter((x) => text.includes(`"${x.name}"`)).map((x) => x.name);
  }

  // ---- songs ---------------------------------------------------------------------------------------------------------

  /** Channels muted or soloed for listening (this page only; nothing is written). */
  readonly songMutes = new Map<string, { mute: Set<string>; solo: Set<string> }>();
  private songRenders = new Map<string, SongRender>();
  /** The song playing now: where its buffer began on the audio clock, and what part of the song it plays. */
  songPlay: { id: string; mode: 'full' | 'loop'; started: number; offset: number; window: { start: number; end: number }; length: number; region: { start: number; end: number } | null } | null = null;
  /** The song being rendered for playback (a render takes a second or two here). */
  songBusy: string | null = null;
  /** Songs played, as tests read them: the mode and the hash of the samples handed to the speakers. */
  readonly songsPlayed: { id: string; mode: 'full' | 'loop'; hash: string; muted: string[]; from?: number; region?: { start: number; end: number } }[] = [];

  lookupInstrument = (id: string): Instrument | undefined => this.instruments.find((i) => i.id === id) ?? builtinInstruments()[id];

  songKey(song: SongDoc): string {
    const used = new Set<string>();
    for (const c of song.channels) { if (c.inst) used.add(c.inst); for (const v of Object.values(c.kit ?? {})) used.add(v); }
    if (song.channels.some((c) => c.kit)) for (const d of ['kick', 'snare', 'hat', 'hat_open']) used.add(d);
    const insts = [...used].sort().map((id) => { const i = this.lookupInstrument(id); return i ? `${id}:${instrumentKey(i, (n) => this.sampleBank.hash(n) ?? 'missing')}` : id; });
    return sha256Text(`${songText(song)}|${insts.join(',')}`);
  }

  /** Channel parts kept between renders (a part's key is its notes, instruments, gain and pan): after an edit only the changed channel renders again. */
  private parts = new Map<string, Float32Array>();
  private partBytes = 0;
  readonly partStore: PartStore = {
    get: (k) => { const v = this.parts.get(k); if (v) { this.parts.delete(k); this.parts.set(k, v); } return v ?? null; },
    put: (k, v) => {
      this.parts.set(k, v);
      this.partBytes += v.byteLength;
      // keep about 400 MB of parts, the least recently used going first
      for (const [old, buf] of this.parts) { if (this.partBytes <= 400e6) break; this.parts.delete(old); this.partBytes -= buf.byteLength; }
    },
  };
  /** Rendered notes kept between renders: a changed channel re-sums the notes it had and renders only its new ones. */
  private noteCache = new Map<string, Float32Array[]>();
  /** What the master limiter worked out on the last render of each song and mode. */
  private limiterMemos = new Map<string, { value: LimiterMemo | null }[]>();
  /** The last song render: how long it took and how many channels came from the cache (the page shows it; tests read it). */
  lastRender: { id: string; mode: 'full' | 'loop'; ms: number; cached: number; channels: number } | null = null;
  /** When the last edit to a playing song arrived (performance.now()), and how long until it was playing again. */
  editStarted: number | null = null;
  lastEditToSound: number | null = null;

  /** A song rendered here with core: the same samples the CLI renders. */
  songRender(song: SongDoc, mode: 'full' | 'loop'): SongRender {
    const key = `${this.songKey(song)}|${mode}`;
    let r = this.songRenders.get(key);
    if (!r) {
      const mk = `${song.id}|${mode}`;
      let limiter = this.limiterMemos.get(mk);
      if (!limiter) { limiter = [{ value: null }, { value: null }]; this.limiterMemos.set(mk, limiter); if (this.limiterMemos.size > 4) this.limiterMemos.delete(this.limiterMemos.keys().next().value!); }
      if (this.noteCache.size > 6000) this.noteCache.clear();
      const t0 = performance.now();
      r = renderSong(song, { instruments: this.lookupInstrument, bank: this.sampleBank, mode, store: this.partStore, notes: this.noteCache, limiter });
      this.lastRender = { id: song.id, mode, ms: Math.round(performance.now() - t0), cached: r.cached, channels: r.parts.length };
      this.songRenders.set(key, r);
      if (this.songRenders.size > 6) this.songRenders.delete(this.songRenders.keys()[Symbol.iterator]().next().value!);
    }
    return r;
  }

  songGroups(id: string): { mute: Set<string>; solo: Set<string> } {
    let g = this.songMutes.get(id);
    if (!g) { g = { mute: new Set(), solo: new Set() }; this.songMutes.set(id, g); }
    return g;
  }

  /** Which layers of a layered song play on this page: the base up to the layer at this place (null: all of them). Nothing is written. */
  readonly songIntensity = new Map<string, number | null>();
  /** The song meters: computed in a worker while a song plays, read by the mixer every animation frame. */
  readonly meters = new MeterHub();

  setSongIntensity(id: string, level: number | null): void {
    this.songIntensity.set(id, level);
    this.changed();
    if (this.songPlay?.id === id) void this.playSong(id, this.songPlay.mode, true, this.songPlay.region);
  }

  /** The channels that sound, given the intensity, mute and solo: a solo silences every channel not soloed. */
  songAudible(song: SongDoc): string[] {
    const g = this.songGroups(song.id);
    const level = this.songIntensity.get(song.id) ?? null;
    const layers = level === null ? null : layerOrder(song).slice(0, level + 1);
    return song.channels.filter((c) => !layers || layers.includes(c.layer)).map((c) => c.name).filter((n) => (g.solo.size ? g.solo.has(n) : !g.mute.has(n)));
  }

  /** Solo these channels and play the stretch repeating (a masking link in the mixer); the same again clears the solo and stops. */
  soloAndLoop(id: string, channels: string[], region: { start: number; end: number }): void {
    const g = this.songGroups(id);
    const same = g.solo.size === channels.length && channels.every((c) => g.solo.has(c)) && this.songPlay?.id === id;
    g.solo.clear();
    g.mute.clear();
    if (same) { this.stop(); this.changed(); return; }
    for (const c of channels) g.solo.add(c);
    this.changed();
    void this.playSong(id, 'full', true, region);
  }

  toggleSongChannel(id: string, channel: string, kind: 'mute' | 'solo'): void {
    const g = this.songGroups(id);
    const set = kind === 'mute' ? g.mute : g.solo;
    if (set.has(channel)) set.delete(channel);
    else set.add(channel);
    this.changed();
    const song = this.songs.find((x) => x.id === id);
    if (song && this.songPlay?.id === id) void this.playSong(id, this.songPlay.mode, true, this.songPlay.region);
  }

  /**
   * Play a song (the whole of it once, or its loop region repeating) with the channels as muted and soloed on this page. Playing it
   * again stops it. `region` (song seconds, full mode) plays that stretch repeating (a selection); `from` starts there (the cursor).
   */
  async playSong(id: string, mode: 'full' | 'loop', restart = false, region: { start: number; end: number } | null = null, from: number | null = null): Promise<void> {
    const song = this.songs.find((x) => x.id === id);
    if (!song) return;
    if (!restart && this.songPlay?.id === id && this.songPlay.mode === mode && from === null && JSON.stringify(region) === JSON.stringify(this.songPlay.region)) { this.stop(); return; }
    const where = from ?? (restart && this.songPlay ? this.songClock(id) : null);
    this.stop();
    this.songBusy = id;
    this.changed();
    await new Promise((r) => setTimeout(r, 30));
    try {
      await this.ensureSampleNames(this.samplesOfSong(song));
      const r = this.songRender(song, mode);
      const audible = this.songAudible(song);
      const all = audible.length === song.channels.length;
      const mix = all ? r.mix : mixParts(song, r.parts.filter((p) => audible.includes(p.name)), r.length, mode === 'loop').mix;
      // the hash of what was played is worked out when asked for (hashing a long song takes a while)
      let hash: string | null = null;
      this.songsPlayed.push({ id, mode, get hash() { return (hash ??= samplesHash(joinChannels([mix[0], mix[1]]))); }, muted: song.channels.map((c) => c.name).filter((n) => !audible.includes(n)), ...(from !== null ? { from } : {}), ...(region ? { region } : {}) });
      this.ctx ??= new AudioContext({ sampleRate: 44100 });
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      const buf = this.ctx.createBuffer(2, r.length, 44100);
      buf.copyToChannel(mix[0] as Float32Array<ArrayBuffer>, 0);
      buf.copyToChannel(mix[1] as Float32Array<ArrayBuffer>, 1);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = mode === 'loop' || region !== null;
      if (region && mode === 'full') { src.loopStart = region.start - r.window.start; src.loopEnd = region.end - r.window.start; }
      src.connect(this.out());
      let offset = where !== null ? Math.max(0, Math.min(r.length / 44100 - 0.01, where - r.window.start)) : 0;
      if (region && (offset < region.start - r.window.start || offset >= region.end - r.window.start)) offset = region.start - r.window.start;
      src.onended = () => {
        if (this.source === src) { this.source = null; this.songPlay = null; this.playing = null; this.meters.end(); this.changed(); this.wake(); }
      };
      this.source = src;
      this.playing = `${id}#song-${mode}`;
      this.songPlay = { id, mode, started: this.ctx.currentTime - offset, offset, window: r.window, length: r.length / 44100, region: mode === 'full' ? region : null };
      this.songBusy = null;
      src.start(0, offset);
      if (this.editStarted !== null) { this.lastEditToSound = Math.round(performance.now() - this.editStarted); this.editStarted = null; }
      const playedRegion = mode === 'full' && region ? { a: region.start - r.window.start, len: region.end - region.start } : null;
      this.meters.begin({ song, render: r, mix: [mix[0], mix[1]], mixKey: all ? 'all' : audible.join(','), wrap: mode === 'loop', audible }, { perf: performance.now(), pos: offset, length: r.length / 44100, mode, region: playedRegion });
      this.changed();
    } catch (e) {
      this.songBusy = null;
      this.songPlay = null;
      this.playing = null;
      this.error = `could not play: ${(e as Error).message}`;
      this.changed();
    }
  }

  private master: { input: GainNode; analysers: AnalyserNode[]; bufs: Float32Array<ArrayBuffer>[] } | null = null;

  /** Where every source plays to: the master gain, which feeds the speakers and the two analysers behind the master meter. */
  out(): AudioNode {
    const ctx = this.ctx!;
    if (!this.master) {
      const input = ctx.createGain();
      const split = ctx.createChannelSplitter(2);
      const analysers = [ctx.createAnalyser(), ctx.createAnalyser()];
      for (const a of analysers) a.fftSize = 1024;
      input.connect(ctx.destination);
      input.connect(split);
      analysers.forEach((a, i) => split.connect(a, i));
      this.master = { input, analysers, bufs: analysers.map(() => new Float32Array(new ArrayBuffer(4 * 1024))) };
    }
    return this.master.input;
  }

  /** The master meter's peaks (dBFS, left and right) right now, or null when nothing has played yet. Read every animation frame; it never touches React state. */
  readLevels(): number[] | null {
    const m = this.master;
    if (!m) return null;
    return m.analysers.map((a, i) => {
      a.getFloatTimeDomainData(m.bufs[i]!);
      let p = 0;
      for (const v of m.bufs[i]!) { const x = Math.abs(v); if (x > p) p = x; }
      return p > 0 ? 20 * Math.log10(p) : -120;
    });
  }

  /** Where the playing song is, in seconds of the song's own timeline (a loop repeats within its region), or null when it is not playing. */
  songClock(id: string): number | null {
    const p = this.songPlay;
    if (!p || p.id !== id || !this.ctx) return null;
    const t = this.ctx.currentTime - p.started;
    if (p.region) {
      // a selection repeating: the buffer plays from the offset into the region, then round the region
      const a = p.region.start - p.window.start, len = p.region.end - p.region.start;
      return p.window.start + (t < a + len ? t : a + ((t - a) % len));
    }
    const inside = p.mode === 'loop' ? t % p.length : Math.min(t, p.length);
    return p.window.start + inside;
  }

  /** The pattern and step sounding at a song time, or null in a gap (the tail after the end). */
  songStepAt(song: SongDoc, t: number): { instance: number; pattern: string; section: string; step: number } | null {
    let arr;
    try { arr = arrange(song); } catch { return null; }
    const inst: Instance | undefined = arr.instances.find((i) => t >= i.t0 - 1e-9 && t < i.t0 + i.dur - 1e-9);
    if (!inst) return null;
    let step = 0;
    for (let s = 0; s < inst.pattern.steps; s++) if (stepTime(inst, s, song.swing, inst.pattern.steps) <= t + 1e-9) step = s;
    return { instance: inst.index, pattern: inst.pattern.name, section: inst.section, step };
  }

  /** Play one note of an instrument (its root, held half a second): what the instrument panel's play button sounds. */
  async playNote(inst: Instrument, midi = inst.root, gate = 0.5): Promise<void> {
    const key = `${inst.id}#note`;
    if (this.playing === key) { this.stop(); return; }
    this.stop();
    await this.ensureSampleNames(this.samples.filter((x) => JSON.stringify(inst).includes(`"${x.name}"`)).map((x) => x.name));
    const chans = renderNote(inst, { midi, gate }, this.sampleBank);
    this.played.push({ id: inst.id, hash: samplesHash(joinChannels(chans)), samples: chans[0]!.length, key });
    this.playing = key;
    this.changed();
    try {
      this.ctx ??= new AudioContext({ sampleRate: 44100 });
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      const buf = this.ctx.createBuffer(chans.length, chans[0]!.length, 44100);
      chans.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.out());
      src.onended = () => { if (this.source === src) { this.source = null; this.playing = null; this.changed(); this.wake(); } };
      this.source = src;
      src.start();
    } catch (e) {
      this.playing = null;
      this.error = `could not play: ${(e as Error).message}`;
      this.changed();
    }
  }

  /** The key a sound's render is kept by: its document and the bytes of the samples it names (as the server's cache keys it). */
  keyOf(s: Sound): string {
    return renderKey(s, (n) => this.sampleBank.hash(n) ?? 'missing');
  }

  /** Are the samples the sound names here yet? (Until then it renders its sample layers as silence, and the render is not kept.) */
  private ready(s: Sound): boolean {
    return s.voice !== 'layered' || s.layers.every((l) => l.kind !== 'sample' || !l.p.sample || !!this.sampleBank.get(String(l.p.sample)));
  }

  /** The sound's channels (one, or two when a layer is panned), rendered by core here in the browser (kept by the document's content key). */
  channels(s: Sound): Float32Array[] {
    const key = this.keyOf(s);
    let r = this.renders.get(key);
    if (!r) {
      r = renderChannels(s, this.sampleBank);
      if (!this.ready(s)) return r;
      this.renders.set(key, r);
      if (this.renders.size > 64) this.renders.delete(this.renders.keys().next().value!);
    }
    return r;
  }

  /** The sound's samples: the channel itself, or the mix of two. */
  render(s: Sound): Float32Array {
    return mixdown(this.channels(s));
  }

  /** The sound's exact samples (doubles; for a classic sound, what the reference synth makes), for tests that compare the browser with Node bit for bit. */
  exact(s: Sound): Float64Array {
    return renderExact(s, this.sampleBank);
  }

  /** The WAV a person downloads: as the CLI exports it (a layered sound through the limiter at the style's true-peak ceiling). */
  wavOf(s: Sound): Uint8Array {
    return soundExport(s, this.render(s), { ceilingDb: this.style.truePeakMax, channels: this.channels(s), bank: this.sampleBank }).wav;
  }

  /** The loudness rule the sound is held to: its class and target, and why. */
  rule(s: Sound): LoudnessRule {
    return loudnessFor(s, this.sets, this.style);
  }

  /** The names of the loudness classes the style has. */
  classNames(): string[] {
    return Object.keys(classTable(this.style));
  }

  /** The sound's numbers, checks and a spectrogram, measured here with core (the same code the CLI uses), kept by the document's content key. */
  measure(s: Sound): Measured {
    // a set's target (or a family's offset) changes what the loudness check is held to, and a loop is checked at its seam
    const style = soundStyle(s, this.sets, this.style);
    const rule = loudnessFor(s, this.sets, this.style);
    const loop = s.voice === 'layered' && !!s.loop;
    const key = `${this.keyOf(s)}|${JSON.stringify(style)}|${rule.basis}|${loop ? 'loop' : ''}`;
    let m = this.measures.get(key);
    if (!m) {
      const ch = this.channels(s);
      if (ch[0]!.length > BIG) {
        // a long sound: the worker measures it; the editor shows what it has and fills in when the numbers come
        if (this.ready(s) && !this.measuring.has(key)) {
          this.measuring.add(key);
          void this.renderer.measure(s, this.samples, this.token, style, rule.basis)
            .then((r) => {
              this.measures.set(key, { analysis: r.analysis, checks: r.checks, spec: r.spec });
              this.hashes.set(this.keyOf(s), r.hash);
              if (this.measures.size > 64) this.measures.delete(this.measures.keys().next().value!);
            })
            .catch(() => undefined)
            .finally(() => { this.measuring.delete(key); this.changed(); });
        }
        return PENDING;
      }
      const x = mixdown(ch);
      const mc = measuredChannels(s, ch); // a classic sound is measured as its exported WAV holds it
      const analysis = analyze(mc);
      const hop = Math.max(256, Math.ceil(x.length / 240));
      m = { analysis, checks: runChecks(mc, analysis, style, { loop, loudnessClass: rule.basis, fullScale: fullScaleOf(s) }), spec: melSpectrogram(x, { bands: 48, hop }) };
      if (this.ready(s)) {
        this.measures.set(key, m);
        if (this.measures.size > 64) this.measures.delete(this.measures.keys().next().value!);
      }
    }
    return m;
  }

  private measuring = new Set<string>();

  /** Each layer of a layered sound on its own, as peaks, rendered in the worker. */
  layerStrips(s: Sound, cols = 360): ReturnType<Renderer['strips']> {
    return this.renderer.strips(s, this.samples, this.token, cols);
  }

  private lenses = new Map<string, LensReply>();
  private lensing = new Set<string>();
  /** What the analysis lenses draw for a sound, from the measuring worker (null until it arrives). The key is the sound's content and the rule it is held to. */
  lens(s: Sound): LensReply | null {
    const style = soundStyle(s, this.sets, this.style);
    const rule = loudnessFor(s, this.sets, this.style);
    const loop = s.voice === 'layered' && !!s.loop;
    const key = `${this.keyOf(s)}|${JSON.stringify(style)}|${rule.basis}|${loop ? 'loop' : ''}`;
    const have = this.lenses.get(key);
    if (have) return have;
    if (this.ready(s) && !this.lensing.has(key)) {
      this.lensing.add(key);
      void this.renderer.lens(s, this.samples, this.token, style, rule.basis)
        .then((r) => { this.lenses.set(key, r); this.hashes.set(this.keyOf(s), r.hash); if (this.lenses.size > 12) this.lenses.delete(this.lenses.keys().next().value!); })
        .catch(() => undefined)
        .finally(() => { this.lensing.delete(key); this.changed(); });
    }
    return null;
  }

  private outlines = new Map<string, { min: Float32Array; max: Float32Array; duration: number }>();
  /** The peaks of a short sound as it was (the dashed outline of the sound before an agent's change), rendered here: it is one short sound, and null for a long one. */
  lensOutline(s: Sound): { min: ArrayLike<number>; max: ArrayLike<number>; duration: number } | null {
    const key = this.keyOf(s);
    let o = this.outlines.get(key);
    if (!o) {
      if (!this.ready(s)) return null;
      const ch = this.channels(s);
      if (ch[0]!.length > BIG) return null;
      const pk = peaks(this.render(s), 900);
      o = { min: pk.min, max: pk.max, duration: ch[0]!.length / 44100 };
      this.outlines.set(key, o);
      if (this.outlines.size > 8) this.outlines.delete(this.outlines.keys().next().value!);
    }
    return o;
  }

  private diffs = new Map<string, DiffReply>();
  private diffing = new Set<string>();
  /** The difference spectrogram of a sound against another (null until the worker has it). */
  lensDiff(s: Sound, ref: Sound): DiffReply | null {
    const key = `${this.keyOf(s)}|${this.keyOf(ref)}`;
    const have = this.diffs.get(key);
    if (have) return have;
    if (this.ready(s) && this.ready(ref) && !this.diffing.has(key)) {
      this.diffing.add(key);
      void this.renderer.diff(s, ref, this.samples, this.token)
        .then((r) => { this.diffs.set(key, r); if (this.diffs.size > 12) this.diffs.delete(this.diffs.keys().next().value!); })
        .catch(() => undefined)
        .finally(() => { this.diffing.delete(key); this.changed(); });
    }
    return null;
  }

  /** Who set what on a sound, from the tape (the whole tape is fetched first in a lean project). */
  provenance(id: string): Provenance {
    if (this.lean && this.tape.length < this.tapeTotal && !this.loadingTape) {
      this.loadingTape = true;
      void (async () => { while (this.tape.length < this.tapeTotal) { const n = this.tape.length; await this.loadEarlier(); if (this.tape.length === n) break; } })().finally(() => { this.loadingTape = false; });
    }
    return provenanceMemo(this.tape, id);
  }
  private loadingTape = false;

  // ---- sets and audition: versions from the tape, grid cells, blind A/B ---------------------------------------------

  private versionMemo = new WeakMap<Provenance, ReturnType<typeof gridVersions>>();
  /** A member's versions for the clip grid (the whole tape is fetched first in a lean project). */
  versions(id: string): { versions: Version[]; proposed: Version | null } {
    const p = this.provenance(id);
    let v = this.versionMemo.get(p);
    if (!v) { v = gridVersions(p); this.versionMemo.set(p, v); }
    return v;
  }

  private cells = new Map<string, CellReply>();
  private celling = new Set<string>();
  /** A version's cell (small peaks, loudness, true peak) from the measuring worker; null until it arrives. */
  cell(doc: Sound): CellReply | null {
    const key = this.keyOf(doc);
    const have = this.cells.get(key);
    if (have) return have;
    if (this.ready(doc) && !this.celling.has(key)) {
      this.celling.add(key);
      void this.renderer.cell(doc, this.samples, this.token)
        .then((r) => { this.cells.set(key, r); this.hashes.set(key, r.hash); if (this.cells.size > 200) this.cells.delete(this.cells.keys().next().value!); })
        .catch(() => undefined)
        .finally(() => { this.celling.delete(key); this.changed(); });
    }
    return null;
  }

  /** Make an earlier version of a sound current: one batch of ordinary commands, written as this person (or why it cannot be). */
  async restoreVersion(id: string, want: Sound): Promise<{ ok: boolean; error?: string; commands?: string[] }> {
    const now = await this.docNow(id);
    if (!now) return { ok: false, error: `no sound '${id}'` };
    const r = restoreCommands(now, want, (n) => this.sampleBank.hash(n) ?? 'missing');
    if ('error' in r) return { ok: false, error: r.error };
    if (!r.commands.length) return { ok: true, commands: [] };
    const res = await this.run(r.commands.join('\n'));
    return res.ok ? { ok: true, commands: r.commands } : { ok: false, error: res.errors[0]?.message ?? 'refused' };
  }

  /** Are two versions the same sound once their levels are matched (one render a scaled copy of the other)? */
  async identical(a: Sound, b: Sound): Promise<boolean> {
    if (this.keyOf(a) === this.keyOf(b)) return true;
    const [ra, rb] = await Promise.all([this.renderer.render(a, this.samples, this.token), this.renderer.render(b, this.samples, this.token)]);
    return sameUpToLevel(ra.channels, rb.channels);
  }

  /** A blind A/B answer, as a comparison request the agent receives through await. */
  compare(body: Omit<Extract<PersonRequest, { action: 'compare' }>, 'action'>): Promise<Answer> {
    return this.request({ action: 'compare', ...body });
  }

  /** The answers given on this page since it loaded (the A/B card's session tally). */
  tally: Tally = { a: 0, b: 0, both: 0, neither: 0 };
  countAnswer(a: keyof Tally): void { this.tally = { ...this.tally, [a]: this.tally[a] + 1 }; this.changed(); }

  /** Play a version of a sound (a clip-grid cell); playing it again stops it. */
  async playVersion(id: string, seq: number, doc: Sound): Promise<void> {
    this.markSeen(id);
    await this.playDoc(`${id}@${seq}`, doc, id, undefined, false, false, undefined, { seq });
  }

  /** Play versions one after the other with a gap (ms): a row or a column of the grid. */
  async playVersions(items: { id: string; seq: number; doc: Sound }[], gapMs: number): Promise<void> {
    const token = ++this.seqToken;
    this.stop();
    const keys = items.map((x) => `${x.id}@${x.seq}`);
    for (let i = 0; i < items.length; i++) {
      if (token !== this.seqToken) return;
      this.sequence = { ids: keys, index: i };
      this.changed();
      const x = items[i]!;
      await this.playDoc(keys[i]!, x.doc, x.id, undefined, true, false, undefined, { seq: x.seq });
      await this.idle();
      if (token !== this.seqToken) return;
      if (i < items.length - 1) await new Promise((r) => setTimeout(r, gapMs));
    }
    if (token === this.seqToken) { this.sequence = null; this.changed(); }
  }

  /** The blind A/B playing now: which side is heard. Both sides are scheduled together; Tab switches which one is heard, in time. */
  ab: { side: 'A' | 'B'; a: AbSide; b: AbSide } | null = null;
  private abNodes: { A: GainNode; B: GainNode; sources: AudioBufferSourceNode[]; hashes: { A: string; B: string }; samples: { A: number; B: number } } | null = null;

  /** Play a pair: `side` is heard, `times` starts `interval` seconds apart, each side at its level-matching gain. */
  async playAB(a: AbSide, b: AbSide, side: 'A' | 'B', times: number, interval: number): Promise<void> {
    this.stopSequence();
    const token = ++this.playToken;
    this.playing = `ab#${side}`;
    this.rendering = this.playing;
    this.ab = { side, a, b };
    this.changed();
    try {
      const [ra, rb] = await Promise.all([this.renderer.render(a.doc, this.samples, this.token), this.renderer.render(b.doc, this.samples, this.token)]);
      if (token !== this.playToken) return;
      this.rendering = null;
      this.ctx ??= new AudioContext({ sampleRate: 44100 });
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      if (token !== this.playToken) return;
      const ctx = this.ctx;
      const lin = (db: number): number => 10 ** (db / 20);
      const gains = { A: ctx.createGain(), B: ctx.createGain() };
      gains.A.gain.value = side === 'A' ? lin(a.gain) : 0;
      gains.B.gain.value = side === 'B' ? lin(b.gain) : 0;
      gains.A.connect(this.out());
      gains.B.connect(this.out());
      const t0 = ctx.currentTime + 0.05;
      const sources: AudioBufferSourceNode[] = [];
      let end = 0;
      for (const [r, g] of [[ra, gains.A], [rb, gains.B]] as const) {
        const buf = ctx.createBuffer(r.channels.length, r.channels[0]!.length, 44100);
        r.channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
        for (let k = 0; k < times; k++) {
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(g);
          src.start(t0 + k * interval);
          sources.push(src);
          end = Math.max(end, k * interval + buf.duration);
        }
      }
      this.abNodes = { ...gains, sources, hashes: { A: ra.hash, B: rb.hash }, samples: { A: ra.channels[0]!.length, B: rb.channels[0]!.length } };
      const heard = side === 'A' ? a : b;
      this.played.push({ id: heard.id, slot: side, seq: heard.seq, gain: heard.gain, hash: this.abNodes.hashes[side], samples: this.abNodes.samples[side], key: this.keyOf(heard.doc) });
      this.clock = { at: performance.now() + 50, from: 0, len: end, loop: false };
      const last = sources.at(-1)!;
      last.onended = () => { if (this.abNodes?.sources === sources) { this.abNodes = null; this.ab = null; this.playing = null; this.changed(); this.wake(); } };
    } catch (e) {
      if (token !== this.playToken) return;
      this.rendering = null;
      this.playing = null;
      this.ab = null;
      this.error = `could not play: ${(e as Error).message}`;
      this.changed();
      this.wake();
    }
  }

  /** Tab: hear the other side of the playing pair from this moment on. */
  switchAB(): boolean {
    const n = this.abNodes, ab = this.ab;
    if (!n || !ab || !this.ctx) return false;
    const side = ab.side === 'A' ? 'B' : 'A';
    const t = this.ctx.currentTime;
    const lin = (db: number): number => 10 ** (db / 20);
    n.A.gain.setValueAtTime(side === 'A' ? lin(ab.a.gain) : 0, t);
    n.B.gain.setValueAtTime(side === 'B' ? lin(ab.b.gain) : 0, t);
    this.ab = { ...ab, side };
    this.playing = `ab#${side}`;
    const heard = side === 'A' ? ab.a : ab.b;
    this.played.push({ id: heard.id, slot: side, seq: heard.seq, gain: heard.gain, hash: n.hashes[side], samples: n.samples[side], key: this.keyOf(heard.doc), switched: true });
    this.changed();
    return true;
  }

  private setMeasures = new Map<string, { key: string; m: SetMeasure | null }>();
  private setFetching = new Set<string>();

  /** A set's distance matrix, member loudness and set-spread check, measured on the server (the numbers `check` prints); null until they arrive. */
  setMeasure(set: SetDoc): SetMeasure | null {
    const key = `${set.target}|${JSON.stringify(this.style)}|${set.members.map((id) => this.index.find((x) => x.id === id)?.key ?? '').join(',')}`;
    const have = this.setMeasures.get(set.id);
    if (have?.key === key) return have.m;
    if (!this.setFetching.has(`${set.id}|${key}`) && set.members.length >= 2) {
      this.setFetching.add(`${set.id}|${key}`);
      void fetch(`/api/set/${set.id}.json?token=${encodeURIComponent(this.token)}`)
        .then((r) => (r.ok ? (r.json() as Promise<SetMeasure>) : null))
        .then((m) => { if (m) { this.setMeasures.set(set.id, { key, m }); this.changed(); } })
        .catch(() => undefined)
        .finally(() => this.setFetching.delete(`${set.id}|${key}`));
    }
    return have?.m ?? null;
  }

  // ---- cards: the list's thumbnails and numbers, from the server --------------------------------------------------

  private cardData = new Map<string, CardInfo>();
  private cardWanted = new Map<string, string>();
  private cardActive = new Set<string>();
  private cardFailed = new Map<string, number>();
  private cardSubs = new Map<string, Set<() => void>>();
  /** Cards fetched, and when (ms since the page began) the first arrived: what tests and curious people read. */
  readonly cardStats = { fetched: 0, firstAt: null as number | null, helloAt: null as number | null };

  subscribeCard = (id: string, fn: () => void): (() => void) => {
    let set = this.cardSubs.get(id);
    if (!set) { set = new Set(); this.cardSubs.set(id, set); }
    set.add(fn);
    return () => { set!.delete(fn); };
  };

  /** The card held for a sound (it may be of an earlier version of the sound until the new one arrives). */
  cardOf(id: string): CardInfo | undefined {
    return this.cardData.get(id);
  }

  summary(id: string): SoundSummary | undefined {
    return this.index.find((x) => x.id === id);
  }

  /** A card is in view: fetch its thumbnails if the held ones are not for the sound as it stands. */
  wantCard(id: string): void {
    this.cardRefs.set(id, (this.cardRefs.get(id) ?? 0) + 1);
    const sum = this.summary(id);
    if (!sum || this.cardData.get(id)?.key === sum.key || this.cardActive.has(`${id}|${sum.key}`)) return;
    if (Date.now() - (this.cardFailed.get(id) ?? 0) < 3000) return;
    this.cardWanted.delete(id);
    this.cardWanted.set(id, sum.key);
    this.pumpCards();
  }

  /** The card scrolled out of view before its turn. */
  unwantCard(id: string): void {
    // a library row and a card may both want the same card: it is dropped from the queue only when nobody does
    const n = (this.cardRefs.get(id) ?? 1) - 1;
    if (n > 0) { this.cardRefs.set(id, n); return; }
    this.cardRefs.delete(id);
    this.cardWanted.delete(id);
  }
  private cardRefs = new Map<string, number>();

  private pumpCards(): void {
    // four at a time, the newest request first (what is in view now)
    while (this.cardActive.size < 4 && this.cardWanted.size) {
      const [id, key] = [...this.cardWanted].at(-1)!;
      this.cardWanted.delete(id);
      const tag = `${id}|${key}`;
      this.cardActive.add(tag);
      void fetch(`/api/card/${id}.json?token=${encodeURIComponent(this.token)}`)
        .then((r) => (r.ok ? (r.json() as Promise<CardInfo>) : Promise.reject(new Error(`${r.status}`))))
        .then((c) => {
          this.cardData.set(id, c);
          this.cardStats.fetched++;
          this.cardStats.firstAt ??= Math.round(performance.now());
          for (const fn of [...(this.cardSubs.get(id) ?? [])]) fn();
          // the list had no numbers for this version of the sound yet: it has now
          const sum = this.summary(id);
          if (sum && sum.key === c.key && !sum.info) {
            this.index = this.index.map((x) => (x === sum ? { ...x, info: { hash: c.hash, duration: c.duration, lufs: c.lufs, truePeakDb: c.truePeakDb, pass: c.pass, failing: c.failing, summary: c.summary } } : x));
            this.changed();
          }
        })
        .catch(() => this.cardFailed.set(id, Date.now()))
        .finally(() => {
          this.cardActive.delete(tag);
          this.pumpCards();
          // the sound moved on while the card was coming: ask again for the new one
          const now = this.summary(id);
          if (now && this.cardSubs.get(id)?.size && this.cardData.get(id)?.key !== now.key) this.wantCard(id);
        });
    }
  }

  private hashes = new Map<string, string>();

  /** Hash of the sound's samples as rendered here (kept by the render key: hashing a long render takes a while). */
  hashOf(s: Sound): string {
    const key = this.keyOf(s);
    let h = this.hashes.get(key);
    if (h === undefined) {
      const chs = this.channels(s);
      // a long sound's hash comes with its measurement from the worker
      if (chs[0]!.length > BIG) { this.measure(s); return this.hashes.get(key) ?? ''; }
      h = samplesHash(joinChannels(chs));
      if (this.ready(s)) {
        this.hashes.set(key, h);
        if (this.hashes.size > 64) this.hashes.delete(this.hashes.keys().next().value!);
      }
    }
    return h;
  }

  stop(): void {
    this.playToken++;
    this.rendering = null;
    try {
      this.source?.stop();
    } catch {
      // already stopped
    }
    this.source = null;
    if (this.abNodes) {
      for (const x of this.abNodes.sources) { try { x.stop(); } catch { /* not started */ } }
      this.abNodes.A.disconnect();
      this.abNodes.B.disconnect();
      this.abNodes = null;
    }
    this.ab = null;
    this.clock = null;
    const wasSong = this.songPlay !== null;
    this.songPlay = null;
    if (wasSong) this.meters.end();
    if (this.playing || wasSong) {
      this.playing = null;
      this.changed();
    }
    this.wake();
  }

  /** When the sound now playing began (page clock), where in the sound that was, and whether it repeats: the playhead of the lenses reads it. */
  clock: { at: number; from: number; len: number; loop: boolean } | null = null;

  /** Where the playhead is in the sound now playing (seconds), or null when it is not playing. */
  playPosition(key: string): number | null {
    const c = this.clock;
    if (!c || this.playing !== key) return null;
    const el = (performance.now() - c.at) / 1000;
    return c.from + (c.loop ? el % c.len : Math.min(el, c.len));
  }

  /** Play part of a sound repeating until stopped (the selection of a lens). */
  async playRegion(id: string, from: number, to: number): Promise<void> {
    const s = await this.docNow(id);
    if (s) await this.playDoc(`${id}#loop`, s, id, undefined, true, true, [from, to]);
  }

  /** Play one document, then another (hear the sound before a change, then as it is now); stopped by anything else that plays. */
  async playPair(id: string, first: Sound, second: Sound): Promise<void> {
    const token = ++this.seqToken;
    this.stop();
    await this.playDoc(`${id}#A`, first, id, 'A', true);
    await this.idle();
    if (token !== this.seqToken) return;
    await new Promise((r) => setTimeout(r, 250));
    if (token !== this.seqToken) return;
    await this.playDoc(id, second, id, 'B', true);
  }

  private wake(): void {
    const w = this.idleWaiters;
    this.idleWaiters = [];
    for (const f of w) f();
  }

  /** Resolves when nothing is playing. */
  idle(): Promise<void> {
    return this.playing === null ? Promise.resolve() : new Promise((r) => this.idleWaiters.push(r));
  }

  /** Play sounds one after the other with a gap between them (ms); stopSequence ends it. */
  async playSequence(ids: string[], gapMs: number): Promise<void> {
    const token = ++this.seqToken;
    this.stop();
    for (let i = 0; i < ids.length; i++) {
      if (token !== this.seqToken) return;
      this.sequence = { ids, index: i };
      this.changed();
      await this.play(ids[i]!);
      await this.idle();
      if (token !== this.seqToken) return;
      if (i < ids.length - 1) await new Promise((r) => setTimeout(r, gapMs));
    }
    if (token === this.seqToken) { this.sequence = null; this.changed(); }
  }

  stopSequence(): void {
    this.seqToken++;
    this.sequence = null;
    this.stop();
    this.changed();
  }

  /** A sound's document, waiting for it if the page has not asked for it yet (a lean project). */
  async docNow(id: string): Promise<Sound | undefined> {
    const d = this.docs.get(id);
    if (d || !this.lean) return d;
    await this.fetchDoc(id);
    return this.docs.get(id);
  }

  /** Play a looping sound repeating (its seam is what you listen for) until stopped. */
  async playLoop(id: string): Promise<void> {
    const s = await this.docNow(id);
    if (s) await this.playDoc(`${id}#loop`, s, id, undefined, false, true);
  }

  /** Play a sound: rendered here with core, handed to Web Audio at the renderer's own rate. */
  async play(id: string): Promise<void> {
    const s = await this.docNow(id);
    this.markSeen(id);
    if (s) await this.playDoc(id, s);
  }

  /** Play one side of a comparison: A is the pinned sound, B the sound as it stands. */
  async playSide(id: string, slot: 'A' | 'B'): Promise<void> {
    const doc = slot === 'A' ? this.pinned(id)?.sound : await this.docNow(id);
    if (doc) await this.playDoc(slot === 'A' ? `${id}#A` : id, doc, id, slot);
  }

  /** Play a sound document under a playing key (a toggle: playing it again stops it). It is rendered in the worker, so the page never waits for it. */
  async playDoc(key: string, s: Sound, id = s.id, slot?: 'A' | 'B', restart = false, loop = false, region?: [number, number], extra: { seq?: number } = {}): Promise<void> {
    if (this.playing === key && !restart) { this.stop(); return; }
    this.stop();
    const token = ++this.playToken;
    this.playing = key;
    this.rendering = key;
    this.changed();
    try {
      const r = await this.renderer.render(s, this.samples, this.token);
      if (token !== this.playToken) return;
      this.rendering = null;
      let chans = r.channels;
      if (region) {
        // only a part: the selection of a lens, looped
        const a = Math.max(0, Math.floor(region[0] * 44100)), b = Math.min(chans[0]!.length, Math.ceil(region[1] * 44100));
        if (b - a >= 64) chans = chans.map((c) => c.slice(a, b));
        else region = undefined;
      }
      const samples = chans[0]!;
      this.played.push({ id, ...(slot ? { slot } : {}), ...(loop ? { loop: true } : {}), ...(region ? { region } : {}), ...(extra.seq !== undefined ? { seq: extra.seq } : {}), hash: r.hash, samples: samples.length, key: this.keyOf(s) });
      this.ctx ??= new AudioContext({ sampleRate: 44100 });
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      if (token !== this.playToken) return;
      const buf = this.ctx.createBuffer(chans.length, samples.length, 44100);
      chans.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = loop;
      src.connect(this.out());
      src.onended = () => {
        if (this.source === src) {
          this.source = null;
          this.playing = null;
          this.changed();
          this.wake();
        }
      };
      this.source = src;
      this.clock = { at: performance.now(), from: region?.[0] ?? 0, len: samples.length / 44100, loop };
      src.start();
    } catch (e) {
      if (token !== this.playToken) return;
      this.rendering = null;
      this.playing = null;
      this.error = `could not play: ${(e as Error).message}`;
      this.changed();
      this.wake();
    }
  }
}
