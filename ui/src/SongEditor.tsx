// The music editor: a song's page (#/song/<id>). The song order (sections as blocks to drag, the
// intro, loop and ending, the loop region on a bar ruler), the settings (tempo, swing, key, time),
// the instrument panel, the pattern grid (every channel; drum channels as a row per hit to paint)
// and the piano roll of the channel picked, the helpers, and playback with a cursor across all of
// them. Every edit is a command, the very text an agent would write, sent as this person: a
// gesture is one batch on the history, undone as one.

import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_KIT, GestureBatch, arrange, formatCell, noteEditText, stepTime,
  type Arrangement, type Instance, type Pattern, type SongDoc,
} from '@soundclaw/core';
import { PianoRoll } from './PianoRoll.tsx';
import { HelperPanel, InstrumentPanel } from './SongPanels.tsx';
import type { Store } from './store.ts';

const TIMES = ['4/4', '3/4', '2/4', '6/8', '5/4', '7/8', '12/8'];

/** The first place a pattern plays in the arrangement (where the grid's steps are timed from). */
const firstInstance = (arr: Arrangement | null, pattern: string): Instance | undefined => arr?.instances.find((i) => i.pattern.name === pattern);

/** A settings field: written as one `song set` when it is left or Enter is pressed. */
function Field({ label, value, testid, onCommit, width = 70 }: { label: string; value: string; testid: string; onCommit(v: string): void; width?: number }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="field">{label}
      <input data-testid={testid} value={v} style={{ width }} onChange={(e) => setV(e.target.value)}
        onBlur={() => { if (v.trim() && v !== value) onCommit(v.trim()); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setV(value); }} />
    </label>
  );
}

// ---- the song order ---------------------------------------------------------------------------------------------------

interface OrderProps {
  song: SongDoc;
  arr: Arrangement | null;
  cursor: number | null;
  current: string | null;
  send(cmds: string[]): void;
  onCursor(t: number): void;
  onPattern(p: string): void;
}

