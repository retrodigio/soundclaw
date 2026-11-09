// The app shell: transport on top, the library on the left, tabs over the page, the agent rail on
// the right and the bottom panel under the page. Panels resize and collapse (sizes are kept per
// browser), the palette and the shortcut sheet are dialogs, and narrow windows degrade: below
// 1180 px the rail is an icon strip, below 900 px the library is an overlay.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Store } from '../store.ts';
import { BottomPanel } from './Bottom.tsx';
import { AskHost, askHere, itemSpec, openAsk } from './ask.tsx';
import { ToastHost, useToast } from './controls.tsx';
import { Chevron, Close, KindIcon, Spark, type TabKind } from './icons.tsx';
import { Library } from './Library.tsx';
import { UndoBar } from './decisions.tsx';
import { BatchStrip, UpdateChip } from './live.tsx';
import { OfflineBanner, RefusedBanner } from './offline.tsx';
import { PartBoundary, Resizer } from './layout.tsx';
import { SelectionCtx } from './NeedCard.tsx';
import { Page } from './pages.tsx';
import { Palette, ShortcutSheet } from './Palette.tsx';
import { LIMITS, loadTabs, saveTabs, setPanels, toggleDensity, toggleTheme, setPrefs, usePrefs, effectiveTheme } from './prefs.ts';
import { Rail, presenceOf } from './Rail.tsx';
import { dispatchKey, keyOf, setModalProbe, useActions, type Action } from './registry.ts';
import { focusOf, hashOf, type Focus } from './shellData.ts';
import { Transport } from './Transport.tsx';

function useWidth(): number {
  return useSyncExternalStore((f) => { window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, () => window.innerWidth);
}

interface TabInfo { hash: string; label: string; kind: TabKind; id: string | null; pinned?: boolean }

/** What a tab's hash is: its label and icon. */
function tabOf(hash: string): TabInfo | null {
  let m = /^#\/(sound|set|song)\/([A-Za-z][A-Za-z0-9_-]*)/.exec(hash);
  if (m) return { hash: `#/${m[1]}/${m[2]}`, label: m[2]!, kind: m[1] as TabKind, id: m[2]! };
  m = /^#\/audition(?:\/([A-Za-z][A-Za-z0-9_-]*))?$/.exec(hash);
  if (m) return { hash, label: m[1] ? `audition · ${m[1]}` : 'Audition', kind: 'audition', id: null };
  if (hash === '#/session') return { hash, label: 'Session', kind: 'session', id: null };
  m = /^#\/review\/([A-Za-z][A-Za-z0-9_-]*)$/.exec(hash);
  if (m) return { hash, label: `Review ${m[1]}`, kind: 'review', id: null };
  return null;
}

function TabBar({ store, tabs, current, onClose }: { store: Store; tabs: TabInfo[]; current: string; onClose(hash: string): void }) {
  return (
    <div className="tabbar" role="tablist" aria-label="Open items" data-testid="tabbar">
      <a role="tab" className="tab-item pinned" href="#/" aria-selected={current === '#/' || current === ''} data-testid="tab-home"><KindIcon kind="list" />Needs attention</a>
      {tabs.map((t) => {
        const on = current.startsWith(t.hash);
        const dot = t.kind === 'sound' && t.id && store.agentNew.has(t.id);
        return (
          <span key={t.hash} className="tab-wrap" data-active={on || undefined}>
            <a role="tab" className="tab-item" href={t.hash} aria-selected={on} data-testid={`tab-${t.hash.slice(2).replace(/\//g, '-')}`}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(t.hash); } }} onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}>
              <KindIcon kind={t.kind} />{t.label}{dot && <span className="tab-dot" role="img" aria-label="changed by the agent" />}
            </a>
            <button type="button" className="tab-x" aria-label={`Close ${t.label}`} data-testid={`tab-close-${t.hash.slice(2).replace(/\//g, '-')}`} onClick={() => onClose(t.hash)}><Close size={9} /></button>
          </span>
        );
      })}
    </div>
  );
}

