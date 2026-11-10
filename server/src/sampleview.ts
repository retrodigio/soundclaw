// Samples in the ears: `describe`, `measure`, `view` and `compare` take `sample:<name>` or `hash:<sha256 or its first 8+ digits>` the way they
// take a sound; `sample list` filters by the numbers query; `sample check` reports the advisory checks of a sample (a sample is material:
// its checks never gate `work done`).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  analyze, checkSample, describeSample, FORMAT_BITS, findOnsets, licenceState, loopView, matchQuery, measureSample, mixdown, parseQuery, pcmChannels, pitchView, resample,
  seamNumbers, specView, waveView, type Image, type PcmAudio, type QueryFacts, type SampleCheck, type SampleEntry, type SampleMeasure,
} from '@soundclaw/core';
import { audioOf } from './sampleedit.ts';
import { ProjectError } from './project.ts';
import type { Writer } from './writer.ts';

export const SAMPLE_REF_RE = /^(sample|hash):/;
export const isSampleRef = (s: string): boolean => SAMPLE_REF_RE.test(s);

export interface SampleSide {
  label: string;
  hash: string;
  entry?: SampleEntry;
  audio: PcmAudio;
}

/** `sample:<name>` or `hash:<digits>` to the audio and its entry (when the tape names it). */
export function sampleSide(w: Writer, ref: string): SampleSide {
  const m = /^(sample|hash):(.*)$/.exec(ref);
  if (!m) throw new ProjectError(`'${ref}' is not sample:<name> or hash:<sha256>`);
  if (m[1] === 'sample') {
    const entry = w.samples.entry(m[2]!);
    if (!entry) {
      const names = w.samples.names();
      throw new ProjectError(`no sample '${m[2]}'${names.length ? ` (samples: ${names.join(', ')})` : ' (this project has none: soundclaw sample import)'}`);
    }
    const audio = audioOf(w, entry.hash);
    if (!audio) throw new ProjectError(`the audio of sample ${entry.name} (${entry.hash.slice(0, 12)}) is not in the store`);
    return { label: `sample:${entry.name}`, hash: entry.hash, entry, audio };
  }
  const digits = m[2]!.toLowerCase();
  if (!/^[0-9a-f]{8,64}$/.test(digits)) throw new ProjectError(`hash:${m[2]}: give 8 to 64 hex digits of a sample's hash (soundclaw sample list shows them)`);
  const all = [...new Set([...w.samples.store.list().map((o) => o.hash), ...w.samples.all().map((x) => x.entry.hash)])].filter((h) => h.startsWith(digits));
  if (!all.length) throw new ProjectError(`no audio with a hash starting ${digits} in this project's store`);
  if (all.length > 1) throw new ProjectError(`hash:${digits} fits ${all.length} objects: give more digits`);
  const hash = all[0]!;
  const audio = audioOf(w, hash);
  if (!audio) throw new ProjectError(`the audio ${hash.slice(0, 12)} is not in the store`);
  const entry = w.samples.all().find((x) => x.entry.hash === hash)?.entry;
  return { label: `hash:${hash.slice(0, 12)}`, hash, ...(entry ? { entry } : {}), audio };
}

// ---- measuring (kept by hash: audio never changes under a hash) -----------------------------------------------------

const measured = new Map<string, SampleMeasure>();

export function measureHash(side: SampleSide): SampleMeasure {
  const have = measured.get(side.hash);
  if (have) return have;
  const m = measureSampleAudio(side.audio);
  measured.set(side.hash, m);
  if (measured.size > 64) measured.delete(measured.keys().next().value!);
  return m;
}

function measureSampleAudio(a: PcmAudio): SampleMeasure {
  return measureSample(pcmChannels(a, 120), a.rate);
}

