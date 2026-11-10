# Changelog

All notable changes to SoundClaw are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Normalize and effects
- **`normalize` no longer clips a sparse sound.** When gain 4 is not enough, the rest of the level now goes in front of the master limiter (a new
  `limit` parameter `gain`, 0 to 48 dB, added before limiting; `normalize` adds a `limit ceiling=-1` at the end of the master chain when it has
  none), not as an output level after the chain, so the peaks the extra level makes are held and the clip check passes. Going quieter takes that
  gain back first. Documents without the parameter render and key as before.
- **`compress makeup=auto`** in `fx add` and `fx set` writes the makeup that brings a full-scale input back to full scale, −threshold × (1 − 1/ratio) dB
  (to 24), from the threshold and ratio the effect has then; the document holds the number.

## [0.2.0] - 2026-11-10

Sampled sources: recorded, library and generated audio beside synthesis, pinned by hash so every render stays exact.

### Samples
- **A store for audio.** Samples are kept once per content, as `samples/objects/<xx>/<hash>.wav`, under a hash of the audio itself (not of a file,
  so the chunks around it change nothing). Objects are written atomically and never rewritten. Names are on the history tape (`sample add`, `sample
  set`, `sample rename`, `sample remove`), with authors and undo groups; pointing a name at other audio renders again and undo brings the old audio
  back, in the page too, and an earlier version of a sound renders with the audio its names stood for then. `samples/<name>.sample` is written
  from the tape.
- **More formats, channels kept.** WAV (PCM 8/16/24/32-bit, float 32 and 64, extensible), AIFF and AIFF-C, and FLAC are read by SoundClaw's own
  decoders; OGG, MP3 and M4A through ffmpeg when it is installed. The root note, loop points, one-shot flag, cue points and text tags a file carries
  are read and printed. A folder is one undo group, and the same audio under a second name is kept once. A sample layer takes `side=stereo`: both
  channels of a file in one layer (the two-layer form renders as before).
- **Provenance and licence.** Each sample records its source, origin, the original file's hash, who and when, and its licence (an SPDX id, `own`,
  `generated:…`, `proprietary:…`, or `unknown`, the default; nothing is guessed). Sounds, instruments and songs carry the licences of every sample
  they reach. `soundclaw licence check` reports where each stands; manifest exports (`--all`, `--set`, `--pack`) list the samples used, write
  `ATTRIBUTION.txt` when a licence asks for credit, and refuse what reaches an unknown or blocked licence unless `--allow-licence <id>` lets it
  through. `project.json` `licences` changes the policy.
- **Looking after the store.** `soundclaw sample show`, `sample gc` (a dry run; `--apply`, `--drop-history`), `sample git-lfs`, a limits table,
  uploads from the page (read in a worker thread) at `POST /api/samples/import`, and the audio at `GET /api/sample-object/<hash>`.
- **Projects from 0.1 keep working.** Their `samples/*.wav` files open and render exactly as before; `soundclaw upgrade` moves them into the store.
- **Editing samples.** `sample derive <new> from=<name> op="…"` makes new audio by a chain of operations (trim, fade, gain, normalize peak or lufs,
  silence-trim, dc, reverse, mono/left/right, pitch, stretch, loop, slice, mix); what is measured is written onto the history as plain numbers, the parent's
  licence travels, and a derived object that is missing is made again from its parents and refused if its hash differs. `sample slice` (measured
  onsets, given times or a grid), `sample loop … find` (candidate loop points with their seam numbers) and `sample bounce` (a sound, one layer of it, or a
  song, frozen into a sample, with its render key and licence) are commands of the same kind.
- **Sample layers learn to edit and to read better.** A sample layer takes `slice`, `fade-in`, `fade-out`, `stretch` (WSOLA for hits, a phase vocoder
  for tones, both written in core), `loop` with a crossfade, and `interp=linear|cubic|sinc`: a windowed sinc whose cut-off follows the pitch, so pitching
  up does not alias. A layer added now is written with `interp=sinc`; a document made before reads as linear, and every earlier render, render key and
  golden is unchanged. `layer align`, `layer match` and `env … follow=` line a synth body up with a recording by onset or peak, level and envelope.
- **Ears for samples.** `describe`, `measure`, `view` and `compare` take `sample:<name>` or `hash:<sha256>`: rate, bit depth, noise floor, harmonic-to-noise,
  pitch with confidence, onsets and tempo, silence at the ends, runs at full scale, words for organic sound, a loop view and a slices view. `compare
  <project> <a> <b>` prints the distance between any two sounds, songs, samples or files. `sample check` gives advice (clipping, DC, silence, noise floor,
  loop seam, slices off a transient) and never gates `work done`.
- **One numbers query.** `sample list "creak" dur=0.8-2.5 lufs>-30 centroid<2.5k pitched=no onsets=1 tag=wood licence=shippable` keeps the samples a
  query fits, closest first, with units (`ms`, `k`, `dB`, note names); the same language will serve library search and generation.
- **The Samples tab shows each sample.** Its numbers, a licence badge (a glyph and a word, never colour alone) and a play button.
- **Generation.** `soundclaw generate <project> sfx "<prompt>" duration=2 takes=3` makes sound effects with ElevenLabs (music too, held until you turn it on)
  and keeps each take as a sample (`<as>_t1`, …) with its prompt, provider, model, parameters, request id, credits and the licence your plan gives, as one undo
  group; replay and undo never call. Every cap is checked before the first call: one call at most 300 credits, the project's cap (`project.json`
  `"generation": {"capCredits": n}`, 0 by default, so paid generation is off until a person sets it) and a daily cap across projects (3,000). `--estimate`
  prints the cost and the budget and calls nothing; `want=` and `like=` rank the takes, each printed with its numbers and words; `--again <sample>` makes new
  takes with the recorded prompt. The charge is read from the provider's cost header, else the account's counter, and logged in the project's `generation.jsonl`
  and your `spend.jsonl` (`generate --ledger` totals them). The key is read only from `ELEVENLABS_API_KEY` in the environment of the process that calls, and
  is never written anywhere; paid calls are refused in CI and with `SOUNDCLAW_NO_PAID=1`. A `fake` provider makes test audio with no network. The same is in
  the MCP `generate` tool and `POST /api/generate`; `generate config` holds your plan, caps and rates.
