// `check` for a sampled instrument, and the key-map view. These measure (they may use platform maths): each zone is played alone, at its
// root, through the instrument's own renderer, and its pitch and loudness are read from what comes out. Advisory in the sense that a
// sample is material, but a finding marked `fail` is a fault in the instrument as a played thing (a hole in the key-map, a zone that plays
// out of tune), so `check` reports it as failing.
//
//   coverage      keys (inside the declared range) or velocities with no zone to play them
//   pitch         a zone's pitch at its root more than 10 cents off (pitch-check=class: by pitch class; onset: not checked)
//   level         more than 3 LU between adjacent zones, or adjacent velocity layers, played alone at the same velocity
//   loop-seam     a looped zone's seam: a click, a level step, a spectral jump
//   distance      a note played more than 7 semitones from its zone's root (warning)
//   round-robin   takes of one round robin too alike or too different (the set-spread rules)
//   release       a release zone louder than the zone it follows

import { integratedLoudness, melSpectrogram } from './analysis.ts';
import { DEFAULT_STYLE, type Style } from './checks.ts';
import { cloneInstrument, pitchCheckOf, renderNote, type Instrument } from './instrument.ts';
import { noteLabel } from './music.ts';
import { Canvas, type Rgb } from './png.ts';
import { LOOP_CLICK_OK, LOOP_LEVEL_OK, LOOP_SPECTRAL_OK, loopSeam, measureSample } from './sampleears.ts';
import { melDistance, type Image } from './views.ts';
import { zoneWindow, type Zone } from './zones.ts';
import type { SampleBank } from './synth.ts';
import { SAMPLE_RATE } from './sound.ts';
import { mixdown } from './render.ts';

export const PITCH_TOLERANCE_CENTS = 10;
export const LEVEL_STEP_LU = 3;
export const FAR_FROM_ROOT = 7;
/** The velocity zones are played at for the level and pitch measurements. */
const MEASURE_VEL = 100;
const MEASURE_GATE = 0.6;

export interface InstrumentFinding {
  check: 'coverage' | 'pitch' | 'level' | 'loop-seam' | 'distance' | 'round-robin' | 'release' | 'samples';
  severity: 'fail' | 'warn';
  /** Zones (counted from 1) the finding is about. */
  zones: number[];
  message: string;
}

export interface ZoneReport {
  /** 1-based. */
  index: number;
  /** Cents the zone sounds above (+) or below (-) its root when the root is played; null when not pitched or not measured. */
  pitchCents: number | null;
  /** Loudness of the zone played alone, LUFS; null when silent. */
  lufs: number | null;
  /** Severity of the worst finding about it. */
  status: 'ok' | 'warn' | 'fail';
}

export interface InstrumentCheck {
  id: string;
  /** No `fail`. */
  pass: boolean;
  findings: InstrumentFinding[];
  zones: ZoneReport[];
}

const chroma = (cents: number): number => {
  let c = cents % 1200;
  if (c > 600) c -= 1200;
  if (c < -600) c += 1200;
  return c;
};

/** The instrument with only this zone, played by every key and velocity, as an attack zone: how the zone sounds by itself. */
function alone(inst: Instrument, z: Zone, asAttack = false): Instrument {
  const i = cloneInstrument(inst);
  i.voice.layers = [];
  i.zones = [{ ...z, rr: null, keys: [0, 127], vel: [1, 127], ...(asAttack ? { trigger: 'attack' as const } : {}) }];
  delete i.velxfade;
  return i;
}

function runs(ok: boolean[]): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  ok.forEach((v, k) => {
    if (v && start < 0) start = k;
    if ((!v || k === ok.length - 1) && start >= 0) { out.push([start, v ? k : k - 1]); start = -1; }
  });
  return out;
}

