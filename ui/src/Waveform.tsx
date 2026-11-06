// A waveform thumbnail: the min and max of each pixel column of the sound's samples.

import { useEffect, useRef } from 'react';
import { levels, peaks } from '@soundclaw/core';

export const WAVE_W = 240;
export const WAVE_H = 48;

export function Waveform({ samples, id }: { samples: Float32Array; id: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const peak = levels(samples).peak;
  useEffect(() => {
    const c = ref.current;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    g.clearRect(0, 0, WAVE_W, WAVE_H);
    g.fillStyle = '#58c4a6';
    // Scale to the full height only up to full scale: a quiet sound looks quiet.
    const p = peaks(samples, WAVE_W);
    const mid = WAVE_H / 2;
    for (let x = 0; x < WAVE_W; x++) {
      const top = mid - p.max[x]! * mid;
      const bottom = mid - p.min[x]! * mid;
      g.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
  }, [samples]);
  return <canvas ref={ref} className="wave" width={WAVE_W} height={WAVE_H} data-testid={`wave-${id}`} data-peak={peak.toFixed(4)} aria-label={`waveform of ${id}`} />;
}