/** The values a numbers query tests, for one sample. */
export function sampleFacts(w: Writer, e: SampleEntry, m: SampleMeasure): QueryFacts {
  const state = licenceState(e.licence, w.samples.shipPolicy).state;
  return {
    dur: m.duration, lufs: Number.isFinite(m.lufs) ? m.lufs : null, peak: Number.isFinite(m.peakDb) ? m.peakDb : null, rms: Number.isFinite(m.rmsDb) ? m.rmsDb : null,
    centroid: m.centroid, flatness: m.flatness, attack: m.attackMs, decay: m.decay60, noise: m.noiseFloorDb, harmonicity: Number.isFinite(m.hnrDb) ? m.hnrDb : null,
    pitch: m.pitch ? m.pitch.midi : null, pitched: m.pitched, onsets: m.onsets.count, onsetrate: m.onsets.perSecond, tempo: m.tempo,
    loop: !!e.loop, channels: m.channels, samplerate: m.rate, bits: FORMAT_BITS[e.format], width: m.stereoWidth,
    'silence-start': m.silenceStartMs, 'silence-end': m.silenceEndMs, clips: m.fullScaleRuns,
    tag: e.tags, source: e.prov.source, licence: [state, e.licence.id], name: e.name,
  };
}

const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : v > 0 ? 'inf' : '-inf');

/** The numbers of a sample, one line each group. */
export function sampleNumbers(m: SampleMeasure): string {
  if (m.silent) return `${m.duration.toFixed(3)} s of silence`;
  return [
    `length ${m.duration.toFixed(3)} s (${m.frames} frames), ${m.rate} Hz, ${m.channels === 1 ? 'mono' : m.channels + ' channels'}${m.channels > 1 ? `, stereo width ${m.stereoWidth.toFixed(2)}` : ''}`,
    `peak ${f1(m.peakDb)} dBFS (true ${f1(m.truePeakDb)} dBTP), rms ${f1(m.rmsDb)} dBFS, loudness ${f1(m.lufs)} LUFS${m.lra !== null ? `, range ${f1(m.lra)} LU` : ''}, dc ${m.dc.toFixed(4)}, full-scale runs ${m.fullScaleRuns}`,
    `centroid ${Math.round(m.centroid)} Hz, flatness ${m.flatness.toFixed(2)}, harmonic-to-noise ${f1(m.hnrDb)} dB, noise floor ${f1(m.noiseFloorDb)} dBFS`,
    `pitch ${m.pitch ? `${m.pitch.note}${Math.round(m.pitch.cents) ? ` ${Math.round(m.pitch.cents) > 0 ? '+' : ''}${Math.round(m.pitch.cents)} cents` : ''} (${m.pitch.hz.toFixed(1)} Hz, confidence ${m.pitch.confidence.toFixed(2)}, spread ${Math.round(m.pitch.steadiness)} cents)` : 'none'}`,
    `attack ${m.attackMs.toFixed(1)} ms, falls 60 dB in ${m.decay60 === null ? 'more than the sample (sustained)' : m.decay60.toFixed(2) + ' s'}, silence ${Math.round(m.silenceStartMs)} ms at the start and ${Math.round(m.silenceEndMs)} ms at the end`,
    `onsets ${m.onsets.count}${m.onsets.count ? ` at ${m.onsets.times.slice(0, 8).map((t) => t.toFixed(3)).join(', ')}${m.onsets.times.length > 8 ? ', …' : ''} s` : ''}${m.tempo ? `; tempo about ${Math.round(m.tempo)} bpm` : ''}`,
  ].join('\n');
}

function provenanceLines(w: Writer, s: SampleSide): string[] {
  const e = s.entry;
  if (!e) return [`not named on the tape (audio ${s.hash.slice(0, 12)} in the store)`];
  const lic = licenceState(e.licence, w.samples.shipPolicy);
  const lines = [`source ${e.prov.source}${e.prov.origin ? ` (${e.prov.origin})` : ''}; licence ${e.licence.id} (${lic.state})${e.tags.length ? `; tags ${e.tags.join(', ')}` : ''}`];
  if (e.prov.ops) lines.push(`made by: ${e.prov.ops}`);
  if (e.root !== undefined || e.loop || e.slices) lines.push([e.root !== undefined ? `root ${e.root}` : '', e.loop ? `loop ${e.loop[0]}-${e.loop[1]} frames` : '', e.slices ? `${e.slices.length} slice${e.slices.length === 1 ? '' : 's'}` : ''].filter(Boolean).join('; '));
  return lines;
}

/** `describe sample:<name>`: the words, then the numbers, the provenance and the advisory checks. */
export function sampleDescribeText(w: Writer, ref: string): string {
  const s = sampleSide(w, ref);
  const m = measureHash(s);
  const checks = s.entry ? sampleChecks(s, m) : [];
  const bad = checks.filter((c) => !c.ok);
  return [`${s.label}: ${describeSample(m).join(' ')}`, sampleNumbers(m), ...provenanceLines(w, s), bad.length ? `checks (advice): ${bad.map((c) => c.message).join('; ')}` : 'checks (advice): none to report'].join('\n');
}

