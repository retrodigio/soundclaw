// Requests from the dashboard: requests.jsonl in the project, one record a line, only ever
// appended. People open requests (Ask for changes), answer a blocked one or withdraw one; the
// agent claims, posts progress and finishes them through the MCP `work` tool or `soundclaw work`.
// Every record is checked against the state the file is in before it is written (core's state
// machine), so the file only holds records that fit.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTHOR_RE, foldRequests, nextRequestId, openRequests, quote, requestProblem, serializeSound, type RequestRecord, type WorkRequest } from '@soundclaw/core';
import { unseenOpen, type AgentEvent } from './await.ts';
import { REQUESTS_FILE, ProjectError, type Project } from './project.ts';
import type { PersonRequest } from './protocol.ts';
import type { Writer } from './writer.ts';

/** Every record in the file, in order (a line that is not JSON is skipped). */
export function readRequestRecords(p: Project): RequestRecord[] {
  const f = join(p.dir, REQUESTS_FILE);
  if (!existsSync(f)) return [];
  const out: RequestRecord[] = [];
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RequestRecord);
    } catch {
      // a broken line (a hand edit) is not a record
    }
  }
  return out;
}

export function readRequests(p: Project): Map<string, WorkRequest> {
  return foldRequests(readRequestRecords(p)).requests;
}

/** Append one record if it fits; returns the request as it now stands. */
export function appendRequest(p: Project, r: RequestRecord): WorkRequest {
  const reqs = readRequests(p);
  const problem = requestProblem(reqs, r);
  if (problem) throw new ProjectError(problem);
  appendFileSync(join(p.dir, REQUESTS_FILE), JSON.stringify(r) + '\n');
  return readRequests(p).get(r.id)!;
}

/**
 * A person's request, reply or cancel. "Ask for changes" writes `sound mark <id> rejected "…"` on
 * the history with the person's name (as the Approve button writes `approved`) and records the
 * request with that mark. Run inside the writer's queue.
 */
export function personRequest(w: Writer, by: string, q: PersonRequest): WorkRequest {
  const p = w.project;
  const at = w.stamp();
  if (q.action === 'reply') return appendRequest(p, { type: 'reply', id: q.id, by, at, text: String(q.text ?? '') });
  if (q.action === 'cancel') return appendRequest(p, { type: 'cancel', id: q.id, by, at, ...(q.text ? { text: q.text } : {}) });
  const reqs = readRequests(p);
  const id = nextRequestId(reqs);
  const note = (q.note ?? '').trim();
  w.sound(q.sound); // throws when there is no such sound
  if (!note) throw new ProjectError('say what should change');
  const rec: RequestRecord = { type: 'request', id, sound: q.sound, kind: 'change', note, by, at };
  const problem = requestProblem(reqs, rec);
  if (problem) throw new ProjectError(problem);
  const r = w.hub.withoutMarkEvents(() => w.run({ commands: `sound mark ${q.sound} rejected ${quote(note)}`, by }));
  if (!r.ok) throw new ProjectError(r.errors.map((e) => e.message).join('; '));
  return appendRequest(p, { ...rec, mark: r.added.at(-1)?.seq });
}

/** A request as one line: `r3 change beep: "softer" (from human:ana at …; claimed by agent:claude)`. */
export function requestLine(q: WorkRequest): string {
  // An open request an agent was handed reads as the dashboard's card does: "seen by agent:claude".
  const state = q.state === 'claimed' ? `claimed by ${q.claimedBy}` : q.state === 'blocked' ? `blocked: "${q.question}"`
    : q.state === 'open' && q.seen.length ? `seen by ${q.seen.map((x) => x.by).join(', ')}` : q.state;
  return `${q.id} change ${q.sound}${q.note ? `: "${q.note}"` : ''} (from ${q.by} at ${q.at}; ${state})`;
}

