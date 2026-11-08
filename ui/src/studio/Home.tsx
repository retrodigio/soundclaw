// The centre page at #/: "Needs attention" as cards or rows. All sounds stay one toggle away
// ("Show all"), with the sets and songs sections and the paged cards as before.

import { useEffect, useMemo, useState } from 'react';
import { SongCard } from '../SongCard.tsx';
import { SoundList } from '../SoundList.tsx';
import type { Store } from '../store.ts';
import { Badge, Segmented, Toggle } from './controls.tsx';
import { VirtualList } from './layout.tsx';
import { MiniWave, useRowHeight } from './Library.tsx';
import { read, setPrefs, usePrefs, write } from './prefs.ts';
import { checkOf, lufsText, useAttentionOrder } from './shellData.ts';

const ALL_KEY = 'soundclaw.homeAll';

function Rows({ store, ids }: { store: Store; ids: string[] }) {
  const h = useRowHeight();
  const byId = useMemo(() => new Map(store.index.map((s) => [s.id, s])), [store.index]);
  return (
    <div className="home-rows" data-testid="home-rows">
      <div className="home-rows-head cap"><span className="grow">Name</span><span className="hr-wave">Waveform</span><span className="hr-num">LUFS</span><span className="hr-checks">Checks</span><span className="hr-when">Voice</span></div>
      <VirtualList count={ids.length} rowHeight={Math.max(h, 28)} label="Sounds" testId="home-rows-list" renderRow={(i) => {
        const s = byId.get(ids[i]!)!;
        const k = checkOf(s);
        return (
          <a className="home-row" href={`#/sound/${s.id}`} data-testid={`home-row-${s.id}`} data-check={k}>
            <span className="new-dot" style={{ opacity: store.agentNew.has(s.id) ? 1 : 0 }} aria-hidden />
            <span className="grow home-name">{s.id}</span>
            <span className="hr-wave"><MiniWave store={store} id={s.id} w={96} h={16} /></span>
            <span className="mono hr-num">{s.info ? lufsText(s.info.lufs) : '…'}</span>
            <span className="hr-checks"><Badge kind={k}>{k === 'fail' ? (s.info?.failing ?? []).join(', ') : k === 'pass' ? 'all pass' : 'checking'}</Badge></span>
            <span className="mono hr-when dim">{s.voice}</span>
          </a>
        );
      }} />
    </div>
  );
}

export function Home({ store }: { store: Store }) {
  const prefs = usePrefs();
  const [all, setAll] = useState(() => read(ALL_KEY) === '1');
  useEffect(() => { write(ALL_KEY, all ? '1' : null); }, [all]);
  const ordered = useAttentionOrder(store);
  const needs = useMemo(() => ordered.filter((s) => checkOf(s) === 'fail'), [ordered]);
  const empty = store.index.length === 0 && store.songs.length === 0 && store.sets.length === 0;
  return (
    <div className="home" data-testid="home">
      <div className="home-head">
        <h1>{all ? 'All sounds' : 'Needs attention'}</h1>
        <span className="dim" data-testid="home-sub">{all ? `${store.index.length} sounds, the ones that fail a check first` : `${needs.length} sound${needs.length === 1 ? '' : 's'} fail a check · sorted by severity, then by last change`}</span>
        <span className="grow" />
        <Toggle checked={all} onChange={setAll} label="Show all" testId="show-all" />
        <Segmented value={prefs.homeView} onChange={(v) => setPrefs({ homeView: v })} label="View" testId="home-view"
          options={[{ value: 'cards', label: 'Cards', testId: 'view-cards' }, { value: 'rows', label: 'Rows', testId: 'view-rows' }]} />
      </div>
      {all && store.sets.length > 0 && (
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
      {all && store.songs.length > 0 && (
        <section className="songs" data-testid="songs" aria-label="Songs">
          <h2>Songs</h2>
          {store.songs.map((x) => <SongCard key={x.id} store={store} song={x} />)}
        </section>
      )}
      {empty && store.status === 'open' && (
        <section className="sounds" data-testid="sounds" aria-label="Sounds">
          <p className="empty" data-testid="empty">No sounds yet. Ask the agent to make one, or run <code>soundclaw run &lt;project&gt; -e "sound new beep"</code>.</p>
        </section>
      )}
      {!empty && !all && needs.length === 0 && (
        <p className="all-clear" data-testid="all-clear">Nothing fails a check right now. <button type="button" className="link-btn" onClick={() => setAll(true)}>Show all {store.index.length} sounds</button></p>
      )}
      {store.index.length > 0 && (all || needs.length > 0) && (
        prefs.homeView === 'rows'
          ? <Rows store={store} ids={(all ? ordered : needs).map((s) => s.id)} />
          : <SoundList store={store} attentionOnly={!all} />
      )}
      {!all && needs.length > 0 && <p className="dim small">Everything else is in the library; <button type="button" className="link-btn" onClick={() => setAll(true)}>show all</button>.</p>}
    </div>
  );
}
