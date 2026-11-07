// Sets: a named group of sounds that belong together (the footsteps on grass, the clicks of a menu),
// with a loudness target and a variation rule. A set document is plain data: its members are sounds
// like any other (each a real sound, in sounds/), so a set never hides a sound inside itself.
//
//   set new <set> from=<sound> count=<n> [target=<LUFS>] [spread="<param>±<amount> ..."] [seed=<n>]
//   set add|remove <set> <sound>...
//   set retarget <set> <LUFS>|none
//   set regen <set> [seed=<n>] [spread="..."]
//
// The variants are seeded and deterministic (nothing here uses the clock or Math.random). Loudness
// matching MEASURES a render, and a measurement may differ in its last digit between platforms, so
// it is never done while a tape replays: the writer measures when a command is run and writes the
// result as ordinary `sound set <member> gain=…` commands after it (see matchCommands).

import { CLASSIC_FIELDS, type ClassicKey } from './classic.ts';
import { integratedLoudness, melSpectrogram, type MelSpec } from './analysis.ts';
import { DEFAULT_STYLE, type CheckResult, type Style } from './checks.ts';
import { Rng, hashText } from './generators.ts';
import { FX_SPECS, layerSpecs, parseTarget, specOf, type Env, type LayeredSound, type PSpec } from './layered.ts';
import { melDistance } from './views.ts';
import { mixdown, renderChannels } from './render.ts';
import { SOUND_ID_RE, cloneSound, type Sound } from './sound.ts';
import type { SampleBank } from './synth.ts';

export const MAX_SET_MEMBERS = 32;

/** One variation rule: a parameter and how far a member may move from the source's value, `amount` in the parameter's own unit or (relative) in percent. */
export interface SpreadRule {
  /** A classic parameter (`freq`), or for a layered sound `N.param`, `*.param` (every layer that has it), `N.amp`, `N.fxK.param`, `master.fxK.param`, or `gain`. */
  target: string;
  amount: number;
  relative: boolean;
}

export interface SetDoc {
  id: string;
  /** The sound the variants were made from (regen makes them again from its current state). */
  from: string | null;
  seed: number;
  /** LUFS the members are matched to (null: not matched). */
  target: number | null;
  spread: SpreadRule[];
  /** Every member, in order. */
  members: string[];
  /** The members `set new` and `set regen` made (regen replaces these; others are the person's). */
  generated: string[];
}

/** The sounds of a project, and its sets. Commands replace a sound's (or a set's) object rather than mutating it. */
export class Library extends Map<string, Sound> {
  sets = new Map<string, SetDoc>();
}

export function copyLibrary(lib: Library): Library {
  const out = new Library(lib);
  out.sets = new Map(lib.sets);
  return out;
}

export function cloneLibrary(lib: Library): Library {
  const out = new Library([...lib].map(([k, v]) => [k, cloneSound(v)] as const));
  out.sets = new Map([...lib.sets].map(([k, v]) => [k, cloneSet(v)] as const));
  return out;
}

export function cloneSet(s: SetDoc): SetDoc {
  return { ...s, spread: s.spread.map((r) => ({ ...r })), members: [...s.members], generated: [...s.generated] };
}

// ---- the spread text --------------------------------------------------------------------------------

const num = (s: string): number | null => (/^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) ? Number(s) : null);
const fmt = (n: number): string => String(n);

/** `freq±0.04 decay±0.1`, `1.freq±10% 2.cutoff±15%`; `+-` and `+/-` are accepted for the sign. Throws a plain Error. */
export function parseSpread(text: string): SpreadRule[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error('spread is empty: give rules like "freq±0.04 decay±0.1" (a parameter, ±, an amount; % for relative)');
  const seen = new Set<string>();
  return words.map((w) => {
    const m = /^([A-Za-z0-9.*]+?)(?:±|\+\/-|\+-)(.+?)(%?)$/.exec(w);
    if (!m) throw new Error(`spread: '${w}' is not <parameter>±<amount> (like freq±0.04, or 1.cutoff±15%)`);
    const amount = num(m[2]!);
    if (amount === null || amount <= 0) throw new Error(`spread: '${w}': the amount after ± must be a number above 0`);
    if (m[3] && amount > 100) throw new Error(`spread: '${w}': a relative amount is at most 100%`);
    if (seen.has(m[1]!)) throw new Error(`spread: ${m[1]} is given twice`);
    seen.add(m[1]!);
    return { target: m[1]!, amount, relative: m[3] === '%' };
  });
}

