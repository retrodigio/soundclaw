// Instruments: any voice of the layered sound (classic, oscillator, FM, pluck, sample, several layers)
// played at a pitch. An instrument is a template sound (its layers and effects, written as they sound
// at the `root` note) plus a note envelope (attack, decay, sustain, release), an optional pitch
// envelope, a velocity sensitivity and a declared range. Playing note N renders the template with
// every pitched layer moved by (N - root) semitones:
//   osc, fm, ks   freq × 2^(semitones/12)
//   classic       the start and minimum frequency, by the same ratio (the slide keeps its shape)
//   sample        pitch + semitones
// Pitch effects (a pitch envelope, ~slide, ~vib, ~arp) move osc, fm and sample layers continuously; a
// pluck (ks) and a classic layer are tuned at the note's start and keep their pitch.
// The note envelope multiplies each layer's amplitude before the layer's effects, so a delay's echoes
// ring on after the note ends.

import {
  cloneLayered, formatEnv, fmtNum, newLayer, newLayeredSound, serializeLayered, layeredBody,
  type Env, type Layer, type LayeredSound,
} from './layered.ts';
import { exp2, sineCycles } from './mathx.ts';
import { midiFreq, noteLabel, parseNote, parseRange } from './music.ts';
import type { NoteFx } from './pattern.ts';
import { sha256Text } from './sha256.ts';
import { RENDER_VERSION, SAMPLE_RATE } from './sound.ts';
import { envAt, fxTail, renderLayered, type SampleBank } from './synth.ts';

export const INSTRUMENT_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;

export interface Instrument {
  id: string;
  /** The template: layers and effects as they sound at `root`. Its `gain` is the instrument's gain and its `seed` the noise seed; duration and loop are ignored. */
  voice: LayeredSound;
  /** The MIDI note the template sounds at as written. */
  root: number;
  /** Follows the note's pitch. A drum or a sound effect does not: every note plays it as written. */
  pitched: boolean;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  /** 0: every velocity plays at full level; 1: the level follows velocity / 127. */
  velocity: number;
  /** Declared playable range (MIDI), checked by `range`. */
  range: [number, number] | null;
  /** Semitones over time since the note began (a kick's drop, a chirp). */
  pitchEnv: Env | null;
  /**
   * How `render-match` hears the instrument's pitch: `full` (the note, octave included; the default),
   * `class` (the pitch class, octave ignored: an inharmonic voice such as a bell, whose partials make
   * a pitch tracker hear an octave off) or `onset` (timing only). Left out when full.
   */
  pitchCheck?: PitchCheck;
  /**
   * A legato voice (a recorder, a bowed string, a held drone): notes that touch run into each other with no
   * rise in level, so `render-match` finds a touching note's onset in the pitch change, not the level. Checking
   * only: it changes no sample. Left out when not set.
   */
  legato?: true;
  /** Set on the built-in instruments: the name they are listed under. */
  builtin?: true;
}

export const PITCH_CHECKS = ['full', 'class', 'onset'] as const;
export type PitchCheck = (typeof PITCH_CHECKS)[number];

/** The pitch rule an instrument is checked by (full when it declares none). */
export const pitchCheckOf = (i: Pick<Instrument, 'pitchCheck'> | undefined): PitchCheck => i?.pitchCheck ?? 'full';

export const INSTRUMENT_PARAMS = {
  attack: { min: 0.001, max: 4, unit: 's', help: 'time to reach full level' },
  decay: { min: 0, max: 4, unit: 's', help: 'time from full level down to sustain (0: none)' },
  sustain: { min: 0, max: 1, unit: '', help: 'level held while the note is held' },
  release: { min: 0.005, max: 8, unit: 's', help: 'time to fall to silence after the note ends' },
  velocity: { min: 0, max: 1, unit: '', help: 'how much velocity changes the level (0: not at all, 1: fully)' },
  gain: { min: 0, max: 4, unit: '', help: 'the instrument\'s level' },
  seed: { min: 0, max: 4294967295, unit: '', help: 'the noise seed' },
} as const;

export const MAX_NOTE_SECONDS = 12;
const CTRL = 0.002;
const SLIDE_TIME = 0.08;
const VIB_DELAY = 0.08;
const VIB_RAMP = 0.15;
export const ARP_STEP = 0.02;

