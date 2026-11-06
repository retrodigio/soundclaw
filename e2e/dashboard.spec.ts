// The dashboard in a browser: sound cards with play buttons and waveforms, the history, Approve and
// Ask for changes reaching a waiting agent, and what plays being what the agent rendered.

import { expect, test, type Page } from '@playwright/test';
import { floatBytes, newSound, renderSound, samplesHash } from '../core/src/index.ts';
import { startAgent, type Agent } from './helpers.ts';

let agent: Agent;
test.afterEach(async () => { await agent?.close(); });

/** Record what the page hands to Web Audio, so the test can compare it with what Node renders. */
async function spyOnAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __buffers: { sampleRate: number; samples: number[] }[]; __started: number };
    w.__buffers = [];
    w.__started = 0;
    const create = AudioContext.prototype.createBuffer;
    AudioContext.prototype.createBuffer = function (this: AudioContext, ...a: [number, number, number]) {
      const b = create.apply(this, a);
      const rec = { sampleRate: b.sampleRate, samples: [] as number[] };
      w.__buffers.push(rec);
      const copy = b.copyToChannel.bind(b);
      b.copyToChannel = (src: Float32Array, ch: number, off?: number) => { copy(src as Float32Array<ArrayBuffer>, ch, off); rec.samples = Array.from(src); };
      return b;
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...a: [number?]) { w.__started++; return start.apply(this, a); };
  });
}

const commands = (page: Page) => page.locator('[data-testid=cmd-row]').evaluateAll((rows) => rows.map((r) => ({
  seq: Number((r as HTMLElement).dataset.seq), by: (r as HTMLElement).dataset.by, text: r.querySelector('code')!.textContent, undone: r.classList.contains('undone'),
})));

test('lists the sounds as cards with waveforms and the history, and follows the agent live', async ({ page }) => {
  agent = await startAgent();
  await page.goto(`${agent.url}&name=ana`);
  await expect(page.getByTestId('empty')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveAttribute('data-status', 'open');
  expect((await agent.cli(['run', agent.dir, '-e', 'sound new beep; sound set beep frequency=880 duration=0.3 volume=0.4; sound new boop; sound set boop frequency=220'])).code).toBe(0);

  const beep = page.getByTestId('card-beep');
  await expect(page.getByTestId('sounds').locator('article')).toHaveCount(2);
  await expect(beep).toHaveAttribute('data-status', 'draft');
  await expect(page.getByTestId('params-beep')).toHaveText('880 Hz0.3 svolume 0.4');
  await expect(page.getByTestId('params-boop')).toContainText('220 Hz');
  // The thumbnail is drawn: a 0.4 peak fills 40% of the height, where silence would be a line.
  await expect(page.getByTestId('wave-beep')).toHaveAttribute('data-peak', '0.4000');
  const rows = await page.getByTestId('wave-beep').evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const set = new Set<number>();
    for (let i = 3; i < d.length; i += 4) if (d[i]) set.add(Math.floor(i / 4 / c.width));
    return set.size;
  });
  expect(rows).toBeGreaterThan(15);
  expect(rows).toBeLessThan(26);
  // The card shows the same 12 digits as the CLI's result.
  const hash = samplesHash(renderSound({ ...newSound('beep'), frequency: 880, duration: 0.3, volume: 0.4 }));
  await expect(beep.getByText(`samples ${hash.slice(0, 12)}`)).toBeVisible();
  expect(await commands(page)).toEqual([
    { seq: 4, by: 'agent:claude', text: 'sound set boop frequency=220', undone: false },
    { seq: 3, by: 'agent:claude', text: 'sound new boop', undone: false },
    { seq: 2, by: 'agent:claude', text: 'sound set beep frequency=880 duration=0.3 volume=0.4', undone: false },
    { seq: 1, by: 'agent:claude', text: 'sound new beep', undone: false },
  ]);

  // Live: a change by the agent updates the card; an undo removes the sound and strikes the history.
  await agent.cli(['run', agent.dir, '-e', 'sound set boop frequency=330']);
  await expect(page.getByTestId('params-boop')).toContainText('330 Hz');
  await agent.cli(['run', agent.dir, '-e', 'sound new bop']);
  await expect(page.getByTestId('card-bop')).toBeVisible();
  await agent.cli(['run', agent.dir, '-e', 'undo']);
  await expect(page.getByTestId('card-bop')).toHaveCount(0);
  const after = await commands(page);
  expect(after[0]).toMatchObject({ text: 'undo group=g3', by: 'agent:claude', undone: false });
  expect(after[1]).toMatchObject({ text: 'sound new bop', undone: true });
  // The page loaded fresh shows the same.
  await page.reload();
  await expect(page.getByTestId('sounds').locator('article')).toHaveCount(2);
  expect(await commands(page)).toEqual(after);
});

