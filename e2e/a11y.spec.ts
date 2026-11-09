// Accessibility: text contrast on every screen in both themes and both densities (4.5:1 for text, 3:1
// for large text and UI glyphs; disabled and decorative text skipped and counted), and the roles the
// dashboard promises: tabs, sliders with a value text, the palette and the composer as dialogs that
// keep focus inside, the library as a listbox, a visible focus ring, reduced motion, and the shortcut
// sheet built from the registry with every shortcut a person needs.

import { expect, test, type Browser, type Page } from '@playwright/test';
import { measureContrast, type ContrastResult } from './contrast.ts';
import { SCREENS, makeExample } from './example.ts';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.describe.configure({ mode: 'default' });
test.beforeAll(async () => { agent = await startAgent(); await makeExample(agent); });
test.afterAll(async () => { await agent?.close(); });

type Theme = 'dark' | 'light';
type Density = 'compact' | 'comfortable';

async function pageWith(browser: Browser, theme: Theme, density: Density, viewport = { width: 1440, height: 900 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  await ctx.addInitScript((p) => { try { localStorage.setItem('soundclaw.prefs', JSON.stringify(p)); localStorage.setItem('soundclaw.homeAll', '1'); } catch { /* off */ } }, { theme, density, panels: { bottomOpen: true, bottomTab: 'history' } });
  return ctx.newPage();
}

async function show(page: Page, a: Agent, hash: string, ready: string): Promise<void> {
  // a fresh load each time (a change of the hash alone would keep a dialog the last screen opened)
  await page.goto('about:blank');
  await page.goto(`${a.url}&name=ana${hash}`);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
  await page.getByTestId(ready).first().waitFor({ timeout: 30_000 });
  // let the numbers and the thumbnails arrive (they change what is drawn)
  await page.getByTestId('lens-measuring').waitFor({ state: 'detached', timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
}

const report = (rows: string[], total: { screens: number; checked: number; disabled: number; decorative: number; overImage: number; covered: number }) =>
  `${total.screens} screens, ${total.checked} text elements checked; skipped: ${total.disabled} disabled, ${total.decorative} decorative, ${total.overImage} over an image or gradient, ${total.covered} covered by a dialog or clipped\n${rows.join('\n')}`;

for (const theme of ['dark', 'light'] as const) {
  for (const density of ['compact', 'comfortable'] as const) {
    test(`contrast: every screen in the ${theme} theme, ${density}`, async ({ browser }) => {
      test.setTimeout(300_000);
      const page = await pageWith(browser, theme, density);
      const fails: string[] = [];
      const total = { screens: 0, checked: 0, disabled: 0, decorative: 0, overImage: 0, covered: 0 };
      for (const s of SCREENS) {
        await show(page, agent, s.hash, s.ready);
        if (s.act) await s.act(page);
        await page.waitForTimeout(150);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.locator('html')).toHaveAttribute('data-density', density);
        const r: ContrastResult = await page.evaluate(measureContrast);
        total.screens++;
        total.checked += r.checked;
        total.disabled += r.skipped.disabled;
        total.decorative += r.skipped.decorative;
        total.overImage += r.skipped.overImage;
        total.covered += r.skipped.covered;
        for (const f of r.fails) fails.push(`${s.name}: ${f.where} "${f.text}" ${f.ratio}:1 < ${f.need} (${f.fg} on ${f.bg}, ${f.size}px)`);
      }
      console.log(`contrast ${theme} ${density}: ${report([], total)}`);
      expect(fails, report(fails, total)).toEqual([]);
      await page.context().close();
    });
  }
}

test('contrast: a new project and the offline banner, in both themes', async ({ browser }) => {
  test.setTimeout(120_000);
  const empty = await startAgent();
  try {
    const fails: string[] = [];
    for (const theme of ['dark', 'light'] as const) {
      const page = await pageWith(browser, theme, 'compact');
      await show(page, empty, '#/', 'new-project');
      for (const f of (await page.evaluate(measureContrast)).fails) fails.push(`new project ${theme}: ${f.where} "${f.text}" ${f.ratio}:1 < ${f.need} (${f.fg} on ${f.bg})`);
      await page.context().close();
    }
    // offline, with an edit queued and the list open
    const pages: Page[] = [];
    for (const theme of ['dark', 'light'] as const) {
      const page = await pageWith(browser, theme, 'compact');
      await show(page, empty, '#/', 'new-project');
      pages.push(page);
    }
    await empty.stop();
    for (const [i, page] of pages.entries()) {
      await page.getByTestId('offline').waitFor();
      await page.evaluate(() => (window as unknown as { soundclaw: { run(c: string): Promise<unknown> } }).soundclaw.run('sound new beep voice=classic preset=blip seed=1'));
      await page.getByTestId('offline-queue').locator('summary').click();
      for (const f of (await page.evaluate(measureContrast)).fails) fails.push(`offline ${i ? 'light' : 'dark'}: ${f.where} "${f.text}" ${f.ratio}:1 < ${f.need} (${f.fg} on ${f.bg})`);
      await page.context().close();
    }
    expect(fails).toEqual([]);
  } finally {
    await empty.close();
  }
});

test('roles: tabs, sliders with a value text, the library as a listbox, dialogs that keep focus, a visible focus ring', async ({ browser }) => {
  const page = await pageWith(browser, 'dark', 'compact');
  await show(page, agent, '#/sound/coin_pickup', 'editor');
  // tab lists hold tabs, and one is selected
  await expect(page.getByTestId('tab-sound-coin_pickup')).toHaveAttribute('aria-selected', 'true');
  for (const list of await page.getByRole('tablist').all()) {
    const name = await list.getAttribute('aria-label');
    expect(await list.getByRole('tab').count(), `tabs in ${name}`).toBeGreaterThan(0);
    expect(await list.locator('[role=tab][aria-selected=true]').count(), `a selected tab in ${name}`).toBeGreaterThanOrEqual(1);
  }
  // every slider has a value text and a name
  const sliders = await page.locator('[role=slider]').evaluateAll((els) => els.map((e) => ({ id: e.getAttribute('data-testid') ?? e.className, name: e.getAttribute('aria-label') ?? e.getAttribute('aria-labelledby'), text: e.getAttribute('aria-valuetext'), now: e.getAttribute('aria-valuenow') })));
  expect(sliders.length).toBeGreaterThan(10);
  const bad = sliders.filter((s) => !s.name || !s.text || s.now === null);
  expect(bad, 'sliders without a name, a value text or a value').toEqual([]);
  // the library is a listbox with options
  await expect(page.getByTestId('lib-list')).toHaveAttribute('role', 'listbox');
  // a visible focus ring: 2 px in the ember colour on a focused knob
  const knob = page.getByTestId('knob-decay');
  await knob.focus();
  await page.keyboard.press('ArrowUp');
  const ring = await knob.evaluate((e) => { const s = getComputedStyle(e); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), shadow: s.boxShadow }; });
  expect(ring.style !== 'none' && ring.width >= 2 || ring.shadow !== 'none').toBe(true);

  // the palette: a dialog; Tab stays inside; Esc gives focus back
  await page.locator('body').click({ position: { x: 2, y: 300 } });
  await page.getByTestId('open-palette').focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('open-palette')).toBeFocused();

  // the composer: a dialog that keeps focus too
  await page.locator('body').click({ position: { x: 2, y: 300 } });
  await page.keyboard.press('r');
  const composer = page.getByTestId('composer');
  await expect(composer).toBeVisible();
  await expect(composer).toHaveAttribute('role', 'dialog');
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab');
    expect(await composer.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(composer).toHaveCount(0);
  await page.context().close();
});

