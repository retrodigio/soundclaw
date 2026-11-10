// Generation providers: who makes audio from a prompt, what one call costs, and the call itself. One call is one take. Providers live in
// the server, never in core: generation is acquisition, done once when a command runs, and what it returns is stored by hash and named on
// the tape like any import, so a replay or a render never calls a provider.
//
//   fake        audio SoundClaw makes itself from a hash of the request, for tests and demos; no network, no key, always free (it never counts against a cap)
//   elevenlabs  ElevenLabs' sound effects (POST /v1/sound-generation) and music (POST /v1/music) endpoints; the key comes from
//               ELEVENLABS_API_KEY in the environment of the process that calls, and is never written anywhere

import { pcmChannels, pcmFromFloats, sha256Text, sinRad, type PcmAudio } from '@soundclaw/core';
import { ProjectError } from './project.ts';

export type GenKind = 'sfx' | 'music';
export const GEN_KINDS: readonly GenKind[] = ['sfx', 'music'];

/** What a provider takes for one kind of audio. */
export interface KindLimits {
  minDuration: number;
  maxDuration: number;
  /** The length asked for when the command gives none. */
  defaultDuration: number;
  maxPrompt: number;
  /** Whether it can make a seamless loop (`loop=yes`). */
  loop: boolean;
  /** Whether it takes a prompt influence (0..1). */
  influence: boolean;
}

export interface ProviderLimits {
  kinds: Partial<Record<GenKind, KindLimits>>;
  /** Takes in one command (one call each). */
  maxTakes: number;
}

/** A user's settings for one provider (user configuration, generation.json). */
export interface ProviderSettings {
  /** The account's plan (free, starter, creator, pro, ...): it decides the licence written on the takes and the output format. */
  plan?: string;
  /** Another address that speaks the same API (a local stub for tests); https, or http to this machine only. */
  url?: string;
  /** The music endpoint is off until this is true. */
  music?: boolean;
  /** Credits per second of audio, by kind. */
  rates?: Partial<Record<GenKind, number>>;
  /** The output format asked for (default: by the plan). */
  format?: string;
}

/** One call's request: one take. */
export interface GenRequest {
  kind: GenKind;
  prompt: string;
  duration: number;
  loop: boolean;
  influence?: number;
  model: string;
  /** Music: a composition plan instead of the prompt (the provider's JSON, passed on as it is). */
  composition?: unknown;
  /** The take's number among this name's takes (the fake provider makes different audio for each). */
  take: number;
}

/** What one call returned. */
export interface TakeOut {
  bytes: Uint8Array;
  /** `pcm16`: raw little-endian 16-bit samples at `rate` and `channels`; otherwise a file to decode (wav, mp3). */
  container: 'pcm16' | 'wav' | 'mp3';
  rate?: number;
  channels?: number;
  /** The output format named as the provider names it (pcm_44100, mp3_44100_128). */
  format: string;
  request?: string;
  /** The credits the provider says the call cost, when it says. */
  credits?: number;
}

export interface CallContext {
  settings: ProviderSettings;
  key?: string;
  signal?: AbortSignal;
}

export interface Provider {
  id: string;
  /** A paid provider: capped, logged, refused in CI and when SOUNDCLAW_NO_PAID=1, and needs a key. */
  paid: boolean;
  /** The environment variable the key is read from. */
  keyVar?: string;
  limits: ProviderLimits;
  /** The provider's terms, in a sentence, and where they are. */
  terms: string;
  termsUrl?: string;
  /** The licence id the takes get under these settings, or the reason there is none yet. */
  licence(settings: ProviderSettings): { id: string } | { problem: string };
  defaultModel(kind: GenKind): string;
  endpoint(kind: GenKind): string;
  outputFormat(kind: GenKind, settings: ProviderSettings): string;
  /** Credits per second of audio for a kind under these settings. */
  rate(kind: GenKind, settings: ProviderSettings): number;
  /** One call: one take. */
  generate(req: GenRequest, ctx: CallContext): Promise<TakeOut>;
  /** The account's counter of credits used so far (for the charge when a call does not say it), or null when it cannot be read. */
  counter?(ctx: CallContext): Promise<number | null>;
}

