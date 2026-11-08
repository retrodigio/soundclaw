// The request records fold to states; a record that does not fit is refused.
import { describe, expect, it } from 'vitest';
import { comparisonWords, foldRequests, nextRequestId, openRequests, requestProblem, type Comparison, type RequestRecord } from '../src/index.ts';

const at = '2026-11-06T10:00:00Z';
const req = (id: string, note = 'too harsh'): RequestRecord => ({ type: 'request', id, sound: 'beep', kind: 'change', note, by: 'human:ana', at });
const rec = (type: 'claim' | 'progress' | 'done' | 'blocked' | 'reply' | 'cancel' | 'seen', id: string, by = 'agent:claude', text?: string): RequestRecord => ({ type, id, by, at, ...(text ? { text } : {}) });

describe('requests', () => {
  it('follow open → claimed → blocked → open → claimed → done', () => {
    const { requests, problems } = foldRequests([
      req('r1'), rec('seen', 'r1'), rec('claim', 'r1'), rec('progress', 'r1', 'agent:claude', 'softening'), rec('blocked', 'r1', 'agent:claude', 'how soft?'),
      rec('reply', 'r1', 'human:ana', 'a lot'), rec('claim', 'r1'), rec('done', 'r1', 'agent:claude', 'volume down'),
    ]);
    expect(problems).toEqual([]);
    expect(requests.get('r1')).toMatchObject({ state: 'done', latest: 'volume down', claimedBy: 'agent:claude', question: null, seen: [] });
  });

  it('refuses records that do not fit, with a reason', () => {
    const { requests } = foldRequests([req('r1'), rec('claim', 'r1')]);
    const why = (r: RequestRecord) => requestProblem(requests, r);
    expect(why(rec('claim', 'r1', 'agent:other'))).toMatch(/agent:claude has it/);
    expect(why(rec('done', 'r1', 'agent:other', 'x'))).toMatch(/claim it before finishing/);
    expect(why(rec('done', 'r1', 'agent:claude'))).toMatch(/say what changed/);
    expect(why(rec('reply', 'r1', 'human:ana', 'x'))).toMatch(/only a blocked request takes a reply/);
    expect(why(rec('claim', 'r9'))).toMatch(/no request r9/);
    expect(why(req('r1'))).toMatch(/already exists/);
    expect(why(req('r2', '  '))).toMatch(/says what should change/);
    expect(why({ ...req('r2'), sound: 'Bad Name' })).toMatch(/names a sound/);
  });

  it('numbers requests and lists the unfinished ones, open first', () => {
    const { requests } = foldRequests([req('r1'), req('r2'), req('r3'), rec('claim', 'r1'), rec('cancel', 'r2')]);
    expect(nextRequestId(requests)).toBe('r4');
    expect(openRequests(requests).map((q) => [q.id, q.state])).toEqual([['r3', 'open'], ['r1', 'claimed']]);
  });
});

describe('comparison requests', () => {
  const cmp = (o: Record<string, unknown> = {}): RequestRecord => ({
    type: 'request', id: 'r1', sound: 'step_2', kind: 'comparison', note: 'A fits better', by: 'human:ana', at,
    comparison: { a: { sound: 'step_2', seq: 12 }, b: { sound: 'step_2', seq: 20 }, answer: 'a', moment: 'walking on grass at night', gains: { a: 1.2, b: -0.3 } },
    ...o,
  } as RequestRecord);

  it('fold like feedback: open, seen, claimed, done; the comparison is kept on the request', () => {
    const { requests, problems } = foldRequests([cmp(), rec('seen', 'r1'), rec('claim', 'r1'), rec('done', 'r1', 'agent:claude', 'noted: keeping the earlier step')]);
    expect(problems).toEqual([]);
    const q = requests.get('r1')!;
    expect(q).toMatchObject({ kind: 'comparison', state: 'done', sound: 'step_2' });
    expect(q.comparison).toEqual({ a: { sound: 'step_2', seq: 12 }, b: { sound: 'step_2', seq: 20 }, answer: 'a', moment: 'walking on grass at night', gains: { a: 1.2, b: -0.3 } });
    expect(comparisonWords(q.comparison!)).toBe('A fits better in "walking on grass at night": A was step_2 as at #12 (gain +1.2 dB), B was step_2 as at #20 (gain −0.3 dB)');
  });

  it('are refused when a field does not fit', () => {
    const why = (r: RequestRecord) => requestProblem(new Map(), r);
    const c = (cmp() as { comparison: Comparison }).comparison;
    expect(why(cmp())).toBeNull();
    expect(why(cmp({ comparison: { ...c, moment: undefined } }))).toBeNull();
    expect(why(cmp({ comparison: undefined }))).toMatch(/carries the comparison/);
    expect(why(cmp({ comparison: { ...c, answer: 'maybe' } }))).toMatch(/answer is a, b, both, neither/);
    expect(why(cmp({ comparison: { ...c, b: { sound: 'step_2', seq: 12 } } }))).toMatch(/two different versions/);
    expect(why(cmp({ comparison: { ...c, a: { sound: 'step_2', seq: 0 } } }))).toMatch(/tape number/);
    expect(why(cmp({ comparison: { ...c, a: { sound: 'no good', seq: 3 } } }))).toMatch(/a names a sound/);
    expect(why(cmp({ comparison: { ...c, gains: { a: 1, b: 'x' } } }))).toMatch(/gain applied to each side/);
    expect(why(cmp({ comparison: { ...c, gains: { a: 99, b: 0 } } }))).toMatch(/gain applied to each side/);
    expect(why(cmp({ comparison: { ...c, moment: '  ' } }))).toMatch(/moment is text/);
    expect(why(cmp({ sound: 'other' }))).toMatch(/names one of the two sounds/);
    expect(why(cmp({ tags: ['good'] }))).toMatch(/no tags/);
    expect(why({ ...req('r1'), comparison: c } as RequestRecord)).toMatch(/only a comparison request carries a comparison/);
    // a sound id with capitals is a sound (ids keep their case)
    expect(why(cmp({ sound: 'Step_A', comparison: { ...c, a: { sound: 'Step_A', seq: 3 }, b: { sound: 'Step_B', seq: 4 } } }))).toBeNull();
  });

  it('say the answer in words without a moment', () => {
    expect(comparisonWords({ a: { sound: 'x', seq: 1 }, b: { sound: 'y', seq: 2 }, answer: 'neither', gains: { a: 0, b: 2 } })).toBe('Neither would do (no moment given): A was x as at #1 (gain ±0.0 dB), B was y as at #2 (gain +2.0 dB)');
  });
});
