# Command reference

Everything an agent does goes through two surfaces that do the same things: the `soundclaw` command
line and the MCP tools of `soundclaw serve`. Run `soundclaw <command> --help` for one command's
usage and `soundclaw --version` for the version.

Project folders are named anything; `*.sclaw` is the convention.

## The command language

A batch is text sent with `soundclaw run` (or the MCP `run` tool): one command per line or
separated by `;`, `#` starts a comment, words are separated by spaces, text goes in "double
quotes". A batch is **one undo group**: every command is checked against a copy of the sounds
first, and if any fails nothing is applied (not a line of history, not a file). Errors are
reported with their line and column.

Each command has a *normal form*, which is what is written on the history, so a history replays
exactly. `sound set beep frequency=880.0 volume=.4` is stored as `sound set beep frequency=880 volume=0.4`.

| Command | Does |
|---|---|
| `sound new <id>` | Make a sound. Ids are `a-z`, `0-9`, `_` and `-`, start with a letter, at most 48 characters. A new sound is a 440 Hz, 0.5 s, volume 0.5 sine tone. |
| `sound set <id> <param>=<value> ...` | Change parameters. Values outside a range are errors. |
| `sound mark <id> approved\|rejected\|draft ["note"]` | Set the sound's status. People use the dashboard's Approve and Ask for changes buttons, which write this. |
| `undo [group=<g>] [by=<author>]` | Take a group out of effect: the latest one still in effect, a named one, or an author's latest. |
| `redo [group=<undo group>] [by=<author>]` | Take back an undo: the latest undo still in effect, a named one, or an author's latest. |

`undo` and `redo` run alone, as the only command of their batch. They are refused when a later
change depends on what they would remove (undoing the batch that made a sound while a later batch
changes it): undo the later changes first.

### Parameters of a sound

The only voice for now is a placeholder sine tone, so that history, rendering, export and the
dashboard are real end to end. A fuller synth replaces it in later versions; the plumbing stays.

| Parameter | Range | Default |
|---|---|---|
| `frequency` | 20 to 20000 Hz | 440 |
| `duration` | 0.01 to 10 s | 0.5 |
| `volume` | 0 to 1 | 0.5 |

### Authors

Every history entry has an author: `agent:<name>` or `human:<name>` (letters, digits, `.`, `_`,
`-`, at most 32 characters). The CLI's `--by` takes either form; a bare name means `agent:<name>`
for `run` and `work`, and `human:<name>` for `request`, `reply` and `cancel`. The MCP tools write
as `agent:claude`. A dashboard page writes as the name in its header (`?name=ana` in the URL gives
`human:ana`).

## The project folder

```
demo.sclaw/
  project.json     format and name
  sounds/          <id>.sfx per sound: the current state, written from the history
  instruments/ songs/ sets/    homes for the documents later versions add
  history.jsonl    the command tape: every change, its author and undo group; the source of truth
  requests.jsonl   what people asked for, and how the agent answered; append-only
  exports/         WAV files (ignored by git)
  .cache/          the render cache (ignored by git)
```

The history is the source of truth; `sounds/*.sfx` are rewritten from it after every change, so
they are for reading and diffing. A hand edit to a `.sfx` file is overwritten by the next change.

## Commands

```
soundclaw new <project> [--name <name>]
soundclaw run <project> (<script> | - | -e "<commands>") [--by <author>]
soundclaw list <project>
soundclaw history <project> [--sound <id>] [--by <author>] [--limit <n, default 50>]
soundclaw render <project> <id>
soundclaw export <project> [<id>...] [--out <dir>]
soundclaw request <project> [<id> --note "<what should change>"] [--by <author>]
soundclaw reply <project> <request> "<answer>" [--by <author>]
soundclaw cancel <project> <request> ["<why>"] [--by <author>]
soundclaw work <project> list | claim [<request>] | progress [<request>] "<note>" | block [<request>] "<question>" | done [<request>] "<what changed>" [--by <agent>]
soundclaw skill install [--dest <dir> | --project <dir>]
soundclaw await <project-folder | watch-url> [--timeout <seconds>] [--since <cursor>] [--as <name>] [--json]
soundclaw serve --project <project> [--port 7418] [--no-mcp]
```

Example:

```
$ soundclaw new demo.sclaw
$ soundclaw run demo.sclaw -e 'sound new beep; sound set beep frequency=880 volume=0.4'
applied 2 commands as group g1 by agent:claude
  #1 sound new beep
  #2 sound set beep frequency=880 volume=0.4
beep: tone 880 Hz, 0.5 s, volume 0.4 → 22050 samples, peak 0.400, rms 0.283, hash f4c7b3408089
warnings: none
```

Every result ends with numbers for each sound it touched, since an agent cannot listen: samples,
peak, rms, and the first 12 digits of a hash of the samples. The same document always gives the same
hash, on every machine. The dashboard shows the same 12 digits on each card.

Exit codes: 0 done, 1 refused (an error in the commands or the project; nothing was applied), 2
usage error, 3 (`await` only) the timeout passed with nothing to report.

### While a server runs

`soundclaw serve` owns its project. Commands that write (`run`, `export`, `request`, `reply`,
`cancel`, `work`) are sent to it over HTTP, found through the project's lock file and a token file
only you can read, so they go through its single writer and a connected dashboard updates live.
If a server holds the folder and its token cannot be read, a writing command refuses rather than
write behind its back. Read-only commands (`list`, `history`, `render`) read the files.

## Requests, await and work

People ask for changes on a sound's card in the dashboard: **Ask for changes** (a note saying what
should change) writes `sound mark <id> rejected "<note>"` on the history and a request record;
**Approve** writes `sound mark <id> approved`. A request goes through these states:

```
 open ──claim──▶ claimed ──done──▶ done
  ▲                │  ▲ progress
  │                └──┴──blocked──▶ blocked ──reply──▶ open
  └── cancel (open, claimed, blocked) ──▶ cancelled
```

`seen` records that an agent was handed an open request, so the card can say "seen by
agent:claude" instead of "sent". Every record is checked against the state before it is written.

An agent hears of requests by waiting. `soundclaw await <project>` blocks until a person files,
answers or withdraws a request, or approves or rejects a sound, prints the events with the next
step and a cursor, then **exits**: its exit is what wakes an agent that ran it in the background.
Run it again with `--since <cursor>` so nothing is missed or repeated. Exit 0 with events, 3 on
timeout, 1 if no server can be reached. The MCP tool `await_requests` does the same for up to 120
seconds. While an await is open the dashboard shows an agent is listening; when there is none, a
card says so and offers a prompt to hand to an agent.

`soundclaw work` is the agent's side for a session without MCP: `list` hands over the open requests
(marking them seen), `claim` takes the next one (or a named one) and prints what is asked and the
sound as it stands, `progress` posts a note the person sees, `block` stops with one question the
person answers on the card (the request opens again), `done` finishes it with what changed.

## MCP tools

`soundclaw serve --project <folder>` speaks MCP on stdin and stdout and serves the dashboard on
`http://127.0.0.1:<port>/?token=…` (the link is printed to stderr and returned by `project`). MCP
is also served over HTTP at `/mcp` with the token as a bearer.

| Tool | Does |
|---|---|
| `project` | The sounds with their numbers, the open requests, and the watch link. |
| `run` | `commands`: a batch, as above. |
| `history` | The tape, filtered by `sound`, `by` or `last` (default 50). Includes what people did. |
| `render` | `sound`: the numbers of its render, through the cache. |
| `export` | `sounds` (default all), `out` (default `<project>/exports`): WAV files. |
| `request` | File (`sound`, `note`), `reply` (`id`, `text`) or `cancel` a request. |
| `work` | `next` (default), `progress`, `done`, `blocked`, `list`. |
| `await_requests` | Wait for people; `cursor` from the previous call. |

## HTTP API (localhost, token required)

| Path | Returns |
|---|---|
| `GET /api/state` | The snapshot the dashboard starts from: sounds, tape, requests, presence. |
| `GET /api/render/<id>.f32` | The sound's samples as the server renders them: little-endian float32. |
| `GET /api/render/<id>.wav` | The same as a 16-bit PCM WAV. |
| `GET /api/await?timeout=…&since=…&as=agent:<name>` | Long poll for events. |
| `GET /api/presence` | Who is listening. |
| `POST /api/cli` | A writing CLI command, run on the server's writer (used by the CLI itself). |
| `/ws` | The dashboard's WebSocket: batches, requests and presence out; `run` and `request` in. |
| `/mcp` | MCP over HTTP. |

The token goes as `?token=…` or `Authorization: Bearer …`. The server answers only to the host
names `127.0.0.1`, `localhost` and `[::1]`.
