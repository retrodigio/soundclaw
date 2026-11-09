// Waiting for work. People file requests and write status marks in the dashboard; an agent
// learns of them by waiting here: `await` returns as soon as an event arrives after a cursor, or
// empty on timeout. Events live in memory in the server that owns the project; the cursor is
// `<epoch>:<n>`, a count that only grows within one server run, so nothing is lost or repeated
// between calls (a cursor from another run, or none, starts afresh: the requests still open and
// not yet seen are the events then).
//
// The hub also knows who is listening (waiters, and agents that called an agent tool lately), which the dashboard shows beside each request.

import { randomBytes } from 'node:crypto';
import { HUMAN_RE, comparisonWords, targetWords, type Comparison, type RequestRecord, type RequestTarget, type WorkRequest } from '@soundclaw/core';

export type EventKind = 'request' | 'comparison' | 'reply' | 'cancel' | 'approved' | 'rejected';

/** What an agent is told. `next`: `work` claims a request; `history` reads what a person did to a sound. */
export interface AgentEvent {
  /** Position in this server's event sequence (0 for an open request found when no cursor was given). */
  seq: number;
  kind: EventKind;
  /** The request (request, reply, cancel); null for a status mark. */
  id: string | null;
  sound: string;
  note: string;
  /** Quick tags on the request (too loud, good, …). */
  tags?: string[];
  /** A comparison: the two sides, the answer, the moment and the gains. */
  comparison?: Comparison;
  /** What inside the item the request points at. */
  target?: RequestTarget;
  /** The earlier request this one asks again about. */
  again?: string;
  by: string;
  at: string;
  next: 'work' | 'history';
}

export interface Presence {
  /** Someone is, or may be, taking requests. */
  listening: boolean;
  /** Calls to await that are open right now. */
  waiters: { by: string; via: 'cli' | 'mcp'; since: string }[];
  /** Agents that called work or await in the last few minutes. */
  agents: { by: string; at: string }[];
}

/** How long an agent that called a tool counts as listening. */
export const ACTIVE_MS = 5 * 60 * 1000;
/** How long an open request may go unseen before a card says so. */
export const UNSEEN_MS = 2 * 60 * 1000;
const KEEP = 500;

const MARK_RE = /^(?:sound|song) mark (\S+) (approved|rejected)\b\s*(.*)$/;

interface Waiter {
  by: string;
  via: 'cli' | 'mcp';
  since: string;
  /** Called when an event is pushed. */
  wake(): void;
  /** Stop waiting now. */
  stop(): void;
}

export class Hub {
  readonly epoch = randomBytes(3).toString('hex');
  private seq = 0;
  private log: AgentEvent[] = [];
  private waiters = new Set<Waiter>();
  private active = new Map<string, number>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private consumed = 0;
  private quiet = 0;
  private closed = false;
  /** Called when presence changes. */
  onPresence: () => void = () => undefined;
  private readonly clock: () => number;
  private readonly stamp: () => string;
  constructor(clock: () => number = Date.now, stamp: () => string = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
    this.clock = clock;
    this.stamp = stamp;
  }

  cursor(): string {
    return `${this.epoch}:${this.seq}`;
  }

  /** Records already in the file when the project was opened are not events. */
  attach(records: RequestRecord[]): void {
    this.consumed = records.length;
  }

  push(e: Omit<AgentEvent, 'seq'>): void {
    this.log.push({ ...e, seq: ++this.seq });
    if (this.log.length > KEEP) this.log.splice(0, this.log.length - KEEP);
    for (const w of [...this.waiters]) w.wake();
  }

  /** Requests.jsonl has grown: the records after the last ones seen are events (an agent's claim, progress and done are not). */
  syncRequests(records: RequestRecord[], reqs: ReadonlyMap<string, WorkRequest>): void {
    if (records.length < this.consumed) this.consumed = 0;
    for (const r of records.slice(this.consumed)) {
      if (r.type === 'request') this.push({ kind: r.comparison ? 'comparison' : 'request', id: r.id, sound: r.sound, note: r.note, ...(r.tags?.length ? { tags: r.tags } : {}), ...(r.comparison ? { comparison: r.comparison } : {}), ...(r.target ? { target: r.target } : {}), ...(r.again ? { again: r.again } : {}), by: r.by, at: r.at, next: 'work' });
      else if (r.type === 'reply' || r.type === 'cancel') {
        this.push({ kind: r.type, id: r.id, sound: reqs.get(r.id)?.sound ?? '', note: r.text ?? '', by: r.by, at: r.at, next: 'work' });
      }
    }
    this.consumed = records.length;
  }

  /** Tape lines a batch added: a status mark by a person is an event. */
  marks(by: string, entries: { cmd: string }[], at: string): void {
    if (this.quiet || !HUMAN_RE.test(by)) return;
    for (const e of entries) {
      const m = MARK_RE.exec(e.cmd);
      if (!m) continue;
      let note = m[3]!.trim();
      try {
        const v: unknown = JSON.parse(note);
        if (typeof v === 'string') note = v;
      } catch {
        // an unquoted note stays as written
      }
      this.push({ kind: m[2] as EventKind, id: null, sound: m[1]!, note, by, at, next: 'history' });
    }
  }

  /** Run something whose status marks belong to a request (Ask for changes), so they are not events of their own. */
  withoutMarkEvents<T>(f: () => T): T {
    this.quiet++;
    try {
      return f();
    } finally {
      this.quiet--;
    }
  }

