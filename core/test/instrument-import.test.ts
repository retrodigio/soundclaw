// SFZ and SoundFont 2 readers: what they carry into zones and what they name as lost, on files built by test code.

import { describe, expect, it } from 'vitest';
import {
  InstrumentImportError, findSf2Preset, lossLines, normalisePath, parseSf2, parseSfz, planCommands, sf2PresetList, sf2PresetListText, sf2ToPlan, sfzSamples, sfzToPlan,
  type SampleFacts,
} from '../src/index.ts';
import { G, buildSf2, type Sf2Description } from './sf2-fixture.ts';

const facts: SampleFacts = { rate: 44100, frames: 44100 };
const plan = (sfz: string, f: (p: string) => SampleFacts = () => facts, inc?: Record<string, string>) => sfzToPlan(parseSfz(sfz, { include: (p) => inc?.[p] }), f);
const zoneLines = (sfz: string, f?: (p: string) => SampleFacts) => planCommands(plan(sfz, f), 'inst', (k) => k.replace(/\.wav$/, '').replace(/[^A-Za-z0-9_-]/g, '_')).filter((l) => l.startsWith('instrument zone add'));

describe('SFZ: reading the text', () => {
  it('headers inherit from global to master to group to region, and a new header resets the ones below it', () => {
    const p = parseSfz(`<global> volume=-3 ampeg_release=0.4
<master> pan=20
<group> lokey=c3 hikey=b3
<region> sample=a.wav pitch_keycenter=c3
<region> sample=b.wav pitch_keycenter=d3 volume=-6
<group> lokey=c4 hikey=b4
<region> sample=c.wav`);
    expect(p.regions.map((r) => [r.opcodes.get('sample'), r.opcodes.get('volume'), r.opcodes.get('pan'), r.opcodes.get('lokey')])).toEqual([
      ['a.wav', '-3', '20', 'c3'], ['b.wav', '-6', '20', 'c3'], ['c.wav', '-3', '20', 'c4'],
    ]);
    const q = parseSfz('<global> volume=-3\n<region> sample=a.wav\n<global>\n<region> sample=b.wav');
    expect(q.regions.map((r) => r.opcodes.get('volume'))).toEqual(['-3', undefined]);
  });

  it('comments, #define, #include, default_path and a sample name with spaces', () => {
    const text = `// a comment
#define $KEY 61
/* block
   comment */
<control> default_path=Sam ples\\
#include "parts/extra.sfz"
<region> sample=A note.wav key=$KEY // trailing
<region> sample=b.wav lokey=c4 hikey=d4 pitch_keycenter=c4`;
    const p = parseSfz(text, { include: (path) => (path === 'parts/extra.sfz' ? '<global> volume=-2' : undefined) });
    expect(p.regions).toHaveLength(2);
    expect(p.regions[0]!.opcodes.get('sample')).toBe('A note.wav');
    expect(p.regions[0]!.opcodes.get('key')).toBe('61');
    expect(p.regions[0]!.opcodes.get('volume')).toBe('-2');
    expect(sfzSamples(p).map((s) => s.path)).toEqual(['Sam ples/A note.wav', 'Sam ples/b.wav']);
  });

  it('an include that cannot be read is an error naming it; paths are folded', () => {
    expect(() => parseSfz('#include "gone.sfz"', { include: () => undefined })).toThrow(/gone\.sfz/);
    expect(normalisePath('a\\b/../c/./d.wav')).toBe('a/c/d.wav');
  });

  it('a generator or an absolute path is refused, naming the region', () => {
    expect(() => sfzSamples(parseSfz('<region> sample=a.wav\n<region> sample=*sine'))).toThrow(/region 2: sample=\*sine is a generator/);
    expect(() => sfzSamples(parseSfz('<region> sample=/etc/x.wav'))).toThrow(/region 1: .*absolute path/);
    expect(() => sfzSamples(parseSfz('<control> default_path=C:\\Samples\\\n<region> sample=x.wav'))).toThrow(/absolute path/);
  });
});

