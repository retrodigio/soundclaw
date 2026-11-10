// The fixes from the first large use, through the CLI: machine-readable numbers for many sounds in one process,
// normalize, loudness classes in the checks, import options, the compare header, sample folders.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeWav } from '@soundclaw/core';
import { main, type Io } from '../src/main.ts';

let tmp: string;
let proj: string;
let clock = 0;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'soundclaw-cli-s3c-'));
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
const run = (cmds: string): void => { const r = sc(['run', proj, '-e', cmds]); expect(r.code, r.err).toBe(0); };
const measure = (...ids: string[]) => JSON.parse(sc(['measure', proj, ...ids, '--json']).out) as { pass: boolean; sounds: any[]; sets: any[] };
// a sine of a known level: layered, flat amplitude, closed by a short decay so the checks other than loudness pass
const sine = (id: string, amp: number, extra = ''): string => `sound new ${id} voice=layered seed=1\nlayer add ${id} osc wave=sine freq=440 dur=0.6\nenv ${id} 1.amp "0:0 0.01:${amp} 0.5:${amp} 0.6:0@exp"\n${extra}`;

describe('measure, check, describe and render as JSON', () => {
  it('measure --json: every sound of the project in one process, with the class, every number and every check', () => {
    run(sine('a', 0.3) + sine('b', 0.05, 'sound set b class=ui\n') + 'sound new quiet\nsound set quiet volume=0\n');
    const r = sc(['measure', proj, '--json']);
    expect(r.code).toBe(1); // something fails
    const j = JSON.parse(r.out);
    expect(j.format).toBe('soundclaw-measure');
    expect(j.sounds.map((s: any) => s.id)).toEqual(['a', 'b', 'quiet']);
    const a = j.sounds[0];
    expect(Object.keys(a).sort()).toEqual(['binding', 'checks', 'class', 'description', 'id', 'moment', 'numbers', 'pass', 'status', 'summary', 'voice']);
    expect(a.class).toMatchObject({ name: 'standard', target: -16, tolerance: 1, basis: 'class standard' });
    expect(j.sounds[1].class).toMatchObject({ name: 'ui', target: -28, tolerance: 3 });
    expect(a.checks.map((c: any) => c.name)).toEqual(['clip', 'loudness', 'dc', 'click', 'tail', 'harsh']);
    for (const c of a.checks) expect(Object.keys(c).sort()).toEqual(['name', 'pass', 'ranges', 'score', 'threshold', 'value']);
    expect(Object.keys(a.numbers)).toEqual(expect.arrayContaining(['duration', 'lufs', 'truePeakDb', 'peakDb', 'rmsDb', 'crestDb', 'dc', 'attack', 'tail', 'centroid', 'pitch', 'onsets', 'onsetTimes', 'samples', 'channels']));
    expect(a.numbers.duration).toBeGreaterThan(0.55);
    expect(a.numbers.pitch.start).toBeGreaterThan(400);
    expect(a.numbers.pitch.start).toBeLessThan(480);
    expect(j.sounds[2].numbers.lufs).toBeNull(); // silent: no loudness, not -Infinity
    expect(r.out).not.toMatch(/Infinity|NaN/);
    // named sounds only; the same numbers as describe
    const one = measure('b');
    expect(one.sounds).toHaveLength(1);
    const d = JSON.parse(sc(['describe', proj, 'b', '--json']).out);
    expect(d.numbers).toEqual(one.sounds[0].numbers);
    const rd = JSON.parse(sc(['render', proj, 'b', '--json']).out);
    expect(rd.renderKey).toMatch(/^[0-9a-f]{64}$/);
    expect(rd.samplesHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rd.numbers).toEqual(d.numbers);
    const ck = JSON.parse(sc(['check', proj, 'b', '--json']).out);
    expect(ck.sounds[0].checks).toEqual(d.checks);
    expect(sc(['measure', proj, 'nope', '--json']).err).toMatch(/no sound 'nope'/);
  });

  it('measure says which class applied, in text; a set is measured as its set-spread check', () => {
    run(sine('a', 0.3, 'sound set a class=foley\n') + 'set new g from=a count=3 spread="1.freq±8%"\n');
    const t = sc(['measure', proj, 'a']);
    expect(t.out).toMatch(/^a \(class foley: -22.0 LUFS ±2\)/);
    const j = measure('g');
    expect(j.sets[0]).toMatchObject({ id: 'g', members: ['g_1', 'g_2', 'g_3'] });
    expect(j.sets[0].check.name).toBe('set-spread');
    expect(j.sets[0].distances).toHaveLength(3);
    expect(measure().sets).toHaveLength(1);
    expect(measure().sounds.map((s: any) => s.id)).toEqual(['a', 'g_1', 'g_2', 'g_3']);
    expect(sc(['check', proj, 'a']).out).toMatch(/held to -22\.0 LUFS ±2 \(class foley\)/);
  });

  it('check names the rule that binds when harsh and loudness pull against each other', () => {
    // a bright, quiet sound: its 2-5 kHz band is over the limit and it is too quiet
    run('sound new h voice=layered seed=1\nlayer add h osc wave=sine freq=3000 dur=0.5\nenv h 1.amp "0:0 0.01:0.2 0.4:0.2 0.5:0@exp"\nsound set h loudness=-8\n');
    const j = measure('h').sounds[0];
    expect(j.checks.find((c: any) => c.name === 'harsh').pass).toBe(false);
    expect(j.checks.find((c: any) => c.name === 'loudness').value).toMatch(/too quiet/);
    expect(j.binding[0]).toMatch(/lower the 2-5 kHz energy first.*then raise gain/);
    expect(sc(['check', proj, 'h']).out).toMatch(/binding rule: harsh and loudness pull against each other \(louder is harsher\): lower the 2-5 kHz energy first/);
  });
});

