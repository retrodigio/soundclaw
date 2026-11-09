// A change request's target: validated, printed in words, read from text, and the review decisions a done request takes.
import { describe, expect, it } from 'vitest';
import { foldRequests, parseRequestTarget, requestProblem, targetProblem, targetWords, type RequestRecord, type RequestTarget } from '../src/index.ts';

const at = '2026-11-06T10:00:00Z';
const req = (id: string, extra: Partial<Extract<RequestRecord, { type: 'request' }>> = {}): RequestRecord => ({ type: 'request', id, sound: 'beep', kind: 'change', note: 'shorter', by: 'human:ana', at, ...extra });
const step = (type: 'claim' | 'done' | 'reviewed', id: string, by: string, text?: string): RequestRecord => ({ type, id, by, at, ...(text ? { text } : {}) } as RequestRecord);

describe('a request target', () => {
  it('is checked by kind and fields', () => {
    const ok: RequestTarget[] = [{ kind: 'range', start: 0.31, end: 0.38 }, { kind: 'bars', from: 9, to: 12, channel: 'lead' }, { kind: 'bars', from: 3, to: 3 }, { kind: 'param', param: 'decay' }, { kind: 'param', param: 'cutoff', layer: 2, fx: 1 }, { kind: 'layer', layer: 3 }, { kind: 'item' }];
    for (const t of ok) expect(targetProblem(t)).toBeNull();
    const bad: [unknown, RegExp][] = [
      [null, /object with a kind/], [{ kind: 'what' }, /kind is/], [{ kind: 'range', start: 0.5, end: 0.2 }, /ends after it starts/], [{ kind: 'range', start: -1, end: 2 }, /start and end/],
      [{ kind: 'range', start: 0, end: 1, extra: 1 }, /no 'extra'/], [{ kind: 'bars', from: 0, to: 2 }, /bar numbers/], [{ kind: 'bars', from: 5, to: 2 }, /at or after/], [{ kind: 'bars', from: 1, to: 2, channel: 'a b' }, /channel/],
      [{ kind: 'param', param: '' }, /names the parameter/], [{ kind: 'param', param: 'decay', layer: 0 }, /layer/], [{ kind: 'param', param: 'decay', fx: 1.5 }, /fx/], [{ kind: 'layer' }, /gives the layer/], [{ kind: 'item', layer: 1 }, /no 'layer'/],
    ];
    for (const [t, why] of bad) expect(targetProblem(t)).toMatch(why);
  });

  it('reads in words', () => {
    expect(targetWords({ kind: 'range', start: 0.31, end: 0.38 })).toBe('pinned to 0.31–0.38 s');
    expect(targetWords({ kind: 'bars', from: 9, to: 12, channel: 'lead' })).toBe('bars 9–12 of lead');
    expect(targetWords({ kind: 'bars', from: 4, to: 4 })).toBe('bar 4');
    expect(targetWords({ kind: 'param', param: 'decay' })).toBe('parameter decay');
    expect(targetWords({ kind: 'param', param: 'cutoff', layer: 2, fx: 1 })).toBe('parameter cutoff of effect 1 on layer 2');
    expect(targetWords({ kind: 'layer', layer: 2 })).toBe('layer 2');
    expect(targetWords({ kind: 'item' })).toBe('the item as a whole');
  });

  it('is read from text', () => {
    expect(parseRequestTarget('range 0.31-0.38')).toEqual({ kind: 'range', start: 0.31, end: 0.38 });
    expect(parseRequestTarget('range 0.31 - 0.38 s')).toEqual({ kind: 'range', start: 0.31, end: 0.38 });
    expect(parseRequestTarget('bars 9-12 lead')).toEqual({ kind: 'bars', from: 9, to: 12, channel: 'lead' });
    expect(parseRequestTarget('bars 4')).toEqual({ kind: 'bars', from: 4, to: 4 });
    expect(parseRequestTarget('param low pass cutoff layer 2 fx 1')).toEqual({ kind: 'param', param: 'low pass cutoff', layer: 2, fx: 1 });
    expect(parseRequestTarget('layer 2')).toEqual({ kind: 'layer', layer: 2 });
    expect(parseRequestTarget('item')).toEqual({ kind: 'item' });
    expect(() => parseRequestTarget('somewhere')).toThrow(/range <start>-<end>/);
    expect(() => parseRequestTarget('range 2-1')).toThrow(/ends after/);
    expect(() => parseRequestTarget('param decay layer')).toThrow(/layer is a number/);
  });

  it('rides on a change request and is refused elsewhere', () => {
    const { requests, problems } = foldRequests([req('r1', { target: { kind: 'range', start: 0.1, end: 0.2 } })]);
    expect(problems).toEqual([]);
    expect(requests.get('r1')!.target).toEqual({ kind: 'range', start: 0.1, end: 0.2 });
    expect(requestProblem(requests, req('r2', { target: { kind: 'range', start: 3, end: 2 } }))).toMatch(/ends after/);
    expect(requestProblem(requests, req('r2', { kind: 'feedback', note: 'nice', tags: ['good'], target: { kind: 'item' } }))).toMatch(/only a change request carries a target/);
  });
});

describe('deciding on a done request', () => {
  const done = [req('r1'), step('claim', 'r1', 'agent:claude'), step('done', 'r1', 'agent:claude', 'shortened')];
  it('is approved or reverted once', () => {
    const { requests, problems } = foldRequests([...done, step('reviewed', 'r1', 'human:ana', 'approved')]);
    expect(problems).toEqual([]);
    expect(requests.get('r1')).toMatchObject({ state: 'done', reviewed: { by: 'human:ana', how: 'approved' } });
    expect(requestProblem(requests, step('reviewed', 'r1', 'human:ana', 'reverted'))).toMatch(/already approved/);
    expect(requestProblem(foldRequests(done.slice(0, 2)).requests, step('reviewed', 'r1', 'human:ana', 'approved'))).toMatch(/only a done request/);
  });
  it('is asked again by a new request that names it', () => {
    const { requests, problems } = foldRequests([...done, req('r2', { again: 'r1', note: 'shorter still' })]);
    expect(problems).toEqual([]);
    expect(requests.get('r2')!.again).toBe('r1');
    expect(requests.get('r1')!.reviewed).toMatchObject({ how: 'asked again', by: 'human:ana' });
    expect(requestProblem(foldRequests(done.slice(0, 1)).requests, req('r2', { again: 'r1' }))).toMatch(/only a done request is asked again/);
    expect(requestProblem(requests, req('r3', { again: 'r9' }))).toMatch(/no request r9/);
  });
  it('gives the decision back: undone, or the asking-again request withdrawn', () => {
    const a = foldRequests([...done, step('reviewed', 'r1', 'human:ana', 'approved'), step('reviewed', 'r1', 'human:ana', 'undone')]);
    expect(a.problems).toEqual([]);
    expect(a.requests.get('r1')!.reviewed).toBeUndefined();
    expect(requestProblem(a.requests, step('reviewed', 'r1', 'human:ana', 'undone'))).toMatch(/no decision to take back/);
    const b = foldRequests([...done, req('r2', { again: 'r1' }), { type: 'cancel', id: 'r2', by: 'human:ana', at }]);
    expect(b.requests.get('r1')!.reviewed).toBeUndefined();
  });
});
