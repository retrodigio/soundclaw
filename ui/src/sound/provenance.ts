// Who set what, worked out from the history tape. The tape is replayed once, group by group, and a
// sound's document is compared before and after each group: the latest group that changed a
// parameter (or a layer, or a device) is that control's trail. A control is "set by the agent" when
// its trail is an agent's and no person has approved the sound since. Pure functions, no DOM.

import { CLASSIC_KEYS, Library, applyCommand, cloneSound, effectiveEntries, parse, type Fx, type Layer, type Sound, type TapeEntry, type WorkRequest } from '@soundclaw/core';

/** The latest group to change something, and what it was before. */
export interface Trail {
  seq: number;
  group: string;
  by: string;
  at?: string;
  /** The value before that group (a classic parameter), or the device as it was (a layered one). */
  prev?: number | Fx | Layer;
  /** The value after (a classic parameter). */
  now?: number;
}

/** One group that changed the sound. */
export interface GroupInfo { group: string; by: string; at?: string; seq: number; cmds: string[]; kinds: string[] }

export interface Provenance {
  /** Classic parameters (`freq`, `seed`...) by name. */
  params: Map<string, Trail>;
  /** Layers by their salt; devices by `<salt>:<index>` and the master chain by `M:<index>`. */
  layers: Map<number, Trail>;
  devices: Map<string, Trail>;
  /** The tape number of the latest approval by a person (0: none). */
  approvedAfter: number;
  /** The sound as it stood before its latest group, and before the latest group by an agent that nobody approved (null: none). */
  before: Sound | null;
  beforeAgent: Sound | null;
  /** The groups that changed the sound, oldest first. */
  groups: GroupInfo[];
  /** Problems that stopped the replay from knowing the sound (a partial tape). */
  complete: boolean;
}

export const isAgent = (by: string): boolean => by.startsWith('agent:');

/** Is this trail the agent's, with nobody having approved since? */
export function agentSet(p: Provenance, t: Trail | undefined): t is Trail {
  return !!t && isAgent(t.by) && t.seq > p.approvedAfter;
}

const json = (v: unknown): string => JSON.stringify(v);

function changedClassic(a: Sound, b: Sound): string[] {
  if (a.voice !== 'classic' || b.voice !== 'classic') return a.voice === b.voice ? [] : ['*'];
  const out: string[] = [];
  for (const k of [...CLASSIC_KEYS, 'seed'] as const) if ((a.patch as Record<string, unknown>)[k] !== (b.patch as Record<string, unknown>)[k]) out.push(k);
  return out;
}

const layerBody = (l: Layer): string => json({ kind: l.kind, p: l.p, mute: l.mute, solo: l.solo, amp: l.amp, envs: l.envs });

export function emptyProvenance(): Provenance {
  return { params: new Map(), layers: new Map(), devices: new Map(), approvedAfter: 0, before: null, beforeAgent: null, groups: [], complete: false };
}