const noop = (): void => undefined;
/** Keys that belong to one page, for the shortcut sheet: listed, never bound here, not in the palette. */
const REFERENCE_KEYS: Action[] = [
  { id: 'ref.mutate', label: 'Mutate the sound (classic editor)', group: 'Edit', shortcut: 'M' },
  { id: 'ref.lens', label: 'Switch the lens: waveform, spectrogram, pitch, compare, numbers (sound pages)', group: 'Analysis', shortcut: '1–5' },
  { id: 'ref.layers', label: 'Lens: sum by layer (layered editor)', group: 'Analysis', shortcut: '6' },
  { id: 'ref.addLayer', label: 'Add a layer (layered editor)', group: 'Edit', shortcut: '⇧ L' },
  { id: 'ref.gridRow', label: 'Play a row of the clip grid, back to back', group: 'Audition', shortcut: '1–9' },
  { id: 'ref.gridCol', label: 'Play a column of the clip grid', group: 'Audition', shortcut: '⇧ 1–9' },
  { id: 'ref.compare', label: 'Compare the two selected cells on the A/B card', group: 'Audition', shortcut: 'C' },
  { id: 'ref.abA', label: 'Blind A/B: A fits better', group: 'Audition', shortcut: 'A' },
  { id: 'ref.abB', label: 'Blind A/B: B fits better', group: 'Audition', shortcut: 'B' },
  { id: 'ref.abBoth', label: 'Blind A/B: both would do', group: 'Audition', shortcut: '=' },
  { id: 'ref.abNeither', label: 'Blind A/B: neither would do', group: 'Audition', shortcut: 'N' },
  { id: 'ref.abTab', label: 'Switch A and B while playing (A/B card, review)', group: 'Audition', shortcut: 'Tab' },
  { id: 'ref.abNext', label: 'The next pair (A/B card)', group: 'Audition', shortcut: '→' },
].map((a) => ({ ...a, local: true, noPalette: true, run: noop }));

