// Pieces of the song page that keep their old behaviour: a settings field, the song order as a list
// of sections to drag and repeat (the loop region lives on the arrangement's ruler), and the pattern
// grid (drum hit rows to paint), which is a tab beside the piano roll.

import { useEffect, useRef, useState } from 'react';
import { DEFAULT_KIT, GestureBatch, formatCell, noteEditText, type Arrangement, type Pattern, type SongDoc } from '@soundclaw/core';
import { sectionSpans } from './model.ts';

/** A settings field: written as one `song set` when it is left or Enter is pressed. */
export function Field({ label, value, testid, onCommit, width = 70 }: { label: string; value: string; testid: string; onCommit(v: string): void; width?: number }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="field">{label}
      <input data-testid={testid} value={v} style={{ width }} onChange={(e) => setV(e.target.value)}
        onBlur={() => { if (v.trim() && v !== value) onCommit(v.trim()); }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setV(value); }} />
    </label>
  );
}

// ---- the song order ---------------------------------------------------------------------------------------------------

interface OrderProps {
  song: SongDoc;
  arr: Arrangement | null;
  current: string | null;
  send(cmds: string[]): void;
  onPattern(p: string): void;
}

/** The sections in the order they play: drag a row to move it, repeat it, make it the intro or the ending. */
export function SongOrderPanel({ song, arr, current, send, onPattern }: OrderProps) {
  const spans = arr ? sectionSpans(song, arr) : [];
  const body = spans.filter((x) => x.part === 'body');
  const [drag, setDrag] = useState<{ name: string; y0: number; dy: number } | null>(null);
  const rows = useRef<Map<string, HTMLElement>>(new Map());
  const fullOrder = (bodyNames: string[]): string[] => [...(song.intro ? [song.intro] : []), ...bodyNames, ...(song.ending ? [song.ending] : [])];
  const orderAfter = (name: string, dy: number): string[] => {
    const me = rows.current.get(name)!.getBoundingClientRect();
    const centre = me.top + me.height / 2 + dy;
    const others = body.filter((b) => b.name !== name);
    let at = others.findIndex((b) => { const r = rows.current.get(b.name)!.getBoundingClientRect(); return r.top + r.height / 2 > centre; });
    if (at < 0) at = others.length;
    const out = others.map((b) => b.name);
    out.splice(at, 0, name);
    return out;
  };
  const beats = song.time[0] * (4 / song.time[1]);
  const barSec = (beats * 60) / song.tempo;
  const bars = arr ? Math.floor(arr.total / barSec + 1e-6) : 0;
  return (
    <section className="panel song-order" data-testid="song-order" aria-label="Song order">
      <p className="dim small">Drag a section to move it. The loop region is the band on the arrangement’s ruler.</p>
      <div className="order-list">
        {spans.map(({ name, part }) => {
          const sec = song.sections.find((s) => s.name === name)!;
          const moving = drag?.name === name;
          return (
            <div key={name} ref={(el) => { if (el) rows.current.set(name, el); }} className={`order-row part-${part}${moving ? ' moving' : ''}${current && sec.patterns.includes(current) ? ' current' : ''}`} data-testid={`block-${name}`} data-part={part}
              style={moving ? { transform: `translateY(${drag!.dy}px)` } : undefined}
              onPointerDown={(e) => { if (part !== 'body' || (e.target as HTMLElement).closest('button')) return; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setDrag({ name, y0: e.clientY, dy: 0 }); }}
              onPointerMove={(e) => { if (drag?.name === name) setDrag({ ...drag, dy: e.clientY - drag.y0 }); }}
              onPointerUp={() => {
                if (drag?.name !== name) return;
                const next = orderAfter(name, drag.dy);
                setDrag(null);
                if (next.join(' ') === body.map((b) => b.name).join(' ')) return;
                // a loop whose ends now come the other way round keeps its two ends, swapped
                const lp = song.loop && typeof song.loop === 'object' ? song.loop : null;
                const swap = lp && next.indexOf(lp.from) > next.indexOf(lp.to);
                send([`song order ${song.id} ${fullOrder(next).join(' ')}`, ...(swap ? [`song loop ${song.id} ${lp.to}..${lp.from}`] : [])]);
              }}>
              <b className="order-name">{name}</b>
              {part !== 'body' && <span className="chip tag">{part}</span>}
              <span className="order-pats">{sec.patterns.map((p, i) => <button key={`${p}${i}`} className="link" data-testid={`block-pattern-${name}-${p}`} onClick={() => onPattern(p)}>{p}</button>)}</span>
              <span className="order-tools">
                <button className="mini" title="play it one time fewer" data-testid={`block-less-${name}`} disabled={sec.repeat <= 1} onClick={() => send([`song section set ${song.id} ${name} ${sec.patterns.join(' ')}${sec.repeat - 1 > 1 ? ` x${sec.repeat - 1}` : ''}`])}>−</button>
                <span data-testid={`block-repeat-${name}`}>x{sec.repeat}</span>
                <button className="mini" title="play it one time more" data-testid={`block-more-${name}`} onClick={() => send([`song section set ${song.id} ${name} ${sec.patterns.join(' ')} x${sec.repeat + 1}`])}>+</button>
                <button className={`mini${song.intro === name ? ' on' : ''}`} title="the intro: plays once, before the loop" data-testid={`block-intro-${name}`} onClick={() => send([`song intro ${song.id} ${song.intro === name ? 'none' : name}`])}>intro</button>
                <button className={`mini${song.ending === name ? ' on' : ''}`} title="the ending: plays once, at the end" data-testid={`block-ending-${name}`} onClick={() => send([`song ending ${song.id} ${song.ending === name ? 'none' : name}`])}>end</button>
              </span>
            </div>
          );
        })}
        {!spans.length && <p className="dim small">The song has no sections yet (song section add {song.id} A &lt;pattern&gt;).</p>}
      </div>
      <div className="row dim small">
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

export function PatternGrid({ song, pattern, channel, cursorStep, send, onChannel, onCursor }: GridProps) {
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
