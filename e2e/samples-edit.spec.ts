// Edited samples in the page: a layer that plays a slice, a stretched part and a loop with the windowed sinc renders in the page to the bytes
// Node renders; changing the sample's slice points (no new audio) changes the sound in the page too; and the Samples tab shows each sample's
// numbers and licence (glyph and word) and plays it.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { floatsFromBytes, samplesHash } from '../core/src/index.ts';
import { hitsFloats, toneFloats } from '../core/test/sample-golden-table.ts';
import { pcmFromFloats } from '../core/src/index.ts';
import { wavBytes } from '../core/test/audio-fixtures.ts';
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

test('an edited sample layer renders in the page to the bytes Node renders, follows new slice points, and the Samples tab shows numbers and licence', async ({ page }) => {
  test.setTimeout(150_000);
  const dir = mkdtempSync(join(tmpdir(), 'sc-sample-edit-'));
  try {
    writeFileSync(join(dir, 'hits.wav'), wavBytes(pcmFromFloats([hitsFloats(22050, 2, 0.5)], 22050, 'pcm16')));
    writeFileSync(join(dir, 'tone.wav'), wavBytes(pcmFromFloats([toneFloats(44100, 1)], 44100, 'pcm16')));
    agent = await startAgent();
    const imp = await agent.cli(['sample', 'import', agent.dir, join(dir, 'hits.wav'), 'licence=CC-BY-4.0', 'attribution=made for the test']);
    expect(imp.code, imp.err).toBe(0);
    expect((await agent.cli(['sample', 'import', agent.dir, join(dir, 'tone.wav'), 'licence=own'])).code).toBe(0);
    const run = await agent.cli(['run', agent.dir, '-e', [
      'sample slice hits grid=4',
      'sample loop tone 0.2 0.8',
      'sample derive tone_soft from=tone op="fade out=100ms; gain -6"',
      'sound new edited voice=layered seed=3',
      'layer add edited sample sample=hits slice=2 stretch=1.3 method=wsola',
      'layer add edited sample sample=tone loop=1 xfade=0.02 pitch=5 offset=0.1',
      'sound new soft voice=layered seed=4',
      'layer add soft sample sample=tone_soft interp=cubic pitch=-3',
    ].join('\n')]);
    expect(run.code, run.err).toBe(0);
    await page.goto(`${agent.url}&name=ana`);
    await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
    await expect(page.getByTestId('card-edited')).toBeVisible();
    // the page plays what the server renders, for edits that read the sample's metadata, and for a derived sample
    const first = await serverHash('edited');
    expect(await playedHash(page, 'edited')).toBe(first);
    expect(await playedHash(page, 'soft')).toBe(await serverHash('soft'));
    // new slice points are metadata only: no new audio, and the sound changes in the page as it does on the server
    expect((await agent.cli(['run', agent.dir, '-e', 'sample slice hits at=0,0.25,0.75'])).code).toBe(0);
    const changed = await serverHash('edited');
    expect(changed).not.toBe(first);
    await expect.poll(async () => playedHash(page, 'edited'), { timeout: 15_000 }).toBe(changed);
    // the Samples tab: numbers, licence glyph and word, and a play button
    await page.getByTestId('lib-tab-samples').click();
    await expect(page.getByTestId('lib-row-hits')).toBeVisible();
    await expect(page.getByTestId('sample-numbers-hits')).toContainText('2.00 s');
    await expect(page.getByTestId('sample-numbers-hits')).toContainText('22.1 kHz');
    await expect(page.getByTestId('sample-licence-hits')).toHaveAttribute('data-state', 'attribution');
    await expect(page.getByTestId('sample-licence-hits')).toContainText('attribution');
    await expect(page.getByTestId('sample-licence-tone')).toContainText('shippable');
    await expect(page.getByTestId('sample-licence-tone_soft')).toContainText('shippable');
    await page.getByTestId('play-sample-hits').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { soundclaw: { played: { id: string }[] } }).soundclaw.played.some((p) => p.id === 'sample:hits'))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
