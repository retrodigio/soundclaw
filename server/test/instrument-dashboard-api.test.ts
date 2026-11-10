// What the dashboard's instrument page and generation panel read: an instrument's check for the key-map (worked out in a worker and kept), and the
// generation status (the budget against the caps, the providers, the ledger), which never carries a key.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { midiFreq, pcmFromFloats, sinRad } from '@soundclaw/core';
import { importPath } from '../src/index.ts';
import { startWatchServer, type WatchServer } from '../src/http.ts';
import { wavBytes } from '../../core/test/audio-fixtures.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
let server: WatchServer;
const saved = { cfg: process.env.SOUNDCLAW_CONFIG_DIR, cache: process.env.SOUNDCLAW_CACHE_DIR, key: process.env.ELEVENLABS_API_KEY };
beforeEach(async () => {
  f = fixture();
  process.env.SOUNDCLAW_CONFIG_DIR = join(f.root, 'config');
  process.env.SOUNDCLAW_CACHE_DIR = join(f.root, 'cache');
  delete process.env.ELEVENLABS_API_KEY;
  mkdirSync(join(f.root, 'config'), { recursive: true });
  server = await startWatchServer({ writer: f.w, token: 'tok', port: 0 });
});
afterEach(async () => {
  await server.close();
  await f.w.thumbs.close();
  await f.w.sampleCards.close();
  f.clean();
  if (saved.cfg === undefined) delete process.env.SOUNDCLAW_CONFIG_DIR; else process.env.SOUNDCLAW_CONFIG_DIR = saved.cfg;
  if (saved.cache === undefined) delete process.env.SOUNDCLAW_CACHE_DIR; else process.env.SOUNDCLAW_CACHE_DIR = saved.cache;
  if (saved.key === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = saved.key;
});

const url = (path: string, token = 'tok'): string => `http://127.0.0.1:${server.port}${path}?${new URLSearchParams(token ? { token } : {})}`;
const steady = (hz: number): Float32Array => Float32Array.from({ length: 44100 }, (_, i) => 0.4 * sinRad((i / 44100) * 6.283185307179586 * hz) + 0.1 * sinRad((i / 44100) * 6.283185307179586 * hz * 2));
function tone(name: string, midi: number): void {
  const p = join(f.root, `${name}.wav`);
  writeFileSync(p, wavBytes(pcmFromFloats([steady(midiFreq(midi))], 44100, 'pcm16')));
  importPath(f.w, p, { by: 'agent:claude', as: name, licence: 'own' });
}

describe('GET /api/instrument-check/<id>.json', () => {
  it('gives each zone its measured pitch and level and the findings, keeps it for the same instrument and works it out again after an edit', async () => {
    tone('c3', 48); tone('g3', 55);
    const r = f.w.run({ commands: 'instrument new harp kind=zones\ninstrument zone add harp sample=c3 root=C3 keys=C2-D#3\ninstrument zone add harp sample=g3 root=G3 keys=E3-B3 tune=40\ninstrument set harp range=C2-B3', by: 'agent:claude' });
    expect(r.ok).toBe(true);
    const a = await (await fetch(url('/api/instrument-check/harp.json'))).json() as { id: string; pass: boolean; zones: { index: number; pitchCents: number | null; lufs: number | null; status: string }[]; findings: { check: string }[]; key: string };
    expect(a.id).toBe('harp');
    expect(a.zones).toHaveLength(2);
    expect(a.zones[0]!.pitchCents).not.toBeNull();
    expect(a.zones[1]!.lufs).not.toBeNull();
    const b = await (await fetch(url('/api/instrument-check/harp.json'))).json() as { key: string };
    expect(b.key).toBe(a.key);
    f.w.run({ commands: 'instrument zone set harp 2 tune=0', by: 'agent:claude' });
    const c = await (await fetch(url('/api/instrument-check/harp.json'))).json() as { key: string; zones: { pitchCents: number | null }[] };
    expect(c.key).not.toBe(a.key);
  });
  it('is behind the token and says when there is no such instrument', async () => {
    expect((await fetch(url('/api/instrument-check/harp.json', ''))).status).toBe(401);
    const r = await fetch(url('/api/instrument-check/nothing.json'));
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toMatch(/no instrument 'nothing'/);
  });
});

describe('GET /api/generation', () => {
  it('says paid generation is off with no cap, lists the providers and whether a key is set (never the key), and the ledger once there is one', async () => {
    process.env.ELEVENLABS_API_KEY = 'sk-test-not-a-real-key-123';
    const g = await (await fetch(url('/api/generation'))).json() as { budget: { projectCap: number; dailyCap: number; maxPerCall: number }; providers: { id: string; paid: boolean; keySet: boolean; kinds: { kind: string; rate: number; held: boolean }[] }[]; recent: unknown[]; paidOff: string | null };
    expect(g.budget).toMatchObject({ projectCap: 0, dailyCap: 3000, maxPerCall: 300 });
    const eleven = g.providers.find((p) => p.id === 'elevenlabs')!;
    expect(eleven).toMatchObject({ paid: true, keySet: true });
    expect(eleven.kinds.find((k) => k.kind === 'sfx')).toMatchObject({ rate: 10, held: false });
    expect(eleven.kinds.find((k) => k.kind === 'music')!.held).toBe(true);
    expect(g.providers.find((p) => p.id === 'fake')).toMatchObject({ paid: false, keySet: true });
    expect(JSON.stringify(g)).not.toContain('sk-test-not-a-real-key');
    expect(g.recent).toEqual([]);
    expect((await fetch(url('/api/generation', ''))).status).toBe(401);
  });
  it('shows what the fake provider spent nothing on, and a person\'s cap', async () => {
    const gen = await fetch(url('/api/generate'), { method: 'POST', body: JSON.stringify({ kind: 'sfx', prompt: 'a short click', pairs: { provider: 'fake', duration: '0.5', takes: '2', as: 'click' }, by: 'human:ana' }) });
    expect(gen.status).toBe(200);
    await fetch(url('/api/generation/cap'), { method: 'POST', body: JSON.stringify({ capCredits: 500, by: 'human:ana' }) });
    const g = await (await fetch(url('/api/generation'))).json() as { budget: { projectCap: number; projectSpent: number }; recent: { provider: string; kind: string; takes: number; prompt: string; charge: number }[]; totals: { commands: number } };
    expect(g.budget).toMatchObject({ projectCap: 500, projectSpent: 0 });
    expect(g.recent[0]).toMatchObject({ provider: 'fake', kind: 'sfx', takes: 2, prompt: 'a short click', charge: 0 });
    expect(g.totals.commands).toBe(1);
  });
});
