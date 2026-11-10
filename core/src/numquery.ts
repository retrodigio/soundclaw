// The numbers query: one small language for every search and filter over sounds and samples.
//
//   "creak" dur=0.8-2.5 lufs>-30 centroid<2.5k attack<20ms pitched=no onsets=1 loop=no channels=1 tag=wood source=library licence=shippable
//
// Plain words (bare or quoted) match names and tags; `key<op>value` terms test measured numbers or text. The
// keys are a table (QUERY_KEYS) that the parser, the matcher and the docs all read. Units are the ones the
// knobs take: `ms`, `s`, `k` (kilo), `Hz`, `dB`, `LU`, note names for pitch. Values are kept in each key's own unit.

export type KeyKind = 'num' | 'note' | 'bool' | 'text' | 'tags';
/** The kind of unit a numeric key takes. */
export type Dim = 'seconds' | 'ms' | 'hz' | 'level' | 'bpm' | 'plain';

export interface QueryKey {
  key: string;
  /** The unit values are held in (shown in help; a bare number means this). */
  unit: string;
  kind: KeyKind;
  dim: Dim;
  help: string;
  /** How far outside a range counts as "one unit away" when ranking by closeness. */
  scale: number;
  aliases?: readonly string[];
}

const k = (key: string, unit: string, kind: KeyKind, dim: Dim, scale: number, help: string, aliases?: readonly string[]): QueryKey => ({ key, unit, kind, dim, scale, help, ...(aliases ? { aliases } : {}) });

export const QUERY_KEYS: readonly QueryKey[] = [
  k('dur', 's', 'num', 'seconds', 1, 'length', ['duration']),
  k('lufs', 'LUFS', 'num', 'level', 6, 'integrated loudness', ['loudness']),
  k('peak', 'dB', 'num', 'level', 3, 'sample peak level'),
  k('rms', 'dB', 'num', 'level', 6, 'RMS level'),
  k('centroid', 'Hz', 'num', 'hz', 1000, 'spectral centroid (brightness)', ['brightness']),
  k('flatness', '', 'num', 'plain', 0.2, 'spectral flatness, 0 (tonal) to 1 (noise)'),
  k('attack', 'ms', 'num', 'ms', 20, 'time to reach the peak'),
  k('decay', 's', 'num', 'seconds', 0.5, 'time to fall 60 dB after the peak'),
  k('noise', 'dBFS', 'num', 'level', 10, 'noise floor'),
  k('harmonicity', 'dB', 'num', 'level', 6, 'harmonic-to-noise ratio'),
  k('pitch', 'MIDI note', 'note', 'plain', 12, 'measured pitch: a note name (C4) or a MIDI number', ['note']),
  k('pitched', 'yes/no', 'bool', 'plain', 1, 'has a clear pitch'),
  k('onsets', '', 'num', 'plain', 2, 'number of onsets (hits)'),
  k('onsetrate', '/s', 'num', 'plain', 2, 'onsets per second'),
  k('tempo', 'bpm', 'num', 'bpm', 20, 'estimated tempo'),
  k('loop', 'yes/no', 'bool', 'plain', 1, 'has loop points'),
  k('channels', '', 'num', 'plain', 1, 'number of channels'),
  k('samplerate', 'Hz', 'num', 'hz', 10000, 'sample rate of the file', ['sr']),
  k('bits', '', 'num', 'plain', 8, 'bit depth'),
  k('width', '', 'num', 'plain', 0.3, 'stereo width, 0 (mono) to 1'),
  k('silence-start', 'ms', 'num', 'ms', 50, 'silence at the start'),
  k('silence-end', 'ms', 'num', 'ms', 50, 'silence at the end'),
  k('clips', '', 'num', 'plain', 1, 'runs at full scale'),
  k('tag', 'text', 'tags', 'plain', 1, 'a tag of the entry (repeat for all of them)', ['tags']),
  k('source', 'text', 'text', 'plain', 1, 'where it came from (file, library, recorded, generated, derived, bounce, ...)'),
  k('licence', 'text', 'text', 'plain', 1, 'shippable, attribution, blocked, unknown, or an SPDX id', ['license']),
  k('name', 'text', 'text', 'plain', 1, 'part of the name'),
];

