// The generation panel: the kind, the prompt, the length, the takes, the estimate in credits and the budget it comes out of, and a confirm before anything is
// spent. The estimate is the server's (the same text `generate --estimate` prints); nothing is called until Generate, and never past the caps. The free
// test provider makes deterministic placeholder audio and costs nothing.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { GenerationStatus } from '@soundclaw/server/protocol';
import type { Store } from '../store.ts';
import { fetchGeneration, setCap } from '../instruments/api.ts';
import { useToast } from '../studio/controls.tsx';
import { plural } from '../studio/values.ts';
import { setPanels, setPrefs } from '../studio/prefs.ts';
import { Dialog } from './Dialog.tsx';

interface Estimate { ok: boolean; text?: string; error?: string; json?: { estimate: number; perTake: number; names: string[]; refusals: string[]; budget: GenerationStatus['budget']; licence: string } }

async function post(store: Store, body: Record<string, unknown>): Promise<Estimate> {
  try {
    const r = await fetch(`/api/generate?token=${encodeURIComponent(store.token)}`, { method: 'POST', body: JSON.stringify({ ...body, by: store.me }) });
    const j = (await r.json()) as Omit<Estimate, 'ok'>;
    return { ...j, ok: r.ok };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const round = (v: number): number => Math.round(v * 100) / 100;

/** The bar of the project's budget: spent against the cap, as words and as a bar (the words carry it). */
export function BudgetBar({ spent, cap, label }: { spent: number; cap: number; label: string }) {
  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
  return (
    <div className="gen-bar" data-testid={`budget-${label}`}>
      <div className="gen-bar-text"><span>{label}</span><span className="mono">{cap > 0 ? `${round(spent)} of ${cap} credits · ${round(Math.max(0, cap - spent))} left` : `${round(spent)} spent · no cap`}</span></div>
      <div className="gen-bar-track" role="presentation"><div className="gen-bar-fill" style={{ width: `${pct}%` }} data-high={pct >= 90 || undefined} /></div>
    </div>
  );
}

export function GenerateDialog({ store, onClose }: { store: Store; onClose(): void }) {
  const toast = useToast();
  const [status, setStatus] = useState<GenerationStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [kind, setKind] = useState<'sfx' | 'music'>('sfx');
  const [prompt, setPrompt] = useState('');
  const [duration, setDuration] = useState('');
  const [takes, setTakes] = useState(2);
  const [loop, setLoop] = useState(false);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('');
  const [est, setEst] = useState<Estimate | null>(null);
  const [asking, setAsking] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [capText, setCapText] = useState('500');
  const [again, setAgain] = useState(0);
  const refresh = () => { void fetchGeneration(store).then((s) => { setStatus(s); setStatusError(null); setProvider((p) => p || s.provider); }, (e: Error) => setStatusError(e.message)); };
  useEffect(refresh, [store]); // eslint-disable-line react-hooks/exhaustive-deps

  const prov = status?.providers.find((p) => p.id === provider);
  const lim = prov?.kinds.find((k) => k.kind === kind);
  const dur = duration.trim() === '' ? undefined : Number(duration);
  const durBad = dur !== undefined && (!Number.isFinite(dur) || (lim ? dur < lim.min || dur > lim.max : false));
  const nameBad = name !== '' && !/^[a-z0-9][a-z0-9_-]{0,40}$/.test(name);
  const pairs = useMemo(() => ({ ...(dur !== undefined && !durBad ? { duration: String(dur) } : {}), takes: String(takes), ...(loop && lim?.loop ? { loop: 'yes' } : {}), ...(name ? { as: name } : {}), ...(provider ? { provider } : {}) }), [dur, durBad, takes, loop, lim?.loop, name, provider]);

  // the estimate follows what is typed, after a short pause; nothing is called
  const seq = useRef(0);
  useEffect(() => {
    setConfirmed(false);
    if (!prompt.trim() || !provider || durBad || nameBad) { setEst(null); return; }
    const n = ++seq.current;
    setAsking(true);
    const t = setTimeout(() => { void post(store, { kind, prompt: prompt.trim(), pairs, estimate: true }).then((e) => { if (n === seq.current) { setEst(e); setAsking(false); } }); }, 300);
    return () => clearTimeout(t);
  }, [store, kind, prompt, pairs, provider, durBad, nameBad, again]);

  const refusals = est?.ok ? est.json?.refusals ?? [] : est ? [est.error ?? 'refused'] : [];
  const credits = est?.ok ? est.json?.estimate ?? 0 : 0;
  const spends = !!prov?.paid && credits > 0;
  const noCap = !!prov?.paid && (status?.budget.projectCap ?? 0) === 0;
  const canGo = !!est?.ok && refusals.length === 0 && !asking && (!spends || confirmed) && !busy;
  const go = async () => {
    setBusy(true);
    const r = await post(store, { kind, prompt: prompt.trim(), pairs });
    setBusy(false);
    if (r.ok) {
      toast(`Generated ${plural(takes, 'take')}${spends ? ` for about ${credits} credits` : ''}; they wait in Takes`);
      setPrefs({ libTab: 'samples', samplesMode: 'takes' });
      setPanels({ libOpen: true });
      onClose();
    } else { toast(r.error ?? 'generation was refused', 'error'); refresh(); setAgain((n) => n + 1); }
  };
  const saveCap = async () => {
    const r = await setCap(store, Number(capText));
    if (r.ok) { toast(`Project cap set to ${capText} credits`); refresh(); setAgain((n) => n + 1); } else toast(r.error ?? 'refused', 'error');
  };

  return (
    <Dialog title="Generate audio" onClose={onClose} testId="generate-dialog" wide>
      <form className="smp-form" onSubmit={(e) => { e.preventDefault(); if (canGo) void go(); }}>
        {statusError && <p className="smp-error" role="alert" data-testid="generate-status-error"><span className="mono" aria-hidden>!</span> {statusError}</p>}
        <div className="gen-grid">
          <label>kind
            <select value={kind} onChange={(e) => setKind(e.target.value as 'sfx' | 'music')} data-testid="gen-kind">
              <option value="sfx">sound effect</option>
              <option value="music" disabled={!!prov?.kinds.find((k) => k.kind === 'music')?.held}>music{prov?.kinds.find((k) => k.kind === 'music')?.held ? ' (held: needs the owner’s OK)' : ''}</option>
            </select>
          </label>
          <label>made by
            <select value={provider} onChange={(e) => setProvider(e.target.value)} data-testid="gen-provider">
              {status?.providers.map((p) => <option key={p.id} value={p.id}>{p.id}{p.paid ? ` (paid${p.keySet ? '' : `, ${p.keyVar} not set`})` : ' (free test audio)'}</option>)}
            </select>
          </label>
        </div>
        <label>prompt<textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} data-testid="gen-prompt" placeholder="the slow creak of an old wooden door hinge, close, dry, no reverb" autoFocus /></label>
        <div className="gen-grid">
          <label>length (s){lim ? <span className="dim"> {lim.min}–{lim.max}, default {lim.default}</span> : null}<input value={duration} onChange={(e) => setDuration(e.target.value)} data-testid="gen-duration" inputMode="decimal" placeholder={lim ? String(lim.default) : ''} aria-invalid={durBad} spellCheck={false} /></label>
          <label>takes<select value={takes} onChange={(e) => setTakes(Number(e.target.value))} data-testid="gen-takes">{Array.from({ length: Math.min(4, prov?.maxTakes ?? 4) }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
          <label>name (optional)<input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} data-testid="gen-name" placeholder="from the prompt" aria-invalid={nameBad} spellCheck={false} /></label>
        </div>
        {lim?.loop && <label className="smp-confirm"><input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} data-testid="gen-loop" />make it loop seamlessly</label>}

        <div className="gen-estimate" data-testid="gen-estimate" data-state={refusals.length ? 'refused' : est?.ok ? 'ok' : 'idle'} aria-live="polite">
          {!prompt.trim() ? <p className="dim">Type a prompt to see what it would cost.</p> : asking || !est ? <p className="dim" data-testid="gen-estimate-wait">working out the cost{'…'}</p> : (
            <>
              {est.ok && <p className="gen-cost" data-testid="gen-cost"><b className="mono">{credits}</b> credits for {plural(takes, 'take')}{est.json && est.json.perTake ? <span className="dim mono"> ({est.json.perTake} a take)</span> : null}{prov && !prov.paid ? <span className="dim"> · free test audio, no paid call</span> : null}</p>}
              {refusals.map((r, i) => <p key={i} className="smp-error" role="alert" data-testid="gen-refusal"><span className="mono" aria-hidden>!</span> {r}</p>)}
            </>
          )}
          {status && prov?.paid && (
            <>
              <BudgetBar spent={status.budget.projectSpent} cap={status.budget.projectCap} label="this project" />
              <BudgetBar spent={status.budget.daySpent} cap={status.budget.dailyCap} label="today, all projects" />
              <p className="dim mono gen-limit" data-testid="gen-limit">at most {status.budget.maxPerCall} credits for one take</p>
            </>
          )}
          {status?.paidOff && prov?.paid && <p className="smp-error warn" role="status" data-testid="gen-paid-off"><span className="mono" aria-hidden>!</span> paid calls are refused here: {status.paidOff}</p>}
        </div>

        {noCap && (
          <div className="gen-cap" data-testid="gen-cap">
            <p className="dim">Paid generation is off until you set a cap for this project: the most it may spend in total. You set it; the agent cannot.</p>
            <div className="gen-cap-row"><label>cap (credits)<input value={capText} onChange={(e) => setCapText(e.target.value)} data-testid="gen-cap-input" inputMode="numeric" spellCheck={false} /></label>
              <button type="button" className="btn btn-secondary" onClick={() => void saveCap()} disabled={!/^\d+$/.test(capText) || Number(capText) <= 0} data-testid="gen-cap-set">Set the cap</button></div>
          </div>
        )}
        {spends && refusals.length === 0 && (
          <label className="smp-confirm"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-testid="gen-confirm" />I understand this spends about {credits} credits of the {prov?.id} account</label>
        )}
        {prov && <p className="dim smp-hint">{prov.terms.replace(/[.\s]*$/, '')}. The takes are stored as samples with the prompt, the provider and what they cost, and wait in Takes to keep or discard. The licence is the provider{'’'}s, for the plan set in the configuration; keeping a take asks you to confirm it.</p>}
        <div className="smp-form-actions"><button type="submit" className="btn btn-agent" disabled={!canGo} data-testid="gen-go">{busy ? 'Generating…' : 'Generate'}</button><button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button></div>
      </form>
    </Dialog>
  );
}
