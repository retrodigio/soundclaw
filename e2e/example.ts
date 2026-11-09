// The invented example project the walking specs (contrast, narrow widths) and the screenshots use:
// classic and layered sounds, a set of footsteps with a moment and several versions, a layered song
// with an agent's arp that masks the lead, and requests in every lane, one of them ready for review.
// Then the list of screens, each with the address, what it waits for and what it does first.

import type { Page } from '@playwright/test';
import type { Agent } from './helpers.ts';

export const SOUNDS = `sound new laser voice=classic preset=laser seed=3
sound new coin_pickup voice=classic preset=pickup seed=5
sound set coin_pickup wave=square volume=0.45 sustain=0.08 decay=0.3 punch=0.32 freq=0.62
sound new jump voice=classic preset=jump seed=2
sound new ui_select voice=classic preset=blip seed=4
sound new coin_click voice=classic
sound set coin_click wave=square attack=0 sustain=0.1 decay=0.3 freq=0.5 volume=0.245
sound new explosion_big voice=layered seed=7
layer add explosion_big osc wave=brown dur=0.9 gain=0.8
layer add explosion_big osc wave=white dur=0.5 gain=0.5 offset=0.01
layer add explosion_big osc wave=sine freq=48 dur=1.2 gain=0.7
layer add explosion_big fm freq=70 dur=0.14 gain=0.6
fx add explosion_big layer=1 filter type=lp cutoff=1800 q=1.2
fx add explosion_big layer=1 distort drive=4
fx add explosion_big layer=1 compress threshold=-18 ratio=4
fx add explosion_big layer=2 filter type=bp cutoff=3100 q=1.4
fx add explosion_big layer=3 filter type=lp cutoff=120
env explosion_big 1.amp "0:0 0.004:1 0.9:0@exp"
env explosion_big 3.amp "0:0 0.008:1 1.2:0@exp"
sound new footstep_base voice=layered preset=footstep seed=11
set new footsteps_grass from=footstep_base count=4 as=footstep_grass_01,footstep_grass_02,footstep_grass_03,footstep_grass_04 class=foley spread="1.freq±12% *.gain±20%" seed=2
set moment footsteps_grass "The player walks slowly across a meadow at night. Steps repeat every 0.4 s under quiet music, for a minute or more."
`;

export const SONG = `song new battle_loop tempo=140 key=D:minor
song set battle_loop gain=0.55
song channel add battle_loop drums kit=default layer=base gain=0.5
song channel add battle_loop bass inst=triangle_bass layer=base gain=0.5
song channel add battle_loop pad inst=saw_pad layer=base gain=0.25
song channel add battle_loop lead inst=pulse_lead layer=intensity gain=0.8
song channel add battle_loop arp inst=pulse_lead layer=intensity gain=0.8
song send battle_loop reverb size=0.55
song send battle_loop delay time=0.21 feedback=0.35
song channel set battle_loop pad reverb=0.4
song channel set battle_loop lead reverb=0.2 delay=0.25 pan=-0.15
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
song section add battle_loop A verse x2
song section add battle_loop B build x2
song loop battle_loop A..B
`;

/** The agent's part of the song: an arp under the lead in the build (it masks the lead). */
export const SONG_AGENT = `pattern battle_loop.build steps=16 tpb=4 bar=8
  drums: k . h k s . h . | k . h k s . h h
  bass: D2 . D2 . D2 . F2 . | A#1 . A#1 . C2 . C2 .
  pad: D3+F3+A3 - - - - - - - | A#2+D3+F3 - - - - - - -
  lead: D5 - - - F5 - A5 - | D5 - - - A5 - F5 -
  arp: D5 F5 A5 F5 D5 F5 A5 F5 | D5 F5 A5 F5 D5 F5 A5 F5
song channel set battle_loop arp pan=0.25 reverb=0.2
`;

/** Make the example on a running server: sounds, the set's versions, the song, and requests in every lane (r1 ready for review). */
export async function makeExample(a: Agent): Promise<void> {
  const cli = async (args: string[]) => { const r = await a.cli(args); if (r.code !== 0) throw new Error(`${args.join(' ')}: ${r.err || r.out}`); return r; };
  const run = (script: string, by: string) => cli(['run', a.dir, '-e', script, '--by', by]);
  await run(SOUNDS + SONG, 'human:ana');
  await run(SONG_AGENT, 'agent:claude');
  // versions in the set: some by the agent, some by the person
  await run('sound set footstep_grass_01 seed=21', 'agent:claude');
  await run('sound mark footstep_grass_01 approved', 'human:ana');
  await run('sound set footstep_grass_02 seed=41', 'human:ana');
  await run('sound set footstep_grass_02 seed=57', 'agent:claude');
  await run('sound set footstep_grass_03 seed=33', 'human:ana');
  await run('sound set footstep_grass_04 out=-5.5', 'agent:claude');
  const ask = (sound: string, note: string, target?: string) => cli(['request', a.dir, sound, '--note', note, '--by', 'human:ana', ...(target ? ['--target', target] : [])]);
  await ask('coin_click', 'brighter, less clicky', 'param attack'); // r1: ready for review
  await cli(['work', a.dir, 'claim', 'r1', '--by', 'agent:claude']);
  await run('sound set coin_click attack=0.02 freq=0.55', 'agent:claude');
  await cli(['work', a.dir, 'done', 'r1', 'Raised the start pitch a little and gave it a 20 ms attack, which was the click.', '--by', 'agent:claude']);
  await ask('explosion_big', 'less harsh around 3 kHz'); // r2: blocked
  await cli(['work', a.dir, 'claim', 'r2', '--by', 'agent:wren']);
  await cli(['work', a.dir, 'block', 'r2', 'Roll off the top, or notch 3 kHz only?', '--by', 'agent:wren']);
  await ask('laser', 'Shorten the laser tail', 'range 0.31-0.38'); // r3: claimed
  await cli(['work', a.dir, 'claim', 'r3', '--by', 'agent:fox']);
  await ask('footstep_grass_01', 'Footsteps on grass softer, less samey'); // r4: working
  await cli(['work', a.dir, 'claim', 'r4', '--by', 'agent:otter']);
  await cli(['work', a.dir, 'progress', 'r4', 'mutating 8 variants at spread 0.15', '--by', 'agent:otter']);
  await ask('battle_loop', 'arp masks lead, bars 3-4', 'bars 3-4 lead'); // r5: seen
  await cli(['work', a.dir, 'list', '--by', 'agent:heron']);
  await ask('jump', 'a little higher at the top'); // r6: sent
  await run(Array.from({ length: 6 }, (_, i) => `sound mutate laser amount=0.1 seed=${40 + i} as=laser_v${i + 1}`).join('\n'), 'agent:otter');
  await run('sound set jump punch=0.4', 'human:ana');
}

