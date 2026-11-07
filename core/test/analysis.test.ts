// The measurements, against synthetic signals with known answers.

import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  Canvas, DEFAULT_STYLE, SAMPLE_RATE, analyze, checkSummary, checksPass, compareView, describe as describeSound, fft, formatChecks, formatNumbers, hzToMidi, integratedLoudness, melSpectrogram, noteName,
  pitchView, resolveStyle, runChecks, specView, stft, truePeak, waveView, zlibCompress, type Samples,
} from '../src/index.ts';

const N = SAMPLE_RATE;
const sine = (hz: number, amp: number, secs = 1): Float32Array => Float32Array.from({ length: Math.round(secs * N) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / N));
const db = (x: number) => 20 * Math.log10(x);

describe('FFT', () => {
  it('matches a direct DFT and inverts', () => {
    const n = 64;
    const x = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1));
    const re = Float64Array.from(x), im = new Float64Array(n);
    fft(re, im);
    for (const k of [0, 1, 5, 17, 31]) {
      let r = 0, m = 0;
      for (let t = 0; t < n; t++) { r += x[t]! * Math.cos((2 * Math.PI * k * t) / n); m -= x[t]! * Math.sin((2 * Math.PI * k * t) / n); }
      expect(re[k]).toBeCloseTo(r, 9);
      expect(im[k]).toBeCloseTo(m, 9);
    }
    fft(re, im, true);
    for (let i = 0; i < n; i++) expect(re[i]).toBeCloseTo(x[i]!, 12);
  });

  it('the STFT of a unit sine peaks at the right bin with amplitude near 1', () => {
    const s = stft(sine(1000, 1, 0.5), 1024, 256);
    const m = s.mags[20]!;
    const peakBin = m.indexOf(Math.max(...m));
    expect(peakBin * (N / 1024)).toBeCloseTo(1000, -2);
    expect(Math.max(...m)).toBeGreaterThan(0.9);
    expect(Math.max(...m)).toBeLessThan(1.05);
  });
});

describe('a 1 kHz sine at −20 dBFS', () => {
  const a = analyze(sine(1000, 0.1));
  it('has the known loudness (−23.0 LUFS), peaks, crest factor and no DC', () => {
    expect(a.duration).toBe(1);
    expect(a.lufs).toBeCloseTo(-23.0, 1);
    expect(a.peakDb).toBeCloseTo(-20, 2);
    expect(a.truePeakDb).toBeCloseTo(-20, 1);
    expect(a.rmsDb).toBeCloseTo(-23.01, 2);
    expect(a.crestDb).toBeCloseTo(3.01, 1);
    expect(Math.abs(a.dc)).toBeLessThan(1e-4);
  });
  it('has a centroid and a pitch at 1 kHz', () => {
    expect(a.centroid.mean).toBeGreaterThan(970);
    expect(a.centroid.mean).toBeLessThan(1040);
    expect(a.pitch.start).toBeCloseTo(1000, -1);
    expect(a.pitch.end).toBeCloseTo(1000, -1);
    expect(a.pitch.rangeSemitones).toBeLessThan(0.1);
    expect(a.pitch.voiced).toBeGreaterThan(0.9);
    expect(a.flatness).toBeLessThan(0.01);
  });
  it('is one onset, a sharp attack, no tail and no silence', () => {
    expect(a.onsets).toBe(1);
    expect(a.attack).toBeLessThan(0.0005);
    expect(a.tail).toBeLessThan(0.02);
    expect(a.leadingSilence).toBeLessThan(0.001);
    expect(a.trailingSilence).toBe(0);
    expect(a.silent).toBe(false);
  });
  it('is described in plain words from those numbers', () => {
    const d = describeSound(a);
    expect(d).toMatch(/^1\.00 s, tonal and mid-range \(centroid about 1\.0 kHz\), steady pitch near 1\.0 kHz \(B5\), sharp attack/);
    expect(d).toContain('-23.0 LUFS');
    expect(d).toMatch(/1 onset\.$/);
    expect(formatNumbers(a)).toContain('loudness -23.0 LUFS, true peak -20.0 dBTP');
  });
});

