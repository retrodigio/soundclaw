// The lenses of one sample on one time axis: waveform, spectrogram, pitch, loop (the seam) and compare, with handles over the time axis for trimming,
// the loop points and the slice markers. A handle moves while it is dragged and writes one command when it is let go.

import { useEffect, useRef, useState } from 'react';
import type { SampleInfo } from '@soundclaw/server/protocol';
import type { DiffReply } from '../render.worker.ts';
import { Fit, PitchLens, Surface, SpecLens, TimeRuler, WaveLens, fmtT, useBitmap, type Axis } from '../sound/Lenses.tsx';
import type { Store } from '../store.ts';
import { Tabs } from '../studio/controls.tsx';
import { usePrefs } from '../studio/prefs.ts';
import { useActions, type Action } from '../studio/registry.ts';
import type { SampleLensReply, SeamReply } from './sample.worker.ts';
import { sampleWorker } from './sampleWorker.ts';

export type LensTab = 'wave' | 'spec' | 'pitch' | 'loop' | 'compare';
export type Tool = 'select' | 'trim' | 'loop' | 'slice';

export const SAMPLE_LENSES: { id: LensTab; name: string; key: string; title: string; hint: string }[] = [
  { id: 'wave', name: 'Waveform', key: '1', title: 'Waveform', hint: 'drag to select · ⌥-scroll zooms time · ⇧-scroll zooms level' },
  { id: 'spec', name: 'Spectrogram', key: '2', title: 'Mel spectrogram', hint: 'hover for note, Hz and dB' },
  { id: 'pitch', name: 'Pitch', key: '3', title: 'Pitch track', hint: 'over a note grid · gaps where the sample has no pitch' },
  { id: 'loop', name: 'Loop', key: '4', title: 'Loop seam', hint: 'the end of the loop joined to its start' },
  { id: 'compare', name: 'Compare', key: '5', title: 'Difference spectrogram', hint: 'this sample minus the one you pick' },
];

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// ---- a handle ------------------------------------------------------------------------------------------------------------

export interface HandleProps {
  t: number;
  view: { t0: number; t1: number };
  min: number;
  max: number;
  label: string;
  tone: 'trim' | 'loop' | 'slice';
  testId: string;
  selected?: boolean;
  /** Seconds one arrow key moves it. */
  step: number;
  onMove(t: number): void;
  onCommit(t: number): void;
  onDelete?(): void;
  onFocusHandle?(): void;
}

/** A vertical handle on the time axis: drag it, or focus it and use the arrow keys (Enter writes the change). Its box is the lens surface. */
export function TimeHandle({ t, view, min, max, label, tone, testId, selected, step, onMove, onCommit, onDelete, onFocusHandle }: HandleProps) {
  const drag = useRef(false);
  const last = useRef(t);
  const span = view.t1 - view.t0 || 1;
  const at = (clientX: number, el: HTMLElement): number => {
    const r = el.parentElement!.getBoundingClientRect();
    return clamp(view.t0 + ((clientX - r.left) / Math.max(1, r.width)) * span, min, max);
  };
  const pct = ((t - view.t0) / span) * 100;
  if (pct < -1 || pct > 101) return null;
  // a handle at either edge keeps its grip inside the surface (which clips what sticks out), so it can still be pressed
  const edge = pct > 98 ? 'end' : pct < 2 ? 'start' : undefined;
  return (
    <div className={`smp-handle${selected ? ' sel' : ''}`} data-tone={tone} data-edge={edge} data-testid={testId} style={{ left: `${Math.min(100, Math.max(0, pct))}%` }} role="slider" tabIndex={0}
      aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={Number(t.toFixed(4))} aria-valuetext={`${t.toFixed(3)} seconds`}
      onFocus={onFocusHandle}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = true; onFocusHandle?.(); }}
      onPointerMove={(e) => { if (!drag.current) return; last.current = at(e.clientX, e.currentTarget); onMove(last.current); }}
      onPointerUp={(e) => { if (!drag.current) return; drag.current = false; const v = at(e.clientX, e.currentTarget); last.current = v; onCommit(v); }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault(); e.stopPropagation();
          const v = clamp(t + (e.key === 'ArrowRight' ? 1 : -1) * step * (e.shiftKey ? 10 : 1), min, max);
          last.current = v; onMove(v);
        } else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onCommit(last.current === t ? t : last.current); }
        else if ((e.key === 'Delete' || e.key === 'Backspace') && onDelete) { e.preventDefault(); e.stopPropagation(); onDelete(); }
      }}>
      <span className="smp-handle-line" aria-hidden />
      <span className="smp-handle-tag mono" aria-hidden>{label} {fmtT(t)}</span>
    </div>
  );
}

