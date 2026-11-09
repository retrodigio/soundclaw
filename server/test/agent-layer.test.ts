// The agent layer on the server: a request's target in words (the listing, await and the brief), batch progress events, and the review.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreCommands, restoreSongCommands, songFromJson } from '@soundclaw/core';
import { agentWork, awaitRequests, formatEvents, personRequest, readRequests, requestBrief, requestLine, reviewOf, toPersonRequest, type ServerMessage } from '../src/index.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
const claude = 'agent:claude';
const ana = 'human:ana';
beforeEach(() => {
  f = fixture();
  f.w.run({ commands: 'sound new laser voice=classic; sound set laser wave=sine attack=0.05 sustain=0.3 decay=0.4 freq=0.3 volume=0.15', by: claude });
});
afterEach(() => f.clean());
const run = (commands: string, by = claude) => { const r = f.w.run({ commands, by }); if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('; ')); };
const rvSong = (rv: ReturnType<typeof reviewOf>) => songFromJson(rv.song!.before!);
const ask = (target: unknown, sound = 'laser', extra: Record<string, unknown> = {}) => personRequest(f.w, ana, toPersonRequest({ action: 'request', sound, note: 'shorter tail', target, ...extra }));

describe('a request target, end to end', () => {
  it('is kept on the record and printed in words by the listing, await and the brief', async () => {
    const q = ask({ kind: 'range', start: 0.31, end: 0.38 });
    expect(q.target).toEqual({ kind: 'range', start: 0.31, end: 0.38 });
    expect(readRequests(f.w.project).get('r1')!.target).toEqual(q.target);
    expect(requestLine(q)).toMatch(/^r1 change laser: "shorter tail" — pinned to 0\.31–0\.38 s \(from human:ana/);
    const r = await awaitRequests(f.w, { timeoutS: 0, by: claude, via: 'mcp' });
    expect(r.events[0]!.target).toEqual(q.target);
    expect(formatEvents(r.events, r.cursor)).toMatch(/request r1 \(laser\) from human:ana at \S+: "shorter tail" — pinned to 0\.31–0\.38 s/);
    expect(requestBrief(f.w, q)).toMatch(/selected pinned to 0\.31–0\.38 s: change what is heard there/);
  });

  it('takes the text form the CLI uses, and every kind in words', () => {
    expect(requestLine(ask('range 0.1-0.2'))).toContain('pinned to 0.1–0.2 s');
    expect(requestLine(ask('param decay'))).toContain('— parameter decay');
    expect(requestLine(ask({ kind: 'item' }))).toContain('— the item as a whole');
  });

  it('must fit the item: bars for a song, time and layers for a sound', () => {
    f.w.run({ commands: 'song new tune tempo=120\nsong channel add tune lead inst=square_lead\npattern tune.a steps=16 tpb=4 bar=8\n  lead: C5 . E5 . G5 - - . | A4 . . . G4 . E4 .\nsong section add tune A a x2', by: claude });
    expect(() => ask({ kind: 'bars', from: 1, to: 2 })).toThrow(/is a sound: bars are for a song/);
    expect(() => ask({ kind: 'range', start: 0, end: 1 }, 'tune')).toThrow(/is a song/);
    expect(() => ask({ kind: 'layer', layer: 1 })).toThrow(/has no layers/);
    expect(() => ask({ kind: 'bars', from: 1, to: 2, channel: 'nope' }, 'tune')).toThrow(/no channel 'nope'/);
    const q = ask({ kind: 'bars', from: 1, to: 2, channel: 'lead' }, 'tune');
    expect(requestLine(q)).toContain('— bars 1–2 of lead');
    expect(() => ask('range 3-1')).toThrow(/ends after/);
  });

  it('asks again about a done request, linked by again', async () => {
    ask({ kind: 'item' });
    agentWork(f.w, claude, { action: 'next' });
    f.w.run({ commands: 'sound set laser decay=0.2', by: claude });
    agentWork(f.w, claude, { action: 'done', text: 'shortened' });
    const q2 = personRequest(f.w, ana, toPersonRequest({ action: 'request', sound: 'laser', note: 'still too long', again: 'r1' }));
    expect(q2.again).toBe('r1');
    expect(readRequests(f.w.project).get('r1')!.reviewed).toMatchObject({ how: 'asked again' });
    expect(requestLine(q2)).toContain('(asks again about r1)');
    expect(requestBrief(f.w, q2)).toMatch(/asks again about r1/);
    expect(() => personRequest(f.w, ana, toPersonRequest({ action: 'request', sound: 'laser', note: 'x', again: 'r2' }))).toThrow(/only a done request is asked again/);
  });
});

describe('batch progress', () => {
  const messages = () => {
    const out: ServerMessage[] = [];
    f.w.on((m) => out.push(m));
    return out;
  };
  const progress = (out: ServerMessage[]) => out.filter((m): m is Extract<ServerMessage, { type: 'batchProgress' }> => m.type === 'batchProgress');

  it('a run of several commands starts with a count, finishes each item, and ends once the batch is announced', () => {
    const out = messages();
    const lines = ['a', 'b', 'c', 'd'].map((n) => `sound mutate laser amount=0.1 seed=${n.charCodeAt(0)} as=laser_${n}`).join('\n');
    const r = f.w.run({ commands: lines, by: claude });
    expect(r.ok).toBe(true);
    const p = progress(out);
    expect(p.map((m) => `${m.phase}:${m.batch.done}/${m.batch.total}`)).toEqual(['start:0/4', 'item:1/4', 'item:2/4', 'item:3/4', 'item:4/4', 'end:4/4']);
    expect(p[0]!.batch).toMatchObject({ by: claude, state: 'running' });
    expect(p.at(-1)!.batch.state).toBe('done');
    expect(p[1]!.batch.label).toMatch(/^sound mutate laser/);
    expect(out.findIndex((m) => m.type === 'batch')).toBeLessThan(out.indexOf(p.at(-1)!));
    expect(out.findIndex((m) => m.type === 'batch')).toBeGreaterThan(out.indexOf(p[4]!));
    expect(f.w.snapshot().batch).toMatchObject({ id: p[0]!.batch.id, total: 4, done: 4, state: 'done' });
  });

  it('a set counts its members, one item as each one is level-matched', () => {
    const out = messages();
    expect(f.w.run({ commands: 'set new steps from=laser count=3', by: claude }).ok).toBe(true);
    const p = progress(out);
    expect(p[0]).toMatchObject({ phase: 'start', batch: { total: 3, done: 0 } });
    expect(p.at(-1)).toMatchObject({ phase: 'end', batch: { done: 3, state: 'done' } });
    expect(p.filter((m) => m.phase === 'item').length).toBeGreaterThanOrEqual(2);
    out.length = 0;
    expect(f.w.run({ commands: 'set regen steps', by: claude }).ok).toBe(true);
    expect(progress(out)[0]!.batch.total).toBe(f.w.set('steps').generated.length);
  });

  it('a single command, an undo, and a refused batch say nothing or end failed', () => {
    const out = messages();
    f.w.run({ commands: 'sound set laser volume=0.2', by: claude });
    f.w.run({ commands: 'undo', by: claude });
    expect(progress(out)).toEqual([]);
    const bad = f.w.run({ commands: 'sound set laser volume=0.2\nsound set nope volume=1', by: claude });
    expect(bad.ok).toBe(false);
    expect(progress(out).map((m) => `${m.phase}:${m.batch.state}`)).toEqual(['start:running', 'item:running', 'end:failed']);
  });
});

describe('the review', () => {
  it('shows what an agent did for a request: before and after, parameters, numbers with check glyphs, and the note', () => {
    ask({ kind: 'param', param: 'decay' });
    agentWork(f.w, claude, { action: 'next' });
    f.w.run({ commands: 'sound set laser decay=0.3 freq=0.32', by: claude });
    agentWork(f.w, claude, { action: 'done', text: 'shortened the decay' });
    const rv = reviewOf(f.w, { request: 'r1' });
    expect(rv).toMatchObject({ request: 'r1', item: 'laser', kind: 'sound', by: claude, note: 'shortened the decay', current: true });
    expect(rv.params.map((p) => p.name)).toEqual(expect.arrayContaining(['decay', 'freq']));
    expect(rv.params.find((p) => p.name === 'decay')).toMatchObject({ old: '0.4', new: '0.3', by: claude });
    expect(rv.before!.sound!.id).toBe('laser');
    expect(rv.rows.map((r) => r.k)).toEqual(expect.arrayContaining(['Integrated', 'Centroid', 'True peak', 'Duration']));
    expect(rv.rows.every((r) => ['pass', 'fail', ''].includes(r.glyph))).toBe(true);
    expect(rv.after!.checks.length).toBeGreaterThan(0);
    // the same, by the group
    expect(reviewOf(f.w, { group: rv.groups[0]! }).params).toEqual(rv.params);
    // later edits make the after no longer current; restoring the before is one set of commands
    f.w.run({ commands: 'sound set laser decay=0.5', by: ana });
    const later = reviewOf(f.w, { request: 'r1' });
    expect(later.current).toBe(false);
    const back = restoreCommands(f.w.sound('laser'), later.before!.sound!);
    expect('commands' in back && back.commands).toEqual(['sound set laser decay=0.4 freq=0.5'].map((c) => expect.stringContaining('sound set laser')));
  });

  it('a request with no commands by its agent has no review', () => {
    ask({ kind: 'item' });
    agentWork(f.w, claude, { action: 'next' });
    agentWork(f.w, claude, { action: 'done', text: 'nothing to do' });
    expect(() => reviewOf(f.w, { request: 'r1' })).toThrow(/no commands by agent:claude/);
    expect(() => reviewOf(f.w, { request: 'r9' })).toThrow(/no request r9/);
  });

  it('a song review holds the notes that went and came, and restores patterns with pattern set', () => {
    f.w.run({ commands: 'song new tune tempo=120\nsong channel add tune lead inst=square_lead\npattern tune.a steps=16 tpb=4 bar=8\n  lead: C5 . E5 . G5 - - . | A4 . . . G4 . E4 .\nsong section add tune A a x2', by: claude });
    ask({ kind: 'bars', from: 1, to: 1, channel: 'lead' }, 'tune');
    agentWork(f.w, claude, { action: 'next' });
    run('pattern tune.a steps=16 tpb=4 bar=8\n  lead: C5 . . . G5 - - . | A4 . . . G4 . E4 .');
    agentWork(f.w, claude, { action: 'done', text: 'thinned the first bar' });
    const rv = reviewOf(f.w, { request: 'r1' });
    expect(rv.kind).toBe('song');
    expect(rv.song!.notes.join('\n')).toMatch(/a\.lead/);
    expect(rv.song!.before).not.toBeNull();
    const back = restoreSongCommands(f.w.song('tune'), rvSong(rv));
    expect(back).toMatchObject({ commands: [expect.stringMatching(/^pattern set tune\.a "/)] });
  });
});

describe('deciding on a request', () => {
  it('approved and reverted are recorded once on a done request', () => {
    ask({ kind: 'item' });
    agentWork(f.w, claude, { action: 'next' });
    agentWork(f.w, claude, { action: 'done', text: 'ok' });
    const q = personRequest(f.w, ana, { action: 'reviewed', id: 'r1', how: 'approved' });
    expect(q.reviewed).toMatchObject({ how: 'approved', by: ana });
    expect(() => personRequest(f.w, ana, { action: 'reviewed', id: 'r1', how: 'reverted' })).toThrow(/already approved/);
  });
});
