// The event cursor and presence (await.ts), the token file (runfile.ts).
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foldRequests, type RequestRecord } from '@soundclaw/core';
import { ACTIVE_MS, Hub, formatEvents, unseenOpen } from '../src/await.ts';
import { readTokenFile, removeTokenFile, tokenFilePath, writeTokenFile } from '../src/runfile.ts';

const AT = '2026-11-06T10:00:00Z';
const claude = 'agent:claude';
const req = (id: string, by = 'human:ana'): RequestRecord => ({ type: 'request', id, sound: 'beep', kind: 'change', note: 'n', by, at: AT });
const wait = (h: Hub, o: { cursor?: string; initial?: () => ReturnType<typeof unseenOpen>; ms?: number } = {}) =>
  h.wait({ cursor: o.cursor, initial: o.initial ?? (() => []), timeoutMs: o.ms ?? 50, by: claude, via: 'cli' });

describe('the event cursor', () => {
  it('returns events after a cursor once, in order, and nothing is repeated', async () => {
    const h = new Hub();
    const recs: RequestRecord[] = [];
    const push = (r: RequestRecord) => { recs.push(r); h.syncRequests(recs, foldRequests(recs).requests); };
    push(req('r1'));
    const first = await wait(h);
    expect(first.events).toEqual([]);
    push(req('r2'));
    push({ type: 'cancel', id: 'r2', by: 'human:ana', at: AT });
    const a = await wait(h, { cursor: first.cursor });
    expect(a.events.map((e) => [e.kind, e.id])).toEqual([['request', 'r2'], ['cancel', 'r2']]);
    expect(a.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(await wait(h, { cursor: a.cursor, ms: 20 })).toMatchObject({ events: [], timedOut: true, cursor: a.cursor });
  });

  it('wakes a waiter as soon as an event arrives', async () => {
    const h = new Hub();
    const recs: RequestRecord[] = [];
    const t0 = Date.now();
    const w = wait(h, { ms: 5000 });
    expect(h.presence().waiters).toMatchObject([{ by: claude, via: 'cli' }]);
    setTimeout(() => { recs.push(req('r1')); h.syncRequests(recs, foldRequests(recs).requests); }, 30);
    const r = await w;
    expect(r.events[0]).toMatchObject({ kind: 'request', id: 'r1', sound: 'beep', next: 'work' });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(h.presence().waiters).toHaveLength(0);
  });

  it('does not report the agent\'s own claim, progress and done, nor its own requests back to it', async () => {
    const h = new Hub();
    const recs: RequestRecord[] = [req('r1')];
    h.attach([]);
    recs.push({ type: 'claim', id: 'r1', by: claude, at: AT }, { type: 'progress', id: 'r1', by: claude, at: AT, text: 'x' }, { type: 'done', id: 'r1', by: claude, at: AT, text: 'y' }, req('r2', claude));
    h.syncRequests(recs, foldRequests(recs).requests);
    const r = await wait(h, { cursor: `${h.epoch}:0`, ms: 20 });
    expect(r.events.map((e) => e.id)).toEqual(['r1']);
  });

  it('a cursor from another run, or none, falls back to the open unseen requests', async () => {
    const h = new Hub();
    const recs = [req('r1'), req('r2'), { type: 'seen', id: 'r2', by: claude, at: AT } as RequestRecord];
    const initial = () => unseenOpen(foldRequests(recs).requests);
    for (const cursor of [undefined, 'ffffff:3', 'junk', `${h.epoch}:99`]) {
      expect((await wait(h, { cursor, initial, ms: 20 })).events.map((e) => e.id), String(cursor)).toEqual(['r1']);
    }
  });

  it('approvals and rejections by a person are events; the agent\'s are not; Ask for changes is one event, not two', () => {
    const h = new Hub();
    h.marks('human:ana', [{ cmd: 'sound mark beep approved "nice"' }, { cmd: 'sound set beep volume=0.1' }], 'T');
    h.marks(claude, [{ cmd: 'sound mark beep approved' }], 'T');
    h.withoutMarkEvents(() => h.marks('human:ana', [{ cmd: 'sound mark beep rejected "softer"' }], 'T'));
    h.marks('human:bo', [{ cmd: 'sound mark boop rejected' }, { cmd: 'sound mark boop draft' }], 'T');
    const e = h.since(`${h.epoch}:0`)!;
    expect(e.map((x) => [x.kind, x.sound, x.note, x.next])).toEqual([['approved', 'beep', 'nice', 'history'], ['rejected', 'boop', '', 'history']]);
  });

  it('a waiting await or a recent tool call makes the project listened to, for a few minutes', () => {
    let now = 1_000_000;
    const h = new Hub(() => now);
    expect(h.presence().listening).toBe(false);
    h.touch(claude);
    expect(h.presence()).toMatchObject({ listening: true, agents: [{ by: claude }] });
    now += ACTIVE_MS + 1;
    expect(h.presence().listening).toBe(false);
    h.close();
  });

  it('prints events with their next step', () => {
    const text = formatEvents([{ seq: 1, kind: 'request', id: 'r1', sound: 'beep', note: 'softer', by: 'human:ana', at: AT, next: 'work' }], 'abc:1', { cli: 'demo.sclaw' });
    expect(text).toContain('request r1 (beep) from human:ana');
    expect(text).toContain('soundclaw work demo.sclaw claim r1');
    expect(formatEvents([], 'abc:1')).toBe('no new events\nnext cursor: abc:1');
  });
});

describe('the token file', () => {
  let tmp: string;
  let proj: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'soundclaw-tok-'));
    proj = join(tmp, 'p.sclaw');
    process.env.SOUNDCLAW_STATE_DIR = join(tmp, 'state');
  });
  afterEach(() => {
    delete process.env.SOUNDCLAW_STATE_DIR;
    rmSync(tmp, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('is created readable by the user alone, outside the project, and removed on stop', () => {
    writeTokenFile(proj, { url: 'http://127.0.0.1:7418/', token: 'secret' });
    const f = tokenFilePath(proj);
    expect(f.startsWith(proj)).toBe(false);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(join(tmp, 'state')).mode & 0o777).toBe(0o700);
    expect(readTokenFile(proj)).toMatchObject({ token: 'secret', pid: process.pid });
    removeTokenFile(proj);
    expect(existsSync(f)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('is not trusted when others can read it, or its server is gone', () => {
    writeTokenFile(proj, { url: 'http://127.0.0.1:7418/', token: 'secret' });
    const f = tokenFilePath(proj);
    writeFileSync(f, JSON.stringify({ pid: process.pid, url: 'u', token: 't', dir: proj }), { mode: 0o644 });
    chmodSync(f, 0o644);
    expect(readTokenFile(proj)).toBeNull();
    chmodSync(f, 0o600);
    writeFileSync(f, JSON.stringify({ pid: 2 ** 22 + 99, url: 'u', token: 't', dir: proj }), { mode: 0o600 });
    expect(readTokenFile(proj)).toBeNull();
  });

  it('does not remove another server\'s file', () => {
    writeTokenFile(proj, { url: 'u', token: 't' });
    writeFileSync(tokenFilePath(proj), JSON.stringify({ pid: 1, url: 'u', token: 't', dir: proj }), { mode: 0o600 });
    removeTokenFile(proj);
    expect(existsSync(tokenFilePath(proj))).toBe(true);
  });
});

describe('the seen record', () => {
  it('folds into the request, once per agent, and a reply clears it', () => {
    const recs: RequestRecord[] = [req('r1'), { type: 'seen', id: 'r1', by: claude, at: AT }, { type: 'seen', id: 'r1', by: claude, at: AT }, { type: 'seen', id: 'r1', by: 'agent:other', at: AT }];
    const f = foldRequests(recs);
    expect(f.requests.get('r1')!.seen.map((s) => s.by)).toEqual([claude, 'agent:other']);
    expect(f.problems).toHaveLength(1);
    const more = [...recs, { type: 'claim', id: 'r1', by: claude, at: AT } as RequestRecord, { type: 'blocked', id: 'r1', by: claude, at: AT, text: 'q?' } as RequestRecord, { type: 'reply', id: 'r1', by: 'human:ana', at: AT, text: 'a' } as RequestRecord];
    expect(foldRequests(more).requests.get('r1')).toMatchObject({ state: 'open', seen: [] });
  });
});
