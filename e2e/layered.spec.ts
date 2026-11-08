// The layered editor in a browser: a three-layer impact built with the controls, an envelope point
// dragged (one history entry), an effect added, played; layer-list edits as commands; and what the
// browser renders for every kind of layer equal to what Node renders, bit for bit.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { test } from './fixtures.ts';
import { encodeWav, floatsFromBytes, samplesHash } from '../core/src/index.ts';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

const SHOTS = join(import.meta.dirname, '..', '.dev', 'screens');
type Played = { id: string; slot?: string; hash: string; samples: number };
const played = (page: Page): Promise<Played[]> => page.evaluate(() => (window as unknown as { soundclaw: { played: Played[] } }).soundclaw.played);
const rows = (page: Page) => page.locator('[data-testid=cmd-row]').evaluateAll((rs) => rs.map((r) => ({ by: (r as HTMLElement).dataset.by!, text: r.querySelector('code')!.textContent!, undone: r.classList.contains('undone') })));
const texts = async (page: Page): Promise<string[]> => (await rows(page)).map((r) => r.text);

async function open(page: Page, setup: string, name = 'impact'): Promise<void> {
  agent = await startAgent();
  const r = await agent.cli(['run', agent.dir, '-e', setup]);
  expect(r.code, r.err).toBe(0);
  await page.goto(`${agent.url}&name=ana#/sound/${name}`);
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
  await page.getByTestId('play-on-change').uncheck();
}

/** Set a range input to a position (0 to 1000) and wait for the command that follows. */
async function fillRange(page: Page, testid: string, pos: number): Promise<void> {
  await page.getByTestId(testid).fill(String(pos));
}

test('builds a three-layer impact in the editor, drags an envelope point (one history entry), adds an effect and plays', async ({ page }) => {
  await open(page, 'sound new impact voice=layered seed=3');
  await expect(page.getByTestId('no-layers')).toBeVisible();

  // layer 1: a sine thump at 60 Hz
  await page.getByTestId('add-layer-osc').click();
  await expect(page.getByTestId('layer-row-1')).toBeVisible();
  await fillRange(page, 'ctl-L-1-freq', 159); // 20 * 1000^0.159 = 60 Hz
  await fillRange(page, 'ctl-L-1-dur', 392); // 0.4 s (log scale, 0.01 to 123 s)
  // both moves came within the pause: they are written together, as one command
  await expect.poll(async () => (await texts(page)).filter((t) => /^layer set impact 1 freq=\d+(\.\d+)? dur=0\.\d+$/.test(t)).length, { timeout: 8000 }).toBe(1);

  // layer 2: a burst of white noise, low-passed
  await page.getByTestId('add-layer-osc').click();
  await expect(page.getByTestId('layer-row-2')).toBeVisible();
  await page.getByTestId('ctl-L-2-wave').selectOption('white');
  await page.getByTestId('ctl-L-2-filter').selectOption('lp');
  await fillRange(page, 'ctl-L-2-dur', 245); // about 0.1 s
  await expect.poll(async () => (await texts(page)).some((t) => /^layer set impact 2 .*filter=lp/.test(t))).toBe(true);

  // layer 3: a short square click
  await page.getByTestId('add-layer-osc').click();
  await page.getByTestId('ctl-L-3-wave').selectOption('square');
  await fillRange(page, 'ctl-L-3-dur', 74); // about 0.02 s
  await expect.poll(async () => (await texts(page)).some((t) => /^layer set impact 3 .*wave=square/.test(t))).toBe(true);
  await expect(page.getByTestId('layer-row-3')).toBeVisible();
  await expect(page.locator('[data-testid^=layer-row-]')).toHaveCount(3);
  await expect(page.getByTestId('card-impact').or(page.getByTestId('layer-strips'))).toBeVisible();
  await expect(page.locator('[data-testid^=strip-]')).toHaveCount(3);

  // an envelope on layer 1's pitch: make it, then drag its second point
  await page.getByTestId('layer-select-1').click();
  await page.getByTestId('env-btn-L-1-freq').click();
  await expect(page.getByTestId('env-graph')).toHaveAttribute('data-points', '2');
  await expect(page.getByTestId('env-graph')).toHaveAttribute('data-target', '1.freq');
  const before = await texts(page);
  const pt = page.getByTestId('env-point-1');
  const t0 = Number(await pt.getAttribute('data-t')), v0 = Number(await pt.getAttribute('data-v'));
  const box = (await pt.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 60, cy + 50, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await texts(page)).length).toBe(before.length + 1);
  const entry = (await rows(page))[0]!;
  expect(entry.by).toBe('human:ana');
  expect(entry.text).toMatch(/^env impact 1\.freq "0:60 0\.\d+:\d+(\.\d+)?"$/);
  await page.waitForTimeout(1200);
  expect((await texts(page)).length).toBe(before.length + 1); // the drag did not split into more
  const p1 = page.getByTestId('env-point-1');
  expect(Number(await p1.getAttribute('data-t'))).toBeLessThan(t0);
  expect(Number(await p1.getAttribute('data-v'))).toBeLessThan(v0);

  // an exponential curve into the second point, an amplitude envelope, and an effect
  await page.getByTestId('env-point-1').click();
  await page.getByTestId('env-curve').selectOption('exp');
  await expect.poll(async () => (await texts(page))[0]).toMatch(/^env impact 1\.freq ".*@exp"$/);
  await page.getByTestId('fx-add-layer-reverb').click();
  await expect.poll(async () => (await texts(page))[0]).toBe('fx add impact layer=1 reverb');
  await page.getByTestId('fx-add-master-distort').click();
  await expect.poll(async () => (await texts(page))[0]).toBe('fx add impact distort');
  await expect(page.getByTestId('fx-1-1')).toHaveAttribute('data-kind', 'reverb');
  await expect(page.getByTestId('fx-M-1')).toHaveAttribute('data-kind', 'distort');

  // play it: what the page hands to Web Audio is what the server renders
  const plays = (await played(page)).length;
  await page.getByTestId('editor-play').click();
  await expect.poll(async () => (await played(page)).length).toBe(plays + 1);
  const last = (await played(page)).at(-1)!;
  const served = floatsFromBytes(new Uint8Array(await (await fetch(`http://127.0.0.1:${agent.port}/api/render/impact.f32?token=${agent.token}`)).arrayBuffer()));
  expect(last.hash).toBe(samplesHash(served));
  expect(last.id).toBe('impact');
  const cli = await agent.cli(['describe', agent.dir, 'impact']);
  expect(cli.out).toMatch(/impact: /);

  // the whole thing is commands an agent could have written
  const tape = (await texts(page)).reverse();
  expect(tape.filter((t) => t.startsWith('layer add impact osc')).length).toBe(3);
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1500, height: 1500 });
  await page.getByTestId('editor').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS, 'layered-editor.png'), fullPage: true });
  await page.getByTestId('env-editor').screenshot({ path: join(SHOTS, 'layered-envelope.png') });
});

