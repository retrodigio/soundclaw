// Importing other tools' patch strings into the classic voice: jsfxr (the base58 form of its
// URL hash, and its JSON form) and bfxr (its comma-separated settings string). Every value is
// matched by name; what the classic voice cannot hold is reported per row, never dropped silently.
//
//   jsfxr base58: 1 byte wave type, then 22 little-endian float32 (the parameters, in a fixed order),
//     written in base58 (alphabet 123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz, a leading
//     "1" is a zero byte). The URL form is https://sfxr.me/#<base58>. It carries no volume: jsfxr plays
//     it at its default sound_vol 0.5.
//   jsfxr JSON: the same parameters by name (p_env_attack ...), plus sound_vol, sample_rate, sample_size.
//   bfxr: comma-separated numbers in its parameter order (waveType, masterVolume, attackTime ...), 32 values.
//
// Volume: jsfxr's output is multiplied by exp(sound_vol) - 1 and the classic voice's by `volume`, so
// volume = exp(sound_vol) - 1 gives the same amplitude (volume cannot go above 1). Bfxr's is
// multiplied by masterVolume², so volume = masterVolume².

import { CLASSIC_FIELDS, makePatch, type ClassicPatch } from './classic.ts';

export type ImportFormat = 'jsfxr' | 'bfxr';

export interface ImportedRow {
  id: string;
  patch: ClassicPatch;
  /** Every value of the source is in the patch as it means there (the row is a plain `sound patch`). */
  exact: boolean;
  /** What was approximated or lost, one line each. */
  notes: string[];
  /** Which form the row was read as. */
  form: 'jsfxr base58' | 'jsfxr json' | 'bfxr';
}

export class ImportError extends Error {}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 to bytes (null: not base58). */
export function b58decode(s: string): Uint8Array | null {
  const digits: number[] = [];
  let zeros = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B58.indexOf(s[i]!);
    if (v < 0) return null;
    if (v === 0 && digits.length === 0) { zeros++; continue; }
    let carry = v;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! * 58;
      digits[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { digits.push(carry & 0xff); carry >>= 8; }
  }
  const out = new Uint8Array(zeros + digits.length);
  digits.forEach((d, i) => { out[out.length - 1 - i] = d; });
  return out;
}

/** Bytes to base58 (what jsfxr writes; used by the tests and by anyone round-tripping). */
export function b58encode(bytes: Uint8Array): string {
  const digits: number[] = [];
  let zeros = 0;
  for (const b of bytes) {
    if (b === 0 && digits.length === 0) { zeros++; continue; }
    let carry = b;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => B58[d]).join('');
}

/** jsfxr's parameters, in the order its base58 form holds them, with the classic parameter each becomes. */
export const JSFXR_PARAMS: readonly { name: string; to: string }[] = [
  { name: 'wave_type', to: 'wave' }, { name: 'p_env_attack', to: 'attack' }, { name: 'p_env_sustain', to: 'sustain' }, { name: 'p_env_punch', to: 'punch' },
  { name: 'p_env_decay', to: 'decay' }, { name: 'p_base_freq', to: 'freq' }, { name: 'p_freq_limit', to: 'minFreq' }, { name: 'p_freq_ramp', to: 'slide' },
  { name: 'p_freq_dramp', to: 'deltaSlide' }, { name: 'p_vib_strength', to: 'vibratoDepth' }, { name: 'p_vib_speed', to: 'vibratoSpeed' },
  { name: 'p_arp_mod', to: 'changeAmount' }, { name: 'p_arp_speed', to: 'changeSpeed' }, { name: 'p_duty', to: 'duty' }, { name: 'p_duty_ramp', to: 'dutySweep' },
  { name: 'p_repeat_speed', to: 'repeatSpeed' }, { name: 'p_pha_offset', to: 'phaserOffset' }, { name: 'p_pha_ramp', to: 'phaserSweep' },
  { name: 'p_lpf_freq', to: 'lowPass' }, { name: 'p_lpf_ramp', to: 'lowPassSweep' }, { name: 'p_lpf_resonance', to: 'resonance' },
  { name: 'p_hpf_freq', to: 'highPass' }, { name: 'p_hpf_ramp', to: 'highPassSweep' },
];

/** The shortest decimal that reads back as the same float32 (so a stored 0.3 is 0.3, not 0.30000001192092896). */
export function shortest32(v: number): number {
  if (!Number.isFinite(v)) return v;
  for (let p = 1; p <= 9; p++) {
    const d = Number(v.toPrecision(p));
    if (Math.fround(d) === Math.fround(v)) return d;
  }
  return v;
}

const clean = (v: number, lo: number, hi: number, name: string, notes: string[]): number => {
  if (!Number.isFinite(v)) { notes.push(`${name} is not a number: the default is used`); return NaN; }
  const c = Math.min(hi, Math.max(lo, v));
  if (c !== v) notes.push(`${name} ${v} is outside ${lo}..${hi}: clamped to ${c}`);
  return c;
};