export function newInstrument(id: string, seed: number): Instrument {
  const voice = newLayeredSound(id, seed);
  const l = newLayer('osc', 1);
  voice.layers.push(l);
  voice.nextSalt = 2;
  return { id, voice, root: 69, pitched: true, attack: 0.005, decay: 0.1, sustain: 0.7, release: 0.1, velocity: 1, range: null, pitchEnv: null };
}

export function cloneInstrument(i: Instrument): Instrument {
  return { ...i, voice: cloneLayered(i.voice), range: i.range ? [...i.range] : null, pitchEnv: i.pitchEnv ? i.pitchEnv.map((p) => ({ ...p })) : null };
}

/** The instrument's file (instruments/<id>.inst). */
export function serializeInstrument(i: Instrument): string {
  const lines = ['soundclaw instrument 1', `id ${i.id}`, `root ${noteLabel(i.root)}`, `pitched ${i.pitched ? 'yes' : 'no'}`,
    `note-envelope ${fmtNum(i.attack)} ${fmtNum(i.decay)} ${fmtNum(i.sustain)} ${fmtNum(i.release)}`, `velocity ${fmtNum(i.velocity)}`,
    `range ${i.range ? `${noteLabel(i.range[0])}-${noteLabel(i.range[1])}` : 'none'}`, `pitch-envelope ${i.pitchEnv ? formatEnv(i.pitchEnv) : 'none'}`];
  if (pitchCheckOf(i) !== 'full') lines.push(`pitch-check ${pitchCheckOf(i)}`);
  if (i.legato) lines.push('legato yes');
  lines.push(...serializeLayered(i.voice));
  return lines.join('\n') + '\n';
}

/** The key a note's render is cached under: everything that changes the samples. */
export function instrumentKey(i: Instrument, sampleHash: (name: string) => string = () => 'none'): string {
  return sha256Text(`${RENDER_VERSION}|inst|${i.root}|${i.pitched}|${i.attack}|${i.decay}|${i.sustain}|${i.release}|${i.pitchEnv ? formatEnv(i.pitchEnv) : '-'}|${layeredBody(i.voice, sampleHash)}`);
}

// ---- the note envelope --------------------------------------------------------------------------------------

/** The note envelope for a note held `gate` seconds: attack, decay to sustain, hold, release to silence (breakpoints, 0..1). */
export function noteEnvelope(i: Pick<Instrument, 'attack' | 'decay' | 'sustain' | 'release'>, gate: number): Env {
  const full: Env = [{ t: 0, v: 0, curve: 'lin' }, { t: i.attack, v: 1, curve: 'lin' }];
  if (i.decay > 0) full.push({ t: i.attack + i.decay, v: i.sustain, curve: 'exp' });
  else if (i.sustain < 1) full.push({ t: i.attack + 0.002, v: i.sustain, curve: 'lin' });
  const g = Math.max(gate, 0.002);
  const pts: Env = full.filter((p) => p.t < g - 1e-9).map((p) => ({ ...p }));
  const level = envAt(full, g);
  pts.push({ t: g, v: level, curve: 'lin' });
  pts.push({ t: g + i.release, v: 0, curve: 'exp' });
  return pts;
}

function sampled(f: (t: number) => number, end: number): Env {
  const n = Math.max(1, Math.ceil(end / CTRL));
  const out: Env = [];
  for (let k = 0; k <= n; k++) out.push({ t: k * CTRL, v: f(k * CTRL), curve: 'lin' });
  return out;
}

const clampHz = (f: number): number => (f < 20 ? 20 : f > 20000 ? 20000 : f);

export interface NoteSpec {
  midi: number;
  /** Seconds the key is held. */
  gate: number;
  fx?: NoteFx;
  /** With ~slide: the pitch (MIDI) the glide starts from. */
  slideFrom?: number | null;
}

