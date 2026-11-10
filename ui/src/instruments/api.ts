// What the instrument page and the generation panel ask the server for.

import type { InstrumentCheck } from '@soundclaw/core';
import type { GenerationStatus } from '@soundclaw/server/protocol';
import type { Store } from '../store.ts';

export type CheckReply = InstrumentCheck & { key: string };

export async function fetchInstrumentCheck(store: Store, id: string): Promise<CheckReply> {
  const r = await fetch(`/api/instrument-check/${encodeURIComponent(id)}.json?token=${encodeURIComponent(store.token)}`);
  const j = (await r.json()) as CheckReply & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `the check failed (${r.status})`);
  return j;
}

export async function fetchGeneration(store: Store): Promise<GenerationStatus> {
  const r = await fetch(`/api/generation?token=${encodeURIComponent(store.token)}`);
  const j = (await r.json()) as GenerationStatus & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `generation status failed (${r.status})`);
  return j;
}

/** A person sets the project's generation cap (credits). The server takes it only from a human author. */
export async function setCap(store: Store, credits: number): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`/api/generation/cap?token=${encodeURIComponent(store.token)}`, { method: 'POST', body: JSON.stringify({ capCredits: credits, by: store.me }) });
  const j = (await r.json()) as { error?: string };
  return r.ok ? { ok: true } : { ok: false, error: j.error ?? `refused (${r.status})` };
}
