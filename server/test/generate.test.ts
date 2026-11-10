// Generation as a source of samples: the fake provider, and the ElevenLabs provider against a local stub (never the real service). Estimates,
// every cap refusing before the first call, the charge from the cost header and from the account counter, the ledgers, the CI refusal,
// ranking takes, generating again, replay and undo that never call, and a search of every output for the key.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeAudio, pcmHash, pcmToWav, similarDistance } from '@soundclaw/core';
import {
  againOptions, budgetOf, configText, estimateText, fakeAudio, generateJson, generateText, ledgerText, ledgerTotals, nameFromPrompt, optionsFromPairs, planGeneration, readGenerationConfig,
  readLedger, readSpend, redact, runGeneration, setGenerationConfig, spendFile, type GenerateOptions,
} from '../src/index.ts';
import { fixture, type Fixture } from './helpers.ts';
import { startStub, stubPcm, type Stub } from './provider-stub.ts';

const KEY = 'sk_stubkey0123456789abcdefSTUB';
const claude = 'agent:claude';
let f: Fixture;
let stub: Stub | null = null;
const ENV = ['SOUNDCLAW_CONFIG_DIR', 'ELEVENLABS_API_KEY', 'CI', 'SOUNDCLAW_NO_PAID', 'SOUNDCLAW_FAKE_LONGER'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  f = fixture();
  process.env.SOUNDCLAW_CONFIG_DIR = join(f.root, 'config');
  // the stub's key, never a real one; and nothing that would refuse the stub's calls
  process.env.ELEVENLABS_API_KEY = KEY;
  delete process.env.CI;
  delete process.env.SOUNDCLAW_NO_PAID;
});
afterEach(async () => {
  await stub?.close();
  stub = null;
  await f.w.thumbs.close();
  f.clean();
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

function setCap(credits: number): void {
  const file = join(f.dir, 'project.json');
  const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...j, generation: { capCredits: credits } }, null, 2) + '\n');
}

async function useStub(o: Partial<Parameters<typeof startStub>[0]> = {}, plan = 'pro'): Promise<Stub> {
  stub = await startStub({ key: KEY, ...o });
  setGenerationConfig([['elevenlabs.url', stub.url], ['elevenlabs.plan', plan]]);
  return stub;
}

const sfx = (prompt: string, more: Partial<GenerateOptions> = {}): GenerateOptions => ({ kind: 'sfx', prompt, by: claude, ...more });
const tape = (): { cmd: string; by: string; group: string }[] => readFileSync(join(f.dir, 'history.jsonl'), 'utf8').trim().split('\n').slice(1).map((l) => JSON.parse(l) as { cmd: string; by: string; group: string });

