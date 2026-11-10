// The Samples tab of the library: a browser with three modes. Project: this project's samples, filtered by the numbers query. Library: the
// registered sample libraries, 48 files at a time, nothing loaded until one is auditioned. Takes: what generation made, to keep or discard.
// Space plays, ↑↓ moves (and previews), Enter opens a sample (or uses a library file); a project row drags onto a layer list.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { LibraryHitJson, LibraryListing, SampleInfo } from '@soundclaw/server/protocol';
import type { Store } from '../store.ts';
import { Chip, Segmented, useToast } from './controls.tsx';
import { Search } from './icons.tsx';
import { VirtualList, type VirtualHandle } from './layout.tsx';
import { LicenceBadge, useRowHeight } from './Library.tsx';
import { usePrefs, setPrefs, type Prefs } from './prefs.ts';
import { cardsOf, fetchLibraries, filterSamples, parseFilter, rowNumbers, searchLibrary, SOURCE_GLYPH, SOURCE_WORD, useLibraryFile, type CardView } from './samplesApi.ts';
import { useNewSamples } from './sampleSeen.ts';

/** What a dragged sample row carries: the sample's name. A layer list takes it as `layer add … sample`. */
export const SAMPLE_MIME = 'application/x-soundclaw-sample';

const MINUS = '−';

/** A sample's peaks drawn small. */
export function PeakWave({ peaks, w = 56, h = 16 }: { peaks: { min: number[]; max: number[] } | undefined; w?: number; h?: number }) {
  if (!peaks) return <span className="mini-shim" style={{ width: w, height: Math.max(6, h - 4) }} aria-hidden />;
  const n = 28;
  const pk = peaks.max.length;
  let top = '', bot = '';
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i / n) * pk), b = Math.max(a + 1, Math.floor(((i + 1) / n) * pk));
    let mx = 0, mn = 0;
    for (let j = a; j < b; j++) { mx = Math.max(mx, peaks.max[j]!); mn = Math.min(mn, peaks.min[j]!); }
    const x = ((i + 0.5) / n) * w;
    top += `${i ? 'L' : 'M'}${x.toFixed(1)} ${(h / 2 - mx * h / 2).toFixed(1)}`;
    bot = `L${x.toFixed(1)} ${(h / 2 - mn * h / 2).toFixed(1)}${bot}`;
  }
  return <svg className="mini-wave" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden><path d={`${top}${bot}Z`} /></svg>;
}

/** Where the audio came from: a glyph and the word together. */
export function SourceMark({ source }: { source: string }) {
  return <span className="smp-source" title={`source: ${SOURCE_WORD[source] ?? source}`}><span className="mono" aria-hidden>{SOURCE_GLYPH[source] ?? '·'}</span>{SOURCE_WORD[source] ?? source}</span>;
}

/** A card for each sample in view; asked for while the row exists. */
function useCard(store: Store, hash: string): CardView | undefined {
  const c = cardsOf(store);
  useSyncExternalStore(c.subscribe, c.getVersion);
  useEffect(() => { c.want(hash); }, [c, hash]);
  return c.get(hash);
}

interface RowProps { store: Store; x: SampleInfo; sel: boolean; fresh: boolean; onSelect(): void; onOpen(): void; extra?: React.ReactNode }

function SampleRow({ store, x, sel, fresh, onSelect, onOpen, extra }: RowProps) {
  const card = useCard(store, x.sha256);
  const playing = store.playing === `sample:${x.name}`;
  return (
    <div className={`lib-row smp-row${sel ? ' sel' : ''}`} data-testid={`lib-row-${x.name}`} data-sample-row={x.name} data-licence={x.licenceState} data-new={fresh || undefined} draggable
      onDragStart={(e) => { e.dataTransfer.setData(SAMPLE_MIME, x.name); e.dataTransfer.setData('text/plain', x.name); e.dataTransfer.effectAllowed = 'copy'; }}
      onClick={onSelect} onDoubleClick={onOpen}>
      <span className={`new-dot${fresh ? ' agent' : ''}`} role={fresh ? 'img' : undefined} aria-label={fresh ? 'added by the agent' : undefined} data-testid={fresh ? `sample-new-${x.name}` : undefined} style={{ opacity: fresh ? 1 : 0 }} />
      <button type="button" className="lib-play" data-testid={`play-sample-${x.name}`} aria-label={`${playing ? 'Stop' : 'Play'} sample ${x.name}`} aria-pressed={playing}
        onClick={(e) => { e.stopPropagation(); onSelect(); void store.playSample(x.name); }}>{playing ? '■' : '▶'}</button>
      <div className="smp-main">
        <div className="smp-l1">
          <span className="lib-name" title={`${x.name}: ${SOURCE_WORD[x.source] ?? x.source}, licence ${x.licence}`}>{x.name}</span>
          <PeakWave peaks={card?.peaks} />
          <LicenceBadge state={x.licenceState} licence={x.licence} testId={`sample-licence-${x.name}`} />
        </div>
        <div className="smp-l2">
          <span className="mono lib-sub" data-testid={`sample-numbers-${x.name}`}>{numbersText(x, card)}</span>
          <SourceMark source={x.source} />
        </div>
        {extra}
      </div>
    </div>
  );
}

