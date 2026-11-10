// The library: tabs with counts, a filter field, chips, the needs-attention order, a windowed
// list with mini waveforms from the server's cards, LUFS and the check glyph. ↑↓ moves the
// selection and previews it, Enter opens it, Space plays it, R asks for changes on it.

import { askAttr } from './ask.tsx';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { SoundSummary } from '@soundclaw/server/protocol';
import type { Store } from '../store.ts';
import { Chip, GLYPH, Popover, Tabs, WORD, type CheckKind } from './controls.tsx';
import { Search } from './icons.tsx';
import { VirtualList, type VirtualHandle } from './layout.tsx';
import { usePrefs, setPrefs, type Prefs } from './prefs.ts';
import { checkOf, lufsText, rowName, useAttentionOrder, type Focus } from './shellData.ts';
import { SamplesBrowser } from './Samples.tsx';

const LICENCE_GLYPH: Record<string, string> = { shippable: '✓', attribution: '©', blocked: '×', unknown: '?' };
const LICENCE_KIND: Record<string, CheckKind> = { shippable: 'pass', attribution: 'warn', blocked: 'fail', unknown: 'warn' };

/** Where a sample stands for shipping: a glyph and a word together (never colour alone). */
export function LicenceBadge({ state, licence, testId }: { state: string; licence: string; testId?: string }) {
  return (
    <span className="badge lib-lic" data-kind={LICENCE_KIND[state] ?? 'warn'} data-state={state} title={`licence ${licence}: ${state}`} data-testid={testId} aria-label={`licence ${state}: ${licence}`}>
      <span className="mono" aria-hidden>{LICENCE_GLYPH[state] ?? '?'}</span>{state}
    </span>
  );
}

/** A sample row's numbers: length, rate, channels and the note it sounds at. */
function sampleNumbers(x: { seconds: number; rate: number; channels: number; root?: string | undefined }): string {
  const len = x.seconds < 10 ? x.seconds.toFixed(2) : x.seconds.toFixed(1);
  return `${len} s · ${Number((x.rate / 1000).toFixed(1))} kHz · ${x.channels === 1 ? 'mono' : x.channels === 2 ? 'stereo' : `${x.channels} ch`}${x.root ? ` · ${x.root}` : ''}`;
}

/** The row height the density gives (24 compact, 32 comfortable), read from the token. */
export function useRowHeight(): number {
  const { density } = usePrefs();
  const [h, setH] = useState(24);
  useEffect(() => {
    const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row-h'), 10);
    setH(Number.isFinite(v) && v > 0 ? v : density === 'comfortable' ? 32 : 24);
  }, [density]);
  return h;
}

/** The server's peaks for a row, drawn small. The card is asked for while the row exists (the list only builds rows in view). */
export function MiniWave({ store, id, w = 48, h = 14 }: { store: Store; id: string; w?: number; h?: number }) {
  const [, bump] = useState(0);
  useEffect(() => {
    const off = store.subscribeCard(id, () => bump((n) => n + 1));
    store.wantCard(id);
    return () => { off(); store.unwantCard(id); };
  }, [store, id]);
  const card = store.cardOf(id);
  const sum = store.summary(id);
  // a card for an earlier version of the sound still draws; it is replaced when the new one arrives
  if (!card) return <span className="mini-shim" style={{ width: w, height: Math.max(6, h - 4) }} aria-hidden />;
  const n = 24;
  const pk = card.wave.max.length;
  let top = '', bot = '';
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i / n) * pk), b = Math.max(a + 1, Math.floor(((i + 1) / n) * pk));
    let mx = 0, mn = 0;
    for (let j = a; j < b; j++) { mx = Math.max(mx, card.wave.max[j]!); mn = Math.min(mn, card.wave.min[j]!); }
    const x = ((i + 0.5) / n) * w;
    top += `${i ? 'L' : 'M'}${x.toFixed(1)} ${(h / 2 - mx * h / 2).toFixed(1)}`;
    bot = `L${x.toFixed(1)} ${(h / 2 - mn * h / 2).toFixed(1)}${bot}`;
  }
  return <svg className="mini-wave" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden data-stale={sum && card.key !== sum.key ? 'true' : undefined}><path d={`${top}${bot}Z`} /></svg>;
}

