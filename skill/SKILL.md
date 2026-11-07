---
name: soundclaw
description: Make sound effects with SoundClaw, a workbench driven by commands through its MCP tools (project, run, history, changes, render, view, describe, check, measure, normalize, import, sample, export, request, work, await_requests) or the soundclaw CLI, while a person listens, approves and asks for changes in the browser. Use when asked to create, change or export game sound effects, or to work through a person's change requests on sounds.
---

# SoundClaw

You make sounds by writing commands. A sound is a small document of parameters, rendered the same
way every time; every command goes on a history tape with its author, so what you did and what
the person did can be read back. You cannot hear, so you have ears: every result ends with numbers
for each sound it touched (samples, peak, rms, a hash, and a one-line check summary), `view` shows
a picture, `describe` puts the numbers in words, `check` says what fails and where. **A person
listens** in the dashboard, which plays exactly the samples you rendered, and tells you what to
change through requests.

Make sounds with the **classic voice** (`voice=classic`: sfxr's 25 parameters) or the **layered
voice** (`voice=layered`: up to 8 layers; see *Layered sounds*). The plain sine tone
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
- Ids keep their case and use `A-Z a-z 0-9 _ -`; two ids that differ only in case are one id too many. Sample names are the same.
- `render <sound>` gives the numbers again; `export` writes `wav` (16-bit PCM, 44,100 Hz, mono; stereo for a layered sound with a panned layer),
  `patch` (sfxr text) or `csv` (synth.csv: classic sounds only) to `<project>/exports/` or `out`; `import` reads an
  sfxr csv or patch.
- The same document always renders the same hash, on every machine. If a number surprises you,
  trust the numbers, not your expectation of the sound.

## Layered sounds

**Classic or layered?** Use the classic voice for a blip, a coin, a laser, a jump: one sfxr voice,
exportable as a `synth.csv` row for an engine that reads them, and quick to explore with `random`
and `mutate`. Use a **layered** sound when it needs a body and a top, or sound sources sfxr does not
have: impacts, doors, footsteps, UI clicks, magic, plucked and bell tones, a recorded sample. A layered
sound exports as a WAV only (said by `export`). Keep a classic sound classic with `sound classic <id> on`
(it then refuses `layer-up`); `sound layer-up <id>` turns a classic one into layer 1 of a layered one, same samples.

```
sound new impact voice=layered seed=4
layer add impact osc wave=sine freq=140 dur=0.5 gain=0.9     # sources: classic osc fm ks sample
env impact 1.freq "0:140 0.25:42@exp"                         # an envelope replaces a fixed value
env impact 1.amp adsr(0.002,0.28,0,0)                         # writes breakpoints
layer add impact osc wave=brown dur=0.2 filter=lp cutoff=2500 gain=0.8
env impact 2.cutoff "0:5000 0.15:300@exp"
layer add impact osc wave=square freq=3200 dur=0.012 gain=0.3
fx add impact reverb size=0.25 mix=0.12                       # no layer= : the master chain
layer mute impact 3; layer solo impact 1 on; layer move impact 3 to=1
sound new door voice=layered preset=door seed=2               # recipes: footstep ui-click door magic
```

- **The impact recipe** (a low sine thump that falls in pitch, a short burst of low-passed noise, a
  few-millisecond click): thump `osc sine freq≈140 → 42 @exp, dur 0.5`, amplitude `adsr(0.002,0.28,0,0)`;
  noise `osc brown` (or white) with `filter=lp` whose `cutoff` envelope falls `5000 → 300 @exp` over 0.15 s and
  an amplitude that decays in 0.18 s; click `osc square freq≈3200 dur 0.012`. Add a soft `distort` and a short
  `reverb` on the master chain; then raise `sound set <id> gain=` until `loudness` passes (distortion before the
  level holds the peak down). docs/examples/layered-demo.txt has this and two more that pass every check.
- Order: source → filter → amplitude envelope → effects (list order) → gain → pan; then sum → master gain → master
  effects; export adds a limiter at the style's true-peak ceiling. Without an amplitude envelope a layer fades 2 ms at
  both ends; with one, make it reach 0 before `dur` ends or the `tail` check will say the sound is cut.
- Envelope targets: `N.amp`, `N.<param>` (those marked in docs/commands.md), `N.fxK.<param>`, `master.fxK.<param>`. Curves
  are for the segment arriving at a point: `lin exp hold ease`. A fixed value set later removes the envelope.
- Any layer off centre in `pan` makes the sound **stereo**; the checks count both channels and `describe` says stereo.
- `sample import <project> <file.wav> as=<name>` (CLI `soundclaw sample import …`, MCP `sample`) before a `sample` layer;
  a batch naming a missing sample is refused. A sample layer with no envelope and no `start`/`end` plays the file as it is (no fade,
  not cut), so `measure` of it equals the file. A 48 or 96 kHz file is converted with a windowed sinc (the import says so) and keeps
  its loudness. A stereo file stays stereo as two layers: `layer add <id> sample sample=<name> side=left pan=-1` and `… side=right pan=1`.
- `view <sound> layers` shows each layer's waveform and spectrogram with offsets: use it to see which layer makes a
  problem (a late click, a layer that is too long); `layer mute`/`solo` then `check` finds out. The `harsh` check flags
  sustained 2–5 kHz energy (default above −20 dBFS for 80 ms; `harshLimitDb`/`harshMinMs` in the project style): lower
  that layer's `gain`, or add `filter=lp` to it.
- A person edits layers, envelopes and effects in the dashboard as `human:<name>` (`layer set`, `env`, `fx …`): read
  `changes` before editing a sound they touched, as with classic sounds.

## Sets, families and beds

Use these instead of making sounds one at a time whenever a game plays the same kind of sound again and again.

- **A sound that repeats (footsteps, UI clicks, impacts, voice barks): make a set.** One good source, then
  `set new footsteps from=step count=6 target=-20 spread="1.freq±12% 2.cutoff±20% *.gain±20%"`: six seeded variants that are
  each a real sound (`footsteps_1` …), matched to the target loudness by gain (the result is on the history as `sound set … gain=`
  commands). Name the parameters in `spread` as `sound set` / `layer set` do: a classic sound `freq±0.04 decay±0.1`; a layered
  sound `N.<param>`, `*.<param>`, `N.amp`, `N.fxK.<param>`, `gain`; `%` is relative. A pitch driven by an envelope moves as a whole.
  `view <set> set` shows the members and the distance matrix; `check <set>` runs **set-spread**: members must be neither too
  alike (under 1 dB apart; widen the spread) nor too different (over 20 dB; narrow it), and within ±1 LU of the target (a member's own `loudness=` replaces the target for that member). Fix a
  member with ordinary commands; `set regen <set> seed=<n>` throws the generated members away and makes them again from the source
  as it is now (so edit the source first); `set add` / `set remove` / `set retarget` change the membership and the target.
  A classic member is quieted by its `volume`; if the target needs more than volume 1 allows, the run says how many LU it falls
  short and `sound layer-up <id>` makes it layered (same samples) so its gain can go to 4.
- **The same sound at several distances: `family <sound> near|far|muffled`.** A copy by documented rules (far is 9 LU quieter,
  darker and wetter; muffled is low-passed behind a wall; near is a little drier and louder). It is matched to the source's
  loudness plus the rule's offset, and `check` holds it to the style target plus that offset, so a far sound is not "too quiet".
  It is a copy: change the source and the variant does not follow; make it again under another name.
- **Ambience that runs for ever: a bed.** `sound new rain voice=layered preset=rain` (also `wind`, `fire`, `crowd`) is a looping
  layered sound; or loop any layered sound with `sound loop <id> <seconds> [fade=<s>]`. The seam is made
  when it renders (the end is crossfaded over the start), `sound loop` lengthens the `dur` of every osc, fm and ks layer that is shorter than length + fade (0.1 to 120 s) and says which. `view <id> loop`
  shows the seam, and the click check judges the seam (a jump, or a step in level) instead of the first and last sample. For a
  loop that must be exact, export WAV; OGG is lossy at the seam. A tonal loop should hold a whole number of cycles; noise needs nothing.
- **Handing over to a game:** `export <project> --all --format ogg --to <dir>` (or `--set <set>`) writes the files and a
  `manifest.json` (id, file, duration, loudness, channels, loop points, set); `--pack` keeps one flat folder and puts the sounds
  marked classic in a single `synth.csv`.
- **Bringing sounds from other tools:** `import <project> jsfxr "<base58 or sfxr.me URL or JSON>" --id zap`, `import <project> bfxr
  "<settings string>" --id zap`; several in a file, one `<id> <string>` per line. Every row is reported **exact** or **approximated**
  with the loss named (Bfxr's compression and harmonics, its extra waves): read it and tell the person what changed.
- **Listening in a batch:** the dashboard's **Audition** page (`#/audition`, or `#/audition/<set>`) shows every sound as a compact
  card with the check badge; the person goes through them with the keyboard (arrows, space, `a` approves, `r` asks for changes) and
  their approvals and requests reach you through `await` as ever. A set has its own page (`#/set/<id>`).

## Loudness classes: one target does not fit a whole game

A UI tick is not as loud as an explosion (a game's sounds span about −8 to −49 LUFS), so **give every sound a class** and the `loudness` check
holds it to that class: `sound set tick class=ui` (`ui` −28 ±3, `foley` −22 ±2, `impact` −14 ±2, `ambience` −26 ±3, `voice` −20 ±2,
`music-sting` −16 ±2; a sound with none is `standard`, −16 ±1; the project style can add or change classes). `loudness=<LUFS>` is a
target for one sound; a set takes a class too (`set new … class=foley`, `set class <set> <name>`). Recipes start their sounds in the
class they are made for. `check` and `measure` say which class applied.

- **Bring sounds to their level with `normalize <project> <id|set>... [<class> | target=<LUFS>]`**, not by trial and error: it writes the
  gain (layered: `gain` up to 4, then `out`, the output level in dB after the master chain, up to +36 dB; a target out of reach is an error that
  names the sound and writes nothing. A classic sound's `volume` stops at 1 or where it would clip, and the warning says how far short; `sound layer-up` lets gain go to 4).
  `measure` of a classic sound is taken from its exported WAV (`trunc(s * 32000)`), so it agrees with the file.
- **Loud and not clipping: put dynamics in the chain, where the checks see them.** `fx add <id> compress threshold=-20 ratio=4`
  and `fx add <id> limit ceiling=-1` (on the master chain, or `layer=<n>`), then raise `gain`. The checks measure the sound after
  the master chain; the export limiter only guards the true-peak ceiling and never makes anything louder. When `check` prints a
  **binding rule** (harsh against loudness: lower the 2–5 kHz energy first, then raise gain; clip against loudness: limit first),
  fix them in that order.
- **Many hits in one layer: `bursts(...)`.** A sound has 8 layers at most; rain drops, a ratchet or a clock are one layer with
  `env <id> 1.amp bursts(times=0.1,0.3,0.55 attack=0.002 decay=0.05 level=1)` or `bursts(count=12 over=2 jitter=0.5 level=0.4..1 seed=7)`; `level=1,0.6,0.3` after `times=` gives each hit its own level.
- **Decays: end the amplitude envelope at 0 with `@exp`** (`0:0 0.002:1 2.6:0@exp`): it is 60 dB down at its end, which is what `tail`
  asks for; `sound set <id> duration=auto` then ends the sound where it died away, inside a layer's source too.
- **Scripts: `measure <project> [ids...] --json` measures many sounds in one process** (starting a process per sound costs about half a second each):
  `{pass, sounds: [{id, class, numbers, checks, binding}], sets}`. `check`, `describe` and `render` take `--json` too.
- Manage sounds with commands, not files: `sound copy <id> <new>`, `sound rename <id> <new>` (sets that name it follow),
  `sound remove <id> [--from-sets]`; all undoable. Ids keep their case (`Door_01`) and are unique ignoring case. A set's members can be
  named: `set new … names="step_{n}"` or `as=a,b,c`. `sample import <project> <folder>` brings in every WAV in a folder.
- A long script: `import … --quiet` prints only the warnings and one summary line; `--classic` marks the imported sounds classic.

## Listening with numbers and pictures

- Start with `check` (CLI: `soundclaw check <project> <sound-or-set>`): six checks (with `harsh`) per sound, `set-spread` per set: clip, loudness (target from the
  sound's loudness class, default -16 LUFS ±1, so `normalize` is usually the fix), dc, click (a jump at the first
  or last sample: use `attack` > 0 and let `decay` reach zero), tail (silence padding, or a sound cut
  off while still loud: a `minFreq` cut or a short decay), harsh (sustained 2–5 kHz energy). It lists the exact time ranges.
- `view <sound> spec` shows brightness, pitch motion and noise; `wave` the shape and the clipping;
  `pitch` the note it actually sounds (slides, vibrato); `layers` (layered sounds) each layer on its own; `compare <sound> other=<sound>` stacks two
  and shows the difference with distance numbers (use it for "more like that one" and to see what a
  `mutate` changed). The image is a PNG; the tool also prints the numbers.
- `describe <sound>` is the same measurements in plain words.
- A request's `work done` is refused while the sound's checks fail, and, for a sound in a set of two or more, while the set's `set-spread` fails; fix it, then finish.

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