/** The numbers under a name: length, loudness and note; the rate and the channels only when they are not the usual 44.1 kHz mono (the sample's page has them all). */
export function numbersText(x: SampleInfo, card: CardView | undefined): string {
  const base = rowNumbers(x.seconds, card, x.root);
  const odd = [x.rate !== 44100 ? `${Number((x.rate / 1000).toFixed(1))} kHz` : '', x.channels === 2 ? 'stereo' : x.channels > 2 ? `${x.channels} ch` : ''].filter(Boolean);
  return odd.length ? `${base} \u00b7 ${odd.join(' \u00b7 ')}` : base;
}

const CHIPS: { id: string; label: string; fragment: string }[] = [
  { id: 'short', label: 'short', fragment: 'dur<1' },
  { id: 'hit', label: 'one hit', fragment: 'onsets=1' },
  { id: 'pitched', label: 'pitched', fragment: 'pitched=yes' },
  { id: 'loop', label: 'loops', fragment: 'loop=yes' },
  { id: 'unknown', label: 'unknown licence', fragment: 'licence=unknown' },
];

interface BrowserProps { store: Store; inputRef: React.RefObject<HTMLInputElement | null>; onOpen(name: string): void }

export function SamplesBrowser({ store, inputRef, onOpen }: BrowserProps) {
  const prefs = usePrefs();
  const mode = prefs.samplesMode;
  const fresh = useNewSamples(store);
  const taking = store.samples.filter((x) => x.source === 'generated' && !x.tags.includes('kept'));
  const counts = { project: store.samples.length, library: null as number | null, takes: taking.length };
  return (
    <div className="smp-browser" data-testid="samples-browser" data-mode={mode}>
      <div className="smp-mode">
        <Segmented<Prefs['samplesMode']> label="Samples" value={mode} onChange={(v) => setPrefs({ samplesMode: v })} testId="samples-mode"
          options={[
            { value: 'project', label: <>Project<span className="mono tab-n">{counts.project}</span></>, testId: 'samples-mode-project' },
            { value: 'library', label: 'Library', testId: 'samples-mode-library' },
            { value: 'takes', label: <>Takes<span className="mono tab-n" data-agent={taking.some((x) => fresh.has(x.name)) || undefined}>{counts.takes}</span></>, testId: 'samples-mode-takes' },
          ]} />
      </div>
      {mode === 'project' && <ProjectMode store={store} inputRef={inputRef} onOpen={onOpen} fresh={fresh} />}
      {mode === 'library' && <LibraryMode store={store} inputRef={inputRef} onOpen={onOpen} />}
      {mode === 'takes' && <TakesMode store={store} onOpen={onOpen} fresh={fresh} />}
    </div>
  );
}

function FilterField({ value, onChange, inputRef, placeholder, error }: { value: string; onChange(v: string): void; inputRef: React.RefObject<HTMLInputElement | null>; placeholder: string; error: string | null }) {
  return (
    <>
      <label className="lib-search"><Search size={12} /><span className="sr-only">Filter samples</span>
        <input ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} data-testid="lib-filter" spellCheck={false} autoComplete="off" aria-invalid={error ? true : undefined} aria-describedby={error ? 'smp-filter-error' : undefined}
          onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); (e.currentTarget.closest('.smp-browser')?.querySelector('.vlist, .smp-list') as HTMLElement | null)?.focus(); } else if (e.key === 'Escape') { if (value) { onChange(''); e.stopPropagation(); } else e.currentTarget.blur(); } }} />
        <kbd className="kbd">/</kbd>
      </label>
      {error && <p className="smp-error" id="smp-filter-error" role="alert" data-testid="samples-filter-error"><span className="mono" aria-hidden>!</span> {error}</p>}
    </>
  );
}

