// A review: what the agent did for a request (or in one tape group), from the server's `changes` work. Before (A) and after (B)
// waveforms aligned on the onset with the checks' markers, the parameters old → new with who changed them, the agent's note, the
// numbers before → after with check glyphs, and level-matched A/B (Tab switches in time). Approve keeps B, Ask again sends a new
// request linked to this one, Revert restores A with one batch by the person. Each lands on the tape, offers Undo for ten seconds
// (outside this page) and sends focus back to where the review was opened from.

import { useEffect, useMemo, useRef, useState } from 'react';
import { songFromJson, targetWords, type Sound } from '@soundclaw/core';
import type { Review as ReviewData, ReviewSide } from '@soundclaw/server/protocol';
import { matchGains, gainText } from '../sets/abmath.ts';
import type { Store } from '../store.ts';
import { AuthorDot, AuthorMark, Button, Kbd, useToast } from './controls.tsx';
import { offerUndo } from './decisions.tsx';
import { Spark } from './icons.tsx';
import { useActions, type Action } from './registry.ts';
import { ago, requestState } from './shellData.ts';

// ---- where the review was opened from -------------------------------------------------------------------------------------------

let origin: { hash: string; testId: string | null } | null = null;
if (typeof document !== 'undefined') {
  const note = (e: Event): void => {
    const a = (e.target as HTMLElement | null)?.closest?.('a[href^="#/review/"]');
    if (a) origin = { hash: location.hash || '#/', testId: a.getAttribute('data-testid') };
  };
  document.addEventListener('click', note, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter') note(e); }, true);
}

/** Close the review: back to the page it came from, with focus on the thing that opened it (or, if that is gone, on the page). */
function leave(): void {
  const o = origin ?? { hash: '#/session', testId: null };
  origin = null;
  location.hash = o.hash === location.hash ? '#/session' : o.hash;
  const t0 = Date.now();
  const tryFocus = (): void => {
    const el = (o.testId ? document.querySelector<HTMLElement>(`[data-testid="${o.testId}"]`) : null) ?? (Date.now() - t0 > 600 ? document.getElementById('page') : null);
    if (el) { if (!el.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT)$/.test(el.tagName)) el.tabIndex = -1; el.focus({ preventScroll: true }); }
    else setTimeout(tryFocus, 40);
  };
  setTimeout(tryFocus, 60);
}

// ---- the waveforms ------------------------------------------------------------------------------------------------------------

const W = 600, H = 72;

function onsetOf(o: { max: ArrayLike<number>; min: ArrayLike<number>; duration: number } | null): number {
  if (!o) return 0;
  let peak = 0;
  for (let i = 0; i < o.max.length; i++) peak = Math.max(peak, Math.abs(o.max[i]!), Math.abs(o.min[i]!));
  const thr = Math.max(0.01, peak * 0.04);
  for (let i = 0; i < o.max.length; i++) if (Math.abs(o.max[i]!) > thr || Math.abs(o.min[i]!) > thr) return (i / o.max.length) * o.duration;
  return 0;
}

function pathOf(o: { max: ArrayLike<number>; min: ArrayLike<number>; duration: number }, onset: number, lead: number, span: number): string {
  const n = o.max.length;
  const top: string[] = [], bot: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * o.duration - onset + lead;
    const x = (t / span) * W;
    if (x < 0 || x > W) continue;
    top.push(`${x.toFixed(1)} ${(H / 2 - Math.max(0, o.max[i]!) * (H / 2 - 2)).toFixed(1)}`);
    bot.push(`${x.toFixed(1)} ${(H / 2 - Math.min(0, o.min[i]!) * (H / 2 - 2)).toFixed(1)}`);
  }
  return top.length ? `M${top.join(' L')} L${bot.reverse().join(' L')} Z` : '';
}

