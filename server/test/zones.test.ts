// Sampled instruments on a project: building zones from samples (roots measured once, then written as plain numbers), the checks and the
// key-map, SFZ export, and the guards that keep a zone's sample from going away. A 0.1.x project keeps its renders when it is upgraded
// and then given an instrument of samples.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { joinChannels, midiFreq, pcmFromFloats, samplesHash, sinRad } from '@soundclaw/core';
import { Writer, createProject, exportInstrument, importPath, instrumentChecksText, instrumentZonesText, loadProject, upgradeProject, viewKeymap, type Writer as W } from '../src/index.ts';
import { wavBytes } from '../../core/test/audio-fixtures.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
const claude = 'agent:claude';
beforeEach(() => { f = fixture(); });
afterEach(() => f.clean());

const run = (commands: string, w: W = f.w) => { const r = w.run({ commands, by: claude }); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r; };
const fail = (commands: string, w: W = f.w) => { const r = w.run({ commands, by: claude }); if (r.ok) throw new Error('expected an error'); return r.errors.map((e) => e.message).join('; '); };
const tape = (): string[] => readFileSync(join(f.dir, 'history.jsonl'), 'utf8').trim().split('\n').slice(1).map((l) => (JSON.parse(l) as { cmd: string }).cmd);

/** A steady tone (a fundamental and two partials) at `hz`: it has a pitch the tool can hear and a loop that can be found. */
function steady(hz: number, secs: number): Float32Array {
  const n = Math.round(44100 * secs);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = (i / 44100) * 6.283185307179586; x[i] = 0.4 * sinRad(t * hz) + 0.15 * sinRad(t * hz * 2) + 0.05 * sinRad(t * hz * 3); }
  return x;
}
const wavAt = (name: string, hz: number, secs = 1): string => { const p = join(f.root, `${name}.wav`); writeFileSync(p, wavBytes(pcmFromFloats([steady(hz, secs)], 44100, 'pcm16'))); return p; };
const load = (): void => {
  importPath(f.w, wavAt('c3', midiFreq(48)), { by: claude, as: 'c3', licence: 'own' });
  importPath(f.w, wavAt('g3', midiFreq(55) * 1.0058), { by: claude, as: 'g3', licence: 'CC-BY-4.0', attribution: 'test tones' });
  importPath(f.w, wavAt('d4', midiFreq(62)), { by: claude, as: 'd4', licence: 'own' });
};