- **Sample libraries.** `soundclaw library add <folder>` registers a folder of recordings kept outside any project, with its licence (`licence=`, a `soundclaw-library.json`, or a
  licence file's text that you confirm). `library index` reads, hashes and measures every file once on worker threads (and again only what changed), keeping the numbers of `sample list`,
  the root and loop a file carries and tags from its folders and name. `library search "door creak" dur=0.8-2.5 pitched=no licence=shippable` ranks by word match and then by closeness to the
  ranges; `library similar` finds files that sound like a sound, sample or file by a documented feature distance; `library use` copies one into a project with its provenance and the library's licence;
  `library tag` adds tags that survive a re-index (`library remove` asks for `--yes` before dropping them). `library similar` takes an audio file with no project. The MCP `library`
  tool has list, search, similar, use, add and index, and `GET /api/library/<id>/audio` lets a page audition a file without copying it, with byte ranges for seeking. The index lives in
  the system's cache folder (`~/Library/Caches/soundclaw` on macOS, `~/.cache/soundclaw` on Linux, `%LOCALAPPDATA%\soundclaw\cache` on Windows).

- **Sampled instruments.** An instrument can play recordings: a table of zones, each a sample (or one slice) for the keys and velocities it covers, played at `note - root + tune`
  semitones, beside any synth layers and under the same note envelope and effects. Zones loop (`sustain` while the key is held, `continuous`, `oneshot` for hits, with an equal-power
  crossfade), play release samples (`trigger=release`, lowered by `release-decay` for how long the key was held), take turns as round robins (`rr=1/3`, by `cycle` or `hash`; one channel
  re-renders alone to the same bytes), crossfade velocity layers (`velxfade`), and choke one another (`choke=1`). `instrument zones <id> from-samples … root=detect`, `from-slices` and
  `instrument from-sample … loop=find` build them (what is measured is written as plain `instrument zone add` lines); a drum channel may name one kit instrument whose zones are keyed by
  hit name (`kit=<instrument>`). `check <project> <instrument>` finds holes in the key-map, zones out of tune at their root, level steps, a looped zone's seam, a note far from its root,
  round robins too alike or too different and a release louder than its attack; `view <project> <instrument> keymap` draws it; `soundclaw instrument export … --format sfz` writes an SFZ with
  its samples. A song of sampled instruments renders to the same bytes in Node and in the browser, and a project from before has the renders it had.
- **SFZ and SoundFont 2 import.** `soundclaw instrument import <project> <file.sfz|file.sf2>` (and the MCP `instrument_import` tool) reads an SFZ (headers, `#define`, `#include`, `default_path`, and the key, velocity,
  pitch, level, pan, envelope, loop, offset, release, round-robin and choke opcodes) or one preset of a SoundFont 2 file (16- and 24-bit samples, ranges, root and tuning, loops and their offsets,
  attenuation, pan, the volume envelope, exclusive classes) as a sampled instrument: the samples go into the store with the file and path as provenance and the licence `unknown` unless given, the
  regions become plain `instrument zone add` lines, all one undo group, and nothing is read again on replay. Every opcode or generator the zones cannot carry is named, per region or zone, as lost or
  approximated; a sample that cannot be read names its region and nothing is written. `--list` shows a font's presets. SFZ export now writes the loop crossfade and counts a zone's `start` into its loop
  points, so an exported instrument imports back to the same zones and renders the same bytes.
- **Bigger imported instruments.** An instrument holds up to 4096 zones (it was 512): a note from 4096 zones renders in about 30 ms, `check` takes about two seconds (zones that differ only in the keys and velocities they answer to are measured once) and the key-map view draws in under 0.1 s. Each sample of an SFZ or SoundFont 2 import records the file's own SHA-256 as `container-hash`.
- **Samples in the dashboard.** The library's Samples tab is a browser with three modes: *Project* (a small waveform, length, loudness and note, where the
  audio came from and its licence, each as a glyph and a word; the numbers query of `sample list` in the filter field, with chips; ↑↓, Space and Enter),
  *Library* (the registered sample libraries, 48 files a page, nothing loaded until one is played, and *Use* to copy one in with its licence) and *Takes*
  (what generation made, to keep under a name and a confirmed licence, or discard). A sample has a page, `#/sample/<name>`: waveform, spectrogram, pitch,
  loop-seam and compare lenses on one time axis, handles for the trim, the loop points and the slice markers (each gesture is one command, as an agent would
  write it; from a layer the trim writes that layer's start and end), the numbers, the words, the advisory checks, where the audio came from, its licence
  (editable) and what uses it, with derive, make an instrument, generate again and ask for changes. Audio dropped on the window (or chosen from the palette)
  is imported as the person, under the licence they choose; a record button records the microphone (an input meter, an optional count-in) and saves the
  take as `recorded`, licence `own`, once they confirm it. A sample row drags onto a layer list. The agent's new samples carry the violet mark in the list
  and the rail's feed until they are played, and the feed says what came in (an import, a library file, a recording, a take with its prompt and credits, a
  derived sample, a bounce). The server makes each sample's numbers and waveform once per audio in a worker thread (`GET /api/sample-card/<hash>.json`) and
  adds `GET /api/sample-detail/<name>.json`, `GET /api/libraries`, `GET /api/library/search` and `POST /api/library/use` for the page.
- **The instrument page.** `#/instrument/<id>` draws a sampled instrument's key-map: keys across, velocity up, every zone a labelled box that wears its check as a
  glyph and a word (round robins stacked, release zones dashed). Letting go of a zone's edge writes one `instrument zone set`; the arrow keys move an edge and Enter
  writes it. A sample dragged from the Samples tab onto a key (or *Add zone…*) writes one `instrument zone add`, rooted at the sample's own root, else its measured
  pitch, else the key. The table, a zone's fields and the check's findings sit beside it (`GET /api/instrument-check/<id>.json`, worked out in a worker thread).
- **Playing an instrument in the page.** Click the piano strip, use the computer keyboard (A W S E D F T G Y H U J K O L P ;, Z and X for the octave) or a MIDI
  keyboard when the browser offers Web MIDI. Notes are rendered in the page by core, so they are the bytes a song renders; a held key fades over the instrument's
  release, and a key that plays release samples starts them when it comes up, for the time it was held; a fixed length plays out as written.
- **The generation panel.** *Generate…* in the Takes mode, on the session page and in the palette: kind, prompt, length, takes and name, the estimate and every
  reason a call would be refused, the project's and today's budget as words and bars, and a confirm before anything is spent. A person can set the project cap there
  (as `human:<name>`; no agent route sets one). The free test provider costs nothing. The takes of one call are one item in the feed, and the session page shows the
  spend and the latest calls (`GET /api/generation`, which never carries a key).
- **Requests about a sample.** A request's item may be `sample:<name>` (`request <project> sample:<name>`, the MCP `request` tool, or *Ask for changes* on the sample's
  page, which can pin it to the selected stretch). No mark is written and no check holds `done`; the brief shows the sample's numbers and what plays it. The sample's page
  lists its requests with what the agent said, and offers *Approve* and *Ask again*. A request on a sound that plays the sample still works.
