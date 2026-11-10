// A loudness match can be two commands (the sound's gain and its master limiter's gain). Sets and families write each as its own tape line, and the state has both.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LayeredSound } from '@soundclaw/core';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
beforeEach(() => { f = fixture(); });
afterEach(() => f.clean());

describe('a set matched by gain', () => {
  it('puts the limiter gain a match needs on the tape as its own line, in the state, and after a reopen', () => {
    const r = f.w.run({ commands: 'sound new step voice=layered preset=footstep seed=11\nset new grass from=step count=2 target=-20 seed=2', by: 'human:ana' });
    expect(r.ok).toBe(true);
    const tape = f.w.tape().map((t) => t.cmd);
    expect(tape.every((c) => !c.includes('\n'))).toBe(true);
    const fxLine = tape.find((c) => /^fx set grass_1 \d+ gain=/.test(c));
    expect(fxLine).toBeDefined();
    const limiter = (w: typeof f.w): number => Number((w.sound('grass_1') as LayeredSound).master.at(-1)!.p.gain);
    const want = Number(/gain=([\d.]+)$/.exec(fxLine!)![1]);
    expect(limiter(f.w)).toBe(want);
    expect(limiter(f.reopen())).toBe(want);
  });
});
