// soundclaw: new | run | list | history | changes | render | view | describe | check | import | sample | export | scale | style | request | reply | cancel | work (its actions) | skill (await and serve: entry.ts). A thin layer over @soundclaw/core and the project folder.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTHOR_RE, BIBLE_FILE, STYLE_FILE, guideText, openRequests, scaleText, shipPolicyOf, type ViewKind } from '@soundclaw/core';
import { SONG_VIEWS, exportSong, formatSongExport, listInstruments, midiImportScript, songChecksText, songJsonObject, songNumbersText, songSummary, viewSong, type SongViewKind } from '@soundclaw/server';
import {
  EXPORT_FORMATS, SAMPLE_VIEWS, isSampleRef, sampleView, sampleDescribeText, sampleMeasureJson, sampleCheckText, compareText, sampleLine, gcApply, gcPlan, gcReport, gitLfsLines, importPath, importReport, licenceCheck, licencePolicyNote, licenceReportText, sampleListText, sampleShowText, upgradeProject, changesText, ProjectError, Writer, describeJson, measureJson, measureText, normalizePlan, soundJson, agentName, agentWork, checkText, cliSteps, createProject, describeText, exportFormat, formatErrors, formatExportFiles, formatRun, historyText, humanName,
  IMPORT_KINDS, formatImportReport, importCommands, loadProject, lockHolder, personRequest, plural, readRequests, renderText, requestBrief, requestLine, setSummary, shellArg, soundSummary, toPersonRequest, viewSound, type ExportFormat, type ImportKind, type Project,
} from '@soundclaw/server';
import { addLibrary, hitJson, listLibraries, listText, removeLibrary, searchLibraries, searchText, similarLibraries, stateUnder, tagFile, useLibraryFile } from '@soundclaw/server';
import { soundclawVersion } from './version.ts';
import { init, runClaude, SCOPES, type ClaudeRunner, type Scope } from './init.ts';

export interface Io {
  out(s: string): void;
  err(s: string): void;
  stdin(): string;
  now(): string;
  /** Set when the command runs inside a server (a CLI call sent to it): its writer is used instead of a new one. */
  writer?: Writer;
  /** Runs the claude command for `init` (tests replace it). */
  claude?: ClaudeRunner;
  /** The folder `init` works in (tests replace it); the process's own by default. */
  cwd?: string;
}

const nodeIo: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  stdin: () => readFileSync(0, 'utf8'),
  now: () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
};