/** Build the patch from classic-named values, clamping and noting what moved. */
function toPatch(values: Record<string, number>, notes: string[]): ClassicPatch {
  const t: Record<string, number> = {};
  for (const f of CLASSIC_FIELDS) {
    const v = values[f.name];
    if (v === undefined) continue;
    const c = clean(v, f.min, f.max, f.name, notes);
    if (!Number.isNaN(c)) t[f.name] = c;
  }
  return makePatch(t, 'import');
}

/** The base58 text out of what a person pasted: a URL, `#hash`, or the string itself. */
export function b58Of(text: string): string {
  const t = text.trim().replace(/^.*#/, '');
  return t.replace(/^["']|["']$/g, '');
}

export function looksLikeJsfxr(text: string): boolean {
  const t = text.trim();
  if (t.startsWith('{')) return true;
  const b = b58Of(t);
  return /^[1-9A-HJ-NP-Za-km-z]{100,}$/.test(b) && !/[,\s=]/.test(b);
}

/** A jsfxr base58 string (or URL) or JSON object as a classic patch. */
export function importJsfxr(text: string, id: string): ImportedRow {
  const t = text.trim();
  const notes: string[] = [];
  let values: Record<string, number> = {};
  let soundVol: number | null = null;
  let form: ImportedRow['form'];
  if (t.startsWith('{')) {
    form = 'jsfxr json';
    let o: Record<string, unknown>;
    try { o = JSON.parse(t) as Record<string, unknown>; } catch (e) { throw new ImportError(`not JSON: ${(e as Error).message}`); }
    for (const p of JSFXR_PARAMS) {
      const v = o[p.name];
      if (v === undefined) continue;
      if (typeof v !== 'number') throw new ImportError(`${p.name} must be a number`);
      values[p.to] = v;
    }
    if (typeof o.sound_vol === 'number') soundVol = o.sound_vol;
    else if (o.sound_vol !== undefined) throw new ImportError('sound_vol must be a number');
    for (const k of Object.keys(o)) if (!JSFXR_PARAMS.some((p) => p.name === k) && !['sound_vol', 'sample_rate', 'sample_size', 'oldParams'].includes(k)) notes.push(`unknown field '${k}' ignored`);
    if (typeof o.sample_rate === 'number' && o.sample_rate !== 44100) notes.push(`sample_rate ${o.sample_rate} ignored: the classic voice renders at 44,100 Hz`);
    if (typeof o.sample_size === 'number' && o.sample_size !== 16) notes.push(`sample_size ${o.sample_size} bits ignored: exports are 16-bit`);
  } else {
    form = 'jsfxr base58';
    const bytes = b58decode(b58Of(t));
    if (!bytes) throw new ImportError('not a jsfxr string: base58 uses 1-9 A-Z a-z without 0, O, I, l');
    const want = 1 + 4 * (JSFXR_PARAMS.length - 1);
    if (bytes.length !== want) throw new ImportError(`not a jsfxr string: it decodes to ${bytes.length} bytes, jsfxr's hold ${want}`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    JSFXR_PARAMS.forEach((p, i) => {
      values[p.to] = i === 0 ? bytes[0]! : shortest32(view.getFloat32(1 + (i - 1) * 4, true));
    });
    notes.push('the string carries no volume: jsfxr plays it at sound_vol 0.5, so volume is 0.648721');
  }
  if (values.wave !== undefined && !Number.isInteger(values.wave)) throw new ImportError(`wave_type ${values.wave} is not 0 to 3`);
  if (values.wave !== undefined && (values.wave < 0 || values.wave > 3)) throw new ImportError(`wave_type ${values.wave} is not one of jsfxr's four waves (0 to 3)`);
  const sv = soundVol ?? 0.5;
  const vol = Math.exp(sv) - 1;
  values = { ...values, volume: Math.min(1, Number(vol.toPrecision(6))) };
  if (vol > 1) notes.push(`sound_vol ${sv} is louder than the classic volume goes (exp(${sv}) - 1 = ${vol.toFixed(3)}): volume is 1`);
  const exact = !notes.some((n) => !n.startsWith('the string carries no volume'));
  const patch = toPatch(values, notes);
  return { id, patch, exact: exact && !notes.some((n) => /clamped|default is used/.test(n)), notes, form };
}

/** Bfxr's settings string order. */
export const BFXR_PARAMS = [
  'waveType', 'masterVolume', 'attackTime', 'sustainTime', 'sustainPunch', 'decayTime', 'compressionAmount', 'startFrequency', 'minFrequency', 'slide', 'deltaSlide',
  'vibratoDepth', 'vibratoSpeed', 'overtones', 'overtoneFalloff', 'changeRepeat', 'changeAmount', 'changeSpeed', 'changeAmount2', 'changeSpeed2', 'squareDuty', 'dutySweep',
  'repeatSpeed', 'flangerOffset', 'flangerSweep', 'lpFilterCutoff', 'lpFilterCutoffSweep', 'lpFilterResonance', 'hpFilterCutoff', 'hpFilterCutoffSweep', 'bitCrush', 'bitCrushSweep',
] as const;

const BFXR_TO: Record<string, string> = {
  attackTime: 'attack', sustainTime: 'sustain', sustainPunch: 'punch', decayTime: 'decay', startFrequency: 'freq', minFrequency: 'minFreq', slide: 'slide', deltaSlide: 'deltaSlide',
  vibratoDepth: 'vibratoDepth', vibratoSpeed: 'vibratoSpeed', changeAmount: 'changeAmount', changeSpeed: 'changeSpeed', squareDuty: 'duty', dutySweep: 'dutySweep', repeatSpeed: 'repeatSpeed',
  flangerOffset: 'phaserOffset', flangerSweep: 'phaserSweep', lpFilterCutoff: 'lowPass', lpFilterCutoffSweep: 'lowPassSweep', lpFilterResonance: 'resonance', hpFilterCutoff: 'highPass', hpFilterCutoffSweep: 'highPassSweep',
};

/** Bfxr's extra waves and the classic wave nearest each (0..3 map exactly). */
const BFXR_WAVES = ['square', 'saw', 'sine', 'noise', 'triangle', 'pink noise', 'tan', 'whistle', 'breaker', 'bitnoise', 'wave 10', 'wave 11'];
const BFXR_NEAREST = [0, 1, 2, 3, 2, 3, 2, 2, 3, 3, 0, 0];

/** The parameters Bfxr has that the classic voice does not: nonzero means the sound is not reproduced. */
const BFXR_LOST: { name: string; what: string }[] = [
  { name: 'compressionAmount', what: 'compression (the classic voice has none: the sound is quieter in its soft parts than in Bfxr)' },
  { name: 'overtones', what: 'harmonics (overtones)' },
  { name: 'overtoneFalloff', what: 'harmonics falloff' },
  { name: 'changeRepeat', what: 'pitch jump repeat' },
  { name: 'changeAmount2', what: 'second pitch jump amount' },
  { name: 'changeSpeed2', what: 'second pitch jump onset' },
  { name: 'bitCrush', what: 'bit crush' },
  { name: 'bitCrushSweep', what: 'bit crush sweep' },
];

/** A Bfxr settings string (32 comma-separated numbers; an empty field is 0, as Bfxr writes it) as a classic patch. */
export function importBfxr(text: string, id: string): ImportedRow {
  const fields = text.trim().replace(/^["']|["']$/g, '').split(',').map((x) => x.trim());
  if (fields.length < BFXR_PARAMS.length) throw new ImportError(`not a Bfxr string: it has ${fields.length} values, Bfxr's settings string has ${BFXR_PARAMS.length}`);
  const raw: Record<string, number> = {};
  BFXR_PARAMS.forEach((name, i) => {
    const f = fields[i]!;
    const v = f === '' ? 0 : Number(f);
    if (!Number.isFinite(v)) throw new ImportError(`${name}: '${f}' is not a number`);
    raw[name] = v;
  });
  const notes: string[] = [];
  const wave = Math.floor(raw.waveType!);
  if (wave < 0 || wave >= BFXR_WAVES.length) throw new ImportError(`waveType ${raw.waveType} is not one of Bfxr's waves (0 to ${BFXR_WAVES.length - 1})`);
  const values: Record<string, number> = { wave: BFXR_NEAREST[wave]! };
  if (wave > 3) notes.push(`wave ${BFXR_WAVES[wave]} has no classic equivalent: ${['square', 'saw', 'sine', 'noise'][BFXR_NEAREST[wave]!]} is the nearest`);
  for (const [from, to] of Object.entries(BFXR_TO)) values[to] = raw[from]!;
  values.volume = Math.min(1, Number((raw.masterVolume! * raw.masterVolume!).toPrecision(6)));
  for (const l of BFXR_LOST) if (raw[l.name]! !== 0) notes.push(`${l.name} ${raw[l.name]} not reproduced: ${l.what}`);
  const patch = toPatch(values, notes);
  return { id, patch, exact: !notes.length, notes, form: 'bfxr' };
}

/** The rows of an import source: one string per line, optionally `<id> <string>` or `<id>: <string>`; lines starting with # are comments. */
export function splitRows(text: string): { id: string | null; body: string }[] {
  const t = text.trim();
  if (t.startsWith('{') && !t.includes('\n')) return [{ id: null, body: t }];
  const rows: { id: string | null; body: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const m = /^([a-z][a-z0-9_-]{0,47}):?\s+(\S.*)$/.exec(l);
    rows.push(m ? { id: m[1]!, body: m[2]! } : { id: null, body: l });
  }
  return rows;
}
