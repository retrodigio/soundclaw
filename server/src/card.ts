// What a sound's card shows, worked out on the server (in a worker thread, once for each distinct
// render and rule, kept in <project>/.cache/thumbs): the numbers, the checks, the waveform's peaks
// and the spectrogram as small bytes. The page draws them; it never renders a sound for its card.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import { SPEC_RANGE_DB, analyze, checkSummary, checksPass, fullScaleOf, joinChannels, levels, measuredChannels, melSpectrogram, mixdown, peaks, runChecks, samplesHash, specMax, TIMED_CHECKS, type Sound, type Style } from '@soundclaw/core';
import type { CardInfo, CardLite } from './protocol.ts';

/** The spectrogram thumbnail's size (the page draws it as it is). */
export const CARD_W = 240;
export const CARD_H = 48;

const num = (v: number): number | null => (Number.isFinite(v) ? v : null);
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** The card for a sound rendered as `channels`, held to `style` (a set's target and a family's offset included). */
export function buildCard(s: Sound, channels: Float32Array[], o: { key: string; style: Style; basis: string }): CardInfo {
  const loop = s.voice === 'layered' && !!s.loop;
  const mc = measuredChannels(s, channels); // a classic sound is measured as its exported WAV holds it
  const analysis = analyze(mc);
  const checks = runChecks(mc, analysis, o.style, { loop, loudnessClass: o.basis, fullScale: fullScaleOf(s) });
  const x = mixdown(channels);
  const hop = Math.max(256, Math.ceil(x.length / CARD_W));
  const spec = melSpectrogram(x, { bands: CARD_H, hop });
  const top = specMax(spec);
  const bands = spec.freqs.length;
  const bytes = new Uint8Array(CARD_W * CARD_H);
  for (let col = 0; col < CARD_W; col++) {
    const frame = spec.db[Math.min(spec.db.length - 1, Math.floor((col / CARD_W) * spec.db.length))]!;
    for (let y = 0; y < CARD_H; y++) {
      const band = Math.round(((CARD_H - 1 - y) / (CARD_H - 1)) * (bands - 1));
      const t = (frame[band]! - (top - SPEC_RANGE_DB)) / SPEC_RANGE_DB;
      bytes[y * CARD_W + col] = Math.round(255 * (t < 0 ? 0 : t > 1 ? 1 : t));
    }
  }
  const p = peaks(x, CARD_W);
  const failing = checks.filter((k) => !k.pass).map((k) => k.name);
  return {
    key: o.key,
    hash: samplesHash(joinChannels(channels)),
    duration: analysis.duration,
    lufs: num(analysis.lufs),
    truePeakDb: num(analysis.truePeakDb),
    pass: checksPass(checks),
    failing,
    summary: checkSummary(checks),
    issues: checks.filter((k) => !k.pass).map((k) => ({ name: k.name, value: k.value, ...(TIMED_CHECKS.includes(k.name) && k.ranges.length ? { at: round3(k.ranges[0]!.from) } : {}) })),
    peak: levels(x).peak,
    wave: { min: Array.from(p.min, round3), max: Array.from(p.max, round3) },
    spec: { w: CARD_W, h: CARD_H, frames: spec.db.length, bands, data: Buffer.from(bytes).toString('base64') },
  };
}

export const liteOf = (c: CardInfo): CardLite => ({ hash: c.hash, duration: c.duration, lufs: c.lufs, truePeakDb: c.truePeakDb, pass: c.pass, failing: c.failing, summary: c.summary, ...(c.issues ? { issues: c.issues } : {}) });

/** The thumbnail cache on disk: a full card and a small one (what the list needs) for each key. */
export class CardFiles {
  private readonly dir: string | null;
  constructor(projectDir: string | null) {
    this.dir = projectDir ? join(projectDir, '.cache', 'thumbs') : null;
  }
  private path(key: string, lite: boolean): string | null {
    return this.dir ? join(this.dir, `${key}${lite ? '.lite' : ''}.json`) : null;
  }
  read(key: string): CardInfo | null {
    const f = this.path(key, false);
    try {
      return f && existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as CardInfo) : null;
    } catch {
      return null;
    }
  }
  readLite(key: string): CardLite | null {
    const f = this.path(key, true);
    try {
      return f && existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as CardLite) : null;
    } catch {
      return null;
    }
  }
  /** Written whole, then renamed into place, so another thread never reads half a file. */
  write(c: CardInfo): void {
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true });
    for (const [lite, body] of [[false, c], [true, liteOf(c)]] as const) {
      const f = this.path(c.key, lite)!;
      writeFileSync(`${f}.${process.pid}.${threadId}.tmp`, JSON.stringify(body));
      renameSync(`${f}.${process.pid}.${threadId}.tmp`, f);
    }
  }
}
