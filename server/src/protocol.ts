// Messages between the server and the dashboard (WebSocket, JSON). Types only, so the UI can
// import them without pulling in any Node code.

import type { Presence } from './await.ts';
import type { Diag, Sound, Style, TapeEntry, WorkRequest } from '@soundclaw/core';

export type { Presence };
export { HUMAN_RE } from '@soundclaw/core';

/** Everything a page needs to start: sent on connect. */
export interface Snapshot {
  project: { name: string; dir: string; /** The server user's home folder, so the page can show the folder as ~/…. */ home?: string };
  /** Every sound's document; the page renders them with the same core the agent's renders use. */
  sounds: Sound[];
  /** What the checks are held to (the card's badge uses the same numbers the CLI does). */
  style: Style;
  /** The whole history tape (undone groups included, with the undo that undid them). */
  tape: TapeEntry[];
  requests: WorkRequest[];
  presence: Presence;
}

/** What a person can ask from the dashboard. */
export type PersonRequest =
  | { action: 'request'; kind: 'change'; sound: string; note: string; /** Quick tags (too loud, …, good). */ tags?: string[]; /** With `too similar to another sound`. */ other?: string }
  | { action: 'reply'; id: string; text: string }
  | { action: 'cancel'; id: string; text?: string };

export type ServerMessage =
  | { type: 'hello'; snapshot: Snapshot }
  /** One applied batch (one undo group): its tape entries, and the sounds as they now stand. */
  | { type: 'batch'; by: string; group: string; entries: TapeEntry[]; sounds: Sound[] }
  /** The answer to one page's `run` (only to that page; the batch itself goes to every page). */
  | { type: 'result'; id: number; ok: true; group: string | null; seq: number | null }
  | { type: 'result'; id: number; ok: false; errors: Diag[] }
  | { type: 'pong' }
  /** requests.jsonl changed: every request as it stands. */
  | { type: 'requests'; requests: WorkRequest[] }
  /** Who is listening for requests (sent on connect and whenever it changes). */
  | { type: 'presence'; presence: Presence }
  /** The answer to a page's request (only to that page). */
  | { type: 'answer'; id: number; ok: boolean; error?: string; request?: WorkRequest };

export type ClientMessage =
  | { type: 'ping' }
  /** Commands from a person: applied by the single writer as one undo group, written `by`. */
  | { type: 'run'; id: number; commands: string; by: string }
  /** A request, a reply or a cancel from the dashboard, written `by`. */
  | { type: 'request'; id: number; by: string; body: PersonRequest };
