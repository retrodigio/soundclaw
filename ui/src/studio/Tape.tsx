// The history tape as a timeline: one mark for each command, agent marks round and violet, yours square and teal. A group
// of several commands (one batch, one undo) is a labelled span over its marks. The strip pans (drag, or scroll sideways)
// and zooms (⌘/Ctrl + wheel, or the buttons); hovering a mark lists its group's commands; a click plays the focused item
// as it was after that group (a replay in the page's worker; nothing is written). "Undo batch" is the existing undo.
// The bottom panel's History tab uses the same component, filtered to the focused item.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { activeGroups, groupsOf, type TapeEntry } from '@soundclaw/core';
import type { Store } from '../store.ts';
import { Button, Kbd } from './controls.tsx';
import { ago } from './shellData.ts';
import { useNow } from '../Listening.tsx';

const MIN_ZOOM = 6;
const MAX_ZOOM = 48;
const PAD = 24;

/** The ids a tape entry names are matched as words (a song's `demo` also finds `demo_lead`), so `beep` does not pick up `beeper`. */
export function mentions(cmd: string, id: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9-])`).test(cmd);
}

interface Mark { e: TapeEntry; i: number; human: boolean }

export function Tape({ store, filter = null, preview = null, height = 96, compact = false, testId = 'tape' }: { store: Store; filter?: string | null; preview?: string | null; height?: number; compact?: boolean; testId?: string }) {
  const now = useNow(15_000);
  const scroller = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(16);
  const [view, setView] = useState({ left: 0, width: 800 });
  const [hover, setHover] = useState<{ group: string; x: number } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const stick = useRef(true);

  const entries = useMemo(() => (filter ? store.tape.filter((e) => mentions(e.cmd, filter) || /^(undo|redo)\b/.test(e.cmd)) : store.tape), [store.tape, filter]);
  const groups = useMemo(() => groupsOf(entries), [entries]);
  const active = useMemo(() => activeGroups(store.tape), [store.tape]);
  const marks: Mark[] = useMemo(() => entries.map((e, i) => ({ e, i, human: e.by.startsWith('human:') })), [entries]);
  const width = PAD * 2 + marks.length * zoom;

  // the strip starts at "now" (the right end) and stays there while new commands land, until the person pans away
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (stick.current) el.scrollLeft = el.scrollWidth;
    setView({ left: el.scrollLeft, width: el.clientWidth });
  }, [width]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView({ left: el.scrollLeft, width: el.clientWidth }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scroller.current!;
    stick.current = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4;
    setView({ left: el.scrollLeft, width: el.clientWidth });
  };
  const zoomBy = (f: number) => setZoom((z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z * f))));
  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.25 : 0.8); }
  };
  // drag to pan
  const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null);
  const onDown = (e: React.PointerEvent) => { if ((e.target as HTMLElement).closest('button')) return; drag.current = { x: e.clientX, left: scroller.current!.scrollLeft, moved: false }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); };
  const onMove = (e: React.PointerEvent) => { const d = drag.current; if (!d) return; if (Math.abs(e.clientX - d.x) > 3) d.moved = true; scroller.current!.scrollLeft = d.left - (e.clientX - d.x); };
  const onUp = () => { drag.current = null; };

  const lo = Math.max(0, Math.floor((view.left - PAD) / zoom) - 4), hi = Math.min(marks.length, Math.ceil((view.left + view.width) / zoom) + 4);
  const visible = marks.slice(lo, hi);

  const target = (group: string): string | null => {
    // the item a click plays: the one asked for, else the group's first sound
    if (preview) return preview;
    const sel = store.index.map((x) => x.id);
    for (const e of groups.get(group) ?? []) for (const t of e.cmd.split(/\s+/).slice(1, 4)) if (sel.includes(t)) return t;
    return null;
  };
  const pick = async (group: string): Promise<void> => {
    const es = store.tape.filter((e) => e.group === group);
    const last = es.at(-1);
    const id = target(group);
    setPicked(group);
    if (!last || !id) { setNote('That group did not touch a sound to play.'); return; }
    const r = await store.previewAt(id, last.seq);
    setNote(r.ok ? `Playing ${id} as it was after ${group} (#${last.seq}). Nothing is written.` : (r.error ?? 'could not play'));
  };

  const hovered = hover ? groups.get(hover.group) ?? [] : [];
  const spans = [...groups.entries()].filter(([, es]) => es.length > 1);
  const mid = Math.round(height / 2);
  const lastAgent = [...store.tape].reverse().find((e) => !/^(undo|redo)\b/.test(e.cmd));

  return (
    <div className={`tape${compact ? ' compact' : ''}`} data-testid={testId} data-marks={marks.length}>
      <div className="tape-head">
        <span className="tape-legend"><span className="tape-key round" />agent</span>
        <span className="tape-legend"><span className="tape-key square" />you</span>
        <span className="dim small tape-count" data-testid="tape-count">{marks.length} command{marks.length === 1 ? '' : 's'} in {groups.size} group{groups.size === 1 ? '' : 's'}{filter ? ` for ${filter}` : ''}</span>
        <span className="grow" />
        <button type="button" className="tape-zoom" aria-label="Zoom out" data-testid="tape-zoom-out" onClick={() => zoomBy(0.8)}>{'−'}</button>
        <button type="button" className="tape-zoom" aria-label="Zoom in" data-testid="tape-zoom-in" onClick={() => zoomBy(1.25)}>+</button>
        <Button onClick={() => void store.undo()} disabled={!store.canUndo()} testId="tape-undo" title={lastAgent ? `Undo the latest group (${lastAgent.group})` : 'Nothing to undo'}>Undo batch <Kbd>{'⌘'} Z</Kbd></Button>
      </div>
      <div className="tape-body" style={{ height }}>
        <div ref={scroller} className="tape-scroll" data-testid={`${testId}-scroll`} onScroll={onScroll} onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} data-zoom={zoom}>
          <div className="tape-inner" style={{ width, height }}>
            <span className="tape-axis" style={{ top: mid }} />
            {spans.map(([g, es]) => {
              const first = marks.findIndex((m) => m.e.group === g);
              if (first < 0 || first + es.length < lo || first > hi) return null;
              const human = es[0]!.by.startsWith('human:');
              // the label fits the span: the long form, a short one, the count, or nothing (the full text is the tooltip)
              const w = Math.max(8, es.length * zoom - 2);
              const label = w >= 124 ? `batch · ${es.length} commands` : w >= 50 ? `${es.length} cmds` : w >= 18 ? String(es.length) : '';
              return (
                <button key={g} type="button" className={`tape-span${active.has(g) ? '' : ' undone'}${picked === g ? ' picked' : ''}`} data-by={human ? 'you' : 'agent'} data-group={g} data-testid={`tape-span-${g}`}
                  style={{ left: PAD + first * zoom, width: w, top: 6 }} onClick={() => void pick(g)}
                  onMouseEnter={() => setHover({ group: g, x: PAD + first * zoom })} onMouseLeave={() => setHover(null)} aria-label={`${g}: batch of ${es.length} commands by ${es[0]!.by}`} title={`${g}: batch of ${es.length} commands by ${es[0]!.by}`}>
                  <span className="tape-span-label" data-testid={`tape-span-label-${g}`}>{label}</span>
                </button>
              );
            })}
            {visible.map(({ e, i, human }) => (
              <button key={e.seq} type="button" className={`tape-mark ${human ? 'square' : 'round'}${active.has(e.group) ? '' : ' undone'}${picked === e.group ? ' picked' : ''}`} data-by={human ? 'you' : 'agent'} data-group={e.group} data-seq={e.seq} data-testid="tape-mark"
                style={{ left: PAD + i * zoom + Math.max(0, zoom / 2 - 4.5), top: human ? mid + 4 : mid - 13 }}
                onClick={() => void pick(e.group)} onMouseEnter={() => setHover({ group: e.group, x: PAD + i * zoom })} onMouseLeave={() => setHover(null)} onFocus={() => setHover({ group: e.group, x: PAD + i * zoom })} onBlur={() => setHover(null)}
                aria-label={`${human ? 'you' : 'agent'} ${e.group} #${e.seq}: ${e.cmd}`} />
            ))}
            {!compact && visible.filter(({ e, i }) => e.at && (i === 0 || (i % Math.max(1, Math.round(110 / zoom)) === 0))).map(({ e, i }) => (
              <span key={`t${e.seq}`} className="tape-tick mono" style={{ left: PAD + i * zoom, top: mid + 22 }}>{(e.at ?? '').slice(11, 16)}</span>
            ))}
            <span className="tape-now" style={{ left: width - PAD / 2 }}><span className="mono">now</span></span>
          </div>
        </div>
        {hover && hovered.length > 0 && (
          <div className="tape-tip" data-testid="tape-tip" style={{ left: Math.max(4, Math.min(hover.x - view.left, view.width - 300)) }} role="tooltip">
            <div className="tape-tip-head"><b>{hover.group}</b> <span className="dim">{hovered[0]!.by}{hovered[0]!.at ? ` · ${ago(hovered[0]!.at, now)}` : ''}</span></div>
            {hovered.slice(0, 8).map((e) => <div key={e.seq} className="mono tape-tip-cmd">{e.cmd}</div>)}
            {hovered.length > 8 && <div className="dim small">… {hovered.length - 8} more</div>}
            <div className="dim small">click to hear {preview ?? 'the item'} as it was after this</div>
          </div>
        )}
      </div>
      <div className="tape-note small dim" role="status" aria-live="polite" data-testid="tape-note">{note ?? 'Click a mark to hear the item as it was after that group. Drag to pan; ⌘-scroll to zoom.'}</div>
    </div>
  );
}