/** A request, reply or cancel from the CLI or MCP as the dashboard's message. Checked here for shape; personRequest checks it against the project. */
export function toPersonRequest(a: { action?: string; sound?: string; note?: string; id?: string; text?: string }): PersonRequest {
  const action = a.action ?? 'request';
  if (action === 'reply' || action === 'cancel') {
    if (!a.id || !/^r\d+$/.test(a.id)) throw new ProjectError(`${action}: give the request's id (like r3)`);
    if (action === 'reply') {
      if (!a.text?.trim()) throw new ProjectError('reply: give the answer (text)');
      return { action, id: a.id, text: a.text };
    }
    return { action, id: a.id, ...(a.text?.trim() ? { text: a.text } : {}) };
  }
  if (action !== 'request') throw new ProjectError(`unknown action '${action}' (request, reply, cancel)`);
  if (!a.sound) throw new ProjectError('request: give the sound');
  return { action, kind: 'change', sound: a.sound, note: a.note ?? '' };
}

/** An agent's name as an author: `claude` and `agent:claude` both give `agent:claude`. */
export function agentName(name: string | undefined): string {
  const n = name ?? 'claude';
  const full = n.includes(':') ? n : `agent:${n}`;
  if (!AUTHOR_RE.test(full) || !full.startsWith('agent:')) throw new ProjectError(`'${n}' is not an agent name (letters, digits, . _ -; or agent:<name>)`);
  return full;
}

/** A person's name as an author: `ana` and `human:ana` both give `human:ana`. */
export function humanName(name: string | undefined): string {
  const n = name ?? 'cli';
  const full = n.includes(':') ? n : `human:${n}`;
  if (!AUTHOR_RE.test(full) || !full.startsWith('human:')) throw new ProjectError(`'${n}' is not a person's name (letters, digits, . _ -; or human:<name>)`);
  return full;
}

/** Record that an agent was handed these requests (those still open and not seen by it yet). */
export function markSeen(w: Writer, ids: Iterable<string>, by: string): void {
  const reqs = readRequests(w.project);
  let wrote = false;
  for (const id of new Set(ids)) {
    const q = reqs.get(id);
    if (!q || q.state !== 'open' || q.seen.some((x) => x.by === by)) continue;
    appendRequest(w.project, { type: 'seen', id, by, at: w.stamp() });
    wrote = true;
  }
  if (wrote) w.requestsChanged();
}

/** The most seconds one await may wait (the CLI's and the HTTP endpoint's cap; MCP asks for less). */
export const MAX_AWAIT_S = 3600;

/**
 * Wait for what people did (a request, reply or cancel; an approval or rejection) after a cursor.
 * The requests it hands over are recorded as seen by `by`.
 */
export async function awaitRequests(w: Writer, o: { cursor?: string; timeoutS: number; by: string; via: 'cli' | 'mcp'; signal?: AbortSignal }): Promise<{ events: AgentEvent[]; cursor: string; timedOut: boolean }> {
  const timeoutMs = Math.max(0, Math.min(MAX_AWAIT_S, o.timeoutS)) * 1000;
  const r = await w.hub.wait({ cursor: o.cursor, initial: () => unseenOpen(readRequests(w.project)), timeoutMs, by: o.by, via: o.via, signal: o.signal });
  if (r.events.length) await w.enqueue(() => markSeen(w, r.events.filter((e) => (e.kind === 'request' || e.kind === 'reply') && e.id).map((e) => e.id!), o.by));
  return r;
}

/** The note added to listings when open requests have nobody waiting to take them (empty when an await is waiting or none is open). */
export function listenerNote(w: Writer): string {
  const open = [...readRequests(w.project).values()].filter((q) => q.state === 'open');
  const pr = w.hub.presence();
  if (!open.length || pr.waiters.length) return '';
  const them = open.length === 1 ? 'it' : 'them';
  return `${open.length} open request${open.length === 1 ? '' : 's'} and no agent is waiting for ${them}. Take ${them} with work, and keep \`soundclaw await <project>\` running in the background (or call await_requests) so people's next requests reach you.`;
}

/** The agent's side (the MCP `work` tool and `soundclaw work`). */
export type AgentWork =
  | { action: 'next'; id?: string }
  | { action: 'progress' | 'done' | 'blocked'; id?: string; text: string }
  | { action: 'list' };

