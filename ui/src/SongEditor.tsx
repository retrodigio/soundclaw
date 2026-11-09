// The music editor: a song's page (#/song/<id>) and its mixer (#/song/<id>/mixer). The arrangement
// (tracks by layer, clips, the loop region, flags), the piano roll beside the pattern text with the
// pattern grid as a tab, and an inspector with the instruments, helpers, song order and changes. Every
// edit is a command, the very text an agent would write, sent as this person: a gesture is one batch
// on the history, undone as one.

import { askLabel, useAskSource } from './studio/ask.tsx';
import { useMemo, useRef, useState } from 'react';
import { arrange, layerOrder, rollNotes, stepTime, type Arrangement as Arr, type Pattern, type SongDoc } from '@soundclaw/core';
import { PianoRoll } from './PianoRoll.tsx';
import { HelperPanel, InstrumentPanel } from './SongPanels.tsx';
import type { Store } from './store.ts';
import { Arrangement, type BarSel } from './song/Arrangement.tsx';
import { LiveText, Mixer, MeterModeToggle } from './song/Mixer.tsx';
import { PatternText } from './song/PatternText.tsx';
import { Field, PatternGrid, SongOrderPanel } from './song/parts.tsx';
import { useSongClock, useSongReport } from './song/hooks.tsx';
import { barSeconds, channelColour, laneFlags, patternAuthors, type Clip, type LaneFlag } from './song/model.ts';
import { AuthorDot, authorOf, Button, Segmented, Tabs } from './studio/controls.tsx';
import { useActions, type Action } from './studio/registry.ts';
import { ago } from './studio/shellData.ts';

const TIMES = ['4/4', '3/4', '2/4', '6/8', '5/4', '7/8', '12/8'];
const KEY = 'soundclaw.songInspector';
type InspTab = 'instruments' | 'helpers' | 'order' | 'changes';

/** The first place a pattern plays in the arrangement (where the grid's steps are timed from). */
const firstInstance = (arr: Arr | null, pattern: string) => arr?.instances.find((i) => i.pattern.name === pattern);

function useSongInspector(): [boolean, (v?: boolean) => void] {
  const [open, setOpen] = useState<boolean>(() => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } });
  const toggle = (v?: boolean): void => setOpen((o) => { const n = v ?? !o; try { localStorage.setItem(KEY, n ? '1' : '0'); } catch { /* storage off */ } return n; });
  return [open, toggle];
}

const mentions = (cmd: string, id: string): boolean => new RegExp(`(^|[\\s.])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s.]|$)`).test(cmd);

