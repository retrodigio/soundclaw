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
import { Review } from './Review.tsx';
import { Session } from './Session.tsx';

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

export function Page({ store, onOpen }: { store: Store; onPlay?(id: string): void; onOpen(id: string): void }) {
  const r = store.route;
  switch (r.kind) {
    case 'sound': return <EditorGate key={`${r.id}/${r.view ?? ''}`} store={store} id={r.id} {...(r.view ? { view: r.view } : {})} />;
    case 'song': return <SongEditor key={r.id} store={store} id={r.id} {...(r.view ? { view: r.view } : {})} />;
    case 'audition': return <AuditionPage key={r.set ?? 'all'} store={store} setId={r.set} />;
    case 'set': {
      const set = store.sets.find((x) => x.id === r.id);
      return set ? <SetPage key={set.id} store={store} set={set} /> : <p className="dim" data-testid="no-set">{store.status === 'open' ? 'No such set.' : 'Connecting…'} <a href="#/">{'←'} all sounds</a></p>;
    }
    case 'session': return <Session store={store} onOpen={onOpen} />;
    case 'review': return <Review store={store} id={r.id} />;
    case 'kit': return <Kit />;
    default: return <Home store={store} />;
  }
}
