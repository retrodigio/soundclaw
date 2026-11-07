// The set, loop and audition features in a browser: the audition page driven by the keyboard (an
// approval reaching the tape, feedback reaching a waiting agent, play-all with gaps, filters), a set's
// page (members, play in sequence, regen with a new seed, the spread numbers), and the loop controls.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

const SHOTS = join(import.meta.dirname, '..', '.dev', 'screens');
type Played = { id: string; slot?: string; loop?: boolean; hash: string; samples: number };
const played = (page: Page): Promise<Played[]> => page.evaluate(() => (window as unknown as { soundclaw: { played: Played[] } }).soundclaw.played);
const rows = (page: Page) => page.locator('[data-testid=cmd-row]').evaluateAll((rs) => rs.map((r) => ({ by: (r as HTMLElement).dataset.by!, text: r.querySelector('code')!.textContent!, undone: r.classList.contains('undone') })));
const texts = async (page: Page): Promise<string[]> => (await rows(page)).map((r) => r.text);
const shot = async (page: Page, name: string): Promise<void> => { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, name), fullPage: true }); };

async function open(page: Page, setup: string, hash: string): Promise<void> {
  agent = await startAgent();
  const r = await agent.cli(['run', agent.dir, '-e', setup]);
  expect(r.code, r.err).toBe(0);
  await page.goto(`${agent.url}&name=ana${hash}`);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
}

const FOUR = 'sound new a voice=classic preset=pickup seed=1; sound new b voice=classic preset=laser seed=2; sound new c voice=classic preset=blip seed=3; sound new d voice=classic preset=hit seed=4';

test('the audition page: every sound as a card, the keyboard moves, plays, approves and asks for changes', async ({ page }) => {
  await open(page, FOUR, '#/audition');
  await expect(page.getByTestId('audition')).toHaveAttribute('data-count', '4');
  for (const id of ['a', 'b', 'c', 'd']) await expect(page.getByTestId(`aud-${id}`)).toBeVisible();
  // the first card is selected; arrows move
  await expect(page.getByTestId('aud-a')).toHaveAttribute('data-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('aud-b')).toHaveAttribute('data-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('aud-b')).toHaveAttribute('data-selected', 'true');
  // space plays the selected sound
  await page.keyboard.press('Space');
  await expect.poll(async () => (await played(page)).map((p) => p.id)).toEqual(['b']);
  // a approves: the mark reaches the tape, written by the person
  await page.keyboard.press('a');
  await expect(page.getByTestId('aud-status-b')).toHaveText('approved');
  await expect.poll(() => texts(page)).toContain('sound mark b approved');
  expect((await rows(page)).find((r) => r.text === 'sound mark b approved')!.by).toBe('human:ana');
  // r asks for changes: the note box takes focus; typing does not trigger the shortcuts
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('r');
  const note = page.getByTestId('aud-ask-text-c');
  await expect(note).toBeFocused();
  const waiting = agent.background(['await', agent.dir, '--timeout', '60']);
  await expect(page.getByTestId('listener-chip')).toHaveAttribute('data-listening', 'true');
  await note.fill('an arpeggio, a bit softer: a');
  await page.getByTestId('aud-ask-send-c').click();
  const done = await waiting.done;
  expect(done.code).toBe(0);
  expect(done.out).toContain('request r1 (c) from human:ana');
  expect(done.out).toContain('an arpeggio, a bit softer: a');
  await expect(page.getByTestId('aud-status-c')).toHaveText('rejected');
  expect((await played(page)).map((p) => p.id)).toEqual(['b']); // the "a" typed in the note approved nothing and played nothing
  expect(await texts(page)).not.toContain('sound mark c approved');
  await shot(page, 'audition.png');
});

test('the audition page: feedback tags reach a waiting agent, and the filters narrow the page', async ({ page }) => {
  await open(page, FOUR, '#/audition');
  const waiting = agent.background(['await', agent.dir, '--timeout', '60']);
  await expect(page.getByTestId('listener-chip')).toHaveAttribute('data-listening', 'true');
  await page.getByTestId('aud-feedback-toggle-d').click();
  await page.getByTestId('tag-d-too-harsh').click();
  await page.getByTestId('feedback-send-d').click();
  const done = await waiting.done;
  expect(done.out).toMatch(/request r1 \(d\) from human:ana/);
  expect(done.out).toContain('too harsh');
  // approve two with the keyboard, then filter by status
  await page.getByTestId('aud-a').click();
  await page.keyboard.press('a');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('a');
  await page.getByTestId('aud-filter-status').selectOption('approved');
  await expect(page.getByTestId('audition')).toHaveAttribute('data-count', '2');
  await expect(page.getByTestId('aud-c')).toHaveCount(0);
  await page.getByTestId('aud-filter-status').selectOption('rejected');
  await expect(page.getByTestId('audition')).toHaveAttribute('data-count', '1'); // d: the tags marked it
  await expect(page.getByTestId('aud-d')).toBeVisible();
  await page.getByTestId('aud-filter-status').selectOption('any');
  // by tag
  await page.getByTestId('aud-filter-tag').selectOption('too harsh');
  await expect(page.getByTestId('audition')).toHaveAttribute('data-count', '1');
  await page.getByTestId('aud-filter-tag').selectOption('');
  // by checks: the laser, blip and hit fail some; the filter counts agree with the badges
  const pass = await page.locator('[data-testid^=aud-check-]').evaluateAll((els) => els.filter((e) => (e as HTMLElement).dataset.pass === 'true').length);
  await page.getByTestId('aud-filter-check').selectOption('pass');
  await expect(page.getByTestId('audition')).toHaveAttribute('data-count', String(pass));
  await page.getByTestId('aud-filter-check').selectOption('fail');
  await expect(page.getByTestId('audition')).toHaveAttribute('data-count', String(4 - pass));
});

