// Importing an SFZ or a SoundFont 2 file as a sampled instrument: one undo group, the samples in the store with their provenance,
// the zones as plain commands, nothing read again on replay, all or nothing, and a 0.1.x project that is upgraded first.
// Every file is made by test code.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { joinChannels, midiFreq, pcmFromFloats, sinRad, samplesHash } from '@soundclaw/core';
import { Writer, createProject, exportInstrument, formatInstrumentImport, importInstrument, importPath, instrumentChecksText, instrumentZonesText, loadProject, soundFontList, upgradeProject } from '../src/index.ts';
import { wavBytes } from '../../core/test/audio-fixtures.ts';
import { G, buildSf2 } from '../../core/test/sf2-fixture.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
const by = 'agent:claude';
beforeEach(() => { f = fixture(); });
afterEach(() => f.clean());

const tone = (hz: number, secs: number): Float32Array => {
  const n = Math.round(44100 * secs);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.4 * sinRad((i / 44100) * 6.283185307179586 * hz);
  return x;
};
const wav = (path: string, hz: number, secs = 0.5): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, wavBytes(pcmFromFloats([tone(hz, secs)], 44100, 'pcm16'))); };
const tape = (): string[] => readFileSync(join(f.dir, 'history.jsonl'), 'utf8').trim().split('\n').slice(1).map((l) => (JSON.parse(l) as { cmd: string }).cmd);

/** A small SFZ library in a folder: three notes, two velocity layers on the low one, a release sample and a loud/quiet pair. */
function makeSfz(dir: string, extra = ''): string {
  wav(join(dir, 'Samples', 'low.wav'), midiFreq(48));
  wav(join(dir, 'Samples', 'mid.wav'), midiFreq(60));
  wav(join(dir, 'Samples', 'high.wav'), midiFreq(72));
  wav(join(dir, 'Samples', 'rel.wav'), 3000, 0.1);
  const file = join(dir, 'strings.sfz');
  writeFileSync(file, `// invented test instrument
<control> default_path=Samples/
<global> ampeg_attack=0.02 ampeg_release=0.4
<group> loop_mode=no_loop
<region> sample=low.wav lokey=36 hikey=53 pitch_keycenter=48 lovel=1 hivel=63 volume=-4
<region> sample=low.wav lokey=36 hikey=53 pitch_keycenter=48 lovel=64 hivel=127
<region> sample=mid.wav lokey=54 hikey=66 pitch_keycenter=60 cutoff=3000
<region> sample=HIGH.WAV lokey=67 hikey=96 pitch_keycenter=72
<region> sample=rel.wav lokey=36 hikey=96 trigger=release rt_decay=3 pitch_keytrack=0
${extra}`);
  return file;
}

