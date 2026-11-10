// A set on its own page: the header with the loudness class and the spread, the set loudness meter,
// the clip grid (each member's last four distinct versions from the tape, and the agent's proposal),
// the blind A/B card, play in sequence, regen with a new seed, and the numbers that keep the members
// alike but never identical: the spread rules and the distance matrix, with the set-spread verdict.

import { useEffect, useMemo, useRef, useState } from 'react';
import { classTable, formatSpread, momentOf, quoteText, setTarget, type SetDoc, type Sound } from '@soundclaw/core';
import type { SoundSummary } from '@soundclaw/server/protocol';
import { ABCard, TallyCard, useBlindAB, type Pair, type PairSide } from './sets/ABCard.tsx';
import { ClipGrid, PeaksPath, type CellModel, type ColumnModel, type RowModel } from './sets/ClipGrid.tsx';
import { SetMeter } from './sets/SetMeter.tsx';
import { loudKind } from './sets/abmath.ts';
import { Badge, Button, type CheckKind } from './studio/controls.tsx';
import { inTextField, useActions } from './studio/registry.ts';
import { lufsText } from './studio/shellData.ts';
import type { Version } from './sound/provenance.ts';
import type { Store } from './store.ts';
import { plural } from './studio/values.ts';

const randomSeed = (): number => Math.floor(Math.random() * 4294967296);

interface Member { s: SoundSummary; n: number; versions: Version[]; proposed: Version | null }

/** The version a member holds now: the agent's proposal when there is one, else the current numbered version. */
const currentOf = (m: Member): Version | null => m.proposed ?? m.versions.find((v) => v.current) ?? m.versions.at(-1) ?? null;

