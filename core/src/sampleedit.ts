// Editing a sample: `sample derive <new> from=<name> op="<chain>"` makes new audio from stored audio by a chain of
// deterministic operations. The chain is first *settled*: every measured or relative value (a silence threshold,
// a loudness target, a duration) becomes plain numbers, in frames where a position is meant, and the settled text is
// what goes on the tape (`ops=`), so replay recomputes from numbers and measures nothing. The operations run on
// floats (single precision between steps) with the renderer's rules: no platform maths, a fixed order.
//
//   trim <start> <end>            keep a part (a time, `<n>ms`, `<n>f` frames; `end` is the end)
//   fade in=<t>[@curve] out=<t>[@curve]    curve: lin (default), exp, ease
//   gain <dB>
//   normalize peak <dB> | normalize lufs <target>      settled as `gain <dB>`
//   silence-trim <dB>             settled as `trim <a>f <b>f`
//   dc                            a one-pole 10 Hz high-pass
//   reverse
//   mono | left | right
//   pitch <semitones> [method=resample|stretch]
//   stretch <ratio> | to=<seconds> | tempo=<from>:<to> [method=wsola|pv]      settled as `stretch <ratio> method=…`
//   loop <start> <end> [xfade=<t>]     a loop made seamless by a crossfade; the result carries the loop points
//   slice <n>                     the n-th slice of the parent (its slice points); settled as `trim`; first in the chain
//   mix <sample> [at=<t>] [gain=<dB>]   add another sample; settled as `mix hash:<h> at=<n>f gain=<dB>`

import { exp2 } from './mathx.ts';
import { integratedLoudness } from './analysis.ts';
import { pcmChannels } from './sampleears.ts';
import { pcmFromFloats, type PcmAudio } from './pcm.ts';
import { resample } from './resample.ts';
import { pitchShift, stretchChannels } from './stretch.ts';

/** What a chain can look at besides the audio it works on. */
export interface DeriveContext {
  /** The parent's slice points (frames at its rate), for `slice <n>`. */
  slices?: readonly number[];
  /** Another sample by name (for `mix`): its hash and audio. */
  byName?(name: string): { hash: string; audio: PcmAudio } | undefined;
  /** Audio by hash (for a settled `mix hash:…`). */
  byHash?(hash: string): PcmAudio | undefined;
}

export interface DeriveResult {
  audio: PcmAudio;
  /** The chain with everything measured or relative written as numbers. */
  settled: string;
  /** The hashes of the other audio the chain used (`mix`), in order of use. */
  mixed: string[];
  /** Loop points (frames) a `loop` operation made. */
  loop?: [number, number];
}

const LOG2_10_OVER_20 = 0.16609640474436813;
const dbGain = (db: number): number => exp2(db * LOG2_10_OVER_20);
/** Numbers in a settled chain: enough digits to read back the same double. */
const fmt = (n: number): string => String(n);

class ChainError extends Error {}
const bad = (m: string): never => { throw new ChainError(m); };

interface State {
  chs: Float32Array[];
  rate: number;
  loop?: [number, number];
}