describe('loudness', () => {
  it('doubling the amplitude adds 6 dB; silence is −Infinity; short sounds are measured whole', () => {
    expect(integratedLoudness(sine(1000, 0.2)) - integratedLoudness(sine(1000, 0.1))).toBeCloseTo(6.02, 2);
    expect(integratedLoudness(new Float32Array(1000))).toBe(-Infinity);
    expect(integratedLoudness(sine(1000, 0.1, 0.1))).toBeCloseTo(-23.0, 0);
  });
  it('gates out silence: a tone followed by a long pause has the tone\'s loudness', () => {
    const x = new Float32Array(N * 3);
    x.set(sine(1000, 0.1, 1));
    // the blocks that only half overlap the tone count too (BS.1770), so a little under the tone's own −23.0; without gating it would be −27.8
    expect(integratedLoudness(x)).toBeGreaterThan(-24);
    expect(integratedLoudness(x)).toBeLessThan(-22.9);
  });
  it('weights frequencies: a 100 Hz tone reads lower than a 1 kHz tone of the same amplitude, a 4 kHz one higher', () => {
    const l = (hz: number) => integratedLoudness(sine(hz, 0.1));
    expect(l(100)).toBeLessThan(l(1000) - 0.3);
    expect(l(4000)).toBeGreaterThan(l(1000) + 2);
  });
});

describe('true peak', () => {
  it('finds a peak between samples that the samples miss', () => {
    // fs/4 with a 45° phase: the samples sit at ±0.69 of the 0.98 peak
    const x = Float32Array.from({ length: 4000 }, (_, i) => 0.98 * Math.sin((2 * Math.PI * (N / 4) * i) / N + 0.7854));
    const sample = Math.max(...x.map(Math.abs));
    expect(db(sample)).toBeCloseTo(-3.2, 0);
    expect(db(truePeak(x))).toBeGreaterThan(-0.5);
    expect(db(truePeak(x))).toBeLessThan(0.3);
  });
  it('equals the sample peak for a slow signal', () => {
    const x = sine(100, 0.5, 0.2);
    expect(db(truePeak(x))).toBeCloseTo(db(0.5), 1);
  });
});

