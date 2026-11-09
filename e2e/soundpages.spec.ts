// The sound pages' finish: the library keeps its names, the outline is a thin dashed line, flags that
// crowd become one marker with a list, the spectrogram's quiet is the ground, the numbers strip does not
// overlap, the device detail panel is built from the studio components, and native controls wear the tokens.

import { expect, type Page } from '@playwright/test';
import { test } from './fixtures.ts';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

const SETUP = [
  'sound new boom voice=layered seed=4',
  'layer add boom osc wave=brown dur=0.4',
  'layer add boom osc wave=white dur=0.2',
  'layer add boom osc wave=sine freq=48 dur=0.5',
  'fx add boom layer=1 filter type=lp cutoff=1800',
  'fx add boom layer=1 distort drive=6',
  'sound new coin voice=classic preset=pickup seed=5',
  'sound set coin wave=square volume=0.45 decay=0.3',
  'sound new laser voice=classic preset=laser seed=3',
].join('\n');
type Played = { loop?: boolean; region?: [number, number] };
const played = (page: Page): Promise<Played[]> => page.evaluate(() => (window as unknown as { soundclaw: { played: Played[] } }).soundclaw.played);

async function open(page: Page, hash: string, setup = SETUP): Promise<void> {
  agent = await startAgent();
  const r = await agent.cli(['run', agent.dir, '-e', setup]);
  expect(r.code, r.err).toBe(0);
  await page.goto(`${agent.url}&name=ana${hash}`);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
}

test('every library row shows its name, its loudness and its glyph, on every page', async ({ page }) => {
  for (const hash of ['#/sound/coin', '#/sound/boom', '#/sound/laser/analysis', '#/']) {
    if (!agent) await open(page, hash); else await page.goto(`${agent.url}&name=ana${hash}`);
    for (const id of ['boom', 'coin', 'laser']) {
      const row = page.getByTestId(`lib-row-${id}`);
      await expect(row).toBeVisible();
      const name = row.locator('.lib-name');
      await expect(name).toHaveText(id);
      const box = (await name.boundingBox())!;
      expect(box.width, `${id} name width on ${hash}`).toBeGreaterThan(24);
      const rowBox = (await row.boundingBox())!;
      for (const cls of ['.lib-lufs', '.lib-glyph']) {
        const b = (await row.locator(cls).boundingBox())!;
        expect(b.x + b.width, `${id} ${cls} inside the row on ${hash}`).toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.5);
      }
    }
  }
});

test('the outline from before the agent\'s change is a thin dashed line, never filled', async ({ page }) => {
  await open(page, '#/sound/coin');
  await page.evaluate(() => (window as unknown as { soundclaw: { askForChanges(s: string, n: string): Promise<unknown> } }).soundclaw.askForChanges('coin', 'shorter'));
  await agent.cli(['work', agent.dir, 'claim']);
  await agent.cli(['run', agent.dir, '-e', 'sound set coin decay=0.15']);
  const outline = page.getByTestId('lens-outline');
  await expect(outline).toBeVisible();
  const style = await outline.evaluate((e) => { const c = getComputedStyle(e); return { fill: c.fill, dash: c.strokeDasharray, width: c.strokeWidth }; });
  expect(style.fill).toBe('none');
  expect(style.dash).not.toBe('none');
  expect(Number.parseFloat(style.width)).toBeLessThan(2);
  // two lines, the upper and the lower envelope, each a smooth run (no point goes back on itself by more than a fifth of the box)
  const d = (await outline.getAttribute('d'))!;
  expect(d.match(/M/g)).toHaveLength(2);
  const ys = [...d.split('M')[1]!.matchAll(/L?[\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
  const jump = Math.max(...ys.slice(1).map((y, i) => Math.abs(y - ys[i]!)));
  expect(jump).toBeLessThan(80);
});

test('markers within 24 px become one marker with a list; a row loops its flag', async ({ page }) => {
  await open(page, '#/sound/boom');
  await expect(page.getByTestId('lens-layers')).toHaveAttribute('data-bands', '3', { timeout: 15_000 });
  const cluster = page.locator('[data-testid^=flag-cluster-]').first();
  await expect(cluster).toBeVisible();
  await expect(cluster).toContainText(/\d+ checks/);
  // no two markers overlap on screen
  const boxes = await page.locator('[data-testid^=flag-]:not([data-testid^=flag-pop]):not([role=menuitem])').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent).map((e) => e.getBoundingClientRect().toJSON()));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    expect(overlap, `markers ${i} and ${j}`).toBe(false);
  }
  await cluster.click();
  const pop = page.locator('[data-testid^=flag-pop-]').first();
  await expect(pop).toBeVisible();
  const rows = pop.getByRole('menuitem');
  expect(await rows.count()).toBeGreaterThanOrEqual(2);
  // glyph, check name, time, then the detail; long numbers are rounded
  const text = (await rows.first().textContent())!;
  expect(text).toMatch(/^×\w+ \d\.\d{3} s/);
  expect(text).not.toMatch(/\d\.\d{4,}/);
  const n = (await played(page)).length;
  await rows.first().click();
  await expect.poll(async () => (await played(page)).length).toBe(n + 1);
  expect((await played(page)).at(-1)!.loop).toBe(true);
  await expect(pop).toHaveCount(0);
});

