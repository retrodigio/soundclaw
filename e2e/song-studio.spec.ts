// The song page and the mixer: the arrangement (flags, the agent's tint, the loop handles, bars picked on
// the ruler), the piano roll beside the pattern text kept in sync both ways, the mixer's faders and knobs
// (one command for each drag), the meters moving while a song plays without React drawing at meter rate,
// and the masking link that solos two strips.

import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { test } from './fixtures.ts';
import { settledDrag } from './drag.ts';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

const SHOTS = join(import.meta.dirname, '..', '.dev', 'screens');

// 120 bpm, 16 steps at four a beat: a pattern is one bar of two seconds. Bars 3 and 4 have the lead and an arp holding notes in the same band.
const BASE = `song new mix tempo=120 key=C:major
song channel add mix bass inst=triangle_bass layer=base
song channel add mix lead inst=pulse_lead layer=tension
song channel add mix arp inst=pulse_lead layer=tension
song channel add mix choir inst=saw_pad layer=boss gain=0.6
song send mix reverb size=0.6
song channel set mix lead reverb=0.2
pattern mix.a steps=16 tpb=4 bar=8
  bass: C3 . . . C3 . . . | G2 . . . G2 . . .
  lead: C5 . E5 . G5 . E5 . | C5 . E5 . G5 . E5 .
  choir: C4+E4+G4 - - - - - - - | - - - - - - - -
pattern mix.b steps=16 tpb=4 bar=8
  lead: E5 - - - - - - - | G5 - - - - - - -
song section add mix A a x2
song section add mix B b x2
`;
// the agent adds an arp under the lead
const AGENT = `pattern mix.b steps=16 tpb=4 bar=8
  lead: E5 - - - - - - - | G5 - - - - - - -
  arp: C5 - - - - - - - | E5 - - - - - - -
`;

type Row = { seq: number; by: string; group: string; text: string };
/** The tape rows in the History tab (the fixtures leave it open). */
const tape = (page: Page): Promise<Row[]> => page.locator('[data-testid=cmd-row]').evaluateAll((rows) => rows.map((r) => {
  const e = r as HTMLElement;
  return { seq: Number(e.dataset.seq), by: e.dataset.by!, group: e.dataset.group!, text: r.querySelector('code')!.textContent! };
}).sort((a, b) => a.seq - b.seq));
const humanGroups = async (page: Page): Promise<string[][]> => {
  const groups = new Map<string, string[]>();
  for (const r of (await tape(page)).filter((x) => x.by === 'human:ana')) groups.set(r.group, [...(groups.get(r.group) ?? []), r.text]);
  return [...groups.values()];
};