function ShellInner({ store }: { store: Store }) {
  useSyncExternalStore(store.subscribe, store.getVersion);
  const toast = useToast();
  const prefs = usePrefs();
  const p = prefs.panels;
  const width = useWidth();
  const narrowLib = width < 900;
  const narrowRail = width < 1180;
  const route = store.route;
  const hash = typeof location !== 'undefined' ? location.hash || '#/' : '#/';

  const [selected, setSelected] = useState<Focus | null>(null);
  const [overlay, setOverlay] = useState<'palette' | 'shortcuts' | null>(null);
  const [libOverlay, setLibOverlay] = useState(false);
  const [railOverlay, setRailOverlay] = useState(false);
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;
  useEffect(() => { setModalProbe(() => overlayRef.current !== null); }, []);
  // the queue went out after a reconnect: say so (refusals have their own banner)
  useEffect(() => {
    if (!store.flushes) return;
    const ok = store.sentAfterReconnect - store.refused.length;
    if (ok > 0) toast(`Sent ${ok} queued edit${ok === 1 ? '' : 's'} to the server, in order.`);
  }, [store.flushes]); // eslint-disable-line react-hooks/exhaustive-deps
  const filterRef = useRef<HTMLInputElement>(null);

  /* tabs: opening an item opens or focuses its tab; the list is saved per browser and project */
  const project = store.project?.name ?? null;
  const [tabHashes, setTabHashes] = useState<string[]>([]);
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (!project || loaded.current === project) return;
    loaded.current = project;
    // the saved tabs, and the one the address opened (a link to an item opens its tab even in a fresh browser)
    const here = tabOf(location.hash || '#/');
    const saved = loadTabs(project);
    setTabHashes(here && !saved.includes(here.hash) ? [...saved, here.hash] : saved);
  }, [project]);
  useEffect(() => {
    const t = tabOf(hash);
    if (t) setTabHashes((xs) => (xs.includes(t.hash) ? xs : [...xs, t.hash]));
  }, [hash]);
  useEffect(() => { if (project && loaded.current === project) saveTabs(project, tabHashes); }, [tabHashes, project]);
  const tabs = useMemo(() => tabHashes.map(tabOf).filter((t): t is TabInfo => !!t), [tabHashes]);
  const closeTab = useCallback((h: string) => {
    setTabHashes((xs) => {
      const i = xs.indexOf(h);
      const next = xs.filter((x) => x !== h);
      if (hash.startsWith(h)) location.hash = next[Math.min(i, next.length - 1)] ?? '#/';
      return next;
    });
  }, [hash]);

  /* focus: the open tab's item, else the library's selection */
  const tabFocus = focusOf(route, null);
  const focus: Focus | null = tabFocus ?? selected;
  const panelFocus: Focus | null = selected ?? tabFocus;
  useEffect(() => { if (tabFocus) setSelected(tabFocus); }, [tabFocus?.kind, tabFocus?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = useCallback((f: Focus) => { location.hash = hashOf(f); if (narrowLib) setLibOverlay(false); }, [narrowLib]);
  const openSound = useCallback((id: string) => { location.hash = `#/sound/${id}`; }, []);

  const ask = useCallback(async (text: string, target: Focus | null = focus): Promise<boolean> => {
    if (!target || target.kind === 'set') { toast('Open or select a sound first, then ask.', 'warn'); return false; }
    const r = await store.askForChanges(target.id, text);
    if (r.ok) toast(`Sent to the agent: “${text}” on ${target.id}`);
    else toast(r.error ?? 'The request was refused.', 'error');
    return r.ok;
  }, [focus, store, toast]);

  const showRail = useCallback(() => { if (narrowRail) setRailOverlay(true); else setPanels({ railOpen: true }); }, [narrowRail]);
  const focusAsk = useCallback(() => { showRail(); setTimeout(() => document.getElementById('rail-ask')?.focus(), 30); }, [showRail]);

  /* transport actions */
  const playingNow = store.playing !== null;
  const playFocus = useCallback((loop: boolean) => {
    const f = focus;
    if (!f) return;
    if (f.kind === 'sound') void (loop ? store.playLoop(f.id) : store.play(f.id));
    else if (f.kind === 'song') void store.playSong(f.id, loop ? 'loop' : 'full');
    else {
      const set = store.sets.find((x) => x.id === f.id);
      if (set) void store.playSequence(set.members.map((m) => (typeof m === 'string' ? m : (m as { id: string }).id)), 400);
    }
  }, [focus, store]);
  const stop = useCallback(() => { store.stopSequence(); store.stop(); }, [store]);
  const togglePlay = useCallback(() => { if (store.playing !== null) stop(); else playFocus(false); }, [playFocus, stop, store]);
  const looping = !!store.playing && (store.playing.endsWith('#loop') || store.songPlay?.mode === 'loop');

  const toggleLibrary = useCallback(() => { if (narrowLib) { setLibOverlay((v) => !v); setTimeout(() => filterRef.current?.focus(), 30); } else setPanels({ libOpen: !p.libOpen }); }, [narrowLib, p.libOpen]);
  const toggleRail = useCallback(() => { if (narrowRail) setRailOverlay((v) => !v); else setPanels({ railOpen: !p.railOpen }); }, [narrowRail, p.railOpen]);

  const actions: Action[] = [
    { id: 'transport.play', label: 'Play / stop the focused item', group: 'Transport', shortcut: 'Space', key: 'space', run: togglePlay, keywords: 'start pause' },
    { id: 'transport.loop', label: 'Play the focused item looping', group: 'Transport', shortcut: 'L', key: 'l', run: () => playFocus(true), enabled: () => !!focus && focus.kind !== 'set' },
    { id: 'transport.stop', label: 'Stop playback', group: 'Transport', run: stop },
    { id: 'edit.undo', label: 'Undo', group: 'Edit', shortcut: '⌘ Z', key: 'mod+z', run: () => { void store.undo(); }, enabled: () => store.canUndo() },
    { id: 'edit.redo', label: 'Redo', group: 'Edit', shortcut: '⇧ ⌘ Z', key: 'mod+shift+z', run: () => { void store.redo(); }, enabled: () => store.canRedo() },
    { id: 'edit.ask', label: 'Ask for changes on the selection', group: 'Edit', shortcut: 'R', key: 'r', run: () => { if (!askHere(focus)) focusAsk(); }, keywords: 'request agent feedback' },
    { id: 'edit.approve', label: 'Approve the focused item', group: 'Edit', shortcut: '⌘ ↵', key: 'mod+enter', inText: false, run: () => { if (focus?.kind === 'sound') void store.approve(focus.id); else if (focus?.kind === 'song') void store.run(`song mark ${focus.id} approved`); }, enabled: () => focus?.kind === 'sound' || focus?.kind === 'song' },
    { id: 'nav.palette', label: 'Open the command palette', group: 'Navigate', shortcut: '⌘ K', key: 'mod+k', inText: true, noPalette: true, run: () => setOverlay((o) => (o === 'palette' ? null : 'palette')) },
    { id: 'nav.filter', label: 'Filter the library', group: 'Navigate', shortcut: '/', key: '/', run: () => { if (narrowLib) setLibOverlay(true); else setPanels({ libOpen: true }); setTimeout(() => filterRef.current?.focus(), 30); }, keywords: 'search find' },
    { id: 'nav.browse', label: 'Browse the library (preview on select)', group: 'Navigate', shortcut: '↑ ↓', local: true, noPalette: true, run: () => document.querySelector<HTMLElement>('.lib-list .vlist')?.focus() },
    { id: 'nav.openSelected', label: 'Open the selected item in a tab', group: 'Navigate', shortcut: '↵', local: true, run: () => { if (selected) open(selected); }, enabled: () => !!selected },
    { id: 'nav.close', label: 'Close the palette or a dialog', group: 'Navigate', shortcut: 'Esc', local: true, noPalette: true, run: () => setOverlay(null) },
    { id: 'nav.home', label: 'Go to Needs attention', group: 'Navigate', run: () => { location.hash = '#/'; }, keywords: 'home sounds list cards rows' },
    { id: 'nav.audition', label: 'Open the audition page', group: 'Navigate', run: () => { location.hash = '#/audition'; }, keywords: 'listen compare play all' },
    { id: 'nav.analysis', label: 'Open the analysis lenses for the focused sound', group: 'Navigate', run: () => { if (focus?.kind === 'sound') location.hash = `#/sound/${focus.id}/analysis`; }, enabled: () => focus?.kind === 'sound', keywords: 'waveform spectrogram pitch compare numbers lens' },
    { id: 'nav.session', label: 'Open the agent session', group: 'Navigate', run: () => { location.hash = '#/session'; }, keywords: 'requests live feed' },
    { id: 'nav.closeTab', label: 'Close the current tab', group: 'Navigate', run: () => closeTab(tabOf(hash)?.hash ?? ''), enabled: () => !!tabOf(hash) },
    { id: 'nav.library.sounds', label: 'Library: show sounds', group: 'Library', run: () => setPrefs({ libTab: 'sounds' }) },
    { id: 'nav.library.sets', label: 'Library: show sets', group: 'Library', run: () => setPrefs({ libTab: 'sets' }) },
    { id: 'nav.library.songs', label: 'Library: show songs', group: 'Library', run: () => setPrefs({ libTab: 'songs' }) },
    { id: 'nav.library.instruments', label: 'Library: show instruments', group: 'Library', run: () => setPrefs({ libTab: 'instruments' }) },
    { id: 'nav.library.samples', label: 'Library: show samples', group: 'Library', run: () => setPrefs({ libTab: 'samples' }) },
    { id: 'panel.library', label: 'Toggle the library', group: 'Panels', shortcut: '⌥ 1', key: 'alt+1', run: toggleLibrary },
    { id: 'panel.inspector', label: 'Toggle the inspector', group: 'Panels', shortcut: '⌥ 2', key: 'alt+2', run: () => toast('This page has no inspector.') },
    { id: 'panel.rail', label: 'Toggle the agent rail', group: 'Panels', shortcut: '⌥ 3', key: 'alt+3', run: toggleRail },
    { id: 'panel.bottom', label: 'Toggle the bottom panel', group: 'Panels', shortcut: '⌥ 4', key: 'alt+4', run: () => setPanels({ bottomOpen: !p.bottomOpen }) },
    { id: 'bottom.detail', label: 'Bottom panel: Detail', group: 'Panels', run: () => setPanels({ bottomOpen: true, bottomTab: 'detail' }) },
    { id: 'bottom.mixer', label: 'Bottom panel: Mixer', group: 'Panels', run: () => setPanels({ bottomOpen: true, bottomTab: 'mixer' }) },
    { id: 'bottom.history', label: 'Bottom panel: History', group: 'Panels', run: () => setPanels({ bottomOpen: true, bottomTab: 'history' }), keywords: 'tape commands log' },
    { id: 'view.theme', label: `Theme: switch to ${effectiveTheme() === 'dark' ? 'light' : 'dark'}`, group: 'View', run: toggleTheme, keywords: 'dark light colour' },
    { id: 'view.density', label: `Density: switch to ${prefs.density === 'compact' ? 'comfortable' : 'compact'}`, group: 'View', shortcut: '⌘ .', key: 'mod+.', run: toggleDensity, keywords: 'compact comfortable rows' },
    { id: 'view.preview', label: `Preview on select: turn ${prefs.previewOnSelect ? 'off' : 'on'}`, group: 'View', run: () => setPrefs({ previewOnSelect: !prefs.previewOnSelect }), keywords: 'audition browse' },
    { id: 'view.cards', label: 'Needs attention: show cards', group: 'View', run: () => setPrefs({ homeView: 'cards' }) },
    { id: 'view.rows', label: 'Needs attention: show rows', group: 'View', run: () => setPrefs({ homeView: 'rows' }) },
    { id: 'help.shortcuts', label: 'Show the keyboard shortcuts', group: 'Help', shortcut: '?', key: '?', run: () => setOverlay('shortcuts') },
    // the keys a page handles itself, listed in the sheet from anywhere (a page's own entry replaces its line while it is open)
    ...REFERENCE_KEYS,
  ];
  useActions(actions);

  // the one keyboard handler: it runs the action bound to a key, and never while a text field has focus (except Esc and ⌘K)
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      // the audition page has its own Space, A and R (it plays, approves and asks on its selected card)
      if (store.route.kind === 'audition' && ['space', 'a', 'r'].includes(keyOf(e))) return;
      dispatchKey(e);
    };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [store]);

  // Esc closes an overlaid panel
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape' && !overlayRef.current) { setLibOverlay(false); setRailOverlay(false); } };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, []);

  const libVisible = narrowLib ? libOverlay : p.libOpen;
  const railStrip = narrowRail;
  const railVisible = narrowRail ? railOverlay : p.railOpen;
  const pr = presenceOf(store);
  const openRequests = store.requests.filter((q) => ['open', 'claimed', 'blocked'].includes(q.state)).length;

  const style = { '--lib-w': `${p.libW}px`, '--rail-w': `${p.railW}px`, '--bottom-h': `${p.bottomH}px` } as React.CSSProperties;
  return (
    <div className="studio" style={style} data-narrow-lib={narrowLib || undefined} data-narrow-rail={narrowRail || undefined} data-testid="studio">
      <Transport store={store} focus={focus} onPalette={() => setOverlay('palette')} canLoop={!!focus && focus.kind !== 'set'} onPlay={() => playFocus(false)} onStop={stop} onLoop={() => (looping ? stop() : playFocus(true))} playingNow={playingNow} looping={looping} />
      <div className="studio-body">
        {libVisible && !narrowLib && (
          <aside className="library" aria-label="Library" data-testid="library-panel">
            <Library store={store} selected={selected} onSelect={setSelected} onOpen={open} onAsk={(f) => { setSelected(f); if (f.kind !== 'set') openAsk(itemSpec(f.id)); else focusAsk(); }} inputRef={filterRef} />
            <Resizer side="left" size={p.libW} min={LIMITS.libW[0]} max={LIMITS.libW[1]} onSize={(v) => setPanels({ libW: v })} onToggle={() => setPanels({ libOpen: false })} label="Resize the library" testId="resize-library" />
          </aside>
        )}
        <div className="center">
          <TabBar store={store} tabs={tabs} current={hash} onClose={closeTab} />
          <OfflineBanner store={store} />
          <RefusedBanner store={store} />
          <div className="page" role="main" id="page" data-testid="page">
            {store.error && <div className="error banner" data-testid="error" role="alert">{store.error} <button className="link" onClick={() => { store.error = null; store.changed(); }}>dismiss</button></div>}
            <div className="live-layer">
              {route.kind !== 'session' && <BatchStrip store={store} scope={route.kind === 'sound' || route.kind === 'song' ? route.id : null} />}
              {(route.kind === 'sound' || route.kind === 'song') && <UpdateChip store={store} id={route.id} />}
            </div>
            <SelectionCtx.Provider value={{ selected, select: setSelected, ask: (f) => { setSelected(f); focusAsk(); } }}>
              <PartBoundary reset={hash} name="page"><Page store={store} onPlay={(id) => void store.play(id)} onOpen={openSound} /></PartBoundary>
            </SelectionCtx.Provider>
          </div>
          {p.bottomOpen && (
            <section className="bottom" aria-label="Bottom panel" data-testid="bottom">
              <Resizer side="top" size={p.bottomH} min={LIMITS.bottomH[0]} max={LIMITS.bottomH[1]} onSize={(v) => setPanels({ bottomH: v })} onToggle={() => setPanels({ bottomOpen: false })} label="Resize the bottom panel" testId="resize-bottom" />
              <PartBoundary name="bottom panel"><BottomPanel store={store} focus={panelFocus} /></PartBoundary>
            </section>
          )}
        </div>
        {railVisible && !narrowRail && (
          <aside className="rail" aria-label="Agent" data-testid="rail-panel">
            <Resizer side="right" size={p.railW} min={LIMITS.railW[0]} max={LIMITS.railW[1]} onSize={(v) => setPanels({ railW: v })} onToggle={() => setPanels({ railOpen: false })} label="Resize the agent rail" testId="resize-rail" />
            <Rail store={store} onPlay={(id) => void store.play(id)} onOpen={openSound} ask={(t) => ask(t)} focus={focus} />
          </aside>
        )}
        {railStrip && (
          <aside className="rail-strip" aria-label="Agent" data-testid="rail-strip">
            <button type="button" className="strip-btn" aria-label={`Agent: ${pr.text}${openRequests ? `, ${openRequests} open requests` : ''}`} aria-expanded={railOverlay} onClick={toggleRail} data-testid="rail-strip-btn">
              <Spark size={16} /><span className={`presence-dot s-${pr.state}`} aria-hidden />{openRequests > 0 && <span className="mono strip-n">{openRequests}</span>}
            </button>
          </aside>
        )}
      </div>
      {narrowLib && libOverlay && (
        <div className="scrim" onMouseDown={() => setLibOverlay(false)} data-testid="library-scrim">
          <aside className="library overlay-panel" aria-label="Library" data-testid="library-panel" onMouseDown={(e) => e.stopPropagation()}>
            <Library store={store} selected={selected} onSelect={setSelected} onOpen={open} onAsk={(f) => { setSelected(f); setLibOverlay(false); if (f.kind !== 'set') openAsk(itemSpec(f.id)); else focusAsk(); }} inputRef={filterRef} />
          </aside>
        </div>
      )}
      {narrowRail && railOverlay && (
        <div className="scrim right" onMouseDown={() => setRailOverlay(false)}>
          <aside className="rail overlay-panel" aria-label="Agent" data-testid="rail-panel" onMouseDown={(e) => e.stopPropagation()}>
            <button type="button" className="overlay-close" aria-label="Close the agent rail" onClick={() => setRailOverlay(false)}><Chevron dir="right" /></button>
            <Rail store={store} onPlay={(id) => void store.play(id)} onOpen={openSound} ask={(t) => ask(t)} focus={focus} />
          </aside>
        </div>
      )}
      <AskHost store={store} focus={focus} />
      <UndoBar />
      {overlay === 'palette' && <Palette store={store} focus={focus} onClose={() => setOverlay(null)} ask={(t, f) => ask(t, f)} />}
      {overlay === 'shortcuts' && <ShortcutSheet onClose={() => setOverlay(null)} />}
    </div>
  );
}

export function Shell({ store }: { store: Store }) {
  return <ToastHost><ShellInner store={store} /></ToastHost>;
}
