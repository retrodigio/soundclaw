// The sound editor: the classic voice's 25 parameters as sliders grouped as sfxr groups them,
// the generators, mutate, A/B, and exports. Every change re-renders here with core and replays at
// once. A person's edit is a command, the very text an agent would write, sent as this person:
// a drag is held back and written as ONE `sound set` when the slider is released (or has stopped
// for a moment), never one per pixel.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Coalescer, EDITOR_GROUPS, GENERATOR_NAMES, MUTATE_AMOUNT, WAVE_NAMES, classicField, csvFileText, diffPatch, patchFileText, resetCommand, restoreCommand, roundParam, setCommand,
  type ClassicKey, type ClassicPatch, type Edits, type Scheduler, type Sound,
} from '@soundclaw/core';
import { MelSpectrogram } from './Spectrogram.tsx';
import { LoudnessClass } from './LoudnessClass.tsx';
import type { Store } from './store.ts';
import { download } from './download.ts';
import { LayeredEditor } from './LayeredEditor.tsx';
import { LoopPanel } from './LoopPanel.tsx';
import { Waveform } from './Waveform.tsx';

const sched: Scheduler = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/** How long a slider may rest, mid-drag, before what it holds is written. */
const PAUSE_MS = 700;
/** After a release, how long to wait for a double-click (a reset) before writing. */
const DOUBLE_CLICK_MS = 250;

const randomSeed = (): number => Math.floor(Math.random() * 4294967296);

/** The patch with edits laid over it (the draft the sliders show before it is written). */
function withEdits(p: ClassicPatch, e: Edits): ClassicPatch {
  const out: ClassicPatch = { ...p };
  for (const [k, v] of Object.entries(e)) {
    if (k === 'seed') { if (v === 'auto') delete out.seed; else out.seed = v as number; } else (out as unknown as Record<string, number>)[k] = v as number;
  }
  return out;
}

interface SliderProps {
  name: ClassicKey;
  value: number;
  onMove(v: number): void;
  onRelease(): void;
  onReset(): void;
}

function Slider({ name, value, onMove, onRelease, onReset }: SliderProps) {
  const f = classicField(name)!;
  const changed = value !== f.default;
  return (
    <div className={`slider${changed ? ' changed' : ''}`} data-testid={`row-${name}`}>
      <label htmlFor={`s-${name}`} title={f.help}>{name}</label>
      <input
        id={`s-${name}`} type="range" min={f.min} max={f.max} step={0.001} value={value} data-testid={`slider-${name}`}
        onChange={(e) => onMove(roundParam(name, Number(e.target.value)))}
        onPointerDown={() => window.addEventListener('pointerup', onRelease, { once: true })}
        onKeyUp={onRelease}
        onBlur={onRelease}
        onDoubleClick={onReset}
      />
      <output data-testid={`value-${name}`} title={`default ${f.default}`}>{value}</output>
      <span className="range dim" data-testid={`range-${name}`}>{f.min} … {f.max}</span>
      <button className="link reset" data-testid={`reset-${name}`} disabled={!changed} onClick={onReset} title={`back to the default, ${f.default}`} aria-label={`reset ${name}`}>↺</button>
    </div>
  );
}

function Numbers({ store, sound }: { store: Store; sound: Sound }) {
  const m = store.measure(sound);
  if (m.pending) return <span className="dim" data-testid="editor-numbers">measuring…</span>;
  const a = m.analysis;
  const hz = (v: number | null) => (v === null ? '—' : `${v.toFixed(0)} Hz`);
  return (
    <span className="dim" data-testid="editor-numbers">
      {a.duration.toFixed(2)} s · {Number.isFinite(a.lufs) ? a.lufs.toFixed(1) : '−∞'} LUFS · centroid {hz(a.centroid.mean)} · pitch {hz(a.pitch.start)}
    </span>
  );
}

