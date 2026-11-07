// soundclaw: new | run | list | history | changes | render | view | describe | check | import | sample | export | request | reply | cancel | work (its actions) | skill (await and serve: entry.ts). A thin layer over @soundclaw/core and the project folder.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTHOR_RE, openRequests, type ViewKind } from '@soundclaw/core';
import {
  EXPORT_FORMATS, sampleLine, changesText, ProjectError, Writer, describeJson, measureJson, measureText, normalizeCommands, soundJson, agentName, agentWork, checkText, cliSteps, createProject, describeText, exportFormat, formatErrors, formatExportFiles, formatRun, historyText, humanName,
  IMPORT_KINDS, formatImportReport, importCommands, loadProject, lockHolder, personRequest, plural, readRequests, renderText, requestBrief, requestLine, setSummary, shellArg, soundSummary, toPersonRequest, viewSound, type ExportFormat, type ImportKind, type Project,
} from '@soundclaw/server';
import { soundclawVersion } from './version.ts';

export interface Io {
  out(s: string): void;
  err(s: string): void;
  stdin(): string;
  now(): string;
  /** Set when the command runs inside a server (a CLI call sent to it): its writer is used instead of a new one. */
  writer?: Writer;
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
        family <sound> near|far|muffled [as=<id>]           the sound heard near, far away or through a wall
        layer add <id> classic|osc|fm|ks|sample [<param>=<value> ...] [at=<n>]
        layer set <id> <n> <param>=<value> ...   layer remove|move|mute|solo <id> <n> [to=<m> | on|off]
        env <id> <target> "<time>:<value>[@lin|exp|hold|ease] ..." | adsr(a,d,s,r[,hold]) | bursts(times=...|count=... over=...) | clear
        fx add <id> [layer=<n>] filter|distort|bitcrush|chorus|delay|reverb|compress|limit [<param>=<value> ...] [at=<k>]
        fx set|remove|move <id> [layer=<n>] <k> ...
        undo [group=<g>] [by=<author>]    redo [group=<undo group>] [by=<author>]   (each alone in its batch)
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
  soundclaw view <project> <id> compare <other> [--out <file.png>]
      The agent's ears as a PNG (saved under <project>/.cache/views, or --out) and the numbers:
      wave (waveform, envelope, clip marks), spec (mel spectrogram with Hz and note rulers),
      pitch (YIN track over a note grid), layers (a layered sound's layers stacked: waveform and
      spectrogram of each, with their start offsets), loop (a looping sound's end joined to its start,
      the two overlapped, the joined spectrogram, and the level across four repeats), set (a set's members side
      by side with loudness bars, and the pairwise distance matrix), compare (two spectrograms and their difference, with
      distance numbers).
  soundclaw describe <project> <id> [--json]
      A plain-words summary built only from the measured numbers, then the numbers (--json: as a JSON object).
  soundclaw measure <project> [<id|set>...] [--json]
      The numbers and the loudness class of many sounds in ONE process (all sounds when none are named): per
      sound its class and target, every number describe prints and every check's result. --json prints one JSON
      document for scripts ({format, pass, sounds: [{id, class, numbers, checks, binding}], sets}); exit 1 when any
      check fails. A sound's loudness class: sound set <id> class=<name> (or loudness=<LUFS> for that sound alone).
  soundclaw normalize <project> <id|set>... [<class> | target=<LUFS>] [--by <author>]
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
  soundclaw sample import <project> <file.wav | folder> [as=<name>]
  soundclaw sample list <project>
      Copy a WAV (PCM 8/16/24/32-bit or float, any rate, at most 120 s) into <project>/samples/ so a
      sample layer can name it (layer add <id> sample sample=<name>). A folder: every .wav in it (as= does
      not apply). The name defaults to the file's name, its case kept (names are unique ignoring case). A name
      that exists with other content is refused (in a folder, reported and the others still go in). A file at
      a rate other than 44,100 Hz is converted by a windowed sinc, and the import says so. A layer plays a
      stereo file as the mix of its channels, or one side of it (side=left, side=right): the whole file in
      stereo is two layers, side=left pan=-1 and side=right pan=1.
  soundclaw export <project> [<id>...] [--all | --set <set>] [--format wav|ogg|patch|csv] [--to <dir>] [--pack] [--quality <q>]
      Default wav: 16-bit PCM, 44,100 Hz (classic sounds as pre-rendered WAVs, trunc(s*32000), mono;
      layered sounds through a limiter at the style's true-peak ceiling, mono or stereo). ogg: Vorbis,
      variable bitrate (--quality -0.1 to 1, default 0.4). With --all, --set, --pack or ogg, manifest.json
      is written beside the files: id, file, duration, loudness, channels, loop points, set. patch: <id>.sfxr single-patch
      text; csv: one synth.csv. Without ids (or with --all), every sound; --set exports a set's members.
      --pack: a flat folder where sounds marked classic become rows of one synth.csv instead of
      audio files. --to (or --out) names the folder (default <project>/exports/).
  soundclaw changes <project> [--since <command number | time>] [--by human|agent|<author>] [--as <agent>] [--peek]
      What other hands changed since this agent last looked (a cursor kept per agent in the
      project): each history group with the parameters before and after, the numbers before and
      after (duration, loudness, centroid, pitch) and a before/after compare view saved as a PNG.
      Without --by: everyone but the agent itself; --by human: people only. Reading moves the
      cursor (not with --since or --peek). Never undo a person's edit silently.
  soundclaw request <project> [<id> --note "<what should change>"] [--tag <tag>]... [--like <sound>] [--by <author>]
      Ask for a change on a sound, as the dashboard's Ask for changes does (also writes
      sound mark <id> rejected "<note>" on the history). --tag adds the quick tags of the cards
      (too loud, too quiet, too long, too short, too harsh, too dull, too similar to another
      sound, good; with --like naming the other sound); a note may then be left out, and the tag
      good alone is praise (no mark). Without an id, lists the requests still
      open, claimed or blocked (open ones say seen by <agent> once an agent has been handed them).
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
  soundclaw skill install [--dest <dir> | --project <dir>]
      Install the Claude Code skill into ~/.claude/skills/soundclaw (or <dir>/.claude/skills/soundclaw).
      skill path prints where it is.
  soundclaw await <project-folder | watch-url> [--timeout <seconds>, default 600] [--since <cursor>] [--as <name>] [--json]
      Wait on the running server for what people ask in the dashboard (a request, a reply, a
      withdrawn request, or an approval or rejection mark), print the events with their next
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
  export: [['out', 'to', 'format', 'set', 'quality'], ['all', 'pack']],
  import: [['id', 'by'], ['quiet', 'classic']],
  normalize: [['by'], []],
  sample: [['as', 'by'], []],
  request: [['note', 'by', 'tag', 'like'], []],
  reply: [['by'], []],
  cancel: [['by'], []],
  work: [['by'], []],
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
  io.out(formatRun(r, (id) => soundSummary(w, id), (id) => setSummary(w, id)) + '\n');
  return 0;
}