export interface Screen {
  name: string;
  hash: string;
  /** A test id that is on screen once the page is drawn. */
  ready: string;
  /** What to do once it is drawn (open a dialog, switch a lens, inject a state). */
  act?: (p: Page) => Promise<void>;
}

/** Take focus off whatever has it (the page's keys then act on the page, not on a focused list or field). */
export const unfocus = (p: Page) => p.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });

const lens = (key: string): ((p: Page) => Promise<void>) => async (p) => {
  await unfocus(p);
  await p.keyboard.press(key);
  await p.waitForTimeout(250);
};

/** Every screen of the dashboard on the example project (the empty and offline states have their own project and step). */
export const SCREENS: Screen[] = [
  { name: 'home', hash: '#/', ready: 'home' },
  { name: 'classic', hash: '#/sound/coin_pickup', ready: 'editor' },
  { name: 'layered', hash: '#/sound/explosion_big', ready: 'editor' },
  { name: 'layered-device', hash: '#/sound/explosion_big', ready: 'editor', act: async (p) => { await p.getByTestId('fx-1-1').click(); await p.getByTestId('fx-panel-1-1').waitFor(); } },
  ...(['1', '2', '3', '4', '5'] as const).map((k) => ({ name: `analysis-${k}`, hash: '#/sound/laser/analysis', ready: 'analysis-page', act: lens(k) })),
  { name: 'set', hash: '#/set/footsteps_grass', ready: 'set-page' },
  { name: 'ab', hash: '#/set/footsteps_grass', ready: 'set-page', act: async (p) => { await p.getByTestId('ab-card').scrollIntoViewIfNeeded(); await p.getByTestId('ab-matched').waitFor({ timeout: 20_000 }); } },
  { name: 'audition', hash: '#/audition', ready: 'audition' },
  { name: 'song', hash: '#/song/battle_loop', ready: 'song-editor' },
  { name: 'mixer', hash: '#/song/battle_loop/mixer', ready: 'song-editor' },
  { name: 'session', hash: '#/session', ready: 'session' },
  { name: 'review', hash: '#/review/r1', ready: 'review-item' },
  { name: 'kit', hash: '#/kit', ready: 'kit' },
  { name: 'palette', hash: '#/sound/coin_pickup', ready: 'editor', act: async (p) => { await p.getByTestId('open-palette').click(); await p.getByRole('dialog').first().waitFor(); await p.keyboard.type('make the coin brighter'); } },
  { name: 'shortcuts', hash: '#/', ready: 'home', act: async (p) => { await unfocus(p); await p.keyboard.press('?'); await p.getByRole('dialog').first().waitFor(); } },
  { name: 'composer', hash: '#/sound/laser', ready: 'editor', act: async (p) => { await unfocus(p); await p.keyboard.press('r'); await p.getByTestId('composer').waitFor(); } },
  {
    name: 'mid-batch', hash: '#/session', ready: 'session', act: async (p) => {
      await p.evaluate(() => {
        const s = (window as unknown as { soundclaw: { receive(m: unknown): void } }).soundclaw;
        const b = (done: number, label: string) => ({ id: 'b9', by: 'agent:otter', total: 8, done, label, state: 'running', startedAt: '' });
        s.receive({ type: 'batchProgress', phase: 'start', batch: b(0, '') });
        for (let i = 1; i <= 3; i++) s.receive({ type: 'batchProgress', phase: 'item', batch: b(i, `sound mutate footstep_base amount=0.15 seed=44${i} as=grass_v${i}`) });
      });
      await p.getByTestId('session-batch').waitFor();
    },
  },
  {
    // a big project's first second: nothing is known yet about any sound (the cards are still being worked out)
    name: 'streaming', hash: '#/', ready: 'home', act: async (p) => {
      await p.evaluate(() => {
        const s = (window as unknown as { soundclaw: { index: { info?: unknown }[]; changed(): void } }).soundclaw;
        s.index = s.index.map((x, i) => (i % 3 === 0 ? x : { ...x, info: undefined }));
        s.changed();
      });
      await p.getByTestId('home-thumb-progress').waitFor();
    },
  },
];
