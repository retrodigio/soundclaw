// What shows when the agent works while you look: the batch strip (cells fill as items land) and the
// "agent update waiting" chip. Neither moves anything you are looking at: the strip takes its own row,
// and the chip sits at the top of the page of the item whose update it holds.

import { useEffect, useState } from 'react';
import type { Store } from '../store.ts';
import { Spark } from './icons.tsx';

const LINGER_MS = 6000;

/** Is a batch worth showing: running, or ended a moment ago (so a fast one is still seen). */
export function useBatch(store: Store): { batch: NonNullable<Store['batch']>; running: boolean } | null {
  const [, tick] = useState(0);
  const b = store.batch;
  const ended = store.batchEndedAt;
  useEffect(() => {
    if (!b || b.state === 'running' || !ended) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.max(0, LINGER_MS - (Date.now() - ended)) + 20);
    return () => clearTimeout(t);
  }, [b, ended]);
  if (!b) return null;
  if (b.state === 'running') return { batch: b, running: true };
  return ended && Date.now() - ended < LINGER_MS ? { batch: b, running: false } : null;
}

/** The batch strip: one cell for each item, filled as items land. `scope` limits it to a page about one item. */
export function BatchStrip({ store, scope }: { store: Store; scope?: string | null }) {
  const v = useBatch(store);
  if (!v) return null;
  const { batch: b, running } = v;
  if (scope && store.batchItems.size && !store.batchItems.has(scope)) return null;
  const who = b.by.replace(/^(agent|human):/, '');
  return (
    <div className={`batch-strip${running ? '' : ' ended'}`} data-testid="batch-strip" data-state={b.state} data-done={b.done} data-total={b.total} role="status" aria-live="polite">
      <Spark size={12} />
      <b>{who}</b>
      <span className="batch-word">{running ? `rendering ${Math.min(b.total, b.done + 1)} of ${b.total}` : b.state === 'failed' ? 'batch refused' : `finished ${b.total} of ${b.total}`}</span>
      <div className="batch-cells" aria-hidden>
        {Array.from({ length: Math.min(b.total, 60) }, (_, i) => (
          <span key={i} className="batch-cell" data-state={i < b.done ? 'ready' : i === b.done && running ? 'rendering' : 'queued'} />
        ))}
      </div>
      <span className="mono batch-label" title={b.label}>{b.label}</span>
    </div>
  );
}

/** "Agent update waiting · review": the agent changed the item you are editing; your version stays until you take it. */
export function UpdateChip({ store, id }: { store: Store; id: string }) {
  const held = store.held.get(id);
  if (!held) return null;
  const target = held.request ?? held.group;
  return (
    <div className="update-row" data-testid="update-row">
      <a className="update-chip" href={`#/review/${target}`} data-testid="update-chip" data-request={held.request ?? undefined} data-group={held.group}>
        <Spark size={10} />agent update waiting {'·'} review
      </a>
      <span className="dim small">The agent changed {id}; the editor keeps your version until you take its update.</span>
      <button type="button" className="link-btn small" data-testid="update-take" onClick={() => store.takeUpdate(id)}>take it now</button>
    </div>
  );
}