function AB({ store, sound }: { store: Store; sound: Sound }) {
  const pin = store.pinned(sound.id);
  const others = store.sounds.filter((s) => s.id !== sound.id);
  const keep = pin && sound.voice === 'classic' && pin.sound.voice === 'classic' ? restoreCommand(sound.id, sound.patch, pin.sound.patch) : null;
  const num = (s: Sound) => { const m = store.measure(s); if (m.pending) return ['…', '…', '…', '…']; const a = m.analysis; return [a.duration.toFixed(2), Number.isFinite(a.lufs) ? a.lufs.toFixed(1) : '−∞', a.centroid.mean.toFixed(0), a.pitch.start === null ? '—' : a.pitch.start.toFixed(0)]; };
  return (
    <section className="panel" data-testid="ab" aria-label="A/B">
      <h3>A / B</h3>
      <div className="row">
        <button data-testid="pin-a" onClick={() => store.pinSnapshot(sound.id)} title="Keep a snapshot of this sound's parameters as A">Pin as A</button>
        <select data-testid="pin-other" value="" onChange={(e) => { if (e.target.value) store.pinOther(sound.id, e.target.value); }} aria-label="Pin another sound as A">
          <option value="">or another sound…</option>
          {others.map((o) => <option key={o.id} value={o.id}>{o.id}</option>)}
        </select>
      </div>
      {pin ? (
        <>
          <div className="row">
            <button className="play" data-testid="play-a" data-playing={store.playing === `${sound.id}#A`} onClick={() => void store.playSide(sound.id, 'A')}>▶ A</button>
            <button className="play" data-testid="play-b" data-playing={store.playing === sound.id} onClick={() => void store.playSide(sound.id, 'B')}>▶ B (live)</button>
            <button data-testid="keep-a" disabled={!keep} title={keep ?? 'B already has the parameters of A'} onClick={() => { if (keep) void store.run(keep); }}>Keep A</button>
            <button className="link" data-testid="clear-a" onClick={() => store.unpin(sound.id)}>clear A</button>
          </div>
          <table className="ab-table dim" data-testid="ab-table">
            <thead><tr><th /><th>s</th><th>LUFS</th><th>centroid Hz</th><th>pitch Hz</th></tr></thead>
            <tbody>
              <tr data-testid="ab-row-a"><th>A: {pin.label}</th>{num(pin.sound).map((v, i) => <td key={i}>{v}</td>)}</tr>
              <tr data-testid="ab-row-b"><th>B: live</th>{num(sound).map((v, i) => <td key={i}>{v}</td>)}</tr>
            </tbody>
          </table>
        </>
      ) : <p className="dim">Pin the sound as A, change it, then switch between A and the live B to compare.</p>}
    </section>
  );
}

