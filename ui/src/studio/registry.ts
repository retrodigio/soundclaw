// The action registry: every action the UI can do has an id, a label, a group and (maybe) a
// shortcut. The palette lists them, the `?` sheet is built from them, and the one keyboard
// handler runs them. Shortcuts never fire while focus is in a text field, except Esc and ⌘K.

import { useEffect, useRef, useSyncExternalStore } from 'react';

export interface Action {
  id: string;
  label: string;
  group: string;
  /** What the keycaps show, space separated: "⌘ K", "⌥ 1", "⇧ ⌘ Z". */
  shortcut?: string;
  /** The key that runs it from anywhere: "mod+k", "alt+1", "space", "?", "mod+shift+z". Absent: palette only, or `local` (a key the focused list handles itself). */
  key?: string;
  /** The key is handled by a focused part of the page (the library's ↑↓ and Enter): listed, but not bound here. */
  local?: boolean;
  /** Runs even while a text field has focus (Esc, ⌘K). */
  inText?: boolean;
  /** Not offered in the palette's list (still in the shortcut sheet). */
  noPalette?: boolean;
  enabled?: () => boolean;
  run(): void | Promise<void>;
  /** Extra words the search matches. */
  keywords?: string;
  /** A page's version of a shell action (same id): it wins while the page is open, whatever the order they registered in. */
  override?: boolean;
}

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

let actions: Action[] = [];
const subs = new Set<() => void>();
const sources = new Map<symbol, Action[]>();
let version = 0;
let recent: string[] = [];

function rebuild(): void {
  actions = [...sources.values()].flat();
  version++;
  for (const f of [...subs]) f();
}

/** Register actions for as long as the caller is mounted. Later registrations of the same id win. */
export function registerActions(list: Action[]): () => void {
  const k = Symbol('actions');
  sources.set(k, list);
  rebuild();
  return () => { sources.delete(k); rebuild(); };
}
export const allActions = (): Action[] => {
  const seen = new Map<string, Action>();
  for (const a of actions) { const prev = seen.get(a.id); if (!prev || a.override || !prev.override) seen.set(a.id, a); }
  return [...seen.values()];
};
export function useActionList(): Action[] {
  useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => version);
  return allActions();
}
/** Register actions whose closures change every render: the latest list is what runs. */
export function useActions(list: Action[]): void {
  const ref = useRef(list);
  ref.current = list;
  useEffect(() => {
    const stable: Action[] = list.map((a, i) => ({ ...a, enabled: a.enabled ? () => ref.current[i]?.enabled?.() ?? true : undefined, run: () => ref.current[i]!.run() }));
    return registerActions(stable);
    // the set of ids and labels is what registers; the closures are read through the ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.map((a) => `${a.id}|${a.label}|${a.shortcut ?? ''}|${a.key ?? ''}`).join('\n')]);
}

export function noteRecent(id: string): void {
  recent = [id, ...recent.filter((x) => x !== id)].slice(0, 8);
}
export const recentIds = (): string[] => recent;

/** The canonical key of a keyboard event: modifiers in a fixed order, then the key ("mod+shift+z", "alt+1", "?", "space"). */
export function keyOf(e: KeyboardEvent): string {
  let k = e.key;
  // ⌥ changes the character on a Mac (⌥1 is ¡): read the physical key instead
  const m = /^(?:Digit|Key)(.)$/.exec(e.code);
  if (e.altKey && m) k = m[1]!;
  k = k === ' ' ? 'space' : k.length === 1 ? k.toLowerCase() : k.toLowerCase();
  const mods = [e.metaKey || e.ctrlKey ? 'mod' : '', e.altKey ? 'alt' : '', e.shiftKey && !(k === '?' || (k.length === 1 && !/[a-z0-9]/.test(k))) ? 'shift' : ''].filter(Boolean);
  return [...mods, k].join('+');
}

export function inTextField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT') return !['checkbox', 'radio', 'button', 'range'].includes((el as HTMLInputElement).type);
  return false;
}

/** Enter activates a focused control, and Space a focused slider, tab, switch or checkbox; Space plays even from a button. */
function onControl(t: EventTarget | null, key: string): boolean {
  const el = t as HTMLElement | null;
  if (key === 'space') return !!el?.closest?.('[role="slider"], [role="tab"], [role="switch"], [role="radio"], [role="separator"], [role="option"], input[type="checkbox"], input[type="radio"], input[type="range"], summary');
  return !!el?.closest?.('button, a[href], [role="slider"], [role="tab"], [role="switch"], [role="radio"], [role="separator"], summary, [role="menuitem"]');
}

let modalOpen = (): boolean => false;
export function setModalProbe(f: () => boolean): void { modalOpen = f; }

/** Handle a key press: run the action bound to it, if any. Returns whether one ran. */
export function dispatchKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  const key = keyOf(e);
  const text = inTextField(e.target);
  const hit = allActions().find((a) => a.key === key && !a.local && (!a.enabled || a.enabled()));
  if (!hit) return false;
  if (text && !hit.inText) return false;
  if (modalOpen() && !hit.inText) return false;
  if ((key === 'space' || key === 'enter') && onControl(e.target, key)) return false;
  e.preventDefault();
  noteRecent(hit.id);
  void hit.run();
  return true;
}

/** A shortcut as keycaps for this platform: ⌘ on a Mac, Ctrl elsewhere. */
export function shortcutLabel(s: string): string {
  return MAC ? s : s.replace(/⌘/g, 'Ctrl').replace(/⌥/g, 'Alt').replace(/⇧/g, 'Shift');
}

/** Fuzzy match: every character of the query in order; contiguous and word-start matches score higher. Null: no match. */
export function fuzzy(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0, ti = 0, run = 0;
  for (const c of q) {
    const at = t.indexOf(c, ti);
    if (at < 0) return null;
    run = at === ti ? run + 1 : 0;
    score += 1 + run * 2 + (at === 0 || /[\s/_-]/.test(t[at - 1]!) ? 3 : 0) - Math.min(3, (at - ti) * 0.2);
    ti = at + 1;
  }
  return score - t.length * 0.01;
}