const num = (s: string | undefined, what: string): number => {
  if (s === undefined || !/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return bad(`${what}: a number (got '${s ?? ''}')`);
  return Number(s);
};

/** A position: seconds (`0.5`, `0.5s`), `250ms`, `1234f` (frames) or `end`. Frames out. */
function frames(s: string | undefined, rate: number, len: number, what: string): number {
  if (s === undefined) return bad(`${what}: give a time (seconds, 250ms, 1234f or end)`);
  if (s === 'end') return len;
  let m = /^(\d+)f$/.exec(s);
  if (m) return Number(m[1]);
  m = /^(-?(?:\d+\.?\d*|\.\d+))(ms|s)?$/.exec(s);
  if (!m) return bad(`${what}: '${s}' is not a time (seconds, 250ms, 1234f or end)`);
  const t = Number(m[1]) / (m[2] === 'ms' ? 1000 : 1);
  return Math.round(t * rate);
}

/** A duration in frames, never negative. */
const dur = (s: string | undefined, rate: number, what: string): number => {
  const n = frames(s, rate, 0, what);
  return n < 0 ? bad(`${what}: not negative`) : n;
};

function curveOf(w: string | undefined, rate: number, what: string): { n: number; curve: string } {
  if (w === undefined) return { n: 0, curve: 'lin' };
  const [t, c = 'lin'] = w.split('@');
  if (!['lin', 'exp', 'ease'].includes(c)) bad(`${what}: the curve is lin, exp or ease (got '${c}')`);
  return { n: dur(t, rate, what), curve: c };
}

/** The rising gain of a fade at 0..1. */
function fadeShape(u: number, curve: string): number {
  if (curve === 'exp') return (exp2(8 * u) - 1) / 255;
  if (curve === 'ease') return u * u * (3 - 2 * u);
  return u;
}

const len = (st: State): number => st.chs[0]!.length;

function opWords(op: string): string[] {
  return op.trim().split(/\s+/).filter(Boolean);
}

/** Split a chain into its operations (separated by `;`). */
export function chainOps(chain: string): string[] {
  return chain.split(';').map((x) => x.trim()).filter(Boolean);
}

/** Take `key=value` words out of a list (the rest are positional). */
function keyed(words: string[]): { pos: string[]; kv: Map<string, string> } {
  const pos: string[] = [];
  const kv = new Map<string, string>();
  for (const w of words) {
    const m = /^([a-z-]+)=(.*)$/.exec(w);
    if (m) kv.set(m[1]!, m[2]!); else pos.push(w);
  }
  return { pos, kv };
}

function loudness44(st: State): number {
  const mono = st.chs.length > 2 ? st.chs.slice(0, 2) : st.chs;
  return integratedLoudness(mono.map((c) => resample(c, st.rate, 44100)));
}

const peakOf = (chs: readonly Float32Array[]): number => {
  let p = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]!); if (a > p) p = a; }
  return p;
};