function ReviewWave({ letter, side, outline, onset, lead, span, on, onPick, tag, tagTone, agent, playing }: {
  letter: 'A' | 'B'; side: ReviewSide; outline: { max: ArrayLike<number>; min: ArrayLike<number>; duration: number } | null; onset: number; lead: number; span: number; on: boolean; onPick(): void; tag: string; tagTone: 'fail' | 'agent' | 'pass'; agent: boolean; playing: boolean;
}) {
  const marks = side.checks.filter((c) => !c.pass && c.at.length).flatMap((c) => c.at.map((t) => ({ name: c.name, t, value: c.value })));
  return (
    <div className="rv-wave-row">
      <button type="button" className={`rv-side${on ? ' on' : ''}`} aria-pressed={on} onClick={onPick} data-testid={`review-pick-${letter.toLowerCase()}`}>{letter}{playing ? ' ▶' : ''}</button>
      <div className={`rv-wave${on ? ' on' : ''}`} data-testid={`review-wave-${letter.toLowerCase()}`}>
        <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
          {outline && <path d={pathOf(outline, onset, lead, span)} className={agent ? 'rv-ink agent' : 'rv-ink'} />}
          <rect x={(lead / span) * W} y="0" width="1.5" height={H} className="rv-onset" />
          {marks.map((m, i) => <rect key={i} x={((m.t - onset + lead) / span) * W - 1} y="0" width="2.4" height={H} className="rv-marker" data-testid={`review-marker-${letter.toLowerCase()}`} />)}
        </svg>
        <span className={`rv-tag mono tone-${tagTone}`} data-testid={`review-tag-${letter.toLowerCase()}`}>{tag}</span>
      </div>
    </div>
  );
}

const glyph = (g: 'pass' | 'fail' | ''): string => (g === 'pass' ? '✓' : g === 'fail' ? '×' : '');

// ---- the page ----------------------------------------------------------------------------------------------------------------

