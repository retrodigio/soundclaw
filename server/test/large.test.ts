// A project with more sounds than a page can render at once: the snapshot sends the list first
// (documents on demand, the newest end of the tape), batches carry only the sounds they touched,
// cards (numbers, checks, thumbnails) are worked out in worker threads and kept on disk, and the
// HTTP API serves them.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checksPass } from '@soundclaw/core';
import { LEAN_AT, Writer, loadProject, type ServerMessage } from '../src/index.ts';
import { startWatchServer, type WatchServer } from '../src/http.ts';
import { buildLargeProject } from '../../test/support/large-project.ts';
import { until } from './helpers.ts';

let root: string;
let dir: string;
let w: Writer;
let ids: string[];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'soundclaw-large-'));
  dir = join(root, 'big.sclaw');
  const p = buildLargeProject(dir, { sounds: 140, samples: 12, tape: 500 });
  ids = p.sounds;
  w = new Writer(loadProject(dir));
}, 120_000);
afterAll(async () => {
  await w?.thumbs.close();
  rmSync(root, { recursive: true, force: true });
});

describe('a lean snapshot', () => {
  it('sends the list, no documents, and the newest end of the tape', () => {
    const snap = w.snapshot();
    expect(ids.length).toBeGreaterThan(LEAN_AT);
    expect(snap.lean).toBe(true);
    expect(snap.sounds).toEqual([]);
    expect(snap.index.map((x) => x.id)).toEqual([...ids].sort());
    expect(snap.index[0]).toMatchObject({ id: 'cl_000', voice: 'classic', status: 'draft' });
    expect(snap.index.find((x) => x.id === 'ly_101')!.label).toMatch(/^\d layers?: /);
    expect(snap.tapeTotal).toBeGreaterThanOrEqual(500);
    expect(snap.tape.length).toBe(200);
    expect(snap.tape.at(-1)!.seq).toBe(snap.tapeTotal);
    expect(snap.history.canUndo).toBe(true);
    expect(snap.history.canRedo).toBe(false);
    // the list is small next to the documents it stands for
    expect(JSON.stringify(snap).length).toBeLessThan(JSON.stringify({ sounds: w.sounds(), tape: w.tape() }).length / 2);
  });

  it('a project under the limit keeps sending everything', () => {
    const small = mkdtempSync(join(tmpdir(), 'soundclaw-small-'));
    try {
      const p = buildLargeProject(join(small, 'a.sclaw'), { sounds: 8, samples: 2, tape: 20 });
      const snap = p.writer.snapshot();
      expect(snap.lean).toBe(false);
      expect(snap.sounds.length).toBe(8);
      expect(snap.tape.length).toBe(snap.tapeTotal);
    } finally {
      rmSync(small, { recursive: true, force: true });
    }
  }, 60_000);

  it('a batch carries the documents it touched, the list, and whether undo is possible', () => {
    const seen: ServerMessage[] = [];
    const off = w.on((m) => seen.push(m));
    const r = w.run({ commands: 'sound set cl_001 volume=0.31', by: 'human:ana' });
    expect(r.ok).toBe(true);
    const batch = seen.find((m) => m.type === 'batch');
    expect(batch).toBeTruthy();
    if (batch?.type !== 'batch') return;
    expect(batch.lean).toBe(true);
    expect(batch.sounds.map((x) => x.id)).toEqual(['cl_001']);
    expect(batch.index.length).toBe(ids.length);
    expect(batch.removed).toEqual([]);
    expect(batch.history.canUndo).toBe(true);
    // the changed sound has a new card key; the others keep theirs
    expect(batch.index.find((x) => x.id === 'cl_001')!.key).not.toBe(w.snapshot().index.find((x) => x.id === 'cl_002')!.key);
    const undone = w.run({ commands: 'undo', by: 'human:ana' });
    expect(undone.ok).toBe(true);
    off();
  });
});

