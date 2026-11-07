// Loops: the seam made seamless by rendering past the end and crossfading over the start, the loop
// flag and its command, the click check at the seam, the loop view, and the bed recipes.

import { describe, expect, it } from 'vitest';
import {
  Library, RECIPE_NAMES, SAMPLE_RATE, analyze, applyCommand, loopView, parse, renderChannels, renderKey, runChecks, samplesHash, seamNumbers, serializeSound, DEFAULT_STYLE, type LayeredSound,
} from '../src/index.ts';
import { build } from './layered-helpers.ts';

const lib = (script: string): Library => build(script, new Library());
const render = (s: LayeredSound): Float32Array => renderChannels(s)[0]!;
const BEDS = ['wind', 'rain', 'fire', 'crowd'] as const;
const bed = (name: string, seed = 5): LayeredSound => lib(`sound new b voice=layered preset=${name} seed=${seed}`).get('b') as LayeredSound;

/** RMS in dB of x[from, to). */
const db = (x: Float32Array, from: number, to: number): number => {
  let e = 0;
  for (let i = from; i < to; i++) e += x[i]! * x[i]!;
  return 10 * Math.log10(e / (to - from));
};

const FLAT_NOISE = 'sound new n voice=layered seed=3\nlayer add n osc wave=white dur=9 gain=0.4\nenv n 1.amp "0:1"\nsound loop n 2 fade=0.4\n';

describe('the loop flag', () => {
  it('is a command with a length and a crossfade, written in its normal form, off again', () => {
    const l = lib('sound new n voice=layered\nsound loop n 3');
    expect((l.get('n') as LayeredSound).loop).toEqual({ length: 3, fade: 0.5 });
    expect(applyCommand(l, parse('sound loop n 2.5 fade=0.25').commands[0]!)).toBeUndefined();
    expect(parse('sound loop n 2.5 fade=0.25').commands[0]!.text).toBe('sound loop n 2.5 fade=0.25');
    expect(serializeSound(l.get('n')!)).toContain('loop 2.5 fade 0.25');
    applyCommand(l, parse('sound loop n off').commands[0]!);
    expect((l.get('n') as LayeredSound).loop).toBeUndefined();
    expect(serializeSound(l.get('n')!)).not.toContain('loop');
  });
  it('is refused for a classic sound (saying how), for a bad length and for a crossfade longer than half the loop', () => {
    expect(() => lib('sound new c voice=classic\nsound loop c 2')).toThrow(/layer-up/);
    expect(parse('sound loop n 0.05').errors[0]!.message).toMatch(/0\.1 to 120 seconds/);
    expect(parse('sound loop n 130').errors[0]!.message).toMatch(/0\.1 to 120 seconds/);
    expect(parse('sound loop n 2 fade=1.5').errors[0]!.message).toMatch(/at most half the length/);
    expect(parse('sound loop n').errors[0]!.message).toMatch(/give the loop length/);
  });
  it('changes the render key (and only for a looped sound)', () => {
    const l = lib('sound new n voice=layered seed=3\nlayer add n osc dur=2');
    const plain = renderKey(l.get('n')!);
    applyCommand(l, parse('sound loop n 1').commands[0]!);
    expect(renderKey(l.get('n')!)).not.toBe(plain);
    applyCommand(l, parse('sound loop n off').commands[0]!);
    expect(renderKey(l.get('n')!)).toBe(plain);
  });
});

