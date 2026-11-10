// SoundFont 2 import: the RIFF structure of an .sf2 file (INFO, sdta with 16-bit and 24-bit samples, pdta with presets,
// instruments, zones, generators and sample headers), and one preset made into the zones of a sampled instrument. The
// generators the zones carry are read (key and velocity ranges, root, tuning, loops and their offsets, attenuation, pan,
// the volume envelope, exclusive classes); modulators, filters, LFOs, the modulation envelope and effect sends are
// named in the report. Compressed SoundFonts (version 3) and ROM samples are refused.
//
// Parsing is defensive: the file is untrusted, every index and size is checked against the chunk it lives in.

import type { PcmAudio } from './pcm.ts';
import { limitProblem } from './pcm.ts';
import {
  Groups, InstrumentImportError, LossReport, checkZoneCount, clampedZone, modeOf, roundTime, r4,
  type InstrumentPlan, type PlanSample, type PlanZone,
} from './instrumentimport.ts';
import type { Zone, ZoneLoopMode } from './zones.ts';

export interface Sf2Info {
  version: string;
  name: string;
  copyright?: string;
  comment?: string;
  engineers?: string;
  tools?: string;
  product?: string;
}

export interface Sf2SampleHeader {
  index: number;
  name: string;
  start: number;
  end: number;
  startLoop: number;
  endLoop: number;
  rate: number;
  originalPitch: number;
  pitchCorrection: number;
  link: number;
  type: number;
}

interface Sf2Zone {
  gens: Map<number, number>;
  keyRange: [number, number] | null;
  velRange: [number, number] | null;
  /** The instrument (in a preset) or sample (in an instrument) the zone ends in; null for a global zone. */
  target: number | null;
  mods: number;
}

interface Sf2Preset { name: string; bank: number; program: number; zones: Sf2Zone[] }
interface Sf2Instrument { name: string; zones: Sf2Zone[] }

export interface Sf2File {
  info: Sf2Info;
  presets: Sf2Preset[];
  instruments: Sf2Instrument[];
  samples: Sf2SampleHeader[];
  /** The 16-bit sample data, and the low bytes of the 24-bit data when the file has them. */
  smpl: Uint8Array;
  sm24: Uint8Array | null;
}

// ---- the RIFF structure ------------------------------------------------------------------------------------------

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const i16 = (b: Uint8Array, o: number): number => { const v = u16(b, o); return v >= 0x8000 ? v - 0x10000 : v; };
const u32 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const tag = (b: Uint8Array, o: number): string => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
const text = (b: Uint8Array, o: number, n: number): string => {
  let s = '';
  for (let i = 0; i < n && b[o + i]; i++) s += String.fromCharCode(b[o + i]!);
  return s.trim();
};

interface Chunk { id: string; start: number; size: number }

/** The chunks directly inside [from, to). */
function chunksOf(b: Uint8Array, from: number, to: number): Chunk[] {
  const out: Chunk[] = [];
  let o = from;
  while (o + 8 <= to) {
    const size = u32(b, o + 4);
    if (o + 8 + size > to) throw new InstrumentImportError(`SoundFont: the chunk '${tag(b, o)}' runs past the end of its parent (the file is cut short or damaged)`);
    out.push({ id: tag(b, o), start: o + 8, size });
    o += 8 + size + (size & 1);
  }
  return out;
}

function listOf(b: Uint8Array, c: Chunk): { type: string; chunks: Chunk[] } {
  return { type: tag(b, c.start), chunks: chunksOf(b, c.start + 4, c.start + c.size) };
}

// ---- generators --------------------------------------------------------------------------------------------------

