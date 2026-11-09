// Samples in the page: the audio is fetched by its hash, decoded by core's own decoders, and rendered to the bytes Node renders -
// for 24-bit stereo, FLAC, a stereo layer, and a name that is pointed at other audio and back.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { floatsFromBytes, samplesHash } from '../core/src/index.ts';
import { aiffBytes, channelInts, flacBytes, makeAudio, wavBytes } from '../core/test/audio-fixtures.ts';
import { test } from './fixtures.ts';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

const serverHash = async (id: string): Promise<string> => samplesHash(floatsFromBytes(new Uint8Array(await (await fetch(`http://127.0.0.1:${agent.port}/api/render/${id}.f32?token=${agent.token}`)).arrayBuffer())));
const playedHash = async (page: Page, id: string): Promise<string> => {
  const before = Number((await page.getByTestId(`play-${id}`).getAttribute('data-plays')) ?? 0);
  await page.getByTestId(`play-${id}`).click();
  await expect(page.getByTestId(`play-${id}`)).toHaveAttribute('data-plays', String(before + 1));
  return page.evaluate((sid) => (window as unknown as { soundclaw: { played: { id: string; hash: string }[] } }).soundclaw.played.filter((p) => p.id === sid).at(-1)!.hash, id);
};

test('the page renders stereo, 24-bit and FLAC samples to the bytes Node renders, and follows a name pointed elsewhere and back', async ({ page }) => {
  test.setTimeout(120_000);
  const dir = mkdtempSync(join(tmpdir(), 'sc-samples-'));
  try {
    const wide = makeAudio('pcm24', 2, 9000, 48000, 21);
    const lone = makeAudio('pcm16', 1, 7000, 22050, 22);
    const other = makeAudio('pcm16', 2, 5000, 44100, 23);
    writeFileSync(join(dir, 'wide.aiff'), aiffBytes(wide, { compression: 'sowt' }));
    writeFileSync(join(dir, 'lone.flac'), flacBytes([channelInts(lone, 0)], 16, 22050, { kind: 'lpc' }));
    writeFileSync(join(dir, 'other.wav'), wavBytes(other));
    agent = await startAgent();
    for (const f of ['wide.aiff', 'lone.flac', 'other.wav']) {
      const r = await agent.cli(['sample', 'import', agent.dir, join(dir, f), 'licence=own']);
      expect(r.code, r.err).toBe(0);
    }
    const run = await agent.cli(['run', agent.dir, '-e', [
      'sound new both voice=layered seed=3',
      'layer add both sample sample=wide side=stereo',
      'layer add both sample sample=lone pitch=3 offset=0.1',
      'sound new halves voice=layered seed=4',
      'layer add halves sample sample=wide side=left pan=-1',
      'layer add halves sample sample=wide side=right pan=1',
    ].join('\n')]);
    expect(run.code, run.err).toBe(0);
    await page.goto(`${agent.url}&name=ana`);
    await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
    await expect(page.getByTestId('card-both')).toBeVisible();
    // the page plays what the server renders
    const first = await serverHash('both');
    expect(await playedHash(page, 'both')).toBe(first);
    expect(await playedHash(page, 'halves')).toBe(await serverHash('halves'));
    // point `lone` at other audio: the page fetches the new object by its hash and plays what the server renders now
    const hash = /hash: ([0-9a-f]{64})/.exec((await agent.cli(['sample', 'show', agent.dir, 'other'])).out)![1]!;
    const set = await agent.cli(['sample', 'set', agent.dir, 'lone', `hash=${hash}`, 'rate=44100', 'channels=2', 'frames=5000', 'format=pcm16']);
    expect(set.code, set.err).toBe(0);
    const changed = await serverHash('both');
    expect(changed).not.toBe(first);
    await expect.poll(async () => playedHash(page, 'both'), { timeout: 15_000 }).toBe(changed);
    // and undo brings the old audio back, in the page too
    expect((await agent.cli(['run', agent.dir, '-e', 'undo'])).code).toBe(0);
    expect(await serverHash('both')).toBe(first);
    await expect.poll(async () => playedHash(page, 'both'), { timeout: 15_000 }).toBe(first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
