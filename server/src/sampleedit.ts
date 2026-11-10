// The commands that are worked out when they run: `sample derive`, `sample bounce`, `sample slice`, `sample loop`,
// `layer align`, `layer match` and `env … follow=`. Each is measured or computed against the batch so far and put on the
// tape as the plain commands it found (`sample add` with the new audio's hash, `sample set`, `layer set`, `env`), so a
// replay applies numbers and measures nothing. New audio goes into the store first; the tape names it.

import {
  decodeAudio, deriveAudio, findLoops, findOnsets, measureLayerCommand, measureSample, noteLabel, pcmChannels, pcmFromFloats, pcmHash, quote, renderKey,
  type Command, type Library, type LicenceState, type PcmAudio, type SampleCommand, type SampleEntry, type Sound, type SongDoc, type SongRender,
} from '@soundclaw/core';
import type { RenderCache } from './cache.ts';
import type { SampleStore } from './samples.ts';

/** What the measured commands need of the writer. */
export interface EditHost {
  samples: SampleStore;
  cache: RenderCache;
  /** The last tape number written (a bounce says where on the tape it was made). */
  seq: number;
  renderSong(song: SongDoc, o: { mode?: 'full' | 'loop'; only?: readonly string[] }): SongRender;
}

export interface Expanded {
  commands: string[];
  notes: string[];
}

export const MEASURED_OPS = new Set(['song-clip', 'sample-derive', 'sample-bounce', 'sample-slice', 'sample-loop', 'layer-align', 'layer-match', 'env-follow', 'inst-zones', 'inst-from-sample']);

const word = (v: string): string => (/^[^\s"\\;]+$/.test(v) ? v : quote(v));

/** The audio of a hash: a store object, or a 0.1.x file. */
export function audioOf(host: { samples: SampleStore }, hash: string): PcmAudio | undefined {
  const bytes = host.samples.objectBytes2(hash);
  return bytes ? decodeAudio(bytes, { lenient: true }).audio : undefined;
}

function entryOf(host: EditHost, next: Library, name: string): SampleEntry {
  const e = next.samples.get(name) ?? host.samples.entry(name);
  if (!e) {
    const names = [...new Set([...next.samples.keys(), ...host.samples.names()])].sort();
    throw new Error(`no sample '${name}'${names.length ? ` (samples: ${names.join(', ')})` : ''}`);
  }
  return e;
}

/** A time as frames at a rate: seconds, `250ms` or `1234f`. */
function framesOf(w: string, rate: number): number {
  if (/^\d+f$/.test(w)) return Number(w.slice(0, -1));
  const m = /^(\d*\.?\d+)(ms|s)?$/.exec(w);
  if (!m) throw new Error(`'${w}' is not a time (seconds, 250ms or 1234f)`);
  return Math.round((Number(m[1]) / (m[2] === 'ms' ? 1000 : 1)) * rate);
}

const mono = (chs: readonly Float32Array[]): Float32Array => {
  if (chs.length === 1) return chs[0]!;
  const out = new Float32Array(chs[0]!.length);
  for (let i = 0; i < out.length; i++) { let s = 0; for (const c of chs) s += c[i]!; out[i] = s / chs.length; }
  return out;
};

const STATE_ORDER: LicenceState[] = ['shippable', 'attribution', 'unknown', 'blocked'];

/** The fields of a `sample add` for audio this command made. */
function addText(name: string, audio: PcmAudio, hash: string, extra: Record<string, string | undefined>): string {
  const f: Record<string, string> = { hash, rate: String(audio.rate), channels: String(audio.channels), frames: String(audio.frames), format: audio.format };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) f[k] = v;
  return `sample add ${name}${Object.entries(f).map(([k, v]) => ` ${k}=${word(v)}`).join('')}`;
}

/** The fields a user gave (and the parent's tags) as `k=v` words, the user's winning. */
function userFields(given: SampleCommandFields, inherited: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...inherited };
  for (const [k, v] of Object.entries(given)) out[k] = v;
  return out;
}
type SampleCommandFields = Partial<Record<string, string>>;

