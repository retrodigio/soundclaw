// `check` for a sampled instrument and its key-map view: each fault is found on a fixture built to have it.

import { describe, expect, it } from 'vitest';
import { Library, SAMPLE_RATE, applyCommand, checkInstrument, instrumentCheckLines, keymapView, lookupInstrument, parse, sinRad, type SampleBank, type SampleData } from '../src/index.ts';

const SR = SAMPLE_RATE;
const TAU = 6.283185307179586;

function tone(hz: number, secs: number, level = 0.5, extra: Partial<SampleData> = {}): SampleData {
  const n = Math.round(secs * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = level * (sinRad(TAU * hz * (i / SR)) + 0.3 * sinRad(TAU * 2 * hz * (i / SR)));
  return { rate: SR, data: x, ...extra };
}
const bankOf = (d: Record<string, SampleData>): SampleBank => ({ get: (n) => d[n], hash: (n) => (d[n] ? `t-${n}` : undefined) });

function inst(script: string) {
  const p = parse(script);
  if (p.errors.length) throw new Error(p.errors[0]!.message);
  const l = new Library();
  for (const c of p.commands) applyCommand(l, c);
  return lookupInstrument(l, 'i')!;
}

const A3 = 220, A4 = 440;
const data = { a3: tone(A3, 1), a4: tone(A4, 1), a4loud: tone(A4, 1, 0.5 * 4), a4flat: tone(A4 * 1.03, 1) };
const bank = bankOf(data);
const GOOD = 'instrument new i kind=zones\ninstrument set i range=A2-A5\ninstrument zone add i sample=a3 root=A3 keys=A2-D4\ninstrument zone add i sample=a4 root=A4 keys=D#4-A5';

describe('instrument check', () => {
  it('passes a key-map with no faults', () => {
    const r = checkInstrument(inst(GOOD), bank);
    expect(r.findings.filter((f) => f.severity === 'fail')).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.zones.map((z) => z.pitchCents)).toEqual([expect.any(Number), expect.any(Number)]);
    expect(Math.abs(r.zones[0]!.pitchCents!)).toBeLessThan(10);
    expect(instrumentCheckLines(r)[0]).toMatch(/^i: pass, 2 zones/);
  });

  it('finds keys inside the range with no zone, and velocities with no zone', () => {
    const r = checkInstrument(inst('instrument new i kind=zones\ninstrument set i range=A2-A5\ninstrument zone add i sample=a3 root=A3 keys=A2-C4\ninstrument zone add i sample=a4 root=A4 keys=E4-A4 vel=1-90'), bank);
    const cov = r.findings.filter((f) => f.check === 'coverage');
    expect(cov.map((f) => f.message).join('\n')).toMatch(/keys C#4-D#4 have no zone/);
    expect(cov.map((f) => f.message).join('\n')).toMatch(/keys A#4-A5 have no zone/);
    expect(cov.map((f) => f.message).join('\n')).toMatch(/E4-A4 have no zone for velocities 91-127/);
    expect(r.pass).toBe(false);
  });

  it('finds a zone more than 10 cents off its root and says what tune would fix it', () => {
    const r = checkInstrument(inst('instrument new i kind=zones\ninstrument zone add i sample=a4flat root=A4 keys=A3-A5'), bank);
    const f = r.findings.find((x) => x.check === 'pitch')!;
    expect(f.severity).toBe('fail');
    expect(f.message).toMatch(/sounds \+\d+ cents from its root A4/);
    expect(f.message).toMatch(/tune=-\d+/);
    // with the tune it passes
    const fixed = checkInstrument(inst('instrument new i kind=zones\ninstrument zone add i sample=a4flat root=A4 tune=-51 keys=A3-A5'), bank);
    expect(fixed.findings.filter((x) => x.check === 'pitch')).toEqual([]);
  });

  it('by pitch class when the instrument says so', () => {
    const octave = bankOf({ hi: tone(A4 * 2, 1) });
    const full = checkInstrument(inst('instrument new i kind=zones\ninstrument zone add i sample=hi root=A4 keys=A4-A4'), octave);
    expect(full.findings.some((x) => x.check === 'pitch')).toBe(true);
    const cls = checkInstrument(inst('instrument new i kind=zones\ninstrument set i pitch-check=class\ninstrument zone add i sample=hi root=A4 keys=A4-A4'), octave);
    expect(cls.findings.some((x) => x.check === 'pitch')).toBe(false);
  });

  it('finds a level step of more than 3 LU between neighbours, and between velocity layers', () => {
    const r = checkInstrument(inst('instrument new i kind=zones\ninstrument zone add i sample=a3 root=A3 keys=A2-D4\ninstrument zone add i sample=a4loud root=A4 keys=D#4-A5'), bank);
    expect(r.findings.find((f) => f.check === 'level')!.message).toMatch(/neighbouring zones 1 and 2 differ by \d+\.\d LU/);
    const v = checkInstrument(inst('instrument new i kind=zones\ninstrument zone add i sample=a4 root=A4 keys=A3-A5 vel=1-60\ninstrument zone add i sample=a4loud root=A4 keys=A3-A5 vel=61-127'), bank);
    expect(v.findings.find((f) => f.check === 'level')!.message).toMatch(/velocity-layer zones/);
  });

  it('finds a looped zone whose seam clicks, and a note far from its root', () => {
    const bad = tone(A3, 1, 0.5, { loop: [3000, 20000] });
    const withLoop = bankOf({ a3: bad });
    const r = checkInstrument(inst('instrument new i kind=zones\ninstrument zone add i sample=a3 root=A3 keys=A1-A5'), withLoop);
    expect(r.findings.some((f) => f.check === 'loop-seam')).toBe(true);
    const d = r.findings.find((f) => f.check === 'distance')!;
    expect(d.severity).toBe('warn');
    expect(d.message).toMatch(/semitones from its root A3/);
  });

  it('finds round-robin takes that are the same, and a release zone louder than its attack', () => {
    const same = checkInstrument(inst('instrument new i kind=zones\ninstrument zone add i sample=a4 root=A4 keys=A4-A4 rr=1/2\ninstrument zone add i sample=a4 root=A4 keys=A4-A4 rr=2/2'), bank);
    expect(same.findings.find((f) => f.check === 'round-robin')!.message).toMatch(/too alike/);
    const rel = checkInstrument(inst('instrument new i kind=zones\ninstrument zone add i sample=a4 root=A4 keys=A3-A5\ninstrument zone add i sample=a4loud root=A4 keys=A3-A5 trigger=release'), bank);
    expect(rel.findings.find((f) => f.check === 'release')!.message).toMatch(/louder than the attack/);
  });

  it('names a zone whose sample is not in the project', () => {
    const r = checkInstrument(inst('instrument new i kind=zones\ninstrument zone add i sample=gone root=A4 keys=A3-A5'), bank);
    expect(r.findings[0]).toMatchObject({ check: 'samples', severity: 'fail', zones: [1] });
  });
});

describe('key-map view', () => {
  it('draws a PNG for a key-map, with and without the check', () => {
    const i = inst(GOOD + '\ninstrument zone add i sample=a4 root=A4 keys=A4-A4 trigger=release');
    const plain = keymapView(i);
    const checked = keymapView(i, checkInstrument(i, bank));
    for (const img of [plain, checked]) {
      expect(img.width).toBe(1000);
      expect([...img.png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
    expect(Buffer.from(plain.png).equals(Buffer.from(checked.png))).toBe(false);
    // the same input draws the same bytes
    expect(Buffer.from(keymapView(i, checkInstrument(i, bank)).png).equals(Buffer.from(checked.png))).toBe(true);
  });

  it('draws the hits of a kit in their own rows', () => {
    const i = inst('instrument new i kind=zones\ninstrument set i pitched=no\ninstrument zone add i sample=a3 root=C3 hit=kick loopmode=oneshot\ninstrument zone add i sample=a4 root=C3 hit=snare loopmode=oneshot choke=1');
    const img = keymapView(i);
    expect(img.height).toBeGreaterThan(keymapView(inst(GOOD)).height - 1);
  });
});