/** One operation: settle it (to its plain-number text) against the audio so far. */
function settle(op: string, st: State, cx: DeriveContext, first: boolean): string {
  const [name, ...rest] = opWords(op);
  const { pos, kv } = keyed(rest);
  const n = len(st);
  const rate = st.rate;
  const only = (...keys: string[]): void => { for (const k of kv.keys()) if (!keys.includes(k)) bad(`${name}: no option '${k}'${keys.length ? ` (options: ${keys.join(', ')})` : ''}`); };
  switch (name) {
    case 'trim': {
      only();
      if (pos.length !== 2) bad('trim <start> <end>');
      const a = frames(pos[0], rate, n, 'trim start');
      const b = frames(pos[1], rate, n, 'trim end');
      if (a < 0 || b > n || b - a < 2) bad(`trim ${a}f ${b}f: the part must lie inside the sample (${n} frames) and be at least 2 frames`);
      return `trim ${a}f ${b}f`;
    }
    case 'fade': {
      only('in', 'out');
      if (pos.length || !kv.size) bad('fade in=<t>[@curve] out=<t>[@curve]');
      const fi = curveOf(kv.get('in'), rate, 'fade in');
      const fo = curveOf(kv.get('out'), rate, 'fade out');
      if (fi.n > n || fo.n > n) bad(`fade: longer than the sample (${n} frames)`);
      return `fade${kv.has('in') ? ` in=${fi.n}f${fi.curve === 'lin' ? '' : '@' + fi.curve}` : ''}${kv.has('out') ? ` out=${fo.n}f${fo.curve === 'lin' ? '' : '@' + fo.curve}` : ''}`;
    }
    case 'gain': {
      only();
      if (pos.length !== 1) bad('gain <dB>');
      return `gain ${fmt(num(pos[0], 'gain'))}`;
    }
    case 'normalize': {
      only();
      const [kind, v] = pos;
      if (kind === 'peak') {
        const target = num(v, 'normalize peak target (dBFS)');
        const p = peakOf(st.chs);
        if (p === 0) bad('normalize peak: the sample is silent');
        return `gain ${fmt(Math.round((target - 20 * Math.log10(p)) * 1e4) / 1e4)}`;
      }
      if (kind === 'lufs') {
        const target = num(v, 'normalize lufs target');
        const l = loudness44(st);
        if (!Number.isFinite(l)) bad('normalize lufs: the sample is silent');
        return `gain ${fmt(Math.round((target - l) * 1e4) / 1e4)}`;
      }
      return bad('normalize peak <dBFS> | normalize lufs <target>');
    }
    case 'silence-trim': {
      only();
      if (pos.length !== 1) bad('silence-trim <dBFS threshold, like -50>');
      const thr = dbGain(num(pos[0], 'silence-trim threshold'));
      let a = 0;
      let b = n;
      const loud = (i: number): boolean => st.chs.some((c) => Math.abs(c[i]!) > thr);
      while (a < n && !loud(a)) a++;
      if (a >= n) bad(`silence-trim ${pos[0]}: nothing in the sample is above ${pos[0]} dBFS`);
      while (b > a && !loud(b - 1)) b--;
      return `trim ${a}f ${Math.max(b, a + 2)}f`;
    }
    case 'dc': case 'reverse': case 'mono': case 'left': case 'right':
      only();
      if (pos.length) bad(`${name} takes no arguments`);
      if ((name === 'left' || name === 'right') && st.chs.length < 2) bad(`${name}: the sample has one channel`);
      return name;
    case 'pitch': {
      only('method');
      if (pos.length !== 1) bad('pitch <semitones> [method=resample|stretch]');
      const s = num(pos[0], 'pitch semitones');
      if (Math.abs(s) > 48) bad('pitch: -48 to 48 semitones');
      const method = kv.get('method') ?? 'resample';
      if (method !== 'resample' && method !== 'stretch') bad(`pitch: method is resample or stretch (got '${method}')`);
      return `pitch ${fmt(s)} method=${method}`;
    }
    case 'stretch': {
      only('to', 'tempo', 'method');
      const method = kv.get('method') ?? 'wsola';
      if (method !== 'wsola' && method !== 'pv') bad(`stretch: method is wsola or pv (got '${method}')`);
      let ratio: number;
      if (kv.has('to')) {
        if (pos.length) bad('stretch to=<seconds>');
        const target = Math.round(num(kv.get('to'), 'stretch to') * rate);
        if (target < 2) bad('stretch to=: too short');
        ratio = target / n;
      } else if (kv.has('tempo')) {
        if (pos.length) bad('stretch tempo=<from>:<to>');
        const m = /^([\d.]+):([\d.]+)$/.exec(kv.get('tempo')!);
        if (!m || Number(m[1]) <= 0 || Number(m[2]) <= 0) return bad('stretch tempo=<from bpm>:<to bpm>');
        ratio = Number(m[1]) / Number(m[2]);
      } else {
        if (pos.length !== 1) bad('stretch <ratio> | stretch to=<seconds> | stretch tempo=<from>:<to>');
        ratio = num(pos[0], 'stretch ratio');
      }
      if (!(ratio >= 0.25 && ratio <= 4)) bad(`stretch: the ratio is 0.25 to 4 (got ${fmt(ratio)})`);
      return `stretch ${fmt(ratio)} method=${method}`;
    }
    case 'loop': {
      only('xfade');
      if (pos.length !== 2) bad('loop <start> <end> [xfade=<t>]');
      const a = frames(pos[0], rate, n, 'loop start');
      const b = frames(pos[1], rate, n, 'loop end');
      if (a < 0 || b > n || b - a < 4) bad(`loop ${a}f ${b}f: the loop must lie inside the sample (${n} frames) and be at least 4 frames`);
      const xf = Math.min(kv.has('xfade') ? dur(kv.get('xfade'), rate, 'loop xfade') : 0, Math.floor((b - a) / 2));
      return `loop ${a}f ${b}f xfade=${xf}f`;
    }
    case 'slice': {
      only();
      if (!first) bad('slice <n> comes first in a chain (slice points belong to the parent as it is)');
      const k = Math.round(num(pos[0], 'slice number'));
      const pts = cx.slices ?? [];
      if (!pts.length) bad('slice: the sample has no slice points (sample slice <name> at=onsets)');
      if (k < 1 || k > pts.length) bad(`slice ${k}: the sample has ${pts.length} slices (1-${pts.length})`);
      const a = pts[k - 1]!;
      const b = k < pts.length ? pts[k]! : n;
      if (b - a < 2) bad(`slice ${k} is empty`);
      return `trim ${a}f ${Math.min(b, n)}f`;
    }
    case 'mix': {
      only('at', 'gain');
      if (pos.length !== 1) bad('mix <sample> [at=<t>] [gain=<dB>]');
      let hash: string;
      const h = /^hash:([0-9a-f]{64})$/.exec(pos[0]!);
      if (h) hash = h[1]!;
      else {
        const other = cx.byName?.(pos[0]!);
        if (!other) return bad(`mix: no sample '${pos[0]}'`);
        hash = other.hash;
      }
      const at = kv.has('at') ? frames(kv.get('at'), rate, n, 'mix at') : 0;
      if (at < 0) bad('mix at= is not negative');
      return `mix hash:${hash} at=${at}f gain=${fmt(kv.has('gain') ? num(kv.get('gain'), 'mix gain') : 0)}`;
    }
    default:
      return bad(`unknown operation '${name}' (trim, fade, gain, normalize, silence-trim, dc, reverse, mono, left, right, pitch, stretch, loop, slice, mix)`);
  }
}

