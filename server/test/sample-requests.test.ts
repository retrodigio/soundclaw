// A request may be about a sample itself (its item is `sample:<name>`): filed by a person, handed to the agent with the sample's numbers and what plays it,
// claimed and finished without a check gate (a sample is material), while a request on a sound that plays the sample still works as before.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pcmFromFloats } from '@soundclaw/core';
import { agentWork, importPath, personRequest, readRequests, requestBrief, requestLine, toPersonRequest, reviewOf } from '../src/index.ts';
import { toneFloats } from '../../core/test/sample-golden-table.ts';
import { wavBytes } from '../../core/test/audio-fixtures.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
const claude = 'agent:claude';
beforeEach(() => {
  f = fixture();
  const p = join(f.root, 'creak.wav');
  writeFileSync(p, wavBytes(pcmFromFloats([toneFloats(44100, 1)], 44100, 'pcm16')));
  importPath(f.w, p, { by: claude, licence: 'own' });
  f.w.run({ commands: 'sound new door voice=layered; layer add door sample sample=creak', by: claude });
});
afterEach(() => f.clean());

const ask = (note = 'shorter and drier', item = 'sample:creak', extra: Record<string, unknown> = {}) => personRequest(f.w, 'human:ana', { action: 'request', kind: 'change', sound: item, note, ...extra } as never);

describe('a request on a sample', () => {
  it('is filed without a mark and read back with the sample as the item', () => {
    const tape = f.w.tape().length;
    const q = ask();
    expect(q).toMatchObject({ id: 'r1', sound: 'sample:creak', state: 'open', by: 'human:ana' });
    expect(q.mark).toBeUndefined();
    expect(f.w.tape()).toHaveLength(tape);
    expect(requestLine(q)).toContain('r1 change sample:creak: "shorter and drier"');
  });
  it('refuses a missing sample, a bad item, tags and a target that is not time', () => {
    expect(() => ask('x', 'sample:nope')).toThrow(/no sample 'nope'/);
    expect(() => ask('x', 'sample:')).toThrow(/not a sample item/);
    expect(() => ask('x', 'sample:creak', { tags: ['too loud'] })).toThrow(/quick tags are for sounds and songs/);
    expect(() => ask('x', 'sample:creak', { target: { kind: 'layer', layer: 1 } })).toThrow(/range|item/);
    expect(readRequests(f.w.project).size).toBe(0);
  });
  it('takes a pinned stretch of time', () => {
    const q = ask('the first half', 'sample:creak', { target: { kind: 'range', start: 0, end: 0.5 } });
    expect(requestLine(q)).toContain('pinned to 0–0.5 s');
  });
  it('is handed to the agent with the sample\'s numbers and what plays it, and finishes with no check gate', () => {
    ask();
    const c = agentWork(f.w, claude, { action: 'next' });
    expect(c.message).toBe('claimed r1');
    const brief = requestBrief(f.w, readRequests(f.w.project).get('r1')!);
    expect(brief).toContain('the sample now:');
    expect(brief).toMatch(/creak:/);
    expect(brief).toContain('it is played by: sound door');
    expect(brief).toContain('sample derive <new> from=creak');
    const d = agentWork(f.w, claude, { action: 'done', text: 'made creak_short and pointed door at it' });
    expect(d.request).toMatchObject({ state: 'done' });
  });
  it('is not done when the sample is gone', () => {
    ask();
    agentWork(f.w, claude, { action: 'next' });
    f.w.run({ commands: 'sound remove door; sample remove creak', by: claude });
    expect(() => agentWork(f.w, claude, { action: 'done', text: 'x' })).toThrow(/sample 'creak' no longer exists/);
  });
  it('has no review page, and says where the request is shown', () => {
    ask();
    agentWork(f.w, claude, { action: 'next' });
    agentWork(f.w, claude, { action: 'done', text: 'ok' });
    expect(() => reviewOf(f.w, { request: 'r1' })).toThrow(/about a sample.*creak's page/);
  });
  it('is the shape the CLI and MCP give a person request', () => {
    expect(toPersonRequest({ sound: 'sample:creak', note: 'drier' })).toMatchObject({ action: 'request', sound: 'sample:creak', note: 'drier' });
  });
  it('leaves the sound-level route working: a request on the sound that plays it', () => {
    const q = personRequest(f.w, 'human:ana', { action: 'request', kind: 'change', sound: 'door', note: 'About sample creak: shorter' });
    expect(q).toMatchObject({ sound: 'door', mark: expect.any(Number) });
  });
});

describe('keeping a take records where it came from', () => {
  it('writes kept-from into the provenance, which survives a tag edit and shows in the info', () => {
    f.w.run({ commands: 'sample set creak kept-from=creak_t2 tags=kept', by: 'human:ana' });
    f.w.run({ commands: 'sample set creak tags=none', by: 'human:ana' });
    const info = f.w.samples.list().find((x) => x.name === 'creak')!;
    expect(info.keptFrom).toBe('creak_t2');
    expect(info.tags).toEqual([]);
    expect(f.reopen().samples.list().find((x) => x.name === 'creak')!.keptFrom).toBe('creak_t2');
  });
  it('refuses a value that is not a sample name', () => {
    const r = f.w.run({ commands: 'sample set creak kept-from="a b"', by: 'human:ana' });
    expect(r.ok).toBe(false);
  });
});
