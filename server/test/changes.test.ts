// `changes` (what other hands did since an agent looked), listening-feedback tags as requests,
// and the duplicate-id rule of synth.csv on import.

import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hub, agentWork, changesCursor, collectChanges, changesText, formatEvents, importCommands, personRequest, readRequests, requestBrief, requestLine, toPersonRequest } from '../src/index.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
const claude = 'agent:claude';
const ana = 'human:ana';
beforeEach(() => { f = fixture(); });
afterEach(() => f.clean());
const run = (commands: string, by = claude) => { const r = f.w.run({ commands, by }); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r; };
const SETUP = 'sound new beep voice=classic preset=pickup seed=3; sound set beep wave=sine volume=0.3';

describe('changes', () => {
  it('shows what a person changed with parameters and numbers before and after, and a compare PNG', () => {
    run(SETUP);
    const first = collectChanges(f.w, { agent: claude });
    expect(first.changes).toEqual([]); // the agent's own work is not news to it
    expect(first.cursor).toBe(f.w.tape().at(-1)!.seq);
    run('sound set beep freq=0.6 decay=0.2', ana);
    const r = collectChanges(f.w, { agent: claude, by: 'human' });
    expect(r.changes).toHaveLength(1);
    const c = r.changes[0]!;
    expect(c).toMatchObject({ by: ana, undone: false, commands: ['sound set beep freq=0.6 decay=0.2'] });
    const s = c.sounds[0]!;
    expect(s.id).toBe('beep');
    expect(s.params.map((l) => l.replace(/ [\d.-]+ → [\d.-]+$/, ''))).toEqual(['decay', 'freq']);
    expect(s.params.find((l) => l.startsWith('freq'))).toMatch(/^freq [\d.]+ → 0\.6$/);
    expect(s.numbers.map((n) => n.split(' ')[0])).toEqual(['duration', 'loudness', 'centroid', 'pitch']);
    expect(s.view).toMatch(/change-g\d+-beep\.png$/);
    expect(readFileSync(s.view!).subarray(1, 4).toString()).toBe('PNG');
    const text = changesText(f.w, { agent: claude, since: '0' });
    expect(text).toContain('human:ana');
    expect(text).toContain('compare view');
    expect(text).toContain('do not undo or overwrite one silently');
  });

  it('keeps a cursor per agent: reading moves it, peek and since do not, another agent has its own', () => {
    run(SETUP);
    run('sound set beep punch=0.4', ana);
    expect(changesCursor(f.w, claude)).toBe(0);
    expect(collectChanges(f.w, { agent: claude, peek: true }).changes).toHaveLength(1);
    expect(changesCursor(f.w, claude)).toBe(0);
    expect(collectChanges(f.w, { agent: claude, since: '1' }).changes).toHaveLength(1);
    expect(changesCursor(f.w, claude)).toBe(0);
    const r = collectChanges(f.w, { agent: claude });
    expect(r.changes).toHaveLength(1);
    expect(r.from).toBe(0);
    const seq = f.w.tape().at(-1)!.seq;
    expect(changesCursor(f.w, claude)).toBe(seq);
    expect(collectChanges(f.w, { agent: claude }).changes).toEqual([]);
    expect(changesText(f.w, { agent: claude })).toMatch(/^no changes by anyone but agent:claude since #\d+/);
    // another agent never looked: it sees the person's edit too
    expect(collectChanges(f.w, { agent: 'agent:other' }).changes.map((c) => c.by)).toEqual([claude, ana]);
    // and new work after the cursor is what comes next
    run('sound set beep volume=0.2', ana);
    const next = collectChanges(f.w, { agent: claude });
    expect(next.from).toBe(seq);
    expect(next.changes).toHaveLength(1);
  });

  it('filters by author: people only, agents only, one person; its own work only when asked', () => {
    run(SETUP);
    run('sound set beep punch=0.4', ana);
    run('sound set beep punch=0.5', 'human:bo');
    run('sound set beep punch=0.6', 'agent:other');
    const by = (o: Partial<Parameters<typeof collectChanges>[1]>) => collectChanges(f.w, { agent: claude, since: '0', ...o }).changes.map((c) => c.by);
    expect(by({})).toEqual([ana, 'human:bo', 'agent:other']);
    expect(by({ by: 'human' })).toEqual([ana, 'human:bo']);
    expect(by({ by: 'agent' })).toEqual([claude, 'agent:other']);
    expect(by({ by: 'human:bo' })).toEqual(['human:bo']);
    expect(() => by({ by: 'robots' })).toThrow(/--by is human, agent/);
  });

  it('takes a time as well as a command number, and marks a change that was undone later', () => {
    run(SETUP);
    const t = f.w.tape().at(-1)!.at!;
    run('sound set beep punch=0.4', ana);
    run('undo', ana);
    const all = collectChanges(f.w, { agent: claude, since: t });
    expect(all.changes.map((c) => [c.by, c.commands[0]!.split(' ')[0], c.undone])).toEqual([[ana, 'sound', true], [ana, 'undo', false]]);
    expect(all.changes[1]!.sounds[0]!.params[0]).toBe('punch 0.4 → 0.312');
    expect(() => collectChanges(f.w, { agent: claude, since: 'yesterday' })).toThrow(/--since is a command number/);
  });

  it('a new sound, a removal by undo, and a status mark are changes too', () => {
    run(SETUP);
    run('sound new zap voice=classic', ana);
    run('sound mark beep approved', ana);
    const r = collectChanges(f.w, { agent: claude, since: '0', by: 'human' });
    expect(r.changes[0]!.sounds).toMatchObject([{ id: 'zap', kind: 'new' }]);
    expect(r.changes[1]!.sounds[0]!.params).toEqual(['status draft → approved']);
  });

  it('details the newest few and counts the rest', () => {
    run(SETUP);
    for (let i = 1; i <= 14; i++) run(`sound set beep punch=${i / 20}`, ana);
    const r = collectChanges(f.w, { agent: claude, since: '0' });
    expect(r.changes).toHaveLength(12);
    expect(r.omitted).toBe(2);
    expect(r.changes.at(-1)!.commands[0]).toBe('sound set beep punch=0.7');
  });

  it('keeps the cursor in the project\'s ignored cache', () => {
    run(SETUP);
    collectChanges(f.w, { agent: claude });
    expect(existsSync(`${f.dir}/.cache/changes-seen.json`)).toBe(true);
    expect(readFileSync(`${f.dir}/.gitignore`, 'utf8')).toContain('.cache/');
  });
});

describe('listening feedback', () => {
  const ask = (o: Parameters<typeof toPersonRequest>[0]) => personRequest(f.w, ana, toPersonRequest({ action: 'request', sound: 'beep', ...o }));
  beforeEach(() => { run(SETUP + '; sound new boop voice=classic'); });

  it('a tag alone is a request with the tags, and marks the sound like Ask for changes does', () => {
    const q = ask({ tags: ['too loud', 'too harsh'] });
    expect(q).toMatchObject({ id: 'r1', kind: 'change', tags: ['too loud', 'too harsh'], note: 'too loud, too harsh', state: 'open' });
    expect(f.w.sound('beep').status).toBe('rejected');
    expect(f.w.tape().at(-1)).toMatchObject({ by: ana, cmd: 'sound mark beep rejected "too loud, too harsh"' });
    expect(requestLine(q)).toContain('r1 change beep [too loud, too harsh] (from human:ana');
  });

  it('keeps the words beside the tags, and the other sound a "too similar" tag points at', () => {
    const q = ask({ tags: ['too similar to another sound'], other: 'boop', note: 'it is the same blip' });
    expect(q).toMatchObject({ tags: ['too similar to another sound'], other: 'boop', note: 'it is the same blip' });
    expect(requestLine(q)).toContain('[too similar to another sound]: "it is the same blip" (like boop)');
    expect(f.w.tape().at(-1)!.cmd).toBe('sound mark beep rejected "[too similar to another sound] it is the same blip"');
    expect(requestBrief(f.w, q)).toContain('view beep compare boop');
  });

  it('good alone is praise: a feedback request, no mark, and it can be closed whatever the checks say', () => {
    const before = f.w.tape().length;
    const q = ask({ tags: ['good'] });
    expect(q).toMatchObject({ kind: 'feedback', tags: ['good'], note: 'good' });
    expect(f.w.tape()).toHaveLength(before);
    expect(f.w.sound('beep').status).toBe('draft');
    agentWork(f.w, claude, { action: 'next' });
    expect(requestBrief(f.w, readRequests(f.w.project).get('r1')!)).toContain('This is praise');
    expect(agentWork(f.w, claude, { action: 'done', text: 'thanks' }).request!.state).toBe('done');
    // good with another tag is a change request
    expect(ask({ tags: ['good', 'too long'] }).kind).toBe('change');
  });

  it('refuses nothing to say, a tag that is not on the cards, and a bad other sound', () => {
    expect(() => ask({})).toThrow(/say what should change, or pick a tag/);
    expect(() => ask({ tags: ['too purple'] })).toThrow(/no tag 'too purple'/);
    expect(() => ask({ tags: ['too long'], other: 'boop' })).toThrow(/too similar/);
    expect(() => ask({ tags: ['too similar to another sound'], other: 'nope' })).toThrow(/no sound 'nope'/);
    expect(() => ask({ tags: ['too similar to another sound'], other: 'beep' })).toThrow(/not similar to itself/);
  });

  it('arrives through await with its tags, and the tags survive a restart', () => {
    const hub = new Hub();
    hub.attach([]);
    ask({ tags: ['too short'], note: 'cut off' });
    const reqs = readRequests(f.w.project);
    hub.syncRequests([...[...reqs.values()].map((q) => ({ type: 'request' as const, id: q.id, sound: q.sound, kind: q.kind, note: q.note, tags: q.tags, by: q.by, at: q.at }))], reqs);
    const events = hub.since(hub.cursor().replace(/:\d+$/, ':0'))!;
    expect(events).toMatchObject([{ kind: 'request', id: 'r1', sound: 'beep', tags: ['too short'], note: 'cut off', by: ana }]);
    expect(formatEvents(events, 'x:1')).toContain('request r1 (beep) from human:ana');
    expect(formatEvents(events, 'x:1')).toContain('[too short]: "cut off"');
    expect(readRequests(f.reopen().project).get('r1')!.tags).toEqual(['too short']);
  });
});

describe('synth.csv with a repeated id', () => {
  const csv = 'id,freq,decay\nzap,0.2,0.1\nboom,0.3,0.2\nzap,0.5,0.3\n';
  it('imports the engine\'s way: first position, last values, one sound, a warning naming both lines', () => {
    const { commands, ids, warnings } = importCommands(csv, null);
    expect(ids).toEqual(['zap', 'boom']);
    expect(commands.match(/sound new zap /g)).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/'zap' is on line 2 and again on line 4/);
    run(commands);
    const s = f.w.sound('zap');
    expect(s.voice === 'classic' && [s.patch.freq, s.patch.decay]).toEqual([0.5, 0.3]);
  });
});