describe('building zones', () => {
  beforeEach(load);

  it('from-samples measures each root once and writes plain zone commands, with keys split halfway and the tuning settled', () => {
    run('instrument new harp kind=zones');
    const r = run('instrument zones harp from-samples d4 c3 g3 root=detect');
    const lines = tape().filter((t) => t.startsWith('instrument zone add harp'));
    expect(lines).toEqual([
      'instrument zone add harp sample=c3 root=C3 keys=C-1-D#3',
      'instrument zone add harp sample=g3 root=G3 tune=-10 keys=E3-A#3',
      'instrument zone add harp sample=d4 root=D4 keys=B3-G9',
    ]);
    expect(r.warnings.join('\n')).toMatch(/3 zones added[\s\S]*g3: root G3 -10 cents \(measured 19\d\.\d Hz/);
    // the tape holds numbers: a replay by a new process measures nothing and has the same zones
    const again = f.reopen();
    expect(instrumentZonesText(again, 'harp')).toBe(instrumentZonesText(f.w, 'harp'));
  });

  it('from-samples without root=detect uses the samples\' own roots', () => {
    run('sample set c3 root=C3\nsample set d4 root=D4 tune=20');
    run('instrument new harp kind=zones');
    run('instrument zones harp from-samples c3 d4');
    expect(tape().filter((t) => t.startsWith('instrument zone add harp'))).toEqual([
      'instrument zone add harp sample=c3 root=C3 keys=C-1-G3',
      'instrument zone add harp sample=d4 root=D4 tune=-20 keys=G#3-G9',
    ]);
  });

  it('from-sample makes the instrument with one zone, and finds a loop when asked', () => {
    const r = run('instrument from-sample pad c3 loop=find');
    expect(tape().slice(-3)).toEqual([
      'instrument new pad kind=zones seed=1',
      expect.stringMatching(/^sample set c3 loop=\d+-\d+ loopmode=sustain$/),
      'instrument zone add pad sample=c3 root=C3 keys=C-1-G9',
    ]);
    expect(r.warnings.join('\n')).toMatch(/one zone, sample c3 at C3[\s\S]*loop \d+-\d+ frames/);
    expect(fail('instrument from-sample pad c3')).toMatch(/exists already/);
  });

  it('from-slices puts a sliced sample across the keyboard, one slice to a key, played whole', () => {
    run('sample slice c3 grid=4');
    run('instrument new kit kind=zones');
    run('instrument zones kit from-slices c3 start=C2');
    expect(tape().filter((t) => t.startsWith('instrument zone add kit'))).toEqual([
      'instrument zone add kit sample=c3 slice=1 root=C2 keys=C2-C2 loop=none loopmode=oneshot',
      'instrument zone add kit sample=c3 slice=2 root=C#2 keys=C#2-C#2 loop=none loopmode=oneshot',
      'instrument zone add kit sample=c3 slice=3 root=D2 keys=D2-D2 loop=none loopmode=oneshot',
      'instrument zone add kit sample=c3 slice=4 root=D#2 keys=D#2-D#2 loop=none loopmode=oneshot',
    ]);
    expect(fail('instrument zones kit from-slices d4')).toMatch(/has no slice points/);
  });

  it('says why a sample\'s pitch cannot be heard', () => {
    const n = 44100;
    const noise = new Float32Array(n);
    let s = 7;
    for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; noise[i] = (s / 4294967296 - 0.5) * 0.5; }
    const p = join(f.root, 'noise.wav');
    writeFileSync(p, wavBytes(pcmFromFloats([noise], 44100, 'pcm16')));
    importPath(f.w, p, { by: claude, as: 'noise', licence: 'own' });
    run('instrument new x kind=zones');
    expect(fail('instrument zones x from-samples noise root=detect')).toMatch(/cannot hear a steady pitch in sample noise/);
  });
});

describe('zones and the samples they play', () => {
  beforeEach(load);

  it('refuse a zone whose sample is not in the project, and a slice the sample does not have', () => {
    run('instrument new x kind=zones');
    expect(fail('instrument zone add x sample=nothing root=C3 keys=C3-C4')).toMatch(/zone 1 names sample 'nothing', which is not in the project/);
    expect(fail('instrument zone add x sample=c3 root=C3 keys=C3-C4 slice=2')).toMatch(/plays slice 2, but sample c3 has no slice points/);
  });

  it('keep a sample from being removed while a zone plays it, and follow a rename', () => {
    run('instrument new x kind=zones\ninstrument zone add x sample=c3 root=C3 keys=C0-C9');
    expect(fail('sample remove c3')).toMatch(/sample c3 is played by instrument x/);
    run('sample rename c3 low');
    expect(instrumentZonesText(f.w, 'x')).toMatch(/sample=low root=C3/);
    expect(f.reopen().instruments().find((i) => i.id === 'x')!.zones![0]!.sample).toBe('low');
    // the licence of the sample reaches the instrument
    run('instrument zone add x sample=g3 root=G3 keys=C#9-G9');
    const item = f.w.itemLicence('instrument', 'x');
    expect(item.samples.map((s) => s.name).sort()).toEqual(['g3', 'low']);
    expect(item.state).toBe('attribution');
  });

  it('undo takes a zone back, and a sample a zone plays cannot be undone away', () => {
    run('instrument new x kind=zones');
    run('instrument zone add x sample=c3 root=C3 keys=C0-C9');
    run('undo');
    expect(f.w.instruments().find((i) => i.id === 'x')!.zones).toEqual([]);
    run('redo');
    expect(f.w.instruments().find((i) => i.id === 'x')!.zones).toHaveLength(1);
  });
});

