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
| `sound new <id>` | Make a sound. Ids are `a-z`, `0-9`, `_` and `-`, start with a letter, at most 48 characters. A new sound is a 440 Hz, 0.5 s, volume 0.5 sine tone (the placeholder voice). |
| `sound new <id> voice=classic [preset=<category>] [seed=<n>]` | Make a classic-voice sound: the 25 sfxr-style parameters at their defaults, or generated from a category (below). `preset=` alone means `voice=classic`. Without `seed=` the seed comes from the category and the id, and is written into the normal form. |
| `sound set <id> <param>=<value> ...` | Change parameters (those of the sound's voice, below). Values outside a range are errors. `wave=square\|saw\|sine\|noise` takes names. `seed=<n>` fixes the noise stream; `seed=auto` goes back to the hash of the values. |
| `sound patch <id> "<single-patch text>"` | Replace all 25 values from sfxr patch text: numbers in positional order (an empty field keeps the default) or `name=value` pairs, with an optional version line first (write the line break as `\n` inside the quotes). |
| `sound generate <id> <category\|random> [seed=<n>]` | Replace a classic sound's 25 values with a new patch from a category or from `random` (below). The seed used is written into the normal form, so a history replays. This is what the editor's category and `random` buttons write. |
| `sound mutate <id> [amount=0.05] [seed=<n>] [as=<new id>]` | A small seeded change to a classic sound (also written `mutate <id> ...`): each parameter except the wave and the volume moves, with a chance of one half, by up to `amount`, kept in its range. `as=` leaves the original alone and makes a new sound. The seed used is written into the normal form. |
| `sound mark <id> approved\|rejected\|draft ["note"]` | Set the sound's status. People use the dashboard's Approve and Ask for changes buttons, which write this. |
| `sound new <id> voice=layered [preset=<recipe>] [seed=<n>]` | Make a layered sound: up to 8 layers, envelopes, effects (below). `preset=` takes a layered recipe (`footstep`, `ui-click`, `door`, `magic`) or a classic category (one classic layer). The seed (the sound's noise seed; the recipe's seed too) is written into the normal form. |
| `sound set <id> duration=<s\|auto> gain=<g> seed=<n>` | On a layered sound: its length (`auto` follows the layers), master level and noise seed. |
| `sound layer-up <id>` | A classic sound becomes layered: the classic voice is layer 1, the very same samples. Refused on a sound marked classic. |
| `sound classic <id> on\|off` | Mark a classic sound as classic: it must stay one classic voice, so it refuses `sound layer-up` (and the layer and effect commands refuse it as ever), and it exports as a `synth.csv` row. |
| `layer add <id> classic\|osc\|fm\|ks\|sample [<param>=<value> ...] [at=<n>]` | Add a layer with a source (below). A classic layer also takes `preset=<category>` (`presetseed=<n>`) or `patch="<single-patch text>"`. |
| `layer set <id> <n> <param>=<value> ...` | Change a layer's parameters; `source=<kind>` changes its source (the source's parameters go back to their defaults). A fixed value replaces any envelope on that parameter. |
| `layer remove\|move\|mute\|solo <id> <n> [to=<m> \| on\|off]` | Remove a layer, move it to a position, mute or solo it (`on` is the default; `off` undoes). If any layer is soloed only soloed layers sound. Layers count from 1. |
| `env <id> <target> "<breakpoints>"` | An envelope on a parameter (below). Also `adsr(a,d,s,r[,hold])` for an amplitude envelope, and `clear`. |
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
| `offset` | 0 to 10 s | 0 | - | when the layer starts, from the start of the sound |
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
| `dur` | 0.01 to 10 s | 0.3 | - | length of the source |

Wavetables: `organ`, `bell`, `reed`, `hollow` (built from harmonics) or your own: `table=0,0.8,1,0.2,-0.5,-1,-0.3,0`
(4 to 64 numbers, read with linear interpolation).

