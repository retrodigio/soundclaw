import { describe, expect, it } from 'vitest';
import type { TapeEntry, WorkRequest } from '@soundclaw/core';
import { agentSet, answeredNote, provenanceOf } from '../src/sound/provenance.ts';

let n = 0;
const e = (by: string, group: string, cmd: string, at = '2026-11-08T10:00:00.000Z'): TapeEntry => ({ seq: ++n, by, group, cmd, at });
const reset = () => { n = 0; };

describe('provenance from the tape', () => {
  it('the latest change to a classic parameter is its trail, with the value before', () => {
    reset();
    const tape = [
      e('human:ana', 'g1', 'sound new beep voice=classic preset=pickup seed=3'),
      e('human:ana', 'g2', 'sound set beep decay=0.3'),
      e('agent:claude', 'g3', 'sound set beep decay=0.11 sustain=0.05'),
    ];
    const p = provenanceOf(tape, 'beep');
    expect(p.params.get('decay')).toMatchObject({ by: 'agent:claude', prev: 0.3, now: 0.11, group: 'g3' });
    expect(p.params.get('sustain')?.by).toBe('agent:claude');
    expect(agentSet(p, p.params.get('decay'))).toBe(true);
    // a parameter nobody changed since the sound was made has no trail
    expect(p.params.get('freq')).toBeUndefined();
    expect(p.before).not.toBeNull();
    expect(p.beforeAgent).not.toBeNull();
  });

  it('a person editing the parameter afterwards takes the tick away; so does an approval', () => {
    reset();
    const base = [e('human:ana', 'g1', 'sound new beep voice=classic preset=pickup seed=3'), e('agent:claude', 'g2', 'sound set beep decay=0.11 punch=0.4')];
    let p = provenanceOf([...base, e('human:ana', 'g3', 'sound set beep decay=0.2')], 'beep');
    expect(agentSet(p, p.params.get('decay'))).toBe(false);
    expect(agentSet(p, p.params.get('punch'))).toBe(true);
    p = provenanceOf([...base, e('human:ana', 'g3', 'sound mark beep approved')], 'beep');
    expect(agentSet(p, p.params.get('punch'))).toBe(false);
    expect(p.beforeAgent).toBeNull();
    // an agent marking it approved is not a person's approval
    p = provenanceOf([...base, e('agent:claude', 'g3', 'sound mark beep approved')], 'beep');
    expect(agentSet(p, p.params.get('punch'))).toBe(true);
  });

  it('an undone group is not in the trail', () => {
    reset();
    const p = provenanceOf([
      e('human:ana', 'g1', 'sound new beep voice=classic preset=pickup seed=3'),
      e('agent:claude', 'g2', 'sound set beep decay=0.11'),
      e('human:ana', 'g3', 'undo group=g2'),
    ], 'beep');
    expect(agentSet(p, p.params.get('decay'))).toBe(false);
  });

  it('layered devices are tracked by layer and position', () => {
    reset();
    const p = provenanceOf([
      e('human:ana', 'g1', 'sound new boom voice=layered'),
      e('human:ana', 'g2', 'layer add boom osc'),
      e('human:ana', 'g3', 'fx add boom layer=1 filter'),
      e('agent:claude', 'g4', 'fx add boom layer=1 distort'),
      e('agent:claude', 'g5', 'fx set boom layer=1 1 cutoff=900'),
    ], 'boom');
    const salt = [...p.layers.keys()][0]!;
    expect(p.devices.get(`${salt}:1`)?.by).toBe('agent:claude'); // added by the agent
    expect(p.devices.get(`${salt}:0`)?.by).toBe('agent:claude'); // then set by the agent
    expect(p.devices.get(`${salt}:0`)?.prev).toBeDefined();
  });
});

describe('the note of the request an agent answered', () => {
  const req = (over: Partial<WorkRequest>): WorkRequest => ({ id: 'r1', sound: 'beep', kind: 'change', note: 'shorter', by: 'human:ana', at: '2026-11-08T09:59:00.000Z', tags: [], state: 'done', claimedBy: 'agent:claude', latest: null, question: null, seen: [], events: [], ...over }) as WorkRequest;
  it('is the done text of the request whose claim and end surround the change', () => {
    const q = req({ events: [{ type: 'claim', by: 'agent:claude', at: '2026-11-08T09:59:30.000Z' }, { type: 'progress', by: 'agent:claude', at: '2026-11-08T09:59:40.000Z', text: 'working' }, { type: 'done', by: 'agent:claude', at: '2026-11-08T10:00:05.000Z', text: 'shorter, so a run of coins does not blur' }] });
    expect(answeredNote([q], 'beep', 'agent:claude', '2026-11-08T10:00:00.000Z')).toBe('shorter, so a run of coins does not blur');
    expect(answeredNote([q], 'beep', 'agent:claude', '2026-11-08T11:00:00.000Z')).toBeNull();
    expect(answeredNote([q], 'other', 'agent:claude', '2026-11-08T10:00:00.000Z')).toBeNull();
    expect(answeredNote([q], 'beep', 'agent:other', '2026-11-08T10:00:00.000Z')).toBeNull();
  });
});
