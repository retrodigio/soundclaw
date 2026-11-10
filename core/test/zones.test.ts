// Sampled instruments: zones chosen by key and velocity, pitched from their roots, looped, released, taking turns, choked and
// crossfaded. Every sample here is generated from integers and the engine's own sine; nothing is read from disk.

import { describe, expect, it } from 'vitest';
import {
  Library, SAMPLE_RATE, applyCommand, instrumentKey, lookupInstrument, noteSound, noteSoundWith, parse, renderNote, renderSong, serializeInstrument, sinRad, velocityWeight, yinPitch,
  chooseZones, newZone, renderMatch, renderStems, mixParts, type PartStore, type SampleBank, type SampleData,
} from '../src/index.ts';

const SR = SAMPLE_RATE;
const TAU = 6.283185307179586;

/** A tone at `hz` for `secs`, steady (so a loop inside it is seamless), as sample data at the engine's rate. */
function tone(hz: number, secs: number, extra: Partial<SampleData> = {}): SampleData {
  const n = Math.round(secs * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * sinRad(TAU * hz * (i / SR));
  return { rate: SR, data: x, ...extra };
}

/** Short noise burst: distinct from a tone, for choke and round-robin tests. */
function burst(seed: number, secs: number, level = 0.5): SampleData {
  const n = Math.round(secs * SR);
  const x = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; x[i] = (s / 4294967296 * 2 - 1) * level * (1 - i / n); }
  return { rate: SR, data: x };
}

export function bankOf(data: Record<string, SampleData>): SampleBank {
  return { get: (n) => data[n], hash: (n) => (data[n] ? `test-${n}` : undefined) };
}

function lib(script: string): Library {
  const p = parse(script);
  if (p.errors.length) throw new Error(p.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join('; '));
  const l = new Library();
  for (const c of p.commands) applyCommand(l, c);
  return l;
}

const hzOf = (x: Float32Array, from = 0.05): number => {
  const seg = x.subarray(Math.round(from * SR), Math.round(from * SR) + 8192);
  const frames = yinPitch(seg, { hop: 1024, fmin: 60, fmax: 2000 }).filter((f) => f.hz !== null);
  return frames.map((f) => f.hz!).sort((a, b) => a - b)[Math.floor(frames.length / 2)]!;
};
const rms = (x: Float32Array, a: number, b: number): number => {
  let s = 0;
  const i0 = Math.round(a * SR), i1 = Math.min(x.length, Math.round(b * SR));
  for (let i = i0; i < i1; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, i1 - i0));
};

