// The MCP tools: project, run, history, render, export, request, work and await_requests. Few
// tools; the command language carries the rest. Every call goes through the writer's queue, in
// the order it arrives.

import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { openRequests } from '@soundclaw/core';
import { formatEvents } from './await.ts';
import { exportSounds } from './export.ts';
import { ProjectError } from './project.ts';
import { formatErrors, formatExport, plural } from './report.ts';
import { MCP_STEPS, agentWork, awaitRequests, listenerNote, markSeen, personRequest, readRequests, requestBrief, requestLine, toPersonRequest } from './requests.ts';
import { historyText, soundSummary } from './summary.ts';
import type { Writer } from './writer.ts';

/** The author name every MCP batch is written with. */
export const AGENT = 'agent:claude';

export const SERVER_NAME = 'soundclaw';

export const INSTRUCTIONS = `SoundClaw is a sound effects and music workbench you drive with a small command language. You cannot hear: every result ends with numbers for each sound it touched (length, peak, rms, a hash of the samples); a person listens in the dashboard.

Start with the \`project\` tool: it lists the sounds and gives a watch link (http://127.0.0.1:…/?token=…). Give the person that link so they can listen, and ask for changes or approve on each sound's card.

Make sounds with \`run\` (one batch = one undo group; any error applies nothing). Commands, one per line or separated by ';' ('#' starts a comment):
  sound new <id>                                   a new sound (ids: a-z, 0-9, _ and -; a placeholder sine tone for now)
  sound set <id> <param>=<value> [<param>=<value>...]   frequency (20-20000 Hz), duration (0.01-10 s), volume (0-1)
  sound mark <id> approved|rejected|draft ["note"]   a status mark (people use the buttons; the note says why)
  undo [group=<g>] [by=<author>]   |   redo [group=<undo group>] [by=<author>]      run alone, as the only command of the batch
\`history\` reads the tape: every command with its number, author (agent:<name> or human:<name>) and undo group, undone groups marked. People edit in the dashboard too, as human:<name>; call \`history\` (by=… to pick one person) at the start of each turn while someone is watching, and carry on from what they did; never silently redo it. \`render\` gives a sound's numbers; \`export\` writes WAV files (16-bit, 44,100 Hz, mono).

Requests: people ask for changes on a sound's card (Ask for changes, with a note). \`work\` claims the next open request and says what is asked; post progress with work(action="progress", text=…); finish with work(action="done", text=<what changed>) or, when you need the person, work(action="blocked", text=<one clear question>). While you are between tasks, keep \`soundclaw await <project>\` running in the background (its exit wakes you), or call await_requests.`;

const text = (t: string) => ({ type: 'text' as const, text: t });
const fail = (t: string): CallToolResult => ({ content: [text(t)], isError: true });

function errorResult(e: unknown): CallToolResult {
  if (e instanceof ProjectError || e instanceof SyntaxError) return fail(`error: ${e.message}`);
  throw e;
}

export function projectSummary(w: Writer, url: string): string {
  const p = w.project;
  const lines = [`project: ${p.json.name} (${p.dir})`, `watch: ${url}`];
  const sounds = w.sounds();
  lines.push('', sounds.length ? `sounds (${sounds.length}):` : 'sounds: none yet. Make one with run: "sound new beep; sound set beep frequency=880".');
  for (const s of sounds) lines.push(`  ${soundSummary(w, s.id)}`);
  const open = openRequests(readRequests(p));
  if (open.length) lines.push('', `requests from people (${open.length}):`, ...open.map((q) => `  ${requestLine(q)}`));
  const note = listenerNote(w);
  if (note) lines.push('', note);
  return lines.join('\n');
}

export interface McpHost {
  writer: Writer;
  /** The dashboard's URL, with its token. */
  url(): string;
}

