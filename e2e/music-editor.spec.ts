// The music editor in a browser: notes added, moved and lengthened in the piano roll (one history entry
// each), drum hits painted in the grid, a section dragged to a new place, the loop region dragged on the
// ruler, a helper previewed then applied, undo from the page, the cursor following playback, `changes`
// after a person's edit, song feedback reaching `await`, and the time from an edit to sound in a 35 s
// six-channel song.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

const SHOTS = join(import.meta.dirname, '..', '.dev', 'screens');

// 240 bpm, two steps a beat: a pattern of eight steps lasts one second
const SETUP = `song new demo tempo=240 key=C:major
song channel add demo lead inst=pulse_lead
song channel add demo pad inst=saw_pad gain=0.5
song channel add demo bass inst=triangle_bass
song channel add demo drums kit=default
pattern demo.verse steps=8 tpb=2 bar=4
  lead: C5 . E5 . | G5 - E5 .
  bass: C3 . . . | G2 . . .
  drums: k . h . | s . h h
pattern demo.chorus steps=8 tpb=2 bar=4
  lead: A4 . C5 . | E5 - C5 .
  bass: A2 . . . | E2 . . .
  drums: k . h . | s . h h
song section add demo A verse
song section add demo B chorus
song section add demo C verse
song loop demo A..B
`;

type Row = { seq: number; by: string; group: string; text: string; undone: boolean };
const tape = (page: Page): Promise<Row[]> => page.locator('[data-testid=cmd-row]').evaluateAll((rows) => rows.map((r) => {
  const e = r as HTMLElement;
  return { seq: Number(e.dataset.seq), by: e.dataset.by!, group: e.dataset.group!, text: r.querySelector('code')!.textContent!, undone: r.classList.contains('undone') };
}).sort((a, b) => a.seq - b.seq));
const humanGroups = async (page: Page): Promise<string[][]> => {
  const rows = (await tape(page)).filter((r) => r.by === 'human:ana');
  const groups = new Map<string, string[]>();
  for (const r of rows) groups.set(r.group, [...(groups.get(r.group) ?? []), r.text]);
  return [...groups.values()];
};

async function open(page: Page, setup = SETUP, song = 'demo'): Promise<void> {
  agent = await startAgent();
  const r = await agent.cli(['run', agent.dir, '-e', setup]);
  expect(r.code, r.err).toBe(0);
  await page.goto(`${agent.url}&name=ana#/song/${song}`);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
  await expect(page.getByTestId('song-editor')).toBeVisible();
}

/** The page point of a step and pitch in a channel's roll. */
async function rollAt(page: Page, ch: string, step: number, midi: number, dx = 0.5): Promise<{ x: number; y: number }> {
  const svg = page.getByTestId(`roll-grid-${ch}`);
  await svg.scrollIntoViewIfNeeded();
  const box = (await svg.boundingBox())!;
  const W = Number(await svg.getAttribute('width')), H = Number(await svg.getAttribute('height'));
  const hi = Number(await svg.getAttribute('data-hi'));
  return { x: box.x + ((44 + (step + dx) * 26) / W) * box.width, y: box.y + (((hi - midi) * 11 + 5.5) / H) * box.height };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let k = 1; k <= 6; k++) await page.mouse.move(from.x + ((to.x - from.x) * k) / 6, from.y + ((to.y - from.y) * k) / 6);
  await page.mouse.up();
}