test('the audition page: play all goes through the filtered sounds in order with gaps, and stops', async ({ page }) => {
  await open(page, FOUR, '#/audition');
  await page.getByTestId('aud-gap').fill('30');
  await page.getByTestId('aud-play-all').click();
  await expect.poll(async () => (await played(page)).map((p) => p.id), { timeout: 15000 }).toEqual(['a', 'b', 'c', 'd']);
  await expect(page.getByTestId('aud-play-all')).toHaveAttribute('data-playing', 'false', { timeout: 15000 });
  // stop in the middle
  await page.getByTestId('aud-filter-status').selectOption('draft');
  await page.getByTestId('aud-gap').fill('5000');
  const before = (await played(page)).length;
  await page.getByTestId('aud-play-all').click();
  await expect(page.getByTestId('aud-play-all')).toHaveAttribute('data-playing', 'true');
  await expect.poll(async () => (await played(page)).length).toBe(before + 1);
  await page.getByTestId('aud-play-all').click(); // Stop
  await expect(page.getByTestId('aud-play-all')).toHaveAttribute('data-playing', 'false');
  await page.waitForTimeout(300);
  expect((await played(page)).length).toBe(before + 1);
});

const FEET = 'sound new step voice=layered preset=footstep seed=11; set new footsteps from=step count=6 class=foley spread="1.freq±12% 2.cutoff±20% *.gain±20%" seed=2';

