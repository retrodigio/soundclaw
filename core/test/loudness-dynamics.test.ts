// Fixes from the first large use: loudness classes, dynamics, exponential decays and the automatic length,
// the bursts envelope, new limits, loops of any length, copy / rename / remove and the id rules.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLASSES, DEFAULT_STYLE, Library, MAX_BURSTS, analyze, applyCommand, burstsEnv, classTable, curveValue, integratedLoudness, loudnessFor, parse, renderChannels, resolveStyle, runChecks,
  seamNumbers, serializeSound, setTarget, soundStyle, type LayeredSound, type Style,
} from '../src/index.ts';
import { build, layered, render } from './layered-helpers.ts';

const rms = (x: Float32Array | Float64Array): number => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
const db = (v: number): number => 20 * Math.log10(v);

describe('loudness classes', () => {
  it('starts with the named classes, and the project style adds or replaces them', () => {
    const t = classTable(DEFAULT_STYLE);
    expect(Object.keys(t).sort()).toEqual(['ambience', 'foley', 'impact', 'music', 'music-sting', 'standard', 'stinger', 'ui', 'voice']);
    expect(t.standard).toEqual({ target: -16, tolerance: 1 });
    expect(t.ui!.target).toBeLessThan(t.foley!.target);
    expect(t.foley!.target).toBeLessThan(t.impact!.target);
    const s = resolveStyle({ loudnessClasses: { ui: { target: -30, tolerance: 4 }, boss: { target: -9 } }, defaultClass: 'foley' });
    expect(classTable(s).ui).toEqual({ target: -30, tolerance: 4 });
    expect(classTable(s).boss).toEqual({ target: -9, tolerance: 1 });
    expect(s.defaultClass).toBe('foley');
    expect(DEFAULT_CLASSES.ui!.target).toBe(-28); // the defaults are not changed by a project
  });

  it('refuses a style with a class that is not one', () => {
    expect(() => resolveStyle({ defaultClass: 'nope' })).toThrow(/not a class/);
    expect(() => resolveStyle({ loudnessClasses: { Bad: { target: -20 } } })).toThrow(/not a class name/);
    expect(() => resolveStyle({ loudnessClasses: { x: { target: 3 } } })).toThrow(/-70 to 0/);
    expect(() => resolveStyle({ loudnessClasses: { x: 5 } })).toThrow(/target/);
    expect(() => resolveStyle({ loudnessClasses: [] })).toThrow(/object/);
  });

  it('decides a sound\'s rule: own loudness, own class, its set\'s target, its set\'s class, the default; and says why', () => {
    const lib = build('sound new a voice=classic preset=pickup seed=1\nsound new b voice=classic preset=pickup seed=2\nset new s from=a count=2 class=impact\nsound set a class=ui');
    const rule = (id: string, style: Style = DEFAULT_STYLE) => loudnessFor(lib.get(id)!, lib.sets.values(), style);
    expect(rule('a')).toMatchObject({ className: 'ui', target: -28, tolerance: 3, basis: 'class ui' });
    expect(rule('s_1')).toMatchObject({ className: 'impact', target: -14, basis: 'class impact' }); // the set's class
    expect(rule('b')).toMatchObject({ className: 'standard', target: -16, basis: 'class standard' }); // the default
    applyCommand(lib, parse('sound set a loudness=-33').commands[0]!);
    expect(rule('a')).toMatchObject({ className: 'ui', target: -33, tolerance: 3, basis: 'class ui; own loudness' });
    applyCommand(lib, parse('set retarget s -12').commands[0]!);
    expect(rule('s_2')).toMatchObject({ className: 'impact', target: -12, basis: 'class impact; target of set s' });
    applyCommand(lib, parse('sound set a loudness=auto class=none').commands[0]!);
    expect(rule('a').className).toBe('standard');
    expect(rule('a', resolveStyle({ defaultClass: 'voice' })).className).toBe('voice');
    expect(setTarget(lib.sets.get('s')!, DEFAULT_STYLE)).toBe(-12);
    applyCommand(lib, parse('set retarget s none').commands[0]!);
    expect(setTarget(lib.sets.get('s')!, DEFAULT_STYLE)).toBe(-14); // the class's target when the set has none
    expect(setTarget({ ...lib.sets.get('s')!, class: undefined }, DEFAULT_STYLE)).toBeNull();
  });

  it('a class the style lacks falls back to the default and the rule says so; a family variant is held to the target plus its offset', () => {
    const lib = build('sound new a voice=layered preset=door seed=1\nsound set a class=ui\nfamily a far as=a_far');
    const s = resolveStyle({ loudnessClasses: {} });
    delete (s.loudnessClasses as Record<string, unknown>).ui;
    expect(loudnessFor(lib.get('a')!, [], s).basis).toMatch(/class 'ui' is not in the style/);
    const far = loudnessFor(lib.get('a_far')!, [], DEFAULT_STYLE);
    expect(far.target).toBeCloseTo(-28 - 9, 5); // the copy keeps the source's class
    expect(far.basis).toMatch(/class ui; -9 LU as a far variant/);
  });

  it('the loudness check is held to the sound\'s class and names it; one tone checked against two classes', () => {
    const lib = build('sound new t\nsound set t frequency=440 duration=0.4 volume=0.05');
    const ch = renderChannels(lib.get('t')!);
    const a = analyze(ch);
    const asClass = (cls: string | undefined): ReturnType<typeof runChecks> => {
      applyCommand(lib, parse(`sound set t class=${cls ?? 'none'}`).commands[0]!);
      const s = soundStyle(lib.get('t')!, [], DEFAULT_STYLE);
      return runChecks(ch, a, s, { loudnessClass: loudnessFor(lib.get('t')!, [], DEFAULT_STYLE).basis });
    };
    const std = asClass(undefined).find((c) => c.name === 'loudness')!;
    expect(std.threshold).toBe('-16.0 LUFS ±1 (class standard)');
    expect(a.lufs).toBeLessThan(-20); // far too quiet for the standard class
    expect(std.pass).toBe(false);
    const ui = asClass('ui').find((c) => c.name === 'loudness')!;
    expect(ui.threshold).toBe('-28.0 LUFS ±3 (class ui)');
    expect(ui.pass).toBe(Math.abs(a.lufs + 28) <= 3);
  });

  it('class and loudness are written in the document and do not change the render key', async () => {
    const { renderKey } = await import('../src/index.ts');
    const lib = build('sound new a voice=classic\nsound new b voice=layered seed=2\nsound new c');
    const keys = ['a', 'b', 'c'].map((id) => renderKey(lib.get(id)!));
    for (const id of ['a', 'b', 'c']) applyCommand(lib, parse(`sound set ${id} class=voice loudness=-21`).commands[0]!);
    for (const id of ['a', 'b', 'c']) expect(serializeSound(lib.get(id)!)).toMatch(/\nclass voice\nloudness -21\n/);
    expect(['a', 'b', 'c'].map((id) => renderKey(lib.get(id)!))).toEqual(keys);
    expect(parse('sound set a class=Loud').errors[0]!.message).toMatch(/class is a loudness class name/);
    expect(parse('sound set a loudness=5').errors[0]!.message).toMatch(/LUFS from -60 to 0/);
  });
});

