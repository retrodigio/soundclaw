// The composition step in a project: the style guide and bible files, from-bible and stingers
// written to the tape as plain commands, helpers replayed from the tape, and the style check.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatPattern } from '@soundclaw/core';
import { fixture, type Fixture } from './helpers.ts';
import { formatRun, songChecksText } from '../src/index.ts';

let f: Fixture;
afterEach(() => f?.clean());

const STYLE = 'tempo: 80-140\nscales: major, minor\nforbid: drums in town\n';
const BIBLE = '## square\ntempo: 100\nkey: G:major\ntags: town\ninstruments: lead=square_lead, bass=triangle_bass, drums=kit\nmotif: hook tpb=4 G5 - B5 D6\n';

describe('the music guide in a project', () => {
  it('song new from-bible= goes on the tape as the plain commands it stands for, and the project reopens the same', () => {
    f = fixture();
    writeFileSync(join(f.dir, 'music-style.md'), STYLE);
    writeFileSync(join(f.dir, 'music-bible.md'), BIBLE);
    const r = f.w.run({ commands: 'song new sq from-bible=square\nchords sq v lead "I IV V I" rhythm=beats\nbass sq v bass from=lead style=root-fifth\nmotif write sq hook v lead at=0\nsong section add sq a v', by: 'agent:t' });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.added.map((e) => e.cmd.split(' ').slice(0, 3).join(' '))).toEqual([
      'song new sq', 'song channel add', 'song channel add', 'song channel add', 'motif set sq', 'chords sq v', 'bass sq v', 'motif write sq', 'song section add',
    ]);
    expect(r.added[0]!.cmd).toBe('song new sq tempo=100 key=G:major tags=town bible=square');
    const text = formatRun(r, () => '', () => '', () => '');
    expect(text).toMatch(/#\d+ chords sq v lead "I IV V I" bars=1 rhythm=beats voices=3 range=G3-G5 vel=100 tpb=4 {2}\(wrote:\)\n {8}lead: G4\+B4\+D5/);
    const again = f.reopen();
    expect(formatPattern(again.song('sq').patterns.get('v')!)).toBe(formatPattern(f.w.song('sq').patterns.get('v')!));
    // the bible's drums channel plays nothing yet; with drums written, the town rule flags them
    expect(songChecksText(f.w, 'sq').text).toMatch(/pass style/);
    const d = f.w.run({ commands: 'drums sq v drums rock', by: 'agent:t' });
    expect(d.ok).toBe(true);
    expect(songChecksText(f.w, 'sq').text).toMatch(/FAIL style .*\n.*\n.*drums in town are forbidden: channel drums plays/);
  });
  it('reads the files again when they change, and the checks follow', () => {
    f = fixture();
    expect(f.w.run({ commands: 'song new t tempo=150 key=C:major\nsong channel add t lead inst=square_lead\npattern t.p steps=4 tpb=4\n  lead: C5 . . .\nsong section add t a p', by: 'agent:t' }).ok).toBe(true);
    expect(songChecksText(f.w, 't').text).toMatch(/skip style/);
    writeFileSync(join(f.dir, 'music-style.md'), STYLE);
    expect(songChecksText(f.w, 't').text).toMatch(/FAIL style .*\n.*\n.*tempo 150 is outside 80-140/);
    writeFileSync(join(f.dir, 'music-style.md'), 'tempo: 80-160\n');
    expect(songChecksText(f.w, 't').text).toMatch(/pass style/);
  });
  it('a stinger takes the project\'s key and goes on the tape as plain commands', () => {
    f = fixture();
    writeFileSync(join(f.dir, 'music-style.md'), 'key: E:minor\n');
    const r = f.w.run({ commands: 'song new win kind=stinger template=victory', by: 'agent:t' });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.added[0]!.cmd).toBe('song new win tempo=132 time=4/4 key=E:minor class=stinger kind=stinger tags=stinger');
    expect(r.added.at(-1)!.cmd).toBe('song loop win off');
    expect(f.reopen().song('win').ending).toBe('sting');
  });
});
