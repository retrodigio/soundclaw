// The classic voice's editor: the big view (the analysis lenses) over seven modules in signal
// order, with a drawn envelope, and an inspector on the right. Every edit is a command, the very
// text an agent would write, sent as this person: a knob's drag is a local draft and is written as
// ONE `sound set` when it is released (the Coalescer), exactly as before. A parameter the agent set
// last (and nobody approved since) wears a violet tick and a ghost mark at the value before.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Coalescer, EDITOR_GROUPS, GENERATOR_NAMES, MUTATE_AMOUNT, WAVE_NAMES, classicField, csvFileText, diffPatch, patchFileText, roundParam, setCommand,
  type ClassicKey, type ClassicPatch, type Edits, type Scheduler, type Sound,
} from '@soundclaw/core';
import { download } from '../download.ts';
import { LoopPanel } from '../LoopPanel.tsx';
import { LoudnessClass } from '../LoudnessClass.tsx';
import type { Store } from '../store.ts';
import { AuthorChip, Badge, Button, Knob, Segmented, type CheckKind } from '../studio/controls.tsx';
import { useActions, type Action } from '../studio/registry.ts';
import { ago } from '../studio/shellData.ts';
import { formatValue } from '../studio/values.ts';
import { CHECK_MODULE, CLASSIC_LABEL, CLASSIC_MODULES, classicSpec, isBipolar, lengthParam, lengthSeconds, moduleOff } from './classicUnits.ts';
import { AskComposer, HistoryList, useInspectorOpen } from './Inspector.tsx';
import { LensPanel, type Axis } from './Lenses.tsx';
import { AB, Numbers } from './parts.tsx';
import { agentSet, answeredNote } from './provenance.ts';

const sched: Scheduler = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/** How long a control may rest, mid-gesture, before what it holds is written. */
const PAUSE_MS = 700;
/** After a release, how long to wait for a double-click (a reset) or another key press before writing. */
const DOUBLE_CLICK_MS = 250;

const randomSeed = (): number => Math.floor(Math.random() * 4294967296);

/** The patch with edits laid over it (the draft the controls show before it is written). */
function withEdits(p: ClassicPatch, e: Edits): ClassicPatch {
  const out: ClassicPatch = { ...p };
  for (const [k, v] of Object.entries(e)) {
    if (k === 'seed') { if (v === 'auto') delete out.seed; else out.seed = v as number; } else (out as unknown as Record<string, number>)[k] = v as number;
  }
  return out;
}

// ---- the drawn envelope ----------------------------------------------------------------------------------

const EW = 360, EH = 84;

/**
 * The envelope as sfxr makes it: a rise over the attack, the sustain starting at 1 + 2·punch and
 * falling to 1, then a fall over the decay. Four corners are handles: the end of the attack, the top
 * of the punch, the end of the sustain and the end of the decay. A drag changes one parameter and
 * writes it once, when it is released.
 */