const BY_NAME = new Map<string, QueryKey>();
for (const q of QUERY_KEYS) { BY_NAME.set(q.key, q); for (const a of q.aliases ?? []) BY_NAME.set(a, q); }
const keyList = (): string => QUERY_KEYS.map((q) => q.key).join(', ');

export type Op = '=' | '<' | '>' | '<=' | '>=' | '!=';

export interface QueryTerm {
  key: string;
  op: Op;
  kind: KeyKind;
  /** Numbers and notes: a range (lo = hi for a single value), in the key's unit. */
  lo?: number;
  hi?: number;
  bool?: boolean;
  text?: string;
}

export interface Query {
  words: string[];
  terms: QueryTerm[];
}

// ---- parsing ----------------------------------------------------------------------------------------------

function tokens(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (const ch of text) {
    if (ch === '"') { inQ = !inQ; cur += ch; } else if (/\s/.test(ch) && !inQ) { if (cur) out.push(cur); cur = ''; } else cur += ch;
  }
  if (inQ) throw new Error('a quote is not closed');
  if (cur) out.push(cur);
  return out;
}

const unquote = (s: string): string => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s.replace(/"/g, ''));

const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n: number): string => `${NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;

const UNITS: Record<string, { dim: Dim; mul: number }> = {
  s: { dim: 'seconds', mul: 1 }, ms: { dim: 'ms', mul: 1 }, hz: { dim: 'hz', mul: 1 }, khz: { dim: 'hz', mul: 1000 },
  db: { dim: 'level', mul: 1 }, lu: { dim: 'level', mul: 1 }, dbfs: { dim: 'level', mul: 1 }, lufs: { dim: 'level', mul: 1 }, bpm: { dim: 'bpm', mul: 1 },
};
const DIM_UNITS: Record<Dim, string> = { seconds: 's or ms', ms: 'ms or s', hz: 'Hz or k', level: 'dB or LU', bpm: 'bpm', plain: 'no unit' };
const DIM_WORD: Record<Dim, string> = { seconds: 'a time', ms: 'a time', hz: 'a frequency', level: 'a level', bpm: 'a tempo', plain: 'a plain number' };

/** One number with an optional unit, in the key's unit; null when it is not a number at all; throws for a wrong unit. */
function scalar(s: string, ky: QueryKey, whole: string): number | null {
  if (ky.kind === 'note') {
    const m = /^([A-G])([#b]?)(-?\d)$/.exec(s);
    if (m) {
      const n = (Number(m[3]) + 1) * 12 + LETTER[m[1]!]! + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
      if (n < 0 || n > 127) throw new Error(`${whole}: ${s} is outside the MIDI notes (C-1 to G9)`);
      return n;
    }
  }
  const m = /^(-?(?:\d+\.?\d*|\.\d+))([A-Za-z]*)$/.exec(s);
  if (!m) return null;
  let v = Number(m[1]);
  const u = m[2]!;
  if (!u) return v;
  const lu = u.toLowerCase();
  if (lu === 'k') {
    if (ky.dim === 'hz' || ky.dim === 'plain' && ky.kind === 'num') return v * 1000;
    throw new Error(`${whole}: 'k' (thousands) does not fit ${ky.key}, which is in ${ky.unit || 'plain numbers'}`);
  }
  const unit = UNITS[lu];
  if (!unit) throw new Error(`${whole}: unknown unit '${u}' (${ky.key} takes ${DIM_UNITS[ky.dim]})`);
  if (unit.dim === 'seconds' || unit.dim === 'ms') {
    if (ky.dim !== 'seconds' && ky.dim !== 'ms') throw new Error(`${whole}: '${u}' is a time; ${ky.key} takes ${DIM_UNITS[ky.dim]}`);
    const sec = lu === 'ms' ? v / 1000 : v;
    v = ky.dim === 'seconds' ? sec : sec * 1000;
    return Math.round(v * 1e9) / 1e9;
  }
  if (unit.dim !== ky.dim) throw new Error(`${whole}: '${u}' is ${DIM_WORD[unit.dim]}; ${ky.key} takes ${DIM_UNITS[ky.dim]}`);
  return v * unit.mul;
}

function range(s: string, ky: QueryKey, whole: string): [number, number] {
  const one = scalar(s, ky, whole);
  if (one !== null) return [one, one];
  for (let i = 1; i < s.length - 1; i++) {
    if (s[i] !== '-') continue;
    const a = scalar(s.slice(0, i), ky, whole);
    if (a === null) continue;
    const b = scalar(s.slice(i + 1), ky, whole);
    if (b === null) continue;
    if (b < a) throw new Error(`${whole}: the range runs backwards (${s})`);
    return [a, b];
  }
  const hint = ky.kind === 'note' ? 'a note like C4, a MIDI number or a range like C3-C5' : `a number${ky.unit ? ` in ${ky.unit}` : ''}, or a range like 1-2.5${ky.dim !== 'plain' ? `; units: ${DIM_UNITS[ky.dim]}` : ''}`;
  throw new Error(`${whole}: '${s}' is not ${hint}`);
}

const TERM_RE = /^([A-Za-z][A-Za-z-]*)(<=|>=|!=|=|<|>)(.*)$/s;

export function parseQuery(text: string): Query {
  const words: string[] = [];
  const terms: QueryTerm[] = [];
  for (const tok of tokens(text)) {
    const m = tok.startsWith('"') ? null : TERM_RE.exec(tok);
    if (!m) { const w = unquote(tok); if (w) words.push(w); continue; }
    const name = m[1]!.toLowerCase();
    const op = m[2] as Op;
    const raw = unquote(m[3]!);
    const ky = BY_NAME.get(name);
    if (!ky) throw new Error(`${tok}: no key '${m[1]}' (keys: ${keyList()})`);
    if (!raw) throw new Error(`${tok}: give a value after ${op}`);
    if (ky.kind === 'bool' || ky.kind === 'text' || ky.kind === 'tags') {
      if (op !== '=' && op !== '!=') throw new Error(`${tok}: ${ky.key} is ${ky.kind === 'bool' ? 'yes or no' : 'text'}, so it takes = or != (not ${op})`);
      if (ky.kind === 'bool') {
        const v = raw.toLowerCase();
        if (!['yes', 'no', 'true', 'false'].includes(v)) throw new Error(`${tok}: ${ky.key} is yes or no (got '${raw}')`);
        terms.push({ key: ky.key, op, kind: 'bool', bool: v === 'yes' || v === 'true' });
      } else terms.push({ key: ky.key, op, kind: ky.kind, text: raw.toLowerCase() });
      continue;
    }
    if (op !== '=' && op !== '!=') {
      const v = scalar(raw, ky, tok);
      if (v === null) throw new Error(`${tok}: '${raw}' is not a ${ky.kind === 'note' ? 'note or MIDI number' : `number${ky.unit ? ` in ${ky.unit}` : ''}`}${ky.dim !== 'plain' ? ` (units: ${DIM_UNITS[ky.dim]})` : ''}`);
      terms.push({ key: ky.key, op, kind: ky.kind, lo: v, hi: v });
    } else {
      const [lo, hi] = range(raw, ky, tok);
      terms.push({ key: ky.key, op, kind: ky.kind, lo, hi });
    }
  }
  return { words, terms };
}

// ---- normal form --------------------------------------------------------------------------------------------

const num = (n: number): string => String(Math.round(n * 1e6) / 1e6);

export function formatTerm(t: QueryTerm): string {
  if (t.kind === 'bool') return `${t.key}${t.op}${t.bool ? 'yes' : 'no'}`;
  if (t.kind === 'text' || t.kind === 'tags') return `${t.key}${t.op}${/^[^\s"]+$/.test(t.text!) ? t.text : `"${t.text}"`}`;
  const f = t.kind === 'note' ? noteName : num;
  return `${t.key}${t.op}${t.lo === t.hi ? f(t.lo!) : `${f(t.lo!)}-${f(t.hi!)}`}`;
}

export function formatQuery(q: Query): string {
  return [...q.words.map((w) => (/^[^\s"]+$/.test(w) && !TERM_RE.test(w) ? w : `"${w}"`)), ...q.terms.map(formatTerm)].join(' ');
}

// ---- matching -----------------------------------------------------------------------------------------------

export type QueryFacts = Partial<Record<string, number | boolean | string | string[] | null>>;

export interface QueryMatch {
  match: boolean;
  /** 0 when everything is inside its range; grows with the distance outside (each key normalised by its scale). */
  closeness: number;
  /** The words and terms that did not hold (including those that could not be evaluated). */
  failed: string[];
  /** The terms whose measure was not available. */
  unknown: string[];
}

const EPS = 1e-9;

export function matchQuery(q: Query, facts: QueryFacts, name: string, tags: readonly string[]): QueryMatch {
  const failed: string[] = [];
  const unknown: string[] = [];
  let closeness = 0;
  const lname = name.toLowerCase();
  const ltags = tags.map((t) => t.toLowerCase());
  for (const w of q.words) {
    const lw = w.toLowerCase();
    if (!lname.includes(lw) && !ltags.some((t) => t.includes(lw))) { failed.push(`"${w}"`); closeness += 1; }
  }
  for (const t of q.terms) {
    const label = formatTerm(t);
    const ky = BY_NAME.get(t.key)!;
    let ok: boolean;
    let miss = 0;
    if (t.kind === 'tags') {
      const has = ltags.includes(t.text!) || (Array.isArray(facts.tag) && facts.tag.some((x) => x.toLowerCase() === t.text));
      ok = t.op === '=' ? has : !has;
      miss = 1;
    } else if (t.key === 'name') {
      const has = lname.includes(t.text!);
      ok = t.op === '=' ? has : !has;
      miss = 1;
    } else {
      const f = facts[t.key];
      if (f === undefined || f === null) { unknown.push(label); failed.push(label); closeness += 1; continue; }
      if (t.kind === 'bool') { ok = (f === t.bool) === (t.op === '='); miss = 1; }
      else if (t.kind === 'text') {
        const vals = (Array.isArray(f) ? f : [String(f)]).map((x) => x.toLowerCase());
        const has = vals.includes(t.text!);
        ok = t.op === '=' ? has : !has;
        miss = 1;
      } else {
        const x = Number(f);
        const lo = t.lo!, hi = t.hi!;
        const dist = (below: number, above: number): number => Math.max(0, below, above);
        switch (t.op) {
          case '=': ok = x >= lo - EPS * Math.max(1, Math.abs(lo)) && x <= hi + EPS * Math.max(1, Math.abs(hi)); miss = dist(lo - x, x - hi); break;
          case '!=': ok = !(x >= lo - EPS && x <= hi + EPS); miss = ky.scale; break;
          case '<': ok = x < lo; miss = x - lo; break;
          case '<=': ok = x <= lo; miss = x - lo; break;
          case '>': ok = x > lo; miss = lo - x; break;
          case '>=': ok = x >= lo; miss = lo - x; break;
        }
        miss = Math.max(miss, 0) / ky.scale;
        if (!ok && miss === 0) miss = EPS; // strict bounds exactly on the edge
      }
    }
    if (!ok) { failed.push(label); closeness += miss || 1; }
  }
  return { match: failed.length === 0, closeness, failed, unknown };
}
