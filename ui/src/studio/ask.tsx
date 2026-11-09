// Ask for changes from a selection: the composer popover and the ways to reach it. A page says what is selected in two
// ways: an element carries `data-ask` (a knob, a layer, a device, a library row or card: what it stands for, as JSON), or
// the page registers a source that reads its own state (the region on a lens, the bars on a song's ruler). R opens the composer
// for the focused element, else the page's selection, else the focused item; the context menu does the same from the pointer.
// The popover is anchored to the selection, carries the note and context chips, and sends with ⌘↵ or cancels with Esc,
// returning focus to where it was.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { momentOf, targetWords, type RequestTarget } from '@soundclaw/core';
import type { Store } from '../store.ts';
import { Button, Chip, Kbd, useToast } from './controls.tsx';
import { Spark } from './icons.tsx';
import type { Focus } from './shellData.ts';

export interface AskSpec {
  /** The sound or song the request is about. */
  sound: string;
  target: RequestTarget;
  /** The selection as the chip says it (`laser · 0.31–0.38 s`). */
  label: string;
  /** Where the popover points; absent: the focused element, else the middle of the page. */
  anchor?: () => DOMRect | null;
}

interface Open extends AskSpec { returnTo: HTMLElement | null }

let current: Open | null = null;
const subs = new Set<() => void>();
const notify = (): void => { for (const f of [...subs]) f(); };

/** Open the composer on a selection; focus goes back to where it was when the composer closes. */
export function openAsk(spec: AskSpec): void {
  const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  current = { ...spec, returnTo: active };
  notify();
}

export function closeAsk(restore = true): void {
  const was = current;
  current = null;
  notify();
  if (restore && was?.returnTo && document.contains(was.returnTo)) was.returnTo.focus({ preventScroll: true });
}

/** `data-ask` for an element that stands for a selection. */
export function askAttr(sound: string, target: RequestTarget, label: string): { 'data-ask': string } {
  return { 'data-ask': JSON.stringify({ sound, target, label }) };
}

/** The label a selection gets: the item, then the target in words. */
export function askLabel(sound: string, target: RequestTarget): string {
  return target.kind === 'item' ? sound : `${sound} · ${targetWords(target)}`;
}

function specOf(el: Element | null): AskSpec | null {
  const host = el?.closest('[data-ask]');
  if (!host) return null;
  try {
    const v = JSON.parse(host.getAttribute('data-ask')!) as { sound: string; target: RequestTarget; label: string };
    return { ...v, anchor: () => host.getBoundingClientRect() };
  } catch {
    return null;
  }
}

// ---- sources: a page's own selection (a region on a lens, bars on a ruler) --------------------------------------------------

interface Source { id: symbol; get: { current: () => AskSpec | null }; prio: number }
const sources: Source[] = [];

/** Register the page's selection while the caller is mounted; the latest, highest-priority source with a selection wins. */
export function useAskSource(get: () => AskSpec | null, prio = 1): void {
  const ref = useRef(get);
  ref.current = get;
  useEffect(() => {
    const s: Source = { id: Symbol('ask'), get: ref, prio };
    sources.push(s);
    return () => { sources.splice(sources.indexOf(s), 1); };
  }, [prio]);
}

function fromSources(): AskSpec | null {
  for (const s of [...sources].sort((a, b) => b.prio - a.prio)) {
    const spec = s.get.current();
    if (spec) return spec;
  }
  return null;
}

/** R: the focused element's selection, else the page's, else the focused item. Returns whether the composer opened. */
export function askHere(focus: Focus | null): boolean {
  const spec = specOf(document.activeElement) ?? fromSources() ?? (focus && focus.kind !== 'set' ? itemSpec(focus.id) : null);
  if (!spec) return false;
  openAsk(spec);
  return true;
}

/** The whole item as a selection, anchored to its library row or card when there is one. */
export function itemSpec(id: string, anchor?: () => DOMRect | null): AskSpec {
  return { sound: id, target: { kind: 'item' }, label: id, anchor: anchor ?? (() => document.querySelector(`[data-ask-item="${id}"]`)?.getBoundingClientRect() ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement.getBoundingClientRect() : null)) };
}

