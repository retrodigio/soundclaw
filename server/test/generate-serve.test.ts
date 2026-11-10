// Generation through a real `soundclaw serve`: the MCP `generate` tool as an agent calls it, `soundclaw generate` sent from another process
// (with no key of its own) to the server that owns the project, and the page's route as a person. The server calls a local stub with a
// made-up key; the test reads everything the server and the commands printed and wrote, and finds no key. Nothing is left running.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BIN, until } from './helpers.ts';
import { startStub, type Stub } from './provider-stub.ts';

const KEY = 'sk_servestubkey0123456789abcdef';
let root: string;
let dir: string;
let env: NodeJS.ProcessEnv;
let stub: Stub;
let client: Client | null = null;
let server: ChildProcess | null = null;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'soundclaw-genserve-'));
  dir = join(root, 'demo.sclaw');
  const { ELEVENLABS_API_KEY: _k, CI: _ci, SOUNDCLAW_NO_PAID: _np, ...rest } = process.env;
  env = { ...rest, SOUNDCLAW_STATE_DIR: join(root, 'state'), SOUNDCLAW_CONFIG_DIR: join(root, 'config'), SOUNDCLAW_CACHE_DIR: join(root, 'cache') };
  stub = await startStub({ key: KEY });
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'generation.json'), JSON.stringify({ providers: { elevenlabs: { plan: 'pro', url: stub.url } } }));
  await cli(['new', dir]);
  const pj = join(dir, 'project.json');
  writeFileSync(pj, JSON.stringify({ ...JSON.parse(readFileSync(pj, 'utf8')), generation: { capCredits: 200 } }, null, 2));
});
afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = null;
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((r) => server!.once('exit', r));
  }
  server = null;
  await stub.close();
  rmSync(root, { recursive: true, force: true });
});

interface Done { code: number | null; out: string; err: string }
function cli(args: string[], extra: NodeJS.ProcessEnv = {}): Promise<Done> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [BIN, ...args], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d: Buffer) => { out += d; });
    c.stderr.on('data', (d: Buffer) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
  });
}

describe('generate while a server owns the project', () => {
  it('works over MCP, from the CLI and from the page, with the key only in the server’s environment, and nothing prints it', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'serve', '--project', dir, '--port', '0'], stderr: 'pipe', env: { ...env, ELEVENLABS_API_KEY: KEY } as Record<string, string> });
    let serverErr = '';
    (transport.stderr as PassThrough).on('data', (d: Buffer) => { serverErr += d; });
    client = new Client({ name: 'soundclaw-test', version: '1.0.0' });
    await client.connect(transport);
    await until(() => /watch at (\S+)/.test(serverErr), 'the watch URL');
    const watch = /watch at (\S+)/.exec(serverErr)![1]!;
    const outputs: string[] = [];
    const call = async (args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
      const r = (await client!.callTool({ name: 'generate', arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
      const text = r.content.map((c) => c.text ?? '').join('\n');
      outputs.push(text);
      return { text, isError: !!r.isError };
    };
    // MCP: estimate, then two takes
    const est = await call({ prompt: 'a heavy wooden door slams', duration: 1, takes: 2, estimate: true });
    expect(est.text).toMatch(/estimate: 20 credits/);
    expect(stub.requests).toEqual([]);
    const made = await call({ prompt: 'a heavy wooden door slams', duration: 1, takes: 2, as: 'slam', want: 'dur=0.5-1.5' });
    expect(made.isError, made.text).toBe(false);
    expect(made.text).toMatch(/generated 2 of 2 takes with elevenlabs sound-generation/);
    expect(made.text).toMatch(/charged 20 credits/);
    expect((await call({ action: 'ledger' })).text).toMatch(/^20 credits over 1 command, 2 takes kept/);
    expect((await call({ action: 'config' })).text).toMatch(/key from ELEVENLABS_API_KEY \(set here\)/);
    expect((await call({ prompt: 'x', duration: 30 })).text).toMatch(/one take costs about 300 credits|project has 180 of its 200 left/);
    // the CLI, with no key of its own: sent to the server, which calls with its key
    const sent = await cli(['generate', dir, 'sfx', 'a chain rattles', 'duration=1', 'as=chain']);
    outputs.push(sent.out, sent.err);
    expect(sent.code, sent.err).toBe(0);
    expect(sent.out).toMatch(/generated 1 of 1 take with elevenlabs/);
    const again = await cli(['generate', dir, '--again', 'slam_t2']);
    expect(again.code, again.err).toBe(0);
    expect(again.out).toMatch(/slam_t3/);
    // the page, as a person, with the free fake provider
    const token = new URL(watch).searchParams.get('token')!;
    const page = await fetch(new URL('/api/generate', watch), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'sfx', prompt: 'a bell', pairs: { provider: 'fake', duration: 1 }, by: 'human:tester' }) });
    const pj = (await page.json()) as { text: string; json: { takes: { name: string }[] } };
    outputs.push(JSON.stringify(pj));
    expect(page.status).toBe(200);
    expect(pj.json.takes.map((t) => t.name)).toEqual(['bell_t1']);
    expect((await fetch(new URL('/api/generate', watch), { method: 'POST', body: '{}' })).status).toBe(401);
    const bad = await fetch(new URL('/api/generate', watch), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ kind: 'sfx', prompt: 'x', pairs: {}, by: 'nobody' }) });
    expect(bad.status).toBe(400);
    const tape = readFileSync(join(dir, 'history.jsonl'), 'utf8').trim().split('\n').slice(1).map((l) => JSON.parse(l) as { cmd: string; by: string });
    expect(tape.map((t) => `${t.by} ${t.cmd.split(' ')[2]}`)).toEqual(['agent:claude slam_t1', 'agent:claude slam_t2', 'agent:claude chain_t1', 'agent:claude slam_t3', 'human:tester bell_t1']);
    expect(stub.requests.filter((q) => q.path === '/v1/sound-generation').every((q) => q.key === KEY)).toBe(true);
    // stop the server, then look at everything it and the commands left
    await client.close();
    client = null;
    await until(() => !readdirSync(dir).includes('.soundclaw.lock'), 'the server to stop');
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(join(d, x.name)) : [join(d, x.name)]));
    const files = [...walk(dir), ...walk(join(root, 'config')), ...walk(join(root, 'state'))];
    expect(files.some((x) => x.endsWith('generation.jsonl'))).toBe(true);
    expect(files.some((x) => x.endsWith('spend.jsonl'))).toBe(true);
    for (const t of [serverErr, ...outputs, ...files.map((x) => readFileSync(x, 'latin1'))]) expect(t.includes(KEY)).toBe(false);
  }, 120_000);