test('the piano roll: add, move and lengthen a note, one history entry each; fx from the menu; delete; undo from the page', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('roll-lead')).toHaveAttribute('data-notes', '4');
  // click an empty step: D5 (74) at step 1
  const p = await rollAt(page, 'lead', 1, 74);
  await page.mouse.click(p.x, p.y);
  await expect(page.getByTestId('note-lead-1-D5')).toBeVisible();
  expect(await humanGroups(page)).toEqual([['pattern note add demo.verse lead 1 D5']]);
  // drag it two steps right and three semitones up
  await drag(page, await rollAt(page, 'lead', 1, 74, 0.3), await rollAt(page, 'lead', 3, 77, 0.3));
  await expect(page.getByTestId('note-lead-3-F5')).toBeVisible();
  await expect(page.getByTestId('note-lead-1-D5')).toHaveCount(0);
  expect((await humanGroups(page)).at(-1)).toEqual(['pattern note move demo.verse lead 1 step=3 note=F5']);
  // drag the last note's right edge one step on
  await drag(page, await rollAt(page, 'lead', 6, 76, 0.9), await rollAt(page, 'lead', 7, 76, 0.9));
  await expect(page.getByTestId('note-lead-6-E5')).toHaveAttribute('data-len', '2');
  expect((await humanGroups(page)).at(-1)).toEqual(['pattern note len demo.verse lead 6 2']);
  expect(await humanGroups(page)).toHaveLength(3);
  await expect(page.getByTestId('cell-lead-7')).toHaveClass(/hold/);
  // the selected note gets a slide from the small menu
  await page.getByTestId('note-lead-6-E5').click({ button: 'right' });
  await page.getByTestId('roll-fx-slide').click();
  await expect(page.getByTestId('note-lead-6-E5')).toHaveAttribute('data-fx', 'slide');
  expect((await humanGroups(page)).at(-1)).toEqual(['pattern note set demo.verse lead 6 fx=~slide']);
  // velocity: a drag across the lane over steps 0 and 2 is one entry
  const lane = page.getByTestId('vel-lane-lead');
  await lane.scrollIntoViewIfNeeded();
  const lb = (await lane.boundingBox())!;
  const W = Number(await lane.getAttribute('width'));
  const lx = (s: number) => lb.x + ((44 + s * 26 + 6) / W) * lb.width;
  await drag(page, { x: lx(0), y: lb.y + lb.height * 0.5 }, { x: lx(2), y: lb.y + lb.height * 0.5 });
  await expect.poll(async () => (await humanGroups(page)).at(-1)!.length).toBe(2);
  const vel = (await humanGroups(page)).at(-1)!;
  expect(vel[0]).toMatch(/^pattern note set demo\.verse lead 0 vel=\d+$/);
  expect(vel[1]).toMatch(/^pattern note set demo\.verse lead 2 vel=\d+$/);
  // shift-drag selects two notes, Delete removes them in one entry
  await page.keyboard.down('Shift');
  await drag(page, await rollAt(page, 'lead', 3, 79, 0.1), await rollAt(page, 'lead', 4, 76, 0.9));
  await page.keyboard.up('Shift');
  await expect(page.getByTestId('roll-lead')).toHaveAttribute('data-selected', '2');
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('note-lead-3-F5')).toHaveCount(0);
  expect((await humanGroups(page)).at(-1)).toEqual(['pattern note remove demo.verse lead 4', 'pattern note remove demo.verse lead 3']);
  // Undo on the page brings them back, as one step
  await page.getByTestId('editor-undo').click();
  await expect(page.getByTestId('note-lead-3-F5')).toBeVisible();
  await expect(page.getByTestId('note-lead-4-G5')).toBeVisible();
  const last = (await tape(page)).at(-1)!;
  expect(last.text).toMatch(/^undo /);
  await page.locator('.roll-panel').screenshot({ path: join(SHOTS, 'music-roll.png') });

  // what the person did, as the agent sees it
  const ch = await agent.cli(['changes', agent.dir, '--by', 'human']);
  expect(ch.code).toBe(0);
  expect(ch.out).toContain('song demo (edited):');
  expect(ch.out).toContain('verse.lead: + D5 at 1');
  expect(ch.out).toContain('verse.lead: − D5 at 1; + F5 at 3');
  expect(ch.out).toMatch(/notes before\/after \(red went, green came\): \S+\.png/);
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, 'changes-after-human-edit.txt'), ch.out);
});

test('the grid: a drum hit painted by a click, and a drag that paints several hits as one entry', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('hit-drums-k-1')).toHaveAttribute('data-on', 'false');
  await page.getByTestId('hit-drums-k-1').click();
  await expect(page.getByTestId('hit-drums-k-1')).toHaveAttribute('data-on', 'true');
  expect(await humanGroups(page)).toEqual([['pattern note add demo.verse drums 1 k']]);
  const a = (await page.getByTestId('hit-drums-oh-3').boundingBox())!, b = (await page.getByTestId('hit-drums-oh-5').boundingBox())!;
  await drag(page, { x: a.x + a.width / 2, y: a.y + a.height / 2 }, { x: b.x + b.width / 2, y: b.y + b.height / 2 });
  await expect(page.getByTestId('hit-drums-oh-5')).toHaveAttribute('data-on', 'true');
  expect((await humanGroups(page)).at(-1)).toEqual(['pattern note add demo.verse drums 3 oh', 'pattern note add demo.verse drums 4 oh', 'pattern note add demo.verse drums 5 oh']);
  // a click on a hit removes it
  await page.getByTestId('hit-drums-k-1').click();
  await expect(page.getByTestId('hit-drums-k-1')).toHaveAttribute('data-on', 'false');
  expect((await humanGroups(page)).at(-1)).toEqual(['pattern note remove demo.verse drums 1 k']);
  await page.getByTestId('pattern-grid').screenshot({ path: join(SHOTS, 'music-grid.png') });
});

