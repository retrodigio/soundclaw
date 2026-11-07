// Songs on the server: the project files, validation, the checks and `work done`, export, stems, normalising.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyze, decodeWav, songToMidi, parseMidi } from '@soundclaw/core';
import { agentWork, exportSong, normalizeSong, personRequest, songChecksText, songJsonObject, songNumbersText, songSummary, viewSong } from '../src/index.ts';
import { fixture, type Fixture } from './helpers.ts';
import { readOgg } from './ogg.ts';

let f: Fixture;
beforeEach(() => { f = fixture(); });
afterEach(() => f.clean());

const claude = 'agent:claude';
const SONG = `song new demo tempo=120 key=C:major class=music
song channel add demo lead inst=square_lead gain=0.8 layer=tension
song channel add demo bass inst=triangle_bass layer=base
song channel add demo drums kit=default layer=base
pattern demo.verse steps=16 tpb=4 bar=8
  lead: C5 . E5 . G5 - - . | A4 . . . G4 . E4 .
  bass: C3 . . . C3 . . . | A2 . . . G2 . . .
  drums: k . h . s . h . | k k h . s . h h
song section add demo A verse x2
`;
const run = (cmds: string, by = claude) => { const r = f.w.run({ commands: cmds, by }); if (!r.ok) throw new Error(r.errors.map((e) => `${e.line}: ${e.message}`).join('; ')); return r; };

describe('the project files', () => {
  it('a song is songs/<id>.song with each pattern in songs/<id>/patterns/<name>.pat, and an instrument is instruments/<id>.inst', () => {
    run(`instrument new bell2 from=fm_bell\n${SONG}`);
    expect(existsSync(join(f.dir, 'songs', 'demo.song'))).toBe(true);
    expect(readFileSync(join(f.dir, 'songs', 'demo', 'patterns', 'verse.pat'), 'utf8')).toMatch(/^pattern verse steps=16 tpb=4 bar=8\n {2}lead:/);
    expect(readdirSync(join(f.dir, 'instruments'))).toContain('bell2.inst');
    expect(readFileSync(join(f.dir, 'songs', 'demo.song'), 'utf8')).toMatch(/channel drums kit=default gain=1 pan=0 layer=base/);
  });

  it('undo takes the song and its files away, redo brings them back, and a restart replays the tape to the same song', () => {
    const r = run(SONG);
    run('undo', claude);
    expect(f.w.hasSong('demo')).toBe(false);
    expect(existsSync(join(f.dir, 'songs', 'demo.song'))).toBe(false);
    expect(existsSync(join(f.dir, 'songs', 'demo'))).toBe(false);
    run('redo group=g2');
    expect(f.w.hasSong('demo')).toBe(true);
    const w2 = f.reopen();
    expect(w2.song('demo').patterns.get('verse')!.steps).toBe(16);
    expect(w2.song('demo').sections).toEqual([{ name: 'A', patterns: ['verse'], repeat: 2 }]);
    void r;
  });

  it('a pattern edit is one command on the tape, with the pattern text in its normal form', () => {
    run(SONG);
    run('pattern set demo.verse "pattern verse steps=4 tpb=4\\n  lead: C5 . E5 .\\n  bass: C3 . . .\\n  drums: k . h ."');
    const last = f.w.tape().at(-1)!;
    expect(last.cmd).toMatch(/^pattern set demo\.verse "pattern verse steps=4 tpb=4\\n {2}lead: {2}C5 \. E5 \./);
    expect(f.w.song('demo').patterns.get('verse')!.steps).toBe(4);
  });
});

describe('what a batch must leave playable', () => {
  it('a channel that names an instrument that does not exist is refused, and nothing is written', () => {
    const r = f.w.run({ commands: 'song new s\nsong channel add s lead inst=nothing', by: claude });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/channel lead plays instrument 'nothing', which does not exist/);
    expect(f.w.hasSong('s')).toBe(false);
  });
  it('a drum hit in a pitched channel, and a note in a drum channel, are refused with the step', () => {
    let r = f.w.run({ commands: 'song new s\nsong channel add s lead inst=square_lead\npattern s.p steps=2 tpb=4\n  lead: k .\nsong section add s A p', by: claude });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/channel lead plays instrument square_lead, but step 0 is a drum hit 'k'/);
    r = f.w.run({ commands: 'song new s\nsong channel add s d kit=default\npattern s.p steps=2 tpb=4\n  d: C5 .\nsong section add s A p', by: claude });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/is a drum channel \(kit\), but step 0 is a note/);
  });
  it('a drum with no instrument in the kit says how to map it', () => {
    const r = f.w.run({ commands: 'song new s\nsong channel add s d kit=default\npattern s.p steps=2 tpb=4\n  d: gong .\nsong section add s A p', by: claude });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/has no drum 'gong'.*song channel set s d kit=gong:<instrument>/);
  });
  it('a pattern row for a channel the song lacks is a warning, not an error', () => {
    const r = run('song new s\nsong channel add s lead inst=square_lead\npattern s.p steps=2 tpb=4\n  lead: C5 .\n  ghost: C3 .\nsong section add s A p');
    expect(r.warnings.join()).toMatch(/row for channel 'ghost', which the song does not have/);
  });
});

