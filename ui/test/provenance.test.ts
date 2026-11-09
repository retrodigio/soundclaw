import { describe, expect, it } from 'vitest';
import type { TapeEntry, WorkRequest } from '@soundclaw/core';
import { agentSet, answeredNote, gridVersions, provenanceOf } from '../src/sound/provenance.ts';

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

describe('the clip grid\'s versions', () => {
  it('are the distinct renders after each group, newest last, at most four numbered; a status mark or a moment is not a version', () => {
    reset();
    const tape = [
      e('agent:claude', 'g1', 'sound new beep voice=classic preset=pickup seed=3'),
      e('agent:claude', 'g2', 'sound set beep decay=0.3'),
      e('human:ana', 'g3', 'sound mark beep approved'),
      e('human:ana', 'g4', 'sound set beep moment="a coin lands"'),
      e('human:ana', 'g5', 'sound set beep decay=0.2'),
      e('agent:claude', 'g6', 'sound set beep sustain=0.1'),
      e('human:ana', 'g7', 'sound set beep sustain=0.2'),
      e('human:ana', 'g8', 'sound set beep punch=0.5'),
    ];
    const g = gridVersions(provenanceOf(tape, 'beep'));
    expect(g.proposed).toBeNull();
    expect(g.versions.map((v) => [v.label, v.seq, v.by, v.current])).toEqual([['v1', 5, 'human:ana', false], ['v2', 6, 'agent:claude', false], ['v3', 7, 'human:ana', false], ['v4', 8, 'human:ana', true]]);
  });

  it('the agent\'s unapproved change is the proposal apart from v1…vN; an approval or the creation is not one', () => {
    reset();
    const base = [e('human:ana', 'g1', 'sound new beep voice=classic preset=pickup seed=3'), e('human:ana', 'g2', 'sound set beep decay=0.3'), e('agent:claude', 'g3', 'sound set beep decay=0.11')];
    let g = gridVersions(provenanceOf(base, 'beep'));
    expect(g.versions.map((v) => v.label)).toEqual(['v1', 'v2']);
    expect(g.versions.some((v) => v.current)).toBe(false);
    expect(g.proposed).toMatchObject({ seq: 3, label: 'agent', current: true, proposed: true });
    g = gridVersions(provenanceOf([...base, e('human:ana', 'g4', 'sound mark beep approved')], 'beep'));
    expect(g.proposed).toBeNull();
    expect(g.versions.at(-1)).toMatchObject({ seq: 3, label: 'v3', current: true });
    // a sound the agent made and nobody touched: its creation is v1, not a proposal
    reset();
    g = gridVersions(provenanceOf([e('agent:claude', 'g1', 'sound new zap voice=classic preset=laser seed=1')], 'zap'));
    expect(g).toMatchObject({ proposed: null, versions: [{ label: 'v1', current: true }] });
  });

  it('restoring an earlier render makes it the newest version', () => {
    reset();
    const tape = [e('human:ana', 'g1', 'sound new beep voice=classic preset=pickup seed=3'), e('human:ana', 'g2', 'sound set beep decay=0.3'), e('agent:claude', 'g3', 'sound set beep decay=0.4'), e('human:ana', 'g4', 'sound set beep decay=0.3')];
    const g = gridVersions(provenanceOf(tape, 'beep'));
    expect(g.versions.map((v) => [v.label, v.seq, v.current])).toEqual([['v1', 1, false], ['v2', 3, false], ['v3', 4, true]]);
  });
});

describe('versions of a sound that plays a sample', () => {
  const H1 = 'a'.repeat(64);
  const H2 = 'b'.repeat(64);
  const add = (name: string, hash: string) => `sample add ${name} hash=${hash} rate=44100 channels=1 frames=1000 format=pcm16`;

  it('a name pointed at other audio is a new version, and each version keeps the audio the name stood for then', () => {
    reset();
    const tape = [
      e('agent:claude', 'g1', add('knock', H1)),
      e('agent:claude', 'g2', add('knock2', H2)),
      e('agent:claude', 'g3', 'sound new door voice=layered seed=1'),
      e('agent:claude', 'g4', 'layer add door sample sample=knock'),
      e('human:ana', 'g5', `sample set knock hash=${H2} rate=44100 channels=1 frames=1000 format=pcm16`),
      e('human:ana', 'g6', 'sample set knock root=C4'), // metadata: not a different render
    ];
    const p = provenanceOf(tape, 'door');
    expect(p.snapshots.map((s) => [s.seq, s.samples])).toEqual([
      [3, []],
      [4, [{ name: 'knock', sha256: H1 }]],
      [5, [{ name: 'knock', sha256: H2 }]],
    ]);
    expect(new Set(p.snapshots.map((s) => s.key)).size).toBe(3);
    // the grid shows v1 with its old audio and v2 with the new
    const g = gridVersions(p, 4);
    expect(g.versions.map((v) => [v.label, v.samples.map((x) => x.sha256 === H1 ? 'old' : x.sha256 === H2 ? 'new' : '-').join('')])).toEqual([['v1', ''], ['v2', 'old'], ['v3', 'new']]);
  });
  it('undoing the repoint brings the old audio back as a version that is the same render as before', () => {
    reset();
    const tape = [
      e('agent:claude', 'g1', add('knock', H1)),
      e('agent:claude', 'g2', 'sound new door voice=layered seed=1'),
      e('agent:claude', 'g3', 'layer add door sample sample=knock'),
      e('human:ana', 'g4', add('other', H2)),
      e('human:ana', 'g5', `sample set knock hash=${H2} rate=44100 channels=1 frames=1000 format=pcm16`),
      e('human:ana', 'g6', 'undo group=g5'),
    ];
    const p = provenanceOf(tape, 'door');
    expect(p.snapshots.map((s) => s.samples.map((x) => x.sha256).join())).toEqual(['', H1]);
  });
});
