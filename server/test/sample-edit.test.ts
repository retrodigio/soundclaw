// Editing and hearing samples on a project: derive, slice, loop, bounce and the layering helpers are worked out when they run and written to the
// tape as plain numbers; replay recomputes a missing object and refuses a hash that differs; samples have the same ears as sounds.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderChannels, joinChannels, parse, pcmFromFloats, samplesHash, sampleKeyPart, type LayeredSound } from '@soundclaw/core';
import {
  compareText, describeJson, describeText, importPath, measureHash, sampleCheckText, sampleListText, sampleQueryText, sampleSide, viewSound, ProjectError, Writer, loadProject, type Writer as W,
} from '../src/index.ts';
import { wavBytes } from '../../core/test/audio-fixtures.ts';
import { hitsFloats, toneFloats } from '../../core/test/sample-golden-table.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
const claude = 'agent:claude';
beforeEach(() => { f = fixture(); });
afterEach(() => f.clean());

const run = (commands: string, w: W = f.w) => { const r = w.run({ commands, by: claude }); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r; };
const fail = (commands: string, w: W = f.w) => { const r = w.run({ commands, by: claude }); if (r.ok) throw new Error('expected an error'); return r.errors.map((e) => e.message).join('; '); };
const tape = (): string[] => readFileSync(join(f.dir, 'history.jsonl'), 'utf8').trim().split('\n').slice(1).map((l) => (JSON.parse(l) as { cmd: string }).cmd);
const wav = (name: string, chs: Float32Array[], rate: number): string => { const p = join(f.root, name); writeFileSync(p, wavBytes(pcmFromFloats(chs, rate, 'pcm16'))); return p; };

function load(): void {
  importPath(f.w, wav('hits.wav', [hitsFloats(22050, 2, 0.5)], 22050), { by: claude, as: 'hits', licence: 'CC-BY-4.0', attribution: 'test hits' });
  importPath(f.w, wav('tone.wav', [toneFloats(44100, 1)], 44100), { by: claude, as: 'tone', licence: 'own' });
}
const entry = (w: W, n: string) => w.sampleEntries().get(n)!;

