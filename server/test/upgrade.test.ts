// A project made by 0.1.x keeps its samples as samples/<name>.wav with nothing on the tape. It must open and render exactly as before,
// and `soundclaw upgrade` must move the files into the store without changing a rendered sample.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { joinChannels, readSampleWav, renderChannels, samplesHash, type LayeredSound } from '@soundclaw/core';
import { Writer, createProject, importPath, licenceCheck, loadProject, prepareImport, upgradeProject } from '../src/index.ts';
import { makeAudio, wavBytes } from '../../core/test/audio-fixtures.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
const claude = 'agent:claude';
beforeEach(() => { f = fixture(); });
afterEach(() => f.clean());

/** The samples a 0.1.x project could hold: mono, stereo, 48 kHz, 24-bit (and the other widths), all as WAV files in samples/. */
const LEGACY = [
  ['mono_22k', wavBytes(makeAudio('pcm16', 1, 6000, 22050, 1))],
  ['stereo_44k', wavBytes(makeAudio('pcm16', 2, 8000, 44100, 2))],
  ['mono_48k', wavBytes(makeAudio('pcm16', 1, 9000, 48000, 3))],
  ['stereo_24bit', wavBytes(makeAudio('pcm24', 2, 7000, 44100, 4))],
  ['mono_8bit', wavBytes(makeAudio('pcm8', 1, 5000, 44100, 5))],
  ['stereo_float', wavBytes(makeAudio('f32', 2, 6500, 96000, 6))],
  ['Mixed_Case', wavBytes(makeAudio('pcm32', 1, 4000, 44100, 7))],
] as const;

const LAYERS = [
  'sound new mix voice=layered seed=3',
  ...LEGACY.map(([n], i) => `layer add mix sample sample=${n} pitch=${i % 5} offset=${(i * 0.01).toFixed(2)}`),
  'sound new halves voice=layered seed=4',
  'layer add halves sample sample=stereo_44k side=left pan=-1',
  'layer add halves sample sample=stereo_44k side=right pan=1',
  'layer add halves sample sample=stereo_24bit side=left start=0.02 end=0.1',
  'sound new rev voice=layered seed=5',
  'layer add rev sample sample=mono_48k reverse=1 start=0.01',
].join('\n');

/** What the render of each sound is, from the files alone: the 0.1.x reader, the layers, nothing of the new store. */
function reference(w: Writer, dir: string): Record<string, string> {
  const bank = {
    get: (n: string) => {
      const file = join(dir, 'samples', `${n}.wav`);
      if (!existsSync(file)) return undefined;
      const x = readSampleWav(new Uint8Array(readFileSync(file)));
      return { rate: x.rate, data: x.data, ...(x.left && x.right ? { left: x.left, right: x.right } : {}) };
    },
    hash: (n: string) => (existsSync(join(dir, 'samples', `${n}.wav`)) ? n : undefined),
  };
  return Object.fromEntries(['mix', 'halves', 'rev'].map((id) => [id, samplesHash(joinChannels(renderChannels(w.sound(id) as LayeredSound, bank)))]));
}

function legacyProject(): { dir: string; w: Writer; want: Record<string, string> } {
  const dir = join(f.root, 'old.sclaw');
  createProject(dir);
  mkdirSync(join(dir, 'samples'), { recursive: true });
  for (const [n, bytes] of LEGACY) writeFileSync(join(dir, 'samples', `${n}.wav`), bytes);
  const w = new Writer(loadProject(dir));
  const r = w.run({ commands: LAYERS, by: claude });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return { dir, w, want: reference(w, dir) };
}

const renders = (w: Writer): Record<string, string> => Object.fromEntries(['mix', 'halves', 'rev'].map((id) => [id, samplesHash(joinChannels(w.render(id).channels))]));

