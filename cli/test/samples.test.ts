// The sample commands of the CLI: import with its fields, show, the tape verbs, gc, git-lfs, upgrade, `licence check`,
// and the export flags. Audio is made by test code.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandHelp, main, type Io } from '../src/main.ts';
import { aiffBytes, makeAudio, wavBytes } from '../../core/test/audio-fixtures.ts';
import { pcmFromFloats } from '@soundclaw/core';
import { hitsFloats, toneFloats } from '../../core/test/sample-golden-table.ts';

let tmp: string;
let proj: string;
let clock = 0;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'soundclaw-cli-samples-'));
  proj = join(tmp, 'demo.sclaw');
  clock = 0;
  sc(['new', proj]);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function sc(args: string[]): { code: number; out: string; err: string } {
  let out = '', err = '';
  const io: Io = { out: (s) => { out += s; }, err: (s) => { err += s; }, stdin: () => '', now: () => `2026-11-09T10:00:${String(clock++ % 60).padStart(2, '0')}Z` };
  return { code: main(args, io), out, err };
}
const wav = (name: string, seed = 1, ch = 1, frames = 1500): string => { const p = join(tmp, name); writeFileSync(p, wavBytes(makeAudio('pcm16', ch, frames, 44100, seed))); return p; };

describe('sample import, show, set', () => {
  it('imports with the fields a person or agent gives, in key=value or --option form', () => {
    const a = sc(['sample', 'import', proj, wav('door.wav'), 'licence=CC-BY-4.0', 'attribution=Door by Ana', 'tags=wood,door', 'origin=foley:doors/door.wav', 'source=library', 'note=a close door']);
    expect(a.code, a.err).toBe(0);
    expect(a.out).toMatch(/^imported sample door: 0\.034 s, 44100 Hz, pcm16, mono\n1 sample as group g1\nuse it: layer add <sound> sample sample=door .*side=mix\|left\|right\|stereo\]\n$/);
    const show = sc(['sample', 'show', proj, 'door']).out;
    expect(show).toContain('provenance: source library, origin foley:doors/door.wav');
    expect(show).toContain('licence: CC-BY-4.0 (✓ attribution); attribution: Door by Ana');
    expect(show).toContain('metadata: tags door, wood');
    expect(show).toContain('note: a close door');
    const b = sc(['sample', 'import', proj, wav('other.wav', 2), '--licence', 'own', '--tags', 'x', '--by', 'ana']);
    expect(b.code, b.err).toBe(0);
    expect(sc(['sample', 'show', proj, 'other']).out).toContain('by agent:ana');
    expect(sc(['sample', 'import', proj, wav('third.wav', 3), 'licence=free for all']).err).toMatch(/SPDX id/);
    expect(sc(['sample', 'import', proj, wav('fourth.wav', 4), 'wibble=1']).code).toBe(2);
    expect(sc(['sample', 'import', proj]).code).toBe(2);
    expect(sc(['sample', 'show', proj, 'nope']).err).toMatch(/no sample 'nope' \(samples: door, other\)/);
  });
  it('sets, renames and removes through the tape, with undo', () => {
    sc(['sample', 'import', proj, wav('hit.wav')]);
    const s = sc(['sample', 'set', proj, 'hit', 'root=A2', 'licence=own', 'note=a hit with spaces', 'loop=10-900']);
    expect(s.code, s.err).toBe(0);
    expect(s.out).toBe('sample set hit root=A2 loop=10-900 note="a hit with spaces" licence=own (group g2)\n');
    expect(sc(['sample', 'show', proj, 'hit']).out).toContain('metadata: root A2; loop frames 10-900 (sustain)');
    expect(sc(['sample', 'set', proj, 'hit', 'loop=900-10']).err).toMatch(/start before end/);
    expect(sc(['sample', 'rename', proj, 'hit', 'knock']).code).toBe(0);
    expect(existsSync(join(proj, 'samples', 'knock.sample'))).toBe(true);
    expect(sc(['sample', 'remove', proj, 'knock']).code).toBe(0);
    expect(sc(['sample', 'list', proj]).out).toMatch(/^no samples/);
    expect(sc(['run', proj, '-e', 'undo']).code).toBe(0);
    expect(sc(['sample', 'list', proj]).out).toMatch(/^knock: /);
    const hist = sc(['history', proj]).out;
    expect(hist).toMatch(/sample add hit hash=/);
    expect(hist).toMatch(/sample rename hit knock/);
  });
  it('a sample can be added by the run language when the audio is in the store', () => {
    const imported = sc(['sample', 'import', proj, wav('hit.wav')]);
    expect(imported.code).toBe(0);
    const hash = /hash ([0-9a-f]{12})/.exec(sc(['sample', 'list', proj]).out)![1]!;
    expect(hash).toHaveLength(12);
    const e = sc(['run', proj, '-e', `sample add again hash=${'f'.repeat(64)} rate=44100 channels=1 frames=10 format=pcm16`]);
    expect(e.code).toBe(1);
    expect(e.err).toContain(`hash ${'f'.repeat(64)} is not in the sample store`);
  });
});

