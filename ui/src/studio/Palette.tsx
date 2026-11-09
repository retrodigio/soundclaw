// The command palette (⌘K) and the shortcut sheet (?). The palette searches the action registry
// and the project's items; a sentence that matches no action well becomes a request to the agent
// on the focused item. Both are dialogs with a focus trap; Esc closes and focus goes back.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Store } from '../store.ts';
import { Kbd, Keys } from './controls.tsx';
import { Search, Spark } from './icons.tsx';
import { fuzzy, recentIds, noteRecent, shortcutLabel, useActionList, type Action } from './registry.ts';
import { hashOf, type Focus } from './shellData.ts';

/** Restore focus to what had it when the dialog opened. */
function useReturnFocus(): void {
  useEffect(() => {
    const was = document.activeElement as HTMLElement | null;
    return () => { if (was && document.contains(was)) was.focus({ preventScroll: true }); };
  }, []);
}

/** Tab stays inside the dialog. */
function trapTab(e: React.KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'Tab') return;
  const els = [...e.currentTarget.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'));
  if (!els.length) { e.preventDefault(); return; }
  const first = els[0]!, last = els.at(-1)!;
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

type Row =
  | { kind: 'ask'; label: string; text: string; target: Focus | null }
  | { kind: 'action'; action: Action; group: string }
  | { kind: 'item'; label: string; group: string; hash: string; sub?: string };

const words = (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean);
const haystack = (s: string) => s.toLowerCase().replace(/[_-]+/g, ' ');

/** Whether the text reads as a sentence: two or more words, and no action or item has all of them. */
function readsAsSentence(text: string, hay: string[]): boolean {
  const w = words(text);
  if (w.length < 2) return false;
  return !hay.some((h) => w.every((x) => h.includes(x)));
}

export function Palette({ store, focus, onClose, ask }: { store: Store; focus: Focus | null; onClose(): void; ask(text: string, target: Focus | null): Promise<boolean> }) {
  useReturnFocus();
  const actions = useActionList();
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const text = q.trim();
    const shown = actions.filter((a) => !a.noPalette && (!a.enabled || a.enabled()));
    const items: Extract<Row, { kind: 'item' }>[] = [
      ...store.index.map((s) => ({ kind: 'item' as const, label: s.id, group: 'Sounds', hash: `#/sound/${s.id}`, sub: s.voice })),
      ...store.sets.map((s) => ({ kind: 'item' as const, label: s.id, group: 'Sets', hash: `#/set/${s.id}`, sub: `${s.members.length} members` })),
      ...store.songs.map((s) => ({ kind: 'item' as const, label: s.id, group: 'Songs', hash: `#/song/${s.id}`, sub: `${s.tempo} BPM` })),
    ];
    const scoredActions = shown.map((a) => ({ a, s: text ? fuzzy(text, `${a.label} ${a.group} ${a.keywords ?? ''}`) : recentIds().includes(a.id) ? 100 - recentIds().indexOf(a.id) : 0 })).filter((x) => x.s !== null);
    scoredActions.sort((x, y) => (y.s ?? 0) - (x.s ?? 0));
    const scoredItems = text ? items.map((it) => ({ it, s: fuzzy(text, `open ${it.label} ${it.sub ?? ''}`) })).filter((x) => x.s !== null).sort((x, y) => (y.s ?? 0) - (x.s ?? 0)).slice(0, 30).map((x) => x.it) : [];
    if (text && readsAsSentence(text, [...shown.map((a) => haystack(`${a.label} ${a.group} ${a.keywords ?? ''}`)), ...items.map((i) => haystack(`open ${i.label} ${i.sub ?? ''}`))])) {
      out.push({ kind: 'ask', label: text, text, target: focus && focus.kind !== 'set' ? focus : null });
    }
    // an item whose name holds the typed text outranks fuzzy matches among the actions
    const lower = text.toLowerCase();
    const itemsFirst = !!text && scoredItems.some((i) => i.label.toLowerCase().includes(lower)) && !scoredActions.some((x) => x.a.label.toLowerCase().includes(lower));
    if (itemsFirst) out.push(...scoredItems);
    for (const x of scoredActions.slice(0, text ? 12 : 40)) out.push({ kind: 'action', action: x.a, group: x.a.group });
    if (!itemsFirst) out.push(...scoredItems);
    if (text && text.includes(' ') && !out.some((r) => r.kind === 'ask')) out.push({ kind: 'ask', label: text, text, target: focus && focus.kind !== 'set' ? focus : null });
    return out;
  }, [q, actions, store.index, store.sets, store.songs, focus]);

  useEffect(() => setAt(0), [q]);
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [at, rows]);

  const run = async (r: Row | undefined) => {
    if (!r) return;
    if (r.kind === 'ask') {
      if (!r.target) return;
      if (await ask(r.text, r.target)) onClose();
      return;
    }
    onClose();
    if (r.kind === 'action') { noteRecent(r.action.id); await r.action.run(); } else { location.hash = r.hash; }
  };

  const onKey = (e: React.KeyboardEvent<HTMLElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); setAt((i) => Math.min(rows.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); void run(rows[at]); }
    else trapTab(e);
  };

  let lastGroup = '';
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="palette-overlay">
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKey} data-testid="palette">
        <div className="palette-in">
          <Search size={14} />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search actions and items, or ask the agent in a sentence" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={rows[at] ? `pal-${at}` : undefined} aria-autocomplete="list" data-testid="palette-input" spellCheck={false} autoComplete="off" />
        </div>
        <div className="palette-list" id="palette-list" role="listbox" aria-label="Results" ref={listRef} data-testid="palette-list">
          {rows.length === 0 && <p className="dim pad">Nothing matches. Type a sentence to ask the agent.</p>}
          {rows.map((r, i) => {
            const group = r.kind === 'ask' ? '' : r.group;
            const head = group && group !== lastGroup ? <div className="cap palette-group" key={`g${i}`}>{group}</div> : null;
            if (group) lastGroup = group;
            return (
              <div key={i}>
                {head}
                <div id={`pal-${i}`} role="option" aria-selected={i === at} aria-disabled={r.kind === 'ask' && !r.target ? true : undefined} className={`palette-row${r.kind === 'ask' ? ' ask-row' : ''}${r.kind === 'ask' && !r.target ? ' disabled' : ''}`} data-testid={r.kind === 'ask' ? 'palette-ask' : `palette-row-${r.kind === 'action' ? r.action.id : r.label}`}
                  onMouseMove={() => setAt(i)} onClick={() => void run(r)}>
                  {r.kind === 'ask' && <><Spark size={14} /><span className="grow">Ask the agent: <span className="ask-text">{'“'}{r.text}{'”'}</span> {r.target ? <>on <span className="mono">{r.target.id}</span></> : <span className="dim">(open or select a sound first)</span>}</span><Kbd>{'↵'}</Kbd></>}
                  {r.kind === 'action' && <><span className="grow">{r.action.label}</span>{r.action.shortcut && <span className="keys"><Keys combo={shortcutLabel(r.action.shortcut)} /></span>}</>}
                  {r.kind === 'item' && <><span className="grow">Open <span className="mono">{r.label}</span></span><span className="dim small">{r.sub}</span></>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function ShortcutSheet({ onClose }: { onClose(): void }) {
  useReturnFocus();
  const actions = useActionList();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('button')?.focus(); }, []);
  const groups = useMemo(() => {
    const m = new Map<string, Action[]>();
    // a page's own action replaces the shell's reference line for the same key in the same group
    const live = new Set(actions.filter((a) => a.shortcut && !a.id.startsWith('ref.')).map((a) => `${a.group}|${a.shortcut}`));
    for (const a of actions) if (a.shortcut && !(a.id.startsWith('ref.') && live.has(`${a.group}|${a.shortcut}`))) { const g = m.get(a.group) ?? []; g.push(a); m.set(a.group, g); }
    return [...m.entries()];
  }, [actions]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="shortcuts-overlay">
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" ref={ref} data-testid="shortcuts" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); onClose(); } else trapTab(e); }}>
        <div className="sheet-head"><h2>Keyboard shortcuts</h2><button type="button" className="btn btn-quiet" onClick={onClose}>Close</button></div>
        <div className="sheet-cols">
          {groups.map(([g, list]) => (
            <section key={g} aria-label={g}>
              <h3 className="cap">{g}</h3>
              {list.map((a) => <div key={a.id} className="sheet-row" data-testid={`sc-${a.id}`}><span>{a.label}</span><span className="keys"><Keys combo={shortcutLabel(a.shortcut!)} /></span></div>)}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

export { hashOf };
