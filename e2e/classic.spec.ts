// The classic editor's modules: a knob writes `sound set`, typed values take units, the drawn
// envelope writes the same parameters, the agent's last change wears a tick and a ghost until a
// person approves it, and the inspector reverts it.

import { expect, type Page } from '@playwright/test';
import { test } from './fixtures.ts';
import { settledDrag } from './drag.ts';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

const SETUP = 'sound new beep voice=classic preset=pickup seed=3; sound set beep wave=sine volume=0.15 decay=0.4 sustain=0.3 punch=0.1';
const rows = (page: Page) => page.locator('[data-testid=cmd-row]').evaluateAll((rs) => rs.map((r) => ({ by: (r as HTMLElement).dataset.by!, text: r.querySelector('code')!.textContent! })));
type Played = { id: string; slot?: string };
const played = (page: Page): Promise<Played[]> => page.evaluate(() => (window as unknown as { soundclaw: { played: Played[] } }).soundclaw.played);

async function open(page: Page): Promise<void> {
  agent = await startAgent();
  await agent.cli(['run', agent.dir, '-e', SETUP]);
  await page.goto(`${agent.url}&name=ana#/sound/beep`);
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
  await page.getByTestId('play-on-change').uncheck();
  await expect.poll(async () => (await rows(page)).length).toBeGreaterThanOrEqual(2); // the setup is on the tape
}

/** A dragged-down knob or corner, in small steps. */
async function dragBy(page: Page, testid: string, dx: number, dy: number): Promise<void> {
  await settledDrag(page, page.getByTestId(testid), dx, dy, { steps: 20, settled: page.getByTestId('editor') });
}

/**
 * Drag an envelope corner by (dx, dy) in twenty explicit pointer steps. The editor measures the sound after every change, and the
 * numbers and badges it shows when they arrive move the modules down; so the drag starts only once the editor has measured the
 * sound as it now stands and the corner is the element under the pointer, and the button is released only once the corner's
 * draft value has followed the pointer.
 */
async function dragCorner(page: Page, testid: string, dx: number, dy: number): Promise<void> {
  await expect(page.getByTestId('editor')).toHaveAttribute('data-measured', 'true');
  const el = page.getByTestId(testid);
  await el.scrollIntoViewIfNeeded();
  const before = await el.getAttribute('aria-valuenow');
  let x = 0, y = 0;
  await expect.poll(async () => {
    const b = await el.boundingBox();
    if (!b) return false;
    x = b.x + b.width / 2;
    y = b.y + b.height / 2;
    return page.evaluate(([px, py, id]) => document.elementFromPoint(px as number, py as number)?.getAttribute('data-testid') === id, [x, y, testid]);
  }).toBe(true);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(x + (dx * i) / 20, y + (dy * i) / 20);
  await expect(el).not.toHaveAttribute('aria-valuenow', before!);
  await page.mouse.up();
}

test('a knob writes one sound set; a typed value takes its unit; the stored number is on the control', async ({ page }) => {
  await open(page);
  const n = (await rows(page)).length;
  // 110 ms is a decay parameter of 0.22 (the length is the parameter squared times 10^5 samples)
  await page.getByTestId('knob-decay').click();
  await page.getByTestId('knob-decay-entry').fill('110ms');
  await page.getByTestId('knob-decay-entry').press('Enter');
  await expect.poll(async () => (await rows(page))[0]!.text).toBe('sound set beep decay=0.22');
  expect((await rows(page))[0]!.by).toBe('human:ana');
  await expect(page.getByTestId('knob-decay')).toHaveAttribute('aria-valuenow', '0.22');
  await expect(page.getByTestId('knob-decay-value')).toHaveText('0.11 s');
  // a volume in dB
  await page.getByTestId('knob-volume').click();
  await page.getByTestId('knob-volume-entry').fill('-6dB');
  await page.getByTestId('knob-volume-entry').press('Enter');
  await expect.poll(async () => (await rows(page))[0]!.text).toBe('sound set beep volume=0.501');
  // arrow keys step the focused knob, a burst of them is one command
  await page.getByTestId('knob-punch').focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await rows(page)).length).toBe(n + 3);
  expect((await rows(page))[0]!.text).toBe('sound set beep punch=0.14');
  await page.waitForTimeout(1000);
  expect(await rows(page)).toHaveLength(n + 3);
  // the wave is a segmented control
  await page.getByTestId('wave-noise').click();
  await expect.poll(async () => (await rows(page))[0]!.text).toBe('sound set beep wave=noise');
});

