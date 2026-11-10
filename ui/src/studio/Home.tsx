// The centre page at #/: "Needs attention" as cards or rows. All sounds stay one toggle away
// ("Show all"), with the sets and songs sections and the paged cards as before.

import { useEffect, useMemo, useState } from 'react';
import { SongCard } from '../SongCard.tsx';
import { SoundList } from '../SoundList.tsx';
import type { Store } from '../store.ts';
import { Badge, Segmented, Toggle } from './controls.tsx';
import { VirtualList } from './layout.tsx';
import { MiniWave, ThumbProgress, useRowHeight } from './Library.tsx';
import { read, setPrefs, usePrefs, write } from './prefs.ts';
import { checkOf, lufsText, useAttentionOrder } from './shellData.ts';
import { useActions } from './registry.ts';
import { useToast } from './controls.tsx';
import { Spark } from './icons.tsx';
import { projectPath } from './offline.tsx';
import { plural } from './values.ts';

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

const GENS = ['laser', 'pickup', 'jump', 'hit', 'explosion'] as const;

/** A name nothing in the project has (ids are unique ignoring case): `base`, then `base_2`, `base_3` … */
function freeName(store: Store, base: string): string {
  const taken = new Set([...store.index.map((x) => x.id), ...store.songs.map((x) => x.id), ...store.sets.map((x) => x.id)].map((x) => x.toLowerCase()));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

/** The three starts, as the commands they write (the same an agent would). */
export function startScript(store: Store, kind: 'sound' | 'set' | 'song', gen: string = 'laser', seed = 1): { id: string; commands: string } {
  if (kind === 'sound') {
    const id = freeName(store, gen);
    return { id, commands: `sound new ${id} voice=classic preset=${gen} seed=${seed}` };
  }
  if (kind === 'set') {
    const base = freeName(store, 'footstep');
    const id = freeName(store, 'footsteps');
    return { id, commands: `sound new ${base} voice=layered preset=footstep seed=${seed}\nset new ${id} from=${base} count=4 class=foley seed=${seed}` };
  }
  const id = freeName(store, 'loop');
  return {
    id,
    commands: [
      `song new ${id} tempo=120 key=A:minor`,
      `song channel add ${id} chords inst=saw_pad gain=0.3 harmony=yes`,
      `song channel add ${id} lead inst=square_lead gain=0.33`,
      `song channel add ${id} bass inst=triangle_bass gain=0.6`,
      `song channel add ${id} drums kit=default gain=0.6`,
      `chords ${id} a chords "i VI iv V i VI iv V i VI iv V i VI iv V" rhythm=bar`,
      `arp ${id} a lead from=chords pattern=updown rate=1/8 range=A4-A5`,
      `bass ${id} a bass from=chords style=root-fifth`,
      `drums ${id} a drums rock-16 fill=4 seed=${seed}`,
      `song section add ${id} A a`,
      `song loop ${id} A..A`,
    ].join('\n'),
  };
}

/** A small decaying shape for a start card (drawn, not measured: there is nothing to measure yet). */
function startWave(kind: number): string {
  const n = 48, h = 20, pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const env = kind === 0 ? Math.exp(-t * 3) : kind === 1 ? Math.exp(-((t * 4) % 1) * 6) : 0.6 + 0.4 * Math.abs(((t * 12) % 2) - 1);
    const wob = 0.55 + 0.45 * Math.abs(Math.sin(i * 2.3 + kind));
    pts.push([t * 160, Math.min(1, t * 30) * env * wob * h * 0.9]);
  }
  return `M${pts.map(([x, y]) => `${x.toFixed(1)} ${(h - y).toFixed(1)}`).join(' L')} L${pts.slice().reverse().map(([x, y]) => `${x.toFixed(1)} ${(h + y).toFixed(1)}`).join(' L')} Z`;
}

/** The three starts as actions (N, ⇧N, ⌥N on the home page): each writes its commands as the person and opens what it made. */
function useStarts(store: Store): { start(kind: 'sound' | 'set' | 'song'): Promise<void>; busy: string | null; gen: string; setGen(g: string): void } {
  const toast = useToast();
  const [gen, setGen] = useState<string>('laser');
  const [busy, setBusy] = useState<string | null>(null);
  const start = async (kind: 'sound' | 'set' | 'song') => {
    if (busy) return;
    const { id, commands } = startScript(store, kind, gen);
    setBusy(kind);
    const r = await store.run(commands);
    setBusy(null);
    if (!r.ok) { toast(r.errors.map((e) => e.message).join('; '), 'error'); return; }
    if (r.queued) { toast('Offline: the start is queued and is made when the server is back.', 'warn'); return; }
    location.hash = kind === 'sound' ? `#/sound/${id}` : kind === 'set' ? `#/set/${id}` : `#/song/${id}`;
    if (kind === 'sound') void store.play(id);
  };
  useActions([
    { id: 'new.sound', label: 'New sound from a preset', group: 'New', shortcut: 'N', key: 'n', run: () => void start('sound'), keywords: 'make create generator laser pickup jump hit explosion' },
    { id: 'new.set', label: 'New set: four footsteps as one family', group: 'New', shortcut: '⇧ N', key: 'shift+n', run: () => void start('set'), keywords: 'make create family' },
    { id: 'new.song', label: 'New song: a 16-bar loop', group: 'New', shortcut: '⌥ N', key: 'alt+n', run: () => void start('song'), keywords: 'make create music loop' },
  ]);
  return { start, busy, gen, setGen };
}

