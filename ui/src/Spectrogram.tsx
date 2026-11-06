// A spectrogram thumbnail: the sound's mel spectrogram, one pixel column per slice of time, low
// frequencies at the bottom, 80 dB below the loudest cell.

import { useEffect, useRef } from 'react';
import { INFERNO, SPEC_RANGE_DB, specMax, ramp, type MelSpec } from '@soundclaw/core';

export const SPEC_W = 240;
export const SPEC_H = 48;

export function Spectrogram({ spec, id }: { spec: MelSpec; id: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    const img = g.createImageData(SPEC_W, SPEC_H);
    const top = specMax(spec);
    const bands = spec.freqs.length;
    for (let x = 0; x < SPEC_W; x++) {
      const frame = Math.min(spec.db.length - 1, Math.floor((x / SPEC_W) * spec.db.length));
      for (let y = 0; y < SPEC_H; y++) {
        const band = Math.round(((SPEC_H - 1 - y) / (SPEC_H - 1)) * (bands - 1));
        const [r, gg, b] = ramp(INFERNO, (spec.db[frame]![band]! - (top - SPEC_RANGE_DB)) / SPEC_RANGE_DB);
        const o = (y * SPEC_W + x) * 4;
        img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }, [spec]);
  return <canvas ref={ref} className="spec" width={SPEC_W} height={SPEC_H} data-testid={`spec-${id}`} data-frames={spec.db.length} data-bands={bands(spec)} aria-label={`spectrogram of ${id}`} />;
}

const bands = (s: MelSpec): number => s.freqs.length;
