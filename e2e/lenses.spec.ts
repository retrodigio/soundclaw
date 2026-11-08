// The analysis lenses: five views on one time axis (switched with 1–5), a selection and a zoom that
// stay put across lenses, flags that jump to a failing check and loop it, and numbers equal to the
// ones `soundclaw measure --json` prints.

import { expect, type Page } from '@playwright/test';
import { test } from './fixtures.ts';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

const SETUP = 'sound new laser voice=classic preset=laser seed=3; sound set laser sustain=0.2 decay=0.35';
type Played = { id: string; slot?: string; loop?: boolean; region?: [number, number]; hash: string };
const played = (page: Page): Promise<Played[]> => page.evaluate(() => (window as unknown as { soundclaw: { played: Played[] } }).soundclaw.played);

async function openAnalysis(page: Page, setup = SETUP, id = 'laser'): Promise<void> {
  agent = await startAgent();
  const r = await agent.cli(['run', agent.dir, '-e', setup]);
  expect(r.code, r.err).toBe(0);
  await page.goto(`${agent.url}&name=ana#/sound/${id}/analysis`);
  await expect(page.getByTestId('analysis-page')).toBeVisible();
  await expect(page.getByTestId('lens-measuring')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('numbers-strip')).toBeVisible();
}

const sel = async (page: Page) => page.getByTestId('lens-readout').getAttribute('data-sel');

/** Drag across the lens surface between two fractions of its width. */
async function dragAcross(page: Page, from: number, to: number, shift = false): Promise<void> {
  const box = (await page.getByTestId('lens-surface').boundingBox())!;
  const y = box.y + box.height * 0.6;
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(box.x + box.width * from, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to, y, { steps: 12 });
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
}

test('1 to 5 switch the lenses; each draws its own view; the numbers strip stays', async ({ page }) => {
  await openAnalysis(page);
  await expect(page.getByTestId('lens-panel')).toHaveAttribute('data-lens', 'wave');
  await expect(page.getByTestId('lens-wave')).toBeVisible();
  await expect(page.getByTestId('lens-loud-path')).toHaveAttribute('d', /^M/);
  await page.locator('body').click({ position: { x: 4, y: 4 } });
  const want: [string, string, string][] = [['2', 'spec', 'lens-spec'], ['3', 'pitch', 'lens-pitch'], ['4', 'compare', 'lens-compare'], ['5', 'nums', 'lens-nums'], ['1', 'wave', 'lens-wave']];
  for (const [key, lens, shown] of want) {
    await page.keyboard.press(key);
    await expect(page.getByTestId('lens-panel')).toHaveAttribute('data-lens', lens);
    await expect(page.getByTestId(shown)).toBeVisible();
    await expect(page.getByTestId('numbers-strip')).toBeVisible();
    await expect(page.getByTestId('nstrip-truePeakDb')).toBeVisible();
    await expect(page.getByTestId('lens-tab-' + lens)).toHaveAttribute('aria-selected', 'true');
  }
  // a tab click switches too
  await page.getByTestId('lens-tab-pitch').click();
  await expect(page.getByTestId('lens-pitch')).toBeVisible();
  await expect(page.getByTestId('pitch-summary')).toContainText(/falls|rises|holds/);
  await expect(page.getByTestId('lens-pitch-seg').first()).toHaveAttribute('d', /^M/);
  // the spectrogram reads out note, Hz and dB under the pointer
  await page.getByTestId('lens-tab-spec').click();
  await expect(page.getByTestId('lens-spec')).toHaveAttribute('data-bands', '96');
  const box = (await page.getByTestId('lens-surface').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await expect(page.getByTestId('spec-readout')).toHaveText(/^[A-G]#?\d · \d+(\.\d+)? (k?Hz) · [−\d]+ dB · \d\.\d{3} s$/);
  // the page says which command prints the same numbers
  await expect(page.getByTestId('measure-command')).toHaveText(/^soundclaw measure .* laser --json$/);
});

test('the cursor, the selection and the zoom are kept across lenses', async ({ page }) => {
  await openAnalysis(page);
  await dragAcross(page, 0.3, 0.6);
  const picked = (await sel(page))!;
  expect(picked).toMatch(/^0\.\d+,0\.\d+$/);
  const [a, b] = picked.split(',').map(Number) as [number, number];
  expect(b).toBeGreaterThan(a);
  // a click puts the cursor down (the selection stays), a shift-drag extends the selection
  const box = (await page.getByTestId('lens-surface').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.5);
  const cursor = (await page.getByTestId('lens-readout').getAttribute('data-cursor'))!;
  expect(Number(cursor)).toBeGreaterThan(b);
  expect(await sel(page)).toBe(picked);
  await dragAcross(page, 0.65, 0.75, true);
  const [a2, b2] = (await sel(page))!.split(',').map(Number) as [number, number];
  expect(a2).toBeCloseTo(a, 3);
  expect(b2).toBeGreaterThan(b);
  const extended = (await sel(page))!;
  // ⌥-scroll zooms the time axis
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.keyboard.down('Alt');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Alt');
  await expect(page.getByTestId('lens-zoom-reset')).toBeVisible();
  const rulerBefore = await page.getByTestId('lens-ruler').textContent();
  // switch through every lens: the same cursor, selection and zoom
  for (const key of ['2', '3', '4', '1']) {
    await page.keyboard.press(key);
    await expect(page.getByTestId('lens-readout')).toHaveAttribute('data-sel', extended);
    await expect(page.getByTestId('lens-readout')).toHaveAttribute('data-cursor', cursor);
    await expect(page.getByTestId('lens-zoom-reset')).toBeVisible();
    expect(await page.getByTestId('lens-ruler').textContent()).toBe(rulerBefore);
  }
  await expect(page.getByTestId('lens-sel')).toBeVisible();
  await expect(page.getByTestId('lens-cursor')).toBeVisible();
  // ⇧-scroll zooms the level of the waveform only
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Shift');
  await expect(page.locator('.lz-tag')).toContainText('level ×');
  // L loops the selection: the page plays that part, repeating
  const n = (await played(page)).length;
  await page.keyboard.press('l');
  await expect.poll(async () => (await played(page)).length).toBe(n + 1);
  const last = (await played(page)).at(-1)!;
  expect(last.loop).toBe(true);
  expect(last.region![0]).toBeCloseTo(a, 3);
  expect(last.region![1]).toBeGreaterThan(last.region![0]);
});

test('a flag is a marker: a click jumps to it and loops it', async ({ page }) => {
  // a classic preset starts at a high level: the click check flags the first millisecond (and the harsh stretch starts there too, so the two share one marker)
  await openAnalysis(page, 'sound new zap voice=classic preset=pickup seed=3', 'zap');
  const flag = page.getByTestId('flag-click-0');
  /** Open the marker's list when the flag is in one. */
  const reveal = async () => { if (!(await flag.isVisible())) await page.locator('[data-testid^=flag-cluster-]').first().click(); await expect(flag).toBeVisible(); };
  await reveal();
  await expect(flag).toContainText(/click/);
  const from = Number(await flag.getAttribute('data-from'));
  const n = (await played(page)).length;
  await flag.click();
  await expect.poll(async () => (await played(page)).length).toBe(n + 1);
  const last = (await played(page)).at(-1)!;
  expect(last.loop).toBe(true);
  expect(last.region![0]).toBeLessThanOrEqual(from);
  expect(last.region![1]).toBeGreaterThan(from);
  // the cursor went to the flag and the region around it is selected, on whichever lens is showing
  await expect(page.getByTestId('lens-readout')).toHaveAttribute('data-cursor', String(from));
  expect(await sel(page)).toMatch(/^0,0\.0\d+$/);
  await page.keyboard.press('2');
  await expect(page.locator('[data-testid^=flag-]').first()).toBeVisible();
  await expect(page.getByTestId('lens-sel')).toBeVisible();
  // the marker is a button, reachable by keyboard
  await page.keyboard.press('1');
  await page.locator('[data-testid^=flag-cluster-], button.lens-flag').first().focus();
  await page.keyboard.press('Enter');
  await reveal();
  await flag.focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await played(page)).length).toBe(n + 2);
});