describe('numbers, checks and work done', () => {
  it('the numbers and checks of a song are measured once for each distinct document', () => {
    run(SONG);
    const a = f.w.measureSong('demo');
    expect(f.w.measureSong('demo')).toBe(a);
    expect(a.report.numbers.tempo).toBe(120);
    expect(a.report.numbers.layers).toEqual(['tension', 'base']);
    run('song set demo tempo=121');
    expect(f.w.measureSong('demo')).not.toBe(a);
  });

  it('the text says what an agent needs: the summary line, the numbers and each failing check with its places', () => {
    run(SONG);
    expect(songSummary(f.w, 'demo')).toMatch(/^demo: song, 120 bpm 4\/4, key C:major, 3 channels \(lead, bass, drums\), 1 pattern, 4 s, loop 4 s, layers tension \+ base\n\s+[-\d.]+ LUFS \(class music, -16 ±2\), true peak [-\d.]+ dBTP\n\s+checks: /);
    expect(songNumbersText(f.w, 'demo')).toMatch(/channels \(alone, before the master chain\):\n\s+lead .* 12 notes/);
    const c = songChecksText(f.w, 'demo');
    expect(c.text).toMatch(/pass clip/);
    expect(c.text).toMatch(/render-match/);
    const j = songJsonObject(f.w, 'demo') as { playable: boolean; checks: { name: string }[]; numbers: { channels: unknown[] } };
    expect(j.checks.map((x) => x.name)).toEqual(['clip', 'loudness', 'dc', 'key', 'range', 'render-match', 'loop-music', 'masking', 'voice-leading', 'style', 'layers']);
    expect(j.numbers.channels.length).toBe(3);
  });

  it('a request on a song marks it, and work done needs the checks to pass (masking is advisory)', () => {
    run(SONG.replace('G5 - -', 'F#5 - -')); // F#5 is outside C major
    const q = personRequest(f.w, 'human:ana', { action: 'request', kind: 'change', sound: 'demo', note: 'the lead sounds off' });
    expect(f.w.song('demo').status).toBe('rejected');
    expect(f.w.tape().at(-1)!.cmd).toMatch(/^song mark demo rejected/);
    agentWork(f.w, claude, { action: 'next' });
    // loudness and key fail: not done
    expect(() => agentWork(f.w, claude, { action: 'done', id: q.id, text: 'fixed' })).toThrow(/key: 2 of 20 notes are outside C:major/);
    run('pattern set demo.verse "pattern verse steps=16 tpb=4 bar=8\\n  lead: C5 . E5 . G5 - - . | A4 . . . G4 . E4 .\\n  bass: C3 . . . C3 . . . | A2 . . . G2 . . .\\n  drums: k . h . s . h . | k k h . s . h h"');
    const n = normalizeSong(f.w, 'demo');
    run(n.command!);
    const r = agentWork(f.w, claude, { action: 'done', id: q.id, text: 'fixed the note, normalised' });
    expect(r.request!.state).toBe('done');
  });
});