/** ↑↓ moves the selection through names (and previews it after a short pause), Home and End jump. */
function useListKeys(names: string[], sel: string | null, setSel: (n: string) => void, o: { onPlay(n: string): void; onEnter(n: string): void; preview: boolean }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const i = sel ? names.indexOf(sel) : -1;
    const go = (j: number) => {
      const n = names[Math.max(0, Math.min(names.length - 1, j))];
      if (!n) return;
      setSel(n);
      if (timer.current) clearTimeout(timer.current);
      if (o.preview) timer.current = setTimeout(() => o.onPlay(n), 140);
    };
    if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); go(i <= 0 ? 0 : i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(names.length - 1); }
    else if (e.key === ' ' && sel) { e.preventDefault(); if (timer.current) clearTimeout(timer.current); o.onPlay(sel); }
    else if (e.key === 'Enter' && sel) { e.preventDefault(); o.onEnter(sel); }
  };
}

// ---- project -------------------------------------------------------------------------------------------------------------

function ProjectMode({ store, inputRef, onOpen, fresh }: { store: Store; inputRef: React.RefObject<HTMLInputElement | null>; onOpen(n: string): void; fresh: Set<string> }) {
  const prefs = usePrefs();
  const rowH = useRowHeight();
  const [text, setText] = useState('');
  const [onlyNew, setOnlyNew] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const list = useRef<VirtualHandle>(null);
  const cards = cardsOf(store);
  useSyncExternalStore(cards.subscribe, cards.getVersion);
  const parsed = useMemo(() => parseFilter(text), [text]);
  const { rows: kept, pending } = filterSamples(store.samples, parsed.q, cards);
  const rows = onlyNew ? kept.filter((x) => fresh.has(x.name)) : kept;
  const total = store.samples.length;
  // a numbers query needs every sample's card: ask for them all, a few at a time
  useEffect(() => {
    if (parsed.q && parsed.q.terms.length) for (const x of store.samples) cards.want(x.sha256);
  }, [parsed.q, store.samples, cards]);
  const names = rows.map((x) => x.name);
  const at = sel ? names.indexOf(sel) : -1;
  useEffect(() => { if (at >= 0) list.current?.scrollToIndex(at); }, [at]);
  const onKeyDown = useListKeys(names, sel, setSel, { onPlay: (n) => void store.playSample(n), onEnter: onOpen, preview: prefs.previewOnSelect });
  const toggleChip = (fragment: string) => {
    const parts = text.split(/\s+/).filter(Boolean);
    setText(parts.includes(fragment) ? parts.filter((p) => p !== fragment).join(' ') : [...parts, fragment].join(' '));
  };
  const rowHeight = rowH + 18;
  return (
    <>
      <div className="lib-filter">
        <FilterField value={text} onChange={setText} inputRef={inputRef} placeholder="Filter samples: words and dur<1 lufs>-20" error={parsed.error} />
        <div className="chips" data-testid="samples-chips">
          {CHIPS.map((c) => <Chip key={c.id} on={text.split(/\s+/).includes(c.fragment)} onClick={() => toggleChip(c.fragment)} testId={`chip-sample-${c.id}`} title={c.fragment}>{c.label}</Chip>)}
          <Chip on={onlyNew} tone="agent" onClick={() => setOnlyNew(!onlyNew)} testId="chip-sample-new">new · {fresh.size}</Chip>
        </div>
      </div>
      <div className="lib-sort"><span>Sort: {parsed.q && (parsed.q.terms.length) ? 'closest' : 'name'}{pending > 0 ? ` · measuring ${pending}…` : ''}</span><span className="mono" data-testid="lib-count">{rows.length} / {total}</span></div>
      <div className="lib-list" onKeyDown={onKeyDown}>
        {total === 0 ? (
          <div className="lib-empty smp-empty" data-testid="samples-empty">
            <p>No samples yet.</p>
            <p className="dim">Drop audio files here, record with the microphone button in the top bar, or ask the agent: <code className="mono">soundclaw sample import</code>.</p>
          </div>
        ) : rows.length === 0 ? <p className="lib-empty dim">{pending > 0 ? 'Measuring the samples…' : 'Nothing matches.'}</p> : (
          <VirtualList ref={list} count={rows.length} rowHeight={rowHeight} label="samples" activeIndex={at} testId="lib-list"
            renderRow={(i) => { const x = rows[i]!; return <SampleRow store={store} x={x} sel={sel === x.name} fresh={fresh.has(x.name)} onSelect={() => setSel(x.name)} onOpen={() => onOpen(x.name)} />; }} />
        )}
      </div>
      <div className="lib-foot"><span>{'↑↓'} audition {'·'} Enter open</span><span className="mono">{prefs.density}</span></div>
    </>
  );
}

