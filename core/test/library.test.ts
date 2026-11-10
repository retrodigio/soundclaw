// The pure parts of sample libraries: tags from names, declared licences, band energies, the feature vector and the search ranking.

import { describe, expect, it } from 'vitest';
import {
  BAND_COUNT, SIMILAR_FEATURES, bandEnergies, decodeMeasure, encodeMeasure, fileOneLiner, foldPlural, libraryIdFrom, licenceFromText, measureSample, nameWords, parseLibraryManifest, parseQuery,
  pathWords, searchFiles, similarDistance, similarVector, splitLibraryRef, tagsFromPath, wordScore, resample,
  type IndexedFile, type LibraryRef,
} from '../src/index.ts';
import { signal, type Kind } from './library-signals.ts';

describe('tags from paths', () => {
  it('splits on separators and camelCase, lower-cases, folds plurals, drops numbers and extensions', () => {
    expect(nameWords('Creaky_Doors-04')).toEqual(['creaky', 'door']);
    expect(nameWords('CellarDoorSlam.wav')).toEqual(['cellar', 'door', 'slam']);
    expect(nameWords('take 12 final')).toEqual(['take', 'final']);
    expect(['doors', 'cries', 'boxes', 'glass', 'bass', 'bus', 'chains', 'waves', 'is'].map(foldPlural)).toEqual(['door', 'cry', 'box', 'glass', 'bass', 'bus', 'chain', 'wave', 'is']);
  });
  it('gives the words of the folders then those of the name, once each', () => {
    expect(pathWords('Foley/Doors/Wooden/creak_04.wav')).toEqual({ name: ['creak'], folders: ['foley', 'door', 'wooden'] });
    expect(tagsFromPath('Foley/Doors/Wooden/creak_04.wav')).toEqual(['foley', 'door', 'wooden', 'creak']);
    expect(tagsFromPath('doors/door_creak.wav')).toEqual(['door', 'creak']);
  });
  it('makes library ids and splits references', () => {
    expect(libraryIdFrom('Cellar Foley (v2)')).toBe('cellar-foley-v2');
    expect(libraryIdFrom('???')).toBe('library');
    expect(splitLibraryRef('foley:doors/creak 04.wav')).toEqual({ library: 'foley', path: 'doors/creak 04.wav' });
    expect(splitLibraryRef('C:\\x')).toBeNull();
  });
});

describe('what a library declares', () => {
  it('reads soundclaw-library.json and refuses what is wrong with it', () => {
    expect(parseLibraryManifest('{"name":"Cellar","licence":"CC0-1.0","attribution":"made by me","terms":"https://example.org/t"}')).toMatchObject({ from: 'manifest', name: 'Cellar', licence: 'CC0-1.0', attribution: 'made by me' });
    expect(parseLibraryManifest('{"license":"CC-BY-4.0"}').licence).toBe('CC-BY-4.0');
    expect(() => parseLibraryManifest('[]')).toThrow(/object/);
    expect(() => parseLibraryManifest('{"licence":3}')).toThrow(/non-empty string/);
    expect(() => parseLibraryManifest('{"licence":"not a licence"}')).toThrow(/not a licence id/);
    expect(() => parseLibraryManifest('nope')).toThrow(/not JSON/);
  });
  it('reads a licence out of a licence text only when the text says so outright', () => {
    expect(licenceFromText('SPDX-License-Identifier: CC-BY-4.0\n')?.id).toBe('CC-BY-4.0');
    expect(licenceFromText('This work is dedicated to the public domain under CC0 1.0 Universal.')?.id).toBe('CC0-1.0');
    expect(licenceFromText('Creative Commons Attribution-NonCommercial 4.0 International')?.id).toBe('CC-BY-NC-4.0');
    expect(licenceFromText('Creative Commons Attribution-NonCommercial-ShareAlike 3.0')?.id).toBe('CC-BY-NC-SA-3.0');
    expect(licenceFromText('Creative Commons Attribution 4.0')?.id).toBe('CC-BY-4.0');
    expect(licenceFromText('Creative Commons Attribution-NoDerivatives 4.0')?.id).toBe('CC-BY-ND-4.0');
    expect(licenceFromText('All rights reserved. Do what you like, probably.')).toBeNull();
    expect(licenceFromText('Attribution is appreciated.')).toBeNull();
  });
});

