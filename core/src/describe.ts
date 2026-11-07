// Words and numbers for the agent's ears. `describe` is a summary built only from the measured
// numbers (never from the sound's settings, and never an opinion).

import { noteName, type Analysis } from './analysis.ts';

const hz = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kHz` : `${Math.round(v)} Hz`);
const hzNote = (v: number): string => `${hz(v)} (${noteName(v)})`;
const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : v > 0 ? 'inf' : '-inf');
const secs = (v: number): string => (v < 0.1 ? `${(v * 1000).toFixed(v < 0.01 ? 1 : 0)} ms` : `${v.toFixed(2)} s`);

/** The numbers, as lines printed with every view and render. */
export function formatNumbers(a: Analysis): string {
  if (a.silent) return `duration ${a.duration.toFixed(3)} s (${a.samples} samples); silent (no sample above −120 dB)`;
  const c = a.centroid;
  const p = a.pitch;
  const lines = [
    `duration ${a.duration.toFixed(3)} s (${a.samples} samples${a.channels > 1 ? `, ${a.channels} channels: stereo` : ''})`,
    `loudness ${f1(a.lufs)} LUFS, true peak ${f1(a.truePeakDb)} dBTP (sample peak ${f1(a.peakDb)} dBFS), rms ${f1(a.rmsDb)} dBFS, crest factor ${f1(a.crestDb)} dB`,
    `dc offset ${a.dc.toFixed(5)} (${(a.dc * 100).toFixed(2)} %)`,
    `attack ${(a.attack * 1000).toFixed(1)} ms to −3 dB of peak; tail ${a.tail.toFixed(3)} s to −60 dB; silence ${Math.round(a.leadingSilence * 1000)} ms before and ${Math.round(a.trailingSilence * 1000)} ms after`,
    `brightness (spectral centroid) mean ${hz(c.mean)}; start ${hz(c.start)}, middle ${hz(c.mid)}, end ${hz(c.end)}; flatness ${a.flatness.toFixed(2)} (0 tonal … 1 noise)`,
    p.start !== null && p.end !== null && p.min !== null && p.max !== null
      ? `pitch ${hzNote(p.start)} at the start → ${hzNote(p.end)} at the end; range ${hzNote(p.min)} to ${hzNote(p.max)} (${p.rangeSemitones.toFixed(1)} semitones); ${Math.round(p.voiced * 100)} % of the sound is pitched`
      : 'pitch none found (not clearly pitched)',
    `onsets ${a.onsets} (at ${a.onsetTimes.slice(0, 8).map((t) => t.toFixed(3)).join(', ')} s${a.onsetTimes.length > 8 ? ', …' : ''})`,
  ];
  return lines.join('\n');
}

/** A plain-words summary of the measurements. */
export function describe(a: Analysis): string {
  if (a.silent) return `${secs(a.duration)} of silence.`;
  const parts: string[] = [secs(a.duration)];
  if (a.channels > 1) parts.push('stereo');
  const c = a.centroid.mean;
  const noisy = a.flatness > 0.2 || a.pitch.voiced < 0.25;
  const brightness = c < 400 ? 'very dark' : c < 1000 ? 'dark' : c < 2500 ? 'mid-range' : c < 5000 ? 'bright' : 'very bright';
  parts.push(`${noisy ? (a.pitch.voiced > 0.25 ? 'mixed noise and tone' : 'noisy') : 'tonal'} and ${brightness} (centroid about ${hz(c)})`);
  const p = a.pitch;
  if (p.start !== null && p.end !== null && p.voiced >= 0.25) {
    const moved = 12 * Math.log2(p.end / p.start);
    if (Math.abs(moved) < 1) parts.push(`steady pitch near ${hzNote((p.start + p.end) / 2)}`);
    else parts.push(`${moved > 0 ? 'rising' : 'falling'} from about ${hzNote(p.start)} to ${hzNote(p.end)}`);
    if (p.rangeSemitones > Math.abs(moved) + 6) parts.push(`pitch wanders over ${p.rangeSemitones.toFixed(0)} semitones (${hz(p.min!)} to ${hz(p.max!)})`);
  }
  const at = a.attack * 1000;
  parts.push(`${at < 3 ? 'sharp' : at < 20 ? 'quick' : at < 100 ? 'soft' : 'slow'} attack (${at < 10 ? at.toFixed(1) : Math.round(at)} ms)`);
  parts.push(`${a.tail < 0.05 ? 'almost no' : a.tail < 0.3 ? 'short' : a.tail < 1 ? 'medium' : 'long'} tail (${a.tail.toFixed(2)} s)`);
  if (a.leadingSilence > 0.05) parts.push(`${Math.round(a.leadingSilence * 1000)} ms of silence at the start`);
  if (a.trailingSilence > 0.05) parts.push(`${Math.round(a.trailingSilence * 1000)} ms of silence at the end`);
  parts.push(`peak ${f1(a.truePeakDb)} dBTP${a.truePeakDb > -0.1 ? ' (at full scale)' : ''}`);
  parts.push(`${f1(a.lufs)} LUFS`);
  if (Math.abs(a.dc) > 0.005) parts.push(`DC offset ${(a.dc * 100).toFixed(1)} %`);
  parts.push(`${a.onsets} onset${a.onsets === 1 ? '' : 's'}`);
  return parts.join(', ') + '.';
}

