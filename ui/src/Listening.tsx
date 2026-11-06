// Whether anyone will pick up a request. A request a person files is only a line in
// requests.jsonl until an agent hears of it, so a card says "sent", then "seen by <agent>", and
// when nobody is listening (or nobody has seen it for a couple of minutes) it says that plainly
// and offers a prompt to hand to an agent.

import { useEffect, useState } from 'react';
import type { WorkRequest } from '@soundclaw/core';
import type { Store } from './store.ts';
import { promptFor, shownDir } from './prompt.ts';

/** How long an open request may go unseen before the card says so (the server uses the same figure). */
export const UNSEEN_MS = 2 * 60 * 1000;

/** The time, refreshed every few seconds so "unseen for two minutes" shows up without an event. */
export function useNow(everyMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function askedAt(q: WorkRequest): number {
  const reply = q.events.filter((e) => e.type === 'reply').at(-1);
  return Date.parse(reply?.at ?? q.at);
}

/** An open request nobody has: no one is listening, or it has gone unseen too long. */
export function unattended(store: Store, q: WorkRequest, now: number): boolean {
  if (q.state !== 'open' || (q.seen ?? []).length) return false;
  const p = store.presence;
  if (!p) return false;
  return !p.listening || now - askedAt(q) > UNSEEN_MS;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The honest answer when nobody has a request: why, and a prompt to start someone on it. */
export function NoListener({ store, why }: { store: Store; why: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const dir = store.project?.dir ? shownDir(store.project.dir, store.project.home) : '<project folder>';
  const prompt = promptFor(dir);
  return (
    <div className="no-listener" data-testid="no-listener" role="status">
      <div><b>⚠ {why}</b></div>
      <div className="card-actions">
        <button onClick={() => void copy(prompt).then(setCopied)} data-testid="copy-prompt" title="Copy a prompt to paste into an agent session">Copy prompt for the agent</button>
      </div>
      {copied !== null && (
        <div className="dim" data-testid="prompt-copied">
          {copied ? 'Copied. Paste it into an agent session.' : 'Could not copy; select the prompt below.'}
          <pre className="prompt-text" data-testid="prompt-text">{prompt}</pre>
        </div>
      )}
    </div>
  );
}

/** The header's listening indicator. */
export function ListenerChip({ store }: { store: Store }) {
  const p = store.presence;
  if (!p) return null;
  const who = p.waiters.length ? p.waiters[0]!.by : p.agents[0]?.by ?? '';
  return (
    <span className={`chip listener-chip ${p.listening ? 'on' : 'off'}`} data-testid="listener-chip" data-listening={p.listening}
      title={p.listening ? 'An agent is waiting for requests or took a request recently' : 'Requests you file now wait until an agent is started on this project'}>
      {p.listening ? `● ${who} is listening` : '○ no agent is listening'}
    </span>
  );
}
