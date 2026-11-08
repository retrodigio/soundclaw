// The spectrogram's colours: the ground, then ember at rising opacity, then a pale ember highlight
// for the loudest cells (tokens --ground, --ember and --spec-hi, so both themes get their own).

let cache: { key: string; lut: Uint8ClampedArray } | null = null;

function rgbOf(css: string): [number, number, number] {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const g = c.getContext('2d')!;
  g.fillStyle = css || '#000';
  g.fillRect(0, 0, 1, 1);
  const d = g.getImageData(0, 0, 1, 1).data;
  return [d[0]!, d[1]!, d[2]!];
}

/** 256 colours (r, g, b) from quiet to loud, for the theme in effect. */
export function specLut(): Uint8ClampedArray {
  const cs = getComputedStyle(document.documentElement);
  const get = (n: string) => cs.getPropertyValue(n).trim();
  const key = `${get('--ground')}|${get('--ember')}|${get('--spec-hi')}`;
  if (cache?.key === key) return cache.lut;
  const ground = rgbOf(get('--ground')), ember = rgbOf(get('--ember')), hi = rgbOf(get('--spec-hi'));
  const lut = new Uint8ClampedArray(256 * 3);
  const mix = (a: number[], b: number[], t: number, i: number) => { for (let k = 0; k < 3; k++) lut[i * 3 + k] = Math.round(a[k]! + (b[k]! - a[k]!) * t); };
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    // ember opacity rises from 0 to 0.85 over the first 80 %, the top fifth goes on to the pale highlight
    const alpha = Math.min(1, t / 0.8) ** 1.4 * 0.85;
    const base = [0, 0, 0];
    for (let k = 0; k < 3; k++) base[k] = ground[k]! + (ember[k]! - ground[k]!) * alpha;
    mix(base, hi, t > 0.8 ? ((t - 0.8) / 0.2) ** 1.2 : 0, i);
  }
  cache = { key, lut };
  return lut;
}
