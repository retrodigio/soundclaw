// Sample libraries on the server: registering a folder and what it declares, the index (worker threads, incremental), search, the
// sounds-like ranking, tags, copying a file into a project with its provenance, and the audition route. Audio is made by test code.

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MANIFEST_FILE, decodeAudio, decodeMeasure, pcmFromFloats, pcmHash, pcmToWav } from '@soundclaw/core';
import { STREAM_OVER, chunkPlan, readWavHead, totalOf } from '../../ui/src/samples/stream.ts';
import {
  addLibrary, confinedFile, defaultWorkers, moveLegacyCache, platformCacheDir, legacyCacheDir, getLibrary, hitJson, indexLibrary, listLibraries, loadIndex, readRegistry, removeLibrary, scanLibrary, searchLibraries, similarLibraries, stateUnder, tagFile,
  useLibraryFile, libraryAudioFile, licenceCheck, importPath,
} from '../src/index.ts';
import { byteRange, startWatchServer } from '../src/http.ts';
import { fixture, type Fixture } from './helpers.ts';
import { makeBigLibrary, makeSmallLibrary, put, wavOf } from './library-fixtures.ts';

let f: Fixture;
let lib: string;
let outside: string;
const saved = { cfg: process.env.SOUNDCLAW_CONFIG_DIR, cache: process.env.SOUNDCLAW_CACHE_DIR };
beforeEach(() => {
  f = fixture();
  process.env.SOUNDCLAW_CONFIG_DIR = join(f.root, 'config');
  process.env.SOUNDCLAW_CACHE_DIR = join(f.root, 'cache');
  lib = join(f.root, 'cellar-foley');
  outside = join(f.root, 'outside');
  mkdirSync(lib, { recursive: true });
  mkdirSync(outside, { recursive: true });
});
afterEach(async () => {
  await f.w.thumbs.close();
  f.clean();
  if (saved.cfg === undefined) delete process.env.SOUNDCLAW_CONFIG_DIR; else process.env.SOUNDCLAW_CONFIG_DIR = saved.cfg;
  if (saved.cache === undefined) delete process.env.SOUNDCLAW_CACHE_DIR; else process.env.SOUNDCLAW_CACHE_DIR = saved.cache;
});

const claude = 'agent:claude';

