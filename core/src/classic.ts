// The classic voice: an sfxr-style synth of 25 normalised parameters, rendered at 44,100 Hz with
// 8x supersampling through a three-stage envelope (attack, sustain with punch, decay), a pitch
// slide, vibrato, a one-time pitch change, duty sweep, a repeat that restarts the pitch
// parameters, a phaser and low/high-pass filters. The output is a Float64Array of doubles in
// [-1, 1]; the same parameters always give the same samples, bit for bit, on every platform (the
// sine and the cube come from mathx.ts rather than the platform's libm; see docs/design.md).
//
// The noise wave draws from a private xorshift stream seeded by FNV-1a over the patch's text form
// (or an explicit seed). Pre-rendered WAVs quantise as trunc(s × 32000), 16-bit mono.

import { cube, formatG, sinRad } from './mathx.ts';

const SAMPLE_RATE = 44100;
export const SUPERSAMPLE = 8;
/** The version tag of the single-patch text. */
export const PATCH_VERSION = '1';

export const WAVE_NAMES = ['square', 'saw', 'sine', 'noise'] as const;

export interface ClassicField {
  name: ClassicKey;
  min: number;
  max: number;
  default: number;
  help: string;
}

/** The 25 parameters in their stable positional order (part of the text and CSV formats). */
export const CLASSIC_FIELDS = [
  { name: 'wave', min: 0, max: 3, default: 0, help: '0 square, 1 saw, 2 sine, 3 noise (names accepted)' },
  { name: 'attack', min: 0, max: 1, default: 0, help: 'attack length a² · 10⁵ samples, linear rise' },
  { name: 'sustain', min: 0.01, max: 1, default: 0.3, help: 'sustain length s² · 10⁵ samples' },
  { name: 'punch', min: 0, max: 1, default: 0, help: 'sustain level 1 + 2 · punch · (1 − t/len)' },
  { name: 'decay', min: 0, max: 1, default: 0.4, help: 'decay length d² · 10⁵ samples, linear fall; the sound ends after it' },
  { name: 'freq', min: 0, max: 1, default: 0.3, help: 'start period 100 / (f² + 0.001) supersamples' },
  { name: 'minFreq', min: 0, max: 1, default: 0, help: 'period ceiling 100 / (m² + 0.001); when m > 0 and the period reaches it the sound ends' },
  { name: 'slide', min: -1, max: 1, default: 0, help: 'per-sample period factor 1 − slide³ · 0.01' },
  { name: 'deltaSlide', min: -1, max: 1, default: 0, help: 'added to that factor each sample: −dslide³ · 10⁻⁶' },
  { name: 'vibratoDelay', min: 0, max: 1, default: 0, help: 'vibrato starts after this fraction of the envelope length' },
  { name: 'vibratoDepth', min: -1, max: 1, default: 0, help: 'period × (1 + sin(phase) · depth · 0.5)' },
  { name: 'vibratoSpeed', min: 0, max: 1, default: 0, help: 'phase += speed² · 0.01 per sample' },
  { name: 'changeAmount', min: -1, max: 1, default: 0, help: 'one period change: × 1 − a² · 0.9 (a ≥ 0) or × 1 + a² · 10 (a < 0)' },
  { name: 'changeSpeed', min: 0, max: 1, default: 0, help: '... after (1 − speed)² · 20000 + 32 samples; 1 = never' },
  { name: 'duty', min: 0, max: 1, default: 0, help: 'square duty 0.5 − 0.5 · duty' },
  { name: 'dutySweep', min: -1, max: 1, default: 0, help: 'duty += −sweep · 5 · 10⁻⁵ per sample, kept in [0, 0.5]' },
  { name: 'repeatSpeed', min: 0, max: 1, default: 0, help: 'restart the pitch parameters every (1 − r)² · 20000 + 32 samples; 0 = off' },
  { name: 'phaserOffset', min: -1, max: 1, default: 0, help: 'phaser delay ±offset² · 1020 samples' },
  { name: 'phaserSweep', min: -1, max: 1, default: 0, help: 'delay += ±sweep² per sample' },
  { name: 'lowPass', min: 0, max: 1, default: 1, help: 'low-pass coefficient c³ · 0.1; 1 = bypassed' },
  { name: 'lowPassSweep', min: -1, max: 1, default: 0, help: 'coefficient × 1 + sweep · 10⁻⁴ per supersample, kept in [0, 0.1]' },
  { name: 'resonance', min: 0, max: 1, default: 0, help: 'low-pass damping min(0.8, 5 / (1 + res² · 20) · (0.01 + w))' },
  { name: 'highPass', min: 0, max: 1, default: 0, help: 'high-pass coefficient c² · 0.1' },
  { name: 'highPassSweep', min: -1, max: 1, default: 0, help: 'coefficient × 1 + sweep · 3 · 10⁻⁴ per sample, kept in [10⁻⁵, 0.1]' },
  { name: 'volume', min: 0, max: 1, default: 0.5, help: 'output gain' },
] as const satisfies readonly ClassicField[];

