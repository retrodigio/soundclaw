// A small modal dialog for the Samples views: a scrim, a titled panel, focus in the first field, Esc closes, focus returns to where it was.

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Close } from '../studio/icons.tsx';

export function Dialog({ title, onClose, children, testId, wide }: { title: string; onClose(): void; children: ReactNode; testId?: string; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea, button.btn-primary, button')?.focus();
    return () => { if (prev && document.contains(prev)) prev.focus(); };
  }, []);
  return (
    <div className="smp-scrim" onMouseDown={onClose} data-testid={testId ? `${testId}-scrim` : undefined}>
      <div ref={ref} className={`smp-dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} data-testid={testId} onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          // keep Tab inside the dialog
          if (e.key === 'Tab') {
            const f = [...(ref.current?.querySelectorAll<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])') ?? [])];
            if (!f.length) return;
            const first = f[0]!, last = f[f.length - 1]!;
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
          }
        }}>
        <header className="smp-dialog-head"><h2 id={id}>{title}</h2><button type="button" className="ib ib-quiet" aria-label="Close" onClick={onClose}><Close size={10} /></button></header>
        {children}
      </div>
    </div>
  );
}
