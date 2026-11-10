// Licences at the door: `licence check`, and manifest exports (--all, --set, --pack) that refuse what reaches an unknown or blocked
// licence unless it is let through, list the samples they use, and write ATTRIBUTION.txt when a licence asks for it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportFormat, importPath, licenceCheck, licenceReportText, licencePolicyNote, loadProject, Writer } from '../src/index.ts';
import { makeAudio, wavBytes } from '../../core/test/audio-fixtures.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
const claude = 'agent:claude';
beforeEach(() => {
  f = fixture();
  const put = (name: string, seed: number, o: Record<string, string>) => {
    const p = join(f.root, `${name}.wav`);
    writeFileSync(p, wavBytes(makeAudio('pcm16', 1, 1500, 44100, seed)));
    importPath(f.w, p, { by: claude, ...o });
  };
  put('own_hit', 1, { licence: 'own' });
  put('air', 2, { licence: 'CC0-1.0' });
  put('bell', 3, { licence: 'CC-BY-4.0', attribution: 'Bell by Ana, CC BY 4.0', terms: 'https://creativecommons.org/licenses/by/4.0/' });
  put('mystery', 4, {});
  put('pirated', 5, { licence: 'CC-BY-NC-4.0' });
  const r = f.w.run({ by: claude, commands: [
    'sound new clean voice=layered; layer add clean sample sample=own_hit; layer add clean sample sample=air',
    'sound new credit voice=layered; layer add credit sample sample=bell',
    'sound new murky voice=layered; layer add murky sample sample=mystery',
    'sound new noncomm voice=layered; layer add noncomm sample sample=pirated',
    'sound new plain voice=layered; layer add plain osc',
    'set new steps from=clean count=2',
  ].join('\n') });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
});
afterEach(() => f.clean());

const out = (name: string) => join(f.root, name);
const manifest = (dir: string) => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { allowedLicences?: string[]; samples: { name: string; hash: string; licence: string; attribution?: string; terms?: string; source: string; origin?: string }[]; sounds: { id: string; licences: string[]; licence: string }[] };

