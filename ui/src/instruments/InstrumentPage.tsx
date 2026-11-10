// `#/instrument/<id>`: a sampled instrument. The key-map (keys across, velocity up, every zone a labelled box that wears its check as a glyph and a word),
// edge handles that write one `instrument zone set` when let go, a sample dropped on a key (or the Add zone dialog) that writes `instrument zone add`
// with the sample's measured root, the zone's numbers, the check's findings, and playing: click the piano strip, the computer keyboard, or a MIDI
// keyboard when the browser offers one. Every gesture is a command an agent could have written.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { noteLabel, parseNote, decodeMeasure, type Instrument, type Zone } from '@soundclaw/core';
import type { SampleCard, SampleInfo } from '@soundclaw/server/protocol';
import { Dialog } from '../samples/Dialog.tsx';
import type { Store } from '../store.ts';
import { Badge, Button, Segmented, useToast } from '../studio/controls.tsx';
import { Play, Stop } from '../studio/icons.tsx';
import { LicenceBadge } from '../studio/Library.tsx';
import { useActions, type Action } from '../studio/registry.ts';
import { SAMPLE_MIME } from '../studio/Samples.tsx';
import { plural } from '../studio/values.ts';
import { fetchInstrumentCheck, type CheckReply } from './api.ts';
import { computerNote, dragTo, dropZone, geometry, keyAtX, keyRange, keysText, moveEdge, parseMidiMessage, velAtY, velText, xOfKey, yOfVel, zoneSetCommand, type DropSample, type Edge, type Geometry, type Span } from './keymap.ts';
import { LivePlayer, type NoteLength } from './player.ts';

const WORD = { ok: 'ok', warn: 'warning', fail: 'fault' } as const;
const GLYPH = { ok: '✓', warn: '!', fail: '×' } as const;
const BLACK = new Set([1, 3, 6, 8, 10]);

type Status = keyof typeof WORD;

export function InstrumentPage({ store, id }: { store: Store; id: string }) {
  const inst = store.instruments.find((x) => x.id === id) ?? null;
  if (!inst) {
    const builtin = store.lookupInstrument(id);
    return (
      <section className="instrument-page" data-testid="instrument-page" data-instrument={id}>
        <a href="#/" className="back">{'←'} library</a>
        {builtin ? <BuiltIn store={store} inst={builtin} /> : <p className="empty" data-testid="instrument-missing">{store.status === 'open' ? `No instrument “${id}” in this project.` : 'Connecting…'}</p>}
      </section>
    );
  }
  return <InstrumentView key={id} store={store} inst={inst} />;
}

/** A built-in synth instrument has no zones to edit; it can still be played. */
function BuiltIn({ store, inst }: { store: Store; inst: Instrument }) {
  const player = useMemo(() => new LivePlayer(store), [store]);
  return (
    <>
      <header className="ip-head"><h1 data-testid="instrument-title">{inst.id}</h1><span className="chip-c">built-in synth voice</span></header>
      <p className="dim" data-testid="instrument-builtin">This instrument is built in and has no zones. Make an editable copy with <code className="mono">instrument new &lt;id&gt; from={inst.id}</code>, or play it here.</p>
      <PlayBar store={store} inst={inst} player={player} />
    </>
  );
}

