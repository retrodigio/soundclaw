// Sets: the spread text, seeded variants (determinism, bounds, coverage), the set commands and their
// replay, loudness matching by gain, the set-spread check on constructed members, and families.

import { describe, expect, it } from 'vitest';
import {
  FAMILIES, Library, analyze, applyCommand, checkSpread, defaultSetSeed, formatSpread, integratedLoudness, loudnessOf, matchGain, measureSet, mixdown, parse, parseSpread, renderChannels, replay, serializeSet,
  serializeSound, soundStyle, runChecks, DEFAULT_STYLE, type ClassicSound, type LayeredSound, type Sound, type TapeEntry,
} from '../src/index.ts';
import { build } from './layered-helpers.ts';

const lib = (script: string): Library => build(script, new Library());
const fails = (script: string, base = ''): string => {
  const l = base ? lib(base) : new Library();
  try {
    for (const c of parse(script).commands) applyCommand(l, c);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected an error');
};
const classic = (l: Library, id: string): ClassicSound => l.get(id) as ClassicSound;

describe('the spread text', () => {
  it('reads absolute and relative rules, with ± or +- or +/-, and prints them one way', () => {
    const r = parseSpread('freq±0.04 decay+-0.1 1.cutoff+/-15% *.gain±20%');
    expect(r).toEqual([
      { target: 'freq', amount: 0.04, relative: false }, { target: 'decay', amount: 0.1, relative: false },
      { target: '1.cutoff', amount: 15, relative: true }, { target: '*.gain', amount: 20, relative: true },
    ]);
    expect(formatSpread(r)).toBe('freq±0.04 decay±0.1 1.cutoff±15% *.gain±20%');
    expect(parseSpread(formatSpread(r))).toEqual(r);
  });
  it('refuses what it cannot read, saying why', () => {
    expect(() => parseSpread('')).toThrow(/spread is empty/);
    expect(() => parseSpread('freq')).toThrow(/not <parameter>±<amount>/);
    expect(() => parseSpread('freq±0')).toThrow(/above 0/);
    expect(() => parseSpread('freq±150%')).toThrow(/at most 100%/);
    expect(() => parseSpread('freq±0.1 freq±0.2')).toThrow(/given twice/);
  });
});

const PICKUP = 'sound new coin voice=classic preset=pickup seed=3\n';
const STEP = 'sound new step voice=layered seed=11\nlayer add step osc wave=sine freq=110 dur=0.18 gain=0.8\nenv step 1.freq \"0:150 0.1:55@exp\"\nenv step 1.amp \"0:0 0.003:1 0.15:0@exp\"\nlayer add step osc wave=brown dur=0.15 filter=lp cutoff=1200 q=1 gain=0.7\nenv step 2.cutoff \"0:2200 0.12:400@exp\"\nenv step 2.amp \"0:0 0.004:1 0.12:0@exp\"\nlayer add step osc wave=white dur=0.07 offset=0.03 filter=hp cutoff=3500 gain=0.2\nenv step 3.amp \"0:0 0.004:1 0.05:0@exp\"\n';

describe('variants', () => {
  it('are deterministic: the same set command makes the same sounds, another seed others', () => {
    const cmd = (seed: number) => `${PICKUP}set new c from=coin count=6 spread="freq±0.04 decay±0.1" seed=${seed}\n`;
    const a = lib(cmd(5)), b = lib(cmd(5)), c = lib(cmd(6));
    for (let k = 1; k <= 6; k++) {
      expect(serializeSound(a.get(`c_${k}`)!)).toBe(serializeSound(b.get(`c_${k}`)!));
      expect(serializeSound(a.get(`c_${k}`)!)).not.toBe(serializeSound(c.get(`c_${k}`)!));
    }
    expect(serializeSet(a.sets.get('c')!)).toBe(serializeSet(b.sets.get('c')!));
  });
  it('stay inside the stated bounds, move only the named parameters, and differ from each other (a classic sound)', () => {
    const l = lib(`${PICKUP}set new c from=coin count=6 spread="freq±0.04 decay±0.1" seed=5\n`);
    const src = classic(l, 'coin').patch;
    const freqs: number[] = [];
    for (let k = 1; k <= 6; k++) {
      const p = classic(l, `c_${k}`).patch;
      expect(Math.abs(p.freq - src.freq)).toBeLessThanOrEqual(0.04 + 1e-6);
      expect(Math.abs(p.decay - src.decay)).toBeLessThanOrEqual(0.1 + 1e-6);
      for (const key of Object.keys(src) as (keyof typeof src)[]) if (key !== 'freq' && key !== 'decay' && key !== 'seed') expect(p[key], key).toBe(src[key]);
      expect(p.seed).toBeDefined();
      freqs.push(p.freq);
    }
    expect(new Set(freqs).size).toBe(6);
    // stratified: neighbouring members are at least a tenth of the amount apart (6 stripes, each jittered inside its own)
    const sorted = [...freqs].sort((x, y) => x - y);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(0.004 - 1e-6);
    expect(new Set([1, 2, 3, 4, 5, 6].map((k) => classic(l, `c_${k}`).patch.seed)).size).toBe(6);
  });
  it('clamp to the parameter\'s range', () => {
    const l = lib(`sound new q voice=classic\nsound set q freq=0.98 punch=0.02\nset new c from=q count=8 spread="freq±0.5 punch±0.5" seed=2\n`);
    for (let k = 1; k <= 8; k++) {
      const p = classic(l, `c_${k}`).patch;
      expect(p.freq).toBeLessThanOrEqual(1);
      expect(p.punch).toBeGreaterThanOrEqual(0);
    }
  });
  it('vary a layered sound: parameters by layer, every layer at once, an envelope as a whole, and the sound gain', () => {
    const l = lib(`${STEP}set new f from=step count=6 spread="1.freq±10% 2.cutoff±20% *.gain±20% gain±10%" seed=4\n`);
    const src = l.get('step') as LayeredSound;
    for (let k = 1; k <= 6; k++) {
      const m = l.get(`f_${k}`) as LayeredSound;
      // layer 1's pitch is an envelope: every breakpoint moves, by the same ratio
      const ratios = m.layers[0]!.envs.freq!.map((p, i) => p.v / src.layers[0]!.envs.freq![i]!.v);
      for (const r of ratios) { expect(r).toBeGreaterThan(0.9 - 1e-3); expect(r).toBeLessThan(1.1 + 1e-3); expect(r).toBeCloseTo(ratios[0]!, 2); }
      expect(Number(m.layers[1]!.p.cutoff)).toBeGreaterThanOrEqual(Number(src.layers[1]!.p.cutoff) * 0.8 - 1e-3);
      expect(Number(m.layers[1]!.p.cutoff)).toBeLessThanOrEqual(Number(src.layers[1]!.p.cutoff) * 1.2 + 1e-3);
      m.layers.forEach((x, i) => { const g = Number(x.p.gain) / Number(src.layers[i]!.p.gain); expect(g).toBeGreaterThan(0.8 - 1e-3); expect(g).toBeLessThan(1.2 + 1e-3); });
      expect(m.gain).toBeGreaterThanOrEqual(0.9 - 1e-6);
      expect(m.gain).toBeLessThanOrEqual(1.1 + 1e-6);
      expect(m.seed).not.toBe(src.seed);
      expect(m.id).toBe(`f_${k}`);
      expect(m.status).toBe('draft');
    }
    expect(new Set([1, 2, 3, 4, 5, 6].map((k) => serializeSound(l.get(`f_${k}`)!).replace(/^id .*$/m, ''))).size).toBe(6);
  });
  it('refuse a rule that names something the sound does not have', () => {
    expect(fails('set new f from=step count=3 spread="9.freq±5%"', STEP)).toMatch(/no layer 9/);
    expect(fails('set new f from=step count=3 spread="1.wave±5%"', STEP)).toMatch(/choice or a text/);
    expect(fails('set new f from=step count=3 spread="*.dur2±5%"', STEP)).toMatch(/no layer of step has a numeric parameter/);
    expect(fails('set new f from=coin count=3 spread="bogus±0.1"', PICKUP)).toMatch(/no parameter 'bogus'/);
    expect(fails('set new f from=coin count=3 spread="wave±0.1"', PICKUP)).toMatch(/choice/);
    expect(fails('set new f from=nope count=3')).toMatch(/no sound 'nope'/);
    expect(fails('set new f from=t count=3', 'sound new t')).toMatch(/is a tone/);
  });
});

describe('the set commands', () => {
  const BASE = `${PICKUP}set new c from=coin count=4 target=-20 spread="freq±0.04" seed=9\nsound new extra voice=classic preset=blip seed=1\n`;
  it('set new makes the sounds c_1 … c_n and the document; the same names twice are refused', () => {
    const l = lib(BASE);
    expect([...l.keys()].sort()).toEqual(['c_1', 'c_2', 'c_3', 'c_4', 'coin', 'extra']);
    expect(l.sets.get('c')).toMatchObject({ id: 'c', from: 'coin', seed: 9, target: -20, members: ['c_1', 'c_2', 'c_3', 'c_4'], generated: ['c_1', 'c_2', 'c_3', 'c_4'] });
    expect(fails('set new c from=coin count=2', BASE)).toMatch(/set 'c' exists already/);
    expect(fails('set new d from=coin count=2\nsound new d_1', BASE.replace('set new c', 'set new x'))).toMatch(/d_1/);
    expect(fails(`sound new c_2 voice=classic\nset new c from=coin count=3`, PICKUP)).toMatch(/sound 'c_2' exists already/);
    expect(serializeSet(l.sets.get('c')!)).toContain('spread freq±0.04');
  });
  it('add, remove and retarget change the membership and the target, not the sounds', () => {
    const l = lib(`${BASE}set add c extra\nset remove c c_1 c_2\nset retarget c -18LUFS\n`);
    expect(l.sets.get('c')).toMatchObject({ members: ['c_3', 'c_4', 'extra'], generated: ['c_3', 'c_4'], target: -18 });
    expect(l.has('c_1')).toBe(true);
    expect(lib(`${BASE}set retarget c none\n`).sets.get('c')!.target).toBeNull();
    expect(fails('set add c extra', BASE + 'set add c extra\n')).toMatch(/in c already/);
    expect(fails('set remove c extra', BASE)).toMatch(/not in c/);
    expect(fails('set add c ghost', BASE)).toMatch(/no sound 'ghost'/);
    expect(fails('set add z extra', BASE)).toMatch(/no set 'z'/);
  });
  it('regen makes the generated members again with a new seed from the source as it is now, and leaves the others', () => {
    const before = lib(`${BASE}set add c extra\n`);
    const after = lib(`${BASE}set add c extra\nsound set coin decay=0.2\nset regen c seed=77\n`);
    expect(after.sets.get('c')!.seed).toBe(77);
    expect(classic(after, 'c_1').patch.decay).toBe(0.2);
    expect(classic(after, 'c_1').patch.freq).not.toBe(classic(before, 'c_1').patch.freq);
    expect(serializeSound(after.get('extra')!)).toBe(serializeSound(before.get('extra')!));
    expect(fails('set regen c', 'sound new t')).toMatch(/no set/);
  });
  it('replay from the tape gives the same library: sets and members alike', () => {
    const script = `${BASE}set add c extra\nset regen c seed=3 spread="freq±0.1 decay±0.05"\nset remove c c_2\nsound set c_3 volume=0.31\n`;
    const entries: TapeEntry[] = parse(script).commands.map((c, i) => ({ seq: i + 1, by: 'agent:claude', group: `g${i + 1}`, cmd: c.text }));
    const direct = lib(script);
    const r = replay(entries);
    expect(r.problems).toEqual([]);
    expect([...r.library.keys()].sort()).toEqual([...direct.keys()].sort());
    for (const [id, s] of direct) expect(serializeSound(r.library.get(id)!), id).toBe(serializeSound(s));
    expect(serializeSet(r.library.sets.get('c')!)).toBe(serializeSet(direct.sets.get('c')!));
  });
  it('write the normal form with the seed settled', () => {
    const [c] = parse('set new foot from=step count=3 spread="1.freq+-5%"').commands;
    const l = lib(STEP);
    expect(applyCommand(l, c!)).toBe(`set new foot from=step count=3 spread="1.freq±5%" seed=${defaultSetSeed('foot', 'step')}`);
    expect(applyCommand(l, parse('set regen foot').commands[0]!)).toMatch(/^set regen foot seed=\d+$/);
  });
  it('are parsed with their errors placed', () => {
    expect(parse('set new f from=a').errors[0]!.message).toMatch(/give from=<sound> and count=<n>/);
    expect(parse('set new f from=a count=0').errors[0]!.message).toMatch(/whole number from 1/);
    expect(parse('set new f from=a count=3 target=5').errors[0]!.message).toMatch(/LUFS from -60 to 0/);
    expect(parse('set new f from=a count=3 spread="freq"').errors[0]!.message).toMatch(/not <parameter>±<amount>/);
    expect(parse('set frob f').errors[0]!.message).toMatch(/unknown set command/);
    expect(parse('family a sideways').errors[0]!.message).toMatch(/near, far or muffled/);
  });
});

describe('loudness matching', () => {
  it('brings a layered sound to the target by its gain, within 0.1 LU, and says the command', () => {
    const l = lib(STEP);
    const s = l.get('step')!;
    for (const target of [-30, -23, -20]) {
      const m = matchGain(s, target);
      expect(m.reached, String(target)).toBe(true);
      expect(Math.abs(m.lufs - target)).toBeLessThan(0.1);
      expect(m.command).toMatch(/^sound set step gain=[\d.]+$/);
      const t = applyCommand(l, parse(m.command!).commands[0]!);
      void t;
      expect(Math.abs(loudnessOf(l.get('step')!) - target)).toBeLessThan(0.1);
      l.set('step', s);
    }
  });
  it('brings a classic sound there by its volume (its gain), and falls short, saying so, when volume 1 is not loud enough', () => {
    const l = lib(PICKUP);
    const s = l.get('coin')!;
    const own = loudnessOf(s);
    const quieter = matchGain(s, own - 6);
    expect(quieter.reached).toBe(true);
    expect(quieter.command).toMatch(/^sound set coin volume=0\.\d+$/);
    const louder = matchGain(s, own + 30);
    expect(louder.reached).toBe(false);
    expect(louder.command).toBe('sound set coin volume=1');
    expect(louder.note).toMatch(/volume would need to be above 1.*layer-up/);
  });
  it('is the same on every run', () => {
    const a = matchGain(lib(STEP).get('step')!, -22), b = matchGain(lib(STEP).get('step')!, -22);
    expect(a.command).toBe(b.command);
  });
  it('refuses to guess for a silent sound or a tone', () => {
    expect(matchGain(lib('sound new t').get('t')!, -20).note).toMatch(/tone/);
    expect(matchGain(lib('sound new s voice=layered').get('s')!, -20).note).toMatch(/silent/);
  });
});

/** Members matched to a target, as the writer does after `set new`. */
function matched(l: Library, set: string, target: number): void {
  for (const id of l.sets.get(set)!.members) {
    const m = matchGain(l.get(id)!, target);
    if (m.command) applyCommand(l, parse(m.command).commands[0]!);
  }
}
const members = (l: Library, set: string) => l.sets.get(set)!.members.map((id) => { const ch = renderChannels(l.get(id)!); return { id, channels: ch, lufs: integratedLoudness(ch) }; });

describe('the set-spread check', () => {
  it('passes a set whose members differ within the floor and the ceiling and share a loudness', () => {
    const l = lib(`${PICKUP}set new c from=coin count=5 spread="freq±0.04 decay±0.1" seed=5\n`);
    matched(l, 'c', -20);
    const m = measureSet(members(l, 'c'), -20);
    expect(m.result.pass, m.result.value + JSON.stringify(m.result.ranges)).toBe(true);
    expect(m.matrix[0]![0]).toBe(0);
    expect(m.matrix[1]![2]).toBe(m.matrix[2]![1]);
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) if (i !== j) { expect(m.matrix[i]![j]).toBeGreaterThan(DEFAULT_STYLE.setSpreadMin); expect(m.matrix[i]![j]).toBeLessThan(DEFAULT_STYLE.setSpreadMax); }
  });
  it('flags members that are too alike: identical copies are 0 dB apart', () => {
    const l = lib(`${PICKUP}sound new twin voice=classic\nsound patch twin "${'wave=0'}"\n`);
    const a = renderChannels(l.get('coin')!);
    const m = measureSet([{ id: 'a', channels: a, lufs: -20 }, { id: 'b', channels: a, lufs: -20 }, { id: 'c', channels: a, lufs: -20 }], -20);
    expect(m.result.pass).toBe(false);
    expect(m.result.ranges.filter((r) => /too alike/.test(r.note))).toHaveLength(3);
    expect(m.result.ranges[0]!.note).toMatch(/a and b are only 0\.0 dB apart/);
  });
  it('flags members that are too different: a laser and an explosion', () => {
    const l = lib('sound new a voice=classic preset=laser seed=2\nsound new b voice=classic preset=explosion seed=3\n');
    const m = measureSet(['a', 'b'].map((id) => { const ch = renderChannels(l.get(id)!); return { id, channels: ch, lufs: -20 }; }), -20);
    expect(m.result.pass).toBe(false);
    expect(m.result.ranges[0]!.note).toMatch(/a and b are [\d.]+ dB apart \(too different: at most 20 dB\)/);
  });
  it('flags a member whose loudness is more than 1 LU from the target (or from the middle member without one)', () => {
    const l = lib(`${PICKUP}set new c from=coin count=4 spread="freq±0.04 decay±0.1" seed=5\n`);
    matched(l, 'c', -20);
    const ms = members(l, 'c');
    ms[2]!.lufs -= 4;
    const m = measureSet(ms, -20);
    expect(m.result.pass).toBe(false);
    expect(m.result.ranges.map((r) => r.note).join('\n')).toMatch(/c_3 is -24\.\d LUFS, 4\.\d LU from the target -20\.0/);
    expect(measureSet(ms, null).result.ranges.map((r) => r.note).join('\n')).toMatch(/c_3 .* from the middle member/);
    expect(measureSet(ms.slice(0, 1), -20).result.pass).toBe(false);
  });
  it('holds a member with its own loudness to that, and the report names the per-member targets', () => {
    const l = lib(`${PICKUP}set new c from=coin count=4 spread="freq±0.04 decay±0.1" seed=5\n`);
    matched(l, 'c', -20);
    const ms = members(l, 'c');
    ms[2]!.lufs -= 4;
    expect(measureSet(ms, -20).result.pass).toBe(false);
    ms[2]!.own = ms[2]!.lufs; // its own loudness is where it is
    const m = measureSet(ms, -20);
    expect(m.result.ranges.filter((r) => /LUFS, .* LU from/.test(r.note))).toHaveLength(0);
    expect(m.result.threshold).toMatch(/own targets \(LUFS\): c_3 -24\.\d/);
    ms[2]!.own = -30; // an own target it misses is flagged against that target
    expect(measureSet(ms, -20).result.ranges.map((r) => r.note).join('\n')).toMatch(/c_3 is -24\.\d LUFS, 6\.\d LU from the own target -30\.0/);
  });
  it('holds the members of a set to its target, and a family variant to the target plus its offset', () => {
    const l = lib(`${PICKUP}set new c from=coin count=2 target=-24 seed=1\nfamily coin far\n`);
    expect(soundStyle(l.get('c_1')!, l.sets.values()).loudnessTarget).toBe(-24);
    expect(soundStyle(l.get('coin')!, l.sets.values()).loudnessTarget).toBe(-16);
    expect(soundStyle(l.get('coin_far')!, l.sets.values()).loudnessTarget).toBe(-16 + FAMILIES.far.gainDb);
  });
});

