// The views: images of a sound an agent can be shown (PNG, drawn here with no native libraries).
// `wave`, `spec` (mel spectrogram with note and Hz rulers), `pitch` (YIN track over a note grid)
// and `compare` (two sounds and the difference between them, with distance numbers).

import { analyze, hzToMel, hzToMidi, melSpectrogram, melToHz, midiName, midiToHz, noteName, rmsEnvelope, type Analysis, type MelSpec, type Samples } from './analysis.ts';
import { Canvas, type Rgb } from './png.ts';
import { SAMPLE_RATE } from './sound.ts';

export type ViewKind = 'wave' | 'spec' | 'pitch';
export const VIEW_KINDS: readonly (ViewKind | 'compare' | 'layers')[] = ['wave', 'spec', 'pitch', 'layers', 'compare'];

export interface Image {
  png: Uint8Array;
  width: number;
  height: number;
}

const BG: Rgb = [20, 22, 28];
const GRID: Rgb = [46, 50, 60];
const GRID2: Rgb = [78, 84, 98];
const TEXT: Rgb = [190, 196, 208];
const DIM: Rgb = [120, 126, 140];
const TEAL: Rgb = [88, 196, 166];
const TEAL_DIM: Rgb = [50, 120, 104];
const RED: Rgb = [235, 80, 80];
const AMBER: Rgb = [240, 190, 70];

const W = 900;
const LEFT = 62;
const RIGHT = 46;
const TOP = 22;
const BOTTOM = 26;

const fmtHz = (f: number): string => (f >= 1000 ? `${f / 1000}K` : String(f));

/** Time-ruler tick spacing (seconds) giving about 8 ticks. */
function niceStep(duration: number): number {
  const steps = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];
  return steps.find((s) => duration / s <= 9) ?? 10;
}

function timeRuler(c: Canvas, x0: number, w: number, y: number, duration: number): void {
  const step = niceStep(duration);
  for (let t = 0; t <= duration + 1e-9; t += step) {
    const x = x0 + (t / duration) * (w - 1);
    c.vline(Math.round(x), y, y + 3, DIM);
    c.text(`${Number(t.toFixed(3))}${t === 0 ? ' S' : ''}`, x, y + 6, DIM, { align: x > x0 + w - 20 ? 'right' : x === x0 ? 'left' : 'center' });
  }
}

function header(c: Canvas, left: string, right: string): void {
  c.text(left, LEFT, 7, TEXT);
  c.text(right, c.width - RIGHT, 7, DIM, { align: 'right' });
}

// ---- wave --------------------------------------------------------------------------------------

export function waveView(x: Samples, a: Analysis, title = ''): Image {
  const H = 300;
  const c = new Canvas(W, H, BG);
  const px = LEFT, pw = W - LEFT - RIGHT, py = TOP, ph = H - TOP - BOTTOM;
  const mid = py + ph / 2;
  header(c, `WAVE ${title}`, `${a.duration.toFixed(3)} S  PEAK ${Number.isFinite(a.peakDb) ? a.peakDb.toFixed(1) : '-INF'} DB  TRUE ${Number.isFinite(a.truePeakDb) ? a.truePeakDb.toFixed(1) : '-INF'} DBTP`);
  for (const v of [-1, -0.5, 0, 0.5, 1]) {
    const y = mid - v * (ph / 2 - 1);
    c.hline(px, px + pw - 1, Math.round(y), v === 0 ? GRID2 : GRID);
    c.text(v === 0 ? '0' : v > 0 ? `+${v}` : String(v), px - 5, y - 3, DIM, { align: 'right' });
  }
  const n = x.length;
  const env = rmsEnvelope(x, Math.max(1, Math.ceil(n / pw)), Math.max(1, Math.ceil(n / pw)));
  for (let col = 0; col < pw; col++) {
    const from = Math.floor((col * n) / pw);
    const to = Math.max(from + 1, Math.floor(((col + 1) * n) / pw));
    let lo = 0, hi = 0;
    for (let i = from; i < to && i < n; i++) { const v = x[i]!; if (v < lo) lo = v; if (v > hi) hi = v; }
    const top = mid - hi * (ph / 2 - 1);
    const bot = mid - lo * (ph / 2 - 1);
    c.vline(px + col, Math.round(top), Math.max(Math.round(bot), Math.round(top)), TEAL_DIM);
    const r = env[Math.min(env.length - 1, Math.floor((col * env.length) / pw))] ?? 0;
    c.vline(px + col, Math.round(mid - r * (ph / 2 - 1)), Math.round(mid + r * (ph / 2 - 1)), TEAL);
    if (Math.abs(hi) >= 0.9999 || Math.abs(lo) >= 0.9999) { c.vline(px + col, py - 6, py - 2, RED); c.vline(px + col, py + ph + 1, py + ph + 3, RED); }
  }
  if (a.peak > 0) {
    for (const s of [1, -1]) {
      const y = Math.round(mid - s * a.peak * (ph / 2 - 1));
      c.hline(px, px + pw - 1, y, AMBER, 4);
    }
  }
  timeRuler(c, px, pw, py + ph + 2, a.duration);
  return { png: c.png(), width: W, height: H };
}

