// Requests about a sample: the dialog that files one (on the sample itself, or on a sound that plays it, as before) and the panel that lists the
// requests made on this sample with what the agent said, and Approve / Ask again once one is done.

import { useState } from 'react';
import type { WorkRequest } from '@soundclaw/core';
import { targetWords } from '@soundclaw/core';
import type { SampleInfo } from '@soundclaw/server/protocol';
import type { Store } from '../store.ts';
import { useToast } from '../studio/controls.tsx';
import { requestState } from '../studio/shellData.ts';
import { Dialog } from './Dialog.tsx';

export const sampleItem = (name: string): string => `sample:${name}`;

/** The requests made on this sample itself, newest first. */
export const requestsOn = (store: Store, name: string): WorkRequest[] => store.requests.filter((q) => q.sound === sampleItem(name)).slice().reverse();

interface AskProps { store: Store; info: SampleInfo; sounds: string[]; /** The region selected on the lens (seconds), pinned to the request when the person asks. */ selection: [number, number] | null; again?: string | undefined; onClose(): void }

export function AskDialog({ store, info, sounds, selection, again, onClose }: AskProps) {
  const toast = useToast();
  const [on, setOn] = useState<'sample' | 'sound'>('sample');
  const [sound, setSound] = useState(sounds[0] ?? '');
  const [text, setText] = useState('');
  const [pin, setPin] = useState(!!selection);
  const go = async () => {
    if (on === 'sample') {
      const target = pin && selection ? { kind: 'range' as const, start: Math.round(selection[0] * 1000) / 1000, end: Math.round(selection[1] * 1000) / 1000 } : undefined;
      const r = await store.request({ action: 'request', kind: 'change', sound: sampleItem(info.name), note: text.trim(), ...(target ? { target } : {}), ...(again ? { again } : {}) });
      if (r.ok) { toast(`Sent to the agent about ${info.name}`); onClose(); } else toast(r.error ?? 'The request was refused.', 'error');
      return;
    }
    // the older route: a request on a sound that plays the sample, with the sample named in the note
    const r = await store.askForChanges(sound, `About sample ${info.name}: ${text.trim()}`);
    if (r.ok) { toast(`Sent to the agent about ${info.name} (on ${sound})`); onClose(); } else toast(r.error ?? 'The request was refused.', 'error');
  };
  const ok = !!text.trim() && (on === 'sample' || !!sound);
  return (
    <Dialog title={`${again ? 'Ask again' : 'Ask for changes'}: ${info.name}`} onClose={onClose} testId="ask-sample-dialog">
      <form className="smp-form" onSubmit={(e) => { e.preventDefault(); if (ok) void go(); }}>
        <fieldset className="smp-radios" aria-label="What the request is about">
          <label className="smp-confirm"><input type="radio" name="ask-on" checked={on === 'sample'} onChange={() => setOn('sample')} data-testid="ask-on-sample" />the sample itself</label>
          <label className="smp-confirm"><input type="radio" name="ask-on" checked={on === 'sound'} onChange={() => setOn('sound')} disabled={sounds.length === 0} data-testid="ask-on-sound" />a sound that plays it{sounds.length === 0 ? ' (none does yet)' : ''}</label>
        </fieldset>
        {on === 'sound' && (
          <label>on the sound<select value={sound} onChange={(e) => setSound(e.target.value)} data-testid="ask-sample-sound">{sounds.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
        )}
        {on === 'sample' && selection && (
          <label className="smp-confirm"><input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} data-testid="ask-sample-pin" />pin it to the selected {selection[0].toFixed(2)}–{selection[1].toFixed(2)} s</label>
        )}
        <label>what should change<textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} data-testid="ask-sample-text" placeholder="shorter, less noisy, a deeper version…" autoFocus /></label>
        <p className="dim smp-hint">{on === 'sample' ? 'The agent is handed the sample’s numbers and what plays it. A sample is material, so no check gates it.' : 'The agent changes the sound and its checks hold, as for any sound.'}</p>
        <div className="smp-form-actions"><button type="submit" className="btn btn-agent" disabled={!ok} data-testid="ask-sample-go">Send to the agent</button><button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button></div>
      </form>
    </Dialog>
  );
}

/** What this sample's requests say, in the page's second column. */
export function RequestsPanel({ store, name, onAgain }: { store: Store; name: string; onAgain(id: string): void }) {
  const toast = useToast();
  const reqs = requestsOn(store, name);
  if (!reqs.length) return null;
  const decide = async (id: string) => {
    const r = await store.decide(id, 'approved');
    if (r.ok) toast(`Approved ${id}`); else toast(r.error ?? 'refused', 'error');
  };
  return (
    <>
      <h2 className="cap">Requests <span className="dim">about this sample</span></h2>
      <ul className="sp-requests" data-testid="sample-requests">
        {reqs.map((q) => {
          const st = requestState(q);
          const done = q.state === 'done';
          return (
            <li key={q.id} data-testid={`sample-request-${q.id}`} data-state={q.state}>
              <div className="sp-req-head"><b className="mono">{q.id}</b><span className="state-chip" data-tone={st.tone} data-testid={`sample-request-state-${q.id}`}>{q.reviewed ? q.reviewed.how : st.word}</span>{q.target && <span className="mono dim">{targetWords(q.target)}</span>}</div>
              <p className="sp-req-note">{'“'}{q.note}{'”'}</p>
              {q.state === 'blocked' && <p className="sp-req-said" data-testid={`sample-request-question-${q.id}`}>The agent asks: {'“'}{q.question}{'”'}</p>}
              {q.latest && q.state !== 'blocked' && <p className="sp-req-said" data-testid={`sample-request-said-${q.id}`}>{q.latest}</p>}
              {done && !q.reviewed && (
                <div className="sp-req-actions">
                  <button type="button" className="btn btn-primary" data-testid={`sample-request-approve-${q.id}`} onClick={() => void decide(q.id)}>Approve</button>
                  <button type="button" className="btn btn-quiet" data-testid={`sample-request-again-${q.id}`} onClick={() => onAgain(q.id)}>Ask again{'…'}</button>
                </div>
              )}
              {['open', 'claimed', 'blocked'].includes(q.state) && <button type="button" className="link-btn" data-testid={`sample-request-cancel-${q.id}`} onClick={() => void store.request({ action: 'cancel', id: q.id })}>withdraw</button>}
            </li>
          );
        })}
      </ul>
    </>
  );
}
