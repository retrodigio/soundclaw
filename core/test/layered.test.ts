// The layered voice: spot values worked out by hand, envelopes, filters, effects, the limiter,
// layer-up, stereo, the commands and their normal forms, the harsh check, and goldens.

import { describe, expect, it } from 'vitest';
import {
  CHECK_NAMES, DEFAULT_STYLE, SAMPLE_RATE, adsr, analyze, applyCommand, channelCount, curveValue, encodeWavChannels, decodeWav, envAt, exp2, formatEnv, harshBand, limitChannels, log2, parse, parseEnv, renderChannels,
  parsePatch, renderClassic, renderKey, renderSound, replay, runChecks, sineCycles, truePeak, yinPitch, readSampleWav, soundExport, serializeSound, type Library, type LayeredSound, type TapeEntry,
} from '../src/index.ts';
import { BANK, build, layered, render, tailPeak } from './layered-helpers.ts';

const NEW = 'sound new s voice=layered seed=1\n';
const FLAT = 'env s 1.amp "0:1"\n'; // a flat amplitude envelope: no 2 ms fades at the ends

describe('deterministic maths', () => {
  it('exp2 and log2 agree with Math.pow / Math.log2 to 1e-12 and invert each other', () => {
    for (let x = -30; x <= 30; x += 0.37) {
      expect(Math.abs(exp2(x) / 2 ** x - 1)).toBeLessThan(1e-12);
      expect(Math.abs(log2(2 ** x) - x)).toBeLessThan(1e-11);
    }
    expect(exp2(3)).toBe(8);
    expect(exp2(-1)).toBe(0.5);
    expect(log2(1)).toBe(0);
    expect(log2(1024)).toBe(10);
  });
});

describe('oscillators', () => {
  it('a sine at 1 kHz is sin(2*pi*1000*t) sample for sample', () => {
    const x = render(layered(NEW + 'layer add s osc wave=sine freq=1000 dur=0.1\n' + FLAT));
    expect(Math.abs(x.length - 4410)).toBeLessThanOrEqual(2); // the automatic length ends where the sound has died away
    expect(x[0]).toBe(0);
    for (const i of [1, 10, 100, 1000, 4000]) expect(Math.abs(x[i]! - Math.sin((2 * Math.PI * 1000 * i) / SAMPLE_RATE))).toBeLessThan(1e-7); // (the samples are float32)
  });

  it('without an amplitude envelope a layer fades in and out over 2 ms; with one it does not', () => {
    const faded = render(layered(NEW + 'layer add s osc wave=square freq=100 dur=0.1\n'));
    const flat = render(layered(NEW + 'layer add s osc wave=square freq=100 dur=0.1\n' + FLAT));
    expect(Math.abs(faded[0]!)).toBe(0);
    expect(Math.abs(flat[0]!)).toBe(1);
    expect(Math.abs(faded[100]!)).toBe(1);
    expect(Math.abs(faded.at(-1)!)).toBeLessThan(0.02);
  });

  it('square, saw, triangle, pulse have their shapes; duty moves the square', () => {
    const w = (wave: string, extra = '') => render(layered(NEW + `layer add s osc wave=${wave} freq=441 dur=0.05 ${extra}\n` + FLAT)); // 100 samples a cycle
    const sq = w('square');
    expect([sq[10], sq[40], sq[60], sq[90]]).toEqual([1, 1, -1, -1]);
    const duty = w('square', 'duty=0.25');
    expect([duty[10], duty[30], duty[60]]).toEqual([1, -1, -1]);
    const saw = w('saw');
    expect(saw[0]).toBe(0);
    expect(saw[25]).toBeCloseTo(0.5, 6);
    expect(saw[75]).toBeCloseTo(-0.5, 6);
    expect(saw[49]).toBeCloseTo(0.98, 6);
    const tri = w('triangle');
    expect([tri[0], tri[25], tri[50], tri[75]].map((v) => Math.round(v! * 1e6) / 1e6 + 0)).toEqual([0, 1, 0, -1]);
    const pulse = w('pulse', 'duty=0.1');
    expect(Math.max(...pulse)).toBeCloseTo(1, 6);
    expect(Math.abs(pulse.reduce((s, v) => s + v, 0) / pulse.length)).toBeLessThan(0.02); // zero mean
  });

  it('wavetable reads its points back (and interpolates between them)', () => {
    const x = render(layered(NEW + 'layer add s osc wave=wavetable table=0,1,0,-1 freq=441 dur=0.05\n' + FLAT));
    expect(x[0]).toBe(0);
    expect(x[25]).toBeCloseTo(1, 6);
    expect(x[12]).toBeCloseTo(0.48, 6);
    expect(x[75]).toBeCloseTo(-1, 6);
  });

  it('white, pink, brown noise are seeded: same seed same noise, another seed another', () => {
    for (const wave of ['white', 'pink', 'brown']) {
      const a = render(layered(NEW + `layer add s osc wave=${wave} dur=0.1 seed=5\n` + FLAT));
      const b = render(layered(NEW + `layer add s osc wave=${wave} dur=0.1 seed=5\n` + FLAT));
      const c = render(layered(NEW + `layer add s osc wave=${wave} dur=0.1 seed=6\n` + FLAT));
      expect(Buffer.compare(Buffer.from(a.buffer), Buffer.from(b.buffer))).toBe(0);
      expect(Buffer.compare(Buffer.from(a.buffer), Buffer.from(c.buffer))).not.toBe(0);
      expect(Math.max(...a.map(Math.abs))).toBeLessThanOrEqual(1.5);
    }
  });

  it('metal noise repeats: it has a pitch', () => {
    const x = render(layered(NEW + 'layer add s osc wave=metal freq=441 dur=0.2 seed=3\n' + FLAT));
    const period = 100; // 441 Hz at 44.1 kHz
    let same = 0;
    for (let i = 2000; i < 6000; i++) if (x[i] === x[i + period]) same++;
    expect(same / 4000).toBeGreaterThan(0.9);
  });
});