export type ClassicKey =
  | 'wave' | 'attack' | 'sustain' | 'punch' | 'decay' | 'freq' | 'minFreq' | 'slide' | 'deltaSlide'
  | 'vibratoDelay' | 'vibratoDepth' | 'vibratoSpeed' | 'changeAmount' | 'changeSpeed' | 'duty' | 'dutySweep'
  | 'repeatSpeed' | 'phaserOffset' | 'phaserSweep' | 'lowPass' | 'lowPassSweep' | 'resonance' | 'highPass'
  | 'highPassSweep' | 'volume';

/** A validated patch: the 25 values, and optionally the noise seed. */
export type ClassicPatch = { [K in ClassicKey]: number } & { seed?: number };

export const CLASSIC_KEYS: readonly ClassicKey[] = CLASSIC_FIELDS.map((f) => f.name);

export function classicField(name: string): ClassicField | undefined {
  return CLASSIC_FIELDS.find((f) => f.name === name);
}

export class ClassicError extends Error {}

/** A number as Lua's tonumber reads it: decimal, exponent, or 0x hex; null when it is not one. */
export function luaNumber(s: string): number | null {
  const t = s.trim();
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (/^[-+]?0[xX][0-9a-fA-F]+$/.test(t)) return t.startsWith('-') ? -Number(t.slice(1)) : Number(t);
  return null;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * A complete, validated patch from names, positions (1..25) or both (names win). Missing values
 * take the defaults; `wave` also takes a name; values outside a range are clamped (so sustain
 * never drops below 0.01). Unknown names are an error.
 */
export function makePatch(t: Record<string, unknown> = {}, where = 'sfxr patch'): ClassicPatch {
  for (const k of Object.keys(t)) {
    if (/^\d+$/.test(k)) {
      const i = Number(k);
      if (i < 1 || i > CLASSIC_FIELDS.length) throw new ClassicError(`${where}: parameter index ${k} out of range`);
    } else if (!classicField(k) && k !== 'seed') throw new ClassicError(`${where}: unknown parameter '${k}'`);
  }
  const p = {} as Record<string, number>;
  CLASSIC_FIELDS.forEach((f, i) => {
    let v = t[f.name];
    if (v === undefined) v = t[String(i + 1)];
    if (v === undefined || v === null) v = f.default;
    if (f.name === 'wave' && typeof v === 'string') {
      const w = (WAVE_NAMES as readonly string[]).indexOf(v);
      if (w < 0) throw new ClassicError(`${where}: unknown wave '${v}' (square, saw, sine, noise)`);
      v = w;
    }
    if (typeof v !== 'number' || v !== v) throw new ClassicError(`${where}: parameter '${f.name}' must be a number`);
    p[f.name] = f.name === 'wave' ? Math.floor(clamp(v, f.min, f.max)) : clamp(v, f.min, f.max);
  });
  if (t.seed !== undefined && t.seed !== null) {
    const s = typeof t.seed === 'string' ? luaNumber(t.seed) : t.seed;
    if (typeof s !== 'number' || s !== s) throw new ClassicError(`${where}: seed must be a number`);
    p.seed = s;
  }
  return p as ClassicPatch;
}

export const defaultPatch = (): ClassicPatch => makePatch({});

/** The 25 values in positional order. */
export function patchValues(p: ClassicPatch): number[] {
  return CLASSIC_FIELDS.map((f) => p[f.name]);
}

/**
 * The single-patch text: an optional first line holding only a version tag, then either one line
 * of up to 25 comma-separated numbers (an empty field keeps its default) or `name=value` pairs
 * separated by commas, semicolons or newlines. `#` starts a comment.
 */
export function parsePatch(text: string, where = 'sfxr patch'): { patch: ClassicPatch; version: string | null } {
  let lines = text.split('\n').map((l) => l.replace(/#.*$/, '').replace(/\r/g, '').trim()).filter((l) => l !== '');
  let version: string | null = null;
  if (lines.length > 1 && !/[,=]/.test(lines[0]!)) {
    version = lines[0]!;
    lines = lines.slice(1);
  }
  const body = lines.join(';');
  const t: Record<string, unknown> = {};
  if (body.includes('=')) {
    for (const item of body.split(/[,;]+/)) {
      if (item === '') continue;
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(item);
      if (!m) throw new ClassicError(`${where}: bad parameter '${item}'`);
      t[m[1]!] = luaNumber(m[2]!) ?? m[2]!;
    }
  } else {
    const fields = body.split(',');
    if (fields.length > CLASSIC_FIELDS.length) throw new ClassicError(`${where}: ${fields.length} fields, at most ${CLASSIC_FIELDS.length}`);
    fields.forEach((raw, i) => {
      const f = raw.trim();
      if (f === '') return;
      const n = luaNumber(f);
      if (n === null) throw new ClassicError(`${where}: field ${i + 1} is not a number`);
      t[String(i + 1)] = n;
    });
  }
  return { patch: makePatch(t, where), version };
}

/** The engine's single-patch text: the version line, then 25 positional numbers at six significant digits (a seed, which that form cannot carry, is not written). */
export function formatPatch(p: ClassicPatch): string {
  return `${PATCH_VERSION}\n${patchValues(p).map((v) => formatG(v, 6)).join(',')}\n`;
}

/** The patch as `name=value` pairs at full precision, on one line: exact, and carries the seed. */
export function formatPatchNamed(p: ClassicPatch): string {
  const parts = CLASSIC_FIELDS.map((f) => `${f.name}=${p[f.name]}`);
  if (p.seed !== undefined) parts.push(`seed=${p.seed}`);
  return parts.join(',');
}

/** Stable 32-bit seed from the patch values: FNV-1a over their text form (14 significant digits, joined by commas). */
export function seedOf(p: ClassicPatch): number {
  let h = 2166136261 | 0;
  const s = patchValues(p).map((v) => formatG(v, 14)).join(',');
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Envelope stage lengths in output samples. */
export function envelope(p: ClassicPatch): [number, number, number] {
  return [Math.floor(p.attack * p.attack * 100000), Math.floor(p.sustain * p.sustain * 100000), Math.floor(p.decay * p.decay * 100000)];
}

/** Patch length in samples when the minimum-frequency cut-off does not end it early. */
export function envelopeLength(p: ClassicPatch): number {
  const [a, s, d] = envelope(p);
  return a + s + d + 3;
}

/** Lua's `x % 4294967296` for a finite x (result in [0, 2^32)). */
function mod32(x: number): number {
  const m = x % 4294967296;
  return m < 0 ? m + 4294967296 : m;
}

/** bit.tobit: round to nearest (ties to even), wrap to a signed 32-bit integer. */
function toBit(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  const r = d < 0.5 ? f : d > 0.5 ? f + 1 : f % 2 === 0 ? f : f + 1;
  return r | 0;
}

const TAU_OVER = 3.141592653589793; // pi

/** Render a patch: the samples (doubles in [-1, 1]). `opts.seed` overrides the noise seed (default the patch's, else seedOf). */
export function renderClassic(p: ClassicPatch, opts: { seed?: number } = {}): Float64Array {
  const seed = opts.seed ?? p.seed ?? seedOf(p);
  let x = toBit(mod32(seed));
  if (x === 0) x = 0x2545f491;
  const noise = (): number => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2147483648 - 1;
  };

  const wave = p.wave;
  const noiseBuf = new Float64Array(32);
  for (let i = 0; i < 32; i++) noiseBuf[i] = noise();

  // pitch state (restored by the repeat)
  let fperiod = 0, fmaxperiod = 0, fslide = 0, fdslide = 0, duty = 0, dutySlide = 0, arpMod = 0, arpTime = 0, arpLimit = 0;
  const resetPitch = (): void => {
    fperiod = 100 / (p.freq * p.freq + 0.001);
    fmaxperiod = 100 / (p.minFreq * p.minFreq + 0.001);
    fslide = 1 - cube(p.slide) * 0.01;
    fdslide = -cube(p.deltaSlide) * 0.000001;
    duty = 0.5 - p.duty * 0.5;
    dutySlide = -p.dutySweep * 0.00005;
    arpMod = p.changeAmount >= 0 ? 1 - p.changeAmount * p.changeAmount * 0.9 : 1 + p.changeAmount * p.changeAmount * 10;
    arpTime = 0;
    const cs = 1 - p.changeSpeed;
    arpLimit = Math.floor(cs * cs * 20000 + 32);
    if (p.changeSpeed === 1) arpLimit = 0;
  };
  resetPitch();

  // filters
  const lpOn = p.lowPass !== 1;
  let fltp = 0, fltdp = 0;
  let fltw = cube(p.lowPass) * 0.1;
  const fltwD = 1 + p.lowPassSweep * 0.0001;
  let fltdmp = 5 / (1 + p.resonance * p.resonance * 20) * (0.01 + fltw);
  if (fltdmp > 0.8) fltdmp = 0.8;
  let fltphp = 0;
  let flthp = p.highPass * p.highPass * 0.1;
  const flthpD = 1 + p.highPassSweep * 0.0003;

  // vibrato
  let vibPhase = 0;
  const vibSpeed = p.vibratoSpeed * p.vibratoSpeed * 0.01;
  const vibAmp = p.vibratoDepth * 0.5;

  // envelope
  const len = envelope(p);
  const vibStart = Math.floor(p.vibratoDelay * (len[0] + len[1] + len[2]));
  let envStage = 0; // 0..2 are the reference's stages 1..3; 3 is its stage 4
  let envTime = 0;
  let envVol = 0;

  // phaser
  let fphase = p.phaserOffset * p.phaserOffset * 1020;
  if (p.phaserOffset < 0) fphase = -fphase;
  let fdphase = p.phaserSweep * p.phaserSweep;
  if (p.phaserSweep < 0) fdphase = -fdphase;
  let iphase = Math.floor(Math.abs(fphase));
  let ipp = 0;
  const pbuf = new Float64Array(1024);

  // repeat
  let repTime = 0;
  const rs = 1 - p.repeatSpeed;
  let repLimit = Math.floor(rs * rs * 20000 + 32);
  if (p.repeatSpeed === 0) repLimit = 0;

  const gain = p.volume / SUPERSAMPLE;
  const minFreq = p.minFreq;
  let phase = 0;
  const out = new Float64Array(len[0] + len[1] + len[2] + 4);
  let n = 0;
  let playing = true;
  const punch2 = 2 * p.punch;

  while (playing) {
    repTime++;
    if (repLimit !== 0 && repTime >= repLimit) {
      repTime = 0;
      resetPitch();
    }
    arpTime++;
    if (arpLimit !== 0 && arpTime >= arpLimit) {
      arpLimit = 0;
      fperiod = fperiod * arpMod;
    }
    fslide = fslide + fdslide;
    fperiod = fperiod * fslide;
    if (fperiod > fmaxperiod) {
      fperiod = fmaxperiod;
      if (minFreq > 0) playing = false;
    }
    let rfperiod = fperiod;
    if (vibAmp !== 0 && n >= vibStart) {
      vibPhase = vibPhase + vibSpeed;
      rfperiod = fperiod * (1 + sinRad(vibPhase) * vibAmp);
    }
    let period = Math.floor(rfperiod);
    if (period < 8) period = 8;
    duty = duty + dutySlide;
    if (duty < 0) duty = 0;
    else if (duty > 0.5) duty = 0.5;

    envTime++;
    if (envTime > len[envStage]!) {
      envTime = 0;
      envStage++;
      if (envStage === 3) playing = false;
    }
    if (envStage === 0) envVol = envTime / len[0]!;
    else if (envStage === 1) envVol = 1 + (1 - envTime / len[1]!) * punch2;
    else if (envStage === 2) envVol = len[2]! > 0 ? 1 - envTime / len[2]! : 0;

    fphase = fphase + fdphase;
    iphase = Math.floor(Math.abs(fphase));
    if (iphase > 1023) iphase = 1023;
    flthp = flthp * flthpD;
    if (flthp < 0.00001) flthp = 0.00001;
    else if (flthp > 0.1) flthp = 0.1;

    let ssample = 0;
    for (let k = 0; k < SUPERSAMPLE; k++) {
      let sample: number;
      phase = phase + 1;
      if (phase >= period) {
        phase = phase % period;
        if (wave === 3) for (let i = 0; i < 32; i++) noiseBuf[i] = noise();
      }
      const fp = phase / period;
      if (wave === 0) sample = fp < duty ? 0.5 : -0.5;
      else if (wave === 1) sample = 1 - fp * 2;
      else if (wave === 2) sample = sinRad(fp * 2 * TAU_OVER);
      else sample = noiseBuf[Math.floor(phase * 32 / period)]!;
      const pp = fltp;
      fltw = fltw * fltwD;
      if (fltw < 0) fltw = 0;
      else if (fltw > 0.1) fltw = 0.1;
      if (lpOn) {
        fltdp = fltdp + (sample - fltp) * fltw;
        fltdp = fltdp - fltdp * fltdmp;
      } else {
        fltp = sample;
        fltdp = 0;
      }
      fltp = fltp + fltdp;
      fltphp = fltphp + fltp - pp;
      fltphp = fltphp - fltphp * flthp;
      sample = fltphp;
      pbuf[ipp & 1023] = sample;
      sample = sample + pbuf[(ipp - iphase + 1024) & 1023]!;
      ipp = (ipp + 1) & 1023;
      ssample = ssample + sample * envVol;
    }
    ssample = ssample * gain;
    if (ssample > 1) ssample = 1;
    else if (ssample < -1) ssample = -1;
    out[n++] = ssample;
  }
  return out.slice(0, n);
}

/** Quantise as the engine's pre-rendered WAVs do: trunc(s × 32000), 16-bit. */
export function quantizeClassic(samples: Float64Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.trunc(samples[i]! * 32000);
  return out;
}

/** The pre-rendered WAV: RIFF PCM, mono, 44,100 Hz, 16-bit, each sample trunc(s × 32000). */
export function classicWav(samples: Float64Array): Uint8Array {
  const q = quantizeClassic(samples);
  const dataBytes = q.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const v = new DataView(out.buffer);
  const tag = (off: number, s: string) => { for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i); };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < q.length; i++) v.setInt16(44 + i * 2, q[i]!, true);
  return out;
}

// ---- synth.csv -------------------------------------------------------------------------------

export interface CsvRow {
  id: string;
  patch: ClassicPatch;
}

/** One CSV record split into cells (RFC 4180 quoting). */
function csvCells(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { cells.push(cur); cur = ''; } else cur += c;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/**
 * synth.csv: the key column is the sound id (a column named id, key, sound or name, else the
 * first); the other columns are named after the parameters, in any order, plus an optional
 * `seed`. A missing column, an empty cell or `NA` takes the default. Blank lines and lines
 * starting with `#` are skipped.
 */
export function parseCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  if (!lines.length) throw new ClassicError('synth.csv: no header line');
  const head = csvCells(lines[0]!);
  const keyAt = Math.max(0, head.findIndex((h) => ['id', 'key', 'sound', 'name'].includes(h.toLowerCase())));
  for (const [i, h] of head.entries()) {
    if (i !== keyAt && !classicField(h) && h !== 'seed') throw new ClassicError(`synth.csv: unknown column '${h}'`);
  }
  const rows: CsvRow[] = [];
  const seen = new Set<string>();
  lines.slice(1).forEach((line, li) => {
    const cells = csvCells(line);
    const id = cells[keyAt] ?? '';
    const where = `synth.csv line ${li + 2}${id ? ` (${id})` : ''}`;
    if (!id) throw new ClassicError(`${where}: no sound id`);
    if (seen.has(id)) throw new ClassicError(`${where}: '${id}' appears twice`);
    seen.add(id);
    const t: Record<string, unknown> = {};
    head.forEach((h, i) => {
      if (i === keyAt) return;
      const c = cells[i];
      if (c === undefined || c === '' || c === 'NA') return;
      const n = luaNumber(c);
      t[h] = n ?? c;
    });
    rows.push({ id, patch: makePatch(t, where) });
  });
  return rows;
}

/** synth.csv text for the rows: every column, full precision (so a re-read renders the same samples), `seed` only when some row has one. */
export function formatCsv(rows: readonly CsvRow[]): string {
  const withSeed = rows.some((r) => r.patch.seed !== undefined);
  const head = ['id', ...CLASSIC_KEYS, ...(withSeed ? ['seed'] : [])];
  const body = rows.map((r) => [r.id, ...patchValues(r.patch).map(String), ...(withSeed ? [r.patch.seed === undefined ? 'NA' : String(r.patch.seed)] : [])].join(','));
  return [head.join(','), ...body].join('\n') + '\n';
}
