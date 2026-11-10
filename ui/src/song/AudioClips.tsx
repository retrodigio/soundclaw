// The audio clips of an audio channel, drawn in the arrangement: a block for each clip with a sketch of its sound, its place from its bar and beat,
// and what is done to it (fitted to the tempo, pitched). A click selects it, a drag moves it along the beats, the arrow keys move it a beat, a sample
// dragged from the library onto the lane places one. Every gesture is one `song clip …` command, the one an agent would write.

import { useEffect, useRef, useState } from 'react';
import { clipSeconds, formatAt, planClip, sampleSeconds, type AudioClip, type Channel, type SampleData, type SongDoc } from '@soundclaw/core';
import type { Store } from '../store.ts';
import { SAMPLE_MIME } from '../studio/Samples.tsx';

const pct = (v: number): string => `${(v * 100).toFixed(3)}%`;
const BARS = 48;

const peakCache = new WeakMap<SampleData, Map<string, number[]>>();
/** The sample's size over `BARS` stretches of the part a clip plays: 0..1 each. */
export function clipPeaks(smp: SampleData, clip: Pick<AudioClip, 'slice'>, fraction: number): number[] {
  let per = peakCache.get(smp);
  if (!per) peakCache.set(smp, (per = new Map()));
  const key = `${clip.slice}|${fraction.toFixed(3)}`;
  const have = per.get(key);
  if (have) return have;
  const n = smp.data.length;
  const pts = smp.slices ?? [];
  const a = clip.slice > 0 && clip.slice <= pts.length ? pts[clip.slice - 1]! : 0;
  const b = clip.slice > 0 && clip.slice <= pts.length ? (clip.slice < pts.length ? pts[clip.slice]! : n) : n;
  const to = Math.max(a + 1, Math.round(a + (b - a) * Math.min(1, Math.max(0, fraction))));
  const out: number[] = [];
  let top = 1e-9;
  for (let k = 0; k < BARS; k++) {
    const from = a + Math.floor(((to - a) * k) / BARS), end = Math.max(from + 1, a + Math.floor(((to - a) * (k + 1)) / BARS));
    let m = 0;
    for (let i = from; i < end && i < n; i++) { const v = Math.abs(smp.data[i]!); if (v > m) m = v; }
    out.push(m);
    if (m > top) top = m;
  }
  const res = out.map((v) => v / top);
  per.set(key, res);
  return res;
}

interface LaneProps {
  store: Store;
  song: SongDoc;
  channel: Channel;
  /** Seconds across the lane. */
  total: number;
  agentClips: Set<string>;
  selected: number | null;
  onSelect(id: number | null): void;
  send(cmds: string[]): void;
}