describe('SFZ: regions as zones', () => {
  it('keys, velocities, root, tuning, level and pan', () => {
    const lines = zoneLines('<region> sample=a.wav lokey=c3 hikey=e3 pitch_keycenter=d3 lovel=1 hivel=80 tune=-12 transpose=1 volume=-6 pan=-50 loop_mode=no_loop');
    expect(lines).toEqual(['instrument zone add inst sample=a root=D3 tune=88 keys=C3-E3 vel=1-80 gain=-6 pan=-0.5 loop=none loopmode=none']);
  });

  it('key= sets the keys and the root; note names are read; octave_offset shifts them', () => {
    expect(zoneLines('<region> sample=a.wav key=c#4 loop_mode=one_shot')).toEqual(['instrument zone add inst sample=a root=C#4 keys=C#4-C#4 loop=none loopmode=oneshot']);
    expect(zoneLines('<control> octave_offset=1\n<region> sample=a.wav key=60 loop_mode=no_loop')[0]).toContain('root=C5 keys=C5-C5');
  });

  it('offset, end and loops are settled in seconds from where the zone starts playing', () => {
    const f = (): SampleFacts => ({ rate: 1000, frames: 5000 });
    const lines = zoneLines('<region> sample=a.wav key=60 offset=500 end=4000 loop_mode=loop_sustain loop_start=1000 loop_end=1999 loop_crossfade=0.05', f);
    expect(lines[0]).toContain('start=0.5 end=4 loop=0.5-1.5 xfade=0.05');
  });

  it('the file\'s own loop points are followed when the SFZ gives none, and a loop mode with no loop anywhere is reported', () => {
    const withLoop = (): SampleFacts => ({ rate: 44100, frames: 44100, loop: [100, 20000] });
    expect(zoneLines('<region> sample=a.wav key=60', withLoop)[0]).toContain('loopmode=continuous');
    const none = plan('<region> sample=a.wav key=60 loop_mode=loop_sustain');
    expect(none.zones[0]!.zone.loopmode).toBe('none');
    expect(lossLines(none.losses, 'region').join('\n')).toMatch(/approximated: loop_mode \(region 1\)/);
  });

  it('release samples carry their decay; seq_position makes round robin takes the instrument cycles through', () => {
    const p = plan(`<group> key=60 seq_length=3 loop_mode=no_loop
<region> sample=a1.wav seq_position=1
<region> sample=a2.wav seq_position=2
<region> sample=a3.wav seq_position=3
<group>
<region> sample=r.wav key=60 trigger=release rt_decay=2 loop_mode=no_loop`);
    expect(p.rr).toBe('cycle');
    expect(p.zones.map((z) => z.zone.rr)).toEqual([[1, 3], [2, 3], [3, 3], null]);
    expect(p.zones[3]!.zone.trigger).toBe('release');
    expect(p.zones[3]!.zone.releaseDecay).toBe(2);
  });

  it('lorand and hirand ranges become takes picked by hash, and unequal ranges are reported', () => {
    const p = plan(`<group> key=60 loop_mode=no_loop
<region> sample=a.wav lorand=0 hirand=0.5
<region> sample=b.wav lorand=0.5 hirand=1`);
    expect(p.rr).toBe('hash');
    expect(p.zones.map((z) => z.zone.rr)).toEqual([[1, 2], [2, 2]]);
    const q = plan(`<group> key=60 loop_mode=no_loop
<region> sample=a.wav lorand=0 hirand=0.8
<region> sample=b.wav lorand=0.8 hirand=1`);
    expect(lossLines(q.losses, 'region').join('\n')).toMatch(/the ranges are not equal/);
  });

  it('group and off_by become one choke number, and a one-way cut is reported', () => {
    const p = plan(`<region> sample=open.wav key=46 group=1 off_by=2 loop_mode=one_shot
<region> sample=closed.wav key=42 group=2 loop_mode=one_shot
<region> sample=kick.wav key=36 loop_mode=one_shot`);
    expect(p.zones.map((z) => z.zone.choke)).toEqual([1, 1, 0]);
    expect(lossLines(p.losses, 'region').join('\n')).toMatch(/approximated: group\/off_by \(region 1\).*cut by group 2 only/);
  });

  it('the envelope is the commonest of the regions, the odd ones are reported, velocity sensitivity follows amp_veltrack', () => {
    const p = plan(`<global> ampeg_attack=0.01 ampeg_release=0.3 ampeg_sustain=80 amp_veltrack=50
<region> sample=a.wav key=60
<region> sample=b.wav key=61
<region> sample=c.wav key=62 ampeg_release=1`);
    expect(p.adsr).toEqual([0.01, 0, 0.8, 0.3]);
    expect(p.velocity).toBe(0.5);
    expect(lossLines(p.losses, 'region').join('\n')).toMatch(/approximated: ampeg_attack\/decay\/sustain\/release \(region 3\)/);
  });

  it('unpitched regions: every region at keytrack 0 makes an unpitched instrument; a few are one zone per key', () => {
    const all = plan('<region> sample=a.wav lokey=36 hikey=40 pitch_keytrack=0');
    expect(all.pitched).toBe(false);
    expect(all.zones).toHaveLength(1);
    const some = plan('<region> sample=a.wav lokey=36 hikey=38 pitch_keytrack=0 loop_mode=no_loop\n<region> sample=b.wav lokey=40 hikey=50 pitch_keycenter=45 loop_mode=no_loop');
    expect(some.pitched).toBe(true);
    expect(some.zones.map((z) => [z.zone.keys[0], z.zone.root])).toEqual([[36, 36], [37, 37], [38, 38], [40, 45]]);
  });

  it('every opcode the zones cannot carry is named with the regions that had it; harmless ones are not', () => {
    const p = plan(`<group> cutoff=900 fil_type=lpf_2p
<region> sample=a.wav key=60 resonance=4 label_cc1=Volume
<region> sample=b.wav key=61 cutoff_cc1=2000 hint_ram_based=1
<curve> curve_index=1 v000=0 v127=1`);
    const lines = lossLines(p.losses, 'region');
    expect(lines).toContain('lost: cutoff (regions 1-2)');
    expect(lines).toContain('lost: fil_type (regions 1-2)');
    expect(lines).toContain('lost: resonance (region 1)');
    expect(lines).toContain('lost: cutoff_cc1 (region 2)');
    expect(lines.join('\n')).toContain('<curve> header');
    expect(lines.join('\n')).not.toMatch(/hint_ram_based|label_cc/);
  });

  it('a region with no sample or an empty key range plays nothing and is left out with a note', () => {
    const p = plan('<region> key=60\n<region> sample=a.wav lokey=70 hikey=60\n<region> sample=b.wav key=62 loop_mode=no_loop');
    expect(p.zones).toHaveLength(1);
    expect(p.notes.join('\n')).toMatch(/region 1 has no sample[\s\S]*region 2 has lokey above hikey/);
  });

  it('values a zone cannot hold are clamped and reported', () => {
    const p = plan('<region> sample=a.wav key=60 volume=-90 tune=1500 loop_mode=no_loop');
    expect(p.zones[0]!.zone.gain).toBe(-60);
    expect(p.zones[0]!.zone.tune).toBe(1200);
    expect(lossLines(p.losses, 'region').join('\n')).toMatch(/approximated: volume/);
    expect(lossLines(p.losses, 'region').join('\n')).toMatch(/approximated: tune/);
  });

  it('too many regions is an error that says so', () => {
    const many = Array.from({ length: 520 }, (_, i) => `<region> sample=a.wav key=${i % 128} loop_mode=no_loop lovel=${1 + (i >> 7) * 25} hivel=${25 + (i >> 7) * 25}`).join('\n');
    expect(() => plan(many)).toThrow(InstrumentImportError);
    expect(() => plan(many)).toThrow(/at most 512/);
  });
});

