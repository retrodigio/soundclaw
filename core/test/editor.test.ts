// What the editor sends: the groups, the commands (equal to what an agent writes), the rule that
// turns a drag into one command, and the random generator.

import { describe, expect, it } from 'vitest';
import {
  CLASSIC_FIELDS, CLASSIC_KEYS, Coalescer, EDITOR_GROUPS, GENERATOR_NAMES, RANDOM, Rng, applyCommand, classicField, csvFileText, diffPatch, formatPatchNamed, generate, makePatch, parse, parseCsv, parsePatch,
  patchFileText, replay, resetCommand, restoreCommand, roundParam, setCommand, type Edits, type Library, type Scheduler,
} from '../src/index.ts';

/** A clock the test moves by hand. */
function fakeClock() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const sched: Scheduler = {
    set: (fn, ms) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
    clear: (h) => { timers.delete(h as number); },
  };
  return {
    sched,
    advance(ms: number) {
      const to = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = to;
    },
    pending: () => timers.size,
  };
}

describe('the parameter groups', () => {
  it('hold each of the 25 parameters exactly once, in sfxr\'s order of groups', () => {
    const all = EDITOR_GROUPS.flatMap((g) => g.params);
    expect([...all].sort()).toEqual([...CLASSIC_KEYS].sort());
    expect(new Set(all).size).toBe(25);
    expect(EDITOR_GROUPS.map((g) => g.id)).toEqual(['wave', 'envelope', 'frequency', 'vibrato', 'change', 'duty', 'repeat', 'phaser', 'filters', 'volume']);
  });
});

describe('the commands the editor sends are the commands an agent writes', () => {
  it('sound set: the same normal form as the parser gives, the wave by name, parameters in table order', () => {
    expect(setCommand('beep', { freq: 0.45, wave: 1 })).toBe('sound set beep wave=saw freq=0.45');
    // The tape keeps the order a command is written in; the editor writes the table's order, as an agent reading the docs would.
    const agent = parse('sound set beep wave=saw freq=0.45').commands[0]!;
    expect(agent.text).toBe(setCommand('beep', { freq: 0.45, wave: 1 }));
  });

  it('every edit the editor can make parses back to exactly itself, and applies', () => {
    const rng = new Rng(7);
    for (let n = 0; n < 200; n++) {
      const e: Edits = {};
      for (const f of CLASSIC_FIELDS) if (rng.next() < 0.3) e[f.name] = roundParam(f.name, rng.range(f.min, f.max));
      if (rng.next() < 0.3) e.seed = rng.next() < 0.5 ? 'auto' : Math.floor(rng.range(0, 4294967295));
      if (!Object.keys(e).length) continue;
      const text = setCommand('beep', e);
      const p = parse(text);
      expect(p.errors).toEqual([]);
      expect(p.commands[0]!.text).toBe(text);
      const lib: Library = new Map();
      applyCommand(lib, parse('sound new beep voice=classic').commands[0]!);
      applyCommand(lib, p.commands[0]!);
      const s = lib.get('beep')!;
      expect(s.voice === 'classic' && Object.entries(e).every(([k, v]) => k === 'seed' ? s.voice === 'classic' && (v === 'auto' ? s.patch.seed === undefined : s.patch.seed === v) : s.voice === 'classic' && s.patch[k as keyof typeof s.patch] === v)).toBe(true);
    }
  });

  it('slider values are three decimals inside the range; the wave is a whole number', () => {
    expect(roundParam('freq', 0.123456)).toBe(0.123);
    expect(roundParam('sustain', 0)).toBe(0.01);
    expect(roundParam('slide', -3)).toBe(-1);
    expect(roundParam('wave', 1.7)).toBe(2);
    expect(roundParam('wave', 9)).toBe(3);
  });

  it('reset writes the defaults, one command', () => {
    expect(resetCommand('beep', ['lowPass', 'volume', 'wave'])).toBe('sound set beep wave=square lowPass=1 volume=0.5');
    expect(classicField('lowPass')!.default).toBe(1);
  });

  it('Keep A is one command that makes B equal A, and nothing when they already are', () => {
    const a = makePatch({ freq: 0.5, wave: 2, seed: 9 });
    const b = makePatch({ freq: 0.31, decay: 0.2, volume: 0.3 });
    const cmd = restoreCommand('beep', b, a)!;
    expect(cmd.split('\n')).toHaveLength(1);
    expect(cmd).toBe('sound set beep wave=sine decay=0.4 freq=0.5 volume=0.5 seed=9');
    const lib: Library = new Map();
    applyCommand(lib, parse('sound new beep voice=classic').commands[0]!);
    applyCommand(lib, parse(`sound patch beep "${formatPatchNamed(b)}"`).commands[0]!);
    applyCommand(lib, parse(cmd).commands[0]!);
    const s = lib.get('beep')!;
    expect(s.voice === 'classic' && formatPatchNamed(s.patch)).toBe(formatPatchNamed(a));
    expect(restoreCommand('beep', a, a)).toBeNull();
    expect(restoreCommand('beep', a, makePatch({ ...a, seed: undefined }))).toMatch(/seed=auto$/);
    expect(diffPatch(a, a)).toEqual({});
  });
});

