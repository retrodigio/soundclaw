// The page's state: the project's sounds as the server streams them, the history tape, requests
// and who is listening, this person's author name, and playback. The page renders sounds with
// core, the same code the agent's renders use, so what plays here is what the agent rendered.
// React reads it via useSyncExternalStore.

import { DEFAULT_STYLE, HUMAN_RE, activeGroups, analyze, melSpectrogram, renderExact, renderKey, renderSound, runChecks, samplesHash, type Analysis, type CheckResult, type Diag, type MelSpec, type Sound, type Style, type TapeEntry, type WorkRequest } from '@soundclaw/core';
import type { ClientMessage, PersonRequest, Presence, ServerMessage, Snapshot } from '@soundclaw/server/protocol';

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
  /** Hash of the samples played; the CLI and MCP print its first 12 digits. */
  hash: string;
  samples: number;
  key: string;
}

/** What a sound's A side is: a snapshot of its parameters, or another sound (followed as it changes). */
export type Pin = { kind: 'snapshot'; sound: Sound; label: string } | { kind: 'sound'; id: string };

/** The sound the page's route names (#/sound/<id>), or null for the list of cards. */
export function routeSound(hash: string): string | null {
  return /^#\/sound\/([a-z][a-z0-9_-]*)$/.exec(hash)?.[1] ?? null;
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
  /** Replay a sound each time it changes in the editor. */
  playOnChange = true;
  /** The A side of each sound's A/B comparison. */
  pins = new Map<string, Pin>();
  played: Played[] = [];
  /** Bumped on every change; React's snapshot. */
  version = 0;
  private token = '';
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private nextId = 0;
  private waiting = new Map<number, (r: RunResult) => void>();
  private answers = new Map<number, (r: Answer) => void>();
  private renders = new Map<string, Float32Array>();
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
    window.addEventListener('hashchange', () => { this.editing = routeSound(location.hash); this.changed(); });
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
        this.style = m.snapshot.style ?? DEFAULT_STYLE;
        this.tape = m.snapshot.tape;
        this.requests = m.snapshot.requests;
        this.presence = m.snapshot.presence;
        break;
      case 'batch':
        this.sounds = m.sounds;
        this.tape = [...this.tape, ...m.entries];
        break;
      case 'requests':
        this.requests = m.requests;
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
    this.pins.set(id, { kind: 'snapshot', sound: s.voice === 'classic' ? { ...s, patch: { ...s.patch } } : { ...s }, label: `${id} as it was at #${this.tape.at(-1)?.seq ?? 0}` });
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

  /** The sound's samples, rendered by core here in the browser (kept by the document's content key). */
  render(s: Sound): Float32Array {
    const key = renderKey(s);
    let r = this.renders.get(key);
    if (!r) {
      r = renderSound(s);
      this.renders.set(key, r);
      if (this.renders.size > 64) this.renders.delete(this.renders.keys().next().value!);
    }
    return r;
  }

  /** The sound's exact samples (doubles; for a classic sound, what the reference synth makes), for tests that compare the browser with Node bit for bit. */
  exact(s: Sound): Float64Array {
    return renderExact(s);
  }

  /** The sound's numbers, checks and a spectrogram, measured here with core (the same code the CLI uses), kept by the document's content key. */
  measure(s: Sound): Measured {
    const key = `${renderKey(s)}|${JSON.stringify(this.style)}`;
    let m = this.measures.get(key);
    if (!m) {
      const x = this.render(s);
      const analysis = analyze(x);
      const hop = Math.max(256, Math.ceil(x.length / 240));
      m = { analysis, checks: runChecks(x, analysis, this.style), spec: melSpectrogram(x, { bands: 48, hop }) };
      this.measures.set(key, m);
      if (this.measures.size > 64) this.measures.delete(this.measures.keys().next().value!);
    }
    return m;
  }

  hashOf(s: Sound): string {
    return samplesHash(this.render(s));
  }

  stop(): void {
    try {
      this.source?.stop();
    } catch {
      // already stopped
    }
    this.source = null;
    if (this.playing) {
      this.playing = null;
      this.changed();
    }
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
  async playDoc(key: string, s: Sound, id = s.id, slot?: 'A' | 'B', restart = false): Promise<void> {
    if (this.playing === key && !restart) { this.stop(); return; }
    this.stop();
    const samples = this.render(s);
    this.played.push({ id, ...(slot ? { slot } : {}), hash: samplesHash(samples), samples: samples.length, key: renderKey(s) });
    this.playing = key;
    this.changed();
    try {
      this.ctx ??= new AudioContext({ sampleRate: 44100 });
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      const buf = this.ctx.createBuffer(1, samples.length, 44100);
      buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      src.onended = () => {
        if (this.source === src) {
          this.source = null;
          this.playing = null;
          this.changed();
        }
      };
      this.source = src;
      src.start();
    } catch (e) {
      this.playing = null;
      this.error = `could not play: ${(e as Error).message}`;
      this.changed();
    }
  }
}