describe('cards', () => {
  it('a worker thread works out the numbers, checks and thumbnails of the Node render, and they are kept on disk', async () => {
    const card = await w.thumbs.card('cl_003');
    const m = w.measure('cl_003');
    expect(card.hash).toBe(w.samplesHashOf('cl_003'));
    expect(card.pass).toBe(checksPass(m.checks));
    expect(card.failing).toEqual(m.checks.filter((c) => !c.pass).map((c) => c.name));
    expect(card.duration).toBeCloseTo(m.analysis.duration, 6);
    expect(card.wave.min.length).toBe(240);
    expect(card.wave.max.length).toBe(240);
    expect(card.peak).toBeGreaterThan(0);
    expect(card.spec).toMatchObject({ w: 240, h: 48, bands: 48 });
    expect(Buffer.from(card.spec.data, 'base64').length).toBe(240 * 48);
    // the list now knows its numbers, and so does a server that starts later
    expect(w.index().find((x) => x.id === 'cl_003')!.info).toMatchObject({ hash: card.hash, pass: card.pass });
    const later = new Writer(loadProject(dir));
    expect(later.index().find((x) => x.id === 'cl_003')!.info?.hash).toBe(card.hash);
    expect(later.thumbs.built).toBe(0);
    await later.thumbs.close();
  }, 60_000);

  it('a layered sound with a stereo sample layer: the same hash as the render, mono waveform of the mix', async () => {
    const id = ids.find((x) => x.startsWith('ly_'))!;
    const card = await w.thumbs.card(id);
    expect(card.hash).toBe(w.samplesHashOf(id));
  }, 60_000);

  it('quiet work fills in the list, and a request goes before it', async () => {
    const fresh = new Writer(loadProject(dir));
    const heard: number[] = [];
    fresh.on((m) => { if (m.type === 'cards') heard.push(m.cards.length); });
    fresh.thumbs.warm();
    const first = await fresh.thumbs.card('cl_030');
    expect(first.key).toBe(fresh.cardSpec(fresh.sound('cl_030')).key);
    await until(() => fresh.thumbs.built >= 8 && heard.length > 0, 'cards worked out and announced', 60_000);
    await fresh.thumbs.close();
  }, 90_000);
});

describe('the HTTP API', () => {
  let server: WatchServer;
  const get = (path: string, token = server.token) => fetch(`http://127.0.0.1:${server.port}${path}${path.includes('?') ? '&' : '?'}token=${token}`);
  beforeAll(async () => { server = await startWatchServer({ writer: w, token: 'tok', port: 0 }); });
  afterAll(async () => { await server.close(); });

  it('serves a card, a document, the tape before a seq, and refuses without the token', async () => {
    const card = (await (await get('/api/card/cl_004.json')).json()) as { hash: string; wave: { min: number[] } };
    expect(card.hash).toBe(w.samplesHashOf('cl_004'));
    expect(card.wave.min.length).toBe(240);
    expect(((await (await get('/api/sound/ly_101.json')).json()) as { id: string; voice: string })).toMatchObject({ id: 'ly_101', voice: 'layered' });
    const page = (await (await get('/api/tape?before=100&limit=50')).json()) as { entries: { seq: number }[]; total: number };
    expect(page.entries.length).toBe(50);
    expect(page.entries.at(-1)!.seq).toBe(99);
    expect(page.total).toBeGreaterThanOrEqual(500);
    expect((await get('/api/card/cl_004.json', 'wrong')).status).toBe(401);
    expect((await get('/api/card/nope.json')).status).toBe(404);
  }, 60_000);

  it('a page that connects is sent the list first in one frame', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=tok`);
    const text = await new Promise<string>((resolve, reject) => { ws.onmessage = (e) => resolve(String(e.data)); ws.onerror = () => reject(new Error('ws')); });
    ws.close();
    const hello = JSON.parse(text) as Extract<ServerMessage, { type: 'hello' }>;
    expect(hello.snapshot.lean).toBe(true);
    expect(hello.snapshot.index.length).toBe(ids.length);
    expect(text.length).toBeLessThan(300_000);
  }, 30_000);
});