export function SetPage({ store, set }: { store: Store; set: SetDoc }) {
  const [gap, setGap] = useState(400);
  const [cursor, setCursor] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const style = store.style;
  const summaries = set.members.map((id) => store.summary(id)).filter((s): s is SoundSummary => !!s);
  const measure = summaries.length >= 2 ? store.setMeasure(set) : null;
  const sequencing = store.sequence !== null;

  // the members and their versions, from the tape
  const members: Member[] = summaries.map((s, i) => ({ s, n: i + 1, ...store.versions(s.id) }));
  const cls = set.class ? classTable(style)[set.class] : undefined;
  const tolerance = cls?.tolerance ?? style.loudnessTolerance;
  const lufsNow = members.map((m) => { const v = currentOf(m); return v ? store.cell(v.doc)?.lufs : undefined; });
  const finite = lufsNow.filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
  const target = setTarget(set, style) ?? (finite.length ? finite[Math.floor(finite.length / 2)]! : style.loudnessTarget);
  const spread = finite.length >= 2 ? finite.at(-1)! - finite[0]! : null;
  const spreadMax = 2 * tolerance;
  const spreadKind: CheckKind = spread === null ? 'checking' : spread <= spreadMax ? 'pass' : 'warn';

  const nVersions = Math.max(1, ...members.map((m) => m.versions.length));
  const agentCol = members.some((m) => m.proposed);
  const cols: ColumnModel[] = [...Array.from({ length: nVersions }, (_, i) => ({ label: `v${i + 1}` })), ...(agentCol ? [{ label: 'agent', agent: true, title: 'Proposed by the agent, not yet approved' }] : [])];

  const cellOf = (m: Member, v: Version): CellModel => {
    const c = store.cell(v.doc, v.samples);
    return {
      key: `${m.s.id}@${v.seq}`, id: m.s.id, seq: v.seq, label: v.label, name: `${m.s.id} · ${v.label}`, current: v.current, proposed: v.proposed, by: v.by,
      lufs: c ? c.lufs : undefined, kind: c ? loudKind(c.lufs, target, tolerance) : 'checking', duration: c?.duration,
      wave: <PeaksPath peaks={c?.peaks} />,
    };
  };
  const grid: { m: Member; cells: (CellModel | null)[] }[] = members.map((m) => ({
    m,
    cells: [...Array.from({ length: nVersions }, (_, i) => (m.versions[i] ? cellOf(m, m.versions[i]!) : null)), ...(agentCol ? [m.proposed ? cellOf(m, m.proposed) : null] : [])],
  }));
  const allCells = grid.flatMap((r) => r.cells.filter((c): c is CellModel => !!c));
  const byKey = new Map(allCells.map((c) => [c.key, c]));
  const docOf = (c: CellModel): Sound | null => {
    const m = members.find((x) => x.s.id === c.id);
    const v = m && [...m.versions, ...(m.proposed ? [m.proposed] : [])].find((x) => x.seq === c.seq);
    return v?.doc ?? null;
  };
  const sideOf = (c: CellModel): PairSide | null => { const doc = docOf(c); return doc ? { id: c.id, seq: c.seq, doc, name: c.name } : null; };
  const currentCell = (id: string): CellModel | null => grid.find((r) => r.m.s.id === id)?.cells.find((c) => c?.current) ?? null;
  const at = cursor && byKey.has(cursor) ? cursor : currentCell(members[0]?.s.id ?? '')?.key ?? allCells[0]?.key ?? null;

  // the page's queue of pairs: each member's current version against each of its other versions, the newest first
  const queue: Pair[] = useMemo(() => grid.flatMap(({ cells }) => {
    const cur = cells.find((c) => c?.current);
    const ref = cur ? sideOf(cur) : null;
    if (!ref) return [];
    return cells.filter((c): c is CellModel => !!c && c !== cur).reverse().map((c) => sideOf(c)).filter((x): x is PairSide => !!x).map((o) => [ref, o] as Pair);
  }), [allCells.map((c) => c.key).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const momentFor = (id: string | undefined): { text: string; set: string | null } | null => {
    const d = id ? store.doc(id) : undefined;
    return d ? momentOf(d, store.sets) : set.moment ? { text: set.moment, set: set.id } : null;
  };
  const refId = useRef<string | undefined>(undefined);
  const ab = useBlindAB(store, queue, () => momentFor(refId.current)?.text ?? null);
  refId.current = ab.pair?.ref.id;
  const moment = ab.pair ? momentFor(ab.pair.ref.id) : null;

  const play = (c: CellModel) => { const d = docOf(c); if (d) void store.playVersion(c.id, c.seq, d); };
  const playList = (cells: (CellModel | null)[]) => {
    const items = cells.filter((c): c is CellModel => !!c).map((c) => ({ id: c.id, seq: c.seq, doc: docOf(c)! })).filter((x) => x.doc);
    if (items.length) void store.playVersions(items, gap);
  };
  const playRow = (n: number) => { const r = grid[n - 1]; if (r) playList(r.cells); };
  const playCol = (n: number) => { if (n <= cols.length) playList(grid.map((r) => r.cells[n - 1] ?? null)); };

  const makeCurrent = async (c: CellModel) => {
    if (c.proposed) {
      const r = await store.approve(c.id);
      setMessage(r.ok ? { text: `Approved the agent's version of ${c.id}.` } : { text: r.errors[0]?.message ?? 'refused', error: true });
      return;
    }
    if (c.current) { setMessage({ text: `${c.name} is already current.` }); return; }
    const d = docOf(c);
    if (!d) return;
    const r = await store.restoreVersion(c.id, d);
    setMessage(r.ok ? { text: `${c.id} is ${c.label} again (${r.commands!.length} command${r.commands!.length === 1 ? '' : 's'}, one undo).` } : { text: `${c.name} cannot be made current: ${r.error}.`, error: true });
  };
  const compareWithCurrent = (c: CellModel) => {
    const cur = currentCell(c.id);
    if (!cur || cur.key === c.key) { setMessage({ text: `${c.name} is the current version: pick another to compare with it.` }); return; }
    const a = sideOf(cur), b = sideOf(c);
    if (a && b) ab.put([a, b]);
  };
  const comparePicked = () => {
    const [x, y] = picked.map((k) => byKey.get(k)).filter((c): c is CellModel => !!c);
    if (x && y) { const a = sideOf(x), b = sideOf(y); if (a && b) ab.put([a, b]); return; }
    const one = x ?? (at ? byKey.get(at) : undefined);
    if (one) compareWithCurrent(one);
  };
  const onDrop = (c: CellModel) => {
    // a drop puts the dropped cell beside the one dropped before it, or beside its sound's current version
    const prev = picked.filter((k) => k !== c.key).map((k) => byKey.get(k)).find((x): x is CellModel => !!x);
    if (prev) { const a = sideOf(prev), b = sideOf(c); if (a && b) ab.put([a, b]); setPicked([]); }
    else { setPicked([c.key]); compareWithCurrent(c); }
  };

  // Space plays the cell under the cursor
  useActions([{ id: 'transport.play', label: 'Play / stop the cell under the cursor', group: 'Transport', shortcut: 'Space', key: 'space', override: true, run: () => { const c = at ? byKey.get(at) : undefined; if (c) play(c); } }]);

  // the page's keys: 1–9 play a row, ⇧1–9 a column, C compares, A/B/=/N answer, Tab switches the side heard, → the next pair, arrows move
  const keys = useRef({ ab, at, grid, playRow, playCol, comparePicked });
  keys.current = { ab, at, grid, playRow, playCol, comparePicked };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented || inTextField(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const k = keys.current;
      const digit = /^Digit([1-9])$/.exec(e.code);
      const done = () => { e.preventDefault(); e.stopPropagation(); };
      if (digit) { done(); if (e.shiftKey) k.playCol(Number(digit[1])); else k.playRow(Number(digit[1])); return; }
      if (e.key === 'Tab' && store.ab) { done(); store.switchAB(); return; }
      const open = k.ab.pair && !k.ab.answered && !k.ab.busy;
      const answer = ({ a: 'a', b: 'b', '=': 'both', n: 'neither' } as const)[e.key.toLowerCase() as 'a'];
      if (answer && open) { done(); void k.ab.answer(answer); return; }
      if (e.key === 'c' || e.key === 'C') { done(); k.comparePicked(); return; }
      if (e.key === 'ArrowRight' && k.ab.answered) { done(); k.ab.next(); return; }
      if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(e.key) && k.at) {
        const r = k.grid.findIndex((x) => x.cells.some((c) => c?.key === k.at));
        const ci = k.grid[r]!.cells.findIndex((c) => c?.key === k.at);
        const find = (row: number, col: number, dc: number): string | null => {
          const cells = k.grid[row]?.cells;
          if (!cells) return null;
          for (let j = col; j >= 0 && j < cells.length; j += dc || -1) if (cells[j]) return cells[j]!.key;
          return null;
        };
        const to = e.key === 'ArrowRight' ? find(r, ci + 1, 1) : e.key === 'ArrowLeft' ? find(r, ci - 1, -1) : find(r + (e.key === 'ArrowDown' ? 1 : -1), ci, 0);
        if (to) { done(); setCursor(to); }
      }
    };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [store]);
  useEffect(() => () => store.stopSequence(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const playingKey = store.playing && byKey.has(store.playing) ? store.playing : null;
  const rows: RowModel[] = grid.map(({ m, cells }) => {
    const info = m.s.info ?? store.cardOf(m.s.id);
    const pass = info?.pass;
    const inSeq = store.sequence?.ids[store.sequence.index];
    const current = inSeq === m.s.id || (!!inSeq && inSeq.startsWith(`${m.s.id}@`));
    const playing = store.playing === m.s.id;
    return {
      id: m.s.id, digit: m.n <= 9 ? m.n : null, testId: `member-${m.s.id}`, cells,
      attrs: { 'data-hash': info?.hash ?? '', 'data-current': String(current) },
      head: (
        <>
          <span className="cg-name"><span className="mono cg-n" title={m.n <= 9 ? `key ${m.n} plays the row` : undefined}>{m.n}</span><a href={`#/sound/${m.s.id}`} data-testid={`member-edit-${m.s.id}`} className="cg-id">{m.s.id}</a></span>
          <span className="cg-meta">
            <button type="button" className="ib ib-quiet cg-play" data-testid={`member-play-${m.s.id}`} data-playing={playing} aria-label={`${playing ? 'Stop' : 'Play'} ${m.s.id} as it is now`} onClick={() => void store.play(m.s.id)}>
              <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden><path d={playing ? 'M2 1 H5 V11 H2 Z M7 1 H10 V11 H7 Z' : 'M2 1 L11 6 L2 11 Z'} fill="currentColor" /></svg>
            </button>
            <span className="mono dim small" data-testid={`member-numbers-${m.s.id}`}>{info ? `${info.duration.toFixed(2)} s · ${lufsText(info.lufs)}` : '…'}</span>
            <Badge kind={pass === undefined ? 'checking' : pass ? 'pass' : 'fail'} testId={`member-check-${m.s.id}`} title={info?.failing.join(', ')}>{pass === false ? info!.failing.join(', ') : undefined}</Badge>
          </span>
        </>
      ),
    };
  });
  const sel = picked.map((k) => byKey.get(k)).filter((c): c is CellModel => !!c);

  return (
    <section className="setpage studio-page" data-testid="set-page" data-set={set.id}>
      <header className="set-head">
        <a href="#/" className="back" data-testid="back">← all sounds</a>
        <h1 className="set-title" title={set.id}>{set.id.replace(/_/g, ' ')}</h1>
        <span className="set-chip" data-testid="set-info">set · {plural(set.members.length, 'member')}{set.from ? ` from ${set.from}` : ''} · {set.target !== null ? `target ${lufsText(set.target)} LUFS` : set.class ? `loudness class "${set.class}" ${lufsText(target)} LUFS` : 'no loudness target'} · seed <b data-testid="set-seed">{set.seed}</b></span>
        {spread !== null && <Badge kind={spreadKind} testId="set-spread" title="How far apart the members' loudness is, against twice the class tolerance">spread {spread.toFixed(1)} LU, max {spreadMax}</Badge>}
        {measure && <span className="badge" data-kind={measure.result.pass ? 'pass' : 'fail'} data-testid="set-check" data-pass={measure.result.pass}><span className="mono" aria-hidden>{measure.result.pass ? '✓' : '×'}</span>set-spread</span>}
      </header>
      <div className="set-tools" role="group" aria-label="Play and regenerate the set" data-testid="set-toolbar">
        <Button testId="set-play-row" disabled={!members.length} onClick={() => { const r = grid.findIndex((x) => x.cells.some((c) => c?.key === at)); playRow(r + 1 || 1); }}>Play row <span className="kbd">1–{Math.min(9, members.length) || 1}</span></Button>
        <Button testId="set-play-col" disabled={!members.length} onClick={() => { const r = grid.find((x) => x.cells.some((c) => c?.key === at)); playCol((r?.cells.findIndex((c) => c?.key === at) ?? 0) + 1); }}>Play column <span className="kbd">⇧1–{Math.min(9, cols.length)}</span></Button>
        <label className="dim small">gap <input type="number" min={0} max={5000} step={50} value={gap} data-testid="set-gap" className="num-input" onChange={(e) => setGap(Math.max(0, Number(e.target.value)))} /> ms</label>
        <button type="button" className="btn btn-primary" data-testid="set-play-all" data-playing={sequencing} disabled={!members.length} onClick={() => void (sequencing ? store.stopSequence() : store.playSequence(members.map((m) => m.s.id), gap))}>{sequencing ? '■ Stop' : '▶ Play in sequence'}</button>
        <Button testId="set-regen" disabled={!set.generated.length || !set.from} title="Make the generated members again from the source with a new seed" onClick={() => void store.run(`set regen ${set.id} seed=${randomSeed()}`)}>Regen with a new seed</Button>
        <a className="btn btn-secondary" href={`#/audition/${set.id}`} data-testid="set-audition">Audition</a>
        {message && <span className={`small ${message.error ? 'error' : 'dim'}`} role="status" data-testid="set-message">{message.text}</span>}
      </div>
      {!members.length && <p className="dim">This set has no members.</p>}
      {members.length > 0 && (
        <div className="set-main">
          <div className="set-left">
            <SetMeter target={target} tolerance={tolerance} label={`each mark is one sound's current version; the band is ${set.class ? `the class "${set.class}"` : set.target !== null ? 'the target' : 'the middle member'} ±${tolerance} LU`} marks={members.map((m, i) => ({ id: m.s.id, n: m.n, lufs: lufsNow[i] }))} />
            <div className="cg-panel" data-testid="members">
              <ClipGrid cols={cols} rows={rows} cursor={at} picked={picked} playing={playingKey} label={`The versions of the members of ${set.id}`}
                onClick={(c, add) => { setCursor(c.key); setPicked((p) => (add ? [...p.filter((k) => k !== c.key), c.key].slice(-2) : [c.key])); if (!add) play(c); }}
                onEnter={(c) => { setCursor(c.key); void makeCurrent(c); }}
                onDrop={onDrop} />
              <div className="cg-foot-note small">
                <span>Click a cell to play it · <span className="kbd">↵</span> makes it the current version</span>
                <span>Dashed violet = proposed by the agent, not yet approved</span>
                <span>Drag two cells onto the A/B card, or pick two (⇧-click) and press <span className="kbd">C</span>, to compare them blind</span>
              </div>
              {sel.length > 0 && (
                <div className="cg-selbar" data-testid="set-selection">
                  <span className="small">{sel.map((c) => c.name).join(' and ')} picked</span>
                  <span className="spacer" />
                  {sel.length === 2
                    ? <Button kind="primary" testId="sel-compare" onClick={comparePicked}>Compare blind <span className="kbd">C</span></Button>
                    : <Button testId="sel-compare-current" disabled={sel[0]!.current} onClick={() => compareWithCurrent(sel[0]!)}>Compare with current <span className="kbd">C</span></Button>}
                  {sel.length === 1 && <Button testId="sel-make-current" disabled={sel[0]!.current && !sel[0]!.proposed} onClick={() => void makeCurrent(sel[0]!)}>{sel[0]!.proposed ? 'Approve' : 'Make current'} <span className="kbd">↵</span></Button>}
                </div>
              )}
            </div>
          </div>
          <div className="set-right">
            <ABCard store={store} ab={ab} moment={moment} where="this set's sounds"
              onWriteMoment={async (text) => { const r = await store.run(`set moment ${set.id} ${quoteText(text)}`); return r.ok ? null : r.errors[0]?.message ?? 'refused'; }}
              empty={<>Every version has been compared. Drag two cells here, or pick two and press <span className="kbd">C</span>.</>} />
            <TallyCard store={store} />
          </div>
        </div>
      )}
      <section className="panel" data-testid="spread-numbers" aria-label="Spread">
        <h3>The spread</h3>
        <div className="dim" data-testid="spread-rules">{set.spread.length ? <>rules: <code>{formatSpread(set.spread)}</code></> : 'no variation rules (the members are the sounds as they are)'}</div>
        {measure ? (
          <>
            <table className="matrix" data-testid="matrix">
              <thead><tr><th>dB apart</th>{summaries.map((m, j) => <th key={m.id} title={m.id}>{j + 1}</th>)}</tr></thead>
              <tbody>
                {summaries.map((a, i) => (
                  <tr key={a.id}>
                    <th title={a.id}>{i + 1} {a.id}</th>
                    {summaries.map((b, j) => {
                      const d = measure.matrix[i]![j]!;
                      const bad = i !== j && (d < style.setSpreadMin || d > style.setSpreadMax);
                      return <td key={b.id} data-testid={`dist-${i + 1}-${j + 1}`} data-bad={bad} className={i === j ? 'diag' : bad ? 'bad' : ''}>{i === j ? '–' : d.toFixed(1)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div data-testid="set-verdict" className={measure.result.pass ? '' : 'error'}>{measure.result.value}</div>
            <div className="dim">held to: {measure.result.threshold}</div>
            {measure.result.ranges.map((r, i) => <div key={i} className="error" data-testid="set-flag">{r.note}</div>)}
          </>
        ) : <p className="dim">A set needs two members to be compared.</p>}
      </section>
    </section>
  );
}