test('the layer list: mute, solo, reorder, gain and remove are one command each', async ({ page }) => {
  await open(page, 'sound new impact voice=layered seed=1; layer add impact osc wave=sine freq=100 dur=0.2; layer add impact osc wave=saw freq=200 dur=0.2; layer add impact fm freq=300 dur=0.2');
  await expect(page.locator('[data-testid^=layer-row-]')).toHaveCount(3);
  const base = (await texts(page)).length;
  await page.getByTestId('layer-mute-2').click();
  await expect.poll(async () => (await texts(page))[0]).toBe('layer mute impact 2 on');
  await expect(page.getByTestId('layer-row-2')).toHaveClass(/muted/);
  await page.getByTestId('layer-solo-3').click();
  await expect.poll(async () => (await texts(page))[0]).toBe('layer solo impact 3 on');
  await page.getByTestId('layer-down-1').click();
  await expect.poll(async () => (await texts(page))[0]).toBe('layer move impact 1 to=2');
  await expect(page.getByTestId('layer-row-2')).toHaveAttribute('data-kind', 'osc');
  // a drag on a gain slider writes one command
  const box = (await page.getByTestId('layer-gain-1').boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.5, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.35, y, { steps: 15 });
  await page.mouse.up();
  await expect.poll(async () => (await texts(page)).length).toBe(base + 4);
  expect((await texts(page))[0]).toMatch(/^layer set impact 1 gain=0\.\d+$/);
  await page.waitForTimeout(1200);
  expect((await texts(page)).length).toBe(base + 4);
  await page.getByTestId('layer-remove-3').click();
  await expect.poll(async () => (await texts(page))[0]).toBe('layer remove impact 3');
  await expect(page.locator('[data-testid^=layer-row-]')).toHaveCount(2);
  // undo from the page brings it back
  await page.getByTestId('editor-undo').click();
  await expect(page.locator('[data-testid^=layer-row-]')).toHaveCount(3);
  // the card on the list shows the layers
  await page.getByTestId('back').click();
  await expect(page.getByTestId('params-impact')).toHaveAttribute('data-voice', 'layered');
  await expect(page.getByTestId('layer-impact-1')).toContainText('1 ');
});

const WAVES = ['sine', 'square', 'saw', 'triangle', 'pulse', 'wavetable', 'white', 'metal'];

