// The editor of a layered sound: a list of layers (add, remove, reorder, mute, solo, gain, pan,
// offset), the selected layer's source controls and filter, an envelope editor (breakpoints drag on
// a small graph), and the effect chains (the layer's and the master's). Every edit is a command,
// the very text an agent would write, sent as this person; a drag is held back and written as ONE
// command when the control is released (or has rested for a moment), exactly as in the classic
// editor.

import { LoopPanel } from './LoopPanel.tsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FX_KINDS, FX_SPECS, KeyedCoalescer, LAYER_SPECS, MAX_FX, MAX_LAYERS, RECIPE_NAMES, SOURCE_KINDS, addPoint, envAt, envCommand, flatEnv, fxSetCommand, isLogScale, isStereo, layerLabel, layerSetCommand, layerSpecs,
  movePoint, peaks, renderParts, roundSpec, sliderPosition, sliderValue, CURVES, type Curve, type Env, type Fx, type FxKind, type Layer, type LayeredSound, type PSpec, type Scheduler, type SourceKind, type Value,
} from '@soundclaw/core';
import { download } from './download.ts';
import { MelSpectrogram } from './Spectrogram.tsx';
import { LoudnessClass } from './LoudnessClass.tsx';
import type { RunResult, Store } from './store.ts';
import { Waveform } from './Waveform.tsx';

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
  onMove(v: Value): void;
  onRelease(): void;
  onReset(): void;
  onEnv?(): void;
}