/** Credits for one take. */
export const estimateTake = (p: Provider, kind: GenKind, duration: number, settings: ProviderSettings): number => Math.ceil(p.rate(kind, settings) * duration - 1e-9) || 0;

// ---- keys never leave the call ---------------------------------------------------------------------------------------

/** Replace a key (and anything shaped like one) in text that came back from a provider or the network. */
export function redact(text: string, key?: string): string {
  let t = text;
  if (key && key.length >= 4) t = t.split(key).join('[redacted]');
  return t.replace(/\bsk_[A-Za-z0-9]{16,}\b/g, '[redacted]').replace(/(xi-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]');
}

// ---- fake ------------------------------------------------------------------------------------------------------------

/** Deterministic noise from a seed (xorshift32), in -1..1. */
function noise(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 2147483648 - 1;
  };
}

/** The fake provider's audio: a tone and a filtered noise burst whose pitch, colour and shape come from a hash of the request. Mono, 44.1 kHz. */
export function fakeAudio(req: GenRequest): PcmAudio {
  const h = sha256Text(`soundclaw-fake 1\n${req.kind}\n${req.prompt}\n${req.duration}\n${req.loop}\n${req.influence ?? ''}\n${req.model}\n${req.take}\n${req.composition === undefined ? '' : JSON.stringify(req.composition)}`);
  const byte = (i: number): number => parseInt(h.slice(i * 2, i * 2 + 2), 16);
  const rate = 44100;
  const n = Math.max(2, Math.round(req.duration * rate));
  const out = new Float32Array(n);
  const rnd = noise(parseInt(h.slice(0, 8), 16));
  const base = 80 + byte(4) * 3; // 80..845 Hz
  const toneLevel = byte(5) / 255;
  const lp = 0.02 + (byte(6) / 255) * 0.5; // the noise's one-pole low-pass
  const decay = 1 - 1 / (rate * (0.08 + (byte(7) / 255) * 0.6)); // per-sample fall of a hit
  const attack = Math.round(rate * 0.004);
  let env = 1, y = 0, phase = 0;
  for (let i = 0; i < n; i++) {
    // music changes note every half second, over a few steps of a pentatonic scale
    const step = req.kind === 'music' ? [0, 2, 4, 7, 9][byte(8 + (Math.floor(i / (rate / 2)) % 16)) % 5]! : 0;
    const f = base * (1 + step / 12);
    phase += f / rate;
    if (phase >= 1) phase -= 1;
    y += lp * (rnd() - y);
    const a = i < attack ? i / attack : 1;
    if (!req.loop && req.kind === 'sfx') env *= decay;
    const e = req.loop || req.kind === 'music' ? 0.6 : env;
    out[i] = a * e * (toneLevel * 0.5 * sinRad(6.283185307179586 * phase) + (1 - toneLevel) * 2.5 * y);
  }
  // a short fade at the end so nothing clicks, then about -6 dBFS at the peak
  const fade = Math.min(n, Math.round(rate * 0.01));
  for (let i = 0; i < fade; i++) out[n - 1 - i]! *= i / fade;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]!));
  if (peak > 0) for (let i = 0; i < n; i++) out[i]! *= 0.5 / peak;
  return pcmFromFloats([out], rate, 'pcm16');
}

/**
 * With SOUNDCLAW_FAKE_LONGER=<factor> (a test and demo knob, like a real provider that returns takes longer than asked) the take is
 * `factor` times as long: the audio that was asked for, 60% of the way in, in a faint bed of noise.
 */
function fakeLonger(a: PcmAudio): PcmAudio {
  const f = Number(process.env.SOUNDCLAW_FAKE_LONGER);
  if (!(f > 1) || !Number.isFinite(f)) return a;
  const x = pcmChannels(a)[0]!;
  const n = Math.round(x.length * f);
  const at = Math.round((n - x.length) * 0.6);
  const out = new Float32Array(n);
  const rnd = noise(12345);
  for (let i = 0; i < n; i++) out[i] = rnd() * 0.001;
  out.set(x, at);
  return pcmFromFloats([out], a.rate, 'pcm16');
}

