// The song page's side panels. The instrument panel: each channel's instrument, gain, pan, mute and
// solo (listening only), game layer, and an instrument's own editor (its note envelope, velocity,
// range, pitch rule, and its voice with the sound editor's controls). The helpers panel: the
// composition helpers run on the pattern and channel picked, shown as the rows they would write
// before the person applies the same command.

import { useEffect, useRef, useState } from 'react';
import {
  BASS_STYLES, BUILTIN_NAMES, DRUM_TEMPLATES, INSTRUMENT_PARAMS, Library, PITCH_CHECKS, RHYTHMS, noteLabel, pitchCheckOf, previewRows,
  type Instrument, type Pattern, type RowsPreview, type SongDoc,
} from '@soundclaw/core';
import { LayeredEditor } from './LayeredEditor.tsx';
import type { RunResult, Store } from './store.ts';

/** A slider that writes one command when it is let go (a drag is one history entry). */
function Knob({ label, min, max, step, value, testid, onCommit }: { label: string; min: number; max: number; step: number; value: number; testid: string; onCommit(v: number): void }) {
  const [v, setV] = useState<number | null>(null);
  const cur = useRef<number | null>(null);
  const commit = (): void => { const x = cur.current; cur.current = null; setV(null); if (x !== null && x !== value) onCommit(x); };
  return (
    <label className="knob" title={`${label}: ${v ?? value}`}>
      <span className="dim">{label}</span>
      <input type="range" min={min} max={max} step={step} value={v ?? value} data-testid={testid}
        onChange={(e) => { const x = Number(e.target.value); cur.current = x; setV(x); }}
        onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
      <output>{(v ?? value).toFixed(2)}</output>
    </label>
  );
}

function instrumentText(i: Instrument): string {
  return `root ${noteLabel(i.root)} · ${i.pitched ? 'pitched' : 'unpitched'} · adsr ${i.attack}/${i.decay}/${i.sustain}/${i.release}${i.range ? ` · range ${noteLabel(i.range[0])}–${noteLabel(i.range[1])}` : ''} · pitch check ${pitchCheckOf(i)}`;
}

/** The sound commands the voice controls write, as the instrument's own commands. */
export const asInstrumentCommands = (cmds: string): string => cmds.split('\n').filter(Boolean).map((l) => (l.startsWith('sound set ') ? l.replace(/^sound set /, 'instrument set ') : `instrument ${l}`)).join('\n');

