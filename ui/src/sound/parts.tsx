// Pieces both sound editors share: the one-line numbers and the A/B comparison.

import { restoreCommand, type Sound } from '@soundclaw/core';
import type { Store } from '../store.ts';

export function Numbers({ store, sound }: { store: Store; sound: Sound }) {
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

export function AB({ store, sound }: { store: Store; sound: Sound }) {
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

