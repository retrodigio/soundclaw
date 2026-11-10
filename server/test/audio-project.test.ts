// Audio in sounds and songs on a project: impulse responses, grains and clips name samples of the store; what is measured when a command runs is
// written onto the tape as numbers; the guards keep a sample that is read from going away; licences travel to the song and the sound.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { itemLicence, joinChannels, pcmFromFloats, renderKey, samplesHash, soundSamples } from '@soundclaw/core';
import { Writer, createProject, importPath, loadProject, upgradeProject } from '../src/index.ts';
import { makeAudio as makePcm, wavBytes } from '../../core/test/audio-fixtures.ts';
import { clickTrain, room, tone } from '../../core/test/audio-material.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
const claude = 'agent:claude';
beforeEach(() => { f = fixture(); });
afterEach(() => f.clean());

const run = (commands: string, w = f.w) => { const r = w.run({ commands, by: claude }); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r; };
const fail = (commands: string, w = f.w) => { const r = w.run({ commands, by: claude }); if (r.ok) throw new Error('expected an error'); return r.errors.map((e) => e.message).join('; '); };
const tape = (): string[] => readFileSync(join(f.dir, 'history.jsonl'), 'utf8').trim().split('\n').slice(1).map((l) => (JSON.parse(l) as { cmd: string }).cmd);
const wav = (name: string, x: Float32Array): string => { const p = join(f.root, `${name}.wav`); writeFileSync(p, wavBytes(pcmFromFloats([x], 44100, 'pcm16'))); return p; };
const load = (): void => {
  importPath(f.w, wav('hall', room(1.3, 4)), { by: claude, as: 'hall', licence: 'CC-BY-4.0', attribution: 'a made-up hall' });
  importPath(f.w, wav('loop90', clickTrain(8, 60 / 90, 0.1)), { by: claude, as: 'loop90', licence: 'own' });
  importPath(f.w, wav('bed', tone(300, 1.5)), { by: claude, as: 'bed', licence: 'own' });
};
const SONG = 'instrument new sine kind=osc\nsong new s tempo=120\nsong channel add s lead inst=sine\npattern s.a steps=16 tpb=4\n  lead: C5 - - - - - - - - - - - - - - -\nsong section add s a a x4\n';

const SONG_A = SONG.replace('song channel add s lead', 'song channel add s drums audio\nsong channel add s lead');

describe('impulse responses on a project', () => {
  beforeEach(load);

  it('an effect that convolves takes the length of its response when it is not given one, and the tape holds the number', () => {
    run('sound new s voice=layered seed=1\nlayer add s osc wave=sine dur=0.2');
    run('fx add s layer=1 convolve ir=hall mix=0.4');
    expect(tape().find((t) => t.startsWith('fx add s layer=1 convolve'))).toBe('fx add s layer=1 convolve ir=hall mix=0.4 len=1.3');
    // a response longer than 12 s is cut at 12; a len given is kept
    importPath(f.w, wav('long', room(14, 5)), { by: claude, as: 'long' });
    run('fx add s convolve ir=long\nfx add s convolve ir=hall len=0.7');
    expect(tape().filter((t) => t.startsWith('fx add s convolve'))).toEqual(['fx add s convolve ir=long len=12', 'fx add s convolve ir=hall len=0.7']);
    // a replay by a new process measures nothing and renders the same
    const again = f.reopen();
    expect(renderKey(again.sampleLibrary().get('s')!, (n) => again.samples.hash(n) ?? 'none')).toBe(renderKey(f.w.sampleLibrary().get('s')!, (n) => f.w.samples.hash(n) ?? 'none'));
  });

  it('refuses a response that is not in the project, or none, and says where', () => {
    run('sound new s voice=layered seed=1\nlayer add s osc wave=sine dur=0.2');
    expect(fail('fx add s layer=1 convolve ir=nowhere')).toMatch(/s layer 1 effect 1 \(convolve\) names sample 'nowhere', which is not in the project/);
    expect(fail('fx add s convolve')).toMatch(/has no impulse response/);
    run('instrument new i kind=osc');
    expect(fail('instrument fx add i convolve ir=nowhere')).toMatch(/instrument i master effect 1 \(convolve\) names sample 'nowhere'/);
  });

  it('keeps the response from going away while a sound, an instrument or a song reads it, and follows a rename', () => {
    run(SONG + 'sound new s voice=layered seed=1\nlayer add s osc wave=sine dur=0.2\nfx add s layer=1 convolve ir=hall\nsong send s convolve ir=hall\n');
    expect(fail('sample remove hall')).toMatch(/played by sound s, song s/);
    run('sample rename hall cathedral');
    expect(f.w.sampleLibrary().get('s')).toBeDefined();
    expect(soundSamples(f.w.sampleLibrary().get('s')!)).toEqual(['cathedral']);
    expect(f.w.sampleLibrary().songs.get('s')!.convolve!.p.ir).toBe('cathedral');
    // an undo that would take the sample away says so
    expect(f.w.run({ commands: 'undo', by: claude }).ok).toBe(true);
  });

  it('licences reach the sound and the song through the response', () => {
    run(SONG + 'song channel set s lead convolve=0.3\nsong send s convolve ir=hall\n');
    const l = itemLicence(f.w.sampleLibrary(), 'song', 's');
    expect(l.samples.map((x) => x.name)).toEqual(['hall']);
    expect(l.state).toBe('attribution');
  });
});

