// The clip grid: rows are sounds, columns are versions of each (a set's members and their last four
// distinct versions from the tape), or one column (the audition page). A cell shows a small waveform,
// its loudness against the class with a glyph, who made it and the play progress. Click plays a cell;
// ⇧- or ⌘-click picks a second one; a cell dragged onto the blind A/B card is put on it. The page owns
// the cursor, the picks and the keys; the grid draws them and reports gestures.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AuthorMark, GLYPH, WORD, authorOf, type CheckKind } from '../studio/controls.tsx';
import { lufsText } from '../studio/shellData.ts';

export interface CellModel {
  /** `<sound>@<seq>`: the cell's identity, and the key it plays under. */
  key: string;
  id: string;
  seq: number;
  /** v1…vN, agent, or current (the audition page's one column). */
  label: string;
  /** The sound and the version, as the reveal names it: `steps_2 · v3`. */
  name: string;
  current: boolean;
  proposed: boolean;
  by?: string;
  lufs: number | null | undefined;
  kind: CheckKind;
  /** The waveform drawn in the cell. */
  wave: ReactNode;
  duration?: number;
}

export interface RowModel {
  id: string;
  /** The number key that plays the row (1–9), if it has one. */
  digit: number | null;
  head: ReactNode;
  cells: (CellModel | null)[];
  attrs?: Record<string, string | undefined>;
  testId: string;
  /** Under the row: an ask box, feedback tags. */
  below?: ReactNode;
}

export interface ColumnModel { label: string; agent?: boolean; title?: string }

export interface ClipGridProps {
  cols: ColumnModel[];
  rows: RowModel[];
  /** The cell the keyboard acts on. */
  cursor: string | null;
  /** Cells picked for a comparison (at most two). */
  picked: string[];
  /** The key now sounding, and when it began (page clock) and how long it is, for the progress fill. */
  playing: string | null;
  onClick(cell: CellModel, additive: boolean): void;
  onEnter(cell: CellModel): void;
  onDrop(cell: CellModel): void;
  headWidth?: number;
  testId?: string;
  label: string;
}

/** A pointer drag from a cell: a label follows the pointer; a drop on `[data-ab-drop]` puts the cell on the A/B card. */
function useCellDrag(onDrop: (c: CellModel) => void): { start(e: React.PointerEvent, c: CellModel): void; ghost: ReactNode; dragged: () => boolean } {
  const [drag, setDrag] = useState<{ cell: CellModel; x: number; y: number; over: boolean } | null>(null);
  const moved = useRef(false);
  const start = (e: React.PointerEvent, c: CellModel) => {
    if (e.button !== 0) return;
    const x0 = e.clientX, y0 = e.clientY;
    moved.current = false;
    const move = (ev: PointerEvent) => {
      if (!moved.current && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      moved.current = true;
      const over = !!document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-ab-drop]');
      setDrag({ cell: c, x: ev.clientX, y: ev.clientY, over });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved.current && document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-ab-drop]')) onDrop(c);
      setDrag(null);
      // the click that follows a drag is not a play
      setTimeout(() => { moved.current = false; }, 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const ghost = drag ? <div className="cg-ghost mono" data-over={drag.over || undefined} style={{ left: drag.x + 12, top: drag.y + 8 }} aria-hidden>{drag.cell.label}</div> : null;
  return { start, ghost, dragged: () => moved.current };
}

function Cell({ c, cursor, picked, playing, onClick, onEnter, onPointerDown, dragged }: { c: CellModel; cursor: boolean; picked: boolean; playing: boolean; onClick(additive: boolean): void; onEnter(): void; onPointerDown(e: React.PointerEvent): void; dragged(): boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // the keyboard moved the cursor: focus follows it while the grid has focus
    if (cursor && ref.current && ref.current.closest('.cg')?.contains(document.activeElement) && document.activeElement !== ref.current) ref.current.focus();
  }, [cursor]);
  const by = c.by ? authorOf(c.by) : null;
  return (
    <button ref={ref} type="button" className="cg-cell" tabIndex={cursor ? 0 : -1}
      data-testid={`cell-${c.key}`} data-key={c.key} data-seq={c.seq} data-label={c.label} data-current={c.current} data-proposed={c.proposed || undefined} data-picked={picked || undefined} data-cursor={cursor || undefined} data-playing={playing || undefined} data-kind={c.kind}
      aria-label={`${c.name}${c.current ? ', current' : ''}${c.proposed ? ', proposed by the agent' : ''}, ${c.lufs === undefined ? 'measuring' : `${lufsText(c.lufs)} LUFS`}, loudness ${WORD[c.kind]}`}
      aria-pressed={picked}
      onPointerDown={onPointerDown}
      onClick={(e) => { if (dragged()) return; onClick(e.shiftKey || e.metaKey || e.ctrlKey); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onEnter(); }
        else if (e.key === ' ') { e.preventDefault(); onClick(false); }
      }}>
      <span className="cg-top">
        <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden className="cg-icon"><path d={playing ? 'M2 1 H5 V11 H2 Z M7 1 H10 V11 H7 Z' : 'M2 1 L11 6 L2 11 Z'} /></svg>
        <span className="mono cg-lufs">{c.lufs === undefined ? '…' : lufsText(c.lufs)}</span>
        <span className="mono cg-glyph" data-kind={c.kind} aria-hidden>{GLYPH[c.kind]}</span>
      </span>
      <span className="cg-wave">
        {playing && <span className="cg-prog" style={{ animationDuration: `${Math.max(0.05, c.duration ?? 0.5)}s` }} aria-hidden />}
        {c.wave}
      </span>
      <span className="cg-foot">
        <span className="mono cg-label">{c.label}</span>
        {c.current && c.label !== 'current' ? <span className="cg-now">{c.proposed ? 'proposed' : 'current'}</span> : <span className="cg-now" />}
        {by && <AuthorMark by={by} size={11} />}
      </span>
    </button>
  );
}