// ---- the loop seam -------------------------------------------------------------------------------------------------------

function SeamLens({ seam, error, hasLoop }: { seam: SeamReply | null; error: string | null; hasLoop: boolean }) {
  if (!hasLoop) return <div className="lens-canvas lens-empty" data-testid="lens-loop" data-has-loop="0"><p>This sample has no loop. Use the Loop tool to set one, or Find loop to let SoundClaw look for the best seam.</p></div>;
  if (error) return <div className="lens-canvas lens-empty" data-testid="lens-loop"><p role="alert">{error}</p></div>;
  if (!seam) return <div className="lens-wait" data-testid="lens-loop-measuring">measuring the seam…</div>;
  const W = 800, H = 240, mid = H / 2;
  const n = seam.max.length;
  let top = '', bot = '';
  for (let i = 0; i < n; i++) {
    const x = ((i + 0.5) / n) * W;
    top += `${i ? 'L' : 'M'}${x.toFixed(1)} ${(mid - clamp(seam.max[i]!, -1, 1) * mid).toFixed(1)}`;
    bot = `L${x.toFixed(1)} ${(mid - clamp(seam.min[i]!, -1, 1) * mid).toFixed(1)}${bot}`;
  }
  const cutX = (seam.cut / n) * W;
  const num = seam.numbers;
  return (
    <div className="lens-canvas" data-testid="lens-loop" data-has-loop="1" data-click={num.clickDb.toFixed(1)}>
      <svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        <line x1="0" y1={mid} x2={W} y2={mid} className="lz-axis" />
        <path d={`${top}${bot}Z`} className="lz-wave" />
        <line x1={cutX} y1="0" x2={cutX} y2={H} className="smp-seam-line" />
      </svg>
      <span className="mono lz-tag" style={{ left: 8, top: 8 }}>{(seam.side * 1000).toFixed(0)} ms before the loop end</span>
      <span className="mono lz-tag" style={{ right: 8, top: 8 }}>{(seam.side * 1000).toFixed(0)} ms from the loop start</span>
      <div className="smp-seam-numbers mono" data-testid="seam-numbers">
        <span>click {num.clickDb.toFixed(1)} dB</span><span>level step {num.levelStepDb.toFixed(1)} dB</span><span>spectral jump {num.spectralJump.toFixed(2)}</span>
      </div>
    </div>
  );
}

// ---- compare -------------------------------------------------------------------------------------------------------------

function CompareLens({ store, info, view, duration }: { store: Store; info: SampleInfo; view: { t0: number; t1: number }; duration: number }) {
  const [other, setOther] = useState('');
  const [diff, setDiff] = useState<DiffReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const theme = usePrefs().theme;
  const samples = store.samples.filter((x) => x.name !== info.name);
  const sounds = store.index;
  useEffect(() => {
    setDiff(null); setError(null);
    if (!other) return;
    let live = true;
    const done = (d: DiffReply) => { if (live) setDiff(d); };
    const fail = (e: Error) => { if (live) setError(e.message); };
    if (other.startsWith('sample:')) {
      const x = store.samples.find((s) => s.name === other.slice(7));
      if (x) void sampleWorker.diff(store.token, info.sha256, { hash: x.sha256 }).then(done, fail);
    } else {
      void store.renderMono(other.slice(6)).then((mono) => sampleWorker.diff(store.token, info.sha256, { mono })).then(done, fail);
    }
    return () => { live = false; };
  }, [other, info.sha256, store]);
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
      img.data[o + 3] = Math.round(255 * Math.min(1, Math.max(0, (Math.abs(v) - 0.1) / 0.8)) ** 1.3);
    }
  }, [diff, theme]);
  const dur = diff?.duration ?? duration;
  return (
    <div className="lens-canvas lens-compare" data-testid="lens-compare">
      <div className="lc-bar">
        <span className="lc-label">Against</span>
        <select className="lc-select" data-testid="compare-other" value={other} aria-label="Compare with another sample or a sound" onChange={(e) => setOther(e.target.value)}>
          <option value="">pick a sample or a sound…</option>
          {samples.length > 0 && <optgroup label="Samples">{samples.map((x) => <option key={x.name} value={`sample:${x.name}`}>{x.name}</option>)}</optgroup>}
          {sounds.length > 0 && <optgroup label="Sounds">{sounds.map((x) => <option key={x.id} value={`sound:${x.id}`}>{x.id}</option>)}</optgroup>}
        </select>
        <span className="spacer" />
        <span className="lc-key"><i className="sw-warm" aria-hidden />louder here</span>
        <span className="lc-key"><i className="sw-cool" aria-hidden />quieter here</span>
      </div>
      <div className="lc-plot">
        {!other && <p className="lens-empty-note" data-testid="compare-none">Pick another sample, or a sound made to replace it, to see where they differ.</p>}
        {other && !diff && !error && <p className="lens-empty-note" data-testid="compare-measuring">measuring…</p>}
        {error && <p className="lens-empty-note" role="alert">{error}</p>}
        {diff && <Fit className="lz-fill" testId="lens-compare-canvas" deps={[bmp, view.t0, view.t1]} draw={(g, w, h) => { if (bmp) g.drawImage(bmp, (view.t0 / dur) * cw, 0, ((view.t1 - view.t0) / dur) * cw, ch, 0, 0, w, h); }} />}
      </div>
      {diff && <div className="lc-summary" data-testid="compare-summary">{diff.summary.replace(/^Now:/, 'This sample:')}</div>}
    </div>
  );
}