/** Run one settled operation. */
function run(settled: string, st: State, cx: DeriveContext, mixed: string[]): State {
  const [name, ...rest] = opWords(settled);
  const { pos, kv } = keyed(rest);
  const n = len(st);
  const rate = st.rate;
  const f = (s: string | undefined): number => Number((s ?? '0').replace(/f$/, ''));
  switch (name) {
    case 'trim': {
      const a = f(pos[0]);
      const b = f(pos[1]);
      if (a < 0 || b > n || b - a < 2) bad(`trim ${a}f ${b}f is outside the sample (${n} frames)`);
      return { chs: st.chs.map((c) => c.slice(a, b)), rate };
    }
    case 'fade': {
      const chs = st.chs.map((c) => c.slice());
      for (const side of ['in', 'out'] as const) {
        const w = kv.get(side);
        if (!w) continue;
        const [t, curve = 'lin'] = w.split('@');
        const k = Math.min(f(t), n);
        for (const c of chs) {
          for (let i = 0; i < k; i++) {
            const g = fadeShape((i + 0.5) / k, curve);
            const j = side === 'in' ? i : n - 1 - i;
            c[j] = c[j]! * g;
          }
        }
      }
      return { chs, rate };
    }
    case 'gain': {
      const g = dbGain(Number(pos[0]));
      return { chs: st.chs.map((c) => c.map((x) => x * g)), rate };
    }
    case 'dc': {
      // y[i] = x[i] - x[i-1] + R y[i-1]; R from a 10 Hz corner: 1 - 2π·10/rate
      const R = 1 - (6.283185307179586 * 10) / rate;
      return {
        chs: st.chs.map((c) => {
          const o = new Float32Array(c.length);
          let xp = 0;
          let yp = 0;
          for (let i = 0; i < c.length; i++) { const x = c[i]!; yp = x - xp + R * yp; xp = x; o[i] = yp; }
          return o;
        }),
        rate,
      };
    }
    case 'reverse': return { chs: st.chs.map((c) => c.slice().reverse()), rate };
    case 'mono': {
      if (st.chs.length === 1) return st;
      const o = new Float32Array(n);
      for (let i = 0; i < n; i++) { let s = 0; for (const c of st.chs) s += c[i]!; o[i] = s / st.chs.length; }
      return { chs: [o], rate };
    }
    case 'left': return { chs: [st.chs[0]!], rate };
    case 'right': return { chs: [st.chs[1]!], rate };
    case 'pitch': {
      const semis = Number(pos[0]);
      return { chs: st.chs.map((c) => pitchShift(c, semis, rate, kv.get('method') === 'stretch' ? 'stretch' : 'resample')), rate };
    }
    case 'stretch': {
      const ratio = Number(pos[0]);
      return { chs: stretchChannels(st.chs, ratio, rate, kv.get('method') === 'pv' ? 'pv' : 'wsola'), rate };
    }
    case 'loop': {
      const a = f(pos[0]);
      const b = f(pos[1]);
      const xf = f(kv.get('xfade'));
      const m = b - a;
      // the last xf frames become a blend of the tail into the head, so playing round from the end to frame xf is continuous
      const chs = st.chs.map((c) => {
        const o = c.slice(a, b);
        for (let j = 0; j < xf; j++) {
          const t = (j + 0.5) / xf;
          o[m - xf + j] = c[b - xf + j]! * Math.sqrt(1 - t) + c[a + j]! * Math.sqrt(t);
        }
        return o;
      });
      return { chs, rate, loop: [xf, m] };
    }
    case 'mix': {
      const hash = /^hash:([0-9a-f]{64})$/.exec(pos[0]!)![1]!;
      const other = cx.byHash?.(hash);
      if (!other) return bad(`mix: the audio ${hash.slice(0, 12)} is not in the store`);
      mixed.push(hash);
      const at = f(kv.get('at'));
      const g = dbGain(Number(kv.get('gain') ?? '0'));
      const och = pcmChannels(other).map((c) => resample(c, other.rate, rate));
      const total = Math.max(n, at + och[0]!.length);
      const chs = st.chs.map((c, ci) => {
        const o = new Float32Array(total);
        o.set(c);
        const src = st.chs.length === 1 ? null : och[Math.min(ci, och.length - 1)]!;
        for (let i = 0; i < och[0]!.length; i++) {
          let x: number;
          if (src) x = src[i]!;
          else { let s = 0; for (const oc of och) s += oc[i]!; x = s / och.length; }
          o[at + i] = o[at + i]! + x * g;
        }
        return o;
      });
      return { chs, rate };
    }
    default: return bad(`unknown operation '${name}'`);
  }
}

