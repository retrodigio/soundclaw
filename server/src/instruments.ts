// Sampled instruments on the server side: `check` and the key-map view of an instrument, a text listing of its zones, and the SFZ export.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  attributionText, checkInstrument, instrumentCheckLines, instrumentToSfz, keymapView, noteLabel, zoneWords,
  type Instrument, type InstrumentCheck, type ItemLicence,
} from '@soundclaw/core';
import { ProjectError } from './project.ts';
import type { Writer } from './writer.ts';

/** A project instrument, or an error naming the instruments there are. */
export function projectInstrument(w: Writer, id: string): Instrument {
  const i = w.instruments().find((x) => x.id === id);
  if (!i) {
    const ids = w.instruments().map((x) => x.id);
    throw new ProjectError(`no instrument '${id}' in the project${ids.length ? ` (instruments: ${ids.join(', ')})` : ''}`);
  }
  return i;
}

/** Whether `id` names a project instrument (and not a sound, a set or a song). */
export const isProjectInstrument = (w: Writer, id: string): boolean => !w.has(id) && !w.hasSong(id) && !w.hasSet(id) && w.instruments().some((x) => x.id === id);

export function instrumentCheckOf(w: Writer, id: string): InstrumentCheck {
  const i = projectInstrument(w, id);
  return checkInstrument(i, w.samples.bankFor(w.sampleLibrary()));
}

/** `check` for instruments: text, pass, and the JSON objects. */
export function instrumentChecksText(w: Writer, ids: readonly string[]): { text: string; pass: boolean; json: InstrumentCheck[] } {
  const rs = ids.map((id) => instrumentCheckOf(w, id));
  return { text: rs.map((r) => instrumentCheckLines(r).join('\n')).join('\n\n'), pass: rs.every((r) => r.pass), json: rs };
}

/** The zones in words. */
export function instrumentZonesText(w: Writer, id: string): string {
  const i = projectInstrument(w, id);
  const zs = i.zones ?? [];
  const head = `instrument ${id}: ${zs.length} zone${zs.length === 1 ? '' : 's'}${i.voice.layers.length ? `, ${i.voice.layers.length} synth layer${i.voice.layers.length === 1 ? '' : 's'}` : ''}, note envelope ${i.attack}/${i.decay}/${i.sustain}/${i.release} s${i.velxfade ? `, velocity crossfade ${i.velxfade}` : ''}${i.rr ? `, round robin by ${i.rr}` : ''}${i.range ? `, range ${noteLabel(i.range[0])}-${noteLabel(i.range[1])}` : ''}`;
  return [head, ...zs.map((z, k) => `  ${k + 1}  ${zoneWords(z, noteLabel).join(' ')}`)].join('\n');
}

export function viewKeymap(w: Writer, id: string, out?: string): { png: Uint8Array; file: string; text: string } {
  const i = projectInstrument(w, id);
  const check = checkInstrument(i, w.samples.bankFor(w.sampleLibrary()));
  const img = keymapView(i, check);
  const file = out ? resolve(out) : join(w.project.dir, '.cache', 'views', `${id}-keymap.png`);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, img.png);
  return { png: img.png, file, text: `keymap view saved to ${file}\n${instrumentCheckLines(check).join('\n')}` };
}

export interface InstrumentExport {
  dir: string;
  sfz: string;
  samples: string[];
  attribution: boolean;
  notes: string[];
}

/** Write an instrument as an SFZ with its samples as WAV files (and ATTRIBUTION.txt when a licence asks for it). */
export function exportInstrument(w: Writer, id: string, o: { format?: string; out?: string } = {}): InstrumentExport {
  const format = o.format ?? 'sfz';
  if (format !== 'sfz') throw new ProjectError(`instrument export: --format is sfz (not '${format}')`);
  const inst = projectInstrument(w, id);
  if (!inst.zones?.length) throw new ProjectError(`instrument ${id} has no zones to export (instrument zone add ${id} sample=<name> root=<note> keys=<lo>-<hi>)`);
  const lib = w.sampleLibrary();
  const dir = resolve(o.out ?? join(w.project.dir, 'exports', id));
  const sfz = instrumentToSfz(inst, (n) => lib.samples.get(n) ?? w.samples.entry(n));
  const notes = sfz.lost.map((l) => `not written: ${l}`);
  mkdirSync(join(dir, 'samples'), { recursive: true });
  for (const f of sfz.files) {
    const e = lib.samples.get(f.sample) ?? w.samples.entry(f.sample);
    const bytes = e ? w.samples.objectBytes2(e.hash) : undefined;
    if (!bytes) throw new ProjectError(`the audio of sample ${f.sample} is not in the store`);
    writeFileSync(join(dir, 'samples', f.file), bytes);
  }
  const file = join(dir, `${id}.sfz`);
  writeFileSync(file, sfz.text);
  const lic: ItemLicence = w.samples.itemLicence(lib, 'instrument', id);
  const attr = attributionText(lic.samples);
  if (attr) writeFileSync(join(dir, 'ATTRIBUTION.txt'), attr);
  if (lic.state === 'blocked' || lic.state === 'unknown') {
    const why = lic.samples.filter((s) => s.state === 'blocked' || s.state === 'unknown').map((s) => `${s.name} (${s.licence.id}: ${s.reason})`);
    notes.push(`licence: ${lic.state}: ${why.join('; ')}`);
  }
  void existsSync;
  return { dir, sfz: file, samples: sfz.files.map((f) => f.file), attribution: !!attr, notes };
}

export function formatInstrumentExport(r: InstrumentExport): string {
  return [`wrote ${r.sfz}`, `  ${r.samples.length} sample${r.samples.length === 1 ? '' : 's'} in ${join(r.dir, 'samples')}${r.attribution ? ', ATTRIBUTION.txt' : ''}`, ...r.notes.map((n) => `  ${n}`)].join('\n');
}
