// The page's state: the project's sounds as the server streams them, the history tape, requests
// and who is listening, this person's author name, and playback. The page renders sounds with
// core, the same code the agent's renders use, so what plays here is what the agent rendered.
// React reads it via useSyncExternalStore.

import { arrange, builtinInstruments, renderNote, type LimiterMemo, type PartStore, instrumentKey, mixParts, renderSong, sha256Text, songFromJson, songText, stepTime, type Instance, type Instrument, type SongDoc, type SongRender, DEFAULT_STYLE, HUMAN_RE, activeGroups, analyze, cloneSound, measuredChannels, fullScaleOf, joinChannels, measureSet, melSpectrogram, mixdown, readSampleWav, renderChannels, renderExact, renderKey, runChecks, samplesHash, soundExport, soundStyle, classTable, loudnessFor, type LoudnessRule, type Analysis, type CheckResult, type Diag, type MelSpec, type SampleBank, type SampleData, type SetDoc, type SetMeasure, type Sound, type Style, type TapeEntry, type WorkRequest } from '@soundclaw/core';
import type { ClientMessage, PersonRequest, Presence, SampleInfo, ServerMessage, Snapshot } from '@soundclaw/server/protocol';

export interface Measured {
  analysis: Analysis;
  checks: CheckResult[];
  spec: MelSpec;
}

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
  /** Hash of the samples played; the CLI and MCP print its first 12 digits. */
  hash: string;
  samples: number;
  key: string;
}

/** What a sound's A side is: a snapshot of its parameters, or another sound (followed as it changes). */
export type Pin = { kind: 'snapshot'; sound: Sound; label: string } | { kind: 'sound'; id: string };

/** The sound the page's route names (#/sound/<id>), or null for the list of cards. */
export function routeSound(hash: string): string | null {
  return /^#\/sound\/([A-Za-z][A-Za-z0-9_-]*)$/.exec(hash)?.[1] ?? null;
}

/** Where the address points: the cards, a sound's editor, a set's page, or the audition page (all sounds, or one set's). */
export type Route = { kind: 'cards' } | { kind: 'sound'; id: string } | { kind: 'set'; id: string } | { kind: 'song'; id: string } | { kind: 'audition'; set: string | null };

