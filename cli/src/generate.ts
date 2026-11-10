// `soundclaw generate`: audio from a prompt (a provider call per take), the estimate, the ledger and the settings. It is asynchronous (it waits
// on the network), so it runs from entry.ts. While a server owns the project the command is sent to it (POST /api/generate): the server makes
// the calls with the key in its own environment and writes the takes through its writer, so the dashboard shows them as they land.

import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { resolve } from 'node:path';
import {
  ProjectError, Writer, configText, estimateText, findServer, generateJson, generateOptions, generateText, ledgerText, ledgerTotals, loadProject, lockHolder, planGeneration,
  readGenerationConfig, runGeneration, setGenerationConfig, shellArg, type GenerateBody, type ServerRef,
} from '@soundclaw/server';
import { AUTHOR_RE } from '@soundclaw/core';
import { UsageError, one, parseArgs } from './main.ts';

export const GENERATE_OPTS: [string[], string[]] = [['by', 'again'], ['estimate', 'json', 'ledger']];

const out = (s: string): void => { process.stdout.write(s); };

/** `key=value` words (the value may hold `=`), checked for shape only. */
function pairs(words: string[]): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const w of words) {
    const i = w.indexOf('=');
    if (i < 1) throw new UsageError(`generate: '${w}' is not key=value (the prompt is one quoted word: generate <project> sfx "<prompt>" duration=2)`);
    kv[w.slice(0, i)] = w.slice(i + 1);
  }
  return kv;
}

function post(ref: ServerRef, body: GenerateBody): Promise<{ status: number; text: string }> {
  return new Promise((resolveP, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = request(new URL('/api/generate', ref.base), { method: 'POST', headers: { Authorization: `Bearer ${ref.token}`, 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (d: Buffer) => parts.push(d));
      res.on('end', () => resolveP({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(data);
  });
}

export async function generateMain(argv: string[]): Promise<number> {
  const p = parseArgs(argv, ...GENERATE_OPTS);
  const json = p.flags.has('json');
  if (p.pos[0] === 'config') {
    const kv = Object.entries(pairs(p.pos.slice(1)));
    out(configText(kv.length ? setGenerationConfig(kv) : readGenerationConfig()));
    return 0;
  }
  if (p.flags.has('ledger')) {
    if (p.pos.length > 1) throw new UsageError('generate --ledger [<project>]');
    const dir = p.pos[0] ? loadProject(p.pos[0]).dir : null;
    const t = ledgerTotals(dir);
    out(json ? JSON.stringify(t, null, 1) + '\n' : ledgerText(t, dir));
    return 0;
  }
  const by = one(p, 'by') ?? 'agent:claude';
  const full = by.includes(':') ? by : `agent:${by}`;
  if (!AUTHOR_RE.test(full)) throw new UsageError(`--by is agent:<name> or human:<name>, not '${by}'`);
  const [dir, ...rest] = p.pos;
  if (!dir) throw new UsageError('generate: generate <project> sfx|music "<prompt>" [duration=<s>] [takes=<n>] ... | generate <project> --again <sample> | generate --ledger | generate config');
  const again = one(p, 'again');
  const body: GenerateBody = { pairs: {}, by: full, estimate: p.flags.has('estimate'), json };
  if (again) {
    body.again = again;
    body.pairs = pairs(rest);
  } else {
    const [kind, prompt, ...more] = rest;
    if (!kind || prompt === undefined) throw new UsageError('generate: give sfx or music and a prompt in quotes: generate <project> sfx "the slow creak of a door" duration=2 takes=3');
    body.kind = kind;
    body.prompt = prompt;
    body.pairs = pairs(more);
  }
  if (body.pairs.composition !== undefined && !body.pairs.composition.trim().startsWith('{')) {
    const f = body.pairs.composition;
    if (!existsSync(f)) throw new UsageError(`composition=${f}: no such file (a composition plan is a JSON file)`);
    body.pairs.composition = readFileSync(f, 'utf8');
  }
  // a server that owns the project makes the calls and writes the takes
  const ref = body.estimate ? null : findServer(resolve(dir));
  if (ref) {
    let r: { status: number; text: string };
    try { r = await post(ref, body); } catch (e) { throw new ProjectError(`could not reach the soundclaw server that owns ${dir}: ${(e as Error).message}`); }
    let j: { text?: string; json?: unknown; error?: string };
    try { j = JSON.parse(r.text); } catch { throw new ProjectError(`the server answered ${r.status}`); }
    if (r.status !== 200) throw new ProjectError(j.error ?? `the server answered ${r.status}`);
    out(json ? JSON.stringify(j.json, null, 1) + '\n' : j.text ?? '');
    return 0;
  }
  if (!body.estimate) {
    const held = lockHolder(loadProject(dir).dir);
    if (held) throw new ProjectError(`a soundclaw server (pid ${held.pid}) owns ${dir} and the command could not be sent to it (its token file must be readable by you); use its MCP generate tool or stop it first`);
  }
  const w = new Writer(loadProject(dir));
  try {
    const o = generateOptions(w, body);
    if (body.estimate) {
      const plan = planGeneration(w, o);
      out(json ? JSON.stringify({ estimate: plan.total, perTake: plan.perTake, names: plan.names, budget: plan.budget, licence: plan.licence, refusals: plan.refusals }, null, 1) + '\n' : estimateText(plan));
      return 0;
    }
    const r = await runGeneration(w, o);
    out(json ? JSON.stringify(generateJson(r), null, 1) + '\n' : generateText(r, shellArg(dir)));
    return 0;
  } finally {
    await w.thumbs.close();
  }
}
