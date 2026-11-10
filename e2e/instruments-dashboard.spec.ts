// The dashboard for sampled instruments and generation: the instrument page's key-map (zones with their check as a glyph and a word), an edge dragged or
// moved by keys writing one command, a sample dropped on a key, playing by clicking, by the computer keyboard and by a (stubbed) MIDI keyboard with the
// bytes the core renders, the generation panel with its estimate and caps, the Takes list, the spend on the session page and the feed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { decodeAudio, joinChannels, pcmFromFloats, pcmToSampleData, renderNote, samplesHash, type Instrument } from '../core/src/index.ts';
import { wavBytes } from '../core/test/audio-fixtures.ts';
import { HARP_HZ, makeInstrument, makeSamples, steadyTone } from './example.ts';
import { settledDrag } from './drag.ts';
import { test } from './fixtures.ts';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

interface Tape { cmd: string; by: string; group: string }
const tape = (): Tape[] => readFileSync(join(agent.dir, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Tape).filter((t) => typeof t.cmd === 'string');
const zoneSets = (): string[] => tape().map((t) => t.cmd).filter((c) => c.startsWith('instrument zone set harp'));
const played = (page: Page): Promise<{ id: string; key: string; hash: string }[]> => page.evaluate(() => (window as unknown as { soundclaw: { played: { id: string; key: string; hash: string }[] } }).soundclaw.played);

async function open(page: Page, hash = ''): Promise<void> {
  await page.goto(`${agent.url}&name=ana${hash}`);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
}
async function start(withSamples = false): Promise<void> {
  agent = await startAgent();
  if (withSamples) await makeSamples(agent);
  await makeInstrument(agent);
}
async function openHarp(page: Page): Promise<void> {
  await open(page, '#/instrument/harp');
  await expect(page.getByTestId('zone-1')).toBeVisible();
  await expect(page.getByTestId('instrument-check-badge')).toBeVisible({ timeout: 30_000 });
}

test('the instrument page: the key-map draws every zone with its check as a glyph and a word, the table and the findings say the same', async ({ page }) => {
  await start();
  await open(page);
  await page.getByTestId('lib-tab-instruments').click();
  await expect(page.getByTestId('lib-row-harp')).toContainText('3 zones');
  await page.getByTestId('lib-row-harp').dblclick();
  await expect(page).toHaveURL(/#\/instrument\/harp$/);
  await expect(page.getByTestId('tab-instrument-harp')).toBeVisible();
  await expect(page.getByTestId('instrument-title')).toHaveText('harp');
  await expect(page.getByTestId('instrument-zones-count')).toHaveText('3 zones');
  await expect(page.getByTestId('instrument-check-badge')).toContainText('check fails', { timeout: 30_000 });
  // zone 1 reaches far from its root (a warning), zone 2 is a quarter tone off (a fault), zone 3 is the release sample (it passes)
  await expect(page.getByTestId('zone-1')).toHaveAttribute('data-status', 'warn');
  await expect(page.getByTestId('zone-2')).toHaveAttribute('data-status', 'fail');
  await expect(page.getByTestId('zone-3')).toHaveAttribute('data-release', 'true');
  await expect(page.getByTestId('zone-3')).toHaveAttribute('data-status', 'ok');
  await expect(page.getByTestId('zone-row-1')).toContainText('warning');
  await expect(page.getByTestId('zone-row-2')).toContainText('fault');
  await expect(page.getByTestId('zone-row-2')).toContainText('×');
    await expect(page.getByTestId('zone-row-1')).toContainText('C2-D#3');
  await expect(page.getByTestId('zone-row-2')).toContainText('G3');
  const findings = page.getByTestId('instrument-findings');
  await expect(findings).toContainText('zone 2');
  await expect(findings.locator('[data-check=pitch]')).toBeVisible();
  await expect(findings.locator('[data-check=coverage]')).toBeVisible();
  await expect(findings.locator('[data-check=distance]')).toBeVisible();
  await expect(page.getByTestId('instrument-licence')).toHaveAttribute('data-state', 'shippable');
  // selecting a zone shows its numbers and its edge handles
  await page.getByTestId('zone-row-2').click();
  await expect(page.getByTestId('zone-editor')).toHaveAttribute('data-zone', '2');
  await expect(page.getByTestId('zone-measured')).toContainText('cents at its root');
  await expect(page.getByTestId('zone-2-edge-left')).toBeVisible();
  // the shortcut sheet lists what this page adds, and the palette opens an instrument
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog').first()).toContainText('Instrument: play with the computer keyboard');
  await page.keyboard.press('Escape');
  await page.getByTestId('open-palette').click();
  await page.keyboard.type('harp');
  await expect(page.getByRole('dialog').first()).toContainText('Instruments');
  await page.keyboard.press('Escape');
  // a built-in has no zones and can still be played; a missing instrument says so
  await open(page, '#/instrument/pluck');
  await expect(page.getByTestId('instrument-builtin')).toBeVisible();
  await open(page, '#/instrument/nothing');
  await expect(page.getByTestId('instrument-missing')).toBeVisible();
});

test('letting go of an edge writes one instrument zone set; the arrow keys move a draft and Enter writes it', async ({ page }) => {
  await start();
  await openHarp(page);
  await page.getByTestId('zone-row-1').click();
  const before = zoneSets().length;
  const right = page.getByTestId('zone-1-edge-right');
  const keys0 = Number(await right.getAttribute('aria-valuenow'));
  const svg = (await page.getByTestId('keymap-svg').boundingBox())!;
  const keyPx = (svg.width / 1000) * ((1000 - 50) / (Number(await page.getByTestId('keymap-svg').getAttribute('data-b')) - Number(await page.getByTestId('keymap-svg').getAttribute('data-a')) + 1));
  await settledDrag(page, right, keyPx * 3, 0, { attr: 'aria-valuenow' });
  await expect.poll(() => zoneSets().length).toBe(before + 1);
  const cmd = zoneSets().at(-1)!;
  expect(cmd).toMatch(/^instrument zone set harp 1 keys=C2-[A-G]#?\d$/);
  expect(tape().at(-1)).toMatchObject({ cmd, by: 'human:ana' });
  await expect(page.getByTestId('zone-1')).toHaveAttribute('data-keys', new RegExp(`^36-${keys0 + 3}$`));
  // the keyboard: a draft first, nothing written until Enter
  const left = page.getByTestId('zone-1-edge-left');
  await left.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('keymap-draft')).toContainText('zone 1');
  expect(zoneSets().length).toBe(before + 1);
  await page.keyboard.press('Enter');
  await expect.poll(() => zoneSets().length).toBe(before + 2);
  expect(zoneSets().at(-1)).toBe('instrument zone set harp 1 keys=D2-' + cmd.split('-').at(-1));
  await expect(page.getByTestId('keymap-draft')).toHaveCount(0);
  // a velocity edge
  const top = page.getByTestId('zone-3-edge-top');
  await page.getByTestId('zone-row-3').click();
  await top.focus();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Enter');
  await expect.poll(() => zoneSets().length).toBe(before + 3);
  expect(zoneSets().at(-1)).toBe('instrument zone set harp 3 vel=1-117');
});

test('the zone editor writes one command for the fields changed; a zone is removed by a command too', async ({ page }) => {
  await start();
  await openHarp(page);
  await page.getByTestId('zone-row-2').click();
  await page.getByTestId('zone-field-tune').fill('-50');
  await page.getByTestId('zone-field-gain').fill('-3');
  await page.getByTestId('zone-apply').click();
  await expect.poll(() => zoneSets().length).toBe(1);
  expect(zoneSets()[0]).toBe('instrument zone set harp 2 tune=-50 gain=-3');
  // the check follows the edit: the quarter tone is tuned away
  await expect(page.getByTestId('zone-2')).toHaveAttribute('data-status', 'ok', { timeout: 30_000 });
  await page.getByTestId('zone-field-keys').fill('zz');
  await expect(page.getByTestId('zone-apply')).toBeDisabled();
  await page.getByTestId('zone-remove').click();
  await expect(page.getByTestId('instrument-zones-count')).toHaveText('2 zones');
  expect(tape().at(-1)!.cmd).toBe('instrument zone remove harp 2');
  // Add zone: a dialog for people who do not drag
  await page.getByTestId('instrument-add').click();
  await page.getByTestId('add-zone-sample').selectOption('harp_g3');
  await page.getByTestId('add-zone-key').fill('G3');
  await page.getByTestId('add-zone-go').click();
  await expect(page.getByTestId('instrument-zones-count')).toHaveText('3 zones');
  expect(tape().at(-1)!.cmd).toMatch(/^instrument zone add harp sample=harp_g3 root=[A-G]#?\d( tune=-?\d+)? keys=F#3-G#3$/);
});

test('a sample dragged from the Samples tab onto a key adds a zone at its measured root, in one command', async ({ page }) => {
  test.setTimeout(180_000);
  await start(true);
  await openHarp(page);
  await page.getByTestId('lib-tab-samples').click();
  await expect(page.getByTestId('lib-row-hum_tone')).toBeVisible();
  const n = tape().length;
  const svg = page.getByTestId('keymap-svg');
  const box = (await svg.boundingBox())!;
  const a = Number(await svg.getAttribute('data-a')), b = Number(await svg.getAttribute('data-b'));
  const keyW = (1000 - 50) / (b - a + 1);
  const key = 68; // G#4: above every zone, inside the range
  const x = ((40 + (key - a + 0.5) * keyW) / 1000) * box.width;
  await page.getByTestId('lib-row-hum_tone').dragTo(svg, { targetPosition: { x, y: box.height * 0.4 } });
  await expect.poll(() => tape().length).toBe(n + 1);
  const cmd = tape().at(-1)!;
  expect(cmd.by).toBe('human:ana');
  expect(cmd.cmd).toMatch(/^instrument zone add harp sample=hum_tone root=[A-G]#?\d( tune=-?\d+)? keys=G4-A4$/);
  await expect(page.getByTestId('instrument-zones-count')).toHaveText('4 zones');
  // a sample with no steady pitch is rooted at the key, and the toast says so
  await page.getByTestId('lib-row-field_noise').dragTo(svg, { targetPosition: { x: ((40 + (60 - a + 0.5) * keyW) / 1000) * box.width, y: box.height * 0.4 } });
  await expect.poll(() => tape().length).toBe(n + 2);
  expect(tape().at(-1)!.cmd).toMatch(/^instrument zone add harp sample=field_noise root=(C4|[A-G]#?\d)( tune=-?\d+)? keys=B3-C#4$/);
});

/** The bytes the core renders in Node for a note of the harp, from the same audio the page was given. */
function nodeNote(inst: Instrument, midi: number, vel: number, gate: number): string {
  const bank: Record<string, ReturnType<typeof pcmToSampleData>> = {};
  for (const [name, hz] of Object.entries(HARP_HZ)) bank[name] = pcmToSampleData(decodeAudio(wavBytes(pcmFromFloats([steadyTone(hz, 1)], 44100, 'pcm16'))).audio);
  const chans = renderNote(inst, { midi, gate, vel }, { get: (n: string) => bank[n], hash: (n: string) => (bank[n] ? n : undefined) } as never);
  return samplesHash(joinChannels(chans));
}
const harpDoc = (page: Page): Promise<Instrument> => page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { soundclaw: { instruments: { id: string }[] } }).soundclaw.instruments.find((i) => i.id === 'harp'))) as never);

test('playing: the piano strip, the computer keyboard and a MIDI keyboard sound notes the core renders to the same bytes as Node', async ({ page }) => {
  await page.addInitScript(() => {
    // a MIDI keyboard that is not there: the page asks for access, this answers with one input the test plays
    const input: { id: string; name: string; onmidimessage: ((e: { data: Uint8Array }) => void) | null } = { id: 'fake-1', name: 'Test keyboard', onmidimessage: null };
    (window as unknown as { __midi: typeof input }).__midi = input;
    (navigator as unknown as { requestMIDIAccess: () => Promise<unknown> }).requestMIDIAccess = async () => ({ inputs: new Map([['fake-1', input]]), onstatechange: null });
  });
  await start();
  await openHarp(page);
  // wait for the page to have the audio under the zones
  await expect.poll(async () => { await page.getByTestId('play-root').click(); return (await played(page)).length; }, { timeout: 30_000 }).toBeGreaterThan(0);
  const inst = await harpDoc(page);
  const base = (await played(page)).length;
  // the piano strip: pressing a key plays it, letting go lets a held note fade
  const key = page.getByTestId('key-60');
  const kb = (await key.boundingBox())!;
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height - 6);
  await page.mouse.down();
  await expect(key).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.up();
  await expect(key).toHaveAttribute('aria-pressed', 'false');
  let list = await played(page);
  expect(list.length).toBe(base + 1);
  expect(list.at(-1)).toMatchObject({ id: 'harp', key: 'harp#live' });
  expect(list.at(-1)!.hash).toBe(nodeNote(inst, 60, 100, 3));
  // the computer keyboard: A plays C4 (the shell's own letter keys do not fire here), Z lowers the octave
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.down('a');
  await expect(page.getByTestId('key-60')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.up('a');
  list = await played(page);
  expect(list.at(-1)!.hash).toBe(nodeNote(inst, 60, 100, 3));
  await page.keyboard.press('z');
  await expect(page.getByTestId('play-octave')).toHaveText('3');
  await page.keyboard.press('l'); // D4 an octave down: not the shell's loop key
  list = await played(page);
  expect(list.at(-1)!.hash).toBe(nodeNote(inst, 62, 100, 3));
  // a fixed length plays the note as written, release sample included
  await page.getByTestId('length-0.6').click();
  await page.keyboard.press('a');
  list = await played(page);
  expect(list.at(-1)!.hash).toBe(nodeNote(inst, 48, 100, 0.6));
  // MIDI: the browser asks, the keyboard plays with its velocity, a note on with velocity 0 is an off
  await page.getByTestId('play-midi').click();
  await expect(page.getByTestId('midi-state')).toContainText('Test keyboard');
  await page.getByTestId('length-held').click();
  await page.evaluate(() => (window as unknown as { __midi: { onmidimessage: (e: { data: Uint8Array }) => void } }).__midi.onmidimessage({ data: new Uint8Array([0x90, 52, 64]) }));
  await expect(page.getByTestId('key-52')).toHaveAttribute('aria-pressed', 'true');
  list = await played(page);
  expect(list.at(-1)!.hash).toBe(nodeNote(inst, 52, 64, 3));
  await page.evaluate(() => (window as unknown as { __midi: { onmidimessage: (e: { data: Uint8Array }) => void } }).__midi.onmidimessage({ data: new Uint8Array([0x90, 52, 0]) }));
  await expect(page.getByTestId('key-52')).toHaveAttribute('aria-pressed', 'false');
});

test('a browser without Web MIDI says so', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'requestMIDIAccess', { value: undefined, configurable: true }); });
  await start();
  await openHarp(page);
  await page.getByTestId('play-midi').click();
  await expect(page.getByTestId('midi-state')).toContainText('no Web MIDI');
});