test('the song order: a section dragged to a new place, repeats, and the loop region dragged on the ruler', async ({ page }) => {
  await open(page);
  const A = (await page.getByTestId('block-A').boundingBox())!, B = (await page.getByTestId('block-B').boundingBox())!;
  await drag(page, { x: B.x + 12, y: B.y + 8 }, { x: A.x + 4, y: B.y + 8 });
  // the loop A..B would now run backwards: it keeps its ends, swapped, in the same entry
  await expect.poll(async () => (await humanGroups(page)).at(-1)).toEqual(['song order demo B A C', 'song loop demo B..A']);
  await expect(page.getByTestId('loop-band')).toHaveAttribute('data-from', 'B');
  // the loop's end handle dragged to the end of C
  const to = (await page.getByTestId('loop-to').boundingBox())!, C = (await page.getByTestId('block-C').boundingBox())!;
  await drag(page, { x: to.x + to.width / 2, y: to.y + to.height / 2 }, { x: C.x + C.width - 2, y: to.y + to.height / 2 });
  await expect(page.getByTestId('loop-band')).toHaveAttribute('data-to', 'C');
  expect((await humanGroups(page)).at(-1)).toEqual(['song loop demo B..C']);
  // its start handle to the start of A (A now plays second)
  const from = (await page.getByTestId('loop-from').boundingBox())!, A2 = (await page.getByTestId('block-A').boundingBox())!;
  await drag(page, { x: from.x + from.width / 2, y: from.y + from.height / 2 }, { x: A2.x + 2, y: from.y + from.height / 2 });
  await expect(page.getByTestId('loop-band')).toHaveAttribute('data-from', 'A');
  expect((await humanGroups(page)).at(-1)).toEqual(['song loop demo A..C']);
  // the band dragged as a whole one section left keeps its length
  const band = (await page.getByTestId('loop-band').boundingBox())!;
  await drag(page, { x: band.x + band.width / 2, y: band.y + band.height / 2 }, { x: band.x + band.width / 2 - (A.width + 2), y: band.y + band.height / 2 });
  await expect(page.getByTestId('loop-band')).toHaveAttribute('data-to', 'A');
  expect((await humanGroups(page)).at(-1)).toEqual(['song loop demo B..A']);
  await page.getByTestId('block-more-C').click();
  await expect(page.getByTestId('block-repeat-C')).toHaveText('x2');
  expect((await humanGroups(page)).at(-1)).toEqual(['song section set demo C verse x2']);
  // settings
  await page.getByTestId('set-tempo').fill('200');
  await page.getByTestId('set-tempo').press('Enter');
  await expect.poll(async () => (await humanGroups(page)).at(-1)).toEqual(['song set demo tempo=200']);
  await page.getByTestId('song-order').screenshot({ path: join(SHOTS, 'music-song-order.png') });
});

test('a helper: the rows it would write shown first, then applied as the same command', async ({ page }) => {
  await open(page);
  await page.getByTestId('grid-row-pad').click();
  await page.getByTestId('helper-chords').click();
  await page.getByTestId('helper-prog').fill('I IV');
  await page.getByTestId('helper-bars').fill('0.5');
  await page.getByTestId('helper-rhythm').selectOption('hold');
  await page.getByTestId('helper-preview').click();
  await expect(page.getByTestId('helper-command')).toHaveText('chords demo verse pad "I IV" bars=0.5 rhythm=hold');
  await expect(page.getByTestId('helper-after-verse')).toContainText('pad:');
  expect(await humanGroups(page)).toEqual([]); // nothing written yet
  await page.getByTestId('helper-cancel').click();
  await expect(page.getByTestId('helper-preview-box')).toHaveCount(0);
  await page.getByTestId('helper-preview').click();
  const after = (await page.getByTestId('helper-after-verse').textContent())!;
  await page.getByTestId('helper-apply').click();
  await expect.poll(async () => (await humanGroups(page)).length).toBe(1);
  const g = (await humanGroups(page))[0]!;
  expect(g[0]).toMatch(/^chords demo verse pad "I IV" bars=0\.5 rhythm=hold .*written=/);
  // the pad now plays what the preview showed
  const padRow = after.split('\n').find((l) => l.trim().startsWith('pad:'))!.trim();
  const shown = await page.locator('[data-testid=grid-row-pad] td').evaluateAll((tds) => tds.map((t) => t.textContent));
  expect(shown[0]).toBe(padRow.split(/\s+/)[1]!.replace(/~.*$/, '~'));
  await page.getByTestId('chan-edit-lead').or(page.getByTestId('chan-copy-lead')).first().click();
  await expect(page.getByTestId('inst-editor-demo_lead')).toBeVisible();
  expect((await humanGroups(page)).at(-1)).toEqual(['instrument new demo_lead from=pulse_lead seed=1', 'song channel set demo lead inst=demo_lead']);
  await page.getByTestId('inst-pitch-check-demo_lead').selectOption('class');
  await expect.poll(async () => (await humanGroups(page)).at(-1)).toEqual(['instrument set demo_lead pitch-check=class']);
  // the voice, with the sound editor's controls, written as the instrument's own commands
  await page.getByTestId('ctl-L-1-wave').selectOption('saw');
  await expect.poll(async () => (await humanGroups(page)).at(-1)).toEqual(['instrument layer set demo_lead 1 wave=saw']);
  await expect(page.getByTestId('inst-summary-demo_lead')).toContainText('pitch check class');
  await page.getByTestId('instrument-panel').screenshot({ path: join(SHOTS, 'music-instruments.png') });
  await page.getByTestId('helper-panel').screenshot({ path: join(SHOTS, 'music-helper.png') });
});

