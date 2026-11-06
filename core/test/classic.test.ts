// The classic voice from its documented formulas (not from its own output): lengths, periods,
// the minFreq cut-off, quantisation, clamping, seeds, the single-patch text and synth.csv.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLASSIC_FIELDS, ClassicError, classicWav, cube, decodeWav, defaultPatch, envelope, envelopeLength, formatCsv, formatG, formatPatch, formatPatchNamed, makePatch, parseCsv, parsePatch, patchValues,
  quantizeClassic, renderClassic, seedOf, sha256Hex, sinRad,
} from '../src/index.ts';

const patch = (o: Record<string, number | string>) => makePatch({ sustain: 0.1, decay: 0, ...o });

describe('the 25 parameters', () => {
  it('are in the documented order with the documented ranges and defaults', () => {
    expect(CLASSIC_FIELDS.map((f) => [f.name, f.min, f.max, f.default])).toEqual([
      ['wave', 0, 3, 0], ['attack', 0, 1, 0], ['sustain', 0.01, 1, 0.3], ['punch', 0, 1, 0], ['decay', 0, 1, 0.4], ['freq', 0, 1, 0.3], ['minFreq', 0, 1, 0],
      ['slide', -1, 1, 0], ['deltaSlide', -1, 1, 0], ['vibratoDelay', 0, 1, 0], ['vibratoDepth', -1, 1, 0], ['vibratoSpeed', 0, 1, 0], ['changeAmount', -1, 1, 0],
      ['changeSpeed', 0, 1, 0], ['duty', 0, 1, 0], ['dutySweep', -1, 1, 0], ['repeatSpeed', 0, 1, 0], ['phaserOffset', -1, 1, 0], ['phaserSweep', -1, 1, 0],
      ['lowPass', 0, 1, 1], ['lowPassSweep', -1, 1, 0], ['resonance', 0, 1, 0], ['highPass', 0, 1, 0], ['highPassSweep', -1, 1, 0], ['volume', 0, 1, 0.5],
    ]);
  });

  it('clamp to their ranges (sustain never below 0.01) and wave floors to a whole number', () => {
    const p = makePatch({ sustain: -3, decay: 7, slide: -9, volume: 2, wave: 2.9, freq: -1 });
    expect(p).toMatchObject({ sustain: 0.01, decay: 1, slide: -1, volume: 1, wave: 2, freq: 0 });
    expect(makePatch({ wave: 'noise' }).wave).toBe(3);
    expect(makePatch({ wave: 9 }).wave).toBe(3);
  });

  it('take positions 1..25, with names winning, and reject unknown names and bad values', () => {
    expect(makePatch({ '1': 1, '6': 0.7 })).toMatchObject({ wave: 1, freq: 0.7 });
    expect(makePatch({ '6': 0.7, freq: 0.2 }).freq).toBe(0.2);
    expect(() => makePatch({ pitch: 1 })).toThrow(/unknown parameter 'pitch'/);
    expect(() => makePatch({ '26': 1 })).toThrow(/out of range/);
    expect(() => makePatch({ wave: 'triangle' })).toThrow(/unknown wave/);
    expect(() => makePatch({ freq: NaN })).toThrow(/must be a number/);
    expect(() => makePatch({ seed: NaN })).toThrow(/seed must be a number/);
  });
});