test('a set\'s page: the members in a row, play in sequence, regen with a new seed, the spread numbers', async ({ page }) => {
  await open(page, FEET, '#/');
  // the home page lists the set
  await expect(page.getByTestId('set-tile-footsteps')).toBeVisible();
  await page.getByTestId('set-open-footsteps').click();
  await expect(page.getByTestId('set-page')).toHaveAttribute('data-set', 'footsteps');
  await expect(page.getByTestId('members').locator('[data-testid^=member-footsteps_]')).toHaveCount(6);
  await expect(page.getByTestId('set-info')).toContainText('6 members from step');
  await expect(page.getByTestId('set-info')).toContainText('class foley');
  await expect(page.getByTestId('spread-rules')).toContainText('1.freq±12% 2.cutoff±20% *.gain±20%');
  // the spread numbers: the distance matrix and the verdict agree with the CLI's check
  await expect(page.getByTestId('set-check')).toHaveAttribute('data-pass', 'true');
  const cli = await agent.cli(['check', agent.dir, 'footsteps']);
  expect(cli.code).toBe(0);
  const closest = /closest (\S+) ([\d.]+) dB/.exec(cli.out)!;
  await expect(page.getByTestId('set-verdict')).toContainText(`closest ${closest[1]} ${closest[2]} dB`);
  const cells = await page.locator('[data-testid^=dist-]').evaluateAll((els) => els.map((e) => ({ id: (e as HTMLElement).dataset.testid!, text: e.textContent!, bad: (e as HTMLElement).dataset.bad })));
  expect(cells).toHaveLength(36);
  expect(cells.filter((c) => c.text === '–')).toHaveLength(6);
  expect(cells.every((c) => c.bad === 'false')).toBe(true);
  expect(cells.find((c) => c.id === 'dist-1-2')!.text).toBe(cells.find((c) => c.id === 'dist-2-1')!.text);
  // each member plays; the sequence plays all six in order
  await page.getByTestId('member-play-footsteps_3').click();
  await expect.poll(async () => (await played(page)).map((p) => p.id)).toEqual(['footsteps_3']);
  await page.getByTestId('set-gap').fill('20');
  await page.getByTestId('set-play-all').click();
  await expect.poll(async () => (await played(page)).map((p) => p.id).slice(1), { timeout: 15000 }).toEqual(['footsteps_1', 'footsteps_2', 'footsteps_3', 'footsteps_4', 'footsteps_5', 'footsteps_6']);
  await expect(page.getByTestId('set-play-all')).toHaveAttribute('data-playing', 'false', { timeout: 15000 });
  // what plays is what the agent renders
  const hash = (await played(page)).find((p) => p.id === 'footsteps_2')!.hash;
  expect((await agent.cli(['render', agent.dir, 'footsteps_2'])).out).toContain(hash.slice(0, 12));
  await shot(page, 'set.png');
  // regen with a new seed: one command by the person, the members change, the target holds
  const hashes = await page.locator('[data-testid^=member-footsteps_]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.hash));
  const gainCount = async (): Promise<number> => (await texts(page)).filter((t) => /^sound set footsteps_\d gain=/.test(t)).length;
  const gainsBefore = await gainCount();
  await page.getByTestId('set-regen').click();
  await expect.poll(async () => (await texts(page)).filter((t) => /^set regen footsteps seed=\d+$/.test(t)).length).toBe(1);
  await expect.poll(async () => (await page.locator('[data-testid^=member-footsteps_]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.hash))).join()).not.toBe(hashes.join());
  expect((await rows(page)).find((r) => /^set regen/.test(r.text))!.by).toBe('human:ana');
  // matched at the start, and again after the regen (the seed is random, so how many members need a gain varies;
  // one already on the target needs no command)
  expect(gainsBefore).toBeGreaterThanOrEqual(5);
  await expect.poll(gainCount).toBeGreaterThan(gainsBefore);
  await expect(page.getByTestId('set-seed')).not.toHaveText('2');
  // the audition page for the set shows its six sounds
  await page.getByTestId('set-audition').click();
  await expect(page.getByTestId('audition')).toHaveAttribute('data-count', '6');
});

const BED = 'sound new rain voice=layered preset=rain seed=4; sound new zap voice=classic preset=laser seed=2';

test('the loop controls: length and crossfade are commands, the loop plays repeating, the seam is shown, and Node and the browser render the same bed', async ({ page }) => {
  await open(page, BED, '#/sound/rain');
  await expect(page.getByTestId('editor')).toBeVisible();
  await page.getByTestId('play-on-change').uncheck();
  const panel = page.getByTestId('loop-panel');
  await expect(panel).toHaveAttribute('data-loop', 'on');
  await expect(page.getByTestId('loop-seam')).toContainText('seam: jump');
  // length: a command by the person
  await page.getByTestId('loop-length').fill('3');
  await page.getByTestId('loop-length').blur();
  await expect.poll(() => texts(page)).toContain('sound loop rain 3 fade=0.5');
  expect((await rows(page)).find((r) => r.text === 'sound loop rain 3 fade=0.5')!.by).toBe('human:ana');
  await page.getByTestId('loop-fade').fill('0.25');
  await page.getByTestId('loop-fade').blur();
  await expect.poll(() => texts(page)).toContain('sound loop rain 3 fade=0.25');
  // the loop plays repeating (until stopped)
  await page.getByTestId('loop-play').click();
  await expect.poll(async () => (await played(page)).filter((p) => p.loop).length).toBe(1);
  await expect(page.getByTestId('loop-play')).toHaveAttribute('data-playing', 'true');
  const p = (await played(page)).at(-1)!;
  expect(p.samples).toBe(3 * 44100);
  const node = await agent.cli(['render', agent.dir, 'rain']);
  expect(node.out).toContain(p.hash.slice(0, 12));
  await shot(page, 'loop.png');
  await page.getByTestId('loop-play').click();
  await expect(page.getByTestId('loop-play')).toHaveAttribute('data-playing', 'false');
  // the seam numbers are the CLI's
  const seam = await page.getByTestId('loop-seam').getAttribute('data-jump');
  const view = await agent.cli(['view', agent.dir, 'rain', 'loop', '--out', join(agent.dir, '.cache', 'l.png')]);
  expect(view.out).toContain(`seam jump ${Number(seam).toFixed(3)}`);
  // off, and on again
  await page.getByTestId('loop-on').click(); // (the box follows the sound, which the command changes)
  await expect.poll(() => texts(page)).toContain('sound loop rain off');
  await expect(panel).toHaveAttribute('data-loop', 'off');
  await page.getByTestId('loop-on').click();
  await expect.poll(async () => (await texts(page)).filter((t) => t.startsWith('sound loop rain')).length).toBe(4);
});

test('a classic sound offers to become layered before it can loop', async ({ page }) => {
  await open(page, BED, '#/sound/zap');
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('loop-panel')).toContainText('needs a layered sound');
  await page.getByTestId('loop-layer-up').click();
  await expect.poll(async () => (await texts(page)).some((t) => /^sound layer-up zap seed=\d+$/.test(t))).toBe(true);
  await expect(page.getByTestId('loop-on')).toBeVisible();
});
