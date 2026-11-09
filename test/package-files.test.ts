// The npm package carries everything the build writes to cli/dist (the bundle loads its worker and
// the dashboard from beside itself), and the README for the npm page. Needs a build first (pnpm test builds).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const CLI = join(import.meta.dirname, '..', 'cli');
const DIST = join(CLI, 'dist');

it.skipIf(!existsSync(join(DIST, 'soundclaw.js')))('npm pack includes every built file', () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: CLI, encoding: 'utf8', shell: process.platform === 'win32' })) as { files: { path: string }[] }[];
  const files = new Set(packed[0]!.files.map((f) => f.path));
  const built = readdirSync(DIST, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name).slice(CLI.length + 1).split('\\').join('/'));
  expect(built.length).toBeGreaterThan(5);
  for (const f of built) expect(files, f).toContain(f);
  expect(files).toContain('README.md');
  expect(files).toContain('package.json');
}, 60_000);
