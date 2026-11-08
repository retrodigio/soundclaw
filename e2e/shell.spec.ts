// The shell: panels (collapse, resize, kept per browser), tabs and routes (old links too), the
// command palette and the sentence that becomes a request, shortcuts that stay out of text
// fields, the theme and density kept per browser, the library's order and preview, the agent
// rail, and narrow windows with no horizontal scroll.

import { expect, test, type Page } from '@playwright/test';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

// two sounds that fail a check (a tone has no fade) and one that passes (a layered footstep)
const SETUP = 'sound new beep; sound new boop; sound new soft voice=layered preset=footstep seed=11; set new steps from=soft count=2 class=foley seed=3';

async function open(page: Page, hash = '', setup = SETUP): Promise<void> {
  agent = await startAgent();
  if (setup) expect((await agent.cli(['run', agent.dir, '-e', setup])).code).toBe(0);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${agent.url}&name=ana${hash}`);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
  await expect(page.getByTestId('lib-row-soft')).toBeVisible();
}
const prefs = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('soundclaw.prefs') ?? '{}') as { theme?: string; density?: string; panels?: Record<string, number | boolean | string> });
const played = (page: Page) => page.evaluate(() => (window as unknown as { soundclaw: { played: { id: string }[] } }).soundclaw.played.map((p) => p.id));
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);

test('the layout: transport, library, tabs, agent rail and bottom panel; panels collapse with ⌥1 to ⌥4 and stay collapsed after a reload', async ({ page }) => {
  await open(page);
  for (const id of ['transport', 'library-panel', 'tabbar', 'rail-panel', 'bottom']) await expect(page.getByTestId(id)).toBeVisible();
  const size = async (id: string) => (await page.getByTestId(id).boundingBox())!;
  expect((await size('transport')).height).toBe(52);
  expect((await size('library-panel')).width).toBeCloseTo(288, 0);
  expect((await size('rail-panel')).width).toBeCloseTo(320, 0);
  expect((await size('bottom')).height).toBeCloseTo(220, 0);
  await page.keyboard.press('Alt+1');
  await expect(page.getByTestId('library-panel')).toHaveCount(0);
  await page.keyboard.press('Alt+3');
  await expect(page.getByTestId('rail-panel')).toHaveCount(0);
  await page.keyboard.press('Alt+4');
  await expect(page.getByTestId('bottom')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('transport')).toBeVisible();
  for (const id of ['library-panel', 'rail-panel', 'bottom']) await expect(page.getByTestId(id)).toHaveCount(0);
  expect((await prefs(page)).panels).toMatchObject({ libOpen: false, railOpen: false, bottomOpen: false });
  await page.keyboard.press('Alt+1');
  await page.keyboard.press('Alt+4');
  await expect(page.getByTestId('library-panel')).toBeVisible();
  await expect(page.getByTestId('bottom')).toBeVisible();
  // the toggles in the transport do the same
  await page.getByTestId('toggle-rail').click();
  await expect(page.getByTestId('rail-panel')).toBeVisible();
});

test('panels resize by dragging their edge or with the arrow keys, inside their limits, and the sizes are kept', async ({ page }) => {
  await open(page);
  const edge = page.getByTestId('resize-library');
  const b = (await edge.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 200);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 60, b.y + 200, { steps: 6 });
  await page.mouse.up();
  expect((await page.getByTestId('library-panel').boundingBox())!.width).toBeCloseTo(348, 0);
  // beyond the limits it stops at 420 and at 220
  await edge.focus();
  for (let i = 0; i < 12; i++) await page.keyboard.press('Shift+ArrowRight');
  expect((await page.getByTestId('library-panel').boundingBox())!.width).toBe(420);
  for (let i = 0; i < 20; i++) await page.keyboard.press('Shift+ArrowLeft');
  expect((await page.getByTestId('library-panel').boundingBox())!.width).toBe(220);
  // the bottom panel's top edge: dragging up makes it taller
  const top = (await page.getByTestId('resize-bottom').boundingBox())!;
  await page.mouse.move(top.x + 300, top.y + top.height / 2);
  await page.mouse.down();
  await page.mouse.move(top.x + 300, top.y + top.height / 2 - 80, { steps: 6 });
  await page.mouse.up();
  expect((await page.getByTestId('bottom').boundingBox())!.height).toBeCloseTo(300, 0);
  await page.reload();
  await expect(page.getByTestId('library-panel')).toBeVisible();
  expect((await page.getByTestId('library-panel').boundingBox())!.width).toBe(220);
  expect((await page.getByTestId('bottom').boundingBox())!.height).toBeCloseTo(300, 0);
  expect((await prefs(page)).panels).toMatchObject({ libW: 220, bottomH: 300 });
});

test('tabs and routes: opening an item opens or focuses its tab, × and middle-click close it, the list is kept, and old links work', async ({ page }) => {
  await open(page);
  await page.getByTestId('lib-row-beep').click();
  await page.getByTestId('lib-row-beep').dblclick();
  await expect(page).toHaveURL(/#\/sound\/beep$/);
  await expect(page.getByTestId('tab-sound-beep')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('editor')).toBeVisible();
  // Enter in the library opens the selection in a tab
  await page.getByTestId('lib-row-boop').click();
  await page.getByTestId('lib-list').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/sound\/boop$/);
  await expect(page.getByTestId('tab-sound-beep')).toHaveAttribute('aria-selected', 'false');
  // focusing an open tab again does not duplicate it
  await page.getByTestId('tab-sound-beep').click();
  await expect(page.locator('[data-testid^="tab-sound-"]')).toHaveCount(2);
  await expect(page.getByTestId('editor')).toHaveAttribute('data-testid', 'editor');
  // the list survives a reload
  await page.reload();
  await expect(page.getByTestId('tab-sound-boop')).toBeVisible();
  // × closes; the neighbour takes over
  await page.getByTestId('tab-close-sound-beep').click();
  await expect(page.getByTestId('tab-sound-beep')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/sound\/boop$/);
  await page.getByTestId('tab-sound-boop').click({ button: 'middle' });
  await expect(page.getByTestId('tab-sound-boop')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByTestId('tab-home')).toHaveAttribute('aria-selected', 'true');
  // old links: a set, the audition page, a song and a sound, opened fresh
  for (const [hash, id] of [['#/set/steps', 'set-page'], ['#/audition', 'audition'], ['#/sound/soft', 'editor']] as const) {
    await page.goto(`${agent.url}&name=ana${hash}`);
    await expect(page.getByTestId(id).first()).toBeVisible();
  }
  await expect(page.getByTestId('tab-set-steps')).toBeVisible();
  await page.goto(`${agent.url}&name=ana#/session`);
  await expect(page.getByTestId('session')).toBeVisible();
  await page.goto(`${agent.url}&name=ana#/kit`);
  await expect(page.getByTestId('kit')).toBeVisible();
});