/** Check a sampled instrument against the samples it plays. */
export function checkInstrument(inst: Instrument, bank: SampleBank, style: Style = DEFAULT_STYLE): InstrumentCheck {
  const zones = inst.zones ?? [];
  const findings: InstrumentFinding[] = [];
  const report: ZoneReport[] = zones.map((_, k) => ({ index: k + 1, pitchCents: null, lufs: null, status: 'ok' }));
  const flag = (f: InstrumentFinding): void => {
    findings.push(f);
    for (const n of f.zones) {
      const r = report[n - 1]!;
      if (f.severity === 'fail') r.status = 'fail';
      else if (r.status === 'ok') r.status = 'warn';
    }
  };
  if (!zones.length) {
    return { id: inst.id, pass: true, findings: [{ check: 'coverage', severity: 'warn', zones: [], message: `${inst.id} has no zones (instrument zone add ${inst.id} sample=<name> root=<note> keys=<lo>-<hi>)` }], zones: report };
  }
  const missing = [...new Set(zones.filter((z) => !bank.get(z.sample)).map((z) => z.sample))];
  zones.forEach((z, k) => { if (!bank.get(z.sample)) flag({ check: 'samples', severity: 'fail', zones: [k + 1], message: `zone ${k + 1} plays sample ${z.sample}, which is not in the project` }); });
  void missing;
  const here = (k: number): boolean => !!bank.get(zones[k]!.sample);

  // coverage: the keys of the declared range, by velocity
  const keyed = zones.map((z, k) => ({ z, k })).filter(({ z }) => z.hit === null && z.trigger === 'attack');
  if (keyed.length && inst.range) {
    const [lo, hi] = inst.range;
    const gaps = new Map<string, number[]>();
    for (let m = lo; m <= hi; m++) {
      const covered = new Array<boolean>(128).fill(false);
      for (const { z } of keyed) if (m >= z.keys[0] && m <= z.keys[1]) for (let v = z.vel[0]; v <= z.vel[1]; v++) covered[v] = true;
      const holes = runs(covered.slice(1).map((c) => !c)).map(([a, b]) => `${a + 1}-${b + 1}`).join(',');
      if (holes) gaps.set(holes, [...(gaps.get(holes) ?? []), m]);
    }
    for (const [holes, ms] of gaps) {
      for (const [a, b] of runs(Array.from({ length: hi - lo + 1 }, (_, i) => ms.includes(lo + i)))) {
        const from = lo + a, to = lo + b;
        const whole = holes === '1-127';
        flag({ check: 'coverage', severity: 'fail', zones: [], message: `${from === to ? `key ${noteLabel(from)}` : `keys ${noteLabel(from)}-${noteLabel(to)}`} ${whole ? 'have no zone' : `have no zone for velocities ${holes}`} (the range is ${noteLabel(lo)}-${noteLabel(hi)}): add a zone or widen one` });
      }
    }
  }

  // each pitched zone alone at its root: pitch and loudness
  const rule = pitchCheckOf(inst);
  // zones that differ only in the keys and velocities they answer to sound the same alone: each sound is measured once
  const memo = new Map<string, { l: number | null; cents: number | null }>();
  zones.forEach((z, k) => {
    if (!here(k)) return;
    const midi = z.hit !== null ? inst.root : z.root;
    const alike = JSON.stringify([{ ...z, rr: null, keys: 0, vel: 0, trigger: 'attack', choke: 0 }, midi]);
    let got = memo.get(alike);
    if (!got) {
      const chs = renderNote(alone(inst, z, true), { midi, gate: MEASURE_GATE, vel: MEASURE_VEL, hit: z.hit }, bank);
      const lufs = integratedLoudness(chs);
      const l = Number.isFinite(lufs) ? lufs : null;
      let cents: number | null = null;
      if (l !== null && z.hit === null && rule !== 'onset' && z.loopmode !== 'oneshot') {
        const m = measureSample(chs.map((c) => c), SAMPLE_RATE, { maxSeconds: 4 });
        if (m.pitch && m.pitch.confidence >= 0.5) cents = (m.pitch.midi - z.root) * 100 + m.pitch.cents;
      }
      got = { l, cents };
      memo.set(alike, got);
    }
    const { l } = got;
    report[k]!.lufs = l;
    if (l === null) { flag({ check: 'samples', severity: 'warn', zones: [k + 1], message: `zone ${k + 1} (${z.sample}) is silent when played` }); return; }
    if (got.cents === null) return;
    const err = rule === 'class' ? chroma(got.cents) : got.cents;
    report[k]!.pitchCents = Math.round(err * 10) / 10;
    if (Math.abs(err) > PITCH_TOLERANCE_CENTS) {
      flag({ check: 'pitch', severity: 'fail', zones: [k + 1], message: `zone ${k + 1} (${z.sample}) sounds ${err > 0 ? '+' : ''}${err.toFixed(0)} cents from its root ${noteLabel(z.root)}${rule === 'class' ? ' by pitch class' : ''}: set tune=${Math.round(z.tune - err)} (instrument zone set ${inst.id} ${k + 1} tune=…), or check the root` });
    }
  });

  // level: neighbours by key (same velocity range) and by velocity (same keys)
  const pitched = keyed.filter(({ k }) => report[k]!.lufs !== null);
  const step = (a: number, b: number, what: string): void => {
    const d = Math.abs(report[a]!.lufs! - report[b]!.lufs!);
    if (d > LEVEL_STEP_LU) flag({ check: 'level', severity: 'fail', zones: [a + 1, b + 1], message: `${what} zones ${a + 1} and ${b + 1} differ by ${d.toFixed(1)} LU when played alone at the same velocity (over ${LEVEL_STEP_LU}): set gain on one (instrument zone set ${inst.id} ${report[a]!.lufs! > report[b]!.lufs! ? a + 1 : b + 1} gain=${(report[a]!.lufs! > report[b]!.lufs! ? -d : d).toFixed(1)}...)` });
  };
  const groups = new Map<string, typeof pitched>();
  for (const e of pitched) groups.set(`${e.z.vel.join('-')}`, [...(groups.get(`${e.z.vel.join('-')}`) ?? []), e]);
  for (const g of groups.values()) {
    const sorted = [...g].sort((a, b) => a.z.keys[0] - b.z.keys[0] || a.k - b.k);
    for (let i = 1; i < sorted.length; i++) if (sorted[i]!.z.keys[0] > sorted[i - 1]!.z.keys[0]) step(sorted[i - 1]!.k, sorted[i]!.k, 'neighbouring');
  }
  const byKeys = new Map<string, typeof pitched>();
  for (const e of pitched) byKeys.set(`${e.z.keys.join('-')}`, [...(byKeys.get(`${e.z.keys.join('-')}`) ?? []), e]);
  for (const g of byKeys.values()) {
    const sorted = [...g].sort((a, b) => a.z.vel[0] - b.z.vel[0] || a.k - b.k);
    for (let i = 1; i < sorted.length; i++) if (sorted[i]!.z.vel[0] > sorted[i - 1]!.z.vel[0] && sorted[i]!.z.vel[0] === sorted[i - 1]!.z.vel[1] + 1) step(sorted[i - 1]!.k, sorted[i]!.k, 'velocity-layer');
  }

  // loop seams
  zones.forEach((z, k) => {
    const smp = bank.get(z.sample);
    if (!smp || z.loopmode === 'none' || z.loopmode === 'oneshot' || z.loop === null) return;
    let s: number, e: number;
    if (z.loop === 'sample') {
      if (!smp.loop || smp.loop[1] <= smp.loop[0]) return;
      [s, e] = smp.loop;
    } else {
      const w = zoneWindow(z, smp);
      const origin = (w.a * smp.rate) / SAMPLE_RATE;
      s = Math.round(origin + z.loop[0] * smp.rate);
      e = Math.round(origin + z.loop[1] * smp.rate);
    }
    const sm = loopSeam(smp.data, smp.rate, s, e);
    const bad: string[] = [];
    if (sm.clickDb > LOOP_CLICK_OK) bad.push(`a click (${sm.clickDb.toFixed(1)} dB over the signal's own change; ok up to ${LOOP_CLICK_OK})`);
    if (Math.abs(sm.levelStepDb) > LOOP_LEVEL_OK) bad.push(`a level step of ${sm.levelStepDb.toFixed(1)} dB (ok up to ${LOOP_LEVEL_OK})`);
    if (sm.spectralJump > LOOP_SPECTRAL_OK) bad.push(`a spectral jump of ${sm.spectralJump.toFixed(2)} (ok up to ${LOOP_SPECTRAL_OK})`);
    if (bad.length) flag({ check: 'loop-seam', severity: 'fail', zones: [k + 1], message: `zone ${k + 1} (${z.sample}) loops ${s}-${e} with ${bad.join(', ')}: sample loop ${z.sample} find looks for a better loop (the crossfade softens a click, not a level step)` });
  });

  // distance from the root
  keyed.forEach(({ z, k }) => {
    if (rule === 'onset') return;
    const far = Math.max(Math.abs(z.keys[0] - z.root), Math.abs(z.keys[1] - z.root));
    if (far > FAR_FROM_ROOT) flag({ check: 'distance', severity: 'warn', zones: [k + 1], message: `zone ${k + 1} (${z.sample}) plays keys ${noteLabel(z.keys[0])}-${noteLabel(z.keys[1])}, up to ${far} semitones from its root ${noteLabel(z.root)} (over ${FAR_FROM_ROOT}): a sample stretched that far loses its character; add a zone nearer` });
  });

  // round robins: takes that share keys, velocities and trigger
  const rrSets = new Map<string, number[]>();
  zones.forEach((z, k) => { if (z.rr && here(k)) rrSets.set(`${z.keys.join('-')}|${z.vel.join('-')}|${z.hit ?? ''}|${z.trigger}`, [...(rrSets.get(`${z.keys.join('-')}|${z.vel.join('-')}|${z.hit ?? ''}|${z.trigger}`) ?? []), k]); });
  for (const ks of rrSets.values()) {
    if (ks.length < 2) continue;
    const specs = ks.map((k) => {
      const z = zones[k]!;
      return melSpectrogram(mixdown(renderNote(alone(inst, z, true), { midi: z.hit !== null ? inst.root : z.root, gate: 0.4, vel: MEASURE_VEL, hit: z.hit }, bank)), { hop: 128 });
    });
    for (let a = 0; a < ks.length; a++) for (let b = a + 1; b < ks.length; b++) {
      const d = melDistance(specs[a]!, specs[b]!).spectralDb;
      if (d < style.setSpreadMin) flag({ check: 'round-robin', severity: 'warn', zones: [ks[a]! + 1, ks[b]! + 1], message: `round-robin takes ${ks[a]! + 1} and ${ks[b]! + 1} are only ${d.toFixed(1)} dB apart (too alike: at least ${style.setSpreadMin}): the repeat will be heard as the same hit` });
      if (d > style.setSpreadMax) flag({ check: 'round-robin', severity: 'warn', zones: [ks[a]! + 1, ks[b]! + 1], message: `round-robin takes ${ks[a]! + 1} and ${ks[b]! + 1} are ${d.toFixed(1)} dB apart (too different: at most ${style.setSpreadMax}): they will not read as one sound` });
    }
  }

  // a release zone louder than the attack it follows
  zones.forEach((z, k) => {
    if (z.trigger !== 'release' || report[k]!.lufs === null) return;
    const att = zones.map((a, i) => ({ a, i })).filter(({ a, i }) => a.trigger === 'attack' && a.hit === z.hit && report[i]!.lufs !== null && a.keys[0] <= z.keys[1] && a.keys[1] >= z.keys[0] && a.vel[0] <= z.vel[1] && a.vel[1] >= z.vel[0]);
    if (!att.length) return;
    const loudest = Math.max(...att.map(({ i }) => report[i]!.lufs!));
    if (report[k]!.lufs! > loudest) flag({ check: 'release', severity: 'warn', zones: [k + 1, ...att.map(({ i }) => i + 1)], message: `release zone ${k + 1} (${z.sample}) is ${(report[k]!.lufs! - loudest).toFixed(1)} LU louder than the attack it follows: lower its gain, or raise release-decay` });
  });

  return { id: inst.id, pass: !findings.some((f) => f.severity === 'fail'), findings, zones: report };
}

