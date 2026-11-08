// The analysis lenses: five views of one sound on one time axis (waveform with loudness, mel
// spectrogram, pitch track, compare, numbers). The cursor, the selection and the zoom live in the
// panel, so they stay put when the lens changes. The data comes from the measuring worker (the same
// measuring code the CLI uses); the numbers strip under the lens is always there. Flags are the
// failing checks' ranges as markers: a click jumps to one and loops it.

import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { noteName, peaks, midiName, type Sound } from '@soundclaw/core';
import type { LensReply } from '../render.worker.ts';
import type { Store } from '../store.ts';
import { Badge, LoudnessTarget, Tabs, type CheckKind } from '../studio/controls.tsx';
import { useActions, type Action } from '../studio/registry.ts';
import { specLut } from '../studio/specColor.ts';
import { usePrefs } from '../studio/prefs.ts';
import { agentSet, type Provenance } from './provenance.ts';

export type LensId = 'wave' | 'spec' | 'pitch' | 'compare' | 'nums' | 'layers';
export const LENSES: { id: LensId; name: string; key: string; title: string; hint: string }[] = [
  { id: 'wave', name: 'Waveform', key: '1', title: 'Waveform', hint: 'drag to select · ⇧-drag extends · ⌥-scroll zooms time · ⇧-scroll zooms level' },
  { id: 'spec', name: 'Spectrogram', key: '2', title: 'Mel spectrogram', hint: 'hover for note, Hz and dB · brightness is level' },
  { id: 'pitch', name: 'Pitch', key: '3', title: 'Pitch track', hint: 'over a note grid · gaps where the sound has no pitch' },
  { id: 'compare', name: 'Compare', key: '4', title: 'Difference spectrogram', hint: 'now minus the version you pick' },
  { id: 'nums', name: 'Numbers', key: '5', title: 'Numbers', hint: 'every value the checks and the agent use' },
];

const LAYERS_META = { id: 'layers' as LensId, name: 'Layers', key: '6', title: 'Sum by layer', hint: 'hover a band to hear that layer alone · click to select it' };

/** What the layered editor adds: each layer's share of the sum over time, as stacked bands. */
export interface LayersLens {
  strips: { min: number[]; max: number[] }[] | null;
  names: string[];
  selected: number;
  hover: number | null;
  onSelect(n: number): void;
  onHover(n: number | null): void;
}

/** The stacked bands: each layer's absolute level per column on top of the ones before, and a way to find the band under a point. */
export function stackBands(strips: { min: number[]; max: number[] }[]): { n: number; cum: Float32Array[]; scale: number } {
  const n = strips[0]?.max.length ?? 0;
  const cum: Float32Array[] = [];
  let prev = new Float32Array(n);
  for (const s of strips) {
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) c[i] = prev[i]! + Math.max(Math.abs(s.max[i]!), Math.abs(s.min[i]!));
    cum.push(c);
    prev = c;
  }
  const top = cum.length ? Math.max(...cum[cum.length - 1]!) : 0;
  return { n, cum, scale: 0.46 / Math.max(top, 0.3) };
}
/** The layer (1-based) whose band holds the point (a column, and a height from the centre line in 0..0.5 of the box), or null. */
export function bandAt(st: ReturnType<typeof stackBands>, col: number, fromCentre: number): number | null {
  if (!st.n) return null;
  const c = clamp(col, 0, st.n - 1);
  const d = fromCentre / st.scale;
  for (let j = 0; j < st.cum.length; j++) if (d <= st.cum[j]![c]! + 1e-9) return j + 1;
  return null;
}

/** The cursor, selection and zoom that every lens shares. */
export interface Axis {
  cursor: number | null;
  sel: { a: number; b: number } | null;
  /** The visible window of the time axis (seconds). */
  t0: number;
  t1: number;
  /** Waveform level zoom (1 = full scale). */
  level: number;
}

export const fmtT = (t: number): string => t.toFixed(3);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export interface Flag { id: string; kind: 'fail' | 'warn'; name: string; from: number; to: number; label: string }

/** A note with its long numbers rounded: "starts at level 0.7213" reads "starts at level 0.72". */
export const roundNumbers = (t: string): string => t.replace(/-?\d+\.\d{3,}/g, (m) => String(Number(Number(m).toFixed(m.length > 7 ? 1 : 2))));

/**
 * Markers that fall within `gap` pixels of one another become one cluster (a marker "× 3 checks" with a list).
 * `x` is a flag's position in pixels; the flags are taken in time order.
 */
export function clusterFlags(flags: Flag[], x: (f: Flag) => number, gap = 24): Flag[][] {
  const sorted = [...flags].sort((a, b) => a.from - b.from);
  const out: Flag[][] = [];
  for (const f of sorted) {
    const last = out[out.length - 1];
    if (last && x(f) - x(last[last.length - 1]!) < gap) last.push(f);
    else out.push([f]);
  }
  return out;
}

/** The failing checks' ranges as markers. */
export function flagsOf(data: LensReply | null): Flag[] {
  if (!data) return [];
  const out: Flag[] = [];
  for (const c of data.checks) {
    if (c.pass) continue;
    c.ranges.forEach((r, i) => out.push({ id: `${c.name}-${i}`, kind: 'fail', name: c.name, from: r.from, to: r.to, label: `${c.name} ${r.from.toFixed(3)} s${r.note ? ` · ${roundNumbers(r.note)}` : ''}` }));
  }
  return out;
}

/** How the numbers read, shared by the strip, the cards and the tests (the same rounding `soundclaw measure --json` prints). */
export const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

// ---- the panel -------------------------------------------------------------------------------------------

