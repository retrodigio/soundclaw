// Stinger templates: short pieces with a fixed ending that never loop (victory, game over, level
// up, item get). Each is written in scale degrees, so it lands in any key: `song new <id>
// kind=stinger template=victory [key=…]` writes the song as plain commands (channels, one
// pattern, the section as the ending, the loop off, the stinger loudness class).
//
// A template row is a token per step: a degree (1 the tonic, 8 the octave above, `3v80` with a
// velocity), `t<degree>` the triad on that degree, `-` hold, `.` rest, or a drum hit.

import { quote } from './commands.ts';
import { noteLabel, parseKey, type Key } from './music.ts';
import { builtinInstruments } from './instrument.ts';
import { degreeNote } from './theory.ts';

interface Part { name: string; inst: string; gain: number; octave: number; row: string }

export interface StingerTemplate {
  about: string;
  tempo: number;
  tpb: number;
  parts: Part[];
  drums: string | null;
}

export const STINGER_TEMPLATES: Readonly<Record<string, StingerTemplate>> = {
  victory: {
    about: 'a rising arpeggio and a held tonic chord, about 3.6 s',
    tempo: 132, tpb: 2,
    parts: [
      { name: 'lead', inst: 'square_lead', gain: 0.56, octave: 5, row: '1 3 5 3 5 8 . 7 | 8 - - - - - - -' },
      { name: 'harm', inst: 'pluck', gain: 0.39, octave: 4, row: 't1 - - - t4 - t5 - | t1 - - - - - - -' },
      { name: 'bass', inst: 'triangle_bass', gain: 0.56, octave: 2, row: '1 . 1 . 4 . 5 . | 1 - - - - - - -' },
    ],
    drums: 'k . s . k k s . | k . . . . . . .',
  },
  'game-over': {
    about: 'a slow fall from the fifth to the tonic over vi IV V I, about 4.8 s',
    tempo: 100, tpb: 2,
    parts: [
      { name: 'lead', inst: 'pulse_lead', gain: 0.69, octave: 4, row: '5 . 4 . 3 . 2 . | 1 - - - - - - -' },
      { name: 'harm', inst: 'saw_pad', gain: 0.69, octave: 3, row: 't6 - - - t4 - t5 - | t1 - - - - - - -' },
      { name: 'bass', inst: 'triangle_bass', gain: 0.78, octave: 2, row: '6 - - - 4 - 5 - | 1 - - - - - - -' },
    ],
    drums: 'kv70 . . . kv70 . . . | kv70 . . . . . . .',
  },
  'level-up': {
    about: 'a scale run up an octave over IV V I, about 1.6 s',
    tempo: 150, tpb: 4,
    parts: [
      { name: 'lead', inst: 'square_lead', gain: 0.52, octave: 5, row: '1 2 3 4 5 6 7 8 5 . 8 - - - - -' },
      { name: 'harm', inst: 'pluck', gain: 0.39, octave: 4, row: 't4 - - - t5 - - - t1 - - - - - - -' },
      { name: 'bass', inst: 'triangle_bass', gain: 0.56, octave: 3, row: '4 . . . 5 . . . 1 - - - - - - -' },
    ],
    drums: 'k . . . k . . . k . s . . . . .',
  },
  'item-get': {
    about: 'a quick sparkle up two octaves to a held tonic, about 1.7 s',
    tempo: 140, tpb: 4,
    parts: [
      { name: 'lead', inst: 'fm_bell', gain: 0.65, octave: 4, row: '1 3 5 8 10 12 15 - - - - - - - - -' },
      { name: 'harm', inst: 'pluck', gain: 0.47, octave: 4, row: '. . . . . . t1 - - - - - - - - -' },
      { name: 'bass', inst: 'triangle_bass', gain: 0.69, octave: 3, row: '. . . . . . 1 - - - - - - - - -' },
    ],
    drums: null,
  },
};

function cellOf(tok: string, key: Key, octave: number): string {
  if (tok === '-' || tok === '.') return tok;
  const t = /^(t?)(\d+)(v\d+)?$/.exec(tok);
  if (!t) return tok;
  const deg = Number(t[2]);
  const vel = t[3] ?? '';
  if (t[1]) return [0, 2, 4].map((k) => noteLabel(degreeNote(key, deg + k, octave), key.flats) + vel).join('+');
  return noteLabel(degreeNote(key, deg, octave), key.flats) + vel;
}

/** The part's octave in a key: the template's, moved an octave when that keeps the part inside its instrument's range. */
function octaveFor(p: Part, key: Key): number {
  const range = builtinInstruments()[p.inst]?.range;
  if (!range) return p.octave;
  const notes = (o: number): number[] => p.row.split(/\s+/).flatMap((w) => {
    const t = /^(t?)(\d+)/.exec(w);
    if (!t) return [];
    const deg = Number(t[2]);
    return (t[1] ? [deg, deg + 2, deg + 4] : [deg]).map((d) => degreeNote(key, d, o));
  });
  let o = p.octave;
  if (Math.max(...notes(o)) > range[1] && Math.min(...notes(o - 1)) >= range[0]) o--;
  else if (Math.min(...notes(o)) < range[0] && Math.max(...notes(o + 1)) <= range[1]) o++;
  return o;
}

/** The commands a stinger template writes, in a key. */
export function stingerCommands(id: string, template: string, keyText: string, given: Map<string, string>): string[] {
  const t = STINGER_TEMPLATES[template];
  if (!t) throw new Error(`no stinger template '${template}' (${Object.keys(STINGER_TEMPLATES).join(', ')})`);
  const key = parseKey(keyText);
  const v = new Map<string, string>([['tempo', String(t.tempo)], ['time', '4/4'], ['key', keyText], ['class', 'stinger'], ['kind', 'stinger'], ['tags', 'stinger']]);
  for (const [k, x] of given) v.set(k, x);
  const lines = [`song new ${id}${[...v].map(([k, x]) => ` ${k}=${x}`).join('')}`];
  for (const p of t.parts) lines.push(`song channel add ${id} ${p.name} inst=${p.inst} gain=${p.gain}`);
  if (t.drums) lines.push(`song channel add ${id} drums kit=default gain=0.5`);
  const steps = t.parts[0]!.row.split(/\s+/).filter((w) => w !== '|').length;
  const rows = t.parts.map((p) => `  ${p.name}: ${p.row.split(/\s+/).map((w) => (w === '|' ? w : cellOf(w, key, octaveFor(p, key)))).join(' ')}`);
  if (t.drums) rows.push(`  drums: ${t.drums}`);
  lines.push(`pattern set ${id}.sting ${quote(`pattern sting steps=${steps} tpb=${t.tpb}\n${rows.join('\n')}`)}`);
  lines.push(`song section add ${id} sting sting`, `song ending ${id} sting`, `song loop ${id} off`);
  return lines;
}
