import { describe, expect, it } from 'vitest';
import { Library, applyCommand, arrange, formatPattern, parse, type SongDoc, type TapeEntry } from '@soundclaw/core';
import {
  barsOf, barSeconds, clipsOf, laneFlags, layersAt, lineCol, maskLinks, notesAt, offsetOf, paramTrails, patternAuthors, rowLines, sectionSpans, seamOf, selectedTokens, textEdit, textTokens, tokenMidis, trackGroups,
  type SongReport,
} from '../src/song/model.ts';

const SCRIPT = `song new demo tempo=120 key=C:major
song channel add demo bass inst=triangle_bass layer=base
song channel add demo lead inst=pulse_lead layer=tension
song channel add demo arp inst=pluck layer=tension
song channel add demo drums kit=default layer=base
pattern demo.verse steps=8 tpb=2 bar=4
  lead: C5 . E5 - | G5 - E5 .
  bass: C3 . . . | G2 . . .
  drums: k . h . | s . h h
pattern demo.chorus steps=8 tpb=2 bar=4
  lead: A4 . C5 . | E5 - C5 .
  arp: C5 E5 G5 E5 | C5 E5 G5 E5
song section add demo A verse x2
song section add demo B chorus
song loop demo A..B
`;
const song = (): SongDoc => {
  const lib = new Library();
  const p = parse(SCRIPT);
  expect(p.errors).toEqual([]);
  for (const c of p.commands) applyCommand(lib, c);
  return lib.songs.get('demo')!;
};

let n = 0;
const e = (by: string, group: string, cmd: string): TapeEntry => ({ seq: ++n, by, group, cmd, at: '2026-11-08T10:00:00.000Z' });
const reset = () => { n = 0; };

describe('tracks and clips', () => {
  it('channels are grouped by layer in stacking order, and a layer count picks what sounds', () => {
    const s = song();
    expect(trackGroups(s).map((g) => [g.layer, g.channels.map((c) => c.name)])).toEqual([['base', ['bass', 'drums']], ['tension', ['lead', 'arp']]]);
    expect([...layersAt(s, 0)]).toEqual(['base']);
    expect([...layersAt(s, null)]).toEqual(['base', 'tension']);
  });

  it('a clip for each placement where the channel plays, with its notes sketched', () => {
    const s = song();
    const arr = arrange(s);
    const lead = clipsOf(arr, 'lead');
    expect(lead.map((c) => [c.pattern, c.pass, c.t0])).toEqual([['verse', 0, 0], ['verse', 1, 2], ['chorus', 0, 4]]);
    expect(lead[0]!.notes).toHaveLength(4);
    expect(lead[0]!.notes.every((n) => n.x >= 0 && n.x < 1 && n.y >= 0 && n.y <= 1)).toBe(true);
    // the arp only plays in the chorus; the bass only in the verse
    expect(clipsOf(arr, 'arp').map((c) => c.pattern)).toEqual(['chorus']);
    expect(clipsOf(arr, 'bass').map((c) => c.pattern)).toEqual(['verse', 'verse']);
    expect(sectionSpans(s, arr).map((x) => [x.name, x.start, x.end, x.inLoop])).toEqual([['A', 0, 4, true], ['B', 4, 6, true]]);
    expect(barSeconds(s)).toBe(2);
  });
});

