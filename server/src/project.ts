// The project folder. Plain files, so a project diffs well in git:
//   project.json     the format and the name
//   sounds/          one <id>.sfx per sound (the current state, written from the history)
//   instruments/ songs/ sets/   homes for the documents later versions add
//   history.jsonl    the command tape: every change, by whom, in groups; the source of truth
//   requests.jsonl   what people asked for, and how the agent answered
//   exports/         rendered WAV files (ignored by git)
//   .cache/          the render cache (ignored by git)

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { TAPE_FORMAT, parseTape, serializeSet, serializeSound, tapeHeader, tapeToJsonl, type Library, type Sound, type TapeEntry } from '@soundclaw/core';

export const PROJECT_FORMAT = 'soundclaw-project';
export const HISTORY_FILE = 'history.jsonl';
export const REQUESTS_FILE = 'requests.jsonl';
export const DOC_DIRS = ['sounds', 'instruments', 'songs', 'sets'] as const;

export interface ProjectJson {
  format: typeof PROJECT_FORMAT;
  version: 1;
  name: string;
  /** What the checks are held to (core's Style keys: loudnessTarget, loudnessTolerance, truePeakMax, dcMax, clickMax, silenceMax, tailFloorDb); the defaults for any left out. */
  style?: Record<string, number>;
}

export class ProjectError extends Error {}

export interface Project {
  dir: string;
  json: ProjectJson;
}

const writeJson = (file: string, v: unknown): void => writeFileSync(file, JSON.stringify(v, null, 2) + '\n');

export function createProject(dir: string, o: { name?: string } = {}): Project {
  const root = resolve(dir);
  if (existsSync(join(root, 'project.json'))) throw new ProjectError(`${dir} is a SoundClaw project already`);
  if (existsSync(root) && readdirSync(root).length) throw new ProjectError(`${dir} exists and is not empty: pick a new folder`);
  mkdirSync(root, { recursive: true });
  for (const d of DOC_DIRS) {
    mkdirSync(join(root, d));
    writeFileSync(join(root, d, '.gitkeep'), '');
  }
  mkdirSync(join(root, 'exports'));
  const json: ProjectJson = { format: PROJECT_FORMAT, version: 1, name: o.name ?? (basename(root).replace(/\.(sclaw|soundclaw)$/, '') || 'sounds') };
  writeJson(join(root, 'project.json'), json);
  writeFileSync(join(root, HISTORY_FILE), tapeToJsonl([]));
  writeFileSync(join(root, REQUESTS_FILE), '');
  writeFileSync(join(root, '.gitignore'), 'exports/\n.cache/\n.soundclaw.lock\n');
  return { dir: root, json };
}

export function loadProject(dir: string): Project {
  const root = resolve(dir);
  const file = join(root, 'project.json');
  if (!existsSync(file)) throw new ProjectError(`${dir} is not a SoundClaw project (no project.json); make one with: soundclaw new ${dir}`);
  let json: ProjectJson;
  try {
    json = JSON.parse(readFileSync(file, 'utf8')) as ProjectJson;
  } catch (e) {
    throw new ProjectError(`${file}: ${(e as Error).message}`);
  }
  if (json.format !== PROJECT_FORMAT || json.version !== 1) throw new ProjectError(`${file}: not a ${PROJECT_FORMAT} version 1 file`);
  return { dir: root, json };
}

export function readTape(p: Project): TapeEntry[] {
  const file = join(p.dir, HISTORY_FILE);
  if (!existsSync(file)) throw new ProjectError(`${HISTORY_FILE} is missing from ${p.dir}`);
  try {
    return parseTape(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ProjectError(`${HISTORY_FILE}: ${(e as Error).message}`);
  }
}

/** Append entries to the tape. The only way the tape is written; it is never rewritten. */
export function appendTape(p: Project, entries: TapeEntry[]): void {
  if (!entries.length) return;
  const file = join(p.dir, HISTORY_FILE);
  if (!existsSync(file)) writeFileSync(file, tapeHeader() + '\n');
  appendFileSync(file, entries.map((e) => JSON.stringify(e.at ? { seq: e.seq, by: e.by, at: e.at, group: e.group, cmd: e.cmd } : { seq: e.seq, by: e.by, group: e.group, cmd: e.cmd })).join('\n') + '\n');
}

export { TAPE_FORMAT };

export const soundFile = (p: Project, id: string): string => join(p.dir, 'sounds', `${id}.sfx`);

/** Make sounds/ match the library: write the sounds that changed, remove those that are gone. */
export function writeSounds(p: Project, lib: Library, before: Library): void {
  // Remove first: a rename that only changes case (Foo -> foo) is one file on a case-insensitive disk, and must not be deleted after it is written.
  for (const id of before.keys()) if (!lib.has(id)) rmSync(soundFile(p, id), { force: true });
  const present = new Set(readdirSync(join(p.dir, 'sounds')));
  for (const [id, s] of lib) {
    const text = serializeSound(s);
    const prev = before.get(id);
    if (prev && serializeSound(prev) === text && present.has(`${id}.sfx`)) continue;
    writeFileSync(soundFile(p, id), text);
  }
}

export const setFile = (p: Project, id: string): string => join(p.dir, 'sets', `${id}.set`);

/** Make sets/ match the library's sets, the same way. */
export function writeSets(p: Project, lib: Library, before: Library): void {
  mkdirSync(join(p.dir, 'sets'), { recursive: true });
  for (const id of before.sets.keys()) if (!lib.sets.has(id)) rmSync(setFile(p, id), { force: true });
  for (const [id, s] of lib.sets) {
    const text = serializeSet(s);
    const prev = before.sets.get(id);
    if (prev && serializeSet(prev) === text && existsSync(setFile(p, id))) continue;
    writeFileSync(setFile(p, id), text);
  }
}

export function listSoundFiles(p: Project): string[] {
  return readdirSync(join(p.dir, 'sounds')).filter((f) => f.endsWith('.sfx')).map((f) => f.slice(0, -4)).sort();
}

export type { Sound };

// The server lock: a running server is the single writer for its project. It writes
// .soundclaw.lock (pid and URL) and removes it on exit; other writers refuse while it is held.

export const LOCK_FILE = '.soundclaw.lock';

export interface LockInfo {
  pid: number;
  url: string;
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The live server holding this project, if any (a lock left by a dead process is ignored). */
export function lockHolder(dir: string): LockInfo | null {
  const f = join(dir, LOCK_FILE);
  if (!existsSync(f)) return null;
  try {
    const info = JSON.parse(readFileSync(f, 'utf8')) as LockInfo;
    return info.pid !== process.pid && alive(info.pid) ? info : null;
  } catch {
    return null;
  }
}

export function acquireLock(dir: string, url: string): void {
  const held = lockHolder(dir);
  if (held) throw new ProjectError(`another soundclaw server (pid ${held.pid}) owns ${dir}; watch it at ${held.url.replace(/\?.*$/, '')}`);
  // The URL is stored without its token: the lock file sits in the project folder.
  writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: process.pid, url: url.replace(/\?.*$/, '') }) + '\n');
}

export function releaseLock(dir: string): void {
  const f = join(dir, LOCK_FILE);
  try {
    const info = JSON.parse(readFileSync(f, 'utf8')) as LockInfo;
    if (info.pid === process.pid) rmSync(f, { force: true });
  } catch {
    // no lock, or not ours
  }
}