/** An empty project: three starts that each make something real, and the line an agent would run. */
function NewProject({ store, starts }: { store: Store; starts: ReturnType<typeof useStarts> }) {
  const { start, busy, gen, setGen } = starts;
  const path = projectPath(store);
  const cli = `soundclaw run ${/\s/.test(path) ? JSON.stringify(path) : path} -e "sound new laser voice=classic preset=laser seed=1" && soundclaw render ${/\s/.test(path) ? JSON.stringify(path) : path} laser`;
  const cards = [
    { kind: 'sound' as const, t: 'A sound from a preset', d: 'Pick laser, pickup, jump, hit or explosion. One key.', k: 'N' },
    { kind: 'set' as const, t: 'A set', d: 'Four footsteps that match in loudness, made as one family.', k: '⇧N' },
    { kind: 'song' as const, t: 'A song', d: 'A 16-bar loop in A minor with drums, bass and a lead.', k: '⌥N' },
  ];
  return (
    <section className="newp" data-testid="new-project" aria-label="New project">
      <div className="newp-head">
        <h1>Start with a sound you can hear</h1>
        <p className="dim">Each start makes something real in under a second, with the same commands the agent uses. You can change everything after.</p>
      </div>
      <div className="newp-starts">
        {cards.map((c, i) => (
          <div key={c.kind} className="newp-card" data-primary={i === 0 || undefined}>
            <button type="button" className="newp-go" onClick={() => void start(c.kind)} disabled={!!busy} data-testid={`start-${c.kind}`} aria-keyshortcuts={c.k === 'N' ? 'N' : c.k === '⇧N' ? 'Shift+N' : 'Alt+N'}>
              <svg width="100%" height="40" viewBox="0 0 160 40" preserveAspectRatio="none" aria-hidden><path d={startWave(i)} /></svg>
              <span className="newp-t">{busy === c.kind ? 'Making it…' : c.t}</span>
              <span className="newp-d">{c.d}</span>
              <kbd className="kbd">{c.k}</kbd>
            </button>
            {c.kind === 'sound' && (
              <div className="newp-gens" role="radiogroup" aria-label="Preset">
                {GENS.map((g) => <button key={g} type="button" role="radio" aria-checked={gen === g} className="chip-btn" onClick={() => setGen(g)} data-testid={`start-gen-${g}`}>{g}</button>)}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="newp-agent">
        <span className="cap agent-cap"><Spark size={12} />Or let the agent start</span>
        <code className="mono newp-cli" data-testid="new-cli">{cli}</code>
        <span className="dim small">The agent's results appear here live, as it makes them: run the agent with this project's MCP server (<code className="mono">soundclaw serve --project {path}</code>) or the CLI line above.</span>
      </div>
    </section>
  );
}

export function Home({ store }: { store: Store }) {
  const prefs = usePrefs();
  const [all, setAll] = useState(() => read(ALL_KEY) === '1');
  useEffect(() => { write(ALL_KEY, all ? '1' : null); }, [all]);
  const starts = useStarts(store);
  const ordered = useAttentionOrder(store);
  const needs = useMemo(() => ordered.filter((s) => checkOf(s) === 'fail'), [ordered]);
  const empty = store.index.length === 0 && store.songs.length === 0 && store.sets.length === 0;
  return (
    <div className="home" data-testid="home">
      {!empty && <div className="home-head">
        <h1>{all ? 'All sounds' : 'Needs attention'}</h1>
        <span className="dim" data-testid="home-sub">{all ? `${plural(store.index.length, 'sound')}, the ones that fail a check first` : `${needs.length} sound${needs.length === 1 ? '' : 's'} fail a check · sorted by severity, then by last change`}</span>
        <span className="grow" />
        <Toggle checked={all} onChange={setAll} label="Show all" testId="show-all" />
        <Segmented value={prefs.homeView} onChange={(v) => setPrefs({ homeView: v })} label="View" testId="home-view"
          options={[{ value: 'cards', label: 'Cards', testId: 'view-cards' }, { value: 'rows', label: 'Rows', testId: 'view-rows' }]} />
      </div>}
      {!empty && <ThumbProgress store={store} testId="home-thumb-progress" />}
      {all && store.sets.length > 0 && (
        <section className="sets" data-testid="sets" aria-label="Sets">
          <h2>Sets</h2>
          <div className="set-tiles">
            {store.sets.map((x) => (
              <article key={x.id} className="card set-tile" data-testid={`set-tile-${x.id}`}>
                <h3><a href={`#/set/${x.id}`} data-testid={`set-open-${x.id}`}>{x.id}</a></h3>
                <div className="dim">{plural(x.members.length, 'member')}{x.target !== null ? ` · ${x.target} LUFS` : ''}</div>
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
      {empty && store.project && <NewProject store={store} starts={starts} />}
      {!empty && !all && needs.length === 0 && (
        <p className="all-clear" data-testid="all-clear">Nothing fails a check right now. <button type="button" className="link-btn" onClick={() => setAll(true)}>Show all {plural(store.index.length, 'sound')}</button></p>
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