function SongOrder({ song, arr, cursor, current, send, onCursor, onPattern }: OrderProps) {
  const W = 960;
  const total = Math.max(arr?.total ?? 1, 0.001);
  const px = (t: number): number => (t / total) * W;
  // the sections in the order they play, with where each starts and ends
  const spans = song.sections.map((sec) => {
    const ins = arr?.instances.filter((i) => i.section === sec.name) ?? [];
    return { sec, start: ins[0]?.t0 ?? 0, end: ins.length ? ins[ins.length - 1]!.t0 + ins[ins.length - 1]!.dur : 0, part: ins[0]?.part ?? 'body' };
  }).sort((a, b) => a.start - b.start);
  const body = spans.filter((x) => x.part === 'body');
  const [drag, setDrag] = useState<{ name: string; x0: number; dx: number } | null>(null);
  const [loopDrag, setLoopDrag] = useState<{ which: 'from' | 'to' | 'both'; x0: number; from: number; to: number } | null>(null);
  const rail = useRef<HTMLDivElement>(null);
  const xIn = (e: { clientX: number }): number => { const r = rail.current!.getBoundingClientRect(); return ((e.clientX - r.left) / r.width) * W; };

  // reordering: a body block dragged across the others
  const orderAfter = (name: string, dx: number): string[] => {
    const names = body.map((b) => b.sec.name);
    const me = body.find((b) => b.sec.name === name)!;
    const centre = px((me.start + me.end) / 2) + dx;
    const others = body.filter((b) => b.sec.name !== name);
    let at = others.findIndex((b) => px((b.start + b.end) / 2) > centre);
    if (at < 0) at = others.length;
    const out = others.map((b) => b.sec.name);
    out.splice(at, 0, name);
    void names;
    return out;
  };
  const fullOrder = (bodyNames: string[]): string[] => [...(song.intro ? [song.intro] : []), ...bodyNames, ...(song.ending ? [song.ending] : [])];
  const bodyIndex = (name: string | undefined): number => body.findIndex((b) => b.sec.name === name);
  const loopFrom = arr?.loop ? (song.loop && typeof song.loop === 'object' ? bodyIndex(song.loop.from) : 0) : -1;
  const loopTo = arr?.loop ? (song.loop && typeof song.loop === 'object' ? bodyIndex(song.loop.to) : body.length - 1) : -1;
  const lf = loopDrag ? loopDrag.from : loopFrom, lt = loopDrag ? loopDrag.to : loopTo;
  const nearestBoundary = (x: number, ends: boolean): number => {
    let best = 0, bd = Infinity;
    body.forEach((b, i) => { const d = Math.abs(px(ends ? b.end : b.start) - x); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  const beats = song.time[0] * (4 / song.time[1]);
  const barSec = (beats * 60) / song.tempo;
  const bars = Math.floor(total / barSec + 1e-6);
  const every = Math.max(1, Math.ceil(bars / 32));
  return (
    <section className="panel song-order" data-testid="song-order" aria-label="Song order">
      <h3>Song order <span className="dim">drag a block to move it · the band under the bars is the loop: drag its ends or the band</span></h3>
      <div className="order-rail" ref={rail} style={{ width: W }}>
        <div className="blocks">
          {spans.map(({ sec, start, end, part }) => {
            const moving = drag?.name === sec.name;
            return (
              <div key={sec.name} className={`block part-${part}${moving ? ' moving' : ''}${current && sec.patterns.includes(current) ? ' current' : ''}`} data-testid={`block-${sec.name}`} data-part={part}
                style={{ left: px(start) + (moving ? drag!.dx : 0), width: Math.max(24, px(end) - px(start) - 2) }}
                onPointerDown={(e) => { if (part !== 'body' || (e.target as HTMLElement).closest('button')) return; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setDrag({ name: sec.name, x0: e.clientX, dx: 0 }); }}
                onPointerMove={(e) => { if (drag?.name === sec.name) setDrag({ ...drag, dx: e.clientX - drag.x0 }); }}
                onPointerUp={() => {
                  if (drag?.name !== sec.name) return;
                  const next = orderAfter(sec.name, drag.dx);
                  setDrag(null);
                  if (next.join(' ') === body.map((b) => b.sec.name).join(' ')) return;
                  // a loop whose ends now come the other way round keeps its two ends, swapped
                  const lp = song.loop && typeof song.loop === 'object' ? song.loop : null;
                  const swap = lp && next.indexOf(lp.from) > next.indexOf(lp.to);
                  send([`song order ${song.id} ${fullOrder(next).join(' ')}`, ...(swap ? [`song loop ${song.id} ${lp.to}..${lp.from}`] : [])]);
                }}>
                <div className="block-head"><b>{sec.name}</b>{part !== 'body' && <span className="chip tag">{part}</span>}</div>
                <div className="block-pats">
                  {sec.patterns.map((p, i) => <button key={`${p}${i}`} className="link" data-testid={`block-pattern-${sec.name}-${p}`} onClick={() => onPattern(p)}>{p}</button>)}
                </div>
                <div className="block-tools">
                  <button className="mini" title="play it one time fewer" data-testid={`block-less-${sec.name}`} disabled={sec.repeat <= 1} onClick={() => send([`song section set ${song.id} ${sec.name} ${sec.patterns.join(' ')}${sec.repeat - 1 > 1 ? ` x${sec.repeat - 1}` : ''}`])}>−</button>
                  <span data-testid={`block-repeat-${sec.name}`}>x{sec.repeat}</span>
                  <button className="mini" title="play it one time more" data-testid={`block-more-${sec.name}`} onClick={() => send([`song section set ${song.id} ${sec.name} ${sec.patterns.join(' ')} x${sec.repeat + 1}`])}>+</button>
                  <button className={`mini${song.intro === sec.name ? ' on' : ''}`} title="the intro: plays once, before the loop" data-testid={`block-intro-${sec.name}`} onClick={() => send([`song intro ${song.id} ${song.intro === sec.name ? 'none' : sec.name}`])}>intro</button>
                  <button className={`mini${song.ending === sec.name ? ' on' : ''}`} title="the ending: plays once, at the end" data-testid={`block-ending-${sec.name}`} onClick={() => send([`song ending ${song.id} ${song.ending === sec.name ? 'none' : sec.name}`])}>end</button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="ruler" data-testid="bar-ruler" onPointerDown={(e) => { if (!(e.target as HTMLElement).closest('.loop-band')) onCursor((xIn(e) / W) * total); }}>
          {Array.from({ length: bars + 1 }, (_, b) => (
            <span key={b} className={`tick${b % every === 0 ? ' major' : ''}`} style={{ left: px(b * barSec) }}>{b % every === 0 && b < bars ? b + 1 : ''}</span>
          ))}
          {lf >= 0 && lt >= 0 && body[lf] && body[lt] && (
            <div className="loop-band" data-testid="loop-band" data-from={body[lf]!.sec.name} data-to={body[lt]!.sec.name}
              style={{ left: px(body[lf]!.start), width: px(body[lt]!.end) - px(body[lf]!.start) }}
              onPointerDown={(e) => {
                const t = e.target as HTMLElement;
                const which = t.dataset.handle === 'from' ? 'from' : t.dataset.handle === 'to' ? 'to' : 'both';
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                setLoopDrag({ which, x0: xIn(e), from: loopFrom, to: loopTo });
              }}
              onPointerMove={(e) => {
                if (!loopDrag) return;
                const x = xIn(e);
                if (loopDrag.which === 'from') setLoopDrag({ ...loopDrag, from: Math.min(nearestBoundary(x, false), loopDrag.to) });
                else if (loopDrag.which === 'to') setLoopDrag({ ...loopDrag, to: Math.max(nearestBoundary(x, true), loopDrag.from) });
                else {
                  const span = loopTo - loopFrom;
                  const from = Math.max(0, Math.min(body.length - 1 - span, nearestBoundary(px(body[loopFrom]!.start) + (x - loopDrag.x0), false)));
                  setLoopDrag({ ...loopDrag, from, to: from + span });
                }
              }}
              onPointerUp={() => {
                const d = loopDrag;
                setLoopDrag(null);
                if (d && (d.from !== loopFrom || d.to !== loopTo)) send([`song loop ${song.id} ${body[d.from]!.sec.name}..${body[d.to]!.sec.name}`]);
              }}>
              <span className="loop-handle from" data-handle="from" data-testid="loop-from" />
              <span className="loop-label">loop</span>
              <span className="loop-handle to" data-handle="to" data-testid="loop-to" />
            </div>
          )}
          {cursor !== null && <span className="order-cursor" data-testid="order-cursor" data-t={cursor.toFixed(3)} style={{ left: px(cursor) }} />}
        </div>
      </div>
      <div className="row dim">
        {arr ? `${arr.total.toFixed(1)} s · ${bars} bars${arr.loop ? ` · loop ${arr.loop.start.toFixed(1)}–${arr.loop.end.toFixed(1)} s` : ' · no loop'}` : 'the song cannot be arranged'}
        <span className="spacer" />
        <button className="mini" data-testid="loop-auto" disabled={song.loop === null || song.kind === 'stinger'} onClick={() => send([`song loop ${song.id} auto`])} title="the whole body loops">loop all</button>
        <button className="mini" data-testid="loop-off" disabled={song.loop === false} onClick={() => send([`song loop ${song.id} off`])} title="the song does not loop">no loop</button>
      </div>
    </section>
  );
}

// ---- the pattern grid ------------------------------------------------------------------------------------------------

interface GridProps {
  song: SongDoc;
  pattern: Pattern;
  channel: string | null;
  cursorStep: number | null;
  send(cmds: string[]): void;
  onChannel(c: string): void;
  onCursor(step: number): void;
}

/** The hit rows a drum channel shows: the default kit's short words, its own kit, and any word the pattern uses. */
function drumWords(pattern: Pattern, name: string, kit: Record<string, string> | null): string[] {
  const used = (pattern.channels.find((c) => c.name === name)?.cells ?? []).flatMap((c) => (c.kind === 'drum' ? [c.drum] : []));
  const base = ['k', 's', 'h', 'oh'];
  return [...new Set([...base, ...Object.keys(kit ?? {}), ...used])].filter((w) => used.includes(w) || base.includes(w) || (kit && w in kit) || w in DEFAULT_KIT);
}

function PatternGrid({ song, pattern, channel, cursorStep, send, onChannel, onCursor }: GridProps) {
  // painting hits: the drag's mode comes from the first cell (a hit there: erase; none: paint)
  const paint = useRef<{ ch: string; word: string; mode: 'paint' | 'erase'; batch: GestureBatch } | null>(null);
  const [draft, setDraft] = useState<Map<string, boolean>>(new Map());
  useEffect(() => {
    const up = (): void => { const p = paint.current; paint.current = null; if (p) p.batch.flush(); setDraft(new Map()); };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);
  const touch = (ch: string, word: string, step: number, has: boolean): void => {
    const p = paint.current;
    if (!p || p.ch !== ch || p.word !== word) return;
    const want = p.mode === 'paint';
    p.batch.push(`${step}`, want === has ? null : want
      ? noteEditText(song.id, pattern.name, { verb: 'add', channel: ch, step, cell: { kind: 'drum', drum: word, vel: 100 }, len: null })
      : noteEditText(song.id, pattern.name, { verb: 'remove', channel: ch, step, sel: { drum: word } }));
    setDraft((d) => new Map(d).set(`${ch}/${word}/${step}`, want));
  };
  const steps = Array.from({ length: pattern.steps }, (_, s) => s);
  const barCls = (s: number): string => (pattern.bar && s > 0 && s % pattern.bar === 0 ? ' bar' : s % pattern.tpb === 0 ? ' beat' : '');
  return (
    <section className="panel grid-panel" data-testid="pattern-grid" data-pattern={pattern.name} aria-label={`pattern ${pattern.name}`}>
      <table className="grid">
        <thead>
          <tr>
            <th />
            {steps.map((s) => <th key={s} className={`step-head${barCls(s)}${cursorStep === s ? ' now' : ''}`} data-testid={`grid-head-${s}`} onClick={() => onCursor(s)} title="put the cursor here">{s % pattern.tpb === 0 ? s / pattern.tpb + 1 : ''}</th>)}
          </tr>
        </thead>
        <tbody>
          {song.channels.map((ch) => {
            const cells = pattern.channels.find((c) => c.name === ch.name)?.cells ?? [];
            if (ch.kit) {
              return drumWords(pattern, ch.name, ch.kit).map((word, wi) => (
                <tr key={`${ch.name}/${word}`} className={`hit-row${wi === 0 ? ' first' : ''}`} data-testid={`grid-row-${ch.name}-${word}`}>
                  <th className="chan" title={`${ch.name}: hit ${word}`}>{wi === 0 ? <span>{ch.name} </span> : null}<span className="dim">{word}</span></th>
                  {steps.map((s) => {
                    const c = cells[s];
                    const has = c?.kind === 'drum' && c.drum === word;
                    const d = draft.get(`${ch.name}/${word}/${s}`);
                    const on = d ?? has;
                    return (
                      <td key={s} className={`cell hit${on ? ' on' : ''}${barCls(s)}${cursorStep === s ? ' now' : ''}`} data-testid={`hit-${ch.name}-${word}-${s}`} data-on={on}
                        onPointerDown={(e) => { if (e.button !== 0) return; (e.target as HTMLElement).releasePointerCapture?.(e.pointerId); paint.current = { ch: ch.name, word, mode: has ? 'erase' : 'paint', batch: new GestureBatch(send) }; touch(ch.name, word, s, has); }}
                        onPointerEnter={() => touch(ch.name, word, s, has)}>
                        {c?.kind === 'drum' && c.drum === word && c.vel !== 100 ? <span className="vel">{c.vel}</span> : null}
                      </td>
                    );
                  })}
                </tr>
              ));
            }
            return (
              <tr key={ch.name} className={`note-row${channel === ch.name ? ' picked' : ''}`} data-testid={`grid-row-${ch.name}`} onClick={() => onChannel(ch.name)}>
                <th className="chan" title={`${ch.name}: ${ch.inst}; click to open it in the piano roll`}>{ch.name}</th>
                {steps.map((s) => {
                  const c = cells[s];
                  return <td key={s} className={`cell${c?.kind === 'hold' ? ' hold' : c?.kind === 'notes' ? ' note' : ''}${barCls(s)}${cursorStep === s ? ' now' : ''}`} data-testid={`cell-${ch.name}-${s}`}>{c && c.kind !== 'rest' && c.kind !== 'hold' ? formatCell(c).replace(/~.*$/, '~') : ''}</td>;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// ---- the page --------------------------------------------------------------------------------------------------------

export function SongEditor({ store, id }: { store: Store; id: string }) {
  const song = store.songs.find((x) => x.id === id);
  const [patName, setPatName] = useState<string | null>(null);
  const [chan, setChan] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<number | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const raf = useRef(0);
  const playing = !!song && store.songPlay?.id === song.id;
  useEffect(() => {
    if (!playing || !song) { setNow(null); return; }
    const tick = (): void => {
      setNow(store.songClock(song.id));
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, song, store]);

  if (!song) return <section className="editor"><a href="#/" className="back">← all sounds and songs</a><p className="empty" data-testid="song-missing">{store.status === 'open' ? `No song “${id}”.` : 'Connecting…'}</p></section>;

  let arr: Arrangement | null = null;
  try { arr = arrange(song); } catch { arr = null; }
  const names = [...song.patterns.keys()];
  const pattern = song.patterns.get(patName ?? '') ?? song.patterns.get(arr?.instances[0]?.pattern.name ?? '') ?? song.patterns.get(names[0] ?? '');
  const melodic = song.channels.filter((c) => c.inst);
  const channel = song.channels.find((c) => c.name === chan && c.inst) ?? melodic[0];
  const send = (cmds: string[]): void => { if (cmds.length) void store.run(cmds.join('\n')); };
  const shown = now ?? cursor;
  const at = shown !== null ? store.songStepAt(song, shown) : null;
  const stepHere = at && pattern && at.pattern === pattern.name ? at.step : null;
  const inst0 = pattern ? firstInstance(arr, pattern.name) : undefined;
  const stepToTime = (s: number): number | null => (inst0 ? stepTime(inst0, s, song.swing, inst0.pattern.steps) : null);
  const setCursorStep = (s: number): void => { const t = stepToTime(s); if (t !== null) setCursor(t); };
  // the selection as a span of song time (the notes picked in the roll, else the whole pattern), for looping it
  const selRegion = (): { start: number; end: number } | null => {
    if (!inst0 || !pattern) return null;
    const keys = [...selected].map((k) => Number(k.split(':')[0]));
    const row = channel ? pattern.channels.find((c) => c.name === channel.name) : undefined;
    if (!keys.length || !row) return { start: inst0.t0, end: inst0.t0 + inst0.dur };
    const a = Math.min(...keys);
    let b = Math.max(...keys) + 1;
    while (b < row.cells.length && row.cells[b]!.kind === 'hold') b++;
    return { start: stepToTime(a)!, end: inst0.t0 + b * inst0.stepSec };
  };
  const mode = store.songPlay?.mode;
  const busy = store.songBusy === song.id;
  const lr = store.lastRender?.id === song.id ? store.lastRender : null;
  return (
    <section className="editor song-editor" data-testid="song-editor" data-song={song.id} data-playing={playing} data-now={now !== null ? now.toFixed(3) : ''} data-step={at?.step ?? ''} data-pattern={at?.pattern ?? ''}>
      <header className="editor-head">
        <a href="#/" className="back" data-testid="back">← all sounds and songs</a>
        <h2>{song.id}</h2>
        <span className="chip">{song.kind}</span>
        <span className={`chip status-${song.status}`}>{song.status}</span>
        <span className="spacer" />
        <button className="play" data-testid="play-song" data-playing={playing && mode === 'full' && !store.songPlay?.region} disabled={busy} onClick={() => void store.playSong(song.id, 'full')}>{busy ? 'Rendering…' : playing && mode === 'full' && !store.songPlay?.region ? '■ Stop' : '▶ Play'}</button>
        <button data-testid="play-cursor" disabled={busy || cursor === null} title="play from the cursor" onClick={() => void store.playSong(song.id, 'full', false, null, cursor)}>▶ from cursor</button>
        <button data-testid="play-selection" disabled={busy || !inst0} title="the selected notes (or this pattern) repeating" onClick={() => void store.playSong(song.id, 'full', false, selRegion())}>⟲ selection</button>
        <button data-testid="play-loop" disabled={busy || !arr?.loop} title="the loop region, repeating" onClick={() => void store.playSong(song.id, 'loop')}>{playing && mode === 'loop' ? '■ Stop loop' : '⟲ Loop'}</button>
        <button data-testid="stop-song" disabled={!playing} onClick={() => store.stop()}>■</button>
        <label className="toggle"><input type="checkbox" data-testid="play-on-change" checked={store.playOnChange} onChange={(e) => { store.playOnChange = e.target.checked; store.changed(); }} /> play on change</label>
        <button data-testid="editor-undo" disabled={!store.canUndo()} onClick={() => void store.undo()}>Undo</button>
        <button data-testid="editor-redo" disabled={!store.canRedo()} onClick={() => void store.redo()}>Redo</button>
      </header>
      <div className="row settings" data-testid="song-settings">
        <Field label="tempo" testid="set-tempo" value={String(song.tempo)} onCommit={(v) => send([`song set ${song.id} tempo=${v}`])} width={56} />
        <Field label="swing" testid="set-swing" value={String(song.swing)} onCommit={(v) => send([`song set ${song.id} swing=${v}`])} width={50} />
        <Field label="key" testid="set-key" value={song.key ?? 'none'} onCommit={(v) => send([`song set ${song.id} key=${v}`])} width={110} />
        <label className="field">time
          <select data-testid="set-time" value={`${song.time[0]}/${song.time[1]}`} onChange={(e) => send([`song set ${song.id} time=${e.target.value}`])}>
            {[...new Set([`${song.time[0]}/${song.time[1]}`, ...TIMES])].map((t) => <option key={t}>{t}</option>)}
          </select>
        </label>
        <span className="spacer" />
        <span className="dim" data-testid="render-stats" data-ms={lr?.ms ?? ''} data-cached={lr?.cached ?? ''} data-edit-ms={store.lastEditToSound ?? ''}>
          {lr ? `last render ${lr.ms} ms (${lr.channels - lr.cached} of ${lr.channels} channels rendered)` : ''}{store.lastEditToSound !== null ? ` · edit to sound ${store.lastEditToSound} ms` : ''}
        </span>
        <span className="dim" data-testid="cursor-readout">{shown !== null ? `${shown.toFixed(2)} s${at ? ` · ${at.section} · ${at.pattern} step ${at.step}` : ''}` : 'no cursor: click the ruler or a step'}</span>
      </div>
      <SongOrder song={song} arr={arr} cursor={shown} current={pattern?.name ?? null} send={send} onCursor={setCursor} onPattern={(p) => { setPatName(p); setSelected(new Set()); }} />
      <InstrumentPanel store={store} song={song} />
      <div className="row pattern-tabs" data-testid="pattern-tabs">
        <span className="dim">patterns</span>
        {names.map((n) => <button key={n} className={`tab${pattern?.name === n ? ' on' : ''}`} data-testid={`tab-${n}`} onClick={() => { setPatName(n); setSelected(new Set()); }}>{n}</button>)}
      </div>
      {pattern ? (
        <>
          <PatternGrid song={song} pattern={pattern} channel={channel?.name ?? null} cursorStep={stepHere} send={send} onChannel={(c) => { setChan(c); setSelected(new Set()); }} onCursor={setCursorStep} />
          <div className="roll-row-layout">
            {channel ? (
              <section className="panel roll-panel" aria-label={`piano roll of ${channel.name}`}>
                <div className="row">
                  <h3>Piano roll</h3>
                  {melodic.map((c) => <button key={c.name} className={`tab${c.name === channel.name ? ' on' : ''}`} data-testid={`roll-tab-${c.name}`} onClick={() => { setChan(c.name); setSelected(new Set()); }}>{c.name}</button>)}
                </div>
                <PianoRoll key={`${pattern.name}/${channel.name}`} store={store} song={song} pattern={pattern} channel={channel} cursorStep={stepHere} selected={selected} onSelect={setSelected} send={send} onCursor={setCursorStep} />
              </section>
            ) : <p className="dim">No melodic channel: add one with song channel add {song.id} lead inst=square_lead.</p>}
            <HelperPanel store={store} song={song} pattern={pattern} channel={channel?.name ?? song.channels[0]?.name ?? null} atStep={selected.size ? Math.min(...[...selected].map((k) => Number(k.split(':')[0]))) : 0} />
          </div>
        </>
      ) : <p className="dim" data-testid="no-patterns">The song has no patterns yet.</p>}
    </section>
  );
}