// ---- spectrogram ---------------------------------------------------------------------------------

export const INFERNO: Rgb[] = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];

export function ramp(stops: readonly Rgb[], t: number): Rgb {
  const v = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(v));
  const f = v - i;
  const a = stops[i]!, b = stops[i + 1]!;
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
}

/** A diverging ramp for differences: blue when the first is louder, red when the second is, dark at zero. */
function diverge(t: number): Rgb {
  const m = Math.min(1, Math.abs(t));
  const zero: Rgb = [28, 30, 38];
  return t >= 0 ? ramp([zero, [235, 70, 50], [255, 230, 120]], m) : ramp([zero, [50, 110, 235], [140, 235, 255]], m);
}

export const SPEC_RANGE_DB = 80;

/** Level of a spectrogram's loudest cell, dB. */
export function specMax(s: MelSpec): number {
  let m = -Infinity;
  for (const row of s.db) for (const v of row) if (v > m) m = v;
  return m;
}

/** Draw a spectrogram's cells into the rectangle; `color(db, col, row)` picks each colour. */
function paintSpec(c: Canvas, s: MelSpec, x0: number, y0: number, w: number, h: number, duration: number, color: (col: number, band: number, frac: number) => Rgb): void {
  const bands = s.freqs.length;
  for (let col = 0; col < w; col++) {
    const t = (col / w) * duration;
    const frame = Math.round((t * SAMPLE_RATE) / s.hop);
    for (let row = 0; row < h; row++) {
      // row 0 is the top (highest band); interpolate between bands
      const pos = ((h - 1 - row) / (h - 1)) * (bands - 1);
      const b0 = Math.floor(pos);
      const frac = pos - b0;
      c.set(x0 + col, y0 + row, color(frame, b0, frac));
    }
  }
}

/** The frequency ruler: Hz on the left, note names on the right, dashed lines across. */
function freqRuler(c: Canvas, s: MelSpec, x0: number, y0: number, w: number, h: number): void {
  const m0 = hzToMel(s.freqs[0]!), m1 = hzToMel(s.freqs[s.freqs.length - 1]!);
  const yOf = (f: number): number => y0 + (h - 1) - ((hzToMel(f) - m0) / (m1 - m0)) * (h - 1);
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    if (f < s.freqs[0]! || f > s.freqs[s.freqs.length - 1]!) continue;
    const y = Math.round(yOf(f));
    c.hline(x0, x0 + w - 1, y, [255, 255, 255], 6);
    c.text(`${fmtHz(f)}`, x0 - 5, y - 3, TEXT, { align: 'right' });
  }
  for (let oct = 1; oct <= 8; oct++) {
    const f = midiToHz(12 * (oct + 1)); // C<oct>
    if (f < s.freqs[0]! || f > s.freqs[s.freqs.length - 1]!) continue;
    const y = Math.round(yOf(f));
    c.hline(x0 + w, x0 + w + 3, y, DIM);
    c.text(`C${oct}`, x0 + w + 6, y - 3, DIM);
  }
  c.text('HZ', x0 - 5, y0 - 12, DIM, { align: 'right' });
}

export function specView(x: Samples, a: Analysis, title = ''): Image {
  const H = 380;
  const c = new Canvas(W, H, BG);
  const px = LEFT, pw = W - LEFT - RIGHT, py = TOP, ph = H - TOP - BOTTOM;
  const spec = melSpectrogram(x, { hop: 128 });
  const top = specMax(spec);
  header(c, `SPECTROGRAM ${title}`, `${a.duration.toFixed(3)} S  RANGE ${SPEC_RANGE_DB} DB BELOW ${Number.isFinite(top) ? top.toFixed(0) : '-'} DB`);
  paintSpec(c, spec, px, py, pw, ph, a.duration, (frame, b, frac) => {
    const row = spec.db[Math.min(spec.db.length - 1, frame)]!;
    const v = row[b]! * (1 - frac) + row[Math.min(row.length - 1, b + 1)]! * frac;
    return ramp(INFERNO, (v - (top - SPEC_RANGE_DB)) / SPEC_RANGE_DB);
  });
  freqRuler(c, spec, px, py, pw, ph);
  timeRuler(c, px, pw, py + ph + 2, a.duration);
  return { png: c.png(), width: W, height: H };
}