describe('a drag is one command', () => {
  it('a hundred moves are held; release writes ONE batch with the latest value of each parameter', () => {
    const clock = fakeClock();
    const sent: Edits[] = [];
    const c = new Coalescer((e) => sent.push(e), clock.sched, 700);
    for (let i = 1; i <= 100; i++) { c.push('freq', i / 1000); clock.advance(5); }
    c.push('decay', 0.2);
    expect(sent).toEqual([]);
    c.flush();
    expect(sent).toEqual([{ freq: 0.1, decay: 0.2 }]);
    expect(clock.pending()).toBe(0);
    c.flush();
    clock.advance(5000);
    expect(sent).toHaveLength(1);
  });

  it('a pause in the drag writes what is held; moving on starts the next one', () => {
    const clock = fakeClock();
    const sent: Edits[] = [];
    const c = new Coalescer((e) => sent.push(e), clock.sched, 700);
    c.push('freq', 0.4);
    clock.advance(600);
    c.push('freq', 0.5); // still moving: the pause starts again
    clock.advance(600);
    expect(sent).toEqual([]);
    clock.advance(200);
    expect(sent).toEqual([{ freq: 0.5 }]);
    c.push('freq', 0.6);
    c.flush();
    expect(sent).toEqual([{ freq: 0.5 }, { freq: 0.6 }]);
  });

  it('cancel drops what is held; the held value can be read while the control moves', () => {
    const clock = fakeClock();
    const sent: Edits[] = [];
    const c = new Coalescer((e) => sent.push(e), clock.sched);
    c.push('slide', -0.2);
    expect(c.value('slide')).toBe(-0.2);
    expect(c.active).toBe(true);
    c.cancel();
    clock.advance(10_000);
    expect(sent).toEqual([]);
    expect(c.active).toBe(false);
  });
});

describe('the random generator', () => {
  it('is a generator with its ranges as data, listed beside the categories', () => {
    expect(GENERATOR_NAMES).toEqual(['pickup', 'laser', 'explosion', 'powerup', 'hit', 'jump', 'blip', 'random']);
    expect(RANDOM.help.length).toBeGreaterThan(5);
  });

  it('is deterministic: the same seed gives the same patch, other seeds other ones', () => {
    expect(generate('random', 5)).toEqual(generate('random', 5));
    const texts = new Set<string>();
    for (let s = 0; s < 50; s++) texts.add(formatPatchNamed(generate('random', s)));
    expect(texts.size).toBeGreaterThan(45);
  });

  it('keeps every value inside the written ranges, and a parameter it does not mention at its default', () => {
    const written = new Map<string, [number, number]>();
    const note = (rules: Record<string, unknown>) => {
      for (const [k, r] of Object.entries(rules)) {
        const [lo, hi] = typeof r === 'number' ? [r, r] : Array.isArray(r) ? [r[0] as number, r[1] as number] : [Math.min(...(r as { pick: number[] }).pick), Math.max(...(r as { pick: number[] }).pick)];
        const w = written.get(k);
        written.set(k, w ? [Math.min(w[0], lo), Math.max(w[1], hi)] : [lo, hi]);
      }
    };
    note(RANDOM.always);
    for (const m of RANDOM.maybe ?? []) note(m.rules);
    for (let s = 0; s < 300; s++) {
      const p = generate('random', s);
      for (const f of CLASSIC_FIELDS) {
        const v = p[f.name];
        const w = written.get(f.name);
        if (!w) { expect(v).toBe(f.default); continue; }
        expect(v === f.default || (v >= w[0] - 0.0005 && v <= w[1] + 0.0005)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(f.min);
        expect(v).toBeLessThanOrEqual(f.max);
      }
    }
  });

  it('draws the optional groups about as often as the data says', () => {
    let slides = 0;
    const n = 1000;
    for (let s = 0; s < n; s++) if (generate('random', s).slide !== 0) slides++;
    const chance = RANDOM.maybe!.find((m) => 'slide' in m.rules)!.chance;
    expect(Math.abs(slides / n - chance)).toBeLessThan(0.07);
  });
});

describe('sound generate', () => {
  it('has a normal form with the settled seed, replays from the tape, and refuses a tone', () => {
    const c = parse('sound generate beep random seed=42').commands[0]!;
    expect(c.text).toBe('sound generate beep random seed=42');
    const withDefault = parse('sound generate beep laser').commands[0]!;
    expect(withDefault.text).toMatch(/^sound generate beep laser seed=\d+$/);
    const tape = [
      { seq: 1, by: 'agent:claude', group: 'g1', cmd: 'sound new beep voice=classic' },
      { seq: 2, by: 'human:ana', group: 'g2', cmd: 'sound generate beep random seed=42' },
    ];
    const r = replay(tape);
    expect(r.problems).toEqual([]);
    const s = r.library.get('beep')!;
    expect(s.voice === 'classic' && formatPatchNamed(s.patch)).toBe(formatPatchNamed(generate('random', 42)));
    const lib: Library = new Map();
    applyCommand(lib, parse('sound new tone1').commands[0]!);
    expect(() => applyCommand(lib, parse('sound generate tone1 random seed=1').commands[0]!)).toThrow(/tone/);
    expect(parse('sound generate beep wobble').errors[0]!.message).toMatch(/give a category/);
    expect(parse('sound new beep preset=random seed=3').commands[0]!.text).toBe('sound new beep voice=classic preset=random seed=3');
  });
});

describe('export texts', () => {
  it('the patch file text reads back to the patch; a seed travels as named pairs', () => {
    const p = makePatch({ freq: 0.51, decay: 0.33 });
    expect(parsePatch(patchFileText(p)).patch).toEqual(p);
    const q = makePatch({ freq: 0.51, seed: 12 });
    expect(patchFileText(q)).toBe(`1\n${formatPatchNamed(q)}\n`);
    expect(parsePatch(patchFileText(q)).patch).toEqual(q);
  });

  it('the CSV row reads back to the same patch', () => {
    const p = makePatch({ freq: 0.51, wave: 3, seed: 5 });
    expect(parseCsv(csvFileText('zap', p))).toEqual([{ id: 'zap', patch: p }]);
  });
});
