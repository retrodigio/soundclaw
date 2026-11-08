// Device cards of the layered editor: a sketch of what the effect does (filter response, drive
// curve, echoes...), the two or three values worth showing, and the commands for moving a device
// within a chain, to another layer, or copying it. Pure functions, no DOM.

import { FX_SPECS, envCommand, type Env, type Fx, type FxKind, type LayeredSound, type PSpec, type Value } from '@soundclaw/core';

export const SW = 150, SH = 26;
const f = (n: number): string => n.toFixed(1);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const num = (v: Value | undefined, d: number): number => (typeof v === 'number' ? v : d);
const line = (pts: [number, number][]): string => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)} ${f(y)}`).join(' ');

/** A path of what the effect does, in a 150 × 26 box. */
export function sketch(kind: FxKind, p: Record<string, Value>): string {
  const x = (u: number): number => 2 + u * (SW - 4);
  const y = (u: number): number => SH - 3 - clamp(u, 0, 1) * (SH - 6);
  switch (kind) {
    case 'filter': {
      const type = String(p.type ?? 'lp');
      const c = Math.log(clamp(num(p.cutoff, 1000), 20, 20000) / 20) / Math.log(1000); // 0..1 across 20 Hz … 20 kHz
      const q = clamp(num(p.q, 0.707), 0.5, 20);
      const bump = clamp(Math.log2(q / 0.707) / 5, 0, 0.35);
      const pts: [number, number][] = [];
      for (let i = 0; i <= 60; i++) {
        const u = i / 60;
        const d = (u - c) * 6; // distance from the cutoff, in sketch units
        let g: number;
        if (type === 'lp') g = d < 0 ? 0.78 : 0.78 * Math.exp(-d * d * 0.9);
        else if (type === 'hp') g = d > 0 ? 0.78 : 0.78 * Math.exp(-d * d * 0.9);
        else if (type === 'bp') g = 0.78 * Math.exp(-d * d * 0.45);
        else g = 0.78 * (1 - 0.9 * Math.exp(-d * d * 3));
        g += bump * Math.exp(-d * d * 6);
        pts.push([x(u), y(g)]);
      }
      return line(pts);
    }
    case 'distort': {
      const drive = clamp(num(p.drive, 4), 1, 50);
      const shape = String(p.shape ?? 'soft');
      const pts: [number, number][] = [];
      for (let i = 0; i <= 40; i++) {
        const xin = (i / 40) * 2 - 1;
        const v = xin * drive * 0.5;
        const out = shape === 'hard' ? clamp(v, -1, 1) : shape === 'fold' ? Math.sin(v * 1.6) : shape === 'cubic' ? (Math.abs(v) >= 1 ? Math.sign(v) * 0.667 : v - (v * v * v) / 3) * 1.5 : v / (1 + Math.abs(v));
        pts.push([x(i / 40), y(0.5 + clamp(out, -1, 1) * 0.5)]);
      }
      return line(pts);
    }
    case 'bitcrush': {
      const steps = Math.pow(2, clamp(num(p.bits, 8), 1, 16) > 5 ? 5 : clamp(num(p.bits, 8), 1, 16));
      const pts: [number, number][] = [];
      for (let i = 0; i <= 60; i++) {
        const u = i / 60;
        const s = 0.5 + 0.45 * Math.sin(u * Math.PI * 2);
        pts.push([x(u), y(Math.round(s * steps) / steps)]);
      }
      return line(pts);
    }
    case 'chorus': {
      const depth = clamp(num(p.depth, 3) / 10, 0.1, 1);
      const rate = clamp(num(p.rate, 0.8), 0.05, 10);
      const cycles = 1 + Math.log2(rate * 8) / 2;
      const pts: [number, number][] = [];
      for (let i = 0; i <= 60; i++) { const u = i / 60; pts.push([x(u), y(0.5 + 0.38 * depth * Math.sin(u * Math.PI * 2 * cycles))]); }
      return line(pts);
    }
    case 'delay': {
      const t = clamp(num(p.time, 0.25), 0.01, 1);
      const fb = clamp(num(p.feedback, 0.4), 0, 0.95);
      let d = '';
      for (let k = 0, level = 1; k < 8; k++, level *= fb) {
        const u = (k * (0.1 + t * 0.4)) % 1.2;
        if (u > 1 || level < 0.05) break;
        d += `M${f(x(u))} ${f(y(0))} L${f(x(u))} ${f(y(0.1 + level * 0.8))} `;
      }
      return d.trim();
    }
    case 'reverb': {
      const size = clamp(num(p.size, 0.5), 0, 1);
      const pts: [number, number][] = [];
      for (let i = 0; i <= 40; i++) { const u = i / 40; pts.push([x(u), y(0.9 * Math.exp(-u * (6 - 4.5 * size)))]); }
      return line(pts);
    }
    case 'compress': {
      const th = clamp(num(p.threshold, -18), -60, 0);
      const ratio = clamp(num(p.ratio, 4), 1, 20);
      const knee = (th + 60) / 60; // where the line bends, as a fraction of the input range
      const out = (u: number): number => (u <= knee ? u : knee + (u - knee) / ratio);
      return line([0, knee, 1].map((u) => [x(u), y(out(u))] as [number, number]));
    }
    case 'limit': {
      const ceil = clamp(num(p.ceiling, -1), -24, 0);
      const c = 1 - Math.abs(ceil) / 30; // the ceiling's height
      return line([[x(0), y(0)], [x(c), y(c)], [x(1), y(c)]]);
    }
  }
}

/** The path of an amplitude (or any) envelope in the 150 × 26 box; null for no envelope. */
export function envSketch(env: Env | null): string {
  if (!env || env.length < 1) return line([[2, SH - 3], [SW - 2, SH - 3]]);
  const tMax = Math.max(env[env.length - 1]!.t, 1e-6);
  const vMax = Math.max(...env.map((q) => q.v), 1e-6), vMin = Math.min(0, ...env.map((q) => q.v));
  const X = (t: number): number => 2 + (t / tMax) * (SW - 4);
  const Y = (v: number): number => SH - 3 - ((v - vMin) / (vMax - vMin || 1)) * (SH - 6);
  const pts: [number, number][] = [];
  env.forEach((q, i) => {
    if (i > 0 && q.curve === 'hold') pts.push([X(q.t), Y(env[i - 1]!.v)]);
    pts.push([X(q.t), Y(q.v)]);
  });
  return line(pts);
}

const unitText = (sp: PSpec, v: Value): string => {
  if (typeof v !== 'number') return String(v);
  if (sp.unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kHz` : `${Number(v.toPrecision(3))} Hz`;
  if (sp.unit === 's') return v < 1 ? `${Math.round(v * 1000)} ms` : `${Number(v.toPrecision(3))} s`;
  if (sp.unit) return `${Number(v.toPrecision(3))} ${sp.unit}`;
  return String(Number(v.toPrecision(3)));
};

