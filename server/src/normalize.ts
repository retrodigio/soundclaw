// `normalize`, for the CLI, the MCP tool and the `normalize` line of a `run` batch: what to write to bring sounds, a set or a song
// to their loudness. It measures; the commands it returns are what goes on the tape.

import { normalizeCommands } from './ears.ts';
import { ProjectError } from './project.ts';
import { plural } from './report.ts';
import { normalizeSong } from './songs.ts';
import type { Writer } from './writer.ts';

export interface NormalizePlan {
  /** Plain commands, one per line; empty when nothing needs to change. */
  commands: string;
  /** Things worth saying that are not errors. */
  notes: string[];
  /** A song with layers: how the mixes were fitted. */
  info: string | null;
  /** "<what> to <target>", for the sentence "normalized …". */
  what: string;
  /** For the sentence "<what> already at …". */
  already: string;
}

/** The words after `normalize`: a song (optionally with `target=<LUFS>`), or sounds and sets (optionally ending in a class or `target=<LUFS>`). */
export function normalizePlan(w: Writer, args: readonly string[]): NormalizePlan {
  const [first, ...rest] = args;
  if (!first) throw new ProjectError('normalize: name sounds, a set or a song');
  if (w.hasSong(first)) {
    if (rest.length > 1) throw new ProjectError(`normalize: a song takes target=<LUFS> (or nothing: its class target), not '${rest.join(' ')}'`);
    const t = rest[0]?.replace(/^target=/, '');
    const target = t === undefined ? undefined : Number(t.replace(/lufs$/i, ''));
    if (target !== undefined && !(target >= -60 && target <= 0)) throw new ProjectError('normalize: a song takes target=<LUFS> (or nothing: its class target)');
    const n = normalizeSong(w, first, target);
    return { commands: n.command ?? '', notes: n.notes, info: n.info ?? null, what: `${first} to ${n.target} LUFS`, already: `${first} is already at ${n.target} LUFS` };
  }
  const names = [...args];
  const last = names[names.length - 1]!;
  const isName = (x: string): boolean => w.has(x) || w.hasSet(x);
  const spec = names.length > 1 && !isName(last) ? names.pop() : undefined;
  const n = normalizeCommands(w, names, spec);
  return { commands: n.commands, notes: n.notes, info: null, what: `${plural(n.ids.length, 'sound')} to ${n.target}`, already: `${plural(n.ids.length, 'sound')} already at ${n.target}` };
}
