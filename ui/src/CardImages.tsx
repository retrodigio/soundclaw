// The thumbnails of a sound's card, from the server: asked for when the card comes into view (not
// before), drawn from the peaks and bytes it sends. The page never renders a sound for its card.

import { useEffect, useRef, useState } from 'react';
import type { Store } from './store.ts';
import { Spectrogram } from './Spectrogram.tsx';
import { Waveform } from './Waveform.tsx';

/** The card held for a sound, re-read when it changes; asks for it while the element is near the screen. */
export function useCard(store: Store, id: string, key: string): { ref: React.RefObject<HTMLDivElement | null>; card: ReturnType<Store['cardOf']> } {
  const ref = useRef<HTMLDivElement>(null);
  const [, bump] = useState(0);
  const [near, setNear] = useState(false);
  useEffect(() => store.subscribeCard(id, () => bump((n) => n + 1)), [store, id]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const io = new IntersectionObserver((es) => setNear(es.some((e) => e.isIntersecting)), { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  // asked for while near the screen, and again when the sound changes (its key moves on); given back
  // only when it was asked for (the library row may want the same card, and its claim must stand)
  useEffect(() => {
    if (!near) return;
    store.wantCard(id);
    return () => store.unwantCard(id);
  }, [store, id, key, near]);
  return { ref, card: store.cardOf(id) };
}

export function CardImages({ store, id, soundKey, waveId, specId, spec = true }: { store: Store; id: string; soundKey: string; waveId?: string; specId?: string; spec?: boolean }) {
  const { ref, card } = useCard(store, id, soundKey);
  return (
    <div ref={ref} className="thumbs">
      <Waveform wave={card?.wave} peak={card?.peak} id={waveId ?? id} />
      {spec && <Spectrogram spec={card?.spec} id={specId ?? id} />}
    </div>
  );
}
