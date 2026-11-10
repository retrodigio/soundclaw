// view compare with an audio file for either side.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeWavChannels, resample } from '@soundclaw/core';
import { compareText, viewSound } from '../src/index.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
beforeEach(() => {
  f = fixture();
  const r = f.w.run({ commands: 'sound new a voice=layered\nlayer add a osc freq=440 dur=0.5\nsound new b voice=layered\nlayer add b osc freq=660 dur=0.5\nsong new s tempo=120\nsong channel add s lead inst=square_lead\npattern s.p steps=8 tpb=4\n  lead: C5 - E5 - G5 - E5 -\nsong section add s x p\n', by: 'agent:claude' });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
});
afterEach(() => f.clean());

const distanceLine = (text: string): string => text.split('\n').find((l) => /distance|dB/i.test(l)) ?? '';
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

describe('view compare with a file', () => {
  it('a sound against a WAV of itself outside the project: the same numbers as the sound against itself', () => {
    const samples = f.w.render('a').samples;
    const file = join(f.root, 'ref.wav');
    writeFileSync(file, encodeWavChannels([samples]));
    const withFile = viewSound(f.w, 'a', 'compare', { other: file });
    const withSound = viewSound(f.w, 'a', 'compare', { other: 'a' });
    expect(withFile.png.length).toBeGreaterThan(1000);
    expect(withFile.text).toContain('ref.wav: mono, 44100 Hz, 0.50 s');
    // the same numbers, up to the 16 bits of the file
    expect(withFile.text).toMatch(/duration \+0\.000 s; loudness [-+]0\.0 LU; true peak [-+]0\.0 dB; brightness [-+][0-2] Hz/);
    expect(withFile.text).toMatch(/envelope correlation 1\.00/);
    expect(withSound.text).toMatch(/envelope correlation 1\.00/);
    expect(withFile.file).toMatch(/\.cache\/views\/a-vs-ref\.wav-compare-/);
  });
  it('either side can be the file, and a sound compared with a different one differs', () => {
    const file = join(f.root, 'ref.wav');
    writeFileSync(file, encodeWavChannels([f.w.render('b').samples]));
    const left = viewSound(f.w, file, 'compare', { other: 'a' });
    const same = viewSound(f.w, file, 'compare', { other: 'b' });
    expect(left.text).not.toBe(same.text);
    expect(left.text).toContain('ref.wav');
    expect(left.text).toMatch(/a: /);
  });
  it('a WAV at another rate is resampled and says so; stereo is mixed to mono', () => {
    const x = f.w.render('a').samples;
    const half = resample(x, 44100, 22050);
    const file = join(f.root, 'low.wav');
    writeFileSync(file, encodeWavChannels([half, half], 22050));
    const v = viewSound(f.w, 'a', 'compare', { other: file });
    expect(v.text).toMatch(/low\.wav: 2 channels mixed to mono, 22050 Hz \(.* to 44100 Hz\), 0\.50 s/);
  });
  it('a song is a side too: its full mix', () => {
    const file = join(f.root, 'ref.wav');
    writeFileSync(file, encodeWavChannels([f.w.render('a').samples]));
    const v = viewSound(f.w, 's', 'compare', { other: file });
    expect(v.text).toMatch(/s: the song's full mix, mono/);
    expect(v.png.length).toBeGreaterThan(1000);
  });
  it.skipIf(!hasFfmpeg)('an OGG reference is read through ffmpeg', () => {
    const wav = join(f.root, 'ref.wav'), ogg = join(f.root, 'ref.ogg');
    writeFileSync(wav, encodeWavChannels([f.w.render('a').samples]));
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-c:a', 'libvorbis', ogg]);
    const v = viewSound(f.w, 'a', 'compare', { other: ogg });
    expect(v.text).toMatch(/ref\.ogg: decoded by ffmpeg to mono 44100 Hz, 0\.\d\d s/);
  });
  it('says what is wrong: a name that is nothing, a file that is not audio', () => {
    expect(() => viewSound(f.w, 'a', 'compare', { other: 'nothing_here' })).toThrow(/no sound, song or audio file 'nothing_here'/);
    expect(() => viewSound(f.w, 'a', 'compare', {})).toThrow(/needs a second sound, song or audio file/);
    const txt = join(f.root, 'notes.txt');
    writeFileSync(txt, 'not audio');
    expect(() => viewSound(f.w, 'a', 'compare', { other: txt })).toThrow(/notes\.txt/);
  });
});

describe('compare does not depend on level when asked', () => {
  const nums = (text: string, re: RegExp): number[] => (re.exec(text) ?? []).slice(1).map(Number);
  it('the same sound at two gains: the as-they-are distances differ, the level-matched ones agree', () => {
    f.w.run({ commands: 'sound new q voice=layered\nlayer add q osc freq=440 dur=0.5\nsound set q gain=0.2\nsound new r voice=layered\nlayer add r osc freq=440 dur=0.5 filter=lp cutoff=900\nsound set r gain=0.9', by: 'agent:claude' });
    const file = join(f.root, 'ref.wav');
    writeFileSync(file, encodeWavChannels([f.w.render('r').samples]));
    const loud = compareText(f.w, 'a', file).text, quiet = compareText(f.w, 'q', file).text;
    const raw = (t: string): number => nums(t, /spectral distance ([\d.]+) dB \(mean/)[0]!;
    const matched = (t: string): number => nums(t, /with the level matched \(.*\): ([\d.]+) dB/)[0]!;
    expect(Math.abs(raw(loud) - raw(quiet))).toBeGreaterThan(2);
    expect(Math.abs(matched(loud) - matched(quiet))).toBeLessThan(0.6);
    expect(quiet).toMatch(/with the level matched \(ref\.wav [+-][\d.]+ dB to be as loud as q\)/);
    // --match-level puts the matched one first and still prints the other
    const lead = compareText(f.w, 'q', file, true).text;
    expect(lead).toMatch(/spectral distance [\d.]+ dB with the level matched/);
    expect(lead).toMatch(/as they are: [\d.]+ dB/);
    const j = compareText(f.w, 'q', file, true).json as { matchLevel: boolean; distance: { spectralDb: number; spectralMatchedDb: number; levelMatchDb: number } };
    expect(j.matchLevel).toBe(true);
    expect(j.distance.spectralMatchedDb).toBeLessThan(j.distance.spectralDb);
    expect(Math.abs(j.distance.levelMatchDb)).toBeGreaterThan(1);
    // the same thing against itself is 0 at any level once matched
    const self = compareText(f.w, 'q', 'a').json as { distance: { spectralMatchedDb: number; spectralDb: number } };
    expect(self.distance.spectralMatchedDb).toBeLessThan(0.3);
    expect(self.distance.spectralDb).toBeGreaterThan(2);
    // the picture's text carries both too
    expect(viewSound(f.w, 'q', 'compare', { other: 'a', matchLevel: true }).text).toMatch(/spectral distance [\d.]+ dB with the level matched[\s\S]*as they are: [\d.]+ dB/);
  });
});
void distanceLine;

describe('describe, measure and view read a reference file where they read a sound', () => {
  it('describe and measure give the numbers of a file outside the project, and import nothing', async () => {
    const { describeText, describeJson, measureJson, isRef } = await import('../src/index.ts');
    const file = join(f.root, 'ref.wav');
    writeFileSync(file, encodeWavChannels([f.w.render('a').samples]));
    expect(isRef(f.w, file)).toBe(true);
    expect(isRef(f.w, 'a')).toBe(false);
    expect(isRef(f.w, join(f.root, 'nothing.wav'))).toBe(false);
    const before = f.w.samples.names().length;
    const text = describeText(f.w, file);
    expect(text).toMatch(/^ref\.wav: 0\.50 s/);
    expect(text).toMatch(/pitch A4/);
    expect(text).toContain('a file outside the project');
    const j = JSON.parse(describeJson(f.w, file)) as { ref: string; measure: { duration: number; pitch: { hz: number } } };
    expect(j.ref).toBe('ref.wav');
    expect(j.measure.duration).toBeCloseTo(0.5, 2);
    expect(j.measure.pitch.hz).toBeCloseTo(440, 0);
    expect(f.w.samples.names().length).toBe(before);
    expect(measureJson(f.w, ['a']).json).toContain('"id": "a"'); // a sound of the project is still a sound
  });
  it('view of a file draws it like a sample, and a file that is not audio says so', () => {
    const file = join(f.root, 'ref.wav');
    writeFileSync(file, encodeWavChannels([f.w.render('a').samples]));
    const v = viewSound(f.w, file, 'spec');
    expect(v.png.length).toBeGreaterThan(1000);
    expect(v.text).toContain('ref.wav');
    const txt = join(f.root, 'notes.txt');
    writeFileSync(txt, 'not audio');
    expect(() => viewSound(f.w, txt, 'spec')).toThrow(/notes\.txt/);
  });
  it('the CLI: describe and measure take the path', () => {
    const file = join(f.root, 'ref.wav');
    writeFileSync(file, encodeWavChannels([f.w.render('a').samples]));
    const run = (args: string[]): string => execFileSync('node', ['--no-warnings', join(__dirname, '../../cli/bin/soundclaw.js'), ...args], { encoding: 'utf8' });
    expect(run(['describe', f.dir, file])).toMatch(/^ref\.wav: 0\.50 s/);
    const m = JSON.parse(run(['measure', f.dir, file, '--json'])) as { samples: { ref: string }[] };
    expect(m.samples[0]!.ref).toBe('ref.wav');
  });
});
