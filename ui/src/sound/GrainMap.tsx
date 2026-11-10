// A grain layer drawn: the sample it is cut from, where the grains are taken (the position and the band the spread covers), and how many sound at once.
// The card in the layer's chain holds the small drawing; the layer's panel the larger one with the words.

import type { Layer, SampleData } from '@soundclaw/core';

const BARS = 100;
const cache = new WeakMap<SampleData, number[]>();

/** The sample's size over `BARS` stretches, 0..1 each. */
function peaksOf(smp: SampleData): number[] {
  const have = cache.get(smp);
  if (have) return have;
  const n = smp.data.length;
  const out: number[] = [];
  let top = 1e-9;
  for (let k = 0; k < BARS; k++) {
    const a = Math.floor((n * k) / BARS), b = Math.max(a + 1, Math.floor((n * (k + 1)) / BARS));
    let m = 0;
    for (let i = a; i < b && i < n; i++) { const v = Math.abs(smp.data[i]!); if (v > m) m = v; }
    out.push(m);
    if (m > top) top = m;
  }
  const res = out.map((v) => v / top);
  cache.set(smp, res);
  return res;
}

/** Grains sounding at once, as the renderer counts them (at most 64). */
export const grainOverlap = (l: Pick<Layer, 'p'>): number => Math.min(64, Number(l.p.density) * Number(l.p.size));

export function GrainMap({ layer, smp, compact = false, testId }: { layer: Layer; smp: SampleData | undefined; compact?: boolean; testId?: string }) {
  const W = 300, H = compact ? 26 : 56;
  const pos = Math.min(1, Math.max(0, Number(layer.p.position))), spr = Math.min(1, Math.max(0, Number(layer.p.spread)));
  const lo = Math.max(0, pos - spr), hi = Math.min(1, pos + spr);
  const peaks = smp ? peaksOf(smp) : [];
  const moving = !!layer.envs.position;
  const overlap = grainOverlap(layer);
  return (
    <div className="grain-map" data-testid={testId} data-missing={smp ? undefined : true}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height={H} role="img"
        aria-label={`grains cut from ${String(layer.p.sample) || 'no sample'} around ${Math.round(pos * 100)} percent, spread ${Math.round(spr * 100)} percent`}>
        {peaks.map((v, i) => <rect key={i} className="gm-wave" x={(i / BARS) * W + 0.4} width={W / BARS - 0.8} y={H / 2 - v * (H / 2 - 2)} height={Math.max(0.8, v * (H - 4))} />)}
        {!moving && <rect className="gm-band" x={lo * W} width={Math.max(1.5, (hi - lo) * W)} y={0} height={H} />}
        {!moving && <line className="gm-pos" x1={pos * W} x2={pos * W} y1={0} y2={H} />}
      </svg>
      {!compact && (
        <p className="dim small gm-words" data-testid="grain-words">
          {Number(layer.p.density)} grains a second of {Math.round(Number(layer.p.size) * 1000)} ms, about {overlap < 10 ? overlap.toFixed(1) : Math.round(overlap)} at once
          {Number(layer.p.density) * Number(layer.p.size) > 64 ? ' (the density is lowered to keep to 64)' : ''}
          {moving ? ' · the position follows an envelope' : ` · taken around ${Math.round(pos * 100)} % of the sample, ± ${Math.round(spr * 100)} %`}
          {smp ? '' : ' · the sample is not here'}
        </p>
      )}
    </div>
  );
}
