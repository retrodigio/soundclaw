// The piano roll of one melodic channel in one pattern: notes as bars on a pitch grid, the key's
// notes shaded, notes outside the key marked. Click to add (drag right to make it longer), drag a
// note to move it (the selection moves with it), drag its right edge to lengthen it, shift-drag to
// select, Delete to remove, a velocity lane to drag, and a small menu for slide, vibrato and arp.
// Each gesture writes the commands an agent would write (`pattern note …`), as one batch when the
// pointer is released.

import { useEffect, useRef, useState } from 'react';
import {
  GestureBatch, inKey, lengthAt, moveCommands, noteEditText, noteLabel, parseKey, rollNotes, selOf, startOf,
  type Channel, type NoteFx, type Pattern, type RollNote, type SongDoc,
} from '@soundclaw/core';
import type { Store } from './store.ts';

const CW = 26;
const RH = 11;
const KEYW = 44;
const VH = 56;

export const noteKey = (n: Pick<RollNote, 'step' | 'midi'>): string => `${n.step}:${n.midi}`;

type Drag =
  | { kind: 'add'; step: number; midi: number; len: number }
  | { kind: 'move'; x0: number; y0: number; dSteps: number; dSemis: number; notes: RollNote[]; hit: RollNote; shift: boolean }
  | { kind: 'len'; note: RollNote; len: number; max: number }
  | { kind: 'band'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'vel'; batch: GestureBatch; vals: Map<string, number> };

export interface RollProps {
  store: Store;
  song: SongDoc;
  pattern: Pattern;
  channel: Channel;
  /** The step sounding now (playing), or the cursor's step. */
  cursorStep: number | null;
  selected: Set<string>;
  onSelect(keys: Set<string>): void;
  send(cmds: string[]): void;
  onCursor(step: number): void;
}

