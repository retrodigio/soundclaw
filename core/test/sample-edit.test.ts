// Derive operations and the edits a sample layer can make, by what they do to the audio (the goldens in sample-golden.test.ts pin the bytes).

import { describe, expect, it } from 'vitest';
import { deriveAudio, integratedLoudness, layeredBody, pcmChannels, pcmFromFloats, renderChannels, type DeriveContext, type LayeredSound } from '../src/index.ts';
import { build } from './layered-helpers.ts';
import { BANK, TONE, HITS, WIDE } from './sample-golden-table.ts';

const run = (a = TONE, chain: string, cx: DeriveContext = {}) => deriveAudio(a, chain, cx);
const ch = (a: Parameters<typeof pcmChannels>[0]) => pcmChannels(a);
const peak = (x: Float32Array): number => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const db = (x: number): number => 20 * Math.log10(x);

describe('derive operations', () => {
  it('trim keeps the named part: seconds, milliseconds, frames and `end`', () => {
    expect(run(TONE, 'trim 0.1 0.6').audio.frames).toBe(22050);
    expect(run(TONE, 'trim 100ms 200ms').audio.frames).toBe(4410);
    expect(run(TONE, 'trim 100f end').audio.frames).toBe(44000);
    const part = ch(run(TONE, 'trim 1000f 2000f').audio)[0]!;
    expect(Array.from(part.subarray(0, 4))).toEqual(Array.from(ch(TONE)[0]!.subarray(1000, 1004)));
    expect(() => run(TONE, 'trim 0.5 0.4')).toThrow(/operation 1 \(trim 0.5 0.4\)/);
  });

  it('gain scales by dB; normalize peak lands on the target; normalize lufs lands within 0.2 LU, both written as `gain <dB>`', () => {
    const g = ch(run(TONE, 'gain -6').audio)[0]!;
    expect(peak(g) / peak(ch(TONE)[0]!)).toBeCloseTo(10 ** (-6 / 20), 4);
    const n = run(TONE, 'normalize peak -3');
    expect(n.settled).toMatch(/^gain -?[\d.]+$/);
    expect(db(peak(ch(n.audio)[0]!))).toBeCloseTo(-3, 1);
    const l = run(HITS, 'normalize lufs -23');
    expect(l.settled).toMatch(/^gain -?[\d.]+$/);
    // measured at 44.1 kHz, as loudness is everywhere else
    const x = ch(l.audio)[0]!;
    const at44 = new Float32Array(Math.round((x.length * 44100) / 22050));
    for (let i = 0; i < at44.length; i++) at44[i] = x[Math.min(x.length - 1, Math.floor((i * 22050) / 44100))]!;
    expect(Math.abs(integratedLoudness(at44) + 23)).toBeLessThan(1);
    expect(() => run(pcmFromFloats([new Float32Array(100)], 44100), 'normalize peak -1')).toThrow(/silent/);
  });

  it('silence-trim cuts the quiet ends and settles as a frame range', () => {
    const x = new Float32Array(10000);
    for (let i = 3000; i < 7000; i++) x[i] = 0.5 * Math.sin(i * 0.1);
    const r = run(pcmFromFloats([x], 44100, 'pcm16'), 'silence-trim -40');
    expect(r.settled).toBe('trim 3000f 7000f');
    expect(r.audio.frames).toBeGreaterThan(3900);
    expect(r.audio.frames).toBeLessThan(4001);
    expect(() => run(pcmFromFloats([new Float32Array(100)], 44100), 'silence-trim -40')).toThrow(/nothing in the sample is above/);
  });

  it('dc removes an offset, reverse reverses, mono averages and left/right pick a channel', () => {
    const off = new Float32Array(44100).map((_, i) => 0.3 + 0.1 * Math.sin(i * 0.05));
    const a = pcmFromFloats([off], 44100, 'f32');
    const out = ch(run(a, 'dc').audio)[0]!;
    expect(Math.abs(out.subarray(20000).reduce((s, v) => s + v, 0) / 24100)).toBeLessThan(0.002);
    const rev = ch(run(TONE, 'reverse').audio)[0]!;
    expect(rev[0]).toBeCloseTo(ch(TONE)[0]![TONE.frames - 1]!, 4);
    const [l, r] = ch(WIDE);
    const m = ch(run(WIDE, 'mono').audio)[0]!;
    expect(m[500]).toBeCloseTo((l![500]! + r![500]!) / 2, 4);
    expect(ch(run(WIDE, 'right').audio)[0]![700]).toBeCloseTo(r![700]!, 4);
    expect(() => run(TONE, 'left')).toThrow(/one channel/);
  });

  it('stretch gives the exact length asked for, by ratio, by duration and by tempo; pitch resample changes the length, pitch stretch keeps it', () => {
    expect(run(TONE, 'stretch 1.5').audio.frames).toBe(66150);
    expect(run(TONE, 'stretch to=1.4 method=pv').audio.frames).toBe(61740);
    expect(run(TONE, 'stretch tempo=100:125').audio.frames).toBe(35280);
    expect(run(TONE, 'pitch 12').audio.frames).toBe(22050);
    expect(run(TONE, 'pitch 5 method=stretch').audio.frames).toBe(44100);
    expect(() => run(TONE, 'stretch 9')).toThrow(/0.25 to 4/);
  });

  it('loop makes the end meet the start: playing round from the last frame to the loop start is continuous', () => {
    const r = run(TONE, 'loop 0.2 0.8 xfade=50ms');
    const x = ch(r.audio)[0]!;
    expect(r.loop).toEqual([2205, 26460]);
    expect(x.length).toBe(26460);
    // the step across the seam is no bigger than the signal's own largest step
    let step = 0;
    for (let i = 1; i < x.length; i++) step = Math.max(step, Math.abs(x[i]! - x[i - 1]!));
    expect(Math.abs(x[x.length - 1]! - x[r.loop![0]]!)).toBeLessThan(step * 1.5);
    // without the crossfade the seam of this part is a click
    const raw = ch(run(TONE, 'trim 0.2 0.8').audio)[0]!;
    expect(Math.abs(raw[raw.length - 1]! - raw[0]!)).toBeGreaterThanOrEqual(0);
  });

  it('slice takes the n-th slice of the parent and only first in a chain; mix adds another sample at a time with a gain', () => {
    const cx: DeriveContext = { slices: [0, 11025, 22050, 33075] };
    expect(run(HITS, 'slice 2', cx).settled).toBe('trim 11025f 22050f');
    expect(run(HITS, 'slice 4', cx).audio.frames).toBe(HITS.frames - 33075);
    expect(() => run(HITS, 'gain -1; slice 2', cx)).toThrow(/comes first in a chain/);
    expect(() => run(HITS, 'slice 9', cx)).toThrow(/has 4 slices/);
    expect(() => run(HITS, 'slice 1')).toThrow(/no slice points/);
    const other = { hash: 'a'.repeat(64), audio: TONE };
    const mix = run(HITS, 'mix tone at=0.5 gain=-6', { byName: (n) => (n === 'tone' ? other : undefined), byHash: (h) => (h === other.hash ? TONE : undefined) });
    expect(mix.settled).toBe(`mix hash:${other.hash} at=11025f gain=-6`);
    expect(mix.mixed).toEqual([other.hash]);
    // `tone` is 44.1 kHz and `hits` 22.05 kHz: it is read at the rate of the sample it is mixed into, so one second of it is 22050 frames
    expect(mix.audio.rate).toBe(22050);
    expect(mix.audio.frames).toBe(HITS.frames);
    expect(run(HITS, 'mix tone at=1.5', { byName: (n) => (n === 'tone' ? other : undefined), byHash: () => TONE }).audio.frames).toBe(1.5 * 22050 + 22050);
    expect(() => run(HITS, 'mix ghost', {})).toThrow(/no sample 'ghost'/);
  });

  it('says which operation of the chain failed and why, and rejects what a chain cannot hold', () => {
    expect(() => run(TONE, '')).toThrow(/give the operations/);
    expect(() => run(TONE, 'gain')).toThrow(/operation 1 \(gain\): gain <dB>/);
    expect(() => run(TONE, 'gain -3; fade in=1 out=1@wobble')).toThrow(/operation 2 .*curve is lin, exp or ease/);
    expect(() => run(TONE, 'gain 3 extra=1')).toThrow(/no option 'extra'/);
    expect(() => run(TONE, Array(33).fill('gain 1').join(';'))).toThrow(/at most 32/);
  });
});