describe('the rendered seam', () => {
  it('is exactly the loop length long, and deterministic', () => {
    const n = lib(FLAT_NOISE).get('n') as LayeredSound;
    expect(render(n)).toHaveLength(2 * SAMPLE_RATE);
    expect(samplesHash(render(n))).toBe(samplesHash(render(lib(FLAT_NOISE).get('n') as LayeredSound)));
  });
  it('runs the end into the start: the first sample is the one that follows the last in the long render', () => {
    const n = lib(FLAT_NOISE).get('n') as LayeredSound;
    const L = 2 * SAMPLE_RATE;
    const long = render({ ...n, loop: undefined, duration: (L + Math.round(0.4 * SAMPLE_RATE)) / SAMPLE_RATE });
    const x = render(n);
    expect(x[0]).toBeCloseTo(long[L]!, 5);
    expect(x[L - 1]).toBe(long[L - 1]);
    // past the crossfade the sound is the long render itself
    expect(x[L - 5000]).toBe(long[L - 5000]);
  });
  it('has no click at the seam: a continuous tone keeps its phase across the join, and the click check says so', () => {
    // a sine that does not fit the loop length in whole cycles: a plain cut would jump, the fold does not
    const l = lib('sound new t voice=layered seed=1\nlayer add t osc wave=sine freq=441.7 dur=3 gain=0.5\nenv t 1.amp "0:1"\nsound loop t 1 fade=0.1');
    const x = render(l.get('t') as LayeredSound);
    const step = Math.max(...Array.from({ length: 400 }, (_, i) => Math.abs(x[i + 1]! - x[i]!)));
    expect(Math.abs(x[0]! - x[x.length - 1]!)).toBeLessThanOrEqual(step * 1.2);
    const cut = x.slice(0, Math.round(1 * SAMPLE_RATE));
    const cutJump = Math.abs(cut[0]! - cut[cut.length - 1]!);
    expect(cutJump).toBeGreaterThan(0.01); // (the same cycles cut at the same length without the fold do click)
    const a = analyze(x);
    expect(runChecks(x, a, DEFAULT_STYLE, { loop: true }).find((c) => c.name === 'click')!.pass).toBe(true);
  });
  it('holds the level steady across the seam and over several repeats', () => {
    const n = lib(FLAT_NOISE).get('n') as LayeredSound;
    const x = render(n);
    const N = x.length;
    const rep = new Float32Array(N * 4);
    for (let r = 0; r < 4; r++) rep.set(x, r * N);
    const win = 2205; // 50 ms
    const levels: number[] = [];
    for (let s = 0; s + win <= rep.length; s += win) levels.push(db(rep, s, s + win));
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(1.5); // windows of steady white noise differ by a fraction of a dB, none dips at the join
    for (let r = 1; r < 4; r++) {
      const seam = r * N;
      expect(Math.abs(db(rep, seam - 4410, seam) - db(rep, seam, seam + 4410))).toBeLessThan(1);
    }
    const seamLevels = seamNumbers(x);
    expect(Math.abs(seamLevels.stepDb)).toBeLessThan(1.5);
  });
  it('is what the click check catches when a seam does jump: a tone cut a quarter cycle early, a step in level', () => {
    const tone = (n: number, amp: (i: number) => number = () => 0.5, cos = true): Float32Array => Float32Array.from({ length: n }, (_, i) => amp(i) * (cos ? Math.cos : Math.sin)((2 * Math.PI * 441 * i) / SAMPLE_RATE));
    const check = (x: Float32Array) => runChecks(x, analyze(x), DEFAULT_STYLE, { loop: true }).find((c) => c.name === 'click')!;
    expect(check(tone(44100)).pass).toBe(true); // whole cycles: the end runs into the start
    const early = check(tone(44100 + 25)); // ends a quarter cycle into the next one
    expect(early.pass).toBe(false);
    expect(early.ranges[0]!.note).toMatch(/seam jumps by/);
    const stepped = check(tone(44100, (i) => (i < 22050 ? 0.02 : 0.5), false)); // quiet start, loud end, no jump
    expect(stepped.pass).toBe(false);
    expect(stepped.ranges.map((r) => r.note).join()).toMatch(/level steps/);
    // and without the loop flag the same tone is judged on its first and last sample as ever
    const plain = tone(44100);
    expect(runChecks(plain, analyze(plain), DEFAULT_STYLE).find((c) => c.name === 'click')!.pass).toBe(false);
  });
  it('makes a loop\'s tail check pass without a fade-out (and still fails a silent loop)', () => {
    const n = lib(FLAT_NOISE).get('n') as LayeredSound;
    const x = render(n);
    expect(runChecks(x, analyze(x), DEFAULT_STYLE, { loop: true }).find((c) => c.name === 'tail')!.pass).toBe(true);
    expect(runChecks(x, analyze(x), DEFAULT_STYLE).find((c) => c.name === 'tail')!.pass).toBe(false); // as a one-shot it is cut
    const silent = new Float32Array(4410);
    expect(runChecks(silent, analyze(silent), DEFAULT_STYLE, { loop: true }).find((c) => c.name === 'tail')!.pass).toBe(false);
  });
});