const KIND_LIMITS: Record<GenKind, KindLimits> = {
  sfx: { minDuration: 0.5, maxDuration: 30, defaultDuration: 2, maxPrompt: 1000, loop: true, influence: true },
  music: { minDuration: 10, maxDuration: 300, defaultDuration: 30, maxPrompt: 2000, loop: false, influence: false },
};

export const fakeProvider: Provider = {
  id: 'fake',
  paid: false,
  limits: { kinds: KIND_LIMITS, maxTakes: 4 },
  terms: 'audio SoundClaw makes itself from a hash of the request, for tests and demos; nothing is sent anywhere',
  licence: () => ({ id: 'own' }),
  defaultModel: (kind) => (kind === 'sfx' ? 'fake-sfx-1' : 'fake-music-1'),
  endpoint: (kind) => (kind === 'sfx' ? 'sound-generation' : 'music'),
  outputFormat: () => 'pcm_44100',
  rate: () => 0,
  async generate(req, ctx) {
    const a = fakeLonger(fakeAudio(req));
    const credits = estimateTake(fakeProvider, req.kind, req.duration, ctx.settings);
    return { bytes: a.data, container: 'pcm16', rate: a.rate, channels: a.channels, format: 'pcm_44100', request: `fake-${sha256Text(`${req.prompt}\n${req.take}`).slice(0, 12)}`, credits };
  },
};

// ---- ElevenLabs ------------------------------------------------------------------------------------------------------

export const ELEVENLABS_URL = 'https://api.elevenlabs.io';
/** Plans whose output may be 16-bit PCM at 44.1 kHz; the others get MP3, decoded at import through ffmpeg. */
const PCM_PLANS = new Set(['pro', 'scale', 'business', 'enterprise']);
/** Credits per second measured from the provider's own cost header: sound effects about 10, music about 27.4. */
export const ELEVENLABS_RATES: Record<GenKind, number> = { sfx: 10, music: 27.4 };
export const PLAN_RE = /^[a-z][a-z0-9_-]{0,23}$/;

/** The address calls go to: https, or plain http only to this machine (a stub). */
export function providerUrl(s: ProviderSettings, fallback: string): URL {
  let u: URL;
  try { u = new URL(s.url ?? fallback); } catch { throw new ProjectError(`'${s.url}' is not an address`); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new ProjectError(`${u.origin}: a provider is called over https (plain http only to this machine)`);
  return u;
}

/** The message of a provider's error body: `detail.message`, `detail`, `message`, or the text; short, and with any key taken out. */
function errorMessage(body: string, key?: string): string {
  let msg = body;
  try {
    const j = JSON.parse(body) as { detail?: unknown; message?: unknown };
    const d = j.detail as { message?: unknown; status?: unknown } | string | undefined;
    msg = typeof d === 'string' ? d : typeof d?.message === 'string' ? `${d.message}${typeof d.status === 'string' ? ` (${d.status})` : ''}` : typeof j.message === 'string' ? j.message : body;
  } catch { /* not JSON: the text */ }
  return redact(msg.replace(/\s+/g, ' ').trim().slice(0, 300), key);
}

/** A fetch whose failure says where it went, never what it sent. */
async function call(url: URL, init: RequestInit, key: string | undefined, what: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new ProjectError(`${what}: no answer from ${url.origin} in time`);
    throw new ProjectError(`${what}: could not reach ${url.origin}${err.cause?.code ? ` (${err.cause.code})` : ''}: ${redact(err.message, key)}`);
  }
}

