// The batch audition page: every sound of the project (or of one set) on one page as compact
// cards, each with play, the check badge and the feedback controls, a play-all with gaps, filters
// (tag, status, check) and the keyboard: arrows move, space plays, a approves, r asks for changes.

import { useEffect, useMemo, useRef, useState } from 'react';
import { checksPass, type Sound } from '@soundclaw/core';
import { Feedback } from './SoundCard.tsx';
import type { Store } from './store.ts';
import { Waveform } from './Waveform.tsx';

type StatusFilter = 'any' | 'draft' | 'approved' | 'rejected';
type CheckFilter = 'any' | 'pass' | 'fail';

function typing(t: EventTarget | null): boolean {
  const e = t as HTMLElement | null;
  return !!e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT' || e.isContentEditable);
}

function Card({ store, sound, selected, asking, onSelect, onAsk }: { store: Store; sound: Sound; selected: boolean; asking: boolean; onSelect(): void; onAsk(open: boolean): void }) {
  const m = store.measure(sound);
  const pass = checksPass(m.checks);
  const failing = m.checks.filter((k) => !k.pass).map((k) => k.name);
  const playing = store.playing === sound.id;
  const current = store.sequence?.ids[store.sequence.index] === sound.id;
  const [feeding, setFeeding] = useState(false);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (selected) ref.current?.scrollIntoView({ block: 'nearest' }); }, [selected]);
  useEffect(() => { if (asking) noteRef.current?.focus(); }, [asking]);
  const tags = [...new Set(store.requests.filter((q) => q.sound === sound.id).flatMap((q) => q.tags ?? []))];
  const send = async () => {
    const r = await store.askForChanges(sound.id, note);
    if (r.ok) { onAsk(false); setNote(''); setProblem(null); } else setProblem(r.error ?? 'refused');
  };
  return (
    <article ref={ref} className={`card aud${selected ? ' selected' : ''}${current ? ' current' : ''}`} data-testid={`aud-${sound.id}`} data-selected={selected} data-current={current} data-status={sound.status} data-pass={pass} onClick={onSelect}>
      <header>
        <h2>{sound.id}</h2>
        <span className={`chip check-${pass ? 'pass' : 'fail'}`} data-testid={`aud-check-${sound.id}`} data-pass={pass} data-failing={failing.join(',')} title={failing.join(', ')}>{pass ? '✓' : `✗ ${failing.join(', ')}`}</span>
        <span className={`chip status-${sound.status}`} data-testid={`aud-status-${sound.id}`}>{sound.status}</span>
      </header>
      <Waveform samples={store.render(sound)} id={`aud-${sound.id}`} />
      <div className="dim analysis">{m.analysis.duration.toFixed(2)} s · {Number.isFinite(m.analysis.lufs) ? m.analysis.lufs.toFixed(1) : '−∞'} LUFS{tags.length ? ` · ${tags.join(', ')}` : ''}</div>
      <div className="card-actions">
        <button className="play" data-testid={`aud-play-${sound.id}`} data-playing={playing} onClick={(e) => { e.stopPropagation(); onSelect(); void store.play(sound.id); }}>{playing ? '■' : '▶'}</button>
        <button data-testid={`aud-approve-${sound.id}`} disabled={sound.status === 'approved'} onClick={(e) => { e.stopPropagation(); void store.approve(sound.id); }}>Approve</button>
        <button data-testid={`aud-ask-${sound.id}`} aria-expanded={asking} onClick={(e) => { e.stopPropagation(); onAsk(!asking); }}>Ask</button>
        <button data-testid={`aud-feedback-toggle-${sound.id}`} aria-expanded={feeding} onClick={(e) => { e.stopPropagation(); setFeeding(!feeding); }}>Feedback</button>
      </div>
      {asking && (
        <div className="ask" onClick={(e) => e.stopPropagation()}>
          <textarea ref={noteRef} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change?" data-testid={`aud-ask-text-${sound.id}`}
            onKeyDown={(e) => { if (e.key === 'Escape') onAsk(false); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && note.trim()) void send(); }} />
          <button disabled={!note.trim()} data-testid={`aud-ask-send-${sound.id}`} onClick={() => void send()}>Send</button>
          {problem && <div className="error">{problem}</div>}
        </div>
      )}
      {feeding && <div onClick={(e) => e.stopPropagation()}><Feedback store={store} sound={sound} /></div>}
    </article>
  );
}

