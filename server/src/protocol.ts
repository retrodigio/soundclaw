// Messages between the server and the dashboard (WebSocket, JSON). Types only, so the UI can
// import them without pulling in any Node code.

import type { Presence } from './await.ts';
import type { SampleInfo } from './samples.ts';
import type { Diag, Instrument, SetDoc, SongJson, Sound, Style, TapeEntry, WorkRequest } from '@soundclaw/core';

export type { Presence, SampleInfo };

/** What the list shows about a sound's last known render: the numbers and the checks (the server works them out in a worker thread and keeps them). */
export interface CardLite {
  /** Hash of the rendered samples; the CLI and MCP print its first 12 digits. */
  hash: string;
  duration: number;
  /** null: silence (minus infinity). */
  lufs: number | null;
  truePeakDb: number | null;
  pass: boolean;
  failing: string[];
  /** The one-line checks summary (the badge's tooltip). */
  summary: string;
  /** One entry per failing check: what was measured as text, and when in the sound (seconds) for the checks that report a time. Absent in cards written before it existed. */
  issues?: { name: string; value: string; at?: number }[];
}

/** A card's thumbnails: the waveform's peaks per pixel column and the spectrogram as one byte per cell (0 to 255 over its 80 dB). */
export interface CardInfo extends CardLite {
  /** Names the render, the loudness rule and the style this was worked out for (changes when any of them does). */
  key: string;
  peak: number;
  wave: { min: number[]; max: number[] };
  spec: { w: number; h: number; frames: number; bands: number; /** base64, rows from the top, h × w bytes. */ data: string };
}

/** One line of the sound list: all the page needs to show it before it has the sound's document. */
export interface SoundSummary {
  id: string;
  voice: Sound['voice'];
  status: Sound['status'];
  /** The card key for the sound as it stands; `info` is for that key, when the server knows it yet. */
  key: string;
  /** A few words about what the sound is made of (`3 layers: osc, sample, sample`). */
  label: string;
  info?: CardLite;
}

/** Projects with more sounds than this send the list first and the documents on demand. */
export const LEAN_AT = 100;
export { HUMAN_RE } from '@soundclaw/core';

/** Everything a page needs to start: sent on connect. */
export interface Snapshot {
  project: { name: string; dir: string; /** The server user's home folder, so the page can show the folder as ~/…. */ home?: string };
  /** The list: every sound's id, voice, status and last known numbers. */
  index: SoundSummary[];
  /** Sound documents. All of them in a small project; none in a lean one (the page asks for a document when it opens the sound: GET /api/sound/<id>.json). */
  sounds: Sound[];
  lean: boolean;
  /** Whether undo and redo would do anything (the page may hold only the end of the tape). */
  history: { canUndo: boolean; canRedo: boolean };
  /** How many entries the tape has; `tape` holds the newest ones (GET /api/tape?before=<seq> has the earlier ones). */
  tapeTotal: number;
  /** The sets: named groups of sounds with a loudness target (their members are sounds above). */
  sets: SetDoc[];
  /** The songs (patterns as a list) and the project's instruments; the page renders songs with the same core, the built-in instruments included. */
  songs: SongJson[];
  instruments: Instrument[];
  /** The project's imported samples (a sample layer names one; the page fetches the bytes to render it). */
  samples: SampleInfo[];
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
  | { type: 'batch'; by: string; group: string; entries: TapeEntry[]; index: SoundSummary[]; /** The documents the batch touched (all of them in a small project). */ sounds: Sound[]; /** Sounds that are gone. */ removed: string[]; lean: boolean; history: { canUndo: boolean; canRedo: boolean }; sets: SetDoc[]; songs: SongJson[]; instruments: Instrument[] }
  /** Cards the server has worked out since (for the list's badges): id, the key it is for, and the numbers. */
  | { type: 'cards'; cards: { id: string; key: string; info: CardLite }[] }
  /** The answer to one page's `run` (only to that page; the batch itself goes to every page). */
  | { type: 'result'; id: number; ok: true; group: string | null; seq: number | null }
  | { type: 'result'; id: number; ok: false; errors: Diag[] }
  | { type: 'pong' }
  /** The project's samples changed (a sample was imported). */
  | { type: 'samples'; samples: SampleInfo[] }
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
