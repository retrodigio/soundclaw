// Loudness classes on the sound page: the rule shown, the menu writing `sound set <id> class=<name>` as the person,
// the check badge following the class, and the CLI's measure and normalize agreeing with what the page shows.

import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

const SINE = (id: string, amp: number): string => `sound new ${id} voice=layered seed=1; layer add ${id} osc wave=sine freq=440 dur=0.6; env ${id} 1.amp "0:0 0.01:${amp} 0.5:${amp} 0.6:0@exp"`;

test('the sound page shows the class rule, the menu changes it as a command, and normalize brings the sound to it', async ({ page }) => {
  agent = await startAgent();
  await agent.cli(['run', agent.dir, '-e', SINE('tick', 0.02)]);
  await page.goto(`${agent.url}&name=ana#/sound/tick`);
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
  // no class: the default (standard, -16 LUFS ±1), and the quiet sound fails its loudness check
  await expect(page.getByTestId('loudness-target')).toHaveText('-16.0 LUFS ±1');
  await expect(page.getByTestId('loudness-target')).toHaveAttribute('title', 'class standard');
  const options = await page.getByTestId('loudness-class').locator('option').allTextContents();
  expect(options).toEqual(['default (standard)', 'standard', 'ui', 'foley', 'impact', 'ambience', 'voice', 'music-sting']);
  await page.getByTestId('loudness-class').selectOption('ui');
  await expect(page.getByTestId('loudness-target')).toHaveText('-28.0 LUFS ±3');
  await expect(page.getByTestId('loudness-target')).toHaveAttribute('title', 'class ui');
  // the menu wrote the command, as the person
  await expect.poll(async () => (await agent.cli(['history', agent.dir])).out).toMatch(/human:ana .*sound set tick class=ui/);
  expect((await agent.cli(['check', agent.dir, 'tick'])).out).toMatch(/\(class ui\)/);
  // the page and the CLI measure the same loudness against the same rule
  const json = JSON.parse((await agent.cli(['measure', agent.dir, 'tick', '--json'])).out);
  expect(json.sounds[0].class).toMatchObject({ name: 'ui', target: -28, tolerance: 3 });
  const shown = Number((await page.getByTestId('editor-numbers').textContent())!.match(/(-?\d+\.\d) LUFS/)![1]);
  expect(Math.abs(shown - json.sounds[0].numbers.lufs)).toBeLessThan(0.06);
  // normalize writes the gain; the page follows
  const n = await agent.cli(['normalize', agent.dir, 'tick']);
  expect(n.out).toMatch(/normalized 1 sound/);
  await expect.poll(async () => Number((await page.getByTestId('editor-numbers').textContent())!.match(/(-?\d+\.\d) LUFS/)![1])).toBeCloseTo(-28, 0);
  await page.screenshot({ path: join(import.meta.dirname, '..', '.dev', 'screens', 'class.png') });
  // back to the default through the menu
  await page.getByTestId('loudness-class').selectOption('');
  await expect(page.getByTestId('loudness-target')).toHaveText('-16.0 LUFS ±1');
  await expect.poll(async () => (await agent.cli(['history', agent.dir])).out).toMatch(/sound set tick class=none/);
});

test('a classic sound has the menu too, and the card badge follows the class', async ({ page }) => {
  agent = await startAgent();
  await agent.cli(['run', agent.dir, '-e', 'sound new beep voice=classic preset=pickup seed=3; sound set beep wave=sine volume=0.15']);
  await page.goto(`${agent.url}&name=ana`);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
  const before = await page.getByTestId('check-beep').getAttribute('data-failing');
  await page.getByTestId('edit-beep').click();
  await expect(page.getByTestId('loudness-class')).toBeVisible();
  await page.getByTestId('loudness-class').selectOption('ui');
  await expect(page.getByTestId('loudness-target')).toHaveText('-28.0 LUFS ±3');
  await page.getByTestId('back').click();
  const after = await page.getByTestId('check-beep').getAttribute('data-failing');
  expect(typeof before).toBe('string');
  expect(typeof after).toBe('string');
  expect((after ?? '').includes('loudness')).toBe(((await agent.cli(['check', agent.dir, 'beep'])).out.match(/loudness\s+FAIL/) ?? []).length > 0);
});

test('copy, rename and remove from the command line show on the cards at once, and undo brings them back', async ({ page }) => {
  agent = await startAgent();
  await agent.cli(['run', agent.dir, '-e', 'sound new Click_A voice=classic preset=pickup seed=1']);
  await page.goto(`${agent.url}&name=ana`);
  await expect(page.getByTestId('card-Click_A')).toBeVisible(); // ids keep their case
  await agent.cli(['run', agent.dir, '-e', 'sound copy Click_A Click_B']);
  await expect(page.getByTestId('card-Click_B')).toBeVisible();
  await agent.cli(['run', agent.dir, '-e', 'sound rename Click_B tap']);
  await expect(page.getByTestId('card-tap')).toBeVisible();
  await expect(page.getByTestId('card-Click_B')).toHaveCount(0);
  await agent.cli(['run', agent.dir, '-e', 'sound remove tap']);
  await expect(page.getByTestId('card-tap')).toHaveCount(0);
  await agent.cli(['run', agent.dir, '-e', 'undo']);
  await expect(page.getByTestId('card-tap')).toBeVisible();
  const refused = await agent.cli(['run', agent.dir, '-e', 'sound new click_a']);
  expect(refused.err).toMatch(/exists already as 'Click_A' \(ids are unique ignoring case\)/);
  await page.goto(`${agent.url}&name=ana#/sound/Click_A`);
  await expect(page.getByTestId('editor')).toHaveAttribute('data-sound', 'Click_A');
});
