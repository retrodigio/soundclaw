// Which samples the person has seen. A sample the agent added carries the violet mark until it is played, opened or approved here; what was
// there when the page first opened a project counts as seen (it is not news). Kept per browser and project.

import { useMemo, useSyncExternalStore } from 'react';
import type { Store } from '../store.ts';
import { read, write } from './prefs.ts';

const cache = new Map<string, Set<string>>();
const subs = new Set<() => void>();
let version = 0;
const keyOf = (project: string): string => `soundclaw.seenSamples.${project}`;

function seenOf(project: string, names: readonly string[]): Set<string> {
  let s = cache.get(project);
  if (s) return s;
  const raw = read(keyOf(project));
  if (raw) {
    try { s = new Set(JSON.parse(raw) as string[]); } catch { s = undefined; }
  }
  if (!s) { s = new Set(names); write(keyOf(project), JSON.stringify([...s])); }
  cache.set(project, s);
  return s;
}

/** The names of samples an agent added that the person has not played, opened or approved yet. */
export function newSampleNames(store: Pick<Store, 'project' | 'samples' | 'status'>): Set<string> {
  const out = new Set<string>();
  if (!store.project || store.status !== 'open') return out;
  const seen = seenOf(store.project.name, store.samples.map((x) => x.name));
  for (const x of store.samples) if (x.author?.startsWith('agent:') && !seen.has(x.name)) out.add(x.name);
  return out;
}

/** The sample was played, opened or approved: its violet mark goes. */
export function markSampleSeen(store: Pick<Store, 'project' | 'samples' | 'status'>, name: string): void {
  if (!store.project) return;
  const seen = seenOf(store.project.name, store.samples.map((x) => x.name));
  if (seen.has(name)) return;
  seen.add(name);
  write(keyOf(store.project.name), JSON.stringify([...seen]));
  version++;
  for (const f of [...subs]) f();
}

/** The agent's new samples, kept up to date as they are seen. */
export function useNewSamples(store: Store): Set<string> {
  const v = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => version);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => newSampleNames(store), [store.samples, store.project?.name, store.status, v]);
}