export function ClipGrid({ cols, rows, cursor, picked, playing, onClick, onEnter, onDrop, headWidth = 150, testId = 'clip-grid', label }: ClipGridProps) {
  const drag = useCellDrag(onDrop);
  const template = `${headWidth}px repeat(${cols.length}, minmax(0, 1fr))`;
  return (
    <div className="cg" role="grid" aria-label={label} data-testid={testId}>
      <div className="cg-row cg-headrow" role="row" style={{ gridTemplateColumns: template }}>
        <span className="cg-colhead" role="columnheader">Sound</span>
        {cols.map((c, i) => <span key={i} role="columnheader" className="cg-colhead" data-agent={c.agent || undefined} title={c.title} data-testid={`col-${i + 1}`}>{c.agent ? <><AuthorMark by="agent" size={12} />{c.label}</> : c.label}<span className="kbd">⇧{i + 1}</span></span>)}
      </div>
      {rows.map((r) => (
        <div key={r.id} className="cg-rowwrap" data-testid={r.testId} {...r.attrs}>
          <div className="cg-row" role="row" style={{ gridTemplateColumns: template }}>
            <div className="cg-head" role="rowheader">{r.head}</div>
            {r.cells.map((c, i) => (
              <div key={i} role="gridcell" className="cg-slot" data-agent={cols[i]?.agent || undefined}>
                {c ? <Cell c={c} cursor={cursor === c.key} picked={picked.includes(c.key)} playing={playing === c.key} onClick={(add) => onClick(c, add)} onEnter={() => onEnter(c)} onPointerDown={(e) => drag.start(e, c)} dragged={drag.dragged} /> : <span className="cg-empty" aria-label="no version">—</span>}
              </div>
            ))}
          </div>
          {r.below}
        </div>
      ))}
      {drag.ghost}
    </div>
  );
}

/** A small waveform from peaks (min and max per column), drawn as one filled path. */
export function PeaksPath({ peaks, w = 100, h = 30, className }: { peaks: { min: ArrayLike<number>; max: ArrayLike<number> } | null | undefined; w?: number; h?: number; className?: string }) {
  if (!peaks) return <span className="mini-shim cg-shim" aria-hidden />;
  const n = peaks.max.length;
  let top = 0;
  for (let i = 0; i < n; i++) top = Math.max(top, Math.abs(peaks.max[i]!), Math.abs(peaks.min[i]!));
  const k = top > 0 ? 1 / top : 1;
  let d = '', back = '';
  for (let i = 0; i < n; i++) {
    const x = ((i + 0.5) / n) * w;
    d += `${i ? 'L' : 'M'}${x.toFixed(1)} ${(h / 2 - peaks.max[i]! * k * (h / 2)).toFixed(1)}`;
    back = `L${x.toFixed(1)} ${(h / 2 - peaks.min[i]! * k * (h / 2)).toFixed(1)}${back}`;
  }
  return <svg className={className ?? 'cg-svg'} width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden><path d={`${d}${back}Z`} /></svg>;
}
