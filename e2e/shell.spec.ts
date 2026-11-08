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

test('the needs-attention card: name and voice, one 54 px panel, a badge per failing check, who changed it; actions on hover; an overflow menu', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '', `${SETUP}; sound new zap voice=classic preset=laser seed=1`);
  const card = page.getByTestId('card-zap');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('check-zap')).toHaveAttribute('data-pass', 'false', { timeout: 20_000 });
  // four columns at 1440 with both rails open; every card is one height
  await expect(page.getByTestId('need-grid')).toHaveAttribute('data-cols', '4');
  expect((await card.boundingBox())!.height).toBe(168);
  await expect(card.locator('.nc-name')).toHaveText('zap');
  await expect(card.locator('.nc-voice')).toHaveText('classic');
  // one panel of 54 px holds the spectrogram and the waveform drawn over it
  const panel = (await card.locator('.nc-panel').boundingBox())!;
  expect(panel.height).toBe(54);
  for (const id of ['spec-zap', 'wave-zap']) {
    const b = (await card.getByTestId(id).boundingBox())!;
    expect(Math.abs(b.x - panel.x)).toBeLessThan(1);
    expect(Math.abs(b.width - panel.width)).toBeLessThan(1);
    expect(Math.abs(b.height - 54)).toBeLessThan(1);
  }
  // no parameter dump, no two-row button block
  await expect(card.locator('[data-testid^="param"]')).toHaveCount(0);
  // a badge per failing check (at most two), a time only where the check reports one
  const failing = (await page.getByTestId('check-zap').getAttribute('data-failing'))!.split(',');
  await expect(page.getByTestId('check-zap').locator('.badge')).toHaveCount(Math.min(2, failing.length));
  const marks = await card.locator('.nc-mark').count();
  const timed = await page.getByTestId('check-zap').locator('.badge', { hasText: /\d\.\d\d s/ }).count();
  expect(marks).toBe(timed);
  // who changed it last
  await expect(card.locator('.nc-author')).toContainText('agent');
  await expect(card.locator('.nc-author .author-mark[data-by=agent]')).toBeVisible();
  // actions: hidden at rest, shown on hover and on keyboard focus
  const opacity = () => card.locator('.nc-actions').evaluate((e) => getComputedStyle(e).opacity);
  await page.mouse.move(5, 5);
  expect(await opacity()).toBe('0');
  await card.hover();
  await expect.poll(opacity).toBe('1');
  await page.mouse.move(5, 5);
  await expect.poll(opacity).toBe('0');
  await card.getByTestId('play-zap').focus();
  await expect.poll(opacity).toBe('1');
  // the selected card has the ember border
  await card.click({ position: { x: 20, y: 30 } });
  await expect(card).toHaveAttribute('data-selected', 'true');
  const ember = await page.evaluate(() => { const d = document.createElement('i'); d.style.color = 'var(--ember)'; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; });
  expect(await card.evaluate((e) => getComputedStyle(e).borderColor)).toBe(ember);
  await expect(page.getByTestId('detail')).toHaveAttribute('data-sound', 'zap');
  // the overflow menu holds Feedback, Edit and the exports
  await card.hover();
  await card.getByTestId('more-zap').click();
  for (const id of ['feedback-toggle-zap', 'edit-zap', 'export-wav-zap', 'export-patch-zap', 'export-csv-zap']) await expect(page.getByTestId(id)).toBeVisible();
  await expect(page.getByTestId('edit-zap')).toHaveAttribute('href', '#/sound/zap');
  await page.getByTestId('feedback-toggle-zap').click();
  await expect(page.getByTestId('feedback-zap')).toBeVisible();
  // the request line is one line, and the card keeps its height
  await card.getByTestId('reject-zap').click();
  await page.getByTestId('reject-text-zap').fill('shorter please');
  await page.getByTestId('reject-send-zap').click();
  await expect(page.getByTestId('request-r1')).toContainText('shorter please');
  // (nobody is listening yet, so the card says so under itself; an agent that has seen it turns that into the one line)
  await agent.cli(['work', agent.dir, 'list']);
  await expect(page.getByTestId('request-r1')).toContainText('seen by');
  expect((await page.getByTestId('request-r1').boundingBox())!.height).toBeLessThan(20);
  expect((await card.boundingBox())!.height).toBe(168);
  // the exports download
  const dl = page.waitForEvent('download');
  await card.hover();
  await card.getByTestId('more-zap').click();
  await page.getByTestId('export-wav-zap').click();
  expect((await dl).suggestedFilename()).toBe('zap.wav');
});

