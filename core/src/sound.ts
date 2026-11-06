// The sound document. In this first version a sound has one placeholder voice, a plain sine tone
// (frequency, duration, volume), so that history, rendering, export and the dashboard are real
// end to end before the full synth arrives. A document is plain data: it prints to a canonical
// text form (sounds/<id>.sfx) and to the key the render cache is addressed by.

import { CLASSIC_FIELDS, formatPatchNamed, makePatch, patchValues, type ClassicPatch } from './classic.ts';
import { sha256Text } from './sha256.ts';

export const SAMPLE_RATE = 44100;
/** Bump when the renderer's output for the same document changes: cached renders are keyed by it. */
export const RENDER_VERSION = 1;

export const SOUND_ID_RE = /^[a-z][a-z0-9_-]{0,47}$/;

export type SoundStatus = 'draft' | 'approved' | 'rejected';

export interface ParamSpec {
  name: string;
  min: number;
  max: number;
  default: number;
  unit: string;
  help: string;
}

/** The tone voice's parameters: name, range, default. The ranges are the validation. */
export const TONE_PARAMS: readonly ParamSpec[] = [
  { name: 'frequency', min: 20, max: 20000, default: 440, unit: 'Hz', help: 'pitch of the sine wave' },
  { name: 'duration', min: 0.01, max: 10, default: 0.5, unit: 's', help: 'length of the sound' },
  { name: 'volume', min: 0, max: 1, default: 0.5, unit: '', help: 'peak amplitude, 0 to 1' },
];

export type ParamName = 'frequency' | 'duration' | 'volume';

export type VoiceKind = 'tone' | 'classic';

/** The placeholder voice: a plain sine tone. */
export interface ToneSound {
  id: string;
  voice: 'tone';
  frequency: number;
  duration: number;
  volume: number;
  /** The latest status mark: draft until a person (or agent) approves or rejects it. */
  status: SoundStatus;
}

/** The classic voice: 25 sfxr-style parameters (and optionally the noise seed). */
export interface ClassicSound {
  id: string;
  voice: 'classic';
  patch: ClassicPatch;
  status: SoundStatus;
}

export type Sound = ToneSound | ClassicSound;

export function newSound(id: string): ToneSound {
  return { id, voice: 'tone', frequency: 440, duration: 0.5, volume: 0.5, status: 'draft' };
}

export function newClassicSound(id: string, patch: ClassicPatch = makePatch({})): ClassicSound {
  return { id, voice: 'classic', patch, status: 'draft' };
}

export function paramSpec(name: string): ParamSpec | undefined {
  return TONE_PARAMS.find((p) => p.name === name);
}

/** The parameters a voice has, with ranges: what `sound set` accepts. */
export function voiceParams(voice: VoiceKind): readonly ParamSpec[] {
  if (voice === 'tone') return TONE_PARAMS;
  return CLASSIC_FIELDS.map((f) => ({ name: f.name, min: f.min, max: f.max, default: f.default, unit: '', help: f.help }));
}

/** Why this value is not allowed for the parameter (null: fine). */
export function paramProblem(name: string, value: number, voice: VoiceKind = 'tone'): string | null {
  const spec = voiceParams(voice).find((p) => p.name === name);
  if (!spec) return `no parameter '${name}' on a ${voice} sound (parameters: ${voiceParams(voice).map((p) => p.name).join(', ')})`;
  if (!Number.isFinite(value)) return `${name} must be a number`;
  if (value < spec.min || value > spec.max) return `${name} must be between ${spec.min} and ${spec.max}${spec.unit ? ' ' + spec.unit : ''} (got ${value})`;
  if (name === 'wave' && !Number.isInteger(value)) return `wave must be 0, 1, 2 or 3 (square, saw, sine, noise)`;
  return null;
}

/** The parameter names of the voices together (the command parser checks a name against these; the sound's voice decides at apply time). */
export function isParamName(name: string): boolean {
  return name === 'seed' || TONE_PARAMS.some((p) => p.name === name) || CLASSIC_FIELDS.some((f) => f.name === name);
}

/** A number as written in the tape and documents: shortest round-trip form, no exponent noise. */
export function fmtNumber(n: number): string {
  return String(n);
}

/** The sound as the text of its file (sounds/<id>.sfx): fixed order, one `key value` per line. */
export function serializeSound(s: Sound): string {
  const lines = ['soundclaw sound 1', `id ${s.id}`, `voice ${s.voice}`];
  if (s.voice === 'tone') for (const p of TONE_PARAMS) lines.push(`${p.name} ${fmtNumber(s[p.name as ParamName])}`);
  else {
    for (const f of CLASSIC_FIELDS) lines.push(`${f.name} ${fmtNumber(s.patch[f.name])}`);
    if (s.patch.seed !== undefined) lines.push(`seed ${fmtNumber(s.patch.seed)}`);
  }
  lines.push(`status ${s.status}`);
  return lines.join('\n') + '\n';
}

/** What the renderer reads: the voice and its parameters, nothing else (a status mark does not change the audio). */
export function renderKey(s: Sound): string {
  const body = s.voice === 'tone'
    ? `${RENDER_VERSION}|tone|${TONE_PARAMS.map((p) => `${p.name}=${fmtNumber(s[p.name as ParamName])}`).join('|')}`
    : `${RENDER_VERSION}|classic|${formatPatchNamed(s.patch)}`;
  return sha256Text(body);
}

export function cloneSound<T extends Sound>(s: T): T {
  return s.voice === 'classic' ? ({ ...s, patch: { ...s.patch } } as T) : { ...s };
}

/** The classic sounds' values in positional order, for tables and cards. */
export const classicValues = (s: ClassicSound): number[] => patchValues(s.patch);

