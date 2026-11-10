// The batch audition page: every sound of the project (or of one set) as a row of the clip grid with
// one column, the version each sound holds now. Each row plays, shows its check, and has approve, ask
// and feedback; play-all goes through the rows with gaps; the filters narrow them; two rows picked
// (⇧-click, or dragged) go on the blind A/B card. The keyboard: arrows move, space plays, a approves,
// r asks for changes, c compares the picks, and A/B/=/N answer while a pair is on the card.

import { useEffect, useMemo, useRef, useState } from 'react';
import { quoteText, momentOf } from '@soundclaw/core';
import type { SoundSummary } from '@soundclaw/server/protocol';
import { ABCard, TallyCard, useBlindAB, type PairSide } from './sets/ABCard.tsx';
import { ClipGrid, type CellModel, type RowModel } from './sets/ClipGrid.tsx';
import { FilterBar, NO_FILTERS, matches, useMore, type Filters } from './SoundList.tsx';
import { Feedback } from './SoundCard.tsx';
import { Badge, Button } from './studio/controls.tsx';
import { MiniWave } from './studio/Library.tsx';
import { inTextField } from './studio/registry.ts';
import { lastChanges, lufsText } from './studio/shellData.ts';
import type { Store } from './store.ts';
import { plural } from './studio/values.ts';

function AskBox({ store, id, onClose }: { store: Store; id: string; onClose(): void }) {
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const send = async () => {
    const r = await store.askForChanges(id, note);
    if (r.ok) { onClose(); setNote(''); setProblem(null); } else setProblem(r.error ?? 'refused');
  };
  return (
    <div className="ask cg-below" onClick={(e) => e.stopPropagation()}>
      <textarea ref={ref} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change?" data-testid={`aud-ask-text-${id}`}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && note.trim()) void send(); }} />
      <Button kind="primary" disabled={!note.trim()} testId={`aud-ask-send-${id}`} onClick={() => void send()}>Send</Button>
      {problem && <div className="error">{problem}</div>}
    </div>
  );
}

