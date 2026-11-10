// The difference of two mono signals' mel spectrograms (a minus b), as the Compare lens draws it, and a sentence about it.
// Shared by the render worker (a sound against another) and the sample worker (a sample against another).

import { SPEC_RANGE_DB, melSpectrogram, specMax, type MelSpec } from '@soundclaw/core';
import type { DiffReply } from './render.worker.ts';

/** Both signals at 44.1 kHz. */
export function diffOf(a: Float32Array, b: Float32Array): DiffReply {
  const len = Math.max(a.length, b.length);
  const hop = Math.max(128, Math.ceil(len / 480));
  const sa = melSpectrogram(a, { bands: 96, hop }), sb = melSpectrogram(b, { bands: 96, hop });
  const w = Math.max(sa.db.length, sb.db.length), h = sa.freqs.length;
  const floor = Math.max(specMax(sa), specMax(sb)) - SPEC_RANGE_DB;
  const at = (s: MelSpec, f: number, k: number): number => (f < s.db.length ? Math.max(floor, s.db[f]![k]!) : floor);
  const data = new Int8Array(w * h);
  const grid: number[][] = [];
  for (let f = 0; f < w; f++) { const row: number[] = []; for (let k = 0; k < h; k++) { const d = at(sa, f, k) - at(sb, f, k); row.push(d); data[f * h + k] = Math.round(Math.max(-1, Math.min(1, d / 30)) * 127); } grid.push(row); }
  const duration = len / 44100;
  return { w, h, data, freqs: Array.from(sa.freqs), duration, summary: diffSummary(grid, sa.freqs, duration) };
}

/** One sentence about a difference spectrogram: the regions (time quarters by low, mid and high bands) that moved by 3 dB or more, joined when neighbours agree. */
export function diffSummary(grid: number[][], freqs: ArrayLike<number>, duration: number): string {
  const w = grid.length;
  if (!w) return 'nothing to compare';
  const bandsOf: [string, (hz: number) => boolean][] = [['below 500 Hz', (hz) => hz < 500], ['between 500 Hz and 2 kHz', (hz) => hz >= 500 && hz < 2000], ['above 2 kHz', (hz) => hz >= 2000]];
  const Q = 4;
  const parts: string[] = [];
  for (const [name, inBand] of bandsOf) {
    const q: number[] = [];
    for (let i = 0; i < Q; i++) {
      let s = 0, n = 0;
      for (let f = Math.floor((i * w) / Q); f < Math.floor(((i + 1) * w) / Q); f++) for (let k = 0; k < freqs.length; k++) if (inBand(freqs[k]!)) { s += grid[f]![k]!; n++; }
      q.push(n ? s / n : 0);
    }
    let i = 0;
    while (i < Q) {
      const sign = Math.abs(q[i]!) >= 3 ? Math.sign(q[i]!) : 0;
      if (!sign) { i++; continue; }
      let j = i;
      while (j + 1 < Q && Math.sign(q[j + 1]!) === sign && Math.abs(q[j + 1]!) >= 3) j++;
      const mags = q.slice(i, j + 1).map((v) => Math.abs(v));
      const lo = Math.round(Math.min(...mags)), hi = Math.round(Math.max(...mags));
      const t0 = ((i / Q) * duration).toFixed(2), t1 = (((j + 1) / Q) * duration).toFixed(2);
      parts.push(`${name} is ${lo === hi ? lo : `${lo}–${hi}`} dB ${sign > 0 ? 'louder' : 'quieter'} from ${t0} to ${t1} s`);
      i = j + 1;
    }
  }
  return parts.length ? `Now: ${parts.join('; ')}.` : 'No part of the spectrum differs by 3 dB or more.';
}
