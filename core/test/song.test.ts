// Songs: the commands, the arrangement, rendering with values checked by hand, loops, stems and the part cache.

import { describe, expect, it } from 'vitest';
import {
  SAMPLE_RATE, arrange, channelNotes, builtinInstruments, formatPattern, parse, renderNote, samplesHash, joinChannels, midiFreq, noteSound, yinPitch, analyze, applyCommand, Library, type PartStore, instrumentKey,
} from '../src/index.ts';
import { SINE, firstAbove, library, render } from './music-helpers.ts';

const SONG = (tempo: number, rows: string, extra = '') => `${SINE}song new s tempo=${tempo}${extra}\nsong channel add s lead inst=sine gain=1\npattern s.p steps=8 tpb=2\n  lead: ${rows}\nsong section add s A p\nsong master_off\n`.replace('song master_off\n', 'song fx remove s 1\n');

describe('the music commands', () => {
  it('make a song, and every command has a normal form that replays to the same song', () => {
    const script = `instrument new bell2 from=fm_bell\ninstrument set bell2 adsr=0.002,0.5,0,0.2 range=C4-C7 root=A4\nsong new demo tempo=96 key=A:minor time=3/4\nsong channel add demo lead inst=bell2 gain=0.8 pan=-0.2 layer=tension\nsong channel add demo drums kit=default\npattern demo.a steps=6 tpb=2\n  lead: A4 . C5 . E5 .\n  drums: k . h . s .\nsong section add demo A a x2\nsong loop demo A\nsong fx add demo compress threshold=-12\n`;
    const p = parse(script);
    expect(p.errors).toEqual([]);
    const lib = new Library();
    for (const c of p.commands) applyCommand(lib, c);
    // the tape's lines parse again to the same normal form
    const again = parse(p.commands.map((c) => c.text).join('\n'));
    expect(again.errors).toEqual([]);
    expect(again.commands.map((c) => c.text)).toEqual(p.commands.map((c) => c.text));
    const lib2 = new Library();
    for (const c of again.commands) applyCommand(lib2, c);
    expect(JSON.stringify(lib2.songs.get('demo')!.sections)).toBe(JSON.stringify(lib.songs.get('demo')!.sections));
    expect(formatPattern(lib2.songs.get('demo')!.patterns.get('a')!)).toBe(formatPattern(lib.songs.get('demo')!.patterns.get('a')!));
    expect(lib2.songs.get('demo')!.master.map((f) => f.kind)).toEqual(['limit', 'compress']);
  });

  it('a pattern block in a script reports a problem at its place in the script', () => {
    const e = parse('song new d\n\npattern d.a steps=4 tpb=4\n  lead: C5 . Q5 .\n').errors[0]!;
    expect([e.line, e.col]).toEqual([4, 14]);
    expect(e.message).toMatch(/'Q5' is not a note/);
  });

  it('refuse what does not fit, saying why', () => {
    const lib = library('song new d\ninstrument new i kind=osc\nsong channel add d lead inst=i\npattern d.a steps=2 tpb=4\n  lead: C5 .\nsong section add d A a\n');
    const run = (t: string) => () => { for (const c of parse(t).commands) applyCommand(lib, c); };
    expect(run('song section add d B nope')).toThrow(/no pattern 'nope'/);
    expect(run('song section add d A a')).toThrow(/has a section A already/);
    expect(run('pattern remove d.a')).toThrow(/played by section A/);
    expect(run('instrument remove i')).toThrow(/played by d\/lead/);
    expect(run('song channel add d lead inst=i')).toThrow(/has a channel lead already/);
    expect(run('song loop d X..Y')).toThrow(/must be body sections/);
    expect(run('song intro d A')).not.toThrow();
    expect(run('song ending d A')).toThrow(/both intro and ending/);
    expect(run('instrument new SINE2 kind=osc\ninstrument new sine2 kind=osc')).toThrow(/ignoring case/);
    expect(parse('song new d tempo=500').errors[0]!.message).toMatch(/tempo must be a number from 30 to 300/);
    expect(parse('instrument set x range=C6-C3').errors[0]!.message).toMatch(/range is two notes/);
  });

  it('the arrangement: the intro plays once, the loop region is a run of body sections, the ending follows', () => {
    const lib = library(`${SINE}song new d tempo=120\nsong channel add d l inst=sine\npattern d.p steps=8 tpb=2\n  l: C5 . . . . . . .\nsong section add d intro p\nsong section add d A p x2\nsong section add d B p\nsong section add d out p\nsong intro d intro\nsong ending d out\nsong loop d A..B\n`);
    const a = arrange(lib.songs.get('d')!);
    expect(a.instances.map((i) => `${i.part}:${i.section}`)).toEqual(['intro:intro', 'body:A', 'body:A', 'body:B', 'ending:out']);
    // 8 steps at 2 per beat and 120 bpm: 2 s each
    expect(a.total).toBe(10);
    expect(a.loop).toEqual({ start: 2, end: 8 });
    expect(a.instances.filter((i) => i.inLoop).length).toBe(3);
  });
});

