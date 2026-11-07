# Changelog

All notable changes to SoundClaw are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