/** Apply a chain to audio. The result is stored as 32-bit float at the parent's rate. Throws a plain Error naming the operation that failed. */
export function deriveAudio(parent: PcmAudio, chain: string, cx: DeriveContext = {}): DeriveResult {
  const ops = chainOps(chain);
  if (!ops.length) throw new Error('give the operations to apply, like op="trim 0.1 0.9; fade out=50ms"');
  if (ops.length > 32) throw new Error('a chain has at most 32 operations');
  let st: State = { chs: pcmChannels(parent, Infinity), rate: parent.rate };
  const settled: string[] = [];
  const mixed: string[] = [];
  for (const [i, op] of ops.entries()) {
    try {
      const s = settle(op, st, cx, i === 0);
      settled.push(s);
      st = run(s, st, cx, mixed);
    } catch (e) {
      if (e instanceof ChainError) throw new Error(`operation ${i + 1} (${op}): ${e.message}`);
      throw e;
    }
    if (len(st) < 2) throw new Error(`operation ${i + 1} (${op}) leaves no audio`);
    if (len(st) / st.rate > 600) throw new Error(`operation ${i + 1} (${op}) makes the sample longer than 600 s`);
  }
  const audio = pcmFromFloats(st.chs, st.rate, 'f32');
  return { audio, settled: settled.join('; '), mixed, ...(st.loop ? { loop: st.loop } : {}) };
}
