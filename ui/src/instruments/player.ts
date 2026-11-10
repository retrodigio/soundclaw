// Playing an instrument live: a key down renders the note (in the page, with core, the same bytes the server and a song render) and starts it; a key up
// fades a held note over the instrument's release, and starts its release samples (if it has any) for the time the key was held. The note is rendered held for
// HELD_GATE seconds, or for a fixed length the person chose, in which case it plays out as written. Several notes sound at once.

import { joinChannels, renderNote, samplesHash, velocityGain, zonesOf, type Instrument } from '@soundclaw/core';
import type { Store } from '../store.ts';
import { HELD_GATE } from './keymap.ts';

interface Sounding { src: AudioBufferSourceNode; gain: GainNode; held: boolean; release: number; inst: Instrument; vel: number; since: number }

export type NoteLength = 'held' | number;

/** Does this key play a release-sample zone? */
const hasRelease = (inst: Instrument, midi: number, vel: number): boolean => !!inst.zones?.some((z) => z.trigger === 'release') && zonesOf(inst, { midi, gate: 0, vel }).some((c) => c.zone.trigger === 'release');

export class LivePlayer {
  private readonly store: Store;
  private readonly cache = new Map<string, Float32Array[]>();
  private readonly sounding = new Map<number, Sounding>();

  constructor(store: Store) { this.store = store; }

  /** The notes sounding now (MIDI numbers). */
  get down(): number[] { return [...this.sounding.keys()]; }

  /** Render a note (kept for the next time: a repeated key costs nothing). */
  private chans(inst: Instrument, midi: number, vel: number, gate: number, part?: 'attack' | 'release'): Float32Array[] {
    const key = `${JSON.stringify(inst.zones ?? null)}${inst.id}|${midi}|${vel}|${gate}|${part ?? ''}`;
    const have = this.cache.get(key);
    if (have) return have;
    const made = renderNote(inst, { midi, gate, vel, ...(part ? { part } : {}) }, this.store.sampleBank);
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
    // a held note on an instrument with release samples is the attack zones now; the release zones are rendered at key up, when the length held is known
    const split = held && hasRelease(inst, midi, vel);
    const chans = this.chans(inst, midi, vel, held ? HELD_GATE : length, split ? 'attack' : undefined);
    const buf = ctx.createBuffer(chans.length, chans[0]!.length, 44100);
    chans.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = velocityGain(inst, vel);
    src.connect(gain);
    gain.connect(this.store.out());
    const s: Sounding = { src, gain, held, release: Math.min(1, Math.max(0.03, inst.release)), inst, vel, since: ctx.currentTime };
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
    if (!retrigger && hasRelease(s.inst, midi, s.vel)) this.playRelease(midi, s, ctx);
  }

  /** The release samples of a note that was held: rendered for the time it was held (to 50 ms), started at key up. */
  private playRelease(midi: number, s: Sounding, ctx: AudioContext): void {
    const held = Math.min(30, Math.max(0.05, Math.round((ctx.currentTime - s.since) * 20) / 20));
    const chans = this.chans(s.inst, midi, s.vel, held, 'release');
    const buf = ctx.createBuffer(chans.length, chans[0]!.length, 44100);
    chans.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = velocityGain(s.inst, s.vel);
    src.connect(gain);
    gain.connect(this.store.out());
    this.store.played.push({ id: s.inst.id, hash: samplesHash(joinChannels(chans)), samples: chans[0]!.length, key: `${s.inst.id}#live-release`, gain: 0 });
    // the buffer is silent until the note's end: begin where the key came up
    if (held < buf.duration) src.start(ctx.currentTime, held);
  }

  allOff(): void { for (const m of [...this.sounding.keys()]) this.noteOff(m, true); }
}
