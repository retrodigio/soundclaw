// The single writer: batches are atomic, history is a tape with authors, undo and redo are
// commands, and the project folder is plain files.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { samplesHash, renderSound, newSound } from '@soundclaw/core';
import { HISTORY_FILE, ProjectError, createProject } from '../src/index.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
beforeEach(() => { f = fixture(); });
afterEach(() => f.clean());

const snapshot = (dir: string) => ({
  history: readFileSync(join(dir, HISTORY_FILE), 'utf8'),
  sounds: readdirSync(join(dir, 'sounds')).sort().map((n) => [n, readFileSync(join(dir, 'sounds', n), 'utf8')]),
});

describe('a new project', () => {
  it('has the folders, an empty history, requests and an ignore file', () => {
    for (const d of ['sounds', 'instruments', 'songs', 'sets', 'exports']) expect(existsSync(join(f.dir, d)), d).toBe(true);
    expect(readFileSync(join(f.dir, HISTORY_FILE), 'utf8')).toBe('{"format":"soundclaw-history","lang":1}\n');
    expect(readFileSync(join(f.dir, 'requests.jsonl'), 'utf8')).toBe('');
    expect(readFileSync(join(f.dir, '.gitignore'), 'utf8')).toContain('exports/');
    expect(JSON.parse(readFileSync(join(f.dir, 'project.json'), 'utf8'))).toMatchObject({ format: 'soundclaw-project', version: 1, name: 'demo' });
  });
  it('refuses a folder that is a project already or holds other files', () => {
    expect(() => createProject(f.dir)).toThrow(/already/);
    expect(() => createProject(join(f.root))).toThrow(/not empty/);
  });
});

