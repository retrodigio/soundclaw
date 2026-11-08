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
import { checkText, describeJson, describeText, exportFormat, measureJson, measureText, formatExportFiles, formatImportReport, importCommands, renderText, setSummary, viewSound } from './ears.ts';
import { normalizePlan } from './normalize.ts';
import { ProjectError } from './project.ts';
import { formatErrors, plural, tapeEntryLines } from './report.ts';
import { MCP_STEPS, agentWork, awaitRequests, listenerNote, markSeen, personRequest, readRequests, requestBrief, requestLine, toPersonRequest } from './requests.ts';
import { historyText, soundSummary } from './summary.ts';
import { SONG_VIEWS, exportSong, formatSongExport, listInstruments, midiImportScript, songChecksText, songJsonObject, songNumbersText, songSummary, viewSong, type SongViewKind } from './songs.ts';
import { readFileSync } from 'node:fs';
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
  layer add <id> classic|osc|fm|ks|sample [<param>=<value> ...] [at=<n>]   osc: wave sine|square|saw|triangle|pulse|wavetable|white|pink|brown|metal, freq, duty, dur; fm: ops 2-4, algo, ratio1-4, index2-4; ks (pluck): freq, decay, bright; sample: sample=<name>, start, end, pitch, reverse; every layer: offset, gain, pan, filter=off|lp|hp|bp|notch, cutoff, q
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
  instrument new <id> [from=<built-in>|kind=osc|fm|ks|classic|sample]   instrument from-sound <id> <sound> [root=<note>]   instrument set <id> root= pitched= adsr=a,d,s,r velocity= range=C3-C6 pitchenv= gain=   instrument layer|fx|env …   (built-ins: square_lead pulse_lead triangle_bass saw_pad fm_bell fm_bass pluck kick snare hat hat_open: use them by name)
  song new <id> [tempo=] [swing=] [time=4/4] [key=A:minor] [class=music|stinger]   song channel add <song> <name> inst=<instrument>|kit=default [gain=] [pan=] [layer=base|tension|combat]   song section add <song> <name> <pattern>… [x2]   song loop <song> <from>..<to>|off   song intro|ending <song> <section>   song fx add <song> compress|limit …
  pattern <song>.<name> steps=16 tpb=4 bar=8, then indented rows: \`lead: C5 . E5 - | G5v80 . E5~slide .\` (. rest, - hold, | bars, v velocity, ! outside the key on purpose, ~slide ~vib ~arp(0,4,7), chords C4+E4+G4, lower-case words are drum hits)
  One note at a time: \`pattern note add|remove|move|len|set <song>.<pattern> <channel> <step> …\` (add E5 len=2; move step=6 note=G5; set vel=80 fx=~slide). A person's edits in the music editor are these commands: call \`changes\` before editing a song a person touched.
  Helpers write notes into patterns (on the tape with the rows they wrote; edit the rows afterwards like any pattern): \`chords <song> <pattern> <channel> "i VI III VII" [bars=1] [rhythm=hold|beats|offbeat|"x-.x"] [range=G3-G5]\` (roman numerals in the song's key: V7 ii65 bVII V/V Vsus4), \`bass <song> <pattern> <channel> "<progression>"|from=<chord channel> style=root|root-fifth|walking|octave\`, \`arp … pattern=up|down|updown|random(7) rate=1/16\`, \`drums <song> <pattern> <channel>[,<hats>] rock|halftime|shuffle|march|waltz|pulse|chip… fill=4 seed=1\`, \`humanise <song> <pattern> <channel>|all timing=8 velocity=6 seed=1\`, \`motif set|transpose|invert|retrograde|augment|diminish|write|sequence …\`, \`layer-plan <song> base=<ch,…> tension=… combat=…\`. \`song new <id> from-bible=<entry>\` sets a song up from music-bible.md; \`song new <id> kind=stinger template=victory|game-over|level-up|item-get\` writes a stinger. The \`scale\` tool lists a key's notes and chords; \`style\` shows music-style.md and music-bible.md.
  Songs have the views notes (written notes against what the render plays, per channel) and mix (energy by band over time, masking in amber); the checks key, range, render-match, loop-music, masking and voice-leading (advisory), style (music-style.md and the song's bible entry), layers (each game layer alone and with the base) and clip, loudness, dc on the mix. \`normalize\` writes the song's gain; \`export\` writes wav/ogg, --loop (seamless), --stems (one per game layer), midi.

Loudness classes: \`sound set <id> class=ui|foley|impact|ambience|voice|music-sting\` (or loudness=<LUFS>); the loudness check holds each sound to its class (standard: -16 LUFS ±1) and says which applied. \`normalize\` writes the gain that brings sounds to their class; \`measure\` returns the numbers and checks of many sounds as JSON in one call. Dynamics: \`fx add <id> compress|limit\` (a limiter on the master chain lets a spiky sound be loud without clipping). Many hits in one layer: \`env <id> 1.amp bursts(times=0.1,0.3 ...)\`. \`sound copy|rename|remove <id> ...\` manage sounds.

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
      kind: z.enum(['wave', 'spec', 'pitch', 'layers', 'loop', 'set', 'compare', 'notes', 'mix']).optional().describe('Default spec (a song: notes, mix, wave, spec, loop; default notes)'),
      other: z.string().optional().describe('compare: the second sound, song, or the path of a WAV or OGG file (a reference outside the project; `sound` may be a file too)'),
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
      if (a.kind === 'notes' || a.kind === 'mix') return fail(`error: ${a.kind} is a view of a song (${a.sound} is a sound)`);
      const v = viewSound(w, a.sound, a.kind ?? 'spec', { other: a.other });
      return { content: [{ type: 'image' as const, data: Buffer.from(v.png).toString('base64'), mimeType: 'image/png' }, text(v.text)] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('describe', {
    title: 'Describe a sound',
    description: 'A plain-words summary built only from the measured numbers (length, tonal or noisy, brightness, pitch motion, attack, tail, peak, loudness, onsets), then the numbers and the check summary.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({ sound: z.string(), json: z.boolean().optional().describe('The result as one JSON object') }),
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
    inputSchema: z.object({ sounds: z.array(z.string()).optional().describe('Sound ids and set names'), json: z.boolean().optional().describe('One JSON document with every number and every check (as measure)') }),
  }, (a) => w.enqueue(() => {
    try {
      const ids = a.sounds ?? [];
      const songIds = ids.length ? ids.filter((x) => w.hasSong(x)) : w.songs().map((x) => x.id);
      const soundIds = ids.filter((x) => !w.hasSong(x));
      const only = (ids.length > 0 && !soundIds.length) || (ids.length === 0 && !w.sounds().length && !w.sets().length && songIds.length > 0);
      if (a.json) {
        const doc = JSON.parse(only ? '{}' : measureJson(w, soundIds).json) as Record<string, unknown>;
        if (songIds.length) doc.songs = songIds.map((x) => songJsonObject(w, x));
        return { content: [text(JSON.stringify(doc, null, 2))] };
      }
      return { content: [text([only ? '' : checkText(w, soundIds).text, ...songIds.map((x) => songChecksText(w, x).text)].filter(Boolean).join('\n\n'))] };
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
    inputSchema: z.object({ sounds: z.array(z.string()).optional().describe('Sound ids and set names (default all)'), json: z.boolean().optional().describe('Default true; false gives text') }),
  }, (a) => w.enqueue(() => {
    try {
      const ids = a.sounds ?? [];
      const songIds = ids.length ? ids.filter((x) => w.hasSong(x)) : w.songs().map((x) => x.id);
      const soundIds = ids.filter((x) => !w.hasSong(x));
      const only = (ids.length > 0 && !soundIds.length) || (ids.length === 0 && !w.sounds().length && !w.sets().length && songIds.length > 0);
      if (a.json === false) return { content: [text([only ? '' : measureText(w, soundIds).text, ...songIds.map((x) => `${songNumbersText(w, x)}\n${songChecksText(w, x).text}`)].filter(Boolean).join('\n\n'))] };
      const doc = JSON.parse(only ? '{}' : measureJson(w, soundIds).json) as Record<string, unknown>;
      if (songIds.length) doc.songs = songIds.map((x) => songJsonObject(w, x));
      return { content: [text(JSON.stringify(doc, null, 2))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('normalize', {
    title: 'Normalize loudness',
    description: 'Write the gain (a layered sound\'s gain, a classic sound\'s volume) that brings sounds, or a set\'s members, to a loudness, as one undo group. With no `to`, each sound goes to its own class target; ' +
      '`to` is a class name (the sounds join that class) or target=<LUFS> (the sounds are held to it). A classic sound cannot go above volume 1: the warning says how far it falls short (sound layer-up lets gain go to 4). A song takes target=<LUFS> or nothing; a song with layers gets the song gain and the gains of the channels above the base chosen so every mix a game can play fits the class window. The same word works as a line of a run batch.',
    inputSchema: z.object({ sounds: z.array(z.string()).min(1).describe('Sound ids and set names'), to: z.string().optional().describe('A class name, or target=<LUFS>') }),
  }, (a) => w.enqueue(() => {
    try {
      const n = normalizePlan(w, a.to === undefined ? a.sounds : [...a.sounds, a.to]);
      const warn = n.notes.map((x) => `warning: ${x}`);
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
    description: 'Samples for sample layers. import: copy a WAV file, or every .wav in a folder (PCM 8/16/24/32-bit or float, any rate, mixed to mono, at most 120 s each), into <project>/samples/ under a name (default: the file name); then `layer add <id> sample sample=<name> ...` uses it. list: the samples in the project.',
    inputSchema: z.object({
      action: z.enum(['import', 'list']),
      file: z.string().optional().describe('import: path of the WAV file'),
      as: z.string().optional().describe('import: the sample\'s name (letters, digits, _ and -; the case is kept)'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      if (a.action === 'list') {
        const list = w.samples.list();
        return { content: [text(list.length ? list.map((x) => `${x.name}: ${x.seconds.toFixed(3)} s, ${x.rate} Hz, ${x.channels === 1 ? 'mono' : x.channels === 2 ? 'stereo' : `${x.channels} channels`}, sha256 ${x.sha256.slice(0, 12)}`).join('\n') : 'no samples')] };
      }
      if (!a.file) return fail('import needs file');
      if (existsSync(a.file) && statSync(a.file).isDirectory()) {
        const d = w.samples.importDir(a.file);
        w.samplesChanged();
        return { content: [text(`${[...d.imported.map((x) => sampleLine(x.info, x.created)), ...d.problems.map((x) => `warning: ${x}`)].join('\n')}\n${plural(d.imported.length, 'sample')} from ${a.file}`)] };
      }
      const r = w.samples.import(a.file, a.as);
      w.samplesChanged();
      return { content: [text(`${sampleLine(r.info, r.created)}\nsha256 ${r.info.sha256.slice(0, 12)}`)] };
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
      format: z.enum(['wav', 'ogg', 'patch', 'csv', 'midi']).optional().describe('Default wav (a song: wav, ogg or midi)'),
      loop: z.boolean().optional().describe('A song: its loop region (seamless)'),
      stems: z.boolean().optional().describe('A song: one aligned file per game layer'),
      loops: z.number().int().min(1).max(16).optional().describe('A song: the loop region repeated this many times (in a full export, a loop export or the stems)'),
      stemsThroughMaster: z.boolean().optional().describe('A song, with stems: run the master chain\'s filters over each stem (its compressor and limiter cannot be split, so the stems sum louder than the mix)'),
      pattern: z.string().optional().describe('A song, midi: one pattern instead of the song'),
      out: z.string().optional().describe('The folder to write into'),
      pack: z.boolean().optional().describe('Pack layout: classic-marked sounds as synth.csv rows, the rest as audio, in one flat folder'),
      quality: z.number().min(-0.1).max(1).optional().describe('OGG quality'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      const names = a.sounds ?? [];
      if (names.length && names.every((x) => w.hasSong(x))) {
        const f = a.format ?? 'wav';
        if (f !== 'wav' && f !== 'ogg' && f !== 'midi') return fail('error: a song exports as wav, ogg or midi');
        return { content: [text(names.map((id) => formatSongExport(exportSong(w, id, { format: f, loop: a.loop, stems: a.stems, loops: a.loops, stemsThroughMaster: a.stemsThroughMaster, pattern: a.pattern, out: a.out, quality: a.quality }))).join('\n'))] };
      }
      if (a.format === 'midi') return fail('error: midi is for songs');
      return { content: [text(formatExportFiles(exportFormat(w, names, a.format ?? 'wav', { out: a.out, set: a.set, all: a.all, pack: a.pack, quality: a.quality })))] };
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
      'action "reply" answers a blocked request (id, text) and opens it again; "cancel" withdraws one (id, optional text). Returns the request as it stands.',
    inputSchema: z.object({
      action: z.enum(['request', 'reply', 'cancel']).optional().describe('Default request'),
      sound: z.string().optional().describe('request: the sound'),
      note: z.string().optional().describe('request: what should change (may be left out when tags say it)'),
      tags: z.array(z.enum(['too loud', 'too quiet', 'too long', 'too short', 'too harsh', 'too dull', 'too similar to another sound', 'good'])).optional().describe('request: the cards\' quick tags (good alone is praise: no mark)'),
      like: z.string().optional().describe('request with the tag too similar to another sound: the other sound'),
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
