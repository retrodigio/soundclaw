// `generate`: audio from a prompt, as samples. The command is worked out and checked before anything is sent (the provider, the takes'
// names, every cap), then each take is one call, then the takes go into the store and onto the tape as `sample add … source=generated` with
// their provenance (provider, endpoint, model, prompt, parameters, take n/m, request id, credits) and the licence the provider's plan gives,
// as one undo group. Replay and undo never call a provider; `--again` is a new call with the recorded prompt and parameters.
//
// Costs are capped before the first call: each take's estimate against the per-call maximum, the whole command against what is left of the
// project's cap (project.json "generation": {"capCredits": n}; 0, the default, keeps paid generation off) and of the user's daily cap. What each
// command cost is logged in the project's generation.jsonl (tracked, no key) and in the user's spend.jsonl (across projects).

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  SAMPLE_NAME_RE, bandEnergies, describeSample, matchQuery, measureSample, parseQuery, pcmChannels, pcmHash, rangeCentre, sampleAddText, sha256Hex, similarDistance, similarVector,
  type PcmAudio, type Query, type SampleEntry, type SampleMeasure,
} from '@soundclaw/core';
import { compareSide } from './ears.ts';
import { configDir } from './library.ts';
import { ProjectError, loadProject } from './project.ts';
import { GEN_KINDS, PLAN_RE, estimateTake, getProvider, redact, type GenKind, type GenRequest, type Provider, type ProviderSettings, type TakeOut } from './providers.ts';
import { commitImports, decodeFileBytes, type Prepared } from './sampleimport.ts';
import { monoAt44, sampleFacts, sampleNumbers } from './sampleview.ts';
import type { Writer } from './writer.ts';

// ---- the user's configuration ------------------------------------------------------------------------------------------

export interface GenerationConfig {
  /** The provider `generate` uses when the command names none. */
  provider?: string;
  /** Credits a day across every project (UTC days). */
  dailyCap?: number;
  /** Credits one call (one take) may cost. */
  maxPerCall?: number;
  providers?: Record<string, ProviderSettings>;
}

export const GENERATION_DEFAULTS = { provider: 'elevenlabs', dailyCap: 3000, maxPerCall: 300 } as const;

export const generationConfigFile = (): string => join(configDir(), 'generation.json');
export const spendFile = (): string => join(configDir(), 'spend.jsonl');