// ---- pitch ---------------------------------------------------------------------------------------

export function pitchView(a: Analysis, title = ''): Image {
  const H = 320;
  const c = new Canvas(W, H, BG);
  const px = LEFT, pw = W - LEFT - RIGHT, py = TOP, ph = H - TOP - BOTTOM;
  const p = a.pitch;
  const voiced = p.track.filter((f) => f.hz !== null);
  const note = p.start !== null && p.end !== null ? `${noteName(p.start)} TO ${noteName(p.end)}` : 'NO PITCH FOUND';
  header(c, `PITCH ${title}`, `${a.duration.toFixed(3)} S  ${note}`);
  if (!voiced.length || p.min === null || p.max === null) {
    c.text('NOT CLEARLY PITCHED', px + pw / 2, py + ph / 2 - 4, DIM, { align: 'center', scale: 2 });
    timeRuler(c, px, pw, py + ph + 2, a.duration);
    return { png: c.png(), width: W, height: H };
  }
  let lo = Math.floor(hzToMidi(p.min)) - 3, hi = Math.ceil(hzToMidi(p.max)) + 3;
  while (hi - lo < 24) { lo--; hi++; }
  lo = Math.max(12, lo); hi = Math.min(120, hi);
  const yOf = (m: number): number => py + ph - 1 - ((m - lo) / (hi - lo)) * (ph - 1);
  const labelEvery = hi - lo <= 30 ? 1 : 12;
  for (let m = lo; m <= hi; m++) {
    const isC = m % 12 === 0;
    c.hline(px, px + pw - 1, Math.round(yOf(m)), isC ? GRID2 : GRID);
    if (isC || (labelEvery === 1 && ph / (hi - lo) >= 8)) c.text(midiName(m), px - 5, yOf(m) - 3, isC ? TEXT : DIM, { align: 'right' });
  }
  const xOf = (t: number): number => px + (t / a.duration) * (pw - 1);
  let prev: { x: number; y: number } | null = null;
  for (const f of p.track) {
    if (f.hz === null) { prev = null; continue; }
    const pt = { x: xOf(f.t), y: yOf(hzToMidi(f.hz)) };
    if (prev && pt.x - prev.x < 40) c.line(prev.x, prev.y, pt.x, pt.y, TEAL);
    c.rect(pt.x - 1, pt.y - 1, 3, 3, f.clarity > 0.95 ? TEAL : AMBER);
    prev = pt;
  }
  const first = voiced[0]!, last = voiced[voiced.length - 1]!;
  c.text(`${Math.round(first.hz!)} HZ`, xOf(first.t) + 5, yOf(hzToMidi(first.hz!)) - 12, TEXT);
  c.text(`${Math.round(last.hz!)} HZ`, xOf(last.t) - 5, yOf(hzToMidi(last.hz!)) + 7, TEXT, { align: 'right' });
  timeRuler(c, px, pw, py + ph + 2, a.duration);
  return { png: c.png(), width: W, height: H };
}

// ---- compare -------------------------------------------------------------------------------------

export interface Distance {
  /** Mean absolute difference between the two mel spectrograms over time and band (time axes as they are), dB. */
  spectralDb: number;
  /** The same on the time-averaged spectra, dB. */
  averageSpectrumDb: number;
  durationDiffS: number;
  loudnessDiffLu: number;
  truePeakDiffDb: number;
  centroidDiffHz: number;
  /** Semitones, second minus first; null when either is not pitched. */
  pitchStartDiffSt: number | null;
  pitchEndDiffSt: number | null;
  /** Correlation of the two loudness envelopes after stretching both to the same length (−1..1). */
  envelopeCorrelation: number;
}

