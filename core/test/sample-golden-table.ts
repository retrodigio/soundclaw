// The material and scripts of the sample goldens: sounds that play samples with each interpolation and each edit a layer
// can make, and derive chains over stored audio. Everything is generated here from integers and the engine's own sine.

import { pcmFromFloats, sinRad, type PcmAudio, type SampleBank, type SampleData } from '../src/index.ts';
import { lcg } from './audio-fixtures.ts';

const TAU = 6.283185307179586;

/** A tonal note (220 Hz with two partials and a decay) and noise hits, as floats. */
export function toneFloats(rate: number, seconds: number): Float32Array {
  const n = Math.round(rate * seconds);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    x[i] = (0.5 * sinRad(TAU * 220 * t) + 0.25 * sinRad(TAU * 440 * t) + 0.12 * sinRad(TAU * 660 * t)) * (1 - 0.4 * (i / n));
  }
  return x;
}

export function hitsFloats(rate: number, seconds: number, every: number): Float32Array {
  const n = Math.round(rate * seconds);
  const x = new Float32Array(n);
  const r = lcg(11);
  const len = Math.round(0.06 * rate);
  for (let at = 0; at < n; at += Math.round(every * rate)) {
    for (let i = 0; i < len && at + i < n; i++) x[at + i] = (r() * 2 - 1) * 0.7 * (1 - i / len) * (1 - i / len);
  }
  return x;
}

export const TONE: PcmAudio = pcmFromFloats([toneFloats(44100, 1)], 44100, 'pcm16');
export const HITS: PcmAudio = pcmFromFloats([hitsFloats(22050, 2, 0.5)], 22050, 'pcm16');
const left = toneFloats(44100, 0.8);
const right = new Float32Array(left.length);
for (let i = 0; i < right.length; i++) right[i] = left[Math.max(0, i - 30)]! * 0.6;
export const WIDE: PcmAudio = pcmFromFloats([left, right], 44100, 'pcm16');

function dataOf(a: PcmAudio, extra: Partial<SampleData>): SampleData {
  const ch = (c: number): Float32Array => {
    const o = new Float32Array(a.frames);
    const v = new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength);
    for (let i = 0; i < a.frames; i++) o[i] = v.getInt16((i * a.channels + c) * 2, true) / 32768;
    return o;
  };
  const chs = Array.from({ length: a.channels }, (_, c) => ch(c));
  const mono = new Float32Array(a.frames);
  for (let i = 0; i < a.frames; i++) { let s = 0; for (const c of chs) s += c[i]!; mono[i] = s / a.channels; }
  return { rate: a.rate, data: mono, ...(a.channels >= 2 ? { left: chs[0]!, right: chs[1]! } : {}), ...extra };
}

const DATA: Record<string, SampleData> = {
  tone: dataOf(TONE, { slices: [0, 11025, 22050, 33075], loop: [8820, 35280] }),
  hits: dataOf(HITS, { slices: [0, 11025, 22050, 33075], loop: [0, 22050] }),
  wide: dataOf(WIDE, {}),
};
export const BANK: SampleBank = {
  get: (n) => DATA[n],
  hash: (n) => (DATA[n] ? `golden-${n}` : undefined),
};

const sound = (layer: string, extra = ''): string => `sound new s voice=layered seed=5\n${layer}${extra ? '\n' + extra : ''}\nsound set s duration=1.2`;

