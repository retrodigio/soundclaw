// The agent layer: the composer from every kind of selection (and the target reaching `soundclaw await` in words), the session
// page's lanes, batch progress filling while a batch runs, the history tape's preview, a review's three decisions with Undo and
// focus return, and the live-arrival rules (the update chip, and nothing moving under you).

import { expect, type Page } from '@playwright/test';
import { test } from './fixtures.ts';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

const LASER = 'sound new laser voice=classic; sound set laser wave=square attack=0 sustain=0.1 decay=0.3 freq=0.5 volume=0.245';
const BOOM = [
  'sound new boom voice=layered seed=4', 'layer add boom osc wave=brown dur=0.4', 'layer add boom osc wave=sine freq=48 dur=0.5',
  'fx add boom layer=1 filter type=lp cutoff=1800', 'fx add boom layer=2 reverb',
].join('\n');
// 120 bpm, 16 steps at four a beat: a pattern is one bar of two seconds
const SONG = `song new mix tempo=120 key=C:major
song channel add mix bass inst=triangle_bass layer=base
song channel add mix lead inst=pulse_lead layer=tension
pattern mix.a steps=16 tpb=4 bar=8
  bass: C3 . . . C3 . . . | G2 . . . G2 . . .
  lead: C5 . E5 . G5 . E5 . | C5 . E5 . G5 . E5 .
pattern mix.b steps=16 tpb=4 bar=8
  lead: E5 - - - - - - - | G5 - - - - - - -
song section add mix A a x2
song section add mix B b x2
`;