test('playback: the cursor follows across grid, roll and song order; from the cursor; the selection repeating', async ({ page }) => {
  await open(page);
  await page.getByTestId('play-song').click();
  await expect(page.getByTestId('song-editor')).toHaveAttribute('data-playing', 'true', { timeout: 20_000 });
  const steps = new Set<string>(), pats = new Set<string>(), ts: number[] = [];
  await expect.poll(async () => {
    const e = page.getByTestId('song-editor');
    const s = await e.getAttribute('data-step'), p = await e.getAttribute('data-pattern'), t = await e.getAttribute('data-now');
    if (s) steps.add(s);
    if (p) pats.add(p);
    if (t) ts.push(Number(t));
    return steps.size >= 5 && pats.size >= 2;
  }, { timeout: 8000, intervals: [40] }).toBe(true);
  expect(ts.at(-1)!).toBeGreaterThan(ts[0]!);
  await expect(page.getByTestId('order-cursor')).toBeVisible();
  await page.getByTestId('stop-song').click();
  // the cursor: a click on a step of the grid; play from there
  await page.getByTestId('grid-head-4').click();
  await expect(page.getByTestId('cursor-readout')).toContainText('verse step 4');
  await expect(page.getByTestId('roll-cursor')).toBeVisible();
  await page.getByTestId('play-cursor').click();
  await expect(page.getByTestId('song-editor')).toHaveAttribute('data-playing', 'true', { timeout: 20_000 });
  const played = await page.evaluate(() => (window as unknown as { soundclaw: { songsPlayed: { from?: number }[] } }).soundclaw.songsPlayed.at(-1));
  expect(played!.from).toBeCloseTo(0.5, 6);
  await page.getByTestId('stop-song').click();
  // two notes selected, repeating
  await page.getByTestId('note-lead-2-E5').click();
  await page.getByTestId('note-lead-4-G5').click({ modifiers: ['Shift'] });
  await page.getByTestId('play-selection').click();
  await expect(page.getByTestId('song-editor')).toHaveAttribute('data-playing', 'true', { timeout: 20_000 });
  const sel = await page.evaluate(() => (window as unknown as { soundclaw: { songsPlayed: { region?: { start: number; end: number } }[] } }).soundclaw.songsPlayed.at(-1));
  expect(sel!.region!.start).toBeCloseTo(0.25, 6);
  expect(sel!.region!.end).toBeCloseTo(0.75, 6);
  // it repeats: the clock comes back round inside the region
  const seen: number[] = [];
  await expect.poll(async () => { const t = await page.getByTestId('song-editor').getAttribute('data-now'); if (t) seen.push(Number(t)); return seen.length > 3 && seen.some((t, i) => i > 0 && t < seen[i - 1]!); }, { timeout: 6000, intervals: [60] }).toBe(true);
  for (const t of seen) { expect(t).toBeGreaterThanOrEqual(0.25 - 1e-6); expect(t).toBeLessThan(0.75 + 1e-6); }
  await page.getByTestId('stop-song').click();
});