/** The pitch offset (semitones) a note has at time t beyond its steady pitch. */
function pitchOffset(i: Instrument, n: NoteSpec): ((t: number) => number) | null {
  const fx = n.fx ?? {};
  const slide = fx.slide && n.slideFrom !== null && n.slideFrom !== undefined ? n.slideFrom - n.midi : 0;
  if (!i.pitchEnv && !slide && !fx.vib && !fx.arp) return null;
  const pe = i.pitchEnv;
  return (t) => {
    let p = pe ? envAt(pe, t) : 0;
    if (slide) p += slide * Math.max(0, 1 - t / SLIDE_TIME);
    if (fx.vib && t > VIB_DELAY) p += fx.vib.depth * sineCycles(fx.vib.rate * (t - VIB_DELAY)) * Math.min(1, (t - VIB_DELAY) / VIB_RAMP);
    if (fx.arp) p += fx.arp[Math.floor(t / ARP_STEP) % fx.arp.length]!;
    return p;
  };
}

function multiply(a: Env, b: Env, end: number): Env {
  const n = Math.max(1, Math.ceil(end / CTRL));
  const out: Env = [];
  for (let k = 0; k <= n; k++) out.push({ t: k * CTRL, v: envAt(a, k * CTRL) * envAt(b, k * CTRL), curve: 'lin' });
  return out;
}

/** How long the rendered note is: the key held, the release and the effects' tails. */
export function noteLength(i: Instrument, gate: number): number {
  const tail = i.voice.master.reduce((a, f) => a + fxTail(f), 0);
  return Math.min(MAX_NOTE_SECONDS, Math.max(0.02, gate + i.release + tail));
}

/** The sound that plays one note: the template with its pitch, envelope and length set. */
export function noteSound(i: Instrument, n: NoteSpec): LayeredSound {
  const s = cloneLayered(i.voice);
  delete s.loop;
  delete s.family;
  const st0 = i.pitched ? n.midi - i.root : 0;
  const total = noteLength(i, n.gate);
  s.duration = total;
  const P = pitchOffset(i, n);
  const env = noteEnvelope(i, n.gate);
  const ratio = exp2(st0 / 12);
  s.layers = s.layers.map((l: Layer): Layer => {
    const out: Layer = { ...l, p: { ...l.p }, envs: { ...l.envs }, fx: l.fx };
    out.amp = l.amp ? multiply(l.amp, env, total) : env;
    const dur = Math.min(123, total + (l.p.offset as number));
    if (l.kind === 'osc' || l.kind === 'fm' || l.kind === 'ks') {
      out.p.dur = dur;
      const base = l.p.freq as number;
      if (l.kind === 'ks' || !P) {
        if (l.kind === 'ks' || !l.envs.freq) {
          // tuned once; a pluck also takes the pitch the note starts on
          const start = (l.kind === 'ks' && P ? exp2((st0 + P(0)) / 12) : ratio) * base;
          out.p.freq = clampHz(start);
          delete out.envs.freq;
        } else {
          const e = l.envs.freq;
          out.envs.freq = sampled((t) => clampHz(envAt(e, t) * ratio), total);
        }
      } else {
        const e = l.envs.freq;
        out.envs.freq = sampled((t) => clampHz((e ? envAt(e, t) : base) * exp2((st0 + P(t)) / 12)), total);
      }
    } else if (l.kind === 'sample') {
      const base = l.p.pitch as number;
      if (!P) out.p.pitch = Math.max(-48, Math.min(48, base + st0));
      else {
        const e = l.envs.pitch;
        out.envs.pitch = sampled((t) => Math.max(-48, Math.min(48, (e ? envAt(e, t) : base) + st0 + P(t))), total);
      }
    } else if (l.kind === 'classic' && st0 !== 0) {
      for (const name of ['freq', 'minFreq'] as const) {
        const f = l.p[name] as number;
        if (name === 'minFreq' && f === 0) continue;
        out.p[name] = Math.min(1, Math.sqrt(Math.max(0, ratio * (f * f + 0.001) - 0.001)));
      }
    }
    return out;
  });
  return s;
}

/** One note, unscaled by velocity: the instrument's channels (1, or 2 when a layer is panned). */
export function renderNote(i: Instrument, n: NoteSpec, bank?: SampleBank): Float32Array[] {
  return renderLayered(noteSound(i, n), bank);
}

/** The level a velocity plays at (1 at velocity 127). */
export function velocityGain(i: Instrument, vel: number): number {
  return 1 - i.velocity + (i.velocity * vel) / 127;
}

// ---- the built-in instruments --------------------------------------------------------------------------------

