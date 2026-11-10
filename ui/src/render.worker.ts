// A Web Worker that renders sounds with core, so the page never freezes to play one. It fetches
// the samples a sound names (once; the page's token travels with each request), keeps what it has
// rendered by the render key, and answers with the channels and the hash of their samples.

import { diffOf } from './diffspec.ts';
import { sampleKeyPart, renderParts, peaks, analyze, integratedLoudness, truePeak, fullScaleOf, joinChannels, loudnessCurve, measuredChannels, melSpectrogram, mixdown, specMax, SPEC_RANGE_DB, type PitchFrame, decodeAudio, pcmToSampleData, renderChannels, renderKey, runChecks, samplesHash, type Analysis, type CheckResult, type MelSpec, type SampleBank, type SampleData, type Sound, type Style } from '@soundclaw/core';

export interface RenderRequest {
  id: number;
  sound: Sound;
  /** The project's samples this sound names: name and the SHA-256 of the bytes (the key of what to hold). */
  samples: { name: string; sha256: string; slices?: number[]; loop?: [number, number] }[];
  token: string;
  /** `render`: the channels (to play). `measure`: the numbers, checks and spectrogram (for an editor), held to `style` (the loudness class `basis`). */
  op?: 'render' | 'measure' | 'strips' | 'lens' | 'diff' | 'cell';
  style?: Style;
  basis?: string;
  /** `strips`: columns of peaks per layer. */
  cols?: number;
  /** `diff`: the sound to compare against, and the samples it names. */
  ref?: Sound;
  refSamples?: { name: string; sha256: string; slices?: number[]; loop?: [number, number] }[];
}

/** What the analysis lenses draw, worked out in the worker from the same measuring code the CLI uses. */
export interface LensReply {
  analysis: Analysis;
  checks: CheckResult[];
  duration: number;
  peaks: StripPeaks;
  /** Loudness over time (400 ms windows), LUFS, silence floored at −70. */
  loud: { t: number[]; lufs: number[] };
  /** The mel spectrogram as bytes over the 80 dB below its loudest cell: `h` bands (lowest first) by `w` frames, frame-major. */
  spec: { w: number; h: number; data: Uint8Array; freqs: number[]; maxDb: number };
  pitch: PitchFrame[];
  hash: string;
}

/** The difference of two sounds' mel spectrograms (now minus ref), one signed byte per cell (full scale = 30 dB), and a sentence about it. */
export interface DiffReply {
  w: number;
  h: number;
  data: Int8Array;
  freqs: number[];
  duration: number;
  summary: string;
}

/** A clip-grid cell: a small waveform, the integrated loudness and the true peak of one version (no other measurement). */
export interface CellReply { peaks: StripPeaks; lufs: number | null; truePeakDb: number | null; duration: number; hash: string }

export interface MeasureReply { analysis: Analysis; checks: CheckResult[]; spec: MelSpec; hash: string }
export interface StripPeaks { min: number[]; max: number[] }
export type RenderReply =
  | { id: number; ok: true; key: string; strips: StripPeaks[]; ms: number }
  | { id: number; ok: true; key: string; channels: Float32Array[]; hash: string; ms: number }
  | { id: number; ok: true; key: string; measure: MeasureReply; ms: number }
  | { id: number; ok: true; key: string; lens: LensReply; ms: number }
  | { id: number; ok: true; key: string; diff: DiffReply; ms: number }
  | { id: number; ok: true; key: string; cell: CellReply; ms: number }
  | { id: number; ok: false; error: string };

const held = new Map<string, { sha: string; data: SampleData }>();
const fetching = new Map<string, Promise<void>>();
const renders = new Map<string, Float32Array[]>();

async function ensure(name: string, sha: string, token: string): Promise<void> {
  if (held.get(name)?.sha === sha) return;
  const k = `${name}:${sha}`;
  let p = fetching.get(k);
  if (!p) {
    p = fetch(`/api/sample-object/${sha}?token=${encodeURIComponent(token)}`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`sample ${name}: ${r.status}`))))
      .then((buf) => {
        held.set(name, { sha, data: pcmToSampleData(decodeAudio(new Uint8Array(buf), { lenient: true }).audio) });
      })
      .finally(() => fetching.delete(k));
    fetching.set(k, p);
  }
  await p;
}