test('a flag reads glyph, check, time, then the detail with short numbers', async ({ page }) => {
  await open(page, '#/sound/laser/analysis');
  // the click and the harsh stretch both fall at the very start: one marker with the two in a list
  await page.locator('[data-testid^=flag-cluster-]').first().click();
  const row = page.getByTestId('flag-click-0');
  await expect(row).toBeVisible();
  expect((await row.textContent())!).toMatch(/^×click 0\.000 s · starts at level 0\.\d{1,2}(?!\d)/);
});

test('the spectrogram\'s quiet is the ground colour', async ({ page }) => {
  await open(page, '#/sound/laser/analysis');
  await page.keyboard.press('2');
  const canvas = page.getByTestId('lens-spec-canvas');
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(500);
  const share = await canvas.evaluate((c) => {
    const cv = c as HTMLCanvasElement;
    const g = cv.getContext('2d')!;
    const probe = document.createElement('i'); probe.style.color = 'var(--ground)'; document.body.append(probe);
    const m = /(\d+), (\d+), (\d+)/.exec(getComputedStyle(probe).color)!; probe.remove();
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let near = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i]! - Number(m[1])) + Math.abs(d[i + 1]! - Number(m[2])) + Math.abs(d[i + 2]! - Number(m[3])) < 24) near++;
    return near / (d.length / 4);
  });
  expect(share, 'the share of the picture that is ground').toBeGreaterThan(0.35);
});

test('the analysis page shows the command an agent types from the project folder, and the numbers strip overlaps nothing at 1440 and 1024', async ({ page }) => {
  await open(page, '#/sound/laser/analysis');
  await expect(page.getByTestId('measure-command')).toHaveText('soundclaw measure . laser --json');
  for (const w of [1440, 1024]) {
    await page.setViewportSize({ width: w, height: w === 1440 ? 900 : 768 });
    await expect(page.getByTestId('numbers-strip')).toBeVisible();
    await page.waitForTimeout(300);
    const cards = await page.locator('[data-testid^=nstrip-]').evaluateAll((els) => els.map((e) => ({ r: e.getBoundingClientRect().toJSON(), over: e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1 })));
    expect(cards.length).toBeGreaterThanOrEqual(6);
    // every card's details stay inside the card
    const stray = await page.locator('[data-testid^=nstrip-]').evaluateAll((els) => els.flatMap((e) => [...e.children].map((k) => { const a = e.getBoundingClientRect(), b = k.getBoundingClientRect(); return b.bottom > a.bottom + 1 || b.right > a.right + 1 || b.top < a.top - 1 ? k.className : null; }).filter(Boolean)));
    expect(stray, `details outside their card at ${w}`).toEqual([]);
    for (const c of cards) expect(c.over, `a strip card overflows at ${w}`).toBe(false);
    for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i]!.r, b = cards[j]!.r;
      expect(a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1, `strip cards ${i} and ${j} at ${w}`).toBe(false);
    }
  }
});

test('in the classic editor at 1440 with the inspector open, every card of the numbers strip shows its whole value', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/sound/coin');
  await expect(page.getByTestId('editor')).toHaveAttribute('data-measured', 'true');
  await expect(page.getByTestId('inspector')).toBeVisible();
  await expect(page.getByTestId('nstrip-truePeakDb')).toBeVisible();
  const cut = await page.locator('[data-testid^=nstrip-] .strip-v').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > e.parentElement!.getBoundingClientRect().right + 1).map((e) => e.textContent));
  expect(cut, 'values cut short').toEqual([]);
  await expect(page.getByTestId('nstrip-truePeakDb').locator('.strip-v')).toHaveText(/dBTP$/);
});