describe('lengths, periods, cut-off and quantisation (from the formulas)', () => {
  it('a sound not cut short is attack + sustain + decay + 3 samples, stage lengths truncated', () => {
    for (const [a, s, d] of [[0, 0.1, 0], [0.05, 0.2, 0.1], [0.123, 0.456, 0.789], [1, 0.01, 0], [0, 0.01, 0.01]] as const) {
      const p = makePatch({ attack: a, sustain: s, decay: d });
      const want = Math.floor(a * a * 100000) + Math.floor(s * s * 100000) + Math.floor(d * d * 100000) + 3;
      expect(envelope(p)).toEqual([Math.floor(a * a * 100000), Math.floor(s * s * 100000), Math.floor(d * d * 100000)]);
      expect(envelopeLength(p)).toBe(want);
      expect(renderClassic(p).length, `a=${a} s=${s} d=${d}`).toBe(want);
    }
  });

  it('with no phaser the delayed copy is the sample itself, so the output is doubled: sample 0 of a punched square, from the formulas', () => {
    // freq 0.3 → period floor(100/0.091) = 1098 supersamples, so all 8 supersamples of sample 0 are in the high half (+0.5).
    // The high-pass (minimum coefficient 1e-5) holds k supersamples at 0.5·(1 − 1e-5)^k; the phaser adds the same value again;
    // the envelope starts at 1 + 2·punch = 2; the gain is volume / 8:  sample 0 = (volume / 8) · 2 · 2 · Σ_{k=1..8} 0.5·(1 − 1e-5)^k.
    const x = renderClassic(makePatch({ sustain: 0.1, decay: 0, punch: 0.5, volume: 0.4 }));
    let sum = 0;
    for (let k = 1; k <= 8; k++) sum += 0.5 * Math.pow(1 - 1e-5, k);
    expect(x[0]).toBeCloseTo((0.4 / 8) * 2 * 2 * sum, 12);
    expect(x[0]).toBeCloseTo(0.8, 4);
    // the envelope then falls linearly to the sustain level: sample k is about volume · (1 + 2·punch·(1 − k/len)), here low half so negative
    expect(Math.abs(x[500]!) / x[0]!).toBeCloseTo(1.5 / 2, 1);
  });

  it('a plain square at full volume swings nearly ±1 (the doubling); a sine never exceeds the clip', () => {
    const sq = renderClassic(patch({ volume: 1, freq: 0.5 }));
    expect(Math.max(...sq)).toBeGreaterThan(0.99);
    expect(Math.max(...sq)).toBeLessThanOrEqual(1);
    expect(Math.min(...sq)).toBeLessThan(-0.99);
    const sine = renderClassic(patch({ wave: 2, volume: 1, freq: 0.5 }));
    expect(Math.max(...sine)).toBeGreaterThan(0.99);
    expect(Math.max(...sine)).toBeLessThanOrEqual(1);
  });

  it('the start period is 100/(f² + 0.001) supersamples: freq 0.5 → 398 → 49.75 samples per cycle', () => {
    const x = renderClassic(patch({ volume: 1, freq: 0.5, sustain: 0.1 }));
    let changes = 0;
    for (let i = 1; i < x.length; i++) if (Math.sign(x[i]!) !== Math.sign(x[i - 1]!) && x[i] !== 0 && x[i - 1] !== 0) changes++;
    // 1003 samples / 49.75 = 20.2 cycles → about 40 sign changes
    expect(changes).toBeGreaterThanOrEqual(39);
    expect(changes).toBeLessThanOrEqual(41);
  });

  it('the duty is 0.5 − 0.5·duty: duty 0.5 is high a quarter of the time, duty 0 half of it', () => {
    const high = (x: Float64Array) => x.filter((v) => v > 0.2).length / x.filter((v) => Math.abs(v) > 0.2).length;
    expect(high(renderClassic(patch({ volume: 0.5, freq: 0.5, duty: 0.5, sustain: 0.05 })))).toBeCloseTo(0.25, 1);
    expect(high(renderClassic(patch({ volume: 0.5, freq: 0.5, duty: 0, sustain: 0.05 })))).toBeCloseTo(0.5, 1);
  });

  it('minFreq ends the sound when the period reaches 100/(m² + 0.001)', () => {
    // slide −0.5 multiplies the period by 1 − (−0.5)³·0.01 = 1.00125 each sample; minFreq 0.3 caps it at 100/0.091.
    const p = makePatch({ sustain: 0.5, decay: 0, freq: 0.5, slide: -0.5, minFreq: 0.3 });
    let per = 100 / (0.5 * 0.5 + 0.001);
    const max = 100 / (0.3 * 0.3 + 0.001);
    let n = 0;
    do { per *= 1.00125; n++; } while (per <= max);
    expect(renderClassic(p).length).toBe(n);
    expect(n).toBeLessThan(envelopeLength(p));
    // with minFreq 0 the same slide runs the whole envelope
    expect(renderClassic({ ...p, minFreq: 0 }).length).toBe(envelopeLength(p));
  });

  it('quantises as trunc(s × 32000): toward zero, 16-bit, mono, 44,100 Hz', () => {
    const q = quantizeClassic(Float64Array.of(0.4, -0.4, 0.00003, -0.00003, 1, -1, 0.99999));
    expect(Array.from(q)).toEqual([12800, -12800, 0, 0, 32000, -32000, 31999]);
    const x = renderClassic(patch({ wave: 2, volume: 0.8 }));
    const w = decodeWav(classicWav(x));
    expect(w).toMatchObject({ channels: 1, sampleRate: 44100, bitsPerSample: 16, frames: x.length });
    expect(Array.from(w.data)).toEqual(Array.from(x, (v) => Math.trunc(v * 32000)));
  });

  it('a zero-length decay is silent at the end, not NaN', () => {
    const x = renderClassic(makePatch({ sustain: 0.05, decay: 0 }));
    expect(x.every((v) => Number.isFinite(v))).toBe(true);
    expect(x[x.length - 1]).toBe(0);
  });

  it('repeat restarts the pitch: a falling sound repeated has a higher mean pitch than the same sound once', () => {
    const base = { sustain: 0.3, decay: 0, freq: 0.5, slide: 0.4, volume: 1 };
    const crossings = (x: Float64Array) => { let c = 0; for (let i = 1; i < x.length; i++) if (x[i - 1]! < 0 !== x[i]! < 0) c++; return c; };
    expect(crossings(renderClassic(makePatch({ ...base, repeatSpeed: 0.9 })))).toBeLessThan(crossings(renderClassic(makePatch(base))));
  });
});