export function readGenerationConfig(): GenerationConfig {
  const f = generationConfigFile();
  if (!existsSync(f)) return {};
  try {
    const j = JSON.parse(readFileSync(f, 'utf8')) as GenerationConfig;
    return j && typeof j === 'object' ? j : {};
  } catch (e) {
    throw new ProjectError(`${f} is not readable (${(e as Error).message}); fix it, or remove it for the defaults`);
  }
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const nonNegative = (k: string, v: string): number => {
  const n = Number(v);
  if (!/^\d+(\.\d+)?$/.test(v) || !Number.isFinite(n)) throw new ProjectError(`${k} is a number of credits, 0 or more (not '${v}')`);
  return n;
};

/** The keys `generate config` sets. */
export const CONFIG_KEYS = ['provider', 'daily-cap', 'max-per-call', '<provider>.plan', '<provider>.music', '<provider>.format', '<provider>.rate.sfx', '<provider>.rate.music', '<provider>.url'];

/** `generate config key=value ...`: change the user's generation settings (`<key>=none` clears one). */
export function setGenerationConfig(pairs: [string, string][]): GenerationConfig {
  const c = readGenerationConfig();
  for (const [k, v] of pairs) {
    const clear = v === 'none';
    if (k === 'provider') { if (clear) delete c.provider; else { getProvider(v); c.provider = v; } continue; }
    if (k === 'daily-cap') { if (clear) delete c.dailyCap; else c.dailyCap = nonNegative(k, v); continue; }
    if (k === 'max-per-call') { if (clear) delete c.maxPerCall; else c.maxPerCall = nonNegative(k, v); continue; }
    const m = /^([a-z0-9]+)\.(plan|music|format|url|rate\.(sfx|music))$/.exec(k);
    if (!m) throw new ProjectError(`no setting '${k}' (${CONFIG_KEYS.join(', ')})`);
    getProvider(m[1]!);
    const s: ProviderSettings = { ...(c.providers?.[m[1]!] ?? {}) };
    const field = m[2]!;
    if (field === 'plan') { if (clear) delete s.plan; else if (PLAN_RE.test(v)) s.plan = v; else throw new ProjectError(`plan is a word like free, starter, creator or pro (not '${v}')`); }
    else if (field === 'music') { if (clear || v === 'off' || v === 'no') delete s.music; else if (v === 'on' || v === 'yes') s.music = true; else throw new ProjectError(`${k} is on or off`); }
    else if (field === 'format') { if (clear) delete s.format; else if (/^(pcm_\d{4,6}|mp3_\d{4,6}_\d{2,3})$/.test(v)) s.format = v; else throw new ProjectError(`${k} is pcm_<rate> or mp3_<rate>_<kbps>, like pcm_44100 or mp3_44100_128`); }
    else if (field === 'url') { if (clear) delete s.url; else if (/^https?:\/\/\S+$/.test(v)) s.url = v; else throw new ProjectError(`${k} is an http(s) address`); }
    else {
      const kind = m[3] as GenKind;
      const rates = { ...(s.rates ?? {}) };
      if (clear) delete rates[kind]; else rates[kind] = nonNegative(k, v);
      if (Object.keys(rates).length) s.rates = rates; else delete s.rates;
    }
    c.providers = { ...(c.providers ?? {}), [m[1]!]: s };
    if (!Object.keys(s).length) delete c.providers[m[1]!];
  }
  writeAtomic(generationConfigFile(), JSON.stringify(c, null, 1) + '\n');
  return c;
}

export function configText(c: GenerationConfig): string {
  const lines = [
    `provider ${c.provider ?? GENERATION_DEFAULTS.provider}${c.provider ? '' : ' (the default)'}`,
    `daily cap ${c.dailyCap ?? GENERATION_DEFAULTS.dailyCap} credits across projects${c.dailyCap === undefined ? ' (the default)' : ''}`,
    `per call at most ${c.maxPerCall ?? GENERATION_DEFAULTS.maxPerCall} credits${c.maxPerCall === undefined ? ' (the default)' : ''}`,
  ];
  for (const id of ['elevenlabs', 'fake']) {
    const s = c.providers?.[id] ?? {};
    const p = getProvider(id);
    const lic = p.licence(s);
    lines.push(`${id}: ${'id' in lic ? `licence ${lic.id}` : 'plan not set'}${s.plan ? ` (plan ${s.plan})` : ''}; output ${p.outputFormat('sfx', s)}; ${GEN_KINDS.map((k) => `${k} ${p.rate(k, s)} credits/s`).join(', ')}${p.paid ? `; music ${s.music ? 'on' : 'held (soundclaw generate config ' + id + '.music=on)'}` : ''}${s.url ? `; address ${s.url}` : ''}${p.keyVar ? `; key from ${p.keyVar} (${process.env[p.keyVar] ? 'set' : 'not set'} here)` : ''}`);
  }
  lines.push(`settings: ${generationConfigFile()}`);
  return lines.join('\n') + '\n';
}

// ---- ledgers -------------------------------------------------------------------------------------------------------------

export const LEDGER_FILE = 'generation.jsonl';

export interface TakeRecord {
  take: number;
  name?: string;
  hash?: string;
  credits?: number;
  request?: string;
  error?: string;
}

/** One line of a project's generation.jsonl: one command. No key, no absolute path. */
export interface LedgerLine {
  at: string;
  by: string;
  provider: string;
  endpoint: string;
  model: string;
  kind: GenKind;
  prompt: string;
  params: Record<string, unknown>;
  takes: number;
  estimate: number;
  charge: number;
  /** Where the charge came from: the provider's answer (`header`), the account's counter before and after (`counter`), or the estimate when neither said. */
  chargeFrom: 'header' | 'counter' | 'estimate' | 'provider' | 'mixed';
  results: TakeRecord[];
  outcome: 'ok' | 'partial' | 'failed';
}

/** One line of the user's spend.jsonl. */
export interface SpendLine {
  at: string;
  project: string;
  dir: string;
  provider: string;
  endpoint: string;
  credits: number;
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l) as T); } catch { /* a torn line is skipped */ }
  }
  return out;
}

export const readLedger = (projectDir: string): LedgerLine[] => readJsonl<LedgerLine>(join(projectDir, LEDGER_FILE));
export const readSpend = (): SpendLine[] => readJsonl<SpendLine>(spendFile());

function appendLine(file: string, v: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(v) + '\n');
}

const day = (at: string): string => at.slice(0, 10);

export interface LedgerTotals {
  credits: number;
  commands: number;
  takes: number;
  byProvider: Record<string, number>;
  byDay: Record<string, number>;
  byProject?: Record<string, number>;
}

/** `generate --ledger`: a project's generation totals, or (no project) the user's spend across projects. */
export function ledgerTotals(projectDir: string | null): LedgerTotals {
  const add = (m: Record<string, number>, k: string, v: number): void => { m[k] = (m[k] ?? 0) + v; };
  const t: LedgerTotals = { credits: 0, commands: 0, takes: 0, byProvider: {}, byDay: {} };
  if (projectDir) {
    for (const l of readLedger(projectDir)) {
      t.credits += l.charge; t.commands++; t.takes += l.results.filter((r) => r.hash).length;
      add(t.byProvider, l.provider, l.charge); add(t.byDay, day(l.at), l.charge);
    }
    return t;
  }
  t.byProject = {};
  for (const l of readSpend()) {
    t.credits += l.credits; t.commands++;
    add(t.byProvider, l.provider, l.credits); add(t.byDay, day(l.at), l.credits); add(t.byProject, `${l.project} (${l.dir})`, l.credits);
  }
  return t;
}

export function ledgerText(t: LedgerTotals, projectDir: string | null): string {
  const rows = (title: string, m: Record<string, number>): string[] => [title, ...Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `  ${k}  ${round(v)} credits`)];
  if (!t.commands) return projectDir ? `no generation in this project yet (${LEDGER_FILE} is empty)\n` : `no generation spend recorded yet (${spendFile()})\n`;
  return [
    `${round(t.credits)} credits over ${t.commands} command${t.commands === 1 ? '' : 's'}${projectDir ? `, ${t.takes} take${t.takes === 1 ? '' : 's'} kept` : ' across projects'}`,
    ...rows('by provider:', t.byProvider),
    ...(t.byProject ? rows('by project:', t.byProject) : []),
    ...rows('by day (UTC):', t.byDay),
  ].join('\n') + '\n';
}