export function parseRoute(hash: string): Route {
  let m = /^#\/sound\/([A-Za-z][A-Za-z0-9_-]*)$/.exec(hash);
  if (m) return { kind: 'sound', id: m[1]! };
  m = /^#\/set\/([A-Za-z][A-Za-z0-9_-]*)$/.exec(hash);
  if (m) return { kind: 'set', id: m[1]! };
  m = /^#\/song\/([A-Za-z][A-Za-z0-9_-]*)$/.exec(hash);
  if (m) return { kind: 'song', id: m[1]! };
  m = /^#\/audition(?:\/([A-Za-z][A-Za-z0-9_-]*))?$/.exec(hash);
  if (m) return { kind: 'audition', set: m[1] ?? null };
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
  sounds: Sound[] = [];
  sets: SetDoc[] = [];
  /** The songs, and the project's instruments (the built-in ones come from core). */
  songs: SongDoc[] = [];
  instruments: Instrument[] = [];
  style: Style = DEFAULT_STYLE;
  tape: TapeEntry[] = [];
  requests: WorkRequest[] = [];
  presence: Presence | null = null;
  me: string = initialAuthor();
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
  private fetching = new Set<string>();
  private renders = new Map<string, Float32Array[]>();
  private measures = new Map<string, Measured>();
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = (): number => this.version;
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
        this.sounds = m.snapshot.sounds;
        this.sets = m.snapshot.sets ?? [];
        this.songs = (m.snapshot.songs ?? []).map(songFromJson);
        this.instruments = m.snapshot.instruments ?? [];
        this.samples = m.snapshot.samples ?? [];
        this.loadSamples();
        this.style = m.snapshot.style ?? DEFAULT_STYLE;
        this.tape = m.snapshot.tape;
        this.requests = m.snapshot.requests;
        this.presence = m.snapshot.presence;
        break;
      case 'batch': {
        this.sounds = m.sounds;
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
        this.loadSamples();
        break;
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
    const active = activeGroups(this.tape);
    return this.tape.some((e) => active.has(e.group) && !/^(undo|redo) /.test(e.cmd));
  }

  canRedo(): boolean {
    const active = activeGroups(this.tape);
    return this.tape.some((e) => active.has(e.group) && e.cmd.startsWith('undo '));
  }

  /** The samples sample layers can use: the page fetches each one's bytes once and renders with them. */
  readonly sampleBank: SampleBank = {
    get: (name) => {
      const info = this.samples.find((x) => x.name === name);
      const have = this.sampleData.get(name);
      return info && have && have.sha === info.sha256 ? have.data : undefined;
    },
    hash: (name) => this.samples.find((x) => x.name === name)?.sha256,
  };

  private loadSamples(): void {
    for (const info of this.samples) {
      const have = this.sampleData.get(info.name);
      if ((have && have.sha === info.sha256) || this.fetching.has(`${info.name}:${info.sha256}`)) continue;
      const key = `${info.name}:${info.sha256}`;
      this.fetching.add(key);
      void fetch(`/api/samples/${info.name}.wav?token=${encodeURIComponent(this.token)}`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
        .then((buf) => {
          const w = readSampleWav(new Uint8Array(buf));
          this.sampleData.set(info.name, { sha: info.sha256, data: { rate: w.rate, data: w.data } });
        })
        .catch(() => undefined)
        .finally(() => { this.fetching.delete(key); this.renders.clear(); this.measures.clear(); this.changed(); });
    }
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

  /** The channels that sound, given mute and solo: a solo silences every channel not soloed. */
  songAudible(song: SongDoc): string[] {
    const g = this.songGroups(song.id);
    return song.channels.map((c) => c.name).filter((n) => (g.solo.size ? g.solo.has(n) : !g.mute.has(n)));
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
      src.connect(this.ctx.destination);
      let offset = where !== null ? Math.max(0, Math.min(r.length / 44100 - 0.01, where - r.window.start)) : 0;
      if (region && (offset < region.start - r.window.start || offset >= region.end - r.window.start)) offset = region.start - r.window.start;
      src.onended = () => {
        if (this.source === src) { this.source = null; this.songPlay = null; this.playing = null; this.changed(); this.wake(); }
      };
      this.source = src;
      this.playing = `${id}#song-${mode}`;
      this.songPlay = { id, mode, started: this.ctx.currentTime - offset, offset, window: r.window, length: r.length / 44100, region: mode === 'full' ? region : null };
      this.songBusy = null;
      src.start(0, offset);
      if (this.editStarted !== null) { this.lastEditToSound = Math.round(performance.now() - this.editStarted); this.editStarted = null; }
      this.changed();
    } catch (e) {
      this.songBusy = null;
      this.songPlay = null;
      this.playing = null;
      this.error = `could not play: ${(e as Error).message}`;
      this.changed();
    }
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
      src.connect(this.ctx.destination);
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

  private setMeasures = new Map<string, SetMeasure>();

  /** A set's distance matrix, member loudness and set-spread check, measured here with core (the numbers `check` prints). */
  measureSet(set: SetDoc): SetMeasure {
    const members = set.members.map((id) => this.sounds.find((x) => x.id === id)).filter((x): x is Sound => !!x);
    const key = `${set.target}|${JSON.stringify(this.style)}|${members.map((m) => this.keyOf(m)).join(',')}`;
    let m = this.setMeasures.get(key);
    if (!m) {
      m = measureSet(members.map((x) => ({ id: x.id, channels: this.channels(x), lufs: this.measure(x).analysis.lufs })), set.target, this.style);
      this.setMeasures.set(key, m);
      if (this.setMeasures.size > 32) this.setMeasures.delete(this.setMeasures.keys().next().value!);
    }
    return m;
  }

  hashOf(s: Sound): string {
    return samplesHash(joinChannels(this.channels(s)));
  }

  stop(): void {
    try {
      this.source?.stop();
    } catch {
      // already stopped
    }
    this.source = null;
    const wasSong = this.songPlay !== null;
    this.songPlay = null;
    if (this.playing || wasSong) {
      this.playing = null;
      this.changed();
    }
    this.wake();
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

  /** Play a looping sound repeating (its seam is what you listen for) until stopped. */
  async playLoop(id: string): Promise<void> {
    const s = this.sounds.find((x) => x.id === id);
    if (s) await this.playDoc(`${id}#loop`, s, id, undefined, false, true);
  }

  /** Play a sound: rendered here with core, handed to Web Audio at the renderer's own rate. */
  async play(id: string): Promise<void> {
    const s = this.sounds.find((x) => x.id === id);
    if (s) await this.playDoc(id, s);
  }

  /** Play one side of a comparison: A is the pinned sound, B the sound as it stands. */
  async playSide(id: string, slot: 'A' | 'B'): Promise<void> {
    const doc = slot === 'A' ? this.pinned(id)?.sound : this.sounds.find((x) => x.id === id);
    if (doc) await this.playDoc(slot === 'A' ? `${id}#A` : id, doc, id, slot);
  }

  /** Play a sound document under a playing key (a toggle: playing it again stops it). */
  async playDoc(key: string, s: Sound, id = s.id, slot?: 'A' | 'B', restart = false, loop = false): Promise<void> {
    if (this.playing === key && !restart) { this.stop(); return; }
    this.stop();
    const chans = this.channels(s);
    const samples = chans[0]!;
    this.played.push({ id, ...(slot ? { slot } : {}), ...(loop ? { loop: true } : {}), hash: samplesHash(joinChannels(chans)), samples: samples.length, key: this.keyOf(s) });
    this.playing = key;
    this.changed();
    try {
      this.ctx ??= new AudioContext({ sampleRate: 44100 });
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      const buf = this.ctx.createBuffer(chans.length, samples.length, 44100);
      chans.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = loop;
      src.connect(this.ctx.destination);
      src.onended = () => {
        if (this.source === src) {
          this.source = null;
          this.playing = null;
          this.changed();
          this.wake();
        }
      };
      this.source = src;
      src.start();
    } catch (e) {
      this.playing = null;
      this.error = `could not play: ${(e as Error).message}`;
      this.changed();
      this.wake();
    }
  }
}