describe('audio clips on a project', () => {
  beforeEach(load);

  it('a clip that follows the tempo and gives none gets the tempo measured from the recording, written as a number, and the command says which clip it made', () => {
    const r = run(SONG_A + 'song clip add s drums loop90 at=1 stretch=tempo');
    const line = tape().find((t) => t.startsWith('song clip add'))!;
    expect(line).toMatch(/^song clip add s drums loop90 at=1 stretch=tempo from-tempo=(8\d|9\d)(\.\d)?$/);
    expect(r.warnings.join('\n')).toMatch(/song s: clip 1 on drums: loop90 at 1/);
    expect(r.warnings.join('\n')).toMatch(/from-tempo=\d+(\.\d)? \(measured/);
    expect(f.reopen().sampleLibrary().songs.get('s')!.channels[0]!.clips![0]!.fromTempo).toBe(f.w.sampleLibrary().songs.get('s')!.channels[0]!.clips![0]!.fromTempo);
  });

  it('a recording with no steady tempo asks for one', () => {
    expect(fail(SONG_A + 'song clip add s drums bed at=1 stretch=tempo')).toMatch(/cannot hear a steady tempo in sample bed: give from-tempo/);
  });

  it('refuses a clip of a sample that is not in the project, and a slice it does not have', () => {
    run(SONG_A);
    expect(fail('song clip add s drums nothing at=1')).toMatch(/no sample 'nothing'/);
    expect(fail('song clip add s drums bed at=1 slice=2')).toMatch(/plays slice 2, but sample bed has no slice points/);
    run('sample slice bed grid=2');
    run('song clip add s drums bed at=1 slice=2');
  });

  it('keeps the recording from going away while a clip plays it, follows a rename, and gives the song its licence', () => {
    run(SONG_A + 'song clip add s drums loop90 at=1 from-tempo=90\nsong clip add s drums bed at=3');
    expect(fail('sample remove bed')).toMatch(/played by song s/);
    run('sample rename bed pad');
    expect(f.w.sampleLibrary().songs.get('s')!.channels[0]!.clips!.map((k) => k.sample)).toEqual(['loop90', 'pad']);
    expect(itemLicence(f.w.sampleLibrary(), 'song', 's').samples.map((x) => x.name)).toEqual(['loop90', 'pad']);
    // undoing the rename gives the clip its old name again
    run('undo');
    expect(f.w.sampleLibrary().songs.get('s')!.channels[0]!.clips!.map((k) => k.sample)).toEqual(['loop90', 'bed']);
  });

  it('is part of the song\'s file and survives a restart', () => {
    run(SONG_A + 'song clip add s drums loop90 at=2.2 len=1 from-tempo=90 gain=0.8');
    const text = readFileSync(join(f.dir, 'songs', 's.song'), 'utf8');
    expect(text).toMatch(/channel drums audio gain=1 pan=0 layer=base/);
    expect(text).toMatch(/clip drums 1 sample=loop90 at=2.2 len=1 stretch=tempo from-tempo=90 gain=0.8/);
    expect(f.reopen().sampleLibrary().songs.get('s')!.channels[0]!.clips![0]).toMatchObject({ id: 1, sample: 'loop90', fromTempo: 90, gain: 0.8 });
  });
});

describe('grains and recipes on a project', () => {
  beforeEach(load);

  it('a grain layer must name a sample of the project, and keeps it from going away', () => {
    run('sound new s voice=layered seed=1');
    expect(fail('layer add s grain sample=nowhere dur=1')).toMatch(/layer 1 names sample 'nowhere'/);
    run('layer add s grain sample=bed dur=1 density=30');
    expect(soundSamples(f.w.sampleLibrary().get('s')!)).toEqual(['bed']);
    expect(fail('sample remove bed')).toMatch(/played by sound s/);
  });

  it('a recipe takes a sample and lays its first moments over its body', () => {
    run('sound new s voice=layered preset=door seed=3 sample=loop90');
    const s = f.w.sampleLibrary().get('s')!;
    expect(soundSamples(s)).toEqual(['loop90']);
    expect(tape().find((t) => t.startsWith('sound new s'))).toBe('sound new s voice=layered preset=door seed=3 sample=loop90');
    expect(fail('sound new t voice=layered preset=door seed=3 sample=nowhere')).toMatch(/names sample 'nowhere'/);
  });
});

describe('a 0.1.x project', () => {
  it('opens and renders as before; a room, grains and a clip can use its files before and after it is upgraded, and no earlier render changes', () => {
    const dir = join(f.root, 'old.sclaw');
    createProject(dir);
    mkdirSync(join(dir, 'samples'), { recursive: true });
    // the samples a 0.1.x project holds: files in samples/, nothing on the tape
    writeFileSync(join(dir, 'samples', 'mono_22k.wav'), wavBytes(makePcm('pcm16', 1, 6000, 22050, 1)));
    writeFileSync(join(dir, 'samples', 'stereo_44k.wav'), wavBytes(makePcm('pcm16', 2, 8000, 44100, 2)));
    const w = new Writer(loadProject(dir));
    run('sound new mix voice=layered seed=3\nlayer add mix sample sample=mono_22k pitch=2\nlayer add mix sample sample=stereo_44k side=left pan=-1', w);
    const hash = (x: Writer, id: string): string => samplesHash(joinChannels(x.render(id).channels));
    const before = hash(w, 'mix');
    // the files are not on the tape, and a room, grains and a clip name them: the room's length is the file's (6000 frames at 22,050 Hz is 0.28 s, rounded up)
    const r = run('sound new roomy voice=layered seed=4\nlayer add roomy osc wave=sine dur=0.2\nfx add roomy layer=1 convolve ir=mono_22k mix=0.5\nsound new bed voice=layered seed=5\nlayer add bed grain sample=stereo_44k dur=0.5 density=30\ninstrument new sine kind=osc\nsong new s tempo=120\nsong channel add s lead inst=sine\nsong channel add s loops audio\npattern s.a steps=16 tpb=4\n  lead: C5 - - - - - - - - - - - - - - -\nsong section add s a a x2\nsong clip add s loops mono_22k at=1 from-tempo=100', w);
    expect(r.ok).toBe(true);
    const lines = readFileSync(join(dir, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { cmd?: string }).cmd ?? '');
    expect(lines).toContain('fx add roomy layer=1 convolve ir=mono_22k mix=0.5 len=0.28');
    expect(hash(w, 'mix')).toBe(before);
    const roomy = hash(w, 'roomy'), bed = hash(w, 'bed');
    expect(w.render('roomy').channels[0]!.length).toBeGreaterThan(Math.round(0.2 * 44100));
    // a new process reads the same project: the same renders
    const again = new Writer(loadProject(dir));
    expect([hash(again, 'mix'), hash(again, 'roomy'), hash(again, 'bed')]).toEqual([before, roomy, bed]);
    // upgraded: the files go into the store, and every render is the same sample for sample
    upgradeProject(w);
    expect([hash(w, 'mix'), hash(w, 'roomy'), hash(w, 'bed')]).toEqual([before, roomy, bed]);
    const reopened = new Writer(loadProject(dir));
    expect([hash(reopened, 'mix'), hash(reopened, 'roomy'), hash(reopened, 'bed')]).toEqual([before, roomy, bed]);
    // the song's clip reaches the upgraded sample, and its licence (unknown until set) is the song's
    expect(itemLicence(reopened.sampleLibrary(), 'song', 's').samples.map((x) => [x.name, x.licence.id])).toEqual([['mono_22k', 'unknown']]);
    expect(reopened.sampleLibrary().songs.get('s')!.channels[1]!.clips![0]).toMatchObject({ sample: 'mono_22k', stretch: 'tempo', fromTempo: 100 });
  });
});
