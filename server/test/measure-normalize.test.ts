// What `measure` says agrees with the exported file, and `normalize` reaches a target (or says why not):
// a classic sound is measured as its WAV holds it (trunc(s x 32000) of 32768), a sparse or quiet layered
// sound gets the rest of the level as gain in front of a master limiter, which holds its peaks, a classic sound stops
// at the volume where it would clip.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyze, decodeWav, integratedLoudness, type LayeredSound } from '@soundclaw/core';
import { ProjectError, measureJson, normalizeCommands, type Writer } from '../src/index.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
const claude = 'agent:claude';
beforeEach(() => { f = fixture(); });
afterEach(() => f.clean());
const run = (commands: string, w: Writer = f.w) => { const r = w.run({ commands, by: claude }); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r; };

/** The numbers of the exported WAV, read back as floats the way any other tool reads a 16-bit file. */
function exportedNumbers(id: string): { lufs: number; truePeakDb: number; peak: number } {
  const wav = decodeWav(f.w.wavOf(id));
  const x = Float32Array.from(wav.data, (v) => v / 32768);
  const a = analyze(x);
  return { lufs: integratedLoudness(x), truePeakDb: a.truePeakDb, peak: a.peak };
}

describe('measure agrees with the exported file', () => {
  it('a classic sound is measured at the exported scale: loudness, true peak and peak within 0.05 dB of the WAV', () => {
    run('sound new a voice=classic preset=pickup seed=3; sound set a volume=0.5; sound new b voice=classic preset=explosion seed=2; sound set b volume=0.4');
    for (const id of ['a', 'b']) {
      const m = f.w.measure(id).analysis;
      const e = exportedNumbers(id);
      expect(Math.abs(m.lufs - e.lufs), `${id} loudness`).toBeLessThan(0.05);
      expect(Math.abs(m.truePeakDb - e.truePeakDb), `${id} true peak`).toBeLessThan(0.05);
      expect(Math.abs(20 * Math.log10(m.peak / e.peak)), `${id} peak`).toBeLessThan(0.05);
    }
  });
  it('is 0.2 dB under what the float render says (the exported scale of 32000 of 32768)', () => {
    run('sound new a voice=classic preset=pickup seed=3; sound set a volume=0.5');
    const float = integratedLoudness(f.w.render('a').channels);
    expect(float - f.w.measure('a').analysis.lufs).toBeGreaterThan(0.15);
    expect(float - f.w.measure('a').analysis.lufs).toBeLessThan(0.3);
  });
  it('agrees with ffmpeg ebur128 on the exported file (when ffmpeg is installed)', () => {
    run('sound new a voice=classic; sound set a wave=sine attack=0.05 sustain=0.5 decay=0.4 freq=0.3 volume=0.15');
    expect(f.w.measure('a').analysis.duration).toBeGreaterThan(0.8); // BS.1770 needs 400 ms blocks
    const dir = mkdtempSync(join(tmpdir(), 'soundclaw-ebur-'));
    try {
      const file = join(dir, 'a.wav');
      writeFileSync(file, f.w.wavOf('a'));
      const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
      const m = [...`${r.stderr ?? ''}`.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1);
      if (r.error || !m) return;
      expect(Math.abs(f.w.measure('a').analysis.lufs - Number(m[1]))).toBeLessThan(0.15); // ffmpeg prints one decimal
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('a clipped classic sound is still caught by the clip check', () => {
    run('sound new a voice=classic preset=explosion seed=2; sound set a volume=1');
    const clip = f.w.measure('a').checks.find((c) => c.name === 'clip')!;
    expect(clip.pass).toBe(false);
    expect(clip.value).toMatch(/at full scale/);
  });
  it('the JSON of measure has the same numbers', () => {
    run('sound new a voice=classic preset=pickup seed=3; sound set a volume=0.5');
    const j = JSON.parse(measureJson(f.w, ['a']).json);
    expect(Math.abs(j.sounds[0].numbers.lufs - exportedNumbers('a').lufs)).toBeLessThan(0.05);
  });
});

describe('normalize', () => {
  const SPARSE = 'sound new s voice=layered seed=1\nlayer add s osc wave=sine freq=440 dur=1 gain=0.02\nenv s 1.amp "0:0 0.01:1 0.9:0@exp"';

  it('reaches the target of a quiet layered sound that gain 4 cannot: the rest is gain in front of a master limiter', () => {
    run(SPARSE);
    const before = f.w.measure('s').analysis.lufs;
    expect(before).toBeLessThan(-40);
    const n = normalizeCommands(f.w, ['s'], 'target=-16');
    expect(n.commands).toMatch(/sound set s loudness=-16/);
    expect(n.commands).toMatch(/sound set s gain=4/);
    expect(n.commands).toMatch(/fx add s limit ceiling=-1 gain=[\d.]+/);
    expect(n.notes.join('\n')).toMatch(/gain 4 was not enough; a limiter added to the master chain \(ceiling -1 dB\) now takes \+[\d.]+ dB before it/);
    run(n.commands);
    const s = f.w.sound('s') as LayeredSound;
    expect(s.gain).toBe(4);
    expect(s.out ?? 0).toBe(0);
    expect(s.master.at(-1)!.kind).toBe('limit');
    expect(s.master.at(-1)!.p.gain).toBeGreaterThan(0);
    expect(Math.abs(f.w.measure('s').analysis.lufs - -16)).toBeLessThan(0.1);
    expect(f.w.measure('s').checks.find((c) => c.name === 'loudness')!.pass).toBe(true);
    // the limiter's gain is plain data: it survives a restart, and is taken back first when normalizing to something quieter
    expect((f.reopen().sound('s') as LayeredSound).master.at(-1)!.p.gain).toBe(s.master.at(-1)!.p.gain);
    run(normalizeCommands(f.w, ['s'], 'target=-30').commands);
    const quiet = f.w.sound('s') as LayeredSound;
    expect(Math.abs(f.w.measure('s').analysis.lufs - -30)).toBeLessThan(0.1);
    expect(Number(quiet.master.at(-1)!.p.gain)).toBeLessThan(Number(s.master.at(-1)!.p.gain)); // the limiter's gain went first
    expect(quiet.gain).toBe(4);
  });
  it('a sparse, high-crest sound reaches a loud target without clipping: the limiter holds what the gain makes', () => {
    run('sound new k voice=layered seed=1\nlayer add k osc wave=white dur=0.15 gain=0.01\nenv k 1.amp "0:0 0.002:1 0.12:0@exp"\nsound set k duration=0.6');
    const n = normalizeCommands(f.w, ['k'], 'target=-16');
    run(n.commands);
    const m = f.w.measure('k');
    expect(Math.abs(m.analysis.lufs - -16)).toBeLessThan(0.2);
    expect(m.checks.find((c) => c.name === 'clip')!.pass).toBe(true);
    expect(m.checks.find((c) => c.name === 'loudness')!.pass).toBe(true);
  });
  it('an existing master limiter takes the gain, and so does one that is not last: a new one is added at the end', () => {
    run(SPARSE + '\nfx add s limit ceiling=-3');
    run(normalizeCommands(f.w, ['s'], 'target=-16').commands);
    let s = f.w.sound('s') as LayeredSound;
    expect(s.master).toHaveLength(1);
    expect(s.master[0]!.p.ceiling).toBe(-3);
    expect(Number(s.master[0]!.p.gain)).toBeGreaterThan(0);
    run('sound new t voice=layered seed=1\nlayer add t osc wave=sine freq=440 dur=1 gain=0.02\nenv t 1.amp "0:0 0.01:1 0.9:0@exp"\nfx add t limit ceiling=-3\nfx add t reverb mix=0.1');
    run(normalizeCommands(f.w, ['t'], 'target=-16').commands);
    s = f.w.sound('t') as LayeredSound;
    expect(s.master.map((x) => x.kind)).toEqual(['limit', 'reverb', 'limit']);
  });
  it('says plainly when the target cannot be reached (a click in a second: the limiter holds its peak), and changes nothing', () => {
    run('sound new s voice=layered seed=1\nlayer add s osc wave=white dur=0.01 gain=0.05\nenv s 1.amp "0:0 0.0005:1 0.004:0@exp"\nsound set s duration=1');
    const before = f.w.tape().length;
    expect(() => normalizeCommands(f.w, ['s'], 'target=-16')).toThrow(ProjectError);
    expect(() => normalizeCommands(f.w, ['s'], 'target=-16')).toThrow(/s cannot reach -16 LUFS: at gain \d.* and a limiter gain of \+[\d.]+ dB.*it measures -[\d.]+ LUFS, [\d.]+ LU under/);
    expect(f.w.tape().length).toBe(before);
  });
  it('a classic sound goes to its target by volume but stops where it would clip, and says how far short it is', () => {
    run('sound new a voice=classic preset=explosion seed=2');
    const n = normalizeCommands(f.w, ['a'], 'target=-3');
    const v = Number(/volume=([\d.]+)/.exec(n.commands)![1]);
    expect(v).toBeLessThan(1);
    expect(n.notes.join('\n')).toMatch(/a: volume stops at [\d.]+, where the sound would start to clip; it is [\d.]+ LU under the target -3/);
    expect(f.w.measure('a').checks.find((c) => c.name === 'clip')!.pass).toBe(false); // at the volume it came with it clips
    run(n.commands);
    expect(f.w.measure('a').checks.find((c) => c.name === 'clip')!.pass).toBe(true); // at the one normalize set it does not
  });
});
