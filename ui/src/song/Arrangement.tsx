// The song's arrangement: the tracks (a row per channel, grouped by game layer) on a bar ruler with
// the sections as markers, the loop region with handles and the seam badge, a clip for each
// placement of a pattern with a sketch of its notes (violet and dashed while the agent's change is
// not approved), the check flags drawn on the lanes and bars they name, and a send-bus row. A drag
// on the ruler selects bars; a click puts the cursor there.

import { useRef, useState } from 'react';
import type { Arrangement as Arr, SongDoc } from '@soundclaw/core';
import type { Store } from '../store.ts';
import { Badge } from '../studio/controls.tsx';
import { Playhead, type NowRef } from './hooks.tsx';
import { AudioClips } from './AudioClips.tsx';
import {
  barSeconds, channelColour, clipsOf, flaggedChecks, laneFlags, layersAt, sectionSpans, seamOf, trackGroups,
  type Clip, type LaneFlag, type PatternAuthors, type SongReport,
} from './model.ts';

export interface BarSel { from: number; to: number }

interface Props {
  store: Store;
  song: SongDoc;
  arr: Arr | null;
  report: SongReport | null;
  authors: PatternAuthors;
  /** The audio clips the agent placed or changed and nobody approved (`channel#number`). */
  agentClips: Set<string>;
  /** The audio clip selected (its settings are shown under the arrangement), if any. */
  aclip: { ch: string; id: number } | null;
  onAclip(c: { ch: string; id: number } | null): void;
  channel: string | null;
  pattern: string | null;
  intensity: number | null;
  onChannel(c: string): void;
  onClip(c: Clip): void;
  cursor: number | null;
  onCursor(t: number): void;
  nowRef: NowRef;
  playing: boolean;
  bars: BarSel | null;
  onBars(b: BarSel | null): void;
  flag: string | null;
  onFlag(f: LaneFlag | null): void;
  send(cmds: string[]): void;
}

const pct = (v: number): string => `${(v * 100).toFixed(3)}%`;

function Sketch({ clip }: { clip: Clip }) {
  return (
    <svg className="clip-sketch" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden>
      {clip.notes.map((n, i) => <rect key={i} x={n.x * 100} y={2 + n.y * 14} width={Math.max(0.8, n.w * 100)} height={2.6} />)}
    </svg>
  );
}

