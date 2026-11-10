// The agent rail: who is listening, what the agent is working on, your requests with where each
// stands, the live feed of commands and request events (a play button where a sound changed),
// and the field that asks for changes on the selection.

import { useMemo, useState } from 'react';
import type { WorkRequest } from '@soundclaw/core';
import { RequestRow } from '../SoundCard.tsx';
import { useNow } from '../Listening.tsx';
import type { Store } from '../store.ts';
import { AuthorDot, AuthorMark, Kbd } from './controls.tsx';
import { Play, Spark } from './icons.tsx';
import { ago, buildFeed, requestState, type Focus } from './shellData.ts';
import { useNewSamples } from './sampleSeen.ts';

/** The agent's short name: `agent:claude` is `claude`. */
const shortName = (by: string): string => by.replace(/^agent:/, '');

/** The presence: who, the state, and what the agent is working on. */
export function presenceOf(store: Store): { state: 'off' | 'listening' | 'working'; name: string; word: string; text: string } {
  const p = store.presence;
  const claimed = store.requests.find((q) => q.state === 'claimed');
  if (claimed) return { state: 'working', name: shortName(claimed.claimedBy ?? 'agent'), word: 'working', text: claimed.latest ?? claimed.note };
  if (p?.listening) return { state: 'listening', name: shortName(p.waiters[0]?.by ?? p.agents[0]?.by ?? 'agent'), word: 'listening', text: '' };
  return { state: 'off', name: '', word: 'not listening', text: '' };
}

export function PresencePill({ store }: { store: Store }) {
  const p = store.presence;
  if (!p) return null;
  // offline: the server is gone, so nobody can be listening or working as far as this page knows
  if (store.status === 'closed') {
    return (
      <span className="presence presence-offline" data-testid="listener-chip" data-listening="false" data-state="offline" title="The SoundClaw server is not reachable: the agent cannot see this page until it comes back">
        <span className="presence-dot" aria-hidden /><span className="presence-word">offline</span>
      </span>
    );
  }
  const pr = presenceOf(store);
  // the pill shows short state words; the full sentence is the tooltip
  const full = pr.state === 'off' ? 'No agent is listening: requests you file now wait until an agent is started on this project'
    : pr.state === 'listening' ? `${pr.name} is listening: an agent is waiting for requests or took a request recently`
      : `${pr.name} is working${pr.text ? `: ${pr.text}` : ''}`;
  return (
    <span className={`presence presence-${pr.state}`} data-testid="listener-chip" data-listening={p.listening} data-state={pr.state} title={full}>
      {pr.state === 'off' ? <span className="presence-dot" aria-hidden /> : <AuthorMark by="agent" size={14} />}
      {pr.state === 'off' ? <span className="presence-word">{pr.word}</span> : <><b className="presence-name">{pr.name}</b><span className="presence-word">{pr.word}</span></>}
      {pr.text && <span className="presence-text">{pr.text}</span>}
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
  const freshSamples = useNewSamples(store);
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
              <li key={f.key} className="feed-item" data-testid="feed-item" data-by={who} data-sample={f.sample} data-new={f.sample && freshSamples.has(f.sample) ? 'true' : undefined}>
                <AuthorDot by={who} />
                <div className="feed-body"><span className="feed-text">{f.sample ? <a href={`#/sample/${f.sample}`} className="feed-sample" data-testid={`feed-sample-${f.sample}`}>{f.text}</a> : f.instrument ? <a href={`#/instrument/${f.instrument}`} className="feed-sample" data-testid={`feed-instrument-${f.instrument}`}>{f.text}</a> : f.text}</span><span className="mono feed-meta">{f.meta}</span></div>
                {f.sound && <button type="button" className="feed-play" aria-label={`Play ${f.sound}`} title={`Play ${f.sound}`} onClick={() => onPlay(f.sound!)}><Play size={8} /></button>}
                {f.sample && store.samples.some((x) => x.name === f.sample) && <button type="button" className="feed-play" data-testid={`feed-play-${f.sample}`} aria-label={`Play sample ${f.sample}`} title={`Play sample ${f.sample}`} onClick={() => void store.playSample(f.sample!)}><Play size={8} /></button>}
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
