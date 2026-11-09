// Requests from the dashboard: requests.jsonl in the project, one record a line, only ever
// appended. People open requests (Ask for changes), answer a blocked one or withdraw one; the
// agent claims, posts progress and finishes them through the MCP `work` tool or `soundclaw work`.
// Every record is checked against the state the file is in before it is written (core's state
// machine), so the file only holds records that fit.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ANSWER_WORDS, AUTHOR_RE, parseRequestTarget, targetAdvice, targetProblem, targetWords, type RequestTarget, SIMILAR_TAG, comparisonProblem, comparisonWords, foldRequests, momentLine, momentOf, tagsNote, isFeedbackTag, nextRequestId, openRequests, quote, requestProblem, serializeSound, songText, type RequestRecord, type WorkRequest } from '@soundclaw/core';
import { unseenOpen, type AgentEvent } from './await.ts';
import { checkLine, failingChecks } from './ears.ts';
import { songCheckLine, songFailing } from './songs.ts';
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
  if (q.action === 'compare') return personComparison(w, by, q);
  if (q.action === 'reviewed') return appendRequest(p, { type: 'reviewed', id: q.id, by, at, text: q.how });
  const reqs = readRequests(p);
  const id = nextRequestId(reqs);
  const text = (q.note ?? '').trim();
  const tags = [...new Set(q.tags ?? [])];
  for (const t of tags) if (!isFeedbackTag(t)) throw new ProjectError(`no tag '${t}' (a sound: too loud, too quiet, too long, too short, too harsh, too dull, too similar to another sound, good; a song: too busy, too sparse, too loud, too repetitive, wrong mood, good)`);
  if (!w.hasSong(q.sound)) w.sound(q.sound); // throws when there is no such sound or song
  if (q.other !== undefined) {
    if (!tags.includes(SIMILAR_TAG)) throw new ProjectError(`other names the sound a '${SIMILAR_TAG}' tag points at`);
    if (!w.has(q.other)) throw new ProjectError(`no sound '${q.other}' to compare with`);
    if (q.other === q.sound) throw new ProjectError('a sound is not similar to itself: name another');
  }
  const note = text || tagsNote(tags, q.other);
  if (!note) throw new ProjectError('say what should change, or pick a tag');
  if (q.target !== undefined) checkTarget(w, q.sound, q.target);
  // Praise alone is feedback: nothing to change, so the sound is not marked.
  const kind = tags.length && tags.every((t) => t === 'good') ? 'feedback' : 'change';
  const rec: RequestRecord = { type: 'request', id, sound: q.sound, kind, note, ...(tags.length ? { tags } : {}), ...(q.other ? { other: q.other } : {}), ...(q.target ? { target: q.target } : {}), ...(q.again ? { again: q.again } : {}), by, at };
  const problem = requestProblem(reqs, rec);
  if (problem) throw new ProjectError(problem);
  if (kind === 'feedback') return appendRequest(p, rec);
  const markNote = [tags.length && text ? `[${tags.join(', ')}]` : '', note].filter(Boolean).join(' ');
  const r = w.hub.withoutMarkEvents(() => w.run({ commands: `${w.hasSong(q.sound) ? 'song' : 'sound'} mark ${q.sound} rejected ${quote(markNote)}`, by }));
  if (!r.ok) throw new ProjectError(r.errors.map((e) => e.message).join('; '));
  return appendRequest(p, { ...rec, mark: r.added.at(-1)?.seq });
}

/** A target must fit the item it is on: time and layers belong to a sound, bars to a song. */
function checkTarget(w: Writer, sound: string, t: RequestTarget): void {
  const bad = targetProblem(t);
  if (bad) throw new ProjectError(bad);
  const song = w.hasSong(sound);
  if (t.kind === 'bars' && !song) throw new ProjectError(`${sound} is a sound: bars are for a song (pin a stretch of a sound with a range)`);
  if (t.kind === 'range' && song) throw new ProjectError(`${sound} is a song: pin bars of it, not seconds`);
  if (t.kind === 'bars' && t.channel && !w.song(sound).channels.some((c) => c.name === t.channel)) throw new ProjectError(`song ${sound} has no channel '${t.channel}'`);
  if (t.kind === 'layer' || (t.kind === 'param' && t.layer !== undefined)) {
    const layer = t.kind === 'layer' ? t.layer : t.layer!;
    const doc = song ? null : w.sound(sound);
    if (!doc || doc.voice !== 'layered') throw new ProjectError(`${sound} has no layers to point at`);
    if (layer > doc.layers.length) throw new ProjectError(`${sound} has ${doc.layers.length} layer${doc.layers.length === 1 ? '' : 's'}, not ${layer}`);
  }
}