describe('registering a library', () => {
  it('records the folder by its real path, with an id from its name, and lists it', () => {
    makeSmallLibrary(lib, outside);
    const r = addLibrary(lib, { licence: 'CC0-1.0' });
    expect(r.entry).toMatchObject({ id: 'cellar-foley', licence: 'CC0-1.0', declared: 'flags' });
    expect(readRegistry().map((l) => l.id)).toEqual(['cellar-foley']);
    expect(listLibraries()[0]).toMatchObject({ id: 'cellar-foley', indexed: false, files: 0 });
    expect(() => addLibrary(lib)).toThrow(/already the library 'cellar-foley'/);
    const other = join(f.root, 'other');
    mkdirSync(other);
    expect(() => addLibrary(other, { name: 'cellar-foley' })).toThrow(/there is a library 'cellar-foley' already/);
    expect(() => addLibrary(other, { name: 'Bad Name' })).toThrow(/not a library id/);
    expect(() => addLibrary(other, { licence: 'not a licence' })).toThrow(/not a licence id/);
    expect(() => addLibrary(join(f.root, 'nothing'))).toThrow(/not a folder/);
  });
  it('takes the declaration of soundclaw-library.json: name, licence, attribution and terms', () => {
    put(lib, MANIFEST_FILE, JSON.stringify({ name: 'Cellar Foley', description: 'doors and bells', licence: 'CC-BY-4.0', attribution: 'Made by the test', terms: 'https://example.org/terms' }));
    const r = addLibrary(lib);
    expect(r.entry).toMatchObject({ id: 'cellar-foley', name: 'Cellar Foley', licence: 'CC-BY-4.0', attribution: 'Made by the test', terms: 'https://example.org/terms', declared: 'manifest' });
    expect(r.notes.join(' ')).toMatch(/licence CC-BY-4.0, declared in soundclaw-library.json/);
  });
  it('flags win over the manifest, and a broken manifest stops the add', () => {
    put(lib, MANIFEST_FILE, JSON.stringify({ licence: 'CC0-1.0' }));
    const r = addLibrary(lib, { licence: 'own', name: 'mine' });
    expect(r.entry).toMatchObject({ id: 'mine', licence: 'own', declared: 'flags' });
    expect(r.notes.join(' ')).toMatch(/the folder declares CC0-1.0.*you gave own, which is used/);
    const bad = join(f.root, 'bad');
    put(bad, MANIFEST_FILE, '{"licence": 4}');
    expect(() => addLibrary(bad)).toThrow(/'licence' must be a non-empty string/);
  });
  it('shows a licence it read from a LICENSE text and needs --yes (or licence=) to take it; vague text leaves it unknown', () => {
    put(lib, 'LICENSE.txt', 'These recordings are released under CC0 1.0 Universal.\n');
    expect(() => addLibrary(lib)).toThrow(/reads as CC0-1.0; that is a reading of its text, not a declaration.*--yes/s);
    expect(readRegistry()).toEqual([]);
    expect(addLibrary(lib, { yes: true }).entry).toMatchObject({ licence: 'CC0-1.0', declared: 'licence-file' });
    const vague = join(f.root, 'vague');
    put(vague, 'LICENSE', 'Free to use, mostly.\n');
    const r = addLibrary(vague);
    expect(r.entry.licence).toBeUndefined();
    expect(r.entry.declared).toBe('none');
    expect(r.notes.join(' ')).toMatch(/LICENSE is there but does not name a licence outright/);
    expect(r.notes.join(' ')).toMatch(/no licence declared/);
  });
  it('removes a library from the list and leaves its folder alone', () => {
    makeSmallLibrary(lib, outside);
    addLibrary(lib, { licence: 'CC0-1.0' });
    expect(() => getLibrary('nope')).toThrow(/no library 'nope' \(libraries: cellar-foley\)/);
    expect(removeLibrary('cellar-foley')).toBe(0);
    expect(readRegistry()).toEqual([]);
    expect(existsSync(join(lib, 'doors', 'creak_01.wav'))).toBe(true);
  });
  it('needs --yes to remove a library whose files carry tags added by hand, and says how many it drops', async () => {
    makeSmallLibrary(lib, outside);
    addLibrary(lib, { licence: 'CC0-1.0' });
    await indexLibrary('cellar-foley', { workers: 0 });
    tagFile('cellar-foley', 'doors/creak_01.wav', ['hinge']);
    tagFile('cellar-foley', 'bells/BellHigh.wav', ['chime']);
    expect(() => removeLibrary('cellar-foley')).toThrow(/tags added by hand on 2 files.*--yes/);
    expect(readRegistry().map((l) => l.id)).toEqual(['cellar-foley']);
    expect(removeLibrary('cellar-foley', { yes: true })).toBe(2);
    expect(readRegistry()).toEqual([]);
    expect(existsSync(join(process.env.SOUNDCLAW_CONFIG_DIR!, 'library-tags', 'cellar-foley.json'))).toBe(false);
  });
});

describe('where the index lives', () => {
  it('is the platform’s cache folder: Library/Caches on macOS, LOCALAPPDATA on Windows, XDG_CACHE_HOME or ~/.cache elsewhere', () => {
    expect(platformCacheDir('darwin', {}, '/Users/someone')).toBe(join('/Users/someone', 'Library', 'Caches', 'soundclaw'));
    expect(platformCacheDir('linux', {}, '/home/someone')).toBe(join('/home/someone', '.cache', 'soundclaw'));
    expect(platformCacheDir('linux', { XDG_CACHE_HOME: '/var/cache/me' }, '/home/someone')).toBe(join('/var/cache/me', 'soundclaw'));
    expect(platformCacheDir('win32', { LOCALAPPDATA: 'C:/Users/someone/AppData/Local' }, 'C:/Users/someone')).toBe(join('C:/Users/someone/AppData/Local', 'soundclaw', 'cache'));
    expect(platformCacheDir('win32', {}, 'C:/Users/someone')).toBe(join('C:/Users/someone', 'AppData', 'Local', 'soundclaw', 'cache'));
  });
  it('moves a cache an earlier version kept in ~/.soundclaw/cache, once, and never over one that is there', () => {
    const home = join(f.root, 'home');
    const to = platformCacheDir('darwin', {}, home);
    put(join(legacyCacheDir(home), 'library'), 'cellar.index.jsonl', '{"soundclawLibraryIndex":1}\n');
    expect(moveLegacyCache(home, to)).toBe(true);
    expect(readFileSync(join(to, 'library', 'cellar.index.jsonl'), 'utf8')).toMatch(/soundclawLibraryIndex/);
    expect(existsSync(legacyCacheDir(home))).toBe(false);
    // nothing to move the second time; and an old folder next to a new one is left alone
    expect(moveLegacyCache(home, to)).toBe(false);
    put(join(legacyCacheDir(home), 'library'), 'other.index.jsonl', 'x');
    expect(moveLegacyCache(home, to)).toBe(false);
    expect(existsSync(join(to, 'library', 'other.index.jsonl'))).toBe(false);
  });
});