export const USAGE = `soundclaw: a sound effects and music workbench driven by commands

  soundclaw --version | soundclaw <command> --help | soundclaw help <command>
      The version; the usage of one command.

  soundclaw init [<project>, default sounds] [--scope local|project|user] [--name soundclaw] [--no-skill] [--force]
      Set up Claude Code in this folder, in one step: make the project (or use the one there), install
      the skill, and register the MCP server (claude mcp add; .mcp.json when claude is not on the PATH)
      as npx soundclaw@<this version> serve --project <project>. --scope project shares both in the repo
      (.mcp.json and .claude/skills); --force replaces an entry with the same name. Then start claude.
  soundclaw new <project> [--name <name>]
      Create a project folder: sounds/, instruments/, songs/, sets/, history.jsonl (the history
      tape), requests.jsonl, and exports/ (ignored by git).
  soundclaw run <project> (<script> | - | -e "<commands>") [--by <author>]
      Apply commands as one undo group; any error applies nothing. Commands, one per line or
      separated by ';' ('#' starts a comment):
        sound new <id>                                      a placeholder sine tone
        sound new <id> voice=classic [preset=<category>] [seed=<n>]   the classic voice (25 sfxr-style
                                                            parameters); presets: pickup laser explosion
                                                            powerup hit jump blip, seeded
        sound set <id> <param>=<value> ...                  tone: frequency duration volume; classic: the 25
                                                            parameters (wave=square|saw|sine|noise) and seed
        sound patch <id> "<single-patch text>"              all 25 values from sfxr patch text
        sound generate <id> <category|random> [seed=<n>]    a new patch for a classic sound from a category's ranges
        sound mutate <id> [amount=0.05] [seed=<n>] [as=<new id>]   a small seeded change (also: mutate <id> ...)
        sound mark <id> approved|rejected|draft ["note"]
        sound new <id> voice=layered [preset=<recipe>] [seed=<n>]   up to 8 layers (see docs/commands.md); recipes:
                                                            footstep ui-click door magic, beds wind rain fire crowd (or a classic category)
        sound layer-up <id>                                 a classic sound becomes layered (same samples)
        sound classic <id> on|off                           keep a sound one classic voice (exports as a synth.csv row)
        sound set <id> class=<name>|none loudness=<LUFS>|auto   the sound's loudness class (ui foley impact ambience voice music-sting standard), or its own target
        sound copy <id> <new>   sound rename <id> <new>   sound remove <id> [--from-sets]   (undoable; ids are case-sensitive, unique ignoring case)
        sound set <id> duration=<s|auto> gain=<g> seed=<n>  (layered sounds)
        sound loop <id> <seconds>|off [fade=<s>]            a looping bed (0.1 to 120 s): the seam is made seamless; layers shorter than length + fade are lengthened
        set new <set> from=<sound> count=<n> [target=<LUFS>] [class=<name>] [names="<id with {n}>" | as=<id>,<id>,...] [spread="<param>±<amount> ..."] [seed=<n>]
                                                            count seeded variants of a sound, each a real sound
                                                            (<set>_1 ... or the names you give), matched to the loudness target by gain
        set add|remove <set> <sound>...   set retarget <set> <LUFS>|none   set class <set> <name>|none   set regen <set> [seed=<n>] [spread="..."]
        sound set <id> moment="<the game situation>"|none   set moment <set> "…"|none   (words only)
        family <sound> near|far|muffled [as=<id>]           the sound heard near, far away or through a wall
        layer add <id> classic|osc|fm|ks|sample [<param>=<value> ...] [at=<n>]
        layer set <id> <n> <param>=<value> ...   layer remove|move|mute|solo <id> <n> [to=<m> | on|off]
        layer align <id> <n> to=<m>|start [by=onset|peak]   layer match <id> <n> to=<m> [db=<offset>]   (measured, written as layer set offset= / gain=)
        env <id> <n>.amp follow=<layer>|sample:<name> [attack=<s>] [release=<s>]   an envelope that follows a layer's or a sample's level
        env <id> <target> "<time>:<value>[@lin|exp|hold|ease] ..." | adsr(a,d,s,r[,hold]) | bursts(times=...|count=... over=...) | clear
        fx add <id> [layer=<n>] filter|distort|bitcrush|chorus|delay|reverb|compress|limit [<param>=<value> ...] [at=<k>]
        fx set|remove|move <id> [layer=<n>] <k> ...
        undo [group=<g>] [by=<author>]    redo [group=<undo group>] [by=<author>]   (each alone in its batch)
        instrument new <id> [from=<built-in>|kind=osc|fm|ks|classic|sample]   instrument from-sound <id> <sound> [root=<note>]   instrument set <id> root= adsr=a,d,s,r range= ...
        instrument layer|fx|env <as the sound commands> ...   (built-ins to play as they are: square_lead pulse_lead triangle_bass saw_pad fm_bell fm_bass pluck kick snare hat hat_open)
        song new <id> [tempo=] [swing=] [time=4/4] [key=A:minor] [class=music|stinger]   song set <id> ...   song channel add|set <song> <name> inst=<instrument>|kit=default [gain=] [pan=] [layer=]
        pattern <song>.<name> steps=16 tpb=4 [bar=8], then indented rows:  lead: C5 . E5 - | G5v80 . E5~slide .      pattern set|remove|copy|rename <song>.<name> ...
        pattern note add|remove|move|len|set <song>.<pattern> <channel> <step> ...   (one note at a time: add C5 len=2, move step= note=, set vel= fx=)
        song section add|set|remove <song> <name> <pattern>... [x<n>]   song order|intro|ending|loop|fx|copy|rename|remove|mark <song> ...   (music: docs/commands.md)
        song set <id> tags=a,b kind=song|stinger   song channel set <song> <ch> harmony=yes   song new <id> from-bible=<entry> | kind=stinger template=victory|game-over|level-up|item-get
        helpers (they write notes into <pattern>, and go on the tape with the rows they wrote; docs/commands.md "Composition helpers"):
        chords <song> <pattern> <channel> "I vi ii65 V7/V bVII" [bars=] [rhythm=hold|beats|offbeat|"x-.x"] [range=]   bass ... "<prog>"|from=<ch> [style=root|root-fifth|walking|octave]
        arp ... "<prog>"|from=<ch> [pattern=up|down|updown|random(<seed>)] [rate=1/16]   drums <song> <pattern> <ch>[,<hats>] <template> [fill=<n>] [seed=]
        humanise <song> <pattern> <ch>|all [timing=8] [velocity=6] [seed=]   motif set|transpose|invert|retrograde|augment|diminish|write|sequence ...   layer-plan <song> base=<ch,..> tension=...
      '-' reads the commands from standard input. --by is the author written on the history:
      agent:<name> or human:<name> (default agent:claude; a bare name means agent:<name>).
      The result lists the commands as written and each changed sound's numbers and checks.
  soundclaw list <project>
      The sounds, one line each: parameters, status, and the render's numbers (samples, peak, rms, hash).
  soundclaw history <project> [--sound <id>] [--by <author>] [--limit <n, default 50>]
      The history tape: command number, undo group, author, time, command; undone groups marked.
  soundclaw render <project> <id> [--json]
      Render a sound through the content-hash cache and print its numbers (duration, loudness,
      peaks, attack, tail, brightness, pitch, onsets), a plain-words description, and the check
      summary on the last line. --json: the same as one JSON object (class, numbers, checks, hash).
  soundclaw view <project> <id> wave|spec|pitch [--out <file.png>]
  soundclaw view <project> <id> layers [--out <file.png>]
  soundclaw view <project> <id> loop [--out <file.png>]
  soundclaw view <project> <set> set [--out <file.png>]
  soundclaw view <project> <id|file> compare <other|file> [--out <file.png>]
  soundclaw view <project> sample:<name>|hash:<sha256> wave|spec|pitch|loop|slices [--out <file.png>]
      The agent's ears as a PNG (saved under <project>/.cache/views, or --out) and the numbers:
      wave (waveform, envelope, clip marks), spec (mel spectrogram with Hz and note rulers),
      pitch (YIN track over a note grid), layers (a layered sound's layers stacked: waveform and
      spectrogram of each, with their start offsets), loop (a looping sound's end joined to its start,
      the two overlapped, the joined spectrogram, and the level across four repeats), set (a set's members side
      by side with loudness bars, and the pairwise distance matrix), compare (two spectrograms and their difference, with
      distance numbers; either side is a sound, a song's full mix, or the path of a WAV or OGG file outside the project:
      a reference to hold the work against; a WAV of any rate is resampled, OGG is read through ffmpeg when it is installed).
  soundclaw view <project> <song> notes|mix|wave|spec|loop [--from <s>] [--to <s>] [--channels a,b] [--out <file.png>]
      A song's ears: notes (each channel rendered alone: the written notes, the detected onsets and pitch,
      differences in red), mix (each channel's energy by band over time, overlaps in amber), wave and spec
      of the mix, loop (the loop's seam). Printed with the song's numbers: length, loop length, loudness,
      true peak, per-channel loudness, tempo; and the notes that differ, with times.
  soundclaw describe <project> <id|sample:<name>|hash:<sha256>> [--json]
      A plain-words summary built only from the measured numbers, then the numbers (--json: as a JSON object). A
      sample: its numbers (rate, bit depth, channels, noise floor, pitch with confidence, onsets, silence at the ends,
      runs at full scale), words for organic sound (tonal or noisy, steady or moving, one hit or several, dry or
      roomy, mono or wide), where it came from, its licence and the advisory checks.
  soundclaw compare <project> <a> <b> [--json]
      The distance numbers between two things, each a sound, a song, sample:<name>, hash:<sha256> or an audio file
      (view ... compare draws the picture too): a sampled version against a synth version of a sound.
  soundclaw measure <project> [<id|set|sample:<name>>...] [--json]
      The numbers and the loudness class of many sounds in ONE process (all sounds when none are named): per
      sound its class and target, every number describe prints and every check's result. --json prints one JSON
      document for scripts ({format, pass, sounds: [{id, class, numbers, checks, binding}], sets}); exit 1 when any
      check fails. A sound's loudness class: sound set <id> class=<name> (or loudness=<LUFS> for that sound alone).
  soundclaw normalize <project> <id|set>... [<class> | target=<LUFS>] [--by <author>]   (a song: normalize <project> <song> [target=<LUFS>] writes song set gain=)
      Write the gain (a layered sound's gain, a classic sound's volume) that brings sounds, or a set's members,
      to a loudness: each one's own class target (no argument), a class's target (the sounds join that class) or
      target=<LUFS> (the sounds are held to it). One undo group, the commands printed; a shortfall is a warning.
  soundclaw check <project> [<id|set>...] [--json]
      The checks (clip, loudness, dc, click, tail, harsh; for a set, set-spread: members not too alike
      and not too different, loudness within +-1 LU) with scores, thresholds and the exact time
      ranges flagged. A looping sound's click check looks at its seam. Exit 1 when any fails. Targets come from project.json "style":
      each sound is held to its loudness class (ui, foley, impact, ambience, voice, music-sting, standard: -16 LUFS +-1), true peak at
      most -0.1 dBTP. Says which class applied, and which rule binds when two checks pull against each other. --json as in measure.
  soundclaw import <project> sfxr|jsfxr|bfxr <file | "patch text"> [--id <id>] [--by <author>] [--classic] [--quiet]
      Make classic sounds from patches. sfxr: the engine's synth.csv (one per row; the key column is
      the id) or one single-patch text (a file or the text itself; --id names it); a jsfxr string is
      recognised here too. jsfxr: its base58 / sfxr.me URL-hash form or its JSON form. bfxr: Bfxr's
      comma-separated settings string. Several strings in one file: one per line, "<id> <string>".
      Each row is reported: exact, or approximated with what the classic voice could not keep
      (Bfxr's compression, harmonics, bit crush, its extra waves). One undo group. Warnings first, then a summary
      (exact rows are listed only for a few sounds); --quiet prints just the warnings and the summary line;
      --classic marks every imported sound classic (it stays one classic voice and exports as a synth.csv row).
  soundclaw sample import <project> <file | folder> [as=<name>] [licence=<id>] [attribution="<text>"] [terms=<url>] [tags=a,b] [source=<kind>] [origin="<where from>"] [note="<text>"] [--force]
  soundclaw sample list <project> ["<numbers query>"] [--json]
  soundclaw sample show <project> <name>
  soundclaw sample check <project> [<name>...]
  soundclaw sample derive <project> <new> from=<name> op="<operations>" [<field>=<value>...]
  soundclaw sample slice <project> <name> at=onsets|<t,t,...>|grid=<n> [sensitivity=<0-1>] [min-gap=<s>] [tempo=<bpm>]
  soundclaw sample loop <project> <name> find [near=<s>-<e>] [min=<s>]   |   sample loop <project> <name> <start> <end>
  soundclaw sample bounce <project> <new> from=<sound|song> [layer=<n>] [channel=<name>] [loop=yes]
  soundclaw sample add|set <project> <name> <field>=<value>...   |   sample rename <project> <name> <new>   |   sample remove <project> <name>
  soundclaw sample gc <project> [--apply] [--drop-history]
  soundclaw sample git-lfs
      Samples: audio kept once, by content, in <project>/samples/objects/, and named on the history tape
      (sample add <name> hash=...) with its provenance and licence. import reads WAV, AIFF/AIFF-C and FLAC
      itself, and OGG, MP3 and M4A through ffmpeg when it is installed; channels are kept (a layer plays the
      mix, side=left, side=right, or side=stereo); the root note, loop, one-shot flag and cue points a file
      carries are read and printed. A folder is one undo group. The name defaults to the file's name (case
      kept). The same audio under a second name adds the name, not a second copy. licence= is an SPDX id
      (CC0-1.0, CC-BY-4.0), own, unknown (the default), generated:<provider>:<plan> or proprietary:<note>; the
      tool never guesses one. Limits (600 s and 200 MB a file, 8-192 kHz, 1-8 channels, 120 s played, the
      store warns at 250 MB and refuses past 1 GB without --force) are printed when hit. set changes fields
      (root= tune= loop= loopmode= slices= tags= gain= note= licence= attribution= terms=; <field>=none
      clears; hash= with rate, channels, frames and format points the name at other audio, and undo brings
      the old audio back). remove is refused while a sound or instrument plays it. gc lists objects nothing
      on the tape names (--apply deletes them; --drop-history also those only undone or replaced states
      used, after listing the versions that then stop rendering). git-lfs prints .gitattributes lines.
      Editing is a command worked out once, when it runs, and written on the tape as plain numbers (a replay
      measures nothing). derive makes new audio from a sample by a chain separated by ;: trim <s> <e>, fade
      in=<t> out=<t>, gain <dB>, normalize peak <dBFS> | lufs <target>, silence-trim <dBFS>, dc, reverse,
      mono | left | right, pitch <semitones> [method=resample|stretch], stretch <ratio> | to=<s> | tempo=<a>:<b>
      [method=wsola|pv], loop <s> <e> xfade=<t>, slice <n>, mix <sample> at=<t> gain=<dB>; it keeps the parent's
      licence. slice stores slice points (measured onsets, given times or a grid); loop find settles loop points
      and prints the seam numbers of the best three; bounce renders a sound, a layer of it or a song into a
      sample. A numbers query (sample list "creak" dur=0.8-2.5 lufs>-30 centroid<2.5k pitched=no onsets=1
      tag=wood licence=shippable) keeps the samples it fits, closest first. check is advice: clipping, DC, silence
      at the ends, noise floor, loop seam, slice points off a transient; it never gates work done.
  soundclaw upgrade <project>
      Move a 0.1 project's samples/<name>.wav files into the store as one group by system:upgrade; renders are
      unchanged. Such files work without it.
  soundclaw library add <folder> [--name <id>] [licence=<id>] [attribution="<text>"] [terms=<url>] [--yes]
  soundclaw library list [--json]
  soundclaw library remove <id> [--yes]
  soundclaw library index [<id>...] [--rebuild] [--workers <n>]
  soundclaw library tag <id> <path> <tag>... [--remove]
  soundclaw library search ["<words>"] [<numbers query>] [--library <id>] [--limit <n>] [--project <project>] [--json]
  soundclaw library similar [<project>] <sound | sample:<name> | audio file> [<numbers query>] [--library <id>] [--limit <n>] [--project <project>] [--json]
  soundclaw library use <project> <library>:<path> [as=<name>] [licence=<id>] [attribution="<text>"] [tags=<a,b>] [--by <author>]
      Sample libraries: folders of recordings kept outside any project and registered for you (settings in
      ~/.soundclaw, or SOUNDCLAW_CONFIG_DIR; the index in the system's cache folder, or SOUNDCLAW_CACHE_DIR). add records the
      folder and its licence: licence= or --yes, or the folder's soundclaw-library.json ({"name", "description",
      "licence", "attribution", "terms"}); a LICENSE file that says CC0, an SPDX-License-Identifier or a Creative
      Commons title is shown and needs --yes, anything else leaves the licence unknown. index reads, hashes and
      measures every audio file once (worker threads; only files whose size or time changed again; --rebuild
      measures all); the numbers are those of sample list (length, loudness, pitch, centroid, attack, onsets, ...),
      plus the root and loop a file carries and tags from its folder and file names (split on separators, lower
      case, plurals folded) and those tag adds. search matches the words against names, tags and folders (all of
      them must match) and filters by the numbers query ("creak" dur=0.8-2.5 lufs>-30 centroid<2.5k pitched=no
      onsets=1 loop=no channels=1 tag=wood licence=shippable); hits come best word match first, then nearest the
      middle of the ranges, each with its library:path, length, loudness, note, centroid, attack, licence and a
      line of words. --project judges licence=shippable by that project's policy. similar ranks the files by
      distance in a feature vector (length, loudness, brightness, flatness, attack, pitch, hits per second, eight
      energy bands; docs/commands.md lists it) from a sound, a sample or a file (a file needs no project). remove
      forgets a library and its index; tags added by hand go with it, so then it needs --yes. use copies one file into the
      project's store (a tape command, one undo group) as source=library, origin <library>:<path>, with the
      library's licence; the library itself never enters the project.
  soundclaw licence check <project> [<id>...] [--allow-licence <id>]...
      Where sounds, sets, songs, instruments and samples stand on licences: shippable, attribution, unknown or
      blocked, and the samples behind each verdict. project.json "licences": {"allow": [...], "block": [...]} sets
      the policy; the default ships own, CC0-1.0, CC-BY-* and generated audio from a paid plan and blocks unknown,
      -NC, -ND and free-plan generated audio. SoundClaw records licences; it gives no legal advice.
  soundclaw export <project> [<id>...] [--all | --set <set>] [--format wav|ogg|patch|csv] [--to <dir>] [--pack] [--quality <q>] [--allow-licence <id>]...
      Default wav: 16-bit PCM, 44,100 Hz (classic sounds as pre-rendered WAVs, trunc(s*32000), mono;
      layered sounds through a limiter at the style's true-peak ceiling, mono or stereo). ogg: Vorbis,
      variable bitrate (--quality -0.1 to 1, default 0.4). With --all, --set, --pack or ogg, manifest.json
      is written beside the files: id, file, duration, loudness, channels, loop points, set. patch: <id>.sfxr single-patch
      text; csv: one synth.csv. Without ids (or with --all), every sound; --set exports a set's members.
      --pack: a flat folder where sounds marked classic become rows of one synth.csv instead of
      audio files. --to (or --out) names the folder (default <project>/exports/). A manifest export (--all,
      --set, --pack) lists the samples used and writes ATTRIBUTION.txt when a licence asks for it, and refuses a
      sound that reaches an unknown or blocked licence unless --allow-licence <id> lets it through (written into
      the manifest); a single-file export warns.
  soundclaw export <project> <song>... [--format wav|ogg|midi] [--loop] [--stems [--stems-through-master]] [--loops <n>] [--pattern <name>] [--to <dir>] [--quality <q>]
      A song as one file (intro, body once, ending; --loops repeats the loop region), --loop its loop region
      (seamless: the tail of the loop wraps into its start; with --loops <n> the region n times over), --stems one
      aligned file per game layer (the stems of the loop when the song loops; before the master chain, so they sum
      to the mix when the chain does not turn the mix down; --loops repeats them too). --stems-through-master runs
      the master chain's filters over each stem so a tone shaping there reaches the stems; its compressor and
      limiter cannot be split among stems, so the stems then sum to the mix as the filters leave it, louder than
      the exported mix and not limited (the command says what was and was not applied). Or midi (the song, or
      --pattern one pattern). Combinations that mean nothing (--loops with no loop region, --pattern with audio,
      --quality with wav, --loop or --stems with midi, song flags on a sound) are refused. A <song>-manifest.json
      says the loop points.
  soundclaw midi import <project> <file.mid> [--id <song>] [--by <author>]
  soundclaw midi export <project> <song> [--pattern <name>] [--to <dir>]
      Import a Standard MIDI file (type 0 or 1) as a song: one pattern per two bars, a channel per track and MIDI channel,
      drums on channel 10 as a drum channel; timings go to the nearest step. Export: the song or one pattern as type 1.
  soundclaw changes <project> [--since <command number | time>] [--by human|agent|<author>] [--as <agent>] [--peek]
      What other hands changed since this agent last looked (a cursor kept per agent in the
      project): each history group with the parameters before and after, the numbers before and
      after (duration, loudness, centroid, pitch) and a before/after compare view saved as a PNG.
      Without --by: everyone but the agent itself; --by human: people only. Reading moves the
      cursor (not with --since or --peek). Never undo a person's edit silently.
  soundclaw request <project> [<id> --note "<what should change>"] [--tag <tag>]... [--like <sound>] [--target "<where>"] [--again <request>] [--by <author>]
      Ask for a change on a sound, as the dashboard's Ask for changes does (also writes
      sound mark <id> rejected "<note>" on the history). --tag adds the quick tags of the cards
      (too loud, too quiet, too long, too short, too harsh, too dull, too similar to another
      sound, good; with --like naming the other sound); a note may then be left out, and the tag
      good alone is praise (no mark). Without an id, lists the requests still
      open, claimed or blocked (open ones say seen by <agent> once an agent has been handed them),
      the dashboard's blind A/B answers among them as comparisons (which side fits better in the moment,
      each side a sound as at a tape number, with the gain that matched its level).
      --target pins the request inside the item, as a selection in the dashboard does:
      "range 0.31-0.38" (seconds of a sound), "bars 9-12 lead" (bars of a song, then a channel if
      you mean one), "param decay [layer 2] [fx 1]", "layer 2" or "item". The listing, await and the
      brief print it in words (pinned to 0.31–0.38 s, bars 9–12 of lead, parameter decay).
      --again names a done request this one asks again about.
      --by is human:<name> (default human:cli).
  soundclaw reply <project> <request> "<answer>" [--by <author>]      answer a blocked request (it opens again)
  soundclaw cancel <project> <request> ["<why>"] [--by <author>]       withdraw a request
  soundclaw work <project> list | claim [<request>] | progress [<request>] "<note>" | block [<request>] "<question>" | done [<request>] "<what changed>" [--by <agent>]
      An agent's side of the request queue, for a session without SoundClaw's MCP tools (the MCP
      work tool does the same): list hands over the open requests (the cards say seen by
      <agent>), claim takes the next open one or <request> and prints what is asked, progress
      posts a note the person sees, block stops it with one clear question, done finishes it
      with what changed. After claim the id may be left out. Any error applies nothing. --by
      names the agent (default agent:claude). With a server running these go through it, so the
      dashboard's cards move live and the agent shows as listening.
  soundclaw scale <key> | list | <project> <song>
      A key's notes (D:major, A:dorian, E:phrygian-dominant) and, for a seven-note scale, the triad and seventh on
      each degree with its roman numeral, as chords, bass, arp and motif sequence read them; list: every scale
      with what it sounds like; a song: its key.
  soundclaw style <project> [--init]
      The project's music style guide (music-style.md: tempo range, key, scales, instrument palette, loudness
      classes, forbid: drums in town, ## <tag> sections) and music bible (music-bible.md: a ## <entry> per track
      with mood, tempo, key, tags, instruments, motif) as SoundClaw reads them, with the lines it cannot read.
      The style check holds songs to them. --init writes a starter pair when the project has neither.
  soundclaw skill install [--dest <dir> | --project <dir>]
      Install the Claude Code skill into ~/.claude/skills/soundclaw (or <dir>/.claude/skills/soundclaw).
      skill path prints where it is.
  soundclaw await <project-folder | watch-url> [--timeout <seconds>, default 600] [--since <cursor>] [--as <name>] [--json]
      Wait on the running server for what people ask in the dashboard (a request, a blind A/B
      comparison, a reply, a withdrawn request, or an approval or rejection mark), print the events with their next
      step (work claims a request; history reads a mark) and a cursor, then EXIT. Run it in the
      background and restart it with --since <cursor> after each exit: its exit is what wakes an
      agent. Exit 0 with events, 3 on timeout, 1 if no server can be reached. Requests handed
      over are recorded as seen by --as (default agent:claude). Works with serve --no-mcp.
  soundclaw serve --project <project> [--port 7427] [--no-mcp]
      Own the project: MCP on stdin/stdout for the agent, and the live dashboard on
      http://127.0.0.1:<port>/?token=... (printed to stderr). Creates the project if needed.

While a server runs (soundclaw serve): commands that write (run, export, request, reply, cancel,
work, import) are sent to it over HTTP, found through the project's lock and a token file only you can
read, so they go through its writer and a connected dashboard updates live. Read-only commands
read the files. If the server cannot be reached the command runs directly.

Command reference: docs/commands.md
`;