describe('bands and the measure in an index', () => {
  it('puts a low tone in the low bands and noise across the high ones', () => {
    const low = bandEnergies(signal('tone', 1, 1, 44100));
    expect(low).toHaveLength(BAND_COUNT);
    const top = low.indexOf(Math.max(...low));
    expect(top).toBe(2); // 261 Hz is in 250-500 Hz
    expect(low[2]!).toBeGreaterThan(-6);
    const hiss = bandEnergies(signal('rain', 2, 1, 44100));
    expect(hiss.filter((d) => d > -30).length).toBeGreaterThan(3);
    expect(bandEnergies(new Float32Array(10))).toEqual(new Array(BAND_COUNT).fill(-60));
  });
  it('keeps a measure through JSON, including silence (−∞) that JSON would turn into null', () => {
    const m = measureSample([new Float32Array(4410)], 44100);
    const back = decodeMeasure(JSON.parse(JSON.stringify(encodeMeasure(m))));
    expect(back.lufs).toBe(m.lufs);
    expect(back.silent).toBe(true);
    const real = measureSample([signal('bell', 3, 1, 22050)], 22050);
    expect(decodeMeasure(JSON.parse(JSON.stringify(encodeMeasure(real)))).centroid).toBeCloseTo(real.centroid, 6);
  });
});

describe('the sounds-like distance', () => {
  const vec = (k: Kind, seed: number, secs: number) => {
    const x = signal(k, seed, secs, 44100);
    return similarVector(measureSample([x], 44100), bandEnergies(x));
  };
  it('has one value for each feature in the table, and is zero from a sound to itself', () => {
    const v = vec('bell', 1, 1);
    expect(v).toHaveLength(SIMILAR_FEATURES.length);
    expect(similarDistance(v, v)).toBe(0);
  });
  it('puts a bell nearer another bell than a creak, a slam or a rain bed', () => {
    const a = vec('bell', 1, 1.5);
    const b = vec('bell', 9, 1.4);
    for (const other of [vec('creak', 1, 1.5), vec('slam', 1, 0.5), vec('rain', 1, 2), vec('clicks', 1, 1)]) {
      expect(similarDistance(a, b), 'bell to bell').toBeLessThan(similarDistance(a, other));
    }
    // and a creak is nearer a creak
    expect(similarDistance(vec('creak', 1, 1.5), vec('creak', 5, 1.3))).toBeLessThan(similarDistance(vec('creak', 1, 1.5), vec('bell', 1, 1.5)));
  });
});

// ---- search ---------------------------------------------------------------------------------------------------

function indexed(path: string, kind: Kind, seed: number, secs: number, extra: Partial<IndexedFile> = {}): IndexedFile {
  const rate = 22050;
  const x = signal(kind, seed, secs, rate);
  const m = measureSample([x], rate);
  return { path, size: 1000, mtime: 1, hash: `h${seed}${path}`, format: 'wav 16-bit', bits: 16, rate, channels: 1, frames: x.length, measure: encodeMeasure(m), bands: bandEnergies(resample(x, rate, 44100)), tags: tagsFromPath(path), ...extra };
}

const LIB: LibraryRef = { id: 'foley', licence: { id: 'CC0-1.0' } };
const OTHER: LibraryRef = { id: 'rooms', licence: { id: 'unknown' } };
const FILES: { lib: LibraryRef; file: IndexedFile }[] = [
  { lib: LIB, file: indexed('doors/creak_01.wav', 'creak', 1, 1.2) },
  { lib: LIB, file: indexed('doors/creak_02.wav', 'creak', 2, 2.4) },
  { lib: LIB, file: indexed('doors/Slam_01.wav', 'slam', 3, 0.6) },
  { lib: LIB, file: indexed('bells/BellHigh.wav', 'bell', 4, 1.5) },
  { lib: LIB, file: indexed('weather/rain_loop.wav', 'rain', 5, 2, { meta: { loop: [0, 44100] } }) },
  { lib: OTHER, file: indexed('misc/old door creaking.wav', 'creak', 6, 1.8) },
  { lib: LIB, file: { path: 'broken/bad.wav', size: 9, mtime: 1, tags: ['broken', 'bad'], error: 'not a WAV' } },
];
const find = (q: string) => searchFiles(FILES, parseQuery(q)).map((h) => `${h.lib.id}:${h.file.path}`);

