// The sample store on a project: objects by content, names on the tape, provenance, the `.sample` files, gc, imports of every
// container, and the refusals. Audio is made by test code (core/test/audio-fixtures.ts); nothing here is third-party.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinChannels, samplesHash } from '@soundclaw/core';
import { importPath, gcApply, gcPlan, gcReport, sampleListText, sampleShowText, commitImports, prepareImport, SAMPLE_NAME_RE, type Writer } from '../src/index.ts';
import { acidChunk, aiffBytes, channelInts, cueChunk, flacBytes, infoChunk, makeAudio, smplChunk, wavBytes } from '../../core/test/audio-fixtures.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
const claude = 'agent:claude';
beforeEach(() => { f = fixture(); });
afterEach(() => f.clean());

const run = (commands: string, w: Writer = f.w) => { const r = w.run({ commands, by: claude }); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r; };
const fail = (commands: string) => { const r = f.w.run({ commands, by: claude }); if (r.ok) throw new Error('expected an error'); return r.errors.map((e) => e.message).join('; '); };
const file = (name: string, bytes: Uint8Array): string => { const p = join(f.root, name); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, bytes); return p; };
const imp = (path: string, o: Partial<Parameters<typeof importPath>[2]> = {}) => importPath(f.w, path, { by: claude, ...o });
const objects = (): string[] => f.w.samples.store.list().map((o) => o.hash);

describe('the object store', () => {
  it('keeps audio once, under samples/objects/<first two hex>/<hash>.wav, and never rewrites an object', () => {
    const r = imp(file('a.wav', wavBytes(makeAudio('pcm16', 2, 3000)))).items[0]!;
    const path = join(f.dir, 'samples', 'objects', r.info.sha256.slice(0, 2), `${r.info.sha256}.wav`);
    expect(existsSync(path)).toBe(true);
    const before = { mtime: statSync(path).mtimeMs, ino: statSync(path).ino, bytes: readFileSync(path) };
    // the same audio again, under another name, in another container: one object, untouched
    const again = imp(file('b.aiff', aiffBytes(makeAudio('pcm16', 2, 3000))), { as: 'second' }).items[0]!;
    expect(again.info.sha256).toBe(r.info.sha256);
    expect(again.notes.join(' ')).toMatch(/the same audio as 'a': kept once in the store, this name added/);
    expect(statSync(path).mtimeMs).toBe(before.mtime);
    expect(statSync(path).ino).toBe(before.ino);
    expect(Buffer.compare(readFileSync(path), before.bytes)).toBe(0);
    expect(objects()).toEqual([r.info.sha256]);
    // the store form is a plain WAV with a fmt and a data chunk, written whole (no temporary file is left)
    expect(readdirSync(join(f.dir, 'samples', 'objects', r.info.sha256.slice(0, 2)))).toEqual([`${r.info.sha256}.wav`]);
    expect(String.fromCharCode(...readFileSync(path).subarray(0, 4))).toBe('RIFF');
  });
  it('an object is its audio whatever chunks the file around it had', () => {
    const a = makeAudio('pcm24', 1, 2000, 48000);
    const plain = imp(file('plain.wav', wavBytes(a)), { as: 'plain' }).items[0]!;
    const noisy = imp(file('noisy.wav', wavBytes(a, { before: [infoChunk({ INAM: 'x' })], after: [smplChunk({ note: 60 }), cueChunk([5, 9])] })), { as: 'noisy' }).items[0]!;
    expect(noisy.info.sha256).toBe(plain.info.sha256);
    expect(objects()).toHaveLength(1);
  });
});

