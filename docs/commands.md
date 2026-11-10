# Command reference

Everything an agent does goes through two surfaces that do the same things: the `soundclaw` command
line and the MCP tools of `soundclaw serve`. Run `soundclaw <command> --help` for one command's
usage and `soundclaw --version` for the version.

Project folders are named anything; `*.sclaw` is the convention.

## The command language

A batch is text sent with `soundclaw run` (or the MCP `run` tool): one command per line or
separated by `;`, `#` at the start of a word starts a comment (inside a word, as in `key=F#:minor`, it is part of it), words are separated by spaces, text goes in "double
quotes". A batch is **one undo group**: every command is checked against a copy of the sounds
first, and if any fails nothing is applied (not a line of history, not a file). Errors are
reported with their line and column.

Each command has a *normal form*, which is what is written on the history, so a history replays
exactly. `sound set beep frequency=880.0 volume=.4` is stored as `sound set beep frequency=880 volume=0.4`.
A person's edits in the dashboard are commands in the same forms, written as `human:<name>`: the
editor writes `sound set` with the parameters in the table's order and the wave by name
(`sound set zap wave=saw freq=0.45`), exactly the line an agent would write.

| Command | Does |
|---|---|
| `sound new <id>` | Make a sound. Ids are `a-z`, `A-Z`, `0-9`, `_` and `-`, start with a letter, at most 48 characters. An id keeps its case as written (file names in engines are case-sensitive) and is unique ignoring case (`Click` and `click` cannot both exist, so two sounds never share a file on a case-insensitive disk). A new sound is a 440 Hz, 0.5 s, volume 0.5 sine tone (the placeholder voice). |
| `sound new <id> voice=classic [preset=<category>] [seed=<n>]` | Make a classic-voice sound: the 25 sfxr-style parameters at their defaults, or generated from a category (below). `preset=` alone means `voice=classic`. Without `seed=` the seed comes from the category and the id, and is written into the normal form. |
| `sound set <id> <param>=<value> ...` | Change parameters (those of the sound's voice, below). Values outside a range are errors. `wave=square\|saw\|sine\|noise` takes names. `seed=<n>` fixes the noise stream; `seed=auto` goes back to the hash of the values. |
| `sound patch <id> "<single-patch text>"` | Replace all 25 values from sfxr patch text: numbers in positional order (an empty field keeps the default) or `name=value` pairs, with an optional version line first (write the line break as `\n` inside the quotes). |
| `sound generate <id> <category\|random> [seed=<n>]` | Replace a classic sound's 25 values with a new patch from a category or from `random` (below). The seed used is written into the normal form, so a history replays. This is what the editor's category and `random` buttons write. |
| `sound mutate <id> [amount=0.05] [seed=<n>] [as=<new id>]` | A small seeded change to a classic sound (also written `mutate <id> ...`): each parameter except the wave and the volume moves, with a chance of one half, by up to `amount`, kept in its range. `as=` leaves the original alone and makes a new sound. The seed used is written into the normal form. |
| `sound mark <id> approved\|rejected\|draft ["note"]` | Set the sound's status. People use the dashboard's Approve and Ask for changes buttons, which write this. |
| `sound new <id> voice=layered [preset=<recipe>] [seed=<n>]` | Make a layered sound: up to 8 layers, envelopes, effects (below). `preset=` takes a layered recipe (`footstep`, `ui-click`, `door`, `magic`) or a classic category (one classic layer). The seed (the sound's noise seed; the recipe's seed too) is written into the normal form. |
| `sound set <id> duration=<s\|auto> gain=<g> out=<dB> seed=<n>` | On a layered sound: its length (`auto` follows the layers), master level (before the master chain), output level in dB (after it) and noise seed. |
| `sound set <id> class=<name>\|none loudness=<LUFS>\|auto` | On any sound: its loudness class (what the `loudness` check holds it to: "Loudness classes" below), or a loudness for this sound alone. The class must be in the project's style. |
| `sound set <id> moment="<text>"\|none` | On any sound: the moment, the situation in the game the sound is for ("The player walks slowly across a meadow at night; steps repeat every 0.4 s under quiet music"). Words only, at most 400 characters: no render reads them, so a moment never changes a sound's samples or hash. `describe`, the run summaries and a request's brief show it, and the dashboard's blind A/B asks which version fits better in it. `moment=none` clears it. It may share a `sound set` with other values. |
| `sound copy <id> <new>` | A copy of the sound under a new id, as a draft, in no set. |
| `sound rename <id> <new>` | Give the sound a new id (a case-only change is allowed); the sets that name it (members, source) and the variants that name it as their source follow. |
| `sound remove <id> [--from-sets]` | Remove a sound. Refused while a set names it (as a member or as its source), unless `--from-sets`, which takes it out of those sets first. All three are commands on the history: `undo` brings the sound back. |
| `sound loop <id> <seconds>\|off [fade=<s>]` | Make a layered sound a looping bed, `<seconds>` long (0.1 to 120), its seam made seamless by a crossfade of `fade` seconds (0.02 to 2, at most half the length, default 0.5); `off` ends it. Layers shorter than length + fade are lengthened (see "Loops"). |
| `set new <set> from=<sound> count=<n> [target=<LUFS>] [class=<name>] [names="<template>" \| as=<id>,<id>,...] [spread="<param>±<amount> ..."] [seed=<n>]` | Make a set of `count` (1 to 32) seeded variants of a classic or layered sound, each a real sound named `<set>_1` … `<set>_<n>` (or by `names="step_{n}"`, where `{n}` is 1, 2, ..., or by an explicit list `as=`), matched to the loudness target (or the class's) by gain. See "Sets". |
| `set add <set> <sound>...`, `set remove <set> <sound>...` | Put existing sounds into a set (they are matched to its target), or take them out (they stay as sounds). |
| `set retarget <set> <LUFS>\|none` | Change the loudness the members are held to and matched to (`-20` or `-20LUFS`), or stop matching. |
| `set class <set> <name>\|none` | The loudness class of the members that have none of their own; with no target on the set, they are matched to the class's target. |
| `set moment <set> "<text>"\|none` | The moment of the set's members: a member with no moment of its own is judged in this one (`describe` says `moment (of set steps)`). |
| `set regen <set> [seed=<n>] [spread="..."]` | Make the generated members again from the source as it is now, with a new seed (and, if given, new rules). |
| `family <sound> near\|far\|muffled [as=<id>]` | A copy of the sound as heard near, far away or through a wall (default id `<sound>_<kind>`). See "Families". |
| `sound layer-up <id>` | A classic sound becomes layered: the classic voice is layer 1, the very same samples. Refused on a sound marked classic. |
| `sound classic <id> on\|off` | Mark a classic sound as classic: it must stay one classic voice, so it refuses `sound layer-up` (and the layer and effect commands refuse it as ever), and it exports as a `synth.csv` row. |
| `layer add <id> classic\|osc\|fm\|ks\|sample [<param>=<value> ...] [at=<n>]` | Add a layer with a source (below). A classic layer also takes `preset=<category>` (`presetseed=<n>`) or `patch="<single-patch text>"`. |
| `layer set <id> <n> <param>=<value> ...` | Change a layer's parameters; `source=<kind>` changes its source (the source's parameters go back to their defaults). A fixed value replaces any envelope on that parameter. |
| `layer remove\|move\|mute\|solo <id> <n> [to=<m> \| on\|off]` | Remove a layer, move it to a position, mute or solo it (`on` is the default; `off` undoes). If any layer is soloed only soloed layers sound. Layers count from 1. |
| `env <id> <target> "<breakpoints>"` | An envelope on a parameter (below). Also `adsr(a,d,s,r[,hold])` for an amplitude envelope, `bursts(...)` for repeated hits, and `clear`. |
| `fx add <id> [layer=<n>] <kind> [<param>=<value> ...] [at=<k>]` | Add an effect to a layer's chain (or, without `layer=`, to the master chain). |
| `fx set\|remove\|move <id> [layer=<n>] <k> ...` | Change an effect's parameters, remove it, or move it to a position (`to=<m>`). Effects count from 1. |
| `undo [group=<g>] [by=<author>]` | Take a group out of effect: the latest one still in effect, a named one, or an author's latest. |
| `redo [group=<undo group>] [by=<author>]` | Take back an undo: the latest undo still in effect, a named one, or an author's latest. |

`undo` and `redo` run alone, as the only command of their batch. They are refused when a later
change depends on what they would remove (undoing the batch that made a sound while a later batch
changes it): undo the later changes first.

### Parameters of a sound

**The tone voice** is a placeholder, a plain sine. It has no fade, so it always fails the `tail`
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

**Presets** (`sound new <id> voice=classic preset=<category> [seed=<n>]`, and `sound generate`): each category draws from
the ranges below. They are data (`CATEGORIES` in `core/src/generators.ts`), not hidden code; a
parameter a category does not mention keeps its default. "Always" is applied first, then one of
"One of" by weight, then each "Maybe" on its own with its chance. Values are rounded to three
decimals. The same category and seed always give the same sound. `random` is sfxr's randomize: any sound,
with every parameter group used with the chance written in its row (uniform draws, not sfxr's
hidden power-law shaping).

| Category | Meaning | Always | One of (weight) | Maybe (chance) |
|---|---|---|---|---|
| `pickup` | a short bright blip: coins, items | wave 0; attack 0; sustain 0..0.1; decay 0.1..0.5; punch 0.3..0.6; freq 0.4..0.9 | - | changeSpeed 0.5..0.7; changeAmount 0.2..0.6 (0.5) |
| `laser` | a falling zap: shots, beams | attack 0; sustain 0.1..0.3; decay 0..0.4 | wave one of 0, 1, 2; freq 0.5..1; minFreq 0.2..0.3; slide -0.35..-0.15 (2) / wave one of 0, 1, 2; freq 0.3..0.9; minFreq 0..0.1; slide -0.65..-0.35 (1) | duty 0..0.5; dutySweep 0..0.2 (0.5) / punch 0..0.3 (0.5) / phaserOffset 0..0.2; phaserSweep -0.2..0 (0.33) / highPass 0..0.3 (0.5) |
| `explosion` | a noise burst that falls away: blasts, crashes | wave 3; attack 0; sustain 0.1..0.4; decay 0..0.5; punch 0.2..0.8 | freq 0.01..0.25; slide -0.1..0.3 (1) / freq 0.04..0.81; slide -0.4..-0.2 (1) | repeatSpeed 0.3..0.8 (0.5) / phaserOffset -0.3..0.6; phaserSweep -0.3..0 (0.5) / vibratoDepth 0..0.7; vibratoSpeed 0..0.6 (0.5) / changeSpeed 0.6..0.9; changeAmount -0.8..0.8 (0.33) |
| `powerup` | a rising sweep: power-ups, level-ups | attack 0; sustain 0..0.4; decay 0.1..0.5; freq 0.2..0.5 | slide 0.1..0.5; repeatSpeed 0.4..0.8 (1) / slide 0.05..0.25 (1) | wave 1 (0.5) / duty 0..0.6 (0.5) / vibratoDepth 0..0.7; vibratoSpeed 0..0.6 (0.25) |
| `hit` | a sharp impact: hurt, thud, punch | attack 0; sustain 0..0.1; decay 0.1..0.3; freq 0.2..0.8; slide -0.7..-0.3; wave one of 0, 1, 3 | - | highPass 0..0.3 (0.5) / duty 0..0.6 (0.33) |
| `jump` | a short upward chirp: jumps, bounces | wave 0; attack 0; sustain 0.1..0.4; decay 0.1..0.3; freq 0.3..0.6; slide 0.1..0.3; duty 0..0.6 | - | highPass 0..0.3 (0.5) / lowPass 0.4..1 (0.5) |
| `blip` | a very short tick: menu moves, selections | wave one of 0, 1; attack 0; sustain 0.1..0.2; decay 0..0.2; freq 0.2..0.6; highPass 0.1 | - | duty 0..0.6 (0.5) |
| `random` | anything: every parameter group used with the chance written here | wave one of 0, 1, 2, 3; attack 0; sustain 0.05..0.4; decay 0.05..0.5; freq 0.1..0.9; punch 0..0.5 | - | attack 0.02..0.15 (0.3) / slide -0.5..0.5 (0.6) / minFreq 0.05..0.3 (0.2) / deltaSlide -0.3..0.3 (0.2) / vibratoDepth 0..0.6; vibratoSpeed 0.1..0.6; vibratoDelay 0..0.4 (0.3) / changeSpeed 0.3..0.9; changeAmount -0.8..0.8 (0.3) / duty 0..0.8; dutySweep -0.3..0.3 (0.4) / repeatSpeed 0.3..0.9 (0.2) / phaserOffset -0.4..0.6; phaserSweep -0.3..0.3 (0.25) / lowPass 0.2..0.9; lowPassSweep -0.3..0.3; resonance 0..0.5 (0.3) / highPass 0..0.4; highPassSweep -0.2..0.2 (0.3) |


### The layered voice

A layered sound is up to 8 layers added together. Use it when one sfxr voice is not enough: an impact
(a low sine thump + a noise burst + a click), a door, a spark, a footstep. A sound that is one sfxr
voice stays classic. A layered sound is mono until a layer is panned off centre, then **stereo**.

**The order.** A layer is processed in this order, always:
`source → filter → amplitude envelope → effects (in the order of the list) → gain → pan`; then the sound:
`sum of the layers → master gain → master effects (in the order of the list) → [limiter, on export]`.

**Every layer** has (these also come after the source's own parameters):

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `offset` | 0 to 120 s | 0 | - | when the layer starts, from the start of the sound |
| `gain` | 0 to 4 | 1 | yes | level of the layer (1 = as made) |
| `pan` | -1 to 1 | 0 | yes | -1 left … 1 right; any layer off centre makes the whole sound stereo |
| `filter` | `off`, `lp`, `hp`, `bp`, `notch` | off | - | the layer's own filter: off, lp, hp, bp or notch |
| `cutoff` | 20 to 20000 Hz | 1000 | yes | filter cutoff (centre for bp and notch) |
| `q` | 0.5 to 20 | 0.707 | yes | filter resonance (Q); 0.707 is flat, higher rings at the cutoff |
| `seed` | 0 to 4294967295 (whole) | from the sound | - | the noise seed of this layer (default: from the sound's seed and the layer) |

`offset` places the layer in time. A layer without an amplitude envelope fades in and out over 2 ms
(so it never clicks; a classic source keeps its own envelope and no fade). The seed of a layer's noise is
`seed` if given, else derived from the sound's seed and the layer (it does not change when layers are
moved or other parameters are edited).

**Sources.** `layer add <id> <kind> ...`:

*classic*: the full 25-parameter voice (above), sample for sample as a classic sound renders it
(`sound layer-up` makes a classic sound's layer exactly that). Parameters as in the classic table,
`wave` by name or number; plus `seed` (the patch's noise seed; without it, the hash of the values).
A classic layer's own envelope parameters are the classic ones; breakpoint envelopes do not apply to them.

*osc*: an oscillator. `square` is bipolar (+1 for `duty` of each cycle, then −1); `pulse` is unipolar with its mean
removed and its peak scaled to ±1 (a narrow `duty` gives a spiky pulse); `saw` and `triangle` start at zero; the
noises are white, pink (Kellet's filter), brown (a leaky integral) and `metal` (a 15-bit shift register with the short
feedback tap: a 93-step pattern, so it has the pitch `freq`). Waves are not band-limited: a high saw aliases, as sfxr's does.

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `wave` | `sine`, `square`, `saw`, `triangle`, `pulse`, `wavetable`, `white`, `pink`, `brown`, `metal` | sine | - | sine, square (duty), saw, triangle, pulse (unipolar, duty), wavetable, white / pink / brown noise, metal (periodic noise, pitched by freq) |
| `freq` | 20 to 20000 Hz | 440 | yes | pitch (the pitch of metal noise too; noise ignores it) |
| `duty` | 0.01 to 0.99 | 0.5 | yes | square and pulse: the high part of each cycle |
| `table` | text | organ | - | wavetable: organ, bell, reed, hollow, or 4 to 64 numbers like "0,0.5,1,0.5,0,-0.5,-1,-0.5" |
| `dur` | 0.01 to 123 s | 0.3 | - | length of the source |

Wavetables: `organ`, `bell`, `reed`, `hollow` (built from harmonics) or your own: `table=0,0.8,1,0.2,-0.5,-1,-0.3,0`
(4 to 64 numbers, read with linear interpolation).

*fm*: 2 to 4 operators, each a sine at `freq × ratio`. Operator 1 is always a carrier; `index2..4` is how strongly operator
2, 3, 4 modulates its target (radians of phase modulation; 0 silences the modulator, and with every index 0 the sound
is its carrier sine bit for bit). Algorithms: `chain` 4→3→2→1; `fan` 2, 3 and 4 all modulate 1; `pairs` 2→1 plus 4→3,
carriers 1 and 3 added; `parallel` all added. Carriers are added at their `level` and divided by their count.

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `freq` | 20 to 20000 Hz | 440 | yes | base pitch; each operator runs at freq × its ratio |
| `dur` | 0.01 to 123 s | 0.3 | - | length of the source |
| `ops` | 2 to 4 (whole) | 2 | - | how many operators (2 to 4) |
| `algo` | `chain`, `fan`, `pairs`, `parallel` | chain | - | chain: 4→3→2→1; fan: 2, 3 and 4 all modulate 1; pairs: 2→1 and 4→3 added; parallel: all added (no modulation). Operator 1 is always a carrier |
| `ratio1` | 0.25 to 16 | 1 | - | operator 1 frequency ratio |
| `ratio2` | 0.25 to 16 | 2 | - | operator 2 frequency ratio |
| `ratio3` | 0.25 to 16 | 3 | - | operator 3 frequency ratio |
| `ratio4` | 0.25 to 16 | 4 | - | operator 4 frequency ratio |
| `index2` | 0 to 20 rad | 1 | yes | how strongly operator 2 modulates its target (0 = silent modulator) |
| `index3` | 0 to 20 rad | 0 | yes | operator 3 modulation depth |
| `index4` | 0 to 20 rad | 0 | yes | operator 4 modulation depth |
| `level1` | 0 to 1 | 1 | yes | operator 1 output level |
| `level2` | 0 to 1 | 1 | yes | operator 2 level when it is a carrier (pairs, parallel) |
| `level3` | 0 to 1 | 1 | yes | operator 3 level when it is a carrier |
| `level4` | 0 to 1 | 1 | yes | operator 4 level when it is a carrier |

*ks*: a Karplus-Strong plucked string: a burst of filtered noise in a tuned delay loop with an averaging filter and a
fractional-delay all-pass, so the pitch is exact. `decay` is the time the string takes to fall by 60 dB (the fundamental;
the highs fall faster).

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `freq` | 20 to 20000 Hz | 220 | - | pitch of the string |
| `dur` | 0.01 to 123 s | 1 | - | length of the source |
| `decay` | 0.05 to 10 s | 1 | - | time for the string to fall by 60 dB |
| `bright` | 0 to 1 | 0.8 | - | brightness of the pluck (0 dull … 1 bright) |

*sample*: a named sample of the project (see [Samples](#samples): `soundclaw sample import <project> <file | folder> [as=<name>]` reads WAV,
AIFF and FLAC, and OGG, MP3 and M4A through ffmpeg; a layer plays at most 120 s of it). A sample's name keeps the case of the file name (or of `as=`), like
a sound's id, and two names that differ only in case are refused (`Boom` and `boom`); a layer names it exactly. The layer plays the file
as it is: with no amplitude envelope and no `start`/`end` there is no fade at either end and `duration=auto` does not cut it, so `measure`
of a sound that only plays a file measures the file (a trimmed layer, or one with an envelope, still gets the 2 ms fades).

*Rate.* A file at a rate other than 44,100 Hz is converted to 44,100 Hz when a layer plays it, by a Blackman-windowed sinc
(deterministic, the same bytes in Node and the browser): the kernel's cut-off is 95% of the lower of the two Nyquist frequencies
(20.9 kHz when a 48 or 96 kHz file goes down, so nothing folds back), its length gives a transition band of about 5% of that rate,
and its passband gain is 1, so the loudness is kept (within 0.2 LU, tested on 22.05, 32, 48 and 96 kHz files). `sample import`
prints this method for a file whose rate is not 44,100 Hz. After that the sample is trimmed by `start` and `end` (seconds of the
file), transposed by `pitch` (its length changes with it) and optionally backwards. The edits below (`slice`, `stretch`, `loop`, fades) come between
the trim and the pitch; `interp` says how the sample is read between its frames.

*Edits of one layer.* `slice=<n>` plays slice *n* of the sample (counted from 1, from its slice point to the next; see `sample slice`).
`fade-in` and `fade-out` are straight-line fades over the first and last seconds that play. `stretch=<ratio>` makes it longer or shorter without a change of
pitch (`2` plays twice as long), by `method=wsola` (hits, speech, noise: onsets are kept in place) or `method=pv` (a phase vocoder, for tones and pads);
a stereo layer is stretched with both channels together, so they stay aligned. `loop=<seconds>` repeats the sample's loop points (or, with none, the part that
plays) until the layer is that long, with an equal-power crossfade of `xfade` seconds at each seam. `interp=linear|cubic|sinc` reads between frames: `sinc` is
a windowed sinc whose cut-off follows the playback ratio, so pitching up does not fold high content back (alias energy under -60 dB an octave up, tested);
**a layer added now is written with `interp=sinc`**, while a document that never names `interp` reads, renders and keeps its render key exactly as it did
before the setting existed (`linear`). None of these is in a layer's text or render key until it is set. Slice and loop points are the sample's own
(`sample slice`, `sample loop`): changing them changes the render key of the sounds that play the sample, and nothing else.

*Stereo.* Channels are kept in the store. `side=mix` (the default) plays the average of all the file's channels; `side=left` and
`side=right` play one channel of a stereo file; `side=stereo` plays both, the left channel to the left and the right to the right,
through one layer's filter, envelope, effects and gain (each channel is processed on its own, so the layer's effects hear a left and a right;
the layer's `pan` does not apply to it, and a mono file plays the same in both):

```
layer add boom sample sample=Wind side=stereo
```

The older two-layer form still works and renders as before (`side=left pan=-1` and `side=right pan=1`; `measure` of a sound made that way agrees
with ffmpeg's `ebur128` on the file within 0.2 LU). `sample import` says how to use a stereo file. A batch that names a sample that is not in
the project is refused. The render key includes the audio's hash.

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `sample` | text | none | - | the name of a sample in the project (soundclaw sample import <project> <file> as=<name>) |
| `start` | 0 to 120 s | 0 | - | trim: where in the sample to start |
| `end` | 0 to 120 s | 0 | - | trim: where to stop (0 = the end) |
| `pitch` | -48 to 48 semitones | 0 | yes | transposition (the sample's length changes with it) |
| `reverse` | 0 to 1 (whole) | 0 | - | 1 plays it backwards |
| `side` | `mix`, `left`, `right`, `stereo` | mix | - | which channel of a stereo file: mix (both averaged), left or right (a mono file is the same in each), or stereo: both channels, left to the left and right to the right, through one layer's filter, envelope and effects (the layer's pan does not apply; a mono file plays in both) |
| `slice` | 0 to 1024 (whole) | 0 | - | play only slice n of the sample (1 = from its first slice point to the next; 0 = the whole sample): see `sample slice` |
| `fade-in` | 0 to 10 s | 0 | - | fade the start of what plays in over this long |
| `fade-out` | 0 to 10 s | 0 | - | fade the end of what plays out over this long |
| `stretch` | 0.25 to 4 | 1 | - | time stretch without a change of pitch: 2 plays it twice as long (applied before `pitch`) |
| `method` | `wsola`, `pv` | wsola | - | how `stretch` works: wsola (hits, speech, noise) or pv (a phase vocoder: tones, pads) |
| `loop` | 0 to 120 s | 0 | - | repeat the sample's loop (its loop points, else the part that plays) until the layer is this long; 0 plays it once |
| `xfade` | 0 to 2 s | 0.01 | - | crossfade at each seam of `loop` |
| `interp` | `linear`, `cubic`, `sinc` | linear | - | how the sample is read between its frames: linear (what documents without this setting use), cubic, or sinc (a windowed sinc whose cut-off follows the pitch, so pitching up does not alias; new layers are made with sinc) |

*grain*: a cloud of grains cut from a sample, for beds and textures from short recordings (rain, a crowd, fire, a hum, a machine): `layer add bed grain sample=rain dur=8
density=30 size=0.06 position=0.5 spread=0.3`. A grain is a Hann-windowed piece of the sample `size` seconds long, centred on `position` (0 the start of the sample, 1 its end) moved by up
to `spread` of the sample either way, read at the pitch's ratio; one starts `density` times a second, the gap between them varied by `jitter` (0 is regular). The moves come from the
layer's seed (`seed=`, else the sound's seed and the layer), drawn in a fixed order, so the same layer is the same cloud on every machine; another `seed` is another cloud. A grain is
kept inside the sample, and the level is divided by the square root of the grains sounding at once (when there is more than one), so a dense cloud is not louder than a sparse one; at
most 64 grains sound at once (a higher `density` is lowered to keep to that). `position`, `spread`, `density`, `size` and `pitch` take envelopes (`env bed 1.position "0:0.1 8:0.9"`
walks through the recording). Like a sample layer it takes a filter, an amplitude envelope, effects and pan, names a sample that must be in the project, and has the sample's hash in the
render key. For a bed that repeats without a seam, `sound loop <id> <seconds> fade=<s>` as for any layer: the cloud is rendered past the end and folded onto the start.

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `sample` | text | none | - | the name of the sample the grains are cut from (a short recording of rain, a crowd, fire, a hum) |
| `dur` | 0.01 to 123 s | 2 | - | length of the source |
| `density` | 1 to 400 grains/s | 20 | yes | grains started each second (at most 64 sound at once: a higher density is lowered to keep to that) |
| `size` | 0.005 to 1 s | 0.08 | yes | length of one grain, which is faded in and out by a Hann window |
| `position` | 0 to 1 | 0.5 | yes | where in the sample a grain is centred: 0 the start … 1 the end |
| `spread` | 0 to 1 | 0.1 | yes | how far from the position a grain may be taken, either way, as a share of the sample (random, from the layer's seed) |
| `pitch` | -48 to 48 semitones | 0 | yes | transposition of the grains (a grain keeps its length in the sound) |
| `jitter` | 0 to 1 | 0.3 | - | randomness of the time between grains, as a share of that time (0 is regular, 1 up to twice as long or none) |
| `side` | `mix`, `left`, `right` | mix | - | which channel of a stereo file the grains are cut from: mix (both averaged), left or right |
| `interp` | `linear`, `cubic`, `sinc` | sinc | - | how the sample is read between its frames: linear, cubic or sinc |

**Envelopes.** `env <id> <target> "<breakpoints>"` replaces a fixed value with breakpoints `time:value`, times in seconds from the
start of the layer (the master chain's from the start of the sound), rising. Each point may carry a curve for the segment
that arrives at it: `0:100 0.2:400@exp 0.5:100@ease`. Before the first point the value is the first, after the last the last.

| Curve | The segment arriving at the point |
|---|---|
| `lin` (default) | a straight line |
| `exp` | between two values of the same sign: geometric, equal ratios in equal times (a pitch glide of equal musical steps); **to zero**: a true exponential decay `a · 2^(−9.966 u)`, which is 60 dB down (a factor of 1000) at the end of its segment, where the envelope then ends, so a decay has no long run of silence after it; from zero, or across it: a fast-then-slow curve `(1 − 2^(−8u)) / (1 − 2^−8)` |
| `hold` | stays at the earlier value until the point, then jumps |
| `ease` | smoothstep `u²(3 − 2u)` |

**Repeated hits: `bursts(...)`.** A sound has at most 8 layers, so many hits (rain drops, a machine gun, a clock) belong in one layer's amplitude envelope. `bursts(...)` writes that envelope as breakpoints (the normal form is the breakpoints):

```
env drops 1.amp bursts(times=0.1,0.35,0.6 attack=0.002 decay=0.05 level=1)
env drops 1.amp bursts(count=12 over=2 jitter=0.5 attack=0.001 decay=0.04 level=0.4..1 seed=7)
env drops 1.amp bursts(times=0.1,0.35,0.6 level=1,0.6,0.3)
```

Each hit rises over `attack` seconds (0.0005 to 1) to its level (0 to 4) and falls back to 0 on an exponential curve over `decay` seconds (0.005 to 10; 60 dB down at its end). `times=` gives the hits' start times (they must not overlap: a hit lasts attack + decay). `count=` with `over=` (seconds) spreads that many hits evenly over the time, each moved by up to `jitter` (0 to 1, default 0.5) of its slot, seeded (`seed=`; without one it comes from the settings, so the same text is always the same hits); `level=0.4..1` draws each hit's level from a range (count form); with `times=`, `level=1,0.6,0.3` gives each hit its own level, in the order the times are written (one level for each time, or a single level for all; a list with `count=` is an error). At most 85 hits per envelope (256 breakpoints). Write it without spaces, or in quotes. It works on any target that takes an envelope.

Targets: `N.amp` (the amplitude envelope of layer N, 0 to 4), `N.<param>` (a layer parameter that takes an envelope: see the
"Envelope" column), `N.fxK.<param>` (the K-th effect of layer N), `master.fxK.<param>`. `env <id> <target> adsr(a,d,s,r[,hold])`
writes an amplitude envelope as breakpoints (attack linear to 1, decay `exp` to the sustain level, optional hold, release `exp`
to 0) and the normal form is the breakpoints. `clear` removes an envelope. At most 256 points. Values must be inside the
parameter's range. Setting a fixed value with `layer set` or `fx set` removes that parameter's envelope.

**Effects** (`fx add <id> [layer=<n>] <kind> ...`, the master chain when no layer is given), at most 8 per chain, run in the order of the list:

*filter*: a zero-delay-feedback state-variable filter (also the layer's own `filter`, which runs first). At the cutoff a low-pass has gain Q
(0.707 gives −3 dB). Cutoff and Q take envelopes (the coefficients are recomputed every 8 samples when they do).

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `type` | `lp`, `hp`, `bp`, `notch` | lp | - | low-pass, high-pass, band-pass or notch |
| `cutoff` | 20 to 20000 Hz | 1000 | yes | cutoff (centre for bp and notch) |
| `q` | 0.5 to 20 | 0.707 | yes | resonance (Q) |

*distort*: a waveshaper: `soft` x/(1+|x|), `hard` clip at ±1, `fold` a wavefolder, `cubic` a smooth clip.

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `shape` | `soft`, `hard`, `fold`, `cubic` | soft | - | soft: x/(1+|x|); hard: clip at ±1; fold: wavefolder; cubic: smooth clip |
| `drive` | 1 to 50 | 4 | yes | gain into the shaper |
| `mix` | 0 to 1 | 1 | yes | dry/wet |

*bitcrush*: quantises to steps of 2^(1−bits) and holds each sample to a lower rate.

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `bits` | 1 to 16 bits (whole) | 8 | - | quantise to this many bits (steps of 2^(1-bits)) |
| `rate` | 200 to 44100 Hz | 44100 | yes | sample-rate reduction: hold each sample to this rate (44100 = off) |
| `mix` | 0 to 1 | 1 | yes | dry/wet |

*chorus*: a delay swept by a sine.

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `rate` | 0.05 to 10 Hz | 0.8 | - | speed of the sweep |
| `depth` | 0 to 10 ms | 3 | yes | how far the delay sweeps |
| `delay` | 5 to 30 ms | 15 | - | centre delay |
| `mix` | 0 to 1 | 0.5 | yes | dry/wet |

*delay*: echoes.

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `time` | 0.01 to 1 s | 0.25 | - | time between echoes |
| `feedback` | 0 to 0.95 | 0.4 | yes | how much of each echo is fed back |
| `mix` | 0 to 1 | 0.35 | yes | dry/wet |

*reverb*: a small deterministic Freeverb-style reverb (four comb filters and two all-passes; on a stereo sound the right channel's lines are 23 samples longer).

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `size` | 0 to 1 | 0.5 | - | room size (0 small … 1 large); the tail is the time to fall 60 dB: about 0.6 s at 0, 1.3 s at 0.5, 11 s at 1 |
| `damp` | 0 to 1 | 0.5 | - | how fast the highs die away |
| `mix` | 0 to 1 | 0.3 | yes | dry/wet |

*compress*: a feed-forward compressor. A peak detector (one pole: `attack` when the level rises, `release` when it falls) measures the level in dB; above `threshold` the level is cut by `1 − 1/ratio` of the excess, and `makeup` dB is added after. A constant 0.5 (−6 dB) over a −18 dB threshold at 4:1 comes out 9 dB lower. It has no look-ahead, so a transient faster than the attack passes through (that is what `limit` is for). Deterministic: only + − × ÷ and the renderer's own `exp2` and `log2`.

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `threshold` | -60 to 0 dB | -18 | - | level above which the sound is turned down (peak level, dBFS) |
| `ratio` | 1 to 20 | 4 | - | how much of the level above the threshold is kept: 4 means 4 dB over becomes 1 dB over |
| `attack` | 0.1 to 200 ms | 5 | - | how fast the detector follows a rise in level |
| `release` | 5 to 2000 ms | 100 | - | how fast the detector lets go after the level falls |
| `makeup` | 0 to 24 dB | 0 | - | gain added after compressing; `auto` (in `fx add` and `fx set`) writes the makeup that brings a full-scale input back to full scale, −threshold × (1 − 1/ratio) dB, from the threshold and ratio the effect has then |

*limit*: a look-ahead peak limiter. In `mode=true` (the default) nothing is above `ceiling`, the samples **and the points between them**: the signal is 4× oversampled with the same kernel as the export limiter (deterministic: the sine is fdlibm's, only + − × ÷ otherwise), and the peaks of that are held 0.1 dB inside the ceiling, so a limited sound passes the `clip` check (a train of bursts included; `ceiling` is then a true-peak level, dBTP). In `mode=sample` only the samples are held (the old behaviour). The gain a peak needs is reached `lookahead` ms before the peak (a running minimum over the window, averaged so it moves smoothly; in true mode at least 1 ms, because a point between samples depends on the 48 around it) and comes back with a one-pole `release`; the default release of 20 ms lets each hit of a train of bursts be limited on its own, where a long release leaves the hits after a loud one quieter. Under the ceiling the gain is exactly 1, so a quieter sound is left bit for bit as it was. There is no delay. In a stereo sound each channel is limited on its own. Use it on the master chain (or on one layer) so a sparse, spiky sound can be loud without clipping: gain up, then `fx add <id> limit ceiling=-1`.

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `ceiling` | -24 to 0 dB | -1 | - | nothing goes above this level (dBFS, or dBTP in true mode) after the limiter |
| `release` | 1 to 1000 ms | 20 | - | how fast the gain comes back after a peak (20 ms lets a train of hits each be limited on its own; a long release makes the hits after a loud one quieter) |
| `lookahead` | 0 to 20 ms | 5 | - | how long before a peak the gain starts to come down (0: it drops at once; in true mode at least 1 ms) |
| `mode` | `true`, `sample` | true | - | true: the 4x-oversampled peak between the samples is held under the ceiling (0.1 dB inside it), so the clip check passes; sample: only the samples are |
| `gain` | 0 to 48 dB | 0 | - | gain added before limiting, so a quiet or sparse sound can be made loud and the limiter still holds its peaks; `normalize` uses it when the sound's gain 4 is not enough |

*convolve*: a convolution with a sample used as an impulse response: a room, a plate, a speaker or a tube that was recorded, imported, generated, or made with `sample bounce` from a reverb tail. It is a uniformly partitioned FFT convolution (blocks of 2048 frames, overlap-add) written in core with the same sine as the other renderers, so a sound with a room renders to the same bytes in Node and in the browser. The response is read at the engine's rate, cut to `len` seconds and scaled to unit energy (its root of the sum of squares is 1), so `gain=0` keeps a noisy sound about as loud as it was; `predelay` is silence before the wet signal. The wet signal rings on after the sound for `len` seconds, and the sound is given room for it. A stereo response gives each side of a stereo sound its own channel (left through the response's left, right through its right); on the master chain of a sound it makes the sound stereo. A layer's convolution keeps a mono layer mono (it uses the response's left channel): put a stereo room on the master chain, where it makes the sound stereo. A response that is not in the render's bank leaves the sound as it is (the writer refuses a batch that names one, so this only happens to a document read without its audio). When `fx add` is given no `len`, the writer writes the response's length (to 12 s) into the command, so the tape holds the number and a replay measures nothing. The render key holds the response's hash, so pointing the name at other audio (`sample set`) renders the sound again, and undo brings the old room back. The same effect sits on layers, on a sound's master chain, in an instrument's template, on a song's master chain (`song fx add <song> convolve ir=…`) and on the song's send bus (below).

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `ir` | text | none | - | the name of the sample that is the impulse response: a recorded room, a plate, a speaker or a tube (import or generate one, or `sample bounce` a reverb tail) |
| `mix` | 0 to 1 | 0.3 | yes | dry/wet |
| `predelay` | 0 to 0.5 s | 0 | - | silence before the wet signal starts |
| `gain` | -24 to 12 dB | 0 | - | level of the wet signal. The response is scaled to unit energy first, so 0 dB keeps a noisy sound about as loud as it was |
| `len` | 0.05 to 12 s | 2 | - | how much of the response is used, and how long the tail is. `fx add` sets it to the length of the response (to 12 s) when it is not given |

**The sound.** `sound set <id> duration=<s|auto> gain=<g> out=<dB> seed=<n>`:

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `duration` | 0.01 to 120 s | auto | - | length of the sound; `auto` (the default) is as long as the layers and their tails |
| `gain` | 0 to 4 | 1 | - | master level (before the master chain) |
| `out` | -48 to 48 dB | 0 | - | output level in dB, after the master chain (0 = off); older `normalize` runs put the rest of the level here; it now goes in front of the master limiter (`limit gain=`, below), so the peaks are held |
| `seed` | 0 to 4294967295 (whole) | 1 | - | the sound's noise seed (layers derive theirs from it) |

An automatic length is as long as the layers that sound (not muted; if any is soloed, those) and their effects' tails, then
trimmed where the sound has died away: the last sample within 60.3 dB of the peak, **wherever that is, inside a layer's own source too**
(a source longer than its envelope no longer leaves silence at the end), closed with a 3 ms fade; a run of less than 1 ms is left alone. If the
fade would leave nothing above that level (the first few milliseconds of one more echo, say), the sound ends where the audible part before it did.
A classic layer, and a sample layer with no envelope and no trim, are never cut (they are the file or the classic voice as it is, so
`sound layer-up` keeps the very samples).

**One definition of "died away".** `duration=auto` and the `tail` check use the same floor, 60.3 dB under the sound's peak in the loudest
channel (60 dB, plus 0.3 dB so that an exponential decay that ends at −60 dB counts as ended). The sound ends at its last sample above it, and the
check's "silence at the end" is what follows the last sample above it, so a sound with `duration=auto` passes `tail` (its end is the 3 ms fade).
The room an effect is given to ring in is long enough for that: a delay gets its echoes until the feedback has taken them 66 dB down (an envelope
on the feedback counts at its highest point), a reverb the time its longest comb filter takes to fall 60 dB (about 0.6 s at `size` 0, 1.3 s at 0.5, 11 s at 1);
each is capped at 60 s. A fixed `duration` shorter than that cuts the tail, and the check says so.

**Limiter.** A layered sound is exported through a look-ahead peak limiter (about 1 ms) whose ceiling is the style's
`truePeakMax` (default −0.1 dBTP, kept 0.1 dB inside it): no sample and no point between samples (4× oversampled) goes above it, and
under the ceiling it changes nothing. `export` says how much it reduced. **The checks measure the sound after the master chain** (every
layer's and the master's effects, `compress` and `limit` included) and before this export limiter, so they tell you when the limiter would
have to work. The export limiter does one thing only: it guards the true-peak ceiling. It never makes a sound louder and does not touch a sound
whose true peak is under the ceiling; to be loud *and* not clip, put `compress` / `limit` in the chain, where the checks see them.

**Stereo.** Pan is constant-power (`cos`/`sin` of the angle; a layer at the centre of a stereo sound has gain 0.707 in each channel,
so a sound's loudness does not change when one layer is panned). The WAV has two channels; the numbers and checks work on both:
true peak, sample peak and clipping take the louder channel, DC the worse channel, loudness adds the channels' energies
(BS.1770), click looks at both channels' first and last samples, and pitch, spectrum and the `harsh` check are measured on the
mix of the two ((L + R) / 2). `describe` says "stereo". The page plays both channels. `GET /api/render/<id>.f32` is the channels one after the other.

**Layered recipes** (`sound new <id> voice=layered preset=<recipe> [sample=<name>]`, `sound generate <id> <recipe> [seed=<n>] [sample=<name>]`; also `generate` with a
classic category on a layered sound, which gives it one classic layer). With `sample=<name>` a recipe lays a recording over its synth body: one more sample layer (`interp=sinc`, the first 0.3 s
of the sample, a 0.12 s fade-out, `gain=0.8`) after the recipe's layers, which are exactly what the recipe makes without it. Every layered recipe below takes `sample=` (one that already makes 8 layers refuses it); there is no recipe called `impact` (`impact` is a loudness class: build an impact's body by hand, or use `door` or `metal-clank`, and lay the sample over it). The recipes ship no audio; the sample must be in the project. Like the classic categories, the ranges are data (`RECIPES` in
`core/src/recipes.ts`); the same recipe and seed always give the same sound; "×a..b every c..d s" repeats a layer.

| Recipe | Layer | Chance | Parameters | Envelopes | Effects |
|---|---|---|---|---|---|
| `footstep` a soft thud and a scuff: shoes on a floor (class foley) | osc | 1 | osc wave sine; freq 90..150; dur 0.17..0.22; gain 0.7..1 | amp 0:0 0.003:1 0.1..0.16:0@exp; freq 0:110..170 0.1:45..65@exp | - |
|  | osc | 1 | osc wave one of brown, pink; dur 0.12..0.2; filter lp; cutoff 900..1800; q 0.7..1.5; gain 0.5..0.9 | amp 0:0 0.004:1 0.09..0.15:0@exp; cutoff 0:1800..2600 0.12:300..500@exp | - |
|  | osc | 0.6 | osc wave white; offset 0.02..0.06; dur 0.05..0.1; filter hp; cutoff 2500..4500; gain 0.12..0.3 | amp 0:0 0.004:1 0.04..0.07:0@exp | - |
|  | master | 1 | - | - | filter type hp cutoff 40 q 0.707 |
|  | master | 1 | - | - | compress threshold -24 ratio 6 attack 3 release 120 makeup 7.5 |
|  | master | 1 | - | - | limit ceiling -3 |
| `ui-click` a short tick with a bright body: buttons, toggles (class ui) | osc | 1 | osc wave sine; freq 1800..3000; dur 0.1..0.12; gain 0.6..0.9 | amp 0:1 0.07..0.1:0@exp; freq 0:2200..3200 0.05:1400..1900@exp | - |
|  | osc | 1 | osc wave white; dur 0.015; filter hp; cutoff 3000..6000; gain 0.2..0.4 | amp 0:0 0.001:1 0.012:0@exp | - |
|  | osc | 0.5 | osc wave triangle; freq 2400..4000; offset 0.025..0.045; dur 0.06; gain 0.3..0.5 | amp 0:0 0.002:1 0.05:0@exp | - |
| `door` a thump, a wooden body, a creak that bends and a latch click (class foley) | osc | 1 | osc wave sine; freq 80..110; dur 0.35; gain 0.8..1 | amp 0:0 0.003:1 0.25..0.32:0@exp; freq 0:90..120 0.2:35..50@exp | - |
|  | osc | 1 | osc wave brown; dur 0.3; filter lp; cutoff 400..800; gain 0.5..0.8 | amp 0:0 0.003:1 0.2..0.28:0@exp | - |
|  | osc | 1 | osc wave saw; offset 0.12..0.3; dur 0.62..0.9; filter bp; cutoff 600..900; q 4..9; gain 0.35..0.55 | amp 0:0 0.12:1 0.3..0.4:0.7 0.45..0.55:0@exp; freq 0:160..240 0.25:300..420 0.6:140..200; cutoff 0:500..800 0.6:900..1500 | distort shape soft drive 3..8 mix 0.5 |
|  | osc | 0.7 | osc wave square; freq 1200..2000; offset 0.35..0.5; dur 0.02; gain 0.25..0.4 | amp 0:0 0.001:1 0.018:0@exp | - |
|  | master | 1 | - | - | reverb size 0.15..0.35 damp 0.6 mix 0.08..0.15 |
|  | master | 1 | - | - | compress threshold -24 ratio 8 attack 3 release 120 makeup 8 |
|  | master | 1 | - | - | limit ceiling -3 |
| `magic` a run of bell tones with a shimmer, spread across the stereo field, with echo and room (class impact) | fm ×3..5 every 0.04..0.09 s, 0.8× as loud | 1 | fm freq one of 1047, 1319, 1568, 1976, 2349, 2637; ops 2; algo chain; ratio2 1.5..3.5; index2 2..5; dur 0.45..0.8; gain 0.45..0.6; pan -0.5..0.5 | amp 0:0 0.004:1 0.35..0.44:0@exp; index2 0:3..6 0.4:0@exp | - |
|  | osc | 1 | osc wave white; dur 0.4..0.7; filter hp; cutoff 6000..8000; gain 0.08..0.14 | amp 0:0 0.1:1 0.35..0.39:0@exp | - |
|  | master | 1 | - | - | delay time 0.11..0.19 feedback 0.3..0.45 mix 0.2..0.3 |
|  | master | 1 | - | - | reverb size 0.4..0.6 damp 0.6 mix 0.15..0.25 |
|  | master | 1 | - | - | compress threshold -20 ratio 8 attack 3 release 120 makeup 8.7 |
|  | master | 1 | - | - | limit ceiling -6 |
| `creak` a wooden creak: a rough stick-slip pulse train on a bending pitch, a hollow body under it (class foley) (drawn once for the sound: len 0.7..0.95; lo 120..170) | osc | 1 | osc wave saw; freq lo; dur 3; filter bp; cutoff 700..1200; q 5..9; gain 0.7..1 | freq 0:lo len × 0.5:lo × 1.7@ease len:lo × 1.2@ease; cutoff 0:600..800 len:1200..1800; amp hits (24..30 hits over len s, jitter 0.6, attack 0.004 s, decay 0.02..0.04 s, level 0.4..1) | - |
|  | osc | 1 | osc wave triangle; freq lo × 2; dur 3; gain 0.15..0.3 | amp 0:0 0.08:1 len × 0.8:0.7 len × 1.05:0@exp; freq 0:lo × 2 len:lo × 3@ease | - |
|  | osc | 1 | osc wave brown; dur 3; filter lp; cutoff 300..600; gain 0.5..0.8 | amp 0:0 0.1:1 len × 1.05:0@exp | - |
|  | master | 1 | - | - | distort shape soft drive 2..4 mix 0.4 |
|  | master | 1 | - | - | compress threshold -24 ratio 8 attack 3 release 120 makeup 6.3 |
|  | master | 1 | - | - | limit ceiling -3 |
| `bell` a struck bell: FM with inharmonic partials and a long ringing tail (class music-sting) (drawn once for the sound: f 200..420; len 1.2..2.6) | fm | 1 | fm freq f; dur 4; ops 2; algo chain; ratio2 2.7..3.6; index2 3; gain 1 | amp 0:0 0.003:1 0.4:0.12@exp len:0@exp; index2 0:1.5..3 len × 0.25:0.2@exp | - |
|  | osc | 1 | osc wave sine; freq f × 2.01; dur 4; gain 0.3..0.5 | amp 0:0 0.003:1 0.3:0.1@exp len × 0.8:0@exp | - |
|  | osc | 1 | osc wave sine; freq f × 2.76; dur 4; gain 0.2..0.4 | amp 0:0 0.003:1 0.25:0.1@exp len × 0.55:0@exp | - |
|  | osc | 1 | osc wave sine; freq f × 5.4; dur 4; gain 0.08..0.18 | amp 0:0 0.002:1 0.08:0.1@exp len × 0.2:0@exp | - |
|  | osc | 1 | osc wave sine; freq f × 0.5; dur 4; gain 0.2..0.35 | amp 0:0 0.01:1 0.4:0.15@exp len × 0.9:0@exp | - |
|  | master | 1 | - | - | reverb size 0.15..0.25 damp 0.8 mix 0.1..0.18 |
|  | master | 1 | - | - | compress threshold -24 ratio 8 attack 3 release 120 makeup 16.45 |
|  | master | 1 | - | - | limit ceiling -3 |
| `metal-chain` a chain: many small metallic clinks in a row (class foley) (drawn once for the sound: f 1800..3200; n 14..18; over 1..1.2; hit 1..4000000000) | osc | 1 | osc wave sine; freq f; dur 4; gain 0.6..0.9 | amp hits (n hits over over s, jitter 0.8, attack 0.001 s, decay 0.05..0.1 s, level 0.3..1, seed hit) | - |
|  | osc | 1 | osc wave sine; freq f × 2.76; dur 4; gain 0.3..0.5 | amp hits (n hits over over s, jitter 0.8, attack 0.001 s, decay 0.03..0.06 s, level 0.3..1, seed hit) | - |
|  | osc | 1 | osc wave metal; freq f × 0.6; dur 4; filter hp; cutoff 3000..5000; gain 0.3..0.5 | amp hits (n hits over over s, jitter 0.8, attack 0.001 s, decay 0.02 s, level 0.3..1, seed hit) | - |
|  | master | 1 | - | - | compress threshold -24 ratio 8 attack 3 release 120 makeup 6.6 |
|  | master | 1 | - | - | limit ceiling -3 |
| `metal-clank` one heavy metal hit: a thud, an inharmonic ring (class impact) (drawn once for the sound: f 220..360; len 0.7..1) | osc | 1 | osc wave sine; freq 60..90; dur 4; gain 0.8..1 | amp 0:0 0.003:1 0.12..0.2:0@exp; freq 0:100..130 0.1:45..60@exp | - |
|  | osc | 1 | osc wave sine; freq f; dur 4; gain 0.6..0.9 | amp 0:0 0.002:1 len:0@exp | - |
|  | osc | 1 | osc wave sine; freq f × 2.4; dur 4; gain 0.4..0.6 | amp 0:0 0.002:1 len × 0.7:0@exp | - |
|  | osc | 1 | osc wave sine; freq f × 4.1; dur 4; gain 0.2..0.4 | amp 0:0 0.002:1 len × 0.45:0@exp | - |
|  | osc | 1 | osc wave metal; freq f × 3; dur 4; filter bp; cutoff 1500..3000; q 1.5; gain 0.3..0.5 | amp 0:0 0.001:1 0.12..0.25:0@exp | - |
|  | master | 1 | - | - | compress threshold -18 ratio 8 attack 3 release 120 makeup 18.2 |
|  | master | 1 | - | - | limit ceiling -3 |
| `glass-shatter` glass breaking: a crack, a spray of fine bursts and ringing shards (class impact) (drawn once for the sound: n 30..60; over 0.5..1; hit 1..4000000000) | osc | 1 | osc wave white; dur 4; filter hp; cutoff 2500..4000; gain 0.7..1 | amp 0:0 0.001:1 0.04..0.08:0@exp | - |
|  | osc | 1 | osc wave white; dur 4; filter bp; cutoff 5000..8000; q 1; gain 0.5..0.8 | amp hits (n hits over over s, jitter 0.9, attack 0.001 s, decay 0.01..0.025 s, level 0.2..1, seed hit) | - |
|  | osc | 1 | osc wave sine; freq 5300..8000; dur 4; gain 0.2..0.4 | amp hits (8..14 hits over over s, jitter 0.9, attack 0.001 s, decay 0.15..0.3 s, level 0.3..1) | - |
|  | osc | 1 | osc wave sine; freq 8000..11000; dur 4; gain 0.1..0.25 | amp hits (8..14 hits over over s, jitter 0.9, attack 0.001 s, decay 0.1..0.2 s, level 0.3..1) | - |
|  | osc | 1 | osc wave sine; freq 90..140; dur 4; gain 0.5..0.8 | amp 0:0 0.003:1 0.08..0.14:0@exp | - |
|  | master | 1 | - | - | compress threshold -18 ratio 8 attack 3 release 120 makeup 12.8 |
|  | master | 1 | - | - | limit ceiling -3 |
| `glass-clink` two glasses touching: two bright inharmonic partials, short (class foley) (drawn once for the sound: f 5200..6000; len 0.28..0.34) | osc | 1 | osc wave sine; freq f; dur 4; gain 0.7..1 | amp 0:0 0.001:1 len:0@exp | - |
|  | osc | 1 | osc wave sine; freq f × 2.32; dur 4; gain 0.4..0.7 | amp 0:0 0.001:1 len × 0.7:0@exp | - |
|  | osc | 1 | osc wave white; dur 4; filter hp; cutoff 5000..8000; gain 0.2..0.4 | amp 0:0 0.0005:1 0.01:0@exp | - |
|  | master | 1 | - | - | compress threshold -24 ratio 8 attack 3 release 120 makeup 13.2 |
|  | master | 1 | - | - | limit ceiling -3 |
| `voice-vowel` a sung vowel: a saw pulse train through three band-pass formants (class voice) (drawn once for the sound: f0 110..260; vowel one of 0, 1, 2, 3, 4; len 0.4..0.8) | osc | 1 | osc wave saw; freq f0; dur 4; filter bp; cutoff vowel[730 530 270 570 300]; q 5..8; gain 1 | amp 0:0 0.06:1 len × 0.6:0.9 len:0@exp; freq 0:f0 × 1.08 len:f0 × 0.94 | - |
|  | osc | 1 | osc wave saw; freq f0; dur 4; filter bp; cutoff vowel[1090 1840 2290 840 870]; q 6..10; gain 0.7 | amp 0:0 0.06:1 len × 0.6:0.9 len:0@exp; freq 0:f0 × 1.08 len:f0 × 0.94 | - |
|  | osc | 1 | osc wave saw; freq f0; dur 4; filter bp; cutoff vowel[2440 2480 3010 2410 2240]; q 6..10; gain 0.4 | amp 0:0 0.06:1 len × 0.6:0.9 len:0@exp; freq 0:f0 × 1.08 len:f0 × 0.94 | - |
|  | osc | 1 | osc wave white; dur 4; filter bp; cutoff vowel[1090 1840 2290 840 870]; q 2; gain 0.05 | amp 0:0 0.06:1 len × 0.6:0.9 len:0@exp | - |
|  | master | 1 | - | - | compress threshold -24 ratio 8 attack 3 release 120 makeup 9 |
|  | master | 1 | - | - | limit ceiling -3 |
| `voice-cluck` a cluck: a few quick formant pulses on a falling pitch (class voice) (drawn once for the sound: f0 215..250; vowel one of 0, 3; n 3..3; over 0.18..0.26; hit 1..4000000000) | osc | 1 | osc wave saw; freq f0; dur 4; filter bp; cutoff vowel[730 530 270 570 300]; q 5..9; gain 1 | freq 0:f0 × 1.3 over × 1.2:f0 × 0.7@exp; amp hits (n hits over over s, jitter 0.3, attack 0.004 s, decay 0.04..0.07 s, level 0.85..1, seed hit) | - |
|  | osc | 1 | osc wave saw; freq f0; dur 4; filter bp; cutoff vowel[1090 1840 2290 840 870]; q 5..9; gain 0.7 | freq 0:f0 × 1.3 over × 1.2:f0 × 0.7@exp; amp hits (n hits over over s, jitter 0.3, attack 0.004 s, decay 0.04..0.07 s, level 0.85..1, seed hit) | - |
|  | osc | 1 | osc wave saw; freq f0; dur 4; filter bp; cutoff vowel[2440 2480 3010 2410 2240]; q 5..9; gain 0.4 | freq 0:f0 × 1.3 over × 1.2:f0 × 0.7@exp; amp hits (n hits over over s, jitter 0.3, attack 0.004 s, decay 0.04..0.07 s, level 0.85..1, seed hit) | - |
|  | master | 1 | - | - | compress threshold -24 ratio 8 attack 3 release 120 makeup 15.8 |
|  | master | 1 | - | - | limit ceiling -3 |
| `voice-giggle` a giggle: a run of short, high formant bursts that tail off (class voice) (drawn once for the sound: f0 250..340; vowel one of 0, 1; n 5..5; over 0.5..0.65; hit 1..4000000000) | osc | 1 | osc wave saw; freq f0; dur 4; filter bp; cutoff vowel[730 530 270 570 300]; q 5..9; gain 1 | freq 0:f0 × 1.1 over:f0 × 0.85; amp hits (n hits over over s, jitter 0.3, attack 0.01 s, decay 0.05..0.09 s, level 0.85..1, seed hit) | - |
|  | osc | 1 | osc wave saw; freq f0; dur 4; filter bp; cutoff vowel[1090 1840 2290 840 870]; q 5..9; gain 0.7 | freq 0:f0 × 1.1 over:f0 × 0.85; amp hits (n hits over over s, jitter 0.3, attack 0.01 s, decay 0.05..0.09 s, level 0.85..1, seed hit) | - |
|  | osc | 1 | osc wave saw; freq f0; dur 4; filter bp; cutoff vowel[2440 2480 3010 2410 2240]; q 5..9; gain 0.4 | freq 0:f0 × 1.1 over:f0 × 0.85; amp hits (n hits over over s, jitter 0.3, attack 0.01 s, decay 0.05..0.09 s, level 0.85..1, seed hit) | - |
|  | master | 1 | - | - | compress threshold -24 ratio 8 attack 3 release 120 makeup 12.7 |
|  | master | 1 | - | - | limit ceiling -3 |
| `wind` a bed: moving air, a low rush that swells and fades, a thin whistle on top (loops, 5..7 s, fade 0.6 s) | osc | 1 | osc wave brown; dur loop; filter bp; q 0.8..1.4; gain 1 | cutoff wanders (5..8 points in 220..700, back to its start at the loop end); gain wanders (4..7 points in 0.45..1, back to its start at the loop end) | - |
|  | osc | 1 | osc wave pink; dur loop; filter bp; q 2..4; gain 0.2 | cutoff wanders (4..7 points in 700..1800, back to its start at the loop end); gain wanders (4..7 points in 0.04..0.35, back to its start at the loop end) | - |
|  | osc | 1 | osc wave white; dur loop; filter hp; cutoff 5000; gain 0.05 | gain wanders (4..6 points in 0.2..1, back to its start at the loop end) | - |
|  | master | 1 | - | - | reverb size 0.4..0.6 damp 0.5 mix 0.12 |
| `rain` a bed: a steady patter, a soft body underneath and scattered drops (loops, 4..6 s, fade 0.5 s) | osc | 1 | osc wave white; dur loop; filter bp; cutoff 4200..5200; q 0.5; gain 0.5 | - | - |
|  | osc | 1 | osc wave pink; dur loop; filter bp; cutoff 1100..1500; q 0.4; gain 0.4 | gain wanders (3..5 points in 0.2..0.55, back to its start at the loop end) | - |
|  | osc | 1 | osc wave white; dur loop; filter bp; cutoff 3500..6000; q 1.2..2; gain 1 | amp bursts (6..8 of 0.01..0.035 s, level 0.5..1) | - |
|  | osc | 1 | osc wave white; dur loop; filter bp; cutoff 6000..9000; q 1.2..2; gain 0.7 | amp bursts (6..8 of 0.008..0.03 s, level 0.4..0.9) | - |
|  | master | 1 | - | - | reverb size 0.25..0.4 damp 0.5 mix 0.12 |
| `fire` a bed: a low roar that flickers, a hiss, and crackles (loops, 4..6 s, fade 0.5 s) | osc | 1 | osc wave brown; dur loop; filter bp; cutoff 160..240; q 0.4 | gain wanders (6..10 points in 0.45..1, back to its start at the loop end) | - |
|  | osc | 1 | osc wave pink; dur loop; filter bp; cutoff 2500..3500; q 0.8 | gain wanders (6..10 points in 0.1..0.45, back to its start at the loop end) | - |
|  | osc | 1 | osc wave white; dur loop; filter hp; cutoff 1800..2600; gain 0.3 | amp bursts (6..9 of 0.004..0.02 s, level 0.4..0.8) | - |
|  | osc | 1 | osc wave white; dur loop; filter bp; cutoff 700..1400; q 1.5; gain 0.2 | amp bursts (3..5 of 0.02..0.06 s, level 0.3..0.7) | - |
|  | master | 1 | - | - | distort shape soft drive 1 mix 1 |
| `crowd` a bed: many voices far enough that none is a word (murmur): three speech-band hums that rise and fall independently (loops, 6..8 s, fade 0.8 s) | osc | 1 | osc wave pink; dur loop; filter bp; cutoff 380..520; q 3..5; gain 1 | gain wanders (12..18 points in 0.1..0.8, back to its start at the loop end) | - |
|  | osc | 1 | osc wave pink; dur loop; filter bp; cutoff 800..1000; q 3..5; gain 0.8 | gain wanders (12..18 points in 0.1..0.8, back to its start at the loop end) | - |
|  | osc | 1 | osc wave pink; dur loop; filter bp; cutoff 1500..1900; q 3..5; gain 0.5 | gain wanders (12..18 points in 0.1..0.8, back to its start at the loop end) | - |
|  | osc | 1 | osc wave brown; dur loop; filter bp; cutoff 180; q 0.5; gain 0.5 | - | - |
|  | master | 1 | - | - | reverb size 0.45..0.65 damp 0.5 mix 0.25 |
| `metal` a metal sound: the seed picks one of `metal-chain`, `metal-clank` | - | - | - | - | - |
| `glass` a glass sound: the seed picks one of `glass-shatter`, `glass-clink` | - | - | - | - | - |
| `voice` a voice: the seed picks one of `voice-vowel`, `voice-cluck`, `voice-giggle` | - | - | - | - | - |

`examples`: `docs/examples/layered-demo.txt` builds an impact, a magic sparkle and a door creak (all three pass the checks).

### Sets, families and loops

**Sets.** A set is a named group of sounds that belong together (the footsteps on grass, the clicks of a
menu) with a loudness target and a variation rule. It is a document in `sets/<id>.set`; its members are
ordinary sounds in `sounds/`, so a set never hides a sound inside itself.

```
set new footsteps from=step count=6 target=-20 spread="1.freq±12% 2.cutoff±20% *.gain±20%"
```

- `count` variants of `from` (a classic or layered sound) are made, `footsteps_1` … `footsteps_6` (or the ids you choose: `names="step_{n}"` numbers them from 1, `as=step_a,step_b,...` lists them; ids keep their case and must be new, ignoring case). They are seeded:
  the same set command always makes the same sounds (`seed=<n>` is written into the normal form).
- **spread** is a list of `<parameter>±<amount>` rules (`+-` and `+/-` also read). The amount is in the parameter's own
  unit, or a percentage of the source's value with `%`. For a classic sound the parameter is a classic parameter by the
  name `sound set` uses (`freq±0.04 decay±0.1`; `wave` is a choice and cannot vary). For a layered sound it is named as
  `layer set`, `env` and `fx set` name things: `2.cutoff±20%` (layer 2's cutoff), `*.gain±20%` (every layer that has it, moved
  by the same amount), `1.amp±10%` (the amplitude envelope), `1.fx2.mix±0.1` (an effect), `master.fx1.mix±0.1`, or `gain±10%`
  (the sound's gain). **A parameter that an envelope drives moves as a whole**: every breakpoint is shifted (absolute) or scaled
  (relative), so `1.freq±12%` of a footstep whose pitch falls from 160 to 55 Hz gives a thud that falls from 141 to 48 or from 179 to 62.
- The positions are **stratified**, not independent: for each rule the `count` members are given `count` stripes of the range
  `-amount … +amount` in a shuffled order, each member's place jittered inside its own stripe. Six members therefore cover the
  range instead of bunching, and two neighbours are always at least a tenth of the amount apart.
- Each member also gets its own noise seed (a classic sound's `seed`, a layered sound's `seed`), so noise differs even where no rule moves a parameter.
- **Loudness matching.** After `set new`, `set add` (the added sounds), `set retarget` (every member) and `set regen`
  (the generated members), the members are brought to the target LUFS **by gain**, and the result is written on the history as
  plain `sound set <member> gain=<g>` commands in the same undo group. (A measurement may differ in its last digit between
  machines, so it is never repeated while a history replays: the numbers are on the tape.) A layered sound's gain is its `gain` (0 to 4).
  **A classic sound has no separate gain: its gain is its `volume` parameter** (0 to 1, linear in amplitude), so a classic member
  can be made quieter or as loud as volume 1 allows; when the target needs more, `volume` is left at 1 and a warning says by how many LU it
  falls short (`sound layer-up` makes the sound layered, sample for sample, and then gain goes to 4). The match is repeated until it is within 0.05 LU.
- **Checks.** Members are held to the set's target by the `loudness` check (a sound in two sets with targets uses the first). A member with
  its own `loudness=` (`sound set <id> loudness=-24`) is held to that and not to the set's target, in `set-spread` too, which says "from the own
  target" for it and lists the own targets in its threshold line. The `set-spread`
  check (`check <set>`, below) looks at the set as a whole. `view <set> set` draws the members side by side and the distance matrix.
- A set made from a source remembers it: `set regen` makes the generated members again from the source as it is now. Members that were added with
  `set add` are never regenerated; `set remove` takes a member out and keeps the sound.

**set-spread.** Members must be neither too alike nor too different, and equally loud.
The distance between two members is the mean absolute difference of their mel spectrograms (80 dB range, time axes as they are,
dB), the `spectral distance` of `compare`. The check fails when a pair is closer than `setSpreadMin` (default **1 dB**) or farther
than `setSpreadMax` (default **20 dB**), or a member's loudness is more than `loudnessTolerance` (1 LU) from the set's target (without a
target: from the middle member). Both limits are style keys. What the numbers mean in practice, measured on this tool's own sounds:
footstep variants from different seeds of the recipe are 4 to 7 dB apart; a footstep set with 12 % / 20 % rules is 1.5 to 2.5 dB
apart (alike, never identical); a tonal pickup with `freq±0.04 decay±0.1` is 10 to 17 dB apart; a footstep against a door is 14 dB, a coin against an
explosion 39 dB.

**Families.** `family <sound> near|far|muffled [as=<id>]` makes the sound as it is heard near, far away or behind a wall. The rules are
data (`FAMILIES` in `core/src/families.ts`):

| Family | Loudness vs the source | Added to the master chain | Reverbs the source has |
|---|---|---|---|
| `near` close and present: a little louder, drier | +2 LU | nothing | mix × 0.5 |
| `far` a long way off: quieter, darker, more reverb | -9 LU | low-pass 3500 Hz × 1, reverb size 0.65 damp 0.6 mix 0.35 | mix × 1, at least 0.35 |
| `muffled` behind a wall: the highs gone (two low-pass stages), the rumble too, a little room | -6 LU | high-pass 60 Hz, low-pass 500 Hz × 2, reverb size 0.25 damp 0.8 mix 0.15 | mix × 1, at least 0.15 |

The variant is a **copy**, stored as a layered sound (a classic source becomes a one-layer layered sound with the very same samples), with the rules
added to its master chain; it does not refer to the source afterwards. Why a copy: a sound document renders from itself alone, so the render
key, the browser's render, the exports and `undo` need no look-up in another document, and either sound can be edited without the other
moving under it. The document remembers `family <kind> of <source> offset <dB>`. Because a far sound is meant to be quieter, **its loudness is
matched to the source's plus the rule's offset** (written as a `sound set <variant> gain=` command, like a set's) and the `loudness`
check holds it to the style's target plus that offset: `impact_far` of a −16 LUFS impact is held to −25 ±1.

**Loops.** `sound loop <id> <seconds> [fade=<s>]` makes a layered sound a loop (a bed: wind, rain, fire, a crowd). The **seam is made seamless by
rendering over the boundary**: the sound is rendered `fade` seconds longer than the loop, and the part past the end is crossfaded over the first `fade`
seconds with an equal-power curve (`sin` and `cos` of a quarter cycle, built from the tone's polynomial sine so Node and the browser agree). The
last sample of the loop then runs on into the first as the render itself would (the first sample *is* the sample after the last one in the long
render), reverb and delay tails wrap around, and noise keeps its level through the join. It is not a crossfade of two copies of the start. Two
consequences: a layer's `dur` must cover the loop plus the crossfade (a shorter source leaves silence), so **`sound loop` lengthens every osc, fm and ks layer that is shorter than length + fade** (to length + fade + 50 ms, minus its offset; a recipe's layers included; the result says which layers it changed), and leaves a classic or sample layer, which has no `dur`, to play once inside the loop; and a **periodic** sound
whose cycle does not divide the loop length is two correlated copies in the crossfade, so its level can dip or swell there: choose the length to be a
whole number of cycles, or use noise (which is what beds are). An envelope on a parameter should come back to where it started at the loop end;
the bed recipes' wanders do exactly that.

- The loop is `length` samples long exactly (`duration` is ignored), 0.1 to 120 s; the render key changes only for a looping sound. The bed recipes loop cleanly at any allowed length (tested at 4, 8 and 20 s); a recipe's envelopes (wanders, drops) are drawn for the length it was made with and hold their last value after it, so a much longer bed repeats the same texture rather than adding new drops.
- **Checks on a loop.** `click` looks at the **seam** instead of the first and last sample: it fails when the jump from the last sample to the first is
  above `clickMax` *and* above 4 times the local sample-to-sample step (so a loud noise bed is not flagged for being noise), or when the level of the
  last 50 ms differs from the first 50 ms by more than `seamStepMaxDb` (default 3 dB). `tail` needs no fade-out. The other checks are as ever.
- `view <id> loop` draws the last 50 ms joined to the first (the seam marked), the two drawn over each other, the joined spectrogram, and the level
  (50 ms windows) across four repeats with the seams marked.
- WAV is exact; OGG is lossy, so an OGG loop is only as good as the codec at its seam (`export` says so).
- **Ambience recipes** (beds, below): `wind`, `rain`, `fire`, `crowd`: layered, looped, seeded, with periodic wanders and bursts (the table lists them).
  `sound new <id> voice=layered preset=rain` makes a bed; `sound loop <id> off` makes it a one-shot.

`examples`: `docs/examples/sets-demo.txt` makes a footstep set of six, an impact in three distances and a rain bed, and all of it passes the checks.

### Music: instruments, patterns and songs

A song is built from **instruments** (a voice played at a pitch), **patterns** (a grid of notes per channel) and a **song** (tempo, channels bound to instruments, and the order the patterns play in). All of it is text and commands on the history tape, like a sound.

#### Instruments

An instrument is any voice of the layered sound (classic, osc, fm, ks, sample, several layers, effects) written as it sounds at its `root` note, plus a note envelope. Playing note N moves every pitched layer by N - root semitones: `freq` of osc, fm and ks layers is multiplied, a classic layer's `freq` and `minFreq` are moved by the same ratio, a sample layer's `pitch` is added to. The note envelope (attack, decay to sustain, hold while the note is held, release after it ends) multiplies each layer's amplitude before the layer's effects, so a delay's echoes ring on after the note. A built-in instrument can be played by name in any channel; `instrument new <id> from=<built-in>` makes one to change.

```
instrument new <id> [from=<instrument or built-in>] [kind=osc|fm|ks|classic|sample|zones] [seed=<n>]
instrument from-sound <id> <sound> [root=<note>]       the sound's layers; root: the note it sounds at (found from an osc, fm or ks layer's freq when left out, else A4)
instrument set <id> root=<note> pitched=yes|no adsr=<a>,<d>,<s>,<r> velocity=<0..1> range=<C3-C6>|none pitchenv="<t>:<semitones> ..."|none pitch-check=full|class|onset legato=yes|no velxfade=<velocity steps> rr=cycle|hash gain=<g> seed=<n>
                  (also attack= decay= sustain= release=)
instrument layer|fx|env <the sound commands, with the instrument's id>      instrument layer add bell osc wave=sine freq=880
instrument zone add|set|remove|clear <id> …              the samples an instrument plays ("Sampled instruments" below)
instrument zones <id> from-samples|from-slices …         instrument from-sample <id> <sample> [loop=find]
instrument copy|rename <id> <new>       instrument remove <id>     (refused while a channel plays it)
```

| setting | range | meaning |
|---|---|---|
| `root` | C-1 to G9 | the note the template sounds at as written |
| `pitched` | yes / no | no: a drum or sound effect plays as written at every note |
| `attack` | 0.001 to 4 s | time to full level |
| `decay` | 0 to 4 s | time down to `sustain` (0: the level goes straight to sustain) |
| `sustain` | 0 to 1 | level while the note is held |
| `release` | 0.005 to 8 s | time to silence after the note ends |
| `velocity` | 0 to 1 | how much velocity changes the level: level = 1 - v + v x velocity / 127 |
| `range` | two notes | the notes the instrument is meant to play: the `range` check |
| `pitchenv` | semitones over time | a pitch envelope on every note (a kick's drop: `0:30 0.07:0@exp`) |
| `pitch-check` | `full`, `class`, `onset` | how `render-match` hears the instrument's pitch: the note itself (default), its pitch class with the octave ignored (a bell, whose inharmonic partials make a pitch tracker hear an octave off; `fm_bell` uses it), or timing only |
| `legato` | yes / no | a legato voice (a recorder, a bowed string, a held drone): `render-match` finds the onset of a note that touches the one before it in the change of pitch, not in a rise of level, and a note of the same pitch as the one before has no onset to find. Checking only: it changes no sample |
| `velxfade` | 0 to 64 velocity steps | zones: neighbouring velocity layers crossfade over this many steps, at equal power (0: they switch at their boundary) |
| `rr` | `cycle`, `hash` | zones: how round-robin takes are chosen (below) |
| `gain`, `seed` | | the instrument's level and noise seed |

Pitch effects (a pitch envelope, `~slide`, `~vib`, `~arp`) move osc, fm and sample layers continuously. A pluck (ks) and a classic layer are tuned at the note's start and keep their pitch. A pulse wave off 50 % duty has a DC offset: give it a high-pass filter (`filter=hp cutoff=35`), as `pulse_lead` has.

The built-in instruments (generated from the data; a test keeps this table equal to it):

<!-- builtins:begin -->
| instrument | voice | pitch | attack / decay / sustain / release (s, s, level, s) | range | velocity sensitivity | pitch check |
|---|---|---|---|---|---|---|
| `square_lead` | square | root A4 | 0.004 / 0.08 / 0.75 / 0.06 | C3-C7 | 1 | full |
| `pulse_lead` | pulse 0.25 | root A4 | 0.003 / 0.1 / 0.65 / 0.08 | C3-C7 | 1 | full |
| `triangle_bass` | triangle | root A4 | 0.003 / 0.05 / 0.9 / 0.05 | C1-C4 | 1 | full |
| `saw_pad` | saw + saw | root A4 | 0.25 / 0.3 / 0.8 / 0.5 | C2-C6 | 1 | full |
| `fm_bell` | fm 2op | root A4 | 0.002 / 1.4 / 0 / 0.3 | C4-C8 | 1 | class |
| `fm_bass` | fm 2op | root A4 | 0.002 / 0.2 / 0.65 / 0.05 | C1-G3 | 1 | full |
| `pluck` | ks | root A4 | 0.001 / 0 / 1 / 0.2 | C2-E6 | 1 | full |
| `kick` | sine + white | unpitched | 0.001 / 0.2 / 0 / 0.02 | none | 0.8 | - |
| `snare` | white + triangle | unpitched | 0.001 / 0.14 / 0 / 0.02 | none | 0.8 | - |
| `hat` | white | unpitched | 0.001 / 0.045 / 0 / 0.01 | none | 0.8 | - |
| `hat_open` | white | unpitched | 0.001 / 0.3 / 0 / 0.05 | none | 0.8 | - |
<!-- builtins:end -->

The drum kit a drum channel uses by default maps the hit names `k`/`kick` to `kick`, `s`/`snare` to `snare`, `h`/`hat` to `hat` and `oh`/`hat_open` to `hat_open`.

#### Sampled instruments

An instrument can play recordings: a table of **zones**, each a sample (or one slice of it) for the keys and velocities it covers. A zone is played at
`note - root + tune` semitones, so one sample stretches over a few keys and a set of them covers the keyboard. A recorder from three notes, a harp, a
set of drums: the sound is the recording, and the instrument makes it playable. Zones sit beside any synth layers of the instrument (a sampled attack
over a synth pad), under the same note envelope, effects, `range`, `pitch-check` and `legato`, and under the same song rules: a song of sampled
instruments renders to the same bytes in Node and in the browser, a channel is rendered and cached on its own, and a partial re-render equals a full one.

```
instrument new recorder kind=zones                      an instrument of samples (no synth layer); kind=sample makes one with an empty sample layer, which the first zone replaces
instrument zones recorder from-samples rec_c4 rec_g4 rec_d5 root=detect
instrument set recorder legato=yes range=C4-G6 adsr=0.02,0.1,0.9,0.15
instrument zone add <id> sample=<name> root=<note> keys=<lo>-<hi> [vel=<lo>-<hi>] [tune=<cents>] [gain=<dB>] [pan=<-1..1>] [slice=<n>]
                    [start=<s>] [end=<s>] [loop=<s>-<e>|sample|none] [loopmode=none|sustain|continuous|oneshot] [xfade=<s>]
                    [trigger=attack|release] [release-decay=<dB per second>] [rr=<i>/<n>] [choke=<group>] [hit=<name>] [interp=sinc|cubic|linear]
instrument zone set <id> <n> <key>=<value> ...      instrument zone remove <id> <n>      instrument zone clear <id>
instrument zones <id> from-samples <sample>... [root=detect] [vel=<lo>-<hi>]
instrument zones <id> from-slices <sample> [start=C1]
instrument from-sample <id> <sample> [loop=find]
```

| Zone setting | Meaning |
|---|---|
| `sample`, `slice` | the sample (a name in the project) and, with `slice=<n>`, one of its slices (`sample slice`) |
| `root`, `tune` | the note the sample sounds at, and cents added to the pitch it is played at (`tune=-12` for a sample recorded 12 cents sharp). A zone not given a root takes the sample's own root note and tuning |
| `keys`, `vel` | the notes (`C3-C5`, `0-127`, or one note) and velocities (`1-127`) the zone plays for |
| `gain`, `pan` | dB (-60 to 24) and position (-1 to 1; a stereo sample keeps its two channels, pan does not move them) |
| `start`, `end` | seconds into what plays (the slice, else the sample) to start and stop at; `end=0` is the end |
| `loop`, `loopmode`, `xfade` | `loop=sample` (the default) uses the sample's own loop points (`sample loop`) when it has any; `loop=<s>-<e>` sets them in seconds from the start of what plays; `none` never loops. `loopmode`: `sustain` (the default) loops while the key is held, then plays on from the loop to the end of the sample; `continuous` loops through the release too; `oneshot` plays the whole sample whatever the key does (drums, hits); `none` plays it once. `xfade` is the equal-power crossfade at each seam (default 0.01 s) |
| `trigger`, `release-decay` | `release` starts the zone when the key is let go (a damper, a key-up thump), lowered by `release-decay` dB for every second the key was held |
| `rr=<i>/<n>` | take *i* of *n* round robins: zones that share keys, velocities and trigger take turns |
| `choke` | a choke group: a note of the group stops the earlier sounding notes of the group on its channel, with a 5 ms fade (a closed hat cutting an open one) |
| `hit` | a drum hit name: the zone is played by the hit, not by key (below) |
| `interp` | how the sample is read between frames (default `sinc`; see the layer table) |

A note plays every zone whose keys and velocities hold it, or none (silence; `check` finds the holes). Velocity picks the layer; the level follows the
instrument's `velocity` sensitivity as it does for any instrument. With `velxfade=12`, neighbouring velocity layers (`1-70` and `71-127`) fade into each
other across 12 velocity steps at equal power, so a rising velocity does not jump. `rr=cycle` (the default) counts the earlier notes of that zone group
in the same pattern placement (a counter that starts again with each pattern placed in the song), so the first note of a placement is take 1;
`rr=hash` picks from the channel, the note's time and its pitch. Either way a note's take depends only on its own channel and placement, so one channel
re-renders alone to the same bytes as in a full render.

**Building.** `from-samples` makes a zone for each sample, at its root: `root=detect` measures each sample's pitch once, settled as a note and cents
(`root=G3 tune=-10`), otherwise the samples' own roots are used. Key ranges split halfway between neighbouring roots. `vel=` puts all of them in one
velocity layer (run it again with another `vel=` for the next layer). `from-slices` puts the slices of a sliced loop or kit on keys from `start=`
upward, one slice to a key, each played whole. `from-sample` makes the instrument itself, with one zone over the whole keyboard; `loop=find` looks for
loop points when the sample has none. What was measured goes on the tape as plain `instrument zone add` commands; a replay measures nothing.

**Kits.** A drum channel may name one kit instrument: `song channel add <song> drums kit=<instrument>` sends every hit to it, and its zones are
chosen by hit name (`hit=kick`, `hit=snare`; put `pitched=no` on the instrument). The built-in hit names and `kit=default` and `kit=<hit>:<instrument>`
work as before.

**Checking.** `soundclaw check <project> <instrument>` plays each zone alone and reports, as faults (it fails): keys inside the declared `range`
(or velocities) with no zone; a zone more than 10 cents off its root when the root is played (with `pitch-check=class` by pitch class; `onset` skips
it); more than 3 LU between neighbouring zones, or neighbouring velocity layers, played alone at the same velocity; a looped zone whose seam clicks, steps
or jumps in spectrum. And as warnings: a note played more than 7 semitones from its zone's root; round-robin takes less than 1 dB or more than 20 dB
apart (the set-spread rules); a release zone louder than the zone it follows. `soundclaw view <project> <instrument> keymap` draws keys across and
velocity up, each zone a box with its sample, root, measured error and level, coloured by its checks; take stacks the round robins, and hits are listed
below. `soundclaw instrument zones <project> <id>` lists the zones. `render-match` hears a sampled instrument's notes as it does any other.

**SFZ and SoundFont 2 import.** `soundclaw instrument import <project> <file.sfz|file.sf2> [--id <id>] [preset=<bank>:<program>|<name>] [--list] [licence=<id>]
[attribution="<text>"] [terms=<url>] [tags=a,b] [prefix=<text>]` (the MCP `instrument_import` tool takes the same fields, with `list: true`) reads the file into a sampled
instrument. The sample files go into the store as `source=instrument-import` (the origin is `<file>:<path inside it>`, the original file's hash is kept, the licence is `unknown`
unless `licence=` gives one, so an export with a manifest refuses until it is set), and the regions or zones become plain `instrument zone add` lines, all one undo group. The files are
read once, at the import; a replay or a render never opens them again. Sample names are the file's name after `<id>_` (`prefix=` changes the front; a name already taken gets `_2`).
The answer lists what was written and then everything the zones cannot say, per region (SFZ) or zone (SoundFont), as `lost` or `approximated`.

| SFZ | Becomes |
|---|---|
| `<control>`, `<global>`, `<master>`, `<group>`, `<region>`; `#define $NAME value`; `#include "file"` (nested up to 8 deep, from the SFZ's folder); `//` and `/* */` comments; `default_path`; `octave_offset`, `note_offset` | opcodes inherit down the headers as SFZ says; other headers (`<curve>`, `<effect>`, `<midi>`) are named as lost |
| `sample` (spaces allowed; found beside the SFZ, ignoring case) | the zone's sample; a `*sine`-style generator or an absolute path stops the import naming the region |
| `lokey`, `hikey`, `key`, `pitch_keycenter` (note names like `c4` = 60; `sample` = the file's own root) | `keys=`, `root=` (default root 60) |
| `lovel`, `hivel` | `vel=` |
| `tune`, `transpose` | `tune=` (cents, `tune + 100 × transpose`) |
| `volume`, `pan` | `gain=`, `pan=` (pan ÷ 100) |
| `pitch_keytrack=0` | an unpitched instrument if every region has it; else one zone per key (spans up to 16 keys), longer spans are reported as approximated |
| `loop_mode` (`no_loop`, `one_shot`, `loop_continuous`, `loop_sustain`), `loop_start`, `loop_end`, `loop_crossfade` | `loopmode=` (none, oneshot, continuous, sustain), `loop=` in seconds from where the zone starts playing, `xfade=`; with no `loop_mode`, a file or opcode loop plays as `continuous`, else no loop |
| `offset`, `end` | `start=`, `end=` (seconds) |
| `trigger=release`, `rt_decay` | `trigger=release`, `release-decay=` (`first`, `legato` play as attack, reported) |
| `seq_length`, `seq_position` | `rr=<position>/<length>` and `instrument set rr=cycle` |
| `lorand`, `hirand` | regions sharing keys and velocities become `rr=1/n … n/n` and `instrument set rr=hash` (reported as approximated, with unequal ranges said) |
| `group`, `off_by` | `choke=` (groups linked by `off_by` share a number; a one-way cut is reported, as choke cuts both ways) |
| `ampeg_attack`, `ampeg_decay`, `ampeg_sustain` (percent), `ampeg_release`, `amp_veltrack` | the instrument's `attack decay sustain release` and `velocity`: one for the instrument, the commonest of the regions'; regions that differ are reported; an SFZ with no `ampeg_*` leaves the instrument's own envelope |

`ampeg_hold` and every opcode not listed (`cutoff`, `fil_type`, `*_cc`, `sw_*`, `pitch_veltrack`, `polyphony`, …) are reported as lost, with the regions that had them. Opcodes that
only label things (`region_label`, `hint_*`, `label_cc`) are ignored without a word. A region with no `sample`, or an empty key or velocity range, is left out with a note.
More than 4096 zones (an instrument's most) is refused (import a part of the library); at that size a note still renders in about 30 ms, `check` takes about two seconds (zones that differ only in their key and velocity ranges are measured once) and the key-map view draws in under 0.1 s. Each imported sample records the SFZ or SoundFont file's own SHA-256 as `container-hash`. For SoundFont 2: `--list` prints the presets (`bank:program name (zones)`); a file with one preset needs no `preset=`, with
several it is required. Reads the RIFF structure with 16-bit samples and 24-bit (`sm24`); SoundFont 3 (compressed) and ROM samples are refused. Each preset zone × instrument zone becomes a
zone with its key and velocity range (intersected as the format says), root (`overridingRootKey`, else the sample's), tuning (`coarseTune`, `fineTune`, the sample's correction), level
(`initialAttenuation`), pan (a left or right half of a stereo pair is hard left or right), the loop and its address offsets (`sampleModes` 1 = `continuous`, 3 = `sustain`), the start and
end offsets, and `exclusiveClass` as `choke=`; the volume envelope (timecents; decays are converted from decibels) is the instrument's note envelope, the commonest zone's. Modulators, filters,
LFOs, the modulation envelope, effect sends, key-number scaling of the envelope and `scaleTuning` other than 0 or 100 are named as lost; `holdVolEnv` too. The font's name, copyright and comment go into
the samples' notes; the licence stays `unknown` until you set it. Both formats are subsets: what a file has beyond the table is named, never silently dropped.

**SFZ export.** `soundclaw instrument export <project> <id> [--format sfz] [--to <dir>]` writes `<id>.sfz` and its samples as WAV files (and
`ATTRIBUTION.txt` when a licence asks for it) so the instrument can go to a DAW or another sampler. The note envelope becomes the amplitude envelope, and
what SFZ cannot say (synth layers, effects, the pitch envelope, the velocity crossfade width) is named in the report and a comment in the file. A
licence that is unknown or blocked is warned about. The licence of every sample a zone plays reaches the instrument, and the songs that play it.

#### The pattern text

```
pattern verse1 steps=16 tpb=4 bar=8
  lead: C5 .   E5 .   G5v80 - - . | A4 . . . G4~slide . E4~vib .
  bass: C3 .   .  .   C3    . . . | A2 . . . G2       . .   .
  drum: k  .   h  .   s     . h . | k  k h . s        . h   h
```

In a script a pattern is a block: the header `pattern <song>.<name> steps=<n> tpb=<n> [bar=<n>]`, then indented rows. On the tape it is `pattern set <song>.<name> "<text with \n for line breaks>"` in its normal form. Patterns belong to a song (`songs/<song>/patterns/<name>.pat`); `pattern remove|copy|rename <song>.<name> [<new name>]` manage them (a pattern a section plays is not removed).

- **Header.** `steps` is the length (1 to 256), `tpb` the steps per beat (the grid's resolution: 4 is sixteenth notes, 2 eighth notes, 3 or 12 triplets), `bar` the steps in a bar (written when rows use `|`). A step lasts 60 / (tempo x tpb) seconds.
- **Rows.** `<channel>: <step> <step> ...`, exactly `steps` steps. `.` is a rest, `-` holds the note before it one more step (across a `|` too), `|` only splits bars (the groups must all be `bar` steps). A note lasts until the next event or rest, or the end of the pattern; its release rings on after.
- **Notes.** `C5`, `C#5`, `Db5`, `C-1` (C4 is middle C, 60). A flat stays a flat and a sharp a sharp in the normal form, the messages and the views (`Eb4` is not turned into `D#4`); the helpers spell the notes they write by the song's key: flats in a flat key (F, Bb, Eb, Ab, Db major and their relatives, D, G, C, F minor ...), sharps elsewhere. `v1`..`v127` is the velocity (default 100, left out of the normal form), `!` marks a note outside the song's key on purpose (`G#5!`), and effects follow: `~slide` glides in from the note before it (over 80 ms, when that note ended at this step), `~vib` or `~vib(<Hz>,<semitones>)` (default 5 Hz, 0.4 semitones, starting after 80 ms), `~arp(0,4,7)` steps through 2 to 8 semitone offsets every 20 ms. A chord joins notes with `+`: `C4+E4+G4`. `@<ms>` after the velocity (and `!`) plays the note that many milliseconds off the grid, -50 to 50 (`C5v90@-6`, `E5@4`; a positive nudge has no sign, since `+` joins chord notes); `humanise` writes these.
- **Drums.** A lower-case word is a drum hit (`k`, `s`, `hat`, `oh`), with its own velocity (`sv60`) and nudge (`sv60@-3`). A hit is one step. Which instrument plays a hit comes from the channel's kit.
- **Note lists.** `lead= 0:C5*2 4:E5v90 6:G5` (step, note, `*` length in steps) is another way to write a row; it prints as the grid.
- **Normal form.** The grid, aligned in columns, flats written as sharps, comments dropped; format(parse(x)) is stable. Problems are reported with the line and column: `demo.sclaw:4:14: error: 'Q5' is not a note (like C5, C#5, Db3, C5v80, E5~slide, G4!)`.

#### One note at a time

```
pattern note add <song>.<pattern> <channel> <step> <note|chord|hit> [len=<steps>]
pattern note remove <song>.<pattern> <channel> <step> [<note|hit>]
pattern note move <song>.<pattern> <channel> <step> [<note|hit>] [step=<to>] [note=<to>]
pattern note len <song>.<pattern> <channel> <step> <steps>
pattern note set <song>.<pattern> <channel> <step> [<note|hit>] [vel=<1..127>] [fx=~slide~vib~arp(0,4,7)|none] [accidental=yes|no]
```

Small edits by the step a note starts on (steps count from 0); the music editor writes exactly these, and an agent can too. A row holds one sounding thing per step (a note, a chord, a hit) and its holds, so:

- `add` writes the note over what it lands on: a note holding into it is cut where it begins, a note that starts under it goes. A note added where a note or chord already starts joins it as a chord (the chord takes `len=` when given, else keeps its length); the same pitch is replaced. A hit (`k`, `s`, `oh`) is one step and replaces what is at the step. A channel the pattern has no row for gets one.
- `remove` takes one pitch out of a chord (name it), or the whole note, chord or hit (its holds become rests).
- `move` keeps the length, velocity and effects; `note=` moves a chord as a whole (its lowest note goes to `note=`), or renames a hit (`note=oh`).
- `len` sets how many steps a note or chord lasts (what it grows over goes, as with `add`).
- `set` changes the velocity, effects or `!` mark of a note, or of every note of a chord when no pitch is named (a hit has a velocity only).

```
pattern note add explore.verse lead 4 E5v90~vib len=2
pattern note move explore.verse lead 4 step=6 note=G5
pattern note add explore.verse drums 3 oh
```

#### Songs

```
song new <id> [tempo=120] [swing=0] [time=4/4] [key=A:minor] [class=music|stinger] [tags=a,b] [kind=song|stinger]
song new <id> from-bible=<entry> [<any of the above>]      song new <id> kind=stinger template=victory|game-over|level-up|item-get [key=] [tempo=]
song set <id> tempo= swing= time= key=<tonic:mode>|none class=<name>|none loudness=<LUFS>|auto gain=<g> tags=a,b|none kind=song|stinger
song channel add|set <song> <name> inst=<instrument> | kit=default|<kit instrument>|<hit>:<instrument>,... [gain=] [pan=] [layer=<game layer>] [harmony=yes|no] [reverb=<0..1>] [delay=<0..1>] [convolve=<0..1>]
song channel add <song> <name> audio [gain=] [pan=] [layer=] [reverb=] [delay=] [convolve=]      an audio channel: it plays clips, not notes
song clip add <song> <channel> <sample> at=<bar>[.<beat>] [len=<bars>|full] [stretch=tempo|none] [from-tempo=<bpm>] [method=wsola|pv] [pitch=<st>] [gain=] [fade=<s>] [slice=<n>] [nudge=<ms>]
song clip set <song> <channel> <clip> <key>=<value> ...      song clip remove <song> <channel> <clip>      (audio clips; see "Audio channels and clips")
song channel remove <song> <name>
song section add|set <song> <name> <pattern>... [x<n>]       song section remove <song> <name>       song order <song> <section>...
song intro <song> <section>|none      song ending <song> <section>|none      song loop <song> <from>[..<to>]|auto|off
song fx add|set|remove|move <song> <effect> ...      the master chain (default: a limiter at -1 dB; compress and limit are for this)
song send <song> reverb|delay|convolve [<param>=<value> ...]|off      the song's send reverb, send delay and send convolution (see "Send buses")
song copy|rename <id> <new>    song remove <id>    song mark <id> approved|rejected|draft
```

`tempo` is 30 to 300 bpm. `swing` (0 to 0.6) delays the second step of each pair of steps by swing x a step. `key` is `<tonic>:<mode>` with a mode of `major`, `minor`, `dorian`, `phrygian`, `lydian`, `mixolydian`, `locrian`, `harmonic-minor`, `melodic-minor`, `pentatonic-major`, `pentatonic-minor`, `blues` or `chromatic`. A channel plays one instrument (a project instrument, else a built-in) or a drum kit; `gain` is 0 to 4, `pan` -1 to 1, and `layer` names the game layer (stem) it belongs to (default `base`; others like `tension` and `combat`).

**Order.** The intro section plays once, first; the other sections are the body, in order; the ending plays once, last. `loop` names a run of body sections that repeats (default: the whole body); `loop off` makes a song that does not loop (a jingle). A section is its patterns in order, repeated `x<n>` times. A new body section goes before the ending. A song is at most 600 s, 16 channels, 64 sections and 64 patterns. A batch that leaves a song unable to play (an instrument that does not exist, a drum hit in a pitched channel, a note in a drum channel, a section naming a pattern the song lacks) is refused with the reason; a pattern row for a channel the song does not have, or a pattern that is not a whole number of bars, is a warning.

**Rendering.** Every channel is rendered on its own (a sum of notes, each note one cached render of its instrument at its pitch and length), panned (constant power) and summed with the song's gain, then sent through the master chain, in 44,100 Hz stereo. A channel is a cached part, keyed by the notes it plays, its instruments, gain and pan: changing one channel renders that channel again and nothing else. The result is the same bytes in Node and in the browser (the golden hashes in `core/test/music-golden.json` pin it).

**Loops.** The loop region is rendered folded onto itself: every note is rendered with its release and effect tail, and what runs past the end is added to the start, which is what a player hears when the region repeats. There is no click and no dip at the seam. The master chain runs over the region twice and the second pass is kept. A loop export is exactly the region's length. **Stems** are the channels of each game layer summed (all the same length, the loop's when the song loops); they are before the master chain, so they sum to the mix whenever the chain does not turn the mix down (the numbers say how far it does).

**Export.** `export <project> <song>` writes the whole song (intro, body once, ending); `--loops <n>` repeats the loop region in it. `--loop` writes the loop region alone, seamless; with `--loops <n>` the region n times over, end to end. `--stems` writes one aligned file per game layer (the stems of the loop when the song loops; `--loops` repeats them too). `--format midi` writes the notes (`--pattern` for one pattern). Combinations that mean nothing are refused with what to do instead: `--loops` where the song has no loop region, `--pattern` with audio, `--quality` with wav (it is for ogg), `--loop`, `--stems`, `--loops` or `--quality` with midi, `--stems-through-master` without `--stems`, song flags (`--loop --stems --loops --pattern`) on a sound, `--all`, `--pack` or `--set` on a song, songs and sounds in one command, and both `--to` and `--out`.

**Stems and the master chain.** Stems are before the master chain, so they sum to the mix when the chain does not turn the mix down. With **`--stems-through-master`** the chain's linear part, its **filters** (a low-pass or high-pass, a notch: the tone shaping), is run over each stem, so that shaping reaches the stems a game plays. What cannot be split among stems is not applied, and the export says so: a **compressor** or **limiter** follows the level of the whole mix, and `delay`, `reverb`, `chorus`, `distort` and `bitcrush` are not filters. The stems then sum to the mix as the filters leave it, before those effects: louder than the exported mix, and not limited. With no filter in the chain they are the plain stems. The manifest (`<song>-manifest.json`) has `stems: { throughMaster, applied, notApplied }`.

**Audio channels and clips.** A song can hold recordings as well as notes: `song channel add <song> loops audio` makes an **audio channel**, and `song clip add <song> loops <sample> at=3.2`
places a sample of the project on it (bar 3, beat 2; bars and beats count from 1, a beat is a quarter note). A channel is one kind for good (an instrument, a drum kit or audio); an audio channel
has the channel's `gain`, `pan`, `layer` (so a game's stems carry it) and the three sends, and no pattern rows (a row for it in a pattern is said and not played). A clip is played by the sample
layer the renderer already has, so it sounds as the same sample on a layer would (the windowed sinc, the two time stretches, the fades): a loop that plays through, a stinger, a texture or a
generated bed. Its settings: `len=<bars>` (a half bar is `0.5`) keeps the first part, `full` (the default) the whole sample; `slice=<n>` plays slice *n* of the sample; `gain` is a level
(0 to 4); `fade=<s>` fades each end; `nudge=<ms>` moves it off the grid, as a note's nudge does; `pitch=<semitones>` moves the pitch. **Tempo sync:** `stretch=tempo from-tempo=90` fits a recording
made at 90 bpm to the song's tempo by the time stretch (`method=wsola` for hits and voices, `pv` for tones and pads), the pitch kept (to a ratio of 0.25 to 4), and it follows the song when its
tempo changes; with `pitch=` the pitch moves and the length is still the synced one (without `stretch=tempo`, `pitch` is a faster or slower tape and the length follows). `from-tempo` alone means
`stretch=tempo`; `stretch=tempo` without it makes the command listen to the sample once, write the tempo it found into the command (`from-tempo=90`) and say so, or ask for one when the spacing
of its onsets is not steady. A clip that runs past the end of the song is let ring up to 4 s, as a note's tail is; in a loop the part past the end wraps to the start. A mono clip is panned with
the constant-power law as a note is; a stereo clip keeps its sides (a centred channel plays it as it is). The command prints the number of the clip it made (`clip 3`); `song clip set` and
`song clip remove` take that number (the song's file lists them: `clip loops 3 sample=… at=3.2 …`). The channels render and cache like the others: the key holds each clip's place, settings,
the sample's hash and the tempo, so changing a note leaves the audio channel in the cache, a partial render is the render of the whole to the byte, and the same bytes come out in Node and the
browser. A sample that a clip plays cannot be removed while the clip is there, a rename follows, an undo that would take it away says so, and the song carries the licence of every clip
(`licence check`, the manifest and `ATTRIBUTION.txt`). Audio channels are not in a MIDI export. `soundclaw view <project> <song> notes` and the note checks look at instrument channels only.

**Send buses.** A song has one **send reverb**, one **send delay** and one **send convolution**, so the whole piece sits in one space: `song send <song> reverb size=0.6 damp=0.4` sets the reverb up (`size`, `damp`), `song send <song> delay time=0.375 feedback=0.35` the delay (`time`, `feedback`), `song send <song> reverb off` takes it away (and clears the channels' sends). The send convolution is a room made of a sample, `song send <song> convolve ir=<sample> [predelay=] [gain=] [len=<s>]` (the `convolve` effect above, wet only; `len` is the response's length when it is not given): one real room can replace the reverbs of the instruments. A channel feeds a bus by an amount, `song channel set <song> <channel> reverb=0.3 delay=0.1 convolve=0.4` (0 to 1, after the channel's gain and pan). The bus returns only the effect (its mix is always 1; `mix=` is refused): the dry channel is unchanged, and the effect of every channel that feeds it is added to the mix before the song gain and the master chain. A full render leaves room after the last note for the bus to ring out (up to 4 s); a loop wraps the tail to its start as the notes' tails do. The channel parts, and so every analysis of a channel alone (`render-match`, `masking`), are the dry channels. Both buses are linear, so each game layer's stem carries the share of the return its own channels send, and the stems sum to the mix before the master chain.

**Loudness.** A song is held to a class: `music` (-16 LUFS, ±2 LU, the default) or `stinger` (-14 LUFS, ±2), or its own `loudness=`. `normalize <project> <song> [target=<LUFS>]` writes `song set <id> gain=...`; if the master limiter stops it short it says how far. A song with a layer plan (`layer-plan`) is held to every mix a game can play, so `normalize` fits them together: the base alone and the base with each set of the other layers (the mixes the `layers` check measures) all inside the class's window. If the base alone and the fullest mix already fit with room to spare, the song gain centres them and the balance the music has is kept; if they are further apart than the window, the base goes to the low end and the channels above it are turned down together (`song channel set <song> <channel> gain=...`, one line each) until the fullest mix is at the high end. It measures with the gains as they will be written and says in a note what still does not fit (a mix outside the window, a true peak over the limit, the whole song with its master chain outside it). A song whose mixes already fit has nothing to write. `normalize` is also a line of a `run` script or batch, on what the batch has made so far; the tape holds the gain commands it measured, not the word `normalize`.

#### MIDI

`export <project> <song> --format midi [--pattern <name>]` (or `midi export`) writes a type 1 file with the tempo, the time signature, a track per pitched channel and one drum track on channel 10 (General MIDI numbers: kick 36, snare 38, hat 42, open hat 46; other hits get numbers from 60). Swing, effects and instruments are not written. `midi import <project> <file.mid> [--id <song>]` reads type 0 and 1 files: the first tempo and time signature (later tempo changes are ignored and said), a pattern per two bars on the grid (4, 2, 8, 3, 6, 12 or 24 steps per beat, whichever fits the notes best; timings go to the nearest step), a channel per track and MIDI channel (a polyphonic part is split into lines, chords are notes that start and end together), instruments from the General MIDI program (bass, pad, bell, pluck, else `square_lead`), and drums on channel 10 as a kit channel (toms to `k`, cymbals to `oh`).

#### The song's ears

`view <project> <song> notes|mix|wave|spec|loop [--from <s>] [--to <s>] [--channels a,b]`, `render`/`describe` (the numbers: length, loop length, loudness, true peak, loudness and note count of each channel alone, tempo, key, how far the master chain turns the mix down) and `check`:

| check | holds the song to | flags |
|---|---|---|
| `clip` | true peak at most -0.1 dBTP and no samples at full scale (the mix, after the master chain) | the places over |
| `loudness` | the class target ±tolerance | the whole song |
| `dc` | DC offset at most 0.5 % | the whole song |
| `key` | every written note in the song's key, or marked `!` (notes made by `~arp` are not checked) | each note, with its channel, pattern and step |
| `range` | every note inside the range its instrument declares | each note |
| `render-match` | each channel rendered alone: the onset of each written note within 20 ms (plus half its instrument's attack) and a single note's pitch within 0.6 semitones (chords and `~arp` notes: timing only; notes under 55 Hz are not pitched); a note whose onset has no rise in level (one that touches the note before it, a legato line) is found in the change of pitch; a pitch the tracker gets wrong on a decaying pluck is looked for again in the start of the note (the written pitch must be the fundamental there), so a plucked line needs no helper layer; a note 40 dB under its channel's loudest counts as not heard | the note, with `wrong octave` and `wrong pitch` told apart (a wrong `root` is what usually does it) |
| `loop-music` | the loop's seam: no jump from the last sample to the first (more than `clickMax` and 4 times the local step), and no more than 2 x `seamStepMaxDb` (6 dB) between the loudness of the last beat and the first (a gap of silence is a gap, not a step) | the seam |
| `masking` | in each 46 ms frame, the band with the most energy (sub, low, mid, high, air): the two loudest channels in it must not be within 4 dB of each other for more than 25 % of the time | the stretches of 0.5 s or more, longest first, each with its time range, the two channels, the band (and its Hz), and how many dB apart they are; the value line names the longest three. They are listed even when the check passes. **Advisory:** it is a warning and never blocks `work done` |

The composition helpers add three more checks, `voice-leading`, `style` and `layers` ("Composition helpers" below). `work done` on a request about a song needs every check to pass except `masking` and `voice-leading`. The `notes` view draws, per channel, the written notes (blue bars), the detected pitch (yellow), the detected onsets (green ticks) and the notes that differ in red; `mix` draws each channel's energy in five bands over time with the masked stretches in amber. Both are saved under `<project>/.cache/views/` and printed with the numbers.

#### Composition helpers

The helpers are commands that write notes into a pattern. They are not generators hidden behind a seed: each one goes on the tape with every option resolved and the rows it wrote (`written="…"`), so the history shows the notes, a replay puts back exactly those rows (it never works them out again, so a later change to a helper cannot change an old song), and the notes can then be edited by hand like any others. A helper writes the rows of the channels it names and leaves the pattern's other rows alone; when the pattern does not exist it makes one as long as the progression (or `bars=`), on a grid of 4 steps per beat unless `tpb=` says otherwise. A helper works in the song's key (`song set <id> key=D:major` first). A note it writes outside the key (V in a minor key, a borrowed bVII, a secondary dominant) is marked `!`, so the `key` check passes it as meant.

```
$ soundclaw run town.sclaw -e 'chords town a pad "I vi IV V" rhythm=beats'
  #12 chords town a pad "I vi IV V" bars=1 rhythm=beats voices=3 range=G3-G5 vel=100 tpb=4  (wrote:)
        pad: D4+F#4+A4 - - - D4+F#4+A4 - - - ...
```

**Scales.** A key is `<tonic>:<scale>`. Besides the modes above there are `ionian`, `aeolian`, `natural-minor`, `major-blues`, `whole-tone`, `phrygian-dominant`, `hungarian-minor`, `double-harmonic`, `harmonic-major`, `lydian-dominant`, `hirajoshi` and `octatonic`. `soundclaw scale list` prints every scale with what it sounds like; `soundclaw scale D:dorian` prints the notes and, for a seven-note scale, the triad and seventh chord on each degree with its roman numeral; `soundclaw scale <project> <song>` does it for the song's key. Roman numerals in a scale of other than seven notes count in the major (or natural minor) scale on the same tonic.

**Progressions.** A progression is roman numerals in quotes, counted in the song's key: upper case a major chord, lower case a minor one, whatever the scale (`I vi IV V`; in A minor `i iv V` gives the major V of harmonic minor, `i iv v` the minor one). After the numeral:

| suffix | chord | example |
|---|---|---|
| `°` or `o` or `dim` | diminished | `vii°` |
| `ø` | half-diminished seventh | `iiø7` |
| `+` or `aug` | augmented | `III+` |
| `7` | a minor seventh on top (a dominant seventh on a major chord, a minor seventh on a minor one, a diminished seventh on `°`) | `V7`, `ii7`, `vii°7` |
| `maj7` | a major seventh | `IVmaj7` |
| `sus2`, `sus4` | the third replaced by the second or the fourth | `Vsus4` |
| `add9` | an added ninth | `Iadd9` |
| `6` / `64` | first / second inversion of a triad | `I6`, `I64` |
| `65` / `43` / `42` | first / second / third inversion of a seventh chord | `V65` |
| `b` or `#` before it | borrowed: the chord on the lowered or raised degree (and a minor `iv` in a major key is borrowed by its case) | `bVII`, `bVI`, `iv` |
| `/<numeral>` | secondary: the chord in the major key on that degree | `V/V`, `V7/vi`, `vii°/V` |
| `:<bars>` | its length in bars (else `bars=`) | `I:2 V:1` |

`bars=` gives every chord's length (`bars=2`) or each in turn (`bars=2,1,1,2`; half a bar is `0.5`). A progression shorter than the pattern repeats to fill it.

**Chords.**

```
chords <song> <pattern> <channel> "<progression>" [bars=1] [rhythm=hold] [voices=<n>] [range=<lo>-<hi>] [vel=100] [gate=<0..1>] [legato=yes] [tpb=4]
```

The chords are voiced with smooth voice leading: each chord's notes are chosen inside the range (default G3 to G5, narrowed to the instrument's own range) to move as little as possible from the chord before, with no parallel fifths or octaves where they can be avoided, the root doubled before the fifth and the fifth before the third, and the voicing kept near the middle of the range. `voices` is 2 to 6 notes (default: the most notes any chord has). `rhythm` is `hold` (each chord held for its length), `bar`, `half` or `beats` (struck every bar, half note or beat), `pulse` (every step), `offbeat` (on the off beat, resting on the beat), or a mask repeated across the pattern: `x` strike, `X` accent (velocity + 20), `-` hold, `.` rest (`rhythm="x-.x-.x-"`). Each chord starts with a strike. Mark the channel `harmony=yes` (`song channel set <song> <channel> harmony=yes`) to have the `voice-leading` check read it.

**Gate and legato** (chords, bass and arp). `gate=<0..1>` sets how long each note sounds as a fraction of the time to the next note (or to the end of its span); the rest of the time is a rest. The grid holds a note for whole steps, so the length is rounded to a step and is never less than one: `gate=0.5` on a chord that lasts a bar of 16 steps holds it 8 steps and rests 8; a one-step arpeggio note cannot get shorter (write the pattern at a finer `tpb` for that). Without `gate` the helper's own rhythm decides, as before. `legato=yes` holds every note right up to the next (a gate of 1, rests inside a rhythm included), the way to write a line for a legato instrument (`instrument set <id> legato=yes`); giving it with a `gate` below 1 is an error. The options are written in the helper's normal form, and the notes are on the tape as before.

**Bass.**

```
bass <song> <pattern> <channel> ("<progression>" | from=<channel>) [style=root] [rate=<r>] [bars=1] [range=C2-C4] [vel=100] [gate=<0..1>] [legato=yes] [tpb=4]
```

`from=` follows the chords another channel of the same pattern plays (each chord or note lasts until the next). `style`: `root` (the root, once per chord; default rate `chord`), `root-fifth` (root and fifth, half notes), `octave` (the root and the octave above, eighth notes), `walking` (quarter notes: the root on the beat, chord tones and scale tones heading for the next chord, and a step into its root; never the same note twice running). An inverted chord puts its bass note (the third of `I6`) in place of the root. `rate` is `chord`, `1`, `1/2`, `1/4`, `1/8`, `1/16` or `1/32` (a whole note to a thirty-second note; it must be a whole number of steps on the grid). The range defaults to C2 to C4, narrowed to the instrument's.

**Arpeggios.**

```
arp <song> <pattern> <channel> ("<progression>" | from=<channel>) [pattern=up] [rate=1/16] [octaves=1] [bars=1] [range=C4-C6] [vel=100] [gate=<0..1>] [legato=yes] [tpb=4]
```

The chord's notes from its lowest root in the range, over 1 to 3 `octaves`, in the order `up`, `down`, `updown` (up and back without repeating the ends) or `random(<seed>)` (seeded: the same seed writes the same notes; never the same note twice running), one note every `rate`.

**Motifs.** A motif is a named note list kept in the song (`motif <name> tpb=4 D5 - F#5 A5` in the `.song` file), written in the pattern text's cells (notes, chords, `-`, `.`, velocities, effects). The transforms make a new motif (`as=<name>`) or replace it:

```
motif set <song> <name> "<cells>" [tpb=4]          motif remove <song> <name>
motif transpose <song> <name> by=<n> [mode=chromatic|diatonic] [as=<new>]     by semitones, or steps of the song's scale
motif invert <song> <name> [around=<note>] [mode=diatonic|chromatic] [as=]    mirrored about a note (default its first), along the scale when the song has a key
motif retrograde <song> <name> [as=]               the notes backwards (each keeps its length)
motif augment|diminish <song> <name> [factor=2] [as=]   lengths times or divided by 2 to 4 (a diminish that does not divide moves the motif to a finer grid)
motif write <song> <name> <pattern> <channel> [at=0] [by=0] [mode=chromatic] [vel=] [bars=] [tpb=]     the motif into a pattern from step at, moved by
motif sequence <song> <name> <pattern> <channel> "<progression>" [bars=1] [mode=diatonic] [vel=] [tpb=]   the motif once per chord, moved as the chord's root moves
```

A note a transform moves out of the key is marked `!`. A motif's grid must fit the pattern's (a motif at tpb=2 writes into tpb=4 at two steps a cell; the other way is an error). `motif sequence` with `mode=diatonic` moves the motif by the chord's degree (I IV V I: up three steps, up four, back), with `mode=chromatic` by the semitones between the roots (the nearer way, up to a tritone).

**Drums.**

```
drums <song> <pattern> <channel>[,<hat channel>] <template> [bars=<n>] [fill=0] [seed=1] [vary=0.25]
```

A drum template is one bar of kick, snare and hats; `drums` writes it into every bar of the pattern (or a new pattern of `bars` bars) of a channel with a drum kit, kick `k`, snare `s`, hat `h`, open hat `oh`. With one channel the hats play where the kick and snare rest; with two (`drums,hats`) the hats get their own channel. `fill=4` puts a fill in the last beat or two of every 4th bar; `vary` (0 to 1) adds seeded variation in every bar but the first (ghost snares, an extra kick, a hat opened or dropped), the same for the same seed.

| template | feel | |
|---|---|---|
| `rock`, `rock-16`, `rock-push` | straight rock | kick on 1 and 3 and snare on 2 and 4; sixteenth hats; a syncopated kick |
| `halftime`, `halftime-ghost` | half-time | the snare on 3 only; with ghost notes |
| `shuffle`, `shuffle-half` | shuffle | triplet swing (tpb=3) |
| `march`, `march-roll` | march | bass drum on 1 and 3 under snare figures; a running snare |
| `waltz`, `waltz-light` | waltz | 3/4 |
| `pulse`, `pulse-sparse` | ambient pulse | a soft heartbeat; one kick a bar |
| `chip`, `chip-gallop`, `chip-break` | chiptune | driving noise hats; a galloping kick; a broken beat |

A template must fit the song's bar (a waltz needs 3/4) and the pattern's grid.

**Humanise.**

```
humanise <song> <pattern> <channel>[,<channel>...]|all [timing=8] [velocity=6] [seed=1]
```

Moves each note or hit off the grid by up to `timing` ms (0 to 50) and its velocity by up to `velocity` steps (0 to 40), both from a seeded triangular spread (most moves small), and writes them into the notes: the timing as a nudge, `C5@-4` or `kv92@6` (−50 to 50 ms; a nudge is the note's own, so humanising again replaces it, while velocity moves from what the note has). `humanize` is the same command. The checks read the notes on the grid: a chord humanised apart is still one chord to `render-match` and `voice-leading`. In a looping song a note nudged before the start of the loop plays at its end.

**Layers.**

```
layer-plan <song> base=<channel>,... <layer>=<channel>,... ...
```

Names the game layers (stems) in the order they stack and puts each channel in one (a channel left out joins the base): `layer-plan battle base=pad,bass tension=arp,hats combat=drums,lead`. The `layers` check then plays every mix a game can play, the base with each combination of the others (up to five layers above the base): each mix within the song's loudness class, under the true-peak limit with no limiter (stems are summed as a game sums them), and with a clean loop seam; each layer alone in key and no louder than its class allows. The check's line lists every mix with its loudness (`base -17.9, base+tension -16.4, ... LUFS`). Export the stems with `export <project> <song> --stems`.

**Style guide and music bible.** Two Markdown files in the project folder that people write and SoundClaw reads (`soundclaw style <project> --init` writes a starter pair; `soundclaw style <project>` prints what it reads and the lines it cannot). Prose is for people; the `key: value` lines are data.

`music-style.md` holds every song to the project's style; `## <tag>` sections add rules for songs with that tag (their values replace the guide's; `## stinger` holds stingers):

```
tempo: 70-150
key: C:major                       the project's key (stingers take it)
scales: major, minor, dorian       the scales a song's key may use
instruments: square_lead, saw_pad, triangle_bass, kick, snare, hat
loudness: music, stinger           the loudness classes songs may use
swing: 0-0.3
forbid: locrian                    a scale, an instrument, drums, accidentals or swing,
forbid: drums in town                optionally in songs with a tag

## town
tempo: 80-112
scales: major, mixolydian, pentatonic-major
```

`music-bible.md` has an entry per track, a `## <id>` heading (the id is its first word; a title may follow after a dash) and its data:

```
## market — the market square
mood: warm, unhurried, a little proud
tempo: 96
key: D:major
time: 4/4
tags: town
instruments: lead=square_lead, pad=saw_pad, bass=triangle_bass, drums=kit
motif: theme tpb=4 D5 - F#5 A5 B5 - A5 - G5 F#5 E5 F#5 D5 - - -
region: the market square at noon
```

`song new <id> from-bible=<entry>` sets a song up from it and goes on the tape as the plain commands it stands for: `song new` with the tempo, time, key, swing, class, tags and `bible=<entry>`, a `song channel add` per instrument, and a `motif set` per motif (other options on the line win over the entry's). The `style` check holds a song to the guide's rules for its tags, and a song from the bible to its entry (tempo, key, time, channels and their instruments, its motifs present).

**Stingers.** `song new <id> kind=stinger template=<template> [key=<key>] [tempo=<bpm>]` writes a short piece that ends and never loops: a lead, a harmony part, a bass and (for some) drums in one pattern, played as the song's ending with the loop off, in the `stinger` loudness class. The templates are written in scale degrees, so they land in any key (default: the style guide's `key`, else C:major).

| template | |
|---|---|
| `victory` | a rising arpeggio and a held tonic chord, about 3.6 s |
| `game-over` | a slow fall from the fifth to the tonic over vi IV V I, about 4.8 s |
| `level-up` | a scale run up an octave over IV V I, about 1.6 s |
| `item-get` | a quick sparkle up two octaves to a held tonic, about 1.7 s |

A song of `kind=stinger` refuses `song loop` (other than `off`) and warns when it has no ending. `song set <id> tags=a,b` and `kind=song|stinger` change them later.

**The helpers' checks.**

| check | holds the song to | flags |
|---|---|---|
| `voice-leading` | the channels marked `harmony=yes`, read as voices low to high: no two moving the same way into a fifth or an octave (on the grid) | each pair, with the notes and the step. **Advisory:** a warning that never blocks `work done` (the style may want parallels) |
| `style` | the style guide's rules for the song's tags, and its bible entry (skipped when there is neither) | each rule broken |
| `layers` | with a layer plan: every mix of the base and the other layers within the class, under the true-peak limit, with a clean seam; each layer alone in key and within the class's top | each mix or layer |

### Loudness classes

One loudness target for every sound is wrong for a game: a UI tick is not as loud as an explosion (a real set spans about −8 to −49 LUFS). The style names **loudness classes**, each with a target and a tolerance, and every sound is held to its class:

| Class | Target | Tolerance | For |
|---|---|---|---|
| `standard` | -16 LUFS | ±1 LU | a sound with no class (the default class): the style's loudnessTarget and loudnessTolerance |
| `ui` | -28 LUFS | ±3 LU | ticks, clicks, toggles, menu sounds |
| `foley` | -22 LUFS | ±2 LU | footsteps, doors, rustles, props |
| `impact` | -14 LUFS | ±2 LU | hits, explosions, crashes, spells |
| `ambience` | -26 LUFS | ±3 LU | beds and loops under everything |
| `voice` | -20 LUFS | ±2 LU | voices, barks, giggles |
| `music-sting` | -16 LUFS | ±2 LU | bells, stingers, short musical cues |

- A sound's class: `sound set <id> class=<name>` (`class=none` clears it); `loudness=<LUFS>` holds this sound alone to its own target (the class's tolerance still applies; `loudness=auto` clears it). A set has a class too: `set new … class=<name>` or `set class <set> <name>`, which its members use if they have none of their own, and which — when the set has no `target` — is also what `set new`, `set add` and `set class` match the members to by gain.
- Which rule holds a sound, most specific first: its own `loudness`, its own `class`, the `target` of its set, the class of its set, the style's `defaultClass` (`standard`). A far or muffled family variant is held to that target plus its offset.
- `check`, `measure` and `describe --json` say which rule applied: `held to -28.0 LUFS ±3 (class ui)`, `(class ui; own loudness)`, `(class standard; target of set steps)`. The recipes (ui-click, footstep, door, magic and the sound-effect recipes below) start their sounds in the class they were made for.
- The project style adds to or replaces the classes: `"style": { "loudnessClasses": { "ui": { "target": -30, "tolerance": 3 }, "boss": { "target": -9 } }, "defaultClass": "foley" }` (tolerance defaults to 1 LU; a class name is `a-z`, `0-9`, `-`).
- `normalize <project> <id|set>... [<class> | target=<LUFS>]` writes the gain that brings sounds to their class (or to a class you name, which they join, or to a target they are then held to). A layered sound's gain goes up to 4 and, if that is not enough (a quiet or sparse sound), the rest is the `gain` of the limiter that ends its master chain (up to +48 dB, added before limiting: one is added with `ceiling=-1` when the chain has none at its end), so the peaks the extra level makes are held under the ceiling and the clip check still passes; when even that cannot reach the target the sound is listed as `not normalized: …` (naming it and what it measures at the most) and left exactly as it was, and the other sounds are still normalized (the CLI exits 1 when any was left); only when no sound could be normalized is it an error that writes nothing. A sound that ends inside its class's tolerance (say 0.6 LU under a ±1 window) counts as normalized, with a warning, since it passes the loudness check. Going quieter takes the limiter's gain back first, then `out` (what older runs left), then `gain`. A classic sound's `volume` stops at 1 or at the volume where it would start to clip (the clip check would fail above it), whichever is lower, and the warning says how many LU it falls short (`sound layer-up` first lets gain go to 4).
- **When two checks pull against each other**, `check` names the rule that binds, so they are fixed in the right order: harsh and loudness ("louder is harsher": lower the 2–5 kHz energy first, then raise gain), and clip and loudness (shave the peaks with `compress` / `limit` first, then raise gain).

### Checks and the project style

Six checks hold a sound to the project's style (below), and a seventh, `set-spread`, holds a set of sounds ("Sets" above). Each has a score from 0 to 1, a threshold,
and the exact time ranges it flags.

| Check | Flags | Default |
|---|---|---|
| `clip` | true peak above the limit, or samples at full scale (the ranges are where) | at most -0.1 dBTP |
| `loudness` | integrated loudness (ITU-R BS.1770, K-weighted, gated) off the target of the sound's class (above) | its class: `standard` -16 LUFS ±1 |
| `dc` | DC offset | at most 0.5 % |
| `click` | a jump at the first or last sample (a loop: at its seam, see "Loops") | at most 0.02 of full scale |
| `tail` | silence padding at the start or end, or a sound cut off before it died away (the last samples are not at least 60 dB below the peak; an exponential decay that reaches −60 dB at its end counts as finished, so the rule has 1 dB of slack); a loop needs no fade-out | at most 50 ms; -60 dB |
| `harsh` | sustained energy at 2 to 5 kHz: the level of that band (dBFS, RMS of the band content, from 1024-sample Hann spectra; a full-scale sine inside it reads -3) stays above the limit for at least the minimum time (the ranges are where) | at most -20 dBFS for 80 ms |

| `set-spread` | (a set, `check <set>`) members closer together than `setSpreadMin` or farther apart than `setSpreadMax`, or a member's loudness off the set's target | 1 dB; 20 dB; ±1 LU |

**A classic sound is measured as its exported WAV holds it**: the engine's pre-rendered form is `trunc(s × 32000)` in 16 bits, so a classic sound's samples are read as that value over 32768 (a full-scale 1.0 is 0.977, 0.2 dB under full scale). Its peak, true peak, rms and loudness therefore agree with the exported file within 0.05 dB (and with ffmpeg's `ebur128` on it), and the `clip` check counts a run at that level (31,996 of 32,768 and up) as full scale. Layered sounds already export at the scale they render at. The `render` summary line (peak, rms) is the float render; `measure`, `describe` and `check` are the exported scale.

Every check works on stereo (below). A sound shorter than 400 ms is measured as one block over its whole length (BS.1770 needs 400 ms
blocks; padding with silence would lower the figure). `work` `done` on a request is refused while the
sound's checks fail. Targets come from the optional `style` object in `project.json`, any of
`loudnessTarget`, `loudnessTolerance` (the `standard` class), `loudnessClasses` and `defaultClass` (above), `truePeakMax`, `dcMax`, `clickMax`, `silenceMax` (seconds),
`tailFloorDb`, `harshLimitDb` (dBFS), `harshMinMs`, `setSpreadMin` (dB), `setSpreadMax` (dB), `seamStepMaxDb` (dB); the defaults fill what is left out. An unknown key is an error.

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
`human:ana`; with no name, the last one used in that browser, else `human:owner`).

## Samples

A sample is audio kept once, by content, in the project, with a name, where it came from and its licence. The audio is a plain WAV in
`samples/objects/<first two hex digits>/<hash>.wav`; objects are never rewritten or renamed. The **name** is on the history tape
(`sample add <name> hash=…`), so a sample has an author and an undo group like a sound, and pointing a name at other audio is a command
that undo takes back. `samples/<name>.sample` is the same facts as text, written from the tape for reading and diffs.

*The hash* is the SHA-256 of a fixed header (`soundclaw-pcm 1`, then the rate, the channels and the sample format) and the samples as
little-endian values, not of a file's bytes: the extra chunks a WAV may carry (`LIST`, `smpl`, `bext`) do not change it, and the same
audio read from a WAV, an AIFF or a FLAC file has one hash and is kept once. The renderer reads the stored audio only: a file is decoded
once, when it is imported, and a replay or a render never decodes a compressed file or measures anything.

### Importing

`soundclaw sample import <project> <file | folder>` (the MCP `sample` tool's `import`, or a file dropped on the dashboard) reads:

| Format | Read |
|---|---|
| WAV | PCM 8, 16, 24 and 32 bit; float 32 and 64 (stored as float 32, and the import says so); `WAVE_FORMAT_EXTENSIBLE`; 1 to 8 channels |
| AIFF, AIFF-C | uncompressed (`none`), `sowt` (little-endian) and `fl32` |
| FLAC | every subframe kind and stereo mode, 4 to 32 bits (stored at the width that holds them, left-justified) |
| OGG, Opus, MP3, M4A/AAC, WMA | through `ffmpeg` when it is installed (stored as 16-bit PCM at the file's own rate and channels; the original file's hash is kept in the provenance); otherwise the error says to install it or convert the file to WAV |

The decoders are plain TypeScript in `core`; ffmpeg is an import-time convenience and never a render dependency. Channels are kept. What a
file says about itself is read and printed: the root note and fine tuning, a loop and the one-shot flag (`smpl`, `acid`, AIFF `INST`), cue
points (kept as slice points), the tempo and text tags (kept in the note). Licence text in a file is not taken as a licence.

The name defaults to the file's name with anything but letters, digits, `_` and `-` turned into `_`; `as=<name>` names it. A folder
imports every audio file directly in it as **one undo group**; a file that cannot be read is reported and the others still go in. The same
audio under a second name adds the name, not a second object, and says so. A name that exists with other audio is refused. Importing
the same file under the same name again does nothing. SoundClaw never fetches a file from an address: download it with your own tools and import it with `origin=<address>`, so the provenance keeps where it came from.

**Limits** (printed when one is hit):

| | Limit |
|---|---|
| A file | at most 600 s and 200 MB |
| Rate | 8,000 to 192,000 Hz (files of a 0.1 project from 3,000 Hz still open) |
| Channels | 1 to 8 |
| What a sample layer plays | at most 120 s of a sample |
| The store | a warning past 250 MB; an import past 1 GB is refused without `--force` |

### The tape commands

```
sample add <name> hash=<sha256> rate=<Hz> channels=<n> frames=<n> format=pcm8|pcm16|pcm24|pcm32|f32 [<field>=<value> ...]
sample set <name> <field>=<value> ...          (<field>=none clears an optional field)
sample rename <name> <new name>                (sounds and instruments that play it follow)
sample remove <name>                           (refused while a sound or instrument plays it)
```

`sample add` names audio that is in the store: a batch that names a hash that is not there is refused, naming the hash (import first).
`sample set <name> hash=…` points a name at other audio and needs `rate=`, `channels=`, `frames=` and `format=` with it; renders follow it,
and `undo` brings the old audio back. The fields, in the order the normal form writes them:

| Field | Value |
|---|---|
| `root`, `tune` | the pitch the audio sounds at (`C4`, `F#3`, or a MIDI number) and a tuning offset in cents (-100 to 100) |
| `loop`, `loopmode` | loop points in frames (`<start>-<end>`) and `none`, `sustain`, `continuous` or `oneshot` (`sustain` when a loop is given) |
| `slices` | slice points in frames, ascending (at most 1024) |
| `tags`, `gain`, `note` | up to 32 lower-case tags (`wood,door`); a default level in dB (-60 to 24); a note (at most 400 characters) |
| `source` | `file`, `library`, `recorded`, `generated`, `derived`, `bounce` or `instrument-import` (default `file`) |
| `origin`, `orig-hash`, `orig-format` | a file name, a library id and path, or an address (never an absolute path from a disk); the original file's SHA-256 and format |
| `container-hash` | the SHA-256 of the SFZ or SoundFont 2 file an instrument import took the sample from |
| `date`, `author` | when and by whom, written by the writer from the tape line |
| `provider`, `endpoint`, `model`, `prompt`, `params`, `seed`, `take`, `request`, `credits` | for generated audio: who made it and how, take `n/m`, the provider's request id and the credits charged |
| `kept-from` | for a kept take: the name it was generated under (Keep in the dashboard writes it with the `kept` tag; the Takes list reads it, so editing the tag does not bring a kept take back) |
| `parents`, `ops` | for derived audio: the parents' hashes and the operations |
| `licence`, `attribution`, `terms` | see below |

### Editing samples

Editing is a command, and it is worked out once, when it runs: whatever is measured (an onset, a loudness, a loop point, a silence threshold) is written onto the
tape as plain numbers, and a replay applies the numbers and measures nothing. A derived sample is a `sample add` with `source=derived`, the parents' hashes
and the settled chain in `ops=`; its audio goes into the store like any object. A project that is opened without such an object makes it again from its
parents and that chain, and refuses to open if the hash comes out different.

```
sample derive <new> from=<name> op="<operations separated by ;>" [<field>=<value> ...]
sample slice <name> at=onsets [sensitivity=<0-1>] [min-gap=<s>] | at=<t,t,...> | grid=<n> [tempo=<bpm>]
sample loop <name> find [near=<start>-<end>] [min=<s>] | sample loop <name> <start> <end>
sample bounce <new> from=<sound|song> [layer=<n>] [channel=<name>] [loop=yes] [<field>=<value> ...]
layer align <id> <n> to=<m>|start [by=onset|peak]
layer match <id> <n> to=<m> [db=<offset>]
env <id> <n>.amp follow=<layer number>|sample:<name> [attack=<s>] [release=<s>]
```

**`sample derive`** takes a chain of operations (at most 32). Times are seconds, `250ms` or `1234f` (frames); the result is stored as 32-bit float at the
parent's rate. It keeps the parent's licence and tags (so it ships as the parent does); `licence=`, `tags=`, `root=`, `note=` and the other fields of a sample may be given.

| Operation | Does | Settled as |
|---|---|---|
| `trim <start> <end>` | keeps the part (`end` is the end) | `trim <n>f <n>f` |
| `fade in=<t>[@curve] out=<t>[@curve]` | fades the ends; curve `lin`, `exp` or `ease` | `fade in=<n>f out=<n>f` |
| `gain <dB>` | | as given |
| `normalize peak <dBFS>` / `normalize lufs <target>` | the gain that puts the peak, or the integrated loudness (at 44.1 kHz, K-weighted), on the target | `gain <dB>` |
| `silence-trim <dBFS>` | cuts the leading and trailing frames below the threshold (every channel) | `trim <n>f <n>f` |
| `dc` | a one-pole 10 Hz high-pass that removes an offset | |
| `reverse`, `mono`, `left`, `right` | backwards; the channels averaged; one channel of a stereo sample | |
| `pitch <semitones> [method=resample\|stretch]` | `resample` changes the length with the pitch; `stretch` keeps the length (a stretch, then a resample) | `pitch <s> method=<m>` |
| `stretch <ratio>` \| `to=<seconds>` \| `tempo=<from>:<to>` `[method=wsola\|pv]` | time stretch without a change of pitch; the length is exact to the frame | `stretch <ratio> method=<m>` |
| `loop <start> <end> [xfade=<t>]` | the part, with its last `xfade` blended into its first, so that playing round from the end to the loop start is continuous; the result carries `loop=` points | `loop <n>f <n>f xfade=<n>f` |
| `slice <n>` | the n-th slice of the parent (first in the chain) | `trim <n>f <n>f` |
| `mix <sample> [at=<t>] [gain=<dB>]` | adds another sample (at the rate and channels of this one) | `mix hash:<sha256> at=<n>f gain=<dB>` |

WSOLA and the phase vocoder are written in `core` (no GPL or LGPL code), deterministic like the renderer (twiddles from the engine's sine, a fixed order): a tone keeps
its pitch within 5 cents over ratios 0.5 to 2, the length is exact, and WSOLA keeps a click train's attack times within 5 ms.

**`sample slice`** stores slice points (frames, ascending, the first at 0). `at=onsets` measures the onsets (`sensitivity` 0 to 1, default 0.5; `min-gap` seconds,
default 0.05) and writes them as frames; `at=0,0.25,0.5` takes times; `grid=<n>` makes *n* equal slices, or with `tempo=<bpm>`, *n* slices to the beat. A layer plays a slice
with `slice=<n>`, and `op="slice <n>"` makes it a sample of its own. A layer that plays a slice a sample does not have is refused, naming the count.

**`sample loop … find`** looks for loop points (positive-going zero crossings with a matching slope, the best seam by waveform and spectrum), writes the best as
`loop=<start>-<end> loopmode=sustain` in frames and prints the seam numbers (click in dB, level step, spectral jump) of the best three. `near=` and `min=` narrow the search.
By hand, `sample loop <name> <start> <end>` takes seconds or frames. A crossfaded loop is made by `derive`, not `loop`.

**`sample bounce`** renders a sound (one layer with `layer=`) or a song (one channel with `channel=`) through core and stores the result as a sample: `source=bounce`, the
render key and the tape position in `params`. Its licence is that of the worst sample the sound or song plays (`own` when it plays none), and those samples are its
parents, so the licence travels. `loop=yes` is for a sound made a loop with `sound loop`. A song is bounced as it stands at the start of the batch. The audio is not
recomputed on replay; the object is needed (it is named by hash like any other).

**`layer align`** moves layer *n* by `offset=` so that its onset (the first moment its level reaches 10% of its peak) or its peak meets that of layer *m* (or the
sound's start). **`layer match`** sets `gain=` so that layer *n*'s loudness is layer *m*'s plus `db`. **`env … follow=`** writes an amplitude envelope that follows the level of a
layer's render (or a sample, from the layer's own start) with the given attack and release (default 5 ms and 50 ms), at most 256 points, so a synth body tracks a recorded hit.
Each is put on the tape as the `layer set` or `env` it found.

### Hearing samples

`describe`, `measure`, `view` and `compare` take `sample:<name>`, `hash:<sha256 or its first 8 or more digits>` or **the path of an audio file** (a WAV, AIFF, FLAC, or OGG, MP3 or M4A with ffmpeg; a reference outside the project that is read for its numbers, never imported, so nothing of it is kept or licensed) where they take a sound. A path counts as a file when it exists and is no sound, song or set of the project; `generate … like=` takes one too:

```
soundclaw describe <project> sample:<name>|<file> [--json]
soundclaw measure <project> sample:<name>|<file>... [--json]
soundclaw view <project> sample:<name>|<file> wave|spec|pitch|loop|slices [--out <file.png>]
soundclaw view <project> sample:<name> compare <sound|song|sample:<other>|hash:<h>|file>
soundclaw compare <project> <a> <b> [--match-level] [--json]
soundclaw sample check <project> [<name>...]
```

The numbers are the sound's (length, peak, true peak, rms, loudness, centroid, flatness, attack, pitch) with the sample's own: rate, bit depth, channels and stereo width,
noise floor, harmonic-to-noise ratio, pitch with confidence, cents and steadiness, onsets and their rate, a tempo estimate for loops, the time it takes to fall 60 dB (dry or roomy),
silence at each end, runs at full scale and DC. `describe` puts them in words (tonal, noisy or mixed; the pitch and how steady it is; one hit or several; dry or roomy; mono or wide)
and adds the provenance, the licence and the advice. `view … loop` draws the sample's loop points joined (or the whole sample when it has none), `view … slices` its slice points (or its
measured onsets). `compare` works between any two of a sound, a song, a sample, a hash and a file, with the same distance numbers, and `compare` prints them without a picture (`--json` for scripts). **The spectral distance depends on level**: the same sound at two gains is a different distance from the same reference, so `compare` and `view … compare` print it twice, as the sounds are and with the second turned up or down to the first's integrated loudness (`level matched`, which says by how many dB; it does not depend on how loud either is). `--match-level` (MCP `view` `matchLevel`) puts the level-matched number first; the JSON has `spectralMatchedDb`, `averageSpectrumMatchedDb` and `levelMatchDb` beside `spectralDb` and `averageSpectrumDb`. Use the matched one to ask "is it the same sound", the other to ask "is it the same sound at the same level".

**`sample check`** is advice: clipping in the source, DC, more than 20 ms of silence at an end, a noise floor above -60 dBFS, a loop seam with a click, a level step or a spectral
jump, and slice points more than 15 ms from a transient. A sample is material: its checks never gate `work done`; the checks of the sounds and songs made from it do.

### The numbers query

One query language filters and searches by what is measured. `sample list <project> "<query>"` (and the MCP `sample` tool's `list` with `query`) keeps the samples a query fits, closest first:

```
soundclaw sample list demo "creak" dur=0.8-2.5 lufs>-30 centroid<2.5k attack<20ms pitched=no onsets=1 loop=no channels=1 tag=wood source=file licence=shippable
```

Plain words (bare or quoted) match names and tags (`library search` also matches folders). A term is `key<op>value` with `=` (a value, or a range `a-b`; a negative number is a sign, and `lufs=-30--20` is a range), `!=`, `<`, `>`, `<=` or `>=`.
Values take the units the knobs do: `ms`, `s`, `k` (kilo: `2.5k`), `Hz`, `dB`, `LU`, `bpm`, note names for `pitch`, and `yes` or `no`. An unknown key, or a unit the key does not take, is an error that
names the valid ones. A sample whose number is not known does not match a term that needs it. Keys: `dur` (`duration`), `lufs` (`loudness`), `peak`, `rms`, `centroid` (`brightness`), `flatness`,
`attack`, `decay`, `noise`, `harmonicity`, `pitch` (`note`), `pitched`, `onsets`, `onsetrate`, `tempo`, `loop`, `channels`, `samplerate` (`sr`), `bits`, `width`, `silence-start`, `silence-end`,
`clips`, `tag` (repeat for all), `source`, `licence` (`shippable`, `attribution`, `blocked`, `unknown`, or an SPDX id) and `name`.

### Sample libraries

A library is a folder of recordings that lives **outside any project**. You register it once for your user, index it once, and then search it by words and by
the numbers; a project holds only the files it uses, copied in with where they came from and the library's licence.

```
soundclaw library add ~/sounds/cellar licence=CC0-1.0            # register a folder (an id from its name; --name <id> picks one)
soundclaw library index                                          # read, hash and measure every audio file (all libraries, or name them)
soundclaw library search "door creak" dur=0.8-2.5 pitched=no licence=shippable --limit 8
soundclaw library similar demo door_synth dur<3                  # files that sound like a sound of the project (or sample:<name>, or a file)
soundclaw library similar ~/takes/creak.wav                      # files that sound like an audio file (no project needed)
soundclaw library use demo cellar:doors/creak_04.wav as=creak    # copy one file into the project's store
soundclaw library tag cellar doors/creak_04.wav hinge,rusty      # add tags to a file (they survive a re-index)
soundclaw library list [--json]    soundclaw library remove <id> [--yes]
```

**Where things are kept.** The list of libraries and the tags you add are settings in `~/.soundclaw` (or `$SOUNDCLAW_CONFIG_DIR`, or `$XDG_CONFIG_HOME/soundclaw`); the
index is a cache in the system's cache folder (macOS `~/Library/Caches/soundclaw`; Linux `$XDG_CACHE_HOME/soundclaw`, else `~/.cache/soundclaw`; Windows
`%LOCALAPPDATA%\soundclaw\cache`; `$SOUNDCLAW_CACHE_DIR` overrides it) and can be deleted and built again. A cache an earlier version kept in `~/.soundclaw/cache` is moved
there once. Nothing about a library is written into a
project except the files `library use` copies, and no path of your machine is written on the tape: a copied file's origin is `<library>:<path inside it>`.

**The licence of a library.** `add` takes `licence=<id>` (with `attribution="…"` and `terms=<url>`), or reads the folder's own declaration, a
`soundclaw-library.json`:

```
{ "name": "Cellar Foley", "description": "doors, bells and weather", "licence": "CC0-1.0", "attribution": "Recorded by the cellar crew", "terms": "https://example.org/terms" }
```

A `LICENSE` file that says outright `SPDX-License-Identifier: <id>`, CC0, or a Creative Commons title ("Attribution-NonCommercial 4.0") is shown as a reading of its text and needs
`--yes` (or `licence=<id>`); a licence file that says anything else is not guessed and the licence stays `unknown`. A file copied out with `library use` takes the library's
licence, attribution and terms (override with `licence=`), so the ship policy and `licence check` judge it like any sample. SoundClaw records licences; it gives no legal advice.

**The index.** `library index [<id>...] [--rebuild] [--workers <n>]` lists the audio files below the folder (WAV, AIFF, FLAC; OGG, MP3 and M4A when ffmpeg is installed; hidden files and links are
skipped), and for each keeps its path, size and time stamp, the canonical hash, format, rate, channels and bit depth, the numbers of `sample list` (measured over the first 20 s; the length is the
file's), eight energy bands, the root note, loop points, one-shot flag, tempo and text the file's chunks carry, and tags from its folders and file name (split on separators and camelCase,
lower case, plurals folded, numbers dropped). A file that cannot be read keeps an entry with the reason and is never a hit. Files are measured on worker threads (one fewer than the
cores, 1 to 6; `$SOUNDCLAW_INDEX_WORKERS` or `--workers` sets it, 0 is this thread) and only files whose size or time changed are read again. A file over 64 MB is listed but not read.
Plan on about 0.1 CPU-second per short one-shot: 1,000 generated one-shots take about 15 s on 8 free cores.

**Search.** `library search "<words>" [<numbers query>] [--library <id>] [--limit <n>] [--project <project>] [--json]`. Every word has to match a file's name, tags or folders (plurals folded:
`doors` finds `door`); the numbers query (see the numbers query above, with the same keys; `source` is `library`, `loop` is whether the file carries loop points) filters. Hits come
best word match first (a file-name word beats an added tag, which beats a folder word), then those nearest the middle of the query's ranges. Each hit prints `<library>:<path>`, length,
loudness, note, centroid, attack, a licence glyph and word and a line of words (`tonal, one hit, dry, mono`). `--project` judges `licence=shippable` by that project's policy
(the default policy otherwise). `--json` prints one object per hit.

**Sounds like.** `library similar [<project>] <sound | sample:<name> | audio file> [<numbers query>] [--library <id>] [--limit <n>]` ranks the files (those the query keeps) by their distance
from the reference in this feature space, nearest first; the distance is the square root of the sum of weight × ((a − b) / scale)² over:

| Feature | Value | One unit | Weight |
|---|---|---|---|
| duration | log10 of the length in seconds | 0.5 (×3) | 1 |
| loudness | integrated loudness, LUFS | 8 LU | 0.6 |
| centroid | log2 of the spectral centroid in kHz | 1.2 octaves | 1 |
| flatness | 0 tonal … 1 noise | 0.3 | 1 |
| attack | log10 of the attack in ms | 0.8 | 0.8 |
| pitched | 1 when it has a clear pitch | 1 | 0.7 |
| pitch | octaves (MIDI note ÷ 12), when pitched | 1 | 0.5 |
| onset rate | onsets per second | 3 | 0.6 |
| eight bands | energy in 0-100, 100-250, 250-500, 500-1k, 1-2k, 2-4k, 4-8k and above 8k Hz, dB below the total | 12 dB | 0.35 each |

The reference is measured as the others are (mixed to mono at 44.1 kHz). A sound of the project is rendered first. An audio file needs no project: `library similar
<file> [<query>]` (with `--project <project>` to judge `licence=shippable` by that project's policy).

**Remove.** `library remove <id>` forgets the library and its index and never touches the folder. Tags added by hand with `library tag` cannot be rebuilt from the folder,
so when there are any, `remove` says how many files carry them and needs `--yes`.

**Use.** `library use <project> <library>:<path> [as=<name>] [licence=<id>] [attribution="…"] [terms=<url>] [tags=<a,b>] [note="…"]` copies the file into the
project's store (one undo group, a tape command by `--by`, default `agent:claude`) as `source=library` with the origin `<library>:<path>`, the original file's hash and format, the tags from its
path and those you added, and the library's licence. The name defaults to the file's; a name that exists with other audio is refused, and the same audio under another name is kept once.
While a server runs, `library use` is sent to it like the other commands that write. The file must be inside the library's folder: `..`, absolute paths and links that lead out are refused.

**For the dashboard.** `GET /api/library/<id>/audio?path=<path>` (behind the token) plays a library file without copying it: the server decodes it (in a worker) and sends a WAV, confined to the
registered folder, with an ETag from the file's size and time. It answers a `Range: bytes=…` request with that part (206), so a player can seek in a long
file without the server decoding it again.

**MCP.** The `library` tool has `list`, `search`, `similar`, `use`, `add` (`dir`, `name`, `licence`, `attribution`, `terms`, `yes`) and `index` (`ids`, `rebuild`); hits are one compact JSON object per
line (`ref`, `dur`, `lufs`, `note`, `centroid`, `attack`, `licence`, `state`, `desc`, and `distance` for `similar`), or the CLI's lines with `format: "text"`. `index` can take minutes; it runs
beside the other tools rather than holding them up. Removing a library stays a CLI step.

### Generation

`generate` makes audio from a prompt with an AI provider and keeps each take as a sample. Two providers come with SoundClaw: `elevenlabs` (its sound
effects and music endpoints) and `fake`, which makes test audio from a hash of the request, with no network and no key, for tests and demos. The fake provider is free: it never counts against a cap, so it works at a project cap of 0 and over any per-call maximum.

```
soundclaw generate demo sfx "the slow creak of an old wooden door hinge, close, dry, no reverb" duration=2 takes=3 as=creak --estimate
soundclaw generate demo sfx "the slow creak of an old wooden door hinge, close, dry, no reverb" duration=2 takes=3 as=creak want="dur=1.5-2.5 centroid<2.5k attack<40ms"
soundclaw generate demo --again creak_t2 takes=2          # the same prompt and parameters, new takes (new audio)
soundclaw generate --ledger demo                          # what this project spent, by provider and day
soundclaw generate config elevenlabs.plan=creator         # your settings
```

`generate <project> sfx|music "<prompt>" [duration=<s>] [takes=1..4] [loop=yes] [influence=<0-1>] [as=<name>] [want="<numbers query>"]
[like=<sound|sample:name|file>] [provider=elevenlabs|fake] [model=<id>] [tags=<a,b>] [composition=<file.json>] [--estimate] [--json] [--by <author>]`

| Setting | Sound effects | Music |
|---|---|---|
| `duration` | 0.5 to 30 s, default 2 | 10 to 300 s, default 30 |
| `loop=yes` | a seamless loop | (not taken) |
| `influence` | 0 to 1: how closely the audio follows the prompt | (not taken) |
| `model` | `eleven_text_to_sound_v2` | `music_v1` |
| `composition` | (not taken) | a composition plan (a JSON file, the provider's format) instead of the prompt |

**Takes are samples.** Each take is one call and is stored as `<as>_t1`, `<as>_t2`, … (numbered after the takes of that name already there; `as` defaults to
the first words of the prompt) with `source=generated`, the provider, endpoint, model, prompt, parameters, `take=<n>/<m>`, the provider's request id and the
credits it cost, the hash and format of the bytes the provider sent, and the licence the provider's plan gives: `generated:elevenlabs:<plan>` (the default
policy ships it from a paid plan and blocks `generated:*:free`), with the provider's terms address; the fake provider's takes are `own`. All the takes of a
command are one undo group. Output is 16-bit PCM at 44.1 kHz on a plan that allows it (pro and above), otherwise MP3, decoded when it arrives through
ffmpeg (the MP3's hash stays in the provenance). Generation is acquisition: replay, undo and rendering never call a provider. `--again <sample>` is a new
call with the recorded prompt and parameters (from the ledger, else the provenance): new takes, not the same audio; it takes `takes=` and `as=`.

**Each take comes back with its numbers** (length, loudness, peak, centroid, attack, pitch, credits, request id) and its words, as `describe` gives them.
`want="<numbers query>"` ranks the takes: those that fit first, then the closest. `like=<sound | sample:name | the path of an audio file>` (a reference outside the project, a WAV, or an OGG with ffmpeg) ranks them by the sounds-like distance of
`library similar` **with the level matched**: a take's loudness says nothing about whether it is the sound you asked for, so it is left out of the ranking (each take's line gives the distance both ways, `distance 4.03 … (level matched; 4.44 with the level)`; `--json` has `distance` and `distanceWithLevel`). `want=` ranks on the numbers you name, so it depends on level only when you name `lufs`, `peak` or `rms`. Listen before you build on one, and remove the takes you do not keep (`sample remove`; the audio stays until `sample gc`).

**Costs are capped before the call.** A command is worked out first: the provider, the names, and an estimate per take (credits per second: sound
effects 10, music 27.4, measured from the provider's cost header; `elevenlabs.rate.sfx` and `.rate.music` change them). Any of these refuses the whole
command before the first call, and says which:

| Cap | Default | Where |
|---|---|---|
| one call (one take) | 300 credits (30 s of sound effects) | `soundclaw generate config max-per-call=<credits>` |
| the project | **0: paid generation is off until a person sets a cap** | `soundclaw generate cap <project> <credits>` (or the page); it is `project.json`: `"generation": {"capCredits": <credits>}` |
| a day, across projects (UTC) | 3,000 credits | `soundclaw generate config daily-cap=<credits>` |

A paid provider is also refused when `CI` is set or `SOUNDCLAW_NO_PAID=1`, until your plan is set (`generate config elevenlabs.plan=<plan>`: it decides the
licence on the takes), and for music until `generate config elevenlabs.music=on` (music costs about 27 credits a second, so the endpoint is held until
you turn it on). **A cap is set by a person**: `generate cap` on the command line, or the page's control (`POST /api/generation/cap`, which takes only a `human:<name>` author). No MCP tool and no command of the command language sets one, so an agent cannot raise its own cap; it asks. The caps guard against a runaway loop; they are not a security boundary against someone who edits `project.json`. `--estimate` prints the cost, the budget left and what would
refuse the command, and calls nothing. After each call the charge is logged: the provider's `character-cost` header, else the change in the account's
counter read before and after, else the estimate (and the ledger says which).

**The key comes from the environment only.** The ElevenLabs key is read from `ELEVENLABS_API_KEY` in the environment of the process that makes the call:
the command's own, or, while a server owns the project, the server's (the CLI sends `generate` to it, like the commands that write). It is never written
to a file, a log, a ledger, an error message or a page; text a provider sends back has any key taken out. A missing key is an error naming the variable.
Calls go over https (plain http only to this machine, for a local stand-in: `elevenlabs.url=`). They are the only calls SoundClaw makes, and only on an
explicit command.

**Ledgers.** Every command that called is a line in the project's `generation.jsonl` (tracked in git; no key, no path of your machine): time, author,
provider, endpoint, model, kind, prompt, parameters, the estimate, the charge and where it came from, each take's name, hash, credits and request id, and
the outcome (`ok`, `partial` when a take failed after others were made, `failed`). The same charge goes into your `spend.jsonl` across projects (beside
the settings), which the daily cap reads. `generate --ledger [<project>] [--json]` totals them by provider, project and day.

**Settings** (`generate config`, kept in `generation.json` beside the library settings; `<key>=none` clears one): `provider` (the default provider),
`daily-cap`, `max-per-call`, `elevenlabs.plan`, `elevenlabs.music` (`on`/`off`), `elevenlabs.format` (`pcm_44100`, `mp3_44100_128`, …),
`elevenlabs.rate.sfx`, `elevenlabs.rate.music`, `elevenlabs.url` (the fake provider has none of these: it is free).

**MCP and the page.** The MCP `generate` tool takes the same settings (`kind`, `prompt`, `duration`, `takes`, `loop`, `influence`, `model`, `as`, `want`,
`like`, `provider`, `tags`, `composition`, `again`, `estimate`, `by`; `action: "ledger"` and `"config"` print the ledger and the settings).
`POST /api/generate` (behind the token) takes `{ "kind", "prompt", "pairs": { "duration": …, … }, "again", "estimate", "by" }` and answers `{ "text", "json" }`.

### Licences

Each sample has a licence: an SPDX id (`CC0-1.0`, `CC-BY-4.0`), or `own`, `generated:<provider>:<plan>`, `proprietary:<note>` or `unknown`
(the default). The tool never guesses one: it takes the licence it is given and no other, and it records licences; it gives no legal advice.
A sound, instrument or song carries the licences of every sample it reaches (layers, instruments its channels play, and the parents of
derived samples), and its state is the worst of them:

| State | Meaning |
|---|---|
| `shippable` | may ship (also a sound that plays no sample) |
| `attribution` | may ship with credit: `CC-BY-*` and any licence with attribution text |
| `unknown` | the licence has not been set |
| `blocked` | the project's policy does not let it ship |

The default policy ships `own`, `CC0-1.0`, `CC-BY-*` (with `ATTRIBUTION.txt`) and `generated:*:*` (generated audio from a paid plan), and blocks
`unknown`, any `-NC` or `-ND` licence, `generated:*:free` and `proprietary:*`. A project changes it in `project.json`:

```
"licences": { "allow": ["own", "CC0-1.0", "CC-BY-*"], "block": ["unknown", "*-NC*"] }
```

(patterns where `*` matches anything; `block` is looked at first; a list left out keeps its default; `unknown` is never shippable). Non-commercial and
no-derivatives licences (`CC-BY-NC-4.0`, `CC-BY-ND-4.0`, `CC-BY-NC-SA-4.0`) stay blocked unless the `allow` list names an NC or ND pattern itself (`"CC-BY-NC-4.0"`, `"CC-BY-NC-*"`):
a broad pattern such as `CC-BY-*` or `*` never admits them, and an explicit `allow` of one overrides only the default `*-NC*` and `*-ND*` blocks, not a block that names it. While you work
a licence only warns; the gate is on export. `soundclaw licence check <project> [<id>...]` reports each item (default every sound, instrument and
song) with the samples behind its verdict. A manifest export (`--all`, `--set`, `--pack`) refuses an item whose state is `unknown` or `blocked`
unless `--allow-licence <id>` names that licence (written into the manifest as `allowedLicences`); it lists the samples used (name, hash, licence,
attribution, terms, source) in `manifest.json`, with each sound's `licences` and `licence`, and writes `ATTRIBUTION.txt` when a licence asks
for attribution. A single-file export warns and goes ahead.

### Looking after the store

`soundclaw sample gc <project>` lists the objects no line of the tape names (a dry run); `--apply` deletes them. Undo and redo are commands, so
an object named by an undone group is kept. `--drop-history` also drops objects only undone or replaced states used, and lists first the tape
lines (the versions) that will then no longer render with their audio; the parents of a derived sample that is still in use stay.
`soundclaw sample git-lfs` prints the `.gitattributes` lines for Git LFS; plain git works and stores each object once, because objects never change.
Libraries of recordings stay outside projects: only what a project uses is copied in.

### Projects from 0.1

A project whose samples are `samples/<name>.wav` files with nothing on the tape opens and renders exactly as before: the files read as
samples that are not on the tape yet (`sample list` marks them), with the licence `unknown`. `soundclaw upgrade <project>` moves them into the
store and writes one `sample add` group by `system:upgrade`; every render stays the same sample for sample. A name already on the tape is left
alone and reported. After an upgrade an undo that would take a sample away from a sound that plays it is refused.

## The project folder

```
demo.sclaw/
  project.json     format and name
  sounds/          <id>.sfx per sound: the current state, written from the history
  instruments/ songs/ sets/    homes for the documents later versions add
  samples/         objects/<xx>/<hash>.wav: the audio, once per content; <name>.sample: each name, written from the history
  history.jsonl    the command tape: every change, its author and undo group; the source of truth
  generation.jsonl what each generation command asked a provider for and what it cost (no key)
  requests.jsonl   what people asked for, and how the agent answered; append-only
  exports/         WAV files (ignored by git)
  .cache/          the render cache (ignored by git)
```

The history is the source of truth; `sounds/*.sfx` are rewritten from it after every change, so
they are for reading and diffing. A hand edit to a `.sfx` file is overwritten by the next change.

## Commands

```
soundclaw init [<project>, default sounds] [--scope local|project|user] [--name soundclaw] [--no-skill] [--force]
soundclaw new <project> [--name <name>]
soundclaw run <project> (<script> | - | -e "<commands>") [--by <author>]
soundclaw list <project>
soundclaw history <project> [--sound <id>] [--by <author>] [--limit <n, default 50>]
soundclaw changes <project> [--since <command number | time>] [--by human|agent|<author>] [--as <agent>] [--peek]
soundclaw render <project> <id>
soundclaw view <project> <id> wave|spec|pitch [--out <file.png>]
soundclaw view <project> <id> layers [--out <file.png>]
soundclaw view <project> <id> compare <other> [--match-level] [--out <file.png>]
soundclaw view <project> <instrument> keymap [--out <file.png>]
soundclaw view <project> <song> notes|mix|wave|spec|loop [--from <s>] [--to <s>] [--channels a,b] [--out <file.png>]
soundclaw view <project> <song> notes|mix|wave|spec|loop [--from <s>] [--to <s>] [--channels a,b] [--out <file.png>]
soundclaw describe <project> <id>
soundclaw check <project> [<id>...]          (sounds, sets, songs and sampled instruments)
soundclaw import <project> sfxr <file.csv | patch-file | "patch text"> [--id <id>] [--by <author>]
soundclaw sample import <project> <file | folder> [as=<name>] [licence=<id>] [attribution="<text>"] [terms=<url>] [tags=a,b] [source=<kind>] [origin="<where from>"] [note="<text>"] [--force]
soundclaw sample list <project>
soundclaw sample show <project> <name>
soundclaw sample add|set <project> <name> <field>=<value>...
soundclaw sample rename <project> <name> <new>
soundclaw sample remove <project> <name>
soundclaw sample gc <project> [--apply] [--drop-history]
soundclaw sample git-lfs
soundclaw upgrade <project>
soundclaw generate <project> sfx|music "<prompt>" [duration=<s>] [takes=<n>] [as=<name>] [want="<query>"] [like=<ref|file>] [provider=<id>] [--estimate] [--json]
soundclaw generate <project> --again <sample> [takes=<n>] [as=<name>]
soundclaw generate --ledger [<project>]    soundclaw generate config [<key>=<value>...]
soundclaw generate cap <project> <credits>
soundclaw instrument import <project> <file.sfz|file.sf2> [--id <id>] [preset=<bank>:<program>|<name>] [--list] [licence=<id>] [attribution="<text>"] [terms=<url>] [tags=a,b] [prefix=<text>]
soundclaw instrument export <project> <id> [--format sfz] [--to <dir>]
soundclaw instrument zones <project> <id>
soundclaw licence check <project> [<id>...] [--allow-licence <id>]...
soundclaw export <project> [<id>...] [--format wav|patch|csv] [--out <dir>]
soundclaw export <project> <song>... [--format wav|ogg|midi] [--loop] [--stems [--stems-through-master]] [--loops <n>] [--pattern <name>] [--to <dir>] [--quality <q>]
soundclaw midi import <project> <file.mid> [--id <song>]
soundclaw midi export <project> <song> [--pattern <name>] [--to <dir>]
soundclaw export <project> <song>... [--format wav|ogg|midi] [--loop] [--stems [--stems-through-master]] [--loops <n>] [--pattern <name>] [--to <dir>] [--quality <q>]
soundclaw midi import <project> <file.mid> [--id <song>]
soundclaw midi export <project> <song> [--pattern <name>] [--to <dir>]
soundclaw request <project> [<id> --note "<what should change>"] [--tag <tag>]... [--like <sound>] [--target "<where>"] [--again <request>] [--by <author>]
soundclaw reply <project> <request> "<answer>" [--by <author>]
soundclaw cancel <project> <request> ["<why>"] [--by <author>]
soundclaw work <project> list | claim [<request>] | progress [<request>] "<note>" | block [<request>] "<question>" | done [<request>] "<what changed>" [--by <agent>]
soundclaw scale <key> | list | <project> <song>
soundclaw style <project> [--init]
soundclaw skill install [--dest <dir> | --project <dir>]
soundclaw await <project-folder | watch-url> [--timeout <seconds>] [--since <cursor>] [--as <name>] [--json]
soundclaw serve --project <project> [--port 7427] [--no-mcp]
```

`soundclaw init` sets up Claude Code in the current folder in one step. It makes the project (or
uses the one already there), installs the skill, and registers the MCP server as
`npx -y soundclaw@<this version> serve --project <project>` with `claude mcp add`. The scope is
Claude Code's: `local` (the default: you, in this folder), `project` (a shared `.mcp.json` with a
relative path, and the skill in `.claude/skills`, both for the repo) or `user` (you, in every
folder). When the `claude` command is not on the PATH it writes `.mcp.json` instead, which Claude
Code asks you to approve. An entry with the same name is left alone unless `--force`; after an
upgrade, `soundclaw init --force` moves the entry to the new version.

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
| `layers` | for a layered sound: each sounding layer's waveform and spectrogram, stacked on one time axis (the layer as it enters the sum: filter, envelope, effects, gain and pan applied), its start offset marked, with its label, gain and pan |
| `loop` | for a looping sound: the last 50 ms joined to the first (the seam marked), the two drawn over each other, the joined spectrogram, and the level across four repeats |
| `set` | (`view <project> <set> set`) a set's members side by side on one time scale: waveform, spectrogram and a loudness bar each (the target marked), then the pairwise distance matrix in dB with the pairs outside the limits outlined |
| `keymap` | (`view <project> <instrument> keymap`) a sampled instrument: keys across, velocity up, each zone a box labelled with its sample, root, measured pitch error and level and coloured by its checks; round robins stacked, release zones dashed, a kit's hits listed |
| `compare` | two spectrograms stacked and, under them, their difference (red: the second is louder; blue: the first), plus distance numbers: spectral distance (dB), loudness, duration, brightness, pitch start and end (semitones), envelope correlation. Either side may be a sound, a song (its full mix) or the path of a WAV or OGG file outside the project, a reference to hold the work against: `view <project> theme.wav compare ~/refs/target.ogg`. A WAV is read at any rate and bit depth (resampled to 44,100 Hz, mixed to mono); OGG and other formats are decoded by `ffmpeg` when it is installed (else the error says to convert to WAV). The numbers are the same as for two sounds. Audio is limited to 120 s |

The `compare` header says `A = <first>, B = <second>` (the order of the arguments); the differences are B compared with A: positive means B is more.

`describe` is a plain-words summary built only from the measured numbers (never from the sound's
settings), then the numbers. `check` runs the checks with scores, thresholds and the exact ranges;
it exits 1 when any sound fails. `check` also takes a set's name and runs `set-spread` on it (with no names it checks every sound and every set).
It says which loudness class held each sound, and when two failing checks pull against each other, the rule that binds.

**Numbers for scripts, and many sounds in one process.** Starting a process costs about half a second, so a script that measures 100 sounds one at a time
spends a minute starting. `measure <project> [<id|set>...] [--json]` measures many sounds in one process (all of them when none is named): per sound its
class and target, every number `describe` prints and every check's result. `--json` prints one document:

```
{ "format": "soundclaw-measure", "version": 1, "pass": false,
  "sounds": [ { "id": "tick", "voice": "layered", "status": "draft",
                "class": { "name": "ui", "target": -28, "tolerance": 3, "basis": "class ui" },
                "pass": true, "description": "…",
                "numbers": { "duration", "samples", "channels", "silent", "peak", "peakDb", "truePeakDb", "rmsDb", "crestDb", "dc", "lufs",
                             "attack", "tail", "leadingSilence", "trailingSilence", "endLevelDb",
                             "centroid": { "mean", "start", "mid", "end" }, "flatness",
                             "pitch": { "start", "end", "min", "max", "rangeSemitones", "voiced" }, "onsets", "onsetTimes" },
                "checks": [ { "name", "pass", "score", "value", "threshold", "ranges": [ { "from", "to", "note" } ] } ],
                "binding": [ "…" ] } ],
  "sets": [ { "id", "pass", "members", "loudness", "distances", "check" } ] }
```

A number that is not finite (a silent sound has no loudness) is `null`. Numbers are rounded to four decimals. `measure` and `check` exit 1 when any check fails.
`--json` is also on `check` (the same document), `describe` (one sound's object) and `render` (the same, with `renderKey` and `samplesHash`). The MCP `measure` tool does the same.

**`normalize <project> <id|set>... [<class> | target=<LUFS>]`** writes the gain commands that bring sounds (or a set's members) to a loudness, as one undo group, and prints them: each
sound's own class target with no argument; a class name (the sounds join that class: `sound set <id> class=<name>`); or `target=<LUFS>` (they are given `loudness=<LUFS>` and held to it).
The gain is a layered sound's `gain`, then the `gain` of the limiter that ends its master chain (dB, added before limiting: the sound is first brought to gain 4, and the rest goes in front of the limiter, up to +48 dB, which `normalize` adds with `ceiling=-1` when the chain has none at its end; when the sound is louder than the target the limiter's gain is taken back first); a target out of reach even then lists the sound as `not normalized` with the loudness it reaches, and leaves it as it was while the other sounds are normalized (an error, with nothing written, only when none could be); ending inside the class tolerance counts as done, with a warning. A classic sound's gain is its `volume`, which stops at 1 or where the sound would clip (no sample at full scale, exported true peak within `truePeakMax`), whichever is lower: a classic sound that cannot get loud enough that way is a warning that says by how many LU. Loudness matching sees a classic sound as `measure` does, at the exported scale (below).

### What others changed

`changes <project>` (MCP `changes`) tells an agent what other hands did since it last looked. Every
history group after the agent's **cursor** is listed with its author, its commands, and for each
sound it changed: the parameters before and after (`freq 0.437 → 0.7`), the numbers before and
after (duration, loudness, spectral centroid, pitch) and a before/after compare view saved as a PNG
under `<project>/.cache/views/change-<group>-<sound>.png` (the same picture as `view … compare`).

```
$ soundclaw changes demo.sclaw --by human
1 change by people since #2 (your cursor is now #3):

g2 #3 human:ana 2026-11-06T10:00:01Z
  sound set beep freq=0.7
  beep (edited):
    freq 0.437 → 0.7
    numbers: duration 0.192 → 0.192 s; loudness -9.6 → -7.9 LUFS; centroid 4686 → 6402 Hz; pitch 679 → 1742 Hz
    compare view (before above, after below): demo.sclaw/.cache/views/change-g2-beep.png
```

- The cursor is per agent (`--as`, default `agent:claude`), kept in `<project>/.cache/changes-seen.json`
  (ignored by git) as the highest command number read. Reading moves it; `--peek` and `--since` do not.
  `--since` takes a command number or a time.
- Without `--by` the list is everyone but the asking agent; `--by human` people only, `--by agent`
  agents, `--by human:ana` one author.
- The newest 12 changes are detailed; older ones are counted.
- A group a later undo took out of effect is marked. An `undo` by a person is a change too.
- For a **song** a group changed: the settings, channels and sections that differ (`− tempo 120`, `+ tempo 126`),
  per pattern the notes that went and came (`verse.lead: − E5 at 3; + G5 at 5 (2 steps)`), and a before/after
  view of the written notes of each changed pattern (`change-<group>-<song>-<pattern>.png`: red went, green came).
  For an **instrument**: the lines of its file that differ.

```
g7 #31-#32 human:ana 2026-11-07T09:12:40Z
  pattern note move tune.verse lead 3 step=5 note=G5
  pattern note add tune.verse drums 1 h
  song tune (edited):
    verse.lead: − E5 at 3; + G5 at 5
    verse.drums: + h at 1
    notes before/after (red went, green came): demo.sclaw/.cache/views/change-g7-tune-verse.png
```

- Call it before editing a sound or song a person has touched, and never undo a person's edit silently: say
  so (a reply, a question) before changing it back.

### Import and export

`import <project> sfxr <source>` makes classic sounds: from a `synth.csv` (one sound per row; the key
column is the id: a column named `id`, `key`, `sound` or `name`, else the first; the other columns
are parameter names in any order plus an optional `seed`; a missing column, an empty cell or `NA`
takes the default), from a single-patch file (the file name gives the id, or `--id`), or from the
patch text itself. One undo group. The output starts with the warnings, then one summary line (how many sounds, how many exact and how many approximated); the
per-row report is printed for the rows that lost something, or for every row when there are 8 or fewer sounds. `--quiet` leaves out the rows. `--classic` marks every imported
sound classic (`sound classic <id> on`), so it stays one classic voice and exports as a `synth.csv` row. A sound id that appears twice in a csv is read as the engine
reads it: the id keeps the position of its first row and the values of its last, and a warning names
both lines (`warning: synth.csv: 'zip' is on line 2 and again on line 4; …`).

`import <project> jsfxr <string | file>` reads jsfxr's patches: the **base58** form (what follows the `#` in an `https://sfxr.me/#…` address, or the whole
address): one byte of wave type and 22 little-endian float32 parameters, written in base58 (the alphabet without `0 O I l`; a leading `1` is a zero byte); or its **JSON**
form (`{"wave_type":1,"p_env_sustain":0.25,…,"sound_vol":0.25}`). `import <project> bfxr <string | file>` reads Bfxr's settings string (32 comma-separated numbers in
Bfxr's parameter order; an empty field is 0). Several strings go in one file, one per line, `<id> <string>` (a single string takes `--id`, or the file's name).
`sfxr` (the default kind) also recognises a jsfxr string. Nothing is imported unless every row can be read. **Each row is reported**:

```
row 1 zap: exact (jsfxr base58)
row 2 buzz: approximated (bfxr)
    lost or changed: compressionAmount 0.3 not reproduced: compression (the classic voice has none: …)
    lost or changed: wave triangle has no classic equivalent: sine is the nearest
```

- **Parameters carry over by name**, one for one, with no scaling: jsfxr's `p_env_attack` … `p_hpf_ramp` are the classic `attack` … `highPassSweep`; Bfxr's `attackTime`,
  `startFrequency`, `squareDuty`, `flangerOffset`, `lpFilterCutoff` … likewise. jsfxr's base58 holds float32; each value is written as the shortest decimal that reads back as the
  same float32 (so a `0.3` stays `0.3`, and a value jsfxr's own encoder truncated stays what the string says). Such a sound is **exact**: it is the `sound patch` of those
  values, sample for sample. (Rendering is the engine's synth; the noise stream differs from jsfxr's and Bfxr's own, which use the platform's random numbers.)
- **Volume.** jsfxr multiplies its output by `exp(sound_vol) - 1` and the classic voice by `volume`, so `volume = exp(sound_vol) - 1` has the same amplitude (a base58 string has no
  `sound_vol`: jsfxr plays it at 0.5, so `volume` is 0.648721; above 1 it is clamped and the row says so). Bfxr multiplies by `masterVolume²`, so `volume = masterVolume²`.
- **Approximated, with the loss named**: Bfxr's compression (default 0.3 in its own presets, so most Bfxr strings are approximated), harmonics (`overtones`, `overtoneFalloff`), bit crush
  and sweep, the second pitch jump, the pitch jump repeat, and its extra waves (triangle, pink noise, tan, whistle, breaker, bit noise → the nearest classic wave); JSON's
  `sample_rate` and `sample_size` (exports are 44,100 Hz, 16-bit); values outside a classic range (clamped). A row with something in that list is *approximated*; otherwise *exact*.

`export --format`: `wav` (default; 16-bit PCM, 44,100 Hz, mono; a classic sound is written in the
engine's pre-rendered form, each sample `trunc(s × 32000)`), `patch` (`<id>.sfxr`, the single-patch
text: a version line, then the 25 values at six significant digits; a sound with a seed is written
as `name=value` pairs so the seed travels), `csv` (one `synth.csv`, every column at full precision,
so reading it back renders the same samples), `ogg` (Vorbis, variable bitrate, `--quality -0.1 … 1`, default 0.4; libvorbis compiled to JavaScript, the `libvorbis.js` package, MIT with
Xiph.org's BSD licences; one or two channels; the stream ends with the exact number of samples; the same sound gives the same bytes, as every file gets the same stream serial number).

`export <project> --all [--format wav|ogg] [--to <dir>]` (or `--set <set>` for a set's members, or `--pack`) also writes **`manifest.json`** beside the files:

```
{ "format": "soundclaw-manifest", "version": 1, "project": "demo",
  "sounds": [ { "id": "rain", "file": "rain.ogg", "format": "ogg", "duration": 5.159, "samples": 227511, "sampleRate": 44100, "channels": 1,
                "loudness": -16.2, "truePeak": -6, "loop": { "start": 0, "end": 227511, "startSeconds": 0, "endSeconds": 5.159 },
                "set": null, "status": "draft", "synth": false }, … ],
  "sets": [ { "id": "footsteps", "members": [ … ], "target": -20 } ] }
```

`loudness` and `truePeak` are of the render, before the export limiter; `loop` is null for a sound that is not a loop. **The pack layout** (`--pack`) is one flat folder in which
the sounds marked classic (`sound classic <id> on`) are rows of a single `synth.csv` instead of audio files (their manifest entries have `"file": null, "synth": true`), and
everything else is audio, ready to drop into a pack. Without `--all`, `--set` or `--pack` (and for WAV) no manifest is written, as before.

A layered sound exports as audio only, **WAV** (16-bit, 44,100 Hz, mono or stereo, through the limiter above) **or OGG**; `export` says so for each one
and how much the limiter reduced it, `--format csv` and `patch` refuse a layered sound that is named and skip it when everything is
exported (a `synth.csv` row cannot hold layers). A classic sound marked classic, or never layered, keeps exporting as a row.
Samples are brought in with `sample import` (see [Samples](#samples)). A manifest export (`--all`, `--set`, `--pack`) lists the samples its sounds use and writes
`ATTRIBUTION.txt` when a licence asks for it; it refuses a sound that reaches an unknown or blocked licence unless `--allow-licence <id>` lets that licence through
(the ids let through are written into `manifest.json`); a single-file export warns instead.

Exit codes: 0 done, 1 refused (an error in the commands or the project; nothing was applied), 2
usage error, 3 (`await` only) the timeout passed with nothing to report.

### While a server runs

`soundclaw serve` owns its project. Commands that write (`run`, `export`, `import`, `sample import`, `request`, `reply`,
`cancel`, `work`) are sent to it over HTTP, found through the project's lock file and a token file
only you can read, so they go through its single writer and a connected dashboard updates live.
If a server holds the folder and its token cannot be read, a writing command refuses rather than
write behind its back. Read-only commands (`list`, `history`, `render`, `view`, `describe`, `check`) read the files.

### The dashboard's pages

`soundclaw serve` prints the watch address; the page has five views, all written to by commands as `human:<name>` (what a person does is on the history):

| Address | Page |
|---|---|
| `#/` | the cards (play, waveform, spectrogram, checks, Approve, Ask for changes, Feedback, Edit) and, above them, a tile for each set |
| `#/sound/<id>` | the editor (classic sliders, or layers, envelopes and effects; a **grain** layer has a card and a map of its sample with the band the grains are taken from and the words for how many sound at once, a **convolve** card draws the response it uses and its panel picks the response from the project's samples), with the **Loop** panel: a loop box (`sound loop <id> 4 …` / `off`), the length and the crossfade (each a `sound loop` command), **Play looped** (repeats until stopped) and the numbers of the seam |
| `#/set/<set>` | a set: a header with its loudness class and the loudness spread of its members (warned when wider than twice the class tolerance); the set loudness meter (the class band and one mark per member, shaped and coloured by how it stands); the clip grid: a row per member, a column per version (its last four distinct renders from the history, v1 oldest, the current one marked; the agent's latest change that nobody approved since in a dashed violet **agent** column). A click plays a cell, **Enter** makes it current (one batch of ordinary commands, written as you; on the agent's column it approves it), **1**–**9** play a row, **⇧1**–**⇧9** a column, ⇧-click picks a second cell. The blind A/B card beside it (below, when the window is narrow) compares two versions: drag two cells onto it, pick two and press **C**, or **Compare with current**; their loudness is matched (the gain shown on each side; a pair that is the same once matched is skipped and the card says so), A and B are assigned at random and the names hidden until you answer. It shows the moment (or a field that writes `set moment`) and asks *Which one fits better in this moment?*; **Play** plays a side four times at the interval the moment names ("every 0.4 s"), else once; **Tab** switches the side heard in time; **A**, **B**, **=** and **N** answer, writing a `comparison` request; then the names are shown, the session tally grows and the next pair loads after 2 s (**→** now). Also **Play in sequence** (with a gap, in ms), **Regen with a new seed** (`set regen <set> seed=<n>`, the seed chosen by the page), the spread rules, the distance matrix (pairs outside the limits outlined) and the set-spread verdict |
| `#/song/<id>` | the music editor (an audio channel has a lane of **clips**: a block for each recording, sized by it and drawn from it, with a badge for the tempo fit and the pitch; a click selects it and opens its settings, a drag or the arrow keys move it along the beats, a sample dragged from the Samples tab onto the lane places one, *+ audio* adds an audio channel; each is one `song clip …` command; the mixer has a strip for the channel and one for the convolution bus): the song order (sections as blocks to drag into a new order, repeats, intro and ending, the loop region as a band on a bar ruler with handles to drag), tempo, swing, key and time, the channels (instrument, gain, pan, mute and solo for listening, game layer) with each instrument's editor (note envelope, velocity, root, range, pitch check, and its voice with the sound editor's controls; a built-in is copied into the project first), the pattern grid (every channel; a drum channel as a row per hit to click or paint), the piano roll of a melodic channel (the key's notes shaded, notes outside it marked; click to add, drag to move, drag the end to lengthen, shift-drag to select, Delete, a velocity lane, slide/vibrato/arp from the menu), the helpers (the rows a helper would write shown before **Apply** runs the same command), and playback: **Play**, **from cursor** (a click on the ruler or a step), **selection** (the notes picked, or the pattern, repeating) and **Loop**, with the cursor lit across the grid, the roll and the ruler. Every edit is the command an agent would write (`pattern note …`, `song …`, `instrument …`), one gesture one history entry; after an edit only the changed channel renders again, and a playing song plays on from where it was |
| `#/instrument/<id>` | a sampled instrument: the **key-map** (keys across, velocity up; every zone a labelled box that wears its check as a glyph and a word, round robins stacked, release zones dashed), edge handles that write one `instrument zone set` when let go (or the arrow keys on a focused edge, Enter writes), a sample dragged from the Samples tab onto a key (`instrument zone add` at its own or measured root), the zone table and a zone's fields, the check's findings, and playing: the piano strip, the computer keyboard (A W S E D F T G Y H U J K O L P ;, Z and X shift the octave) and a MIDI keyboard when the browser offers Web MIDI |
| `#/session` | the agent's session: *Working on now* (the claimed request, its latest progress, the agent's commands since the claim, a running batch as cells that fill), your requests in lanes (Sent, Seen, Claimed, Working, Blocked with a reply field, Ready for review, Closed) and the history tape: a timeline of every command, agent marks round and violet, yours square and teal, a batch a labelled span; it pans and zooms, hovering lists a group's commands, a click plays the focused item as it was after that group (nothing is written), *Undo batch* is the existing undo |
| `#/review/<request or group>` | what an agent did: before (A) and after (B) waveforms aligned on the onset with the checks' markers, the parameters old → new, the agent's note, the numbers before → after with check glyphs, level-matched A/B (Tab switches in time), and for a song the notes per pattern and A/B of the loop; *Approve* (⌘↵), *Ask again…*, *Revert*; each offers Undo for ten seconds |
| `#/audition`, `#/audition/<set>` | the batch audition page: every sound (or a set's members) as a row of the clip grid with one column, the sound as it is now, with Play, the check badge, Approve, Ask and Feedback; **Play all** with a gap; filters by set, status, checks and feedback tag; the keyboard: ↑ ↓ (and ← →) move the selection, **space** plays it, **a** approves it (`sound mark … approved`), **r** opens the note for Ask for changes (shortcuts are off while you type). Two sounds picked (click one, ⇧-click another, then **C**, or drag them) go on the blind A/B card as on a set's page; while a pair waits for an answer, **a**, **b**, **=** and **n** answer it, and the moment field writes `sound set <id> moment="…"` |

Approvals, asks and feedback from the audition page are the same requests as on the cards: they reach a waiting agent through `await`. So are blind A/B answers, as `comparison` requests (see "Comparisons").

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

**Feedback tags.** A card's *Feedback* button opens quick tags (too loud, too quiet, too long, too
short, too harsh, too dull, too similar to another sound, good) and a text box. Sending makes one
request carrying the tags (and, for *too similar*, the other sound), which reaches the agent through
`await` as `request r3 (beep) from human:ana [too loud, too harsh]: "a bit softer"` and is shown on
the card. Like *Ask for changes* it marks the sound rejected; the tag `good` on its own is
praise: a `feedback` request that marks nothing and that the agent just closes. The CLI files the
same with `request <project> <id> --tag "too loud" [--note …] [--like <sound>]`.

**Targets.** A change request may point inside its item, as a selection in the dashboard does (R, or
right-click › *Ask for changes*, on a waveform region, bars of a song, a knob, a layer or device, or an item).
The record carries `target`: `{kind:"range", start, end}` (seconds of a sound), `{kind:"bars", from, to, channel?}`
(bars of a song, from 1, and the selected channel), `{kind:"param", param, layer?, fx?}` (a control; `layer` and
`fx` count from 1, `fx` with no layer is the master chain), `{kind:"layer", layer}` or `{kind:"item"}`. A request
names a song in `sound` as it names a sound; a range needs a sound, bars need a song, a layer needs a layered
sound with that many layers, and a bars channel must be one of the song's. `await`, `request` listings, the MCP
text and the brief print it in words: `— pinned to 0.31–0.38 s`, `— bars 9–12 of lead`, `— parameter decay`,
`— layer 2`, `— the item as a whole`. The CLI takes it as `--target "range 0.31-0.38"`, `"bars 9-12 lead"`,
`"param decay layer 2 fx 1"`, `"layer 2"` or `"item"`; the MCP `request` tool takes the object or that text.
The composer also attaches, inside the note, `[attached: <the failing check inside the selection>; moment: "…"]`
(each removable before sending).

**A request about a sample.** The item of a request may be a sample: `sound` is `sample:<name>` (`request <project> sample:door_hits --note "shorter and drier"`,
the MCP `request` tool with `sound: "sample:door_hits"`, or the sample page's *Ask for changes*, which can pin it to the selected stretch with `--target "range 0.1-0.4"`).
A sample is material, so there is no `sound mark` and no check holds `done` (only that the sample still exists); `work` claim prints the sample's numbers and words,
where it came from, what plays it, and the commands that change a sample (`sample derive`, `sample set`, `sample loop`, `sample slice`, or other audio from `library` or `generate`).
It has no review page: the sample's own page shows the request, what the agent said and what it did, and *Approve* or *Ask again*. A request on a sound that plays the sample
works as before. Quick tags and `--like` are for sounds and songs.

**Review and asking again.** A person looks at what an agent did for a done request in the dashboard
(`#/review/<request>` or `#/review/<group>`, from the session page's *Ready for review* lane, the feed, or the
"agent update waiting" chip) and approves it, reverts it, or asks again. *Ask again* files a new change request with
`again: "<request>"` (`request … --again r3`); `await` prints `(asks again about r3)` and the brief says what that means.
Approving or reverting a done request also writes a `reviewed` record (`approved` or `reverted`; `undone` takes the
decision back within the ten-second Undo), which takes it out of *Ready for review*; the listing shows
`approved by human:ana`. Reverting is one batch by the person that restores the parameters from before (a
`sound set` of the values that differ for a classic sound, the layer/fx commands for a layered one, `pattern set` for a
song's patterns).

**Comparisons.** The dashboard's blind A/B card plays two versions (two cells of a set's grid: one
sound at two tape numbers, or two sounds) at matched loudness with their names hidden, and asks
"Which one fits better in this moment?". Each answer (A fits better, B fits better, Both would do,
Neither would do) is a `comparison` request: it records `a` and `b` (each a sound and the tape
number its version stood at), the `answer` (`a`, `b`, `both`, `neither`), the moment the person read
and the gain that matched each side's level. It marks nothing on the sounds. It reaches the agent
through `await` as `comparison r5 (step_2) from human:ana at …: A fits better in "walks slowly
across a meadow at night": A was step_2 as at #12 (gain +1.2 dB), B was step_2 as at #20 (gain
−0.3 dB)`, `request <project>` lists it the same way, and the agent claims it and closes it with
`done` like praise: it is a judgment to steer by, not a change to make.

`soundclaw work` is the agent's side for a session without MCP: `list` hands over the open requests
(marking them seen), `claim` takes the next one (or a named one) and prints what is asked and the
sound as it stands, `progress` posts a note the person sees, `block` stops with one question the
person answers on the card (the request opens again), `done` finishes it with what changed.

## MCP tools

`soundclaw serve --project <folder>` speaks MCP on stdin and stdout and serves the dashboard on
`http://127.0.0.1:<port>/?token=…` (the link is printed to stderr and returned by `project`). MCP
is also served over HTTP at `/mcp` with the token as a bearer.
A server started again on the same folder keeps the last one's token, so an open dashboard and its
links keep working across a restart (the token is kept beside the lock file, readable only by you).

| Tool | Does |
|---|---|
| `project` | The sounds with their numbers, the open requests, and the watch link. |
| `run` | `commands`: a batch, as above. |
| `history` | The tape, filtered by `sound`, `by` or `last` (default 50). Includes what people did. |
| `render` | `sound`: the numbers of its render (samples, peaks, loudness, attack, tail, brightness, pitch, onsets), a description, and the check summary last. |
| `view` | `sound` (a set's name for `set`), `kind` (for a sample: `wave`, `spec`, `pitch`, `loop`, `slices`; `wave`, `spec` default, `pitch`, `layers`, `loop`, `set`, `compare`), `other` for compare (a sound, a song, or the path of a WAV or OGG file; `sound` may be a file too): a PNG image and the numbers. |
| `describe` | `sound` (also `sample:<name>` or `hash:<sha256>`), `json`: words from the numbers, then the numbers (or one JSON object). |
| `measure` | `sounds` (ids and set names; default all; `sample:<name>` measures a sample), `json` (default true): the class, every number and every check of many sounds in one call. |
| `normalize` | `sounds`, `to` (a class name, or `target=<LUFS>`): write the gain that brings sounds, a set or a song to a loudness, as one undo group. A song with layers is fitted so every mix of them is inside the class window. |
| `check` | `sounds` (sound ids and set names; default all), `json`: the checks with scores, thresholds and flagged ranges, and `set-spread` for a set. |
| `import` | `source` (csv, patch text or strings, or a path), `kind` (`sfxr` default, `jsfxr`, `bfxr`), `id`: make classic sounds, each row reported. |
| `sample` | `action`: `import` (`file`, a file or a folder, with `as`, `licence`, `attribution`, `terms`, `tags`, `source`, `origin`, `note`, `force`), `list` (`query`, a numbers query; `json`), `show` (`name`), `check` (`names`: advice on samples), `gc` (`apply`, `drop_history`), `upgrade`. Change or make a sample with `run` (`sample set …`, `sample rename …`, `sample remove …`, `sample derive …`, `sample slice …`, `sample loop …`, `sample bounce …`). |
| `generate` | `prompt`, `kind` (`sfx`, `music`), `duration`, `takes`, `loop`, `influence`, `model`, `as`, `want`, `like`, `provider`, `tags`, `composition`, `again`, `estimate`, `by`; `action` `ledger` or `config`: audio from a prompt, each take a sample, every cap checked before the first call. |
| `licence` | `ids` (sounds, sets, songs, instruments, samples; default every sound, instrument and song), `allow_licence`: where each stands (shippable, attribution, unknown, blocked) and the samples behind it. |
| `export` | `sounds` (default all), `set`, `all`, `format` (`wav` default, `ogg`, `patch`, `csv`), `out` (default `<project>/exports`), `pack`, `quality`: with `all`, `set`, `pack` or `ogg` a `manifest.json` too (`allow_licence` lets licence ids through a manifest export). A song: `format` `wav`, `ogg` or `midi`, `loop`, `stems`, `stemsThroughMaster`, `loops`, `pattern`. |
| `changes` | `since`, `by`, `peek`: what others changed since you last looked, with parameters and numbers before and after and a compare PNG path. |
| `request` | File (`sound`, `note`, `tags`, `like`), `reply` (`id`, `text`) or `cancel` a request. |
| `work` | `next` (default), `progress`, `done`, `blocked`, `list`. |
| `await_requests` | Wait for people; `cursor` from the previous call. |
| `scale` | `key`: a key like `D:major`, a song id (its key), or `list`: the notes and the chords on each degree with their roman numerals. |
| `style` | The project's music style guide and music bible as SoundClaw reads them, with the lines it cannot read. |

## HTTP API (localhost, token required)

| Path | Returns |
|---|---|
| `GET /api/state` | The snapshot the dashboard starts from: sounds, samples, style, tape, requests, presence. |
| `GET /api/render/<id>.f32` | The sound's samples as the server renders them: little-endian float32 (a stereo sound: the left channel, then the right). |
| `GET /api/render/<id>.f64` | The exact doubles (for a classic sound, the reference samples that WAVs quantise): little-endian float64. |
| `GET /api/render/<id>.wav` | The same as the exported WAV (a classic sound in the pre-rendered form, a layered sound through the limiter, stereo when it is). |
| `GET /api/samples`, `GET /api/samples/<name>.wav` | The project's samples (name, hash, rate, length, format, licence and its state, source, tags) and the audio a name stands for. |
| `GET /api/sample-object/<hash>` | The stored audio of a hash, as a WAV. The bytes never change, so it is sent as cacheable for ever; the page fetches the samples a sound names by hash to render its sample layers. Byte ranges are answered. |
| `GET /api/sample-card/<hash>.json` | A sample's numbers (the measure `describe` prints) and 96 peaks for a small waveform, worked out once per audio in a worker thread and kept in `.cache/samplecards`. |
| `GET /api/sample-detail/<name>.json` | What a sample's page shows beyond the list: the whole provenance, the licence and why it stands as it does, the metadata, and which sounds, instruments, songs and samples reach it. |
| `GET /api/libraries`, `GET /api/library/search?q=<words and numbers>&library=<id>&offset=<n>&limit=<n>` | The registered sample libraries (and how many files each index holds), and a page of hits (at most 96) in the compact form `library search --json` prints. |
| `POST /api/library/use` | `{ "ref": "<library>:<path>", "as", "by": "human:<name>" }`: `library use` as a person. |
| `GET /api/library/<id>/audio?path=<path>` | A file of a registered sample library, decoded to a WAV for auditioning, confined to the library's folder; byte ranges are answered. |
| `POST /api/samples/import?by=human:<name>&name=<file name>` | An uploaded audio file (the body is its bytes, at most 200 MB), read in a worker thread and named on the tape as that person. `as`, `licence`, `attribution`, `terms`, `tags`, `source`, `origin` and `note` are as for `sample import`; the file name is cut to its last part. |
| `POST /api/generate` | `{ "kind", "prompt", "pairs", "again", "estimate", "by" }`: a `generate` command, run here with this process's key; answers `{ "text", "json" }`. |
| `GET /api/await?timeout=…&since=…&as=agent:<name>` | Long poll for events. |
| `GET /api/presence` | Who is listening. |
| `POST /api/cli` | A writing CLI command, run on the server's writer (used by the CLI itself). |
| `/ws` | The dashboard's WebSocket: batches, requests and presence out; `run` and `request` in. |
| `/mcp` | MCP over HTTP. |

The token goes as `?token=…` or `Authorization: Bearer …`. The server answers only to the host
names `127.0.0.1`, `localhost` and `[::1]`.