export function sampleMeasureJson(w: Writer, ref: string): Record<string, unknown> {
  const s = sampleSide(w, ref);
  const m = measureHash(s);
  const e = s.entry;
  return {
    ref: s.label, hash: s.hash, measure: m, words: describeSample(m),
    ...(e ? { name: e.name, format: e.format, bits: FORMAT_BITS[e.format], source: e.prov.source, licence: e.licence.id, licenceState: licenceState(e.licence, w.samples.shipPolicy).state, tags: e.tags, ...(e.root !== undefined ? { root: e.root } : {}), ...(e.loop ? { loop: e.loop } : {}), ...(e.slices ? { slices: e.slices } : {}), checks: sampleChecks(s, m) } : {}),
  };
}

export function sampleChecks(s: SampleSide, m: SampleMeasure): SampleCheck[] {
  const e = s.entry;
  return checkSample(m, { frames: s.audio.frames, rate: s.audio.rate, ...(e?.loop ? { loop: e.loop } : {}), ...(e?.slices ? { slices: e.slices } : {}) }, pcmChannels(s.audio, 120));
}

/** `sample check [names]`: advisory checks, every sample when none are named. */
export function sampleCheckText(w: Writer, names: string[]): string {
  const all = names.length ? names : w.samples.names();
  if (!all.length) throw new ProjectError('this project has no samples (soundclaw sample import)');
  const lines: string[] = [];
  let flagged = 0;
  for (const n of all) {
    const s = sampleSide(w, `sample:${n}`);
    const checks = sampleChecks(s, measureHash(s));
    const bad = checks.filter((c) => !c.ok);
    if (bad.length) flagged++;
    lines.push(`sample ${n}: ${bad.length ? `${bad.length} to look at` : 'clean'}`);
    for (const c of checks) lines.push(`  ${c.ok ? '✓' : c.severity === 'warn' ? '!' : 'i'} ${c.name}: ${c.message}`);
  }
  lines.push(`${all.length} sample${all.length === 1 ? '' : 's'} checked, ${flagged} with something to look at (advice only: a sample is material; the sounds and songs made from it have the checks that gate work done)`);
  return lines.join('\n');
}

/** `sample list "<query>"`: every sample, or those the numbers query keeps, closest first. */
export function sampleQueryText(w: Writer, query: string | undefined, o: { json?: boolean } = {}): string {
  let q: ReturnType<typeof parseQuery> | null = null;
  try { q = query ? parseQuery(query) : null; } catch (e) { throw new ProjectError(`sample list: ${(e as Error).message}`); }
  const out: { name: string; line: string; close: number; json: Record<string, unknown> }[] = [];
  for (const x of w.samples.all()) {
    const e = x.entry;
    const info = w.samples.infoOf(x);
    let close = 0;
    if (q && (q.terms.length || q.words.length)) {
      const needsNumbers = q.terms.some((t) => !['tag', 'source', 'licence', 'name', 'loop', 'channels', 'samplerate', 'bits'].includes(t.key));
      let facts: QueryFacts;
      if (needsNumbers) { const full = sampleSide(w, `sample:${e.name}`); facts = sampleFacts(w, e, measureHash(full)); }
      else facts = { loop: !!e.loop, channels: e.channels, samplerate: e.rate, bits: FORMAT_BITS[e.format], tag: e.tags, source: e.prov.source, licence: [info.licenceState, e.licence.id], name: e.name, dur: e.frames / e.rate };
      const r = matchQuery(q, facts, e.name, e.tags);
      if (!r.match) continue;
      close = r.closeness;
    }
    out.push({
      name: e.name, close,
      line: `${e.name}  ${info.seconds.toFixed(3)} s  ${info.rate} Hz  ${info.channels === 1 ? 'mono' : info.channels + ' ch'}  ${info.format}${e.root !== undefined ? '  root ' + (info.root ?? '') : ''}  ${info.source}  ${licenceGlyph(info.licenceState)} ${info.licenceState} (${info.licence})${e.tags.length ? '  [' + e.tags.join(', ') + ']' : ''}${info.legacy ? '  (0.1.x file: soundclaw upgrade)' : ''}`,
      json: { ...info },
    });
  }
  out.sort((a, b) => a.close - b.close || (a.name < b.name ? -1 : 1));
  if (o.json) return JSON.stringify(out.map((x) => x.json), null, 1);
  if (!out.length) return q ? 'no sample fits that query' : 'this project has no samples (soundclaw sample import)';
  return `${out.map((x) => x.line).join('\n')}\n${out.length} sample${out.length === 1 ? '' : 's'}${q ? ' fit the query, closest first' : ''}`;
}

