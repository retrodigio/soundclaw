// Playing an instrument live: a key down renders the note (in the page, with core, the same bytes the server and a song render) and starts it; a key up
// fades a held note over the instrument's release. The note is rendered held for HELD_GATE seconds, or for a fixed length the person chose, in which
// case it plays out as written (release samples included). Several notes sound at once.

import { joinChannels, renderNote, samplesHash, velocityGain, type Instrument } from '@soundclaw/core';
import type { Store } from '../store.ts';
import { HELD_GATE } from './keymap.ts';

interface Sounding { src: AudioBufferSourceNode; gain: GainNode; held: boolean; release: number }

export type NoteLength = 'held' | number;

export class LivePlayer {
  private readonly store: Store;
  private readonly cache = new Map<string, Float32Array[]>();
  private readonly sounding = new Map<number, Sounding>();

  constructor(store: Store) { this.store = store; }

  /** The notes sounding now (MIDI numbers). */
  get down(): number[] { return [...this.sounding.keys()]; }

  /** Render a note (kept for the next time: a repeated key costs nothing). */
  private chans(inst: Instrument, midi: number, vel: number, gate: number): Float32Array[] {
    const key = `${JSON.stringify(inst.zones ?? null)}${inst.id}|${midi}|${vel}|${gate}`;
    const have = this.cache.get(key);
    if (have) return have;
    const made = renderNote(inst, { midi, gate, vel }, this.store.sampleBank);
    this.cache.set(key, made);
    if (this.cache.size > 96) this.cache.delete(this.cache.keys().next().value!);
    return made;
  }

  /** Forget the rendered notes (the instrument or its samples changed). */
  clear(): void { this.cache.clear(); }

  async noteOn(inst: Instrument, midi: number, vel: number, length: NoteLength): Promise<void> {
    this.noteOff(midi, true);
    const ctx = this.store.audioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const held = length === 'held';
    const chans = this.chans(inst, midi, vel, held ? HELD_GATE : length);
    const buf = ctx.createBuffer(chans.length, chans[0]!.length, 44100);
    chans.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = velocityGain(inst, vel);
    src.connect(gain);
    gain.connect(this.store.out());
    const s: Sounding = { src, gain, held, release: Math.min(1, Math.max(0.03, inst.release)) };
    this.sounding.set(midi, s);
    src.onended = () => { if (this.sounding.get(midi) === s) this.sounding.delete(midi); };
    // what was played, for the tests and for anyone curious: the same record a song or a sound leaves
    this.store.played.push({ id: inst.id, hash: samplesHash(joinChannels(chans)), samples: chans[0]!.length, key: `${inst.id}#live`, gain: 0 });
    src.start();
    this.store.changed();
  }

  /** A key up: a held note fades over the instrument's release (a fixed-length note plays out). */
  noteOff(midi: number, retrigger = false): void {
    const s = this.sounding.get(midi);
    if (!s) return;
    if (!s.held && !retrigger) return;
    const ctx = this.store.audioContext();
    const fade = retrigger ? 0.02 : s.release;
    s.gain.gain.cancelScheduledValues(ctx.currentTime);
    s.gain.gain.setValueAtTime(s.gain.gain.value, ctx.currentTime);
    s.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + fade);
    try { s.src.stop(ctx.currentTime + fade + 0.01); } catch { /* not started */ }
    this.sounding.delete(midi);
  }

  allOff(): void { for (const m of [...this.sounding.keys()]) this.noteOff(m, true); }
}