  /** Events after a cursor, or null when the cursor is not this run's. */
  since(cursor: string | undefined): AgentEvent[] | null {
    if (!cursor) return null;
    const m = /^([0-9a-f]+):(\d+)$/.exec(cursor);
    if (!m || m[1] !== this.epoch || Number(m[2]) > this.seq) return null;
    const n = Number(m[2]);
    return this.log.filter((e) => e.seq > n);
  }

  /**
   * Wait for events after the cursor (see `since`); `initial` are the events to return at once
   * when there is no usable cursor. Resolves on the first event, on timeout (no events), or when
   * the signal aborts or the hub closes.
   */
  async wait(o: { cursor?: string; initial: () => AgentEvent[]; timeoutMs: number; by: string; via: 'cli' | 'mcp'; signal?: AbortSignal }): Promise<{ events: AgentEvent[]; cursor: string; timedOut: boolean }> {
    const pick = (): AgentEvent[] => (this.since(o.cursor) ?? o.initial()).filter((e) => e.by !== o.by);
    let events = pick();
    if (events.length || this.closed) return { events, cursor: this.cursor(), timedOut: false };
    // The cursor moves up even when everything after it was the waiter's own doing.
    const base = this.since(o.cursor) ? o.cursor : this.cursor();
    this.touch(o.by);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waiter!: Waiter;
    await new Promise<void>((resolve) => {
      waiter = { by: o.by, via: o.via, since: this.stamp(), wake: () => { if (pickNew().length) resolve(); }, stop: resolve };
      const pickNew = (): AgentEvent[] => (this.since(base) ?? []).filter((e) => e.by !== o.by);
      this.waiters.add(waiter);
      this.timers.add(timer = setTimeout(resolve, o.timeoutMs));
      timer.unref?.();
      o.signal?.addEventListener('abort', () => resolve(), { once: true });
      if (o.signal?.aborted) resolve();
      this.onPresence();
    });
    clearTimeout(timer);
    this.timers.delete(timer!);
    this.waiters.delete(waiter);
    this.touch(o.by);
    events = (this.since(base) ?? []).filter((e) => e.by !== o.by);
    return { events, cursor: this.cursor(), timedOut: events.length === 0 };
  }

  /** An agent called a tool that takes requests. */
  touch(by: string): void {
    this.active.set(by, this.clock());
    const t = setTimeout(() => { this.timers.delete(t); this.onPresence(); }, ACTIVE_MS + 1000);
    t.unref?.();
    this.timers.add(t);
    this.onPresence();
  }

  presence(): Presence {
    const now = this.clock();
    const agents = [...this.active].filter(([, at]) => now - at <= ACTIVE_MS).map(([by, at]) => ({ by, at: new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z') }));
    const waiters = [...this.waiters].map(({ by, via, since }) => ({ by, via, since }));
    return { listening: waiters.length > 0 || agents.length > 0, waiters, agents };
  }

  /** Wake every waiter and stop timers (the server is stopping). */
  close(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const w of [...this.waiters]) w.stop();
  }
}

/** The open requests no agent has seen yet: what a listener with no cursor is told. */
export function unseenOpen(reqs: ReadonlyMap<string, WorkRequest>): AgentEvent[] {
  return [...reqs.values()]
    .filter((q) => q.state === 'open' && q.seen.length === 0)
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
    .map((q) => {
      const reply = q.events.filter((e) => e.type === 'reply').at(-1);
      return { seq: 0, kind: reply ? 'reply' as const : q.comparison ? 'comparison' as const : 'request' as const, id: q.id, sound: q.sound, note: reply?.text ?? q.note, ...(!reply && q.tags.length ? { tags: q.tags } : {}), ...(!reply && q.comparison ? { comparison: q.comparison } : {}), ...(!reply && q.target ? { target: q.target } : {}), ...(!reply && q.again ? { again: q.again } : {}), by: reply?.by ?? q.by, at: reply?.at ?? q.at, next: 'work' as const };
    });
}

/** Events as text, for the CLI and the MCP tool. */
export function formatEvents(events: AgentEvent[], cursor: string, o: { cli?: string } = {}): string {
  if (!events.length) return `no new events\nnext cursor: ${cursor}`;
  const out: string[] = [`${events.length} event${events.length === 1 ? '' : 's'}:`];
  for (const e of events) {
    const what = e.id ? `${e.kind} ${e.id} (${e.sound})` : `${e.kind} ${e.sound}`;
    out.push(e.comparison
      ? `  ${what} from ${e.by} at ${e.at}: ${comparisonWords(e.comparison)}`
      : `  ${what} from ${e.by} at ${e.at}${e.tags?.length ? ` [${e.tags.join(', ')}]` : ''}${e.note ? `: "${e.note}"` : ''}${e.target ? ` — ${targetWords(e.target)}` : ''}${e.again ? ` (asks again about ${e.again})` : ''}`);
    out.push(e.next === 'work'
      ? `    next: work${e.kind === 'cancel' ? ' (action "list"; stop if you hold it)' : e.kind === 'comparison' ? ` (claim it: work id=${e.id}, read it, then close it with done: nothing is asked to change)` : e.id ? ` (claim it: work id=${e.id})` : ''}` +
        (o.cli && e.kind !== 'cancel' && e.id ? `; without MCP: soundclaw work ${o.cli} claim ${e.id}` : '')
      : `    next: history (read what the person did: soundclaw history ${o.cli ?? '<project>'} --sound ${e.sound})`);
  }
  out.push(`next cursor: ${cursor}`);
  return out.join('\n');
}