/** The inspector's changes: what the agent wrote that nobody has approved, and the song's recent commands. */
function Changes({ store, song, pending, onApprove }: { store: Store; song: SongDoc; pending: string[]; onApprove(): void }) {
  const rows = store.tape.filter((e) => mentions(e.cmd, song.id) && !/^(undo|redo)\b/.test(e.cmd)).slice(-10).reverse();
  const now = Date.now();
  return (
    <div className="song-changes" data-testid="song-changes">
      <div className="insp-sec">
        <span className="cap">Waiting for approval</span>
        {pending.length === 0 ? <p className="dim small" data-testid="changes-none">Nothing: every pattern was written or approved by a person.</p> : (
          <>
            <p className="small" data-testid="changes-pending">The agent changed {pending.map((p) => <b key={p} className="mono"> {p}</b>)}.</p>
            <Button kind="agent" testId="approve-song" onClick={onApprove}>Approve the song</Button>
          </>
        )}
      </div>
      <div className="insp-sec">
        <span className="cap">Recent commands</span>
        {rows.length === 0 && <p className="dim small">Nothing on the tape names this song yet.</p>}
        {rows.map((e) => (
          <div key={e.seq} className="insp-hist-row" data-testid="song-change-row" data-by={authorOf(e.by)}>
            <AuthorDot by={authorOf(e.by)} />
            <span className="mono insp-cmd">{e.cmd.split('\n')[0]!.slice(0, 120)}</span>
            <span className="insp-when">{authorOf(e.by) === 'you' ? 'you' : 'agent'}{e.at ? ` · ${ago(e.at, now).replace(' ago', '')}` : ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Ask the agent for changes, pinned to the bars selected on the ruler and the selected channel. */
function SongAsk({ store, song, bars, channel, focusToken }: { store: Store; song: SongDoc; bars: BarSel | null; channel: string | null; focusToken: number }) {
  const [text, setText] = useState('');
  const [state, setState] = useState<{ ok: boolean; msg: string } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [seen, setSeen] = useState(0);
  if (focusToken !== seen) { setSeen(focusToken); setTimeout(() => ref.current?.focus(), 30); }
  const pin = bars ? `bars ${bars.from + 1}${bars.to > bars.from ? `–${bars.to + 1}` : ''}${channel ? `, ${channel}` : ''}` : channel ? channel : null;
  const send = async (): Promise<void> => {
    const note = text.trim();
    if (!note) return;
    const r = await store.request({ action: 'request', kind: 'change', sound: song.id, note, ...(bars ? { target: { kind: 'bars', from: bars.from + 1, to: bars.to + 1, ...(channel ? { channel } : {}) } } : {}) });
    setState({ ok: r.ok, msg: r.ok ? 'Sent to the agent.' : (r.error ?? 'The request was refused.') });
    if (r.ok) setText('');
  };
  return (
    <div className="ask-box insp-sec" data-testid="song-ask">
      <span className="cap">Ask for changes{pin ? ` · ${pin}` : ''}</span>
      <textarea ref={ref} value={text} rows={3} data-testid="song-ask-text" aria-label="Ask the agent for changes" placeholder={bars ? `What should change in ${pin}?` : 'What should change? Drag on the ruler to pin it to bars.'}
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void send(); } else if (e.key === 'Escape') (e.target as HTMLElement).blur(); }} />
      <div className="ask-row">
        <Button kind="agent" testId="song-ask-send" disabled={!text.trim()} onClick={() => void send()}>Send <kbd className="kbd">⌘↵</kbd></Button>
        {state && <span className={state.ok ? 'dim small' : 'small ask-err'} role="status">{state.msg}</span>}
      </div>
    </div>
  );
}

export function SongEditor({ store, id, view }: { store: Store; id: string; view?: 'mixer' }) {
  const song = store.songs.find((x) => x.id === id);
  const [patName, setPatName] = useState<string | null>(null);
  const [chan, setChan] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<number | null>(null);
  const [bars, setBars] = useState<BarSel | null>(null);
  const [flagId, setFlagId] = useState<string | null>(null);
  const [tab, setTab] = useState<'roll' | 'grid'>('roll');
  const [ghostOn, setGhostOn] = useState(false);
  const [ghostCh, setGhostCh] = useState<string | null>(null);
  const [ghostManual, setGhostManual] = useState(false);
  const [inspector, toggleInspector] = useSongInspector();
  const [inspTab, setInspTab] = useState<InspTab>('instruments');
  const [askFocus, setAskFocus] = useState(0);
  // R and the context menu ask about the bars picked on the ruler, with the selected channel
  useAskSource(() => {
    if (!bars) return null;
    const target = { kind: 'bars' as const, from: bars.from + 1, to: bars.to + 1, ...(chan ? { channel: chan } : {}) };
    return { sound: id, target, label: askLabel(id, target), anchor: () => document.querySelector('[data-testid="bar-selection"]')?.getBoundingClientRect() ?? null };
  }, 2);
  const root = useRef<HTMLElement | null>(null);
  const playing = !!song && store.songPlay?.id === song.id;
  const { at: playingAt, nowRef } = useSongClock(store, song, playing && view !== 'mixer', root);
  const report = useSongReport(store, song);
  const authors = useMemo(() => patternAuthors(store.tape, id), [store.tape, id]);

  let arr: Arr | null = null;
  if (song) { try { arr = arrange(song); } catch { arr = null; } }
  const names = song ? [...song.patterns.keys()] : [];
  const pattern: Pattern | undefined = song ? (song.patterns.get(patName ?? '') ?? song.patterns.get(arr?.instances[0]?.pattern.name ?? '') ?? song.patterns.get(names[0] ?? '')) : undefined;
  const melodic = song?.channels.filter((c) => c.inst) ?? [];
  const channel = song?.channels.find((c) => c.name === chan && c.inst) ?? melodic[0];
  const layers = song ? layerOrder(song) : [];
  const intensity = song ? (store.songIntensity.get(song.id) ?? null) : null;
  const send = (cmds: string[]): void => { if (cmds.length) void store.run(cmds.join('\n')); };
  const openInspector = (t: InspTab): void => { setInspTab(t); toggleInspector(true); };

  const at = playing ? playingAt : (song && cursor !== null ? store.songStepAt(song, cursor) : null);
  const stepHere = at && pattern && at.pattern === pattern.name ? at.step : null;
  const inst0 = pattern ? firstInstance(arr, pattern.name) : undefined;
  const stepToTime = (s: number): number | null => (inst0 && song ? stepTime(inst0, s, song.swing, inst0.pattern.steps) : null);
  const setCursorStep = (s: number): void => { const t = stepToTime(s); if (t !== null) setCursor(t); };
  // the selection as a span of song time (the bars picked on the ruler, else the notes picked in the roll, else the whole pattern), for looping it
  const selRegion = (): { start: number; end: number } | null => {
    if (!inst0 || !pattern || !song) return null;
    if (bars && arr) {
      const barSec = (song.time[0] * (4 / song.time[1]) * 60) / song.tempo;
      return { start: bars.from * barSec, end: Math.min(arr.total, (bars.to + 1) * barSec) };
    }
    const keys = [...selected].map((k) => Number(k.split(':')[0]));
    const row = channel ? pattern.channels.find((c) => c.name === channel.name) : undefined;
    if (!keys.length || !row) return { start: inst0.t0, end: inst0.t0 + inst0.dur };
    const a = Math.min(...keys);
    let b = Math.max(...keys) + 1;
    while (b < row.cells.length && row.cells[b]!.kind === 'hold') b++;
    return { start: stepToTime(a)!, end: inst0.t0 + b * inst0.stepSec };
  };

  const pickFlag = (f: LaneFlag | null): void => {
    setFlagId(f?.id ?? null);
    if (f && f.kind === 'masking' && song) {
      // the roll shows the lane that is masked, with its partner behind it
      const mine = f.lanes.includes(channel?.name ?? '') ? channel!.name : f.lanes.find((l) => song.channels.find((c) => c.name === l)?.inst) ?? f.lanes[0]!;
      const partner = f.lanes.find((l) => l !== mine) ?? null;
      setChan(mine);
      setGhostCh(partner);
      setGhostManual(false);
      setGhostOn(!!partner);
      const inst = arr?.instances.find((i) => f.from + 0.06 >= i.t0 - 1e-6 && f.from + 0.06 < i.t0 + i.dur);
      if (inst) setPatName(inst.pattern.name);
      setSelected(new Set());
    }
  };

  const actions: Action[] = [
    { id: 'panel.inspector', label: 'Toggle the inspector', group: 'Panels', shortcut: '⌥ 2', key: 'alt+2', override: true, run: () => toggleInspector() },
    { id: 'song.arrangement', label: 'Song: open the arrangement', group: 'Song', run: () => { location.hash = `#/song/${id}`; }, keywords: 'tracks clips ruler' },
    { id: 'song.mixer', label: 'Song: open the mixer', group: 'Song', run: () => { location.hash = `#/song/${id}/mixer`; }, keywords: 'faders pan sends meters loudness master' },
    { id: 'song.instruments', label: 'Song: show the instruments', group: 'Song', run: () => { if (view) location.hash = `#/song/${id}`; openInspector('instruments'); }, keywords: 'channels voice' },
    { id: 'song.helpers', label: 'Song: show the helpers', group: 'Song', run: () => { if (view) location.hash = `#/song/${id}`; openInspector('helpers'); }, keywords: 'chords bass arp drums humanise motif' },
    { id: 'song.order', label: 'Song: show the song order', group: 'Song', run: () => { if (view) location.hash = `#/song/${id}`; openInspector('order'); }, keywords: 'sections intro ending repeat loop' },
    { id: 'song.changes', label: 'Song: show the changes', group: 'Song', run: () => { if (view) location.hash = `#/song/${id}`; openInspector('changes'); }, keywords: 'agent approve history' },
    { id: 'song.roll', label: 'Song: show the piano roll and pattern text', group: 'Song', run: () => { if (view) location.hash = `#/song/${id}`; setTab('roll'); }, keywords: 'notes text' },
    { id: 'song.grid', label: 'Song: show the pattern grid', group: 'Song', run: () => { if (view) location.hash = `#/song/${id}`; setTab('grid'); }, keywords: 'drum hits steps' },
    { id: 'song.ghost', label: 'Song: show another channel’s notes behind the roll', group: 'Song', run: () => setGhostOn((v) => !v), keywords: 'ghost masking partner' },
    ...layers.map((l, i): Action => ({ id: `song.intensity.${i}`, label: `Song: play ${i === 0 ? l : `up to ${l}`}`, group: 'Song', run: () => store.setSongIntensity(id, i === layers.length - 1 ? null : i), enabled: () => layers.length > 1, keywords: 'intensity layers stems' })),
  ];
  useActions(song ? actions : []);

  if (!song) return <section className="editor"><a href="#/" className="back">← all sounds and songs</a><p className="empty" data-testid="song-missing">{store.status === 'open' ? `No song “${id}”.` : 'Connecting…'}</p></section>;

  const mode = store.songPlay?.mode;
  const busy = store.songBusy === song.id;
  const lr = store.lastRender?.id === song.id ? store.lastRender : null;
  const pendingPatterns = [...authors.patterns];
  // the ghost is the masking partner of the roll's channel while a masking flag is selected, else the channel picked in the menu
  const flagObj = flagId ? laneFlags(report, barSeconds(song), Math.max(1, Math.floor((arr?.total ?? 1) / barSeconds(song) + 1e-6))).find((f) => f.id === flagId) : undefined;
  const partner = !ghostManual && flagObj?.kind === 'masking' && channel && flagObj.lanes.includes(channel.name) ? flagObj.lanes.find((l) => l !== channel.name) ?? null : null;
  const picked = ghostCh && ghostCh !== channel?.name && melodic.some((c) => c.name === ghostCh) ? ghostCh : null;
  const ghostName = ghostOn ? (partner ?? picked ?? melodic.find((c) => c.name !== channel?.name)?.name ?? null) : null;
  const ghostNotes = ghostName && pattern ? rollNotes(pattern.channels.find((c) => c.name === ghostName)) : [];

  const header = (
    <header className="editor-head song-head">
      <div className="song-head-row">
        <a href="#/" className="back" data-testid="back">← all sounds and songs</a>
        <h2>{song.id}</h2>
        <span className="chip">{song.kind}</span>
        <span className={`chip status-${song.status}`}>{song.status}</span>
        <a className={`link-btn${view ? '' : ' on'}`} href={`#/song/${id}`} data-testid="view-arrangement">Arrangement</a>
        <a className={`link-btn${view ? ' on' : ''}`} href={`#/song/${id}/mixer`} data-testid="view-mixer">Mixer</a>
        {!view && <button type="button" className={`link-btn${inspector ? ' on' : ''}`} aria-pressed={inspector} data-testid="inspector-toggle" onClick={() => toggleInspector()} title="Inspector (⌥2)">Inspector</button>}
        <span className="spacer" />
        {layers.length > 1 && (
          <span className="song-intensity" data-testid="intensity">
            <span className="dim small">Intensity</span>
            <Segmented<string> label="Intensity" value={String(intensity ?? layers.length - 1)} onChange={(v) => store.setSongIntensity(id, Number(v) === layers.length - 1 ? null : Number(v))}
              options={layers.map((l, i) => ({ value: String(i), label: i === 0 ? l : `+ ${l}`, testId: `intensity-${i}` }))} />
          </span>
        )}
      </div>
      <div className="song-head-row">
        <button className="play" data-testid="play-song" data-playing={playing && mode === 'full' && !store.songPlay?.region} disabled={busy} onClick={() => void store.playSong(song.id, 'full')}>{busy ? 'Rendering…' : playing && mode === 'full' && !store.songPlay?.region ? '■ Stop' : '▶ Play'}</button>
        {!view && <button data-testid="play-cursor" disabled={busy || cursor === null} title="play from the cursor" onClick={() => void store.playSong(song.id, 'full', false, null, cursor)}>▶ from cursor</button>}
        {!view && <button data-testid="play-selection" disabled={busy || !inst0} title="the selected bars or notes (or this pattern) repeating" onClick={() => void store.playSong(song.id, 'full', false, selRegion())}>⟲ selection</button>}
        <button data-testid="play-loop" disabled={busy || !arr?.loop} title="the loop region, repeating" onClick={() => void store.playSong(song.id, 'loop')}>{playing && mode === 'loop' ? '■ Stop loop' : '⟲ Loop'}</button>
        <button data-testid="stop-song" disabled={!playing} onClick={() => store.stop()}>■</button>
        <label className="toggle"><input type="checkbox" data-testid="play-on-change" checked={store.playOnChange} onChange={(e) => { store.playOnChange = e.target.checked; store.changed(); }} /> play on change</label>
        {!view && (
          <span className="song-fields" data-testid="song-settings">
            <Field label="tempo" testid="set-tempo" value={String(song.tempo)} onCommit={(v) => send([`song set ${song.id} tempo=${v}`])} width={52} />
            <Field label="swing" testid="set-swing" value={String(song.swing)} onCommit={(v) => send([`song set ${song.id} swing=${v}`])} width={44} />
            <Field label="key" testid="set-key" value={song.key ?? 'none'} onCommit={(v) => send([`song set ${song.id} key=${v}`])} width={96} />
            <label className="field">time
              <select data-testid="set-time" value={`${song.time[0]}/${song.time[1]}`} onChange={(e) => send([`song set ${song.id} time=${e.target.value}`])}>
                {[...new Set([`${song.time[0]}/${song.time[1]}`, ...TIMES])].map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
          </span>
        )}
        <span className="spacer" />
        <button data-testid="editor-undo" disabled={!store.canUndo()} onClick={() => void store.undo()}>Undo</button>
        <button data-testid="editor-redo" disabled={!store.canRedo()} onClick={() => void store.redo()}>Redo</button>
      </div>
    </header>
  );

  if (view === 'mixer') {
    return (
      <section ref={root} className="editor song-editor song-mixer-page" data-testid="song-editor" data-song={song.id} data-playing={playing} data-view="mixer">
        {header}
        <div className="row settings">
          <span className="mono dim">{song.tempo} BPM · {song.time[0]}/{song.time[1]}{song.key ? ` · ${song.key}` : ''}</span>
          <span className="spacer" />
          <MeterModeToggle store={store} />
        </div>
        <Mixer store={store} song={song} report={report} intensity={intensity} onInserts={() => { location.hash = `#/song/${id}`; openInspector('instruments'); }} />
      </section>
    );
  }

  const inspectorBody = (
    <aside className="inspector song-insp" data-testid="inspector" aria-label="Inspector">
      <div className="insp-tabs">
        <Tabs<InspTab> label="Song inspector" value={inspTab} onChange={setInspTab} testId="insp-tabs"
          tabs={[{ value: 'instruments', label: 'Instruments', testId: 'insp-tab-instruments' }, { value: 'helpers', label: 'Helpers', testId: 'insp-tab-helpers' }, { value: 'order', label: 'Order', testId: 'insp-tab-order' }, { value: 'changes', label: 'Changes', testId: 'insp-tab-changes', ...(pendingPatterns.length ? { count: pendingPatterns.length } : {}) }]} />
      </div>
      <div className="insp-body">
        {inspTab === 'instruments' && <InstrumentPanel store={store} song={song} />}
        {inspTab === 'helpers' && (pattern
          ? <HelperPanel store={store} song={song} pattern={pattern} channel={channel?.name ?? song.channels[0]?.name ?? null} atStep={selected.size ? Math.min(...[...selected].map((k) => Number(k.split(':')[0]))) : 0} />
          : <p className="dim small pad">The song has no patterns yet.</p>)}
        {inspTab === 'order' && <SongOrderPanel song={song} arr={arr} current={pattern?.name ?? null} send={send} onPattern={(p) => { setPatName(p); setSelected(new Set()); }} />}
        {inspTab === 'changes' && <Changes store={store} song={song} pending={pendingPatterns} onApprove={() => void store.run(`song mark ${song.id} approved`)} />}
      </div>
      <SongAsk store={store} song={song} bars={bars} channel={channel?.name ?? null} focusToken={askFocus} />
    </aside>
  );

  return (
    <section ref={root} className="editor song-editor" data-testid="song-editor" data-song={song.id} data-playing={playing} data-step={at?.step ?? ''} data-pattern={at?.pattern ?? ''}>
      {header}
      <div className="song-grid" data-inspector={inspector || undefined}>
        <div className="song-main">
          <Arrangement store={store} song={song} arr={arr} report={report} authors={authors} channel={channel?.name ?? null} pattern={pattern?.name ?? null} intensity={intensity}
            onChannel={(c) => { if (song.channels.find((x) => x.name === c)?.inst) { setChan(c); setSelected(new Set()); } }}
            onClip={(cl: Clip) => { setPatName(cl.pattern); if (song.channels.find((x) => x.name === cl.channel)?.inst) setChan(cl.channel); setSelected(new Set()); setCursor(cl.t0); }}
            cursor={cursor} onCursor={setCursor} nowRef={nowRef} playing={playing} bars={bars} onBars={setBars} flag={flagId} onFlag={pickFlag} send={send} />
          <div className="row pattern-tabs" data-testid="pattern-tabs">
            <span className="dim">patterns</span>
            {names.map((n) => (
              <button key={n} className={`tab${pattern?.name === n ? ' on' : ''}${authors.patterns.has(n) ? ' agent' : ''}`} data-testid={`tab-${n}`} data-agent={authors.patterns.has(n) || undefined} onClick={() => { setPatName(n); setSelected(new Set()); }}>
                {authors.patterns.has(n) && <span className="mono" aria-label="changed by the agent" title="changed by the agent, not approved yet">✦ </span>}{n}
              </button>
            ))}
            <span className="spacer" />
            <span className="dim small" data-testid="render-stats" data-ms={lr?.ms ?? ''} data-cached={lr?.cached ?? ''} data-edit-ms={store.lastEditToSound ?? ''}>
              {lr ? `last render ${lr.ms} ms (${lr.channels - lr.cached} of ${lr.channels} channels rendered)` : ''}{store.lastEditToSound !== null ? ` · edit to sound ${store.lastEditToSound} ms` : ''}
            </span>
            <span className="dim mono small" data-testid="cursor-readout">
              {playing ? <><LiveText read={() => nowRef.current} fmt={(v) => (v === null ? '' : `${v.toFixed(2)} s`)} />{at ? ` · ${at.section} · ${at.pattern} step ${at.step}` : ''}</>
                : cursor !== null ? `${cursor.toFixed(2)} s${at ? ` · ${at.section} · ${at.pattern} step ${at.step}` : ''}` : 'no cursor: click the ruler or a step'}
            </span>
          </div>
          {pattern ? (
            <div className="split" data-testid="split-editor">
              <div className="split-head">
                <Tabs<'roll' | 'grid'> label="Editor" value={tab} onChange={setTab} testId="split-tabs" tabs={[{ value: 'roll', label: 'Roll + text', testId: 'split-tab-roll' }, { value: 'grid', label: 'Grid', testId: 'split-tab-grid' }]} />
                {tab === 'roll' && channel && (
                  <span className="roll-tabs" role="group" aria-label="Channel">
                    {melodic.map((c) => <button key={c.name} className={`tab${c.name === channel.name ? ' on' : ''}`} data-testid={`roll-tab-${c.name}`} style={{ ['--tab-colour' as string]: channelColour(song, c.name) }} onClick={() => { setChan(c.name); setSelected(new Set()); }}>{c.name}</button>)}
                  </span>
                )}
                <span className="spacer" />
                {tab === 'roll' && melodic.length > 1 && (
                  <span className="ghost-ctl" data-testid="ghost-ctl">
                    <label className="toggle"><input type="checkbox" data-testid="ghost-toggle" checked={ghostOn} onChange={(e) => setGhostOn(e.target.checked)} /> ghost</label>
                    <select aria-label="Ghost channel" data-testid="ghost-channel" value={ghostName ?? ''} disabled={!ghostOn} onChange={(e) => { setGhostCh(e.target.value); setGhostManual(true); }}>
                      {melodic.filter((c) => c.name !== channel?.name).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                  </span>
                )}
              </div>
              {tab === 'roll' ? (
                <div className="split-body">
                  <div className="split-roll">
                    {channel ? (
                      <section className="panel roll-panel" aria-label={`piano roll of ${channel.name}`}>
                        <PianoRoll key={`${pattern.name}/${channel.name}`} store={store} song={song} pattern={pattern} channel={channel} cursorStep={stepHere} selected={selected} onSelect={setSelected} send={send} onCursor={setCursorStep}
                          colour={channelColour(song, channel.name)} {...(ghostName ? { ghost: ghostNotes, ghostName } : {})} />
                        {ghostName && <p className="ghost-note small" data-testid="ghost-note">ghost: {ghostName}’s notes{flagId ? ', the masking partner' : ''}</p>}
                      </section>
                    ) : <p className="dim pad">No melodic channel: add one with song channel add {song.id} lead inst=square_lead.</p>}
                  </div>
                  <PatternText key={`${song.id}/${pattern.name}`} song={song} pattern={pattern} channel={channel?.name ?? null} agentRows={authors.rows} selected={selected} onSelect={setSelected} send={send} />
                </div>
              ) : (
                <PatternGrid song={song} pattern={pattern} channel={channel?.name ?? null} cursorStep={stepHere} send={send} onChannel={(c) => { setChan(c); setSelected(new Set()); }} onCursor={setCursorStep} />
              )}
            </div>
          ) : <p className="dim" data-testid="no-patterns">The song has no patterns yet.</p>}
        </div>
        {inspector && inspectorBody}
      </div>
    </section>
  );
}