async function open(page: Page, hash = '#/song/mix', o: { agent?: boolean } = {}): Promise<void> {
  agent = await startAgent();
  let r = await agent.cli(['run', agent.dir, '-e', BASE, '--by', 'human:ana']);
  expect(r.code, r.err).toBe(0);
  if (o.agent !== false) {
    r = await agent.cli(['run', agent.dir, '-e', AGENT]);
    expect(r.code, r.err).toBe(0);
  }
  await page.goto(`${agent.url}&name=ana${hash}`);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
  await expect(page.getByTestId('song-editor')).toBeVisible();
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let k = 1; k <= 6; k++) await page.mouse.move(from.x + ((to.x - from.x) * k) / 6, from.y + ((to.y - from.y) * k) / 6);
  await page.mouse.up();
}
const centre = async (page: Page, id: string): Promise<{ x: number; y: number }> => { const b = (await page.getByTestId(id).boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };

test('the arrangement: the agent’s clips are violet and dashed, the masking flag is a dashed amber box on both lanes, the loop has handles and a seam badge', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page);
  // one clip for each placement: the arp only plays in B (placements 2 and 3), the lead in all four
  await expect(page.getByTestId('clip-lead-0')).toBeVisible();
  await expect(page.locator('[data-testid^=clip-lead-]')).toHaveCount(4);
  await expect(page.locator('[data-testid^=clip-arp-]')).toHaveCount(2);
  // the arp was written by the agent and nobody approved it: tinted; the lead was written by a person
  await expect(page.getByTestId('clip-arp-2')).toHaveAttribute('data-agent', 'true');
  await expect(page.getByTestId('clip-lead-2')).toHaveAttribute('data-agent', 'false');
  const style = await page.getByTestId('clip-arp-2').evaluate((e) => { const c = getComputedStyle(e); return { border: c.borderTopStyle, colour: c.borderTopColor, bg: c.backgroundColor }; });
  const human = await page.getByTestId('clip-lead-2').evaluate((e) => getComputedStyle(e).borderTopStyle);
  expect(style.border).toBe('dashed');
  expect(human).toBe('solid');
  const agentColour = await page.evaluate(() => { const p = document.createElement('i'); p.style.color = 'var(--agent)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; });
  expect(style.colour).toBe(agentColour);
  // the sections are markers, the loop (the whole body) has handles and a seam badge
  await expect(page.getByTestId('marker-A')).toContainText('×2');
  await expect(page.getByTestId('loop-from')).toBeVisible();
  await expect(page.getByTestId('loop-to')).toBeVisible();
  await expect(page.getByTestId('seam-badge')).toBeVisible({ timeout: 40_000 });
  // the layers are groups of tracks, with their stems
  await expect(page.getByTestId('track-lead')).toHaveAttribute('data-layer', 'tension');
  await expect(page.getByTestId('track-choir')).toHaveAttribute('data-layer', 'boss');
  await expect(page.getByTestId('track-sends')).toContainText('reverb');
  // the masking check names the lead and the arp in the second half: a dashed amber box on both lanes, labelled
  const label = page.locator('[data-testid^=flag-label-masking-]').first();
  await expect(label).toBeVisible({ timeout: 40_000 });
  await expect(label).toContainText('masking');
  await expect(label).toHaveText(/bars? \d/);
  for (const lane of ['lead', 'arp']) {
    const box = page.locator(`[data-testid^=flag-masking-][data-testid$=-${lane}]`).first();
    await expect(box).toBeVisible();
    expect(await box.evaluate((e) => getComputedStyle(e).borderTopStyle)).toBe('dashed');
  }
  const fb = (await page.locator('[data-testid^=flag-masking-][data-testid$=-arp]').first().boundingBox())!;
  const lane = (await page.getByTestId('track-arp').locator('.arr-lane').boundingBox())!;
  // the arp plays in the second half of the 8 s song, and so does the stretch
  expect((fb.x - lane.x) / lane.width).toBeGreaterThan(0.4);
  expect(fb.x + fb.width).toBeLessThanOrEqual(lane.x + lane.width + 1);
  await expect(page.getByTestId('arr-checks')).toBeVisible();
  // the intensity selector lists the layers
  await expect(page.getByTestId('intensity').locator('button')).toHaveText(['base', '+ tension', '+ boss']);
  // approving the song takes the tint away
  await page.getByTestId('inspector-toggle').click();
  await page.getByTestId('insp-tab-changes').click();
  await expect(page.getByTestId('changes-pending')).toContainText('b');
  await page.getByTestId('approve-song').click();
  await expect(page.getByTestId('clip-arp-2')).toHaveAttribute('data-agent', 'false');
  expect((await humanGroups(page)).at(-1)).toEqual(['song mark mix approved']);
  await page.getByTestId('arrangement').screenshot({ path: join(SHOTS, 'song-arrangement.png') });
});

test('bars picked on the ruler pin a request to them and the selected channel', async ({ page }) => {
  await open(page);
  const r = (await page.getByTestId('bar-ruler').boundingBox())!;
  // a quarter of the 8 s song is a bar: drag from bar 2 to bar 3
  await drag(page, { x: r.x + r.width * 0.3, y: r.y + 40 }, { x: r.x + r.width * 0.55, y: r.y + 40 });
  await expect(page.getByTestId('bar-selection')).toHaveAttribute('data-from', '2');
  await expect(page.getByTestId('bar-selection')).toHaveAttribute('data-to', '3');
  await page.getByTestId('track-name-lead').click();
  const wait = agent.background(['await', agent.dir, '--timeout', '30']);
  await page.keyboard.press('r');
  await expect(page.getByTestId('composer-note')).toBeFocused();
  await page.getByTestId('composer-note').fill('the lead is too busy here');
  await page.getByTestId('composer-send').click();
  const done = await wait.done;
  expect(done.code).toBe(0);
  expect(done.out).toContain('the lead is too busy here');
  expect(done.out).toContain('bars 2–3 of lead');
  // play selection loops those bars
  await page.getByTestId('play-selection').click();
  await expect(page.getByTestId('song-editor')).toHaveAttribute('data-playing', 'true', { timeout: 20_000 });
  const sel = await page.evaluate(() => (window as unknown as { soundclaw: { songsPlayed: { region?: { start: number; end: number } }[] } }).soundclaw.songsPlayed.at(-1));
  expect(sel!.region).toEqual({ start: 2, end: 6 });
  await page.getByTestId('stop-song').click();
});

test('a masking flag puts its partner behind the roll as ghost notes', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page);
  await expect(page.getByTestId('ghost-toggle')).not.toBeChecked();
  const label = page.locator('[data-testid^=flag-label-masking-]').first();
  await label.click({ timeout: 40_000 });
  await expect(page.getByTestId('ghost-toggle')).toBeChecked();
  await expect(page.getByTestId('ghost-note')).toContainText('masking partner');
  await expect(page.getByTestId('roll-ghost-note').first()).toBeVisible();
  // the roll shows one of the two channels, the ghost the other
  const roll = await page.locator('[data-testid^=roll-][data-ghost]').first().getAttribute('data-ghost');
  expect(['lead', 'arp']).toContain(roll);
  await page.getByTestId('ghost-toggle').uncheck();
  await expect(page.getByTestId('roll-ghost-note')).toHaveCount(0);
});

