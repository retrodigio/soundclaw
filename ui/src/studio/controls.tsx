// The component set: knob, slider, fader, meter, loudness target, badge, author marks, buttons,
// segmented control, toggle, tabs, chip, keycap, tooltip, popover, toast, banner. Each is built
// once with its states and used everywhere; the hidden #/kit page shows them all.

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as RKeyEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { Close, Person, Spark } from './icons.tsx';
import { arcSpan, clampTo, formatValue, fracOf, parseValue, type ValueSpec } from './values.ts';

const MINUS = '−';

/* ───────────────────────── value controls ───────────────────────── */

export interface ValueProps {
  label: string;
  value: number;
  min: number;
  max: number;
  def: number;
  /** One arrow-key or wheel step, in the value's own unit (default: a hundredth of the range). */
  step?: number;
  bipolar?: boolean;
  spec?: ValueSpec;
  disabled?: boolean;
  /** The latest change to this parameter is the agent's and nobody has approved it: a violet arc, a dot on the rim, and a dashed ghost tick at the value before. */
  agent?: { prev?: number } | false;
  /** A drag changes a local draft; this tells the page about it (a preview). */
  onDraft?(v: number): void;
  /** The one write: at the end of a drag, or for a key, a wheel gesture, a typed value or a reset. */
  onCommit(v: number): void;
  /** ⌥-click: play the value before the agent's change, then the current one (a page preview, not a command). */
  onHearBefore?(): void;
  testId?: string;
  /** Unit sweep for the warped scale (a fader): value to 0..1, and back. */
  warp?: { to(v: number): number; from(f: number): number };
}

const DRAG_PX = 160;
const DRAG_START = 3;
const WHEEL_COMMIT_MS = 300;

/** The input rules both the knob and the slider follow. */
function useValueControl(p: ValueProps, axis: 'x' | 'y', pxFull = DRAG_PX) {
  const spec = p.spec ?? { unit: 'plain' };
  const step = p.step ?? (p.max - p.min) / 100;
  const [draft, setDraft] = useState<number | null>(null);
  const [fine, setFine] = useState(false);
  const [entry, setEntry] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean; v: number; alt: boolean } | null>(null);
  const wheel = useRef<{ v: number; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const latest = useRef(p);
  latest.current = p;
  const to = p.warp?.to ?? ((v: number) => fracOf(v, p.min, p.max));
  const from = p.warp?.from ?? ((f: number) => p.min + f * (p.max - p.min));
  const shown = draft ?? p.value;

  const commit = useCallback((v: number) => {
    const c = latest.current;
    const out = Number(clampTo(v, c.min, c.max).toFixed(6));
    setDraft(null);
    c.onCommit(out);
  }, []);

  const onPointerDown = (e: RPointerEvent<HTMLElement>) => {
    if (p.disabled || e.button !== 0) return;
    if (e.altKey && p.onHearBefore) { e.preventDefault(); p.onHearBefore(); return; }
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, v: p.value, alt: false };
    setFine(e.shiftKey);
    rootRef.current?.focus({ preventScroll: true });
  };
  const onPointerMove = (e: RPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dist = axis === 'y' ? d.y - e.clientY : e.clientX - d.x;
    if (!d.moved && Math.abs(e.clientX - d.x) < DRAG_START && Math.abs(e.clientY - d.y) < DRAG_START) return;
    if (!d.moved) { d.moved = true; setEntry(null); }
    // incremental, so Shift can be pressed or released in the middle of a drag
    const delta = (axis === 'y' ? -(e.clientY - d.y) : e.clientX - d.x);
    d.x = e.clientX; d.y = e.clientY;
    void dist;
    const f = clampTo(to(d.v) + (delta / pxFull) * (e.shiftKey ? 0.1 : 1), 0, 1);
    d.v = from(f);
    setFine(e.shiftKey);
    setDraft(d.v);
    p.onDraft?.(d.v);
  };
  const onPointerUp = (e: RPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setFine(false);
    if (d.moved) commit(d.v);
    else { setDraft(null); setEntry(formatEntry(p.value, spec)); setBad(false); }
  };
  const onDoubleClick = () => {
    if (p.disabled) return;
    setEntry(null);
    commit(p.def);
  };
  const onKeyDown = (e: RKeyEvent<HTMLElement>) => {
    if (p.disabled || entry !== null) return;
    const k = e.key;
    const s = step * (e.shiftKey ? 0.1 : 1);
    let v: number | null = null;
    if (k === 'ArrowUp' || k === 'ArrowRight') v = p.value + s;
    else if (k === 'ArrowDown' || k === 'ArrowLeft') v = p.value - s;
    else if (k === 'PageUp') v = p.value + s * 10;
    else if (k === 'PageDown') v = p.value - s * 10;
    else if (k === 'Home') v = p.min;
    else if (k === 'End') v = p.max;
    else if (k === 'Enter') { e.preventDefault(); setEntry(formatEntry(p.value, spec)); setBad(false); return; }
    else if (k === 'Escape' && drag.current) { drag.current = null; setDraft(null); return; }
    if (v === null) return;
    e.preventDefault();
    commit(v);
  };

  // the wheel steps the value; one gesture (a burst of wheel events) is one write
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const on = (e: WheelEvent) => {
      const c = latest.current;
      if (c.disabled) return;
      e.preventDefault();
      const st = (c.step ?? (c.max - c.min) / 100) * (e.shiftKey ? 0.1 : 1) * (e.deltaY < 0 || e.deltaX > 0 ? 1 : -1);
      const w = wheel.current ?? { v: c.value, timer: null };
      w.v = clampTo(w.v + st, c.min, c.max);
      wheel.current = w;
      setDraft(w.v);
      c.onDraft?.(w.v);
      if (w.timer) clearTimeout(w.timer);
      w.timer = setTimeout(() => { const v = wheel.current!.v; wheel.current = null; commit(v); }, WHEEL_COMMIT_MS);
    };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  }, [commit]);

  const apply = (text: string): boolean => {
    const v = parseValue(text, spec);
    if (v === null) { setBad(true); return false; }
    setEntry(null);
    commit(v);
    return true;
  };
  const cancel = () => { setEntry(null); rootRef.current?.focus({ preventScroll: true }); };

  return { spec, shown, draft, fine, entry, bad, rootRef, handlers: { onPointerDown, onPointerMove, onPointerUp, onDoubleClick, onKeyDown }, apply, cancel, dragging: draft !== null && drag.current !== null, setEntry };
}