function resampleEnv(x: Samples, n: number): number[] {
  const out: number[] = [];
  const step = Math.max(1, Math.floor(x.length / n));
  const env = rmsEnvelope(x, step * 2, step);
  for (let i = 0; i < n; i++) out.push(env[Math.min(env.length - 1, Math.floor((i * env.length) / n))] ?? 0);
  return out;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

export function distance(xa: Samples, xb: Samples, aa: Analysis, ab: Analysis, sa: MelSpec, sb: MelSpec): Distance {
  const ref = Math.max(specMax(sa), specMax(sb));
  const floor = ref - SPEC_RANGE_DB;
  const frames = Math.max(sa.db.length, sb.db.length);
  const bands = sa.freqs.length;
  const level = (s: MelSpec, f: number, b: number): number => (f < s.db.length ? Math.max(floor, s.db[f]![b]!) : floor);
  let sum = 0;
  const avgA = new Float64Array(bands), avgB = new Float64Array(bands);
  for (let f = 0; f < frames; f++) for (let b = 0; b < bands; b++) sum += Math.abs(level(sa, f, b) - level(sb, f, b));
  for (let f = 0; f < sa.db.length; f++) for (let b = 0; b < bands; b++) avgA[b] = avgA[b]! + level(sa, f, b) / sa.db.length;
  for (let f = 0; f < sb.db.length; f++) for (let b = 0; b < bands; b++) avgB[b] = avgB[b]! + level(sb, f, b) / sb.db.length;
  let avgSum = 0;
  for (let b = 0; b < bands; b++) avgSum += Math.abs(avgA[b]! - avgB[b]!);
  const st = (u: number | null, v: number | null): number | null => (u !== null && v !== null ? 12 * Math.log2(v / u) : null);
  return {
    spectralDb: sum / (frames * bands), averageSpectrumDb: avgSum / bands,
    durationDiffS: ab.duration - aa.duration, loudnessDiffLu: ab.lufs - aa.lufs, truePeakDiffDb: ab.truePeakDb - aa.truePeakDb,
    centroidDiffHz: ab.centroid.mean - aa.centroid.mean,
    pitchStartDiffSt: st(aa.pitch.start, ab.pitch.start), pitchEndDiffSt: st(aa.pitch.end, ab.pitch.end),
    envelopeCorrelation: pearson(resampleEnv(xa, 200), resampleEnv(xb, 200)),
  };
}

export function formatDistance(d: Distance, a: string, b: string): string {
  const sg = (v: number, unit: string, dp = 1): string => `${v >= 0 ? '+' : ''}${v.toFixed(dp)} ${unit}`;
  const st = (v: number | null): string => (v === null ? 'n/a' : sg(v, 'semitones'));
  return [
    `${b} compared with ${a} (positive: ${b} is more):`,
    `spectral distance ${d.spectralDb.toFixed(1)} dB (mean |difference| of the mel spectrograms); on the average spectra ${d.averageSpectrumDb.toFixed(1)} dB`,
    `duration ${sg(d.durationDiffS, 's', 3)}; loudness ${sg(d.loudnessDiffLu, 'LU')}; true peak ${sg(d.truePeakDiffDb, 'dB')}; brightness ${sg(d.centroidDiffHz, 'Hz', 0)}`,
    `pitch at the start ${st(d.pitchStartDiffSt)}, at the end ${st(d.pitchEndDiffSt)}; envelope correlation ${d.envelopeCorrelation.toFixed(2)}`,
  ].join('\n');
}

export function compareView(xa: Samples, xb: Samples, la: string, lb: string): { image: Image; distance: Distance; a: Analysis; b: Analysis } {
  const aa = analyze(xa), ab = analyze(xb);
  const sa = melSpectrogram(xa, { hop: 128 }), sb = melSpectrogram(xb, { hop: 128 });
  const duration = Math.max(aa.duration, ab.duration, 0.001);
  const panelH = 190;
  const H = TOP + 3 * panelH + 3 * 8 + BOTTOM;
  const c = new Canvas(W, H, BG);
  const px = LEFT, pw = W - LEFT - RIGHT;
  const ref = Math.max(specMax(sa), specMax(sb));
  const floor = ref - SPEC_RANGE_DB;
  const cell = (s: MelSpec, f: number, b: number, frac: number): number => {
    if (f >= s.db.length) return floor;
    const row = s.db[f]!;
    return Math.max(floor, row[b]! * (1 - frac) + row[Math.min(row.length - 1, b + 1)]! * frac);
  };
  header(c, `COMPARE ${la} AND ${lb}`, `${duration.toFixed(3)} S`);
  const panels: { y: number; label: string; color: (f: number, b: number, frac: number) => Rgb }[] = [
    { y: TOP, label: la, color: (f, b, fr) => ramp(INFERNO, (cell(sa, f, b, fr) - floor) / SPEC_RANGE_DB) },
    { y: TOP + panelH + 8, label: lb, color: (f, b, fr) => ramp(INFERNO, (cell(sb, f, b, fr) - floor) / SPEC_RANGE_DB) },
    { y: TOP + 2 * (panelH + 8), label: `DIFFERENCE ${lb} MINUS ${la}  RED: ${lb} LOUDER  BLUE: ${la} LOUDER  FULL COLOUR AT 30 DB`, color: (f, b, fr) => diverge((cell(sb, f, b, fr) - cell(sa, f, b, fr)) / 30) },
  ];
  for (const p of panels) {
    paintSpec(c, sa, px, p.y, pw, panelH, duration, (f, b, fr) => p.color(f, b, fr));
    freqRuler(c, sa, px, p.y, pw, panelH);
    c.text(p.label, px + 4, p.y + 4, [255, 255, 255]);
  }
  timeRuler(c, px, pw, panels[2]!.y + panelH + 2, duration);
  return { image: { png: c.png(), width: W, height: H }, distance: distance(xa, xb, aa, ab, sa, sb), a: aa, b: ab };
}


// ---- layers --------------------------------------------------------------------------------------

export interface LayerRow {
  /** `1 osc sine 60 Hz` */
  label: string;
  /** Seconds into the sound where the layer starts. */
  offset: number;
  /** `gain 0.9 pan -0.3 (muted)` */
  detail: string;
  /** The layer as it enters the sum, in the sound's timeline (stereo: the mix of the two). */
  samples: Samples;
}

/** Each layer's waveform and spectrogram, stacked on one time axis, with the layers' start offsets marked. */
export function layersView(rows: readonly LayerRow[], duration: number, title = ''): Image {
  const waveH = 44, specH = 52, gap = 10;
  const rowH = 12 + waveH + specH + gap;
  const H = TOP + Math.max(1, rows.length) * rowH + BOTTOM;
  const c = new Canvas(W, H, BG);
  const px = LEFT, pw = W - LEFT - RIGHT;
  header(c, `LAYERS ${title}`, `${rows.length} LAYER${rows.length === 1 ? '' : 'S'}  ${duration.toFixed(3)} S`);
  const specs = rows.map((r) => melSpectrogram(r.samples, { hop: 256 }));
  let top = -Infinity;
  for (const s of specs) top = Math.max(top, specMax(s));
  rows.forEach((r, i) => {
    const y0 = TOP + i * rowH;
    c.text(`${r.label}  ${r.detail}  STARTS ${r.offset.toFixed(3)} S`, px, y0 + 1, TEXT);
    const wy = y0 + 12, mid = wy + waveH / 2;
    c.hline(px, px + pw - 1, Math.round(mid), GRID);
    const n = r.samples.length;
    for (let col = 0; col < pw; col++) {
      const from = Math.floor((col * n) / pw);
      const to = Math.max(from + 1, Math.floor(((col + 1) * n) / pw));
      let lo = 0, hi = 0;
      for (let k = from; k < to && k < n; k++) { const v = r.samples[k]!; if (v < lo) lo = v; if (v > hi) hi = v; }
      const yTop = Math.round(mid - Math.min(1, hi) * (waveH / 2 - 1));
      c.vline(px + col, yTop, Math.max(Math.round(mid - Math.max(-1, lo) * (waveH / 2 - 1)), yTop), TEAL);
    }
    const sy = wy + waveH + 2;
    const s = specs[i]!;
    if (Number.isFinite(top)) {
      paintSpec(c, s, px, sy, pw, specH - 2, duration, (frame, b, frac) => {
        const row = s.db[Math.min(s.db.length - 1, frame)]!;
        const v = row[b]! * (1 - frac) + row[Math.min(row.length - 1, b + 1)]! * frac;
        return ramp(INFERNO, (v - (top - SPEC_RANGE_DB)) / SPEC_RANGE_DB);
      });
    }
    const ox = px + Math.round((r.offset / duration) * (pw - 1));
    c.vline(ox, y0 + 10, y0 + rowH - gap, AMBER, 3);
  });
  timeRuler(c, px, pw, TOP + Math.max(1, rows.length) * rowH - gap + 2, duration);
  return { png: c.png(), width: W, height: H };
}