async function open(page: Page, hash = '', setup = [LASER, BOOM, SONG]): Promise<void> {
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  agent = await startAgent();
  for (const s of setup) {
    const r = await agent.cli(['run', agent.dir, '-e', s, '--by', 'human:ana']);
    expect(r.code, r.err).toBe(0);
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${agent.url}&name=ana${hash}`);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
}

type TapeRow = { seq: number; by: string; group: string; cmd: string };
const tapeOf = (page: Page): Promise<TapeRow[]> => page.evaluate(() => (window as unknown as { soundclaw: { tape: TapeRow[] } }).soundclaw.tape.map((e) => ({ seq: e.seq, by: e.by, group: e.group, cmd: e.cmd })));
const humanGroups = async (page: Page): Promise<string[][]> => {
  const groups = new Map<string, string[]>();
  for (const r of (await tapeOf(page)).filter((x) => x.by === 'human:ana')) groups.set(r.group, [...(groups.get(r.group) ?? []), r.cmd]);
  return [...groups.values()];
};
const played = (page: Page) => page.evaluate(() => (window as unknown as { soundclaw: { played: { id: string; seq?: number; hash: string; slot?: string }[] } }).soundclaw.played);
const agentRun = (cmds: string) => agent.cli(['run', agent.dir, '-e', cmds, '--by', 'agent:claude']);

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

async function ask(page: Page, note: string): Promise<void> {
  await expect(page.getByTestId('composer-note')).toBeFocused();
  await page.getByTestId('composer-note').fill(note);
  await page.getByTestId('composer-note').press('Meta+Enter');
  await expect(page.getByTestId('composer')).toHaveCount(0);
}

test('the composer opens from a region, bars, a knob, a layer, a device and an item, and each target reaches await in words', async ({ page }) => {
  await open(page);
  // a region on a lens
  await page.goto(`${agent.url}&name=ana#/sound/laser`);
  const box = (await page.getByTestId('lens-surface').boundingBox())!;
  await drag(page, { x: box.x + box.width * 0.3, y: box.y + box.height * 0.5 }, { x: box.x + box.width * 0.55, y: box.y + box.height * 0.5 });
  await page.keyboard.press('r');
  await expect(page.getByTestId('composer')).toHaveAttribute('data-target', 'range');
  await expect(page.getByTestId('chip-selection')).toContainText(/laser · pinned to 0\.\d+–0\.\d+ s/);
  await expect(page.getByRole('dialog', { name: 'Ask for changes' })).toBeVisible();
  await ask(page, 'the tail rings on too long here');
  // a knob (focus is on the slider)
  await page.getByTestId('slot-decay').getByRole('slider').focus();
  await page.keyboard.press('r');
  await expect(page.getByTestId('composer')).toHaveAttribute('data-target', 'param');
  await expect(page.getByTestId('chip-selection')).toContainText('parameter decay');
  await ask(page, 'decay is too long');
  // a layer and a device
  await page.goto(`${agent.url}&name=ana#/sound/boom`);
  await page.getByTestId('layer-select-2').focus();
  await page.keyboard.press('r');
  await expect(page.getByTestId('chip-selection')).toContainText('layer 2');
  await ask(page, 'this layer is muddy');
  await page.getByTestId('fx-1-1').focus();
  await page.keyboard.press('r');
  await expect(page.getByTestId('chip-selection')).toContainText('parameter filter of effect 1 on layer 1');
  await ask(page, 'open the filter');
  // bars on a song's ruler, with the selected channel
  await page.goto(`${agent.url}&name=ana#/song/mix`);
  await expect(page.getByTestId('seam-badge')).toBeVisible();
  await page.getByTestId('bar-ruler').scrollIntoViewIfNeeded();
  const r = (await page.getByTestId('bar-ruler').boundingBox())!;
  await drag(page, { x: r.x + r.width * 0.3, y: r.y + 40 }, { x: r.x + r.width * 0.55, y: r.y + 40 });
  await expect(page.getByTestId('bar-selection')).toBeVisible();
  await page.getByTestId('track-name-lead').click();
  await page.keyboard.press('r');
  await expect(page.getByTestId('composer')).toHaveAttribute('data-target', 'bars');
  await expect(page.getByTestId('chip-selection')).toContainText(/bars \d–\d of lead/);
  await ask(page, 'the lead is too busy');
  // an item: R on the library's selection, and the context menu on a row
  await page.goto(`${agent.url}&name=ana#/`);
  await page.getByTestId('lib-row-boom').click();
  await page.keyboard.press('r');
  await expect(page.getByTestId('chip-selection')).toHaveText('boom');
  await ask(page, 'make it bigger');
  await page.getByTestId('lib-row-laser').click({ button: 'right' });
  await page.getByTestId('ctx-ask').click();
  await expect(page.getByTestId('composer')).toHaveAttribute('data-target', 'item');
  await ask(page, 'a touch brighter');
  // the agent hears all of them, in words
  const got = await agent.cli(['await', agent.dir, '--timeout', '5']);
  expect(got.code, got.err).toBe(0);
  expect(got.out).toMatch(/\(laser\) from human:ana at \S+: "the tail rings on too long here[^\n]*" — pinned to 0\.\d+–0\.\d+ s/);
  expect(got.out).toContain('"decay is too long" — parameter decay');
  expect(got.out).toContain('"this layer is muddy" — layer 2');
  expect(got.out).toContain('"open the filter" — parameter filter of effect 1 on layer 1');
  expect(got.out).toMatch(/\(mix\) from human:ana at \S+: "the lead is too busy" — bars \d–\d of lead/);
  expect(got.out).toMatch(/"make it bigger[^"]*" — the item as a whole/);
  expect(got.out).toMatch(/"a touch brighter[^"]*" — the item as a whole/);
  // the check inside the region was attached (the laser starts at a click)
  const list = await agent.cli(['request', agent.dir]);
  expect(list.out).toMatch(/\[attached: click check/);
});

test('the composer: the check can be removed, Esc gives focus back, and it stays put while the agent writes', async ({ page }) => {
  await open(page, '#/sound/laser');
  const box = (await page.getByTestId('lens-surface').boundingBox())!;
  // a region over the very start of the sound, where the click is
  await drag(page, { x: box.x + 2, y: box.y + box.height * 0.5 }, { x: box.x + box.width * 0.2, y: box.y + box.height * 0.5 });
  await page.locator('body').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('r');
  await expect(page.getByTestId('chip-check')).toContainText('click');
  await expect(page.getByTestId('chip-check')).toContainText('attached');
  await page.getByTestId('composer-note').fill('half written');
  // the agent writes while the composer is open: it keeps its place, text and focus
  const before = await page.getByTestId('composer').boundingBox();
  expect((await agentRun('sound set laser decay=0.25\nsound set laser decay=0.2\nsound set laser decay=0.28')).code).toBe(0);
  await expect(page.getByTestId('feed')).toContainText('decay=0.28');
  expect(await page.getByTestId('composer').boundingBox()).toEqual(before);
  await expect(page.getByTestId('composer-note')).toBeFocused();
  await expect(page.getByTestId('composer-note')).toHaveValue('half written');
  // remove the check chip; send is disabled without a note and Esc cancels
  await page.getByTestId('chip-check').getByRole('button').click();
  await expect(page.getByTestId('chip-check')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('composer')).toHaveCount(0);
  await expect(page.locator('body')).toBeFocused();
  expect((await agent.cli(['request', agent.dir])).out).toContain('no open requests');
});

test('the session page: a request moves through sent, seen, claimed, working, blocked, a reply and ready for review', async ({ page }) => {
  await open(page, '#/session');
  const count = (lane: string) => expect(page.getByTestId(`lane-count-${lane}`));
  expect((await agent.cli(['request', agent.dir, 'laser', '--note', 'shorten the tail', '--target', 'range 0.31-0.38', '--by', 'human:ana'])).code).toBe(0);
  await expect(page.getByTestId('lane-sent').getByTestId('lane-card-r1')).toContainText('shorten the tail');
  await expect(page.getByTestId('lane-target-r1')).toHaveText('pinned to 0.31–0.38 s');
  await count('sent').toHaveText('1');
  await expect(page.getByTestId('session-working')).toHaveAttribute('data-idle', 'true');
  // seen: an agent was handed it
  await agent.cli(['work', agent.dir, 'list']);
  await expect(page.getByTestId('lane-seen').getByTestId('lane-card-r1')).toBeVisible();
  await count('sent').toHaveText('0');
  // claimed, with the working card
  await agent.cli(['work', agent.dir, 'claim', 'r1']);
  await expect(page.getByTestId('lane-claimed').getByTestId('lane-card-r1')).toBeVisible();
  await expect(page.getByTestId('working-note')).toContainText('shorten the tail');
  await expect(page.getByTestId('working-target')).toContainText('pinned to 0.31–0.38 s');
  // working: progress, and the agent's commands since the claim, live from the tape
  await agent.cli(['work', agent.dir, 'progress', 'r1', 'cutting the decay']);
  await expect(page.getByTestId('lane-working').getByTestId('lane-card-r1')).toContainText('cutting the decay');
  await expect(page.getByTestId('working-progress')).toContainText('cutting the decay');
  await agentRun('sound set laser decay=0.2');
  await expect(page.getByTestId('working-cmds')).toContainText('sound set laser decay=0.2');
  // blocked: the question and a reply field that writes a reply
  await agent.cli(['work', agent.dir, 'block', 'r1', 'How short is short?']);
  await expect(page.getByTestId('lane-blocked').getByTestId('lane-question-r1')).toContainText('How short is short?');
  await page.getByTestId('lane-blocked').getByTestId('reply-text-r1').fill('under a tenth of a second');
  await page.getByTestId('lane-blocked').getByTestId('reply-send-r1').click();
  await expect(page.getByTestId('lane-sent').getByTestId('lane-card-r1')).toBeVisible();
  const reqs = await agent.cli(['request', agent.dir]);
  expect(reqs.out).toContain('r1 change laser');
  // claimed again, then done: ready for review
  await agent.cli(['work', agent.dir, 'claim', 'r1']);
  await agentRun('sound set laser attack=0.02');
  await agent.cli(['work', agent.dir, 'done', 'r1', 'cut the decay and gave it an attack']);
  await expect(page.getByTestId('lane-review').getByTestId('lane-card-r1')).toContainText('cut the decay');
  await count('review').toHaveText('1');
  await expect(page.getByTestId('session-working')).toHaveAttribute('data-idle', 'true');
  // an approval from a person takes it out of "ready for review" and into Closed
  await page.goto(`${agent.url}&name=ana#/`);
  await page.getByTestId('card-laser').getByTestId('approve-laser').click();
  await page.goto(`${agent.url}&name=ana#/session`);
  await expect(page.getByTestId('lane-count-review')).toHaveText('0');
  await expect(page.getByTestId('lane-count-closed')).toHaveText('1');
  expect(await page.getByTestId('lane-closed').getAttribute('open')).toBeNull();
});

test('batch progress: a batch of several items starts with a count and the cells fill as items land', async ({ page }) => {
  await open(page, '#/session');
  // every change to the cells' count is recorded (each progress message is a task of its own, so each one is drawn)
  await page.evaluate(() => {
    const w = window as unknown as { __seen: string[] };
    w.__seen = [];
    new MutationObserver((ms) => { for (const m of ms) { const e = m.target as HTMLElement; if (e.dataset.testid === 'session-batch') w.__seen.push(`${e.dataset.state}:${e.dataset.done}/${e.dataset.total}`); } })
      .observe(document.body, { attributes: true, subtree: true, attributeFilter: ['data-done'] });
  });
  const lines = Array.from({ length: 6 }, (_, i) => `sound mutate laser amount=0.1 seed=${i + 3} as=laser_${String.fromCharCode(97 + i)}`).join('\n');
  expect((await agentRun(lines)).code).toBe(0);
  await expect(page.getByTestId('session-batch')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('session-batch')).toHaveAttribute('data-done', '6');
  await expect(page.getByTestId('session-batch-count')).toHaveText('6 / 6');
  await expect(page.getByTestId('session-batch-cell-6')).toHaveAttribute('data-state', 'ready');
  const log = await page.evaluate(() => (window as unknown as { soundclaw: { batchLog: string[] } }).soundclaw.batchLog);
  expect(log).toEqual(['start:0/6', 'item:1/6', 'item:2/6', 'item:3/6', 'item:4/6', 'item:5/6', 'item:6/6', 'end:6/6']);
  // the cells were drawn filling one by one, not only full
  const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
  for (const n of [1, 2, 3, 4, 5]) expect(seen, seen.join(' ')).toContain(`running:${n}/6`);
  expect(seen.at(-1)).toBe('running:6/6');
  // the same strip is on the page the batch touches, and nowhere it does not
  await page.goto(`${agent.url}&name=ana#/sound/laser`);
  await agentRun('set new steps from=laser count=8 seed=3');
  await expect(page.getByTestId('batch-strip')).toHaveAttribute('data-total', '8');
  await expect(page.getByTestId('batch-strip')).toHaveAttribute('data-state', 'done');
  expect((await page.evaluate(() => (window as unknown as { soundclaw: { batchLog: string[] } }).soundclaw.batchLog)).at(-1)).toBe('end:8/8');
});

test('the history tape: agent marks are round and yours square, a batch is a labelled span, and a click plays the item as it was after that group', async ({ page }) => {
  await open(page, '#/');
  await agentRun('sound set laser decay=0.15');
  await agentRun('sound set laser freq=0.7\nsound set laser sustain=0.3');
  await page.getByTestId('lib-row-laser').click();
  await page.goto(`${agent.url}&name=ana#/session`);
  const rows = await tapeOf(page);
  const first = rows.find((r) => r.cmd === 'sound set laser decay=0.15')!;
  const last = rows.at(-1)!;
  await expect(page.getByTestId('tape').getByTestId('tape-count')).toContainText(`${rows.length} commands`);
  await expect(page.getByTestId('tape').locator(`[data-testid=tape-mark][data-seq="${first.seq}"]`)).toHaveAttribute('data-by', 'agent');
  await expect(page.getByTestId('tape').locator('[data-testid=tape-mark][data-by="you"]').first()).toBeVisible();
  const round = await page.getByTestId('tape').locator(`[data-testid=tape-mark][data-seq="${first.seq}"]`).evaluate((e) => getComputedStyle(e).borderRadius);
  const square = await page.getByTestId('tape').locator('[data-testid=tape-mark][data-by="you"]').first().evaluate((e) => getComputedStyle(e).borderRadius);
  expect(parseFloat(round)).toBeGreaterThan(parseFloat(square));
  const span = page.getByTestId('tape').getByTestId(`tape-span-${last.group}`);
  await expect(span).toHaveAttribute('title', new RegExp(`${last.group}: batch of 2 commands by`));
  // the label fits its span: the long form, "n cmds" or the count, never cut
  await expect(span.locator('.tape-span-label')).toHaveText(/^(batch · 2 commands|2 cmds|2|)$/);
  expect(await span.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  // hovering a mark lists its group's commands
  await page.getByTestId('tape').locator(`[data-testid=tape-mark][data-seq="${last.seq}"]`).hover();
  await expect(page.getByTestId('tape-tip')).toContainText('sound set laser sustain=0.3');
  // a click plays the focused item as it was after that group: not the sound as it is now
  await page.getByTestId('tape').locator(`[data-testid=tape-mark][data-seq="${first.seq}"]`).click();
  await expect.poll(async () => (await played(page)).at(-1)?.seq).toBe(first.seq);
  const early = (await played(page)).at(-1)!;
  expect(early.id).toBe('laser');
  await page.getByTestId('tape').locator(`[data-testid=tape-mark][data-seq="${last.seq}"]`).click();
  await expect.poll(async () => (await played(page)).at(-1)?.seq).toBe(last.seq);
  expect((await played(page)).at(-1)!.hash).not.toBe(early.hash);
  await expect(page.getByTestId('tape').getByTestId('tape-note')).toContainText('as it was after');
  // nothing was written
  expect((await tapeOf(page)).length).toBe(rows.length);
  // Undo batch is the existing undo of the latest group
  await page.getByTestId('tape').getByTestId('tape-undo').click();
  await expect.poll(async () => (await tapeOf(page)).at(-1)?.cmd).toMatch(/^undo group=/);
});

test('review: approve, ask again and revert each write their commands, offer Undo and send focus back', async ({ page }) => {
  await open(page, '#/session', [
    'sound new coin voice=classic; sound set coin wave=square attack=0 sustain=0.1 decay=0.3 freq=0.5 volume=0.245',
    'sound new zap voice=classic; sound set zap wave=square attack=0.02 sustain=0.1 decay=0.3 freq=0.5 volume=0.245',
    'sound new pop voice=classic; sound set pop wave=square attack=0.02 sustain=0.1 decay=0.3 freq=0.5 volume=0.245',
  ]);
  // three requests, each finished by the agent
  for (const [i, s] of ['coin', 'zap', 'pop'].entries()) {
    const id = `r${i + 1}`;
    await agent.cli(['request', agent.dir, s, '--note', `brighter ${s}`, '--by', 'human:ana']);
    await agent.cli(['work', agent.dir, 'claim', id]);
    await agentRun(s === 'coin' ? 'sound set coin attack=0.02' : `sound set ${s} decay=0.2 freq=0.55`);
    await agent.cli(['work', agent.dir, 'done', id, `changed ${s}`]);
  }
  await expect(page.getByTestId('lane-count-review')).toHaveText('3');

  // ---- the review of coin: the click that was there is gone
  await page.getByTestId('lane-review-r1').click();
  await expect(page).toHaveURL(/#\/review\/r1$/);
  await expect(page.getByTestId('review-item')).toHaveText('coin');
  await expect(page.getByTestId('review-status')).toHaveText('ready for review');
  await expect(page.getByTestId('review-wave-a').getByTestId('review-marker-a')).toHaveCount(1);
  await expect(page.getByTestId('review-wave-b').getByTestId('review-marker-b')).toHaveCount(0);
  await expect(page.getByTestId('review-tag-a')).toContainText('× click');
  await expect(page.getByTestId('review-tag-b')).toContainText('✓ checks pass');
  await expect(page.getByTestId('review-param').filter({ hasText: 'attack' })).toContainText('0.02');
  await expect(page.getByTestId('review-number').filter({ hasText: 'click' })).toHaveAttribute('data-glyph', 'pass');
  await expect(page.getByTestId('review-note')).toContainText('changed coin');
  await expect(page.getByTestId('review-gain')).toContainText('Levels matched');
  // A/B: both sides start together; Tab switches which is heard, in time
  await page.getByTestId('review-play').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { soundclaw: { ab: { side: string } | null } }).soundclaw.ab?.side)).toBe('B');
  await page.waitForFunction(() => ((window as unknown as { soundclaw: { ctx: AudioContext | null } }).soundclaw.ctx?.currentTime ?? 0) > 0.15);
  await page.keyboard.press('Tab');
  await expect.poll(() => page.evaluate(() => { const s = (window as unknown as { soundclaw: { ab: { side: string } | null; error: string | null } }).soundclaw; return s.ab?.side ?? `none (${s.error})`; })).toBe('A');
  await page.screenshot({ path: '/tmp/review-coin.png' });
  // approve: one human batch, the review closes, Undo for ten seconds, focus goes back
  await page.keyboard.press('Meta+Enter');
  await expect(page).toHaveURL(/#\/session$/);
  expect(await humanGroups(page)).toContainEqual(['sound mark coin approved']);
  await expect(page.getByTestId('undo-bar')).toContainText('you approved coin · request r1 closed');
  await expect(page.getByTestId('lane-count-review')).toHaveText('2');
  await expect.poll(() => page.evaluate(() => document.activeElement?.id === 'page' || !!document.activeElement?.closest('#page'))).toBe(true);
  await page.getByTestId('undo-decision').click();
  await expect(page.getByTestId('lane-count-review')).toHaveText('3');
  await expect(page.getByTestId('undo-bar')).toHaveCount(0);
  expect((await tapeOf(page)).at(-1)!.cmd).toMatch(/^undo group=/);

  // ---- ask again on zap: a new request linked to the first
  await page.getByTestId('lane-review-r2').click();
  await expect(page.getByTestId('review-param').filter({ hasText: 'decay' })).toContainText('0.3');
  await page.getByTestId('review-ask-again').click();
  await expect(page.getByTestId('review-again-note')).toBeFocused();
  await page.getByTestId('review-again-note').fill('brighter yes, but a touch shorter');
  await page.getByTestId('review-again-note').press('Meta+Enter');
  await expect(page).toHaveURL(/#\/session$/);
  await expect(page.getByTestId('undo-bar')).toContainText('you asked again on zap');
  const list = await agent.cli(['request', agent.dir]);
  expect(list.out).toMatch(/r4 change zap: "brighter yes, but a touch shorter" \(asks again about r2\)/);
  expect(await humanGroups(page)).toContainEqual([expect.stringMatching(/^sound mark zap rejected "brighter yes, but a touch shorter"$/) as unknown as string]);
  await expect(page.getByTestId('lane-count-review')).toHaveText('2');
  await page.getByTestId('undo-decision').click();
  await expect(page.getByTestId('lane-count-review')).toHaveText('3');
  expect((await agent.cli(['request', agent.dir])).out).not.toContain('r4 change zap');

  // ---- revert pop: one human batch that restores the parameters from before
  await page.getByTestId('lane-review-r3').click();
  await page.getByTestId('review-revert').click();
  await expect(page).toHaveURL(/#\/session$/);
  const groups = await humanGroups(page);
  expect(groups.at(-1)).toEqual(['sound set pop decay=0.3 freq=0.5']);
  await expect(page.getByTestId('undo-bar')).toContainText('you reverted pop to before request r3');
  await expect(page.getByTestId('lane-count-review')).toHaveText('2');
  await page.getByTestId('undo-decision').click();
  await expect(page.getByTestId('lane-count-review')).toHaveText('3');
  // the same undo as ⌘Z, within the window
  await page.getByTestId('lane-review-r3').click();
  await page.getByTestId('review-revert').click();
  await expect(page.getByTestId('undo-bar')).toBeVisible();
  await page.keyboard.press('Meta+z');
  await expect(page.getByTestId('lane-count-review')).toHaveText('3');
});

test('the update chip: it appears while you edit the sound the agent changes, keeps your version, and does not appear when you are idle', async ({ page }) => {
  await open(page, '#/sound/laser');
  const decay = page.getByTestId('slot-decay').getByRole('slider');
  const before = await decay.getAttribute('aria-valuenow');
  // idle: the agent's change shows at once and there is no chip
  expect((await agentRun('sound set laser decay=0.1')).code).toBe(0);
  await expect(decay).not.toHaveAttribute('aria-valuenow', before!);
  await expect(page.getByTestId('update-chip')).toHaveCount(0);
  const idle = await decay.getAttribute('aria-valuenow');
  // editing: a change of yours in the last minute makes the next agent change wait
  await page.getByTestId('slot-freq').getByRole('slider').focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await tapeOf(page)).some((r) => r.by === 'human:ana' && r.cmd.startsWith('sound set laser freq='))).toBe(true);
  expect((await agentRun('sound set laser decay=0.45')).code).toBe(0);
  await expect(page.getByTestId('update-chip')).toBeVisible();
  await expect(page.getByTestId('update-chip')).toContainText('agent update waiting');
  await expect(page.getByTestId('update-chip')).toContainText('review');
  await expect(decay).toHaveAttribute('aria-valuenow', idle!);
  // your next edit lands on your version, and the update keeps waiting
  await page.getByTestId('slot-freq').getByRole('slider').focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await tapeOf(page)).filter((r) => r.by === 'human:ana' && r.cmd.startsWith('sound set laser freq=')).length).toBe(2);
  await expect(page.getByTestId('update-chip')).toBeVisible();
  await expect(decay).toHaveAttribute('aria-valuenow', idle!);
  // taking it shows the agent's version
  await page.getByTestId('update-take').click();
  await expect(page.getByTestId('update-chip')).toHaveCount(0);
  await expect(decay).not.toHaveAttribute('aria-valuenow', idle!);
  // the chip opens the review of what the agent did
  await page.getByTestId('slot-freq').getByRole('slider').focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await tapeOf(page)).filter((r) => r.by === 'human:ana' && r.cmd.startsWith('sound set laser freq=')).length).toBe(3);
  await agentRun('sound set laser decay=0.2');
  await page.screenshot({ path: '/tmp/update-chip.png' });
  await page.getByTestId('update-chip').click();
  await expect(page).toHaveURL(/#\/review\/g\d+$/);
  await expect(page.getByTestId('review-param').filter({ hasText: 'decay' })).toBeVisible();
  await page.screenshot({ path: '/tmp/review-group.png' });
});