describe('SFZ import', () => {
  it('writes the samples and the zones as one group, with provenance, a lost-opcode report, and the licence unknown', () => {
    const file = makeSfz(join(f.root, 'lib'));
    const r = importInstrument(f.w, file, { by, id: 'strings' });
    expect(r).toMatchObject({ id: 'strings', format: 'sfz', read: 5, zones: 5 });
    expect(r.samples.map((s) => s.name).sort()).toEqual(['strings_HIGH', 'strings_low', 'strings_mid', 'strings_rel']);
    expect(r.lost).toEqual(['lost: cutoff (region 3)', expect.stringMatching(/^approximated: pitch_keytrack=0 \(region 5\)/)]);
    // one group: the sample adds, then the instrument
    const lines = tape();
    expect(lines.filter((l) => l.startsWith('sample add'))).toHaveLength(4);
    expect(lines.filter((l) => l.startsWith('instrument zone add strings'))).toHaveLength(5);
    expect(lines).toContain('instrument new strings kind=zones seed=1');
    expect(lines.find((l) => l.startsWith('instrument set strings'))).toBe('instrument set strings attack=0.02 decay=0 sustain=1 release=0.4');
    expect(new Set(f.w.tape().map((t) => t.group)).size).toBe(1);
    // provenance names the SFZ and the path inside the folder, never an absolute path
    const show = f.w.samples.entry('strings_mid')!;
    expect(show.prov).toMatchObject({ source: 'instrument-import', origin: 'strings.sfz:Samples/mid.wav' });
    expect(show.prov.origHash).toMatch(/^[0-9a-f]{64}$/);
    expect(show.licence.id).toBe('unknown');
    expect(show.note).toMatch(/^from strings\.sfz \(sha256 [0-9a-f]{16}…\)$/);
    expect(JSON.stringify(f.w.tape())).not.toContain(f.root);
    expect(formatInstrumentImport(r, file)).toContain('imported instrument strings from strings.sfz (SFZ): 5 regions read, 5 zones written, 4 samples, as group g1');
    expect(instrumentZonesText(f.w, 'strings').split('\n').slice(1, 3)).toEqual([
      '  1  sample=strings_low root=C3 keys=C2-F3 vel=1-63 gain=-4 loop=none loopmode=none',
      '  2  sample=strings_low root=C3 keys=C2-F3 vel=64-127 loop=none loopmode=none',
    ]);
  });

  it('plays: a song renders the same bytes after a reopen, the instrument checks run, and one undo takes the instrument and its samples back', () => {
    importInstrument(f.w, makeSfz(join(f.root, 'lib')), { by, id: 'strings' });
    expect(instrumentChecksText(f.w, ['strings']).json[0]!.id).toBe('strings');
    const r = f.w.run({ commands: 'song new s tempo=120\nsong channel add s p inst=strings\npattern s.a steps=8 tpb=4\n  p: C3 - E3 - G3 - C4 -\nsong section add s x a', by });
    expect(r.ok, JSON.stringify(r.ok ? '' : r.errors)).toBe(true);
    const mix = (w: Writer): string => samplesHash(joinChannels(w.bench.render(w.song('s'), { mode: 'full' }).mix));
    const h = mix(f.w);
    expect(h).toBe(mix(f.reopen()));
    expect(f.w.run({ commands: 'undo', by }).ok).toBe(true);
    expect(f.w.run({ commands: 'undo', by }).ok).toBe(true);
    expect(f.w.instruments()).toHaveLength(0);
    expect(f.w.samples.names()).toEqual([]);
  });

  it('a replay reads no file: the instrument and its samples are the same after the SFZ and its folder are gone', () => {
    const dir = join(f.root, 'lib');
    importInstrument(f.w, makeSfz(dir), { by, id: 'strings' });
    const before = instrumentZonesText(f.w, 'strings');
    rmSync(dir, { recursive: true, force: true });
    const again = f.reopen();
    expect(instrumentZonesText(again, 'strings')).toBe(before);
    expect(again.samples.entry('strings_HIGH')!.hash).toBe(f.w.samples.entry('strings_HIGH')!.hash);
  });

  it('a second import under the same id is refused; a name collision with other audio gets a numbered sample name', () => {
    const file = makeSfz(join(f.root, 'lib'));
    importInstrument(f.w, file, { by, id: 'strings' });
    expect(() => importInstrument(f.w, file, { by, id: 'strings' })).toThrow(/instrument 'strings' exists already/);
    // the same SFZ as another instrument: the same audio, the names are new (the prefix is the id)
    const r = importInstrument(f.w, file, { by, id: 'strings2' });
    expect(r.samples.map((s) => s.name)).toContain('strings2_low');
    importPath(f.w, join(f.root, 'lib', 'Samples', 'mid.wav'), { by, as: 'other_mid' });
    wav(join(f.root, 'lib', 'Samples', 'mid.wav'), 500);
    const r3 = importInstrument(f.w, file, { by, id: 'strings3', prefix: 'strings_' });
    expect(r3.samples.map((s) => s.name)).toContain('strings_low_2');
  });

  it('all or nothing: a missing, absolute or unreadable sample names its region and writes nothing', () => {
    const dir = join(f.root, 'lib');
    const file = makeSfz(dir, '<region> sample=gone.wav key=100');
    const before = f.w.tape().length;
    expect(() => importInstrument(f.w, file, { by, id: 'strings' })).toThrow(/region 6: sample Samples\/gone\.wav is not there/);
    writeFileSync(join(dir, 'Samples', 'bad.wav'), 'this is not audio');
    writeFileSync(join(dir, 'bad.sfz'), '<region> sample=Samples/low.wav key=60\n<region> sample=Samples/bad.wav key=61');
    expect(() => importInstrument(f.w, join(dir, 'bad.sfz'), { by })).toThrow(/region 2: .*bad\.wav: not a WAV, AIFF or FLAC/);
    writeFileSync(join(dir, 'abs.sfz'), '<region> sample=/tmp/x.wav key=60');
    expect(() => importInstrument(f.w, join(dir, 'abs.sfz'), { by })).toThrow(/region 1: .*absolute path/);
    expect(f.w.tape().length).toBe(before);
    expect(f.w.instruments()).toHaveLength(0);
    expect(f.w.samples.names()).toEqual([]);
  });

  it('licence, attribution, terms and tags are written on every sample; a file name with other case is found', () => {
    const file = makeSfz(join(f.root, 'lib'));
    importInstrument(f.w, file, { by, id: 'strings', licence: 'CC-BY-4.0', attribution: 'Invented by the tests', terms: 'https://example.invalid/terms', tags: 'orchestral' });
    const e = f.w.samples.entry('strings_HIGH')!;
    expect(e.licence).toEqual({ id: 'CC-BY-4.0', attribution: 'Invented by the tests', terms: 'https://example.invalid/terms' });
    expect(e.tags).toEqual(['orchestral', 'sfz']);
  });

  it('#include files beside the SFZ are read', () => {
    const dir = join(f.root, 'lib');
    wav(join(dir, 'a.wav'), 440);
    writeFileSync(join(dir, 'regions.sfz'), '<region> sample=a.wav key=69 loop_mode=no_loop');
    writeFileSync(join(dir, 'main.sfz'), '<global> volume=-3\n#include "regions.sfz"');
    importInstrument(f.w, join(dir, 'main.sfz'), { by });
    expect(tape()).toContain('instrument zone add main sample=main_a root=A4 keys=A4-A4 gain=-3 loop=none loopmode=none');
  });

  it('a file the project\'s own sounds or songs already name is refused as an id', () => {
    f.w.run({ commands: 'sound new beep', by });
    expect(() => importInstrument(f.w, makeSfz(join(f.root, 'lib')), { by, id: 'beep' })).toThrow(/is a sound, set or song/);
    expect(() => importInstrument(f.w, makeSfz(join(f.root, 'lib')), { by, id: '9bad' })).toThrow(/not an instrument id/);
  });

  it('only .sfz and .sf2 are read', () => {
    writeFileSync(join(f.root, 'x.txt'), 'x');
    expect(() => importInstrument(f.w, join(f.root, 'x.txt'), { by })).toThrow(/reads \.sfz and \.sf2/);
    expect(() => importInstrument(f.w, join(f.root, 'nothing.sfz'), { by })).toThrow(/no file/);
  });
});