test('roll to text: the selected notes light their tokens, and the agent’s rows have the violet border', async ({ page }) => {
  await open(page);
  // the agent wrote the arp row of B, a person the other rows
  await page.getByTestId('tab-b').click();
  await expect(page.locator('[data-testid^=ptx-num-][data-agent]')).toHaveCount(1);
  const arpLine = await page.locator('[data-testid^=ptx-num-][data-agent]').first().getAttribute('data-testid');
  const textB = await page.getByTestId('pattern-text-area').inputValue();
  expect(textB.split('\n')[Number(arpLine!.replace('ptx-num-', '')) - 1]).toContain('arp:');
  const border = await page.locator(`[data-testid=${arpLine}]`).evaluate((e) => getComputedStyle(e).borderLeftColor);
  const violet = await page.evaluate(() => { const p = document.createElement('i'); p.style.color = 'var(--agent)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; });
  expect(border).toBe(violet);
  // select two notes of the lead in A: C5 at step 0, and G5 at step 4
  await page.getByTestId('tab-a').click();
  await page.getByTestId('roll-tab-lead').click();
  await expect(page.getByTestId('roll-lead')).toHaveAttribute('data-notes', '8');
  await expect(page.locator('[data-testid^=ptx-num-][data-agent]')).toHaveCount(0);
  await expect(page.getByTestId('tok-sel')).toHaveCount(0);
  await page.getByTestId('note-lead-0-C5').click();
  await page.getByTestId('note-lead-4-G5').click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('tok-sel')).toHaveText(['C5', 'G5']);
  await expect(page.getByTestId('pattern-text')).toHaveAttribute('data-lit', '2');
  // a single note
  await page.getByTestId('note-lead-2-E5').click();
  await expect(page.getByTestId('tok-sel')).toHaveText(['E5']);
  await page.getByTestId('pattern-text').screenshot({ path: join(SHOTS, 'song-text-highlight.png') });
  // a note added in the roll is in the text at once
  const svg = page.getByTestId('roll-grid-lead');
  const box = (await svg.boundingBox())!;
  const W = Number(await svg.getAttribute('width')), H = Number(await svg.getAttribute('height')), hi = Number(await svg.getAttribute('data-hi'));
  await page.mouse.click(box.x + ((44 + 7.5 * 26) / W) * box.width, box.y + (((hi - 74) * 11 + 5.5) / H) * box.height);
  await expect(page.getByTestId('note-lead-7-D5')).toBeVisible();
  await expect.poll(async () => (await page.getByTestId('pattern-text-area').inputValue()).split('\n').find((l) => l.includes('lead:'))).toMatch(/D5/);
  expect((await humanGroups(page)).at(-1)).toEqual(['pattern note add mix.a lead 7 D5']);
});

test('text to roll: a pause writes one pattern set, a problem is underlined and writes nothing, and the caret stays', async ({ page }) => {
  await open(page);
  await page.getByTestId('tab-a').click();
  await page.getByTestId('roll-tab-lead').click();
  const area = page.getByTestId('pattern-text-area');
  const before = (await humanGroups(page)).length;
  // replace the first lead note: select C5 on the lead row and type D5, one key after another
  const place = async (needle: string, row: string): Promise<number> => area.evaluate((el: HTMLTextAreaElement, [n, r]) => {
    const start = el.value.indexOf(r!);
    const at = start + el.value.slice(start).indexOf(n!);
    el.focus();
    el.setSelectionRange(at, at + n!.length);
    return at;
  }, [needle, row] as [string, string]);
  const at = await place('C5', 'lead:');
  await page.keyboard.type('D5', { delay: 40 });
  await expect(page.getByTestId('pattern-text')).toHaveAttribute('data-status', 'typing');
  expect(await humanGroups(page)).toHaveLength(before); // nothing yet
  await expect(page.getByTestId('note-lead-0-D5')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('note-lead-0-C5')).toHaveCount(0);
  // one pause, one batch: a single pattern set, the very command an agent would write
  const groups = await humanGroups(page);
  expect(groups).toHaveLength(before + 1);
  expect(groups.at(-1)).toHaveLength(1);
  expect(groups.at(-1)![0]).toMatch(/^pattern set mix\.a "pattern a steps=16 tpb=4 bar=8\\n/);
  expect(groups.at(-1)![0]).toMatch(/lead: +D5 /);
  // the roll updated, the caret is where it was (after the two typed characters), and the typed layout was kept
  expect(await area.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([at + 2, at + 2]);
  await expect(page.getByTestId('pattern-text')).toHaveAttribute('data-status', 'sync');
  // more typing goes in at the caret
  await page.keyboard.type('v90', { delay: 30 });
  await expect(page.getByTestId('note-lead-0-D5')).toHaveAttribute('data-vel', '90', { timeout: 5000 });
  expect(await humanGroups(page)).toHaveLength(before + 2);
  // the notes under the caret light up in the roll
  await expect(page.getByTestId('roll-lead')).toHaveAttribute('data-selected', '1');

  // a problem: underlined with its message, and nothing is written
  const count = (await humanGroups(page)).length;
  await place('E5', 'lead:');
  await page.keyboard.type('Q9', { delay: 40 });
  await expect(page.getByTestId('pattern-text')).toHaveAttribute('data-status', 'error', { timeout: 3000 });
  await expect(page.getByTestId('pattern-text-error')).toContainText('not a note');
  await expect(page.getByTestId('tok-err')).toHaveText(/Q9/);
  await page.waitForTimeout(700);
  expect(await humanGroups(page)).toHaveLength(count);
  await expect(page.getByTestId('note-lead-2-E5')).toBeVisible(); // the roll still has the last good pattern
  await page.getByTestId('pattern-text').screenshot({ path: join(SHOTS, 'song-text-error.png') });
  // fixing it writes
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('F5', { delay: 40 });
  await expect(page.getByTestId('note-lead-2-F5')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('pattern-text')).toHaveAttribute('data-status', 'sync');
  expect(await humanGroups(page)).toHaveLength(count + 1);
});

test('an outside change to the pattern replaces the text and keeps the caret on its line and column', async ({ page }) => {
  await open(page, '#/song/mix', { agent: false });
  await page.getByTestId('tab-a').click();
  const area = page.getByTestId('pattern-text-area');
  // the caret in the bass row, a few characters in
  const where = await area.evaluate((el: HTMLTextAreaElement) => {
    const at = el.value.indexOf('bass:') + 9;
    el.focus();
    el.setSelectionRange(at, at);
    return at;
  });
  await agent.cli(['run', agent.dir, '-e', 'pattern note add mix.a bass 1 D3']);
  await expect(page.getByTestId('note-bass-1-D3')).toBeVisible().catch(() => undefined);
  await expect.poll(async () => area.inputValue()).toContain('D3');
  const caret = await area.evaluate((el: HTMLTextAreaElement) => { const before = el.value.slice(0, el.selectionStart); return { line: before.split('\n').length, col: before.length - (before.lastIndexOf('\n') + 1) }; });
  const was = await area.evaluate((el: HTMLTextAreaElement, at) => { const before = el.value.slice(0, at); return { line: before.split('\n').length, col: before.length - (before.lastIndexOf('\n') + 1) }; }, where);
  expect(caret.line).toBe(was.line);
  expect(caret.col).toBe(was.col);
});

test('the mixer: a fader, a pan knob and a send knob each write one command for a drag; double-click resets; the agent’s knob has the tick', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page, '#/song/mix/mixer');
  const mixer = page.getByTestId('page').getByTestId('mixer');
  await expect(mixer).toBeVisible();
  for (const n of ['bass', 'lead', 'arp', 'choir']) await expect(page.getByTestId(`strip-${n}`)).toBeVisible();
  await expect(page.getByTestId('strip-bus-reverb')).toBeVisible();
  await expect(page.getByTestId('strip-master')).toBeVisible();
  // the strip has its instrument and effects as inserts, a pan knob and one send knob for the bus
  await expect(page.getByTestId('inserts-lead')).toContainText('pulse_lead');
  await expect(page.getByTestId('knob-lead-pan')).toBeVisible();
  await expect(page.getByTestId('knob-lead-reverb')).toBeVisible();
  await expect(page.getByTestId('knob-lead-delay')).toHaveCount(0); // there is no delay bus
  const before = (await humanGroups(page)).length;

  // the fader: one drag, one command
  const fh = (await page.getByTestId('fader-lead').boundingBox())!.height;
  await settledDrag(page, page.getByTestId('fader-lead'), 0, fh * 0.25, { steps: 6, at: (b) => ({ x: b.x + b.width / 2, y: b.y + b.height * 0.2 }) });
  await expect.poll(async () => (await humanGroups(page)).length).toBe(before + 1);
  let last = (await humanGroups(page)).at(-1)!;
  expect(last).toHaveLength(1);
  expect(last[0]).toMatch(/^song channel set mix lead gain=0\.\d+$/);
  const gain = Number(last[0]!.split('gain=')[1]);
  expect(gain).toBeLessThan(1);
  await expect(page.getByTestId('fader-lead-value')).not.toHaveText('0.0 dB');

  // the pan knob: one drag
  await settledDrag(page, page.getByTestId('knob-lead-pan'), 0, -24, { steps: 6 });
  await expect.poll(async () => (await humanGroups(page)).length).toBe(before + 2);
  last = (await humanGroups(page)).at(-1)!;
  expect(last).toHaveLength(1);
  expect(last[0]).toMatch(/^song channel set mix lead pan=0\.\d+$/);
  await expect(page.getByTestId('knob-lead-pan-value')).toHaveText(/^R\d+$/);

  // the send knob named for its bus: one drag
  await settledDrag(page, page.getByTestId('knob-lead-reverb'), 0, -24, { steps: 6 });
  await expect.poll(async () => (await humanGroups(page)).length).toBe(before + 3);
  last = (await humanGroups(page)).at(-1)!;
  expect(last).toHaveLength(1);
  expect(last[0]).toMatch(/^song channel set mix lead reverb=0\.\d+$/);

  // double-click: back to 0 dB, which is a gain of 1
  await page.getByTestId('fader-lead').dblclick();
  await expect.poll(async () => (await humanGroups(page)).at(-1)!.join()).toBe('song channel set mix lead gain=1');
  expect((await humanGroups(page)).length).toBe(before + 4);

  // the master fader and the limiter's ceiling write the song's own commands
  await page.getByTestId('knob-master-ceiling').focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await humanGroups(page)).at(-1)!.join()).toMatch(/^song fx set mix 1 ceiling=/);

  // the agent's pan on the arp carries the tick; a person's edit of the lead's pan has none
  await expect(page.getByTestId('knob-arp-pan-tick')).toHaveCount(0);
  await agent.cli(['run', agent.dir, '-e', 'song channel set mix arp pan=-0.4 gain=0.7']);
  await expect(page.getByTestId('knob-arp-pan-tick')).toBeVisible();
  await expect(page.getByTestId('knob-lead-pan-tick')).toHaveCount(0);
  await expect(page.getByTestId('fader-arp').locator('xpath=ancestor::div[contains(@class,"fader-c")]')).toHaveAttribute('data-by', 'agent');
});

