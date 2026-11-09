// The component kit at #/kit: the input rules of the knob and the slider (drag, Shift for fine
// steps, double-click to reset, the wheel, click-to-type with units, the arrow keys, the slider
// role), the agent tick and ghost, and the themes.

import { expect, test, type Page } from '@playwright/test';
import { settledDrag } from './drag.ts';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

async function open(page: Page): Promise<void> {
  agent = await startAgent();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${agent.url}#/kit`);
  await expect(page.getByTestId('kit')).toBeVisible();
}
const knob = (page: Page, n: string) => page.getByTestId(`kit-knob-${n}`);
const commits = async (page: Page) => Number(await page.getByTestId('kit-commit-count').textContent());
const now = async (page: Page, n: string) => Number(await knob(page, n).getAttribute('aria-valuenow'));

const drag = (page: Page, loc: ReturnType<typeof knob>, dx: number, dy: number, shift = false): Promise<void> => settledDrag(page, loc, dx, dy, { shift, steps: 8 });

test('a knob is a slider with a value text; a drag writes once, Shift makes it fine, double-click resets', async ({ page }) => {
  await open(page);
  const k = knob(page, 'amount');
  await expect(k).toHaveAttribute('role', 'slider');
  await expect(k).toHaveAttribute('aria-valuenow', '0.5');
  await expect(k).toHaveAttribute('aria-valuetext', '0.50');
  await expect(k).toHaveAttribute('aria-label', 'amount');
  // a drag of 40 px up is a quarter of the sweep; the page hears many drafts but one commit
  await drag(page, k, 0, -40);
  expect(await now(page, 'amount')).toBeCloseTo(0.75, 3);
  expect(await commits(page)).toBe(1);
  expect(await page.getByTestId('kit-log').textContent()).toContain('amount=0.75');
  // Shift: a tenth of that
  await drag(page, k, 0, -40, true);
  expect(await now(page, 'amount')).toBeCloseTo(0.775, 3);
  expect(await commits(page)).toBe(2);
  // down is down, and the value stays inside the range
  await drag(page, k, 0, 400);
  expect(await now(page, 'amount')).toBe(0);
  // double-click returns to the default, as one commit, and leaves no typed entry open
  const before = await commits(page);
  await k.dblclick();
  expect(await now(page, 'amount')).toBe(0.5);
  expect(await commits(page)).toBe(before + 1);
  await expect(page.getByTestId('kit-knob-amount-entry')).toHaveCount(0);
});

test('the wheel steps the value, and a burst of wheel events is one commit', async ({ page }) => {
  await open(page);
  const k = knob(page, 'amount');
  await k.scrollIntoViewIfNeeded();
  const b = (await k.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.wheel(0, -100);
  await page.mouse.wheel(0, -100);
  await page.mouse.wheel(0, -100);
  await expect.poll(() => commits(page)).toBe(1);
  expect(await now(page, 'amount')).toBeCloseTo(0.53, 3);
  await page.mouse.wheel(0, 100);
  await expect.poll(() => commits(page)).toBe(2);
  expect(await now(page, 'amount')).toBeCloseTo(0.52, 3);
});

test('arrow keys step the focused knob, Shift steps finely, Home and End go to the ends', async ({ page }) => {
  await open(page);
  const k = knob(page, 'amount');
  await k.focus();
  await page.keyboard.press('ArrowUp');
  expect(await now(page, 'amount')).toBeCloseTo(0.51, 3);
  await page.keyboard.press('Shift+ArrowUp');
  expect(await now(page, 'amount')).toBeCloseTo(0.511, 3);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  expect(await now(page, 'amount')).toBeCloseTo(0.491, 3);
  await page.keyboard.press('End');
  expect(await now(page, 'amount')).toBe(1);
  await page.keyboard.press('Home');
  expect(await now(page, 'amount')).toBe(0);
  expect(await commits(page)).toBe(6);
});

test('a click opens a typed entry that takes units: 110ms, 1.8k, C6, −3dB, +5st, 18%; Enter applies, Esc cancels', async ({ page }) => {
  await open(page);
  const type = async (name: string, text: string) => {
    await knob(page, name).click();
    const entry = page.getByTestId(`kit-knob-${name}-entry`);
    await expect(entry).toBeFocused();
    await entry.fill(text);
    await entry.press('Enter');
    await expect(entry).toHaveCount(0);
  };
  await type('time', '110ms');
  expect(await now(page, 'time')).toBeCloseTo(0.11, 6);
  await expect(knob(page, 'time')).toHaveAttribute('aria-valuetext', '0.11 s');
  await type('freq', '1.8k');
  expect(await now(page, 'freq')).toBe(1800);
  await expect(knob(page, 'freq')).toHaveAttribute('aria-valuetext', '1.80 kHz');
  await type('freq', 'C6');
  expect(await now(page, 'freq')).toBeCloseTo(1046.5, 1);
  await type('level', '−3dB');
  expect(await now(page, 'level')).toBe(-3);
  await type('pitch', '+5st');
  expect(await now(page, 'pitch')).toBe(5);
  await type('mix', '18%');
  expect(await now(page, 'mix')).toBeCloseTo(0.18, 6);
  // a value over the end is held at the end
  await type('time', '9s');
  expect(await now(page, 'time')).toBe(2);
  // Esc cancels: nothing is written
  const n = await commits(page);
  await knob(page, 'time').click();
  await page.getByTestId('kit-knob-time-entry').fill('1ms');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('kit-knob-time-entry')).toHaveCount(0);
  expect(await commits(page)).toBe(n);
  expect(await now(page, 'time')).toBe(2);
  await expect(knob(page, 'time')).toBeFocused();
  // text that is not a value is refused and the entry stays
  await knob(page, 'time').click();
  await page.getByTestId('kit-knob-time-entry').fill('loud');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('kit-knob-time-entry')).toHaveAttribute('aria-invalid', 'true');
  expect(await commits(page)).toBe(n);
});

