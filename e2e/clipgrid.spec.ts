// The clip grid and the blind A/B card in a browser: a set's grid shows each member's versions from
// the tape after agent and human edits, Enter restores a version as one batch, the number keys play
// a row or a column, the A/B card matches levels (the gain on each side) and skips a pair that is the
// same once matched, an answer reaches a waiting agent as a comparison with the moment, and the
// moment can be written from the page.

import { expect, type Page } from '@playwright/test';
import { test } from './fixtures.ts';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

type Played = { id: string; seq?: number; slot?: string; gain?: number; hash: string };
type Tape = { seq: number; by: string; group: string; cmd: string };
const played = (page: Page): Promise<Played[]> => page.evaluate(() => (window as unknown as { soundclaw: { played: Played[] } }).soundclaw.played);
const tape = (page: Page): Promise<Tape[]> => page.evaluate(() => (window as unknown as { soundclaw: { tape: Tape[] } }).soundclaw.tape.map((e) => ({ seq: e.seq, by: e.by, group: e.group, cmd: e.cmd })));
const cells = (page: Page, id: string) => page.getByTestId(`member-${id}`).locator('[data-testid^=cell-]').evaluateAll((els) => els.map((e) => {
  const d = (e as HTMLElement).dataset;
  return { label: d.label!, seq: Number(d.seq), current: d.current === 'true', proposed: d.proposed === 'true', by: e.querySelector('.author-mark')?.getAttribute('data-by') ?? null };
}));

const GRASS = 'sound new step voice=layered preset=footstep seed=11; set new grass from=step count=2 target=-20 seed=2';

async function open(page: Page, ...scripts: { by?: string; text: string }[]): Promise<void> {
  agent = await startAgent();
  for (const s of scripts) {
    const r = await agent.cli(['run', agent.dir, '-e', s.text, ...(s.by ? ['--by', s.by] : [])]);
    expect(r.code, r.err).toBe(0);
  }
  await page.goto(`${agent.url}&name=ana#/set/grass`);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
  await expect(page.getByTestId('set-page')).toHaveAttribute('data-set', 'grass');
}

test('the clip grid: each member\'s versions from the tape after agent and human edits, the agent\'s unapproved one apart', async ({ page }) => {
  await open(page, { text: GRASS },
    { by: 'human:ana', text: 'sound set grass_1 out=-2; layer mute grass_1 1 on' },
    { text: 'sound set grass_2 seed=99' });
  await expect.poll(() => cells(page, 'grass_1')).toEqual([
    expect.objectContaining({ label: 'v1', current: false, proposed: false, by: 'agent' }),
    expect.objectContaining({ label: 'v2', current: true, proposed: false, by: 'you' }),
  ]);
  await expect.poll(() => cells(page, 'grass_2')).toEqual([
    expect.objectContaining({ label: 'v1', current: false, proposed: false, by: 'agent' }),
    expect.objectContaining({ label: 'agent', current: true, proposed: true, by: 'agent' }),
  ]);
  // the columns: v1, v2 and the agent's
  await expect(page.getByTestId('col-1')).toContainText('v1');
  await expect(page.getByTestId('col-2')).toContainText('v2');
  await expect(page.getByTestId('col-3')).toContainText('agent');
  // a status mark is not a version; approving the agent's version makes it a numbered one
  const r = await agent.cli(['run', agent.dir, '-e', 'sound mark grass_2 approved', '--by', 'human:ana']);
  expect(r.code, r.err).toBe(0);
  await expect.poll(() => cells(page, 'grass_2')).toEqual([
    expect.objectContaining({ label: 'v1', current: false }),
    expect.objectContaining({ label: 'v2', current: true, proposed: false, by: 'agent' }),
  ]);
  await expect(page.getByTestId('col-3')).toHaveCount(0);
  // the meter has one mark per member, the loudness measured in the page
  await expect(page.getByTestId('mark-grass_1')).toBeVisible();
  await expect(page.getByTestId('mark-grass_2')).toBeVisible();
});

