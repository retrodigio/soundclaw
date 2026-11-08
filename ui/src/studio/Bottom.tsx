// The bottom panel: Detail (the selected sound's waveform with check markers and its numbers),
// Mixer (the focused song's channels, or the sound's level and loudness) and History (the tape,
// filtered to the focused item).

import { useEffect, useMemo, useState } from 'react';
import { TIMED_CHECKS, activeGroups, type Sound, type TapeEntry } from '@soundclaw/core';
import { useCard } from '../CardImages.tsx';
import type { Measured, Store } from '../store.ts';
import { Badge, LoudnessTarget, Tabs, type CheckKind } from './controls.tsx';
import { WaveView, type WaveMarker } from './layout.tsx';
import { setPanels, usePrefs, type PanelPrefs } from './prefs.ts';
import { checkOf, lufsText, MINUS, type Focus } from './shellData.ts';
import { Mixer, MeterModeToggle } from '../song/Mixer.tsx';
import { useSongReport } from '../song/hooks.tsx';

const num = (v: number | null | undefined, digits: number, unit: string): string => (v === null || v === undefined || !Number.isFinite(v) ? `${MINUS}∞` : `${v.toFixed(digits).replace('-', MINUS)} ${unit}`);

function Numbers({ rows }: { rows: { k: string; v: string; kind?: CheckKind }[] }) {
  return (
    <div className="nums" data-testid="detail-numbers">
      {rows.map((r) => (
        <div key={r.k} className="num-row"><span>{r.k}</span><span className="mono" data-kind={r.kind}>{r.kind && r.kind !== 'pass' && <span aria-hidden>{r.kind === 'fail' ? '× ' : r.kind === 'warn' ? '! ' : '… '}</span>}{r.v}</span></div>
      ))}
    </div>
  );
}

function SoundDetail({ store, id }: { store: Store; id: string }) {
  const sum = store.summary(id);
  const { ref, card } = useCard(store, id, sum?.key ?? '');
  const [doc, setDoc] = useState<Sound | undefined>(undefined);
  const [measured, setMeasured] = useState<Measured | null>(null);
  // the numbers come from a measurement of the document once the selection has been still for a moment, and only for short sounds
  useEffect(() => {
    setDoc(undefined);
    setMeasured(null);
    let live = true;
    const t = setTimeout(() => {
      void store.docNow(id).then((d) => {
        if (!live || !d) return;
        setDoc(d);
        const dur = store.summary(id)?.info?.duration ?? store.cardOf(id)?.duration ?? 0;
        if (dur > 0 && dur <= 2.5) {
          try { const m = store.measure(d); if (!m.pending) setMeasured(m); } catch { /* the card's numbers stand */ }
        }
      });
    }, 180);
    return () => { live = false; clearTimeout(t); };
  }, [store, id, sum?.key]);
  if (!sum) return <p className="dim pad">No such sound.</p>;
  const info = sum.info ?? card;
  const a = measured?.analysis;
  const rule = doc ? store.rule(doc) : null;
  const markers: WaveMarker[] = measured ? measured.checks.filter((c) => !c.pass && TIMED_CHECKS.includes(c.name)).flatMap((c) => (c.ranges.length ? c.ranges.map((r) => ({ t: r.from, end: r.to > r.from ? r.to : undefined, kind: 'fail' as const, label: `${c.name} ${r.from.toFixed(3)} s` })) : [])) : [];
  const failing = info?.failing ?? [];
  const k = checkOf(sum);
  const duration = info?.duration ?? a?.duration ?? 0;
  const seed = doc && doc.voice === 'classic' && doc.patch.seed !== undefined ? ` · seed ${doc.patch.seed}` : '';
  return (
    <div className="detail" data-testid="detail" data-sound={id}>
      <div className="detail-wave" ref={ref}>
        <div className="detail-title"><b>{id}</b><span className="mono dim">{sum.voice}{seed} {'·'} {duration ? `${duration.toFixed(2)} s` : '…'}</span>
          <Badge kind={k}>{k === 'fail' ? failing.join(', ') : k === 'pass' ? 'checks' : 'checking'}</Badge>
        </div>
        <WaveView wave={card?.wave} duration={duration} markers={markers} height={110} label={`Waveform of ${id}`} testId="detail-wave" />
      </div>
      <Numbers rows={[
        { k: 'Integrated', v: num(a?.lufs ?? info?.lufs, 1, 'LUFS'), kind: failing.includes('loudness') ? 'fail' : undefined },
        { k: 'Target', v: rule ? `${rule.target.toFixed(0).replace('-', MINUS)} ±${rule.tolerance}` : '—' },
        { k: 'True peak', v: num(a?.truePeakDb ?? info?.truePeakDb, 1, 'dBTP'), kind: failing.includes('clip') ? 'fail' : undefined },
        { k: 'Crest', v: a ? num(a.crestDb, 1, 'dB') : '…' },
        { k: 'Attack', v: a ? `${Math.round(a.attack * 1000)} ms` : '…' },
        { k: 'Tail −60', v: a ? `${a.tail.toFixed(2)} s` : '…', kind: failing.includes('tail') ? 'fail' : undefined },
        { k: 'Centroid', v: a ? (a.centroid.mean >= 1000 ? `${(a.centroid.mean / 1000).toFixed(1)} kHz` : `${Math.round(a.centroid.mean)} Hz`) : '…', kind: failing.includes('harsh') ? 'fail' : undefined },
        { k: 'Onsets', v: a ? String(a.onsets) : '…' },
      ]} />
    </div>
  );
}