describe('dynamics: compress and limit', () => {
  const steady = (level: number, secs = 0.6) => `sound new s voice=layered seed=1\nlayer add s osc wave=square freq=100 dur=${secs}\nenv s 1.amp "0:${level}"\n`;
  const tailLevel = (x: Float32Array): number => Math.abs(x[Math.floor(x.length * 0.8)]!);

  it('compress: a constant 0.5 (-6 dB) over a -18 dB threshold at 4:1 is turned down by 9 dB; makeup adds back', () => {
    // a square wave of |x| = 0.5 has a constant magnitude, so the detector settles on exactly 0.5
    const plain = render(layered(steady(0.5)));
    const c = render(layered(steady(0.5) + 'fx add s compress threshold=-18 ratio=4 attack=1 release=50\n'));
    const want = 0.5 * Math.pow(10, -9 / 20);
    expect(Math.abs(c[Math.floor(c.length * 0.8)]!)).toBeCloseTo(want, 3);
    expect(Math.abs(plain[Math.floor(plain.length * 0.8)]!)).toBeCloseTo(0.5, 6);
    const m = render(layered(steady(0.5) + 'fx add s compress threshold=-18 ratio=4 attack=1 release=50 makeup=6\n'));
    expect(tailLevel(m) / tailLevel(c)).toBeCloseTo(Math.pow(10, 6 / 20), 3);
  });

  it('compress: below the threshold, or at ratio 1, the sound is untouched; the attack decides how fast the gain comes down', () => {
    const quiet = render(layered(steady(0.05) + 'fx add s compress threshold=-18 ratio=8\n'));
    expect(Math.abs(quiet[Math.floor(quiet.length * 0.8)]!)).toBeCloseTo(0.05, 6);
    const flat = render(layered(steady(0.5) + 'fx add s compress threshold=-40 ratio=1\n'));
    expect(Math.abs(flat[Math.floor(flat.length * 0.8)]!)).toBeCloseTo(0.5, 6);
    const reduction = (attack: number): number => {
      const x = render(layered(steady(0.5) + `fx add s compress threshold=-30 ratio=10 attack=${attack} release=200\n`));
      return Math.abs(x[Math.round(0.02 * 44100)]!);
    };
    expect(reduction(100)).toBeGreaterThan(reduction(1)); // a slow attack has not yet turned it down at 20 ms
  });

  it('limit: nothing goes above the ceiling; a quieter sound is left exactly as it was; the gain was down before the peak and comes back after', () => {
    const script = 'sound new s voice=layered seed=1\nlayer add s osc wave=sine freq=300 dur=0.4\nenv s 1.amp "0:0.4 0.19:0.4 0.2:3 0.205:3 0.21:0.4 0.4:0.4"\n';
    const raw = render(layered(script));
    expect(Math.max(...raw.map(Math.abs))).toBeGreaterThan(2.5);
    const lim = render(layered(script + 'fx add s limit ceiling=-3 release=40 lookahead=5\n'));
    const ceil = Math.pow(10, -3 / 20);
    expect(Math.max(...lim.map(Math.abs))).toBeLessThanOrEqual(ceil + 1e-9);
    // before the peak (at 0.2 s) by less than the look-ahead the gain is already down; long before, it is exactly 1
    const at = (t: number): number => Math.round(t * 44100);
    const ratio = (t: number): number => Math.abs(lim[at(t)]!) / Math.abs(raw[at(t)]!);
    expect(ratio(0.1)).toBeCloseTo(1, 12);
    expect(ratio(0.1999)).toBeLessThan(0.9);
    expect(ratio(0.39)).toBeGreaterThan(0.99); // released
    const under = render(layered(script.replace('3 0.205:3', '0.4 0.205:0.4') + 'fx add s limit ceiling=-3\n'));
    expect(Array.from(under)).toEqual(Array.from(render(layered(script.replace('3 0.205:3', '0.4 0.205:0.4')))));
  });

  it('limit with no look-ahead drops at once and still holds the ceiling; the master chain and a layer both take the effects', () => {
    const x = render(layered(steady(1.5) + 'fx add s limit ceiling=-6 lookahead=0 release=10\n'));
    expect(Math.max(...x.map(Math.abs))).toBeLessThanOrEqual(Math.pow(10, -6 / 20) + 1e-9);
    const y = render(layered(steady(1.5) + 'fx add s layer=1 limit ceiling=-6\nfx add s compress threshold=-20\n'));
    expect(Math.max(...y.map(Math.abs))).toBeLessThanOrEqual(Math.pow(10, -6 / 20) + 1e-9);
    expect(layered(steady(1) + 'fx add s limit ceiling=-6\n').master.map((f) => f.kind)).toEqual(['limit']);
    expect(() => build(steady(1) + 'fx add s compress ratio=40')).toThrow(/ratio must be between 1 and 20/);
    expect(() => build(steady(1) + 'fx add s limit ceiling=3')).toThrow(/ceiling must be between -24 and 0/);
  });

  it('a loud sparse sound can pass loudness without clipping once it is limited', () => {
    // a click train: high peaks, low average. Gained up to the loudness target it clips; compressed and limited it does not.
    const base = 'sound new s voice=layered seed=1\nlayer add s osc wave=white dur=1\nenv s 1.amp bursts(times=0.1,0.4,0.7 attack=0.001 decay=0.04 level=1)\n';
    const loud = layered(base + 'sound set s gain=4');
    const a1 = analyze(renderChannels(loud));
    expect(a1.truePeakDb).toBeGreaterThan(-0.1);
    const fixed = layered(base + 'sound set s gain=4\nfx add s limit ceiling=-1 release=60 lookahead=3\n');
    const a2 = analyze(renderChannels(fixed));
    expect(Math.max(...renderChannels(fixed)[0]!.map(Math.abs))).toBeLessThanOrEqual(Math.pow(10, -1 / 20) + 1e-9); // sample peaks are at the ceiling; the export limiter guards the true peak
    expect(integratedLoudness(renderChannels(fixed))).toBeGreaterThan(integratedLoudness(renderChannels(layered(base + 'sound set s gain=0.5'))) + 3);
  });
});

