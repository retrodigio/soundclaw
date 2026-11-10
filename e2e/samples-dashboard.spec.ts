// The dashboard for samples: the Samples tab in its three modes with the numbers query, a row dragged onto a layer list, the sample page and its handles
// (each gesture is one command on the tape), audio dropped on the window, the microphone recorded through Chromium's fake media stream (never a real
// device), the feed and the agent's violet mark, generating again, a licence set from the page, and a 0.1.x project's samples.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { pcmFromFloats } from '../core/src/index.ts';
import { wavBytes } from '../core/test/audio-fixtures.ts';
import { toneFloats } from '../core/test/sample-golden-table.ts';
import { makeBigLibrary } from '../server/test/library-fixtures.ts';
import { makeSamples } from './example.ts';
import { test } from './fixtures.ts';
import { BIN, startAgent, type Agent } from './helpers.ts';

// the microphone is Chromium's fake device (a generated beep), never a real one
test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }, permissions: ['microphone'] });

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

interface Tape { cmd: string; by: string; group: string }
const tape = (): Tape[] => readFileSync(join(agent.dir, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Tape).filter((t) => typeof t.cmd === 'string');
const samplesList = async (): Promise<{ name: string; licence: string; licenceState: string; source: string; frames: number; rate: number }[]> => (await fetch(`http://127.0.0.1:${agent.port}/api/samples?token=${agent.token}`)).json();
const played = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { soundclaw: { played: { id: string }[] } }).soundclaw.played.map((p) => p.id));

async function open(page: Page, hash = ''): Promise<void> {
  await page.goto(`${agent.url}&name=ana${hash}`);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
}
async function start(o: { samples?: boolean } = {}): Promise<void> {
  agent = await startAgent();
  if (o.samples !== false) await makeSamples(agent);
}
/** Press on a handle's grip, move by `dx` pixels in steps and let go. */
async function dragHandle(page: Page, handle: Locator, dx: number): Promise<void> {
  const b = (await handle.boundingBox())!;
  const x = b.x + b.width / 2, y = b.y + Math.min(b.height - 6, 40);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x + (dx * i) / 6, y);
  await page.mouse.up();
}
const waitLens = async (page: Page): Promise<void> => { await expect(page.getByTestId('snum-length')).toBeVisible({ timeout: 30_000 }); };

test('the Samples tab: project rows with numbers, a wave, the licence and where each came from; the numbers query and chips; keys', async ({ page }) => {
  await start();
  await open(page);
  await page.getByTestId('lib-tab-samples').click();
  await expect(page.getByTestId('samples-browser')).toHaveAttribute('data-mode', 'project');
  await expect(page.getByTestId('lib-count')).toHaveText('7 / 7');
  const row = page.getByTestId('lib-row-door_hits');
  await expect(page.getByTestId('sample-numbers-door_hits')).toContainText('2.00 s');
  await expect(page.getByTestId('sample-numbers-door_hits')).toContainText('22.1 kHz');
  await expect(row.locator('svg.mini-wave')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('sample-numbers-door_hits')).toContainText('LUFS');
  await expect(page.getByTestId('sample-licence-door_hits')).toHaveAttribute('data-state', 'attribution');
  await expect(page.getByTestId('sample-licence-field_noise')).toContainText('unknown');
  await expect(page.getByTestId('lib-row-creak_gen_t1')).toContainText('generated');
  await expect(row).toContainText('file');
  // the numbers query: ranges, text, flags; a failing query says why and keeps the list
  const filter = page.getByTestId('lib-filter');
  await filter.fill('dur>1.4');
  await expect(page.getByTestId('lib-count')).toHaveText('3 / 7');
  await expect(page.getByTestId('lib-row-field_noise')).toHaveCount(0);
  await filter.fill('licence=unknown');
  await expect(page.getByTestId('lib-row-field_noise')).toBeVisible();
  await expect(page.getByTestId('lib-row-door_hits')).toHaveCount(0);
  await filter.fill('door');
  await expect(page.getByTestId('lib-count')).toHaveText('1 / 7');
  await filter.fill('dur<');
  await expect(page.getByTestId('samples-filter-error')).toBeVisible();
  await expect(page.getByTestId('lib-count')).toHaveText('7 / 7');
  await filter.fill('');
  await page.getByTestId('chip-sample-loop').click();
  await expect(filter).toHaveValue('loop=yes');
  await expect(page.getByTestId('lib-row-hum_tone')).toBeVisible();
  await expect(page.getByTestId('lib-row-door_hits')).toHaveCount(0);
  await page.getByTestId('chip-sample-loop').click();
  await expect(page.getByTestId('lib-count')).toHaveText('7 / 7');
  // keys: ↓ moves, Space plays, Enter opens
  await page.getByTestId('lib-list').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-sample-row].sel')).toHaveCount(1);
  const sel = await page.locator('[data-sample-row].sel').getAttribute('data-sample-row');
  await page.keyboard.press('Space');
  await expect.poll(async () => (await played(page)).includes(`sample:${sel}`)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#/sample/${sel}$`));
  await expect(page.getByTestId('sample-page')).toHaveAttribute('data-sample', sel!);
});

