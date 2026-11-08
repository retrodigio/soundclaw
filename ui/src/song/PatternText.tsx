// The pattern text beside the piano roll: the very text `pattern set` takes, in a mono editor with
// line numbers. Selected notes light their tokens. Typing is read again after a 300 ms pause: a
// problem is underlined with its message and nothing is written; text that means something new
// writes one `pattern set`, the command an agent would write. The caret stays where it was.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatPattern, type Pattern, type SongDoc } from '@soundclaw/core';
import { lineCol, notesAt, offsetOf, rowLines, selectedTokens, textEdit, textTokens } from './model.ts';

export const TEXT_PAUSE_MS = 300;

interface Props {
  song: SongDoc;
  pattern: Pattern;
  channel: string | null;
  /** `pattern/channel` rows the agent wrote that nobody approved. */
  agentRows: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  onSelect(keys: Set<string>): void;
  send(cmds: string[]): void;
}

type Seg = { col: number; len: number; cls: string };

const sameKeys = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((k) => b.has(k));

export function PatternText({ song, pattern, channel, agentRows, selected, onSelect, send }: Props) {
  const docText = useMemo(() => formatPattern(pattern), [pattern]);
  const [text, setText] = useState(docText);
  const [status, setStatus] = useState<'sync' | 'typing' | 'error'>('sync');
  const [errors, setErrors] = useState<{ line: number; col: number; message: string }[]>([]);
  const [stale, setStale] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const under = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seen = useRef(docText);
  const caret = useRef<{ line: number; col: number } | null>(null);
  const latest = useRef({ text, song, pattern, channel, onSelect, send, selected });
  latest.current = { text, song, pattern, channel, onSelect, send, selected };

  // the pattern changed under the text: the roll, the agent, an undo, or our own write coming back
  useEffect(() => {
    if (docText === seen.current) return;
    seen.current = docText;
    const l = latest.current;
    const mine = textEdit(l.song.id, l.pattern, l.text);
    if (mine.pattern && formatPattern(mine.pattern) === docText) { setStale(false); return; } // what the text already means: leave the person's layout alone
    const ta = area.current;
    const busy = timer.current !== null || status === 'error';
    if (ta && document.activeElement === ta && busy) { setStale(true); return; }
    if (ta && document.activeElement === ta) caret.current = lineCol(l.text, ta.selectionStart);
    setStale(false);
    setErrors([]);
    setStatus('sync');
    setText(docText);
  }, [docText, status]);
  useLayoutEffect(() => {
    const c = caret.current;
    caret.current = null;
    const ta = area.current;
    if (c && ta && document.activeElement === ta) { const o = offsetOf(text, c.line, c.col); ta.setSelectionRange(o, o); }
  }, [text]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const tokens = useMemo(() => textTokens(text), [text]);
  const lit = useMemo(() => (channel ? selectedTokens(tokens, channel, selected) : []), [tokens, channel, selected]);
  const rows = useMemo(() => rowLines(text), [text]);
  const agentLines = useMemo(() => {
    const out = new Set<number>();
    for (const [name, line] of rows) if (agentRows.has(`${pattern.name}/${name}`)) out.add(line);
    return out;
  }, [rows, agentRows, pattern.name]);

  const commit = (value: string): void => {
    timer.current = null;
    const l = latest.current;
    const r = textEdit(l.song.id, l.pattern, value);
    if (r.errors.length) { setErrors(r.errors); setStatus('error'); return; }
    setErrors([]);
    setStatus('sync');
    if (r.cmd) { seen.current = formatPattern(r.pattern!); l.send([r.cmd]); }
    pickAtCaret(value);
  };
  /** The notes under the caret (or the selected text) light up in the roll. */
  const pickAtCaret = (value: string): void => {
    const ta = area.current, l = latest.current;
    if (!ta || !l.channel || document.activeElement !== ta) return;
    const keys = notesAt(textTokens(value), l.channel, [lineCol(value, ta.selectionStart), lineCol(value, ta.selectionEnd)]);
    if (keys.size && !sameKeys(keys, l.selected)) l.onSelect(keys);
  };
  const change = (value: string): void => {
    setText(value);
    setStatus('typing');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(value), TEXT_PAUSE_MS);
  };
  const flush = (): void => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    commit(latest.current.text);
  };

  // what each line shows beneath the transparent text: lit tokens, and the underlined problem
  const lines = text.split('\n');
  const segs = useMemo(() => {
    const by = new Map<number, Seg[]>();
    const add = (line: number, s: Seg): void => { by.set(line, [...(by.get(line) ?? []), s]); };
    for (const t of lit) add(t.line, { col: t.col, len: t.len, cls: 'tok-sel' });
    for (const e of errors.slice(0, 1)) {
      const src = lines[e.line - 1] ?? '';
      const w = /\S+/.exec(src.slice(e.col - 1));
      if (e.line - 1 < lines.length) add(e.line - 1, { col: e.col - 1, len: Math.max(1, w?.[0].length ?? 1), cls: 'tok-err' });
    }
    return by;
  }, [lit, errors, lines]);

  const scroll = (): void => {
    const ta = area.current;
    if (!ta) return;
    if (under.current) { under.current.scrollTop = ta.scrollTop; under.current.scrollLeft = ta.scrollLeft; }
    if (gutter.current) gutter.current.scrollTop = ta.scrollTop;
  };
  const err = errors[0];
  return (
    <div className="ptx" data-testid="pattern-text" data-status={status} data-lit={lit.length}>
      <div className="ptx-head">
        <span className="cap">Pattern text</span>
        <span className="mono dim small">{song.id}.{pattern.name} · live</span>
        <span className="spacer" />
        <span className="ptx-state" data-testid="pattern-text-state" data-kind={status === 'error' ? 'fail' : status === 'typing' ? 'checking' : 'pass'} role="status">
          {status === 'error' ? <><span className="mono" aria-hidden>×</span> doesn’t parse</> : status === 'typing' ? <><span className="mono" aria-hidden>…</span> reading</> : <><span className="mono" aria-hidden>✓</span> parses · in sync</>}
        </span>
      </div>
      <div className="ptx-body">
        <div className="ptx-gutter mono" ref={gutter} aria-hidden>
          {lines.map((_, i) => <div key={i} className={`ptx-num${agentLines.has(i) ? ' agent' : ''}`} data-testid={`ptx-num-${i + 1}`} data-agent={agentLines.has(i) || undefined}>{i + 1}</div>)}
        </div>
        <div className="ptx-edit">
          <pre className="ptx-under mono" ref={under} aria-hidden>
            {lines.map((src, i) => {
              const ss = (segs.get(i) ?? []).sort((a, b) => a.col - b.col);
              const out: React.ReactNode[] = [];
              let at = 0;
              for (const s of ss) {
                if (s.col < at) continue;
                out.push(src.slice(at, s.col), <span key={`${i}-${s.col}-${s.cls}`} className={s.cls} data-testid={s.cls === 'tok-sel' ? 'tok-sel' : 'tok-err'}>{src.slice(s.col, s.col + s.len)}</span>);
                at = s.col + s.len;
              }
              out.push(src.slice(at));
              return <div key={i} className={`ptx-line${agentLines.has(i) ? ' agent' : ''}`}>{out.length ? out : ' '}{'\n'}</div>;
            })}
          </pre>
          <textarea ref={area} className="ptx-area mono" value={text} spellCheck={false} wrap="off" aria-label={`Pattern text of ${pattern.name}`} aria-invalid={status === 'error'} data-testid="pattern-text-area"
            onChange={(e) => change(e.target.value)} onScroll={scroll} onBlur={flush}
            onSelect={() => { if (status !== 'typing') pickAtCaret(latest.current.text); }}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') (e.target as HTMLElement).blur(); }} />
        </div>
      </div>
      <div className="ptx-foot small" role={err ? 'alert' : undefined} data-testid="pattern-text-error" data-error={!!err}>
        {err ? <span className="ptx-msg"><span className="mono" aria-hidden>×</span> line {err.line}, column {err.col}: {err.message}</span>
          : <span className="dim">Selected notes light their tokens here; typing moves them in the roll. Violet rows came from the agent, not yet approved.</span>}
        {stale && <button type="button" className="link-btn" data-testid="pattern-text-reload" onClick={() => { setStale(false); setErrors([]); setStatus('sync'); if (timer.current) { clearTimeout(timer.current); timer.current = null; } setText(docText); }}>The pattern changed elsewhere: reload it</button>}
      </div>
    </div>
  );
}