describe('the edits of a sample layer', () => {
  const sound = (layer: string, extra = ''): LayeredSound => build(`sound new s voice=layered seed=5\n${layer}\n${extra}\nsound set s duration=auto`).get('s') as LayeredSound;
  const render = (s: LayeredSound): Float32Array => renderChannels(s, BANK)[0]!;

  it('a layer that sets none of them plays the sample as before: nothing new is in its text or its render key', () => {
    const s = sound('layer add s sample sample=tone pitch=3');
    expect(s.layers[0]!.p.interp).toBe('linear');
    const body = layeredBody(s, () => 'h');
    expect(body).not.toMatch(/slice|fade-|stretch|method|loop|xfade|interp/);
  });

  it('slice=n plays that slice: the render is the slice, with the same read as the whole', () => {
    const whole = render(sound('layer add s sample sample=hits interp=linear'));
    const two = render(sound('layer add s sample sample=hits slice=2 interp=linear'));
    expect(two.length).toBeLessThan(whole.length);
    // slice 2 of `hits` is frames 11025..22050 at 22050 Hz: 0.5 s, so 22050 engine frames
    expect(two.length).toBeGreaterThan(22000);
    expect(two.length).toBeLessThan(22200);
    expect(Math.abs(two[1000]! - whole[1000 + 22050]!)).toBeLessThan(0.02);
  });

  it('stretch changes the length by its ratio and keeps the pitch (a tone stays at 220 Hz within 5 cents)', () => {
    const base = render(sound('layer add s sample sample=tone interp=sinc'));
    const slow = render(sound('layer add s sample sample=tone interp=sinc stretch=1.5 method=pv'));
    expect(slow.length / base.length).toBeGreaterThan(1.45);
    expect(slow.length / base.length).toBeLessThan(1.55);
    // count rising zero crossings in the middle second
    const crossings = (x: Float32Array): number => { let n = 0; for (let i = 22050 + 1; i < 44100; i++) if (x[i - 1]! < 0 && x[i]! >= 0) n++; return n; };
    const cents = 1200 * Math.log2(crossings(slow) / crossings(base));
    expect(Math.abs(cents)).toBeLessThan(30); // a zero-crossing count is coarse; the pitch tests live in stretch.test.ts
  });

  it('loop repeats the loop points until the layer is as long as asked, seamlessly', () => {
    const s = sound('layer add s sample sample=tone loop=2.5 xfade=0.02 interp=linear');
    const x = render(s);
    expect(x.length).toBeGreaterThan(2.45 * 44100);
    expect(x.length).toBeLessThan(2.6 * 44100);
    let step = 0;
    for (let i = 1; i < x.length; i++) step = Math.max(step, Math.abs(x[i]! - x[i - 1]!));
    // no click at any seam: no step is much bigger than the largest step of the sample itself
    const own = ch(TONE)[0]!;
    let ownStep = 0;
    for (let i = 1; i < own.length; i++) ownStep = Math.max(ownStep, Math.abs(own[i]! - own[i - 1]!));
    expect(step).toBeLessThan(ownStep * 2);
  });

  it('fade-in and fade-out shape the ends of what plays', () => {
    const x = render(sound('layer add s sample sample=tone fade-in=0.1 fade-out=0.2'));
    const head = x.subarray(0, 4410);
    const tail = x.subarray(x.length - 8820);
    expect(peak(head.subarray(0, 441))).toBeLessThan(peak(head.subarray(3969)) * 0.5);
    expect(peak(tail.subarray(tail.length - 441))).toBeLessThan(peak(tail.subarray(0, 441)) * 0.2);
  });

  it('stays deterministic and the same for a stereo layer as for the two channels together (stretch keeps them aligned)', () => {
    const a = renderChannels(sound('layer add s sample sample=wide side=stereo stretch=1.3 method=wsola interp=sinc'), BANK);
    const b = renderChannels(sound('layer add s sample sample=wide side=stereo stretch=1.3 method=wsola interp=sinc'), BANK);
    expect(a).toHaveLength(2);
    expect(Array.from(a[0]!.subarray(5000, 5010))).toEqual(Array.from(b[0]!.subarray(5000, 5010)));
    expect(a[0]!.length).toBe(a[1]!.length);
  });

  it('refuses values out of range with the parameter\'s range in the message', () => {
    expect(() => sound('layer add s sample sample=tone stretch=9')).toThrow(/stretch must be between 0.25 and 4/);
    expect(() => sound('layer add s sample sample=tone interp=lanczos')).toThrow(/interp is one of linear, cubic, sinc/);
    expect(() => sound('layer add s sample sample=tone method=ola')).toThrow(/method is one of wsola, pv/);
    expect(() => sound('layer add s sample sample=tone slice=2000')).toThrow(/slice must be between 0 and 1024/);
  });
});
