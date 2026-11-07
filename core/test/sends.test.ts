// The song's send buses: one reverb and one delay for the whole piece, fed by each channel's send amount.

import { describe, expect, it } from 'vitest';
import { Library, applyCommand, lookupInstrument, parse, renderSong, renderStems, serializeSong } from '../src/index.ts';
import { SINE, library, render } from './music-helpers.ts';

const BASE = `${SINE}song new s tempo=120 key=C:major
song channel add s lead inst=sine gain=0.8 layer=base
song channel add s pad inst=sine gain=0.5 pan=0.4 layer=tension
song fx set s 1 ceiling=-0.3
pattern s.a steps=16 tpb=4
  lead: C5 - - - E5 - - - G5 - - . . . . .
  pad: C4 - - - - - - - G3 - - - - - - -
song section add s a a x2
`;

const max = (a: Float32Array, from = 0, to = a.length): number => { let m = 0; for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i]!)); return m; };

describe('send buses', () => {
  it('a channel with a send puts the reverb under the whole mix; the dry parts do not change', () => {
    const dry = render(library(BASE), 's');
    const wetLib = library(BASE + 'song send s reverb size=0.6 damp=0.4\nsong channel set s lead reverb=0.5\n');
    const wet = render(wetLib, 's');
    const head = (x: Float32Array, n: number): string => Buffer.from(x.subarray(0, n).buffer, 0, n * 4).toString('base64');
    expect(wet.parts.map((p) => head(p.channels[0], dry.length))).toEqual(dry.parts.map((p) => head(p.channels[0], dry.length)));
    expect(wet.mix[0].some((v, i) => v !== dry.mix[0][i])).toBe(true);
    // the song ends at 4 s: past it the dry mix is silent and the reverb rings on
    const end = Math.round(4 * 44100);
    expect(wet.length).toBeGreaterThan(end);
    expect(max(dry.mix[0], end + 8000)).toBeLessThan(1e-4);
    expect(max(wet.mix[0], end + 8000)).toBeGreaterThan(1e-3);
  });
  it('is linear: a channel sending twice as much puts twice the return in, and a bus nobody feeds is silent', () => {
    const a = render(library(BASE + 'song send s reverb\nsong channel set s lead reverb=0.25\n'), 's');
    const b = render(library(BASE + 'song send s reverb\nsong channel set s lead reverb=0.5\n'), 's');
    const none = render(library(BASE + 'song send s reverb\n'), 's');
    const dry = render(library(BASE), 's');
    expect(Buffer.from(none.pre[0].buffer).equals(Buffer.from(dry.pre[0].buffer))).toBe(true);
    expect(none.length).toBe(dry.length);
    for (const i of [30000, 90000, 150000, 170000]) {
      const ra = a.pre[0][i]! - dry.pre[0][i]!, rb = b.pre[0][i]! - dry.pre[0][i]!;
      expect(rb).toBeCloseTo(2 * ra, 4);
    }
  });
  it('a delay bus echoes the channel at its time', () => {
    const lib = library(BASE + 'song send s delay time=0.5 feedback=0\nsong channel set s pad delay=1\n');
    const r = render(lib, 's');
    const d = render(library(BASE), 's');
    // the first note of pad starts at 0: its echo is the same note 0.5 s later (a sine, so check the level at 0.5 s + a bit)
    const at = Math.round(0.6 * 44100);
    expect(Math.abs(r.pre[0][at]! - d.pre[0][at]!)).toBeGreaterThan(0.005);
  });
  it('the stems carry their layer\'s share of the bus and sum to the mix before the master chain', () => {
    const lib = library(BASE + 'song send s reverb size=0.5\nsong send s delay time=0.3 feedback=0.3\nsong channel set s lead reverb=0.5 delay=0.3\nsong channel set s pad reverb=0.2\n');
    const r = render(lib, 's');
    const sum = new Float32Array(r.length);
    for (const s of r.stems) for (let i = 0; i < r.length; i++) sum[i] = sum[i]! + s.channels[0][i]!;
    let worst = 0;
    for (let i = 0; i < r.length; i++) worst = Math.max(worst, Math.abs(sum[i]! - r.pre[0][i]!));
    expect(worst).toBeLessThan(1e-5);
    // the tension stem holds the pad's reverb and none of the lead's
    const tension = r.stems.find((s) => s.layer === 'tension')!;
    expect(max(tension.channels[0], Math.round(4.3 * 44100))).toBeGreaterThan(1e-4);
  });
  it('in a loop the tail wraps to the start: the loop equals the middle of three runs', () => {
    const lib = library(BASE + 'song send s reverb size=0\nsong channel set s lead reverb=0.5\n');
    const loop = render(lib, 's', { mode: 'loop' });
    const three = render(lib, 's', { mode: 'full', loops: 3 });
    const n = loop.length;
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(loop.pre[0][i]! - three.pre[0][n + i]!));
    expect(worst).toBeLessThan(2e-3);
  });
  it('commands: normal form, refusals, off, and the song file', () => {
    const lib = library(BASE);
    const p = parse('song send s reverb size=0.6 damp=0.4\nsong channel set s lead reverb=0.3 delay=0.1');
    expect(p.errors).toEqual([]);
    expect(p.commands[0]!.text).toBe('song send s reverb size=0.6 damp=0.4');
    expect(p.commands[1]!.text).toBe('song channel set s lead reverb=0.3 delay=0.1');
    for (const c of p.commands) applyCommand(lib, c);
    const text = serializeSong(lib.songs.get('s')!);
    expect(text).toMatch(/^send reverb size=0.6 damp=0.4$/m);
    expect(text).toMatch(/^channel lead .* reverb=0.3 delay=0.1$/m);
    expect(parse('song send s reverb mix=0.3').errors[0]!.message).toMatch(/only the effect/);
    expect(parse('song send s reverb size=3').errors[0]!.message).toMatch(/size must be a number from 0 to 1/);
    expect(parse('song send s chorus').errors[0]!.message).toMatch(/reverb or delay/);
    expect(parse('song send s reverb room=1').errors[0]!.message).toMatch(/size, damp/);
    expect(parse('song channel set s lead reverb=2').errors[0]!.message).toMatch(/reverb must be a number from 0 to 1/);
    applyCommand(lib, parse('song send s reverb off').commands[0]!);
    const song = lib.songs.get('s')!;
    expect(song.reverb).toBeNull();
    expect(song.channels.find((c) => c.name === 'lead')!.reverb).toBeUndefined();
    expect(song.channels.find((c) => c.name === 'lead')!.delay).toBe(0.1);
    // a song with no bus renders as it did: the bytes do not change
    const a = renderSong(song, { instruments: (i) => lookupInstrument(lib, i) });
    const b = render(library(BASE), 's');
    expect(Buffer.from(a.mix[0].buffer).equals(Buffer.from(b.mix[0].buffer))).toBe(true);
    void Library; void renderStems;
  });
});
