// The session page: what the agent is working on now (the claimed request, its progress, its commands since the claim, a
// running batch), your requests in lanes from Sent to Ready for review, and the history tape.
// Pause and "stop after this" are not here: the request machinery has no such step (claim, progress, done, blocked,
// reply, cancel), and a button that did nothing would be a promise.

import { useState } from 'react';
import { targetWords, type WorkRequest } from '@soundclaw/core';
import { useNow } from '../Listening.tsx';
import type { Store } from '../store.ts';
import { AuthorMark } from './controls.tsx';
import { Spark } from './icons.tsx';
import { useBatch } from './live.tsx';
import { useSelection } from './NeedCard.tsx';
import { ago, doneAt, laneOf, type LaneId } from './shellData.ts';
import { Tape } from './Tape.tsx';
import { Spend } from './Spend.tsx';

const LANES: { id: LaneId; title: string; glyph: string; tone: 'quiet' | 'agent' | 'warn' | 'pass' }[] = [
  { id: 'sent', title: 'Sent', glyph: '→', tone: 'quiet' },
  { id: 'seen', title: 'Seen', glyph: '◦', tone: 'quiet' },
  { id: 'claimed', title: 'Claimed', glyph: '●', tone: 'agent' },
  { id: 'working', title: 'Working', glyph: '…', tone: 'agent' },
  { id: 'blocked', title: 'Blocked', glyph: '?', tone: 'warn' },
  { id: 'review', title: 'Ready for review', glyph: '✓', tone: 'pass' },
];

function times(q: WorkRequest, lane: LaneId, now: number): string {
  const claim = q.events.find((e) => e.type === 'claim');
  switch (lane) {
    case 'sent': return `sent ${ago(q.at, now)}`;
    case 'seen': return `seen ${ago(q.seen[0]?.at, now)} by ${(q.seen[0]?.by ?? '').replace(/^agent:/, '')} · sent ${ago(q.at, now)}`;
    case 'claimed': case 'working': return `claimed ${ago(claim?.at, now)} by ${(q.claimedBy ?? '').replace(/^agent:/, '')}`;
    case 'blocked': return `asked ${ago([...q.events].reverse().find((e) => e.type === 'blocked')?.at, now)}`;
    case 'review': return `ready ${ago(doneAt(q), now)}`;
    default: return q.reviewed ? `${q.reviewed.how} ${ago(q.reviewed.at, now)}` : `${q.state} ${ago(q.events.at(-1)?.at ?? q.at, now)}`;
  }
}

function LaneCard({ store, q, lane, now, onOpen }: { store: Store; q: WorkRequest; lane: LaneId; now: number; onOpen(id: string): void }) {
  const [text, setText] = useState('');
  const kindWord = q.kind === 'comparison' ? 'A/B answer' : q.kind === 'feedback' ? 'feedback' : null;
  return (
    <div className="lane-card" data-testid={`lane-card-${q.id}`} data-lane={lane} data-state={q.state}>
      <span className="lane-note">{'“'}{q.note}{'”'}</span>
      <span className="lane-meta mono">
        <b>{q.id}</b> {'·'} <button type="button" className="link-btn" data-testid={`lane-open-${q.id}`} onClick={() => onOpen(q.sound)}>{q.sound}</button>
        {kindWord ? ` · ${kindWord}` : ''}
      </span>
      {q.target && <span className="lane-target mono" data-testid={`lane-target-${q.id}`}>{targetWords(q.target)}</span>}
      <span className="lane-meta mono">{times(q, lane, now)}</span>
      {lane === 'working' && q.latest && <span className="lane-progress" data-testid={`lane-progress-${q.id}`}>{q.latest}</span>}
      {lane === 'blocked' && (
        <div className="lane-blocked">
          <span className="lane-question" data-testid={`lane-question-${q.id}`}>The agent asks: {'“'}{q.question}{'”'}</span>
          <div className="lane-reply">
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="your answer" aria-label={`Answer ${q.id}`} data-testid={`reply-text-${q.id}`}
              onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { e.preventDefault(); void store.request({ action: 'reply', id: q.id, text }).then((r) => { if (r.ok) setText(''); }); } }} />
            <button type="button" className="btn" disabled={!text.trim()} data-testid={`reply-send-${q.id}`} onClick={() => void store.request({ action: 'reply', id: q.id, text }).then((r) => { if (r.ok) setText(''); })}>Answer</button>
          </div>
        </div>
      )}
      {lane === 'review' && (
        <div className="lane-actions">
          {q.latest && <span className="lane-progress">{q.latest}</span>}
          {q.sound.startsWith('sample:')
            ? <a className="btn btn-primary" href={`#/sample/${q.sound.slice(7)}`} data-testid={`lane-review-${q.id}`}>Open sample</a>
            : <a className="btn btn-primary" href={`#/review/${q.id}`} data-testid={`lane-review-${q.id}`}>Review</a>}
        </div>
      )}
      {(lane === 'sent' || lane === 'seen' || lane === 'claimed' || lane === 'working' || lane === 'blocked') && (
        <button type="button" className="link-btn lane-withdraw" data-testid={`cancel-${q.id}`} onClick={() => void store.request({ action: 'cancel', id: q.id })}>withdraw</button>
      )}
    </div>
  );
}

