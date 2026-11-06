// The sound document. In this first version a sound has one placeholder voice, a plain sine tone
// (frequency, duration, volume), so that history, rendering, export and the dashboard are real
// end to end before the full synth arrives. A document is plain data: it prints to a canonical
// text form (sounds/<id>.sfx) and to the key the render cache is addressed by.

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

export interface Sound {
  id: string;
  voice: 'tone';
  frequency: number;
  duration: number;
  volume: number;
  /** The latest status mark: draft until a person (or agent) approves or rejects it. */
  status: SoundStatus;
}

export function newSound(id: string): Sound {
  return { id, voice: 'tone', frequency: 440, duration: 0.5, volume: 0.5, status: 'draft' };
}

export function paramSpec(name: string): ParamSpec | undefined {
  return TONE_PARAMS.find((p) => p.name === name);
}

/** Why this value is not allowed for the parameter (null: fine). */
export function paramProblem(name: string, value: number): string | null {
  const spec = paramSpec(name);
  if (!spec) return `no parameter '${name}' (parameters: ${TONE_PARAMS.map((p) => p.name).join(', ')})`;
  if (!Number.isFinite(value)) return `${name} must be a number`;
  if (value < spec.min || value > spec.max) return `${name} must be between ${spec.min} and ${spec.max}${spec.unit ? ' ' + spec.unit : ''} (got ${value})`;
  return null;
}

/** A number as written in the tape and documents: shortest round-trip form, no exponent noise. */
export function fmtNumber(n: number): string {
  return String(n);
}

/** The sound as the text of its file (sounds/<id>.sfx): fixed order, one `key value` per line. */
export function serializeSound(s: Sound): string {
  const lines = ['soundclaw sound 1', `id ${s.id}`, `voice ${s.voice}`];
  for (const p of TONE_PARAMS) lines.push(`${p.name} ${fmtNumber(s[p.name as ParamName])}`);
  lines.push(`status ${s.status}`);
  return lines.join('\n') + '\n';
}

/** What the renderer reads: the voice and its parameters, nothing else (a status mark does not change the audio). */
export function renderKey(s: Sound): string {
  const body = `${RENDER_VERSION}|${s.voice}|${TONE_PARAMS.map((p) => `${p.name}=${fmtNumber(s[p.name as ParamName])}`).join('|')}`;
  return sha256Text(body);
}

export function cloneSound(s: Sound): Sound {
  return { ...s };
}
