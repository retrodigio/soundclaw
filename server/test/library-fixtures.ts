// A sample library made by test code: folders of generated one-shots (nothing third-party), plus the odd files an index must cope with.

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pcmFromFloats, pcmToWav } from '@soundclaw/core';
import { signal, type Kind } from '../../core/test/library-signals.ts';
import { smplChunk, wavBytes } from '../../core/test/audio-fixtures.ts';

export function put(root: string, rel: string, bytes: Uint8Array | string): string {
  const p = join(root, ...rel.split('/'));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, bytes);
  return p;
}

export function wavOf(kind: Kind, seed: number, seconds: number, rate = 22050): Uint8Array {
  return pcmToWav(pcmFromFloats([signal(kind, seed, seconds, rate)], rate));
}

/** The files of the small library most tests use (paths relative to its root). */
export const SMALL: { path: string; kind: Kind; seed: number; secs: number }[] = [
  { path: 'doors/creak_01.wav', kind: 'creak', seed: 1, secs: 1.2 },
  { path: 'doors/creak_02.wav', kind: 'creak', seed: 2, secs: 2.4 },
  { path: 'doors/Slam_01.wav', kind: 'slam', seed: 3, secs: 0.6 },
  { path: 'bells/BellHigh.wav', kind: 'bell', seed: 4, secs: 1.5 },
  { path: 'weather/rain_loop.wav', kind: 'rain', seed: 5, secs: 2 },
  { path: 'weather/Thunder Rumble.wav', kind: 'rain', seed: 6, secs: 3 },
  { path: 'clicks/ticks.wav', kind: 'clicks', seed: 7, secs: 1 },
];

/** Write the small library, a tone with a root note and a loop in its chunks, and files an index has to skip or report. */
export function makeSmallLibrary(root: string, outside: string): void {
  for (const f of SMALL) put(root, f.path, wavOf(f.kind, f.seed, f.secs));
  const tone = pcmFromFloats([signal('tone', 1, 1, 22050)], 22050);
  put(root, 'tones/c4_sustain.wav', wavBytes(tone, { before: [smplChunk({ note: 60, loop: { start: 2000, end: 20000 } })] }));
  put(root, 'broken/bad.wav', 'this is not a wave file');
  put(root, 'broken/voice.mp3', 'not an mp3 either');
  put(root, 'notes.txt', 'not audio');
  put(root, '.hidden/secret.wav', wavOf('slam', 9, 0.3));
  put(root, '._creak_01.wav', 'apple double');
  // a folder link to somewhere else: neither listed nor followed
  put(outside, 'elsewhere/outside.wav', wavOf('bell', 8, 0.5));
  symlinkSync(join(outside, 'elsewhere'), join(root, 'linked'), 'dir');
}

/** `n` short one-shots in folders of fifty, of the six kinds in turn. */
export function makeBigLibrary(root: string, n: number): void {
  const kinds: Kind[] = ['creak', 'bell', 'slam', 'tone', 'rain', 'clicks'];
  for (let i = 0; i < n; i++) {
    const kind = kinds[i % kinds.length]!;
    put(root, `pack${String(Math.floor(i / 50)).padStart(2, '0')}/${kind}_${String(i).padStart(4, '0')}.wav`, wavOf(kind, i + 1, 0.3 + (i % 7) * 0.1, 22050));
  }
}
