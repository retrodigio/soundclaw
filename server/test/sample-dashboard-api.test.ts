// What the dashboard's sample views read: a sample's card (numbers and a small waveform, worked out in a worker once per audio), the sample page's
// detail (provenance, licence and why, what uses it), the registered libraries, a page of library hits, and a library file used as a person.

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeMeasure, pcmFromFloats, pcmHash } from '@soundclaw/core';
import { addLibrary, importPath, indexLibrary } from '../src/index.ts';
import { startWatchServer, type WatchServer } from '../src/http.ts';
import { buildSampleCard } from '../src/samplecards.ts';
import { makeBigLibrary, makeSmallLibrary, wavOf } from './library-fixtures.ts';
import { toneFloats } from '../../core/test/sample-golden-table.ts';
import { wavBytes } from '../../core/test/audio-fixtures.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
let server: WatchServer;
let lib: string;
let outside: string;
const saved = { cfg: process.env.SOUNDCLAW_CONFIG_DIR, cache: process.env.SOUNDCLAW_CACHE_DIR };
beforeEach(async () => {
  f = fixture();
  process.env.SOUNDCLAW_CONFIG_DIR = join(f.root, 'config');
  process.env.SOUNDCLAW_CACHE_DIR = join(f.root, 'cache');
  lib = join(f.root, 'cellar-foley');
  outside = join(f.root, 'outside');
  mkdirSync(lib, { recursive: true });
  mkdirSync(outside, { recursive: true });
  server = await startWatchServer({ writer: f.w, token: 'tok', port: 0 });
});
afterEach(async () => {
  await server.close();
  await f.w.thumbs.close();
  await f.w.sampleCards.close();
  f.clean();
  if (saved.cfg === undefined) delete process.env.SOUNDCLAW_CONFIG_DIR; else process.env.SOUNDCLAW_CONFIG_DIR = saved.cfg;
  if (saved.cache === undefined) delete process.env.SOUNDCLAW_CACHE_DIR; else process.env.SOUNDCLAW_CACHE_DIR = saved.cache;
});

const url = (path: string, q: Record<string, string> = {}, token = 'tok'): string => `http://127.0.0.1:${server.port}${path}?${new URLSearchParams({ ...(token ? { token } : {}), ...q })}`;
const get = async (path: string, q: Record<string, string> = {}) => (await fetch(url(path, q))).json() as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function toneSample(name: string, licence = 'own'): string {
  const p = join(f.root, `${name}.wav`);
  writeFileSync(p, wavBytes(pcmFromFloats([toneFloats(44100, 1)], 44100, 'pcm16')));
  return importPath(f.w, p, { by: 'agent:claude', licence }).items[0]!.info.sha256;
}

describe('GET /api/sample-card/<hash>.json', () => {
  it('has the numbers and a small waveform, worked out once in a worker and kept on disk', async () => {
    const hash = toneSample('tone');
    const r = await fetch(url(`/api/sample-card/${hash}.json`));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    const card = (await r.json()) as { hash: string; measure: unknown; peaks: { min: number[]; max: number[] } };
    expect(card.hash).toBe(hash);
    const m = decodeMeasure(card.measure);
    expect(m.duration).toBeCloseTo(1, 2);
    expect(m.rate).toBe(44100);
    expect(m.pitch?.note).toMatch(/^[A-G]/);
    expect(card.peaks.max).toHaveLength(96);
    expect(Math.max(...card.peaks.max)).toBeGreaterThan(0.1);
    expect(f.w.sampleCards.built).toBe(1);
    // asked again, from the disk and the memory: nothing is measured twice
    await get(`/api/sample-card/${hash}.json`);
    expect(f.w.sampleCards.built).toBe(1);
    expect(readdirSync(join(f.w.project.dir, '.cache', 'samplecards'))).toEqual([`${hash}.json`]);
    // the same bytes as building it here
    const audio = f.w.samples.store.audio(hash)!;
    expect(pcmHash(audio)).toBe(hash);
    expect(JSON.parse(JSON.stringify(buildSampleCard(hash, audio)))).toEqual(card);
  });

  it('wants the token, a real hash and an object that exists', async () => {
    const hash = toneSample('tone');
    expect((await fetch(url(`/api/sample-card/${hash}.json`, {}, ''))).status).toBe(401);
    expect((await fetch(url(`/api/sample-card/${'0'.repeat(64)}.json`))).status).toBe(404);
    expect((await fetch(url('/api/sample-card/nothing.json'))).status).not.toBe(200);
    expect((await fetch(url(`/api/sample-card/${hash}.json`), { headers: { 'If-None-Match': `"${hash}"` } })).status).toBe(304);
  });
});