export function AuditionPage({ store, setId }: { store: Store; setId: string | null }) {
  const set = setId ? store.sets.find((s) => s.id === setId) ?? null : null;
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [gap, setGap] = useState(500);
  const [sel, setSel] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [feeding, setFeeding] = useState<Set<string>>(() => new Set());
  const [picked, setPicked] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const pool = set ? set.members.map((id) => store.summary(id)).filter((s): s is SoundSummary => !!s) : store.index;
  const tagMap = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const q of store.requests) if (q.tags?.length) m.set(q.sound, [...(m.get(q.sound) ?? []), ...q.tags]);
    return m;
  }, [store.requests]);
  const allTags = useMemo(() => [...new Set(pool.flatMap((s) => tagMap.get(s.id) ?? []))].sort(), [tagMap, pool.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = pool.filter((s) => matches(s, filters, (id) => tagMap.get(id) ?? []));
  const ids = shown.map((s) => s.id);
  const cur = sel && ids.includes(sel) ? sel : ids[0] ?? null;
  const { shown: upto, sentinel, more } = useMore(shown.length, JSON.stringify(filters) + (setId ?? ''));
  // the keyboard may move past the rows drawn so far: draw up to the selection
  const drawn = Math.max(upto, cur ? ids.indexOf(cur) + 1 : 0);
  const lastSeq = store.tape.at(-1)?.seq ?? 0;
  const changed = lastChanges(store.tape, store.index);
  const seqOf = (id: string): number => changed.get(id) || lastSeq || 1;

  // the A/B card: nothing is queued on this page; a pair is what the person picks
  const refId = useRef<string | undefined>(undefined);
  const momentFor = (id: string | undefined) => { const d = id ? store.doc(id) : undefined; return d ? momentOf(d, store.sets) : null; };
  const ab = useBlindAB(store, [], () => momentFor(refId.current)?.text ?? null);
  refId.current = ab.pair?.ref.id;
  const sideOf = async (id: string): Promise<PairSide | null> => { const doc = await store.docNow(id); return doc ? { id, seq: seqOf(id), doc, name: id } : null; };
  const comparePair = async (x: string, y: string) => {
    if (x === y) return;
    const [a, b] = await Promise.all([sideOf(x), sideOf(y)]);
    if (a && b) { ab.put([a, b]); setMessage(null); }
  };
  const comparePicked = () => {
    const [x, y] = picked.filter((id) => ids.includes(id));
    if (x && y) void comparePair(x, y);
    else setMessage('Pick two sounds to compare (⇧-click the second one), or drag them onto the A/B card.');
  };

  // the keyboard: arrows move, space plays, a approves, r asks for changes, c compares, A/B/=/N answer, Tab switches, → next
  const keys = useRef({ ids, cur, store, ab, comparePicked });
  keys.current = { ids, cur, store, ab, comparePicked };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || inTextField(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const { ids: list, cur: at, store: st, ab: card } = keys.current;
      if (e.key === 'Tab' && st.ab) { e.preventDefault(); st.switchAB(); return; }
      const answer = ({ a: 'a', b: 'b', '=': 'both', n: 'neither' } as const)[e.key.toLowerCase() as 'a'];
      if (answer && card.pair && !card.answered && !card.busy) { e.preventDefault(); void card.answer(answer); return; }
      if (e.key === 'ArrowRight' && card.answered) { e.preventDefault(); card.next(); return; }
      if (e.key === 'c' || e.key === 'C') { e.preventDefault(); keys.current.comparePicked(); return; }
      if (!list.length) return;
      const i = at ? list.indexOf(at) : 0;
      const move = (to: number) => { setSel(list[Math.max(0, Math.min(list.length - 1, to))]!); e.preventDefault(); };
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(i + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(i - 1);
      else if (e.key === ' ' && at) { e.preventDefault(); void st.play(at); }
      else if (e.key === 'a' && at) { e.preventDefault(); void st.approve(at); }
      else if (e.key === 'r' && at) { e.preventDefault(); setAsking(at); }
      else if (e.key === 'Escape') setAsking(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => () => store.stopSequence(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const sequencing = store.sequence !== null;
  const counts = { approved: pool.filter((s) => s.status === 'approved').length, rejected: pool.filter((s) => s.status === 'rejected').length };
  const unchecked = pool.filter((s) => !s.info).length;

  const rows: RowModel[] = shown.slice(0, drawn).map((s) => {
    const info = s.info ?? store.cardOf(s.id);
    const pass = info?.pass;
    const failing = info?.failing ?? [];
    const playing = store.playing === s.id;
    const current = store.sequence?.ids[store.sequence.index] === s.id;
    const selected = s.id === cur;
    const tags = [...new Set(tagMap.get(s.id) ?? [])];
    const seq = seqOf(s.id);
    const cell: CellModel = {
      key: s.id, id: s.id, seq, label: 'current', name: s.id, current: true, proposed: false,
      lufs: info ? info.lufs : undefined, kind: info ? (info.failing.some((f) => f.startsWith('loud')) ? 'fail' : 'pass') : 'checking',
      duration: info?.duration, wave: <MiniWave store={store} id={s.id} w={220} h={30} />,
    };
    return {
      id: s.id, digit: null, testId: `aud-${s.id}`, cells: [cell],
      attrs: { 'data-selected': String(selected), 'data-current': String(current), 'data-status': s.status, ...(pass === undefined ? {} : { 'data-pass': String(pass) }) },
      head: (
        <div className="aud-head" onClick={() => setSel(s.id)}>
          <span className="aud-line">
            <a className="cg-id" href={`#/sound/${s.id}`} onClick={(e) => e.stopPropagation()}>{s.id}</a>
            <span className={`chip status-${s.status}`} data-testid={`aud-status-${s.id}`}>{s.status}</span>
            <span className="badge" data-kind={pass === undefined ? 'checking' : pass ? 'pass' : 'fail'} data-testid={`aud-check-${s.id}`} {...(pass === undefined ? {} : { 'data-pass': pass })} data-failing={failing.join(',')} title={failing.join(', ')}><span className="mono" aria-hidden>{pass === undefined ? '…' : pass ? '✓' : '×'}</span>{pass === false ? failing.join(', ') : null}</span>
          </span>
          <span className="aud-line">
            <button type="button" className="ib ib-quiet" data-testid={`aud-play-${s.id}`} data-playing={playing} aria-label={`${playing ? 'Stop' : 'Play'} ${s.id}`} onClick={(e) => { e.stopPropagation(); setSel(s.id); void store.play(s.id); }}>{playing ? '■' : '▶'}</button>
            <span className="mono dim small aud-numbers">{info ? `${info.duration.toFixed(2)} s · ${lufsText(info.lufs)} LUFS` : '…'}{tags.length ? ` · ${tags.join(', ')}` : ''}</span>
            <button type="button" className="btn btn-quiet" data-testid={`aud-approve-${s.id}`} disabled={s.status === 'approved'} onClick={(e) => { e.stopPropagation(); void store.approve(s.id); }}>Approve</button>
            <button type="button" className="btn btn-quiet" data-testid={`aud-ask-${s.id}`} aria-expanded={asking === s.id} onClick={(e) => { e.stopPropagation(); setAsking(asking === s.id ? null : s.id); }}>Ask</button>
            <button type="button" className="btn btn-quiet" data-testid={`aud-feedback-toggle-${s.id}`} aria-expanded={feeding.has(s.id)} onClick={(e) => { e.stopPropagation(); setFeeding((f) => { const n = new Set(f); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; }); }}>Feedback</button>
          </span>
        </div>
      ),
      below: (asking === s.id || feeding.has(s.id)) ? (
        <>
          {asking === s.id && <AskBox store={store} id={s.id} onClose={() => setAsking(null)} />}
          {feeding.has(s.id) && <div className="cg-below" onClick={(e) => e.stopPropagation()}><Feedback store={store} sound={s} /></div>}
        </>
      ) : undefined,
    };
  });

  // the selected row scrolls into view as the keyboard moves
  useEffect(() => { if (cur) document.querySelector(`[data-testid="aud-${CSS.escape(cur)}"]`)?.scrollIntoView({ block: 'nearest' }); }, [cur]);

  const moment = ab.pair ? momentFor(ab.pair.ref.id) : null;
  return (
    <section className="audition studio-page" data-testid="audition" data-count={shown.length}>
      <header className="set-head">
        <a href="#/" className="back" data-testid="back">← all sounds</a>
        <h1 className="set-title">Audition{set ? ` · set ${set.id}` : ''}</h1>
        <span className="set-chip" data-testid="aud-count">{shown.length} of {plural(pool.length, 'sound')} · {counts.approved} approved · {counts.rejected} asked for changes</span>
        <span className="spacer" />
        <label className="dim small">gap <input type="number" min={0} max={5000} step={50} value={gap} data-testid="aud-gap" className="num-input" onChange={(e) => setGap(Math.max(0, Number(e.target.value)))} /> ms</label>
        <button type="button" className="btn btn-primary" data-testid="aud-play-all" data-playing={sequencing} disabled={!shown.length} onClick={() => void (sequencing ? store.stopSequence() : store.playSequence(ids, gap))}>{sequencing ? '■ Stop' : '▶ Play all'}</button>
      </header>
      <div className="set-tools">
        <label className="small">set{' '}
          <select data-testid="aud-set" value={setId ?? ''} onChange={(e) => { location.hash = e.target.value ? `#/audition/${e.target.value}` : '#/audition'; }}>
            <option value="">all sounds</option>
            {store.sets.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
          </select>
        </label>
        <span className="dim small">↑ ↓ move · space plays · a approves · r asks for changes · ⇧-click two and c compares them blind{unchecked ? ` · ${unchecked} not checked yet` : ''}</span>
        {message && <span className="small dim" role="status" data-testid="aud-message">{message}</span>}
      </div>
      <FilterBar filters={filters} set={setFilters} tags={allTags} prefix="aud" />
      {setId && !set && <p className="error">No set “{setId}”.</p>}
      {!shown.length && <p className="dim" data-testid="aud-empty">No sounds match.</p>}
      <div className="set-main" data-page="audition">
        <div className="set-left">
          <div className="cg-panel" data-testid="aud-grid">
            <ClipGrid cols={[{ label: 'current' }]} rows={rows} cursor={cur} picked={picked} playing={store.playing && ids.includes(store.playing) ? store.playing : null} headWidth={430} testId="aud-clip-grid" label="The sounds, as they are now"
              onClick={(c, add) => { setSel(c.id); if (add) setPicked((p) => [...p.filter((k) => k !== c.id), c.id].slice(-2)); else { setPicked([c.id]); void store.play(c.id); } }}
              onEnter={(c) => { setSel(c.id); if (store.summary(c.id)?.status !== 'approved') void store.approve(c.id); }}
              onDrop={(c) => { const prev = picked.find((k) => k !== c.id); if (prev) { void comparePair(prev, c.id); setPicked([]); } else { setPicked([c.id]); setMessage(`${c.id} is on its way: drag or ⇧-click a second sound to compare it with.`); } }} />
            {drawn < shown.length && <div ref={sentinel} className="more" data-testid="aud-more"><Button onClick={more}>Show more</Button></div>}
          </div>
        </div>
        <div className="set-right">
          <ABCard store={store} ab={ab} moment={moment} where={ab.pair?.ref.id ?? 'the sound'}
            onWriteMoment={async (text) => { const id = ab.pair?.ref.id; if (!id) return 'no sound'; const r = await store.run(`sound set ${id} moment=${quoteText(text)}`); return r.ok ? null : r.errors[0]?.message ?? 'refused'; }}
            empty={<>Pick two sounds (click one, ⇧-click another) and press <span className="kbd">C</span>, or drag them here, to compare them blind at matched loudness.</>} />
          <TallyCard store={store} />
        </div>
      </div>
    </section>
  );
}