describe('library search', () => {
  it('needs every word to match somewhere, with plurals folded both ways', () => {
    expect(find('creak')).toEqual(expect.arrayContaining(['foley:doors/creak_01.wav', 'foley:doors/creak_02.wav', 'rooms:misc/old door creaking.wav']));
    expect(find('creaks')).toContain('foley:doors/creak_01.wav');
    expect(find('door creak')).toHaveLength(3);
    expect(find('door bell')).toEqual([]);
    expect(find('doors')).toHaveLength(4);
  });
  it('ranks a file-name match above a folder match', () => {
    const hits = find('door');
    expect(hits[0]).toBe('rooms:misc/old door creaking.wav'); // "door" is a word of the name, a folder word in the others
    expect(hits.slice(1).every((h) => h.startsWith('foley:doors/'))).toBe(true);
  });
  it('filters by the numbers and orders the hits that fit by closeness to the middle of the range', () => {
    expect(find('creak dur=1-3')).toHaveLength(3);
    expect(find('creak dur=2-3')).toEqual(['foley:doors/creak_02.wav']);
    // a name match first, then the files that fit by their distance from the middle of the range (here 1.5 s)
    expect(find('creak dur=0.8-2.8')).toEqual(['foley:doors/creak_01.wav', 'foley:doors/creak_02.wav', 'rooms:misc/old door creaking.wav']);
    const byMiddle = find('dur=0.5-2.5');
    expect(byMiddle[0]).toBe('foley:bells/BellHigh.wav'); // 1.5 s: dead centre
    expect(byMiddle.slice(-2).sort()).toEqual(['foley:doors/Slam_01.wav', 'foley:doors/creak_02.wav']); // 0.6 s and 2.4 s: furthest out
    expect(find('onsets=4 attack<20ms').length).toBeLessThanOrEqual(5);
    expect(find('pitched=yes')).toContain('foley:bells/BellHigh.wav');
    expect(find('loop=yes')).toEqual(['foley:weather/rain_loop.wav']);
    expect(find('dur<0.7')).toEqual(['foley:doors/Slam_01.wav']);
  });
  it('tests licence, source, channels and tags, and skips files that could not be read', () => {
    expect(find('licence=shippable')).not.toContain('rooms:misc/old door creaking.wav');
    expect(find('licence=unknown')).toEqual(['rooms:misc/old door creaking.wav']);
    expect(find('licence=CC0-1.0 tag=bell')).toEqual(['foley:bells/BellHigh.wav']);
    expect(find('source=library channels=1')).toHaveLength(6);
    expect(find('bad')).toEqual([]);
    expect(find('')).toHaveLength(6);
  });
  it('counts a tag added by hand as a tag, and weighs it above a folder word', () => {
    const tagged = FILES.map((e) => (e.file.path === 'bells/BellHigh.wav' ? { ...e, file: { ...e.file, extraTags: ['hinge'] } } : e));
    expect(searchFiles(tagged, parseQuery('hinge')).map((h) => h.file.path)).toEqual(['bells/BellHigh.wav']);
    expect(searchFiles(tagged, parseQuery('tag=hinge')).map((h) => h.file.path)).toEqual(['bells/BellHigh.wav']);
    expect(wordScore(['hinge'], LIB, tagged[3]!.file)).toBe(3);
    expect(wordScore(['doors'], LIB, tagged[0]!.file)).toBe(2); // a folder word
    expect(wordScore(['bells'], LIB, tagged[3]!.file)).toBe(4); // the name has the word too
    expect(wordScore(['bellhigh'], LIB, tagged[3]!.file)).toBe(3); // a joined word still finds a part of it
    expect(wordScore(['hammer'], LIB, tagged[3]!.file)).toBeNull();
  });
  it('describes a file in a line of words', () => {
    expect(fileOneLiner(FILES[3]!.file)).toMatch(/tonal.*one hit/);
    expect(fileOneLiner(FILES[4]!.file)).toMatch(/noisy/);
    expect(fileOneLiner(FILES[6]!.file)).toBe('not readable: not a WAV');
  });
});