test('the clip grid: Enter on an earlier version makes it current with one human batch, and Enter on the agent\'s approves it', async ({ page }) => {
  await open(page, { text: GRASS },
    { by: 'human:ana', text: 'sound set grass_1 out=-2; layer mute grass_1 1 on' },
    { text: 'sound set grass_2 seed=99' });
  await expect.poll(async () => (await cells(page, 'grass_1')).length).toBe(2);
  const [v1] = await cells(page, 'grass_1');
  const hashOf = async (key: string) => { await page.getByTestId(`cell-${key}`).click(); await expect.poll(async () => (await played(page)).at(-1)?.seq).toBe(Number(key.split('@')[1])); return (await played(page)).at(-1)!.hash; };
  const h1 = await hashOf(`grass_1@${v1!.seq}`);
  const before = await tape(page);
  await page.getByTestId(`cell-grass_1@${v1!.seq}`).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('set-message')).toContainText('grass_1 is v1 again (2 commands, one undo)');
  await expect.poll(async () => (await tape(page)).length).toBe(before.length + 2);
  const added = (await tape(page)).slice(before.length);
  expect(added.every((e) => e.by === 'human:ana' && e.group === added[0]!.group)).toBe(true);
  expect(added.map((e) => e.cmd).join('\n')).toContain('layer mute grass_1 1 off');
  // the restored render is the newest version now, and it sounds as v1 did
  await expect.poll(() => cells(page, 'grass_1')).toEqual([
    expect.objectContaining({ label: 'v1', current: false, by: 'you' }),
    expect.objectContaining({ label: 'v2', current: true, by: 'you' }),
  ]);
  await page.getByTestId('member-play-grass_1').click();
  await expect.poll(async () => (await played(page)).at(-1)?.id).toBe('grass_1');
  expect((await played(page)).at(-1)!.hash).toBe(h1);
  // Enter on the agent's proposal approves it
  const agentCell = (await cells(page, 'grass_2')).find((c) => c.proposed)!;
  await page.getByTestId(`cell-grass_2@${agentCell.seq}`).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('set-message')).toContainText('Approved the agent\'s version of grass_2');
  await expect.poll(async () => (await tape(page)).at(-1)?.cmd).toBe('sound mark grass_2 approved');
});

test('the clip grid: the number keys play a row, shift and a number a column', async ({ page }) => {
  await open(page, { text: GRASS },
    { by: 'human:ana', text: 'sound set grass_1 out=-2' },
    { text: 'sound set grass_2 seed=99' });
  await expect.poll(async () => (await cells(page, 'grass_2')).length).toBe(2);
  const g1 = await cells(page, 'grass_1'), g2 = await cells(page, 'grass_2');
  await page.getByTestId('set-gap').fill('20');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('1');
  await expect.poll(async () => (await played(page)).map((p) => `${p.id}@${p.seq}`), { timeout: 15000 }).toEqual(g1.map((c) => `grass_1@${c.seq}`));
  await expect(page.getByTestId('set-play-all')).toHaveAttribute('data-playing', 'false', { timeout: 15000 });
  const n = (await played(page)).length;
  await page.keyboard.press('Shift+1');
  await expect.poll(async () => (await played(page)).slice(n).map((p) => `${p.id}@${p.seq}`), { timeout: 15000 }).toEqual([`grass_1@${g1[0]!.seq}`, `grass_2@${g2[0]!.seq}`]);
  await expect(page.getByTestId('set-play-all')).toHaveAttribute('data-playing', 'false', { timeout: 15000 });
  const m = (await played(page)).length;
  await page.keyboard.press('Shift+3'); // the agent's column: only grass_2 has one
  await expect.poll(async () => (await played(page)).slice(m).map((p) => `${p.id}@${p.seq}`), { timeout: 15000 }).toEqual([`grass_2@${g2[1]!.seq}`]);
});

test('the blind A/B card: levels matched with the gain on each side, and a pair that is the same once matched is skipped', async ({ page }) => {
  // grass_1's change is only a level (the same sound once matched); grass_2's is new noise
  await open(page, { text: GRASS }, { text: 'sound set grass_1 out=-3; sound set grass_2 seed=99' });
  await expect(page.getByTestId('ab-skipped')).toContainText('grass_1 · agent and grass_1 · v1 sound the same once their levels are matched', { timeout: 15000 });
  await expect(page.getByTestId('ab-matched')).toBeVisible();
  await expect(page.getByTestId('ab-count')).toHaveText('pair 2 of 2');
  for (const side of ['A', 'B']) {
    await expect(page.getByTestId(`ab-gain-${side}`)).toHaveText(/^gain applied [+−±]\d+\.\d dB$/);
    await expect(page.getByTestId(`ab-name-${side}`)).toHaveText('name hidden until you answer');
  }
  // the gains bring both to the same loudness: the cells' LUFS plus the gains agree
  const lufs = async (key: string) => Number((await page.getByTestId(`cell-${key}`).locator('.cg-lufs').textContent())!.replace('−', '-'));
  const gain = async (side: string) => Number((await page.getByTestId(`ab-gain-${side}`).textContent())!.replace('gain applied ', '').replace(' dB', '').replace('−', '-').replace('±', ''));
  const g2 = await cells(page, 'grass_2');
  const keys = g2.map((c) => `grass_2@${c.seq}`);
  const total = [(await lufs(keys[0]!)) + 0, (await lufs(keys[1]!)) + 0];
  const [ga, gb] = [await gain('A'), await gain('B')];
  // A is one of the two, B the other: either way the sums meet
  const meet = Math.min(Math.abs(total[0]! + ga - (total[1]! + gb)), Math.abs(total[1]! + ga - (total[0]! + gb)));
  expect(meet).toBeLessThan(0.25);
  // playing a side plays it at its gain
  await page.getByTestId('ab-play-A').click();
  await expect.poll(async () => (await played(page)).at(-1)?.slot).toBe('A');
  expect((await played(page)).at(-1)!.gain).toBe(ga);
});