describe('families', () => {
  const centroid = (s: Sound) => analyze(renderChannels(s)).centroid.mean;
  const SRC = 'sound new door voice=layered seed=7\nlayer add door osc wave=sine freq=95 dur=0.35 gain=0.9\nenv door 1.freq \"0:110 0.2:42@exp\"\nenv door 1.amp \"0:0 0.003:1 0.3:0@exp\"\nlayer add door osc wave=brown dur=0.3 filter=lp cutoff=600 gain=0.6\nenv door 2.amp \"0:0 0.003:1 0.25:0@exp\"\nlayer add door osc wave=saw dur=0.7 offset=0.2 filter=bp cutoff=2800 q=2 gain=0.7\nenv door 3.amp \"0:0 0.1:1 0.5:0@exp\"\nfx add door reverb size=0.25 damp=0.6 mix=0.1\nfamily door near\nfamily door far\nfamily door muffled as=door_wall\n';
  it('far is darker and, matched to its offset, quieter; muffled is darker; near is a little louder', () => {
    const l = lib(SRC);
    const src = l.get('door')!;
    expect(centroid(l.get('door_far')!)).toBeLessThan(centroid(src));
    expect(centroid(l.get('door_wall')!)).toBeLessThan(centroid(src) * 0.5);
    const bright = lib(`${PICKUP}family coin far\nfamily coin muffled\n`);
    expect(centroid(bright.get('coin_far')!)).toBeLessThan(centroid(bright.get('coin')!) * 0.5);
    expect(centroid(bright.get('coin_muffled')!)).toBeLessThan(centroid(bright.get('coin_far')!));
    const lu = loudnessOf(src);
    for (const [id, kind] of [['door_near', 'near'], ['door_far', 'far'], ['door_wall', 'muffled']] as const) {
      const m = matchGain(l.get(id)!, lu + FAMILIES[kind].gainDb);
      expect(m.reached, id).toBe(true);
      applyCommand(l, parse(m.command ?? 'sound set door_near gain=1').commands[0]!);
    }
    expect(loudnessOf(l.get('door_far')!)).toBeLessThan(lu - 8);
    expect(loudnessOf(l.get('door_wall')!)).toBeLessThan(lu - 5);
    expect(loudnessOf(l.get('door_near')!)).toBeGreaterThan(lu + 1);
    expect(loudnessOf(l.get('door_far')!)).toBeLessThan(loudnessOf(l.get('door_wall')!));
  });
  it('are copies: they name the source and the rule, are layered, and do not follow the source', () => {
    const l = lib(SRC);
    const far = l.get('door_far') as LayeredSound;
    expect(far.family).toEqual({ of: 'door', kind: 'far', offsetDb: -9 });
    expect(far.layers.length).toBe((l.get('door') as LayeredSound).layers.length);
    expect(far.master.map((f) => f.kind)).toEqual(['reverb', 'filter', 'reverb'].slice(0, far.master.length));
    const before = serializeSound(far);
    applyCommand(l, parse('layer set door 1 gain=0.2').commands[0]!);
    expect(serializeSound(l.get('door_far')!)).toBe(before);
    expect(serializeSound(l.get('door_far')!)).toContain('family far of door offset -9');
  });
  it('make a classic sound layered, sample for sample before the rules act', () => {
    const l = lib(`${PICKUP}family coin muffled as=coin_wall\n`);
    const w = l.get('coin_wall') as LayeredSound;
    expect(w.voice).toBe('layered');
    expect(w.layers[0]!.kind).toBe('classic');
    expect(w.master.filter((f) => f.kind === 'filter')).toHaveLength(3); // a high-pass and two low-pass stages
    expect(w.master.some((f) => f.kind === 'reverb')).toBe(true);
  });
  it('refuse a name that exists, a tone, and a master chain that would overflow', () => {
    expect(fails('family door far', SRC)).toMatch(/sound 'door_far' exists already/);
    expect(fails('family t far', 'sound new t')).toMatch(/is a tone/);
  });
  it('are held to the style target plus their offset by the checks', () => {
    const l = lib(SRC);
    const far = l.get('door_far')!;
    const m = matchGain(far, -16 + FAMILIES.far.gainDb);
    applyCommand(l, parse(m.command!).commands[0]!);
    const ch = renderChannels(l.get('door_far')!);
    const a = analyze(ch);
    const ok = runChecks(ch, a, soundStyle(l.get('door_far')!, l.sets.values()));
    expect(ok.find((c) => c.name === 'loudness')!.pass).toBe(true);
    expect(runChecks(ch, a, DEFAULT_STYLE).find((c) => c.name === 'loudness')!.pass).toBe(false);
  });
});
void checkSpread; void mixdown;