/** Replay the tape and read one sound's trails. `tape` is the whole tape (or what the page holds of it). */
export function provenanceOf(tape: readonly TapeEntry[], id: string): Provenance {
  const out = emptyProvenance();
  const lib = new Library();
  let cur: string | null = null;
  let curEntries: TapeEntry[] = [];
  let prevDoc: Sound | undefined;
  let seenId = false;
  let lastGroupBefore: Sound | null = null;

  const closeGroup = (): void => {
    if (cur === null) return;
    const now = lib.get(id);
    const first = curEntries[0]!;
    const by = first.by;
    const base = { seq: curEntries.at(-1)!.seq, group: cur, by, ...(first.at ? { at: first.at } : {}) };
    const touched = json(prevDoc) !== json(now);
    // a person approving the sound
    const approves = !isAgent(by) && curEntries.some((e) => new RegExp(`^sound mark ${id} approved`).test(e.cmd));
    if (approves) out.approvedAfter = base.seq;
    if (touched && now) {
      const before = prevDoc ? cloneSound(prevDoc) : null;
      const cmds = curEntries.map((e) => e.cmd).filter((c) => c.split(/\s+/).slice(0, 4).includes(id));
      out.groups.push({ group: cur, by, ...(first.at ? { at: first.at } : {}), seq: base.seq, cmds, kinds: [] });
      if (before) {
        if (now.voice === 'classic' && before.voice === 'classic') {
          for (const k of changedClassic(before, now)) {
            const pv = (before.patch as Record<string, unknown>)[k];
            const nv = (now.patch as Record<string, unknown>)[k];
            out.params.set(k, { ...base, ...(typeof pv === 'number' ? { prev: pv } : {}), ...(typeof nv === 'number' ? { now: nv } : {}) });
          }
        } else if (now.voice === 'layered' && before.voice === 'layered') {
          const old = new Map(before.layers.map((l) => [l.salt, l] as const));
          now.layers.forEach((l) => {
            const o = old.get(l.salt);
            if (!o || layerBody(o) !== layerBody(l)) out.layers.set(l.salt, { ...base, ...(o ? { prev: o } : {}) });
            l.fx.forEach((f, k) => { const of = o?.fx[k]; if (!of || json(of) !== json(f)) out.devices.set(`${l.salt}:${k}`, { ...base, ...(of ? { prev: of } : {}) }); });
          });
          now.master.forEach((f, k) => { const of = before.master[k]; if (!of || json(of) !== json(f)) out.devices.set(`M:${k}`, { ...base, ...(of ? { prev: of } : {}) }); });
        }
        if (now.voice !== before.voice) { out.params.clear(); out.layers.clear(); out.devices.clear(); }
        lastGroupBefore = before;
        if (isAgent(by)) out.beforeAgent = before;
      }
    }
    if (approves) out.beforeAgent = null;
    prevDoc = now ? cloneSound(now) : undefined;
    curEntries = [];
  };

  for (const e of effectiveEntries(tape)) {
    if (cur !== e.group) { closeGroup(); cur = e.group; prevDoc = lib.get(id) ? cloneSound(lib.get(id)!) : undefined; }
    curEntries.push(e);
    const p = parse(e.cmd);
    if (p.errors.length || p.commands.length !== 1) continue;
    try { applyCommand(lib, p.commands[0]!); } catch { /* a problem in a partial tape */ }
    if (lib.has(id)) seenId = true;
  }
  closeGroup();
  out.before = lastGroupBefore;
  out.complete = seenId;
  return out;
}

const memo = new Map<string, Provenance>();
/** `provenanceOf`, kept until the tape grows. */
export function provenanceMemo(tape: readonly TapeEntry[], id: string): Provenance {
  const key = `${id}|${tape.length}|${tape.at(-1)?.seq ?? 0}|${tape[0]?.seq ?? 0}`;
  let p = memo.get(key);
  if (!p) {
    p = provenanceOf(tape, id);
    memo.set(key, p);
    if (memo.size > 24) memo.delete(memo.keys().next().value!);
  }
  return p;
}

/** The done or progress text of the request the agent was answering when it wrote a change. */
export function answeredNote(requests: readonly WorkRequest[], sound: string, by: string, at: string | undefined): string | null {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return null;
  let best: { text: string; claimed: number } | null = null;
  for (const q of requests) {
    if (q.sound !== sound) continue;
    const claim = q.events.find((e) => e.type === 'claim' && e.by === by);
    if (!claim) continue;
    const c = Date.parse(claim.at);
    if (!(c <= t + 1000)) continue;
    const endEv = q.events.find((e) => Date.parse(e.at) >= c && (e.type === 'done' || e.type === 'blocked' || e.type === 'cancel'));
    const end = endEv ? Date.parse(endEv.at) : Infinity;
    if (t > end + 1000) continue;
    const text = [...q.events].reverse().find((e) => (e.type === 'done' || e.type === 'progress') && e.by === by && e.text)?.text;
    if (text && (!best || c > best.claimed)) best = { text, claimed: c };
  }
  return best?.text ?? null;
}