describe('names on the tape', () => {
  it('sample add is the first line of an import group: the hash, the facts about the audio, where it came from and when, by whom', () => {
    const wav = wavBytes(makeAudio('pcm16', 2, 1500));
    const r = imp(file('Door Creak.wav', wav), { licence: 'CC0-1.0', tags: 'Wood,door' });
    const e = f.w.tape().find((t) => t.group === r.group)!;
    expect(e.by).toBe(claude);
    expect(e.cmd).toBe(`sample add Door_Creak hash=${r.items[0]!.info.sha256} rate=44100 channels=2 frames=1500 format=pcm16 tags=door,wood source=file origin="Door Creak.wav" orig-hash=${createHashHex(wav)} orig-format="wav 16-bit" date=${e.at} author=agent:claude licence=CC0-1.0`);
    expect(f.w.samples.entry('Door_Creak')!.prov).toMatchObject({ source: 'file', origin: 'Door Creak.wav', author: claude, origFormat: 'wav 16-bit' });
    // the origin is a file name, never the folder it was in
    expect(e.cmd).not.toContain(f.root);
  });
  it('is also a .sample file in samples/, written from the tape and removed with the name', () => {
    imp(file('hit.wav', wavBytes(makeAudio('pcm16', 1, 800))));
    const p = join(f.dir, 'samples', 'hit.sample');
    expect(readFileSync(p, 'utf8')).toMatch(/^soundclaw sample 1\nname hit\nhash [0-9a-f]{64}\nrate 44100\nchannels 1\nframes 800\nformat pcm16\nsource file\norigin hit.wav\norig-hash [0-9a-f]{64}\norig-format "wav 16-bit"\ndate \S+\nauthor agent:claude\nlicence unknown\n$/);
    run('sample set hit root=A3 licence=own');
    expect(readFileSync(p, 'utf8')).toContain('root A3\n');
    run('sample rename hit knock');
    expect(existsSync(p)).toBe(false);
    expect(existsSync(join(f.dir, 'samples', 'knock.sample'))).toBe(true);
    run('sample remove knock');
    expect(existsSync(join(f.dir, 'samples', 'knock.sample'))).toBe(false);
    run('undo');
    expect(existsSync(join(f.dir, 'samples', 'knock.sample'))).toBe(true);
  });
  it('a batch that names a hash not in the store is refused, naming the hash, and writes nothing', () => {
    const tape = f.w.tape().length;
    const h = 'e'.repeat(64);
    expect(fail(`sample add ghost hash=${h} rate=44100 channels=1 frames=100 format=pcm16`)).toMatch(new RegExp(`hash ${h} is not in the sample store`));
    expect(f.w.tape().length).toBe(tape);
    expect(f.w.samples.list()).toEqual([]);
    const real = imp(file('r.wav', wavBytes(makeAudio('pcm16', 1, 500)))).items[0]!.info.sha256;
    expect(fail(`sample set r hash=${h} rate=44100 channels=1 frames=100 format=pcm16`)).toMatch(/is not in the sample store/);
    expect(real).toHaveLength(64);
  });
  it('pointing a name at other audio is a command: the render changes, and undo and redo bring the audio back', () => {
    const a = imp(file('a.wav', wavBytes(makeAudio('pcm16', 1, 4000, 44100, 1))), { as: 'a' }).items[0]!;
    const b = imp(file('b.wav', wavBytes(makeAudio('pcm16', 1, 6000, 44100, 2))), { as: 'b' }).items[0]!;
    run('sound new s voice=layered; layer add s sample sample=a');
    const hashA = samplesHash(joinChannels(f.w.render('s').channels));
    run(`sample set a hash=${b.info.sha256} rate=44100 channels=1 frames=6000 format=pcm16`);
    const hashB = samplesHash(joinChannels(f.w.render('s').channels));
    expect(hashB).not.toBe(hashA);
    run('undo');
    expect(samplesHash(joinChannels(f.w.render('s').channels))).toBe(hashA);
    run('redo');
    expect(samplesHash(joinChannels(f.w.render('s').channels))).toBe(hashB);
    expect(a.info.sha256).not.toBe(b.info.sha256);
    // and the project reopens the same
    expect(samplesHash(joinChannels(f.reopen().render('s').channels))).toBe(hashB);
  });
  it('a sound and its sample can be made in one batch (the layer finds the name the same batch adds)', () => {
    const r = prepareImport(wavBytes(makeAudio('pcm16', 1, 900)), 'x.wav', { as: 'x' });
    f.w.samples.store.put(r.audio, r.hash);
    run(`${r.command}\nsound new s voice=layered\nlayer add s sample sample=x`);
    expect(f.w.render('s').samples.length).toBeGreaterThan(800);
  });
  it('refuses to remove a sample a sound plays, and a rename updates the sound', () => {
    imp(file('x.wav', wavBytes(makeAudio('pcm16', 1, 900))));
    run('sound new s voice=layered; layer add s sample sample=x');
    expect(fail('sample remove x')).toMatch(/played by sound s/);
    run('sample rename x y');
    expect(JSON.stringify(f.w.sound('s'))).toContain('"sample":"y"');
    expect(f.w.render('s').samples.length).toBeGreaterThan(800);
  });
});