- **Keep remembers the take.** A kept take gets `kept-from=<take name>` in its provenance as well as the `kept` tag, so editing the tag does not bring it back to the Takes list.
- **An unsaved trim says so.** A trim dragged on a sample's page is a draft; the header and toolbar show *unsaved trim* until *Make* writes the one `sample derive`, and *Reset* takes it back.
- **Long library files stream.** A library audition asks for byte ranges: a file over 2 MB starts playing from its first 2 MB while the rest arrives in 1 MB ranges.
- **Convolution.** `fx add <id> [layer=<n>] convolve ir=<sample> [mix=] [predelay=] [gain=] [len=]` runs a layer, a sound's master chain, an instrument's template or a song's
  master chain through a sample used as an impulse response (a recorded room, a plate, a speaker, or a `sample bounce` of a reverb tail). It is a uniformly partitioned FFT
  convolution written in core, so it renders to the same bytes in Node and in the browser; the response is scaled to unit energy, a stereo response gives each side of a stereo
  sound its own channel, and `fx add` writes the response's length (to 12 s) into the command, so the tape holds the number. A song has a third send bus beside the reverb and the
  delay: `song send <song> convolve ir=<sample>`, fed by `song channel set <song> <ch> convolve=0.3`. The render key holds the response's hash; a sample that is read as a
  response cannot be removed while a sound, instrument or song reads it, a rename follows, and its licence reaches the sound and the song.
- **Grains.** `layer add <id> grain sample=<name> dur= density= size= position= spread= pitch= jitter=` is a source that cuts a cloud of Hann-windowed grains from a short recording
  (rain, a crowd, fire, a hum) for beds and textures. The positions and gaps come from the layer's seed, so a cloud is the same on every machine and another `seed` is another cloud;
  the level is kept as the density rises; `position`, `spread`, `density`, `size` and `pitch` take envelopes; `sound loop` makes a bed that repeats without a seam. The grain layer
  names a sample like a sample layer does (the batch is refused when it is not in the project; the sample cannot be removed while a sound plays it).
- **Recipes take a sample.** `sound new <id> voice=layered preset=<recipe> sample=<name>` (and `sound generate <id> <recipe> sample=<name>`) lays the first 0.3 s of a recording over the
  recipe's synth body as one more sample layer. No recipe ships audio.
- **Audio clips in songs.** `song channel add <song> loops audio` makes a channel that plays recordings, and `song clip add <song> loops <sample> at=3.2 [len=<bars>] [stretch=tempo
  from-tempo=<bpm>] [pitch=] [gain=] [fade=] [slice=] [nudge=]` places one on a bar and beat; `song clip set` and `song clip remove` take the clip's number. A clip is played by the sample
  layer the renderer already has (the windowed sinc and both time stretches), fitted to the song's tempo when asked and following it when it changes; `stretch=tempo` without a tempo
  listens to the recording once and writes the one it found. Audio channels have the gain, pan, game layer and sends of any channel and render and cache like the others (a partial render is
  the render of the whole to the byte, the same in Node and the browser); loops fold a clip that runs past the end onto the start. The song carries the clips' licences, a clip's sample cannot
  be removed while it is there, and a rename follows.
- **Audio in sounds and songs on the dashboard.** An audio channel has a lane of clips in the arrangement: a block for each recording, sized by it and drawn from it, with a badge for the tempo
  fit and the pitch, the agent's in violet and dashed. A click selects a clip and opens its settings (each field is one `song clip set`), a drag or the arrow keys move it along the beats, a sample
  dragged from the Samples tab onto the lane places one, and *+ audio* adds an audio channel. The mixer has a strip for the channel and one for the convolution bus. A convolve device card draws the
  response it uses and its panel picks the response from the project's samples; a grain layer has a card and a map (the sample, the band the grains are taken from, how many sound at once).
  The page renders a song with clips and a room to the bytes Node renders.
- **The skill teaches three sample workflows**: a sound effect from a library file and a generated take layered with synthesis, an instrument from single
  notes, and a synth note frozen into an instrument; the README and the design notes describe sampled sources.

### Changed
- Non-commercial and no-derivatives licences stay blocked unless a project's `allow` list names an NC or ND pattern itself; a broad pattern such as `CC-BY-*` never admits them.
- Undoing a change that would take away a sample that is still played says which sounds and instruments play it.
- The fake generation provider is free and never counts against a cap (it works at a project cap of 0), and has no rates to set.
- A project's generation cap is set by a person: `soundclaw generate cap <project> <credits>`, or `POST /api/generation/cap` from the page (which takes only a `human:<name>` author). No MCP tool and no command of the command language sets one, so an agent cannot raise its own cap.

### Fixed
- The mixer's convolution bus meter moves while a song plays (the meters worker is given the room's response).
- The generation dialog's help text ends the provider's terms with a full stop.
- The library rail's five tabs fit at 1440 px and every width above 900: they share the strip, which scrolls sideways when they do not all fit.
- On the key-map, the small text of a zone (root, round robin, loop mode) no longer overlaps its name line.
- Counts read right in the singular everywhere: "1 sound", "1 song", "1 member", "1 slice", "1 sample asks for attribution".
- A library audition is decoded without hashing the file (a long file started seconds late).
- The browser tests no longer leave a server running when a spec times out while its server is starting or a worker is stopped.
- `midi import` sent through a running server names the right project folder.
- On Linux, a CLI command could not reach a server an MCP client had started: the token file went under `$XDG_RUNTIME_DIR`, which MCP
  clients do not pass to the servers they start. The token file is now always in `~/.soundclaw/run` (or `SOUNDCLAW_STATE_DIR`).

## [0.1.1] - 2026-11-09

### Changed
- Releases are published from GitHub Actions by npm trusted publishing, with a provenance statement on the package.
- A browser test of the command palette expects the platform's modifier key (⌘ on a Mac, Ctrl elsewhere).

## [0.1.0] - 2026-11-09

The first release.

### Setup
- **`soundclaw init`** sets up Claude Code in one step: it makes the project (or uses the one there), installs the skill, and
  registers the MCP server at this version with `claude mcp add` (or in `.mcp.json` when `claude` is not on the PATH).
  `--scope project` shares both with the repo.

### The dashboard shell
- **A new look and layout.** Design tokens (dark and light themes, compact and comfortable densities, reduced motion) and bundled fonts (Inter, Space
  Grotesk and JetBrains Mono under the SIL OFL, with their licence texts), a component set (knob, slider, fader, meters, badges, authorship marks,
  buttons, tabs, chips, popover, toast, banner, a windowed list, a waveform view), and a hidden `#/kit` page that shows every component in every state.
- **The shell.** A transport bar, a library (tabs with counts, a filter, chips, needs-attention order, mini waveforms, loudness and the check glyph;
  ↑↓ previews, Enter opens), tabs for open items with routes (old links still work), an agent rail (presence, your requests with their state, a live
  feed), and a bottom panel (Detail, Mixer, History). Panels resize and collapse (⌥1 to ⌥4) and are kept per browser; narrow windows degrade without
  horizontal scroll.
- **Palette and shortcuts.** ⌘K opens a palette of every action and item; a sentence typed there becomes a change request on the focused item. `?` lists
  the shortcuts. Shortcuts stay out of text fields. ⌘. switches the density; the palette switches the theme.
- **Needs attention** is the home page, as cards or rows; "Show all" brings back every sound, the sets and the songs. The editors, set page,
  audition page and song editor sit inside the shell, restyled with the tokens.
- **Cards.** The needs-attention card is one compact, fixed-height card (waveform over spectrogram, a badge per failing check with its time when it
  has one, who changed it last; actions on hover; an overflow menu), in a windowed grid. Cards from the server now say what each failing check measured
  and when (`issues`). Spectrograms use the theme's ember ramp instead of a heat map.
