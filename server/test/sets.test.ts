// Sets, families and loops through the writer: the loudness-matching commands on the tape, replay
// without measuring, undo, the checks a set's members are held to, the set and loop views, export
// (OGG, the manifest, the pack layout) and the import report.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAMILIES, loudnessOf, renderChannels, serializeSet, serializeSound, replay, samplesHash, joinChannels, type LayeredSound } from '@soundclaw/core';
import { Writer, checkText, exportFormat, formatExportFiles, formatImportReport, importCommands, normalizeCommands, setSummary, soundSummary, viewSound, ProjectError } from '../src/index.ts';
import { fixture, type Fixture } from './helpers.ts';
import { readOgg } from './ogg.ts';

let f: Fixture;
const claude = 'agent:claude';
beforeEach(() => { f = fixture(); });
afterEach(() => f.clean());
const run = (commands: string, w: Writer = f.w) => { const r = w.run({ commands, by: claude }); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r; };

const STEPS = 'sound new step voice=layered seed=11\nlayer add step osc wave=sine freq=110 dur=0.18 gain=0.8\nenv step 1.freq \"0:150 0.1:55@exp\"\nenv step 1.amp \"0:0 0.003:1 0.15:0@exp\"\nlayer add step osc wave=brown dur=0.15 filter=lp cutoff=1200 q=1 gain=0.7\nenv step 2.cutoff \"0:2200 0.12:400@exp\"\nenv step 2.amp \"0:0 0.004:1 0.12:0@exp\"\nlayer add step osc wave=white dur=0.07 offset=0.03 filter=hp cutoff=3500 gain=0.2\nenv step 3.amp \"0:0 0.004:1 0.05:0@exp\"\nset new feet from=step count=6 target=-20 spread="1.freq±12% 2.cutoff±20% *.gain±20%" seed=5\n';