test('the strips show their own loudness, or say silent here; the master has a limiter and a loudness target', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page, '#/song/mix/mixer');
  await expect(page.getByTestId('strip-lufs-lead')).toContainText('LUFS', { timeout: 40_000 });
  await expect(page.getByTestId('strip-lufs-bass')).toContainText('LUFS');
  await expect(page.getByTestId('master-limiter')).toContainText('True-peak limiter');
  await expect(page.getByTestId('master-gr')).toHaveText(/^−\d/);
  await expect(page.getByTestId('num-integrated')).toHaveText(/^−\d+\.\d$/);
  await expect(page.getByTestId('num-true-peak')).toContainText('dBTP');
  await expect(page.getByTestId('master-loudness')).toHaveAttribute('data-kind', /pass|warn|fail/);
  await expect(page.getByTestId('num-range')).toContainText('LU', { timeout: 20_000 });
  // the base alone: the layers above it do not sound here
  await page.getByTestId('view-arrangement').click();
  await page.getByTestId('intensity-0').click();
  await page.getByTestId('view-mixer').click();
  await expect(page.getByTestId('strip-lufs-lead')).toHaveText('silent here');
  await expect(page.getByTestId('strip-choir')).toHaveAttribute('data-silent', 'true');
  await expect(page.getByTestId('strip-lufs-bass')).toContainText('LUFS');
  await page.screenshot({ path: join(SHOTS, 'song-mixer.png') });
});

