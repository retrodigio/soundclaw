// Shared by the music tests: build a library from a command script, and render a song from it.

import { Library, applyCommand, lookupInstrument, parse, renderSong, type SongRender, type SongRenderOptions } from '../src/index.ts';

export function library(script: string): Library {
  const p = parse(script);
  if (p.errors.length) throw new Error(`script: ${p.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join('; ')}`);
  const lib = new Library();
  for (const c of p.commands) applyCommand(lib, c);
  return lib;
}

export function render(lib: Library, id: string, o: Partial<SongRenderOptions> = {}): SongRender {
  return renderSong(lib.songs.get(id)!, { instruments: (i) => lookupInstrument(lib, i), ...o });
}

/** A sine instrument with a flat envelope: a note is a clean tone at its own pitch. */
export const SINE = 'instrument new sine kind=osc\ninstrument set sine adsr=0.001,0,1,0.01 gain=0.5 velocity=0\n';

/** The index of the first sample whose magnitude is above `level`. */
export function firstAbove(x: Float32Array, level = 0.01): number {
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]!) > level) return i;
  return -1;
}