describe('normalize', () => {
  const lufs = (id: string): number => measure(id).sounds[0].numbers.lufs as number;

  it('brings sounds to their class target within 0.1 LU, writing gain commands in one undo group', () => {
    run(sine('a', 0.3) + sine('b', 0.1) + 'sound set a class=ui\nsound set b class=impact\n');
    const r = sc(['normalize', proj, 'a', 'b']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/normalized 2 sounds to each sound's own class as group g\d+/);
    expect(r.out).toMatch(/sound set a gain=/);
    expect(Math.abs(lufs('a') + 28)).toBeLessThan(0.1);
    expect(Math.abs(lufs('b') + 14)).toBeLessThan(0.1);
    expect(sc(['check', proj, 'a', 'b']).out).toMatch(/loudness\s+pass/);
    const again = sc(['normalize', proj, 'a', 'b']);
    expect(again.out).toMatch(/already at|nothing to write|normalized/);
    expect(sc(['run', proj, '-e', 'undo']).code).toBe(0);
  });

  it('to a class (the sounds join it) or to target=<LUFS> (they are held to it); a set normalizes its members', () => {
    run(sine('a', 0.3) + sine('b', 0.05) + 'set new g from=a count=3\n');
    const c = sc(['normalize', proj, 'a', 'voice']);
    expect(c.out).toMatch(/to class voice \(-20 LUFS\)/);
    expect(c.out).toMatch(/sound set a class=voice loudness=auto/);
    expect(Math.abs(lufs('a') + 20)).toBeLessThan(0.1);
    expect(measure('a').sounds[0].class.name).toBe('voice');
    const t = sc(['normalize', proj, 'b', 'target=-31']);
    expect(t.out).toMatch(/to -31 LUFS/);
    expect(Math.abs(lufs('b') + 31)).toBeLessThan(0.1);
    expect(measure('b').sounds[0].class).toMatchObject({ target: -31, basis: 'class standard; own loudness' });
    expect(measure('b').sounds[0].checks.find((x: any) => x.name === 'loudness').pass).toBe(true);
    const s = sc(['normalize', proj, 'g', 'ambience']);
    expect(s.code, s.err).toBe(0);
    for (const m of ['g_1', 'g_2', 'g_3']) expect(Math.abs(lufs(m) + 26)).toBeLessThan(0.1);
  });

  it('says it when a classic sound cannot get loud enough, and refuses what it does not know', () => {
    run('sound new k voice=classic preset=blip seed=2\nsound set k sustain=0.02 decay=0.02 volume=0.2\n');
    const r = sc(['normalize', proj, 'k', 'target=-3']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/warning: k: volume stops at [\d.]+, .* LU under the target -3/);
    expect(sc(['normalize', proj, 'k', 'loudest']).err).toMatch(/no sound or set 'loudest'|neither a loudness class/);
    expect(sc(['normalize', proj, 'k', 'target=5']).err).toMatch(/LUFS from -60 to 0/);
    expect(sc(['normalize', proj]).err).toMatch(/normalize:/);
  });

  it('a set made with a class is matched to the class target', () => {
    run(sine('a', 0.3) + 'set new g from=a count=3 class=foley\n');
    for (const m of ['g_1', 'g_2', 'g_3']) expect(Math.abs(lufs(m) + 22)).toBeLessThan(0.1);
    expect(sc(['check', proj, 'g_1']).out).toMatch(/loudness\s+pass .*\(class foley\)/);
    run('set class g music-sting');
    for (const m of ['g_1', 'g_2']) expect(Math.abs(lufs(m) + 16)).toBeLessThan(0.1);
    expect(sc(['run', proj, '-e', 'sound set g_1 class=nope']).err).toMatch(/no loudness class 'nope' \(classes: standard, ui, foley/);
  });
});

describe('the rest of the output', () => {
  const CSV = 'key,wave,freq\nbeepa,2,0.3\nbeepb,2,0.4\nbeepa,2,0.5\n';

  it('import prints the warnings first and a summary, --quiet only those; --classic marks the sounds', () => {
    const file = join(tmp, 'synth.csv');
    writeFileSync(file, CSV);
    const r = sc(['import', proj, 'sfxr', file]);
    expect(r.code, r.err).toBe(0);
    const lines = r.out.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^warning: .*beepa/);
    expect(lines[1]).toMatch(/^imported 2 sounds \(beepa, beepb\) as group g\d+: 2 exact, 0 approximated$/);
    expect(lines.some((l) => /^row 1 beepa: exact/.test(l))).toBe(true);
    sc(['run', proj, '-e', 'undo']);
    const q = sc(['import', proj, 'sfxr', file, '--quiet', '--classic']);
    expect(q.out.trimEnd().split('\n')).toHaveLength(2);
    expect(q.out).toMatch(/all marked classic/);
    expect(q.out).not.toMatch(/row 1/);
    expect(readFileSync(join(proj, 'sounds', 'beepa.sfx'), 'utf8')).toContain('classic yes');
    expect(sc(['export', proj, '--pack', '--to', join(tmp, 'pack')]).out).toMatch(/marked classic written as rows of synth.csv/);
    expect(existsSync(join(tmp, 'pack', 'synth.csv'))).toBe(true);
  });

  it('a big import lists only the rows that lost something', () => {
    const rows = ['key,wave,freq', ...Array.from({ length: 12 }, (_, i) => `imp${i},2,0.${(i % 9) + 1}`)];
    writeFileSync(join(tmp, 'many.csv'), rows.join('\n') + '\n');
    const r = sc(['import', proj, 'sfxr', join(tmp, 'many.csv')]);
    expect(r.out).toMatch(/imported 12 sounds as group g\d+: 12 exact, 0 approximated/);
    expect(r.out).not.toMatch(/row 1 /);
  });

  it('view compare states which sound is A and which is B, and the sign in that order', () => {
    run(sine('first', 0.3) + sine('second', 0.1));
    const v = sc(['view', proj, 'first', 'compare', 'second']);
    expect(v.out).toMatch(/A = first, B = second/);
    expect(v.out).toMatch(/B compared with A, that is second compared with first \(positive: second is more, negative: first is more\)/);
    expect(v.out).toMatch(/loudness -\d/); // second is quieter
  });

  it('sample import takes a folder: every .wav, the problems named, the rest imported', () => {
    const dir = join(tmp, 'wavs');
    mkdirSync(dir);
    const tone = (f: number): Float32Array => Float32Array.from({ length: 4410 }, (_, i) => 0.5 * Math.sin(i * f));
    writeFileSync(join(dir, 'Hit One.wav'), encodeWav(tone(0.1)));
    writeFileSync(join(dir, 'hit-two.wav'), encodeWav(tone(0.2)));
    writeFileSync(join(dir, 'broken.wav'), 'not a wav');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    const r = sc(['sample', 'import', proj, dir]);
    expect(r.out).toMatch(/imported sample Hit_One: 0.100 s/);
    expect(r.out).toMatch(/imported sample hit-two/);
    expect(r.out).toMatch(/warning: broken.wav:/);
    expect(r.out).toMatch(/2 samples as group g\d+/);
    expect(sc(['sample', 'list', proj]).out.split('\n').filter(Boolean)).toHaveLength(2);
    expect(sc(['sample', 'import', proj, dir]).out).toMatch(/already in the project: sample Hit_One/);
    expect(sc(['sample', 'import', proj, dir, 'as=x']).err).toMatch(/names one file/);
    // the audio is in the store, the names are .sample files written from the tape
    expect(readdirSync(join(proj, 'samples')).sort()).toEqual(['Hit_One.sample', 'hit-two.sample', 'objects']);
  });

  it('--help lists the new commands', () => {
    for (const [cmd, text] of [['measure', 'ONE process'], ['normalize', 'target=<LUFS>'], ['import', '--classic'], ['check', 'loudness class']] as const) {
      expect(sc([cmd, '--help']).out, cmd).toContain(text);
    }
  });
});