export const formatSpread = (rules: readonly SpreadRule[]): string => rules.map((r) => `${r.target}±${fmt(r.amount)}${r.relative ? '%' : ''}`).join(' ');

// ---- making a member --------------------------------------------------------------------------------

const clampTo = (spec: { min: number; max: number; integer?: boolean }, v: number): number => {
  const c = Math.min(spec.max, Math.max(spec.min, v));
  return spec.integer ? Math.round(c) : c;
};

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

const move = (v: number, u: number, r: SpreadRule): number => (r.relative ? v * (1 + (u * r.amount) / 100) : v + u * r.amount);

function moveEnv(e: Env, u: number, r: SpreadRule, spec: PSpec | { min: number; max: number }): Env {
  return e.map((p) => ({ ...p, v: round6(clampTo(spec, move(p.v, u, r))) }));
}

/** The numeric, variable parameters a sound has, as `target` names (for errors). */
function targetsHint(s: Sound): string {
  if (s.voice === 'classic') return CLASSIC_FIELDS.filter((f) => f.name !== 'wave').map((f) => f.name).join(', ');
  if (s.voice === 'layered') return 'gain, N.<layer param> (like 1.freq), *.<param>, N.amp, N.fxK.<param>, master.fxK.<param>';
  return '(a tone has no parameters to vary)';
}

/** Move one parameter of a sound (in place; `s` is a copy) by u in -1..1 under a rule. Throws a plain Error when the target does not exist. */
function applyRule(s: Sound, r: SpreadRule, u: number): void {
  if (s.voice === 'tone') throw new Error(`${s.id} is a tone: a set is made from a classic or layered sound`);
  if (s.voice === 'classic') {
    const f = CLASSIC_FIELDS.find((x) => x.name === r.target);
    if (!f) throw new Error(`spread: ${s.id} is a classic sound with no parameter '${r.target}' (parameters: ${targetsHint(s)})`);
    if (f.name === 'wave') throw new Error('spread: wave is a choice, not a number: it cannot vary');
    s.patch[f.name as ClassicKey] = round6(clampTo(f, move(s.patch[f.name as ClassicKey], u, r)));
    return;
  }
  const l = s;
  if (r.target === 'gain') { l.gain = round6(clampTo({ min: 0, max: 4 }, move(l.gain, u, r))); return; }
  const layer = (n: number) => {
    const x = l.layers[n - 1];
    if (!x) throw new Error(`spread: ${s.id} has no layer ${n}${l.layers.length ? ` (layers 1 to ${l.layers.length})` : ''}`);
    return x;
  };
  const star = /^\*\.([A-Za-z0-9]+)$/.exec(r.target);
  if (star) {
    let hit = 0;
    for (const x of l.layers) {
      const spec = specOf(layerSpecs(x.kind), star[1]!);
      if (spec && !spec.choices && !spec.text) { varyLayer(x, spec, r, u); hit++; }
    }
    if (!hit) throw new Error(`spread: no layer of ${s.id} has a numeric parameter '${star[1]}'`);
    return;
  }
  let t;
  try { t = parseTarget(r.target); } catch { throw new Error(`spread: '${r.target}' is not a parameter of ${s.id} (${targetsHint(s)})`); }
  if (t.kind === 'amp') {
    const x = layer(t.layer);
    if (!x.amp) throw new Error(`spread: layer ${t.layer} of ${s.id} has no amplitude envelope to vary`);
    x.amp = moveEnv(x.amp, u, r, { min: 0, max: 4 });
  } else if (t.kind === 'layer') {
    const x = layer(t.layer);
    const spec = specOf(layerSpecs(x.kind), t.param);
    if (!spec) throw new Error(`spread: a ${x.kind} layer has no parameter '${t.param}'`);
    if (spec.choices || spec.text) throw new Error(`spread: ${t.param} is a choice or a text, not a number: it cannot vary`);
    varyLayer(x, spec, r, u);
  } else {
    const chain = t.layer === null ? l.master : layer(t.layer).fx;
    const f = chain[t.fx - 1];
    if (!f) throw new Error(`spread: ${t.layer === null ? 'the master chain' : `layer ${t.layer}`} of ${s.id} has no effect ${t.fx}`);
    const spec = specOf(FX_SPECS[f.kind], t.param);
    if (!spec || spec.choices || spec.text) throw new Error(`spread: a ${f.kind} effect has no numeric parameter '${t.param}'`);
    if (f.envs[t.param]) f.envs[t.param] = moveEnv(f.envs[t.param]!, u, r, spec);
    else f.p[t.param] = round6(clampTo(spec, move(Number(f.p[t.param]), u, r)));
  }
}