type Spec = Record<string, number | string>;

function make(id: string, o: Partial<Instrument> & { layers: { kind: Layer['kind']; p: Spec; envs?: Record<string, string>; fx?: [string, Spec][] }[]; gain?: number; fx?: [string, Spec][] }): Instrument {
  const base = newInstrument(id, 1);
  base.voice.layers = [];
  o.layers.forEach((spec, k) => {
    const l = newLayer(spec.kind, k + 1);
    Object.assign(l.p, spec.p);
    base.voice.layers.push(l);
  });
  base.voice.nextSalt = o.layers.length + 1;
  base.voice.gain = o.gain ?? 1;
  const { layers: _l, gain: _g, fx: _f, ...rest } = o;
  void _l; void _g; void _f;
  const inst: Instrument = { ...base, ...rest, builtin: true };
  return inst;
}

const env = (s: string): Env => s.split(' ').map((w) => { const [t, v] = w.split(':'); const [val, c] = v!.split('@'); return { t: Number(t), v: Number(val), curve: (c ?? 'lin') as Env[number]['curve'] }; });

export const BUILTIN_NAMES = ['square_lead', 'pulse_lead', 'triangle_bass', 'saw_pad', 'fm_bell', 'fm_bass', 'pluck', 'kick', 'snare', 'hat', 'hat_open'] as const;

function buildBuiltins(): Record<string, Instrument> {
  const out: Record<string, Instrument> = {};
  out.square_lead = make('square_lead', { layers: [{ kind: 'osc', p: { wave: 'square', duty: 0.5, freq: 440 } }], gain: 0.35, attack: 0.004, decay: 0.08, sustain: 0.75, release: 0.06, range: [48, 96] });
  out.pulse_lead = make('pulse_lead', { layers: [{ kind: 'osc', p: { wave: 'square', duty: 0.25, freq: 440, filter: 'hp', cutoff: 35, q: 0.707 } }], gain: 0.35, attack: 0.003, decay: 0.1, sustain: 0.65, release: 0.08, range: [48, 96] });
  out.triangle_bass = make('triangle_bass', { layers: [{ kind: 'osc', p: { wave: 'triangle', freq: 440 } }], gain: 0.7, attack: 0.003, decay: 0.05, sustain: 0.9, release: 0.05, range: [24, 60] });
  out.saw_pad = make('saw_pad', {
    layers: [
      { kind: 'osc', p: { wave: 'saw', freq: 440, pan: -0.4, filter: 'lp', cutoff: 2400, gain: 0.5 } },
      { kind: 'osc', p: { wave: 'saw', freq: 442.6, pan: 0.4, filter: 'lp', cutoff: 2400, gain: 0.5 } },
    ], gain: 0.28, attack: 0.25, decay: 0.3, sustain: 0.8, release: 0.5, range: [36, 84],
  });
  out.fm_bell = make('fm_bell', { layers: [{ kind: 'fm', p: { freq: 440, ops: 2, ratio1: 1, ratio2: 3.5, index2: 2.4 } }], gain: 0.45, attack: 0.002, decay: 1.4, sustain: 0, release: 0.3, range: [60, 108], pitchCheck: 'class' });
  out.fm_bell.voice.layers[0]!.envs.index2 = env('0:4 1.2:0.3@exp');
  out.fm_bass = make('fm_bass', { layers: [{ kind: 'fm', p: { freq: 440, ops: 2, ratio1: 1, ratio2: 1, index2: 2.2 } }], gain: 0.6, attack: 0.002, decay: 0.2, sustain: 0.65, release: 0.05, range: [24, 55] });
  out.fm_bass.voice.layers[0]!.envs.index2 = env('0:3.2 0.15:1.2@exp');
  out.pluck = make('pluck', { layers: [{ kind: 'ks', p: { freq: 440, decay: 1.2, bright: 0.7 } }], gain: 0.9, attack: 0.001, decay: 0, sustain: 1, release: 0.2, range: [36, 88] });
  out.kick = make('kick', {
    layers: [
      { kind: 'osc', p: { wave: 'sine', freq: 52 } },
      { kind: 'osc', p: { wave: 'white', filter: 'lp', cutoff: 3000, gain: 0.25 } },
    ], gain: 0.9, pitched: false, attack: 0.001, decay: 0.2, sustain: 0, release: 0.02, velocity: 0.8,
    pitchEnv: env('0:30 0.07:0@exp'),
  });
  out.snare = make('snare', {
    layers: [
      { kind: 'osc', p: { wave: 'white', filter: 'bp', cutoff: 2200, q: 0.8, gain: 1 } },
      { kind: 'osc', p: { wave: 'triangle', freq: 185, gain: 0.5 } },
    ], gain: 0.55, pitched: false, attack: 0.001, decay: 0.14, sustain: 0, release: 0.02, velocity: 0.8,
  });
  out.hat = make('hat', { layers: [{ kind: 'osc', p: { wave: 'white', filter: 'hp', cutoff: 7500, q: 0.7 } }], gain: 0.35, pitched: false, attack: 0.001, decay: 0.045, sustain: 0, release: 0.01, velocity: 0.8 });
  out.hat_open = make('hat_open', { layers: [{ kind: 'osc', p: { wave: 'white', filter: 'hp', cutoff: 6500, q: 0.7 } }], gain: 0.3, pitched: false, attack: 0.001, decay: 0.3, sustain: 0, release: 0.05, velocity: 0.8 });
  return out;
}

