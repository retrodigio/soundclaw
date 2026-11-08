// The mixer: a strip for every channel (inserts, pan, a send knob for each bus, a fader with a stereo
// meter, the gain, the channel's own loudness, M and S), then the send buses, then the master with
// its limiter and a vertical loudness target. Every edit is a song command written once when a
// drag ends. The meters are fed by a worker about thirty times a second and drawn every animation
// frame: nothing here re-renders at meter rate. A masking lane links the strips that clash.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { FX_SPECS, arrange, type Arrangement, type Channel, type Fx, type SongDoc } from '@soundclaw/core';
import type { Store } from '../store.ts';
import { Badge, Fader, Knob, LoudnessTarget, Segmented } from '../studio/controls.tsx';
import { Meter } from '../studio/controls.tsx';
import type { ValueSpec } from '../studio/values.ts';
import { barsOf, channelColour, layersAt, maskLinks, paramTrails, trackGroups, type MaskLink, type ParamTrail, type SongReport } from './model.ts';

const MINUS = '−';

/** Pan as a person reads it: C, L15, R25 (percent to the side). */
export const PAN_SPEC: ValueSpec = {
  unit: 'plain',
  custom: {
    show: (v) => (Math.abs(v) < 0.005 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`),
    read: (t) => {
      const s = t.trim().toLowerCase();
      if (s === 'c' || s === 'centre' || s === 'center') return 0;
      const m = /^([lr])\s*(\d+(?:\.\d+)?)%?$/.exec(s);
      if (m) return (m[1] === 'l' ? -1 : 1) * Math.min(100, Number(m[2])) / 100;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    },
    entry: (v) => (Math.abs(v) < 0.005 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`),
    hint: 'C, L15, R25',
  },
};
const PCT: ValueSpec = { unit: 'pct' };

export const gainToDb = (g: number): number => (g > 0.001 ? Math.max(-60, Math.min(6, 20 * Math.log10(g))) : -60);
export const dbToGain = (db: number): number => (db <= -59.5 ? 0 : Number((10 ** (db / 20)).toFixed(3)));

/** Does the channel play anything in the stretch the mixer is about (the loop region, else the song), at this intensity? */
export function soundsHere(song: SongDoc, arr: Arrangement | null, ch: Channel, intensity: number | null): boolean {
  if (!layersAt(song, intensity).has(ch.layer)) return false;
  if (!arr) return true;
  return arr.instances.some((i) => (arr.loop ? i.inLoop : true) && (i.pattern.channels.find((c) => c.name === ch.name)?.cells.some((c) => c.kind !== 'rest' && c.kind !== 'hold') ?? false));
}

/** A text the frame loop does not own: it is rewritten ten times a second straight into the DOM. */
export function LiveText({ read, fmt, testId, className }: { read: () => number | null; fmt(v: number | null): string; testId?: string; className?: string }) {
  const el = useRef<HTMLSpanElement>(null);
  const latest = useRef({ read, fmt });
  latest.current = { read, fmt };
  useEffect(() => {
    const id = setInterval(() => { if (el.current) el.current.textContent = latest.current.fmt(latest.current.read()); }, 100);
    return () => clearInterval(id);
  }, []);
  return <span ref={el} className={className} data-testid={testId}>{fmt(null)}</span>;
}

interface Props {
  store: Store;
  song: SongDoc;
  report: SongReport | null;
  intensity: number | null;
  /** The bottom panel's version: faders, meters and M/S only. */
  compact?: boolean;
  /** Open the instrument panel (the page's inspector) for a channel. */
  onInserts?(channel: string): void;
}

const fxChip = (f: Fx): string => {
  const sp = FX_SPECS[f.kind].find((s) => !s.choices && !s.text && s.name !== 'mix');
  const v = sp ? f.p[sp.name] : undefined;
  return `${f.kind}${typeof v === 'number' ? ` ${Number(v.toFixed(2))}${sp!.unit ? ` ${sp!.unit}` : ''}` : ''}`;
};

