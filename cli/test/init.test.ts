// `soundclaw init`: the project, the skill and the MCP entry in one step, with the claude command replaced.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type Io } from '../src/main.ts';
import { serveCommand, type ClaudeResult } from '../src/init.ts';
import { soundclawVersion } from '../src/version.ts';

let tmp: string;
let calls: string[][];
let reply: (args: string[]) => ClaudeResult;
const ok = (output = ''): ClaudeResult => ({ status: 0, output, missing: false });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sc-init-'));
  calls = [];
  reply = () => ok('Added stdio MCP server');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function sc(args: string[]): { code: number; out: string; err: string } {
  let out = '', err = '';
  const io: Io = {
    out: (s) => { out += s; }, err: (s) => { err += s; }, stdin: () => '', now: () => '2026-11-09T10:00:00Z',
    cwd: tmp,
    claude: (a) => { calls.push(a); return reply(a); },
  };
  return { code: main(args, io), out, err };
}

const v = soundclawVersion();

describe('soundclaw init', () => {
  it('makes the project and registers the server at this version, with an absolute path for a local entry', () => {
    const r = sc(['init', '--no-skill']);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(tmp, 'sounds', 'project.json'))).toBe(true);
    expect(calls).toEqual([['mcp', 'add', '--scope', 'local', 'soundclaw', '--', 'npx', '-y', `soundclaw@${v}`, 'serve', '--project', join(tmp, 'sounds')]]);
    expect(r.out).toContain("project: created 'sounds'");
    expect(r.out).toContain("mcp: registered 'soundclaw' (local scope)");
    expect(r.out).toContain('claude --continue');
  });

  it('uses a project that is already there, and names the folder given', () => {
    expect(sc(['new', join(tmp, 'sfx')]).code).toBe(0);
    const r = sc(['init', 'sfx', '--no-skill', '--name', 'sfx-tools']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('project: using the one at sfx');
    expect(calls[0]!.slice(4, 6)).toEqual(['sfx-tools', '--']);
  });

  it('refuses a folder that has other files in it', () => {
    mkdirSync(join(tmp, 'busy'));
    writeFileSync(join(tmp, 'busy', 'notes.txt'), 'x');
    const r = sc(['init', 'busy', '--no-skill']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('exists and is not empty');
    expect(calls).toEqual([]);
  });

  it('--scope project puts a relative path in the shared entry and the skill in the repo', () => {
    const r = sc(['init', 'audio/sfx', '--scope', 'project']);
    expect(r.code, r.err).toBe(0);
    expect(calls[0]).toEqual(['mcp', 'add', '--scope', 'project', 'soundclaw', '--', 'npx', '-y', `soundclaw@${v}`, 'serve', '--project', 'audio/sfx']);
    expect(existsSync(join(tmp, '.claude', 'skills', 'soundclaw', 'SKILL.md'))).toBe(true);
    expect(r.out).toContain(`skill: installed in ${join(tmp, '.claude', 'skills', 'soundclaw')}`);
  });

  it('the user-scope skill goes to the home folder', () => {
    const home = process.env.HOME;
    process.env.HOME = join(tmp, 'home');
    try {
      const r = sc(['init', '--scope', 'user']);
      expect(r.code, r.err).toBe(0);
      expect(existsSync(join(tmp, 'home', '.claude', 'skills', 'soundclaw', 'SKILL.md'))).toBe(true);
      expect(r.out).toContain('any folder');
    } finally {
      process.env.HOME = home;
    }
  });

  it('leaves an existing entry alone, and --force replaces it', () => {
    reply = (a) => (a[1] === 'add' && calls.filter((c) => c[1] === 'add').length === 1 ? { status: 1, output: 'MCP server soundclaw already exists in local config', missing: false } : ok());
    const kept = sc(['init', '--no-skill']);
    expect(kept.code, kept.err).toBe(0);
    expect(kept.out).toContain('already registered');
    expect(calls.map((c) => c[1])).toEqual(['add']);

    calls = [];
    const forced = sc(['init', '--no-skill', '--force']);
    expect(forced.code, forced.err).toBe(0);
    expect(calls.map((c) => c[1])).toEqual(['add', 'remove', 'add']);
    expect(calls[1]).toEqual(['mcp', 'remove', 'soundclaw', '--scope', 'local']);
    expect(forced.out).toContain("mcp: registered 'soundclaw'");
  });

  it('a failed claude mcp add is an error that says what to run', () => {
    reply = () => ({ status: 1, output: 'something broke', missing: false });
    const r = sc(['init', '--no-skill']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('something broke');
    expect(r.err).toContain(`claude mcp add --scope local soundclaw -- npx -y soundclaw@${v} serve --project`);
  });

  it('without the claude command, writes .mcp.json and keeps what is in it', () => {
    reply = () => ({ status: null, output: '', missing: true });
    writeFileSync(join(tmp, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }));
    const r = sc(['init', '--no-skill']);
    expect(r.code, r.err).toBe(0);
    const json = JSON.parse(readFileSync(join(tmp, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(Object.keys(json.mcpServers)).toEqual(['other', 'soundclaw']);
    expect(json.mcpServers.soundclaw!.args).toEqual(['-y', `soundclaw@${v}`, 'serve', '--project', join(tmp, 'sounds')]);
    expect(r.out).toContain('approve it');
    // Again: kept, unless forced.
    expect(sc(['init', '--no-skill']).out).toContain('already in');
    expect(sc(['init', '--no-skill', '--force']).out).toContain('replaced in');
  });

  it('checks its options', () => {
    expect(sc(['init', '--scope', 'team']).code).toBe(2);
    expect(sc(['init', '--name', 'a b']).code).toBe(2);
    expect(sc(['init', 'a', 'b']).code).toBe(2);
  });

  it('a path outside the repo stays absolute even in a shared entry', () => {
    expect(serveCommand({ project: '../elsewhere', scope: 'project', version: '1.2.3', cwd: '/repo/game' }).args)
      .toEqual(['-y', 'soundclaw@1.2.3', 'serve', '--project', '/repo/elsewhere']);
  });
});
