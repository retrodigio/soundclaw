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

export const REQUEST_KINDS = ['change'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export const REQUEST_STATES = ['open', 'claimed', 'blocked', 'done', 'cancelled'] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

/** One line of requests.jsonl. */
export type RequestRecord =
  | { type: 'request'; id: string; sound: string; kind: RequestKind; note: string; by: string; at: string; /** The `sound mark … rejected` it goes with (tape seq). */ mark?: number }
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

/** Why this record cannot follow these requests (null: it can). */
export function requestProblem(reqs: ReadonlyMap<string, WorkRequest>, r: RequestRecord): string | null {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'a request id looks like r12';
  if (typeof r.by !== 'string' || !r.by) return 'a record needs who wrote it (by)';
  if (typeof r.at !== 'string') return 'a record needs a time (at)';
  if (r.type === 'request') {
    if (reqs.has(r.id)) return `request ${r.id} already exists`;
    if (typeof r.sound !== 'string' || !NAME_RE.test(r.sound)) return 'a request names a sound (a-z, 0-9, _ and -)';
    if (!(REQUEST_KINDS as readonly string[]).includes(r.kind)) return `a request's kind is ${REQUEST_KINDS.join(', ')}`;
    if (typeof r.note !== 'string') return 'a request has a note (it may be empty)';
    if (!r.note.trim()) return 'a change request says what should change';
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
      id: r.id, sound: r.sound, kind: r.kind, note: r.note, by: r.by, at: r.at, ...(r.mark !== undefined ? { mark: r.mark } : {}),
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
