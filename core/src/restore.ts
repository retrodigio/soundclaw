// Restoring a sound to an earlier version with ordinary commands: the batch a person's "make this
// version current" writes. A classic or tone sound takes one `sound set` of the values that differ; a
// layered sound takes the layer, env and fx commands that turn the current layers into the earlier
// ones. The result is checked by applying the commands to a copy: when they do not give the earlier
// sound's render exactly (a layer that was removed cannot get its noise salt back), nothing is
// offered, and the reason is given.

import { Library } from './sets.ts';
import { applyCommand, parse } from './commands.ts';
import { restoreCommand } from './editor.ts';
import { FX_SPECS, formatEnv, layerSpecs, showValue, type Env, type Fx, type Layer, type LayeredSound, type Value } from './layered.ts';
import { TONE_PARAMS, cloneSound, fmtNumber, renderKey, type Sound } from './sound.ts';

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function pairsOf(kind: string, specs: readonly { name: string }[], p: Record<string, Value>, names: readonly string[]): string {
  return specs.filter((sp) => names.includes(sp.name)).map((sp) => `${sp.name}=${showValue(kind, sp.name, p[sp.name]!)}`).join(' ');
}

const envCmd = (id: string, target: string, env: Env | null): string => `env ${id} ${target} ${env ? `"${formatEnv(env)}"` : 'clear'}`;

/** The commands that make one effect chain (a layer's, or the master's) the target's: effects of the same kind keep their place and are set, the rest removed and added again. */
function chainCommands(id: string, layer: number | null, now: Fx[], want: Fx[], out: string[]): void {
  const where = layer === null ? '' : ` layer=${layer}`;
  const prefix = layer === null ? 'master.' : `${layer}.`;
  // keep the longest run of effects of the same kind from the start; what follows is rebuilt
  let keep = 0;
  while (keep < now.length && keep < want.length && now[keep]!.kind === want[keep]!.kind) keep++;
  for (let k = now.length; k > keep; k--) out.push(`fx remove ${id}${where} ${k}`);
  for (let k = 0; k < keep; k++) {
    const a = now[k]!, b = want[k]!;
    const names = FX_SPECS[b.kind].filter((sp) => !same(a.p[sp.name], b.p[sp.name]) || (a.envs[sp.name] && !b.envs[sp.name])).map((sp) => sp.name);
    if (names.length) out.push(`fx set ${id}${where} ${k + 1} ${pairsOf('', FX_SPECS[b.kind], b.p, names)}`);
    for (const name of Object.keys(b.envs)) if (!same(a.envs[name], b.envs[name])) out.push(envCmd(id, `${prefix}fx${k + 1}.${name}`, b.envs[name]!));
  }
  for (let k = keep; k < want.length; k++) {
    const f = want[k]!;
    const given = pairsOf('', FX_SPECS[f.kind], f.p, FX_SPECS[f.kind].map((sp) => sp.name));
    out.push(`fx add ${id}${where} ${f.kind}${given ? ` ${given}` : ''}`);
    for (const [name, e] of Object.entries(f.envs)) out.push(envCmd(id, `${prefix}fx${k + 1}.${name}`, e));
  }
}