export function Arrangement({ store, song, arr, report, authors, agentClips, aclip, onAclip, channel, pattern, intensity, onChannel, onClip, cursor, onCursor, nowRef, playing, bars, onBars, flag, onFlag, send }: Props) {
  const total = Math.max(arr?.total ?? 1, 0.001);
  const barSec = barSeconds(song);
  const nBars = Math.max(1, Math.floor(total / barSec + 1e-6));
  const groups = trackGroups(song);
  const spans = arr ? sectionSpans(song, arr) : [];
  const body = spans.filter((s) => s.part === 'body');
  const flags = laneFlags(report, barSec, nBars);
  const seam = seamOf(report);
  const flagged = flaggedChecks(report);
  const heard = layersAt(song, intensity);
  const g = store.songGroups(song.id);
  const rail = useRef<HTMLDivElement>(null);
  const tOf = (e: { clientX: number }): number => { const r = rail.current!.getBoundingClientRect(); return Math.max(0, Math.min(total, ((e.clientX - r.left) / r.width) * total)); };
  const barOf = (t: number): number => Math.max(0, Math.min(nBars - 1, Math.floor(t / barSec + 1e-6)));

  // the ruler: a drag selects bars, a click puts the cursor
  const sel = useRef<{ x: number; t: number; moved: boolean } | null>(null);
  const rulerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('.loop-band, .seam-badge')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    sel.current = { x: e.clientX, t: tOf(e), moved: false };
  };
  const rulerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const s = sel.current;
    if (!s) return;
    if (!s.moved && Math.abs(e.clientX - s.x) < 4) return;
    s.moved = true;
    const a = barOf(s.t), b = barOf(tOf(e));
    onBars({ from: Math.min(a, b), to: Math.max(a, b) });
  };
  const rulerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const s = sel.current;
    sel.current = null;
    if (s && !s.moved) { onBars(null); onCursor(tOf(e)); }
  };

  // the loop region: its ends and the band as a whole snap to the sections' edges
  const [loopDrag, setLoopDrag] = useState<{ which: 'from' | 'to' | 'both'; t0: number; from: number; to: number } | null>(null);
  const bodyIndex = (name: string | undefined): number => body.findIndex((b) => b.name === name);
  const loopFrom = arr?.loop ? (song.loop && typeof song.loop === 'object' ? bodyIndex(song.loop.from) : 0) : -1;
  const loopTo = arr?.loop ? (song.loop && typeof song.loop === 'object' ? bodyIndex(song.loop.to) : body.length - 1) : -1;
  const lf = loopDrag ? loopDrag.from : loopFrom, lt = loopDrag ? loopDrag.to : loopTo;
  const nearest = (t: number, ends: boolean): number => {
    let best = 0, bd = Infinity;
    body.forEach((b, i) => { const d = Math.abs((ends ? b.end : b.start) - t); if (d < bd) { bd = d; best = i; } });
    return best;
  };

  const flagSel = flags.find((f) => f.id === flag) ?? null;
  // a pair of channels masking each other many times gets one label, on its longest stretch; the other stretches are boxes with a tooltip
  const labelled = new Set<string>();
  const longest = new Map<string, LaneFlag>();
  for (const f of flags) {
    if (f.kind !== 'masking') { labelled.add(f.id); continue; }
    const k = [...f.lanes].sort().join('|');
    const cur = longest.get(k);
    if (!cur || f.to - f.from > cur.to - cur.from) longest.set(k, f);
  }
  for (const f of longest.values()) labelled.add(f.id);
  const lane = (ch: string, h: number) => {
    const mine = flags.filter((f) => f.lanes.includes(ch));
    const color = channelColour(song, ch);
    const row = clipsOf(arr ?? { instances: [], total: 0, loop: null }, ch);
    const c = song.channels.find((x) => x.name === ch)!;
    const silent = !heard.has(c.layer);
    return (
      <div className={`arr-time arr-lane${c.clips ? ' audio' : ''}`} style={{ height: h, ['--clip' as string]: color }} data-silent={silent || undefined}>
        {c.clips && <AudioClips store={store} song={song} channel={c} total={total} agentClips={agentClips} selected={aclip?.ch === ch ? aclip.id : null} onSelect={(id) => onAclip(id === null ? null : { ch, id })} send={send} />}
        {row.map((cl) => {
          const agent = authors.rows.has(`${cl.pattern}/${ch}`);
          const here = pattern === cl.pattern && channel === ch;
          return (
            <div key={cl.key} role="button" tabIndex={0} className={`arr-clip${agent ? ' agent' : ''}${here ? ' current' : ''}`} data-testid={`clip-${ch}-${cl.instance}`} data-agent={agent} data-pattern={cl.pattern}
              style={{ left: pct(cl.t0 / total), width: pct(cl.dur / total) }}
              title={`${cl.pattern} · ${cl.section}${agent ? ' · written by the agent, not approved yet' : ''}`}
              onClick={() => onClip(cl)} onKeyDown={(e) => { if (e.key === 'Enter') onClip(cl); }}>
              <span className="clip-name">{agent && <span className="mono" aria-hidden>✦ </span>}{cl.pattern}</span>
              <Sketch clip={cl} />
            </div>
          );
        })}
        {mine.map((f) => (
          <div key={f.id} className={`arr-flag${flag === f.id ? ' sel' : ''}`} data-kind={f.kind} data-testid={`flag-${f.id}-${ch}`} title={f.note} style={{ left: pct(f.from / total), width: pct(Math.max(Math.min(f.to, total) - f.from, barSec / 4) / total) }}>
            {f.lanes[0] === ch && labelled.has(f.id) && (
              <button type="button" className="arr-flag-label" data-testid={`flag-label-${f.id}`} title={f.note} onClick={(e) => { e.stopPropagation(); onFlag(flag === f.id ? null : f); }}>
                <span className="mono" aria-hidden>!</span> {f.label}
              </button>
            )}
          </div>
        ))}
        {bars && <span className="arr-barsel" style={{ left: pct((bars.from * barSec) / total), width: pct(((bars.to - bars.from + 1) * barSec) / total) }} aria-hidden />}
      </div>
    );
  };

  const buses = (['reverb', 'delay', 'convolve'] as const).filter((k) => song[k]);
  const audioName = (): string => { let n = 1; while (song.channels.some((x) => x.name === (n === 1 ? 'audio' : `audio${n}`))) n++; return n === 1 ? 'audio' : `audio${n}`; };
  return (
    <section className="arr" data-testid="arrangement" data-ask-surface aria-label="Arrangement" style={{ ['--nbars' as string]: nBars }}>
      <div className="arr-row arr-rulerrow">
        <div className="arr-head arr-corner">
          <span className="cap">Arrangement</span><span className="spacer" />
          {flagged.length > 0 && <span data-testid="arr-checks"><Badge kind="warn">{` ${flagged.length} check${flagged.length === 1 ? '' : 's'}`}</Badge></span>}
        </div>
        <div className="arr-time arr-ruler" ref={rail} data-testid="bar-ruler" onPointerDown={rulerDown} onPointerMove={rulerMove} onPointerUp={rulerUp} onPointerCancel={() => { sel.current = null; }}>
          <div className="arr-markers">
            {spans.map((s) => (
              <div key={s.name} className={`arr-marker part-${s.part}`} data-testid={`marker-${s.name}`} data-part={s.part} style={{ left: pct(s.start / total), width: pct((s.end - s.start) / total) }}>
                {s.name}{s.repeat > 1 ? ` ×${s.repeat}` : ''}{s.part !== 'body' ? ` · ${s.part}` : ''}
              </div>
            ))}
          </div>
          {lf >= 0 && lt >= 0 && body[lf] && body[lt] && (
            <div className="loop-band" data-testid="loop-band" data-from={body[lf]!.name} data-to={body[lt]!.name}
              style={{ left: pct(body[lf]!.start / total), width: pct((body[lt]!.end - body[lf]!.start) / total) }}
              onPointerDown={(e) => {
                const t = e.target as HTMLElement;
                const which = t.dataset.handle === 'from' ? 'from' : t.dataset.handle === 'to' ? 'to' : 'both';
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                setLoopDrag({ which, t0: tOf(e), from: loopFrom, to: loopTo });
              }}
              onPointerMove={(e) => {
                if (!loopDrag) return;
                const t = tOf(e);
                if (loopDrag.which === 'from') setLoopDrag({ ...loopDrag, from: Math.min(nearest(t, false), loopDrag.to) });
                else if (loopDrag.which === 'to') setLoopDrag({ ...loopDrag, to: Math.max(nearest(t, true), loopDrag.from) });
                else {
                  const span = loopTo - loopFrom;
                  const from = Math.max(0, Math.min(body.length - 1 - span, nearest(body[loopFrom]!.start + (t - loopDrag.t0), false)));
                  setLoopDrag({ ...loopDrag, from, to: from + span });
                }
              }}
              onPointerUp={() => {
                const d = loopDrag;
                setLoopDrag(null);
                if (d && (d.from !== loopFrom || d.to !== loopTo)) send([`song loop ${song.id} ${body[d.from]!.name}..${body[d.to]!.name}`]);
              }}>
              <span className="loop-handle from" data-handle="from" data-testid="loop-from" />
              <span className="loop-label">loop</span>
              <span className="loop-handle to" data-handle="to" data-testid="loop-to" />
            </div>
          )}
          {seam && arr?.loop && (
            <span className="seam-badge mono" data-testid="seam-badge" data-pass={seam.pass} style={{ left: pct(arr.loop.end / total) }} title="the loop's seam: no click, and no step in level from the end back to the start">
              {seam.pass ? '✓' : '×'} {seam.text}
            </span>
          )}
          {bars && <span className="arr-barsel top" data-testid="bar-selection" data-from={bars.from + 1} data-to={bars.to + 1} style={{ left: pct((bars.from * barSec) / total), width: pct(((bars.to - bars.from + 1) * barSec) / total) }}><span className="mono">bars {bars.from + 1}{bars.to > bars.from ? `–${bars.to + 1}` : ''}</span></span>}
          <div className="arr-bars mono">
            {Array.from({ length: nBars }, (_, b) => {
              const every = Math.max(1, Math.ceil(nBars / 24));
              return <span key={b} style={{ left: pct((b * barSec) / total), width: pct(barSec / total) }}>{b % every === 0 ? b + 1 : ''}</span>;
            })}
          </div>
        </div>
      </div>
      {groups.map((grp, gi) => (
        <div key={grp.layer} className="arr-group" data-layer={grp.layer} data-muted={!heard.has(grp.layer) || undefined}>
          {grp.channels.map((c, ci) => {
            const picked = channel === c.name;
            const pending = [...authors.rows].some((k) => k.endsWith(`/${c.name}`));
            return (
              <div key={c.name} className={`arr-row arr-track${picked ? ' picked' : ''}${ci === 0 && gi > 0 ? ' group-start' : ''}`} data-testid={`track-${c.name}`} data-layer={c.layer}>
                <div className="arr-head" style={{ borderLeftColor: channelColour(song, c.name) }} onClick={() => onChannel(c.name)}>
                  <button type="button" className="arr-name" data-testid={`track-name-${c.name}`} onClick={(e) => { e.stopPropagation(); onChannel(c.name); }} aria-pressed={picked}>{c.name}</button>
                  {pending && <span className="mono arr-agent" title="the agent changed this channel; not approved yet" aria-label="changed by the agent">✦</span>}
                  <span className="mono arr-stem" title={heard.has(c.layer) ? `layer ${c.layer}` : `layer ${c.layer}: not playing at this intensity`}>{c.layer}</span>
                  <button type="button" className={`sm s${g.solo.has(c.name) ? ' on' : ''}`} aria-pressed={g.solo.has(c.name)} aria-label={`Solo ${c.name}`} data-testid={`track-solo-${c.name}`} onClick={(e) => { e.stopPropagation(); store.toggleSongChannel(song.id, c.name, 'solo'); }}>S</button>
                  <button type="button" className={`sm m${g.mute.has(c.name) ? ' on' : ''}`} aria-pressed={g.mute.has(c.name)} aria-label={`Mute ${c.name}`} data-testid={`track-mute-${c.name}`} onClick={(e) => { e.stopPropagation(); store.toggleSongChannel(song.id, c.name, 'mute'); }}>M</button>
                </div>
                {lane(c.name, 34)}
              </div>
            );
          })}
        </div>
      ))}
      <div className="arr-row arr-sends" data-testid="track-sends">
        <div className="arr-head"><span className="arr-name dim">sends</span>{buses.length === 0 && <span className="dim small">none set up</span>}</div>
        <div className="arr-time arr-lane" style={{ height: 28 }}>
          <span className="arr-buses">{buses.map((k) => <span key={k} className="chip tag mono" data-testid={`bus-${k}`}>{k}</span>)}<span className="spacer" /><button type="button" className="mini" data-testid="add-audio-channel" title="Add a channel that plays recordings: then drop a sample from the library on its lane" onClick={() => send([`song channel add ${song.id} ${audioName()} audio`])}>+ audio channel</button></span>
        </div>
      </div>
      <div className="arr-overlay" aria-hidden>
        <Playhead nowRef={nowRef} cursor={cursor} total={total} playing={playing} />
        {flagSel && <span className="arr-flagline" style={{ left: pct(flagSel.from / total) }} />}
      </div>
    </section>
  );
}
