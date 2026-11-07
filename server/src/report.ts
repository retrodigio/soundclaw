// Results as text, for the CLI and the MCP tools.

import { CLASSIC_FIELDS, WAVE_NAMES, isStereo, layerLabel, type Sound, type TapeEntry } from '@soundclaw/core';
import type { RunOutcome } from './writer.ts';

export const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** A run's outcome: the commands as written to the tape, then the sounds they touched. */
export function formatRun(r: Extract<RunOutcome, { ok: true }>, summary: (id: string) => string, setSummary: (id: string) => string = () => '', songSummary: (id: string) => string = () => ''): string {
  if (!r.added.length) return 'no commands';
  const first = r.added[0]!;
  const lines = [`applied ${plural(r.added.length, 'command')} as group ${r.group} by ${first.by}`];
  lines.push(...r.added.map((e) => `  #${e.seq} ${e.cmd.length > 150 ? `${e.cmd.slice(0, 120).replace(/\\n/g, ' ')}… (${e.cmd.length} characters)` : e.cmd}`));
  for (const id of r.touched) lines.push(summary(id));
  for (const id of r.touchedSets ?? []) lines.push(setSummary(id));
  for (const id of r.touchedInstruments ?? []) lines.push(`instrument ${id}: ${r.added.some((e) => e.cmd.startsWith('instrument remove ' + id)) ? 'removed' : 'changed'}`);
  for (const id of r.touchedSongs ?? []) lines.push(songSummary(id));
  lines.push(r.warnings.length ? `warnings: ${r.warnings.join('; ')}` : 'warnings: none');
  return lines.join('\n');
}

export function formatErrors(source: string, errors: { line: number; col: number; message: string }[]): string {
  return errors.map((e) => `${source}:${e.line}:${e.col}: error: ${e.message}`).join('\n') + `\n${plural(errors.length, 'error')}; nothing was applied.`;
}

/** One sound on a line. */
export function soundLine(s: Sound): string {
  const status = s.status === 'draft' ? '' : `, ${s.status}`;
  if (s.voice === 'tone') return `${s.id}: ${s.voice} ${s.frequency} Hz, ${s.duration} s, volume ${s.volume}${status}`;
  if (s.voice === 'layered') {
    const parts = s.layers.map((l, i) => `${i + 1} ${layerLabel(l)}${l.mute ? ' (muted)' : ''}${l.solo ? ' (solo)' : ''}${l.fx.length ? ` +${l.fx.map((f) => f.kind).join('+')}` : ''}`);
    return `${s.id}: layered ${s.layers.length ? `${s.layers.length} layer${s.layers.length === 1 ? '' : 's'} [${parts.join('; ')}]` : '(no layers yet)'}${s.master.length ? `, master ${s.master.map((f) => f.kind).join('+')}` : ''}${isStereo(s) ? ', stereo' : ''}${status}`;
  }
  const set = CLASSIC_FIELDS.filter((f) => s.patch[f.name] !== f.default).map((f) => `${f.name}=${f.name === 'wave' ? WAVE_NAMES[s.patch.wave] : s.patch[f.name]}`);
  if (s.patch.seed !== undefined) set.push(`seed=${s.patch.seed}`);
  return `${s.id}: classic${s.classicOnly ? ' (marked classic)' : ''}${set.length ? ' ' + set.join(' ') : ' (all defaults)'}${status}`;
}

/** The tape: `#12 g5 agent:claude 2026-11-06T10:00:00Z  sound set beep volume=0.4`, undone groups marked. */
export function formatHistory(entries: readonly TapeEntry[], active: ReadonlySet<string>): string {
  if (!entries.length) return 'the history is empty';
  return entries.map((e) => `#${e.seq} ${e.group} ${e.by}${e.at ? ' ' + e.at : ''}  ${e.cmd}${active.has(e.group) ? '' : '   (undone)'}`).join('\n');
}