test('a click or Enter on a device opens its detail panel, docked to the right, built from the studio components', async ({ page }) => {
  await open(page, '#/sound/boom');
  await expect(page.getByTestId('device-panel').or(page.locator('aside.device-panel'))).toHaveCount(0);
  await page.getByTestId('fx-1-1').click();
  const panel = page.locator('aside.device-panel');
  await expect(panel).toBeVisible();
  const tracks = (await page.getByTestId('layers').boundingBox())!;
  const pb = (await panel.boundingBox())!;
  expect(pb.x).toBeGreaterThanOrEqual(tracks.x + tracks.width - 1); // beside the tracks, not under them
  // knobs with units, a segmented control for the filter type, every parameter
  await expect(page.getByTestId('ctl-F-1-1-cutoff-value')).toHaveText('1.80 kHz');
  await expect(page.getByTestId('ctl-F-1-1-cutoff')).toHaveAttribute('role', 'slider');
  await expect(page.getByTestId('ctl-F-1-1-type')).toHaveAttribute('role', 'radiogroup');
  await expect(page.getByTestId('ctl-F-1-1-type-hp')).toBeVisible();
  await expect(page.locator('[data-testid^=ctl-F-1-1-][role=slider]')).toHaveCount(2); // cutoff, q
  // a typed value writes one command
  await page.getByTestId('ctl-F-1-1-cutoff').click();
  await page.getByTestId('ctl-F-1-1-cutoff-entry').fill('900');
  await page.getByTestId('ctl-F-1-1-cutoff-entry').press('Enter');
  await expect.poll(async () => (await agent.cli(['history', agent.dir])).out).toContain('fx set boom layer=1 1 cutoff=900');
  // the segmented control writes the type
  await page.getByTestId('ctl-F-1-1-type-hp').click();
  await expect.poll(async () => (await agent.cli(['history', agent.dir])).out).toContain('fx set boom layer=1 1 type=hp');
  // the envelope editor is in the panel: make one, move to its curve control, remove a point, clear it
  await page.getByTestId('env-btn-F-1-1-cutoff').click();
  await expect(page.getByTestId('env-graph')).toHaveAttribute('data-target', '1.fx1.cutoff');
  await page.getByTestId('env-point-1').scrollIntoViewIfNeeded();
  await page.getByTestId('env-point-1').click();
  await page.getByTestId('env-curve-exp').click();
  await expect.poll(async () => (await agent.cli(['history', agent.dir])).out).toMatch(/env boom 1\.fx1\.cutoff ".*@exp"/);
  await page.getByTestId('env-clear').click();
  await expect.poll(async () => (await agent.cli(['history', agent.dir])).out).toContain('env boom 1.fx1.cutoff clear');
  // Esc closes it; Enter opens a card again
  await page.getByTestId('ctl-F-1-1-cutoff').focus();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await page.getByTestId('fx-1-2').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ctl-F-1-2-drive')).toBeVisible();
  // the source opens the same way, with the layer's own controls, pan and offset
  await page.getByTestId('source-open-2').click();
  await expect(page.getByTestId('layer-panel')).toHaveAttribute('data-layer', '2');
  await expect(page.getByTestId('ctl-L-2-wave')).toBeVisible();
  await expect(page.getByTestId('layer-pan-2')).toHaveAttribute('role', 'slider');
  await expect(page.getByTestId('layer-offset-2')).toHaveAttribute('role', 'slider');
});

test('native form controls on the sound pages wear the tokens: ground, line border, ember focus ring', async ({ page }) => {
  await open(page, '#/sound/coin');
  const token = (name: string) => page.evaluate((n) => { const i = document.createElement('i'); i.style.color = `var(${n})`; document.body.append(i); const c = getComputedStyle(i).color; i.remove(); return c; }, name);
  const ground = await token('--ground'), line = await token('--line'), ember = await token('--ember');
  for (const id of ['loudness-class', 'mutate-amount', 'seed']) {
    const el = page.getByTestId(id);
    await expect(el).toBeVisible();
    const s = await el.evaluate((e) => { const c = getComputedStyle(e); return { bg: c.backgroundColor, border: c.borderTopColor, appearance: c.appearance }; });
    expect(s.bg, `${id} background`).toBe(ground);
    expect(s.border, `${id} border`).toBe(line);
    expect(s.appearance, `${id} drawn by the page`).toBe('none');
    await el.focus();
    await page.keyboard.press('Tab');
    await el.focus();
    expect(await el.evaluate((e) => getComputedStyle(e).outlineColor), `${id} focus ring`).toBe(ember);
  }
  const box = page.getByTestId('play-on-change');
  expect(await box.evaluate((e) => getComputedStyle(e).appearance)).toBe('none');
  await box.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  expect(await box.evaluate((e) => getComputedStyle(e).outlineColor)).toBe(ember);
  // and in the layered editor
  await page.goto(`${agent.url}&name=ana#/sound/boom`);
  await page.getByTestId('fx-1-1').click();
  const sel = page.getByTestId('env-target');
  expect(await sel.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(ground);
});