describe('other signals with known answers', () => {
  it('a click: one impulse in silence, high crest factor, an onset, silence around it', () => {
    const x = new Float32Array(N / 2);
    x[N / 4] = 0.8;
    const a = analyze(x);
    expect(a.peak).toBeCloseTo(0.8, 6);
    expect(a.crestDb).toBeGreaterThan(40);
    expect(a.onsets).toBe(1);
    expect(a.leadingSilence).toBeCloseTo(0.25, 2);
    expect(a.trailingSilence).toBeCloseTo(0.25, 2);
    expect(a.pitch.start).toBeNull();
  });

  it('DC: a constant offset is measured', () => {
    const x = Float32Array.from(sine(500, 0.1, 0.5), (v) => v + 0.1);
    expect(analyze(x).dc).toBeCloseTo(0.1, 3);
  });

  it('a long tail: an exponential decay with τ = 0.1 s is 0.66 s from its loud part to −60 dB', () => {
    const n = N * 2;
    const x = Float32Array.from({ length: n }, (_, i) => Math.exp(-i / N / 0.1) * Math.sin((2 * Math.PI * 440 * i) / N));
    const a = analyze(x);
    // −3 dB at τ·ln(√2) = 0.035 s, −60 dB at τ·ln(1000) = 0.69 s
    expect(a.tail).toBeGreaterThan(0.6);
    expect(a.tail).toBeLessThan(0.72);
    expect(describeSound(a)).toContain('medium tail');
  });

  it('a sweep from 880 down to 220 Hz reads as falling, with its start and end pitches', () => {
    const n = Math.round(N * 0.5);
    let phase = 0;
    const x = Float32Array.from({ length: n }, (_, i) => {
      const f = 880 * Math.pow(0.25, i / n);
      phase += (2 * Math.PI * f) / N;
      return 0.5 * Math.sin(phase);
    });
    const a = analyze(x);
    expect(a.pitch.start!).toBeGreaterThan(800);
    expect(a.pitch.start!).toBeLessThan(900);
    expect(a.pitch.end!).toBeGreaterThan(215);
    expect(a.pitch.end!).toBeLessThan(260);
    expect(a.pitch.rangeSemitones).toBeGreaterThan(18);
    expect(describeSound(a)).toMatch(/falling from about \d+ Hz \(G#5\) to \d+ Hz \(B3\)/);
  });

  it('two bursts apart are two onsets; noise is noisy, high-flatness and unpitched', () => {
    const x = new Float32Array(N);
    x.set(sine(800, 0.5, 0.1), 0);
    x.set(sine(800, 0.5, 0.1), Math.round(N * 0.5));
    const a = analyze(x);
    expect(a.onsets).toBe(2);
    expect(a.onsetTimes[1]).toBeCloseTo(0.5, 1);
    let s = 12345;
    const noise = Float32Array.from({ length: N / 2 }, () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s / 4294967296 - 0.5) * 0.5; });
    const b = analyze(noise);
    expect(b.flatness).toBeGreaterThan(0.3);
    expect(b.pitch.voiced).toBeLessThan(0.2);
    expect(describeSound(b)).toMatch(/noisy/);
    expect(b.centroid.mean).toBeGreaterThan(8000);
  });

  it('silence is silent, with numbers that do not blow up', () => {
    const a = analyze(new Float32Array(1000));
    expect(a.silent).toBe(true);
    expect(describeSound(a)).toBe('23 ms of silence.');
    expect(formatNumbers(a)).toContain('silent');
  });

  it('names notes', () => {
    expect(noteName(440)).toBe('A4');
    expect(noteName(261.63)).toBe('C4');
    expect(noteName(880)).toBe('A5');
    expect(hzToMidi(440)).toBe(69);
  });

  it('the mel spectrogram puts a tone in the right band and has the frame count and band count asked for', () => {
    const m = melSpectrogram(sine(2000, 0.5, 0.3), { bands: 64, hop: 256 });
    expect(m.freqs).toHaveLength(64);
    expect(m.db).toHaveLength(Math.ceil(0.3 * N / 256));
    const row = m.db[20]!;
    const best = row.indexOf(Math.max(...row));
    expect(m.freqs[best]!).toBeGreaterThan(1700);
    expect(m.freqs[best]!).toBeLessThan(2400);
  });
});

