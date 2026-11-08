// The blind A/B card: two versions of a sound (or two sounds) at matched loudness, named A and B at
// random, judged against the moment the sound is for. The answer is written as a comparison request
// the agent reads through await; then the names are shown, the session tally grows and the next
// pair loads after two seconds (→ loads it now). A pair that sounds the same once its levels are
// matched is skipped, and the card says so.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ANSWER_WORDS, momentProblem, type ComparisonAnswer, type Sound } from '@soundclaw/core';
import { Button } from '../studio/controls.tsx';
import type { Store } from '../store.ts';
import { gainText, matchGains, pairKey, playPlan } from './abmath.ts';
import { PeaksPath } from './ClipGrid.tsx';

/** One side of a pair before it is hidden: a version of a sound, and the name the reveal gives it. */
export interface PairSide { id: string; seq: number; doc: Sound; name: string }
export type Pair = [PairSide, PairSide];

const ANSWERS: { k: string; answer: ComparisonAnswer }[] = [{ k: 'A', answer: 'a' }, { k: 'B', answer: 'b' }, { k: '=', answer: 'both' }, { k: 'N', answer: 'neither' }];
const NEXT_MS = 2000;

export interface BlindAB {
  /** The pair on the card, A and B as assigned, with the reference side (whose moment it is judged in) first in `ref`. */
  pair: { a: PairSide; b: PairSide; ref: PairSide; key: string } | null;
  gains: { a: number; b: number } | null;
  /** Measuring the two sides, or checking whether they are the same. */
  busy: boolean;
  answered: ComparisonAnswer | null;
  error: string | null;
  /** The pairs skipped because they sounded the same once matched (names, for the note). */
  skipped: string | null;
  /** Pair n of m in this page's queue. */
  index: number;
  total: number;
  /** Put a pair on the card now (dragged, picked with C, or "compare with current"). */
  put(p: Pair): void;
  answer(a: ComparisonAnswer): Promise<void>;
  next(): void;
  play(side: 'A' | 'B'): void;
  playBoth(): void;
}

/**
 * The card's state: a queue of pairs (the page's, after any the person put there), the random assignment of A and B, the gains
 * from the measured loudness, the identical-pair skip and the answer. `moment` is the reference side's moment.
 */
