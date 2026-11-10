// Samples in the project document: the tape commands (parsing, normal forms, applying, replay), the licence rules
// (states under a policy, propagation to everything that reaches a sample, attribution), and the stereo sample layer.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHIP_POLICY, Library, applyCommand, attributionText, itemLicence, licenceState, parse, reachedSamples, renderChannels, replay, sampleAddText, serializeSample, settleSampleAdd, shipPolicyOf,
  type SampleBank, type SampleData, type TapeEntry,
} from '../src/index.ts';
import { build } from './layered-helpers.ts';

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const H3 = 'c'.repeat(64);
const ADD = (name: string, hash = H1, extra = '') => `sample add ${name} hash=${hash} rate=44100 channels=2 frames=44100 format=pcm16${extra}`;

const parsed = (text: string) => { const p = parse(text); if (p.errors.length) throw new Error(p.errors[0]!.message); return p.commands[0]!; };
const bad = (text: string) => { const p = parse(text); expect(p.errors.length, text).toBeGreaterThan(0); return p.errors[0]!.message; };

describe('sample commands', () => {
  it('sample add has a normal form: fixed order, defaults written out (source file, licence unknown)', () => {
    expect(parsed(ADD('door')).text).toBe(`sample add door hash=${H1} rate=44100 channels=2 frames=44100 format=pcm16 source=file licence=unknown`);
    const full = parsed(`sample add boing format=pcm24 frames=22050 channels=1 rate=48000 licence=CC-BY-4.0 hash=${H2} tags=Wood,hit,wood root=C#4 tune=-12.5 loop=100-2000 slices=0,500,1000 gain=-3 note="a short hit; made by test" source=generated provider=elevenlabs prompt="a wood hit" take=2/3 credits=8 seed=7 parents=${H1},${H3} attribution="by Test, CC BY 4.0" date=2026-11-09T10:00:00Z author=agent:claude`);
    expect(full.text).toBe(`sample add boing hash=${H2} rate=48000 channels=1 frames=22050 format=pcm24 root=C#4 tune=-12.5 loop=100-2000 loopmode=sustain slices=0,500,1000 tags=hit,wood gain=-3 note="a short hit; made by test" source=generated date=2026-11-09T10:00:00Z author=agent:claude provider=elevenlabs prompt="a wood hit" seed=7 take=2/3 credits=8 parents=${H1},${H3} licence=CC-BY-4.0 attribution="by Test, CC BY 4.0"`);
    // the normal form parses back to itself
    expect(parsed(full.text).text).toBe(full.text);
  });
  it('is checked: a name, the hash and the audio facts are needed, and every value has a range', () => {
    expect(bad(`sample add ${'x'.repeat(49)} hash=${H1} rate=44100 channels=1 frames=10 format=pcm16`)).toMatch(/not a sample name/);
    expect(bad('sample add door rate=44100 channels=1 frames=10 format=pcm16')).toMatch(/hash= is needed/);
    expect(bad('sample add door hash=nope rate=44100 channels=1 frames=10 format=pcm16')).toMatch(/64 lowercase hex digits/);
    expect(bad(`sample add door hash=${H1} rate=44100 channels=9 frames=10 format=pcm16`)).toMatch(/1-8 channels/);
    expect(bad(`sample add door hash=${H1} rate=44100 channels=1 frames=10 format=mp3`)).toMatch(/pcm8, pcm16/);
    expect(bad(ADD('door', H1, ' root=H4'))).toMatch(/note like C4/);
    expect(bad(ADD('door', H1, ' loop=300-100'))).toMatch(/start before end/);
    expect(bad(ADD('door', H1, ' loop=0-99999999'))).toMatch(/past the 44100 frames/);
    expect(bad(ADD('door', H1, ' slices=5,3'))).toMatch(/ascending/);
    expect(bad(ADD('door', H1, ' tags="a b"'))).toMatch(/tags/);
    expect(bad(ADD('door', H1, ' gain=99'))).toMatch(/-60 to 24/);
    expect(bad(ADD('door', H1, ' licence="free for all!"'))).toMatch(/SPDX id/);
    expect(bad(ADD('door', H1, ' terms=file:///x'))).toMatch(/http/);
    expect(bad(ADD('door', H1, ' wibble=1'))).toMatch(/no field 'wibble'/);
    expect(bad(ADD('door', H1, ' tags=a tags=b'))).toMatch(/twice/);
  });
  it('never keeps an absolute path from a disk in the origin (a file name, a library path or an address are fine)', () => {
    for (const p of ['/Users/ana/Music/door.wav', '~/door.wav', 'C:\\Users\\ana\\door.wav', '\\\\server\\share\\door.wav']) expect(bad(ADD('door', H1, ` origin="${p}"`)), p).toMatch(/not an absolute path/);
    expect(parsed(ADD('door', H1, ' origin=door.wav')).text).toContain('origin=door.wav');
    expect(parsed(ADD('door', H1, ' origin=foley:doors/creak_04.wav')).text).toContain('origin=foley:doors/creak_04.wav');
    expect(parsed(ADD('door', H1, ' origin=https://example.org/a.wav')).text).toContain('origin=https://example.org/a.wav');
  });
  it('sample set changes fields; field=none clears one; other audio needs the facts about it', () => {
    expect(parsed('sample set door root=C4 tags=x licence=CC0-1.0').text).toBe('sample set door root=C4 tags=x licence=CC0-1.0');
    expect(parsed('sample set door root=none loop=none note=none').text).toBe('sample set door root=none loop=none note=none');
    expect(bad('sample set door')).toMatch(/at least one/);
    expect(bad(`sample set door hash=${H2}`)).toMatch(/needs rate=, channels=, frames= and format=/);
    expect(bad('sample set door frames=10')).toMatch(/goes with hash=/);
    expect(bad('sample set door hash=none')).toMatch(/64 lowercase hex/);
  });
  it('applies to the library: add, set, rename, remove, with unique names ignoring case', () => {
    const lib = new Library();
    applyCommand(lib, parsed(ADD('Door')));
    expect(lib.samples.get('Door')).toMatchObject({ hash: H1, rate: 44100, channels: 2, frames: 44100, format: 'pcm16', tags: [], prov: { source: 'file' }, licence: { id: 'unknown' } });
    expect(() => applyCommand(lib, parsed(ADD('door')))).toThrow(/exists already as 'Door'.*ignoring case/);
    expect(() => applyCommand(lib, parsed(ADD('Door', H2)))).toThrow(/exists already.*sample set Door hash=/);
    applyCommand(lib, parsed('sample set Door root=A3 tune=10 licence=CC0-1.0 tags=wood,door loop=10-500 loopmode=continuous'));
    expect(lib.samples.get('Door')).toMatchObject({ root: 57, tune: 10, licence: { id: 'CC0-1.0' }, tags: ['door', 'wood'], loop: [10, 500], loopMode: 'continuous' });
    applyCommand(lib, parsed('sample set Door root=none loop=none loopmode=none'));
    expect(lib.samples.get('Door')!.root).toBeUndefined();
    expect(lib.samples.get('Door')!.loop).toBeUndefined();
    applyCommand(lib, parsed(`sample set Door hash=${H2} rate=48000 channels=1 frames=9000 format=pcm24`));
    expect(lib.samples.get('Door')).toMatchObject({ hash: H2, rate: 48000, channels: 1, frames: 9000, format: 'pcm24' });
    expect(() => applyCommand(lib, parsed('sample set nope root=C4'))).toThrow(/no sample 'nope'/);
    expect(() => applyCommand(lib, parsed('sample set Door loop=0-99999'))).toThrow(/past the 9000 frames/);
    applyCommand(lib, parsed(ADD('Other', H3)));
    expect(() => applyCommand(lib, parsed('sample rename Door OTHER'))).toThrow(/exists already as 'Other'/);
    applyCommand(lib, parsed('sample rename Door Gate'));
    expect([...lib.samples.keys()]).toEqual(['Gate', 'Other']);
    expect(lib.samples.get('Gate')!.name).toBe('Gate');
    applyCommand(lib, parsed('sample remove Gate'));
    expect([...lib.samples.keys()]).toEqual(['Other']);
    expect(() => applyCommand(lib, parsed('sample remove Gate'))).toThrow(/no sample 'Gate'/);
  });
  it('a rename follows the sounds and instruments that play the sample; a remove is refused while they do', () => {
    const lib = build(`${ADD('knock')}\nsound new s voice=layered\nlayer add s sample sample=knock\ninstrument new tap from=square_lead`);
    lib.instruments.set('tap', { ...lib.instruments.get('tap')!, voice: build('sound new i voice=layered\nlayer add i sample sample=knock').get('i') as never });
    expect(() => applyCommand(lib, parsed('sample remove knock'))).toThrow(/played by sound s, instrument tap/);
    applyCommand(lib, parsed('sample rename knock rap'));
    const s = lib.get('s') as { layers: { p: Record<string, unknown> }[] };
    expect(s.layers[0]!.p.sample).toBe('rap');
    expect((lib.instruments.get('tap')!.voice.layers[0]!.p as Record<string, unknown>).sample).toBe('rap');
  });
  it('is written into the command by the writer: the date and author of the tape line', () => {
    const c = settleSampleAdd(parsed(ADD('door')), 'human:ana', '2026-11-09T10:00:00Z');
    expect(c.text).toBe(`sample add door hash=${H1} rate=44100 channels=2 frames=44100 format=pcm16 source=file date=2026-11-09T10:00:00Z author=human:ana licence=unknown`);
    // what is there already is kept
    expect(settleSampleAdd(parsed(ADD('door', H1, ' date=2020-01-01 author=system:upgrade')), 'human:ana', '2026-11-09T10:00:00Z').text).toContain('date=2020-01-01 author=system:upgrade');
  });
  it('replays from the tape and undoes: an undone add is no sample, a redone one is back', () => {
    const entries: TapeEntry[] = [
      { seq: 1, by: 'agent:claude', group: 'g1', cmd: parsed(ADD('door')).text },
      { seq: 2, by: 'agent:claude', group: 'g2', cmd: 'sample set door root=C4' },
      { seq: 3, by: 'agent:claude', group: 'g3', cmd: 'undo group=g2' },
    ];
    expect(replay(entries).library.samples.get('door')!.root).toBeUndefined();
    expect(replay(entries.slice(0, 2)).library.samples.get('door')!.root).toBe(60);
    expect(replay([...entries, { seq: 4, by: 'agent:claude', group: 'g4', cmd: 'undo group=g1' }]).library.samples.size).toBe(0);
    expect(replay([...entries, { seq: 4, by: 'agent:claude', group: 'g4', cmd: 'redo group=g3' }]).library.samples.get('door')!.root).toBe(60);
  });
  it('writes the .sample text one field a line, and sampleAddText is the add command for an entry', () => {
    const lib = new Library();
    applyCommand(lib, parsed(ADD('door', H1, ' root=C4 tags=a,b note="hello world" licence=CC-BY-4.0 attribution="Ana"')));
    const e = lib.samples.get('door')!;
    expect(serializeSample(e)).toBe(`soundclaw sample 1\nname door\nhash ${H1}\nrate 44100\nchannels 2\nframes 44100\nformat pcm16\nroot C4\ntags a,b\nnote "hello world"\nsource file\nlicence CC-BY-4.0\nattribution Ana\n`);
    expect(parsed(sampleAddText(e)).text).toBe(sampleAddText(e));
    const again = new Library();
    applyCommand(again, parsed(sampleAddText(e)));
    expect(again.samples.get('door')).toEqual(e);
  });
});

