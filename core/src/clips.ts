// Audio clips in songs: a recorded, library or generated sample placed on a bar and a beat of an audio channel.
// A clip is played by the sample layer the renderer already has (the windowed sinc, the time stretch, the fades), so a
// clip sounds like the same sample on a layer; this file works out which layer: where the clip starts, how far the
// sample is stretched to fit the song's tempo, and how long it plays.

import { newLayeredSound, newLayer, type LayeredSound } from './layered.ts';
import { exp2 } from './mathx.ts';
import type { AudioClip, SongDoc } from './song.ts';
import type { SampleBank } from './synth.ts';

export const CLIP_ID_RE = /^\d{1,6}$/;
export const MAX_CLIPS = 512;
/** The most a sample is stretched (or squeezed) to fit a tempo, as a ratio of lengths; the layer's own limits. */
export const CLIP_STRETCH = { min: 0.25, max: 4 } as const;

/** Quarter-note beats in a bar. */
export const beatsPerBar = (time: readonly [number, number]): number => time[0] * (4 / time[1]);

/** `3` (bar 3), `3.2` (bar 3, beat 2): bars and beats count from 1. Returns quarter-note beats from the start of the song. */
export function parseAt(text: string, time: readonly [number, number]): number {
  const m = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) throw new Error(`at is a bar, or a bar and a beat: 3 (the start of bar 3) or 3.2 (beat 2 of bar 3); got '${text}'`);
  const bar = Number(m[1]), beat = m[2] === undefined ? 1 : Number(m[2]);
  const per = beatsPerBar(time);
  if (bar < 1) throw new Error('bars count from 1');
  if (beat < 1 || beat > Math.ceil(per)) throw new Error(`beats in a ${time[0]}/${time[1]} bar run from 1 to ${Math.ceil(per)} (got ${beat})`);
  return (bar - 1) * per + (beat - 1);
}

/** The position as bar.beat in the song's time signature (a fraction of a beat as a decimal). */
export function formatAt(beats: number, time: readonly [number, number]): string {
  const per = beatsPerBar(time);
  const bar = Math.floor(beats / per + 1e-9);
  const within = beats - bar * per;
  const beat = Math.floor(within + 1e-9);
  const frac = within - beat;
  const base = `${bar + 1}.${beat + 1}`;
  return frac > 1e-6 ? `${base}${String(Math.round(frac * 1e6) / 1e6).slice(1)}` : base;
}

/** The seconds a clip plays for and how it is made: the sample's trim, the stretch ratio and the layer's pitch. */
export interface ClipPlan {
  /** Seconds of the sample (after any slice) the clip plays, the part the layer reads. */
  from: number;
  to: number;
  /** Output length over input length (the layer's `stretch`). */
  ratio: number;
  /** The layer's pitch, semitones. */
  pitch: number;
  /** How long the clip is, seconds. */
  seconds: number;
}

/** The sample's own length in seconds (of the slice a clip plays, when it plays one). */
export function sampleSeconds(bank: SampleBank | undefined, clip: Pick<AudioClip, 'sample' | 'slice'>): number {
  const smp = bank?.get(clip.sample);
  if (!smp) return 0;
  const n = smp.data.length;
  if (clip.slice > 0) {
    const pts = smp.slices ?? [];
    if (clip.slice > pts.length) return 0;
    const a = pts[clip.slice - 1]!;
    const b = clip.slice < pts.length ? pts[clip.slice]! : n;
    return Math.max(0, b - a) / smp.rate;
  }
  return n / smp.rate;
}

export function planClip(song: Pick<SongDoc, 'tempo'>, clip: AudioClip, srcSeconds: number): ClipPlan {
  const rho = exp2(clip.pitch / 12);
  let ratio = 1;
  if (clip.stretch === 'tempo' && clip.fromTempo) ratio = (clip.fromTempo / song.tempo) * rho;
  ratio = Math.min(CLIP_STRETCH.max, Math.max(CLIP_STRETCH.min, ratio));
  // output seconds = source seconds x ratio / rho
  let from = 0, to = srcSeconds;
  if (clip.len !== null) {
    const want = (clip.len * 60) / song.tempo; // output seconds
    to = Math.min(srcSeconds, (want * rho) / ratio);
  }
  return { from, to, ratio, pitch: clip.pitch, seconds: Math.max(0, ((to - from) * ratio) / rho) };
}