describe('a 0.1.x project', () => {
  it('opens and renders exactly as the 0.1.x reader renders it, with its samples listed as files not yet on the tape', () => {
    const { dir, w, want } = legacyProject();
    expect(renders(w)).toEqual(want);
    expect(w.samples.list().map((s) => [s.name, s.legacy])).toEqual(LEGACY.map(([n]) => [n, true]).sort((a, b) => (String(a[0]).toLowerCase() < String(b[0]).toLowerCase() ? -1 : 1)));
    expect(w.samples.info('stereo_24bit')).toMatchObject({ channels: 2, rate: 44100, format: 'pcm24', licence: 'unknown' });
    // opened again by a new process: the same
    expect(renders(new Writer(loadProject(dir)))).toEqual(want);
    // and it can take new samples next to the old ones
    writeFileSync(join(f.root, 'new.wav'), wavBytes(makeAudio('pcm16', 1, 900, 44100, 9)));
    expect(importPath(w, join(f.root, 'new.wav'), { by: claude }).items[0]!.info.name).toBe('new');
    expect(renders(w)).toEqual(want);
  });
  it('is upgraded in one group by system:upgrade; every render is the same sample for sample, before, after and on reopening', () => {
    const { dir, w, want } = legacyProject();
    const tape = w.tape().length;
    const r = upgradeProject(w);
    expect(r.moved.sort()).toEqual(LEGACY.map(([n]) => n).sort());
    expect(r.skipped).toEqual([]);
    // one group, by system:upgrade, a sample add for each file
    const added = w.tape().slice(tape);
    expect(added).toHaveLength(LEGACY.length);
    expect(new Set(added.map((t) => t.group)).size).toBe(1);
    expect(new Set(added.map((t) => t.by))).toEqual(new Set(['system:upgrade']));
    expect(added.every((t) => /^sample add \S+ hash=[0-9a-f]{64} rate=\d+ channels=\d frames=\d+ format=\w+ source=file origin=\S+\.wav orig-hash=[0-9a-f]{64} orig-format="wav .+" date=\S+ author=system:upgrade licence=unknown$/.test(t.cmd))).toBe(true);
    // the files moved: samples/ holds .sample text and the store, no .wav
    expect(readdirSync(join(dir, 'samples')).filter((x) => x.endsWith('.wav'))).toEqual([]);
    expect(readdirSync(join(dir, 'samples')).sort()).toEqual([...LEGACY.map(([n]) => `${n}.sample`), 'objects'].sort());
    expect(w.samples.list().every((s) => !s.legacy)).toBe(true);
    // the same samples out
    expect(renders(w)).toEqual(want);
    expect(renders(new Writer(loadProject(dir)))).toEqual(want);
    // nothing left to do
    expect(upgradeProject(w).moved).toEqual([]);
  });
  it('the upgrade is undone like any group: the names go, the audio stays in the store, and the sounds then name samples that are not there', () => {
    const { w } = legacyProject();
    upgradeProject(w);
    const hashes = w.samples.store.list().length;
    expect(hashes).toBeGreaterThan(0);
    const r = w.run({ commands: 'undo', by: claude });
    // sounds play these samples, so the undo is refused: a name cannot go while a sound plays it
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/would take away (a sample|samples) that (is|are) still played: sample '\w+' is still played by sound \w+/);
    expect(w.samples.store.list()).toHaveLength(hashes);
  });
  it('a name already on the tape is left alone: its file stays and is reported', () => {
    const { dir, w } = legacyProject();
    // the tape names mono_22k, with other audio than the file in samples/
    const other = prepareImport(wavBytes(makeAudio('pcm16', 1, 700, 44100, 42)), 'o.wav', {});
    w.samples.store.put(other.audio, other.hash);
    expect(w.run({ commands: `sample add mono_22k hash=${other.hash} rate=44100 channels=1 frames=700 format=pcm16`, by: claude }).ok).toBe(true);
    const r = upgradeProject(w);
    expect(r.skipped).toEqual(['mono_22k: already on the tape; the file is left where it is']);
    expect(r.moved).not.toContain('mono_22k');
    expect(existsSync(join(dir, 'samples', 'mono_22k.wav'))).toBe(true);
    expect(w.samples.entry('mono_22k')!.hash).toBe(other.hash);
  });
  it('has licences like any sample: unknown until set, and a licence check says so', () => {
    const { w } = legacyProject();
    const items = licenceCheck(w, ['mix']);
    expect(items[0]).toMatchObject({ kind: 'sound', id: 'mix', state: 'unknown' });
    upgradeProject(w);
    const set = LEGACY.map(([n]) => `sample set ${n} licence=own`).join('\n');
    const r = w.run({ commands: set, by: claude });
    expect(r.ok).toBe(true);
    expect(licenceCheck(w, ['mix'])[0]!.state).toBe('shippable');
  });
});
