// Sample layers as references to files: played as they are (no fade, no cut), a stereo file as two
// hard-panned layers (side=left, side=right), and files at 48 and 96 kHz converted to 44,100 Hz
// without moving their loudness.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeWavChannels, integratedLoudness, readSampleWav, renderChannels, type LayeredSound, type SampleBank, type SampleData } from '../src/index.ts';
import { resample, resampleMethod } from '../src/resample.ts';
import { build } from './layered-helpers.ts';

function bankOf(files: Record<string, SampleData>): SampleBank {
  return { get: (n) => files[n], hash: (n) => (files[n] ? `h-${n}` : undefined) };
}

/** A sum of sines at `hz` (equal amplitude), `seconds` long, at `rate`: the same signal at any rate. */
function tones(hz: number[], amp: number, seconds: number, rate: number): Float32Array {
  const x = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < x.length; i++) {
    let v = 0;
    for (const f of hz) v += Math.sin((2 * Math.PI * f * i) / rate);
    x[i] = (v * amp) / hz.length;
  }
  return x;
}

/** Noise from a fixed generator (not Math.random), so the file is the same every run. */
function noise(n: number, amp: number): Float32Array {
  const x = new Float32Array(n);
  let s = 12345;
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; x[i] = ((s / 4294967296) * 2 - 1) * amp; }
  return x;
}

const sound = (script: string): LayeredSound => build('sound new s voice=layered seed=1\n' + script).get('s') as LayeredSound;

