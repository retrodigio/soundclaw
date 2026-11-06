---
name: soundclaw
description: Make sound effects with SoundClaw, a workbench driven by commands through its MCP tools (project, run, history, render, export, request, work, await_requests) or the soundclaw CLI, while a person listens, approves and asks for changes in the browser. Use when asked to create, change or export game sound effects, or to work through a person's change requests on sounds.
---

# SoundClaw

You make sounds by writing commands. A sound is a small document of parameters, rendered the same
way every time; every command goes on a history tape with its author, so what you did and what
the person did can be read back. You cannot hear: every result ends with numbers for each sound it
touched (samples, peak, rms, a hash of the samples). **A person listens** in the dashboard, which
plays exactly the samples you rendered, and tells you what to change through requests.

At present a sound is a placeholder sine tone with `frequency`, `duration` and `volume`; the fuller
synth arrives in later versions, and everything below stays the same.

If the tools are missing, the server is not connected:
`claude mcp add soundclaw -- npx soundclaw serve --project <folder>.sclaw` (then restart Claude
Code). Without MCP, use the `soundclaw` command line, which does the same.

## Every session

1. `project` (CLI: `soundclaw list <project>`). Give the person the watch link it prints, so they can
   listen, approve, and ask for changes on each sound's card.
2. `history` at the start of every turn while someone watches, and whenever they say they did
   something (`by=human:<name>` to pick one person). Carry on from their edits; never silently
   redo them.
3. **Keep a background wait running** on a served project, so people's requests reach you:
   `soundclaw await <project folder>` (run it in the background; it blocks, prints what people
   asked for and a cursor, then exits). When it exits, handle what it printed (`work` for a
   request, `history` for an approval or rejection mark), then **start it again with
   `--since <cursor>`**. Exit 0 means events, 3 a timeout (just start it again), 1 no server.
   With MCP, `await_requests` waits up to two minutes in the foreground instead.

## Making sounds

`run` takes commands, one per line or separated by `;`:

```
sound new beep
sound set beep frequency=880 duration=0.3 volume=0.4
sound mark beep approved "note"      # people do this with buttons
undo                                  # run alone; also: undo group=g3, undo by=human:ana
redo
```

- A batch is **one undo group**, and any error applies **nothing**: read the error (line:column),
  fix the batch, and send it again.
- Parameters: `frequency` 20-20000 Hz, `duration` 0.01-10 s, `volume` 0-1.
- Ids are lowercase: `a-z`, `0-9`, `_`, `-`.
- `render <sound>` gives the numbers again; `export` writes WAV files (16-bit PCM, 44,100 Hz,
  mono) to `<project>/exports/` or `out`.
- The same document always renders the same hash, on every machine. If a number surprises you,
  trust the numbers, not your expectation of the sound.

## Requests from people

A person writes what should change on a sound's card (**Ask for changes**), or approves it.
Take requests before anything else:

1. `work` (CLI: `soundclaw work <project> claim`): claims the next open request and shows what is
   asked, with the sound as it stands.
2. Make the change with `run`. Post `work(action="progress", text="…")` if it takes a while.
3. Finish with `work(action="done", text="<what changed>")` (CLI: `work <project> done "…"`).
4. If you cannot go on without the person, `work(action="blocked", text="<one clear question>")`
   (CLI: `work <project> block "…"`); they answer on the card and the request opens again, so
   claim it again when `await` reports the reply.

A request leaves the sound marked `rejected`; the person approves it again when it is right.
`soundclaw request <project> <sound> --note "…"` files a request yourself (for the person to see).

## House rules

- Never edit files in the project folder by hand: `history.jsonl` is the source of truth and
  `sounds/*.sfx` are rewritten from it. Everything goes through commands.
- One thing per batch when you can: a small, named change is easy for a person to undo.
- Do not run `soundclaw` commands that write while another process edits the same folder without
  a server: serve it (`soundclaw serve`) and let the commands go through it.
- Never leave servers or background waits running when you finish.

Full command reference: `commands.md` beside this file.
