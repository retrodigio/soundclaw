// Layout parts: a resizable edge for panels, the windowed list, and the waveform view.

import { Component, forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as RKeyEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react';

/* ───────────────────────── resizing ───────────────────────── */

/** The draggable edge of a panel: pointer drag or arrow keys resize, a double-click toggles. Sizes are clamped to [min, max]. */
export function Resizer({ side, size, min, max, onSize, onToggle, label, testId }: { side: 'left' | 'right' | 'top' | 'bottom'; size: number; min: number; max: number; onSize(v: number): void; onToggle?(): void; label: string; testId?: string }) {
  const start = useRef<{ x: number; y: number; size: number; id: number } | null>(null);
  const vertical = side === 'top' || side === 'bottom';
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v)));
  const down = (e: RPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, y: e.clientY, size, id: e.pointerId };
    e.currentTarget.dataset.active = 'true';
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    // the left panel's edge is on its right: dragging right grows it; the right panel's edge is on its left; the bottom panel's on its top
    const d = side === 'left' ? e.clientX - s.x : side === 'right' ? s.x - e.clientX : side === 'bottom' ? e.clientY - s.y : s.y - e.clientY;
    onSize(clamp(s.size + d));
  };
  const up = (e: RPointerEvent<HTMLDivElement>) => { start.current = null; delete e.currentTarget.dataset.active; };
  const key = (e: RKeyEvent<HTMLDivElement>) => {
    const grow = side === 'left' ? 'ArrowRight' : side === 'right' ? 'ArrowLeft' : side === 'bottom' ? 'ArrowDown' : 'ArrowUp';
    const shrink = side === 'left' ? 'ArrowLeft' : side === 'right' ? 'ArrowRight' : side === 'bottom' ? 'ArrowUp' : 'ArrowDown';
    const step = e.shiftKey ? 40 : 10;
    if (e.key === grow) { e.preventDefault(); onSize(clamp(size + step)); }
    else if (e.key === shrink) { e.preventDefault(); onSize(clamp(size - step)); }
    else if (e.key === 'Enter') { e.preventDefault(); onToggle?.(); }
  };
  return (
    <div className={`resizer resizer-${side}`} role="separator" aria-orientation={vertical ? 'horizontal' : 'vertical'} aria-label={label} aria-valuenow={size} aria-valuemin={min} aria-valuemax={max} tabIndex={0}
      data-testid={testId} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key} onDoubleClick={onToggle} />
  );
}

/* ───────────────────────── a part that failed ───────────────────────── */

/** A part of the page that throws while drawing shows what went wrong in its place; the rest of the dashboard keeps working. */
export class PartBoundary extends Component<{ name: string; children: ReactNode; /** A new value (the route) clears the failure. */ reset?: string }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  override componentDidCatch(error: Error) { console.error(`soundclaw: the ${this.props.name} failed`, error); }
  override componentDidUpdate(prev: { reset?: string }) { if (prev.reset !== this.props.reset && this.state.error) this.setState({ error: null }); }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="part-failed" role="alert" data-testid="part-failed" data-part={this.props.name}>
        <b>The {this.props.name} failed to draw.</b> <span className="mono">{this.state.error.message}</span>{' '}
        <button type="button" className="link-btn" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}

/* ───────────────────────── virtual list ───────────────────────── */

export interface VirtualHandle { scrollToIndex(i: number): void; element(): HTMLDivElement | null }