/** What the typed-entry field starts with: the value without its unit word, easy to retype. */
function formatEntry(v: number, spec: ValueSpec): string {
  if (spec.custom) return spec.custom.entry ? spec.custom.entry(v) : spec.custom.show(v);
  return formatValue(v, spec).replace(/−/g, '-').replace(/ ?(kHz|Hz|dB|st|ms|s)$/, '').trim();
}

function EntryField({ ctl, spec, label, testId }: { ctl: ReturnType<typeof useValueControl>; spec: ValueSpec; label: string; testId?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); ref.current?.select(); }, []);
  return (
    <input ref={ref} className="vc-entry mono" defaultValue={ctl.entry ?? ''} aria-label={`${label} value`} aria-invalid={ctl.bad || undefined} data-testid={testId ? `${testId}-entry` : undefined}
      title={`Type a value (${unitHint(spec)}). Enter applies, Esc cancels.`}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); ctl.apply(e.currentTarget.value); } else if (e.key === 'Escape') { e.preventDefault(); ctl.cancel(); } }}
      onBlur={() => ctl.setEntry(null)} />
  );
}
const unitHint = (s: ValueSpec): string => s.custom?.hint ?? ({ s: 'e.g. 110ms or 0.11', hz: 'e.g. 1.8k or C6', pct: 'e.g. 18%', db: 'e.g. −3dB', st: 'e.g. +5st', note: 'e.g. C6', plain: 'a number, 18% or 1.8k' }[s.unit]);

const ariaOf = (p: ValueProps, shown: number, spec: ValueSpec) => ({
  role: 'slider' as const,
  'aria-label': p.label,
  'aria-valuemin': p.min,
  'aria-valuemax': p.max,
  'aria-valuenow': Number(shown.toFixed(6)),
  'aria-valuetext': `${formatValue(shown, spec)}${p.agent ? ', set by the agent' : ''}`,
  'aria-disabled': p.disabled || undefined,
  tabIndex: p.disabled ? -1 : 0,
});