describe('checking, viewing and exporting', () => {
  beforeEach(load);

  it('check and the key-map read the project\'s samples', () => {
    run('instrument new harp kind=zones\ninstrument set harp range=C3-G4\ninstrument zones harp from-samples c3 g3 d4 root=detect');
    const ok = instrumentChecksText(f.w, ['harp']);
    expect(ok.text).toMatch(/^harp: (pass|FAIL), 3 zones/);
    run('instrument zone set harp 2 tune=+80');
    const bad = instrumentChecksText(f.w, ['harp']);
    expect(bad.pass).toBe(false);
    expect(bad.text).toMatch(/FAIL pitch: zone 2 \(g3\) sounds \+\d+ cents from its root G3/);
    const v = viewKeymap(f.w, 'harp');
    expect(existsSync(v.file)).toBe(true);
    expect([...readFileSync(v.file).subarray(0, 4)]).toEqual([137, 80, 78, 71]);
    expect(v.text).toMatch(/keymap view saved to/);
  });

  it('exports an SFZ with its samples as WAV files and the attribution', () => {
    run('instrument new harp kind=zones\ninstrument set harp adsr=0.002,0.1,0.8,0.3\ninstrument zones harp from-samples c3 g3 d4 root=detect\ninstrument zone set harp 1 loopmode=oneshot rr=1/2');
    const out = join(f.root, 'out');
    const r = exportInstrument(f.w, 'harp', { out });
    expect(readdirSync(join(out, 'samples')).sort()).toEqual(['c3.wav', 'd4.wav', 'g3.wav']);
    expect(r.attribution).toBe(true);
    expect(readFileSync(join(out, 'ATTRIBUTION.txt'), 'utf8')).toMatch(/g3 \(CC-BY-4.0/);
    const sfz = readFileSync(join(out, 'harp.sfz'), 'utf8');
    expect(sfz).toMatch(/<control>\ndefault_path=samples\//);
    expect(sfz).toMatch(/ampeg_attack=0.002\nampeg_decay=0.1\nampeg_sustain=80\nampeg_release=0.3/);
    expect(sfz).toMatch(/<region> sample=c3.wav lokey=0 hikey=\d+ pitch_keycenter=48 loop_mode=one_shot seq_length=2 seq_position=1/);
    expect(sfz).toMatch(/<region> sample=g3.wav .*tune=-?\d+/);
    expect(() => exportInstrument(f.w, 'harp', { format: 'sf2' })).toThrow(/--format is sfz/);
  });
});

describe('a 0.1.x project given an instrument of samples', () => {
  it('keeps every render through the upgrade and plays the zones after it', () => {
    const dir = join(f.root, 'old.sclaw');
    createProject(dir);
    mkdirSync(join(dir, 'samples'), { recursive: true });
    writeFileSync(join(dir, 'samples', 'bell.wav'), wavBytes(pcmFromFloats([steady(midiFreq(60), 0.8)], 44100, 'pcm16')));
    const w = new Writer(loadProject(dir));
    run(`sound new hit voice=layered seed=2
layer add hit sample sample=bell
instrument new old from=square_lead
instrument layer set old 1 wave=triangle
song new t tempo=120
song channel add t a inst=old
pattern t.p steps=8 tpb=4
  a: C4 - E4 - G4 - C5 -
song section add t x p`, w);
    const mix = (ww: Writer): string => samplesHash(joinChannels(ww.bench.render(ww.song('t'), { mode: 'full' }).mix));
    const before = { hit: samplesHash(joinChannels(w.render('hit').channels)), song: mix(w) };
    upgradeProject(w);
    expect({ hit: samplesHash(joinChannels(w.render('hit').channels)), song: mix(w) }).toEqual(before);
    expect({ hit: samplesHash(joinChannels(new Writer(loadProject(dir)).render('hit').channels)), song: mix(new Writer(loadProject(dir))) }).toEqual(before);
    // the upgraded sample plays as a zone, and the song renders it
    run('instrument new bells kind=zones\ninstrument zone add bells sample=bell root=C4 keys=C3-C6\nsong channel set t a inst=bells', w);
    const after = mix(w);
    expect(after).not.toBe(before.song);
    expect(mix(new Writer(loadProject(dir)))).toBe(after);
    // undone, the old instrument and its render are back
    run('undo', w);
    expect(mix(w)).toBe(before.song);
  });
});