/** A layer parameter: when an envelope drives it, every breakpoint of the envelope moves (shifted, or scaled for a relative rule); else the fixed value does. */
function varyLayer(x: LayeredSound['layers'][number], spec: PSpec, r: SpreadRule, u: number): void {
  if (x.envs[spec.name]) x.envs[spec.name] = moveEnv(x.envs[spec.name]!, u, r, spec);
  else x.p[spec.name] = round6(clampTo(spec, move(Number(x.p[spec.name]), u, r)));
}

/** Check that every rule's target exists in the source (throws the first problem). */
export function checkSpread(source: Sound, rules: readonly SpreadRule[]): void {
  const probe = cloneSound(source);
  for (const r of rules) applyRule(probe, r, 0);
}

/** The positions in -1..1 the members take for each rule: stratified, so N members cover the range instead of bunching (each member's slot is jittered inside its own stripe). */
export function spreadPositions(seed: number, rules: readonly SpreadRule[], count: number): number[][] {
  return rules.map((_, i) => {
    const rng = new Rng(hashText(`${seed}:spread:${i}`));
    const order = Array.from({ length: count }, (_, k) => k);
    for (let k = count - 1; k > 0; k--) {
      const j = Math.floor(rng.next() * (k + 1));
      [order[k], order[j]] = [order[j]!, order[k]!];
    }
    return order.map((slot) => (2 * (slot + 0.15 + 0.7 * rng.next())) / count - 1);
  });
}

/** The seed the k-th member's noise uses. */
export const memberSeed = (setSeed: number, k: number): number => hashText(`${setSeed}:member:${k}`);

/** Member k (0-based) of `count`, made from `source` under the rules, named `id`. */
export function makeMember(source: Sound, id: string, rules: readonly SpreadRule[], seed: number, k: number, count: number, positions = spreadPositions(seed, rules, count)): Sound {
  const s = cloneSound(source);
  s.id = id;
  s.status = 'draft';
  rules.forEach((r, i) => applyRule(s, r, positions[i]![k]!));
  const noise = memberSeed(seed, k);
  if (s.voice === 'classic') s.patch.seed = noise;
  else if (s.voice === 'layered') { s.seed = noise; delete s.family; }
  return s;
}

export function memberId(set: string, k: number): string {
  return `${set}_${k + 1}`;
}

export function checkMemberIds(set: string, count: number): void {
  const last = memberId(set, count - 1);
  if (!SOUND_ID_RE.test(last)) throw new Error(`the members would be named ${memberId(set, 0)} … ${last}, which is not a sound id (at most 48 characters)`);
}

export const defaultSetSeed = (id: string, from: string): number => hashText(`set:${id}:${from}`);

// ---- loudness ---------------------------------------------------------------------------------------

/** Integrated loudness of a sound's render (LUFS; -Infinity when silent). */
export function loudnessOf(s: Sound, bank?: SampleBank): number {
  return integratedLoudness(renderChannels(s, bank));
}

