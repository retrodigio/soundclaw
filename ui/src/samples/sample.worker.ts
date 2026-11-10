// A Web Worker for the sample page: it fetches a sample's audio by its hash (immutable, so it keeps what it has), and works out what the lenses
// draw (the same measuring code the CLI uses), the seam of a loop, and the difference of two signals. The page's own thread measures nothing.

import { SPEC_RANGE_DB, analyze, decodeAudio, describeSample, loopSeam, loudnessCurve, measureSample, melSpectrogram, mixdown, pcmChannels, peaks, resample, specMax, type PcmAudio, type SampleMeasure } from '@soundclaw/core';
import { diffOf } from '../diffspec.ts';
import type { DiffReply, LensReply } from '../render.worker.ts';

/** What the page asks for. */
export type SampleReq =
  | { id: number; token: string; op: 'lens'; hash: string }
  | { id: number; token: string; op: 'diff'; hash: string; refHash?: string; refMono?: Float32Array }
  | { id: number; token: string; op: 'seam'; hash: string; start: number; end: number };

/** The lens data plus what only a sample has: its measure and the words. */
export interface SampleLensReply extends LensReply {
  measure: SampleMeasure;
  words: string[];
  rate: number;
  frames: number;
  channels: number;
}

/** A loop's seam: the audio just before the loop end joined to the audio at the loop start, and the numbers of the join. */
export interface SeamReply {
  /** Peak columns of the joined audio: `cut` is the column where the join is. */
  min: number[];
  max: number[];
  cut: number;
  /** Seconds each side of the join that are drawn. */
  side: number;
  numbers: { clickDb: number; levelStepDb: number; spectralJump: number };
}

export type SampleRes =
  | { id: number; ok: true; lens: SampleLensReply }
  | { id: number; ok: true; diff: DiffReply }
  | { id: number; ok: true; seam: SeamReply }
  | { id: number; ok: false; error: string };

const held = new Map<string, PcmAudio>();

async function audioOf(hash: string, token: string): Promise<PcmAudio> {
  const have = held.get(hash);
  if (have) return have;
  const r = await fetch(`/api/sample-object/${hash}?token=${encodeURIComponent(token)}`);
  if (!r.ok) throw new Error(`sample ${hash.slice(0, 12)}: ${r.status}`);
  const a = decodeAudio(new Uint8Array(await r.arrayBuffer()), { lenient: true }).audio;
  held.set(hash, a);
  if (held.size > 4) held.delete(held.keys().next().value!);
  return a;
}

/** The sample's channels at the engine's 44.1 kHz (the analysis and the views work there). */
const at44 = (a: PcmAudio): Float32Array[] => pcmChannels(a, 120).map((c) => (a.rate === 44100 ? c : resample(c, a.rate, 44100)));

self.onmessage = async (ev: MessageEvent<SampleReq>) => {
  const q = ev.data;
  const post = (m: SampleRes): void => (self as unknown as Worker).postMessage(m);
  try {
    const a = await audioOf(q.hash, q.token);
    if (q.op === 'lens') {
      const own = pcmChannels(a, 120);
      const measure = measureSample(own, a.rate);
      const chs = at44(a);
      const analysis = analyze(chs);
      const x = chs.length === 1 ? chs[0]! : mixdown(chs);
      const hop = Math.max(128, Math.ceil(x.length / 480));
      const sp = melSpectrogram(x, { bands: 96, hop });
      const top = specMax(sp);
      const w = sp.db.length, h = sp.freqs.length;
      const data = new Uint8Array(w * h);
      for (let f = 0; f < w; f++) for (let b = 0; b < h; b++) {
        const t = (sp.db[f]![b]! - (top - SPEC_RANGE_DB)) / SPEC_RANGE_DB;
        data[f * h + b] = Math.round(255 * (t < 0 ? 0 : t > 1 ? 1 : t));
      }
      const pk = peaks(x, 1600);
      const lc = loudnessCurve(chs);
      const reply: SampleLensReply = {
        analysis, checks: [], duration: x.length / 44100,
        peaks: { min: Array.from(pk.min), max: Array.from(pk.max) },
        loud: { t: lc.t, lufs: lc.lufs.map((v) => (Number.isFinite(v) && v > -70 ? v : -70)) },
        spec: { w, h, data, freqs: Array.from(sp.freqs), maxDb: top },
        pitch: analysis.pitch.track, hash: q.hash,
        measure, words: describeSample(measure),
        rate: a.rate, frames: a.frames, channels: a.channels,
      };
      post({ id: q.id, ok: true, lens: reply });
      return;
    }
    if (q.op === 'diff') {
      const mine = at44(a);
      const x = mine.length === 1 ? mine[0]! : mixdown(mine);
      let other: Float32Array;
      if (q.refMono) other = q.refMono;
      else if (q.refHash) {
        const r = await audioOf(q.refHash, q.token);
        const chs = at44(r);
        other = chs.length === 1 ? chs[0]! : mixdown(chs);
      } else throw new Error('nothing to compare with');
      post({ id: q.id, ok: true, diff: diffOf(x, other) });
      return;
    }
    // seam: the sample's own rate, the mono mix, the loop in frames
    const own = pcmChannels(a, 120);
    const x = own.length === 1 ? own[0]! : mixdown(own);
    if (!(q.start >= 0 && q.end > q.start && q.end <= x.length)) throw new Error('the loop must lie inside the sample');
    const side = Math.min(0.05, (q.end - q.start) / a.rate / 2);
    const n = Math.max(2, Math.round(side * a.rate));
    const joined = new Float32Array(2 * n);
    joined.set(x.subarray(Math.max(0, q.end - n), q.end), n - Math.min(n, q.end));
    joined.set(x.subarray(q.start, Math.min(x.length, q.start + n)), n);
    const pk = peaks(joined, 400);
    const sm = loopSeam(x, a.rate, q.start, q.end);
    post({ id: q.id, ok: true, seam: { min: Array.from(pk.min), max: Array.from(pk.max), cut: 200, side, numbers: { clickDb: sm.clickDb, levelStepDb: sm.levelStepDb, spectralJump: sm.spectralJump } } });
  } catch (e) {
    post({ id: q.id, ok: false, error: (e as Error).message });
  }
};
