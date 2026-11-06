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
| `sound new <id>` | Make a sound. Ids are `a-z`, `0-9`, `_` and `-`, start with a letter, at most 48 characters. A new sound is a 440 Hz, 0.5 s, volume 0.5 sine tone (the placeholder voice). |
| `sound new <id> voice=classic [preset=<category>] [seed=<n>]` | Make a classic-voice sound: the 25 sfxr-style parameters at their defaults, or generated from a category (below). `preset=` alone means `voice=classic`. Without `seed=` the seed comes from the category and the id, and is written into the normal form. |
| `sound set <id> <param>=<value> ...` | Change parameters (those of the sound's voice, below). Values outside a range are errors. `wave=square\|saw\|sine\|noise` takes names. `seed=<n>` fixes the noise stream; `seed=auto` goes back to the hash of the values. |
| `sound patch <id> "<single-patch text>"` | Replace all 25 values from sfxr patch text: numbers in positional order (an empty field keeps the default) or `name=value` pairs, with an optional version line first (write the line break as `\n` inside the quotes). |
| `sound mutate <id> [amount=0.05] [seed=<n>] [as=<new id>]` | A small seeded change to a classic sound (also written `mutate <id> ...`): each parameter except the wave and the volume moves, with a chance of one half, by up to `amount`, kept in its range. `as=` leaves the original alone and makes a new sound. The seed used is written into the normal form. |
| `sound mark <id> approved\|rejected\|draft ["note"]` | Set the sound's status. People use the dashboard's Approve and Ask for changes buttons, which write this. |
| `undo [group=<g>] [by=<author>]` | Take a group out of effect: the latest one still in effect, a named one, or an author's latest. |
| `redo [group=<undo group>] [by=<author>]` | Take back an undo: the latest undo still in effect, a named one, or an author's latest. |

`undo` and `redo` run alone, as the only command of their batch. They are refused when a later
change depends on what they would remove (undoing the batch that made a sound while a later batch
changes it): undo the later changes first.

### Parameters of a sound

**The tone voice** is the S0 placeholder, a plain sine. It has no fade, so it always fails the `tail`
check; use the classic voice for sounds that have to be finished.

| Parameter | Range | Default |
|---|---|---|
| `frequency` | 20 to 20000 Hz | 440 |
| `duration` | 0.01 to 10 s | 0.5 |
| `volume` | 0 to 1 | 0.5 |

**The classic voice** is sfxr's synth: one oscillator at 44,100 Hz with 8x supersampling through a
three-stage envelope, pitch slide, vibrato, a one-time pitch change, duty sweep, a repeat, a phaser
and low/high-pass filters. The 25 parameters, in their stable positional order (the order of the
single-patch text and of `synth.csv` columns):

| # | Parameter | Range | Default | Meaning |
|---|---|---|---|---|
| 1 | `wave` | 0..3 | 0 | 0 square, 1 saw, 2 sine, 3 noise (the names are accepted) |
| 2 | `attack` | 0..1 | 0 | attack length `a² · 10⁵` samples, linear rise |
| 3 | `sustain` | 0.01..1 | 0.3 | sustain length `s² · 10⁵` samples |
| 4 | `punch` | 0..1 | 0 | sustain level `1 + 2 · punch · (1 − t/len)` |
| 5 | `decay` | 0..1 | 0.4 | decay length `d² · 10⁵` samples, linear fall; the sound ends after it |
| 6 | `freq` | 0..1 | 0.3 | start period `100 / (f² + 0.001)` supersamples |
| 7 | `minFreq` | 0..1 | 0 | period ceiling `100 / (m² + 0.001)`; when m > 0 and the period reaches it the sound ends |
| 8 | `slide` | -1..1 | 0 | per-sample period factor `1 − slide³ · 0.01` |
| 9 | `deltaSlide` | -1..1 | 0 | added to that factor each sample: `−dslide³ · 10⁻⁶` |
| 10 | `vibratoDelay` | 0..1 | 0 | vibrato starts after this fraction of the envelope length |
| 11 | `vibratoDepth` | -1..1 | 0 | period × `1 + sin(phase) · depth · 0.5` |
| 12 | `vibratoSpeed` | 0..1 | 0 | phase += `speed² · 0.01` per sample |
| 13 | `changeAmount` | -1..1 | 0 | one period change: × `1 − a² · 0.9` (a ≥ 0) or × `1 + a² · 10` (a < 0) |
| 14 | `changeSpeed` | 0..1 | 0 | ... after `(1 − speed)² · 20000 + 32` samples; 1 = never |
| 15 | `duty` | 0..1 | 0 | square duty `0.5 − 0.5 · duty` |
| 16 | `dutySweep` | -1..1 | 0 | duty += `−sweep · 5 · 10⁻⁵` per sample, kept in [0, 0.5] |
| 17 | `repeatSpeed` | 0..1 | 0 | restart the pitch parameters every `(1 − r)² · 20000 + 32` samples; 0 = off |
| 18 | `phaserOffset` | -1..1 | 0 | phaser delay `±offset² · 1020` samples. With no offset the delayed copy is the sample itself, so every classic sound is doubled before the volume (as in sfxr) |
| 19 | `phaserSweep` | -1..1 | 0 | delay += `±sweep²` per sample |
| 20 | `lowPass` | 0..1 | 1 | low-pass coefficient `c³ · 0.1`; 1 = bypassed |
| 21 | `lowPassSweep` | -1..1 | 0 | coefficient × `1 + sweep · 10⁻⁴` per supersample, kept in [0, 0.1] |
| 22 | `resonance` | 0..1 | 0 | low-pass damping `min(0.8, 5 / (1 + res² · 20) · (0.01 + w))` |
| 23 | `highPass` | 0..1 | 0 | high-pass coefficient `c² · 0.1` |
| 24 | `highPassSweep` | -1..1 | 0 | coefficient × `1 + sweep · 3 · 10⁻⁴` per sample, kept in [10⁻⁵, 0.1] |
| 25 | `volume` | 0..1 | 0.5 | output gain |

Output is the mean of the supersamples × envelope × volume, clipped to [-1, 1]. A sound not cut short
by `minFreq` is exactly `attack + sustain + decay + 3` samples long (stage lengths truncated to whole
samples). The noise wave draws from an xorshift stream seeded by FNV-1a over the patch's text form
(the 25 values at 14 significant digits, joined by commas), or by `seed`, so the same parameters
always render the same samples. In `sound patch`, `import` and the patch and CSV files, values outside
a range are clamped (as the engine does); in `sound set` they are errors.

**Presets** (`sound new <id> voice=classic preset=<category> [seed=<n>]`): each category draws from
the ranges below. They are data (`CATEGORIES` in `core/src/generators.ts`), not hidden code; a
parameter a category does not mention keeps its default. "Always" is applied first, then one of
"One of" by weight, then each "Maybe" on its own with its chance. Values are rounded to three
decimals. The same category and seed always give the same sound.

| Category | Meaning | Always | One of (weight) | Maybe (chance) |
|---|---|---|---|---|
| `pickup` | a short bright blip: coins, items | wave 0; attack 0; sustain 0..0.1; decay 0.1..0.5; punch 0.3..0.6; freq 0.4..0.9 | - | changeSpeed 0.5..0.7; changeAmount 0.2..0.6 (0.5) |
| `laser` | a falling zap: shots, beams | attack 0; sustain 0.1..0.3; decay 0..0.4 | wave one of 0, 1, 2; freq 0.5..1; minFreq 0.2..0.3; slide -0.35..-0.15 (2) / wave one of 0, 1, 2; freq 0.3..0.9; minFreq 0..0.1; slide -0.65..-0.35 (1) | duty 0..0.5; dutySweep 0..0.2 (0.5) / punch 0..0.3 (0.5) / phaserOffset 0..0.2; phaserSweep -0.2..0 (0.33) / highPass 0..0.3 (0.5) |
| `explosion` | a noise burst that falls away: blasts, crashes | wave 3; attack 0; sustain 0.1..0.4; decay 0..0.5; punch 0.2..0.8 | freq 0.01..0.25; slide -0.1..0.3 (1) / freq 0.04..0.81; slide -0.4..-0.2 (1) | repeatSpeed 0.3..0.8 (0.5) / phaserOffset -0.3..0.6; phaserSweep -0.3..0 (0.5) / vibratoDepth 0..0.7; vibratoSpeed 0..0.6 (0.5) / changeSpeed 0.6..0.9; changeAmount -0.8..0.8 (0.33) |
| `powerup` | a rising sweep: power-ups, level-ups | attack 0; sustain 0..0.4; decay 0.1..0.5; freq 0.2..0.5 | slide 0.1..0.5; repeatSpeed 0.4..0.8 (1) / slide 0.05..0.25 (1) | wave 1 (0.5) / duty 0..0.6 (0.5) / vibratoDepth 0..0.7; vibratoSpeed 0..0.6 (0.25) |
| `hit` | a sharp impact: hurt, thud, punch | attack 0; sustain 0..0.1; decay 0.1..0.3; freq 0.2..0.8; slide -0.7..-0.3; wave one of 0, 1, 3 | - | highPass 0..0.3 (0.5) / duty 0..0.6 (0.33) |
| `jump` | a short upward chirp: jumps, bounces | wave 0; attack 0; sustain 0.1..0.4; decay 0.1..0.3; freq 0.3..0.6; slide 0.1..0.3; duty 0..0.6 | - | highPass 0..0.3 (0.5) / lowPass 0.4..1 (0.5) |
| `blip` | a very short tick: menu moves, selections | wave one of 0, 1; attack 0; sustain 0.1..0.2; decay 0..0.2; freq 0.2..0.6; highPass 0.1 | - | duty 0..0.6 (0.5) |

### Checks and the project style

Five checks hold a sound to the project's style (below). Each has a score from 0 to 1, a threshold,
and the exact time ranges it flags.

| Check | Flags | Default |
|---|---|---|
| `clip` | true peak above the limit, or samples at full scale (the ranges are where) | at most -0.1 dBTP |
| `loudness` | integrated loudness (ITU-R BS.1770, K-weighted, gated) off the target | -16 LUFS ±1 |
| `dc` | DC offset | at most 0.5 % |
| `click` | a jump at the first or last sample | at most 0.02 of full scale |
| `tail` | silence padding at the start or end, or a sound cut off before it died away (the last samples are not at least 60 dB below the peak) | at most 50 ms; -60 dB |

A sound shorter than 400 ms is measured as one block over its whole length (BS.1770 needs 400 ms
blocks; padding with silence would lower the figure). `work` `done` on a request is refused while the
sound's checks fail. Targets come from the optional `style` object in `project.json`, any of
`loudnessTarget`, `loudnessTolerance`, `truePeakMax`, `dcMax`, `clickMax`, `silenceMax` (seconds),
`tailFloorDb`; the defaults fill what is left out. An unknown key is an error.

### The numbers

Printed with every view, render and describe (measurements, so the last digit may differ between
platforms; the samples themselves do not):

```
duration 0.136 s (5978 samples)
loudness -4.2 LUFS, true peak -1.0 dBTP (sample peak -2.2 dBFS), rms -6.3 dBFS, crest factor 4.2 dB
dc offset -0.00007 (-0.01 %)
attack 0.2 ms to −3 dB of peak; tail 0.000 s to −60 dB; silence 0 ms before and 0 ms after
brightness (spectral centroid) mean 7.7 kHz; start 8.2 kHz, middle 7.6 kHz, end 6.9 kHz; flatness 0.01 (0 tonal … 1 noise)
pitch 2.3 kHz (D7) at the start → 1.4 kHz (F6) at the end; range 1.3 kHz (E6) to 2.5 kHz (D#7) (11.5 semitones); 100 % of the sound is pitched
onsets 1 (at 0.000 s)
```

Attack is the time to the first sample within -3 dB of the peak. Tail is the time from the end of the
loud part (the last point within -3 dB of the loudest level) to the last point above -60 dB below the
peak. Pitch is a YIN track; centroid and flatness come from a 1024-point spectrogram; an onset is a
rise of 10 dB within 20 ms.

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
soundclaw view <project> <id> wave|spec|pitch [--out <file.png>]
soundclaw view <project> <id> compare <other> [--out <file.png>]
soundclaw describe <project> <id>
soundclaw check <project> [<id>...]
soundclaw import <project> sfxr <file.csv | patch-file | "patch text"> [--id <id>] [--by <author>]
soundclaw export <project> [<id>...] [--format wav|patch|csv] [--out <dir>]
soundclaw request <project> [<id> --note "<what should change>"] [--by <author>]
soundclaw reply <project> <request> "<answer>" [--by <author>]
soundclaw cancel <project> <request> ["<why>"] [--by <author>]
soundclaw work <project> list | claim [<request>] | progress [<request>] "<note>" | block [<request>] "<question>" | done [<request>] "<what changed>" [--by <agent>]
soundclaw skill install [--dest <dir> | --project <dir>]
soundclaw await <project-folder | watch-url> [--timeout <seconds>] [--since <cursor>] [--as <name>] [--json]
soundclaw serve --project <project> [--port 7427] [--no-mcp]
```

Example:

```
$ soundclaw new demo.sclaw
$ soundclaw run demo.sclaw -e 'sound new zap voice=classic preset=laser seed=1; sound set zap volume=0.2'
applied 2 commands as group g1 by agent:claude
  #1 sound new zap voice=classic preset=laser seed=1
  #2 sound set zap volume=0.2
zap: classic wave=sine sustain=0.225 punch=0.298 decay=0.001 freq=0.984 minFreq=0.228 slide=-0.227 highPass=0.042 volume=0.2 → 5065 samples, peak 0.633, rms 0.368, hash 254675a10aed
    checks: 3/5 pass; failing: loudness -5.8 LUFS (10.2 LU too loud); click start 0.171, end 0.000
warnings: none
```

Every result ends with numbers for each sound it touched, since an agent cannot listen: samples,
peak, rms, the first 12 digits of a hash of the samples, and a one-line check summary. The same
document always gives the same hash, on every machine. The dashboard shows the same 12 digits on
each card. `render` adds the full numbers and a description (and still ends with the check summary).

### The ears

`view` draws a PNG (saved under `<project>/.cache/views`, or `--out`) and prints the numbers; the
MCP `view` tool returns the image itself.

| View | Shows |
|---|---|
| `wave` | the waveform with its loudness envelope, a time ruler, amplitude marks, the peak lines, red marks where samples reach full scale |
| `spec` | a mel spectrogram (80 dB range) with a log frequency ruler in Hz and the C notes, and a time ruler |
| `pitch` | the YIN pitch track over a grid of semitones with note names; unpitched stretches are gaps |
| `compare` | two spectrograms stacked and, under them, their difference (red: the second is louder; blue: the first), plus distance numbers: spectral distance (dB), loudness, duration, brightness, pitch start and end (semitones), envelope correlation |

`describe` is a plain-words summary built only from the measured numbers (never from the sound's
settings), then the numbers. `check` runs the checks with scores, thresholds and the exact ranges;
it exits 1 when any sound fails.

### Import and export

`import <project> sfxr <source>` makes classic sounds: from a `synth.csv` (one sound per row; the key
column is the id: a column named `id`, `key`, `sound` or `name`, else the first; the other columns
are parameter names in any order plus an optional `seed`; a missing column, an empty cell or `NA`
takes the default), from a single-patch file (the file name gives the id, or `--id`), or from the
patch text itself. One undo group.

`export --format`: `wav` (default; 16-bit PCM, 44,100 Hz, mono; a classic sound is written in the
engine's pre-rendered form, each sample `trunc(s × 32000)`), `patch` (`<id>.sfxr`, the single-patch
text: a version line, then the 25 values at six significant digits; a sound with a seed is written
as `name=value` pairs so the seed travels), `csv` (one `synth.csv`, every column at full precision,
so reading it back renders the same samples).

Exit codes: 0 done, 1 refused (an error in the commands or the project; nothing was applied), 2
usage error, 3 (`await` only) the timeout passed with nothing to report.

### While a server runs

`soundclaw serve` owns its project. Commands that write (`run`, `export`, `import`, `request`, `reply`,
`cancel`, `work`) are sent to it over HTTP, found through the project's lock file and a token file
only you can read, so they go through its single writer and a connected dashboard updates live.
If a server holds the folder and its token cannot be read, a writing command refuses rather than
write behind its back. Read-only commands (`list`, `history`, `render`, `view`, `describe`, `check`) read the files.

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
| `render` | `sound`: the numbers of its render (samples, peaks, loudness, attack, tail, brightness, pitch, onsets), a description, and the check summary last. |
| `view` | `sound`, `kind` (`wave`, `spec` default, `pitch`, `compare`), `other` for compare: a PNG image and the numbers. |
| `describe` | `sound`: words from the numbers, then the numbers. |
| `check` | `sounds` (default all): the checks with scores, thresholds and flagged ranges. |
| `import` | `source` (csv or patch text, or a path), `id`: make classic sounds. |
| `export` | `sounds` (default all), `format` (`wav` default, `patch`, `csv`), `out` (default `<project>/exports`). |
| `request` | File (`sound`, `note`), `reply` (`id`, `text`) or `cancel` a request. |
| `work` | `next` (default), `progress`, `done`, `blocked`, `list`. |
| `await_requests` | Wait for people; `cursor` from the previous call. |

## HTTP API (localhost, token required)

| Path | Returns |
|---|---|
| `GET /api/state` | The snapshot the dashboard starts from: sounds, style, tape, requests, presence. |
| `GET /api/render/<id>.f32` | The sound's samples as the server renders them: little-endian float32. |
| `GET /api/render/<id>.f64` | The exact doubles (for a classic sound, the reference samples that WAVs quantise): little-endian float64. |
| `GET /api/render/<id>.wav` | The same as the exported WAV (a classic sound in the pre-rendered form). |
| `GET /api/await?timeout=…&since=…&as=agent:<name>` | Long poll for events. |
| `GET /api/presence` | Who is listening. |
| `POST /api/cli` | A writing CLI command, run on the server's writer (used by the CLI itself). |
| `/ws` | The dashboard's WebSocket: batches, requests and presence out; `run` and `request` in. |
| `/mcp` | MCP over HTTP. |

The token goes as `?token=…` or `Authorization: Bearer …`. The server answers only to the host
names `127.0.0.1`, `localhost` and `[::1]`.
