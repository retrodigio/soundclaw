// The home page's card: name and voice, one 54 px panel (the waveform over the spectrogram, a
// marker where a check reports a time), a badge per failing check, and who changed it last.
// Actions (Play, Approve, Ask) show on hover and focus; Feedback, Edit and the exports are in the
// overflow menu. Every card is the same height, so the grid can be windowed.

import { askAttr } from './ask.tsx';
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { csvFileText, patchFileText, targetWords, type Sound, type TapeEntry, type WorkRequest } from '@soundclaw/core';
import type { SoundSummary } from '@soundclaw/server/protocol';
import { useCard } from '../CardImages.tsx';
import { download } from '../download.ts';
import { unattended, useNow } from '../Listening.tsx';
import { Feedback, RequestRow } from '../SoundCard.tsx';
import { Spectrogram } from '../Spectrogram.tsx';
import type { Store } from '../store.ts';
import { Waveform } from '../Waveform.tsx';
import { AuthorMark, Badge, Popover, authorOf, type CheckKind } from './controls.tsx';
import { Menu, Play, Stop } from './icons.tsx';
import { ago, checkOf, MINUS } from './shellData.ts';

/** The library's selection, shared with the centre page so the selected card gets the ember border. */
export interface Selection { selected: { kind: string; id: string } | null; select(f: { kind: 'sound'; id: string }): void; ask(f: { kind: 'sound'; id: string }): void }
export const SelectionCtx = createContext<Selection>({ selected: null, select: () => undefined, ask: () => undefined });
export const useSelection = (): Selection => useContext(SelectionCtx);

/** The card's height and the gap between cards: fixed, so the grid knows where every row is. */
export const CARD_H = 168;
export const CARD_GAP = 10;
export const CARD_MIN_W = 190;

const text = (n: number): string => n.toFixed(1).replace('-', MINUS);

/** One badge per failing check, with its time when it has one ("click 0.14 s"), and loudness with its number. */
function issueBadges(sum: SoundSummary): { name: string; label: string; title: string; at?: number }[] {
  const info = sum.info;
  if (!info || info.pass) return [];
  const issues: { name: string; value: string; at?: number }[] = info.issues ?? info.failing.map((name) => ({ name, value: '' }));
  return issues.map((i) => ({
    name: i.name,
    at: i.at,
    label: i.at !== undefined ? `${i.name} ${i.at.toFixed(2)} s` : i.name === 'loudness' && info.lufs !== null ? `loud ${text(info.lufs)}` : i.name,
    title: i.value ? `${i.name}: ${i.value}` : i.name,
  }));
}

export interface NeedCardProps {
  store: Store;
  sound: SoundSummary;
  selected: boolean;
  playing: boolean;
  plays: number;
  mine: WorkRequest[];
  /** What a request's row shows besides the request itself (who is listening). */
  presence: string;
  fresh: boolean;
  last: TapeEntry | undefined;
  /** Minutes-level clock tick, so "2 min ago" moves on. */
  tick: number;
}

function RequestLine({ store, q }: { store: Store; q: WorkRequest }) {
  const label = q.state === 'open' ? ((q.seen ?? []).length ? `seen by ${q.seen.map((x) => x.by).join(', ')}` : 'sent') : q.state === 'claimed' ? `${q.claimedBy} is working on it` : q.state;
  return (
    <div className="nc-req" data-testid={`request-${q.id}`} data-state={q.state} title={`${q.id}: ${q.note}`}>
      <b>{q.id}</b> <span className={`chip state-${q.state}`}>{label}</span>
      {(q.tags ?? []).map((t) => <span key={t} className={`chip tag${t === 'good' ? ' good' : ''}`} data-testid={`request-tag-${q.id}`}>{t}</span>)}
      {q.other && <span className="dim" data-testid={`request-other-${q.id}`}>like {q.other}</span>}
      <span className="dim nc-req-note"> {'“'}{q.note}{'”'}</span>
      {q.target && <span className="mono dim" data-testid={`request-target-${q.id}`}> {targetWords(q.target)}</span>}
      {q.state === 'claimed' && q.latest && <span className="dim nc-req-note" data-testid="working"> {q.latest}</span>}
      {q.state === 'done' && <span className="dim nc-req-note" data-testid={`done-${q.id}`}>{'✓'} done: {q.latest}</span>}
      {(q.state === 'open' || q.state === 'claimed') && <button className="link" data-testid={`cancel-${q.id}`} onClick={() => void store.request({ action: 'cancel', id: q.id })}>withdraw</button>}
    </div>
  );
}

