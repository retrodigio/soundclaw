// Screenshots of the dashboard on an invented example project: a few sounds, a set, a song and
// requests in different states. Run it after `pnpm build`:
//   node scripts/screens-studio.ts <name> [sounds|sets|songs]  saves PNGs to .dev/screens/studio/<name>/ (with `sounds`: the sound pages; `sets`: a set's page, the blind A/B card and the audition page; `songs`: a song's arrangement and split editor, and the mixer)
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

// ---- the sound pages: the editors and the analysis lenses (`node scripts/screens-studio.ts <name> sounds`) ----

const SOUNDS_ST2 = `sound new laser voice=classic preset=laser seed=3
sound new coin_pickup voice=classic preset=pickup seed=5
sound set coin_pickup wave=square volume=0.45 sustain=0.08 decay=0.3 punch=0.32 freq=0.62
sound new explosion_big voice=layered seed=7
layer add explosion_big osc wave=brown dur=0.9 gain=0.8
layer add explosion_big osc wave=white dur=0.5 gain=0.5 offset=0.01
layer add explosion_big osc wave=sine freq=48 dur=1.2 gain=0.7
layer add explosion_big fm freq=70 dur=0.14 gain=0.6
fx add explosion_big layer=1 filter type=lp cutoff=1800 q=1.2
fx add explosion_big layer=1 distort drive=4
fx add explosion_big layer=1 compress threshold=-18 ratio=4
fx add explosion_big layer=2 filter type=bp cutoff=3100 q=1.4
fx add explosion_big layer=2 reverb size=0.4 mix=0.18
fx add explosion_big layer=3 filter type=lp cutoff=120
env explosion_big 1.amp "0:0 0.004:1 0.9:0@exp"
env explosion_big 3.amp "0:0 0.008:1 1.2:0@exp"
`;

/** The agent claims a request on `sound`, writes `script`, and says why. */
async function agentChange(a: Agent, page: Page, sound: string, request: string, script: string, note: string): Promise<void> {
  await ask(page, sound, request);
  await a.cli(['work', a.dir, 'claim']);
  const r = await a.cli(['run', a.dir, '-e', script, '--by', 'agent:claude']);
  if (r.code !== 0) throw new Error(r.err || r.out);
  await a.cli(['work', a.dir, 'progress', note]);
}