describe('zones', () => {
  const A3 = tone(220, 1);
  const bank = bankOf({ a3: A3 });

  it('plays a sample at note - root + tune semitones', () => {
    const l = lib('instrument new s kind=zones\ninstrument zone add s sample=a3 root=A3 keys=A2-A5');
    const s = lookupInstrument(l, 's')!;
    expect(hzOf(renderNote(s, { midi: 57, gate: 0.4 }, bank)[0]!)).toBeCloseTo(220, 0);
    expect(hzOf(renderNote(s, { midi: 69, gate: 0.4 }, bank)[0]!)).toBeCloseTo(440, 0);
    expect(hzOf(renderNote(s, { midi: 45, gate: 0.4 }, bank)[0]!)).toBeCloseTo(110, 0);
    // tune: +100 cents is one semitone up
    const t = lib('instrument new s kind=zones\ninstrument zone add s sample=a3 root=A3 keys=A2-A5 tune=100');
    expect(hzOf(renderNote(lookupInstrument(t, 's')!, { midi: 57, gate: 0.4 }, bank)[0]!)).toBeCloseTo(233.08, 0);
  });

  it('the instrument does not add note - root again for zones (its own root is ignored)', () => {
    const l = lib('instrument new s kind=zones\ninstrument set s root=C2\ninstrument zone add s sample=a3 root=A3 keys=A2-A5');
    expect(hzOf(renderNote(lookupInstrument(l, 's')!, { midi: 57, gate: 0.4 }, bank)[0]!)).toBeCloseTo(220, 0);
  });

  it('a key outside every zone is silent', () => {
    const l = lib('instrument new s kind=zones\ninstrument zone add s sample=a3 root=A3 keys=A3-A3');
    const out = renderNote(lookupInstrument(l, 's')!, { midi: 70, gate: 0.2 }, bank)[0]!;
    expect(rms(out, 0, 1)).toBe(0);
  });

  it('picks a velocity layer by velocity', () => {
    const l = lib('instrument new s kind=zones\ninstrument zone add s sample=a3 root=A3 keys=A3-A3 vel=1-63 gain=-12\ninstrument zone add s sample=a3 root=A3 keys=A3-A3 vel=64-127');
    const s = lookupInstrument(l, 's')!;
    const soft = renderNote(s, { midi: 57, gate: 0.3, vel: 40 }, bank)[0]!;
    const loud = renderNote(s, { midi: 57, gate: 0.3, vel: 100 }, bank)[0]!;
    expect(rms(loud, 0.05, 0.25) / rms(soft, 0.05, 0.25)).toBeCloseTo(4, 0);
  });

  it('crosses neighbouring velocity layers at equal power', () => {
    const a = { ...newZone('x', 60), vel: [1, 63] as [number, number] };
    const b = { ...newZone('x', 60), vel: [64, 127] as [number, number] };
    for (const v of [60, 62, 63, 64, 65, 67]) {
      const wa = velocityWeight(a, v, 8), wb = velocityWeight(b, v, 8);
      expect(wa * wa + wb * wb).toBeCloseTo(1, 6);
    }
    expect(velocityWeight(a, 20, 8)).toBe(1);
    expect(velocityWeight(b, 20, 8)).toBe(0);
    expect(velocityWeight(a, 120, 8)).toBe(0);
    // without a crossfade the boundary is hard
    expect(velocityWeight(a, 64, 0)).toBe(0);
    expect(velocityWeight(a, 63, 0)).toBe(1);
    const l = lib('instrument new s kind=zones\ninstrument set s velxfade=8\ninstrument zone add s sample=a3 root=A3 keys=A3-A3 vel=1-63\ninstrument zone add s sample=a3 root=A3 keys=A3-A3 vel=64-127');
    const s = lookupInstrument(l, 's')!;
    expect(chooseZones(s.zones!, { midi: 57, vel: 63 }, s.velxfade!)).toHaveLength(2);
    expect(chooseZones(s.zones!, { midi: 57, vel: 20 }, s.velxfade!)).toHaveLength(1);
  });

  it('a sustain loop holds as long as the key does, then plays on from the loop', () => {
    // a 0.6 s sample with a loop in its middle: held for 2 s it still sounds at 1.5 s
    const looped = tone(220, 0.6, { loop: [4410, 17640] });
    const b = bankOf({ lp: looped });
    const l = lib('instrument new s kind=zones\ninstrument set s adsr=0.002,0,1,0.05\ninstrument zone add s sample=lp root=A3 keys=A3-A3 loopmode=sustain');
    const s = lookupInstrument(l, 's')!;
    const held = renderNote(s, { midi: 57, gate: 2 }, b)[0]!;
    expect(rms(held, 1.4, 1.6)).toBeGreaterThan(0.2);
    expect(hzOf(held, 1.3)).toBeCloseTo(220, 0);
    // without a loop the sample ends and the rest is silence
    const none = lib('instrument new s kind=zones\ninstrument set s adsr=0.002,0,1,0.05\ninstrument zone add s sample=lp root=A3 keys=A3-A3 loopmode=none');
    const plain = renderNote(lookupInstrument(none, 's')!, { midi: 57, gate: 2 }, b)[0]!;
    expect(rms(plain, 1.4, 1.6)).toBe(0);
  });

  it('a continuous loop goes on through the release; a one-shot ignores the key length', () => {
    const looped = tone(220, 0.6, { loop: [4410, 17640] });
    const b = bankOf({ lp: looped, hit: burst(3, 0.5) });
    const cont = lib('instrument new s kind=zones\ninstrument set s adsr=0.002,0,1,1\ninstrument zone add s sample=lp root=A3 keys=A3-A3 loopmode=continuous');
    const c = renderNote(lookupInstrument(cont, 's')!, { midi: 57, gate: 0.3 }, b)[0]!;
    expect(rms(c, 0.35, 0.45)).toBeGreaterThan(0.02);
    const one = lib('instrument new h kind=zones\ninstrument zone add h sample=hit root=C3 keys=C3-C3 loopmode=oneshot');
    const h = renderNote(lookupInstrument(one, 'h')!, { midi: 48, gate: 0.02 }, b)[0]!;
    expect(h.length).toBeGreaterThan(Math.round(0.45 * SR));
    expect(rms(h, 0.1, 0.2)).toBeGreaterThan(0.01);
  });

  it('a release zone starts when the key is let go, lowered by release-decay for every second it was held', () => {
    const b = bankOf({ a3: A3, rel: burst(9, 0.2, 0.8) });
    const mk = (decay: number): ReturnType<typeof lookupInstrument> => lookupInstrument(lib(`instrument new s kind=zones\ninstrument set s adsr=0.002,0,1,0.05\ninstrument zone add s sample=a3 root=A3 keys=A3-A3\ninstrument zone add s sample=rel root=A3 keys=A3-A3 trigger=release release-decay=${decay}`), 's');
    const short = renderNote(mk(6)!, { midi: 57, gate: 0.5 }, b)[0]!;
    // the release sample's burst begins at 0.5 s, after the key is up
    expect(rms(short, 0.52, 0.6)).toBeGreaterThan(0.02);
    const held1 = rms(renderNote(mk(6)!, { midi: 57, gate: 0.5 }, b)[0]!, 0.51, 0.55);
    const held2 = rms(renderNote(mk(6)!, { midi: 57, gate: 1.5 }, b)[0]!, 1.51, 1.55);
    // 1 second longer is 6 dB quieter
    expect(held1 / held2).toBeGreaterThan(1.8);
    expect(held1 / held2).toBeLessThan(2.3);
    // without a decay it is the same level
    const f1 = rms(renderNote(mk(0)!, { midi: 57, gate: 0.5 }, b)[0]!, 0.51, 0.55);
    const f2 = rms(renderNote(mk(0)!, { midi: 57, gate: 1.5 }, b)[0]!, 1.51, 1.55);
    expect(f1 / f2).toBeCloseTo(1, 1);
  });

  it('a kit instrument is keyed by hit name, not by pitch', () => {
    const b = bankOf({ k: burst(1, 0.2), s: burst(2, 0.2, 0.2) });
    const l = lib('instrument new kit kind=zones\ninstrument set kit pitched=no\ninstrument zone add kit sample=k root=C3 hit=kick loopmode=oneshot\ninstrument zone add kit sample=s root=C3 hit=snare loopmode=oneshot');
    const kit = lookupInstrument(l, 'kit')!;
    const kick = renderNote(kit, { midi: 69, gate: 0.05, hit: 'kick' }, b)[0]!;
    const snare = renderNote(kit, { midi: 69, gate: 0.05, hit: 'snare' }, b)[0]!;
    expect(rms(kick, 0, 0.1)).toBeGreaterThan(rms(snare, 0, 0.1) * 1.5);
    expect(rms(renderNote(kit, { midi: 69, gate: 0.05, hit: 'tom' }, b)[0]!, 0, 0.2)).toBe(0);
  });

  it('a zones instrument sits beside synth layers, under the same note envelope and effects', () => {
    const l = lib('instrument new m from=square_lead\ninstrument zone add m sample=a3 root=A3 keys=A3-A3');
    const m = lookupInstrument(l, 'm')!;
    expect(m.voice.layers).toHaveLength(1);
    const sound = noteSound(m, { midi: 57, gate: 0.3 });
    expect(sound.layers).toHaveLength(1);
    const withZones = noteSoundWith(m, { midi: 57, gate: 0.3 }, bank).sound;
    expect(withZones.layers).toHaveLength(2);
    expect(withZones.layers[1]!.kind).toBe('sample');
    expect(withZones.layers[1]!.amp).toEqual(withZones.layers[0]!.amp);
  });

  it('an instrument without zones keeps its key and its text', () => {
    const l = lib('instrument new q from=pluck');
    const i = lookupInstrument(l, 'q')!;
    expect(i.zones).toBeUndefined();
    expect(serializeInstrument(i)).not.toMatch(/zone/);
    const withEmpty = { ...i, zones: [] };
    expect(instrumentKey(withEmpty)).toBe(instrumentKey(i));
  });
});