const round = (v: number): number => Math.round(v * 100) / 100;

// ---- the budget ----------------------------------------------------------------------------------------------------------

export interface Budget {
  projectCap: number;
  projectSpent: number;
  dailyCap: number;
  daySpent: number;
  maxPerCall: number;
}

/** The project's cap, read from project.json each time (a person may change it while a server runs). */
export function projectCap(dir: string): number {
  const j = loadProject(dir).json as { generation?: { capCredits?: unknown } };
  const v = j.generation?.capCredits;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

export function budgetOf(dir: string, now: string, cfg: GenerationConfig = readGenerationConfig()): Budget {
  const today = day(now);
  return {
    projectCap: projectCap(dir),
    projectSpent: readLedger(dir).reduce((n, l) => n + (l.charge || 0), 0),
    dailyCap: cfg.dailyCap ?? GENERATION_DEFAULTS.dailyCap,
    daySpent: readSpend().filter((l) => day(l.at) === today).reduce((n, l) => n + (l.credits || 0), 0),
    maxPerCall: cfg.maxPerCall ?? GENERATION_DEFAULTS.maxPerCall,
  };
}

export const budgetText = (b: Budget): string =>
  `budget: project ${round(b.projectSpent)} of ${b.projectCap} credits spent (${round(Math.max(0, b.projectCap - b.projectSpent))} left${b.projectCap === 0 ? '; paid generation is off until a person sets project.json "generation": {"capCredits": <credits>}' : ''}); today ${round(b.daySpent)} of ${b.dailyCap} (${round(Math.max(0, b.dailyCap - b.daySpent))} left); one call at most ${b.maxPerCall}`;

// ---- planning a command --------------------------------------------------------------------------------------------------

export interface GenerateOptions {
  kind: GenKind;
  prompt: string;
  duration?: number;
  takes?: number;
  loop?: boolean;
  influence?: number;
  model?: string;
  composition?: unknown;
  /** The takes' names are <as>_t1, <as>_t2, ... (numbering goes on after takes already there). */
  as?: string;
  /** A numbers query the takes are ranked against. */
  want?: string;
  /** A sound or sample:<name> the takes are ranked by closeness to. */
  like?: string;
  provider?: string;
  tags?: string;
  by: string;
}

export interface GeneratePlan {
  provider: Provider;
  settings: ProviderSettings;
  o: GenerateOptions;
  kind: GenKind;
  prompt: string;
  duration: number;
  takes: number;
  loop: boolean;
  influence?: number;
  model: string;
  names: string[];
  firstTake: number;
  perTake: number;
  total: number;
  budget: Budget;
  licence: string;
  params: Record<string, unknown>;
  paramsText: string;
  /** Why the command would be refused (empty: it may run). Refusals come before the first call. */
  refusals: string[];
  want?: Query;
  like?: { label: string; vector: number[] };
}

const STOP = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'or', 'no', 'not', 'in', 'on', 'at', 'to', 'for', 'from', 'very', 'some', 'its', 'it', 'is', 'that', 'this', 'as', 'by', 'into', 'over']);

/** A name for takes from the prompt's first few words: "the slow creak of an old door" gives slow_creak_old. */
export function nameFromPrompt(prompt: string): string {
  const words = prompt.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => !STOP.has(w)) ?? [];
  const n = words.slice(0, 3).join('_').slice(0, 40).replace(/_+$/, '');
  return n && /^[a-z0-9]/.test(n) ? n : 'take';
}

const isPaidOff = (): string | null => (process.env.CI ? 'CI is set' : process.env.SOUNDCLAW_NO_PAID === '1' ? 'SOUNDCLAW_NO_PAID=1 is set' : null);