describe('sample derive', () => {
  beforeEach(load);

  it('writes the new audio into the store and the settled chain onto the tape as a plain sample add', () => {
    const r = run('sample derive soft from=tone op="silence-trim -50; fade out=100ms@exp; normalize peak -3"');
    const line = tape().at(-1)!;
    expect(line).toMatch(/^sample add soft hash=[0-9a-f]{64} rate=44100 channels=1 frames=\d+ format=f32 /);
    expect(line).toContain('source=derived');
    expect(line).toContain(`parents=${entry(f.w, 'tone').hash}`);
    // everything measured is a number: a frame range, a gain in dB
    expect(line).toMatch(/ops="trim \d+f \d+f; fade out=4410f@exp; gain -?[\d.]+"/);
    expect(r.warnings.join(' ')).toMatch(/sample soft: [\d.]+ s, mono, from tone by:/);
    expect(f.w.samples.hasObject(entry(f.w, 'soft').hash)).toBe(true);
    // the licence comes from the parent
    expect(entry(f.w, 'soft').licence.id).toBe('own');
    expect(entry(f.w, 'soft').prov.source).toBe('derived');
  });

  it('inherits the parent licence and reaches every sample it mixes (the licence report lists them)', () => {
    run('sample derive blend from=tone op="mix hits at=0.2 gain=-6"');
    const e = entry(f.w, 'blend');
    expect(e.prov.parents).toEqual([entry(f.w, 'tone').hash, entry(f.w, 'hits').hash]);
    const item = f.w.itemLicence('sample', 'blend');
    expect(item.samples.map((s) => s.name).sort()).toEqual(['blend', 'hits', 'tone']);
    expect(item.state).toBe('attribution'); // the CC-BY hits it mixes in
  });

  it('refuses a name that exists, an unknown parent, an unknown operation and a chain that leaves no audio, naming the operation', () => {
    expect(fail('sample derive tone from=hits op="gain -3"')).toMatch(/exists already/);
    expect(fail('sample derive x from=nothing op="gain -3"')).toMatch(/no sample 'nothing'/);
    expect(fail('sample derive x from=tone op="gain -3; frobnicate 4"')).toMatch(/operation 2 \(frobnicate 4\): unknown operation 'frobnicate'/);
    expect(fail('sample derive x from=tone op="trim 5 6"')).toMatch(/operation 1 \(trim 5 6\): trim \d+f \d+f: the part must lie inside the sample/);
    expect(fail('sample derive x from=tone op="slice 1"')).toMatch(/no slice points/);
    expect(fail('sample derive x from=tone')).toMatch(/op="<operations>" is needed/);
  });

  it('is atomic with the batch it is in, and undoes as one group', () => {
    run('sample derive a from=tone op="gain -3"\nsample derive b from=a op="reverse"');
    expect(f.w.sampleEntries().has('b')).toBe(true);
    run('undo');
    expect(f.w.sampleEntries().has('a')).toBe(false);
    expect(f.w.sampleEntries().has('b')).toBe(false);
    run('redo');
    expect(f.w.sampleEntries().has('b')).toBe(true);
    // a failing second command leaves nothing
    expect(fail('sample derive c from=tone op="gain -3"\nsample derive d from=missing op="gain 1"')).toMatch(/no sample 'missing'/);
    expect(f.w.sampleEntries().has('c')).toBe(false);
  });

  it('replays: the same library after a restart, and a missing object is made again with the same hash', () => {
    run('sample derive loud from=tone op="trim 0.1 0.8; stretch 1.25 method=pv; normalize lufs -20"');
    run('sample derive loud2 from=loud op="pitch 3 method=stretch; fade in=20ms"');
    const loud = entry(f.w, 'loud').hash;
    const loud2 = entry(f.w, 'loud2').hash;
    f.w.samples.store.remove(loud);
    f.w.samples.store.remove(loud2);
    expect(f.w.samples.hasObject(loud)).toBe(false);
    const again = f.reopen();
    expect(again.samples.hasObject(loud)).toBe(true);
    expect(again.samples.hasObject(loud2)).toBe(true);
    expect(entry(again, 'loud').hash).toBe(loud);
    expect(entry(again, 'loud2').hash).toBe(loud2);
  });

  it('refuses to open a project whose history says a hash this build does not reproduce', () => {
    run('sample derive soft from=tone op="gain -6"');
    const hash = entry(f.w, 'soft').hash;
    f.w.samples.store.remove(hash);
    const file = join(f.dir, 'history.jsonl');
    writeFileSync(file, readFileSync(file, 'utf8').replace('ops=\\"gain -6\\"', 'ops=\\"gain -7\\"'));
    expect(() => f.reopen()).toThrow(/made again from its parents.*comes out as .*but the history says/s);
    expect(() => f.reopen()).toThrow(ProjectError);
  });

  it('a mix of an object that is gone cannot be recomputed, and the sample stays unreadable rather than wrong', () => {
    run('sample derive blend from=tone op="mix hits at=0.1"');
    const h = entry(f.w, 'blend').hash;
    f.w.samples.store.remove(h);
    f.w.samples.store.remove(entry(f.w, 'hits').hash);
    const again = f.reopen(); // opens: it cannot make blend (a parent is gone), and says nothing wrong about it
    expect(again.samples.hasObject(h)).toBe(false);
  });
});