async function soundShots(): Promise<void> {
  const a = await startAgent();
  const browser = await chromium.launch();
  try {
    const r = await a.cli(['run', a.dir, '-e', SOUNDS_ST2]);
    if (r.code !== 0) throw new Error(r.err || r.out);
    let first = true;
    const shots: { file: string; theme: 'dark' | 'light'; density: 'compact' | 'comfortable'; hash: string; lens?: string; wait: string; w?: number; h?: number; extra?: (p: Page) => Promise<void> }[] = [];
    for (const theme of ['dark', 'light'] as const) {
      shots.push({ file: `home-${theme}`, theme, density: 'compact', hash: '#/', wait: 'home' });
      shots.push({ file: `classic-${theme}-compact`, theme, density: 'compact', hash: '#/sound/coin_pickup', wait: 'editor' });
      shots.push({ file: `classic-${theme}-modules`, theme, density: 'compact', hash: '#/sound/coin_pickup', wait: 'editor', extra: async (p) => { await p.getByTestId('knob-decay').focus(); await p.getByTestId('module-1').scrollIntoViewIfNeeded(); await p.evaluate(() => document.querySelector('.page')?.scrollBy(0, 420)); await p.waitForTimeout(300); } });
      shots.push({ file: `layered-${theme}-compact`, theme, density: 'compact', hash: '#/sound/explosion_big', wait: 'editor' });
      for (const [key, lens] of [['1', 'wave'], ['2', 'spec'], ['3', 'pitch'], ['4', 'compare'], ['5', 'nums']] as const) {
        shots.push({ file: `analysis-${lens}-${theme}`, theme, density: 'compact', hash: '#/sound/laser/analysis', lens: key, wait: 'analysis-page' });
      }
    }
    shots.push({ file: 'analysis-wave-dark-1024', theme: 'dark', density: 'compact', hash: '#/sound/laser/analysis', lens: '1', wait: 'analysis-page', w: 1024, h: 768 });
    shots.push({ file: 'classic-dark-comfortable', theme: 'dark', density: 'comfortable', hash: '#/sound/coin_pickup', wait: 'editor' });
    shots.push({ file: 'layered-dark-comfortable', theme: 'dark', density: 'comfortable', hash: '#/sound/explosion_big', wait: 'editor' });
    shots.push({ file: 'layered-dark-device-open', theme: 'dark', density: 'compact', hash: '#/sound/explosion_big', wait: 'editor', extra: async (p) => { await p.getByTestId('fx-1-1').click(); await p.getByTestId('fx-panel-1-1').scrollIntoViewIfNeeded(); await p.waitForTimeout(300); } });
    for (const v of shots) {
      const ctx = await browser.newContext({ viewport: { width: v.w ?? 1440, height: v.h ?? 900 }, reducedMotion: 'reduce' });
      await ctx.addInitScript((p) => { try { localStorage.setItem('soundclaw.prefs', JSON.stringify(p)); } catch { /* storage off */ } }, { theme: v.theme, density: v.density, panels: { bottomOpen: v.hash === '#/' } });
      const page = await ctx.newPage();
      await page.goto(`${a.url}&name=ana${v.hash}`);
      await page.getByTestId('connection').and(page.locator('[data-status=open]')).waitFor();
      if (first) {
        first = false;
        // the agent changes a coin parameter, a laser decay (for Compare) and adds a device to the explosion, each answering a request
        await agentChange(a, page, 'coin_pickup', 'Shorter, so a run of coins does not blur', 'sound set coin_pickup decay=0.22 sustain=0.05', 'shorter, so a run of coins does not blur');
        await a.cli(['run', a.dir, '-e', 'sound set laser decay=0.3', '--by', 'agent:claude']);
        await ask(page, 'explosion_big', 'More weight under the crack');
        await a.cli(['work', a.dir, 'claim']);
        await a.cli(['run', a.dir, '-e', 'fx add explosion_big layer=3 limit ceiling=-2', '--by', 'agent:claude']);
        await a.cli(['work', a.dir, 'progress', 'added a limiter so the sub weight does not push the master']);
        await page.waitForTimeout(600);
      }
      await page.waitForTimeout(500);
      await page.getByTestId(v.wait).first().waitFor();
      await page.getByTestId('lens-measuring').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined);
      if (v.lens) {
        await page.locator('body').click({ position: { x: 4, y: 4 } });
        // a selection and a cursor, then the lens
        const box = (await page.getByTestId('lens-surface').boundingBox())!;
        await page.mouse.move(box.x + box.width * 0.58, box.y + box.height * 0.5);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.82, box.y + box.height * 0.5, { steps: 8 });
        await page.mouse.up();
        await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4);
        await page.keyboard.press(v.lens);
        if (v.lens === '2') await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.55);
        else await page.mouse.move(box.x + box.width * 0.5, box.y - 80);
        await page.waitForTimeout(700);
      }
      if (v.extra) await v.extra(page);
      await page.waitForTimeout(700);
      const file = join(OUT, `${v.file}-${v.w ?? 1440}x${v.h ?? 900}.png`);
      await page.screenshot({ path: file });
      console.log(file);
      await ctx.close();
    }
  } finally {
    await browser.close();
    await a.close();
  }
}

// ---- sets and audition: the clip grid and the blind A/B card (`node scripts/screens-studio.ts <name> sets`) ----

const SET_ST3 = `sound new laser voice=classic preset=laser seed=3
sound new coin_pickup voice=classic preset=pickup seed=5
sound new jump voice=classic preset=jump seed=2
sound new footstep_base voice=layered preset=footstep seed=11
set new footsteps_grass from=footstep_base count=4 as=footstep_grass_01,footstep_grass_02,footstep_grass_03,footstep_grass_04 class=foley spread="1.freq±12% *.gain±20%" seed=2
set moment footsteps_grass "The player walks slowly across a meadow at night. Steps repeat every 0.4 s under quiet music, for a minute or more."
`;