test('nothing moves under you across a burst of agent commands: scroll, selection and a lens region stay', async ({ page }) => {
  const many = Array.from({ length: 80 }, (_, i) => `sound new s${String(i).padStart(2, '0')}`).join('; ');
  await open(page, '#/', [many, LASER]);
  const list = page.locator('.lib-list .vlist').first();
  // the list is drawn (newest first: s00 is far down, which is the point of scrolling)
  await expect(page.locator('.lib-row').nth(12)).toBeVisible();
  await list.evaluate((e) => { e.scrollTop = 300; });
  const rowId = await page.locator('.lib-row').nth(12).getAttribute('data-testid');
  await page.getByTestId(rowId!).click();
  const top = await list.evaluate((e) => e.scrollTop);
  await list.evaluate((e) => { (e as unknown as { __mark: number }).__mark = 1; });
  const burst = Array.from({ length: 12 }, (_, i) => `sound set s${String(i * 5).padStart(2, '0')} frequency=${300 + i * 20}`).join('\n');
  expect((await agentRun(burst)).code).toBe(0);
  await expect(page.getByTestId('feed')).toContainText('frequency=520');
  expect(await list.evaluate((e) => `${(e as unknown as { __mark?: number }).__mark} ${e.scrollTop} ${e.scrollHeight}`)).toMatch(new RegExp(`^1 ${top} `));
  await expect(page.getByTestId(rowId!)).toHaveClass(/sel/);
  // a region on the lens of laser, then the agent writes: the region stays
  await page.goto(`${agent.url}&name=ana#/sound/laser`);
  const box = (await page.getByTestId('lens-surface').boundingBox())!;
  await drag(page, { x: box.x + box.width * 0.3, y: box.y + box.height * 0.5 }, { x: box.x + box.width * 0.6, y: box.y + box.height * 0.5 });
  const sel = await page.getByTestId('lens-readout').getAttribute('data-sel');
  expect(sel).toMatch(/^0\.\d+,0\.\d+$/);
  await agentRun(Array.from({ length: 8 }, (_, i) => `sound set laser decay=${0.2 + i * 0.01}`).join('\n'));
  await expect(page.getByTestId('feed')).toContainText('decay=0.27');
  await expect(page.getByTestId('lens-readout')).toHaveAttribute('data-sel', sel!);
});
