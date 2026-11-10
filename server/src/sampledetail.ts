// What the sample page shows that the list does not: where the audio came from (the whole provenance), its licence and why it stands as it does,
// the metadata a handle edits, and what uses it. One JSON object, worked out from the tape's current state.

import { itemSamples, licenceState, noteLabel, reachedSamples, type SampleEntry } from '@soundclaw/core';
import type { Writer } from './writer.ts';
import { ProjectError } from './project.ts';
import type { SampleInfo } from './samples.ts';

export interface SampleDetail {
  info: SampleInfo;
  /** The metadata a handle edits, frames at the sample's own rate. */
  meta: { root?: string; tune?: number; loop?: [number, number]; loopMode?: string; slices?: number[]; tags: string[]; gain?: number; note?: string };
  prov: { source: string; origin?: string; origHash?: string; origFormat?: string; containerHash?: string; date?: string; author?: string; provider?: string; endpoint?: string; model?: string; prompt?: string; params?: string; seed?: number; take?: string; keptFrom?: string; request?: string; credits?: number; parents?: { hash: string; name: string | null }[]; ops?: string };
  licence: { id: string; state: string; reason: string; attribution?: string; terms?: string };
  /** What plays this sample, directly or through a sample made from it. */
  usedBy: { sounds: string[]; instruments: string[]; songs: string[]; samples: string[] };
}

export function sampleDetail(w: Writer, name: string): SampleDetail {
  const x = w.samples.all().find((s) => s.entry.name === name);
  if (!x) throw new ProjectError(`no sample '${name}'`);
  const e: SampleEntry = x.entry;
  const lib = w.sampleLibrary();
  const lic = licenceState(e.licence, w.samples.shipPolicy);
  const reaches = (kind: 'sound' | 'instrument' | 'song', id: string): boolean => reachedSamples(lib, itemSamples(lib, kind, id)).some((r) => r.name === name);
  const byHash = new Map<string, string>();
  for (const s of lib.samples.values()) if (!byHash.has(s.hash)) byHash.set(s.hash, s.name);
  const p = e.prov;
  return {
    info: w.samples.infoOf(x),
    meta: {
      ...(e.root !== undefined ? { root: noteLabel(e.root) } : {}), ...(e.tune !== undefined ? { tune: e.tune } : {}),
      ...(e.loop ? { loop: e.loop } : {}), ...(e.loopMode ? { loopMode: e.loopMode } : {}), ...(e.slices?.length ? { slices: e.slices } : {}),
      tags: e.tags, ...(e.gain !== undefined ? { gain: e.gain } : {}), ...(e.note ? { note: e.note } : {}),
    },
    prov: {
      source: p.source,
      ...(p.origin ? { origin: p.origin } : {}), ...(p.origHash ? { origHash: p.origHash } : {}), ...(p.origFormat ? { origFormat: p.origFormat } : {}), ...(p.containerHash ? { containerHash: p.containerHash } : {}),
      ...(p.date ? { date: p.date } : {}), ...(p.author ? { author: p.author } : {}), ...(p.provider ? { provider: p.provider } : {}), ...(p.endpoint ? { endpoint: p.endpoint } : {}),
      ...(p.model ? { model: p.model } : {}), ...(p.prompt ? { prompt: p.prompt } : {}), ...(p.params ? { params: p.params } : {}), ...(p.seed !== undefined ? { seed: p.seed } : {}),
      ...(p.take ? { take: p.take } : {}), ...(p.keptFrom ? { keptFrom: p.keptFrom } : {}), ...(p.request ? { request: p.request } : {}), ...(p.credits !== undefined ? { credits: p.credits } : {}),
      ...(p.parents?.length ? { parents: p.parents.map((h) => ({ hash: h, name: byHash.get(h) ?? null })) } : {}), ...(p.ops ? { ops: p.ops } : {}),
    },
    licence: { id: e.licence.id, state: lic.state, reason: lic.reason, ...(e.licence.attribution ? { attribution: e.licence.attribution } : {}), ...(e.licence.terms ? { terms: e.licence.terms } : {}) },
    usedBy: {
      sounds: w.sounds().filter((s) => reaches('sound', s.id)).map((s) => s.id),
      instruments: [...lib.instruments.keys()].filter((i) => reaches('instrument', i)),
      songs: [...lib.songs.keys()].filter((s) => reaches('song', s)),
      samples: [...lib.samples.values()].filter((s) => s.name !== name && (s.prov.parents ?? []).includes(e.hash)).map((s) => s.name),
    },
  };
}
