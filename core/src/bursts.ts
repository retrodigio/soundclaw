// The bursts envelope generator: repeated short hits (rain drops, a machine gun, a ticking clock) as ONE envelope, so
// a sound with many hits does not need a layer for each (a sound has at most 8 layers). Two forms:
//
//   bursts(times=0.1,0.3,0.55, attack=0.002, decay=0.05, level=1)      hits at the given times
//   bursts(times=0.1,0.3,0.55, level=1,0.6,0.3)                        one level per hit (in the order the times are given)
//   bursts(count=6, over=2, jitter=0.5, attack=0.002, decay=0.05, level=0.5..1, seed=7)
//                                                                       `count` hits spread over `over` seconds, each moved by
//                                                                       up to `jitter` of its slot, seeded (the same text always
//                                                                       gives the same hits)
//
// Each hit rises over `attack` seconds from 0 to its level and falls back to 0 over `decay` seconds on an exponential curve
// (-60 dB at its end). The result is plain breakpoints (what the tape holds), at most MAX_POINTS of them.

import { Rng, hashText } from './generators.ts';
import { MAX_POINTS, parseNumber, type Env } from './layered.ts';

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** Hits one burst takes in breakpoints: its start (when it does not begin at the previous end), its peak and its end. */
export const MAX_BURSTS = Math.floor((MAX_POINTS - 1) / 3);

const KEYS = ['times', 'attack', 'decay', 'level', 'count', 'over', 'jitter', 'seed'];

function fields(inner: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([a-z]+)=/g;
  const marks: { key: string; at: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) marks.push({ key: m[1]!, at: m.index, end: m.index + m[0].length });
  const lead = inner.slice(0, marks[0]?.at ?? inner.length).replace(/[\s,]/g, '');
  if (lead) throw new Error(`bursts(...): '${lead}' is not <name>=<value> (names: ${KEYS.join(', ')})`);
  marks.forEach((k, i) => {
    if (!KEYS.includes(k.key)) throw new Error(`bursts(...): no setting '${k.key}' (names: ${KEYS.join(', ')})`);
    if (out.has(k.key)) throw new Error(`bursts(...): ${k.key} is given twice`);
    out.set(k.key, inner.slice(k.end, marks[i + 1]?.at ?? inner.length).replace(/[\s,]+$/, '').trim());
  });
  return out;
}

function num(f: Map<string, string>, key: string, dflt: number, lo: number, hi: number, unit = ''): number {
  const raw = f.get(key);
  if (raw === undefined) return dflt;
  const n = parseNumber(raw);
  if (n === null || n < lo || n > hi) throw new Error(`bursts(...): ${key} must be a number from ${lo} to ${hi}${unit} (got '${raw}')`);
  return n;
}

/** Is this word a bursts(...) generator? */
export const isBursts = (w: string): boolean => /^bursts\(.*\)$/s.test(w.trim());

/** The breakpoints of a `bursts(...)` text. Throws a plain Error saying what is wrong. */
export function burstsEnv(text: string): Env {
  const m = /^bursts\((.*)\)$/s.exec(text.trim());
  if (!m) throw new Error('bursts(times=0.1,0.3 attack=0.002 decay=0.05 level=1) or bursts(count=6 over=2 jitter=0.5 ...)');
  const f = fields(m[1]!);
  const attack = num(f, 'attack', 0.002, 0.0005, 1, ' s');
  const decay = num(f, 'decay', 0.05, 0.005, 10, ' s');
  let lo = 1, hi = 1;
  const lv = f.get('level');
  let perHit: number[] | null = null;
  if (lv !== undefined && /[\s,]/.test(lv)) {
    if (!f.has('times')) throw new Error(`bursts(...): a level for each hit (level=${lv}) goes with times=; with count= give one level or a range like 0.5..1`);
    perHit = lv.split(/[\s,]+/).filter(Boolean).map((w) => {
      const n = parseNumber(w);
      if (n === null || n < 0 || n > 4) throw new Error(`bursts(...): each level is a number from 0 to 4 (got '${w}' in level=${lv})`);
      return n;
    });
  } else if (lv !== undefined) {
    const r = /^(.+?)\.\.(.+)$/.exec(lv);
    const a = parseNumber(r ? r[1]! : lv), b = parseNumber(r ? r[2]! : lv);
    if (a === null || b === null || a < 0 || b > 4 || a > b) throw new Error(`bursts(...): level is a number from 0 to 4, or a range like 0.5..1 (got '${lv}')`);
    lo = a; hi = b;
  }
  let times: number[];
  let rng: Rng | null = null;
  if (f.has('times')) {
    for (const k of ['count', 'over', 'jitter', 'seed']) if (f.has(k)) throw new Error(`bursts(...): ${k} goes with the count= form, not times=`);
    times = f.get('times')!.split(/[\s,]+/).filter(Boolean).map((w) => {
      const t = parseNumber(w);
      if (t === null || t < 0) throw new Error(`bursts(...): times are seconds from 0 (got '${w}')`);
      return t;
    });
    if (!times.length) throw new Error('bursts(...): times= needs at least one time');
    if (perHit && perHit.length !== times.length) throw new Error(`bursts(...): ${times.length} times but ${perHit.length} levels: level= needs one level for each hit, or a single level`);
    // the levels stay with their times in the order they were written
    const order = times.map((t, i) => ({ t, i })).sort((x, y) => x.t - y.t || x.i - y.i);
    if (perHit) perHit = order.map((o) => perHit![o.i]!);
    times = order.map((o) => o.t);
  } else {
    if (!f.has('count') || !f.has('over')) throw new Error('bursts(...): give times=<t,t,...> or count=<n> over=<seconds>');
    const count = num(f, 'count', 1, 1, MAX_BURSTS);
    if (!Number.isInteger(count)) throw new Error(`bursts(...): count must be a whole number (got '${f.get('count')}')`);
    const over = num(f, 'over', 1, 0.01, 120, ' s');
    const jitter = num(f, 'jitter', 0.5, 0, 1);
    const seed = f.has('seed') ? num(f, 'seed', 0, 0, 4294967295) : hashText(`bursts:${count}:${over}:${jitter}:${attack}:${decay}:${lv ?? ''}`);
    rng = new Rng(seed);
    const slot = over / count;
    times = Array.from({ length: count }, (_, i) => Math.max(0, slot * (i + 0.5) + (rng!.next() - 0.5) * jitter * slot));
  }
  if (times.length > MAX_BURSTS) throw new Error(`bursts(...): at most ${MAX_BURSTS} bursts in one envelope (an envelope has at most ${MAX_POINTS} breakpoints); split them over two layers or two sounds`);
  const out: Env = [];
  let end = -1;
  for (const [k, raw] of times.entries()) {
    let t = round6(raw);
    if (rng && t < end) t = round6(end + 0.001);
    if (t < end - 1e-9) throw new Error(`bursts(...): the bursts at ${round6(end - attack - decay)} s and ${t} s overlap (a burst lasts attack + decay = ${round6(attack + decay)} s): use a shorter decay or spread the times`);
    if (!out.length || t > end + 1e-9) out.push({ t, v: 0, curve: 'lin' });
    out.push({ t: round6(t + attack), v: round6(perHit ? perHit[k]! : rng && hi > lo ? lo + (hi - lo) * rng.next() : hi), curve: 'lin' });
    end = round6(t + attack + decay);
    out.push({ t: end, v: 0, curve: 'exp' });
  }
  return out;
}