export const elevenlabsProvider: Provider = {
  id: 'elevenlabs',
  paid: true,
  keyVar: 'ELEVENLABS_API_KEY',
  limits: { kinds: KIND_LIMITS, maxTakes: 4 },
  terms: 'ElevenLabs output, used under the terms of the account\'s plan (commercial use needs a paid plan)',
  termsUrl: 'https://elevenlabs.io/terms-of-use',
  licence: (s) => (s.plan ? { id: `generated:elevenlabs:${s.plan}` } : { problem: 'your ElevenLabs plan is not set, and it decides the licence written on the takes: soundclaw generate config elevenlabs.plan=<free|starter|creator|pro|...>' }),
  defaultModel: (kind) => (kind === 'sfx' ? 'eleven_text_to_sound_v2' : 'music_v1'),
  endpoint: (kind) => (kind === 'sfx' ? 'sound-generation' : 'music'),
  outputFormat: (_kind, s) => s.format ?? (s.plan && PCM_PLANS.has(s.plan) ? 'pcm_44100' : 'mp3_44100_128'),
  rate: (kind, s) => s.rates?.[kind] ?? ELEVENLABS_RATES[kind],
  async generate(req, ctx) {
    const format = elevenlabsProvider.outputFormat(req.kind, ctx.settings);
    const base = providerUrl(ctx.settings, ELEVENLABS_URL);
    const url = new URL(req.kind === 'sfx' ? '/v1/sound-generation' : '/v1/music', base);
    url.searchParams.set('output_format', format);
    const body = req.kind === 'sfx'
      ? { text: req.prompt, duration_seconds: req.duration, ...(req.influence !== undefined ? { prompt_influence: req.influence } : {}), ...(req.loop ? { loop: true } : {}), model_id: req.model }
      : req.composition !== undefined ? { composition_plan: req.composition, model_id: req.model } : { prompt: req.prompt, music_length_ms: Math.round(req.duration * 1000), model_id: req.model };
    const what = `elevenlabs ${elevenlabsProvider.endpoint(req.kind)}`;
    const r = await call(url, {
      method: 'POST',
      headers: { 'xi-api-key': ctx.key ?? '', 'Content-Type': 'application/json', Accept: format.startsWith('pcm') ? 'audio/pcm, application/octet-stream' : 'audio/mpeg' },
      body: JSON.stringify(body),
      signal: ctx.signal ?? AbortSignal.timeout(req.kind === 'sfx' ? 120_000 : 600_000),
    }, ctx.key, what);
    if (!r.ok) throw new ProjectError(`${what} answered ${r.status}: ${errorMessage(await r.text().catch(() => ''), ctx.key)}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (!bytes.length) throw new ProjectError(`${what} sent no audio`);
    const cost = r.headers.get('character-cost');
    const credits = cost !== null && /^\d+(\.\d+)?$/.test(cost.trim()) ? Number(cost) : undefined;
    const request = r.headers.get('request-id') ?? r.headers.get('x-request-id') ?? r.headers.get('history-item-id') ?? undefined;
    const m = /^pcm_(\d+)$/.exec(format);
    const out: TakeOut = m ? { bytes, container: 'pcm16', rate: Number(m[1]), channels: 1, format } : { bytes, container: format.startsWith('mp3') ? 'mp3' : 'wav', format };
    if (credits !== undefined) out.credits = credits;
    if (request && /^[A-Za-z0-9_.:-]{1,120}$/.test(request)) out.request = request;
    return out;
  },
  async counter(ctx) {
    try {
      const url = new URL('/v1/user/subscription', providerUrl(ctx.settings, ELEVENLABS_URL));
      const r = await fetch(url, { headers: { 'xi-api-key': ctx.key ?? '' }, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return null;
      const j = (await r.json()) as { character_count?: unknown };
      return typeof j.character_count === 'number' ? j.character_count : null;
    } catch {
      return null;
    }
  },
};

export const PROVIDERS: Record<string, Provider> = { fake: fakeProvider, elevenlabs: elevenlabsProvider };

export function getProvider(id: string): Provider {
  const p = PROVIDERS[id];
  if (!p) throw new ProjectError(`no provider '${id}' (providers: ${Object.keys(PROVIDERS).join(', ')})`);
  return p;
}
