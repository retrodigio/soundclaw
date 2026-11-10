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

The only document today is a **sound**, with one of three voices: the **classic voice** (sfxr's 25
parameters; below), the **layered voice** (below), or the tone placeholder, a sine tone with `frequency`, `duration` and `volume`.
The folder already has places (`instruments/`, `songs/`, `sets/`) for the documents the fuller tool
will add.

**The tape is the source of truth; `sounds/<id>.sfx` is written from it.** Every command, including
a person's action in the dashboard, goes on `history.jsonl`, and the sounds are the tape replayed.
`sounds/*.sfx` are rewritten from the replayed library after each change so that they read and
diff well in git. A hand edit to one is overwritten by the next change (turning an edited file into
a command is a later step). Commands that settle something the text left open (a default seed for a
preset or a mutation) write the settled value into their normal form, so the tape replays exactly.

## Samples

A sample is **bytes named by their hash**. The store keeps each audio once, as a plain WAV in `samples/objects/<xx>/<hash>.wav`; objects are written
whole under a temporary name and moved into place, and never rewritten or renamed, so git stores each once. The hash is a SHA-256 over a fixed header
(`soundclaw-pcm 1`, rate, channels, sample format) and the interleaved little-endian samples, not over a file: the chunks a WAV carries around its
audio, or another container holding the same audio, change nothing, and a lossless store in another encoding could come later without changing a name's
hash or a render. The formats stored are 8, 16, 24 and 32-bit integer and 32-bit float, exactly as read, so a file renders as it always has.