describe('run', () => {
  it('applies a batch as one group on the tape with its author, and writes the sound file', () => {
    const r = f.w.run({ commands: 'sound new beep\nsound set beep frequency=880 volume=0.4', by: 'agent:claude' });
    expect(r).toMatchObject({ ok: true, group: 'g1', touched: ['beep'], warnings: [] });
    expect(f.w.tape().map((e) => [e.seq, e.group, e.by, e.cmd])).toEqual([
      [1, 'g1', 'agent:claude', 'sound new beep'], [2, 'g1', 'agent:claude', 'sound set beep frequency=880 volume=0.4'],
    ]);
    expect(readFileSync(join(f.dir, 'sounds', 'beep.sfx'), 'utf8')).toContain('frequency 880\nduration 0.5\nvolume 0.4\nstatus draft\n');
    const g2 = f.w.run({ commands: 'sound new boop', by: 'human:ana' });
    expect(g2).toMatchObject({ ok: true, group: 'g2' });
    expect(f.w.history({ by: 'human:ana' }).map((e) => e.cmd)).toEqual(['sound new boop']);
    expect(f.w.history({ sound: 'beep', limit: 1 }).map((e) => e.seq)).toEqual([2]);
  });

  it('applies nothing when any command fails: not the tape, not the files', () => {
    f.w.run({ commands: 'sound new beep', by: 'agent:claude' });
    const before = snapshot(f.dir);
    const bad = f.w.run({ commands: 'sound set beep volume=0.9\nsound new beep\nsound set nothere volume=1\nsound new fine', by: 'agent:claude' });
    expect(bad).toMatchObject({ ok: false });
    expect(!bad.ok && bad.errors.map((e) => `${e.line}: ${e.message}`)).toEqual(["2: sound 'beep' exists already", "3: no sound 'nothere'"]);
    const syntax = f.w.run({ commands: 'sound set beep volume=0.9\nsound set beep volume=loud', by: 'agent:claude' });
    expect(syntax.ok).toBe(false);
    expect(snapshot(f.dir)).toEqual(before);
    expect(f.w.sound('beep').volume).toBe(0.5);
    expect(f.reopen().sounds().map((s) => s.id)).toEqual(['beep']);
  });

  it('sees earlier commands of the same batch', () => {
    expect(f.w.run({ commands: 'sound new a; sound set a frequency=100; sound mark a approved "ok"', by: 'agent:claude' })).toMatchObject({ ok: true });
    expect(f.w.sound('a')).toMatchObject({ frequency: 100, status: 'approved' });
  });

  it('warns when a set changes nothing, and reports no commands', () => {
    f.w.run({ commands: 'sound new a', by: 'agent:claude' });
    const r = f.w.run({ commands: 'sound set a frequency=440', by: 'agent:claude' });
    expect(r).toMatchObject({ ok: true, touched: [] });
    expect(r.ok && r.warnings[0]).toMatch(/already had those values/);
    expect(f.w.run({ commands: '# nothing\n', by: 'agent:claude' })).toMatchObject({ ok: true, group: null, added: [] });
  });

  it('refuses an author that is not agent:<name> or human:<name>', () => {
    expect(() => f.w.run({ commands: 'sound new a', by: 'claude' })).toThrow(ProjectError);
    expect(() => f.w.run({ commands: 'sound new a', by: 'human:' })).toThrow(/agent:<name> or human:<name>/);
    expect(f.w.tape()).toHaveLength(0);
  });

  it('serialises batches that arrive together, in arrival order', async () => {
    const out = await Promise.all(['a', 'b', 'c'].map((id) => f.w.enqueue(() => f.w.run({ commands: `sound new ${id}`, by: 'agent:claude' }))));
    expect(out.map((r) => r.ok && r.group)).toEqual(['g1', 'g2', 'g3']);
    expect(f.w.tape().map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('replays the same sounds in a new process (a new Writer on the folder)', () => {
    f.w.run({ commands: 'sound new a; sound set a frequency=300 duration=0.2', by: 'agent:claude' });
    f.w.run({ commands: 'sound set a volume=0.7', by: 'human:ana' });
    expect(f.reopen().sounds()).toEqual(f.w.sounds());
    expect(f.reopen().tape()).toEqual(f.w.tape());
  });
});

describe('undo and redo', () => {
  beforeEach(() => {
    f.w.run({ commands: 'sound new a', by: 'agent:claude' });
    f.w.run({ commands: 'sound set a volume=0.9', by: 'agent:claude' });
    f.w.run({ commands: 'sound set a frequency=220', by: 'human:ana' });
  });

  it('undo takes the latest group out of effect (an entry on the tape), redo brings it back', () => {
    const u = f.w.run({ commands: 'undo', by: 'agent:claude' });
    expect(u).toMatchObject({ ok: true, group: 'g4', touched: ['a'] });
    expect(f.w.sound('a')).toMatchObject({ frequency: 440, volume: 0.9 });
    expect(f.w.tape().at(-1)).toMatchObject({ cmd: 'undo group=g3', group: 'g4' });
    expect(f.w.tape()).toHaveLength(4);
    expect(readFileSync(join(f.dir, 'sounds', 'a.sfx'), 'utf8')).toContain('frequency 440');
    f.w.run({ commands: 'redo', by: 'agent:claude' });
    expect(f.w.sound('a').frequency).toBe(220);
    expect(f.w.tape().at(-1)).toMatchObject({ cmd: 'redo group=g4' });
  });

  it('undo by an author, or a named group; the next undo walks back', () => {
    f.w.run({ commands: 'undo by=agent:claude', by: 'human:ana' });
    expect(f.w.sound('a')).toMatchObject({ volume: 0.5, frequency: 220 });
    expect(f.w.tape().at(-1)!.cmd).toBe('undo group=g2');
    f.w.run({ commands: 'undo group=g3', by: 'human:ana' });
    expect(f.w.sound('a')).toMatchObject({ volume: 0.5, frequency: 440 });
    f.w.run({ commands: 'redo group=g5', by: 'human:ana' });
    expect(f.w.sound('a').frequency).toBe(220);
  });

  it('undoing the batch that made a sound removes its file; redo writes it again', () => {
    f.w.run({ commands: 'sound new b', by: 'agent:claude' });
    f.w.run({ commands: 'undo', by: 'agent:claude' });
    expect(f.w.has('b')).toBe(false);
    expect(existsSync(join(f.dir, 'sounds', 'b.sfx'))).toBe(false);
    f.w.run({ commands: 'redo', by: 'agent:claude' });
    expect(existsSync(join(f.dir, 'sounds', 'b.sfx'))).toBe(true);
  });

  it('refuses what cannot be done, and applies nothing', () => {
    const before = snapshot(f.dir);
    const why = (commands: string) => { const r = f.w.run({ commands, by: 'agent:claude' }); return r.ok ? 'ok' : r.errors[0]!.message; };
    expect(why('redo')).toBe('nothing to redo');
    expect(why('undo group=g9')).toBe('no group g9');
    expect(why('undo group=g1')).toMatch(/would leave a later change without what it works on \(no sound 'a'\)/);
    expect(why('sound set a volume=0.1\nundo')).toMatch(/runs alone/);
    expect(snapshot(f.dir)).toEqual(before);
    f.w.run({ commands: 'undo', by: 'agent:claude' });
    expect(why('undo group=g3')).toBe('g3 is undone already');
    expect(why('undo group=g4')).toMatch(/is an undo or redo/);
  });

  it('survives a restart: the undone group is still undone', () => {
    f.w.run({ commands: 'undo', by: 'agent:claude' });
    expect(f.reopen().sound('a').frequency).toBe(440);
  });
});

describe('render and the cache', () => {
  it('renders the sound through a content-hash cache that survives a new process and tracks the document', () => {
    f.w.run({ commands: 'sound new a; sound set a frequency=523.25 duration=0.2', by: 'agent:claude' });
    const first = f.w.render('a');
    expect(first.cached).toBe(false);
    expect(samplesHash(first.samples)).toBe(samplesHash(renderSound({ ...newSound('a'), frequency: 523.25, duration: 0.2 })));
    const again = f.w.render('a');
    expect(again).toMatchObject({ cached: true, key: first.key });
    expect(samplesHash(again.samples)).toBe(samplesHash(first.samples));
    const w2 = f.reopen();
    const fromDisk = w2.render('a');
    expect(fromDisk.cached).toBe(true);
    expect(samplesHash(fromDisk.samples)).toBe(samplesHash(first.samples));
    f.w.run({ commands: 'sound set a frequency=523.26', by: 'agent:claude' });
    expect(f.w.render('a')).toMatchObject({ cached: false });
    expect(f.w.render('a').key).not.toBe(first.key);
    // A status mark does not change the audio, so it does not miss the cache.
    f.w.run({ commands: 'sound mark a approved', by: 'human:ana' });
    expect(f.w.render('a').cached).toBe(true);
    expect(() => f.w.render('nope')).toThrow(/no sound 'nope'/);
    expect(readdirSync(join(f.dir, '.cache', 'renders')).length).toBe(2);
  });
});
