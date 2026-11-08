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
parameters; below), the **layered voice** (below), or the S0 placeholder, a sine tone with `frequency`, `duration` and `volume`.
The folder already has places (`instruments/`, `songs/`, `sets/`) for the documents the fuller tool
will add.

**The tape is the source of truth; `sounds/<id>.sfx` is written from it.** Every command, including
a person's action in the dashboard, goes on `history.jsonl`, and the sounds are the tape replayed.
`sounds/*.sfx` are rewritten from the replayed library after each change so that they read and
diff well in git. A hand edit to one is overwritten by the next change (turning an edited file into
a command is a later step). Commands that settle something the text left open (a default seed for a
preset or a mutation) write the settled value into their normal form, so the tape replays exactly.

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
- **Bottom panel.** Detail (the selected sound's waveform with check markers and its numbers), Mixer (a sound's loudness, a song's channels) and
  History (the tape, for the focused item).
- **Palette and shortcuts.** Every action is registered once (`registry.ts`) with an id, a label, a group and a shortcut; the palette (⌘K) searches
  them and the project's items, `?` shows the shortcut sheet built from the registry, and one keyboard handler runs them. Shortcuts never fire while a
  text field has focus, except Esc and ⌘K. Typed text that has two or more words and matches no action becomes "Ask the agent: … on <focused item>",
  which writes a change request.

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