describe('the fake provider', () => {
  it('makes the same audio for the same request and other audio for another take, of the asked length', () => {
    const req = { kind: 'sfx' as const, prompt: 'a dry wooden knock', duration: 0.75, loop: false, model: 'fake-sfx-1', take: 1 };
    const a = fakeAudio(req), b = fakeAudio(req), c = fakeAudio({ ...req, take: 2 });
    expect(pcmHash(a)).toBe(pcmHash(b));
    expect(pcmHash(c)).not.toBe(pcmHash(a));
    expect(a).toMatchObject({ rate: 44100, channels: 1, format: 'pcm16', frames: Math.round(0.75 * 44100) });
    expect(pcmHash(fakeAudio({ ...req, prompt: 'a dry wooden knock!' }))).not.toBe(pcmHash(a));
  });
  it('generates takes into the store as one group, with their provenance, the licence own and a ledger line, and calls nothing', async () => {
    const r = await runGeneration(f.w, sfx('the slow creak of an old wooden door', { provider: 'fake', takes: 3, duration: 1.5 }));
    expect(r.takes.map((t) => t.name)).toEqual(['slow_creak_old_t1', 'slow_creak_old_t2', 'slow_creak_old_t3']);
    expect(new Set(r.takes.map((t) => t.hash)).size).toBe(3);
    const lines = tape();
    expect(lines).toHaveLength(3);
    expect(new Set(lines.map((l) => l.group))).toEqual(new Set([r.group]));
    expect(lines[0]!.cmd).toMatch(/^sample add slow_creak_old_t1 hash=[0-9a-f]{64} rate=44100 channels=1 frames=66150 format=pcm16 tags=generated,sfx /);
    expect(lines[0]!.cmd).toMatch(/source=generated origin=fake:sound-generation orig-hash=[0-9a-f]{64} orig-format=pcm_44100 /);
    expect(lines[0]!.cmd).toMatch(/provider=fake endpoint=sound-generation model=fake-sfx-1 prompt="the slow creak of an old wooden door" params="duration=1.5 loop=no format=pcm_44100" take=1\/3 request=fake-[0-9a-f]{12} credits=0 licence=own/);
    const e = f.w.samples.entry('slow_creak_old_t2')!;
    expect(e.prov).toMatchObject({ source: 'generated', provider: 'fake', take: '2/3', credits: 0 });
    expect(r.charge).toBe(0);
    const ledger = readLedger(f.dir);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ by: claude, provider: 'fake', endpoint: 'sound-generation', model: 'fake-sfx-1', kind: 'sfx', takes: 3, estimate: 0, charge: 0, chargeFrom: 'provider', outcome: 'ok' });
    expect(ledger[0]!.results.map((x) => x.name)).toEqual(['slow_creak_old_t1', 'slow_creak_old_t2', 'slow_creak_old_t3']);
    expect(new Set(ledger[0]!.results.map((x) => x.hash))).toEqual(new Set(r.takes.map((t) => t.hash)));
    expect(readSpend()).toHaveLength(1);
    const text = generateText(r, 'demo');
    expect(text).toMatch(/^generated 3 of 3 takes with fake sound-generation \(fake-sfx-1\), 1.5 s each: "the slow creak of an old wooden door"\n/);
    expect(text).toMatch(/slow_creak_old_t1 {2}1\.500 s {2}-?\d+\.\d LUFS {2}peak -?\d+\.\d dBFS {2}centroid \d+ Hz {2}attack \d+\.\d ms {2}pitch \S+ {2}0 credits {2}request fake-/);
    expect(text).toMatch(/licence own; 3 samples as group \S+; logged in generation\.jsonl/);
    expect(text).toMatch(/listen: soundclaw describe demo sample:slow_creak_old_t1/);
  });
  it('numbers new takes after the ones there, and --again is a new call with the recorded prompt and parameters', async () => {
    await runGeneration(f.w, sfx('glass chime', { provider: 'fake', takes: 2, duration: 0.8, as: 'chime', influence: 0.6 }));
    const o = againOptions(f.w, 'chime_t2', claude);
    expect(o).toMatchObject({ kind: 'sfx', prompt: 'glass chime', provider: 'fake', as: 'chime', duration: 0.8, influence: 0.6, model: 'fake-sfx-1' });
    const again = await runGeneration(f.w, { ...o, takes: 1 });
    expect(again.takes.map((t) => t.name)).toEqual(['chime_t3']);
    expect(again.takes[0]!.hash).not.toBe(f.w.samples.entry('chime_t1')!.hash);
    expect(f.w.samples.entry('chime_t3')!.prov.take).toBe('1/1');
    expect(() => againOptions(f.w, 'nothing', claude)).toThrow(/no sample 'nothing'/);
  });
  it('is free and never counts against a cap: it runs at a project cap of 0, over any per-call maximum, and costs nothing in the ledgers', async () => {
    expect(() => setGenerationConfig([['fake.rate.sfx', '10']])).toThrow(/the fake provider makes test audio and is always free/);
    setGenerationConfig([['max-per-call', '1'], ['daily-cap', '0']]);
    const p = await f.w.enqueue(() => planGeneration(f.w, sfx('a knock', { provider: 'fake', takes: 3, duration: 30 })));
    expect(p.perTake).toBe(0);
    expect(p.refusals).toEqual([]);
    const r = await runGeneration(f.w, sfx('a knock', { provider: 'fake', takes: 2, duration: 2 }));
    expect(r.charge).toBe(0);
    expect(budgetOf(f.dir, '2026-11-06T12:00:00Z').projectSpent).toBe(0);
    expect(readSpend().reduce((n, l) => n + (l.credits || 0), 0)).toBe(0);
  });
});