// ---- SoundFont 2 -----------------------------------------------------------------------------------------------------

const ramp = (n: number, amp = 8000): Int16Array => Int16Array.from({ length: n }, (_, i) => Math.round(Math.sin(i / 20) * amp));

function font(over: Partial<Sf2Description> = {}): Sf2Description {
  return {
    info: { INAM: 'Test font', ICOP: 'Made by the tests', ICMT: 'invented sounds' },
    samples: [
      { name: 'tone c4', pcm: ramp(2000), rate: 22050, rootKey: 60, correction: 7, loop: [500, 1500] },
      { name: 'tone left', pcm: ramp(1500), rate: 44100, rootKey: 62, type: 4 },
      { name: 'tone right', pcm: ramp(1500), rate: 44100, rootKey: 62, type: 2 },
      { name: 'hat', pcm: ramp(800), rate: 44100, rootKey: 255 },
    ],
    instruments: [
      {
        name: 'Tone', zones: [
          { gens: [[G.attackVolEnv, -2400], [G.releaseVolEnv, -1200], [G.sustainVolEnv, 200], [G.sampleModes, 1], [G.fineTune, 5]] },
          { keys: [0, 71], vel: [0, 100], target: 0, gens: [[G.initialAttenuation, 60], [G.coarseTune, -1]] },
          { keys: [72, 127], vel: [0, 127], target: 0, gens: [[G.overridingRootKey, 72], [G.sampleModes, 3], [G.initialFilterFc, 4000], [G.reverbEffectsSend, 200]], mods: 2 },
        ],
      },
      { name: 'Pair', zones: [{ keys: [60, 72], target: 1, gens: [[G.sampleModes, 0]] }, { keys: [60, 72], target: 2, gens: [[G.sampleModes, 0]] }] },
      { name: 'Hats', zones: [{ keys: [42, 42], target: 3, gens: [[G.exclusiveClass, 7], [G.scaleTuning, 0], [G.holdVolEnv, -2000]] }, { keys: [46, 46], target: 3, gens: [[G.exclusiveClass, 7], [G.scaleTuning, 0]] }] },
    ],
    presets: [
      { name: 'Tone preset', bank: 0, program: 0, zones: [{ target: 0 }] },
      { name: 'Pair preset', bank: 0, program: 1, zones: [{ gens: [[G.pan, 100]] }, { keys: [64, 127], target: 1 }] },
      { name: 'Hat kit', bank: 128, program: 0, zones: [{ target: 2 }] },
    ],
    ...over,
  };
}