/** The server is still working out cards (thumbnails, numbers, checks): a thin ember line under the header counts them. Gone when every sound has one. */
export function ThumbProgress({ store, testId = 'thumb-progress' }: { store: Store; testId?: string }) {
  const total = store.index.length;
  let known = 0;
  for (const x of store.index) if (x.info) known++;
  if (!total || known >= total) return null;
  return (
    <div className="thumb-progress" data-testid={testId} data-known={known} data-total={total}>
      <div className="thumb-line" role="progressbar" aria-label="Thumbnails worked out" aria-valuemin={0} aria-valuemax={total} aria-valuenow={known} aria-valuetext={`${known} of ${total} thumbnails`}><span style={{ width: `${(100 * known) / total}%` }} /></div>
      <span className="mono thumb-text">index {total} {'·'} thumbs {known} / {total}</span>
    </div>
  );
}

function Glyph({ kind }: { kind: CheckKind }) {
  return <span className="mono lib-glyph" data-kind={kind} role="img" aria-label={WORD[kind]}>{GLYPH[kind]}</span>;
}

export interface LibraryProps {
  store: Store;
  selected: Focus | null;
  onSelect(f: Focus | null): void;
  onOpen(f: Focus): void;
  onAsk(f: Focus): void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

export function Library({ store, selected, onSelect, onOpen, onAsk, inputRef }: LibraryProps) {
  const prefs = usePrefs();
  const rowH = useRowHeight();
  // the list's numbers move while an editor is open: the library keeps up through its own channel
  useSyncExternalStore(store.subscribeCards2, store.getCardsVersion);
  const [q, setQ] = useState('');
  const [attention, setAttention] = useState(false);
  const [voice, setVoice] = useState<string | null>(null);
  const [status, setStatus] = useState('any');
  const [check, setCheck] = useState('any');
  const [more, setMore] = useState(false);
  const [sort, setSort] = useState<'attention' | 'name'>('attention');
  const list = useRef<VirtualHandle>(null);
  const tab = prefs.libTab;

  const byAttention = useAttentionOrder(store);
  const sorted = useMemo(() => (sort === 'attention' ? byAttention : [...store.index].sort((a, b) => a.id.localeCompare(b.id))), [byAttention, store.index, sort]);
  const needs = useMemo(() => store.index.filter((s) => checkOf(s) === 'fail').length, [store.index]);
  const failingNames = useMemo(() => [...new Set(store.index.flatMap((s) => s.info?.failing ?? []))].sort(), [store.index]);
  const voices = useMemo(() => [...new Set(store.index.map((s) => s.voice))].sort(), [store.index]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sorted.filter((s) => {
      if (needle && !s.id.toLowerCase().includes(needle) && !s.label.toLowerCase().includes(needle)) return false;
      if (attention && checkOf(s) !== 'fail') return false;
      if (voice && s.voice !== voice) return false;
      if (status !== 'any' && s.status !== status) return false;
      if (check !== 'any' && !(s.info?.failing ?? []).includes(check)) return false;
      return true;
    });
  }, [sorted, q, attention, voice, status, check]);