describe('licence check', () => {
  it('gives each item the worst state of the samples it reaches, and the samples behind it', () => {
    const items = licenceCheck(f.w, []);
    expect(items.map((i) => [i.id, i.state])).toEqual([['clean', 'shippable'], ['credit', 'attribution'], ['murky', 'unknown'], ['noncomm', 'blocked'], ['plain', 'shippable'], ['steps_1', 'shippable'], ['steps_2', 'shippable']]);
    const text = licenceReportText(items, licencePolicyNote(f.w));
    expect(text).toMatch(/^✓ shippable {3}sound clean {2}\(CC0-1\.0, own\)\n/);
    expect(text).toMatch(/\? unknown {5}sound murky {2}\(unknown\)\n {4}\? sample mystery [0-9a-f]{12} unknown: the licence is not known: set it with sample set <name> licence=<id>/);
    expect(text).toMatch(/✗ blocked {5}sound noncomm.*\n {4}✗ sample pirated .* CC-BY-NC-4\.0 is a non-commercial or no-derivatives licence: it ships only when the project's allow list names it/);
    expect(text).toMatch(/7 items: 4 shippable, 1 with attribution, 1 unknown, 1 blocked/);
    expect(text).toContain('Manifest exports (--all, --set, --pack) refuse these unless --allow-licence <id> is given.');
    expect(text).toContain('SoundClaw records licences; it gives no legal advice.');
  });
  it('takes names of sounds, sets, samples (and says what is not any)', () => {
    expect(licenceCheck(f.w, ['murky', 'bell']).map((i) => [i.kind, i.id, i.state])).toEqual([['sound', 'murky', 'unknown'], ['sample', 'bell', 'attribution']]);
    expect(licenceCheck(f.w, ['steps']).map((i) => i.id)).toEqual(['steps_1', 'steps_2']);
    expect(() => licenceCheck(f.w, ['nothing'])).toThrow(/'nothing' is not a sound, set, song, instrument or sample/);
  });
  it('follows the policy in project.json: a list it names replaces that default list', () => {
    f.w.samples.setPolicy({ allow: ['own', 'CC0-1.0', 'CC-BY-*', 'CC-BY-NC-*'], block: ['unknown'] });
    expect(licenceCheck(f.w, ['noncomm'])[0]!.state).toBe('attribution'); // CC-BY-NC-4.0 is no longer blocked, and CC-BY-* ships with attribution
    expect(licenceCheck(f.w, ['murky'])[0]!.state).toBe('unknown');
  });
  it('is read from project.json when the project opens', () => {
    const json = JSON.parse(readFileSync(join(f.dir, 'project.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(f.dir, 'project.json'), JSON.stringify({ ...json, licences: { block: ['unknown'] } }));
    const w = new Writer(loadProject(f.dir));
    // the block list now names only `unknown`; the allow list is the default, whose broad CC-BY-* never admits a non-commercial licence
    expect(licenceCheck(w, ['noncomm'])[0]!.state).toBe('blocked');
    expect(licenceCheck(w, ['noncomm'])[0]!.samples[0]!.reason).toMatch(/non-commercial or no-derivatives licence: it ships only when the project's allow list names it/);
    expect(licenceCheck(w, ['murky'])[0]!.state).toBe('unknown');
  });
});

describe('a song', () => {
  it('reaches the licences of the samples its instruments play, and exports with a warning when one is unknown', () => {
    const bell = f.w.sound('murky');
    expect(bell.voice).toBe('layered');
    const r = f.w.run({ by: claude, commands: 'instrument new tapper from=square_lead' });
    expect(r.ok).toBe(true);
    const inst = f.w.sampleLibrary().instruments.get('tapper')!;
    inst.voice = bell as never; // a project instrument that plays the unknown sample
    f.w.run({ by: claude, commands: 'song new tune tempo=120\nsong channel add tune lead inst=tapper\npattern tune.a steps=16 tpb=4 bar=8\n  lead: C5 . E5 . G5 - - . | A4 . . . G4 . E4 .\nsong section add tune A a x2' });
    expect(licenceCheck(f.w, ['tune'])[0]).toMatchObject({ kind: 'song', state: 'unknown' });
  });
});

describe('manifest exports', () => {
  it('refuse a sound that reaches an unknown or blocked licence, naming the sound, the sample and the way out, and write nothing', () => {
    const dir = out('all');
    expect(() => exportFormat(f.w, [], 'wav', { out: dir, all: true })).toThrow(/export refused: 2 sounds reach a licence the project does not ship:\n {2}murky \(unknown\)\n {4}sample mystery: the licence is not known[\s\S]*noncomm \(blocked\)[\s\S]*--allow-licence <id>/);
    expect(existsSync(dir)).toBe(false);
    expect(() => exportFormat(f.w, [], 'wav', { out: out('pack'), pack: true })).toThrow(/export refused/);
    expect(() => exportFormat(f.w, [], 'wav', { out: out('set'), set: 'steps' })).not.toThrow(); // the set's members are clean
  });
  it('let an id through with allowLicence, and write what was let through into the manifest', () => {
    const dir = out('allowed');
    exportFormat(f.w, [], 'wav', { out: dir, all: true, allowLicence: ['unknown', 'CC-BY-NC-4.0'] });
    const m = manifest(dir);
    expect(m.allowedLicences).toEqual(['unknown', 'CC-BY-NC-4.0']);
    expect(m.sounds.find((s) => s.id === 'murky')).toMatchObject({ licences: ['unknown'], licence: 'shippable' }); // let through for this export
  });
  it('list the samples used (name, hash, licence, attribution, source) and write ATTRIBUTION.txt when a licence asks for it', () => {
    const dir = out('clean');
    const r = exportFormat(f.w, ['clean', 'credit'], 'wav', { out: dir, all: false, set: undefined, pack: true });
    const m = manifest(dir);
    expect(m.samples.map((s) => [s.name, s.licence, s.source])).toEqual([['air', 'CC0-1.0', 'file'], ['bell', 'CC-BY-4.0', 'file'], ['own_hit', 'own', 'file']]);
    expect(m.samples.find((s) => s.name === 'bell')).toMatchObject({ attribution: 'Bell by Ana, CC BY 4.0', terms: 'https://creativecommons.org/licenses/by/4.0/', origin: 'bell.wav' });
    expect(m.samples.find((s) => s.name === 'bell')!.hash).toBe(f.w.samples.entry('bell')!.hash);
    expect(m.allowedLicences).toBeUndefined();
    expect(m.sounds.map((s) => [s.id, s.licence, s.licences])).toEqual([['clean', 'shippable', ['CC0-1.0', 'own']], ['credit', 'attribution', ['CC-BY-4.0']]]);
    const at = readFileSync(join(dir, 'ATTRIBUTION.txt'), 'utf8');
    expect(at).toContain('bell (CC-BY-4.0');
    expect(at).toContain('Bell by Ana, CC BY 4.0');
    expect(at).toContain('https://creativecommons.org/licenses/by/4.0/');
    expect(at).not.toContain('own_hit');
    expect(r.notes.join('\n')).toContain('ATTRIBUTION.txt written (1 samples ask for attribution)');
  });
  it('write no ATTRIBUTION.txt when none asks (and remove an old one), and a set export lists its own samples', () => {
    const dir = out('plain');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ATTRIBUTION.txt'), 'old');
    exportFormat(f.w, [], 'wav', { out: dir, set: 'steps' });
    expect(existsSync(join(dir, 'ATTRIBUTION.txt'))).toBe(false);
    expect(manifest(dir).samples.map((s) => s.name)).toEqual(['air', 'own_hit']);
  });
  it('a single-file export warns but is not refused', () => {
    const dir = out('single');
    const r = exportFormat(f.w, ['murky', 'noncomm'], 'wav', { out: dir });
    expect(r.files).toHaveLength(2);
    expect(r.manifest).toBeNull();
    expect(r.notes.join('\n')).toMatch(/murky: unknown licence \(mystery unknown\); a manifest export would refuse it/);
    expect(r.notes.join('\n')).toMatch(/noncomm: blocked licence \(pirated CC-BY-NC-4\.0\)/);
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false);
  });
  it('an OGG export keeps writing its manifest, and gates only the manifest exports named for it', () => {
    // ogg writes a manifest as before; the gate is for --all, --set and --pack (a single named sound exports with a warning)
    const r = exportFormat(f.w, ['murky'], 'ogg', { out: out('ogg') });
    expect(r.manifest).not.toBeNull();
    expect(r.notes.join('\n')).toMatch(/murky: unknown licence/);
  });
});
