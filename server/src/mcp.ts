// The MCP tools: project, run, history, render, export, request, work and await_requests. Few
// tools; the command language carries the rest. Every call goes through the writer's queue, in
// the order it arrives.

import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { openRequests } from '@soundclaw/core';
import { formatEvents } from './await.ts';
import { changesText } from './changes.ts';
import { checkText, describeText, exportFormat, formatExportFiles, importCommands, renderText, viewSound } from './ears.ts';
import { ProjectError } from './project.ts';
import { formatErrors, plural } from './report.ts';
import { MCP_STEPS, agentWork, awaitRequests, listenerNote, markSeen, personRequest, readRequests, requestBrief, requestLine, toPersonRequest } from './requests.ts';
import { historyText, soundSummary } from './summary.ts';
import type { Writer } from './writer.ts';

/** The author name every MCP batch is written with. */
export const AGENT = 'agent:claude';

export const SERVER_NAME = 'soundclaw';

export const INSTRUCTIONS = `SoundClaw is a sound effects and music workbench you drive with a small command language. You cannot hear, so you have ears: every result ends with numbers for each sound it touched (duration, loudness, peaks, attack, tail, brightness, pitch, onsets) and a one-line check summary, \`view\` shows a picture (waveform, spectrogram, pitch track, A/B comparison), \`describe\` says it in words, \`check\` lists what fails and where. A person listens in the dashboard.

Start with the \`project\` tool: it lists the sounds and gives a watch link (http://127.0.0.1:…/?token=…). Give the person that link so they can listen, and ask for changes or approve on each sound's card.

Make sounds with \`run\` (one batch = one undo group; any error applies nothing). Commands, one per line or separated by ';' ('#' starts a comment):
  sound new <id> voice=classic [preset=<category>] [seed=<n>]   the classic voice: 25 sfxr-style parameters; presets pickup, laser, explosion, powerup, hit, jump, blip (seeded: same seed, same sound)
  sound new <id>                                   a placeholder sine tone (frequency 20-20000 Hz, duration 0.01-10 s, volume 0-1)
  sound set <id> <param>=<value> [<param>=<value>...]   classic parameters (wave=square|saw|sine|noise, attack, sustain, punch, decay, freq, minFreq, slide, deltaSlide, vibratoDelay, vibratoDepth, vibratoSpeed, changeAmount, changeSpeed, duty, dutySweep, repeatSpeed, phaserOffset, phaserSweep, lowPass, lowPassSweep, resonance, highPass, highPassSweep, volume; seed) with their ranges in docs/commands.md
  sound patch <id> "<single-patch text>"           all 25 values at once (sfxr text: numbers in order, or name=value pairs)
  sound generate <id> <category|random> [seed=<n>]   a new random patch for a classic sound, from a category's ranges (or any sound: random)
  sound mutate <id> [amount=0.05] [seed=<n>] [as=<new id>]   a small seeded change to a classic sound
  sound mark <id> approved|rejected|draft ["note"]   a status mark (people use the buttons; the note says why)
Layered sounds (several voices summed; use them when one sfxr voice is not enough: impacts, doors, magic, footsteps, anything with a body and a top):
  sound new <id> voice=layered [preset=footstep|ui-click|door|magic|<classic category>] [seed=<n>]   up to 8 layers; sound set <id> duration=<s|auto> gain=<g> seed=<n>
  layer add <id> classic|osc|fm|ks|sample [<param>=<value> ...] [at=<n>]   osc: wave sine|square|saw|triangle|pulse|wavetable|white|pink|brown|metal, freq, duty, dur; fm: ops 2-4, algo, ratio1-4, index2-4; ks (pluck): freq, decay, bright; sample: sample=<name>, start, end, pitch, reverse; every layer: offset, gain, pan, filter=off|lp|hp|bp|notch, cutoff, q
  layer set <id> <n> <param>=<value> ...  |  layer remove|move|mute|solo <id> <n> [to=<m> | on|off]   (layers count from 1; source=<kind> changes a layer's source)
  env <id> <target> "<time>:<value>[@lin|exp|hold|ease] ..." | adsr(a,d,s,r[,hold]) | clear   an envelope replaces a fixed value; targets 1.freq 1.amp 1.cutoff 2.pan 1.fx1.mix master.fx1.mix
  fx add <id> [layer=<n>] filter|distort|bitcrush|chorus|delay|reverb [<param>=<value> ...] [at=<k>]  |  fx set|remove|move <id> [layer=<n>] <k> ...   (no layer= : the master chain)
  sound layer-up <id>   a classic sound becomes layered, same samples   |   sound classic <id> on|off   keep it one classic voice (exports as a synth.csv row)
  Order: source -> filter -> amp envelope -> effects -> gain -> pan, then the sum -> master gain -> master effects; export adds a limiter. Layered sounds export as WAV only. A layer with pan off centre makes the sound stereo. The \`layers\` view shows each layer; the \`harsh\` check flags sustained 2-5 kHz energy. \`sample\` imports a WAV for sample layers.
  undo [group=<g>] [by=<author>]   |   redo [group=<undo group>] [by=<author>]      run alone, as the only command of the batch
\`history\` reads the tape: every command with its number, author (agent:<name> or human:<name>) and undo group, undone groups marked. People edit in the dashboard too, as human:<name>; call \`history\` (by=… to pick one person) at the start of each turn while someone is watching, and carry on from what they did; never silently redo it. \`render\` gives a sound's numbers, description and checks; \`export\` writes wav (16-bit, 44,100 Hz, mono), patch (sfxr text) or csv (synth.csv) files; \`import\` makes classic sounds from an sfxr csv or patch.

Checks (clip, loudness, dc, click, tail) hold a sound to the project's style (default -16 LUFS ±1, true peak at most -0.1 dBTP, no click at the first or last sample, no cut tail). A request's work(action="done") is refused while its sound fails them: look at \`check\`, fix the sound (volume sets loudness; attack and decay remove clicks), then finish.

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
  lines.push('', sounds.length ? `sounds (${sounds.length}):` : 'sounds: none yet. Make one with run: "sound new zap voice=classic preset=laser seed=1".');
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

  server.registerTool('changes', {
    title: 'What others changed',
    description: 'What people (or other agents) changed since you last looked: each history group after your cursor with the parameters before and after, the numbers before and after (duration, loudness, centroid, pitch) and a before/after compare view saved as a PNG (the path is in the text). ' +
      'Your cursor is kept per agent in the project and moves when you read, unless you pass since or peek. Call this before editing a sound a person has touched, and never undo a person\'s edit silently.',
    annotations: { readOnlyHint: false },
    inputSchema: z.object({
      since: z.string().optional().describe('A command number (like 14) or a time: read from there, and leave the cursor alone'),
      by: z.string().optional().describe('human (people only), agent, or one author like human:ana. Default: everyone but you'),
      peek: z.boolean().optional().describe('Read without moving the cursor'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      return { content: [text(changesText(w, { agent: AGENT, since: a.since, by: a.by, peek: a.peek }))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('render', {
    title: 'Render a sound',
    description: 'Render a sound (through the content-hash cache) and return its numbers (samples, peak, rms, a hash of the samples; duration, loudness, true peak, attack, tail, brightness, pitch, onsets), a plain-words description, and the check summary as the last line. The same document always gives the same hash; the dashboard plays exactly these samples.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({ sound: z.string() }),
  }, (a) => w.enqueue(() => {
    try {
      const r = w.render(a.sound); // first, so the summary does not warm the cache
      const head = soundSummary(w, a.sound).split('\n')[0]!;
      return { content: [text(renderText(w, a.sound, `${head}\nrender key ${r.key.slice(0, 12)}${r.cached ? ' (from the render cache)' : ''}`))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('view', {
    title: 'View a sound',
    description: 'Your ears as a picture (PNG) with the numbers: wave (waveform, envelope, clip marks), spec (mel spectrogram with Hz and note rulers), pitch (YIN track over a note grid), layers (the layers of a layered sound stacked: waveform and spectrogram of each, with offsets), compare (this sound and `other` stacked with a difference spectrogram, and distance numbers). The image is also saved under <project>/.cache/views.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({
      sound: z.string(),
      kind: z.enum(['wave', 'spec', 'pitch', 'layers', 'compare']).optional().describe('Default spec'),
      other: z.string().optional().describe('compare: the second sound'),
    }),
  }, (a) => w.enqueue((): CallToolResult => {
    try {
      const v = viewSound(w, a.sound, a.kind ?? 'spec', { other: a.other });
      return { content: [{ type: 'image' as const, data: Buffer.from(v.png).toString('base64'), mimeType: 'image/png' }, text(v.text)] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('describe', {
    title: 'Describe a sound',
    description: 'A plain-words summary built only from the measured numbers (length, tonal or noisy, brightness, pitch motion, attack, tail, peak, loudness, onsets), then the numbers and the check summary.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({ sound: z.string() }),
  }, (a) => w.enqueue(() => {
    try {
      return { content: [text(describeText(w, a.sound))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('check', {
    title: 'Check sounds',
    description: 'Run the checks (clip, loudness, dc, click, tail) on sounds (all when none are named): pass or fail with a score, the threshold from the project style, and the exact time ranges flagged. `work` done is refused while a sound fails.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({ sounds: z.array(z.string()).optional() }),
  }, (a) => w.enqueue(() => {
    try {
      return { content: [text(checkText(w, a.sounds ?? []).text)] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('import', {
    title: 'Import sfxr patches',
    description: 'Make classic sounds from an sfxr synth.csv (one sound per row, the key column is the id), a single-patch text, or a path to either. NA and missing cells take the defaults. One undo group; any error applies nothing.',
    inputSchema: z.object({
      source: z.string().describe('The csv or patch text, or a path to a file holding it'),
      id: z.string().optional().describe('The sound id for a single patch'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      const { commands, ids, warnings } = importCommands(a.source, a.id ?? null);
      const r = w.run({ commands, by: AGENT });
      if (!r.ok) return fail(formatErrors('import', r.errors));
      return { content: [text([`imported ${plural(ids.length, 'sound')} (${ids.join(', ')}) as group ${r.group}`, ...warnings.map((x) => `warning: ${x}`), ...r.touched.map((id) => soundSummary(w, id))].join('\n'))] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('sample', {
    title: 'Sample',
    description: 'Samples for sample layers. import: copy a WAV file (PCM 8/16/24/32-bit or float, any rate, mixed to mono, at most 60 s) into <project>/samples/ under a name (default: the file name); then `layer add <id> sample sample=<name> ...` uses it. list: the samples in the project.',
    inputSchema: z.object({
      action: z.enum(['import', 'list']),
      file: z.string().optional().describe('import: path of the WAV file'),
      as: z.string().optional().describe('import: the sample\'s name (a-z, 0-9, _ and -)'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      if (a.action === 'list') {
        const list = w.samples.list();
        return { content: [text(list.length ? list.map((x) => `${x.name}: ${x.seconds.toFixed(3)} s, ${x.rate} Hz, sha256 ${x.sha256.slice(0, 12)}`).join('\n') : 'no samples')] };
      }
      if (!a.file) return fail('import needs file');
      const r = w.samples.import(a.file, a.as);
      w.samplesChanged();
      return { content: [text(`${r.created ? 'imported' : 'already in the project:'} sample ${r.info.name}: ${r.info.seconds.toFixed(3)} s, ${r.info.rate} Hz, sha256 ${r.info.sha256.slice(0, 12)}`)] };
    } catch (e) {
      return errorResult(e);
    }
  }));

  server.registerTool('export', {
    title: 'Export sounds',
    description: 'Write sounds to a folder (default <project>/exports, which git ignores). format wav (default): 16-bit PCM, 44,100 Hz; classic sounds as the engine\'s pre-rendered WAVs (trunc(s x 32000), mono); layered sounds through a limiter at the style\'s true-peak ceiling (mono, or stereo when a layer is panned), as WAV only. patch: a single-patch text per classic sound. csv: one synth.csv for the classic sounds. Without sounds, all of them.',
    inputSchema: z.object({
      sounds: z.array(z.string()).optional().describe('The sounds to export (default all)'),
      format: z.enum(['wav', 'patch', 'csv']).optional().describe('Default wav'),
      out: z.string().optional().describe('The folder to write into'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      return { content: [text(formatExportFiles(exportFormat(w, a.sounds ?? [], a.format ?? 'wav', a.out)))] };
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
      note: z.string().optional().describe('request: what should change (may be left out when tags say it)'),
      tags: z.array(z.enum(['too loud', 'too quiet', 'too long', 'too short', 'too harsh', 'too dull', 'too similar to another sound', 'good'])).optional().describe('request: the cards\' quick tags (good alone is praise: no mark)'),
      like: z.string().optional().describe('request with the tag too similar to another sound: the other sound'),
      id: z.string().regex(/^r\d+$/).optional().describe('reply, cancel: the request'),
      text: z.string().optional().describe('reply: the answer; cancel: why'),
    }),
  }, (a) => w.enqueue(() => {
    try {
      const q = personRequest(w, AGENT, toPersonRequest({ ...a, other: a.like }));
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
