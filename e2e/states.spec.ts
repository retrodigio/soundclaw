// The dashboard's states: a new project's three starts (each makes something real with the same
// commands an agent uses), and offline: the banner with the server's address and start command, a
// retry countdown, local playback, edits queued with a count and a "not sent" list, sent in order
// on reconnect, and a refused one listed with its reason.

import { expect, type Page } from '@playwright/test';
import { test } from './fixtures.ts';
import { startAgent, type Agent } from './helpers.ts';
import { makeExample } from './example.ts';

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

const tape = (page: Page) => page.evaluate(() => (window as unknown as { soundclaw: { tape: { cmd: string; by: string }[] } }).soundclaw.tape.map((e) => ({ cmd: e.cmd, by: e.by })));

test('a new project offers three starts that make a sound, a set and a song, and the line an agent would run', async ({ page }) => {
  agent = await startAgent();
  await page.goto(`${agent.url}&name=ana`);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
  const np = page.getByTestId('new-project');
  await expect(np).toBeVisible();
  await expect(page.getByTestId('start-sound')).toContainText('A sound from a preset');
  await expect(page.getByTestId('start-set')).toContainText('A set');
  await expect(page.getByTestId('start-song')).toContainText('A song');
  // the agent's line names real commands and this project
  await expect(page.getByTestId('new-cli')).toContainText('soundclaw run');
  await expect(page.getByTestId('new-cli')).toContainText('demo.sclaw');
  await expect(np).toContainText('appear here live');
  // the three starts and the agent's line fit the page column, side panels open, at 1440 and at 1024
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    const fit = await page.evaluate(() => {
      const col = document.querySelector('[data-testid=new-project]')!.parentElement!.getBoundingClientRect();
      return [...document.querySelectorAll('[data-testid^=start-], [data-testid=new-cli]')].map((e) => ({ id: e.getAttribute('data-testid'), over: Math.round(e.getBoundingClientRect().right - col.right) })).filter((x) => x.over > 0);
    });
    expect(fit, `starts sticking out of the page at ${width}`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // pick a preset and press the start: the sound is made by the person and opens
  await page.getByTestId('start-gen-jump').click();
  await page.getByTestId('start-sound').click();
  await expect(page).toHaveURL(/#\/sound\/jump$/);
  await expect.poll(async () => (await tape(page)).at(-1)).toEqual({ cmd: 'sound new jump voice=classic preset=jump seed=1', by: 'human:ana' });

  // the other two from the keyboard, back on the home page (the project is no longer empty, so through the palette's actions)
  await page.goto(`${agent.url}&name=ana#/`);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
  await page.locator('body').click({ position: { x: 600, y: 400 } });
  await page.keyboard.press('Shift+N');
  await expect(page).toHaveURL(/#\/set\/footsteps$/);
  await expect.poll(async () => (await tape(page)).map((e) => e.cmd)).toContain('set new footsteps from=footstep count=4 class=foley seed=1');
  await page.goto(`${agent.url}&name=ana#/`);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
  await page.locator('body').click({ position: { x: 600, y: 400 } });
  await page.keyboard.press('Alt+N');
  await expect(page).toHaveURL(/#\/song\/loop$/);
  const list = await agent.cli(['list', agent.dir]);
  expect(list.out).toMatch(/loop: song, 120 bpm 4\/4, key A:minor, 4 channels \(chords, lead, bass, drums\)/);
  expect(list.out).toMatch(/footsteps_4/);
});

test('offline: a banner with the address and the start command, local playback, a queue of edits sent in order on reconnect, a refusal listed', async ({ page }) => {
  agent = await startAgent();
  await agent.cli(['run', agent.dir, '-e', 'sound new coin voice=classic preset=pickup seed=5\nsound new jump voice=classic preset=jump seed=2']);
  await page.goto(`${agent.url}&name=ana#/sound/coin`);
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
  await page.getByTestId('play-on-change').uncheck();
  await expect(page.getByTestId('offline')).toHaveCount(0);

  await agent.stop();
  const banner = page.getByTestId('offline');
  await expect(banner).toBeVisible();
  await expect(page.getByTestId('offline-title')).toHaveText(`Lost the SoundClaw server at 127.0.0.1:${agent.port}`.replace('127.0.0.1', new URL(agent.url).hostname));
  await expect(page.getByTestId('offline-command')).toContainText('soundclaw serve --project');
  await expect(page.getByTestId('offline-command')).toContainText('demo.sclaw');
  await expect(page.getByTestId('offline-command')).toContainText(`--port ${agent.port}`);
  await expect(page.getByTestId('offline-countdown')).toContainText(/retrying in \d+ s|trying now/);
  await expect(page.getByTestId('listener-chip')).toHaveAttribute('data-state', 'offline');
  await expect(page.getByTestId('listener-chip')).toHaveText('offline');
  await expect(page.getByTestId('offline-queued')).toHaveAttribute('data-count', '0');

  // local playback keeps working
  const n0 = await page.evaluate(() => (window as unknown as { soundclaw: { played: unknown[] } }).soundclaw.played.length);
  await page.getByTestId('transport-play').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { soundclaw: { played: unknown[] } }).soundclaw.played.length)).toBeGreaterThan(n0);

  // an edit through a knob: queued, shown on the knob at once, "not sent"
  await page.getByTestId('knob-decay').click();
  await page.getByTestId('knob-decay-entry').fill('0.3');
  await page.getByTestId('knob-decay-entry').press('Enter');
  await expect(page.getByTestId('offline-queued')).toHaveAttribute('data-count', '1');
  await expect(page.getByTestId('knob-decay')).toHaveAttribute('aria-valuetext', '0.30 s');
  // two more: one the server will refuse (the agent removes `jump` while the server is down), one that lands
  await page.evaluate(() => (window as unknown as { soundclaw: { run(c: string): Promise<unknown> } }).soundclaw.run('sound set jump decay=0.25'));
  await page.evaluate(() => (window as unknown as { soundclaw: { run(c: string): Promise<unknown> } }).soundclaw.run('sound set coin sustain=0.04'));
  await expect(page.getByTestId('offline-queued')).toHaveText('3 edits queued');
  await page.getByTestId('offline-queue').locator('summary').click();
  await expect(page.getByTestId('offline-q')).toHaveCount(3);
  await expect(page.getByTestId('offline-q').first()).toContainText('sound set coin decay=0.364');
  await expect(page.getByTestId('offline-q').first()).toContainText('not sent');
  expect((await agent.cli(['run', agent.dir, '-e', 'sound remove jump', '--by', 'agent:claude'])).code).toBe(0);

  // the server comes back (same port, same token): Retry, and the queue goes out in order
  await agent.restart();
  await page.getByTestId('offline-retry').click();
  await expect(banner).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
  await expect(page.getByTestId('refused')).toBeVisible();
  await expect(page.getByTestId('refused-row')).toHaveCount(1);
  await expect(page.getByTestId('refused-row')).toContainText('sound set jump decay=0.25');
  await expect(page.getByTestId('refused-row')).toContainText(/jump/);
  const mine = (await tape(page)).filter((e) => e.by === 'human:ana').map((e) => e.cmd);
  expect(mine.slice(-2)).toEqual(['sound set coin decay=0.364', 'sound set coin sustain=0.04']);
  await expect(page.getByTestId('knob-decay')).toHaveAttribute('aria-valuetext', '0.30 s');
  await page.getByTestId('refused-dismiss').click();
  await expect(page.getByTestId('refused')).toHaveCount(0);
  await expect(page.getByTestId('listener-chip')).not.toHaveAttribute('data-state', 'offline');
});

test('the library fills in on every page: thumbnails, loudness and a check glyph for each row in view', async ({ page }) => {
  test.setTimeout(120_000);
  agent = await startAgent();
  await makeExample(agent);
  // the home page twice: its cards and the library rows ask for the same thumbnails, and one giving its claim back must not drop the other's
  for (const hash of ['#/', '#/session', '#/song/battle_loop', '#/set/footsteps_grass', '#/audition', '#/review/r1', '#/kit', '#/sound/laser/analysis', '#/']) {
    await page.goto(`${agent.url}&name=ana${hash}`);
    await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
    const rows = page.locator('[data-testid^="lib-row-"]');
    await expect(rows.first()).toBeVisible();
    // every row in view gets its thumbnail and its loudness (no placeholders left)
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('[data-testid^="lib-row-"]')].filter((r) => {
      const b = r.getBoundingClientRect();
      return b.bottom > 0 && b.top < innerHeight && (r.querySelector('.mini-shim') || r.querySelector('.lib-lufs')?.textContent === '…');
    }).map((r) => r.getAttribute('data-testid'))), { message: `placeholders left on ${hash}`, timeout: 20_000 }).toEqual([]);
  }
});

test('the home page and the library want the same thumbnails: every row fills in, in a fresh browser each time', async ({ browser }) => {
  test.setTimeout(120_000);
  agent = await startAgent();
  await makeExample(agent);
  for (let i = 0; i < 3; i++) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => { localStorage.setItem('soundclaw.homeAll', '1'); localStorage.setItem('soundclaw.prefs', JSON.stringify({ panels: { bottomOpen: true, bottomTab: 'history' } })); });
    const page = await ctx.newPage();
    await page.goto(`${agent.url}&name=ana#/`);
    await page.getByTestId('home').waitFor();
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('[data-testid^="lib-row-"]')].filter((r) => r.querySelector('.mini-shim')).length), { message: `rows without a thumbnail, browser ${i + 1}`, timeout: 15_000 }).toBe(0);
    await ctx.close();
  }
});
