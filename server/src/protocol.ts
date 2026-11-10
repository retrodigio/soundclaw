// Messages between the server and the dashboard (WebSocket, JSON). Types only, so the UI can
// import them without pulling in any Node code.

import type { Presence } from './await.ts';
import type { SampleInfo } from './samples.ts';
import type { Diag, Instrument, RequestTarget, SetDoc, SongJson, Sound, Style, TapeEntry, WorkRequest } from '@soundclaw/core';

export type { Presence, SampleInfo };
export type { SampleDetail } from './sampledetail.ts';
export type { SampleCard } from './samplecards.ts';
export type { GenerationStatus } from './generate.ts';

/** A registered sample library, as `GET /api/libraries` lists it. */
export interface LibraryListing { id: string; name: string; licence: string; attribution?: string; declared: string; /** Files in its index, or null when it has not been indexed. */ files: number | null }

/** One library file in a search page (`GET /api/library/search`): the numbers a row shows, and where it is. */
export interface LibraryHitJson {
  ref: string;
  dur?: number | null; lufs?: number | null; note?: string | null; centroid?: number; attack?: number | null; onsets?: number; channels?: number; rate?: number;
  error?: string; licence: string; state: string; desc: string; tags?: string[];
}
export interface LibrarySearchReply { offset: number; total: number; notIndexed: string[]; hits: LibraryHitJson[] }

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
  /** The batch the writer is running, or the last one it ran (null: none since the server started). */
  batch: BatchProgress | null;
}

/** A multi-item batch (a run of many commands, `set new`, `set regen`): how many items, how many are done, and whether it has ended. */
export interface BatchProgress {
  id: string;
  by: string;
  total: number;
  done: number;
  /** The latest item done, as the command (or member) it was. */
  label: string;
  state: 'running' | 'done' | 'failed';
  startedAt: string;
}

/** What a person can ask from the dashboard. */
export type PersonRequest =
  | { action: 'request'; kind: 'change'; sound: string; note: string; /** Quick tags (too loud, …, good). */ tags?: string[]; /** With `too similar to another sound`. */ other?: string; /** What inside the item it points at. */ target?: RequestTarget; /** The done request it asks again about. */ again?: string }
  /** A blind A/B judgment: two versions (sound and tape number), the answer, the moment they were judged in and the gain each side played at. */
  | { action: 'compare'; a: { sound: string; seq: number }; b: { sound: string; seq: number }; answer: 'a' | 'b' | 'both' | 'neither'; moment?: string; gains: { a: number; b: number } }
  /** A decision on a done request that is not a new request: approved, or reverted. */
  | { action: 'reviewed'; id: string; how: 'approved' | 'reverted' | 'undone' }
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
  /** A multi-item batch started (`start`, with the count), finished an item (`item`) or ended (`end`). Sent while the batch runs, before its `batch` message. */
  | { type: 'batchProgress'; phase: 'start' | 'item' | 'end'; batch: BatchProgress }
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

/** A check as the review shows it: pass or fail, what was measured, and where in the sound (seconds) for the checks that say. */
export interface ReviewCheck { name: string; pass: boolean; value: string; at: number[] }

/** One side of a review: the sound, its checks, and its numbers. */
export interface ReviewSide { sound: Sound | null; checks: ReviewCheck[]; lufs: number | null; truePeakDb: number | null; duration: number; centroid: number | null }

/** A row of the review's numbers: before, after and the glyph of the check it belongs to (empty: none). */
/** A row of the review's numbers: before (a) and after (b), the after side's check glyph, and for a check the before side's (`ga`). */
export interface ReviewRow { k: string; a: string; b: string; glyph: 'pass' | 'fail' | ''; ga?: 'pass' | 'fail' | '' }

/** What an agent did for a request (or one group), structured for the review page. */
export interface Review {
  /** The request, when the review is of one. */
  request: string | null;
  /** The tape groups the review covers, oldest first. */
  groups: string[];
  first: number;
  last: number;
  by: string;
  at?: string;
  /** The sound or song the review is of. */
  item: string;
  kind: 'sound' | 'song';
  /** The agent's note: the text it finished the request with. */
  note: string | null;
  commands: string[];
  params: { name: string; old: string; new: string; by: string }[];
  rows: ReviewRow[];
  before: ReviewSide | null;
  after: ReviewSide | null;
  /** For a song: notes that went and came, per pattern, and the song as it was and is (the page renders both for the loop). */
  song: { notes: string[]; settings: string[]; before: SongJson | null; after: SongJson | null; stillThere: boolean } | null;
  /** The item as it is now matches the `after` (nothing has changed it since). */
  current: boolean;
  /** The tape's end when this was worked out. */
  tapeEnd: number;
}