/** Everything a command will do and cost, with every reason to refuse it; nothing is called. Runs on the writer (it reads names and samples). */
export function planGeneration(w: Writer, o: GenerateOptions, cfg: GenerationConfig = readGenerationConfig()): GeneratePlan {
  const provider = getProvider(o.provider ?? cfg.provider ?? GENERATION_DEFAULTS.provider);
  const settings = cfg.providers?.[provider.id] ?? {};
  if (!GEN_KINDS.includes(o.kind)) throw new ProjectError(`generate makes ${GEN_KINDS.join(' or ')}, not '${o.kind}'`);
  const lim = provider.limits.kinds[o.kind];
  if (!lim) throw new ProjectError(`${provider.id} does not make ${o.kind}`);
  const prompt = (o.prompt ?? '').trim();
  if (o.composition === undefined && !prompt) throw new ProjectError('give a prompt: what the sound is, in words');
  if (prompt.length > lim.maxPrompt) throw new ProjectError(`the prompt is ${prompt.length} characters; ${provider.id} ${o.kind} takes at most ${lim.maxPrompt}`);
  if (o.composition !== undefined && o.kind !== 'music') throw new ProjectError('a composition plan is for music');
  const duration = o.duration ?? lim.defaultDuration;
  if (!Number.isFinite(duration) || duration < lim.minDuration || duration > lim.maxDuration) throw new ProjectError(`duration ${o.duration}: ${provider.id} ${o.kind} is ${lim.minDuration} to ${lim.maxDuration} s`);
  const takes = o.takes ?? 1;
  if (!Number.isInteger(takes) || takes < 1 || takes > provider.limits.maxTakes) throw new ProjectError(`takes is 1 to ${provider.limits.maxTakes}`);
  const loop = !!o.loop;
  if (loop && !lim.loop) throw new ProjectError(`${provider.id} ${o.kind} does not make loops`);
  if (o.influence !== undefined && (!lim.influence || !(o.influence >= 0 && o.influence <= 1))) throw new ProjectError(lim.influence ? 'influence is 0 to 1 (how closely the audio follows the prompt)' : `${provider.id} ${o.kind} takes no influence`);
  const model = o.model ?? provider.defaultModel(o.kind);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(model)) throw new ProjectError(`'${model}' is not a model id`);
  // the names: <as>_t<n>, numbered after the takes already there
  const as = o.as ?? nameFromPrompt(prompt || 'music');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,43}$/.test(as)) throw new ProjectError(`'${as}' is not a name for takes (letters, digits, _ and -, at most 44 characters; the takes are <as>_t1, ...)`);
  const re = new RegExp(`^${as}_t(\\d+)$`, 'i');
  const have = w.samples.names();
  const firstTake = 1 + Math.max(0, ...have.map((n) => re.exec(n)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1])));
  const names = Array.from({ length: takes }, (_, i) => `${as}_t${firstTake + i}`);
  for (const n of names) {
    if (!SAMPLE_NAME_RE.test(n)) throw new ProjectError(`'${n}' is not a sample name`);
    const clash = have.find((x) => x.toLowerCase() === n.toLowerCase());
    if (clash) throw new ProjectError(`sample '${clash}' is there already; give another as=<name>`);
  }
  let want: Query | undefined;
  if (o.want) { try { want = parseQuery(o.want); } catch (e) { throw new ProjectError(`want: ${(e as Error).message}`); } }
  let like: GeneratePlan['like'];
  if (o.like) {
    const side = compareSide(w, o.like);
    like = { label: side.label, vector: similarVector(measureSample([side.samples], 44100, { maxSeconds: 20 }), bandEnergies(side.samples)) };
  }
  const perTake = estimateTake(provider, o.kind, duration, settings);
  const total = perTake * takes;
  const budget = budgetOf(w.project.dir, w.stamp(), cfg);
  const refusals: string[] = [];
  const lic = provider.licence(settings);
  if (provider.paid) {
    const off = isPaidOff();
    if (off) refusals.push(`${off}: paid providers are never called in CI or with SOUNDCLAW_NO_PAID=1 (provider=fake makes test audio)`);
    if ('problem' in lic) refusals.push(lic.problem);
    if (o.kind === 'music' && !settings.music) refusals.push(`the ${provider.id} music endpoint is held: it costs about ${provider.rate('music', settings)} credits a second, so it needs the user's OK first (soundclaw generate config ${provider.id}.music=on)`);
  }
  if (perTake > budget.maxPerCall) refusals.push(`one take costs about ${perTake} credits, over the ${budget.maxPerCall} a call may cost (a shorter duration, or soundclaw generate config max-per-call=<credits>)`);
  if (total > 0 && budget.projectSpent + total > budget.projectCap) {
    refusals.push(budget.projectCap === 0
      ? `paid generation is off for this project: its cap is 0 credits until a person sets one in project.json: "generation": {"capCredits": <credits>} (this command needs about ${total})`
      : `this needs about ${total} credits and the project has ${round(Math.max(0, budget.projectCap - budget.projectSpent))} of its ${budget.projectCap} left (project.json "generation": {"capCredits": …})`);
  }
  if (total > 0 && budget.daySpent + total > budget.dailyCap) refusals.push(`this needs about ${total} credits and today has ${round(Math.max(0, budget.dailyCap - budget.daySpent))} of the daily ${budget.dailyCap} left across projects (soundclaw generate config daily-cap=<credits>)`);
  if (provider.paid && provider.keyVar && !refusals.length && !process.env[provider.keyVar]) refusals.push(`${provider.keyVar} is not set in the environment of the process that calls (${process.argv.includes('serve') ? `the soundclaw server for this project, pid ${process.pid}` : 'this soundclaw command'}); the key is read from there only, never from a file`);
  const format = provider.outputFormat(o.kind, settings);
  const params: Record<string, unknown> = {
    duration, ...(o.kind === 'sfx' ? { loop } : {}), ...(o.influence !== undefined ? { influence: o.influence } : {}), format,
    ...(o.composition !== undefined ? { composition: o.composition } : {}),
  };
  const paramsText = [`duration=${duration}`, ...(o.kind === 'sfx' ? [`loop=${loop ? 'yes' : 'no'}`] : []), ...(o.influence !== undefined ? [`influence=${o.influence}`] : []), `format=${format}`, ...(o.composition !== undefined ? ['composition=yes'] : [])].join(' ');
  return {
    provider, settings, o, kind: o.kind, prompt, duration, takes, loop, ...(o.influence !== undefined ? { influence: o.influence } : {}), model, names, firstTake, perTake, total, budget,
    licence: 'id' in lic ? lic.id : 'unknown', params, paramsText, refusals, ...(want ? { want } : {}), ...(like ? { like } : {}),
  };
}

