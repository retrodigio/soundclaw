// The SFX editor in a browser: sliders that write one command per drag as the person, replay,
// undo from the page, A/B, listening feedback reaching await, and exports equal to the CLI's.

import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

const SETUP = 'sound new beep voice=classic preset=pickup seed=3; sound set beep wave=sine volume=0.15';
type Played = { id: string; slot?: string; hash: string };
const played = (page: Page): Promise<Played[]> => page.evaluate(() => (window as unknown as { soundclaw: { played: Played[] } }).soundclaw.played);
const rows = (page: Page) => page.locator('[data-testid=cmd-row]').evaluateAll((rs) => rs.map((r) => ({ by: (r as HTMLElement).dataset.by!, text: r.querySelector('code')!.textContent!, undone: r.classList.contains('undone') })));

/** Drag a slider's thumb from one fraction of its track to another, in small steps. */
async function drag(page: Page, name: string, from: number, to: number): Promise<void> {
  const box = (await page.getByTestId(`slider-${name}`).boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 8 + (box.width - 16) * from, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 8 + (box.width - 16) * to, y, { steps: 25 });
  await page.mouse.up();
}

async function open(page: Page, extra = ''): Promise<void> {
  agent = await startAgent();
  await agent.cli(['run', agent.dir, '-e', SETUP + extra]);
  await page.goto(`${agent.url}&name=ana#/sound/beep`);
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
}

/** The 12 digits `render` prints for the sound now. */
async function cliHash(name = 'beep'): Promise<string> {
  return /hash ([0-9a-f]{12})/.exec((await agent.cli(['render', agent.dir, name])).out)![1]!;
}

test('the editor has all 25 parameters in sfxr\'s groups, each with its value and range, and a card opens it', async ({ page }) => {
  agent = await startAgent();
  await agent.cli(['run', agent.dir, '-e', SETUP]);
  await page.goto(`${agent.url}&name=ana`);
  await page.getByTestId('edit-beep').click();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-sound', 'beep');
  expect(new URL(page.url()).hash).toBe('#/sound/beep');
  const groups = await page.locator('[data-testid^=group-]').evaluateAll((g) => g.map((x) => (x as HTMLElement).dataset.testid));
  expect(groups).toEqual(['wave', 'envelope', 'frequency', 'vibrato', 'change', 'duty', 'repeat', 'phaser', 'filters', 'volume'].map((g) => `group-${g}`));
  await expect(page.locator('[data-testid^=slider-]')).toHaveCount(24); // 25 parameters; the wave has buttons
  for (const w of ['square', 'saw', 'sine', 'noise']) await expect(page.getByTestId(`wave-${w}`)).toBeVisible();
  await expect(page.getByTestId('wave-sine')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('range-freq')).toHaveText('0 … 1');
  await expect(page.getByTestId('range-slide')).toHaveText('-1 … 1');
  await expect(page.getByTestId('range-sustain')).toHaveText('0.01 … 1');
  await expect(page.getByTestId('value-volume')).toHaveText('0.15');
  await expect(page.getByTestId('value-lowPass')).toHaveText('1');
  await page.screenshot({ path: join(import.meta.dirname, '..', '.dev', 'screens', 'editor.png') });
  await page.getByTestId('back').click();
  await expect(page.getByTestId('card-beep')).toBeVisible();
});

