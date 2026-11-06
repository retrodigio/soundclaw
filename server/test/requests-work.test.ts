// The request queue end to end on a Writer: a person asks for changes (which also marks the sound
// rejected on the history), the agent is handed it (seen), claims it, posts progress, is blocked,
// is answered, finishes. Every record is checked before it is written.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cliSteps, agentWork, agentName, humanName, awaitRequests, listenerNote, markSeen, personRequest, readRequests, requestBrief, requestLine, toPersonRequest } from '../src/index.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
const claude = 'agent:claude';
beforeEach(() => {
  f = fixture();
  f.w.run({ commands: 'sound new beep; sound set beep frequency=880', by: claude });
});
afterEach(() => f.clean());

const ask = (note = 'too harsh', sound = 'beep', by = 'human:ana') => personRequest(f.w, by, { action: 'request', kind: 'change', sound, note });
const records = () => readFileSync(join(f.dir, 'requests.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string; id: string });

describe('Ask for changes', () => {
  it('files the request and marks the sound rejected on the history by the same person', () => {
    const q = ask('too harsh; "softer" please');
    expect(q).toMatchObject({ id: 'r1', sound: 'beep', state: 'open', by: 'human:ana', mark: 3 });
    expect(f.w.tape().at(-1)).toMatchObject({ seq: 3, by: 'human:ana', cmd: 'sound mark beep rejected "too harsh; \\"softer\\" please"' });
    expect(f.w.sound('beep').status).toBe('rejected');
    expect(requestLine(q)).toMatch(/^r1 change beep: "too harsh; "softer" please" \(from human:ana at \S+; open\)$/);
  });
  it('refuses an empty note, an unknown sound, and writes nothing', () => {
    expect(() => ask('  ')).toThrow(/say what should change/);
    expect(() => ask('x', 'nope')).toThrow(/no sound 'nope'/);
    expect(f.w.tape()).toHaveLength(2);
    expect(readRequests(f.w.project).size).toBe(0);
  });
});

describe('the agent\'s side', () => {
  it('list hands requests over (seen); claim, progress, blocked, a reply, claim, done', () => {
    ask('softer');
    agentWork(f.w, claude, { action: 'list' });
    expect(readRequests(f.w.project).get('r1')!.seen.map((s) => s.by)).toEqual([claude]);
    expect(requestLine(readRequests(f.w.project).get('r1')!)).toContain(`seen by ${claude}`);
    const c = agentWork(f.w, claude, { action: 'next' });
    expect(c).toMatchObject({ message: 'claimed r1', request: { state: 'claimed', claimedBy: claude } });
    expect(agentWork(f.w, claude, { action: 'next' }).message).toMatch(/already have r1/);
    agentWork(f.w, claude, { action: 'progress', text: 'lowering the volume' });
    agentWork(f.w, claude, { action: 'blocked', text: 'how much softer?' });
    expect(readRequests(f.w.project).get('r1')).toMatchObject({ state: 'blocked', question: 'how much softer?' });
    personRequest(f.w, 'human:ana', { action: 'reply', id: 'r1', text: 'half' });
    expect(readRequests(f.w.project).get('r1')).toMatchObject({ state: 'open', seen: [] });
    agentWork(f.w, claude, { action: 'next', id: 'r1' });
    f.w.run({ commands: 'sound set beep volume=0.25', by: claude });
    const d = agentWork(f.w, claude, { action: 'done', text: 'volume 0.5 → 0.25' });
    expect(d.request).toMatchObject({ state: 'done', latest: 'volume 0.5 → 0.25' });
    expect(records().map((r) => r.type)).toEqual(['request', 'seen', 'claim', 'progress', 'blocked', 'reply', 'claim', 'done']);
  });

  it('refuses a record that does not fit and writes nothing', () => {
    ask();
    const n = records().length;
    expect(() => agentWork(f.w, claude, { action: 'done', id: 'r1', text: 'x' })).toThrow(/claim it before finishing/);
    expect(() => agentWork(f.w, claude, { action: 'progress', text: 'x' })).toThrow(/no claimed request/);
    agentWork(f.w, claude, { action: 'next' });
    expect(() => agentWork(f.w, 'agent:other', { action: 'done', id: 'r1', text: 'x' })).toThrow(/claim it before finishing/);
    expect(() => agentWork(f.w, claude, { action: 'done', text: '' })).toThrow(/say what changed/);
    expect(records()).toHaveLength(n + 1);
  });

  it('done is refused when the sound was removed', () => {
    ask();
    agentWork(f.w, claude, { action: 'next' });
    f.w.run({ commands: 'undo group=g1', by: claude }); // refused: a later group depends on it
    f.w.run({ commands: 'undo', by: claude });
    f.w.run({ commands: 'undo', by: claude });
    f.w.run({ commands: 'undo', by: claude });
    expect(f.w.has('beep')).toBe(false);
    expect(() => agentWork(f.w, claude, { action: 'done', text: 'x' })).toThrow(/no longer exists/);
  });

  it('a brief shows the sound and the next steps, as MCP tools or as CLI commands', () => {
    const q = ask('softer');
    const mcp = requestBrief(f.w, q);
    expect(mcp).toContain('frequency 880');
    expect(mcp).toContain('sound mark beep rejected');
    expect(mcp).toContain('work(action="done"');
    expect(requestBrief(f.w, q, cliSteps('my proj'))).toContain("soundclaw work 'my proj' done r1");
  });
});

describe('cancel, shapes and names', () => {
  it('a person withdraws a request; a finished one cannot be', () => {
    ask();
    expect(personRequest(f.w, 'human:ana', { action: 'cancel', id: 'r1', text: 'never mind' })).toMatchObject({ state: 'cancelled' });
    expect(() => personRequest(f.w, 'human:ana', { action: 'cancel', id: 'r1' })).toThrow(/already finished/);
  });
  it('checks the shape of CLI and MCP arguments', () => {
    expect(() => toPersonRequest({ action: 'reply', id: 'r1' })).toThrow(/give the answer/);
    expect(() => toPersonRequest({ action: 'cancel', id: 'x' })).toThrow(/like r3/);
    expect(() => toPersonRequest({ action: 'frob' })).toThrow(/unknown action/);
    expect(() => toPersonRequest({})).toThrow(/give the sound/);
    expect(toPersonRequest({ sound: 'beep', note: 'n' })).toEqual({ action: 'request', kind: 'change', sound: 'beep', note: 'n' });
  });
  it('names: bare names get their prefix, and the wrong kind is refused', () => {
    expect(agentName('claude')).toBe('agent:claude');
    expect(agentName(undefined)).toBe('agent:claude');
    expect(humanName('ana')).toBe('human:ana');
    expect(() => agentName('human:ana')).toThrow(/not an agent name/);
    expect(() => humanName('bad name')).toThrow(/not a person's name/);
  });
});

describe('await on a writer', () => {
  it('hands over an open request once, as seen; a request filed while waiting wakes it', async () => {
    ask('first');
    f.w.requestsChanged();
    const a = await awaitRequests(f.w, { timeoutS: 1, by: claude, via: 'cli' });
    expect(a.events.map((e) => e.id)).toEqual(['r1']);
    expect(readRequests(f.w.project).get('r1')!.seen).toHaveLength(1);
    const waiting = awaitRequests(f.w, { cursor: a.cursor, timeoutS: 5, by: claude, via: 'cli' });
    await new Promise((r) => setTimeout(r, 30));
    expect(f.w.hub.presence().waiters).toHaveLength(1);
    expect(listenerNote(f.w)).toBe('');
    await f.w.enqueue(() => { ask('second'); f.w.requestsChanged(); });
    const b = await waiting;
    expect(b.events.map((e) => [e.kind, e.id, e.sound, e.note])).toEqual([['request', 'r2', 'beep', 'second']]);
    markSeen(f.w, ['r2'], claude);
    expect(readRequests(f.w.project).get('r2')!.seen).toHaveLength(1);
  });
  it('says plainly when open requests have no listener', () => {
    ask();
    expect(listenerNote(f.w)).toMatch(/1 open request and no agent is waiting for it/);
  });
});
