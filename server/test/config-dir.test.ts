// Settings live in SOUNDCLAW_CONFIG_DIR, else ~/.soundclaw: not $XDG_CONFIG_HOME, which MCP stdio clients drop. Settings an earlier version
// kept under $XDG_CONFIG_HOME/soundclaw are copied in where ~/.soundclaw has none.

import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configDir } from '../src/index.ts';

const KEYS = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'SOUNDCLAW_CONFIG_DIR'] as const;
const saved: Record<string, string | undefined> = {};
let root: string;
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), 'soundclaw-cfg-'));
  process.env.HOME = join(root, 'home');
  process.env.USERPROFILE = join(root, 'home');
  delete process.env.SOUNDCLAW_CONFIG_DIR;
  delete process.env.XDG_CONFIG_HOME;
  mkdirSync(process.env.HOME, { recursive: true });
});
afterEach(() => {
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  rmSync(root, { recursive: true, force: true });
});
const put = (file: string, text: string): void => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };

describe('configDir', () => {
  it('is ~/.soundclaw whether or not XDG_CONFIG_HOME is set, so a CLI and an MCP-started server read the same settings', () => {
    const home = join(root, 'home', '.soundclaw');
    expect(configDir()).toBe(home);
    process.env.XDG_CONFIG_HOME = join(root, 'xdg');
    expect(configDir()).toBe(home);
  });
  it('SOUNDCLAW_CONFIG_DIR overrides, and nothing is migrated into it', () => {
    process.env.XDG_CONFIG_HOME = join(root, 'xdg');
    put(join(root, 'xdg', 'soundclaw', 'libraries.json'), '{"old":true}');
    process.env.SOUNDCLAW_CONFIG_DIR = join(root, 'chosen');
    expect(configDir()).toBe(join(root, 'chosen'));
    expect(existsSync(join(root, 'chosen', 'libraries.json'))).toBe(false);
  });
  it('copies settings from the old XDG location where ~/.soundclaw has none, folders too, and never overwrites', () => {
    const xdg = join(root, 'xdg');
    process.env.XDG_CONFIG_HOME = xdg;
    put(join(xdg, 'soundclaw', 'libraries.json'), '{"libraries":["old"]}');
    put(join(xdg, 'soundclaw', 'generation.json'), '{"provider":"old"}');
    put(join(xdg, 'soundclaw', 'library-tags', 'cellar.json'), '{"tags":1}');
    put(join(root, 'home', '.soundclaw', 'generation.json'), '{"provider":"new"}');
    const dir = configDir();
    expect(readFileSync(join(dir, 'libraries.json'), 'utf8')).toBe('{"libraries":["old"]}');
    expect(readFileSync(join(dir, 'library-tags', 'cellar.json'), 'utf8')).toBe('{"tags":1}');
    expect(readFileSync(join(dir, 'generation.json'), 'utf8')).toBe('{"provider":"new"}'); // already there: left alone
    expect(readFileSync(join(xdg, 'soundclaw', 'libraries.json'), 'utf8')).toBe('{"libraries":["old"]}'); // the old copy stays
  });
  it('also reads ~/.config/soundclaw, where XDG_CONFIG_HOME points when it is not set (a server that lost the variable)', () => {
    put(join(root, 'home', '.config', 'soundclaw', 'libraries.json'), '{"libraries":["from-default"]}');
    expect(readFileSync(join(configDir(), 'libraries.json'), 'utf8')).toBe('{"libraries":["from-default"]}');
  });
});