export interface LensPanelProps {
  store: Store;
  sound: Sound;
  /** Samples of the sound with a draft applied (the classic editor's drag): the waveform lens draws these in place of the worker's peaks. */
  live?: Float32Array | null;
  height?: number | 'fill';
  prov?: Provenance;
  /** Told whenever the cursor, selection or zoom change. */
  onAxis?(a: Axis): void;
  /** The dashed outline: the sound before the agent's latest change. */
  outline?: Sound | null;
  /** The sound the Compare lens starts against (the version before the latest group). */
  previous?: Sound | null;
  /** Where the page lives, to show next to the command that prints the same numbers. */
  idBase?: string;
  /** Keep the keyboard actions (1–5, L) to this panel. Off when two panels share a page. */
  keys?: boolean;
  /** The layered editor's sum-by-layer view, as one more lens (6). */
  layersLens?: LayersLens | undefined;
}

export function LensPanel({ store, sound, live, height = 300, prov, outline, previous, keys = true, onAxis, layersLens }: LensPanelProps) {
  const id = sound.id;
  const data = store.lens(sound);
  const duration = data?.duration ?? 0;
  const [lens, setLens] = useState<LensId>(layersLens ? 'layers' : 'wave');
  const bands = useMemo(() => (layersLens?.strips ? stackBands(layersLens.strips) : null), [layersLens?.strips]);
  const [specHover, setSpecHover] = useState<{ t: number; fy: number; px: number; py: number } | null>(null);
  const [axis, setAxis] = useState<Axis>({ cursor: null, sel: null, t0: 0, t1: 0, level: 1 });
  // the window follows the sound's length until the person zooms
  const t0 = axis.t0, t1 = axis.t1 > axis.t0 ? axis.t1 : duration;
  const view = { t0, t1: t1 || 1 };
  const set = (p: Partial<Axis>) => setAxis((a) => ({ ...a, ...p }));

  useEffect(() => { onAxis?.(axis); }, [axis]); // eslint-disable-line react-hooks/exhaustive-deps
  const flags = useMemo(() => flagsOf(data), [data]);
  const loopRegion = (a: number, b: number) => { void store.playRegion(id, a, b); };

  const jumpToFlag = (f: Flag) => {
    const a = Math.max(0, f.from - 0.03), b = Math.min(duration || f.to + 0.03, Math.max(f.to, f.from + 0.01) + 0.03);
    set({ cursor: f.from, sel: { a, b } });
    loopRegion(a, b);
  };

  const actions: Action[] = keys ? [
    ...(layersLens ? [{ id: 'lens.layers', label: 'Lens: Layers (sum by layer)', group: 'Analysis', shortcut: '6', key: '6', run: () => setLens('layers'), keywords: 'view stacked bands' }] : []),
    ...LENSES.map((l) => ({ id: `lens.${l.id}`, label: `Lens: ${l.name}`, group: 'Analysis', shortcut: l.key, key: l.key, run: () => setLens(l.id), keywords: 'view analysis waveform spectrogram pitch compare numbers' })),
    { id: 'transport.loop', label: 'Play the focused item looping (the selection, if there is one)', group: 'Transport', shortcut: 'L', key: 'l', override: true, run: () => { if (axis.sel) loopRegion(axis.sel.a, axis.sel.b); else void store.playLoop(id); } },
  ] : [];
  useActions(actions);

  const lensMeta = lens === 'layers' ? LAYERS_META : LENSES.find((l) => l.id === lens)!;
  const readout = `cursor ${axis.cursor === null ? '—' : `${fmtT(axis.cursor)} s`} · selection ${axis.sel ? `${fmtT(axis.sel.a)}–${fmtT(axis.sel.b)} s` : '—'}`;

  return (
    <section className={`lens${height !== 'fill' && height <= 260 ? ' compact' : ''}`} data-testid="lens-panel" data-lens={lens} aria-label="Analysis lenses">
      <div className="lens-head">
        <Tabs<LensId> value={lens} onChange={setLens} label="Lens" testId="lens-tabs" idBase="lens"
          tabs={[...(layersLens ? [LAYERS_META] : []), ...LENSES].map((l) => ({ value: l.id, testId: `lens-tab-${l.id}`, label: <>{l.name}<kbd className="kbd">{l.key}</kbd></> }))} />
        <span className="cap lens-title">{lensMeta.title}</span>
        <span className="lens-hint">{lensMeta.hint}</span>
        <span className="spacer" />
        <span className="mono lens-readout" data-testid="lens-readout" data-cursor={axis.cursor ?? ''} data-sel={axis.sel ? `${axis.sel.a},${axis.sel.b}` : ''}>{readout}</span>
        {axis.sel && <button type="button" className="link-btn" data-testid="lens-clear" onClick={() => set({ sel: null })}>clear selection</button>}
        {(axis.t1 > axis.t0 && (t0 > 0 || (duration && t1 < duration - 1e-6))) && <button type="button" className="link-btn" data-testid="lens-zoom-reset" onClick={() => set({ t0: 0, t1: 0, level: 1 })}>reset zoom</button>}
      </div>

      <div className={`lens-body${height === 'fill' ? ' fill' : ''}`} style={height === 'fill' ? undefined : { height }} data-testid="lens-body">
        {!data ? <div className="lens-wait" data-testid="lens-measuring">measuring…</div> : (
          <>
            {lens === 'layers' && layersLens && <LayersView data={data} view={view} lens={layersLens} bands={bands} />}
            {lens === 'wave' && <WaveLens data={data} view={view} axis={axis} live={live} outline={outline ? store.lensOutline(outline) : null} />}
            {lens === 'spec' && <SpecLens data={data} view={view} hover={specHover} />}
            {lens === 'pitch' && <PitchLens data={data} view={view} />}
            {lens === 'compare' && <CompareLens store={store} sound={sound} data={data} previous={previous ?? null} view={view} />}
            {lens === 'nums' && <NumbersLens data={data} store={store} sound={sound} />}
            {lens !== 'nums' && <Surface store={store} id={id} view={view} duration={duration} axis={axis} set={set} flags={flags} onFlag={jumpToFlag} lens={lens} data={data} onPick={lens === 'layers' && layersLens ? (kind, t, fy) => { const col = bands ? Math.floor((t / duration) * bands.n) : 0; const l = bands ? bandAt(bands, col, Math.abs(fy - 0.5)) : null; if (kind === 'click') { if (l) layersLens.onSelect(l); } else if (l !== layersLens.hover) layersLens.onHover(l); } : lens === 'spec' ? (kind, t, fy, px, py) => { if (kind === 'move') setSpecHover(t < 0 ? null : { t, fy, px, py }); } : undefined} />}
          </>
        )}
      </div>
      <TimeRuler view={view} duration={duration} />
      <NumbersStrip store={store} sound={sound} data={data} prov={prov} />
    </section>
  );
}