/** The check in words, one finding to a line. */
export function instrumentCheckLines(r: InstrumentCheck): string[] {
  const head = `${r.id}: ${r.pass ? 'pass' : 'FAIL'}, ${r.zones.length} zone${r.zones.length === 1 ? '' : 's'}, ${r.findings.filter((f) => f.severity === 'fail').length} fault${r.findings.filter((f) => f.severity === 'fail').length === 1 ? '' : 's'}, ${r.findings.filter((f) => f.severity === 'warn').length} warning${r.findings.filter((f) => f.severity === 'warn').length === 1 ? '' : 's'}`;
  return [head, ...r.findings.map((f) => `  ${f.severity === 'fail' ? 'FAIL' : 'warn'} ${f.check}: ${f.message}`)];
}

// ---- the key-map view ----------------------------------------------------------------------------------------------------

const BG: Rgb = [20, 22, 28];
const GRID: Rgb = [46, 50, 60];
const GRID2: Rgb = [78, 84, 98];
const TEXT: Rgb = [190, 196, 208];
const DIM: Rgb = [120, 126, 140];
const OK: Rgb = [100, 210, 130];
const WARN: Rgb = [240, 190, 70];
const FAIL: Rgb = [235, 80, 80];
const RELEASE: Rgb = [92, 140, 230];
const COLOUR: Record<ZoneReport['status'], Rgb> = { ok: OK, warn: WARN, fail: FAIL };
const dim = (c: Rgb, f: number): Rgb => [Math.round(c[0] * f), Math.round(c[1] * f), Math.round(c[2] * f)];