async function setShots(): Promise<void> {
  const a = await startAgent();
  const browser = await chromium.launch();
  const run = async (script: string, by: string) => { const r = await a.cli(['run', a.dir, '-e', script, '--by', by]); if (r.code !== 0) throw new Error(r.err || r.out); };
  try {
    await run(SET_ST3, 'agent:claude');
    // versions: the agent's and a person's, an approval, a proposal still open and one member pushed quiet (the spread warning)
    await run('sound set footstep_grass_01 seed=21', 'agent:claude');
    await run('sound mark footstep_grass_01 approved', 'human:ana');
    await run('sound set footstep_grass_02 seed=41', 'human:ana');
    await run('sound set footstep_grass_02 seed=57', 'agent:claude');
    await run('sound set footstep_grass_03 seed=33', 'human:ana');
    await run('sound set footstep_grass_03 seed=34', 'human:ana');
    await run('sound set footstep_grass_04 out=-5.5', 'agent:claude');
    const shots: { file: string; theme: 'dark' | 'light'; hash: string; act?: (p: Page) => Promise<void> }[] = [];
    for (const theme of ['dark', 'light'] as const) {
      shots.push({ file: `set-${theme}`, theme, hash: '#/set/footsteps_grass' });
      shots.push({ file: `ab-answered-${theme}`, theme, hash: '#/set/footsteps_grass', act: async (p) => {
        await p.locator('body').click({ position: { x: 4, y: 4 } });
        await p.keyboard.press('a');
        await p.getByTestId('ab-recorded').waitFor();
        await p.getByTestId('ab-card').scrollIntoViewIfNeeded();
      } });
      shots.push({ file: `audition-${theme}`, theme, hash: '#/audition', act: async (p) => {
        await p.getByTestId('cell-footstep_grass_02').click();
        await p.getByTestId('cell-footstep_grass_03').click({ modifiers: ['Shift'] });
        await p.keyboard.press('c');
        await p.getByTestId('ab-matched').waitFor({ timeout: 20_000 });
      } });
    }
    for (const v of shots) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
      await ctx.addInitScript((p) => { try { localStorage.setItem('soundclaw.prefs', JSON.stringify(p)); } catch { /* storage off */ } }, { theme: v.theme, density: 'compact', panels: { bottomOpen: false, railOpen: false } });
      const page = await ctx.newPage();
      await page.goto(`${a.url}&name=ana${v.hash}`);
      await page.getByTestId('connection').and(page.locator('[data-status=open]')).waitFor();
      await page.getByTestId(v.hash.startsWith('#/set') ? 'set-page' : 'audition').waitFor();
      if (v.hash.startsWith('#/set')) await page.getByTestId('ab-matched').waitFor({ timeout: 20_000 });
      await page.waitForTimeout(800);
      if (v.act) await v.act(page);
      await page.waitForTimeout(600);
      const file = join(OUT, `${v.file}-1440x900.png`);
      await page.screenshot({ path: file });
      console.log(file);
      await ctx.close();
    }
  } finally {
    await browser.close();
    await a.close();
  }
}

// ---- songs: the arrangement with the split editor, and the mixer (`node scripts/screens-studio.ts <name> songs`) ----

