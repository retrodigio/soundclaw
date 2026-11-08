// Requests: what a person asks the agent for from the dashboard, kept as an append-only
// list of records (requests.jsonl). A request is opened by a person (`request`: change a sound),
// then the agent claims it, posts progress, and
// finishes it (`done`, with what changed) or stops on a question (`blocked`). The person answers a
// blocked request (`reply`, which opens it again) or withdraws one (`cancel`). The state is worked
// out by reading the records in order; a record that does not fit the state is refused before it is
// written, so the file never holds one.
//
//   open ──claim──▶ claimed ──done──▶ done
//    ▲                │  ▲ progress
//    │                └──┴──blocked──▶ blocked ──reply──▶ open
//    └── cancel (open, claimed, blocked) ──▶ cancelled
//
// `seen` records that an agent was handed an open request (by await, plan or work). It changes
// no state; it lets the dashboard say "seen by claude" instead of "open". A reply opens the
// request again and clears who has seen it, since the new answer has not been seen yet. Files
// written before `seen` existed read the same: they simply hold no such records.

import { isFeedbackTag } from './editor.ts';

/**
 * `change`: something should be different. `feedback`: only praise (the tag `good`); nothing to change, the agent just acknowledges it.
 * `comparison`: a person's blind judgment of two versions (A and B, each a sound at a tape number) against the moment in the game they
 * are for; nothing is asked to change, the agent reads it and closes it like feedback.
 */