describe('checks', () => {
  const run = (x: Samples, style = DEFAULT_STYLE) => runChecks(x, analyze(x), style);
  const by = (r: ReturnType<typeof run>, n: string) => r.find((c) => c.name === n)!;
  /** A sound that passes all five: a sine with a fade in and out, at about −16 LUFS. */
  const good = (amp = 0.245, secs = 0.5): Float32Array => {
    const x = sine(440, amp, secs);
    const n = x.length;
    for (let i = 0; i < n; i++) x[i] = x[i]! * Math.min(1, i / 400, (n - 1 - i) / 4000);
    return x;
  };

  it('a clean, well-levelled sound passes every check', () => {
    const r = run(good());
    expect(r.map((c) => c.name)).toEqual(['clip', 'loudness', 'dc', 'click', 'tail', 'harsh']);
    expect(checksPass(r)).toBe(true);
    expect(checkSummary(r)).toBe('checks: 6/6 pass');
    expect(r.every((c) => c.score === 1 && c.ranges.length === 0)).toBe(true);
  });

  it('clip: flags samples at full scale with their time ranges, and a true peak over the limit', () => {
    const x = good(2.5, 0.5).map((v) => Math.max(-1, Math.min(1, v)));
    const c = by(run(x), 'clip');
    expect(c.pass).toBe(false);
    expect(c.ranges.length).toBeGreaterThan(0);
    expect(c.ranges[0]!.from).toBeGreaterThan(0);
    expect(c.ranges[0]!.note).toBe('samples at full scale');
    expect(c.score).toBeLessThan(1);
    const hot = good(0.995, 0.5);
    const c2 = by(run(hot), 'clip');
    expect(c2.pass).toBe(false);
    expect(c2.value).toMatch(/true peak -?\d/);
    expect(c2.ranges[0]!.note).toMatch(/true peak/);
    expect(by(run(hot, { ...DEFAULT_STYLE, truePeakMax: 0 }), 'clip').pass).toBe(true);
  });

  it('loudness: the target and tolerance come from the style; the message says how far and which way', () => {
    const quiet = by(run(good(0.02)), 'loudness');
    expect(quiet.pass).toBe(false);
    expect(quiet.value).toMatch(/LU too quiet/);
    expect(quiet.threshold).toBe('-16.0 LUFS ±1 (class standard)');
    expect(by(run(good(0.9)), 'loudness').value).toMatch(/LU too loud/);
    expect(by(run(good(0.02), { ...DEFAULT_STYLE, loudnessTarget: -38, loudnessTolerance: 3 }), 'loudness').pass).toBe(true);
    expect(by(run(new Float32Array(100)), 'loudness')).toMatchObject({ pass: false, score: 0, value: 'silent' });
  });

  it('dc: flags an offset over 0.5 %', () => {
    const x = Float32Array.from(good(0.15), (v) => v + 0.02);
    const c = by(run(x), 'dc');
    expect(c.pass).toBe(false);
    expect(c.ranges).toEqual([{ from: 0, to: 0.5, note: 'the whole sound is offset' }]);
  });

  it('click: flags a jump at the start and at the end, with the first and last millisecond', () => {
    const x = sine(440, 0.15, 0.5);
    x[x.length - 1] = 0.3;
    const c = by(run(x), 'click');
    expect(c.pass).toBe(false);
    expect(c.ranges.map((g) => g.note)).toEqual(['ends at level 0.300']);
    const loud = Float32Array.from(good(0.15)); loud[0] = 0.4;
    const c2 = by(run(loud), 'click');
    expect(c2.ranges[0]).toMatchObject({ from: 0, to: 0.001 });
    expect(c2.ranges[0]!.note).toBe('starts at level 0.400');
  });

  it('tail: flags silence padding over 50 ms and a tail cut before it died away', () => {
    const padded = new Float32Array(N);
    padded.set(good(0.15, 0.4), Math.round(N * 0.2));
    const c = by(run(padded), 'tail');
    expect(c.pass).toBe(false);
    expect(c.ranges.map((g) => g.note)).toEqual([expect.stringMatching(/^20\d ms of silence at the start$/), expect.stringMatching(/^40\d ms of silence at the end \(under -60 dB; duration=auto/)]);
    expect(c.ranges[0]!.from).toBe(0);
    expect(c.ranges[0]!.to).toBeCloseTo(0.2, 2);
    const cut = by(run(sine(440, 0.15, 0.5)), 'tail');
    expect(cut.pass).toBe(false);
    expect(cut.ranges.at(-1)!.note).toMatch(/^cut at -\d+\.\d dB below the peak \(end the amplitude/);
    expect(by(run(padded, { ...DEFAULT_STYLE, silenceMax: 1 }), 'tail').pass).toBe(true);
  });

  it('summarises failures on one line, and lists thresholds and flagged ranges in full', () => {
    const r = run(sine(440, 0.5, 0.5));
    expect(checkSummary(r)).toMatch(/^checks: \d\/6 pass; failing: /);
    const text = formatChecks('beep', r);
    expect(text).toMatch(/^beep: FAIL \(\d\/6 checks pass\)/);
    expect(text).toMatch(/loudness\s+FAIL\s+score 0\.\d\d\s+.*held to -16\.0 LUFS ±1/);
    expect(text).toMatch(/flagged 0\.\d{4}-0\.\d{4} s: /);
  });

  it('the style: defaults, overrides, and errors for unknown keys', () => {
    expect(resolveStyle(undefined)).toEqual(DEFAULT_STYLE);
    expect(resolveStyle({ loudnessTarget: -20 })).toEqual({ ...DEFAULT_STYLE, loudnessTarget: -20 });
    expect(() => resolveStyle({ loudness: -20 })).toThrow(/unknown key 'loudness'/);
    expect(() => resolveStyle({ dcMax: 'high' })).toThrow(/style.dcMax must be a number/);
    expect(() => resolveStyle([1])).toThrow(/must be an object/);
  });
});

describe('PNG and the views', () => {
  const png = (b: Uint8Array) => {
    expect(Array.from(b.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const v = new DataView(b.buffer, b.byteOffset);
    const width = v.getUint32(16), height = v.getUint32(20);
    const at = Array.from(b).findIndex((_, i) => b[i] === 0x49 && b[i + 1] === 0x44 && b[i + 2] === 0x41 && b[i + 3] === 0x54);
    const raw = inflateSync(b.subarray(at + 4, at + 4 + v.getUint32(at - 4)));
    return { width, height, raw };
  };

  it('zlibCompress makes a valid, smaller stream for repetitive data and survives incompressible data', () => {
    const flat = new Uint8Array(100000).fill(7);
    expect(Array.from(inflateSync(zlibCompress(flat)))).toEqual(Array.from(flat));
    expect(zlibCompress(flat).length).toBeLessThan(1000);
    let s = 1;
    const noise = Uint8Array.from({ length: 50000 }, () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s >>> 24; });
    expect(Buffer.compare(Buffer.from(inflateSync(zlibCompress(noise))), Buffer.from(noise))).toBe(0);
    expect(inflateSync(zlibCompress(new Uint8Array(0))).length).toBe(0);
  });

  it('a canvas encodes to a PNG that decodes to the pixels drawn', () => {
    const c = new Canvas(40, 20, [0, 0, 0]);
    c.rect(5, 5, 10, 10, [255, 0, 0]);
    c.set(30, 3, [0, 255, 0]);
    const { width, height, raw } = png(c.png());
    expect([width, height]).toEqual([40, 20]);
    expect(raw.length).toBe(20 * (40 * 3 + 1));
    // undo the Up filter, then read pixels
    const stride = 40 * 3;
    const px = new Uint8Array(20 * stride);
    for (let y = 0; y < 20; y++) for (let x = 0; x < stride; x++) px[y * stride + x] = (raw[y * (stride + 1) + 1 + x]! + (raw[y * (stride + 1)] === 2 && y > 0 ? px[(y - 1) * stride + x]! : 0)) & 0xff;
    expect(Array.from(px.subarray((5 * 40 + 5) * 3, (5 * 40 + 5) * 3 + 3))).toEqual([255, 0, 0]);
    expect(Array.from(px.subarray((3 * 40 + 30) * 3, (3 * 40 + 30) * 3 + 3))).toEqual([0, 255, 0]);
    expect(Array.from(px.subarray(0, 3))).toEqual([0, 0, 0]);
  });

  it('wave, spec, pitch and compare produce PNGs of the stated sizes, with something drawn', () => {
    const x = sine(660, 0.3, 0.3);
    const a = analyze(x);
    for (const v of [waveView(x, a, 'tone'), specView(x, a, 'tone'), pitchView(a, 'tone')]) {
      const { width, height, raw } = png(v.png);
      expect([width, height]).toEqual([v.width, v.height]);
      expect(raw.length).toBe(height * (width * 3 + 1));
      expect(new Set(raw).size).toBeGreaterThan(10);
    }
    const c = compareView(x, sine(880, 0.3, 0.4), 'low', 'high');
    expect(png(c.image.png).width).toBe(900);
    expect(c.distance.durationDiffS).toBeCloseTo(0.1, 3);
    expect(c.distance.pitchStartDiffSt).toBeCloseTo(12 * Math.log2(880 / 660), 0);
    expect(c.distance.spectralDb).toBeGreaterThan(3);
    expect(compareView(x, x, 'a', 'a').distance).toMatchObject({ spectralDb: 0, averageSpectrumDb: 0, durationDiffS: 0, loudnessDiffLu: 0 });
  });
});