/** A windowed list of fixed-height rows: only the rows in view (plus a margin) exist in the DOM. Smooth at thousands of rows. */
export const VirtualList = forwardRef<VirtualHandle, {
  count: number;
  rowHeight: number;
  renderRow(i: number): ReactNode;
  label: string;
  overscan?: number;
  activeIndex?: number;
  className?: string;
  testId?: string;
  /** The role of the container: a listbox for the library. */
  role?: string;
}>(function VirtualList({ count, rowHeight, renderRow, label, overscan = 8, activeIndex, className, testId, role = 'listbox' }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, h: 400 });
  const raf = useRef(0);
  const measure = useCallback(() => {
    const el = box.current;
    if (el) setView((v) => (v.top === el.scrollTop && v.h === el.clientHeight ? v : { top: el.scrollTop, h: el.clientHeight }));
  }, []);
  useLayoutEffect(() => {
    measure();
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  const onScroll = () => { if (!raf.current) raf.current = requestAnimationFrame(() => { raf.current = 0; measure(); }); };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  useImperativeHandle(ref, () => ({
    element: () => box.current,
    scrollToIndex(i: number) {
      const el = box.current;
      if (!el) return;
      const top = i * rowHeight, bottom = top + rowHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    },
  }), [rowHeight]);
  const first = Math.max(0, Math.floor(view.top / rowHeight) - overscan);
  const last = Math.min(count, Math.ceil((view.top + view.h) / rowHeight) + overscan);
  const rows: ReactNode[] = [];
  for (let i = first; i < last; i++) rows.push(<div key={i} className="vrow" role="option" aria-selected={i === activeIndex} aria-posinset={i + 1} aria-setsize={count} style={{ top: i * rowHeight, height: rowHeight }}>{renderRow(i)}</div>);
  return (
    <div ref={box} className={`vlist${className ? ` ${className}` : ''}`} role={role} aria-label={label} data-testid={testId} data-count={count} onScroll={onScroll} tabIndex={0}>
      <div className="vlist-spacer" style={{ height: count * rowHeight }}>{rows}</div>
    </div>
  );
});

/* ───────────────────────── waveform view ───────────────────────── */

export interface WaveMarker { t: number; end?: number; kind: 'fail' | 'warn'; label: string }
export interface WavePeaks { min: ArrayLike<number>; max: ArrayLike<number> }

/** A waveform on a time axis with check markers, a cursor and a selection; every screen that shows a sound uses it. */
export function WaveView({ wave, duration, height = 120, markers = [], cursor, selection, ghost, label, testId, onSeek }: {
  wave?: WavePeaks;
  duration: number;
  height?: number;
  markers?: WaveMarker[];
  cursor?: number | null;
  selection?: { a: number; b: number } | null;
  /** A dashed outline of the waveform before a change (not drawn yet when absent). */
  ghost?: WavePeaks;
  label: string;
  testId?: string;
  onSeek?(t: number): void;
}) {
  const W = 600;
  const path = useCallback((p: WavePeaks) => {
    const n = p.max.length;
    if (!n) return '';
    const mid = height / 2;
    let top = '', bot = '';
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) / n) * W;
      top += `${i ? 'L' : 'M'}${x.toFixed(1)} ${(mid - Math.min(1, p.max[i]!) * mid).toFixed(1)}`;
      bot = `L${x.toFixed(1)} ${(mid - Math.max(-1, p.min[i]!) * mid).toFixed(1)}${bot}`;
    }
    return `${top}${bot}Z`;
  }, [height]);
  const d = wave ? path(wave) : '';
  const gd = ghost ? path(ghost) : '';
  const x = (t: number) => (duration > 0 ? Math.min(1, Math.max(0, t / duration)) * W : 0);
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onSeek || duration <= 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    onSeek(((e.clientX - r.left) / r.width) * duration);
  };
  return (
    <div className="waveview" style={{ height } as CSSProperties} onClick={seek} data-testid={testId} role="img" aria-label={`${label}${markers.length ? `; ${markers.map((m) => `${m.kind === 'fail' ? 'fails' : 'warns'} ${m.label} at ${m.t.toFixed(3)} s`).join('; ')}` : ''}`}>
      <svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" aria-hidden>
        {selection && <rect x={x(selection.a)} y="0" width={Math.max(1, x(selection.b) - x(selection.a))} height={height} className="wv-sel" />}
        {markers.map((m, i) => <rect key={i} x={x(m.t)} y="0" width={m.end !== undefined ? Math.max(2, x(m.end) - x(m.t)) : 2} height={height} className={`wv-mark wv-${m.kind}`} />)}
        {gd && <path d={gd} className="wv-ghost" />}
        {d ? <path d={d} className="wv-ink" /> : <path d={`M0 ${height / 2} H${W}`} className="wv-flat" />}
        {cursor !== null && cursor !== undefined && <rect x={x(cursor)} y="0" width="1.5" height={height} className="wv-cursor" />}
      </svg>
      {markers.map((m, i) => <span key={i} className="wv-flag" data-kind={m.kind} style={{ left: `calc(${duration > 0 ? (m.t / duration) * 100 : 0}% + 4px)`, top: 4 + (i % 3) * 20 }}><span className="mono" aria-hidden>{m.kind === 'fail' ? '×' : '!'}</span> {m.label}</span>)}
    </div>
  );
}
