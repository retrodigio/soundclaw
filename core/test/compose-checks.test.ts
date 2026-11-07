// The checks and documents of the composition step: voice leading, the style guide and the music
// bible, stinger templates, and the game layers.

import { describe, expect, it } from 'vitest';
import {
  Library, applyCommand, arrange, channelNotes, keyCheck, rangeCheck, layerCombinations, layersCheck, musicGuide, parse, parseKey, inKey, renderSong, lookupInstrument, resolveStyle,
  songLoudnessRule, styleCheck, voiceLeadingCheck, STINGER_TEMPLATES, serializeSong, songProblems, guideText, parseBible, parseStyleGuide, cloneSong,
} from '../src/index.ts';
import { library, SINE } from './music-helpers.ts';

function tape(lib: Library, script: string): string[] {
  const p = parse(script);
  if (p.errors.length) throw new Error(p.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join('; '));
  return p.commands.flatMap((c) => (applyCommand(lib, c) ?? c.text).split('\n'));
}

const vl = (script: string) => {
  const lib = library(`${SINE}song new s tempo=120 key=C:major\nsong channel add s pad inst=sine harmony=yes\nsong channel add s bass inst=sine\n${script}\nsong section add s x p\n`);
  const s = lib.songs.get('s')!;
  return voiceLeadingCheck(s, arrange(s));
};