describe('export', () => {
  beforeEach(() => { run(SONG); });

  it('wav: the whole song, 16-bit stereo 44.1 kHz, with a manifest naming the loop', () => {
    const out = join(f.root, 'out');
    const files = exportSong(f.w, 'demo', { format: 'wav', out });
    const w = decodeWav(new Uint8Array(readFileSync(files[0]!.file)));
    expect([w.channels, w.sampleRate]).toEqual([2, 44100]);
    expect(w.frames).toBeGreaterThanOrEqual(4 * 44100);
    const man = JSON.parse(readFileSync(join(out, 'demo-manifest.json'), 'utf8'));
    expect(man).toMatchObject({ id: 'demo', tempo: 120, loop: { start: 0, length: 4 }, class: 'music', layers: ['tension', 'base'] });
  });

  it('the loop export is exactly the loop length, and its wrap is as smooth as the signal is everywhere else', () => {
    const out = join(f.root, 'out');
    const [file] = exportSong(f.w, 'demo', { format: 'wav', loop: true, out });
    const w = decodeWav(new Uint8Array(readFileSync(file!.file)));
    expect(w.frames).toBe(4 * 44100);
    const ch = Int16Array.from({ length: w.frames }, (_, i) => w.data[2 * i]!); // the left channel
    let biggest = 0;
    for (let i = 1; i < ch.length; i++) biggest = Math.max(biggest, Math.abs(ch[i]! - ch[i - 1]!));
    expect(Math.abs(ch[0]! - ch[ch.length - 1]!)).toBeLessThanOrEqual(biggest);
  });

  it('stems: one aligned file per game layer, the stems of the loop, and they sum to the mix', () => {
    run('song fx remove demo 1; song set demo gain=0.4'); // no limiter and no clipping: the stems and the mix are the same sum
    const out = join(f.root, 'out');
    const files = exportSong(f.w, 'demo', { format: 'wav', stems: true, out });
    expect(files.map((x) => x.file.split('/').pop())).toEqual(['demo-stem-tension.wav', 'demo-stem-base.wav']);
    const stems = files.map((x) => decodeWav(new Uint8Array(readFileSync(x.file))));
    expect(stems[0]!.frames).toBe(stems[1]!.frames);
    expect(stems[0]!.frames).toBe(4 * 44100);
    const [mix] = exportSong(f.w, 'demo', { format: 'wav', loop: true, out: join(f.root, 'out2') });
    const m = decodeWav(new Uint8Array(readFileSync(mix!.file)));
    let worst = 0;
    for (let i = 0; i < m.data.length; i++) worst = Math.max(worst, Math.abs(stems[0]!.data[i]! + stems[1]!.data[i]! - m.data[i]!));
    // 16-bit quantisation of three files: at most two steps apart (the numbers are integers, 32768 = full scale)
    expect(worst).toBeLessThanOrEqual(2);
  });

  it('ogg: a well-formed stereo Vorbis file of the loop with the exact sample count', () => {
    const out = join(f.root, 'out');
    const [file] = exportSong(f.w, 'demo', { format: 'ogg', loop: true, out });
    const info = readOgg(new Uint8Array(readFileSync(file!.file)));
    expect(info.channels).toBe(2);
    expect(info.samples).toBe(4 * 44100);
    expect(info.eos).toBe(true);
  });

  it('midi: the song, or one pattern', () => {
    const out = join(f.root, 'out');
    const files = exportSong(f.w, 'demo', { format: 'midi', out });
    const m = parseMidi(new Uint8Array(readFileSync(files[0]!.file)));
    expect(m.tempo).toBe(120);
    expect(m.notes.length).toBe(2 * (6 + 4 + 10));
    const [one] = exportSong(f.w, 'demo', { format: 'midi', pattern: 'verse', out });
    expect(one!.file).toMatch(/demo-verse\.mid$/);
    void songToMidi;
  });

  it('a song with no loop refuses a loop export, saying how to set one', () => {
    run('song loop demo off');
    expect(() => exportSong(f.w, 'demo', { format: 'wav', loop: true, out: join(f.root, 'o') })).toThrow(/has no loop region/);
  });
});

describe('normalize and views', () => {
  beforeEach(() => { run(SONG); });

  it('normalize writes the song gain that brings the mix to its class target', () => {
    const n = normalizeSong(f.w, 'demo');
    expect(n.command).toMatch(/^song set demo gain=[\d.]+$/);
    run(n.command!);
    const a = f.w.measureSong('demo').report.numbers;
    expect(Math.abs(a.lufs - -16)).toBeLessThan(0.3);
    expect(f.w.measureSong('demo').report.checks.find((c) => c.name === 'loudness')!.pass).toBe(true);
  });

  it('normalize to a target writes it as the song\'s own loudness, and says when the limiter stops it short', () => {
    const n = normalizeSong(f.w, 'demo', -6);
    expect(n.notes.join()).toMatch(/short of -6|stops at/);
    expect(n.command).toMatch(/loudness=-6$/);
  });

  it('the notes view and the mix view are PNGs saved under .cache/views, with the numbers printed', () => {
    const v = viewSong(f.w, 'demo', 'notes');
    expect(v.file).toMatch(/\.cache\/views\/demo-notes-[0-9a-f]{8}\.png$/);
    expect(existsSync(v.file)).toBe(true);
    expect(v.text).toMatch(/notes view: 40 written notes/);
    expect(v.text).toMatch(/loudness .* LUFS/);
    const m = viewSong(f.w, 'demo', 'mix');
    expect(m.text).toMatch(/mix view: \d+ % of the time/);
    expect(() => viewSong(f.w, 'demo', 'notes', { channels: ['nope'] })).toThrow(/no channel 'nope'/);
    const loop = viewSong(f.w, 'demo', 'loop');
    expect(loop.text).toMatch(/loop view: seam jump/);
    void analyze;
  });
});

describe('history', () => {
  it('--sound names a song: its own commands, its channels, sections and patterns', () => {
    run(`instrument new bell2 from=fm_bell\ninstrument layer set bell2 1 ratio2=2\n${SONG}`);
    run('song new other');
    const mine = f.w.history({ sound: 'demo' }).map((e) => e.cmd.split(' ').slice(0, 3).join(' '));
    expect(mine).toEqual(['song new demo', 'song channel add', 'song channel add', 'song channel add', 'pattern set demo.verse', 'song section add']);
    expect(f.w.history({ sound: 'bell2' }).map((e) => e.cmd.split(' ').slice(0, 3).join(' '))).toEqual(['instrument new bell2', 'instrument layer set']);
  });
});
