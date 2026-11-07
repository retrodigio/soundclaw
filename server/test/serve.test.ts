// A real `soundclaw serve`: MCP over stdio as an agent uses it, the HTTP API, a WebSocket client
// standing in for a page, and other `soundclaw` processes (run, await, work) going through the
// server's writer. Nothing is left running.
import type { ClassicSound } from '@soundclaw/core';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { decodeWav, floatsFromBytes, newSound, renderSound, samplesHash, type Sound } from '@soundclaw/core';
import { LOCK_FILE, tokenFilePath } from '../src/index.ts';
import { BIN, until } from './helpers.ts';

let root: string;
let dir: string;
let env: NodeJS.ProcessEnv;
let server: ChildProcess | null = null;
let client: Client | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'soundclaw-serve-'));
  dir = join(root, 'demo.sclaw');
  env = { ...process.env, SOUNDCLAW_STATE_DIR: join(root, 'state') };
  process.env.SOUNDCLAW_STATE_DIR = join(root, 'state'); // for tokenFilePath in this process
  execFileSync(process.execPath, [BIN, 'new', dir], { env });
});
afterEach(async () => {
  delete process.env.SOUNDCLAW_STATE_DIR;
  await client?.close().catch(() => undefined);
  client = null;
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((r) => server!.once('exit', r));
  }
  server = null;
  rmSync(root, { recursive: true, force: true });
});

interface Done { code: number | null; out: string; err: string }
function cli(args: string[]): Promise<Done> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d: Buffer) => { out += d; });
    c.stderr.on('data', (d: Buffer) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
  });
}