/** The clips of one audio channel, in the lane's own coordinates (a share of the song's length). */
export function AudioClips({ store, song, channel, total, agentClips, selected, onSelect, send }: LaneProps) {
  const lane = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: number; beats: number } | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const secPerBeat = 60 / song.tempo;
  const bank = store.sampleBank;
  // a block is as long as its recording, and drawn from it: fetch the audio the clips name (a change of the store redraws when it has come)
  const names = [...new Set((channel.clips ?? []).map((k) => k.sample))].sort().join(',');
  useEffect(() => { if (names) void store.ensureSampleNames(names.split(',')); }, [store, names]);

  /** The beat (a whole one) under a pointer, counted from the start of the song. */
  const beatAt = (clientX: number): number => {
    const r = lane.current!.getBoundingClientRect();
    const t = Math.max(0, Math.min(total, ((clientX - r.left) / r.width) * total));
    return Math.max(0, Math.round(t / secPerBeat));
  };

  const down = (e: React.PointerEvent<HTMLDivElement>, k: AudioClip): void => {
    if (e.button !== 0) return;
    onSelect(k.id);
    const x0 = e.clientX;
    const start = k.at;
    let moved = false;
    let beats = start;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent): void => {
      if (!moved && Math.abs(ev.clientX - x0) < 4) return;
      moved = true;
      const r = lane.current!.getBoundingClientRect();
      beats = Math.max(0, Math.round(start + ((ev.clientX - x0) / r.width) * (total / secPerBeat)));
      setDrag({ id: k.id, beats });
    };
    const up = (): void => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setDrag(null);
      if (moved && beats !== start) send([`song clip set ${song.id} ${channel.name} ${k.id} at=${formatAt(beats, song.time)}`]);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const key = (e: React.KeyboardEvent<HTMLDivElement>, k: AudioClip): void => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(k.id); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const to = Math.max(0, k.at + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 4 : 1));
      if (to !== k.at) send([`song clip set ${song.id} ${channel.name} ${k.id} at=${formatAt(to, song.time)}`]);
    }
  };

  const hasSample = (e: React.DragEvent): boolean => [...e.dataTransfer.types].includes(SAMPLE_MIME);

  return (
    <div ref={lane} className={`aclips${over !== null ? ' drop' : ''}`} data-testid={`aclips-${channel.name}`}
      onPointerDown={(e) => { if (e.target === e.currentTarget) onSelect(null); }}
      onDragOver={(e) => { if (hasSample(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(beatAt(e.clientX)); } }}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => {
        setOver(null);
        const name = e.dataTransfer.getData(SAMPLE_MIME);
        if (!name) return;
        e.preventDefault();
        send([`song clip add ${song.id} ${channel.name} ${name} at=${formatAt(beatAt(e.clientX), song.time)}`]);
      }}>
      {(channel.clips ?? []).map((k) => {
        const beats = drag?.id === k.id ? drag.beats : k.at;
        const start = beats * secPerBeat + k.nudge / 1000;
        const smp = bank.get(k.sample);
        const have = sampleSeconds(bank, k);
        const plan = planClip(song, k, have);
        const secs = clipSeconds(song, k, bank);
        const peaks = smp ? clipPeaks(smp, k, have > 0 ? plan.to / have : 1) : [];
        const agent = agentClips.has(`${channel.name}#${k.id}`);
        const fitted = k.stretch === 'tempo' && k.fromTempo ? `${Number(k.fromTempo.toFixed(1))}→${Number(song.tempo.toFixed(1))}` : null;
        const label = `clip ${k.id}: ${k.sample} at ${formatAt(k.at, song.time)}${fitted ? `, fitted from ${k.fromTempo} to ${song.tempo} bpm` : ''}${k.pitch ? `, ${k.pitch > 0 ? '+' : ''}${k.pitch} semitones` : ''}${smp ? '' : ', its audio is not here'}`;
        return (
          <div key={k.id} role="button" tabIndex={0} aria-pressed={selected === k.id} aria-label={label} title={label}
            className={`aclip${selected === k.id ? ' sel' : ''}${agent ? ' agent' : ''}${drag?.id === k.id ? ' dragging' : ''}${smp ? '' : ' missing'}`}
            data-testid={`aclip-${channel.name}-${k.id}`} data-agent={agent || undefined} data-sample={k.sample} data-at={formatAt(k.at, song.time)}
            style={{ left: pct(start / total), width: pct(Math.max(secs, 0.15) / total) }}
            onPointerDown={(e) => down(e, k)} onKeyDown={(e) => key(e, k)}>
            <span className="aclip-name">{agent && <span className="mono" aria-hidden>✦ </span>}{k.sample}{smp ? '' : ' ×'}</span>
            <svg className="aclip-wave" viewBox={`0 0 ${BARS} 20`} preserveAspectRatio="none" aria-hidden>
              {peaks.map((v, i) => <rect key={i} x={i + 0.1} width={0.8} y={10 - v * 9} height={Math.max(0.6, v * 18)} />)}
            </svg>
            {(fitted || k.pitch !== 0) && <span className="mono aclip-badge" data-testid={`aclip-badge-${channel.name}-${k.id}`}>{fitted ? `↔ ${fitted}` : ''}{fitted && k.pitch ? ' ' : ''}{k.pitch ? `${k.pitch > 0 ? '+' : ''}${k.pitch} st` : ''}</span>}
          </div>
        );
      })}
      {over !== null && <span className="aclip-drop" data-testid="aclip-drop-line" style={{ left: pct((over * secPerBeat) / total) }} aria-hidden />}
    </div>
  );
}

