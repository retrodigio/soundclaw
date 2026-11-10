// Generation spend on the session page: what this project has spent against its cap, what today has spent against the daily cap across projects, and
// the latest calls (what was asked, how many takes, what it cost). It reads the project's ledger through the server; a free test call costs nothing.

import { useEffect, useState } from 'react';
import type { GenerationStatus } from '@soundclaw/server/protocol';
import { fetchGeneration } from '../instruments/api.ts';
import { BudgetBar } from '../samples/GenerateDialog.tsx';
import { openGenerate } from '../samples/samplesUi.ts';
import type { Store } from '../store.ts';
import { Button } from './controls.tsx';
import { ago } from './shellData.ts';
import { plural } from './values.ts';

export function Spend({ store, now }: { store: Store; now: number }) {
  const [s, setS] = useState<GenerationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the numbers follow the tape: a generation by the agent adds takes to it
  useEffect(() => {
    let live = true;
    fetchGeneration(store).then((x) => { if (live) { setS(x); setError(null); } }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [store, store.tapeTotal]);
  const off = s && s.budget.projectCap === 0;
  return (
    <section className="card spend-card" aria-label="Generation spend" data-testid="session-spend">
      <div className="working-head"><span className="cap">Generation spend</span><span className="grow" /><Button kind="agent" testId="spend-generate" onClick={openGenerate}>Generate audio{'…'}</Button></div>
      {error && <p className="smp-error" role="alert" data-testid="spend-error"><span className="mono" aria-hidden>!</span> {error}</p>}
      {!s && !error && <p className="dim small">reading the ledger{'…'}</p>}
      {s && (
        <>
          <BudgetBar spent={s.budget.projectSpent} cap={s.budget.projectCap} label="this project" />
          <BudgetBar spent={s.budget.daySpent} cap={s.budget.dailyCap} label="today, all projects" />
          <p className="dim small" data-testid="spend-state">
            {off ? <><span className="mono" aria-hidden>{'■'}</span> paid generation is off until a person sets a cap for this project. The free test audio always works.</> : <>at most {s.budget.maxPerCall} credits for one take {'·'} {plural(s.totals.commands, 'call')} so far {'·'} {s.totals.credits} credits</>}
            {s.paidOff ? <> {'·'} paid calls refused here: {s.paidOff}</> : null}
          </p>
          <ul className="spend-recent" data-testid="spend-recent">
            {s.recent.length === 0 && <li className="dim small">No generation yet.</li>}
            {s.recent.map((l, i) => (
              <li key={i} data-testid="spend-line"><span className="mono">{l.charge} credits</span><span>{plural(l.takes, 'take')}: {'“'}{l.prompt}{'”'}</span><span className="dim mono">{l.provider} {l.kind} {'·'} {l.by.replace(/^(agent|human):/, '')} {'·'} {ago(l.at, now)}{l.outcome !== 'ok' ? ` · ${l.outcome}` : ''}</span></li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
