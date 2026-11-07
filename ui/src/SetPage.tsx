// A set on its own page: the members in a row (play each, play them in sequence), regenerate with
// a new seed, and the numbers that keep them alike but never identical: the spread rules and the
// distance matrix, with the set-spread verdict.

import { useState } from 'react';
import { checksPass, formatSpread, type SetDoc, type Sound } from '@soundclaw/core';
import type { Store } from './store.ts';
import { Spectrogram } from './Spectrogram.tsx';
import { Waveform } from './Waveform.tsx';

const randomSeed = (): number => Math.floor(Math.random() * 4294967296);

function Member({ store, sound, index }: { store: Store; sound: Sound; index: number }) {
  const m = store.measure(sound);
  const pass = checksPass(m.checks);
  const playing = store.playing === sound.id;
  const current = store.sequence?.ids[store.sequence.index] === sound.id;
  return (
    <article className={`card member${current ? ' current' : ''}`} data-testid={`member-${sound.id}`} data-current={current} data-hash={store.hashOf(sound)}>
      <header>
        <h2>{index + 1} {sound.id}</h2>
        <span className={`chip check-${pass ? 'pass' : 'fail'}`} data-testid={`member-check-${sound.id}`} data-pass={pass}>{pass ? '✓' : `✗ ${m.checks.filter((k) => !k.pass).map((k) => k.name).join(', ')}`}</span>
      </header>
      <Waveform samples={store.render(sound)} id={sound.id} />
      <Spectrogram spec={m.spec} id={sound.id} />
      <div className="dim analysis" data-testid={`member-numbers-${sound.id}`}>{m.analysis.duration.toFixed(2)} s · {Number.isFinite(m.analysis.lufs) ? m.analysis.lufs.toFixed(1) : '−∞'} LUFS</div>
      <div className="card-actions">
        <button className="play" data-testid={`member-play-${sound.id}`} data-playing={playing} onClick={() => void store.play(sound.id)}>{playing ? '■ Stop' : '▶ Play'}</button>
        <a className="button" href={`#/sound/${sound.id}`} data-testid={`member-edit-${sound.id}`}>Edit</a>
      </div>
    </article>
  );
}

export function SetPage({ store, set }: { store: Store; set: SetDoc }) {
  const [gap, setGap] = useState(400);
  const members = set.members.map((id) => store.sounds.find((s) => s.id === id)).filter((s): s is Sound => !!s);
  const measure = members.length >= 2 ? store.measureSet(set) : null;
  const sequencing = store.sequence !== null;
  const style = store.style;
  return (
    <section className="setpage" data-testid="set-page" data-set={set.id}>
      <header className="editor-head">
        <a href="#/" className="back" data-testid="back">← all sounds</a>
        <h2>set {set.id}</h2>
        {measure && <span className={`chip check-${measure.result.pass ? 'pass' : 'fail'}`} data-testid="set-check" data-pass={measure.result.pass}>{measure.result.pass ? '✓ set-spread' : '✗ set-spread'}</span>}
        <span className="dim" data-testid="set-info">{set.members.length} members{set.from ? ` from ${set.from}` : ''} · {set.target !== null ? `target ${set.target} LUFS` : 'no loudness target'} · seed <b data-testid="set-seed">{set.seed}</b></span>
        <span className="spacer" />
        <label className="dim">gap <input type="number" min={0} max={5000} step={50} value={gap} data-testid="set-gap" style={{ width: '5em' }} onChange={(e) => setGap(Math.max(0, Number(e.target.value)))} /> ms</label>
        <button className="play" data-testid="set-play-all" data-playing={sequencing} disabled={!members.length} onClick={() => void (sequencing ? store.stopSequence() : store.playSequence(members.map((m) => m.id), gap))}>{sequencing ? '■ Stop' : '▶ Play in sequence'}</button>
        <button data-testid="set-regen" disabled={!set.generated.length || !set.from} title="Make the generated members again from the source with a new seed" onClick={() => void store.run(`set regen ${set.id} seed=${randomSeed()}`)}>Regen with a new seed</button>
        <a className="button" href={`#/audition/${set.id}`} data-testid="set-audition">Audition</a>
      </header>
      {!members.length && <p className="dim">This set has no members.</p>}
      <div className="members" data-testid="members">
        {members.map((m, i) => <Member key={m.id} store={store} sound={m} index={i} />)}
      </div>
      <section className="panel" data-testid="spread-numbers" aria-label="Spread">
        <h3>The spread</h3>
        <div className="dim" data-testid="spread-rules">{set.spread.length ? <>rules: <code>{formatSpread(set.spread)}</code></> : 'no variation rules (the members are the sounds as they are)'}</div>
        {measure ? (
          <>
            <table className="matrix" data-testid="matrix">
              <thead><tr><th>dB apart</th>{members.map((m, j) => <th key={m.id} title={m.id}>{j + 1}</th>)}</tr></thead>
              <tbody>
                {members.map((a, i) => (
                  <tr key={a.id}>
                    <th title={a.id}>{i + 1} {a.id}</th>
                    {members.map((b, j) => {
                      const d = measure.matrix[i]![j]!;
                      const bad = i !== j && (d < style.setSpreadMin || d > style.setSpreadMax);
                      return <td key={b.id} data-testid={`dist-${i + 1}-${j + 1}`} data-bad={bad} className={i === j ? 'diag' : bad ? 'bad' : ''}>{i === j ? '–' : d.toFixed(1)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div data-testid="set-verdict" className={measure.result.pass ? '' : 'error'}>{measure.result.value}</div>
            <div className="dim">held to: {measure.result.threshold}</div>
            {measure.result.ranges.map((r, i) => <div key={i} className="error" data-testid="set-flag">{r.note}</div>)}
          </>
        ) : <p className="dim">A set needs two members to be compared.</p>}
      </section>
    </section>
  );
}