test('the browser renders every kind of layer exactly as Node does (samples, checks, WAV)', async ({ page }) => {
  // a sample to use: a decaying chirp as a 22.05 kHz WAV
  const dir = mkdtempSync(join(tmpdir(), 'sc-sample-'));
  const x = new Float32Array(8000);
  for (let i = 0; i < x.length; i++) x[i] = Math.sin(i * (0.05 + i * 0.00002)) * (1 - i / x.length);
  const wav = join(dir, 'chirp.wav');
  writeFileSync(wav, encodeWav(x, 22050));
  try {
    agent = await startAgent();
    const imp = await agent.cli(['sample', 'import', agent.dir, wav, 'as=chirp']);
    expect(imp.code, imp.err).toBe(0);
    const script = [
      'sound new mix voice=layered seed=9',
      'layer add mix classic preset=laser presetseed=4',
      'layer add mix osc wave=pink dur=0.2 filter=bp cutoff=1800 q=3 pan=-0.6',
      'layer add mix fm ops=4 algo=pairs freq=330 index2=2 index4=3 dur=0.3 pan=0.5',
      'layer add mix ks freq=196 dur=0.6 decay=0.8 offset=0.05',
      'layer add mix sample sample=chirp pitch=5 offset=0.1',
      'env mix 2.cutoff "0:6000 0.2:300@exp"',
      'env mix 3.index2 "0:5 0.3:0@exp"',
      'env mix 5.pan "0:-1 0.4:1@ease"',
      'fx add mix layer=2 bitcrush bits=6 rate=11025',
      'fx add mix layer=3 chorus mix=0.4',
      'fx add mix distort shape=fold drive=2 mix=0.3',
      'fx add mix delay time=0.09 feedback=0.35 mix=0.25',
      'fx add mix reverb size=0.4 mix=0.2',
      'sound new waves voice=layered seed=2',
      ...WAVES.map((w, i) => `layer add waves osc wave=${w} freq=220 duty=0.3 dur=0.15 offset=${(i * 0.02).toFixed(2)}`),
      'sound new door voice=layered preset=door seed=5',
      'sound new sparkle voice=layered preset=magic seed=8',
    ].join('\n');
    const r = await agent.cli(['run', agent.dir, '-e', script]);
    expect(r.code, r.err + r.out).toBe(0);
    await page.goto(`${agent.url}&name=ana`);
    await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
    await expect(page.getByTestId('card-mix')).toBeVisible();
    for (const id of ['mix', 'waves', 'door', 'sparkle']) {
      const bytes = new Uint8Array(await (await fetch(`http://127.0.0.1:${agent.port}/api/render/${id}.f32?token=${agent.token}`)).arrayBuffer());
      const server = floatsFromBytes(bytes);
      // what the page plays (rendered in its worker, which fetches the samples it needs) is the Node render
      await page.getByTestId(`play-${id}`).click();
      await expect(page.getByTestId(`play-${id}`)).toHaveAttribute('data-plays', '1');
      const played = await page.evaluate((sid) => {
        const s = (window as unknown as { soundclaw: { played: { id: string; hash: string; samples: number }[] } }).soundclaw;
        return s.played.filter((p) => p.id === sid).at(-1)!;
      }, id);
      expect(played.hash, `${id} played`).toBe(samplesHash(server));
      // the editors render on the page's own thread, once the samples are here: the same bytes
      const mine = await page.evaluate(async (sid) => {
        const s = (window as unknown as { soundclaw: { sounds: { id: string }[]; hashOf(s: unknown): string; channels(s: unknown): Float32Array[]; ensureSamples(s: unknown): Promise<void> } }).soundclaw;
        const sound = s.sounds.find((x) => x.id === sid)!;
        await s.ensureSamples(sound);
        return { hash: s.hashOf(sound), channels: s.channels(sound).length };
      }, id);
      expect(mine.hash, id).toBe(samplesHash(server));
      expect(mine.channels).toBe(id === 'mix' || id === 'sparkle' ? 2 : 1);
      // the card's check badge is what the CLI says
      const cli = await agent.cli(['check', agent.dir, id]);
      await expect(page.getByTestId(`check-${id}`)).toHaveAttribute('data-pass', /true|false/);
      const failing = (await page.getByTestId(`check-${id}`).getAttribute('data-failing')) ?? '';
      const cliFailing = [...cli.out.matchAll(/^ {2}(\w+)\s+FAIL/gm)].map((m) => m[1]).join(',');
      expect(failing, id).toBe(cliFailing);
      // and the card's hash is the render's
      await expect(page.getByTestId(`card-${id}`)).toHaveAttribute('data-hash', samplesHash(server));
    }
    // the WAV a person downloads is the one the server exports, limiter included
    const pageWav = await page.evaluate(() => {
      const s = (window as unknown as { soundclaw: { sounds: { id: string }[]; wavOf(s: unknown): Uint8Array } }).soundclaw;
      return Array.from(s.wavOf(s.sounds.find((x) => x.id === 'mix')!));
    });
    const served = new Uint8Array(await (await fetch(`http://127.0.0.1:${agent.port}/api/render/mix.wav?token=${agent.token}`)).arrayBuffer());
    expect(Buffer.from(pageWav).equals(Buffer.from(served))).toBe(true);
    const out = join(dir, 'out');
    const ex = await agent.cli(['export', agent.dir, 'mix', '--out', out]);
    expect(ex.code, ex.err).toBe(0);
    expect(ex.out).toMatch(/layered sound, exported as WAV only \(stereo/);
    expect(Buffer.from(readFileSync(join(out, 'mix.wav'))).equals(Buffer.from(served))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