const BATTLE = `song new battle_loop tempo=140 key=D:minor
song set battle_loop gain=0.55
song channel add battle_loop drums kit=default layer=base gain=0.5
song channel add battle_loop bass inst=triangle_bass layer=base gain=0.5
song channel add battle_loop pad inst=saw_pad layer=base gain=0.25
song channel add battle_loop lead inst=pulse_lead layer=intensity gain=0.8
song channel add battle_loop arp inst=pulse_lead layer=intensity gain=0.8
song channel add battle_loop choir inst=fm_bell layer=boss gain=0.5
song send battle_loop reverb size=0.55
song send battle_loop delay time=0.21 feedback=0.35
song channel set battle_loop pad reverb=0.4
song channel set battle_loop lead reverb=0.2 delay=0.25 pan=-0.15
song channel set battle_loop choir reverb=0.55
pattern battle_loop.intro steps=16 tpb=4 bar=8
  drums: k . . . k . . . | k . . . k . h h
  pad: D3+F3+A3 - - - - - - - | A#2+D3+F3 - - - - - - -
pattern battle_loop.verse steps=16 tpb=4 bar=8
  drums: k . h . s . h . | k . h . s . h h
  bass: D2 . D2 . D2 . F2 . | A#1 . A#1 . C2 . C2 .
  pad: D3+F3+A3 - - - - - - - | A#2+D3+F3 - - - - - - -
  lead: D5 - - - F5 - A5 - | D5 - - - A5 - F5 -
pattern battle_loop.build steps=16 tpb=4 bar=8
  drums: k . h k s . h . | k . h k s . h h
  bass: D2 . D2 . D2 . F2 . | A#1 . A#1 . C2 . C2 .
  pad: D3+F3+A3 - - - - - - - | A#2+D3+F3 - - - - - - -
  lead: D5 - - - F5 - A5 - | D5 - - - A5 - F5 -
pattern battle_loop.boss steps=16 tpb=4 bar=8
  drums: k . h k s . h k | k . h k s k h h
  bass: D2 D2 D2 . D2 . F2 F2 | A#1 A#1 A#1 . C2 . C2 C2
  pad: D3+F3+A3 - - - - - - - | A#2+D3+F3 - - - - - - -
  lead: D5 - - - F5 - A5 - | D5 - - - A5 - F5 -
  choir: D5+A5 - - - - - - - | F5+C6 - - - - - - -
song section add battle_loop intro intro
song section add battle_loop A verse x4
song section add battle_loop B build x4
song section add battle_loop C boss x4
song intro battle_loop intro
`;
// the agent adds an arp that plays under the lead in the build and the boss, and sets its pan and reverb
const BATTLE_AGENT = `pattern battle_loop.build steps=16 tpb=4 bar=8
  drums: k . h k s . h . | k . h k s . h h
  bass: D2 . D2 . D2 . F2 . | A#1 . A#1 . C2 . C2 .
  pad: D3+F3+A3 - - - - - - - | A#2+D3+F3 - - - - - - -
  lead: D5 - - - F5 - A5 - | D5 - - - A5 - F5 -
  arp: D5 F5 A5 F5 D5 F5 A5 F5 | D5 F5 A5 F5 D5 F5 A5 F5
pattern battle_loop.boss steps=16 tpb=4 bar=8
  drums: k . h k s . h k | k . h k s k h h
  bass: D2 D2 D2 . D2 . F2 F2 | A#1 A#1 A#1 . C2 . C2 C2
  pad: D3+F3+A3 - - - - - - - | A#2+D3+F3 - - - - - - -
  lead: D5 - - - F5 - A5 - | D5 - - - A5 - F5 -
  arp: D5 F5 A5 F5 D5 F5 A5 F5 | D5 F5 A5 F5 D5 F5 A5 F5
  choir: D5+A5 - - - - - - - | F5+C6 - - - - - - -
song channel set battle_loop arp pan=0.25 reverb=0.2
`;