describe('SoundFont 2 import', () => {
  const ramp = (n: number): Int16Array => Int16Array.from({ length: n }, (_, i) => Math.round(Math.sin(i / 15) * 9000));
  const sf2 = (): string => {
    const file = join(f.root, 'invented.sf2');
    writeFileSync(file, buildSf2({
      info: { INAM: 'Invented font', ICOP: 'Test code', ICMT: 'sine ramps' },
      samples: [{ name: 'ramp c4', pcm: ramp(4000), rate: 22050, rootKey: 60, correction: 12, loop: [1000, 3000] }, { name: 'ramp g4', pcm: ramp(3000), rate: 22050, rootKey: 67 }],
      instruments: [{ name: 'Ramps', zones: [{ gens: [[G.releaseVolEnv, -1000]] }, { keys: [0, 63], target: 0, gens: [[G.sampleModes, 1]] }, { keys: [64, 127], target: 1 }] }],
      presets: [{ name: 'Ramps', bank: 0, program: 0, zones: [{ target: 0 }] }, { name: 'Other', bank: 0, program: 1, zones: [{ target: 0, keys: [60, 127] }] }],
    }));
    return file;
  };

  it('lists presets; with several, one has to be named', () => {
    expect(soundFontList(sf2())).toBe('Invented font  Test code  (SoundFont 2.01, 2 presets)\n000:000  Ramps  (1 zone)\n000:001  Other  (1 zone)\n');
    expect(() => importInstrument(f.w, sf2(), { by })).toThrow(/2 presets; name one with preset=/);
  });

  it('imports a preset: samples with root, tuning, loop and the font\'s text in the provenance; zones; one group', () => {
    const r = importInstrument(f.w, sf2(), { by, preset: '0:0', licence: 'own' });
    expect(r).toMatchObject({ id: 'Ramps', format: 'sf2', read: 2, zones: 2 });
    const c4 = f.w.samples.entry('Ramps_ramp_c4')!;
    expect(c4).toMatchObject({ rate: 22050, channels: 1, frames: 4000, root: 60, tune: -12, loop: [1000, 3000], loopMode: 'sustain' });
    expect(c4.prov).toMatchObject({ source: 'instrument-import', origin: 'invented.sf2:ramp c4', origFormat: 'sf2 16-bit' });
    expect(c4.note).toBe('SoundFont "Invented font", preset "Ramps"; Test code; sine ramps');
    expect(c4.licence.id).toBe('own');
    expect(tape().filter((l) => l.startsWith('instrument zone add'))).toEqual([
      'instrument zone add Ramps sample=Ramps_ramp_c4 root=C4 tune=12 keys=C-1-D#4 loopmode=continuous',
      'instrument zone add Ramps sample=Ramps_ramp_g4 root=G4 keys=E4-G9 loop=none loopmode=none',
    ]);
    expect(new Set(f.w.tape().map((t) => t.group)).size).toBe(1);
    expect(f.w.run({ commands: 'song new s tempo=100\nsong channel add s p inst=Ramps', by }).ok).toBe(true);
  });

  it('the licence stays unknown until set, and the report says so', () => {
    const r = importInstrument(f.w, sf2(), { by, preset: 'Ramps' });
    expect(f.w.samples.entry('Ramps_ramp_g4')!.licence.id).toBe('unknown');
    expect(formatInstrumentImport(r, 'invented.sf2')).toContain('the licence of the samples is unknown until you set it');
  });
});