test('library mode: libraries, a search, 48 files a page, audition without copying, and use as a person', async ({ page }) => {
  await start();
  const big = join(agent.root, 'pack');
  mkdirSync(big, { recursive: true });
  makeBigLibrary(big, 60);
  expect((await agent.cli(['library', 'add', big, 'licence=CC0-1.0'])).code).toBe(0);
  expect((await agent.cli(['library', 'index', 'pack'])).code).toBe(0);
  await open(page);
  await page.getByTestId('lib-tab-samples').click();
  await page.getByTestId('samples-mode-library').click();
  await expect(page.getByTestId('library-hit').first()).toBeVisible({ timeout: 20_000 });
  // two libraries: a picker; the big one pages
  await page.getByTestId('library-pick').selectOption('pack');
  await expect(page.getByTestId('library-range')).toHaveText('1–48 of 60');
  await page.getByTestId('library-next').click();
  await expect(page.getByTestId('library-range')).toHaveText('49–60 of 60');
  await expect(page.getByTestId('library-hit')).toHaveCount(12);
  await page.getByTestId('library-pick').selectOption('cellar-foley');
  await page.getByTestId('lib-filter').fill('door creak dur=1-3');
  await expect(page.getByTestId('library-range')).toContainText('of 2');
  const hit = page.locator('[data-testid=library-hit][data-ref="cellar-foley:doors/creak_01.wav"]');
  await expect(hit).toBeVisible();
  await expect(hit.getByTestId('hit-licence')).toHaveAttribute('data-state', 'shippable');
  // listening copies nothing into the project
  const before = (await samplesList()).length;
  await page.getByTestId('play-hit-cellar-foley:doors/creak_01.wav').click();
  await expect.poll(async () => (await played(page)).includes('library:cellar-foley:doors/creak_01.wav'), { timeout: 15_000 }).toBe(true);
  expect((await samplesList()).length).toBe(before);
  // Use: a person's `sample add` with the library's licence and where it came from
  await page.getByTestId('use-hit-cellar-foley:doors/creak_01.wav').click();
  await expect(page).toHaveURL(/#\/sample\/creak_01$/);
  const add = tape().find((t) => t.cmd.startsWith('sample add creak_01 '))!;
  expect(add.by).toBe('human:ana');
  expect(add.cmd).toContain('source=library');
  expect(add.cmd).toContain('origin=cellar-foley:doors/creak_01.wav');
  expect(add.cmd).toContain('licence=CC0-1.0');
  await expect(page.getByTestId('prov-origin')).toContainText('cellar-foley:doors/creak_01.wav');
});

test('takes: keep one with a name and a confirmed licence, discard another', async ({ page }) => {
  await start();
  await open(page);
  await page.getByTestId('lib-tab-samples').click();
  await page.getByTestId('samples-mode-takes').click();
  await expect(page.getByTestId('lib-count')).toHaveText('3 takes');
  await expect(page.getByTestId('take-creak_gen_t1')).toContainText('slow creak');
  await page.getByTestId('keep-creak_gen_t1').click();
  const form = page.getByTestId('keep-form-creak_gen_t1');
  await expect(form.getByTestId('keep-go')).toBeDisabled();
  await form.getByTestId('keep-name').fill('door_creak');
  await form.getByTestId('keep-licence').selectOption('own');
  await form.getByTestId('keep-confirm').check();
  await form.getByTestId('keep-go').click();
  await expect(page.getByTestId('lib-count')).toHaveText('2 takes');
  const cmds = tape().map((t) => t.cmd);
  expect(cmds.some((c) => c === 'sample rename creak_gen_t1 door_creak')).toBe(true);
  const set = tape().filter((t) => t.cmd.startsWith('sample set door_creak ')).at(-1)!;
  expect(set.by).toBe('human:ana');
  expect(set.cmd).toContain('licence=own');
  expect(set.cmd).toMatch(/tags=\S*kept/);
  await page.getByTestId('discard-creak_gen_t2').click();
  await expect(page.getByTestId('lib-count')).toHaveText('1 take');
  expect(tape().some((t) => t.cmd === 'sample remove creak_gen_t2' && t.by === 'human:ana')).toBe(true);
  // the kept one is an ordinary sample now
  await page.getByTestId('samples-mode-project').click();
  await expect(page.getByTestId('lib-row-door_creak')).toBeVisible();
});

test('a sample row dragged onto a layer list adds a sample layer, as the person', async ({ page }) => {
  await start();
  expect((await agent.cli(['run', agent.dir, '-e', 'sound new knock voice=layered seed=3\nlayer add knock osc wave=sine freq=120 dur=0.2', '--by', 'agent:claude'])).code).toBe(0);
  await open(page, '#/sound/knock');
  await page.getByTestId('lib-tab-samples').click();
  await expect(page.getByTestId('layer-strips')).toBeVisible();
  const before = tape().length;
  await page.getByTestId('lib-row-door_hits').dragTo(page.getByTestId('layers'));
  await expect.poll(() => tape().length).toBe(before + 1);
  const last = tape().at(-1)!;
  expect(last.cmd).toMatch(/^layer add knock sample sample=door_hits/);
  expect(last.by).toBe('human:ana');
  await expect(page.getByTestId('layer-strips').locator('[data-testid^=layer-]').first()).toBeVisible();
  // the sample's control links to its page, trimming this layer
  await expect(page.getByTestId('layer-sample-2')).toHaveAttribute('href', '#/sample/door_hits/layer/knock/2');
});

test('the sample page: lenses, numbers, words, checks, provenance and where it is used', async ({ page }) => {
  await start();
  expect((await agent.cli(['run', agent.dir, '-e', 'sound new knock voice=layered seed=3\nlayer add knock sample sample=hum_soft', '--by', 'agent:claude'])).code).toBe(0);
  await open(page, '#/sample/hum_tone');
  await waitLens(page);
  await expect(page.getByTestId('sample-title')).toHaveText('hum_tone');
  await expect(page.getByTestId('sample-page-licence')).toHaveAttribute('data-state', 'shippable');
  await expect(page.getByTestId('snum-length')).toContainText('1.500 s');
  // the strip under the lens is always there, whatever the lens
  await expect(page.getByTestId('sstrip-loudness')).toContainText('LUFS');
  await expect(page.getByTestId('sstrip-pitch')).not.toContainText('none');
  await expect(page.getByTestId('snum-pitch')).not.toContainText('none');
  await expect(page.getByTestId('sample-words')).toContainText('1.50 s');
  await expect(page.getByTestId('scheck-clipping')).toBeVisible();
  // the five lenses on one time axis
  for (const [k, id] of [['1', 'wave'], ['2', 'spec'], ['3', 'pitch'], ['4', 'loop'], ['5', 'compare']] as const) {
    await page.getByTestId(`lens-tab-${id}`).click();
    await expect(page.getByTestId('lens-panel')).toHaveAttribute('data-lens', id);
    void k;
  }
  await page.getByTestId('lens-tab-loop').click();
  await expect(page.getByTestId('seam-numbers')).toContainText('click');
  await page.getByTestId('lens-tab-compare').click();
  await page.getByTestId('compare-other').selectOption('sample:door_hits');
  await expect(page.getByTestId('compare-summary')).toBeVisible({ timeout: 30_000 });
  // provenance and use
  await expect(page.getByTestId('prov-source')).toContainText('file');
  await expect(page.getByTestId('prov-origin')).toContainText('hum_tone.wav');
  await expect(page.getByTestId('prov-added')).toContainText('agent:claude');
  await expect(page.getByTestId('used-sample-hum_soft')).toBeVisible();
  await expect(page.getByTestId('used-sound-knock')).toBeVisible();
  await page.goto(`${agent.url}&name=ana#/sample/hum_soft`);
  await expect(page.getByTestId('prov-parents')).toContainText('hum_tone');
  await expect(page.getByTestId('prov-ops')).toContainText('fade');
  // a name the project does not have
  await page.goto(`${agent.url}&name=ana#/sample/nothing`);
  await expect(page.getByTestId('sample-missing')).toBeVisible();
});

test('handles: each gesture writes one command; trim from a layer writes its start and end', async ({ page }) => {
  await start();
  expect((await agent.cli(['run', agent.dir, '-e', 'sound new knock voice=layered seed=3\nlayer add knock osc wave=sine freq=120 dur=0.2\nlayer add knock sample sample=door_hits', '--by', 'agent:claude'])).code).toBe(0);
  // trim, opened from the layer: the layer's start and end
  await open(page, '#/sample/door_hits/layer/knock/2');
  await waitLens(page);
  await expect(page.getByTestId('sample-from-layer')).toContainText('knock layer 2');
  await expect(page.getByTestId('tool-trim')).toHaveAttribute('aria-checked', 'true');
  let n = tape().length;
  await dragHandle(page, page.getByTestId('trim-end'), -160);
  await expect.poll(() => tape().length).toBe(n + 1);
  const trim = tape().at(-1)!;
  expect(trim.by).toBe('human:ana');
  expect(trim.cmd).toMatch(/^layer set knock 2 start=0 end=1\.\d+$/);
  // keyboard: the focused handle moves with the arrows, Enter writes
  n = tape().length;
  await page.getByTestId('trim-start').focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight');
  expect(tape().length).toBe(n);
  await page.keyboard.press('Enter');
  await expect.poll(() => tape().length).toBe(n + 1);
  expect(tape().at(-1)!.cmd).toMatch(/^layer set knock 2 start=0\.0\d+ end=1\.\d+$/);

  // loop points
  await page.goto('about:blank');
  await open(page, '#/sample/hum_tone');
  await waitLens(page);
  await page.getByTestId('tool-loop').click();
  await expect(page.getByTestId('loop-info')).toContainText('loop 8820\u201352920 frames');
  n = tape().length;
  await dragHandle(page, page.getByTestId('loop-end'), -120);
  await expect.poll(() => tape().length).toBe(n + 1);
  const loop = tape().at(-1)!;
  expect(loop.cmd).toMatch(/^sample set hum_tone loop=8820-\d+ loopmode=sustain$/);
  expect(loop.by).toBe('human:ana');
  await expect(page.getByTestId('loop-info')).not.toContainText('52920');
  await page.getByTestId('lens-tab-loop').click();
  await expect(page.getByTestId('seam-numbers')).toBeVisible();
  n = tape().length;
  await page.getByTestId('loop-find').click();
  await expect.poll(() => tape().length).toBe(n + 1);
  expect(tape().at(-1)!.cmd).toMatch(/^sample set hum_tone loop=\d+-\d+ loopmode=sustain$/);

  // slices: move, add, remove, find
  await page.goto('about:blank');
  await open(page, '#/sample/door_hits');
  await waitLens(page);
  await page.getByTestId('tool-slice').click();
  await page.getByTestId('lens-tab-wave').click();
  const points = (cmd: string): number[] => /slices=([\d,]+)/.exec(cmd)![1]!.split(',').map(Number);
  const startPts = points(tape().filter((t) => t.cmd.startsWith('sample set door_hits slices=')).at(-1)!.cmd);
  expect(startPts).toHaveLength(4);
  n = tape().length;
  await dragHandle(page, page.getByTestId('slice-handle-2'), 40);
  await expect.poll(() => tape().length).toBe(n + 1);
  const moved = points(tape().at(-1)!.cmd);
  expect(moved).toHaveLength(4);
  expect(moved[1]).toBeGreaterThan(startPts[1]!);
  expect(moved[0]).toBe(0);
  n = tape().length;
  const surface = (await page.getByTestId('lens-surface').boundingBox())!;
  await page.mouse.click(surface.x + surface.width * 0.9, surface.y + surface.height * 0.8);
  await expect.poll(() => tape().length).toBe(n + 1);
  expect(points(tape().at(-1)!.cmd)).toHaveLength(5);
  n = tape().length;
  await page.getByTestId('slice-handle-5').focus();
  await page.keyboard.press('Delete');
  await expect.poll(() => tape().length).toBe(n + 1);
  expect(points(tape().at(-1)!.cmd)).toHaveLength(4);
  n = tape().length;
  await page.getByTestId('slice-onsets').click();
  await expect.poll(() => tape().length).toBe(n + 1);
  expect(tape().at(-1)!.cmd).toMatch(/^sample set door_hits slices=0/);

  // trim to a new sample: one derive when the person says so, the original untouched
  await page.goto('about:blank');
  await open(page, '#/sample/hum_tone');
  await waitLens(page);
  await page.getByTestId('tool-trim').click();
  await expect(page.getByTestId('trim-make')).toBeDisabled();
  n = tape().length;
  await expect(page.getByTestId('trim-saved-note')).toBeVisible();
  await expect(page.getByTestId('trim-reset')).toBeDisabled();
  await dragHandle(page, page.getByTestId('trim-start'), 120);
  expect(tape().length).toBe(n);
  // a drag is a draft: the page says it is unsaved (in the toolbar and in the header) until Make, and Reset takes it back
  await expect(page.getByTestId('trim-unsaved')).toContainText('unsaved trim');
  await expect(page.getByTestId('sample-unsaved-trim')).toBeVisible();
  await page.getByTestId('trim-reset').click();
  await expect(page.getByTestId('trim-unsaved')).toHaveCount(0);
  await expect(page.getByTestId('sample-unsaved-trim')).toHaveCount(0);
  expect(tape().length).toBe(n);
  await page.getByTestId('trim-start').scrollIntoViewIfNeeded(); // pressing Reset scrolled the lens out of view
  await dragHandle(page, page.getByTestId('trim-start'), 120);
  await expect(page.getByTestId('trim-unsaved')).toBeVisible();
  await page.getByTestId('trim-name').fill('hum_short');
  await page.getByTestId('trim-make').click();
  await expect(page).toHaveURL(/#\/sample\/hum_short$/);
  const derived = tape().filter((t) => t.cmd.startsWith('sample add hum_short '));
  expect(derived).toHaveLength(1);
  expect(derived[0]!.by).toBe('human:ana');
  expect(derived[0]!.cmd).toContain('source=derived');
  expect(derived[0]!.cmd).toMatch(/ops="trim \d+f \d+f"/);
});

test('audio dropped on the window is imported as the person, under the licence they choose', async ({ page }) => {
  await start({ samples: false });
  await open(page);
  const knock = wavBytes(pcmFromFloats([toneFloats(44100, 0.4)], 44100, 'pcm16'));
  const b64 = Buffer.from(knock).toString('base64');
  const drop = (name: string, extra = false) => page.evaluate(async ([data, fname, withText]) => {
    const bytes = Uint8Array.from(atob(data!), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], fname!, { type: 'audio/wav' }));
    if (withText === 'yes') dt.items.add(new File(['notes'], 'readme.txt', { type: 'text/plain' }));
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    (window as unknown as { __dt: DataTransfer }).__dt = dt;
  }, [b64, name, extra ? 'yes' : 'no']);
  await drop('Wooden Knock.wav', true);
  await expect(page.getByTestId('drop-veil')).toBeVisible();
  await page.evaluate(() => { const dt = (window as unknown as { __dt: DataTransfer }).__dt; window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); });
  const dlg = page.getByTestId('import-dialog');
  await expect(dlg).toBeVisible();
  await expect(page.getByTestId('drop-veil')).toHaveCount(0);
  await expect(dlg.getByTestId('import-licence')).toHaveValue('unknown');
  await expect(dlg.getByTestId('import-skipped')).toContainText('1 file is not');
  await expect(dlg.getByTestId('import-name')).toHaveValue('wooden_knock');
  await dlg.getByTestId('import-licence').selectOption('CC-BY-4.0');
  await dlg.getByTestId('import-attribution').fill('Made by a friend');
  await dlg.getByTestId('import-tags').fill('knock, wood');
  await dlg.getByTestId('import-go').click();
  await expect(page).toHaveURL(/#\/sample\/wooden_knock$/);
  const add = tape().find((t) => t.cmd.startsWith('sample add wooden_knock '))!;
  expect(add.by).toBe('human:ana');
  expect(add.cmd).toContain('licence=CC-BY-4.0');
  expect(add.cmd).toContain('tags=knock,wood');
  expect(add.cmd).toContain('origin="Wooden Knock.wav"');
  const list = await samplesList();
  expect(list.find((x) => x.name === 'wooden_knock')).toMatchObject({ licence: 'CC-BY-4.0', licenceState: 'attribution' });
  // the file chooser reaches the same dialog from the palette
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('open-palette').click();
  await page.keyboard.type('import audio');
  await page.keyboard.press('Enter');
  const fc = await chooser;
  await fc.setFiles({ name: 'second.wav', mimeType: 'audio/wav', buffer: Buffer.from(knock) });
  await expect(page.getByTestId('import-dialog')).toBeVisible();
  await expect(page.getByTestId('import-licence')).toHaveValue('unknown');
  await page.getByTestId('import-go').click();
  await expect(page).toHaveURL(/#\/sample\/second$/);
  expect((await samplesList()).find((x) => x.name === 'second')!.licence).toBe('unknown');
});

test('the meter moves, a take is recorded with a count-in, and saved as a sample only once its licence is confirmed', async ({ page }) => {
  await start({ samples: false });
  await open(page);
  await page.getByTestId('transport-record').click();
  const dlg = page.getByTestId('record-dialog');
  await expect(dlg.getByTestId('record-status')).toHaveAttribute('data-phase', 'ready', { timeout: 20_000 });
  await expect.poll(async () => Number(await dlg.getByTestId('record-meter').getAttribute('data-db')), { timeout: 15_000 }).toBeGreaterThan(-70);
  await dlg.getByTestId('record-countin').selectOption('1');
  await dlg.getByTestId('record-start').click();
  await expect(dlg.getByTestId('record-status')).toHaveAttribute('data-phase', 'recording', { timeout: 10_000 });
  await page.waitForTimeout(1500);
  await dlg.getByTestId('record-stop').click();
  await expect(dlg.getByTestId('record-status')).toHaveAttribute('data-phase', 'done');
  const said = (await dlg.getByTestId('record-status').textContent())!;
  const rate = Number(/at (\d+) Hz/.exec(said)![1]);
  expect(rate).toBeGreaterThanOrEqual(8000);
  await dlg.getByTestId('record-name').fill('mic_test');
  await expect(dlg.getByTestId('record-save')).toBeDisabled();
  await dlg.getByTestId('record-own').check();
  await dlg.getByTestId('record-save').click();
  await expect(page).toHaveURL(/#\/sample\/mic_test$/);
  const add = tape().find((t) => t.cmd.startsWith('sample add mic_test '))!;
  expect(add.by).toBe('human:ana');
  expect(add.cmd).toContain('source=recorded');
  expect(add.cmd).toContain('licence=own');
  expect(add.cmd).toContain(`rate=${rate}`);
  expect(add.cmd).toContain('origin=microphone');
  const made = (await samplesList()).find((x) => x.name === 'mic_test')!;
  expect(made.frames / made.rate).toBeGreaterThan(1.2);
  expect(made.rate).toBe(rate);
});

test('the agent\'s new samples carry the violet mark in the list and the feed until they are played; the feed says what came in', async ({ page }) => {
  await start();
  await open(page);
  await page.getByTestId('lib-tab-samples').click();
  await expect(page.getByTestId('lib-count')).toHaveText('7 / 7');
  // what was there when the page opened is not news
  await expect(page.locator('[data-sample-row][data-new=true]')).toHaveCount(0);
  const f = join(agent.root, 'audio', 'agent_hit.wav');
  writeFileSync(f, wavBytes(pcmFromFloats([toneFloats(44100, 0.3)], 44100, 'pcm16')));
  expect((await agent.cli(['sample', 'import', agent.dir, f, 'licence=own'])).code).toBe(0);
  await expect(page.getByTestId('sample-new-agent_hit')).toBeVisible();
  await expect(page.getByTestId('chip-sample-new')).toContainText('1');
  const item = page.locator('[data-testid=feed-item][data-sample=agent_hit]');
  await expect(item).toHaveAttribute('data-new', 'true');
  await expect(item).toContainText('Imported agent_hit from agent_hit.wav (0.30 s)');
  expect((await agent.cli(['generate', agent.dir, 'sfx', 'a small brass bell, struck once', 'provider=fake', 'takes=1', 'duration=1', 'as=bell_gen'])).code).toBe(0);
  const gen = page.locator('[data-testid=feed-item][data-sample=bell_gen_t1]');
  await expect(gen).toContainText('Generated bell_gen_t1');
  await expect(gen).toContainText('a small brass bell, struck once');
  await expect(gen).toContainText('take 1/1');
  expect((await agent.cli(['run', agent.dir, '-e', 'sample derive agent_soft from=agent_hit op="gain -6"', '--by', 'agent:claude'])).code).toBe(0);
  await expect(page.locator('[data-testid=feed-item][data-sample=agent_soft]')).toContainText('Derived agent_soft (gain -6');
  // playing it clears its mark everywhere
  await page.getByTestId('play-sample-agent_hit').click();
  await expect(page.getByTestId('sample-new-agent_hit')).toHaveCount(0);
  await expect(item).not.toHaveAttribute('data-new', 'true');
  // a person's own import is not news to them
  expect(tape().filter((t) => t.cmd.startsWith('sample add agent_hit '))[0]!.by).toBe('agent:claude');
});

test('a generated sample shows its prompt, the provider and the take; generate again shows the estimate first; the licence is set from the page', async ({ page }) => {
  await start();
  await open(page, '#/sample/creak_gen_t1');
  await waitLens(page);
  await expect(page.getByTestId('prov-prompt')).toContainText('slow creak of an old wooden door hinge');
  await expect(page.getByTestId('prov-provider')).toContainText('fake');
  await expect(page.getByTestId('prov-take')).toContainText('1/3');
  await expect(page.getByTestId('prov-request')).toBeVisible();
  const before = (await samplesList()).length;
  await page.getByTestId('sample-again').click();
  await expect(page.getByTestId('again-estimate')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('again-go')).toBeEnabled();
  await page.getByTestId('again-go').click();
  await expect.poll(async () => (await samplesList()).length, { timeout: 30_000 }).toBeGreaterThan(before);
  const ledger = readFileSync(join(agent.dir, 'generation.jsonl'), 'utf8').trim().split('\n');
  expect(ledger.length).toBeGreaterThanOrEqual(2);
  // the licence, from the page
  await page.getByTestId('licence-edit').click();
  await page.getByTestId('licence-select').selectOption('own');
  await page.getByTestId('licence-save').click();
  await expect(page.getByTestId('sample-licence-state')).toHaveAttribute('data-state', 'shippable');
  const set = tape().at(-1)!;
  expect(set.cmd).toBe('sample set creak_gen_t1 licence=own');
  expect(set.by).toBe('human:ana');
  // derive and make an instrument from the page
  await page.getByTestId('sample-derive').click();
  await page.getByTestId('derive-name').fill('creak_clean');
  await page.getByTestId('derive-go').click();
  await expect(page).toHaveURL(/#\/sample\/creak_clean$/);
  await page.getByTestId('sample-instrument').click();
  await page.getByTestId('instrument-id').fill('creak_kit');
  await page.getByTestId('instrument-go').click();
  // a sound with no steady pitch says so, and a root note given in the dialog is set first
  await expect(page.getByTestId('instrument-dialog').getByRole('alert')).toContainText('steady pitch');
  await page.getByTestId('instrument-root').fill('C4');
  await page.getByTestId('instrument-go').click();
  await expect.poll(() => tape().some((t) => t.cmd.startsWith('instrument new creak_kit ') && t.by === 'human:ana')).toBe(true);
  expect(tape().some((t) => t.cmd === 'sample set creak_clean root=C4' && t.by === 'human:ana')).toBe(true);
  expect(tape().some((t) => t.cmd.startsWith('instrument zone add creak_kit sample=creak_clean ') && t.by === 'human:ana')).toBe(true);
});

test('a 0.1 project\'s samples (WAV files in the samples folder) list, open on the sample page and play', async ({ page }) => {
  agent = await startAgent({
    build: (dir) => {
      execFileSync(process.execPath, [BIN, 'new', dir]);
      mkdirSync(join(dir, 'samples'), { recursive: true });
      writeFileSync(join(dir, 'samples', 'old_tone.wav'), wavBytes(pcmFromFloats([toneFloats(44100, 0.8)], 44100, 'pcm16')));
    },
  });
  await open(page);
  await page.getByTestId('lib-tab-samples').click();
  await expect(page.getByTestId('lib-row-old_tone')).toBeVisible();
  await expect(page.getByTestId('sample-numbers-old_tone')).toContainText('0.80 s');
  await expect(page.getByTestId('lib-row-old_tone').locator('svg.mini-wave')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('lib-row-old_tone').dblclick();
  await waitLens(page);
  await expect(page.getByTestId('snum-length')).toContainText('0.800 s');
  await page.getByTestId('sample-play').click();
  await expect.poll(async () => (await played(page)).includes('sample:old_tone')).toBe(true);
});

