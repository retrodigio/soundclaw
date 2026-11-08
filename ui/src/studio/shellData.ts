// What the shell derives from the store: the order of the library, which sound a command names,
// the focused item, and how requests read in words.

import { useEffect, useMemo, useState } from 'react';
import type { SoundSummary } from '@soundclaw/server/protocol';
import type { TapeEntry, WorkRequest } from '@soundclaw/core';
import type { Store, Route } from '../store.ts';
import type { CheckKind } from './controls.tsx';

/** What a library row calls a sound. A sound has no title of its own yet (the list's `label` says what it is made of), so this is its id, the name every command uses; the label is the row's tooltip. */
export const rowName = (s: SoundSummary): string => s.id;

/** The worst check of a sound from what the list knows: × fails, … is not checked yet, ✓ passes. (The list's numbers hold pass or fail only.) */
export function checkOf(s: SoundSummary): CheckKind {
  return s.info ? (s.info.pass ? 'pass' : 'fail') : 'checking';
}

/** Failing first, then checking (no verdict yet), then passing. */
const RANK: Record<CheckKind, number> = { fail: 0, warn: 1, checking: 2, pass: 3 };
export const attentionRank = (s: SoundSummary): number => RANK[checkOf(s)];

/** The sound a tape command names (`sound set beep …`, `mutate beep …`, `sound mark beep approved`), among the sounds the project has. */
export function soundOfCmd(cmd: string, known: Set<string>): string | null {
  const t = cmd.split(/\s+/);
  for (let i = 1; i < Math.min(t.length, 4); i++) if (known.has(t[i]!)) return t[i]!;
  return null;
}

/** For each sound, the sequence number of the latest tape entry that names it (0: none held). Recomputed when the tape grows. */
let lastKey = '';
let lastMap = new Map<string, number>();
export function lastChanges(tape: TapeEntry[], index: SoundSummary[]): Map<string, number> {
  const key = `${tape.length}|${tape.at(-1)?.seq ?? 0}|${index.length}`;
  if (key === lastKey) return lastMap;
  const known = new Set(index.map((x) => x.id));
  const m = new Map<string, number>();
  for (const e of tape) { const id = soundOfCmd(e.cmd, known); if (id) m.set(id, e.seq); }
  lastKey = key;
  lastMap = m;
  return m;
}

/** The library's default order: needs attention first (failing, then checking, then passing), the most recently changed first within each. */
export function sortByAttention(index: SoundSummary[], tape: TapeEntry[]): SoundSummary[] {
  const last = lastChanges(tape, index);
  return index.map((s, i) => ({ s, i })).sort((a, b) => attentionRank(a.s) - attentionRank(b.s) || (last.get(b.s.id) ?? 0) - (last.get(a.s.id) ?? 0) || a.i - b.i).map((x) => x.s);
}

/** The item the transport and the bottom panel act on: the open tab's item, else the library's selection. */
export interface Focus { kind: 'sound' | 'song' | 'set'; id: string }
export function focusOf(route: Route, selected: Focus | null): Focus | null {
  if (route.kind === 'sound') return { kind: 'sound', id: route.id };
  if (route.kind === 'song') return { kind: 'song', id: route.id };
  if (route.kind === 'set') return { kind: 'set', id: route.id };
  if (route.kind === 'audition' && route.set) return { kind: 'set', id: route.set };
  return selected;
}

export const hashOf = (f: Focus): string => `#/${f.kind}/${f.id}`;

/** A request's state in the words the rail uses: sent → seen → claimed → working → ready for review. */
export function requestState(q: WorkRequest): { word: string; tone: 'quiet' | 'agent' | 'warn' | 'pass' } {
  switch (q.state) {
    case 'open': return (q.seen ?? []).length ? { word: 'seen', tone: 'quiet' } : { word: 'sent', tone: 'quiet' };
    case 'claimed': return q.latest ? { word: 'working', tone: 'agent' } : { word: 'claimed', tone: 'agent' };
    case 'blocked': return { word: 'blocked', tone: 'warn' };
    case 'done': return { word: 'ready for review', tone: 'pass' };
    default: return { word: q.state, tone: 'quiet' };
  }
}

/** "3 min ago" from an ISO time, or '' when there is none. */
export function ago(at: string | undefined, now: number): string {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return 'now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const MINUS = '−';
export const lufsText = (v: number | null | undefined): string => (v === undefined ? '…' : v === null ? `${MINUS}∞` : v.toFixed(1).replace('-', MINUS));

export interface FeedItem { key: string; by: string; text: string; meta: string; at: number; sound: string | null }

/** The live feed: the tape's newest commands and the requests' events, newest first. */
export function buildFeed(store: Store, limit = 40): FeedItem[] {
  const known = new Set(store.index.map((x) => x.id));
  const now = Date.now();
  const items: FeedItem[] = [];
  for (const e of store.tape.slice(-limit)) {
    const sound = soundOfCmd(e.cmd, known);
    items.push({ key: `t${e.seq}`, by: e.by, text: e.cmd, meta: `#${e.seq} · ${e.by}${e.at ? ` · ${ago(e.at, now)}` : ''}`, at: e.at ? Date.parse(e.at) : 0, sound });
  }
  for (const q of store.requests.slice(-12)) {
    items.push({ key: `q${q.id}`, by: q.by, text: `${q.by.startsWith('human:') ? 'You asked' : `${q.by} asked`}: ${q.note}`, meta: `request ${q.id} · ${q.sound} · ${ago(q.at, now)}`, at: Date.parse(q.at), sound: null });
    q.events.forEach((ev, i) => {
      if (!ev.text && ev.type !== 'claim') return;
      items.push({ key: `q${q.id}e${i}`, by: ev.by, text: `${ev.type === 'claim' ? 'Claimed' : ev.type === 'done' ? 'Finished' : ev.type === 'blocked' ? 'Asked' : ev.type === 'progress' ? 'Progress' : ev.type}${ev.text ? `: ${ev.text}` : ''}`, meta: `request ${q.id} · ${ago(ev.at, now)}`, at: Date.parse(ev.at), sound: ev.type === 'done' ? q.sound : null });
    });
  }
  return items.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
}

/**
 * The needs-attention order as ids, for rows that must not jump while numbers stream in: it is worked out again when the list
 * or the tape changes, and once the checks the server knows have been still for a moment, never on each arriving number.
 */
export function useAttentionOrder(store: Store): SoundSummary[] {
  const known = store.index.reduce((n, s) => n + (s.info ? 1 : 0), 0);
  const [settled, setSettled] = useState(known);
  useEffect(() => { const t = setTimeout(() => setSettled(known), 1200); return () => clearTimeout(t); }, [known]);
  const ids = useMemo(
    () => sortByAttention(store.index, store.tape).map((s) => s.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store.index.length, store.index[0]?.id, store.index.at(-1)?.id, store.tape.length, settled],
  );
  const byId = new Map(store.index.map((s) => [s.id, s]));
  return ids.flatMap((id) => { const s = byId.get(id); return s ? [s] : []; });
}