describe('FM', () => {
  it('with every modulation index 0 it is its carrier, bit for bit', () => {
    const fm = render(layered(NEW + 'layer add s fm freq=440 ops=2 index2=0 dur=0.1\n'));
    const osc = render(layered(NEW + 'layer add s osc wave=sine freq=440 dur=0.1\n'));
    expect(Buffer.compare(Buffer.from(fm.buffer), Buffer.from(osc.buffer))).toBe(0);
    const four = render(layered(NEW + 'layer add s fm freq=440 ops=4 index2=0 index3=0 index4=0 dur=0.1\n'));
    expect(Buffer.compare(Buffer.from(four.buffer), Buffer.from(osc.buffer))).toBe(0);
  });

  it('the carrier runs at freq x ratio1', () => {
    const fm = render(layered(NEW + 'layer add s fm freq=220 ratio1=2 index2=0 dur=0.1\n'));
    const osc = render(layered(NEW + 'layer add s osc wave=sine freq=440 dur=0.1\n'));
    expect(Buffer.compare(Buffer.from(fm.buffer), Buffer.from(osc.buffer))).toBe(0);
  });

  it('modulation adds sidebands: the spectrum widens with the index', () => {
    const bright = (idx: number) => analyze(render(layered(NEW + `layer add s fm freq=440 ratio2=2 index2=${idx} dur=0.3\n` + FLAT))).centroid.mean;
    expect(bright(4)).toBeGreaterThan(bright(0.5) * 1.3);
  });

  it('every algorithm renders something different at 3 and 4 operators', () => {
    const hashes = new Set(['chain', 'fan', 'pairs', 'parallel'].map((algo) => Buffer.from(render(layered(NEW + `layer add s fm ops=4 algo=${algo} index2=2 index3=2 index4=2 dur=0.1\n`)).buffer).toString('base64')));
    expect(hashes.size).toBe(4);
  });
});

describe('Karplus-Strong', () => {
  it('rings at the pitch asked for', () => {
    for (const f of [110, 330, 880]) {
      const x = render(layered(NEW + `layer add s ks freq=${f} dur=1 decay=2\n`));
      const frames = yinPitch(x.subarray(2000, 30000), { hop: 512 }).filter((p) => p.hz !== null).map((p) => p.hz!);
      const median = [...frames].sort((a, b) => a - b)[Math.floor(frames.length / 2)]!;
      expect(frames.length).toBeGreaterThan(20);
      expect(Math.abs(median / f - 1)).toBeLessThan(0.006);
    }
  });

  it('dies away faster with a shorter `decay`; a long string is still ringing when a short one has gone', () => {
    const level = (decay: number, at: number) => {
      const x = render(layered(NEW + `layer add s ks freq=440 dur=2 decay=${decay}\n` + FLAT));
      const from = Math.round(at * SAMPLE_RATE);
      return 20 * Math.log10(Math.sqrt(x.subarray(from, from + 441).reduce((s, v) => s + v * v, 0) / 441));
    };
    expect(level(2, 0.5)).toBeGreaterThan(level(0.5, 0.5) + 15);
    expect(level(2, 1.2)).toBeGreaterThan(level(0.25, 1.2) + 30);
  });
});

