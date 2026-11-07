// render-match for legato voices and decaying plucks: a touching note's onset is its pitch change, a
// repeated tied note has none to find, and a pitch tracker that locks onto a sub-harmonic does not
// fail a note that is in fact the written pitch.

import { describe, expect, it } from 'vitest';
import { Library, applyCommand, lookupInstrument, midiFreq, parse, renderMatch, renderSong, serializeInstrument, type SongRender } from '../src/index.ts';

function tape(lib: Library, script: string): void {
  const p = parse(script);
  if (p.errors.length) throw new Error(p.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join('; '));
  for (const c of p.commands) applyCommand(lib, c);
}

/** A song of one channel playing `notes` for `len` steps each, then `rest` rest steps, `per` notes to a pattern. */
function song(def: string, inst: string, notes: string[], o: { tempo?: number; tpb?: number; len: number; rest: number }): Library {
  const lib = new Library();
  const steps = (o.len + o.rest) * 4;
  let s = `song new t tempo=${o.tempo ?? 70} key=C:major\n${def}song channel add t lead inst=${inst}\n`;
  const row = notes.map((n) => `${n}${' -'.repeat(o.len - 1)}${' .'.repeat(o.rest)}`);
  for (let i = 0; i < row.length; i += 4) s += `pattern t.p${i} steps=${steps} tpb=${o.tpb ?? 16}\n  lead: ${row.slice(i, i + 4).join(' ')}\nsong section add t s${i} p${i}\n`;
  tape(lib, s);
  return lib;
}

function match(lib: Library, tweak?: (r: SongRender) => void) {
  const s = lib.songs.get('t')!;
  const r = renderSong(s, { instruments: (i) => lookupInstrument(lib, i) });
  tweak?.(r);
  return renderMatch(s, r, (i) => lookupInstrument(lib, i));
}

const MELODY = ['C4', 'E4', 'G4', 'A4', 'G4', 'E4', 'D4', 'C4', 'E4', 'G4', 'C5', 'A4', 'G4', 'A4', 'G4', 'E4'];
const recorder = (leg: string) => `instrument new rec from=square_lead\ninstrument set rec adsr=0.2,0,1,0.8 range=C3-C6${leg}\n`;

describe('render-match: legato', () => {
  it('a recorder-like melody written nearly legato passes, with and without the legato declaration', () => {
    for (const leg of ['', ' legato=yes']) {
      for (const rest of [0, 1, 2]) {
        const m = match(song(recorder(leg), 'rec', MELODY, { len: 7, rest: rest + 1 }));
        expect(m.check.ranges.map((r) => r.note)).toEqual([]);
        expect(m.check.pass).toBe(true);
      }
    }
  });
  it('notes with no gap at all pass, and the onsets are found by the pitch change', () => {
    const m = match(song(recorder(' legato=yes'), 'rec', MELODY, { len: 8, rest: 0 }));
    expect(m.check.pass).toBe(true);
    const onsets = m.onsets.get('lead')!;
    const written = m.notes.filter((n, i, a) => a.findIndex((x) => x.t === n.t) === i);
    // each detected pitch onset is within 20 ms plus half the attack (100 ms) of the written start
    let near = 0;
    for (const n of written) if (onsets.some((o) => Math.abs(o - n.t) <= 0.12)) near++;
    expect(near).toBeGreaterThan(written.length - 2);
  });
  it('a held drone written as tied notes of one pitch passes', () => {
    const def = 'instrument new drone from=saw_pad\ninstrument set drone adsr=0.3,0,1,0.6 range=C1-C4 legato=yes\n';
    const m = match(song(def, 'drone', ['D2', 'D2', 'D2', 'D2', 'A1', 'A1', 'A1', 'A1'], { tempo: 60, len: 8, rest: 0 }));
    expect(m.check.pass).toBe(true);
  });
  it('a note that does not change the pitch where the score changes it is still caught', () => {
    const lib = song(recorder(' legato=yes'), 'rec', ['C4', 'E4', 'G4', 'A4'], { len: 8, rest: 0 });
    const m = match(lib, (r) => {
      // the channel plays C4 throughout: the E4 and the G4 never sound
      const n = r.length;
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * midiFreq(60) * i) / 44100);
      r.parts[0]!.channels = [x, x];
    });
    expect(m.check.pass).toBe(false);
    expect(m.check.ranges.some((r) => /wrong pitch|no clear onset|onset/.test(r.note))).toBe(true);
  });
  it('legato is a checking declaration: set, normal form, file, reset, refusal; the samples do not change', () => {
    const lib = new Library();
    const p = parse('instrument new x from=square_lead\ninstrument set x legato=yes');
    expect(p.commands[1]!.text).toBe('instrument set x legato=yes');
    for (const c of p.commands) applyCommand(lib, c);
    expect(serializeInstrument(lib.instruments.get('x')!)).toMatch(/^legato yes$/m);
    tape(lib, 'instrument set x legato=no');
    expect(serializeInstrument(lib.instruments.get('x')!)).not.toMatch(/legato/);
    expect(parse('instrument set x legato=maybe').errors[0]!.message).toMatch(/legato is yes or no/);
    const a = song('instrument new r1 from=square_lead\n', 'r1', ['C4', 'D4', 'E4', 'F4'], { len: 4, rest: 0 });
    const b = song('instrument new r1 from=square_lead\ninstrument set r1 legato=yes\n', 'r1', ['C4', 'D4', 'E4', 'F4'], { len: 4, rest: 0 });
    const ra = renderSong(a.songs.get('t')!, { instruments: (i) => lookupInstrument(a, i) });
    const rb = renderSong(b.songs.get('t')!, { instruments: (i) => lookupInstrument(b, i) });
    expect(Buffer.from(rb.mix[0].buffer).equals(Buffer.from(ra.mix[0].buffer))).toBe(true);
  });
});