test('the play button plays exactly the samples the agent rendered', async ({ page }) => {
  agent = await startAgent();
  await spyOnAudio(page);
  await agent.cli(['run', agent.dir, '-e', 'sound new beep; sound set beep frequency=659.25 duration=0.2 volume=0.8; sound new low; sound set low frequency=110 duration=0.1']);
  await page.goto(`${agent.url}&name=ana`);
  const play = page.getByTestId('play-beep');
  await expect(play).toHaveAttribute('data-plays', '0');
  await play.click();
  await expect(play).toHaveAttribute('data-plays', '1');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __started: number }).__started)).toBe(1);

  const doc = { ...newSound('beep'), frequency: 659.25, duration: 0.2, volume: 0.8 };
  const want = renderSound(doc);
  // 1. What the page handed to Web Audio is, sample for sample, what Node renders.
  const buffers = await page.evaluate(() => (window as unknown as { __buffers: { sampleRate: number; samples: number[] }[] }).__buffers);
  expect(buffers).toHaveLength(1);
  expect(buffers[0]!.sampleRate).toBe(44100);
  expect(buffers[0]!.samples).toHaveLength(want.length);
  expect(samplesHash(Float32Array.from(buffers[0]!.samples))).toBe(samplesHash(want));
  // 2. The page's record of the play has the hash the CLI printed for the sound.
  const played = await page.evaluate(() => (window as unknown as { soundclaw: { played: { id: string; hash: string; samples: number }[] } }).soundclaw.played);
  expect(played).toEqual([{ id: 'beep', hash: samplesHash(want), samples: want.length, key: expect.any(String) }]);
  const listed = await agent.cli(['render', agent.dir, 'beep']);
  expect(listed.out).toContain(`hash ${samplesHash(want).slice(0, 12)}`);
  // 3. And it is what the server renders and serves.
  const served = new Uint8Array(await (await fetch(`http://127.0.0.1:${agent.port}/api/render/beep.f32?token=${agent.token}`)).arrayBuffer());
  expect(Buffer.compare(Buffer.from(served), Buffer.from(floatBytes(want)))).toBe(0);
  expect(Buffer.compare(Buffer.from(floatBytes(Float32Array.from(buffers[0]!.samples))), Buffer.from(served))).toBe(0);

  // A second sound plays its own samples; playing it stops the first.
  await page.getByTestId('play-low').click();
  await expect(page.getByTestId('play-low')).toHaveAttribute('data-plays', '1');
  const low = await page.evaluate(() => (window as unknown as { soundclaw: { played: { id: string; hash: string }[] } }).soundclaw.played.at(-1));
  expect(low!.hash).toBe(samplesHash(renderSound({ ...newSound('low'), frequency: 110, duration: 0.1 })));
});