async function songShots(): Promise<void> {
  const a = await startAgent();
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const run = async (script: string, by: string) => { const r = await a.cli(['run', a.dir, '-e', script, '--by', by]); if (r.code !== 0) throw new Error(r.err || r.out); };
  try {
    await run(BATTLE, 'human:ana');
    await run(BATTLE_AGENT, 'agent:claude');
    const shots: { file: string; theme: 'dark' | 'light'; density?: 'compact' | 'comfortable'; hash: string; panels?: Record<string, unknown>; act: (p: Page) => Promise<void> }[] = [];
    for (const theme of ['dark', 'light'] as const) {
      // the arrangement with the masking flag, the agent's arp, a selection in the roll and the text lit
      shots.push({ file: `song-${theme}`, theme, hash: '#/song/battle_loop', act: async (p) => {
        await p.locator('[data-testid^=flag-label-masking-]').first().waitFor({ timeout: 60_000 });
        await p.getByTestId('seam-badge').waitFor();
        await p.locator('[data-testid^=flag-label-masking-]').first().click();
        await p.getByTestId('roll-tab-lead').click();
        await p.getByTestId('roll-lead').waitFor();
        const svg = p.getByTestId('roll-grid-lead');
        await svg.scrollIntoViewIfNeeded();
        await p.getByTestId('note-lead-4-F5').click();
        await p.getByTestId('note-lead-6-A5').click({ modifiers: ['Shift'] });
        await p.getByTestId('note-lead-12-A5').click({ modifiers: ['Shift'] });
        await p.getByTestId('tok-sel').first().waitFor();
        await p.evaluate(() => document.getElementById('page')?.scrollTo(0, 0));
        await p.mouse.move(2, 2);
      } });
      // the same page with the inspector open on the changes
      shots.push({ file: `song-inspector-${theme}`, theme, hash: '#/song/battle_loop', act: async (p) => {
        await p.locator('[data-testid^=flag-label-masking-]').first().waitFor({ timeout: 60_000 });
        await p.getByTestId('inspector-toggle').click();
        await p.getByTestId('insp-tab-changes').click();
        await p.getByTestId('changes-pending').waitFor();
      } });
      // a bar selection for a request, with the text in an error state
      shots.push({ file: `song-bars-${theme}`, theme, density: 'comfortable', hash: '#/song/battle_loop', act: async (p) => {
        await p.locator('[data-testid^=flag-label-masking-]').first().waitFor({ timeout: 60_000 });
        const r = (await p.getByTestId('bar-ruler').boundingBox())!;
        await p.mouse.move(r.x + r.width * 0.55, r.y + 40);
        await p.mouse.down();
        await p.mouse.move(r.x + r.width * 0.7, r.y + 40, { steps: 6 });
        await p.mouse.up();
        await p.getByTestId('tab-boss').click();
        await p.getByTestId('pattern-text-area').click({ position: { x: 90, y: 60 } });
        await p.keyboard.type('Q9');
        await p.getByTestId('pattern-text-error').and(p.locator('[data-error=true]')).waitFor();
      } });
      // the mixer during playback
      shots.push({ file: `mixer-${theme}`, theme, hash: '#/song/battle_loop/mixer', panels: { libOpen: false }, act: async (p) => {
        await p.locator('[data-testid^=mask-link-]').first().waitFor({ timeout: 60_000 });
        await p.getByRole('button', { name: /^▶ Play$/ }).click();
        await p.getByTestId('song-editor').and(p.locator('[data-playing=true]')).waitFor({ timeout: 60_000 });
        await p.waitForFunction(() => (window as unknown as { soundclaw: { meters: { frames: number } } }).soundclaw.meters.frames > 40, undefined, { timeout: 30_000 });
        await p.waitForTimeout(3500);
      } });
      shots.push({ file: `mixer-bottom-${theme}`, theme, hash: '#/song/battle_loop', panels: { bottomOpen: true, bottomTab: 'mixer', bottomH: 300 }, act: async (p) => {
        await p.getByTestId('play-song').click();
        await p.getByTestId('song-editor').and(p.locator('[data-playing=true]')).waitFor({ timeout: 60_000 });
        await p.waitForFunction(() => (window as unknown as { soundclaw: { meters: { frames: number } } }).soundclaw.meters.frames > 40, undefined, { timeout: 30_000 });
        await p.waitForTimeout(2500);
      } });
    }
    for (const v of shots.filter((x) => !process.argv[4] || x.file.includes(process.argv[4]))) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
      await ctx.addInitScript((p) => { try { localStorage.setItem('soundclaw.prefs', JSON.stringify(p.prefs)); localStorage.setItem('soundclaw.songInspector', '0'); } catch { /* storage off */ } }, { prefs: { theme: v.theme, density: v.density ?? 'compact', panels: { bottomOpen: false, railOpen: false, ...(v.panels ?? {}) } } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.log('PAGE ERROR', v.file, e.stack));
      await page.goto(`${a.url}&name=ana${v.hash}`);
      await page.getByTestId('connection').and(page.locator('[data-status=open]')).waitFor();
      await page.getByTestId('song-editor').waitFor();
      await page.waitForTimeout(800);
      try { await v.act(page); } catch (e) { console.log('FAILED', v.file, await page.getByTestId('error').allTextContents()); await page.screenshot({ path: join(OUT, `${v.file}-failed.png`) }); throw e; }
      await page.waitForTimeout(500);
      const file = join(OUT, `${v.file}-1440x900.png`);
      await page.screenshot({ path: file });
      console.log(file);
      await ctx.close();
    }
  } finally {
    await browser.close();
    await a.close();
  }
}

if (process.argv[3] === 'sets') { await setShots(); process.exit(0); }
if (process.argv[3] === 'sounds') { await soundShots(); process.exit(0); }
if (process.argv[3] === 'songs') { await songShots(); process.exit(0); }

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