describe('licences', () => {
  it('stand under the default policy: own, CC0 and CC-BY ship (CC-BY with attribution), generated audio ships from a paid plan; unknown, NC, ND, free-plan and proprietary do not', () => {
    const state = (id: string, attribution?: string) => licenceState({ id, ...(attribution ? { attribution } : {}) }).state;
    expect(state('own')).toBe('shippable');
    expect(state('CC0-1.0')).toBe('shippable');
    expect(state('CC-BY-4.0')).toBe('attribution');
    expect(state('CC-BY-SA-4.0')).toBe('attribution');
    expect(state('generated:elevenlabs:pro')).toBe('shippable');
    expect(state('generated:elevenlabs:free')).toBe('blocked');
    expect(state('unknown')).toBe('unknown');
    expect(state('CC-BY-NC-4.0')).toBe('blocked');
    expect(state('CC-BY-ND-4.0')).toBe('blocked');
    expect(state('proprietary:bought a pack')).toBe('blocked');
    expect(state('MIT')).toBe('blocked'); // not on the list of what may ship
    expect(state('own', 'thanks to Ana')).toBe('shippable'); // own audio needs no credit
  });
  it('--allow-licence lets an id through for one export; a policy in project.json changes the lists', () => {
    expect(licenceState({ id: 'unknown' }, DEFAULT_SHIP_POLICY, ['unknown']).state).toBe('shippable');
    expect(licenceState({ id: 'CC-BY-NC-4.0' }, DEFAULT_SHIP_POLICY, ['CC-BY-NC-4.0']).state).toBe('attribution');
    const p = shipPolicyOf({ allow: ['own', 'MIT'], block: [] });
    expect(licenceState({ id: 'MIT' }, p).state).toBe('shippable');
    expect(licenceState({ id: 'CC0-1.0' }, p).state).toBe('blocked');
    expect(licenceState({ id: 'unknown' }, p).state).toBe('unknown'); // unknown is always unknown, never shippable by a list
    expect(shipPolicyOf(undefined)).toEqual(DEFAULT_SHIP_POLICY);
    expect(shipPolicyOf({ allow: 'nonsense' })).toEqual(DEFAULT_SHIP_POLICY);
  });
  it('non-commercial and no-derivatives licences ship only when the allow list names an NC or ND pattern; a broad pattern never admits them', () => {
    const st = (id: string, p: Parameters<typeof licenceState>[1]) => licenceState({ id }, p).state;
    // broad patterns, even `*`, do not admit them (and a policy that drops the default blocks does not either)
    expect(st('CC-BY-NC-4.0', shipPolicyOf({ allow: ['CC-BY-*'], block: [] }))).toBe('blocked');
    expect(st('CC-BY-ND-4.0', shipPolicyOf({ allow: ['*'], block: [] }))).toBe('blocked');
    expect(st('CC-BY-NC-SA-4.0', shipPolicyOf({ allow: ['CC-BY-*', 'own'] }))).toBe('blocked');
    expect(licenceState({ id: 'CC-BY-NC-4.0' }, shipPolicyOf({ allow: ['CC-BY-*'], block: [] })).reason).toMatch(/non-commercial or no-derivatives/);
    // an explicit NC or ND pattern admits exactly what it names, over the default block patterns
    expect(st('CC-BY-NC-4.0', shipPolicyOf({ allow: ['own', 'CC-BY-NC-4.0'] }))).toBe('attribution');
    expect(st('CC-BY-NC-SA-4.0', shipPolicyOf({ allow: ['own', 'CC-BY-NC-4.0'] }))).toBe('blocked');
    expect(st('CC-BY-NC-SA-4.0', shipPolicyOf({ allow: ['CC-BY-NC-*'] }))).toBe('attribution');
    expect(st('CC-BY-ND-4.0', shipPolicyOf({ allow: ['CC-BY-NC-*'] }))).toBe('blocked');
    expect(st('CC-BY-ND-4.0', shipPolicyOf({ allow: ['*-ND-*'] }))).toBe('attribution');
    // an explicit block of the same id still wins
    expect(st('CC-BY-NC-4.0', shipPolicyOf({ allow: ['CC-BY-NC-4.0'], block: ['CC-BY-NC-4.0'] }))).toBe('blocked');
    // the default policy blocks both
    expect(st('CC-BY-NC-4.0', DEFAULT_SHIP_POLICY)).toBe('blocked');
    expect(st('CC-BY-ND-4.0', DEFAULT_SHIP_POLICY)).toBe('blocked');
  });
  const LIB = `${ADD('own_hit', H1, ' licence=own')}\n${ADD('cc0_air', H2, ' licence=CC0-1.0')}\n${ADD('by_bell', H3, ' licence=CC-BY-4.0 attribution="Bell by Ana"')}\n${ADD('mystery', 'd'.repeat(64))}`;
  it('propagate to every sound, instrument and song that reaches a sample, the worst state winning', () => {
    const lib = build(`${LIB}
sound new clean voice=layered; layer add clean sample sample=own_hit; layer add clean sample sample=cc0_air
sound new credit voice=layered; layer add credit sample sample=by_bell; layer add credit osc
sound new murky voice=layered; layer add murky sample sample=own_hit; layer add murky sample sample=mystery
sound new synth voice=layered; layer add synth osc
instrument new bell from=square_lead
song new tune
song channel add tune lead inst=bell
song channel add tune other inst=sine`);
    const bell = build('sound new i voice=layered\nlayer add i sample sample=by_bell').get('i') as never;
    lib.instruments.set('bell', { ...lib.instruments.get('bell')!, voice: bell });
    const state = (kind: 'sound' | 'instrument' | 'song' | 'sample', id: string) => itemLicence(lib, kind, id);
    expect(state('sound', 'clean')).toMatchObject({ state: 'shippable' });
    expect(state('sound', 'credit').state).toBe('attribution');
    expect(state('sound', 'murky').state).toBe('unknown');
    expect(state('sound', 'murky').samples.map((s) => [s.name, s.state])).toEqual([['mystery', 'unknown'], ['own_hit', 'shippable']]);
    expect(state('sound', 'synth')).toMatchObject({ state: 'shippable', samples: [] }); // no sample, nothing to block
    expect(state('instrument', 'bell').state).toBe('attribution');
    expect(state('song', 'tune').state).toBe('attribution'); // through the instrument its channel plays
    expect(state('sample', 'mystery').state).toBe('unknown');
  });
  it('reach through the parents of a derived sample (by hash), so a derived sample of a blocked one is blocked too', () => {
    const lib = build(`${ADD('raw', H1, ' licence=CC-BY-NC-4.0')}\n${ADD('cut', H2, ` licence=own source=derived parents=${H1} ops="trim 0 1"`)}\n${ADD('cut2', H3, ` licence=own source=derived parents=${H2}`)}\nsound new s voice=layered\nlayer add s sample sample=cut2`);
    const r = itemLicence(lib, 'sound', 's');
    expect(r.state).toBe('blocked');
    expect(r.samples.map((x) => [x.name, x.via, x.state])).toEqual([['cut', 'parent', 'shippable'], ['cut2', 'used', 'shippable'], ['raw', 'parent', 'blocked']]);
    expect(reachedSamples(lib, ['cut']).map((x) => x.name)).toEqual(['cut', 'raw']);
  });
  it('make an ATTRIBUTION text only for the licences that ask for it', () => {
    const lib = build(LIB);
    expect(attributionText(reachedSamples(lib, ['own_hit', 'cc0_air']))).toBeNull();
    const t = attributionText(reachedSamples(lib, ['own_hit', 'by_bell']))!;
    expect(t).toContain('by_bell (CC-BY-4.0, cccccccccccc)');
    expect(t).toContain('Bell by Ana');
    expect(t).not.toContain('own_hit');
  });
});

