// The agent rail: who is listening, what the agent is working on, your requests with where each
// stands, the live feed of commands and request events (a play button where a sound changed),
// and the field that asks for changes on the selection.

import { useMemo, useState } from 'react';
import type { WorkRequest } from '@soundclaw/core';
import { RequestRow } from '../SoundCard.tsx';
import { useNow } from '../Listening.tsx';
import type { Store } from '../store.ts';
import { AuthorDot, Kbd } from './controls.tsx';
import { Play, Spark } from './icons.tsx';
import { ago, buildFeed, requestState, type Focus } from './shellData.ts';

/** The presence in one line: listening, working (with what on), or nobody. */
export function presenceOf(store: Store): { state: 'off' | 'listening' | 'working'; text: string } {
  const p = store.presence;
  const claimed = store.requests.find((q) => q.state === 'claimed');
  if (claimed) return { state: 'working', text: `${claimed.claimedBy ?? 'agent'} · ${claimed.latest ?? claimed.note}`.slice(0, 60) };
  if (p?.listening) return { state: 'listening', text: `${p.waiters[0]?.by ?? p.agents[0]?.by ?? 'agent'} is listening` };
  return { state: 'off', text: 'no agent is listening' };
}

export function PresencePill({ store }: { store: Store }) {
  const p = store.presence;
  if (!p) return null;
  const pr = presenceOf(store);
  return (
    <span className={`presence presence-${pr.state}`} data-testid="listener-chip" data-listening={p.listening} data-state={pr.state}
      title={p.listening ? 'An agent is waiting for requests or took a request recently' : 'Requests you file now wait until an agent is started on this project'}>
      {pr.state === 'working' ? <Spark size={12} /> : <span className="presence-dot" aria-hidden />}
      {pr.state === 'working' ? `agent · ${pr.text}` : pr.state === 'listening' ? `${pr.text}` : pr.text}
    </span>
  );
}

function WorkingOn({ store, now }: { store: Store; now: number }) {
  const q = store.requests.find((x) => x.state === 'claimed');
  if (!q) return null;
  const claim = q.events.find((e) => e.type === 'claim');
  const since = claim ? Date.parse(claim.at) : 0;
  const cmds = store.tape.filter((e) => !e.by.startsWith('human:') && (e.at ? Date.parse(e.at) >= since : false)).slice(-3).reverse();
  return (
    <div className="working-on" data-testid="working-on">
      <span className="cap agent-cap">Working on</span>
      <span className="wo-note">{'“'}{q.note}{'”'}</span>
      <span className="mono wo-meta">{q.claimedBy ?? 'agent'} claimed {ago(claim?.at, now)} {'·'} {q.sound}</span>
      {q.latest && <span className="wo-latest" data-testid="wo-latest">{q.latest}</span>}
      {cmds.map((e) => <span key={e.seq} className="mono wo-cmd">{e.cmd}</span>)}
    </div>
  );
}

export function Rail({ store, onPlay, onOpen, ask, focus }: { store: Store; onPlay(id: string): void; onOpen(id: string): void; ask(text: string): Promise<boolean>; focus: Focus | null }) {
  const now = useNow(10_000);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const feed = useMemo(() => buildFeed(store), [store.tape, store.requests, now]);
  const mine = store.requests.filter((q) => q.by.startsWith('human:')).slice(-8).reverse();
  const open = store.requests.filter((q) => ['open', 'claimed', 'blocked'].includes(q.state));
  const pr = presenceOf(store);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    if (await ask(text.trim())) setText('');
    setBusy(false);
  };
  return (
    <div className="rail-in" data-testid="rail">
      <div className="rail-head">
        <div className="rail-title"><Spark size={16} /><b>Agent</b>
          <span className={`rail-status s-${pr.state}`}><span className="presence-dot" aria-hidden />{pr.state === 'off' ? 'not listening' : pr.state === 'listening' ? 'connected · listening' : 'working'}</span>
          <span className="grow" /><Kbd>{'⌥'}3</Kbd>
        </div>
        <WorkingOn store={store} now={now} />
      </div>
      <div className="rail-sec">
        <span className="cap">Your requests</span>
        <span className="dim req-count" data-testid="requests-count">{open.length} request{open.length === 1 ? '' : 's'} for the agent</span>
        {mine.length === 0 && <span className="dim small">Ask for changes with R, or type below.</span>}
        {mine.map((q) => <RequestLine key={q.id} store={store} q={q} onOpen={onOpen} />)}
      </div>
      <div className="rail-feed" data-testid="feed">
        <span className="cap">Live</span>
        {feed.length === 0 && <span className="dim small">Commands and requests appear here as they happen.</span>}
        <ul>
          {feed.map((f) => {
            const who = f.by.startsWith('human:') ? 'you' : 'agent';
            return (
              <li key={f.key} className="feed-item" data-testid="feed-item" data-by={who}>
                <AuthorDot by={who} />
                <div className="feed-body"><span className="feed-text">{f.text}</span><span className="mono feed-meta">{f.meta}</span></div>
                {f.sound && <button type="button" className="feed-play" aria-label={`Play ${f.sound}`} title={`Play ${f.sound}`} onClick={() => onPlay(f.sound!)}><Play size={8} /></button>}
              </li>
            );
          })}
        </ul>
      </div>
      <form className="rail-ask" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input id="rail-ask" value={text} onChange={(e) => setText(e.target.value)} placeholder={focus ? `Ask for changes on ${focus.id}…` : 'Select a sound, then ask for changes…'} aria-label="Ask for changes on the selection" data-testid="ask-input" disabled={!focus || focus.kind === 'set'} />
        <Kbd>R</Kbd>
      </form>
    </div>
  );
}

function RequestLine({ store, q, onOpen }: { store: Store; q: WorkRequest; onOpen(id: string): void }) {
  const st = requestState(q);
  if (q.state === 'blocked') return <RequestRow store={store} q={q} />;
  return (
    <button type="button" className="req-line" data-testid={`rail-request-${q.id}`} data-state={q.state} onClick={() => onOpen(q.sound)} title={`${q.sound}: ${q.note}`}>
      <AuthorDot by="you" />
      <span className="req-text">{q.note || q.sound}</span>
      <span className="state-chip" data-tone={st.tone}>{st.word}</span>
    </button>
  );
}
