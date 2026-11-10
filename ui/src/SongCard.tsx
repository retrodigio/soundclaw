// One song as a card: its numbers and check badge (measured on the server), play and loop buttons, the
// patterns in the order they play with the step sounding now lit, and mute/solo for each channel (for
// listening on this page only: nothing is written), listening feedback (tags and a few words, as a
// request the agent gets through await), and the way into the song's editor.

import { useEffect, useRef, useState } from 'react';
import { SONG_FEEDBACK_TAGS, arrange, channelNotes, formatCell, type SongDoc, type Pattern } from '@soundclaw/core';
import type { Store } from './store.ts';
import { plural } from './studio/values.ts';

interface Report {
  id: string;
  playable: boolean;
  problem?: string;
  pass?: boolean;
  numbers?: { length: number; loopLength: number | null; tempo: number; time: string; key: string | null; lufs: number | null; truePeakDb: number | null; layers: string[]; class: string };
  checks?: { name: string; pass: boolean; advisory: boolean; skipped: boolean; value: string }[];
}

function useReport(store: Store, song: SongDoc, token: string): Report | null {
  const [report, setReport] = useState<Report | null>(null);
  const key = store.songKey(song);
  useEffect(() => {
    let live = true;
    void fetch(`/api/song/${song.id}.json?token=${encodeURIComponent(token)}`)
      .then((r) => (r.ok ? (r.json() as Promise<Report>) : null))
      .then((j) => { if (live) setReport(j); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [key, song.id, token]);
  return report;
}

function PatternGrid({ pattern, active, instance }: { pattern: Pattern; active: number | null; instance: number }) {
  return (
    <div className="pattern" data-testid={`pattern-${pattern.name}-${instance}`} data-active={active ?? ''}>
      <div className="pattern-name">{pattern.name}</div>
      {pattern.channels.map((ch) => (
        <div className="pattern-row" key={ch.name}>
          <span className="pattern-chan">{ch.name}</span>
          {ch.cells.map((c, s) => (
            <span key={s} className={`step${active === s ? ' now' : ''}${c.kind === 'rest' ? ' rest' : c.kind === 'hold' ? ' hold' : ''}${pattern.bar && s > 0 && s % pattern.bar === 0 ? ' bar' : ''}`} data-step={s}>{formatCell(c)}</span>
          ))}
        </div>
      ))}
    </div>
  );
}

const slug = (t: string): string => t.replace(/[^a-z]+/g, '-');

/** Listening feedback on a song: quick tags (too busy, too sparse, too loud, too repetitive, wrong mood, good) and a few words. */
function SongFeedback({ store, song }: { store: Store; song: SongDoc }) {
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const toggle = (t: string) => setTags((xs) => (xs.includes(t) ? xs.filter((x) => x !== t) : [...xs, t]));
  const send = async () => {
    const r = await store.feedback(song.id, tags, note);
    if (r.ok) { setTags([]); setNote(''); setProblem(null); setSent(r.request?.id ?? 'sent'); } else setProblem(r.error ?? 'refused');
  };
  return (
    <div className="feedback" data-testid={`feedback-${song.id}`}>
      <div className="tags">
        {SONG_FEEDBACK_TAGS.map((t) => (
          <button key={t} className={`tag${tags.includes(t) ? ' on' : ''}${t === 'good' ? ' good' : ''}`} aria-pressed={tags.includes(t)} data-testid={`tag-${song.id}-${slug(t)}`} onClick={() => toggle(t)}>{t}</button>
        ))}
      </div>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="A few words, if the tags are not enough (a time helps: 0:12 the bass is muddy)" data-testid={`feedback-text-${song.id}`} />
      <button disabled={!tags.length && !note.trim()} data-testid={`feedback-send-${song.id}`} onClick={() => void send()}>Send feedback</button>
      {sent && <span className="dim" data-testid={`feedback-sent-${song.id}`}>sent ({sent})</span>}
      {problem && <div className="error" data-testid={`feedback-error-${song.id}`}>{problem}</div>}
    </div>
  );
}

export function SongCard({ store, song }: { store: Store; song: SongDoc }) {
  const [feeding, setFeeding] = useState(false);
  const report = useReport(store, song, store.token);
  const [pos, setPos] = useState<{ instance: number; pattern: string; step: number } | null>(null);
  const raf = useRef(0);
  const playing = store.songPlay?.id === song.id;
  useEffect(() => {
    if (!playing) { setPos(null); return; }
    const tick = (): void => {
      const t = store.songClock(song.id);
      const at = t === null ? null : store.songStepAt(song, t);
      setPos((old) => (at && old && old.instance === at.instance && old.step === at.step ? old : at));
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, song, store]);
  let arr: ReturnType<typeof arrange> | null = null;
  try { arr = arrange(song); } catch { arr = null; }
  const g = store.songGroups(song.id);
  const mode = store.songPlay?.mode;
  const busy = store.songBusy === song.id;
  const failing = report?.checks?.filter((c) => !c.pass && !c.advisory && !c.skipped) ?? [];
  const warn = report?.checks?.filter((c) => !c.pass && c.advisory) ?? [];
  const n = report?.numbers;
  const f1 = (v: number | null | undefined): string => (v === null || v === undefined ? '−∞' : v.toFixed(1));
  const notes = song.channels.map((c) => channelNotes(song, arr ?? { instances: [] }, c.name).length);
  return (
    <article className="card song-card" data-testid={`song-${song.id}`} data-status={song.status} data-playing={playing} data-mode={mode ?? ''} data-step={pos?.step ?? ''} data-pattern={pos?.pattern ?? ''} data-instance={pos?.instance ?? ''}>
      <header>
        <h2>{song.id}</h2>
        <span className="chip">song</span>
        {report?.playable && (
          <span className={`chip check-${report.pass ? 'pass' : 'fail'}`} data-testid={`song-check-${song.id}`} data-pass={!!report.pass} data-failing={failing.map((k) => k.name).join(',')} title={report.checks?.map((c) => `${c.name}: ${c.value}`).join('\n')}>
            {report.pass ? '✓ checks pass' : `✗ ${failing.map((k) => k.name).join(', ')}`}
          </span>
        )}
        {warn.length > 0 && <span className="chip tag" data-testid={`song-warn-${song.id}`} title={warn.map((c) => c.value).join('\n')}>{warn.map((c) => c.name).join(', ')}</span>}
        <span className={`chip status-${song.status}`}>{song.status}</span>
      </header>
      <div className="dim analysis" data-testid={`song-numbers-${song.id}`}>
        {song.tempo} bpm · {song.time[0]}/{song.time[1]}{song.key ? ` · ${song.key}` : ''}{arr ? ` · ${arr.total.toFixed(1)} s` : ''}{arr?.loop ? ` · loop ${(arr.loop.end - arr.loop.start).toFixed(1)} s` : ' · no loop'}
        {n ? ` · ${f1(n.lufs)} LUFS · ${f1(n.truePeakDb)} dBTP (${n.class})` : ''}
      </div>
      {report && !report.playable && <div className="error" data-testid={`song-problem-${song.id}`}>{report.problem}</div>}
      <div className="card-actions">
        <button className="play" data-testid={`song-play-${song.id}`} data-plays={store.songsPlayed.filter((p) => p.id === song.id && p.mode === 'full').length} data-playing={playing && mode === 'full'} disabled={busy} onClick={() => void store.playSong(song.id, 'full')}>
          {busy ? 'Rendering…' : playing && mode === 'full' ? '■ Stop' : '▶ Play'}
        </button>
        <button data-testid={`song-loop-${song.id}`} data-plays={store.songsPlayed.filter((p) => p.id === song.id && p.mode === 'loop').length} data-playing={playing && mode === 'loop'} disabled={busy || !arr?.loop} title={arr?.loop ? 'The loop region, repeating' : 'The song has no loop region'} onClick={() => void store.playSong(song.id, 'loop')}>
          {playing && mode === 'loop' ? '■ Stop loop' : '⟲ Loop'}
        </button>
        <a className="button" href={`#/song/${song.id}`} data-testid={`song-edit-${song.id}`}>Edit</a>
        <button data-testid={`song-feedback-${song.id}`} aria-pressed={feeding} onClick={() => setFeeding((f) => !f)}>Feedback</button>
      </div>
      {feeding && <SongFeedback store={store} song={song} />}
      <div className="channels" data-testid={`song-channels-${song.id}`}>
        {song.channels.map((c, i) => (
          <span key={c.name} className={`channel layer-${c.layer}`} data-testid={`song-channel-${song.id}-${c.name}`} data-audible={store.songAudible(song).includes(c.name)}>
            <span className="channel-name" title={`${c.clips ? 'audio' : c.inst ?? 'drum kit'} · layer ${c.layer} · ${plural(notes[i] ?? 0, 'note')}`}>{c.name}</span>
            <button className={`mini${g.mute.has(c.name) ? ' on' : ''}`} aria-pressed={g.mute.has(c.name)} data-testid={`song-mute-${song.id}-${c.name}`} onClick={() => store.toggleSongChannel(song.id, c.name, 'mute')} title="Mute (for listening here; not saved)">M</button>
            <button className={`mini${g.solo.has(c.name) ? ' on' : ''}`} aria-pressed={g.solo.has(c.name)} data-testid={`song-solo-${song.id}-${c.name}`} onClick={() => store.toggleSongChannel(song.id, c.name, 'solo')} title="Solo (for listening here; not saved)">S</button>
          </span>
        ))}
      </div>
      <div className="patterns" data-testid={`song-patterns-${song.id}`} aria-label={`patterns of ${song.id}, read-only`}>
        {(arr?.instances ?? []).filter((i, k, all) => all.findIndex((x) => x.pattern.name === i.pattern.name) === k).map((i) => (
          <PatternGrid key={i.pattern.name} pattern={i.pattern} instance={i.index} active={pos && pos.pattern === i.pattern.name ? pos.step : null} />
        ))}
      </div>
    </article>
  );
}
