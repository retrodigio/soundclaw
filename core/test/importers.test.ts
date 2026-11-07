// Importing jsfxr (base58, URL, JSON) and bfxr strings into the classic voice. The jsfxr strings are
// real: made by jsfxr's own encoder (sfxr.b58encode) from the parameters named beside them.

import { describe, expect, it } from 'vitest';
import {
  b58decode, b58encode, formatPatchNamed, importBfxr, importJsfxr, looksLikeJsfxr, makePatch, renderClassic, samplesHash, shortest32, splitRows, BFXR_PARAMS, ImportError, JSFXR_PARAMS,
} from '../src/index.ts';

// sfxr.b58encode({ wave_type: 1, p_env_sustain: 0.25, p_env_punch: 0.4, p_env_decay: 0.3, p_base_freq: 0.55, p_freq_limit: 0.1, p_freq_ramp: -0.3, p_arp_mod: 0.35, p_arp_speed: 0.6, p_duty: 0.2, p_duty_ramp: 0.1 })
const SAW = '34T6PkicSdTR6Xme4WVHVpfGPiSxgrS6pLxiVg6Ws3XTheFfAeNNbf4R9zKEMwhP4VweyAeNArmeK2jNTUqa8zWAXyyidedzeXvK85THZC5B6eBVP7RobsAvB';
// sfxr.b58encode({ wave_type: 0, p_env_sustain: 0.1, p_env_decay: 0.4, p_base_freq: 0.3 }): wave type 0 is a zero byte, written as a leading "1"
const SQUARE = '11111Fc13SajJH62jNe2k3ctPhzkXNYtK16FBV33LAVw7Df46Vas3d7M1XjJEWdoMSJ2cF9JijnogukyoRpEWtFPfVTJHMezGnkBy9Bz8GwwGvnprF9iQFDh';
// sfxr.b58encode({ wave_type: 2, p_env_attack: 0.1, p_env_sustain: 0.4, p_env_decay: 0.5, p_base_freq: 0.35, p_vib_strength: 0.4, p_vib_speed: 0.5, p_pha_offset: -0.3, p_pha_ramp: 0.2, p_lpf_freq: 0.6, p_lpf_ramp: -0.1, p_lpf_resonance: 0.3, p_hpf_freq: 0.1, p_hpf_ramp: 0.05 })
const SINE = '6mTfHY19EFfvUE51fWSDipECjXcKHzFPcuLMyWMME1Nk8KYib1M5FfUfhQSczLzEsQbSg1Sgjg4DdoC88i5nGw1hroBkykejJ7E5P89Z4SmRVLuKTPcu8Lvr8';

const near = (a: number, b: number): void => expect(Math.abs(a - b)).toBeLessThan(1e-6);

describe('base58', () => {
  it('round-trips bytes, with the leading zero bytes jsfxr writes as 1s', () => {
    for (const s of [SAW, SQUARE, SINE]) expect(b58encode(b58decode(s)!)).toBe(s);
    expect(b58decode(SQUARE)![0]).toBe(0);
    expect(b58decode(SAW)!.length).toBe(89);
    expect(b58decode('0OIl')).toBeNull();
  });
});