test('a drag changes the sound, writes ONE history entry as the person, and replays it', async ({ page }) => {
  await open(page);
  const before = await rows(page);
  const hashBefore = await cliHash();
  const playsBefore = (await played(page)).length;
  await drag(page, 'freq', 0.2, 0.8);
  await expect.poll(async () => (await rows(page)).length).toBe(before.length + 1);
  const entry = (await rows(page))[0]!;
  expect(entry.by).toBe('human:ana');
  expect(entry.text).toMatch(/^sound set beep freq=0\.\d+$/);
  // Settle: no further entry arrives from the same drag (the pause rule must not split it).
  await page.waitForTimeout(1500);
  expect(await rows(page)).toHaveLength(before.length + 1);
  // The sound is what the command says, as the server and the agent see it.
  const value = entry.text.split('=')[1]!;
  await expect(page.getByTestId('value-freq')).toHaveText(value);
  const hashAfter = await cliHash();
  expect(hashAfter).not.toBe(hashBefore);
  expect((await agent.cli(['list', agent.dir])).out).toContain(`freq=${value}`);
  expect((await agent.cli(['history', agent.dir, '--by', 'human:ana'])).out).toContain(`sound set beep freq=${value}`);
  // It replayed at once, with the new samples.
  await expect.poll(async () => (await played(page)).length).toBe(playsBefore + 1);
  const last = (await played(page)).at(-1)!;
  expect(last.hash.slice(0, 12)).toBe(hashAfter);
  // A second drag, on another slider, is a second entry (not one per pixel).
  await drag(page, 'decay', 0.6, 0.1);
  await expect.poll(async () => (await rows(page)).length).toBe(before.length + 2);
  await page.waitForTimeout(1000);
  expect(await rows(page)).toHaveLength(before.length + 2);
  expect((await rows(page))[0]!.text).toMatch(/^sound set beep decay=0\.\d+$/);
  await expect.poll(async () => (await played(page)).length).toBe(playsBefore + 2);
  // What the agent sees: both drags, as the person's, with the numbers and a compare picture.
  const ch = await agent.cli(['changes', agent.dir, '--by', 'human']);
  expect(ch.code, ch.err).toBe(0);
  expect(ch.out).toMatch(/^2 changes by people since #0 \(your cursor is now #4\):/);
  expect(ch.out).toContain(`sound set beep freq=${value}`);
  expect(ch.out).toMatch(/human:ana/);
  expect(ch.out).toMatch(/numbers: duration [\d.]+ → [\d.]+ s; loudness/);
  const png = /compare view \(before above, after below\): (\S+\.png)/.exec(ch.out)![1]!;
  expect(readFileSync(png).subarray(1, 4).toString()).toBe('PNG');
  writeFileSync(join(import.meta.dirname, '..', '.dev', 'screens', 'changes-example.txt'), ch.out);
  expect((await agent.cli(['changes', agent.dir, '--by', 'human'])).out).toMatch(/^no changes by people since #4/);
});

test('undo and redo from the page use the history; double-click returns a parameter to its default', async ({ page }) => {
  await open(page);
  const hash0 = await cliHash();
  await drag(page, 'punch', 0.1, 0.7);
  await expect.poll(async () => (await rows(page))[0]!.text).toMatch(/^sound set beep punch=/);
  const hash1 = await cliHash();
  const n = (await rows(page)).length;
  await page.getByTestId('editor-undo').click();
  await expect.poll(async () => (await rows(page))[0]!.text).toMatch(/^undo group=g\d+$/);
  expect((await rows(page))[0]!.by).toBe('human:ana');
  await expect(page.getByTestId('value-punch')).toHaveText('0.312');
  expect(await cliHash()).toBe(hash0);
  await page.getByTestId('editor-redo').click();
  await expect.poll(async () => (await rows(page))[0]!.text).toMatch(/^redo group=g\d+$/);
  expect(await cliHash()).toBe(hash1);
  expect(await rows(page)).toHaveLength(n + 2);
  // Double-click resets: one command, to the default.
  await page.getByTestId('slider-volume').dblclick();
  await expect.poll(async () => (await rows(page))[0]!.text).toBe('sound set beep volume=0.5');
  await expect(page.getByTestId('value-volume')).toHaveText('0.5');
  await page.waitForTimeout(800);
  expect(await rows(page)).toHaveLength(n + 3);
  // And the reset control does the same for another parameter.
  await expect(page.getByTestId('reset-punch')).toBeEnabled();
  await page.getByTestId('reset-punch').click();
  await expect.poll(async () => (await rows(page))[0]!.text).toBe('sound set beep punch=0');
});

test('buttons write the commands an agent would: wave, generators, random, mutate; the agent sees the same tape', async ({ page }) => {
  await open(page);
  await page.getByTestId('wave-saw').click();
  await expect.poll(async () => (await rows(page))[0]!.text).toBe('sound set beep wave=saw');
  await page.getByTestId('gen-laser').click();
  await expect.poll(async () => (await rows(page))[0]!.text).toMatch(/^sound generate beep laser seed=\d+$/);
  await page.getByTestId('gen-random').click();
  await expect.poll(async () => (await rows(page))[0]!.text).toMatch(/^sound generate beep random seed=\d+$/);
  await page.getByTestId('mutate-amount').fill('0.2');
  await page.getByTestId('mutate').click();
  await expect.poll(async () => (await rows(page))[0]!.text).toMatch(/^sound mutate beep amount=0\.2 seed=\d+$/);
  expect((await rows(page)).slice(0, 4).every((r) => r.by === 'human:ana')).toBe(true);
  // The page and the agent agree on the sound after all of it.
  const shown = await page.getByTestId('editor').locator('.hash').textContent();
  expect(shown).toContain(await cliHash());
  // The history the agent reads has them, authored by the person.
  const h = (await agent.cli(['history', agent.dir, '--by', 'human:ana'])).out;
  expect(h).toMatch(/sound generate beep random seed=\d+/);
  // Seed field: a typed seed is one command, auto goes back.
  await page.getByTestId('seed').fill('77');
  await page.getByTestId('seed').blur();
  await expect.poll(async () => (await rows(page))[0]!.text).toBe('sound set beep seed=77');
  await page.getByTestId('seed-auto').click();
  await expect.poll(async () => (await rows(page))[0]!.text).toBe('sound set beep seed=auto');
});

test('play on change can be turned off; space plays and stops; stop stops', async ({ page }) => {
  await open(page, '; sound set beep sustain=0.9 decay=0.9'); // long enough to still be playing when stopped
  await page.getByTestId('play-on-change').uncheck();
  const n0 = (await played(page)).length;
  await page.getByTestId('wave-square').click();
  await expect.poll(async () => (await rows(page))[0]!.text).toBe('sound set beep wave=square');
  await page.waitForTimeout(400);
  expect(await played(page)).toHaveLength(n0);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Space');
  await expect.poll(async () => (await played(page)).length).toBe(n0 + 1);
  await expect(page.getByTestId('editor-play')).toHaveAttribute('data-playing', 'true');
  expect((await played(page)).at(-1)!.hash.slice(0, 12)).toBe(await cliHash());
  await page.getByTestId('editor-stop').click();
  await expect(page.getByTestId('editor-play')).toHaveAttribute('data-playing', 'false');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('editor-play')).toHaveAttribute('data-playing', 'true');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('editor-play')).toHaveAttribute('data-playing', 'false');
});

