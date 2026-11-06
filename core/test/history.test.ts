import { describe, expect, it } from 'vitest';
import { activeGroups, effectiveEntries, historyTarget, nextGroup, parse, parseTape, replay, tapeToJsonl, type TapeEntry } from '../src/index.ts';

let seq = 0;
const e = (group: string, cmd: string, by = 'agent:claude'): TapeEntry => ({ seq: ++seq, by, group, cmd });
const undoCmd = (text: string) => parse(text).commands[0] as Extract<ReturnType<typeof parse>['commands'][number], { op: 'undo' | 'redo' }>;

describe('the history tape', () => {
  it('replays to the sounds', () => {
    const t = [e('g1', 'sound new a'), e('g1', 'sound set a frequency=220'), e('g2', 'sound new b', 'human:ana')];
    const r = replay(t);
    expect(r.problems).toEqual([]);
    expect([...r.library.keys()]).toEqual(['a', 'b']);
    expect(r.library.get('a')!.frequency).toBe(220);
  });

  it('undo takes a group out of effect and redo brings it back; the tape only grows', () => {
    const t = [e('g1', 'sound new a'), e('g2', 'sound set a volume=0.9')];
    expect(replay(t).library.get('a')!.volume).toBe(0.9);
    t.push(e('g3', 'undo group=g2'));
    expect(replay(t).library.get('a')!.volume).toBe(0.5);
    expect([...activeGroups(t)]).toEqual(['g1', 'g3']);
    t.push(e('g4', 'redo group=g3'));
    expect(replay(t).library.get('a')!.volume).toBe(0.9);
    expect(t).toHaveLength(4);
    expect(effectiveEntries(t).map((x) => x.cmd)).toEqual(['sound new a', 'sound set a volume=0.9']);
  });

  it('finds the target: the latest group in effect, one author\'s latest, or a named group', () => {
    const t = [e('g1', 'sound new a'), e('g2', 'sound set a volume=0.9', 'human:ana'), e('g3', 'sound set a volume=0.1')];
    expect(historyTarget(t, undoCmd('undo'))).toEqual({ group: 'g3' });
    expect(historyTarget(t, undoCmd('undo by=human:ana'))).toEqual({ group: 'g2' });
    expect(historyTarget(t, undoCmd('undo group=g1'))).toEqual({ group: 'g1' });
    expect(historyTarget(t, undoCmd('undo group=g9'))).toEqual({ error: 'no group g9' });
    expect(historyTarget(t, undoCmd('redo'))).toEqual({ error: 'nothing to redo' });
    t.push(e('g4', 'undo group=g3'));
    expect(historyTarget(t, undoCmd('undo'))).toEqual({ group: 'g2' });
    expect(historyTarget(t, undoCmd('undo group=g3'))).toEqual({ error: 'g3 is undone already' });
    expect(historyTarget(t, undoCmd('redo'))).toEqual({ group: 'g4' });
    expect(historyTarget(t, undoCmd('redo group=g2'))).toEqual({ error: 'g2 is not an undo (redo takes back an undo)' });
    expect(historyTarget(t, undoCmd('undo group=g4'))).toEqual({ error: 'g4 is an undo or redo, not changes (redo undoes an undo)' });
  });

  it('repeated undo walks back and repeated redo walks forward', () => {
    const t = [e('g1', 'sound new a'), e('g2', 'sound set a volume=0.2'), e('g3', 'sound set a volume=0.3')];
    t.push(e('g4', 'undo group=g3'), e('g5', 'undo group=g2'));
    expect(replay(t).library.get('a')!.volume).toBe(0.5);
    t.push(e('g6', 'redo group=g5'));
    expect(replay(t).library.get('a')!.volume).toBe(0.2);
    t.push(e('g7', 'redo group=g4'));
    expect(replay(t).library.get('a')!.volume).toBe(0.3);
  });

  it('reports a replay problem when an undo leaves a later group without its sound', () => {
    const t = [e('g1', 'sound new a'), e('g2', 'sound set a volume=0.9'), e('g3', 'undo group=g1')];
    expect(replay(t).problems[0]).toMatchObject({ message: "no sound 'a'" });
  });

  it('numbers groups, and round-trips through its file form', () => {
    const t = [e('g1', 'sound new a'), e('g7', 'sound new b')];
    expect(nextGroup(t)).toBe('g8');
    expect(nextGroup([])).toBe('g1');
    expect(parseTape(tapeToJsonl(t))).toEqual(t);
    expect(() => parseTape('{"format":"x","lang":1}\n')).toThrow(/not a history header/);
    expect(() => parseTape(tapeToJsonl([{ seq: 1, by: 'claude', group: 'g1', cmd: 'sound new a' }]))).toThrow(/agent:<name> or human:<name>/);
  });
});