function InstrumentEditor({ store, inst }: { store: Store; inst: Instrument }) {
  const run = (cmds: string): Promise<RunResult> => store.run(cmds);
  const set = (kv: string): void => void run(`instrument set ${inst.id} ${kv}`);
  return (
    <div className="inst-editor" data-testid={`inst-editor-${inst.id}`}>
      <div className="row wrap">
        <b>{inst.id}</b>
        <span className="dim" data-testid={`inst-summary-${inst.id}`}>{instrumentText(inst)}</span>
        <span className="spacer" />
        <button className="play" data-testid={`inst-play-${inst.id}`} onClick={() => void store.playNote(inst)}>▶ note</button>
      </div>
      <div className="row wrap">
        {(['attack', 'decay', 'sustain', 'release', 'velocity'] as const).map((k) => (
          <Knob key={k} label={k} min={INSTRUMENT_PARAMS[k].min} max={Math.min(INSTRUMENT_PARAMS[k].max, k === 'sustain' || k === 'velocity' ? 1 : 2)} step={0.001} value={inst[k]} testid={`inst-${k}-${inst.id}`} onCommit={(v) => set(`${k}=${Number(v.toFixed(3))}`)} />
        ))}
        <label className="field">pitch check
          <select data-testid={`inst-pitch-check-${inst.id}`} value={pitchCheckOf(inst)} onChange={(e) => set(`pitch-check=${e.target.value}`)} title="how render-match hears the pitch: the note, its pitch class (a bell), or timing only">
            {PITCH_CHECKS.map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
        <label className="field">root
          <input data-testid={`inst-root-${inst.id}`} defaultValue={noteLabel(inst.root)} key={inst.root} style={{ width: 48 }} onBlur={(e) => { if (e.target.value !== noteLabel(inst.root)) set(`root=${e.target.value}`); }} />
        </label>
        <label className="field">range
          <input data-testid={`inst-range-${inst.id}`} defaultValue={inst.range ? `${noteLabel(inst.range[0])}-${noteLabel(inst.range[1])}` : 'none'} key={String(inst.range)} style={{ width: 74 }} onBlur={(e) => { const was = inst.range ? `${noteLabel(inst.range[0])}-${noteLabel(inst.range[1])}` : 'none'; if (e.target.value !== was) set(`range=${e.target.value}`); }} />
        </label>
      </div>
      <LayeredEditor store={store} id={inst.id} voice={{ sound: inst.voice, run: (c) => run(asInstrumentCommands(c)), play: () => void store.playNote(inst), playing: store.playing === `${inst.id}#note` }} />
    </div>
  );
}

export function InstrumentPanel({ store, song }: { store: Store; song: SongDoc }) {
  const [open, setOpen] = useState<string | null>(null);
  const g = store.songGroups(song.id);
  const send = (cmd: string): void => void store.run(cmd);
  const choices = [...store.instruments.map((i) => i.id), ...BUILTIN_NAMES];
  const openInst = open ? store.instruments.find((i) => i.id === open) : undefined;
  return (
    <section className="panel instruments" data-testid="instrument-panel" aria-label="Instruments">
      <h3>Channels and instruments</h3>
      <table className="inst-table">
        <thead><tr><th>channel</th><th>instrument</th><th>gain</th><th>pan</th><th>listen</th><th>layer</th><th /></tr></thead>
        <tbody>
          {song.channels.map((c) => {
            const own = c.inst ? store.instruments.find((i) => i.id === c.inst) : undefined;
            return (
              <tr key={c.name} data-testid={`chan-${c.name}`} data-audible={store.songAudible(song).includes(c.name)}>
                <td><b>{c.name}</b></td>
                <td>
                  {c.inst ? (
                    <select data-testid={`chan-inst-${c.name}`} value={c.inst} onChange={(e) => send(`song channel set ${song.id} ${c.name} inst=${e.target.value}`)}>
                      {[...new Set([c.inst, ...choices])].map((x) => <option key={x} value={x}>{x}{(BUILTIN_NAMES as readonly string[]).includes(x) && !store.instruments.some((i) => i.id === x) ? ' (built-in)' : ''}</option>)}
                    </select>
                  ) : <span className="dim">drum kit{c.kit && Object.keys(c.kit).length ? ` (${Object.entries(c.kit).map(([k, v]) => `${k}:${v}`).join(', ')})` : ''}</span>}
                </td>
                <td><Knob label="" min={0} max={2} step={0.01} value={c.gain} testid={`chan-gain-${c.name}`} onCommit={(v) => send(`song channel set ${song.id} ${c.name} gain=${Number(v.toFixed(2))}`)} /></td>
                <td><Knob label="" min={-1} max={1} step={0.01} value={c.pan} testid={`chan-pan-${c.name}`} onCommit={(v) => send(`song channel set ${song.id} ${c.name} pan=${Number(v.toFixed(2))}`)} /></td>
                <td>
                  <button className={`mini${g.mute.has(c.name) ? ' on' : ''}`} aria-pressed={g.mute.has(c.name)} data-testid={`chan-mute-${c.name}`} onClick={() => store.toggleSongChannel(song.id, c.name, 'mute')} title="Mute (for listening here; not saved)">M</button>
                  <button className={`mini${g.solo.has(c.name) ? ' on' : ''}`} aria-pressed={g.solo.has(c.name)} data-testid={`chan-solo-${c.name}`} onClick={() => store.toggleSongChannel(song.id, c.name, 'solo')} title="Solo (for listening here; not saved)">S</button>
                </td>
                <td><input data-testid={`chan-layer-${c.name}`} defaultValue={c.layer} key={c.layer} style={{ width: 70 }} onBlur={(e) => { if (e.target.value && e.target.value !== c.layer) send(`song channel set ${song.id} ${c.name} layer=${e.target.value}`); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></td>
                <td>
                  {c.inst && (own
                    ? <button className="mini" data-testid={`chan-edit-${c.name}`} onClick={() => setOpen(open === own.id ? null : own.id)}>{open === own.id ? 'close' : 'edit'}</button>
                    : <button className="mini" data-testid={`chan-copy-${c.name}`} title={`${c.inst} is built in: make the song its own copy to edit`}
                      onClick={() => {
                        const base = `${song.id}_${c.name}`.slice(0, 48);
                        let idn = base;
                        for (let k = 2; store.instruments.some((i) => i.id.toLowerCase() === idn.toLowerCase()); k++) idn = `${base}${k}`;
                        void store.run(`instrument new ${idn} from=${c.inst}\nsong channel set ${song.id} ${c.name} inst=${idn}`).then((r) => { if (r.ok) setOpen(idn); });
                      }}>edit a copy</button>)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {openInst && <InstrumentEditor store={store} inst={openInst} />}
    </section>
  );
}

// ---- the helpers ------------------------------------------------------------------------------------------------------

type HelperName = 'chords' | 'bass' | 'arp' | 'drums' | 'humanise' | 'motif';

/** The helper's command as the person set it up (the same text an agent would write). */
function helperCommand(song: SongDoc, pattern: string, channel: string, h: HelperName, o: Record<string, string>, at: number): string {
  const q = (s: string): string => `"${s.replace(/"/g, '')}"`;
  switch (h) {
    case 'chords': return `chords ${song.id} ${pattern} ${channel} ${q(o.prog!)} bars=${o.bars} rhythm=${o.rhythm}`;
    case 'bass': return `bass ${song.id} ${pattern} ${channel} ${o.from ? `from=${o.from}` : q(o.prog!)} style=${o.style} bars=${o.bars}`;
    case 'arp': return `arp ${song.id} ${pattern} ${channel} ${o.from ? `from=${o.from}` : q(o.prog!)} pattern=${o.arp} rate=${o.rate} bars=${o.bars}`;
    case 'drums': return `drums ${song.id} ${pattern} ${channel} ${o.template}`;
    case 'humanise': return `humanise ${song.id} ${pattern} ${channel} timing=${o.timing} velocity=${o.velocity} seed=${o.seed}`;
    case 'motif': {
      const m = o.motif!;
      if (o.transform === 'none' || o.transform === 'transpose') return `motif write ${song.id} ${m} ${pattern} ${channel} at=${at}${o.transform === 'transpose' ? ` by=${o.by}` : ''}`;
      const as = `${m}_${o.transform}`;
      return `motif ${o.transform} ${song.id} ${m} as=${as}\nmotif write ${song.id} ${as} ${pattern} ${channel} at=${at}`;
    }
  }
}

export function HelperPanel({ store, song, pattern, channel, atStep }: { store: Store; song: SongDoc; pattern: Pattern; channel: string | null; atStep: number }) {
  const ch = song.channels.find((c) => c.name === channel);
  const [helper, setHelper] = useState<HelperName>(ch?.kit ? 'drums' : 'chords');
  const [o, setO] = useState<Record<string, string>>({ prog: 'I V vi IV', bars: '1', rhythm: 'beats', style: 'root-fifth', from: '', arp: 'up', rate: '1/8', template: 'rock', timing: '8', velocity: '6', seed: '1', motif: song.motifs[0]?.name ?? '', transform: 'none', by: '2' });
  const [preview, setPreview] = useState<{ cmd: string; rows: RowsPreview[] } | { cmd: string; error: string } | null>(null);
  const drumCh = song.channels.find((c) => c.kit)?.name;
  const target = helper === 'drums' ? (ch?.kit ? ch.name : drumCh) : helper === 'humanise' ? channel : ch?.inst ? ch.name : song.channels.find((c) => c.inst)?.name;
  useEffect(() => { setPreview(null); }, [helper, pattern.name, channel, song]);
  const field = (k: string, label: string, opts?: readonly string[], width = 90) => (
    <label className="field" key={k}>{label}
      {opts ? <select data-testid={`helper-${k}`} value={o[k]} onChange={(e) => setO({ ...o, [k]: e.target.value })}>{opts.map((x) => <option key={x}>{x}</option>)}</select>
        : <input data-testid={`helper-${k}`} value={o[k]} style={{ width }} onChange={(e) => setO({ ...o, [k]: e.target.value })} />}
    </label>
  );
  const others = song.channels.filter((c) => c.inst && c.name !== target).map((c) => c.name);
  const doPreview = (): void => {
    if (!target) return;
    const cmd = helperCommand(song, pattern.name, target, helper, o, atStep);
    const lib = new Library();
    for (const s of store.songs) lib.songs.set(s.id, s);
    for (const i of store.instruments) lib.instruments.set(i.id, i);
    const r = previewRows(lib, song.id, cmd);
    setPreview(r.ok ? { cmd, rows: r.rows } : { cmd, error: r.error });
  };
  return (
    <section className="panel helpers" data-testid="helper-panel" aria-label="Helpers">
      <h3>Helpers <span className="dim">on {pattern.name}{target ? ` · ${target}` : ''}{helper === 'motif' ? ` · from step ${atStep}` : ''}</span></h3>
      <div className="row wrap">
        {(['chords', 'bass', 'arp', 'drums', 'humanise', 'motif'] as const).map((h) => <button key={h} className={`tab${helper === h ? ' on' : ''}`} data-testid={`helper-${h}`} onClick={() => setHelper(h)}>{h}</button>)}
      </div>
      <div className="row wrap">
        {helper === 'chords' && [field('prog', 'progression', undefined, 140), field('bars', 'bars per chord', undefined, 40), field('rhythm', 'rhythm', RHYTHMS)]}
        {(helper === 'bass' || helper === 'arp') && [field('prog', 'progression', undefined, 140), field('from', 'or follow', ['', ...others]), field('bars', 'bars per chord', undefined, 40)]}
        {helper === 'bass' && field('style', 'style', BASS_STYLES)}
        {helper === 'arp' && [field('arp', 'pattern', ['up', 'down', 'updown', 'random(1)']), field('rate', 'rate', ['1/4', '1/8', '1/16'])]}
        {helper === 'drums' && field('template', 'template', Object.keys(DRUM_TEMPLATES))}
        {helper === 'humanise' && [field('timing', 'timing ms', undefined, 40), field('velocity', 'velocity', undefined, 40), field('seed', 'seed', undefined, 50)]}
        {helper === 'motif' && (song.motifs.length
          ? [field('motif', 'motif', song.motifs.map((m) => m.name)), field('transform', 'as', ['none', 'transpose', 'invert', 'retrograde', 'augment', 'diminish']), ...(o.transform === 'transpose' ? [field('by', 'by steps', undefined, 40)] : [])]
          : <span className="dim">The song has no motifs (motif set {song.id} &lt;name&gt; "C5 D5 E5").</span>)}
      </div>
      <div className="row">
        <button data-testid="helper-preview" disabled={!target || (helper === 'motif' && !song.motifs.length)} onClick={doPreview}>Preview</button>
        {!target && <span className="dim">no channel this helper can write into</span>}
      </div>
      {preview && (
        <div className="helper-preview" data-testid="helper-preview-box">
          <code className="dim" data-testid="helper-command">{preview.cmd}</code>
          {'error' in preview ? <div className="error" data-testid="helper-error">{preview.error}</div> : (
            <>
              {preview.rows.length === 0 && <div className="dim">No rows change.</div>}
              {preview.rows.map((r) => (
                <div key={r.pattern} className="preview-rows" data-testid={`helper-rows-${r.pattern}`}>
                  <div className="dim">before</div><pre>{r.before}</pre>
                  <div className="dim">after</div><pre data-testid={`helper-after-${r.pattern}`}>{r.after}</pre>
                </div>
              ))}
              <div className="row">
                <button className="play" data-testid="helper-apply" disabled={!preview.rows.length} onClick={() => { const c = preview.cmd; setPreview(null); void store.run(c); }}>Apply</button>
                <button data-testid="helper-cancel" onClick={() => setPreview(null)}>Cancel</button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