/** The generator numbers the importer knows by name. */
export const GEN = {
  startAddrsOffset: 0, endAddrsOffset: 1, startloopAddrsOffset: 2, endloopAddrsOffset: 3, startAddrsCoarseOffset: 4, modLfoToPitch: 5, vibLfoToPitch: 6,
  modEnvToPitch: 7, initialFilterFc: 8, initialFilterQ: 9, modLfoToFilterFc: 10, modEnvToFilterFc: 11, endAddrsCoarseOffset: 12, modLfoToVolume: 13,
  chorusEffectsSend: 15, reverbEffectsSend: 16, pan: 17, delayModLFO: 21, freqModLFO: 22, delayVibLFO: 23, freqVibLFO: 24, delayModEnv: 25, attackModEnv: 26,
  holdModEnv: 27, decayModEnv: 28, sustainModEnv: 29, releaseModEnv: 30, keynumToModEnvHold: 31, keynumToModEnvDecay: 32, delayVolEnv: 33, attackVolEnv: 34,
  holdVolEnv: 35, decayVolEnv: 36, sustainVolEnv: 37, releaseVolEnv: 38, keynumToVolEnvHold: 39, keynumToVolEnvDecay: 40, instrument: 41, keyRange: 43,
  velRange: 44, startloopAddrsCoarseOffset: 45, keynum: 46, velocity: 47, initialAttenuation: 48, endloopAddrsCoarseOffset: 50, coarseTune: 51, fineTune: 52,
  sampleID: 53, sampleModes: 54, scaleTuning: 56, exclusiveClass: 57, overridingRootKey: 58,
} as const;

const GEN_NAMES = new Map<number, string>(Object.entries(GEN).map(([k, v]) => [v, k]));

/** Generators that a preset may not add to: the instrument's value stands. */
const NOT_ADDITIVE = new Set<number>([GEN.keyRange, GEN.velRange, GEN.instrument, GEN.sampleID, GEN.sampleModes, GEN.exclusiveClass, GEN.overridingRootKey, GEN.keynum, GEN.velocity,
  GEN.startAddrsOffset, GEN.endAddrsOffset, GEN.startloopAddrsOffset, GEN.endloopAddrsOffset, GEN.startAddrsCoarseOffset, GEN.endAddrsCoarseOffset, GEN.startloopAddrsCoarseOffset, GEN.endloopAddrsCoarseOffset]);

const DEFAULTS = new Map<number, number>([
  [GEN.initialFilterFc, 13500], [GEN.delayModLFO, -12000], [GEN.delayVibLFO, -12000], [GEN.delayModEnv, -12000], [GEN.attackModEnv, -12000], [GEN.holdModEnv, -12000],
  [GEN.decayModEnv, -12000], [GEN.releaseModEnv, -12000], [GEN.delayVolEnv, -12000], [GEN.attackVolEnv, -12000], [GEN.holdVolEnv, -12000], [GEN.decayVolEnv, -12000],
  [GEN.releaseVolEnv, -12000], [GEN.scaleTuning, 100], [GEN.overridingRootKey, -1], [GEN.keynum, -1], [GEN.velocity, -1], [GEN.freqModLFO, 0], [GEN.freqVibLFO, 0],
]);
const dflt = (op: number): number => DEFAULTS.get(op) ?? 0;

/** The generators that are carried by name in the report when they differ from their default (and that the zones cannot say). */
const LOST_GENS = [
  GEN.modLfoToPitch, GEN.vibLfoToPitch, GEN.modEnvToPitch, GEN.initialFilterFc, GEN.initialFilterQ, GEN.modLfoToFilterFc, GEN.modEnvToFilterFc, GEN.modLfoToVolume,
  GEN.chorusEffectsSend, GEN.reverbEffectsSend, GEN.delayModLFO, GEN.freqModLFO, GEN.delayVibLFO, GEN.freqVibLFO, GEN.delayModEnv, GEN.attackModEnv, GEN.holdModEnv,
  GEN.decayModEnv, GEN.sustainModEnv, GEN.releaseModEnv, GEN.keynumToModEnvHold, GEN.keynumToModEnvDecay, GEN.delayVolEnv, GEN.keynumToVolEnvHold, GEN.keynumToVolEnvDecay,
  GEN.keynum, GEN.velocity,
];

