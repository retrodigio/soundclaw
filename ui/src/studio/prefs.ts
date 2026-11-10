// Per-browser choices: theme, density, panel sizes and which are collapsed, preview on select,
// the open tabs of a project. Storage may be off or full, so every access is wrapped.

import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';
export type Density = 'compact' | 'comfortable';

export interface PanelPrefs {
  libW: number; railW: number; bottomH: number;
  libOpen: boolean; railOpen: boolean; bottomOpen: boolean; inspectorOpen: boolean;
  bottomTab: 'detail' | 'mixer' | 'history';
}

export interface Prefs {
  theme: Theme | null;
  density: Density;
  panels: PanelPrefs;
  previewOnSelect: boolean;
  homeView: 'cards' | 'rows';
  libTab: 'sounds' | 'sets' | 'songs' | 'instruments' | 'samples';
  /** The Samples tab's mode. */
  samplesMode: 'project' | 'library' | 'takes';
}

export const DEFAULT_PANELS: PanelPrefs = { libW: 288, railW: 320, bottomH: 220, libOpen: true, railOpen: true, bottomOpen: true, inspectorOpen: true, bottomTab: 'detail' };
export const LIMITS = { libW: [220, 420], railW: [260, 480], bottomH: [120, 480] } as const;

export function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function write(key: string, value: string | null): void {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage may be off */ }
}
function readJson<T>(key: string, fallback: T): T {
  const s = read(key);
  if (!s) return fallback;
  try { return { ...fallback, ...(JSON.parse(s) as object) } as T; } catch { return fallback; }
}

const KEY = 'soundclaw.prefs';
const clamp = (v: number, [lo, hi]: readonly [number, number]): number => Math.min(hi, Math.max(lo, Math.round(v)));

function load(): Prefs {
  const p = readJson<Partial<Prefs>>(KEY, {});
  const theme = p.theme === 'dark' || p.theme === 'light' ? p.theme : null;
  const panels = { ...DEFAULT_PANELS, ...(p.panels ?? {}) };
  panels.libW = clamp(panels.libW, LIMITS.libW); panels.railW = clamp(panels.railW, LIMITS.railW); panels.bottomH = clamp(panels.bottomH, LIMITS.bottomH);
  return { theme, density: p.density === 'comfortable' ? 'comfortable' : 'compact', panels, previewOnSelect: p.previewOnSelect !== false, homeView: p.homeView === 'rows' ? 'rows' : 'cards', libTab: p.libTab ?? 'sounds', samplesMode: p.samplesMode === 'library' || p.samplesMode === 'takes' ? p.samplesMode : 'project' };
}

let prefs: Prefs = load();
const subs = new Set<() => void>();

export function getPrefs(): Prefs { return prefs; }
export function setPrefs(patch: Partial<Prefs> | ((p: Prefs) => Partial<Prefs>)): void {
  const next = { ...prefs, ...(typeof patch === 'function' ? patch(prefs) : patch) };
  prefs = next;
  write(KEY, JSON.stringify({ theme: next.theme, density: next.density, panels: next.panels, previewOnSelect: next.previewOnSelect, homeView: next.homeView, libTab: next.libTab, samplesMode: next.samplesMode }));
  apply();
  for (const f of [...subs]) f();
}
export function setPanels(patch: Partial<PanelPrefs>): void {
  setPrefs((p) => ({ panels: { ...p.panels, ...patch } }));
}
export function usePrefs(): Prefs {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, getPrefs);
}

/** The theme in effect: the saved choice, else the system's. */
export function effectiveTheme(): Theme {
  if (prefs.theme) return prefs.theme;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Put the theme and density on <html>. Called at start and whenever they change. */
export function apply(): void {
  if (typeof document === 'undefined') return; // a unit test has no page
  const el = document.documentElement;
  el.dataset.theme = effectiveTheme();
  el.dataset.density = prefs.density;
}

export function toggleTheme(): void { setPrefs({ theme: effectiveTheme() === 'dark' ? 'light' : 'dark' }); }
export function toggleDensity(): void { setPrefs({ density: prefs.density === 'compact' ? 'comfortable' : 'compact' }); }

/** The open tabs of a project, kept per browser. */
export function loadTabs(project: string): string[] {
  const s = read(`soundclaw.tabs.${project}`);
  try { const v = s ? (JSON.parse(s) as unknown) : []; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
}
export function saveTabs(project: string, tabs: string[]): void { write(`soundclaw.tabs.${project}`, JSON.stringify(tabs)); }

/** Sounds the agent changed that this browser has not played or opened since: the library's "new" dot. */
export function loadNew(project: string): Set<string> {
  const s = read(`soundclaw.new.${project}`);
  try { const v = s ? (JSON.parse(s) as unknown) : []; return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []); } catch { return new Set(); }
}
export function saveNew(project: string, ids: Set<string>): void { write(`soundclaw.new.${project}`, JSON.stringify([...ids].slice(0, 500))); }

apply();
if (typeof matchMedia === 'function') matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (!prefs.theme) apply(); });