test('the browser and Node render identical samples for a range of documents', async ({ page }) => {
  agent = await startAgent();
  await agent.cli(['run', agent.dir, '-e', 'sound new a; sound set a frequency=20 duration=0.05 volume=1; sound new b; sound set b frequency=19999.5 duration=0.05; sound new c; sound set c frequency=1234.5678 duration=1.5 volume=0.123; sound new d; sound set d frequency=261.6255653 duration=0.01 volume=0']);
  await page.goto(`${agent.url}&name=ana`);
  await expect(page.getByTestId('sounds').locator('article')).toHaveCount(4);
  const fromPage = await page.evaluate(() => {
    const s = (window as unknown as { soundclaw: { sounds: unknown[]; render(s: unknown): Float32Array } }).soundclaw;
    return s.sounds.map((doc) => { const f = s.render(doc); return { id: (doc as { id: string }).id, bytes: Array.from(new Uint8Array(f.buffer, f.byteOffset, f.byteLength)) }; });
  });
  expect(fromPage.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  for (const x of fromPage) {
    const served = new Uint8Array(await (await fetch(`http://127.0.0.1:${agent.port}/api/render/${x.id}.f32?token=${agent.token}`)).arrayBuffer());
    expect(Buffer.compare(Buffer.from(x.bytes), Buffer.from(served)), x.id).toBe(0);
  }
});

test('Ask for changes reaches a waiting agent; the card follows claim, progress, a question, the answer and done', async ({ page }) => {
  agent = await startAgent();
  await agent.cli(['run', agent.dir, '-e', 'sound new beep voice=classic; sound set beep wave=sine attack=0.05 sustain=0.3 decay=0.4 freq=0.5 volume=0.15']);
  await page.goto(`${agent.url}&name=ana`);
  const card = page.getByTestId('card-beep');
  await expect(page.getByTestId('listener-chip')).toHaveAttribute('data-listening', 'false');

  // The agent waits in the background; the page shows it is listening.
  const waiting = agent.background(['await', agent.dir, '--timeout', '60']);
  await expect(page.getByTestId('listener-chip')).toHaveAttribute('data-listening', 'true');
  await expect(page.getByTestId('listener-chip')).toContainText('agent:claude is listening');

  await card.getByTestId('reject-beep').click();
  await expect(card.getByTestId('reject-send-beep')).toBeDisabled();
  await card.getByTestId('reject-text-beep').fill('a little lower and softer');
  await card.getByTestId('reject-send-beep').click();
  await expect(card.getByTestId('request-r1')).toBeVisible();

  const done = await waiting.done;
  expect(done.code).toBe(0);
  expect(done.out).toContain('request r1 (beep) from human:ana');
  expect(done.out).toContain('"a little lower and softer"');
  await expect(card.getByTestId('request-r1')).toHaveAttribute('data-state', 'open');
  await expect(card.getByTestId('request-r1')).toContainText('seen by agent:claude');
  await expect(card).toHaveAttribute('data-status', 'rejected');
  await expect(page.getByTestId('requests-count')).toHaveText('1 request for the agent');
  expect((await commands(page))[0]).toMatchObject({ by: 'human:ana', text: 'sound mark beep rejected "a little lower and softer"' });

  expect((await agent.cli(['work', agent.dir, 'claim'])).out).toMatch(/^claimed r1/);
  await expect(card.getByTestId('request-r1')).toHaveAttribute('data-state', 'claimed');
  await expect(card.getByTestId('request-r1')).toContainText('agent:claude is working on it');
  await agent.cli(['work', agent.dir, 'progress', 'lowering it']);
  await expect(card.getByTestId('working')).toHaveText('lowering it');
  await agent.cli(['work', agent.dir, 'block', 'How much lower: a third or an octave?']);
  await expect(card.getByTestId('question-r1')).toHaveText('The agent asks: “How much lower: a third or an octave?”');
  await card.getByTestId('reply-text-r1').fill('an octave');
  await card.getByTestId('reply-send-r1').click();
  await expect(card.getByTestId('request-r1')).toHaveAttribute('data-state', 'open');

  // The answer wakes the next await.
  const second = await agent.cli(['await', agent.dir, '--timeout', '30', '--since', /next cursor: (\S+)/.exec(done.out)![1]!]);
  expect(second.code).toBe(0);
  expect(second.out).toContain('reply r1 (beep) from human:ana');
  expect(second.out).toContain('an octave');
  expect((await agent.cli(['work', agent.dir, 'claim', 'r1'])).out).toContain('The person answered: "an octave"');
  expect((await agent.cli(['run', agent.dir, '-e', 'sound set beep freq=0.3'])).code).toBe(0);
  await expect(page.getByTestId('param-beep-freq')).toHaveText('freq 0.3');
  await agent.cli(['work', agent.dir, 'done', 'freq 0.5 → 0.3']);
  await expect(card.getByTestId('done-r1')).toHaveText('✓ done: freq 0.5 → 0.3');
  await expect(page.getByTestId('requests-count')).toHaveText('0 requests for the agent');
});

test('Approve marks the sound, tells a waiting agent, and Undo takes it back', async ({ page }) => {
  agent = await startAgent();
  await agent.cli(['run', agent.dir, '-e', 'sound new beep']);
  await page.goto(`${agent.url}&name=ana`);
  const card = page.getByTestId('card-beep');
  const waiting = agent.background(['await', agent.dir, '--timeout', '60']);
  await expect(page.getByTestId('listener-chip')).toHaveAttribute('data-listening', 'true');
  await card.getByTestId('approve-beep').click();
  const done = await waiting.done;
  expect(done.out).toContain('approved beep from human:ana');
  expect(done.out).toContain('next: history');
  await expect(card).toHaveAttribute('data-status', 'approved');
  await expect(page.getByTestId('status-beep')).toHaveText('approved');
  await expect(card.getByTestId('approve-beep')).toBeDisabled();
  expect((await commands(page))[0]).toMatchObject({ by: 'human:ana', text: 'sound mark beep approved' });
  await page.getByTestId('undo').click();
  await expect(card).toHaveAttribute('data-status', 'draft');
  expect((await commands(page))[0]).toMatchObject({ by: 'human:ana', text: 'undo group=g2' });
  await page.getByTestId('redo').click();
  await expect(card).toHaveAttribute('data-status', 'approved');
});

test('a request with nobody listening says so and offers a prompt', async ({ page }) => {
  agent = await startAgent();
  await agent.cli(['run', agent.dir, '-e', 'sound new beep']);
  await page.goto(`${agent.url}&name=ana`);
  const card = page.getByTestId('card-beep');
  await card.getByTestId('reject-beep').click();
  await card.getByTestId('reject-text-beep').fill('shorter');
  await card.getByTestId('reject-send-beep').click();
  await expect(card.getByTestId('no-listener')).toContainText('No agent is listening for requests.');
  await card.getByTestId('copy-prompt').click();
  await expect(card.getByTestId('prompt-text')).toContainText('soundclaw work');
  await expect(card.getByTestId('prompt-text')).toContainText('soundclaw await');
  // An agent that starts to wait is told of it at once, and the warning goes.
  const waiting = agent.background(['await', agent.dir, '--timeout', '30']);
  const got = await waiting.done;
  expect(got.out).toContain('request r1 (beep) from human:ana');
  await expect(card.getByTestId('request-r1')).toContainText('seen by agent:claude');
  await expect(card.getByTestId('no-listener')).toHaveCount(0);
  // A person can withdraw a request.
  await card.getByTestId('request-r1').getByTestId('cancel-r1').click();
  await expect(card.getByTestId('request-r1')).toHaveAttribute('data-state', 'cancelled');
});

test('a page writes as the name it is given, and refuses a bad one', async ({ page }) => {
  agent = await startAgent();
  await page.goto(`${agent.url}&name=bo`);
  await expect(page.getByTestId('author')).toHaveValue('bo');
  await agent.cli(['run', agent.dir, '-e', 'sound new beep']);
  await page.getByTestId('approve-beep').click();
  await expect(page.getByTestId('status-beep')).toHaveText('approved');
  expect((await commands(page))[0]).toMatchObject({ by: 'human:bo' });
  await page.getByTestId('author').fill('not ok!');
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('status-beep')).toHaveText('draft');
  // A name that is not allowed leaves the previous one in force.
  expect((await commands(page))[0]).toMatchObject({ by: 'human:bo' });
});