// ---- the shared surface: pointer gestures, cursor, selection, playhead, flags ---------------------------------------------

function Surface({ store, id, view, duration, axis, set, flags, onFlag, lens, data, onPick }: { store: Store; id: string; view: { t0: number; t1: number }; duration: number; axis: Axis; set(p: Partial<Axis>): void; flags: Flag[]; onFlag(f: Flag): void; lens: LensId; data: LensReply; onPick?: ((kind: 'click' | 'move', t: number, fy: number, px: number, py: number) => void) | undefined }) {
  const box = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; t: number; moved: boolean; extend: boolean; base: { a: number; b: number } | null } | null>(null);
  const [width, setWidth] = useState(800);
  const [openCluster, setOpenCluster] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(1, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(1, el.clientWidth));
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (openCluster === null) return;
    const off = () => setOpenCluster(null);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') off(); };
    window.addEventListener('pointerdown', off);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', off); window.removeEventListener('keydown', key); };
  }, [openCluster]);
  const span = view.t1 - view.t0;
  const pct = (t: number): number => ((t - view.t0) / (span || 1)) * 100;
  const clusters = useMemo(() => clusterFlags(flags, (f) => ((f.from - view.t0) / ((view.t1 - view.t0) || 1)) * width), [flags, view.t0, view.t1, width]);
  const timeAt = (clientX: number): number => {
    const r = box.current!.getBoundingClientRect();
    return clamp(view.t0 + ((clientX - r.left) / Math.max(1, r.width)) * span, 0, duration);
  };

  // the playhead: read from the player's clock each frame and moved directly, so React is not updated at frame rate
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = head.current;
      if (el) {
        const key = store.playing === `${id}#loop` ? `${id}#loop` : store.playing === id ? id : store.playing === `${id}#A` ? `${id}#A` : null;
        const pos = key ? store.playPosition(key) : null;
        if (pos === null) el.style.display = 'none';
        else { el.style.display = 'block'; el.style.left = `${((pos - view.t0) / ((view.t1 - view.t0) || 1)) * 100}%`; }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [store, id, view.t0, view.t1]);

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, t: timeAt(e.clientX), moved: false, extend: e.shiftKey && !!axis.sel, base: axis.sel };
  };
  const fyAt = (clientY: number): number => { const r = box.current!.getBoundingClientRect(); return (clientY - r.top) / Math.max(1, r.height); };
  const local = (e: { clientX: number; clientY: number }): [number, number] => { const r = box.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) { onPick?.('move', timeAt(e.clientX), fyAt(e.clientY), ...local(e)); return; }
    if (!d.moved && Math.abs(e.clientX - d.x) < 3) return;
    d.moved = true;
    const t = timeAt(e.clientX);
    if (d.extend && d.base) set({ sel: { a: Math.min(d.base.a, t, d.t), b: Math.max(d.base.b, t, d.t) } });
    else set({ sel: { a: Math.min(d.t, t), b: Math.max(d.t, t) } });
  };
  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) { set({ cursor: timeAt(e.clientX) }); onPick?.('click', timeAt(e.clientX), fyAt(e.clientY), ...local(e)); }
  };

  // ⌥-scroll zooms the time axis around the pointer, ⇧-scroll the level; a plain scroll pans a zoomed view
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const on = (e: WheelEvent) => {
      const dy = e.deltaY || e.deltaX;
      if (e.altKey) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const f = clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1);
        const at = view.t0 + f * (view.t1 - view.t0);
        const k = dy < 0 ? 0.8 : 1.25;
        const s = clamp((view.t1 - view.t0) * k, Math.max(0.005, duration / 64), duration);
        const a = clamp(at - f * s, 0, Math.max(0, duration - s));
        set({ t0: a, t1: a + s });
      } else if (e.shiftKey && lens === 'wave') {
        e.preventDefault();
        set({ level: clamp(axis.level * (dy < 0 ? 1.25 : 0.8), 1, 16) });
      } else if (view.t1 - view.t0 < duration - 1e-6) {
        e.preventDefault();
        const s = view.t1 - view.t0;
        const a = clamp(view.t0 + (dy / 600) * s, 0, Math.max(0, duration - s));
        set({ t0: a, t1: a + s });
      }
    };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  });
  void data;

  return (
    <div ref={box} className="lens-surface" data-testid="lens-surface" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => onPick?.('move', -1, 9, 0, 0)} onDoubleClick={() => set({ sel: null })} role="application" aria-label="Time axis: drag to select a region">
      {axis.sel && <div className="lens-sel" data-testid="lens-sel" style={{ left: `${pct(axis.sel.a)}%`, width: `${Math.max(0.15, pct(axis.sel.b) - pct(axis.sel.a))}%` }} />}
      {axis.cursor !== null && <div className="lens-cursor" data-testid="lens-cursor" style={{ left: `${pct(axis.cursor)}%` }} />}
      <div ref={head} className="lens-playhead" data-testid="lens-playhead" style={{ display: 'none' }} />
      {flags.map((f) => (
        <span key={f.id} className="lens-flagband" data-kind={f.kind} style={{ left: `${pct(f.from)}%`, width: `${Math.max(0.2, pct(f.to) - pct(f.from))}%` }} />
      ))}
      {clusters.map((c, i) => {
        const f = c[0]!;
        const top = 6 + (i % 3) * 22;
        if (c.length === 1) {
          return (
            <button key={f.id} type="button" className="lens-flag" data-kind={f.kind} data-testid={`flag-${f.id}`} data-from={f.from} data-to={f.to} style={{ left: `calc(${pct(f.from)}% + 3px)`, top }} title={`${f.label}: jump here and loop it`}
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onFlag(f); }}>
              <span className="mono" aria-hidden>×</span> {f.label} <span className="lens-flag-hint">click to loop</span>
            </button>
          );
        }
        return (
          <span key={`c${i}`} className="lens-flag-wrap" style={{ left: `calc(${pct(f.from)}% + 3px)`, top }}>
            <button type="button" className="lens-flag" data-kind={f.kind} data-testid={`flag-cluster-${i}`} aria-haspopup="menu" aria-expanded={openCluster === i} title={c.map((g) => g.label).join('\n')}
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setOpenCluster(openCluster === i ? null : i); }}>
              <span className="mono" aria-hidden>×</span> {c.length} checks
            </button>
            {openCluster === i && (
              <div className="flag-pop" role="menu" data-testid={`flag-pop-${i}`} onPointerDown={(e) => e.stopPropagation()}>
                {c.map((g) => (
                  <button key={g.id} type="button" role="menuitem" className="flag-row" data-testid={`flag-${g.id}`} data-from={g.from} data-to={g.to} onClick={(e) => { e.stopPropagation(); setOpenCluster(null); onFlag(g); }}>
                    <span className="mono" aria-hidden>×</span><span>{g.label}</span><span className="lens-flag-hint">click to loop</span>
                  </button>
                ))}
              </div>
            )}
          </span>
        );
      })}
    </div>
  );
}