export function PianoRoll({ store, song, pattern, channel, cursorStep, selected, onSelect, send, onCursor }: RollProps) {
  const row = pattern.channels.find((c) => c.name === channel.name);
  const notes = rollNotes(row);
  const inst = channel.inst ? store.lookupInstrument(channel.inst) : undefined;
  const key = song.key ? (() => { try { return parseKey(song.key!); } catch { return null; } })() : null;
  const mids = notes.map((n) => n.midi!);
  const centre = mids.length ? Math.round((Math.min(...mids) + Math.max(...mids)) / 2) : inst?.range ? Math.round((inst.range[0] + inst.range[1]) / 2) : 66;
  let lo = Math.min(centre - 12, ...mids.map((m) => m - 4)), hi = Math.max(centre + 12, ...mids.map((m) => m + 4));
  lo = Math.max(0, lo); hi = Math.min(127, hi);
  const rows = hi - lo + 1;
  const W = KEYW + pattern.steps * CW, H = rows * RH;
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  const lane = useRef<SVGSVGElement>(null);
  const latest = useRef({ drag });
  latest.current = { drag };
  const [lastLen, setLastLen] = useState(1);

  const pt = (e: { clientX: number; clientY: number }, el: SVGSVGElement | null): { x: number; y: number } => {
    const r = el!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * (el === lane.current ? VH : H) };
  };
  const stepAt = (x: number): number => Math.max(0, Math.min(pattern.steps - 1, Math.floor((x - KEYW) / CW)));
  const midiAt = (y: number): number => Math.max(lo, Math.min(hi, hi - Math.floor(y / RH)));
  const yOf = (m: number): number => (hi - m) * RH;
  const cells = row?.cells ?? [];
  /** The most steps a note at `step` may last without running into the next note. */
  const room = (step: number): number => {
    let s = step + lengthAt(cells, step);
    while (s < pattern.steps && cells[s]!.kind === 'rest') s++;
    return s - step;
  };
  const selNotes = notes.filter((n) => selected.has(noteKey(n)));

  const onDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (e.button !== 0) return;
    const { x, y } = pt(e, svg.current);
    if (x < KEYW) return;
    svg.current!.setPointerCapture(e.pointerId);
    const step = stepAt(x), midi = midiAt(y);
    const hit = notes.find((n) => n.midi === midi && step >= n.step && step < n.step + n.len);
    setMenu(false);
    if (hit) {
      const right = KEYW + (hit.step + hit.len) * CW;
      if (x > right - 7) { setDrag({ kind: 'len', note: hit, len: hit.len, max: room(hit.step) }); return; }
      const group = selected.has(noteKey(hit)) ? selNotes : [hit];
      setDrag({ kind: 'move', x0: x, y0: y, dSteps: 0, dSemis: 0, notes: group, hit, shift: e.shiftKey });
      return;
    }
    if (e.shiftKey) { setDrag({ kind: 'band', x0: x, y0: y, x1: x, y1: y }); return; }
    onSelect(new Set());
    setDrag({ kind: 'add', step, midi, len: lastLen });
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    const d = latest.current.drag;
    if (!d) return;
    const { x, y } = pt(e, svg.current);
    if (d.kind === 'add') setDrag({ ...d, len: Math.max(1, Math.min(pattern.steps - d.step, stepAt(x) - d.step + 1)) });
    else if (d.kind === 'move') setDrag({ ...d, dSteps: Math.round((x - d.x0) / CW), dSemis: -Math.round((y - d.y0) / RH) });
    else if (d.kind === 'len') setDrag({ ...d, len: Math.max(1, Math.min(d.max, stepAt(x) - d.note.step + 1)) });
    else if (d.kind === 'band') setDrag({ ...d, x1: x, y1: y });
  };
  const onUp = (): void => {
    const d = latest.current.drag;
    setDrag(null);
    if (!d) return;
    if (d.kind === 'add') {
      // joining a chord that starts there keeps the chord's length unless the drag gave one
      const joins = cells[d.step]?.kind === 'notes';
      const len = d.len > 1 || (!joins && d.len !== 1) ? d.len : null;
      if (d.len > 1) setLastLen(d.len);
      send([noteEditText(song.id, pattern.name, { verb: 'add', channel: channel.name, step: d.step, cell: { kind: 'notes', notes: [{ midi: d.midi, vel: 100, fx: {} }] }, len })]);
      onSelect(new Set([noteKey({ step: d.step, midi: d.midi })]));
    } else if (d.kind === 'move') {
      if (d.dSteps === 0 && d.dSemis === 0) {
        const k = noteKey(d.hit);
        if (d.shift) { const n = new Set(selected); if (n.has(k)) n.delete(k); else n.add(k); onSelect(n); } else onSelect(new Set([k]));
        onCursor(d.hit.step);
        return;
      }
      const cmds = moveCommands(song.id, pattern, channel.name, d.notes, d.dSteps, d.dSemis);
      if (cmds?.length) {
        send(cmds);
        onSelect(new Set(d.notes.map((n) => noteKey({ step: n.step + d.dSteps, midi: n.midi! + d.dSemis }))));
      }
    } else if (d.kind === 'len') {
      if (d.len !== d.note.len) { send([noteEditText(song.id, pattern.name, { verb: 'len', channel: channel.name, step: d.note.step, len: d.len })]); setLastLen(d.len); }
    } else if (d.kind === 'band') {
      const [x0, x1] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)], [y0, y1] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
      onSelect(new Set(notes.filter((n) => {
        const nx0 = KEYW + n.step * CW, nx1 = nx0 + n.len * CW, ny = yOf(n.midi!);
        return nx1 > x0 && nx0 < x1 && ny + RH > y0 && ny < y1;
      }).map(noteKey)));
    }
  };

  // the velocity lane: a drag sets the velocity of each step it crosses; one batch on release
  const velDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (e.button !== 0) return;
    lane.current!.setPointerCapture(e.pointerId);
    const batch = new GestureBatch(send);
    const d: Drag = { kind: 'vel', batch, vals: new Map() };
    setDrag(d);
    latest.current.drag = d;
    velMove(e);
  };
  const velMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    const d = latest.current.drag;
    if (!d || d.kind !== 'vel') return;
    const { x, y } = pt(e, lane.current);
    const step = stepAt(x);
    const at = notes.filter((n) => n.step === step);
    if (!at.length) return;
    const vel = Math.max(1, Math.min(127, Math.round(((VH - y) / VH) * 127)));
    const vals = new Map(d.vals);
    for (const n of at) vals.set(noteKey(n), vel);
    // the whole chord at a step takes the velocity: one command per step
    d.batch.push(`vel:${step}`, at.every((n) => n.vel === vel) ? null : noteEditText(song.id, pattern.name, { verb: 'set', channel: channel.name, step, sel: null, vel }));
    setDrag({ ...d, vals });
  };
  const velUp = (): void => {
    const d = latest.current.drag;
    setDrag(null);
    if (d?.kind === 'vel') d.batch.flush();
  };

  const removeSelected = (): void => {
    if (!selNotes.length) return;
    // remove pitch by pitch (a chord with every note selected goes whole)
    const cmds: string[] = [];
    const done = new Set<number>();
    for (const n of [...selNotes].sort((a, b) => b.midi! - a.midi!)) {
      const whole = n.chord === selNotes.filter((x) => x.step === n.step).length;
      if (whole) { if (done.has(n.step)) continue; done.add(n.step); cmds.push(noteEditText(song.id, pattern.name, { verb: 'remove', channel: channel.name, step: n.step, sel: null })); }
      else cmds.push(noteEditText(song.id, pattern.name, { verb: 'remove', channel: channel.name, step: n.step, sel: selOf(n) }));
    }
    send(cmds);
    onSelect(new Set());
  };
  const minor = key ? [3].every((d) => !inKey(key, key.tonic + 4) && inKey(key, key.tonic + d)) : false;
  const toggleFx = (which: 'slide' | 'vib' | 'arp'): void => {
    const all = selNotes.every((n) => !!n.fx[which]);
    const cmds = selNotes.map((n) => {
      const fx: NoteFx = { ...n.fx };
      if (all) delete fx[which];
      else if (which === 'slide') fx.slide = true;
      else if (which === 'vib') fx.vib = { rate: 5, depth: 0.4 };
      else fx.arp = minor ? [0, 3, 7] : [0, 4, 7];
      return noteEditText(song.id, pattern.name, { verb: 'set', channel: channel.name, step: n.step, sel: selOf(n), fx });
    });
    send(cmds);
  };
  useEffect(() => { if (!selNotes.length) setMenu(false); }, [selNotes.length]);

  // what the drag shows before it is written
  const shown = (n: RollNote): { step: number; len: number; midi: number; vel: number } => {
    let step = n.step, len = n.len, midi = n.midi!, vel = n.vel;
    if (drag?.kind === 'move' && drag.notes.includes(n)) { step += drag.dSteps; midi += drag.dSemis; }
    if (drag?.kind === 'len' && drag.note === n) len = drag.len;
    if (drag?.kind === 'vel') vel = drag.vals.get(noteKey(n)) ?? vel;
    return { step, len, midi, vel };
  };
  const scaleRows = Array.from({ length: rows }, (_, i) => hi - i);
  return (
    <div className="roll-wrap" data-testid={`roll-${channel.name}`} data-pattern={pattern.name} data-notes={notes.length} data-selected={selNotes.length} data-cursor={cursorStep ?? ''}
      tabIndex={0} onKeyDown={(e) => {
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); }
        if (e.key === 'Escape') onSelect(new Set());
      }}>
      <div className="roll-tools">
        <span className="dim">{channel.name} · {channel.inst}{inst?.range ? ` · range ${noteLabel(inst.range[0])}–${noteLabel(inst.range[1])}` : ''}{song.key ? ` · key ${song.key}` : ''}</span>
        <span className="spacer" />
        <span className="dim" data-testid="roll-selection">{selNotes.length ? `${selNotes.length} selected` : 'click to add · drag to move · drag the end to lengthen · shift-drag to select'}</span>
        <button className="mini" data-testid="roll-fx" disabled={!selNotes.length} onClick={() => setMenu((m) => !m)} title="effects of the selected notes">fx ▾</button>
        <button className="mini" data-testid="roll-delete" disabled={!selNotes.length} onClick={removeSelected} title="remove the selected notes (Delete)">×</button>
        {menu && selNotes.length > 0 && (
          <span className="roll-menu" data-testid="roll-fx-menu">
            {(['slide', 'vib', 'arp'] as const).map((f) => (
              <button key={f} className={`mini${selNotes.every((n) => !!n.fx[f]) ? ' on' : ''}`} data-testid={`roll-fx-${f}`} onClick={() => toggleFx(f)}>{f === 'vib' ? 'vibrato' : f}</button>
            ))}
          </span>
        )}
      </div>
      <svg ref={svg} className="roll" width={W} height={H} viewBox={`0 0 ${W} ${H}`} data-testid={`roll-grid-${channel.name}`} data-lo={lo} data-hi={hi}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}
        onContextMenu={(e) => {
          e.preventDefault();
          const { x, y } = pt(e, svg.current);
          const hit = notes.find((n) => n.midi === midiAt(y) && stepAt(x) >= n.step && stepAt(x) < n.step + n.len);
          if (hit) { if (!selected.has(noteKey(hit))) onSelect(new Set([noteKey(hit)])); setMenu(true); }
        }}>
        {scaleRows.map((m, i) => {
          const inScale = !key || inKey(key, m);
          return <rect key={m} x={KEYW} y={i * RH} width={W - KEYW} height={RH} className={`roll-row${inScale ? ' in-key' : ''}${m % 12 === 0 ? ' c-row' : ''}`} />;
        })}
        {scaleRows.map((m, i) => (
          <text key={`k${m}`} x={KEYW - 4} y={i * RH + RH - 2} className={`roll-key${key && !inKey(key, m) ? ' off' : ''}`} textAnchor="end">{m % 12 === 0 || (key && m % 12 === key.tonic) ? noteLabel(m) : ''}</text>
        ))}
        {Array.from({ length: pattern.steps + 1 }, (_, s) => (
          <line key={`s${s}`} x1={KEYW + s * CW} x2={KEYW + s * CW} y1={0} y2={H} className={pattern.bar && s % pattern.bar === 0 ? 'roll-bar' : s % pattern.tpb === 0 ? 'roll-beat' : 'roll-step'} />
        ))}
        {cursorStep !== null && <rect x={KEYW + cursorStep * CW} y={0} width={CW} height={H} className="roll-cursor" data-testid="roll-cursor" />}
        {notes.map((n) => {
          const v = shown(n);
          const out = !!key && !inKey(key, v.midi) && !n.accidental;
          const k = noteKey(n);
          return (
            <g key={k} className={`roll-note${selected.has(k) ? ' sel' : ''}${out ? ' out-of-key' : ''}${n.accidental ? ' accidental' : ''}`} data-testid={`note-${channel.name}-${n.step}-${noteLabel(n.midi!)}`} data-step={n.step} data-len={n.len} data-vel={n.vel} data-fx={Object.keys(n.fx).join(',')}>
              <rect x={KEYW + v.step * CW + 1} y={yOf(v.midi) + 1} width={v.len * CW - 2} height={RH - 2} rx={2} style={{ opacity: 0.45 + 0.55 * (v.vel / 127) }} />
              <rect x={KEYW + (v.step + v.len) * CW - 6} y={yOf(v.midi) + 1} width={4} height={RH - 2} className="roll-edge" />
              {(out || n.accidental) && <text x={KEYW + v.step * CW + 3} y={yOf(v.midi) + RH - 2} className="roll-mark">!</text>}
              {(n.fx.slide || n.fx.vib || n.fx.arp) && <text x={KEYW + v.step * CW + (out ? 9 : 3)} y={yOf(v.midi) + RH - 2} className="roll-fx">{[n.fx.slide ? 's' : '', n.fx.vib ? 'v' : '', n.fx.arp ? 'a' : ''].join('')}</text>}
            </g>
          );
        })}
        {drag?.kind === 'add' && <rect x={KEYW + drag.step * CW + 1} y={yOf(drag.midi) + 1} width={drag.len * CW - 2} height={RH - 2} className="roll-draft" />}
        {drag?.kind === 'band' && <rect x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)} className="roll-band" />}
      </svg>
      <svg ref={lane} className="vel-lane" width={W} height={VH} viewBox={`0 0 ${W} ${VH}`} data-testid={`vel-lane-${channel.name}`}
        onPointerDown={velDown} onPointerMove={velMove} onPointerUp={velUp} onPointerCancel={() => setDrag(null)}>
        <text x={KEYW - 4} y={12} className="roll-key" textAnchor="end">vel</text>
        {notes.map((n, i) => {
          const v = shown(n);
          const h = (v.vel / 127) * (VH - 4);
          const off = notes.filter((x, j) => j < i && x.step === n.step).length * 3;
          return <rect key={noteKey(n)} x={KEYW + n.step * CW + 3 + off} y={VH - h} width={5} height={h} className={`vel-bar${selected.has(noteKey(n)) ? ' sel' : ''}`} data-testid={`vel-${channel.name}-${n.step}-${noteLabel(n.midi!)}`} />;
        })}
      </svg>
      {/* the step a note sounding at the cursor started on, for the cursor readout */}
      <span hidden data-testid="roll-cursor-start">{cursorStep !== null ? startOf(cells, cursorStep) : ''}</span>
    </div>
  );
}