self.onmessage = async (ev: MessageEvent<RenderRequest>) => {
  const q = ev.data;
  try {
    const t0 = performance.now();
    await Promise.all(q.samples.map((s) => ensure(s.name, s.sha256, q.token)));
    const metaOf = (n: string) => q.samples.find((s) => s.name === n);
    const bank: SampleBank = {
      get: (n) => {
        const data = held.get(n)?.data;
        const m = metaOf(n);
        return data && (m?.slices || m?.loop) ? { ...data, ...(m.slices ? { slices: m.slices } : {}), ...(m.loop ? { loop: m.loop } : {}) } : data;
      },
      hash: (n) => { const m = metaOf(n); const sha = held.get(n)?.sha ?? m?.sha256; return sha ? sampleKeyPart({ hash: sha, ...(m?.slices ? { slices: m.slices } : {}), ...(m?.loop ? { loop: m.loop } : {}) }) : undefined; },
    };
    const key = renderKey(q.sound, (n) => bank.hash(n) ?? 'missing');
    if (q.op === 'strips') {
      // each layer on its own, as peaks per pixel column (the layer strips of the layered editor)
      if (q.sound.voice !== 'layered') throw new Error('strips are for layered sounds');
      const strips = renderParts(q.sound, bank).parts.map((p) => {
        const mono = p.channels.length === 1 ? p.channels[0]! : Float32Array.from(p.channels[0]!, (v, k) => (v + p.channels[1]![k]!) / 2);
        const pk = peaks(mono, q.cols ?? 360);
        return { min: Array.from(pk.min), max: Array.from(pk.max) };
      });
      (self as unknown as Worker).postMessage({ id: q.id, ok: true, key, strips, ms: Math.round(performance.now() - t0) } satisfies RenderReply);
      return;
    }
    let channels = renders.get(key);
    if (!channels) {
      channels = renderChannels(q.sound, bank);
      renders.set(key, channels);
      if (renders.size > 24) renders.delete(renders.keys().next().value!);
    }
    if (q.op === 'cell') {
      const mc = measuredChannels(q.sound, channels);
      const l = integratedLoudness(mc);
      const tp = Math.max(...mc.map((c) => truePeak(c)));
      const pk = peaks(mixdown(channels), 120);
      const cell: CellReply = { peaks: { min: Array.from(pk.min), max: Array.from(pk.max) }, lufs: Number.isFinite(l) ? l : null, truePeakDb: tp > 0 ? 20 * Math.log10(tp) : null, duration: channels[0]!.length / 44100, hash: samplesHash(joinChannels(channels)) };
      (self as unknown as Worker).postMessage({ id: q.id, ok: true, key, cell, ms: Math.round(performance.now() - t0) } satisfies RenderReply);
      return;
    }
    if (q.op === 'measure') {
      const loop = q.sound.voice === 'layered' && !!q.sound.loop;
      const mc = measuredChannels(q.sound, channels); // a classic sound is measured as its exported WAV holds it
      const analysis = analyze(mc);
      const checks = runChecks(mc, analysis, q.style!, { loop, loudnessClass: q.basis!, fullScale: fullScaleOf(q.sound) });
      const x = mixdown(channels);
      const spec = melSpectrogram(x, { bands: 48, hop: Math.max(256, Math.ceil(x.length / 240)) });
      (self as unknown as Worker).postMessage({ id: q.id, ok: true, key, measure: { analysis, checks, spec, hash: samplesHash(joinChannels(channels)) }, ms: Math.round(performance.now() - t0) } satisfies RenderReply);
      return;
    }
    if (q.op === 'lens') {
      const loop = q.sound.voice === 'layered' && !!q.sound.loop;
      const mc = measuredChannels(q.sound, channels);
      const analysis = analyze(mc);
      const checks = runChecks(mc, analysis, q.style!, { loop, loudnessClass: q.basis!, fullScale: fullScaleOf(q.sound) });
      const x = mixdown(channels);
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
      const lc = loudnessCurve(mc);
      const reply: LensReply = {
        analysis, checks, duration: x.length / 44100,
        peaks: { min: Array.from(pk.min), max: Array.from(pk.max) },
        loud: { t: lc.t, lufs: lc.lufs.map((v) => (Number.isFinite(v) && v > -70 ? v : -70)) },
        spec: { w, h, data, freqs: Array.from(sp.freqs), maxDb: top },
        pitch: analysis.pitch.track, hash: samplesHash(joinChannels(channels)),
      };
      (self as unknown as Worker).postMessage({ id: q.id, ok: true, key, lens: reply, ms: Math.round(performance.now() - t0) } satisfies RenderReply);
      return;
    }
    if (q.op === 'diff') {
      await Promise.all((q.refSamples ?? []).map((s) => ensure(s.name, s.sha256, q.token)));
      const rk = renderKey(q.ref!, (n) => bank.hash(n) ?? q.refSamples?.find((s) => s.name === n)?.sha256 ?? 'missing');
      let rch = renders.get(rk);
      if (!rch) { rch = renderChannels(q.ref!, bank); renders.set(rk, rch); }
      const reply = diffOf(mixdown(channels), mixdown(rch));
      (self as unknown as Worker).postMessage({ id: q.id, ok: true, key, diff: reply, ms: Math.round(performance.now() - t0) } satisfies RenderReply);
      return;
    }
    // the page gets its own copy: the buffers are handed over, and the kept render stays whole
    const out = channels.map((c) => c.slice());
    const reply: RenderReply = { id: q.id, ok: true, key, channels: out, hash: samplesHash(joinChannels(channels)), ms: Math.round(performance.now() - t0) };
    (self as unknown as Worker).postMessage(reply, out.map((c) => c.buffer));
  } catch (e) {
    (self as unknown as Worker).postMessage({ id: q.id, ok: false, error: (e as Error).message } satisfies RenderReply);
  }
};