/** The note a sample sounds at, found once and settled as a root note and a tuning in cents (zone `tune` is the cents to add to play it in tune). */
function soundsAt(host: EditHost, e: SampleEntry, measure: boolean): { root: number; tune: number; how: string } {
  if (!measure && e.root !== undefined) return { root: e.root, tune: -Math.round(e.tune ?? 0), how: 'its root note' };
  const a = audioOf(host, e.hash);
  if (!a) throw new Error(`the audio of sample ${e.name} is not in the store`);
  const m = measureSample(pcmChannels(a, 8), a.rate, { maxSeconds: 8 });
  if (!m.pitch || m.pitch.confidence < 0.5) throw new Error(`I cannot hear a steady pitch in sample ${e.name}${m.pitch ? ` (confidence ${m.pitch.confidence.toFixed(2)})` : ''}: set its root note with sample set ${e.name} root=<note>, or give each zone a root`);
  return { root: m.pitch.midi, tune: -Math.round(m.pitch.cents), how: `measured ${m.pitch.hz.toFixed(1)} Hz, confidence ${m.pitch.confidence.toFixed(2)}` };
}

function buildZones(host: EditHost, next: Library, c: Extract<MusicCommandLike, { op: 'inst-zones' | 'inst-from-sample' }>): Expanded {
  const inst = next.instruments.get(c.id);
  const notes: string[] = [];
  const commands: string[] = [];
  if (c.op === 'inst-from-sample') {
    if (inst) throw new Error(`instrument '${c.id}' exists already: instrument zones ${c.id} from-samples ${c.sample} adds it as a zone`);
    const e = entryOf(host, next, c.sample);
    const at = soundsAt(host, e, e.root === undefined);
    commands.push(`instrument new ${c.id} kind=zones seed=1`);
    let loop = '';
    if (c.loop === 'find' && !e.loop) {
      const au = audioOf(host, e.hash);
      if (!au) throw new Error(`the audio of sample ${c.sample} is not in the store`);
      const found = findLoops(mono(pcmChannels(au)), au.rate, { top: 3 });
      if (!found.length) throw new Error(`instrument from-sample: no loop found in ${c.sample}: set one by hand with sample loop ${c.sample} <start> <end>, or leave loop=find out`);
      commands.push(`sample set ${c.sample} loop=${found[0]!.start}-${found[0]!.end} loopmode=sustain`);
      loop = `; loop ${found[0]!.start}-${found[0]!.end} frames (click ${found[0]!.seam.clickDb.toFixed(1)} dB)`;
    }
    commands.push(`instrument zone add ${c.id} sample=${c.sample} root=${noteLabel(at.root)}${at.tune ? ` tune=${at.tune}` : ''} keys=${noteLabel(0)}-${noteLabel(127)}`);
    notes.push(`instrument ${c.id}: one zone, sample ${c.sample} at ${noteLabel(at.root)}${at.tune ? ` ${at.tune > 0 ? '+' : ''}${at.tune} cents` : ''} (${at.how})${loop}`);
    return { commands, notes };
  }
  if (!inst) throw new Error(`no instrument '${c.id}' (instrument new ${c.id} kind=zones)`);
  if (c.how === 'from-slices') {
    const e = entryOf(host, next, c.names[0]!);
    const n = e.slices?.length ?? 0;
    if (!n) throw new Error(`sample ${e.name} has no slice points (sample slice ${e.name} at=onsets, or grid=<n>)`);
    const start = c.start ?? 36;
    const count = Math.min(n, 128 - start);
    if (count < n) notes.push(`only ${count} of ${n} slices fit from ${noteLabel(start)} to the top of the keyboard`);
    for (let k = 1; k <= count; k++) commands.push(`instrument zone add ${c.id} sample=${e.name} slice=${k} root=${noteLabel(start + k - 1)} keys=${noteLabel(start + k - 1)}-${noteLabel(start + k - 1)}${c.vel ? ` vel=${c.vel[0]}-${c.vel[1]}` : ''} loop=none loopmode=oneshot`);
    notes.push(`instrument ${c.id}: ${count} slice zones of ${e.name} on ${noteLabel(start)}-${noteLabel(start + count - 1)}, played whole (loopmode=oneshot)`);
    return { commands, notes };
  }
  const found = c.names.map((name) => {
    const e = entryOf(host, next, name);
    const at = soundsAt(host, e, c.root === 'detect');
    return { name, ...at };
  });
  const order = found.map((f, i) => ({ ...f, i })).sort((a, b) => a.root - b.root || a.i - b.i);
  const roots = [...new Set(order.map((f) => f.root))];
  const rangeOf = (root: number): [number, number] => {
    const k = roots.indexOf(root);
    const lo = k === 0 ? 0 : Math.floor((roots[k - 1]! + root) / 2) + 1;
    const hi = k === roots.length - 1 ? 127 : Math.floor((root + roots[k + 1]!) / 2);
    return [lo, hi];
  };
  for (const f of order) {
    const [lo, hi] = rangeOf(f.root);
    commands.push(`instrument zone add ${c.id} sample=${f.name} root=${noteLabel(f.root)}${f.tune ? ` tune=${f.tune}` : ''} keys=${noteLabel(lo)}-${noteLabel(hi)}${c.vel ? ` vel=${c.vel[0]}-${c.vel[1]}` : ''}`);
    notes.push(`  ${f.name}: root ${noteLabel(f.root)}${f.tune ? ` ${f.tune > 0 ? '+' : ''}${f.tune} cents` : ''} (${f.how}), keys ${noteLabel(lo)}-${noteLabel(hi)}`);
  }
  notes.unshift(`instrument ${c.id}: ${order.length} zone${order.length === 1 ? '' : 's'} added`);
  return { commands, notes };
}