describe('sample slice and loop', () => {
  beforeEach(load);

  it('slices at measured onsets, at given times and on a grid, as plain frame numbers on the tape', () => {
    run('sample slice hits at=onsets');
    expect(tape().at(-1)).toMatch(/^sample set hits slices=0,1102[4-6],2205\d,3307\d$/);
    run('sample slice hits at=0,0.25,0.75');
    expect(tape().at(-1)).toBe('sample set hits slices=0,5513,16538');
    run('sample slice hits grid=4');
    expect(tape().at(-1)).toBe('sample set hits slices=0,11025,22050,33075');
    const r = run('sample slice tone grid=8 tempo=120');
    expect(entry(f.w, 'tone').slices?.length).toBe(Math.floor(44100 / (60 / 120 / 8 * 44100)));
    expect(r.warnings.join(' ')).toMatch(/slices of 8 to the beat at 120 bpm/);
    expect(fail('sample slice hits at=soon')).toMatch(/at= is onsets or times/);
    expect(fail('sample slice hits')).toMatch(/say how/);
  });

  it('a layer plays slice n, and a slice becomes a sample of its own', () => {
    run('sample slice hits grid=4\nsample derive hit3 from=hits op="slice 3"');
    expect(tape().at(-1)).toMatch(/ops="trim 22050f 33075f"/);
    expect(entry(f.w, 'hit3').frames).toBe(11025);
    run('sound new a voice=layered seed=1\nlayer add a sample sample=hits slice=3\nsound new b voice=layered seed=1\nlayer add b sample sample=hit3');
    expect(fail('layer set a 1 slice=9')).toMatch(/a layer 1 plays slice 9, but sample hits has 4 slices/);
    expect(fail('layer add b sample sample=tone slice=1')).toMatch(/sample tone has no slice points/);
  });

  it('slice points change the render key of a sound that plays the sample, and nothing else', () => {
    run('sample slice hits grid=4\nsound new a voice=layered seed=1\nlayer add a sample sample=hits slice=2\nsound new b voice=layered seed=1\nlayer add b osc wave=sine freq=300');
    const ka = f.w.render('a').key;
    const kb = f.w.render('b').key;
    run('sample slice hits at=0,0.1,0.9');
    expect(f.w.render('a').key).not.toBe(ka);
    expect(f.w.render('b').key).toBe(kb);
    expect(sampleKeyPart({ hash: 'abc' })).toBe('abc');
    expect(sampleKeyPart({ hash: 'abc', slices: [0, 5] })).toBe('abc~s0,5');
  });

  it('finds a loop in a tone and settles it as frames; a loop by hand takes seconds or frames', () => {
    const r = run('sample loop tone find');
    const line = tape().at(-1)!;
    expect(line).toMatch(/^sample set tone loop=\d+-\d+ loopmode=sustain$/);
    expect(r.warnings.join('\n')).toMatch(/chosen of \d candidates:\n {2}1\. \d+-\d+ \(.* s\): click -?[\d.]+ dB, level step/);
    run('sample loop tone 0.25 0.75');
    expect(entry(f.w, 'tone').loop).toEqual([11025, 33075]);
    run('sample loop tone 100f 2000f');
    expect(entry(f.w, 'tone').loop).toEqual([100, 2000]);
    expect(fail('sample loop tone 0.5 0.2')).toMatch(/must lie inside the sample/);
    expect(fail('sample loop tone 0.2 0.8 xfade=0.1')).toMatch(/sample derive/);
  });

  it('a baked crossfade loop is a derive that carries its loop points', () => {
    run('sample derive tone_loop from=tone op="loop 0.2 0.8 xfade=50ms"');
    const e = entry(f.w, 'tone_loop');
    expect(e.loop).toEqual([2205, 26460]);
    expect(e.loopMode).toBe('sustain');
  });
});

describe('sample layers: interp, edits, and documents written before them', () => {
  beforeEach(load);

  it('a new sample layer is written with interp=sinc; a line that never names interp replays as linear', () => {
    run('sound new a voice=layered seed=1\nlayer add a sample sample=tone pitch=5');
    expect(tape().at(-1)).toMatch(/^layer add a sample sample=tone pitch=5 interp=sinc$/);
    // what a 0.1 tape holds for the same layer has no interp
    run('sound new old voice=layered seed=1');
    const file = join(f.dir, 'history.jsonl');
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    const seq = lines.length;
    writeFileSync(file, lines.join('\n') + '\n' + JSON.stringify({ seq, by: claude, at: '2026-11-06T10:01:00Z', group: 'g99', cmd: 'layer add old sample sample=tone pitch=5' }) + '\n');
    const w = f.reopen();
    const old = w.sound('old') as LayeredSound;
    expect(old.layers[0]!.p.interp).toBe('linear');
    // and its render key is what a document without the setting always had: no interp in the text
    expect(readFileSync(join(f.dir, 'sounds', 'old.sfx'), 'utf8')).not.toMatch(/interp/);
    const sinc = w.sound('a') as LayeredSound;
    expect(sinc.layers[0]!.p.interp).toBe('sinc');
    expect(samplesHash(joinChannels(renderChannels(old, w.samples)))).not.toBe(samplesHash(joinChannels(renderChannels(sinc, w.samples))));
  });

  it('serialises the edits only when they are set, so an untouched layer reads as it always did', () => {
    run('sound new a voice=layered seed=1\nlayer add a sample sample=tone interp=linear');
    expect(tape().at(-1)).toBe('layer add a sample sample=tone');
    run('layer set a 1 fade-in=0.05 stretch=1.5 method=pv loop=2 xfade=0.1 slice=0');
    const text = readFileSync(join(f.dir, 'sounds', 'a.sfx'), 'utf8');
    expect(text).toMatch(/fade-in=0\.05 stretch=1\.5 method=pv loop=2 xfade=0\.1/);
    expect(text).not.toMatch(/slice=/);
  });
});

