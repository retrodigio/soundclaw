// Hooks and small parts for the song page: the server's report for the song, the playback clock
// (the playhead moves in requestAnimationFrame by changing a style; React only hears when the
// step changes), and the playhead itself.

import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { SongDoc } from '@soundclaw/core';
import type { Store } from '../store.ts';
import type { SongReport } from './model.ts';

/** The server's numbers and checks for a song, fetched again (after a pause) whenever the song or an instrument it plays changes. The last report stays until the new one arrives. */
export function useSongReport(store: Store, song: SongDoc | undefined): SongReport | null {
  const [report, setReport] = useState<SongReport | null>(null);
  const key = song ? store.songKey(song) : '';
  const id = song?.id ?? '';
  const token = store.token;
  useEffect(() => {
    if (!id || !token) return;
    let live = true;
    const t = setTimeout(() => {
      void fetch(`/api/song/${id}.json?token=${encodeURIComponent(token)}`)
        .then((r) => (r.ok ? (r.json() as Promise<SongReport>) : null))
        .then((j) => { if (live && j) setReport(j); })
        .catch(() => undefined);
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [key, id, token]);
  return report && report.id === id ? report : null;
}

export interface StepAt { instance: number; pattern: string; section: string; step: number }
export type NowRef = MutableRefObject<number | null>;

/**
 * The playing song's clock. `nowRef` holds the time (read every frame by whatever draws it); `at`
 * is state that changes only when the step does. The root element gets `data-now` straight from
 * the frame loop, so a test can watch the clock without React rendering at frame rate.
 */
export function useSongClock(store: Store, song: SongDoc | undefined, playing: boolean, root: MutableRefObject<HTMLElement | null>): { at: StepAt | null; nowRef: NowRef } {
  const [at, setAt] = useState<StepAt | null>(null);
  const nowRef = useRef<number | null>(null);
  useEffect(() => {
    if (!song || !playing) {
      nowRef.current = null;
      root.current?.removeAttribute('data-now');
      setAt(null);
      return;
    }
    let raf = 0;
    const tick = (): void => {
      const t = store.songClock(song.id);
      nowRef.current = t;
      if (t === null) root.current?.removeAttribute('data-now'); else root.current?.setAttribute('data-now', t.toFixed(3));
      const a = t === null ? null : store.songStepAt(song, t);
      setAt((prev) => (prev === a || (prev && a && prev.instance === a.instance && prev.step === a.step) ? prev : a));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, song, store, root]);
  return { at, nowRef };
}

/** The line across the arrangement at the playing time, or at the cursor when nothing plays. Moved by style, one frame at a time. */
export function Playhead({ nowRef, cursor, total, playing }: { nowRef: NowRef; cursor: number | null; total: number; playing: boolean }) {
  const el = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const put = (t: number | null): void => {
      const e = el.current;
      if (!e) return;
      if (t === null || total <= 0) { e.hidden = true; return; }
      e.hidden = false;
      e.style.left = `${Math.min(100, (t / total) * 100)}%`;
      e.dataset.t = t.toFixed(3);
    };
    if (!playing) { put(cursor); return; }
    let raf = 0;
    const tick = (): void => { put(nowRef.current ?? cursor); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, cursor, total, nowRef]);
  return <span ref={el} className="arr-playhead" data-testid="order-cursor" hidden aria-hidden />;
}