describe('the index', () => {
  it('lists the audio files below the folder, skipping hidden files, links and other files', () => {
    makeSmallLibrary(lib, outside);
    expect(scanLibrary(lib).map((j) => j.path)).toEqual([
      'bells/BellHigh.wav', 'broken/bad.wav', 'broken/voice.mp3', 'clicks/ticks.wav', 'doors/Slam_01.wav', 'doors/creak_01.wav', 'doors/creak_02.wav', 'tones/c4_sustain.wav', 'weather/Thunder Rumble.wav', 'weather/rain_loop.wav',
    ]);
  });
  it('measures every file once: its hash, numbers, tags and what its chunks say; unreadable files are listed with the reason', async () => {
    makeSmallLibrary(lib, outside);
    addLibrary(lib, { licence: 'CC0-1.0' });
    const st = await indexLibrary('cellar-foley', { workers: 0 });
    expect(st).toMatchObject({ files: 10, measured: 10, reused: 0, removed: 0, errors: 2 });
    const idx = loadIndex('cellar-foley')!;
    const by = new Map(idx.files.map((x) => [x.path, x]));
    const creak = by.get('doors/creak_01.wav')!;
    expect(creak.hash).toBe(pcmHash(decodeAudio(new Uint8Array(readFileSync(join(lib, 'doors', 'creak_01.wav')))).audio));
    expect(creak).toMatchObject({ rate: 22050, channels: 1, bits: 16, tags: ['door', 'creak'], format: 'wav 16-bit' });
    const m = decodeMeasure(creak.measure);
    expect(m.duration).toBeCloseTo(1.2, 3);
    expect(m.pitched).toBe(false);
    expect(creak.bands).toHaveLength(8);
    const tone = by.get('tones/c4_sustain.wav')!;
    expect(tone.meta).toMatchObject({ root: 60, loop: [2000, 20000] });
    expect(decodeMeasure(tone.measure).pitched).toBe(true);
    expect(by.get('weather/Thunder Rumble.wav')!.tags).toEqual(['weather', 'thunder', 'rumble']);
    expect(by.get('broken/bad.wav')!.error).toMatch(/not a WAV|bad\.wav/);
    expect(by.get('broken/voice.mp3')!.error).toBeTruthy();
    expect(by.get('broken/bad.wav')!.measure).toBeUndefined();
    // nothing absolute from this machine is in the index
    expect(readFileSync(join(f.root, 'cache', 'library', 'cellar-foley.index.jsonl'), 'utf8')).not.toContain(f.root);
  });
  it('gives the same index from worker threads as from this thread', async () => {
    makeSmallLibrary(lib, outside);
    addLibrary(lib, { licence: 'CC0-1.0' });
    await indexLibrary('cellar-foley', { workers: 0 });
    const inline = JSON.stringify(loadIndex('cellar-foley')!.files);
    await indexLibrary('cellar-foley', { workers: 3, rebuild: true });
    expect(JSON.stringify(loadIndex('cellar-foley')!.files)).toBe(inline);
  });
  it('updates incrementally: only files whose size or time changed are read, new ones are added, gone ones dropped', async () => {
    makeSmallLibrary(lib, outside);
    addLibrary(lib, { licence: 'CC0-1.0' });
    await indexLibrary('cellar-foley', { workers: 0 });
    const again = await indexLibrary('cellar-foley', { workers: 0 });
    expect(again).toMatchObject({ measured: 0, reused: 10, removed: 0 });
    put(lib, 'bells/BellLow.wav', wavOf('bell', 11, 1));
    put(lib, 'doors/creak_01.wav', wavOf('creak', 12, 1.6)); // changed
    rmSync(join(lib, 'clicks', 'ticks.wav'));
    const st = await indexLibrary('cellar-foley', { workers: 2 });
    expect(st).toMatchObject({ measured: 2, files: 10, removed: 1 });
    const idx = loadIndex('cellar-foley')!;
    expect(idx.files.map((x) => x.path)).toContain('bells/BellLow.wav');
    expect(decodeMeasure(idx.files.find((x) => x.path === 'doors/creak_01.wav')!.measure).duration).toBeCloseTo(1.6, 3);
    // a time stamp alone is enough to read a file again
    utimesSync(join(lib, 'doors', 'creak_02.wav'), new Date(), new Date(Date.now() + 5000));
    expect((await indexLibrary('cellar-foley', { workers: 0 })).measured).toBe(1);
    expect((await indexLibrary('cellar-foley', { workers: 0, rebuild: true })).measured).toBe(10);
  });
  it('refuses a library whose folder is gone, naming the folder', async () => {
    addLibrary(lib, { licence: 'own' });
    rmSync(lib, { recursive: true });
    await expect(indexLibrary('cellar-foley')).rejects.toThrow(/the folder of library cellar-foley is gone/);
  });
  it('indexes 1,000 generated one-shots in under 30 s', async () => {
    makeBigLibrary(lib, 1000);
    addLibrary(lib, { licence: 'CC0-1.0' });
    const workers = defaultWorkers();
    const cpu0 = process.cpuUsage();
    const t0 = Date.now();
    const st = await indexLibrary('cellar-foley');
    const wall = (Date.now() - t0) / 1000;
    const cpu = process.cpuUsage(cpu0);
    const cpuPerWorker = (cpu.user + cpu.system) / 1e6 / workers;
    expect(st).toMatchObject({ files: 1000, measured: 1000, errors: 0 });
    // The target is wall time on a machine with free cores. A busy machine stretches the wall time and nothing else, so there it is
    // judged by the work done: the CPU seconds each worker spent (this process's, workers included) must also fit in 30 s.
    expect(cpuPerWorker, `cpu per worker ${cpuPerWorker.toFixed(1)} s (wall ${wall.toFixed(1)} s on ${workers} workers)`).toBeLessThan(30);
    if (loadavg()[0]! < cpus().length / 2) expect(wall, `wall ${wall.toFixed(1)} s`).toBeLessThan(30);
    // searching them is quick too
    const t1 = Date.now();
    const r = searchLibraries('creak dur=0.5-1', { limit: 5 });
    expect(Date.now() - t1).toBeLessThan(2000);
    expect(r.total).toBeGreaterThan(0);
    // and a second pass reads nothing
    expect((await indexLibrary('cellar-foley')).measured).toBe(0);
  }, 240_000);
});