const PASSING = 'sound new beep voice=classic; sound set beep wave=sine attack=0.05 sustain=0.3 decay=0.4 freq=0.3 volume=0.15';

test('a classic card shows its 25 parameters read-only, a waveform and a spectrogram, and a check badge that follows the sound', async ({ page }) => {
  agent = await startAgent();
  expect((await agent.cli(['run', agent.dir, '-e', `${PASSING}; sound new zap voice=classic preset=laser seed=1`])).code).toBe(0);
  await page.goto(`${agent.url}&name=ana`);
  const beep = page.getByTestId('card-beep');
  await expect(page.getByTestId('sounds').locator('article')).toHaveCount(2);

  // The parameters: all 25, as values, nothing to edit yet.
  const params = beep.getByTestId('params-beep');
  await expect(params).toHaveAttribute('data-voice', 'classic');
  await expect(params.locator('[data-testid^="param-beep-"]')).toHaveCount(25);
  await expect(beep.getByTestId('param-beep-wave')).toHaveText('wave sine');
  await expect(beep.getByTestId('param-beep-freq')).toHaveText('freq 0.3');
  await expect(beep.getByTestId('param-beep-volume')).toHaveText('volume 0.15');
  await expect(beep.getByTestId('param-beep-attack')).toHaveText('attack 0.05');
  await expect(params.locator('input, select, textarea, [contenteditable]')).toHaveCount(0);

  // The thumbnails are drawn: the waveform has height, and the spectrogram has many colours.
  await expect(beep.getByTestId('wave-beep')).toHaveAttribute('data-peak', /^0\.[3-9]/);
  const colours = await beep.getByTestId('spec-beep').evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const set = new Set<number>();
    for (let i = 0; i < d.length; i += 4) set.add((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!);
    return { n: set.size, w: c.width, h: c.height, alpha: d[3] };
  });
  expect(colours).toMatchObject({ w: 240, h: 48, alpha: 255 });
  expect(colours.n).toBeGreaterThan(25);
  await expect(beep.getByTestId('spec-beep')).toHaveAttribute('data-bands', '48');

  // The badge says what the CLI says.
  await expect(beep.getByTestId('check-beep')).toHaveAttribute('data-pass', 'true');
  await expect(beep.getByTestId('check-beep')).toHaveText('✓ checks pass');
  const zap = page.getByTestId('card-zap');
  await expect(zap.getByTestId('check-zap')).toHaveAttribute('data-pass', 'false');
  const cli = await agent.cli(['check', agent.dir, 'zap']);
  const failing = [...cli.out.matchAll(/^ {2}(\w+) +FAIL/gm)].map((m) => m[1]).join(',');
  expect(failing).not.toBe('');
  await expect(zap.getByTestId('check-zap')).toHaveAttribute('data-failing', failing);
  await expect(zap.getByTestId('check-zap')).toHaveAttribute('title', /^checks: \d\/5 pass; failing: /);

  // The agent changes the sound: the card, the badge and the thumbnail follow.
  await agent.cli(['run', agent.dir, '-e', 'sound set beep volume=0.6']);
  await expect(beep.getByTestId('check-beep')).toHaveAttribute('data-pass', 'false');
  await expect(beep.getByTestId('param-beep-volume')).toHaveText('volume 0.6');
  await agent.cli(['run', agent.dir, '-e', 'sound set beep volume=0.15']);
  await expect(beep.getByTestId('check-beep')).toHaveAttribute('data-pass', 'true');
});

