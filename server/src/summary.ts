// One-line summaries that end every result, so an agent that cannot listen still gets numbers.

import { activeGroups, joinChannels, levels, momentLine, momentOf, samplesHash } from '@soundclaw/core';
import { checkLine } from './ears.ts';
import { formatHistory, soundLine } from './report.ts';
import type { Writer } from './writer.ts';

/**
 * `beep: tone 880 Hz, 0.5 s, volume 0.4 → 22050 samples, peak 0.400, rms 0.283, hash 1a2b3c4d5e6f`
 * and, on the next line, the check summary (`checks: 4/5 pass; failing: …`); or `beep: removed`.
 */
export function soundSummary(w: Writer, id: string): string {
  if (!w.has(id)) return `${id}: removed`;
  const s = w.sound(id);
  const r = w.render(id);
  const l = levels(r.channels.length > 1 ? joinChannels(r.channels) : r.samples);
  const moment = momentOf(s, w.sets());
  return `${soundLine(s)} → ${r.samples.length} samples${r.channels.length > 1 ? ` × ${r.channels.length} channels` : ''}, peak ${l.peak.toFixed(3)}, rms ${l.rms.toFixed(3)}, hash ${samplesHash(joinChannels(r.channels)).slice(0, 12)}\n    ${checkLine(w.measure(id))}${moment ? `\n    ${momentLine(moment)}` : ''}`;
}

export function historyText(w: Writer, o: { sound?: string; by?: string; limit?: number } = {}): string {
  const all = w.tape();
  const groups = new Set(all.map((e) => e.group));
  const active = activeGroups(all);
  const shown = w.history(o);
  const head = `${all.length} commands in ${groups.size} groups${active.size < groups.size ? `; ${groups.size - active.size} group${groups.size - active.size === 1 ? '' : 's'} out of effect` : ''}${shown.length < all.length ? `; showing ${shown.length}` : ''}`;
  return `${head}\n${formatHistory(shown, active)}`;
}
