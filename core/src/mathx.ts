// The two pieces of maths the classic voice needs that platforms may round differently, written
// with + - * / only (IEEE-754 fixes those exactly), so Node and every browser agree bit for bit:
//
//  - `sinRad`: the sine, a port of fdlibm's __kernel_sin, __kernel_cos and the medium-range
//    argument reduction (the algorithm V8's Math.sin is built on). Math.sin itself is allowed to
//    differ in the last digit between engines and libm builds; this function is not.
//  - `cube`: x³ correctly rounded (one rounding of the exact product), the value a good libm
//    `pow(x, 3)` returns, where `x * x * x` rounds twice.

const view = new DataView(new ArrayBuffer(8));

/** The high 32 bits of a double (sign, exponent, top of the mantissa), platform independent. */
function high(x: number): number {
  view.setFloat64(0, x);
  return view.getInt32(0);
}

const S1 = -1.66666666666666324348e-01;
const S2 = 8.33333333332248946124e-03;
const S3 = -1.98412698298579493134e-04;
const S4 = 2.75573137070700676789e-06;
const S5 = -2.50507602534068634195e-08;
const S6 = 1.58969099521155010221e-10;

const C1 = 4.16666666666666019037e-02;
const C2 = -1.38888888888741095749e-03;
const C3 = 2.48015872894767294178e-05;
const C4 = -2.75573143513906633035e-07;
const C5 = 2.08757232129817482790e-09;
const C6 = -1.13596475577881948265e-11;

const PIO2_1 = 1.57079632673412561417e+00;
const PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_2T = 2.02226624879595063154e-21;
const PIO2_3 = 2.02226624871116645580e-21;
const PIO2_3T = 8.47842766036889956997e-32;
const INVPIO2 = 6.36619772367581382433e-01;

function kernelSin(x: number, y: number, iy: number): number {
  const ix = high(x) & 0x7fffffff;
  if (ix < 0x3e400000 && Math.trunc(x) === 0) return x;
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

function kernelCos(x: number, y: number): number {
  const ix = high(x) & 0x7fffffff;
  if (ix < 0x3e400000 && Math.trunc(x) === 0) return 1;
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3fd33333) return 1 - (0.5 * z - (z * r - x * y));
  let qx: number;
  if (ix > 0x3fe90000) qx = 0.28125;
  else {
    view.setInt32(0, ix - 0x00200000);
    view.setInt32(4, 0);
    qx = view.getFloat64(0);
  }
  const hz = 0.5 * z - qx;
  const a = 1 - qx;
  return a - (hz - (z * r - x * y));
}

/** x reduced to [-π/4, π/4] as y0 + y1, and the quadrant n (fdlibm's __ieee754_rem_pio2, |x| up to 2^19·π/2 exact; beyond, still the right quadrant to a few digits). */
function remPio2(x: number): { n: number; y0: number; y1: number } {
  const hx = high(x);
  const ix = hx & 0x7fffffff;
  if (ix < 0x4002d97c) {
    if (hx > 0) {
      let z = x - PIO2_1;
      if (ix !== 0x3ff921fb) {
        const y0 = z - PIO2_1T;
        return { n: 1, y0, y1: (z - y0) - PIO2_1T };
      }
      z -= PIO2_2;
      const y0 = z - PIO2_2T;
      return { n: 1, y0, y1: (z - y0) - PIO2_2T };
    }
    let z = x + PIO2_1;
    if (ix !== 0x3ff921fb) {
      const y0 = z + PIO2_1T;
      return { n: -1, y0, y1: (z - y0) + PIO2_1T };
    }
    z += PIO2_2;
    const y0 = z + PIO2_2T;
    return { n: -1, y0, y1: (z - y0) + PIO2_2T };
  }
  const t = Math.abs(x);
  const n = Math.floor(t * INVPIO2 + 0.5);
  const fn = n;
  let r = t - fn * PIO2_1;
  let w = fn * PIO2_1T;
  const j = ix >> 20;
  let y0 = r - w;
  let i = j - ((high(y0) >> 20) & 0x7ff);
  if (i > 16) {
    let t2 = r;
    w = fn * PIO2_2;
    r = t2 - w;
    w = fn * PIO2_2T - ((t2 - r) - w);
    y0 = r - w;
    i = j - ((high(y0) >> 20) & 0x7ff);
    if (i > 49) {
      t2 = r;
      w = fn * PIO2_3;
      r = t2 - w;
      w = fn * PIO2_3T - ((t2 - r) - w);
      y0 = r - w;
    }
  }
  const y1 = (r - y0) - w;
  return hx < 0 ? { n: -n, y0: -y0, y1: -y1 } : { n, y0, y1 };
}