test('the spectrogram is the token ramp (ground, ember at rising opacity, a pale highlight) in both themes, not the heat map', async ({ page }) => {
  await open(page, '', `${SETUP}; sound new zap voice=classic preset=laser seed=1`);
  const sample = async () => page.getByTestId('spec-zap').evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const set = new Set<number>();
    for (let i = 0; i < d.length; i += 4) set.add((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!);
    return [...set].map((v) => [v >> 16, (v >> 8) & 255, v & 255]);
  });
  const token = (n: string) => page.evaluate((k) => { const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d')!; g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(k).trim(); g.fillRect(0, 0, 1, 1); return Array.from(g.getImageData(0, 0, 1, 1).data.slice(0, 3)); }, n);
  await expect(page.getByTestId('spec-zap')).toHaveAttribute('data-frames', /\d+/, { timeout: 20_000 });
  for (const theme of ['dark', 'light'] as const) {
    if (theme === 'light') {
      await page.keyboard.press('Control+k');
      await page.getByTestId('palette-input').fill('theme');
      await page.keyboard.press('Enter');
    }
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    const ground = await token('--ground');
    const ember = await token('--ember');
    const dist = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]!));
    await expect.poll(async () => {
      const px = await sample();
      const span = dist(ground, ember);
      // some cells sit near the ground, and the ramp rises towards the ember
      return Math.min(...px.map((p) => dist(p, ground))) < span * 0.4 && Math.max(...px.map((p) => dist(p, ground))) > span * 0.5;
    }, { message: `${theme}: the ramp runs from the ground to the ember` }).toBe(true);
  }
  // the heat map's purple and yellow are gone: every colour lies on the ember ramp (red at least as high as blue, blue never above green by much)
  await page.keyboard.press('Control+k');
  await page.getByTestId('palette-input').fill('theme');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await page.waitForTimeout(200);
  const hue = await page.getByTestId('spec-zap').evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let off = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 2]! > d[i]! + 12) off++;
    return off;
  });
  expect(hue).toBe(0);
});

test('the presence pill: the author mark, the agent name and the state, then the request text, at most 260 px; your name is a chip', async ({ page }) => {
  await open(page);
  await page.getByTestId('lib-row-soft').click();
  await page.getByTestId('ask-input').fill('make the footsteps a great deal softer and much less samey, please');
  await page.getByTestId('ask-input').press('Enter');
  await agent.cli(['work', agent.dir, 'claim', 'r1']);
  const pill = page.getByTestId('listener-chip');
  await expect(pill).toHaveAttribute('data-state', 'working');
  await expect(pill.locator('.author-mark[data-by=agent]')).toBeVisible();
  await expect(pill).toContainText('claude');
  await expect(pill).toContainText('working');
  await expect(pill).not.toContainText('agent:claude');
  await expect(pill).not.toContainText('agent \u00B7');
  expect((await pill.boundingBox())!.width).toBeLessThanOrEqual(262);
  await expect(pill).toHaveAttribute('title', /make the footsteps a great deal softer/);
  // your name: a chip, a field after a click
  await expect(page.getByTestId('author')).toHaveCount(0);
  await expect(page.getByTestId('author-chip')).toContainText('ana');
  expect((await page.getByTestId('author-chip').boundingBox())!.height).toBeLessThanOrEqual(26);
  await page.getByTestId('author-chip').click();
  await expect(page.getByTestId('author')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('author-chip')).toBeVisible();
});

test('check markers: only the checks that report a time are drawn on the waveform; clip and loudness are badges only', async ({ page }) => {
  await open(page, '', `${SETUP}; sound new zap voice=classic preset=laser seed=1`);
  await expect(page.getByTestId('lib-row-zap')).toHaveAttribute('data-check', 'fail', { timeout: 20_000 });
  await page.getByTestId('lib-row-zap').click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-sound', 'zap');
  const failing = (await page.getByTestId('lib-row-zap').evaluate(() => (window as unknown as { soundclaw: { summary(id: string): { info?: { failing: string[] } } } }).soundclaw.summary('zap').info!.failing));
  expect(failing.some((n) => ['clip', 'loudness'].includes(n))).toBe(true);
  await expect(page.getByTestId('detail-wave')).toHaveAttribute('aria-label', /Waveform of zap/);
  await expect.poll(async () => (await page.getByTestId('detail-wave').getAttribute('aria-label')) ?? '').not.toMatch(/\b(clip|loudness|dc)\b/);
  const label = (await page.getByTestId('detail-wave').getAttribute('aria-label'))!;
  const flags = await page.getByTestId('detail-wave').locator('.wv-flag').allTextContents();
  for (const f of flags) expect(f).toMatch(/^[\u00D7!] (click|tail|harsh) \d/);
  expect(label.includes('at 0.000 s') && !/click|tail|harsh/.test(label)).toBe(false);
  // the failing checks still show as badges in the title row
  await expect(page.getByTestId('detail').locator('.badge').first()).toContainText(/clip|loudness|click|tail|harsh|dc/);
});

test('a library row shows the id (a sound has no title yet) with what it is made of as the tooltip', async ({ page }) => {
  await open(page);
  const row = page.getByTestId('lib-row-soft').locator('.lib-name');
  await expect(row).toHaveText('soft');
  await expect(row).toHaveAttribute('title', /^soft: .*layer/);
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