/** Keys across, velocity up; zones are boxes labelled with their sample, root, measured pitch error and level, coloured by their worst finding. */
export function keymapView(inst: Instrument, check?: InstrumentCheck): Image {
  const zones = inst.zones ?? [];
  const keyZones = zones.map((z, k) => ({ z, k })).filter(({ z }) => z.hit === null);
  const hits = [...new Set(zones.filter((z) => z.hit !== null).map((z) => z.hit!))];
  const lo = Math.max(0, Math.min(inst.range?.[0] ?? 127, ...keyZones.map(({ z }) => z.keys[0])) - 0);
  const hi = Math.min(127, Math.max(inst.range?.[1] ?? 0, ...keyZones.map(({ z }) => z.keys[1])));
  const a = keyZones.length ? Math.min(lo, hi) : 36, b = keyZones.length ? Math.max(lo, hi) : 84;
  const W = 1000, LEFT = 48, RIGHT = 14, TOP = 26;
  const gridW = W - LEFT - RIGHT;
  const gridH = 300;
  const hitRows = hits.length;
  const H = TOP + gridH + 40 + (hitRows ? 18 * hitRows + 18 : 0);
  const c = new Canvas(W, H, BG);
  const keyW = gridW / (b - a + 1);
  const xOf = (m: number): number => LEFT + (m - a) * keyW;
  const yOf = (v: number): number => TOP + gridH - (v / 128) * gridH;
  c.text(`${inst.id} KEY-MAP  ${zones.length} ZONES${check ? (check.pass ? '  PASS' : '  FAIL') : ''}`, LEFT, 8, TEXT);
  for (let m = a; m <= b; m++) if (m % 12 === 0 || m === a) c.vline(Math.round(xOf(m)), TOP, TOP + gridH, m % 12 === 0 ? GRID2 : GRID);
  for (const v of [32, 64, 96, 127]) { c.hline(LEFT, W - RIGHT, Math.round(yOf(v)), GRID); c.text(String(v), LEFT - 6, yOf(v) - 3, DIM, { align: 'right' }); }
  for (let m = a; m <= b; m++) if (m % 12 === 0) c.text(noteLabel(m), xOf(m) + 2, TOP + gridH + 6, DIM);
  if (inst.range) {
    c.hline(xOf(inst.range[0]), xOf(inst.range[1] + 1), TOP + gridH + 22, DIM);
    c.text(`RANGE ${noteLabel(inst.range[0])}-${noteLabel(inst.range[1])}`, xOf(inst.range[0]), TOP + gridH + 26, DIM);
  }
  const stackOf = new Map<string, number>();
  for (const { z, k } of keyZones) {
    const st = check?.zones[k]?.status ?? 'ok';
    const col = z.trigger === 'release' ? RELEASE : COLOUR[st];
    const sk = `${z.keys.join('-')}|${z.vel.join('-')}|${z.trigger}`;
    const n = stackOf.get(sk) ?? 0;
    stackOf.set(sk, n + 1);
    const x0 = xOf(z.keys[0]) + n * 2, x1 = xOf(z.keys[1] + 1) - 1 + n * 2;
    const y0 = yOf(z.vel[1] + 1) + n * 2, y1 = yOf(z.vel[0]) - 1 + n * 2;
    c.rect(x0, y0, x1 - x0, y1 - y0, dim(col, 0.28));
    c.hline(Math.round(x0), Math.round(x1), Math.round(y0), col, z.trigger === 'release' ? 3 : 0);
    c.hline(Math.round(x0), Math.round(x1), Math.round(y1), col, z.trigger === 'release' ? 3 : 0);
    c.vline(Math.round(x0), Math.round(y0), Math.round(y1), col, z.trigger === 'release' ? 3 : 0);
    c.vline(Math.round(x1), Math.round(y0), Math.round(y1), col, z.trigger === 'release' ? 3 : 0);
    const rep = check?.zones[k];
    const room = Math.floor((x1 - x0 - 4) / 6);
    const lines = [`${k + 1} ${z.sample}`, `ROOT ${noteLabel(z.root)}${rep?.pitchCents != null ? ` ${rep.pitchCents > 0 ? '+' : ''}${rep.pitchCents}C` : ''}`, `${z.trigger === 'release' ? 'REL ' : ''}${z.loopmode !== 'sustain' ? z.loopmode.toUpperCase() + ' ' : ''}${z.rr ? `RR${z.rr[0]}/${z.rr[1]} ` : ''}${rep?.lufs != null ? `${rep.lufs.toFixed(0)}LU` : ''}`];
    lines.forEach((t, i) => { if (y1 - y0 > 10 + i * 9 && room > 3) c.text(t.slice(0, room), x0 + 3, y0 + 3 + i * 9, TEXT); });
  }
  if (hitRows) {
    let y = TOP + gridH + 40;
    c.text('HITS', LEFT, y - 12, DIM);
    for (const h of hits) {
      const zs = zones.map((z, k) => ({ z, k })).filter(({ z }) => z.hit === h);
      const worst = zs.some(({ k }) => check?.zones[k]?.status === 'fail') ? 'fail' : zs.some(({ k }) => check?.zones[k]?.status === 'warn') ? 'warn' : 'ok';
      c.rect(LEFT, y, 14, 12, dim(COLOUR[worst], 0.5));
      c.text(`${h}  ${zs.map(({ z, k }) => `${k + 1} ${z.sample}${z.rr ? ` RR${z.rr[0]}/${z.rr[1]}` : ''}${z.choke ? ` CHOKE ${z.choke}` : ''}`).join('   ')}`, LEFT + 20, y + 3, TEXT);
      y += 18;
    }
  }
  c.text('GREEN OK  AMBER WARNING  RED FAULT  BLUE RELEASE (DASHED)', LEFT, H - 10, DIM);
  return { png: c.png(), width: W, height: H };
}
