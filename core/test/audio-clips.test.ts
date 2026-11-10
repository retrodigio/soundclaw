// Audio clips in songs: a recording placed on a bar and a beat of an audio channel, stretched to the tempo when asked, summed with the rest,
// and rendered to the same bytes whether the channel is cached or not.

import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE, parse, songDirectSamples, songSamples, songText, type Library, type PartStore } from '../src/index.ts';
import { SINE, library, render } from './music-helpers.ts';
import { AUDIO_BANK, crossingsHz, firstOver, rms } from './audio-material.ts';

const SR = SAMPLE_RATE;
// four bars at 120 bpm (8 s): a note per bar on an instrument channel, and an audio channel for the clips
const BASE = `${SINE}song new s tempo=120
song channel add s lead inst=sine gain=0.5
song channel add s loops audio
pattern s.a steps=16 tpb=4
  lead: C5 - - - - - - - - - - - - - - -
song section add s a a x4
`;
const song = (extra = ''): Library => library(BASE + extra);
const loops = (lib: Library, o = {}) => render(lib, 's', { bank: AUDIO_BANK, ...o }).parts.find((p) => p.name === 'loops')!.channels;

describe('audio clips', () => {
  it('start on their bar and beat', () => {
    const [l] = loops(song('song clip add s loops tone at=2.3\n'));
    // bar 2 is 2 s in, beat 3 another second
    const at = firstOver(l!, 0.01);
    expect(Math.abs(at - 3 * SR)).toBeLessThan(80);
    expect(rms(l!, 0, 2.9 * SR)).toBe(0);
    const [m] = loops(song('song clip add s loops tone at=1\n'));
    expect(firstOver(m!, 0.01)).toBeLessThan(80);
  });

  it('len keeps the first bars of a clip, and a nudge moves it off the grid', () => {
    const [l] = loops(song('song clip add s loops beat at=1 len=0.5\n'));
    // half a bar is one second; the clip is silent after it (the 2 ms fade of a cut clip is inside the second)
    expect(rms(l!, 0.2 * SR, 0.9 * SR)).toBeGreaterThan(0.01);
    expect(rms(l!, 1.01 * SR, 3 * SR)).toBe(0);
    const [n] = loops(song('song clip add s loops tone at=2 nudge=-100\n'));
    expect(Math.abs(firstOver(n!, 0.01) - 1.9 * SR)).toBeLessThan(80);
  });

  it('stretch=tempo fits a recording made at another tempo: clicks 90 bpm apart land 120 bpm apart', () => {
    const [l] = loops(song('song clip add s loops beat at=1 stretch=tempo from-tempo=90\n'));
    const hits: number[] = [];
    for (let i = 0; i < l!.length; i++) if (Math.abs(l![i]!) > 0.1 && (hits.length === 0 || i - hits[hits.length - 1]! > 0.25 * SR)) hits.push(i);
    expect(hits.length).toBe(4);
    for (let k = 1; k < hits.length; k++) expect(Math.abs(hits[k]! - hits[k - 1]! - 0.5 * SR)).toBeLessThan(0.012 * SR);
    // the clip follows the song's tempo when it changes
    const slow = loops(library(BASE.replace('tempo=120', 'tempo=60') + 'song clip add s loops beat at=1 stretch=tempo from-tempo=90\n'), {})[0]!;
    const h2: number[] = [];
    for (let i = 0; i < slow.length; i++) if (Math.abs(slow[i]!) > 0.1 && (h2.length === 0 || i - h2[h2.length - 1]! > 0.5 * SR)) h2.push(i);
    expect(Math.abs(h2[1]! - h2[0]! - SR)).toBeLessThan(0.02 * SR);
  });

  it('pitch= moves the pitch and keeps the length when it follows the tempo', () => {
    const [l] = loops(song('song clip add s loops tone at=1 stretch=tempo from-tempo=120 pitch=12\n'));
    expect(crossingsHz(l!, 0.3 * SR, 1.0 * SR)).toBeGreaterThan(860);
    expect(crossingsHz(l!, 0.3 * SR, 1.0 * SR)).toBeLessThan(900);
    // the tone is 1.5 s long, and so is the clip
    expect(rms(l!, 1.3 * SR, 1.45 * SR)).toBeGreaterThan(0.1);
    expect(rms(l!, 1.56 * SR, 3 * SR)).toBe(0);
    const [raw] = loops(song('song clip add s loops tone at=1 pitch=12\n'));
    // without the tempo, a higher pitch is a faster tape: half as long
    expect(rms(raw!, 0.8 * SR, 1.45 * SR)).toBe(0);
  });

  it('gain and fade shape the clip, and the channel\'s gain and pan apply to it as to any channel', () => {
    const loud = loops(song('song clip add s loops tone at=1\n'))[0]!;
    const half = loops(song('song clip add s loops tone at=1 gain=0.5\n'))[0]!;
    expect(rms(half, 0, 2 * SR) / rms(loud, 0, 2 * SR)).toBeCloseTo(0.5, 2);
    const faded = loops(song('song clip add s loops tone at=1 fade=0.2\n'))[0]!;
    expect(rms(faded, 0, 0.02 * SR)).toBeLessThan(0.3 * rms(loud, 0, 0.02 * SR) + 1e-9);
    expect(rms(faded, 0.5 * SR, 1.0 * SR)).toBeCloseTo(rms(loud, 0.5 * SR, 1.0 * SR), 3);
    const panned = loops(song('song clip add s loops tone at=1\nsong channel set s loops pan=1 gain=0.5\n'));
    // a mono clip is panned with the constant-power law: all on the right
    expect(rms(panned[0]!)).toBeLessThan(1e-6);
    expect(rms(panned[1]!)).toBeGreaterThan(0.05);
  });

  it('a stereo clip keeps its sides', () => {
    const [l, r] = loops(song('song clip add s loops wide at=1\n'));
    expect(rms(l!, 0, 3 * SR)).toBeGreaterThan(0.1);
    expect(rms(r!)).toBe(0);
  });

  it('is summed with the other channels, belongs to a game layer, and its stem is its share', () => {
    const lib = song('song clip add s loops tone at=2\nsong channel set s loops layer=tension\n');
    const r = render(lib, 's', { bank: AUDIO_BANK });
    expect(r.stems.map((x) => x.layer)).toEqual(['base', 'tension']);
    const pre = r.pre[0];
    for (let i = 0; i < r.length; i += 1013) expect(pre[i]!).toBeCloseTo(r.parts[0]!.channels[0][i]! + r.parts[1]!.channels[0][i]!, 5);
  });

  it('a partly cached render is the render without a cache, byte for byte', () => {
    const lib = song('song clip add s loops beat at=1 stretch=tempo from-tempo=90\nsong clip add s loops tone at=3.2 gain=0.7\n');
    const cache = new Map<string, Float32Array>();
    const store: PartStore = { get: (k) => cache.get(k) ?? null, put: (k, v) => { cache.set(k, v); } };
    const first = render(lib, 's', { bank: AUDIO_BANK, store });
    expect(first.cached).toBe(0);
    // a change to the instrument channel leaves the audio channel in the cache
    lib.songs.get('s')!.channels[0]!.gain = 0.4;
    const again = render(lib, 's', { bank: AUDIO_BANK, store });
    expect(again.cached).toBe(1);
    const plain = render(lib, 's', { bank: AUDIO_BANK });
    for (const c of [0, 1] as const) expect(Buffer.from(again.mix[c].buffer).equals(Buffer.from(plain.mix[c].buffer))).toBe(true);
    // another sample under the same name is another key
    const other = { get: AUDIO_BANK.get, hash: (n: string) => (n === 'tone' ? 'changed' : AUDIO_BANK.hash(n)) };
    expect(render(lib, 's', { bank: other, store }).parts.find((p) => p.name === 'loops')!.key).not.toBe(first.parts.find((p) => p.name === 'loops')!.key);
  });

  it('in the loop region a clip that runs past the end wraps to the start', () => {
    const lib = song('song clip add s loops tone at=4.3\n');
    const full = loops(lib, { mode: 'full' })[0]!;
    const loop = loops(lib, { mode: 'loop' })[0]!;
    // bar 4 beat 3 is 7 s in; the 1.5 s tone ends 0.5 s past the 8 s the loop is long
    expect(loop.length).toBe(8 * SR);
    expect(rms(loop, 0.05 * SR, 0.45 * SR)).toBeGreaterThan(0.1);
    for (const i of [0.1 * SR, 0.2 * SR, 0.3 * SR]) expect(loop[Math.round(i)]!).toBeCloseTo(full[Math.round(8 * SR + i)]!, 5);
  });

  it('a long clip makes the song as long as it needs, up to the tail the render allows', () => {
    const lib = song('song clip add s loops tone at=4.4\n');
    const r = render(lib, 's', { bank: AUDIO_BANK });
    expect(r.length).toBeGreaterThan(8 * SR);
  });

  it('is written into the song\'s file and replays from its commands', () => {
    const lib = song('song clip add s loops beat at=2.2 len=1 stretch=tempo from-tempo=90 method=pv gain=0.8 fade=0.05 slice=0\nsong clip add s loops tone at=1 pitch=-5 nudge=12\n');
    const text = songText(lib.songs.get('s')!);
    expect(text).toContain('channel loops audio');
    expect(text).toContain('clip loops 1 sample=beat at=2.2 len=1 stretch=tempo from-tempo=90 method=pv gain=0.8 fade=0.05');
    expect(text).toContain('clip loops 2 sample=tone at=1.1 nudge=12 pitch=-5');
    const script = (BASE + 'song clip add s loops beat at=2.2 len=1 stretch=tempo from-tempo=90 method=pv gain=0.8 fade=0.05 slice=0\nsong clip add s loops tone at=1 pitch=-5 nudge=12\n');
    const replay = library(parse(script).commands.map((c) => c.text).join('\n'));
    expect(songText(replay.songs.get('s')!)).toBe(text);
  });

  it('is changed and removed by its number', () => {
    const lib = song('song clip add s loops tone at=1\nsong clip add s loops beat at=3\nsong clip set s loops 1 at=2.2 gain=0.5\nsong clip remove s loops 2\n');
    const clips = lib.songs.get('s')!.channels[1]!.clips!;
    expect(clips.map((k) => [k.id, k.sample, k.gain])).toEqual([[1, 'tone', 0.5]]);
    expect(clips[0]!.at).toBe(5);
    const again = library(BASE + 'song clip add s loops tone at=1\nsong clip add s loops beat at=3\nsong clip remove s loops 1\nsong clip add s loops tone at=2\n');
    expect(again.songs.get('s')!.channels[1]!.clips!.map((k) => [k.id, k.sample])).toEqual([[2, 'beat'], [3, 'tone']]);
  });

  it('says what is wrong with a clip command', () => {
    const bad = (extra: string, re: RegExp): void => { expect(() => song(extra), extra).toThrow(re); };
    bad('song clip add s lead tone at=1\n', /audio channel/);
    bad('song clip add s loops tone at=1.5\n', /beats in a 4\/4 bar run from 1 to 4/);
    bad('song clip add s loops tone at=1 stretch=tempo\n', /from-tempo/);
    bad('song clip add s loops tone\n', /at=/);
    bad('song clip add s loops tone at=1 speed=2\n', /a clip has/);
    bad('song clip set s loops 9 gain=1\n', /no clip 9/);
    bad('song channel set s loops inst=sine\n', /audio channel/);
    bad('song channel add s x audio inst=sine\n', /not both/);
    bad('song channel set s lead audio\n', /song channel add/);
    bad('song clip add s nobody tone at=1\n', /no channel nobody/);
  });

  it('adds its samples to those the song reaches', () => {
    const lib = song('song clip add s loops beat at=1\nsong clip add s loops tone at=3\nsong send s convolve ir=room len=0.3\nsong channel set s loops convolve=0.4\n');
    expect(songDirectSamples(lib.songs.get('s')!).sort()).toEqual(['beat', 'room', 'tone']);
    expect(songSamples(lib, 's').sort()).toEqual(['beat', 'room', 'tone']);
  });
});

