// Screenshots of the dashboard on an invented example project: a few sounds, a set, a song and
// requests in different states. Run it after `pnpm build`:
//   node scripts/screens-studio.ts <name>          saves PNGs to .dev/screens/studio/<name>/
// It starts its own server on a temporary project and stops it; nothing is left running.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { startAgent, type Agent } from '../e2e/helpers.ts';

const name = process.argv[2];
if (!name) throw new Error('usage: node scripts/screens-studio.ts <name>');
const OUT = join(import.meta.dirname, '..', '.dev', 'screens', 'studio', name);
mkdirSync(OUT, { recursive: true });

const SOUNDS = `sound new laser voice=classic preset=laser seed=3
sound new coin_pickup voice=classic preset=pickup seed=5
sound new explosion_big voice=classic preset=explosion seed=7
sound new jump voice=classic preset=jump seed=2
sound new ui_select voice=classic preset=blip seed=4
sound new footstep_base voice=layered preset=footstep seed=11
set new footsteps_grass from=footstep_base count=4 as=footstep_grass_01,footstep_grass_02,footstep_grass_03,footstep_grass_04 class=foley spread="1.freq±12% *.gain±20%" seed=2
`;

const SONG = `song new battle_loop tempo=140 key=D:minor
song channel add battle_loop lead inst=pulse_lead gain=0.8 layer=tension
song channel add battle_loop bass inst=triangle_bass layer=base
song channel add battle_loop drums kit=default layer=base
pattern battle_loop.verse steps=16 tpb=4 bar=8
  lead: D5 . . . F5 . E5 . | D5 . . . A4 . . .
  bass: D2 . . . D2 . . . | A1 . . . A1 . . .
  drums: k . h . s . h . | k . h . s . h h
song section add battle_loop A verse
song loop battle_loop A..A
`;

async function ask(page: Page, sound: string, note: string): Promise<void> {
  await page.evaluate(([s, n]) => (window as unknown as { soundclaw: { askForChanges(s: string, n: string): Promise<unknown> } }).soundclaw.askForChanges(s!, n!), [sound, note]);
}

async function project(): Promise<Agent> {
  const a = await startAgent();
  for (const script of [SOUNDS, SONG]) {
    const r = await a.cli(['run', a.dir, '-e', script]);
    if (r.code !== 0) throw new Error(r.err || r.out);
  }
  return a;
}

interface Variant { file: string; theme: 'dark' | 'light'; density: 'compact' | 'comfortable'; w: number; h: number; hash?: string; palette?: boolean; typed?: string; full?: boolean; select?: string; rail?: boolean }

const VARIANTS: Variant[] = [
  { file: 'kit-dark', theme: 'dark', density: 'compact', w: 1440, h: 900, hash: '#/kit', full: true },
  { file: 'kit-light', theme: 'light', density: 'compact', w: 1440, h: 900, hash: '#/kit', full: true },
  ...(['dark', 'light'] as const).flatMap((theme) => (['compact', 'comfortable'] as const).flatMap((density) => [
    { file: `shell-${theme}-${density}`, theme, density, w: 1440, h: 900, select: 'coin_pickup' },
    { file: `shell-${theme}-${density}-palette`, theme, density, w: 1440, h: 900, select: 'coin_pickup', palette: true, typed: 'make the coin brighter' },
  ] as Variant[])),
  { file: 'shell-dark-compact-1024', theme: 'dark', density: 'compact', w: 1024, h: 768, select: 'coin_pickup' },
  { file: 'shell-dark-compact-1024-rail', theme: 'dark', density: 'compact', w: 1024, h: 768, select: 'coin_pickup', rail: true },
  { file: 'shell-dark-compact-760', theme: 'dark', density: 'compact', w: 760, h: 900, select: 'coin_pickup' },
  { file: 'shell-light-compact-760-palette', theme: 'light', density: 'compact', w: 760, h: 900, select: 'coin_pickup', palette: true },
];

const agent = await project();
const browser = await chromium.launch();
try {
  let n = 0;
  for (const v of VARIANTS) {
    n++;
    const ctx = await browser.newContext({ viewport: { width: v.w, height: v.full ? 3300 : v.h }, reducedMotion: 'reduce' });
    await ctx.addInitScript((p) => { try { localStorage.setItem('soundclaw.prefs', JSON.stringify(p)); } catch { /* storage off */ } }, { theme: v.theme, density: v.density });
    const page = await ctx.newPage();
    await page.goto(`${agent.url}&name=ana${v.hash ?? ''}`);
    await page.getByTestId('connection').and(page.locator('[data-status=open]')).waitFor();
    if (!v.hash) {
      if (v.w < 900) { await page.keyboard.press('Alt+1'); }
      await page.getByTestId('lib-row-coin_pickup').waitFor();
      // requests in different states (made once, from the first page)
      if (v === VARIANTS.find((x) => !x.hash)) {
        await ask(page, 'laser', 'Shorten the laser tail');
        await ask(page, 'footstep_grass_01', 'Footsteps on grass softer, less samey');
        await ask(page, 'jump', 'Make the jump feel lighter');
        await ask(page, 'explosion_big', 'Less harsh in the top');
        await agent.cli(['work', agent.dir, 'list']);
        await agent.cli(['work', agent.dir, 'claim', 'r1']);
        await agent.cli(['work', agent.dir, 'progress', 'r1', 'shortened the decay, checking the tail']);
        await agent.cli(['work', agent.dir, 'claim', 'r2']);
        await agent.cli(['work', agent.dir, 'block', 'r2', 'Should the variants keep the same pitch?']);
        await agent.cli(['work', agent.dir, 'claim', 'r3']);
        await agent.cli(['work', agent.dir, 'done', 'r3', 'lowered sustain and attack']);
        await page.waitForTimeout(300);
        await ask(page, 'coin_pickup', 'Brighter, and a little shorter');
      }
      // the agent changes two sounds while the page is open: a "new" dot on each
      await agent.cli(['run', agent.dir, '-e', `sound set jump decay=${(0.3 + n / 100).toFixed(2)}; sound set ui_select decay=${(0.2 + n / 100).toFixed(2)}`, '--by', 'agent:claude']);
      await page.getByTestId('lib-row-jump').and(page.locator('[data-new=true]')).waitFor();
      if (v.select) await page.getByTestId(`lib-row-${v.select}`).click();
      if (v.w < 900) await page.keyboard.press('Escape');
      await page.waitForTimeout(700);
      if (v.rail) await page.getByTestId('rail-strip-btn').click();
    } else await page.waitForTimeout(400);
    if (v.palette) {
      await page.keyboard.press('Control+k');
      await page.getByTestId('palette-input').waitFor();
      if (v.typed) await page.getByTestId('palette-input').fill(v.typed);
      await page.waitForTimeout(150);
    }
    const file = join(OUT, `${v.file}-${v.w}x${v.h}.png`);
    await page.screenshot({ path: file, fullPage: false });
    if (v.full) {
      // the kit is long: crop to its content
      const h = await page.evaluate(() => document.querySelector<HTMLElement>('.page')!.scrollHeight + 90);
      await page.screenshot({ path: file, clip: { x: 0, y: 0, width: v.w, height: Math.min(h, 3300) } });
    }
    console.log(file);
    await ctx.close();
  }
} finally {
  await browser.close();
  await agent.close();
}
