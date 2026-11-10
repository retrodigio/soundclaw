// `soundclaw instrument import`: an SFZ and a SoundFont 2 file made by test code, the fields, --list, and what a bad call says.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pcmFromFloats, sinRad } from '@soundclaw/core';
import { main, type Io } from '../src/main.ts';
import { wavBytes } from '../../core/test/audio-fixtures.ts';
import { buildSf2 } from '../../core/test/sf2-fixture.ts';

let tmp: string;
let proj: string;
let clock = 0;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'soundclaw-cli-instimport-'));
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

const tone = (hz: number): Float32Array => Float32Array.from({ length: 4410 }, (_, i) => 0.4 * sinRad((i / 44100) * 6.283185307179586 * hz));
function sfzFolder(): string {
  const dir = join(tmp, 'pack');
  mkdirSync(join(dir, 'wav'), { recursive: true });
  writeFileSync(join(dir, 'wav', 'a.wav'), wavBytes(pcmFromFloats([tone(220)], 44100, 'pcm16')));
  writeFileSync(join(dir, 'wav', 'b.wav'), wavBytes(pcmFromFloats([tone(330)], 44100, 'pcm16')));
  writeFileSync(join(dir, 'pad.sfz'), '<control> default_path=wav/\n<group> loop_mode=no_loop cutoff=800\n<region> sample=a.wav lokey=48 hikey=59 pitch_keycenter=57\n<region> sample=b.wav lokey=60 hikey=71 pitch_keycenter=64 eq1_gain=3\n');
  return join(dir, 'pad.sfz');
}

describe('instrument import', () => {
  it('imports an SFZ, says what it could not carry, and the instrument is there', () => {
    const r = sc(['instrument', 'import', proj, sfzFolder(), 'licence=CC0-1.0', '--by', 'claude']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('imported instrument pad from pad.sfz (SFZ): 2 regions read, 2 zones written, 2 samples, as group g1');
    expect(r.out).toContain('lost: cutoff (regions 1-2)');
    expect(r.out).toContain('lost: eq1_gain (region 2)');
    const z = sc(['instrument', 'zones', proj, 'pad']).out;
    expect(z).toContain('sample=pad_a root=A3 keys=C3-B3 loop=none loopmode=none');
    expect(sc(['sample', 'show', proj, 'pad_a']).out).toContain('licence: CC0-1.0 (✓ shippable)');
  });

  it('--id, prefix= and the unknown licence', () => {
    const r = sc(['instrument', 'import', proj, sfzFolder(), '--id', 'warm_pad', 'prefix=wp_']);
    expect(r.code, r.err).toBe(0);
    expect(sc(['sample', 'list', proj]).out).toMatch(/^wp_a: .*\? unknown \(unknown\)/);
    expect(sc(['instrument', 'zones', proj, 'warm_pad']).code).toBe(0);
  });

  it('lists a SoundFont\'s presets and imports one', () => {
    const sf2 = join(tmp, 'f.sf2');
    writeFileSync(sf2, buildSf2({
      samples: [{ name: 's', pcm: Int16Array.from({ length: 2000 }, (_, i) => Math.round(Math.sin(i / 9) * 8000)), rate: 22050, rootKey: 60 }],
      instruments: [{ name: 'I', zones: [{ target: 0 }] }],
      presets: [{ name: 'Alpha', bank: 0, program: 0, zones: [{ target: 0 }] }, { name: 'Beta', bank: 0, program: 5, zones: [{ target: 0 }] }],
    }));
    expect(sc(['instrument', 'import', proj, sf2, '--list']).out).toContain('000:005  Beta  (1 zone)');
    const none = sc(['instrument', 'import', proj, sf2]);
    expect(none.code).toBe(1);
    expect(none.err).toContain('2 presets; name one with preset=');
    const ok = sc(['instrument', 'import', proj, sf2, 'preset=beta']);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toContain('imported instrument Beta from f.sf2 (SoundFont 2)');
  });

  it('a call that is wrong says how', () => {
    expect(sc(['instrument', 'import', proj]).err).toContain('give a project folder and an .sfz or .sf2 file');
    expect(sc(['instrument', 'import', proj, join(tmp, 'nothing.sfz')]).err).toContain('no file');
    expect(sc(['instrument', 'import', proj, sfzFolder(), 'colour=red']).err).toContain("no field 'colour'");
    expect(sc(['instrument', 'import', proj, sfzFolder(), '--list']).err).toContain('lists the presets of a .sf2 file');
  });
});
