// One sound as a card: name and status, a waveform thumbnail, a play button, its numbers, and the
// person's two answers: Approve, or Ask for changes (a note the agent receives through await).
// The requests on the sound show where they stand: sent, seen by an agent, claimed, blocked
// (answer it here), done.

import { memo, useState } from 'react';
import { CLASSIC_FIELDS, FEEDBACK_TAGS, SIMILAR_TAG, WAVE_NAMES, isStereo, layerLabel, tagsNote, type Sound, type WorkRequest } from '@soundclaw/core';
import type { SoundSummary } from '@soundclaw/server/protocol';
import { CardImages } from './CardImages.tsx';
import { NoListener, unattended, useNow } from './Listening.tsx';
import type { Store } from './store.ts';

const fmt = (n: number) => String(n);

export function RequestRow({ store, q }: { store: Store; q: WorkRequest }) {
  const [text, setText] = useState('');
  const now = useNow();
  const seen = q.seen ?? [];
  const label = q.state === 'open' ? (seen.length ? `seen by ${seen.map((x) => x.by).join(', ')}` : 'sent') : q.state === 'claimed' ? `${q.claimedBy} is working on it` : q.state;
  return (
    <div className="request" data-testid={`request-${q.id}`} data-state={q.state}>
      <div>
        <b>{q.id}</b> <span className={`chip state-${q.state}`}>{label}</span>
        {(q.tags ?? []).map((t) => <span key={t} className={`chip tag${t === 'good' ? ' good' : ''}`} data-testid={`request-tag-${q.id}`}>{t}</span>)}
        {q.other && <span className="dim" data-testid={`request-other-${q.id}`}>like {q.other}</span>}
        {(!(q.tags ?? []).length || q.note !== tagsNote(q.tags, q.other)) && <span className="dim"> “{q.note}”</span>}
        {(q.state === 'open' || q.state === 'claimed' || q.state === 'blocked') && (
          <button className="link" data-testid={`cancel-${q.id}`} onClick={() => void store.request({ action: 'cancel', id: q.id })}>withdraw</button>
        )}
      </div>
      {q.state === 'claimed' && q.latest && <div className="dim" data-testid="working">{q.latest}</div>}
      {q.state === 'done' && <div className="dim" data-testid={`done-${q.id}`}>✓ done: {q.latest}</div>}
      {q.state === 'blocked' && (
        <div className="blocked">
          <div data-testid={`question-${q.id}`}>The agent asks: “{q.question}”</div>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="your answer" data-testid={`reply-text-${q.id}`} />
          <button disabled={!text.trim()} data-testid={`reply-send-${q.id}`} onClick={() => void store.request({ action: 'reply', id: q.id, text }).then((r) => { if (r.ok) setText(''); })}>Answer</button>
        </div>
      )}
      {unattended(store, q, now) && <NoListener store={store} why={store.presence?.listening ? 'Nobody has picked this up yet.' : 'No agent is listening for requests.'} />}
    </div>
  );
}

const slug = (t: string): string => t.replace(/[^a-z]+/g, '-');

/** Listening feedback: click quick tags, add a few words, send. It reaches the agent as a request with the tags. */
export function Feedback({ store, sound }: { store: Store; sound: { id: string } }) {
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [other, setOther] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const similar = tags.includes(SIMILAR_TAG);
  const toggle = (t: string) => setTags((xs) => (xs.includes(t) ? xs.filter((x) => x !== t) : [...xs, t]));
  const others = store.index.filter((x) => x.id !== sound.id);
  const send = async () => {
    const r = await store.feedback(sound.id, tags, note, similar && other ? other : undefined);
    if (r.ok) { setTags([]); setNote(''); setOther(''); setProblem(null); } else setProblem(r.error ?? 'refused');
  };
  return (
    <div className="feedback" data-testid={`feedback-${sound.id}`}>
      <div className="tags">
        {FEEDBACK_TAGS.map((t) => (
          <button key={t} className={`tag${tags.includes(t) ? ' on' : ''}${t === 'good' ? ' good' : ''}`} aria-pressed={tags.includes(t)} data-testid={`tag-${sound.id}-${slug(t)}`} onClick={() => toggle(t)}>{t}</button>
        ))}
      </div>
      {similar && (
        <select value={other} onChange={(e) => setOther(e.target.value)} data-testid={`tag-other-${sound.id}`} aria-label="Which sound is it too similar to?">
          <option value="">which sound? (optional)</option>
          {others.map((o) => <option key={o.id} value={o.id}>{o.id}</option>)}
        </select>
      )}
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="A few words, if the tags are not enough" data-testid={`feedback-text-${sound.id}`} />
      <button disabled={!tags.length && !note.trim()} data-testid={`feedback-send-${sound.id}`} onClick={() => void send()}>Send feedback</button>
      {problem && <div className="error" data-testid={`feedback-error-${sound.id}`}>{problem}</div>}
    </div>
  );
}

export interface SoundCardProps {
  store: Store;
  sound: SoundSummary;
  /** The document, when the page has it (always in a small project; in a lean one once the sound has been opened). */
  doc: Sound | undefined;
  playing: boolean;
  plays: number;
  mine: WorkRequest[];
  /** What a request's row shows besides the request itself (who is listening). */
  presence: string;
}

