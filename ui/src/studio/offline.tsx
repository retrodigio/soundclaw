// Offline: the websocket to the server is lost. A banner says where the server was and how to
// start it again, counts down to the next automatic try (1, 2, 4 … 30 s) and offers Retry. Edits
// made meanwhile wait in the page's queue ("not sent") and are sent in order when the server is
// back; any it refuses are listed here with the reason, until the person dismisses them.

import { useEffect, useState } from 'react';
import type { Store } from '../store.ts';
import { Button } from './controls.tsx';

/** The project folder as the person would type it: ~/… under their home folder. */
export function projectPath(store: Store): string {
  const dir = store.project?.dir ?? '<project>';
  const home = store.project?.home;
  return home && (dir === home || dir.startsWith(home + '/')) ? `~${dir.slice(home.length)}` : dir;
}

/** The command that starts this project's server on the port the page was served from. */
export function serveCommand(store: Store): string {
  const port = typeof location !== 'undefined' ? location.port : '';
  const path = projectPath(store);
  return `soundclaw serve --project ${/\s/.test(path) ? JSON.stringify(path) : path}${port && port !== '7427' ? ` --port ${port}` : ''}`;
}

function useSecondsTo(at: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.ceil((at - now) / 1000));
}

function Countdown({ store }: { store: Store }) {
  const s = useSecondsTo(store.retryAt);
  return <span className="mono offline-count" data-testid="offline-countdown" data-seconds={s}>{store.status === 'connecting' || s === 0 ? '… trying now' : `! retrying in ${s} s`}</span>;
}

export function OfflineBanner({ store }: { store: Store }) {
  if (store.status === 'open' || (store.status === 'connecting' && !store.project)) return null;
  const host = typeof location !== 'undefined' ? location.host : '';
  const n = store.outbox.length;
  return (
    <div className="offline" role="alert" data-testid="offline">
      <span className="banner-glyph mono" aria-hidden>!</span>
      <div className="offline-body">
        <b data-testid="offline-title">Lost the SoundClaw server at {host}</b>
        <span className="banner-text">Everything you have open still plays from the local render. Your edits are kept here and sent when it comes back. The agent can't see them until then.</span>
        <code className="mono offline-cmd" data-testid="offline-command">{serveCommand(store)}</code>
        {n > 0 && (
          <details className="offline-queue" data-testid="offline-queue">
            <summary className="cap">Queued edits · not sent</summary>
            <ul>
              {store.outbox.map((q) => (
                <li key={q.id} className="offline-q" data-testid="offline-q"><span className="you-sq" aria-hidden /><span className="mono grow">{q.commands.split('\n').join(' · ')}</span><span className="dim small">not sent</span></li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <div className="offline-side">
        <Button kind="warn" onClick={() => store.retryNow()} testId="offline-retry">Retry now</Button>
        <Countdown store={store} />
        <span className="mono offline-n" data-testid="offline-queued" data-count={n}>{n === 0 ? 'no edits queued' : `${n} edit${n === 1 ? '' : 's'} queued`}</span>
      </div>
    </div>
  );
}

/** After a reconnect: the queued edits the server refused, each with its reason. */
export function RefusedBanner({ store }: { store: Store }) {
  if (!store.refused.length) return null;
  const n = store.refused.length;
  return (
    <div className="offline refused" role="alert" data-testid="refused">
      <span className="banner-glyph mono" aria-hidden>×</span>
      <div className="offline-body">
        <b>{n} queued edit{n === 1 ? ' was' : 's were'} refused by the server</b>
        <span className="banner-text">They were sent in order when the server came back{store.sentAfterReconnect > n ? `; the other ${store.sentAfterReconnect - n} landed` : ''}. Nothing else was dropped.</span>
        <ul>
          {store.refused.map((r, i) => (
            <li key={i} className="offline-q" data-testid="refused-row"><span className="mono">{r.commands.split('\n').join(' · ')}</span><span className="refused-why">× {r.reason}</span></li>
          ))}
        </ul>
      </div>
      <div className="offline-side"><Button onClick={() => store.dismissRefused()} testId="refused-dismiss">Dismiss</Button></div>
    </div>
  );
}