**Names live on the tape.** `sample add <name> hash=…` (with the facts about the audio, its provenance and its licence), `sample set`, `sample rename`
and `sample remove` are tape commands with authors and undo groups, replayed like sounds; `samples/<name>.sample` is written from the tape for reading
and diffs. A name resolves to a hash at that point of the tape, and the render key holds the hash, so a name pointed at other audio renders again, undo
brings the old audio back, and an earlier version of a sound (a set's clip grid, a review) renders with the audio its names stood for then. The
dashboard fetches audio by hash (`/api/sample-object/<hash>`, cacheable for ever) and decodes it with the same core code as the server, which is why
the page renders the bytes Node renders.

**Everything that reads the world happens once, in the command, and its result is written into the command.** A file is decoded when it is imported
(WAV, AIFF and FLAC by `core`'s own decoders, which use only integers; OGG, MP3 and M4A through ffmpeg, an import-time convenience), and what was read
(hash, rate, channels, frames, root note, loop, cue points) is in the `sample add` line. Replay, undo and rendering never decode a compressed file, call
out, or measure. Uploads are read in a worker thread, with a size limit, a sanitised name, and the hash checked before the name goes on the tape.

**Editing settles once.** `sample derive`, `slice`, `loop find`, `bounce`, `layer align`, `layer match` and `env … follow=` are worked out when the command runs
(in the writer, against the batch so far) and go onto the tape as the plain commands they found: a `sample add` carrying the new audio's hash, the parents' hashes and the
chain with every measured value written as a number (`ops=`), or a `sample set slices=` / `layer set offset=`. Replay applies numbers; it measures and renders nothing. A derived
object that is missing from the store is made again from its parents and the settled chain (all in `core`, deterministic), and a hash that differs refuses the project. Because a
layer's `slice=` and `loop=` read the sample's slice and loop points, which change without the audio changing, the render key holds the hash together with those points
(`sampleKeyPart`); a sample with neither is just its hash, so every earlier key is unchanged. The new layer settings (`interp`, `slice`, `fade-in`, `fade-out`, `stretch`,
`method`, `loop`, `xfade`) are left out of a sound's text and key while they have their defaults, and a document that does not name `interp` reads as `linear`, so every earlier
render and golden is the same; only a layer added now is written with `interp=sinc` (by the writer, so a replayed old line is not changed). Time stretch (WSOLA, phase vocoder) and
the windowed-sinc reader are written in `core` with the renderer's rules (no platform maths). What measures samples (`sampleears.ts`, `layer-measure.ts`, `numquery.ts`) may use `Math.*`:
its numbers are printed rounded and settled before they are used.

**Sampled instruments are sample layers made at the note.** An instrument may hold a table of zones (`core/src/zones.ts`): a sample or slice for the keys and
velocities it covers, with a root and a tuning, loop points and mode, a trigger (attack or release), round-robin takes, a choke group and a drum hit name. When a note is
rendered the zones that apply are made into ordinary `sample` layers of the note's sound (the same reader, the windowed sinc, the note envelope and the instrument's
effects), so a zone sounds exactly as the layer it stands for would. Loops that must follow the key are built at the note (the loop run for as long as the key is held, the
crossfade at each seam, the tail after it for a sustain loop) in `core` with the renderer's rules. A note's choice among round robins depends only on its channel and the
placement in the song it stands in (a counter, or a hash of the channel, the note's time and its pitch), never on other channels, so a channel renders alone to the bytes it has
in a full render; its render key holds the instrument's zones with the hash (and slice and loop points) of each sample they play. An instrument without zones has the key, the text and the
render it always had, so every earlier project and golden is unchanged. Building commands (`from-samples`, `from-slices`, `from-sample`) measure once in the writer and put plain
`instrument zone add` lines on the tape; the checks (`core/src/instrumentchecks.ts`) play each zone alone and measure, and never feed a render.

**Instrument files are read once, at the import.** `instrument import` (`core/src/sfzimport.ts`, `core/src/sf2.ts`, `server/src/instrumentimport.ts`) parses an SFZ or a SoundFont 2 file, decodes
the audio it plays, and writes the result as `sample add` lines (a hash and the facts that were read) and plain `instrument zone add` lines, in one undo group: the file and its folder are not
needed again, a replay opens nothing, and a render never sees either format. The readers are pure TypeScript in `core` (no dependencies; the files are untrusted, so every size and index
is checked against its chunk). They produce a plan, zones in the document's own terms plus a report of every opcode or generator the zones cannot carry, kept per region or zone, so the importer
names what it dropped. Importing may use platform maths (timecents to seconds): its numbers are written to the tape rounded and nothing there feeds back into a render.

**Licences travel with the audio.** Each sample has a licence (never inferred) and a provenance (source, origin, the original file's hash, who and when,
and for generated or derived audio how). A sound, instrument or song carries the licences of every sample it reaches, through parents too, and a manifest
export is gated by the project's policy. The tool records; it gives no legal advice.

**Projects from 0.1** keep `samples/<name>.wav` files with nothing on the tape. They read as samples that are not on the tape yet, rendering the same
floats (the decoders are tested against the 0.1 reader), until `soundclaw upgrade` moves them into the store in one group by `system:upgrade`.

**Generation is acquisition.** A provider (`server/src/providers.ts`: `fake` and `elevenlabs`, behind one interface: limits, terms, the licence a plan
gives, a rate for the estimate, one call per take) is called only by `generate`, never by core, replay or a render. The command is planned on the writer
first (names, estimate, every cap; any excess refuses it before the first call), the calls are made outside the writer's queue so the dashboard and the
agent keep working, and the takes then go into the store and onto the tape as one group of `sample add … source=generated` lines carrying the provider,
prompt, parameters, take, request id and credits. Commands in one process run their calls one after another, so two of them cannot both pass a cap only
one fits. The key is read from the calling process's environment at the call and every text that comes back is redacted. The project's `generation.jsonl`
and the user's `spend.jsonl` record what each command cost.

**Libraries stay outside projects.** A library is a registered folder; its index (per file: path, size, time, canonical hash, the measure `describe` prints, eight band energies, the
chunks' root and loop, path tags) is a rebuildable cache in the user's cache directory, and the list of libraries and the tags added by hand are settings in the user's config directory.
Nothing about a library is written into a project but the files that `library use` copies in, through the same import as any file (so provenance, licence and the store's rules apply).
The index is built by worker threads, each handed a batch of paths and returning entries, and only files whose size or time changed are read again; search, ranking and the sounds-like
distance are pure functions in `core` over those entries (they measure, so they may use `Math.*`; nothing here feeds a render). A page auditions a library file through a route that decodes
it to a WAV in the upload reader's worker and refuses any path that leaves the registered folder, so a library is never loaded whole and never enters a project unasked.

## Rendering

`renderSound` produces 44,100 Hz mono samples. It is deterministic by construction: fixed
operation order, no clock, no random numbers, and a sine made of `+ - * /` only (a Taylor
polynomial on a folded phase), because those are exactly specified by IEEE-754 where `Math.sin`
is not. So a sound renders to the same bits in Node and in any browser; a test renders the same
document in Node and in Chromium and compares every byte, and golden hashes pin the output.

### The classic voice and bit-exactness

`core/src/classic.ts` is a port of a reference synthesiser written in Lua (doubles throughout), and
reproduces its samples exactly for every patch and seed, including the noise stream (xorshift
seeded by FNV-1a over the text form) and the WAV quantisation (`trunc(s × 32000)`). Two places in
the reference lean on the platform's maths library, where results may differ in the last bit between
engines and operating systems, and the port replaces both with arithmetic that IEEE-754 fixes:

- **The sine** (`math.sin` in the reference, for the sine wave and for vibrato) is `sinRad` in
  `core/src/mathx.ts`, a port of fdlibm's `__kernel_sin`, `__kernel_cos` and argument reduction,
  written with `+ - * /` only. It is the algorithm V8's `Math.sin` is built on, and a test checks it
  equals `Math.sin` on this platform over 200,000 arguments; a second test pins a hash of its
  output so a change of code or platform shows. The same bits in Node and in every browser, whatever
  their own `Math.sin` does.
- **The cube** (`x ^ 3` in the reference: slide, deltaSlide, lowPass) is `cube`, x³ rounded once
  (Dekker's exact products, then one rounding; tested against exact integer arithmetic). A libm
  `pow(x, 3)` is not always correctly rounded (one libm in use here was off in the last bit for
  one argument in six), so `cube` can differ from a given platform's `pow` by one unit in the last
  place on some inputs.

Squares are `x * x`, which every `pow(x, 2)` equals. Everything else is `+ - * /`, `Math.floor`,
`Math.abs` and integer operations.

How it was checked: the port was run against the reference code on this machine's Lua (a shim for
the `bit` library and for LuaJIT's `%.14g` number printing) over the 72-patch conformance table
and 300 random patches (2.8 million samples at 16 bits): **no sample differed**. What could not be
checked is the reference's own host: its libm may round a `pow` or a `sin` differently, which could
move a sample by one 16-bit step in a rare case (a period crossing a whole number by a few parts in
10¹⁶). `core/test/classic-golden.json` holds the hashes of the exact samples and of the WAV for the
72 patches (every parameter at both extremes, every wave, seeds); they come from this port.

Pre-rendered WAVs and `export --format wav` of a classic sound quantise the doubles, not the float32
the dashboard plays, so the file is exactly what the reference makes.

### Measurements

`core/src/analysis.ts` measures a render: FFT, a mel spectrogram, integrated loudness (ITU-R BS.1770
K-weighting and gating) and true peak (4x oversampled), YIN pitch, spectral centroid, attack, tail,
onsets. It has no native dependencies and is tested against synthetic signals with known answers. It
is a *measurement*, not part of the render: it may use `Math.sin`, and the last digit may differ
between platforms (numbers are printed rounded). `core/src/checks.ts` holds the six checks and the
project style; `core/src/views.ts` draws the PNG views through `core/src/png.ts`, a small PNG
encoder (its own deflate) with a 5×7 font. A card's numbers and check badge come from the server,
which works them out with the same code, so they and the CLI agree (see "How the dashboard scales").

A **content-hash render cache** (`server/src/cache.ts`) keeps samples under the SHA-256 of the
document's audio-relevant text plus the renderer's version; it lives in memory and in
`.cache/renders/` (ignored by git). A status mark does not change the key.

**Export** is a 16-bit PCM WAV, 44,100 Hz, rendered through the cache (mono, or stereo for a layered sound with a panned layer, through the limiter); the classic voice also
exports as single-patch text and as a `synth.csv`; a layered sound is WAV only.

## The layered voice

A layered sound is plain data: sound-wide values (`duration`, `gain`, `seed`), up to 8 layers and a master
chain. A layer is a source, its parameters (all filled in), the envelopes that replace some of them, an
amplitude envelope and a chain of effects. Everything about a parameter (range, default, whether it takes an
envelope) is a table in `core/src/layered.ts`; the command parser, the editor and the reference read it.

**Rendering** is in `core/src/synth.ts`, in doubles, with the same rule as the classic voice: nothing that may
differ in the last digit between platforms. The sine is `sineCycles` (a polynomial); 2^x and log2 are built from bits
and a series (`mathx.ts`); the filter's tangent is a ratio of fdlibm sines; the rest is `+ - * /`, `sqrt`, `floor` and
`round`. The noise is xorshift, seeded by the sound's seed and the layer's salt (a number that stays with a layer through
moves), so it does not change when layers are reordered or other parameters edited. A layer is built
(source, filter, amplitude envelope, effects, gain), placed at its offset, panned (constant power) and summed;
the sound has the master gain and chain. A sound with a panned layer has two channels. The render cache keeps the channels one after
the other; `renderSound` is the channel (mono) or the mix of two, which is what the spectrum, pitch and views use, while peaks,
clipping, loudness and clicks count each channel (`analyze` and `runChecks` take the channel list).

**Samples** are files in `<project>/samples/`, not part of the tape: a sample layer names one and the render key contains the SHA-256
of its bytes. `core` never reads files: it gets a `SampleBank`. The server's bank reads the folder; the page fetches each sample
once (`/api/samples/<name>.wav`) and renders sample layers as silence, without caching, until it has the bytes. The writer refuses a
batch that names a sample that is not in the project.

**The limiter** is applied by `soundWav` / `export` / the page's download, so all three give the same bytes. It looks 48 samples ahead,
finds the needed gain per sample from a 4x oversampled peak (the same Blackman-windowed sinc as the true-peak measurement) and
averages the minimum over the window, so the gain is at most what each sample needs and exactly 1 under the ceiling.

**An automatic length** is the end of the last layer (and the master effects' worst-case tails), cut where the sound has died away
(60.3 dB under its peak, with a 3 ms fade when an effect's tail was cut), never inside a layer's own source, so a classic voice in a layer
keeps its length and `layer-up` keeps the samples.

## The server

`soundclaw serve --project <folder>` is one process: MCP on stdin/stdout for the agent, an HTTP
and WebSocket server on `127.0.0.1` for the dashboard (and MCP over HTTP at `/mcp`).

- **Token and lock.** Each start makes a random token, required by every route but the page's
  scripts. The folder's lock file holds the pid and URL (never the token); the token is in a
  private file outside the project, which the CLI reads to find the server. A second server on the
  same folder is refused.
- **Single writer.** HTTP, WebSocket, MCP and forwarded CLI commands all go through
  `writer.enqueue`.
- **Live view.** Every applied batch is broadcast with its tape entries, the sound list as it now
  stands and the documents the batch touched. The page keeps a copy and re-renders what changed.

## How the dashboard scales

A project of hundreds of sounds, a hundred samples (some of them half a minute long) and thousands of
commands on the tape opens at once, because the page never does the work of a list. The rules:

- **The list comes first.** The state frame (`hello`) carries `index`: for each sound its id, voice,
  status, a few words about what it is made of, the key of its card and, when the server already knows
  them, the numbers and check result of its last render. A project with more than 100 sounds is
  *lean*: no sound documents in the frame (the page asks for `GET /api/sound/<id>.json` when it opens
  one) and only the newest 200 tape entries (`GET /api/tape?before=<seq>` has the earlier ones, and the
  frame says whether undo and redo would do anything, since the page does not hold the whole tape). A
  batch carries the list and only the documents it touched. A small project still gets everything.
- **Thumbnails are the server's.** A card's waveform peaks and spectrogram bytes, its duration,
  loudness and checks are a *card*, worked out by worker threads (`server/src/thumbs.ts`, so the server's
  own thread never renders for a page), kept in memory and in `.cache/thumbs/` by a key that holds the
  render's content hash, the loudness rule and the style, and served as `GET /api/card/<id>.json` (about
  16 KB). A page asks for the cards that are on, or near, the screen, four at a time, newest request
  first; a quiet pass works out the rest when no page is waiting, announcing each result so the list's
  badges and the checks filter fill in. The browser draws what it is sent and renders nothing for a card.
- **Playing renders in a Web Worker** (`ui/src/render.worker.ts`), which fetches the samples the sound
  names (and only those) and renders with the same core as Node: the hash of what the page plays
  equals the Node render's, and the test says so for a stereo 30 s loop with sample layers. A second
  worker does the editor's long measurements and layer strips, so playing never waits behind them.
  The editors still render the one open sound on the page's thread (a sound under 3 s; a longer
  one is measured in the worker and the editor shows "measuring…" until the numbers come).
- **Long lists are paged and filtered.** The sound list and the audition page show 48 cards and more
  as you scroll, with filters on name prefix, voice, status, checks and tag. The set page measures its
  spread on the server (`GET /api/set/<id>.json`). The cards re-render only when something they show
  has changed.
- Samples are looked at by name, size and time stamp, and what was worked out about them (their
  hashes) is kept in `.cache/samples.json`, so starting on a hundred samples does not read them.

## The dashboard: tokens, components and the shell

The dashboard is one React page (`ui/src/studio/` holds the design system and the shell; the editors, set page, audition page and song editor
it hosts are in `ui/src/`).

**Tokens.** All colour, type, spacing, radius, density and motion values are CSS custom properties in `tokens.css`; no component carries a raw
colour. `data-theme` (`dark`, the default, or `light`) and `data-density` (`compact`, 24 px rows and 28 px controls, or `comfortable`, 32 px) sit
on `<html>`. Both are kept per browser in `localStorage` (wrapped in try/catch); with no saved theme the page follows `prefers-color-scheme`.
`prefers-reduced-motion` turns every animation and transition into an instant change. Fonts are Inter, Space Grotesk and JetBrains Mono (SIL
OFL), bundled as woff2 in `ui/src/studio/fonts/` with their licence texts, so the page works offline. Colour has roles: *ember* marks time and
focus (playhead, selection, armed, primary), *violet* is the agent and *teal* is you (always with a shape and a word: agent marks are round with
a spark, yours square with a person), and ✓ / ! / × / … are checks (a glyph, a word and a colour, never colour alone). In the light theme the
badge text colours are darker than the role colours so they reach 4.5:1 on their tint.

**Components** (`controls.tsx`, `layout.tsx`), each built once with its states and shown on the hidden `#/kit` page: knob, slider and fader (drag,
Shift for tenths, double-click to reset, the wheel, ↑↓ and Home/End, click to type a value with units — `110ms`, `1.8k`, `C6`, `−3dB`, `+5st`,
`18%` — see `values.ts`; `role="slider"` with `aria-valuetext`; a drag is a local draft and one commit), meter and loudness target, badge, author
mark and chip, buttons, segmented control, toggle, tabs, chip, keycap, tooltip, popover, toast (polite, never takes focus), banner, resizable panel
edge, the windowed list and the waveform view with check markers. A knob the agent set last shows a violet arc, a dot on the rim and a dashed
ghost tick at the value before (props for now; the tape feeds them later). Meters and the playhead are drawn from `requestAnimationFrame`
(the master meter reads an analyser on the page's output), never through React state.

**The shell** (`Shell.tsx`). A 52 px transport on top; the library on the left (288 px, 220 to 420); tabs over the page; the agent rail on the
right (320 px); the bottom panel under the page (220 px). Sizes and collapsed panels are kept per browser. ⌥1 to ⌥4 toggle the library, the
page's inspector (a sound's page has one), the rail and the bottom panel (browsers keep ⌘1 to ⌘9 for their own tabs). Below 1180 px the rail is a 44 px strip
that opens over the page, below 900 px the library is an overlay, and there is no horizontal scroll down to 360 px.

- **Routes and tabs.** `#/` (Needs attention), `#/sound/<id>`, `#/set/<id>`, `#/song/<id>`, `#/audition[/<set>]`, `#/session`, `#/review/<request>`,
  `#/sound/<id>/analysis`, `#/song/<id>/mixer` and the hidden `#/kit`. Opening an item opens or focuses its tab (× or a middle click closes it); the
  tab list is kept per browser and project. Old links work.
- **Library.** Tabs with counts (Sounds, Sets, Songs, Instruments, Samples), a filter field (`/`), chips, and a windowed list that holds only the rows
  in view. The default order is needs attention (failing first, then not yet checked, then passing; most recently changed first within each); it is
  worked out again when the list or the tape changes, and once the numbers have been still for a moment, so rows never jump as checks stream in.
  Rows show a violet dot for sounds the agent changed that you have not played or opened (per browser; the row pulses once), the name, a mini
  waveform from the server's card, integrated LUFS and the check glyph. ↑↓ moves the selection and previews it (off in the palette), Enter opens it,
  Space plays it, R asks for changes.
- **Centre page.** Needs attention as cards or rows; "Show all" brings back every sound, the sets and the songs. A card is one fixed height: the name
  and voice, one 54 px panel (the waveform over the spectrogram, a marker where a check reports a time), a badge per failing check ("× click 0.14 s";
  clip, loudness and dc are whole-sound results and carry no time) and who changed it last. Play, Approve and Ask show on hover and focus; Feedback, Edit and
  the exports are in the overflow menu. The grid is windowed, so only the rows near the view exist. The spectrogram colours are a token ramp: the
  ground, ember at rising opacity, then a pale highlight (`--spec-hi`).
- **Agent rail.** Presence, the claimed request ("working on"), your requests with their state (sent, seen, claimed, working, blocked, ready for
  review), the live feed built from the tape and the request events (a play button where a sound changed), and the ask field.
- **Bottom panel.** Detail (the selected sound's waveform with check markers and its numbers), Mixer (a sound's loudness, or a song's strips: faders and live meters, as the song page's mixer) and
  History (the tape, for the focused item).
- **Palette and shortcuts.** Every action is registered once (`registry.ts`) with an id, a label, a group and a shortcut; the palette (⌘K) searches
  them and the project's items, `?` shows the shortcut sheet built from the registry, and one keyboard handler runs them. Shortcuts never fire while a
  text field has focus, except Esc and ⌘K. Typed text that has two or more words and matches no action becomes "Ask the agent: … on <focused item>",
  which writes a change request.

## Samples in the dashboard

A person sees and steers the samples the way they do sounds: everything is a command on the tape, written as `human:<name>`, and everything an agent
brings in is visible as it happens.

- **The Samples tab** of the library has three modes. *Project* lists this project's samples: a name, a small waveform, the length, loudness and note,
  where the audio came from (a glyph and a word), and the licence (a glyph and a word). The filter field takes the numbers query of `sample list`
  (`dur>1.4 centroid<2k pitched=yes`), words and chips; a query that does not parse says why and keeps the list. ↑↓ moves (and plays the row after a
  short pause when preview on select is on), Space plays, Enter opens the sample's page, and a row drags onto a layer list (`layer add <sound> sample
  sample=<name>`). *Library* searches the registered sample libraries with the same query, 48 files a page; nothing is loaded until a file is played,
  which streams from the server (a file over 2 MB plays from its first 2 MB while the rest comes in 1 MB byte ranges), and *Use* copies one into the project with the library's licence and where it came from. *Takes* lists what generation
  made, newest first, with the prompt, the take and the credits; *Keep* names it and asks the person to confirm its licence, *Discard* removes the
  name (the audio stays in the store until `sample gc`).
- **Cards.** A sample's numbers and small waveform are worked out once per distinct audio by a worker thread on the server and kept in
  `.cache/samplecards/<hash>.json` (`GET /api/sample-card/<hash>.json`); the page asks only for rows in view, or for all of them when a query needs
  numbers. The page keeps no audio for a row.
- **The sample page** `#/sample/<name>` shows the lenses (waveform, spectrogram, pitch, the loop's seam, and a difference spectrogram against another
  sample or a sound) on one time axis, worked out in a worker from the same measuring code the CLI uses. Handles sit on the axis and a gesture writes
  one command when it is let go: the loop points (`sample loop`), the slice markers (`sample slice … at=`; click adds one, Delete removes the
  focused one) and the trim (a `sample derive` when the person asks for it; from a layer, `#/sample/<name>/layer/<sound>/<n>`, the layer's own `start`
  and `end`). Below are the numbers, the words, the advisory checks, where the audio came from (source, origin, prompt, provider, take and credits,
  parents and operations, the original and the instrument file's hashes), the licence and why it stands as it does (editable), and what uses the sample.
  Actions: derive, make an instrument, generate again (the estimate and the budget first, then a confirm) and ask for changes (a request on the sample
  itself, `sample:<name>`, optionally pinned to the selected stretch, or on a sound that plays it). The requests made on the sample are listed on its
  page with what the agent said; a done one offers *Approve* and *Ask again*. A trim dragged on the plain page is a draft: the page says *unsaved trim*
  (in the header and the toolbar) until *Make* writes the one `sample derive`, and *Reset* takes it back.
- **The instrument page** `#/instrument/<id>` draws the key-map in SVG from the instrument's zones (the same document the renderer plays) and the
  instrument's check from `GET /api/instrument-check/<id>.json`, which a worker thread works out once for each distinct instrument and set of audio.
  Dragging an edge of the selected zone, or moving it with the arrows and Enter, writes one `instrument zone set`; a sample dropped on a key writes one
  `instrument zone add` rooted at the sample's own root, else its measured pitch (with the tuning that cancels the error), else the key it was dropped on.
  Playing renders the note in the page with core (the bytes a song renders) and starts it; a held key fades over the instrument's release, a fixed
  length plays out as written. The computer keyboard and Web MIDI input play the same way.
- **Generating.** The generation panel (the Takes mode's *Generate…*, the session page, the palette) shows the kind, prompt, length, takes and name, the
  estimate the server works out (a `POST /api/generate` with `estimate: true`, which calls nothing), the budget it comes out of against the project cap and the daily cap,
  and every reason a call would be refused. Nothing is called until *Generate*, and a paid call also needs the person to tick that it spends about N
  credits. Paid generation is off until a person sets a project cap, which the panel can do (only as a human author; no agent route sets one). The takes
  arrive in Takes, and the feed shows the takes of one call as one item. The session page carries the spend (`GET /api/generation`: the budget, the
  providers and whether each has a key set, never the key, and the latest ledger lines).
- **Dropping and recording.** Files dropped anywhere on the window (or chosen from the palette) open a dialog that asks for the licence, `unknown`
  unless the person says otherwise, and upload as a human import. The record button in the top bar opens the microphone through `getUserMedia` into an
  AudioWorklet at the device's own rate, with an input meter and an optional count-in; nothing is trimmed, and the take is saved as `source=recorded
  licence=own` only after the person confirms they recorded it. The worklet is a file next to the page's script (a `data:` address would not pass its
  content security policy).
- **The agent's new samples** carry the violet mark in the list and the rail's feed until the person plays or opens them (what was there when the page
  first opened a project is not news); the feed says what came in: an import, a library file used, a recording, a take with its prompt, a derived
  sample, a bounce.

## States, accessibility and narrow windows

**A new project** shows three starts instead of an empty list: a sound from a preset (laser, pickup, jump, hit or explosion; N), a set of four
footsteps made as one family (⇧N) and a 16-bar loop in A minor with chords, a lead, a bass and drums (⌥N). Each runs the same commands an agent
would (`sound new … preset=…`, `set new … from=…`, `song new` and its channels, patterns and section) as you, and opens what it made. Under them
is the CLI line an agent would run on this project, and a note that the agent's results appear here live.

**A large project's first seconds.** Rows whose numbers are not known yet shimmer and read "…"; a thin ember line under the home header and the
library counts the sounds whose card the server has worked out (`index 400 · thumbs 37 / 400`) and goes away when every one is known. A card
is asked for by whatever shows it (a library row, a home card), counted per claim, and given back only by a claimant: two views of one sound
never cancel each other. A card that failed to come is asked for again a few seconds later while it is still in view, and so is one whose
sound changed.

**Offline.** When the websocket closes, an amber banner under the tabs says "Lost the SoundClaw server at host:port", gives the command that
starts it again on this folder (`soundclaw serve --project <path>`, with `--port` when it is not the default), a Retry button and the time
to the next try (1, 2, 4, 8, 16 and then every 30 s). Everything open still plays from the local render. An edit made offline is applied to
the page's copy at once (the knob moves, the sound plays as edited) and queued; the banner counts the queue and lists it, each line "not
sent". On reconnect the queue goes out in order as ordinary commands by you; any the server refuses (the sound was removed meanwhile, say)
are listed with the server's reason until dismissed. Change requests are not queued: asking needs the server, and says so. The presence
pill reads "offline". A server started again on the same folder keeps its token (it is kept beside the lock file after a stop, readable only
by you), so an open page and its links keep working.

**Contrast.** Text needs 4.5:1 against what is behind it; text of 24 px (or 18.66 px bold) and UI glyphs (one or two symbols, no letters)
need 3:1. A browser test measures every element with text on every screen, in both themes and both densities, from the computed colours
(backgrounds laid over one another up the tree, opacity multiplied in), and lists what it skips: disabled controls, decorative text inside
`aria-hidden`, text over an image or a gradient, and text covered by a dialog or scrolled out of its box. Role colours used as text go
through their `-text` tokens. Values changed to pass: dark `--text3` `#858C9C` → `#8B92A2`; light `--you-text` `#0B6F66` → `#0A635B`; light
`--ember-text` `#B9440A` → `#A03A08`. The light theme's warn button is dark text colour on a raised ground; keycaps on a primary or warn
button use the on-ember colour. Nothing that carries meaning is faded with opacity (a device that is off has a dashed border instead).

**Roles and keys.** Tab lists hold tabs with one selected; every knob, slider, fader and envelope corner is a `slider` with a name, a value
and a value text in units; the library is a `listbox`; the palette, the shortcut sheet and the composer are modal dialogs that keep focus
inside and give it back on Esc; focus shows a 2 px ember ring. Checks carry a glyph and a word, authorship a shape and a name, so colour is
never alone. The shortcut sheet is built from the registry, plus reference lines for keys that live on one page (the lenses, the clip grid,
blind A/B), so it lists every shortcut.

**Narrow windows.** At 1180, 1024, 900, 760 and 360 px no screen scrolls sideways (a test walks every screen at each). Below 1180 px the rail
is a 44 px strip, and the header drops the agent's text from the presence pill, the song's key and metre and the search label; below 1100 px
the song's tempo; below 900 px the library is an overlay (⌥1), the master meter and the project name go; below 720 px the page stacks and
the presence pill and panel toggles go; below 480 px the undo buttons (⌘Z) and the play position. Wide content scrolls inside its own box:
the session's lanes (at least 180 px each, with sticky one-line headers), the mixer's strips (the master stays pinned at the right), a
layered sound's device chain (scrolled to the open device).

**Performance**, measured by a test on a 400-sound fixture: the list paints about 0.3 s after a warm reload, no task while scrolling the
library is over 100 ms, a layered editor of a 30 s loop opens with its longest task near 0.5 s, and meters and the playhead draw in
`requestAnimationFrame` (the mixer's numbers are written into the page ten times a second, outside React).

## The sound pages

A sound's page (`#/sound/<id>`) is the classic or the layered editor; `#/sound/<id>/analysis` is the five lenses on a page of their own. Code:
`ui/src/sound/` (the lenses, the classic editor, the inspector, the provenance and device helpers) and `ui/src/LayeredEditor.tsx`.

**The lenses.** Waveform, mel spectrogram, pitch, compare and numbers share one time axis: the cursor (a click), the selection (a drag; ⇧-drag
extends it; a double-click clears it) and the zoom (⌥-scroll zooms time around the pointer, ⇧-scroll zooms the waveform's level, a plain scroll pans
a zoomed view) live in the panel, so they stay when the lens changes (1 to 5, or the tabs; the layered editor adds a sixth, the sum by layer). The
data comes from the measuring worker (`op: 'lens'` in `render.worker.ts`): peaks, the loudness over time (400 ms windows, `loudnessCurve` in
core's measuring code), the mel spectrogram (96 bands, at most 480 frames, as bytes over the 80 dB below the loudest cell), the pitch frames, and
`analyze` and `runChecks` themselves, so the figures are the ones `soundclaw measure <project> <id> --json` prints (a test compares them). Compare
is a second worker op: both sounds' spectrograms on the same frames, the difference as signed bytes (full scale 30 dB), and one sentence about the
quarters of the sound and three bands that moved by 3 dB or more. It compares with the state before the sound's latest group by default, or
another sound. The numbers strip under the lens is always there. A *flag* is a failing check's time range as a marker on every lens; clicking it
puts the cursor on it, selects a little around it and loops that part (`Store.playRegion`). The playhead is read from the player's clock each
frame and moved directly, so React is not updated at frame rate. Only a draft being dragged is drawn on the page's thread (the waveform of a
sound the person is editing); everything else comes from the worker.

**Who set what** (`sound/provenance.ts`). The tape is replayed once, group by group, and one sound's document is compared before and after each
group. The latest group to change a classic parameter (or a layer, or a layered device) is that control's *trail*: who, when and the value before.
A control is *set by the agent* when its trail is an agent's and no person has marked the sound approved since; then it draws the violet arc, the
dot on the rim and the ghost tick at the value before (knob), the dashed violet envelope (drawn envelope), the dashed outline of the waveform
from before the change (the lens) and a violet border and spark (a layered device). The agent's note on a control is the done or progress text
of the request the agent had claimed when it wrote the change (`answeredNote`: the claim comes before the change and the done, blocked or cancel
after it). In a lean project the page fetches the rest of the tape first, because a replay needs the sound's creation.

**The classic editor.** The header (checks as badges, the generators, Mutate with its amount (M), the seed), the lens panel, and seven modules in
signal order: envelope (with a drawn envelope whose four corners are handles: end of the attack, punch, end of the sustain, end of the decay),
pitch, slide, vibrato, tone (the wave as a segmented control, duty), repeat and phaser, filters and output. The knobs show units (`classicUnits.ts`:
lengths are `a² · 10⁵` samples, frequency is `8 · 44100 · (f² + 0.001) / 100` Hz, the pitch step is semitones, volume is dB); typed text takes
the same units and is turned back into the stored 0..1 number, rounded to three decimals, which is what the command carries. A module whose
parameters all rest is dimmed and says "off"; a module that holds a failing check's likely cause takes its colour (click and harsh: the filters; a
long tail: the envelope). The inspector (⌥2) shows the selected control, the value before, who set it and when, the agent's note, Hear before
(plays the sound with the old value, then now; ⌥-click a knob does the same), Revert (a `sound set` of the value before, by the person), the
numbers, this sound's history, Ask for changes (R; the note carries the selected region) and Approve, and below them A/B, the loop controls and the
exports. A knob's drag is a local draft written once, at the end, by the same `Coalescer`; keys, the wheel and typed values go through it too, and
a burst of key presses is one command.

**The layered editor.** The big view is the lens panel, opening on *sum by layer*: each layer's absolute level over time, stacked in the layer
palette (worked out in the worker from per-layer renders); hovering a band for a moment plays that layer alone (a page preview, nothing is
written), clicking it selects the layer. Under it each layer is a track: a handle (drag to reorder: `layer move`), the name, the source summary,
S and M, a mini waveform, a gain slider, and the layer's chain left to right: the source, the amplitude envelope, then each effect as a card with a
sketch of what it does (filter response, drive curve, echoes, reverb tail, compressor line…) and its first values (`devices.ts`). Enter, or a
click, opens a card with every parameter (and the envelope graph); the source card opens the layer's source parameters, pan and offset. Dragging a
card within a chain is one `fx move`; dragging it onto another layer or the master chain is one batch (an `fx add` with the same parameters and
envelopes, then an `fx remove`), and ⌥-drag leaves the original. Dragging uses pointer events, not the browser's drag and drop, so it works the
same everywhere and is testable. "+" at the end of a chain adds an effect; "+ Layer" adds a layer. A layered effect has no enabled flag, so there is
no bypass toggle.

## The song pages

A song has two pages that share a header (play, loop, the intensity selector for layered songs, undo, the settings): the arrangement, `#/song/<id>`, and
the mixer, `#/song/<id>/mixer` (also the bottom panel's Mixer tab). `ui/src/song/` holds the pieces; `ui/src/song/model.ts` holds everything they work out
(no React, so unit tests read it).

**The arrangement** is a row per channel, ordered by game layer (the stem tag and a rule between layers), on a bar ruler. The sections are markers; the
loop region is a band with two handles (an end or the whole band snaps to the sections' edges, one `song loop` per drag) and the seam check's verdict is a
badge at its end. Each placement of a pattern in which a channel plays is a clip with a sketch of its notes. A clip is violet and dashed while the agent
wrote its row and nobody has approved it: `patternAuthors` reads the tape (undone groups left out) and calls a `pattern/channel` row the agent's when the
latest command that changed it was an agent's (a `pattern set` counts the rows whose cells differ from what the tape last said, a note edit its row, a
helper its channel) and neither `song mark … approved` nor a person's edit of that row came after. Song checks are drawn from the server's report
(`/api/song/<id>.json`): masking is a dashed amber box on both lanes over its stretch, the longest stretch of each pair labelled, other failing checks that
name a channel sit on its lane, and a flag click selects it and puts the partner's notes behind the roll. A drag on the ruler picks bars (R asks for changes
pinned to them and the selected channel); a click puts the cursor there. The playhead and the cursor readout move by style and text from a
`requestAnimationFrame` loop; React hears only when the step changes.

**The split editor.** The piano roll (all its gestures) is on the left and the pattern text on the right. The text is the normal form `pattern set` takes. A
note selected in the roll lights its token (the tokens are found from the text itself, so a note-list row works too), and a caret or selection in the text picks
the notes under it. Typing is read again 300 ms after the last key: a problem is underlined with its message and nothing is written; text that means something new
is one `pattern set` (the very command an agent would write), so one pause is one batch. The person's layout is kept: when the pattern changes and the text already
means it, the text is left alone; an outside change (the roll, the agent, an undo) replaces it and puts the caret back on its line and column, unless the person is
mid-edit, when a link offers the reload. Rows the agent wrote have a violet left border. The grid for drum hits is a tab beside the roll. The roll ends in a velocity lane;
the arrangement above is fitted to its rows when the page opens, and a divider between the two can be dragged (its height is kept per browser).

**The inspector** (⌥2; closed until opened, an overlay below 1040 px) holds the instruments, helpers, song order and changes (what the agent wrote that
nobody approved, with Approve, and the song's recent commands) and the ask box; the palette finds each ("Song: show the helpers" and so on).

**The mixer** has a strip for each channel (instrument and effect inserts, pan, a send knob named for each bus the song has, a fader with a stereo meter, the
gain, the channel's own integrated loudness from the server's per-channel analysis or "silent here", M and S, ⌥ for the whole stem), then each send bus (its
effect's knobs and its return level) and the master (the limiter's ceiling and the most gain reduction it made, a vertical loudness target, short-term loudness
live, the loudness range and the true peak). Every knob and fader writes one `song channel set`, `song send`, `song fx set` or `song set` when a drag ends; a
control whose latest change is the agent's, with no approval or edit since (`paramTrails`), has the violet tick. The masking lane links the strips the masking
check names; a click solos both and loops the stretch (listening only), the same click again clears it.

**Meters.** `ui/src/song/meters.worker.ts` keeps a small track per channel (the peak and the K-weighted energy of each 1/60 s) and posts the levels at the
playhead about thirty times a second while a song plays; the send buses are run there too. The page sends it a channel's audio once, so after an edit only the
changed channel crosses; and only while a mixer is showing. Meters read the latest values in `requestAnimationFrame` (`MeterHub.reader`), falling at 30 dB
a second, as a peak or as the short-term loudness; a test counts the mixer's renders over a second of playback.

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

A change request may carry a **target** (a range, bars of a song with a channel, a parameter, a layer, or the item), set by
the dashboard's composer from whatever is selected; it is validated with the request (a range needs a sound, bars a song)
and printed in words by every surface that prints a request. A request may also name the done request it asks **again**
about, and a person's decision on a done request (`reviewed`: approved, reverted, or undone within ten seconds) is a
record of its own; "ready for review" is a done change with no such decision and no approval from a person since.
The writer tells watchers how far a multi-item batch has got: `batchProgress` messages (`start` with the item count,
`item`, `end`) go over the websocket, ahead of the `batch` message that carries the result, and the latest one is in
the snapshot. An item is a command of a batch of several, or a member of a set that `set new` or `set regen` makes
(its loudness match is the slow part); a batch of one command says nothing.

### Presence and live arrival

The page never moves what you are looking at because of a server update. A changed library row pulses once and keeps a
"new" dot until played or opened; scroll, selection, open popovers and carets are untouched; toasts and the Undo bar
are polite and never take focus; the batch strip and the update chip float in a zero-height sticky layer, so they take
no room. When the agent changes the item you are editing (its editor is open in the focused tab and you changed
something in the last minute, or a draft or drag is open) the store **holds** your version: the editor keeps showing it,
your own edits are applied on top of it, and an "agent update waiting · review" chip opens the review. Taking the
update (the chip's link, discarding your draft, or leaving the editor) shows the item as it is. The page replays
the tape itself for the history tape's preview and for a revert's commands; a review's before and after, parameters,
numbers and check markers come from `GET /api/review?request=r3|group=g7`, which is `changes` with the structure kept.
The review's numbers are kept to one line each (the value and its unit; the check's full text is the tooltip). On the history
tape a batch's span is labelled as its width allows ("batch · 6 commands", "6 cmds", "6"), the full label in its tooltip. The presence pill
says a few words ("listening", "claude working", "not listening", "offline") with the full sentence as its tooltip, and is the first thing
in the header to shrink.

## The editor and human edits

A classic sound's page (`#/sound/<id>`, opened from its card) is the editor: the 25 parameters as
knobs in seven modules (see *The sound pages*), the wave, the category and `random`
generators, mutate with an amount, A/B and exports. The page renders with the same core as the
agent's renders, so what plays is what `render` measures.

**Every edit is a command.** The editor sends the line an agent would write: `sound set <id> …`
(the parameters in the table's order, the wave by name), `sound generate <id> <category> seed=<n>`,
`sound mutate <id> amount=<a> seed=<n>`, and "Keep A" as one `sound set` of the parameters that
differ. The page picks a seed when it asks for a random patch, and the seed is on the tape, so
the history replays. Commands go through the writer as `human:<name>` like any batch.

**A drag is one command.** Moving a slider changes a local draft (drawn and measured at once, not
written). `Coalescer` in core holds the latest value of each parameter and writes one `sound set`
when the control is released (a double-click window of 250 ms later, so a double-click can reset
instead), or when it has not moved for 700 ms; a value equal to the sound's is not written. Undo
and redo on the page are the same `undo` and `redo` commands.

**Replay.** A change to the sound as the server holds it (a person's commit, an undo, an agent's
edit) replays it when *play on change* is on. A/B pins a snapshot of the parameters (or another
sound) as A and switches playback between A and the live B; the pin lives in the page only.

**`changes`.** For the agent: every tape group after its cursor by other authors, with the sound
replayed before and after the group (the tape up to the group's first and last entry), the
parameters that differ, the numbers (duration, loudness, centroid, pitch) and a compare PNG. The
cursor is the highest command number read, per agent, in `.cache/changes-seen.json`.

**Feedback tags** are fields on a request record (`tags`, `other`), so they use the whole
requests machinery: state, `seen`, `await`, the card. The tag `good` alone is a `feedback`
request: no mark, no checks to pass before the agent closes it.

## Sets, families, loops and the audition page

**Sets are documents; their members are sounds.** `sets/<id>.set` names the source, the seed, the loudness target, the spread rules and the members;
the sounds themselves are in `sounds/` like any other and every edit to them is an ordinary command. A set command is a command on the tape
(`set new … seed=5`), replayed like the rest.

**Measuring never happens while a tape replays.** Loudness matching needs a render and a measurement, and a measurement (`Math.log` in the BS.1770 maths) may
differ in its last digit between machines; if it fed a replay, a document would no longer render to the same bytes everywhere. So the *writer*
measures when a command is run and appends plain `sound set <member> gain=<g>` commands to the same undo group; a replay applies those numbers and measures nothing.
`core` supplies the maths (`matchGain`), the writer decides when to call it.

**A loop is a render, not an edit.** The seam is made when the sound is rendered (`renderLoop` in `core/src/synth.ts`): the long render is folded with an
equal-power crossfade over the start. Nothing is done to the samples afterwards, so Node and the browser agree bit for bit (the crossfade weights use the same
polynomial sine as the tone), and the `loop` view and the click check at the seam read the samples as they are.

**OGG is a dependency, not a part of the bundle.** `libvorbis.js` is a sloppy-mode script (it reads `this` at its top level) that cannot live inside an ES module bundle,
so the package depends on it and loads it when the first OGG is made. Its stream serial number is replaced by a fixed one (checksums rewritten) so the same sound gives the
same bytes. There is no permissively licensed Vorbis decoder to hold the encoder against, so the tests read the container and the headers themselves (every page's checksum,
the three headers, sample counts) and, where `ffmpeg` is installed, decode the file and correlate it with the source.

**The audition page and the set page are the same clip grid.** They render and measure in the browser with `core` (the numbers the CLI prints; the audition page's rows use the server's cards, so a large project opens at once), keep their
state (selection, filters) in the page, and write only commands: Approve is `sound mark`, Ask for changes, feedback and blind A/B answers are requests, regen is `set regen … seed=<n>` with a seed
the page chooses, loop controls are `sound loop`.

**Versions are worked out from the tape, in the page.** The set page's clip grid replays the history once per member (the same replay that
gives an editor its "who set what"), keeping a document each time the render key changes: a status mark, a moment or a class is not a version, and a
later change that brings back an earlier render makes that render the newest. The grid shows the last four distinct renders; the latest one is the
agent's proposal when an agent wrote it after the sound was made and no person has approved the sound since. A cell's waveform and loudness come from
the measuring worker rendering that document; nothing is measured inside the replay. "Make current" writes ordinary commands, as the person, in one
batch: one `sound set` for a classic or tone sound, and for a layered sound the layer, env and fx commands that turn the layers as they are into the
layers as they were (`restoreCommands` in core). The commands are applied to a copy first and must give the earlier render key exactly; a layer
removed since cannot get its noise back, and then nothing is written and the page says why.

**Blind A/B is a judgment, not an edit.** Both sides are rendered and measured in the browser; the gains meet at the mean of the two loudnesses
(both lowered together if a side would pass −1 dBTP), and a pair whose renders are scaled copies of each other is skipped. Both sides are scheduled
together on two gain nodes, the one not heard at zero, so Tab switches in time. An answer is a `comparison` request: the two sides as a sound and a
tape number, the answer, the gains and the moment. It changes nothing; the agent reads it through `await` and closes it like feedback.

**The moment is words.** `moment` on a sound or a set is the situation in the game the sound is for. No render reads it (a test renders every golden
with a moment set and finds every hash unchanged); describe, the run summaries, a request's brief and the A/B card show it. A sound with none uses its set's.

## Not yet

Instruments, songs, sets and variants, loops and families for ambience, the batch audition page, bfxr/jsfxr import, OGG export, a time range on feedback ("0.4–0.7 s too harsh"), and a headless worker
that takes requests with no agent session.
