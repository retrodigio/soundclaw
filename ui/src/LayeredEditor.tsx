// The editor of a layered sound: the big view (sum by layer, and the analysis lenses), layers as
// tracks with a device chain each (source, envelope, every effect as a card with its sketch), the
// master chain, and the cards that open every parameter. Every edit is a command, the very text an
// agent would write, sent as this person; a drag is held back and written as ONE command when the
// control is released (or has rested for a moment), exactly as in the classic editor. Dragging a
// layer by its handle is `layer move`; dragging a device is `fx move`, or one batch (remove, then add
// with the same parameters) to another layer; Alt-drag copies.

import { askAttr, askLabel, openAsk } from './studio/ask.tsx';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  FX_KINDS, FX_SPECS, KeyedCoalescer, LAYER_SPECS, MAX_FX, MAX_LAYERS, RECIPE_NAMES, SOURCE_KINDS, addPoint, envAt, envCommand, flatEnv, fxSetCommand, isLogScale, isStereo, layerLabel, layerSetCommand, layerSpecs,
  movePoint, roundSpec, showValue, sliderPosition, sliderValue, CURVES, type Curve, type Env, type Fx, type FxKind, type Layer, type LayeredSound, type PSpec, type Scheduler, type SourceKind, type Value,
} from '@soundclaw/core';
import { download } from './download.ts';
import { LoopPanel } from './LoopPanel.tsx';
import { LoudnessClass } from './LoudnessClass.tsx';
import type { StripPeaks } from './render.worker.ts';
import { AskComposer } from './sound/Inspector.tsx';
import { LensPanel, type Axis } from './sound/Lenses.tsx';
import { SH, SW, chainOf, dropDeviceCommands, envSketch, mainValues, sketch, type Scope } from './sound/devices.ts';
import { agentSet, answeredNote, type Trail } from './sound/provenance.ts';
import type { RunResult, Store } from './store.ts';
import { Badge, Button, Knob, Segmented, Slider, IconButton } from './studio/controls.tsx';
import type { ValueSpec } from './studio/values.ts';
import { Spark } from './studio/icons.tsx';
import { SAMPLE_MIME } from './studio/Samples.tsx';
import { useActions, type Action } from './studio/registry.ts';

const sched: Scheduler = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
const PAUSE_MS = 700;
const DOUBLE_CLICK_MS = 250;
const randomSeed = (): number => Math.floor(Math.random() * 4294967296);

// ---- one parameter ----------------------------------------------------------------------------------

interface ControlProps {
  /** The control's key: L:<layer>:<param>, F:<layer|M>:<k>:<param>, S:<param>. */
  ckey: string;
  spec: PSpec;
  value: Value | undefined;
  samples: string[];
  hasEnv: boolean;
  /** The sound this control belongs to (a sample's control links to the sample's page, trimming this layer). */
  soundId?: string;
  onMove(v: Value): void;
  /** A drag in progress: the page shows it, nothing is written. */
  onPreview(v: Value): void;
  onRelease(): void;
  onReset(): void;
  onEnv?(): void;
}

/** How a parameter reads on a knob: the stored number in its unit. */
export function paramSpec(sp: PSpec): ValueSpec {
  const digits = sp.integer ? 0 : undefined;
  switch (sp.unit) {
    case 'Hz': return { unit: 'hz', ...(digits !== undefined ? { digits } : {}) };
    case 's': return { unit: 's' };
    case 'dB': return { unit: 'db' };
    case 'st': return { unit: 'st' };
    case '': return { unit: 'plain', digits: digits ?? (sp.max - sp.min <= 2 ? 2 : sp.max - sp.min <= 50 ? 1 : 0) };
    default: return { unit: 'plain', custom: { show: (v) => `${Number(v.toPrecision(3))} ${sp.unit}`, read: (t) => { const n = Number.parseFloat(t.replace('−', '-')); return Number.isFinite(n) ? n : null; }, entry: (v) => String(Number(v.toPrecision(4))), hint: `a number in ${sp.unit}` } };
  }
}

