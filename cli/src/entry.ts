// The soundclaw executable: every command but `serve`, `await`, `library index` and `generate` is synchronous (main.ts);
// `serve` runs until the agent disconnects or the process is stopped.

import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_PORT, serve } from '@soundclaw/server/serve';
import { ProjectError, indexLibrary, indexStatsText, readRegistry } from '@soundclaw/server';
import { USAGE, UsageError, main, metaCommand, one, parseArgs, WRITE_OPTS, type Io } from './main.ts';
import { awaitMain, forwardToServer, listenerLine, runForwarded } from './forward.ts';
import { generateMain } from './generate.ts';

const out: Pick<Io, 'out' | 'err'> = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) };

async function serveMain(argv: string[]): Promise<number> {
  try {
    const p = parseArgs(argv, ['project', 'port', 'token'], ['no-mcp']);
    const project = one(p, 'project') ?? p.pos[0];
    if (!project) throw new UsageError('serve: give a project folder with --project <dir>');
    if (p.pos.length > (one(p, 'project') ? 0 : 1)) throw new UsageError(`serve: unexpected argument '${p.pos.at(-1)}'`);
    const portS = one(p, 'port');
    const port = portS === undefined ? DEFAULT_PORT : Number(portS);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port must be 0..65535');
    const s = await serve({ project, port, mcp: !p.flags.has('no-mcp'), token: one(p, 'token'), runCli: runForwarded });
    await s.closed;
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`error: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    if (e instanceof ProjectError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

/**
 * `run` reads its script (a file, or standard input) here, once, and hands the text on as -e, so a
 * run sent to a server carries its commands with it. Returns argv unchanged for anything else.
 */
export function resolveRunArgv(argv: string[]): string[] {
  const spec = WRITE_OPTS.run!;
  let p;
  try { p = parseArgs(argv.slice(1), ...spec); } catch { return argv; }
  const [dir, script] = p.pos;
  if (!dir || !script || p.flags.has('e')) return argv;
  let text: string;
  let source: string;
  if (script === '-') {
    text = readFileSync(0, 'utf8');
    source = '<stdin>';
  } else {
    if (!existsSync(script)) throw new UsageError(`run: no such script ${script}`);
    text = readFileSync(script, 'utf8');
    source = script;
  }
  const by = one(p, 'by');
  return ['run', dir, '-e', text, '--source', source, ...(by !== undefined ? ['--by', by] : [])];
}

/** `soundclaw library index [<id>...]`: measure the files of libraries on worker threads. */
async function libraryIndexMain(argv: string[]): Promise<number> {
  const p = parseArgs(argv, ...WRITE_OPTS.library!);
  const registered = readRegistry().map((l) => l.id);
  const ids = p.pos.length ? p.pos : registered;
  if (!ids.length) throw new ProjectError('no libraries registered (soundclaw library add <folder> [--name <id>] [licence=<id>])');
  const w = one(p, 'workers');
  if (w !== undefined && (!Number.isInteger(Number(w)) || Number(w) < 0 || Number(w) > 32)) throw new UsageError('--workers is a whole number from 0 (this thread) to 32');
  for (const id of ids) {
    let shown = -1;
    const stats = await indexLibrary(id, {
      rebuild: p.flags.has('rebuild'),
      ...(w !== undefined ? { workers: Number(w) } : {}),
      onProgress: process.stderr.isTTY ? (done, total) => {
        const pct = Math.floor((done / total) * 100);
        if (pct !== shown) { shown = pct; process.stderr.write(`\r${id}: ${done}/${total} files`); }
      } : undefined,
    });
    if (process.stderr.isTTY && shown >= 0) process.stderr.write('\r\x1b[K');
    process.stdout.write(indexStatsText(stats) + '\n');
  }
  return 0;
}

export async function cli(argv: string[]): Promise<number> {
  // A reader that stops early (`soundclaw history … | head`) closes the pipe: stop quietly, as Unix
  // tools do, instead of failing on an unhandled EPIPE.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
  // --version, help <command> and <command> --help need no project (and `await` and `serve` are not parsed by main).
  try {
    const meta = metaCommand(argv, out);
    if (meta !== null) return meta;
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`error: ${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (argv[0] === 'serve') {
    const code = await serveMain(argv.slice(1));
    // Nothing else should keep the process alive once the server has stopped.
    process.exit(code);
  }
  try {
    if (argv[0] === 'await') return await awaitMain(argv.slice(1), out);
    if (argv[0] === 'library' && argv[1] === 'index') return await libraryIndexMain(argv.slice(2));
    if (argv[0] === 'generate') return await generateMain(argv.slice(1));
    const args = argv[0] === 'run' ? resolveRunArgv(argv) : argv;
    const sent = await forwardToServer(args, out);
    if (sent !== null) return sent;
    const code = main(args);
    // A listing of a project with open requests says whether anything is waiting for them.
    const listing = args[0] === 'list' || (args[0] === 'request' && args.length === 2);
    if (listing && args[1] && code === 0) process.stdout.write(await listenerLine(args[1]));
    return code;
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`error: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    if (e instanceof ProjectError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