export const REQUEST_KINDS = ['change', 'feedback', 'comparison'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
/** A comparison's answers: A fits better, B fits better, both would do, neither would do. */
export const COMPARISON_ANSWERS = ['a', 'b', 'both', 'neither'] as const;
export type ComparisonAnswer = (typeof COMPARISON_ANSWERS)[number];
/** One side of a comparison: a sound as it stood after a tape entry. */
export interface ComparedSide { sound: string; seq: number }
/** What a comparison request records besides its note. */
export interface Comparison {
  a: ComparedSide;
  b: ComparedSide;
  answer: ComparisonAnswer;
  /** The moment the person judged them in (absent: the sounds had none). */
  moment?: string;
  /** The level-matching gain applied to each side as it played (dB). */
  gains: { a: number; b: number };
}

/** An answer in words, as the dashboard's buttons say it. */
export const ANSWER_WORDS: Record<ComparisonAnswer, string> = { a: 'A fits better', b: 'B fits better', both: 'Both would do', neither: 'Neither would do' };

const sideWords = (x: ComparedSide): string => `${x.sound} as at #${x.seq}`;
const db = (g: number): string => `${g > 0 ? '+' : g < 0 ? '−' : '±'}${Math.abs(g).toFixed(1)} dB`;

/** A comparison in words: `A fits better in "…": A was step as at #12 (gain +1.2 dB), B was step as at #20 (gain −0.3 dB)`. */
export function comparisonWords(c: Comparison): string {
  return `${ANSWER_WORDS[c.answer]}${c.moment ? ` in "${c.moment}"` : ' (no moment given)'}: A was ${sideWords(c.a)} (gain ${db(c.gains.a)}), B was ${sideWords(c.b)} (gain ${db(c.gains.b)})`;
}

export const REQUEST_STATES = ['open', 'claimed', 'blocked', 'done', 'cancelled'] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

/** One line of requests.jsonl. */
export type RequestRecord =
  | { type: 'request'; id: string; sound: string; kind: RequestKind; note: string; by: string; at: string; /** The `sound mark … rejected` it goes with (tape seq). */ mark?: number; /** Quick tags a person clicked (too loud, good, …). */ tags?: string[]; /** With `too similar to another sound`: the other sound. */ other?: string; /** A comparison's sides, answer, moment and gains. */ comparison?: Comparison }
  | { type: 'claim' | 'progress' | 'done' | 'blocked' | 'reply' | 'cancel' | 'seen'; id: string; by: string; at: string; text?: string };

export interface RequestEvent {
  type: Exclude<RequestRecord['type'], 'request' | 'seen'>;
  by: string;
  at: string;
  text?: string;
}

/** A request as it stands after its records. */
export interface WorkRequest {
  id: string;
  sound: string;
  kind: RequestKind;
  note: string;
  by: string;
  at: string;
  mark?: number;
  /** The quick tags on the request (empty when it has none). */
  tags: string[];
  /** The sound a `too similar` tag points at. */
  other?: string;
  /** A comparison request's sides, answer, moment and gains. */
  comparison?: Comparison;
  state: RequestState;
  /** Who claimed it (while claimed, and after). */
  claimedBy: string | null;
  /** The latest progress, done or blocked text. */
  latest: string | null;
  /** The question a blocked request waits on. */
  question: string | null;
  /** Agents handed this request while it was open (cleared when a reply opens it again). */
  seen: { by: string; at: string }[];
  events: RequestEvent[];
}

const ID_RE = /^r\d+$/;
const NAME_RE = /^[a-z][a-z0-9_-]*$/;
/** A sound id as the sounds have them (case kept). */
const SOUND_RE = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;

/** Why a comparison cannot be recorded (null: it can). */
export function comparisonProblem(c: unknown): string | null {
  if (!c || typeof c !== 'object') return 'a comparison request carries the comparison (a, b, answer, gains)';
  const x = c as Partial<Comparison>;
  for (const k of ['a', 'b'] as const) {
    const v = x[k] as Partial<ComparedSide> | undefined;
    if (!v || typeof v !== 'object' || typeof v.sound !== 'string' || !SOUND_RE.test(v.sound)) return `a comparison's ${k} names a sound`;
    if (typeof v.seq !== 'number' || !Number.isInteger(v.seq) || v.seq < 1) return `a comparison's ${k} names the tape number of its version (a whole number from 1)`;
  }
  if (x.a!.sound === x.b!.sound && x.a!.seq === x.b!.seq) return 'a comparison compares two different versions';
  if (!(COMPARISON_ANSWERS as readonly string[]).includes(x.answer as string)) return `a comparison's answer is ${COMPARISON_ANSWERS.join(', ')}`;
  if (x.moment !== undefined && (typeof x.moment !== 'string' || !x.moment.trim() || x.moment.length > 400)) return 'a comparison\'s moment is text (at most 400 characters), or left out';
  const g = x.gains as { a?: unknown; b?: unknown } | undefined;
  if (!g || typeof g !== 'object' || [g.a, g.b].some((v) => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 60)) return 'a comparison records the gain applied to each side (dB, within ±60)';
  return null;
}

/** Why this record cannot follow these requests (null: it can). */
export function requestProblem(reqs: ReadonlyMap<string, WorkRequest>, r: RequestRecord): string | null {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'a request id looks like r12';
  if (typeof r.by !== 'string' || !r.by) return 'a record needs who wrote it (by)';
  if (typeof r.at !== 'string') return 'a record needs a time (at)';
  if (r.type === 'request') {
    if (reqs.has(r.id)) return `request ${r.id} already exists`;
    if (typeof r.sound !== 'string' || !(r.kind === 'comparison' ? SOUND_RE : NAME_RE).test(r.sound)) return 'a request names a sound (a-z, 0-9, _ and -)';
    if (!(REQUEST_KINDS as readonly string[]).includes(r.kind)) return `a request's kind is ${REQUEST_KINDS.join(', ')}`;
    if (typeof r.note !== 'string') return 'a request has a note (it may be empty)';
    if (!r.note.trim()) return 'a change request says what should change';
    if (r.tags !== undefined && (!Array.isArray(r.tags) || r.tags.some((t) => typeof t !== 'string' || !isFeedbackTag(t)))) return 'tags are from the list on the card (a sound: too loud, too quiet, too long, too short, too harsh, too dull, too similar to another sound, good; a song: too busy, too sparse, too loud, too repetitive, wrong mood, good)';
    if (r.other !== undefined && (typeof r.other !== 'string' || !NAME_RE.test(r.other))) return 'the other sound is a sound id';
    if (r.kind === 'feedback' && !(r.tags?.length && r.tags.every((t) => t === 'good'))) return 'a feedback request carries the tag good and nothing else';
    if (r.kind === 'comparison') {
      const p = comparisonProblem(r.comparison);
      if (p) return p;
      if (r.tags?.length || r.other !== undefined || r.mark !== undefined) return 'a comparison carries no tags, other sound or mark';
      if (r.sound !== r.comparison!.a.sound && r.sound !== r.comparison!.b.sound) return 'a comparison request names one of the two sounds it compares';
    } else if (r.comparison !== undefined) return 'only a comparison request carries a comparison';
    return null;
  }
  const q = reqs.get(r.id);
  if (!q) return `no request ${r.id}`;
  if (r.text !== undefined && typeof r.text !== 'string') return 'text is text';
  const need = (ok: boolean, why: string) => (ok ? null : `${r.id} is ${q.state}: ${why}`);
  switch (r.type) {
    case 'claim':
      return need(q.state === 'open' || (q.state === 'claimed' && q.claimedBy === r.by), q.state === 'claimed' ? `${q.claimedBy} has it` : 'only an open request can be claimed');
    case 'progress':
      return need(q.state === 'claimed' && q.claimedBy === r.by, 'progress is posted by whoever claimed it') ?? (r.text?.trim() ? null : 'progress needs text');
    case 'done':
      return need(q.state === 'claimed' && q.claimedBy === r.by, 'claim it before finishing it') ?? (r.text?.trim() ? null : 'say what changed');
    case 'blocked':
      return need(q.state === 'claimed' && q.claimedBy === r.by, 'claim it before blocking it') ?? (r.text?.trim() ? null : 'a blocked request asks a question');
    case 'reply':
      return need(q.state === 'blocked', 'only a blocked request takes a reply') ?? (r.text?.trim() ? null : 'a reply needs text');
    case 'seen':
      return need(q.state === 'open', 'only an open request is handed to an agent') ?? (q.seen.some((x) => x.by === r.by) ? `${r.by} has seen ${r.id} already` : null);
    case 'cancel':
      return need(q.state === 'open' || q.state === 'claimed' || q.state === 'blocked', 'it is already finished');
    default:
      return `unknown record type '${(r as { type: string }).type}'`;
  }
}

/** Apply one record (already checked) to the requests. */
export function applyRequest(reqs: Map<string, WorkRequest>, r: RequestRecord): void {
  if (r.type === 'request') {
    reqs.set(r.id, {
      id: r.id, sound: r.sound, kind: r.kind, note: r.note, by: r.by, at: r.at, ...(r.mark !== undefined ? { mark: r.mark } : {}), tags: [...(r.tags ?? [])], ...(r.other ? { other: r.other } : {}),
      ...(r.comparison ? { comparison: { a: { ...r.comparison.a }, b: { ...r.comparison.b }, answer: r.comparison.answer, ...(r.comparison.moment ? { moment: r.comparison.moment } : {}), gains: { ...r.comparison.gains } } } : {}),
      state: 'open', claimedBy: null, latest: null, question: null, seen: [], events: [],
    });
    return;
  }
  const q = reqs.get(r.id)!;
  if (r.type === 'seen') {
    // Who has seen it is kept on its own, not among the events (the timeline of what happened to it).
    q.seen.push({ by: r.by, at: r.at });
    return;
  }
  q.events.push({ type: r.type, by: r.by, at: r.at, ...(r.text !== undefined ? { text: r.text } : {}) });
  switch (r.type) {
    case 'claim': q.state = 'claimed'; q.claimedBy = r.by; break;
    case 'progress': q.latest = r.text ?? null; break;
    case 'done': q.state = 'done'; q.latest = r.text ?? null; q.question = null; break;
    case 'blocked': q.state = 'blocked'; q.latest = r.text ?? null; q.question = r.text ?? null; break;
    case 'reply': q.state = 'open'; q.claimedBy = null; q.question = null; q.latest = r.text ?? null; q.seen = []; break;
    case 'cancel': q.state = 'cancelled'; break;
  }
}

/** Read records in order. Records that do not fit are skipped and reported (a hand-edited file). */
export function foldRequests(records: RequestRecord[]): { requests: Map<string, WorkRequest>; problems: string[] } {
  const requests = new Map<string, WorkRequest>();
  const problems: string[] = [];
  records.forEach((r, i) => {
    const p = requestProblem(requests, r);
    if (p) problems.push(`record ${i + 1}: ${p}`);
    else applyRequest(requests, r);
  });
  return { requests, problems };
}

/** The next free id. */
export function nextRequestId(reqs: ReadonlyMap<string, WorkRequest>): string {
  let n = 0;
  for (const id of reqs.keys()) n = Math.max(n, Number(id.slice(1)));
  return `r${n + 1}`;
}

/** Requests still wanting something: open first (oldest first), then claimed, then blocked. */
export function openRequests(reqs: ReadonlyMap<string, WorkRequest>): WorkRequest[] {
  const order: Record<RequestState, number> = { open: 0, claimed: 1, blocked: 2, done: 3, cancelled: 4 };
  return [...reqs.values()].filter((q) => order[q.state] < 3).sort((a, b) => order[a.state] - order[b.state] || Number(a.id.slice(1)) - Number(b.id.slice(1)));
}