/** `--estimate`: the cost, the budget and whether it would run. */
export function estimateText(p: GeneratePlan): string {
  return [
    `${p.kind} by ${p.provider.id} ${p.provider.endpoint(p.kind)} (${p.model}): ${p.takes} take${p.takes === 1 ? '' : 's'} of ${p.duration} s as ${p.names.join(', ')}`,
    `estimate: ${p.total} credits (${p.perTake} a take at ${p.provider.rate(p.kind, p.settings)} credits/s)${p.provider.paid ? '' : ' (no paid call)'}`,
    budgetText(p.budget),
    `licence of the takes: ${p.licence}`,
    p.refusals.length ? `would be refused:\n${p.refusals.map((r) => `  ${r}`).join('\n')}` : 'it may run: nothing was called',
  ].join('\n') + '\n';
}

// ---- running it ----------------------------------------------------------------------------------------------------------

export interface TakeResult {
  name: string;
  take: number;
  hash: string;
  credits: number;
  request?: string;
  measure: SampleMeasure;
  words: string[];
  /** With want=: whether it fits, and how far it is (0 inside every range). */
  fits?: boolean;
  closeness?: number;
  failed?: string[];
  /** With like=: the distance from the reference. */
  distance?: number;
  rank?: number;
}

export interface GenerateResult {
  plan: GeneratePlan;
  takes: TakeResult[];
  errors: string[];
  charge: number;
  chargeFrom: LedgerLine['chargeFrom'];
  group: string | null;
  warnings: string[];
  ledger: LedgerLine;
}

/** Calls of one process run one after another, so two commands never both pass a cap that only one of them fits. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/** A take's bytes as stored audio. */
function takeAudio(t: TakeOut, name: string): { audio: PcmAudio; notes: string[] } {
  if (t.container === 'pcm16') {
    const frames = Math.floor(t.bytes.length / (2 * (t.channels ?? 1)));
    if (frames < 2) throw new ProjectError(`${name}: the provider sent no audio`);
    return { audio: { rate: t.rate ?? 44100, channels: t.channels ?? 1, format: 'pcm16', frames, data: t.bytes.slice(0, frames * 2 * (t.channels ?? 1)) }, notes: [] };
  }
  const d = decodeFileBytes(t.bytes, `${name}.${t.container}`);
  return { audio: d.audio, notes: d.notes };
}

function rankTakes(w: Writer, plan: GeneratePlan, takes: TakeResult[], entries: Map<string, SampleEntry>): void {
  if (!plan.want && !plan.like) return;
  for (const t of takes) {
    if (plan.want) {
      const e = entries.get(t.name)!;
      const facts = sampleFacts(w, e, t.measure);
      const r = matchQuery(plan.want, facts, t.name, e.tags);
      t.fits = r.match;
      t.closeness = r.closeness + (r.match ? rangeCentre(plan.want, facts) / 100 : 0);
      t.failed = r.failed;
    }
  }
  takes.sort((a, b) => (plan.want ? Number(!!b.fits) - Number(!!a.fits) || a.closeness! - b.closeness! : 0) || (plan.like ? a.distance! - b.distance! : 0) || a.take - b.take);
  takes.forEach((t, i) => { t.rank = i + 1; });
}

/**
 * Run a planned command: one call per take, outside the writer's queue; then the takes into the store and onto the tape as one group; then
 * the ledgers. Refuses (calling nothing) when the plan has a refusal. A take that fails stops the takes after it; those already made are kept.
 */
