// view compare with an audio file for either side.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeWavChannels, resample } from '@soundclaw/core';
import { viewSound } from '../src/index.ts';
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
void distanceLine;