describe('estimates and caps', () => {
  it('--estimate prints the cost, the budget and the licence, and what would refuse it, calling nothing', async () => {
    const s = await useStub({}, 'creator');
    setCap(500);
    const p = await f.w.enqueue(() => planGeneration(f.w, sfx('rain on a tin roof', { takes: 3, duration: 4 })));
    const t = estimateText(p);
    expect(t).toMatch(/^sfx by elevenlabs sound-generation \(eleven_text_to_sound_v2\): 3 takes of 4 s as rain_tin_roof_t1, rain_tin_roof_t2, rain_tin_roof_t3\n/);
    expect(t).toMatch(/estimate: 120 credits \(40 a take at 10 credits\/s\)/);
    expect(t).toMatch(/budget: project 0 of 500 credits spent \(500 left\); today 0 of 3000 \(3000 left\); one call at most 300/);
    expect(t).toMatch(/licence of the takes: generated:elevenlabs:creator/);
    expect(t).toMatch(/it may run: nothing was called/);
    expect(s.requests).toEqual([]);
  });
  it('refuses the whole command before the first call for each cap and rule, naming it', async () => {
    const s = await useStub();
    const refused = async (o: GenerateOptions, re: RegExp): Promise<void> => {
      await expect(runGeneration(f.w, o)).rejects.toThrow(re);
    };
    // the project cap is 0 until a person sets one
    await refused(sfx('a door', { duration: 2 }), /not generated \(nothing was called\):\n.*its cap is 0 credits until a person sets one in project\.json: "generation": \{"capCredits": <credits>\}/s);
    setCap(50);
    // one take over the per-call maximum
    await refused(sfx('a long drone', { duration: 30, takes: 1 }), /one take costs about 300 credits|this needs about 300 credits and the project has 50/);
    setGenerationConfig([['max-per-call', '25']]);
    await refused(sfx('a door', { duration: 3 }), /one take costs about 30 credits, over the 25 a call may cost/);
    setGenerationConfig([['max-per-call', 'none']]);
    // the whole command over what the project has left
    await refused(sfx('a door', { duration: 2, takes: 3 }), /this needs about 60 credits and the project has 50 of its 50 left/);
    // the daily cap across projects
    setCap(5000);
    writeFileSync(spendFile(), JSON.stringify({ at: '2026-11-06T09:00:00Z', project: 'other', dir: '/elsewhere', provider: 'elevenlabs', endpoint: 'sound-generation', credits: 2990 }) + '\n');
    await refused(sfx('a door', { duration: 2 }), /this needs about 20 credits and today has 10 of the daily 3000 left across projects/);
    rmSync(spendFile());
    // CI and SOUNDCLAW_NO_PAID
    process.env.CI = 'true';
    await refused(sfx('a door'), /CI is set: paid providers are never called in CI/);
    delete process.env.CI;
    process.env.SOUNDCLAW_NO_PAID = '1';
    await refused(sfx('a door'), /SOUNDCLAW_NO_PAID=1 is set/);
    delete process.env.SOUNDCLAW_NO_PAID;
    // the key, by its variable only
    delete process.env.ELEVENLABS_API_KEY;
    await refused(sfx('a door'), /ELEVENLABS_API_KEY is not set in the environment of the process that calls/);
    process.env.ELEVENLABS_API_KEY = KEY;
    // the plan decides the licence: no plan, no call
    setGenerationConfig([['elevenlabs.plan', 'none']]);
    await refused(sfx('a door'), /your ElevenLabs plan is not set/);
    setGenerationConfig([['elevenlabs.plan', 'pro']]);
    // music is held until the user turns it on
    await refused({ kind: 'music', prompt: 'a calm harp loop', by: claude, duration: 20 }, /music endpoint is held/);
    // bad arguments are refused too, before anything
    await refused(sfx('a door', { duration: 0.1 }), /duration 0\.1: elevenlabs sfx is 0\.5 to 30 s/);
    await refused(sfx('a door', { takes: 5 }), /takes is 1 to 4/);
    await refused(sfx('a door', { want: 'dur=slow' }), /want: /);
    await refused(sfx(''), /give a prompt/);
    expect(s.requests).toEqual([]);
    expect(readLedger(f.dir)).toEqual([]);
    expect(f.w.samples.names()).toEqual([]);
  });
});

