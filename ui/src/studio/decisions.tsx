// A decision made in a review (approve, ask again, revert) lands on the tape and offers Undo for ten seconds. The offer lives
// outside the review so the review can close and focus can go back to where it was; it never takes focus, and ⌘Z does the same.

import { useRef, useSyncExternalStore } from 'react';
import { Button, Kbd } from './controls.tsx';
import { useActions, type Action } from './registry.ts';

export const UNDO_MS = 10_000;

interface Offer { id: number; text: string; undo(): Promise<void>; until: number }

let offer: Offer | null = null;
let seq = 0;
const subs = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
const notify = (): void => { for (const f of [...subs]) f(); };

/** Offer Undo for ten seconds on something just done. */
export function offerUndo(text: string, undo: () => Promise<void>): void {
  clearTimeout(timer);
  offer = { id: ++seq, text, undo, until: Date.now() + UNDO_MS };
  const mine = offer.id;
  timer = setTimeout(() => { if (offer?.id === mine) { offer = null; notify(); } }, UNDO_MS);
  notify();
}

async function take(): Promise<void> {
  const o = offer;
  if (!o) return;
  clearTimeout(timer);
  offer = null;
  notify();
  await o.undo();
}

/** Mounted once in the shell. */
export function UndoBar() {
  const o = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => offer);
  const act = useRef<Action[]>([]);
  act.current = o ? [{ id: 'edit.undo', label: 'Undo the decision just made', group: 'Edit', shortcut: '⌘ Z', key: 'mod+z', override: true, noPalette: true, run: () => { void take(); } }] : [];
  useActions(act.current);
  if (!o) return null;
  return (
    <div className="undo-bar" role="status" aria-live="polite" data-testid="undo-bar" key={o.id}>
      <span className="undo-dot" aria-hidden />
      <span className="mono undo-text" data-testid="undo-text">{o.text}</span>
      <Button onClick={() => void take()} testId="undo-decision">Undo <Kbd>{'⌘'} Z</Kbd></Button>
      <span className="undo-timer" aria-hidden style={{ animationDuration: `${UNDO_MS}ms` }} />
    </div>
  );
}
