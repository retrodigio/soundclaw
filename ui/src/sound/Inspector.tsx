// Pieces of the sound pages' inspector that both editors use: whether it is open (kept per
// browser), this sound's history, and the box that asks the agent for changes.

import { useEffect, useRef, useState } from 'react';
import type { Store } from '../store.ts';
import { AuthorDot, authorOf, Button } from '../studio/controls.tsx';
import { ago, soundOfCmd } from '../studio/shellData.ts';

const KEY = 'soundclaw.inspector';

/** Is the inspector open? Kept per browser. */
export function useInspectorOpen(): [boolean, (v?: boolean) => void] {
  const [open, setOpen] = useState<boolean>(() => { try { return localStorage.getItem(KEY) !== '0'; } catch { return true; } });
  const toggle = (v?: boolean) => setOpen((o) => { const n = v ?? !o; try { localStorage.setItem(KEY, n ? '1' : '0'); } catch { /* storage off */ } return n; });
  return [open, toggle];
}

/** The commands on the tape that name this sound, newest first. */
export function HistoryList({ store, id, limit = 8 }: { store: Store; id: string; limit?: number }) {
  const known = new Set([id]);
  const rows = store.tape.filter((e) => soundOfCmd(e.cmd, known) === id).slice(-limit).reverse();
  const now = Date.now();
  return (
    <div className="insp-hist" data-testid="insp-history">
      {rows.length === 0 && <p className="dim small">Nothing on the tape names this sound yet.</p>}
      {rows.map((e) => (
        <div key={e.seq} className="insp-hist-row" data-testid="insp-history-row" data-by={authorOf(e.by)}>
          <AuthorDot by={authorOf(e.by)} />
          <span className="mono insp-cmd">{e.cmd}</span>
          <span className="insp-when">{authorOf(e.by) === 'you' ? 'you' : 'agent'}{e.at ? ` · ${ago(e.at, now).replace(' ago', '')}` : ''}</span>
        </div>
      ))}
    </div>
  );
}

/** Ask the agent for changes: a note (with the selected region, when there is one), sent as a change request. */
export function AskComposer({ store, id, selection, focusToken, onClose }: { store: Store; id: string; selection?: { a: number; b: number } | null; focusToken: number; onClose?(): void }) {
  const [text, setText] = useState('');
  const [state, setState] = useState<{ ok: boolean; msg: string } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (focusToken) ref.current?.focus(); }, [focusToken]);
  const send = async () => {
    const note = text.trim();
    if (!note) return;
    const pinned = selection ? ` (pinned to ${selection.a.toFixed(2)}–${selection.b.toFixed(2)} s)` : '';
    const r = await store.askForChanges(id, note + pinned);
    setState({ ok: r.ok, msg: r.ok ? 'Sent to the agent.' : (r.error ?? 'The request was refused.') });
    if (r.ok) { setText(''); onClose?.(); }
  };
  return (
    <div className="ask-box" data-testid="ask-box">
      <textarea ref={ref} value={text} rows={2} placeholder={selection ? `What should change in ${selection.a.toFixed(2)}–${selection.b.toFixed(2)} s?` : 'What should change?'} aria-label="Ask the agent for changes" data-testid="ask-text"
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void send(); } else if (e.key === 'Escape') { e.preventDefault(); (e.target as HTMLElement).blur(); onClose?.(); } }} />
      <div className="ask-row">
        <Button kind="agent" testId="ask-send" disabled={!text.trim()} onClick={() => void send()}>Send <kbd className="kbd">⌘↵</kbd></Button>
        {state && <span className={state.ok ? 'dim small' : 'small ask-err'} role="status">{state.msg}</span>}
      </div>
    </div>
  );
}
