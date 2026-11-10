// Layering helpers that measure: `layer align`, `layer match` and `env … follow=`. Each is worked out against the sound as
// it renders when the command runs and put on the tape as the plain command it found (`layer set … offset=`,
// `layer set … gain=`, `env … "<breakpoints>"`), so a replay applies numbers and measures nothing.

import { integratedLoudness } from './analysis.ts';
import type { Command } from './commands.ts';
import { formatEnv, fmtNum, MAX_POINTS, type Env, type LayeredSound } from './layered.ts';
import { SAMPLE_RATE } from './sound.ts';
import { renderParts, type SampleBank } from './synth.ts';
import type { Library } from './sets.ts';

const SR = SAMPLE_RATE;
const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

export interface Measured {
  commands: string[];
  notes: string[];
}

function layered(lib: Library, id: string, what: string): LayeredSound {
  const s = lib.get(id);
  if (!s) throw new Error(`no sound '${id}'`);
  if (s.voice !== 'layered') throw new Error(`${what}: ${id} is a ${s.voice} sound; layers belong to layered sounds`);
  return s;
}

/** The mix of a part's channels, absolute value. */
function level(chs: readonly Float32Array[]): Float32Array {
  const n = chs[0]!.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let m = 0; for (const c of chs) { const a = Math.abs(c[i]!); if (a > m) m = a; } out[i] = m; }
  return out;
}

/** When a layer starts to sound (the first time its 1 ms level reaches 10 % of its peak) or peaks, seconds from the sound's start. */
export function layerMoment(chs: readonly Float32Array[], by: 'onset' | 'peak'): number | null {
  const a = level(chs);
  let peak = 0;
  let at = 0;
  for (let i = 0; i < a.length; i++) if (a[i]! > peak) { peak = a[i]!; at = i; }
  if (peak === 0) return null;
  if (by === 'peak') return at / SR;
  const step = Math.round(SR / 1000);
  for (let i = 0; i < a.length; i += step) {
    let m = 0;
    for (let j = i; j < Math.min(a.length, i + step); j++) m = Math.max(m, a[j]!);
    if (m >= peak * 0.1) {
      // inside this millisecond, the first frame at that level
      for (let j = i; j < Math.min(a.length, i + step); j++) if (a[j]! >= peak * 0.1) return j / SR;
    }
  }
  return at / SR;
}

function partOf(parts: ReturnType<typeof renderParts>['parts'], n: number, id: string, what: string) {
  const p = parts.find((x) => x.index === n - 1);
  if (!p) throw new Error(`${what}: ${id} layer ${n} does not sound (it is muted, or another layer is soloed, or there is no such layer)`);
  return p;
}

/** A follower of the level: it rises with `attack` seconds and falls with `release` seconds (one-pole smoothing on the rectified signal). */
export function followLevel(x: Float32Array, rate: number, attack: number, release: number): Float32Array {
  const out = new Float32Array(x.length);
  const ka = attack > 0 ? 1 - Math.exp(-1 / (attack * rate)) : 1;
  const kr = release > 0 ? 1 - Math.exp(-1 / (release * rate)) : 1;
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]!);
    y += (a > y ? ka : kr) * (a - y);
    out[i] = y;
  }
  return out;
}