// ---- library -------------------------------------------------------------------------------------------------------------

const PAGE = 48;

function HitRow({ store, h, sel, onSelect, onUse, busy }: { store: Store; h: LibraryHitJson; sel: boolean; onSelect(): void; onUse(): void; busy: boolean }) {
  const playing = store.playing === `library:${h.ref}`;
  const colon = h.ref.indexOf(':');
  const path = h.ref.slice(colon + 1);
  const file = path.split('/').pop()!;
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const nums = h.error ? h.error : [h.dur != null ? `${h.dur < 10 ? h.dur.toFixed(2) : h.dur.toFixed(1)} s` : '', h.lufs != null ? `${String(h.lufs.toFixed(1)).replace('-', MINUS)} LUFS` : '', h.note ?? ''].filter(Boolean).join(' · ');
  return (
    <div className={`lib-row smp-row${sel ? ' sel' : ''}`} data-testid="library-hit" data-ref={h.ref} data-licence={h.state} onClick={onSelect} onDoubleClick={onUse}>
      <span className="new-dot" style={{ opacity: 0 }} />
      <button type="button" className="lib-play" data-testid={`play-hit-${h.ref}`} aria-label={`${playing ? 'Stop' : 'Audition'} ${file}`} aria-pressed={playing}
        onClick={(e) => { e.stopPropagation(); onSelect(); void store.playLibraryFile(h.ref); }}>{playing ? '■' : '▶'}</button>
      <div className="smp-main">
        <div className="smp-l1">
          <span className="lib-name" title={h.ref}>{file}</span>
          <LicenceBadge state={h.state} licence={h.licence} testId="hit-licence" />
          <button type="button" className="btn btn-quiet smp-use" data-testid={`use-hit-${h.ref}`} disabled={busy} onClick={(e) => { e.stopPropagation(); onUse(); }} title="Copy this file into the project (with its licence and where it came from)">Use</button>
        </div>
        <div className="smp-l2"><span className="mono lib-sub">{nums}</span>{folder && <span className="smp-folder" title={folder}>{folder}</span>}</div>
      </div>
    </div>
  );
}

