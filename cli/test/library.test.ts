// The library commands of the CLI: add (and what it reads from the folder), list, index, tag, search, similar, use and remove, with the
// refusals. Audio is made by test code.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SIMILAR_FEATURES } from '@soundclaw/core';
import { commandHelp, main, type Io } from '../src/main.ts';
import { makeSmallLibrary, put, wavOf } from '../../server/test/library-fixtures.ts';

const BIN = join(import.meta.dirname, '..', 'bin', 'soundclaw.js');
let tmp: string;
let proj: string;
let lib: string;
let env: NodeJS.ProcessEnv;
const saved = { cfg: process.env.SOUNDCLAW_CONFIG_DIR, cache: process.env.SOUNDCLAW_CACHE_DIR };
let clock = 0;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'soundclaw-cli-library-'));
  proj = join(tmp, 'demo.sclaw');
  lib = join(tmp, 'cellar');
  mkdirSync(lib);
  process.env.SOUNDCLAW_CONFIG_DIR = join(tmp, 'config');
  process.env.SOUNDCLAW_CACHE_DIR = join(tmp, 'cache');
  env = { ...process.env, SOUNDCLAW_INDEX_WORKERS: '2' };
  clock = 0;
  sc(['new', proj]);
  makeSmallLibrary(lib, join(tmp, 'outside'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (saved.cfg === undefined) delete process.env.SOUNDCLAW_CONFIG_DIR; else process.env.SOUNDCLAW_CONFIG_DIR = saved.cfg;
  if (saved.cache === undefined) delete process.env.SOUNDCLAW_CACHE_DIR; else process.env.SOUNDCLAW_CACHE_DIR = saved.cache;
});