describe('sample bounce', () => {
  beforeEach(load);

  it('freezes a sound as a sample with where it came from: the render key and the tape position', () => {
    run('sound new thump voice=layered seed=2\nlayer add thump osc wave=sine freq=80 dur=0.3');
    const r = run('sample bounce thump_b from=thump');
    const e = entry(f.w, 'thump_b');
    expect(e.prov.source).toBe('bounce');
    expect(e.prov.origin).toBe('sound thump');
    expect(e.prov.params).toMatch(/^render [0-9a-f]{16} tape \d+$/);
    expect(e.licence.id).toBe('own'); // it reaches no sample
    expect(e.rate).toBe(44100);
    expect(e.frames).toBe(f.w.render('thump').samples.length);
    expect(r.warnings.join(' ')).toMatch(/a render of sound thump/);
  });

  it('takes the licence of the samples the sound plays (the worst of them) and lists them as parents', () => {
    run('sound new mix voice=layered seed=2\nlayer add mix sample sample=hits\nlayer add mix sample sample=tone');
    run('sample bounce mix_b from=mix');
    const e = entry(f.w, 'mix_b');
    expect(e.licence.id).toBe('CC-BY-4.0');
    expect(e.licence.attribution).toBe('test hits');
    expect(e.prov.parents).toEqual([entry(f.w, 'hits').hash, entry(f.w, 'tone').hash]);
    run('sample set hits licence=unknown');
    run('sample bounce mix_c from=mix');
    expect(entry(f.w, 'mix_c').licence.id).toBe('unknown');
  });

  it('bounces one layer, and a loop only when the sound is one', () => {
    run('sound new two voice=layered seed=2\nlayer add two osc wave=sine freq=100 dur=0.2\nlayer add two osc wave=sine freq=300 dur=0.4');
    run('sample bounce two_l1 from=two layer=1');
    expect(entry(f.w, 'two_l1').frames).toBeLessThan(f.w.render('two').samples.length);
    expect(entry(f.w, 'two_l1').prov.origin).toBe('sound two layer 1');
    expect(fail('sample bounce nope from=two loop=yes')).toMatch(/has no loop/);
    expect(fail('sample bounce nope from=two layer=5')).toMatch(/no layer 5/);
    expect(fail('sample bounce nope from=ghost')).toMatch(/no sound or song 'ghost'/);
    run('sound loop two 1');
    run('sample bounce two_loop from=two loop=yes');
    expect(entry(f.w, 'two_loop').loop).toEqual([0, entry(f.w, 'two_loop').frames]);
  });

  it('is replayed from the tape without rendering anything: the sample add carries the hash', () => {
    run('sound new thump voice=layered seed=2\nlayer add thump osc wave=sine freq=80 dur=0.3\nsample bounce thump_b from=thump');
    const hash = entry(f.w, 'thump_b').hash;
    const again = f.reopen();
    expect(entry(again, 'thump_b').hash).toBe(hash);
  });
});