- **The agent's changes** pulse once in the library and keep a "new" dot until you play or open them.

### The sound pages
- **Analysis lenses.** Waveform with loudness over time, mel spectrogram with note and Hz rulers and a hover readout, pitch over a note grid,
  compare (a difference spectrogram against the version before the latest change, or another sound, with a sentence about it) and numbers, on one time
  axis. 1 to 5 switch lenses; the cursor, selection and zoom stay put; the numbers strip is always shown; a flag (a failing check's time range) jumps
  to it and loops it. The data comes from the measuring worker and is the same as `soundclaw measure --json`. They are a page, `#/sound/<id>/analysis`,
  and the big view inside both editors.
- **Classic editor.** Seven modules in signal order with knobs that show units (seconds, Hz, %, semitones, dB) and take them when typed, a drawn
  envelope whose corners are draggable, "off" modules, a check's likely module marked, and an inspector (⌥2) with the selected control's value, the
  value before, who set it, the agent's note, Hear before, Revert, the numbers, this sound's history, Ask for changes and Approve.
- **The agent's tick and ghost.** A parameter, layer or device the agent changed last, with no approval by a person since, is marked (violet arc,
  rim dot, dashed ghost at the value before, a dashed outline of the waveform before the change), worked out from the tape.
- **Layered editor.** A sum-by-layer view (hover a band to hear the layer alone, click to select it), layers as tracks with a drag handle, S and M, a
  mini waveform and a gain slider, and device chains: source, envelope and every effect as a card with a sketch and its main values. Drag a layer to
  reorder it, a device to reorder or move it to another layer (one batch), ⌥-drag to copy; "+" adds an effect, "+ Layer" a layer; Enter opens all of a
  card's parameters. The agent's note sits on the device it touched.
- **New in core's measuring code:** `loudnessCurve` (loudness over time). No render changed; the golden hashes are as they were.
- **Fixed:** the request line on a needs-attention card clipped the bottom of its state chip.