// ---- the inspector -----------------------------------------------------------------------------------------------------------------

interface InspectorProps {
  song: SongDoc;
  channel: Channel;
  clip: AudioClip;
  send(cmds: string[]): void;
  onClose(): void;
}

/** The selected clip's settings: each field writes one `song clip set` when it is left. */
export function ClipInspector({ song, channel, clip, send, onClose }: InspectorProps) {
  const set = (what: string): void => send([`song clip set ${song.id} ${channel.name} ${clip.id} ${what}`]);
  const barsOf = (beats: number): string => String(Math.round((beats / (song.time[0] * (4 / song.time[1]))) * 1e6) / 1e6);
  const field = (key: string, label: string, shown: string, commit: (v: string) => void, title: string, width = 64) => (
    <label className="aci-field" title={title}>
      <span className="cap">{label}</span>
      <input type="text" className="txt" style={{ width }} data-testid={`aclip-field-${key}`} defaultValue={shown} key={`${clip.id}-${key}-${shown}`} spellCheck={false} autoComplete="off"
        onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== shown) commit(v); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); else if (e.key === 'Escape') { (e.target as HTMLInputElement).value = shown; (e.target as HTMLInputElement).blur(); } }} />
    </label>
  );
  return (
    <div className="aclip-inspector" data-testid="aclip-inspector" data-clip={clip.id} role="group" aria-label={`Clip ${clip.id}: ${clip.sample}`}>
      <span className="aci-title"><b>{clip.sample}</b> <span className="dim mono">clip {clip.id} · {channel.name}</span></span>
      {field('at', 'at', formatAt(clip.at, song.time), (v) => set(`at=${v}`), 'bar.beat; bars and beats count from 1')}
      {field('len', 'len', clip.len === null ? 'full' : barsOf(clip.len), (v) => set(`len=${v}`), 'bars it plays (0.5 is half a bar), or full')}
      {field('gain', 'gain', String(clip.gain), (v) => set(`gain=${v}`), 'level, 0 to 4')}
      {field('pitch', 'pitch', String(clip.pitch), (v) => set(`pitch=${v}`), 'semitones; with the tempo fit the length is kept')}
      {field('fade', 'fade', String(clip.fade), (v) => set(`fade=${v}`), 'seconds faded in and out')}
      {field('nudge', 'nudge', String(clip.nudge), (v) => set(`nudge=${v}`), 'milliseconds off the grid')}
      <label className="aci-field aci-check" title="fit the recording to the song's tempo, its pitch kept">
        <input type="checkbox" data-testid="aclip-field-stretch" checked={clip.stretch === 'tempo'} onChange={(e) => set(e.target.checked ? 'stretch=tempo' : 'stretch=none')} />
        <span>fit to tempo</span>
      </label>
      {clip.stretch === 'tempo' && field('from-tempo', 'made at', String(clip.fromTempo ?? ''), (v) => set(`from-tempo=${v}`), 'the tempo (bpm) the recording was made at', 56)}
      {clip.stretch === 'tempo' && (
        <label className="aci-field" title="wsola for hits and voices, pv for tones and pads">
          <span className="cap">method</span>
          <select className="sel" data-testid="aclip-field-method" value={clip.method} onChange={(e) => set(`method=${e.target.value}`)}><option value="wsola">wsola</option><option value="pv">pv</option></select>
        </label>
      )}
      <span className="spacer" />
      <button type="button" className="mini" data-testid="aclip-remove" onClick={() => { send([`song clip remove ${song.id} ${channel.name} ${clip.id}`]); onClose(); }}>Remove</button>
      <button type="button" className="mini" data-testid="aclip-close" onClick={onClose} aria-label="Close the clip's settings">Done</button>
    </div>
  );
}
