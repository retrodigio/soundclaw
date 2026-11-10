// The MCP tools: project, run, history, render, export, request, work and await_requests. Few
// tools; the command language carries the rest. Every call goes through the writer's queue, in
// the order it arrives.

import { existsSync, statSync } from 'node:fs';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { builtinInstruments, guideText, openRequests, scaleText } from '@soundclaw/core';

import { formatEvents } from './await.ts';
import { changesText } from './changes.ts';
import { sampleLine } from './samples.ts';
import { addLibrary, hitJson, indexLibrary, indexStatsText, listLibraries, listText, readRegistry, searchLibraries, searchText, similarLibraries, stateUnder, useLibraryFile, type SearchResult } from './library.ts';
import { gcApply, gcPlan, gcReport, importPath, importReport, licenceCheck, licencePolicyNote, licenceReportText, sampleListText, sampleShowText, upgradeProject } from './sampleimport.ts';
import { sampleCheckText, sampleDescribeText, sampleMeasureJson, isSampleRef } from './sampleview.ts';
import { checkText, describeJson, describeText, exportFormat, measureJson, measureText, formatExportFiles, formatImportReport, importCommands, renderText, setSummary, viewSound } from './ears.ts';
import { failureLines, normalizePlan } from './normalize.ts';
import { ProjectError } from './project.ts';
import { formatErrors, plural, tapeEntryLines } from './report.ts';
import { MCP_STEPS, agentName, agentWork, awaitRequests, listenerNote, markSeen, personRequest, readRequests, requestBrief, requestLine, toPersonRequest } from './requests.ts';
import { historyText, soundSummary } from './summary.ts';
import { exportInstrument, formatInstrumentExport, instrumentChecksText, instrumentZonesText, isProjectInstrument, viewKeymap } from './instruments.ts';
import { SONG_VIEWS, exportSong, formatSongExport, listInstruments, midiImportScript, songChecksText, songJsonObject, songNumbersText, songSummary, viewSong, type SongViewKind } from './songs.ts';
import { readFileSync } from 'node:fs';
import { formatInstrumentImport, importInstrument, isSoundFont, soundFontList } from './instrumentimport.ts';
import { configText, generateFromBody, ledgerText, ledgerTotals, readGenerationConfig } from './generate.ts';
import type { Writer } from './writer.ts';

/** The author name every MCP batch is written with. */
export const AGENT = 'agent:claude';

export const SERVER_NAME = 'soundclaw';

