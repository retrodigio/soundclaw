// The music views as PNG images.
//   notes  per channel: the written notes (bars), the detected onsets (ticks) and the detected pitch (dots);
//          a note that differs from what was heard is drawn red
//   mix    per channel: energy by band over time (rows low to high), the stretches where two channels share
//          their loudest band outlined in amber

import { Canvas, type Rgb } from './png.ts';
import { INFERNO, ramp, type Image } from './views.ts';
import { BANDS, type BandMap, type RenderMatchResult } from './musicchecks.ts';
import type { SongRender } from './songrender.ts';
import type { SongDoc } from './song.ts';
import { noteLabel } from './music.ts';

const BG: Rgb = [20, 22, 28];
const GRID: Rgb = [46, 50, 60];
const TEXT: Rgb = [190, 196, 208];
const DIM: Rgb = [120, 126, 140];
const BLUE: Rgb = [92, 140, 230];
const BLUE_FILL: Rgb = [48, 78, 130];
const GREEN: Rgb = [100, 210, 130];
const YELLOW: Rgb = [250, 220, 90];
const RED: Rgb = [235, 80, 80];
const AMBER: Rgb = [240, 190, 70];

const W = 1000;
const LEFT = 78;
const RIGHT = 14;
const TOP = 22;

function niceStep(duration: number): number {
  const steps = [0.1, 0.25, 0.5, 1, 2, 4, 5, 10, 15, 30, 60];
  return steps.find((s) => duration / s <= 12) ?? 60;
}

function ruler(c: Canvas, x0: number, w: number, y: number, from: number, to: number): void {
  const step = niceStep(to - from);
  for (let t = Math.ceil(from / step) * step; t <= to + 1e-9; t += step) {
    const x = x0 + ((t - from) / (to - from)) * (w - 1);
    c.vline(Math.round(x), y, y + 3, DIM);
    c.text(`${Number(t.toFixed(2))}`, x, y + 6, DIM, { align: 'center' });
  }
}

export interface MusicViewOptions {
  /** Seconds of the song to draw (default: all). */
  from?: number;
  to?: number;
  /** Only these channels. */
  channels?: readonly string[];
}

/** The notes view: the written notes against what the rendered channel sounds like. */
export function notesView(song: SongDoc, render: SongRender, match: RenderMatchResult, o: MusicViewOptions = {}): Image {
  const from = o.from ?? 0;
  const to = o.to ?? render.length / 44100;
  const names = render.parts.map((p) => p.name).filter((n) => !o.channels || o.channels.includes(n));
  const rows = names.map((n) => {
    const ev = (render.events.get(n) ?? []).filter((e) => e.t + e.len >= from && e.t <= to);
    const pitched = ev.filter((e) => e.midi !== null).map((e) => e.midi!);
    const track = (match.pitch.get(n) ?? []).filter((f) => f.hz !== null && f.t >= from && f.t <= to).map((f) => 69 + 12 * Math.log2(f.hz! / 440));
    const all = [...pitched, ...track.filter((m) => m > 0 && m < 128)];
    const lo = all.length ? Math.floor(Math.min(...pitched, ...(pitched.length ? [] : all)) - 2) : 0;
    const hi = all.length ? Math.ceil(Math.max(...pitched, ...(pitched.length ? [] : all)) + 2) : 12;
    return { n, ev, pitched: pitched.length > 0, lo: Math.max(0, Math.min(lo, hi - 8)), hi: Math.max(hi, lo + 8) };
  });
  const rowH = (r: { pitched: boolean; lo: number; hi: number }): number => (r.pitched ? Math.max(70, Math.min(150, (r.hi - r.lo) * 6)) : 34);
  const H = TOP + rows.reduce((a, r) => a + rowH(r) + 8, 0) + 30;
  const c = new Canvas(W, H, BG);
  const w = W - LEFT - RIGHT;
  const xOf = (t: number): number => LEFT + ((t - from) / (to - from)) * (w - 1);
  const bad = match.notes.filter((m) => !m.ok).length;
  c.text(`NOTES  ${song.id}  ${from.toFixed(1)}-${to.toFixed(1)} S`, LEFT, 7, TEXT);
  c.text(bad ? `${bad} NOTES DIFFER` : 'EVERY NOTE AS WRITTEN', W - RIGHT, 7, bad ? RED : GREEN, { align: 'right' });
  let y = TOP;
  for (const r of rows) {
    const h = rowH(r);
    c.rect(LEFT, y, w, h, [26, 29, 37]);
    c.text(r.n, LEFT - 6, y + 4, TEXT, { align: 'right' });
    const m = match.notes.filter((x) => x.channel === r.n);
    if (r.pitched) {
      const yOf = (midi: number): number => y + h - ((midi - r.lo + 0.5) / (r.hi - r.lo + 1)) * h;
      for (let n = r.lo; n <= r.hi; n++) if (n % 12 === 0) { c.hline(LEFT, LEFT + w - 1, Math.round(yOf(n)), GRID); c.text(noteLabel(n), LEFT - 6, Math.round(yOf(n)) - 3, DIM, { align: 'right' }); }
      for (const e of r.ev) {
        if (e.midi === null) continue;
        const mm = m.find((x) => x.midi === e.midi && Math.abs(x.t - e.t) < 1e-6);
        const x0 = xOf(Math.max(from, e.t)), x1 = xOf(Math.min(to, e.t + e.len));
        const yy = yOf(e.midi);
        const wrong = mm && !mm.ok;
        c.rect(x0, yy - 3, Math.max(2, x1 - x0), 6, wrong ? [120, 40, 40] : BLUE_FILL);
        c.hline(x0, Math.max(x0 + 1, x1), Math.round(yy - 3), wrong ? RED : BLUE);
        c.hline(x0, Math.max(x0 + 1, x1), Math.round(yy + 2), wrong ? RED : BLUE);
      }
      for (const f of match.pitch.get(r.n) ?? []) {
        if (f.hz === null || f.t < from || f.t > to) continue;
        const mid = 69 + 12 * Math.log2(f.hz / 440);
        if (mid < r.lo - 1 || mid > r.hi + 1) continue;
        c.set(xOf(f.t), yOf(mid), YELLOW);
      }
    }
    for (const e of r.ev) if (e.midi === null) c.rect(xOf(e.t), y + 14, 2, 14, BLUE);
    for (const t of match.onsets.get(r.n) ?? []) if (t >= from && t <= to) c.vline(Math.round(xOf(t)), y + h - 6, y + h - 1, GREEN);
    for (const x of m) if (!x.ok && x.t >= from && x.t <= to) c.vline(Math.round(xOf(x.t)), y, y + h - 1, RED, 2);
    y += h + 8;
  }
  ruler(c, LEFT, w, y - 4, from, to);
  c.text('BLUE WRITTEN  YELLOW HEARD PITCH  GREEN HEARD ONSET  RED DIFFERS', LEFT, H - 10, DIM);
  return { png: c.png(), width: W, height: H };
}