export class UsageError extends Error {}

/** The usage blocks of one command (a command may have several), or null when there is no such command. */
export function commandHelp(cmd: string): string | null {
  const blocks: string[][] = [];
  let cur: string[] | null = null;
  for (const line of USAGE.split('\n')) {
    const m = /^  soundclaw (\S+)/.exec(line);
    if (m) {
      cur = m[1] === cmd ? [] : null;
      if (cur) blocks.push(cur);
    }
    if (cur && (m || line.startsWith('  '))) cur.push(line);
    else if (!line.startsWith('  ')) cur = null;
  }
  if (!blocks.length) return null;
  return `${blocks.map((b) => b.join('\n')).join('\n')}\n\nAll commands: soundclaw --help. The command language: docs/commands.md\n`;
}

/** `--version`, `help <command>` and `<command> --help`: answered without touching a project. Null when argv is none of them. */
export function metaCommand(argv: string[], io: Pick<Io, 'out' | 'err'>): number | null {
  const [cmd, ...rest] = argv;
  if (cmd === '--version' || cmd === '-V' || cmd === 'version') {
    io.out(`soundclaw ${soundclawVersion()}\n`);
    return 0;
  }
  const target = cmd === 'help' ? rest[0] : rest.some((a) => a === '--help' || a === '-h') ? cmd : undefined;
  if (target === undefined) return null;
  const h = commandHelp(target);
  if (!h) throw new UsageError(`unknown command '${target}'`);
  io.out(h);
  return 0;
}