/** One parameter, drawn with the studio components: a knob for a number, a segmented control for a few choices, a styled select for many, a text field for a name. */
function Control({ ckey, spec, value, samples, hasEnv, soundId, onMove, onPreview, onRelease, onReset, onEnv }: ControlProps) {
  const tid = ckey.replace(/:/g, '-');
  if (spec.choices) {
    const cur = String(value);
    if (spec.choices.length <= 4) {
      return (
        <div className="pc wide" data-testid={`row-${tid}`} title={spec.help}>
          <span className="cap">{spec.name}</span>
          <Segmented label={spec.name} value={cur} testId={`ctl-${tid}`} onChange={(c) => { onMove(c); onRelease(); }} options={spec.choices.map((c) => ({ value: c, label: c, testId: `ctl-${tid}-${c}` }))} />
        </div>
      );
    }
    return (
      <div className="pc wide" data-testid={`row-${tid}`} title={spec.help}>
        <label htmlFor={`c-${tid}`} className="cap">{spec.name}</label>
        <select id={`c-${tid}`} className="sel" data-testid={`ctl-${tid}`} value={cur} onChange={(e) => { onMove(e.target.value); onRelease(); }}>
          {spec.choices.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
    );
  }
  if (spec.text) {
    const isSample = spec.name === 'sample';
    return (
      <div className="pc wide" data-testid={`row-${tid}`} title={spec.help}>
        <label htmlFor={`c-${tid}`} className="cap">{spec.name}</label>
        {isSample ? (
          <>
          <select id={`c-${tid}`} className="sel" data-testid={`ctl-${tid}`} value={String(value)} onChange={(e) => { onMove(e.target.value); onRelease(); }}>
            <option value="">(none)</option>
            {samples.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          {String(value) && soundId && /^\d+:/.test(ckey) && <a className="link-btn smp-open" href={`#/sample/${String(value)}/layer/${soundId}/${ckey.split(':')[0]}`} data-testid={`open-sample-${tid}`} title="Open the sample: its trim handles write this layer's start and end">open</a>}
          </>
        ) : (
          <input id={`c-${tid}`} type="text" className="txt" data-testid={`ctl-${tid}`} defaultValue={String(value)} key={String(value)} onBlur={(e) => { if (e.target.value !== String(value)) { onMove(e.target.value); onRelease(); } }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        )}
      </div>
    );
  }
  const v = typeof value === 'number' ? value : (spec.default as number);
  const log = isLogScale(spec);
  const integer = !!spec.integer;
  return (
    <div className="pc" data-testid={`row-${tid}`} title={spec.help}>
      <Knob label={spec.name} testId={`ctl-${tid}`} value={v} min={spec.min} max={spec.max} def={spec.default as number} size={40} disabled={hasEnv} spec={paramSpec(spec)} bipolar={spec.min < 0 && spec.max > 0 && -spec.min === spec.max}
        step={integer ? 1 : log ? Math.max(Math.abs(v) * 0.05, 1e-6) : (spec.max - spec.min) / 100}
        {...(log ? { warp: { to: (x: number) => sliderPosition(spec, x), from: (f: number) => sliderValue(spec, f) } } : {})}
        onDraft={(x) => onPreview(roundSpec(spec, x))} onCommit={(x) => { const r = roundSpec(spec, x); if (r === spec.default && v !== r) onReset(); else onMove(r); }} />
      {spec.env && onEnv ? <button type="button" className={`env-chip${hasEnv ? ' on' : ''}`} data-testid={`env-btn-${tid}`} title={hasEnv ? 'This parameter follows an envelope: edit it below' : 'Replace the fixed value with an envelope'} onClick={onEnv}>{hasEnv ? '∿ env ●' : '∿ env'}</button> : null}
    </div>
  );
}

// ---- the envelope graph -------------------------------------------------------------------------------

interface EnvTarget {
  /** `1.freq`, `2.amp`, `1.fx2.mix`, `master.fx1.mix` */
  target: string;
  label: string;
  spec: PSpec;
  env: Env | null;
  /** The value the parameter has while it has no envelope. */
  fixed: number;
}

function targetsOf(sound: LayeredSound, n: number): EnvTarget[] {
  const l = sound.layers[n - 1];
  if (!l) return [];
  const out: EnvTarget[] = [{ target: `${n}.amp`, label: `layer ${n} amplitude`, spec: { name: 'amp', min: 0, max: 4, default: 1, unit: '', help: '', env: true }, env: l.amp, fixed: 1 }];
  for (const sp of layerSpecs(l.kind)) if (sp.env) out.push({ target: `${n}.${sp.name}`, label: `layer ${n} ${sp.name}`, spec: sp, env: l.envs[sp.name] ?? null, fixed: l.p[sp.name] as number });
  l.fx.forEach((f, k) => { for (const sp of FX_SPECS[f.kind]) if (sp.env) out.push({ target: `${n}.fx${k + 1}.${sp.name}`, label: `layer ${n} ${f.kind} ${k + 1} ${sp.name}`, spec: sp, env: f.envs[sp.name] ?? null, fixed: f.p[sp.name] as number }); });
  sound.master.forEach((f, k) => { for (const sp of FX_SPECS[f.kind]) if (sp.env) out.push({ target: `master.fx${k + 1}.${sp.name}`, label: `master ${f.kind} ${k + 1} ${sp.name}`, spec: sp, env: f.envs[sp.name] ?? null, fixed: f.p[sp.name] as number }); });
  return out;
}

const GW = 520, GH = 190, PAD = 34;

function EnvEditor({ run, sound, target, onTarget, targets, span }: { run(cmds: string): Promise<unknown>; sound: LayeredSound; target: string; onTarget(t: string): void; targets: EnvTarget[]; span: number }) {
  const t = targets.find((x) => x.target === target) ?? targets[0];
  const [draft, setDraft] = useState<Env | null>(null);
  const [sel, setSel] = useState(0);
  const drag = useRef<{ i: number; env: Env } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  if (!t) return null;
  const env = draft ?? t.env;
  const spec = t.spec;
  const tmax = Math.max(span, env ? env[env.length - 1]!.t * 1.15 : 0, 0.1);
  const log = isLogScale(spec);
  const xOf = (time: number) => PAD + (time / tmax) * (GW - PAD - 8);
  const yOf = (v: number) => {
    const u = log ? Math.log(Math.max(v, spec.min) / spec.min) / Math.log(spec.max / spec.min) : (v - spec.min) / (spec.max - spec.min);
    return GH - 22 - Math.min(1, Math.max(0, u)) * (GH - 34);
  };
  const fromXY = (cx: number, cy: number): { time: number; v: number } => {
    const r = svg.current!.getBoundingClientRect();
    const x = ((cx - r.left) / r.width) * GW, y = ((cy - r.top) / r.height) * GH;
    const u = Math.min(1, Math.max(0, (GH - 22 - y) / (GH - 34)));
    const v = log ? spec.min * (spec.max / spec.min) ** u : spec.min + (spec.max - spec.min) * u;
    return { time: Math.max(0, ((x - PAD) / (GW - PAD - 8)) * tmax), v };
  };
  const send = (e: Env | null) => run(envCommand(sound.id, t.target, e));
  const path = env ? Array.from({ length: 160 }, (_, k) => { const time = (k / 159) * tmax; return `${k ? 'L' : 'M'}${xOf(time).toFixed(1)},${yOf(envAt(env, time)).toFixed(1)}`; }).join(' ') : '';
  const ticks = log ? [spec.min, spec.min * Math.sqrt(spec.max / spec.min), spec.max] : [spec.min, (spec.min + spec.max) / 2, spec.max];

  return (
    <section className="env-editor" data-testid="env-editor" aria-label="Envelope editor">
      <span className="cap">Envelope</span>
      <div className="env-bar">
        <select className="sel" data-testid="env-target" value={t.target} onChange={(e) => { setSel(0); setDraft(null); onTarget(e.target.value); }}>
          {targets.map((x) => <option key={x.target} value={x.target}>{x.env ? '● ' : ''}{x.label}</option>)}
        </select>
        {env ? (
          <>
            <Button testId="env-clear" onClick={() => void send(null)}>Remove envelope</Button>
            {sel > 0 ? (
              <Segmented label={`Curve into point ${sel + 1}`} value={env[sel]?.curve ?? 'lin'} testId="env-curve" onChange={(c) => void send(env.map((p, k) => (k === sel ? { ...p, curve: c as Curve } : p)))}
                options={CURVES.map((c) => ({ value: c, label: c, testId: `env-curve-${c}` }))} />
            ) : <span className="dim small">the first point has no curve</span>}
            <Button testId="env-remove-point" disabled={env.length < 2} onClick={() => { void send(env.filter((_, k) => k !== sel)); setSel(0); }}>Remove point</Button>
          </>
        ) : <Button testId="env-make" onClick={() => void send(flatEnv(t.fixed, tmax))}>Make envelope (now fixed at {t.fixed})</Button>}
      </div>
      <svg ref={svg} className="envgraph" viewBox={`0 0 ${GW} ${GH}`} width="100%" data-testid="env-graph" data-target={t.target} data-points={env ? env.length : 0}
        onDoubleClick={(e) => {
          if (!env || (e.target as Element).tagName === 'circle') return;
          const { time, v } = fromXY(e.clientX, e.clientY);
          const next = addPoint(env, time, roundSpec(spec, v));
          if (next) void send(next);
        }}>
        <rect x={PAD} y={12} width={GW - PAD - 8} height={GH - 34} className="envbg" />
        {ticks.map((v, k) => <g key={k}><line x1={PAD} x2={GW - 8} y1={yOf(v)} y2={yOf(v)} className="envgrid" /><text x={PAD - 4} y={yOf(v) + 3} className="envtext" textAnchor="end">{Number(v.toPrecision(3))}</text></g>)}
        {[0, 0.5, 1].map((u) => <text key={u} x={xOf(u * tmax)} y={GH - 6} className="envtext" textAnchor="middle">{(u * tmax).toFixed(2)} s</text>)}
        {env ? (
          <>
            <path d={path} className="envpath" />
            {env.map((p, i) => (
              <circle key={i} cx={xOf(p.t)} cy={yOf(p.v)} r={i === sel ? 7 : 6} className={`envpt${i === sel ? ' sel' : ''}`} data-testid={`env-point-${i}`} data-t={p.t} data-v={p.v}
                onPointerDown={(e) => { (e.target as Element).setPointerCapture(e.pointerId); drag.current = { i, env }; setSel(i); }}
                onPointerMove={(e) => {
                  const d = drag.current;
                  if (!d || d.i !== i) return;
                  const { time, v } = fromXY(e.clientX, e.clientY);
                  const next = movePoint(d.env, i, time, v, spec);
                  drag.current = { i, env: d.env };
                  setDraft(next);
                }}
                onPointerUp={() => {
                  const d = drag.current;
                  drag.current = null;
                  if (d && draft && JSON.stringify(draft) !== JSON.stringify(d.env)) void send(draft).then(() => setDraft(null));
                  else setDraft(null);
                }} />
            ))}
          </>
        ) : <text x={GW / 2} y={GH / 2} className="envtext" textAnchor="middle">no envelope: {t.label} stays at {t.fixed}</text>}
      </svg>
      <p className="dim">Drag a point to move it (one change when you let go); double-click the graph to add a point. {env && sel < env.length ? `Point ${sel + 1}: ${env[sel]!.t} s, ${env[sel]!.v}.` : ''}</p>
    </section>
  );
}

// ---- the page --------------------------------------------------------------------------------------

type OpenPanel = { kind: 'source'; n: number } | { kind: 'fx'; scope: Scope; k: number } | null;
type Drag = { type: 'layer'; n: number } | { type: 'fx'; scope: Scope; k: number };

/**
 * Another document with a layered voice edited with these controls: an instrument's template. Its
 * commands are the sound commands the controls write, which `run` turns into the document's own
 * (`instrument layer set …`); the sound-only panels (length, loop, recipes, export) are left out.
 */
export interface VoiceTarget {
  sound: LayeredSound;
  run(cmds: string): Promise<RunResult>;
  play(): void;
  playing: boolean;
}

/** Each layer rendered alone, as peaks, by the measuring worker (the sum-by-layer bands and the tracks' mini waveforms). */
function useStrips(store: Store, sound: LayeredSound | undefined): StripPeaks[] | null {
  const key = sound ? store.keyOf(sound) : '';
  const [strips, setStrips] = useState<{ key: string; strips: StripPeaks[] } | null>(null);
  useEffect(() => {
    if (!sound) return;
    let live = true;
    store.layerStrips(sound, 600).then((s) => { if (live) setStrips({ key, strips: s }); }, () => undefined);
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return strips && sound && strips.strips.length === sound.layers.length ? strips.strips : null;
}

function MiniWave({ peaks: p, n, color }: { peaks: StripPeaks | undefined; n: number; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    g.clearRect(0, 0, c.width, c.height);
    if (!p) return;
    g.fillStyle = color;
    const mid = c.height / 2, cols = p.max.length;
    for (let x = 0; x < c.width; x++) {
      const a = Math.floor((x / c.width) * cols), b = Math.max(a + 1, Math.floor(((x + 1) / c.width) * cols));
      let hi = -1, lo = 1;
      for (let i = a; i < b && i < cols; i++) { hi = Math.max(hi, p.max[i]!); lo = Math.min(lo, p.min[i]!); }
      g.fillRect(x, mid - Math.max(0, hi) * mid, 1, Math.max(1, (Math.max(0, hi) - Math.min(0, lo)) * mid));
    }
  }, [p, color]);
  return <canvas ref={ref} className="track-wave" width={190} height={26} data-testid={`strip-${n}`} aria-hidden />;
}

const layerColor = (i: number): string => `var(--layer-${(i % 8) + 1})`;

export function LayeredEditor({ store, id, voice }: { store: Store; id: string; voice?: VoiceTarget }) {
  const found = voice ? voice.sound : store.sounds.find((s) => s.id === id);
  const sound = found?.voice === 'layered' ? found : undefined;
  const runCmd = (cmds: string): Promise<RunResult> => (voice ? voice.run(cmds) : store.run(cmds));
  const [sel, setSel] = useState(1);
  const [open, setOpen] = useState<OpenPanel>(voice ? { kind: 'source', n: 1 } : null);
  const [envTarget, setEnvTarget] = useState('1.amp');
  const [draft, setDraft] = useState<Record<string, Value>>({});
  const [menu, setMenu] = useState<string | null>(null);
  const [dropSample, setDropSample] = useState(false);
  const [over, setOver] = useState<string | null>(null);
  const [hoverBand, setHoverBand] = useState<number | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [askFocus, setAskFocus] = useState(0);
  const [axis, setAxis] = useState<Axis | null>(null);
  const dnd = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null);
  const latest = useRef({ sound, store, id, run: { run: runCmd }, voice });
  latest.current = { sound, store, id, run: { run: runCmd }, voice };
  const release = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null);

  const co = useMemo(() => new KeyedCoalescer<Value>((edits) => {
    const { sound: cur, run: st, id: sid } = latest.current;
    const clear = () => setDraft((d) => {
      const next = { ...d };
      for (const [k, v] of edits) if (next[k] === v) delete next[k];
      return next;
    });
    if (!cur) { clear(); return; }
    const cmds = commandsFor(sid, cur, edits);
    if (!cmds.length) { clear(); return; }
    void st.run(cmds.join('\n')).then(clear);
  }, sched, PAUSE_MS), []);
  useEffect(() => () => { co.cancel(); if (release.current) clearTimeout(release.current); if (dwell.current) clearTimeout(dwell.current); }, [co]);

  // the open device stays in view in its chain: the dock takes width from the chains, which then scroll sideways to it
  useEffect(() => {
    if (!open) return;
    const tid = open.kind === 'fx' ? `fx-${String(open.scope)}-${open.k}` : open.kind === 'source' ? `source-open-${open.n}` : null;
    if (!tid) return;
    let raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-testid="${tid}"]`);
      const chain = el?.closest<HTMLElement>('.chain');
      if (!el || !chain) return;
      const c = chain.getBoundingClientRect(), d = el.getBoundingClientRect();
      const pad = 12;
      if (d.left < c.left + pad || d.width > c.width - 2 * pad) chain.scrollLeft += d.left - c.left - pad;
      else if (d.right > c.right - pad) chain.scrollLeft += d.right - c.right + pad;
    }); });
    return () => cancelAnimationFrame(raf);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const key = sound ? store.keyOf(sound) : '';
  const prevKey = useRef(key);
  useEffect(() => {
    const was = prevKey.current;
    prevKey.current = key;
    if (!was || !key || was === key) return;
    if (sound && store.playOnChange) { if (voice) voice.play(); else void store.playDoc(id, sound, id, undefined, true); }
  }, [key, sound, store, id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!latest.current.voice || e.code !== 'Space' || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range' && (t as HTMLInputElement).type !== 'checkbox'))) return;
      e.preventDefault();
      latest.current.voice!.play();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // keep the selection inside the list
  useEffect(() => { if (sound && sel > Math.max(1, sound.layers.length)) setSel(Math.max(1, sound.layers.length)); }, [sound?.layers.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const strips = useStrips(store, sound);
  const prov = store.provenance(id);
  const samples = store.samples.map((s) => s.name);

  const actions: Action[] = voice ? [] : [
    { id: 'layer.add', label: 'Add a layer', group: 'Edit', shortcut: '⇧ L', key: 'shift+l', run: () => setMenu('layer'), keywords: 'new source track' },
    { id: 'panel.inspector', label: 'Toggle the inspector', group: 'Panels', shortcut: '⌥ 2', key: 'alt+2', override: true, run: () => { setAskOpen((o) => !o); setAskFocus((n) => n + 1); } },
  ];
  useActions(actions);

  if (!sound) return <section className="editor"><a href="#/" className="back">← all sounds</a><p className="empty" data-testid="editor-missing">No sound “{id}”.</p></section>;

  const now = (cmd: string) => { co.flush(); return runCmd(cmd); };
  const move = (k: string, v: Value) => { setDraft((d) => ({ ...d, [k]: v })); co.push(k, v); };
  const doRelease = () => {
    if (release.current) clearTimeout(release.current);
    release.current = setTimeout(() => { release.current = null; co.flush(); }, DOUBLE_CLICK_MS);
  };
  const resetTo = (k: string, def: Value) => {
    if (release.current) { clearTimeout(release.current); release.current = null; }
    co.cancel();
    setDraft((d) => { const n = { ...d }; delete n[k]; return n; });
    void runCmd(commandsFor(id, sound, new Map([[k, def]])).join('\n'));
  };
  const val = (k: string, fallback: Value | undefined): Value | undefined => draft[k] ?? fallback;
  const releaseFor = (k: string) => () => { if (co.value(k) !== undefined) doRelease(); };

  const layer: Layer | undefined = sound.layers[sel - 1];
  const targets = targetsOf(sound, sel);
  const effTarget = targets.some((t) => t.target === envTarget) ? envTarget : (targets[0]?.target ?? '1.amp');
  const measured = store.measure(sound);
  const playing = voice ? voice.playing : store.playing === id;
  const stereo = isStereo(sound);
  const length = store.render(sound).length / 44100;
  const span = layer ? (typeof layer.p.dur === 'number' ? layer.p.dur : length) : length;
  const data = voice ? null : store.lens(sound);

  const controlFor = (ckey: string, spec: PSpec, current: Value | undefined, hasEnv: boolean, onEnv?: () => void) => (
    <Control key={ckey} ckey={ckey} spec={spec} value={val(ckey, current)} samples={samples} hasEnv={hasEnv} soundId={id}
      onMove={(v) => move(ckey, v)} onPreview={(v) => setDraft((d) => ({ ...d, [ckey]: v }))} onRelease={releaseFor(ckey)} onReset={() => resetTo(ckey, spec.default)} onEnv={onEnv} />
  );
  const toEnv = (target: string, fixed: number, exists: boolean) => () => {
    setEnvTarget(target);
    if (!exists) void now(envCommand(id, target, flatEnv(fixed, Math.max(span, 0.1))));
  };

  const select = (n: number) => { setSel(n); setOpen({ kind: 'source', n }); setEnvTarget(`${n}.amp`); };
  const scopeKey = (s: Scope): string => String(s);
  const chainWhere = (s: Scope): string => (s === 'M' ? '' : ` layer=${s}`);

  // ---- dragging: layers by their handle, devices by their card (pointer events, so it works the same with a mouse, a pen and a test) ----
  const dropDevice = (to: Scope, at: number, alt: boolean) => {
    const d = dnd.current;
    if (d?.type !== 'fx') return;
    const cmds = dropDeviceCommands(sound, d.scope, d.k, to, at, alt);
    if (cmds.length) void now(cmds.join('\n'));
  };
  const scopeOf = (t: string): Scope => (t === 'M' ? 'M' : Number(t));
  const dropOn = (target: string, alt: boolean) => {
    const d = dnd.current;
    if (!d) return;
    const [kind, a, b] = target.split(':');
    if (d.type === 'layer') {
      const to = kind === 'layer' || kind === 'fx' ? Number(a) : NaN;
      if (Number.isFinite(to) && to !== d.n && to >= 1 && to <= sound.layers.length) { void now(`layer move ${id} ${d.n} to=${to}`); setSel(to); setOpen({ kind: 'source', n: to }); }
    } else if (kind === 'fx') dropDevice(scopeOf(a!), Number(b), alt);
    else if (kind === 'layer') dropDevice(Number(a), chainOf(sound, Number(a)).length + 1, alt);
    else if (kind === 'master') dropDevice('M', sound.master.length + 1, alt);
  };
  const startDrag = (e: React.PointerEvent, drag: Drag, label: string) => {
    if (e.button !== 0 || voice) return;
    const sx = e.clientX, sy = e.clientY;
    let active = false;
    const pick = (ev: PointerEvent): string | null => (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-drop]')?.dataset.drop ?? null;
    const move = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      active = true;
      dnd.current = drag;
      setOver(pick(ev));
      setGhost({ x: ev.clientX, y: ev.clientY, label });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      if (!active) return;
      const t = pick(ev);
      setOver(null); setGhost(null);
      suppressClick.current = true;
      setTimeout(() => { suppressClick.current = false; }, 0);
      if (t) dropOn(t, ev.altKey);
      dnd.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  // ---- hover on a band solos that layer for preview; a click selects it ----
  const hoverLayer = (n: number | null) => {
    setHoverBand(n);
    if (dwell.current) { clearTimeout(dwell.current); dwell.current = null; }
    if (n === null) { if (store.playing === `${id}#solo`) store.stop(); return; }
    dwell.current = setTimeout(() => {
      dwell.current = null;
      const solo: LayeredSound = { ...sound, layers: sound.layers.map((l, i) => ({ ...l, solo: i === n - 1, mute: false })) };
      void store.playDoc(`${id}#solo`, solo, id, undefined, true);
    }, 350);
  };

  const trailNote = (t: Trail | undefined): string | null => (t ? answeredNote(store.requests, id, t.by, t.at) : null);

  const device = (scope: Scope, k: number, f: Fx, salt: number | 'M') => {
    const trail = prov.devices.get(`${salt}:${k - 1}`);
    const byAgent = agentSet(prov, trail);
    const note = byAgent ? trailNote(trail) : null;
    const sc = scopeKey(scope);
    const isOpen = open?.kind === 'fx' && open.scope === scope && open.k === k;
    const chain = chainOf(sound, scope);
    const vals = mainValues(f.kind, f.p);
    const prevKind = byAgent && trail && typeof trail.prev === 'object' && !('salt' in trail.prev) ? (trail.prev as Fx) : null;
    return (
      <div key={`${sc}-${k}`} className="dev-wrap">
        <div className={`device${isOpen ? ' open' : ''}${byAgent ? ' by-agent' : ''}${over === `fx:${sc}:${k}` ? ' drop' : ''}`} data-testid={`fx-${sc}-${k}`} {...askAttr(id, { kind: 'param', param: f.kind, ...(sc === 'M' ? {} : { layer: Number(sc) }), fx: k }, askLabel(id, { kind: 'param', param: f.kind, ...(sc === 'M' ? {} : { layer: Number(sc) }), fx: k }))} data-kind={f.kind} data-agent={byAgent || undefined}
          tabIndex={0} role="button" aria-expanded={isOpen} aria-label={`${f.kind} effect ${k}${byAgent ? ', changed by the agent' : ''}. Enter opens its parameters.`} data-drop={`fx:${sc}:${k}`}
          onPointerDown={(e) => startDrag(e, { type: 'fx', scope, k }, `${f.kind}`)}
          onClick={() => { if (suppressClick.current) return; if (scope !== 'M') { setSel(scope); setEnvTarget(`${scope}.fx${k}.${FX_SPECS[f.kind].find((x) => x.env)?.name ?? 'mix'}`); } setOpen(isOpen ? null : { kind: 'fx', scope, k }); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); e.currentTarget.click(); } }}>
          <div className="dev-title"><span className="dev-name">{f.kind}</span>{byAgent && <Spark size={11} />}<span className="spacer" /><span className="dev-n mono">{k}</span></div>
          <svg className="dev-sketch" viewBox={`0 0 ${SW} ${SH}`} preserveAspectRatio="none" width="100%" height="26" aria-hidden><path d={sketch(f.kind, f.p)} /></svg>
          <div className="dev-vals">{vals.map((v) => <div key={v.k}><span className="dev-k">{v.k}</span><span className="mono dev-v" data-by={byAgent && prevKind && prevKind.p[v.k] !== f.p[v.k] ? 'agent' : undefined}>{v.v}</span></div>)}</div>
          {note && <span className="dev-note" data-testid={`fx-note-${sc}-${k}`}>{note}</span>}
          {byAgent && !note && <span className="dev-note dim">changed by the agent</span>}
        </div>
        {k < chain.length && <svg className="dev-arrow" width="18" height="10" viewBox="0 0 18 10" aria-hidden><path d="M2 5 H14 M11 2 L14 5 L11 8" /></svg>}
      </div>
    );
  };

  const addMenu = (scope: Scope) => {
    const chain = chainOf(sound, scope);
    const mk = scope === 'M' ? 'master' : `L${scope}`;
    return (
      <div className="dev-add" key="add">
        <button type="button" className="dev-plus" aria-label={scope === 'M' ? 'Add a master effect' : `Add an effect to layer ${scope}`} aria-haspopup="menu" aria-expanded={menu === `fx-${scope}`} data-testid={`device-add-${scope}`} disabled={chain.length >= MAX_FX}
          onClick={() => setMenu(menu === `fx-${scope}` ? null : `fx-${scope}`)}>+</button>
        {menu === `fx-${scope}` && (
          <div className="dev-menu" role="menu" data-testid={`device-menu-${scope}`}>
            {FX_KINDS.map((kd) => (
              <button key={kd} type="button" role="menuitem" data-testid={`fx-add-${mk}-${kd}`} onClick={() => { setMenu(null); void now(`fx add ${id}${chainWhere(scope)} ${kd}`).then(() => setOpen({ kind: 'fx', scope, k: chain.length + 1 })); if (scope !== 'M') setSel(scope); }}>{kd}</button>
            ))}
          </div>
        )}
      </div>
    );
  };

  /** The device detail panel, docked to the right of the tracks: every parameter of the selected device or source, and the envelope graph. */
  const panel = (which: NonNullable<OpenPanel>) => {
    const close = <IconButton label="Close the panel" testId="panel-close" kind="quiet" onClick={() => setOpen(null)}><span aria-hidden>×</span></IconButton>;
    if (which.kind === 'source') {
      const l = sound.layers[which.n - 1];
      if (!l) return null;
      const n = which.n;
      const ps = LAYER_SPECS.find((x) => x.name === 'pan')!;
      const os = LAYER_SPECS.find((x) => x.name === 'offset')!;
      const pk = `L:${n}:pan`, ok = `L:${n}:offset`;
      const numeric = layerSpecs(l.kind).filter((sp) => !['offset', 'gain', 'pan', 'seed'].includes(sp.name));
      return (
        <aside className="device-panel" data-testid="layer-panel" data-layer={n} aria-label={`Layer ${n} source`}>
          <div className="dp-head"><span className="dp-title">Layer {n} · source</span><span className="mono dim small">{layerLabel(l)}</span><span className="spacer" />{close}</div>
          <div className="pc wide" data-testid="layer-source" title="the layer's source">
            <span className="cap">source</span>
            <Segmented label="Source" value={l.kind} testId="ctl-source" onChange={(k) => void now(`layer set ${id} ${n} source=${k}`)}
              options={SOURCE_KINDS.filter((k) => k !== 'sample' || samples.length || l.kind === 'sample').map((k) => ({ value: k, label: k, testId: `ctl-source-${k}` }))} />
          </div>
          <div className="pc-grid">
            {numeric.filter((sp) => !['filter', 'cutoff', 'q'].includes(sp.name)).map((sp) =>
              controlFor(`L:${n}:${sp.name}`, sp, l.p[sp.name], !!l.envs[sp.name], sp.env ? toEnv(`${n}.${sp.name}`, l.p[sp.name] as number, !!l.envs[sp.name]) : undefined))}
            <div className="pc" data-testid="amp-row">
              <span className="cap">amplitude</span>
              <span className="dim small" data-testid="amp-state">{l.amp ? `envelope, ${l.amp.length} points` : l.kind === 'classic' ? 'the classic voice\'s own envelope' : '2 ms fade in and out'}</span>
              <button type="button" className={`env-chip${l.amp ? ' on' : ''}`} data-testid="env-btn-amp" onClick={toEnv(`${n}.amp`, 1, !!l.amp)}>{l.amp ? '∿ env ●' : '∿ env'}</button>
            </div>
            {numeric.filter((sp) => ['filter', 'cutoff', 'q'].includes(sp.name)).map((sp) =>
              controlFor(`L:${n}:${sp.name}`, sp, l.p[sp.name], !!l.envs[sp.name], sp.env ? toEnv(`${n}.${sp.name}`, l.p[sp.name] as number, !!l.envs[sp.name]) : undefined))}
            {controlFor(`L:${n}:seed`, { ...LAYER_SPECS.find((x) => x.name === 'seed')!, default: 0 }, l.p.seed ?? 0, false)}
            <div className="pc wide" data-testid={`row-L-${n}-pan`}>
              <Slider label="Pan" testId={`layer-pan-${n}`} value={val(pk, l.p.pan) as number} min={ps.min} max={ps.max} def={ps.default as number} bipolar disabled={!!l.envs.pan} spec={{ unit: 'plain', digits: 2 }} step={0.02}
                onDraft={(v) => setDraft((d) => ({ ...d, [pk]: roundSpec(ps, v) }))} onCommit={(v) => move(pk, roundSpec(ps, v))} />
            </div>
            <div className="pc" data-testid={`row-L-${n}-offset`}>
              <Knob label="offset" testId={`layer-offset-${n}`} value={val(ok, l.p.offset) as number} min={os.min} max={os.max} def={os.default as number} size={40} spec={{ unit: 's' }} step={0.01}
                onDraft={(v) => setDraft((d) => ({ ...d, [ok]: roundSpec(os, v) }))} onCommit={(v) => move(ok, roundSpec(os, v))} />
            </div>
          </div>
          {layer && <EnvEditor run={runCmd} sound={sound} target={effTarget} onTarget={setEnvTarget} targets={targets} span={span} />}
        </aside>
      );
    }
    const chain = chainOf(sound, which.scope);
    const f = chain[which.k - 1];
    if (!f) return null;
    const sc = scopeKey(which.scope), k = which.k;
    const wh = chainWhere(which.scope);
    return (
      <aside className="device-panel" data-testid={which.scope === 'M' ? 'fx-master' : 'fx-layer'} aria-label={`${f.kind} effect`}>
        <div className="dp-head" data-testid={`fx-panel-${sc}-${k}`} data-kind={f.kind}>
          <span className="dp-title">{which.scope === 'M' ? 'Master' : `Layer ${which.scope}`} · {k}. {f.kind}</span><span className="spacer" />{close}
        </div>
        <div className="dp-btns">
          <Button kind="quiet" testId={`fx-up-${sc}-${k}`} disabled={k === 1} onClick={() => void now(`fx move ${id}${wh} ${k} to=${k - 1}`).then(() => setOpen({ kind: 'fx', scope: which.scope, k: k - 1 }))} title="earlier in the chain">← earlier</Button>
          <Button kind="quiet" testId={`fx-down-${sc}-${k}`} disabled={k === chain.length} onClick={() => void now(`fx move ${id}${wh} ${k} to=${k + 1}`).then(() => setOpen({ kind: 'fx', scope: which.scope, k: k + 1 }))} title="later in the chain">later →</Button>
          <Button kind="danger" testId={`fx-remove-${sc}-${k}`} onClick={() => { void now(`fx remove ${id}${wh} ${k}`); setOpen(null); }} title="remove this effect">Remove</Button>
        </div>
        <div className="pc-grid">
          {FX_SPECS[f.kind].map((sp) => controlFor(`F:${which.scope === 'M' ? 'M' : which.scope}:${k}:${sp.name}`, sp, f.p[sp.name], !!f.envs[sp.name], sp.env ? toEnv(`${which.scope === 'M' ? 'master' : which.scope}.fx${k}.${sp.name}`, f.p[sp.name] as number, !!f.envs[sp.name]) : undefined))}
        </div>
        {layer && <EnvEditor run={runCmd} sound={sound} target={effTarget} onTarget={setEnvTarget} targets={targets} span={span} />}
      </aside>
    );
  };
  const panelEl = open ? panel(open) : null;

  const gs = LAYER_SPECS.find((x) => x.name === 'gain')!;
  const gainWarp = { to: (v: number) => sliderPosition(gs, v), from: (f: number) => sliderValue(gs, f) };

  const track = (l: Layer, i: number) => {
    const n = i + 1;
    const gk = `L:${n}:gain`;
    const color = layerColor(i);
    const byAgentLayer = agentSet(prov, prov.layers.get(l.salt));
    const srcOpen = open?.kind === 'source' && open.n === n;
    const env = l.amp;
    return (
      <div key={l.salt} className={`track${n === sel ? ' sel' : ''}${l.mute ? ' muted' : ''}${over === `layer:${n}` ? ' drop' : ''}${byAgentLayer ? ' by-agent' : ''}`} data-testid={`layer-row-${n}`} {...askAttr(id, { kind: 'layer', layer: n }, askLabel(id, { kind: 'layer', layer: n }))} data-kind={l.kind} data-drop={`layer:${n}`} style={{ '--lc': color } as CSSProperties}>
        <div className="track-main">
          <div className="track-head">
            <div className="track-title">
              <span className="drag-handle" role="img" aria-label="Drag to reorder" title="Drag to reorder (layer move)" data-testid={`layer-handle-${n}`} onPointerDown={(e) => startDrag(e, { type: 'layer', n }, `Layer ${n}`)}>
                <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden>{[3, 7, 11].flatMap((y) => [3, 7].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.2" />))}</svg>
              </span>
              <button className="layer-name" data-testid={`layer-select-${n}`} aria-pressed={n === sel} onClick={() => select(n)}>Layer {n}</button>
              {byAgentLayer && <Spark size={11} />}
              <span className="spacer" />
              <button className={`letter-btn${l.solo ? ' on' : ''}`} aria-pressed={l.solo} data-testid={`layer-solo-${n}`} title="solo" aria-label={`Solo layer ${n}`} onClick={() => void now(`layer solo ${id} ${n} ${l.solo ? 'off' : 'on'}`)}>S</button>
              <button className={`letter-btn${l.mute ? ' on' : ''}`} aria-pressed={l.mute} data-testid={`layer-mute-${n}`} title="mute" aria-label={`Mute layer ${n}`} onClick={() => void now(`layer mute ${id} ${n} ${l.mute ? 'off' : 'on'}`)}>M</button>
            </div>
            <span className="mono track-src" data-testid={`layer-src-${n}`}>{layerLabel(l)}{l.kind === 'sample' && l.p.sample ? <a className="link-btn smp-open" href={`#/sample/${String(l.p.sample)}/layer/${id}/${n}`} data-testid={`layer-sample-${n}`} title="Open the sample: its trim handles write this layer's start and end">open sample</a> : null}</span>
            <MiniWave peaks={strips?.[i]} n={n} color={color} />
            <div className="track-gain"><Slider label="Gain" testId={`layer-gain-${n}`} value={val(gk, l.p.gain) as number} min={gs.min} max={gs.max} def={gs.default as number} warp={gainWarp} disabled={!!l.envs.gain} spec={{ unit: 'plain', digits: 2 }} step={0.02}
              onDraft={(v) => setDraft((d) => ({ ...d, [gk]: roundSpec(gs, v) }))} onCommit={(v) => { move(gk, roundSpec(gs, v)); doRelease(); }} />
              <span className="track-btns">
                <button className="link" data-testid={`layer-up-${n}`} disabled={i === 0} title="move up" aria-label={`Move layer ${n} up`} onClick={() => { void now(`layer move ${id} ${n} to=${n - 1}`); setSel(n - 1); }}>↑</button>
                <button className="link" data-testid={`layer-down-${n}`} disabled={i === sound.layers.length - 1} title="move down" aria-label={`Move layer ${n} down`} onClick={() => { void now(`layer move ${id} ${n} to=${n + 1}`); setSel(n + 1); }}>↓</button>
                <button className="link" data-testid={`layer-remove-${n}`} title="remove this layer" aria-label={`Remove layer ${n}`} onClick={() => void now(`layer remove ${id} ${n}`)}>×</button>
              </span>
            </div>
          </div>
          <div className="chain" data-testid={`chain-${n}`}>
            <div className="dev-wrap">
              <div className={`device source${srcOpen ? ' open' : ''}`} data-testid={`source-open-${n}`} tabIndex={0} role="button" aria-expanded={srcOpen} aria-label={`Layer ${n} source: ${layerLabel(l)}. Enter opens its parameters.`}
                onClick={() => select(n)} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); select(n); } }}>
                <div className="dev-title"><span className="dev-name">{l.kind === 'ks' ? 'pluck' : l.kind}</span><span className="spacer" /><span className="dev-n mono">src</span></div>
                <div className="dev-vals">{layerSpecs(l.kind).filter((sp) => ['wave', 'freq', 'dur', 'sample', 'ops', 'pitch'].includes(sp.name)).slice(0, 3).map((sp) => <div key={sp.name}><span className="dev-k">{sp.name}</span><span className="mono dev-v">{String(showValue(l.kind, sp.name, l.p[sp.name] ?? sp.default))}</span></div>)}</div>
              </div>
              <svg className="dev-arrow" width="18" height="10" viewBox="0 0 18 10" aria-hidden><path d="M2 5 H14 M11 2 L14 5 L11 8" /></svg>
            </div>
            <div className="dev-wrap">
              <div className={`device envelope${l.amp ? '' : ' none'}`} data-testid={`env-open-${n}`} tabIndex={0} role="button" aria-label={`Layer ${n} amplitude envelope. Enter opens it.`}
                onClick={() => { select(n); setEnvTarget(`${n}.amp`); }} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); select(n); setEnvTarget(`${n}.amp`); } }}>
                <div className="dev-title"><span className="dev-name">envelope</span><span className="spacer" /><span className="dev-n mono">amp</span></div>
                <svg className="dev-sketch" viewBox={`0 0 ${SW} ${SH}`} preserveAspectRatio="none" width="100%" height="26" aria-hidden><path d={envSketch(env)} /></svg>
                <div className="dev-vals">{env ? <><div><span className="dev-k">points</span><span className="mono dev-v">{env.length}</span></div><div><span className="dev-k">length</span><span className="mono dev-v">{env[env.length - 1]!.t.toFixed(2)} s</span></div></> : <div><span className="dev-k">none</span><span className="mono dev-v">2 ms fade</span></div>}</div>
              </div>
              {l.fx.length > 0 && <svg className="dev-arrow" width="18" height="10" viewBox="0 0 18 10" aria-hidden><path d="M2 5 H14 M11 2 L14 5 L11 8" /></svg>}
            </div>
            {l.fx.map((f, k) => device(n, k + 1, f, l.salt))}
            {addMenu(n)}
          </div>
        </div>
      </div>
    );
  };

  const layersLens = voice ? undefined : { strips, names: sound.layers.map((_, i) => `Layer ${i + 1}`), selected: sel, hover: hoverBand, onSelect: select, onHover: hoverLayer };

  return (
    <section className={`editor layered${voice ? ' voice' : ''}`} data-testid={voice ? 'voice-editor' : 'editor'} data-sound={id} data-voice="layered">
      <header className="editor-head">
        {!voice && <a href="#/" className="back" data-testid="back">← all sounds</a>}
        <h2>{voice ? `voice of ${sound.id}` : sound.id}</h2>
        {!voice && <span className={`chip status-${sound.status}`}>{sound.status}</span>}
        <span className="chip voice-chip">layered voice · {sound.layers.length} layer{sound.layers.length === 1 ? '' : 's'}</span>
        {(data?.checks ?? []).filter((c) => !c.pass).map((c) => <Badge key={c.name} kind="fail" testId={`check-${c.name}`}>{` ${c.name}`}</Badge>)}
        {data && data.checks.every((c) => c.pass) && <Badge kind="pass" testId="check-all">all checks</Badge>}
        <span className="dim" data-testid="editor-numbers">
          {measured.pending ? 'measuring…' : `${measured.analysis.duration.toFixed(2)} s · ${Number.isFinite(measured.analysis.lufs) ? measured.analysis.lufs.toFixed(1) : '−∞'} LUFS · centroid ${measured.analysis.centroid.mean.toFixed(0)} Hz`}{stereo ? ' · stereo' : ''}
        </span>
        {!voice && <LoudnessClass store={store} sound={sound} />}
        <span className="spacer" />
        {!voice && <a className="link-btn" href={`#/sound/${id}/analysis`} data-testid="open-analysis">Analysis ↗</a>}
        <button className="play" data-testid="editor-play" data-playing={playing} onClick={() => (voice ? voice.play() : void store.play(id))}>{playing ? '■ Stop' : '▶ Play'} <span className="dim">space</span></button>
        <button data-testid="editor-stop" onClick={() => store.stop()} disabled={!store.playing}>■ Stop</button>
        <label className="toggle"><input type="checkbox" data-testid="play-on-change" checked={store.playOnChange} onChange={(e) => { store.playOnChange = e.target.checked; store.changed(); }} /> play on change</label>
        <button data-testid="editor-undo" disabled={!store.canUndo()} onClick={() => void store.undo()}>Undo</button>
        <button data-testid="editor-redo" disabled={!store.canRedo()} onClick={() => void store.redo()}>Redo</button>
      </header>

      {!voice && (
        <div className="lay-actions">
          <div className="dev-add">
            <button type="button" className="btn btn-secondary" data-testid="add-layer-menu" aria-haspopup="menu" aria-expanded={menu === 'layer'} onClick={() => setMenu(menu === 'layer' ? null : 'layer')}>+ Layer <kbd className="kbd">⇧L</kbd></button>
            {menu === 'layer' && (
              <div className="dev-menu" role="menu" data-testid="layer-menu">
                {SOURCE_KINDS.map((k) => (
                  <button key={k} type="button" role="menuitem" data-testid={`add-layer-${k}`} disabled={sound.layers.length >= MAX_LAYERS || (k === 'sample' && !samples.length)} title={k === 'sample' && !samples.length ? 'import a sample first: soundclaw sample import <project> <file.wav>' : undefined}
                    onClick={() => { setMenu(null); void now(`layer add ${id} ${k}${k === 'sample' ? ` sample=${samples[0]}` : ''}`).then(() => select(sound.layers.length + 1)); }}>{k}</button>
                ))}
              </div>
            )}
          </div>
          <span className="dim small">{sound.layers.length} of {MAX_LAYERS} layers</span>
          <span className="spacer" />
          <Button kind="agent" testId="ask-toggle" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); const t = { kind: 'layer' as const, layer: sel }; openAsk({ sound: id, target: sel > 0 ? t : { kind: 'item' }, label: sel > 0 ? askLabel(id, t) : id, anchor: () => r }); }}>Ask for changes <kbd className="kbd">R</kbd></Button>
          <Button kind="primary" testId="insp-approve" onClick={() => void store.approve(id)}>Approve</Button>
        </div>
      )}
      {!voice && askOpen && <div className="ask-bar"><AskComposer store={store} id={id} selection={axis?.sel ?? null} focusToken={askFocus} onClose={() => setAskOpen(false)} /></div>}

      {!voice && <LensPanel store={store} sound={sound} height={190} prov={prov} outline={prov.beforeAgent} previous={prov.before} layersLens={layersLens} onAxis={setAxis} />}

      <div className="lay-grid" data-panel={panelEl ? 'open' : undefined} onKeyDown={(e) => { if (e.key === 'Escape' && panelEl && (e.target as HTMLElement).closest('.device-panel')) setOpen(null); }}>
      <section className={`tracks${dropSample ? ' drop-sample' : ''}`} data-testid="layers" aria-label="Layers" data-count={sound.layers.length}
        onDragOver={(e) => { if (!voice && [...e.dataTransfer.types].includes(SAMPLE_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!dropSample) setDropSample(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropSample(false); }}
        onDrop={(e) => {
          const name = e.dataTransfer.getData(SAMPLE_MIME);
          setDropSample(false);
          if (!name || voice) return;
          e.preventDefault();
          if (sound.layers.length >= MAX_LAYERS) return;
          void now(`layer add ${id} sample sample=${name}`).then(() => select(sound.layers.length + 1));
        }}>
        {sound.layers.length === 0 && <p className="dim" data-testid="no-layers">No layers yet: add one with + Layer, or start from a recipe.</p>}
        <div data-testid="layer-strips" className="tracks-list">
          {sound.layers.map((l, i) => track(l, i))}
        </div>
        <div className={`track master${over === 'master' ? ' drop' : ''}`} data-testid="master-fx" data-drop="master">
          <div className="track-main">
            <div className="track-head"><div className="track-title"><span className="layer-name static">Master</span></div><span className="mono track-src">after every layer</span></div>
            <div className="chain" data-testid="chain-M">
              {sound.master.map((f, k) => device('M', k + 1, f, 'M'))}
              {addMenu('M')}
            </div>
          </div>
        </div>
        <div className="lay-hints"><span>Drag a device onto another layer to move it · ⌥ drag copies</span><span>Enter opens a device · Tab moves along the chain</span><span>Drag the handle to reorder layers</span></div>
      </section>
      {panelEl}
      </div>

      {!voice && (
        <details className="sound-more" open>
          <summary className="cap">Sound settings, recipes, loop and export</summary>
          <div className="sound-more-grid">
            <section className="panel" data-testid="sound-settings" aria-label="Sound settings">
              <h3>Sound</h3>
              <div className="row">
                <label className="toggle"><input type="checkbox" data-testid="duration-auto" checked={sound.duration === null} onChange={(e) => void now(e.target.checked ? `sound set ${id} duration=auto` : `sound set ${id} duration=${Number(length.toFixed(3))}`)} /> length follows the layers</label>
                {sound.duration !== null && <input type="number" min={0.01} max={10} step={0.01} data-testid="duration" defaultValue={sound.duration} key={sound.duration} onBlur={(e) => { const v = Number(e.target.value); if (v >= 0.01 && v <= 10 && v !== sound.duration) void now(`sound set ${id} duration=${v}`); }} />}
              </div>
              {controlFor('S:gain', { name: 'gain', min: 0, max: 4, default: 1, unit: '', help: 'master level', env: false }, sound.gain, false)}
              <div className="row">
                <label className="seed" title="the sound's noise seed; layers derive theirs from it">seed
                  <input type="number" min={0} step={1} data-testid="sound-seed" defaultValue={sound.seed} key={sound.seed} onBlur={(e) => { const v = Math.floor(Number(e.target.value)); if (v >= 0 && v !== sound.seed) void now(`sound set ${id} seed=${v}`); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></label>
              </div>
            </section>
            <LoopPanel store={store} sound={sound} />
            <section className="panel" data-testid="generators" aria-label="Generators">
              <h3>Start from</h3>
              <div className="row wrap">
                {RECIPE_NAMES.map((c) => <button key={c} data-testid={`gen-${c}`} onClick={() => void now(`sound generate ${id} ${c} seed=${randomSeed()}`)}>{c}</button>)}
              </div>
              <p className="dim">A recipe replaces the layers with a seeded sound; Undo brings the old ones back.</p>
            </section>
            <section className="panel" data-testid="export" aria-label="Export">
              <h3>Export</h3>
              <div className="row wrap"><button data-testid="export-wav" onClick={() => download(`${id}.wav`, store.wavOf(sound), 'audio/wav')}>WAV</button></div>
              <p className="dim">A layered sound exports as a WAV only ({stereo ? 'stereo' : 'mono'}, 16-bit, 44,100 Hz, through a limiter at {store.style.truePeakMax} dBTP); a synth.csv row or patch text cannot hold layers.</p>
            </section>
          </div>
        </details>
      )}
      {ghost && <div className="drag-ghost" style={{ left: ghost.x + 10, top: ghost.y + 10 }} aria-hidden>{ghost.label}{store.playing === null ? '' : ''}</div>}
      <div className="dim hash" data-testid="layered-hash">samples {store.hashOf(sound).slice(0, 12)}</div>
    </section>
  );
}

/** The commands for a set of pending control edits (keys: L:<layer>:<param>, F:<layer|M>:<k>:<param>, S:<param>), skipping values that are already so. */
function commandsFor(id: string, sound: LayeredSound, edits: Map<string, Value>): string[] {
  const byLayer = new Map<number, Record<string, Value>>();
  const byFx = new Map<string, { layer: number | null; k: number; kind: FxKind; vals: Record<string, Value> }>();
  const snd: Record<string, Value> = {};
  for (const [key, v] of edits) {
    const p = key.split(':');
    if (p[0] === 'L') {
      const n = Number(p[1]);
      const l = sound.layers[n - 1];
      if (!l) continue;
      const name = p[2]!;
      if (l.p[name] === v && !(name === 'seed' && v === 0)) continue;
      byLayer.set(n, { ...(byLayer.get(n) ?? {}), [name]: v });
    } else if (p[0] === 'F') {
      const layer = p[1] === 'M' ? null : Number(p[1]);
      const k = Number(p[2]);
      const chain = layer === null ? sound.master : sound.layers[layer - 1]?.fx;
      const f = chain?.[k - 1];
      if (!f || f.p[p[3]!] === v) continue;
      const kk = `${layer}:${k}`;
      byFx.set(kk, { layer, k, kind: f.kind, vals: { ...(byFx.get(kk)?.vals ?? {}), [p[3]!]: v } });
    } else if (p[0] === 'S') {
      const name = p[1]!;
      if ((sound as unknown as Record<string, Value>)[name] !== v) snd[name] = v;
    }
  }
  const out: string[] = [];
  for (const [n, vals] of byLayer) out.push(layerSetCommand(id, n, sound.layers[n - 1]!.kind as SourceKind, vals));
  for (const f of byFx.values()) out.push(fxSetCommand(id, f.layer, f.k, f.kind, f.vals));
  if (Object.keys(snd).length) out.push(`sound set ${id} ${Object.entries(snd).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  return out;
}