export function runGeneration(w: Writer, o: GenerateOptions): Promise<GenerateResult> {
  return serial(async () => {
    const plan = await w.enqueue(() => planGeneration(w, o));
    if (plan.refusals.length) throw new ProjectError(`not generated (nothing was called):\n${plan.refusals.map((r) => `  ${r}`).join('\n')}\n${budgetText(plan.budget)}`);
    const { provider, settings } = plan;
    const key = provider.keyVar ? process.env[provider.keyVar] : undefined;
    const ctx = { settings, ...(key ? { key } : {}) };
    const outs: { take: number; name: string; out: TakeOut; credits: number; from: LedgerLine['chargeFrom'] }[] = [];
    const errors: string[] = [];
    let before = provider.paid && provider.counter ? await provider.counter(ctx) : null;
    for (let i = 0; i < plan.takes; i++) {
      const take = plan.firstTake + i;
      const req: GenRequest = { kind: plan.kind, prompt: plan.prompt, duration: plan.duration, loop: plan.loop, ...(plan.influence !== undefined ? { influence: plan.influence } : {}), model: plan.model, ...(o.composition !== undefined ? { composition: o.composition } : {}), take };
      try {
        const out = await provider.generate(req, ctx);
        let credits: number, from: LedgerLine['chargeFrom'];
        if (out.credits !== undefined) { credits = out.credits; from = provider.paid ? 'header' : 'provider'; }
        else if (before !== null && provider.counter) {
          const after = await provider.counter(ctx);
          if (after !== null) { credits = Math.max(0, after - before); before = after; from = 'counter'; } else { credits = plan.perTake; from = 'estimate'; }
        } else { credits = plan.perTake; from = 'estimate'; }
        outs.push({ take, name: plan.names[i]!, out, credits, from });
      } catch (e) {
        errors.push(`take ${i + 1} of ${plan.takes}: ${redact((e as Error).message, key)}`);
        break;
      }
    }
    // into the store and onto the tape, as one group
    const at = w.stamp();
    const records: TakeRecord[] = [];
    const prepared: (Prepared & { take: number; credits: number; request?: string })[] = [];
    for (const x of outs) {
      try {
        const { audio, notes } = takeAudio(x.out, x.name);
        const hash = pcmHash(audio);
        const entry: SampleEntry = {
          name: x.name, hash, rate: audio.rate, channels: audio.channels, frames: audio.frames, format: audio.format,
          tags: [...new Set(['generated', plan.kind, ...(o.tags ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)])].sort(),
          prov: {
            source: 'generated', origin: `${provider.id}:${provider.endpoint(plan.kind)}`, origHash: sha256Hex(x.out.bytes), origFormat: x.out.format,
            provider: provider.id, endpoint: provider.endpoint(plan.kind), model: plan.model, prompt: plan.prompt || '(a composition plan)', params: plan.paramsText,
            take: `${x.take - plan.firstTake + 1}/${plan.takes}`, credits: x.credits, ...(x.out.request ? { request: x.out.request } : {}),
          },
          licence: { id: plan.licence, ...(provider.termsUrl ? { terms: provider.termsUrl } : {}) },
        };
        prepared.push({ name: x.name, audio, hash, command: sampleAddText(entry), notes, file: x.name, take: x.take, credits: x.credits, ...(x.out.request ? { request: x.out.request } : {}) });
      } catch (e) {
        errors.push(`${x.name}: ${redact((e as Error).message, key)}`);
        records.push({ take: x.take, name: x.name, credits: x.credits, ...(x.out.request ? { request: x.out.request } : {}), error: redact((e as Error).message, key) });
      }
    }
    let group: string | null = null;
    let warnings: string[] = [];
    let committed = new Set<string>();
    let entries = new Map<string, SampleEntry>();
    let line!: LedgerLine;
    try {
      if (prepared.length) {
        const r = await w.enqueue(() => commitImports(w, prepared, { by: o.by, force: false }));
        group = r.group;
        warnings = [...r.warnings, ...r.problems];
        committed = new Set(r.items.map((it) => it.info.name));
        entries = new Map([...committed].map((n) => [n, w.samples.entry(n)!] as const));
      }
    } catch (e) {
      errors.push(redact((e as Error).message, key));
    } finally {
      for (const p of prepared) records.push({ take: p.take, name: p.name, ...(committed.has(p.name) ? { hash: p.hash } : { error: 'not stored' }), credits: p.credits, ...(p.request ? { request: p.request } : {}) });
      records.sort((a, b) => a.take - b.take);
      for (const e of errors) if (!records.some((r) => r.error && e.includes(r.error))) records.push({ take: plan.firstTake + outs.length, error: e });
      const charge = outs.reduce((n, x) => n + x.credits, 0);
      const froms = [...new Set(outs.map((x) => x.from))];
      line = {
        at, by: o.by, provider: provider.id, endpoint: provider.endpoint(plan.kind), model: plan.model, kind: plan.kind, prompt: plan.prompt, params: plan.params,
        takes: plan.takes, estimate: plan.total, charge, chargeFrom: froms.length === 1 ? froms[0]! : froms.length ? 'mixed' : 'estimate', results: records,
        outcome: !outs.length ? 'failed' : committed.size === plan.takes && !errors.length ? 'ok' : 'partial',
      };
      if (outs.length || errors.length) {
        appendLine(join(w.project.dir, LEDGER_FILE), line);
        appendLine(spendFile(), { at, project: w.project.json.name, dir: w.project.dir, provider: provider.id, endpoint: line.endpoint, credits: charge } satisfies SpendLine);
      }
    }
    // the takes' numbers and the ranking
    const takes: TakeResult[] = [];
    for (const p of prepared) {
      if (!committed.has(p.name)) continue;
      const chs = pcmChannels(p.audio, 120);
      const m = measureSample(chs, p.audio.rate);
      const t: TakeResult = { name: p.name, take: p.take, hash: p.hash, credits: p.credits, ...(p.request ? { request: p.request } : {}), measure: m, words: describeSample(m) };
      if (plan.like) t.distance = similarDistance(plan.like.vector, similarVector(m, bandEnergies(monoAt44(p.audio, 20))));
      takes.push(t);
    }
    rankTakes(w, plan, takes, entries);
    if (!takes.length && errors.length) throw new ProjectError(`nothing was generated:\n${errors.map((e) => `  ${e}`).join('\n')}${line.charge ? `\ncharged ${round(line.charge)} credits all the same (logged in ${LEDGER_FILE})` : ''}`);
    return { plan, takes, errors, charge: line.charge, chargeFrom: line.chargeFrom, group, warnings, ledger: line };
  });
}