/** The two or three values a card shows: the effect's first parameters. */
export function mainValues(kind: FxKind, p: Record<string, Value>): { k: string; v: string }[] {
  return FX_SPECS[kind].slice(0, 3).map((sp) => ({ k: sp.name, v: unitText(sp, p[sp.name] ?? sp.default) }));
}

// ---- moving devices -------------------------------------------------------------------------------

/** A chain: a layer's (1-based) or the master's. */
export type Scope = number | 'M';
const where = (s: Scope): string => (s === 'M' ? '' : ` layer=${s}`);
const target = (s: Scope, k: number, param: string): string => `${s === 'M' ? 'master' : s}.fx${k}.${param}`;

/** The chain of a scope. */
export const chainOf = (sound: LayeredSound, s: Scope): Fx[] => (s === 'M' ? sound.master : sound.layers[s - 1]?.fx ?? []);

/**
 * The commands for dropping device `k` of chain `from` at position `at` (1-based, in the chain it
 * lands in) of chain `to`. Within a chain it is one `fx move`. Between chains it is a remove and an
 * add with the same parameters, and the envelopes the device's parameters follow; `copy` leaves
 * the original in place. One batch: the caller sends them as one `run`.
 */
export function dropDeviceCommands(sound: LayeredSound, from: Scope, k: number, to: Scope, at: number, copy: boolean): string[] {
  const id = sound.id;
  const src = chainOf(sound, from)[k - 1];
  if (!src) return [];
  if (from === to && !copy) {
    const to2 = Math.min(at, chainOf(sound, from).length);
    return to2 === k ? [] : [`fx move ${id}${where(from)} ${k} to=${to2}`];
  }
  // the remove comes first, so a drop later in the same chain would shift by one; chains differ here, or it is a copy
  const values = Object.entries(src.p).map(([name, v]) => ` ${name}=${v}`).join('');
  const out: string[] = [];
  const insertAt = Math.min(at, chainOf(sound, to).length + 1);
  out.push(`fx add ${id}${where(to)} ${src.kind}${values} at=${insertAt}`);
  for (const [param, env] of Object.entries(src.envs)) out.push(envCommand(id, target(to, insertAt, param), env));
  if (!copy) {
    // a copy into the same chain lands at `at`; the original then sits one place further on when it was at or after it
    const origin = from === to && insertAt <= k ? k + 1 : k;
    out.push(`fx remove ${id}${where(from)} ${origin}`);
  }
  return out;
}