describe('set new through the writer', () => {
  it('makes the members, then writes the loudness matching as plain commands on the same tape group', () => {
    const r = run(STEPS);
    const cmds = r.added.map((e) => e.cmd);
    expect(cmds[0]).toBe("sound new step voice=layered seed=11");
    const at = cmds.findIndex((c) => c.startsWith('set new'));
    expect(cmds[at]).toBe('set new feet from=step count=6 target=-20 spread="1.freq±12% 2.cutoff±20% *.gain±20%" seed=5');
    expect(cmds.slice(at + 1).map((c) => c.replace(/gain=.*/, 'gain=…'))).toEqual(Array.from({ length: 6 }, (_, k) => `sound set feet_${k + 1} gain=…`));
    expect(new Set(r.added.map((e) => e.group)).size).toBe(1);
    expect(r.touchedSets).toEqual(['feet']);
    expect(r.touched).toContain('feet_3');
    for (let k = 1; k <= 6; k++) expect(Math.abs(loudnessOf(f.w.sound(`feet_${k}`)) - -20)).toBeLessThan(0.1);
    expect(readFileSync(join(f.dir, 'sets', 'feet.set'), 'utf8')).toBe(serializeSet(f.w.set('feet')));
    expect(existsSync(join(f.dir, 'sounds', 'feet_6.sfx'))).toBe(true);
    expect(f.w.snapshot().sets.map((s) => s.id)).toEqual(['feet']);
  });
  it('holds a member with its own loudness to that target in set-spread, and says so', () => {
    run(STEPS);
    expect(f.w.measureSetDoc('feet').result.threshold).not.toMatch(/own targets/);
    run('sound set feet_2 loudness=-26');
    const m = f.w.measureSetDoc('feet').result;
    expect(m.threshold).toMatch(/own targets \(LUFS\): feet_2 -26/);
    expect(m.ranges.map((r) => r.note).join('\n')).toMatch(/feet_2 is -20\.\d LUFS, 6\.\d LU from the own target -26\.0/);
    run(normalizeCommands(f.w, ['feet_2']).commands);
    expect(f.w.measureSetDoc('feet').result.ranges.map((r) => r.note).join('\n')).not.toMatch(/LU from the/);
  });
  it('replays from the tape to the same sounds with nothing measured (a fresh writer has the same gains)', () => {
    run(STEPS);
    const again = f.reopen();
    for (const s of f.w.sounds()) expect(serializeSound(again.sound(s.id)), s.id).toBe(serializeSound(s));
    expect(serializeSet(again.set('feet'))).toBe(serializeSet(f.w.set('feet')));
    const r = replay(f.w.tape());
    expect(r.problems).toEqual([]);
  });
  it('is one undo group: undo removes the set, its members and their files, redo brings them back', () => {
    run(STEPS);
    run('undo');
    expect(f.w.sets()).toEqual([]);
    expect(f.w.sounds()).toEqual([]);
    expect(existsSync(join(f.dir, 'sets', 'feet.set'))).toBe(false);
    expect(existsSync(join(f.dir, 'sounds', 'feet_1.sfx'))).toBe(false);
    run('redo');
    expect(f.w.sets().map((s) => s.id)).toEqual(['feet']);
    expect(f.w.sounds()).toHaveLength(7);
  });
  it('holds the members to the set\'s target, not the project\'s, in the checks and in the summary', () => {
    run(STEPS);
    const loud = f.w.measure('feet_2').checks.find((c) => c.name === 'loudness')!;
    expect(loud.pass).toBe(true);
    expect(loud.threshold).toContain('-20.0 LUFS');
    expect(f.w.measure('step').checks.find((c) => c.name === 'loudness')!.threshold).toContain('-16.0');
    expect(soundSummary(f.w, 'feet_1')).toContain('checks:');
  });
  it('retarget matches every member again; add matches the sounds it adds; each is plain commands', () => {
    run(STEPS);
    const r = run('set retarget feet -26');
    expect(r.added.map((e) => e.cmd).filter((c) => c.startsWith('sound set feet_'))).toHaveLength(6);
    expect(Math.abs(loudnessOf(f.w.sound('feet_4')) - -26)).toBeLessThan(0.1);
    run('sound new boot voice=layered seed=2\nlayer add boot osc wave=sine freq=110 dur=0.18 gain=0.8\nenv boot 1.freq \"0:150 0.1:55@exp\"\nenv boot 1.amp \"0:0 0.003:1 0.15:0@exp\"\nlayer add boot osc wave=brown dur=0.15 filter=lp cutoff=1200 q=1 gain=0.7\nenv boot 2.cutoff \"0:2200 0.12:400@exp\"\nenv boot 2.amp \"0:0 0.004:1 0.12:0@exp\"\nlayer add boot osc wave=white dur=0.07 offset=0.03 filter=hp cutoff=3500 gain=0.2\nenv boot 3.amp \"0:0 0.004:1 0.05:0@exp\"');
    const a = run('set add feet boot');
    expect(a.added.map((e) => e.cmd)).toEqual(['set add feet boot', expect.stringMatching(/^sound set boot gain=/)]);
    expect(Math.abs(loudnessOf(f.w.sound('boot')) - -26)).toBeLessThan(0.1);
    expect(f.w.set('feet').members).toContain('boot');
  });
  it('regen with a new seed makes the generated members again and matches them again', () => {
    run(STEPS);
    const before = serializeSound(f.w.sound('feet_1'));
    const r = run('set regen feet seed=99');
    expect(r.added[0]!.cmd).toBe('set regen feet seed=99');
    expect(serializeSound(f.w.sound('feet_1'))).not.toBe(before);
    expect(f.w.set('feet').seed).toBe(99);
    expect(Math.abs(loudnessOf(f.w.sound('feet_5')) - -20)).toBeLessThan(0.1);
  });
  it('says, as a warning, when a classic member cannot reach the target with its volume', () => {
    const r = run('sound new coin voice=classic preset=pickup seed=3\nset new c from=coin count=3 target=-3 spread="freq±0.04" seed=1');
    expect(r.warnings.join('\n')).toMatch(/volume would need to be above 1.*layer-up/);
    expect(f.w.sound('c_1').voice).toBe('classic');
  });
  it('is atomic: an error in the batch applies none of it', () => {
    const r = f.w.run({ commands: 'sound new step voice=layered seed=11\nlayer add step osc wave=sine freq=110 dur=0.18 gain=0.8\nenv step 1.freq \"0:150 0.1:55@exp\"\nenv step 1.amp \"0:0 0.003:1 0.15:0@exp\"\nlayer add step osc wave=brown dur=0.15 filter=lp cutoff=1200 q=1 gain=0.7\nenv step 2.cutoff \"0:2200 0.12:400@exp\"\nenv step 2.amp \"0:0 0.004:1 0.12:0@exp\"\nlayer add step osc wave=white dur=0.07 offset=0.03 filter=hp cutoff=3500 gain=0.2\nenv step 3.amp \"0:0 0.004:1 0.05:0@exp\"\nset new feet from=step count=3 spread="9.freq±5%"', by: claude });
    expect(r.ok).toBe(false);
    expect(f.w.sounds()).toEqual([]);
  });
  it('the history of a member includes the matching commands', () => {
    run(STEPS);
    expect(f.w.history({ sound: 'feet_2' }).map((e) => e.cmd)).toEqual([expect.stringMatching(/^sound set feet_2 gain=/)]);
    expect(f.w.history({ sound: 'feet' })).toEqual([]); // a set is not a sound
  });
});

