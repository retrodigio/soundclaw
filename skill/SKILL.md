---
name: soundclaw
description: Make sound effects and music (instruments, patterns, songs) with SoundClaw, a workbench driven by commands through its MCP tools (project, run, history, changes, render, view, describe, check, measure, normalize, import, sample, export, request, work, await_requests) or the soundclaw CLI, while a person listens, approves and asks for changes in the browser. Use when asked to create, change or export game sound effects, or to work through a person's change requests on sounds.
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
run `npx soundclaw init` in the game's folder (or `claude mcp add soundclaw -- npx -y soundclaw
serve --project <folder>`), then restart Claude Code. Without MCP, use the `soundclaw` command
line, which does the same.

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
   A person's edits made while the server was down are queued in their page and arrive, in order,
   when it is back: a burst of `human:<name>` commands at once, so read `changes` after a
   restart too. A new project's start buttons make real items as the person (a preset sound, a set
   of four footsteps, a 16-bar loop): treat them like any other edit.
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
- Samples are named audio in the project's store. `sample import <project> <file or folder> as=<name> licence=<id>` (CLI `soundclaw sample import …`,
  MCP `sample`) reads WAV, AIFF and FLAC (OGG, MP3 and M4A when ffmpeg is installed) before a `sample` layer; a batch naming a missing sample is
  refused. Say where a file came from and under what licence when you know it: `licence=CC0-1.0`, `CC-BY-4.0` with `attribution="…"`, `own`;
  it is `unknown` otherwise, and the tool never guesses. Change a sample with the tape commands (`sample set <name> root=C4 tags=wood licence=own`,
  `sample rename`, `sample remove`) and look with `sample list` / `sample show`. A sample layer with no envelope and no `start`/`end` plays the file as
  it is (no fade, not cut), so `measure` of it equals the file. A 48 or 96 kHz file is converted with a windowed sinc (the import says so) and keeps
  its loudness. Channels are kept: `side=stereo` plays both channels of a stereo file in one layer (`side=left`, `side=right` and the default `mix`
  play one channel or the average). `soundclaw licence check <project>` (MCP `licence`) says which sounds may ship; a manifest export (`--all`, a set,
  `--pack`) refuses a sound that reaches an unknown or blocked licence unless you pass `--allow-licence <id>` (only if the person says so), lists the
  samples used and writes `ATTRIBUTION.txt`. Pointing a name at other audio (`sample set <name> hash=…`) is undoable like any edit. A 0.1 project's
  `samples/*.wav` still work; `soundclaw upgrade <project>` moves them into the store. `sample gc` is a dry run until `--apply`.
- Libraries are folders of recordings kept outside the project; the person (or you, from Bash or the MCP `library` tool's `add` and `index`) registers them once: `soundclaw library add <folder> licence=<id>` then
  `soundclaw library index` (minutes for thousands of files). From then on search by words and numbers, with the MCP `library` tool or the CLI:
  `library search "door creak" dur=0.8-2.5 pitched=no licence=shippable --limit 8` (every word must match a name, tag or folder; the numbers query is the one `sample list` takes; hits show length,
  loudness, note, centroid, attack, licence and a line of words), `library similar <project> <sound|sample:name|file>` for "recordings like the synth door I made" (a file needs no project), then
  `library use <project> <library>:<path> as=creak_lib` to copy one in (it keeps where it came from and the library's licence; a library with no declared licence is `unknown` and
  blocks a manifest export until someone sets one). Listen to a hit before building on it: after `library use`, `describe`, `view … sample:<name>` and `compare` it with your synth version.
  Add your own tags with `library tag` so the next search finds a file by what it is. Never read a library's folder by hand to find files: search it.
- Generate a sound effect when neither synthesis nor a library has it (voices, creatures, crowds, organic one-shots): first `soundclaw generate <project> sfx
  "<prompt>" duration=2 takes=3 as=creak --estimate` (MCP `generate` with `estimate: true`): it prints the cost, the budget left and what would refuse it, and
  calls nothing. Write the prompt as a sound designer would: source, action, material, distance, space ("the slow creak of an old wooden door hinge, close, dry,
  no reverb"); keep it dry and let the tool add the room. Then run it with `want="dur=1.5-2.5 centroid<2.5k attack<40ms"` (or `like=<your synth version>`) so
  the takes come back ranked, each with its numbers and words. Every take costs credits: the project's cap is 0 until the person sets one in `project.json`
  (`"generation": {"capCredits": n}`), and you never raise a cap or turn on music yourself; ask (a person sets a cap with `soundclaw generate cap <project> <credits>`, or on the page; there is no tool for it). Never put a key in a command, a file or a message; it comes
  from the environment (`ELEVENLABS_API_KEY`). Pick a take by listening (`describe`, `compare` with your synth version), shape it in the tool (`sample derive
  … op="silence-trim -50; fade out=80ms"`, layers with synthesis) rather than generating again and again, and `sample remove` the takes you drop.
  `generate <project> --again <take>` gives new takes of the same prompt; `generate --ledger <project>` shows what was spent. `provider=fake` makes free test audio.
- Samples are material you can edit and hear. Listen first: `describe <project> sample:<name>` (words and numbers: tonal or noisy, pitch and how steady, one hit
  or several, dry or roomy, mono or wide, silence at the ends, the licence and the advice), `view <project> sample:<name> wave|spec|pitch|loop|slices`,
  `compare <project> sample:<name> <the synth version>` for the distance numbers, and `sample check` for advice (a sample's checks never gate `work done`; the sound's do).
  Search the project's samples by numbers: `sample list "creak" dur=0.8-2.5 lufs>-30 centroid<2.5k attack<20ms pitched=no onsets=1 tag=wood licence=shippable`.
  Make what the moment needs from them with commands that are worked out once and written on the tape as numbers: `sample derive creak from=take op="silence-trim -50;
  fade out=80ms; normalize peak -3"` (ops: trim, fade, gain, normalize peak|lufs, silence-trim, dc, reverse, mono|left|right, pitch, stretch, loop, slice, mix; the parent's
  licence travels), `sample slice <name> at=onsets` then a layer plays `slice=2` (or `op="slice 2"` makes it a sample), `sample loop <name> find` then `layer add … loop=<seconds>
  xfade=0.02`, `sample bounce <new> from=<sound> [layer=<n>]` to freeze a synth render into a sample. A new sample layer is made with `interp=sinc` (no folding when pitched up);
  `stretch=` keeps pitch (`method=wsola` for hits and noise, `pv` for tones), `fade-in`/`fade-out` shape the ends. Layer a synth body with a recording: `layer align <id> 2 to=1
  by=onset`, `layer match <id> 2 to=1 db=-6`, `env <id> 2.amp follow=1`. Listen after each step and judge by ear, not only by the numbers.
- Sampled instruments. A recorded note or two becomes a playable instrument: `instrument new recorder kind=zones`, `instrument zones recorder from-samples rec_c4 rec_g4
  rec_d5 root=detect` (each root measured once and written as `root=G3 tune=-10`; key ranges split halfway between roots), `instrument set recorder legato=yes range=C4-G6
  adsr=0.02,0.1,0.9,0.15`. A sample with loop points (`sample loop <name> find`) sustains while the key is held (`loopmode=sustain`, the default), `continuous` goes on through
  the release, `oneshot` plays the whole sample whatever the key does (drums). Velocity layers are zones with `vel=1-70` and `vel=71-127` (`instrument set <id> velxfade=12` crossfades them);
  round robins are zones sharing keys with `rr=1/3`, `2/3`, `3/3`; a release sample is `trigger=release release-decay=<dB per second held>`; a closed hat cuts an open one with the same `choke=<n>`;
  a kit is an instrument whose zones are `hit=kick`, `hit=snare` (`pitched=no`), a drum channel `kit=<instrument>`. Then `check <project> <instrument>` (holes in the key-map, a zone more than
  10 cents off its root, a level step over 3 LU between neighbours, a looped zone's seam, round robins too alike) and `view <project> <instrument> keymap` (zones as boxes coloured by their checks):
  fix what it says (`instrument zone set <id> <n> tune=… gain=…`) before you write the song, then judge it in the song by ear and with `render-match`. `from-sample <id> <sample> loop=find` makes
  a one-sample instrument. `soundclaw instrument export <project> <id> --format sfz` takes it to a DAW. The samples' licences reach the instrument and every song that plays it.
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
- **Listening in a batch:** the dashboard's **Audition** page (`#/audition`, or `#/audition/<set>`) shows every sound as a row
  with the check badge; the person goes through them with the keyboard (arrows, space, `a` approves, `r` asks for changes) and
  their approvals and requests reach you through `await` as ever. A set has its own page (`#/set/<id>`): a grid of each member's
  last versions from the history, where your latest unapproved change is a column of its own, and a person may make an earlier
  version current again (a batch of ordinary commands written as them: read it with `changes` before you build on the sound).
  Both pages have the blind A/B card, whose answers reach you as `comparison` requests (below).

## Music: write a song in passes, and check each pass

A song is **instruments** (a voice at a pitch), **patterns** (a grid of notes per channel) and a **song** (tempo,
channels bound to instruments, the order of the patterns, the loop). The full reference is docs/commands.md
("Music"); `docs/examples/chip-exploration.txt` is a 16-bar loop written by hand, `docs/examples/compose-demo.txt` a
town theme, a layered battle loop and a stinger written with the helpers.
You cannot hear a song, so you work in passes and run `check <song>` after each: the failure is then in the
pass you just made.

0. **The brief.** `soundclaw style <project>` prints the project's music style guide (`music-style.md`: tempo range, scales,
   instrument palette, forbidden things, rules per tag) and music bible (`music-bible.md`: an entry per track with its mood,
   tempo, key, instruments and motif). Read it before you write a note; `style <project> --init` writes a starter pair.
   A track the bible names starts as `song new <id> from-bible=<entry>`: the tempo, key, tags, channels and motifs from the
   entry, written to the tape as plain commands. The `style` check holds the song to the guide and to its entry.
1. **Structure.** `song new <id> tempo=<bpm> key=<tonic:mode> time=4/4 tags=<tag>` (`soundclaw scale D:major` prints the
   key's chords by roman numeral; `scale list` every scale). Decide the sections and their length in bars first (a loop:
   8 bars of A, 8 of B ...), and the channels: `song channel add <song> <name> inst=<instrument>|kit=default`. Use the
   built-in instruments first (square_lead, pulse_lead, triangle_bass, saw_pad, fm_bell, fm_bass, pluck, kick, snare, hat,
   hat_open); `instrument new <id> from=<built-in>` then `instrument set` to change one. An inharmonic voice (a bell) is
   heard an octave off by a pitch tracker: `instrument set <id> pitch-check=class` has `render-match` check its pitch class
   only (`fm_bell` has it), `pitch-check=onset` its timing only. A legato voice (a recorder, a bowed string, a held drone) is
   declared with `instrument set <id> legato=yes`: `render-match` then finds the onset of a note that touches the one before it
   in the change of pitch, so a legato line need not be written detached to pass; plucked strings need no helper sine layer.
   A fanfare or jingle is a stinger:
   `song new win kind=stinger template=victory|game-over|level-up|item-get` writes a whole one in the project's key to edit.
2. **Harmony.** `chords <song> <pattern> pad "I vi ii65 V7" bars=1 rhythm=beats` writes the chords with smooth voice leading
   into the `pad` row (making the pattern when it is new: as long as the progression). Inversions (`I6`, `V65`), sevenths,
   `sus4`, borrowed (`bVII`, `iv`) and secondary (`V/V`) chords are written as they sound and marked `!` where they leave the
   key. `song channel set <song> pad harmony=yes` and the advisory `voice-leading` check warns about parallel fifths and octaves.
   One chord a bar is a good start; a progression shorter than the pattern repeats.
3. **Bass and motion.** `bass <song> <pattern> bass from=pad style=root-fifth|walking|octave|root` follows the chords you wrote;
   `arp <song> <pattern> arp from=pad pattern=updown rate=1/16` adds an arpeggio. Both stay in the instrument's range. Under C2 the
   `render-match` pitch check cannot hear the note. `chords`, `bass` and `arp` take `gate=<0..1>` (each note's length as a fraction
   of the time to the next, kept to whole steps, at least one) and `legato=yes` (hold each note right up to the next): for a slow,
   sustained style write `legato=yes`, for plucked notes `gate=0.5`. The notes are spelled by the key: flats in a flat key.
4. **Melody.** Put the tune in a motif: `motif set <song> theme "D5 - F#5 A5 B5 - A5 -"` (or the bible's), then
   `motif write <song> <pattern> lead theme at=0`, and develop it: `motif transpose ... by=2 mode=diatonic as=answer`,
   `invert`, `retrograde`, `augment`, `diminish`, and `motif sequence <song> theme <pattern> lead "I IV V I"` (the motif on each
   chord). A motif is notes you can read on the tape, never a seed. Then edit by hand where the line needs it (`pattern set`):
   hold with `-`, rest with `.`, `~slide`, `~vib`, `v80`. Keep the lead in the instrument's range (a sequence climbs: check it).
   `view <song> notes` draws the written notes against what the render plays: a red note differs.
5. **Drums.** `drums <song> <pattern> drums rock|rock-16|halftime|shuffle|march|waltz|pulse|chip|... fill=4 seed=1` writes a
   template into every bar with a fill every 4th and seeded variation; `drums,hats` gives the hats their own channel. Then
   `humanise <song> <pattern> all timing=6 velocity=6 seed=1` writes small timing nudges (`C5@-4`) and velocity changes into
   the notes. Both are seeded: the same command writes the same notes.
6. **Arrangement and layers.** `song section add <song> <name> <patterns...> x<n>`, `song intro`/`song ending` for a part that
   plays once, `song loop <song> <from>..<to>` for the repeating region (a stinger has `loop off`). For a game's adaptive
   music, `layer-plan <song> base=pad,bass tension=arp combat=drums,lead` names the layers in the order they stack; the `layers`
   check then plays the base with every mix of the others (as a game sums the stems, with no limiter) and holds each to the
   loudness class, the true-peak limit and a clean seam, and each layer alone to the key. `loop-music` checks the seam.
7. **Mix.** `normalize <project> <song>` writes `song set <id> gain=...` to the class target; with a layer plan it fits every mix
   a game can play into the class window in one command (the song gain, and the gains of the channels above the base), and tells
   you what still does not fit. It is also a line of a `run` script. Give the piece one space: `song send <song> reverb size=0.6`,
   then `song channel set <song> <channel> reverb=0.3` for each channel that should sit in it (the same for `delay`); the dry
   channels are unchanged. Then `view <song> mix`: channels sharing the main band at the same time are amber, and `masking`
   (advisory) lists the stretches with their time range, the two channels and the band. Fix it by moving a part to another
   octave, thinning its notes, or panning it, not by turning it down. To hold the work against a reference,
   `view <project> <song> compare ~/refs/target.wav` (a WAV or OGG outside the project; either side may be a file).

Every helper goes on the tape with every option resolved and the rows it wrote (`run` and `history` print them), so the
song replays to the same notes and you can see and edit what it did. `chords`, `bass`, `arp` and
`drums` rewrite the whole row of the channel they name in that pattern (`motif write` only the steps it covers): run them
before hand edits to that row, not after.

What the checks hold the song to: `clip`, `loudness` (class `music` -16 ±2 LUFS, `stinger` -14 ±2), `dc` (a pulse wave off 50 %
duty needs a high-pass), `key`, `range`, `render-match` (every note's onset within 20 ms and its pitch right), `loop-music`,
`masking` (advisory), `voice-leading` (advisory), `style`, `layers`. `work done` on a request about a song needs all but the two
advisory ones to pass. `export <song> --loop` is the seamless loop (`--loops <n>` repeats it), `--stems` one aligned file per game layer (before the master
chain: they sum to the mix; `--stems-through-master` runs the chain's filters over each stem, but not its compressor or limiter, so
the stems then sum louder than the mix), `--format ogg|midi`; combinations that mean nothing are refused; `midi import` brings a MIDI file in as a song. People mute and solo channels on
the song card for listening; that is not stored, and a request from a person on a song is a `song mark <id> rejected` with their
note. Change a pattern with `pattern set <song>.<name> "<text>"` (or the block form in a script), or one note at a time with
`pattern note add|remove|move|len|set <song>.<pattern> <channel> <step> …` (`pattern note move tune.verse lead 4 step=6 note=G5`).

**A person edits songs too**, in the music editor (`#/song/<id>`: the piano roll, the grid, the song order, the loop region,
the instruments, the helpers). Every edit they make is one of these same commands on the history as `human:<name>`. **Call
`changes` before you edit a song a person has touched**: it lists, per pattern, the notes they took out and put in
(`verse.lead: − E5 at 3; + G5 at 5`), the settings and sections they changed, and a before/after picture of the written notes.
Work from their version; do not rewrite a row they edited with a helper (helpers replace the whole row) without asking.
Feedback on a song card comes as tags (too busy, too sparse, too loud, too repetitive, wrong mood, good) with a note.

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
  and `fx add <id> limit ceiling=-1` (on the master chain, or `layer=<n>`; it holds the true peak between samples under the ceiling, so `clip` passes, and its 20 ms release limits each hit of a burst train on its own), then raise `gain`. The checks measure the sound after
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

**Read a request's target.** A request may be pinned to part of its item: the line says so after the note, in words.
`— pinned to 0.31–0.38 s` is a stretch of the sound (change what is heard there and leave the rest alone;
`view` with a window and `check` show it), `— bars 9–12 of lead` is bars of a song, optionally of one channel (edit
those bars in the pattern text, leave the others), `— parameter decay` or `— parameter cutoff of effect 1 on layer 2`
is the control the person pointed at (start there), `— layer 2` is a layer, and `— the item as a whole` is no
narrower than the sound or song. Text such as `[attached: click check: …; moment: "…"]` at the end of a note is the
failing check inside the selection and the moment the person had in mind. When you file a request yourself, pin it
the same way with `--target "range 0.31-0.38"` (also `"bars 9-12 lead"`, `"param decay layer 2 fx 1"`, `"layer 2"`,
`"item"`; the MCP `request` tool takes the same text or an object).

**Being reviewed.** When you finish a request the person reviews it in the dashboard: your commands for it, before and
after, the parameters, the numbers and the checks, with your `done` text as the note, so say what changed and why in a
sentence. They approve it, revert it (one batch of theirs that restores the earlier values), or ask again: that
arrives as a new request with `(asks again about r3)`; read `history --sound <id>` and the old request's `done` text,
because what you did was not enough or not right. If they are editing the sound while you work, your change waits
behind a chip until they take it, so keep going and do not rewrite it. A batch of many items (`set new … count=8`,
`set regen`, a `run` of many commands) shows the person how far it has got; prefer one batch to many single commands
when the items belong together.

### The moment, and blind comparisons

**Give every sound you make for a known situation a moment**: `sound set <id> moment="The player walks
slowly across a meadow at night; steps repeat every 0.4 s under quiet music"` (a set's members can share one:
`set moment <set> "…"`; `moment=none` clears it). Say what happens in the game, how often the sound repeats
("every 0.4 s"), and what plays under it. It is words only: no render reads it, so it never changes a sound.
`describe` and the run summaries print it, and a change request's brief carries it, so judge your edits
against it too.

People compare versions blind in the dashboard: two cells of a set's grid (a sound at two points on the
tape, or two sounds) play level-matched with the names hidden, under the fixed question "Which one fits
better in this moment?". Each answer arrives through `await` as a **comparison**:

```
comparison r5 (step_2) from human:ana at …: A fits better in "walks slowly across a meadow at night":
  A was step_2 as at #12 (gain +1.2 dB), B was step_2 as at #20 (gain −0.3 dB)
```

How to read and use one:

- `#12` and `#20` are tape numbers: `history --sound step_2` shows what each version was (the state after
  that entry). The gains matched their loudness, so the preference is not about level: look at what else
  differs (`view <sound> compare <other>` for two sounds; for two versions of one, the commands between them).
- **A or B fits better**: keep the direction of the winner in what you make next. If the loser is the current
  version, the person may restore the winner from the grid themselves; do not undo their choices.
- **Both would do**: that difference does not matter in this moment; spend effort elsewhere.
- **Neither would do**: both miss the moment; read the moment again and move away from both.
- "(no moment given)": write a moment for the sound (ask the person if you do not know the situation).
- Nothing is asked to change: claim it with `work`, then close it with `work(action="done", text="<what you take from it>")`.
`soundclaw request <project> <sound> --note "…"` files a request yourself (for the person to see).

## House rules

- Never edit files in the project folder by hand: `history.jsonl` is the source of truth and
  `sounds/*.sfx` are rewritten from it. Everything goes through commands.
- One thing per batch when you can: a small, named change is easy for a person to undo.
- Do not run `soundclaw` commands that write while another process edits the same folder without
  a server: serve it (`soundclaw serve`) and let the commands go through it.
- Never leave servers or background waits running when you finish.

Full command reference: `commands.md` beside this file.