export const INSTRUCTIONS = `SoundClaw is a sound effects and music workbench you drive with a small command language. You cannot hear, so you have ears: every result ends with numbers for each sound it touched (duration, loudness, peaks, attack, tail, brightness, pitch, onsets) and a one-line check summary, \`view\` shows a picture (waveform, spectrogram, pitch track, A/B comparison), \`describe\` says it in words, \`check\` lists what fails and where. A person listens in the dashboard.

Start with the \`project\` tool: it lists the sounds and gives a watch link (http://127.0.0.1:…/?token=…). Give the person that link so they can listen, and ask for changes or approve on each sound's card.

Make sounds with \`run\` (one batch = one undo group; any error applies nothing). Commands, one per line or separated by ';' ('#' starts a comment):
  sound new <id> voice=classic [preset=<category>] [seed=<n>]   the classic voice: 25 sfxr-style parameters; presets pickup, laser, explosion, powerup, hit, jump, blip (seeded: same seed, same sound)
  sound new <id>                                   a placeholder sine tone (frequency 20-20000 Hz, duration 0.01-10 s, volume 0-1)
  sound set <id> <param>=<value> [<param>=<value>...]   classic parameters (wave=square|saw|sine|noise, attack, sustain, punch, decay, freq, minFreq, slide, deltaSlide, vibratoDelay, vibratoDepth, vibratoSpeed, changeAmount, changeSpeed, duty, dutySweep, repeatSpeed, phaserOffset, phaserSweep, lowPass, lowPassSweep, resonance, highPass, highPassSweep, volume; seed) with their ranges in docs/commands.md
  sound patch <id> "<single-patch text>"           all 25 values at once (sfxr text: numbers in order, or name=value pairs)
  sound generate <id> <category|random> [seed=<n>]   a new random patch for a classic sound, from a category's ranges (or any sound: random)
  sound mutate <id> [amount=0.05] [seed=<n>] [as=<new id>]   a small seeded change to a classic sound
  sound mark <id> approved|rejected|draft ["note"]   a status mark (people use the buttons; the note says why)
Layered sounds (several voices summed; use them when one sfxr voice is not enough: impacts, doors, magic, footsteps, anything with a body and a top):
  sound new <id> voice=layered [preset=footstep|ui-click|door|magic|<classic category>] [seed=<n>]   up to 8 layers; sound set <id> duration=<s|auto> gain=<g> seed=<n>
  layer add <id> classic|osc|fm|ks|sample [<param>=<value> ...] [at=<n>]   osc: wave sine|square|saw|triangle|pulse|wavetable|white|pink|brown|metal, freq, duty, dur; fm: ops 2-4, algo, ratio1-4, index2-4; ks (pluck): freq, decay, bright; sample: sample=<name>, start, end, pitch, reverse, side, slice, fade-in, fade-out, stretch, method, loop, xfade, interp; every layer: offset, gain, pan, filter=off|lp|hp|bp|notch, cutoff, q
  layer set <id> <n> <param>=<value> ...  |  layer remove|move|mute|solo <id> <n> [to=<m> | on|off]   (layers count from 1; source=<kind> changes a layer's source)
  env <id> <target> "<time>:<value>[@lin|exp|hold|ease] ..." | adsr(a,d,s,r[,hold]) | clear   an envelope replaces a fixed value; targets 1.freq 1.amp 1.cutoff 2.pan 1.fx1.mix master.fx1.mix
  fx add <id> [layer=<n>] filter|distort|bitcrush|chorus|delay|reverb|compress|limit [<param>=<value> ...] [at=<k>]  |  fx set|remove|move <id> [layer=<n>] <k> ...   (no layer= : the master chain)
  sound layer-up <id>   a classic sound becomes layered, same samples   |   sound classic <id> on|off   keep it one classic voice (exports as a synth.csv row)
Sets, families and loops (game sounds that repeat, or come in several distances, or run for ever):
  set new <set> from=<sound> count=<n> [target=<LUFS>] [spread="1.freq±10% 2.cutoff±15% gain±10%"] [seed=<n>]   count seeded variants (<set>_1 ...) of a classic or layered sound, each a real sound; spread: classic parameter ±amount, or for a layered sound N.<param>, *.<param>, N.amp, N.fxK.<param>, master.fxK.<param>, gain; % is relative. Members are matched to the target LUFS by gain (a classic member's gain is its volume, at most 1: the note says when it falls short). \`view\` set and \`check\` the set (set-spread: not too alike, not too different, loudness within ±1 LU)
  set add|remove <set> <sound>...   |   set retarget <set> <LUFS>|none   |   set regen <set> [seed=<n>] [spread="..."]   (regen makes the generated members again from the source's current state)
  The moment: \`sound set <id> moment="<the situation in the game the sound is for>"\` (or moment=none), \`set moment <set> "<…>"|none\` for a set's members. Words only (no render reads them); \`describe\` and the summaries show it. People judge blind A/B comparisons against it, so write one for every sound you make for a known situation: what happens, how often it repeats ("every 0.4 s"), what plays under it.
  family <sound> near|far|muffled [as=<id>]   a copy as heard near (drier), far away (quieter, darker, more reverb) or behind a wall (low-passed); its loudness is held to the source's plus the rule's offset
  sound loop <id> <seconds>|off [fade=<s>]   a bed: the sound is that long and its end runs into its start without a seam (the render goes fade seconds past the end and crossfades it over the start); \`view\` loop shows the seam; the click check looks at it. Beds come as recipes: sound new <id> voice=layered preset=wind|rain|fire|crowd
  Export: wav, ogg (Vorbis) with a manifest.json; pack layout for the engine's synth.csv. Import: sfxr, jsfxr and bfxr strings, each row reported as exact or approximated.
  Order: source -> filter -> amp envelope -> effects -> gain -> pan, then the sum -> master gain -> master effects; export adds a limiter. Layered sounds export as WAV only. A layer with pan off centre makes the sound stereo. The \`layers\` view shows each layer; the \`harsh\` check flags sustained 2-5 kHz energy. \`sample\` imports a WAV for sample layers.
  undo [group=<g>] [by=<author>]   |   redo [group=<undo group>] [by=<author>]      run alone, as the only command of the batch
\`history\` reads the tape: every command with its number, author (agent:<name> or human:<name>) and undo group, undone groups marked. People edit in the dashboard too, as human:<name>; call \`history\` (by=… to pick one person) at the start of each turn while someone is watching, and carry on from what they did; never silently redo it. \`render\` gives a sound's numbers, description and checks; \`export\` writes wav (16-bit, 44,100 Hz, mono), patch (sfxr text) or csv (synth.csv) files; \`import\` makes classic sounds from an sfxr csv or patch.

Music (instruments, patterns, songs; build a song in passes and run \`check\` after each: structure, harmony, bass, melody, drums, mix):
  instrument new <id> [from=<built-in>|kind=osc|fm|ks|classic|sample|zones]   instrument from-sound <id> <sound> [root=<note>]   instrument set <id> root= pitched= adsr=a,d,s,r velocity= range=C3-C6 pitchenv= gain=   instrument layer|fx|env …   (built-ins: square_lead pulse_lead triangle_bass saw_pad fm_bell fm_bass pluck kick snare hat hat_open: use them by name)
  Sampled instruments (the samples of the project played by key and velocity): instrument zone add <id> sample=<name> root=<note> keys=<lo>-<hi> [vel=<lo>-<hi>] [tune=<cents>] [gain=<dB>] [loopmode=none|sustain|continuous|oneshot] [trigger=attack|release] [release-decay=<dB/s>] [rr=<i>/<n>] [choke=<group>] [hit=<name>]   instrument zone set|remove|clear <id> [<n>] ...   instrument zones <id> from-samples <sample>... [root=detect] | from-slices <sample> [start=C1]   instrument from-sample <id> <sample> [loop=find]   instrument set <id> velxfade=<steps> rr=cycle|hash; a drum channel takes kit=<kit instrument> (zones keyed by hit=<name>). \`check\` an instrument for holes in its key-map, zones out of tune, level steps and loop seams; \`view\` it with kind keymap; \`export\` it as sfz. \`instrument_import\` reads an .sfz file or one preset of an .sf2 (list: true shows the presets) as a sampled instrument and names what it could not carry.
  song new <id> [tempo=] [swing=] [time=4/4] [key=A:minor] [class=music|stinger]   song channel add <song> <name> inst=<instrument>|kit=default [gain=] [pan=] [layer=base|tension|combat]   song section add <song> <name> <pattern>… [x2]   song loop <song> <from>..<to>|off   song intro|ending <song> <section>   song fx add <song> compress|limit …
  pattern <song>.<name> steps=16 tpb=4 bar=8, then indented rows: \`lead: C5 . E5 - | G5v80 . E5~slide .\` (. rest, - hold, | bars, v velocity, ! outside the key on purpose, ~slide ~vib ~arp(0,4,7), chords C4+E4+G4, lower-case words are drum hits)
  One note at a time: \`pattern note add|remove|move|len|set <song>.<pattern> <channel> <step> …\` (add E5 len=2; move step=6 note=G5; set vel=80 fx=~slide). A person's edits in the music editor are these commands: call \`changes\` before editing a song a person touched.
  Helpers write notes into patterns (on the tape with the rows they wrote; edit the rows afterwards like any pattern): \`chords <song> <pattern> <channel> "i VI III VII" [bars=1] [rhythm=hold|beats|offbeat|"x-.x"] [range=G3-G5]\` (roman numerals in the song's key: V7 ii65 bVII V/V Vsus4), \`bass <song> <pattern> <channel> "<progression>"|from=<chord channel> style=root|root-fifth|walking|octave\`, \`arp … pattern=up|down|updown|random(7) rate=1/16\`, \`drums <song> <pattern> <channel>[,<hats>] rock|halftime|shuffle|march|waltz|pulse|chip… fill=4 seed=1\`, \`humanise <song> <pattern> <channel>|all timing=8 velocity=6 seed=1\`, \`motif set|transpose|invert|retrograde|augment|diminish|write|sequence …\`, \`layer-plan <song> base=<ch,…> tension=… combat=…\`. \`song new <id> from-bible=<entry>\` sets a song up from music-bible.md; \`song new <id> kind=stinger template=victory|game-over|level-up|item-get\` writes a stinger. The \`scale\` tool lists a key's notes and chords; \`style\` shows music-style.md and music-bible.md.
  Songs have the views notes (written notes against what the render plays, per channel) and mix (energy by band over time, masking in amber); the checks key, range, render-match, loop-music, masking and voice-leading (advisory), style (music-style.md and the song's bible entry), layers (each game layer alone and with the base) and clip, loudness, dc on the mix. \`normalize\` writes the song's gain; \`export\` writes wav/ogg, --loop (seamless), --stems (one per game layer), midi.

Loudness classes: \`sound set <id> class=ui|foley|impact|ambience|voice|music-sting\` (or loudness=<LUFS>); the loudness check holds each sound to its class (standard: -16 LUFS ±1) and says which applied. \`normalize\` writes the gain that brings sounds to their class; \`measure\` returns the numbers and checks of many sounds as JSON in one call. Dynamics: \`fx add <id> compress|limit\` (a limiter on the master chain lets a spiky sound be loud without clipping). Many hits in one layer: \`env <id> 1.amp bursts(times=0.1,0.3 ...)\`. \`sound copy|rename|remove <id> ...\` manage sounds.

Samples as material: \`sample derive <new> from=<name> op="trim 0.1 0.9; fade out=50ms; normalize peak -3"\` makes new audio (ops: trim, fade, gain, normalize peak|lufs, silence-trim <dB>, dc, reverse, mono|left|right, pitch <semitones> [method=resample|stretch], stretch <ratio>|to=<s>|tempo=<a>:<b> [method=wsola|pv], loop <s> <e> xfade=<t>, slice <n>, mix <sample> at=<t> gain=<dB>; measured values are written into the history as numbers). \`sample slice <name> at=onsets|<t,t,..>|grid=<n>\`, \`sample loop <name> find|<start> <end>\`, \`sample bounce <new> from=<sound|song> [layer=<n>] [loop=yes]\` freezes a render. \`layer align <id> <n> to=<m>|start by=onset|peak\`, \`layer match <id> <n> to=<m> db=<offset>\`, \`env <id> <n>.amp follow=<layer>|sample:<name>\`. Hear samples with describe, measure and view (sample:<name> or hash:<sha256>: wave, spec, pitch, loop, slices, compare), sample check (advice only), and search with a numbers query: sample list "creak" dur=0.8-2.5 lufs>-30 centroid<2.5k pitched=no onsets=1.

Sample libraries (folders of recordings outside the project, registered by \`soundclaw library add\` or the tool's \`add\`, and indexed by \`soundclaw library index\` or \`index\`): the \`library\` tool searches them (\`search\` with words and a numbers query such as "creak" dur=0.8-2.5 pitched=no licence=shippable), finds files that sound like a sound or sample (\`similar\`), and copies one into the project (\`use\`, with its provenance and the library's licence); then \`layer add <sound> sample sample=<name>\`.

Generation (the \`generate\` tool): sound effects from a prompt by an AI provider, each take kept as a sample with its prompt, provider, credits and licence. Call it with estimate: true first; every cap is checked before the first call and nothing is called if one would be passed (the project's cap is 0 until a person sets one, so ask them). Rank takes with want (a numbers query) or like; listen with describe and compare before you build on one; remove the takes you do not keep. Shape a take in the tool (sample derive, layers with synthesis) rather than generating again and again.

Checks (clip, loudness, dc, click, tail) hold a sound to the project's style (default -16 LUFS ±1, true peak at most -0.1 dBTP, no click at the first or last sample, no cut tail). A request's work(action="done") is refused while its sound fails them: look at \`check\`, fix the sound (volume sets loudness; attack and decay remove clicks), then finish.

Requests: people ask for changes on a sound's card (Ask for changes, with a note); a blind A/B in the dashboard arrives as a comparison (A fits better, B fits better, both would do, neither would do, in the moment, with the two versions as tape numbers and the gains that matched their levels): a judgment, not a change, so read it, let it steer what you make next and close it with done. \`work\` claims the next open request and says what is asked; post progress with work(action="progress", text=…); finish with work(action="done", text=<what changed>) or, when you need the person, work(action="blocked", text=<one clear question>). While you are between tasks, keep \`soundclaw await <project>\` running in the background (its exit wakes you), or call await_requests.`;

