// Audio in songs and sounds on the dashboard: the clips of an audio channel in the arrangement (their place, sound and what is done to them; a click, a drag, the
// arrow keys, the inspector and a sample dropped from the library each write the command an agent would), the song that plays them rendered in the page to the
// bytes Node renders, the convolve device card with the response it draws, and the grain layer's card and map.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { settledDrag } from './drag.ts';
import { makeAudio, makeSamples } from './example.ts';
import { test } from './fixtures.ts';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

interface Tape { cmd: string; by: string; group: string }
const tape = (): Tape[] => readFileSync(join(agent.dir, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Tape).filter((t) => typeof t.cmd === 'string');
const clipCmds = (): Tape[] => tape().filter((t) => /^song clip (set|add|remove) /.test(t.cmd));
type SongPlayed = { id: string; mode: string; hash: string; muted: string[] };
const songsPlayed = (page: Page): Promise<SongPlayed[]> => page.evaluate(() => (window as unknown as { soundclaw: { songsPlayed: SongPlayed[] } }).soundclaw.songsPlayed);

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`${agent.url}&name=ana${hash}`);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
}
async function start(withSamples = false): Promise<void> {
  agent = await startAgent();
  if (withSamples) await makeSamples(agent);
  await makeAudio(agent);
}
/** Where a clip's block sits, as a share of its lane. */
async function share(page: Page, id: number): Promise<{ left: number; width: number }> {
  return page.evaluate((n) => {
    const lane = document.querySelector('[data-testid=aclips-loops]')!.getBoundingClientRect();
    const r = document.querySelector(`[data-testid=aclip-loops-${n}]`)!.getBoundingClientRect();
    return { left: (r.left - lane.left) / lane.width, width: r.width / lane.width };
  }, id);
}

test('the arrangement draws a clip for each recording on an audio channel: its place, its sound and what is done to it; the agent\'s is violet', async ({ page }) => {
  await start();
  await open(page, '#/song/audio_loop');
  const one = page.getByTestId('aclip-loops-1'), two = page.getByTestId('aclip-loops-2');
  await expect(one).toBeVisible();
  await expect(two).toBeVisible();
  // the song is four bars of 2 s: the first clip starts at the start; the second at bar 3 (a half), a bar long
  // (a block is as long as its recording is, which it knows once the audio has arrived)
  await expect.poll(async () => (await share(page, 2)).width, { timeout: 20_000 }).toBeGreaterThan(0.15);
  const a = await share(page, 1), b = await share(page, 2);
  expect(a.left).toBeCloseTo(0, 2);
  expect(b.left).toBeCloseTo(0.5, 2);
  // the second is a recording 1.6 s long (a bar was asked for: 2 s, and it ends first)
  expect(b.width).toBeCloseTo(1.6 / 8, 2);
  // the first is a loop made at 90 bpm and fitted to the song's 120: it is two bars (len=2) of 2 s each, a half of the song
  expect(a.width).toBeCloseTo(0.5, 2);
  await expect(page.getByTestId('aclip-badge-loops-1')).toHaveText('↔ 90→120');
  await expect(one).toHaveAttribute('data-at', '1.1');
  await expect(two).toHaveAttribute('data-at', '3.1');
  expect(await one.locator('.aclip-wave rect').count()).toBeGreaterThan(20);
  // the agent's clip is violet and dashed, the person's is not, and neither is by colour alone (the star)
  await expect(two).toHaveAttribute('data-agent', 'true');
  await expect(one).not.toHaveAttribute('data-agent', 'true');
  await expect(two).toContainText('✦');
  await expect(two).toHaveAttribute('aria-label', /clip 2: rain_src at 3\.1/);
  // the track and the mixer know the channel is audio
  await expect(page.getByTestId('track-loops')).toBeVisible();
});