test('the home page is Needs attention, as cards or rows, with Show all one toggle away', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  // the two tones fail; the footstep passes and is not listed
  await expect(page.getByTestId('card-beep')).toBeVisible();
  await expect(page.getByTestId('card-soft')).toHaveCount(0);
  await page.getByTestId('view-rows').click();
  await expect(page.getByTestId('home-row-beep')).toBeVisible();
  await expect(page.getByTestId('home-row-soft')).toHaveCount(0);
  await page.getByTestId('view-cards').click();
  await page.getByTestId('show-all').click();
  await expect(page.getByTestId('card-soft')).toBeVisible();
  await expect(page.getByTestId('set-tile-steps')).toBeVisible();
  // the choice of view is kept
  await page.getByTestId('view-rows').click();
  await page.reload();
  await expect(page.getByTestId('home-rows')).toBeVisible();
});

test('the palette: ⌘K opens it, a sentence becomes a request on the focused item, Esc closes it and focus goes back', async ({ page }) => {
  await open(page, '#/sound/beep');
  await expect(page.getByTestId('editor')).toBeVisible();
  const filter = page.getByTestId('lib-filter');
  await filter.focus();
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('palette')).toBeVisible();
  await expect(page.getByTestId('palette')).toHaveAttribute('aria-modal', 'true');
  await expect(page.getByTestId('palette-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('palette')).toHaveCount(0);
  await expect(filter).toBeFocused();
  // a word finds an action with its shortcut
  await page.keyboard.press('Control+k');
  await page.getByTestId('palette-input').fill('density');
  await expect(page.getByTestId('palette-row-view.density')).toContainText('⌘');
  await expect(page.getByTestId('palette-ask')).toHaveCount(0);
  // a sentence that matches no action is a request, and it names the item
  await page.getByTestId('palette-input').fill('make the beep brighter');
  const ask = page.getByTestId('palette-ask');
  await expect(ask).toBeVisible();
  await expect(ask).toContainText('Ask the agent');
  await expect(ask).toContainText('make the beep brighter');
  await expect(ask).toContainText('beep');
  expect(await page.locator('[data-testid^="palette-"][role=option]').first().getAttribute('data-testid')).toBe('palette-ask');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('palette')).toHaveCount(0);
  await expect(page.getByTestId('toasts')).toContainText('Sent to the agent');
  await expect(page.getByTestId('toasts').locator('[role=status]').first()).toBeVisible();
  const list = await agent.cli(['work', agent.dir, 'list']);
  expect(list.out).toContain('make the beep brighter');
  expect(list.out).toContain('beep');
  await expect(page.getByTestId('rail-request-r1')).toContainText('make the beep brighter');
  await expect(page.getByTestId('rail-request-r1')).toContainText('seen');
  // items open from the palette
  await page.keyboard.press('Control+k');
  await page.getByTestId('palette-input').fill('boop');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/sound\/boop$/);
  // with nothing to point at, the sentence is offered but cannot be sent
  await page.goto(`${agent.url}&name=ana#/`);
  await page.reload();
  await expect(page.getByTestId('lib-row-soft')).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByTestId('palette-input').fill('make everything quieter please');
  await expect(page.getByTestId('palette-ask')).toContainText('select a sound first');
});