function Control({ ckey, spec, value, samples, hasEnv, onMove, onRelease, onReset, onEnv }: ControlProps) {
  const tid = ckey.replace(/:/g, '-');
  if (spec.choices) {
    return (
      <div className="slider" data-testid={`row-${tid}`}>
        <label htmlFor={`c-${tid}`} title={spec.help}>{spec.name}</label>
        <select id={`c-${tid}`} data-testid={`ctl-${tid}`} value={String(value)} onChange={(e) => { onMove(e.target.value); onRelease(); }}>
          {spec.choices.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <span /><span /><span />
      </div>
    );
  }
  if (spec.text) {
    const isSample = spec.name === 'sample';
    return (
      <div className="slider" data-testid={`row-${tid}`}>
        <label htmlFor={`c-${tid}`} title={spec.help}>{spec.name}</label>
        {isSample ? (
          <select id={`c-${tid}`} data-testid={`ctl-${tid}`} value={String(value)} onChange={(e) => { onMove(e.target.value); onRelease(); }}>
            <option value="">(none)</option>
            {samples.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        ) : (
          <input id={`c-${tid}`} type="text" data-testid={`ctl-${tid}`} defaultValue={String(value)} key={String(value)} onBlur={(e) => { if (e.target.value !== String(value)) { onMove(e.target.value); onRelease(); } }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        )}
        <span /><span /><span />
      </div>
    );
  }
  const v = typeof value === 'number' ? value : (spec.default as number);
  const changed = v !== spec.default;
  const step = spec.integer && spec.max - spec.min <= 20 ? 1 : 0;
  return (
    <div className={`slider${changed ? ' changed' : ''}`} data-testid={`row-${tid}`}>
      <label htmlFor={`c-${tid}`} title={spec.help}>{spec.name}</label>
      {step ? (
        <input id={`c-${tid}`} type="range" min={spec.min} max={spec.max} step={1} value={v} data-testid={`ctl-${tid}`}
          onChange={(e) => onMove(Number(e.target.value))}
          onPointerDown={() => window.addEventListener('pointerup', onRelease, { once: true })} onKeyUp={onRelease} onBlur={onRelease} onDoubleClick={onReset} />
      ) : (
        <input id={`c-${tid}`} type="range" min={0} max={1000} step={1} value={Math.round(sliderPosition(spec, v) * 1000)} data-testid={`ctl-${tid}`}
          onChange={(e) => onMove(sliderValue(spec, Number(e.target.value) / 1000))}
          onPointerDown={() => window.addEventListener('pointerup', onRelease, { once: true })} onKeyUp={onRelease} onBlur={onRelease} onDoubleClick={onReset} />
      )}
      <output data-testid={`val-${tid}`} title={`default ${String(spec.default)}`}>{v}{spec.unit && spec.unit.length <= 2 ? ` ${spec.unit}` : ''}</output>
      {spec.env && onEnv ? (
        <button className={`link env-btn${hasEnv ? ' on' : ''}`} data-testid={`env-btn-${tid}`} title={hasEnv ? 'This parameter follows an envelope: edit it below' : 'Replace the fixed value with an envelope'} onClick={onEnv}>{hasEnv ? '∿ env' : '∿'}</button>
      ) : <span />}
      <button className="link reset" data-testid={`reset-${tid}`} disabled={!changed} onClick={onReset} title={`back to the default, ${String(spec.default)}`} aria-label={`reset ${spec.name}`}>↺</button>
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
    <section className="panel" data-testid="env-editor" aria-label="Envelope editor">
      <h3>Envelope</h3>
      <div className="row">
        <select data-testid="env-target" value={t.target} onChange={(e) => { setSel(0); setDraft(null); onTarget(e.target.value); }}>
          {targets.map((x) => <option key={x.target} value={x.target}>{x.env ? '● ' : ''}{x.label}</option>)}
        </select>
        {env ? (
          <>
            <button data-testid="env-clear" onClick={() => void send(null)}>Remove envelope</button>
            <label className="toggle">curve into point {sel + 1}
              <select data-testid="env-curve" value={env[sel]?.curve ?? 'lin'} disabled={sel === 0} onChange={(e) => void send(env.map((p, k) => (k === sel ? { ...p, curve: e.target.value as Curve } : p)))}>
                {CURVES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <button data-testid="env-remove-point" disabled={env.length < 2} onClick={() => { void send(env.filter((_, k) => k !== sel)); setSel(0); }}>Remove point</button>
          </>
        ) : <button data-testid="env-make" onClick={() => void send(flatEnv(t.fixed, tmax))}>Make envelope (now fixed at {t.fixed})</button>}
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

function LayerStrips({ store, sound }: { store: Store; sound: LayeredSound }) {
  const key = store.keyOf(sound);
  // each layer on its own, rendered in the worker (a long sound's layers take seconds)
  const [strips, setStrips] = useState<{ key: string; strips: { min: number[]; max: number[] }[] } | null>(null);
  useEffect(() => {
    let live = true;
    store.layerStrips(sound).then((s) => { if (live) setStrips({ key, strips: s }); }, () => undefined);
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const refs = useRef<(HTMLCanvasElement | null)[]>([]);
  useEffect(() => {
    if (!strips) return;
    strips.strips.forEach((p, i) => {
      const c = refs.current[i];
      const g = c?.getContext('2d');
      if (!c || !g) return;
      g.clearRect(0, 0, c.width, c.height);
      g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--wave').trim() || '#888';
      const mid = c.height / 2;
      for (let x = 0; x < c.width; x++) g.fillRect(x, mid - p.max[x]! * mid, 1, Math.max(1, (p.max[x]! - p.min[x]!) * mid));
    });
  }, [strips]);
  if (!strips || strips.strips.length !== sound.layers.length) return null;
  return (
    <div className="strips" data-testid="layer-strips">
      {strips.strips.map((_, i) => (
        <div key={sound.layers[i]!.salt} className="strip"><span className="dim">{i + 1} {layerLabel(sound.layers[i]!)}</span>
          <canvas ref={(el) => { refs.current[i] = el; }} width={360} height={26} data-testid={`strip-${i + 1}`} /></div>
      ))}
    </div>
  );
}

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

export function LayeredEditor({ store, id, voice }: { store: Store; id: string; voice?: VoiceTarget }) {
  const found = voice ? voice.sound : store.sounds.find((s) => s.id === id);
  const sound = found?.voice === 'layered' ? found : undefined;
  const runCmd = (cmds: string): Promise<RunResult> => (voice ? voice.run(cmds) : store.run(cmds));
  const [sel, setSel] = useState(1);
  const [envTarget, setEnvTarget] = useState('1.amp');
  const [draft, setDraft] = useState<Record<string, Value>>({});
  const latest = useRef({ sound, store, id, run: { run: runCmd }, voice });
  latest.current = { sound, store, id, run: { run: runCmd }, voice };
  const release = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  useEffect(() => () => { co.cancel(); if (release.current) clearTimeout(release.current); }, [co]);

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
      if (e.code !== 'Space' || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range' && (t as HTMLInputElement).type !== 'checkbox'))) return;
      e.preventDefault();
      if (latest.current.voice) latest.current.voice.play();
      else void latest.current.store.play(latest.current.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // keep the selection inside the list
  useEffect(() => { if (sound && sel > Math.max(1, sound.layers.length)) setSel(Math.max(1, sound.layers.length)); }, [sound?.layers.length]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const samples = store.samples.map((s) => s.name);
  const length = store.render(sound).length / 44100;
  const span = layer ? (typeof layer.p.dur === 'number' ? layer.p.dur : length) : length;

  const controlFor = (ckey: string, spec: PSpec, current: Value | undefined, hasEnv: boolean, onEnv?: () => void) => (
    <Control key={ckey} ckey={ckey} spec={spec} value={val(ckey, current)} samples={samples} hasEnv={hasEnv}
      onMove={(v) => move(ckey, v)} onRelease={releaseFor(ckey)} onReset={() => resetTo(ckey, spec.default)} onEnv={onEnv} />
  );
  const toEnv = (target: string, fixed: number, exists: boolean) => () => {
    setEnvTarget(target);
    if (!exists) void now(envCommand(id, target, flatEnv(fixed, Math.max(span, 0.1))));
  };

  const fxList = (scope: number | null, fx: Fx[]) => (
    <div className="fxlist" data-testid={scope === null ? 'fx-master' : 'fx-layer'}>
      {fx.map((f, i) => {
        const k = i + 1;
        const sc = scope === null ? 'M' : String(scope);
        return (
          <fieldset key={i} className="group fx" data-testid={`fx-${sc}-${k}`} data-kind={f.kind}>
            <legend>{k}. {f.kind}</legend>
            <div className="row">
              <button className="link" data-testid={`fx-up-${sc}-${k}`} disabled={i === 0} onClick={() => void now(`fx move ${id}${scope === null ? '' : ` layer=${scope}`} ${k} to=${k - 1}`)} title="earlier in the chain">↑</button>
              <button className="link" data-testid={`fx-down-${sc}-${k}`} disabled={i === fx.length - 1} onClick={() => void now(`fx move ${id}${scope === null ? '' : ` layer=${scope}`} ${k} to=${k + 1}`)} title="later in the chain">↓</button>
              <button className="link" data-testid={`fx-remove-${sc}-${k}`} onClick={() => void now(`fx remove ${id}${scope === null ? '' : ` layer=${scope}`} ${k}`)} title="remove this effect">× remove</button>
            </div>
            {FX_SPECS[f.kind].map((sp) => controlFor(`F:${sc}:${k}:${sp.name}`, sp, f.p[sp.name], !!f.envs[sp.name], sp.env ? toEnv(`${scope === null ? 'master' : scope}.fx${k}.${sp.name}`, f.p[sp.name] as number, !!f.envs[sp.name]) : undefined))}
          </fieldset>
        );
      })}
      <div className="row wrap">
        {FX_KINDS.map((kd) => (
          <button key={kd} data-testid={`fx-add-${scope === null ? 'master' : 'layer'}-${kd}`} disabled={fx.length >= MAX_FX || (scope !== null && !layer)} onClick={() => void now(`fx add ${id}${scope === null ? '' : ` layer=${scope}`} ${kd}`)}>+ {kd}</button>
        ))}
      </div>
    </div>
  );

  return (
    <section className={`editor layered${voice ? ' voice' : ''}`} data-testid={voice ? 'voice-editor' : 'editor'} data-sound={id} data-voice="layered">
      <header className="editor-head">
        {!voice && <a href="#/" className="back" data-testid="back">← all sounds</a>}
        <h2>{voice ? `voice of ${sound.id}` : sound.id}</h2>
        {!voice && <span className={`chip status-${sound.status}`}>{sound.status}</span>}
        <span className="dim" data-testid="editor-numbers">
          {measured.pending ? 'measuring…' : `${measured.analysis.duration.toFixed(2)} s · ${Number.isFinite(measured.analysis.lufs) ? measured.analysis.lufs.toFixed(1) : '−∞'} LUFS · centroid ${measured.analysis.centroid.mean.toFixed(0)} Hz`}{stereo ? ' · stereo' : ''}
        </span>
        {!voice && <LoudnessClass store={store} sound={sound} />}
        <span className="spacer" />
        <button className="play" data-testid="editor-play" data-playing={playing} onClick={() => (voice ? voice.play() : void store.play(id))}>{playing ? '■ Stop' : '▶ Play'} <span className="dim">space</span></button>
        <button data-testid="editor-stop" onClick={() => store.stop()} disabled={!store.playing}>■ Stop</button>
        <label className="toggle"><input type="checkbox" data-testid="play-on-change" checked={store.playOnChange} onChange={(e) => { store.playOnChange = e.target.checked; store.changed(); }} /> play on change</label>
        <button data-testid="editor-undo" disabled={!store.canUndo()} onClick={() => void store.undo()}>Undo</button>
        <button data-testid="editor-redo" disabled={!store.canRedo()} onClick={() => void store.redo()}>Redo</button>
      </header>

      <div className="editor-grid">
        <div className="params-col layers-col">
          <section className="panel" data-testid="layers" aria-label="Layers">
            <h3>Layers <span className="dim">{sound.layers.length} of {MAX_LAYERS}</span></h3>
            {sound.layers.length === 0 && <p className="dim" data-testid="no-layers">No layers yet: add one below, or start from a recipe.</p>}
            {sound.layers.map((l, i) => {
              const n = i + 1;
              const gk = `L:${n}:gain`, pk = `L:${n}:pan`, ok = `L:${n}:offset`;
              const gs = LAYER_SPECS.find((x) => x.name === 'gain')!, ps = LAYER_SPECS.find((x) => x.name === 'pan')!;
              return (
                <div key={l.salt} className={`layer-row${n === sel ? ' sel' : ''}${l.mute ? ' muted' : ''}`} data-testid={`layer-row-${n}`} data-kind={l.kind} onClick={() => setSel(n)}>
                  <button className="layer-name" data-testid={`layer-select-${n}`} aria-pressed={n === sel} onClick={() => setSel(n)}>{n}. {layerLabel(l)}</button>
                  <button className={l.mute ? 'on' : ''} aria-pressed={l.mute} data-testid={`layer-mute-${n}`} title="mute" onClick={(e) => { e.stopPropagation(); void now(`layer mute ${id} ${n} ${l.mute ? 'off' : 'on'}`); }}>M</button>
                  <button className={l.solo ? 'on' : ''} aria-pressed={l.solo} data-testid={`layer-solo-${n}`} title="solo" onClick={(e) => { e.stopPropagation(); void now(`layer solo ${id} ${n} ${l.solo ? 'off' : 'on'}`); }}>S</button>
                  <div className="layer-ctls">
                  <label title="gain">gain
                    <input type="range" min={0} max={1000} value={Math.round(sliderPosition(gs, val(gk, l.p.gain) as number) * 1000)} data-testid={`layer-gain-${n}`} disabled={!!l.envs.gain}
                      onChange={(e) => move(gk, sliderValue(gs, Number(e.target.value) / 1000))} onPointerDown={() => window.addEventListener('pointerup', releaseFor(gk), { once: true })} onKeyUp={releaseFor(gk)} onBlur={releaseFor(gk)} />
                    <output>{val(gk, l.p.gain)}</output></label>
                  <label title="pan: -1 left, 1 right">pan
                    <input type="range" min={0} max={1000} value={Math.round(sliderPosition(ps, val(pk, l.p.pan) as number) * 1000)} data-testid={`layer-pan-${n}`} disabled={!!l.envs.pan}
                      onChange={(e) => move(pk, sliderValue(ps, Number(e.target.value) / 1000))} onPointerDown={() => window.addEventListener('pointerup', releaseFor(pk), { once: true })} onKeyUp={releaseFor(pk)} onBlur={releaseFor(pk)} />
                    <output>{val(pk, l.p.pan)}</output></label>
                  <label title="start offset, seconds">offset
                    <input type="number" min={0} max={10} step={0.01} data-testid={`layer-offset-${n}`} value={String(val(ok, l.p.offset))}
                      onChange={(e) => setDraft((d) => ({ ...d, [ok]: Number(e.target.value) }))} onBlur={() => { if (draft[ok] !== undefined) { co.push(ok, draft[ok]!); co.flush(); } }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></label>
                  </div>
                  <button className="link" data-testid={`layer-up-${n}`} disabled={i === 0} title="move up" onClick={(e) => { e.stopPropagation(); void now(`layer move ${id} ${n} to=${n - 1}`); setSel(n - 1); }}>↑</button>
                  <button className="link" data-testid={`layer-down-${n}`} disabled={i === sound.layers.length - 1} title="move down" onClick={(e) => { e.stopPropagation(); void now(`layer move ${id} ${n} to=${n + 1}`); setSel(n + 1); }}>↓</button>
                  <button className="link" data-testid={`layer-remove-${n}`} title="remove this layer" onClick={(e) => { e.stopPropagation(); void now(`layer remove ${id} ${n}`); }}>×</button>
                </div>
              );
            })}
            <div className="row wrap">
              <span className="dim">Add a layer:</span>
              {SOURCE_KINDS.map((k) => (
                <button key={k} data-testid={`add-layer-${k}`} disabled={sound.layers.length >= MAX_LAYERS || (k === 'sample' && !samples.length)} title={k === 'sample' && !samples.length ? 'import a sample first: soundclaw sample import <project> <file.wav>' : undefined}
                  onClick={() => { void now(`layer add ${id} ${k}${k === 'sample' ? ` sample=${samples[0]}` : ''}`).then(() => setSel(sound.layers.length + 1)); }}>+ {k}</button>
              ))}
            </div>
          </section>

          {layer && (
            <fieldset className="group" data-testid="layer-panel" data-layer={sel}>
              <legend>Layer {sel}: {layerLabel(layer)}</legend>
              <div className="slider">
                <label htmlFor="c-source">source</label>
                <select id="c-source" data-testid="ctl-source" value={layer.kind} onChange={(e) => void now(`layer set ${id} ${sel} source=${e.target.value}`)}>
                  {SOURCE_KINDS.map((k) => <option key={k} value={k} disabled={k === 'sample' && !samples.length}>{k}</option>)}
                </select>
                <span /><span /><span />
              </div>
              {layerSpecs(layer.kind).filter((sp) => !['offset', 'gain', 'pan', 'seed'].includes(sp.name) && !(['filter', 'cutoff', 'q'].includes(sp.name))).map((sp) =>
                controlFor(`L:${sel}:${sp.name}`, sp, layer.p[sp.name], !!layer.envs[sp.name], sp.env ? toEnv(`${sel}.${sp.name}`, layer.p[sp.name] as number, !!layer.envs[sp.name]) : undefined))}
              <div className="slider"><label>amplitude</label>
                <span className="dim" data-testid="amp-state">{layer.amp ? `envelope, ${layer.amp.length} points` : layer.kind === 'classic' ? 'the classic voice\'s own envelope' : '2 ms fade in and out'}</span>
                <span /><button className={`link env-btn${layer.amp ? ' on' : ''}`} data-testid="env-btn-amp" onClick={toEnv(`${sel}.amp`, 1, !!layer.amp)}>{layer.amp ? '∿ env' : '∿'}</button><span /></div>
              {layerSpecs(layer.kind).filter((sp) => ['filter', 'cutoff', 'q'].includes(sp.name)).map((sp) =>
                controlFor(`L:${sel}:${sp.name}`, sp, layer.p[sp.name], !!layer.envs[sp.name], sp.env ? toEnv(`${sel}.${sp.name}`, layer.p[sp.name] as number, !!layer.envs[sp.name]) : undefined))}
              {controlFor(`L:${sel}:seed`, { ...LAYER_SPECS.find((x) => x.name === 'seed')!, default: 0 }, layer.p.seed ?? 0, false)}
            </fieldset>
          )}

          {layer && (
            <fieldset className="group" data-testid="layer-fx">
              <legend>Effects on layer {sel}</legend>
              {fxList(sel, layer.fx)}
            </fieldset>
          )}

          <fieldset className="group" data-testid="master-fx">
            <legend>Master effects</legend>
            {fxList(null, sound.master)}
          </fieldset>
        </div>

        <div className="side-col">
          <section className="panel" aria-label="Sound">
            <Waveform samples={store.render(sound)} id={id} />
            {!measured.pending && <MelSpectrogram spec={measured.spec} id={id} />}
            <LayerStrips store={store} sound={sound} />
            <div className="dim hash">samples {store.hashOf(sound).slice(0, 12)}</div>
          </section>

          {layer && <EnvEditor run={runCmd} sound={sound} target={effTarget} onTarget={setEnvTarget} targets={targets} span={span} />}

          {!voice && <>
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
          </>}
        </div>
      </div>
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