export interface Parsed {
  pos: string[];
  flags: Map<string, string[]>;
}

export function parseArgs(argv: string[], valued: string[], bare: string[]): Parsed {
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('-') && a !== '-') {
      const name = a.replace(/^--?/, '');
      if (valued.includes(name)) {
        const v = argv[++i];
        if (v === undefined) throw new UsageError(`${a} needs a value`);
        flags.set(name, [...(flags.get(name) ?? []), v]);
      } else if (bare.includes(name)) flags.set(name, ['']);
      else throw new UsageError(`unknown option ${a}`);
    } else pos.push(a);
  }
  return { pos, flags };
}

export const one = (p: Parsed, k: string): string | undefined => p.flags.get(k)?.at(-1);

/** The options of the commands that write (valued, bare): the CLI uses them to send a command to a running server. */
export const WRITE_OPTS: Record<string, [string[], string[]]> = {
  run: [['by', 'e', 'source'], []],
  export: [['out', 'to', 'format', 'set', 'quality', 'loops', 'pattern', 'allow-licence'], ['all', 'pack', 'loop', 'stems', 'stems-through-master']],
  midi: [['id', 'by', 'pattern', 'to', 'out'], []],
  import: [['id', 'by'], ['quiet', 'classic']],
  normalize: [['by'], []],
  sample: [['as', 'by', 'licence', 'license', 'attribution', 'terms', 'tags', 'source', 'origin', 'note'], ['force', 'apply', 'drop-history', 'json']],
  upgrade: [['by'], []],
  request: [['note', 'by', 'tag', 'like', 'target', 'again'], []],
  reply: [['by'], []],
  cancel: [['by'], []],
  work: [['by'], []],
  library: [['name', 'licence', 'license', 'attribution', 'terms', 'library', 'limit', 'workers', 'project', 'by', 'as', 'tags', 'note'], ['json', 'yes', 'rebuild', 'remove', 'force']],
};

/** `soundclaw work <project> <action>`: the MCP work tool's actions, for an agent with no MCP. */
export const WORK_ACTIONS = ['list', 'claim', 'progress', 'block', 'done'];

export const WORK_USAGE = 'work <project> (list | claim [<request>] | progress [<request>] "<note>" | block [<request>] "<question>" | done [<request>] "<what changed>") [--by <agent>]';

/** The writer a command writes through: the server's own when it was sent to one, else a new one on the folder. */
function wr(io: Io, dir: string): Writer {
  return io.writer ?? new Writer(loadProject(dir), { now: io.now });
}

/** A running server is the single writer for its project; the CLI does not write behind its back. */
function assertNoServer(dir: string, io: Io): void {
  if (io.writer) return;
  const held = lockHolder(loadProject(dir).dir);
  if (held) throw new ProjectError(`a soundclaw server (pid ${held.pid}) owns ${dir} and the command could not be sent to it (its token file must be readable by you); send commands through it (MCP: run, export, request; or its dashboard), or stop it first`);
}

/** An author for `--by`: `agent:<name>` or `human:<name>`; a bare name is taken as `agent:<name>`. */
function author(p: Parsed, fallback: string, bare: (n: string) => string): string {
  const by = one(p, 'by');
  if (by === undefined) return fallback;
  const full = by.includes(':') ? by : bare(by);
  if (!AUTHOR_RE.test(full)) throw new UsageError(`--by is agent:<name> or human:<name> (letters, digits, . _ -), not '${by}'`);
  return full;
}

function cmdNew(io: Io, p: Parsed): number {
  const [dir, ...extra] = p.pos;
  if (!dir) throw new UsageError('new: give a project folder');
  if (extra.length) throw new UsageError(`new: unexpected argument '${extra[0]}'`);
  const proj: Project = createProject(dir, { name: one(p, 'name') });
  io.out(`created project '${proj.json.name}' at ${dir}\n  sounds/ instruments/ songs/ sets/  history.jsonl  requests.jsonl  exports/ (ignored by git)\n`);
  return 0;
}

function cmdRun(io: Io, p: Parsed): number {
  const [dir, script, ...extra] = p.pos;
  if (!dir) throw new UsageError('run: give a project folder');
  if (extra.length) throw new UsageError(`run: unexpected argument '${extra[0]}'`);
  let text: string;
  let source: string;
  const inline = one(p, 'e');
  if (inline !== undefined) {
    if (script) throw new UsageError('run: give a script or -e, not both');
    text = inline;
    source = one(p, 'source') ?? '<-e>';
  } else if (script === '-') {
    text = io.stdin();
    source = '<stdin>';
  } else if (script) {
    if (!existsSync(script)) throw new UsageError(`run: no such script ${script}`);
    text = readFileSync(script, 'utf8');
    source = script;
  } else throw new UsageError('run: give a script file, - for standard input, or -e "<commands>"');
  assertNoServer(dir, io);
  const w = wr(io, dir);
  const r = w.run({ commands: text, by: author(p, 'agent:claude', (n) => `agent:${n}`) });
  if (!r.ok) {
    io.err(formatErrors(source, r.errors) + '\n');
    return 1;
  }
  io.out(formatRun(r, (id) => soundSummary(w, id), (id) => setSummary(w, id), (id) => songSummary(w, id)) + '\n');
  return 0;
}

function cmdList(io: Io, p: Parsed): number {
  const [dir, ...extra] = p.pos;
  if (!dir || extra.length) throw new UsageError('list: give a project folder');
  const w = wr(io, dir);
  const sounds = w.sounds();
  const sets = w.sets();
  const songs = w.songs();
  const insts = w.instruments();
  const musicText = (songs.length ? `${plural(songs.length, 'song')}:\n${songs.map((x) => `  ${songSummary(w, x.id)}\n`).join('')}` : '') + (insts.length ? `${plural(insts.length, 'instrument')}: ${insts.map((i) => i.id).join(', ')}\n` : '');
  io.out(musicText + (sounds.length ? `${plural(sounds.length, 'sound')}:\n${sounds.map((s) => `  ${soundSummary(w, s.id)}\n`).join('')}` : 'no sounds yet\n') + (sets.length ? `${plural(sets.length, 'set')}:\n${sets.map((x) => `  ${setSummary(w, x.id)}\n`).join('')}` : ''));
  return 0;
}

function cmdHistory(io: Io, p: Parsed): number {
  const [dir, ...extra] = p.pos;
  if (!dir || extra.length) throw new UsageError('history: give a project folder');
  const limit = one(p, 'limit') === undefined ? 50 : Number(one(p, 'limit'));
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit is a whole number from 1');
  const by = one(p, 'by');
  if (by !== undefined && !AUTHOR_RE.test(by)) throw new UsageError('--by is agent:<name> or human:<name>');
  io.out(historyText(wr(io, dir), { sound: one(p, 'sound'), by, limit }) + '\n');
  return 0;
}

function cmdRender(io: Io, p: Parsed): number {
  const [dir, id, ...extra] = p.pos;
  if (!dir || !id || extra.length) throw new UsageError('render: give a project folder and a sound id');
  const w = wr(io, dir);
  if (w.hasSong(id)) {
    io.out((p.flags.has('json') ? JSON.stringify(songJsonObject(w, id, { hashes: true }), null, 2) : `${songNumbersText(w, id)}\n${songSummary(w, id).split('\n').slice(1).join('\n')}`) + '\n');
    return 0;
  }
  const r = w.render(id); // first, so the line below does not warm the cache
  if (p.flags.has('json')) {
    io.out(describeJson(w, id, { renderKey: r.key, cached: r.cached, samplesHash: w.samplesHashOf(id) }) + '\n');
    return 0;
  }
  const head = soundSummary(w, id).split('\n')[0]!;
  io.out(`${renderText(w, id, `${head}\nrender key ${r.key.slice(0, 12)}${r.cached ? ' (from the render cache)' : ''}`)}\n`);
  return 0;
}

function cmdView(io: Io, p: Parsed): number {
  const [dir, id, kind, other, ...extra] = p.pos;
  if (!dir || !id || !kind) throw new UsageError('view: give a project folder, a sound id and wave, spec, pitch or compare <other>');
  if (wr(io, dir).hasSong(id) && kind !== 'compare') {
    if (!(SONG_VIEWS as readonly string[]).includes(kind)) throw new UsageError(`view: a song has the views ${SONG_VIEWS.join(', ')} (not '${kind}')`);
    if (other !== undefined || extra.length) throw new UsageError(`view ${kind}: unexpected '${other}'`);
    const num = (k: string): number | undefined => { const v = one(p, k); if (v === undefined) return undefined; const n = Number(v); if (!(n >= 0)) throw new UsageError(`--${k} is a time in seconds`); return n; };
    const v = viewSong(wr(io, dir), id, kind as SongViewKind, { from: num('from'), to: num('to'), channels: one(p, 'channels')?.split(',').filter(Boolean), out: one(p, 'out') });
    io.out(v.text + '\n');
    return 0;
  }
  if (isSampleRef(id) && kind !== 'compare') {
    if (!(SAMPLE_VIEWS as readonly string[]).includes(kind)) throw new UsageError(`view: a sample has the views ${SAMPLE_VIEWS.join(', ')}, and compare <other> (not '${kind}')`);
    if (other !== undefined) throw new UsageError(`view ${kind}: unexpected '${other}'`);
    io.out(sampleView(wr(io, dir), id, kind, one(p, 'out')).text + '\n');
    return 0;
  }
  if (!['wave', 'spec', 'pitch', 'layers', 'loop', 'set', 'compare'].includes(kind)) throw new UsageError(`view: no view '${kind}' (wave, spec, pitch, layers, loop, set, compare)`);
  if (kind === 'compare' ? !other || extra.length : other !== undefined) throw new UsageError(kind === 'compare' ? 'view compare: give the other sound, song or audio file' : `view ${kind}: unexpected '${other}'`);
  const v = viewSound(wr(io, dir), id, kind as ViewKind | 'compare' | 'layers' | 'loop' | 'set', { other, out: one(p, 'out') });
  io.out(v.text + '\n');
  return 0;
}