describe('zone commands', () => {
  it('write a zone in its normal form, with the sample entry\'s root when none is given', () => {
    const l = new Library();
    const run = (t: string): string | undefined => { const p = parse(t); if (p.errors.length) throw new Error(p.errors[0]!.message); return applyCommand(l, p.commands[0]!); };
    run('sample add tone hash=' + 'a'.repeat(64) + ' rate=44100 channels=1 frames=44100 format=pcm16 root=A3 tune=12');
    run('instrument new s kind=zones');
    expect(run('instrument zone add s sample=tone keys=C3-C5')).toBe('instrument zone add s sample=tone root=A3 tune=-12 keys=C3-C5');
    expect(() => run('instrument zone add s sample=other keys=C3-C5')).toThrow(/root=<note> is needed/);
    run('instrument zone set s 1 gain=-3 loopmode=oneshot rr=1/2');
    expect(serializeInstrument(l.instruments.get('s')!)).toMatch(/^zone 1 sample=tone root=A3 tune=-12 keys=C3-C5 gain=-3 loopmode=oneshot rr=1\/2$/m);
    expect(() => run('instrument zone set s 4 gain=1')).toThrow(/no zone 4/);
    run('instrument zone remove s 1');
    expect(l.instruments.get('s')!.zones).toEqual([]);
  });

  it('hold up to 4096 zones, render a note from them, and refuse the next one saying so', () => {
    const l = new Library();
    const run = (t: string): void => { const p = parse(t); if (p.errors.length) throw new Error(p.errors[0]!.message); applyCommand(l, p.commands[0]!); };
    run('sample add tone hash=' + 'a'.repeat(64) + ' rate=44100 channels=1 frames=44100 format=pcm16 root=A3');
    run('instrument new big kind=zones');
    // 128 keys by 32 velocity layers
    for (let key = 0; key < 128; key++) for (let v = 0; v < 32; v++) run(`instrument zone add big sample=tone root=A3 keys=${key}-${key} vel=${v * 4 + 1}-${Math.min(127, v * 4 + 4)}`);
    const big = l.instruments.get('big')!;
    expect(big.zones).toHaveLength(4096);
    const chs = renderNote(lookupInstrument(l, 'big')!, { midi: 57, gate: 0.2, vel: 100 }, bankOf({ tone: tone(220, 1) }));
    expect(chs[0]!.length).toBeGreaterThan(0);
    expect(rms(chs[0]!, 0.05, 0.15)).toBeGreaterThan(0.01);
    expect(() => run('instrument zone add big sample=tone root=A3 keys=0-0')).toThrow(/at most 4096 zones/);
  });

  it('refuse a bad setting where it is written', () => {
    for (const [text, msg] of [
      ['instrument zone add s sample=a root=H9', /root is a note/],
      ['instrument zone add s sample=a root=C4 vel=0-5', /vel is a range/],
      ['instrument zone add s sample=a root=C4 loopmode=bounce', /loopmode is one of/],
      ['instrument zone add s sample=a root=C4 rr=3/2', /rr is take\/takes/],
      ['instrument zone add s sample=a root=C4 pan=3', /pan must be/],
      ['instrument zone add s sample=a root=C4 colour=red', /no zone setting 'colour'/],
      ['instrument zone add s root=C4', /sample=<name> is needed/],
      ['instrument set s velxfade=200', /velxfade must be/],
      ['instrument set s rr=random', /rr is cycle/],
    ] as const) {
      const p = parse(text);
      expect(p.errors[0]?.message, text).toMatch(msg);
    }
  });

  it('a placeholder sample layer goes when the first zone arrives (kind=sample)', () => {
    const l = lib('instrument new r kind=sample\ninstrument zone add r sample=a root=C4');
    expect(l.instruments.get('r')!.voice.layers).toHaveLength(0);
    const keep = lib('instrument new r kind=sample\ninstrument layer set r 1 sample=a\ninstrument zone add r sample=a root=C4');
    expect(keep.instruments.get('r')!.voice.layers).toHaveLength(1);
  });

  it('channels can name one kit instrument for every hit', () => {
    const l = lib('instrument new kit kind=zones\nsong new d tempo=120\nsong channel add d drums kit=kit');
    expect(l.songs.get('d')!.channels[0]!.kit).toEqual({ '*': 'kit' });
    const again = lib('instrument new kit kind=zones\nsong new d tempo=120\nsong channel add d drums kit=k:kit,s:kit');
    expect(again.songs.get('d')!.channels[0]!.kit).toEqual({ k: 'kit', s: 'kit' });
  });
});