let builtins: Record<string, Instrument> | null = null;
export function builtinInstruments(): Readonly<Record<string, Instrument>> {
  builtins ??= buildBuiltins();
  return builtins;
}

/** A copy of a built-in under a new id (the builtin mark dropped), or undefined. */
export function fromBuiltin(name: string, id: string): Instrument | undefined {
  const b = builtinInstruments()[name];
  if (!b) return undefined;
  const c = cloneInstrument(b);
  c.id = id;
  c.voice.id = id;
  delete c.builtin;
  return c;
}

/** The template for `instrument from-sound`: the sound's layers as an instrument. `root` is given or found from the sound's pitch. */
export function instrumentFromSound(id: string, sound: LayeredSound, root: number): Instrument {
  const voice = cloneLayered(sound);
  voice.id = id;
  voice.duration = null;
  delete voice.loop;
  delete voice.family;
  delete voice.loudClass;
  delete voice.loudness;
  return { id, voice, root, pitched: true, attack: 0.001, decay: 0, sustain: 1, release: 0.05, velocity: 1, range: null, pitchEnv: null };
}

/** The root note of a template, from its first pitched layer (osc, fm, ks: the freq); null when it has none. */
export function guessRoot(s: LayeredSound): number | null {
  for (const l of s.layers) {
    if ((l.kind === 'osc' && !['white', 'pink', 'brown'].includes(String(l.p.wave))) || l.kind === 'fm' || l.kind === 'ks') {
      const hz = l.p.freq as number;
      let best = 0, bd = Infinity;
      for (let m = 0; m <= 127; m++) { const d = Math.abs(midiFreq(m) - hz); if (d < bd) { bd = d; best = m; } }
      return best;
    }
  }
  return null;
}

export { SAMPLE_RATE, parseNote, parseRange };

/** The built-in instruments as a markdown table (docs/commands.md carries it; a test keeps them equal). */
export function builtinTable(): string {
  const rows = Object.values(builtinInstruments()).map((i) => {
    const layers = i.voice.layers.map((l) => (l.kind === 'osc' ? (l.p.wave === 'square' && l.p.duty !== 0.5 ? `pulse ${l.p.duty}` : String(l.p.wave)) : l.kind === 'fm' ? `fm ${l.p.ops}op` : l.kind)).join(' + ');
    const range = i.range ? `${noteLabel(i.range[0])}-${noteLabel(i.range[1])}` : 'none';
    const env = [i.attack, i.decay, i.sustain, i.release].join(' / ');
    return `| \`${i.id}\` | ${layers} | ${i.pitched ? `root ${noteLabel(i.root)}` : 'unpitched'} | ${env} | ${range} | ${i.velocity} | ${i.pitched ? pitchCheckOf(i) : '-'} |`;
  });
  return ['| instrument | voice | pitch | attack / decay / sustain / release (s, s, level, s) | range | velocity sensitivity | pitch check |', '|---|---|---|---|---|---|---|', ...rows].join('\n');
}