describe('SFZ export, then import', () => {
  it('an instrument exported and imported again has the same zones and renders the same bytes', () => {
    const dir = join(f.root, 'lib');
    wav(join(dir, 'c3.wav'), midiFreq(48), 1);
    wav(join(dir, 'g3.wav'), midiFreq(55), 1);
    wav(join(dir, 'tick.wav'), 2000, 0.2);
    for (const n of ['c3', 'g3', 'tick']) importPath(f.w, join(dir, `${n}.wav`), { by, as: n, licence: 'own' });
    const r = f.w.run({ commands: `instrument new harp kind=zones
instrument set harp attack=0.01 decay=0.2 sustain=0.6 release=0.3 velocity=0.5
instrument zone add harp sample=c3 root=C3 keys=C2-D#3 vel=1-80 gain=-3 pan=0.25 start=0.05 end=0.9 loop=0.2-0.7 loopmode=sustain xfade=0.02
instrument zone add harp sample=c3 root=C3 keys=C2-D#3 vel=81-127 loop=none loopmode=none
instrument zone add harp sample=g3 root=G3 tune=-8 keys=E3-C5 loop=0.1-0.6 loopmode=continuous
instrument zone add harp sample=tick root=C3 keys=C2-C5 trigger=release release-decay=4 loop=none loopmode=none rr=1/2 choke=1
instrument zone add harp sample=tick root=C3 keys=C2-C5 trigger=release release-decay=4 loop=none loopmode=none rr=2/2 choke=1
instrument set harp rr=cycle
song new s tempo=120
song channel add s p inst=harp
pattern s.a steps=8 tpb=4
  p: C3 - E3 - G3 - C4 -
song section add s x a`, by });
    expect(r.ok, JSON.stringify(r.ok ? '' : r.errors)).toBe(true);
    const out = join(f.root, 'out');
    const ex = exportInstrument(f.w, 'harp', { out });
    const second = fixture();
    try {
      importInstrument(second.w, ex.sfz, { by, id: 'harp', prefix: '' });
      const words = (w: Writer): string[] => instrumentZonesText(w, 'harp').split('\n').map((l) => l.replace(/^\s*\d+\s+/, ''));
      expect(words(second.w)).toEqual(words(f.w));
      const r2 = second.w.run({ commands: 'song new s tempo=120\nsong channel add s p inst=harp\npattern s.a steps=8 tpb=4\n  p: C3 - E3 - G3 - C4 -\nsong section add s x a', by });
      expect(r2.ok, JSON.stringify(r2.ok ? '' : r2.errors)).toBe(true);
      const mix = (w: Writer): string => samplesHash(joinChannels(w.bench.render(w.song('s'), { mode: 'full' }).mix));
      expect(mix(second.w)).toBe(mix(f.w));
    } finally { second.clean(); }
  });
});

describe('importing into a 0.1.x project', () => {
  it('upgrades first; every sound renders as before, and the imported instrument sits beside the old samples', () => {
    // a 0.1.x project: a sample file in samples/ and a sound that plays it
    mkdirSync(join(f.dir, 'samples'), { recursive: true });
    writeFileSync(join(f.dir, 'samples', 'thump.wav'), wavBytes(pcmFromFloats([tone(80, 0.3)], 44100, 'pcm16')));
    const w0 = new Writer(loadProject(f.dir));
    expect(w0.run({ commands: 'sound new hit voice=layered\nlayer add hit sample sample=thump', by }).ok).toBe(true);
    const render = (w: Writer): string => samplesHash(joinChannels(w.render('hit').channels));
    const before = render(w0);
    const w1 = new Writer(loadProject(f.dir));
    upgradeProject(w1);
    expect(render(w1)).toBe(before);
    importInstrument(w1, makeSfz(join(f.root, 'lib')), { by, id: 'strings' });
    expect(render(w1)).toBe(before);
    expect(render(new Writer(loadProject(f.dir)))).toBe(before);
    expect(existsSync(join(f.dir, 'samples', 'thump.wav'))).toBe(false);
  });
});
