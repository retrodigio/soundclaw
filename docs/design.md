# Design

SoundClaw is a sound workbench with two kinds of user. An **agent** drives it by text commands,
through a command line or an MCP server. **People** listen, watch and edit in a browser. Both work
on the same project folder through one writer.

The central problem: **the agent cannot hear.** SoundClaw therefore turns a sound into things an
agent can read and check (today: its length, peak, rms and a hash of its samples, printed after
every command), and keeps a person's ears as the final judge: the dashboard plays everything, and
listening feedback comes back as requests.

## The parts

```
 agent ──CLI──┐                          ┌── browser (dashboard)
 agent ──MCP──┤                          │      renders with core, plays with Web Audio
              ▼                          │
        soundclaw serve ── one Node process: MCP (stdio, HTTP), HTTP, WebSocket
              │
         the Writer (a queue) ── core: commands, history, renderer, WAV
              │
        the project folder: history.jsonl · requests.jsonl · sounds/ · .cache/ · exports/
```

- **core** is pure TypeScript over plain data and `Float32Array`: no DOM, no Node APIs. The same
  code renders offline in Node and live in the browser.
- **server** owns the project folder. One `Writer` applies every change in the order it arrives.
- **cli** is a thin layer. While a server runs, commands that write are sent to it.
- **ui** is a React page that receives the sounds as documents over a WebSocket and renders them
  itself.

## Documents and the history

A project's source of truth is its **history tape**, `history.jsonl`: one line per command, with a
sequence number, an author (`agent:<name>` or `human:<name>`), a time, an undo **group** and the
command in its normal form. A batch is one group. The sounds are the tape replayed.

- **Atomic batches.** A batch is parsed, then applied to a copy of the sounds; only if every
  command fits is it appended to the tape (and the readable `sounds/<id>.sfx` rewritten). An error
  applies nothing.
- **Undo and redo are commands on the tape.** `undo group=g3` takes a group out of effect; `redo`
  takes the undo out of effect. Nothing is deleted, so the history keeps everything that happened,
  including who undid what. An undo or redo that would leave a later group without what it works
  on (undoing the group that made a sound while a later group changes it) is refused, found by
  trial replay.
- **Authors.** A page can only write as `human:<name>`; the MCP tools write as `agent:claude`; the
  CLI takes `--by`. An agent that wants to know what a person did reads the history.
- **Text on disk.** Everything is plain text and git-friendly. The history is append-only.

The only document today is a **sound** with a placeholder voice, a sine tone with `frequency`,
`duration` and `volume`. The folder already has places (`instruments/`, `songs/`, `sets/`) for the
documents the fuller tool will add.

## Rendering

`renderSound` produces 44,100 Hz mono samples. It is deterministic by construction: fixed
operation order, no clock, no random numbers, and a sine made of `+ - * /` only (a Taylor
polynomial on a folded phase), because those are exactly specified by IEEE-754 where `Math.sin`
is not. So a sound renders to the same bits in Node and in any browser; a test renders the same
document in Node and in Chromium and compares every byte, and golden hashes pin the output.

A **content-hash render cache** (`server/src/cache.ts`) keeps samples under the SHA-256 of the
document's audio-relevant text plus the renderer's version; it lives in memory and in
`.cache/renders/` (ignored by git). A status mark does not change the key.

**Export** is a 16-bit PCM WAV, mono, 44,100 Hz, rendered through the cache.

## The server

`soundclaw serve --project <folder>` is one process: MCP on stdin/stdout for the agent, an HTTP
and WebSocket server on `127.0.0.1` for the dashboard (and MCP over HTTP at `/mcp`).

- **Token and lock.** Each start makes a random token, required by every route but the page's
  scripts. The folder's lock file holds the pid and URL (never the token); the token is in a
  private file outside the project, which the CLI reads to find the server. A second server on the
  same folder is refused.
- **Single writer.** HTTP, WebSocket, MCP and forwarded CLI commands all go through
  `writer.enqueue`.
- **Live view.** Every applied batch is broadcast with its tape entries and the sounds as they now
  stand. The page keeps a copy and re-renders what changed.

## Requests, await and presence

People talk to the agent through **requests**. A request is a record in `requests.jsonl`
(append-only, each record checked against the state before it is written):

```
open ──claim──▶ claimed ──done──▶ done
 ▲                │  ▲ progress
 │                └──┴──blocked──▶ blocked ──reply──▶ open
 └── cancel ──▶ cancelled
```

"Ask for changes" on a card writes the request and a `sound mark <id> rejected "<note>"` on the
history by the same person; "Approve" writes `sound mark <id> approved`. The agent learns of them
by waiting: the server keeps an in-memory event log with a cursor, and `soundclaw await` (or the
MCP `await_requests`) returns as soon as an event after the cursor arrives, then **exits**; the
exit is what wakes an agent that ran it in the background. A `seen` record notes that an agent
was handed a request, so a card can say "seen by agent:claude". The server also knows who is
listening (open waits, agents that called a tool lately), and a card says plainly when nobody is.

## Not yet

The real synth voices, the views that let an agent "hear" (waveform and spectrogram images,
loudness, checks), instruments, songs and sets, the editors in the dashboard, more export formats,
and a headless worker that takes requests with no agent session.