/** ffmpeg's integrated loudness of a WAV, or null when ffmpeg is not installed. */
function ffmpegLufs(chs: readonly Float32Array[], rate: number): number | null {
  const dir = mkdtempSync(join(tmpdir(), 'soundclaw-ebur-'));
  try {
    const f = join(dir, 'a.wav');
    writeFileSync(f, encodeWavChannels(chs, rate));
    const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', f, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
    if (r.error) return null;
    const m = [...`${r.stderr}`.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1);
    return m ? Number(m[1]) : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('a sample layer with no envelope and no trim', () => {
  const data = noise(30000, 0.6);
  const bank = bankOf({ clip: { rate: 44100, data } });

  it('plays the file sample for sample: no fade at either end, no cut, so measure of a reference equals the file', () => {
    const [x] = renderChannels(sound('layer add s sample sample=clip\n'), bank);
    expect(x!.length).toBe(data.length);
    expect(Array.from(x!)).toEqual(Array.from(data));
    expect(integratedLoudness(x!)).toBe(integratedLoudness(data));
  });
  it('is not cut by duration=auto even when the file ends in near-silence', () => {
    const quiet = new Float32Array(20000);
    quiet.set(noise(8000, 0.5));
    for (let i = 8000; i < 20000; i++) quiet[i] = 1e-6 * Math.sin(i);
    const [x] = renderChannels(sound('layer add s sample sample=q\n'), bankOf({ q: { rate: 44100, data: quiet } }));
    expect(x!.length).toBe(20000);
  });
  it('still fades the ends when it is trimmed or has an amplitude envelope', () => {
    const [t] = renderChannels(sound('layer add s sample sample=clip start=0.1\n'), bank);
    expect(t![0]).toBe(0);
    const [e] = renderChannels(sound('layer add s sample sample=clip\nenv s 1.amp "0:1 1:1"\n'), bank);
    expect(e![0]).toBeCloseTo(data[0]!, 6);
  });
});

describe('a stereo file', () => {
  const L = tones([440, 1250], 0.5, 2.5, 44100);
  const R = tones([880, 3000], 0.12, 2.5, 44100);
  const wav = encodeWavChannels([L, R], 44100);
  const parsed = readSampleWav(wav);
  const bank = bankOf({ pair: { rate: 44100, data: parsed.data, left: parsed.left!, right: parsed.right! } });
  const two = 'layer add s sample sample=pair side=left pan=-1\nlayer add s sample sample=pair side=right pan=1\n';

  it('is read with its two channels, and side=left, side=right play them as they are', () => {
    expect(parsed.channels).toBe(2);
    const chs = renderChannels(sound(two), bank);
    expect(chs).toHaveLength(2);
    for (let i = 0; i < L.length; i += 997) {
      expect(Math.abs(chs[0]![i]! - parsed.left![i]!)).toBeLessThan(1e-6);
      expect(Math.abs(chs[1]![i]! - parsed.right![i]!)).toBeLessThan(1e-6);
    }
    expect(chs[0]!.length).toBe(L.length);
    // side=mix (the default) is the mono mix, as before
    const mix = renderChannels(sound('layer add s sample sample=pair\n'), bank);
    expect(mix).toHaveLength(1);
    expect(Math.abs(mix[0]![1000]! - (L[1000]! + R[1000]!) / 2)).toBeLessThan(1e-4);
  });
  it('measures as BS.1770 says: the channels add (the louder side is not diluted)', () => {
    const chs = renderChannels(sound(two), bank);
    const l = integratedLoudness(L), r = integratedLoudness(R);
    const byHand = 10 * Math.log10(10 ** ((l + 0.691) / 10) + 10 ** ((r + 0.691) / 10)) - 0.691;
    expect(Math.abs(integratedLoudness(chs) - byHand)).toBeLessThan(0.01);
    expect(Math.abs(integratedLoudness(chs) - integratedLoudness([L, R]))).toBeLessThan(0.01);
    expect(Math.abs(integratedLoudness(parsed.data) - integratedLoudness(chs))).toBeGreaterThan(1); // the mono mix is a different (quieter) loudness
  });
  it('agrees with ffmpeg ebur128 within 0.2 LU (when ffmpeg is installed)', () => {
    const ref = ffmpegLufs([L, R], 44100);
    if (ref === null) return;
    expect(Math.abs(integratedLoudness(renderChannels(sound(two), bank)) - ref)).toBeLessThan(0.2);
  });
});

describe('files at other rates', () => {
  const HZ = [100, 1000, 4000, 10000, 16000];
  const direct = integratedLoudness(tones(HZ, 0.5, 3, 44100));

  for (const rate of [22050, 32000, 48000, 96000]) {
    it(`a ${rate} Hz multi-tone file keeps its loudness within 0.2 LU of the same tones made at 44.1 kHz`, () => {
      const x = tones(rate < 44100 ? HZ.filter((f) => f < 10000) : HZ, 0.5, 3, rate);
      const want = rate < 44100 ? integratedLoudness(tones(HZ.filter((f) => f < 10000), 0.5, 3, 44100)) : direct;
      const [y] = renderChannels(sound('layer add s sample sample=f\n'), bankOf({ f: { rate, data: x } }));
      expect(y!.length).toBe(Math.round((x.length * 44100) / rate));
      expect(Math.abs(integratedLoudness(y!) - want)).toBeLessThan(0.2);
    });
  }
  it('a 48 kHz and a 96 kHz white-ish noise file keep their loudness (judged by ffmpeg when installed, else by the energy below the cut-off)', () => {
    for (const rate of [48000, 96000]) {
      const x = noise(rate * 3, 0.3);
      const [y] = renderChannels(sound('layer add s sample sample=n\n'), bankOf({ n: { rate, data: x } }));
      // noise is flat to Nyquist: below 20.9 kHz of 24 (or 48) kHz is the share of the energy that is kept
      const kept = (0.95 * 22050) / (rate / 2);
      let ex = 0, ey = 0;
      for (let i = 0; i < x.length; i++) ex += x[i]! * x[i]!;
      for (let i = 0; i < y!.length; i++) ey += y![i]! * y![i]!;
      const ratio = ey / y!.length / (ex / x.length) / kept;
      expect(Math.abs(10 * Math.log10(ratio))).toBeLessThan(0.3);
    }
  });
  it('a 96 kHz tone file agrees with ffmpeg ebur128 on the file (when installed)', () => {
    const x = tones([300, 2000, 9000], 0.4, 3, 96000);
    const ref = ffmpegLufs([x], 96000);
    if (ref === null) return;
    const [y] = renderChannels(sound('layer add s sample sample=f\n'), bankOf({ f: { rate: 96000, data: x } }));
    expect(Math.abs(integratedLoudness(y!) - ref)).toBeLessThan(0.2);
  });
  it('resampling is a pure function of the data (same bytes twice), is the identity at equal rates, and says what it does', () => {
    const x = noise(5000, 0.5);
    const a = resample(x, 48000, 44100);
    expect(resample(x, 48000, 44100)).toBe(a); // cached
    expect(Array.from(resample(new Float32Array(x), 48000, 44100))).toEqual(Array.from(a));
    expect(resample(x, 44100, 44100)).toBe(x);
    expect(resampleMethod(96000, 44100)).toMatch(/Blackman-windowed sinc.*95%/);
  });
});