function useCheck(store: Store, inst: Instrument): { check: CheckReply | null; error: string | null; busy: boolean } {
  const [state, setState] = useState<{ check: CheckReply | null; error: string | null; busy: boolean }>({ check: null, error: null, busy: !!inst.zones?.length });
  // the check follows the zones and the audio under their names
  const names = new Set((inst.zones ?? []).map((z) => z.sample));
  const stamp = JSON.stringify(inst.zones ?? []) + JSON.stringify(inst.voice.layers.length) + store.samples.filter((x) => names.has(x.name)).map((x) => x.sha256).join(',');
  useEffect(() => {
    if (!inst.zones?.length) { setState({ check: null, error: null, busy: false }); return; }
    let live = true;
    setState((s) => ({ ...s, busy: true }));
    const t = setTimeout(() => {
      fetchInstrumentCheck(store, inst.id).then((c) => { if (live) setState({ check: c, error: null, busy: false }); }, (e: Error) => { if (live) setState({ check: null, error: e.message, busy: false }); });
    }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [store, inst.id, stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

function InstrumentView({ store, inst }: { store: Store; inst: Instrument }) {
  const toast = useToast();
  const zones = inst.zones ?? [];
  const { check, error, busy } = useCheck(store, inst);
  const [sel, setSel] = useState<number | null>(null);
  const [dialog, setDialog] = useState<'add' | null>(null);
  const player = useMemo(() => new LivePlayer(store), [store]);
  const status = (k: number): Status => check?.zones[k]?.status ?? 'ok';
  const worst: Status | null = !check ? null : check.zones.some((z) => z.status === 'fail') || check.findings.some((f) => f.severity === 'fail') ? 'fail' : check.findings.length ? 'warn' : 'ok';
  const names = [...new Set(zones.map((z) => z.sample))];
  const infos = names.map((n) => store.samples.find((x) => x.name === n)).filter((x): x is SampleInfo => !!x);
  const missing = names.filter((n) => !store.samples.some((x) => x.name === n));
  const licenceWorst = infos.find((x) => x.licenceState === 'blocked') ?? infos.find((x) => x.licenceState === 'unknown') ?? infos.find((x) => x.licenceState === 'attribution') ?? infos[0];

  // the samples the zones name are fetched so a key plays; the rendered notes are forgotten when anything under them changes
  useEffect(() => { void store.ensureSampleNames(names).then(() => player.clear()); }, [store, names.join(','), infos.map((x) => x.sha256).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { player.clear(); }, [player, JSON.stringify(zones)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => player.allOff(), [player]);
  useEffect(() => { if (sel !== null && sel >= zones.length) setSel(zones.length ? zones.length - 1 : null); }, [zones.length, sel]);

  const run = useCallback(async (cmd: string, done?: string): Promise<boolean> => {
    const r = await store.run(cmd);
    if (r.ok) { if (done) toast(done); return true; }
    toast(r.errors.map((e) => e.message).join('; '), 'error');
    return false;
  }, [store, toast]);

  const actions: Action[] = [
    { id: 'instrument.add', label: 'Instrument: add a zone', group: 'Instruments', run: () => setDialog('add'), keywords: 'sample key zone' },
    { id: 'instrument.play', label: 'Instrument: play a note at its root', group: 'Instruments', run: () => { void player.noteOn(inst, inst.root, 100, 0.8); }, keywords: 'audition' },
    { id: 'instrument.keys', label: 'Instrument: play with the computer keyboard (A W S E D F …, Z X shift the octave)', group: 'Instruments', shortcut: 'A–;', local: true, noPalette: true, run: () => undefined },
    { id: 'instrument.octave', label: 'Instrument: octave down or up', group: 'Instruments', shortcut: 'Z X', local: true, noPalette: true, run: () => undefined },
  ];
  useActions(actions);

  return (
    <section className="instrument-page" data-testid="instrument-page" data-instrument={inst.id}>
      <header className="ip-head">
        <a href="#/" className="back" data-testid="instrument-back">{'←'} library</a>
        <h1 data-testid="instrument-title">{inst.id}</h1>
        <span className="chip-c" data-testid="instrument-zones-count">{plural(zones.length, 'zone')}</span>
        {worst && <Badge kind={worst === 'ok' ? 'pass' : worst === 'warn' ? 'warn' : 'fail'} testId="instrument-check-badge" title="the instrument's check">{worst === 'ok' ? 'check passes' : worst === 'warn' ? 'check warns' : 'check fails'}</Badge>}
        {busy && <span className="dim mono" data-testid="instrument-checking">checking{'…'}</span>}
        {licenceWorst && <LicenceBadge state={licenceWorst.licenceState} licence={licenceWorst.licence} testId="instrument-licence" />}
        <span className="grow" />
        <Button kind="secondary" testId="instrument-add" onClick={() => setDialog('add')}>Add zone{'…'}</Button>
      </header>
      {error && <p className="smp-error" role="alert" data-testid="instrument-check-error"><span className="mono" aria-hidden>!</span> {error}</p>}
      {missing.length > 0 && <p className="smp-error warn" role="status" data-testid="instrument-missing-samples"><span className="mono" aria-hidden>!</span> zones name samples the project does not have: {missing.join(', ')}</p>}

      <KeyMap store={store} inst={inst} check={check} sel={sel} onSelect={setSel} run={run} player={player} />
      <PlayBar store={store} inst={inst} player={player} />

      <div className="ip-lower">
        <div className="ip-col">
          <h2 className="cap">Zones</h2>
          {zones.length === 0
            ? <div className="smp-empty" data-testid="instrument-empty"><p>No zones yet.</p><p className="dim">Drag a sample from the Samples tab onto a key above, or use Add zone. An agent builds them with <code className="mono">instrument zones {inst.id} from-samples …</code>.</p></div>
            : <ZoneTable store={store} inst={inst} check={check} sel={sel} onSelect={setSel} status={status} />}
        </div>
        <div className="ip-col">
          {sel !== null && zones[sel] && <ZoneEditor key={`${sel}:${JSON.stringify(zones[sel])}`} store={store} inst={inst} n={sel} zone={zones[sel]!} check={check} run={run} onRemoved={() => setSel(null)} />}
          <h2 className="cap">Check <span className="dim">{check ? `${plural(check.findings.length, 'finding')}` : ''}</span></h2>
          <ul className="ip-findings" data-testid="instrument-findings">
            {check && check.findings.length === 0 && <li data-testid="finding-none"><Badge kind="pass">ok</Badge><span>no findings: every key and velocity in range has a zone, the pitches and levels agree</span></li>}
            {check?.findings.map((f, i) => (
              <li key={i} data-severity={f.severity} data-check={f.check} data-testid={`finding-${i}`}>
                <Badge kind={f.severity === 'fail' ? 'fail' : 'warn'}>{f.severity === 'fail' ? 'fault' : 'warning'}</Badge>
                <span>{f.message}{f.zones.length > 0 && <> {f.zones.map((n) => <button key={n} type="button" className="link-btn mono" onClick={() => setSel(n - 1)}>zone {n}</button>)}</>}</span>
              </li>
            ))}
            {!check && !error && zones.length > 0 && <li className="dim">measuring the zones{'…'}</li>}
          </ul>
        </div>
      </div>
      {dialog === 'add' && <AddZoneDialog store={store} inst={inst} run={run} onClose={() => setDialog(null)} />}
    </section>
  );
}

// ---- the key-map ------------------------------------------------------------------------------------------------------------

interface KeyMapProps { store: Store; inst: Instrument; check: CheckReply | null; sel: number | null; onSelect(n: number | null): void; run(cmd: string, done?: string): Promise<boolean>; player: LivePlayer }

interface Drag { n: number; edge: Edge; start: Span; now: Span }

function KeyMap({ store, inst, check, sel, onSelect, run, player }: KeyMapProps) {
  const toast = useToast();
  const zones = inst.zones ?? [];
  const keyZones = zones.map((z, k) => ({ z, k })).filter(({ z }) => z.hit === null);
  const hits = [...new Set(zones.filter((z) => z.hit !== null).map((z) => z.hit!))];
  const [a, b] = useMemo(() => keyRange(zones, inst.range), [zones, inst.range]);
  const g = useMemo(() => geometry(a, b), [a, b]);
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [over, setOver] = useState<{ key: number; vel: number } | null>(null);
  const [draft, setDraft] = useState<{ n: number; edge: Edge; span: Span } | null>(null);

  // pointer position in the grid's own units
  const at = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = svg.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * g.width, y: ((e.clientY - r.top) / r.height) * g.height };
  };
  const spanOf = (z: Zone): Span => ({ keys: [z.keys[0], z.keys[1]], vel: [z.vel[0], z.vel[1]] });
  const shown = (k: number, z: Zone): Span => (drag && drag.n === k ? drag.now : draft && draft.n === k ? draft.span : spanOf(z));

  const startDrag = (e: React.PointerEvent, n: number, edge: Edge) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    onSelect(n);
    const s = spanOf(zones[n]!);
    setDrag({ n, edge, start: s, now: s });
  };
  const moveDrag = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = at(e);
    setDrag({ ...drag, now: dragTo(g, drag.start, drag.edge, p.x, p.y) });
  };
  const endDrag = async () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    const cmd = zoneSetCommand(inst.id, d.n + 1, d.start, d.now);
    if (cmd) await run(cmd);
  };
  // keyboard: arrows move an edge a key or a velocity step (shift: an octave, ten steps) and Enter writes it
  const onEdgeKey = async (e: React.KeyboardEvent, n: number, edge: Edge) => {
    const z = zones[n]!;
    const base = draft && draft.n === n ? draft.span : spanOf(z);
    const big = e.shiftKey;
    const dk = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const dv = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (draft && draft.n === n) { const cmd = zoneSetCommand(inst.id, n + 1, spanOf(z), draft.span); setDraft(null); if (cmd) await run(cmd); }
      return;
    }
    if (e.key === 'Escape') { setDraft(null); return; }
    if (!dk && !dv) return;
    e.preventDefault();
    const horizontal = edge === 'left' || edge === 'right';
    if (horizontal && !dk) return;
    if (!horizontal && !dv) return;
    const step = horizontal ? dk * (big ? 12 : 1) : dv * (big ? 10 : 1);
    const cur = edge === 'left' ? base.keys[0] : edge === 'right' ? base.keys[1] : edge === 'top' ? base.vel[1] : base.vel[0];
    const moved = moveEdge(base, edge, horizontal ? cur + step : 0, horizontal ? 0 : cur + step);
    setDraft({ n, edge, span: moved });
  };

  const stackOf = new Map<string, number>();
  const boxes = keyZones.map(({ z, k }) => {
    const s = shown(k, z);
    const sk = `${z.keys.join('-')}|${z.vel.join('-')}|${z.trigger}`;
    const stack = stackOf.get(sk) ?? 0;
    stackOf.set(sk, stack + 1);
    const x0 = xOfKey(g, s.keys[0]) + stack * 2, x1 = xOfKey(g, s.keys[1] + 1) - 1 + stack * 2;
    const y0 = yOfVel(g, s.vel[1]) + stack * 2, y1 = yOfVel(g, s.vel[0] - 1) - 1 + stack * 2;
    return { z, k, s, x0, x1, y0, y1, st: (check?.zones[k]?.status ?? 'ok') as Status };
  });

  const sampleFromEvent = (e: React.DragEvent): string | null => e.dataTransfer.getData(SAMPLE_MIME) || null;
  const hasSample = (e: React.DragEvent): boolean => [...e.dataTransfer.types].includes(SAMPLE_MIME);
  const onDrop = async (e: React.DragEvent) => {
    const name = sampleFromEvent(e);
    setOver(null);
    if (!name) return;
    e.preventDefault();
    const p = at(e);
    const key = keyAtX(g, p.x);
    const info = store.samples.find((x) => x.name === name);
    if (!info) { toast(`No sample ${name} in this project.`, 'error'); return; }
    const s: DropSample = { name, root: info.root };
    if (!info.root) {
      try {
        const r = await fetch(`/api/sample-card/${info.sha256}.json?token=${encodeURIComponent(store.token)}`);
        if (r.ok) { const m = decodeMeasure(((await r.json()) as SampleCard).measure); s.pitch = m.pitch ? { note: m.pitch.note, cents: m.pitch.cents } : null; s.pitched = m.pitched; }
      } catch { /* an unmeasured sample is rooted at the key */ }
    }
    const d = dropZone(inst.id, s, key);
    await run(d.command, `Added a zone for ${name} on ${keysText([Math.max(0, key - 1), Math.min(127, key + 1)])}: ${d.note}`);
  };

  return (
    <div className="ip-map" data-testid="keymap">
      <div className="ip-map-scroll">
        <svg ref={svg} className="ip-svg" viewBox={`0 0 ${g.width} ${g.height}`} role="group" aria-label={`Key-map of ${inst.id}: keys across, velocity up`} data-testid="keymap-svg"
          data-a={g.a} data-b={g.b}
          onPointerMove={moveDrag} onPointerUp={() => void endDrag()} onPointerCancel={() => setDrag(null)}
          onPointerDown={(e) => { const p = at(e); onSelect(null); void player.noteOn(inst, keyAtX(g, p.x), velAtY(g, p.y), 0.6); }}
          onDragOver={(e) => { if (hasSample(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; const p = at(e); setOver({ key: keyAtX(g, p.x), vel: velAtY(g, p.y) }); } }}
          onDragLeave={() => setOver(null)} onDrop={(e) => void onDrop(e)}>
          {/* the grid */}
          {Array.from({ length: b - a + 1 }, (_, i) => a + i).filter((m) => m % 12 === 0 || m === a).map((m) => <line key={m} className={m % 12 === 0 ? 'km-octave' : 'km-grid'} x1={xOfKey(g, m)} x2={xOfKey(g, m)} y1={g.top} y2={g.top + g.gridH} />)}
          {[32, 64, 96, 127].map((v) => <g key={v}><line className="km-grid" x1={g.left} x2={g.width - 10} y1={yOfVel(g, v)} y2={yOfVel(g, v)} /><text className="km-label" x={g.left - 6} y={yOfVel(g, v) + 3} textAnchor="end">{v}</text></g>)}
          {Array.from({ length: b - a + 1 }, (_, i) => a + i).filter((m) => m % 12 === 0).map((m) => <text key={m} className="km-label" x={xOfKey(g, m) + 3} y={g.top + g.gridH + 13}>{noteLabel(m)}</text>)}
          {inst.range && <g data-testid="keymap-range"><line className="km-range" x1={xOfKey(g, inst.range[0])} x2={xOfKey(g, inst.range[1] + 1)} y1={g.top + g.gridH + 24} y2={g.top + g.gridH + 24} /><text className="km-label" x={xOfKey(g, inst.range[0])} y={g.top + g.gridH + 37}>range {noteLabel(inst.range[0])}–{noteLabel(inst.range[1])}</text></g>}
          {over && <rect className="km-over" data-testid="keymap-drop-target" x={xOfKey(g, Math.max(g.a, over.key - 1))} y={g.top} width={g.keyW * (Math.min(g.b, over.key + 1) - Math.max(g.a, over.key - 1) + 1)} height={g.gridH} />}
          {/* the zones */}
          {[...boxes].sort((p, q) => Number(p.k === sel) - Number(q.k === sel) || Number(q.z.trigger === 'release') - Number(p.z.trigger === 'release')).map(({ z, k, s, x0, x1, y0, y1, st }) => {
            const on = sel === k;
            const room = Math.floor((x1 - x0 - 6) / 6.2);
            const lines = [`${GLYPH[st]} ${k + 1} ${z.sample}`, `${z.trigger === 'release' ? 'release ' : ''}root ${noteLabel(z.root)}${check?.zones[k]?.pitchCents != null ? ` ${check.zones[k]!.pitchCents! > 0 ? '+' : ''}${check.zones[k]!.pitchCents}c` : ''}`, `${z.rr ? `rr ${z.rr[0]}/${z.rr[1]} ` : ''}${z.loopmode !== 'sustain' ? z.loopmode : ''}`];
            return (
              <g key={k} className={`km-zone${on ? ' sel' : ''}`} data-status={st} data-release={z.trigger === 'release' || undefined} data-testid={`zone-${k + 1}`} data-keys={s.keys.join('-')} data-vel={s.vel.join('-')}
                tabIndex={0} role="button" aria-pressed={on} aria-label={`zone ${k + 1}: ${z.sample}, keys ${keysText(s.keys)}, velocity ${velText(s.vel)}, ${WORD[st]}`}
                onPointerDown={(e) => { e.stopPropagation(); onSelect(k); }} onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onSelect(k); } }}>
                <title>{`zone ${k + 1}: ${z.sample}, keys ${keysText(s.keys)}, velocity ${velText(s.vel)}, ${WORD[st]}`}</title>
                <rect className="km-box" x={x0} y={y0} width={Math.max(2, x1 - x0)} height={Math.max(2, y1 - y0)} />
                {lines.map((t, i) => (y1 - y0 > 16 + i * 13 && room > 3 && t.trim()) ? <text key={i} className="km-text" x={x0 + 4} y={z.trigger === 'release' ? y1 - 5 - (lines.length - 1 - i) * 13 : y0 + 13 + i * 13}>{t.slice(0, room)}</text> : null)}
                {on && (['left', 'right', 'top', 'bottom'] as Edge[]).map((edge) => {
                  const hx = edge === 'left' ? x0 : edge === 'right' ? x1 : (x0 + x1) / 2;
                  const hy = edge === 'top' ? y0 : edge === 'bottom' ? y1 : (y0 + y1) / 2;
                  const horizontal = edge === 'left' || edge === 'right';
                  const val = edge === 'left' ? s.keys[0] : edge === 'right' ? s.keys[1] : edge === 'top' ? s.vel[1] : s.vel[0];
                  return (
                    <rect key={edge} className="km-handle" data-edge={edge} data-testid={`zone-${k + 1}-edge-${edge}`} x={hx - (horizontal ? 4 : 10)} y={hy - (horizontal ? 10 : 4)} width={horizontal ? 8 : 20} height={horizontal ? 20 : 8} rx={2}
                      tabIndex={0} role="slider" aria-label={`${edge} edge of zone ${k + 1}`} aria-orientation={horizontal ? 'horizontal' : 'vertical'} aria-valuenow={val}
                      aria-valuetext={horizontal ? noteLabel(val) : `velocity ${val}`} style={{ cursor: horizontal ? 'ew-resize' : 'ns-resize' }}
                      onPointerDown={(e) => startDrag(e, k, edge)} onKeyDown={(e) => void onEdgeKey(e, k, edge)} />
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      {draft && <p className="dim ip-draft" role="status" data-testid="keymap-draft"><span className="mono" aria-hidden>{'●'}</span> zone {draft.n + 1} edge moved to {keysText(draft.span.keys)}, velocity {velText(draft.span.vel)}: Enter writes it, Esc drops it</p>}
      {hits.length > 0 && (
        <ul className="ip-hits" data-testid="keymap-hits"><li className="cap">Hits</li>
          {hits.map((h) => <li key={h} className="mono">{h}: {zones.map((z, k) => ({ z, k })).filter(({ z }) => z.hit === h).map(({ z, k }) => <button key={k} type="button" className="link-btn" onClick={() => onSelect(k)}>{k + 1} {z.sample}{z.rr ? ` rr${z.rr[0]}/${z.rr[1]}` : ''}{z.choke ? ` choke ${z.choke}` : ''}</button>)}</li>)}
        </ul>
      )}
      <p className="dim ip-hint">Drag a sample from the Samples tab onto a key to add a zone; select a zone and drag its edges, or focus an edge and use the arrows (Enter writes). Click the grid or the keys below to play.</p>
    </div>
  );
}

// ---- playing ---------------------------------------------------------------------------------------------------------------

const LENGTHS: { value: string; label: string }[] = [{ value: 'held', label: 'held' }, { value: '0.25', label: '¼ s' }, { value: '0.6', label: '0.6 s' }, { value: '1.5', label: '1.5 s' }];

function PlayBar({ store, inst, player }: { store: Store; inst: Instrument; player: LivePlayer }) {
  const [octave, setOctave] = useState(4);
  const [vel, setVel] = useState(100);
  const [length, setLength] = useState('held');
  const [keys, setKeys] = useState(true);
  const [midi, setMidi] = useState<{ state: 'off' | 'asking' | 'on' | 'none' | 'denied'; inputs: string[] }>({ state: 'off', inputs: [] });
  const [down, setDown] = useState<number[]>([]);
  const lenRef = useRef<NoteLength>('held');
  lenRef.current = length === 'held' ? 'held' : Number(length);
  const velRef = useRef(vel); velRef.current = vel;
  const octRef = useRef(octave); octRef.current = octave;
  const instRef = useRef(inst); instRef.current = inst;
  const sync = useCallback(() => setDown(player.down), [player]);
  const on = useCallback((m: number, v = velRef.current) => { void player.noteOn(instRef.current, m, v, lenRef.current).then(sync); }, [player, sync]);
  const off = useCallback((m: number) => { player.noteOff(m); sync(); }, [player, sync]);

  // the computer keyboard plays while the page is open and no text is being typed (these keys win over the shell's single-key shortcuts here)
  useEffect(() => {
    if (!keys) return;
    const held = new Set<string>();
    const typing = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || (t.getAttribute('role') === 'slider'));
    const down_ = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || document.querySelector('[role=dialog]')) return;
      const k = e.key.toLowerCase();
      if (k === 'z' || k === 'x') { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) setOctave((o) => Math.max(0, Math.min(8, o + (k === 'z' ? -1 : 1)))); return; }
      const m = computerNote(k, octRef.current);
      if (m === null) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.repeat || held.has(k)) return;
      held.add(k);
      on(m);
    };
    const up_ = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (!held.delete(k)) return;
      const m = computerNote(k, octRef.current);
      if (m !== null) off(m);
    };
    window.addEventListener('keydown', down_, true);
    window.addEventListener('keyup', up_, true);
    return () => { window.removeEventListener('keydown', down_, true); window.removeEventListener('keyup', up_, true); player.allOff(); };
  }, [keys, on, off, player]);

  // a MIDI keyboard, once the person asks for it (the browser asks its own permission then)
  const midiCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => midiCleanup.current?.(), []);
  const enableMidi = async () => {
    const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<MIDIAccess> };
    if (!nav.requestMIDIAccess) { setMidi({ state: 'none', inputs: [] }); return; }
    setMidi({ state: 'asking', inputs: [] });
    try {
      const access = await nav.requestMIDIAccess();
      const attach = (): void => {
        const names: string[] = [];
        access.inputs.forEach((inp) => { names.push(inp.name ?? inp.id); inp.onmidimessage = (ev) => { const n = ev.data ? parseMidiMessage(ev.data) : null; if (!n) return; if (n.on) on(n.midi, n.vel); else off(n.midi); }; });
        setMidi({ state: 'on', inputs: names });
      };
      attach();
      access.onstatechange = attach;
      midiCleanup.current = () => { access.inputs.forEach((inp) => { inp.onmidimessage = null; }); access.onstatechange = null; };
    } catch {
      setMidi({ state: 'denied', inputs: [] });
    }
  };

  const [a, b] = useMemo(() => keyRange(inst.zones ?? [], inst.range), [inst.zones, inst.range]);
  const first = Math.max(0, Math.min(a, 127)), last = Math.min(127, b);
  const marks = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const whites = marks.filter((m) => !BLACK.has(m % 12));
  return (
    <div className="ip-play" data-testid="play-bar">
      <div className="ip-play-row">
        <label className="ip-field">octave <span className="mono" data-testid="play-octave">{octave}</span>
          <span className="ip-step"><button type="button" className="ib ib-quiet" aria-label="Octave down" data-testid="octave-down" onClick={() => setOctave((o) => Math.max(0, o - 1))}>{'−'}</button><button type="button" className="ib ib-quiet" aria-label="Octave up" data-testid="octave-up" onClick={() => setOctave((o) => Math.min(8, o + 1))}>+</button></span>
        </label>
        <label className="ip-field">velocity <input type="range" min={1} max={127} value={vel} onChange={(e) => setVel(Number(e.target.value))} data-testid="play-velocity" aria-valuetext={`velocity ${vel}`} /><span className="mono">{vel}</span></label>
        <div className="ip-field">length <Segmented<string> label="Note length" value={length} onChange={setLength} testId="play-length" options={LENGTHS.map((l) => ({ value: l.value, label: l.label, testId: `length-${l.value}` }))} /></div>
        <label className="smp-confirm"><input type="checkbox" checked={keys} onChange={(e) => setKeys(e.target.checked)} data-testid="play-keys" />computer keyboard</label>
        <Button kind="quiet" testId="play-midi" onClick={() => void enableMidi()} disabled={midi.state === 'asking' || midi.state === 'on'} title="Play from a MIDI keyboard (the browser asks permission)">{midi.state === 'on' ? 'MIDI on' : 'Use MIDI keyboard'}</Button>
        <span className="dim mono" role="status" data-testid="midi-state">{midi.state === 'none' ? 'this browser has no Web MIDI' : midi.state === 'denied' ? 'MIDI permission was refused' : midi.state === 'on' ? (midi.inputs.length ? midi.inputs.join(', ') : 'no MIDI input connected') : ''}</span>
        <Button kind="secondary" testId="play-root" icon={down.length ? <Stop size={9} /> : <Play size={9} />} onClick={() => { void player.noteOn(inst, inst.root, vel, 0.8); }}>Play {noteLabel(inst.root)}</Button>
      </div>
      <div className="ip-piano" role="group" aria-label="Piano keys" data-testid="piano" style={{ ['--whites' as string]: whites.length }}>
        {marks.map((m) => {
          const black = BLACK.has(m % 12);
          const idx = whites.filter((w) => w < m).length;
          const left = black ? (idx - 0.3) : idx;
          return (
            <button key={m} type="button" className={`ip-key ${black ? 'black' : 'white'}${down.includes(m) ? ' down' : ''}`} data-midi={m} data-testid={`key-${m}`} aria-label={noteLabel(m)} aria-pressed={down.includes(m)}
              style={{ left: `calc(${left} * 100% / var(--whites))`, width: `calc(${black ? 0.6 : 1} * 100% / var(--whites))` }}
              onPointerDown={(e) => { e.preventDefault(); (e.currentTarget as Element).setPointerCapture(e.pointerId); on(m); }}
              onPointerUp={() => off(m)} onPointerCancel={() => off(m)}
              onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); on(m); } }} onKeyUp={(e) => { if (e.key === 'Enter' || e.key === ' ') off(m); }}>
              {!black && m % 12 === 0 && <span className="ip-key-label">{noteLabel(m)}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---- the zones --------------------------------------------------------------------------------------------------------------

function ZoneTable({ store, inst, check, sel, onSelect, status }: { store: Store; inst: Instrument; check: CheckReply | null; sel: number | null; onSelect(n: number): void; status(k: number): Status }) {
  const zones = inst.zones ?? [];
  return (
    <div className="ip-table-wrap">
      <table className="ip-table" data-testid="zone-table">
        <thead><tr><th>#</th><th>sample</th><th>keys</th><th>velocity</th><th>root</th><th>level</th><th>check</th></tr></thead>
        <tbody>
          {zones.map((z, k) => {
            const info = store.samples.find((x) => x.name === z.sample);
            const rep = check?.zones[k];
            const st = status(k);
            return (
              <tr key={k} className={sel === k ? 'sel' : ''} data-testid={`zone-row-${k + 1}`} data-status={st} tabIndex={0} aria-selected={sel === k} aria-label={`zone ${k + 1}: ${z.sample}, ${WORD[st]}`}
                onClick={() => onSelect(k)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(k); } }}>
                <td className="mono">{k + 1}</td>
                <td><a href={`#/sample/${z.sample}`} onClick={(e) => e.stopPropagation()}>{z.sample}</a>{info && <> <LicenceBadge state={info.licenceState} licence={info.licence} /></>}{z.trigger === 'release' && <span className="chip-c">release</span>}{z.rr && <span className="chip-c mono">rr {z.rr[0]}/{z.rr[1]}</span>}</td>
                <td className="mono">{z.hit ? `hit ${z.hit}` : keysText(z.keys)}</td>
                <td className="mono">{velText(z.vel)}</td>
                <td className="mono">{noteLabel(z.root)}{rep?.pitchCents != null ? ` ${rep.pitchCents > 0 ? '+' : ''}${rep.pitchCents}c` : ''}</td>
                <td className="mono">{rep?.lufs != null ? `${rep.lufs.toFixed(1)} LUFS` : check ? 'silent' : '…'}</td>
                <td><span className="ip-status" data-status={st}><span className="mono" aria-hidden>{GLYPH[st]}</span>{WORD[st]}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const ZONE_FIELDS: { key: string; label: string; read(z: Zone): string; testId: string }[] = [
  { key: 'keys', label: 'keys', read: (z) => keysText(z.keys), testId: 'zone-field-keys' },
  { key: 'vel', label: 'velocity', read: (z) => velText(z.vel), testId: 'zone-field-vel' },
  { key: 'root', label: 'root', read: (z) => noteLabel(z.root), testId: 'zone-field-root' },
  { key: 'tune', label: 'tune (cents)', read: (z) => String(z.tune), testId: 'zone-field-tune' },
  { key: 'gain', label: 'gain (dB)', read: (z) => String(z.gain), testId: 'zone-field-gain' },
  { key: 'pan', label: 'pan', read: (z) => String(z.pan), testId: 'zone-field-pan' },
];

function ZoneEditor({ store, inst, n, zone, check, run, onRemoved }: { store: Store; inst: Instrument; n: number; zone: Zone; check: CheckReply | null; run(cmd: string, done?: string): Promise<boolean>; onRemoved(): void }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(ZONE_FIELDS.map((f) => [f.key, f.read(zone)])));
  const [loopmode, setLoopmode] = useState<string>(zone.loopmode);
  const changed = ZONE_FIELDS.filter((f) => vals[f.key] !== f.read(zone));
  const dirty = changed.length > 0 || loopmode !== zone.loopmode;
  const bad = (k: string, v: string): boolean => (k === 'root' ? parseNote(v.trim()) === null : k === 'keys' ? !/^[A-G][#b]?-?\d(-[A-G][#b]?-?\d)?$/.test(v.trim()) && !/^\d{1,3}(-\d{1,3})?$/.test(v.trim()) : k === 'vel' ? !/^\d{1,3}(-\d{1,3})?$/.test(v.trim()) : !Number.isFinite(Number(v)));
  const invalid = changed.some((f) => bad(f.key, vals[f.key]!));
  const rep = check?.zones[n];
  const apply = async () => {
    const parts = changed.map((f) => `${f.key}=${vals[f.key]!.trim()}`);
    if (loopmode !== zone.loopmode) parts.push(`loopmode=${loopmode}`);
    await run(`instrument zone set ${inst.id} ${n + 1} ${parts.join(' ')}`);
  };
  return (
    <div className="ip-editor" data-testid="zone-editor" data-zone={n + 1}>
      <h2 className="cap">Zone {n + 1} <span className="dim">{zone.sample}</span></h2>
      <form className="ip-fields" onSubmit={(e) => { e.preventDefault(); if (dirty && !invalid) void apply(); }}>
        {ZONE_FIELDS.map((f) => <label key={f.key}>{f.label}<input value={vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} data-testid={f.testId} aria-invalid={bad(f.key, vals[f.key]!)} spellCheck={false} disabled={zone.hit !== null && f.key === 'keys'} /></label>)}
        <label>loop<select value={loopmode} onChange={(e) => setLoopmode(e.target.value)} data-testid="zone-field-loopmode">{['sustain', 'continuous', 'oneshot', 'none'].map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
        <div className="ip-editor-actions">
          <Button kind="primary" type="submit" testId="zone-apply" disabled={!dirty || invalid}>Write change</Button>
          <Button kind="quiet" testId="zone-play" onClick={() => void store.playSample(zone.sample)}>Play sample</Button>
          <Button kind="danger" testId="zone-remove" onClick={() => void run(`instrument zone remove ${inst.id} ${n + 1}`, `Removed zone ${n + 1}`).then((ok) => { if (ok) onRemoved(); })}>Remove zone</Button>
        </div>
      </form>
      <p className="mono dim" data-testid="zone-measured">{rep ? `measured: ${rep.pitchCents != null ? `${rep.pitchCents > 0 ? '+' : ''}${rep.pitchCents} cents at its root` : 'no steady pitch'}, ${rep.lufs != null ? `${rep.lufs.toFixed(1)} LUFS` : 'silent'}` : 'measuring…'}</p>
    </div>
  );
}

function AddZoneDialog({ store, inst, run, onClose }: { store: Store; inst: Instrument; run(cmd: string, done?: string): Promise<boolean>; onClose(): void }) {
  const [name, setName] = useState(store.samples[0]?.name ?? '');
  const [key, setKey] = useState('C4');
  const [busy, setBusy] = useState(false);
  const midi = parseNote(key.trim());
  const info = store.samples.find((x) => x.name === name);
  const go = async () => {
    if (midi === null || !info) return;
    setBusy(true);
    const s: DropSample = { name, root: info.root };
    if (!info.root) {
      try {
        const r = await fetch(`/api/sample-card/${info.sha256}.json?token=${encodeURIComponent(store.token)}`);
        if (r.ok) { const m = decodeMeasure(((await r.json()) as SampleCard).measure); s.pitch = m.pitch ? { note: m.pitch.note, cents: m.pitch.cents } : null; s.pitched = m.pitched; }
      } catch { /* rooted at the key */ }
    }
    const d = dropZone(inst.id, s, midi);
    const ok = await run(d.command, `Added a zone for ${name}: ${d.note}`);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog title={`Add a zone to ${inst.id}`} onClose={onClose} testId="add-zone-dialog">
      <form className="smp-form" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        {store.samples.length === 0 ? <p className="dim">The project has no samples yet: import or generate some first.</p> : (
          <label>sample<select value={name} onChange={(e) => setName(e.target.value)} data-testid="add-zone-sample">{store.samples.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}</select></label>
        )}
        <label>on the key<input value={key} onChange={(e) => setKey(e.target.value)} data-testid="add-zone-key" aria-invalid={midi === null} spellCheck={false} placeholder="C4" /></label>
        <p className="dim smp-hint">The zone covers that key and one either side, rooted where the sample sounds (its own root, else measured). Change its keys and velocities afterwards on the key-map. The command is <code className="mono">instrument zone add {inst.id} sample={name || '<sample>'} …</code>.</p>
        <div className="smp-form-actions"><button type="submit" className="btn btn-primary" disabled={midi === null || !info || busy} data-testid="add-zone-go">Add zone</button><button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button></div>
      </form>
    </Dialog>
  );
}

export type { Geometry };