export function useBlindAB(store: Store, queue: Pair[], moment: () => string | null): BlindAB {
  const [manual, setManual] = useState<Pair[]>([]);
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const [answered, setAnswered] = useState<ComparisonAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string | null>(null);
  const [same, setSame] = useState<Map<string, boolean>>(() => new Map());
  const flips = useRef(new Map<string, boolean>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const all = [...manual, ...queue];
  const seen = new Set<string>();
  const pending: Pair[] = [];
  for (const p of all) {
    const k = pairKey(p[0], p[1]);
    if (seen.has(k) || done.has(k)) continue;
    seen.add(k);
    pending.push(p);
  }
  const head = pending[0] ?? null;
  const key = head ? pairKey(head[0], head[1]) : null;
  if (key && !flips.current.has(key)) flips.current.set(key, Math.random() < 0.5);
  const flip = key ? flips.current.get(key)! : false;
  const pair = head && key ? { a: flip ? head[1] : head[0], b: flip ? head[0] : head[1], ref: head[0], key } : null;
  const ca = pair ? store.cell(pair.a.doc) : null;
  const cb = pair ? store.cell(pair.b.doc) : null;
  const gains = ca && cb ? matchGains(ca, cb) ?? { a: 0, b: 0 } : null;
  const isSame = key ? same.get(key) : undefined;

  // is the pair the same once matched? Then it is skipped
  useEffect(() => {
    if (!pair || same.has(pair.key)) return;
    let live = true;
    const k = pair.key;
    const names = `${pair.ref.name} and ${(pair.ref === pair.a ? pair.b : pair.a).name}`;
    void store.identical(pair.a.doc, pair.b.doc).then((s) => {
      if (!live) return;
      setSame((m) => new Map(m).set(k, s));
      if (s) { setSkipped(`${names} sound the same once their levels are matched, so that pair was skipped.`); setDone((d) => new Set(d).add(k)); }
    }).catch(() => { if (live) setSame((m) => new Map(m).set(k, false)); });
    return () => { live = false; };
  }, [pair?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const next = (): void => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (!pair || !answered) return;
    const k = pair.key;
    setDone((d) => new Set(d).add(k));
    setManual((m) => m.filter((p) => pairKey(p[0], p[1]) !== k));
    setAnswered(null);
    setError(null);
  };
  const nextRef = useRef(next);
  nextRef.current = next;

  const sideOf = (s: PairSide, g: number) => ({ id: s.id, seq: s.seq, doc: s.doc, gain: g });
  const playPair = (side: 'A' | 'B', times: number, interval: number): void => {
    if (!pair || !gains) return;
    if (store.ab && store.ab.side === side) { store.stop(); return; }
    void store.playAB(sideOf(pair.a, gains.a), sideOf(pair.b, gains.b), side, times, interval);
  };
  const plan = playPlan(moment());

  return {
    pair, gains, answered, error, skipped,
    busy: !!pair && (!gains || isSame === undefined),
    index: done.size + 1,
    total: done.size + pending.length,
    put(p) {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      const k = pairKey(p[0], p[1]);
      if (p[0].id === p[1].id && p[0].seq === p[1].seq) return;
      setDone((d) => { if (!d.has(k)) return d; const n = new Set(d); n.delete(k); return n; });
      setManual((m) => [p, ...m.filter((x) => pairKey(x[0], x[1]) !== k)]);
      setAnswered(null);
      setError(null);
      setSkipped(null);
    },
    async answer(ans) {
      if (!pair || !gains || answered || isSame !== false) return;
      setAnswered(ans);
      const m = moment();
      const r = await store.compare({ a: { sound: pair.a.id, seq: pair.a.seq }, b: { sound: pair.b.id, seq: pair.b.seq }, answer: ans, ...(m ? { moment: m } : {}), gains });
      if (!r.ok) { setAnswered(null); setError(r.error ?? 'the answer was refused'); return; }
      store.countAnswer(ans);
      timer.current = setTimeout(() => nextRef.current(), NEXT_MS);
    },
    next,
    play: (side) => playPair(side, plan.times, plan.interval),
    playBoth() {
      if (!pair || !gains) return;
      const a = sideOf(pair.a, gains.a), b = sideOf(pair.b, gains.b);
      void (async () => {
        await store.playAB(a, b, 'A', 1, 0);
        await store.idle();
        if (store.ab) return;
        await new Promise((r) => setTimeout(r, plan.gap * 1000));
        await store.playAB(a, b, 'B', 1, 0);
      })();
    },
  };
}

/** The moment as the card shows it, or a field that writes it. */
function MomentBox({ moment, onWrite, where }: { moment: { text: string; set: string | null } | null; onWrite?(text: string): Promise<string | null>; where: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    const t = text.trim();
    const p = t ? momentProblem(t) : 'say what happens in the game when the sound plays';
    if (p) { setProblem(p); return; }
    const err = await onWrite!(t);
    if (err) setProblem(err); else { setEditing(false); setProblem(null); }
  };
  if (moment && !editing) {
    return (
      <div className="ab-moment" data-testid="ab-moment">
        <span className="cap ab-moment-cap">The moment{moment.set ? <span className="ab-moment-of"> · of set {moment.set}</span> : null}</span>
        <span className="ab-moment-text" data-testid="ab-moment-text">{moment.text}</span>
        {onWrite && <button type="button" className="link-btn ab-moment-edit" data-testid="ab-moment-edit" onClick={() => { setText(moment.text); setEditing(true); }}>Edit</button>}
      </div>
    );
  }
  if (!onWrite) return <div className="ab-moment" data-empty data-testid="ab-moment"><span className="cap ab-moment-cap">The moment</span><span className="dim">No moment yet: judge it as you hear it.</span></div>;
  return (
    <form className="ab-moment" data-empty={!moment || undefined} data-testid="ab-moment" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label className="cap ab-moment-cap" htmlFor="ab-moment-field">The moment</label>
      {!moment && <span className="dim small">Say what happens in the game when {where} plays: the comparison is judged against it, and the agent reads it too.</span>}
      <textarea id="ab-moment-field" rows={2} value={text} maxLength={400} data-testid="ab-moment-field" placeholder="The player walks slowly across a meadow at night. Steps repeat every 0.4 s."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void save(); } if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); } }} />
      <span className="ab-moment-row">
        <Button kind="primary" type="submit" testId="ab-moment-save" disabled={!text.trim()}>Set the moment</Button>
        {moment && <Button kind="quiet" onClick={() => setEditing(false)}>Cancel</Button>}
        {problem && <span className="error small" data-testid="ab-moment-problem">{problem}</span>}
      </span>
    </form>
  );
}

function SideWave({ store, doc }: { store: Store; doc: Sound }) {
  const c = store.cell(doc);
  return <PeaksPath peaks={c?.peaks} w={160} h={40} className="ab-wave" />;
}