// ---- the numbers strip: always under the lens ---------------------------------------------------------------------------

const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1).replace('-', '\u2212') : `${v < 0 ? '\u2212' : ''}\u221e`);

function NumbersStrip({ lens }: { lens: SampleLensReply | null }) {
  const m = lens?.measure;
  const items: [string, string, string][] = m ? [
    ['loudness', 'Loudness', `${f1(m.lufs)} LUFS`], ['truePeak', 'True peak', `${f1(m.truePeakDb)} dBTP`], ['attack', 'Attack', `${m.attackMs < 10 ? m.attackMs.toFixed(1) : Math.round(m.attackMs)} ms`],
    ['centroid', 'Centroid', m.centroid >= 1000 ? `${(m.centroid / 1000).toFixed(1)} kHz` : `${Math.round(m.centroid)} Hz`],
    ['pitch', 'Pitch', m.pitch && m.pitched ? `${m.pitch.note}${Math.round(m.pitch.cents) ? ` ${Math.round(m.pitch.cents) > 0 ? '+' : ''}${Math.round(m.pitch.cents)}c` : ''}` : 'none'], ['onsets', 'Onsets', `${m.onsets.count}${m.tempo ? ` \u00b7 ${Math.round(m.tempo)} bpm` : ''}`],
  ] : [];
  return (
    <div className="lens-strip" data-testid="sample-strip">
      {items.map(([k, label, v]) => <div key={k} className="strip-card" data-testid={`sstrip-${k}`}><span className="cap">{label}</span><span className="mono strip-v">{v}</span></div>)}
      {!m && <span className="dim strip-wait">measuring…</span>}
    </div>
  );
}

// ---- the panel -----------------------------------------------------------------------------------------------------------

export interface LensDrafts {
  trim: [number, number] | null;
  loop: [number, number] | null;
  slices: number[] | null;
}

export interface SampleLensProps {
  store: Store;
  info: SampleInfo;
  lens: SampleLensReply | null;
  loading: string | null;
  tool: Tool;
  drafts: LensDrafts;
  setDrafts(f: (d: LensDrafts) => LensDrafts): void;
  /** Trim handles let go: [start, end] in seconds. */
  onTrim(a: number, b: number): void;
  /** Loop handles let go: frames. */
  onLoop(start: number, end: number): void;
  /** Slice markers changed: the new points in frames. */
  onSlices(points: number[]): void;
  /** The selection and cursor, for the tool bar. */
  onAxis(a: Axis): void;
}