function layeredCommands(now: LayeredSound, want: LayeredSound): string[] | string {
  const id = now.id;
  const out: string[] = [];
  const salts = new Set(want.layers.map((l) => l.salt));
  const missing = want.layers.filter((l) => !now.layers.some((x) => x.salt === l.salt));
  if (missing.length) return `layer${missing.length === 1 ? '' : 's'} ${missing.map((l) => want.layers.indexOf(l) + 1).join(', ')} of that version ${missing.length === 1 ? 'was' : 'were'} removed since, and a layer added again gets new noise`;
  // remove the layers the earlier version did not have, from the end so the numbers hold
  const order = now.layers.map((l) => l.salt);
  for (let i = order.length - 1; i >= 0; i--) if (!salts.has(order[i]!)) { out.push(`layer remove ${id} ${i + 1}`); order.splice(i, 1); }
  // put the layers in the earlier order
  want.layers.forEach((l, i) => {
    const j = order.indexOf(l.salt);
    if (j !== i) { out.push(`layer move ${id} ${j + 1} to=${i + 1}`); order.splice(j, 1); order.splice(i, 0, l.salt); }
  });
  want.layers.forEach((w, i) => {
    const n = i + 1;
    const c: Layer = now.layers.find((x) => x.salt === w.salt)!;
    const specs = layerSpecs(w.kind);
    const sourceChanged = c.kind !== w.kind;
    // a source change keeps the layer's shared values and drops the rest: every value of the earlier source is set
    const names = specs.filter((sp) => w.p[sp.name] !== undefined && (sourceChanged || !same(c.p[sp.name], w.p[sp.name]) || (c.envs[sp.name] && !w.envs[sp.name]))).map((sp) => sp.name);
    if (sourceChanged || names.length) out.push(`layer set ${id} ${n}${sourceChanged ? ` source=${w.kind}` : ''}${names.length ? ` ${pairsOf(w.kind, specs, w.p, names)}` : ''}`);
    if (!same(c.amp, w.amp) || sourceChanged) out.push(envCmd(id, `${n}.amp`, w.amp));
    for (const name of new Set([...Object.keys(c.envs), ...Object.keys(w.envs)])) {
      if (!w.envs[name] && (names.includes(name) || sourceChanged)) continue; // setting the value cleared it
      if (!same(c.envs[name], w.envs[name])) out.push(envCmd(id, `${n}.${name}`, w.envs[name] ?? null));
    }
    if (c.mute !== w.mute) out.push(`layer mute ${id} ${n} ${w.mute ? 'on' : 'off'}`);
    if (c.solo !== w.solo) out.push(`layer solo ${id} ${n} ${w.solo ? 'on' : 'off'}`);
    chainCommands(id, n, sourceChanged ? [] : c.fx, w.fx, out);
  });
  chainCommands(id, null, now.master, want.master, out);
  const sets: string[] = [];
  if (now.duration !== want.duration) sets.push(`duration=${want.duration === null ? 'auto' : fmtNumber(want.duration)}`);
  if (now.gain !== want.gain) sets.push(`gain=${fmtNumber(want.gain)}`);
  if ((now.out ?? 0) !== (want.out ?? 0)) sets.push(`out=${fmtNumber(want.out ?? 0)}`);
  if (now.seed !== want.seed) sets.push(`seed=${fmtNumber(want.seed)}`);
  if (sets.length) out.push(`sound set ${id} ${sets.join(' ')}`);
  if (!same(now.loop, want.loop)) out.push(want.loop ? `sound loop ${id} ${fmtNumber(want.loop.length)} fade=${fmtNumber(want.loop.fade)}` : `sound loop ${id} off`);
  return out;
}

/**
 * The commands that make `now` sound as `want` did (one batch), or why that cannot be done with commands. Empty when they
 * already render the same. Only what renders is restored: status, class and moment stay as they are now.
 */
export function restoreCommands(now: Sound, want: Sound, sampleHash: (name: string) => string = () => 'none'): { commands: string[] } | { error: string } {
  if (now.id !== want.id) return { error: 'a version is restored onto the same sound' };
  if (renderKey(now, sampleHash) === renderKey(want, sampleHash)) return { commands: [] };
  let commands: string[];
  if (now.voice !== want.voice) return { error: `that version is a ${want.voice} sound and this one is ${now.voice} now; no command turns it back` };
  if (now.voice === 'classic' && want.voice === 'classic') {
    const c = restoreCommand(now.id, now.patch, want.patch);
    commands = c ? [c] : [];
  } else if (now.voice === 'tone' && want.voice === 'tone') {
    const parts = TONE_PARAMS.filter((p) => now[p.name as 'frequency'] !== want[p.name as 'frequency']).map((p) => `${p.name}=${fmtNumber(want[p.name as 'frequency'])}`);
    commands = parts.length ? [`sound set ${now.id} ${parts.join(' ')}`] : [];
  } else {
    const r = layeredCommands(now as LayeredSound, want as LayeredSound);
    if (typeof r === 'string') return { error: r };
    commands = r;
  }
  // check: the commands, applied to a copy of the sound as it is now, give the earlier render exactly
  const lib = new Library([[now.id, cloneSound(now)]]);
  for (const text of commands) {
    const p = parse(text);
    if (p.errors.length || p.commands.length !== 1) return { error: `could not write the restore (${p.errors[0]?.message ?? text})` };
    try { applyCommand(lib, p.commands[0]!); } catch (e) { return { error: `could not write the restore (${(e as Error).message})` }; }
  }
  if (renderKey(lib.get(now.id)!, sampleHash) !== renderKey(want, sampleHash)) return { error: 'the commands cannot give that version back exactly' };
  return { commands };
}
