// The page's state: the project's sounds as the server streams them, the history tape, requests
// and who is listening, this person's author name, and playback. The page renders sounds with
// core, the same code the agent's renders use, so what plays here is what the agent rendered.
// React reads it via useSyncExternalStore.

import { HUMAN_RE, activeGroups, renderKey, renderSound, samplesHash, type Diag, type Sound, type TapeEntry, type WorkRequest } from '@soundclaw/core';
import type { ClientMessage, PersonRequest, Presence, ServerMessage, Snapshot } from '@soundclaw/server/protocol';

export type Status = 'connecting' | 'open' | 'closed';
export type Answer = { ok: boolean; error?: string; request?: WorkRequest };
export type RunResult = { ok: true; group: string | null; seq: number | null } | { ok: false; errors: Diag[] };

/** A playback the page started: kept so tests (and curious people) can see what was played. */
export interface Played {
  id: string;
  /** Hash of the samples played; the CLI and MCP print its first 12 digits. */
  hash: string;
  samples: number;
  key: string;
}

/** The author name this page writes as: ?name=…, else the last one used here, else human:guest. */
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
  return 'human:guest';
}

export class Store {
  status: Status = 'connecting';
  project: Snapshot['project'] | null = null;
  sounds: Sound[] = [];
  tape: TapeEntry[] = [];
  requests: WorkRequest[] = [];
  presence: Presence | null = null;
  me: string = initialAuthor();
  error: string | null = null;
  /** The sound playing now. */
  playing: string | null = null;
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
    if (!s) return;
    if (this.playing === id) { this.stop(); return; }
    this.stop();
    const samples = this.render(s);
    this.played.push({ id, hash: samplesHash(samples), samples: samples.length, key: renderKey(s) });
    this.playing = id;
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
