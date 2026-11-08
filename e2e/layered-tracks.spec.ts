// The layered editor's tracks: the sum by layer, reordering layers and devices by dragging, moving
// and copying a device to another layer as one batch, and the agent's note on the device it touched.

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
  'fx add boom layer=1 compress',
  'fx add boom layer=2 filter type=bp cutoff=3100',
  'fx add boom layer=3 reverb',
].join('\n');
type Played = { id: string; hash: string };
const played = (page: Page): Promise<Played[]> => page.evaluate(() => (window as unknown as { soundclaw: { played: Played[] } }).soundclaw.played);
const rows = (page: Page) => page.locator('[data-testid=cmd-row]').evaluateAll((rs) => rs.map((r) => ({ by: (r as HTMLElement).dataset.by!, text: r.querySelector('code')!.textContent! })));
const kinds = (page: Page, n: number) => page.getByTestId(`chain-${n}`).locator('[data-testid^="fx-"][data-kind]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.kind));

async function open(page: Page, setup = SETUP): Promise<void> {
  agent = await startAgent();
  const r = await agent.cli(['run', agent.dir, '-e', setup]);
  expect(r.code, r.err).toBe(0);
  await page.goto(`${agent.url}&name=ana#/sound/boom`);
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
  await page.getByTestId('play-on-change').uncheck();
  await expect.poll(async () => (await rows(page)).length).toBeGreaterThanOrEqual(9);
}

/** The group number the history prints for the newest `count` commands. */
async function groups(count: number): Promise<{ group: string; cmd: string }[]> {
  const out = (await agent.cli(['history', agent.dir])).out.trim().split('\n').slice(-count);
  return out.map((l) => { const m = /^#\d+ (g\d+) \S+ \S+\s+(.*)$/.exec(l)!; return { group: m[1]!, cmd: m[2]! }; });
}

test('the sum by layer: one band per layer; hovering a band solos it for preview; clicking selects its layer', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('lens-panel')).toHaveAttribute('data-lens', 'layers');
  await expect(page.getByTestId('lens-layers')).toHaveAttribute('data-bands', '3', { timeout: 15_000 });
  for (const n of [1, 2, 3]) await expect(page.getByTestId(`band-${n}`)).toHaveAttribute('d', /^M/);
  await expect(page.locator('[data-testid^=strip-]')).toHaveCount(3);
  // find a point inside the third band: near the centre line, in the first part of the sound
  const box = (await page.getByTestId('lens-surface').boundingBox())!;
  const n0 = (await played(page)).length;
  await page.mouse.move(box.x + box.width * 0.05, box.y + box.height * 0.5);
  await expect.poll(async () => (await played(page)).length, { timeout: 5000 }).toBe(n0 + 1);
  const solo = (await played(page)).at(-1)!;
  // that is not the whole sound: a preview of one layer, nothing written
  await page.mouse.move(box.x + box.width * 0.5, box.y - 40);
  const before = (await rows(page)).length;
  await page.getByTestId('editor-play').click();
  await expect.poll(async () => (await played(page)).length).toBe(n0 + 2);
  expect((await played(page)).at(-1)!.hash).not.toBe(solo.hash);
  expect(await rows(page)).toHaveLength(before);
  // a click on a band selects the layer it belongs to, and opens its source
  await page.mouse.click(box.x + box.width * 0.05, box.y + box.height * 0.5);
  await expect(page.locator('[data-testid^=layer-row-].sel')).toHaveCount(1);
  await expect(page.getByTestId('layer-panel')).toBeVisible();
});

test('dragging a layer by its handle is one layer move; the arrows do the same', async ({ page }) => {
  await open(page);
  const n = (await rows(page)).length;
  await page.getByTestId('layer-handle-1').dragTo(page.getByTestId('layer-row-3'));
  await expect.poll(async () => (await rows(page)).length).toBe(n + 1);
  expect((await rows(page))[0]).toMatchObject({ by: 'human:ana', text: 'layer move boom 1 to=3' });
  // layer 1 is now the old layer 2 (white noise)
  await expect(page.getByTestId('layer-row-3')).toHaveAttribute('data-kind', 'osc');
  await expect(page.getByTestId('layer-src-1')).toContainText('white');
  await expect(page.getByTestId('layer-src-3')).toContainText('brown');
  // the arrows and keyboard are the same command
  await page.getByTestId('layer-down-1').click();
  await expect.poll(async () => (await rows(page))[0]!.text).toBe('layer move boom 1 to=2');
});

test('dragging a device within a chain is one fx move', async ({ page }) => {
  await open(page);
  expect(await kinds(page, 1)).toEqual(['filter', 'distort', 'compress']);
  const n = (await rows(page)).length;
  await page.getByTestId('fx-1-1').dragTo(page.getByTestId('fx-1-3'));
  await expect.poll(async () => (await rows(page)).length).toBe(n + 1);
  expect((await rows(page))[0]).toMatchObject({ by: 'human:ana', text: 'fx move boom layer=1 1 to=3' });
  await expect.poll(async () => kinds(page, 1)).toEqual(['distort', 'compress', 'filter']);
});

test('dragging a device to another layer is one batch (remove, then add with the same parameters); Alt-drag copies', async ({ page }) => {
  await open(page);
  const n = (await rows(page)).length;
  await page.getByTestId('fx-1-2').dragTo(page.getByTestId('layer-row-2'));
  await expect.poll(async () => (await rows(page)).length).toBe(n + 2);
  const g = await groups(2);
  expect(g[0]!.cmd).toBe('fx add boom layer=2 distort drive=6 at=2');
  expect(g[1]!.cmd).toBe('fx remove boom layer=1 2');
  expect(g[0]!.group).toBe(g[1]!.group); // one batch: one undo
  await expect.poll(async () => kinds(page, 1)).toEqual(['filter', 'compress']);
  await expect.poll(async () => kinds(page, 2)).toEqual(['filter', 'distort']);
  // one undo takes the whole move back
  await page.getByTestId('editor-undo').click();
  await expect.poll(async () => kinds(page, 1)).toEqual(['filter', 'distort', 'compress']);
  await expect.poll(async () => kinds(page, 2)).toEqual(['filter']);
  // Alt-drag copies: the original stays
  const m = (await rows(page)).length;
  await page.keyboard.down('Alt');
  await page.getByTestId('fx-1-3').dragTo(page.getByTestId('layer-row-3'));
  await page.keyboard.up('Alt');
  await expect.poll(async () => (await rows(page)).length).toBe(m + 1);
  expect((await rows(page))[0]!.text).toMatch(/^fx add boom layer=3 compress /);
  await expect.poll(async () => kinds(page, 3)).toEqual(['reverb', 'compress']);
  expect(await kinds(page, 1)).toEqual(['filter', 'distort', 'compress']);
  // a device can go to the master chain too
  await page.getByTestId('fx-3-1').dragTo(page.getByTestId('master-fx'));
  await expect.poll(async () => kinds(page, 3)).toEqual(['compress']);
  await expect(page.getByTestId('fx-M-1')).toHaveAttribute('data-kind', 'reverb');
});

test('a card opens every parameter with Enter; there is no bypass, because a layered effect has no enabled flag', async ({ page }) => {
  await open(page);
  await page.getByTestId('fx-1-1').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ctl-F-1-1-cutoff')).toBeVisible();
  await expect(page.getByTestId('ctl-F-1-1-type')).toBeVisible();
  await page.getByTestId('fx-1-1').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ctl-F-1-1-cutoff')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /bypass/i })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: /bypass/i })).toHaveCount(0);
  // the card shows the effect's two or three main values and a sketch
  await expect(page.getByTestId('fx-1-1')).toContainText('1.8 kHz');
  await expect(page.getByTestId('fx-1-1').locator('svg.dev-sketch path')).toHaveAttribute('d', /^M/);
});

test('the agent\'s note sits on the device it touched, until a person approves', async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window as unknown as { soundclaw: { askForChanges(s: string, n: string): Promise<unknown> } }).soundclaw.askForChanges('boom', 'more weight'));
  await agent.cli(['work', agent.dir, 'claim']);
  const r = await agent.cli(['run', agent.dir, '-e', 'fx add boom layer=3 limit ceiling=-2']);
  expect(r.code, r.err).toBe(0);
  await agent.cli(['work', agent.dir, 'progress', 'added a limiter so the sub does not push the master']);
  const card = page.getByTestId('fx-3-2');
  await expect(card).toHaveAttribute('data-agent', 'true');
  await expect(page.getByTestId('fx-note-3-2')).toHaveText('added a limiter so the sub does not push the master');
  await expect(page.getByTestId('fx-3-1')).not.toHaveAttribute('data-agent', 'true');
  await page.getByTestId('insp-approve').click();
  await expect(card).not.toHaveAttribute('data-agent', 'true');
  await expect(page.getByTestId('fx-note-3-2')).toHaveCount(0);
});