function readZones(b: Uint8Array, bag: Chunk | undefined, gen: Chunk | undefined, mod: Chunk | undefined, first: number, last: number, what: string): Sf2Zone[] {
  const out: Sf2Zone[] = [];
  if (!bag || !gen) return out;
  const nBag = Math.floor(bag.size / 4);
  const nGen = Math.floor(gen.size / 4);
  const nMod = mod ? Math.floor(mod.size / 10) : 0;
  if (first > last || last >= nBag) throw new InstrumentImportError(`SoundFont: ${what} refers to zones that are not in the file (bag ${first}-${last} of ${nBag})`);
  for (let z = first; z < last; z++) {
    const g0 = u16(b, bag.start + z * 4);
    const g1 = u16(b, bag.start + (z + 1) * 4);
    const m0 = u16(b, bag.start + z * 4 + 2);
    const m1 = u16(b, bag.start + (z + 1) * 4 + 2);
    if (g1 < g0 || g1 > nGen) throw new InstrumentImportError(`SoundFont: ${what}, zone ${z - first + 1}: the generator list is outside the file`);
    const zone: Sf2Zone = { gens: new Map(), keyRange: null, velRange: null, target: null, mods: Math.max(0, Math.min(nMod, m1) - m0) };
    for (let g = g0; g < g1; g++) {
      const o = gen.start + g * 4;
      const op = u16(b, o);
      if (op === GEN.keyRange) zone.keyRange = [b[o + 2]!, b[o + 3]!];
      else if (op === GEN.velRange) zone.velRange = [b[o + 2]!, b[o + 3]!];
      else if (op === GEN.instrument || op === GEN.sampleID) { zone.target = u16(b, o + 2); break; }
      else if (op === GEN.sampleModes || op === GEN.exclusiveClass) zone.gens.set(op, u16(b, o + 2));
      else zone.gens.set(op, i16(b, o + 2));
    }
    out.push(zone);
  }
  return out;
}

/** Read the structure of a SoundFont 2 file. */
export function parseSf2(b: Uint8Array): Sf2File {
  if (b.length < 12 || tag(b, 0) !== 'RIFF' || tag(b, 8) !== 'sfbk') throw new InstrumentImportError('not a SoundFont 2 file (no RIFF sfbk header)');
  const top = chunksOf(b, 12, Math.min(b.length, 8 + u32(b, 4)));
  const lists = top.filter((c) => c.id === 'LIST').map((c) => ({ c, ...listOf(b, c) }));
  const info = lists.find((l) => l.type === 'INFO');
  const sdta = lists.find((l) => l.type === 'sdta');
  const pdta = lists.find((l) => l.type === 'pdta');
  if (!info || !sdta || !pdta) throw new InstrumentImportError('SoundFont: the file lacks its INFO, sdta or pdta list');
  const ch = (l: { chunks: Chunk[] }, id: string): Chunk | undefined => l.chunks.find((c) => c.id === id);

  const ifil = ch(info, 'ifil');
  const major = ifil && ifil.size >= 4 ? u16(b, ifil.start) : 2;
  const minor = ifil && ifil.size >= 4 ? u16(b, ifil.start + 2) : 0;
  if (major >= 3) throw new InstrumentImportError(`SoundFont ${major}.${minor} (compressed samples) is not read; SoundClaw reads SoundFont 2 (convert the file to .sf2 with uncompressed samples)`);
  const str = (id: string): string | undefined => { const c = ch(info, id); return c ? text(b, c.start, c.size) || undefined : undefined; };
  const infoOut: Sf2Info = { version: `${major}.${String(minor).padStart(2, '0')}`, name: str('INAM') ?? '' };
  for (const [k, id] of [['copyright', 'ICOP'], ['comment', 'ICMT'], ['engineers', 'IENG'], ['tools', 'ISFT'], ['product', 'IPRD']] as const) { const v = str(id); if (v) infoOut[k] = v; }

  const smplC = ch(sdta, 'smpl');
  if (!smplC) throw new InstrumentImportError('SoundFont: the file has no sample data (smpl chunk; a SoundFont that uses ROM samples cannot be read)');
  if (smplC.size >= 4 && tag(b, smplC.start) === 'OggS') throw new InstrumentImportError('SoundFont: the sample data is compressed (Ogg); SoundClaw reads uncompressed SoundFont 2');
  const smpl = b.subarray(smplC.start, smplC.start + smplC.size);
  const sm24C = ch(sdta, 'sm24');
  const nSamp = Math.floor(smpl.length / 2);
  const sm24 = sm24C && sm24C.size >= nSamp ? b.subarray(sm24C.start, sm24C.start + nSamp) : null;

  const need = (id: string): Chunk => { const c = ch(pdta, id); if (!c) throw new InstrumentImportError(`SoundFont: the pdta list has no '${id}' chunk`); return c; };
  const phdr = need('phdr'), pbag = need('pbag'), pgen = need('pgen'), inst = need('inst'), ibag = need('ibag'), igen = need('igen'), shdr = need('shdr');
  const pmod = ch(pdta, 'pmod');
  const imod = ch(pdta, 'imod');

  const samples: Sf2SampleHeader[] = [];
  const nSh = Math.max(0, Math.floor(shdr.size / 46) - 1);
  for (let i = 0; i < nSh; i++) {
    const o = shdr.start + i * 46;
    samples.push({
      index: i, name: text(b, o, 20), start: u32(b, o + 20), end: u32(b, o + 24), startLoop: u32(b, o + 28), endLoop: u32(b, o + 32), rate: u32(b, o + 36),
      originalPitch: b[o + 40]!, pitchCorrection: (b[o + 41]! << 24) >> 24, link: u16(b, o + 42), type: u16(b, o + 44),
    });
  }

  const instruments: Sf2Instrument[] = [];
  const nInst = Math.max(0, Math.floor(inst.size / 22) - 1);
  for (let i = 0; i < nInst; i++) {
    const o = inst.start + i * 22;
    const name = text(b, o, 20);
    instruments.push({ name, zones: readZones(b, ibag, igen, imod, u16(b, o + 20), u16(b, o + 22 + 20), `instrument '${name}'`) });
  }
  const presets: Sf2Preset[] = [];
  const nPh = Math.max(0, Math.floor(phdr.size / 38) - 1);
  for (let i = 0; i < nPh; i++) {
    const o = phdr.start + i * 38;
    const name = text(b, o, 20);
    presets.push({ name, program: u16(b, o + 20), bank: u16(b, o + 22), zones: readZones(b, pbag, pgen, pmod, u16(b, o + 24), u16(b, o + 38 + 24), `preset '${name}'`) });
  }
  return { info: infoOut, presets, instruments, samples, smpl, sm24 };
}

