// Inline SVG icons: no icon font, no library. Each draws with currentColor unless it says otherwise.

import type { CSSProperties } from 'react';

interface P { size?: number; className?: string; style?: CSSProperties }
const base = (size: number, w = size, h = size) => ({ width: w, height: h, 'aria-hidden': true as const, focusable: false as const, viewBox: `0 0 ${size} ${size}` });

export const Play = ({ size = 12, ...r }: P) => <svg {...base(12, size, size)} {...r}><path d="M2 1 L11 6 L2 11 Z" fill="currentColor" /></svg>;
export const Stop = ({ size = 10, ...r }: P) => <svg {...base(10, size, size)} {...r}><rect width="10" height="10" rx="1" fill="currentColor" /></svg>;
/** Record: a filled circle. */
export const Record = ({ size = 12, ...r }: P) => <svg {...base(12, size, size)} {...r}><circle cx="6" cy="6" r="4.5" fill="currentColor" /></svg>;
export const Loop = ({ size = 16, ...r }: P) => <svg width={size} height={size * 0.75} viewBox="0 0 16 12" aria-hidden {...r}><path d="M3 4 H12 L10 2 M13 8 H4 L6 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
export const Undo = ({ size = 14, ...r }: P) => <svg width={size} height={size * 0.86} viewBox="0 0 14 12" aria-hidden {...r}><path d="M4 2 L1 5 L4 8 M1 5 H9 A4 3.5 0 0 1 9 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
export const Redo = ({ size = 14, ...r }: P) => <svg width={size} height={size * 0.86} viewBox="0 0 14 12" aria-hidden {...r}><path d="M10 2 L13 5 L10 8 M13 5 H5 A4 3.5 0 0 0 5 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
export const Search = ({ size = 13, ...r }: P) => <svg {...base(14, size, size)} {...r}><circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M9.2 9.2 L13 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
/** The agent's mark: a four-pointed spark. */
export const Spark = ({ size = 13, color = 'var(--agent)', ...r }: P & { color?: string }) => <svg {...base(14, size, size)} {...r}><path d="M7 1 L8.4 5.6 L13 7 L8.4 8.4 L7 13 L5.6 8.4 L1 7 L5.6 5.6 Z" fill={color} /></svg>;
/** Yours: a person. */
export const Person = ({ size = 13, color = 'var(--you)', ...r }: P & { color?: string }) => <svg {...base(14, size, size)} {...r}><circle cx="7" cy="4.6" r="2.6" fill={color} /><path d="M2 13 C2 9.6 4.4 8.2 7 8.2 C9.6 8.2 12 9.6 12 13 Z" fill={color} /></svg>;
export const Logo = ({ size = 24, ...r }: P) => <svg {...base(36, size, size)} {...r}><rect x="1" y="1" width="34" height="34" rx="9" fill="var(--raised)" stroke="var(--line)" /><path d="M8 22 L12 14 L16 24 L20 9 L24 27 L28 16" fill="none" stroke="var(--ember)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
export const Close = ({ size = 10, ...r }: P) => <svg {...base(10, size, size)} {...r}><path d="M2 2 L8 8 M8 2 L2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>;
export const Chevron = ({ size = 10, dir = 'right', ...r }: P & { dir?: 'left' | 'right' | 'up' | 'down' }) => <svg {...base(10, size, size)} style={{ transform: `rotate(${{ right: 0, down: 90, left: 180, up: 270 }[dir]}deg)` }} {...r}><path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
export const Menu = ({ size = 14, ...r }: P) => <svg {...base(14, size, size)} {...r}><path d="M2 3.5 H12 M2 7 H12 M2 10.5 H12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;

const KIND_PATH = {
  sound: 'M2 6 H3 M4.5 3 V9 M7 1.5 V10.5 M9.5 4 V8',
  set: 'M2 2 H5 V5 H2 Z M7 2 H10 V5 H7 Z M2 7 H5 V10 H2 Z M7 7 H10 V10 H7 Z',
  song: 'M4 9.5 V2.5 L10 1.5 V8.5 M4 9.5 A1.5 1.5 0 1 1 1 9.5 A1.5 1.5 0 1 1 4 9.5',
  list: 'M2 3 H10 M2 6 H10 M2 9 H7',
  audition: 'M2 6 H4 L6 3 V9 L4 6 M8 4 Q10 6 8 8',
  session: 'M6 1.5 L7 5 L10.5 6 L7 7 L6 10.5 L5 7 L1.5 6 L5 5 Z',
  review: 'M2 6 L5 9 L10 3',
  kit: 'M2 2 H6 V6 H2 Z M7 7 H10 V10 H7 Z',
  instrument: 'M2 4 H10 V9 H2 Z M4.5 4 V9 M7.5 4 V9',
  sample: 'M1.5 6 H3 L4.5 2.5 L6.5 9.5 L8 6 H10.5',
} as const;
export type TabKind = keyof typeof KIND_PATH;
/** The icon of a kind of item (a sound, a set, a song, a page). */
export const KindIcon = ({ kind, size = 12, ...r }: P & { kind: TabKind }) => <svg {...base(12, size, size)} {...r}><path d={KIND_PATH[kind]} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
