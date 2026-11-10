// What the dashboard works out for audio in songs and sounds: which clips are the agent's, how a clip is sketched, what a convolution card draws, and the grains sounding at once.

import { describe, expect, it } from 'vitest';
import type { SampleData, TapeEntry } from '@soundclaw/core';
import { clipAuthors } from '../src/song/model.ts';
import { clipPeaks } from '../src/song/AudioClips.tsx';
import { irSketch, mainValues, sketch } from '../src/sound/devices.ts';
import { grainOverlap } from '../src/sound/GrainMap.tsx';

let seq = 0;
const e = (cmd: string, by: string, group = `g${seq + 1}`): TapeEntry => ({ seq: ++seq, by, at: '2026-11-10T10:00:00Z', group, cmd });

describe('which clips are the agent\'s', () => {
  it('a clip is the agent\'s until a person touches it or the song is approved', () => {
    seq = 0;
    const tape = [
      e('song new s tempo=120', 'human:ana'),
      e('song channel add s loops audio', 'human:ana'),
      e('song clip add s loops a at=1', 'agent:claude'),
      e('song clip add s loops b at=2', 'human:ana'),
      e('song clip add s loops c at=3', 'agent:claude'),
    ];
    expect([...clipAuthors(tape, 's')].sort()).toEqual(['loops#1', 'loops#3']);
    // a person's change to clip 1 makes it theirs; an agent's change to clip 2 makes it the agent's
    const more = [...tape, e('song clip set s loops 1 gain=0.5', 'human:ana'), e('song clip set s loops 2 at=4', 'agent:claude')];
    expect([...clipAuthors(more, 's')].sort()).toEqual(['loops#2', 'loops#3']);
    // approval clears them; a later agent change brings one back; removal drops it
    const approved = [...more, e('song mark s approved', 'human:ana'), e('song clip set s loops 3 pitch=2', 'agent:claude'), e('song clip remove s loops 2', 'agent:claude')];
    expect([...clipAuthors(approved, 's')]).toEqual(['loops#3']);
  });

  it('counts the numbers as the song does, skips undone groups and other songs', () => {
    seq = 0;
    const tape = [
      e('song new s', 'human:ana', 'g1'), e('song channel add s loops audio', 'human:ana', 'g1'),
      e('song clip add s loops a at=1', 'human:ana', 'g2'),
      e('song clip add s loops b at=2', 'agent:claude', 'g3'),
      e('undo group=g3', 'human:ana', 'g4'),
      e('song clip add s loops c at=3', 'agent:claude', 'g5'),
      e('song clip add other loops x at=1', 'agent:claude', 'g6'),
    ];
    // the undone add of b never happened: c is clip 2
    expect([...clipAuthors(tape, 's')]).toEqual(['loops#2']);
  });
});

describe('a clip\'s sketch', () => {
  const smp = (n: number, f: (i: number) => number): SampleData => ({ rate: 44100, data: Float32Array.from({ length: n }, (_, i) => f(i)) });
  it('is the size of the part that plays, normalised, and kept for the sample', () => {
    const s = smp(44100, (i) => (i < 22050 ? 0.2 : 0.8));
    const whole = clipPeaks(s, { slice: 0 }, 1);
    expect(whole.length).toBe(48);
    expect(whole[0]).toBeCloseTo(0.25, 5);
    expect(whole[47]).toBe(1);
    // only the first half plays: all of it is the quiet part, normalised
    expect(clipPeaks(s, { slice: 0 }, 0.5).every((v) => Math.abs(v - 1) < 1e-9)).toBe(true);
    expect(clipPeaks(s, { slice: 0 }, 1)).toBe(whole);
  });
  it('follows a slice', () => {
    const s: SampleData = { ...smp(44100, (i) => (i < 22050 ? 0.1 : 0.9)), slices: [0, 22050] };
    expect(clipPeaks(s, { slice: 1 }, 1).every((v) => v === 1)).toBe(true);
  });
});

describe('the convolution card', () => {
  it('draws the response it uses: nothing for the predelay, then a fall; a flat line when the sample is not here', () => {
    const ir: SampleData = { rate: 44100, data: Float32Array.from({ length: 22050 }, (_, i) => (i % 2 ? 1 : -1) * (1 - i / 22050)) };
    const d = irSketch(ir, { len: 0.5, predelay: 0.1 });
    const pts = d.split('L').map((p) => p.replace('M', '').trim().split(' ').map(Number) as [number, number]);
    expect(pts.length).toBeGreaterThan(50);
    expect(pts[0]![1]).toBe(pts[1]![1]);
    expect(pts[2]![1]).toBeLessThan(pts[1]![1]);
    expect(pts.at(-1)![1]).toBeGreaterThan(pts[3]![1]);
    expect(irSketch(undefined, { len: 0.5 }).split('L').length).toBe(2);
  });
  it('has a sketch without the audio, and shows the response, the mix and the length', () => {
    expect(sketch('convolve', { len: 1, predelay: 0.05 }).startsWith('M')).toBe(true);
    expect(mainValues('convolve', { ir: 'room_ir', mix: 0.3, len: 0.9 })).toEqual([{ k: 'ir', v: 'room_ir' }, { k: 'mix', v: '0.3' }, { k: 'len', v: '900 ms' }]);
    expect(mainValues('convolve', { ir: '' })[0]!.v).toBe('(none)');
  });
});

describe('grains at once', () => {
  it('is the density times the size, to the 64 the renderer allows', () => {
    expect(grainOverlap({ p: { density: 30, size: 0.08 } })).toBeCloseTo(2.4, 5);
    expect(grainOverlap({ p: { density: 400, size: 1 } })).toBe(64);
  });
});
