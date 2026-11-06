// The agent's ears and the classic voice through the writer: numbers and checks, views, describe,
// export (wav, patch, csv), import (csv with NA, patch text), the project style, and `work done`
// needing the sound's checks to pass.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLASSIC_FIELDS, classicWav, makePatch, parseCsv, parsePatch, renderExact, type ClassicSound } from '@soundclaw/core';
import { Writer, agentWork, checkText, describeText, exportFormat, formatExportFiles, importCommands, loadProject, personRequest, renderText, viewSound } from '../src/index.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
const claude = 'agent:claude';
const GOOD = 'sound new beep voice=classic; sound set beep wave=sine attack=0.05 sustain=0.3 decay=0.4 freq=0.3 volume=0.15';
beforeEach(() => { f = fixture(); });
afterEach(() => f.clean());
const run = (commands: string) => { const r = f.w.run({ commands, by: claude }); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r; };

describe('numbers and checks through the writer', () => {
  it('measures a classic sound once per distinct render and says how it did', () => {
    run(GOOD);
    const m = f.w.measure('beep');
    expect(m.checks.map((c) => c.pass)).toEqual([true, true, true, true, true]);
    expect(f.w.measure('beep')).toBe(m);
    run('sound set beep volume=0.6');
    expect(f.w.measure('beep')).not.toBe(m);
    expect(f.w.measure('beep').checks.find((c) => c.name === 'loudness')!.pass).toBe(false);
  });

  it('every run result ends each sound with its check summary line', () => {
    const r = run(GOOD);
    expect(r.touched).toEqual(['beep']);
    const text = checkText(f.w, ['beep']).text;
    expect(text).toMatch(/^beep: PASS \(5\/5 checks pass\)/);
  });

  it('render ends with the check summary, after the numbers and the description', () => {
    run(GOOD + '; sound set beep volume=0.6');
    const t = renderText(f.w, 'beep', 'head');
    const lines = t.split('\n');
    expect(lines[0]).toBe('head');
    expect(lines[1]).toMatch(/^0\.\d\d s, tonal/);
    expect(t).toContain('duration 0.');
    expect(lines.at(-1)).toMatch(/^checks: \d\/5 pass; failing: .*loudness /);
  });

  it('describe is words from the numbers, then the numbers, then the checks', () => {
    run(GOOD);
    const t = describeText(f.w, 'beep');
    expect(t).toMatch(/^beep: \d\.\d\d s, tonal and \w[\w -]* \(centroid about/);
    expect(t).toContain('brightness (spectral centroid) mean');
    expect(t.split('\n').at(-1)).toBe('checks: 5/5 pass');
  });

  it('check lists every sound with scores, thresholds and flagged ranges; names an unknown sound', () => {
    run(GOOD + '; sound new zap voice=classic preset=laser seed=1');
    const c = checkText(f.w, []);
    expect(c.pass).toBe(false);
    expect(c.text).toMatch(/^beep: PASS/m);
    expect(c.text).toMatch(/^zap: FAIL/m);
    expect(c.text).toMatch(/flagged 0\.\d{4}-0\.\d{4} s: /);
    expect(c.text).toMatch(/1 sound of 2 pass all of clip, loudness, dc, click, tail \(target -16 LUFS ±1, true peak at most -0.1 dBTP; the default style\)/);
    expect(() => checkText(f.w, ['nope'])).toThrow(/no sound 'nope'/);
    expect(() => checkText(fixture().w, [])).toThrow(/no sounds to check/);
  });

  it('the project style sets the targets', () => {
    run(GOOD);
    const file = join(f.dir, 'project.json');
    const j = JSON.parse(readFileSync(file, 'utf8'));
    j.style = { loudnessTarget: -30, loudnessTolerance: 2 };
    writeFileSync(file, JSON.stringify(j));
    const w = new Writer(loadProject(f.dir));
    expect(w.style).toMatchObject({ loudnessTarget: -30, loudnessTolerance: 2, truePeakMax: -0.1 });
    const c = checkText(w, ['beep']);
    expect(c.pass).toBe(false);
    expect(c.text).toContain('held to -30.0 LUFS ±2');
    expect(c.text).toContain('from the project style');
    j.style = { loudness: 1 };
    writeFileSync(file, JSON.stringify(j));
    expect(() => new Writer(loadProject(f.dir))).toThrow(/unknown key 'loudness'/);
  });
});

describe('work done needs the checks to pass', () => {
  const ask = () => personRequest(f.w, 'human:ana', { action: 'request', kind: 'change', sound: 'beep', note: 'softer' });

  it('refuses while a check fails, naming it, and finishes once the sound is fixed', () => {
    run(GOOD + '; sound set beep volume=0.6');
    ask();
    agentWork(f.w, claude, { action: 'next' });
    expect(() => agentWork(f.w, claude, { action: 'done', text: 'softer' })).toThrow(/r1 is not done: beep's checks fail \(.*loudness: -\d+\.\d LUFS \(\d+\.\d LU too loud\)/);
    run('sound set beep volume=0.15');
    expect(agentWork(f.w, claude, { action: 'done', text: 'volume 0.6 → 0.15' }).request).toMatchObject({ state: 'done' });
  });

  it('a tone sound, which has no fade, cannot be finished: its tail is cut', () => {
    run('sound new beep; sound set beep volume=0.15');
    ask();
    agentWork(f.w, claude, { action: 'next' });
    expect(() => agentWork(f.w, claude, { action: 'done', text: 'x' })).toThrow(/checks fail/);
  });
});

describe('views', () => {
  it('saves a PNG under .cache/views and prints the numbers; compare adds distances', () => {
    run(GOOD + '; sound new zap voice=classic preset=laser seed=1');
    for (const kind of ['wave', 'spec', 'pitch'] as const) {
      const v = viewSound(f.w, 'beep', kind);
      expect(v.file).toContain(join('.cache', 'views', `beep-${kind}-`));
      expect(Array.from(readFileSync(v.file).subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);
      expect(v.text).toContain(`${kind} view saved to`);
      expect(v.text).toContain('loudness');
    }
    const c = viewSound(f.w, 'beep', 'compare', { other: 'zap', out: join(f.root, 'cmp.png') });
    expect(c.file).toBe(join(f.root, 'cmp.png'));
    expect(c.text).toMatch(/^zap compared with beep/m);
    expect(c.text).toContain('spectral distance');
    expect(() => viewSound(f.w, 'beep', 'compare')).toThrow(/second sound/);
    expect(() => viewSound(f.w, 'nope', 'wave')).toThrow(/no sound 'nope'/);
  });
});

describe('export', () => {
  beforeEach(() => { run(GOOD + '; sound new zap voice=classic preset=laser seed=2; sound set zap seed=99; sound new tone1'); });

  it('wav: classic sounds as the engine\'s pre-rendered WAV (trunc × 32000), a tone as before', () => {
    const r = exportFormat(f.w, ['beep', 'tone1'], 'wav', join(f.root, 'out'));
    expect(r.files.map((x) => x.id)).toEqual(['beep', 'tone1']);
    const beep = readFileSync(join(f.root, 'out', 'beep.wav'));
    expect(Buffer.compare(beep, Buffer.from(classicWav(renderExact(f.w.sound('beep')))))).toBe(0);
    expect(formatExportFiles(r)).toMatch(/exported 2 sounds as wav\n  beep: .*beep\.wav \(\d+ bytes, 0\.\d{3} s, peak 0\.\d{3}, samples [0-9a-f]{12}\)/);
  });

  it('patch: one single-patch text per classic sound (a seed travels in the named form), reading back to the same sound', () => {
    const r = exportFormat(f.w, [], 'patch', join(f.root, 'out'));
    expect(r.files.map((x) => x.id)).toEqual(['beep', 'zap']);
    expect(r.notes).toEqual(['skipped tone1 (not a classic sound)']);
    const beep = readFileSync(join(f.root, 'out', 'beep.sfxr'), 'utf8');
    expect(beep).toMatch(/^1\n[-\d.e+,]+\n$/);
    expect(parsePatch(beep).patch).toEqual((f.w.sound('beep') as ClassicSound).patch);
    const zap = readFileSync(join(f.root, 'out', 'zap.sfxr'), 'utf8');
    expect(zap).toMatch(/^1\nwave=\d,.*,seed=99\n$/);
    expect(parsePatch(zap).patch).toEqual((f.w.sound('zap') as ClassicSound).patch);
    expect(() => exportFormat(f.w, ['tone1'], 'patch')).toThrow(/is a tone sound: a patch is for classic sounds/);
  });

  it('csv: one synth.csv with a row per classic sound, reading back to the same patches', () => {
    const r = exportFormat(f.w, [], 'csv', join(f.root, 'out'));
    expect(r.notes).toEqual(['skipped tone1 (not a classic sound)']);
    const rows = parseCsv(readFileSync(join(f.root, 'out', 'synth.csv'), 'utf8'));
    expect(rows.map((x) => x.id)).toEqual(['beep', 'zap']);
    for (const row of rows) expect(row.patch).toEqual((f.w.sound(row.id) as ClassicSound).patch);
    expect(() => exportFormat(f.w, ['tone1'], 'csv')).toThrow(/csv is for classic sounds/);
  });
});

describe('import', () => {
  const CSV = 'id,wave,freq,decay,volume,seed\ncoin,square,0.6,0.2,0.4,\nboom,noise,NA,0.5,0.6,77\n';

  it('makes a classic sound per csv row (NA and empty cells take the defaults), as one undo group', () => {
    const { commands, ids } = importCommands(CSV, null);
    expect(ids).toEqual(['coin', 'boom']);
    const r = run(commands);
    expect(r.group).toBe('g1');
    expect((f.w.sound('coin') as ClassicSound).patch).toEqual(makePatch({ wave: 0, freq: 0.6, decay: 0.2, volume: 0.4 }));
    expect((f.w.sound('boom') as ClassicSound).patch).toEqual(makePatch({ wave: 3, decay: 0.5, volume: 0.6, seed: 77 }));
    run('undo');
    expect(f.w.sounds()).toEqual([]);
  });

  it('reads a csv file, or a patch file named for its sound, or patch text with --id', () => {
    const csv = join(f.root, 'synth.csv');
    writeFileSync(csv, CSV);
    expect(importCommands(csv, null).ids).toEqual(['coin', 'boom']);
    writeFileSync(join(f.root, 'Power Up.sfxr'), '1\n0,0,0.3,0.5');
    expect(importCommands(join(f.root, 'Power Up.sfxr'), null).ids).toEqual(['power_up']);
    expect(importCommands('wave=saw,freq=0.5', 'zap').commands).toContain('sound new zap voice=classic');
    expect(importCommands('1\n1,0.1,0.2,0.3', 'a').commands).toContain('sound patch a "wave=1,attack=0.1,sustain=0.2,punch=0.3');
    expect(() => importCommands('wave=saw', null)).toThrow(/needs a sound id/);
    expect(() => importCommands('wave=saw,speed=1', 'a')).toThrow(/unknown parameter 'speed'/);
    expect(() => importCommands('id,freq\nBad Id,1\n', null)).toThrow(/'Bad Id' is not a sound id/);
    expect(() => importCommands(CSV, 'one')).toThrow(/--id names one sound/);
  });

  it('a name that is already taken applies nothing', () => {
    run('sound new coin');
    const { commands } = importCommands(CSV, null);
    const r = f.w.run({ commands, by: claude });
    expect(r.ok).toBe(false);
    expect(f.w.sounds().map((s) => s.id)).toEqual(['coin']);
  });
});

describe('the classic parameters are all there', () => {
  it('a sound serialises its 25 values and loads back from the tape', () => {
    run('sound new a voice=classic preset=hit seed=5; sound set a seed=12');
    const text = readFileSync(join(f.dir, 'sounds', 'a.sfx'), 'utf8');
    for (const fld of CLASSIC_FIELDS) expect(text).toContain(`\n${fld.name} `);
    expect(text).toMatch(/\nseed 12\nstatus draft\n$/);
    expect((f.reopen().sound('a') as ClassicSound).patch.seed).toBe(12);
  });
});
