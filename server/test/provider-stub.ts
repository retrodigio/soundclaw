// A local stand-in for the ElevenLabs API, for tests: it answers the sound effects, music and subscription endpoints on 127.0.0.1 with audio
// made here, and records every request. Nothing reaches a real provider; the key it expects is a made-up value the tests hand it.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pcmFromFloats } from '@soundclaw/core';

export interface StubRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  key: string | undefined;
  body: Record<string, unknown> | null;
}

export interface StubOptions {
  /** The key it accepts (other keys get 401). */
  key: string;
  /** How the stub reports a call's cost: the character-cost header (default), only the account counter, or not at all. */
  cost?: 'header' | 'counter' | 'none';
  /** Answer the generation endpoints with this status and body instead of audio. */
  fail?: { status: number; body: string };
  /** Fail from this call on (counting from 1). */
  failFrom?: number;
  /** Bytes to answer with for mp3 output (a real MP3 made by ffmpeg, when the test has one). */
  mp3?: Uint8Array;
}

export interface Stub {
  url: string;
  requests: StubRequest[];
  /** The account counter (credits used so far). */
  counter(): number;
  close(): Promise<void>;
}

/** A tone of the given length, as raw 16-bit little-endian PCM at 44.1 kHz (what pcm_44100 sends). */
export function stubPcm(seconds: number, freq = 330): Uint8Array {
  const n = Math.round(seconds * 44100);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.4 * Math.sin((2 * Math.PI * freq * i) / 44100) * Math.min(1, (n - i) / 441);
  return pcmFromFloats([x], 44100, 'pcm16').data;
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    req.on('data', (d: Buffer) => parts.push(d));
    req.on('end', () => {
      if (!parts.length) { resolve(null); return; }
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown>); } catch { resolve(null); }
    });
  });
}

export async function startStub(o: StubOptions): Promise<Stub> {
  const requests: StubRequest[] = [];
  let used = 1000;
  let calls = 0;
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      const key = req.headers['xi-api-key'] as string | undefined;
      const body = await readJson(req);
      requests.push({ method: req.method ?? '', path: url.pathname, query: Object.fromEntries(url.searchParams), key, body });
      if (key !== o.key) {
        // a real service would never echo a key; this one does, so the tests can see it is taken out of every message
        res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ detail: { status: 'invalid_api_key', message: `Invalid API key: ${key}` } }));
        return;
      }
      if (url.pathname === '/v1/user/subscription' && req.method === 'GET') {
        if (o.cost === 'none') { res.writeHead(503).end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ tier: 'creator', character_count: used, character_limit: 100000 }));
        return;
      }
      const sfx = url.pathname === '/v1/sound-generation';
      const music = url.pathname === '/v1/music';
      if ((!sfx && !music) || req.method !== 'POST') { res.writeHead(404).end(); return; }
      calls++;
      if (o.fail && (o.failFrom === undefined || calls >= o.failFrom)) {
        res.writeHead(o.fail.status, { 'Content-Type': 'application/json' }).end(o.fail.body.replaceAll('$KEY', key ?? ''));
        return;
      }
      const seconds = sfx ? Number(body?.duration_seconds ?? 2) : Number(body?.music_length_ms ?? 30000) / 1000;
      const cost = Math.ceil(seconds * (sfx ? 10 : 27.4));
      used += cost;
      const format = url.searchParams.get('output_format') ?? 'mp3_44100_128';
      const headers: Record<string, string> = { 'request-id': `req${String(calls).padStart(4, '0')}`, 'Content-Type': format.startsWith('pcm') ? 'application/octet-stream' : 'audio/mpeg' };
      if ((o.cost ?? 'header') === 'header') headers['character-cost'] = String(cost);
      if (format.startsWith('mp3')) {
        if (!o.mp3) { res.writeHead(422).end(JSON.stringify({ detail: { message: 'this stub has no MP3' } })); return; }
        res.writeHead(200, headers).end(Buffer.from(o.mp3));
        return;
      }
      res.writeHead(200, headers).end(Buffer.from(stubPcm(seconds, 220 + calls * 55)));
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    counter: () => used,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