describe('zones in a song', () => {
  const data = { a3: tone(220, 1), r1: burst(1, 0.15), r2: burst(2, 0.15), r3: burst(3, 0.15), hatc: burst(5, 0.1), hato: burst(6, 1.2) };
  const bank = bankOf(data);

  const SONG_SCRIPT_HEAD = `instrument new rr kind=zones
instrument zone add rr sample=r1 root=C3 keys=C3-C3 rr=1/3 loopmode=oneshot
instrument zone add rr sample=r2 root=C3 keys=C3-C3 rr=2/3 loopmode=oneshot
instrument zone add rr sample=r3 root=C3 keys=C3-C3 rr=3/3 loopmode=oneshot
instrument new hats kind=zones
instrument set hats pitched=no
instrument zone add hats sample=hatc root=C3 hit=hc choke=1 loopmode=oneshot
instrument zone add hats sample=hato root=C3 hit=ho choke=1 loopmode=oneshot
song new t tempo=120
song channel add t a inst=rr
song channel add t h kit=hats
pattern t.p steps=16 tpb=4`;

  const song = (extra: string, rows: string): Library => lib(`instrument new rr kind=zones
instrument zone add rr sample=r1 root=C3 keys=C3-C3 rr=1/3 loopmode=oneshot
instrument zone add rr sample=r2 root=C3 keys=C3-C3 rr=2/3 loopmode=oneshot
instrument zone add rr sample=r3 root=C3 keys=C3-C3 rr=3/3 loopmode=oneshot
instrument new hats kind=zones
instrument set hats pitched=no
instrument zone add hats sample=hatc root=C3 hit=hc choke=1 loopmode=oneshot
instrument zone add hats sample=hato root=C3 hit=ho choke=1 loopmode=oneshot
song new t tempo=120
song channel add t a inst=rr
song channel add t h kit=hats
${extra}
pattern t.p steps=16 tpb=4
${rows}
song section add t x p
`);

  const RR = '  a: C3 - C3 - C3 - C3 - C3 - C3 - C3 - C3 -\n';

  it('round robins take turns within a pattern placement', () => {
    const l = song('', RR);
    const r = renderSong(l.songs.get('t')!, { instruments: (i) => lookupInstrument(l, i), bank });
    const ch = r.parts.find((p) => p.name === 'a')!.channels[0]!;
    // the 8 notes are r1 r2 r3 r1 r2 r3 r1 r2: the first three differ from one another, the fourth repeats the first
    const note = (k: number): Float32Array => ch.slice(Math.round(k * 0.25 * SR), Math.round(k * 0.25 * SR) + 3000);
    const same = (a: Float32Array, b: Float32Array): boolean => a.every((v, i) => Math.abs(v - b[i]!) < 1e-6);
    expect(same(note(0), note(1))).toBe(false);
    expect(same(note(1), note(2))).toBe(false);
    expect(same(note(0), note(3))).toBe(true);
    expect(same(note(1), note(4))).toBe(true);
  });

  it('a partial re-render of a round-robin channel is byte-identical to the full one', () => {
    const l = song('', RR + '  h: hc . . . . . . . hc . . . hc . . .\n');
    const store = new Map<string, Float32Array>();
    const parts: PartStore = { get: (k) => store.get(k) ?? null, put: (k, v) => { store.set(k, v); } };
    const instruments = (i: string): ReturnType<typeof lookupInstrument> => lookupInstrument(l, i);
    const full = renderSong(l.songs.get('t')!, { instruments, bank, store: parts });
    expect(full.cached).toBe(0);
    // the other channel changes; this one comes from the store, byte for byte
    const edited = lib(`${SONG_SCRIPT_HEAD}\n  a: C3 - C3 - C3 - C3 - C3 - C3 - C3 - C3 -\n  h: hc . . . hc . . . hc . . . hc . . .\nsong section add t x p\n`);
    const again = renderSong(edited.songs.get('t')!, { instruments: (i) => lookupInstrument(edited, i), bank, store: parts, notes: new Map() });
    expect(again.cached).toBe(1);
    const same = (a: Float32Array, b: Float32Array): boolean => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
    expect(same(again.parts[0]!.channels[0]!, full.parts[0]!.channels[0]!)).toBe(true);
    // and rendered again from nothing it is the same bytes as the full render's
    const cold = renderSong(l.songs.get('t')!, { instruments, bank, notes: new Map() });
    expect(same(cold.parts[0]!.channels[0]!, full.parts[0]!.channels[0]!)).toBe(true);
    expect(same(cold.parts[0]!.channels[1]!, full.parts[0]!.channels[1]!)).toBe(true);
    // a render of the channel alone has the same notes (the length of the song's tail can differ with the channels asked for, so compare the audible part)
    const solo = renderSong(l.songs.get('t')!, { instruments, bank, only: ['a'] });
    expect(same(solo.parts[0]!.channels[0]!.subarray(0, 2 * SR), full.parts[0]!.channels[0]!.subarray(0, 2 * SR))).toBe(true);
  });

  it('rr=hash picks from the channel, the note\'s time and its pitch, the same every render', () => {
    const l = song('instrument set rr rr=hash', RR);
    const s = l.songs.get('t')!;
    const one = renderSong(s, { instruments: (i) => lookupInstrument(l, i), bank });
    const two = renderSong(s, { instruments: (i) => lookupInstrument(l, i), bank });
    expect(one.parts[0]!.key).toBe(two.parts[0]!.key);
    expect(Buffer.from(one.parts[0]!.channels[0]!.buffer).equals(Buffer.from(two.parts[0]!.channels[0]!.buffer))).toBe(true);
    const cycle = renderSong(song('', RR).songs.get('t')!, { instruments: (i) => lookupInstrument(song('', RR), i), bank });
    expect(one.parts[0]!.key).not.toBe(cycle.parts[0]!.key);
  });

  it('a note of a choke group stops the earlier sounding notes of the group with a short fade', () => {
    const rows = '  h: ho . . . hc . . . . . . . . . . .\n';
    const l = song('', rows);
    const s = l.songs.get('t')!;
    const r = renderSong(s, { instruments: (i) => lookupInstrument(l, i), bank });
    const h = r.parts.find((p) => p.name === 'h')!.channels[0]!;
    // steps are 0.125 s apart: the closed hat falls at 0.5 s, while the open hat (1.2 s long) is still sounding
    const without = lib(`instrument new hats kind=zones
instrument set hats pitched=no
instrument zone add hats sample=hatc root=C3 hit=hc loopmode=oneshot
instrument zone add hats sample=hato root=C3 hit=ho loopmode=oneshot
song new t tempo=120
song channel add t h kit=hats
pattern t.p steps=16 tpb=4
${rows}
song section add t x p
`);
    const free = renderSong(without.songs.get('t')!, { instruments: (i) => lookupInstrument(without, i), bank }).parts[0]!.channels[0]!;
    const cutAt = 0.5;
    expect(rms(free, cutAt - 0.05, cutAt)).toBeGreaterThan(0.001);
    // choked: the open hat is silent right after the closed hat's own sound (0.1 s) is over
    expect(rms(h, cutAt + 0.12, cutAt + 0.3)).toBeLessThan(rms(free, cutAt + 0.12, cutAt + 0.3) * 0.2);
    expect(rms(h, cutAt - 0.05, cutAt - 0.01)).toBeCloseTo(rms(free, cutAt - 0.05, cutAt - 0.01), 6);
  });
});

