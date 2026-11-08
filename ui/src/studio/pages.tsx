// The pages the shell hosts: the existing editors, sets and audition (restyled by the tokens),
// the needs-attention page, the session and a review (basic for now) and the hidden #/kit.

import { useEffect, useState } from 'react';
import { AuditionPage } from '../AuditionPage.tsx';
import { Editor } from '../Editor.tsx';
import { AnalysisPage } from '../sound/AnalysisPage.tsx';
import { SetPage } from '../SetPage.tsx';
import { SongEditor } from '../SongEditor.tsx';
import type { Store } from '../store.ts';
import { Home } from './Home.tsx';
import { Kit } from './Kit.tsx';
import { Rail } from './Rail.tsx';
import { RequestRow } from '../SoundCard.tsx';
import { requestState } from './shellData.ts';

/** An editor's page: the sound's document (asked for in a lean project) and the samples it names are fetched first, then the editor opens. */
function EditorGate({ store, id, view }: { store: Store; id: string; view?: 'analysis' }) {
  const doc = store.doc(id);
  const [ready, setReady] = useState(false);
  useEffect(() => { store.markSeen(id); }, [store, id]);
  useEffect(() => {
    if (!doc || ready) return;
    let live = true;
    void store.ensureSamples(doc).then(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, [doc, ready, store]);
  if (!doc && store.index.some((x) => x.id === id)) return <section className="editor"><a href="#/" className="back">{'←'} all sounds</a><p className="dim" data-testid="editor-loading">Loading {id}{'…'}</p></section>;
  if (doc && !ready && !store.samplesReadyFor(store.samples.filter((x) => JSON.stringify(doc).includes(`"${x.name}"`)).map((x) => x.name))) return <section className="editor"><a href="#/" className="back">{'←'} all sounds</a><p className="dim" data-testid="editor-loading">Loading the samples of {id}{'…'}</p></section>;
  return view === 'analysis' ? <AnalysisPage store={store} id={id} /> : <Editor store={store} id={id} />;
}

/** The session: every request and where it stands, with the live feed. The lanes and the working-on card grow in later work. */
function Session({ store, onPlay, onOpen }: { store: Store; onPlay(id: string): void; onOpen(id: string): void }) {
  const lanes: { title: string; match(q: ReturnType<Store['requests']['at']> & object): boolean }[] = [
    { title: 'Sent', match: (q) => q.state === 'open' && !(q.seen ?? []).length },
    { title: 'Seen', match: (q) => q.state === 'open' && (q.seen ?? []).length > 0 },
    { title: 'Working', match: (q) => q.state === 'claimed' },
    { title: 'Blocked', match: (q) => q.state === 'blocked' },
    { title: 'Ready for review', match: (q) => q.state === 'done' },
  ];
  return (
    <div className="session" data-testid="session">
      <h1>Session</h1>
      <p className="dim">What the agent is doing and where each request stands.</p>
      <div className="lanes">
        {lanes.map((l) => {
          const qs = store.requests.filter(l.match).slice(-20).reverse();
          return (
            <section key={l.title} className="lane" aria-label={l.title}>
              <h2 className="cap">{l.title} <span className="mono">{qs.length}</span></h2>
              {qs.length === 0 && <p className="dim small">Nothing here.</p>}
              {qs.map((q) => (
                <div key={q.id} className="lane-card">
                  <RequestRow store={store} q={q} />
                  <button type="button" className="link-btn" onClick={() => onOpen(q.sound)}>open {q.sound}</button>
                  <button type="button" className="link-btn" onClick={() => { location.hash = `#/review/${q.id}`; }}>review</button>
                </div>
              ))}
            </section>
          );
        })}
      </div>
      <div className="session-feed"><Rail store={store} onPlay={onPlay} onOpen={onOpen} ask={async () => false} focus={null} /></div>
    </div>
  );
}

/** A review of one request: what was asked and the commands the agent wrote for it (before and after, approve and revert come later). */
function Review({ store, id }: { store: Store; id: string }) {
  const q = store.requests.find((x) => x.id === id);
  if (!q) return <section className="review"><p className="dim" data-testid="no-review">{store.status === 'open' ? 'No such request.' : 'Connecting…'} <a href="#/">{'←'} back</a></p></section>;
  const st = requestState(q);
  return (
    <section className="review" data-testid="review">
      <h1>Review {q.id}</h1>
      <p><b>{q.sound}</b> <span className="state-chip" data-tone={st.tone}>{st.word}</span></p>
      <p>{'“'}{q.note}{'”'}</p>
      {q.latest && <p className="dim">{q.latest}</p>}
      <ul className="review-events">{q.events.map((e, i) => <li key={i}><span className="mono">{e.type}</span> {e.by}{e.text ? `: ${e.text}` : ''}</li>)}</ul>
      <p><a className="button" href={`#/sound/${q.sound}`}>Open {q.sound}</a></p>
    </section>
  );
}

export function Page({ store, onPlay, onOpen }: { store: Store; onPlay(id: string): void; onOpen(id: string): void }) {
  const r = store.route;
  switch (r.kind) {
    case 'sound': return <EditorGate key={`${r.id}/${r.view ?? ''}`} store={store} id={r.id} {...(r.view ? { view: r.view } : {})} />;
    case 'song': return <SongEditor key={r.id} store={store} id={r.id} />;
    case 'audition': return <AuditionPage key={r.set ?? 'all'} store={store} setId={r.set} />;
    case 'set': {
      const set = store.sets.find((x) => x.id === r.id);
      return set ? <SetPage key={set.id} store={store} set={set} /> : <p className="dim" data-testid="no-set">{store.status === 'open' ? 'No such set.' : 'Connecting…'} <a href="#/">{'←'} all sounds</a></p>;
    }
    case 'session': return <Session store={store} onPlay={onPlay} onOpen={onOpen} />;
    case 'review': return <Review store={store} id={r.id} />;
    case 'kit': return <Kit />;
    default: return <Home store={store} />;
  }
}