const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : '-inf');

/** One take as a line: its numbers, its words, and where it ranks. */
function takeLine(t: TakeResult, plan: GeneratePlan): string {
  const m = t.measure;
  const rank = t.rank !== undefined ? `${t.rank}. ` : '';
  const fit = t.fits === undefined ? '' : t.fits ? '  fits want' : `  misses ${t.failed!.join(', ')}`;
  const like = t.distance !== undefined ? `  distance ${t.distance.toFixed(2)} from ${plan.like!.label}` : '';
  return `${rank}${t.name}  ${m.duration.toFixed(3)} s  ${f1(m.lufs)} LUFS  peak ${f1(m.peakDb)} dBFS  centroid ${Math.round(m.centroid)} Hz  attack ${m.attackMs.toFixed(1)} ms  pitch ${m.pitched && m.pitch ? m.pitch.note : 'none'}  ${round(t.credits)} credits${t.request ? `  request ${t.request}` : ''}${fit}${like}\n   ${t.words.join(' ')}`;
}

export function generateText(r: GenerateResult, projectArg = '<project>'): string {
  const p = r.plan;
  const from = { header: "the provider's cost header", counter: "the account's counter before and after", estimate: 'the estimate (the provider said nothing)', provider: 'the provider', mixed: 'the cost header and the counter' }[r.chargeFrom];
  const lines = [
    `generated ${r.takes.length} of ${p.takes} take${p.takes === 1 ? '' : 's'} with ${p.provider.id} ${p.provider.endpoint(p.kind)} (${p.model}), ${p.duration} s each: "${p.prompt}"`,
    ...(p.want || p.like ? [`ranked by ${[p.o.want ? `want "${p.o.want}"` : '', p.like ? `closeness to ${p.like.label}` : ''].filter(Boolean).join(', then ')}:`] : []),
    ...r.takes.map((t) => takeLine(t, p)),
    ...r.errors.map((e) => `warning: ${e}`),
    ...r.warnings.map((x) => `warning: ${x}`),
    `charged ${round(r.charge)} credits (from ${from}); the estimate was ${p.total}`,
    budgetText({ ...p.budget, projectSpent: p.budget.projectSpent + r.charge, daySpent: p.budget.daySpent + r.charge }),
    `licence ${p.licence}${p.provider.termsUrl ? ` (terms ${p.provider.termsUrl})` : ''}; ${r.takes.length} sample${r.takes.length === 1 ? '' : 's'}${r.group ? ` as group ${r.group}` : ''}; logged in ${LEDGER_FILE}`,
  ];
  if (r.takes.length) lines.push(`listen: soundclaw describe ${projectArg} sample:${r.takes[0]!.name}; keep the best and remove the others (sample remove <name>; the audio stays until sample gc)`);
  return lines.join('\n') + '\n';
}

export function generateJson(r: GenerateResult): Record<string, unknown> {
  return {
    provider: r.plan.provider.id, endpoint: r.plan.provider.endpoint(r.plan.kind), model: r.plan.model, kind: r.plan.kind, prompt: r.plan.prompt, estimate: r.plan.total, charge: r.charge, chargeFrom: r.chargeFrom,
    licence: r.plan.licence, group: r.group, errors: r.errors,
    takes: r.takes.map((t) => ({ name: t.name, hash: t.hash, credits: t.credits, request: t.request ?? null, rank: t.rank ?? null, fits: t.fits ?? null, distance: t.distance === undefined ? null : round(t.distance), dur: round(t.measure.duration), lufs: Number.isFinite(t.measure.lufs) ? round(t.measure.lufs) : null, centroid: Math.round(t.measure.centroid), attack: round(t.measure.attackMs), words: t.words.join(' ') })),
  };
}

// ---- generate again ------------------------------------------------------------------------------------------------------

