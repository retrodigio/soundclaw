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
| `sound set <id> duration=<s\|auto> gain=<g> seed=<n>` | On a layered sound: its length (`auto` follows the layers), master level and noise seed. |
| `sound set <id> class=<name>\|none loudness=<LUFS>\|auto` | On any sound: its loudness class (what the `loudness` check holds it to: "Loudness classes" below), or a loudness for this sound alone. The class must be in the project's style. |
| `sound copy <id> <new>` | A copy of the sound under a new id, as a draft, in no set. |
| `sound rename <id> <new>` | Give the sound a new id (a case-only change is allowed); the sets that name it (members, source) and the variants that name it as their source follow. |
| `sound remove <id> [--from-sets]` | Remove a sound. Refused while a set names it (as a member or as its source), unless `--from-sets`, which takes it out of those sets first. All three are commands on the history: `undo` brings the sound back. |
| `sound loop <id> <seconds>\|off [fade=<s>]` | Make a layered sound a looping bed, `<seconds>` long (0.1 to 120), its seam made seamless by a crossfade of `fade` seconds (0.02 to 2, at most half the length, default 0.5); `off` ends it. Layers shorter than length + fade are lengthened (see "Loops"). |
| `set new <set> from=<sound> count=<n> [target=<LUFS>] [class=<name>] [names="<template>" \| as=<id>,<id>,...] [spread="<param>±<amount> ..."] [seed=<n>]` | Make a set of `count` (1 to 32) seeded variants of a classic or layered sound, each a real sound named `<set>_1` … `<set>_<n>` (or by `names="step_{n}"`, where `{n}` is 1, 2, ..., or by an explicit list `as=`), matched to the loudness target (or the class's) by gain. See "Sets". |
| `set add <set> <sound>...`, `set remove <set> <sound>...` | Put existing sounds into a set (they are matched to its target), or take them out (they stay as sounds). |
| `set retarget <set> <LUFS>\|none` | Change the loudness the members are held to and matched to (`-20` or `-20LUFS`), or stop matching. |
| `set class <set> <name>\|none` | The loudness class of the members that have none of their own; with no target on the set, they are matched to the class's target. |
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

*sample*: an imported WAV (`soundclaw sample import <project> <file.wav | folder> [as=<name>]`: PCM 8/16/24/32-bit or 32-bit float,
any rate, stereo mixed to mono, at most 120 s; it is copied to `<project>/samples/`). It plays at its own rate resampled
(linear interpolation), trimmed by `start` and `end`, transposed by `pitch` (its length changes with it) and optionally
backwards. A batch that names a sample that is not in the project is refused. The render key includes the file's hash.

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `sample` | text | none | - | the name of a sample in the project (sample import <project> <file.wav> as=<name>) |
| `start` | 0 to 120 s | 0 | - | trim: where in the sample to start |
| `end` | 0 to 120 s | 0 | - | trim: where to stop (0 = the end) |
| `pitch` | -48 to 48 semitones | 0 | yes | transposition (the sample's length changes with it) |
| `reverse` | 0 to 1 (whole) | 0 | - | 1 plays it backwards |

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
```

Each hit rises over `attack` seconds (0.0005 to 1) to its level (0 to 4) and falls back to 0 on an exponential curve over `decay` seconds (0.005 to 10; 60 dB down at its end). `times=` gives the hits' start times (they must not overlap: a hit lasts attack + decay). `count=` with `over=` (seconds) spreads that many hits evenly over the time, each moved by up to `jitter` (0 to 1, default 0.5) of its slot, seeded (`seed=`; without one it comes from the settings, so the same text is always the same hits); `level=0.4..1` draws each hit's level from a range (count form). At most 85 hits per envelope (256 breakpoints). Write it without spaces, or in quotes. It works on any target that takes an envelope.

Targets: `N.amp` (the amplitude envelope of layer N, 0 to 4), `N.<param>` (a layer parameter that takes an envelope: see the
"Envelope" column), `N.fxK.<param>` (the K-th effect of layer N), `master.fxK.<param>`. `env <id> <target> adsr(a,d,s,r[,hold])`
writes an amplitude envelope as breakpoints (attack linear to 1, decay `exp` to the sustain level, optional hold, release `exp`
to 0) and the normal form is the breakpoints. `clear` removes an envelope. At most 256 points. Values must be inside the
parameter's range. Setting a fixed value with `layer set` or `fx set` removes that parameter's envelope.

**Effects** (`fx add <id> [layer=<n>] <kind> ...`), at most 8 per chain, run in the order of the list:

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
| `size` | 0 to 1 | 0.5 | - | room size (0 small … 1 large); the tail is about 0.3 + 2.2 × size seconds |
| `damp` | 0 to 1 | 0.5 | - | how fast the highs die away |
| `mix` | 0 to 1 | 0.3 | yes | dry/wet |

*compress*: a feed-forward compressor. A peak detector (one pole: `attack` when the level rises, `release` when it falls) measures the level in dB; above `threshold` the level is cut by `1 − 1/ratio` of the excess, and `makeup` dB is added after. A constant 0.5 (−6 dB) over a −18 dB threshold at 4:1 comes out 9 dB lower. It has no look-ahead, so a transient faster than the attack passes through (that is what `limit` is for). Deterministic: only + − × ÷ and the renderer's own `exp2` and `log2`.

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `threshold` | -60 to 0 dB | -18 | - | level above which the sound is turned down (peak level, dBFS) |
| `ratio` | 1 to 20 | 4 | - | how much of the level above the threshold is kept: 4 means 4 dB over becomes 1 dB over |
| `attack` | 0.1 to 200 ms | 5 | - | how fast the detector follows a rise in level |
| `release` | 5 to 2000 ms | 100 | - | how fast the detector lets go after the level falls |
| `makeup` | 0 to 24 dB | 0 | - | gain added after compressing |

*limit*: a look-ahead peak limiter: after it no sample is above `ceiling` (sample peaks; the export limiter below still guards the 4×-oversampled true peak). The gain a peak needs is reached `lookahead` ms before the peak (a running minimum over the window, averaged so it moves smoothly) and comes back with a one-pole `release`; under the ceiling the gain is exactly 1, so a quieter sound is left bit for bit as it was. There is no delay. In a stereo sound each channel is limited on its own. Use it on the master chain (or on one layer) so a sparse, spiky sound can be loud without clipping: gain up, then `fx add <id> limit ceiling=-1`.

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `ceiling` | -24 to 0 dB | -1 | - | no sample goes above this level (dBFS) after the limiter |
| `release` | 1 to 1000 ms | 50 | - | how fast the gain comes back after a peak |
| `lookahead` | 0 to 20 ms | 5 | - | how long before a peak the gain starts to come down (0: it drops at once) |

**The sound.** `sound set <id> duration=<s|auto> gain=<g> seed=<n>`:

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `duration` | 0.01 to 120 s | auto | - | length of the sound; `auto` (the default) is as long as the layers and their tails |
| `gain` | 0 to 4 | 1 | - | master level |
| `seed` | 0 to 4294967295 (whole) | 1 | - | the sound's noise seed (layers derive theirs from it) |

An automatic length is as long as the layers that sound (not muted; if any is soloed, those) and their effects' tails, then
trimmed where the sound has died away: the last sample within 60.3 dB of the peak, **wherever that is, inside a layer's own source too**
(a source longer than its envelope no longer leaves silence at the end), closed with a 3 ms fade; a run of less than 1 ms is left alone. A classic
layer is never cut (it is the classic voice as it is, so `sound layer-up` keeps the very samples).

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

**Layered recipes** (`sound new <id> voice=layered preset=<recipe>`, `sound generate <id> <recipe> [seed=<n>]`; also `generate` with a
classic category on a layered sound, which gives it one classic layer). Like the classic categories, the ranges are data (`RECIPES` in
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
- **Checks.** Members are held to the set's target by the `loudness` check (a sound in two sets with targets uses the first). The `set-spread`
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
- `normalize <project> <id|set>... [<class> | target=<LUFS>]` writes the gain that brings sounds to their class (or to a class you name, which they join, or to a target they are then held to). A layered sound's gain goes up to 4; a classic sound's `volume` stops at 1, and the warning says how many LU it falls short (`sound layer-up` first lets gain go to 4).
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
soundclaw changes <project> [--since <command number | time>] [--by human|agent|<author>] [--as <agent>] [--peek]
soundclaw render <project> <id>
soundclaw view <project> <id> wave|spec|pitch [--out <file.png>]
soundclaw view <project> <id> layers [--out <file.png>]
soundclaw view <project> <id> compare <other> [--out <file.png>]
soundclaw describe <project> <id>
soundclaw check <project> [<id>...]
soundclaw import <project> sfxr <file.csv | patch-file | "patch text"> [--id <id>] [--by <author>]
soundclaw sample import <project> <file.wav | folder> [as=<name>]
soundclaw sample list <project>
soundclaw export <project> [<id>...] [--format wav|patch|csv] [--out <dir>]
soundclaw request <project> [<id> --note "<what should change>"] [--tag <tag>]... [--like <sound>] [--by <author>]
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
| `layers` | for a layered sound: each sounding layer's waveform and spectrogram, stacked on one time axis (the layer as it enters the sum: filter, envelope, effects, gain and pan applied), its start offset marked, with its label, gain and pan |
| `loop` | for a looping sound: the last 50 ms joined to the first (the seam marked), the two drawn over each other, the joined spectrogram, and the level across four repeats |
| `set` | (`view <project> <set> set`) a set's members side by side on one time scale: waveform, spectrogram and a loudness bar each (the target marked), then the pairwise distance matrix in dB with the pairs outside the limits outlined |
| `compare` | two spectrograms stacked and, under them, their difference (red: the second is louder; blue: the first), plus distance numbers: spectral distance (dB), loudness, duration, brightness, pitch start and end (semitones), envelope correlation |

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
The gain is a layered sound's `gain` or a classic sound's `volume`; a classic sound that cannot get loud enough is a warning that says by how many LU.

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
- Call it before editing a sound a person has touched, and never undo a person's edit silently: say
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
`sample import <project> <file.wav | folder> [as=<name>]` copies a WAV (or every `.wav` in a folder; a file that cannot be read is reported and the others still go in) into `<project>/samples/`; `sample list` lists them.

Exit codes: 0 done, 1 refused (an error in the commands or the project; nothing was applied), 2
usage error, 3 (`await` only) the timeout passed with nothing to report.

### While a server runs

`soundclaw serve` owns its project. Commands that write (`run`, `export`, `import`, `sample import`, `request`, `reply`,
`cancel`, `work`) are sent to it over HTTP, found through the project's lock file and a token file
only you can read, so they go through its single writer and a connected dashboard updates live.
If a server holds the folder and its token cannot be read, a writing command refuses rather than
write behind its back. Read-only commands (`list`, `history`, `render`, `view`, `describe`, `check`) read the files.

### The dashboard's pages

`soundclaw serve` prints the watch address; the page has four views, all written to by commands as `human:<name>` (what a person does is on the history):

| Address | Page |
|---|---|
| `#/` | the cards (play, waveform, spectrogram, checks, Approve, Ask for changes, Feedback, Edit) and, above them, a tile for each set |
| `#/sound/<id>` | the editor (classic sliders, or layers, envelopes and effects), with the **Loop** panel: a loop box (`sound loop <id> 4 …` / `off`), the length and the crossfade (each a `sound loop` command), **Play looped** (repeats until stopped) and the numbers of the seam |
| `#/set/<set>` | a set: its members in a row (each with waveform, spectrogram, loudness, check badge, Play), **Play in sequence** (with a gap, in ms), **Regen with a new seed** (`set regen <set> seed=<n>`, the seed chosen by the page), the spread rules, the distance matrix (pairs outside the limits outlined) and the set-spread verdict |
| `#/audition`, `#/audition/<set>` | the batch audition page: every sound (or a set's members) as a compact card with Play, the check badge, Approve, Ask and Feedback; **Play all** with a gap; filters by set, status, checks and feedback tag; the keyboard: ← → ↑ ↓ move the selection, **space** plays it, **a** approves it (`sound mark … approved`), **r** opens the note for Ask for changes (shortcuts are off while you type) |

Approvals, asks and feedback from the audition page are the same requests as on the cards: they reach a waiting agent through `await`.

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
| `view` | `sound` (a set's name for `set`), `kind` (`wave`, `spec` default, `pitch`, `layers`, `loop`, `set`, `compare`), `other` for compare: a PNG image and the numbers. |
| `describe` | `sound`, `json`: words from the numbers, then the numbers (or one JSON object). |
| `measure` | `sounds` (ids and set names; default all), `json` (default true): the class, every number and every check of many sounds in one call. |
| `normalize` | `sounds`, `to` (a class name, or `target=<LUFS>`): write the gain that brings sounds to a loudness, as one undo group. |
| `check` | `sounds` (sound ids and set names; default all), `json`: the checks with scores, thresholds and flagged ranges, and `set-spread` for a set. |
| `import` | `source` (csv, patch text or strings, or a path), `kind` (`sfxr` default, `jsfxr`, `bfxr`), `id`: make classic sounds, each row reported. |
| `sample` | `action` (`import` with `file` (a WAV or a folder) and `as`, or `list`): WAV samples for sample layers. |
| `export` | `sounds` (default all), `set`, `all`, `format` (`wav` default, `ogg`, `patch`, `csv`), `out` (default `<project>/exports`), `pack`, `quality`: with `all`, `set`, `pack` or `ogg` a `manifest.json` too. |
| `changes` | `since`, `by`, `peek`: what others changed since you last looked, with parameters and numbers before and after and a compare PNG path. |
| `request` | File (`sound`, `note`, `tags`, `like`), `reply` (`id`, `text`) or `cancel` a request. |
| `work` | `next` (default), `progress`, `done`, `blocked`, `list`. |
| `await_requests` | Wait for people; `cursor` from the previous call. |

## HTTP API (localhost, token required)

| Path | Returns |
|---|---|
| `GET /api/state` | The snapshot the dashboard starts from: sounds, samples, style, tape, requests, presence. |
| `GET /api/render/<id>.f32` | The sound's samples as the server renders them: little-endian float32 (a stereo sound: the left channel, then the right). |
| `GET /api/render/<id>.f64` | The exact doubles (for a classic sound, the reference samples that WAVs quantise): little-endian float64. |
| `GET /api/render/<id>.wav` | The same as the exported WAV (a classic sound in the pre-rendered form, a layered sound through the limiter, stereo when it is). |
| `GET /api/samples`, `GET /api/samples/<name>.wav` | The project's samples (name, SHA-256, rate, length) and their bytes; the page fetches them to render sample layers. |
| `GET /api/await?timeout=…&since=…&as=agent:<name>` | Long poll for events. |
| `GET /api/presence` | Who is listening. |
| `POST /api/cli` | A writing CLI command, run on the server's writer (used by the CLI itself). |
| `/ws` | The dashboard's WebSocket: batches, requests and presence out; `run` and `request` in. |
| `/mcp` | MCP over HTTP. |

The token goes as `?token=…` or `Authorization: Bearer …`. The server answers only to the host
names `127.0.0.1`, `localhost` and `[::1]`.
