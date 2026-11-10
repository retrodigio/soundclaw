// Narrow windows: at 1180, 1024, 900, 760 and 360 px wide no screen scrolls the page sideways and the header
// keeps everything it shows (the search button last) on screen. Below
// 1180 the agent rail is a 44 px icon strip (its panel opens over the page); below 900 the library is
// an overlay that ⌥1 opens.

import { expect, test, type Page } from '@playwright/test';
import { SCREENS, makeExample } from './example.ts';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.beforeAll(async () => { agent = await startAgent(); await makeExample(agent); });
test.afterAll(async () => { await agent?.close(); });

const sideways = (page: Page) => page.evaluate(() => {
  const d = document.scrollingElement!;
  // what sticks out past the right edge, for the message
  const out = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed'; })
    .filter((e) => !e.parentElement || e.parentElement.getBoundingClientRect().right <= innerWidth + 1).slice(0, 4)
    .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]}${e.closest('[data-testid]') ? ` in [${e.closest('[data-testid]')!.getAttribute('data-testid')}]` : ''}`);
  // the header clips what does not fit: nothing may be cut there (the search button is the last thing in it)
  const t = document.querySelector('[data-testid=transport]')!;
  const header = t.scrollWidth - t.clientWidth;
  const search = document.querySelector('[data-testid=open-palette]')!.getBoundingClientRect();
  return { scroll: d.scrollWidth - innerWidth, body: document.body.scrollWidth - innerWidth, header: Math.max(header, Math.round(search.right - innerWidth)), out };
});

/** The library's tabs: none starts left of the strip, and one that runs past its right edge is reachable because the strip scrolls. */
const tabsFit = (page: Page) => page.evaluate(() => {
  const list = document.querySelector('[data-testid=lib-tabs]')!;
  const box = list.getBoundingClientRect();
  const scrolls = list.scrollWidth > list.clientWidth + 1;
  const tabs = [...list.querySelectorAll('[role=tab]')].map((t) => ({ name: (t.textContent ?? '').trim(), r: t.getBoundingClientRect() }));
  return { scrolls, left: tabs.filter((t) => t.r.left < box.left - 1).map((t) => t.name), right: tabs.filter((t) => t.r.right > box.right + 1).map((t) => t.name), count: tabs.length };
});

test('at 1440 by 900 every tab of the library rail is whole', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(`${agent.url}&name=ana#/sound/coin_pickup`);
  await expect(page.getByTestId('library-panel')).toBeVisible();
  const r = await tabsFit(page);
  expect(r.count).toBe(5);
  expect(r.left).toEqual([]);
  expect(r.right).toEqual([]);
  await ctx.close();
});

for (const width of [1180, 1024, 900, 760, 360]) {
  test(`at ${width} px no screen scrolls sideways or cuts the header${width < 1180 ? '; the rail is an icon strip' : ''}${width < 900 ? ', the library an overlay' : ''}`, async ({ browser }) => {
    test.setTimeout(240_000);
    const ctx = await browser.newContext({ viewport: { width, height: width <= 760 ? 900 : 800 }, reducedMotion: 'reduce' });
    await ctx.addInitScript(() => { try { localStorage.setItem('soundclaw.prefs', JSON.stringify({ theme: 'dark', density: 'compact', panels: { bottomOpen: true } })); } catch { /* off */ } });
    const page = await ctx.newPage();
    const bad: string[] = [];
    for (const s of SCREENS) {
      await page.goto('about:blank'); // a fresh load: a change of the hash alone keeps the last screen's dialog
      await page.goto(`${agent.url}&name=ana${s.hash}`);
      await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
      await page.getByTestId(s.ready).first().waitFor({ timeout: 30_000 });
      if (s.act) await s.act(page);
      await page.waitForTimeout(250);
      const r = await sideways(page);
      if (r.scroll > 0 || r.body > 0) bad.push(`${s.name}: ${Math.max(r.scroll, r.body)} px (${r.out.join(', ')})`);
      if (r.header > 0) bad.push(`${s.name}: the header is ${r.header} px too wide`);
    }
    expect(bad, `screens that scroll sideways at ${width}`).toEqual([]);
    // the rail and the library
    await page.goto(`${agent.url}&name=ana#/sound/coin_pickup`);
    await page.getByTestId('editor').waitFor();
    if (width < 1180) {
      await expect(page.getByTestId('rail-strip')).toBeVisible();
      expect((await page.getByTestId('rail-strip').boundingBox())!.width).toBeLessThanOrEqual(width <= 720 ? width : 45);
      await expect(page.getByTestId('rail-panel')).toHaveCount(0);
    } else await expect(page.getByTestId('rail-panel')).toBeVisible();
    if (width < 900) {
      await expect(page.getByTestId('library-panel')).toHaveCount(0);
      await page.locator('body').click({ position: { x: 2, y: 2 } });
      await page.keyboard.press('Alt+1');
      await expect(page.getByTestId('library-panel')).toBeVisible();
      await expect(page.getByTestId('library-scrim')).toBeVisible();
      const r = await sideways(page);
      expect(r.scroll).toBeLessThanOrEqual(0);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('library-panel')).toHaveCount(0);
    } else await expect(page.getByTestId('library-panel')).toBeVisible();
    // the library's tabs: none is cut at the left edge, and the strip scrolls when they do not all fit
    if (width >= 900) {
      const t = await tabsFit(page);
      expect(t.left, `tabs cut at the left edge at ${width}`).toEqual([]);
      if (!t.scrolls) expect(t.right, `tabs cut at the right edge at ${width}`).toEqual([]);
    }
    await ctx.close();
  });
}
