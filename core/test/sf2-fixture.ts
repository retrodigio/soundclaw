// A SoundFont 2 file built by test code (no third-party sound fonts anywhere): the RIFF structure of INFO, sdta and pdta with the
// tables the reader uses, from a small description.

export interface FixtureSample {
  name: string;
  /** 16-bit samples; the data of 24-bit fixtures also gives `low` bytes. */
  pcm: Int16Array;
  low?: Uint8Array;
  rate: number;
  rootKey: number;
  correction?: number;
  loop?: [number, number];
  /** 1 mono, 2 right, 4 left (default 1). */
  type?: number;
}

export type Gen = [op: number, amount: number | [number, number]];

export interface FixtureZone {
  gens?: Gen[];
  keys?: [number, number];
  vel?: [number, number];
  /** The instrument (preset zones) or the sample (instrument zones) index; omit for a global zone. */
  target?: number;
  mods?: number;
}

export interface Sf2Description {
  info?: Record<string, string>;
  version?: [number, number];
  samples: FixtureSample[];
  instruments: { name: string; zones: FixtureZone[] }[];
  presets: { name: string; bank: number; program: number; zones: FixtureZone[] }[];
}

const le16 = (n: number): number[] => [n & 255, (n >> 8) & 255];
const le32 = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const ascii = (s: string, n?: number): number[] => {
  const out = [...s].map((c) => c.charCodeAt(0) & 127);
  if (n !== undefined) { while (out.length < n) out.push(0); return out.slice(0, n); }
  out.push(0);
  if (out.length % 2) out.push(0);
  return out;
};
const chunk = (id: string, body: number[] | Uint8Array): number[] => {
  const b = [...body];
  return [...ascii(id, 4), ...le32(b.length), ...b, ...(b.length % 2 ? [0] : [])];
};
const list = (type: string, parts: number[][]): number[] => chunk('LIST', [...ascii(type, 4), ...parts.flat()]);

/** The bytes of a SoundFont 2 file. */
export function buildSf2(d: Sf2Description): Uint8Array {
  const info: number[][] = [chunk('ifil', [...le16(d.version?.[0] ?? 2), ...le16(d.version?.[1] ?? 1)]), chunk('isng', ascii('EMU8000')), chunk('INAM', ascii(d.info?.INAM ?? 'Test font'))];
  for (const [k, v] of Object.entries(d.info ?? {})) if (k !== 'INAM') info.push(chunk(k, ascii(v)));
  // sample data: each sample followed by 46 zero points, as the format asks
  const smpl: number[] = [];
  const low: number[] = [];
  const headers: number[] = [];
  const has24 = d.samples.some((s) => s.low);
  for (const s of d.samples) {
    const start = smpl.length / 2;
    for (let i = 0; i < s.pcm.length; i++) { smpl.push(...le16(s.pcm[i]! & 0xffff)); low.push(s.low?.[i] ?? 0); }
    const end = smpl.length / 2;
    for (let i = 0; i < 46; i++) { smpl.push(0, 0); low.push(0); }
    const [ls, le] = s.loop ?? [0, 0];
    headers.push(...ascii(s.name, 20), ...le32(start), ...le32(end), ...le32(s.loop ? start + ls : start), ...le32(s.loop ? start + le : start), ...le32(s.rate), s.rootKey, (s.correction ?? 0) & 255, ...le16(0), ...le16(s.type ?? 1));
  }
  headers.push(...ascii('EOS', 20), ...le32(0), ...le32(0), ...le32(0), ...le32(0), ...le32(0), 0, 0, ...le16(0), ...le16(0));
  const sdta = list('sdta', [chunk('smpl', smpl), ...(has24 ? [chunk('sm24', low)] : [])]);

  const tables = (groups: FixtureZone[][], terminal: number): { bag: number[]; gen: number[]; mod: number[]; first: number[] } => {
    const bag: number[] = [];
    const gen: number[] = [];
    const mod: number[] = [];
    const first: number[] = [];
    let g = 0, m = 0, z = 0;
    for (const zones of groups) {
      first.push(z);
      for (const zone of zones) {
        bag.push(...le16(g), ...le16(m));
        z++;
        const gens: Gen[] = [...(zone.keys ? [[43, zone.keys] as Gen] : []), ...(zone.vel ? [[44, zone.vel] as Gen] : []), ...(zone.gens ?? [])];
        for (const [op, amount] of gens) { gen.push(...le16(op), ...(Array.isArray(amount) ? amount : le16(amount & 0xffff))); g++; }
        if (zone.target !== undefined) { gen.push(...le16(terminal), ...le16(zone.target)); g++; }
        for (let i = 0; i < (zone.mods ?? 0); i++) { mod.push(...new Array(10).fill(0)); m++; }
      }
    }
    bag.push(...le16(g), ...le16(m));
    gen.push(...le16(0), ...le16(0));
    mod.push(...new Array(10).fill(0));
    first.push(z);
    return { bag, gen, mod, first };
  };
  const pt = tables(d.presets.map((p) => p.zones), 41);
  const it = tables(d.instruments.map((i) => i.zones), 53);
  const phdr: number[] = [];
  d.presets.forEach((p, i) => phdr.push(...ascii(p.name, 20), ...le16(p.program), ...le16(p.bank), ...le16(pt.first[i]!), ...le32(0), ...le32(0), ...le32(0)));
  phdr.push(...ascii('EOP', 20), ...le16(0), ...le16(0), ...le16(pt.first[d.presets.length]!), ...le32(0), ...le32(0), ...le32(0));
  const inst: number[] = [];
  d.instruments.forEach((x, i) => inst.push(...ascii(x.name, 20), ...le16(it.first[i]!)));
  inst.push(...ascii('EOI', 20), ...le16(it.first[d.instruments.length]!));
  const pdta = list('pdta', [chunk('phdr', phdr), chunk('pbag', pt.bag), chunk('pmod', pt.mod), chunk('pgen', pt.gen), chunk('inst', inst), chunk('ibag', it.bag), chunk('imod', it.mod), chunk('igen', it.gen), chunk('shdr', headers)]);
  const body = [...ascii('sfbk', 4), ...list('INFO', info), ...sdta, ...pdta];
  return Uint8Array.from([...ascii('RIFF', 4), ...le32(body.length), ...body]);
}

/** Generator numbers the tests use. */
export const G = {
  startAddrsOffset: 0, endAddrsOffset: 1, startloopAddrsOffset: 2, endloopAddrsOffset: 3, initialFilterFc: 8, reverbEffectsSend: 16, pan: 17, attackVolEnv: 34, holdVolEnv: 35,
  decayVolEnv: 36, sustainVolEnv: 37, releaseVolEnv: 38, initialAttenuation: 48, coarseTune: 51, fineTune: 52, sampleModes: 54, scaleTuning: 56, exclusiveClass: 57, overridingRootKey: 58,
} as const;