describe('the project cap', () => {
  const capNow = (): number => (JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as { generation: { capCredits: number } }).generation.capCredits;

  it('is set by a person only: the CLI and the page can; no MCP tool and no command of the language can', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'serve', '--project', dir, '--port', '0'], stderr: 'pipe', env: { ...env, ELEVENLABS_API_KEY: KEY } as Record<string, string> });
    let serverErr = '';
    (transport.stderr as PassThrough).on('data', (d: Buffer) => { serverErr += d; });
    client = new Client({ name: 'soundclaw-test', version: '1.0.0' });
    await client.connect(transport);
    await until(() => /watch at (\S+)/.test(serverErr), 'the watch URL');
    const watch = /watch at (\S+)/.exec(serverErr)![1]!;
    const token = new URL(watch).searchParams.get('token')!;
    expect(capNow()).toBe(200);

    // MCP: no tool sets a cap, the generate tool has no field for one, its config action only reads, and the command language does not know it
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).filter((n) => /cap/i.test(n))).toEqual([]);
    expect(JSON.stringify(tools.find((t) => t.name === 'generate')!.inputSchema)).not.toMatch(/capCredits|cap_credits|"cap"|daily|per.call/i);
    const viaRun = (await client.callTool({ name: 'run', arguments: { commands: 'generate cap demo 99999' } })) as { isError?: boolean; content: { text?: string }[] };
    expect(viaRun.isError).toBe(true);
    expect(viaRun.content.map((c) => c.text).join('')).toMatch(/unknown command 'generate'/);
    const viaConfig = (await client.callTool({ name: 'generate', arguments: { action: 'config', prompt: 'project-cap=99999', cap: 99999, capCredits: 99999 } })) as { content: { text?: string }[] };
    expect(viaConfig.content.map((c) => c.text).join('')).toMatch(/^provider /);
    await expect(client.callTool({ name: 'generation_cap', arguments: { capCredits: 99999 } })).rejects.toThrow(/Tool generation_cap not found/);
    expect(capNow()).toBe(200);

    // the page: a person (human:<name>) with the token
    const post = (body: unknown, auth = true): Promise<Response> => fetch(new URL('/api/generation/cap', watch), { method: 'POST', headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ capCredits: 900, by: 'human:tester' }, false)).status).toBe(401);
    expect((await post({ capCredits: 900, by: 'agent:claude' })).status).toBe(403);
    expect((await post({ capCredits: 900 })).status).toBe(403);
    expect(capNow()).toBe(200);
    expect((await post({ capCredits: -5, by: 'human:tester' })).status).toBe(400);
    const ok = await post({ capCredits: 900, by: 'human:tester' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ capCredits: 900 });
    expect(capNow()).toBe(900);

    // the CLI, while the server runs: project.json is read fresh at every command, so the server sees it
    const cli1 = await cli(['generate', 'cap', dir, '300']);
    expect(cli1.code, cli1.err).toBe(0);
    expect(cli1.out).toBe('project cap 300 credits\n');
    expect(capNow()).toBe(300);
    const est = (await client.callTool({ name: 'generate', arguments: { prompt: 'a bell', duration: 1, estimate: true } })) as { content: { text?: string }[] };
    expect(est.content.map((c) => c.text).join('')).toMatch(/project 0 of 300 credits spent/);
    expect((await cli(['generate', 'cap', dir, '0'])).out).toBe('project cap 0 credits (paid generation is off)\n');
    expect((await cli(['generate', 'cap', dir, 'lots'])).code).toBe(2);
    expect((await cli(['generate', 'cap', dir])).code).toBe(2);
    // other fields of project.json are kept
    expect((JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as { name?: string }).name).toBeTruthy();
  }, 120_000);
});
});