type MusicCommandLike = { op: 'inst-zones'; id: string; how: 'from-samples' | 'from-slices'; names: string[]; root: 'detect' | null; vel: [number, number] | null; start: number | null; text: string }
  | { op: 'inst-from-sample'; id: string; sample: string; loop: 'find' | null; text: string };

/** `song clip add|set`: checks the sample, settles `from-tempo` when the clip is to follow the tempo and no tempo was given, and says which clip it made. */
function settleClip(host: EditHost, next: Library, c: ClipCommandLike): Expanded {
  if (c.verb === 'remove') return { commands: [c.text], notes: [] };
  const song = next.songs.get(c.id);
  const channel = song?.channels.find((x) => x.name === c.channel);
  const have = c.verb === 'set' ? channel?.clips?.find((k) => k.id === c.clip) : undefined;
  const name = c.fields.sample ?? have?.sample;
  if (!name) return { commands: [c.text], notes: [] };
  const e = entryOf(host, next, name);
  const slice = c.fields.slice ?? have?.slice ?? 0;
  if (slice > (e.slices?.length ?? 0)) throw new Error(`song ${c.id}: clip plays slice ${slice}, but sample ${name} ${e.slices?.length ? `has ${e.slices.length} slice${e.slices.length === 1 ? '' : 's'}` : 'has no slice points'} (sample slice ${name} at=onsets, or grid=<n>)`);
  const stretch = c.fields.stretch ?? (c.fields.fromTempo !== undefined && c.fields.fromTempo !== 'none' ? 'tempo' : have?.stretch ?? 'none');
  const given = c.fields.fromTempo !== undefined ? (c.fields.fromTempo === 'none' ? null : c.fields.fromTempo) : have?.fromTempo ?? null;
  const notes: string[] = [];
  let text = c.text;
  if (stretch === 'tempo' && !given) {
    const a = audioOf(host, e.hash);
    if (!a) throw new Error(`the audio of sample ${name} is not in the store`);
    const m = measureSample(pcmChannels(a, 8), a.rate, { maxSeconds: 30 });
    if (!m.tempo) throw new Error(`I cannot hear a steady tempo in sample ${name}: give from-tempo=<bpm>, the tempo it was made at`);
    const bpm = Math.round(m.tempo * 10) / 10;
    text += ` from-tempo=${bpm}`;
    notes.push(`clip of ${name}: from-tempo=${bpm} (measured from the spacing of its onsets)`);
  }
  if (c.verb === 'add' && song) {
    const id = 1 + song.channels.reduce((m, ch) => (ch.clips ?? []).reduce((n, k) => Math.max(n, k.id), m), 0);
    notes.unshift(`song ${c.id}: clip ${id} on ${c.channel}: ${name} at ${c.fields.at}`);
  }
  return { commands: [text], notes };
}