test('A/B: pin A, change B, switch playback, and Keep A restores A as one command', async ({ page }) => {
  await open(page);
  const hashA = await cliHash();
  await page.getByTestId('pin-a').click();
  await expect(page.getByTestId('ab-table')).toBeVisible();
  await drag(page, 'slide', 0.5, 0.15);
  await expect.poll(async () => (await rows(page))[0]!.text).toMatch(/^sound set beep slide=-?0\.\d+$/);
  const hashB = await cliHash();
  expect(hashB).not.toBe(hashA);
  await page.getByTestId('play-a').click();
  await expect.poll(async () => (await played(page)).at(-1)!.slot).toBe('A');
  expect((await played(page)).at(-1)!.hash.slice(0, 12)).toBe(hashA);
  await expect(page.getByTestId('play-a')).toHaveAttribute('data-playing', 'true');
  await page.getByTestId('play-b').click();
  await expect.poll(async () => (await played(page)).at(-1)!.slot).toBe('B');
  expect((await played(page)).at(-1)!.hash.slice(0, 12)).toBe(hashB);
  await page.screenshot({ path: join(import.meta.dirname, '..', '.dev', 'screens', 'editor-ab.png'), fullPage: true });
  // Keep A: one command, B is A again.
  const n = (await rows(page)).length;
  await page.getByTestId('keep-a').click();
  await expect.poll(async () => (await rows(page)).length).toBe(n + 1);
  expect((await rows(page))[0]).toMatchObject({ by: 'human:ana', text: 'sound set beep slide=0' });
  expect(await cliHash()).toBe(hashA);
  await expect(page.getByTestId('keep-a')).toBeDisabled();
  // Another sound as A.
  await agent.cli(['run', agent.dir, '-e', 'sound new zap voice=classic preset=laser seed=2']);
  await page.getByTestId('pin-other').selectOption('zap');
  await page.getByTestId('play-a').click();
  await expect.poll(async () => (await played(page)).at(-1)!.slot).toBe('A');
  expect((await played(page)).at(-1)!.hash.slice(0, 12)).toBe(await cliHash('zap'));
  await expect(page.getByTestId('keep-a')).toBeEnabled();
});

