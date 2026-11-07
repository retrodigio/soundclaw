import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { activeGroups, type TapeEntry } from '@soundclaw/core';
import { AuditionPage } from './AuditionPage.tsx';
import { Editor } from './Editor.tsx';
import { ListenerChip } from './Listening.tsx';
import { SetPage } from './SetPage.tsx';
import { SoundList } from './SoundList.tsx';
import { SongCard } from './SongCard.tsx';
import { SongEditor } from './SongEditor.tsx';
import type { Store } from './store.ts';

const HISTORY_ROWS = 200;

function History({ store, tape }: { store: Store; tape: TapeEntry[] }) {
  const [limit, setLimit] = useState(HISTORY_ROWS);
  const active = useMemo(() => activeGroups(tape), [tape]);
  const rows = useMemo(() => tape.slice(-limit).reverse(), [tape, limit]);
  const earlier = store.tapeTotal - rows.length;
  return (
    <section className="history" data-testid="history" aria-label="History">
      <h2>History <span className="dim">({store.tapeTotal} commands)</span></h2>
      {rows.length === 0 && <p className="dim">Nothing yet. Commands the agent and people run appear here.</p>}
      <ol>
        {rows.map((e) => (
          <li key={e.seq} className={`cmd-row${active.has(e.group) ? '' : ' undone'}`} data-testid="cmd-row" data-seq={e.seq} data-by={e.by} data-group={e.group}>
            <span className="seq">#{e.seq}</span>
            <span className="group">{e.group}</span>
            <span className={`by ${e.by.startsWith('human:') ? 'human' : 'agent'}`}>{e.by}</span>
            <code>{e.cmd}</code>
          </li>
        ))}
      </ol>
      {earlier > 0 && (
        <button data-testid="history-earlier" onClick={() => { const n = limit + 500; setLimit(n); if (n > tape.length) void store.loadEarlier(); }}>Show {Math.min(500, earlier)} earlier of {earlier}</button>
      )}
    </section>
  );
}

/** An editor's page: the sound's document (asked for in a lean project) and the samples it names are fetched first, then the editor opens. */
function EditorGate({ store, id }: { store: Store; id: string }) {
  const doc = store.doc(id);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!doc || ready) return;
    let live = true;
    void store.ensureSamples(doc).then(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, [doc, ready, store]);
  if (!doc && store.index.some((x) => x.id === id)) return <section className="editor"><a href="#/" className="back">← all sounds</a><p className="dim" data-testid="editor-loading">Loading {id}…</p></section>;
  if (doc && !ready && !store.samplesReadyFor(store.samples.filter((x) => JSON.stringify(doc).includes(`"${x.name}"`)).map((x) => x.name))) return <section className="editor"><a href="#/" className="back">← all sounds</a><p className="dim" data-testid="editor-loading">Loading the samples of {id}…</p></section>;
  return <Editor store={store} id={id} />;
}

export function App({ store }: { store: Store }) {
  useSyncExternalStore(store.subscribe, store.getVersion);
  const [name, setName] = useState(store.me.replace(/^human:/, ''));
  const open = store.requests.filter((q) => ['open', 'claimed', 'blocked'].includes(q.state));
  return (
    <div className="app">
      <header className="top">
        <h1>SoundClaw <span className="dim" data-testid="project-name">{store.project?.name ?? ''}</span></h1>
        <nav className="nav">
          <a href="#/" data-testid="nav-sounds" aria-current={store.route.kind === 'cards'}>Sounds</a>
          <a href="#/audition" data-testid="nav-audition" aria-current={store.route.kind === 'audition'}>Audition</a>
        </nav>
        <ListenerChip store={store} />
        <span className="dim" data-testid="requests-count">{open.length} request{open.length === 1 ? '' : 's'} for the agent</span>
        <span className="spacer" />
        <button data-testid="undo" disabled={!store.canUndo()} onClick={() => void store.undo()}>Undo</button>
        <button data-testid="redo" disabled={!store.canRedo()} onClick={() => void store.redo()}>Redo</button>
        <label className="me">you are
          <input value={name} data-testid="author" onChange={(e) => { setName(e.target.value); store.setAuthor(e.target.value); }} aria-label="Your name" />
        </label>
        <span className={`chip conn conn-${store.status}`} data-testid="connection" data-status={store.status}>{store.status}</span>
      </header>
      {store.error && <div className="error banner" data-testid="error" role="alert">{store.error} <button className="link" onClick={() => { store.error = null; store.changed(); }}>dismiss</button></div>}
      <main>
        {store.route.kind === 'sound' ? <EditorGate key={store.route.id} store={store} id={store.route.id} />
          : store.route.kind === 'song' ? <SongEditor key={store.route.id} store={store} id={store.route.id} />
          : store.route.kind === 'audition' ? <AuditionPage key={store.route.set ?? 'all'} store={store} setId={store.route.set} />
          : store.route.kind === 'set' ? (() => {
            const set = store.sets.find((x) => x.id === (store.route as { id: string }).id);
            return set ? <SetPage key={set.id} store={store} set={set} /> : <p className="dim" data-testid="no-set">{store.status === 'open' ? 'No such set.' : 'Connecting…'} <a href="#/">← all sounds</a></p>;
          })() : (
            <div className="home">
              {store.sets.length > 0 && (
                <section className="sets" data-testid="sets" aria-label="Sets">
                  <h2>Sets</h2>
                  <div className="set-tiles">
                    {store.sets.map((x) => (
                      <article key={x.id} className="card set-tile" data-testid={`set-tile-${x.id}`}>
                        <h3><a href={`#/set/${x.id}`} data-testid={`set-open-${x.id}`}>{x.id}</a></h3>
                        <div className="dim">{x.members.length} members{x.target !== null ? ` · ${x.target} LUFS` : ''}</div>
                        <div className="card-actions"><a className="button" href={`#/set/${x.id}`}>Open</a><a className="button" href={`#/audition/${x.id}`} data-testid={`set-audition-${x.id}`}>Audition</a></div>
                      </article>
                    ))}
                  </div>
                </section>
              )}
              {store.songs.length > 0 && (
                <section className="songs" data-testid="songs" aria-label="Songs">
                  <h2>Songs</h2>
                  {store.songs.map((x) => <SongCard key={x.id} store={store} song={x} />)}
                </section>
              )}
              {store.index.length === 0 && store.songs.length === 0 && store.status === 'open' && (
                <section className="sounds" data-testid="sounds" aria-label="Sounds">
                  <p className="empty" data-testid="empty">No sounds yet. Ask the agent to make one, or run <code>soundclaw run &lt;project&gt; -e "sound new beep"</code>.</p>
                </section>
              )}
              {store.index.length > 0 && <SoundList store={store} />}
            </div>
          )}
        <History store={store} tape={store.tape} />
      </main>
    </div>
  );
}