describe('the report: flags, links and the seam', () => {
  const report: SongReport = {
    id: 'demo', playable: true,
    checks: [
      { name: 'masking', pass: false, advisory: true, skipped: false, value: '', ranges: [{ from: 4, to: 6, note: 'lead and arp share the mid band for 2 s, 3.2 dB apart: lead is the louder', channels: ['lead', 'arp'], band: 'mid' }, { from: 0, to: 1, note: 'x', channels: ['lead', 'arp'], band: 'mid' }] },
      { name: 'loop-music', pass: true, advisory: false, skipped: false, value: 'seam jump 0.01, level step -0.4 dB over 1 s', ranges: [] },
      { name: 'key', pass: false, advisory: false, skipped: false, value: '', ranges: [{ from: 1, to: 1.5, note: 'F#', channel: 'lead' }] },
      { name: 'clip', pass: true, advisory: false, skipped: false, value: '', ranges: [] },
    ],
  };

  it('masking draws on both lanes with its range, and a failing check that names a channel on that lane', () => {
    const f = laneFlags(report, 2);
    expect(f.filter((x) => x.kind === 'masking').map((x) => [x.lanes, x.from, x.to, x.label])).toEqual([
      [['lead', 'arp'], 4, 6, 'masking: lead over arp, mid, bar 3'],
      [['lead', 'arp'], 0, 1, 'masking: lead over arp, mid, bar 1'],
    ]);
    expect(f.find((x) => x.check === 'key')?.lanes).toEqual(['lead']);
    expect(f.some((x) => x.check === 'clip')).toBe(false);
  });

  it('a stretch starting a frame before a bar line belongs to the bar after it, and no bar is past the end', () => {
    expect(barsOf(3.99, 4.8, 2).text).toBe('bar 3');
    expect(barsOf(2, 6, 2).text).toBe('bars 2–3');
    expect(barsOf(7.5, 8.6, 2, 4).text).toBe('bar 4');
    expect(barsOf(0, 8, 2, 4)).toMatchObject({ first: 1, last: 4 });
  });

  it('a pair of channels is one link, with its longest stretch', () => {
    const l = maskLinks(report);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ a: 'lead', b: 'arp', from: 4, to: 6, band: 'mid' });
    expect(maskLinks(null)).toEqual([]);
  });

  it('the seam badge says pass or fail with the level step', () => {
    expect(seamOf(report)).toEqual({ pass: true, text: 'seam −0.4 dB' });
    expect(seamOf({ ...report, checks: [{ name: 'loop-music', pass: false, advisory: false, skipped: true, value: '', ranges: [] }] })).toBeNull();
  });
});

describe('who wrote a pattern: the tape', () => {
  const pat = (name: string, rows: string) => `pattern set demo.${name} ${JSON.stringify(`pattern ${name} steps=8 tpb=2 bar=4\n${rows}\n`)}`;

  it('rows the agent wrote stay the agent’s until the song is approved or a person edits them', () => {
    reset();
    const tape = [
      e('human:ana', 'g1', 'song new demo tempo=120'),
      e('agent:claude', 'g2', 'arp demo chorus arp "I V" pattern=up rate=1/8 written=8'),
      e('agent:claude', 'g3', 'pattern note add demo.verse lead 2 E5'),
    ];
    let a = patternAuthors(tape, 'demo');
    expect([...a.rows].sort()).toEqual(['chorus/arp', 'verse/lead']);
    expect([...a.patterns].sort()).toEqual(['chorus', 'verse']);
    // a person edits the lead row: it is theirs
    a = patternAuthors([...tape, e('human:ana', 'g4', 'pattern note move demo.verse lead 2 step=3')], 'demo');
    expect([...a.rows]).toEqual(['chorus/arp']);
    // approving the song clears every row written before it
    a = patternAuthors([...tape, e('human:ana', 'g4', 'song mark demo approved')], 'demo');
    expect(a.rows.size).toBe(0);
    // then the agent changes the arp again
    a = patternAuthors([...tape, e('human:ana', 'g4', 'song mark demo approved'), e('agent:claude', 'g5', 'humanise demo chorus arp timing=8 velocity=6 seed=1')], 'demo');
    expect([...a.rows]).toEqual(['chorus/arp']);
  });

  it('undone commands do not count, and other songs are ignored', () => {
    reset();
    const tape = [
      e('agent:claude', 'g1', 'pattern note add demo.verse lead 2 E5'),
      e('agent:claude', 'g2', 'pattern note add other.verse lead 2 E5'),
      e('human:ana', 'g3', 'undo group=g1'),
    ];
    const a = patternAuthors(tape, 'demo');
    expect(a.rows.size).toBe(0);
  });

  it('a pattern set marks only the rows whose cells changed since the tape last said', () => {
    reset();
    const rows1 = '  lead: C5 . E5 - | G5 - E5 .\n  bass: C3 . . . | G2 . . .';
    const rows2 = '  lead: C5 . E5 - | G5 - E5 .\n  bass: C3 . . . | G2 . . D2';
    const tape = [e('human:ana', 'g1', pat('verse', rows1)), e('agent:claude', 'g2', pat('verse', rows2))];
    const a = patternAuthors(tape, 'demo');
    expect([...a.rows]).toEqual(['verse/bass']);
  });
});