// ---- presets -----------------------------------------------------------------------------------------------------

export interface Sf2PresetInfo { index: number; bank: number; program: number; name: string; zones: number }

/** The presets in bank and program order. */
export function sf2PresetList(f: Sf2File): Sf2PresetInfo[] {
  return f.presets.map((p, index) => ({ index, bank: p.bank, program: p.program, name: p.name, zones: p.zones.filter((z) => z.target !== null).length }))
    .sort((a, b) => a.bank - b.bank || a.program - b.program || a.index - b.index);
}

export function sf2PresetListText(f: Sf2File): string {
  const list = sf2PresetList(f);
  return list.map((p) => `${String(p.bank).padStart(3, '0')}:${String(p.program).padStart(3, '0')}  ${p.name}  (${p.zones} zone${p.zones === 1 ? '' : 's'})`).join('\n');
}

/** Find a preset by `bank:program` or by name (exact, ignoring case; else a name containing the text if only one does). */
export function findSf2Preset(f: Sf2File, spec: string | undefined): Sf2PresetInfo {
  const list = sf2PresetList(f);
  if (!list.length) throw new InstrumentImportError('SoundFont: the file has no presets');
  if (spec === undefined || spec === '') {
    if (list.length === 1) return list[0]!;
    const shown = list.slice(0, 30).map((p) => `${p.bank}:${p.program} ${p.name}`).join(', ');
    throw new InstrumentImportError(`SoundFont: the file has ${list.length} presets; name one with preset=<bank>:<program> or preset=<name> (soundclaw instrument import <project> <file.sf2> --list shows them): ${shown}${list.length > 30 ? ', …' : ''}`);
  }
  const m = /^(\d+):(\d+)$/.exec(spec);
  if (m) {
    const hit = list.find((p) => p.bank === Number(m[1]) && p.program === Number(m[2]));
    if (!hit) throw new InstrumentImportError(`SoundFont: no preset ${spec} (soundclaw instrument import <project> <file.sf2> --list shows them)`);
    return hit;
  }
  const lc = spec.toLowerCase();
  const exact = list.filter((p) => p.name.toLowerCase() === lc);
  if (exact.length === 1) return exact[0]!;
  const some = exact.length ? exact : list.filter((p) => p.name.toLowerCase().includes(lc));
  if (some.length === 1) return some[0]!;
  if (!some.length) throw new InstrumentImportError(`SoundFont: no preset named '${spec}' (--list shows them)`);
  throw new InstrumentImportError(`SoundFont: '${spec}' names ${some.length} presets: ${some.slice(0, 12).map((p) => `${p.bank}:${p.program} ${p.name}`).join(', ')}; use preset=<bank>:<program>`);
}

// ---- a preset as zones -------------------------------------------------------------------------------------------