function cmdList(io: Io, p: Parsed): number {
  const [dir, ...extra] = p.pos;
  if (!dir || extra.length) throw new UsageError('list: give a project folder');
  const w = wr(io, dir);
  const sounds = w.sounds();
  const sets = w.sets();
  io.out((sounds.length ? `${plural(sounds.length, 'sound')}:\n${sounds.map((s) => `  ${soundSummary(w, s.id)}\n`).join('')}` : 'no sounds yet\n') + (sets.length ? `${plural(sets.length, 'set')}:\n${sets.map((x) => `  ${setSummary(w, x.id)}\n`).join('')}` : ''));
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
  if (!['wave', 'spec', 'pitch', 'layers', 'loop', 'set', 'compare'].includes(kind)) throw new UsageError(`view: no view '${kind}' (wave, spec, pitch, layers, loop, set, compare)`);
  if (kind === 'compare' ? !other || extra.length : other !== undefined) throw new UsageError(kind === 'compare' ? 'view compare: give the other sound' : `view ${kind}: unexpected '${other}'`);
  const v = viewSound(wr(io, dir), id, kind as ViewKind | 'compare' | 'layers' | 'loop' | 'set', { other, out: one(p, 'out') });
  io.out(v.text + '\n');
  return 0;
}

/** `sample import <project> <file.wav> [as=<name>]` and `sample list <project>`. */
function cmdSample(io: Io, p: Parsed): number {
  const [verb, dir, file, ...extra] = p.pos;
  if (verb === 'list') {
    if (!dir || file) throw new UsageError('sample list: give a project folder');
    const list = wr(io, dir).samples.list();
    io.out(list.length ? list.map((x) => `${x.name}: ${x.seconds.toFixed(3)} s, ${x.rate} Hz, ${x.channels === 1 ? 'mono' : x.channels === 2 ? 'stereo' : `${x.channels} channels`}, ${x.bytes} bytes, sha256 ${x.sha256.slice(0, 12)}`).join('\n') + '\n' : 'no samples (sample import <project> <file.wav>)\n');
    return 0;
  }
  if (verb !== 'import' || !dir || !file) throw new UsageError('sample: sample import <project> <file.wav> [as=<name>] | sample list <project>');
  let as = one(p, 'as');
  for (const e of extra) {
    const m = /^as=(.+)$/.exec(e);
    if (!m) throw new UsageError(`sample import: unexpected '${e}' (as=<name>)`);
    as = m[1];
  }
  assertNoServer(dir, io);
  const w = wr(io, dir);
  if (existsSync(file) && statSync(file).isDirectory()) {
    if (as) throw new UsageError('sample import: as=<name> names one file, not a folder');
    const d = w.samples.importDir(file);
    w.samplesChanged();
    io.out(`${d.imported.map((x) => sampleLine(x.info, x.created)).join('\n')}${d.imported.length ? '\n' : ''}${d.problems.map((x) => `warning: ${x}\n`).join('')}${plural(d.imported.length, 'sample')} from ${file}\n`);
    return d.imported.length ? 0 : 1;
  }
  const r = w.samples.import(file, as);
  w.samplesChanged();
  io.out(`${sampleLine(r.info, r.created)}\nsha256 ${r.info.sha256.slice(0, 12)}\nuse it: layer add <sound> sample sample=${r.info.name} [start=<s>] [end=<s>] [pitch=<semitones>] [reverse=1] [side=left|right]\n`);
  return 0;
}