/** sin(x), x in radians: the same bits on every platform. */
export function sinRad(x: number): number {
  const ix = high(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelSin(x, 0, 0);
  if (ix >= 0x7ff00000) return NaN;
  const { n, y0, y1 } = remPio2(x);
  switch (n & 3) {
    case 0: return kernelSin(y0, y1, 1);
    case 1: return kernelCos(y0, y1);
    case 2: return -kernelSin(y0, y1, 1);
    default: return -kernelCos(y0, y1);
  }
}

const SPLIT = 134217729; // 2^27 + 1

/** x·x as a pair (p, e) with p + e exactly x² (Dekker). */
function twoSquare(x: number): [number, number] {
  const p = x * x;
  const c = SPLIT * x;
  const hi = c - (c - x);
  const lo = x - hi;
  return [p, ((hi * hi - p) + 2 * hi * lo) + lo * lo];
}

/** x³ rounded once (|x| ≤ 1 here, so nothing overflows). */
export function cube(x: number): number {
  if (x === 0 || !Number.isFinite(x)) return x * x * x;
  const [p, e] = twoSquare(x);
  // p·x exactly, as q + qe (Dekker's two-product)
  const q = p * x;
  const cp = SPLIT * p;
  const ph = cp - (cp - p);
  const pl = p - ph;
  const cx = SPLIT * x;
  const xh = cx - (cx - x);
  const xl = x - xh;
  const qe = ((ph * xh - q) + ph * xl + pl * xh) + pl * xl;
  return q + (qe + e * x);
}

/** C's `%.{prec}g` for a finite number (what Lua prints numbers with at 14 digits, and what the single-patch text uses at 6). */
export function formatG(v: number, prec: number): string {
  if (v === 0) return Object.is(v, -0) ? '-0' : '0';
  const exp = Number(v.toExponential(prec - 1).split('e')[1]);
  const strip = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  if (exp < -4 || exp >= prec) {
    const [m, e] = v.toExponential(prec - 1).split('e');
    const n = Number(e);
    return `${strip(m!)}e${n < 0 ? '-' : '+'}${String(Math.abs(n)).padStart(2, '0')}`;
  }
  return strip(v.toFixed(prec - 1 - exp));
}

export const TAU = 6.283185307179586;

/** sin(2π·cycles) for any phase, from a Taylor polynomial on [-π/2, π/2] (error below 1e-11). */
export function sineCycles(cycles: number): number {
  let p = cycles - Math.floor(cycles); // [0, 1)
  // Fold into [-1/4, 1/4] cycles using the sine's symmetries.
  if (p > 0.75) p -= 1;
  else if (p > 0.25) p = 0.5 - p;
  const x = p * TAU;
  const x2 = x * x;
  return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800 + x2 * (1 / 6227020800 + x2 * (-1 / 1307674368000))))))));
}


const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
// Which half of the Float64Array holds the high word depends on the platform's byte order; both common ones are handled.
const HI = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0;

/** 2^n for a whole n from -1022 to 1023, built from the bits: exact on every platform. */
export function pow2int(n: number): number {
  const e = n < -1022 ? -1022 : n > 1023 ? 1023 : n;
  u32[HI] = (e + 1023) << 20;
  u32[1 - HI] = 0;
  return f64[0]!;
}

const LN2 = 0.6931471805599453;

/** 2^x from + - * / alone (relative error below 1e-12): the same bits on every platform. */
export function exp2(x: number): number {
  if (x > 1023) return Infinity;
  if (x < -1022) return 0;
  const n = Math.round(x);
  const y = (x - n) * LN2; // |y| <= 0.347
  let term = 1;
  let sum = 1;
  for (let k = 1; k <= 11; k++) { term = (term * y) / k; sum += term; }
  return sum * pow2int(n);
}

/** log2(x) for x > 0, from the bits and an atanh series: the same bits on every platform. */
export function log2(x: number): number {
  if (!(x > 0)) return x === 0 ? -Infinity : NaN;
  f64[0] = x;
  let e = ((u32[HI]! >>> 20) & 0x7ff) - 1023;
  u32[HI] = (u32[HI]! & 0x800fffff) | (1023 << 20);
  let m = f64[0]!; // [1, 2)
  if (m > 1.4142135623730951) { m /= 2; e += 1; }
  const z = (m - 1) / (m + 1);
  const z2 = z * z;
  let term = z;
  let sum = 0;
  for (let k = 1; k <= 19; k += 2) { sum += term / k; term *= z2; }
  return e + (2 * sum) / LN2;
}

/** tan(pi * f / fs) for the filters' coefficients (f well below fs / 2). */
export function tanPi(ratio: number): number {
  const x = Math.PI * ratio;
  return sinRad(x) / sinRad(x + Math.PI / 2);
}
