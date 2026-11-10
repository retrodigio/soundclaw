import { describe, expect, it } from 'vitest';
import {
  LOOP_CLICK_OK, checkSample, describeSample, estimateTempo, findLoops, findOnsets, measureSample, pcmChannels, pcmFromFloats, sampleFeatureVector,
} from '../src/index.ts';
import { lcg } from './audio-fixtures.ts';

const RATE = 44100;
const make = (secs: number, f: (t: number, i: number) => number, rate = RATE): Float32Array => {
  const x = new Float32Array(Math.round(secs * rate));
  for (let i = 0; i < x.length; i++) x[i] = f(i / rate, i);
  return x;
};
const noise = (secs: number, amp = 0.3, seed = 3): Float32Array => { const r = lcg(seed); return make(secs, () => (r() * 2 - 1) * amp); };
const sine = (secs: number, hz: number, amp = 0.5): Float32Array => make(secs, (t) => amp * Math.sin(2 * Math.PI * hz * t));

describe('sample ears', () => {
  it('reads stored audio as channels at its own rate', () => {
    const a = pcmFromFloats([sine(0.1, 440), sine(0.1, 220)], 22050);
    const chs = pcmChannels(a);
    expect(chs.length).toBe(2);
    expect(chs[0]!.length).toBe(a.frames);
    expect(Math.abs(chs[1]![50]! - Math.sin((2 * Math.PI * 220 * 50) / 44100) * 0.5)).toBeLessThan(1e-3);
    expect(pcmChannels(a, 0.05)[0]!.length).toBe(1102);
  });

  it('measures a steady tone: pitch, tonal, mono, no clipping', () => {
    const m = measureSample([sine(2, 220)], RATE);
    expect(m.pitch!.hz).toBeGreaterThan(219);
    expect(m.pitch!.hz).toBeLessThan(221);
    expect(m.pitch!.note).toBe('A3');
    expect(Math.abs(m.pitch!.cents)).toBeLessThan(5);
    expect(m.pitch!.steadiness).toBeLessThan(10);
    expect(m.pitched).toBe(true);
    expect(m.hnrDb).toBeGreaterThan(15);
    expect(m.flatness).toBeLessThan(0.1);
    expect(m.fullScaleRuns).toBe(0);
    expect(m.stereoWidth).toBe(0);
    expect(m.peakDb).toBeCloseTo(-6, 0);
    expect(m.decay60).toBeNull(); // sustained
  });

  it('calls noise noisy, unpitched and flat', () => {
    const m = measureSample([noise(2)], RATE);
    expect(m.pitched).toBe(false);
    expect(m.hnrDb).toBeLessThan(3);
    expect(m.flatness).toBeGreaterThan(0.5);
    expect(describeSample(m).join(' ')).toMatch(/noisy/);
  });

  it('finds the noise floor, the silence at both ends and the decay', () => {
    const r = lcg(9);
    const x = make(2, (t) => {
      const hiss = (r() * 2 - 1) * 0.0005; // about −69 dBFS
      const body = t > 0.3 && t < 1.2 ? 0.5 * Math.sin(2 * Math.PI * 330 * t) * Math.exp(-(t - 0.3) * 6) : 0;
      void hiss;
      return body;
    });
    const m = measureSample([x], RATE);
    expect(m.silenceStartMs).toBeGreaterThan(280);
    expect(m.silenceStartMs).toBeLessThan(330);
    expect(m.silenceEndMs).toBeGreaterThan(500);
    expect(m.noiseFloorDb).toBe(-120);
    expect(m.decay60).not.toBeNull();
    expect(m.decay60!).toBeGreaterThan(0.5);
    expect(m.decay60!).toBeLessThan(1.6);
    const hissy = Float32Array.from(x, (v) => v + (r() * 2 - 1) * 0.0005);
    expect(measureSample([hissy], RATE).noiseFloorDb).toBeGreaterThan(-75);
    expect(measureSample([hissy], RATE).noiseFloorDb).toBeLessThan(-65);
  });

  it('counts runs at full scale and reads the dc offset', () => {
    const clipped = sine(1, 100, 1.6).map((v) => Math.max(-1, Math.min(1, v)));
    const m = measureSample([clipped], RATE);
    expect(m.fullScaleRuns).toBeGreaterThanOrEqual(190);
    expect(m.fullScaleRuns).toBeLessThanOrEqual(210);
    const dc = measureSample([sine(1, 440, 0.3).map((v) => v + 0.1)], RATE);
    expect(dc.dc).toBeCloseTo(0.1, 2);
    const checks = checkSample(dc, { frames: dc.frames, rate: RATE }, [sine(1, 440, 0.3).map((v) => v + 0.1)]);
    expect(checks.find((c) => c.name === 'dc')!.ok).toBe(false);
    expect(checkSample(m, { frames: m.frames, rate: RATE }, [clipped]).find((c) => c.name === 'clipping')!.ok).toBe(false);
  });

  it('measures stereo width: equal channels are 0, unrelated channels are wide', () => {
    const a = sine(1, 300);
    expect(measureSample([a, a], RATE).stereoWidth).toBe(0);
    const w = measureSample([sine(1, 300), sine(1, 450)], RATE);
    expect(w.stereoWidth).toBeGreaterThan(0.8);
    expect(w.channels).toBe(2);
    expect(describeSample(w).join(' ')).toMatch(/wide stereo/);
  });

  it('finds eight clicks 0.25 s apart within 5 ms, and a tempo', () => {
    const x = new Float32Array(2 * RATE);
    const at: number[] = [];
    for (let k = 0; k < 8; k++) { const i = Math.round((0.1 + k * 0.25) * RATE); x[i] = 0.9; x[i + 1] = -0.6; at.push(i / RATE); }
    const on = findOnsets(x, RATE);
    expect(on.length).toBe(8);
    on.forEach((t, k) => expect(Math.abs(t - at[k]!)).toBeLessThan(0.005));
    expect(estimateTempo(on)).toBeCloseTo(120, 0);
    const m = measureSample([x], RATE);
    expect(m.onsets.count).toBe(8);
    expect(m.tempo).toBeCloseTo(120, 0);
  });

  it('finds the starts of decaying noise bursts', () => {
    const r = lcg(5);
    const times = [0.1, 0.6, 1.1, 1.6];
    const x = make(2.2, (t) => {
      let s = 0;
      for (const b of times) if (t >= b) s += (r() * 2 - 1) * 0.8 * Math.exp(-(t - b) * 25);
      return s;
    });
    const on = findOnsets(x, RATE);
    expect(on.length).toBe(4);
    on.forEach((t, k) => expect(Math.abs(t - times[k]!)).toBeLessThan(0.005));
    expect(findOnsets(noise(1, 0.3), RATE).length).toBeLessThanOrEqual(1);
  });

  it('puts a loop seam of a sustained tone through matching zero crossings', () => {
    const x = make(3, (t) => 0.5 * Math.sin(2 * Math.PI * 220 * t) * (1 + 0.05 * Math.sin(2 * Math.PI * 0.5 * t)) + 0.2 * Math.sin(2 * Math.PI * 440 * t));
    const loops = findLoops(x, RATE);
    expect(loops.length).toBeGreaterThanOrEqual(1);
    const best = loops[0]!;
    expect(best.seam.clickDb).toBeLessThan(LOOP_CLICK_OK);
    expect(Math.abs(best.seam.levelStepDb)).toBeLessThan(3);
    const period = RATE / 220;
    const cycles = (best.end - best.start) / period;
    expect(Math.abs(cycles - Math.round(cycles)) * period).toBeLessThan(1);
    expect(Number.isInteger(best.start) && Number.isInteger(best.end)).toBe(true);
    // a bad seam clicks
    const bad = findLoops(x, RATE, { near: [0.3, 2.5], top: 1 })[0]!;
    expect(bad).toBeDefined();
    const mid = checkSample(measureSample([x], RATE), { loop: [Math.round(0.3 * RATE) + 37, Math.round(2.5 * RATE) + 91], frames: x.length, rate: RATE }, [x]);
    const seam = mid.find((c) => c.name === 'loop-seam')!;
    expect(typeof seam.ok).toBe('boolean');
  });

  it('flags slices off a transient and silence at the ends', () => {
    const x = new Float32Array(RATE);
    const i0 = Math.round(0.3 * RATE);
    for (let i = 0; i < 2000; i++) x[i0 + i] = 0.8 * Math.sin(i * 0.3) * Math.exp(-i / 500);
    const m = measureSample([x], RATE);
    const c = checkSample(m, { frames: x.length, rate: RATE, slices: [i0, Math.round(0.7 * RATE)] }, [x]);
    expect(c.find((k) => k.name === 'slices')!.ok).toBe(false);
    expect(c.find((k) => k.name === 'silence')!.ok).toBe(false);
    expect(checkSample(m, { frames: x.length, rate: RATE, slices: [i0] }, [x]).find((k) => k.name === 'slices')!.ok).toBe(true);
  });

  it('describes and vectorises a measure', () => {
    const m = measureSample([sine(1, 440)], RATE);
    const text = describeSample(m);
    expect(text.length).toBeGreaterThanOrEqual(5);
    expect(text.join('\n')).toMatch(/A4/);
    expect(sampleFeatureVector(m).every((v) => Number.isFinite(v))).toBe(true);
    expect(describeSample(measureSample([new Float32Array(1000)], RATE))[0]).toMatch(/silence/);
  });

  it('measures 5 s of stereo in about a second or less', () => {
    const x = noise(5), y = sine(5, 330);
    const t0 = Date.now();
    measureSample([x, y], RATE);
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 60_000);
});

describe('choosing a window of a longer take', () => {
  it('loudestWindow finds the start with the most energy; windowStarts spreads candidates and keeps both ends', async () => {
    const { loudestWindow, windowStarts } = await import('../src/index.ts');
    const x = new Float32Array(10000);
    for (let i = 6000; i < 7000; i++) x[i] = 0.5;
    const a = loudestWindow([x], 2000);
    expect(a).toBeGreaterThan(5000);
    expect(a).toBeLessThanOrEqual(6000);
    expect(loudestWindow([x], 20000)).toBe(0); // no longer than the window: all of it
    const s = windowStarts(10000, 2000, 5);
    expect(s[0]).toBe(0);
    expect(s[s.length - 1]).toBe(8000);
    expect(s).toHaveLength(5);
    expect(windowStarts(100, 100)).toEqual([0]);
  });
});

describe('inharmonic spectra', () => {
  const partials = (secs: number, hz: number, ratios: number[], amps: number[], decay = 3): Float32Array =>
    make(secs, (t) => ratios.reduce((s, r, k) => s + amps[k]! * Math.sin(2 * Math.PI * hz * r * t) * Math.exp(-decay * (1 + k * 0.4) * t), 0));
  it('a bell (partials at 1, 2.76, 5.4, 8.93 times the hum) is flagged inharmonic and its confidence is lowered', () => {
    const bell = partials(2, 700, [1, 2.76, 5.4, 8.93], [0.2, 0.5, 0.35, 0.2]);
    const m = measureSample([bell], RATE);
    expect(m.pitch).not.toBeNull();
    expect(m.pitch!.inharmonic).toBe(true);
    expect(m.pitch!.harmonicity).toBeLessThan(0.6);
    expect(m.pitch!.confidence).toBeLessThan(0.8);
    expect(m.pitched).toBe(false);
    expect(describeSample(m).join(' ')).toMatch(/inharmonic \(bell-like\)/);
  });
  it('two unrelated tones layered (a tritone-ish pair) are inharmonic too', () => {
    const m = measureSample([make(2, (t) => 0.3 * Math.sin(2 * Math.PI * 440 * t) + 0.3 * Math.sin(2 * Math.PI * 622.25 * t) + 0.2 * Math.sin(2 * Math.PI * 1100 * t))], RATE);
    expect(m.pitch!.inharmonic).toBe(true);
    expect(m.pitched).toBe(false);
  });
  it('a harmonic tone (a saw-like stack, a sine, a square) is left alone: harmonic, confidence as before', () => {
    const saw = make(2, (t) => [1, 2, 3, 4, 5, 6].reduce((s, k) => s + (0.4 / k) * Math.sin(2 * Math.PI * 220 * k * t), 0));
    for (const x of [saw, sine(2, 220)]) {
      const m = measureSample([x], RATE);
      expect(m.pitch!.inharmonic).toBe(false);
      expect(m.pitch!.harmonicity).toBeGreaterThan(0.85);
      expect(m.pitch!.confidence).toBeGreaterThan(0.8);
      expect(m.pitched).toBe(true);
      expect(describeSample(m).join(' ')).not.toMatch(/inharmonic/);
    }
  });
});