type ClipCommandLike = { op: 'song-clip'; verb: 'add' | 'set' | 'remove'; id: string; channel: string; clip: number | null; fields: { sample?: string; at?: string; slice?: number; stretch?: 'none' | 'tempo'; fromTempo?: number | 'none' }; text: string };

export function expand(host: EditHost, next: Library, c: Command): Expanded {
  if (c.op === 'song-clip') return settleClip(host, next, c as unknown as ClipCommandLike);
  if (c.op === 'inst-zones' || c.op === 'inst-from-sample') return buildZones(host, next, c as unknown as MusicCommandLike);
  if (c.op === 'layer-align' || c.op === 'layer-match' || c.op === 'env-follow') return measureLayerCommand(next, c, host.samples.bankFor(next));
  const sc = c as unknown as SampleCommand;
  switch (sc.op) {
    case 'sample-derive': {
      const parent = entryOf(host, next, sc.from);
      const src = audioOf(host, parent.hash);
      if (!src) throw new Error(`the audio of sample ${sc.from} (${parent.hash.slice(0, 12)}) is not in the store`);
      const res = deriveAudio(src, sc.chain, {
        ...(parent.slices ? { slices: parent.slices } : {}),
        byName: (n) => { const e = next.samples.get(n) ?? host.samples.entry(n); const a = e ? audioOf(host, e.hash) : undefined; return e && a ? { hash: e.hash, audio: a } : undefined; },
        byHash: (h) => audioOf(host, h),
      });
      const hash = pcmHash(res.audio);
      host.samples.store.put(res.audio, hash);
      const loop = res.loop ? { loop: `${res.loop[0]}-${res.loop[1]}`, loopmode: 'sustain' } : {};
      const text = addText(sc.name, res.audio, hash, userFields(sc.fields, {
        ...loop,
        ...(parent.tags.length ? { tags: parent.tags.join(',') } : {}),
        source: 'derived', parents: [parent.hash, ...res.mixed.filter((h) => h !== parent.hash)].join(','), ops: res.settled,
        licence: parent.licence.id, ...(parent.licence.attribution ? { attribution: parent.licence.attribution } : {}), ...(parent.licence.terms ? { terms: parent.licence.terms } : {}),
      }));
      const secs = res.audio.frames / res.audio.rate;
      return { commands: [text], notes: [`sample ${sc.name}: ${secs.toFixed(3)} s, ${res.audio.channels === 1 ? 'mono' : res.audio.channels + ' channels'}, from ${sc.from} by: ${res.settled}`] };
    }
    case 'sample-bounce': {
      const asSong = next.songs.has(sc.from);
      const sound = next.get(sc.from);
      if (!asSong && !sound) throw new Error(`sample bounce: no sound or song '${sc.from}'`);
      let chs: Float32Array[];
      let rate = 44100;
      let origin: string;
      let key = '';
      if (asSong) {
        if (sc.layer !== null) throw new Error('sample bounce: layer= is for a sound; a song is bounced whole or by channel=<name>');
        const song = next.songs.get(sc.from)!;
        const names = song.channels.map((x) => x.name);
        if (sc.channel && !names.includes(sc.channel)) throw new Error(`sample bounce: song ${sc.from} has no channel '${sc.channel}' (channels: ${names.join(', ')})`);
        const looped = sc.loop;
        const r = host.renderSong(song, { mode: looped ? 'loop' : 'full', ...(sc.channel ? { only: [sc.channel] } : {}) });
        chs = [r.mix[0], r.mix[1]];
        origin = `song ${sc.from}${sc.channel ? ` channel ${sc.channel}` : ''}`;
        key = `song ${sc.from}`;
      } else {
        if (sc.channel) throw new Error('sample bounce: channel= is for a song');
        let s: Sound = sound!;
        if (sc.layer !== null) {
          if (s.voice !== 'layered') throw new Error(`sample bounce: ${sc.from} is a ${s.voice} sound; layer= is for a layered sound`);
          if (!s.layers[sc.layer - 1]) throw new Error(`sample bounce: ${sc.from} has ${s.layers.length} layers, no layer ${sc.layer}`);
          s = { ...s, layers: s.layers.map((l, i) => ({ ...l, mute: i !== sc.layer! - 1 || l.mute, solo: false })) };
        }
        if (sc.loop && !(s.voice === 'layered' && s.loop)) throw new Error(`sample bounce: ${sc.from} has no loop (sound loop ${sc.from} <seconds>); loop=yes bounces a looping sound's loop`);
        const bank = host.samples.bankFor(next);
        chs = host.cache.render(s, bank).channels;
        origin = `sound ${sc.from}${sc.layer !== null ? ` layer ${sc.layer}` : ''}`;
        key = renderKey(s, (n) => bank.hash(n) ?? 'missing').slice(0, 16);
      }
      if (!chs[0]!.length) throw new Error('sample bounce: nothing was rendered');
      const audio = pcmFromFloats(chs, rate, 'f32');
      const hash = pcmHash(audio);
      host.samples.store.put(audio, hash);
      // licences: what the item reaches; the worst of those samples' licences is the bounce's own (own when it reaches none)
      const item = host.samples.itemLicence(next, asSong ? 'song' : 'sound', sc.from);
      let worst: (typeof item.samples)[number] | null = null;
      for (const r of item.samples) if (!worst || STATE_ORDER.indexOf(r.state) > STATE_ORDER.indexOf(worst.state)) worst = r;
      const parents = [...new Set(item.samples.filter((r) => r.via === 'used').map((r) => r.hash))];
      const licence = worst ? { id: worst.licence.id, ...(worst.licence.attribution ? { attribution: worst.licence.attribution } : {}), ...(worst.licence.terms ? { terms: worst.licence.terms } : {}) } : { id: 'own' };
      const text = addText(sc.name, audio, hash, userFields(sc.fields, {
        ...(sc.loop ? { loop: `0-${audio.frames}`, loopmode: 'sustain' } : {}),
        source: 'bounce', origin, params: `render ${key} tape ${host.seq}`,
        ...(parents.length ? { parents: parents.join(',') } : {}),
        licence: licence.id, ...(licence.attribution ? { attribution: licence.attribution } : {}), ...('terms' in licence && licence.terms ? { terms: licence.terms } : {}),
      }));
      return { commands: [text], notes: [`sample ${sc.name}: ${(audio.frames / rate).toFixed(3)} s ${audio.channels === 1 ? 'mono' : 'stereo'}, a render of ${origin}; licence ${licence.id}${parents.length ? ` (from ${parents.length} sample${parents.length > 1 ? 's' : ''} it plays)` : ''}`] };
    }
    case 'sample-slice': {
      const e = entryOf(host, next, sc.name);
      const rate = e.rate;
      let pts: number[];
      let note: string;
      const h = sc.how;
      if (h.kind === 'onsets') {
        const a = audioOf(host, e.hash);
        if (!a) throw new Error(`the audio of sample ${sc.name} is not in the store`);
        const times = findOnsets(mono(pcmChannels(a)), a.rate, { ...(h.sensitivity !== null ? { sensitivity: h.sensitivity } : {}), ...(h.minGap !== null ? { minGap: h.minGap } : {}) });
        pts = times.map((t) => Math.round(t * a.rate));
        if (!pts.length) throw new Error(`sample slice ${sc.name}: no onsets found (try sensitivity=0.8, or at=<times>, or grid=<n>)`);
        note = `${pts.length} onsets found`;
      } else if (h.kind === 'at') {
        pts = h.times.map((t) => framesOf(t, rate));
        note = 'given slice points';
      } else {
        const step = h.tempo !== null ? (60 / h.tempo / h.n) * rate : e.frames / h.n;
        const count = h.tempo !== null ? Math.floor(e.frames / step) : h.n;
        pts = Array.from({ length: count }, (_, k) => Math.round(k * step));
        note = h.tempo !== null ? `${count} slice${count === 1 ? '' : 's'} of ${h.n} to the beat at ${h.tempo} bpm` : `${count} equal slice${count === 1 ? '' : 's'}`;
      }
      // the first slice starts at the start: a point within 10 ms of it is moved there
      pts = [...new Set(pts)].sort((a, b) => a - b).filter((p) => p >= 0 && p < e.frames);
      if (!pts.length || pts[0]! > Math.round(0.01 * rate)) pts.unshift(0);
      else pts[0] = 0;
      pts = [...new Set(pts)];
      if (pts.length > 1024) throw new Error(`sample slice ${sc.name}: ${pts.length} slice points (at most 1024)`);
      return { commands: [`sample set ${sc.name} slices=${pts.join(',')}`], notes: [`sample ${sc.name}: ${pts.length} slice${pts.length === 1 ? '' : 's'} (${note}); a layer plays one with slice=<n> (1-${pts.length}), sample derive takes one with op="slice <n>"`] };
    }
    case 'sample-loop': {
      const e = entryOf(host, next, sc.name);
      const h = sc.how;
      if (h.kind === 'set') {
        const a = framesOf(h.start, e.rate);
        const b = framesOf(h.end, e.rate);
        if (!(a >= 0 && b > a && b <= e.frames)) throw new Error(`sample loop ${sc.name}: the loop ${a}f-${b}f must lie inside the sample (${e.frames} frames) with start before end`);
        return { commands: [`sample set ${sc.name} loop=${a}-${b} loopmode=sustain`], notes: [`sample ${sc.name}: loop ${a}-${b} frames (${((b - a) / e.rate).toFixed(3)} s)`] };
      }
      const au = audioOf(host, e.hash);
      if (!au) throw new Error(`the audio of sample ${sc.name} is not in the store`);
      const x = mono(pcmChannels(au));
      const near = h.near ? ([framesOf(h.near[0], au.rate) / au.rate, framesOf(h.near[1], au.rate) / au.rate] as [number, number]) : undefined;
      const found = findLoops(x, au.rate, { ...(near ? { near } : {}), ...(h.min ? { min: framesOf(h.min, au.rate) / au.rate } : {}), top: 3 });
      if (!found.length) throw new Error(`sample loop ${sc.name}: no loop found${near ? ' in that range' : ''}: the sample may be too short or too busy; set one by hand with sample loop ${sc.name} <start> <end>`);
      const best = found[0]!;
      const line = (l: (typeof found)[number], i: number): string => `  ${i + 1}. ${l.start}-${l.end} (${((l.end - l.start) / au.rate).toFixed(3)} s): click ${l.seam.clickDb.toFixed(1)} dB, level step ${l.seam.levelStepDb.toFixed(1)} dB, spectral jump ${l.seam.spectralJump.toFixed(2)}`;
      return { commands: [`sample set ${sc.name} loop=${best.start}-${best.end} loopmode=sustain`], notes: [`sample ${sc.name}: loop ${best.start}-${best.end} chosen of ${found.length} candidates:\n${found.map(line).join('\n')}`] };
    }
    default:
      throw new Error(`${sc.op}: not a measured command`);
  }
}