test('feedback tags become a request with the tags, shown on the card and delivered through await', async ({ page }) => {
  agent = await startAgent();
  await agent.cli(['run', agent.dir, '-e', SETUP + '; sound new boop voice=classic preset=hit seed=1']);
  await page.goto(`${agent.url}&name=ana`);
  const wait = agent.background(['await', agent.dir, '--timeout', '30']);
  await expect(page.getByTestId('listener-chip')).toHaveAttribute('data-listening', 'true');
  await page.getByTestId('feedback-toggle-beep').click();
  await page.getByTestId('tag-beep-too-loud').click();
  await page.getByTestId('tag-beep-too-harsh').click();
  await page.getByTestId('feedback-text-beep').fill('a bit softer please');
  await page.getByTestId('feedback-send-beep').click();
  const first = await wait.done;
  expect(first.code).toBe(0);
  expect(first.out).toMatch(/request r1 \(beep\) from human:ana at \S+ \[too loud, too harsh\]: "a bit softer please"/);
  await expect(page.getByTestId('request-r1')).toContainText('a bit softer please');
  await expect(page.getByTestId('request-tag-r1')).toHaveText(['too loud', 'too harsh']);
  await expect(page.getByTestId('card-beep')).toHaveAttribute('data-status', 'rejected');
  // "too similar" names the other sound; a tag alone is enough; good is praise.
  const second = agent.background(['await', agent.dir, '--timeout', '30', '--since', /next cursor: (\S+)/.exec(first.out)![1]!]);
  await page.getByTestId('tag-beep-too-similar-to-another-sound').click();
  await page.getByTestId('tag-other-beep').selectOption('boop');
  await page.getByTestId('feedback-send-beep').click();
  const got = await second.done;
  expect(got.out).toMatch(/request r2 \(beep\) from human:ana at \S+ \[too similar to another sound\]: "too similar to boop"/);
  await expect(page.getByTestId('request-other-r2')).toHaveText('like boop');
  await page.getByTestId('feedback-toggle-boop').click();
  await page.getByTestId('tag-boop-good').click();
  await page.getByTestId('feedback-send-boop').click();
  await expect(page.getByTestId('card-boop').getByTestId('request-r3')).toContainText('good');
  await expect(page.getByTestId('card-boop')).toHaveAttribute('data-status', 'draft');
  const list = await agent.cli(['request', agent.dir]);
  expect(list.out).toContain('r3 feedback boop [good]');
  await page.screenshot({ path: join(import.meta.dirname, '..', '.dev', 'screens', 'cards-feedback.png'), fullPage: true });
});

test('the exports download the same bytes the CLI writes: WAV, patch text and a CSV row', async ({ page }) => {
  await open(page, '; sound set beep seed=41 freq=0.52 vibratoDepth=0.3 vibratoSpeed=0.4');
  const out = mkdtempSync(join(tmpdir(), 'soundclaw-export-'));
  try {
    for (const [button, format, file, name] of [['export-wav', 'wav', 'beep.wav', 'beep.wav'], ['export-patch', 'patch', 'beep.sfxr', 'beep.sfxr'], ['export-csv', 'csv', 'synth.csv', 'beep.csv']] as const) {
      const cli = await agent.cli(['export', agent.dir, 'beep', '--format', format, '--out', out]);
      expect(cli.code, cli.err).toBe(0);
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId(button).click()]);
      expect(dl.suggestedFilename()).toBe(name);
      const got = readFileSync((await dl.path())!);
      const want = readFileSync(join(out, file));
      expect(Buffer.compare(got, want), format).toBe(0);
      if (format === 'wav') {
        expect(got.subarray(0, 4).toString()).toBe('RIFF');
        expect(got.length).toBeGreaterThan(1000);
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a page with no name writes as human:owner', async ({ page }) => {
  await open(page);
  await page.goto(agent.url.replace(/&name=\w+/, '') + '#/sound/beep');
  await expect(page.getByTestId('author')).toHaveValue('owner');
  await page.getByTestId('wave-saw').click();
  await expect.poll(async () => (await rows(page))[0]).toMatchObject({ by: 'human:owner', text: 'sound set beep wave=saw' });
});

test('a tone sound has no editor, only a way to make a classic one; a missing sound says so', async ({ page }) => {
  agent = await startAgent();
  await agent.cli(['run', agent.dir, '-e', 'sound new plain']);
  await page.goto(`${agent.url}&name=ana#/sound/plain`);
  await expect(page.getByTestId('editor-tone')).toBeVisible();
  await page.goto(`${agent.url}&name=ana#/sound/nothing`);
  await expect(page.getByTestId('editor-missing')).toBeVisible();
});
