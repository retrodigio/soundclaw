// The layered voice through the writer: sample import and the refusal of a missing sample, stereo
// renders through the cache, numbers and checks (harsh, from the project style), export (WAV
// only, the limiter, notes), the layers view, undo, and the classic mark.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeWav, encodeWav, parse, renderChannels, samplesHash, joinChannels } from '@soundclaw/core';
import { Writer, importPath, checkText, collectChanges, describeText, exportFormat, formatExportFiles, loadProject, soundSummary, viewSound } from '../src/index.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
const claude = 'agent:claude';
beforeEach(() => { f = fixture(); });
afterEach(() => f.clean());
const run = (commands: string, w: Writer = f.w) => { const r = w.run({ commands, by: claude }); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r; };
const fail = (commands: string) => { const r = f.w.run({ commands, by: claude }); if (r.ok) throw new Error('expected an error'); return r.errors.map((e) => e.message).join('; '); };

function wavFile(name: string, frames = 4000, rate = 22050): string {
  const x = new Float32Array(frames);
  for (let i = 0; i < frames; i++) x[i] = Math.sin(i * 0.07) * (1 - i / frames);
  const file = join(f.root, name);
  writeFileSync(file, encodeWav(x, rate));
  return file;
}

/** Import one file the way `soundclaw sample import` does. */
const imp = (file: string, as?: string) => importPath(f.w, file, { ...(as ? { as } : {}), by: claude });
const impOne = (file: string, as?: string) => imp(file, as).items[0]!;

