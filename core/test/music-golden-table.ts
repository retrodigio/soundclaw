// The scripts whose rendered songs are hashed in the music goldens, and a function that renders them all.

import { Library, applyCommand, joinChannels, lookupInstrument, parse, renderNote, renderSong, samplesHash, builtinInstruments, BUILTIN_NAMES } from '../src/index.ts';

// a pattern file holds rows for several channels; one script per pattern of the song
export const TABLE: Record<string, string> = {
  'drums-and-bass': `song new g tempo=100
song channel add g bass inst=triangle_bass
song channel add g drums kit=default
pattern g.p steps=16 tpb=4
  bass: C3 . . . G2 . . . A2 . . . F2 . . .
  drums: k . h . s . h . k . k . s . h h
song section add g A p x2
`,
  'chip-four': `song new g tempo=96 swing=0.1 key=C:major
song channel add g lead inst=pulse_lead
song channel add g bass inst=triangle_bass
song channel add g arp inst=square_lead gain=0.4 pan=0.3
song channel add g drums kit=default
pattern g.p steps=16 tpb=4
  lead: C5 . E5 . G5v80 - - . A4~slide . E4~vib . C5 - . .
  bass: C3 . . . G2 . . . A2 . . . F2 . . .
  arp: A3~arp(0,3,7) - - - C4~arp(0,4,7) - - - E4~arp(0,3,7) - - - G3~arp(0,4,7) - - -
  drums: k . h . s . h . k . k . s . h h
song section add g A p x2
song loop g A
`,
  'pad-and-bells': `song new g tempo=72
song channel add g pad inst=saw_pad layer=base
song channel add g bell inst=fm_bell layer=tension
song channel add g pluck inst=pluck pan=-0.3
pattern g.p steps=16 tpb=4
  pad: C4+E4+G4 - - - - - - - F3+A3+C4 - - - - - - -
  bell: E5 . . . . . G5 . . . . . C6 . . .
  pluck: C3 . G3 . C4 . G3 . F3 . C4 . F4 . C4 .
song section add g A p
song intro g A
song section add g B p
`,
  'fm-bass-intro-ending': `song new g tempo=140 time=3/4
song channel add g bass inst=fm_bass
song channel add g hats kit=default
pattern g.p steps=12 tpb=4 bar=12
  bass: A2 . . . A2 . . . E2 . . .
  hats: h . h . h . h . h . oh .
song section add g in p
song section add g body p x2
song section add g out p
song intro g in
song ending g out
`,
};

export function hashes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, script] of Object.entries(TABLE)) {
    const lib = new Library();
    const p = parse(script);
    if (p.errors.length) throw new Error(`${name}: ${p.errors[0]!.message} (line ${p.errors[0]!.line})`);
    for (const c of p.commands) applyCommand(lib, c);
    const song = lib.songs.get('g')!;
    const r = renderSong(song, { instruments: (i) => lookupInstrument(lib, i) });
    out[`${name}`] = samplesHash(joinChannels(r.mix));
    for (const part of r.parts) out[`${name}/${part.name}`] = samplesHash(joinChannels(part.channels));
    try {
      const l = renderSong(song, { instruments: (i) => lookupInstrument(lib, i), mode: 'loop' });
      out[`${name}#loop`] = samplesHash(joinChannels(l.mix));
    } catch {
      // no loop region
    }
  }
  // every built-in, one note at its middle pitch
  for (const n of BUILTIN_NAMES) {
    const inst = builtinInstruments()[n]!;
    const note = inst.range ? Math.round((inst.range[0] + inst.range[1]) / 2) : 60;
    out[`builtin:${n}`] = samplesHash(joinChannels(renderNote(inst, { midi: note, gate: 0.3 })));
  }
  return out;
}