/** `key=value` words after a command's positional arguments. */
function pairsFrom(words: string[], what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of words) {
    const m = /^([A-Za-z][A-Za-z-]*)=(.*)$/s.exec(e);
    if (!m) throw new UsageError(`${what}: unexpected '${e}' (<field>=<value>)`);
    out[m[1] === 'license' ? 'licence' : m[1]!] = m[2]!;
  }
  return out;
}

/** The sample tape verbs, as the command language writes them (a value with spaces in quotes). */
const wordOf = (v: string): string => (/^[^\s"\;]+$/.test(v) ? v : `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);

/** `sample import|list|show|add|set|rename|remove|gc|git-lfs`. */
function cmdSample(io: Io, p: Parsed): number {
  const [verb, dir, ...rest] = p.pos;
  if (verb === 'git-lfs') { io.out(gitLfsLines()); return 0; }
  if (!verb || !['import', 'list', 'show', 'add', 'set', 'rename', 'remove', 'gc', 'derive', 'bounce', 'slice', 'loop', 'check'].includes(verb)) throw new UsageError('sample: import | list | show | check | add | set | rename | remove | derive | bounce | slice | loop | gc | git-lfs (sample import <project> <file or folder>)');
  if (!dir) throw new UsageError(`sample ${verb}: give a project folder`);
  if (verb === 'list') {
    if (rest.length > 1) throw new UsageError('sample list: sample list <project> ["<numbers query>"] [--json]');
    io.out(sampleListText(wr(io, dir), rest[0], { json: p.flags.has('json') }));
    return 0;
  }
  if (verb === 'check') {
    io.out(sampleCheckText(wr(io, dir), rest) + '\n');
    return 0;
  }
  if (verb === 'show') {
    if (rest.length !== 1) throw new UsageError('sample show: give a project folder and a sample name');
    io.out(sampleShowText(wr(io, dir), rest[0]!));
    return 0;
  }
  if (verb === 'gc') {
    if (rest.length) throw new UsageError(`sample gc: unexpected '${rest[0]}'`);
    if (p.flags.has('apply')) assertNoServer(dir, io);
    const w = wr(io, dir);
    const plan = gcPlan(w, p.flags.has('drop-history'));
    if (p.flags.has('apply')) gcApply(w, plan);
    io.out(gcReport(plan, p.flags.has('apply')));
    return 0;
  }
  const by = author(p, 'agent:claude', (n) => `agent:${n}`);
  if (verb === 'add' || verb === 'set' || verb === 'rename' || verb === 'remove' || verb === 'derive' || verb === 'bounce' || verb === 'slice' || verb === 'loop') {
    const [name, ...more] = rest;
    if (!name) throw new UsageError(`sample ${verb}: give a sample name`);
    const text = verb === 'rename' || verb === 'remove' || verb === 'loop' ? `sample ${verb} ${[name, ...more.map(wordOf)].join(' ')}` : `sample ${verb} ${name}${Object.entries(pairsFrom(more, `sample ${verb}`)).map(([k, v]) => ` ${k}=${wordOf(v)}`).join('')}`;
    assertNoServer(dir, io);
    const w = wr(io, dir);
    const r = w.run({ commands: text, by });
    if (!r.ok) { io.err(formatErrors('<sample>', r.errors) + '\n'); return 1; }
    io.out(`${r.added.map((a) => a.cmd).join('\n')} (group ${r.group})\n`);
    return 0;
  }
  // import
  const [file, ...extra] = rest;
  if (!file) throw new UsageError('sample import: give a file or folder');
  const kv = pairsFrom(extra, 'sample import');
  for (const k of Object.keys(kv)) if (!['as', 'licence', 'attribution', 'terms', 'tags', 'source', 'origin', 'note'].includes(k)) throw new UsageError(`sample import: no field '${k}' (as, licence, attribution, terms, tags, source, origin, note)`);
  const pick = (k: string): string | undefined => kv[k] ?? one(p, k);
  const licence = pick('licence') ?? one(p, 'license');
  const opts = {
    ...(pick('as') ? { as: pick('as')! } : {}), ...(licence ? { licence } : {}), ...(pick('attribution') ? { attribution: pick('attribution')! } : {}), ...(pick('terms') ? { terms: pick('terms')! } : {}),
    ...(pick('tags') ? { tags: pick('tags')! } : {}), ...(pick('source') ? { source: pick('source') as 'file' } : {}), ...(pick('origin') ? { origin: pick('origin')! } : {}), ...(pick('note') ? { note: pick('note')! } : {}),
    force: p.flags.has('force'), by,
  };
  assertNoServer(dir, io);
  const w = wr(io, dir);
  const r = importPath(w, file, opts);
  const one1 = r.items.length === 1 ? r.items[0]!.info.name : null;
  io.out(`${importReport(r, sampleLine)}\n${plural(r.items.length, 'sample')}${r.group ? ` as group ${r.group}` : ''}${one1 ? `\nuse it: layer add <sound> sample sample=${one1} [start=<s>] [end=<s>] [pitch=<semitones>] [reverse=1] [side=mix|left|right|stereo]` : ''}\n`);
  return r.items.length ? 0 : 1;
}

/** `library add|list|remove|tag|search|similar|use` (`index` runs in entry.ts: it uses worker threads). */
function cmdLibrary(io: Io, p: Parsed): number {
  const [verb, ...rest] = p.pos;
  const verbs = 'add | list | remove | index | tag | search | similar | use';
  if (!verb || !verbs.split(' | ').includes(verb)) throw new UsageError(`library: ${verbs}`);
  const int = (k: string, def: number, max: number): number => {
    const v = one(p, k);
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new UsageError(`--${k} is a whole number from 1 to ${max}`);
    return n;
  };
  const only = (kv: Record<string, string>, allowed: string[], what: string): void => {
    for (const k of Object.keys(kv)) if (!allowed.includes(k)) throw new UsageError(`${what}: no field '${k}' (${allowed.join(', ')})`);
  };
  if (verb === 'index') throw new UsageError('library index runs from the soundclaw command itself (it measures files on worker threads): soundclaw library index [<id>...]');
  if (verb === 'list') {
    if (rest.length) throw new UsageError(`library list: unexpected '${rest[0]}'`);
    const libs = listLibraries();
    io.out(p.flags.has('json') ? JSON.stringify(libs, null, 1) + '\n' : listText(libs));
    return 0;
  }
  if (verb === 'remove') {
    if (rest.length !== 1) throw new UsageError('library remove: give a library id');
    const dropped = removeLibrary(rest[0]!, { yes: p.flags.has('yes') });
    io.out(`removed library ${rest[0]} from the list (its folder and the files in it are untouched)${dropped ? `; dropped the tags added by hand on ${plural(dropped, 'file')}` : ''}\n`);
    return 0;
  }
  if (verb === 'add') {
    const [dir, ...more] = rest;
    if (!dir) throw new UsageError('library add: give a folder');
    const kv = pairsFrom(more, 'library add');
    only(kv, ['licence', 'attribution', 'terms', 'name'], 'library add');
    const pick = (k: string): string | undefined => kv[k] ?? one(p, k) ?? (k === 'licence' ? one(p, 'license') : undefined);
    const r = addLibrary(dir, { name: pick('name'), licence: pick('licence'), attribution: pick('attribution'), terms: pick('terms'), yes: p.flags.has('yes') });
    io.out(`added library '${r.entry.id}' (${r.entry.dir})\n${r.notes.map((n) => `  ${n}\n`).join('')}next: soundclaw library index ${r.entry.id}\n`);
    return 0;
  }
  if (verb === 'tag') {
    const [id, path, ...tags] = rest;
    if (!id || !path || !tags.length) throw new UsageError('library tag: library tag <id> <path> <tag>... [--remove]');
    const now = tagFile(id, path, tags.flatMap((t) => t.split(',')), p.flags.has('remove'));
    io.out(`${id}:${path} tags: ${now.length ? now.join(', ') : 'none'}\n`);
    return 0;
  }
  const policyOf = (dir?: string) => (dir ? shipPolicyOf(loadProject(dir).json.licences) : undefined);
  if (verb === 'search') {
    const policy = policyOf(one(p, 'project'));
    const r = searchLibraries(rest.join(' '), { library: one(p, 'library'), limit: int('limit', 20, 500), ...(policy ? { policy } : {}) });
    const state = policy ? stateUnder(policy) : undefined;
    io.out(p.flags.has('json') ? JSON.stringify(r.hits.map((h) => hitJson(h, state)), null, 1) + '\n' : searchText(r, state) + '\n');
    return 0;
  }
  if (verb === 'similar') {
    // with a project first: a sound, sample:<name> or a file, judged by that project's policy; without one: an audio file
    const isProject = (d: string | undefined): boolean => !!d && existsSync(join(d, 'project.json'));
    const [first, second, ...more] = rest;
    if (isProject(first)) {
      if (!second) throw new UsageError('library similar: library similar [<project>] <sound | sample:<name> | audio file> [<numbers query>]');
      const w = wr(io, first!);
      const policy = w.samples.shipPolicy;
      const r = similarLibraries(w, second, more.join(' '), { library: one(p, 'library'), limit: int('limit', 10, 500), policy });
      const state = stateUnder(policy);
      io.out(p.flags.has('json') ? JSON.stringify(r.hits.map((h) => hitJson(h, state)), null, 1) + '\n' : `like ${r.reference}:\n${searchText(r, state)}\n`);
      return 0;
    }
    if (!first) throw new UsageError('library similar: library similar [<project>] <sound | sample:<name> | audio file> [<numbers query>]');
    if (!existsSync(first) || !statSync(first).isFile()) throw new UsageError(`library similar: '${first}' is neither a project folder nor an audio file (a sound or sample:<name> needs its project first)`);
    const policy = policyOf(one(p, 'project'));
    const r = similarLibraries(null, first, [second, ...more].filter((x) => x !== undefined).join(' '), { library: one(p, 'library'), limit: int('limit', 10, 500), ...(policy ? { policy } : {}) });
    const state = policy ? stateUnder(policy) : undefined;
    io.out(p.flags.has('json') ? JSON.stringify(r.hits.map((h) => hitJson(h, state)), null, 1) + '\n' : `like ${r.reference}:\n${searchText(r, state)}\n`);
    return 0;
  }
  // use
  const [dir, ref, ...more] = rest;
  if (!dir || !ref) throw new UsageError('library use: library use <project> <library>:<path> [as=<name>] [licence=<id>] ...');
  const kv = pairsFrom(more, 'library use');
  only(kv, ['as', 'licence', 'attribution', 'terms', 'tags', 'note'], 'library use');
  const pick = (k: string): string | undefined => kv[k] ?? one(p, k) ?? (k === 'licence' ? one(p, 'license') : undefined);
  assertNoServer(dir, io);
  const w = wr(io, dir);
  const r = useLibraryFile(w, ref, {
    ...(pick('as') ? { as: pick('as')! } : {}), ...(pick('licence') ? { licence: pick('licence')! } : {}), ...(pick('attribution') ? { attribution: pick('attribution')! } : {}),
    ...(pick('terms') ? { terms: pick('terms')! } : {}), ...(pick('tags') ? { tags: pick('tags')! } : {}), ...(pick('note') ? { note: pick('note')! } : {}),
    force: p.flags.has('force'), by: author(p, 'agent:claude', (n) => `agent:${n}`),
  });
  const name = r.items[0]?.info.name;
  io.out(`${importReport(r, sampleLine)}\n${plural(r.items.length, 'sample')}${r.group ? ` as group ${r.group}` : ''}${name ? `\nuse it: layer add <sound> sample sample=${name} [start=<s>] [end=<s>] [pitch=<semitones>] [side=mix|left|right|stereo]` : ''}\n`);
  return r.items.length ? 0 : 1;
}

function cmdUpgrade(io: Io, p: Parsed): number {
  const [dir, ...extra] = p.pos;
  if (!dir || extra.length) throw new UsageError('upgrade: give a project folder');
  assertNoServer(dir, io);
  const w = wr(io, dir);
  const r = upgradeProject(w);
  io.out(`${r.moved.length ? `moved ${plural(r.moved.length, 'sample')} into the store (${r.moved.join(', ')}) as group ${r.group} by system:upgrade` : 'nothing to upgrade: no 0.1 sample files'}\n${r.skipped.map((x) => `warning: ${x}\n`).join('')}`);
  return 0;
}

function cmdLicence(io: Io, p: Parsed): number {
  const [verb, dir, ...ids] = p.pos;
  if (verb !== 'check' || !dir) throw new UsageError('licence: licence check <project> [<id>...] [--allow-licence <id>]...');
  const w = wr(io, dir);
  io.out(licenceReportText(licenceCheck(w, ids, p.flags.get('allow-licence') ?? []), licencePolicyNote(w)));
  return 0;
}

/** `compare <project> <a> <b>`: the distance numbers between two sounds, songs, samples or audio files. */
function cmdCompare(io: Io, p: Parsed): number {
  const [dir, a, b, ...extra] = p.pos;
  if (!dir || !a || !b || extra.length) throw new UsageError('compare: give a project folder and two things: a sound, song, sample:<name>, hash:<sha256> or an audio file');
  const r = compareText(wr(io, dir), a, b);
  io.out((p.flags.has('json') ? JSON.stringify(r.json, null, 2) : r.text) + '\n');
  return 0;
}

function cmdDescribe(io: Io, p: Parsed): number {
  const [dir, id, ...extra] = p.pos;
  if (!dir || !id || extra.length) throw new UsageError('describe: give a project folder and a sound id');
  const w = wr(io, dir);
  if (w.hasSong(id)) { io.out((p.flags.has('json') ? JSON.stringify(songJsonObject(w, id), null, 2) : songNumbersText(w, id)) + '\n'); return 0; }
  io.out((p.flags.has('json') ? describeJson(w, id) : describeText(w, id)) + '\n');
  return 0;
}

/** `measure`: numbers, class and checks of many sounds in one process. */
function cmdMeasure(io: Io, p: Parsed): number {
  let [dir, ...ids] = p.pos;
  if (!dir) throw new UsageError('measure: give a project folder');
  const w = wr(io, dir);
  const refs = ids.filter(isSampleRef);
  ids = ids.filter((x) => !isSampleRef(x));
  const songIds = ids.length ? ids.filter((x) => w.hasSong(x)) : refs.length ? [] : w.songs().map((x) => x.id);
  const soundIds = ids.filter((x) => !w.hasSong(x));
  const only = refs.length > 0 && !ids.length ? true : (ids.length > 0 && !soundIds.length) || (ids.length === 0 && !w.sounds().length && !w.sets().length && songIds.length > 0);
  if (p.flags.has('json')) {
    const r = only ? { json: '{}', pass: true } : measureJson(w, soundIds);
    const doc = JSON.parse(r.json) as Record<string, unknown>;
    const objs = songIds.map((x) => songJsonObject(w, x) as { pass?: boolean });
    if (songIds.length) doc.songs = objs;
    if (refs.length) doc.samples = refs.map((x) => sampleMeasureJson(w, x));
    io.out(JSON.stringify(doc, null, 2) + '\n');
    return r.pass && objs.every((o) => o.pass !== false) ? 0 : 1;
  }
  const r = only ? { text: '', pass: true } : measureText(w, soundIds);
  const songTexts = songIds.map((x) => `${songNumbersText(w, x)}\n${songChecksText(w, x).text}`);
  io.out([r.text, ...songTexts, ...refs.map((x) => sampleDescribeText(w, x))].filter(Boolean).join('\n\n') + '\n');
  return r.pass && songIds.every((x) => songChecksText(w, x).pass) ? 0 : 1;
}

/** `normalize`: the gain commands that bring sounds, a set or a song to a loudness, run as one undo group. */
function cmdNormalize(io: Io, p: Parsed): number {
  const [dir, ...rest] = p.pos;
  if (!dir || !rest.length) throw new UsageError('normalize: soundclaw normalize <project> <id|set|song>... [<class> | target=<LUFS>]');
  assertNoServer(dir, io);
  const w = wr(io, dir);
  const n = normalizePlan(w, rest);
  const warn = n.notes.map((x) => `warning: ${x}\n`).join('');
  if (!n.commands) {
    io.out(`${n.already}: nothing to write\n${n.info ? n.info + '\n' : ''}${warn}`);
    return 0;
  }
  const r = w.run({ commands: n.commands, by: author(p, 'agent:claude', (x) => `agent:${x}`) });
  if (!r.ok) {
    io.err(formatErrors('normalize', r.errors) + '\n');
    return 1;
  }
  const song = rest[0] !== undefined && w.hasSong(rest[0]) ? `${songSummary(w, rest[0])}\n` : '';
  io.out(`${n.info ? n.info + '\n' : ''}${warn}normalized ${n.what} as group ${r.group}\n${r.added.map((e) => `  #${e.seq} ${e.cmd}\n`).join('')}${song}`);
  return 0;
}

function cmdCheck(io: Io, p: Parsed): number {
  const [dir, ...ids] = p.pos;
  if (!dir) throw new UsageError('check: give a project folder');
  const w = wr(io, dir);
  const songIds = ids.length ? ids.filter((x) => w.hasSong(x)) : w.songs().map((x) => x.id);
  const soundIds = ids.filter((x) => !w.hasSong(x));
  const only = (ids.length > 0 && !soundIds.length) || (ids.length === 0 && !w.sounds().length && !w.sets().length && songIds.length > 0);
  if (p.flags.has('json')) {
    const j = only ? { json: '{}', pass: true } : measureJson(w, soundIds);
    const doc = JSON.parse(j.json) as Record<string, unknown>;
    const objs = songIds.map((x) => songJsonObject(w, x) as { pass?: boolean });
    if (songIds.length) doc.songs = objs;
    io.out(JSON.stringify(doc, null, 2) + '\n');
    return j.pass && objs.every((o) => o.pass !== false) ? 0 : 1;
  }
  const r = only ? { text: '', pass: true } : checkText(w, soundIds);
  const results = songIds.map((x) => songChecksText(w, x));
  io.out([r.text, ...results.map((x) => x.text)].filter(Boolean).join('\n\n') + '\n');
  return r.pass && results.every((x) => x.pass) ? 0 : 1;
}

function cmdScale(io: Io, p: Parsed): number {
  const [a, b, ...extra] = p.pos;
  if (!a) throw new UsageError('scale: give a key like D:major, list, or <project> <song>');
  if (extra.length) throw new UsageError(`scale: unexpected argument '${extra[0]}'`);
  let key = a;
  if (b !== undefined) {
    const w = wr(io, a);
    const k = w.song(b).key;
    if (!k) throw new ProjectError(`${b} has no key (song set ${b} key=D:major)`);
    key = k;
  }
  try { io.out(scaleText(key) + '\n'); } catch (e) { throw new UsageError((e as Error).message); }
  return 0;
}

const STARTER_STYLE = `# Music style

Small chip and synth music: short loops, clear tunes, nothing busy. Prose like this is for people;
the \`key: value\` lines are what the style check reads.

tempo: 70-150
key: C:major
scales: major, minor, dorian, mixolydian, harmonic-minor, pentatonic-major, pentatonic-minor
instruments: square_lead, pulse_lead, triangle_bass, saw_pad, fm_bell, fm_bass, pluck, kick, snare, hat, hat_open
loudness: music, stinger
swing: 0-0.3
forbid: locrian
forbid: drums in town

## town
tempo: 80-112
scales: major, mixolydian, pentatonic-major
`;

const STARTER_BIBLE = `# Music bible

One entry per track: a \`## <id>\` heading, then its data. \`song new <id> from-bible=<entry>\` sets a song
up from it.

## market — the market square
mood: warm, unhurried, a little proud
tempo: 96
key: D:major
tags: town
instruments: lead=square_lead, pad=saw_pad, bass=triangle_bass
motif: theme tpb=4 D5 - F#5 A5 B5 - A5 - G5 F#5 E5 F#5 D5 - - -
region: the market square at noon
`;

function cmdStyle(io: Io, p: Parsed): number {
  const [dir, ...extra] = p.pos;
  if (!dir) throw new UsageError('style: give a project folder');
  if (extra.length) throw new UsageError(`style: unexpected argument '${extra[0]}'`);
  const proj = loadProject(dir);
  if (p.flags.has('init')) {
    const made: string[] = [];
    for (const [f, body] of [[STYLE_FILE, STARTER_STYLE], [BIBLE_FILE, STARTER_BIBLE]] as const) {
      const file = join(proj.dir, f);
      if (existsSync(file)) continue;
      writeFileSync(file, body);
      made.push(f);
    }
    io.out(made.length ? `wrote ${made.join(' and ')} in ${dir}; edit them, then soundclaw style ${dir}\n` : `${dir} has ${STYLE_FILE} and ${BIBLE_FILE} already; nothing written\n`);
  }
  io.out(guideText(wr(io, dir).musicGuide().guide) + '\n');
  return 0;
}

function cmdImport(io: Io, p: Parsed): number {
  const [dir, what, source, ...extra] = p.pos;
  if (!dir || !what || !(IMPORT_KINDS as readonly string[]).includes(what) || !source) throw new UsageError(`import: soundclaw import <project> ${IMPORT_KINDS.join('|')} <file | "patch text"> [--id <id>]`);
  if (extra.length) throw new UsageError(`import: put the patch text in quotes (unexpected '${extra[0]}')`);
  assertNoServer(dir, io);
  const w = wr(io, dir);
  const imp = importCommands(source, one(p, 'id') ?? null, what as ImportKind);
  const { ids, warnings, report } = imp;
  const commands = p.flags.has('classic') ? `${imp.commands}\n${ids.map((id) => `sound classic ${id} on`).join('\n')}` : imp.commands;
  const r = w.run({ commands, by: author(p, 'agent:claude', (n) => `agent:${n}`) });
  if (!r.ok) {
    io.err(formatErrors('import', r.errors) + '\n');
    return 1;
  }
  // Warnings first (they are what needs reading), then a summary; the per-row report is for the rows that lost something, or for a few sounds.
  const approx = report.filter((x) => x.status === 'approximated');
  const lines = [...warnings.map((x) => `warning: ${x}`), ...r.warnings.map((x) => `warning: ${x}`)];
  lines.push(`imported ${plural(ids.length, 'sound')}${ids.length <= 8 ? ` (${ids.join(', ')})` : ''} as group ${r.group}: ${report.length - approx.length} exact, ${approx.length} approximated${p.flags.has('classic') ? '; all marked classic' : ''}`);
  if (!p.flags.has('quiet')) {
    lines.push(formatImportReport(report.length <= 8 ? report : approx));
    if (ids.length <= 8) lines.push(...r.touched.map((id) => soundSummary(w, id)));
    else lines.push(`(${plural(ids.length, 'sound')}: soundclaw list ${dir} shows them; --quiet leaves out the rows above)`);
  }
  io.out(lines.filter((x) => x !== '').join('\n') + '\n');
  return 0;
}

/** `changes`: what others changed since this agent looked. Reads the tape; only the agent's cursor file is written. */
function cmdChanges(io: Io, p: Parsed): number {
  const [dir, ...extra] = p.pos;
  if (!dir || extra.length) throw new UsageError('changes: give a project folder');
  const o = { agent: agentName(one(p, 'as')), since: one(p, 'since'), by: one(p, 'by'), peek: p.flags.has('peek') };
  io.out(changesText(wr(io, dir), o) + '\n');
  return 0;
}

function cmdExport(io: Io, p: Parsed): number {
  const [dir, ...ids] = p.pos;
  if (!dir) throw new UsageError('export: give a project folder');
  const fmt0 = one(p, 'format') ?? 'wav';
  if (one(p, 'to') && one(p, 'out')) throw new UsageError('export: give --to or --out, not both');
  const w0 = wr(io, dir);
  const songIds = ids.filter((x) => w0.hasSong(x));
  if (songIds.length && songIds.length !== ids.length) throw new UsageError(`export: ${songIds.join(', ')} ${songIds.length === 1 ? 'is a song' : 'are songs'} and ${ids.filter((x) => !w0.hasSong(x)).join(', ')} ${ids.length - songIds.length === 1 ? 'is not' : 'are not'}: export songs and sounds in separate commands`);
  const songOnly = ['loop', 'stems', 'stems-through-master'].filter((f) => p.flags.has(f)).map((f) => `--${f}`);
  for (const f of ['loops', 'pattern']) if (one(p, f) !== undefined) songOnly.push(`--${f}`);
  if (songIds.length) {
    for (const f of ['all', 'pack']) if (p.flags.has(f)) throw new UsageError(`export: --${f} is for sounds, not songs`);
    if (one(p, 'set')) throw new UsageError('export: --set is for sounds, not songs');
    if (!['wav', 'ogg', 'midi'].includes(fmt0)) throw new UsageError('export: a song exports as --format wav, ogg or midi');
    const q0 = one(p, 'quality') === undefined ? undefined : Number(one(p, 'quality'));
    if (q0 !== undefined && !(q0 >= -0.1 && q0 <= 1)) throw new UsageError('export: --quality is a number from -0.1 to 1');
    const loops = one(p, 'loops') === undefined ? undefined : Number(one(p, 'loops'));
    if (loops !== undefined && !(Number.isInteger(loops) && loops >= 1 && loops <= 16)) throw new UsageError('export: --loops is a whole number from 1 to 16');
    const lines: string[] = [];
    for (const id of songIds) {
      try {
        lines.push(formatSongExport(exportSong(w0, id, { format: fmt0 as 'wav' | 'ogg' | 'midi', loop: p.flags.has('loop'), stems: p.flags.has('stems'), stemsThroughMaster: p.flags.has('stems-through-master'), loops, pattern: one(p, 'pattern'), out: one(p, 'to') ?? one(p, 'out'), quality: q0 })));
      } catch (e) {
        if (e instanceof Error && /^export: /.test(e.message)) throw new UsageError(e.message);
        throw e;
      }
    }
    io.out(lines.join('\n') + '\n');
    return 0;
  }
  if (songOnly.length) throw new UsageError(`export: ${songOnly.join(', ')} ${songOnly.length === 1 ? 'is' : 'are'} for songs (name a song); a sound exports with --format, --to, --quality, --set, --all, --pack`);
  const format = fmt0 as ExportFormat;
  if (!EXPORT_FORMATS.includes(format)) throw new UsageError(`export: --format is ${EXPORT_FORMATS.join(', ')} (not '${format}')`);
  const out = one(p, 'to') ?? one(p, 'out');
  if (p.flags.has('all') && (ids.length || one(p, 'set'))) throw new UsageError('export: --all is every sound; name sounds or --set, not both');
  const quality = one(p, 'quality') === undefined ? undefined : Number(one(p, 'quality'));
  if (quality !== undefined && !(quality >= -0.1 && quality <= 1)) throw new UsageError('export: --quality is a number from -0.1 to 1');
  io.out(formatExportFiles(exportFormat(wr(io, dir), ids, format, { out, set: one(p, 'set'), all: p.flags.has('all'), pack: p.flags.has('pack'), quality, allowLicence: p.flags.get('allow-licence') })) + '\n');
  return 0;
}

/** `midi import <project> <file.mid> [--id <song>]` and `midi export <project> <song> [--pattern <p>] [--to <dir>]`. */
function cmdMidi(io: Io, p: Parsed): number {
  const [what, dir, file, ...extra] = p.pos;
  if (!what || !dir || !file || extra.length || !['import', 'export'].includes(what)) throw new UsageError('midi: soundclaw midi import <project> <file.mid> [--id <song>] | midi export <project> <song> [--pattern <p>] [--to <dir>]');
  if (what === 'export') {
    const w = wr(io, dir);
    if (!w.hasSong(file)) throw new UsageError(`midi export: no song '${file}'`);
    io.out(formatSongExport(exportSong(w, file, { format: 'midi', pattern: one(p, 'pattern'), out: one(p, 'to') ?? one(p, 'out') })) + '\n');
    return 0;
  }
  assertNoServer(dir, io);
  if (!existsSync(file)) throw new UsageError(`midi import: no such file ${file}`);
  const base = (file.split('/').pop() ?? 'song').replace(/\.(mid|midi)$/i, '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z]+/, '') || 'song';
  const id = one(p, 'id') ?? base.slice(0, 48);
  const imp = midiImportScript(new Uint8Array(readFileSync(file)), id);
  const w = wr(io, dir);
  const r = w.run({ commands: imp.script, by: author(p, 'agent:claude', (n) => `agent:${n}`) });
  if (!r.ok) { io.err(formatErrors('midi import', r.errors) + '\n'); return 1; }
  io.out([...imp.notes.map((x) => `warning: ${x}`), `imported ${id} from ${file}: ${imp.summary}, as group ${r.group}`, songSummary(w, id)].join('\n') + '\n');
  return 0;
}

/** `request`: ask for a change as the dashboard's button does, or list the open ones. */
function cmdRequest(io: Io, p: Parsed): number {
  const [dir, sound, ...extra] = p.pos;
  if (!dir) throw new UsageError('request: give a project folder');
  if (extra.length) throw new UsageError(`request: unexpected argument '${extra[0]}'`);
  if (!sound) {
    const open = openRequests(readRequests(loadProject(dir)));
    io.out(open.length ? open.map((q) => requestLine(q) + '\n').join('') : 'no open requests\n');
    return 0;
  }
  assertNoServer(dir, io);
  const w = wr(io, dir);
  const q = personRequest(w, author(p, 'human:cli', humanName), toPersonRequest({ action: 'request', sound, note: one(p, 'note'), tags: p.flags.get('tag'), other: one(p, 'like'), target: one(p, 'target'), again: one(p, 'again') }));
  w.requestsChanged();
  io.out(`${requestLine(q)}\n`);
  return 0;
}

/** `reply` and `cancel`: answer a blocked request, or withdraw one. */
function cmdAnswer(io: Io, action: string, p: Parsed): number {
  const [dir, id, text, ...extra] = p.pos;
  if (!dir || !id) throw new UsageError(`${action}: give a project folder and a request id`);
  if (extra.length) throw new UsageError(`${action}: put the text in quotes (unexpected '${extra[0]}')`);
  assertNoServer(dir, io);
  const w = wr(io, dir);
  const q = personRequest(w, author(p, 'human:cli', humanName), toPersonRequest({ action, id, text }));
  w.requestsChanged();
  io.out(`${requestLine(q)}\n`);
  return 0;
}

/**
 * `work`: an agent's side of a request, as the MCP work tool does it: list hands the open requests
 * over (seen), claim takes one, progress posts a note, block asks one question, done finishes it.
 * The id may be left out after claim: it is the one you hold. Errors apply nothing.
 */
function cmdWork(io: Io, p: Parsed): number {
  const [dir, action, ...rest] = p.pos;
  if (!dir || !action) throw new UsageError(`work: ${WORK_USAGE}`);
  if (!WORK_ACTIONS.includes(action)) throw new UsageError(`work: the action is ${WORK_ACTIONS.join(', ')} (not '${action}')`);
  const id = rest[0] && /^r\d+$/.test(rest[0]) ? rest.shift() : undefined;
  const [text, ...extra] = rest;
  if (extra.length) throw new UsageError(`work ${action}: put the text in quotes (unexpected '${extra[0]}')`);
  if (action === 'list' && (id || text !== undefined)) throw new UsageError('work list takes no id or text');
  if (action === 'claim' && text !== undefined) throw new UsageError(`work claim: unexpected '${text}' (give a request id like r3, or none for the next open one)`);
  if (['progress', 'block', 'done'].includes(action) && !text?.trim()) {
    throw new UsageError(`work ${action}: say ${action === 'progress' ? 'what you are doing' : action === 'block' ? 'the one question for the person' : 'what changed'} (in quotes)`);
  }
  assertNoServer(dir, io);
  const w = wr(io, dir);
  const by = author(p, 'agent:claude', agentName);
  const steps = cliSteps(dir);
  if (action === 'list') {
    agentWork(w, by, { action: 'list' });
    const active = openRequests(readRequests(w.project));
    io.out(active.length ? active.map((q) => requestLine(q) + '\n').join('') + `Take one: \`soundclaw work ${shellArg(dir)} claim [<request>]\`\n` : 'no open requests\n');
    return 0;
  }
  const r = action === 'claim' ? agentWork(w, by, { action: 'next', id }, steps)
    : agentWork(w, by, { action: action === 'block' ? 'blocked' : action as 'progress' | 'done', id, text: text! }, steps);
  w.requestsChanged();
  if (!r.request) {
    io.out(`${r.message}\n`);
    return 0;
  }
  if (action === 'claim') {
    io.out(`${r.message}\n${requestBrief(w, r.request, steps)}\n`);
    return 0;
  }
  const left = openRequests(readRequests(w.project)).filter((x) => x.state === 'open').length;
  io.out(`${r.message}\n${requestLine(r.request)}\n${action === 'progress' ? '' : left ? `${plural(left, 'open request')} left: ${steps.next}.\n` : 'No open requests left.\n'}`);
  return 0;
}

/** Where the shipped skill is: skill/ in the repo, or beside the bundle. */
function skillSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const d of [join(here, 'skill'), join(here, '..', '..', 'skill')]) if (existsSync(join(d, 'SKILL.md'))) return d;
  throw new ProjectError('the skill is not in this build (no skill/SKILL.md)');
}

/** Copy the shipped skill (and the command reference beside it) into dest; returns the files. */
function installSkillAt(dest: string): string[] {
  const src = skillSource();
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true, filter: (f) => !f.endsWith('package.json') });
  // The command reference goes beside it (the bundle carries a copy; the repo has it in docs/).
  const ref = join(src, '..', 'docs', 'commands.md');
  if (!existsSync(join(src, 'commands.md')) && existsSync(ref)) cpSync(ref, join(dest, 'commands.md'));
  return readdirSync(dest, { recursive: true }).map(String).filter((f) => f.includes('.')).sort();
}

