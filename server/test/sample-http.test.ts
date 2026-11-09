// The server's sample routes: audio by hash (immutable), the list, and an uploaded file read in a worker and named on the tape.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pcmHash, decodeAudio } from '@soundclaw/core';
import { importPath } from '../src/index.ts';
import { startWatchServer, type WatchServer } from '../src/http.ts';
import { aiffBytes, flacBytes, channelInts, makeAudio, wavBytes } from '../../core/test/audio-fixtures.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
let server: WatchServer;
beforeEach(async () => {
  f = fixture();
  server = await startWatchServer({ writer: f.w, token: 'tok', port: 0 });
});
afterEach(async () => { await server.close(); await f.w.thumbs.close(); f.clean(); });

const url = (path: string, q: Record<string, string> = {}, token = 'tok'): string => `http://127.0.0.1:${server.port}${path}?${new URLSearchParams({ ...(token ? { token } : {}), ...q })}`;
const upload = (bytes: Uint8Array, q: Record<string, string>) => fetch(url('/api/samples/import', { by: 'human:ana', ...q }), { method: 'POST', body: bytes });

describe('GET /api/sample-object/<hash>', () => {
  it('serves the stored audio by its hash, for ever cacheable, only with the token', async () => {
    const a = makeAudio('pcm24', 2, 1200, 48000);
    const p = join(f.root, 'a.wav');
    writeFileSync(p, wavBytes(a));
    const hash = importPath(f.w, p, { by: 'agent:claude' }).items[0]!.info.sha256;
    const r = await fetch(url(`/api/sample-object/${hash}`));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(r.headers.get('etag')).toBe(`"${hash}"`);
    expect(r.headers.get('content-type')).toBe('audio/wav');
    // what the page gets decodes to the audio, hash and all
    expect(pcmHash(decodeAudio(new Uint8Array(await r.arrayBuffer())).audio)).toBe(hash);
    expect((await fetch(url(`/api/sample-object/${'0'.repeat(64)}`))).status).toBe(404);
    expect((await fetch(url(`/api/sample-object/${hash}`, {}, ''))).status).toBe(401);
    expect((await fetch(url('/api/sample-object/not-a-hash'))).status).not.toBe(200);
    // the list the page keeps names them by hash
    const list = (await (await fetch(url('/api/samples'))).json()) as { name: string; sha256: string }[];
    expect(list.map((x) => [x.name, x.sha256])).toEqual([['a', hash]]);
  });
});

describe('POST /api/samples/import', () => {
  it('reads an uploaded WAV, AIFF or FLAC, names it on the tape as the person, with the licence they chose', async () => {
    const a = makeAudio('pcm16', 2, 3000, 44100, 8);
    const r = await upload(wavBytes(a), { name: 'My Loop.wav', licence: 'own', tags: 'loop' });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { group: string; items: { name: string; hash: string; created: boolean }[] };
    expect(j.items).toMatchObject([{ name: 'My_Loop', hash: pcmHash(a), created: true }]);
    const e = f.w.tape().find((t) => t.group === j.group)!;
    expect(e.by).toBe('human:ana');
    expect(e.cmd).toContain('licence=own');
    expect(f.w.samples.entry('My_Loop')).toMatchObject({ tags: ['loop'], prov: { source: 'file', origin: 'My Loop.wav', author: 'human:ana' } });
    // the same audio from an AIFF and a FLAC: one object, new names
    const aiff = await upload(aiffBytes(a), { name: 'loop.aiff' });
    expect(aiff.status).toBe(200);
    const flac = await upload(flacBytes([channelInts(a, 0), channelInts(a, 1)], 16, 44100, { kind: 'fixed2' }), { name: 'loop.flac' });
    expect(flac.status).toBe(200);
    expect(f.w.samples.store.list()).toHaveLength(1);
    expect(f.w.samples.list().map((s) => s.name)).toEqual(['loop', 'My_Loop']);
  });
  it('keeps only the last part of a file name, and refuses what is not audio, a bad author, or a name that is taken', async () => {
    const wav = wavBytes(makeAudio('pcm16', 1, 800));
    expect((await upload(wav, { name: '../../etc/passwd/evil name.wav' })).status).toBe(200);
    expect(f.w.samples.list().map((s) => s.name)).toEqual(['evil_name']);
    expect(f.w.samples.entry('evil_name')!.prov.origin).toBe('evil name.wav');
    const junk = await upload(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]), { name: 'junk.wav' });
    expect(junk.status).toBe(400);
    expect(((await junk.json()) as { error: string }).error).toMatch(/not a WAV, AIFF or FLAC/);
    const noOne = await fetch(url('/api/samples/import', { by: 'agent:claude', name: 'x.wav' }), { method: 'POST', body: wav });
    expect(noOne.status).toBe(400);
    expect(((await noOne.json()) as { error: string }).error).toMatch(/human:<name>/);
    const clash = await upload(wavBytes(makeAudio('pcm16', 1, 900, 44100, 2)), { name: 'x.wav', as: 'evil_name' });
    expect(clash.status).toBe(400);
    expect(((await clash.json()) as { error: string }).error).toMatch(/exists with other audio/);
    expect((await fetch(url('/api/samples/import', { by: 'human:ana' }, ''), { method: 'POST', body: wav })).status).toBe(401);
    const big = await fetch(url('/api/samples/import', { by: 'human:ana' }), { method: 'POST', body: wav, headers: { 'content-length': String(201 * 1024 * 1024) } }).catch(() => null);
    if (big) expect([413, 400]).toContain(big.status);
    expect(f.w.samples.list()).toHaveLength(1);
  });
});