/** The request this agent has claimed and not finished (the newest), if any. */
function mine(reqs: Map<string, WorkRequest>, agent: string): WorkRequest | undefined {
  return [...reqs.values()].filter((q) => q.state === 'claimed' && q.claimedBy === agent).at(-1);
}

export function agentWork(w: Writer, agent: string, q: AgentWork, steps: WorkSteps = MCP_STEPS): { request: WorkRequest | null; message: string } {
  const p = w.project;
  const reqs = readRequests(p);
  const at = w.stamp();
  w.hub.touch(agent);
  if (q.action === 'list') {
    markSeen(w, openRequests(reqs).filter((x) => x.state === 'open').map((x) => x.id), agent);
    return { request: null, message: '' };
  }
  if (q.action === 'next') {
    const held = q.id ? undefined : mine(reqs, agent);
    if (held) return { request: held, message: `you already have ${held.id}; finish it (done or blocked) before taking another` };
    const target = q.id ? reqs.get(q.id) : openRequests(reqs).find((x) => x.state === 'open');
    if (!target) return { request: null, message: q.id ? `no request ${q.id}` : 'no open requests' };
    return { request: appendRequest(p, { type: 'claim', id: target.id, by: agent, at }), message: `claimed ${target.id}` };
  }
  const id = q.id ?? mine(reqs, agent)?.id;
  if (!id) throw new ProjectError(`no claimed request to post ${q.action} on (give id)`);
  const target = reqs.get(id);
  if (q.action === 'done' && target && target.state === 'claimed' && target.claimedBy === agent && !w.has(target.sound)) {
    throw new ProjectError(`${id} is not done: sound '${target.sound}' no longer exists. Make it again, or ${steps.blocked(id)} if you cannot`);
  }
  const r = appendRequest(p, { type: q.action, id, by: agent, at, text: q.text });
  return { request: r, message: `${id}: ${q.action}` };
}

/** How an agent takes the next step on a request: the MCP `work` tool, or the CLI's `soundclaw work`. */
export interface WorkSteps {
  done(id: string, what: string): string;
  blocked(id: string): string;
  next: string;
}

export const MCP_STEPS: WorkSteps = {
  done: (_id, what) => `work(action="done", text=<${what}>)`,
  blocked: () => 'work(action="blocked", text=<one clear question>)',
  next: 'call work for the next',
};

/** A word for a shell command line, quoted when it needs to be. */
export function shellArg(s: string): string {
  return /^[A-Za-z0-9_./:@%+=,~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The steps as `soundclaw work` commands, for an agent with no MCP; `dir` is the project as the agent named it. */
export function cliSteps(dir: string): WorkSteps {
  const d = shellArg(dir);
  return {
    done: (id, what) => `\`soundclaw work ${d} done ${id} "<${what}>"\``,
    blocked: (id) => `\`soundclaw work ${d} block ${id} "<one clear question>"\``,
    next: `run \`soundclaw work ${d} claim\` for the next`,
  };
}

/** What a claimed request asks, with the sound as it stands and the next steps. */
export function requestBrief(w: Writer, q: WorkRequest, steps: WorkSteps = MCP_STEPS): string {
  const out = [requestLine(q)];
  if (w.has(q.sound)) out.push(`the sound now:\n${serializeSound(w.sound(q.sound)).trimEnd().split('\n').map((l) => `  ${l}`).join('\n')}`);
  else out.push(`sound '${q.sound}' does not exist any more`);
  out.push(`Change it as asked with \`sound set ${q.sound} …\` (the request is also a \`sound mark ${q.sound} rejected\` on the history${q.mark ? ` at #${q.mark}` : ''}; the history shows the person's own edits); then ${steps.done(q.id, 'what changed')}.`);
  if (q.events.some((x) => x.type === 'reply')) out.push(`The person answered: "${q.events.filter((x) => x.type === 'reply').at(-1)!.text}"`);
  out.push(`If you cannot go on without the person, ${steps.blocked(q.id)}.`);
  return out.join('\n');
}