// ---- the context menu ---------------------------------------------------------------------------------------------------------

function ContextAsk({ focus }: { focus: Focus | null }) {
  const [at, setAt] = useState<{ x: number; y: number; spec: AskSpec } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const on = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      let spec = specOf(t);
      if (!spec && t?.closest('[data-ask-surface]')) spec = fromSources();
      if (!spec) return;
      e.preventDefault();
      const rect = { x: e.clientX, y: e.clientY };
      setAt({ ...rect, spec: { ...spec, anchor: () => new DOMRect(rect.x, rect.y, 1, 1) } });
    };
    document.addEventListener('contextmenu', on);
    return () => document.removeEventListener('contextmenu', on);
  }, [focus]);
  useEffect(() => { if (at) btn.current?.focus({ preventScroll: true }); }, [at]);
  useEffect(() => {
    if (!at) return;
    const off = (e: Event) => { if (e instanceof KeyboardEvent && e.key !== 'Escape') return; setAt(null); };
    document.addEventListener('keydown', off);
    document.addEventListener('scroll', off, true);
    return () => { document.removeEventListener('keydown', off); document.removeEventListener('scroll', off, true); };
  }, [at]);
  if (!at) return null;
  return (
    <div className="ctx-menu" role="menu" aria-label="Selection actions" style={{ left: Math.min(at.x, window.innerWidth - 220), top: Math.min(at.y, window.innerHeight - 60) }} data-testid="ctx-menu">
      <button ref={btn} type="button" role="menuitem" className="ctx-item" data-testid="ctx-ask" onClick={() => { const s = at.spec; setAt(null); openAsk(s); }}>
        <Spark size={12} />Ask for changes <Kbd>R</Kbd>
      </button>
    </div>
  );
}

// ---- the composer ---------------------------------------------------------------------------------------------------------------

/** What the card knows about the selection: the failing check inside it, and the item's moment. */
function contextFor(store: Store, spec: AskSpec): { check: string | null; moment: string | null } {
  const info = store.summary(spec.sound)?.info;
  let check: string | null = null;
  const issues = info && !info.pass ? info.issues ?? [] : [];
  const t = spec.target;
  if (t.kind === 'range') {
    // the page's own measurement of a short sound knows where each failing check is; the card's issues are the fallback
    const doc0 = store.doc(spec.sound);
    // (a sound whose card has not come yet is measured too: a long one comes back pending from the worker)
    const dur = store.summary(spec.sound)?.info?.duration;
    if (doc0 && (dur === undefined || dur <= 2.5)) {
      try {
        const m = store.measure(doc0);
        if (!m.pending) for (const c of m.checks) if (!c.pass && !check && c.ranges.some((r) => r.to >= t.start - 0.02 && r.from <= t.end + 0.02)) check = `${c.name} check: ${c.value}`;
      } catch { /* the card's issues stand */ }
    }
    if (!check) {
      const hit = issues.find((i) => i.at !== undefined && i.at >= t.start - 0.02 && i.at <= t.end + 0.02);
      if (hit) check = `${hit.name} check: ${hit.value}`;
    }
  } else if (t.kind === 'item' && issues[0]) check = `${issues[0].name} check: ${issues[0].value}`;
  const doc = store.doc(spec.sound);
  const moment = doc ? momentOf(doc, store.sets)?.text ?? null : null;
  return { check, moment };
}