test('the meters move while the song plays and React does not draw at meter rate', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page, '#/song/mix/mixer');
  const mixer = page.getByTestId('page').getByTestId('mixer');
  await expect(mixer).toBeVisible();
  const reads = () => page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const n of ['lead', 'bass', 'master']) {
      const fills = [...document.querySelectorAll(`[data-testid=meter-${n}] .meter-fill`)] as HTMLElement[];
      out[n] = fills.map((f) => f.style.clipPath).join('|');
    }
    return out;
  });
  const idle = await reads();
  await page.getByRole('button', { name: /^▶ Play$/ }).click();
  await expect(page.getByTestId('song-editor')).toHaveAttribute('data-playing', 'true', { timeout: 30_000 });
  // the worker is posting: wait for the first levels
  await expect.poll(() => page.evaluate(() => (window as unknown as { soundclaw: { meters: { frames: number } } }).soundclaw.meters.frames), { timeout: 20_000 }).toBeGreaterThan(3);
  const r0 = Number(await mixer.getAttribute('data-renders'));
  const f0 = await page.evaluate(() => (window as unknown as { soundclaw: { meters: { frames: number } } }).soundclaw.meters.frames);
  const seen = { lead: new Set<string>(), bass: new Set<string>(), master: new Set<string>() };
  // watch until enough levels have come (not for a fixed time: under load the worker posts later, not less often per message)
  const t0 = Date.now();
  let f1 = f0;
  while (Date.now() - t0 < 30_000) {
    const r = await reads();
    for (const k of Object.keys(seen) as (keyof typeof seen)[]) seen[k].add(r[k]!);
    f1 = await page.evaluate(() => (window as unknown as { soundclaw: { meters: { frames: number } } }).soundclaw.meters.frames);
    if (f1 - f0 >= 30 && seen.lead.size >= 5 && seen.master.size >= 5 && Date.now() - t0 >= 1000) break;
    await page.waitForTimeout(40);
  }
  const seconds = (Date.now() - t0) / 1000;
  const r1 = Number(await mixer.getAttribute('data-renders'));
  // about thirty level messages a second from the worker, many different meter positions, and almost no renders
  expect(f1 - f0).toBeGreaterThanOrEqual(30);
  expect((f1 - f0) / seconds).toBeLessThanOrEqual(50);
  expect(seen.lead.size).toBeGreaterThanOrEqual(5);
  expect(seen.master.size).toBeGreaterThanOrEqual(5);
  expect(r1 - r0).toBeLessThanOrEqual(2);
  expect(idle.master).not.toBe([...seen.master].at(-1));
  // a short-term loudness reading appears for the master
  await expect(page.getByTestId('num-short-term')).toHaveText(/^−\d+\.\d$/, { timeout: 8000 });
  // the toggle switches what the meters show
  await page.getByTestId('meter-mode-lufs').click();
  await expect(page.getByTestId('mixer')).toHaveAttribute('data-mode', 'lufs');
  await page.getByTestId('song-editor').getByTestId('stop-song').click();
  await expect.poll(async () => (await reads()).master, { timeout: 5000 }).toMatch(/inset\(100%/);
  await page.screenshot({ path: join(SHOTS, 'song-mixer-playing.png') });
});