// ---- the stereo sample layer -----------------------------------------------------------------------------------------------

function bankOf(files: Record<string, SampleData>): SampleBank {
  return { get: (n) => files[n], hash: (n) => (files[n] ? `h-${n}` : undefined) };
}
function noise(n: number, seed: number): Float32Array {
  const x = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; x[i] = ((s / 4294967296) * 2 - 1) * 0.5; }
  return x;
}

describe('side=stereo', () => {
  const left = noise(6000, 1);
  const right = noise(6000, 2);
  const mix = Float32Array.from(left, (v, i) => (v + right[i]!) / 2);
  const bank = bankOf({ wide: { rate: 44100, data: mix, left, right }, narrow: { rate: 44100, data: left } });
  const sound = (script: string) => build(`sound new s voice=layered seed=1\n${script}`).get('s') as never;

  it('plays both channels of a file, the left to the left and the right to the right, in a stereo sound', () => {
    const [l, r] = renderChannels(sound('layer add s sample sample=wide side=stereo'), bank);
    expect(r).toBeDefined();
    expect(Array.from(l!)).toEqual(Array.from(left));
    expect(Array.from(r!)).toEqual(Array.from(right));
  });
  it('matches the two-layer form it replaces, sample for sample within float rounding', () => {
    const one = renderChannels(sound('layer add s sample sample=wide side=stereo'), bank);
    const two = renderChannels(sound('layer add s sample sample=wide side=left pan=-1\nlayer add s sample sample=wide side=right pan=1'), bank);
    expect(two).toHaveLength(2);
    for (let c = 0; c < 2; c++) {
      expect(one[c]!.length).toBe(two[c]!.length);
      let worst = 0;
      for (let i = 0; i < one[c]!.length; i++) worst = Math.max(worst, Math.abs(one[c]![i]! - two[c]![i]!));
      expect(worst).toBeLessThan(1e-6);
    }
  });
  it('runs each channel through the layer: gain, envelope, effects and offset apply to both', () => {
    const base = renderChannels(sound('layer add s sample sample=wide side=stereo'), bank);
    const loud = renderChannels(sound('layer add s sample sample=wide side=stereo gain=0.5'), bank);
    for (let c = 0; c < 2; c++) for (let i = 0; i < 100; i++) expect(loud[c]![i]!).toBeCloseTo(base[c]![i]! * 0.5, 6);
    const late = renderChannels(sound('layer add s sample sample=wide side=stereo offset=0.1'), bank);
    expect(late[0]!.length).toBe(base[0]!.length + 4410);
    expect(late[1]![4410 + 50]).toBeCloseTo(base[1]![50]!, 6);
    const reverb = renderChannels(sound('layer add s sample sample=wide side=stereo\nfx add s layer=1 reverb mix=0.3'), bank);
    expect(reverb).toHaveLength(2);
    expect(reverb[0]!.length).toBeGreaterThan(base[0]!.length);
  });
  it('a mono file plays in both channels; the sound is stereo; a layer elsewhere in the mix keeps its pan', () => {
    const [l, r] = renderChannels(sound('layer add s sample sample=narrow side=stereo'), bank);
    expect(Array.from(l!)).toEqual(Array.from(left));
    expect(Array.from(r!)).toEqual(Array.from(left));
    const both = renderChannels(sound('layer add s sample sample=wide side=stereo\nlayer add s osc wave=sine freq=300 dur=0.05 pan=-1'), bank);
    expect(both).toHaveLength(2);
  });
  it('is a choice of the sample layer, and nothing changes for a sound that does not use it', () => {
    const doc = sound('layer add s sample sample=wide');
    expect(renderChannels(doc, bank)).toHaveLength(1);
    expect(() => sound('layer add s sample sample=wide side=wide')).toThrow(/mix, left, right, stereo/);
  });
});
