// Who set what, worked out from the history tape. The tape is replayed once, group by group, and a
// sound's document is compared before and after each group: the latest group that changed a
// parameter (or a layer, or a device) is that control's trail. A control is "set by the agent" when
// its trail is an agent's and no person has approved the sound since. The same replay keeps the
// sound as it stood after each group that changed it: the versions a set's clip grid shows (the
// replay only applies commands; nothing is measured in it). Pure functions, no DOM.

import { sampleKeyPart, CLASSIC_KEYS, Library, applyCommand, cloneSound, effectiveEntries, parse, renderKey, soundSamples, type Fx, type Layer, type Sound, type TapeEntry, type WorkRequest } from '@soundclaw/core';

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

/** The sound as it stood after one group that changed it: `seq` is the group's last tape entry. */
export interface Snapshot {
  seq: number; group: string; by: string; at?: string; doc: Sound;
  /** The audio each sample the sound plays stood for at that point of the tape (a name can be pointed at other audio later). */
  samples: { name: string; sha256: string }[];
  /** Its render key, the samples' hashes included. */
  key: string;
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
  /** The sound after each group that changed its render, oldest first (the document is as it stood after the last group of the run). */
  snapshots: Snapshot[];
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
  return { params: new Map(), layers: new Map(), devices: new Map(), approvedAfter: 0, before: null, beforeAgent: null, groups: [], snapshots: [], complete: false };
}

/** Replay the tape and read one sound's trails. `tape` is the whole tape (or what the page holds of it). */
export function provenanceOf(tape: readonly TapeEntry[], id: string): Provenance {
  const out = emptyProvenance();
  const lib = new Library();
  let cur: string | null = null;
  let curEntries: TapeEntry[] = [];
  let prevDoc: Sound | undefined;
  let prevSig = '';
  let seenId = false;
  let lastGroupBefore: Sound | null = null;

  const closeGroup = (): void => {
    if (cur === null) return;
    const now = lib.get(id);
    const first = curEntries[0]!;
    const by = first.by;
    const base = { seq: curEntries.at(-1)!.seq, group: cur, by, ...(first.at ? { at: first.at } : {}) };
    const samples = now ? soundSamples(now).map((name) => ({ name, sha256: lib.samples.get(name)?.hash ?? 'none' })) : [];
    const sig = json(samples);
    // pointing a name at other audio changes what the sound is, though none of its own lines did
    const touched = json(prevDoc) !== json(now) || (!!now && sig !== prevSig);
    // a person approving the sound
    const approves = !isAgent(by) && curEntries.some((e) => new RegExp(`^sound mark ${id} approved`).test(e.cmd));
    if (approves) out.approvedAfter = base.seq;
    if (touched && now) {
      const before = prevDoc ? cloneSound(prevDoc) : null;
      const cmds = curEntries.map((e) => e.cmd).filter((c) => c.split(/\s+/).slice(0, 4).includes(id));
      out.groups.push({ group: cur, by, ...(first.at ? { at: first.at } : {}), seq: base.seq, cmds, kinds: [] });
      // a group that changed only words or a status (a mark, a moment, a class) leaves the version as it was
      const key = renderKey(now, (n) => { const e = lib.samples.get(n); return e ? sampleKeyPart(e) : 'none'; });
      if (out.snapshots.at(-1)?.key !== key) out.snapshots.push({ seq: base.seq, group: cur, by, ...(first.at ? { at: first.at } : {}), doc: cloneSound(now), samples, key });
      else { const last = out.snapshots[out.snapshots.length - 1]!; last.doc = cloneSound(now); last.samples = samples; }
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
    prevSig = sig;
    curEntries = [];
  };

  for (const e of effectiveEntries(tape)) {
    if (cur !== e.group) {
      closeGroup();
      cur = e.group;
      prevDoc = lib.get(id) ? cloneSound(lib.get(id)!) : undefined;
      prevSig = prevDoc ? json(soundSamples(prevDoc).map((name) => ({ name, sha256: lib.samples.get(name)?.hash ?? 'none' }))) : '';
    }
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

/** A column of a set's clip grid: one distinct version of a member. */
export interface Version extends Snapshot {
  /** v1…vN, oldest first, among the versions shown (the agent's proposal is not numbered). */
  label: string;
  /** The document holds this version now. */
  current: boolean;
  /** The agent's latest change, nobody having approved it since: proposed. */
  proposed: boolean;
}

/**
 * The versions a set's grid shows for one member: its most recent distinct renders (a later group that brings an earlier render
 * back makes that the newest), at most `max` of them numbered v1…vN oldest first, and the agent's proposal apart from them: the
 * latest version when it is an agent's change (not the sound's creation) that no person has approved since.
 */
export function gridVersions(p: Provenance, max = 4): { versions: Version[]; proposed: Version | null } {
  const seen = new Set<string>();
  const distinct: Snapshot[] = [];
  for (let i = p.snapshots.length - 1; i >= 0; i--) {
    const v = p.snapshots[i]!;
    if (seen.has(v.key)) continue;
    seen.add(v.key);
    distinct.unshift(v);
  }
  if (!distinct.length) return { versions: [], proposed: null };
  const last = distinct.at(-1)!;
  const pending = distinct.length > 1 && isAgent(last.by) && last.seq > p.approvedAfter;
  const shown = (pending ? distinct.slice(0, -1) : distinct).slice(-max);
  const versions = shown.map((v, i) => ({ ...v, label: `v${i + 1}`, current: !pending && v === last, proposed: false }));
  return { versions, proposed: pending ? { ...last, label: 'agent', current: true, proposed: true } : null };
}