function Composer({ store, spec }: { store: Store; spec: Open }) {
  const toast = useToast();
  const ctx = useMemo(() => contextFor(store, spec), [store, spec]);
  const [note, setNote] = useState('');
  const [drop, setDrop] = useState<{ check: boolean; moment: boolean }>({ check: false, moment: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean; arrow: number }>({ left: 16, top: 80, above: false, arrow: 24 });

  useEffect(() => { area.current?.focus({ preventScroll: true }); }, []);
  // Esc cancels even when focus has gone (a removed chip held it)
  useEffect(() => {
    const on = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); closeAsk(); } };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, []);
  useLayoutEffect(() => {
    const r = spec.anchor?.() ?? null;
    const w = 380, h = box.current?.offsetHeight ?? 220;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (!r) { setPos({ left: Math.max(8, (vw - w) / 2), top: 72, above: false, arrow: -1 }); return; }
    const left = Math.max(8, Math.min(vw - w - 8, r.left + r.width / 2 - 56));
    const below = r.bottom + 10 + h <= vh - 8;
    setPos({ left, top: below ? r.bottom + 10 : Math.max(8, r.top - 10 - h), above: !below, arrow: Math.max(12, Math.min(w - 28, r.left + r.width / 2 - left - 6)) });
  }, [spec]);

  const attached = [!drop.check && ctx.check ? ctx.check : null, !drop.moment && ctx.moment ? `moment: “${ctx.moment}”` : null].filter((x): x is string => !!x);
  const send = async (): Promise<void> => {
    const text = note.trim();
    if (!text || busy) return;
    setBusy(true);
    const r = await store.request({ action: 'request', kind: 'change', sound: spec.sound, note: attached.length ? `${text} [attached: ${attached.join('; ')}]` : text, target: spec.target });
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? 'The request was refused.'); return; }
    toast(`Sent to the agent: “${text}” on ${spec.sound}`);
    closeAsk();
  };
  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void send(); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeAsk(); return; }
    if (e.key === 'Tab' && box.current) {
      const f = [...box.current.querySelectorAll<HTMLElement>('textarea, button:not(:disabled)')];
      if (!f.length) return;
      const i = f.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === f.length - 1 ? 0 : i + 1);
      e.preventDefault();
      f[next]!.focus();
    }
  };
  return (
    <div ref={box} className={`composer${pos.above ? ' above' : ''}`} role="dialog" aria-label="Ask for changes" aria-modal="false" data-testid="composer" data-target={spec.target.kind} style={{ left: pos.left, top: pos.top }} onKeyDown={onKey}>
      {pos.arrow >= 0 && <span className="composer-arrow" style={{ left: pos.arrow }} aria-hidden />}
      <div className="composer-head"><Spark size={12} /><b>Ask for changes</b></div>
      <label htmlFor="composer-note" className="sr-only">What should change</label>
      <textarea id="composer-note" ref={area} rows={3} value={note} onChange={(e) => { setNote(e.target.value); setErr(null); }} placeholder={`What should change${spec.target.kind === 'item' ? '' : ` at ${targetWords(spec.target)}`}?`} data-testid="composer-note" />
      <div className="composer-chips" data-testid="composer-chips">
        <Chip tone="ember" title="The selection the agent gets" testId="chip-selection"><span className="mono">{spec.label}</span></Chip>
        {ctx.check && !drop.check && <Chip onRemove={() => { setDrop((d) => ({ ...d, check: true })); area.current?.focus({ preventScroll: true }); }} title="The failing check inside the selection" testId="chip-check"><span aria-hidden>! </span>{ctx.check} attached</Chip>}
        {ctx.moment && !drop.moment && <Chip onRemove={() => { setDrop((d) => ({ ...d, moment: true })); area.current?.focus({ preventScroll: true }); }} title="The moment in the game this is for" testId="chip-moment">moment: {ctx.moment}</Chip>}
      </div>
      {err && <p className="composer-err small" role="alert" data-testid="composer-error">{err}</p>}
      <div className="composer-foot">
        <span className="dim small composer-hint">The agent gets the selection, the numbers and the check with your note.</span>
        <Button onClick={() => closeAsk()} testId="composer-cancel">Cancel <Kbd>Esc</Kbd></Button>
        <Button kind="agent" disabled={!note.trim() || busy} onClick={() => void send()} testId="composer-send">Send <Kbd>⌘↵</Kbd></Button>
      </div>
    </div>
  );
}

/** Mounted once in the shell: the composer when one is open, and the context menu. */
export function AskHost({ store, focus }: { store: Store; focus: Focus | null }) {
  const open = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => current);
  return (
    <>
      <ContextAsk focus={focus} />
      {open && <Composer key={`${open.sound}|${JSON.stringify(open.target)}`} store={store} spec={open} />}
    </>
  );
}