test('the shortcut sheet (?) is built from the registry; shortcuts do not fire in text fields, except Esc and ⌘K', async ({ page }) => {
  await open(page);
  await page.getByTestId('lib-filter').focus();
  const was = await prefs(page);
  // typed into the filter: L, R, ?, Space and ⌘. do nothing but type or nothing at all
  await page.keyboard.type('l r ?');
  await expect(page.getByTestId('lib-filter')).toHaveValue('l r ?');
  await expect(page.getByTestId('shortcuts')).toHaveCount(0);
  await page.keyboard.press('Control+.');
  expect(await prefs(page)).toEqual(was);
  expect(await page.evaluate(() => document.documentElement.dataset.density)).toBe('compact');
  await page.keyboard.press('Alt+1');
  // ⌘K works in a text field
  await page.getByTestId('lib-filter').focus().catch(() => undefined);
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('palette')).toBeVisible();
  // and inside the palette's own field the letters are typed
  await page.keyboard.type('?l');
  await expect(page.getByTestId('palette-input')).toHaveValue('?l');
  await page.keyboard.press('Escape');
  // outside a text field they run
  await page.locator('body').click({ position: { x: 700, y: 20 } });
  await page.keyboard.press('?');
  await expect(page.getByTestId('shortcuts')).toBeVisible();
  for (const id of ['transport.play', 'edit.undo', 'nav.palette', 'panel.library', 'panel.rail', 'panel.bottom', 'view.density', 'help.shortcuts', 'edit.ask']) await expect(page.getByTestId(`sc-${id}`)).toBeVisible();
  await expect(page.getByTestId('sc-nav.palette')).toContainText('K');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('shortcuts')).toHaveCount(0);
  // Tab stays in the dialog
  await page.keyboard.press('?');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true);
  await page.keyboard.press('Escape');
});