describe('exponential decays and the automatic length', () => {
  it('an exp curve to zero is a true exponential that is 60 dB down at the end of its segment', () => {
    expect(curveValue(1, 0, 0, 'exp')).toBe(1);
    expect(curveValue(1, 0, 0.5, 'exp')).toBeCloseTo(Math.pow(10, -1.5), 9);
    expect(curveValue(1, 0, 1, 'exp')).toBeCloseTo(0.001, 9);
    expect(curveValue(-2, 0, 1, 'exp')).toBeCloseTo(-0.002, 9);
    // the other exp cases are as they were: geometric between values of one sign, and a rise from 0
    expect(curveValue(100, 400, 0.5, 'exp')).toBeCloseTo(200, 6);
    expect(curveValue(0, 1, 1, 'exp')).toBeCloseTo(1, 12);
  });

  it('test: a 2.6 s sine bell with 0:0 0.002:1 2.6:0@exp passes every check with duration=auto', () => {
    const s = layered('sound new s voice=layered seed=1\nlayer add s osc wave=sine freq=523 dur=2.6\nenv s 1.amp "0:0 0.002:1 2.6:0@exp"\nsound set s gain=0.3\n');
    expect(s.duration).toBeNull();
    const ch = renderChannels(s);
    expect(ch[0]!.length / 44100).toBeGreaterThan(2.55);
    expect(ch[0]!.length / 44100).toBeLessThanOrEqual(2.61);
    const a = analyze(ch);
    const checks = runChecks(ch, a, { ...DEFAULT_STYLE, loudnessTarget: Math.round(a.lufs), loudnessTolerance: 1 });
    const failing = checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.value}`);
    expect(failing).toEqual([]);
    const tail = checks.find((c) => c.name === 'tail')!;
    expect(tail.pass).toBe(true);
  });

  it('duration=auto ends the sound where it is 60 dB down, inside a layer\'s source too; a short run at the end is left alone', () => {
    const s = layered('sound new s voice=layered seed=1\nlayer add s osc wave=sine freq=300 dur=3\nenv s 1.amp "0:1 0.5:0@exp"\n');
    const x = render(s);
    expect(x.length / 44100).toBeGreaterThan(0.45);
    expect(x.length / 44100).toBeLessThan(0.52);
    expect(Math.abs(x[x.length - 1]!)).toBeLessThan(1e-9); // closed with a short fade
    const a = analyze([x]);
    expect(a.trailingSilence).toBeLessThan(0.01);
    const exact = render(layered('sound new s voice=layered seed=1\nlayer add s osc wave=sine freq=300 dur=0.1\n'));
    expect(exact.length).toBe(4410); // the 2 ms fade inside the source is not trimmed
    // a classic layer is the classic voice as it is: never cut
    const classic = build('sound new c voice=classic preset=explosion seed=3\nsound new d voice=classic preset=explosion seed=3\nsound layer-up d').get('d') as LayeredSound;
    expect(render(classic).length).toBe(renderChannels(build('sound new c voice=classic preset=explosion seed=3').get('c')!)[0]!.length);
  });
});

describe('the bursts envelope', () => {
  const pts = (t: string): string => burstsEnv(t).map((p) => `${p.t}:${p.v}${p.curve === 'lin' ? '' : '@' + p.curve}`).join(' ');

  it('times: each burst rises over attack and falls on an exponential over decay', () => {
    expect(pts('bursts(times=0.1,0.3 attack=0.002 decay=0.05 level=1)')).toBe('0.1:0 0.102:1 0.152:0@exp 0.3:0 0.302:1 0.352:0@exp');
    expect(pts('bursts(times=0 attack=0.01 decay=0.1 level=0.5)')).toBe('0:0 0.01:0.5 0.11:0@exp');
    expect(pts('bursts(times=0.1, 0.152 attack=0.002 decay=0.05)')).toBe('0.1:0 0.102:1 0.152:0@exp 0.154:1 0.204:0@exp'); // the second starts where the first ends
  });

  it('count and over: seeded, evenly spread when the jitter is 0, the same text gives the same hits', () => {
    expect(burstsEnv('bursts(count=4 over=2 jitter=0 attack=0.002 decay=0.05)').filter((p) => p.v === 1).map((p) => p.t)).toEqual([0.252, 0.752, 1.252, 1.752]);
    const a = pts('bursts(count=6 over=2 jitter=0.8 level=0.4..1 seed=7)');
    expect(pts('bursts(count=6 over=2 jitter=0.8 level=0.4..1 seed=7)')).toBe(a);
    expect(pts('bursts(count=6 over=2 jitter=0.8 level=0.4..1 seed=8)')).not.toBe(a);
    const levels = burstsEnv('bursts(count=20 over=4 jitter=0.5 level=0.4..1 seed=3)').filter((p) => p.v > 0).map((p) => p.v);
    expect(levels).toHaveLength(20);
    expect(Math.min(...levels)).toBeGreaterThanOrEqual(0.4);
    expect(Math.max(...levels)).toBeLessThanOrEqual(1);
    expect(new Set(levels).size).toBeGreaterThan(10);
    expect(pts('bursts(count=5 over=1)')).toBe(pts('bursts(count=5 over=1)')); // no seed: derived from the settings
    const jitterTimes = burstsEnv('bursts(count=30 over=1.5 jitter=1 attack=0.001 decay=0.01)').filter((p) => p.v === 1).map((p) => p.t);
    expect([...jitterTimes].sort((x, y) => x - y)).toEqual(jitterTimes); // rising, none overlapping
  });

  it('takes a level for each hit with times=, in the order written, and says what is wrong with it', () => {
    expect(pts('bursts(times=0.1,0.3,0.5 attack=0.002 decay=0.05 level=1,0.6,0.3)')).toBe('0.1:0 0.102:1 0.152:0@exp 0.3:0 0.302:0.6 0.352:0@exp 0.5:0 0.502:0.3 0.552:0@exp');
    expect(pts('bursts(level=0.2,0.9 times=0.5,0.1 attack=0.002 decay=0.05)')).toBe('0.1:0 0.102:0.9 0.152:0@exp 0.5:0 0.502:0.2 0.552:0@exp'); // levels follow their times
    expect(() => burstsEnv('bursts(times=0.1,0.3,0.5 level=1,0.6)')).toThrow(/3 times but 2 levels/);
    expect(() => burstsEnv('bursts(times=0.1,0.3 level=1,5)')).toThrow(/each level is a number from 0 to 4 \(got '5'/);
    expect(() => burstsEnv('bursts(count=3 over=1 level=1,0.5,0.2)')).toThrow(/goes with times=/);
    const lib = build('sound new s voice=layered seed=1\nlayer add s osc wave=white dur=2\nenv s 1.amp bursts(times=0.1,0.3 attack=0.002 decay=0.05 level=0.8,0.4)');
    expect((lib.get('s') as LayeredSound).layers[0]!.amp!.map((p) => p.v)).toEqual([0, 0.8, 0, 0, 0.4, 0]);
  });

  it('says what is wrong', () => {
    expect(() => burstsEnv('bursts(times=0.1,0.12 attack=0.002 decay=0.05)')).toThrow(/overlap/);
    expect(() => burstsEnv('bursts(times=0.1 count=3 over=1)')).toThrow(/count=<n> over|goes with the count/);
    expect(() => burstsEnv('bursts(count=3)')).toThrow(/times=<t,t,...> or count=<n> over=<seconds>/);
    expect(() => burstsEnv('bursts(times=0.1 decay=0)')).toThrow(/decay must be a number from 0.005/);
    expect(() => burstsEnv('bursts(times=0.1 volume=2)')).toThrow(/no setting 'volume'/);
    expect(() => burstsEnv('bursts(times=0.1 level=0.9..0.5)')).toThrow(/level is a number/);
    expect(() => burstsEnv(`bursts(count=${MAX_BURSTS + 1} over=100)`)).toThrow(/count must be a number from 1 to/);
  });

  it('is an envelope in the command language: stored as breakpoints, quoted or not, on any target; 85 bursts fit in 256 breakpoints', () => {
    const lib = build('sound new s voice=layered seed=1\nlayer add s osc wave=white dur=2\nenv s 1.amp bursts(times=0.1,0.3 attack=0.002 decay=0.05 level=0.8)');
    const s = lib.get('s') as LayeredSound;
    expect(s.layers[0]!.amp!.map((p) => p.t)).toEqual([0.1, 0.102, 0.152, 0.3, 0.302, 0.352]);
    expect(parse('env s 1.amp "bursts(times=0.5)"').commands[0]).toMatchObject({ op: 'env', text: 'env s 1.amp "0.5:0 0.502:1 0.552:0@exp"' });
    const many = build(`sound new s voice=layered seed=1\nlayer add s osc wave=white dur=10\nenv s 1.amp bursts(count=${MAX_BURSTS} over=10 jitter=0.2 attack=0.001 decay=0.02)`).get('s') as LayeredSound;
    expect(many.layers[0]!.amp!.length).toBeLessThanOrEqual(256);
    expect(MAX_BURSTS).toBe(85);
    expect(parse('env s 1.amp bursts(times=0.1').errors).toHaveLength(1);
  });
});

describe('limits', () => {
  it('a loop is 0.1 to 120 s; envelopes have up to 256 breakpoints; a source up to 120 s (and a little more under a loop); 8 layers, said with the alternative', () => {
    const l = (len: number) => parse(`sound loop s ${len} fade=0.05`).errors[0]?.message;
    expect(l(0.1)).toBeUndefined();
    expect(l(120)).toBeUndefined();
    expect(l(0.09)).toMatch(/0\.1 to 120 seconds/);
    expect(l(121)).toMatch(/0\.1 to 120 seconds/);
    const long = layered('sound new s voice=layered seed=1\nlayer add s osc wave=sine dur=120\nsound set s duration=120');
    expect(long.duration).toBe(120);
    expect(() => build('sound new s voice=layered\nlayer add s osc dur=124')).toThrow(/dur must be between/);
    const many = Array.from({ length: 8 }, () => 'layer add s osc').join('\n');
    expect(() => build(`sound new s voice=layered\n${many}\nlayer add s osc`)).toThrow(/8 layers already \(the most a sound has\).*bursts\(/);
    const points = Array.from({ length: 256 }, (_, i) => `${i / 100}:${i % 2}`).join(' ');
    expect(() => build(`sound new s voice=layered\nlayer add s osc\nenv s 1.gain "${points}"`)).not.toThrow();
  });
});

describe('loops at any length', () => {
  for (const recipe of ['wind', 'rain', 'fire', 'crowd']) {
    for (const len of [4, 8, 20]) {
      it(`${recipe} looped at ${len} s: the right length, its layers cover it, and the seam passes`, () => {
        const lib = build(`sound new b voice=layered preset=${recipe} seed=5\nsound loop b ${len} fade=0.5`);
        const s = lib.get('b') as LayeredSound;
        for (const l of s.layers) expect(l.p.dur as number).toBeGreaterThanOrEqual(len + 0.5 + 0.05 - (l.p.offset as number) - 1e-9);
        const ch = renderChannels(s);
        expect(ch[0]!.length).toBe(len * 44100);
        const checks = runChecks(ch, analyze(ch), DEFAULT_STYLE, { loop: true });
        const click = checks.find((c) => c.name === 'click')!;
        expect(click.pass, click.value).toBe(true);
        // the level at the end and at the start of the loop agree (a layer that stopped early would leave a hole)
        const seam = seamNumbers(ch[0]!);
        expect(Math.abs(seam.stepDb)).toBeLessThan(3);
        const tailRms = rms(ch[0]!.subarray(ch[0]!.length - 22050));
        expect(db(tailRms)).toBeGreaterThan(db(rms(ch[0]!)) - 8);
      }, 20000);
    }
  }

  it('lengthens osc, fm and ks layers that are shorter than length + fade, counting their offset; others are left alone', () => {
    const lib = build('sound new b voice=layered seed=1\nlayer add b osc dur=0.5\nlayer add b osc dur=30 offset=1\nlayer add b ks dur=0.2\nlayer add b fm dur=0.1 offset=2\nlayer add b classic\nsound loop b 6 fade=0.5');
    const s = lib.get('b') as LayeredSound;
    expect(s.layers.map((l) => l.p.dur)).toEqual([6.55, 30, 6.55, 4.55, undefined]);
    expect(s.layers[4]!.kind).toBe('classic');
  });
});

describe('copy, rename and remove', () => {
  const lib = (): Library => build('sound new Door voice=layered preset=door seed=3\nsound new w voice=classic preset=hit seed=1\nset new steps from=w count=3\nsound set Door class=foley');

  it('copy is a draft with the same content under a new id', () => {
    const l = lib();
    applyCommand(l, parse('sound mark Door approved').commands[0]!);
    applyCommand(l, parse('sound copy Door Door2').commands[0]!);
    const a = l.get('Door') as LayeredSound, b = l.get('Door2') as LayeredSound;
    expect(b.status).toBe('draft');
    expect(a.status).toBe('approved');
    expect(b.layers).toEqual(a.layers);
    expect(b.loudClass).toBe('foley');
    expect(b.layers[0]).not.toBe(a.layers[0]); // a copy, not a shared object
    expect(() => applyCommand(l, parse('sound copy Door door2').commands[0]!)).toThrow(/exists already as 'Door2' \(ids are unique ignoring case\)/);
    expect(() => applyCommand(l, parse('sound copy nope x').commands[0]!)).toThrow(/no sound 'nope'/);
  });

  it('rename moves the sound and what names it in sets and families; a case-only rename is allowed', () => {
    const l = lib();
    applyCommand(l, parse('sound rename steps_2 stride').commands[0]!);
    expect(l.has('steps_2')).toBe(false);
    expect(l.has('stride')).toBe(true);
    expect((l.get('stride') as { id: string }).id).toBe('stride');
    expect(l.sets.get('steps')!.members).toEqual(['steps_1', 'stride', 'steps_3']);
    expect(l.sets.get('steps')!.generated).toEqual(['steps_1', 'stride', 'steps_3']);
    applyCommand(l, parse('sound rename w Hit').commands[0]!);
    expect(l.sets.get('steps')!.from).toBe('Hit');
    applyCommand(l, parse('family Door far as=DoorFar').commands[0]!);
    applyCommand(l, parse('sound rename Door door').commands[0]!);
    expect((l.get('DoorFar') as LayeredSound).family!.of).toBe('door');
    applyCommand(l, parse('sound rename door Door').commands[0]!);
    expect(l.has('Door')).toBe(true);
    expect(l.has('door')).toBe(false);
    expect(() => applyCommand(l, parse('sound rename Hit steps_1').commands[0]!)).toThrow(/exists already/);
    expect(() => applyCommand(l, parse('sound rename Hit DOORFAR').commands[0]!)).toThrow(/exists already as 'DoorFar'/);
  });

  it('remove refuses a sound a set names, unless --from-sets; the set keeps the others', () => {
    const l = lib();
    expect(() => applyCommand(l, parse('sound remove steps_1').commands[0]!)).toThrow(/named by set steps.*set remove steps steps_1.*--from-sets/);
    expect(() => applyCommand(l, parse('sound remove w').commands[0]!)).toThrow(/named by set steps/); // its source
    applyCommand(l, parse('sound remove steps_1 --from-sets').commands[0]!);
    expect(l.has('steps_1')).toBe(false);
    expect(l.sets.get('steps')!.members).toEqual(['steps_2', 'steps_3']);
    applyCommand(l, parse('sound remove w --from-sets').commands[0]!);
    expect(l.sets.get('steps')!.from).toBeNull();
    applyCommand(l, parse('sound remove Door').commands[0]!);
    expect(l.has('Door')).toBe(false);
    expect(parse('sound remove Door now').errors[0]!.message).toMatch(/unexpected 'now'/);
  });

  it('ids keep their case and are unique ignoring it', () => {
    const l = build('sound new Click_A voice=classic\nsound new click_b voice=classic');
    expect([...l.keys()]).toEqual(['Click_A', 'click_b']);
    expect(() => build('sound new Click_A\nsound new CLICK_a')).toThrow(/exists already as 'Click_A' \(ids are unique ignoring case\)/);
    expect(parse('sound new 9a').errors[0]!.message).toMatch(/not a sound id/);
    expect(() => build('sound new a voice=classic preset=hit seed=1\nsound mutate a as=A')).toThrow(/exists already as 'a'/);
    expect(() => build('sound new a voice=layered preset=door seed=1\nfamily a far as=A')).toThrow(/exists already as 'a'/);
  });

  it('a set takes its members\' names from a template or a list', () => {
    const l = build('sound new w voice=classic preset=hit seed=1\nset new g from=w count=3 names="Step{n}"\nset new h from=w count=2 as=hit_a,Hit_B');
    expect(l.sets.get('g')!.members).toEqual(['Step1', 'Step2', 'Step3']);
    expect(l.sets.get('h')!.members).toEqual(['hit_a', 'Hit_B']);
    expect(l.has('Step2')).toBe(true);
    const text = parse('set new k from=w count=2 as=x1,x2').commands[0] as { text: string; names: string[] };
    expect(text.names).toEqual(['x1', 'x2']);
    expect(parse('set new g from=w count=3 as=a,b').errors[0]!.message).toMatch(/lists 2 ids but count=3/);
    expect(parse('set new g from=w count=2 names="step"').errors[0]!.message).toMatch(/needs \{n\}/);
    expect(parse('set new g from=w count=2 names="s{n}" as=a,b').errors[0]!.message).toMatch(/not both/);
    expect(parse('set new g from=w count=2 as=a,A').errors[0]!.message).toMatch(/unique ignoring case/);
    expect(() => build('sound new w voice=classic preset=hit seed=1\nsound new Step1 voice=classic\nset new g from=w count=2 names="step{n}"')).toThrow(/exists already as 'Step1'/);
  });
});