describe('sample layers', () => {
  it('plays a sample at its own rate, trimmed, pitched an octave up (half as long) and reversed', () => {
    const base = render(layered(NEW + 'layer add s sample sample=tick\n' + FLAT), BANK);
    expect(Math.abs(base.length - 4410)).toBeLessThanOrEqual(30); // 2205 frames at 22,050 Hz = 0.1 s (minus the faded-out end)
    const up = render(layered(NEW + 'layer add s sample sample=tick pitch=12\n' + FLAT), BANK);
    expect(Math.abs(up.length - 2205)).toBeLessThanOrEqual(8);
    const trimmed = render(layered(NEW + 'layer add s sample sample=tick start=0.02 end=0.05\n' + FLAT), BANK);
    expect(Math.abs(trimmed.length - 1323)).toBeLessThanOrEqual(8);
    const rev = render(layered(NEW + 'layer add s sample sample=tick reverse=1\n' + FLAT), BANK);
    for (const i of [500, 1500, 3000]) expect(Math.min(...[-2, -1, 0, 1, 2].map((d) => Math.abs(rev[i]! - base[Math.min(base.length - 1, Math.max(0, base.length - 1 - i + d))]!)))).toBeLessThan(0.05);
  });

  it('a missing sample is silence (the server refuses to write it)', () => {
    const x = render(layered(NEW + 'layer add s sample sample=nothere\n'), BANK);
    expect(Math.max(...x.map(Math.abs))).toBe(0);
  });

  it('the render key follows the sample bytes', () => {
    const s = layered(NEW + 'layer add s sample sample=tick\n');
    expect(renderKey(s, () => 'aaa')).not.toBe(renderKey(s, () => 'bbb'));
  });

  it('reads 8, 16, 24 and 32-bit PCM and float WAVs of any rate, stereo mixed to mono', () => {
    const make = (bits: number, float: boolean, ch: number, rate: number, frames = 100): Uint8Array => {
      const bps = bits / 8;
      const out = new Uint8Array(44 + frames * ch * bps);
      const v = new DataView(out.buffer);
      const tag = (o: number, t: string) => { for (let i = 0; i < 4; i++) out[o + i] = t.charCodeAt(i); };
      tag(0, 'RIFF'); v.setUint32(4, out.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt '); v.setUint32(16, 16, true);
      v.setUint16(20, float ? 3 : 1, true); v.setUint16(22, ch, true); v.setUint32(24, rate, true); v.setUint32(28, rate * ch * bps, true);
      v.setUint16(32, ch * bps, true); v.setUint16(34, bits, true); tag(36, 'data'); v.setUint32(40, frames * ch * bps, true);
      for (let i = 0; i < frames; i++) for (let c = 0; c < ch; c++) {
        const val = c === 0 ? 0.5 : -0.25;
        const o = 44 + (i * ch + c) * bps;
        if (float) v.setFloat32(o, val, true);
        else if (bits === 8) v.setUint8(o, 128 + val * 128);
        else if (bits === 16) v.setInt16(o, val * 32768, true);
        else if (bits === 24) { const n = Math.round(val * 8388608); v.setUint8(o, n & 255); v.setUint8(o + 1, (n >> 8) & 255); v.setUint8(o + 2, (n >> 16) & 255); } else v.setInt32(o, val * 2147483648, true);
      }
      return out;
    };
    for (const [bits, float] of [[8, false], [16, false], [24, false], [32, false], [32, true]] as const) {
      const mono = readSampleWav(make(bits, float, 1, 48000));
      expect(mono.rate).toBe(48000);
      expect(mono.data[5]).toBeCloseTo(0.5, 2);
      const st = readSampleWav(make(bits, float, 2, 22050));
      expect(st.channels).toBe(2);
      expect(st.data[5]).toBeCloseTo(0.125, 2);
    }
    expect(() => readSampleWav(new Uint8Array(20))).toThrow(/not a WAV/);
    const mp3ish = make(16, false, 1, 44100); new DataView(mp3ish.buffer).setUint16(20, 85, true);
    expect(() => readSampleWav(mp3ish)).toThrow(/only PCM/);
  });
});

describe('envelopes', () => {
  const pts = (s: string) => parseEnv(s);
  it('linear: halfway is the mean; before the first point and after the last it holds', () => {
    const e = pts('0.1:1 0.3:3');
    expect(envAt(e, 0)).toBe(1);
    expect(envAt(e, 0.2)).toBe(2);
    expect(envAt(e, 1)).toBe(3);
  });
  it('exponential between two positive values is geometric (equal ratios in equal times)', () => {
    const e = pts('0:100 1:400@exp');
    expect(envAt(e, 0.5)).toBeCloseTo(200, 8);
    expect(envAt(e, 0.25)).toBeCloseTo(100 * Math.SQRT2, 8);
  });
  it('exponential towards zero is a fast-then-slow fall that arrives', () => {
    const e = pts('0:1 1:0@exp');
    expect(envAt(e, 0.5)).toBeLessThan(0.1);
    expect(envAt(e, 0.5)).toBeGreaterThan(0.01);
    expect(envAt(e, 1)).toBe(0);
    expect(curveValue(1, 0, 0.001, 'exp')).toBeLessThan(0.995);
  });
  it('hold keeps the value until the next point; ease is smoothstep', () => {
    expect(envAt(pts('0:1 0.5:3@hold'), 0.4999)).toBe(1);
    expect(envAt(pts('0:1 0.5:3@hold'), 0.5)).toBe(3);
    expect(envAt(pts('0:0 1:1@ease'), 0.5)).toBe(0.5);
    expect(envAt(pts('0:0 1:1@ease'), 0.25)).toBeCloseTo(0.15625, 10);
  });
  it('breakpoints round-trip as text and refuse nonsense', () => {
    expect(formatEnv(pts('0:1 0.1:0.5@exp 0.3:0@hold'))).toBe('0:1 0.1:0.5@exp 0.3:0@hold');
    expect(formatEnv(pts('0:1 0.1:0.5@exponential'))).toBe('0:1 0.1:0.5@exp');
    expect(() => pts('0:1 0:2')).toThrow(/times must rise/);
    expect(() => pts('0:1 1:x')).toThrow(/numbers/);
    expect(() => pts('0:1@wobble')).toThrow(/no curve/);
    expect(() => pts('')).toThrow(/breakpoints/);
  });
  it('adsr writes breakpoints', () => {
    expect(formatEnv(adsr(0.01, 0.1, 0.5, 0.2))).toBe('0:0 0.01:1 0.11:0.5@exp 0.31:0@exp');
    expect(formatEnv(adsr(0, 0.1, 0, 0))).toBe('0:1 0.1:0@exp');
    expect(formatEnv(adsr(0.01, 0.1, 0.5, 0.2, 0.3))).toBe('0:0 0.01:1 0.11:0.5@exp 0.41:0.5 0.61:0@exp');
  });

  it('an envelope replaces a fixed value: a falling frequency sweeps down, gain follows its breakpoints', () => {
    const x = render(layered(NEW + 'layer add s osc wave=sine freq=100 dur=0.5\nenv s 1.freq "0:200 0.5:100"\n' + FLAT));
    const zc = (a: number, b: number) => { let n = 0; for (let i = a + 1; i < b; i++) if (x[i - 1]! < 0 && x[i]! >= 0) n++; return n; };
    expect(zc(0, 4410)).toBeGreaterThan(zc(17640, 22050) + 4); // first 0.1 s has more cycles than the last
    const g = render(layered(NEW + 'layer add s osc wave=square freq=100 dur=0.4\nenv s 1.gain "0:0 0.2:1"\n' + FLAT));
    expect(Math.abs(g[Math.round(0.1 * SAMPLE_RATE)]!)).toBeCloseTo(0.5, 2);
  });

  it('setting a fixed value drops the envelope on that parameter', () => {
    const s = layered(NEW + 'layer add s osc freq=100\nenv s 1.freq "0:200 0.3:100"\nlayer set s 1 freq=300\n');
    expect(s.layers[0]!.envs.freq).toBeUndefined();
    expect(s.layers[0]!.p.freq).toBe(300);
  });
});

describe('filters', () => {
  const through = (type: string, hz: number, cutoff: number, q = 0.707) => tailPeak(render(layered(NEW + `layer add s osc wave=sine freq=${hz} dur=0.5 filter=${type} cutoff=${cutoff} q=${q}\n` + FLAT)));
  it('a low-pass passes 1/sqrt(2) at its cutoff (Q = 0.707), 1 well below, almost 0 well above', () => {
    expect(through('lp', 1000, 1000)).toBeCloseTo(Math.SQRT1_2, 2);
    expect(through('lp', 100, 1000)).toBeCloseTo(1, 2);
    expect(through('lp', 8000, 1000)).toBeLessThan(0.02);
  });
  it('the response at the cutoff is Q: a resonant low-pass rings up, high-pass mirrors it', () => {
    expect(through('lp', 1000, 1000, 4)).toBeCloseTo(4, 1);
    expect(through('hp', 1000, 1000)).toBeCloseTo(Math.SQRT1_2, 2);
    expect(through('hp', 8000, 1000)).toBeCloseTo(1, 1);
    expect(through('hp', 100, 1000)).toBeLessThan(0.02);
  });
  it('band-pass peaks at 1 in the middle; the notch removes it', () => {
    expect(through('bp', 1000, 1000, 2)).toBeCloseTo(1, 2);
    expect(through('bp', 100, 1000, 2)).toBeLessThan(0.2);
    expect(through('notch', 1000, 1000, 2)).toBeLessThan(0.01);
    expect(through('notch', 100, 1000, 2)).toBeCloseTo(1, 1);
  });
  it('a cutoff envelope sweeps the filter: noise gets duller', () => {
    const x = render(layered(NEW + 'layer add s osc wave=white dur=0.6 filter=lp seed=2\nenv s 1.cutoff "0:8000 0.5:300@exp"\n' + FLAT));
    const bright = (a: number, b: number) => analyze(x.subarray(a, b)).centroid.mean;
    expect(bright(1000, 5000)).toBeGreaterThan(bright(20000, 24000) * 2);
  });
});

describe('effects', () => {
  const fxOf = (line: string, osc = 'wave=sine freq=441 dur=0.3') => render(layered(NEW + `layer add s osc ${osc}\n` + FLAT + line));
  it('bitcrush quantises to steps of 2^(1-bits) and holds samples at the reduced rate', () => {
    const x = fxOf('env s 1.amp "0:0.9"\nfx add s layer=1 bitcrush bits=4', 'wave=sine freq=441 dur=0.1');
    const step = 2 ** -3;
    for (const v of x) expect(Math.abs(v / step - Math.round(v / step))).toBeLessThan(1e-6);
    expect(new Set([...x].map((v) => Math.round(v / step))).size).toBeGreaterThan(8);
    const r = fxOf('fx add s layer=1 bitcrush bits=16 rate=4410', 'wave=sine freq=100 dur=0.1');
    let changes = 0;
    for (let i = 1; i < r.length; i++) if (r[i] !== r[i - 1]) changes++;
    expect(changes).toBeLessThanOrEqual(r.length / 10 + 2); // held for ten samples at a time
  });
  it('distort: hard clips at 1, soft stays under 1, fold folds back, a mix of 0 is the dry signal', () => {
    const hard = fxOf('env s 1.amp "0:0.9"\nfx add s layer=1 distort shape=hard drive=4', 'wave=sine freq=441 dur=0.1');
    expect(Math.max(...hard)).toBe(1);
    expect(hard[25]).toBe(1); // 0.9 sine peak x 4 is clipped to 1
    const soft = fxOf('fx add s layer=1 distort shape=soft drive=10', 'wave=sine freq=441 dur=0.1');
    expect(Math.max(...soft)).toBeLessThan(1);
    expect(Math.max(...soft)).toBeGreaterThan(0.85);
    const dry = fxOf('fx add s layer=1 distort mix=0', 'wave=sine freq=441 dur=0.1');
    const none = fxOf('', 'wave=sine freq=441 dur=0.1');
    expect(Buffer.compare(Buffer.from(dry.buffer), Buffer.from(none.buffer))).toBe(0);
    const fold = fxOf('fx add s layer=1 distort shape=fold drive=1.5', 'wave=sine freq=441 dur=0.1');
    expect(Math.max(...fold)).toBeLessThan(1.0001);
    expect(fold[25]).toBeCloseTo(0.5, 6); // 1.5 folds back to 0.5
  });
  it('delay: the echo arrives after `time` at `feedback` strength', () => {
    const x = fxOf('fx add s layer=1 delay time=0.05 feedback=0.5 mix=1', 'wave=square freq=100 dur=0.01');
    const t = Math.round(0.05 * SAMPLE_RATE);
    expect(Math.abs(x[5]!)).toBe(0); // fully wet: nothing before the first echo
    expect(Math.abs(x[t + 5]!)).toBe(1);
    expect(Math.abs(x[2 * t + 5]!)).toBe(0.5);
  });
  it('reverb: a tail after the source, wet only when mixed in; chorus: changes the sound, mix 0 does not', () => {
    const wet = fxOf('fx add s layer=1 reverb size=0.6 mix=0.5', 'wave=white dur=0.05 seed=1');
    const dry = fxOf('', 'wave=white dur=0.05 seed=1');
    expect(wet.length).toBeGreaterThan(dry.length + 4000);
    const none = fxOf('fx add s layer=1 reverb mix=0', 'wave=white dur=0.05 seed=1');
    expect(none.length).toBe(dry.length);
    const ch = fxOf('fx add s layer=1 chorus mix=0.5', 'wave=saw freq=220 dur=0.3');
    const plain = fxOf('', 'wave=saw freq=220 dur=0.3');
    expect(ch.length).toBe(plain.length);
    expect(Buffer.compare(Buffer.from(ch.buffer), Buffer.from(plain.buffer))).not.toBe(0);
  });
  it('the order is stated and matters: source > filter > amp envelope > effects in list order > gain', () => {
    const a = fxOf('env s 1.amp "0:0.1"\nfx add s layer=1 distort shape=hard drive=8\nfx add s layer=1 bitcrush bits=3', 'wave=sine freq=441 dur=0.1');
    const b = fxOf('env s 1.amp "0:0.1"\nfx add s layer=1 bitcrush bits=3\nfx add s layer=1 distort shape=hard drive=8', 'wave=sine freq=441 dur=0.1');
    expect(Buffer.compare(Buffer.from(a.buffer), Buffer.from(b.buffer))).not.toBe(0);
    const c = fxOf('env s 1.amp "0:0.1"\nfx add s layer=1 distort shape=hard drive=8\nfx add s layer=1 bitcrush bits=3\nfx move s layer=1 2 to=1', 'wave=sine freq=441 dur=0.1');
    expect(Buffer.compare(Buffer.from(c.buffer), Buffer.from(b.buffer))).toBe(0); // moving the bitcrush first is the same as adding it first
  });
  it('master effects act on the sum; an effect envelope changes it over time', () => {
    const s = layered(NEW + 'layer add s osc wave=square freq=100 dur=0.2\n' + FLAT + 'layer add s osc wave=square freq=100 dur=0.2\nenv s 2.amp "0:1"\nfx add s distort shape=hard drive=1\nenv s master.fx1.mix "0:0 0.2:1"\n');
    const x = render(s);
    expect(Math.abs(x[10]!)).toBeGreaterThan(1.97); // the two layers add up to 2 while the effect is still dry
    expect(Math.abs(x[x.length - 20]!)).toBeLessThan(1.05); // and are clipped to 1 by the end
  });
});

describe('the limiter', () => {
  const loud = () => renderChannels(layered(NEW + 'layer add s osc wave=square freq=441 dur=0.2 gain=3\nlayer add s osc wave=saw freq=555 dur=0.2 gain=2\n' + FLAT.replace('1.amp', '1.amp') + 'env s 2.amp "0:1"\n'));
  it('keeps the true peak at or under the ceiling, whatever the ceiling', () => {
    for (const ceil of [-0.1, -1, -6]) {
      const r = limitChannels(loud(), ceil);
      const tp = 20 * Math.log10(truePeak(r.channels[0]!));
      expect(tp).toBeLessThanOrEqual(ceil + 1e-6);
      expect(tp).toBeGreaterThan(ceil - 1.2); // and not much lower: it is a limiter, not a mute
      expect(r.reductionDb).toBeGreaterThan(6);
    }
  });
  it('changes nothing under the ceiling (the gain is exactly 1)', () => {
    const quiet = renderChannels(layered(NEW + 'layer add s osc wave=sine freq=441 dur=0.2 gain=0.3\n'));
    const r = limitChannels(quiet, -0.1);
    expect(Buffer.compare(Buffer.from(r.channels[0]!.buffer), Buffer.from(quiet[0]!.buffer))).toBe(0);
    expect(r.reductionDb).toBe(0);
  });
  it('catches a peak between the samples', () => {
    // two samples of +0.9 side by side: the point between them overshoots on a reconstruction
    const x = new Float32Array(2000);
    x[1000] = 0.99; x[1001] = 0.99; x[999] = -0.4; x[1002] = -0.4;
    const r = limitChannels([x], -6);
    expect(20 * Math.log10(truePeak(r.channels[0]!))).toBeLessThanOrEqual(-6 + 1e-6);
  });
  it('export applies it with the style ceiling, and writes stereo WAVs with two channels', () => {
    const s = layered(NEW + 'layer add s osc wave=square freq=441 dur=0.2 gain=3 pan=-1\nlayer add s osc wave=saw freq=555 dur=0.2 gain=2 pan=1\n' + FLAT + 'env s 2.amp "0:1"\n');
    const e = soundExport(s, undefined, { ceilingDb: -1 });
    const w = decodeWav(e.wav);
    expect(w.channels).toBe(2);
    expect(e.channels).toBe(2);
    expect(e.reductionDb).toBeGreaterThan(3);
    const peak = Math.max(...w.data.map(Math.abs)) / 32767;
    expect(20 * Math.log10(peak)).toBeLessThanOrEqual(-1 + 0.01);
  });
});

describe('stereo', () => {
  it('a sound is mono until a layer is panned; then two channels; constant-power pan', () => {
    const mono = layered(NEW + 'layer add s osc wave=sine freq=441 dur=0.1\n');
    expect(channelCount(mono)).toBe(1);
    expect(renderChannels(mono)).toHaveLength(1);
    const left = layered(NEW + 'layer add s osc wave=sine freq=441 dur=0.1 pan=-1\n' + FLAT);
    const [l, r] = renderChannels(left);
    expect(channelCount(left)).toBe(2);
    expect(Math.max(...r!.map(Math.abs))).toBeLessThan(1e-9);
    expect(Math.max(...l!.map(Math.abs))).toBeCloseTo(1, 6);
    const mid = renderChannels(layered(NEW + 'layer add s osc wave=sine freq=441 dur=0.1 pan=0\nlayer add s osc wave=sine freq=441 dur=0.1 pan=0.0001\n' + FLAT));
    expect(Math.max(...mid[0]!.map(Math.abs))).toBeCloseTo(2 * Math.SQRT1_2, 2);
  });
  it('a pan envelope moves a sound across', () => {
    const [l, r] = renderChannels(layered(NEW + 'layer add s osc wave=square freq=100 dur=0.4\nenv s 1.pan "0:-1 0.4:1"\n' + FLAT));
    expect(Math.abs(l![100]!)).toBeGreaterThan(0.9);
    expect(Math.abs(r![100]!)).toBeLessThan(0.1);
    expect(Math.abs(l![17000]!)).toBeLessThan(0.1);
    expect(Math.abs(r![17000]!)).toBeGreaterThan(0.9);
  });
  it('the checks and numbers count both channels: loudness equals the mono sound, peaks take the louder channel', () => {
    const mono = analyze(renderChannels(layered(NEW + 'layer add s osc wave=sine freq=441 dur=1\n' + FLAT)));
    const st = layered(NEW + 'layer add s osc wave=sine freq=441 dur=1 pan=0.0001\n' + FLAT);
    const stereo = analyze(renderChannels(st));
    expect(stereo.channels).toBe(2);
    expect(Math.abs(stereo.lufs - mono.lufs)).toBeLessThan(0.05);
    const hard = analyze(renderChannels(layered(NEW + 'layer add s osc wave=sine freq=441 dur=1 pan=1\n' + FLAT)));
    expect(hard.peak).toBeCloseTo(1, 4);
    expect(hard.truePeakDb).toBeGreaterThan(-0.2);
    const checks = runChecks(renderChannels(st), stereo);
    expect(checks.map((c) => c.name)).toEqual([...CHECK_NAMES]);
  });
  it('a clip in only the right channel is found; a click in only one channel is found', () => {
    const n = 4410;
    const l = new Float32Array(n), r = new Float32Array(n);
    for (let i = 0; i < n; i++) { l[i] = 0.2 * Math.sin(i * 0.05) * Math.min(1, i / 100, (n - 1 - i) / 100); r[i] = l[i]!; }
    r[2000] = 1; r[2001] = 1; r[n - 1] = 0.5;
    const checks = runChecks([l, r], analyze([l, r]));
    expect(checks.find((c) => c.name === 'clip')!.pass).toBe(false);
    expect(checks.find((c) => c.name === 'click')!.pass).toBe(false);
    expect(runChecks([l, l], analyze([l, l])).find((c) => c.name === 'clip')!.pass).toBe(true);
  });
  it('encodeWavChannels interleaves', () => {
    const w = decodeWav(encodeWavChannels([Float32Array.of(0.5, 0), Float32Array.of(-0.5, 1)]));
    expect(w.channels).toBe(2);
    expect([...w.data]).toEqual([16384, -16383, 0, 32767]);
  });
});

describe('layer-up and the classic mark', () => {
  const patch = 'wave=0,attack=0,sustain=0.2,punch=0.4,decay=0.3,freq=0.5,minFreq=0,slide=-0.3,deltaSlide=0,vibratoDelay=0,vibratoDepth=0,vibratoSpeed=0,changeAmount=0,changeSpeed=0,duty=0.4,dutySweep=0,repeatSpeed=0,phaserOffset=0,phaserSweep=0,lowPass=1,lowPassSweep=0,resonance=0,highPass=0,highPassSweep=0,volume=0.5';
  it('makes the classic voice layer 1 with the very same samples', () => {
    for (const extra of ['', ',seed=1234']) {
      const lib = build(`sound new c voice=classic\nsound patch c "${patch}${extra}"\n`);
      const before = renderSound(lib.get('c')!);
      build('sound layer-up c', lib);
      const up = lib.get('c') as LayeredSound;
      expect(up.voice).toBe('layered');
      expect(up.layers).toHaveLength(1);
      const after = renderSound(up);
      expect(after.length).toBe(before.length);
      expect(Buffer.compare(Buffer.from(after.buffer), Buffer.from(before.buffer))).toBe(0);
      expect(Buffer.compare(Buffer.from(after.buffer), Buffer.from(Float32Array.from(renderClassic(parsePatch(patch + extra).patch)).buffer))).toBe(0);
    }
  });
  it('a classic sound marked classic refuses layer-up, layer and fx commands; the mark lifts', () => {
    const lib = build('sound new c voice=classic\nsound classic c on\n');
    expect((lib.get('c') as { classicOnly?: boolean }).classicOnly).toBe(true);
    expect(() => build('sound layer-up c', lib)).toThrow(/marked classic/);
    expect(() => build('layer add c osc', lib)).toThrow(/classic sound.*layer-up/s);
    expect(() => build('fx add c reverb', lib)).toThrow(/works on a layered sound/);
    expect(() => build('env c 1.amp clear', lib)).toThrow(/layered sound/);
    expect(serializeSound(lib.get('c')!)).toContain('classic yes');
    build('sound classic c off\nsound set c volume=0.3', lib);
    expect(() => build('sound layer-up c', lib)).not.toThrow();
  });
  it('sound set keeps working on classic sounds, and refuses layer-only things', () => {
    const lib = build('sound new c voice=classic\nsound set c freq=0.6 wave=saw\n');
    expect((lib.get('c') as { patch: { freq: number } }).patch.freq).toBe(0.6);
    expect(() => build('sound set c duration=auto', lib)).toThrow(/layered sound/);
    expect(() => build('sound set c gain=2', lib)).toThrow();
    const l = build('sound new l voice=layered seed=4\nsound set l duration=0.5 gain=0.5 seed=9\n');
    expect(l.get('l')).toMatchObject({ duration: 0.5, gain: 0.5, seed: 9 });
    build('sound set l duration=auto', l);
    expect((l.get('l') as LayeredSound).duration).toBeNull();
    expect(() => build('sound set l freq=0.5', l)).toThrow(/layered sound/);
  });
});

describe('commands: normal forms and errors', () => {
  const SCRIPT = `sound new imp voice=layered seed=7
sound set imp duration=1.5 gain=0.8
layer add imp osc wave=sine freq=60 dur=0.4 gain=0.9 pan=-0.2
layer add imp osc wave=white dur=0.12 filter=lp cutoff=3000 q=1.4
layer add imp fm freq=440 ops=3 algo=fan index2=2 index3=1.5 ratio2=3.5
layer add imp ks freq=196 decay=0.8 bright=0.5 at=1
layer add imp classic wave=saw freq=0.4
layer add imp sample sample=tick pitch=-5
env imp 2.freq "0:140 0.2:45@exp"
env imp 2.amp adsr(0.002,0.2,0,0)
env imp 3.cutoff "0:6000 0.1:400@exp"
env imp 3.gain "0:1@hold 0.05:0.5@ease 0.1:0"
fx add imp layer=3 reverb size=0.3 mix=0.15
fx add imp layer=3 bitcrush bits=6 at=1
fx add imp delay time=0.12 feedback=0.3
fx set imp layer=3 2 size=0.5
fx set imp 1 mix=0.2
env imp master.fx1.mix "0:0 1:0.4"
layer mute imp 5
layer solo imp 2 on
fx move imp layer=3 1 to=2
layer move imp 2 to=4
layer set imp 1 pan=0.5 filter=hp cutoff=200
env imp 4.freq clear
fx remove imp 1
layer remove imp 5`;

  it('every command has a normal form that parses back to itself, and the tape replays to the same sound', () => {
    const lib: Library = new Map();
    const entries: TapeEntry[] = [];
    let seq = 0;
    for (const c of parse(SCRIPT).commands) {
      const normal = applyCommand(lib, c) ?? c.text;
      const again = parse(normal);
      expect(again.errors, normal).toEqual([]);
      expect(again.commands).toHaveLength(1);
      entries.push({ seq: ++seq, by: 'agent:claude', group: 'g1', cmd: normal });
    }
    const replayed = replay(entries);
    expect(replayed.problems).toEqual([]);
    expect(serializeSound(replayed.library.get('imp')!)).toBe(serializeSound(lib.get('imp')!));
    expect(renderKey(replayed.library.get('imp')!)).toBe(renderKey(lib.get('imp')!));
    // and the normal form of a normal form is itself
    for (const e of entries) {
      const lib2 = new Map(lib);
      void lib2;
      expect(parse(e.cmd).commands[0]!.text).toBe(e.cmd);
    }
  });

  it('normal forms list values in the order of the parameter table, defaults dropped, and adsr becomes breakpoints', () => {
    const lib = build(NEW);
    const n = (cmd: string) => applyCommand(lib, parse(cmd).commands[0]!);
    expect(n('layer add s osc  cutoff=2000.0 filter=lp freq=0330 wave=saw')).toBe('layer add s osc wave=saw freq=330 filter=lp cutoff=2000');
    expect(n('layer set s 1 q=2 gain=0.50 freq=100')).toBe('layer set s 1 freq=100 gain=0.5 q=2');
    expect(n('env s 1.amp adsr(0.01,0.1,0.5,0.2)')).toBe('env s 1.amp "0:0 0.01:1 0.11:0.5@exp 0.31:0@exp"');
    expect(n('env s 1.freq "0.0:100 0.5:200@linear"')).toBe('env s 1.freq "0:100 0.5:200"');
    expect(n('fx add s layer=1 distort drive=4 shape=fold at=1')).toBe('fx add s layer=1 distort shape=fold at=1');
    expect(n('fx set s layer=1 1 mix=0.5 drive=8')).toBe('fx set s layer=1 1 drive=8 mix=0.5');
    expect(n('env s 1.freq clear')).toBe('env s 1.freq clear');
  });

  it('says plainly what is wrong, with the line and column', () => {
    const err = (cmd: string) => { const p = parse(cmd); if (p.errors.length) return p.errors[0]!.message; try { build(NEW + cmd); } catch (e) { return (e as Error).message; } return 'no error'; };
    expect(err('layer add s horn')).toMatch(/give the source \(classic, osc, fm, ks, sample\)/);
    expect(err('layer add s osc freq=5')).toMatch(/freq must be between 20 and 20000 Hz/);
    expect(err('layer add s osc volume=1')).toMatch(/no parameter 'volume'.*parameters: wave, freq/);
    expect(err('layer add s osc wave=triangel')).toMatch(/wave is one of sine, square/);
    expect(err('layer set s 1 gain=1')).toMatch(/no layer 1.*add one with layer add/);
    expect(err('layer add s osc\nlayer set s 2 gain=1')).toMatch(/no layer 2.*layers 1 to 1/s);
    expect(err('layer add s osc\nlayer set s 1 freq=44')).toBe('no error');
    expect(err('layer add s osc\nlayer set s 1 sample=x')).toMatch(/osc layer has no parameter 'sample'/);
    expect(err('layer add s osc\nenv s 1.dur "0:1 1:2"')).toMatch(/dur of a osc layer cannot take an envelope/);
    expect(err('layer add s osc\nenv s 1.freq "0:10 1:100"')).toMatch(/freq must be between 20 and 20000/);
    expect(err('layer add s osc\nenv s 1.amp adsr(1,2)')).toMatch(/adsr\(attack/);
    expect(err('layer add s osc\nenv s 1.freq adsr(0.1,0.1,0.5,0.1)')).toMatch(/adsr\(…\) is for amplitude/);
    expect(err('layer add s osc\nenv s 1.fx1.mix "0:1"')).toMatch(/layer 1 has no effect 1/);
    expect(err('env s freq "0:1"')).toMatch(/not an envelope target/);
    expect(err('fx add s flanger')).toMatch(/give the effect/);
    expect(err('fx add s reverb size=3')).toMatch(/size must be between 0 and 1/);
    expect(err('fx add s layer=2 reverb')).toMatch(/no layer 2/);
    expect(err('layer move s 1 to=1')).toMatch(/no layer 1/);
    expect(err('sound layer-up s')).toMatch(/layered sound; layer-up makes a classic/);
  });

  it('limits: 8 layers, 8 effects per chain, 32 breakpoints', () => {
    const many = NEW + Array.from({ length: 8 }, () => 'layer add s osc').join('\n') + '\n';
    expect(() => build(many)).not.toThrow();
    expect(() => build(many + 'layer add s osc')).toThrow(/8 layers already/);
    const fx = NEW + 'layer add s osc\n' + Array.from({ length: 8 }, () => 'fx add s layer=1 chorus').join('\n') + '\n';
    expect(() => build(fx)).not.toThrow();
    expect(() => build(fx + 'fx add s layer=1 chorus')).toThrow(/8 effects already/);
    const pts = Array.from({ length: 33 }, (_, i) => `${i}:1`).join(' ');
    expect(() => build(NEW + `layer add s osc\nenv s 1.gain "${pts}"`)).toThrow(/at most 32 breakpoints/);
  });

  it('reordering keeps each layer\'s envelopes, mute/solo decide what sounds, and the noise does not change when layers move', () => {
    const s0 = layered(NEW + 'layer add s osc wave=white dur=0.05\nlayer add s osc wave=square freq=200 dur=0.05\nenv s 1.gain "0:1 0.05:0"\n');
    const s1 = layered(NEW + 'layer add s osc wave=white dur=0.05\nlayer add s osc wave=square freq=200 dur=0.05\nenv s 1.gain "0:1 0.05:0"\nlayer move s 1 to=2\n');
    expect(s1.layers[1]!.envs.gain).toBeDefined();
    expect(Buffer.compare(Buffer.from(render(s0).buffer), Buffer.from(render(s1).buffer))).toBe(0);
    const muted = layered(NEW + 'layer add s osc wave=white dur=0.05\nlayer add s osc wave=square freq=200 dur=0.05\nlayer mute s 1\n');
    const soloed = layered(NEW + 'layer add s osc wave=white dur=0.05\nlayer add s osc wave=square freq=200 dur=0.05\nlayer solo s 2\n');
    const only2 = layered(NEW + 'layer add s osc wave=square freq=200 dur=0.05\n');
    expect(Buffer.compare(Buffer.from(render(muted).buffer), Buffer.from(render(only2).buffer))).toBe(0);
    expect(Buffer.compare(Buffer.from(render(soloed).buffer), Buffer.from(render(only2).buffer))).toBe(0);
  });

  it('layers sum, start at their offsets, and the length follows the layers (or `duration`)', () => {
    const s = layered(NEW + 'layer add s osc wave=square freq=100 dur=0.1\nlayer add s osc wave=square freq=100 dur=0.1 offset=0.2\n' + FLAT + 'env s 2.amp "0:1"\n');
    const x = render(s);
    expect(x.length).toBe(Math.round(0.3 * SAMPLE_RATE));
    expect(Math.abs(x[Math.round(0.15 * SAMPLE_RATE)]!)).toBe(0);
    expect(Math.abs(x[Math.round(0.25 * SAMPLE_RATE)]!)).toBe(1);
    expect(render(layered(NEW + 'layer add s osc dur=0.1\nsound set s duration=0.5\n')).length).toBe(22050);
    expect(render(layered(NEW + 'layer add s osc dur=0.3\nsound set s duration=0.1\n')).length).toBe(4410);
    expect(render(layered(NEW + 'layer add s osc dur=0.1 gain=0.5\nsound set s gain=0.5\n')).length).toBe(4410);
  });

  it('an automatic length ends where the sound has died away, not at the effect\'s worst-case tail', () => {
    const x = render(layered(NEW + 'layer add s osc wave=white dur=0.05 seed=1\nfx add s reverb size=1 mix=0.0003\n'));
    expect(x.length).toBeLessThan(0.05 * SAMPLE_RATE + 0.3 * SAMPLE_RATE); // the reverb may ring for 2.5 s; at this mix it is under -63 dB at once
    const a = analyze(x);
    expect(a.trailingSilence).toBeLessThan(0.01);
  });
});

describe('the harsh check', () => {
  const sineAt = (hz: number, amp: number, seconds: number, fade = 0.005): Float32Array => {
    const n = Math.round(seconds * SAMPLE_RATE);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * Math.min(1, i / (fade * SAMPLE_RATE), (n - 1 - i) / (fade * SAMPLE_RATE));
    return x;
  };
  const harsh = (x: Float32Array, style = DEFAULT_STYLE) => runChecks(x, analyze(x), style).find((c) => c.name === 'harsh')!;

  it('the band meter reads -3 dBFS for a full-scale sine inside 2-5 kHz and nothing for one outside', () => {
    const inside = harshBand(sineAt(3000, 1, 0.3));
    expect(inside.db[Math.floor(inside.db.length / 2)]).toBeCloseTo(-3.0, 0);
    const outside = harshBand(sineAt(300, 1, 0.3));
    expect(outside.db[Math.floor(outside.db.length / 2)]).toBeLessThan(-60);
  });
  it('flags a sustained 3 kHz tone and says when', () => {
    const c = harsh(sineAt(3000, 0.5, 0.4));
    expect(c.pass).toBe(false);
    expect(c.ranges).toHaveLength(1);
    expect(c.ranges[0]!.from).toBeLessThan(0.05);
    expect(c.ranges[0]!.to).toBeGreaterThan(0.35);
    expect(c.ranges[0]!.note).toMatch(/^2-5 kHz band above -20\.0 dBFS for \d+ ms$/);
    expect(c.value).toMatch(/^sustained 2-5 kHz band -?\d+\.\d dBFS, 1 stretch over$/);
  });
  it('passes the same tone when quiet, when short, or when it is elsewhere in the spectrum', () => {
    expect(harsh(sineAt(3000, 0.05, 0.4)).pass).toBe(true); // -26 dBFS RMS in band... -23 dBFS: under the limit
    expect(harsh(sineAt(3000, 0.5, 0.04)).pass).toBe(true); // 40 ms: not sustained
    expect(harsh(sineAt(300, 0.8, 0.4)).pass).toBe(true);
    expect(harsh(sineAt(8000, 0.8, 0.4)).pass).toBe(true);
  });
  it('the limit and the duration are in the project style', () => {
    const x = sineAt(3000, 0.05, 0.4);
    expect(harsh(x, { ...DEFAULT_STYLE, harshLimitDb: -30 }).pass).toBe(false);
    const short = sineAt(3000, 0.5, 0.06);
    expect(harsh(short).pass).toBe(true);
    expect(harsh(short, { ...DEFAULT_STYLE, harshMinMs: 30 }).pass).toBe(false);
  });
  it('finds two separate stretches', () => {
    const a = sineAt(3000, 0.5, 0.2), gap = new Float32Array(Math.round(0.3 * SAMPLE_RATE)), b = sineAt(4000, 0.5, 0.2);
    const x = new Float32Array(a.length + gap.length + b.length);
    x.set(a); x.set(b, a.length + gap.length);
    expect(harsh(x).ranges).toHaveLength(2);
  });
  it('works on both channels of a stereo sound (measured on their mix)', () => {
    const t = sineAt(3000, 0.5, 0.4);
    const c = runChecks([t, new Float32Array(t.length)], analyze([t, new Float32Array(t.length)])).find((k) => k.name === 'harsh')!;
    expect(c.pass).toBe(false);
  });
});

describe('sine helper still agrees with Math.sin', () => {
  it('sineCycles', () => {
    for (let c = -3; c < 3; c += 0.0137) expect(Math.abs(sineCycles(c) - Math.sin(2 * Math.PI * c))).toBeLessThan(1e-9);
  });
});
