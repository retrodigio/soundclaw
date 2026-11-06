// soundclaw: new | run | list | history | render | export | request | reply | cancel | work (its actions) | skill (await and serve: entry.ts). A thin layer over @soundclaw/core and the project folder.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTHOR_RE, openRequests } from '@soundclaw/core';
import {
  ProjectError, Writer, agentName, agentWork, cliSteps, createProject, exportSounds, formatErrors, formatExport, formatRun, historyText, humanName, loadProject, lockHolder,
  personRequest, plural, readRequests, requestBrief, requestLine, shellArg, soundSummary, toPersonRequest, type Project,
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
        sound new <id>                                      a sound (a placeholder sine tone for now)
        sound set <id> frequency=<20-20000 Hz> duration=<0.01-10 s> volume=<0-1>
        sound mark <id> approved|rejected|draft ["note"]
        undo [group=<g>] [by=<author>]    redo [group=<undo group>] [by=<author>]   (each alone in its batch)
      '-' reads the commands from standard input. --by is the author written on the history:
      agent:<name> or human:<name> (default agent:claude; a bare name means agent:<name>).
      The result lists the commands as written and each changed sound's numbers.
  soundclaw list <project>
      The sounds, one line each: parameters, status, and the render's numbers (samples, peak, rms, hash).
  soundclaw history <project> [--sound <id>] [--by <author>] [--limit <n, default 50>]
      The history tape: command number, undo group, author, time, command; undone groups marked.
  soundclaw render <project> <id>
      Render a sound through the content-hash cache and print its numbers.
  soundclaw export <project> [<id>...] [--out <dir>]
      Write WAV files (16-bit PCM, 44,100 Hz, mono). Without ids, all sounds. Default folder:
      <project>/exports/.
  soundclaw request <project> [<id> --note "<what should change>"] [--by <author>]
      Ask for a change on a sound, as the dashboard's Ask for changes does (also writes
      sound mark <id> rejected "<note>" on the history). Without an id, lists the requests still
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
  soundclaw serve --project <project> [--port 7418] [--no-mcp]
      Own the project: MCP on stdin/stdout for the agent, and the live dashboard on
      http://127.0.0.1:<port>/?token=... (printed to stderr). Creates the project if needed.

While a server runs (soundclaw serve): commands that write (run, export, request, reply, cancel,
work) are sent to it over HTTP, found through the project's lock and a token file only you can
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
  export: [['out'], []],
  request: [['note', 'by'], []],
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
  io.out(formatRun(r, (id) => soundSummary(w, id)) + '\n');
  return 0;
}

function cmdList(io: Io, p: Parsed): number {
  const [dir, ...extra] = p.pos;
  if (!dir || extra.length) throw new UsageError('list: give a project folder');
  const w = wr(io, dir);
  const sounds = w.sounds();
  io.out(sounds.length ? `${plural(sounds.length, 'sound')}:\n${sounds.map((s) => `  ${soundSummary(w, s.id)}\n`).join('')}` : 'no sounds yet\n');
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
  const r = w.render(id);
  io.out(`${soundSummary(w, id)}\nrender key ${r.key.slice(0, 12)}${r.cached ? ' (from the cache)' : ''}\n`);
  return 0;
}

function cmdExport(io: Io, p: Parsed): number {
  const [dir, ...ids] = p.pos;
  if (!dir) throw new UsageError('export: give a project folder');
  io.out(formatExport(exportSounds(wr(io, dir), ids, one(p, 'out'))) + '\n');
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
  const q = personRequest(w, author(p, 'human:cli', humanName), toPersonRequest({ action: 'request', sound, note: one(p, 'note') }));
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
      case 'render': return cmdRender(io, parseArgs(rest, [], []));
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
