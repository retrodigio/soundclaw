// Families by context: the same sound as it is heard near, far away or through a wall. The rules are
// DATA (FAMILIES below), printed in docs/commands.md. A family variant is a COPY of the source as a
// layered sound (a classic source becomes a one-layer layered sound, sample for sample) with its
// master chain extended by the rules; it does not refer to the source afterwards. Why a copy: a
// sound document renders from itself alone, so the render key, the browser's render, the exports
// and the history's undo need no look-up in another document, and the variant can be edited (or the
// source changed) without either moving under the other. What it remembers is `family <kind> of
// <source> offset <dB>`: the loudness it is held to is the style's target plus that offset (a far
// sound is meant to be quieter, so the loudness check must not call it too quiet).

import { classicLayer, newFx, MAX_FX, type FamilyKind, type Fx, type LayeredSound } from './layered.ts';
import { cloneSound, type Sound } from './sound.ts';

export interface FamilyRule {
  help: string;
  /** How much quieter (negative) or louder than the source it is meant to be, LU. The family command matches its loudness to the source's plus this. */
  gainDb: number;
  /** Low-pass stages appended to the master chain: each a 12 dB/octave state-variable filter at this cutoff (Hz). */
  lowpass: { cutoff: number; stages: number } | null;
  /** A high-pass (Hz) appended before the low-pass: removes the rumble a wall or distance does not carry. */
  highpass: number | null;
  /** Reverb appended at the end of the master chain (room size, damping, dry/wet). */
  reverb: { size: number; damp: number; mix: number } | null;
  /** Reverbs the source already has: their mix is multiplied by this (near is drier), then raised to at least `reverb.mix` when the rule adds one. */
  reverbScale: number;
}

export const FAMILIES: Record<FamilyKind, FamilyRule> = {
  near: { help: 'close and present: a little louder, drier', gainDb: 2, lowpass: null, highpass: null, reverb: null, reverbScale: 0.5 },
  far: { help: 'a long way off: quieter, darker, more reverb', gainDb: -9, lowpass: { cutoff: 3500, stages: 1 }, highpass: null, reverb: { size: 0.65, damp: 0.6, mix: 0.35 }, reverbScale: 1 },
  muffled: { help: 'behind a wall: the highs gone (two low-pass stages), the rumble too, a little room', gainDb: -6, lowpass: { cutoff: 500, stages: 2 }, highpass: 60, reverb: { size: 0.25, damp: 0.8, mix: 0.15 }, reverbScale: 1 },
};

export const FAMILY_KINDS = Object.keys(FAMILIES) as FamilyKind[];
export const isFamily = (s: string): s is FamilyKind => Object.prototype.hasOwnProperty.call(FAMILIES, s);

const fxLp = (cutoff: number): Fx => { const f = newFx('filter'); f.p.type = 'lp'; f.p.cutoff = cutoff; return f; };
const fxHp = (cutoff: number): Fx => { const f = newFx('filter'); f.p.type = 'hp'; f.p.cutoff = cutoff; return f; };

/**
 * The family variant of `source` as a new layered sound `id`: a copy with the rules applied. The
 * sound's own `gain` is left as it is; the caller matches its loudness (source + gainDb).
 */
export function makeFamily(source: Sound, kind: FamilyKind, id: string, seed: number): LayeredSound {
  const rule = FAMILIES[kind];
  if (source.voice === 'tone') throw new Error(`${source.id} is a tone: a family is made from a classic or layered sound`);
  const up: LayeredSound = source.voice === 'layered'
    ? cloneSound(source)
    : { id, voice: 'layered', duration: null, gain: 1, seed, nextSalt: 2, layers: [classicLayer(source.patch, 1)], master: [], status: 'draft' };
  const out: LayeredSound = { ...up, id, status: 'draft' };
  delete out.family;
  const reverbMix = rule.reverb?.mix ?? 0;
  const master = out.master.map((f) => {
    if (f.kind !== 'reverb') return f;
    const g = { ...f, p: { ...f.p }, envs: { ...f.envs } };
    g.p.mix = Math.min(1, Math.max(Number(f.p.mix) * rule.reverbScale, rule.reverb ? reverbMix : 0));
    delete g.envs.mix;
    return g;
  });
  if (rule.highpass !== null) master.push(fxHp(rule.highpass));
  if (rule.lowpass) for (let i = 0; i < rule.lowpass.stages; i++) master.push(fxLp(rule.lowpass.cutoff));
  if (rule.reverb && !out.master.some((f) => f.kind === 'reverb')) {
    const r = newFx('reverb');
    r.p.size = rule.reverb.size;
    r.p.damp = rule.reverb.damp;
    r.p.mix = rule.reverb.mix;
    master.push(r);
  }
  if (master.length > MAX_FX) throw new Error(`${source.id}'s master chain would have ${master.length} effects (the most a chain has is ${MAX_FX}); remove some first`);
  out.master = master;
  out.family = { of: source.id, kind, offsetDb: (source.voice === 'layered' ? source.family?.offsetDb ?? 0 : 0) + rule.gainDb };
  return out;
}

/** A markdown table of the family rules (for the command reference; a test keeps docs/commands.md in step). */
export function familiesTable(): string {
  const lines = ['| Family | Loudness vs the source | Added to the master chain | Reverbs the source has |', '|---|---|---|---|'];
  for (const k of FAMILY_KINDS) {
    const r = FAMILIES[k];
    const chain = [r.highpass !== null ? `high-pass ${r.highpass} Hz` : '', r.lowpass ? `low-pass ${r.lowpass.cutoff} Hz × ${r.lowpass.stages}` : '', r.reverb ? `reverb size ${r.reverb.size} damp ${r.reverb.damp} mix ${r.reverb.mix}` : ''].filter(Boolean).join(', ') || 'nothing';
    lines.push(`| \`${k}\` ${r.help} | ${r.gainDb > 0 ? '+' : ''}${r.gainDb} LU | ${chain} | mix × ${r.reverbScale}${r.reverb ? `, at least ${r.reverb.mix}` : ''} |`);
  }
  return lines.join('\n');
}