*fm*: 2 to 4 operators, each a sine at `freq × ratio`. Operator 1 is always a carrier; `index2..4` is how strongly operator
2, 3, 4 modulates its target (radians of phase modulation; 0 silences the modulator, and with every index 0 the sound
is its carrier sine bit for bit). Algorithms: `chain` 4→3→2→1; `fan` 2, 3 and 4 all modulate 1; `pairs` 2→1 plus 4→3,
carriers 1 and 3 added; `parallel` all added. Carriers are added at their `level` and divided by their count.

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `freq` | 20 to 20000 Hz | 440 | yes | base pitch; each operator runs at freq × its ratio |
| `dur` | 0.01 to 10 s | 0.3 | - | length of the source |
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
| `dur` | 0.01 to 10 s | 1 | - | length of the source |
| `decay` | 0.05 to 10 s | 1 | - | time for the string to fall by 60 dB |
| `bright` | 0 to 1 | 0.8 | - | brightness of the pluck (0 dull … 1 bright) |

*sample*: an imported WAV (`soundclaw sample import <project> <file.wav> [as=<name>]`: PCM 8/16/24/32-bit or 32-bit float,
any rate, stereo mixed to mono, at most 60 s; it is copied to `<project>/samples/`). It plays at its own rate resampled
(linear interpolation), trimmed by `start` and `end`, transposed by `pitch` (its length changes with it) and optionally
backwards. A batch that names a sample that is not in the project is refused. The render key includes the file's hash.

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `sample` | text | none | - | the name of a sample in the project (sample import <project> <file.wav> as=<name>) |
| `start` | 0 to 60 s | 0 | - | trim: where in the sample to start |
| `end` | 0 to 60 s | 0 | - | trim: where to stop (0 = the end) |
| `pitch` | -48 to 48 semitones | 0 | yes | transposition (the sample's length changes with it) |
| `reverse` | 0 to 1 (whole) | 0 | - | 1 plays it backwards |

**Envelopes.** `env <id> <target> "<breakpoints>"` replaces a fixed value with breakpoints `time:value`, times in seconds from the
start of the layer (the master chain's from the start of the sound), rising. Each point may carry a curve for the segment
that arrives at it: `0:100 0.2:400@exp 0.5:100@ease`. Before the first point the value is the first, after the last the last.

| Curve | The segment arriving at the point |
|---|---|
| `lin` (default) | a straight line |
| `exp` | between two values of the same sign: geometric, equal ratios in equal times (a pitch glide of equal musical steps); towards or from zero or across it: a fast-then-slow fall `(1 − 2^(−8u)) / (1 − 2^−8)`, the shape of a decay |
| `hold` | stays at the earlier value until the point, then jumps |
| `ease` | smoothstep `u²(3 − 2u)` |

Targets: `N.amp` (the amplitude envelope of layer N, 0 to 4), `N.<param>` (a layer parameter that takes an envelope: see the
"Envelope" column), `N.fxK.<param>` (the K-th effect of layer N), `master.fxK.<param>`. `env <id> <target> adsr(a,d,s,r[,hold])`
writes an amplitude envelope as breakpoints (attack linear to 1, decay `exp` to the sustain level, optional hold, release `exp`
to 0) and the normal form is the breakpoints. `clear` removes an envelope. At most 32 points. Values must be inside the
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

**The sound.** `sound set <id> duration=<s|auto> gain=<g> seed=<n>`:

| Parameter | Range | Default | Envelope | Meaning |
|---|---|---|---|---|
| `duration` | 0.01 to 10 s | auto | - | length of the sound; `auto` (the default) is as long as the layers and their tails |
| `gain` | 0 to 4 | 1 | - | master level |
| `seed` | 0 to 4294967295 (whole) | 1 | - | the sound's noise seed (layers derive theirs from it) |

An automatic length is as long as the layers that sound (not muted; if any is soloed, those) and their effects' tails, then
trimmed where the sound has died away (the last sample within 60.3 dB of the peak, with a 3 ms fade if an effect's tail
was cut), but never inside a layer's own source.

**Limiter.** A layered sound is exported through a look-ahead peak limiter (about 1 ms) whose ceiling is the style's
`truePeakMax` (default −0.1 dBTP, kept 0.1 dB inside it): no sample and no point between samples (4× oversampled) goes above it, and
under the ceiling it changes nothing. `export` says how much it reduced. The checks measure the sound as rendered, before the
limiter, so they tell you when the limiter would have to work.

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
| `footstep` a soft thud and a scuff: shoes on a floor | osc | 1 | osc wave sine; freq 90..150; dur 0.17..0.22; gain 0.7..1 | amp 0:0 0.003:1 0.1..0.16:0@exp; freq 0:110..170 0.1:45..65@exp | - |
|  | osc | 1 | osc wave one of brown, pink; dur 0.12..0.2; filter lp; cutoff 900..1800; q 0.7..1.5; gain 0.5..0.9 | amp 0:0 0.004:1 0.09..0.15:0@exp; cutoff 0:1800..2600 0.12:300..500@exp | - |
|  | osc | 0.6 | osc wave white; offset 0.02..0.06; dur 0.05..0.1; filter hp; cutoff 2500..4500; gain 0.12..0.3 | amp 0:0 0.004:1 0.04..0.07:0@exp | - |
| `ui-click` a short tick with a bright body: buttons, toggles | osc | 1 | osc wave sine; freq 1800..3000; dur 0.05..0.08; gain 0.6..0.9 | amp 0:1 0.03..0.05:0@exp; freq 0:2200..3200 0.04:1400..1900@exp | - |
|  | osc | 1 | osc wave white; dur 0.015; filter hp; cutoff 3000..6000; gain 0.2..0.4 | amp 0:0 0.001:1 0.012:0@exp | - |
|  | osc | 0.5 | osc wave triangle; freq 2400..4000; offset 0.025..0.045; dur 0.06; gain 0.3..0.5 | amp 0:0 0.002:1 0.05:0@exp | - |
| `door` a thump, a wooden body, a creak that bends and a latch click | osc | 1 | osc wave sine; freq 80..110; dur 0.35; gain 0.8..1 | amp 0:0 0.003:1 0.25..0.32:0@exp; freq 0:90..120 0.2:35..50@exp | - |
|  | osc | 1 | osc wave brown; dur 0.3; filter lp; cutoff 400..800; gain 0.5..0.8 | amp 0:0 0.003:1 0.2..0.28:0@exp | - |
|  | osc | 1 | osc wave saw; offset 0.12..0.3; dur 0.62..0.9; filter bp; cutoff 600..900; q 4..9; gain 0.35..0.55 | amp 0:0 0.12:1 0.3..0.4:0.7 0.5..0.6:0@exp; freq 0:160..240 0.25:300..420 0.6:140..200; cutoff 0:500..800 0.6:900..1500 | distort shape soft drive 3..8 mix 0.5 |
|  | osc | 0.7 | osc wave square; freq 1200..2000; offset 0.35..0.5; dur 0.02; gain 0.25..0.4 | amp 0:0 0.001:1 0.018:0@exp | - |
|  | master | 1 | - | - | reverb size 0.15..0.35 damp 0.6 mix 0.08..0.15 |
| `magic` a run of bell tones with a shimmer, spread across the stereo field, with echo and room | fm ×3..5 every 0.04..0.09 s, 0.8× as loud | 1 | fm freq one of 1047, 1319, 1568, 1976, 2349, 2637; ops 2; algo chain; ratio2 1.5..3.5; index2 2..5; dur 0.45..0.8; gain 0.45..0.6; pan -0.5..0.5 | amp 0:0 0.004:1 0.35..0.44:0@exp; index2 0:3..6 0.4:0@exp | - |
|  | osc | 1 | osc wave white; dur 0.4..0.7; filter hp; cutoff 6000..8000; gain 0.08..0.14 | amp 0:0 0.1:1 0.35..0.39:0@exp | - |
|  | master | 1 | - | - | delay time 0.11..0.19 feedback 0.3..0.45 mix 0.2..0.3 |
|  | master | 1 | - | - | reverb size 0.5..0.8 damp 0.4 mix 0.2..0.3 |

`examples`: `docs/examples/layered-demo.txt` builds an impact, a magic sparkle and a door creak (all three pass the checks).

### Checks and the project style

Six checks hold a sound to the project's style (below). Each has a score from 0 to 1, a threshold,
and the exact time ranges it flags.

| Check | Flags | Default |
|---|---|---|
| `clip` | true peak above the limit, or samples at full scale (the ranges are where) | at most -0.1 dBTP |
| `loudness` | integrated loudness (ITU-R BS.1770, K-weighted, gated) off the target | -16 LUFS ±1 |
| `dc` | DC offset | at most 0.5 % |
| `click` | a jump at the first or last sample | at most 0.02 of full scale |
| `tail` | silence padding at the start or end, or a sound cut off before it died away (the last samples are not at least 60 dB below the peak) | at most 50 ms; -60 dB |
| `harsh` | sustained energy at 2 to 5 kHz: the level of that band (dBFS, RMS of the band content, from 1024-sample Hann spectra; a full-scale sine inside it reads -3) stays above the limit for at least the minimum time (the ranges are where) | at most -20 dBFS for 80 ms |

Every check works on stereo (below). A sound shorter than 400 ms is measured as one block over its whole length (BS.1770 needs 400 ms
blocks; padding with silence would lower the figure). `work` `done` on a request is refused while the
sound's checks fail. Targets come from the optional `style` object in `project.json`, any of
`loudnessTarget`, `loudnessTolerance`, `truePeakMax`, `dcMax`, `clickMax`, `silenceMax` (seconds),
`tailFloorDb`, `harshLimitDb` (dBFS), `harshMinMs`; the defaults fill what is left out. An unknown key is an error.

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
soundclaw sample import <project> <file.wav> [as=<name>]
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
| `compare` | two spectrograms stacked and, under them, their difference (red: the second is louder; blue: the first), plus distance numbers: spectral distance (dB), loudness, duration, brightness, pitch start and end (semitones), envelope correlation |

`describe` is a plain-words summary built only from the measured numbers (never from the sound's
settings), then the numbers. `check` runs the checks with scores, thresholds and the exact ranges;
it exits 1 when any sound fails.

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
patch text itself. One undo group. A sound id that appears twice in a csv is read as the engine
reads it: the id keeps the position of its first row and the values of its last, and a warning names
both lines (`warning: synth.csv: 'zip' is on line 2 and again on line 4; …`).

`export --format`: `wav` (default; 16-bit PCM, 44,100 Hz, mono; a classic sound is written in the
engine's pre-rendered form, each sample `trunc(s × 32000)`), `patch` (`<id>.sfxr`, the single-patch
text: a version line, then the 25 values at six significant digits; a sound with a seed is written
as `name=value` pairs so the seed travels), `csv` (one `synth.csv`, every column at full precision,
so reading it back renders the same samples).

A layered sound exports as a **WAV only** (16-bit, 44,100 Hz, mono or stereo, through the limiter above); `export` says so for each one
and how much the limiter reduced it, `--format csv` and `patch` refuse a layered sound that is named and skip it when everything is
exported (a `synth.csv` row cannot hold layers). A classic sound marked classic, or never layered, keeps exporting as a row.
`sample import <project> <file.wav> [as=<name>]` copies a WAV into `<project>/samples/`; `sample list` lists them.

Exit codes: 0 done, 1 refused (an error in the commands or the project; nothing was applied), 2
usage error, 3 (`await` only) the timeout passed with nothing to report.

### While a server runs

`soundclaw serve` owns its project. Commands that write (`run`, `export`, `import`, `sample import`, `request`, `reply`,
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
| `view` | `sound`, `kind` (`wave`, `spec` default, `pitch`, `layers`, `compare`), `other` for compare: a PNG image and the numbers. |
| `describe` | `sound`: words from the numbers, then the numbers. |
| `check` | `sounds` (default all): the checks with scores, thresholds and flagged ranges. |
| `import` | `source` (csv or patch text, or a path), `id`: make classic sounds. |
| `sample` | `action` (`import` with `file` and `as`, or `list`): WAV samples for sample layers. |
| `export` | `sounds` (default all), `format` (`wav` default, `patch`, `csv`), `out` (default `<project>/exports`). |
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