export const NeedCard = memo(function NeedCard({ store, sound, selected, playing, plays, mine, fresh, last, tick }: NeedCardProps) {
  const sel = useSelection();
  const { ref, card } = useCard(store, sound.id, sound.key);
  const [asking, setAsking] = useState(false);
  const [feeding, setFeeding] = useState(false);
  const [menu, setMenu] = useState(false);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const info = sound.info ?? card;
  const kind: CheckKind = checkOf(sound);
  const badges = issueBadges(sound);
  const duration = info?.duration ?? 0;
  const now = useMemo(() => Date.now(), [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const clock = useNow(30_000);
  const latest = mine.at(-1);
  // a question to answer, or nobody listening: the full request block opens under the card
  const needsAttention = !!latest && (latest.state === 'blocked' || unattended(store, latest, clock));
  const who = last ? authorOf(last.by) : null;
  const send = async () => {
    const r = await store.askForChanges(sound.id, note);
    if (r.ok) { setAsking(false); setNote(''); setProblem(null); } else setProblem(r.error ?? 'refused');
  };
  const doc = (): Promise<Sound | undefined> => store.docNow(sound.id);
  const item = (label: string, run: () => void | Promise<void>, testId: string) => <button type="button" role="menuitem" className="menu-item" data-testid={testId} onClick={() => { setMenu(false); void run(); }}>{label}</button>;
  return (
    <article ref={ref} className="nc" data-testid={`card-${sound.id}`} data-ask-item={sound.id} {...askAttr(sound.id, { kind: 'item' }, sound.id)} data-status={sound.status} data-hash={info?.hash ?? ''} data-selected={selected || undefined} data-playing={playing || undefined} data-new={fresh || undefined}
      onClick={() => sel.select({ kind: 'sound', id: sound.id })}>
      <header className="nc-head">
        <a className="nc-name" href={`#/sound/${sound.id}`} title={`Open ${sound.id}${sound.label ? ` (${sound.label})` : ''}`}>{sound.id}</a>
        <span className="mono nc-voice">{sound.voice}</span>
      </header>
      <div className="nc-panel">
        <div className="nc-spec"><Spectrogram spec={card?.spec} id={sound.id} /></div>
        <div className="nc-wave"><Waveform wave={card?.wave} peak={card?.peak} id={sound.id} /></div>
        {duration > 0 && badges.slice(0, 2).filter((b) => b.at !== undefined).map((b) => <span key={b.name} className="nc-mark" style={{ left: `${Math.min(99, (b.at! / duration) * 100)}%` }} aria-hidden />)}
        <div className="nc-actions" role="group" aria-label={`Actions for ${sound.id}`}>
          <button className="nc-btn" data-testid={`play-${sound.id}`} data-plays={plays} data-playing={playing} onClick={(e) => { e.stopPropagation(); void store.play(sound.id); }} aria-label={`${playing ? 'Stop' : 'Play'} ${sound.id}`} title={playing ? 'Stop' : 'Play'}>{playing ? <Stop size={9} /> : <Play size={10} />}</button>
          <button className="nc-btn" data-testid={`approve-${sound.id}`} disabled={sound.status === 'approved'} onClick={(e) => { e.stopPropagation(); void store.approve(sound.id); }} title="Approve">{'✓'}<span className="sr-only"> Approve</span></button>
          <button className="nc-btn" data-testid={`reject-${sound.id}`} aria-expanded={asking} onClick={(e) => { e.stopPropagation(); setAsking(!asking); }} title="Ask for changes (R)">Ask <kbd className="kbd">R</kbd></button>
          <div onClick={(e) => e.stopPropagation()}>
            <Popover open={menu} onClose={() => setMenu(false)} label={`More for ${sound.id}`} align="end" trigger={<button type="button" className="nc-btn" aria-label={`More actions for ${sound.id}`} aria-haspopup="menu" aria-expanded={menu} data-testid={`more-${sound.id}`} onClick={() => setMenu(!menu)}><Menu size={12} /></button>}>
              <div className="menu" role="menu">
                {item('Feedback…', () => setFeeding(!feeding), `feedback-toggle-${sound.id}`)}
                <a className="menu-item" role="menuitem" href={`#/sound/${sound.id}`} data-testid={`edit-${sound.id}`}>Edit</a>
                {item('Export WAV', async () => { const d = await doc(); if (d) download(`${sound.id}.wav`, store.wavOf(d), 'audio/wav'); }, `export-wav-${sound.id}`)}
                {sound.voice === 'classic' && item('Export patch text', async () => { const d = await doc(); if (d?.voice === 'classic') download(`${sound.id}.sfxr`, patchFileText(d.patch), 'text/plain'); }, `export-patch-${sound.id}`)}
                {sound.voice === 'classic' && item('Export CSV row', async () => { const d = await doc(); if (d?.voice === 'classic') download(`${sound.id}.csv`, csvFileText(sound.id, d.patch), 'text/csv'); }, `export-csv-${sound.id}`)}
              </div>
            </Popover>
          </div>
        </div>
      </div>
      <div className="nc-badges" data-testid={`check-${sound.id}`} {...(info ? { 'data-pass': info.pass } : {})} data-failing={(info?.failing ?? []).join(',')} title={info?.summary ?? 'not checked yet'}>
        {kind === 'checking' && <Badge kind="checking">checking</Badge>}
        {kind === 'pass' && <Badge kind="pass">all pass</Badge>}
        {badges.slice(0, 2).map((b) => <Badge key={b.name} kind="fail" title={b.title}>{b.label}</Badge>)}
        {badges.length > 2 && <span className="mono dim small" title={badges.slice(2).map((b) => b.title).join('; ')}>+{badges.length - 2}</span>}
      </div>
      <div className="nc-author">
        {who ? <><AuthorMark by={who} size={12} /><span>{who === 'agent' ? 'agent' : 'you'} {'·'} {last?.at ? ago(last.at, now) : `#${last?.seq}`}</span></> : <span className="dim">no changes held</span>}
        {fresh && <span className="new-dot" role="img" aria-label="changed by the agent" />}
        <span className="grow" />
        {sound.status !== 'draft' && <span className={`chip status-${sound.status}`} data-testid={`status-${sound.id}`}>{sound.status === 'rejected' ? 'asked' : sound.status}</span>}
      </div>
      <div className="nc-reqline">{latest && !needsAttention && <RequestLine store={store} q={latest} />}</div>
      {(asking || feeding || needsAttention) && (
        <div className="nc-pop" onClick={(e) => e.stopPropagation()}>
          {asking && (
            <div className="ask">
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change? (e.g. softer, a little lower)" data-testid={`reject-text-${sound.id}`} rows={2} autoFocus />
              <button disabled={!note.trim()} data-testid={`reject-send-${sound.id}`} onClick={() => void send()}>Send</button>
              {problem && <div className="error" data-testid={`reject-error-${sound.id}`}>{problem}</div>}
            </div>
          )}
          {feeding && <Feedback store={store} sound={sound} />}
          {needsAttention && latest && <RequestRow store={store} q={latest} />}
        </div>
      )}
    </article>
  );
}, (a, b) => a.sound === b.sound && a.selected === b.selected && a.playing === b.playing && a.plays === b.plays && a.presence === b.presence && a.store === b.store && a.fresh === b.fresh && a.last === b.last && a.tick === b.tick
  && a.mine.length === b.mine.length && JSON.stringify(a.mine) === JSON.stringify(b.mine));

/** The grid of cards, windowed: only the rows near the page's scroll position exist. The scroll container is the page. */
export function CardGrid({ store, sounds, mineBy, playsBy, presence }: { store: Store; sounds: SoundSummary[]; mineBy: Map<string, WorkRequest[]>; playsBy: Map<string, number>; presence: string }) {
  const sel = useSelection();
  const box = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState({ w: 800, top: 0, view: 800, offset: 0 });
  const tick = Math.floor(useNow(60_000) / 60_000);
  const none: WorkRequest[] = useMemo(() => [], []);
  useEffect(() => {
    const el = box.current;
    const sc = el?.closest('.page') as HTMLElement | null;
    if (!el || !sc) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      const r = el.getBoundingClientRect(), s = sc.getBoundingClientRect();
      setGeo((g) => (g.w === el.clientWidth && Math.abs(g.offset - (r.top - s.top)) < 1 && g.view === sc.clientHeight ? g : { w: el.clientWidth, top: sc.scrollTop, view: sc.clientHeight, offset: r.top - s.top }));
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(read); };
    read();
    sc.addEventListener('scroll', on, { passive: true });
    const ro = new ResizeObserver(on);
    ro.observe(el); ro.observe(sc);
    return () => { sc.removeEventListener('scroll', on); ro.disconnect(); cancelAnimationFrame(raf); };
  }, [sounds.length]);
  const cols = Math.max(1, Math.floor((geo.w + CARD_GAP) / (CARD_MIN_W + CARD_GAP)));
  const rowH = CARD_H + CARD_GAP;
  const rows = Math.ceil(sounds.length / cols);
  // geo.offset is where the grid's top is inside the visible page (negative once scrolled past it)
  const first = Math.max(0, Math.floor(-geo.offset / rowH) - 1);
  const last = Math.min(rows, Math.ceil((-geo.offset + geo.view) / rowH) + 1);
  const shown = sounds.slice(first * cols, last * cols);
  const lastBy = useLastEntries(store);
  return (
    <div ref={box} className="need-grid-wrap" data-testid="need-grid" data-cols={cols} data-rows={rows} style={{ height: Math.max(0, rows * rowH - CARD_GAP) }}>
      <div className="need-grid" style={{ transform: `translateY(${first * rowH}px)`, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: CARD_GAP }}>
        {shown.map((s) => (
          <NeedCard key={s.id} store={store} sound={s} selected={sel.selected?.kind === 'sound' && sel.selected.id === s.id} playing={store.playing === s.id} plays={playsBy.get(s.id) ?? 0} mine={mineBy.get(s.id) ?? none} presence={presence} fresh={store.agentNew.has(s.id)} last={lastBy.get(s.id)} tick={tick} />
        ))}
      </div>
    </div>
  );
}

/** The newest tape entry that names each sound (who changed it last, and when). */
function useLastEntries(store: Store): Map<string, TapeEntry> {
  return useMemo(() => {
    const known = new Set(store.index.map((x) => x.id));
    const m = new Map<string, TapeEntry>();
    for (const e of store.tape) {
      const t = e.cmd.split(/\s+/);
      for (let i = 1; i < Math.min(t.length, 4); i++) if (known.has(t[i]!)) { m.set(t[i]!, e); break; }
    }
    return m;
    // the tape's length is what moves it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.tape.length, store.index.length]);
}