function EnvelopeDraw({ patch, ghost, onDraft, onCommit }: { patch: ClassicPatch; ghost: Partial<Record<ClassicKey, number>>; onDraft(name: ClassicKey, v: number): void; onCommit(name: ClassicKey, v: number): void }) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ name: ClassicKey; scaleT: number; scaleY: number; v: number; moved: boolean } | null>(null);
  const [scale, setScale] = useState<{ t: number; y: number } | null>(null);
  const shape = (p: Record<string, number>) => {
    const a = lengthSeconds(p.attack!), s = lengthSeconds(p.sustain!), d = lengthSeconds(p.decay!);
    return { a, s, d, top: 1 + 2 * p.punch!, total: a + s + d };
  };
  const cur = shape(patch as unknown as Record<string, number>);
  const gh = shape({ ...(patch as unknown as Record<string, number>), ...(ghost as Record<string, number>) });
  const hasGhost = Object.keys(ghost).length > 0;
  const tMax = scale?.t ?? Math.max(cur.total, gh.total, 0.05) * 1.12;
  const yMax = scale?.y ?? Math.max(1.3, cur.top, gh.top) * 1.08;
  const X = (t: number): number => 6 + (t / tMax) * (EW - 12);
  const Y = (v: number): number => EH - 6 - (v / yMax) * (EH - 12);
  const pathOf = (s: ReturnType<typeof shape>): string => `M${X(0)} ${Y(0)} L${X(s.a)} ${Y(1)} L${X(s.a)} ${Y(s.top)} L${X(s.a + s.s)} ${Y(1)} L${X(s.total)} ${Y(0)}`;
  const corners: { name: ClassicKey; x: number; y: number; label: string }[] = [
    { name: 'attack', x: X(cur.a), y: Y(1), label: 'end of the attack' },
    { name: 'punch', x: X(cur.a), y: Y(cur.top), label: 'punch' },
    { name: 'sustain', x: X(cur.a + cur.s), y: Y(1), label: 'end of the sustain' },
    { name: 'decay', x: X(cur.total), y: Y(0), label: 'end of the decay' },
  ];
  const apply = (name: ClassicKey, cx: number, cy: number, sc: { t: number; y: number }): number => {
    const r = svg.current!.getBoundingClientRect();
    const px = ((cx - r.left) / r.width) * EW, py = ((cy - r.top) / r.height) * EH;
    const t = Math.max(0, ((px - 6) / (EW - 12)) * sc.t);
    const v = Math.max(0, ((EH - 6 - py) / (EH - 12)) * sc.y);
    const f = classicField(name)!;
    const raw = name === 'punch' ? (v - 1) / 2
      : name === 'attack' ? lengthParam(Math.max(0, t))
      : name === 'sustain' ? lengthParam(Math.max(0, t - cur.a))
      : lengthParam(Math.max(0, t - cur.a - cur.s));
    return roundParam(name, Math.min(f.max, Math.max(f.min, raw)));
  };
  return (
    <div className="env-draw">
      <svg ref={svg} viewBox={`0 0 ${EW} ${EH}`} preserveAspectRatio="none" width="100%" height={EH} data-testid="env-draw" role="group" aria-label="Envelope: drag the corners">
        {hasGhost && <path d={pathOf(gh)} className="env-ghost" data-testid="env-ghost" />}
        <path d={`${pathOf(cur)} Z`} className="env-fill" />
        <path d={pathOf(cur)} className="env-line" />
        {corners.map((c) => (
          <circle key={c.name} cx={c.x} cy={c.y} r={ghost[c.name] !== undefined ? 5 : 4} className="env-corner" data-by={ghost[c.name] !== undefined ? 'agent' : undefined} data-testid={`env-corner-${c.name}`} tabIndex={0} role="slider" aria-label={`Envelope ${c.label}`}
            aria-valuenow={patch[c.name]} aria-valuemin={classicField(c.name)!.min} aria-valuemax={classicField(c.name)!.max}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              (e.target as Element).setPointerCapture(e.pointerId);
              // the scale is held during the drag, so the corner under the pointer does not run away from it
              const sc = { t: tMax, y: yMax };
              setScale(sc);
              drag.current = { name: c.name, scaleT: sc.t, scaleY: sc.y, v: patch[c.name], moved: false };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d || d.name !== c.name) return;
              d.v = apply(c.name, e.clientX, e.clientY, { t: d.scaleT, y: d.scaleY });
              d.moved = true;
              onDraft(c.name, d.v);
            }}
            onPointerUp={() => {
              const d = drag.current;
              drag.current = null;
              setScale(null);
              if (d?.moved) onCommit(d.name, d.v);
            }}
            onKeyDown={(e) => {
              const k = e.key;
              const st = (e.shiftKey ? 0.001 : 0.01) * (k === 'ArrowUp' || k === 'ArrowRight' ? 1 : k === 'ArrowDown' || k === 'ArrowLeft' ? -1 : 0);
              if (!st) return;
              e.preventDefault();
              const f = classicField(c.name)!;
              onCommit(c.name, roundParam(c.name, Math.min(f.max, Math.max(f.min, patch[c.name] + st))));
            }} />
        ))}
      </svg>
    </div>
  );
}

// ---- the page ---------------------------------------------------------------------------------------------

