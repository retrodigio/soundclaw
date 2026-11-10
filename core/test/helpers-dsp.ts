// Test-only measuring helpers for the interpolation and stretch tests (platform maths is fine here).
export function fftMag(x: Float64Array): Float64Array {
  const n = x.length;
  const re = Float64Array.from(x), im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const a = i + k, b = a + len / 2;
        const xr = re[b]! * wr - im[b]! * wi, xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr; im[b] = im[a]! - xi; re[a] = re[a]! + xr; im[a] = im[a]! + xi;
      }
    }
  }
  const m = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) m[i] = Math.hypot(re[i]!, im[i]!);
  return m;
}

/** The strongest frequency in the middle of `x` (Hann window, parabolic peak on the log magnitude), Hz. */
export function peakHz(x: Float32Array, rate: number, from = 0, to = 1e9, size = 16384): number {
  const a = Math.max(0, Math.floor(x.length / 2 - size / 2));
  const f = new Float64Array(size);
  for (let i = 0; i < size; i++) f[i] = (x[a + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  const m = fftMag(f);
  let best = 1;
  for (let k = 1; k < size / 2 - 1; k++) {
    const hz = (k * rate) / size;
    if (hz < from || hz > to) continue;
    if (m[k]! > m[best]! || (best === 1 && hz >= from)) best = m[k]! > m[best]! || best === 1 ? k : best;
  }
  const l = Math.log(m[best - 1]!), c = Math.log(m[best]!), r = Math.log(m[best + 1]!);
  const d = (0.5 * (l - r)) / (l - 2 * c + r);
  return ((best + d) * rate) / size;
}

export const cents = (a: number, b: number): number => 1200 * Math.log2(a / b);