describe('the convolution send bus', () => {
  const lib = (extra: string): Library => song('song clip add s loops beat at=1\n' + extra);
  it('puts the room under the channels that send to it, rings on after the song and is linear', () => {
    const dry = render(lib(''), 's', { bank: AUDIO_BANK });
    const wet = render(lib('song send s convolve ir=room len=0.5\nsong channel set s loops convolve=0.5\n'), 's', { bank: AUDIO_BANK });
    const twice = render(lib('song send s convolve ir=room len=0.5\nsong channel set s loops convolve=1\n'), 's', { bank: AUDIO_BANK });
    expect(wet.mix[0].some((v, i) => v !== dry.mix[0][i])).toBe(true);
    expect(wet.length).toBeGreaterThan(8 * SR - 1);
    for (const i of [1.2 * SR, 1.4 * SR, 3 * SR]) {
      const a = wet.pre[0][Math.round(i)]! - dry.pre[0][Math.round(i)]!, b = twice.pre[0][Math.round(i)]! - dry.pre[0][Math.round(i)]!;
      expect(b).toBeCloseTo(2 * a, 4);
    }
    // a bus nobody feeds is silent
    const none = render(lib('song send s convolve ir=room len=0.5\n'), 's', { bank: AUDIO_BANK });
    expect(Buffer.from(none.pre[0].buffer).equals(Buffer.from(dry.pre[0].buffer))).toBe(true);
  });
  it('is its own render key: another response or another send is another song', () => {
    const a = render(lib('song send s convolve ir=room len=0.5\nsong channel set s loops convolve=0.5\n'), 's', { bank: AUDIO_BANK }).key;
    const b = render(lib('song send s convolve ir=hall len=0.5\nsong channel set s loops convolve=0.5\n'), 's', { bank: AUDIO_BANK }).key;
    const c = render(lib('song send s convolve ir=room len=0.5\nsong channel set s loops convolve=0.25\n'), 's', { bank: AUDIO_BANK }).key;
    const d = render(lib(''), 's', { bank: AUDIO_BANK }).key;
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
  it('a convolution on the master chain is run over the mix', () => {
    const dry = render(lib(''), 's', { bank: AUDIO_BANK });
    const wet = render(lib('song fx add s convolve ir=room mix=0.4 len=0.4\n'), 's', { bank: AUDIO_BANK });
    expect(Buffer.from(wet.mix[0].buffer).equals(Buffer.from(dry.mix[0].buffer))).toBe(false);
    expect(rms(wet.mix[0], 0, 8 * SR)).toBeGreaterThan(0);
  });
});
