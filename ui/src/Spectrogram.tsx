// A spectrogram thumbnail: the sound's mel spectrogram, one pixel column per slice of time, low
// frequencies at the bottom, 80 dB below the loudest cell. The cards draw the bytes the server
// worked out (one per cell, 0 to 255 over the 80 dB).

import { useEffect, useRef } from 'react';
import { SPEC_RANGE_DB, specMax, type MelSpec } from '@soundclaw/core';
import type { CardInfo } from '@soundclaw/server/protocol';
import { specLut } from './studio/specColor.ts';
import { usePrefs } from './studio/prefs.ts';

export const SPEC_W = 240;
export const SPEC_H = 48;

export function Spectrogram({ spec, id }: { spec?: CardInfo['spec']; id: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { theme } = usePrefs();
  useEffect(() => {
    const c = ref.current;
    const g = c?.getContext('2d');
    if (!c || !g || !spec) return;
    const bytes = Uint8Array.from(atob(spec.data), (ch) => ch.charCodeAt(0));
    const img = g.createImageData(spec.w, spec.h);
    const lut = specLut();
    for (let i = 0; i < spec.w * spec.h; i++) {
      const v = bytes[i]! * 3;
      img.data[i * 4] = lut[v]!; img.data[i * 4 + 1] = lut[v + 1]!; img.data[i * 4 + 2] = lut[v + 2]!; img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }, [spec, theme]);
  return <canvas ref={ref} className="spec" width={SPEC_W} height={SPEC_H} data-testid={`spec-${id}`} {...(spec ? { 'data-frames': spec.frames, 'data-bands': spec.bands } : {})} aria-label={`spectrogram of ${id}`} />;
}

/** A spectrogram drawn from a spectrogram measured here (the editors, which render the sound they edit). */
export function MelSpectrogram({ spec, id }: { spec: MelSpec; id: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { theme } = usePrefs();
  useEffect(() => {
    const c = ref.current;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    const img = g.createImageData(SPEC_W, SPEC_H);
    const top = specMax(spec);
    const bands = spec.freqs.length;
    const lut = specLut();
    for (let x = 0; x < SPEC_W; x++) {
      const frame = Math.min(spec.db.length - 1, Math.floor((x / SPEC_W) * spec.db.length));
      for (let y = 0; y < SPEC_H; y++) {
        const band = Math.round(((SPEC_H - 1 - y) / (SPEC_H - 1)) * (bands - 1));
        const t = (spec.db[frame]![band]! - (top - SPEC_RANGE_DB)) / SPEC_RANGE_DB;
        const v = Math.round(255 * (t < 0 ? 0 : t > 1 ? 1 : t)) * 3;
        const o = (y * SPEC_W + x) * 4;
        img.data[o] = lut[v]!; img.data[o + 1] = lut[v + 1]!; img.data[o + 2] = lut[v + 2]!; img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }, [spec, theme]);
  return <canvas ref={ref} className="spec" width={SPEC_W} height={SPEC_H} data-testid={`spec-${id}`} data-frames={spec.db.length} data-bands={bands(spec)} aria-label={`spectrogram of ${id}`} />;
}

const bands = (s: MelSpec): number => s.freqs.length;