/** The plain command a measuring layer command stands for. */
export function measureLayerCommand(lib: Library, c: Command, bank?: SampleBank): Measured {
  switch (c.op) {
    case 'layer-align': {
      const s = layered(lib, c.id, 'layer align');
      const layer = s.layers[c.n - 1];
      if (!layer) throw new Error(`layer align: ${c.id} has ${s.layers.length} layers, no layer ${c.n}`);
      const { parts } = renderParts(s, bank);
      const mine = layerMoment(partOf(parts, c.n, c.id, 'layer align').channels, c.by);
      if (mine === null) throw new Error(`layer align: layer ${c.n} of ${c.id} is silent, so it has no ${c.by} to align`);
      let target = 0;
      if (c.to !== 'start') {
        if (c.to === c.n) throw new Error('layer align: a layer cannot be aligned to itself');
        const t = layerMoment(partOf(parts, c.to, c.id, 'layer align').channels, c.by);
        if (t === null) throw new Error(`layer align: layer ${c.to} of ${c.id} is silent, so it has no ${c.by} to align to`);
        target = t;
      }
      let offset = round6(layer.p.offset as number + target - mine);
      let late = '';
      if (offset < 0 && offset >= -0.005) { late = ` (${fmtNum(round6(-offset * 1000))} ms short of the target: the layer starts at 0 instead)`; offset = 0; }
      if (offset < 0) throw new Error(`layer align: layer ${c.n}'s ${c.by} is ${fmtNum(round6(mine - target))} s into the layer, so it cannot be moved early enough to meet layer ${c.to === 'start' ? 'the start' : c.to}: align layer ${c.to} to layer ${c.n} instead (or shorten the layer's lead-in with start=)`);
      return { commands: [`layer set ${c.id} ${c.n} offset=${fmtNum(offset)}`], notes: [`${c.id} layer ${c.n}: its ${c.by} (${fmtNum(round6(mine))} s into the sound) moved to ${fmtNum(round6(target))} s: offset ${fmtNum(layer.p.offset as number)} -> ${fmtNum(offset)} s${late}`] };
    }
    case 'layer-match': {
      const s0 = layered(lib, c.id, 'layer match');
      if (!s0.layers[c.n - 1]) throw new Error(`layer match: ${c.id} has ${s0.layers.length} layers, no layer ${c.n}`);
      if (c.to === c.n) throw new Error('layer match: a layer cannot be matched to itself');
      const lufsOf = (s: LayeredSound, n: number): number => integratedLoudness(partOf(renderParts(s, bank).parts, n, c.id, 'layer match').channels);
      const want = lufsOf(s0, c.to) + c.db;
      if (!Number.isFinite(want)) throw new Error(`layer match: layer ${c.to} of ${c.id} is silent, so there is no level to match`);
      let gain = s0.layers[c.n - 1]!.p.gain as number;
      let s = s0;
      let now = lufsOf(s, c.n);
      if (!Number.isFinite(now)) throw new Error(`layer match: layer ${c.n} of ${c.id} is silent`);
      // the layer's effects may not be linear, so the gain is corrected once more against the render
      for (let pass = 0; pass < 3 && Math.abs(want - now) > 0.05; pass++) {
        gain = round4(gain * 10 ** ((want - now) / 20));
        if (gain > 4 || gain < 0.0001) throw new Error(`layer match: layer ${c.n} would need a gain of ${fmtNum(gain)}, outside 0 to 4: raise or lower the layers' own levels first`);
        const next = JSON.parse(JSON.stringify(s)) as LayeredSound;
        next.layers[c.n - 1]!.p.gain = gain;
        s = next;
        now = lufsOf(s, c.n);
      }
      return { commands: [`layer set ${c.id} ${c.n} gain=${fmtNum(gain)}`], notes: [`${c.id} layer ${c.n}: ${fmtNum(round6(now))} LUFS against layer ${c.to} at ${fmtNum(round6(want - c.db))} LUFS${c.db ? ` ${c.db > 0 ? '+' : ''}${c.db} dB` : ''}: gain ${fmtNum(s0.layers[c.n - 1]!.p.gain as number)} -> ${fmtNum(gain)}`] };
    }
    case 'env-follow': {
      const s = layered(lib, c.id, 'env follow');
      const layer = s.layers[c.layer - 1];
      if (!layer) throw new Error(`env follow: ${c.id} has ${s.layers.length} layers, no layer ${c.layer}`);
      const attack = c.attack ?? 0.005;
      const release = c.release ?? 0.05;
      let env: Float32Array;
      let rate = SR;
      let lead = 0;
      if ('layer' in c.source) {
        if (c.source.layer === c.layer) throw new Error('env follow: a layer cannot follow itself');
        const { parts } = renderParts(s, bank);
        env = followLevel(level(partOf(parts, c.source.layer, c.id, 'env follow').channels), SR, attack, release);
        lead = layer.p.offset as number; // the follower is on the sound's timeline; the envelope is on the layer's
      } else {
        const smp = bank?.get(c.source.sample);
        if (!smp) throw new Error(`env follow: no sample '${c.source.sample}'`);
        rate = smp.rate;
        env = followLevel(smp.data, rate, attack, release);
      }
      let peak = 0;
      for (const v of env) if (v > peak) peak = v;
      if (peak === 0) throw new Error('env follow: the source is silent');
      const total = env.length / rate;
      const hop = Math.max(0.005, (total - lead) / (MAX_POINTS - 8));
      const pts: Env = [];
      const at = (t: number): number => env[Math.min(env.length - 1, Math.max(0, Math.round((t + lead) * rate)))]! / peak;
      for (let t = 0; t + lead <= total; t += hop) {
        // the largest the follower gets in this step, so a short hit is not stepped over
        let m = at(t);
        for (let u = t; u < t + hop; u += Math.max(1 / rate, hop / 8)) m = Math.max(m, at(u));
        const v = round4(m);
        if (pts.length && pts[pts.length - 1]!.v === v && pts.length > 1 && pts[pts.length - 2]!.v === v) { pts[pts.length - 1]!.t = round6(t); continue; }
        pts.push({ t: round6(t), v, curve: 'lin' });
      }
      if (pts.length < 2) throw new Error('env follow: the source is too short to follow');
      pts[pts.length - 1] = { t: pts[pts.length - 1]!.t, v: 0, curve: 'lin' };
      return { commands: [`env ${c.id} ${c.layer}.amp "${formatEnv(pts)}"`], notes: [`${c.id} layer ${c.layer} follows ${'layer' in c.source ? 'layer ' + c.source.layer : 'sample ' + c.source.sample}: ${pts.length} points (attack ${fmtNum(attack)} s, release ${fmtNum(release)} s)`] };
    }
    default:
      throw new Error(`${c.op} is not a measuring layer command`);
  }
}
