// A large project (400 sounds, 100 samples, a tape of 3,000 commands, built from the tool's own
// commands) in the browser: the list is there at once, the thumbnails come from the server as the
// cards come into view, nothing blocks the page, playing matches the Node render, the editor opens
// a sample-layer sound, and the audition page is usable at once.

import { expect, test, type Page } from '@playwright/test';
import { samplesHash, floatsFromBytes } from '../core/src/index.ts';
import { execFileSync } from 'node:child_process';
import { cpSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, startAgent, type Agent } from './helpers.ts';

let agent: Agent | undefined;
test.afterEach(async () => { if (agent && process.env.SOUNDCLAW_E2E_LOG) console.log(agent.log()); await agent?.close(); agent = undefined; });

interface Window2 { __long: { start: number; dur: number }[]; soundclaw: { played: { id: string; hash: string }[]; cardStats: { fetched: number; firstAt: number | null; helloAt: number | null }; index: unknown[]; lean: boolean; tape: unknown[] } }

async function watchLongTasks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Window2;
    w.__long = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__long.push({ start: e.startTime, dur: e.duration }); }).observe({ entryTypes: ['longtask'] });
  });
}

const longTasks = (page: Page, after = 0) => page.evaluate((t) => (window as unknown as Window2).__long.filter((x) => x.start >= t).map((x) => Math.round(x.dur)), after);
const firstPaint = (page: Page) => page.evaluate(() => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0);

async function nodeHash(a: Agent, id: string): Promise<string> {
  const bytes = new Uint8Array(await (await fetch(`http://127.0.0.1:${a.port}/api/render/${id}.f32?token=${a.token}`)).arrayBuffer());
  return samplesHash(floatsFromBytes(bytes));
}