test('song feedback tags reach the agent through await', async ({ page }) => {
  await open(page);
  await page.goto(`${agent.url}&name=ana#/`);
  await expect(page.getByTestId('song-demo')).toBeVisible();
  const wait = agent.background(['await', agent.dir, '--timeout', '30']);
  await page.getByTestId('song-feedback-demo').click();
  await page.getByTestId('tag-demo-too-busy').click();
  await page.getByTestId('tag-demo-wrong-mood').click();
  await page.getByTestId('feedback-text-demo').fill('the chorus drums crowd the lead');
  await page.getByTestId('feedback-send-demo').click();
  await expect(page.getByTestId('feedback-sent-demo')).toBeVisible();
  const done = await wait.done;
  expect(done.code).toBe(0);
  expect(done.out).toContain('demo');
  expect(done.out).toContain('too busy, wrong mood');
  expect(done.out).toContain('the chorus drums crowd the lead');
  await expect(page.getByTestId('song-demo')).toHaveAttribute('data-status', 'rejected');
});

// a 35 s song in six channels: lead, pad, bass, arp, bell, drums
const BIG = `song new big tempo=110 key=A:minor
song channel add big lead inst=square_lead
song channel add big pad inst=saw_pad gain=0.5
song channel add big bass inst=triangle_bass
song channel add big arp inst=pluck gain=0.6
song channel add big bell inst=fm_bell gain=0.4
song channel add big drums kit=default
pattern big.a steps=32 tpb=4 bar=8
  lead: A4 . C5 . E5 - . D5 | C5 . B4 . A4 - - . | A4 . C5 . E5 - . G5 | A5 - - . G5 . E5 .
  pad: A3+C4+E4 - - - - - - - | - - - - - - - - | F3+A3+C4 - - - - - - - | G3+B3+D4 - - - - - - -
  bass: A2 . A2 . E2 . A2 . | A2 . A2 . E2 . G2 . | F2 . F2 . C3 . F2 . | G2 . G2 . D3 . G2 .
  arp: A4 C5 E5 C5 A4 C5 E5 C5 | A4 C5 E5 C5 A4 C5 E5 C5 | F4 A4 C5 A4 F4 A4 C5 A4 | G4 B4 D5 B4 G4 B4 D5 B4
  bell: . . . . . . . . | E6 . . . . . . . | . . . . . . . . | D6 . . . . . . .
  drums: k . h . s . h . | k . h k s . h h | k . h . s . h . | k . h k s . h oh
song section add big A a x8
`;

test('one note change in a 35 s six-channel song: only that channel renders again, and the time to sound', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page, BIG, 'big');
  await page.getByTestId('play-song').click();
  await expect(page.getByTestId('song-editor')).toHaveAttribute('data-playing', 'true', { timeout: 60_000 });
  const first = Number(await page.getByTestId('render-stats').getAttribute('data-ms'));
  // move the first lead note up a tone while it plays
  await drag(page, await rollAt(page, 'lead', 0, 69, 0.3), await rollAt(page, 'lead', 0, 71, 0.3));
  await expect(page.getByTestId('note-lead-0-B4')).toBeVisible();
  await expect(page.getByTestId('render-stats')).toHaveAttribute('data-cached', '5', { timeout: 20_000 });
  await expect(page.getByTestId('render-stats')).not.toHaveAttribute('data-edit-ms', '');
  const ms = Number(await page.getByTestId('render-stats').getAttribute('data-ms'));
  const edit = Number(await page.getByTestId('render-stats').getAttribute('data-edit-ms'));
  // the page's render equals the CLI's
  const played = await page.evaluate(() => (window as unknown as { soundclaw: { songsPlayed: { hash: string }[] } }).soundclaw.songsPlayed.at(-1)!.hash);
  const cli = JSON.parse((await agent.cli(['render', agent.dir, 'big', '--json'])).out) as { hashes: { full: string }; length?: number };
  expect(played).toBe(cli.hashes.full);
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, 'edit-timing.json'), JSON.stringify({ song: '35 s, six channels', firstRenderMs: first, noteChangeRenderMs: ms, editToSoundMs: edit }, null, 2) + '\n');
  console.log(`first render ${first} ms; after one note change: render ${ms} ms, edit to sound ${edit} ms`);
  expect(ms).toBeLessThan(first);
  await page.getByTestId('stop-song').click();
  await page.screenshot({ path: join(SHOTS, 'music-editor.png'), fullPage: true });
  await page.getByTestId('pattern-grid').screenshot({ path: join(SHOTS, 'music-grid-six-channels.png') });
  await page.locator('.roll-panel').screenshot({ path: join(SHOTS, 'music-roll-six-channels.png') });
});