export function Review({ store, id }: { store: Store; id: string }) {
  const toast = useToast();
  const q = /^r\d+$/.test(id) ? store.requests.find((x) => x.id === id) : undefined;
  const [data, setData] = useState<ReviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [side, setSide] = useState<'A' | 'B'>('B');
  const [asking, setAsking] = useState(false);
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    store.review(id).then((r) => { if (live) setData(r); }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [store, id]);
  useEffect(() => { if (asking) area.current?.focus(); }, [asking]);

  const A = data?.before ?? null, B = data?.after ?? null;
  const outA = useMemo(() => (A?.sound ? store.lensOutline(A.sound) : null), [store, A, store.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const outB = useMemo(() => (B?.sound ? store.lensOutline(B.sound) : null), [store, B, store.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const onA = onsetOf(outA), onB = onsetOf(outB);
  const lead = 0.03;
  const span = Math.max(0.1, (outA ? outA.duration - onA : 0) + lead, (outB ? outB.duration - onB : 0) + lead, 0.1);
  const gains = A && B ? matchGains({ lufs: A.lufs, truePeakDb: A.truePeakDb }, { lufs: B.lufs, truePeakDb: B.truePeakDb }) ?? { a: 0, b: 0 } : { a: 0, b: 0 };
  const playingAB = store.ab !== null;
  const heard = store.ab?.side ?? (store.playing === 'review#A' ? 'A' : store.playing === 'review#B' ? 'B' : null);

  const songSides = useMemo(() => (data?.song ? { a: data.song.before ? songFromJson(data.song.before) : null, b: data.song.after ? songFromJson(data.song.after) : null } : null), [data]);

  /** Hear the pair, level-matched: both sides start together and Tab switches which is heard, in time. */
  const play = async (which: 'A' | 'B' = side): Promise<void> => {
    if (!data) return;
    if (songSides) {
      const s = which === 'A' ? songSides.a : songSides.b;
      if (!s) return;
      const r = store.songRender(s, 'loop');
      await store.playBuffer(`review#${which}`, data.item, [...r.mix], which === 'A' ? songGain(store, songSides, 'a') : songGain(store, songSides, 'b'), true);
      return;
    }
    if (!A?.sound || !B?.sound) return;
    await Promise.all([store.ensureSamples(A.sound), store.ensureSamples(B.sound)]);
    const dur = Math.max(A.duration, B.duration);
    await store.playAB({ id: data.item, seq: Math.max(0, data.first - 1), doc: A.sound, gain: gains.a }, { id: data.item, seq: data.last, doc: B.sound, gain: gains.b }, which, 6, Math.max(0.5, dur + 0.25));
  };
  const toggleSide = (): void => {
    if (store.ab && store.switchAB()) { setSide(store.ab?.side ?? side); return; }
    const next = side === 'A' ? 'B' : 'A';
    setSide(next);
    if (songSides && store.playing?.startsWith('review#')) void play(next);
  };
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!store.ab && !store.playing?.startsWith('review#')) return;
      e.preventDefault();
      toggleSide();
    };
    document.addEventListener('keydown', on);
    return () => { document.removeEventListener('keydown', on); };
  });
  useEffect(() => () => { if (store.ab || store.playing?.startsWith('review#')) store.stop(); }, [store]);

  // ---- the three decisions -----------------------------------------------------------------------------------------------------

  const song = !!data?.song;
  const markCmd = data ? `${song ? 'song' : 'sound'} mark ${data.item} approved` : '';
  const finish = (): void => { leave(); };

  const undoGroup = (group: string | null) => async (): Promise<void> => {
    if (group) await store.run(`undo group=${group}`);
  };

  const approve = async (): Promise<void> => {
    if (!data || busy) return;
    setBusy(true);
    const r = await store.run(markCmd);
    if (!r.ok) { setBusy(false); setProblem(r.errors[0]?.message ?? 'refused'); return; }
    if (q) await store.decide(q.id, 'approved');
    setBusy(false);
    offerUndo(`you approved ${data.item}${q ? ` · request ${q.id} closed` : ''}`, async () => { await undoGroup(r.group)(); if (q) await store.decide(q.id, 'undone'); });
    finish();
  };

  const revert = async (): Promise<void> => {
    if (!data || busy) return;
    setBusy(true);
    const c = await store.restoreFor(data);
    if (!('commands' in c)) { setBusy(false); setProblem(c.error); return; }
    if (!c.commands.length) { setBusy(false); toast(`${data.item} already sounds as it did before.`); return; }
    const r = await store.run(c.commands.join('\n'));
    if (!r.ok) { setBusy(false); setProblem(r.errors[0]?.message ?? 'refused'); return; }
    if (q) await store.decide(q.id, 'reverted');
    setBusy(false);
    offerUndo(`you reverted ${data.item} to before ${q ? `request ${q.id}` : data.groups[0]}`, async () => { await undoGroup(r.group)(); if (q) await store.decide(q.id, 'undone'); });
    finish();
  };

  const askAgain = async (): Promise<void> => {
    if (!data || busy || !again.trim()) return;
    setBusy(true);
    const r = await store.request({ action: 'request', kind: 'change', sound: data.item, note: again.trim(), ...(q ? { again: q.id } : {}) });
    setBusy(false);
    if (!r.ok || !r.request) { setProblem(r.error ?? 'the request was refused'); return; }
    const nq = r.request;
    offerUndo(`you asked again on ${data.item}: “${again.trim()}”`, async () => {
      await store.request({ action: 'cancel', id: nq.id });
      const g = nq.mark !== undefined ? store.tape.find((e) => e.seq === nq.mark)?.group ?? null : null;
      await undoGroup(g)();
    });
    setAsking(false);
    finish();
  };

  const decide: Action[] = [
    { id: 'edit.approve', label: 'Approve this review', group: 'Edit', shortcut: '⌘ ↵', key: 'mod+enter', override: true, inText: false, run: () => { void approve(); }, enabled: () => !!data && !busy && !asking },
  ];
  useActions(decide);

  if (error) return <section className="review" data-testid="review"><p className="dim" data-testid="no-review">{error}. <a href="#/session">{'←'} the session</a></p></section>;
  if (!data) return <section className="review" data-testid="review"><p className="dim" data-testid="review-loading">{store.status === 'open' ? 'Working out what changed…' : 'Connecting…'}</p></section>;

  const st = q ? requestState(q) : null;
  const decided = q?.reviewed;
  const statusWord = decided ? decided.how : st ? st.word : 'agent group';
  const statusTone = decided ? (decided.how === 'asked again' ? 'agent' : decided.how === 'approved' ? 'pass' : 'quiet') : st?.tone ?? 'agent';
  const stillThere = song ? data.song!.stillThere : !!store.index.some((x) => x.id === data.item);
  const failingNow = (s: ReviewSide | null) => (s ? s.checks.filter((c) => !c.pass).map((c) => c.name) : []);
  const tagA = failingNow(A).length ? `before · × ${A!.checks.filter((c) => !c.pass).map((c) => `${c.name}${c.at[0] !== undefined ? ` ${c.at[0].toFixed(3)} s` : ''}`).join(', ')}` : 'before · checks pass';
  const tagB = failingNow(B).length ? `after · agent · × ${failingNow(B).join(', ')}` : `after · ${data.by.replace(/^agent:/, '')} · ✓ checks pass`;

  return (
    <section className="review rv" data-testid="review" data-item={data.item} data-request={data.request ?? undefined} data-kind={data.kind} data-state={decided ? decided.how : 'ready'}>
      <div className="rv-head">
        <span className="cap">Review</span>
        <b className="rv-item" data-testid="review-item">{data.item}</b>
        <span className="dim small">{q ? <>request {q.id} {'“'}{q.note}{'”'}</> : <>group {data.groups.join(', ')}</>} {'·'} {data.by.startsWith('human:') ? 'you' : data.by.replace(/^agent:/, '')} {'·'} {ago(data.at, Date.now())}</span>
        {q?.target && <span className="mono rv-target" data-testid="review-target">{targetWords(q.target)}</span>}
        <span className="grow" />
        <span className={`state-chip rv-status`} data-tone={statusTone} data-testid="review-status">{statusWord}</span>
      </div>
      {!data.current && <p className="rv-warn small" data-testid="review-stale">{data.item} has changed again since; the after below is what this work left.</p>}
      {!stillThere && <p className="rv-warn small">{data.item} is not in the project any more.</p>}

      {!song && A && B && (
        <div className="rv-waves">
          <ReviewWave letter="A" side={A} outline={outA} onset={onA} lead={lead} span={span} on={side === 'A'} playing={heard === 'A'} onPick={() => { setSide('A'); if (store.ab) store.switchAB(); }} tag={tagA} tagTone={failingNow(A).length ? 'fail' : 'pass'} agent={false} />
          <ReviewWave letter="B" side={B} outline={outB} onset={onB} lead={lead} span={span} on={side === 'B'} playing={heard === 'B'} onPick={() => { setSide('B'); if (store.ab) store.switchAB(); }} tag={tagB} tagTone={failingNow(B).length ? 'fail' : 'agent'} agent />
          <div className="rv-listen small">
            <Button onClick={() => void play()} testId="review-play">{playingAB ? 'Restart' : 'Play A/B'} {side}</Button>
            <span className="dim" data-testid="review-gain">Levels matched for listening (A {gainText(gains.a)}, B {gainText(gains.b)})</span>
            <span className="dim">Tab switches A {'↔'} B in time while playing</span>
            <span className="dim">Aligned on onset</span>
          </div>
        </div>
      )}
      {!song && !B && <p className="dim">{data.item} is new: there is nothing before it.</p>}

      {song && (
        <div className="rv-song" data-testid="review-song">
          <div className="rv-listen small">
            <Button onClick={() => { setSide('A'); void play('A'); }} testId="review-play-a" pressed={heard === 'A'}>Hear A {'·'} before</Button>
            <Button onClick={() => { setSide('B'); void play('B'); }} testId="review-play-b" pressed={heard === 'B'}>Hear B {'·'} after</Button>
            <span className="dim" data-testid="review-gain">Loop of the song, levels matched (A {gainText(songGain(store, songSides, 'a'))}, B {gainText(songGain(store, songSides, 'b'))})</span>
          </div>
          <div className="rv-card rv-notes">
            <span className="cap">Notes per pattern, before {'→'} after</span>
            {data.song!.notes.length === 0 && <span className="dim small">No notes differ.</span>}
            {data.song!.notes.map((n, i) => <div key={i} className="mono rv-noteline" data-testid="review-notes">{n}</div>)}
            {data.song!.settings.map((n, i) => <div key={`s${i}`} className="mono rv-noteline dim">{n}</div>)}
          </div>
        </div>
      )}

      <div className="rv-cols">
        <div className="rv-card" data-testid="review-params">
          <span className="cap">Parameters</span>
          {data.params.length === 0 && <span className="dim small">{song ? 'Settings did not change.' : 'No parameters differ.'}</span>}
          {data.params.map((p, i) => (
            <div key={i} className="rv-param" data-testid="review-param">
              <AuthorDot by={p.by.startsWith('human:') ? 'you' : 'agent'} />
              <span className="rv-param-name">{p.name}</span>
              {p.old && <span className="mono rv-old">{p.old}</span>}
              {p.old && p.new && <span className="dim" aria-hidden>{'→'}</span>}
              {p.new && <span className="mono rv-new">{p.new}</span>}
            </div>
          ))}
          {data.note && <p className="rv-note" data-testid="review-note"><AuthorMark by="agent" size={12} /> {'“'}{data.note}{'”'}</p>}
        </div>
        {!song && (
          <div className="rv-card" data-testid="review-numbers">
            <span className="cap">Numbers</span>
            {data.rows.map((r) => (
              <div key={r.k} className="rv-num" data-testid="review-number" data-glyph={r.glyph || undefined}>
                <span className="rv-num-k">{r.k}</span><span className="mono dim">{r.a}</span><span className="dim" aria-hidden>{'→'}</span><span className="mono">{r.b}</span>
                <span className={`mono rv-glyph g-${r.glyph || 'none'}`} aria-label={r.glyph === 'pass' ? 'passes' : r.glyph === 'fail' ? 'fails' : undefined}>{glyph(r.glyph)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {asking && (
        <div className="rv-ask" data-testid="review-ask">
          <label htmlFor="review-again" className="sr-only">What should change next</label>
          <textarea id="review-again" ref={area} rows={2} value={again} onChange={(e) => setAgain(e.target.value)} placeholder="What should change next? (the agent also gets this review)" data-testid="review-again-note"
            onKeyDown={(e) => { e.stopPropagation(); if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void askAgain(); } else if (e.key === 'Escape') { e.preventDefault(); setAsking(false); } }} />
          <Button kind="agent" disabled={!again.trim() || busy} onClick={() => void askAgain()} testId="review-again-send">Send <Kbd>{'⌘'}{'↵'}</Kbd></Button>
          <Button onClick={() => setAsking(false)}>Cancel <Kbd>Esc</Kbd></Button>
        </div>
      )}
      {problem && <p className="rv-warn small" role="alert" data-testid="review-problem">{problem}</p>}
      <div className="rv-actions">
        <span className="dim small rv-explain">Approve keeps B and closes the request. Ask again keeps B as a draft and sends a new note. Revert restores A; all three land on the history tape.</span>
        <Button onClick={() => void revert()} disabled={busy || !stillThere} testId="review-revert">Revert</Button>
        <Button kind="agent" onClick={() => setAsking(true)} disabled={busy || !stillThere} testId="review-ask-again" pressed={asking}><Spark size={11} />Ask again{'…'}</Button>
        <Button kind="primary" onClick={() => void approve()} disabled={busy || !stillThere} testId="review-approve">Approve <Kbd>{'⌘'}{'↵'}</Kbd></Button>
      </div>
    </section>
  );
}

/** The gain (dB) that levels a song's loop with the other side's, from the loudness of each rendered loop. */
function songGain(store: Store, s: { a: ReturnType<typeof songFromJson> | null; b: ReturnType<typeof songFromJson> | null } | null, which: 'a' | 'b'): number {
  if (!s?.a || !s.b) return 0;
  const m = (song: NonNullable<typeof s.a>): { lufs: number | null; truePeakDb: number | null } => {
    const r = store.songRender(song, 'loop');
    const a = store.songLoudness(r.mix);
    return a;
  };
  const g = matchGains(m(s.a), m(s.b));
  return g ? g[which] : 0;
}

export type { Sound };