describe('jsfxr strings', () => {
  it('map every parameter by name to the classic voice, volume from sound_vol 0.5, exact', () => {
    const r = importJsfxr(SAW, 'saw');
    expect(r.form).toBe('jsfxr base58');
    expect(r.exact).toBe(true);
    const p = r.patch;
    expect([p.wave, p.attack, p.vibratoDelay]).toEqual([1, 0, 0]);
    near(p.sustain, 0.25); near(p.punch, 0.4); near(p.decay, 0.3); near(p.freq, 0.55); near(p.minFreq, 0.1); near(p.slide, -0.3);
    near(p.changeAmount, 0.35); near(p.changeSpeed, 0.6); near(p.duty, 0.2); near(p.dutySweep, 0.1);
    near(p.volume, Math.exp(0.5) - 1);
    expect(p.lowPass).toBe(1);
    expect(r.notes.join()).toMatch(/no volume/);
  });
  it('read the values as the string holds them: the shortest decimal for each float32', () => {
    expect(shortest32(Math.fround(0.3))).toBe(0.3);
    expect(shortest32(Math.fround(0.55))).toBe(0.55);
    expect(shortest32(Math.fround(-0.3))).toBe(-0.3);
    expect(importJsfxr(SQUARE, 'sq').patch.freq).toBe(0.29999998); // jsfxr's encoder truncates 0.3 to the float32 below it
    const sine = importJsfxr(SINE, 'sn').patch;
    near(sine.vibratoDepth, 0.4); near(sine.phaserOffset, -0.3); near(sine.lowPassSweep, -0.1); near(sine.highPassSweep, 0.05); near(sine.resonance, 0.3);
    expect(sine.wave).toBe(2);
  });
  it('are sample-exact: the imported sound renders as the patch of those values, and the URL and JSON forms give the same sound', () => {
    const r = importJsfxr(SQUARE, 'sq');
    const direct = makePatch({ wave: 0, sustain: 0.099999994, decay: 0.39999998, freq: 0.29999998, volume: Math.min(1, Number((Math.exp(0.5) - 1).toPrecision(6))) });
    expect(formatPatchNamed(r.patch)).toBe(formatPatchNamed(direct));
    expect(samplesHash(renderClassic(r.patch))).toBe(samplesHash(renderClassic(direct)));
    const url = importJsfxr(`https://sfxr.me/#${SQUARE}`, 'sq');
    const hash = importJsfxr(`#${SQUARE}`, 'sq');
    expect(formatPatchNamed(url.patch)).toBe(formatPatchNamed(r.patch));
    expect(formatPatchNamed(hash.patch)).toBe(formatPatchNamed(r.patch));
    const json = importJsfxr(JSON.stringify({ oldParams: true, wave_type: 0, p_env_sustain: 0.099999994, p_env_decay: 0.39999998, p_base_freq: 0.29999998, sound_vol: 0.5, sample_rate: 44100, sample_size: 8 }), 'sq');
    expect(samplesHash(renderClassic(json.patch))).toBe(samplesHash(renderClassic(r.patch)));
    expect(json.notes.some((n) => /sample_size 8/.test(n))).toBe(true);
  });
  it('use sound_vol from JSON (volume = exp(sound_vol) - 1, at most 1) and say when it is louder than the classic volume goes', () => {
    near(importJsfxr('{"wave_type":2,"sound_vol":0.25}', 'v').patch.volume, Math.exp(0.25) - 1);
    const loud = importJsfxr('{"sound_vol":1}', 'v');
    expect(loud.patch.volume).toBe(1);
    expect(loud.notes.join()).toMatch(/louder than the classic volume goes/);
  });
  it('refuse what is not a jsfxr string, saying why', () => {
    expect(() => importJsfxr('34T6Pkic', 'x')).toThrow(/decodes to \d+ bytes, jsfxr's hold 89/);
    expect(() => importJsfxr('0000', 'x')).toThrow(/base58 uses/);
    expect(() => importJsfxr('{"wave_type": 7}', 'x')).toThrow(/four waves/);
    expect(() => importJsfxr('{nope', 'x')).toThrow(ImportError);
    expect(() => importJsfxr('{"p_env_attack": "a"}', 'x')).toThrow(/must be a number/);
  });
  it('notice a jsfxr string among other texts', () => {
    expect(looksLikeJsfxr(SAW)).toBe(true);
    expect(looksLikeJsfxr(`https://sfxr.me/#${SAW}`)).toBe(true);
    expect(looksLikeJsfxr('{"wave_type":0}')).toBe(true);
    expect(looksLikeJsfxr('0,0.1,0.3,0,0.4')).toBe(false);
    expect(JSFXR_PARAMS).toHaveLength(23);
  });
});

/** A bfxr settings string from named values (the rest 0, or 0.5 for the volume, 1 for the low-pass), in bfxr's order. */
function bfxr(v: Record<string, number>): string {
  const d: Record<string, number> = { masterVolume: 0.5, lpFilterCutoff: 1 };
  return BFXR_PARAMS.map((n) => String(v[n] ?? d[n] ?? 0)).join(',');
}

describe('bfxr strings', () => {
  it('map by name when Bfxr has nothing extra set: exact, volume = masterVolume squared', () => {
    const r = importBfxr(bfxr({ waveType: 1, masterVolume: 0.6, attackTime: 0.05, sustainTime: 0.3, sustainPunch: 0.2, decayTime: 0.4, startFrequency: 0.35, minFrequency: 0.1, slide: -0.2, squareDuty: 0.3, flangerOffset: 0.1, lpFilterCutoff: 0.8 }), 'b');
    expect(r.exact).toBe(true);
    expect(r.notes).toEqual([]);
    expect(r.patch).toMatchObject({ wave: 1, attack: 0.05, sustain: 0.3, punch: 0.2, decay: 0.4, freq: 0.35, minFreq: 0.1, slide: -0.2, duty: 0.3, phaserOffset: 0.1, lowPass: 0.8 });
    near(r.patch.volume, 0.36);
    expect(samplesHash(renderClassic(r.patch))).toBe(samplesHash(renderClassic(makePatch({ wave: 1, attack: 0.05, sustain: 0.3, punch: 0.2, decay: 0.4, freq: 0.35, minFreq: 0.1, slide: -0.2, duty: 0.3, phaserOffset: 0.1, lowPass: 0.8, volume: 0.36 }))));
  });
  it('read the empty fields Bfxr writes as zero', () => {
    const text = bfxr({ waveType: 3, startFrequency: 0.4 }).split(',').map((x) => (x === '0' ? '' : x)).join(',');
    expect(importBfxr(text, 'b').patch).toMatchObject({ wave: 3, freq: 0.4, attack: 0, sustain: 0 === 0 ? 0.01 : 0 });
  });
  it('approximate what the classic voice lacks and list it: compression, harmonics, bit crush, the extra waves', () => {
    const r = importBfxr(bfxr({ waveType: 4, compressionAmount: 0.3, overtones: 0.2, bitCrush: 0.5, changeAmount2: 0.1, startFrequency: 0.3 }), 'b');
    expect(r.exact).toBe(false);
    const notes = r.notes.join('\n');
    expect(notes).toMatch(/wave triangle has no classic equivalent: sine is the nearest/);
    expect(notes).toMatch(/compressionAmount 0.3 not reproduced/);
    expect(notes).toMatch(/overtones 0.2 not reproduced/);
    expect(notes).toMatch(/bitCrush 0.5 not reproduced/);
    expect(notes).toMatch(/changeAmount2 0.1 not reproduced/);
    expect(r.patch.wave).toBe(2);
    expect(importBfxr(bfxr({ waveType: 5 }), 'b').patch.wave).toBe(3);
  });
  it('refuse a string that is too short, not numbers, or an unknown wave', () => {
    expect(() => importBfxr('1,2,3', 'b')).toThrow(/has 3 values, Bfxr's settings string has 32/);
    expect(() => importBfxr(bfxr({}).replace('0.5', 'x'), 'b')).toThrow(/masterVolume: 'x' is not a number/);
    expect(() => importBfxr(bfxr({ waveType: 20 }), 'b')).toThrow(/not one of Bfxr's waves/);
  });
});

describe('several strings', () => {
  it('are one per line, each `<id> <string>` or `<id>: <string>`, with comments skipped', () => {
    const rows = splitRows(`# sounds\nzap ${SAW}\nboom: ${SQUARE}\n\n${SINE}\n`);
    expect(rows.map((r) => r.id)).toEqual(['zap', 'boom', null]);
    expect(rows[0]!.body).toBe(SAW);
    expect(splitRows('{"wave_type":1}')).toEqual([{ id: null, body: '{"wave_type":1}' }]);
    expect(splitRows('hit {"wave_type":1}')[0]).toEqual({ id: 'hit', body: '{"wave_type":1}' });
  });
});