describe('the ambience recipes', () => {
  it('are wind, rain, fire and crowd, each a loop with a length and a crossfade drawn from its range', () => {
    for (const b of BEDS) expect(RECIPE_NAMES).toContain(b);
    for (const b of BEDS) {
      for (const seed of [1, 2, 3]) {
        const s = bed(b, seed);
        expect(s.loop, `${b} ${seed}`).toBeDefined();
        expect(s.loop!.length).toBeGreaterThanOrEqual(0.5);
        expect(s.loop!.length).toBeLessThanOrEqual(8);
        expect(s.loop!.fade).toBeLessThanOrEqual(s.loop!.length / 2);
        expect(render(s)).toHaveLength(Math.round(s.loop!.length * SAMPLE_RATE));
      }
    }
  });
  it('seam without a click or a step in level, finite, not clipping, and not silent', () => {
    for (const b of BEDS) {
      const s = bed(b, 4);
      const ch = renderChannels(s);
      expect(ch[0]!.every((v) => Number.isFinite(v))).toBe(true);
      const a = analyze(ch);
      expect(a.silent, b).toBe(false);
      const checks = runChecks(ch, a, DEFAULT_STYLE, { loop: true });
      for (const name of ['click', 'tail', 'clip', 'dc'] as const) {
        const c = checks.find((x) => x.name === name)!;
        expect(c.pass, `${b} ${name}: ${c.value}`).toBe(true);
      }
      // the level 150 ms before the seam and 150 ms after it differ by little
      const x = ch[0]!;
      expect(Math.abs(db(x, x.length - 6615, x.length) - db(x, 0, 6615)), b).toBeLessThan(2.5);
    }
  });
  it('differ with the seed, and keep their wanders periodic: the value at the start is the value at the loop end', () => {
    const a = bed('wind', 1), b = bed('wind', 2);
    expect(JSON.stringify(a.layers)).not.toBe(JSON.stringify(b.layers));
    for (const s of [a, b]) {
      const L = s.loop!.length;
      for (const l of s.layers) {
        const g = l.envs.gain ?? l.envs.cutoff;
        if (!g) continue;
        expect(g[0]!.v).toBe(g.find((p) => p.t === L)!.v);
      }
    }
  });
  it('rain and fire have bursts that stay clear of the seam and repeat in the crossfade', () => {
    for (const b of ['rain', 'fire'] as const) {
      const s = bed(b, 2);
      const L = s.loop!.length;
      for (const l of s.layers.filter((x) => x.amp)) {
        const peaks = l.amp!.filter((p) => p.v > 0.2);
        expect(peaks.length).toBeGreaterThan(2);
        expect(l.amp!.length).toBeLessThanOrEqual(32);
        for (const p of peaks.filter((q) => q.t < L)) expect(p.t).toBeLessThan(L - 0.02);
      }
    }
  });
});

describe('the loop view', () => {
  it('is a PNG with the seam, the overlap, the spectrogram and the level across repeats', () => {
    const s = bed('rain', 3);
    const x = render(s);
    const img = loopView(x, analyze(x), seamNumbers(x), 'rain');
    expect(img.width).toBe(900);
    expect(img.height).toBeGreaterThan(500);
    expect([...img.png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});
