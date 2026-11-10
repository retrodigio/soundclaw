// Audio in sounds and songs on a project: impulse responses, grains and clips name samples of the store; what is measured when a command runs is
// written onto the tape as numbers; the guards keep a sample that is read from going away; licences travel to the song and the sound.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { itemLicence, pcmFromFloats, renderKey, soundSamples } from '@soundclaw/core';
import { importPath } from '../src/index.ts';
import { wavBytes } from '../../core/test/audio-fixtures.ts';
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