/** A sample of a SoundFont as the plan will store it. */
export interface Sf2PlanSample extends PlanSample {
  audio: PcmAudio;
  /** The header's root note and cents correction (a sample's own metadata). */
  root: number;
  tune: number;
  /** The header's loop in frames of the stored audio, when it has one. */
  loop?: [number, number];
  header: Sf2SampleHeader;
}

export interface Sf2Plan {
  plan: InstrumentPlan;
  samples: Sf2PlanSample[];
  presetName: string;
  info: Sf2Info;
}

/** The sample data of a header as stored audio (16-bit, or 24-bit when the file carries `sm24`). */
function audioOf(f: Sf2File, h: Sf2SampleHeader): PcmAudio {
  const frames = h.end - h.start;
  const total = Math.floor(f.smpl.length / 2);
  if (h.end > total || h.start >= h.end) throw new InstrumentImportError(`SoundFont: sample '${h.name}' lies outside the sample data (${h.start}-${h.end} of ${total})`);
  if (f.sm24) {
    const data = new Uint8Array(frames * 3);
    for (let i = 0; i < frames; i++) {
      const s = h.start + i;
      data[i * 3] = f.sm24[s]!;
      data[i * 3 + 1] = f.smpl[s * 2]!;
      data[i * 3 + 2] = f.smpl[s * 2 + 1]!;
    }
    return { rate: h.rate, channels: 1, format: 'pcm24', frames, data };
  }
  return { rate: h.rate, channels: 1, format: 'pcm16', frames, data: f.smpl.slice(h.start * 2, h.end * 2) };
}

const tc = (x: number): number => 2 ** (x / 1200);

interface Combined { gens: Map<number, number>; key: [number, number]; vel: [number, number]; sample: number; mods: number; instName: string }

function intersect(a: [number, number], b: [number, number]): [number, number] | null {
  const lo = Math.max(a[0], b[0]);
  const hi = Math.min(a[1], b[1]);
  return lo > hi ? null : [lo, hi];
}

/** The zones of a preset, preset and instrument generators combined as the SoundFont 2 rules say. */
function combine(f: Sf2File, p: Sf2Preset): Combined[] {
  const out: Combined[] = [];
  const pGlobal = p.zones.find((z, i) => i === 0 && z.target === null);
  for (const pz of p.zones) {
    if (pz.target === null) continue;
    const inst = f.instruments[pz.target];
    if (!inst) throw new InstrumentImportError(`SoundFont: preset '${p.name}' uses instrument ${pz.target}, which is not in the file`);
    const iGlobal = inst.zones.find((z, i) => i === 0 && z.target === null);
    const pKey = pz.keyRange ?? pGlobal?.keyRange ?? [0, 127];
    const pVel = pz.velRange ?? pGlobal?.velRange ?? [0, 127];
    for (const iz of inst.zones) {
      if (iz.target === null) continue;
      if (iz.target >= f.samples.length) throw new InstrumentImportError(`SoundFont: instrument '${inst.name}' uses sample ${iz.target}, which is not in the file`);
      const key = intersect(iz.keyRange ?? iGlobal?.keyRange ?? [0, 127], pKey as [number, number]);
      const vel = intersect(iz.velRange ?? iGlobal?.velRange ?? [0, 127], pVel as [number, number]);
      if (!key || !vel) continue;
      const gens = new Map<number, number>();
      for (const src of [iGlobal, iz]) if (src) for (const [k, v] of src.gens) gens.set(k, v);
      for (const src of [pGlobal, pz]) {
        if (!src) continue;
        for (const [k, v] of src.gens) if (!NOT_ADDITIVE.has(k)) gens.set(k, (gens.has(k) ? gens.get(k)! : dflt(k)) + v);
      }
      out.push({ gens, key, vel, sample: iz.target, mods: iz.mods + (iGlobal?.mods ?? 0) + pz.mods + (pGlobal?.mods ?? 0), instName: inst.name });
    }
  }
  return out;
}

const MAX_KEYTRACK0_SPAN = 16;