test('a masking link solos both strips and loops the bars where they clash', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page, '#/song/mix/mixer');
  const link = page.locator('[data-testid^=mask-link-]').first();
  await expect(link).toBeVisible({ timeout: 40_000 });
  await expect(link).toHaveText(/bars? \d/);
  const [a, b] = (await link.getAttribute('data-testid'))!.replace('mask-link-', '').split('-') as [string, string];
  expect([a, b].sort()).toEqual(['arp', 'lead']);
  await expect(page.getByTestId(`mask-arc-${a}-${b}`)).toBeAttached();
  const before = (await humanGroups(page)).length;
  await link.click();
  await expect(page.getByTestId('song-editor')).toHaveAttribute('data-playing', 'true', { timeout: 30_000 });
  await expect(page.getByTestId(`strip-${a}`)).toHaveClass(/solo/);
  await expect(page.getByTestId(`strip-${b}`)).toHaveClass(/solo/);
  await expect(page.getByTestId('strip-bass')).not.toHaveClass(/solo/);
  const played = await page.evaluate(() => (window as unknown as { soundclaw: { songsPlayed: { muted: string[]; region?: { start: number; end: number } }[] } }).soundclaw.songsPlayed.at(-1));
  expect(played!.muted.sort()).toEqual(['bass', 'choir']);
  expect(played!.region!.start).toBeGreaterThanOrEqual(3.5);
  expect(played!.region!.end - played!.region!.start).toBeGreaterThanOrEqual(0.5);
  // listening only: nothing was written
  expect((await humanGroups(page)).length).toBe(before);
  // the same link again clears the solo and stops
  await link.click();
  await expect(page.getByTestId('song-editor')).toHaveAttribute('data-playing', 'false', { timeout: 10_000 });
  await expect(page.getByTestId(`strip-${a}`)).not.toHaveClass(/solo/);
});

