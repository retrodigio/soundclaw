// Results as text, for the CLI and the MCP tools.

import type { Sound, TapeEntry } from '@soundclaw/core';
import type { ExportedSound } from './export.ts';
import type { RunOutcome } from './writer.ts';

export const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** A run's outcome: the commands as written to the tape, then the sounds they touched. */
export function formatRun(r: Extract<RunOutcome, { ok: true }>, summary: (id: string) => string): string {
  if (!r.added.length) return 'no commands';
  const first = r.added[0]!;
  const lines = [`applied ${plural(r.added.length, 'command')} as group ${r.group} by ${first.by}`];
  lines.push(...r.added.map((e) => `  #${e.seq} ${e.cmd}`));
  for (const id of r.touched) lines.push(summary(id));
  lines.push(r.warnings.length ? `warnings: ${r.warnings.join('; ')}` : 'warnings: none');
  return lines.join('\n');
}

export function formatErrors(source: string, errors: { line: number; col: number; message: string }[]): string {
  return errors.map((e) => `${source}:${e.line}:${e.col}: error: ${e.message}`).join('\n') + `\n${plural(errors.length, 'error')}; nothing was applied.`;
}

/** One sound on a line. */
export function soundLine(s: Sound): string {
  return `${s.id}: ${s.voice} ${s.frequency} Hz, ${s.duration} s, volume ${s.volume}${s.status === 'draft' ? '' : `, ${s.status}`}`;
}

/** The tape: `#12 g5 agent:claude 2026-11-06T10:00:00Z  sound set beep volume=0.4`, undone groups marked. */
export function formatHistory(entries: readonly TapeEntry[], active: ReadonlySet<string>): string {
  if (!entries.length) return 'the history is empty';
  return entries.map((e) => `#${e.seq} ${e.group} ${e.by}${e.at ? ' ' + e.at : ''}  ${e.cmd}${active.has(e.group) ? '' : '   (undone)'}`).join('\n');
}

export function formatExport(list: ExportedSound[]): string {
  return [
    `exported ${plural(list.length, 'sound')}`,
    ...list.map((x) => `  ${x.id}: ${x.file} (${x.bytes} bytes, ${x.seconds.toFixed(3)} s, peak ${x.peak.toFixed(3)}, samples ${x.samples.slice(0, 12)}${x.cached ? ', from the render cache' : ''})`),
  ].join('\n');
}