describe('rendering, by hand', () => {
  it('a single A4 on a sine instrument at 120 bpm starts at the right sample and has 440 Hz', () => {
    const lib = library(SONG(120, 'A4 - - - - - - -'));
    const r = render(lib, 's');
    const x = r.mix[0];
    expect(firstAbove(x, 0.001)).toBeLessThan(40); // the note begins at sample 0 (the 1 ms attack ramps up)
    // the period of the sine: zero crossings in half a second give the frequency
    let crossings = 0;
    for (let i = 4410; i < 4410 + 22050; i++) if (x[i - 1]! < 0 && x[i]! >= 0) crossings++;
    expect(crossings / 0.5).toBeGreaterThan(439);
    expect(crossings / 0.5).toBeLessThan(441);
    const pitch = yinPitch(Float32Array.from(x.subarray(2000, 20000)), { hop: 1024 }).filter((f) => f.hz).map((f) => f.hz!);
    expect(pitch.length).toBeGreaterThan(0);
    for (const hz of pitch) expect(Math.abs(hz - 440)).toBeLessThan(2);
  });

  it('tempo: the second note of a 2-steps-per-beat pattern starts exactly one step later (0.25 s at 120 bpm, 0.5 s at 60)', () => {
    for (const [tempo, step] of [[120, 11025], [60, 22050], [90, 14700]] as const) {
      const lib = library(SONG(tempo, '. . A4 . . . . .'));
      const x = render(lib, 's').parts[0]!.channels[0]!;
      // step 2 of the grid, 2 steps per beat
      expect(Math.abs(firstAbove(x, 0.001) - 2 * step)).toBeLessThan(40);
    }
  });

  it('swing delays the second step of each pair by swing × a step', () => {
    const plain = library(SONG(120, '. A4 . . . . . .'));
    const swung = library(SONG(120, '. A4 . . . . . .', ' swing=0.2'));
    const a = firstAbove(render(plain, 's').parts[0]!.channels[0]!, 0.001);
    const b = firstAbove(render(swung, 's').parts[0]!.channels[0]!, 0.001);
    // a step is 0.25 s = 11025 samples; swing 0.2 = 2205 samples
    expect(Math.abs(b - a - 2205)).toBeLessThan(5);
    expect(Math.abs(a - 11025)).toBeLessThan(40);
  });

  it('the notes of a channel carry their written time, length and pitch', () => {
    const lib = library(SONG(120, 'A4 - . C5 . . . .'));
    const song = lib.songs.get('s')!;
    const ev = channelNotes(song, arrange(song), 'lead');
    expect(ev.map((e) => [e.t, e.len, e.midi])).toEqual([[0, 0.5, 69], [0.75, 0.25, 72]]);
  });

  it('velocity scales the level when the instrument follows it', () => {
    const lib = library(`instrument new v kind=osc\ninstrument set v adsr=0.001,0,1,0.01 velocity=1 gain=0.5\nsong new s tempo=120\nsong channel add s l inst=v\npattern s.p steps=2 tpb=2\n  l: A4v127 A4v64\nsong section add s A p\nsong fx remove s 1\n`);
    const x = render(lib, 's').parts[0]!.channels[0]!;
    const peak = (a: number, b: number) => { let m = 0; for (let i = a; i < b; i++) m = Math.max(m, Math.abs(x[i]!)); return m; };
    const loud = peak(1000, 9000), soft = peak(11025 + 1000, 11025 + 9000);
    expect(soft / loud).toBeGreaterThan(0.49);
    expect(soft / loud).toBeLessThan(0.52);
  });

  it('the pitch of a note follows the root: an instrument declared an octave wrong plays an octave off', () => {
    const t = (root: string) => {
      const lib = library(`instrument new i kind=osc\ninstrument set i root=${root} adsr=0.001,0,1,0.01\nsong new s\nsong channel add s l inst=i\npattern s.p steps=1 tpb=1\n  l: A4\nsong section add s A p\n`);
      const x = render(lib, 's').parts[0]!.channels[0]!;
      const f = yinPitch(Float32Array.from(x.subarray(1000, 20000)), { hop: 1024 }).filter((q) => q.hz).map((q) => q.hz!);
      return f[0]!;
    };
    expect(Math.abs(t('A4') - 440)).toBeLessThan(2);
    expect(Math.abs(t('A3') - 880)).toBeLessThan(4);
  });

  it('~slide glides in from the note before, ~arp steps through its offsets, ~vib moves the pitch', () => {
    const inst = { ...builtinInstruments().square_lead };
    const hz = (n: Parameters<typeof renderNote>[1], from: number, to: number) => {
      const x = renderNote(inst, n)[0]!;
      let c = 0;
      for (let i = from + 1; i < to; i++) if (x[i - 1]! < 0 && x[i]! >= 0) c++;
      return (c * SAMPLE_RATE) / (to - from);
    };
    // a slide from A3 to A4: it starts near 220 Hz and has arrived at 440 Hz
    const slide = { midi: 69, gate: 0.5, fx: { slide: true as const }, slideFrom: 57 };
    expect(hz(slide, 0, 1500)).toBeLessThan(380);
    expect(Math.abs(hz(slide, 6000, 20000) - 440)).toBeLessThan(4);
    // arp(0,12): the pitch alternates between A4 and A5 every 20 ms (882 samples)
    const arp = { midi: 69, gate: 0.5, fx: { arp: [0, 12] } };
    expect(Math.abs(hz(arp, 100, 800) - 440)).toBeLessThan(20);
    expect(Math.abs(hz(arp, 982, 1680) - 880)).toBeLessThan(40);
    // a plain note is steady
    expect(Math.abs(hz({ midi: 69, gate: 0.5 }, 3000, 20000) - midiFreq(69))).toBeLessThan(2);
  });

  it('a drum instrument plays the same at every pitch; the kick drops in pitch', () => {
    const k = builtinInstruments().kick;
    const a = renderNote(k, { midi: 40, gate: 0.2 })[0]!;
    const b = renderNote(k, { midi: 90, gate: 0.2 })[0]!;
    expect(samplesHash(a)).toBe(samplesHash(b));
    expect(noteSound(k, { midi: 40, gate: 0.2 }).layers[0]!.envs.freq).toBeDefined();
  });
});