test('theme and density are kept per browser: the palette and ⌘. change them, a reload keeps them', async ({ page }) => {
  await open(page);
  const attr = (n: string) => page.evaluate((k) => document.documentElement.dataset[k], n);
  expect(await attr('theme')).toBe('dark');
  expect(await attr('density')).toBe('compact');
  const rowH = () => page.getByTestId('lib-row-beep').evaluate((e) => (e.parentElement as HTMLElement).getBoundingClientRect().height);
  expect(await rowH()).toBe(24);
  await page.locator('body').click({ position: { x: 700, y: 20 } });
  await page.keyboard.press('Control+.');
  expect(await attr('density')).toBe('comfortable');
  await expect.poll(rowH).toBe(32);
  await page.keyboard.press('Control+k');
  await page.getByTestId('palette-input').fill('theme');
  await page.keyboard.press('Enter');
  expect(await attr('theme')).toBe('light');
  expect(await prefs(page)).toMatchObject({ theme: 'light', density: 'comfortable' });
  await page.reload();
  await expect(page.getByTestId('lib-row-beep')).toBeVisible();
  expect(await attr('theme')).toBe('light');
  expect(await attr('density')).toBe('comfortable');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(233, 235, 240)');
  // with no saved choice the system's colour scheme decides
  await page.evaluate(() => localStorage.clear());
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  expect(await attr('theme')).toBe('light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  expect(await attr('theme')).toBe('dark');
});

test('the library: failing sounds first, ↑↓ browse and preview, Enter opens, preview can be turned off, the filter narrows', async ({ page }) => {
  await open(page);
  const names = () => page.locator('[data-testid^="lib-row-"]').evaluateAll((es) => es.map((e) => (e as HTMLElement).dataset.testid!.replace('lib-row-', '')));
  // the two tones fail (×), the footstep passes (✓): needs attention first
  await expect(page.getByTestId('lib-row-beep')).toHaveAttribute('data-check', 'fail', { timeout: 20_000 });
  await expect(page.getByTestId('lib-row-soft')).toHaveAttribute('data-check', 'pass');
  // the order settles a moment after the numbers arrive, so rows do not jump under the pointer as they stream in
  await expect.poll(async () => (await names()).slice(0, 2).sort().join(), { timeout: 10_000 }).toBe('beep,boop');
  expect((await names()).indexOf('soft')).toBeGreaterThan(1);
  await expect(page.getByTestId('lib-row-beep')).toContainText('×');
  await expect(page.getByTestId('lib-row-soft')).toContainText('✓');
  await expect(page.getByTestId('lib-tab-sounds')).toContainText('5');
  await expect(page.getByTestId('lib-tab-sets')).toContainText('1');
  await expect(page.getByTestId('lib-count')).toHaveText('5 / 5');
  // ↓ moves the selection and plays it
  await page.getByTestId('lib-filter').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('lib-list')).toBeFocused();
  await expect.poll(() => played(page)).toHaveLength(1);
  const first = (await played(page))[0]!;
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => played(page)).toHaveLength(2);
  expect((await played(page))[1]).not.toBe(first);
  await expect(page.locator('[data-testid^="lib-row-"].sel')).toHaveCount(1);
  // preview off: moving the selection is silent
  await page.keyboard.press('Control+k');
  await page.getByTestId('palette-input').fill('preview');
  await page.keyboard.press('Enter');
  await page.getByTestId('lib-list').focus();
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(500);
  expect(await played(page)).toHaveLength(2);
  // Space plays the selection anyway, Enter opens it
  await page.keyboard.press('Space');
  await expect.poll(() => played(page)).toHaveLength(3);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/sound\/(beep|boop|soft)$/);
  // the filter field narrows the list; / focuses it
  await page.locator('body').click({ position: { x: 700, y: 20 } });
  await page.keyboard.press('/');
  await expect(page.getByTestId('lib-filter')).toBeFocused();
  await page.keyboard.type('so');
  await expect(page.getByTestId('lib-count')).toHaveText('1 / 5');
  await expect(page.getByTestId('lib-row-beep')).toHaveCount(0);
  // sets are a tab of the library
  await page.getByTestId('lib-tab-sets').click();
  await page.getByTestId('lib-filter').fill('');
  await expect(page.getByTestId('lib-row-steps')).toBeVisible();
  await page.getByTestId('lib-row-steps').dblclick();
  await expect(page).toHaveURL(/#\/set\/steps$/);
});

test('the agent rail: its changes pulse and keep a "new" dot until you play or open them; your requests show where they stand; the ask field writes one', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('lib-row-beep')).not.toHaveAttribute('data-new', 'true');
  await agent.cli(['run', agent.dir, '-e', 'sound set beep frequency=660', '--by', 'agent:claude']);
  await expect(page.getByTestId('lib-row-beep')).toHaveAttribute('data-new', 'true');
  await expect(page.getByTestId('feed').getByTestId('feed-item').first()).toContainText('sound set beep frequency=660');
  await expect(page.getByTestId('feed').getByTestId('feed-item').first()).toHaveAttribute('data-by', 'agent');
  // a play button on the feed's line plays that sound; playing clears the dot
  await page.getByTestId('feed').getByRole('button', { name: 'Play beep' }).first().click();
  await expect(page.getByTestId('lib-row-beep')).not.toHaveAttribute('data-new', 'true');
  // the dot is kept per browser: a human's change does not set it
  await page.getByTestId('lib-row-soft').click();
  await page.getByTestId('ask-input').fill('softer please');
  await page.getByTestId('ask-input').press('Enter');
  await expect(page.getByTestId('rail-request-r1')).toContainText('softer please');
  await expect(page.getByTestId('rail-request-r1')).toContainText('sent');
  await expect(page.getByTestId('requests-count')).toContainText('1 request');
  // the agent works on it: the rail follows
  await agent.cli(['work', agent.dir, 'claim', 'r1']);
  await agent.cli(['work', agent.dir, 'progress', 'r1', 'rounding the attack']);
  await expect(page.getByTestId('working-on')).toContainText('softer please');
  await expect(page.getByTestId('wo-latest')).toContainText('rounding the attack');
  await expect(page.getByTestId('rail-request-r1')).toContainText('working');
  await expect(page.getByTestId('listener-chip')).toContainText('rounding the attack');
  await agent.cli(['work', agent.dir, 'done', 'r1', 'lowered the attack']);
  await expect(page.getByTestId('rail-request-r1')).toContainText('ready for review');
  // R focuses the ask field
  await page.locator('body').click({ position: { x: 700, y: 20 } });
  await page.keyboard.press('r');
  await expect(page.getByTestId('ask-input')).toBeFocused();
});