function LibraryMode({ store, inputRef, onOpen }: { store: Store; inputRef: React.RefObject<HTMLInputElement | null>; onOpen(n: string): void }) {
  const toast = useToast();
  const prefs = usePrefs();
  const rowH = useRowHeight();
  const [libs, setLibs] = useState<LibraryListing[] | null>(null);
  const [library, setLibrary] = useState('');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [reply, setReply] = useState<{ total: number; hits: LibraryHitJson[]; notIndexed: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = useRef<VirtualHandle>(null);
  const parsed = useMemo(() => parseFilter(text), [text]);
  useEffect(() => { void fetchLibraries(store).then(setLibs).catch((e: Error) => setError(e.message)); }, [store]);
  // the query runs after a short pause; a failing query keeps the last page and says why
  useEffect(() => {
    if (!libs?.length || parsed.error) return;
    const t = setTimeout(() => setQ(text), 220);
    return () => clearTimeout(t);
  }, [text, libs, parsed.error]);
  useEffect(() => { setOffset(0); }, [q, library]);
  useEffect(() => {
    if (!libs?.length) return;
    let live = true;
    searchLibrary(store, q, { ...(library ? { library } : {}), offset, limit: PAGE })
      .then((r) => { if (live) { setReply(r); setError(null); } })
      .catch((e: Error) => { if (live) { setError(e.message); setReply(null); } });
    return () => { live = false; };
  }, [store, libs, q, library, offset]);
  const hits = reply?.hits ?? [];
  const names = hits.map((h) => h.ref);
  const at = sel ? names.indexOf(sel) : -1;
  useEffect(() => { if (at >= 0) list.current?.scrollToIndex(at); }, [at]);
  const use = useCallback(async (ref: string) => {
    setBusy(true);
    const r = await useLibraryFile(store, ref);
    setBusy(false);
    if (r.ok) { toast(`Copied ${ref.slice(ref.indexOf(':') + 1).split('/').pop()} into the project as ${r.name}`); onOpen(r.name); } else toast(r.error, 'error');
  }, [store, toast, onOpen]);
  const onKeyDown = useListKeys(names, sel, setSel, { onPlay: (r) => void store.playLibraryFile(r), onEnter: (r) => void use(r), preview: prefs.previewOnSelect });
  const total = reply?.total ?? 0;
  if (libs && libs.length === 0) {
    return (
      <div className="lib-list"><div className="lib-empty smp-empty" data-testid="library-empty">
        <p>No sample libraries yet.</p>
        <p className="dim">A library is a folder of recordings outside the project. Register one: <code className="mono">soundclaw library add &lt;folder&gt;</code>, then <code className="mono">soundclaw library index &lt;id&gt;</code>.</p>
      </div></div>
    );
  }
  return (
    <>
      <div className="lib-filter">
        <FilterField value={text} onChange={setText} inputRef={inputRef} placeholder={'Search: door creak dur=1-3 lufs>-30'} error={parsed.error} />
        {libs && libs.length > 1 && (
          <label className="smp-libpick"><span className="sr-only">Library</span>
            <select value={library} onChange={(e) => setLibrary(e.target.value)} data-testid="library-pick"><option value="">all libraries</option>{libs.map((l) => <option key={l.id} value={l.id}>{l.name}{l.files !== null ? ` (${l.files})` : ' (not indexed)'}</option>)}</select>
          </label>
        )}
      </div>
      <div className="lib-sort"><span data-testid="library-range">{total ? `${offset + 1}–${Math.min(total, offset + hits.length)} of ${total}` : 'no files'}</span>
        <span className="smp-pager">
          <button type="button" className="link-btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} data-testid="library-prev">Previous</button>
          <button type="button" className="link-btn" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)} data-testid="library-next">Next</button>
        </span>
      </div>
      {reply && reply.notIndexed.length > 0 && <p className="smp-error warn" role="status"><span className="mono" aria-hidden>!</span> not indexed, so not searched: {reply.notIndexed.join(', ')}</p>}
      {error && <p className="smp-error" role="alert" data-testid="library-error"><span className="mono" aria-hidden>!</span> {error}</p>}
      <div className="lib-list" onKeyDown={onKeyDown}>
        {!libs ? <p className="lib-empty dim">Loading the libraries{'…'}</p> : hits.length === 0 ? <p className="lib-empty dim">{error ? '' : 'Nothing matches.'}</p> : (
          <VirtualList ref={list} count={hits.length} rowHeight={rowH + 18} label="library files" activeIndex={at} testId="library-list"
            renderRow={(i) => { const h = hits[i]!; return <HitRow store={store} h={h} sel={sel === h.ref} onSelect={() => setSel(h.ref)} onUse={() => void use(h.ref)} busy={busy} />; }} />
        )}
      </div>
      <div className="lib-foot"><span>{'↑↓'} audition {'·'} Enter uses the file</span><span className="mono">{PAGE} a page</span></div>
    </>
  );
}

// ---- takes ----------------------------------------------------------------------------------------------------------------

const KEEP_LICENCES = ['own', 'CC0-1.0', 'CC-BY-4.0', 'unknown'];

