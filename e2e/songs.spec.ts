// Song cards in a browser: play, the loop playing repeatedly, the pattern text with the current step lit,
// mute and solo for listening (nothing written), and the browser's samples equal to Node's.

import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { test } from './fixtures.ts';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

const SHOTS = join(import.meta.dirname, '..', '.dev', 'screens');
type SongPlayed = { id: string; mode: string; hash: string; muted: string[] };
const songsPlayed = (page: Page): Promise<SongPlayed[]> => page.evaluate(() => (window as unknown as { soundclaw: { songsPlayed: SongPlayed[] } }).soundclaw.songsPlayed);

// 240 bpm: eight steps at two per beat last one second
const SETUP = `song new demo tempo=240 key=C:major
song channel add demo lead inst=pulse_lead gain=0.8 layer=tension
song channel add demo bass inst=triangle_bass layer=base
song channel add demo drums kit=default layer=base
pattern demo.verse steps=8 tpb=2 bar=4
  lead: C5 . E5 . | G5 - E5 .
  bass: C3 . . . | G2 . . .
  drums: k . h . | s . h h
pattern demo.chorus steps=8 tpb=2 bar=4
  lead: A4 . C5 . | E5 - C5 .
  bass: A2 . . . | E2 . . .
  drums: k . h . | s . h h
song section add demo A verse
song section add demo B chorus
song loop demo A..B
`;

async function open(page: Page): Promise<void> {
  agent = await startAgent();
  const r = await agent.cli(['run', agent.dir, '-e', SETUP]);
  expect(r.code, r.err).toBe(0);
  await page.goto(`${agent.url}&name=ana`);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
  await expect(page.getByTestId('song-demo')).toBeVisible();
}

test('a song card: numbers, the check badge, the patterns as read-only text', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('song-numbers-demo')).toContainText('240 bpm · 4/4 · C:major · 2.0 s · loop 2.0 s');
  await expect(page.getByTestId('song-check-demo')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('song-patterns-demo')).toContainText('lead');
  await expect(page.getByTestId('pattern-verse-0').locator('.step').first()).toHaveText('C5');
  // read-only: there is nothing to type into
  await expect(page.getByTestId('song-patterns-demo').locator('input, textarea')).toHaveCount(0);
  await expect(page.getByTestId('song-channels-demo')).toContainText('lead');
});

test('play renders the song in the browser to the same samples as the CLI, and lights the step that sounds', async ({ page }) => {
  await open(page);
  const cli = JSON.parse((await agent.cli(['render', agent.dir, 'demo', '--json'])).out) as { hashes: { full: string; loop: string } };
  await page.getByTestId('song-play-demo').click();
  await expect(page.getByTestId('song-demo')).toHaveAttribute('data-playing', 'true', { timeout: 20_000 });
  const p = await songsPlayed(page);
  expect(p.length).toBe(1);
  expect(p[0]).toMatchObject({ id: 'demo', mode: 'full', muted: [] });
  expect(p[0]!.hash).toBe(cli.hashes.full);
  // the lit step moves: collect the steps seen while it plays
  const seen = new Set<string>();
  const patterns = new Set<string>();
  await expect.poll(async () => {
    const step = await page.getByTestId('song-demo').getAttribute('data-step');
    const pat = await page.getByTestId('song-demo').getAttribute('data-pattern');
    if (step) seen.add(step);
    if (pat) patterns.add(pat);
    return seen.size;
  }, { timeout: 8000, intervals: [50] }).toBeGreaterThanOrEqual(4);
  await expect(page.locator('[data-testid=song-demo] .step.now').first()).toBeVisible();
  await page.screenshot({ path: join(SHOTS, 'song-card.png'), clip: (await page.getByTestId('song-demo').boundingBox())! });
  // it ends by itself after 2 s (and a short tail)
  await expect(page.getByTestId('song-demo')).toHaveAttribute('data-playing', 'false', { timeout: 15_000 });
  expect(patterns.size).toBeGreaterThanOrEqual(1);
});

test('the loop plays repeatedly until stopped, its samples equal to the CLI loop render, and the step highlight wraps', async ({ page }) => {
  await open(page);
  const cli = JSON.parse((await agent.cli(['render', agent.dir, 'demo', '--json'])).out) as { hashes: { full: string; loop: string } };
  await page.getByTestId('song-loop-demo').click();
  await expect(page.getByTestId('song-demo')).toHaveAttribute('data-mode', 'loop', { timeout: 20_000 });
  expect((await songsPlayed(page))[0]!.hash).toBe(cli.hashes.loop);
  // 2 s loop: the first pattern comes round again, so we see the verse pattern lit twice with a gap between
  const lit: string[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 9000) {
    const pat = await page.getByTestId('song-demo').getAttribute('data-pattern');
    if (pat && lit.at(-1) !== pat) lit.push(pat);
    await page.waitForTimeout(40);
  }
  expect(lit.length).toBeGreaterThanOrEqual(3); // verse, chorus, verse ...
  expect(lit.slice(0, 3)).toEqual(['verse', 'chorus', 'verse'].slice(lit[0] === 'verse' ? 0 : 1).concat(lit[0] === 'verse' ? [] : ['chorus']).slice(0, 3));
  await expect(page.getByTestId('song-demo')).toHaveAttribute('data-playing', 'true');
  await page.getByTestId('song-loop-demo').click();
  await expect(page.getByTestId('song-demo')).toHaveAttribute('data-playing', 'false');
});

test('mute and solo change what is heard on this page and write nothing', async ({ page }) => {
  await open(page);
  const before = (await agent.cli(['history', agent.dir])).out;
  await page.getByTestId('song-play-demo').click();
  await expect(page.getByTestId('song-demo')).toHaveAttribute('data-playing', 'true', { timeout: 20_000 });
  await page.getByTestId('song-mute-demo-drums').click();
  await expect.poll(async () => (await songsPlayed(page)).length, { timeout: 20_000 }).toBe(2);
  let p = await songsPlayed(page);
  expect(p[1]!.muted).toEqual(['drums']);
  expect(p[1]!.hash).not.toBe(p[0]!.hash);
  await expect(page.getByTestId('song-channel-demo-drums')).toHaveAttribute('data-audible', 'false');
  await page.getByTestId('song-solo-demo-lead').click();
  await expect.poll(async () => (await songsPlayed(page)).length, { timeout: 20_000 }).toBe(3);
  p = await songsPlayed(page);
  expect(p[2]!.muted.sort()).toEqual(['bass', 'drums']);
  await expect(page.getByTestId('song-channel-demo-bass')).toHaveAttribute('data-audible', 'false');
  await expect(page.getByTestId('song-channel-demo-lead')).toHaveAttribute('data-audible', 'true');
  // un-muting everything brings the full mix back: the very same samples as at first
  await page.getByTestId('song-solo-demo-lead').click();
  await page.getByTestId('song-mute-demo-drums').click();
  await expect.poll(async () => (await songsPlayed(page)).length, { timeout: 20_000 }).toBe(5);
  p = await songsPlayed(page);
  expect(p[4]!.hash).toBe(p[0]!.hash);
  expect((await agent.cli(['history', agent.dir])).out).toBe(before);
  await page.getByTestId('song-play-demo').click(); // stop
});

test('a change by the agent shows on the card at once', async ({ page }) => {
  await open(page);
  await agent.cli(['run', agent.dir, '-e', 'song set demo tempo=120']);
  await expect(page.getByTestId('song-numbers-demo')).toContainText('120 bpm', { timeout: 10_000 });
  await expect(page.getByTestId('song-numbers-demo')).toContainText('4.0 s');
});
