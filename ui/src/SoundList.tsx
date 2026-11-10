// The home page's list of sounds: filters (name prefix, voice, status, checks, tag) over the
// server's list, shown a page at a time (more as you scroll), each card asking the server for its
// thumbnails only when it comes into view. A project of hundreds of sounds opens at once.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SoundSummary } from '@soundclaw/server/protocol';
import { CardGrid } from './studio/NeedCard.tsx';
import { checkOf, useAttentionOrder } from './studio/shellData.ts';
import type { Store } from './store.ts';
import { plural } from './studio/values.ts';

export const PAGE = 48;

export interface Filters { name: string; voice: string; status: string; check: string; tag: string }
export const NO_FILTERS: Filters = { name: '', voice: 'any', status: 'any', check: 'any', tag: '' };

/** Whether a sound passes the filters; the checks filter uses what the server last knew (a sound not checked yet matches neither). */
export function matches(s: SoundSummary, f: Filters, tagsOf: (id: string) => string[]): boolean {
  if (f.name && !s.id.toLowerCase().startsWith(f.name.toLowerCase())) return false;
  if (f.voice !== 'any' && s.voice !== f.voice) return false;
  if (f.status !== 'any' && s.status !== f.status) return false;
  if (f.check === 'pass' && s.info?.pass !== true) return false;
  if (f.check === 'fail' && s.info?.pass !== false) return false;
  if (f.check === 'unknown' && s.info) return false;
  if (f.tag && !tagsOf(s.id).includes(f.tag)) return false;
  return true;
}

/** Show `PAGE` more when the end of what is shown comes near. */
export function useMore(total: number, reset: unknown): { shown: number; sentinel: React.RefObject<HTMLDivElement | null>; more(): void } {
  const [shown, setShown] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => setShown(PAGE), [reset]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setShown((n) => n + PAGE); }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [total, shown]);
  return { shown: Math.min(shown, total), sentinel, more: () => setShown((n) => n + PAGE) };
}

export function FilterBar({ filters, set, tags, prefix }: { filters: Filters; set(f: Filters): void; tags: string[]; prefix: string }) {
  const up = (k: keyof Filters) => (e: { target: { value: string } }) => set({ ...filters, [k]: e.target.value });
  return (
    <div className="filters row wrap" data-testid={`${prefix}-filters`}>
      <label>name <input value={filters.name} placeholder="starts with…" data-testid={`${prefix}-filter-name`} onChange={up('name')} style={{ width: '9em' }} /></label>
      <label>voice
        <select data-testid={`${prefix}-filter-voice`} value={filters.voice} onChange={up('voice')}>
          <option value="any">any</option><option value="classic">classic</option><option value="layered">layered</option><option value="tone">tone</option>
        </select>
      </label>
      <label>status
        <select data-testid={`${prefix}-filter-status`} value={filters.status} onChange={up('status')}>
          <option value="any">any</option><option value="draft">draft</option><option value="approved">approved</option><option value="rejected">asked for changes</option>
        </select>
      </label>
      <label>checks
        <select data-testid={`${prefix}-filter-check`} value={filters.check} onChange={up('check')}>
          <option value="any">any</option><option value="pass">pass</option><option value="fail">fail</option><option value="unknown">not checked yet</option>
        </select>
      </label>
      <label>tag
        <select data-testid={`${prefix}-filter-tag`} value={filters.tag} onChange={up('tag')}>
          <option value="">any</option>
          {tags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
    </div>
  );
}

export function SoundList({ store, attentionOnly = false }: { store: Store; attentionOnly?: boolean }) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const tagMap = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const q of store.requests) for (const t of q.tags ?? []) { let x = m.get(q.sound); if (!x) { x = new Set(); m.set(q.sound, x); } x.add(t); }
    return m;
  }, [store.requests]);
  const allTags = useMemo(() => [...new Set([...tagMap.values()].flatMap((x) => [...x]))].sort(), [tagMap]);
  const ordered = useAttentionOrder(store);
  const filtered = ordered.filter((s) => (!attentionOnly || checkOf(s) === 'fail') && matches(s, filters, (id) => [...(tagMap.get(id) ?? [])]));
  const mineBy = useMemo(() => {
    const m = new Map<string, typeof store.requests>();
    for (const q of store.requests) { const x = m.get(q.sound); if (x) x.push(q); else m.set(q.sound, [q]); }
    return m;
  }, [store.requests]);
  const playsBy = new Map<string, number>();
  for (const p of store.played) if (!p.slot) playsBy.set(p.id, (playsBy.get(p.id) ?? 0) + 1);
  const presence = JSON.stringify(store.presence);
  return (
    <>
      {(store.index.length > PAGE / 2 || attentionOnly) && (
        <>
          {!attentionOnly && <FilterBar filters={filters} set={setFilters} tags={allTags} prefix="sounds" />}
          <div className="dim" data-testid="sounds-count">{filtered.length} of {plural(store.index.length, 'sound')}{attentionOnly ? ' need attention' : ''}{store.index.some((s) => !s.info) ? ` · ${store.index.filter((s) => !s.info).length} not checked yet` : ''}</div>
        </>
      )}
      <section className="sounds need" data-testid="sounds" aria-label="Sounds" data-count={filtered.length}>
        <CardGrid store={store} sounds={filtered} mineBy={mineBy} playsBy={playsBy} presence={presence} />
      </section>
      {filtered.length === 0 && store.index.length > 0 && <p className="dim" data-testid="sounds-none">No sounds match.</p>}
    </>
  );
}