function KeepForm({ store, x, onDone }: { store: Store; x: SampleInfo; onDone(): void }) {
  const toast = useToast();
  const [name, setName] = useState(x.name.replace(/_t\d+$/, ''));
  const [licence, setLicence] = useState(x.licence);
  const [ok, setOk] = useState(false);
  const options = KEEP_LICENCES.includes(x.licence) ? KEEP_LICENCES : [x.licence, ...KEEP_LICENCES];
  const valid = /^[a-z0-9][a-z0-9_-]{0,47}$/.test(name) && (name === x.name || !store.samples.some((s) => s.name === name));
  const keep = async () => {
    const tags = [...new Set([...x.tags, 'kept'])].join(',');
    const cmds = [...(name !== x.name ? [`sample rename ${x.name} ${name}`] : []), `sample set ${name} licence=${licence} tags=${tags}`];
    const r = await store.run(cmds.join('\n'));
    if (r.ok) { toast(`Kept ${name}`); onDone(); } else toast(r.errors.map((e) => e.message).join('; '), 'error');
  };
  return (
    <form className="smp-keep" data-testid={`keep-form-${x.name}`} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (valid && ok) void keep(); }}>
      <label>name<input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} data-testid="keep-name" aria-invalid={!valid} spellCheck={false} /></label>
      <label>licence<select value={licence} onChange={(e) => setLicence(e.target.value)} data-testid="keep-licence">{options.map((l) => <option key={l} value={l}>{l}</option>)}</select></label>
      <label className="smp-confirm"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} data-testid="keep-confirm" />I confirm this licence for {name || 'this take'}</label>
      <div className="smp-keep-actions"><button type="submit" className="btn btn-primary" disabled={!valid || !ok} data-testid="keep-go">Keep</button><button type="button" className="btn btn-quiet" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

function TakesMode({ store, onOpen, fresh }: { store: Store; onOpen(n: string): void; fresh: Set<string> }) {
  const toast = useToast();
  const [sel, setSel] = useState<string | null>(null);
  const [keeping, setKeeping] = useState<string | null>(null);
  const takes = useMemo(() => store.samples.filter((x) => x.source === 'generated' && !x.tags.includes('kept')).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || (a.name < b.name ? -1 : 1)), [store.samples]);
  const names = takes.map((x) => x.name);
  const discard = async (x: SampleInfo) => {
    const r = await store.run(`sample remove ${x.name}`);
    if (r.ok) toast(`Discarded ${x.name}; the audio stays in the store until sample gc`); else toast(r.errors.map((e) => e.message).join('; '), 'error');
  };
  const onKeyDown = useListKeys(names, sel, setSel, { onPlay: (n) => void store.playSample(n), onEnter: onOpen, preview: false });
  return (
    <>
      <div className="lib-sort"><span>Newest first</span><span className="mono" data-testid="lib-count">{takes.length} take{takes.length === 1 ? '' : 's'}</span></div>
      <div className="lib-list smp-list" onKeyDown={onKeyDown} tabIndex={0} data-testid="takes-list">
        {takes.length === 0 ? (
          <div className="lib-empty smp-empty" data-testid="takes-empty"><p>No takes waiting.</p><p className="dim">Audio the agent generates arrives here to keep or discard: <code className="mono">soundclaw generate &lt;project&gt; sfx &quot;…&quot;</code>.</p></div>
        ) : takes.map((x) => (
          <div key={x.name} className="take" data-testid={`take-${x.name}`} data-new={fresh.has(x.name) || undefined}>
            <SampleRow store={store} x={x} sel={sel === x.name} fresh={fresh.has(x.name)} onSelect={() => setSel(x.name)} onOpen={() => onOpen(x.name)}
              extra={<>
                {x.prompt && <p className="smp-prompt" title={x.prompt}>{'“'}{x.prompt}{'”'}</p>}
                <p className="mono smp-takemeta">{[x.take ? `take ${x.take}` : '', x.credits !== undefined ? `${x.credits} credits` : '', x.author ?? ''].filter(Boolean).join(' · ')}</p>
              </>} />
            <div className="take-actions">
              <button type="button" className="btn btn-secondary" data-testid={`keep-${x.name}`} onClick={() => setKeeping(keeping === x.name ? null : x.name)} aria-expanded={keeping === x.name}>Keep{'…'}</button>
              <button type="button" className="btn btn-quiet" data-testid={`discard-${x.name}`} onClick={() => void discard(x)}>Discard</button>
            </div>
            {keeping === x.name && <KeepForm store={store} x={x} onDone={() => setKeeping(null)} />}
          </div>
        ))}
      </div>
      <div className="lib-foot"><span>Keep names a take and confirms its licence</span></div>
    </>
  );
}