export interface Matched {
  /** The command that sets the sound's gain (null: nothing to change). */
  command: string | null;
  lufs: number;
  reached: boolean;
  note: string | null;
}

/**
 * Match a sound's loudness to `target` LUFS by its gain, and say how. A layered sound's gain
 * (`sound set <id> gain=`, 0 to 4) is a plain multiplier before the master chain. A CLASSIC
 * sound has no separate gain: its gain is its `volume` parameter (0 to 1, linear in amplitude),
 * so it can only be made quieter or as loud as volume 1 allows; when the target needs more, the
 * volume is left at 1 and the note says by how much it falls short (`sound layer-up` makes the
 * sound layered and sample-identical, and then gain goes to 4). A measurement is repeated (the
 * master chain may not be linear) until it is within 0.05 LU or six tries have passed.
 */
export function matchGain(s: Sound, target: number, bank?: SampleBank): Matched {
  if (s.voice === 'tone') return { command: null, lufs: loudnessOf(s, bank), reached: false, note: `${s.id} is a tone: it cannot be matched` };
  const classic = s.voice === 'classic';
  const lo = 0, hi = classic ? 1 : 4;
  const key = classic ? 'volume' : 'gain';
  let cur = cloneSound(s);
  const get = (): number => (cur.voice === 'classic' ? cur.patch.volume : (cur as LayeredSound).gain);
  const set = (v: number): void => { if (cur.voice === 'classic') cur.patch.volume = v; else (cur as LayeredSound).gain = v; };
  let lufs = loudnessOf(cur, bank);
  if (!Number.isFinite(lufs)) return { command: null, lufs, reached: false, note: `${s.id} is silent: it cannot be matched` };
  const start = get();
  for (let i = 0; i < 6 && Math.abs(lufs - target) > 0.05; i++) {
    const g = get();
    if (g <= 0) break;
    let next = Number((g * Math.pow(10, (target - lufs) / 20)).toPrecision(5));
    next = Math.min(hi, Math.max(lo + 1e-5, next));
    if (next === g) break;
    set(next);
    lufs = loudnessOf(cur, bank);
  }
  const reached = Math.abs(lufs - target) <= 0.1;
  const end = get();
  let note: string | null = null;
  if (!reached) {
    note = lufs < target
      ? `${s.id}: ${classic ? `volume would need to be above 1 (the most it can be); left at ${end}` : `gain would need to be above 4; left at ${end}`}, ${(target - lufs).toFixed(1)} LU under the target ${target}${classic ? ' (sound layer-up lets gain go to 4)' : ''}`
      : `${s.id}: matching left it ${(lufs - target).toFixed(1)} LU over the target ${target}`;
  }
  return { command: end === start ? null : `sound set ${s.id} ${key}=${end}`, lufs, reached, note };
}

// ---- checks of a set --------------------------------------------------------------------------------

/** The style a sound's checks are held to: a set with a target sets the loudness target of its members; a family variant is held to the target plus its offset. */
export function soundStyle(s: Sound, sets: Iterable<SetDoc>, style: Style = DEFAULT_STYLE): Style {
  let target = style.loudnessTarget;
  for (const set of sets) if (set.target !== null && set.members.includes(s.id)) { target = set.target; break; }
  if (s.voice === 'layered' && s.family) target += s.family.offsetDb;
  return target === style.loudnessTarget ? style : { ...style, loudnessTarget: target };
}

export interface SetMember {
  id: string;
  channels: readonly Float32Array[];
  lufs: number;
}

export interface SetMeasure {
  ids: string[];
  /** Pairwise distances, dB (0 on the diagonal). */
  matrix: number[][];
  lufs: number[];
  result: CheckResult;
}