/** How many seconds a clip is, given the bank (0 when its sample is missing). */
export function clipSeconds(song: Pick<SongDoc, 'tempo'>, clip: AudioClip, bank: SampleBank | undefined): number {
  return planClip(song, clip, sampleSeconds(bank, clip)).seconds;
}

/** The sound that plays one clip: a stereo sample layer, as long as the clip. */
export function clipSound(song: Pick<SongDoc, 'tempo'>, clip: AudioClip, bank: SampleBank | undefined): LayeredSound {
  const src = sampleSeconds(bank, clip);
  const plan = planClip(song, clip, src);
  const s = newLayeredSound('clip', 1);
  const l = newLayer('sample', 1);
  l.p.sample = clip.sample;
  l.p.side = 'stereo';
  l.p.interp = 'sinc';
  l.p.slice = clip.slice;
  l.p.pitch = plan.pitch;
  l.p.stretch = plan.ratio;
  l.p.method = clip.method;
  if (clip.len !== null && plan.to < src) l.p.end = Math.round(plan.to * 1e6) / 1e6;
  if (clip.fade > 0) { l.p['fade-in'] = clip.fade; l.p['fade-out'] = clip.fade; }
  s.layers = [l];
  s.nextSalt = 2;
  s.duration = Math.max(0.01, Math.min(120, plan.seconds));
  return s;
}

/** The arrangement a render plays: its mode, how many times the loop region is played in `full`, its length in seconds and the loop region. */
export interface ClipWhere {
  mode: 'full' | 'loop';
  loops: number;
  total: number;
  loop: { start: number; end: number } | null;
}

/** The words that give a clip, in a fixed order: the normal form of its command and the line of the song's file. */
export function clipWords(c: AudioClip, time: readonly [number, number]): string[] {
  const w = [`sample=${c.sample}`, `at=${formatAt(c.at, time)}`];
  if (c.nudge) w.push(`nudge=${c.nudge}`);
  if (c.len !== null) w.push(`len=${Math.round((c.len / beatsPerBar(time)) * 1e6) / 1e6}`);
  if (c.stretch === 'tempo') w.push('stretch=tempo', `from-tempo=${c.fromTempo}`);
  if (c.method !== 'wsola') w.push(`method=${c.method}`);
  if (c.pitch) w.push(`pitch=${c.pitch}`);
  if (c.gain !== 1) w.push(`gain=${c.gain}`);
  if (c.fade) w.push(`fade=${c.fade}`);
  if (c.slice) w.push(`slice=${c.slice}`);
  return w;
}

/** Where each clip of a channel starts, in seconds from the start of the window, for the arrangement a mode plays. */
export function clipStarts(
  song: SongDoc,
  clips: readonly AudioClip[],
  where: ClipWhere,
): { clip: AudioClip; t: number }[] {
  const out: { clip: AudioClip; t: number }[] = [];
  const secPerBeat = 60 / song.tempo;
  for (const clip of clips) {
    const t = clip.at * secPerBeat + clip.nudge / 1000;
    const base = clip.at * secPerBeat;
    if (where.mode === 'loop') {
      const lp = where.loop!;
      if (base + 1e-9 >= lp.start && base < lp.end - 1e-9) out.push({ clip, t: t - lp.start });
      continue;
    }
    const lp = where.loop;
    if (!lp || where.loops <= 1) {
      if (base < where.total - 1e-9) out.push({ clip, t });
      continue;
    }
    const len = lp.end - lp.start;
    if (base < lp.start - 1e-9) out.push({ clip, t });
    else if (base < lp.end - 1e-9) for (let k = 0; k < where.loops; k++) out.push({ clip, t: t + k * len });
    else out.push({ clip, t: t + (where.loops - 1) * len });
  }
  return out.sort((a, b) => a.t - b.t);
}