const SWEEP_START = 135, SWEEP = 270;
const polar = (frac: number, r: number, c = 28): [number, number] => {
  const a = ((SWEEP_START + SWEEP * frac) * Math.PI) / 180;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
};
function arcPath(f0: number, f1: number, r: number): string {
  if (f1 - f0 < 0.002) return '';
  const [x0, y0] = polar(f0, r), [x1, y1] = polar(f1, r);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${(f1 - f0) * SWEEP > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function Knob(p: ValueProps & { size?: number; /** Force a visual state for the kit: hover, dragging (with the bubble) or focus. */ demo?: 'hover' | 'dragging' | 'focus' }) {
  const ctl = useValueControl(p, 'y');
  const frac = fracOf(ctl.shown, p.min, p.max);
  const [a0, a1] = arcSpan(frac, !!p.bipolar);
  const [nx, ny] = polar(frac, 13), [tx, ty] = polar(frac, 24);
  const ghost = p.agent && p.agent.prev !== undefined ? fracOf(p.agent.prev, p.min, p.max) : null;
  const size = p.size ?? 56;
  const by = p.agent ? 'agent' : undefined;
  return (
    <div className="knob-c vc" data-demo={p.demo} data-by={by} data-dragging={ctl.draft !== null || p.demo === 'dragging' || undefined} data-disabled={p.disabled || undefined} data-testid={p.testId ? `${p.testId}-wrap` : undefined}>
      <div ref={ctl.rootRef} className="knob-dial" style={{ width: size, height: size }} data-testid={p.testId} {...ariaOf(p, ctl.shown, ctl.spec)} {...ctl.handlers}>
        <svg width={size} height={size} viewBox="0 0 56 56" aria-hidden>
          <circle cx="28" cy="28" r="18" className="k-cap" />
          <path d={arcPath(0, 1, 24)} className="k-track" />
          <path d={arcPath(a0, a1, 24)} className="k-arc" />
          {ghost !== null && <path d={`M${polar(ghost, 20).join(' ')} L${polar(ghost, 27).join(' ')}`} className="k-ghost" data-testid={p.testId ? `${p.testId}-ghost` : undefined} />}
          <path d={`M28 28 L${nx.toFixed(2)} ${ny.toFixed(2)}`} className="k-needle" />
          {p.agent && <circle cx={tx.toFixed(2)} cy={ty.toFixed(2)} r="3" className="k-tick" data-testid={p.testId ? `${p.testId}-tick` : undefined} />}
        </svg>
        {ctl.draft !== null && <span className="bubble mono" role="status">{formatValue(ctl.shown, ctl.spec)}{ctl.fine ? ' · fine' : ''}</span>}
      </div>
      {ctl.entry !== null ? <EntryField ctl={ctl} spec={ctl.spec} label={p.label} testId={p.testId} /> : <span className="vc-val mono" data-testid={p.testId ? `${p.testId}-value` : undefined}>{p.disabled ? '—' : formatValue(ctl.shown, ctl.spec)}</span>}
      <span className="vc-label cap">{p.label}</span>
    </div>
  );
}

export function Slider(p: ValueProps) {
  const ctl = useValueControl(p, 'x', 220);
  const frac = fracOf(ctl.shown, p.min, p.max);
  const [a0, a1] = arcSpan(frac, !!p.bipolar);
  const ghost = p.agent && p.agent.prev !== undefined ? fracOf(p.agent.prev, p.min, p.max) : null;
  return (
    <div className="slider-c vc" data-by={p.agent ? 'agent' : undefined} data-dragging={ctl.draft !== null || undefined} data-disabled={p.disabled || undefined}>
      <div className="vc-head">
        <span className="vc-label2">{p.label}{p.agent ? <span className="vc-by"> · agent</span> : null}</span>
        {ctl.entry !== null ? <EntryField ctl={ctl} spec={ctl.spec} label={p.label} testId={p.testId} /> : <span className="vc-val mono" data-testid={p.testId ? `${p.testId}-value` : undefined}>{formatValue(ctl.shown, ctl.spec)}</span>}
      </div>
      <div ref={ctl.rootRef} className="sl-track" data-testid={p.testId} {...ariaOf(p, ctl.shown, ctl.spec)} aria-orientation="horizontal" {...ctl.handlers}>
        <div className="sl-rail" />
        <div className="sl-fill" style={{ left: `${a0 * 100}%`, width: `${(a1 - a0) * 100}%` }} />
        {p.bipolar && <div className="sl-center" />}
        {ghost !== null && <div className="sl-ghost" style={{ left: `${ghost * 100}%` }} data-testid={p.testId ? `${p.testId}-ghost` : undefined} />}
        <div className="sl-thumb" style={{ left: `${frac * 100}%` }} />
        {ctl.draft !== null && <span className="bubble mono" style={{ left: `${frac * 100}%` }} role="status">{formatValue(ctl.shown, ctl.spec)}{ctl.fine ? ' · fine' : ''}</span>}
      </div>
    </div>
  );
}

/* the fader's dB scale is not linear: +6 at the top, 0 near the top, −∞ at the bottom */
const DB_STOPS: [number, number][] = [[6, 1], [0, 0.8], [-6, 0.62], [-12, 0.46], [-24, 0.24], [-60, 0]];
export const dbToFrac = (db: number): number => {
  if (db >= 6) return 1;
  if (db <= -60) return 0;
  for (let i = 0; i < DB_STOPS.length - 1; i++) {
    const [d0, f0] = DB_STOPS[i]!, [d1, f1] = DB_STOPS[i + 1]!;
    if (db <= d0 && db >= d1) return f1 + ((db - d1) / (d0 - d1)) * (f0 - f1);
  }
  return 0;
};
export const fracToDb = (f: number): number => {
  if (f >= 1) return 6;
  if (f <= 0) return -60;
  for (let i = 0; i < DB_STOPS.length - 1; i++) {
    const [d0, f0] = DB_STOPS[i]!, [d1, f1] = DB_STOPS[i + 1]!;
    if (f <= f0 && f >= f1) return d1 + ((f - f1) / (f0 - f1)) * (d0 - d1);
  }
  return -60;
};

export interface MeterProps {
  /** Levels in dBFS, one per bar (static). */
  levels?: number[];
  /** Polled every animation frame, so the page never re-renders at meter rate. */
  read?: () => number[] | null;
  height?: number;
  /** Bars run left to right (the transport's master meter). */
  horizontal?: boolean;
  label?: string;
  testId?: string;
}

/** Green below −6 dBFS, amber above, red at 0 or above. */
export function Meter({ levels = [-60, -60], read, height = 160, horizontal, label = 'Level', testId }: MeterProps) {
  const bars = useRef<(HTMLDivElement | null)[]>([]);
  const [n] = useState(levels.length);
  const paint = useCallback((ls: number[]) => {
    ls.forEach((db, i) => { const b = bars.current[i]; if (b) { b.style.clipPath = horizontal ? `inset(0 ${(1 - dbToFrac(db)) * 100}% 0 0)` : `inset(${(1 - dbToFrac(db)) * 100}% 0 0 0)`; b.dataset.zone = db >= 0 ? 'hot' : db > -6 ? 'warm' : 'ok'; } });
  }, [horizontal]);
  useEffect(() => {
    if (!read) { paint(levels); return; }
    let raf = 0;
    const tick = () => { const ls = read(); if (ls) paint(ls); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [read, paint, levels]);
  const g = `linear-gradient(${horizontal ? 'to right' : 'to top'}, var(--pass) 0%, var(--pass) ${dbToFrac(-6) * 100}%, var(--warn) ${dbToFrac(-6) * 100}%, var(--warn) ${dbToFrac(0) * 100}%, var(--fail) ${dbToFrac(0) * 100}%, var(--fail) 100%)`;
  return (
    <div className={`meter${horizontal ? ' h' : ''}`} style={horizontal ? undefined : { height }} role="img" aria-label={`${label}: ${levels.map((l) => (l > -90 ? `${l.toFixed(1).replace('-', MINUS)} dBFS` : 'silent')).join(', ')}`} data-testid={testId}>
      {Array.from({ length: n }, (_, i) => <div key={i} className="meter-bar"><div ref={(el) => { bars.current[i] = el; }} className="meter-fill" style={{ background: g }} /></div>)}
    </div>
  );
}

export function Fader(p: Omit<ValueProps, 'min' | 'max' | 'warp' | 'spec' | 'bipolar'> & { meter?: MeterProps; height?: number }) {
  const full: ValueProps = { ...p, min: -60, max: 6, def: p.def ?? 0, step: p.step ?? 0.5, spec: { unit: 'db' }, warp: { to: dbToFrac, from: fracToDb } };
  const ctl = useValueControl(full, 'y', p.height ?? 160);
  const h = p.height ?? 160;
  const frac = dbToFrac(ctl.shown);
  return (
    <div className="fader-c vc" data-by={p.agent ? 'agent' : undefined} data-dragging={ctl.draft !== null || undefined} data-disabled={p.disabled || undefined}>
      <div className="fader-row" style={{ height: h }}>
        <Meter height={h} {...(p.meter ?? {})} />
        <div ref={ctl.rootRef} className="fader-track" data-testid={p.testId} {...ariaOf(full, ctl.shown, ctl.spec)} aria-orientation="vertical" {...ctl.handlers}>
          <div className="fader-rail" />
          <div className="fader-cap" style={{ bottom: `calc(${frac * 100}% - 7px)` }} />
          {ctl.draft !== null && <span className="bubble mono" style={{ bottom: `${frac * 100}%`, top: 'auto', left: '34px', transform: 'translateY(50%)' }} role="status">{formatValue(ctl.shown, ctl.spec)}</span>}
        </div>
        <div className="fader-scale mono" aria-hidden>{DB_STOPS.map(([db, f]) => <span key={db} style={{ bottom: `calc(${f * 100}% - 6px)` }}>{db === -60 ? `${MINUS}∞` : db > 0 ? `+${db}` : String(db).replace('-', MINUS)}</span>)}</div>
      </div>
      {ctl.entry !== null ? <EntryField ctl={ctl} spec={ctl.spec} label={p.label} testId={p.testId} /> : <span className="vc-val mono" data-testid={p.testId ? `${p.testId}-value` : undefined}>{formatValue(ctl.shown, ctl.spec)}</span>}
      <span className="vc-label cap">{p.label}</span>
    </div>
  );
}

/* ───────────────────────── loudness, badges, authorship ───────────────────────── */

export type CheckKind = 'pass' | 'warn' | 'fail' | 'checking';
export const GLYPH: Record<CheckKind, string> = { pass: '✓', warn: '!', fail: '×', checking: '…' };
export const WORD: Record<CheckKind, string> = { pass: 'passes', warn: 'warns', fail: 'fails', checking: 'checking' };

/** A check: glyph, word and colour together, never colour alone. */
export function Badge({ kind, children, title, testId }: { kind: CheckKind; children?: ReactNode; title?: string; testId?: string }) {
  return (
    <span className="badge" data-kind={kind} title={title} data-testid={testId} aria-label={`${WORD[kind]}${typeof children === 'string' ? `: ${children}` : ''}`}>
      <span className="mono" aria-hidden>{GLYPH[kind]}</span>{children}
    </span>
  );
}

/** The worst of the given kinds (fail, then warn, then checking, then pass). */
export const worst = (kinds: CheckKind[]): CheckKind => (kinds.includes('fail') ? 'fail' : kinds.includes('warn') ? 'warn' : kinds.includes('checking') ? 'checking' : 'pass');

export function LoudnessTarget({ value, target, tolerance = 1, min = -30, max = -6, label = 'Integrated', testId, vertical }: { value: number | null; target: number; tolerance?: number; min?: number; max?: number; label?: string; testId?: string; vertical?: boolean }) {
  const pos = (v: number) => `${clampTo(((v - min) / (max - min)) * 100, 0, 100)}%`;
  const kind: CheckKind = value === null ? 'checking' : Math.abs(value - target) <= tolerance ? 'pass' : Math.abs(value - target) <= tolerance + 2 ? 'warn' : 'fail';
  const word = value === null ? 'measuring' : kind === 'pass' ? 'on target' : value > target ? 'too loud' : 'too quiet';
  const txt = (v: number) => v.toFixed(1).replace('-', MINUS);
  const dir = vertical ? { a: 'bottom', b: 'height' } : { a: 'left', b: 'width' };
  return (
    <div className={`loud${vertical ? ' vertical' : ''}`} data-kind={kind} data-testid={testId} role="img" aria-label={`${label} loudness ${value === null ? 'not measured' : `${txt(value)} LUFS`}, target ${txt(target)} plus or minus ${tolerance}: ${word}`}>
      <div className="loud-bar">
        <div className="loud-band" style={{ [dir.a]: pos(target - tolerance), [dir.b]: `${(2 * tolerance / (max - min)) * 100}%` } as CSSProperties} />
        {value !== null && <div className="loud-fill" style={{ [dir.b]: pos(value) } as CSSProperties} />}
      </div>
      <div className="loud-scale mono"><span>{min.toString().replace('-', MINUS)}</span><span>target {txt(target)} ±{tolerance} LUFS</span><span>{max.toString().replace('-', MINUS)}</span></div>
      <div className="loud-read"><span className="mono">{value === null ? '—' : `${txt(value)} LUFS`}</span><Badge kind={kind}>{word}</Badge></div>
    </div>
  );
}

/** Agent: violet, round, spark. You: teal, square, person. */
export function AuthorMark({ by, size = 14, label }: { by: 'agent' | 'you'; size?: number; label?: boolean }) {
  return (
    <span className="author-mark" data-by={by} style={{ width: size, height: size }} title={by === 'agent' ? 'the agent' : 'you'} role="img" aria-label={by === 'agent' ? 'agent' : 'you'}>
      {by === 'agent' ? <Spark size={size - 2} color="currentColor" /> : <Person size={size - 2} color="currentColor" />}
      {label ? <span className="author-label">{by === 'agent' ? 'agent' : 'you'}</span> : null}
    </span>
  );
}
export function AuthorChip({ by, proposed, children }: { by: 'agent' | 'you'; proposed?: boolean; children?: ReactNode }) {
  return (
    <span className="author-chip" data-by={by} data-proposed={proposed || undefined}>
      {proposed ? null : by === 'agent' ? <Spark size={13} /> : <Person size={13} />}
      {children ?? (proposed ? 'proposed · not yet approved' : by === 'agent' ? 'agent' : 'you')}
    </span>
  );
}
/** A small round (agent) or square (you) dot, for lists. */
export function AuthorDot({ by }: { by: 'agent' | 'you' }) { return <span className="author-dot" data-by={by} aria-hidden />; }
export const authorOf = (by: string): 'agent' | 'you' => (by.startsWith('human:') ? 'you' : 'agent');

/* ───────────────────────── buttons and small controls ───────────────────────── */

export type ButtonKind = 'primary' | 'secondary' | 'agent' | 'quiet' | 'danger' | 'warn';
export function Button({ kind = 'secondary', icon, children, onClick, disabled, title, type = 'button', testId, pressed, className }: { kind?: ButtonKind; icon?: ReactNode; children?: ReactNode; onClick?(e: React.MouseEvent<HTMLButtonElement>): void; disabled?: boolean; title?: string; type?: 'button' | 'submit'; testId?: string; pressed?: boolean; className?: string }) {
  return <button type={type} className={`btn btn-${kind}${className ? ` ${className}` : ''}`} onClick={onClick} disabled={disabled} title={title} data-testid={testId} aria-pressed={pressed}>{icon}{children}</button>;
}
export function IconButton({ label, children, onClick, disabled, kind = 'secondary', pressed, testId, shortcut }: { label: string; children: ReactNode; onClick?(): void; disabled?: boolean; kind?: 'primary' | 'secondary' | 'quiet'; pressed?: boolean; testId?: string; shortcut?: string }) {
  return <button type="button" className={`ib ib-${kind}`} aria-label={shortcut ? `${label} (${shortcut})` : label} title={shortcut ? `${label} (${shortcut})` : label} onClick={onClick} disabled={disabled} aria-pressed={pressed} data-testid={testId}>{children}</button>;
}

export function Segmented<T extends string>({ value, options, onChange, label, testId }: { value: T; options: { value: T; label: ReactNode; testId?: string }[]; onChange(v: T): void; label: string; testId?: string }) {
  const onKey = (e: RKeyEvent<HTMLDivElement>) => {
    const i = options.findIndex((o) => o.value === value);
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (d) { e.preventDefault(); onChange(options[(i + d + options.length) % options.length]!.value); }
  };
  return (
    <div className="seg" role="radiogroup" aria-label={label} onKeyDown={onKey} data-testid={testId}>
      {options.map((o) => <button key={o.value} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1} data-testid={o.testId} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

export function Toggle({ checked, onChange, label, testId, disabled }: { checked: boolean; onChange(v: boolean): void; label: string; testId?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="toggle-c" disabled={disabled} data-testid={testId} onClick={() => onChange(!checked)}>
      <span className="toggle-knob" /><span className="toggle-label">{label}</span>
    </button>
  );
}

/** Solo / mute style letter buttons. */
export function LetterToggle({ letter, on, onChange, label, tone = 'warn' }: { letter: string; on: boolean; onChange(v: boolean): void; label: string; tone?: 'warn' | 'fail' }) {
  return <button type="button" className="letter" data-tone={tone} aria-pressed={on} aria-label={label} title={label} onClick={() => onChange(!on)}>{letter}</button>;
}

export function Tabs<T extends string>({ value, tabs, onChange, label, testId, idBase }: { value: T; tabs: { value: T; label: ReactNode; count?: number | string; testId?: string }[]; onChange(v: T): void; label: string; testId?: string; idBase?: string }) {
  const base = useId();
  const id = idBase ?? base;
  const onKey = (e: RKeyEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.value === value);
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (d) { e.preventDefault(); onChange(tabs[(i + d + tabs.length) % tabs.length]!.value); }
  };
  return (
    <div className="tabs-c" role="tablist" aria-label={label} onKeyDown={onKey} data-testid={testId}>
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" id={`${id}-${t.value}`} aria-selected={t.value === value} tabIndex={t.value === value ? 0 : -1} data-testid={t.testId} onClick={() => onChange(t.value)}>
          {t.label}{t.count !== undefined && <span className="mono tab-n">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Chip({ children, on, onClick, tone, onRemove, title, testId }: { children: ReactNode; on?: boolean; onClick?(): void; tone?: 'ember' | 'agent' | 'you'; onRemove?(): void; title?: string; testId?: string }) {
  const cls = `chip-c${on ? ' on' : ''}${tone ? ` tone-${tone}` : ''}`;
  if (!onClick) return <span className={cls} title={title} data-testid={testId}>{children}{onRemove && <button type="button" className="chip-x" aria-label="Remove" onClick={onRemove}><Close size={8} /></button>}</span>;
  return <button type="button" className={cls} aria-pressed={on} title={title} onClick={onClick} data-testid={testId}>{children}</button>;
}

/** A shortcut keycap. */
export function Kbd({ children }: { children: ReactNode }) { return <kbd className="kbd">{children}</kbd>; }

/** Keys for display: ⌘K, ⌥1, ⇧⌘Z. */
export function Keys({ combo }: { combo: string }) { return <>{combo.split(' ').map((c, i) => <Kbd key={i}>{c}</Kbd>)}</>; }

/** A label that shows on hover and focus, with the shortcut. */
export function Tooltip({ text, shortcut, children }: { text: string; shortcut?: string; children: ReactNode }) {
  const id = useId();
  return (
    <span className="tip-wrap" aria-describedby={id}>
      {children}
      <span className="tip" role="tooltip" id={id}>{text}{shortcut && <kbd className="kbd">{shortcut}</kbd>}</span>
    </span>
  );
}

/** A box anchored below its trigger; Esc and outside clicks close it, focus goes back to the trigger. */
export function Popover({ open, onClose, trigger, children, label, align = 'start' }: { open: boolean; onClose(): void; trigger: ReactNode; children: ReactNode; label: string; align?: 'start' | 'end' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); (ref.current?.querySelector('[data-popover-trigger] button, [data-popover-trigger]') as HTMLElement | null)?.focus(); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key, true); };
  }, [open, onClose]);
  return (
    <div className="popover-wrap" ref={ref}>
      <span data-popover-trigger>{trigger}</span>
      {open && <div className="popover" role="dialog" aria-label={label} data-align={align}>{children}</div>}
    </div>
  );
}

/* toasts are polite and never take focus */
export interface ToastItem { id: number; text: string; kind: 'info' | 'warn' | 'error' }
const ToastCtx = createContext<(text: string, kind?: ToastItem['kind']) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);
export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, kind: ToastItem['kind'] = 'info') => {
    const id = ++seq.current;
    setItems((xs) => [...xs.slice(-3), { id, text, kind }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 4500);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false" data-testid="toasts">
        {items.map((t) => <div key={t.id} className="toast" data-kind={t.kind} role="status">{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

export function Banner({ kind = 'info', title, children, actions, testId }: { kind?: 'info' | 'warn' | 'error'; title?: ReactNode; children?: ReactNode; actions?: ReactNode; testId?: string }) {
  return (
    <div className="banner-c" data-kind={kind} role={kind === 'info' ? 'status' : 'alert'} data-testid={testId}>
      <span className="banner-glyph mono" aria-hidden>{kind === 'info' ? 'i' : '!'}</span>
      <div className="banner-body">{title && <b>{title}</b>}{children && <div className="banner-text">{children}</div>}</div>
      {actions && <div className="banner-actions">{actions}</div>}
    </div>
  );
}