describe('check and the views of a set', () => {
  it('checks a set by name, with its members, and says what fails', () => {
    run(STEPS);
    const ok = checkText(f.w, ['feet']);
    expect(ok.pass).toBe(true);
    expect(ok.text).toMatch(/set feet: PASS/);
    expect(ok.text).toMatch(/set-spread\s+pass/);
    run('sound set feet_2 gain=0.1');
    const bad = checkText(f.w, ['feet']);
    expect(bad.pass).toBe(false);
    expect(bad.text).toMatch(/feet_2 is -\d+\.\d LUFS/);
    // with no names, every sound and every set
    expect(checkText(f.w, []).text).toMatch(/set feet:/);
  });
  it('lists a set in its summary, and draws the set view as a PNG with the distance matrix', () => {
    run(STEPS);
    expect(setSummary(f.w, 'feet')).toMatch(/set feet: 6 members \[feet_1, .*\] from step, target -20 LUFS, spread "1\.freq±12% 2\.cutoff±20% \*\.gain±20%", seed 5\n\s+set-spread (pass|FAIL):/);
    const v = viewSound(f.w, 'feet', 'set');
    expect([...v.png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(v.text).toMatch(/distance matrix \(dB\):/);
    expect(v.text.split('\n').filter((l) => /^\s+\d feet_\d/.test(l))).toHaveLength(6);
    expect(existsSync(v.file)).toBe(true);
    expect(() => viewSound(f.w, 'ghost', 'set')).toThrow(ProjectError);
  });
});

describe('families through the writer', () => {
  it('matches a family variant\'s loudness to the source\'s plus the rule\'s offset', () => {
    run('sound new door voice=layered seed=7\nlayer add door osc wave=sine freq=95 dur=0.35 gain=0.9\nenv door 1.freq \"0:110 0.2:42@exp\"\nenv door 1.amp \"0:0 0.003:1 0.3:0@exp\"\nlayer add door osc wave=brown dur=0.3 filter=lp cutoff=600 gain=0.6\nenv door 2.amp \"0:0 0.003:1 0.25:0@exp\"\nlayer add door osc wave=saw dur=0.7 offset=0.2 filter=bp cutoff=2800 q=2 gain=0.7\nenv door 3.amp \"0:0 0.1:1 0.5:0@exp\"\nfx add door reverb size=0.25 damp=0.6 mix=0.1');
    const r = run('family door far\nfamily door muffled as=door_wall');
    expect(r.added.map((e) => e.cmd)).toEqual(['family door far as=door_far', expect.stringMatching(/^sound set door_far gain=/), 'family door muffled as=door_wall', expect.stringMatching(/^sound set door_wall gain=/)]);
    const lu = loudnessOf(f.w.sound('door'));
    expect(loudnessOf(f.w.sound('door_far'))).toBeCloseTo(lu + FAMILIES.far.gainDb, 0);
    expect(loudnessOf(f.w.sound('door_wall'))).toBeCloseTo(lu + FAMILIES.muffled.gainDb, 0);
    expect(f.w.measure('door_far').checks.find((c) => c.name === 'loudness')!.threshold).toContain(`${(-16 + FAMILIES.far.gainDb).toFixed(1)} LUFS`);
    expect(f.w.history({ sound: 'door' }).map((e) => e.cmd)).toContain('family door far as=door_far');
  });
});

describe('loops through the writer', () => {
  it('keeps a bed\'s seam checked as a seam (no tail, no start and end levels)', () => {
    run('sound new rain voice=layered preset=rain seed=4');
    const m = f.w.measure('rain');
    const click = m.checks.find((c) => c.name === 'click')!;
    expect(click.value).toMatch(/^loop seam: jump/);
    expect(m.checks.find((c) => c.name === 'tail')!.value).toMatch(/a loop/);
    expect(m.checks.find((c) => c.name === 'click')!.pass).toBe(true);
    run('sound loop rain off');
    expect(f.w.measure('rain').checks.find((c) => c.name === 'click')!.value).toMatch(/^start /);
  });
  it('draws the loop view, and refuses it for a sound that is not a loop', () => {
    run('sound new rain voice=layered preset=rain seed=4\nsound new zap voice=classic preset=laser seed=1');
    const v = viewSound(f.w, 'rain', 'loop');
    expect([...v.png.slice(0, 4)]).toEqual([137, 80, 78, 71]);
    expect(v.text).toMatch(/loop: [\d.]+ s, crossfade 0\.5 s; seam jump/);
    expect(() => viewSound(f.w, 'zap', 'loop')).toThrow(/is not a loop/);
  });
  it('exports the loop points in the manifest', () => {
    run('sound new rain voice=layered preset=rain seed=4\nsound new zap voice=classic preset=laser seed=1');
    const out = join(f.root, 'out');
    const r = exportFormat(f.w, [], 'wav', { out, all: true });
    const m = JSON.parse(readFileSync(r.manifest!, 'utf8'));
    const rain = m.sounds.find((s: { id: string }) => s.id === 'rain');
    expect(rain.loop).toEqual({ start: 0, end: rain.samples, startSeconds: 0, endSeconds: rain.samples / 44100 });
    expect(m.sounds.find((s: { id: string }) => s.id === 'zap').loop).toBeNull();
  });
});

describe('export', () => {
  const SCRIPT = `${STEPS}sound new zap voice=classic preset=laser seed=2\nsound new blip voice=classic preset=blip seed=1\nsound classic blip on\nsound new rain voice=layered preset=rain seed=4\n`;
  it('plain export writes the files and no manifest, as before', () => {
    run(SCRIPT);
    const out = join(f.root, 'plain');
    const r = exportFormat(f.w, ['zap'], 'wav', out);
    expect(r.manifest).toBeNull();
    expect(existsSync(join(out, 'manifest.json'))).toBe(false);
  });
  it('--all writes a manifest: id, file, duration, loudness, channels, loop points, set', () => {
    run(SCRIPT);
    const out = join(f.root, 'all');
    const r = exportFormat(f.w, [], 'wav', { out, all: true });
    const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(m).toMatchObject({ format: 'soundclaw-manifest', version: 1, project: 'demo' });
    expect(m.sounds.map((s: { id: string }) => s.id)).toEqual(['blip', 'feet_1', 'feet_2', 'feet_3', 'feet_4', 'feet_5', 'feet_6', 'rain', 'step', 'zap']);
    const feet = m.sounds.find((s: { id: string }) => s.id === 'feet_3');
    expect(feet).toMatchObject({ file: 'feet_3.wav', format: 'wav', sampleRate: 44100, channels: 1, set: 'feet', loop: null, synth: false, status: 'draft' });
    expect(feet.samples).toBe(Math.round(feet.duration * 44100));
    expect(feet.loudness).toBeCloseTo(-20, 0);
    expect(m.sets).toEqual([{ id: 'feet', members: f.w.set('feet').members, target: -20 }]);
    expect(formatExportFiles(r)).toContain(`manifest: ${join(out, 'manifest.json')}`);
    expect(existsSync(join(out, 'zap.wav'))).toBe(true);
  });
  it('--set exports a set\'s members only', () => {
    run(SCRIPT);
    const out = join(f.root, 'set');
    const r = exportFormat(f.w, [], 'wav', { out, set: 'feet' });
    expect(r.files.map((x) => x.id)).toEqual(f.w.set('feet').members);
    expect(JSON.parse(readFileSync(r.manifest!, 'utf8')).sounds).toHaveLength(6);
    expect(() => exportFormat(f.w, ['zap'], 'wav', { out, set: 'feet' })).toThrow(/sounds or a set, not both/);
    expect(() => exportFormat(f.w, [], 'wav', { out, set: 'nope' })).toThrow(/no set 'nope'/);
  });
  it('the pack layout is one flat folder: sounds marked classic become synth.csv rows, the rest audio', () => {
    run(SCRIPT);
    const out = join(f.root, 'pack');
    const r = exportFormat(f.w, [], 'wav', { out, pack: true });
    expect(existsSync(join(out, 'blip.wav'))).toBe(false);
    expect(readFileSync(join(out, 'synth.csv'), 'utf8')).toMatch(/^id,/);
    expect(readFileSync(join(out, 'synth.csv'), 'utf8')).toContain('blip');
    expect(readFileSync(join(out, 'synth.csv'), 'utf8')).not.toContain('zap');
    expect(existsSync(join(out, 'zap.wav'))).toBe(true);
    const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(m.sounds.find((s: { id: string }) => s.id === 'blip')).toMatchObject({ file: null, format: null, synth: true });
    expect(r.notes.join('\n')).toMatch(/1 sound marked classic written as rows of synth\.csv/);
  });
  it('OGG: a well-formed Vorbis stream with the exact number of samples, mono or stereo, and a manifest', () => {
    run(`${SCRIPT}sound new pan voice=layered preset=magic seed=3\n`);
    const out = join(f.root, 'ogg');
    const r = exportFormat(f.w, [], 'ogg', { out });
    expect(r.manifest).toBe(join(out, 'manifest.json'));
    for (const id of ['zap', 'rain', 'feet_1', 'pan']) {
      const bytes = new Uint8Array(readFileSync(join(out, `${id}.ogg`)));
      const info = readOgg(bytes);
      const want = renderChannels(f.w.sound(id));
      expect(info.headerTypes, id).toEqual([1, 3, 5]);
      expect(info.sampleRate).toBe(44100);
      expect(info.channels).toBe(want.length);
      expect(info.samples, id).toBe(want[0]!.length);
      expect(info.vendor).toMatch(/libVorbis/);
      expect(info.pages).toBeGreaterThan(2);
    }
    expect(readOgg(new Uint8Array(readFileSync(join(out, 'pan.ogg')))).channels).toBe(2);
    const m = JSON.parse(readFileSync(r.manifest!, 'utf8'));
    expect(m.sounds.find((s: { id: string }) => s.id === 'pan')).toMatchObject({ format: 'ogg', file: 'pan.ogg', channels: 2 });
    expect(r.notes.join('\n')).toMatch(/rain: a loop exported as OGG; Vorbis is lossy/);
  });
  it('OGG: quality changes the size, and the same sound gives the same bytes', () => {
    run('sound new rain voice=layered preset=rain seed=4');
    const size = (q: number, dir: string) => readFileSync(join(exportFormat(f.w, ['rain'], 'ogg', { out: join(f.root, dir), quality: q }).files[0]!.file)).length;
    expect(size(0.9, 'q9')).toBeGreaterThan(size(0.1, 'q1') * 1.3);
    const a = readFileSync(join(exportFormat(f.w, ['rain'], 'ogg', { out: join(f.root, 'a') }).files[0]!.file));
    const b = readFileSync(join(exportFormat(f.w, ['rain'], 'ogg', { out: join(f.root, 'b') }).files[0]!.file));
    expect(Buffer.compare(a, b)).toBe(0);
    expect(() => exportFormat(f.w, ['rain'], 'ogg', { out: f.root, quality: 3 })).toThrow(/quality is from -0\.1 to 1/);
  });
  const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  it.skipIf(!hasFfmpeg)('OGG: a reference decoder (ffmpeg, where installed) reads it back to the same sound', () => {
    run('sound new zap voice=classic preset=laser seed=2');
    const x = exportFormat(f.w, ['zap'], 'ogg', { out: join(f.root, 'dec') }).files[0]!;
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', x.file, '-f', 'f32le', '-ac', '1', '-ar', '44100', '-'], { maxBuffer: 1 << 26 });
    const got = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4));
    const want = renderChannels(f.w.sound('zap'))[0]!;
    expect(got.length).toBeGreaterThanOrEqual(want.length);
    // lossy: the decoded wave follows the source closely (correlation above 0.97)
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < want.length; i++) { ab += got[i]! * want[i]!; aa += got[i]! * got[i]!; bb += want[i]! * want[i]!; }
    expect(ab / Math.sqrt(aa * bb)).toBeGreaterThan(0.97);
    void samplesHash; void joinChannels;
  });
});