const text = (t: string) => ({ type: 'text' as const, text: t });
const fail = (t: string): CallToolResult => ({ content: [text(t)], isError: true });

function errorResult(e: unknown): CallToolResult {
  if (e instanceof ProjectError || e instanceof SyntaxError) return fail(`error: ${e.message}`);
  throw e;
}

export function projectSummary(w: Writer, url: string): string {
  const p = w.project;
  const lines = [`project: ${p.json.name} (${p.dir})`, `watch: ${url}`];
  const sounds = w.sounds();
  lines.push('', sounds.length ? `sounds (${sounds.length}):` : 'sounds: none yet. Make one with run: "sound new zap voice=classic preset=laser seed=1".');
  for (const s of sounds) lines.push(`  ${soundSummary(w, s.id)}`);
  const songs = w.songs();
  if (songs.length) lines.push('', `songs (${songs.length}):`, ...songs.map((x) => `  ${songSummary(w, x.id)}`));
  const insts = w.instruments();
  if (insts.length) lines.push('', `instruments (${insts.length}): ${insts.map((i) => i.id).join(', ')} (and the built-ins: ${Object.keys(builtinInstruments()).join(', ')})`);
  const sets = w.sets();
  if (sets.length) lines.push('', `sets (${sets.length}):`, ...sets.map((x) => `  ${setSummary(w, x.id)}`));
  const open = openRequests(readRequests(p));
  if (open.length) lines.push('', `requests from people (${open.length}):`, ...open.map((q) => `  ${requestLine(q)}`));
  const note = listenerNote(w);
  if (note) lines.push('', note);
  return lines.join('\n');
}

export interface McpHost {
  writer: Writer;
  /** The dashboard's URL, with its token. */
  url(): string;
}

