// One sound as a card: name and status, a waveform thumbnail, a play button, its numbers, and the
// person's two answers: Approve, or Ask for changes (a note the agent receives through await).
// The requests on the sound show where they stand: sent, seen by an agent, claimed, blocked
// (answer it here), done.

import { useState } from 'react';
import type { Sound, WorkRequest } from '@soundclaw/core';
import { NoListener, unattended, useNow } from './Listening.tsx';
import type { Store } from './store.ts';
import { Waveform } from './Waveform.tsx';

const fmt = (n: number) => String(n);

function RequestRow({ store, q }: { store: Store; q: WorkRequest }) {
  const [text, setText] = useState('');
  const now = useNow();
  const seen = q.seen ?? [];
  const label = q.state === 'open' ? (seen.length ? `seen by ${seen.map((x) => x.by).join(', ')}` : 'sent') : q.state === 'claimed' ? `${q.claimedBy} is working on it` : q.state;
  return (
    <div className="request" data-testid={`request-${q.id}`} data-state={q.state}>
      <div>
        <b>{q.id}</b> <span className={`chip state-${q.state}`}>{label}</span> <span className="dim">“{q.note}”</span>
        {(q.state === 'open' || q.state === 'claimed' || q.state === 'blocked') && (
          <button className="link" data-testid={`cancel-${q.id}`} onClick={() => void store.request({ action: 'cancel', id: q.id })}>withdraw</button>
        )}
      </div>
      {q.state === 'claimed' && q.latest && <div className="dim" data-testid="working">{q.latest}</div>}
      {q.state === 'done' && <div className="dim" data-testid={`done-${q.id}`}>✓ done: {q.latest}</div>}
      {q.state === 'blocked' && (
        <div className="blocked">
          <div data-testid={`question-${q.id}`}>The agent asks: “{q.question}”</div>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="your answer" data-testid={`reply-text-${q.id}`} />
          <button disabled={!text.trim()} data-testid={`reply-send-${q.id}`} onClick={() => void store.request({ action: 'reply', id: q.id, text }).then((r) => { if (r.ok) setText(''); })}>Answer</button>
        </div>
      )}
      {unattended(store, q, now) && <NoListener store={store} why={store.presence?.listening ? 'Nobody has picked this up yet.' : 'No agent is listening for requests.'} />}
    </div>
  );
}

export function SoundCard({ store, sound }: { store: Store; sound: Sound }) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const samples = store.render(sound);
  const playing = store.playing === sound.id;
  const plays = store.played.filter((p) => p.id === sound.id).length;
  const mine = store.requests.filter((q) => q.sound === sound.id);
  const send = async () => {
    const r = await store.askForChanges(sound.id, note);
    if (r.ok) { setAsking(false); setNote(''); setProblem(null); } else setProblem(r.error ?? 'refused');
  };
  return (
    <article className="card" data-testid={`card-${sound.id}`} data-status={sound.status} data-hash={store.hashOf(sound)}>
      <header>
        <h2>{sound.id}</h2>
        <span className={`chip status-${sound.status}`} data-testid={`status-${sound.id}`}>{sound.status}</span>
      </header>
      <Waveform samples={samples} id={sound.id} />
      <div className="params" data-testid={`params-${sound.id}`}>
        <span>{fmt(sound.frequency)} Hz</span><span>{fmt(sound.duration)} s</span><span>volume {fmt(sound.volume)}</span>
      </div>
      <div className="dim hash" title="Hash of the rendered samples; the CLI and MCP print the same first 12 digits">samples {store.hashOf(sound).slice(0, 12)}</div>
      <div className="card-actions">
        <button className="play" data-testid={`play-${sound.id}`} data-plays={plays} data-playing={playing} onClick={() => void store.play(sound.id)} aria-label={`${playing ? 'Stop' : 'Play'} ${sound.id}`}>
          {playing ? '■ Stop' : '▶ Play'}
        </button>
        <button data-testid={`approve-${sound.id}`} disabled={sound.status === 'approved'} onClick={() => void store.approve(sound.id)}>Approve</button>
        <button data-testid={`reject-${sound.id}`} onClick={() => setAsking(!asking)}>Ask for changes</button>
      </div>
      {asking && (
        <div className="ask">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change? (e.g. softer, a little lower)" data-testid={`reject-text-${sound.id}`} rows={2} />
          <button disabled={!note.trim()} data-testid={`reject-send-${sound.id}`} onClick={() => void send()}>Send</button>
          {problem && <div className="error" data-testid={`reject-error-${sound.id}`}>{problem}</div>}
        </div>
      )}
      {mine.map((q) => <RequestRow key={q.id} store={store} q={q} />)}
    </article>
  );
}
