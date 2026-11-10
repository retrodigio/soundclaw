// The dialogs of the sample page: derive a new sample by a chain of operations, and generate again from the recorded prompt (the estimate first).

import { useEffect, useState } from 'react';
import type { SampleInfo } from '@soundclaw/server/protocol';
import type { Store } from '../store.ts';
import { useToast } from '../studio/controls.tsx';
import { Dialog } from './Dialog.tsx';

const SAMPLE_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** A free name: `base`, else `base_2`, `base_3`, … */
export function freeName(store: Store, base: string): string {
  const b = base.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 44) || 'sample';
  if (!store.samples.some((x) => x.name === b)) return b;
  for (let n = 2; n < 1000; n++) if (!store.samples.some((x) => x.name === `${b}_${n}`)) return `${b}_${n}`;
  return b;
}

const PRESETS: { label: string; op: string }[] = [
  { label: 'cut silence', op: 'silence-trim -50' },
  { label: 'normalize', op: 'normalize peak -1' },
  { label: 'fade out', op: 'fade out=80ms' },
  { label: 'mono', op: 'mono' },
  { label: 'reverse', op: 'reverse' },
  { label: 'octave down', op: 'pitch -12' },
];

export function DeriveDialog({ store, info, onClose, onMade }: { store: Store; info: SampleInfo; onClose(): void; onMade(name: string): void }) {
  const toast = useToast();
  const [name, setName] = useState(() => freeName(store, `${info.name}_2`));
  const [op, setOp] = useState('silence-trim -50');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taken = store.samples.some((x) => x.name === name);
  const valid = SAMPLE_NAME.test(name) && !taken && op.trim().length > 0 && !/["\n]/.test(op);
  const go = async () => {
    if (!valid || busy) return;
    setBusy(true); setError(null);
    const r = await store.run(`sample derive ${name} from=${info.name} op="${op.trim().replace(/\s*;\s*/g, '; ')}"`);
    setBusy(false);
    if (r.ok) { toast(`Made ${name} from ${info.name}`); onMade(name); } else setError(r.errors.map((e) => e.message).join('; '));
  };
  return (
    <Dialog title={`Derive from ${info.name}`} onClose={onClose} testId="derive-dialog">
      <form className="smp-form" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <label>new sample<input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} data-testid="derive-name" aria-invalid={!SAMPLE_NAME.test(name) || taken} spellCheck={false} /></label>
        {taken && <p className="smp-error" role="alert"><span className="mono" aria-hidden>!</span> there is a sample called {name} already</p>}
        <label>operations, separated by ;<input value={op} onChange={(e) => setOp(e.target.value)} data-testid="derive-op" spellCheck={false} /></label>
        <div className="chips" aria-label="Operations">{PRESETS.map((p) => <button key={p.op} type="button" className="chip-c" data-testid={`derive-preset-${p.label.replace(/\s+/g, '-')}`} onClick={() => setOp((o) => (o.trim() ? `${o.trim()}; ${p.op}` : p.op))}>{p.label}</button>)}</div>
        <p className="dim smp-hint">The new sample keeps this one{'’'}s licence. Operations: trim, fade, gain, normalize, silence-trim, dc, reverse, mono, left, right, pitch, stretch, loop, slice, mix. The command is <code className="mono">sample derive {name || '<new>'} from={info.name}</code>.</p>
        {error && <p className="smp-error" role="alert" data-testid="derive-error"><span className="mono" aria-hidden>!</span> {error}</p>}
        <div className="smp-form-actions"><button type="submit" className="btn btn-primary" disabled={!valid || busy} data-testid="derive-go">Derive</button><button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button></div>
      </form>
    </Dialog>
  );
}

interface GenReply { text?: string; json?: { estimate?: number; refusals?: string[]; budget?: unknown }; error?: string }

async function generate(store: Store, body: Record<string, unknown>): Promise<GenReply & { ok: boolean }> {
  try {
    const r = await fetch(`/api/generate?token=${encodeURIComponent(store.token)}`, { method: 'POST', body: JSON.stringify({ ...body, by: store.me }) });
    const j = (await r.json()) as GenReply;
    return { ...j, ok: r.ok };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Generate again from a generated sample's recorded prompt: the estimate and the budget first, then a confirm. A new call, so new takes. */
export function GenerateAgainDialog({ store, info, onClose }: { store: Store; info: SampleInfo; onClose(): void }) {
  const toast = useToast();
  const [est, setEst] = useState<GenReply & { ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { let live = true; void generate(store, { again: info.name, estimate: true }).then((r) => { if (live) setEst(r); }); return () => { live = false; }; }, [store, info.name]);
  const refused = est && (!est.ok || (est.json?.refusals?.length ?? 0) > 0);
  const go = async () => {
    setBusy(true);
    const r = await generate(store, { again: info.name });
    setBusy(false);
    if (r.ok) { toast('Generated new takes; they are in the Takes list'); onClose(); } else toast(r.error ?? 'generation was refused', 'error');
  };
  return (
    <Dialog title={`Generate again: ${info.name}`} onClose={onClose} testId="again-dialog">
      <div className="smp-form">
        {!est ? <p className="dim" data-testid="again-wait">working out the cost{'…'}</p> : (
          <pre className="smp-estimate mono" data-testid="again-estimate" data-refused={refused || undefined}>{est.ok ? est.text : est.error}</pre>
        )}
        <p className="dim smp-hint">This is a new call with the recorded prompt and settings, so the takes are new audio. Nothing is spent until you confirm, and never beyond the project{'’'}s cap.</p>
        <div className="smp-form-actions"><button type="button" className="btn btn-primary" disabled={!est || !!refused || busy} onClick={() => void go()} data-testid="again-go">Generate</button><button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button></div>
      </div>
    </Dialog>
  );
}