export function ClassicEditor({ store, id }: { store: Store; id: string }) {
  const sound = store.sounds.find((s) => s.id === id);
  const [draft, setDraft] = useState<Edits>({});
  const [amount, setAmount] = useState(MUTATE_AMOUNT);
  const [selected, setSelected] = useState<ClassicKey | null>(null);
  const [inspector, toggleInspector] = useInspectorOpen();
  const [askFocus, setAskFocus] = useState(0);
  const [axis, setAxis] = useState<Axis | null>(null);
  const latest = useRef({ sound, store, id });
  latest.current = { sound, store, id };
  const release = useRef<ReturnType<typeof setTimeout> | null>(null);

  const co = useMemo(() => new Coalescer((edits) => {
    const { sound: cur, store: st, id: sid } = latest.current;
    const clear = () => setDraft((d) => {
      const next = { ...d };
      for (const [k, v] of Object.entries(edits)) if (next[k as ClassicKey | 'seed'] === v) delete next[k as ClassicKey | 'seed'];
      return next;
    });
    if (!cur || cur.voice !== 'classic') { clear(); return; }
    const d = diffPatch(cur.patch, withEdits(cur.patch, edits));
    if (!Object.keys(d).length) { clear(); return; }
    void st.run(setCommand(sid, d)).then(clear);
  }, sched, PAUSE_MS), []);
  useEffect(() => () => { co.cancel(); if (release.current) clearTimeout(release.current); }, [co]);

  const key = sound ? store.keyOf(sound) : '';
  const prevKey = useRef(key);
  useEffect(() => {
    const was = prevKey.current;
    prevKey.current = key;
    // Not when the sound first arrives (opening the page must be silent), only when it changes.
    if (!was || !key || was === key) return;
    if (sound && store.playOnChange) void store.playDoc(id, sound, id, undefined, true);
  }, [key, sound, store, id]);

  const prov = store.provenance(id);
  const now = Date.now();

  const cls = sound?.voice === 'classic';
  const patch = cls ? withEdits((sound as Extract<Sound, { voice: 'classic' }>).patch, draft) : null;
  const now1 = (cmd: string) => { co.flush(); return store.run(cmd); };
  const mutate = () => void now1(`sound mutate ${id} amount=${amount} seed=${randomSeed()}`);

  const actions: Action[] = [
    { id: 'edit.mutate', label: 'Mutate the sound', group: 'Edit', shortcut: 'M', key: 'm', run: mutate, enabled: () => cls, keywords: 'random variation' },
    { id: 'panel.inspector', label: 'Toggle the inspector', group: 'Panels', shortcut: '⌥ 2', key: 'alt+2', override: true, run: () => toggleInspector() },
    { id: 'edit.ask', label: 'Ask for changes on the selection', group: 'Edit', shortcut: 'R', key: 'r', override: true, run: () => { toggleInspector(true); setAskFocus((n) => n + 1); }, keywords: 'request agent feedback' },
    { id: 'edit.hearBefore', label: 'Hear the selected control before the agent’s change, then now', group: 'Edit', run: () => hearBefore(), enabled: () => !!selected && agentSet(prov, prov.params.get(selected)) },
  ];
  useActions(cls ? actions : []);

  if (!sound) {
    return <section className="editor"><a href="#/" className="back">← all sounds</a><p className="empty" data-testid="editor-missing">No sound “{id}”.</p></section>;
  }
  if (sound.voice !== 'classic' || !patch) {
    return (
      <section className="editor" data-testid="editor">
        <a href="#/" className="back" data-testid="back">← all sounds</a>
        <h2>{sound.id}</h2>
        <p className="dim" data-testid="editor-tone">This sound uses the placeholder tone voice, which has no editor. Make it again as a classic sound (<code>sound new {sound.id}2 voice=classic</code>) to edit its 25 parameters here.</p>
      </section>
    );
  }

  const committed = sound.patch;
  const move = (name: ClassicKey, v: number) => {
    const r = roundParam(name, v);
    setDraft((d) => ({ ...d, [name]: r }));
    co.push(name, r);
  };
  const preview = (name: ClassicKey, v: number) => setDraft((d) => ({ ...d, [name]: roundParam(name, v) }));
  const doRelease = () => {
    if (release.current) clearTimeout(release.current);
    release.current = setTimeout(() => { release.current = null; co.flush(); }, DOUBLE_CLICK_MS);
  };
  const commit = (name: ClassicKey, v: number) => { setSelected(name); move(name, v); doRelease(); };

  const trailOf = (name: ClassicKey) => prov.params.get(name);
  const isAgentSet = (name: ClassicKey): boolean => agentSet(prov, trailOf(name));
  const agentProp = (name: ClassicKey): { prev?: number } | false => {
    const t = trailOf(name);
    if (!agentSet(prov, t)) return false;
    return typeof t.prev === 'number' && t.prev !== committed[name] ? { prev: t.prev } : { };
  };
  const ghosts: Partial<Record<ClassicKey, number>> = {};
  for (const n of ['attack', 'sustain', 'punch', 'decay'] as const) { const t = trailOf(n); if (agentSet(prov, t) && typeof t.prev === 'number') ghosts[n] = t.prev; }

  const hearBefore = () => {
    if (!selected) return;
    const t = trailOf(selected);
    if (!t || typeof t.prev !== 'number') return;
    void store.playPair(id, { ...sound, patch: { ...committed, [selected]: t.prev } }, sound);
  };

  const data = store.lens(sound);
  const hasDraft = Object.keys(draft).length > 0;
  const live = hasDraft ? store.render({ ...sound, patch }) : null;
  const failing = new Set<number>();
  for (const c of data?.checks ?? []) if (!c.pass && CHECK_MODULE[c.name]) failing.add(CHECK_MODULE[c.name]!);
  const playing = store.playing === id;
  const anyAgent = Object.keys(Object.fromEntries([...prov.params].filter(([, t]) => agentSet(prov, t)))).length > 0;
  const outline = anyAgent ? prov.beforeAgent : null;
  const lastAgent = [...prov.params.values()].filter((t) => agentSet(prov, t)).sort((a, b) => b.seq - a.seq)[0];
  const checkKind = (n: string): CheckKind => { const c = data?.checks.find((x) => x.name === n); return !data ? 'checking' : c && !c.pass ? 'fail' : 'pass'; };

  const knob = (name: ClassicKey, size = 40) => {
    const f = classicField(name)!;
    const a = agentProp(name);
    return (
      <div key={name} className={`knob-slot${selected === name ? ' sel' : ''}`} data-testid={`slot-${name}`} onFocusCapture={() => setSelected(name)} onPointerDownCapture={() => setSelected(name)}>
        <Knob label={CLASSIC_LABEL[name]} testId={`knob-${name}`} value={patch[name]} min={f.min} max={f.max} def={f.default} step={0.01} bipolar={isBipolar(name)} spec={classicSpec(name)} size={size} agent={a}
          onDraft={(v) => preview(name, v)} onCommit={(v) => commit(name, v)} onHearBefore={() => { setSelected(name); const t = trailOf(name); if (t && typeof t.prev === 'number') void store.playPair(id, { ...sound, patch: { ...committed, [name]: t.prev } }, sound); }} />
      </div>
    );
  };

  const selTrail = selected ? trailOf(selected) : undefined;
  const selAgent = !!selected && agentSet(prov, selTrail);
  const selNote = selTrail ? answeredNote(store.requests, id, selTrail.by, selTrail.at) : null;
  const selPrev = selTrail && typeof selTrail.prev === 'number' ? selTrail.prev : null;
  const spec = selected ? classicSpec(selected) : null;
  const revert = () => { if (selected && selPrev !== null) void now1(setCommand(id, { [selected]: selPrev } as Edits)); };

  return (
    <section className="editor classic" data-testid="editor" data-sound={id} data-voice="classic">
      <header className="editor-head">
        <a href="#/" className="back" data-testid="back">← all sounds</a>
        <h2>{sound.id}</h2>
        <span className="chip voice-chip">classic voice</span>
        <span className={`chip status-${sound.status}`}>{sound.status}</span>
        {(['click', 'loudness', 'tail', 'harsh', 'clip', 'dc'] as const).map((n) => { const c = data?.checks.find((x) => x.name === n); return c && !c.pass ? <Badge key={n} kind="fail" testId={`check-${n}`}>{` ${n}`}</Badge> : null; })}
        {data && data.checks.every((c) => c.pass) && <Badge kind="pass" testId="check-all">all checks</Badge>}
        <Numbers store={store} sound={sound} />
        <LoudnessClass store={store} sound={sound} />
        <span className="spacer" />
        <a className="link-btn" href={`#/sound/${id}/analysis`} data-testid="open-analysis">Analysis ↗</a>
        <button className="play" data-testid="editor-play" data-playing={playing} onClick={() => void store.play(id)}>{playing ? '■ Stop' : '▶ Play'} <span className="dim">space</span></button>
        <button data-testid="editor-stop" onClick={() => store.stop()} disabled={!store.playing}>■ Stop</button>
        <label className="toggle"><input type="checkbox" data-testid="play-on-change" checked={store.playOnChange} onChange={(e) => { store.playOnChange = e.target.checked; store.changed(); }} /> play on change</label>
        <button data-testid="editor-undo" disabled={!store.canUndo()} onClick={() => void store.undo()}>Undo</button>
        <button data-testid="editor-redo" disabled={!store.canRedo()} onClick={() => void store.redo()}>Redo</button>
        <button type="button" className={`link-btn${inspector ? ' on' : ''}`} aria-pressed={inspector} data-testid="inspector-toggle" onClick={() => toggleInspector()} title="Inspector (⌥2)">Inspector</button>
      </header>

      <div className="classic-grid" data-inspector={inspector || undefined}>
        <div className="classic-main">
          <div className="gen-bar" data-testid="generators" aria-label="Generators">
            <span className="cap">Generate</span>
            <div className="gen-btns">
              {GENERATOR_NAMES.map((c) => <button key={c} className="btn btn-secondary" data-testid={`gen-${c}`} onClick={() => void now1(`sound generate ${id} ${c} seed=${randomSeed()}`)}>{c}</button>)}
            </div>
            <span className="spacer" />
            <label className="gen-amount">amount
              <input type="number" min={0.01} max={1} step={0.01} value={amount} data-testid="mutate-amount" onChange={(e) => setAmount(Math.min(1, Math.max(0.01, Number(e.target.value) || MUTATE_AMOUNT)))} />
            </label>
            <button className="btn btn-secondary" data-testid="mutate" onClick={mutate}>Mutate <kbd className="kbd">M</kbd></button>
            <label className="seed" title="The noise seed; auto is a hash of the 25 values">Seed
              <input type="number" min={0} step={1} data-testid="seed" className="mono" placeholder="auto" value={patch.seed ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, seed: e.target.value === '' ? 'auto' : Math.max(0, Math.floor(Number(e.target.value))) }))}
                onBlur={() => { if (draft.seed !== undefined) { co.push('seed', draft.seed); co.flush(); } }}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
            </label>
            <button className="link-btn" data-testid="seed-auto" disabled={committed.seed === undefined} onClick={() => void now1(setCommand(id, { seed: 'auto' }))}>auto</button>
          </div>

          <LensPanel store={store} sound={sound} live={live} height={220} prov={prov} outline={outline} previous={prov.before} onAxis={setAxis} />
          <div className="dim hash">samples {store.hashOf(sound).slice(0, 12)}</div>

          <section className="modules" data-testid="params-editor">
            {CLASSIC_MODULES.map((m) => {
              const off = moduleOff(m, patch as unknown as Record<string, number>);
              const bad = failing.has(m.id);
              const group = EDITOR_GROUPS.find((g) => g.params.some((p) => m.params.includes(p as ClassicKey)));
              return (
                <div key={m.id} className={`module${off ? ' off' : ''}${bad ? ' bad' : ''}${m.id === 1 ? ' wide' : ''}`} data-testid={`module-${m.id}`} data-off={off || undefined} data-group={group?.id}>
                  <div className="module-head">
                    <span className="cap">{m.id} · {m.name}</span>
                    <span className="spacer" />
                    <span className="module-note" data-tone={bad ? 'fail' : undefined}>{bad ? <><span className="mono" aria-hidden>×</span> {Object.entries(CHECK_MODULE).filter(([n, mid]) => mid === m.id && data?.checks.some((c) => c.name === n && !c.pass)).map(([n]) => n).join(', ')} lives here</> : off ? 'off' : m.id === 1 ? 'drag the corners' : m.note}</span>
                  </div>
                  {m.id === 1 && <EnvelopeDraw patch={patch} ghost={ghosts} onDraft={preview} onCommit={commit} />}
                  {m.id === 5 && (
                    <Segmented label="Wave" value={WAVE_NAMES[patch.wave]!} onChange={(w) => commit('wave', WAVE_NAMES.indexOf(w as (typeof WAVE_NAMES)[number]))}
                      options={WAVE_NAMES.map((w) => ({ value: w, label: w, testId: `wave-${w}` }))} />
                  )}
                  <div className="module-knobs">{m.params.filter((p) => p !== 'wave').map((p) => knob(p, m.id === 1 ? 44 : 40))}</div>
                </div>
              );
            })}
          </section>
        </div>

        {inspector && (
          <aside className="inspector" data-testid="inspector" aria-label="Inspector">
            <div className="insp-sec" data-testid="insp-control">
              <span className="cap">{selected ? `Selected · ${CLASSIC_LABEL[selected]}` : 'Selected'}</span>
              {selected && spec ? (
                <>
                  <div className="insp-value"><span className="mono insp-now" data-by={selAgent ? 'agent' : undefined} data-testid="insp-value">{formatValue(patch[selected], spec)}</span>
                    {selPrev !== null && <span className="mono insp-was" data-testid="insp-was">was {formatValue(selPrev, spec)}</span>}</div>
                  <div className="insp-by" data-testid="insp-by">
                    {selTrail ? <><AuthorChip by={selTrail.by.startsWith('agent:') ? 'agent' : 'you'}>{selTrail.by.startsWith('agent:') ? 'agent' : 'you'}</AuthorChip> set {selTrail.at ? ago(selTrail.at, now) : `#${selTrail.seq}`}{selNote ? <> · <q className="insp-note" data-testid="insp-note">{selNote}</q></> : null}</> : <span className="dim">not changed since the sound was made</span>}
                  </div>
                  <div className="insp-btns">
                    <Button testId="hear-before" disabled={selPrev === null} onClick={hearBefore} title="Play the sound with the value before, then now (⌥-click a knob does the same)">Hear before <kbd className="kbd">⌥</kbd></Button>
                    <Button testId="revert" disabled={selPrev === null} onClick={revert} title="Write the value before as your own change">Revert</Button>
                  </div>
                  <span className="insp-hint">Drag ↕ to change · ⇧ fine ×0.1 · double-click resets · type a value: 110ms, 0.11, +10%</span>
                </>
              ) : <span className="dim small">Click or focus a knob to see who set it and when.</span>}
            </div>
            <div className="insp-sec">
              <span className="cap">Numbers</span>
              {data ? (
                <dl className="insp-nums" data-testid="insp-numbers">
                  {([['Integrated', `${Number.isFinite(data.analysis.lufs) ? data.analysis.lufs.toFixed(1).replace('-', '−') : '−∞'} LUFS`, checkKind('loudness')], ['True peak', `${data.analysis.truePeakDb.toFixed(1).replace('-', '−')} dBTP`, checkKind('clip')], ['Crest', `${data.analysis.crestDb.toFixed(1)} dB`, null], ['Attack', `${(data.analysis.attack * 1000).toFixed(0)} ms`, null], ['Tail −60 dB', `${data.analysis.tail.toFixed(2)} s`, checkKind('tail')], ['Centroid', `${(data.analysis.centroid.mean / 1000).toFixed(1)} kHz`, null], ['Onsets', String(data.analysis.onsets), null]] as [string, string, CheckKind | null][]).map(([k, v, c]) => (
                    <div key={k}><dt>{k}</dt><dd className="mono">{c && <Badge kind={c}>{''}</Badge>}{v}</dd></div>
                  ))}
                </dl>
              ) : <span className="dim small">measuring…</span>}
            </div>
            <div className="insp-sec insp-grow">
              <span className="cap">History · this sound</span>
              <HistoryList store={store} id={id} />
            </div>
            <div className="insp-sec">
              <AskComposer store={store} id={id} selection={axis?.sel ?? null} focusToken={askFocus} />
              <div className="insp-btns">
                <Button kind="primary" testId="insp-approve" onClick={() => void store.approve(id)} disabled={sound.status === 'approved' && !lastAgent}>Approve</Button>
                {lastAgent && <span className="insp-agent-note" data-testid="insp-agent-note"><AuthorChip by="agent" proposed>proposed · not yet approved</AuthorChip></span>}
              </div>
            </div>
            <details className="insp-more" open>
              <summary className="cap">A / B, loop and export</summary>
              <AB store={store} sound={sound} />
              <LoopPanel store={store} sound={sound} />
              <section className="panel" data-testid="export" aria-label="Export">
                <h3>Export</h3>
                <div className="row wrap">
                  <button data-testid="export-wav" onClick={() => download(`${id}.wav`, store.wavOf(sound), 'audio/wav')}>WAV</button>
                  <button data-testid="export-patch" onClick={() => download(`${id}.sfxr`, patchFileText(sound.patch), 'text/plain')}>Patch text</button>
                  <button data-testid="export-csv" onClick={() => download(`${id}.csv`, csvFileText(id, sound.patch), 'text/csv')}>CSV row</button>
                </div>
                <p className="dim">WAV is the pre-rendered form (16-bit, 44,100 Hz, mono); patch text and the CSV row are what a pack's synth table takes.</p>
              </section>
            </details>
          </aside>
        )}
      </div>
    </section>
  );
}
