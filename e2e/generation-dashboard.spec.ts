// The generation panel and what grows around it: the estimate and the budget before anything is spent, the free test provider's takes arriving in Takes
// as one item in the feed, a cap only a person sets, Keep recording where a take came from, the spend on the session page, a request about a sample
// itself and the old route through a sound that plays it, and a long library file streamed in ranges.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { pcmFromFloats, pcmToWav } from '../core/src/index.ts';
import { makeSamples } from './example.ts';
import { test } from './fixtures.ts';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

interface Tape { cmd: string; by: string; group: string }
const tape = (): Tape[] => readFileSync(join(agent.dir, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Tape).filter((t) => typeof t.cmd === 'string');
const requests = (): { type: string; id: string; sound?: string; by: string; note?: string; text?: string }[] => readFileSync(join(agent.dir, 'requests.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as never);

async function open(page: Page, hash = ''): Promise<void> {
  await page.goto(`${agent.url}&name=ana${hash}`);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
}
async function start(): Promise<void> {
  agent = await startAgent();
  await makeSamples(agent);
}
const takesTab = async (page: Page): Promise<void> => { await page.getByTestId('lib-tab-samples').click(); await page.getByTestId('samples-mode-takes').click(); };

test('the generation panel: the estimate and the budget first, free test audio with no confirm, and the takes arrive in Takes as one feed item', async ({ page }) => {
  test.setTimeout(180_000);
  await start();
  await open(page);
  await takesTab(page);
  const before = await page.locator('[data-testid^=take-]').count();
  await page.getByTestId('takes-generate').click();
  await expect(page.getByTestId('generate-dialog')).toBeVisible();
  await expect(page.getByTestId('gen-go')).toBeDisabled();
  await expect(page.getByTestId('gen-estimate')).toContainText('Type a prompt');
  // the free provider: no credits, no confirmation
  await page.getByTestId('gen-provider').selectOption('fake');
  await page.getByTestId('gen-prompt').fill('a short wooden click, dry');
  await page.getByTestId('gen-duration').fill('0.5');
  await page.getByTestId('gen-takes').selectOption('2');
  await page.getByTestId('gen-name').fill('click');
  await expect(page.getByTestId('gen-cost')).toContainText('0 credits for 2 takes');
  await expect(page.getByTestId('gen-cost')).toContainText('free test audio');
  await expect(page.getByTestId('gen-confirm')).toHaveCount(0);
  await expect(page.getByTestId('gen-go')).toBeEnabled();
  // a length outside what the provider takes is said, and writes nothing
  await page.getByTestId('gen-duration').fill('999');
  await expect(page.getByTestId('gen-duration')).toHaveAttribute('aria-invalid', 'true');
  await page.getByTestId('gen-duration').fill('0.5');
  const n = tape().length;
  await expect(page.getByTestId('gen-go')).toBeEnabled();
  await page.getByTestId('gen-go').click();
  await expect(page.getByTestId('generate-dialog')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId('samples-browser')).toHaveAttribute('data-mode', 'takes');
  await expect(page.getByTestId('take-click_t1')).toBeVisible();
  await expect(page.getByTestId('take-click_t2')).toBeVisible();
  expect(await page.locator('[data-testid^=take-]').count()).toBeGreaterThanOrEqual(before + 2);
  const adds = tape().slice(n).filter((t) => t.cmd.startsWith('sample add click_t'));
  expect(adds).toHaveLength(2);
  expect(adds.every((t) => t.by === 'human:ana' && t.cmd.includes('source=generated') && t.cmd.includes('provider=fake') && t.group === adds[0]!.group)).toBe(true);
  // the feed says it once: what was asked, how many takes, the cost
  const item = page.getByTestId('feed-item').filter({ hasText: 'Generated 2 takes' });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('a short wooden click, dry');
  // the session page: the ledger line and the budget
  await page.goto('about:blank');
  await open(page, '#/session');
  await expect(page.getByTestId('session-spend')).toBeVisible();
  await expect(page.getByTestId('spend-line').first()).toContainText('2 takes');
  await expect(page.getByTestId('spend-line').first()).toContainText('fake sfx');
  await expect(page.getByTestId('spend-state')).toContainText('paid generation is off');
  await expect(page.getByTestId('budget-this project')).toContainText('0 spent');
});

test('a paid provider is refused with the reasons until a person sets a cap; the cap is shown against the spend, and never set by the page for an agent', async ({ page }) => {
  test.setTimeout(120_000);
  agent = await startAgent();
  await open(page);
  await page.getByTestId('lib-tab-samples').click();
  await page.getByTestId('samples-mode-takes').click();
  await page.getByTestId('takes-generate').click();
  await page.getByTestId('gen-provider').selectOption('elevenlabs');
  await page.getByTestId('gen-prompt').fill('a slow creak of an old door');
  await expect(page.getByTestId('gen-refusal').first()).toBeVisible();
  await expect(page.getByTestId('gen-estimate')).toContainText('cap');
  await expect(page.getByTestId('gen-go')).toBeDisabled();
  await expect(page.getByTestId('gen-cap')).toBeVisible();
  await expect(page.getByTestId('budget-this project')).toContainText('no cap');
  await page.getByTestId('gen-cap-input').fill('500');
  await page.getByTestId('gen-cap-set').click();
  await expect(page.getByTestId('budget-this project')).toContainText('0 of 500 credits');
  await expect(page.getByTestId('gen-cap')).toHaveCount(0);
  // still refused (the account has no plan and no key here), and nothing was called or written
  await expect(page.getByTestId('gen-go')).toBeDisabled();
  expect(tape().filter((t) => t.cmd.startsWith('sample add'))).toHaveLength(0);
  expect(JSON.parse(readFileSync(join(agent.dir, 'project.json'), 'utf8')).generation.capCredits).toBe(500);
  // the cap route takes only a person
  const r = await fetch(`http://127.0.0.1:${agent.port}/api/generation/cap?token=${agent.token}`, { method: 'POST', body: JSON.stringify({ capCredits: 99999, by: 'agent:claude' }) });
  expect(r.status).toBe(403);
});

test('Keep records which take a sample came from, so the Takes list stays right when the kept tag is edited', async ({ page }) => {
  test.setTimeout(180_000);
  await start();
  await open(page);
  await takesTab(page);
  await expect(page.getByTestId('take-creak_gen_t1')).toBeVisible();
  await page.getByTestId('keep-creak_gen_t1').click();
  await page.getByTestId('keep-name').fill('creak_keep');
  await page.getByTestId('keep-confirm').check();
  await page.getByTestId('keep-go').click();
  await expect(page.getByTestId('take-creak_gen_t1')).toHaveCount(0);
  const set = tape().filter((t) => t.cmd.startsWith('sample set creak_keep')).at(-1)!;
  expect(set.cmd).toMatch(/tags=[a-z,]*kept[a-z,]* kept-from=creak_gen_t1/);
  expect(set.by).toBe('human:ana');
  // the tag is edited away (by anyone): it is still a kept take
  const r = await agent.cli(['run', agent.dir, '-e', 'sample set creak_keep tags=none', '--by', 'human:ana']);
  expect(r.code, r.err).toBe(0);
  await expect(page.getByTestId('take-creak_keep')).toHaveCount(0);
  await page.goto('about:blank');
  await open(page, '#/sample/creak_keep');
  await expect(page.getByTestId('prov-kept-from')).toContainText('creak_gen_t1');
  await takesTab(page);
  await expect(page.getByTestId('take-creak_keep')).toHaveCount(0);
  await expect(page.getByTestId('take-creak_gen_t2')).toBeVisible();
});

test('a request about a sample itself: filed from its page, shown in the rail and on the page, claimed and finished by the agent, approved by the person; the old route through a sound still works', async ({ page }) => {
  test.setTimeout(180_000);
  await start();
  let r = await agent.cli(['run', agent.dir, '-e', 'sound new knock voice=layered\nlayer add knock sample sample=door_hits', '--by', 'agent:claude']);
  expect(r.code, r.err).toBe(0);
  await open(page, '#/sample/door_hits');
  await page.getByTestId('snum-length').waitFor({ timeout: 30_000 });
  await page.getByTestId('sample-ask').click();
  await expect(page.getByTestId('ask-on-sample')).toBeChecked();
  await page.getByTestId('ask-sample-text').fill('shorter, and drier');
  await page.getByTestId('ask-sample-go').click();
  await expect.poll(() => requests().length).toBe(1);
  expect(requests()[0]).toMatchObject({ type: 'request', sound: 'sample:door_hits', by: 'human:ana', note: 'shorter, and drier' });
  await expect(page.getByTestId('sample-request-r1')).toBeVisible();
  await expect(page.getByTestId('sample-request-state-r1')).toHaveText('sent');
  await expect(page.getByTestId('rail-request-r1')).toContainText('shorter, and drier');
  // the agent is handed it with the sample's numbers
  r = await agent.cli(['work', agent.dir, 'claim', 'r1', '--by', 'agent:claude']);
  expect(r.code, r.err).toBe(0);
  expect(r.out).toContain('the sample now:');
  expect(r.out).toContain('door_hits');
  await expect(page.getByTestId('sample-request-state-r1')).toHaveText('claimed');
  await agent.cli(['work', agent.dir, 'progress', 'r1', 'trimming the tail', '--by', 'agent:claude']);
  await expect(page.getByTestId('sample-request-said-r1')).toHaveText('trimming the tail');
  r = await agent.cli(['work', agent.dir, 'done', 'r1', 'made door_hits_short', '--by', 'agent:claude']);
  expect(r.code, r.err).toBe(0);
  await expect(page.getByTestId('sample-request-state-r1')).toHaveText('ready for review');
  await expect(page.getByTestId('sample-request-said-r1')).toHaveText('made door_hits_short');
  // the session page opens the sample, not a review of a sound
  await page.goto('about:blank');
  await open(page, '#/session');
  await expect(page.getByTestId('lane-review-r1')).toHaveAttribute('href', '#/sample/door_hits');
  await page.getByTestId('lane-review-r1').click();
  await page.getByTestId('sample-request-approve-r1').click();
  await expect(page.getByTestId('sample-request-state-r1')).toHaveText('approved');
  expect(requests().at(-1)).toMatchObject({ type: 'reviewed', id: 'r1', by: 'human:ana', text: 'approved' });
  // the old route: a request on a sound that plays the sample, with the sample named in the note
  await page.getByTestId('sample-ask').click();
  await page.getByTestId('ask-on-sound').check();
  await page.getByTestId('ask-sample-sound').selectOption('knock');
  await page.getByTestId('ask-sample-text').fill('less boomy');
  await page.getByTestId('ask-sample-go').click();
  await expect.poll(() => requests().filter((q) => q.type === 'request').length).toBe(2);
  expect(requests().filter((q) => q.type === 'request')[1]).toMatchObject({ sound: 'knock', note: 'About sample door_hits: less boomy' });
  expect(tape().some((t) => t.cmd.startsWith('sound mark knock rejected'))).toBe(true);
});

test('a library file over 2 MB is auditioned from byte ranges, not fetched whole', async ({ page }) => {
  test.setTimeout(120_000);
  agent = await startAgent();
  const lib = join(agent.root, 'long-library');
  const wave = (f: number): Float32Array => Float32Array.from({ length: 44100 * 30 }, (_, i) => 0.3 * Math.sin((i / 44100) * 6.283185307179586 * f));
  mkdirSync(join(lib, 'beds'), { recursive: true });
  writeFileSync(join(lib, 'beds', 'long_bed.wav'), pcmToWav(pcmFromFloats([wave(220), wave(330)], 44100, 'pcm16')));
  writeFileSync(join(lib, 'beds', 'short.wav'), pcmToWav(pcmFromFloats([wave(440).subarray(0, 4410)], 44100, 'pcm16')));
  for (const args of [['library', 'add', lib, 'licence=CC0-1.0', '--name', 'longlib'], ['library', 'index', 'longlib']]) {
    const r = await agent.cli(args);
    expect(r.code, r.err).toBe(0);
  }
  const seen: { range: string | undefined; status: number }[] = [];
  page.on('response', (res) => { if (res.url().includes('/audio?')) seen.push({ range: res.request().headers().range, status: res.status() }); });
  await open(page);
  await page.getByTestId('lib-tab-samples').click();
  await page.getByTestId('samples-mode-library').click();
  await expect(page.getByTestId('library-hit')).toHaveCount(2, { timeout: 30_000 });
  const play = async (ref: string) => { await page.getByTestId(`play-hit-${ref}`).click(); };
  await play('longlib:beds/long_bed.wav');
  await expect.poll(() => seen.length, { timeout: 30_000 }).toBeGreaterThan(2);
  // the first range asks for 2 MB; the rest follow in 1 MB ranges to the last byte; nothing asks for the whole file
  expect(seen[0]).toMatchObject({ range: 'bytes=0-2097151', status: 206 });
  expect(seen.slice(1).every((s) => /^bytes=\d+-\d+$/.test(s.range ?? '') && s.status === 206)).toBe(true);
  expect(seen.every((s) => s.range !== undefined)).toBe(true);
  const played = await page.evaluate(() => (window as unknown as { soundclaw: { played: { id: string; samples: number }[] } }).soundclaw.played.at(-1));
  expect(played).toMatchObject({ id: 'library:longlib:beds/long_bed.wav', samples: 44100 * 30 });
  await page.getByTestId('play-hit-longlib:beds/long_bed.wav').click(); // stops it
  await expect(page.getByTestId('play-hit-longlib:beds/long_bed.wav')).toHaveAttribute('aria-pressed', 'false');
  // a short file comes back whole in the first range
  seen.length = 0;
  await play('longlib:beds/short.wav');
  await expect.poll(() => seen.length).toBe(1);
  expect(seen[0]).toMatchObject({ range: 'bytes=0-2097151', status: 206 });
});
