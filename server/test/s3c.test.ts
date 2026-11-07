// Document management through the writer (files on disk, undo), loop notes, and `work done` on a member of a set.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { failingChecks, personRequest, agentWork, toPersonRequest } from '../src/index.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
afterEach(() => f.clean());
const run = (commands: string, by = 'agent:claude') => {
  const r = f.w.run({ commands, by });
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('; '));
  return r;
};
const files = (): string[] => readdirSync(join(f.dir, 'sounds')).filter((x) => x.endsWith('.sfx')).sort();

describe('copy, rename and remove', () => {
  it('write and delete the files, update the sets, and every one is undone by its group', () => {
    f = fixture();
    run('sound new Door voice=layered preset=door seed=3\nsound new w voice=classic preset=hit seed=1\nset new steps from=w count=2');
    expect(files()).toEqual(['Door.sfx', 'steps_1.sfx', 'steps_2.sfx', 'w.sfx']);
    run('sound copy Door Door2');
    expect(files()).toContain('Door2.sfx');
    const g = run('sound rename steps_1 stride').group!;
    expect(files()).toEqual(['Door.sfx', 'Door2.sfx', 'steps_2.sfx', 'stride.sfx', 'w.sfx']);
    expect(readFileSync(join(f.dir, 'sets', 'steps.set'), 'utf8')).toContain('members stride steps_2');
    expect(readFileSync(join(f.dir, 'sounds', 'stride.sfx'), 'utf8')).toContain('id stride');
    expect(f.w.set('steps').members).toEqual(['stride', 'steps_2']);
    run(`undo group=${g}`);
    expect(files()).toEqual(['Door.sfx', 'Door2.sfx', 'steps_1.sfx', 'steps_2.sfx', 'w.sfx']);
    expect(f.w.set('steps').members).toEqual(['steps_1', 'steps_2']);
    const rm = f.w.run({ commands: 'sound remove steps_2', by: 'agent:claude' });
    expect(rm.ok).toBe(false);
    run('sound remove steps_2 --from-sets');
    expect(f.w.set('steps').members).toEqual(['steps_1']);
    run('undo');
    expect(f.w.set('steps').members).toEqual(['steps_1', 'steps_2']);
    expect(files()).toContain('steps_2.sfx');
    run('sound remove Door2');
    expect(files()).not.toContain('Door2.sfx');
    run('undo');
    expect(files()).toContain('Door2.sfx');
    // a restarted writer replays the same
    expect(f.reopen().sounds().map((s) => s.id)).toEqual(f.w.sounds().map((s) => s.id));
  });

  it('a rename that only changes case leaves one file with the new case (also on a disk that ignores case)', () => {
    f = fixture();
    run('sound new Foo voice=classic preset=hit seed=1');
    run('sound rename Foo foo');
    expect(files()).toEqual(['foo.sfx']);
    run('sound rename foo FOO');
    expect(files()).toEqual(['FOO.sfx']);
    expect(f.w.sound('FOO').id).toBe('FOO');
    expect(() => f.w.sound('foo')).toThrow(/no sound 'foo'/);
    const clash = f.w.run({ commands: 'sound new foo', by: 'agent:claude' });
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.errors[0]!.message).toMatch(/exists already as 'FOO' \(ids are unique ignoring case\)/);
  });

  it('a name that is not a sound or set errors in the batch and applies nothing', () => {
    f = fixture();
    const r = f.w.run({ commands: 'sound new a voice=classic\nsound rename a b\nsound remove nope', by: 'agent:claude' });
    expect(r.ok).toBe(false);
    expect(f.w.sounds()).toEqual([]);
  });
});

describe('class names and loops through the writer', () => {
  it('a class the style does not have is refused with the list; a loop that lengthens layers says which', () => {
    f = fixture();
    const bad = f.w.run({ commands: 'sound new a voice=classic\nsound set a class=huge', by: 'agent:claude' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]!.message).toMatch(/no loudness class 'huge' \(classes: standard, ui, foley, impact, ambience, voice, music-sting/);
    run('sound new a voice=layered seed=1\nlayer add a osc wave=pink dur=0.5\nlayer add a osc wave=white dur=9');
    const r = run('sound loop a 6 fade=0.5');
    expect(r.warnings).toEqual(['line 1: a layer 1 dur 0.5 -> 6.55 s, to cover the loop and its crossfade (a loop renders length + fade seconds)']);
    expect(f.w.sound('a')).toMatchObject({ loop: { length: 6, fade: 0.5 } });
  });
});

describe('work done on a member of a set', () => {
  it('waits for the set to pass set-spread (members not too alike), when it has two members or more', () => {
    f = fixture();
    run('sound new w voice=classic preset=pickup seed=4\nset new tight from=w count=2 spread="freq±0.0001"\nset new solo from=w count=1');
    const why = failingChecks(f.w, 'tight_1')!;
    expect(why).toMatch(/set-spread of set tight: .*(too alike|dB)/);
    expect(failingChecks(f.w, 'solo_1') ?? '').not.toMatch(/set-spread/); // one member: nothing to compare
    // the request path refuses `done` the same way
    personRequest(f.w, 'human:ana', toPersonRequest({ action: 'request', sound: 'tight_1', note: 'softer' }));
    agentWork(f.w, 'agent:claude', { action: 'next' });
    expect(() => agentWork(f.w, 'agent:claude', { action: 'done', text: 'changed' })).toThrow(/set-spread of set tight/);
  });
});
