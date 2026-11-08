// The arithmetic of the clip grid and the blind A/B card, kept apart from React so it can be tested:
// the repeat interval a moment's words give, the level-matching gains, a cell's loudness glyph and
// whether two renders are the same once their levels are matched.

import type { CheckKind } from '../studio/controls.tsx';

/** The repeat interval a moment gives in words ("steps repeat every 0.4 s", "every 400 ms"), in seconds; null when it gives none. */
export function momentInterval(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /\bevery\s+(\d*\.?\d+)\s*(ms|milliseconds?|s|secs?|seconds?)\b/i.exec(text);
  if (!m) return null;
  const v = Number(m[1]) * (/^m/i.test(m[2]!) ? 0.001 : 1);
  return v >= 0.05 && v <= 10 ? v : null;
}

/** How many times a side plays and how far apart the starts are: four at the moment's interval, else once. */
export function playPlan(moment: string | null | undefined): { times: number; interval: number; gap: number } {
  const every = momentInterval(moment);
  return every ? { times: 4, interval: every, gap: 0.5 } : { times: 1, interval: 0, gap: 0.5 };
}

/**
 * The gains (dB) that bring two sounds to the same integrated loudness: both meet at the mean of the two, then both move down
 * together if a side would go above `ceiling` dBTP. A silent side (null) is left alone and the other is not matched to it.
 */
export function matchGains(a: { lufs: number | null; truePeakDb: number | null }, b: { lufs: number | null; truePeakDb: number | null }, ceiling = -1): { a: number; b: number } | null {
  if (a.lufs === null || b.lufs === null) return null;
  const mid = (a.lufs + b.lufs) / 2;
  let ga = mid - a.lufs, gb = mid - b.lufs;
  const over = Math.max(a.truePeakDb === null ? -Infinity : a.truePeakDb + ga - ceiling, b.truePeakDb === null ? -Infinity : b.truePeakDb + gb - ceiling, 0);
  ga -= over;
  gb -= over;
  const r1 = (v: number): number => Math.round(v * 10) / 10 || 0;
  return { a: r1(ga), b: r1(gb) };
}

/** A gain as the card shows it: +1.2 dB, −0.3 dB, ±0.0 dB. */
export const gainText = (g: number): string => `${g > 0 ? '+' : g < 0 ? '−' : '±'}${Math.abs(g).toFixed(1)} dB`;

/** A cell's loudness against its class: within the tolerance passes, within twice it warns, beyond fails. */
export function loudKind(lufs: number | null | undefined, target: number, tolerance: number): CheckKind {
  if (lufs === undefined) return 'checking';
  if (lufs === null) return 'fail';
  const d = Math.abs(lufs - target);
  return d <= tolerance ? 'pass' : d <= 2 * tolerance ? 'warn' : 'fail';
}

/**
 * Are two renders the same once their levels are matched: one a scaled copy of the other (same length and channels, every sample
 * within −80 dBFS of the scaled copy)? Two versions that differ only by a gain are the same pair after matching.
 */
export function sameUpToLevel(x: readonly Float32Array[], y: readonly Float32Array[]): boolean {
  if (x.length !== y.length || x[0]!.length !== y[0]!.length) return false;
  let xy = 0, xx = 0;
  for (let c = 0; c < x.length; c++) for (let i = 0; i < x[c]!.length; i++) { xy += x[c]![i]! * y[c]![i]!; xx += x[c]![i]! * x[c]![i]!; }
  const k = xx > 0 ? xy / xx : 0;
  if (xx > 0 && k <= 0) return false;
  for (let c = 0; c < x.length; c++) for (let i = 0; i < x[c]!.length; i++) if (Math.abs(x[c]![i]! * k - y[c]![i]!) > 1e-4) return false;
  return true;
}

/** An unordered key for a pair of versions, so a pair answered once this session is not offered again. */
export const pairKey = (a: { id: string; seq: number }, b: { id: string; seq: number }): string => [`${a.id}@${a.seq}`, `${b.id}@${b.seq}`].sort().join('|');