/**
 * Replay uses a derived sample's object when the store has it; when it does not (a folder copied without its objects, a store pruned by hand),
 * the object is made again from its parents and the settled chain on the tape. The hash must come out the same: a mismatch is refused.
 */
export function restoreDerived(host: { samples: SampleStore }, lib: Library): { restored: string[]; missing: string[] } {
  const restored: string[] = [];
  let todo = [...lib.samples.values()].filter((e) => e.prov.source === 'derived' && e.prov.ops && e.prov.parents?.length && !host.samples.hasObject(e.hash));
  for (let progress = true; progress && todo.length;) {
    progress = false;
    const rest: SampleEntry[] = [];
    for (const e of todo) {
      const parent = audioOf(host, e.prov.parents![0]!);
      if (!parent) { rest.push(e); continue; }
      let res;
      try {
        res = deriveAudio(parent, e.prov.ops!, { byHash: (h) => audioOf(host, h) });
      } catch (err) {
        if (/is not in the store/.test((err as Error).message)) { rest.push(e); continue; }
        throw new Error(`sample ${e.name} cannot be made again from its history: ${(err as Error).message}`);
      }
      const hash = pcmHash(res.audio);
      if (hash !== e.hash) throw new Error(`sample ${e.name}: made again from its parents and "${e.prov.ops}" it comes out as ${hash.slice(0, 12)}, but the history says ${e.hash.slice(0, 12)}: this build does not reproduce that audio, so the project is not opened (restore samples/objects, or ask for the build that made it)`);
      host.samples.store.put(res.audio, hash);
      restored.push(e.name);
      progress = true;
    }
    todo = rest;
  }
  return { restored, missing: todo.map((e) => e.name) };
}
