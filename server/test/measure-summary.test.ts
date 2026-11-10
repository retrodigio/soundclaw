// `measure --json` has two schemas (a sound's `numbers`, a sample's `measure`); both also carry one `summary` with the same keys and units,
// and a bell-like pitch is flagged inharmonic with a lowered confidence.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeWavChannels } from '@soundclaw/core';
import { describeJson, measureJson } from '../src/index.ts';
import { sampleMeasureJson } from '../src/sampleview.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
beforeEach(() => {
  f = fixture();
  const lines = ['sound new bell voice=layered seed=1'];
  [[700, 0.2], [1932, 0.5], [3780, 0.35], [6251, 0.2]].forEach(([hz, g], i) => {
    lines.push(`layer add bell osc wave=sine freq=${hz} dur=2 gain=${g}`, `env bell ${i + 1}.amp "0:0 0.003:1 ${1.8 - i * 0.3}:0@exp"`);
  });
  lines.push('sound new tone voice=layered seed=2', 'layer add tone osc wave=saw freq=220 dur=1 gain=0.4', 'env tone 1.amp "0:0 0.01:1 0.9:0.6 1:0"');
  const r = f.w.run({ commands: lines.join('\n'), by: 'agent:claude' });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
});
afterEach(() => f.clean());

type Summary = Record<string, unknown>;
const soundSummary = (id: string): Summary => (JSON.parse(measureJson(f.w, [id]).json) as { sounds: { summary: Summary }[] }).sounds[0]!.summary;

describe('the shared summary of measure --json', () => {
  it('a sound and a sample have the same keys; the sound keeps numbers and the sample keeps measure', () => {
    const file = join(f.root, 'tone.wav');
    writeFileSync(file, encodeWavChannels([f.w.render('tone').samples]));
    const doc = JSON.parse(measureJson(f.w, ['tone']).json) as { sounds: { numbers: { attack: number; centroid: { mean: number } }; summary: Summary }[] };
    const sample = sampleMeasureJson(f.w, file) as { measure: { attackMs: number; centroid: number; pitch: { hz: number } }; summary: Summary };
    const a = doc.sounds[0]!.summary, b = sample.summary;
    expect(Object.keys(a)).toEqual(Object.keys(b));
    expect(Object.keys(a)).toEqual(expect.arrayContaining(['durationS', 'lufs', 'peakDb', 'truePeakDb', 'rmsDb', 'centroidHz', 'flatness', 'attackMs', 'pitchHz', 'pitchNote', 'pitchConfidence', 'harmonicity', 'inharmonic', 'pitched', 'onsets', 'silent']));
    // existing keys are untouched
    expect(doc.sounds[0]!.numbers.centroid.mean).toBeGreaterThan(0);
    expect(sample.measure.pitch.hz).toBeGreaterThan(200);
    // the same units: attack in ms and brightness in Hz on both
    expect(Math.abs((a.attackMs as number) - doc.sounds[0]!.numbers.attack * 1000)).toBeLessThan(0.06);
    expect(a.centroidHz).toBe(doc.sounds[0]!.numbers.centroid.mean);
    expect(b.attackMs).toBeCloseTo(sample.measure.attackMs, 3);
    expect(b.centroidHz).toBeCloseTo(sample.measure.centroid, 2);
    // and agree with each other about the same audio (up to the 16 bits of the file)
    expect(Math.abs((a.durationS as number) - (b.durationS as number))).toBeLessThan(0.01);
    expect(Math.abs((a.lufs as number) - (b.lufs as number))).toBeLessThan(0.3);
    expect(Math.abs((a.centroidHz as number) / (b.centroidHz as number) - 1)).toBeLessThan(0.05);
    expect(Math.abs((a.pitchHz as number) / (b.pitchHz as number) - 1)).toBeLessThan(0.03);
    expect(a.pitchNote).toBe(b.pitchNote);
    expect(a.inharmonic).toBe(false);
    expect(b.inharmonic).toBe(false);
  });
  it('describe --json of a sound carries it too, and a sound with no loudness has nulls', () => {
    const j = JSON.parse(describeJson(f.w, 'tone')) as { summary: Summary };
    expect(j.summary.pitchNote).toBe('A3');
    f.w.run({ commands: 'sound new quiet voice=layered seed=3\nlayer add quiet osc wave=sine freq=440 dur=0.1 gain=0.000001', by: 'agent:claude' });
    const q = soundSummary('quiet');
    expect(q.lufs).toBeNull();
  });
  it('a bell is flagged inharmonic, in the sound and in a sample of it, and a note is not', () => {
    const s = soundSummary('bell');
    expect(s.inharmonic).toBe(true);
    expect(s.harmonicity as number).toBeLessThan(0.6);
    const file = join(f.root, 'bell.wav');
    writeFileSync(file, encodeWavChannels([f.w.render('bell').samples]));
    const sm = (sampleMeasureJson(f.w, file) as { summary: Summary }).summary;
    expect(sm.inharmonic).toBe(true);
    expect(sm.pitched).toBe(false);
    expect(sm.pitchConfidence as number).toBeLessThan(0.8);
    expect(soundSummary('tone').inharmonic).toBe(false);
  });
});
