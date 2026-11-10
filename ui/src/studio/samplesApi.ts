// The Samples views' data: each sample's card (numbers and a small waveform, from the server's worker thread, kept by hash for ever), the sample
// page's detail, the registered libraries and a page of library hits. Nothing here decodes audio.

import { FORMAT_BITS, decodeMeasure, matchQuery, measureFacts, parseQuery, type Query, type QueryFacts, type PcmFormat, type SampleMeasure } from '@soundclaw/core';
import type { LibraryListing, LibrarySearchReply, SampleCard, SampleDetail, SampleInfo } from '@soundclaw/server/protocol';
import type { Store } from '../store.ts';

export interface CardView { hash: string; m: SampleMeasure; peaks: { min: number[]; max: number[] } }

/** Cards fetched so far, two requests at a time, the ones asked for last first (the rows in view). */
export class SampleCardsClient {
  private readonly cards = new Map<string, CardView>();
  private readonly failed = new Set<string>();
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private active = 0;
  private readonly subs = new Set<() => void>();
  version = 0;
  private readonly token: () => string;

  constructor(token: () => string) { this.token = token; }

  get(hash: string): CardView | undefined { return this.cards.get(hash); }
  has(hash: string): boolean { return this.cards.has(hash); }

  /** Ask for a card (a no-op once it is here or on its way). */
  want(hash: string): void {
    if (this.cards.has(hash) || this.queued.has(hash) || this.failed.has(hash)) return;
    this.queued.add(hash);
    this.queue.push(hash);
    this.pump();
  }

  /** Cards asked for and not here yet. */
  get waiting(): number { return this.queue.length + this.active; }

  subscribe = (f: () => void): (() => void) => { this.subs.add(f); return () => { this.subs.delete(f); }; };
  getVersion = (): number => this.version;

  private pump(): void {
    while (this.active < 2 && this.queue.length) {
      const hash = this.queue.pop()!;
      this.active++;
      void fetch(`/api/sample-card/${hash}.json?token=${encodeURIComponent(this.token())}`)
        .then(async (r) => {
          if (!r.ok) throw new Error(String(r.status));
          const c = (await r.json()) as SampleCard;
          this.cards.set(hash, { hash, m: decodeMeasure(c.measure), peaks: c.peaks });
        })
        .catch(() => { this.failed.add(hash); })
        .finally(() => {
          this.active--;
          this.queued.delete(hash);
          this.version++;
          for (const f of [...this.subs]) f();
          this.pump();
        });
    }
  }
}

const clients = new WeakMap<Store, SampleCardsClient>();
export function cardsOf(store: Store): SampleCardsClient {
  let c = clients.get(store);
  if (!c) { c = new SampleCardsClient(() => store.token); clients.set(store, c); }
  return c;
}

async function getJson<T>(store: Store, path: string, params: Record<string, string> = {}): Promise<T> {
  const r = await fetch(`${path}?${new URLSearchParams({ token: store.token, ...params })}`);
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `${path}: ${r.status}`);
  return j;
}

export const fetchDetail = (store: Store, name: string): Promise<SampleDetail> => getJson<SampleDetail>(store, `/api/sample-detail/${encodeURIComponent(name)}.json`);
export const fetchLibraries = (store: Store): Promise<LibraryListing[]> => getJson<LibraryListing[]>(store, '/api/libraries');
export const searchLibrary = (store: Store, q: string, o: { library?: string; offset?: number; limit?: number }): Promise<LibrarySearchReply> =>
  getJson<LibrarySearchReply>(store, '/api/library/search', { q, ...(o.library ? { library: o.library } : {}), offset: String(o.offset ?? 0), limit: String(o.limit ?? 48) });

/** Copy a library file into the project as the person. */
export async function useLibraryFile(store: Store, ref: string, as?: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  try {
    const r = await fetch(`/api/library/use?token=${encodeURIComponent(store.token)}`, { method: 'POST', body: JSON.stringify({ ref, ...(as ? { as } : {}), by: store.me }) });
    const j = (await r.json()) as { items?: { name: string }[]; error?: string };
    return r.ok && j.items?.[0] ? { ok: true, name: j.items[0].name } : { ok: false, error: j.error ?? `library use failed (${r.status})` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** The numbers query of the filter field, or the reason it does not parse. */
export function parseFilter(text: string): { q: Query | null; error: string | null } {
  if (!text.trim()) return { q: null, error: null };
  try { return { q: parseQuery(text), error: null }; } catch (e) { return { q: null, error: (e as Error).message }; }
}

/** Does the query need a sample's measured numbers (not just what the list knows)? */
export const needsNumbers = (q: Query): boolean => q.terms.some((t) => !['tag', 'source', 'licence', 'name', 'loop', 'channels', 'samplerate', 'bits'].includes(t.key));

/** The facts a query tests for one project sample: the list's, and the card's when it is here. */
export function sampleFacts(x: SampleInfo, card: CardView | undefined): QueryFacts {
  return {
    ...(card ? measureFacts(card.m) : { dur: x.seconds }),
    loop: !!x.loop, channels: x.channels, samplerate: x.rate, bits: FORMAT_BITS[x.format as PcmFormat], tag: x.tags, source: x.source, licence: [x.licenceState, x.licence], name: x.name,
  };
}

/** The project samples a filter keeps, closest first when it has ranges; null for a sample whose card is not here and whose test needs numbers. */
export function filterSamples(list: readonly SampleInfo[], q: Query | null, cards: SampleCardsClient): { rows: SampleInfo[]; pending: number } {
  if (!q || (!q.terms.length && !q.words.length)) return { rows: [...list], pending: 0 };
  const numbers = needsNumbers(q);
  const hits: { x: SampleInfo; close: number }[] = [];
  let pending = 0;
  for (const x of list) {
    const card = cards.get(x.sha256);
    if (numbers && !card) { pending++; continue; }
    const r = matchQuery(q, sampleFacts(x, card), x.name, x.tags);
    if (r.match) hits.push({ x, close: r.closeness });
  }
  hits.sort((a, b) => a.close - b.close || (a.x.name < b.x.name ? -1 : 1));
  return { rows: hits.map((h) => h.x), pending };
}

/** The glyph of where a sample came from; the word goes beside it. */
export const SOURCE_GLYPH: Record<string, string> = { file: '↓', library: '▦', recorded: '●', generated: '✦', derived: 'ƒ', bounce: '⟲', 'instrument-import': '♪' };
export const SOURCE_WORD: Record<string, string> = { file: 'file', library: 'library', recorded: 'recorded', generated: 'generated', derived: 'derived', bounce: 'bounce', 'instrument-import': 'instrument' };

/** `1.20 s · −18.2 LUFS · C4`: the numbers a row shows. */
export function rowNumbers(seconds: number, card: CardView | undefined, root: string | undefined): string {
  const len = seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1);
  const parts = [`${len} s`];
  if (card && Number.isFinite(card.m.lufs)) parts.push(`${card.m.lufs.toFixed(1).replace('-', '−')} LUFS`);
  const note = root ?? (card?.m.pitched && card.m.pitch ? card.m.pitch.note : undefined);
  if (note) parts.push(note);
  return parts.join(' · ');
}
