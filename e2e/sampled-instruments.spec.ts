// A song with sampled instruments (velocity layers with a crossfade, a looped sustain, a release sample, round robins, a kit with a choke group)
// renders in the page to the bytes Node renders, whole and as a loop. The audio is made here from integers; nothing is read from disk.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { pcmFromFloats, sinRad } from '../core/src/index.ts';
import { lcg, wavBytes } from '../core/test/audio-fixtures.ts';
import { test } from './fixtures.ts';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

type SongPlayed = { id: string; mode: string; hash: string; muted: string[] };
const songsPlayed = (page: Page): Promise<SongPlayed[]> => page.evaluate(() => (window as unknown as { soundclaw: { songsPlayed: SongPlayed[] } }).soundclaw.songsPlayed);

const SR = 44100;
const steady = (hz: number, secs: number): Float32Array => {
  const x = new Float32Array(Math.round(SR * secs));
  for (let i = 0; i < x.length; i++) { const t = (i / SR) * 6.283185307179586; x[i] = 0.4 * sinRad(t * hz) + 0.15 * sinRad(t * hz * 2); }
  return x;
};
const burst = (seed: number, secs: number, level: number): Float32Array => {
  const r = lcg(seed);
  const x = new Float32Array(Math.round(SR * secs));
  for (let i = 0; i < x.length; i++) x[i] = (r() * 2 - 1) * level * (1 - i / x.length);
  return x;
};

test('a song of sampled instruments renders in the page to the bytes Node renders, whole and as a loop', async ({ page }) => {
  test.setTimeout(150_000);
  const dir = mkdtempSync(join(tmpdir(), 'sc-sampled-'));
  try {
    const files: Record<string, Float32Array> = {
      string: steady(220, 1), pluck: steady(330, 0.4), tick: burst(5, 0.08, 0.5),
      thump1: burst(11, 0.2, 0.6), thump2: burst(12, 0.2, 0.6), thump3: burst(13, 0.2, 0.6),
      closed: burst(21, 0.1, 0.5), open: burst(22, 0.9, 0.5),
    };
    agent = await startAgent();
    for (const [name, x] of Object.entries(files)) {
      writeFileSync(join(dir, `${name}.wav`), wavBytes(pcmFromFloats([x], SR, 'pcm16')));
      const r = await agent.cli(['sample', 'import', agent.dir, join(dir, `${name}.wav`), 'licence=own']);
      expect(r.code, r.err).toBe(0);
    }
    const setup = `sample loop string 0.2 0.6
instrument new keys kind=zones
instrument set keys adsr=0.01,0.1,0.8,0.25 velxfade=12 range=C3-C5
instrument zone add keys sample=string root=A3 keys=C3-D#4 vel=1-70 gain=-6
instrument zone add keys sample=string root=A3 keys=C3-D#4 vel=71-127
instrument zone add keys sample=pluck root=E4 keys=E4-C5
instrument zone add keys sample=tick root=A3 keys=C3-C5 trigger=release release-decay=4 gain=-12 loopmode=oneshot
instrument new thumps kind=zones
instrument set thumps rr=hash
instrument zone add thumps sample=thump1 root=C3 keys=C3-C3 rr=1/3 loopmode=oneshot
instrument zone add thumps sample=thump2 root=C3 keys=C3-C3 rr=2/3 loopmode=oneshot
instrument zone add thumps sample=thump3 root=C3 keys=C3-C3 rr=3/3 loopmode=oneshot
instrument new cycle from=thumps
instrument set cycle rr=cycle
instrument new hats kind=zones
instrument set hats pitched=no
instrument zone add hats sample=closed root=C3 hit=hc choke=1 loopmode=oneshot
instrument zone add hats sample=open root=C3 hit=ho choke=1 loopmode=oneshot
song new demo tempo=240 key=C:major
song channel add demo lead inst=keys gain=0.8
song channel add demo hits inst=thumps gain=0.6
song channel add demo again inst=cycle gain=0.6
song channel add demo hat kit=hats
pattern demo.a steps=8 tpb=2 bar=4
  lead: C4v40 . E4v100 . | G4v68 - A3v90 .
  hits: C3 . C3 . | C3 C3 . C3
  again: C3 C3 C3 . | . C3 C3 .
  hat: ho . . hc | . ho hc .
pattern demo.b steps=8 tpb=2 bar=4
  lead: A3v127 - C4v71 . | E4v80 - . .
  hits: C3 . . C3 | C3 . C3 .
  again: C3 . C3 C3 | C3 C3 . .
  hat: hc . ho . | hc . . ho
song section add demo A a
song section add demo B b
song loop demo A..B
`;
    const run = await agent.cli(['run', agent.dir, '-e', setup]);
    expect(run.code, run.err).toBe(0);
    const checks = await agent.cli(['check', agent.dir, 'keys']);
    expect(checks.out).toMatch(/^keys: /);
    const cli = JSON.parse((await agent.cli(['render', agent.dir, 'demo', '--json'])).out) as { hashes: { full: string; loop: string } };
    await page.goto(`${agent.url}&name=ana`);
    await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
    await expect(page.getByTestId('song-demo')).toBeVisible();
    await page.getByTestId('song-play-demo').click();
    await expect(page.getByTestId('song-demo')).toHaveAttribute('data-playing', 'true', { timeout: 60_000 });
    expect((await songsPlayed(page))[0]).toMatchObject({ id: 'demo', mode: 'full', muted: [] });
    expect((await songsPlayed(page))[0]!.hash).toBe(cli.hashes.full);
    await expect(page.getByTestId('song-demo')).toHaveAttribute('data-playing', 'false', { timeout: 30_000 });
    await page.getByTestId('song-loop-demo').click();
    await expect(page.getByTestId('song-demo')).toHaveAttribute('data-mode', 'loop', { timeout: 60_000 });
    expect((await songsPlayed(page)).at(-1)!.hash).toBe(cli.hashes.loop);
    await page.getByTestId('song-loop-demo').click();
    await expect(page.getByTestId('song-demo')).toHaveAttribute('data-playing', 'false');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
