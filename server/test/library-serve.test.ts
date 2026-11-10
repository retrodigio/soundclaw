// Libraries through a real `soundclaw serve`: the `library` tool over MCP as an agent calls it, and `library use` sent from another
// process to the server that owns the project (so it goes through the writer and the tape shows it). Nothing is left running.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BIN, until } from './helpers.ts';
import { makeSmallLibrary } from './library-fixtures.ts';

let root: string;
let dir: string;
let lib: string;
let env: NodeJS.ProcessEnv;
let server: ChildProcess | null = null;
let client: Client | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'soundclaw-libserve-'));
  dir = join(root, 'demo.sclaw');
  lib = join(root, 'cellar');
  mkdirSync(lib);
  env = { ...process.env, SOUNDCLAW_STATE_DIR: join(root, 'state'), SOUNDCLAW_CONFIG_DIR: join(root, 'config'), SOUNDCLAW_CACHE_DIR: join(root, 'cache'), SOUNDCLAW_INDEX_WORKERS: '2' };
  execFileSync(process.execPath, [BIN, 'new', dir], { env });
  makeSmallLibrary(lib, join(root, 'outside'));
});
afterEach(async () => {
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
    let out = '', err = '';
    c.stdout.on('data', (d: Buffer) => { out += d; });
    c.stderr.on('data', (d: Buffer) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
  });
}

async function registerAndIndex(): Promise<void> {
  const add = await cli(['library', 'add', lib, 'licence=CC0-1.0']);
  expect(add.code, add.err).toBe(0);
  const idx = await cli(['library', 'index']);
  expect(idx.code, idx.err).toBe(0);
  expect(idx.out).toMatch(/library cellar: 10 files indexed/);
}

describe('library over MCP', () => {
  it('searches, finds sounds like a file and copies a file into the project it serves, as the agent', async () => {
    await registerAndIndex();
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'serve', '--project', dir, '--port', '0'], stderr: 'pipe', env: env as Record<string, string> });
    let err = '';
    (transport.stderr as PassThrough).on('data', (d: Buffer) => { err += d; });
    client = new Client({ name: 'soundclaw-test', version: '1.0.0' });
    await client.connect(transport);
    await until(() => /watch at (\S+)/.test(err), 'the watch URL');
    const call = async (args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
      const r = (await client!.callTool({ name: 'library', arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
      return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: !!r.isError };
    };
    const list = await call({ action: 'list' });
    expect(list.text).toMatch(/cellar .*\n {2}licence CC0-1.0.*\n {2}10 files indexed/);
    const search = await call({ action: 'search', query: 'creak dur=0.8-3 pitched=no', limit: 5 });
    expect(search.isError).toBe(false);
    const [head, ...lines] = search.text.split('\n');
    expect(head).toBe('2 hits');
    const hits = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(hits.map((h) => h.ref)).toEqual(['cellar:doors/creak_02.wav', 'cellar:doors/creak_01.wav']);
    expect(hits[0]).toMatchObject({ licence: 'CC0-1.0', state: 'shippable', channels: 1, rate: 22050 });
    expect(Object.keys(hits[0]!)).toEqual(expect.arrayContaining(['ref', 'dur', 'lufs', 'note', 'centroid', 'attack', 'desc']));
    expect((await call({ action: 'search', query: 'creak', format: 'text' })).text).toMatch(/^cellar:doors\/creak_0\d\.wav {2}\d/);
    expect((await call({ action: 'search', query: 'dur=slow' })).isError).toBe(true);
    // sounds like a file outside the library
    const sim = await call({ action: 'similar', ref: join(lib, 'bells', 'BellHigh.wav'), limit: 2 });
    expect(sim.text.split('\n')[0]).toMatch(/^like .*BellHigh.*: 2 of 8 hits$/);
    expect(JSON.parse(sim.text.split('\n')[1]!)).toMatchObject({ ref: 'cellar:bells/BellHigh.wav', distance: 0 });
    // use: one tape group by the agent
    const use = await call({ action: 'use', ref: 'cellar:doors/creak_01.wav', as: 'creak', tags: 'wood' });
    expect(use.isError, use.text).toBe(false);
    expect(use.text).toMatch(/creak/);
    const history = readFileSync(join(dir, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { cmd: string; by: string });
    expect(history.at(-1)).toMatchObject({ by: 'agent:claude' });
    expect(history.at(-1)!.cmd).toContain('origin=cellar:doors/creak_01.wav');
    expect((await call({ action: 'use', ref: 'cellar:../x.wav' })).isError).toBe(true);
    expect((await call({ action: 'use' })).isError).toBe(true);
  }, 90_000);
  it('registers and indexes a library for an agent with no shell', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'serve', '--project', dir, '--port', '0'], stderr: 'pipe', env: env as Record<string, string> });
    client = new Client({ name: 'soundclaw-test', version: '1.0.0' });
    await client.connect(transport);
    const call = async (args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
      const r = (await client!.callTool({ name: 'library', arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
      return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: !!r.isError };
    };
    expect((await call({ action: 'index' })).text).toMatch(/no libraries registered/);
    expect((await call({ action: 'add' })).isError).toBe(true);
    const add = await call({ action: 'add', dir: lib, licence: 'CC0-1.0' });
    expect(add.isError, add.text).toBe(false);
    expect(add.text).toMatch(/added library 'cellar'/);
    const idx = await call({ action: 'index', ids: ['cellar'] });
    expect(idx.text).toMatch(/library cellar: 10 files indexed/);
    // the tools keep working while an index runs, and search sees what it built
    expect((await call({ action: 'search', query: 'creak' })).text.split('\n')[0]).toBe('2 hits');
    expect((await call({ action: 'index' })).text).toMatch(/0 read, 10 unchanged/);
  }, 90_000);
});

describe('library use while a server owns the project', () => {
  it('is sent to the server, which writes it through its writer', async () => {
    await registerAndIndex();
    server = spawn(process.execPath, [BIN, 'serve', '--project', dir, '--port', '0', '--no-mcp'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    server.stderr!.on('data', (d: Buffer) => { err += d; });
    await until(() => /watch at (\S+)/.test(err), 'the watch URL');
    const r = await cli(['library', 'use', dir, 'cellar:bells/BellHigh.wav', 'as=bell', '--by', 'agent:foley']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/bell/);
    const last = readFileSync(join(dir, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { cmd: string; by: string }).at(-1)!;
    expect(last.by).toBe('agent:foley');
    expect(last.cmd).toMatch(/^sample add bell /);
    // the project's samples show it, with its source
    const list = await cli(['sample', 'list', dir]);
    expect(list.out).toMatch(/^bell: 1\.500 s,.*, library, tags bell,high/m);
  }, 90_000);
});