function ClassicEditor({ store, id }: { store: Store; id: string }) {
  const sound = store.sounds.find((s) => s.id === id);
  const [draft, setDraft] = useState<Edits>({});
  const [amount, setAmount] = useState(MUTATE_AMOUNT);
  const latest = useRef({ sound, store, id });
  latest.current = { sound, store, id };
  const release = useRef<ReturnType<typeof setTimeout> | null>(null);

  const co = useMemo(() => new Coalescer((edits) => {
    const { sound: cur, store: st, id: sid } = latest.current;
    const clear = () => setDraft((d) => {
      const next = { ...d };
      for (const [k, v] of Object.entries(edits)) if (next[k as ClassicKey | 'seed'] === v) delete next[k as ClassicKey | 'seed'];
      return next;
    });
    if (!cur || cur.voice !== 'classic') { clear(); return; }
    const d = diffPatch(cur.patch, withEdits(cur.patch, edits));
    if (!Object.keys(d).length) { clear(); return; }
    void st.run(setCommand(sid, d)).then(clear);
  }, sched, PAUSE_MS), []);
  useEffect(() => () => { co.cancel(); if (release.current) clearTimeout(release.current); }, [co]);

  const key = sound ? store.keyOf(sound) : '';
  const prevKey = useRef(key);
  useEffect(() => {
    const was = prevKey.current;
    prevKey.current = key;
    // Not when the sound first arrives (opening the page must be silent), only when it changes.
    if (!was || !key || was === key) return;
    if (sound && store.playOnChange) void store.playDoc(id, sound, id, undefined, true);
  }, [key, sound, store, id]);

  // Space plays and stops the sound: the shell's one keyboard handler does that for the open sound.

  if (!sound) {
    return <section className="editor"><a href="#/" className="back">← all sounds</a><p className="empty" data-testid="editor-missing">No sound “{id}”.</p></section>;
  }
  if (sound.voice !== 'classic') {
    return (
      <section className="editor" data-testid="editor">
        <a href="#/" className="back" data-testid="back">← all sounds</a>
        <h2>{sound.id}</h2>
        <p className="dim" data-testid="editor-tone">This sound uses the placeholder tone voice, which has no editor. Make it again as a classic sound (<code>sound new {sound.id}2 voice=classic</code>) to edit its 25 parameters here.</p>
      </section>
    );
  }

  const patch = withEdits(sound.patch, draft);
  const preview: Sound = { ...sound, patch };
  const move = (name: ClassicKey, v: number) => {
    setDraft((d) => ({ ...d, [name]: v }));
    co.push(name, v);
  };
  const doRelease = () => {
    if (release.current) clearTimeout(release.current);
    release.current = setTimeout(() => { release.current = null; co.flush(); }, DOUBLE_CLICK_MS);
  };
  const reset = (name: ClassicKey) => {
    if (release.current) { clearTimeout(release.current); release.current = null; }
    co.cancel();
    setDraft((d) => { const n = { ...d }; delete n[name]; return n; });
    if (sound.patch[name] !== classicField(name)!.default) void store.run(resetCommand(id, [name]));
  };
  const now = (cmd: string) => { co.flush(); return store.run(cmd); };
  const playing = store.playing === id;
  const measured = store.measure(sound);

  return (
    <section className="editor" data-testid="editor" data-sound={id}>
      <header className="editor-head">
        <a href="#/" className="back" data-testid="back">← all sounds</a>
        <h2>{sound.id}</h2>
        <span className={`chip status-${sound.status}`}>{sound.status}</span>
        <Numbers store={store} sound={sound} />
        <LoudnessClass store={store} sound={sound} />
        <span className="spacer" />
        <button className="play" data-testid="editor-play" data-playing={playing} onClick={() => void store.play(id)}>{playing ? '■ Stop' : '▶ Play'} <span className="dim">space</span></button>
        <button data-testid="editor-stop" onClick={() => store.stop()} disabled={!store.playing}>■ Stop</button>
        <label className="toggle"><input type="checkbox" data-testid="play-on-change" checked={store.playOnChange} onChange={(e) => { store.playOnChange = e.target.checked; store.changed(); }} /> play on change</label>
        <button data-testid="editor-undo" disabled={!store.canUndo()} onClick={() => void store.undo()}>Undo</button>
        <button data-testid="editor-redo" disabled={!store.canRedo()} onClick={() => void store.redo()}>Redo</button>
      </header>

      <div className="editor-grid">
        <div className="params-col" data-testid="params-editor">
          {EDITOR_GROUPS.map((g) => (
            <fieldset key={g.id} className="group" data-testid={`group-${g.id}`}>
              <legend>{g.title}</legend>
              {g.id === 'wave' ? (
                <div className="row">
                  {WAVE_NAMES.map((w, i) => (
                    <button key={w} className={patch.wave === i ? 'on' : ''} aria-pressed={patch.wave === i} data-testid={`wave-${w}`} onClick={() => { setDraft((d) => ({ ...d, wave: i })); co.push('wave', i); co.flush(); }}>{w}</button>
                  ))}
                  <label className="seed" title="The noise seed; auto is a hash of the 25 values">seed
                    <input type="number" min={0} step={1} data-testid="seed" placeholder="auto" value={patch.seed ?? ''}
                      onChange={(e) => setDraft((d) => ({ ...d, seed: e.target.value === '' ? 'auto' : Math.max(0, Math.floor(Number(e.target.value))) }))}
                      onBlur={() => { if (draft.seed !== undefined) { co.push('seed', draft.seed); co.flush(); } }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
                  </label>
                  <button className="link" data-testid="seed-auto" disabled={sound.patch.seed === undefined} onClick={() => void now(setCommand(id, { seed: 'auto' }))}>auto</button>
                </div>
              ) : g.params.map((n) => (
                <Slider key={n} name={n} value={patch[n]} onMove={(v) => move(n, v)} onRelease={() => { if (co.value(n) !== undefined) doRelease(); }} onReset={() => reset(n)} />
              ))}
            </fieldset>
          ))}
        </div>

        <div className="side-col">
          <section className="panel" aria-label="Sound">
            <Waveform samples={store.render(preview)} id={id} />
            {!measured.pending && <MelSpectrogram spec={measured.spec} id={id} />}
            <div className="dim hash">samples {store.hashOf(sound).slice(0, 12)}</div>
          </section>

          <section className="panel" data-testid="generators" aria-label="Generators">
            <h3>Start from</h3>
            <div className="row wrap">
              {GENERATOR_NAMES.map((c) => (
                <button key={c} data-testid={`gen-${c}`} onClick={() => void now(`sound generate ${id} ${c} seed=${randomSeed()}`)}>{c}</button>
              ))}
            </div>
            <div className="row">
              <label>mutate amount
                <input type="number" min={0.01} max={1} step={0.01} value={amount} data-testid="mutate-amount" onChange={(e) => setAmount(Math.min(1, Math.max(0.01, Number(e.target.value) || MUTATE_AMOUNT)))} />
              </label>
              <button data-testid="mutate" onClick={() => void now(`sound mutate ${id} amount=${amount} seed=${randomSeed()}`)}>Mutate</button>
            </div>
          </section>

          <AB store={store} sound={sound} />

          <LoopPanel store={store} sound={sound} />

          <section className="panel" data-testid="export" aria-label="Export">
            <h3>Export</h3>
            <div className="row wrap">
              <button data-testid="export-wav" onClick={() => download(`${id}.wav`, store.wavOf(sound), 'audio/wav')}>WAV</button>
              <button data-testid="export-patch" onClick={() => download(`${id}.sfxr`, patchFileText(sound.patch), 'text/plain')}>Patch text</button>
              <button data-testid="export-csv" onClick={() => download(`${id}.csv`, csvFileText(id, sound.patch), 'text/csv')}>CSV row</button>
            </div>
            <p className="dim">WAV is the pre-rendered form (16-bit, 44,100 Hz, mono); patch text and the CSV row are what a pack's synth table takes.</p>
          </section>
        </div>
      </div>
    </section>
  );
}


/** The editor page of a sound: the layer editor for layered sounds, the sliders of the classic voice for the rest. */
export function Editor({ store, id }: { store: Store; id: string }) {
  const sound = store.sounds.find((s) => s.id === id);
  if (sound?.voice === 'layered') return <LayeredEditor store={store} id={id} />;
  return <ClassicEditor store={store} id={id} />;
}