/** Serve without MCP (so stdin may be closed) and return its address. */
async function startServe(): Promise<{ url: string; token: string; port: number }> {
  server = spawn(process.execPath, [BIN, 'serve', '--project', dir, '--port', '0', '--no-mcp'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  server.stderr!.on('data', (d: Buffer) => { err += d; });
  await until(() => /watch at (\S+)/.test(err), 'the watch URL');
  const url = /watch at (\S+)/.exec(err)![1]!;
  return { url, token: new URL(url).searchParams.get('token')!, port: Number(new URL(url).port) };
}

describe('the server process', () => {
  it('writes a lock without the token and a private token file, and removes both on stop', async () => {
    const s = await startServe();
    const lock = JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8')) as { pid: number; url: string };
    expect(lock.pid).toBe(server!.pid);
    expect(JSON.stringify(lock)).not.toContain(s.token);
    const tf = tokenFilePath(dir);
    expect(JSON.parse(readFileSync(tf, 'utf8'))).toMatchObject({ pid: server!.pid, token: s.token });
    if (process.platform !== 'win32') expect(statSync(tf).mode & 0o777).toBe(0o600);
    // A second server on the same folder is refused.
    const second = spawn(process.execPath, [BIN, 'serve', '--project', dir, '--port', '0', '--no-mcp'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    second.stderr!.on('data', (d: Buffer) => { err += d; });
    await new Promise((r) => second.once('exit', r));
    expect(err).toMatch(/another soundclaw server/);
    server!.kill('SIGTERM');
    await new Promise((r) => server!.once('exit', r));
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    expect(existsSync(tf)).toBe(false);
  });

  it('serves the API only with the token, and only to localhost names', async () => {
    const s = await startServe();
    const base = `http://127.0.0.1:${s.port}`;
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    expect((await fetch(`${base}/api/state?token=wrong`)).status).toBe(401);
    expect((await fetch(`${base}/api/render/beep.wav`)).status).toBe(401);
    expect((await fetch(`${base}/mcp`, { method: 'POST' })).status).toBe(401);
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(401);
    expect(await page.text()).toContain('token required');
    // fetch will not set Host; a raw request can.
    const evil = await new Promise<number>((resolve) => {
      request({ host: '127.0.0.1', port: s.port, path: `/api/state?token=${s.token}`, headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).end();
    });
    expect(evil).toBe(421);
    expect((await fetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${s.token}` } })).status).toBe(200);
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
  });

  it('serves the sound as the server renders it: the same samples as core, as float32 and as WAV', async () => {
    const s = await startServe();
    expect((await cli(['run', dir, '-e', 'sound new beep; sound set beep frequency=659.25 duration=0.3 volume=0.8'])).code).toBe(0);
    const doc: Sound = { ...newSound('beep'), frequency: 659.25, duration: 0.3, volume: 0.8 };
    const want = renderSound(doc);
    const f32 = new Uint8Array(await (await fetch(`http://127.0.0.1:${s.port}/api/render/beep.f32?token=${s.token}`)).arrayBuffer());
    expect(samplesHash(floatsFromBytes(f32))).toBe(samplesHash(want));
    const wav = new Uint8Array(await (await fetch(`http://127.0.0.1:${s.port}/api/render/beep.wav?token=${s.token}`)).arrayBuffer());
    expect(decodeWav(wav)).toMatchObject({ channels: 1, sampleRate: 44100, bitsPerSample: 16, frames: want.length });
    expect((await fetch(`http://127.0.0.1:${s.port}/api/render/nope.wav?token=${s.token}`)).status).toBe(404);
  });

  it('commands from other processes go through the server, and a connected page sees them live', async () => {
    const s = await startServe();
    const ws = new WebSocket(s.url.replace('http', 'ws').replace('/?token', '/ws?token'));
    const messages: { type: string; [k: string]: unknown }[] = [];
    ws.onmessage = (ev) => messages.push(JSON.parse(String(ev.data)));
    await until(() => messages.some((m) => m.type === 'hello'), 'hello');
    const run = await cli(['run', dir, '-e', 'sound new beep voice=classic; sound set beep wave=sine attack=0.05 sustain=0.3 decay=0.4 freq=0.3 volume=0.15', '--by', 'claude']);
    expect(run.code, run.err).toBe(0);
    await until(() => messages.some((m) => m.type === 'batch'), 'the batch');
    const batch = messages.find((m) => m.type === 'batch') as unknown as { by: string; group: string; entries: { cmd: string }[]; sounds: Sound[] };
    expect(batch).toMatchObject({ by: 'agent:claude', group: 'g1' });
    expect(batch.entries.map((e) => e.cmd)).toEqual(['sound new beep voice=classic', 'sound set beep wave=sine attack=0.05 sustain=0.3 decay=0.4 freq=0.3 volume=0.15']);
    expect(batch.sounds.map((x) => [x.id, (x as ClassicSound).patch.freq])).toEqual([['beep', 0.3]]);
    // A person's edit from the page is written as the page's human, then undone from the CLI.
    ws.send(JSON.stringify({ type: 'run', id: 1, commands: 'sound set beep volume=0.3', by: 'human:ana' }));
    await until(() => messages.some((m) => m.type === 'result' && m.id === 1), 'the result');
    expect(messages.find((m) => m.type === 'result')).toMatchObject({ ok: true, group: 'g2' });
    ws.send(JSON.stringify({ type: 'run', id: 2, commands: 'sound set beep volume=0.3', by: 'claude' }));
    await until(() => messages.some((m) => m.type === 'result' && m.id === 2), 'the refusal');
    expect(messages.find((m) => m.type === 'result' && m.id === 2)).toMatchObject({ ok: false, errors: [{ message: expect.stringContaining('human:<name>') }] });
    expect((await cli(['run', dir, '-e', 'undo'])).code).toBe(0);
    const hist = await cli(['history', dir]);
    expect(hist.out).toContain('#3 g2 human:ana');
    expect(hist.out).toMatch(/sound set beep volume=0.3   \(undone\)/);
    ws.close();
  });

  it('await exits with a person\'s request, the agent claims and finishes it through the server, and the page follows', async () => {
    const s = await startServe();
    await cli(['run', dir, '-e', 'sound new beep voice=classic; sound set beep wave=sine attack=0.05 sustain=0.3 decay=0.4 freq=0.3 volume=0.15']);
    const ws = new WebSocket(s.url.replace('http', 'ws').replace('/?token', '/ws?token'));
    const messages: { type: string; [k: string]: unknown }[] = [];
    ws.onmessage = (ev) => messages.push(JSON.parse(String(ev.data)));
    await until(() => messages.some((m) => m.type === 'hello'), 'hello');
    // The agent starts waiting; the page then sees it listening.
    const waiting = cli(['await', dir, '--timeout', '30']);
    await until(async () => ((await (await fetch(`http://127.0.0.1:${s.port}/api/presence?token=${s.token}`)).json()) as { waiters: unknown[] }).waiters.length === 1, 'the waiter');
    ws.send(JSON.stringify({ type: 'request', id: 7, by: 'human:ana', body: { action: 'request', kind: 'change', sound: 'beep', note: 'a little lower' } }));
    const done = await waiting;
    expect(done.code).toBe(0);
    expect(done.out).toContain('request r1 (beep) from human:ana');
    expect(done.out).toContain('a little lower');
    const cursor = /next cursor: (\S+)/.exec(done.out)![1]!;
    const answer = messages.find((m) => m.type === 'answer' && m.id === 7);
    expect(answer).toMatchObject({ ok: true, request: { id: 'r1', state: 'open' } });
    // Resumed from the cursor with nothing new: exits 3 on timeout.
    expect((await cli(['await', dir, '--timeout', '1', '--since', cursor])).code).toBe(3);
    const claimed = await cli(['work', dir, 'claim']);
    expect(claimed.out).toMatch(/^claimed r1/);
    { const rr = await cli(['run', dir, '-e', 'sound set beep freq=0.31']); expect(rr.err).toBe(''); expect(rr.code).toBe(0); }
    expect((await cli(['work', dir, 'done', 'freq 0.3 → 0.31'])).out).toContain('No open requests left.');
    await until(() => messages.some((m) => m.type === 'requests' && (m.requests as { state: string }[]).some((q) => q.state === 'done')), 'the done card');
    // An approval is an event too.
    const waiting2 = cli(['await', dir, '--timeout', '30', '--since', cursor]);
    await until(async () => ((await (await fetch(`http://127.0.0.1:${s.port}/api/presence?token=${s.token}`)).json()) as { waiters: unknown[] }).waiters.length === 1, 'the second waiter');
    ws.send(JSON.stringify({ type: 'run', id: 8, commands: 'sound mark beep approved', by: 'human:ana' }));
    const second = await waiting2;
    expect(second.out).toContain('approved beep from human:ana');
    ws.close();
  });

  it('a CLI call that cannot reach the server writes nothing behind its back', async () => {
    await startServe();
    // Hide the token file: the folder is locked but the token cannot be read.
    const lonely = { ...env, SOUNDCLAW_STATE_DIR: join(root, 'elsewhere') };
    const r = spawn(process.execPath, [BIN, 'run', dir, '-e', 'sound new x'], { env: lonely, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    r.stderr.on('data', (d: Buffer) => { err += d; });
    await new Promise((res) => r.once('close', res));
    expect(err).toMatch(/owns .*and the command could not be sent to it/);
    expect(readFileSync(join(dir, 'history.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('MCP over stdio', () => {
  async function connect(): Promise<{ call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>; url: string }> {
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'serve', '--project', dir, '--port', '0'], stderr: 'pipe', env: env as Record<string, string> });
    let err = '';
    (transport.stderr as PassThrough).on('data', (d: Buffer) => { err += d; });
    client = new Client({ name: 'soundclaw-test', version: '1.0.0' });
    await client.connect(transport);
    await until(() => /watch at (\S+)/.test(err), 'the watch URL');
    return {
      url: /watch at (\S+)/.exec(err)![1]!,
      call: async (name, args = {}) => {
        const r = (await client!.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
        return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: !!r.isError };
      },
    };
  }

  it('lists the tools, runs commands, reports numbers, reads the history, renders and exports', async () => {
    const m = await connect();
    const tools = (await client!.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['await_requests', 'changes', 'check', 'describe', 'export', 'history', 'import', 'measure', 'normalize', 'project', 'render', 'request', 'run', 'sample', 'view', 'work']);
    expect((await m.call('project')).text).toMatch(/sounds: none yet/);
    const r = await m.call('run', { commands: 'sound new beep\nsound set beep frequency=880 volume=0.4' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('applied 2 commands as group g1');
    expect(r.text).toMatch(/beep: tone 880 Hz, 0.5 s, volume 0.4 → 22050 samples, peak 0.400, rms 0.283, hash [0-9a-f]{12}/);
    const bad = await m.call('run', { commands: 'sound set beep volume=3\nsound set ghost volume=1' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('commands:1:16: error: volume must be between 0 and 1');
    expect(bad.text).toContain('nothing was applied');
    expect((await m.call('run', { commands: 'undo' })).text).toContain('beep: removed');
    expect((await m.call('history')).text).toMatch(/2 commands in 1 groups|3 commands in 2 groups; 1 group out of effect/);
    expect((await m.call('run', { commands: 'redo' })).isError).toBe(false);
    const render = await m.call('render', { sound: 'beep' });
    const wanted = samplesHash(renderSound({ ...newSound('beep'), frequency: 880, volume: 0.4 })).slice(0, 12);
    expect(render.text).toContain(`hash ${wanted}`);
    expect((await m.call('render', { sound: 'nope' })).text).toMatch(/no sound 'nope'/);
    const exp = await m.call('export', { sounds: ['beep'] });
    expect(exp.text).toContain('beep.wav');
    expect(decodeWav(new Uint8Array(readFileSync(join(dir, 'exports', 'beep.wav')))).frames).toBe(22050);
    expect((await m.call('project')).text).toContain('watch: http://127.0.0.1:');
  });

  it('files, claims and finishes a request, and await_requests returns what people did', async () => {
    const m = await connect();
    await m.call('run', { commands: 'sound new beep voice=classic\nsound set beep wave=sine attack=0.05 sustain=0.3 decay=0.4 freq=0.3 volume=0.15' });
    const none = await m.call('await_requests', { timeout: 1 });
    expect(none.text).toMatch(/^no new events/);
    const ws = new WebSocket(m.url.replace('http', 'ws').replace('/?token', '/ws?token'));
    await new Promise((r) => { ws.onopen = r; });
    const pending = m.call('await_requests', { timeout: 20 });
    await new Promise((r) => setTimeout(r, 100));
    ws.send(JSON.stringify({ type: 'request', id: 1, by: 'human:ana', body: { action: 'request', kind: 'change', sound: 'beep', note: 'shorter' } }));
    const got = await pending;
    expect(got.text).toContain('request r1 (beep) from human:ana');
    expect((await m.call('work', {})).text).toMatch(/^claimed r1/);
    expect((await m.call('work', { action: 'progress', text: 'trimming' })).isError).toBe(false);
    expect((await m.call('work', { action: 'blocked', text: 'how short?' })).isError).toBe(false);
    expect((await m.call('work', { action: 'done', text: 'x' })).isError).toBe(true);
    ws.send(JSON.stringify({ type: 'request', id: 2, by: 'human:ana', body: { action: 'reply', id: 'r1', text: '0.2 s' } }));
    await until(async () => (await m.call('work', { action: 'list' })).text.includes('r1 change beep'), 'the reply');
    expect((await m.call('work', { id: 'r1' })).text).toContain('The person answered: "0.2 s"');
    expect((await m.call('run', { commands: 'sound set beep freq=0.31' })).isError).toBe(false);
    expect((await m.call('work', { action: 'done', text: 'freq 0.3 → 0.31' })).text).toContain('No open requests left.');
    expect((await m.call('request', { sound: 'beep', note: 'agent asks too' })).text).toContain('r2 change beep');
    ws.close();
  });
});
