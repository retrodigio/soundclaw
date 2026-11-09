// `soundclaw init`: one command from nothing to a Claude Code session with SoundClaw connected.
// It makes (or finds) the project, installs the skill, and registers the MCP server with
// `claude mcp add`, or in .mcp.json when the claude command is not on the PATH.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createProject, ProjectError } from '@soundclaw/server';

export const SCOPES = ['local', 'project', 'user'] as const;
export type Scope = (typeof SCOPES)[number];

/** The result of running the claude command; `missing` when it is not on the PATH. */
export interface ClaudeResult {
  status: number | null;
  output: string;
  missing: boolean;
}

export type ClaudeRunner = (args: string[], cwd: string) => ClaudeResult;

export const runClaude: ClaudeRunner = (args, cwd) => {
  const r = spawnSync('claude', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  const err = r.error as NodeJS.ErrnoException | undefined;
  if (err?.code === 'ENOENT') return { status: null, output: '', missing: true };
  if (err) throw new ProjectError(`could not run claude: ${err.message}`);
  // A Windows shell reports a missing command as exit 1 or 9009 rather than ENOENT.
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (process.platform === 'win32' && r.status !== 0 && /not recognized|not found/i.test(output)) return { status: r.status, output, missing: true };
  return { status: r.status, output, missing: false };
};

export interface InitOptions {
  project: string;
  name: string;
  scope: Scope;
  skill: boolean;
  force: boolean;
  version: string;
  cwd: string;
  installSkill: (dest: string) => string[];
  claude: ClaudeRunner;
  out: (s: string) => void;
}

/** The command Claude Code starts: npx at this version, so the server, the skill and the docs agree. */
export function serveCommand(o: Pick<InitOptions, 'project' | 'scope' | 'version' | 'cwd'>): { command: string; args: string[] } {
  // A shared .mcp.json names the folder relative to the repo (Claude Code starts servers there); the
  // other scopes are kept per user, so an absolute path keeps working from anywhere.
  const abs = resolve(o.cwd, o.project);
  const rel = relative(o.cwd, abs) || '.';
  const path = o.scope === 'project' && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : abs;
  const pkg = o.version === 'unknown' ? 'soundclaw' : `soundclaw@${o.version}`;
  return { command: 'npx', args: ['-y', pkg, 'serve', '--project', path] };
}

function writeMcpJson(file: string, name: string, entry: { command: string; args: string[] }, force: boolean): 'added' | 'exists' | 'replaced' {
  let json: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(file)) {
    try {
      json = JSON.parse(readFileSync(file, 'utf8')) as typeof json;
    } catch (e) {
      throw new ProjectError(`${file} is not valid JSON (${(e as Error).message}); fix it or add the server by hand`);
    }
  }
  const servers = (json.mcpServers ??= {});
  const had = name in servers;
  if (had && !force) return 'exists';
  servers[name] = { type: 'stdio', command: entry.command, args: entry.args };
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  return had ? 'replaced' : 'added';
}

export function init(o: InitOptions): number {
  const dir = resolve(o.cwd, o.project);
  const shown = relative(o.cwd, dir) || '.';

  // 1. The project.
  if (existsSync(join(dir, 'project.json'))) o.out(`project: using the one at ${shown}\n`);
  else {
    const proj = createProject(dir);
    o.out(`project: created '${proj.json.name}' at ${shown}\n`);
  }

  // 2. The skill: per user, or in the repo when the MCP entry is shared there too.
  if (o.skill) {
    const dest = o.scope === 'project' ? join(o.cwd, '.claude', 'skills', 'soundclaw') : join(homedir(), '.claude', 'skills', 'soundclaw');
    o.installSkill(dest);
    o.out(`skill: installed in ${dest}\n`);
  }

  // 3. The MCP server.
  const entry = serveCommand(o);
  const line = [entry.command, ...entry.args].join(' ');
  const add = (): ClaudeResult => o.claude(['mcp', 'add', '--scope', o.scope, o.name, '--', entry.command, ...entry.args], o.cwd);
  let r = add();
  if (r.missing) {
    // No claude command: a project .mcp.json is something Claude Code reads wherever it runs.
    const file = join(o.cwd, '.mcp.json');
    const how = writeMcpJson(file, o.name, entry, o.force);
    if (how === 'exists') {
      o.out(`mcp: '${o.name}' is already in ${file}; --force replaces it\n`);
    } else {
      o.out(`mcp: the claude command is not on the PATH, so '${o.name}' was ${how === 'added' ? 'added to' : 'replaced in'} ${file}\n     (${line}); Claude Code asks you to approve it when it starts here\n`);
    }
  } else {
    if (r.status !== 0 && /already exists/i.test(r.output)) {
      if (!o.force) {
        o.out(`mcp: '${o.name}' is already registered (${o.scope} scope); --force replaces it, --name adds another\n`);
        return next(o);
      }
      const rm = o.claude(['mcp', 'remove', o.name, '--scope', o.scope], o.cwd);
      if (rm.status !== 0) throw new ProjectError(`claude mcp remove ${o.name} failed:\n${rm.output.trim()}`);
      r = add();
    }
    if (r.status !== 0) throw new ProjectError(`claude mcp add failed:\n${r.output.trim()}\nRun it yourself: claude mcp add --scope ${o.scope} ${o.name} -- ${line}`);
    o.out(`mcp: registered '${o.name}' (${o.scope} scope): ${line}\n`);
  }
  return next(o);
}

function next(o: InitOptions): number {
  o.out(`\nNext: start Claude Code in ${o.scope === 'user' ? 'any folder' : 'this folder'} (claude, or claude --continue to resume a session) and ask for a sound.\nThe dashboard link comes from the project tool: ask Claude for it, then open it in a browser.\n`);
  return 0;
}