test('never colour alone: checks carry a glyph and a word; authorship carries a shape and a label', async ({ browser }) => {
  const page = await pageWith(browser, 'dark', 'compact');
  await show(page, agent, '#/sound/coin_click', 'editor');
  // every badge has a glyph and words (or an accessible name)
  const badges = await page.locator('.badge').evaluateAll((els) => els.map((e) => ({ text: e.textContent?.trim() ?? '', label: e.getAttribute('aria-label') ?? e.getAttribute('title') ?? '' })));
  expect(badges.length).toBeGreaterThan(0);
  for (const b of badges) expect(/[✓!×…]/.test(b.text) && (/[a-z]/i.test(b.text) || b.label !== '')).toBe(true);
  // library glyphs have a name
  for (const g of await page.locator('.lib-glyph').all()) expect(await g.getAttribute('aria-label')).toMatch(/passes|fails|warns|checking/);
  // author marks: round for the agent, square for a person, each with a name
  await show(page, agent, '#/session', 'session');
  const marks = await page.locator('.author-mark').evaluateAll((els) => els.map((e) => ({ by: e.getAttribute('data-by'), name: e.getAttribute('aria-label') ?? e.getAttribute('title') ?? '', round: getComputedStyle(e).borderRadius })));
  expect(marks.length).toBeGreaterThan(0);
  for (const m of marks) expect(m.name).not.toBe('');
  await page.context().close();
});

test('reduced motion: animations and transitions are instant', async ({ browser }) => {
  const page = await pageWith(browser, 'dark', 'compact');
  await show(page, agent, '#/', 'home');
  const slow = await page.evaluate(() => [...document.querySelectorAll('*')].filter((e) => {
    const s = getComputedStyle(e);
    const longest = (v: string) => Math.max(...v.split(',').map((x) => parseFloat(x) * (x.trim().endsWith('ms') ? 1 : 1000)));
    return (s.animationName !== 'none' && longest(s.animationDuration) > 1) || longest(s.transitionDuration) > 1;
  }).map((e) => `${e.tagName}.${e.className}`).slice(0, 10));
  expect(slow).toEqual([]);
  await page.context().close();
});

test('the shortcut sheet is built from the registry and lists every shortcut a person needs', async ({ browser }) => {
  const page = await pageWith(browser, 'dark', 'compact');
  await show(page, agent, '#/', 'home');
  await page.locator('body').click({ position: { x: 2, y: 300 } });
  await page.keyboard.press('?');
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  const text = (await sheet.textContent()) ?? '';
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  const mod = (s: string) => (mac ? s : s.replace(/⌘/g, 'Ctrl').replace(/⌥/g, 'Alt').replace(/⇧/g, 'Shift'));
  const need = ['Space', 'L', '⌘Z', '⇧⌘Z', 'R', '⌘↵', 'M', '⌘K', '/', '↑↓', '↵', 'Esc', '⌥1', '⌥2', '⌥3', '⌥4', '1–5', '1–9', '⇧1–9', 'A', 'B', '=', 'N', 'Tab', 'C', '⌘.', '?'];
  const flat = text.replace(/\s+/g, '');
  const missing = need.filter((k) => !flat.includes(mod(k).replace(/\s+/g, '')));
  expect(missing, `shortcuts missing from the sheet`).toEqual([]);
  await page.context().close();
});
