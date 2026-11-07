// The history tape: every change to a project is a command on one append-only tape, written by an
// author (`agent:<name>` or `human:<name>`), in groups (one batch = one group = one undo step).
// The sounds are the tape replayed. Undo and redo are commands on the tape too, so nothing is ever
// deleted: an undone group is simply no longer in effect.

import { AUTHOR_RE, GROUP_RE, applyCommand, parse, type Command } from './commands.ts';
import { Library } from './sets.ts';

export interface TapeEntry {
  seq: number;
  by: string;
  at?: string;
  group: string;
  cmd: string;
}

export const TAPE_FORMAT = 'soundclaw-history';
export const TAPE_LANG = 1;

export function tapeHeader(): string {
  return JSON.stringify({ format: TAPE_FORMAT, lang: TAPE_LANG });
}

export function entryToJson(e: TapeEntry): string {
  return JSON.stringify(e.at ? { seq: e.seq, by: e.by, at: e.at, group: e.group, cmd: e.cmd } : { seq: e.seq, by: e.by, group: e.group, cmd: e.cmd });
}

/** history.jsonl text: the header line, then one entry per line. */
export function tapeToJsonl(entries: TapeEntry[]): string {
  return [tapeHeader(), ...entries.map(entryToJson)].join('\n') + '\n';
}

export function parseTape(text: string): TapeEntry[] {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) throw new Error('the history is empty (no header line)');
  const head = JSON.parse(lines[0]!) as { format?: string; lang?: number };
  if (head.format !== TAPE_FORMAT) throw new Error('history line 1 is not a history header');
  if (head.lang !== TAPE_LANG) throw new Error(`history language ${head.lang} is not supported (this build reads ${TAPE_LANG})`);
  return lines.slice(1).map((l, i) => {
    const o = JSON.parse(l) as TapeEntry;
    if (typeof o.seq !== 'number' || typeof o.cmd !== 'string' || typeof o.group !== 'string' || typeof o.by !== 'string' || !GROUP_RE.test(o.group) || !AUTHOR_RE.test(o.by)) {
      throw new Error(`history line ${i + 2}: needs seq, by (agent:<name> or human:<name>), group (like g3) and cmd`);
    }
    return o;
  });
}

/** What a group is: content, or an undo / redo of another group. */
function groupKind(group: TapeEntry[]): { kind: 'content' } | { kind: 'undo' | 'redo'; target: string } {
  const m = /^(undo|redo) group=(g\d+)$/.exec(group[0]!.cmd);
  return m ? { kind: m[1] as 'undo' | 'redo', target: m[2]! } : { kind: 'content' };
}

/** The entries by group, in the order the groups began. */
export function groupsOf(entries: readonly TapeEntry[]): Map<string, TapeEntry[]> {
  const out = new Map<string, TapeEntry[]>();
  for (const e of entries) {
    const g = out.get(e.group);
    if (g) g.push(e);
    else out.set(e.group, [e]);
  }
  return out;
}

/**
 * The groups still in effect. A group is out of effect when a later group in effect undoes it;
 * a redo takes an undo out of effect, which brings the undone group back.
 */
export function activeGroups(entries: readonly TapeEntry[]): Set<string> {
  const groups = groupsOf(entries);
  const order = [...groups.keys()];
  const targeters = new Map<string, string[]>();
  for (const [g, es] of groups) {
    const k = groupKind(es);
    if (k.kind !== 'content') targeters.set(k.target, [...(targeters.get(k.target) ?? []), g]);
  }
  const live = new Set<string>();
  for (const g of [...order].reverse()) {
    if (!(targeters.get(g) ?? []).some((h) => live.has(h))) live.add(g);
  }
  return new Set(order.filter((g) => live.has(g)));
}

/** The content entries in effect, in tape order: what the sounds are replayed from. */
export function effectiveEntries(entries: readonly TapeEntry[]): TapeEntry[] {
  const active = activeGroups(entries);
  const groups = groupsOf(entries);
  return entries.filter((e) => active.has(e.group) && groupKind(groups.get(e.group)!).kind === 'content');
}

export interface ReplayResult {
  library: Library;
  problems: { seq: number; message: string }[];
}

/** Replay the tape: the effective content commands, applied in order. */
export function replay(entries: readonly TapeEntry[]): ReplayResult {
  const library = new Library();
  const problems: ReplayResult['problems'] = [];
  for (const e of effectiveEntries(entries)) {
    const p = parse(e.cmd);
    if (p.errors.length || p.commands.length !== 1) {
      problems.push({ seq: e.seq, message: p.errors[0]?.message ?? `'${e.cmd}' is not one command` });
      continue;
    }
    try {
      applyCommand(library, p.commands[0]!);
    } catch (err) {
      problems.push({ seq: e.seq, message: (err as Error).message });
    }
  }
  return { library, problems };
}

/** The group an `undo` or `redo` would act on, or why there is none. */
export function historyTarget(entries: readonly TapeEntry[], c: Extract<Command, { op: 'undo' | 'redo' }>): { group: string } | { error: string } {
  const groups = groupsOf(entries);
  const active = activeGroups(entries);
  const want = c.op === 'undo' ? 'content' : 'undo';
  const kindOf = (g: string) => groupKind(groups.get(g)!).kind;
  if (c.group) {
    if (!groups.has(c.group)) return { error: `no group ${c.group}` };
    if (kindOf(c.group) !== want) return { error: c.op === 'undo' ? `${c.group} is an undo or redo, not changes (redo undoes an undo)` : `${c.group} is not an undo (redo takes back an undo)` };
    if (!active.has(c.group)) return { error: c.op === 'undo' ? `${c.group} is undone already` : `${c.group} is not in effect` };
    return { group: c.group };
  }
  const candidates = [...groups].filter(([g, es]) => active.has(g) && kindOf(g) === want && (!c.by || es[0]!.by === c.by)).map(([g]) => g);
  const g = candidates.at(-1);
  if (!g) return { error: c.op === 'undo' ? `nothing to undo${c.by ? ` by ${c.by}` : ''}` : `nothing to redo${c.by ? ` by ${c.by}` : ''}` };
  return { group: g };
}

/** The next group id on a tape. */
export function nextGroup(entries: readonly TapeEntry[]): string {
  let n = 0;
  for (const e of entries) n = Math.max(n, Number(e.group.slice(1)));
  return `g${n + 1}`;
}
