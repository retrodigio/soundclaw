// A waveform thumbnail: the min and max of each pixel column, from the sound's samples (the
// editors, which hold a render) or from the peaks the server sent (the cards).

import { useEffect, useRef } from 'react';
import { levels, peaks } from '@soundclaw/core';
import { usePrefs } from './studio/prefs.ts';

export const WAVE_W = 240;
export const WAVE_H = 48;

export interface WavePeaks { min: ArrayLike<number>; max: ArrayLike<number> }

export function Waveform({ samples, wave, peak, id }: { samples?: Float32Array; wave?: WavePeaks; peak?: number; id: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { theme, density } = usePrefs();
  const level = peak ?? (samples ? levels(samples).peak : undefined);
  useEffect(() => {
    const c = ref.current;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    g.clearRect(0, 0, WAVE_W, WAVE_H);
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--wave').trim() || '#888';
    // Scale to the full height only up to full scale: a quiet sound looks quiet.
    const p = wave ?? (samples ? peaks(samples, WAVE_W) : null);
    if (!p) return;
    const mid = WAVE_H / 2;
    for (let x = 0; x < WAVE_W; x++) {
      const top = mid - p.max[x]! * mid;
      const bottom = mid - p.min[x]! * mid;
      g.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
  }, [samples, wave, theme, density]);
  return <canvas ref={ref} className="wave" width={WAVE_W} height={WAVE_H} data-testid={`wave-${id}`} {...(level !== undefined ? { 'data-peak': level.toFixed(4) } : {})} aria-label={`waveform of ${id}`} />;
}