describe('import', () => {
  const SQUARE = '11111Fc13SajJH62jNe2k3ctPhzkXNYtK16FBV33LAVw7Df46Vas3d7M1XjJEWdoMSJ2cF9JijnogukyoRpEWtFPfVTJHMezGnkBy9Bz8GwwGvnprF9iQFDh';
  const BFXR = '2,0.5,,0.3,,0.4,0.3,0.3,,,,,,,,,,,,,,,,,,1,,,,,,';
  it('reports each row: exact for a jsfxr string, approximated with the loss named for a bfxr one', () => {
    const i = importCommands(`zap ${SQUARE}\nhit {"wave_type":2,"p_base_freq":0.5,"sound_vol":0.25}\n`, null, 'sfxr'); // sfxr recognises jsfxr strings
    expect(i.ids).toEqual(['zap', 'hit']);
    const text = formatImportReport(i.report);
    expect(text).toMatch(/row 1 zap: exact \(jsfxr base58\)/);
    expect(text).toMatch(/row 2 hit: exact \(jsfxr json\)/);
    const b = importCommands(`buzz ${BFXR}`, null, 'bfxr');
    expect(b.report[0]!.status).toBe('approximated');
    expect(formatImportReport(b.report)).toMatch(/row 1 buzz: approximated \(bfxr\)\n\s+lost or changed: compressionAmount 0.3 not reproduced/);
    run(b.commands + '\n' + importCommands(`zap ${SQUARE}`, null, 'jsfxr').commands);
    expect(f.w.sound('zap').voice).toBe('classic');
    expect(f.w.sound('buzz')).toMatchObject({ voice: 'classic' });
  });
  it('needs an id for a single string, and applies nothing when one row cannot be read', () => {
    expect(() => importCommands(SQUARE, null, 'jsfxr')).toThrow(/needs an id/);
    expect(importCommands(SQUARE, 'sq', 'jsfxr').ids).toEqual(['sq']);
    expect(() => importCommands(`ok ${SQUARE}\nbad 1,2,3`, null, 'bfxr')).toThrow(/row 2 \(bad\): not a Bfxr string.*nothing was imported/);
    expect(() => importCommands(`ok ${SQUARE}\nbad 34T6Pk`, null, 'jsfxr')).toThrow(/row 2 \(bad\)/);
  });
  it('still reads the engine\'s csv and patch text, every row exact', () => {
    const i = importCommands('id,wave,freq\nbeep,0,0.4\nboop,2,0.5', null);
    expect(i.report.map((r) => [r.id, r.status])).toEqual([['beep', 'exact'], ['boop', 'exact']]);
  });
  it('the layered sound that a family or set made is not a LayeredSound-less fluke', () => {
    run(STEPS);
    expect((f.w.sound('feet_1') as LayeredSound).voice).toBe('layered');
  });
});