describe('gc, git-lfs, upgrade', () => {
  it('gc is a dry run until --apply; git-lfs prints the lines', () => {
    sc(['sample', 'import', proj, wav('a.wav')]);
    expect(sc(['sample', 'gc', proj]).out).toMatch(/nothing to remove/);
    expect(sc(['sample', 'gc', proj, '--drop-history']).out).toMatch(/nothing to remove: every object is used/);
    expect(sc(['sample', 'git-lfs']).out).toContain('samples/objects/**/*.wav filter=lfs diff=lfs merge=lfs -text');
    expect(sc(['sample', 'gc', proj, 'extra']).code).toBe(2);
  });
  it('upgrade moves 0.1 files into the store and says so; it has nothing to do twice', () => {
    mkdirSync(join(proj, 'samples'), { recursive: true });
    writeFileSync(join(proj, 'samples', 'thump.wav'), wavBytes(makeAudio('pcm24', 2, 3000, 48000, 3)));
    expect(sc(['sample', 'list', proj]).out).toMatch(/^thump: .*stereo, pcm24, \? unknown \(unknown\), file, hash [0-9a-f]{12}  \[a 0\.1 file: `soundclaw upgrade` moves it into the store\]\n$/);
    const u = sc(['upgrade', proj]);
    expect(u.out).toBe('moved 1 sample into the store (thump) as group g1 by system:upgrade\n');
    expect(readdirSync(join(proj, 'samples')).sort()).toEqual(['objects', 'thump.sample']);
    expect(sc(['upgrade', proj]).out).toBe('nothing to upgrade: no 0.1 sample files\n');
    expect(sc(['history', proj]).out).toContain('system:upgrade');
    expect(sc(['upgrade']).code).toBe(2);
  });
});

describe('licence check and export', () => {
  beforeEach(() => {
    sc(['sample', 'import', proj, wav('clean.wav', 1), 'licence=own']);
    sc(['sample', 'import', proj, wav('credit.wav', 2), 'licence=CC-BY-4.0', 'attribution=Credit by Ana']);
    sc(['sample', 'import', proj, wav('murky.wav', 3)]);
    expect(sc(['run', proj, '-e', 'sound new a voice=layered; layer add a sample sample=clean; sound new b voice=layered; layer add b sample sample=credit; sound new c voice=layered; layer add c sample sample=murky']).code).toBe(0);
  });
  it('says where each item stands, and names the sample behind a verdict', () => {
    const r = sc(['licence', 'check', proj]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/✓ shippable +sound a +\(own\)\n✓ attribution +sound b +\(CC-BY-4\.0\)\n.*sample credit .* CC-BY-4\.0 asks for attribution\n\? unknown +sound c +\(unknown\)\n.*sample murky .*set it with sample set/);
    expect(sc(['licence', 'check', proj, 'a']).out).toMatch(/^✓ shippable +sound a/);
    expect(sc(['license', 'check', proj, 'c']).out).toMatch(/\? unknown/);
    expect(sc(['licence', 'check']).code).toBe(2);
    expect(sc(['licence', 'check', proj, 'zzz']).err).toMatch(/'zzz' is not a sound/);
  });
  it('a manifest export refuses and names the way out; --allow-licence lets it through; ATTRIBUTION.txt appears', () => {
    const out = join(tmp, 'out');
    const refused = sc(['export', proj, '--all', '--to', out]);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/export refused: a sound reaches a licence the project does not ship:\n {2}c \(unknown\)\n {4}sample murky: [\s\S]*--allow-licence <id>/);
    expect(existsSync(out)).toBe(false);
    const ok = sc(['export', proj, '--all', '--to', out, '--allow-licence', 'unknown']);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toContain('ATTRIBUTION.txt written');
    expect(readFileSync(join(out, 'ATTRIBUTION.txt'), 'utf8')).toContain('Credit by Ana');
    expect((JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { allowedLicences: string[] }).allowedLicences).toEqual(['unknown']);
    // a named single sound exports with a warning
    const one = sc(['export', proj, 'c', '--to', join(tmp, 'one')]);
    expect(one.code).toBe(0);
    expect(one.out).toMatch(/note: c: unknown licence \(murky unknown\); a manifest export would refuse it/);
  });
});

describe('usage', () => {
  it('has blocks for sample, upgrade and licence, which the reference documents', () => {
    expect(commandHelp('sample')).toContain('soundclaw sample import <project> <file | folder>');
    expect(commandHelp('sample')).toContain('soundclaw sample gc <project> [--apply] [--removed] [--drop-history]');
    expect(commandHelp('upgrade')).toContain('system:upgrade');
    expect(commandHelp('licence')).toContain('licence check <project>');
    const ref = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'commands.md'), 'utf8');
    for (const c of ['sample import', 'sample list', 'sample show', 'sample gc', 'sample git-lfs', 'upgrade', 'licence check']) expect(ref, c).toContain(`soundclaw ${c}`);
  });
  it('the AIFF a person drops in is as good as a WAV', () => {
    const p = join(tmp, 'x.aiff');
    writeFileSync(p, aiffBytes(makeAudio('pcm16', 2, 900)));
    expect(sc(['sample', 'import', proj, p]).out).toMatch(/^imported sample x: 0\.020 s, 44100 Hz, pcm16, stereo\n/);
  });
});