export function createMcpServer(host: McpHost, version: string): McpServer {
  const w = host.writer;
  const server = new McpServer({ name: SERVER_NAME, version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  server.registerTool('project', {
    title: 'Project',
    description: 'Show the open project: its sounds with their numbers, the requests people made, and the live watch link for the person.',
    inputSchema: z.object({}),
  }, () => w.enqueue(() => {
    try {
      return { content: [text(projectSummary(w, host.url()))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('run', {
    title: 'Run commands',
    description: 'Apply command text as one undo group. Returns the commands as written to the tape (normal form), the numbers of every sound they changed, and warnings. ' +
      'Any parse or semantic error is reported with its line and column, and nothing is applied. `undo` and `redo` are commands too and run alone. The person watching sees the sounds change on their cards.',
    inputSchema: z.object({
      commands: z.string().describe('One or more lines of the command language'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      const r = w.run({ commands: a.commands, by: AGENT });
      if (!r.ok) return fail(formatErrors('commands', r.errors));
      if (!r.added.length) return { content: [text('no commands')] };
      const lines = [`applied ${plural(r.added.length, 'command')} as group ${r.group}`, ...r.added.flatMap((e) => tapeEntryLines(e))];
      for (const id of r.touched) lines.push(soundSummary(w, id));
      for (const id of r.touchedSets) lines.push(setSummary(w, id));
      for (const id of r.touchedSongs) lines.push(songSummary(w, id));
      lines.push(r.warnings.length ? `warnings: ${r.warnings.join('; ')}` : 'warnings: none');
      return { content: [text(lines.join('\n'))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('history', {
    title: 'Read the tape',
    description: 'Read the history: every command in order with its number, author and undo group; undone groups are marked. Includes what people did in the dashboard (human:<name>). ' +
      'By default the last 50 commands. Undo is a command (`undo` or `undo group=g4` through run).',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({
      sound: z.string().optional().describe('Only commands about this sound'),
      by: z.string().optional().describe('Only commands by this author, e.g. human:ana'),
      last: z.number().int().min(1).optional().describe('Only the last N commands (default 50)'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      return { content: [text(historyText(w, { sound: a.sound, by: a.by, limit: a.last ?? 50 }))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('changes', {
    title: 'What others changed',
    description: 'What people (or other agents) changed since you last looked: each history group after your cursor with the parameters before and after, the numbers before and after (duration, loudness, centroid, pitch) and a before/after compare view saved as a PNG (the path is in the text). ' +
      'Your cursor is kept per agent in the project and moves when you read, unless you pass since or peek. Call this before editing a sound a person has touched, and never undo a person\'s edit silently.',
    annotations: { readOnlyHint: false },
    inputSchema: z.object({
      since: z.string().optional().describe('A command number (like 14) or a time: read from there, and leave the cursor alone'),
      by: z.string().optional().describe('human (people only), agent, or one author like human:ana. Default: everyone but you'),
      peek: z.boolean().optional().describe('Read without moving the cursor'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      return { content: [text(changesText(w, { agent: AGENT, since: a.since, by: a.by, peek: a.peek }))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('render', {
    title: 'Render a sound',
    description: 'Render a sound (through the content-hash cache) and return its numbers (samples, peak, rms, a hash of the samples; duration, loudness, true peak, attack, tail, brightness, pitch, onsets), a plain-words description, and the check summary as the last line. The same document always gives the same hash; the dashboard plays exactly these samples.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({ sound: z.string(), json: z.boolean().optional().describe('The result as one JSON object (class, numbers, checks, hash)') }),
  }, (a) => w.enqueue(() => {
    try {
      if (w.hasSong(a.sound)) return { content: [text(a.json ? JSON.stringify(songJsonObject(w, a.sound), null, 2) : `${songNumbersText(w, a.sound)}\n${songSummary(w, a.sound).split('\n').slice(1).join('\n')}`)] };
      const r = w.render(a.sound); // first, so the summary does not warm the cache
      if (a.json) return { content: [text(describeJson(w, a.sound, { renderKey: r.key, cached: r.cached, samplesHash: w.samplesHashOf(a.sound) }))] };
      const head = soundSummary(w, a.sound).split('\n')[0]!;
      return { content: [text(renderText(w, a.sound, `${head}\nrender key ${r.key.slice(0, 12)}${r.cached ? ' (from the render cache)' : ''}`))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('view', {
    title: 'View a sound',
    description: 'Your ears as a picture (PNG) with the numbers: wave (waveform, envelope, clip marks), spec (mel spectrogram with Hz and note rulers), pitch (YIN track over a note grid), layers (the layers of a layered sound stacked: waveform and spectrogram of each, with offsets), loop (a looping sound: its end joined to its start, overlapped, the joined spectrogram and the level across four repeats), set (`sound` names a set: members side by side with loudness bars and the pairwise distance matrix), compare (this sound and `other` stacked with a difference spectrogram, and distance numbers). The image is also saved under <project>/.cache/views.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({
      sound: z.string(),
      kind: z.enum(['wave', 'spec', 'pitch', 'layers', 'loop', 'set', 'compare', 'notes', 'mix', 'slices', 'keymap']).optional().describe('Default spec (a song: notes, mix, wave, spec, loop; default notes; a sample: wave, spec, pitch, loop, slices; a sampled instrument: keymap, keys across and velocity up, zones as boxes coloured by their checks)'),
      other: z.string().optional().describe('compare: the second sound, song, sample:<name>, hash:<sha256>, or the path of a WAV or OGG file (a reference outside the project; `sound` may be a file too). A sample is `sample:<name>` in `sound`'),
      from: z.number().optional().describe('A song: draw from this second'),
      to: z.number().optional().describe('A song: draw to this second'),
      channels: z.array(z.string()).optional().describe('A song: only these channels'),
    }),
  }, (a) => w.enqueue((): CallToolResult => {
    try {
      if (w.hasSong(a.sound) && a.kind !== 'compare') {
        const kind = (a.kind ?? 'notes') as string;
        if (!(SONG_VIEWS as readonly string[]).includes(kind)) return fail(`error: a song has the views ${SONG_VIEWS.join(', ')}`);
        const sv = viewSong(w, a.sound, kind as SongViewKind, { from: a.from, to: a.to, channels: a.channels });
        return { content: [{ type: 'image' as const, data: Buffer.from(sv.png).toString('base64'), mimeType: 'image/png' }, text(sv.text)] };
      }
      if (isProjectInstrument(w, a.sound) && a.kind !== 'compare') {
        if (a.kind !== undefined && a.kind !== 'keymap') return fail(`error: an instrument has the view keymap (not '${a.kind}')`);
        const kv = viewKeymap(w, a.sound);
        return { content: [{ type: 'image' as const, data: Buffer.from(kv.png).toString('base64'), mimeType: 'image/png' }, text(`${instrumentZonesText(w, a.sound)}\n${kv.text}`)] };
      }
      if (a.kind === 'keymap') return fail(`error: keymap is a view of a sampled instrument (${a.sound} is not one)`);
      if (a.kind === 'notes' || a.kind === 'mix') return fail(`error: ${a.kind} is a view of a song (${a.sound} is a sound)`);
      const v = viewSound(w, a.sound, a.kind ?? 'spec', { other: a.other });
      return { content: [{ type: 'image' as const, data: Buffer.from(v.png).toString('base64'), mimeType: 'image/png' }, text(v.text)] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('describe', {
    title: 'Describe a sound or sample',
    description: 'A plain-words summary built only from the measured numbers (length, tonal or noisy, brightness, pitch motion, attack, tail, peak, loudness, onsets), then the numbers and the check summary.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({ sound: z.string().describe('A sound, a song, `sample:<name>` or `hash:<sha256>` (a sample: the same numbers and words, its provenance and licence, its advisory checks)'), json: z.boolean().optional().describe('The result as one JSON object') }),
  }, (a) => w.enqueue(() => {
    try {
      if (w.hasSong(a.sound)) return { content: [text(a.json ? JSON.stringify(songJsonObject(w, a.sound), null, 2) : songNumbersText(w, a.sound))] };
      return { content: [text(a.json ? describeJson(w, a.sound) : describeText(w, a.sound))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('check', {
    title: 'Check sounds',
    description: 'Run the checks (clip, loudness, dc, click, tail, harsh) on sounds, and set-spread on sets (members not too alike, not too different, loudness within ±1 LU); all sounds and sets when none are named: pass or fail with a score, the threshold from the project style, and the exact time ranges flagged. A looping sound\'s click check looks at its seam. `work` done is refused while a sound fails.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({ sounds: z.array(z.string()).optional().describe('Sound ids, set names, song ids and sampled instruments (zones: coverage, pitch at the root, level steps, loop seams, distance from the root, round robins, release level)'), json: z.boolean().optional().describe('One JSON document with every number and every check (as measure)') }),
  }, (a) => w.enqueue(() => {
    try {
      const ids = a.sounds ?? [];
      const songIds = ids.length ? ids.filter((x) => w.hasSong(x)) : w.songs().map((x) => x.id);
      const instIds = ids.filter((x) => isProjectInstrument(w, x));
      const soundIds = ids.filter((x) => !w.hasSong(x) && !instIds.includes(x));
      const only = (ids.length > 0 && !soundIds.length) || (ids.length === 0 && !w.sounds().length && !w.sets().length && songIds.length > 0);
      const insts = instIds.length ? instrumentChecksText(w, instIds) : null;
      if (a.json) {
        const doc = JSON.parse(only ? '{}' : measureJson(w, soundIds).json) as Record<string, unknown>;
        if (songIds.length) doc.songs = songIds.map((x) => songJsonObject(w, x));
        if (insts) doc.instruments = insts.json;
        return { content: [text(JSON.stringify(doc, null, 2))] };
      }
      return { content: [text([only ? '' : checkText(w, soundIds).text, ...songIds.map((x) => songChecksText(w, x).text), insts?.text].filter(Boolean).join('\n\n'))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('scale', {
    title: 'Scales and chords',
    description: 'A key\'s notes and, for a seven-note scale, the triad and seventh on each degree with its roman numeral (as chords, bass, arp and motif sequence read them). key: like D:major or A:dorian, a song id (its key), or list (every scale).',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({ key: z.string().describe('D:major, A:dorian, a song id, or list') }),
  }, (a) => w.enqueue(() => {
    try {
      const k = w.hasSong(a.key) ? w.song(a.key).key : a.key;
      if (!k) return fail(`${a.key} has no key (song set ${a.key} key=D:major)`);
      return { content: [text(scaleText(k))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('style', {
    title: 'Music style guide and bible',
    description: 'The project\'s music style guide (music-style.md: tempo range, key, scales, instrument palette, loudness classes, forbidden things, rules per tag) and music bible (music-bible.md: per track mood, tempo, key, instruments, motif) as SoundClaw reads them, with any lines it cannot read. The style check holds songs to them; song new <id> from-bible=<entry> starts a song from an entry.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({}),
  }, () => w.enqueue(() => {
    try {
      return { content: [text(guideText(w.musicGuide().guide))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('measure', {
    title: 'Measure many sounds',
    description: 'The numbers and the loudness class of many sounds in one call (all sounds when none are named): per sound its class and target, every number describe gives and every check result. ' +
      'json (default true) returns one JSON document for scripts: {format, pass, sounds: [{id, class: {name, target, tolerance, basis}, numbers, checks, binding}], sets}. A sound\'s class: `sound set <id> class=<name>` or loudness=<LUFS>.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({ sounds: z.array(z.string()).optional().describe('Sound ids and set names (default all); `sample:<name>` or `hash:<sha256>` measures a sample'), json: z.boolean().optional().describe('Default true; false gives text') }),
  }, (a) => w.enqueue(() => {
    try {
      const refs = (a.sounds ?? []).filter(isSampleRef);
      const ids = (a.sounds ?? []).filter((x) => !isSampleRef(x));
      const songIds = ids.length ? ids.filter((x) => w.hasSong(x)) : refs.length ? [] : w.songs().map((x) => x.id);
      const soundIds = ids.filter((x) => !w.hasSong(x));
      const only = (refs.length > 0 && !ids.length) || (ids.length > 0 && !soundIds.length) || (ids.length === 0 && !w.sounds().length && !w.sets().length && songIds.length > 0);
      if (a.json === false) return { content: [text([only ? '' : measureText(w, soundIds).text, ...songIds.map((x) => `${songNumbersText(w, x)}\n${songChecksText(w, x).text}`), ...refs.map((x) => sampleDescribeText(w, x))].filter(Boolean).join('\n\n'))] };
      const doc = JSON.parse(only ? '{}' : measureJson(w, soundIds).json) as Record<string, unknown>;
      if (songIds.length) doc.songs = songIds.map((x) => songJsonObject(w, x));
      if (refs.length) doc.samples = refs.map((x) => sampleMeasureJson(w, x));
      return { content: [text(JSON.stringify(doc, null, 2))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('normalize', {
    title: 'Normalize loudness',
    description: 'Write the gain (a layered sound\'s gain, a classic sound\'s volume) that brings sounds, or a set\'s members, to a loudness, as one undo group. With no `to`, each sound goes to its own class target; ' +
      '`to` is a class name (the sounds join that class) or target=<LUFS> (the sounds are held to it). Several sounds: the ones that can reach the target are normalized and the others are listed as "not normalized" with why (an error only when none could); a sound that lands inside its class tolerance counts as done, with a warning. A classic sound cannot go above volume 1: the warning says how far it falls short (sound layer-up lets gain go to 4). A song takes target=<LUFS> or nothing; a song with layers gets the song gain and the gains of the channels above the base chosen so every mix a game can play fits the class window. The same word works as a line of a run batch.',
    inputSchema: z.object({ sounds: z.array(z.string()).min(1).describe('Sound ids and set names'), to: z.string().optional().describe('A class name, or target=<LUFS>') }),
  }, (a) => w.enqueue(() => {
    try {
      const n = normalizePlan(w, a.to === undefined ? a.sounds : [...a.sounds, a.to]);
      const warn = [...n.notes.map((x) => `warning: ${x}`), ...failureLines(n)];
      if (!n.commands) return { content: [text([`${n.already}: nothing to write`, ...(n.info ? [n.info] : []), ...warn].join('\n'))] };
      const r = w.run({ commands: n.commands, by: AGENT });
      if (!r.ok) return fail(formatErrors('normalize', r.errors));
      const song = a.sounds.length === 1 && w.hasSong(a.sounds[0]!) ? [songSummary(w, a.sounds[0]!)] : [];
      return { content: [text([...(n.info ? [n.info] : []), ...warn, `normalized ${n.what} as group ${r.group}`, ...r.added.map((e) => `  #${e.seq} ${e.cmd}`), ...song].join('\n'))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('import', {
    title: 'Import sfxr, jsfxr and bfxr patches',
    description: 'Make classic sounds from patches. kind sfxr (default): the engine\'s synth.csv (one sound per row, the key column is the id) or a single-patch text, or a path to either; kind jsfxr: jsfxr\'s base58 / sfxr.me URL-hash form or its JSON form; kind bfxr: Bfxr\'s comma-separated settings string. Several strings: one per line, "<id> <string>". NA and missing cells take the defaults. Each row is reported as exact or approximated, with what the classic voice could not keep. One undo group; any error applies nothing.',
    inputSchema: z.object({
      source: z.string().describe('The csv, patch or string(s), or a path to a file holding them'),
      kind: z.enum(['sfxr', 'jsfxr', 'bfxr']).optional().describe('Default sfxr (which also recognises a jsfxr string)'),
      id: z.string().optional().describe('The sound id for a single patch'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      const { commands, ids, warnings, report } = importCommands(a.source, a.id ?? null, a.kind ?? 'sfxr');
      const r = w.run({ commands, by: AGENT });
      if (!r.ok) return fail(formatErrors('import', r.errors));
      const approx = report.filter((x) => x.status === 'approximated');
      return { content: [text([...warnings.map((x) => `warning: ${x}`), `imported ${plural(ids.length, 'sound')}${ids.length <= 8 ? ` (${ids.join(', ')})` : ''} as group ${r.group}: ${report.length - approx.length} exact, ${approx.length} approximated`, formatImportReport(report.length <= 8 ? report : approx), ...(ids.length <= 8 ? r.touched.map((id) => soundSummary(w, id)) : [])].join('\n'))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('sample', {
    title: 'Sample',
    description: 'Samples: audio kept once by content in the project (samples/objects) and named on the history tape, with where it came from and its licence. import: a WAV, AIFF or FLAC file (OGG, MP3 and M4A through ffmpeg when it is installed), or every audio file in a folder (one undo group), under a name (default: the file name); channels are kept; licence defaults to unknown (set it: licence=CC0-1.0, CC-BY-4.0, own, ...); then `layer add <id> sample sample=<name> ...` plays it (side=stereo for both channels). list / show: the samples and everything about one (metadata, provenance, licence, who uses it). Change a sample with `run`: `sample set <name> licence=CC0-1.0 root=C4 tags=wood,door`, `sample rename <old> <new>`, `sample remove <name>` (the tape commands). gc: objects nothing references (a dry run unless apply; drop_history also drops those only undone or replaced states used, and lists the versions that stop rendering). upgrade: move a 0.1 project\'s samples/*.wav into the store.',
    inputSchema: z.object({
      action: z.enum(['import', 'list', 'show', 'check', 'gc', 'upgrade']),
      file: z.string().optional().describe('import: path of the audio file or folder'),
      name: z.string().optional().describe('show, check: the sample'),
      names: z.array(z.string()).optional().describe('check: samples (all when none)'),
      query: z.string().optional().describe('list: a numbers query that keeps the samples it fits, closest first, like "creak" dur=0.8-2.5 lufs>-30 centroid<2.5k pitched=no onsets=1 tag=wood source=file licence=shippable'),
      json: z.boolean().optional().describe('list: JSON'),
      as: z.string().optional().describe('import: the sample\'s name (letters, digits, _ and -; the case is kept)'),
      licence: z.string().optional().describe('import: CC0-1.0, CC-BY-4.0, own, unknown (default), generated:<provider>:<plan>, proprietary:<note>'),
      attribution: z.string().optional().describe('import: the attribution text a licence asks for'),
      terms: z.string().optional().describe('import: a terms address'),
      tags: z.string().optional().describe('import: comma-separated tags'),
      source: z.enum(['file', 'library', 'recorded', 'generated', 'derived', 'bounce', 'instrument-import']).optional().describe('import: where the audio came from (default file)'),
      origin: z.string().optional().describe('import: the origin to record (a file name or an address; default the file name)'),
      note: z.string().optional().describe('import: a note'),
      force: z.boolean().optional().describe('import: past the store\'s 1 GB limit'),
      apply: z.boolean().optional().describe('gc: delete (default a dry run)'),
      drop_history: z.boolean().optional().describe('gc: also drop objects only undone or replaced states used'),
      by: z.string().optional().describe('the author on the tape (default agent:claude)'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      if (a.action === 'list') return { content: [text(sampleListText(w, a.query, { json: !!a.json }))] };
      if (a.action === 'check') return { content: [text(sampleCheckText(w, a.names ?? (a.name ? [a.name] : [])))] };
      if (a.action === 'show') return a.name ? { content: [text(sampleShowText(w, a.name))] } : fail('show needs name');
      if (a.action === 'gc') {
        const plan = gcPlan(w, !!a.drop_history);
        if (a.apply) gcApply(w, plan);
        return { content: [text(gcReport(plan, !!a.apply))] };
      }
      if (a.action === 'upgrade') {
        const r = upgradeProject(w);
        return { content: [text(`${r.moved.length ? `moved ${plural(r.moved.length, 'sample')} into the store (${r.moved.join(', ')}) as group ${r.group}` : 'nothing to upgrade'}${r.skipped.map((x) => `\nwarning: ${x}`).join('')}`)] };
      }
      if (!a.file) return fail('import needs file');
      const r = importPath(w, a.file, { ...(a.as ? { as: a.as } : {}), ...(a.licence ? { licence: a.licence } : {}), ...(a.attribution ? { attribution: a.attribution } : {}), ...(a.terms ? { terms: a.terms } : {}), ...(a.tags ? { tags: a.tags } : {}), ...(a.source ? { source: a.source } : {}), ...(a.origin ? { origin: a.origin } : {}), ...(a.note ? { note: a.note } : {}), force: !!a.force, by: agentName(a.by) });
      return { content: [text(`${importReport(r, sampleLine)}\n${plural(r.items.length, 'sample')}${r.group ? ` as group ${r.group}` : ''}`)] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('instrument_import', {
    title: 'Import an SFZ or SoundFont 2 file as a sampled instrument',
    description: 'Read an .sfz or .sf2 file on the machine running the server into this project as a sampled instrument: the samples go into the store (provenance: the file and the path inside it; licence unknown unless given) and the regions or preset zones become `instrument zone add` lines, all as one undo group. ' +
      'SFZ covers <control> <global> <master> <group> <region>, #define, #include, default_path and the key, velocity, pitch, level, pan, envelope, loop, offset, release, round-robin and choke opcodes; a SoundFont 2 file imports one preset (preset: <bank>:<program> or a name; list: true lists them). ' +
      'Every other opcode or generator is named in the answer, per region or zone, as lost or approximated. A sample that cannot be read names its region and nothing is written. Then `check` and `view` (keymap) the instrument.',
    inputSchema: z.object({
      path: z.string().describe('The .sfz or .sf2 file'),
      id: z.string().optional().describe('The instrument id (default: the file name, or the preset name)'),
      preset: z.string().optional().describe('SoundFont: <bank>:<program> or a preset name'),
      list: z.boolean().optional().describe('SoundFont: list the presets and import nothing'),
      licence: z.string().optional().describe('CC0-1.0, CC-BY-4.0, own, unknown (default), proprietary:<note>'),
      attribution: z.string().optional(),
      terms: z.string().optional(),
      tags: z.string().optional().describe('comma-separated tags for the samples'),
      prefix: z.string().optional().describe('put in front of the sample names (default <id>_)'),
      by: z.string().optional().describe('the author on the tape (default agent:claude)'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      if (a.list) {
        if (!isSoundFont(a.path)) return fail('error: list is for .sf2 files');
        return { content: [text(soundFontList(a.path))] };
      }
      const r = importInstrument(w, a.path, {
        ...(a.id ? { id: a.id } : {}), ...(a.preset ? { preset: a.preset } : {}), ...(a.licence ? { licence: a.licence } : {}), ...(a.attribution ? { attribution: a.attribution } : {}),
        ...(a.terms ? { terms: a.terms } : {}), ...(a.tags ? { tags: a.tags } : {}), ...(a.prefix !== undefined ? { prefix: a.prefix } : {}), by: agentName(a.by),
      });
      return { content: [text(formatInstrumentImport(r, a.path))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('library', {
    title: 'Sample libraries',
    description: 'Search the user\'s sample libraries (folders of recordings registered with `soundclaw library add`, outside any project) and copy a file into this project. list: the libraries and whether they are indexed. search: query is words (all must match names, tags and folders) and a numbers query, like "creak" dur=0.8-2.5 lufs>-30 centroid<2.5k attack<20ms pitched=no onsets=1 loop=no channels=1 tag=wood licence=shippable; hits come best word match first, then nearest the middle of the ranges. similar: files nearest a sound of the project, sample:<name> or an audio file path (ref), optionally filtered by a query. use: ref is <library>:<path> from a hit; it copies the file into the project\'s sample store as source=library with the library\'s licence (override with licence), and then `layer add <sound> sample sample=<name>` plays it. Hits are one JSON object per line (ref, dur, lufs, note, centroid, attack, licence, state, desc); format=text prints the CLI lines. add: register a folder (dir) as a library for this user, with licence (or yes to accept the licence its LICENSE file reads as; a soundclaw-library.json declares it outright). index: read and measure the files of the libraries named in ids (all when none; only changed files unless rebuild); it can take minutes and does not hold up other tools. Removing a library is the person\'s step (CLI: soundclaw library remove).',
    inputSchema: z.object({
      action: z.enum(['list', 'search', 'similar', 'use', 'add', 'index']),
      query: z.string().optional().describe('search, similar: words and a numbers query'),
      dir: z.string().optional().describe('add: the folder to register'),
      name: z.string().optional().describe('add: the library id (default: from the folder\'s name)'),
      yes: z.boolean().optional().describe('add: accept the licence read from the folder\'s licence file'),
      ids: z.array(z.string()).optional().describe('index: the libraries (default: all)'),
      rebuild: z.boolean().optional().describe('index: measure every file again'),
      library: z.string().optional().describe('search, similar: only this library'),
      limit: z.number().int().min(1).max(200).optional().describe('search (default 20), similar (default 10)'),
      ref: z.string().optional().describe('similar: a sound id, sample:<name> or an audio file; use: <library>:<path>'),
      format: z.enum(['json', 'text']).optional().describe('hits as JSON lines (default) or text lines'),
      as: z.string().optional().describe('use: the sample\'s name (default: the file\'s)'),
      licence: z.string().optional().describe('use: a licence id to write instead of the library\'s; add: the library\'s licence'),
      attribution: z.string().optional().describe('use, add: attribution text'),
      terms: z.string().optional().describe('use, add: a terms address'),
      tags: z.string().optional().describe('use: comma-separated tags to add'),
      note: z.string().optional().describe('use: a note'),
      by: z.string().optional().describe('use: the author on the tape (default agent:claude)'),
    }),
  }, async (a) => {
    // add and index change no project: index measures files on worker threads for minutes, so it runs outside the writer's queue
    if (a.action === 'add' || a.action === 'index') {
      try {
        if (a.action === 'add') {
          if (!a.dir) return fail('add needs dir (a folder)');
          const r = addLibrary(a.dir, { ...(a.name ? { name: a.name } : {}), ...(a.licence ? { licence: a.licence } : {}), ...(a.attribution ? { attribution: a.attribution } : {}), ...(a.terms ? { terms: a.terms } : {}), yes: !!a.yes });
          return { content: [text(`added library '${r.entry.id}' (${r.entry.dir})\n${r.notes.map((n) => `  ${n}\n`).join('')}next: library index with ids ["${r.entry.id}"]`)] };
        }
        const ids = a.ids?.length ? a.ids : readRegistry().map((l) => l.id);
        if (!ids.length) return fail('no libraries registered: add one first (action add, dir=<folder>)');
        const lines: string[] = [];
        for (const id of ids) lines.push(indexStatsText(await indexLibrary(id, { rebuild: !!a.rebuild })));
        return { content: [text(lines.join('\n'))] };
      } catch (e) {
        return errorResult(e);
      }
    }
    return w.enqueue(() => libraryInQueue(a));
  });

  const libraryInQueue = (a: { action: string; query?: string; library?: string; limit?: number; ref?: string; format?: 'json' | 'text'; as?: string; licence?: string; attribution?: string; terms?: string; tags?: string; note?: string; by?: string }): CallToolResult => {
    {
    try {
      const hits = (r: SearchResult, head?: string): CallToolResult => {
        const st = stateUnder(w.samples.shipPolicy);
        if (a.format === 'text') return { content: [text((head ? head + '\n' : '') + searchText(r, st))] };
        const lines = r.hits.map((h) => JSON.stringify(hitJson(h, st)));
        return { content: [text([`${head ? head + ': ' : ''}${r.hits.length}${r.total > r.hits.length ? ` of ${r.total}` : ''} hit${r.hits.length === 1 ? '' : 's'}${r.notIndexed.length ? `; not indexed (CLI: soundclaw library index): ${r.notIndexed.join(', ')}` : ''}`, ...lines].join('\n'))] };
      };
      if (a.action === 'list') return { content: [text(listText(listLibraries()))] };
      if (a.action === 'search') return hits(searchLibraries(a.query ?? '', { library: a.library, limit: a.limit ?? 20, policy: w.samples.shipPolicy }));
      if (a.action === 'similar') {
        if (!a.ref) return fail('similar needs ref (a sound id, sample:<name> or an audio file)');
        const r = similarLibraries(w, a.ref, a.query ?? '', { library: a.library, limit: a.limit ?? 10, policy: w.samples.shipPolicy });
        return hits(r, `like ${r.reference}`);
      }
      if (!a.ref) return fail('use needs ref (<library>:<path>)');
      const r = useLibraryFile(w, a.ref, { ...(a.as ? { as: a.as } : {}), ...(a.licence ? { licence: a.licence } : {}), ...(a.attribution ? { attribution: a.attribution } : {}), ...(a.terms ? { terms: a.terms } : {}), ...(a.tags ? { tags: a.tags } : {}), ...(a.note ? { note: a.note } : {}), by: a.by ?? AGENT });
      return { content: [text(`${importReport(r, sampleLine)}\n${plural(r.items.length, 'sample')}${r.group ? ` as group ${r.group}` : ''}`)] };
    } catch (e) {
      return errorResult(e);
    }
    }
  };

  server.registerTool('generate', {
    title: 'Generate audio',
    description: 'Make sound effects (or music) from a prompt with an AI provider and keep each take as a sample (<as>_t1, <as>_t2, ...: numbered after takes already there) with its provenance (provider, model, prompt, parameters, take, request id, credits) and the licence the provider\'s plan gives, as one undo group. Every cap is checked before the first call, and nothing is called if one would be passed: one take at most the per-call maximum (300 credits by default), the whole command within what is left of the project\'s cap (project.json "generation": {"capCredits": n}; 0 by default, so paid generation is off until a person sets one) and of the user\'s daily cap (3000). estimate: true prints the cost and the budget and calls nothing: use it first. Paid providers are refused in CI and with SOUNDCLAW_NO_PAID=1; provider "fake" makes test audio for free. Each take comes back with its numbers and words; want (a numbers query) and like (a sound or sample:<name>) rank them. Write the prompt as a sound designer would: the source, the action, the material, the space ("the slow creak of an old wooden door hinge, close, dry, no reverb"). again: a generated sample\'s prompt and parameters for new takes (not the same audio). action ledger: what this project has spent; config: the user\'s generation settings.',
    inputSchema: z.object({
      action: z.enum(['generate', 'ledger', 'config']).optional().describe('generate (default), ledger, config'),
      kind: z.enum(['sfx', 'music']).optional().describe('sfx (default) or music (held until the user turns it on)'),
      prompt: z.string().optional().describe('what the sound is, in words'),
      duration: z.number().optional().describe('seconds (sfx 0.5-30, default 2; music 10-300, default 30)'),
      takes: z.number().int().min(1).max(4).optional().describe('takes, one call each (default 1)'),
      loop: z.boolean().optional().describe('sfx: a seamless loop'),
      influence: z.number().min(0).max(1).optional().describe('sfx: how closely the audio follows the prompt (0-1)'),
      model: z.string().optional().describe('the provider\'s model id (default: its sound effects or music model)'),
      as: z.string().optional().describe('the takes are <as>_t1, ... (default: words of the prompt)'),
      want: z.string().optional().describe('a numbers query to rank the takes by, like "dur=1.5-2.5 centroid<2.5k attack<40ms"'),
      like: z.string().optional().describe('a sound or sample:<name> to rank the takes by closeness to'),
      provider: z.string().optional().describe('elevenlabs or fake (default: the user\'s setting, else elevenlabs)'),
      tags: z.string().optional().describe('comma-separated tags for the takes'),
      composition: z.string().optional().describe('music: a composition plan as JSON text, instead of the prompt'),
      again: z.string().optional().describe('a generated sample: new takes with its recorded prompt and parameters (takes and as may change)'),
      estimate: z.boolean().optional().describe('the cost and the budget only; nothing is called'),
      by: z.string().optional().describe('the author on the tape (default agent:claude)'),
    }),
  }, async (a) => {
    try {
      if (a.action === 'config') return { content: [text(configText(readGenerationConfig()))] };
      if (a.action === 'ledger') return { content: [text(ledgerText(ledgerTotals(w.project.dir), w.project.dir))] };
      const pairs: Record<string, string> = {};
      for (const k of ['duration', 'takes', 'influence', 'model', 'as', 'want', 'like', 'provider', 'tags', 'composition'] as const) if (a[k] !== undefined) pairs[k] = String(a[k]);
      if (a.loop !== undefined) pairs.loop = a.loop ? 'yes' : 'no';
      const body = a.again
        ? { again: a.again, pairs: Object.fromEntries(Object.entries(pairs).filter(([k]) => k === 'takes' || k === 'as')), estimate: !!a.estimate, by: agentName(a.by) }
        : { kind: a.kind ?? 'sfx', prompt: a.prompt ?? '', pairs, estimate: !!a.estimate, by: agentName(a.by) };
      const r = await generateFromBody(w, body, w.project.dir);
      return { content: [text(r.text)] };
    } catch (e) {
      return errorResult(e);
    }
  });

  server.registerTool('licence', {
    title: 'Licence check',
    description: 'Where sounds, sets, songs, instruments and samples stand on licences: each item\'s worst state over every sample it reaches (shippable, attribution, unknown, blocked) and the samples behind it. Manifest exports (export with all, a set or pack) refuse items that reach a blocked or unknown licence unless allow_licence names it. The project\'s policy is project.json "licences": {"allow": [...], "block": [...]}; the default ships own, CC0-1.0, CC-BY-* (with ATTRIBUTION.txt) and generated audio from a paid plan, and blocks unknown, -NC, -ND and free-plan generated audio. SoundClaw records licences; it gives no legal advice.',
    inputSchema: z.object({
      ids: z.array(z.string()).optional().describe('Sounds, sets, songs, instruments or samples to check (default: every sound, instrument and song)'),
      allow_licence: z.array(z.string()).optional().describe('Licence ids to let through in this check'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      return { content: [text(licenceReportText(licenceCheck(w, a.ids ?? [], a.allow_licence ?? []), licencePolicyNote(w)))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('export', {
    title: 'Export sounds',
    description: 'Write sounds to a folder (default <project>/exports, which git ignores). format wav (default): 16-bit PCM, 44,100 Hz; classic sounds as the engine\'s pre-rendered WAVs (trunc(s x 32000), mono); layered sounds through a limiter at the style\'s true-peak ceiling (mono, or stereo when a layer is panned). ogg: Vorbis, variable bitrate (quality -0.1 to 1, default 0.4). With all, a set, pack or ogg, manifest.json is written beside the files (id, file, duration, loudness, channels, loop points, set). patch: a single-patch text per classic sound. csv: one synth.csv for the classic sounds. Without sounds, all of them; `set` exports a set\'s members; `pack` makes a flat folder where sounds marked classic become rows of synth.csv.',
    inputSchema: z.object({
      sounds: z.array(z.string()).optional().describe('The sounds to export (default all)'),
      set: z.string().optional().describe('Export the members of this set'),
      all: z.boolean().optional().describe('Every sound, with a manifest'),
      format: z.enum(['wav', 'ogg', 'patch', 'csv', 'midi', 'sfz']).optional().describe('Default wav (a song: wav, ogg or midi; a sampled instrument: sfz, with its samples as WAV files and ATTRIBUTION.txt when a licence asks for it)'),
      loop: z.boolean().optional().describe('A song: its loop region (seamless)'),
      stems: z.boolean().optional().describe('A song: one aligned file per game layer'),
      loops: z.number().int().min(1).max(16).optional().describe('A song: the loop region repeated this many times (in a full export, a loop export or the stems)'),
      stemsThroughMaster: z.boolean().optional().describe('A song, with stems: run the master chain\'s filters over each stem (its compressor and limiter cannot be split, so the stems sum louder than the mix)'),
      pattern: z.string().optional().describe('A song, midi: one pattern instead of the song'),
      out: z.string().optional().describe('The folder to write into'),
      pack: z.boolean().optional().describe('Pack layout: classic-marked sounds as synth.csv rows, the rest as audio, in one flat folder'),
      quality: z.number().min(-0.1).max(1).optional().describe('OGG quality'),
      allow_licence: z.array(z.string()).optional().describe('Licence ids to let through a manifest export (all, set, pack) although the project\'s policy blocks them; written into the manifest'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      const names = a.sounds ?? [];
      if (names.length && names.every((x) => isProjectInstrument(w, x))) return { content: [text(names.map((id) => formatInstrumentExport(exportInstrument(w, id, { format: a.format ?? 'sfz', out: a.out }))).join('\n'))] };
      if (a.format === 'sfz') return fail('error: sfz is for sampled instruments (name an instrument)');
      if (names.length && names.every((x) => w.hasSong(x))) {
        const f = a.format ?? 'wav';
        if (f !== 'wav' && f !== 'ogg' && f !== 'midi') return fail('error: a song exports as wav, ogg or midi');
        return { content: [text(names.map((id) => formatSongExport(exportSong(w, id, { format: f, loop: a.loop, stems: a.stems, loops: a.loops, stemsThroughMaster: a.stemsThroughMaster, pattern: a.pattern, out: a.out, quality: a.quality }))).join('\n'))] };
      }
      if (a.format === 'midi') return fail('error: midi is for songs');
      return { content: [text(formatExportFiles(exportFormat(w, names, a.format ?? 'wav', { out: a.out, set: a.set, all: a.all, pack: a.pack, quality: a.quality, allowLicence: a.allow_licence })))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('midi', {
    title: 'Import a MIDI file as a song',
    description: 'Make a song from a Standard MIDI file (type 0 or 1): one pattern per two bars, a channel per track and MIDI channel, drums on channel 10 as a drum channel; timings go to the nearest step (the tempo, time signature and steps per beat are chosen from the file). ' +
      'path is the .mid file on the machine running the server; id names the song. Export is the export tool with format midi.',
    inputSchema: z.object({ path: z.string(), id: z.string().optional().describe('The song id (default: the file name)') }),
  }, (a) => w.enqueue(() => {
    try {
      if (!existsSync(a.path)) return fail(`error: no such file ${a.path}`);
      const base = (a.path.split('/').pop() ?? 'song').replace(/\.(mid|midi)$/i, '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z]+/, '') || 'song';
      const id = a.id ?? base.slice(0, 48);
      const imp = midiImportScript(new Uint8Array(readFileSync(a.path)), id);
      const r = w.run({ commands: imp.script, by: AGENT });
      if (!r.ok) return fail(formatErrors('midi import', r.errors));
      return { content: [text([...imp.notes.map((x) => `warning: ${x}`), `imported ${id}: ${imp.summary}, as group ${r.group}`, songSummary(w, id)].join('\n'))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  // Filing, answering and withdrawing requests: what the dashboard's buttons do.
  server.registerTool('request', {
    title: 'File, answer or withdraw a request',
    description: 'Ask for a change the way the dashboard does: action "request" (the default) with sound and a note saying what should change (this also writes `sound mark <sound> rejected "<note>"` on the history). ' +
      '`sound` may also be `sample:<name>`: a request about a sample itself (no mark, no check holds its `done`; the brief shows the sample). action "reply" answers a blocked request (id, text) and opens it again; "cancel" withdraws one (id, optional text). Returns the request as it stands.',
    inputSchema: z.object({
      action: z.enum(['request', 'reply', 'cancel']).optional().describe('Default request'),
      sound: z.string().optional().describe('request: the sound or song, or sample:<name> for a sample itself'),
      note: z.string().optional().describe('request: what should change (may be left out when tags say it)'),
      tags: z.array(z.enum(['too loud', 'too quiet', 'too long', 'too short', 'too harsh', 'too dull', 'too similar to another sound', 'good'])).optional().describe('request: the cards\' quick tags (good alone is praise: no mark)'),
      like: z.string().optional().describe('request with the tag too similar to another sound: the other sound'),
      target: z.union([z.string(), z.object({ kind: z.enum(['range', 'bars', 'param', 'layer', 'item']) }).passthrough()]).optional().describe('request: what inside the sound or song it points at, as the dashboard\'s selection does: {kind:"range",start,end} (seconds), {kind:"bars",from,to,channel?}, {kind:"param",param,layer?,fx?}, {kind:"layer",layer}, {kind:"item"}; or text: "range 0.31-0.38", "bars 9-12 lead", "param decay layer 2 fx 1", "layer 2", "item"'),
      again: z.string().regex(/^r\d+$/).optional().describe('request: the done request this one asks again about'),
      id: z.string().regex(/^r\d+$/).optional().describe('reply, cancel: the request'),
      text: z.string().optional().describe('reply: the answer; cancel: why'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      const q = personRequest(w, AGENT, toPersonRequest({ ...a, other: a.like }));
      w.requestsChanged();
      return { content: [text(requestLine(q))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('work', {
    title: 'Work on requests',
    description: 'The request queue: what people asked for in the dashboard. ' +
      'With no action (or action "next"), claim the next open request (or the one named by id) and get what is asked, with the sound as it stands. ' +
      'action "progress" posts a short note the person sees; "done" finishes it with what changed; "blocked" stops it with one clear question for the person (they answer in the dashboard and it opens again). ' +
      '"list" shows every request still open, claimed or blocked.',
    inputSchema: z.object({
      action: z.enum(['next', 'progress', 'done', 'blocked', 'list']).optional(),
      id: z.string().regex(/^r\d+$/).optional().describe('A request id (default: the next open one, or the one you claimed)'),
      text: z.string().optional().describe('progress: a short note; done: what changed; blocked: the question'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      const action = a.action ?? 'next';
      if (action === 'list') {
        w.hub.touch(AGENT);
        const active = openRequests(readRequests(w.project));
        // Listing hands the open requests over: they are now seen.
        markSeen(w, active.filter((x) => x.state === 'open').map((x) => x.id), AGENT);
        return { content: [text(active.length ? active.map((q) => requestLine(q)).join('\n') : 'no open requests')] };
      }
      const r = action === 'next' ? agentWork(w, AGENT, { action, id: a.id }) : agentWork(w, AGENT, { action, id: a.id, text: a.text ?? '' });
      w.requestsChanged();
      if (!r.request) return { content: [text(r.message)] };
      if (action !== 'next') {
        const left = openRequests(readRequests(w.project)).filter((x) => x.state === 'open').length;
        return { content: [text(`${r.message}${action === 'progress' ? '' : `. ${left ? `${plural(left, 'open request')} left: call work for the next.` : 'No open requests left.'}`}`)] };
      }
      return { content: [text(`${r.message}\n${requestBrief(w, r.request, MCP_STEPS)}`)] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  // Waiting for people: returns as soon as one files, answers or withdraws a request, or approves or rejects a sound.
  server.registerTool('await_requests', {
    title: 'Wait for requests and feedback',
    description: 'Wait until a person files, answers or withdraws a request, answers a blind A/B comparison, or approves or rejects a sound in the dashboard, then return what happened (with the next step: `work` claims a request, `history` reads a mark). ' +
      'Returns empty when the timeout passes. Pass back the returned cursor as `cursor` so nothing is missed or repeated; with none, requests still open and unseen are returned. ' +
      'While you are waiting the dashboard shows that an agent is listening, and the requests handed to you are marked seen. A model is not woken by anything else, so for long waits between tasks run `soundclaw await <project>` in the background instead (its exit wakes you).',
    inputSchema: z.object({
      timeout: z.number().int().min(1).max(120).optional().describe('Seconds to wait (default 30, at most 120)'),
      cursor: z.string().optional().describe('The cursor the last call returned'),
    }),
  }, async (a, extra) => {
    try {
      const r = await awaitRequests(w, { cursor: a.cursor, timeoutS: Math.min(120, a.timeout ?? 30), by: AGENT, via: 'mcp', signal: (extra as { signal?: AbortSignal } | undefined)?.signal });
      return { content: [text(formatEvents(r.events, r.cursor))] };
    } catch (e) {
      return errorResult(e);
    }
  });

  return server;
}