/** Mel spectrograms and loudness of the members → the distance matrix and the set-spread check. */
export function measureSet(members: readonly SetMember[], target: number | null, style: Style = DEFAULT_STYLE): SetMeasure {
  const ids = members.map((m) => m.id);
  const specs: MelSpec[] = members.map((m) => melSpectrogram(mixdown([...m.channels]), { hop: 128 }));
  const n = members.length;
  const matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) matrix[i]![j] = matrix[j]![i] = melDistance(specs[i]!, specs[j]!).spectralDb;
  const lufs = members.map((m) => m.lufs);
  const notes: { from: number; to: number; note: string }[] = [];
  let closest: [number, number] | null = null, farthest: [number, number] | null = null;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (!closest || matrix[i]![j]! < matrix[closest[0]]![closest[1]]!) closest = [i, j];
    if (!farthest || matrix[i]![j]! > matrix[farthest[0]]![farthest[1]]!) farthest = [i, j];
  }
  const dur = Math.max(0, ...members.map((m) => m.channels[0]!.length / 44100));
  let tooAlike = 0, tooFar = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d = matrix[i]![j]!;
    if (d < style.setSpreadMin) { tooAlike++; notes.push({ from: 0, to: dur, note: `${ids[i]} and ${ids[j]} are only ${d.toFixed(1)} dB apart (too alike: at least ${style.setSpreadMin} dB)` }); }
    if (d > style.setSpreadMax) { tooFar++; notes.push({ from: 0, to: dur, note: `${ids[i]} and ${ids[j]} are ${d.toFixed(1)} dB apart (too different: at most ${style.setSpreadMax} dB)` }); }
  }
  const finite = lufs.filter(Number.isFinite).sort((a, b) => a - b);
  const centre = target ?? (finite.length ? finite[Math.floor(finite.length / 2)]! : 0);
  let loud = 0;
  lufs.forEach((l, i) => {
    if (!Number.isFinite(l) || Math.abs(l - centre) > style.loudnessTolerance) { loud++; notes.push({ from: 0, to: dur, note: `${ids[i]} is ${Number.isFinite(l) ? `${l.toFixed(1)} LUFS, ${Math.abs(l - centre).toFixed(1)} LU from the ${target !== null ? 'target' : 'middle member'} ${centre.toFixed(1)}` : 'silent'} (within ±${style.loudnessTolerance} LU)` }); }
  });
  const spreadLu = finite.length ? finite[finite.length - 1]! - finite[0]! : 0;
  const pass = n >= 2 && !tooAlike && !tooFar && !loud;
  const f1 = (v: number): string => v.toFixed(1);
  const bad = tooAlike + tooFar + loud;
  const value = n < 2
    ? `${n} member${n === 1 ? '' : 's'}: a set needs at least 2 to be compared`
    : `closest ${ids[closest![0]]}/${ids[closest![1]]} ${f1(matrix[closest![0]]![closest![1]]!)} dB, farthest ${ids[farthest![0]]}/${ids[farthest![1]]} ${f1(matrix[farthest![0]]![farthest![1]]!)} dB; loudness ${finite.length ? `${f1(finite[0]!)} to ${f1(finite[finite.length - 1]!)} LUFS (spread ${f1(spreadLu)} LU)` : 'silent'}`;
  return {
    ids, matrix, lufs,
    result: {
      name: 'set-spread', pass, score: n < 2 ? 0 : Math.max(0, 1 - bad / Math.max(1, n * (n - 1) / 2 + n)), value,
      threshold: `members ${style.setSpreadMin} to ${style.setSpreadMax} dB apart; loudness within ±${style.loudnessTolerance} LU of ${target !== null ? `the target ${target} LUFS` : 'the middle member'}`,
      ranges: notes.slice(0, 12),
    },
  };
}

/** The text of a set's file (sets/<id>.set): one `key value` per line. */
export function serializeSet(s: SetDoc): string {
  const lines = ['soundclaw set 1', `id ${s.id}`, `from ${s.from ?? 'none'}`, `seed ${s.seed}`, `target ${s.target === null ? 'none' : fmt(s.target)}`, `spread ${s.spread.length ? formatSpread(s.spread) : 'none'}`];
  lines.push(`members ${s.members.join(' ') || 'none'}`, `generated ${s.generated.join(' ') || 'none'}`);
  return lines.join('\n') + '\n';
}