describe('ElevenLabs through a local stub', () => {
  it('asks for 16-bit PCM on a plan that allows it, stores each take, and logs the charge from the cost header', async () => {
    const s = await useStub();
    setCap(1000);
    const r = await runGeneration(f.w, sfx('a heavy iron chain dropped on stone', { takes: 2, duration: 1.5, influence: 0.4, loop: false, as: 'chain' }));
    const gen = s.requests.filter((q) => q.path === '/v1/sound-generation');
    expect(gen).toHaveLength(2);
    expect(gen[0]).toMatchObject({ method: 'POST', key: KEY, query: { output_format: 'pcm_44100' }, body: { text: 'a heavy iron chain dropped on stone', duration_seconds: 1.5, prompt_influence: 0.4, model_id: 'eleven_text_to_sound_v2' } });
    expect(gen[0]!.body).not.toHaveProperty('loop');
    expect(r.takes.map((t) => [t.name, t.credits, t.request])).toEqual([['chain_t1', 15, 'req0001'], ['chain_t2', 15, 'req0002']]);
    expect(r.charge).toBe(30);
    expect(r.chargeFrom).toBe('header');
    // the stored audio is the bytes the provider sent
    expect(f.w.samples.entry('chain_t1')!.hash).toBe(pcmHash({ rate: 44100, channels: 1, format: 'pcm16', frames: Math.round(1.5 * 44100), data: stubPcm(1.5, 275) }));
    expect(f.w.samples.entry('chain_t1')!.licence).toEqual({ id: 'generated:elevenlabs:pro', terms: 'https://elevenlabs.io/terms-of-use' });
    expect(f.w.samples.entry('chain_t1')!.prov).toMatchObject({ provider: 'elevenlabs', endpoint: 'sound-generation', model: 'eleven_text_to_sound_v2', take: '1/2', request: 'req0001', credits: 15, origFormat: 'pcm_44100', params: 'duration=1.5 loop=no influence=0.4 format=pcm_44100' });
    const l = readLedger(f.dir)[0]!;
    expect(l).toMatchObject({ provider: 'elevenlabs', estimate: 30, charge: 30, chargeFrom: 'header', outcome: 'ok', params: { duration: 1.5, loop: false, influence: 0.4, format: 'pcm_44100' } });
    expect(readSpend()[0]).toMatchObject({ provider: 'elevenlabs', credits: 30, project: 'demo' });
    // loop=yes is sent
    await runGeneration(f.w, sfx('wind', { duration: 1, loop: true }));
    expect(s.requests.at(-1)!.body).toMatchObject({ loop: true });
  });
  it('reads the charge from the account counter when the answer has no cost header, and falls back to the estimate', async () => {
    const s = await useStub({ cost: 'counter' });
    setCap(1000);
    const r = await runGeneration(f.w, sfx('a cork pops', { duration: 1, takes: 2 }));
    expect(r.chargeFrom).toBe('counter');
    expect(r.takes.map((t) => t.credits)).toEqual([10, 10]);
    expect(s.requests.filter((q) => q.path === '/v1/user/subscription')).toHaveLength(3);
    await s.close();
    stub = await startStub({ key: KEY, cost: 'none' });
    setGenerationConfig([['elevenlabs.url', stub.url]]);
    const r2 = await runGeneration(f.w, sfx('a cork pops', { duration: 1.2 }));
    expect(r2.chargeFrom).toBe('estimate');
    expect(r2.charge).toBe(12);
    expect(generateText(r2)).toMatch(/charged 12 credits \(from the estimate \(the provider said nothing\)\)/);
  });
  it('calls the music endpoint once the user turns it on, with a length or a composition plan', async () => {
    const s = await useStub();
    setCap(2000);
    // a music take of 12 s is about 329 credits: over the default 300 a call may cost
    await expect(runGeneration(f.w, { kind: 'music', prompt: 'a calm harp loop in D', duration: 12, by: claude })).rejects.toThrow(/music endpoint is held.*\n.*one take costs about 329 credits/s);
    setGenerationConfig([['elevenlabs.music', 'on'], ['max-per-call', '1000']]);
    const r = await runGeneration(f.w, { kind: 'music', prompt: 'a calm harp loop in D', duration: 12, by: claude, as: 'harp' });
    expect(s.requests.at(-1)).toMatchObject({ path: '/v1/music', body: { prompt: 'a calm harp loop in D', music_length_ms: 12000, model_id: 'music_v1' } });
    expect(r.charge).toBe(329);
    expect(f.w.samples.entry('harp_t1')!.tags).toEqual(['generated', 'music']);
    const plan = { sections: [{ name: 'a', lines: [] }] };
    await runGeneration(f.w, { kind: 'music', prompt: '', composition: plan, duration: 10, by: claude, as: 'planned' });
    expect(s.requests.at(-1)!.body).toEqual({ composition_plan: plan, model_id: 'music_v1' });
    expect(againOptions(f.w, 'planned_t1', claude).composition).toEqual(plan);
  });
  it('keeps the takes made before one fails, logs a partial command, and refuses when none could be made', async () => {
    await useStub({ fail: { status: 500, body: '{"detail":{"message":"busy"}}' }, failFrom: 2 });
    setCap(1000);
    const r = await runGeneration(f.w, sfx('a pot smashes', { takes: 3, duration: 1 }));
    expect(r.takes.map((t) => t.name)).toEqual(['pot_smashes_t1']);
    expect(r.errors).toEqual(['take 2 of 3: elevenlabs sound-generation answered 500: busy']);
    expect(readLedger(f.dir)[0]).toMatchObject({ outcome: 'partial', charge: 10 });
    expect(generateText(r)).toMatch(/^generated 1 of 3 takes/);
    await expect(runGeneration(f.w, sfx('a pot smashes', { takes: 1, duration: 1 }))).rejects.toThrow(/nothing was generated:\n {2}take 1 of 1: elevenlabs sound-generation answered 500: busy/);
    expect(readLedger(f.dir)[1]).toMatchObject({ outcome: 'failed', charge: 0 });
  });
  it('decodes MP3 through ffmpeg on a plan without PCM, keeping the MP3’s hash in the provenance', async (ctx) => {
    if (spawnSync('ffmpeg', ['-version']).status !== 0) { ctx.skip(); return; }
    const tmp = mkdtempSync(join(tmpdir(), 'soundclaw-mp3-'));
    try {
      writeFileSync(join(tmp, 'in.wav'), pcmToWav({ rate: 44100, channels: 1, format: 'pcm16', frames: 44100, data: stubPcm(1) }));
      execFileSync('ffmpeg', ['-v', 'error', '-i', join(tmp, 'in.wav'), '-b:a', '128k', join(tmp, 'out.mp3')]);
      const mp3 = new Uint8Array(readFileSync(join(tmp, 'out.mp3')));
      const s = await useStub({ mp3 }, 'creator');
      setCap(100);
      const r = await runGeneration(f.w, sfx('a soft thud', { duration: 1 }));
      expect(s.requests.at(-1)!.query).toEqual({ output_format: 'mp3_44100_128' });
      const e = f.w.samples.entry(r.takes[0]!.name)!;
      expect(e.prov.origFormat).toBe('mp3_44100_128');
      expect(e.prov.origHash).toBe(execFileSync('shasum', ['-a', '256', join(tmp, 'out.mp3')]).toString().split(' ')[0]);
      expect(e.format).toBe('pcm16');
      expect(e.licence.id).toBe('generated:elevenlabs:creator');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('ranking takes', () => {
  it('puts the takes that fit want= first, then by closeness to like=', async () => {
    f.w.run({ commands: 'sound new ref voice=classic preset=hit seed=3', by: claude });
    const r = await runGeneration(f.w, sfx('a dull knock', { provider: 'fake', takes: 4, duration: 1, want: 'dur=0.9-1.1 lufs>-60', like: 'ref' }));
    expect(r.takes.map((t) => t.rank)).toEqual([1, 2, 3, 4]);
    expect(r.takes.every((t) => t.fits === true && typeof t.distance === 'number')).toBe(true);
    const d = r.takes.map((t) => t.closeness!);
    expect([...d].sort((a, b) => a - b)).toEqual(d);
    const text = generateText(r);
    expect(text).toMatch(/ranked by want "dur=0\.9-1\.1 lufs>-60", then closeness to ref \(level matched\):\n1\. (a_)?dull_knock_t/);
    expect(text).toMatch(/fits want {2}distance \d+\.\d\d from ref/);
    const missing = await runGeneration(f.w, sfx('a dull knock', { provider: 'fake', takes: 2, duration: 1, want: 'dur>5', as: 'k' }));
    expect(missing.takes.every((t) => t.fits === false)).toBe(true);
    expect(generateText(missing)).toMatch(/misses dur>5/);
    expect(generateJson(missing).takes).toHaveLength(2);
    // like= of something that is not there is refused before any call
    await expect(runGeneration(f.w, sfx('x', { provider: 'fake', like: 'nothing_here' }))).rejects.toThrow(/no sound, song or audio file 'nothing_here'/);
  });
});

describe('like= ranking', () => {
  it('takes a reference file outside the project, and ranks by the distance with the level matched (the other number is printed too)', async () => {
    f.w.run({ commands: 'sound new ref voice=classic preset=hit seed=3', by: claude });
    const file = join(f.root, 'ref.wav');
    writeFileSync(file, f.w.wavOf('ref'));
    const r = await runGeneration(f.w, sfx('a dull knock', { provider: 'fake', takes: 3, duration: 1, like: file }));
    expect(r.takes.every((t) => typeof t.distance === 'number' && typeof t.distanceWithLevel === 'number')).toBe(true);
    const d = r.takes.map((t) => t.distance!);
    expect([...d].sort((a, b) => a - b)).toEqual(d);
    expect(generateText(r)).toMatch(/distance \d+\.\d\d from ref\.wav \(level matched; \d+\.\d\d with the level\)/);
    expect((generateJson(r).takes as { distanceWithLevel: number | null }[])[0]!.distanceWithLevel).not.toBeNull();
  });
  it('the distance with the level matched leaves loudness out, and only that', () => {
    const a = [0, -20, 0, 0.5, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const b = a.map((v, i) => (i === 1 ? -5 : v));
    expect(similarDistance(a, b)).toBeGreaterThan(0.5);
    expect(similarDistance(a, b, true)).toBe(0);
    expect(similarDistance(a, b.map((v, i) => (i === 3 ? 1.5 : v)), true)).toBeGreaterThan(0.5);
  });
});

describe('trim=yes: takes that come back longer than asked', () => {
  const frames = (name: string): number => f.w.samples.entry(name)!.frames;
  it('the fake provider returns takes twice as long (SOUNDCLAW_FAKE_LONGER=2); trim=yes cuts each to the duration around its loudest part', async () => {
    const plain = await runGeneration(f.w, sfx('a dull knock', { provider: 'fake', takes: 2, duration: 1, as: 'plain' }));
    process.env.SOUNDCLAW_FAKE_LONGER = '2';
    const long = await runGeneration(f.w, sfx('a dull knock', { provider: 'fake', takes: 2, duration: 1, as: 'long' }));
    expect(long.takes.map((t) => frames(t.name))).toEqual([88200, 88200]); // as the provider sends them
    expect(long.takes.every((t) => t.trimmed === undefined)).toBe(true);
    const cut = await runGeneration(f.w, sfx('a dull knock', { provider: 'fake', takes: 2, duration: 1, as: 'cut', trim: true }));
    expect(cut.takes.map((t) => frames(t.name)).sort()).toEqual([44100, 44100]);
    for (const t of cut.takes) {
      expect(t.trimmed).toMatchObject({ from: 2, to: 1, by: 'loudest' });
      expect(t.trimmed!.at).toBeGreaterThan(0.55); // the loud part sits 0.6 s in, in a bed of faint noise
      expect(t.trimmed!.at).toBeLessThan(0.62);
      expect(t.measure.duration).toBeCloseTo(1, 3);
    }
    // it kept the part that was asked for: as loud as the same take generated at the length asked
    const asked = new Map(plain.takes.map((t) => [t.take, t.measure.lufs] as const));
    delete process.env.SOUNDCLAW_FAKE_LONGER;
    for (const t of cut.takes) expect(Math.abs(t.measure.lufs - (asked.get(t.take) ?? asked.get(t.take - 2) ?? t.measure.lufs))).toBeLessThan(3);
    const text = generateText(cut);
    expect(text).toMatch(/trimmed from 2\.00 s/);
    expect(text).toMatch(/trimmed from 2\.00 s to 1\.00 s, from 0\.\d\d s in \(around its loudest part\)/);
    expect((generateJson(cut).takes as { trimmedFrom: number }[])[0]!.trimmedFrom).toBe(2);
    // the provenance says so, and generating again remembers it
    expect(f.w.samples.entry(cut.takes[0]!.name)!.prov.params).toContain('trim=yes');
    expect(againOptions(f.w, cut.takes[0]!.name, claude).trim).toBe(true);
  });
  it('with like= the part closest to the reference is kept; a take no longer than asked is left alone; trim=no and the default do nothing', async () => {
    process.env.SOUNDCLAW_FAKE_LONGER = '2';
    f.w.run({ commands: 'sound new ref voice=classic preset=hit seed=3', by: claude });
    const r = await runGeneration(f.w, sfx('a dull knock', { provider: 'fake', takes: 2, duration: 1, as: 'near', trim: true, like: 'ref' }));
    expect(r.takes.every((t) => t.trimmed?.by === 'like' && frames(t.name) === 44100)).toBe(true);
    expect(generateText(r)).toMatch(/the part closest to ref\)/);
    delete process.env.SOUNDCLAW_FAKE_LONGER;
    const exact = await runGeneration(f.w, sfx('a dull knock', { provider: 'fake', takes: 1, duration: 1, as: 'exact', trim: true }));
    expect(exact.takes[0]!.trimmed).toBeUndefined();
    expect(frames(exact.takes[0]!.name)).toBe(44100);
    expect(optionsFromPairs('sfx', 'x', { trim: 'no' }, claude).trim).toBe(false);
    expect(() => optionsFromPairs('sfx', 'x', { trim: 'maybe' }, claude)).toThrow(/trim is yes or no/);
  });
});

describe('generation is acquisition, never replay', () => {
  it('replays, undoes and redoes the takes without calling the provider', async () => {
    const s = await useStub();
    setCap(1000);
    const r = await runGeneration(f.w, sfx('a creaking hinge', { takes: 2, duration: 1, as: 'hinge' }));
    const calls = s.requests.length;
    f.w.run({ commands: 'sound new door voice=layered\nlayer add door sample sample=hinge_t1', by: claude });
    const before = f.w.render('door').key;
    // a new writer replays the tape: the same samples, the same render, no call
    const w2 = f.reopen();
    expect(w2.samples.entry('hinge_t2')!.hash).toBe(r.takes[1]!.hash);
    expect(w2.render('door').key).toBe(before);
    // undo the generation group (after the sound's) and redo it
    expect(f.w.run({ commands: 'undo', by: claude }).ok).toBe(true);
    expect(f.w.run({ commands: `undo group=${r.group}`, by: claude }).ok).toBe(true);
    expect(f.w.samples.names()).toEqual([]);
    expect(f.w.run({ commands: 'redo', by: claude }).ok).toBe(true);
    expect(f.w.samples.names().sort()).toEqual(['hinge_t1', 'hinge_t2']);
    expect(s.requests.length).toBe(calls);
    await w2.thumbs.close();
  });
});

describe('the key', () => {
  it('never appears in an output, an error, the tape, a sample file, the ledgers or the settings', async () => {
    const texts: string[] = [];
    const s = await useStub();
    setCap(5000);
    // made takes, an estimate, the settings
    texts.push(generateText(await runGeneration(f.w, sfx('a bell rings once', { takes: 2, duration: 1 }))));
    texts.push(estimateText(await f.w.enqueue(() => planGeneration(f.w, sfx('a bell', { duration: 1 })))));
    texts.push(configText(readGenerationConfig()));
    texts.push(JSON.stringify(readGenerationConfig()));
    // a provider error that echoes the key
    await s.close();
    stub = await startStub({ key: KEY, fail: { status: 400, body: '{"detail":{"message":"bad request for key $KEY (xi-api-key: $KEY)"}}' } });
    setGenerationConfig([['elevenlabs.url', stub.url]]);
    try { await runGeneration(f.w, sfx('a bell', { duration: 1 })); } catch (e) { texts.push((e as Error).message); }
    // a stub that wants another key, and echoes the one it was sent
    await stub.close();
    stub = await startStub({ key: 'another-key' });
    setGenerationConfig([['elevenlabs.url', stub.url]]);
    try { await runGeneration(f.w, sfx('a bell', { duration: 1 })); } catch (e) { texts.push((e as Error).message); }
    expect(texts.some((t) => t.includes('Invalid API key: [redacted]'))).toBe(true);
    expect(texts.some((t) => t.includes('bad request for key [redacted]'))).toBe(true);
    // every file the project and the settings hold
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(join(d, x.name)) : [join(d, x.name)]));
    for (const file of [...walk(f.dir), ...walk(process.env.SOUNDCLAW_CONFIG_DIR!)]) texts.push(readFileSync(file, 'latin1'));
    expect(texts.length).toBeGreaterThan(8);
    for (const t of texts) expect(t.includes(KEY), t.slice(0, 200)).toBe(false);
    expect(readLedger(f.dir).length).toBe(3);
  });
  it('is taken out of text by its value and by its shape', () => {
    expect(redact(`key ${KEY} here`, KEY)).toBe('key [redacted] here');
    expect(redact('sk_0123456789abcdef0123 and "xi-api-key": "abc"')).toBe('[redacted] and "xi-api-key": "[redacted]"');
  });
});

describe('settings and the ledger', () => {
  it('sets and clears the user’s settings, refusing what it does not know', () => {
    setGenerationConfig([['elevenlabs.plan', 'creator'], ['daily-cap', '1500'], ['elevenlabs.rate.sfx', '12'], ['provider', 'fake']]);
    expect(readGenerationConfig()).toEqual({ providers: { elevenlabs: { plan: 'creator', rates: { sfx: 12 } } }, dailyCap: 1500, provider: 'fake' });
    expect(configText(readGenerationConfig())).toMatch(/elevenlabs: licence generated:elevenlabs:creator \(plan creator\); output mp3_44100_128; sfx 12 credits\/s, music 27\.4 credits\/s; music held/);
    setGenerationConfig([['elevenlabs.rate.sfx', 'none'], ['provider', 'none']]);
    expect(readGenerationConfig().providers!.elevenlabs).toEqual({ plan: 'creator' });
    expect(() => setGenerationConfig([['colour', 'red']])).toThrow(/no setting 'colour'/);
    expect(() => setGenerationConfig([['nobody.plan', 'pro']])).toThrow(/no provider 'nobody'/);
    expect(() => setGenerationConfig([['daily-cap', 'lots']])).toThrow(/daily-cap is a number of credits/);
    expect(() => setGenerationConfig([['elevenlabs.music', 'maybe']])).toThrow(/on or off/);
    expect(() => setGenerationConfig([['elevenlabs.url', 'ftp://x']])).toThrow(/http\(s\) address/);
  });
  it('refuses to send a key over plain http to another machine', async () => {
    setGenerationConfig([['elevenlabs.url', 'http://example.org'], ['elevenlabs.plan', 'pro']]);
    setCap(100);
    await expect(runGeneration(f.w, sfx('a bell', { duration: 1 }))).rejects.toThrow(/http:\/\/example\.org: a provider is called over https/);
  });
  it('totals the project’s ledger by provider and day, and the user’s spend by project too', async () => {
    await useStub({}, 'pro');
    setCap(100);
    await runGeneration(f.w, sfx('one', { duration: 1 }));
    await runGeneration(f.w, sfx('two', { duration: 2 }));
    await runGeneration(f.w, sfx('three', { provider: 'fake', duration: 2 }));
    const t = ledgerTotals(f.dir);
    expect(t).toMatchObject({ credits: 30, commands: 3, takes: 3, byProvider: { elevenlabs: 30, fake: 0 }, byDay: { '2026-11-06': 30 } });
    expect(ledgerText(t, f.dir)).toMatch(/^30 credits over 3 commands, 3 takes kept\nby provider:\n {2}elevenlabs {2}30 credits\n {2}fake {2}0 credits\nby day \(UTC\):\n {2}2026-11-06 {2}30 credits\n$/);
    const u = ledgerTotals(null);
    expect(u.byProject).toEqual({ [`demo (${f.dir})`]: 30 });
    expect(ledgerText(ledgerTotals(join(f.root, 'nothing')), join(f.root, 'nothing'))).toMatch(/no generation in this project yet/);
  });
  it('reads the command’s words', () => {
    expect(optionsFromPairs('sfx', 'a door', { duration: '2s', takes: '3', loop: 'yes', influence: '0.5', as: 'door', want: 'dur<3', like: 'ref', provider: 'fake' }, claude))
      .toEqual({ kind: 'sfx', prompt: 'a door', by: claude, duration: 2, takes: 3, loop: true, influence: 0.5, as: 'door', want: 'dur<3', like: 'ref', provider: 'fake' });
    expect(() => optionsFromPairs('sfx', 'x', { colour: 'red' }, claude)).toThrow(/no field 'colour'/);
    expect(() => optionsFromPairs('voice', 'x', {}, claude)).toThrow(/sfx or music/);
    expect(() => optionsFromPairs('sfx', 'x', { loop: 'perhaps' }, claude)).toThrow(/loop is yes or no/);
    expect(nameFromPrompt('The slow creak of an old wooden door')).toBe('slow_creak_old');
    expect(nameFromPrompt('!!!')).toBe('take');
  });
  it('makes decodable audio from raw PCM takes', () => {
    const wav = pcmToWav({ rate: 44100, channels: 1, format: 'pcm16', frames: 441, data: stubPcm(0.01) });
    expect(decodeAudio(wav).audio.frames).toBe(441);
    expect(existsSync(f.dir)).toBe(true);
  });
});
