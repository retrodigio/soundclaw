// The transport bar: project, play/stop/loop and position for the focused tab, tempo and key for
// a song, the master meter against the loudness target, undo and redo, who you are, the agent's
// presence, the connection, the panel toggles and the search field.

import { useEffect, useRef, useState } from 'react';
import type { Store } from '../store.ts';
import { IconButton, Meter } from './controls.tsx';
import { Chevron, Logo, Loop, Person, Play, Redo, Search, Stop, Undo } from './icons.tsx';
import { usePrefs, setPanels } from './prefs.ts';
import { PresencePill } from './Rail.tsx';
import { shortcutLabel } from './registry.ts';
import { lufsText, MINUS, type Focus } from './shellData.ts';

const fmtTime = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;

/** The play position, updated straight on the element every animation frame (never through React state). */
function Position({ store, focus }: { store: Store; focus: Focus | null }) {
  const el = useRef<HTMLSpanElement>(null);
  const t0 = useRef<number | null>(null);
  const last = useRef<string | null>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const playing = store.playing;
      let t = 0;
      if (playing && !store.rendering) {
        if (last.current !== playing) { last.current = playing; t0.current = performance.now(); }
        const song = store.songPlay ? store.songClock(store.songPlay.id) : null;
        t = song ?? (t0.current === null ? 0 : (performance.now() - t0.current) / 1000);
      } else { last.current = null; t0.current = null; }
      if (el.current) el.current.textContent = fmtTime(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [store]);
  void focus;
  return <span ref={el} className="mono position" data-testid="position" aria-label="Play position">0:00.000</span>;
}

/** Two thin bars fed from the master analyser, with the loudness target as a band. */
function MasterMeter({ store, focus }: { store: Store; focus: Focus | null }) {
  const sum = focus?.kind === 'sound' ? store.summary(focus.id) : undefined;
  const doc = focus?.kind === 'sound' ? store.doc(focus.id) : undefined;
  const song = focus?.kind === 'song' ? store.songs.find((x) => x.id === focus.id) : undefined;
  const rule = doc ? store.rule(doc) : null;
  const target = song?.loudness ?? rule?.target ?? store.style.loudnessTarget;
  const tol = rule?.tolerance ?? store.style.loudnessTolerance;
  const lufs = sum?.info ? sum.info.lufs : undefined;
  const pos = (v: number) => `${Math.min(100, Math.max(0, ((v + 30) / 24) * 100))}%`;
  return (
    <div className="master" data-testid="master" title="Master level; the band is the loudness target">
      <span className="cap small-cap">Master</span>
      <div className="master-bars" aria-hidden>
        <Meter horizontal read={() => store.readLevels()} levels={[-120, -120]} label="Master level" testId="master-meter" />
        <span className="target-band" style={{ left: pos(target - tol), width: `${(2 * tol / 24) * 100}%` }} />
      </div>
      <span className="mono master-lufs" data-testid="master-lufs">{lufs !== undefined ? `${lufsText(lufs)} LUFS` : `${target.toFixed(0).replace('-', MINUS)} LUFS`}</span>
    </div>
  );
}

/** Your name: a compact chip (person and name) that becomes the text field when clicked. */
function YouChip({ store }: { store: Store }) {
  const [editing, setEditing] = useState(false);
  const name = store.me.replace(/^human:/, '');
  if (!editing) return <button type="button" className="you-chip" onClick={() => setEditing(true)} data-testid="author-chip" title="The name your edits are written as. Click to change."><Person size={12} color="currentColor" /><span>{name}</span></button>;
  return (
    <label className="t-me" title="The name your edits are written as"><Person size={12} /><span className="sr-only">Your name</span>
      <input autoFocus value={name} data-testid="author" aria-label="Your name" onChange={(e) => store.setAuthor(e.target.value)} onBlur={() => setEditing(false)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') setEditing(false); }} />
    </label>
  );
}

export function Transport({ store, focus, onPalette, canLoop, onPlay, onStop, onLoop, playingNow, looping }: {
  store: Store; focus: Focus | null; onPalette(): void; canLoop: boolean; onPlay(): void; onStop(): void; onLoop(): void; playingNow: boolean; looping: boolean;
}) {
  const prefs = usePrefs();
  const p = prefs.panels;
  const song = focus?.kind === 'song' ? store.songs.find((x) => x.id === focus.id) : undefined;
  const name = store.project?.name ?? '';
  return (
    <header className="transport" data-testid="transport">
      <div className="t-project"><Logo size={24} /><span className="t-name" data-testid="project-name" title={store.project?.dir}>{name}</span><span className="mono dim small-mono" data-testid="project-counts">{store.index.length} sounds {'·'} {store.songs.length} songs</span></div>
      <div className="t-sep" />
      <div className="t-buttons" role="group" aria-label="Transport">
        <IconButton label={playingNow ? 'Stop' : 'Play'} shortcut={shortcutLabel('Space')} kind="primary" onClick={playingNow ? onStop : onPlay} testId="transport-play">{playingNow ? <Stop size={10} /> : <Play size={11} />}</IconButton>
        <IconButton label="Stop" onClick={onStop} testId="transport-stop" disabled={!playingNow}><Stop size={9} /></IconButton>
        <IconButton label="Loop" shortcut="L" pressed={looping} onClick={onLoop} disabled={!canLoop} testId="transport-loop"><Loop size={15} /></IconButton>
      </div>
      <Position store={store} focus={focus} />
      {song && <><span className="mono t-pill" data-testid="t-tempo">{song.tempo} BPM</span><span className="mono t-pill">{song.key ?? 'no key'}</span><span className="mono t-pill">{song.time[0]}/{song.time[1]}</span></>}
      <MasterMeter store={store} focus={focus} />
      <span className="grow" />
      <div className="t-buttons">
        <IconButton label="Undo" shortcut={shortcutLabel('⌘Z')} onClick={() => void store.undo()} disabled={!store.canUndo()} testId="undo"><Undo /></IconButton>
        <IconButton label="Redo" shortcut={shortcutLabel('⇧⌘Z')} onClick={() => void store.redo()} disabled={!store.canRedo()} testId="redo"><Redo /></IconButton>
      </div>
      <YouChip store={store} />
      <PresencePill store={store} />
      <span className={`conn conn-${store.status}`} data-testid="connection" data-status={store.status} title={`Server: ${store.status}`}><span className="conn-dot" aria-hidden /><span className="conn-word">{store.status === 'open' ? 'online' : store.status === 'closed' ? 'offline' : 'connecting'}</span></span>
      <div className="t-buttons panel-toggles" role="group" aria-label="Panels">
        <IconButton label="Library" shortcut={shortcutLabel('⌥1')} pressed={p.libOpen} onClick={() => setPanels({ libOpen: !p.libOpen })} testId="toggle-library"><Chevron dir="left" /></IconButton>
        <IconButton label="Agent rail" shortcut={shortcutLabel('⌥3')} pressed={p.railOpen} onClick={() => setPanels({ railOpen: !p.railOpen })} testId="toggle-rail"><Chevron dir="right" /></IconButton>
        <IconButton label="Bottom panel" shortcut={shortcutLabel('⌥4')} pressed={p.bottomOpen} onClick={() => setPanels({ bottomOpen: !p.bottomOpen })} testId="toggle-bottom"><Chevron dir="down" /></IconButton>
      </div>
      <button type="button" className="search-btn" onClick={onPalette} data-testid="open-palette" aria-label="Search or ask"><Search size={13} /><span className="search-text">Search or ask</span><kbd className="kbd">{shortcutLabel('⌘K')}</kbd></button>
    </header>
  );
}