test('the numbers equal what `soundclaw measure --json` prints', async ({ page }) => {
  await openAnalysis(page);
  const cli = await agent.cli(['measure', agent.dir, 'laser', '--json']);
  const j = JSON.parse(cli.out) as { sounds: { numbers: Record<string, unknown> & { centroid: { mean: number }; pitch: { start: number | null } } }[] };
  const nums = j.sounds[0]!.numbers;
  await page.keyboard.press('5');
  const cards: [string, number | null][] = [
    ['lufs', nums.lufs as number], ['truePeakDb', nums.truePeakDb as number], ['crestDb', nums.crestDb as number], ['attack', nums.attack as number],
    ['tail', nums.tail as number], ['centroid', nums.centroid.mean], ['pitch', nums.pitch.start], ['dc', nums.dc as number], ['onsets', nums.onsets as number],
  ];
  for (const [key, want] of cards) {
    const got = await page.getByTestId(`num-${key}`).getAttribute('data-value');
    expect(got === 'NaN' ? null : Number(got), key).toBe(want);
  }
  // the strip under every lens shows the same figures in words
  const strip = await page.getByTestId('nstrip-truePeakDb').textContent();
  expect(strip).toContain(String(Math.abs(nums.truePeakDb as number).toFixed(1)));
  await expect(page.getByTestId('nstrip-loudness')).toHaveAttribute('role', 'img');
});

test('Compare: the previous version by default, another sound on request', async ({ page }) => {
  await openAnalysis(page);
  await page.keyboard.press('4');
  // nothing earlier on the tape that changed the sound but its creation: the version before is "none" until a change
  await expect(page.getByTestId('compare-previous')).toBeDisabled();
  await expect(page.getByTestId('compare-none')).toBeVisible();
  await agent.cli(['run', agent.dir, '-e', 'sound set laser decay=0.1']);
  await expect(page.getByTestId('compare-previous')).toBeEnabled();
  await expect(page.getByTestId('compare-summary')).toContainText(/quieter|louder|differs/, { timeout: 15_000 });
  await expect(page.getByTestId('lens-compare-canvas')).toBeVisible();
  await agent.cli(['run', agent.dir, '-e', 'sound new zap voice=classic preset=hit seed=2']);
  await page.getByTestId('compare-other').selectOption('zap');
  await expect(page.getByTestId('compare-summary')).toBeVisible({ timeout: 15_000 });
});