describe('importing', () => {
  it('reads WAV, AIFF and FLAC, keeps the channels, and reports what the file said about itself', () => {
    const mono = makeAudio('pcm16', 1, 4000, 22050, 3);
    const wav = file('bell.wav', wavBytes(mono, { before: [infoChunk({ INAM: 'Small bell', ICMT: 'made by test code' })], after: [smplChunk({ note: 72, fraction: Math.round(0.1 * 4294967296), loop: { start: 200, end: 3500 } }), cueChunk([1000, 2000]), acidChunk({ tempo: 90 })] }));
    const r = imp(wav);
    const e = f.w.samples.entry('bell')!;
    expect(e).toMatchObject({ root: 72, tune: 10, loop: [200, 3500], loopMode: 'sustain', slices: [1000, 2000], channels: 1, rate: 22050 });
    expect(e.note).toBe('title: Small bell; comment: made by test code; tempo 90 BPM');
    const text = r.items[0]!.notes.join('\n');
    expect(text).toContain('read root note C5 +10 cents');
    expect(text).toContain('read a forward loop, frames 200-3500');
    expect(text).toContain('read 2 cue points');
    const stereo = makeAudio('pcm24', 2, 3000, 48000, 4);
    const aiff = imp(file('wide.aiff', aiffBytes(stereo, { compression: 'sowt', inst: { note: 48, loop: { start: 100, end: 2000 } } })));
    expect(aiff.items[0]!.info).toMatchObject({ channels: 2, rate: 48000, format: 'pcm24' });
    expect(f.w.samples.entry('wide')).toMatchObject({ root: 48, loop: [100, 2000] });
    expect(f.w.samples.entry('wide')!.prov.origFormat).toBe('aiff AIFF-C 24-bit');
    const flac = imp(file('air.flac', flacBytes([channelInts(stereo, 0), channelInts(stereo, 1)], 24, 48000, { kind: 'lpc', stereo: 'mid-side' })));
    expect(flac.items[0]!.info.sha256).toBe(aiff.items[0]!.info.sha256); // the same audio in three containers is one hash
    expect(f.w.samples.entry('air')!.prov.origFormat).toBe('flac FLAC 24-bit');
    expect(objects()).toHaveLength(2);
  });
  it('plays a stereo file as it is: side=stereo gives a two-channel sound', () => {
    imp(file('wide.wav', wavBytes(makeAudio('pcm16', 2, 3000, 44100, 9))));
    run('sound new s voice=layered; layer add s sample sample=wide side=stereo');
    expect(f.w.render('s').channels).toHaveLength(2);
    const w2 = f.reopen();
    expect(samplesHash(joinChannels(w2.render('s').channels))).toBe(samplesHash(joinChannels(f.w.render('s').channels)));
  });
  it('takes a folder as one undo group, reports the files it cannot read, and ignores what is not audio', () => {
    file('kit/One Hit.wav', wavBytes(makeAudio('pcm16', 1, 800, 44100, 1)));
    file('kit/two.flac', flacBytes([channelInts(makeAudio('pcm16', 1, 800, 44100, 2), 0)], 16, 44100));
    file('kit/three.aif', aiffBytes(makeAudio('pcm8', 1, 800, 44100, 3)));
    file('kit/broken.wav', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    file('kit/readme.txt', new Uint8Array([65]));
    file('kit/Dup.wav', wavBytes(makeAudio('pcm16', 1, 800, 44100, 1)));
    const tape = f.w.tape().length;
    const r = imp(join(f.root, 'kit'));
    expect(r.items.map((x) => x.info.name).sort()).toEqual(['Dup', 'One_Hit', 'three', 'two']);
    expect(r.problems.join('\n')).toMatch(/broken.wav: not a WAV, AIFF or FLAC/);
    expect(new Set(f.w.tape().slice(tape).map((t) => t.group)).size).toBe(1);
    run('undo');
    expect(f.w.samples.list()).toEqual([]);
    expect(objects()).toHaveLength(3); // objects stay until gc: undo is a command, nothing is deleted
  });
  it('says what is wrong with a name or a file, and takes the same audio under the same name as a no-op', () => {
    const p = file('x.wav', wavBytes(makeAudio('pcm16', 1, 900)));
    expect(() => imp(p, { as: 'Bad Name' })).toThrow(/not a sample name/);
    expect(() => imp(join(f.root, 'nope.wav'))).toThrow(/no file/);
    expect(() => imp(file('empty.wav', new Uint8Array([]))).items).toThrow(/not a WAV/);
    expect(() => imp(file('notes.txt', new Uint8Array([65, 66, 67])))).toThrow(/not a WAV, AIFF or FLAC file \(\.txt is not one of/);
    imp(p, { as: 'x' });
    const tape = f.w.tape().length;
    const again = imp(p, { as: 'x' }).items[0]!;
    expect(again.created).toBe(false);
    expect(f.w.tape().length).toBe(tape);
    expect(() => imp(file('y.wav', wavBytes(makeAudio('pcm16', 1, 100))), { as: 'x' })).toThrow(/exists with other audio/);
    expect(() => imp(p, { as: 'X' })).toThrow(/clashes with the sample 'x'/);
    expect(SAMPLE_NAME_RE.test('door_01')).toBe(true);
  });
  it('refuses a rate or length outside the limits with the limit named, and an import past the store limits needs --force', () => {
    expect(() => imp(file('low.wav', wavBytes(makeAudio('pcm16', 1, 100, 4000))))).toThrow(/4000 Hz \(samples are 8000-192000 Hz\)/);
    expect(() => imp(file('many.wav', wavBytes(makeAudio('pcm16', 9, 100))))).toThrow(/9 channels/);
    const p = file('ok.wav', wavBytes(makeAudio('pcm16', 1, 2000)));
    const total = vi.spyOn(f.w.samples.store, 'totalBytes');
    total.mockReturnValue(2 * 1024 * 1024 * 1024);
    expect(() => imp(p)).toThrow(/past 1024 MB an import needs --force \(limits: a file is at most 600 s and 200 MB/);
    expect(imp(p, { force: true }).items).toHaveLength(1);
    total.mockReturnValue(300 * 1024 * 1024);
    const second = imp(file('ok2.wav', wavBytes(makeAudio('pcm16', 1, 2000, 44100, 99))));
    expect(second.warnings.join(' ')).toMatch(/the sample store is 300 MB \(a warning past 250 MB\)/);
    total.mockRestore();
  });
  it('lists and shows samples: licence state as a glyph and a word, provenance, who uses it', () => {
    imp(file('x.wav', wavBytes(makeAudio('pcm16', 2, 900))), { licence: 'CC-BY-4.0', attribution: 'Ana' });
    run('sound new s voice=layered; layer add s sample sample=x');
    expect(sampleListText(f.w)).toMatch(/^x: 0\.020 s, 44100 Hz, stereo, pcm16, ✓ attribution \(CC-BY-4\.0\), file, hash [0-9a-f]{12}\n$/);
    const show = sampleShowText(f.w, 'x');
    expect(show).toMatch(/audio: 0\.020 s, 44100 Hz, 2 channels, pcm16, 900 frames/);
    expect(show).toMatch(/provenance: source file, origin x\.wav, was wav 16-bit, on \S+, by agent:claude/);
    expect(show).toContain('licence: CC-BY-4.0 (✓ attribution); attribution: Ana');
    expect(show).toContain('used by: sound s');
    expect(() => sampleShowText(f.w, 'nope')).toThrow(/no sample 'nope' \(samples: x\)/);
  });
});

describe('ffmpeg', () => {
  const has = !spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error;
  it.skipIf(!has)('reads MP3, OGG and M4A through ffmpeg, stores 16-bit PCM, and keeps the original file\'s hash', () => {
    const src = file('tone.wav', wavBytes(makeAudio('pcm16', 2, 22050, 44100, 5)));
    let tried = 0;
    for (const [ext, args] of [['mp3', ['-c:a', 'libmp3lame']], ['ogg', ['-c:a', 'libvorbis']], ['m4a', ['-c:a', 'aac']]] as const) {
      const out = join(f.root, `tone.${ext}`);
      const enc = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', src, ...args, out]);
      if (enc.status !== 0) continue; // this ffmpeg has no such encoder
      tried++;
      const r = imp(out, { as: `t_${ext}` }).items[0]!;
      expect(r.info).toMatchObject({ channels: 2, rate: 44100, format: 'pcm16' });
      expect(r.notes.join(' ')).toMatch(/decoded by ffmpeg to 16-bit PCM/);
      expect(f.w.samples.entry(`t_${ext}`)!.prov.origHash).toBe(createHashHex(readFileSync(out)));
      expect(f.w.samples.entry(`t_${ext}`)!.prov.origFormat).toBe(ext);
    }
    expect(tried).toBeGreaterThan(0);
  });
  it('says to install ffmpeg or convert the file when it is not there', () => {
    const p = file('song.mp3', new Uint8Array([0xff, 0xfb, 0x90, 0, 0, 0, 0, 0]));
    const path = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(() => imp(p)).toThrow(/reading \.mp3 files needs ffmpeg, which is not installed; install it, or convert the file to WAV first/);
    } finally {
      process.env.PATH = path;
    }
  });
});

describe('gc', () => {
  it('lists the objects nothing on the tape names, and deletes them only with --apply', () => {
    imp(file('a.wav', wavBytes(makeAudio('pcm16', 1, 600, 44100, 1))));
    expect(gcReport(gcPlan(f.w, false), false)).toMatch(/nothing to remove/);
    // an object put in the store and never named
    const orphan = prepareImport(wavBytes(makeAudio('pcm16', 1, 700, 44100, 2)), 'o.wav', {});
    f.w.samples.store.put(orphan.audio, orphan.hash);
    const plan = gcPlan(f.w, false);
    expect(plan.objects.map((o) => o.hash)).toEqual([orphan.hash]);
    expect(gcReport(plan, false)).toMatch(/would remove 1 object .*that nothing on the tape names[\s\S]*a dry run: add --apply/);
    expect(objects()).toContain(orphan.hash);
    gcApply(f.w, plan);
    expect(objects()).not.toContain(orphan.hash);
    expect(f.w.samples.list().map((s) => s.name)).toEqual(['a']);
  });
  it('keeps what an undone group named (it can be redone); --drop-history drops it, after listing the versions that stop rendering', () => {
    imp(file('a.wav', wavBytes(makeAudio('pcm16', 1, 600, 44100, 1))));
    const b = imp(file('b.wav', wavBytes(makeAudio('pcm16', 1, 650, 44100, 2)))).items[0]!;
    run('undo');
    expect(gcPlan(f.w, false).objects).toEqual([]);
    const plan = gcPlan(f.w, true);
    expect(plan.objects.map((o) => o.hash)).toEqual([b.info.sha256]);
    expect(plan.versions).toHaveLength(1);
    expect(plan.versions[0]!.cmd).toMatch(/^sample add b hash=/);
    expect(gcReport(plan, false)).toMatch(/These versions will no longer render with their audio[\s\S]*#\d+ g\d+ agent:claude: sample add b/);
    gcApply(f.w, plan);
    expect(objects()).not.toContain(b.info.sha256);
    expect(f.w.samples.list().map((s) => s.name)).toEqual(['a']);
  });
  it('--drop-history also drops the old audio of a name that was pointed elsewhere, but keeps the parents of what remains', () => {
    const a = imp(file('a.wav', wavBytes(makeAudio('pcm16', 1, 600, 44100, 1))), { as: 'a' }).items[0]!;
    const b = imp(file('b.wav', wavBytes(makeAudio('pcm16', 1, 650, 44100, 2))), { as: 'b' }).items[0]!;
    run(`sample set a hash=${b.info.sha256} rate=44100 channels=1 frames=650 format=pcm16`);
    const c = prepareImport(wavBytes(makeAudio('pcm16', 1, 300, 44100, 3)), 'c.wav', { as: 'c' });
    f.w.samples.store.put(c.audio, c.hash);
    run(`sample add c hash=${c.hash} rate=44100 channels=1 frames=300 format=pcm16 source=derived parents=${a.info.sha256}`);
    // a's old audio is still named by `c` as its parent, so it stays
    expect(gcPlan(f.w, true).objects).toEqual([]);
    run('sample remove c');
    expect(gcPlan(f.w, true).objects.map((o) => o.hash).sort()).toEqual([a.info.sha256, c.hash].sort());
  });
});

describe('gc --removed: the audio of removed samples', () => {
  it('sample remove says the audio stays; plain gc keeps it and says why; --removed frees it and keeps what names still in the project use', () => {
    const a = imp(file('a.wav', wavBytes(makeAudio('pcm16', 1, 600, 44100, 1))), { as: 'a' }).items[0]!;
    const b = imp(file('b.wav', wavBytes(makeAudio('pcm16', 1, 650, 44100, 2))), { as: 'b' }).items[0]!;
    const c = imp(file('c.wav', wavBytes(makeAudio('pcm16', 1, 700, 44100, 3))), { as: 'c' }).items[0]!;
    // b's audio is pointed elsewhere: a name that is still there keeps its earlier audio
    run(`sample set a hash=${b.info.sha256} rate=44100 channels=1 frames=650 format=pcm16`);
    const r = f.w.run({ commands: 'sample remove c', by: 'agent:claude' });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.warnings.join('\n')).toMatch(/c is gone from the project, but its audio stays in the store.*sample gc --removed --apply/);
    // plain gc: nothing, and it says what only removed samples still hold
    const plain = gcPlan(f.w, false);
    expect(plain.objects).toEqual([]);
    expect(plain.keptForRemoved).toBe(1);
    expect(gcReport(plain, false)).toMatch(/nothing to remove: every object is named on the tape\n1 of them only by samples that were removed.*--removed frees those/);
    // --removed: c's audio goes; a's earlier audio (a name still there) and b's stay
    const gone = gcPlan(f.w, false, true);
    expect(gone.objects.map((o) => o.hash)).toEqual([c.info.sha256]);
    expect(gone.removed).toBe(true);
    expect(gone.versions.map((v) => v.cmd.split(' ')[2])).toEqual(['c']);
    expect(gcReport(gone, false)).toMatch(/would remove 1 object .*that only samples removed from the project used[\s\S]*These versions will no longer render/);
    gcApply(f.w, gone);
    expect(objects()).not.toContain(c.info.sha256);
    expect(objects()).toContain(a.info.sha256);
    expect(objects()).toContain(b.info.sha256);
    expect(gcReport(gcPlan(f.w, false, true), false)).toMatch(/nothing to remove: every object is used by a name that is still in the project/);
    // and the project still opens, lists and renders what is left
    expect(f.w.samples.list().map((x) => x.name).sort()).toEqual(['a', 'b']);
    expect(f.reopen().samples.list().map((x) => x.name).sort()).toEqual(['a', 'b']);
  });
  it('an undone removal keeps the name, so --removed leaves its audio alone', () => {
    const c = imp(file('c.wav', wavBytes(makeAudio('pcm16', 1, 700, 44100, 3))), { as: 'c' }).items[0]!;
    run('sample remove c');
    run('undo');
    expect(gcPlan(f.w, false, true).objects).toEqual([]);
    expect(objects()).toContain(c.info.sha256);
  });
});

describe('commitImports', () => {
  it('does not put objects in the store for a file whose name is taken (only a clean import changes anything)', () => {
    imp(file('x.wav', wavBytes(makeAudio('pcm16', 1, 900, 44100, 1))), { as: 'x' });
    const other = prepareImport(wavBytes(makeAudio('pcm16', 1, 910, 44100, 2)), 'x2.wav', { as: 'x' });
    const r = commitImports(f.w, [other], { by: claude });
    expect(r.problems[0]).toMatch(/exists with other audio/);
    expect(r.items).toEqual([]);
    expect(objects()).toHaveLength(1);
  });
});

const createHashHex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