function cmdSkill(io: Io, p: Parsed): number {
  const [what] = p.pos;
  if (what !== 'install' && what !== 'path') throw new UsageError('skill: install [--dest <dir> | --project <dir>], or path');
  if (what === 'path') { io.out(skillSource() + '\n'); return 0; }
  const proj = one(p, 'project');
  const dest = one(p, 'dest') ?? (proj ? join(proj, '.claude', 'skills', 'soundclaw') : join(homedir(), '.claude', 'skills', 'soundclaw'));
  const files = installSkillAt(dest);
  io.out(`installed the SoundClaw skill in ${dest} (${files.join(', ')})\nClaude Code finds it as /soundclaw; connect the tools with:\n  claude mcp add soundclaw -- npx -y soundclaw serve --project <your project>\n(or run soundclaw init, which does both)\n`);
  return 0;
}

function cmdInit(io: Io, p: Parsed): number {
  const [project = 'sounds', ...extra] = p.pos;
  if (extra.length) throw new UsageError(`init: unexpected argument '${extra[0]}'`);
  const scope = (one(p, 'scope') ?? 'local') as Scope;
  if (!SCOPES.includes(scope)) throw new UsageError(`--scope is local, project or user, not '${scope}'`);
  const name = one(p, 'name') ?? 'soundclaw';
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new UsageError(`--name is letters, digits, _ and -, not '${name}'`);
  return init({
    project, name, scope,
    skill: !p.flags.has('no-skill'),
    force: p.flags.has('force'),
    version: soundclawVersion(),
    cwd: io.cwd ?? process.cwd(),
    installSkill: installSkillAt,
    claude: io.claude ?? runClaude,
    out: io.out,
  });
}