describe('loops and stems', () => {
  const SCRIPT = (extra = '') => `instrument new pad kind=osc\ninstrument set pad adsr=0.002,0.1,0.7,0.5 gain=0.4\ninstrument layer add pad osc wave=saw freq=440 filter=lp cutoff=2000\ninstrument fx add pad reverb size=0.3 mix=0.3\nsong new s tempo=120\nsong channel add s a inst=pad layer=base\nsong channel add s b inst=square_lead layer=tension gain=0.5\nsong channel add s d kit=default layer=base\npattern s.p steps=16 tpb=4\n  a: C4+E4+G4 - - - - - - - . . . . . . . .\n  b: . . C5 . E5 . G5 . . . . . A4 . . .\n  d: k . h . s . h . k . h . s . h h\nsong section add s A p x2\n${extra}`;

  it('the loop render has the length of the loop region, and its wrap equals the rendering of the region twice (the tails fold)', () => {
    const lib = library(SCRIPT());
    const loop = render(lib, 's', { mode: 'loop' });
    const song = lib.songs.get('s')!;
    const arr = arrange(song);
    expect(loop.length).toBe(Math.round((arr.loop!.end - arr.loop!.start) * SAMPLE_RATE));
    // the song played three times over: the middle repetition is the loop (the first has no tail before it, the last none after)
    const three = render(library(SCRIPT().replace('x2', 'x6')), 's', { mode: 'full' });
    const L = loop.length;
    const mid = three.mix[0].subarray(L, 2 * L);
    // channels render exactly alike (the master chain differs by its state only), so compare before it: parts
    const partsThree = three.parts.map((p) => p.channels[0].subarray(L, 2 * L));
    const partsLoop = loop.parts.map((p) => p.channels[0]);
    partsLoop.forEach((p, k) => {
      let worst = 0;
      for (let i = 0; i < L; i++) worst = Math.max(worst, Math.abs(p[i]! - partsThree[k]![i]!));
      expect(worst, `channel ${loop.parts[k]!.name}`).toBeLessThan(1e-5);
    });
    void mid;
  });

  it('no click at the wrap: the step between the last and the first sample is no bigger than the signal moves anywhere else', () => {
    const lib = library(SCRIPT());
    const x = render(lib, 's', { mode: 'loop' }).mix[0];
    const n = x.length;
    const jump = Math.abs(x[0]! - x[n - 1]!);
    let biggest = 0;
    for (let i = 1; i < n; i++) biggest = Math.max(biggest, Math.abs(x[i]! - x[i - 1]!));
    expect(jump).toBeLessThanOrEqual(biggest);
    expect(jump).toBeLessThan(0.05);
  });

  it('stems are aligned (one length) and sum to the mix before the master chain', () => {
    const lib = library(SCRIPT().replace('song new s tempo=120', 'song new s tempo=120 gain=0.5'));
    const r = render(lib, 's', { mode: 'loop' });
    expect(r.stems.map((s) => s.layer)).toEqual(['base', 'tension']);
    for (const s of r.stems) expect(s.channels[0].length).toBe(r.length);
    let worst = 0;
    for (let c = 0; c < 2; c++) for (let i = 0; i < r.length; i++) worst = Math.max(worst, Math.abs(r.stems[0]!.channels[c]![i]! + r.stems[1]!.channels[c]![i]! - r.pre[c]![i]!));
    expect(worst).toBeLessThan(2e-6);
    // and with the limiter out of play (the song is quiet) the mix is the sum
    let diff = 0;
    for (let i = 0; i < r.length; i++) diff = Math.max(diff, Math.abs(r.mix[0][i]! - r.pre[0][i]!));
    expect(diff).toBeLessThan(1e-6);
  });

  it('a muted channel (only=) drops out of the mix and leaves the others exactly as they were', () => {
    const lib = library(SCRIPT());
    const all = render(lib, 's');
    const two = render(lib, 's', { only: ['a', 'd'] });
    expect(two.parts.map((p) => p.name)).toEqual(['a', 'd']);
    expect(samplesHash(two.parts[0]!.channels[0])).toBe(samplesHash(all.parts[0]!.channels[0]));
  });

  it('the part cache: changing one channel renders that channel again and nothing else', () => {
    const lib = library(SCRIPT());
    const store = new Map<string, Float32Array>();
    const gets: string[] = [];
    const ps: PartStore = { get: (k) => { const v = store.get(k) ?? null; if (v) gets.push(k); return v; }, put: (k, v) => { store.set(k, v); } };
    const a = render(lib, 's', { store: ps });
    expect(a.cached).toBe(0);
    const b = render(lib, 's', { store: ps });
    expect(b.cached).toBe(3);
    expect(samplesHash(joinChannels(b.mix))).toBe(samplesHash(joinChannels(a.mix)));
    const lib2 = library(SCRIPT().replace('gain=0.5', 'gain=0.4'));
    const c = render(lib2, 's', { store: ps });
    expect(c.cached).toBe(2); // only channel b was rendered again
  });

  it('an unplayable song says why: a missing instrument', () => {
    const lib = library(`song new s\nsong channel add s l inst=square_lead\npattern s.p steps=1 tpb=1\n  l: C5\nsong section add s A p\n`);
    lib.songs.get('s')!.channels[0]!.inst = 'nothing';
    expect(() => render(lib, 's')).toThrow(/no instrument 'nothing'/);
  });

  it('the fully analysed mix of a song with a tail is as long as its notes need', () => {
    const lib = library(SCRIPT());
    const r = render(lib, 's');
    const an = analyze([r.mix[0], r.mix[1]]);
    expect(an.duration).toBeGreaterThan(arrange(lib.songs.get('s')!).total);
  });
});