export function createMcpServer(host: McpHost, version: string): McpServer {
  const w = host.writer;
  const server = new McpServer({ name: SERVER_NAME, version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  server.registerTool('project', {
    title: 'Project',
    description: 'Show the open project: its sounds with their numbers, the requests people made, and the live watch link for the person.',
    inputSchema: z.object({}),
  }, () => w.enqueue(() => {
    try {
      return { content: [text(projectSummary(w, host.url()))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('run', {
    title: 'Run commands',
    description: 'Apply command text as one undo group. Returns the commands as written to the tape (normal form), the numbers of every sound they changed, and warnings. ' +
      'Any parse or semantic error is reported with its line and column, and nothing is applied. `undo` and `redo` are commands too and run alone. The person watching sees the sounds change on their cards.',
    inputSchema: z.object({
      commands: z.string().describe('One or more lines of the command language'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      const r = w.run({ commands: a.commands, by: AGENT });
      if (!r.ok) return fail(formatErrors('commands', r.errors));
      if (!r.added.length) return { content: [text('no commands')] };
      const lines = [`applied ${plural(r.added.length, 'command')} as group ${r.group}`, ...r.added.map((e) => `  #${e.seq} ${e.cmd}`)];
      for (const id of r.touched) lines.push(soundSummary(w, id));
      lines.push(r.warnings.length ? `warnings: ${r.warnings.join('; ')}` : 'warnings: none');
      return { content: [text(lines.join('\n'))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('history', {
    title: 'Read the tape',
    description: 'Read the history: every command in order with its number, author and undo group; undone groups are marked. Includes what people did in the dashboard (human:<name>). ' +
      'By default the last 50 commands. Undo is a command (`undo` or `undo group=g4` through run).',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({
      sound: z.string().optional().describe('Only commands about this sound'),
      by: z.string().optional().describe('Only commands by this author, e.g. human:ana'),
      last: z.number().int().min(1).optional().describe('Only the last N commands (default 50)'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      return { content: [text(historyText(w, { sound: a.sound, by: a.by, limit: a.last ?? 50 }))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('render', {
    title: 'Render a sound',
    description: 'Render a sound (through the content-hash cache) and return its numbers: samples, duration, peak, rms and a hash of the samples. The same document always gives the same hash; the dashboard plays exactly these samples.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({ sound: z.string() }),
  }, (a) => w.enqueue(() => {
    try {
      const r = w.render(a.sound); // first, so the summary does not warm the cache
      return { content: [text(`${soundSummary(w, a.sound)}\nrender key ${r.key.slice(0, 12)}${r.cached ? ' (from the render cache)' : ''}`)] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('export', {
    title: 'Export WAV files',
    description: 'Write sounds as WAV files (16-bit PCM, 44,100 Hz, mono) to a folder (default <project>/exports, which git ignores). Without sounds, all of them.',
    inputSchema: z.object({
      sounds: z.array(z.string()).optional().describe('The sounds to export (default all)'),
      out: z.string().optional().describe('The folder to write into'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      return { content: [text(formatExport(exportSounds(w, a.sounds ?? [], a.out)))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  // Filing, answering and withdrawing requests: what the dashboard's buttons do.
  server.registerTool('request', {
    title: 'File, answer or withdraw a request',
    description: 'Ask for a change the way the dashboard does: action "request" (the default) with sound and a note saying what should change (this also writes `sound mark <sound> rejected "<note>"` on the history). ' +
      'action "reply" answers a blocked request (id, text) and opens it again; "cancel" withdraws one (id, optional text). Returns the request as it stands.',
    inputSchema: z.object({
      action: z.enum(['request', 'reply', 'cancel']).optional().describe('Default request'),
      sound: z.string().optional().describe('request: the sound'),
      note: z.string().optional().describe('request: what should change'),
      id: z.string().regex(/^r\d+$/).optional().describe('reply, cancel: the request'),
      text: z.string().optional().describe('reply: the answer; cancel: why'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      const q = personRequest(w, AGENT, toPersonRequest(a));
      w.requestsChanged();
      return { content: [text(requestLine(q))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('work', {
    title: 'Work on requests',
    description: 'The request queue: what people asked for in the dashboard. ' +
      'With no action (or action "next"), claim the next open request (or the one named by id) and get what is asked, with the sound as it stands. ' +
      'action "progress" posts a short note the person sees; "done" finishes it with what changed; "blocked" stops it with one clear question for the person (they answer in the dashboard and it opens again). ' +
      '"list" shows every request still open, claimed or blocked.',
    inputSchema: z.object({
      action: z.enum(['next', 'progress', 'done', 'blocked', 'list']).optional(),
      id: z.string().regex(/^r\d+$/).optional().describe('A request id (default: the next open one, or the one you claimed)'),
      text: z.string().optional().describe('progress: a short note; done: what changed; blocked: the question'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      const action = a.action ?? 'next';
      if (action === 'list') {
        w.hub.touch(AGENT);
        const active = openRequests(readRequests(w.project));
        // Listing hands the open requests over: they are now seen.
        markSeen(w, active.filter((x) => x.state === 'open').map((x) => x.id), AGENT);
        return { content: [text(active.length ? active.map((q) => requestLine(q)).join('\n') : 'no open requests')] };
      }
      const r = action === 'next' ? agentWork(w, AGENT, { action, id: a.id }) : agentWork(w, AGENT, { action, id: a.id, text: a.text ?? '' });
      w.requestsChanged();
      if (!r.request) return { content: [text(r.message)] };
      if (action !== 'next') {
        const left = openRequests(readRequests(w.project)).filter((x) => x.state === 'open').length;
        return { content: [text(`${r.message}${action === 'progress' ? '' : `. ${left ? `${plural(left, 'open request')} left: call work for the next.` : 'No open requests left.'}`}`)] };
      }
      return { content: [text(`${r.message}\n${requestBrief(w, r.request, MCP_STEPS)}`)] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  // Waiting for people: returns as soon as one files, answers or withdraws a request, or approves or rejects a sound.
  server.registerTool('await_requests', {
    title: 'Wait for requests and feedback',
    description: 'Wait until a person files, answers or withdraws a request, or approves or rejects a sound in the dashboard, then return what happened (with the next step: `work` claims a request, `history` reads a mark). ' +
      'Returns empty when the timeout passes. Pass back the returned cursor as `cursor` so nothing is missed or repeated; with none, requests still open and unseen are returned. ' +
      'While you are waiting the dashboard shows that an agent is listening, and the requests handed to you are marked seen. A model is not woken by anything else, so for long waits between tasks run `soundclaw await <project>` in the background instead (its exit wakes you).',
    inputSchema: z.object({
      timeout: z.number().int().min(1).max(120).optional().describe('Seconds to wait (default 30, at most 120)'),
      cursor: z.string().optional().describe('The cursor the last call returned'),
    }),
  }, async (a, extra) => {
    try {
      const r = await awaitRequests(w, { cursor: a.cursor, timeoutS: Math.min(120, a.timeout ?? 30), by: AGENT, via: 'mcp', signal: (extra as { signal?: AbortSignal } | undefined)?.signal });
      return { content: [text(formatEvents(r.events, r.cursor))] };
    } catch (e) {
      return errorResult(e);
    }
  });

  return server;
}