function SongDetail({ store, id }: { store: Store; id: string }) {
  const song = store.songs.find((x) => x.id === id);
  if (!song) return <p className="dim pad">No such song.</p>;
  return (
    <div className="detail" data-testid="detail" data-song={id}>
      <div className="detail-wave">
        <div className="detail-title"><b>{id}</b><span className="mono dim">{song.tempo} BPM {'·'} {song.time[0]}/{song.time[1]}{song.key ? ` · ${song.key}` : ''}</span></div>
        <p className="dim small">{song.channels.length} channels {'·'} {song.sections.length} sections {'·'} {song.patterns.size} patterns</p>
      </div>
      <Numbers rows={[{ k: 'Tempo', v: `${song.tempo} BPM` }, { k: 'Time', v: `${song.time[0]}/${song.time[1]}` }, { k: 'Key', v: song.key ?? '—' }, { k: 'Gain', v: num(song.gain, 1, 'dB') }, { k: 'Status', v: song.status }]} />
    </div>
  );
}

/** The focused song's mixer, small: a fader and meter for each channel, the buses and the master. */
function SongMixer({ store, id }: { store: Store; id: string }) {
  const song = store.songs.find((x) => x.id === id);
  const report = useSongReport(store, song);
  if (!song) return <p className="dim pad">No such song.</p>;
  return (
    <div className="mixer-bottom" data-testid="mixer-lite" data-song={id}>
      <div className="mixer-bottom-head"><MeterModeToggle store={store} /><a className="link-btn small" href={`#/song/${id}/mixer`} data-testid="open-mixer">Open the full mixer</a></div>
      <Mixer store={store} song={song} report={report} intensity={store.songIntensity.get(id) ?? null} compact />
    </div>
  );
}

function MixerTab({ store, focus }: { store: Store; focus: Focus | null }) {
  if (focus?.kind === 'song') return <SongMixer store={store} id={focus.id} />;
  if (focus?.kind === 'sound') {
    const sum = store.summary(focus.id);
    const doc = store.doc(focus.id);
    const rule = doc ? store.rule(doc) : null;
    return (
      <div className="mixer-lite" data-testid="mixer-lite">
        <LoudnessTarget value={sum?.info ? sum.info.lufs : null} target={rule?.target ?? store.style.loudnessTarget} tolerance={rule?.tolerance ?? store.style.loudnessTolerance} label={focus.id} />
        <p className="mono dim small">true peak {num(sum?.info?.truePeakDb, 1, 'dBTP')}</p>
      </div>
    );
  }
  return <p className="dim pad">Select a sound or a song to see its level and loudness.</p>;
}

const HISTORY_ROWS = 200;

/** The ids a tape entry names are matched as words (a song's `demo` also finds `demo_lead`), so `beep` does not pick up `beeper`. */
function mentions(cmd: string, id: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9-])`).test(cmd);
}

export function History({ store, focus }: { store: Store; focus: Focus | null }) {
  const [limit, setLimit] = useState(HISTORY_ROWS);
  const tape = store.tape;
  const active = useMemo(() => activeGroups(tape), [tape]);
  const filtered: TapeEntry[] = useMemo(() => {
    if (!focus) return tape;
    // an undo or redo names the group it reverses, not the item, so they stay
    return tape.filter((e) => mentions(e.cmd, focus.id) || /^(undo|redo)\b/.test(e.cmd));
  }, [tape, focus]);
  const rows = useMemo(() => filtered.slice(-limit).reverse(), [filtered, limit]);
  const earlier = focus ? 0 : store.tapeTotal - rows.length;
  return (
    <section className="history" data-testid="history" aria-label="History">
      <h2>History <span className="dim">({focus ? `${filtered.length} for ${focus.id}` : `${store.tapeTotal} commands`})</span>{focus && <span className="dim small"> {'·'} the focused item</span>}</h2>
      {rows.length === 0 && <p className="dim">{focus ? `Nothing on ${focus.id} yet.` : 'Nothing yet. Commands the agent and people run appear here.'}</p>}
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

export function BottomPanel({ store, focus }: { store: Store; focus: Focus | null }) {
  const { panels } = usePrefs();
  const tab = panels.bottomTab;
  const f = focus && focus.kind !== 'set' ? focus : null;
  return (
    <div className="bottom-in" data-testid="bottom-panel">
      <div className="bottom-head">
        <Tabs<PanelPrefs['bottomTab']> label="Bottom panel" value={tab} onChange={(v) => setPanels({ bottomTab: v })} testId="bottom-tabs"
          tabs={[{ value: 'detail', label: 'Detail', testId: 'bottom-tab-detail' }, { value: 'mixer', label: 'Mixer', testId: 'bottom-tab-mixer' }, { value: 'history', label: 'History', testId: 'bottom-tab-history' }]} />
        <span className="grow" />
        <span className="hint">{'⌥'}4 toggles {'·'} drag the edge to resize</span>
      </div>
      <div className="bottom-body" role="tabpanel">
        {tab === 'detail' && (f ? (f.kind === 'sound' ? <SoundDetail store={store} id={f.id} /> : <SongDetail store={store} id={f.id} />) : <p className="dim pad" data-testid="detail-empty">Select a sound in the library to see its waveform and numbers.</p>)}
        {tab === 'mixer' && <MixerTab store={store} focus={f} />}
        {tab === 'history' && <History store={store} focus={focus && focus.kind !== 'set' ? focus : null} />}
      </div>
    </div>
  );
}

export { lufsText };