describe('GET /api/sample-detail/<name>.json', () => {
  it('says where a sample came from, how its licence stands and why, and what uses it', async () => {
    const hash = toneSample('tone', 'unknown');
    const a = await get('/api/sample-detail/tone.json');
    expect(a.info).toMatchObject({ name: 'tone', sha256: hash, licenceState: 'unknown', source: 'file', author: 'agent:claude' });
    expect(a.prov).toMatchObject({ source: 'file', origin: 'tone.wav', author: 'agent:claude' });
    expect(a.licence.state).toBe('unknown');
    expect(a.licence.reason).toMatch(/not known/);
    expect(a.usedBy).toEqual({ sounds: [], instruments: [], songs: [], samples: [] });
    const run = f.w.run({ commands: [
      'sample derive tone_soft from=tone op="gain -6"',
      'sound new knock voice=layered seed=1', 'layer add knock sample sample=tone_soft',
      'instrument new pad kind=zones', 'instrument zone add pad sample=tone root=A3 keys=A2-A4',
    ].join('\n'), by: 'agent:claude' });
    expect(run.ok, JSON.stringify(run)).toBe(true);
    const b = await get('/api/sample-detail/tone.json');
    // a sound that plays only the derived sample reaches the parent too
    expect(b.usedBy).toEqual({ sounds: ['knock'], instruments: ['pad'], songs: [], samples: ['tone_soft'] });
    const d = await get('/api/sample-detail/tone_soft.json');
    expect(d.prov.parents).toEqual([{ hash, name: 'tone' }]);
    expect(d.prov.ops).toMatch(/gain -6/);
    expect(d.usedBy.sounds).toEqual(['knock']);
    expect((await fetch(url('/api/sample-detail/nothing.json'))).status).toBe(404);
    expect((await fetch(url('/api/sample-detail/tone.json', {}, ''))).status).toBe(401);
  });

  it('the list a page keeps says who added a sample, when, and for generated audio the prompt, the take and the credits', async () => {
    toneSample('tone');
    const g = f.w.run({ commands: `sample add made hash=${pcmHash(f.w.samples.store.audio(f.w.samples.entry('tone')!.hash)!)} rate=44100 channels=1 frames=44100 format=pcm16 source=generated provider=fake prompt="a slow creak of a hinge" take=2/3 credits=12 licence=generated:fake:free`, by: 'agent:claude' });
    expect(g.ok, JSON.stringify(g)).toBe(true);
    const list = (await get('/api/samples')) as { name: string; author?: string; date?: string; prompt?: string; take?: string; credits?: number }[];
    const made = list.find((x) => x.name === 'made')!;
    expect(made).toMatchObject({ author: 'agent:claude', prompt: 'a slow creak of a hinge', take: '2/3', credits: 12 });
    expect(made.date).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(list.find((x) => x.name === 'tone')!.prompt).toBeUndefined();
  });
});

describe('the library routes', () => {
  it('list the registered libraries, a page of hits with the numbers a row shows, and copy a file in as a person', async () => {
    makeSmallLibrary(lib, outside);
    addLibrary(lib, { licence: 'CC0-1.0' });
    expect(await get('/api/libraries')).toMatchObject([{ id: 'cellar-foley', licence: 'CC0-1.0', declared: 'flags', files: null }]);
    await indexLibrary('cellar-foley', { workers: 0 });
    expect((await get('/api/libraries'))[0].files).toBeGreaterThan(5);
    const r = await get('/api/library/search', { q: 'door creak dur=1-3', library: 'cellar-foley' });
    expect(r.total).toBeGreaterThanOrEqual(2);
    expect(r.hits[0]).toMatchObject({ licence: 'CC0-1.0', state: 'shippable' });
    expect(r.hits[0].ref).toMatch(/^cellar-foley:doors\/creak_0[12]\.wav$/);
    expect(r.hits[0].dur).toBeGreaterThan(1);
    // nothing is copied into the project by looking
    expect(f.w.samples.names()).toEqual([]);
    expect((await fetch(url('/api/library/search', { q: 'zzz' }, ''))).status).toBe(401);
    expect((await fetch(url('/api/library/search', { q: 'dur>' }))).status).toBe(400);
    // use one: a person's command with the library's licence and where it came from
    const use = await fetch(url('/api/library/use'), { method: 'POST', body: JSON.stringify({ ref: 'cellar-foley:doors/creak_01.wav', as: 'creak_lib', by: 'human:ana' }) });
    expect(use.status).toBe(200);
    expect(((await use.json()) as { items: { name: string }[] }).items[0]!.name).toBe('creak_lib');
    const e = f.w.samples.entry('creak_lib')!;
    expect(e).toMatchObject({ licence: { id: 'CC0-1.0' }, prov: { source: 'library', origin: 'cellar-foley:doors/creak_01.wav', author: 'human:ana' } });
    // an agent's name is not a person's, a bad reference is a plain error, and the token is needed
    expect((await fetch(url('/api/library/use'), { method: 'POST', body: JSON.stringify({ ref: 'cellar-foley:doors/creak_01.wav', by: 'agent:claude' }) })).status).toBe(400);
    expect((await fetch(url('/api/library/use'), { method: 'POST', body: JSON.stringify({ ref: 'cellar-foley:../x.wav', by: 'human:ana' }) })).status).toBe(400);
    expect((await fetch(url('/api/library/use', {}, ''), { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('pages the hits: 48 at a time from an offset', async () => {
    makeBigLibrary(lib, 130);
    addLibrary(lib, { licence: 'CC0-1.0' });
    await indexLibrary('cellar-foley', { workers: 0 });
    const first = await get('/api/library/search', { q: '', limit: '48' });
    expect(first.total).toBe(130);
    expect(first.hits).toHaveLength(48);
    const third = await get('/api/library/search', { q: '', limit: '48', offset: '96' });
    expect(third.offset).toBe(96);
    expect(third.hits).toHaveLength(34);
    expect(new Set([...first.hits, ...third.hits].map((h: { ref: string }) => h.ref)).size).toBe(82);
  });
});

void wavOf;
