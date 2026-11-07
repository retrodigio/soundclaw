// normalize for layered songs (every mix a game can play), and normalize as a line of a run batch.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizePlan, songChecksText } from '../src/index.ts';
import { fixture, type Fixture } from './helpers.ts';

let f: Fixture;
beforeEach(() => { f = fixture(); });
afterEach(() => f.clean());

const run = (cmds: string) => { const r = f.w.run({ commands: cmds, by: 'agent:claude' }); if (!r.ok) throw new Error(r.errors.map((e) => `${e.line}: ${e.message}`).join('; ')); return r; };

const PAT = `pattern lay.a steps=16 tpb=4
  bass: C3 - - - C3 - - - G2 - - - G2 - - -
  pad: C4+E4+G4 - - - - - - - G3+B3+D4 - - - - - - -
  lead: C5 . E5 . G5 - - . A4 . . . G4 . E4 .
  drums: k . h . s . h . k k h . s . h h
song section add lay A a x4
`;
const LAYERED = (gains: string) => `song new lay tempo=120 key=C:major class=music
song channel add lay bass inst=triangle_bass layer=base gain=${gains.split(',')[0]}
song channel add lay pad inst=saw_pad layer=tension gain=${gains.split(',')[1]}
song channel add lay lead inst=square_lead layer=combat gain=${gains.split(',')[2]}
song channel add lay drums kit=default layer=combat gain=${gains.split(',')[3]}
layer-plan lay base=bass tension=pad combat=lead,drums
${PAT}`;

const layersLine = (): string => songChecksText(f.w, 'lay').text.split('\n').find((l) => /\blayers\b/.test(l) && /^\s+(pass|FAIL|skip)/.test(l))!;

describe('normalize a layered song', () => {
  it('fits the base alone and the fullest mix into the class window, with the song gain and the gains above the base', () => {
    run(LAYERED('0.25,0.5,1,1'));
    expect(layersLine()).toMatch(/^\s+FAIL layers/);
    const plan = normalizePlan(f.w, ['lay']);
    expect(plan.info).toMatch(/lay has 3 layers \(base, tension, combat\)/);
    expect(plan.commands).toMatch(/^song set lay gain=[\d.]+$/m);
    expect(plan.commands).toMatch(/^song channel set lay (lead|drums) gain=[\d.]+$/m);
    expect(plan.commands).toMatch(/^song channel set lay pad gain=/m);
    expect(plan.commands).not.toMatch(/song channel set lay bass/);
    const r = run(plan.commands);
    expect(r.added.length).toBeGreaterThan(1);
    const text = songChecksText(f.w, 'lay').text;
    expect(layersLine(), text).toMatch(/^\s+pass layers/);
    expect(text).toMatch(/pass loudness/);
    // nothing more to do
    expect(normalizePlan(f.w, ['lay']).commands).toBe('');
  });
  it('keeps the balance when the mixes already fit together: only the song gain moves', () => {
    run(LAYERED('0.5,0.5,0.5,0.5'));
    const plan = normalizePlan(f.w, ['lay']);
    // a spread that fits the window is shifted as a whole
    if (/song channel set/.test(plan.commands)) throw new Error(`the layers were moved against each other: ${plan.commands}`);
    expect(plan.commands).toMatch(/^song set lay gain=[\d.]+$/);
    run(plan.commands);
    expect(layersLine()).toMatch(/^\s+pass layers/);
  });
  it('a song with one layer is as before: the song gain alone', () => {
    run('song new one tempo=120 class=music\nsong channel add one bass inst=triangle_bass gain=0.2\npattern one.a steps=16 tpb=4\n  bass: C3 - - - C3 - - - G2 - - - G2 - - -\nsong section add one A a x2\n');
    const plan = normalizePlan(f.w, ['one']);
    expect(plan.info).toBeNull();
    expect(plan.commands).toMatch(/^song set one gain=[\d.]+$/);
  });
});

describe('normalize in a run batch', () => {
  it('works on what the batch has made so far, and the tape holds the plain commands', () => {
    const r = run(`${LAYERED('0.25,0.5,1,1')}normalize lay\n`);
    const cmds = r.added.map((e) => e.cmd);
    expect(cmds.some((c) => /^normalize/.test(c))).toBe(false);
    expect(cmds.some((c) => /^song set lay gain=/.test(c))).toBe(true);
    expect(cmds.some((c) => /^song channel set lay (lead|drums) gain=/.test(c))).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/lay has 3 layers/);
    expect(layersLine()).toMatch(/^\s+pass layers/);
    // one group: undo takes the song and its normalization away together
    const u = f.w.run({ commands: `undo group=${r.group}`, by: 'agent:claude' });
    expect(u.ok).toBe(true);
    expect(f.w.hasSong('lay')).toBe(false);
  });
  it('normalizes sounds in a batch, and a sound that is already there is a warning, not an error', () => {
    const r = run('sound new tone voice=layered\nlayer add tone osc\nnormalize tone ui\n');
    expect(r.added.some((e) => /^sound set tone class=ui/.test(e.cmd) || /gain=/.test(e.cmd))).toBe(true);
    const again = run('normalize tone');
    expect(again.added).toEqual([]);
    expect(again.warnings.join(' ')).toMatch(/already at .*nothing to write/);
  });
  it('refuses a normalize with nothing to normalize, and a name that does not exist, as errors of the line', () => {
    const bad = f.w.run({ commands: 'normalize', by: 'agent:claude' });
    expect(bad.ok).toBe(false);
    const gone = f.w.run({ commands: 'normalize nothing_here', by: 'agent:claude' });
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.errors[0]!.message).toMatch(/no sound or set 'nothing_here'/);
  });
});