describe('editing and hearing samples from the command line', () => {
  const load = (): void => {
    const hits = join(tmp, 'hits.wav');
    writeFileSync(hits, wavBytes(pcmFromFloats([hitsFloats(22050, 2, 0.5)], 22050, 'pcm16')));
    const tone = join(tmp, 'tone.wav');
    writeFileSync(tone, wavBytes(pcmFromFloats([toneFloats(44100, 1)], 44100, 'pcm16')));
    expect(sc(['sample', 'import', proj, hits, 'licence=CC-BY-4.0', 'attribution=test']).code).toBe(0);
    expect(sc(['sample', 'import', proj, tone, 'licence=own', 'tags=tonal']).code).toBe(0);
  };

  it('has verbs for derive, slice, loop and bounce, and a numbers query on list', () => {
    load();
    const slice = sc(['sample', 'slice', proj, 'hits', 'at=onsets']);
    expect(slice.code, slice.err).toBe(0);
    expect(slice.out).toMatch(/sample set hits slices=0,/);
    const d = sc(['sample', 'derive', proj, 'hit2', 'from=hits', 'op=slice 2; fade out=10ms; normalize peak -3', 'tags=hit']);
    expect(d.code, d.err).toBe(0);
    expect(d.out).toMatch(/sample add hit2 hash=[0-9a-f]{64} rate=22050 channels=1 frames=\d+ format=f32/);
    const loop = sc(['sample', 'loop', proj, 'tone', 'find', 'min=0.2']);
    expect(loop.code, loop.err).toBe(0);
    expect(sc(['sample', 'loop', proj, 'tone', '0.25', '0.75']).code).toBe(0);
    expect(sc(['run', proj, '-e', 'sound new a voice=layered seed=1\nlayer add a osc wave=sine freq=100 dur=0.2']).code).toBe(0);
    expect(sc(['sample', 'bounce', proj, 'a_b', 'from=a']).out).toMatch(/sample add a_b hash=/);
    expect(sc(['sample', 'list', proj, 'source=derived']).out).toMatch(/^hit2 .*derived/);
    expect(sc(['sample', 'list', proj, 'tag=tonal licence=own', '--json']).out).toMatch(/"name": "tone"/);
    expect(sc(['sample', 'list', proj, 'nope=1']).err).toMatch(/no key 'nope'/);
  });

  it('describe, measure, view, compare and check take sample:<name>', () => {
    load();
    const d = sc(['describe', proj, 'sample:tone']);
    expect(d.code, d.err).toBe(0);
    expect(d.out).toMatch(/^sample:tone: 1\.00 s, 44100 Hz, mono;/);
    expect(d.out).toMatch(/pitch A3/);
    const m = sc(['measure', proj, 'sample:hits', '--json']);
    expect(m.code, m.err).toBe(0);
    expect((JSON.parse(m.out) as { samples: { ref: string; measure: { onsets: { count: number } } }[] }).samples[0]!.measure.onsets.count).toBe(4);
    expect(sc(['view', proj, 'sample:tone', 'wave']).out).toMatch(/^wave view saved to /);
    expect(sc(['view', proj, 'sample:tone', 'slices']).out).toMatch(/onsets? found; set them with sample slice tone/);
    expect(sc(['view', proj, 'sample:tone', 'layers']).err).toMatch(/a sample has the views wave, spec, pitch, loop, slices/);
    const c = sc(['compare', proj, 'sample:tone', 'sample:hits', '--json']);
    expect(c.code, c.err).toBe(0);
    expect((JSON.parse(c.out) as { a: string }).a).toBe('sample:tone');
    expect(sc(['sample', 'check', proj]).out).toMatch(/2 samples checked/);
    expect(sc(['describe', proj, 'sample:ghost']).err).toMatch(/no sample 'ghost'/);
  });

  it('the usage and the reference carry the new commands', () => {
    const ref = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'commands.md'), 'utf8');
    for (const c of ['sample derive', 'sample slice', 'sample loop', 'sample bounce', 'sample check', 'compare', 'layer align', 'layer match']) {
      expect(ref, c).toContain(c);
    }
    for (const c of ['sample derive <project>', 'sample slice <project>', 'sample loop <project>', 'sample bounce <project>', 'sample check <project>']) expect(commandHelp('sample'), c).toContain(`soundclaw ${c}`);
    expect(commandHelp('compare')).toContain('soundclaw compare <project> <a> <b>');
  });
});