test('a slider follows the same rules: drag, Shift, double-click, arrows, typed value', async ({ page }) => {
  await open(page);
  const s = page.getByTestId('kit-slider');
  await expect(s).toHaveAttribute('role', 'slider');
  await expect(s).toHaveAttribute('aria-orientation', 'horizontal');
  const val = async () => Number(await s.getAttribute('aria-valuenow'));
  expect(await val()).toBeCloseTo(0.58, 3);
  await settledDrag(page, s, 60, 0, { steps: 8, at: (b) => ({ x: b.x + 40, y: b.y + b.height / 2 }) });
  expect(await val()).toBeCloseTo(0.58 + 60 / 220, 2);
  await s.dblclick();
  expect(await val()).toBe(0.5);
  await s.focus();
  await page.keyboard.press('ArrowRight');
  expect(await val()).toBeCloseTo(0.51, 3);
  await s.click();
  await page.getByTestId('kit-slider-entry').fill('0.9');
  await page.keyboard.press('Enter');
  expect(await val()).toBe(0.9);
  // the bipolar slider shows the agent's tick and the ghost of the value before
  await expect(page.getByTestId('kit-slider-bipolar-ghost')).toBeVisible();
  await expect(page.getByTestId('kit-slider-bipolar')).toHaveAttribute('aria-valuetext', /set by the agent/);
});

test('set by the agent: a violet tick on the rim and a dashed ghost at the value before; ⌥-click plays before and after', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('kit-state-agent-tick')).toBeVisible();
  await expect(page.getByTestId('kit-state-agent-ghost')).toBeVisible();
  await expect(page.getByTestId('kit-state-rest-tick')).toHaveCount(0);
  await expect(page.getByTestId('kit-state-agent')).toHaveAttribute('aria-valuetext', '0.78, set by the agent');
  const tick = await page.getByTestId('kit-state-agent-tick').evaluate((e) => getComputedStyle(e).fill);
  const agentColour = await page.evaluate(() => { const d = document.createElement('i'); d.style.color = 'var(--agent)'; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; });
  expect(tick).toBe(agentColour);
  // an off control cannot be changed
  const off = page.getByTestId('kit-state-off');
  await expect(off).toHaveAttribute('aria-disabled', 'true');
  const n = await commits(page);
  await off.dblclick({ force: true });
  expect(await commits(page)).toBe(n);
  // ⌥-click is a preview, not a commit
  await page.getByTestId('kit-state-agent').click({ modifiers: ['Alt'] });
  expect(await page.getByTestId('kit-log').textContent()).toContain('hear-before');
  expect((await page.getByTestId('kit-log').textContent())!.split('\n').filter((l) => l.includes('=')).length).toBe(0);
});

test('a fader returns to 0 dB on double-click; checks carry a glyph and a word; the kit follows the theme', async ({ page }) => {
  await open(page);
  const f = page.getByTestId('kit-fader');
  await expect(f).toHaveAttribute('aria-valuenow', '-3');
  await f.dblclick();
  await expect(f).toHaveAttribute('aria-valuenow', '0');
  await expect(f).toHaveAttribute('aria-valuetext', '0.0 dB');
  for (const [k, glyph] of [['pass', '✓'], ['warn', '!'], ['fail', '×'], ['checking', '…']] as const) {
    await expect(page.getByTestId(`kit-badge-${k}`)).toContainText(glyph);
    await expect(page.getByTestId(`kit-badge-${k}`)).toHaveAttribute('aria-label', new RegExp(k === 'pass' ? 'passes' : k === 'warn' ? 'warns' : k === 'fail' ? 'fails' : 'checking'));
  }
  await expect(page.getByTestId('kit-loud-fail')).toContainText('too quiet');
  const ground = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ground').trim());
  expect(await ground()).toBe('#0B0C10');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  expect(await ground()).toBe('#E9EBF0');
  // the windowed list holds a few rows of five thousand
  expect(await page.getByTestId('kit-vlist').locator('[role=option]').count()).toBeLessThan(40);
  await expect(page.getByTestId('kit-vlist')).toHaveAttribute('data-count', '5000');
});
