// The rail's feed: the takes of one generation call are one item (what was asked, how many, what it cost), an instrument command links to its page, and a
// sample import reads as what came in.
import { describe, expect, it } from 'vitest';
import type { Store } from '../src/store.ts';
import { buildFeed, instrumentOfCmd } from '../src/studio/shellData.ts';

const sha = (n: number): string => n.toString(16).padStart(64, '0');
const gen = (seq: number, group: string, name: string, take: string, credits: number): { seq: number; by: string; at: string; group: string; cmd: string } => ({
  seq, by: 'agent:claude', at: new Date(Date.UTC(2026, 10, 9, 10, 0, seq)).toISOString(), group,
  cmd: `sample add ${name} hash=${sha(seq)} rate=44100 channels=1 frames=44100 format=pcm16 source=generated provider=elevenlabs prompt="a slow creak" take=${take} credits=${credits} licence=unknown`,
});
const store = (tape: ReturnType<typeof gen>[]): Store => ({ tape, requests: [], index: [] }) as unknown as Store;

describe('the feed', () => {
  it('puts the takes of one call together, and keeps two calls apart', () => {
    const feed = buildFeed(store([gen(1, 'g1', 'creak_t1', '1/3', 10), gen(2, 'g1', 'creak_t2', '2/3', 10), gen(3, 'g1', 'creak_t3', '3/3', 10), gen(4, 'g2', 'bell_t1', '1/1', 8)]));
    const texts = feed.map((f) => f.text);
    expect(texts.filter((t) => t.startsWith('Generated 3 takes'))).toEqual(['Generated 3 takes: “a slow creak”, 30 credits']);
    expect(texts.some((t) => t.startsWith('Generated bell_t1'))).toBe(true);
    expect(feed).toHaveLength(2);
    expect(feed.find((f) => f.takes === 3)!.sample).toBe('creak_t1');
  });
  it('reads which instrument a command is about', () => {
    expect(instrumentOfCmd('instrument zone add harp sample=c3 root=C3 keys=C2-D#3')).toBe('harp');
    expect(instrumentOfCmd('instrument zones harp from-samples a b')).toBe('harp');
    expect(instrumentOfCmd('instrument set harp range=C2-B4')).toBe('harp');
    expect(instrumentOfCmd('instrument from-sample pad hum')).toBe('pad');
    expect(instrumentOfCmd('sound set beep volume=0.2')).toBeNull();
  });
});
