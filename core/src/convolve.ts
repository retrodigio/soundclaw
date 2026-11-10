// Convolution: a signal through an impulse response, by uniformly partitioned FFT convolution (overlap-add).
// The impulse response is cut into blocks of BLOCK frames, each transformed once; the signal is taken a block
// at a time, and the spectra of its last blocks are multiplied with the spectra of the response's blocks and
// added (a frequency-domain delay line). Only + - * / and the radix-2 FFT of stretch.ts (twiddles from fdlibm's
// sine) are used, in a fixed order, so the same bytes come out in Node and in the browser.

import { fftInPlace as fft } from './stretch.ts';

/** Frames per block (the FFT is twice this long). */
export const CONVOLVE_BLOCK = 2048;

/**
 * `x` convolved with `h`, the first `outLength` frames of the result (the full result is x.length + h.length - 1 frames
 * long; a shorter `outLength` drops the end, a longer one is padded with zeros).
 */
export function convolve(x: ArrayLike<number>, h: ArrayLike<number>, outLength: number): Float64Array {
  const out = new Float64Array(outLength);
  if (!x.length || !h.length || outLength <= 0) return out;
  // past the full length of the result there is nothing, not the rounding of the transform
  const limit = Math.min(outLength, x.length + h.length - 1);
  const B = CONVOLVE_BLOCK;
  const N = 2 * B;
  const parts = Math.ceil(h.length / B);
  const hRe: Float64Array[] = [];
  const hIm: Float64Array[] = [];
  for (let p = 0; p < parts; p++) {
    const re = new Float64Array(N), im = new Float64Array(N);
    const from = p * B;
    for (let i = 0; i < B && from + i < h.length; i++) re[i] = h[from + i]!;
    fft(re, im, false);
    hRe.push(re);
    hIm.push(im);
  }
  const inBlocks = Math.ceil(x.length / B);
  const outBlocks = Math.ceil(limit / B);
  // the spectra of the last blocks of the input: a ring as long as the response has blocks
  const ring = Math.max(1, Math.min(parts, inBlocks));
  const xRe: Float64Array[] = Array.from({ length: ring }, () => new Float64Array(N));
  const xIm: Float64Array[] = Array.from({ length: ring }, () => new Float64Array(N));
  const accRe = new Float64Array(N), accIm = new Float64Array(N);
  for (let k = 0; k < outBlocks; k++) {
    if (k < inBlocks) {
      const re = xRe[k % ring]!, im = xIm[k % ring]!;
      re.fill(0);
      im.fill(0);
      const from = k * B;
      for (let i = 0; i < B && from + i < x.length; i++) re[i] = x[from + i]!;
      fft(re, im, false);
    }
    accRe.fill(0);
    accIm.fill(0);
    let any = false;
    // the block k of the output is the sum over p of (input block k - p) * (response block p)
    for (let p = 0; p < parts; p++) {
      const j = k - p;
      if (j < 0) break;
      if (j >= inBlocks) continue;
      any = true;
      const ar = xRe[j % ring]!, ai = xIm[j % ring]!, br = hRe[p]!, bi = hIm[p]!;
      for (let i = 0; i < N; i++) {
        accRe[i] = accRe[i]! + (ar[i]! * br[i]! - ai[i]! * bi[i]!);
        accIm[i] = accIm[i]! + (ar[i]! * bi[i]! + ai[i]! * br[i]!);
      }
    }
    if (!any) continue;
    fft(accRe, accIm, true);
    const at = k * B;
    for (let i = 0; i < N && at + i < limit; i++) out[at + i] = out[at + i]! + accRe[i]! / N;
  }
  return out;
}

/** The same result, term by term: for tests and for very short responses. */
export function convolveDirect(x: ArrayLike<number>, h: ArrayLike<number>, outLength: number): Float64Array {
  const out = new Float64Array(outLength);
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    if (v === 0) continue;
    for (let j = 0; j < h.length && i + j < outLength; j++) out[i + j] = out[i + j]! + v * h[j]!;
  }
  return out;
}