/** One preset as an instrument plan, with the audio of the samples it plays. */
export function sf2ToPlan(f: Sf2File, presetIndex: number): Sf2Plan {
  const p = f.presets[presetIndex];
  if (!p) throw new InstrumentImportError(`SoundFont: no preset ${presetIndex}`);
  const losses = new LossReport();
  const notes: string[] = [];
  const zones = combine(f, p);
  if (!zones.length) throw new InstrumentImportError(`SoundFont: preset '${p.name}' has no zone that plays a sample`);

  const samples = new Map<number, Sf2PlanSample>();
  const built: { zone: Zone; ref: number; env: string; scale0: boolean; exclusive: number }[] = [];
  const envs: [number, number, number, number][] = [];
  zones.forEach((c, n) => {
    const ref = n + 1;
    const note = (what: string, detail: string): void => losses.add('approximated', what, ref, detail);
    const h = f.samples[c.sample]!;
    if ((h.type & 0x8000) !== 0 || h.type === 0x8001 || h.type === 0x8002 || h.type === 0x8004 || h.type === 0x8008) throw new InstrumentImportError(`SoundFont: zone ${ref} (instrument '${c.instName}', sample '${h.name}') uses a ROM sample, which the file does not carry`);
    const bad = limitProblem({ rate: h.rate, channels: 1, frames: h.end - h.start });
    if (bad) throw new InstrumentImportError(`SoundFont: zone ${ref} (instrument '${c.instName}', sample '${h.name}'): ${bad}`);
    let ps = samples.get(c.sample);
    if (!ps) {
      let audio: PcmAudio;
      try { audio = audioOf(f, h); } catch (e) { throw new InstrumentImportError(`zone ${ref} (instrument '${c.instName}'): ${(e as Error).message}`); }
      const root = h.originalPitch <= 127 ? h.originalPitch : 60;
      const sh = h.startLoop - h.start;
      const eh = h.endLoop - h.start;
      ps = {
        key: `sample ${c.sample}`, label: h.name || `sample${c.sample}`, audio, root, tune: -h.pitchCorrection, header: h,
        ...(sh >= 0 && eh > sh && eh <= audio.frames ? { loop: [sh, eh] as [number, number] } : {}),
      };
      samples.set(c.sample, ps);
    }
    const g = (op: number): number => c.gens.get(op) ?? dflt(op);
    const rate = h.rate;
    // pitch: the root key, then coarse and fine tuning and the sample's own correction, all in cents
    const ork = g(GEN.overridingRootKey);
    const root = ork >= 0 && ork <= 127 ? ork : (h.originalPitch <= 127 ? h.originalPitch : 60);
    const tune = g(GEN.coarseTune) * 100 + g(GEN.fineTune) + h.pitchCorrection;
    const scale = g(GEN.scaleTuning);
    if (scale !== 100 && scale !== 0) note('scaleTuning', `${scale} cents per key; the zone follows the keys at 100 cents each`);
    // where it plays
    const startOff = g(GEN.startAddrsOffset) + g(GEN.startAddrsCoarseOffset) * 32768;
    const endOff = g(GEN.endAddrsOffset) + g(GEN.endAddrsCoarseOffset) * 32768;
    const frames = h.end - h.start;
    const offset = Math.max(0, Math.min(frames - 1, startOff));
    const endF = Math.max(offset + 1, Math.min(frames, frames + endOff));
    // loops
    const modes = c.gens.get(GEN.sampleModes) ?? 0;
    let loopmode: ZoneLoopMode = modes === 1 ? 'continuous' : modes === 3 ? 'sustain' : 'none';
    let loop: Zone['loop'] = loopmode === 'none' ? null : 'sample';
    if (loopmode !== 'none') {
      const ls = h.startLoop - h.start + g(GEN.startloopAddrsOffset) + g(GEN.startloopAddrsCoarseOffset) * 32768;
      const le = h.endLoop - h.start + g(GEN.endloopAddrsOffset) + g(GEN.endloopAddrsCoarseOffset) * 32768;
      if (le <= ls || ls < offset || le > frames) { loop = null; loopmode = 'none'; note('sampleModes', `the loop ${ls}-${le} of ${frames} frames is empty or outside what plays; no loop is used`); }
      else if (offset === 0 && ps.loop && ps.loop[0] === ls && ps.loop[1] === le) loop = 'sample';
      else loop = [roundTime((ls - offset) / rate), roundTime((le - offset) / rate)];
    }
    // pan: a left or right part of a stereo pair is hard left or right
    const kind = h.type & 0x7;
    const pan = kind === 4 ? -1 : kind === 2 ? 1 : Math.max(-500, Math.min(500, g(GEN.pan))) / 500;
    const gain = -g(GEN.initialAttenuation) / 10;
    const excl = c.gens.get(GEN.exclusiveClass) ?? 0;
    const zone = clampedZone(ps.key, root, {
      keys: c.key, vel: [Math.max(1, c.vel[0]), Math.max(1, c.vel[1])], tune, gain, pan, start: roundTime(offset / rate), end: endF < frames ? roundTime(endF / rate) : 0, loop, loopmode,
    }, note);
    // lost generators, named
    for (const op of LOST_GENS) {
      const v = c.gens.get(op);
      if (v === undefined || v === dflt(op)) continue;
      losses.add('lost', GEN_NAMES.get(op) ?? `generator ${op}`, ref);
    }
    for (const op of c.gens.keys()) if (!GEN_NAMES.has(op)) losses.add('lost', `generator ${op}`, ref);
    if (c.mods) losses.add('lost', 'modulators', ref, `${c.mods} in this zone`);
    // the volume envelope: attack, hold, decay, sustain, release
    const hold = g(GEN.holdVolEnv);
    if (hold > -7973) losses.add('lost', 'holdVolEnv', ref, `${r4(tc(hold))} s hold is not carried`);
    const susCb = Math.max(0, Math.min(1440, g(GEN.sustainVolEnv)));
    const sustain = 10 ** (-susCb / 200);
    const dropDb = Math.min(100, susCb / 10);
    const attack = tc(g(GEN.attackVolEnv));
    const decay = tc(g(GEN.decayVolEnv)) * (dropDb / 100);
    const release = tc(g(GEN.releaseVolEnv));
    envs.push([attack, decay, sustain, release]);
    built.push({ zone, ref, env: [attack, decay, sustain, release].map((x) => r4(x)).join(','), scale0: scale === 0, exclusive: excl });
  });

  // the instrument's envelope: one, the commonest
  const { value, unanimous } = modeOf(built.map((b) => b.env));
  const e = value!.split(',').map(Number) as [number, number, number, number];
  const adsr: [number, number, number, number] = [Math.max(0.001, Math.min(4, e[0])), Math.max(0, Math.min(4, e[1])), Math.max(0, Math.min(1, e[2])), Math.max(0.005, Math.min(8, e[3]))];
  if (!unanimous) for (const b of built) if (b.env !== value) losses.add('approximated', 'volume envelope', b.ref, `the instrument has one note envelope (${adsr.map((x) => r4(x)).join('/')}); this zone's is ${b.env.split(',').join('/')}`);
  notes.push('SoundFont envelopes fall in decibels; the instrument has one note envelope of its own shape, so its decay and release are close to the SoundFont\'s, not equal');

  // exclusive classes become choke groups
  const classes = new Groups();
  const ids = new Map<number, number>();
  for (const b of built) {
    if (!b.exclusive) continue;
    const k = classes.find(b.exclusive);
    if (!ids.has(k)) ids.set(k, ids.size + 1);
    if (ids.size > 99) throw new InstrumentImportError('SoundFont: more than 99 exclusive classes');
    b.zone.choke = ids.get(k)!;
  }
  const pitched = !built.every((b) => b.scale0);
  if (!pitched) notes.push('every zone has scaleTuning 0: the instrument is unpitched (pitched=no), so notes play the samples as they are');
  const planZones: PlanZone[] = [];
  const extra = new LossReport();
  for (const b of built) {
    if (b.scale0 && pitched) {
      const [a, z] = b.zone.keys;
      if (z - a + 1 <= MAX_KEYTRACK0_SPAN) {
        for (let n = a; n <= z; n++) planZones.push({ zone: { ...b.zone, keys: [n, n], root: n }, ref: b.ref });
        continue;
      }
      extra.add('approximated', 'scaleTuning', b.ref, `0 cents per key over ${z - a + 1} keys; the zone is transposed from its root as other zones are`);
    }
    planZones.push({ zone: b.zone, ref: b.ref });
  }
  checkZoneCount(planZones.length, `preset '${p.name}' (${built.length} zones)`);
  if (f.info.name || f.info.copyright) notes.push(`SoundFont ${f.info.name ? `'${f.info.name}'` : ''}${f.info.copyright ? ` ${f.info.copyright}` : ''}: the licence stays unknown until you set it`);
  return {
    plan: { source: 'sf2', zones: planZones, adsr, velocity: null, pitched, rr: null, losses: [...losses.list(), ...extra.list()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'lost' ? -1 : 1)), notes },
    samples: [...samples.values()], presetName: p.name, info: f.info,
  };
}