describe('render-match: pitch of decaying plucks', () => {
  it('a tracker that hears a sub-harmonic does not fail the written pitch', () => {
    const lib = song('instrument new h from=pluck\n', 'h', ['C4', 'E4', 'G4', 'A4', 'D4', 'F4', 'A3', 'C4'], { tempo: 60, len: 4, rest: 0, tpb: 4 });
    const s = lib.songs.get('t')!;
    const tone = (r: SongRender): void => {
      // a pluck-like tone whose every other cycle is weaker: the signal repeats exactly every two cycles, so a tracker reads half the pitch
      const n = r.length;
      const x = new Float32Array(n);
      for (const e of r.events.get('lead')!) {
        const f = midiFreq(e.midi!);
        const a = Math.round(e.t * 44100), b = Math.min(n, a + Math.round(e.len * 44100));
        for (let i = a; i < b; i++) {
          const ph = (f * (i - a)) / 44100;
          const cyc = Math.floor(ph);
          x[i] = 0.4 * Math.exp(-(i - a) / 44100 / 0.8) * (1 + 0.35 * (cyc % 2 ? 1 : -1)) * Math.sin(2 * Math.PI * ph);
        }
      }
      r.parts[0]!.channels = [x, x];
    };
    const m = match(lib, tone);
    expect(m.check.ranges.map((r) => r.note)).toEqual([]);
    expect(s.channels.length).toBe(1);
  });
  it('a pluck an octave off, or a semitone off, still fails', () => {
    for (const shift of [12, 1, -12]) {
      const lib = song('instrument new h from=pluck\n', 'h', ['C4', 'E4', 'G4', 'A4'], { tempo: 60, len: 4, rest: 0, tpb: 4 });
      const m = match(lib, (r) => {
        const n = r.length;
        const x = new Float32Array(n);
        for (const e of r.events.get('lead')!) {
          const f = midiFreq(e.midi! + shift);
          const a = Math.round(e.t * 44100), b = Math.min(n, a + Math.round(e.len * 44100));
          for (let i = a; i < b; i++) x[i] = 0.4 * Math.exp(-(i - a) / 44100 / 0.8) * Math.sin((2 * Math.PI * f * (i - a)) / 44100);
        }
        r.parts[0]!.channels = [x, x];
      });
      expect(m.check.pass, `shift ${shift}`).toBe(false);
    }
  });
  it('a 188-note pluck line with a long ring passes without a helper layer', () => {
    let seed = 11;
    const rnd = (n: number): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
    const scale = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
    const notes = Array.from({ length: 188 }, () => `${scale[rnd(7)]}${2 + rnd(4)}`);
    const lib = song('instrument new harp from=pluck\ninstrument set harp adsr=0.001,0,1,0.8 range=C2-C6\n', 'harp', notes, { tempo: 80, tpb: 4, len: 2, rest: 2 });
    const m = match(lib);
    expect(m.notes.length).toBe(188);
    expect(m.check.ranges.map((r) => r.note)).toEqual([]);
  });
});