describe('the rules songs keep with sampled instruments', () => {
  const bank = bankOf({ a3: tone(220, 1), hit: burst(4, 0.2) });
  const script = `instrument new pad kind=zones
instrument set pad adsr=0.01,0.1,0.9,0.2
instrument zone add pad sample=a3 root=A3 keys=A2-D4
instrument zone add pad sample=a3 root=A3 keys=D#4-A6
instrument new perc kind=zones
instrument zone add perc sample=hit root=C3 keys=C3-C3 loopmode=oneshot
song new t tempo=120 key=A:minor
song channel add t lead inst=pad layer=base
song channel add t drum inst=perc layer=tension
pattern t.p steps=16 tpb=4
  lead: A3 - - - C4 - - - E4 - - - A4 - - -
  drum: C3 . . . C3 . . . C3 . . . C3 . . .
song section add t x p
song loop t x..x
`;

  it('render-match hears each written note at its pitch (zone roots and tuning decide it)', () => {
    const l = lib(script);
    const song = l.songs.get('t')!;
    const r = renderSong(song, { instruments: (i) => lookupInstrument(l, i), bank });
    const m = renderMatch(song, r, (i) => lookupInstrument(l, i));
    const lead = m.notes.filter((n) => n.channel === 'lead');
    expect(lead.length).toBe(4);
    expect(lead.every((n) => n.ok), JSON.stringify(lead.filter((n) => !n.ok))).toBe(true);
  });

  it('a zone tuned an octave out is found by render-match', () => {
    const l = lib(script.replace('keys=D#4-A6', 'tune=1200 keys=D#4-A6'));
    const song = l.songs.get('t')!;
    const r = renderSong(song, { instruments: (i) => lookupInstrument(l, i), bank });
    const m = renderMatch(song, r, (i) => lookupInstrument(l, i));
    // A4 is in the second zone, which now plays the sample an octave too high
    expect(m.notes.some((n) => n.channel === 'lead' && !n.ok)).toBe(true);
  });

  it('stems and the mix add up, the loop folds its tails onto its start, and the loop is the same bytes every render', () => {
    const l = lib(script);
    const song = l.songs.get('t')!;
    const o = { instruments: (i: string) => lookupInstrument(l, i), bank };
    const loop = renderSong(song, { ...o, mode: 'loop' });
    const again = renderSong(song, { ...o, mode: 'loop', notes: new Map() });
    expect(Buffer.from(loop.mix[0].buffer).equals(Buffer.from(again.mix[0].buffer))).toBe(true);
    const stems = renderStems(song, loop.parts, loop.length, true);
    expect(stems.map((x) => x.layer)).toEqual(['base', 'tension']);
    const sum = [new Float64Array(loop.length), new Float64Array(loop.length)];
    for (const st of stems) for (let c = 0; c < 2; c++) for (let i = 0; i < loop.length; i++) sum[c]![i] = sum[c]![i]! + st.channels[c]![i]!;
    const pre = mixParts({ ...song, master: [], reverb: null, delay: null }, loop.parts, loop.length, true).pre;
    for (let i = 0; i < loop.length; i += 97) expect(sum[0]![i]).toBeCloseTo(pre[0][i]!, 5);
  });
});