describe('samples', () => {
  it('imports a WAV into the store, by file name or as=<name>, and lists it', () => {
    const file = wavFile('Thump Hit.wav');
    const r = impOne(file);
    expect(r.info.name).toBe('Thump_Hit'); // the case of the file name is kept, as a sound id's is
    expect(r.created).toBe(true);
    // the audio is in samples/objects/<first two hex>/<hash>.wav; the name is on the tape
    expect(readFileSync(join(f.dir, 'samples', 'objects', r.info.sha256.slice(0, 2), `${r.info.sha256}.wav`)).length).toBe(r.info.bytes);
    expect(f.w.tape().at(-1)!.cmd).toMatch(/^sample add Thump_Hit hash=[0-9a-f]{64} rate=22050 channels=1 frames=4000 format=pcm16/);
    expect(impOne(file, 'other').info.name).toBe('other');
    expect(f.w.samples.list().map((s) => s.name)).toEqual(['other', 'Thump_Hit']);
    expect(f.w.samples.info('other')).toMatchObject({ rate: 22050, frames: 4000 });
    expect(f.w.snapshot().samples.map((s) => s.name)).toEqual(['other', 'Thump_Hit']);
    // two names, one object
    expect(readdirSync(join(f.dir, 'samples', 'objects', r.info.sha256.slice(0, 2)))).toHaveLength(1);
  });
  it('keeps the case of a name: a layer finds it by exactly that name, and a name that differs only in case is refused', () => {
    const a = wavFile('a.wav');
    impOne(a, 'BigBoom');
    expect(f.w.samples.list().map((s) => s.name)).toEqual(['BigBoom']);
    expect(f.w.samples.get('BigBoom')).toBeDefined();
    expect(f.w.samples.get('bigboom')).toBeUndefined();
    run('sound new s voice=layered');
    expect(fail('layer add s sample sample=bigboom')).toMatch(/names sample 'bigboom', which is not in the project/);
    run('layer add s sample sample=BigBoom');
    expect(f.w.render('s').samples.length).toBeGreaterThan(3000);
    expect(impOne(a, 'BigBoom').created).toBe(false);
    expect(() => imp(wavFile('b.wav', 3000), 'bigboom')).toThrow(/clashes with the sample 'BigBoom'.*ignoring case/);
    expect(() => imp(a, 'BIGBOOM')).toThrow(/clashes with the sample 'BigBoom'/);
    expect(f.w.samples.list()).toHaveLength(1);
  });
  it('the same file again is a no-op; another file under the same name is refused; bad names and non-audio files are refused with a reason', () => {
    const a = wavFile('a.wav');
    impOne(a, 'x');
    const tape = f.w.tape().length;
    expect(impOne(a, 'x').created).toBe(false);
    expect(f.w.tape().length).toBe(tape);
    expect(() => imp(wavFile('b.wav', 3000), 'x')).toThrow(/exists with other audio/);
    expect(() => imp(a, 'Bad Name')).toThrow(/not a sample name/);
    writeFileSync(join(f.root, 'junk.wav'), 'not a wav at all, really');
    expect(() => imp(join(f.root, 'junk.wav'), 'junk')).toThrow(/not a WAV, AIFF or FLAC/);
    expect(() => imp(join(f.root, 'nope.wav'))).toThrow(/no file/);
  });
  it('a sample layer must name a sample in the project: the batch is refused, nothing is written', () => {
    run('sound new s voice=layered');
    const before = f.w.tape().length;
    expect(fail('layer add s sample sample=ghost')).toMatch(/names sample 'ghost', which is not in the project \(soundclaw sample import/);
    expect(fail('layer add s sample')).toMatch(/has no sample/);
    expect(f.w.tape().length).toBe(before);
    impOne(wavFile('ghost.wav'), 'ghost');
    run('layer add s sample sample=ghost');
    expect(f.w.render('s').samples.length).toBeGreaterThan(3000);
  });
  it('the render follows the sample: pointing the name at other audio renders again, and undo brings the old audio back', () => {
    impOne(wavFile('a.wav'), 'a');
    run('sound new s voice=layered; layer add s sample sample=a');
    const first = f.w.render('s');
    const second = impOne((() => { const file = join(f.root, 'c.wav'); writeFileSync(file, encodeWav(Float32Array.from({ length: 3000 }, (_, i) => Math.sin(i * 0.3) * 0.5), 22050)); return file; })(), 'c');
    run(`sample set a hash=${second.info.sha256} rate=22050 channels=1 frames=3000 format=pcm16`);
    const changed = f.w.render('s');
    expect(changed.key).not.toBe(first.key);
    expect(changed.samples.length).not.toBe(first.samples.length);
    run('undo');
    const back = f.w.render('s');
    expect(back.key).toBe(first.key);
    expect(samplesHash(back.samples)).toBe(samplesHash(first.samples));
  });
});

describe('rendering through the writer', () => {
  const SCRIPT = 'sound new s voice=layered seed=2; layer add s osc wave=sine freq=300 dur=0.3 pan=-1; layer add s osc wave=saw freq=300 dur=0.3 pan=1';
  it('a stereo sound has two channels through the cache, which serves the same bytes again (memory and a fresh Writer)', () => {
    run(SCRIPT);
    const a = f.w.render('s');
    expect(a.channels).toHaveLength(2);
    expect(a.cached).toBe(false);
    const again = f.w.render('s');
    expect(again.cached).toBe(true);
    expect(samplesHash(joinChannels(again.channels))).toBe(samplesHash(joinChannels(a.channels)));
    const w2 = f.reopen();
    const disk = w2.render('s');
    expect(disk.cached).toBe(true);
    expect(disk.channels).toHaveLength(2);
    expect(samplesHash(joinChannels(disk.channels))).toBe(samplesHash(joinChannels(a.channels)));
    expect(samplesHash(joinChannels(a.channels))).toBe(samplesHash(joinChannels(renderChannels(w2.sound('s')))));
    expect(w2.samplesHashOf('s')).toBe(f.w.samplesHashOf('s'));
  });
  it('the summary and describe say stereo and count both channels', () => {
    run(SCRIPT);
    expect(soundSummary(f.w, 's')).toMatch(/^s: layered 2 layers \[1 osc sine 300 Hz; 2 osc saw 300 Hz\], stereo → \d+ samples × 2 channels/);
    expect(describeText(f.w, 's')).toMatch(/stereo/);
    expect(describeText(f.w, 's')).toMatch(/2 channels: stereo/);
  });
  it('layered edits are commands on the tape and undo/redo bring them back', () => {
    run('sound new s voice=layered seed=1');
    run('layer add s osc freq=300');
    run('fx add s layer=1 reverb mix=0.5');
    run('env s 1.amp adsr(0.01,0.1,0.5,0.1)');
    const after = soundSummary(f.w, 's');
    run('undo');
    expect(f.w.sound('s')).toMatchObject({ layers: [{ amp: null }] });
    run('undo');
    expect((f.w.sound('s') as { layers: { fx: unknown[] }[] }).layers[0]!.fx).toHaveLength(0);
    run('redo');
    run('redo');
    expect(soundSummary(f.w, 's')).toBe(after);
    expect(f.w.history({ sound: 's' }).map((e) => e.cmd.split(' ')[0])).toEqual(['sound', 'layer', 'fx', 'env']);
    expect(f.w.history().map((e) => e.cmd.split(' ')[0])).toEqual(['sound', 'layer', 'fx', 'env', 'undo', 'undo', 'redo', 'redo']);
    expect(readFileSync(join(f.dir, 'sounds', 's.sfx'), 'utf8')).toContain('env 1.amp "0:0 0.01:1 0.11:0.5@exp 0.21:0@exp"');
    const w2 = f.reopen();
    expect(soundSummary(w2, 's')).toBe(after);
  });
});

describe('checks on layered sounds', () => {
  it('all six checks run (harsh included) and `check` names each; the harsh limit comes from the project style', () => {
    run('sound new h voice=layered; layer add h osc wave=sine freq=3000 dur=0.4');
    run('env h 1.amp "0:0 0.01:0.5 0.39:0.5 0.4:0"');
    const text = checkText(f.w, ['h']).text;
    expect(text).toMatch(/harsh\s+FAIL.*sustained 2-5 kHz band -?\d+\.\d dBFS, 1 stretch over; held to at most -20\.0 dBFS for 80 ms/);
    expect(text).toMatch(/flagged 0\.\d+-0\.\d+ s: 2-5 kHz band above -20\.0 dBFS for \d+ ms/);
    expect(text).toContain('all of clip, loudness, dc, click, tail, harsh');
    // a project that allows more
    const pj = join(f.dir, 'project.json');
    const j = JSON.parse(readFileSync(pj, 'utf8'));
    j.style = { harshLimitDb: -3 };
    writeFileSync(pj, JSON.stringify(j));
    const w2 = new Writer(loadProject(f.dir));
    expect(w2.measure('h').checks.find((c) => c.name === 'harsh')!.pass).toBe(true);
    expect(w2.style.harshLimitDb).toBe(-3);
    expect(w2.style.harshMinMs).toBe(80);
  });
});

describe('export of layered sounds', () => {
  beforeEach(() => {
    run('sound new l voice=layered seed=3; layer add l osc wave=square freq=441 dur=0.2 gain=3; sound new c voice=classic; sound new st voice=layered; layer add st osc wave=saw freq=200 dur=0.1 pan=0.5');
  });
  it('is WAV only, says so, runs the limiter at the style ceiling and writes the stereo channels it has', () => {
    const r = exportFormat(f.w, ['l', 'st'], 'wav', join(f.root, 'out'));
    const text = formatExportFiles(r);
    expect(r.notes.join('\n')).toMatch(/l: layered sound, exported as WAV only \(mono, 16-bit, 44,100 Hz\); a synth\.csv row or patch text cannot hold layers\. Limiter at the style's true-peak ceiling -0\.1 dBTP: reduced the loudest part by \d+\.\d dB/);
    expect(r.notes.join('\n')).toMatch(/st: layered sound, exported as WAV only \(stereo/);
    expect(text).toContain('note: l: layered sound');
    const l = decodeWav(new Uint8Array(readFileSync(join(f.root, 'out', 'l.wav'))));
    expect(l.channels).toBe(1);
    expect(Math.max(...l.data.map(Math.abs)) / 32767).toBeLessThanOrEqual(10 ** (-0.1 / 20));
    expect(decodeWav(new Uint8Array(readFileSync(join(f.root, 'out', 'st.wav')))).channels).toBe(2);
    expect(Buffer.from(f.w.wavOf('l')).equals(readFileSync(join(f.root, 'out', 'l.wav')))).toBe(true);
  });
  it('csv and patch refuse a layered sound that is named, skip it when everything is exported, and a classic sound still exports as before', () => {
    expect(() => exportFormat(f.w, ['l'], 'csv')).toThrow(/layered sound exports as WAV only/);
    expect(() => exportFormat(f.w, ['l'], 'patch')).toThrow(/layered sound exports as WAV only/);
    const all = exportFormat(f.w, [], 'csv', join(f.root, 'o2'));
    expect(all.notes).toEqual(['skipped l (layered: WAV only)', 'skipped st (layered: WAV only)']);
    expect(readFileSync(join(f.root, 'o2', 'synth.csv'), 'utf8')).toMatch(/^id,/);
    expect(exportFormat(f.w, ['c'], 'wav', join(f.root, 'o3')).files).toHaveLength(1);
  });
  it('a ceiling from the project style: a lower true-peak limit gives a lower export', () => {
    const pj = join(f.dir, 'project.json');
    const j = JSON.parse(readFileSync(pj, 'utf8'));
    j.style = { truePeakMax: -6 };
    writeFileSync(pj, JSON.stringify(j));
    const w2 = new Writer(loadProject(f.dir));
    const wav = decodeWav(w2.wavOf('l'));
    const peak = Math.max(...wav.data.map(Math.abs)) / 32767;
    expect(20 * Math.log10(peak)).toBeLessThanOrEqual(-6);
    expect(20 * Math.log10(peak)).toBeGreaterThan(-7.5);
  });
});

describe('the layers view and the classic mark', () => {
  it('draws a PNG of the layers with a line of numbers; refuses a sound that has none', () => {
    run('sound new l voice=layered seed=3; layer add l osc wave=sine freq=100 dur=0.2; layer add l osc wave=white dur=0.1 offset=0.1; layer mute l 2; layer add l fm dur=0.15 offset=0.05');
    const v = viewSound(f.w, 'l', 'layers', { out: join(f.root, 'layers.png') });
    expect(v.text).toMatch(/layers view saved to .*layers\.png/);
    expect(v.text).toMatch(/layers: 2 sounding, 1 muted or not soloed/);
    const png = readFileSync(join(f.root, 'layers.png'));
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(new DataView(png.buffer, png.byteOffset).getUint32(16)).toBe(900);
    run('sound new c voice=classic');
    expect(() => viewSound(f.w, 'c', 'layers')).toThrow(/layers view is for layered sounds/);
    expect(viewSound(f.w, 'l', 'wave').png.length).toBeGreaterThan(100); // the other views work on a layered sound
    expect(viewSound(f.w, 'l', 'spec').png.length).toBeGreaterThan(100);
  });
  it('a classic mark refuses layer commands through the writer, with the reason', () => {
    run('sound new c voice=classic; sound classic c on');
    expect(fail('sound layer-up c')).toMatch(/marked classic.*synth\.csv/);
    expect(fail('layer add c osc')).toMatch(/classic sound; layer add works on a layered sound/);
    expect(fail('fx add c reverb')).toMatch(/classic sound; fx add works on a layered sound/);
    expect(soundSummary(f.w, 'c')).toMatch(/^c: classic \(marked classic\)/);
    run('sound set c volume=0.3');
    const csv = exportFormat(f.w, ['c'], 'csv', join(f.root, 'o'));
    expect(csv.files).toHaveLength(1);
  });
  it('layer-up through the writer keeps the very samples', () => {
    run('sound new c voice=classic preset=laser seed=5');
    const before = samplesHash(f.w.render('c').samples);
    run('sound layer-up c');
    expect(f.w.sound('c').voice).toBe('layered');
    expect(samplesHash(f.w.render('c').samples)).toBe(before);
    expect(parse('sound layer-up c').commands[0]!.text).toMatch(/^sound layer-up c seed=\d+$/);
  });
});

describe('changes on a layered sound', () => {
  it('shows the lines of the document a person changed: what went and what came', () => {
    run('sound new s voice=layered seed=1; layer add s osc wave=sine freq=100 dur=0.2; layer add s osc wave=white dur=0.1');
    expect(collectChanges(f.w, { agent: claude }).changes).toEqual([]);
    expect(f.w.run({ commands: 'layer set s 1 freq=220 filter=lp cutoff=900\nenv s 2.amp "0:0 0.01:1 0.1:0@exp"\nfx add s reverb mix=0.2', by: 'human:ana' }).ok).toBe(true);
    const c = collectChanges(f.w, { agent: claude, by: 'human' }).changes[0]!;
    const lines = c.sounds[0]!.params;
    expect(lines.some((l) => l.startsWith('− layer 1 osc') && l.includes('freq=100'))).toBe(true);
    expect(lines.some((l) => l.startsWith('+ layer 1 osc') && l.includes('freq=220') && l.includes('filter=lp'))).toBe(true);
    expect(lines).toContain('+ env 2.amp "0:0 0.01:1 0.1:0@exp"');
    expect(lines.some((l) => l.startsWith('+ fx 1 reverb'))).toBe(true);
    expect(c.sounds[0]!.numbers.length).toBe(4);
  });
});