test('selecting a clip opens its settings; each field writes one song clip set, a person\'s', async ({ page }) => {
  await start();
  await open(page, '#/song/audio_loop');
  await page.getByTestId('aclip-loops-1').click();
  const box = page.getByTestId('aclip-inspector');
  await expect(box).toBeVisible();
  await expect(box).toContainText('loop_90');
  const before = clipCmds().length;
  await box.getByTestId('aclip-field-gain').fill('0.5');
  await box.getByTestId('aclip-field-gain').press('Enter');
  await expect.poll(() => clipCmds().length).toBe(before + 1);
  expect(clipCmds().at(-1)).toMatchObject({ cmd: 'song clip set audio_loop loops 1 gain=0.5', by: 'human:ana' });
  await box.getByTestId('aclip-field-pitch').fill('-3');
  await box.getByTestId('aclip-field-pitch').press('Enter');
  await expect.poll(() => clipCmds().at(-1)!.cmd).toBe('song clip set audio_loop loops 1 pitch=-3');
  await expect(page.getByTestId('aclip-badge-loops-1')).toHaveText('↔ 90→120 -3 st');
  // fit to the tempo off and on again
  await box.getByTestId('aclip-field-stretch').click();
  await expect.poll(() => clipCmds().at(-1)!.cmd).toBe('song clip set audio_loop loops 1 stretch=none');
  await expect(box.getByTestId('aclip-field-from-tempo')).toHaveCount(0);
  await box.getByTestId('aclip-field-stretch').click();
  await expect.poll(() => clipCmds().at(-1)!.cmd).toBe('song clip set audio_loop loops 1 stretch=tempo');
  // a field left alone writes nothing
  const n = clipCmds().length;
  await box.getByTestId('aclip-field-fade').focus();
  await box.getByTestId('aclip-field-fade').blur();
  expect(clipCmds().length).toBe(n);
  // a wrong value is refused in words and the clip stays
  await box.getByTestId('aclip-field-at').fill('1.9');
  await box.getByTestId('aclip-field-at').press('Enter');
  await expect(page.getByText(/beats in a 4\/4 bar run from 1 to 4/).first()).toBeVisible();
  // remove
  await box.getByTestId('aclip-remove').click();
  await expect(page.getByTestId('aclip-loops-1')).toHaveCount(0);
  expect(clipCmds().at(-1)!.cmd).toBe('song clip remove audio_loop loops 1');
});

test('dragging a clip moves it along the beats (one command), the arrow keys move it a beat, and Escape-less: a click without a move writes nothing', async ({ page }) => {
  await start();
  await open(page, '#/song/audio_loop');
  const clip = page.getByTestId('aclip-loops-2');
  const before = clipCmds().length;
  await clip.click();
  expect(clipCmds().length).toBe(before);
  const lane = (await page.getByTestId('aclips-loops').boundingBox())!;
  // one bar is a quarter of the lane: drag the clip at bar 3 back one bar
  await settledDrag(page, clip, -lane.width / 4, 0, { expectChange: false, at: (b) => ({ x: b.x + 14, y: b.y + b.height / 2 }) });
  await expect.poll(() => clipCmds().length).toBe(before + 1);
  expect(clipCmds().at(-1)).toMatchObject({ cmd: 'song clip set audio_loop loops 2 at=2.1', by: 'human:ana' });
  await expect(clip).toHaveAttribute('data-at', '2.1');
  await clip.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => clipCmds().at(-1)!.cmd).toBe('song clip set audio_loop loops 2 at=2.2');
  await expect(clip).toHaveAttribute('data-at', '2.2');
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => clipCmds().at(-1)!.cmd).toBe('song clip set audio_loop loops 2 at=1.2');
  expect(clipCmds().length).toBe(before + 3);
});

test('a sample dragged from the Samples tab onto the audio lane places a clip at the beat under it; "+ audio" adds a channel', async ({ page }) => {
  await start(true);
  await open(page, '#/song/audio_loop');
  await page.getByTestId('lib-tab-samples').click();
  const row = page.getByTestId('lib-row-hum_tone');
  await expect(row).toBeVisible();
  const lane = page.getByTestId('aclips-loops');
  const lb = (await lane.boundingBox())!;
  // bar 4 is three quarters across; beat 3 of it is another half bar
  await row.dragTo(lane, { targetPosition: { x: lb.width * 0.875, y: lb.height / 2 } });
  await expect.poll(() => clipCmds().at(-1)?.cmd).toBe('song clip add audio_loop loops hum_tone at=4.3');
  expect(clipCmds().at(-1)!.by).toBe('human:ana');
  await expect(page.locator('[data-testid^=aclip-loops-][data-sample=hum_tone]')).toHaveCount(1);
  // a new audio channel
  await page.getByTestId('add-audio-channel').click();
  await expect.poll(() => tape().at(-1)!.cmd).toBe('song channel add audio_loop audio audio');
  await expect(page.getByTestId('track-audio')).toBeVisible();
  await expect(page.getByTestId('aclips-audio')).toBeVisible();
});

test('the page renders a song with clips and a convolution send to the bytes Node renders, whole and as a loop', async ({ page }) => {
  test.setTimeout(150_000);
  await start();
  const cli = JSON.parse((await agent.cli(['render', agent.dir, 'audio_loop', '--json'])).out) as { hashes: { full: string; loop: string } };
  await open(page, '#/');
  await expect(page.getByTestId('song-audio_loop')).toBeVisible();
  await page.getByTestId('song-play-audio_loop').click();
  await expect(page.getByTestId('song-audio_loop')).toHaveAttribute('data-playing', 'true', { timeout: 60_000 });
  expect((await songsPlayed(page))[0]).toMatchObject({ id: 'audio_loop', mode: 'full', muted: [] });
  expect((await songsPlayed(page))[0]!.hash).toBe(cli.hashes.full);
  await expect(page.getByTestId('song-audio_loop')).toHaveAttribute('data-playing', 'false', { timeout: 30_000 });
  await page.getByTestId('song-loop-audio_loop').click();
  await expect(page.getByTestId('song-audio_loop')).toHaveAttribute('data-mode', 'loop', { timeout: 60_000 });
  expect((await songsPlayed(page)).at(-1)!.hash).toBe(cli.hashes.loop);
  await page.getByTestId('song-loop-audio_loop').click();
});