describe('the instruments', () => {
  it('every built-in renders at a sane level and in its declared range, with a stable key', () => {
    for (const [name, inst] of Object.entries(builtinInstruments())) {
      const note = inst.range ? Math.round((inst.range[0] + inst.range[1]) / 2) : 60;
      const ch = renderNote(inst, { midi: note, gate: 0.3 });
      let peak = 0;
      for (const c of ch) for (const v of c) peak = Math.max(peak, Math.abs(v));
      expect(peak, name).toBeGreaterThan(0.05);
      expect(peak, name).toBeLessThan(1);
      expect(instrumentKey(inst)).toBe(instrumentKey(inst));
    }
  });

  it('from-sound makes an instrument of a sound and finds its root', () => {
    const lib = library('sound new tone voice=layered seed=1\nlayer add tone osc wave=triangle freq=220 dur=0.3\nenv tone 1.amp "0:1"\ninstrument from-sound t tone\n');
    expect(lib.instruments.get('t')!.root).toBe(57);
    expect(lib.instruments.get('t')!.voice.layers.length).toBe(1);
  });
});

describe('the docs', () => {
  it('docs/commands.md carries the built-in instrument table as the data makes it', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { builtinTable } = await import('../src/index.ts');
    const docs = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'commands.md'), 'utf8');
    const m = /<!-- builtins:begin -->\n([\s\S]*?)\n<!-- builtins:end -->/.exec(docs);
    expect(m?.[1]).toBe(builtinTable());
  });
});