test('the drawn envelope writes the envelope parameters, one command per corner dragged', async ({ page }) => {
  await open(page);
  const n = (await rows(page)).length;
  const sustain0 = Number(await page.getByTestId('knob-sustain').getAttribute('aria-valuenow'));
  await dragCorner(page, 'env-corner-sustain', 40, 0);
  await expect.poll(async () => (await rows(page)).length).toBe(n + 1);
  const first = (await rows(page))[0]!;
  expect(first.by).toBe('human:ana');
  expect(first.text).toMatch(/^sound set beep sustain=0\.\d+$/);
  expect(Number(first.text.split('=')[1])).toBeGreaterThan(sustain0);
  await expect(page.getByTestId('knob-sustain')).toHaveAttribute('aria-valuenow', first.text.split('=')[1]!);
  // the punch corner moves up and down
  const punch0 = Number(await page.getByTestId('knob-punch').getAttribute('aria-valuenow'));
  await dragCorner(page, 'env-corner-punch', 0, -14);
  await expect.poll(async () => (await rows(page)).length).toBe(n + 2);
  expect((await rows(page))[0]!.text).toMatch(/^sound set beep punch=0\.\d+$/);
  expect(Number((await rows(page))[0]!.text.split('=')[1])).toBeGreaterThan(punch0);
  // the end of the decay and the end of the attack
  await dragCorner(page, 'env-corner-decay', -30, 0);
  await expect.poll(async () => (await rows(page)).length).toBe(n + 3);
  expect((await rows(page))[0]!.text).toMatch(/^sound set beep decay=0\.\d+$/);
  await dragCorner(page, 'env-corner-attack', 10, 0);
  await expect.poll(async () => (await rows(page)).length).toBe(n + 4);
  expect((await rows(page))[0]!.text).toMatch(/^sound set beep attack=0\.\d+$/);
  // nothing else is waiting to be written: no draft is left, and the history holds exactly the four commands
  await expect(page.getByTestId('editor')).toHaveAttribute('data-draft', 'false');
  expect(await rows(page)).toHaveLength(n + 4);
});

test('modules whose parameters rest are off; a failing check marks the module it likely comes from', async ({ page }) => {
  await open(page);
  await agent.cli(['run', agent.dir, '-e', 'sound set beep wave=square volume=0.9']);
  await expect(page.getByTestId('module-3')).toHaveAttribute('data-off', 'true');
  await expect(page.getByTestId('module-6')).toHaveAttribute('data-off', 'true');
  // the preset starts at a high level: the click check fails, and the rule puts that in the filters
  await expect(page.getByTestId('module-7')).toHaveClass(/bad/, { timeout: 15_000 });
  await expect(page.getByTestId('module-7')).toContainText(/click.* lives here/);
  // turning vibrato on turns the module on
  await page.getByTestId('knob-vibratoDepth').click();
  await page.getByTestId('knob-vibratoDepth-entry').fill('30%');
  await page.getByTestId('knob-vibratoDepth-entry').press('Enter');
  await expect(page.getByTestId('module-4')).not.toHaveAttribute('data-off', 'true');
});