test('the mixer has a strip for the audio channel and the convolution bus, with the room named', async ({ page }) => {
  await start();
  await open(page, '#/song/audio_loop/mixer');
  await expect(page.getByTestId('strip-loops')).toBeVisible();
  await expect(page.getByTestId('inserts-loops')).toContainText('audio · 2 clips');
  await expect(page.getByTestId('strip-bus-convolve')).toContainText('room room_ir');
  await expect(page.getByTestId('knob-loops-convolve')).toBeVisible();
});

test('the convolution bus meter moves while the song plays', async ({ page }) => {
  test.setTimeout(90_000);
  await start();
  await open(page, '#/song/audio_loop/mixer');
  await expect(page.getByTestId('strip-bus-convolve')).toBeVisible();
  const read = () => page.evaluate(() => ([...document.querySelectorAll('[data-testid=meter-bus-convolve] .meter-fill')] as HTMLElement[]).map((f) => f.style.clipPath).join('|'));
  const idle = await read();
  await page.getByRole('button', { name: /^▶ Play$/ }).click();
  await expect(page.getByTestId('song-editor')).toHaveAttribute('data-playing', 'true', { timeout: 30_000 });
  const seen = new Set<string>();
  const t0 = Date.now();
  while (Date.now() - t0 < 20_000 && seen.size < 4) { seen.add(await read()); await page.waitForTimeout(50); }
  seen.delete(idle);
  expect(seen.size).toBeGreaterThanOrEqual(3);
});

test('the convolve device card draws the response it uses, the panel picks it from the project\'s samples, and the room is a sample the sound cannot lose', async ({ page }) => {
  await start();
  await open(page, '#/sound/door_room');
  const card = page.getByTestId('fx-1-1');
  await expect(card).toBeVisible();
  await expect(card).toContainText('convolve');
  await expect(card).toContainText('room_ir');
  // the sketch is the response's own shape: many points, falling
  await expect.poll(async () => (await card.locator('.dev-sketch path').getAttribute('d'))!.split('L').length).toBeGreaterThan(40);
  await card.click();
  const panel = page.getByTestId('fx-panel-1-1');
  await expect(panel).toHaveAttribute('data-kind', 'convolve');
  const pick = page.getByTestId('ctl-F-1-1-ir');
  await expect(pick).toHaveValue('room_ir');
  await pick.selectOption('loop_90');
  await expect.poll(() => tape().at(-1)!.cmd).toBe('fx set door_room layer=1 1 ir=loop_90');
  await expect(card).toContainText('loop_90');
  // the sample page lists what plays it
  const r = await agent.cli(['sample', 'remove', agent.dir, 'room_ir']);
  expect(r.code === 0 ? r.out : r.err).toMatch(/played by song audio_loop/);
});

test('a grain layer has a card and a map of its own: the sample, where the grains are taken, how many sound at once; layers can be added from the menu', async ({ page }) => {
  await start();
  await open(page, '#/sound/rain_bed');
  const card = page.getByTestId('grain-card-1');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('layer-src-1')).toContainText('grains of rain_src');
  await page.getByTestId('source-open-1').click();
  const map = page.getByTestId('grain-map');
  await expect(map).toBeVisible();
  await expect(page.getByTestId('grain-words')).toContainText('30 grains a second of 80 ms');
  await expect(page.getByTestId('grain-words')).toContainText('taken around 50 % of the sample, ± 30 %');
  expect(await map.locator('.gm-wave').count()).toBeGreaterThan(50);
  // a change from outside moves the map
  const r = await agent.cli(['run', agent.dir, '-e', 'layer set rain_bed 1 position=0.8 density=60 size=0.2', '--by', 'agent:claude']);
  expect(r.code, r.err).toBe(0);
  await expect(page.getByTestId('grain-words')).toContainText('60 grains a second of 200 ms, about 12 at once');
  await expect(page.getByTestId('grain-words')).toContainText('around 80 %');
  // an envelope on the position replaces the band
  await agent.cli(['run', agent.dir, '-e', 'env rain_bed 1.position "0:0.1 4:0.9"', '--by', 'agent:claude']);
  await expect(page.getByTestId('grain-words')).toContainText('the position follows an envelope');
  // the menu adds a grain layer that names a sample
  await page.getByTestId('add-layer-menu').click();
  await page.getByTestId('add-layer-grain').click();
  await expect.poll(() => tape().at(-1)!.cmd).toMatch(/^layer add rain_bed grain sample=\S+$/);
});