/** Sounds that play samples: script text, run against a fresh library; the sound is `s`. */
export const RENDER_TABLE: Record<string, string> = {
  'interp-linear-up': sound('layer add s sample sample=tone interp=linear pitch=7'),
  'interp-cubic-up': sound('layer add s sample sample=tone interp=cubic pitch=7'),
  'interp-sinc-up': sound('layer add s sample sample=tone interp=sinc pitch=7'),
  'interp-sinc-down': sound('layer add s sample sample=tone interp=sinc pitch=-5'),
  'interp-sinc-resampled-source': sound('layer add s sample sample=hits interp=sinc pitch=3'),
  'interp-sinc-pitch-envelope': sound('layer add s sample sample=tone interp=sinc', 'env s 1.pitch "0:0 0.5:12@ease"'),
  'edit-reverse-sinc': sound('layer add s sample sample=tone interp=sinc reverse=1'),
  'edit-slice-2': sound('layer add s sample sample=hits slice=2 interp=cubic'),
  'edit-slice-and-trim': sound('layer add s sample sample=hits slice=3 start=0.1 end=0.4 interp=linear'),
  'edit-fades': sound('layer add s sample sample=tone fade-in=0.05 fade-out=0.2 interp=linear'),
  'edit-fade-only-keeps-linear-read': sound('layer add s sample sample=tone fade-out=0.1'),
  'edit-stretch-wsola-slower': sound('layer add s sample sample=hits stretch=1.5 method=wsola interp=sinc'),
  'edit-stretch-pv-faster': sound('layer add s sample sample=tone stretch=0.75 method=pv interp=sinc'),
  'edit-stretch-and-pitch': sound('layer add s sample sample=tone stretch=1.25 pitch=-3 interp=sinc'),
  'edit-loop-points': sound('layer add s sample sample=tone loop=1.1 xfade=0.03 interp=sinc'),
  'edit-loop-whole-sample': sound('layer add s sample sample=hits loop=1.2 xfade=0 interp=linear'),
  'edit-loop-of-a-slice': sound('layer add s sample sample=hits slice=2 loop=1 xfade=0.01 interp=linear'),
  'edit-stereo-stretch': sound('layer add s sample sample=wide side=stereo stretch=1.2 method=wsola interp=sinc'),
  'edit-stereo-loop': sound('layer add s sample sample=wide side=stereo loop=1 xfade=0.02 interp=cubic'),
};

/** Derive chains over stored audio: the audio is `from` (tone, hits or wide); the golden is the derived audio's hash and settled chain. */
export const DERIVE_TABLE: Record<string, { from: 'tone' | 'hits' | 'wide'; chain: string }> = {
  trim: { from: 'tone', chain: 'trim 0.1 0.6' },
  'trim-frames-and-end': { from: 'tone', chain: 'trim 100f end' },
  'fade-curves': { from: 'tone', chain: 'fade in=30ms@exp out=0.2@ease' },
  gain: { from: 'tone', chain: 'gain -6' },
  'normalize-peak': { from: 'tone', chain: 'normalize peak -3' },
  'normalize-lufs': { from: 'hits', chain: 'normalize lufs -20' },
  'silence-trim': { from: 'hits', chain: 'trim 0.1 1.6; silence-trim -40' },
  dc: { from: 'tone', chain: 'gain -12; dc' },
  reverse: { from: 'tone', chain: 'reverse' },
  mono: { from: 'wide', chain: 'mono' },
  left: { from: 'wide', chain: 'left' },
  right: { from: 'wide', chain: 'right' },
  'pitch-resample': { from: 'tone', chain: 'pitch 5' },
  'pitch-stretch': { from: 'tone', chain: 'pitch -7 method=stretch' },
  'stretch-wsola': { from: 'hits', chain: 'stretch 1.5' },
  'stretch-pv': { from: 'tone', chain: 'stretch 0.8 method=pv' },
  'stretch-to': { from: 'tone', chain: 'stretch to=1.4 method=pv' },
  'stretch-tempo': { from: 'hits', chain: 'stretch tempo=100:120' },
  loop: { from: 'tone', chain: 'loop 0.2 0.8 xfade=50ms' },
  slice: { from: 'hits', chain: 'slice 2' },
  'mix-other': { from: 'tone', chain: 'mix hits at=0.25 gain=-6' },
  'chain-everything': { from: 'wide', chain: 'trim 0.05 0.7; fade in=10ms out=50ms; mono; normalize peak -1; reverse' },
};