export function SampleLens({ store, info, lens, loading, tool, drafts, setDrafts, onTrim, onLoop, onSlices, onAxis }: SampleLensProps) {
  const duration = lens?.duration ?? info.seconds;
  const [tab, setTab] = useState<LensTab>('wave');
  const [axis, setAxis] = useState<Axis>({ cursor: null, sel: null, t0: 0, t1: 0, level: 1 });
  const [hover, setHover] = useState<{ t: number; fy: number; px: number; py: number } | null>(null);
  const [selSlice, setSelSlice] = useState<number | null>(null);
  const t0 = axis.t0, t1 = axis.t1 > axis.t0 ? axis.t1 : duration;
  const view = { t0, t1: t1 || 1 };
  const set = (p: Partial<Axis>) => setAxis((a) => ({ ...a, ...p }));
  useEffect(() => { onAxis(axis); }, [axis]); // eslint-disable-line react-hooks/exhaustive-deps
  const rate = info.rate;
  const frame = (t: number): number => Math.round(t * rate);
  const loopFrames = info.loop;
  const loopSecs: [number, number] | null = drafts.loop ?? (loopFrames ? [loopFrames[0] / rate, loopFrames[1] / rate] : null);
  const slicesSecs = drafts.slices ?? (info.slices ?? []).map((f) => f / rate);

  // the seam of the loop as it stands (not while a handle is moving: its numbers come when it is let go)
  const [seam, setSeam] = useState<SeamReply | null>(null);
  const [seamError, setSeamError] = useState<string | null>(null);
  useEffect(() => {
    if (!loopFrames) { setSeam(null); setSeamError(null); return; }
    let live = true;
    sampleWorker.seam(store.token, info.sha256, loopFrames[0], loopFrames[1]).then((s) => { if (live) { setSeam(s); setSeamError(null); } }, (e: Error) => { if (live) setSeamError(e.message); });
    return () => { live = false; };
  }, [store, info.sha256, loopFrames?.[0], loopFrames?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  const actions: Action[] = SAMPLE_LENSES.map((l) => ({ id: `lens.${l.id}`, label: `Lens: ${l.name}`, group: 'Analysis', shortcut: l.key, key: l.key, run: () => setTab(l.id), keywords: 'view analysis sample' }));
  useActions(actions);
  const meta = SAMPLE_LENSES.find((l) => l.id === tab)!;
  const readout = `cursor ${axis.cursor === null ? '—' : `${fmtT(axis.cursor)} s`} · selection ${axis.sel ? `${fmtT(axis.sel.a)}–${fmtT(axis.sel.b)} s` : '—'}`;
  const onSurface = tab === 'wave' || tab === 'spec' || tab === 'pitch';
  const step = 1 / rate;

  // slice handles: moving one replaces its place; letting go writes every point
  const commitSlices = (pts: number[]) => {
    const fr = [...new Set(pts.map(frame))].filter((f) => f >= 0 && f < info.frames).sort((a, b) => a - b);
    if (fr[0] !== 0) fr.unshift(0);
    setDrafts((d) => ({ ...d, slices: null }));
    onSlices(fr);
  };

  return (
    <section className="lens sample-lens compact" data-testid="lens-panel" data-lens={tab} data-tool={tool} aria-label="Sample lenses">
      <div className="lens-head">
        <Tabs<LensTab> value={tab} onChange={setTab} label="Lens" testId="lens-tabs" idBase="slens" tabs={SAMPLE_LENSES.map((l) => ({ value: l.id, testId: `lens-tab-${l.id}`, label: <>{l.name}<kbd className="kbd">{l.key}</kbd></> }))} />
        <span className="cap lens-title">{meta.title}</span>
        <span className="lens-hint">{meta.hint}</span>
        <span className="spacer" />
        <span className="mono lens-readout" data-testid="lens-readout" data-cursor={axis.cursor ?? ''} data-sel={axis.sel ? `${axis.sel.a},${axis.sel.b}` : ''}>{readout}</span>
        {axis.sel && <button type="button" className="link-btn" data-testid="lens-clear" onClick={() => set({ sel: null })}>clear selection</button>}
        {(axis.t1 > axis.t0 && (t0 > 0 || t1 < duration - 1e-6)) && <button type="button" className="link-btn" data-testid="lens-zoom-reset" onClick={() => set({ t0: 0, t1: 0, level: 1 })}>reset zoom</button>}
      </div>
      <div className="lens-body" style={{ height: 250 }} data-testid="lens-body">
        {!lens ? <div className="lens-wait" data-testid="lens-measuring">{loading ?? 'measuring…'}</div> : (
          <>
            {tab === 'wave' && <WaveLens data={lens} view={view} axis={axis} outline={null} />}
            {tab === 'spec' && <SpecLens data={lens} view={view} hover={hover} />}
            {tab === 'pitch' && <PitchLens data={lens} view={view} />}
            {tab === 'loop' && <SeamLens seam={seam} error={seamError} hasLoop={!!loopFrames} />}
            {tab === 'compare' && <CompareLens store={store} info={info} view={view} duration={duration} />}
            {onSurface && (
              <Surface store={store} id={`sample:${info.name}`} view={view} duration={duration} axis={axis} set={set} flags={[]} onFlag={() => undefined} lens={tab === 'spec' ? 'spec' : tab === 'pitch' ? 'pitch' : 'wave'} data={lens}
                onPick={(kind, t, fy, px, py) => {
                  if (tab === 'spec' && kind === 'move') setHover(t < 0 ? null : { t, fy, px, py });
                  if (tool === 'slice' && kind === 'click') commitSlices([...slicesSecs, t]);
                }}>
                {/* slice points are shown under every tool; the Slice tool moves them */}
                {slicesSecs.map((s, i) => (i === 0 || tool !== 'slice'
                  ? <span key={`m${i}`} className="smp-slice-line" style={{ left: `${((s - view.t0) / (view.t1 - view.t0)) * 100}%` }} data-testid={`slice-line-${i + 1}`} aria-hidden />
                  : (
                    <TimeHandle key={`s${i}`} t={s} view={view} min={0} max={duration} label={`slice ${i + 1}`} tone="slice" testId={`slice-handle-${i + 1}`} selected={selSlice === i} step={step}
                      onFocusHandle={() => setSelSlice(i)}
                      onMove={(v) => setDrafts((d) => ({ ...d, slices: slicesSecs.map((x, k) => (k === i ? v : x)) }))}
                      onCommit={(v) => commitSlices(slicesSecs.map((x, k) => (k === i ? v : x)))}
                      onDelete={() => commitSlices(slicesSecs.filter((_, k) => k !== i))} />
                  )))}
                {tool === 'trim' && drafts.trim && (
                  <>
                    <span className="smp-shade" style={{ left: 0, width: `${((drafts.trim[0] - view.t0) / (view.t1 - view.t0)) * 100}%` }} aria-hidden />
                    <span className="smp-shade" style={{ left: `${((drafts.trim[1] - view.t0) / (view.t1 - view.t0)) * 100}%`, right: 0 }} aria-hidden />
                    <TimeHandle t={drafts.trim[0]} view={view} min={0} max={Math.max(0, drafts.trim[1] - step)} label="start" tone="trim" testId="trim-start" step={step}
                      onMove={(v) => setDrafts((d) => ({ ...d, trim: [v, d.trim?.[1] ?? duration] }))} onCommit={(v) => onTrim(v, drafts.trim![1])} />
                    <TimeHandle t={drafts.trim[1]} view={view} min={Math.min(duration, drafts.trim[0] + step)} max={duration} label="end" tone="trim" testId="trim-end" step={step}
                      onMove={(v) => setDrafts((d) => ({ ...d, trim: [d.trim?.[0] ?? 0, v] }))} onCommit={(v) => onTrim(drafts.trim![0], v)} />
                  </>
                )}
                {tool === 'loop' && loopSecs && (
                  <>
                    <span className="smp-loopband" style={{ left: `${((loopSecs[0] - view.t0) / (view.t1 - view.t0)) * 100}%`, width: `${((loopSecs[1] - loopSecs[0]) / (view.t1 - view.t0)) * 100}%` }} aria-hidden />
                    <TimeHandle t={loopSecs[0]} view={view} min={0} max={Math.max(0, loopSecs[1] - step)} label="loop start" tone="loop" testId="loop-start" step={step}
                      onMove={(v) => setDrafts((d) => ({ ...d, loop: [v, loopSecs[1]] }))} onCommit={(v) => onLoop(frame(v), frame(loopSecs[1]))} />
                    <TimeHandle t={loopSecs[1]} view={view} min={Math.min(duration, loopSecs[0] + step)} max={duration} label="loop end" tone="loop" testId="loop-end" step={step}
                      onMove={(v) => setDrafts((d) => ({ ...d, loop: [loopSecs[0], v] }))} onCommit={(v) => onLoop(frame(loopSecs[0]), frame(v))} />
                  </>
                )}
              </Surface>
            )}
          </>
        )}
      </div>
      {onSurface && <TimeRuler view={view} duration={duration} />}
      <NumbersStrip lens={lens} />
    </section>
  );
}