test('the bottom panel: Detail shows the selected sound with its numbers, History lists its commands', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('detail-empty')).toBeVisible();
  await page.getByTestId('lib-row-beep').click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-sound', 'beep');
  await expect(page.getByTestId('detail-wave')).toBeVisible();
  await expect(page.getByTestId('detail-numbers')).toContainText('Integrated');
  await expect(page.getByTestId('detail-numbers')).toContainText('LUFS');
  await expect(page.getByTestId('detail-numbers')).toContainText('True peak');
  await page.getByTestId('bottom-tab-history').click();
  const rows = () => page.locator('[data-testid=cmd-row] code').allTextContents();
  await expect.poll(rows).toContain('sound new beep');
  expect((await rows()).some((r) => r.includes('boop'))).toBe(false);
  await page.getByTestId('lib-row-boop').click();
  await expect.poll(rows).toContain('sound new boop');
  expect((await rows()).includes('sound new beep')).toBe(false);
  await page.getByTestId('bottom-tab-mixer').click();
  await expect(page.getByTestId('mixer-lite')).toBeVisible();
});

for (const [w, h] of [[1024, 768], [760, 900]] as const) {
  test(`narrow window ${w}: no horizontal scroll, and the panels degrade`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    agent = await startAgent();
    await agent.cli(['run', agent.dir, '-e', SETUP]);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`${agent.url}&name=ana`);
    await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
    await expect(page.getByTestId('card-beep')).toBeVisible();
    expect(await noHScroll(page)).toBe(true);
    // below 1180 px the agent rail is a 44 px strip that opens over the page
    await expect(page.getByTestId('rail-strip')).toBeVisible();
    expect((await page.getByTestId('rail-strip').boundingBox())!.width).toBe(44);
    await expect(page.getByTestId('rail-panel')).toHaveCount(0);
    await page.getByTestId('rail-strip-btn').click();
    await expect(page.getByTestId('rail-panel')).toBeVisible();
    expect(await noHScroll(page)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('rail-panel')).toHaveCount(0);
    if (w < 900) {
      // the library is an overlay: ⌥1 opens it, selecting works, Esc closes it
      await expect(page.getByTestId('library-panel')).toHaveCount(0);
      await page.keyboard.press('Alt+1');
      await expect(page.getByTestId('library-panel')).toBeVisible();
      await expect(page.getByTestId('lib-row-soft')).toBeVisible();
      expect(await noHScroll(page)).toBe(true);
      await page.getByTestId('lib-row-soft').dblclick();
      await expect(page).toHaveURL(/#\/sound\/soft$/);
      await expect(page.getByTestId('library-panel')).toHaveCount(0);
    } else {
      await expect(page.getByTestId('library-panel')).toBeVisible();
    }
    await expect(page.getByTestId('transport')).toBeVisible();
    expect(await noHScroll(page)).toBe(true);
    await page.getByTestId('open-palette').click();
    await expect(page.getByTestId('palette')).toBeVisible();
    const pal = (await page.getByTestId('palette').boundingBox())!;
    expect(pal.x).toBeGreaterThanOrEqual(0);
    expect(pal.x + pal.width).toBeLessThanOrEqual(w);
    expect(await noHScroll(page)).toBe(true);
    // the other pages fit too
    for (const hash of ['#/kit', '#/audition', '#/session', '#/set/steps']) {
      await page.keyboard.press('Escape');
      await page.goto(`${agent.url}&name=ana${hash}`);
      await expect(page.getByTestId('transport')).toBeVisible();
      await page.waitForTimeout(150);
      expect(await noHScroll(page), hash).toBe(true);
    }
  });
}