describe('the agent tick on the mixer', () => {
  it('lists the parameters whose latest change is the agent’s, with the value before', () => {
    reset();
    const tape = [
      e('human:ana', 'g1', 'song channel add demo lead inst=pulse_lead gain=0.8 pan=0'),
      e('agent:claude', 'g2', 'song channel set demo lead pan=0.4 reverb=0.2'),
      e('agent:claude', 'g3', 'song send demo reverb size=0.7'),
      e('agent:claude', 'g4', 'song fx set demo 1 ceiling=-2'),
      e('human:ana', 'g5', 'song channel set demo lead gain=0.5'),
    ];
    const t = paramTrails(tape, 'demo');
    expect(t.get('lead.pan')).toMatchObject({ by: 'agent', value: 0.4, prev: 0 });
    expect(t.get('lead.reverb')).toMatchObject({ value: 0.2, prev: null });
    expect(t.get('bus.reverb.size')?.value).toBe(0.7);
    expect(t.get('master.1.ceiling')?.value).toBe(-2);
    expect(t.has('lead.gain')).toBe(false);
    // a person's later edit, or an approval, takes the tick away
    const t2 = paramTrails([...tape, e('human:ana', 'g6', 'song channel set demo lead pan=0.1')], 'demo');
    expect(t2.has('lead.pan')).toBe(false);
    expect(paramTrails([...tape, e('human:ana', 'g6', 'song mark demo approved')], 'demo').size).toBe(0);
  });
});

describe('the pattern text', () => {
  const text = formatPattern(song().patterns.get('verse')!);

  it('tokens know their row and step; a bar line is not a step', () => {
    const toks = textTokens(text);
    const lead = toks.filter((t) => t.channel === 'lead');
    expect(lead.map((t) => [t.step, t.text])).toEqual([[0, 'C5'], [1, '.'], [2, 'E5'], [3, '-'], [4, 'G5'], [5, '-'], [6, 'E5'], [7, '.']]);
    expect(lead[0]!.line).toBe(1);
    expect(textTokens('  lead= 0:C5*2 4:E5v90*4').map((t) => [t.step, t.text])).toEqual([[0, 'C5*2'], [4, 'E5v90*4']]);
    expect(tokenMidis('C4+E4')).toEqual([60, 64]);
    expect(tokenMidis('k')).toEqual([]);
  });

  it('selected notes light their tokens; a caret in a token picks its notes', () => {
    const toks = textTokens(text);
    const lit = selectedTokens(toks, 'lead', new Set(['2:76', '6:76']));
    expect(lit.map((t) => t.step)).toEqual([2, 6]);
    expect(selectedTokens(toks, 'bass', new Set(['2:76']))).toEqual([]);
    const t = toks.find((x) => x.channel === 'lead' && x.step === 4)!;
    expect([...notesAt(toks, 'lead', [{ line: t.line, col: t.col + 1 }, { line: t.line, col: t.col + 1 }])]).toEqual(['4:79']);
  });

  it('offsets and line/column agree', () => {
    const o = offsetOf(text, 2, 5);
    expect(lineCol(text, o)).toEqual({ line: 2, col: 5 });
    expect(offsetOf('ab\ncd', 9, 9)).toBe(5);
    expect([...rowLines(text)]).toEqual([['lead', 1], ['bass', 2], ['drums', 3]]);
  });

  it('text that means something new is a pattern set; the same meaning, or a problem, writes nothing', () => {
    const s = song();
    const pat = s.patterns.get('verse')!;
    expect(textEdit('demo', pat, text)).toMatchObject({ cmd: null, errors: [] });
    // the person's layout (extra spaces) is the same pattern
    expect(textEdit('demo', pat, text.replace('C5 .', 'C5   .')).cmd).toBeNull();
    const changed = textEdit('demo', pat, text.replace('lead:  C5', 'lead:  D5'));
    expect(changed.errors).toEqual([]);
    expect(changed.cmd).toMatch(/^pattern set demo\.verse "pattern verse steps=8 tpb=2 bar=4\\n {2}lead: {2}D5/);
    const bad = textEdit('demo', pat, text.replace('E5', 'Q9'));
    expect(bad.cmd).toBeNull();
    expect(bad.errors[0]!.message).toMatch(/not a note/);
    expect(bad.errors[0]!.line).toBe(2);
  });
});
