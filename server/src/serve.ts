// `soundclaw serve`: one process that owns a project. It speaks MCP on stdin/stdout (for the
// agent) and serves the dashboard on localhost (for people), both through one writer. Logs go to
// stderr, since stdout carries MCP.

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { startWatchServer, type WatchServer } from './http.ts';
import { createMcpServer } from './mcp.ts';
import { acquireLock, createProject, loadProject, releaseLock, type Project } from './project.ts';
import { lastToken, removeTokenFile, writeTokenFile } from './runfile.ts';
import { Writer } from './writer.ts';

export const VERSION = '0.1.0';
export const DEFAULT_PORT = 7427;

export interface ServeOptions {
  /** The project folder; created (empty) if it has no project.json. */
  project: string;
  /** The port to try first (then the next 19); 0 picks a free one. Default 7427. */
  port?: number;
  /** Speak MCP on stdin/stdout (default). Without it, serve only the dashboard. */
  mcp?: boolean;
  token?: string;
  /** Runs a CLI invocation against the writer, for commands sent by another `soundclaw` process (the CLI supplies it). */
  runCli?: (argv: string[], writer: Writer, cwd: string) => { code: number; stdout: string; stderr: string };
  log?: (line: string) => void;
}

export interface Served {
  url: string;
  port: number;
  token: string;
  writer: Writer;
  web: WatchServer;
  /** Stop everything: MCP, the web server and the project lock. */
  close(): Promise<void>;
  /** Resolves once the server has stopped (stdin closed, a signal, or close()). */
  closed: Promise<void>;
}

function openProject(dir: string, log: (s: string) => void): Project {
  if (existsSync(join(dir, 'project.json'))) return loadProject(dir);
  log(`soundclaw: created an empty project at ${dir}`);
  return createProject(dir);
}

export async function serve(o: ServeOptions): Promise<Served> {
  const log = o.log ?? ((s: string) => process.stderr.write(s + '\n'));
  const dir = resolve(o.project);
  // a server started again on the same folder keeps the token, so a dashboard left open reconnects and sends what it queued
  const token = o.token ?? lastToken(dir) ?? randomBytes(16).toString('hex');
  const writer = new Writer(openProject(dir, log));
  let web!: WatchServer;
  const host = { writer, url: () => web.url };
  web = await startWatchServer({ writer, token, port: o.port ?? DEFAULT_PORT, mcp: () => createMcpServer(host, VERSION), runCli: o.runCli });
  try {
    acquireLock(dir, web.url);
    writeTokenFile(dir, { url: web.url.replace(/\?.*$/, ''), token });
  } catch (e) {
    releaseLock(dir);
    await web.close();
    throw e;
  }

  let mcp: StdioServerHandle | null = null;
  let stopping: Promise<void> | null = null;
  let done!: () => void;
  const closed = new Promise<void>((r) => { done = r; });
  const close = (): Promise<void> => {
    stopping ??= (async () => {
      process.stdin.off('end', onEnd);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      releaseLock(writer.project.dir);
      removeTokenFile(writer.project.dir);
      await mcp?.close().catch(() => undefined);
      await web.close();
      done();
    })();
    return stopping;
  };
  const onEnd = (): void => { void close(); };
  const onSignal = (): void => { void close(); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  if (o.mcp ?? true) {
    mcp = serveStdio(() => createMcpServer(host, VERSION), { onerror: (e) => log(`soundclaw: mcp: ${e.message}`) });
    // When the agent goes away (stdin closes), so does the server.
    process.stdin.on('end', onEnd);
  }
  log(`soundclaw: serving ${dir}`);
  log(`soundclaw: watch at ${web.url}`);
  return { url: web.url, port: web.port, token, writer, web, close, closed };
}