/**
 * A person's blind A/B answer, recorded as a `comparison` request: nothing is marked on the sounds (it is a judgment, like praise).
 * Both sides must be sounds of the project at a tape entry that exists; the request names the sound both sides are of, else A's.
 */
function personComparison(w: Writer, by: string, q: Extract<PersonRequest, { action: 'compare' }>): WorkRequest {
  const p = w.project;
  const moment = typeof q.moment === 'string' && q.moment.trim() ? q.moment.trim() : undefined;
  const comparison = { a: { sound: q.a?.sound, seq: q.a?.seq }, b: { sound: q.b?.sound, seq: q.b?.seq }, answer: q.answer, ...(moment ? { moment } : {}), gains: { a: q.gains?.a, b: q.gains?.b } };
  const problem = comparisonProblem(comparison);
  if (problem) throw new ProjectError(problem);
  const total = w.tape().at(-1)?.seq ?? 0;
  for (const side of [comparison.a, comparison.b]) {
    if (!w.has(side.sound!)) throw new ProjectError(`no sound '${side.sound}' to compare`);
    if (side.seq! > total) throw new ProjectError(`the tape has no entry #${side.seq} (it ends at #${total})`);
  }
  const reqs = readRequests(p);
  const c = comparison as import('@soundclaw/core').Comparison;
  const rec: RequestRecord = { type: 'request', id: nextRequestId(reqs), sound: c.a.sound, kind: 'comparison', note: ANSWER_WORDS[c.answer], comparison: c, by, at: w.stamp() };
  return appendRequest(p, rec);
}

/** A request as one line: `r3 change beep: "softer" (from human:ana at …; claimed by agent:claude)`. */
export function requestLine(q: WorkRequest): string {
  // An open request an agent was handed reads as the dashboard's card does: "seen by agent:claude".
  const state = q.state === 'claimed' ? `claimed by ${q.claimedBy}` : q.state === 'blocked' ? `blocked: "${q.question}"`
    : q.state === 'open' && q.seen.length ? `seen by ${q.seen.map((x) => x.by).join(', ')}` : q.state;
  if (q.comparison) return `${q.id} comparison ${q.sound}: ${comparisonWords(q.comparison)} (from ${q.by} at ${q.at}; ${state})`;
  return `${q.id} ${q.kind} ${q.sound}${q.tags.length ? ` [${q.tags.join(', ')}]` : ''}${q.note && q.note !== tagsNote(q.tags, q.other) ? `: "${q.note}"` : ''}${q.other ? ` (like ${q.other})` : ''}${q.target ? ` — ${targetWords(q.target)}` : ''}${q.again ? ` (asks again about ${q.again})` : ''} (from ${q.by} at ${q.at}; ${state}${q.reviewed ? `; ${q.reviewed.how} by ${q.reviewed.by}` : ''})`;
}