describe('search', () => {
  beforeEach(async () => {
    makeSmallLibrary(lib, outside);
    addLibrary(lib, { licence: 'CC0-1.0' });
    await indexLibrary('cellar-foley', { workers: 0 });
  });
  it('finds files by words and by the numbers, best first, with the numbers on each hit', () => {
    const r = searchLibraries('creak dur=0.8-3 pitched=no');
    // both fit 0.8-3 s; 2.4 s is nearer the middle (1.9 s) than 1.2 s
    expect(r.hits.map((h) => h.hit.file.path)).toEqual(['doors/creak_02.wav', 'doors/creak_01.wav']);
    const j = hitJson(r.hits[1]!);
    expect(j).toMatchObject({ ref: 'cellar-foley:doors/creak_01.wav', licence: 'CC0-1.0', state: 'shippable' });
    expect(j.dur).toBeCloseTo(1.2, 2);
    expect(Object.keys(j)).toEqual(expect.arrayContaining(['dur', 'lufs', 'note', 'centroid', 'attack', 'licence', 'desc']));
    expect(searchLibraries('bell').hits.map((h) => h.hit.file.path)).toEqual(['bells/BellHigh.wav']);
    expect(searchLibraries('door').total).toBe(3);
    expect(searchLibraries('rumble tag=weather').total).toBe(1);
    expect(searchLibraries('loop=yes').hits.map((h) => h.hit.file.path)).toEqual(['tones/c4_sustain.wav']);
    expect(searchLibraries('pitched=yes').hits.map((h) => h.hit.file.path)).toContain('tones/c4_sustain.wav');
    expect(searchLibraries('', { limit: 3 }).hits).toHaveLength(3);
    expect(searchLibraries('').total).toBe(8); // the two unreadable files are not hits
  });
  it('says what is wrong with a query, and which libraries are not indexed', () => {
    expect(() => searchLibraries('dur=fast')).toThrow(/library: dur=fast/);
    expect(() => searchLibraries('creak', { library: 'nope' })).toThrow(/no library 'nope'/);
    const other = join(f.root, 'other');
    mkdirSync(other);
    addLibrary(other, { licence: 'own' });
    const r = searchLibraries('creak');
    expect(r.notIndexed).toEqual(['other']);
    expect(r.total).toBe(2);
    expect(() => searchLibraries('creak', { library: 'other' })).toThrow(/library other has no index: soundclaw library index other/);
  });
  it('judges licence=shippable by the project policy it is given', () => {
    expect(searchLibraries('licence=shippable').total).toBe(8);
    expect(searchLibraries('licence=blocked', { policy: { allow: ['own'], block: [] } }).total).toBe(8);
    expect(hitJson(searchLibraries('bell').hits[0]!, stateUnder({ allow: ['own'], block: [] })).state).toBe('blocked');
  });
  it('searches with no libraries registered by saying how to add one', () => {
    removeLibrary('cellar-foley');
    expect(() => searchLibraries('creak')).toThrow(/no libraries registered \(soundclaw library add/);
  });
  it('keeps tags added by hand across an index rebuild, and finds files by them', async () => {
    expect(tagFile('cellar-foley', 'doors/creak_01.wav', ['Hinge', 'rusty'])).toEqual(['hinge', 'rusty']);
    expect(searchLibraries('hinge').hits.map((h) => h.hit.file.path)).toEqual(['doors/creak_01.wav']);
    expect(searchLibraries('tag=rusty').total).toBe(1);
    await indexLibrary('cellar-foley', { workers: 0, rebuild: true });
    expect(searchLibraries('rusty').total).toBe(1);
    expect(tagFile('cellar-foley', 'doors/creak_01.wav', ['rusty'], true)).toEqual(['hinge']);
    expect(searchLibraries('rusty').total).toBe(0);
    expect(() => tagFile('cellar-foley', 'doors/nothing.wav', ['x'])).toThrow(/no indexed file/);
    expect(() => tagFile('cellar-foley', 'doors/creak_01.wav', ['Bad/Tag'])).toThrow(/not a tag/);
  });
});

describe('sounds like', () => {
  beforeEach(async () => {
    makeSmallLibrary(lib, outside);
    addLibrary(lib, { licence: 'CC0-1.0' });
    await indexLibrary('cellar-foley', { workers: 0 });
  });
  it('ranks files nearest a sample of the project, a file and a sound, among those a query keeps', () => {
    const creak = join(f.root, 'my_creak.wav');
    writeFileSync(creak, wavOf('creak', 21, 1.4));
    importPath(f.w, creak, { by: claude });
    const r = similarLibraries(f.w, 'sample:my_creak', '');
    expect(r.reference).toBe('sample:my_creak');
    // the creaks come first, nearest first, and distances only grow
    expect(r.hits.slice(0, 2).map((h) => h.hit.file.path).sort()).toEqual(['doors/creak_01.wav', 'doors/creak_02.wav']);
    const d = r.hits.map((h) => h.distance!);
    expect([...d].sort((a, b) => a - b)).toEqual(d);
    expect(d[0]!).toBeGreaterThan(0);
    expect(r.total).toBe(8);
    // a bell file is nearest the bells, and the query narrows the field
    const bell = join(f.root, 'a_bell.wav');
    writeFileSync(bell, wavOf('bell', 22, 1.3));
    const rb = similarLibraries(f.w, bell, '', { limit: 3 });
    expect(rb.hits[0]!.hit.file.path).toBe('bells/BellHigh.wav');
    expect(rb.hits).toHaveLength(3);
    expect(rb.reference).toMatch(/a_bell/);
    const narrowed = similarLibraries(f.w, 'sample:my_creak', 'dur<1');
    expect(narrowed.hits.map((h) => h.hit.file.path).sort()).toEqual(['doors/Slam_01.wav']);
    // a synth sound of the project is a reference too
    f.w.run({ commands: 'sound new zap voice=classic preset=laser seed=1', by: claude });
    const rs = similarLibraries(f.w, 'zap', 'pitched=no');
    expect(rs.reference).toBe('zap');
    expect(rs.hits.length).toBeGreaterThan(3);
    expect(() => similarLibraries(f.w, 'no_such_thing', '')).toThrow(/no sound, song or audio file 'no_such_thing'/);
  });
  it('hits carry the distance in their JSON', () => {
    const creak = join(f.root, 'my_creak.wav');
    writeFileSync(creak, wavOf('creak', 21, 1.4));
    const r = similarLibraries(f.w, creak, '');
    expect(typeof hitJson(r.hits[0]!).distance).toBe('number');
  });
  it('finds files like an audio file with no project', () => {
    const bell = join(f.root, 'a_bell.wav');
    writeFileSync(bell, wavOf('bell', 22, 1.3));
    const r = similarLibraries(null, bell, '', { limit: 2 });
    expect(r.hits[0]!.hit.file.path).toBe('bells/BellHigh.wav');
    expect(() => similarLibraries(null, 'sample:my_creak', '')).toThrow(/no audio file sample:my_creak/);
  });
});

describe('copying a file into a project', () => {
  beforeEach(async () => {
    makeSmallLibrary(lib, outside);
    put(lib, MANIFEST_FILE, JSON.stringify({ licence: 'CC-BY-4.0', attribution: 'Sounds by the test suite', terms: 'https://example.org/t' }));
    addLibrary(lib);
    await indexLibrary('cellar-foley', { workers: 0 });
    tagFile('cellar-foley', 'doors/creak_01.wav', ['hinge']);
  });
  it('stores the audio under the library file’s hash, names it on the tape as source=library with the library’s licence and where it came from', () => {
    const r = useLibraryFile(f.w, 'cellar-foley:doors/creak_01.wav', { by: claude });
    const e = f.w.samples.entry('creak_01')!;
    const indexed = loadIndex('cellar-foley')!.files.find((x) => x.path === 'doors/creak_01.wav')!;
    expect(e.hash).toBe(indexed.hash);
    expect(e.prov).toMatchObject({ source: 'library', origin: 'cellar-foley:doors/creak_01.wav', origFormat: expect.stringContaining('wav') });
    expect(e.prov.origHash).toMatch(/^[0-9a-f]{64}$/);
    expect(e.licence).toEqual({ id: 'CC-BY-4.0', attribution: 'Sounds by the test suite', terms: 'https://example.org/t' });
    expect(e.tags).toEqual(['creak', 'door', 'hinge']);
    expect(r.items[0]!.created).toBe(true);
    // the tape line says it all and holds nothing absolute
    const line = f.w.tape().filter((t) => t.cmd.startsWith('sample add')).at(-1)!;
    expect(line.cmd).toContain('source=library');
    expect(line.cmd).toContain('origin=cellar-foley:doors/creak_01.wav');
    expect(line.cmd).not.toContain(f.root);
    expect(line.by).toBe(claude);
    // one undo group: undoing it removes the name (the object stays for gc)
    expect(f.w.run({ commands: 'undo', by: claude }).ok).toBe(true);
    expect(f.w.samples.entry('creak_01')).toBeUndefined();
  });
  it('takes as=, a licence of the caller’s, and says when a second name stands for audio already there', () => {
    useLibraryFile(f.w, 'cellar-foley:doors/creak_01.wav', { by: claude, as: 'door_creak', licence: 'own', attribution: '' });
    expect(f.w.samples.entry('door_creak')!.licence.id).toBe('own');
    const again = useLibraryFile(f.w, 'cellar-foley:doors/creak_01.wav', { by: claude, as: 'second' });
    expect(again.items[0]!.notes.join(' ')).toMatch(/the same audio as 'door_creak': kept once in the store, this name added/);
    expect(f.w.samples.store.list()).toHaveLength(1);
    expect(() => useLibraryFile(f.w, 'cellar-foley:doors/creak_02.wav', { by: claude, as: 'door_creak' })).toThrow(/sample 'door_creak' exists with other audio/);
  });
  it('a sound that plays it carries the library’s licence into the ship check', () => {
    useLibraryFile(f.w, 'cellar-foley:bells/BellHigh.wav', { by: claude });
    f.w.run({ commands: 'sound new ding voice=layered; layer add ding sample sample=BellHigh', by: claude });
    const rows = licenceCheck(f.w, ['ding'], []);
    expect(JSON.stringify(rows)).toContain('attribution');
    expect(JSON.stringify(rows)).toContain('CC-BY-4.0');
  });
  it('a library with no declared licence copies in as unknown', async () => {
    const other = join(f.root, 'plain');
    put(other, 'a/hit.wav', wavOf('slam', 3, 0.4));
    addLibrary(other);
    useLibraryFile(f.w, 'plain:a/hit.wav', { by: claude });
    expect(f.w.samples.entry('hit')!.licence).toEqual({ id: 'unknown' });
  });
  it('refuses what is not a reference, an unknown library, a missing file and a path that leaves the folder', () => {
    expect(() => useLibraryFile(f.w, 'doors/creak_01.wav', { by: claude })).toThrow(/is not <library>:<path>/);
    expect(() => useLibraryFile(f.w, 'nope:doors/creak_01.wav', { by: claude })).toThrow(/no library 'nope'/);
    expect(() => useLibraryFile(f.w, 'cellar-foley:doors/missing.wav', { by: claude })).toThrow(/has no file 'doors\/missing.wav'/);
    expect(() => useLibraryFile(f.w, 'cellar-foley:../outside/elsewhere/outside.wav', { by: claude })).toThrow(/not a path inside library/);
    expect(() => useLibraryFile(f.w, 'cellar-foley:broken/bad.wav', { by: claude })).toThrow(/bad\.wav/);
    expect(f.w.samples.all()).toEqual([]);
  });
});

describe('what a path may name', () => {
  beforeEach(() => {
    makeSmallLibrary(lib, outside);
    addLibrary(lib, { licence: 'CC0-1.0' });
    put(outside, 'secret.wav', wavOf('bell', 3, 0.3));
    put(outside, 'secret.txt', 'secret');
    symlinkSync(join(outside, 'secret.wav'), join(lib, 'doors', 'link.wav'));
  });
  it('stays inside the registered folder: no .., no absolute paths, no links out, only audio files', () => {
    const e = getLibrary('cellar-foley');
    expect(confinedFile(e, 'doors/creak_01.wav')).toBe(join(e.dir, 'doors', 'creak_01.wav'));
    for (const bad of ['../outside/secret.wav', 'doors/../../outside/secret.wav', join(outside, 'secret.wav'), '/etc/passwd', '\\windows', 'C:\\x.wav', 'doors/link.wav', 'linked/outside.wav', 'doors', '', 'doors/creak_01.wav\0.txt']) {
      expect(() => confinedFile(e, bad), JSON.stringify(bad)).toThrow();
    }
    put(lib, 'doors/readme.txt', 'x');
    expect(() => confinedFile(e, 'doors/readme.txt')).toThrow(/not an audio file/);
  });
});

describe('GET /api/library/<id>/audio', () => {
  it('plays a library file without copying it: a WAV of the decoded audio, behind the token, confined to the folder', async () => {
    makeSmallLibrary(lib, outside);
    addLibrary(lib, { licence: 'CC0-1.0' });
    put(outside, 'secret.wav', wavOf('bell', 3, 0.3));
    symlinkSync(join(outside, 'secret.wav'), join(lib, 'doors', 'link.wav'));
    const server = await startWatchServer({ writer: f.w, token: 'tok', port: 0 });
    try {
      const url = (path: string, q: Record<string, string> = {}, token = 'tok', id = 'cellar-foley'): string => `http://127.0.0.1:${server.port}/api/library/${id}/audio?${new URLSearchParams({ ...(token ? { token } : {}), path, ...q })}`;
      const r = await fetch(url('doors/creak_01.wav'));
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('audio/wav');
      expect(r.headers.get('etag')).toMatch(/^"cellar-foley-\d+-\d+"$/);
      const wav = decodeAudio(new Uint8Array(await r.arrayBuffer())).audio;
      expect(pcmHash(wav)).toBe(pcmHash(decodeAudio(new Uint8Array(readFileSync(join(lib, 'doors', 'creak_01.wav')))).audio));
      // a repeat with the etag costs nothing
      expect((await fetch(url('doors/creak_01.wav'), { headers: { 'If-None-Match': r.headers.get('etag')! } })).status).toBe(304);
      expect((await fetch(url('doors/creak_01.wav', {}, ''))).status).toBe(401);
      for (const bad of ['../outside/secret.wav', '%2e%2e/outside/secret.wav', '/etc/passwd', 'doors/link.wav', 'linked/outside.wav', 'doors', 'nothing.wav', '']) {
        expect((await fetch(url(bad))).status, bad).toBe(404);
      }
      expect((await fetch(url('doors/creak_01.wav', {}, 'tok', 'nolibrary'))).status).toBe(404);
      // the list of the project's samples is untouched: nothing was copied
      expect(f.w.samples.all()).toEqual([]);
      expect(existsSync(join(f.dir, 'samples', 'objects'))).toBe(false);
      expect(libraryAudioFile('cellar-foley', 'bells/BellHigh.wav').filename).toBe('BellHigh.wav');
    } finally {
      await server.close();
    }
  });
  it('streams a file over 2 MB the way the page plays it: the first range names the total, the planned ranges join to the whole file', async () => {
    makeSmallLibrary(lib, outside);
    put(lib, 'beds/long_bed.wav', pcmToWav(pcmFromFloats([Float32Array.from({ length: 44100 * 30 }, (_, i) => Math.sin(i / 30) * 0.25), Float32Array.from({ length: 44100 * 30 }, (_, i) => Math.sin(i / 17) * 0.25)], 44100, 'pcm16')));
    addLibrary(lib, { licence: 'CC0-1.0' });
    const server = await startWatchServer({ writer: f.w, token: 'tok', port: 0 });
    try {
      const url = `http://127.0.0.1:${server.port}/api/library/cellar-foley/audio?${new URLSearchParams({ token: 'tok', path: 'beds/long_bed.wav' })}`;
      const first = await fetch(url, { headers: { Range: `bytes=0-${STREAM_OVER - 1}` } });
      expect(first.status).toBe(206);
      const total = totalOf(first.headers.get('content-range'))!;
      expect(total).toBeGreaterThan(STREAM_OVER);
      const head = new Uint8Array(await first.arrayBuffer());
      expect(head.length).toBe(STREAM_OVER);
      const h = readWavHead(head)!;
      expect(h).toMatchObject({ channels: 2, rate: 44100, dataBytes: total - 44 });
      const parts = [head];
      for (const [a, b] of chunkPlan(head.length, total)) {
        const r = await fetch(url, { headers: { Range: `bytes=${a}-${b}` } });
        expect(r.status).toBe(206);
        parts.push(new Uint8Array(await r.arrayBuffer()));
      }
      const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) { joined.set(p, o); o += p.length; }
      const whole = new Uint8Array(await (await fetch(url)).arrayBuffer());
      expect(Buffer.compare(joined, whole)).toBe(0);
      // a short file asked the same way comes back whole in the first range
      const small = await fetch(url.replace('beds%2Flong_bed.wav', 'doors%2Fcreak_01.wav'), { headers: { Range: `bytes=0-${STREAM_OVER - 1}` } });
      const sb = new Uint8Array(await small.arrayBuffer());
      expect(totalOf(small.headers.get('content-range'))).toBe(sb.length);
    } finally {
      await server.close();
    }
  });
  it('answers byte ranges, so a player can seek in a long file', async () => {
    makeSmallLibrary(lib, outside);
    addLibrary(lib, { licence: 'CC0-1.0' });
    const server = await startWatchServer({ writer: f.w, token: 'tok', port: 0 });
    try {
      const url = `http://127.0.0.1:${server.port}/api/library/cellar-foley/audio?${new URLSearchParams({ token: 'tok', path: 'doors/creak_01.wav' })}`;
      const whole = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const r = await fetch(url, { headers: { Range: 'bytes=100-199' } });
      expect(r.status).toBe(206);
      expect(r.headers.get('content-range')).toBe(`bytes 100-199/${whole.length}`);
      expect(r.headers.get('accept-ranges')).toBe('bytes');
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(whole.subarray(100, 200));
      const tail = await fetch(url, { headers: { Range: 'bytes=-10' } });
      expect(new Uint8Array(await tail.arrayBuffer())).toEqual(whole.subarray(whole.length - 10));
      const open = await fetch(url, { headers: { Range: `bytes=${whole.length - 4}-` } });
      expect(open.status).toBe(206);
      expect((await open.arrayBuffer()).byteLength).toBe(4);
      const past = await fetch(url, { headers: { Range: `bytes=${whole.length}-` } });
      expect(past.status).toBe(416);
      expect(past.headers.get('content-range')).toBe(`bytes */${whole.length}`);
    } finally {
      await server.close();
    }
  });
  it('reads one range of a Range header', () => {
    expect(byteRange(undefined, 100)).toBeNull();
    expect(byteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(byteRange('bytes=90-200', 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange('bytes=-20', 100)).toEqual({ start: 80, end: 99 });
    expect(byteRange('bytes=-200', 100)).toEqual({ start: 0, end: 99 });
    expect(byteRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(byteRange('bytes=5-2', 100)).toBe('unsatisfiable');
    expect(byteRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(byteRange('items=0-1', 100)).toBeNull();
  });
});