export function Mixer({ store, song, report, intensity, compact, onInserts }: Props) {
  const hub = store.meters;
  const root = useRef<HTMLElement>(null);
  const renders = useRef(0);
  renders.current++;
  useEffect(() => { root.current?.setAttribute('data-renders', String(renders.current)); });
  // the mixer is showing: the worker is sent audio while it is
  useEffect(() => { hub.want(1); return () => hub.want(-1); }, [hub]);
  const mode = useSyncExternalStore(hub.subscribe, () => hub.mode);
  const tooBig = useSyncExternalStore(hub.subscribe, () => hub.tooBig);

  let arr: Arrangement | null = null;
  try { arr = arrange(song); } catch { arr = null; }
  const send = (cmd: string): void => void store.run(cmd);
  const trails = useMemo(() => paramTrails(store.tape, song.id), [store.tape, song.id]);
  const g = store.songGroups(song.id);
  const heard = layersAt(song, intensity);
  const order = trackGroups(song).flatMap((x) => x.channels);
  const numbers = report?.numbers;
  const links = maskLinks(report);
  const masking = report?.checks?.find((c) => c.name === 'masking');
  const buses = (['reverb', 'delay'] as const).filter((k) => song[k]);
  const sends = buses;
  const agent = (key: string): { prev?: number } | false => { const t = trails.get(key); return t ? (t.prev === null ? {} : { prev: t.prev }) : false; };
  const stripCls = (name: string, extra = ''): string => `mx-strip${g.solo.has(name) ? ' solo' : ''}${g.mute.has(name) ? ' mute' : ''}${extra}`;
  const toggle = (ch: Channel, kind: 'mute' | 'solo', whole: boolean): void => {
    if (!whole) { store.toggleSongChannel(song.id, ch.name, kind); return; }
    // ⌥-click acts on the whole stem: all on if any is off, else all off
    const set = kind === 'mute' ? g.mute : g.solo;
    const same = song.channels.filter((c) => c.layer === ch.layer);
    const allOn = same.every((c) => set.has(c.name));
    for (const c of same) if (allOn === set.has(c.name)) store.toggleSongChannel(song.id, c.name, kind);
  };

  // where each strip is, for the masking links drawn above them
  const strips = useRef<HTMLDivElement>(null);
  const [centres, setCentres] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    const el = strips.current;
    if (!el || compact) return;
    const measure = (): void => {
      const box = el.getBoundingClientRect();
      const next: Record<string, number> = {};
      el.querySelectorAll<HTMLElement>('[data-strip]').forEach((s) => { const r = s.getBoundingClientRect(); next[s.dataset.strip!] = r.left - box.left + el.scrollLeft + r.width / 2; });
      setCentres((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [compact, order.length, buses.length]);

  const channelStrip = (c: Channel) => {
    const silent = !soundsHere(song, arr, c, intensity);
    const rep = numbers?.channels?.find((x) => x.name === c.name);
    const lufs = rep && rep.lufs !== null && Number.isFinite(rep.lufs) && rep.notes > 0 ? rep.lufs : null;
    const own = c.inst ? store.lookupInstrument(c.inst) : undefined;
    const inserts: string[] = own ? [...new Set(own.voice.layers.flatMap((l) => l.fx.map(fxChip)))] : [];
    const rows = [...(c.inst ? [c.inst] : [`kit${c.kit && Object.keys(c.kit).length ? '' : ' default'}`]), ...inserts];
    const dbNow = gainToDb(c.gain);
    return (
      <div key={c.name} data-strip={c.name} className={stripCls(c.name, compact ? ' compact' : '')} data-testid={`strip-${c.name}`} data-silent={silent || undefined} data-layer={c.layer} data-audible={store.songAudible(song).includes(c.name)}>
        <div className="mx-head" style={{ borderTopColor: channelColour(song, c.name) }}>
          <b className="mx-name" title={c.name}>{c.name}</b>
          <span className="mono mx-stem">{c.layer}</span>
        </div>
        {!compact && (
          <>
            <div className="mx-inserts" data-testid={`inserts-${c.name}`}>
              {rows.slice(0, 4).map((t, i) => <button type="button" key={`${t}${i}`} className={`mx-ins${i === 0 ? ' first' : ''}`} title={t} onClick={() => onInserts?.(c.name)}>{t}</button>)}
              {rows.length > 4 && <span className="mx-ins more" title={rows.slice(4).join(', ')}>+{rows.length - 4}</span>}
            </div>
            <div className="mx-knobs">
              <Knob size={28} label="pan" value={c.pan} min={-1} max={1} def={0} step={0.01} bipolar spec={PAN_SPEC} agent={agent(`${c.name}.pan`)} testId={`knob-${c.name}-pan`}
                onCommit={(v) => send(`song channel set ${song.id} ${c.name} pan=${Number(v.toFixed(2))}`)} />
              {sends.map((k) => (
                <Knob key={k} size={28} label={k} value={c[k] ?? 0} min={0} max={1} def={0} step={0.01} spec={PCT} agent={agent(`${c.name}.${k}`)} testId={`knob-${c.name}-${k}`}
                  onCommit={(v) => send(`song channel set ${song.id} ${c.name} ${k}=${Number(v.toFixed(2))}`)} />
              ))}
            </div>
          </>
        )}
        <Fader label="gain" value={dbNow} def={0} step={0.5} height={compact ? 84 : 190} agent={agent(`${c.name}.gain`)} testId={`fader-${c.name}`} meter={{ read: hub.reader(`ch:${c.name}`), label: `${c.name} level`, testId: `meter-${c.name}` }}
          onCommit={(db) => send(`song channel set ${song.id} ${c.name} gain=${dbToGain(db)}`)} />
        {!compact && <span className="mono mx-lufs" data-testid={`strip-lufs-${c.name}`} data-silent={silent || lufs === null || undefined}>{silent || lufs === null ? 'silent here' : `${lufs.toFixed(1).replace('-', MINUS)} LUFS`}</span>}
        <div className="mx-ms">
          <button type="button" className={`sm m${g.mute.has(c.name) ? ' on' : ''}`} aria-pressed={g.mute.has(c.name)} aria-label={`Mute ${c.name}`} title="Mute (listening only; ⌥-click the whole stem)" data-testid={`mixer-mute-${c.name}`} onClick={(e) => toggle(c, 'mute', e.altKey)}>M</button>
          <button type="button" className={`sm s${g.solo.has(c.name) ? ' on' : ''}`} aria-pressed={g.solo.has(c.name)} aria-label={`Solo ${c.name}`} title="Solo (listening only; ⌥-click the whole stem)" data-testid={`mixer-solo-${c.name}`} onClick={(e) => toggle(c, 'solo', e.altKey)}>S</button>
        </div>
      </div>
    );
  };

  const busStrip = (kind: 'reverb' | 'delay') => {
    const fx = song[kind]!;
    const params = FX_SPECS[kind].filter((s) => s.name !== 'mix' && !s.choices && !s.text).slice(0, 3);
    return (
      <div key={kind} data-strip={kind} className="mx-strip bus" data-testid={`strip-bus-${kind}`}>
        <div className="mx-head" style={{ borderTopColor: 'var(--line2)' }}><b className="mx-name">{kind}</b><span className="mono mx-stem">bus · {kind === 'reverb' ? 'space' : 'echo'}</span></div>
        {!compact && (
          <>
            <div className="mx-inserts"><span className="mx-ins first">{fxChip(fx)}</span></div>
            <div className="mx-knobs">
              {params.map((p) => (
                <Knob key={p.name} size={28} label={p.name} value={Number(fx.p[p.name])} min={p.min} max={p.max} def={p.default as number} step={(p.max - p.min) / 100} spec={{ unit: p.unit === 's' ? 's' : p.unit === 'Hz' ? 'hz' : 'plain' }} agent={agent(`bus.${kind}.${p.name}`)} testId={`knob-bus-${kind}-${p.name}`}
                  onCommit={(v) => send(`song send ${song.id} ${kind} ${p.name}=${Number(v.toFixed(3))}`)} />
              ))}
            </div>
          </>
        )}
        <div className="mx-busmeter"><Meter height={compact ? 84 : 190} read={hub.reader(`bus:${kind}`)} label={`${kind} return level`} testId={`meter-bus-${kind}`} /></div>
        {!compact && <span className="mono mx-lufs dim">return only</span>}
      </div>
    );
  };

  const limitIdx = song.master.findIndex((f) => f.kind === 'limit');
  const limiter = limitIdx >= 0 ? song.master[limitIdx]! : null;
  const gr = numbers?.masterReductionDb;
  const target = numbers?.target ?? store.style.loudnessTarget;
  const tol = numbers?.tolerance ?? store.style.loudnessTolerance;
  const integrated = numbers?.lufs !== null && numbers?.lufs !== undefined && Number.isFinite(numbers.lufs) ? numbers.lufs : null;
  const master = (
    <div key="master" className={`mx-strip master${compact ? ' compact' : ''}`} data-testid="strip-master">
      <div className="mx-head" style={{ borderTopColor: 'var(--text)' }}><b className="mx-name">master</b><span className="mono mx-stem">to game · stems export</span></div>
      {!compact && (
        <>
          <div className="mx-limiter" data-testid="master-limiter">
            {limiter ? (
              <>
                <div className="mx-limrow"><span className="dim">True-peak limiter</span>
                  <Knob size={28} label="ceiling" value={Number(limiter.p.ceiling)} min={-12} max={0} def={-1} step={0.1} spec={{ unit: 'db', digits: 1 }} agent={agent(`master.${limitIdx + 1}.ceiling`)} testId="knob-master-ceiling"
                    onCommit={(v) => send(`song fx set ${song.id} ${limitIdx + 1} ceiling=${Number(v.toFixed(1))}`)} /></div>
                <div className="mx-gr" title="the most gain reduction the limiter made on the mix"><span className="dim small">GR</span>
                  <div className="mx-grbar"><div style={{ width: `${Math.min(100, ((gr ?? 0) / 6) * 100)}%` }} /></div>
                  <span className="mono small" data-testid="master-gr">{gr === undefined || gr === null ? '…' : `${MINUS}${Math.abs(gr).toFixed(1)}`}</span></div>
              </>
            ) : <span className="dim small">No limiter in the master chain.</span>}
            {song.master.filter((f) => f.kind !== 'limit').map((f, i) => <span key={i} className="mx-ins" title="master chain">{fxChip(f)}</span>)}
          </div>
        </>
      )}
      <Fader label="master" value={gainToDb(song.gain)} def={0} step={0.5} height={compact ? 84 : 150} agent={agent('song.gain')} testId="fader-master" meter={{ read: hub.reader('master'), label: 'master level', testId: 'meter-master' }}
        onCommit={(db) => send(`song set ${song.id} gain=${dbToGain(db)}`)} />
      {!compact && (
        <div className="mx-target" data-testid="master-target">
          <span className="cap mx-cap">Loudness vs target</span>
          <div className="mx-targetrow">
            <LoudnessTarget vertical value={integrated} target={target} tolerance={tol} label="Integrated" testId="master-loudness" />
            <div className="mx-nums">
              <div><span className="dim small">integrated</span><span className="mono big" data-testid="num-integrated">{integrated === null ? '—' : integrated.toFixed(1).replace('-', MINUS)}</span></div>
              <div><span className="dim small">short-term</span><LiveText className="mono" testId="num-short-term" read={() => hub.shortTerm('master')} fmt={(v) => (v === null ? '—' : v.toFixed(1).replace('-', MINUS))} /></div>
              <div><span className="dim small">range</span><span className="mono" data-testid="num-range">{numbers?.loudnessRange === null || numbers?.loudnessRange === undefined ? '—' : `${numbers.loudnessRange.toFixed(1)} LU`}</span></div>
              <div><span className="dim small">true peak</span><span className="mono" data-testid="num-true-peak">{numbers?.truePeakDb === null || numbers?.truePeakDb === undefined ? '—' : `${numbers.truePeakDb.toFixed(1).replace('-', MINUS)} dBTP`}</span></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  const soloed = (l: MaskLink): boolean => g.solo.size === 2 && g.solo.has(l.a) && g.solo.has(l.b);
  const linkText = (l: MaskLink): string => {
    const barSec = (song.time[0] * (4 / song.time[1]) * 60) / song.tempo;
    const nBars = arr ? Math.max(1, Math.floor(arr.total / barSec + 1e-6)) : undefined;
    const gap = /([\d.]+) dB apart/.exec(l.note)?.[1];
    return `${l.a} ↔ ${l.b}${l.band ? ` · ${l.band}` : ''} · ${barsOf(l.from, l.to, barSec, nBars).text}${gap ? ` · ${gap} dB apart` : ''}`;
  };
  const doLink = (l: MaskLink): void => store.soloAndLoop(song.id, [l.a, l.b], { start: l.from, end: l.to });
  const kind = masking?.pass ? 'pass' : 'warn';

  return (
    <section ref={root} className="mixer" data-testid="mixer" data-compact={compact || undefined} data-song={song.id} data-mode={mode} aria-label={`Mixer of ${song.id}`}>
      {!compact && (
        <div className="mx-lane" data-testid="masking-lane">
          <span className="cap">Masking lane</span>
          <span className="dim small">Strips that clash in frequency are linked below. Click a link to solo both and loop the bars where it happens.</span>
          <span className="spacer" />
          {links.map((l) => (
            <button type="button" key={`${l.a}|${l.b}`} className="mx-link" data-kind={kind} aria-pressed={soloed(l)} data-testid={`mask-link-${l.a}-${l.b}`} onClick={() => doLink(l)} title={l.note}>
              <span className="mono" aria-hidden>{kind === 'pass' ? '✓' : '!'}</span> {linkText(l)}
            </button>
          ))}
          {!links.length && (masking && !masking.skipped ? <Badge kind="pass" testId="masking-clear">no strips clash in frequency</Badge> : <span className="dim small" data-testid="masking-none">{report ? 'The masking check has nothing to say here.' : 'Checking…'}</span>)}
        </div>
      )}
      <div className="mx-strips" ref={strips} data-testid="mixer-strips">
        {!compact && links.length > 0 && (
          <svg className="mx-links" aria-hidden width="100%" height="34">
            {links.map((l) => {
              const x1 = centres[l.a], x2 = centres[l.b];
              if (x1 === undefined || x2 === undefined) return null;
              const lift = 8 + Math.min(14, Math.abs(x2 - x1) / 30);
              return <path key={`${l.a}|${l.b}`} d={`M${x1} 34 C${x1} ${34 - lift * 2} ${x2} ${34 - lift * 2} ${x2} 34`} className="mx-arc" data-kind={kind} data-testid={`mask-arc-${l.a}-${l.b}`} onClick={() => doLink(l)} />;
            })}
          </svg>
        )}
        {order.map(channelStrip)}
        {buses.map(busStrip)}
        {master}
      </div>
      {!compact && (
        <div className="mx-foot dim small">
          <span>Drag a fader ↕ · ⇧ fine · double-click 0 dB · click to type a value</span>
          <span>⌥-click M or S applies to the whole stem</span>
          <span>The violet dot on a knob: the agent set it last</span>
          {tooBig && <span data-testid="meters-off">Live meters are off: this song is too long to copy to the meter worker.</span>}
        </div>
      )}
    </section>
  );
}

/** Peak or short-term loudness on every meter. */
export function MeterModeToggle({ store }: { store: Store }) {
  const hub = store.meters;
  const mode = useSyncExternalStore(hub.subscribe, () => hub.mode);
  return (
    <span className="mx-mode" data-testid="meter-mode">
      <span className="dim small">Meters show</span>
      <Segmented<'peak' | 'lufs'> label="Meters show" value={mode} onChange={(v) => hub.setMode(v)} options={[{ value: 'peak', label: 'peak', testId: 'meter-mode-peak' }, { value: 'lufs', label: 'short-term LUFS', testId: 'meter-mode-lufs' }]} />
    </span>
  );
}

export type { ParamTrail };