test('the browser and Node render identical doubles for classic patches, noise and sine included', async ({ page }) => {
  agent = await startAgent();
  const patches: [string, string][] = [
    ['sq', 'wave=0,freq=0.4,sustain=0.1,decay=0.1,duty=0.3,dutySweep=0.2'],
    ['saw', 'wave=1,freq=0.5,sustain=0.1,decay=0.1,slide=-0.3,phaserOffset=0.5,phaserSweep=-0.1'],
    ['sine', 'wave=2,freq=0.35,sustain=0.15,decay=0.1,slide=0.2,deltaSlide=-0.4,lowPass=0.6,resonance=0.5'],
    ['vib', 'wave=2,freq=0.3,sustain=0.2,decay=0.1,vibratoDepth=0.6,vibratoSpeed=0.7,vibratoDelay=0.2'],
    ['noise', 'wave=3,freq=0.45,sustain=0.15,decay=0.2,highPass=0.3,lowPassSweep=-0.3'],
    ['seeded', 'wave=3,freq=0.45,sustain=0.15,decay=0.2,seed=4242'],
    ['rep', 'wave=1,freq=0.5,sustain=0.3,decay=0.1,slide=0.3,repeatSpeed=0.6,changeAmount=0.5,changeSpeed=0.5'],
  ];
  const cmds = patches.map(([id, p]) => `sound new ${id} voice=classic; sound patch ${id} "${p}"`).join('; ');
  expect((await agent.cli(['run', agent.dir, '-e', cmds])).code).toBe(0);
  await page.goto(`${agent.url}&name=ana`);
  await expect(page.getByTestId('sounds').locator('article')).toHaveCount(patches.length);
  const fromPage = await page.evaluate(() => {
    const s = (window as unknown as { soundclaw: { sounds: { id: string }[]; exact(s: unknown): Float64Array } }).soundclaw;
    return s.sounds.map((doc) => { const f = s.exact(doc); return { id: doc.id, bytes: Array.from(new Uint8Array(f.buffer, f.byteOffset, f.byteLength)) }; });
  });
  expect(fromPage.map((x) => x.id).sort()).toEqual(patches.map(([id]) => id).sort());
  for (const x of fromPage) {
    const served = new Uint8Array(await (await fetch(`http://127.0.0.1:${agent.port}/api/render/${x.id}.f64?token=${agent.token}`)).arrayBuffer());
    expect(served.length, x.id).toBeGreaterThan(1000);
    expect(Buffer.compare(Buffer.from(x.bytes), Buffer.from(served)), x.id).toBe(0);
  }
});