export function AuditionPage({ store, setId }: { store: Store; setId: string | null }) {
  const set = setId ? store.sets.find((s) => s.id === setId) ?? null : null;
  const [status, setStatus] = useState<StatusFilter>('any');
  const [check, setCheck] = useState<CheckFilter>('any');
  const [tag, setTag] = useState('');
  const [gap, setGap] = useState(500);
  const [sel, setSel] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);

  const pool = set ? set.members.map((id) => store.sounds.find((s) => s.id === id)).filter((s): s is Sound => !!s) : store.sounds;
  const allTags = useMemo(() => [...new Set(store.requests.filter((q) => pool.some((s) => s.id === q.sound)).flatMap((q) => q.tags ?? []))].sort(), [store.requests, pool.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = pool.filter((s) => {
    if (status !== 'any' && s.status !== status) return false;
    if (check !== 'any' && checksPass(store.measure(s).checks) !== (check === 'pass')) return false;
    if (tag && !store.requests.some((q) => q.sound === s.id && (q.tags ?? []).includes(tag))) return false;
    return true;
  });
  const ids = shown.map((s) => s.id);
  const cur = sel && ids.includes(sel) ? sel : ids[0] ?? null;

  // the keyboard: arrows move, space plays, a approves, r asks for changes
  const keys = useRef({ ids, cur, store });
  keys.current = { ids, cur, store };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const { ids: list, cur: at, store: st } = keys.current;
      if (!list.length) return;
      const i = at ? list.indexOf(at) : 0;
      const cols = Math.max(1, (grid.current ? getComputedStyle(grid.current).gridTemplateColumns.split(' ').length : 1));
      const move = (to: number) => { setSel(list[Math.max(0, Math.min(list.length - 1, to))]!); e.preventDefault(); };
      if (e.key === 'ArrowRight') move(i + 1);
      else if (e.key === 'ArrowLeft') move(i - 1);
      else if (e.key === 'ArrowDown') move(i + cols);
      else if (e.key === 'ArrowUp') move(i - cols);
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
  return (
    <section className="audition" data-testid="audition" data-count={shown.length}>
      <header className="editor-head">
        <a href="#/" className="back" data-testid="back">← all sounds</a>
        <h2>Audition{set ? ` · set ${set.id}` : ''}</h2>
        <span className="dim" data-testid="aud-count">{shown.length} of {pool.length} sounds · {counts.approved} approved · {counts.rejected} asked for changes</span>
        <span className="spacer" />
        <label className="dim">gap <input type="number" min={0} max={5000} step={50} value={gap} data-testid="aud-gap" style={{ width: '5em' }} onChange={(e) => setGap(Math.max(0, Number(e.target.value)))} /> ms</label>
        <button className="play" data-testid="aud-play-all" data-playing={sequencing} disabled={!shown.length} onClick={() => void (sequencing ? store.stopSequence() : store.playSequence(ids, gap))}>{sequencing ? '■ Stop' : '▶ Play all'}</button>
      </header>
      <div className="filters row wrap" data-testid="aud-filters">
        <label>set
          <select data-testid="aud-set" value={setId ?? ''} onChange={(e) => { location.hash = e.target.value ? `#/audition/${e.target.value}` : '#/audition'; }}>
            <option value="">all sounds</option>
            {store.sets.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
          </select>
        </label>
        <label>status
          <select data-testid="aud-filter-status" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="any">any</option><option value="draft">draft</option><option value="approved">approved</option><option value="rejected">asked for changes</option>
          </select>
        </label>
        <label>checks
          <select data-testid="aud-filter-check" value={check} onChange={(e) => setCheck(e.target.value as CheckFilter)}>
            <option value="any">any</option><option value="pass">pass</option><option value="fail">fail</option>
          </select>
        </label>
        <label>tag
          <select data-testid="aud-filter-tag" value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">any</option>
            {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <span className="dim">← → ↑ ↓ move · space plays · a approves · r asks for changes</span>
      </div>
      {setId && !set && <p className="error">No set “{setId}”.</p>}
      {!shown.length && <p className="dim" data-testid="aud-empty">No sounds match.</p>}
      <div className="aud-grid" ref={grid} data-testid="aud-grid">
        {shown.map((s) => <Card key={s.id} store={store} sound={s} selected={s.id === cur} asking={asking === s.id} onSelect={() => setSel(s.id)} onAsk={(open) => setAsking(open ? s.id : null)} />)}
      </div>
    </section>
  );
}
