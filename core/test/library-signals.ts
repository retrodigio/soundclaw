// Generated one-shots for the library tests: every sound here is made by code (nothing third-party).

export type Kind = 'creak' | 'bell' | 'slam' | 'tone' | 'rain' | 'clicks';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** A mono one-shot of `seconds` at `rate`: the kinds differ in length, pitch, brightness, attack and hits, as recordings of those things would. */
export function signal(kind: Kind, seed: number, seconds: number, rate = 22050): Float32Array {
  const n = Math.round(seconds * rate);
  const x = new Float32Array(n);
  const r = lcg(seed);
  const detune = 1 + (r() - 0.5) * 0.2;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const u = i / n;
    let v = 0;
    switch (kind) {
      case 'creak': { // a low saw sliding up, rough with noise, a slow swell
        const f = (80 + 70 * u) * detune;
        const ph = (f * t) % 1;
        v = (ph * 2 - 1) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 9 * t)) * Math.sin(Math.PI * u) * 0.5 + (r() - 0.5) * 0.08 * Math.sin(Math.PI * u);
        break;
      }
      case 'bell': { // a struck bar: inharmonic partials with different decays
        const f0 = 440 * detune;
        v = [1, 2.76, 5.4, 8.93].reduce((s, m, k) => s + Math.sin(2 * Math.PI * f0 * m * t) * Math.exp(-t * (2 + k * 3)) / (k + 1), 0) * 0.5;
        break;
      }
      case 'slam': { // a noise burst falling fast
        lp += ((r() - 0.5) * 2 - lp) * 0.35;
        v = lp * Math.exp(-t * 14) * 0.9;
        break;
      }
      case 'tone': { // a steady sine with a soft attack and release
        v = Math.sin(2 * Math.PI * 261.63 * detune * t) * Math.min(1, t / 0.02) * Math.min(1, (seconds - t) / 0.05) * 0.5;
        break;
      }
      case 'rain': { // a bed of filtered noise with flicker
        lp += ((r() - 0.5) * 2 - lp) * 0.6;
        v = lp * (0.25 + 0.1 * r());
        break;
      }
      case 'clicks': { // four clicks a quarter second apart
        const k = Math.floor(t / 0.25);
        const local = t - k * 0.25;
        v = local < 0.004 ? (r() - 0.5) * 1.6 * (1 - local / 0.004) : 0;
        break;
      }
    }
    x[i] = v;
  }
  return x;
}