function cmdDescribe(io: Io, p: Parsed): number {
  const [dir, id, ...extra] = p.pos;
  if (!dir || !id || extra.length) throw new UsageError('describe: give a project folder and a sound id');
  const w = wr(io, dir);
  io.out((p.flags.has('json') ? describeJson(w, id) : describeText(w, id)) + '\n');
  return 0;
}

/** `measure`: numbers, class and checks of many sounds in one process. */
function cmdMeasure(io: Io, p: Parsed): number {
  const [dir, ...ids] = p.pos;
  if (!dir) throw new UsageError('measure: give a project folder');
  const w = wr(io, dir);
  if (p.flags.has('json')) {
    const r = measureJson(w, ids);
    io.out(r.json + '\n');
    return r.pass ? 0 : 1;
  }
  const r = measureText(w, ids);
  io.out(r.text + '\n');
  return r.pass ? 0 : 1;
}

/** `normalize`: the gain commands that bring sounds to a loudness, run as one undo group. */
function cmdNormalize(io: Io, p: Parsed): number {
  const [dir, ...rest] = p.pos;
  if (!dir || !rest.length) throw new UsageError('normalize: soundclaw normalize <project> <id|set>... [<class> | target=<LUFS>]');
  assertNoServer(dir, io);
  const w = wr(io, dir);
  const last = rest[rest.length - 1]!;
  const isName = (x: string): boolean => w.has(x) || w.hasSet(x);
  const spec = rest.length > 1 && !isName(last) ? rest.pop() : undefined;
  const n = normalizeCommands(w, rest, spec);
  if (!n.commands) {
    io.out(`${plural(n.ids.length, 'sound')} already at ${n.target}: nothing to write\n${n.notes.map((x) => `warning: ${x}\n`).join('')}`);
    return 0;
  }
  const r = w.run({ commands: n.commands, by: author(p, 'agent:claude', (x) => `agent:${x}`) });
  if (!r.ok) {
    io.err(formatErrors('normalize', r.errors) + '\n');
    return 1;
  }
  io.out(`${n.notes.map((x) => `warning: ${x}\n`).join('')}normalized ${plural(n.ids.length, 'sound')} to ${n.target} as group ${r.group}\n${r.added.map((e) => `  #${e.seq} ${e.cmd}\n`).join('')}`);
  return 0;
}

function cmdCheck(io: Io, p: Parsed): number {
  const [dir, ...ids] = p.pos;
  if (!dir) throw new UsageError('check: give a project folder');
  const w = wr(io, dir);
  if (p.flags.has('json')) {
    const j = measureJson(w, ids);
    io.out(j.json + '\n');
    return j.pass ? 0 : 1;
  }
  const r = checkText(w, ids);
  io.out(r.text + '\n');
  return r.pass ? 0 : 1;
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
  const format = (one(p, 'format') ?? 'wav') as ExportFormat;
  if (!EXPORT_FORMATS.includes(format)) throw new UsageError(`export: --format is ${EXPORT_FORMATS.join(', ')} (not '${format}')`);
  const out = one(p, 'to') ?? one(p, 'out');
  if (one(p, 'to') && one(p, 'out')) throw new UsageError('export: give --to or --out, not both');
  if (p.flags.has('all') && (ids.length || one(p, 'set'))) throw new UsageError('export: --all is every sound; name sounds or --set, not both');
  const quality = one(p, 'quality') === undefined ? undefined : Number(one(p, 'quality'));
  if (quality !== undefined && !(quality >= -0.1 && quality <= 1)) throw new UsageError('export: --quality is a number from -0.1 to 1');
  io.out(formatExportFiles(exportFormat(wr(io, dir), ids, format, { out, set: one(p, 'set'), all: p.flags.has('all'), pack: p.flags.has('pack'), quality })) + '\n');
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
  const q = personRequest(w, author(p, 'human:cli', humanName), toPersonRequest({ action: 'request', sound, note: one(p, 'note'), tags: p.flags.get('tag'), other: one(p, 'like') }));
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

function cmdSkill(io: Io, p: Parsed): number {
  const [what] = p.pos;
  if (what !== 'install' && what !== 'path') throw new UsageError('skill: install [--dest <dir> | --project <dir>], or path');
  const src = skillSource();
  if (what === 'path') { io.out(src + '\n'); return 0; }
  const proj = one(p, 'project');
  const dest = one(p, 'dest') ?? (proj ? join(proj, '.claude', 'skills', 'soundclaw') : join(homedir(), '.claude', 'skills', 'soundclaw'));
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true, filter: (f) => !f.endsWith('package.json') });
  // The command reference goes beside it (the bundle carries a copy; the repo has it in docs/).
  const ref = join(src, '..', 'docs', 'commands.md');
  if (!existsSync(join(src, 'commands.md')) && existsSync(ref)) cpSync(ref, join(dest, 'commands.md'));
  const files = readdirSync(dest, { recursive: true }).map(String).filter((f) => f.includes('.')).sort();
  io.out(`installed the SoundClaw skill in ${dest} (${files.join(', ')})\nClaude Code finds it as /soundclaw; connect the tools with:\n  claude mcp add soundclaw -- npx soundclaw serve --project <your project>\n`);
  return 0;
}

