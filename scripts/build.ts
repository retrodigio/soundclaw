// Build the publishable `soundclaw` package in cli/dist: one bundled JavaScript file (core,
// server, CLI and the MCP SDK; Node can't strip TypeScript inside node_modules), the built watch
// view (ui/dist, from `vite build`), the licence, and the licences of everything bundled.
//   node scripts/build.ts        (pnpm build runs the UI build first)

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { build } from 'esbuild';

const REPO = join(import.meta.dirname, '..');
const OUT = join(REPO, 'cli', 'dist');
const UI = join(REPO, 'ui', 'dist');
if (!existsSync(join(UI, 'index.html'))) throw new Error('ui/dist is missing: run pnpm --filter @soundclaw/ui build first');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const result = await build({
  // the card service's worker thread is a second file next to the bundle (the server starts it by name)
  entryPoints: { soundclaw: join(REPO, 'cli', 'bin', 'soundclaw.js'), 'thumbs-worker': join(REPO, 'server', 'src', 'thumbs-worker.ts') },
  outdir: OUT,
  entryNames: '[name]',
  outExtension: { '.js': '.js' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  metafile: true,
  legalComments: 'none',
  minify: true,
  logLevel: 'warning',
  // libvorbis.js is a sloppy-mode script that cannot live inside an ES module: the package depends on it instead.
  external: ['libvorbis.js'],
  // `soundclaw --version`.
  define: { __SOUNDCLAW_VERSION__: JSON.stringify((JSON.parse(readFileSync(join(REPO, 'cli', 'package.json'), 'utf8')) as { version: string }).version) },
  // CommonJS dependencies inside an ES module bundle need a require.
  banner: { js: "import { createRequire as __sclawRequire } from 'node:module'; const require = __sclawRequire(import.meta.url);" },
});
cpSync(UI, join(OUT, 'ui'), { recursive: true });
// The Claude Code skill, for `soundclaw skill install` (the workspace's package.json stays behind).
cpSync(join(REPO, 'skill'), join(OUT, 'skill'), { recursive: true, filter: (f) => !f.endsWith('package.json') });
cpSync(join(REPO, 'docs', 'commands.md'), join(OUT, 'skill', 'commands.md'));
cpSync(join(REPO, 'LICENSE'), join(OUT, 'LICENSE'));

// Third-party licences: every package with code in the bundle, plus the UI's runtime packages.
const pkgDirs = new Set<string>();
for (const input of Object.keys(result.metafile.inputs)) {
  const parts = input.split('/');
  const i = parts.lastIndexOf('node_modules');
  if (i < 0) continue;
  const n = parts[i + 1]!.startsWith('@') ? 2 : 1;
  pkgDirs.add(join(REPO, ...parts.slice(0, i + 1 + n)));
}
const uiRequire = createRequire(join(REPO, 'ui', 'package.json'));
for (const name of ['react', 'react-dom', 'scheduler']) {
  try {
    pkgDirs.add(dirname(uiRequire.resolve(`${name}/package.json`)));
  } catch {
    pkgDirs.add(dirname(createRequire(uiRequire.resolve('react-dom/package.json')).resolve(`${name}/package.json`)));
  }
}
const notices: string[] = [];
for (const dir of [...pkgDirs].sort()) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; version: string; license?: string };
  const file = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE'].map((f) => join(dir, f)).find(existsSync);
  notices.push(`${pkg.name}@${pkg.version} (${pkg.license ?? 'see below'})\n\n${file ? readFileSync(file, 'utf8').trim() : `licence: ${pkg.license}`}\n`);
}
// The dashboard's fonts (SIL Open Font License), bundled as woff2 in ui/: their licence texts sit next to the files.
const FONTS = join(REPO, 'ui', 'src', 'studio', 'fonts');
for (const f of readdirSync(FONTS).filter((x) => x.startsWith('OFL-')).sort()) notices.push(`font ${f.replace(/^OFL-|\.txt$/g, '')} (OFL-1.1)\n\n${readFileSync(join(FONTS, f), 'utf8').trim()}\n`);
writeFileSync(join(OUT, 'THIRD_PARTY_LICENSES.txt'), `SoundClaw bundles the following packages and fonts.\n\n${notices.join('\n' + '-'.repeat(72) + '\n\n')}`);

const kb = (f: string) => Math.round(readFileSync(f).length / 1024);
console.log(`built ${relative(REPO, OUT)}${sep}soundclaw.js (${kb(join(OUT, 'soundclaw.js'))} KB, ${pkgDirs.size} third-party packages) and ui/`);