test('the blind A/B card: an answer reaches a waiting agent as a comparison with the moment, then the names are shown', async ({ page }) => {
  await open(page, { text: GRASS }, { text: 'set moment grass "The player walks slowly across a meadow at night. Steps repeat every 0.4 s."; sound set grass_2 seed=99' });
  await expect(page.getByTestId('ab-moment-text')).toHaveText('The player walks slowly across a meadow at night. Steps repeat every 0.4 s.');
  await expect(page.getByTestId('ab-play-A')).toContainText('Play ×4');
  await expect(page.getByTestId('ab-matched')).toBeVisible({ timeout: 15000 });
  const waiting = agent.background(['await', agent.dir, '--timeout', '60']);
  await new Promise((r) => setTimeout(r, 500));
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('b');
  await expect(page.getByTestId('ab-recorded')).toContainText('Recorded: B fits better');
  const done = await waiting.done;
  expect(done.out).toContain('comparison r1 (grass_2)');
  expect(done.out).toContain('B fits better in "The player walks slowly across a meadow at night. Steps repeat every 0.4 s.": A was grass_2 as at #');
  expect(done.out).toMatch(/\(gain [+−-]?\d+\.\d dB\), B was grass_2 as at #\d+ \(gain/);
  // the names are shown, and the tally counts it
  await expect(page.getByTestId('ab-name-A')).toHaveAttribute('data-revealed', 'true');
  await expect(page.getByTestId('ab-name-A')).toHaveText(/^grass_2 · (v1|agent)$/);
  await expect(page.getByTestId('tally-b')).toHaveText('1');
  // the requests list says it in words, and → loads the next pair now (none left)
  const list = await agent.cli(['request', agent.dir]);
  expect(list.out).toContain('comparison grass_2: B fits better in');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('ab-empty')).toBeVisible();
});

test('the blind A/B card: a pair put there by C, by "compare with current", and on the audition page by picking two', async ({ page }) => {
  await open(page, { text: GRASS }, { by: 'human:ana', text: 'layer mute grass_1 1 on' }, { by: 'human:ana', text: 'sound set grass_2 seed=99' });
  // nothing is proposed, but each member has two versions: the queue holds two pairs
  await expect(page.getByTestId('ab-count')).toHaveText('pair 1 of 2', { timeout: 15000 });
  const g1 = await cells(page, 'grass_1'), g2 = await cells(page, 'grass_2');
  // pick two (the second with shift) and press C: that pair goes first
  await page.getByTestId(`cell-grass_1@${g1[0]!.seq}`).click();
  await page.getByTestId(`cell-grass_2@${g2[1]!.seq}`).click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('set-selection')).toContainText('grass_1 · v1 and grass_2 · v2 picked');
  await page.keyboard.press('c');
  await expect(page.getByTestId('ab-count')).toHaveText('pair 1 of 3');
  // one picked: compare it with its sound's current version
  await page.getByTestId(`cell-grass_2@${g2[0]!.seq}`).click();
  await page.getByTestId('sel-compare-current').click();
  await expect(page.getByTestId('ab-card')).toHaveAttribute('data-pair', [`grass_2@${g2[0]!.seq}`, `grass_2@${g2[1]!.seq}`].sort().join('|'));
  // the audition page: pick two sounds and press C
  await page.goto(`${agent.url}&name=ana#/audition`);
  await expect(page.getByTestId('audition')).toHaveAttribute('data-count', '3');
  await page.getByTestId('cell-grass_1').click();
  await page.getByTestId('cell-step').click({ modifiers: ['Shift'] });
  await page.keyboard.press('c');
  await expect(page.getByTestId('ab-matched')).toBeVisible({ timeout: 15000 });
  await page.getByTestId('ab-answer-neither').click();
  await expect(page.getByTestId('ab-recorded')).toContainText('Neither would do');
  const list = await agent.cli(['request', agent.dir]);
  expect(list.out).toMatch(/comparison (grass_1|step): Neither would do \(no moment given\)/);
});

test('the moment: written from the A/B card as a command, then edited', async ({ page }) => {
  await open(page, { text: GRASS }, { text: 'sound set grass_2 seed=99' });
  const field = page.getByTestId('ab-moment-field');
  await expect(field).toBeVisible({ timeout: 15000 });
  await field.fill('A quiet garden at dusk. Steps repeat every 0.5 s.');
  await field.press('Enter');
  await expect(page.getByTestId('ab-moment-text')).toHaveText('A quiet garden at dusk. Steps repeat every 0.5 s.');
  await expect.poll(async () => (await tape(page)).at(-1)).toEqual(expect.objectContaining({ by: 'human:ana', cmd: 'set moment grass "A quiet garden at dusk. Steps repeat every 0.5 s."' }));
  await expect(page.getByTestId('ab-play-A')).toContainText('Play ×4');
  await page.getByTestId('ab-moment-edit').click();
  await field.fill('A rainy courtyard.');
  await page.getByTestId('ab-moment-save').click();
  await expect(page.getByTestId('ab-moment-text')).toHaveText('A rainy courtyard.');
  await expect(page.getByTestId('ab-play-A')).not.toContainText('×4');
  const d = await agent.cli(['describe', agent.dir, 'grass_1']);
  expect(d.out).toContain('moment (of set grass): "A rainy courtyard."');
});