export function main(argv: string[], io: Io = nodeIo): number {
  const [cmd, ...rest] = argv;
  try {
    const meta = metaCommand(argv, io);
    if (meta !== null) return meta;
    switch (cmd) {
      case 'new': return cmdNew(io, parseArgs(rest, ['name'], []));
      case 'run': return cmdRun(io, parseArgs(rest, ...WRITE_OPTS.run!));
      case 'list': return cmdList(io, parseArgs(rest, [], []));
      case 'history': return cmdHistory(io, parseArgs(rest, ['sound', 'by', 'limit'], []));
      case 'render': return cmdRender(io, parseArgs(rest, [], ['json']));
      case 'view': return cmdView(io, parseArgs(rest, ['out'], []));
      case 'describe': return cmdDescribe(io, parseArgs(rest, [], ['json']));
      case 'measure': return cmdMeasure(io, parseArgs(rest, [], ['json']));
      case 'normalize': return cmdNormalize(io, parseArgs(rest, ...WRITE_OPTS.normalize!));
      case 'check': return cmdCheck(io, parseArgs(rest, [], ['json']));
      case 'import': return cmdImport(io, parseArgs(rest, ...WRITE_OPTS.import!));
      case 'sample': return cmdSample(io, parseArgs(rest, ...WRITE_OPTS.sample!));
      case 'changes': return cmdChanges(io, parseArgs(rest, ['since', 'by', 'as'], ['peek']));
      case 'export': return cmdExport(io, parseArgs(rest, ...WRITE_OPTS.export!));
      case 'request': return cmdRequest(io, parseArgs(rest, ...WRITE_OPTS.request!));
      case 'reply': case 'cancel': return cmdAnswer(io, cmd, parseArgs(rest, ...WRITE_OPTS.reply!));
      case 'work': return cmdWork(io, parseArgs(rest, ...WRITE_OPTS.work!));
      case 'skill': return cmdSkill(io, parseArgs(rest, ['dest', 'project'], []));
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
