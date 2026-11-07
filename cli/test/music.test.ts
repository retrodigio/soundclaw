// The music commands through the CLI: the example song, checks and their exit codes, views, export, MIDI, normalize.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeWav } from '@soundclaw/core';
import { main, USAGE, type Io } from '../src/main.ts';

let tmp: string;
let proj: string;
let clock = 0;
const REPO = join(import.meta.dirname, '..', '..');
const EXAMPLE = join(REPO, 'docs', 'examples', 'chip-exploration.txt');

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'soundclaw-cli-music-'));
  proj = join(tmp, 'demo.sclaw');
  clock = 0;
  sc(['new', proj]);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function sc(args: string[], stdin = ''): { code: number; out: string; err: string } {
  let out = '', err = '';
  const io: Io = { out: (s) => { out += s; }, err: (s) => { err += s; }, stdin: () => stdin, now: () => `2026-11-06T10:00:${String(clock++ % 60).padStart(2, '0')}Z` };
  return { code: main(args, io), out, err };
}

describe('the example: a 16-bar chip exploration loop in two game layers', () => {
  it('runs and passes every check that blocks (masking is advisory), at the music loudness; normalize has nothing left to do', () => {
    let r = sc(['run', proj, EXAMPLE]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/explore: song, 108 bpm 4\/4, key A:minor, 6 channels \(bass, arp, drums, hats, lead, pad\), 7 patterns, 35\.56 s, loop 35\.56 s, layers base \+ tension/);
    expect(r.out).toMatch(/checks: 7\/8 pass; advisory: masking/);
    r = sc(['check', proj]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/pass key .*all 269 notes are in A:minor/);
    expect(r.out).toMatch(/pass render-match/);
    expect(r.out).toMatch(/pass loop-music/);
    expect(r.out).toMatch(/warn masking/);
    const j = JSON.parse(sc(['check', proj, '--json']).out) as { songs: { id: string; pass: boolean; numbers: { lufs: number; loopLength: number; layers: string[] } }[] };
    expect(j.songs[0]!.pass).toBe(true);
    expect(Math.abs(j.songs[0]!.numbers.lufs - -16)).toBeLessThan(0.3);
    expect(j.songs[0]!.numbers.layers).toEqual(['base', 'tension']);
    r = sc(['normalize', proj, 'explore']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/already at -16 LUFS|normalized explore to -16 LUFS/);
  }, 180_000);

  it('the checks have exit codes: a note outside the key fails, and says where', () => {
    sc(['run', proj, '-e', 'song new s key=C:major\nsong channel add s l inst=square_lead\npattern s.p steps=2 tpb=2\n  l: C5 F#5\nsong section add s A p']);
    const r = sc(['check', proj, 's']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL key .*1 of 2 notes are outside C:major \(F#\)\n\s+held to: .*\n\s+0\.25-0\.50 s {2}F#5 in l \(A\/p step 1\)/);
  }, 60_000);
});

describe('views, render, list and export', () => {
  beforeEach(() => {
    sc(['run', proj, '-e', 'song new s tempo=120\nsong channel add s lead inst=pulse_lead\nsong channel add s drums kit=default\npattern s.p steps=8 tpb=2\n  lead: C5 . E5 . G5 - . .\n  drums: k . h . s . h .\nsong section add s A p x2']);
  });

  it('view notes and view mix save a PNG and print the song numbers; --from/--to/--channels narrow it', () => {
    let r = sc(['view', proj, 's', 'notes']);
    expect(r.code, r.err).toBe(0);
    const file = /notes view saved to (\S+\.png)/.exec(r.out)![1]!;
    expect(existsSync(file)).toBe(true);
    expect([...readFileSync(file).subarray(1, 4)]).toEqual([80, 78, 71]);
    expect(r.out).toMatch(/notes view: 14 written notes/);
    r = sc(['view', proj, 's', 'mix', '--from', '0', '--to', '2', '--channels', 'lead']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/mix view saved/);
    r = sc(['view', proj, 's', 'frobnicate']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/a song has the views notes, mix, wave, spec, loop/);
    r = sc(['view', proj, 's', 'compare', 'x']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no sound, song or audio file 'x'/);
  }, 60_000);

  it('render and describe print the numbers; --json is one document', () => {
    const r = sc(['render', proj, 's']);
    expect(r.out).toMatch(/length 4 s, loop 4 s; tempo 120 bpm, 4\/4/);
    const j = JSON.parse(sc(['render', proj, 's', '--json']).out);
    expect(j).toMatchObject({ id: 's', playable: true });
    expect(j.checks.map((c: { name: string }) => c.name)).toContain('render-match');
  }, 60_000);

  it('list shows songs and instruments', () => {
    sc(['run', proj, '-e', 'instrument new bell2 from=fm_bell']);
    const r = sc(['list', proj]);
    expect(r.out).toMatch(/1 song:\n\s+s: song, 120 bpm/);
    expect(r.out).toMatch(/1 instrument: bell2/);
  }, 60_000);

  it('export: wav, --loop, --stems, --format midi and ogg, into --to', () => {
    const out = join(tmp, 'out');
    expect(sc(['export', proj, 's', '--to', out]).code).toBe(0);
    expect(sc(['export', proj, 's', '--loop', '--to', out]).code).toBe(0);
    expect(sc(['export', proj, 's', '--stems', '--to', out]).code).toBe(0);
    expect(sc(['export', proj, 's', '--format', 'midi', '--to', out]).code).toBe(0);
    expect(sc(['export', proj, 's', '--format', 'ogg', '--loop', '--to', out]).code).toBe(0);
    expect(readdirSync(out).sort()).toEqual(['s-loop.ogg', 's-loop.wav', 's-manifest.json', 's-stem-base.wav', 's.mid', 's.wav']);
    expect(decodeWav(new Uint8Array(readFileSync(join(out, 's-loop.wav')))).frames).toBe(4 * 44100);
    const bad = sc(['export', proj, 's', '--format', 'csv']);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/a song exports as --format wav, ogg or midi/);
  }, 90_000);

  it('midi export and import: a song comes back with its notes', () => {
    const out = join(tmp, 'm');
    expect(sc(['midi', 'export', proj, 's', '--to', out]).code).toBe(0);
    const mid = join(out, 's.mid');
    expect(existsSync(mid)).toBe(true);
    const r = sc(['midi', 'import', proj, mid, '--id', 'again']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/imported again from .*s\.mid: 2 channels \((drums, lead|lead, drums)\), 1 pattern, 4 steps per beat/);
    expect(sc(['list', proj]).out).toMatch(/2 songs:/);
  }, 90_000);
});

describe('the reference', () => {
  it('USAGE and docs/commands.md cover every music command', () => {
    const docs = readFileSync(join(REPO, 'docs', 'commands.md'), 'utf8');
    for (const w of ['instrument new', 'instrument from-sound', 'instrument set', 'pattern set', 'song new', 'song channel add', 'song section add', 'song loop', 'song intro', 'song fx', 'midi import', 'midi export', 'view <project> <song>', '--stems', 'notes', 'render-match', 'loop-music', 'masking']) {
      expect(USAGE + docs, w).toContain(w);
      expect(docs, w).toContain(w);
    }
  });
});

beforeAll(() => { void writeFileSync; });

describe('scale and style', () => {
  it('scale prints a key\'s notes and chords, a song\'s key, or every scale', () => {
    let r = sc(['scale', 'A:minor']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^A:minor: A B C D E F G/);
    expect(r.out).toMatch(/VI\s+F\s+F A C\s+Fmaj7/);
    expect(sc(['scale', 'list']).out).toMatch(/phrygian-dominant/);
    expect(sc(['scale', 'H:major']).code).toBe(2);
    sc(['run', proj, '-e', 'song new s key=F#:dorian']);
    r = sc(['scale', proj, 's']);
    expect(r.out).toMatch(/^F#:dorian: F# G# A B C# D# E/);
  });
  it('style --init writes a starter guide and bible, then style reads them back', () => {
    let r = sc(['style', proj]);
    expect(r.out).toMatch(/no style guide \(music-style.md/);
    r = sc(['style', proj, '--init']);
    expect(r.out).toMatch(/wrote music-style.md and music-bible.md/);
    expect(r.out).toMatch(/forbid drums in town/);
    expect(r.out).toMatch(/market: mood warm/);
    expect(r.out).not.toMatch(/problems:/);
    expect(sc(['style', proj, '--init']).out).toMatch(/nothing written/);
    r = sc(['run', proj, '-e', 'song new m from-bible=market']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/song new m tempo=96 key=D:major tags=town bible=market/);
  });
});

describe('the example: a town theme from the bible, a layered battle loop and a stinger, written with the helpers', () => {
  it('runs on the starter style and bible and passes every check, voice leading and layers included', () => {
    sc(['style', proj, '--init']);
    let r = sc(['run', proj, join(REPO, 'docs', 'examples', 'compose-demo.txt')]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/market: song, 96 bpm 4\/4, key D:major, 4 channels \(lead, pad, bass, harp\), 2 patterns, 60 s/);
    expect(r.out).toMatch(/battle: song, 144 bpm 4\/4, key E:minor, .*layers base \+ tension \+ combat/);
    expect(r.out).toMatch(/win: song, 132 bpm 4\/4, key D:major, .*no loop/);
    r = sc(['check', proj]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toMatch(/FAIL|warn /);
    expect(r.out).toMatch(/pass voice-leading .*no parallel fifths or octaves in pad/);
    expect(r.out).toMatch(/pass style .*music bible entry market/);
    expect(r.out).toMatch(/pass layers .*base\+tension\+combat/);
  }, 240_000);
});