describe('SoundFont 2: reading the structure', () => {
  it('reads INFO, presets, instruments and sample headers', () => {
    const f = parseSf2(buildSf2(font()));
    expect(f.info).toMatchObject({ name: 'Test font', copyright: 'Made by the tests', comment: 'invented sounds', version: '2.01' });
    expect(f.presets.map((p) => [p.name, p.bank, p.program])).toEqual([['Tone preset', 0, 0], ['Pair preset', 0, 1], ['Hat kit', 128, 0]]);
    expect(f.samples.map((s) => [s.name, s.rate, s.originalPitch, s.pitchCorrection])).toEqual([['tone c4', 22050, 60, 7], ['tone left', 44100, 62, 0], ['tone right', 44100, 62, 0], ['hat', 44100, 255, 0]]);
    expect(sf2PresetList(f)).toHaveLength(3);
    expect(sf2PresetListText(f)).toBe('000:000  Tone preset  (1 zone)\n000:001  Pair preset  (1 zone)\n128:000  Hat kit  (1 zone)');
  });

  it('finds a preset by bank:program, by name, or by part of a name; several presets need a choice', () => {
    const f = parseSf2(buildSf2(font()));
    expect(findSf2Preset(f, '128:0').name).toBe('Hat kit');
    expect(findSf2Preset(f, 'pair preset').name).toBe('Pair preset');
    expect(findSf2Preset(f, 'hat').name).toBe('Hat kit');
    expect(() => findSf2Preset(f, 'preset')).toThrow(/names 2 presets/);
    expect(() => findSf2Preset(f, '3:3')).toThrow(/no preset 3:3/);
    expect(() => findSf2Preset(f, undefined)).toThrow(/3 presets; name one with preset=/);
    expect(findSf2Preset(parseSf2(buildSf2(font({ presets: [font().presets[0]!] }))), undefined).name).toBe('Tone preset');
  });

  it('refuses what it cannot read, saying why', () => {
    expect(() => parseSf2(Uint8Array.from([1, 2, 3]))).toThrow(/not a SoundFont 2/);
    expect(() => parseSf2(buildSf2(font({ version: [3, 0] })))).toThrow(/SoundFont 3\.0 \(compressed/);
    const b = buildSf2(font());
    expect(() => parseSf2(b.subarray(0, b.length - 400))).toThrow(InstrumentImportError);
  });

  it('a damaged file ends in a plain error, never anything else', () => {
    const good = buildSf2(font());
    let seed = 12345;
    const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let k = 0; k < 400; k++) {
      const b = good.slice();
      for (let j = 0; j < 1 + Math.floor(rnd() * 6); j++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
      try {
        const f = parseSf2(b);
        for (const p of f.presets.keys()) { try { sf2ToPlan(f, p); } catch (e) { expect(e).toBeInstanceOf(InstrumentImportError); } }
      } catch (e) {
        expect(e).toBeInstanceOf(InstrumentImportError);
      }
    }
  });
});

describe('SoundFont 2: a preset as zones', () => {
  const planOf = (name: string, d = font()) => { const f = parseSf2(buildSf2(d)); return sf2ToPlan(f, f.presets.findIndex((p) => p.name === name)); };

  it('key and velocity ranges, root, tuning, level, loops and the sample\'s own facts', () => {
    const r = planOf('Tone preset');
    expect(r.plan.zones).toHaveLength(2);
    const [a, b] = r.plan.zones.map((z) => z.zone);
    expect([a!.keys, a!.vel, a!.root, a!.tune, a!.gain]).toEqual([[0, 71], [1, 100], 60, -100 + 5 + 7, -6]);
    // the file's loop is the sample's loop: the zone follows the sample (loop=sample), mode 1 is a loop through the release
    expect([a!.loop, a!.loopmode]).toEqual(['sample', 'continuous']);
    expect([b!.keys, b!.vel, b!.root, b!.loopmode]).toEqual([[72, 127], [1, 127], 72, 'sustain']);
    expect(r.samples).toHaveLength(1);
    expect(r.samples[0]).toMatchObject({ root: 60, tune: -7, loop: [500, 1500] });
    expect(r.samples[0]!.audio).toMatchObject({ rate: 22050, channels: 1, format: 'pcm16', frames: 2000 });
  });

  it('the volume envelope is the commonest zone\'s, in seconds, with decibel decays', () => {
    const [a, d, s, rel] = planOf('Tone preset').plan.adsr!;
    expect(a).toBeCloseTo(0.25, 3);
    expect(d).toBeLessThan(0.001);
    expect(s).toBeCloseTo(10 ** (-200 / 200), 3);
    expect(rel).toBeCloseTo(0.5, 3);
  });

  it('what the zones cannot say is named: filters, effect sends, modulators, the hold stage', () => {
    const l = lossLines(planOf('Tone preset').plan.losses, 'zone').join('\n');
    expect(l).toContain('lost: initialFilterFc (zone 2)');
    expect(l).toContain('lost: reverbEffectsSend (zone 2)');
    expect(l).toContain('lost: modulators (zone 2): 2 in this zone');
    const hats = lossLines(planOf('Hat kit').plan.losses, 'zone').join('\n');
    expect(hats).toContain('lost: holdVolEnv (zone 1)');
  });

  it('a stereo pair is a hard left and a hard right mono zone; the preset\'s pan adds to the rest', () => {
    const r = planOf('Pair preset');
    expect(r.plan.zones.map((z) => [z.zone.pan, z.zone.keys])).toEqual([[-1, [64, 72]], [1, [64, 72]]]);
    expect(r.samples.map((s) => s.header.name)).toEqual(['tone left', 'tone right']);
  });

  it('exclusive classes become choke groups; scaleTuning 0 zones are one zone per key (or an unpitched instrument when all are)', () => {
    const r = planOf('Hat kit');
    expect(r.plan.pitched).toBe(false);
    expect(r.plan.zones.map((z) => [z.zone.keys, z.zone.choke, z.zone.root])).toEqual([[[42, 42], 1, 255 > 127 ? 60 : 0], [[46, 46], 1, 60]]);
    expect(r.samples[0]!.root).toBe(60);
  });

  it('24-bit data (sm24) is kept whole', () => {
    const pcm = Int16Array.from([0, 1000, -1000, 2000, -2000, 3000, -3000, 4000]);
    const low = Uint8Array.from([0, 7, 255, 128, 1, 2, 3, 4]);
    const d = font({ samples: [{ name: 'deep', pcm, low, rate: 44100, rootKey: 60 }], instruments: [{ name: 'I', zones: [{ target: 0 }] }], presets: [{ name: 'P', bank: 0, program: 0, zones: [{ target: 0 }] }] });
    const r = planOf('P', d);
    const a = r.samples[0]!.audio;
    expect(a.format).toBe('pcm24');
    expect([...a.data.subarray(0, 9)]).toEqual([0, 0, 0, 7, 0xe8, 0x03, 255, 0x18, 0xfc]);
  });

  it('a sample outside the data, or a ROM sample, stops the import naming the zone', () => {
    const bad = font(); bad.samples[0]!.rate = 100;
    expect(() => planOf('Tone preset', bad)).toThrow(/zone 1 \(instrument 'Tone', sample 'tone c4'\)/);
    const rom = font(); rom.samples[3]!.type = 0x8001;
    expect(() => planOf('Hat kit', rom)).toThrow(/ROM sample/);
  });
});