describe('the noise stream and seeds', () => {
  const noise = (o: Record<string, number>) => makePatch({ wave: 3, sustain: 0.05, decay: 0, freq: 0.5, ...o });
  const hash = (x: Float64Array) => sha256Hex(new Uint8Array(x.buffer));

  it('seedOf is FNV-1a over the values joined by commas at 14 significant digits', () => {
    const fnv = (s: string) => { let h = 2166136261n; for (const ch of s) h = ((h ^ BigInt(ch.charCodeAt(0))) * 16777619n) & 0xffffffffn; return Number(h); };
    const p = defaultPatch();
    expect(seedOf(p)).toBe(fnv('0,0,0.3,0,0.4,0.3,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0.5'));
    const q = makePatch({ freq: 0.123456789012345678, slide: -0.5, wave: 3 });
    expect(seedOf(q)).toBe(fnv(`3,0,0.3,0,0.4,0.12345678901235,0,-0.5,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0.5`));
  });

  it('the same parameters always give the same noise; another value or seed gives other noise', () => {
    expect(hash(renderClassic(noise({})))).toBe(hash(renderClassic(noise({}))));
    expect(hash(renderClassic(noise({ freq: 0.51 })))).not.toBe(hash(renderClassic(noise({}))));
    expect(hash(renderClassic(noise({ seed: 1 })))).not.toBe(hash(renderClassic(noise({ seed: 2 }))));
    expect(hash(renderClassic(noise({ seed: 1 })))).toBe(hash(renderClassic(noise({ seed: 1 }))));
  });

  it('opts.seed overrides the patch seed, which overrides the hash; seed 0 is replaced by 0x2545F491', () => {
    expect(hash(renderClassic(noise({ seed: 5 }), { seed: 9 }))).toBe(hash(renderClassic(noise({ seed: 9 }))));
    expect(hash(renderClassic(noise({ seed: seedOf(noise({})) })))).toBe(hash(renderClassic(noise({}))));
    expect(hash(renderClassic(noise({ seed: 0 })))).toBe(hash(renderClassic(noise({ seed: 0x2545f491 }))));
    expect(hash(renderClassic(noise({ seed: 4294967296 + 5 })))).toBe(hash(renderClassic(noise({ seed: 5 }))));
    expect(hash(renderClassic(noise({ seed: -1 })))).toBe(hash(renderClassic(noise({ seed: 4294967295 }))));
  });

  it('only the noise wave listens to the seed', () => {
    const sq = (seed: number) => renderClassic(makePatch({ sustain: 0.05, decay: 0, seed }));
    expect(hash(sq(1))).toBe(hash(sq(2)));
  });

  it('noise is uniform in [-1, 1) before the envelope: mean near zero, spread over the range', () => {
    const x = renderClassic(makePatch({ wave: 3, sustain: 0.3, decay: 0, freq: 0.9, volume: 1 }));
    const mean = x.reduce((a, b) => a + b, 0) / x.length;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(Math.max(...x)).toBeGreaterThan(0.3);
  });
});