function sc(args: string[]): { code: number; out: string; err: string } {
  let out = '', err = '';
  const io: Io = { out: (s) => { out += s; }, err: (s) => { err += s; }, stdin: () => '', now: () => `2026-11-09T10:00:${String(clock++ % 60).padStart(2, '0')}Z` };
  return { code: main(args, io), out, err };
}
/** `library index` runs from the executable (worker threads). */
function index(...args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [BIN, 'library', 'index', ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('library add, list and remove', () => {
  it('adds a folder with licence= and says what it read and what to do next', () => {
    const r = sc(['library', 'add', lib, 'licence=CC-BY-4.0', 'attribution=Sounds by the suite', '--name', 'cellar']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/added library 'cellar'/);
    expect(r.out).toMatch(/next: soundclaw library index cellar/);
    const l = sc(['library', 'list']);
    expect(l.out).toMatch(/^cellar {2}.*\n {2}licence CC-BY-4.0 \(given at add\), attribution "Sounds by the suite"\n {2}not indexed: soundclaw library index cellar/);
    expect(JSON.parse(sc(['library', 'list', '--json']).out)).toMatchObject([{ id: 'cellar', licence: 'CC-BY-4.0', indexed: false }]);
  });
  it('reads soundclaw-library.json, shows a licence file’s reading and asks for --yes', () => {
    put(lib, 'LICENSE', 'Released under CC0 1.0 Universal (public domain).');
    const refused = sc(['library', 'add', lib]);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/reads as CC0-1.0.*--yes/s);
    expect(sc(['library', 'add', lib, '--yes']).out).toMatch(/licence CC0-1.0, read from LICENSE.* and confirmed/);
  });
  it('lists with nothing registered, and removes a library without touching the folder', () => {
    expect(sc(['library', 'list']).out).toMatch(/no libraries registered/);
    sc(['library', 'add', lib, 'licence=own', '--name', 'cellar']);
    expect(sc(['library', 'remove', 'cellar']).out).toMatch(/removed library cellar from the list \(its folder and the files in it are untouched\)/);
    expect(sc(['library', 'remove', 'cellar']).err).toMatch(/no library 'cellar'/);
    expect(sc(['library', 'list']).out).toMatch(/no libraries registered/);
  });
  it('says what is wrong with the arguments', () => {
    expect(sc(['library']).code).toBe(2);
    expect(sc(['library', 'frob']).err).toMatch(/library: add \| list \| remove \| index \| tag \| search \| similar \| use/);
    expect(sc(['library', 'add']).err).toMatch(/give a folder/);
    expect(sc(['library', 'add', lib, 'colour=red']).err).toMatch(/no field 'colour' \(licence, attribution, terms, name\)/);
    expect(sc(['library', 'add', lib, 'bad']).err).toMatch(/unexpected 'bad'/);
    expect(sc(['library', 'add', lib, 'licence=not a licence']).err).toMatch(/not a licence id/);
    expect(sc(['library', 'index']).err).toMatch(/runs from the soundclaw command itself/);
    expect(sc(['library', 'search', '--limit', '0']).err).toMatch(/--limit is a whole number from 1 to 500/);
    expect(sc(['library', 'use', proj]).err).toMatch(/library use: library use <project>/);
    expect(sc(['library', 'tag', 'a', 'b']).err).toMatch(/library tag: library tag <id> <path> <tag>/);
  });
  it('has its own help block', () => {
    const h = commandHelp('library')!;
    expect(h).toContain('soundclaw library add <folder>');
    expect(h).toContain('soundclaw library use <project> <library>:<path>');
    expect(h).not.toContain('soundclaw sample');
  });
});

describe('library index, search, similar, tag and use', () => {
  beforeEach(() => {
    sc(['library', 'add', lib, 'licence=CC0-1.0', '--name', 'cellar']);
  });
  it('indexes on worker threads, reports what it read, and reads only what changed next time', () => {
    const first = index();
    expect(first.code, first.err).toBe(0);
    expect(first.out).toMatch(/^library cellar: 10 files indexed in [\d.]+ s \(10 read, 0 unchanged\)/);
    expect(first.out).toMatch(/warning: 2 files could not be read and are skipped by search/);
    expect(index('cellar').out).toMatch(/\(0 read, 10 unchanged\)/);
    expect(index('--rebuild', '--workers', '0').out).toMatch(/\(10 read, 0 unchanged\)/);
    expect(index('nope').err).toMatch(/no library 'nope'/);
    expect(index('--workers', 'many').code).toBe(2);
  }, 60_000);
  it('searches in text and JSON, by library, with a limit, and sends the user to the next step', () => {
    index();
    const r = sc(['library', 'search', 'creak', 'dur=0.8-3', 'pitched=no']);
    expect(r.code, r.err).toBe(0);
    const lines = r.out.trim().split('\n');
    expect(lines[0]).toMatch(/^cellar:doors\/creak_02\.wav {2}2\.40 s {2}-?[\d.]+ LUFS {2}- {2}centroid \d+ Hz {2}attack \d+ ms {2}✓ shippable \(CC0-1\.0\) {2}/);
    expect(lines[1]).toMatch(/^cellar:doors\/creak_01\.wav/);
    expect(lines.at(-1)).toBe('2 files; use one: soundclaw library use <project> cellar:<path> [as=<name>]');
    const j = JSON.parse(sc(['library', 'search', 'bell', '--json']).out) as Record<string, unknown>[];
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ ref: 'cellar:bells/BellHigh.wav', licence: 'CC0-1.0', state: 'shippable' });
    expect(sc(['library', 'search', '--limit', '2']).out).toMatch(/2 of 8 files \(--limit shows more\)/);
    expect(sc(['library', 'search', 'zzz']).out).toMatch(/no file fits "zzz"/);
    expect(sc(['library', 'search', 'creak', '--library', 'nope']).err).toMatch(/no library 'nope'/);
    expect(sc(['library', 'search', 'dur=fast']).err).toMatch(/library: dur=fast/);
  }, 60_000);
  it('judges licence= by the policy of the project named with --project', () => {
    index();
    expect(sc(['library', 'search', 'licence=shippable']).out).toMatch(/8 files/);
    writeFileSync(join(proj, 'project.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(proj, 'project.json'), 'utf8')), licences: { allow: ['own'], block: [] } }));
    expect(sc(['library', 'search', 'licence=shippable', '--project', proj]).out).toMatch(/no file fits/);
    expect(sc(['library', 'search', 'bell', '--project', proj]).out).toMatch(/✕ blocked \(CC0-1\.0\)/);
  }, 60_000);
  it('finds files like a file or a sample of the project, nearest first', () => {
    index();
    const ref = join(tmp, 'a_creak.wav');
    writeFileSync(ref, wavOf('creak', 31, 1.4));
    const r = sc(['library', 'similar', proj, ref, '--limit', '2']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^like a_creak\.wav:\n/);
    expect(r.out).toMatch(/distance \d+\.\d\d/);
    expect(r.out.split('\n').filter((l) => /creak_0\d/.test(l))).toHaveLength(2);
    sc(['sample', 'import', proj, ref]);
    const j = JSON.parse(sc(['library', 'similar', proj, 'sample:a_creak', 'dur>2', '--json']).out) as Record<string, unknown>[];
    expect(j.map((h) => h.ref)).toContain('cellar:doors/creak_02.wav');
    expect(j.every((h) => typeof h.distance === 'number' && (h.dur as number) > 2)).toBe(true);
    expect(sc(['library', 'similar', proj]).err).toMatch(/library similar: library similar \[<project>\]/);
    // a file needs no project
    const alone = sc(['library', 'similar', ref, 'dur>1', '--limit', '1']);
    expect(alone.code, alone.err).toBe(0);
    expect(alone.out).toMatch(/^like a_creak\.wav:\ncellar:doors\/creak_0\d\.wav /);
    expect(sc(['library', 'similar', 'sample:a_creak']).err).toMatch(/neither a project folder nor an audio file/);
  }, 60_000);
  it('asks for --yes before dropping tags added by hand with a library', () => {
    index();
    sc(['library', 'tag', 'cellar', 'doors/creak_01.wav', 'hinge']);
    expect(sc(['library', 'remove', 'cellar']).err).toMatch(/tags added by hand on 1 file; .*--yes/);
    expect(sc(['library', 'remove', 'cellar', '--yes']).out).toMatch(/removed library cellar .*; dropped the tags added by hand on 1 file/);
  }, 60_000);
  it('tags a file, finds it by the tag, and takes the tag along when it is used', () => {
    index();
    expect(sc(['library', 'tag', 'cellar', 'doors/creak_01.wav', 'hinge,rusty']).out).toBe('cellar:doors/creak_01.wav tags: hinge, rusty\n');
    expect(sc(['library', 'search', 'rusty']).out).toMatch(/cellar:doors\/creak_01\.wav/);
    expect(sc(['library', 'tag', 'cellar', 'doors/creak_01.wav', 'rusty', '--remove']).out).toMatch(/tags: hinge\n/);
    const use = sc(['library', 'use', proj, 'cellar:doors/creak_01.wav', 'as=creak']);
    expect(use.code, use.err).toBe(0);
    expect(use.out).toMatch(/^imported sample creak: 1\.200 s, 22050 Hz, pcm16, mono/);
    expect(sc(['sample', 'list', proj]).out).toMatch(/^creak: 1\.200 s,.*✓ shippable \(CC0-1\.0\), library, tags creak,door,hinge/m);
    expect(use.out).toMatch(/1 sample as group g\d+/);
    expect(use.out).toMatch(/use it: layer add <sound> sample sample=creak/);
    expect(sc(['library', 'tag', 'cellar', 'doors/none.wav', 'x']).err).toMatch(/no indexed file/);
  }, 60_000);
  it('copies a file into the project as the author given, refuses names taken by other audio and paths that leave the folder', () => {
    index();
    const use = sc(['library', 'use', proj, 'cellar:bells/BellHigh.wav', '--by', 'human:ana', 'licence=own', 'tags=chime']);
    expect(use.code, use.err).toBe(0);
    expect(use.out).toMatch(/^imported sample BellHigh: 1\.500 s/);
    expect(sc(['sample', 'list', proj]).out).toMatch(/^BellHigh: 1\.500 s,.*✓ shippable \(own\), library, tags bell,chime,high/m);
    const tape = readFileSync(join(proj, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { cmd: string; by: string });
    expect(tape.at(-1)).toMatchObject({ by: 'human:ana' });
    expect(tape.at(-1)!.cmd).toContain('origin=cellar:bells/BellHigh.wav');
    const clash = sc(['library', 'use', proj, 'cellar:doors/creak_01.wav', 'as=BellHigh']);
    expect(clash.code).toBe(1);
    expect(clash.err).toMatch(/exists with other audio/);
    expect(sc(['library', 'use', proj, 'cellar:../outside/elsewhere/outside.wav']).err).toMatch(/not a path inside library cellar/);
    expect(sc(['library', 'use', proj, 'cellar:doors/creak_01.wav', 'colour=red']).err).toMatch(/no field 'colour'/);
  }, 60_000);
});

describe('the command reference', () => {
  it('prints the sounds-like table with the scale and weight each feature has in the code', () => {
    const ref = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'commands.md'), 'utf8');
    const label: Record<string, string> = { onsetrate: 'onset rate' };
    for (const f of SIMILAR_FEATURES.filter((x) => !x.name.startsWith('band '))) {
      const row = ref.split('\n').find((l) => l.startsWith(`| ${label[f.name] ?? f.name} |`));
      expect(row, f.name).toBeTruthy();
      expect(row, f.name).toMatch(new RegExp(`\\| ${f.weight} \\|$`));
    }
    const bands = ref.split('\n').find((l) => l.startsWith('| eight bands |'))!;
    expect(bands).toContain(`| ${SIMILAR_FEATURES.find((x) => x.name.startsWith('band '))!.weight} each |`);
    expect(SIMILAR_FEATURES.filter((x) => x.name.startsWith('band '))).toHaveLength(8);
  });
});

describe('the bundled executable', () => {
  it('runs `library index` as a command of its own', () => {
    const r = execFileSync(process.execPath, [BIN, 'library', 'list'], { env, encoding: 'utf8' });
    expect(r).toMatch(/no libraries registered/);
  });
});