export function main(argv: string[], io: Io = nodeIo): number {
  const [cmd, ...rest] = argv;
  try {
    const meta = metaCommand(argv, io);
    if (meta !== null) return meta;
    switch (cmd) {
      case 'init': return cmdInit(io, parseArgs(rest, ['scope', 'name'], ['no-skill', 'force']));
      case 'new': return cmdNew(io, parseArgs(rest, ['name'], []));
      case 'run': return cmdRun(io, parseArgs(rest, ...WRITE_OPTS.run!));
      case 'list': return cmdList(io, parseArgs(rest, [], []));
      case 'history': return cmdHistory(io, parseArgs(rest, ['sound', 'by', 'limit'], []));
      case 'render': return cmdRender(io, parseArgs(rest, [], ['json']));
      case 'view': return cmdView(io, parseArgs(rest, ['out', 'from', 'to', 'channels'], []));
      case 'midi': return cmdMidi(io, parseArgs(rest, ...WRITE_OPTS.midi!));
      case 'describe': return cmdDescribe(io, parseArgs(rest, [], ['json']));
      case 'compare': return cmdCompare(io, parseArgs(rest, [], ['json']));
      case 'measure': return cmdMeasure(io, parseArgs(rest, [], ['json']));
      case 'normalize': return cmdNormalize(io, parseArgs(rest, ...WRITE_OPTS.normalize!));
      case 'check': return cmdCheck(io, parseArgs(rest, [], ['json']));
      case 'import': return cmdImport(io, parseArgs(rest, ...WRITE_OPTS.import!));
      case 'sample': return cmdSample(io, parseArgs(rest, ...WRITE_OPTS.sample!));
      case 'library': return cmdLibrary(io, parseArgs(rest, ...WRITE_OPTS.library!));
      case 'upgrade': return cmdUpgrade(io, parseArgs(rest, ...WRITE_OPTS.upgrade!));
      case 'licence': case 'license': return cmdLicence(io, parseArgs(rest, ['allow-licence'], []));
      case 'changes': return cmdChanges(io, parseArgs(rest, ['since', 'by', 'as'], ['peek']));
      case 'export': return cmdExport(io, parseArgs(rest, ...WRITE_OPTS.export!));
      case 'request': return cmdRequest(io, parseArgs(rest, ...WRITE_OPTS.request!));
      case 'reply': case 'cancel': return cmdAnswer(io, cmd, parseArgs(rest, ...WRITE_OPTS.reply!));
      case 'work': return cmdWork(io, parseArgs(rest, ...WRITE_OPTS.work!));
      case 'skill': return cmdSkill(io, parseArgs(rest, ['dest', 'project'], []));
      case 'scale': return cmdScale(io, parseArgs(rest, [], []));
      case 'style': return cmdStyle(io, parseArgs(rest, [], ['init']));
      case undefined: case 'help': case '-h': case '--help':
        io.out(USAGE);
        return cmd === undefined ? 1 : 0;
      default:
        throw new UsageError(`unknown command '${cmd}'`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    if (e instanceof ProjectError) {
      io.err(`error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
