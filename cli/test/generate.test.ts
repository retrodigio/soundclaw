// The `generate` command of the CLI: takes from the fake provider, the estimate, the refusals before any call, generating again, the ledger,
// the settings and the help. Paid calls go only to a local stub; no real key is in the environment of these processes.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandHelp, main, type Io } from '../src/main.ts';
import { startStub, type Stub } from '../../server/test/provider-stub.ts';

const BIN = join(import.meta.dirname, '..', 'bin', 'soundclaw.js');
const KEY = 'sk_clistubkey0123456789abcdef';
let tmp: string;
let proj: string;
let env: NodeJS.ProcessEnv;
let stub: Stub | null = null;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'soundclaw-cli-generate-'));
  proj = join(tmp, 'demo.sclaw');
  const { ELEVENLABS_API_KEY: _k, CI: _ci, SOUNDCLAW_NO_PAID: _np, ...rest } = process.env;
  env = { ...rest, SOUNDCLAW_CONFIG_DIR: join(tmp, 'config'), SOUNDCLAW_STATE_DIR: join(tmp, 'state') };
  expect(sc(['new', proj]).code).toBe(0);
});
afterEach(async () => {
  await stub?.close();
  stub = null;
  rmSync(tmp, { recursive: true, force: true });
});

/** Run the executable; spawnSync would block the stub's event loop, so this waits asynchronously. */
function scAsync(args: string[], extra: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [BIN, ...args], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d: Buffer) => { out += d; });
    c.stderr.on('data', (d: Buffer) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
  });
}
function sc(args: string[], extra: NodeJS.ProcessEnv = {}): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [BIN, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function setCap(credits: number): void {
  const file = join(proj, 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), generation: { capCredits: credits } }, null, 2) + '\n');
}

describe('generate', () => {
  it('makes takes with the fake provider, prints each with its numbers, and logs the command', () => {
    const r = sc(['generate', proj, 'sfx', 'a dry wooden knock', 'provider=fake', 'takes=2', 'duration=0.8', 'as=knock', 'want=dur<1']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^generated 2 of 2 takes with fake sound-generation \(fake-sfx-1\), 0\.8 s each: "a dry wooden knock"\nranked by want "dur<1":\n1\. knock_t1 {2}0\.800 s/);
    expect(r.out).toMatch(/listen: soundclaw describe \S*demo\.sclaw sample:knock_t1/);
    const tape = readFileSync(join(proj, 'history.jsonl'), 'utf8').trim().split('\n').slice(1).map((l) => JSON.parse(l) as { cmd: string; by: string });
    expect(tape.map((t) => t.cmd.split(' ').slice(0, 3).join(' '))).toEqual(['sample add knock_t1', 'sample add knock_t2']);
    expect(tape[0]!.by).toBe('agent:claude');
    const j = JSON.parse(sc(['generate', proj, '--again', 'knock_t1', 'takes=1', '--json', '--by', 'helper']).out) as { takes: { name: string }[] };
    expect(j.takes.map((t) => t.name)).toEqual(['knock_t3']);
    expect(readFileSync(join(proj, 'history.jsonl'), 'utf8')).toMatch(/"by":"agent:helper"/);
    const ledger = sc(['generate', '--ledger', proj]);
    expect(ledger.out).toMatch(/^0 credits over 2 commands, 3 takes kept\nby provider:\n {2}fake {2}0 credits/);
    expect(sc(['generate', '--ledger']).out).toMatch(/0 credits over 2 commands across projects/);
  });
  it('estimates, and refuses a paid command before any call while the project has no cap', () => {
    sc(['generate', 'config', 'elevenlabs.plan=creator']);
    const e = sc(['generate', proj, 'sfx', 'rain on leaves', 'duration=3', 'takes=2', '--estimate']);
    expect(e.code, e.err).toBe(0);
    expect(e.out).toMatch(/estimate: 60 credits \(30 a take at 10 credits\/s\)/);
    expect(e.out).toMatch(/would be refused:\n {2}paid generation is off for this project: its cap is 0 credits/);
    const r = sc(['generate', proj, 'sfx', 'rain on leaves', 'duration=3']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^error: not generated \(nothing was called\):\n {2}paid generation is off/);
    setCap(100);
    expect(sc(['generate', proj, 'sfx', 'rain on leaves', 'duration=3']).err).toMatch(/ELEVENLABS_API_KEY is not set in the environment of the process that calls \(this soundclaw command\)/);
    expect(sc(['generate', proj, 'sfx', 'rain on leaves'], { ELEVENLABS_API_KEY: KEY, CI: 'true' }).err).toMatch(/CI is set/);
  });
  it('calls the provider with the key from its environment and prints the charge (a local stub)', async () => {
    stub = await startStub({ key: KEY });
    sc(['generate', 'config', `elevenlabs.url=${stub.url}`, 'elevenlabs.plan=pro']);
    setCap(100);
    const r = await scAsync(['generate', proj, 'sfx', 'a gong', 'duration=1.5', 'takes=2'], { ELEVENLABS_API_KEY: KEY });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/charged 30 credits \(from the provider's cost header\); the estimate was 30/);
    expect(r.out).toMatch(/budget: project 30 of 100 credits spent \(70 left\)/);
    expect(r.out + r.err).not.toContain(KEY);
    expect(stub.requests.filter((q) => q.path === '/v1/sound-generation')).toHaveLength(2);
  });
  it('shows and changes the settings, and says what is wrong with the words', () => {
    const c = sc(['generate', 'config', 'daily-cap=500', 'elevenlabs.music=on']);
    expect(c.code, c.err).toBe(0);
    expect(c.out).toMatch(/daily cap 500 credits across projects\n/);
    expect(c.out).toMatch(/music on; key from ELEVENLABS_API_KEY \(not set here\)/);
    expect(sc(['generate', 'config', 'colour=red']).err).toMatch(/no setting 'colour'/);
    expect(sc(['generate', proj, 'sfx']).code).toBe(2);
    expect(sc(['generate', proj, 'sfx', 'a knock', 'duration']).err).toMatch(/'duration' is not key=value/);
    expect(sc(['generate', proj, 'sfx', 'a knock', 'size=2', 'provider=fake']).err).toMatch(/no field 'size'/);
    expect(sc(['generate', proj, '--again', 'nothing', 'provider=fake']).err).toMatch(/takes takes= and as=/);
    expect(sc(['generate', proj, 'voice', 'hello', 'provider=fake']).err).toMatch(/sfx or music/);
  });
  it('has its own help block, and main() sends it to the executable', () => {
    expect(commandHelp('generate')).toMatch(/soundclaw generate <project> sfx\|music "<prompt>"/);
    expect(commandHelp('generate')).toMatch(/soundclaw generate --ledger/);
    let err = '';
    const io: Io = { out: () => undefined, err: (s) => { err += s; }, stdin: () => '', now: () => '2026-11-09T10:00:00Z' };
    expect(main(['generate', proj, 'sfx', 'x'], io)).toBe(2);
    expect(err).toMatch(/generate runs from the soundclaw command itself/);
  });
});
