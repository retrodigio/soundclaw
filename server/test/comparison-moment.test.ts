// A person's blind A/B answer reaches the agent: the dashboard's `compare` is recorded as a comparison
// request (no mark on the sounds), is handed over by await in words with the moment and the gains, reads
// as one line in the listings, and the agent closes it like feedback. The moment is shown wherever the
// agent reads a sound: describe, its JSON, the run summary and a change request's brief.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentWork, awaitRequests, describeJson, describeText, formatEvents, personRequest, readRequests, requestBrief, requestLine, setSummary, soundSummary } from '../src/index.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
const claude = 'agent:claude';
const MOMENT = 'The player walks slowly across a meadow at night; steps repeat every 0.4 s';
beforeEach(() => {
  f = fixture();
  f.w.run({ commands: 'sound new step voice=layered preset=footstep seed=4\nset new steps from=step count=2 seed=1', by: claude });
  f.w.run({ commands: 'layer set steps_1 1 gain=0.8', by: claude });
});
afterEach(() => f.clean());

const seqs = () => f.w.tape().map((e) => e.seq);
const compare = (answer: 'a' | 'b' | 'both' | 'neither', moment?: string) => personRequest(f.w, 'human:ana', {
  action: 'compare', a: { sound: 'steps_1', seq: 2 }, b: { sound: 'steps_1', seq: seqs().at(-1)! }, answer, ...(moment ? { moment } : {}), gains: { a: 1.25, b: -0.3 },
});

describe('the comparison request', () => {
  it('is recorded with its sides, answer, moment and gains, and marks nothing', () => {
    const tape = f.w.tape().length;
    const q = compare('a', MOMENT);
    expect(q).toMatchObject({ id: 'r1', kind: 'comparison', sound: 'steps_1', note: 'A fits better', state: 'open', by: 'human:ana' });
    expect(q.comparison).toEqual({ a: { sound: 'steps_1', seq: 2 }, b: { sound: 'steps_1', seq: seqs().at(-1) }, answer: 'a', moment: MOMENT, gains: { a: 1.25, b: -0.3 } });
    expect(f.w.tape()).toHaveLength(tape);
    expect(f.w.sound('steps_1').status).toBe('draft');
    expect(requestLine(q)).toMatch(new RegExp(`^r1 comparison steps_1: A fits better in "${MOMENT}": A was steps_1 as at #2 \\(gain \\+1\\.3 dB\\), B was steps_1 as at #\\d+ \\(gain −0\\.3 dB\\) \\(from human:ana at \\S+; open\\)$`));
  });

  it('is refused for a sound or a tape entry that does not exist, or a bad answer', () => {
    expect(() => personRequest(f.w, 'human:ana', { action: 'compare', a: { sound: 'nope', seq: 1 }, b: { sound: 'steps_1', seq: 2 }, answer: 'a', gains: { a: 0, b: 0 } })).toThrow(/no sound 'nope'/);
    expect(() => personRequest(f.w, 'human:ana', { action: 'compare', a: { sound: 'steps_1', seq: 999 }, b: { sound: 'steps_1', seq: 2 }, answer: 'a', gains: { a: 0, b: 0 } })).toThrow(/no entry #999/);
    expect(() => personRequest(f.w, 'human:ana', { action: 'compare', a: { sound: 'steps_1', seq: 1 }, b: { sound: 'steps_1', seq: 2 }, answer: 'x' as 'a', gains: { a: 0, b: 0 } })).toThrow(/answer is a, b, both, neither/);
    expect(readRequests(f.w.project).size).toBe(0);
  });

  it('arrives through await in words with the moment, and the agent closes it with done (no checks needed)', async () => {
    const waiting = awaitRequests(f.w, { timeoutS: 5, by: claude, via: 'cli' });
    await new Promise((r) => setTimeout(r, 20));
    compare('neither', MOMENT);
    f.w.requestsChanged();
    const r = await waiting;
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ kind: 'comparison', id: 'r1', sound: 'steps_1', by: 'human:ana' });
    const text = formatEvents(r.events, r.cursor, { cli: 'demo.sclaw' });
    expect(text).toContain(`comparison r1 (steps_1) from human:ana`);
    expect(text).toContain(`Neither would do in "${MOMENT}": A was steps_1 as at #2 (gain +1.3 dB), B was steps_1 as at #`);
    expect(text).toContain('close it with done: nothing is asked to change');
    expect(readRequests(f.w.project).get('r1')!.seen.map((x) => x.by)).toEqual([claude]);
    // the agent claims it, reads the brief and closes it, even with a failing check
    const c = agentWork(f.w, claude, { action: 'next' });
    expect(c.message).toBe('claimed r1');
    const brief = requestBrief(f.w, c.request!);
    expect(brief).toContain('This is a judgment, not a change request');
    expect(brief).toContain(`moment "${MOMENT}"`);
    expect(brief).toContain('Neither fits this moment');
    agentWork(f.w, claude, { action: 'done', text: 'noted: both steps too bright for a night meadow' });
    expect(readRequests(f.w.project).get('r1')).toMatchObject({ state: 'done', latest: 'noted: both steps too bright for a night meadow' });
  });

  it('an open comparison found with no cursor is a comparison event too', async () => {
    compare('both');
    const r = await awaitRequests(f.w, { timeoutS: 1, by: claude, via: 'mcp' });
    expect(r.events[0]).toMatchObject({ kind: 'comparison', note: 'Both would do' });
    expect(formatEvents(r.events, r.cursor)).toContain('Both would do (no moment given)');
  });
});

describe('the moment in what the agent reads', () => {
  it('describe, its JSON, the run summary and a set summary show it; a member falls back to its set\'s', () => {
    f.w.run({ commands: `sound set step moment="${MOMENT}"\nset moment steps "walking on grass"`, by: claude });
    expect(describeText(f.w, 'step').split('\n')[1]).toBe(`moment: "${MOMENT}"`);
    expect(JSON.parse(describeJson(f.w, 'step')).moment).toEqual({ text: MOMENT, set: null });
    expect(describeText(f.w, 'steps_2').split('\n')[1]).toBe('moment (of set steps): "walking on grass"');
    expect(soundSummary(f.w, 'step')).toContain(`\n    moment: "${MOMENT}"`);
    expect(setSummary(f.w, 'steps')).toContain(', moment "walking on grass"');
    // a sound with none says nothing about it
    f.w.run({ commands: 'set moment steps none', by: claude });
    expect(describeText(f.w, 'steps_2')).not.toContain('moment');
    expect(JSON.parse(describeJson(f.w, 'steps_2')).moment).toBeNull();
  });

  it('a change request\'s brief carries the moment', () => {
    f.w.run({ commands: `sound set steps_1 moment="${MOMENT}"`, by: claude });
    personRequest(f.w, 'human:ana', { action: 'request', kind: 'change', sound: 'steps_1', note: 'softer' });
    const c = agentWork(f.w, claude, { action: 'next' });
    expect(requestBrief(f.w, c.request!)).toContain(`moment: "${MOMENT}" (the situation in the game it is for`);
  });
});