// ---- time ruler ---------------------------------------------------------------------------------------------

function TimeRuler({ view, duration }: { view: { t0: number; t1: number }; duration: number }) {
  const span = view.t1 - view.t0;
  if (!(span > 0) || !duration) return <div className="lens-ruler mono" />;
  const raw = span / 7;
  const step = [0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30].find((s) => s >= raw) ?? 60;
  const ticks: number[] = [];
  for (let t = Math.ceil(view.t0 / step) * step; t <= view.t1 + 1e-9; t += step) ticks.push(Number(t.toFixed(4)));
  return (
    <div className="lens-ruler mono" data-testid="lens-ruler" aria-hidden>
      {ticks.map((t) => <span key={t} style={{ left: `${((t - view.t0) / span) * 100}%` }}>{t.toFixed(step < 0.1 ? 3 : step < 1 ? 2 : 1)}{t + step > view.t1 ? ' s' : ''}</span>)}
    </div>
  );
}

// ---- sum by layer ----------------------------------------------------------------------------------------

function LayersView({ data, view, lens, bands }: { data: LensReply; view: { t0: number; t1: number }; lens: LayersLens; bands: ReturnType<typeof stackBands> | null }) {
  const dur = data.duration;
  const paths = useMemo(() => {
    if (!bands || !bands.n) return [];
    const out: string[] = [];
    const mid = H / 2;
    const xs: number[] = [];
    for (let i = 0; i < bands.n; i++) xs.push((((i + 0.5) / bands.n) * dur - view.t0) / (view.t1 - view.t0) * W);
    const from = Math.max(0, xs.findIndex((x) => x >= -4) - 1);
    let to = xs.findIndex((x) => x > W + 4);
    to = to < 0 ? bands.n : to + 1;
    bands.cum.forEach((c, j) => {
      const lo = j === 0 ? null : bands.cum[j - 1]!;
      let up = '', dn = '';
      const upB: string[] = [], dnB: string[] = [];
      for (let i = from; i < to; i++) {
        up += `${up ? 'L' : 'M'}${xs[i]!.toFixed(1)} ${(mid - c[i]! * bands.scale * H).toFixed(1)}`;
        dn += `${dn ? 'L' : 'M'}${xs[i]!.toFixed(1)} ${(mid + c[i]! * bands.scale * H).toFixed(1)}`;
        upB.push(`L${xs[i]!.toFixed(1)} ${(mid - (lo ? lo[i]! : 0) * bands.scale * H).toFixed(1)}`);
        dnB.push(`L${xs[i]!.toFixed(1)} ${(mid + (lo ? lo[i]! : 0) * bands.scale * H).toFixed(1)}`);
      }
      out.push(`${up}${upB.reverse().join('')}Z ${dn}${dnB.reverse().join('')}Z`);
    });
    return out;
  }, [bands, view.t0, view.t1, dur]);
  return (
    <div className="lens-canvas" data-testid="lens-layers" data-bands={paths.length}>
      <svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        <line x1="0" y1={H / 2} x2={W} y2={H / 2} className="lz-axis" />
        {paths.map((d, j) => <path key={j} d={d} className="lz-band" data-testid={`band-${j + 1}`} style={{ fill: `var(--layer-${(j % 8) + 1})`, fillOpacity: lens.hover !== null && lens.hover !== j + 1 ? 0.25 : lens.selected === j + 1 ? 1 : 0.8 }} />)}
      </svg>
      <div className="lz-bandkey" aria-label="Layer colours">
        {lens.names.map((n, j) => <span key={j} className={lens.selected === j + 1 ? 'on' : ''}><i style={{ background: `var(--layer-${(j % 8) + 1})` }} aria-hidden />{n}</span>)}
      </div>
      {!lens.strips && <span className="lens-empty-note">measuring the layers…</span>}
    </div>
  );
}

