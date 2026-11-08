// The set loudness meter: the class band (target ± tolerance) and one mark per member at its current
// loudness, coloured and shaped by how it stands against the band (round passes, rounded square
// warns, square fails), with the member's number and its LUFS under the mark.

import { GLYPH, WORD, type CheckKind } from '../studio/controls.tsx';
import { lufsText, MINUS } from '../studio/shellData.ts';
import { loudKind } from './abmath.ts';

export interface MeterMark { id: string; n: number; lufs: number | null | undefined }

export function SetMeter({ marks, target, tolerance, label }: { marks: MeterMark[]; target: number; tolerance: number; label: string }) {
  const span = 6;
  const min = Math.round(target) - span, max = Math.round(target) + span;
  const pos = (v: number) => `${Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100))}%`;
  // marks close together put their labels on lower lines, so none overlaps
  const lines: number[] = [];
  const placed = marks.filter((m) => m.lufs !== undefined)
    .map((m) => ({ m, x: m.lufs === null ? 0 : Math.max(0, Math.min(100, ((m.lufs! - min) / (max - min)) * 100)) }))
    .sort((a, b) => a.x - b.x)
    .map((p) => {
      let row = lines.findIndex((end) => p.x - end >= 11);
      if (row < 0) row = lines.length < 4 ? lines.length : 0;
      lines[row] = p.x;
      return { ...p, row };
    });
  const ticks = [min, min + span / 2, target, max - span / 2, max].map((v) => Math.round(v));
  return (
    <section className="set-meter panel-s" aria-label="Set loudness" data-testid="set-meter">
      <div className="set-meter-head"><span className="cap">Set loudness</span><span className="dim small">{label}</span></div>
      <div className="set-meter-track" style={{ height: 40 + Math.max(0, lines.length - 1) * 13 }} role="img" aria-label={`${label}. ${marks.map((m) => `${m.n} ${m.id} ${m.lufs === undefined ? 'measuring' : `${lufsText(m.lufs)} LUFS, ${WORD[loudKind(m.lufs, target, tolerance)]}`}`).join('; ')}`}>
        <div className="set-meter-rail" />
        <div className="set-meter-band" style={{ left: pos(target - tolerance), width: `${((2 * tolerance) / (max - min)) * 100}%` }} />
        {placed.map(({ m, x, row }) => {
          const kind: CheckKind = loudKind(m.lufs, target, tolerance);
          return (
            <div key={m.id} className="set-mark" data-kind={kind} data-testid={`mark-${m.id}`} data-lufs={m.lufs ?? ''} style={{ left: `${x}%` }} title={`${m.id}: ${lufsText(m.lufs)} LUFS (${WORD[kind]})`}>
              <span className="set-mark-dot" aria-hidden />
              <span className="mono set-mark-t" style={{ marginTop: row * 13 }}><span aria-hidden>{GLYPH[kind]} </span>{m.n} · {lufsText(m.lufs)}</span>
            </div>
          );
        })}
      </div>
      <div className="mono set-meter-scale" aria-hidden>{ticks.map((t, i) => <span key={i}>{String(t).replace('-', MINUS)}{i === ticks.length - 1 ? ' LUFS' : ''}</span>)}</div>
    </section>
  );
}
