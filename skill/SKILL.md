---
name: soundclaw
description: Make sound effects with SoundClaw, a workbench driven by commands through its MCP tools (project, run, history, render, view, describe, check, import, export, request, work, await_requests) or the soundclaw CLI, while a person listens, approves and asks for changes in the browser. Use when asked to create, change or export game sound effects, or to work through a person's change requests on sounds.
---

# SoundClaw

You make sounds by writing commands. A sound is a small document of parameters, rendered the same
way every time; every command goes on a history tape with its author, so what you did and what
the person did can be read back. You cannot hear, so you have ears: every result ends with numbers
for each sound it touched (samples, peak, rms, a hash, and a one-line check summary), `view` shows
a picture, `describe` puts the numbers in words, `check` says what fails and where. **A person
listens** in the dashboard, which plays exactly the samples you rendered, and tells you what to
change through requests.

Make sounds with the **classic voice** (`voice=classic`: sfxr's 25 parameters). The plain sine tone
(`sound new <id>`) is a placeholder with `frequency`, `duration` and `volume`; it has no fade, so it
fails the tail check and cannot finish a request.

If the tools are missing, the server is not connected:
`claude mcp add soundclaw -- npx soundclaw serve --project <folder>.sclaw` (then restart Claude
Code). Without MCP, use the `soundclaw` command line, which does the same.

## Every session

1. `project` (CLI: `soundclaw list <project>`). Give the person the watch link it prints, so they can
   listen, approve, and ask for changes on each sound's card.
2. `changes` (CLI: `soundclaw changes <project> --by human`) at the start of every turn while
   someone watches, **and before you edit any sound a person has touched**. It lists what people
   changed since you last looked: the parameters before and after, the numbers before and after
   (duration, loudness, centroid, pitch) and a before/after compare picture (a PNG path). People
   edit with sliders in the dashboard, as `human:<name>`. Carry on from their edits; **never undo
   or overwrite a person's edit silently** (if you think it is wrong, say so in a reply or a
   question first). `history` shows the raw tape (`by=human:<name>` to pick one person).
3. **Keep a background wait running** on a served project, so people's requests reach you:
   `soundclaw await <project folder>` (run it in the background; it blocks, prints what people
   asked for and a cursor, then exits). When it exits, handle what it printed (`work` for a
   request, `history` for an approval or rejection mark), then **start it again with
   `--since <cursor>`**. Exit 0 means events, 3 a timeout (just start it again), 1 no server.
   With MCP, `await_requests` waits up to two minutes in the foreground instead.

## Making sounds

`run` takes commands, one per line or separated by `;`:

```
sound new zap voice=classic preset=laser seed=3     # presets: pickup laser explosion powerup hit jump blip random
sound generate zap random seed=9                    # a new patch for zap from a category (or any sound: random)
sound set zap wave=saw freq=0.6 slide=-0.3 decay=0.25 volume=0.2
sound patch zap "wave=1,freq=0.6,slide=-0.3"       # or all 25 values from sfxr text
sound mutate zap amount=0.05 as=zap2                 # a small seeded change, into a new sound
sound mark zap approved "note"       # people do this with buttons
undo                                  # run alone; also: undo group=g3, undo by=human:ana
redo
```

- A batch is **one undo group**, and any error applies **nothing**: read the error (line:column),
  fix the batch, and send it again.
- Classic parameters (all 0..1 unless noted): `wave` (square, saw, sine, noise), `attack`, `sustain`
  (0.01..1), `punch`, `decay`, `freq` (start pitch), `minFreq` (the sound ends when the pitch falls
  to it), `slide` and `deltaSlide` (-1..1), `vibratoDelay`, `vibratoDepth` (-1..1), `vibratoSpeed`,
  `changeAmount` (-1..1), `changeSpeed`, `duty`, `dutySweep` (-1..1), `repeatSpeed`, `phaserOffset`
  and `phaserSweep` (-1..1), `lowPass` (1 = off), `lowPassSweep` (-1..1), `resonance`, `highPass`,
  `highPassSweep` (-1..1), `volume`. Ranges and formulas: docs/commands.md. Tone: `frequency`
  20-20000 Hz, `duration` 0.01-10 s, `volume` 0-1.
- Ids are lowercase: `a-z`, `0-9`, `_`, `-`.
- `render <sound>` gives the numbers again; `export` writes `wav` (16-bit PCM, 44,100 Hz, mono),
  `patch` (sfxr text) or `csv` (synth.csv) to `<project>/exports/` or `out`; `import` reads an
  sfxr csv or patch.
- The same document always renders the same hash, on every machine. If a number surprises you,
  trust the numbers, not your expectation of the sound.

## Listening with numbers and pictures

- Start with `check` (CLI: `soundclaw check <project> <sound>`): clip, loudness (target from the
  project style, default -16 LUFS ±1, so `volume` is usually the fix), dc, click (a jump at the first
  or last sample: use `attack` > 0 and let `decay` reach zero), tail (silence padding, or a sound cut
  off while still loud: a `minFreq` cut or a short decay). It lists the exact time ranges.
- `view <sound> spec` shows brightness, pitch motion and noise; `wave` the shape and the clipping;
  `pitch` the note it actually sounds (slides, vibrato); `compare <sound> other=<sound>` stacks two
  and shows the difference with distance numbers (use it for "more like that one" and to see what a
  `mutate` changed). The image is a PNG; the tool also prints the numbers.
- `describe <sound>` is the same measurements in plain words.
- A request's `work done` is refused while the sound's checks fail; fix the sound, then finish.

## Requests from people

A person writes what should change on a sound's card (**Ask for changes**), clicks quick tags
(too loud, too quiet, too long, too short, too harsh, too dull, too similar to another sound,
good), or approves it. A tagged request arrives as `request r3 (beep) from human:ana [too loud, too
harsh]: "…"`; *too similar* names the other sound (`view <sound> compare <other>` shows the
distance); `good` alone is praise: nothing to change, close it with `work done`.
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