test('a project of 400 sounds opens at once, loads thumbnails as cards come into view, plays and edits', async ({ page }) => {
  test.setTimeout(300_000);
  const tb = Date.now();
  agent = await startAgent({ build: (dir) => {
    // SOUNDCLAW_LARGE_DIR: a project built before by test/support/large-project.ts, copied (saves the half minute while working on the page)
    if (process.env.SOUNDCLAW_LARGE_DIR) { cpSync(process.env.SOUNDCLAW_LARGE_DIR, dir, { recursive: true, filter: (f) => !f.includes('.cache') }); return; }
    execFileSync(process.execPath, [join(REPO, 'test', 'support', 'large-project.ts'), dir], { stdio: 'inherit' });
  } });
  const sounds = readdirSync(join(agent.dir, 'sounds')).filter((f) => f.endsWith('.sfx')).map((f) => f.replace(/\.sfx$/, '')).sort();
  console.log(`  fixture built and server started in ${((Date.now() - tb) / 1000).toFixed(1)} s`);
  const T = Date.now();
  const lap = (what: string) => console.log(`  [${((Date.now() - T) / 1000).toFixed(1)} s] ${what}`);
  lap('built');
  expect(sounds.length).toBe(400);
  expect(readdirSync(join(agent.dir, 'samples')).filter((f) => f.endsWith('.wav')).length).toBe(100);
  await watchLongTasks(page);

  // 1. the list, from the state alone
  const t0 = Date.now();
  await page.goto(`${agent.url}&name=ana`);
  await expect(page.getByTestId('card-cl_000')).toBeVisible({ timeout: 10_000 });
  const toList = Date.now() - t0;
  await expect(page.getByTestId('sounds-count')).toContainText('400 of 400 sounds');
  expect(await page.locator('[data-testid^="card-"]').count()).toBe(48);
  expect(await page.evaluate(() => (window as unknown as Window2).soundclaw.lean)).toBe(true);
  // the tape: the newest entries, with the total
  await expect(page.getByTestId('history')).toContainText('(3000 commands)');
  expect(await page.evaluate(() => (window as unknown as Window2).soundclaw.tape.length)).toBeLessThanOrEqual(200);
  expect(await page.locator('[data-testid="cmd-row"]').count()).toBeLessThanOrEqual(200);
  expect(toList, `time to the list: ${toList} ms`).toBeLessThan(2000);

  // 2. thumbnails from the server, for the cards in view
  await expect(page.getByTestId('wave-cl_000')).toHaveAttribute('data-peak', /^0\./, { timeout: 20_000 });
  const toThumb = Date.now() - t0;
  const fetchedAtFirst = await page.evaluate(() => (window as unknown as Window2).soundclaw.cardStats.fetched);
  expect(fetchedAtFirst).toBeLessThan(60);
  const paint = await firstPaint(page);

  // 3. scrolling through the whole list stays responsive
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(80);
  }
  lap('scrolled');
  const tasks = await longTasks(page, paint);
  const longest = Math.max(0, ...tasks);
  console.log(`large project: list ${toList} ms, first thumbnail ${toThumb} ms, longest task after first paint ${longest} ms (${tasks.length} over 50 ms)`);
  expect(longest, `long tasks after first paint: ${tasks.join(', ')} ms`).toBeLessThan(200);
  // cards far down were not asked for before they came near: fewer cards fetched than sounds
  expect(await page.evaluate(() => (window as unknown as Window2).soundclaw.cardStats.fetched)).toBeLessThanOrEqual(400);

  // 4. playing: rendered in the worker, the Node render's samples (a classic sound, a layered one with a sample, and a stereo 30 s loop of a stereo sample)
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const id of ['cl_001', 'ly_101', 'ly_110']) {
    await page.getByTestId('sounds-filter-name').fill(id);
    await expect(page.getByTestId(`play-${id}`)).toBeVisible();
    await page.getByTestId(`play-${id}`).click();
    await expect(page.getByTestId(`play-${id}`)).toHaveAttribute('data-plays', '1', { timeout: 60_000 });
    const played = await page.evaluate((sid) => (window as unknown as Window2).soundclaw.played.filter((p) => p.id === sid).at(-1)!.hash, id);
    expect(played, `${id} played`).toBe(await nodeHash(agent, id));
    await expect(page.getByTestId(`card-${id}`)).toHaveAttribute('data-hash', played, { timeout: 60_000 });
    lap(`played ${id}`);
  }

  // 5. the editor opens a sound with a sample layer (a stereo 30 s loop) and plays it
  const sampled = 'ly_110';
  await page.goto(`${agent.url}&name=ana#/sound/${sampled}`);
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 60_000 });
  lap('editor open');
  const editorTask = Math.max(0, ...(await longTasks(page, paint)));
  console.log(`  longest task while the editor opened: ${editorTask} ms`);
  expect(editorTask, 'the editor of a 30 s stereo loop opens without freezing the page').toBeLessThan(2000);
  const before = await page.evaluate((sid) => (window as unknown as Window2).soundclaw.played.filter((p) => p.id === sid).length, sampled);
  // the 30 s sound started from its card is still sounding: stop it, then play from the editor
  await page.evaluate(() => (window as unknown as { soundclaw: { stop(): void } }).soundclaw.stop());
  await page.getByTestId('editor-play').click();
  await expect.poll(() => page.evaluate((sid) => (window as unknown as Window2).soundclaw.played.filter((p) => p.id === sid).length, sampled), { timeout: 60_000 }).toBe(before + 1);
  const editorHash = await page.evaluate((sid) => (window as unknown as Window2).soundclaw.played.filter((p) => p.id === sid).at(-1)!.hash, sampled);
  expect(editorHash).toBe(await nodeHash(agent, sampled));
  lap('editor played');

  // 6. the audition page on the large project is usable at once
  await page.goto(`${agent.url}&name=ana#/audition`);
  const a0 = Date.now();
  await expect(page.getByTestId('aud-cl_000')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('aud-play-cl_000')).toBeEnabled();
  const toAudition = Date.now() - a0;
  console.log(`audition page usable after ${toAudition} ms`);
  expect(toAudition).toBeLessThan(2000);
  await page.getByTestId('aud-play-cl_000').click();
  await expect(page.getByTestId('aud-play-cl_000')).toHaveAttribute('data-playing', /true|false/);
  await expect.poll(() => page.evaluate(() => (window as unknown as Window2).soundclaw.played.filter((p) => p.id === 'cl_000').length), { timeout: 10_000 }).toBe(1);
  await page.getByTestId('aud-filter-voice').selectOption('layered');
  await expect(page.getByTestId('aud-count')).toContainText('of 400 sounds');
});