/** The mix view: each channel's energy by band over time. */
export function mixView(song: SongDoc, map: BandMap, duration: number, o: MusicViewOptions = {}): Image {
  const from = o.from ?? 0;
  const to = o.to ?? duration;
  const chans = map.channels.filter((ch) => !o.channels || o.channels.includes(ch.name));
  const bandH = 6;
  const rowH = BANDS.length * bandH + 8;
  const H = TOP + 14 + chans.length * rowH + 40;
  const c = new Canvas(W, H, BG);
  const w = W - LEFT - RIGHT;
  c.text(`MIX  ${song.id}  ${from.toFixed(1)}-${to.toFixed(1)} S`, LEFT, 7, TEXT);
  const f0 = Math.floor(from / map.hop), f1 = Math.min(map.frames - 1, Math.ceil(to / map.hop));
  let top = -200;
  for (const ch of chans) for (const row of ch.db) for (const v of row) if (v > top) top = v;
  const xOf = (t: number): number => LEFT + ((t - from) / (to - from)) * (w - 1);
  // the masked stretches, as a strip on top
  const stripY = TOP;
  c.rect(LEFT, stripY, w, 8, [26, 29, 37]);
  for (let f = f0; f <= f1; f++) {
    const m = map.masked[f];
    if (!m) continue;
    c.rect(xOf(f * map.hop), stripY, Math.max(1, xOf((f + 1) * map.hop) - xOf(f * map.hop)), 8, AMBER);
  }
  c.text('MASKING', LEFT - 6, stripY + 1, AMBER, { align: 'right' });
  let y = TOP + 14;
  for (const ch of chans) {
    c.text(ch.name, LEFT - 6, y + 2, TEXT, { align: 'right' });
    BANDS.forEach((b, bi) => {
      const yy = y + (BANDS.length - 1 - bi) * bandH;
      for (let f = f0; f <= f1; f++) {
        const v = ch.db[bi]![f]!;
        const u = Math.max(0, Math.min(1, (v - (top - 60)) / 60));
        const x0 = xOf(f * map.hop), x1 = xOf((f + 1) * map.hop);
        c.rect(x0, yy, Math.max(1, x1 - x0), bandH - 1, ramp(INFERNO, u));
        const m = map.masked[f];
        if (m && (m.a === ch.name || m.b === ch.name) && m.band === b.name) c.rect(x0, yy, Math.max(1, x1 - x0), 1, AMBER);
      }
    });
    y += rowH;
  }
  ruler(c, LEFT, w, y - 4, from, to);
  c.text('ROWS LOW TO HIGH: SUB LOW MID HIGH AIR   AMBER: TWO CHANNELS SHARE THE BAND', LEFT, H - 10, DIM);
  return { png: c.png(), width: W, height: H };
}