export function ABCard({ store, ab, moment, onWriteMoment, where, empty }: { store: Store; ab: BlindAB; moment: { text: string; set: string | null } | null; onWriteMoment?(text: string): Promise<string | null>; where: string; empty: ReactNode }) {
  const { pair, gains } = ab;
  const plan = playPlan(moment?.text);
  const heard = store.ab && pair && store.ab.a.seq === pair.a.seq && store.ab.a.id === pair.a.id && store.ab.b.id === pair.b.id && store.ab.b.seq === pair.b.seq ? store.ab.side : null;
  const sides = pair ? ([['A', pair.a, gains?.a], ['B', pair.b, gains?.b]] as const) : [];
  return (
    <section className="ab-card" data-ab-drop aria-label="Blind A/B" data-testid="ab-card" data-pair={pair?.key} data-answered={ab.answered ?? undefined} data-busy={ab.busy || undefined}>
      <div className="ab-head">
        <span className="cap">Blind A/B</span>
        {pair && <span className="mono ab-count" data-testid="ab-count">pair {ab.index} of {ab.total}</span>}
        <span className="spacer" />
        {pair && (gains && !ab.busy ? <span className="ab-matched" data-testid="ab-matched"><span className="mono" aria-hidden>✓</span>levels matched</span> : <span className="dim small">matching levels…</span>)}
      </div>
      {ab.skipped && <div className="ab-skipped small" role="status" data-testid="ab-skipped">{ab.skipped}</div>}
      {!pair ? <div className="ab-empty dim" data-testid="ab-empty">{empty}</div> : (
        <>
          <MomentBox moment={moment} where={where} {...(onWriteMoment ? { onWrite: onWriteMoment } : {})} />
          <div className="ab-question">Which one fits better in this moment?</div>
          <div className="ab-sides">
            {sides.map(([l, s, g]) => (
              <div key={l} className="ab-side" data-heard={heard === l || undefined} data-testid={`ab-side-${l}`}>
                <div className="ab-side-head">
                  <span className="ab-letter" aria-hidden>{l}</span>
                  <Button testId={`ab-play-${l}`} disabled={!gains || ab.busy} pressed={heard === l} onClick={() => ab.play(l)}
                    icon={<svg width="9" height="9" viewBox="0 0 12 12" aria-hidden><path d={heard === l ? 'M2 1 H5 V11 H2 Z M7 1 H10 V11 H7 Z' : 'M2 1 L11 6 L2 11 Z'} fill="currentColor" /></svg>}>
                    {heard === l ? 'Stop' : plan.times > 1 ? `Play ×${plan.times}` : 'Play'}<span className="visually-hidden"> {l}</span>
                  </Button>
                </div>
                <SideWave store={store} doc={s.doc} />
                <span className="mono ab-gain" data-testid={`ab-gain-${l}`}>gain applied {g === undefined ? '…' : gainText(g)}</span>
                <span className="ab-name small" data-testid={`ab-name-${l}`} data-revealed={!!ab.answered || undefined}>{ab.answered ? <span className="mono">{s.name}</span> : 'name hidden until you answer'}</span>
              </div>
            ))}
          </div>
          <div className="ab-hints small">
            <span><span className="kbd">Tab</span> switches A ↔ B in time while playing</span>
            <span>{plan.times > 1 ? `Each plays ${plan.times} times, ${plan.interval} s apart, as the moment says` : 'Each plays once'}</span>
            <button type="button" className="link-btn" data-testid="ab-play-both" disabled={!gains || ab.busy} onClick={ab.playBoth}>Play A then B</button>
          </div>
          <div className="ab-answers" role="group" aria-label="Your answer">
            {ANSWERS.map(({ k, answer }) => (
              <button key={answer} type="button" className="ab-answer" aria-pressed={ab.answered === answer} disabled={!!ab.answered || ab.busy || !gains} data-testid={`ab-answer-${answer}`} onClick={() => void ab.answer(answer)}>
                <span className="kbd">{k}</span><span>{ANSWER_WORDS[answer]}</span>
              </button>
            ))}
          </div>
          {ab.error && <div className="error small" role="alert">{ab.error}</div>}
          {ab.answered && (
            <div className="ab-recorded small" role="status" data-testid="ab-recorded">
              <span>Recorded: <b>{ANSWER_WORDS[ab.answered]}</b></span>
              <span className="text2">A was <span className="mono">{pair.a.name}</span>, B was <span className="mono">{pair.b.name}</span>.</span>
              <span className="dim">Sent to the agent as a judgment{moment ? ' with the moment attached' : ''}. Next pair in 2 s, or press <span className="kbd">→</span> now.</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function TallyCard({ store }: { store: Store }) {
  const t = store.tally;
  const total = t.a + t.b + t.both + t.neither;
  return (
    <section className="ab-tally" aria-label="This session" data-testid="ab-tally">
      <span className="cap">This session</span>
      {(['a', 'b', 'both', 'neither'] as const).map((k) => (
        <div key={k} className="ab-tally-row" data-answer={k}>
          <span className="ab-tally-word">{ANSWER_WORDS[k]}</span>
          <div className="ab-tally-bar"><div style={{ width: `${total ? (t[k] / total) * 100 : 0}%` }} /></div>
          <span className="mono ab-tally-n" data-testid={`tally-${k}`}>{t[k]}</span>
        </div>
      ))}
    </section>
  );
}