function WorkingNow({ store, now }: { store: Store; now: number }) {
  const q = store.requests.filter((x) => x.state === 'claimed').at(-1);
  const b = useBatch(store);
  if (!q && !b) {
    return (
      <section className="card working idle" data-testid="session-working" data-idle>
        <div className="working-head"><Spark size={18} /><span className="cap">Working on now</span></div>
        <p className="dim">The agent has not claimed a request. Requests wait in the lanes below until one does.</p>
      </section>
    );
  }
  const claim = q?.events.find((e) => e.type === 'claim');
  const cmds = q ? store.tape.filter((e) => e.by === q.claimedBy && (e.at ?? '') >= (claim?.at ?? '')).slice(-4).reverse() : [];
  return (
    <section className="card working" data-testid="session-working" data-request={q?.id}>
      <div className="working-head">
        <Spark size={18} /><span className="cap agent-cap">Working on now</span>
        {q && <span className="mono dim small" data-testid="working-meta">request {q.id} {'·'} claimed {ago(claim?.at, now)} by {(q.claimedBy ?? '').replace(/^agent:/, '')}</span>}
      </div>
      {q && <div className="working-note" data-testid="working-note">{'“'}{q.note}{'”'}</div>}
      {q?.target && <div className="mono working-target" data-testid="working-target">{targetWords(q.target)} {'·'} {q.sound}</div>}
      {q?.latest && <div className="working-progress" data-testid="working-progress"><span className="cap">Latest</span> {q.latest}</div>}
      {q && (
        <ol className="working-cmds" data-testid="working-cmds" aria-label="Commands since the claim">
          {cmds.length === 0 && <li className="dim small">No commands since the claim yet.</li>}
          {cmds.map((e) => <li key={e.seq} className="mono" data-testid="working-cmd"><span className="dim">$</span> {e.cmd}<span className="dim"> {'·'} #{e.seq}</span></li>)}
        </ol>
      )}
      {b && <BatchCells store={store} />}
    </section>
  );
}

/** The batch as a row of cells: the ones done are filled, the next is drawn dashed, the rest wait. */
export function BatchCells({ store }: { store: Store }) {
  const v = useBatch(store);
  if (!v) return null;
  const { batch: b, running } = v;
  return (
    <div className="batch-big" data-testid="session-batch" data-done={b.done} data-total={b.total} data-state={b.state}>
      <div className="batch-big-head mono"><span className="dim">$</span> <span data-testid="session-batch-label">{b.label || 'starting…'}</span><span className="grow" /><span className="dim" data-testid="session-batch-count">{running ? `${b.done} / ${b.total}` : b.state === 'failed' ? 'refused' : `${b.total} / ${b.total}`}</span></div>
      <div className="batch-big-cells">
        {Array.from({ length: Math.min(b.total, 48) }, (_, i) => {
          const state = i < b.done ? 'ready' : i === b.done && running ? 'rendering' : 'queued';
          const label = store.batchLabels[i] ?? '';
          return (
            <div key={i} className="batch-big-cell" data-state={state} data-testid={`session-batch-cell-${i + 1}`} title={label}>
              <span className="mono">{state === 'ready' ? '✓' : state === 'rendering' ? '…' : '·'} {i + 1}</span>
              <span className="batch-big-name">{label.split(/\s+/).at(-1) ?? ''}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Session({ store, onOpen }: { store: Store; onOpen(id: string): void }) {
  const now = useNow(10_000);
  const sel = useSelection();
  const [closedOpen, setClosedOpen] = useState(false);
  const by = new Map<LaneId, WorkRequest[]>();
  for (const q of store.requests) {
    const l = laneOf(store, q);
    by.set(l, [...(by.get(l) ?? []), q]);
  }
  const closed = (by.get('closed') ?? []).slice(-20).reverse();
  const focusId = sel.selected && (sel.selected.kind === 'sound' || sel.selected.kind === 'song') ? sel.selected.id : null;
  const held = [...store.held.entries()];
  return (
    <div className="session" data-testid="session">
      <div className="session-head"><h1>Session</h1><p className="dim">What the agent is doing now, and where each of your requests stands.</p></div>
      <div className="session-top">
        <WorkingNow store={store} now={now} />
      </div>
      <section className="card lanes-card" aria-label="Requests">
        <div className="working-head"><span className="cap">Requests</span><span className="dim small">yours, and where each one stands</span></div>
        <div className="lanes" data-testid="lanes">
          {LANES.map((l) => {
            const qs = (by.get(l.id) ?? []).slice().reverse();
            return (
              <section key={l.id} className="lane" aria-label={l.title} data-testid={`lane-${l.id}`} data-count={qs.length}>
                <h2 className={`lane-title tone-${l.tone}`}><span className="mono" aria-hidden>{l.glyph}</span> {l.title} <span className="mono dim lane-count" data-testid={`lane-count-${l.id}`}>{qs.length}</span></h2>
                {qs.length === 0 && <p className="dim small lane-empty">Nothing here.</p>}
                {qs.map((q) => <LaneCard key={q.id} store={store} q={q} lane={l.id} now={now} onOpen={onOpen} />)}
              </section>
            );
          })}
        </div>
        <details className="closed-lane" open={closedOpen} onToggle={(e) => setClosedOpen((e.currentTarget as HTMLDetailsElement).open)} data-testid="lane-closed">
          <summary><span className="cap">Closed</span> <span className="mono dim" data-testid="lane-count-closed">{(by.get('closed') ?? []).length}</span> <span className="dim small">the last 20</span></summary>
          <div className="closed-cards">{closed.map((q) => <LaneCard key={q.id} store={store} q={q} lane="closed" now={now} onOpen={onOpen} />)}</div>
        </details>
      </section>
      <Spend store={store} now={now} />
      <section className="card live-rules" aria-label="While you edit">
          <div className="working-head"><span className="cap">While you edit</span><span className="grow" /><span className="dim small">nothing moves under your cursor</span></div>
          {held.length === 0
            ? <p className="dim small">When the agent changes the sound you are editing, your version stays and an {'“'}agent update waiting{'”'} chip appears. Library rows the agent changes pulse once and keep a violet dot until you play them.</p>
            : held.map(([id, h]) => (
              <a key={id} className="update-chip" href={`#/review/${h.request ?? h.group}`} data-testid={`held-${id}`}><Spark size={10} />{id}: agent update waiting {'·'} review</a>
            ))}
      </section>
      <section className="card tape-card" aria-label="History tape">
        <div className="working-head"><span className="cap">History tape</span><span className="dim small">every command, by author {'·'} batches undo as one {'·'} click to hear the item at that point</span></div>
        <Tape store={store} preview={focusId} />
      </section>
      <p className="dim small session-marks"><AuthorMark by="agent" size={12} /> agent marks are round and violet {'·'} <AuthorMark by="you" size={12} /> yours are square and teal</p>
    </div>
  );
}