/** `--again <sample>`: a generated sample's prompt and parameters, from the ledger line that made it (or its provenance), for a new call. */
export function againOptions(w: Writer, name: string, by: string): GenerateOptions {
  const e = w.samples.entry(name);
  if (!e) throw new ProjectError(`no sample '${name}'`);
  if (e.prov.source !== 'generated' || !e.prov.provider) throw new ProjectError(`${name} was not generated (its source is ${e.prov.source}); --again repeats a generation`);
  const line = readLedger(w.project.dir).find((l) => l.results.some((r) => r.hash === e.hash));
  const kind: GenKind = (line?.kind ?? (e.prov.endpoint === 'music' ? 'music' : 'sfx'));
  const params: Record<string, unknown> = line?.params ?? Object.fromEntries((e.prov.params ?? '').split(/\s+/).filter((x) => x.includes('=')).map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
  const num = (v: unknown): number | undefined => (v === undefined || v === '' ? undefined : Number(v));
  const o: GenerateOptions = { kind, prompt: line?.prompt ?? e.prov.prompt ?? '', provider: e.prov.provider, by, as: name.replace(/_t\d+$/, '') };
  const d = num(params.duration);
  if (d !== undefined) o.duration = d;
  if (params.loop === true || params.loop === 'yes') o.loop = true;
  const inf = num(params.influence);
  if (inf !== undefined) o.influence = inf;
  if (e.prov.model) o.model = e.prov.model;
  if (params.composition !== undefined && params.composition !== 'yes') o.composition = params.composition;
  else if (params.composition === 'yes') throw new ProjectError(`${name} was made from a composition plan that is not in ${LEDGER_FILE}; generate it again with the plan`);
  return o;
}

// ---- a command as words (the CLI sends these to a server; the dashboard posts them) -----------------------------------------

/** `generate` as words: a kind, a prompt and key=value pairs, or a sample to generate again (with takes= and as=). */
export interface GenerateBody {
  kind?: string;
  prompt?: string;
  pairs: Record<string, string>;
  again?: string;
  estimate?: boolean;
  json?: boolean;
  by: string;
}

/** The options a body asks for: a new prompt, or a generated sample's again (with takes= and as= from the words). */
export function generateOptions(w: Writer, b: GenerateBody): GenerateOptions {
  if (b.again) {
    for (const k of Object.keys(b.pairs)) if (k !== 'takes' && k !== 'as') throw new ProjectError(`generate --again takes takes= and as= (not ${k}=); the rest is what was recorded`);
    const o = againOptions(w, b.again, b.by);
    if (b.pairs.takes !== undefined) o.takes = Number(b.pairs.takes);
    if (b.pairs.as !== undefined) o.as = b.pairs.as;
    return o;
  }
  return optionsFromPairs(b.kind ?? '', b.prompt ?? '', b.pairs, b.by);
}

/** A body from JSON (the HTTP route): only the fields it has, of the types they are. */
export function generateBodyFrom(j: unknown): GenerateBody {
  const o = (j ?? {}) as Record<string, unknown>;
  const str = (k: string): string | undefined => {
    const v = o[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') throw new ProjectError(`${k} is text`);
    return v;
  };
  const pairs: Record<string, string> = {};
  const p = o.pairs;
  if (p !== undefined && (typeof p !== 'object' || p === null || Array.isArray(p))) throw new ProjectError('pairs is an object of key: value text');
  for (const [k, v] of Object.entries((p ?? {}) as Record<string, unknown>)) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new ProjectError(`pairs.${k} is text`);
    pairs[k] = String(v);
  }
  const by = str('by') ?? '';
  const b: GenerateBody = { pairs, by, estimate: o.estimate === true, json: o.json === true };
  const kind = str('kind'), prompt = str('prompt'), again = str('again');
  if (kind !== undefined) b.kind = kind;
  if (prompt !== undefined) b.prompt = prompt;
  if (again !== undefined) b.again = again;
  return b;
}

/** Run a body on a writer: the estimate, or the takes. The text the CLI prints and the JSON. */
export async function generateFromBody(w: Writer, b: GenerateBody, projectArg = '<project>'): Promise<{ text: string; json: unknown }> {
  if (b.estimate) {
    const plan = await w.enqueue(() => planGeneration(w, generateOptions(w, b)));
    return { text: estimateText(plan), json: { estimate: plan.total, perTake: plan.perTake, names: plan.names, budget: plan.budget, licence: plan.licence, refusals: plan.refusals } };
  }
  const o = await w.enqueue(() => generateOptions(w, b));
  const r = await runGeneration(w, o);
  return { text: generateText(r, projectArg), json: generateJson(r) };
}

// ---- reading options from words -------------------------------------------------------------------------------------------

/** The `key=value` words of `generate` (CLI and HTTP), checked. */
export const GENERATE_KEYS = ['duration', 'takes', 'loop', 'influence', 'model', 'as', 'want', 'like', 'provider', 'tags', 'composition'];

export function optionsFromPairs(kind: string, prompt: string, kv: Record<string, string>, by: string): GenerateOptions {
  for (const k of Object.keys(kv)) if (!GENERATE_KEYS.includes(k)) throw new ProjectError(`generate: no field '${k}' (${GENERATE_KEYS.join(', ')})`);
  if (kind !== 'sfx' && kind !== 'music') throw new ProjectError(`generate makes sfx or music, not '${kind}'`);
  const n = (k: string): number | undefined => {
    if (kv[k] === undefined) return undefined;
    const v = Number(String(kv[k]).replace(/s$/, ''));
    if (!Number.isFinite(v)) throw new ProjectError(`${k} is a number (not '${kv[k]}')`);
    return v;
  };
  const o: GenerateOptions = { kind, prompt, by };
  const d = n('duration'); if (d !== undefined) o.duration = d;
  const t = n('takes'); if (t !== undefined) o.takes = t;
  const i = n('influence'); if (i !== undefined) o.influence = i;
  if (kv.loop !== undefined) {
    if (!['yes', 'no', 'on', 'off', '1', '0', 'true', 'false'].includes(kv.loop)) throw new ProjectError('loop is yes or no');
    o.loop = ['yes', 'on', '1', 'true'].includes(kv.loop);
  }
  for (const k of ['model', 'as', 'want', 'like', 'provider', 'tags'] as const) if (kv[k] !== undefined) o[k] = kv[k];
  if (kv.composition !== undefined) {
    try { o.composition = JSON.parse(kv.composition); } catch { throw new ProjectError('composition is the composition plan as JSON text'); }
  }
  return o;
}
