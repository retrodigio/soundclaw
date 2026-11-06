// The request records fold to states; a record that does not fit is refused.
import { describe, expect, it } from 'vitest';
import { foldRequests, nextRequestId, openRequests, requestProblem, type RequestRecord } from '../src/index.ts';

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
