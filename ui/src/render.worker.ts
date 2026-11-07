// A Web Worker that renders sounds with core, so the page never freezes to play one. It fetches
// the samples a sound names (once; the page's token travels with each request), keeps what it has
// rendered by the render key, and answers with the channels and the hash of their samples.

import { renderParts, peaks, analyze, fullScaleOf, joinChannels, measuredChannels, melSpectrogram, mixdown, readSampleWav, renderChannels, renderKey, runChecks, samplesHash, type Analysis, type CheckResult, type MelSpec, type SampleBank, type SampleData, type Sound, type Style } from '@soundclaw/core';

export interface RenderRequest {
  id: number;
  sound: Sound;
  /** The project's samples this sound names: name and the SHA-256 of the bytes (the key of what to hold). */
  samples: { name: string; sha256: string }[];
  token: string;
  /** `render`: the channels (to play). `measure`: the numbers, checks and spectrogram (for an editor), held to `style` (the loudness class `basis`). */
  op?: 'render' | 'measure' | 'strips';
  style?: Style;
  basis?: string;
}

export interface MeasureReply { analysis: Analysis; checks: CheckResult[]; spec: MelSpec; hash: string }
export interface StripPeaks { min: number[]; max: number[] }
export type RenderReply =
  | { id: number; ok: true; key: string; strips: StripPeaks[]; ms: number }
  | { id: number; ok: true; key: string; channels: Float32Array[]; hash: string; ms: number }
  | { id: number; ok: true; key: string; measure: MeasureReply; ms: number }
  | { id: number; ok: false; error: string };

const held = new Map<string, { sha: string; data: SampleData }>();
const fetching = new Map<string, Promise<void>>();
const renders = new Map<string, Float32Array[]>();

async function ensure(name: string, sha: string, token: string): Promise<void> {
  if (held.get(name)?.sha === sha) return;
  const k = `${name}:${sha}`;
  let p = fetching.get(k);
  if (!p) {
    p = fetch(`/api/samples/${name}.wav?token=${encodeURIComponent(token)}`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`sample ${name}: ${r.status}`))))
      .then((buf) => {
        const w = readSampleWav(new Uint8Array(buf));
        held.set(name, { sha, data: { rate: w.rate, data: w.data, ...(w.left && w.right ? { left: w.left, right: w.right } : {}) } });
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
    const bank: SampleBank = {
      get: (n) => held.get(n)?.data,
      hash: (n) => held.get(n)?.sha ?? q.samples.find((s) => s.name === n)?.sha256,
    };
    const key = renderKey(q.sound, (n) => bank.hash(n) ?? 'missing');
    if (q.op === 'strips') {
      // each layer on its own, as peaks per pixel column (the layer strips of the layered editor)
      if (q.sound.voice !== 'layered') throw new Error('strips are for layered sounds');
      const strips = renderParts(q.sound, bank).parts.map((p) => {
        const mono = p.channels.length === 1 ? p.channels[0]! : Float32Array.from(p.channels[0]!, (v, k) => (v + p.channels[1]![k]!) / 2);
        const pk = peaks(mono, 360);
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
    // the page gets its own copy: the buffers are handed over, and the kept render stays whole
    const out = channels.map((c) => c.slice());
    const reply: RenderReply = { id: q.id, ok: true, key, channels: out, hash: samplesHash(joinChannels(channels)), ms: Math.round(performance.now() - t0) };
    (self as unknown as Worker).postMessage(reply, out.map((c) => c.buffer));
  } catch (e) {
    (self as unknown as Worker).postMessage({ id: q.id, ok: false, error: (e as Error).message } satisfies RenderReply);
  }
};