describe('the platform-proof maths', () => {
  it('sinRad agrees with the engine sine to the last bit on this platform, over a wide range', () => {
    let wrong = 0;
    for (let i = 0; i < 200000; i++) {
      const x = (i % 2 ? -1 : 1) * (i * 0.0173 + (i % 5) * 1e-7);
      if (sinRad(x) !== Math.sin(x)) wrong++;
    }
    expect(wrong).toBe(0);
  });

  it('sinRad is pinned: a hash of its output over fixed arguments (so a change of platform or code shows)', () => {
    const x = new Float64Array(5000);
    for (let i = 0; i < x.length; i++) x[i] = sinRad(i * 0.37 - 400);
    expect(sha256Hex(new Uint8Array(x.buffer))).toBe('74fbfd2cd1f4de19b15de9812e475740f091413911bbcded9e9a3f55c9623f20');
  });

  it('cube is x³ rounded once (checked against exact integer arithmetic)', () => {
    const exact = (x: number): number => {
      const b = new DataView(new ArrayBuffer(8));
      b.setFloat64(0, x);
      const hi = b.getUint32(0), lo = b.getUint32(4);
      const ex = (hi >>> 20) & 0x7ff;
      let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
      m |= 1n << 52n;
      const e = ex - 1075;
      let M = m * m * m;
      const neg = hi >>> 31 === 1;
      const shift = M.toString(2).length - 53;
      let q = M >> BigInt(shift);
      const rem = M & ((1n << BigInt(shift)) - 1n);
      const half = 1n << BigInt(shift - 1);
      if (rem > half || (rem === half && (q & 1n))) q += 1n;
      const r = Number(q) * Math.pow(2, 3 * e + shift);
      return neg ? -r : r;
    };
    let wrong = 0;
    for (let i = 1; i <= 5000; i++) {
      const x = Math.sin(i * 1.37) * 0.99;
      if (cube(x) !== exact(x)) wrong++;
    }
    expect(wrong).toBe(0);
    expect(cube(0)).toBe(0);
    expect(cube(-0.5)).toBe(-0.125);
  });

  it('formatG is C\'s %g', () => {
    expect(formatG(0.3, 14)).toBe('0.3');
    expect(formatG(2, 14)).toBe('2');
    expect(formatG(1e-5, 14)).toBe('1e-05');
    expect(formatG(1e15, 14)).toBe('1e+15');
    expect(formatG(123456789, 6)).toBe('1.23457e+08');
    expect(formatG(0.123456789, 6)).toBe('0.123457');
    expect(formatG(-0, 6)).toBe('-0');
    expect(formatG(0.0001234, 6)).toBe('0.0001234');
  });
});

describe('the single-patch text', () => {
  it('formats the version tag, then 25 positional numbers at six significant digits', () => {
    const p = makePatch({ wave: 1, freq: 0.123456789, slide: -0.5 });
    expect(formatPatch(p)).toBe('1\n1,0,0.3,0,0.4,0.123457,0,-0.5,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0.5\n');
  });

  it('parses positional (empty fields keep defaults), name=value, versions, comments, and mixed separators', () => {
    expect(parsePatch('1\n2,0.1,,0.5').patch).toMatchObject({ wave: 2, attack: 0.1, sustain: 0.3, punch: 0.5 });
    expect(parsePatch('1\n2,0.1,,0.5').version).toBe('1');
    expect(parsePatch('2,0.1').version).toBeNull();
    expect(parsePatch('wave=saw, freq=0.6; decay=0.2\nvolume=0.9').patch).toMatchObject({ wave: 1, freq: 0.6, decay: 0.2, volume: 0.9 });
    expect(parsePatch('# a coin\n1\nwave=0,freq=0.7 # bright\n').patch).toMatchObject({ wave: 0, freq: 0.7 });
    expect(parsePatch('wave=3,seed=77').patch.seed).toBe(77);
    expect(parsePatch('  \r\n1\r\n 0 , 0.2 \r\n').patch.attack).toBe(0.2);
    expect(parsePatch('0x2,0.5').patch).toMatchObject({ wave: 2, attack: 0.5 });
  });

  it('refuses what it cannot read, saying where', () => {
    expect(() => parsePatch('0,abc')).toThrow(/field 2 is not a number/);
    expect(() => parsePatch(Array(26).fill('0').join(','))).toThrow(/26 fields, at most 25/);
    expect(() => parsePatch('wave=0,speed=3')).toThrow(/unknown parameter 'speed'/);
    expect(() => parsePatch('wave=0,freq')).toThrow(ClassicError);
    expect(() => parsePatch('wave=triangle')).toThrow(/unknown wave/);
    expect(() => parsePatch('freq=fast')).toThrow(/must be a number/);
  });

  it('round-trips: format then parse gives the same patch (up to the six digits it prints), and the named form is exact', () => {
    for (const p of [defaultPatch(), makePatch({ wave: 3, freq: 0.5, slide: -0.25, lowPass: 0.4, resonance: 0.8, volume: 0.77 })]) {
      expect(parsePatch(formatPatch(p)).patch).toEqual(p);
      expect(parsePatch(formatPatchNamed(p)).patch).toEqual(p);
    }
    const fine = makePatch({ freq: 0.123456789, punch: 1 / 3 });
    expect(parsePatch(formatPatchNamed(fine)).patch).toEqual(fine);
    expect(parsePatch(formatPatch(fine)).patch.freq).toBe(0.123457);
    const seeded = makePatch({ wave: 3, seed: 4242 });
    expect(parsePatch(formatPatchNamed(seeded)).patch).toEqual(seeded);
    expect(patchValues(defaultPatch())).toHaveLength(25);
  });
});