### Sets, audition and blind A/B
- **The moment.** `sound set <id> moment="…"` and `set moment <set> "…"` say what happens in the game when a sound plays ("steps repeat every
  0.4 s under quiet music"). Words only: commands with a normal form on the history, shown by `describe`, `measure --json`, the run summaries,
  the MCP text and a change request's brief; a member without one uses its set's. No render reads it: every golden hash is unchanged.
- **Comparisons.** A new request kind, `comparison`: two versions (each a sound and a tape number), the answer (A, B, both or neither fits
  better), the moment and the gains that matched their levels. It arrives through `await`, MCP and `request` in words, and the agent closes it
  like feedback.
- **The set page** has a header with the loudness class and the spread, a set loudness meter (the class band, one mark per member), and a clip
  grid: each member's last four distinct versions from the history, the current one marked, the agent's unapproved change in a dashed violet
  column. Click plays a cell, Enter makes it current (one batch of ordinary commands, as you), 1–9 play a row and ⇧1–9 a column.
- **Blind A/B.** Drag two cells onto the card, pick two and press C, or "Compare with current": levels matched (gain shown, an identical pair
  skipped), A and B at random with the names hidden, the moment (or a field that writes it), Play ×4 at the moment's interval, Tab to switch in
  time, and four answers (A, B, =, N) that each write a comparison; then the names, a session tally and the next pair.
- **The audition page** is the same grid with one column, the A/B card beside it, and its paging, filters, play-all and keys as before.
- **New in core:** `restoreCommands` (the commands that give a sound an earlier version's render, checked on a copy). No render changed.

### The agent layer
- **Targets.** A change request may carry a `target`: a range of a sound, bars of a song (with a channel), a parameter (of a layer or an effect),
  a layer or the item. It is validated with the request and printed in words by `await`, the MCP text, `request` and the brief (`pinned to
  0.31–0.38 s`, `bars 9–12 of lead`, `parameter decay`); `request --target "range 0.31-0.38"` and the MCP `request` tool take it. A request can also
  name the done request it asks `again` about.
- **The composer.** R, or right-click › Ask for changes, on a waveform region, bars on a song's ruler (with the selected channel), a knob, a layer, a
  device or an item opens a popover anchored to the selection with the note and chips (the selection, the failing check inside it, the moment; the
  check and the moment can be removed). ⌘↵ sends, Esc cancels, and focus goes back to where it was.
- **The session page** (`#/session`): the claimed request with its latest progress and the agent's commands since the claim, a running batch as
  cells that fill, requests in lanes (Sent, Seen, Claimed, Working, Blocked with a reply field, Ready for review, Closed), and the history tape, a
  timeline of every command (agent marks round and violet, yours square and teal, batches as labelled spans) that pans and zooms, lists a group's
  commands on hover and plays the focused item as it was after the group on click. The bottom panel's History tab shows the same tape, filtered to
  the item. Pause and stop are not offered: the request machinery has no such step.
- **Batch progress.** The writer publishes `batchProgress` messages (start with a count, item done, end) for a batch of several commands and for the
  members a `set new` or `set regen` makes; the snapshot carries the latest. The strip appears on the page the batch touches.
- **Review** (`#/review/<request or group>`, from the lane, the feed or the update chip): before and after waveforms aligned on the onset with the
  checks' markers, parameters old → new with author marks, the agent's note, numbers before → after with check glyphs, level-matched A/B with Tab
  switching in time (a song: notes per pattern and A/B of the loop). Approve (⌘↵), Ask again (a new request linked to the old one) and Revert (one
  batch by the person) each land on the tape, offer Undo for ten seconds and return focus. `GET /api/review` serves the structured `changes`.
- **Live arrival.** If you are editing the item the agent changes, the editor keeps your version, your edits are applied on top, and an "agent
  update waiting · review" chip opens the review; discarding your draft takes the update. Scroll, selection, popovers and carets never move.
- **New in core:** `RequestTarget` with `targetProblem`, `targetWords` and `parseRequestTarget`; the request fields `target` and `again`; the
  `reviewed` record; `restoreSongCommands`. No render changed; the golden hashes are as they were.

### Songs and the mixer
- **The arrangement.** A track per channel grouped by game layer, a bar ruler with the sections as markers, the loop region with handles, the seam
  check as a badge, a clip for each placement of a pattern with a note sketch, and the send buses. Clips the agent wrote and nobody approved are violet
  and dashed (worked out from the tape; approving the song or editing the row clears them). Song checks are drawn on the lanes and bars they name:
  masking is a dashed amber box over both channels and its stretch, with a label; selecting a flag shows the partner's notes behind the roll as ghost
  notes. The intensity selector (layered songs) picks which layers play. A drag on the ruler picks bars, and R asks for changes pinned to them and the
  selected channel. The cursor and every capability of the old page stay.
- **Roll and pattern text, in sync.** The piano roll sits beside the pattern text. Selected notes light their tokens; typing is read again after 300 ms,
  a problem is underlined with its message and nothing is written, and text that means something new is one `pattern set` (one pause, one batch). The
  caret stays; rows the agent wrote have a violet left border. The pattern grid is a tab. The instruments, helpers, song order and changes are in the
  inspector (⌥2), found by the palette.
- **The mixer** at `#/song/<id>/mixer` and in the bottom panel: a strip per channel (inserts, pan, a send knob per bus, a fader with a stereo meter, gain,
  the channel's own loudness or "silent here", M and S), the send buses, and the master (the limiter's ceiling and gain reduction, a vertical loudness
  target, short-term loudness, range and true peak). Each drag writes one `song channel set`, `song send`, `song fx set` or `song set`; the agent's
  last change shows the violet tick. A masking lane links clashing strips: a click solos both and loops the bars.
- **Live meters** come from a worker at about 30 Hz and are drawn every animation frame; React does not render at meter rate. Peak or short-term loudness.
- **New in core's measuring code:** `loudnessRange` (EBU Tech 3342), shown by the mixer and added to the song's JSON as `numbers.loudnessRange`. No render
  changed; the golden hashes are as they were.
- **Fixed:** the piano roll threw when the playing step was in a pattern that has no row for the channel; the typed-entry field of a knob or fader
  scrolled the page, which could move the control away from a double-click.

### States, accessibility and narrow windows
- **A new project** offers three starts that make something real as you, with the commands an agent uses: a sound from a preset (N; laser,
  pickup, jump, hit or explosion), a set of four footsteps as one family (⇧N) and a 16-bar loop in A minor (⌥N); under them, the CLI line an
  agent would run on this project.
- **A large project's first seconds**: rows still being worked out shimmer, and an ember line under the home header and the library counts
  the thumbnails (`index 400 · thumbs 37 / 400`).
- **Offline.** An amber banner with the server's address, the command that starts it on this folder, Retry and a countdown (1, 2, 4 … 30 s).
  Open sounds keep playing; edits apply on the page at once and are queued with a count and a "not sent" list, then sent in order on
  reconnect; refusals are listed with the server's reason. The presence pill reads "offline". A server started again on the same folder
  keeps its token, so open pages and links keep working.
- **Contrast** of 4.5:1 for text and 3:1 for large text and glyphs on every screen, in both themes and both densities, checked by a browser
  test that lists what it skips. Changed to pass: dark `--text3` `#858C9C` → `#8B92A2`, light `--you-text` `#0B6F66` → `#0A635B`, light
  `--ember-text` `#B9440A` → `#A03A08`; role colours used as text go through their `-text` tokens; the light warn button and keycaps on
  coloured buttons; nothing meaningful is faded with opacity.
- **Roles and keys**: envelope corners have value texts; a fresh browser opened on an item's address shows its tab; the shortcut sheet lists
  every key, including the ones that belong to one page (lenses, the clip grid, blind A/B).
- **Narrow windows**: no screen scrolls sideways at 1180, 1024, 900, 760 or 360 px, and the header drops what is said elsewhere, widest
  first, so the search button stays on screen.
- **Polish.** The numbers strip shows whole values (true peak was cut); a layered sound's device chain scrolls to the open device; drag
  tests wait for the page to settle; the presence pill says a few words (the sentence is its tooltip) and shrinks first; the song page has
  a velocity lane in view and a draggable divider kept per browser; session lanes are at least 180 px with one-line sticky headers and
  scroll sideways; the review's numbers are one line each; tape spans are labelled by their width ("6 cmds", with the full label as a
  tooltip); the mixer's master strip stays pinned while the strips scroll.
- **Fixed:** library rows could stay "– –" without a thumbnail when the home page's cards and the library wanted the same sound (a card
  that was never asked for gave back the row's claim); a failed thumbnail is now asked for again while in view. The numbers that come with cards reach the list together (once every 50 ms), not one
  list rebuild per card, so a burst of cards on a large project no longer makes a long task. The composer finds the failing check in a selection
  even before the sound's card has come (it could open without the check chip). A new project's starts
  overflowed the page when both side panels were open. A part of a page that throws shows an error in its place instead of blanking
  the whole page.

### The dashboard on large projects
- **A project of 400 sounds, 100 samples and 3,000 commands opens at once.** The page used to fetch every sample and render and measure
  every sound on its own thread before it listed anything (a 60-sound slice took 88 s and froze the tab; the whole project never finished).
  Now the list appears from the state frame (about 0.3 s for 400 sounds), thumbnails come from the server's cache as cards come into view,
  and scrolling never blocks (the longest task after the first paint was under 100 ms).
- **Cards come from the server.** Waveform peaks, the spectrogram, duration, loudness and the checks are worked out in worker threads, kept in
  `.cache/thumbs` by content, and served small (`/api/card/<id>.json`); the list's check badges and filters fill in as a quiet pass works through the
  project.
- **Playing renders in a Web Worker** that fetches only the samples the sound names; the editors measure long sounds there too. What the page plays
  is still the Node render, bit for bit.
- **The state frame for big projects** (more than 100 sounds): the list first, sound documents on demand, the newest 200 tape entries (earlier ones
  on a button), batches that carry only what they touched.
- **Lists are paged and filterable**: the sounds and the audition page show 48 cards and more as you scroll, with filters on name prefix, voice, status,
  checks and tag.
- Samples' hashes are kept in `.cache/samples.json` (starting a server on a hundred samples took seconds); the render cache writes files whole and
  renames them into place, so a worker never reads half a file.

### Fixes from the first real use of the music tools
- **`render-match` no longer forces musical compromises.** A note that touches the one before it has no rise in level to find; its onset is now found
  in the change of pitch (and a note of the same pitch as the one before has none to find). `instrument set <id> legato=yes` declares a legato voice
  (checking only: no sample changes). A decaying pluck whose pitch tracker locks onto a sub-harmonic is looked at again in the start of the note, where
  the written pitch must be the fundamental, so a plucked line passes without a helper layer; an octave or a semitone off still fails.
- `export --loop --loops <n>` repeats the loop region (it was ignored); stems take `--loops` too. Combinations that mean nothing are refused with what to do
  instead, for songs and for sounds.
- `export --stems --stems-through-master` runs the master chain's filters over each stem; the compressor and limiter cannot be split, and the export says so.
- `normalize` fits a layered song to every mix a game can play (the song gain and the gains above the base), and is a line of a `run` batch.
- Faster measuring: each channel is analysed once and the numbers are kept in `.cache/analysis` between processes; the mix is mixed only when something needs it;
  loudness is summed by steps. A 73 s seven-channel song: `check` 13 s before, about 1 s when nothing changed.
- `masking` lists its stretches (time range, the two channels, the band, how far apart), longest first.
- Notes keep their spelling (`Eb4` stays `Eb4` in the normal form and the messages); the helpers spell by the key (flats in a flat key); `scale` too.
- Song send buses: `song send <song> reverb|delay …`, and `song channel set … reverb=<0..1> delay=<0..1>`, one shared space for the piece.
- `chords`, `bass` and `arp` take `gate=<0..1>` and `legato=yes`.
- `view compare` takes a WAV or OGG file outside the project for either side (a reference), or a song's full mix.

### Music
- **Instruments** (`instruments/<id>.inst`): any voice (classic, osc, fm, ks, sample, layered, with effects) played at a pitch, with a note envelope,
  an optional pitch envelope, velocity sensitivity and a declared range. Eleven built-ins to play by name: `square_lead`, `pulse_lead`,
  `triangle_bass`, `saw_pad`, `fm_bell`, `fm_bass`, `pluck`, `kick`, `snare`, `hat`, `hat_open`. `instrument new|from-sound|set|layer|fx|env|copy|rename|remove`.
- **The pattern text**: a step grid per channel (`lead: C5 . E5 - | G5v80 . E5~slide .`), `-` hold, `.` rest, `|` bars, velocity, `!` for an
  accidental on purpose, `~slide` `~vib` `~arp(0,4,7)`, chords with `+`, drum hits as lower-case words, note lists, a normal form, and errors with line and column.
  Patterns live in their song (`songs/<song>/patterns/<name>.pat`); in scripts they are indented blocks.
- **Songs** (`songs/<id>.song`): tempo, swing, time signature, key, channels bound to instruments or a drum kit with gain, pan and a game layer, sections with
  repeats, an intro that plays once, a loop region, an ending, and a master chain. `song new|set|channel|section|order|intro|ending|loop|fx|copy|rename|remove|mark`.
- **Rendering**: deterministic and the same bytes in Node and in the browser; channels are cached parts; WAV and OGG export of the song, of the loop (seamless: the
  tail wraps into the start) and of the stems of each game layer; loudness classes `music` (-16 LUFS) and `stinger` (-14); `normalize` for a song.
- **MIDI**: `midi import` (type 0 and 1; tempo, time signature, tracks and channels, drums on channel 10) and `midi export` / `export --format midi` of a song or a pattern.
- **Ears**: the `notes` view (written notes against detected onsets and pitch, per channel) and the `mix` view (energy by band over time, masking in amber); song numbers
  (length, loop length, loudness, true peak, per-channel loudness, tempo); the checks `key`, `range`, `render-match`, `loop-music`, `masking` (advisory) and `clip`, `loudness`,
  `dc` on the mix. `work done` on a request about a song needs them to pass.
- **Dashboard**: song cards with play, the loop playing repeatedly, the pattern text read-only with the current step lit, and mute/solo for listening (not stored).
- The command text now reads `\n` in a quoted word as a line break (the pattern text on the tape).

### The music editor
- **A song's page** (`#/song/<id>`): the pattern grid (every channel; drum channels as a row per hit, painted by click or drag), the
  piano roll of a melodic channel (the key's notes shaded, out-of-key notes marked; click to add, drag to move, drag the end to
  lengthen, shift-drag to select, Delete, a velocity lane, slide/vibrato/arp from a small menu), the instrument panel (instrument,
  gain, pan, mute/solo for listening, game layer; an instrument's note envelope, velocity, root, range, pitch check and its voice with
  the sound editor's controls), the song order (sections as blocks to drag, repeats, intro and ending, the loop region on a bar ruler
  with handles), tempo, swing, key and time, and the helpers with a preview of the rows before Apply.
- **Playback with a cursor** across the grid, the roll and the ruler: play, play from the cursor, the selection repeating, the loop
  region repeating. After an edit only the changed channel renders again (its unchanged notes come from a cache, and the master
  limiter works out again only around the samples that changed, to the same bytes): one note change in a 35 s six-channel song
  plays again in about a third of a second.
- **Every edit is a command** an agent would write, one gesture one history entry: the new `pattern note add|remove|move|len|set`
  (one note at a time; the page never sends a pattern's whole text), `song order|section|loop|intro|ending|set|channel set`,
  `instrument set|layer|fx|env`.
- **`changes` covers songs and instruments**: per pattern the notes that went and came, the settings and sections that differ, and a
  before/after picture of the written notes.
- **Feedback tags on song cards**: too busy, too sparse, too loud, too repetitive, wrong mood, good; they reach the agent through `await`.

### Composition helpers
- **Helpers that write notes** into a pattern and go on the history tape with every option resolved and the rows they wrote
  (`written="…"`), so a replay puts back exactly those notes: `chords`, `bass`, `arp`, `drums`, `humanise`, `motif write|sequence`.
  Notes they write outside the key are marked `!`.
- **A pitch rule per instrument** for `render-match`: `instrument set <id> pitch-check=full|class|onset` (the note; the pitch class with
  the octave ignored; timing only). The built-in `fm_bell` uses `class` (its inharmonic partials make the pitch tracker hear an octave
  low), and the item-get stinger plays it again.
- **Scales and chords**: twelve more scales (`whole-tone`, `phrygian-dominant`, `hungarian-minor`, `hirajoshi`, `octatonic` …);
  `soundclaw scale <key> | list | <project> <song>` and the MCP tool `scale` print a key's notes and its chords by roman numeral.
- **`chords <song> <pattern> <channel> "<progression>"`**: roman numerals with inversions (`I6`, `V65`), sevenths, `sus2`/`sus4`, `add9`,
  borrowed (`bVII`, `iv`) and secondary (`V/V`, `V7/vi`) chords, lengths in bars, rhythms (`hold`, `beats`, `offbeat`, masks like `"x-.x"`),
  and voice leading within a range per channel (least motion, no parallel fifths or octaves where avoidable, sensible doubling).
- **`bass`** (root, root-fifth, walking, octave) and **`arp`** (up, down, updown, `random(<seed>)`, a rate, octaves), from a progression
  or following the chords another channel plays (`from=pad`).
- **Motifs**: named note lists kept in the song (`motif set`), transformed (`transpose` chromatic or diatonic, `invert`, `retrograde`,
  `augment`, `diminish`), written into patterns (`motif write`) and sequenced over a progression (`motif sequence`).
- **Drum templates**: rock, half-time, shuffle, march, waltz, ambient pulse and chiptune (sixteen in all), fills every N bars, seeded variation.
- **Humanise**: seeded timing and velocity written into the notes. The pattern text gains a nudge, `C5@-4` (−50 to 50 ms), on notes and drum hits.
- **Style guide and music bible**: `music-style.md` (tempo, key, scales, instrument palette, loudness classes, swing, `forbid:` rules,
  `## <tag>` sections) and `music-bible.md` (an entry per track: mood, tempo, key, tags, instruments, motif); `soundclaw style <project> [--init]`
  and the MCP tool `style`; `song new <id> from-bible=<entry>` (written to the tape as plain commands); songs have `tags`.
- **Stingers**: `song new <id> kind=stinger template=victory|game-over|level-up|item-get` in any key, as plain commands; a stinger never loops.
- **Layers**: `layer-plan <song> base=… tension=… combat=…` names the game layers and their order.
- **Checks**: `voice-leading` (advisory: parallel fifths and octaves in channels marked `harmony=yes`), `style` (the guide's rules and the
  song's bible entry), and `layers` (every mix of the base and the other layers within the loudness class, under the true-peak limit,
  with a clean seam; each layer alone in key).
- In the command text a `#` inside a word is part of it (`key=F#:dorian`); a comment starts at the start of a word.

### Fixes from the second large use
- **Samples**: a sample layer with no envelope and no trim plays the file as it is (no 2 ms fades, not cut by `duration=auto`), so `measure`
  of a reference equals the file. A stereo file stays stereo through `side=left` / `side=right` on two hard-panned layers (`sample import`
  prints the two commands; `measure` agrees with ffmpeg's `ebur128` within 0.2 LU). Files at 48 or 96 kHz (any rate) are converted to
  44,100 Hz with a Blackman-windowed sinc that keeps their loudness within 0.2 LU, and the import states the method. Sample names keep their
  case and are unique ignoring case. Renders of sample layers changed, so the render version moved and three layered goldens were regenerated
  (`sample-plain`, `sample-trim-pitch-reverse`, `sample-pitch-envelope`).
- **Sets**: in `set-spread` a member's own `loudness=` replaces the set's target for that member, and the check reports the per-member targets.
- **Bursts**: `bursts(times=... level=a,b,c)` takes a level for each hit.
- **Tails**: `duration=auto` and the `tail` check share one floor (60.3 dB under the peak, `DIED_AWAY`); a delay is given its echoes down to
  66 dB and a reverb its real 60 dB decay time (the largest rings for about 11 s, not 2.5), so delay and reverb sounds with `duration=auto` pass
  `tail`. Renders of delay and reverb sounds, and of sounds with a late faint piece, changed: `RENDER_VERSION` is 4 and 20 layered goldens were
  regenerated (`master-chain`, `amp-adsr`, `fx-delay`, `fx-reverb`, and the recipes footstep 1-2, door 1-3, magic 1-3, creak 1, bell 1 and 3,
  voice-vowel 1-2, voice-cluck 2, voice-giggle 2-3).
- **Limiter**: `limit` has `mode=true` (the default; the 4x-oversampled peak between the samples is held under the ceiling, so a limited
  burst train passes the `clip` check) and `mode=sample`; its default release is 20 ms (was 50), so each hit of a train is limited on its own.
  The recipes keep the sample-peak limiter and its 50 ms release they were tuned with; the `fx-limit` and `master-compress-limit` goldens moved.
- **Measuring**: a classic sound is measured as its exported WAV holds it (`trunc(s * 32000)` of 32768), so `measure` agrees with the file
  within 0.05 dB and with ffmpeg's `ebur128`; the clip check counts a run at that level as full scale.
- **Normalize**: a layered sound that gain 4 cannot bring to its target gets the rest from the new `out` (dB, after the master chain, up to
  +36 dB; `sound set <id> out=<dB>`), and an unreachable target is an error naming the sound and what it reaches, with nothing written.
  A classic sound's volume stops at the clip limit and the warning says how far short it is.

### Fixes from the first large use
- **Loudness classes**: the style names classes with a target and a tolerance (`ui`, `foley`, `impact`, `ambience`, `voice`,
  `music-sting`, and `standard`, the old -16 ±1), a default class, a class per sound (`sound set <id> class=<name>`, or `loudness=<LUFS>` for
  one sound) and per set (`set new … class=`, `set class`). The loudness check uses the sound's class and says so; `check` names the rule that
  binds when two checks pull against each other (harsh and loudness; clip and loudness). A request on a member of a set is done only when
  `set-spread` passes too. The sound page has a class menu.
- **Dynamics**: the `compress` and `limit` effects (per layer and on the master chain), deterministic; the checks measure the sound after
  the master chain, and the export limiter only guards the true-peak ceiling.
- **Decays**: an `exp` curve to zero is a true exponential that is 60 dB down at its end; `duration=auto` ends the sound where it is 60 dB
  down, inside a layer's source too; the `tail` check passes an ordinary exponential decay (1 dB of slack). Layered renders changed, so
  `RENDER_VERSION` is 2 and the layered goldens were regenerated.
- **Numbers for scripts**: `measure <project> [ids...] [--json]` (many sounds, one process), `--json` on `check`, `describe` and `render`,
  `normalize <project> <ids|set> [class | target=<LUFS>]`, `sample import <project> <folder>`. Analysis is about 2 times faster (a faster
  pitch tracker, and a true-peak search that skips what cannot matter).
- **Limits**: loops 0.1 to 120 s, samples and sources up to 120 s, envelopes up to 256 points, and the `bursts(...)` envelope generator
  for many hits in one layer (8 layers stays, and the error says what to do instead).
- **Loops**: `sound loop` lengthens the layers that are shorter than length + fade (and says which); the beds loop cleanly at any length.
- **Documents**: `sound copy`, `sound rename` (sets follow), `sound remove [--from-sets]`, all undoable; ids keep their case and are unique
  ignoring case; `set new … names="step_{n}"` or `as=a,b,c`.
- **Output**: `import` prints warnings first and one summary (`--quiet`, `--classic`); `view A compare B` says `A = …, B = …` and words the
  sign in that order.
- **Recipes**: `creak`, `bell`, `metal` (`metal-chain`, `metal-clank`), `glass` (`glass-shatter`, `glass-clink`), `voice` (`voice-vowel`,
  `voice-cluck`, `voice-giggle`); the footstep has no trailing silence; `ui-click`, `door` and `magic` got lengths and loudness that fit
  their class.

### Sets, loops, families, OGG and imports
- **Sets**: `set new <set> from=<sound> count=<n> [target=<LUFS>] [spread="freq±0.04 1.cutoff±15%"]` makes seeded variants of a
  classic or layered sound (each a real sound, `<set>_1` …), `set add|remove|retarget|regen`. The variants cover the stated range
  (stratified positions), a parameter driven by an envelope moves as a whole, and members are matched to the loudness target by
  gain: written on the history as `sound set … gain=` commands (a classic sound's gain is its `volume`, at most 1, and a shortfall is
  reported). The `set` view (members side by side with loudness bars, and the distance matrix) and the `set-spread` check (members
  not too alike and not too different, both limits in the style, loudness within ±1 LU).
- **Families**: `family <sound> near|far|muffled [as=<id>]` makes a copy by documented rules (far: quieter, darker, more reverb;
  muffled: low-passed behind a wall); its loudness is the source's plus the rule's offset and the loudness check is held to that.
- **Loops**: `sound loop <id> <seconds> [fade=<s>]` makes a layered sound a seamless loop (rendered past its end and crossfaded over
  its start), the `loop` view, the click check at the seam (jump against the local step, and the level step over 50 ms), and the
  ambience recipes `wind`, `rain`, `fire`, `crowd`.
- **Export**: OGG Vorbis (`libvorbis.js`, MIT, with Xiph.org's BSD licences; a dependency of the package, deterministic bytes);
  `export --all|--set <set> [--format wav|ogg] [--to <dir>]` with `manifest.json` (id, file, duration, loudness, channels, loop points,
  set), and `--pack` (a flat folder, sounds marked classic as rows of one `synth.csv`).
- **Import**: `import <project> jsfxr|bfxr <string | file>`: jsfxr's base58 / `sfxr.me` URL and JSON forms and Bfxr's settings
  string, each row reported as exact or approximated with what was lost.
- **Dashboard**: the audition page (`#/audition`, or `#/audition/<set>`): every sound as a compact card with play, check badge and
  feedback, play-all with gaps, filters (set, status, checks, tag), and the keyboard (arrows, space, `a`, `r`); a set's page
  (`#/set/<id>`): members in a row, play each or in sequence, regen with a new seed, the spread numbers; loop controls on a sound.

### The layered voice
- `voice=layered`: a sound of up to 8 layers, each with a start offset, gain, pan, its own state-variable
  filter, an amplitude envelope, effects and one source: the classic voice (sample for sample),
  an oscillator (sine, square with duty, saw, triangle, pulse, wavetable, white / pink / brown noise,
  periodic "metal" noise), FM (2 to 4 operators, four algorithms), a Karplus-Strong pluck, or an
  imported sample (trimmed, pitched, reversed). Deterministic and identical in Node and the browser
  (no platform `sin`, `exp`, `log` or `pow` in the render path), with goldens.
- Breakpoint envelopes (`lin`, `exp`, `hold`, `ease`) on any numeric parameter that allows one, and
  `adsr(a,d,s,r)` as a shorthand that writes breakpoints; a state-variable filter, distortion,
  bitcrush and sample-rate reduction, chorus, delay and a small reverb per layer and on a master chain, in a stated
  order; a limiter on export at the project style's true-peak ceiling.
- Commands: `sound new <id> voice=layered`, `layer add|set|remove|move|mute|solo`, `env`, `fx add|set|remove|move`,
  `sound layer-up` (a classic sound becomes layer 1, same samples), `sound classic <id> on|off` (keeps a sound one
  classic voice so it exports as a `synth.csv` row); `sample import|list` (CLI and MCP); a layered sound exports as WAV only.
- Stereo: a sound is stereo when a layer is panned (constant power); WAV export, the numbers and every check count
  both channels.
- Generators: layered recipes `footstep`, `ui-click`, `door`, `magic` (seeded, ranges as data) through `sound generate`
  and `preset=`.
- The `layers` view (each layer's waveform and spectrogram with offsets) and the `harsh` check (sustained 2-5 kHz
  energy above `harshLimitDb` for `harshMinMs`, both in the project style).
- The editor for layered sounds: a layer list (add, remove, reorder, mute, solo, gain, pan, offset), each source's
  controls, an envelope editor (drag a breakpoint, one command per drag), and the effect chains. Edits are
  commands written as `human:<name>`.

### The SFX editor
- A sound's page in the dashboard (`#/sound/<id>`, "Edit" on its card): the classic voice's 25
  parameters as sliders in sfxr's groups, each showing its value and range, double-click or ↺ for the
  default; wave buttons and a seed; the category buttons and `random`; mutate with an amount.
  Every change re-renders in the browser with the same core and replays (a *play on change*
  toggle, a stop button, space plays). Download the WAV (the pre-rendered form), the patch text
  or a CSV row.
- Human edits are commands: the page sends `sound set` / `sound generate` / `sound mutate` as
  `human:<name>`, the lines an agent would write; a drag is coalesced into one command (on release,
  or after a pause). Undo and redo work from the page.
- A/B: pin a snapshot (or another sound) as A, switch playback between A and the live B, *Keep A*
  restores A's parameters as one command.
- `sound generate <id> <category|random> [seed=<n>]`, and `random` (sfxr's randomize, with its ranges as
  data) as a preset.
- `changes <project> [--since …] [--by human] [--as …] [--peek]` and the MCP `changes` tool: what
  other hands changed since the agent last looked (a per-agent cursor), with parameters and numbers
  before and after and a compare PNG. The skill says to call it before editing a sound a person touched.
- Listening feedback on cards: quick tags (too loud, too quiet, too long, too short, too harsh, too
  dull, too similar to another sound, good) with free text become requests carrying the tags, shown on
  the card and delivered through `await`; `request --tag` from the CLI and `tags` on the MCP tool.
- A `synth.csv` with a repeated sound id is read as the engine reads it (first position, last row's
  values) with a warning naming both lines, instead of being rejected.

### The classic voice and the agent's ears
- The classic voice: sfxr's 25 parameters rendered sample-exactly (a port of a reference
  synthesiser, with a platform-proof sine and cube), noise seeded by FNV-1a, `sound new <id>
  voice=classic`, `sound set` with every parameter and `wave=` names, `sound patch`, and
  seeded generators by category (`preset=pickup|laser|explosion|powerup|hit|jump|blip`) whose
  ranges are data. `sound mutate` (or `mutate`) makes small seeded changes.
- sfxr single-patch text and `synth.csv`: `import <project> sfxr …`, and `export --format
  wav|patch|csv` (a classic WAV is the pre-rendered form, `trunc(s × 32000)`).
- The ears: numbers with every render (duration, loudness in LUFS, true peak, crest factor, DC,
  attack, tail, brightness, pitch, onsets), `view` (wave, spec, pitch, compare as PNG), `describe`,
  and a check summary line at the end of every render result.
- Checks (clip, loudness, dc, click, tail) with scores, thresholds and flagged time ranges:
  `check`; the targets come from `style` in `project.json`. `work done` is refused while the
  sound's checks fail.
- The dashboard card shows the classic parameters read-only, a spectrogram thumbnail and a check
  badge.
- The default port is 7427.


### The first skeleton (early; nothing is released yet)
- A project folder (`soundclaw new`): `sounds/`, `instruments/`, `songs/`, `sets/`, a history tape
  with authors (`agent:<name>`, `human:<name>`), `requests.jsonl`, and `exports/` ignored by git.
- The single writer: `soundclaw run <project> <file|->` applies a batch of commands as one undo
  group, and any error applies nothing. `undo`, `redo` and `history`.
- A placeholder voice: `sound new <id>` and `sound set <id> frequency= duration= volume=` make a
  sine tone, so the plumbing is real end to end.
- A deterministic pure-TypeScript renderer (44,100 Hz mono `Float32Array`; the same samples in Node
  and in the browser), 16-bit WAV export, and a content-hash render cache.
- `soundclaw serve`: MCP over stdio, HTTP and WebSocket, token and lock files, and the dashboard
  (sound cards with a play button, waveform, status, and the history).
- Requests: "Ask for changes" and "Approve" on a card; `soundclaw await` (exits with events) and the
  MCP `await_requests`; `soundclaw work list|claim|progress|block|done` and the MCP `work`.
- Per-command `--help` and `--version`; a Claude Code skill (`soundclaw skill install`).

[Unreleased]: https://github.com/retrodigio/soundclaw/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/retrodigio/soundclaw/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/retrodigio/soundclaw/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/retrodigio/soundclaw/releases/tag/v0.1.0