// ---- waveform with loudness ----------------------------------------------------------------------------------

const W = 1000, H = 400;

function WaveLens({ data, view, axis, live, outline }: { data: LensReply; view: { t0: number; t1: number }; axis: Axis; live?: Float32Array | null; outline: { min: ArrayLike<number>; max: ArrayLike<number>; duration: number } | null }) {
  const dur = data.duration;
  const pk = useMemo(() => {
    if (live && live.length) {
      // a draft the person is dragging: the waveform follows it (peaks of the visible part, on the page)
      const a = Math.floor((view.t0 / dur) * live.length), b = Math.ceil((view.t1 / dur) * live.length);
      const p = peaks(live.subarray(a, Math.max(a + 1, b)), 900);
      return { min: p.min, max: p.max, t0: view.t0, t1: view.t1 };
    }
    return { min: data.peaks.min, max: data.peaks.max, t0: 0, t1: dur };
  }, [live, data, view.t0, view.t1, dur]);
  // the peaks are indexed over [pk.t0, pk.t1]
  const path = useMemo(() => {
    const span = pk.t1 - pk.t0;
    const n = pk.max.length;
    if (!n || !span) return '';
    const mid = H / 2;
    let top = '', bot = '';
    for (let i = 0; i < n; i++) {
      const t = pk.t0 + ((i + 0.5) / n) * span;
      if (t < view.t0 - span / n || t > view.t1 + span / n) continue;
      const x = ((t - view.t0) / (view.t1 - view.t0)) * W;
      top += `${top ? 'L' : 'M'}${x.toFixed(1)} ${(mid - clamp(pk.max[i]! * axis.level, -1, 1) * mid).toFixed(1)}`;
      bot = `L${x.toFixed(1)} ${(mid - clamp(pk.min[i]! * axis.level, -1, 1) * mid).toFixed(1)}${bot}`;
    }
    return top ? `${top}${bot}Z` : '';
  }, [pk, view.t0, view.t1, axis.level]);
  const ghost = useMemo(() => {
    if (!outline) return '';
    // the earlier waveform's envelope, upper and lower, as two thin dashed lines (a run of the loudest peaks, smoothed)
    const n = outline.max.length;
    if (!n) return '';
    const amp = new Float32Array(n);
    const w = Math.max(1, Math.round(n / 120));
    for (let i = 0; i < n; i++) { let m = 0; for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) m = Math.max(m, Math.abs(outline.max[j]!), Math.abs(outline.min[j]!)); amp[i] = m; }
    const sm = new Float32Array(n);
    for (let i = 0; i < n; i++) { let s2 = 0, c = 0; for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) { s2 += amp[j]!; c++; } sm[i] = s2 / c; }
    let up = '', dn = '';
    for (let i = 0; i < n; i++) {
      const t = ((i + 0.5) / n) * outline.duration;
      const x = ((t - view.t0) / (view.t1 - view.t0)) * W;
      if (x < -5 || x > W + 5) continue;
      const a2 = clamp(sm[i]! * axis.level, 0, 1) * (H / 2);
      up += `${up ? 'L' : 'M'}${x.toFixed(1)} ${(H / 2 - a2).toFixed(1)}`;
      dn += `${dn ? 'L' : 'M'}${x.toFixed(1)} ${(H / 2 + a2).toFixed(1)}`;
    }
    return `${up} ${dn}`;
  }, [outline, view.t0, view.t1, axis.level]);
  // loudness over time: −48 … −6 LUFS from the bottom to the top
  const loud = useMemo(() => {
    let s = '';
    data.loud.t.forEach((t, i) => {
      if (t < view.t0 - 0.05 || t > view.t1 + 0.05) return;
      const x = ((t - view.t0) / (view.t1 - view.t0)) * W;
      const y = H - clamp((data.loud.lufs[i]! + 48) / 42, 0, 1) * (H - 30) - 12;
      s += `${s ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    });
    return s;
  }, [data, view.t0, view.t1]);
  return (
    <div className="lens-canvas" data-testid="lens-wave" data-live={live ? 'true' : undefined}>
      <svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        <line x1="0" y1={H / 2} x2={W} y2={H / 2} className="lz-axis" />
        <line x1="0" y1={H * 0.15} x2={W} y2={H * 0.15} className="lz-grid" /><line x1="0" y1={H * 0.85} x2={W} y2={H * 0.85} className="lz-grid" />
        <path d={path} className="lz-wave" data-testid="lens-wave-path" />
        {ghost && <path d={ghost} className="lz-ghost" data-testid="lens-outline" />}
        <path d={loud} className="lz-loud" data-testid="lens-loud-path" />
      </svg>
      <span className="mono lz-tag" style={{ left: 8, top: 8 }}>0 dBFS{axis.level > 1 ? ` · level ×${axis.level.toFixed(1)}` : ''}</span>
      <span className="lz-legend lz-legend-ember"><svg width="16" height="4" aria-hidden><line x1="0" y1="2" x2="16" y2="2" className="lz-loud-key" /></svg>loudness, 400 ms windows (−48 … −6 LUFS)</span>
      {outline && <span className="lz-legend lz-legend-agent"><svg width="16" height="6" aria-hidden><line x1="0" y1="3" x2="16" y2="3" className="lz-ghost-key" /></svg>before the agent's last change</span>}
    </div>
  );
}

// ---- spectrogram ----------------------------------------------------------------------------------------------

const HZ_TICKS = [125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const NOTE_TICKS: number[] = [];
for (let oct = 2; oct <= 8; oct++) NOTE_TICKS.push(440 * 2 ** ((12 * (oct + 1) - 69) / 12)); // the C of each octave

/** The fractional band index of a frequency (bands are mel-spaced; the list is increasing). */
export function bandOf(freqs: ArrayLike<number>, hz: number): number {
  const n = freqs.length;
  if (hz <= freqs[0]!) return 0;
  if (hz >= freqs[n - 1]!) return n - 1;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (freqs[m]! <= hz) lo = m; else hi = m; }
  return lo + (hz - freqs[lo]!) / (freqs[hi]! - freqs[lo]!);
}

function useBitmap(w: number, h: number, paint: (img: ImageData) => void, deps: unknown[]): HTMLCanvasElement | null {
  return useMemo(() => {
    if (!w || !h) return null;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    const img = g.createImageData(w, h);
    paint(img);
    g.putImageData(img, 0, 0);
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** A canvas as large as its box, redrawn by `draw` whenever the box or the inputs change. */
function Fit({ draw, deps, testId, className }: { draw(g: CanvasRenderingContext2D, w: number, h: number): void; deps: unknown[]; testId?: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(1, Math.round(el.clientWidth)), h: Math.max(1, Math.round(el.clientHeight)) }));
    ro.observe(el);
    setSize({ w: Math.max(1, Math.round(el.clientWidth)), h: Math.max(1, Math.round(el.clientHeight)) });
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const c = ref.current;
    const g = c?.getContext('2d');
    if (!c || !g || !size.w) return;
    g.clearRect(0, 0, size.w, size.h);
    draw(g, size.w, size.h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, ...deps]);
  return <canvas ref={ref} className={className} width={size.w} height={size.h} data-testid={testId} aria-hidden />;
}

function SpecLens({ data, view, hover: at }: { data: LensReply; view: { t0: number; t1: number }; hover: { t: number; fy: number; px: number; py: number } | null }) {
  const { theme } = usePrefs();
  const { w, h, data: bytes } = data.spec;
  const bmp = useBitmap(w, h, (img) => {
    const lut = specLut({ floor: 0.3, gamma: 1.7 });
    for (let f = 0; f < w; f++) for (let k = 0; k < h; k++) {
      const v = bytes[f * h + k]! * 3;
      const o = ((h - 1 - k) * w + f) * 4;
      img.data[o] = lut[v]!; img.data[o + 1] = lut[v + 1]!; img.data[o + 2] = lut[v + 2]!; img.data[o + 3] = 255;
    }
  }, [data, theme]);
  const dur = data.duration;
  const hover = at && at.fy >= 0 && at.fy <= 1 ? (() => {
    const k = clamp(Math.round((1 - at.fy) * h - 0.5), 0, h - 1);
    const f = clamp(Math.floor((at.t / dur) * w), 0, w - 1);
    const hz = data.spec.freqs[k]!;
    const db = data.spec.maxDb - 80 + (bytes[f * h + k]! / 255) * 80;
    return { x: at.px, y: at.py, text: `${noteName(hz)} · ${hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${hz.toFixed(0)} Hz`} · ${db.toFixed(0).replace('-', '−')} dB · ${at.t.toFixed(3)} s` };
  })() : null;
  return (
    <div className="lens-canvas" data-testid="lens-spec" data-frames={w} data-bands={h}>
      <Fit className="lz-fill" testId="lens-spec-canvas" deps={[bmp, view.t0, view.t1]} draw={(g, cw, ch) => {
        if (!bmp) return;
        g.imageSmoothingEnabled = true;
        g.drawImage(bmp, (view.t0 / dur) * w, 0, ((view.t1 - view.t0) / dur) * w, h, 0, 0, cw, ch);
      }} />
      <div className="lz-notes mono" aria-hidden>
        {NOTE_TICKS.map((hz) => <span key={hz} style={{ bottom: `${((bandOf(data.spec.freqs, hz) + 0.5) / h) * 100}%` }}>{noteName(hz)}</span>)}
      </div>
      <div className="lz-hz mono" aria-hidden>
        {HZ_TICKS.filter((hz) => hz <= data.spec.freqs[h - 1]!).map((hz) => <span key={hz} style={{ bottom: `${((bandOf(data.spec.freqs, hz) + 0.5) / h) * 100}%` }}>{hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`}</span>)}
      </div>
      {hover && <div className="lz-hover mono" data-testid="spec-readout" style={{ left: Math.min(hover.x + 12, 9999), top: hover.y + 12 }}>{hover.text}</div>}
    </div>
  );
}

// ---- pitch ---------------------------------------------------------------------------------------------------

function PitchLens({ data, view }: { data: LensReply; view: { t0: number; t1: number } }) {
  const dur = data.duration;
  const voiced = data.pitch.filter((p) => p.hz !== null && p.clarity >= 0.5);
  const a = data.analysis.pitch;
  if (!voiced.length || a.min === null || a.max === null) {
    return <div className="lens-canvas lens-empty" data-testid="lens-pitch" data-voiced="0"><p>No pitch found: the sound is noise-like, or too short to track.</p></div>;
  }
  const midis = voiced.map((p) => 69 + 12 * Math.log2(p.hz! / 440));
  const lo = Math.floor(Math.min(...midis)) - 2, hi = Math.ceil(Math.max(...midis)) + 2;
  const mid = (lo + hi) / 2;
  const lo2 = Math.min(lo, Math.round(mid - 6)), hi2 = Math.max(hi, Math.round(mid + 6));
  const rows = hi2 - lo2;
  const y = (m: number): number => ((hi2 - m) / rows) * H;
  const segs: string[] = [];
  let cur = '';
  let prevT = -1;
  for (const p of data.pitch) {
    const ok = p.hz !== null && p.clarity >= 0.5;
    if (!ok || (prevT >= 0 && p.t - prevT > 0.06)) { if (cur) segs.push(cur); cur = ''; }
    if (ok) {
      const x = ((p.t - view.t0) / (view.t1 - view.t0)) * W;
      cur += `${cur ? 'L' : 'M'}${x.toFixed(1)} ${y(69 + 12 * Math.log2(p.hz! / 440)).toFixed(1)}`;
      prevT = p.t;
    }
  }
  if (cur) segs.push(cur);
  const black = (m: number): boolean => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
  const first = voiced[0]!, last = voiced[voiced.length - 1]!;
  const st = 12 * Math.log2(last.hz! / first.hz!);
  const summary = Math.abs(st) < 0.5 ? `holds ${noteName(first.hz!)} for ${(last.t - first.t).toFixed(2)} s` : `${st < 0 ? 'falls' : 'rises'} ${noteName(first.hz!)} → ${noteName(last.hz!)} in ${(last.t - first.t).toFixed(2)} s, ≈ ${st < 0 ? '−' : '+'}${Math.abs(Math.round(st))} st`;
  void dur;
  return (
    <div className="lens-canvas" data-testid="lens-pitch" data-voiced={voiced.length}>
      <svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        {Array.from({ length: rows }, (_, i) => hi2 - i - 1).map((m) => <rect key={m} x="0" y={y(m + 1)} width={W} height={H / rows} className={black(m) ? 'lz-key-black' : 'lz-key-white'} />)}
        {segs.map((d, i) => <path key={i} d={d} className="lz-pitch" data-testid="lens-pitch-seg" />)}
      </svg>
      <div className="lz-grid-notes mono" aria-hidden>
        {Array.from({ length: rows }, (_, i) => hi2 - i - 1).map((m) => !black(m) && <span key={m} style={{ top: `${(y(m + 1) / H) * 100}%`, height: `${100 / rows}%` }}>{midiName(m)}</span>)}
      </div>
      <span className="lz-summary" data-testid="pitch-summary">{summary}</span>
    </div>
  );
}

// ---- compare -------------------------------------------------------------------------------------------------

function CompareLens({ store, sound, data, previous, view }: { store: Store; sound: Sound; data: LensReply; previous: Sound | null; view: { t0: number; t1: number } }) {
  const [against, setAgainst] = useState<string>('previous');
  const others = store.index.filter((s) => s.id !== sound.id);
  const [other, setOther] = useState<string>('');
  const ref: Sound | null = against === 'previous' ? previous : (other ? store.doc(other) ?? null : null);
  const diff = ref ? store.lensDiff(sound, ref) : null;
  const cw = diff?.w ?? 0, ch = diff?.h ?? 0;
  const bmp = useBitmap(cw, ch, (img) => {
    const cs = getComputedStyle(document.documentElement);
    const rgb = (n: string): number[] => { const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d')!; g.fillStyle = cs.getPropertyValue(n).trim() || '#000'; g.fillRect(0, 0, 1, 1); return Array.from(g.getImageData(0, 0, 1, 1).data); };
    const warm = rgb('--ember'), cool = rgb('--cool');
    for (let f = 0; f < cw; f++) for (let k = 0; k < ch; k++) {
      const v = diff!.data[f * ch + k]! / 127;
      const o = ((ch - 1 - k) * cw + f) * 4;
      const col = v >= 0 ? warm : cool;
      img.data[o] = col[0]!; img.data[o + 1] = col[1]!; img.data[o + 2] = col[2]!;
      img.data[o + 3] = Math.round(255 * Math.min(1, Math.max(0, (Math.abs(v) - 0.1) / 0.8)) ** 1.3); // under 3 dB of difference is nothing
    }
  }, [diff, usePrefs().theme]);
  const dur = diff?.duration ?? data.duration;
  return (
    <div className="lens-canvas lens-compare" data-testid="lens-compare">
      <div className="lc-bar">
        <span className="lc-label">Against</span>
        <button type="button" className="lc-pick" aria-pressed={against === 'previous'} disabled={!previous} data-testid="compare-previous" onClick={() => setAgainst('previous')}>{previous ? `${sound.id} · the version before the latest change` : 'no earlier version'}</button>
        <span className="lc-or">or</span>
        <select className="lc-select" data-testid="compare-other" value={other} aria-label="Compare against another sound" onChange={(e) => { setOther(e.target.value); setAgainst(e.target.value ? 'other' : 'previous'); }}>
          <option value="">another sound…</option>
          {others.map((o) => <option key={o.id} value={o.id}>{o.id}</option>)}
        </select>
        <span className="spacer" />
        <span className="lc-key"><i className="sw-warm" aria-hidden />louder now</span>
        <span className="lc-key"><i className="sw-cool" aria-hidden />quieter now</span>
      </div>
      <div className="lc-plot">
        {!ref && <p className="lens-empty-note" data-testid="compare-none">{against === 'previous' ? 'This sound has no earlier version on the tape. Pick another sound to compare with.' : 'Loading…'}</p>}
        {ref && !diff && <p className="lens-empty-note" data-testid="compare-measuring">measuring…</p>}
        {diff && (
          <Fit className="lz-fill" testId="lens-compare-canvas" deps={[bmp, view.t0, view.t1]} draw={(g, w, h) => {
            if (!bmp) return;
            g.drawImage(bmp, (view.t0 / dur) * cw, 0, ((view.t1 - view.t0) / dur) * cw, ch, 0, 0, w, h);
          }} />
        )}
      </div>
      {diff && <div className="lc-summary" data-testid="compare-summary">{diff.summary}</div>}
    </div>
  );
}

// ---- numbers -------------------------------------------------------------------------------------------------

export interface NumberCard { key: string; label: string; value: string; raw: number | string; note: string; kind?: CheckKind }

/** The cards of the Numbers lens: the values `soundclaw measure --json` prints, rounded the way it rounds them. */
export function numberCards(data: LensReply, store: Store, sound: Sound): NumberCard[] {
  const a = data.analysis;
  const rule = store.rule(sound);
  const check = (n: string): CheckKind | undefined => { const c = data.checks.find((x) => x.name === n); return c ? (c.pass ? 'pass' : 'fail') : undefined; };
  const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1).replace('-', '−') : '−∞');
  const mom = Math.max(...data.loud.lufs);
  const momAt = data.loud.t[data.loud.lufs.indexOf(mom)] ?? 0;
  const hz = (v: number | null): string => (v === null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${v.toFixed(0)} Hz`);
  const p = a.pitch;
  return [
    { key: 'lufs', label: 'Integrated', value: `${f1(a.lufs)} LUFS`, raw: r4(a.lufs), note: `target ${rule.target.toFixed(0).replace('-', '−')} ±${rule.tolerance} (${rule.basis})`, kind: check('loudness') },
    { key: 'momentary', label: 'Loudest 400 ms', value: `${f1(mom)} LUFS`, raw: r4(mom), note: `at ${momAt.toFixed(2)} s` },
    { key: 'truePeakDb', label: 'True peak', value: `${f1(a.truePeakDb)} dBTP`, raw: r4(a.truePeakDb), note: `ceiling ${store.style.truePeakMax} dBTP`, kind: check('clip') },
    { key: 'crestDb', label: 'Crest factor', value: `${f1(a.crestDb)} dB`, raw: r4(a.crestDb), note: 'peak to RMS' },
    { key: 'attack', label: 'Attack', value: `${(a.attack * 1000).toFixed(0)} ms`, raw: r4(a.attack), note: 'onset to −3 dB of peak' },
    { key: 'tail', label: 'Tail −60 dB', value: `${a.tail.toFixed(2)} s`, raw: r4(a.tail), note: 'loud part to −60 dB', kind: check('tail') },
    { key: 'centroid', label: 'Spectral centroid', value: hz(a.centroid.mean), raw: r4(a.centroid.mean), note: `${hz(a.centroid.start)} → ${hz(a.centroid.end)}` },
    { key: 'pitch', label: 'Pitch', value: p.start === null ? '—' : p.end !== null && Math.abs(12 * Math.log2(p.end / p.start)) >= 0.5 ? `${noteName(p.start)} → ${noteName(p.end)}` : noteName(p.start), raw: r4(p.start ?? NaN), note: p.start === null ? 'not pitched' : `${hz(p.start)}${p.rangeSemitones ? ` · range ${p.rangeSemitones.toFixed(0)} st` : ''}` },
    { key: 'dc', label: 'DC offset', value: a.dc.toFixed(4), raw: r4(a.dc), note: 'mean sample value', kind: check('dc') },
    { key: 'onsets', label: 'Onsets', value: String(a.onsets), raw: a.onsets, note: a.onsets === 1 ? 'single hit' : `${a.onsets} onsets` },
  ];
}

function NumbersLens({ data, store, sound }: { data: LensReply; store: Store; sound: Sound }) {
  const cards = numberCards(data, store, sound);
  return (
    <div className="lens-numbers" data-testid="lens-nums">
      {cards.map((c) => (
        <div key={c.key} className="num-card" data-kind={c.kind} data-testid={`num-${c.key}`} data-value={String(c.raw)}>
          <span className="cap">{c.label}</span>
          <span className="mono num-v">{c.value}</span>
          <span className="num-n">{c.kind && <Badge kind={c.kind}>{''}</Badge>} {c.note}</span>
        </div>
      ))}
    </div>
  );
}

// ---- the numbers strip -----------------------------------------------------------------------------------------

function NumbersStrip({ store, sound, data, prov }: { store: Store; sound: Sound; data: LensReply | null; prov?: Provenance }): ReactNode {
  const a = data?.analysis;
  const rule = store.rule(sound);
  const check = (n: string): CheckKind => { const c = data?.checks.find((x) => x.name === n); return !data ? 'checking' : !c ? 'pass' : c.pass ? 'pass' : 'fail'; };
  const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1).replace('-', '−') : '−∞');
  const items: { key: string; label: string; value: string; note: string; kind?: CheckKind }[] = a ? [
    { key: 'truePeakDb', label: 'True peak', value: `${f1(a.truePeakDb)} dBTP`, note: `ceiling ${store.style.truePeakMax}`, kind: check('clip') },
    { key: 'crestDb', label: 'Crest', value: `${f1(a.crestDb)} dB`, note: 'peak to RMS' },
    { key: 'attack', label: 'Attack', value: `${(a.attack * 1000).toFixed(0)} ms`, note: 'to −3 dB' },
    { key: 'tail', label: 'Tail', value: `${a.tail.toFixed(2)} s`, note: 'to −60 dB', kind: check('tail') },
    { key: 'centroid', label: 'Centroid', value: a.centroid.mean >= 1000 ? `${(a.centroid.mean / 1000).toFixed(1)} kHz` : `${a.centroid.mean.toFixed(0)} Hz`, note: 'mean' },
    { key: 'onsets', label: 'Onsets', value: String(a.onsets), note: a.onsets === 1 ? 'single hit' : 'hits' },
  ] : [];
  void prov;
  return (
    <div className="lens-strip" data-testid="numbers-strip">
      <div className="strip-loud">
        <LoudnessTarget value={a && Number.isFinite(a.lufs) ? a.lufs : null} target={rule.target} tolerance={rule.tolerance} testId="nstrip-loudness" />
      </div>
      {items.map((n) => (
        <div key={n.key} className="strip-card" data-kind={n.kind} data-testid={`nstrip-${n.key}`}>
          <span className="cap">{n.label}</span>
          <span className="mono strip-v">{n.value}</span>
          <span className="nstrip-note">{n.kind && <Badge kind={n.kind}>{''}</Badge>}{n.note}</span>
        </div>
      ))}
      {!a && <span className="dim strip-wait">measuring…</span>}
    </div>
  );
}

export { agentSet };