describe('synth.csv', () => {
  it('reads named columns in any order; a missing column, an empty cell or NA takes the default; seed is optional', () => {
    const rows = parseCsv('id,volume,freq,wave,decay,seed\ncoin,0.7,0.6,square,NA,\nboom,0.9,,noise,0.5,123\n');
    expect(rows.map((r) => r.id)).toEqual(['coin', 'boom']);
    expect(rows[0]!.patch).toEqual(makePatch({ volume: 0.7, freq: 0.6, wave: 0 }));
    expect(rows[0]!.patch.seed).toBeUndefined();
    expect(rows[1]!.patch).toEqual(makePatch({ volume: 0.9, wave: 3, decay: 0.5, seed: 123 }));
  });

  it('takes the key from a column called id, key, sound or name, else the first column', () => {
    expect(parseCsv('freq,name\n0.5,a\n')[0]).toMatchObject({ id: 'a', patch: { freq: 0.5 } });
    expect(parseCsv('sfx,freq\nzap,0.4\n')[0]).toMatchObject({ id: 'zap', patch: { freq: 0.4 } });
  });

  it('skips blank lines and comments, honours quoted cells, and rejects what is wrong with its line', () => {
    expect(parseCsv('# table\nid,freq\n\n"a",0.2\n')).toHaveLength(1);
    expect(() => parseCsv('id,speed\na,1\n')).toThrow(/unknown column 'speed'/);
    expect(() => parseCsv('id,freq\na,1\na,2\n')).toThrow(/'a' appears twice/);
    expect(() => parseCsv('id,freq\na,fast\n')).toThrow(/line 2 \(a\).*must be a number/);
    expect(() => parseCsv('')).toThrow(/no header/);
  });

  it('writes every column at full precision and reads back the same patches', () => {
    const rows = [
      { id: 'a', patch: makePatch({ wave: 2, freq: 0.123456789 }) },
      { id: 'b', patch: makePatch({ wave: 3, seed: 7, lowPass: 0.5 }) },
    ];
    const text = formatCsv(rows);
    expect(text.split('\n')[0]).toBe(['id', ...CLASSIC_FIELDS.map((f) => f.name), 'seed'].join(','));
    expect(parseCsv(text).map((r) => r.patch)).toEqual(rows.map((r) => r.patch));
    expect(formatCsv([rows[0]!]).split('\n')[0]).not.toContain('seed');
  });
});

describe('what renders uses no platform maths', () => {
  it('classic.ts, mathx.ts, render.ts, generators.ts and sound.ts never call Math.sin/cos/tan/pow/exp/log/hypot/atan, Date or Math.random', () => {
    for (const f of ['classic.ts', 'mathx.ts', 'render.ts', 'generators.ts', 'sound.ts']) {
      const src = readFileSync(join(import.meta.dirname, '..', 'src', f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(src, f).not.toMatch(/Math\.(sin|cos|tan|pow|exp|log\d*|hypot|atan\d?|random)\b|\bDate\b/);
    }
  });
});