export const licenceGlyph = (s: string): string => (s === 'shippable' ? '✓' : s === 'attribution' ? '©' : s === 'blocked' ? '✕' : '?');

// ---- views ----------------------------------------------------------------------------------------------------------

/** A sample as the mono signal the views draw: both channels averaged, at the engine's rate. */
export function monoAt44(a: PcmAudio, seconds = 120): Float32Array {
  const chs = pcmChannels(a, seconds);
  const mono = chs.length === 1 ? chs[0]! : mixdown(chs);
  return a.rate === 44100 ? mono : resample(mono, a.rate, 44100);
}

export const SAMPLE_VIEWS = ['wave', 'spec', 'pitch', 'loop', 'slices'] as const;
export type SampleViewKind = (typeof SAMPLE_VIEWS)[number];

export function sampleView(w: Writer, ref: string, kind: string, out?: string): { png: Uint8Array; file: string; text: string } {
  if (!(SAMPLE_VIEWS as readonly string[]).includes(kind)) throw new ProjectError(`no view '${kind}' for a sample (${SAMPLE_VIEWS.join(', ')}; compare takes two things)`);
  const s = sampleSide(w, ref);
  const m = measureHash(s);
  const x = monoAt44(s.audio);
  const a = analyze(x);
  let img: Image;
  let extra = '';
  if (kind === 'wave') img = waveView(x, a, s.label);
  else if (kind === 'spec') img = specView(x, a, s.label);
  else if (kind === 'pitch') img = pitchView(a, s.label);
  else if (kind === 'slices') {
    const pts = s.entry?.slices?.length ? s.entry.slices : null;
    const marks = pts ? pts.map((p, i) => ({ t: p / s.audio.rate, label: String(i + 1) })) : findOnsets(mixdown(pcmChannels(s.audio, 120)), s.audio.rate).map((t, i) => ({ t, label: String(i + 1) }));
    img = waveView(x, a, `${s.label} ${pts ? 'SLICES' : 'ONSETS (NO SLICE POINTS SET)'}`, marks);
    extra = `\n${pts ? `${pts.length} slice${pts.length === 1 ? '' : 's'} at frames ${pts.join(', ')}` : `${marks.length} onset${marks.length === 1 ? '' : 's'} found; set them with sample slice ${s.entry?.name ?? '<name>'} at=onsets`}`;
  } else {
    const e = s.entry;
    const lp = e?.loop ?? null;
    const scale = 44100 / s.audio.rate;
    const part = lp ? x.slice(Math.round(lp[0] * scale), Math.round(lp[1] * scale)) : x;
    if (part.length < 8) throw new ProjectError('the loop is too short to draw');
    const seam = seamNumbers(part);
    img = loopView(part, analyze(part), seam, `${s.label}${lp ? ` LOOP ${lp[0]}-${lp[1]}` : ' (WHOLE SAMPLE, NO LOOP POINTS SET)'}`);
    extra = `\nloop ${lp ? `${lp[0]}-${lp[1]} frames` : 'none set: the whole sample is treated as the loop (sample loop <name> find)'}; seam jump ${seam.jump.toFixed(3)} against a local step of ${seam.local.toFixed(3)}, level step ${seam.stepDb.toFixed(1)} dB between the last and the first 50 ms`;
  }
  const safe = s.label.replace(/[^A-Za-z0-9_.-]/g, '_');
  const file = out ? resolve(out) : join(w.project.dir, '.cache', 'views', `${safe}-${kind}-${s.hash.slice(0, 8)}.png`);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, img.png);
  return { png: img.png, file, text: `${kind} view saved to ${file}\n${s.label}: ${describeSample(m).join(' ')}${extra}` };
}