  const others = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const has = (id: string) => !needle || id.toLowerCase().includes(needle);
    return {
      sets: store.sets.filter((x) => has(x.id)).map((x) => ({ id: x.id, sub: `${x.members.length} members${x.target !== null ? ` · ${x.target} LUFS` : ''}` })),
      songs: store.songs.filter((x) => has(x.id)).map((x) => ({ id: x.id, sub: `${x.tempo} BPM${x.key ? ` · ${x.key}` : ''}` })),
      instruments: store.instruments.filter((x) => has(x.id)).map((x) => ({ id: x.id, sub: '' })),
    };
  }, [store.sets, store.songs, store.instruments, store.samples, q]);

  const kind: 'sound' | 'set' | 'song' | null = tab === 'sounds' ? 'sound' : tab === 'sets' ? 'set' : tab === 'songs' ? 'song' : null;
  const otherRows = tab === 'sounds' || tab === 'samples' ? [] : others[tab];
  const ids: string[] = tab === 'sounds' ? rows.map((s) => s.id) : otherRows.map((x) => x.id);
  const at = selected && kind && selected.kind === kind ? ids.indexOf(selected.id) : -1;

  // keep the selected row in view when it moves by keyboard
  // (not when the order changes under it because the agent wrote: the list never moves on a server update)
  const lastSel = useRef<string | null>(null);
  useEffect(() => {
    const id = selected?.id ?? null;
    if (at >= 0 && id !== lastSel.current) list.current?.scrollToIndex(at);
    lastSel.current = id;
  }, [at, selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // preview on select: the selection changed by keys or a click plays after a short pause, so a run of ↑ keys renders once
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preview = useCallback((id: string) => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    if (!prefs.previewOnSelect) return;
    previewTimer.current = setTimeout(() => { void store.play(id); }, 140);
  }, [store, prefs.previewOnSelect]);
  useEffect(() => () => { if (previewTimer.current) clearTimeout(previewTimer.current); }, []);

  const pick = useCallback((i: number) => {
    const id = ids[i];
    if (!id || !kind) return;
    onSelect({ kind, id });
    if (kind === 'sound') preview(id);
  }, [ids, kind, onSelect, preview]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); pick(Math.min(ids.length - 1, at + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); pick(Math.max(0, at <= 0 ? 0 : at - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); pick(0); }
    else if (e.key === 'End') { e.preventDefault(); pick(ids.length - 1); }
    else if (e.key === 'Enter' && selected && kind) { e.preventDefault(); onOpen(selected); }
    else if (e.key === ' ' && selected && kind) {
      e.preventDefault();
      if (previewTimer.current) clearTimeout(previewTimer.current);
      if (kind === 'sound') void store.play(selected.id); else if (kind === 'song') void store.playSong(selected.id, 'full');
    } else if ((e.key === 'r' || e.key === 'R') && selected && kind) { e.preventDefault(); onAsk(selected); }
  };

  const newIds = store.agentNew;
  const now = Date.now();
  const renderSound = (i: number) => {
    const s: SoundSummary = rows[i]!;
    const sel = selected?.kind === 'sound' && selected.id === s.id;
    const k = checkOf(s);
    const fresh = newIds.has(s.id);
    const pulse = (store.pulses.get(s.id) ?? 0) > now - 900;
    return (
      <div className={`lib-row${sel ? ' sel' : ''}${pulse ? ' pulse' : ''}`} data-testid={`lib-row-${s.id}`} data-ask-item={s.id} {...askAttr(s.id, { kind: 'item' }, s.id)} data-check={k} data-new={fresh || undefined}
        onClick={() => pick(i)} onDoubleClick={() => onOpen({ kind: 'sound', id: s.id })}>
        <span className="new-dot" aria-label={fresh ? 'changed by the agent' : undefined} role={fresh ? 'img' : undefined} style={{ opacity: fresh ? 1 : 0 }} />
        <span className="lib-name" title={s.label ? `${s.id}: ${s.label}` : s.id}>{rowName(s)}</span>
        <MiniWave store={store} id={s.id} />
        <span className="mono lib-lufs">{s.info ? lufsText(s.info.lufs) : '…'}</span>
        <Glyph kind={k} />
      </div>
    );
  };
  const renderOther = (i: number) => {
    const x = otherRows[i]!;
    const sel = !!kind && selected?.kind === kind && selected.id === x.id;
    return (
      <div className={`lib-row${sel ? ' sel' : ''}`} data-testid={`lib-row-${x.id}`} data-ask-item={x.id} {...(kind === 'song' ? askAttr(x.id, { kind: 'item' }, x.id) : {})} onClick={() => pick(i)} onDoubleClick={() => kind && onOpen({ kind, id: x.id })}>
        <span className="new-dot" style={{ opacity: 0 }} />
        <span className="lib-name">{x.id}</span>
        <span className="mono lib-sub">{x.sub}</span>
      </div>
    );
  };

  const counts = { sounds: store.index.length, sets: store.sets.length, songs: store.songs.length, instruments: store.instruments.length, samples: store.samples.length };
  const total = tab === 'sounds' ? store.index.length : counts[tab];
  const shown = tab === 'sounds' ? rows.length : otherRows.length;
  const onFilterKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); (e.currentTarget.closest('.library')?.querySelector('.vlist') as HTMLElement | null)?.focus(); pick(Math.max(0, at)); }
    else if (e.key === 'Escape') { if (q) { setQ(''); e.stopPropagation(); } else e.currentTarget.blur(); }
  };

  return (
    <div className="library-in" data-testid="library">
      <Tabs<Prefs['libTab']> label="Library" value={tab} onChange={(v) => setPrefs({ libTab: v })} testId="lib-tabs"
        tabs={[{ value: 'sounds', label: 'Sounds', count: counts.sounds, testId: 'lib-tab-sounds' }, { value: 'sets', label: 'Sets', count: counts.sets, testId: 'lib-tab-sets' }, { value: 'songs', label: 'Songs', count: counts.songs, testId: 'lib-tab-songs' },
          { value: 'instruments', label: 'Instr', count: counts.instruments, testId: 'lib-tab-instruments' }, { value: 'samples', label: 'Samples', count: counts.samples, testId: 'lib-tab-samples' }]} />
      {tab === 'samples' ? <SamplesBrowser store={store} inputRef={inputRef} onOpen={(name) => { location.hash = `#/sample/${name}`; }} /> : (
      <>
      <div className="lib-filter">
        <label className="lib-search"><Search size={12} /><span className="sr-only">Filter {tab}</span>
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onFilterKey} placeholder={`Filter ${tab}`} data-testid="lib-filter" spellCheck={false} autoComplete="off" />
          <kbd className="kbd">/</kbd>
        </label>
        {tab === 'sounds' && (
          <div className="chips" data-testid="lib-chips">
            <Chip on={attention} tone="ember" onClick={() => setAttention(!attention)} testId="chip-attention">Needs attention · {needs}</Chip>
            {voices.map((v) => <Chip key={v} on={voice === v} onClick={() => setVoice(voice === v ? null : v)} testId={`chip-voice-${v}`}>{v}</Chip>)}
            {check !== 'any' && <Chip on tone="ember" onRemove={() => setCheck('any')}>{GLYPH.fail} {check}</Chip>}
            {status !== 'any' && <Chip on tone="ember" onRemove={() => setStatus('any')}>{status}</Chip>}
            <Popover open={more} onClose={() => setMore(false)} label="More filters" trigger={<Chip onClick={() => setMore(!more)} testId="chip-more">+ filter</Chip>}>
              <label className="pop-field">status
                <select value={status} onChange={(e) => setStatus(e.target.value)} data-testid="lib-filter-status"><option value="any">any</option><option value="draft">draft</option><option value="approved">approved</option><option value="rejected">asked for changes</option></select>
              </label>
              <label className="pop-field">failing check
                <select value={check} onChange={(e) => setCheck(e.target.value)} data-testid="lib-filter-check"><option value="any">any</option>{failingNames.map((n) => <option key={n} value={n}>{n}</option>)}</select>
              </label>
            </Popover>
          </div>
        )}
      </div>
      <div className="lib-sort">
        {tab === 'sounds'
          ? <button type="button" className="link-btn" onClick={() => setSort(sort === 'attention' ? 'name' : 'attention')} data-testid="lib-sort" title="Change the order">Sort: {sort === 'attention' ? 'needs attention' : 'name'}</button>
          : <span>Sort: name</span>}
        <span className="mono" data-testid="lib-count">{shown} / {total}</span>
      </div>
      {tab === 'sounds' && <ThumbProgress store={store} />}
      <div className="lib-list" onKeyDown={onKeyDown}>
        {total === 0 ? <p className="lib-empty dim">{tab === 'sounds' ? 'No sounds yet.' : `No ${tab} yet.`}</p> : shown === 0 ? <p className="lib-empty dim">Nothing matches.</p> : (
          <VirtualList ref={list} count={shown} rowHeight={rowH} label={`${tab}`} activeIndex={at} testId="lib-list" renderRow={tab === 'sounds' ? renderSound : renderOther} />
        )}
      </div>
      <div className="lib-foot"><span>{'↑↓'} audition {'·'} Enter open</span><span className="mono">{prefs.density}</span></div>
      </>
      )}
    </div>
  );
}