test('the agent tick and ghost appear after an agent command and clear after Approve; the inspector reverts and plays the one before', async ({ page }) => {
  await open(page);
  // no tick yet; the control is the person's or nobody's
  await expect(page.locator('[data-testid$=-tick]')).toHaveCount(0);
  await page.getByTestId('knob-decay').scrollIntoViewIfNeeded();
  // a request, answered by the agent: it claims, changes two parameters, and says why
  await page.evaluate(() => (window as unknown as { soundclaw: { askForChanges(s: string, n: string): Promise<unknown> } }).soundclaw.askForChanges('beep', 'shorter please'));
  await agent.cli(['work', agent.dir, 'claim']);
  const run = await agent.cli(['run', agent.dir, '-e', 'sound set beep decay=0.22 sustain=0.1']);
  expect(run.code, run.err).toBe(0);
  // (the checks on this sound still fail, so the agent reports progress rather than done; the note is read from either)
  await agent.cli(['work', agent.dir, 'progress', 'shorter, so a run of coins does not blur']);
  // the tick on the rim and the ghost at the old value
  await expect(page.getByTestId('knob-decay-tick')).toBeVisible();
  await expect(page.getByTestId('knob-decay-ghost')).toBeVisible();
  await expect(page.getByTestId('knob-sustain-tick')).toBeVisible();
  await expect(page.getByTestId('knob-punch-tick')).toHaveCount(0);
  await expect(page.getByTestId('knob-decay-wrap')).toHaveAttribute('data-by', 'agent');
  // the drawn envelope shows the old shape dashed, and the waveform the outline before the change
  await expect(page.getByTestId('env-ghost')).toBeVisible();
  await expect(page.getByTestId('lens-outline')).toBeVisible();
  await expect(page.getByTestId('insp-agent-note')).toContainText('proposed');
  // the inspector: the value, the one before, who set it, the agent's note
  await page.getByTestId('knob-decay').focus();
  await expect(page.getByTestId('inspector')).toContainText('Selected · Decay');
  await expect(page.getByTestId('insp-value')).toHaveText('0.11 s');
  await expect(page.getByTestId('insp-was')).toHaveText('was 0.36 s');
  await expect(page.getByTestId('insp-by')).toContainText('agent');
  await expect(page.getByTestId('insp-note')).toHaveText('shorter, so a run of coins does not blur');
  // hear before: the sound with the old value, then now
  const n = (await played(page)).length;
  await page.getByTestId('hear-before').click();
  await expect.poll(async () => (await played(page)).slice(n).map((p) => p.slot)).toEqual(['A', 'B']);
  // revert: a sound set of the previous value, by the person; the tick goes (the latest change is theirs)
  const before = (await rows(page)).length;
  await page.getByTestId('revert').click();
  await expect.poll(async () => (await rows(page)).length).toBe(before + 1);
  expect((await rows(page))[0]).toMatchObject({ by: 'human:ana', text: 'sound set beep decay=0.4' });
  await expect(page.getByTestId('knob-decay-tick')).toHaveCount(0);
  await expect(page.getByTestId('knob-sustain-tick')).toBeVisible();
  // approve: one mark by the person; everything the agent set is accepted
  await page.getByTestId('insp-approve').click();
  await expect.poll(async () => (await rows(page))[0]!.text).toBe('sound mark beep approved');
  await expect(page.locator('[data-testid$=-tick]')).toHaveCount(0);
  await expect(page.locator('[data-testid$=-ghost]')).toHaveCount(0);
  await expect(page.getByTestId('env-ghost')).toHaveCount(0);
  await expect(page.getByTestId('lens-outline')).toHaveCount(0);
});

test('the inspector hides with ⌥2, R asks for changes with the selected region, and M mutates', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('inspector')).toBeVisible();
  await page.locator('body').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('Alt+2');
  await expect(page.getByTestId('inspector')).toHaveCount(0);
  await page.keyboard.press('Alt+2');
  await expect(page.getByTestId('inspector')).toBeVisible();
  // a region, then R: the composer opens over the region and the request names it
  const box = (await page.getByTestId('lens-surface').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press('r');
  await expect(page.getByTestId('composer-note')).toBeFocused();
  await page.getByTestId('composer-note').fill('the tail is too long here');
  await page.getByTestId('composer-note').press('Meta+Enter');
  await expect(page.getByTestId('composer')).toHaveCount(0);
  const list = await agent.cli(['request', agent.dir]);
  expect(list.out).toMatch(/the tail is too long here.* — pinned to 0\.\d+–0\.\d+ s/);
  // M mutates with the amount and a seed
  await page.locator('body').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('m');
  await expect.poll(async () => (await rows(page))[0]!.text).toMatch(/^sound mutate beep amount=\d(\.\d+)? seed=\d+$/);
});