describe('layer align, match and follow', () => {
  beforeEach(load);

  it('put plain layer set and env commands on the tape: offset, gain and a breakpoint envelope', () => {
    run('sample slice hits grid=4\nsound new door voice=layered seed=2\nlayer add door sample sample=hits slice=2\nlayer add door osc wave=sine freq=70 dur=0.25');
    const r = run('layer align door 2 to=1 by=peak');
    expect(tape().at(-1)).toMatch(/^layer set door 2 offset=[\d.]+$/);
    expect(r.warnings.join(' ')).toMatch(/its peak/);
    run('layer match door 2 to=1 db=-6');
    expect(tape().at(-1)).toMatch(/^layer set door 2 gain=[\d.]+$/);
    run('env door 2.amp follow=1 attack=0.002 release=0.05');
    expect(tape().at(-1)).toMatch(/^env door 2\.amp "0:[\d.]+ [^"]+"$/);
    // the tape holds numbers: a fresh writer has the same sound
    const again = f.reopen();
    expect(JSON.stringify(again.sound('door'))).toBe(JSON.stringify(f.w.sound('door')));
  });

  it('match lands the layer at the other layer\'s loudness plus the offset', () => {
    run('sound new lv voice=layered seed=2\nlayer add lv osc wave=sine freq=200 dur=0.5 gain=0.8\nlayer add lv osc wave=sine freq=300 dur=0.5 gain=0.2');
    run('layer match lv 2 to=1 db=-3');
    const g = (f.w.sound('lv') as LayeredSound).layers[1]!.p.gain as number;
    // a 3 dB drop from 0.8 is about 0.566
    expect(g).toBeGreaterThan(0.5);
    expect(g).toBeLessThan(0.64);
  });

  it('say why when they cannot: a muted layer, itself, a silent source, an offset that would be negative', () => {
    run('sound new x voice=layered seed=2\nlayer add x osc wave=sine freq=100 dur=0.4\nlayer add x osc wave=sine freq=100 dur=0.2\nenv x 1.amp "0:0 0.2:1 0.4:0"');
    expect(fail('layer align x 1 to=2 by=onset')).toMatch(/cannot be moved early enough/);
    expect(fail('layer align x 1 to=1')).toMatch(/cannot be aligned to itself/);
    expect(fail('layer match x 2 to=2')).toMatch(/cannot be matched to itself/);
    expect(fail('layer align x 3 to=1')).toMatch(/no layer 3/);
    run('layer mute x 2 on');
    expect(fail('layer match x 1 to=2')).toMatch(/does not sound/);
    expect(fail('env x 1.amp follow=sample:nothing')).toMatch(/no sample 'nothing'/);
  });

  it('an envelope can follow a sample, from the layer\'s own start', () => {
    run('sound new f voice=layered seed=2\nlayer add f osc wave=sine freq=100 dur=2');
    run('env f 1.amp follow=sample:hits attack=0.001 release=0.03');
    const env = (f.w.sound('f') as LayeredSound).layers[0]!.amp!;
    expect(env.length).toBeGreaterThan(20);
    expect(Math.max(...env.map((p) => p.v))).toBeCloseTo(1, 3);
    expect(env.at(-1)!.v).toBe(0);
  });
});