/** Renders again only when something this card shows changed: the list updates often while the server works out the cards. */
export const SoundCard = memo(function SoundCard({ store, sound, doc, playing, plays, mine }: SoundCardProps) {
  const [asking, setAsking] = useState(false);
  const [feeding, setFeeding] = useState(false);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  // the numbers the list knows (the last known render), else those of the card fetched for it
  const held = store.cardOf(sound.id);
  const info = sound.info ?? held;
  const pass = info?.pass;
  const failing = info?.failing ?? [];
  const send = async () => {
    const r = await store.askForChanges(sound.id, note);
    if (r.ok) { setAsking(false); setNote(''); setProblem(null); } else setProblem(r.error ?? 'refused');
  };
  return (
    <article className="card" data-testid={`card-${sound.id}`} data-status={sound.status} data-hash={info?.hash ?? ''}>
      <header>
        <h2>{sound.id}</h2>
        <span className={`chip check-${pass === undefined ? 'pending' : pass ? 'pass' : 'fail'}`} data-testid={`check-${sound.id}`} {...(pass === undefined ? {} : { 'data-pass': pass })} data-failing={failing.join(',')} title={info?.summary ?? 'not checked yet'}>
          {pass === undefined ? '… checking' : pass ? '✓ checks pass' : `✗ ${failing.join(', ')}`}
        </span>
        <span className={`chip status-${sound.status}`} data-testid={`status-${sound.id}`}>{sound.status}</span>
      </header>
      <CardImages store={store} id={sound.id} soundKey={sound.key} />
      {!doc ? (
        <div className="params" data-testid={`params-${sound.id}`} data-voice={sound.voice} title="Edit opens the sound's editor.">
          <span className="dim">{sound.voice} · {sound.label}</span>
        </div>
      ) : doc.voice === 'tone' ? (
        <div className="params" data-testid={`params-${sound.id}`}>
          <span>{fmt(doc.frequency)} Hz</span><span>{fmt(doc.duration)} s</span><span>volume {fmt(doc.volume)}</span>
        </div>
      ) : doc.voice === 'layered' ? (
        <div className="params layered" data-testid={`params-${sound.id}`} data-voice="layered" title="A layered sound: its layers and master effects. Edit opens the layer editor.">
          {doc.layers.length === 0 && <span className="dim">no layers yet</span>}
          {doc.layers.map((l, i) => (
            <span key={l.salt} className={l.mute ? 'dim' : 'changed'} data-testid={`layer-${sound.id}-${i + 1}`}>{i + 1} {layerLabel(l)}{l.mute ? ' (muted)' : ''}{l.solo ? ' (solo)' : ''}{l.fx.length ? ` + ${l.fx.map((f) => f.kind).join(', ')}` : ''}</span>
          ))}
          {doc.master.length > 0 && <span className="changed" data-testid={`master-${sound.id}`}>master: {doc.master.map((f) => f.kind).join(', ')}</span>}
          {isStereo(doc) && <span className="changed" data-testid={`stereo-${sound.id}`}>stereo</span>}
        </div>
      ) : (
        <div className="params classic" data-testid={`params-${sound.id}`} data-voice="classic" title="The classic voice's 25 parameters; Edit opens the sliders. Changed from the default in bold.">
          {CLASSIC_FIELDS.map((f) => (
            <span key={f.name} className={doc.patch[f.name] === f.default ? 'dim' : 'changed'} data-testid={`param-${sound.id}-${f.name}`} title={f.help}>
              {f.name} {f.name === 'wave' ? WAVE_NAMES[doc.patch.wave] : fmt(doc.patch[f.name])}
            </span>
          ))}
          {doc.patch.seed !== undefined && <span className="changed" data-testid={`param-${sound.id}-seed`}>seed {doc.patch.seed}</span>}
        </div>
      )}
      <div className="dim analysis" data-testid={`numbers-${sound.id}`}>
        {info ? `${info.duration.toFixed(2)} s · ${info.lufs !== null ? info.lufs.toFixed(1) : '−∞'} LUFS · ${info.truePeakDb !== null ? info.truePeakDb.toFixed(1) : '−∞'} dBTP` : '…'}
      </div>
      <div className="dim hash" title="Hash of the rendered samples; the CLI and MCP print the same first 12 digits">samples {(info?.hash ?? '').slice(0, 12)}</div>
      <div className="card-actions">
        <button className="play" data-testid={`play-${sound.id}`} data-plays={plays} data-playing={playing} onClick={() => void store.play(sound.id)} aria-label={`${playing ? 'Stop' : 'Play'} ${sound.id}`}>
          {playing ? '■ Stop' : '▶ Play'}
        </button>
        <button data-testid={`approve-${sound.id}`} disabled={sound.status === 'approved'} onClick={() => void store.approve(sound.id)}>Approve</button>
        <button data-testid={`reject-${sound.id}`} onClick={() => setAsking(!asking)}>Ask for changes</button>
        <button data-testid={`feedback-toggle-${sound.id}`} aria-expanded={feeding} onClick={() => setFeeding(!feeding)}>Feedback</button>
        <a className="button" href={`#/sound/${sound.id}`} data-testid={`edit-${sound.id}`}>Edit</a>
      </div>
      {feeding && <Feedback store={store} sound={sound} />}
      {asking && (
        <div className="ask">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change? (e.g. softer, a little lower)" data-testid={`reject-text-${sound.id}`} rows={2} />
          <button disabled={!note.trim()} data-testid={`reject-send-${sound.id}`} onClick={() => void send()}>Send</button>
          {problem && <div className="error" data-testid={`reject-error-${sound.id}`}>{problem}</div>}
        </div>
      )}
      {mine.map((q) => <RequestRow key={q.id} store={store} q={q} />)}
    </article>
  );
}, (a, b) => a.sound === b.sound && a.doc === b.doc && a.playing === b.playing && a.plays === b.plays && a.presence === b.presence && a.store === b.store
  && a.mine.length === b.mine.length && JSON.stringify(a.mine) === JSON.stringify(b.mine));