test('the song’s pieces are in the inspector and the bottom panel, and the palette finds each one', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('inspector')).toHaveCount(0);
  const via = async (typed: string, label: string): Promise<void> => {
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog').getByRole('combobox').or(page.getByRole('dialog').locator('input')).first().fill(typed);
    await expect(page.getByRole('dialog')).toContainText(label);
    await page.keyboard.press('Enter');
  };
  await via('song helpers', 'Song: show the helpers');
  await expect(page.getByTestId('helper-panel')).toBeVisible();
  await via('song order', 'Song: show the song order');
  await expect(page.getByTestId('song-order')).toBeVisible();
  await via('song instruments', 'Song: show the instruments');
  await expect(page.getByTestId('instrument-panel')).toBeVisible();
  await via('song changes', 'Song: show the changes');
  await expect(page.getByTestId('song-changes')).toBeVisible();
  await page.keyboard.press('Alt+2');
  await expect(page.getByTestId('inspector')).toHaveCount(0);
  // the mixer in the bottom panel
  await page.getByTestId('bottom-tab-mixer').click();
  await expect(page.getByTestId('mixer-lite')).toBeVisible();
  await expect(page.getByTestId('mixer-lite').getByTestId('strip-lead')).toBeVisible();
  await expect(page.getByTestId('mixer-lite').getByTestId('strip-master')).toBeVisible();
  await page.getByTestId('open-mixer').click();
  await expect(page).toHaveURL(/#\/song\/mix\/mixer$/);
  await via('song mixer', 'Song: open the mixer');
  await via('song arrangement', 'Song: open the arrangement');
  await expect(page).toHaveURL(/#\/song\/mix$/);
});