describe('samples in the ears', () => {
  beforeEach(load);

  it('describe and measure take sample:<name> and hash:<digits>: words, numbers, provenance and advisory checks', () => {
    run('sample slice hits at=onsets\nsample loop tone find');
    const t = describeText(f.w, 'sample:hits');
    expect(t).toMatch(/^sample:hits: 2\.00 s, 22050 Hz, mono;/);
    expect(t).toMatch(/4 hits/);
    expect(t).toMatch(/onsets 4 at 0\.000, 0\.500/);
    expect(t).toMatch(/source file \(hits\.wav\); licence CC-BY-4\.0 \(attribution\)/);
    expect(t).toMatch(/5 slices|4 slices/);
    const byHash = describeText(f.w, `hash:${entry(f.w, 'hits').hash.slice(0, 10)}`);
    expect(byHash).toMatch(/^hash:[0-9a-f]{12}: 2\.00 s/);
    const j = JSON.parse(describeJson(f.w, 'sample:tone')) as { measure: { pitch: { note: string } }; licenceState: string; loop: number[]; checks: { name: string }[] };
    expect(j.measure.pitch.note).toBe('A3');
    expect(j.licenceState).toBe('shippable');
    expect(j.loop).toHaveLength(2);
    expect(j.checks.map((c) => c.name)).toContain('loop-seam');
    expect(() => describeText(f.w, 'sample:ghost')).toThrow(/no sample 'ghost' \(samples: hits, tone\)/);
    expect(() => describeText(f.w, 'hash:zz')).toThrow(/8 to 64 hex digits/);
    expect(() => describeText(f.w, 'hash:00000000')).toThrow(/no audio with a hash starting/);
  });

  it('views: wave, spec, pitch, loop and slices of a sample are saved as PNGs; compare takes samples, sounds and hashes', () => {
    run('sample slice hits grid=4\nsample loop tone 0.2 0.8\nsound new thump voice=layered seed=2\nlayer add thump sample sample=tone');
    for (const kind of ['wave', 'spec', 'pitch', 'loop', 'slices'] as const) {
      const v = viewSound(f.w, 'sample:tone', kind);
      expect(existsSync(v.file), kind).toBe(true);
      expect(String.fromCharCode(...v.png.subarray(1, 4))).toBe('PNG');
    }
    expect(viewSound(f.w, 'sample:hits', 'slices').text).toMatch(/4 slices at frames 0, 11025, 22050, 33075/);
    expect(viewSound(f.w, 'sample:tone', 'loop').text).toMatch(/loop 8820-35280 frames; seam jump/);
    expect(() => viewSound(f.w, 'sample:tone', 'layers')).toThrow(/no view 'layers' for a sample/);
    const c = viewSound(f.w, 'sample:tone', 'compare', { other: 'thump' });
    expect(c.text).toMatch(/spectral distance/);
    const n = compareText(f.w, 'sample:tone', `hash:${entry(f.w, 'tone').hash.slice(0, 12)}`);
    expect((n.json.distance as { spectralDb: number }).spectralDb).toBeCloseTo(0, 5);
    expect(n.text).toMatch(/A = sample:tone/);
  });

  it('sample check is advice: it flags a clipped, offset, silent-ended or noisy sample and says it gates nothing', () => {
    const n = 44100;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = i > n - 4410 ? 0 : Math.max(-1, Math.min(1, 3 * Math.sin(i * 0.05))) + 0.05;
    importPath(f.w, wav('bad.wav', [x], 44100), { by: claude, as: 'bad' });
    const t = sampleCheckText(f.w, ['bad']);
    expect(t).toMatch(/! clipping/);
    expect(t).toMatch(/! dc/);
    expect(t).toMatch(/! silence: .*and 100 ms at the end/);
    expect(t).toMatch(/advice only: a sample is material/);
    expect(sampleCheckText(f.w, ['tone'])).not.toMatch(/! clipping/);
    // work done is not gated by a sample's checks: a sound is
    expect(sampleCheckText(f.w, [])).toMatch(/3 samples checked, \d with something to look at/);
  });

  it('measures once per hash', () => {
    const a = sampleSide(f.w, 'sample:tone');
    expect(measureHash(a)).toBe(measureHash(sampleSide(f.w, `hash:${a.hash}`)));
  });
});

describe('the numbers query on samples', () => {
  beforeEach(load);

  it('keeps the samples a query fits, closest first, and lists them as JSON', () => {
    run('sample set hits tags=wood,hit\nsample derive soft from=hits op="gain -6"');
    expect(sampleListText(f.w, 'onsets=4')).toMatch(/^hits /);
    expect(sampleListText(f.w, 'tag=wood')).not.toMatch(/tone/);
    expect(sampleListText(f.w, 'pitched=yes channels=1')).toMatch(/^tone /);
    expect(sampleListText(f.w, 'dur=0.9-1.1')).toMatch(/^tone /);
    expect(sampleListText(f.w, 'source=derived')).toMatch(/^soft /);
    expect(sampleListText(f.w, 'licence=attribution')).toMatch(/hits/);
    expect(sampleListText(f.w, 'licence=own')).toMatch(/tone/);
    expect(sampleListText(f.w, 'dur>5')).toMatch(/no sample fits that query/);
    expect(() => sampleListText(f.w, 'woods=x')).toThrow(/no key 'woods'/);
    const json = JSON.parse(sampleListText(f.w, undefined, { json: true })) as { name: string; licenceState: string }[];
    expect(json.map((x) => x.name)).toEqual(['hits', 'soft', 'tone']);
    expect(() => sampleQueryText(f.w, 'frob=3')).toThrow(/frob/);
    // with no query and no flag the list is the plain one the earlier tools print
    expect(sampleListText(f.w)).toMatch(/^hits: 2\.000 s/);
  });
});
