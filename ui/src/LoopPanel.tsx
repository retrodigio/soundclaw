// The loop controls of a sound: make it a looping bed (a length and a crossfade), hear it repeat,
// and see the numbers of its seam. A change is a command, `sound loop <id> <seconds> fade=<s>`.

import { LOOP_FADE, LOOP_LENGTH, fmtStep, seamNumbers, type Sound } from '@soundclaw/core';
import type { Store } from './store.ts';

export function LoopPanel({ store, sound }: { store: Store; sound: Sound }) {
  const id = sound.id;
  if (sound.voice !== 'layered') {
    return (
      <section className="panel" data-testid="loop-panel" aria-label="Loop">
        <h3>Loop</h3>
        <p className="dim">A loop needs a layered sound. {sound.voice === 'classic' ? 'Make this one layered first (the same samples).' : ''}</p>
        {sound.voice === 'classic' && <button data-testid="loop-layer-up" onClick={() => void store.run(`sound layer-up ${id}`)}>Make layered</button>}
      </section>
    );
  }
  const loop = sound.loop;
  const looping = store.playing === `${id}#loop`;
  const seam = loop ? seamNumbers(store.render(sound)) : null;
  const write = (length: number, fade: number) => void store.run(`sound loop ${id} ${length} fade=${fade}`);
  return (
    <section className="panel" data-testid="loop-panel" data-loop={loop ? 'on' : 'off'} aria-label="Loop">
      <h3>Loop</h3>
      <label className="toggle">
        <input type="checkbox" data-testid="loop-on" checked={!!loop} onChange={(e) => void store.run(e.target.checked ? `sound loop ${id} 4 fade=${LOOP_FADE.default}` : `sound loop ${id} off`)} /> loop
      </label>
      {loop && (
        <>
          <div className="row wrap">
            <label>length (s)
              <input type="number" data-testid="loop-length" min={LOOP_LENGTH.min} max={LOOP_LENGTH.max} step={0.1} defaultValue={loop.length} key={`l${loop.length}`}
                onBlur={(e) => { const v = Number(e.target.value); if (v >= LOOP_LENGTH.min && v <= LOOP_LENGTH.max && v !== loop.length) write(v, Math.min(loop.fade, v / 2)); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
            </label>
            <label>crossfade (s)
              <input type="number" data-testid="loop-fade" min={LOOP_FADE.min} max={LOOP_FADE.max} step={0.05} defaultValue={loop.fade} key={`f${loop.fade}`}
                onBlur={(e) => { const v = Number(e.target.value); if (v >= LOOP_FADE.min && v <= Math.min(LOOP_FADE.max, loop.length / 2) && v !== loop.fade) write(loop.length, v); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
            </label>
          </div>
          <div className="row">
            <button className="play" data-testid="loop-play" data-playing={looping} onClick={() => void (looping ? store.stop() : store.playLoop(id))}>{looping ? '■ Stop' : '▶ Play looped'}</button>
          </div>
          {seam && (
            <div className="dim" data-testid="loop-seam" data-jump={seam.jump.toFixed(4)} data-step={seam.stepDb.toFixed(2)}>
              seam: jump {seam.jump.toFixed(3)} (local step {seam.local.toFixed(3)}), level step {fmtStep(seam.stepDb)} dB
            </div>
          )}
          <p className="dim">The sound is rendered {loop.fade} s past its end and that part is crossfaded over the start, so the end runs on into the start.</p>
        </>
      )}
    </section>
  );
}
