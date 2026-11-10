// Screenshots of the dashboard's sample views at 1440 x 900 on an invented example project (samples made by test code, takes from the free test
// provider, a small library of generated one-shots). Run it after `pnpm build`:
//   node scripts/screens-samples.ts            saves PNGs to .dev/screens/samples/
// It starts its own server on a temporary project, uses Chromium's fake microphone, and stops everything it started.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { pcmFromFloats } from '../core/src/index.ts';
import { wavBytes } from '../core/test/audio-fixtures.ts';
import { toneFloats } from '../core/test/sample-golden-table.ts';
import { makeSamples } from '../e2e/example.ts';
import { startAgent } from '../e2e/helpers.ts';

const OUT = join(import.meta.dirname, '..', '.dev', 'screens', 'samples');
mkdirSync(OUT, { recursive: true });

const agent = await startAgent();
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  await makeSamples(agent);
  const run = async (script: string, by = 'agent:claude') => { const r = await agent.cli(['run', agent.dir, '-e', script, '--by', by]); if (r.code !== 0) throw new Error(r.err || r.out); };
  await run('sound new knock voice=layered seed=3\nlayer add knock osc wave=sine freq=120 dur=0.2\nlayer add knock sample sample=door_hits');
  await run('instrument new creak_pad kind=zones\ninstrument zone add creak_pad sample=hum_tone root=A3 keys=A2-A4');

  for (const theme of ['dark', 'light'] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'], reducedMotion: 'reduce' });
    await ctx.addInitScript((t) => { try { localStorage.setItem('soundclaw.prefs', JSON.stringify({ theme: t, density: 'compact', panels: { bottomOpen: true } })); localStorage.setItem('soundclaw.homeAll', '1'); } catch { /* off */ } }, theme);
    const page = await ctx.newPage();
    const suffix = theme === 'dark' ? '' : '-light';
    const shot = async (name: string, wait = 400) => { await page.waitForTimeout(wait); await page.screenshot({ path: join(OUT, `${name}${suffix}.png`) }); };
    const open = async (hash: string, ready: string) => {
      await page.goto('about:blank');
      await page.goto(`${agent.url}&name=ana${hash}`);
      await page.getByTestId('connection').waitFor();
      await page.getByTestId(ready).first().waitFor({ timeout: 30_000 });
    };
    const lens = async () => { await page.getByTestId('snum-length').waitFor({ timeout: 30_000 }); };

    // the library's Samples tab: project, filtered, the agent's new sample, library, takes
    await open('#/', 'home');
    await page.getByTestId('lib-tab-samples').click();
    await page.getByTestId('sample-numbers-door_hits').waitFor();
    await page.getByTestId('lib-row-door_hits').locator('svg.mini-wave').waitFor({ timeout: 20_000 });
    await shot('samples-project');
    const f = join(agent.root, `agent_hit_${theme}.wav`);
    writeFileSync(f, wavBytes(pcmFromFloats([toneFloats(44100, 0.3)], 44100, 'pcm16')));
    await agent.cli(['sample', 'import', agent.dir, f, 'licence=own', 'tags=tone']);
    await page.getByTestId(`sample-new-agent_hit_${theme}`).waitFor();
    await shot('samples-project-agent-new');
    await page.getByTestId('lib-filter').fill('dur>1.4 pitched=yes');
    await shot('samples-project-filtered', 700);
    await page.getByTestId('lib-filter').fill('dur<');
    await shot('samples-project-bad-query');
    await page.getByTestId('lib-filter').fill('');
    await page.getByTestId('samples-mode-library').click();
    await page.getByTestId('library-hit').first().waitFor();
    await page.getByTestId('lib-filter').fill('creak');
    await page.waitForTimeout(600);
    await shot('samples-library');
    await page.getByTestId('samples-mode-takes').click();
    await page.getByTestId('take-creak_gen_t1').waitFor();
    await page.getByTestId('keep-creak_gen_t1').click();
    await page.getByTestId('keep-name').fill('door_creak');
    await shot('samples-takes-keep');

    // the sample page
    await open('#/sample/door_hits', 'sample-page');
    await lens();
    await shot('sample-page-waveform');
    await page.getByTestId('tool-slice').click();
    await shot('sample-page-slices');
    await page.getByTestId('lens-tab-spec').click();
    await shot('sample-page-spectrogram');
    await page.getByTestId('lens-tab-compare').click();
    await page.getByTestId('compare-other').selectOption('sample:hum_tone');
    await page.getByTestId('compare-summary').waitFor({ timeout: 30_000 });
    await shot('sample-page-compare');
    await page.evaluate(() => document.querySelector('.page')?.scrollTo(0, 99999));
    await shot('sample-page-lower');
    await page.getByTestId('sample-derive').click();
    await page.getByTestId('derive-dialog').waitFor();
    await shot('sample-derive-dialog');
    await page.keyboard.press('Escape');
    await open('#/sample/hum_tone', 'sample-page');
    await lens();
    await page.getByTestId('tool-loop').click();
    await shot('sample-page-loop-handles');
    await page.getByTestId('lens-tab-loop').click();
    await page.getByTestId('seam-numbers').waitFor();
    await shot('sample-page-loop-seam');
    await open('#/sample/door_hits/layer/knock/2', 'sample-page');
    await lens();
    await shot('sample-page-trim-from-layer');
    await open('#/sample/creak_gen_t1', 'sample-page');
    await lens();
    await page.getByTestId('prov-prompt').waitFor();
    await page.evaluate(() => document.querySelector('.page')?.scrollTo(0, 99999));
    await shot('sample-page-generated');
    await page.evaluate(() => document.querySelector('.page')?.scrollTo(0, 0));
    await page.getByTestId('sample-again').click();
    await page.getByTestId('again-estimate').waitFor({ timeout: 20_000 });
    await shot('sample-generate-again');
    await page.keyboard.press('Escape');
    await page.getByTestId('sample-instrument').click();
    await shot('sample-instrument-dialog');
    await page.keyboard.press('Escape');

    // dropping, recording, dragging to a layer list
    await open('#/sound/knock', 'editor');
    await page.getByTestId('lib-tab-samples').click();
    await page.getByTestId('lib-row-door_hits').waitFor();
    await page.getByTestId('layer-strips').waitFor();
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('application/x-soundclaw-sample', 'door_hits');
      document.querySelector('[data-testid=layers]')!.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await shot('samples-drag-to-layers');
    await open('#/', 'home');
    const knock = wavBytes(pcmFromFloats([toneFloats(44100, 0.4)], 44100, 'pcm16'));
    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'Wooden Knock.wav', { type: 'audio/wav' }));
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      (window as unknown as { __dt: DataTransfer }).__dt = dt;
    }, Buffer.from(knock).toString('base64'));
    await shot('samples-drop-veil');
    await page.evaluate(() => window.dispatchEvent(new DragEvent('drop', { dataTransfer: (window as unknown as { __dt: DataTransfer }).__dt, bubbles: true, cancelable: true })));
    await page.getByTestId('import-dialog').waitFor();
    await shot('samples-import-dialog');
    await page.keyboard.press('Escape');
    await page.getByTestId('transport-record').click();
    const dlg = page.getByTestId('record-dialog');
    await dlg.getByTestId('record-status').waitFor();
    await page.waitForFunction(() => Number(document.querySelector('[data-testid=record-meter]')?.getAttribute('data-db')) > -50, undefined, { timeout: 15_000 }).catch(() => undefined);
    await shot('samples-record-ready', 100);
    await dlg.getByTestId('record-start').click();
    await page.waitForTimeout(1500);
    await dlg.getByTestId('record-stop').click();
    await dlg.getByTestId('record-name').waitFor();
    await shot('samples-record-done');
    await ctx.close();
  }
  console.log(`saved to ${OUT}`);
} finally {
  await browser.close();
  await agent.close();
}