/** A request, reply or cancel from the CLI or MCP as the dashboard's message. Checked here for shape; personRequest checks it against the project. */
export function toPersonRequest(a: { action?: string; sound?: string; note?: string; id?: string; text?: string; tags?: string[]; other?: string; target?: unknown; again?: string }): PersonRequest {
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
  let target: RequestTarget | undefined;
  if (a.target !== undefined && a.target !== null && a.target !== '') {
    try {
      target = typeof a.target === 'string' ? parseRequestTarget(a.target) : (a.target as RequestTarget);
    } catch (e) {
      throw new ProjectError((e as Error).message);
    }
    const bad = targetProblem(target);
    if (bad) throw new ProjectError(bad);
  }
  return { action, kind: 'change', sound: a.sound, note: a.note ?? '', ...(a.tags?.length ? { tags: a.tags } : {}), ...(a.other ? { other: a.other } : {}), ...(target ? { target } : {}), ...(a.again ? { again: a.again } : {}) };
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
  if (r.events.length) await w.enqueue(() => markSeen(w, r.events.filter((e) => (e.kind === 'request' || e.kind === 'comparison' || e.kind === 'reply') && e.id).map((e) => e.id!), o.by));
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
  if (q.action === 'done' && target && target.state === 'claimed' && target.claimedBy === agent && !w.has(target.sound) && !w.hasSong(target.sound)) {
    throw new ProjectError(`${id} is not done: sound '${target.sound}' no longer exists. Make it again, or ${steps.blocked(id)} if you cannot`);
  }
  // done needs the sound's checks to pass: the person is handed something measured, not just claimed
  if (q.action === 'done' && target && target.kind === 'change' && target.state === 'claimed' && target.claimedBy === agent && (w.has(target.sound) || w.hasSong(target.sound))) {
    const failing = w.hasSong(target.sound) ? songFailing(w, target.sound) : failingChecks(w, target.sound);
    if (failing) throw new ProjectError(`${id} is not done: ${target.sound}'s checks fail (${failing}). Fix it (see \`check\`), or ${steps.blocked(id)} if you cannot`);
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
  if (w.hasSong(q.sound)) out.push(`the song now:\n${songText(w.song(q.sound)).trimEnd().split('\n').map((l) => `  ${l}`).join('\n')}`);
  else if (w.has(q.sound)) out.push(`the sound now:\n${serializeSound(w.sound(q.sound)).trimEnd().split('\n').map((l) => `  ${l}`).join('\n')}`);
  else out.push(`sound '${q.sound}' does not exist any more`);
  const moment = w.has(q.sound) ? momentOf(w.sound(q.sound), w.sets()) : null;
  if (moment && !q.comparison) out.push(`${momentLine(moment)} (the situation in the game it is for: judge the change against it)`);
  if (q.kind === 'feedback') {
    out.push(`This is praise (tag good): nothing needs to change. Close it with ${steps.done(q.id, 'a short acknowledgement')}.`);
    return out.join('\n');
  }
  if (q.comparison) {
    const c = q.comparison;
    out.push(`This is a judgment, not a change request: the person heard A and B blind, level-matched (the gains above), ${c.moment ? `and judged which fits better in the moment "${c.moment}"` : 'with no moment given (add one with sound set <id> moment="…" so the next comparison means something)'}.`);
    out.push(`Read A and B as they were with \`history --sound ${c.a.sound}\`${c.b.sound !== c.a.sound ? ` and \`history --sound ${c.b.sound}\`` : ''} (#${c.a.seq} and #${c.b.seq} are the tape entries the versions stood at). ${c.answer === 'a' || c.answer === 'b' ? `Keep the direction of ${c.answer.toUpperCase()} in what you make next; the loudness gain was matched, so the preference is not about level.` : c.answer === 'both' ? 'Either version fits: the difference between them does not matter in this moment.' : 'Neither fits this moment: the next version should move away from both.'}`);
    out.push(`Nothing needs to change because of it on its own. Close it with ${steps.done(q.id, 'what you take from it')}.`);
    return out.join('\n');
  }
  if (q.target) out.push(targetAdvice(q.target));
  if (q.again) out.push(`This asks again about ${q.again}, which you finished and the person looked at: what you did was not enough or not right. Read it with \`history --sound ${q.sound}\` and go on from there.`);
  if (q.other) out.push(`The person finds it too like ${q.other}: \`view ${q.sound} compare ${q.other}\` shows how close they are.`);
  if (w.hasSong(q.sound)) out.push(`${songCheckLine(w.measureSong(q.sound).report.checks)} (finishing the request needs every check to pass except the advisory ones (masking); \`check\` lists what fails and where, \`view ${q.sound} notes\` and \`view ${q.sound} mix\` show what the render does)`);
  else if (w.has(q.sound)) out.push(`${checkLine(w.measure(q.sound))} (finishing the request needs every check to pass; \`check\` lists what fails and where, \`view\` and \`describe\` let you hear the change)`);
  out.push(`Change it as asked with \`sound set ${q.sound} …\` (the request is also a \`sound mark ${q.sound} rejected\` on the history${q.mark ? ` at #${q.mark}` : ''}; the history shows the person's own edits); then ${steps.done(q.id, 'what changed')}.`);
  if (q.events.some((x) => x.type === 'reply')) out.push(`The person answered: "${q.events.filter((x) => x.type === 'reply').at(-1)!.text}"`);
  out.push(`If you cannot go on without the person, ${steps.blocked(q.id)}.`);
  return out.join('\n');
}
