// SFZ export of a sampled instrument: the zones as regions, the note envelope as the amplitude envelope, so a person can take an
// instrument into a DAW or another sampler. Only what SFZ can say is written; what it cannot (the template's synth layers, the interpolation
// kind, velocity crossfade widths) is named in a comment at the top of the file. Plain text; the caller writes the audio files.

import type { Instrument } from './instrument.ts';
import { noteLabel } from './music.ts';
import type { SampleEntry } from './samples.ts';

/** The notes a kit's hit names are written on (General MIDI drum map where there is a name for it). */
const HIT_KEYS: Record<string, number> = { kick: 36, snare: 38, hat: 42, hat_open: 46, clap: 39, tom: 45, crash: 49, ride: 51 };

export interface SfzFile {
  /** The sample's name and the file it is written as (relative to the SFZ's `default_path`). */
  sample: string;
  file: string;
}

export interface SfzResult {
  text: string;
  files: SfzFile[];
  /** What could not be written, in words. */
  lost: string[];
}

const r = (n: number): string => String(Math.round(n * 1e6) / 1e6);

/** The instrument as an SFZ file. `entry` finds a sample's facts (its rate, slices and loop points). */
export function instrumentToSfz(inst: Instrument, entry: (name: string) => SampleEntry | undefined, dir = 'samples'): SfzResult {
  const zones = inst.zones ?? [];
  const lost: string[] = [];
  if (inst.voice.layers.length) lost.push(`${inst.voice.layers.length} synth layer${inst.voice.layers.length === 1 ? '' : 's'} of the template (SFZ here carries the samples only)`);
  if (inst.velxfade) lost.push(`the velocity crossfade (velxfade=${inst.velxfade}): adjacent velocity layers switch at their boundary`);
  if (inst.rr === 'hash') lost.push('round robins chosen by hash: they play in turn (seq_position) in SFZ');
  if (inst.voice.master.length) lost.push(`${inst.voice.master.length} instrument effect${inst.voice.master.length === 1 ? '' : 's'}`);
  if (inst.pitchEnv) lost.push('the pitch envelope');
  const files: SfzFile[] = [];
  const used = new Set<string>();
  const lines: string[] = [`// ${inst.id}: exported from SoundClaw`];
  const unknownHits = new Map<string, number>();
  const hitKey = (h: string): number => HIT_KEYS[h] ?? unknownHits.get(h) ?? (unknownHits.set(h, 60 + unknownHits.size), unknownHits.get(h)!);
  lines.push('<control>', `default_path=${dir}/`, '<global>');
  lines.push(`ampeg_attack=${r(inst.attack)}`, `ampeg_decay=${r(inst.decay)}`, `ampeg_sustain=${r(inst.sustain * 100)}`, `ampeg_release=${r(inst.release)}`, `amp_veltrack=${r(inst.velocity * 100)}`);
  for (const z of zones) {
    const e = entry(z.sample);
    if (!used.has(z.sample)) { used.add(z.sample); files.push({ sample: z.sample, file: `${z.sample}.wav` }); }
    const w = [`sample=${z.sample}.wav`];
    if (z.hit !== null) {
      const k = hitKey(z.hit);
      w.push(`key=${k}`, 'pitch_keytrack=0', `pitch_keycenter=${k}`);
    } else {
      w.push(`lokey=${z.keys[0]}`, `hikey=${z.keys[1]}`, `pitch_keycenter=${z.root}`);
      if (!inst.pitched) w.push('pitch_keytrack=0');
    }
    if (z.tune) w.push(`tune=${r(z.tune)}`);
    if (z.vel[0] !== 1 || z.vel[1] !== 127) w.push(`lovel=${z.vel[0]}`, `hivel=${z.vel[1]}`);
    if (z.gain) w.push(`volume=${r(z.gain)}`);
    if (z.pan) w.push(`pan=${r(z.pan * 100)}`);
    // where in the file it plays: the slice's start plus `start`, and `end`
    if (e) {
      const sliceStart = z.slice > 0 && e.slices?.[z.slice - 1] !== undefined ? e.slices[z.slice - 1]! : 0;
      const sliceEnd = z.slice > 0 ? (e.slices?.[z.slice] ?? e.frames) : e.frames;
      const offset = sliceStart + Math.round(z.start * e.rate);
      const end = z.end > 0 ? sliceStart + Math.round(z.end * e.rate) : sliceEnd;
      if (offset > 0) w.push(`offset=${offset}`);
      if (end < e.frames) w.push(`end=${end}`);
      if (z.loopmode === 'oneshot') w.push('loop_mode=one_shot');
      else if (z.loopmode === 'none' || z.loop === null) w.push('loop_mode=no_loop');
      else {
        const lp = z.loop === 'sample' ? e.loop : ([sliceStart + Math.round((z.start + z.loop[0]) * e.rate), sliceStart + Math.round((z.start + z.loop[1]) * e.rate)] as [number, number]);
        if (lp) w.push(`loop_mode=${z.loopmode === 'continuous' ? 'loop_continuous' : 'loop_sustain'}`, `loop_start=${lp[0]}`, `loop_end=${lp[1] - 1}`, `loop_crossfade=${r(z.xfade)}`);
        else w.push('loop_mode=no_loop');
      }
    } else {
      lost.push(`zone with sample ${z.sample}: the sample is not in the project, so its offsets and loop points are not written`);
    }
    if (z.trigger === 'release') { w.push('trigger=release'); if (z.releaseDecay) w.push(`rt_decay=${r(z.releaseDecay)}`); }
    if (z.rr) w.push(`seq_length=${z.rr[1]}`, `seq_position=${z.rr[0]}`);
    if (z.choke) w.push(`group=${z.choke}`, `off_by=${z.choke}`);
    lines.push('<region> ' + w.join(' ') + (z.hit !== null ? ` // hit ${z.hit}${z.hit in HIT_KEYS ? '' : ` (key ${noteLabel(hitKey(z.hit))})`}` : ''));
  }
  if (lost.length) lines.splice(1, 0, ...lost.map((l) => `// not written: ${l}`));
  return { text: lines.join('\n') + '\n', files, lost };
}