describe('voice-leading', () => {
  it('flags parallel fifths and octaves in a harmony part', () => {
    const c = vl('pattern s.p steps=8 tpb=4\n  pad: C4+G4 - - - D4+A4 - - -');
    expect(c.pass).toBe(false);
    expect(c.advisory).toBe(true);
    expect(c.ranges[0]!.note).toMatch(/parallel fifths: pad#1 and pad#2 \(C4-G4 to D4-A4\) at p step 4/);
    expect(vl('pattern s.p steps=8 tpb=4\n  pad: C4+C5 - - - D4+D5 - - -').ranges[0]!.note).toMatch(/parallel octaves/);
  });
  it('lets oblique and contrary motion pass, and reads across marked channels only', () => {
    expect(vl('pattern s.p steps=8 tpb=4\n  pad: C4+G4 - - - B3+G4 - - -').pass).toBe(true);
    expect(vl('pattern s.p steps=8 tpb=4\n  pad: C4+G4 - - - D4+F4 - - -').pass).toBe(true);
    // the bass is not marked: its fifths with the pad are not read
    expect(vl('pattern s.p steps=8 tpb=4\n  pad: G4 - - - A4 - - -\n  bass: C3 - - - D3 - - -').pass).toBe(true);
    const both = vl('song channel set s bass harmony=yes\npattern s.p steps=8 tpb=4\n  pad: G4 - - - A4 - - -\n  bass: C3 - - - D3 - - -');
    expect(both.ranges.map((r) => r.note)).toEqual([expect.stringMatching(/parallel fifths: pad#1 and bass#1 \(G4-C3 to A4-D3\)/)]);
  });
  it('is skipped when no channel is marked, and the chords helper avoids parallels itself', () => {
    const lib = library(`${SINE}song new s tempo=120 key=C:major\nsong channel add s pad inst=sine\npattern s.p steps=8 tpb=4\n  pad: C4+G4 - - - D4+A4 - - -\nsong section add s x p\n`);
    const s = lib.songs.get('s')!;
    expect(voiceLeadingCheck(s, arrange(s)).skipped).toBe(true);
    const ok = library(`${SINE}song new s tempo=120 key=C:major\nsong channel add s pad inst=sine harmony=yes\nchords s p pad "I ii iii IV V vi IV V I" voices=4\nsong section add s x p\n`);
    const t = ok.songs.get('s')!;
    expect(voiceLeadingCheck(t, arrange(t)).pass).toBe(true);
  });
});

const STYLE = `# Music style
Prose about the sound: warm, small. Notes: this line is prose too.
tempo: 80-140
scales: major, dorian
instruments: sine, kick, snare, hat
loudness: music
forbid: drums in town
forbid: accidentals

## town
tempo: 80-110
`;

const BIBLE = `# Music bible

## market — the square
mood: warm
tempo: 96
key: D:major
tags: town
instruments: lead=sine, drums=kit
motif: theme tpb=4 D5 - F#5 A5
region: the square
`;

describe('the style guide and the music bible', () => {
  it('reads data lines and leaves prose alone; says which lines it cannot read', () => {
    const g = parseStyleGuide(STYLE);
    expect(g.problems).toEqual([]);
    expect(g.guide.rules.tempo).toEqual([80, 140]);
    expect(g.guide.rules.forbid).toEqual([{ what: 'drums', tag: 'town' }, { what: 'accidentals', tag: null }]);
    expect(g.guide.sections.get('town')!.tempo).toEqual([80, 110]);
    expect(parseStyleGuide('scales: major, wobble\ntempo: fast\n').problems).toEqual([
      expect.stringMatching(/music-style.md:1: no scale wobble/), expect.stringMatching(/music-style.md:2: tempo is a number/)]);
    const b = parseBible(BIBLE);
    expect(b.problems).toEqual([]);
    const e = b.entries.get('market')!;
    expect([e.tempo, e.key, e.tags, e.instruments, e.motifs]).toEqual([[96, 96], 'D:major', ['town'], [['lead', 'sine'], ['drums', 'kit']], [{ name: 'theme', tpb: 4, cells: 'D5 - F#5 A5' }]]);
    expect(guideText(musicGuide(STYLE, BIBLE))).toMatch(/## town \(songs tagged town\):\n    tempo 80-110 bpm/);
  });
  it('the style check flags what the guide forbids and what is outside its ranges, with the section for the song\'s tags', () => {
    const g = musicGuide(STYLE, null);
    const lib = library(`${SINE}song new s tempo=120 key=C:major tags=town\nsong channel add s lead inst=sine\nsong channel add s d kit=default\npattern s.p steps=4 tpb=4\n  lead: C5 F#5! . .\n  d: k . s .\nsong section add s x p\n`);
    const c = styleCheck(lib.songs.get('s')!, g);
    expect(c.pass).toBe(false);
    expect(c.ranges.map((r) => r.note)).toEqual([
      'tempo 120 is outside 80-110 bpm (the style guide + ## town)',
      'drums in town are forbidden: channel d plays 2 hits',
      'a note outside the key (lead, p step 1) is forbidden',
    ]);
    // the same song, untagged and slower, with the drums and the marked note gone, keeps every rule
    const ok = library(`${SINE}song new s tempo=100 key=C:dorian\nsong channel add s lead inst=sine\npattern s.p steps=4 tpb=4\n  lead: C5 D5 . .\nsong section add s x p\n`);
    const c2 = styleCheck(ok.songs.get('s')!, g);
    expect(c2.pass).toBe(true);
    expect(c2.value).toMatch(/keeps 5 rules/);
    const bad = library(`${SINE}instrument new buzz kind=osc\nsong new s tempo=100 key=C:locrian class=stinger\nsong channel add s lead inst=buzz\npattern s.p steps=4 tpb=4\n  lead: C5 . . .\nsong section add s x p\n`);
    expect(styleCheck(bad.songs.get('s')!, g).ranges.map((r) => r.note)).toEqual([
      'the scale locrian is not one of the style\'s (major, dorian)',
      'the loudness class stinger is not one of the style\'s (music): song set s class=music',
      'buzz (channel lead) is not in the style\'s instrument palette (sine, kick, snare, hat)',
    ]);
    expect(styleCheck(ok.songs.get('s')!, undefined).skipped).toBe(true);
  });
  it('song new from-bible= writes the plain commands; they replay without the bible', () => {
    const lib = library(SINE);
    lib.guide = musicGuide(STYLE, BIBLE);
    const lines = tape(lib, 'song new m from-bible=market tempo=100');
    expect(lines).toEqual([
      'song new m tempo=100 key=D:major tags=town bible=market',
      'song channel add m lead inst=sine',
      'song channel add m drums kit=default',
      'motif set m theme "D5 - F#5 A5" tpb=4',
    ]);
    const again = library(SINE);
    tape(again, lines.join('\n'));
    expect(serializeSong(again.songs.get('m')!)).toBe(serializeSong(lib.songs.get('m')!));
    expect(() => tape(library(SINE), 'song new n from-bible=market')).toThrow(/no music bible entry 'market'/);
  });
  it('the style check compares a song with its bible entry', () => {
    const g = musicGuide(null, BIBLE);
    const lib = library(SINE);
    lib.guide = g;
    tape(lib, 'song new m from-bible=market\npattern m.p steps=4 tpb=4\n  lead: D5 . . .\nsong section add m x p');
    expect(styleCheck(lib.songs.get('m')!, g).pass).toBe(true);
    tape(lib, 'song set m tempo=120 key=A:minor\nmotif remove m theme\nsong channel set m lead inst=square_lead');
    expect(styleCheck(lib.songs.get('m')!, g).ranges.map((r) => r.note)).toEqual([
      'tempo 120; the bible says 96', 'key A:minor; the bible says D:major', 'channel lead plays square_lead; the bible says sine', 'the bible\'s motif theme is not in the song',
    ]);
  });
});

describe('stingers', () => {
  const tonicOf = (k: string) => parseKey(k).tonic;
  for (const name of Object.keys(STINGER_TEMPLATES)) {
    for (const key of ['D:major', 'A:minor', 'F#:dorian', 'G:minor', 'B:major']) {
      it(`${name} in ${key}: short, a fixed ending on the tonic, no loop, in key and in range, the stinger class`, () => {
        const lib = new Library();
        tape(lib, `song new st kind=stinger template=${name} key=${key}`);
        const s = lib.songs.get('st')!;
        expect(songProblems(s, (i) => !!lookupInstrument(lib, i))).toEqual({ errors: [], warnings: [] });
        const arr = arrange(s);
        expect(arr.loop).toBeNull();
        expect(arr.total).toBeGreaterThan(1);
        expect(arr.total).toBeLessThan(5);
        expect([s.kind, s.loudClass, s.ending, s.loop, s.key]).toEqual(['stinger', 'stinger', 'sting', false, key]);
        expect(keyCheck(s, arr).pass).toBe(true);
        expect(rangeCheck(s, arr, (i) => lookupInstrument(lib, i)).ranges).toEqual([]);
        // the lead ends on the tonic, held to the end of the piece
        const lead = channelNotes(s, arr, 'lead');
        const last = lead[lead.length - 1]!;
        expect(last.midi! % 12).toBe(tonicOf(key));
        expect(last.t + last.len).toBeCloseTo(arr.total, 6);
        for (const e of lead) expect(inKey(parseKey(key), e.midi!)).toBe(true);
      });
    }
  }
  it('takes the project\'s key when the command names none, and never loops', () => {
    const lib = new Library();
    lib.guide = musicGuide('key: E:minor\n', null);
    tape(lib, 'song new st kind=stinger template=game-over');
    expect(lib.songs.get('st')!.key).toBe('E:minor');
    expect(() => tape(lib, 'song loop st sting')).toThrow(/stinger: it ends on its ending and does not loop/);
    const plain = new Library();
    tape(plain, 'song new st2 template=item-get');
    expect(plain.songs.get('st2')!.key).toBe('C:major');
  });
});

describe('game layers', () => {
  const SONG = `${SINE}instrument new sine2 kind=osc
instrument set sine2 adsr=0.001,0,1,0.01 gain=0.5 velocity=0
song new g tempo=120 key=C:major
song channel add g a inst=sine
song channel add g b inst=sine2
song channel add g c inst=sine
pattern g.p steps=16 tpb=4
  a: C4 - - - - - - - - - - - - - - -
  b: E4 - - - - - - - - - - - - - - -
  c: G4 - - - - - - - - - - - - - - -
song section add g x p
`;
  it('layer-plan sets the layers in stacking order; a channel left out joins the base', () => {
    const lib = library(SONG);
    expect(tape(lib, 'layer-plan g base=a tension=b')).toEqual(['layer-plan g base=a,c tension=b']);
    const s = lib.songs.get('g')!;
    expect(s.layers).toEqual(['base', 'tension']);
    expect(s.channels.map((c) => c.layer)).toEqual(['base', 'tension', 'base']);
    expect(serializeSong(s)).toMatch(/\nlayers base tension\n/);
    expect(() => tape(lib, 'layer-plan g base=a,zz')).toThrow(/no channel zz/);
  });
  it('the mixes a game plays: the base alone and the base with each set of the others', () => {
    expect(layerCombinations(['base', 'tension', 'combat'])).toEqual([['base'], ['base', 'tension'], ['base', 'combat'], ['base', 'tension', 'combat']]);
  });
  it('measures every mix against the class, and each layer alone for its key and level', () => {
    const lib = library(SONG + 'layer-plan g base=a tension=b combat=c\n');
    const s = lib.songs.get('g')!;
    const style = resolveStyle({});
    const r = renderSong(s, { instruments: (i) => lookupInstrument(lib, i), mode: 'loop' });
    const { check, mixes } = layersCheck(s, r, style, songLoudnessRule(s, style), arrange(s));
    expect(mixes.map((m) => m.layers.join('+'))).toEqual(['base', 'base+tension', 'base+combat', 'base+tension+combat']);
    // three equal sines: each added layer raises the mix
    expect(mixes[1]!.lufs).toBeGreaterThan(mixes[0]!.lufs + 2);
    expect(mixes[3]!.lufs).toBeGreaterThan(mixes[1]!.lufs);
    for (const m of mixes) expect(m.seam!.pass).toBe(true);
    // a quiet song: every mix is under the music class
    expect(check.pass).toBe(false);
    expect(check.ranges.some((x) => /^base is -\d+\.\d LUFS, outside -16 ±2/.test(x.note))).toBe(true);
    // raise it into the class: the base alone and the full mix within -16 ±2
    const loud = cloneSong(s);
    loud.gain = 10 ** ((-16.5 - mixes[0]!.lufs) / 20);
    loud.channels = loud.channels.map((c) => (c.layer === 'base' ? c : { ...c, gain: 0.35 }));
    const r2 = renderSong(loud, { instruments: (i) => lookupInstrument(lib, i), mode: 'loop' });
    const c2 = layersCheck(loud, r2, style, songLoudnessRule(loud, style), arrange(loud));
    expect(c2.check.ranges.map((x) => x.note)).toEqual([]);
    expect(c2.check.pass).toBe(true);
  });
  it('flags a layer alone with notes out of key, and is skipped without a layer plan', () => {
    const lib = library(SONG.replace('  b: E4 -', '  b: F#4 -') + 'layer-plan g base=a,c tension=b\n');
    const s = lib.songs.get('g')!;
    const style = resolveStyle({});
    const r = renderSong(s, { instruments: (i) => lookupInstrument(lib, i), mode: 'loop' });
    expect(layersCheck(s, r, style, songLoudnessRule(s, style), arrange(s)).check.ranges.map((x) => x.note)).toContain('layer tension alone has 1 note outside C:major');
    const plain = library(SONG + 'song channel set g b layer=tension\n');
    const p = plain.songs.get('g')!;
    expect(layersCheck(p, renderSong(p, { instruments: (i) => lookupInstrument(plain, i) }), style, songLoudnessRule(p, style), arrange(p)).check.skipped).toBe(true);
  });
});

describe('song settings of this step', () => {
  it('tags, kind and harmony are written in the song file and round-trip through commands', () => {
    const lib = library(`${SINE}song new s tags=town,night kind=stinger\nsong channel add s pad inst=sine harmony=yes`);
    const s = lib.songs.get('s')!;
    expect(s.tags).toEqual(['town', 'night']);
    expect(s.loop).toBe(false);
    expect(serializeSong(s)).toMatch(/kind stinger\ntags town,night\nchannel pad inst=sine gain=1 pan=0 layer=base harmony=yes\n/);
    tape(lib, 'song channel set s pad harmony=no\nsong set s tags=none kind=song');
    expect(lib.songs.get('s')!.channels[0]!.harmony).toBeUndefined();
    expect(lib.songs.get('s')!.tags).toEqual([]);
  });
});
