// The Samples views' logic without a browser: the feed's words for a sample on the tape, the sample routes, the numbers query over a project's
// samples, the row's numbers, and the violet mark's bookkeeping.

import { beforeEach, describe, expect, it } from 'vitest';
import { encodeMeasure, measureSample, decodeMeasure } from '@soundclaw/core';
import type { SampleInfo } from '@soundclaw/server/protocol';
import { sampleFeedText } from '../src/studio/shellData.ts';
import { SampleCardsClient, filterSamples, needsNumbers, parseFilter, rowNumbers, sampleFacts, type CardView } from '../src/studio/samplesApi.ts';
import { markSampleSeen, newSampleNames } from '../src/studio/sampleSeen.ts';
import { parseRoute } from '../src/store.ts';

const info = (name: string, more: Partial<SampleInfo> = {}): SampleInfo => ({
  name, sha256: name.padEnd(64, '0'), rate: 44100, frames: 44100, seconds: 1, channels: 1, bytes: 88244, format: 'pcm16', licence: 'unknown', licenceState: 'unknown', source: 'file', tags: [], ...more,
});

const tone = (hz: number, secs: number): Float32Array => Float32Array.from({ length: Math.round(44100 * secs) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / 44100));
const cardOf = (name: string, hz: number, secs: number): CardView => ({ hash: name.padEnd(64, '0'), m: decodeMeasure(JSON.parse(JSON.stringify(encodeMeasure(measureSample([tone(hz, secs)], 44100))))), peaks: { min: [-0.5], max: [0.5] } });

describe('the feed says what came in', () => {
  it('an import, a library file, a recording, a take, a derived sample, a bounce and an instrument file', () => {
    expect(sampleFeedText('sample add kick hash=' + 'a'.repeat(64) + ' rate=44100 channels=1 frames=22050 format=pcm16 source=file origin="Kick Drum.wav" licence=own')?.text).toBe('Imported kick from Kick Drum.wav (0.50 s)');
    expect(sampleFeedText('sample add creak hash=' + 'a'.repeat(64) + ' rate=44100 channels=1 frames=44100 format=pcm16 source=library origin=cellar:doors/creak.wav')?.text).toBe('Used library file cellar:doors/creak.wav as creak (1.00 s)');
    expect(sampleFeedText('sample add rec_1 hash=' + 'a'.repeat(64) + ' rate=48000 channels=1 frames=96000 format=f32 source=recorded origin=microphone licence=own')?.text).toBe('Recorded rec_1 (2.00 s)');
    const gen = sampleFeedText('sample add door_t2 hash=' + 'a'.repeat(64) + ' rate=44100 channels=1 frames=52920 format=pcm16 source=generated provider=elevenlabs prompt="a slow, close creak" take=2/3 credits=12');
    expect(gen).toEqual({ sample: 'door_t2', text: 'Generated door_t2 (1.20 s): “a slow, close creak”, take 2/3, 12 credits' });
    expect(sampleFeedText('sample add soft hash=' + 'a'.repeat(64) + ' rate=44100 channels=1 frames=44100 format=f32 source=derived ops="fade out=4410f; gain -6"')?.text).toBe('Derived soft (fade out=4410f; gain -6) (1.00 s)');
    expect(sampleFeedText('sample add hit hash=' + 'a'.repeat(64) + ' rate=44100 channels=1 frames=4410 format=f32 source=bounce')?.text).toBe('Bounced hit (0.10 s)');
    expect(sampleFeedText('sample add C4 hash=' + 'a'.repeat(64) + ' rate=44100 channels=1 frames=44100 format=pcm16 source=instrument-import origin=strings.sfz:Samples/mid.wav')?.text).toBe('Imported C4 from strings.sfz:Samples/mid.wav (1.00 s)');
  });
  it('a long prompt is cut, and other commands are not samples', () => {
    const long = 'x'.repeat(200);
    const t = sampleFeedText(`sample add g hash=${'a'.repeat(64)} rate=44100 channels=1 frames=44100 format=pcm16 source=generated prompt="${long}"`)!.text;
    expect(t.length).toBeLessThan(140);
    expect(t).toContain('…');
    expect(sampleFeedText('sound set beep decay=0.3')).toBeNull();
    expect(sampleFeedText('sample set kick licence=own')).toBeNull();
  });
});

describe('sample routes', () => {
  it('a sample page, and the page a layer opens', () => {
    expect(parseRoute('#/sample/door_hits')).toEqual({ kind: 'sample', name: 'door_hits' });
    expect(parseRoute('#/sample/door_hits/layer/knock/2')).toEqual({ kind: 'sample', name: 'door_hits', layer: { sound: 'knock', n: 2 } });
    expect(parseRoute('#/sample/9lives')).toEqual({ kind: 'sample', name: '9lives' });
    expect(parseRoute('#/sample/')).toEqual({ kind: 'cards' });
  });
});

describe('the filter over a project\'s samples', () => {
  const list = [info('thump', { tags: ['drum'], source: 'file', loop: [100, 900] }), info('whine', { tags: ['synth'], licence: 'own', licenceState: 'shippable' }), info('creak', { source: 'generated' })];
  const cards = (have: Record<string, CardView>) => {
    const c = new SampleCardsClient(() => 'tok');
    for (const [k, v] of Object.entries(have)) (c as unknown as { cards: Map<string, CardView> }).cards.set(v.hash, v), void k;
    return c;
  };
  it('words and flags need only the list; numbers wait for the card', () => {
    const none = cards({});
    expect(filterSamples(list, parseFilter('drum').q, none).rows.map((x) => x.name)).toEqual(['thump']);
    expect(filterSamples(list, parseFilter('loop=yes').q, none).rows.map((x) => x.name)).toEqual(['thump']);
    expect(filterSamples(list, parseFilter('licence=own').q, none).rows.map((x) => x.name)).toEqual(['whine']);
    expect(filterSamples(list, parseFilter('source=generated').q, none).rows.map((x) => x.name)).toEqual(['creak']);
    const numbers = filterSamples(list, parseFilter('centroid>500').q, none);
    expect(numbers.rows).toEqual([]);
    expect(numbers.pending).toBe(3);
  });
  it('a number is tested once the card is here, closest first', () => {
    const c = cards({ thump: cardOf('thump', 110, 1), whine: cardOf('whine', 3000, 1), creak: cardOf('creak', 900, 1) });
    const r = filterSamples(list, parseFilter('centroid>500').q, c);
    expect(r.pending).toBe(0);
    expect(r.rows.map((x) => x.name).sort()).toEqual(['creak', 'whine']);
    expect(filterSamples(list, parseFilter('centroid<500').q, c).rows.map((x) => x.name)).toEqual(['thump']);
  });
  it('a query that does not parse says why, and a blank one keeps everything', () => {
    expect(parseFilter('dur<').error).toMatch(/\S/);
    expect(parseFilter('').q).toBeNull();
    expect(filterSamples(list, null, cards({})).rows).toHaveLength(3);
    expect(needsNumbers(parseFilter('dur<1 drum').q!)).toBe(true);
    expect(needsNumbers(parseFilter('drum loop=yes').q!)).toBe(false);
  });
  it('the facts are the list\'s and the card\'s', () => {
    const f = sampleFacts(list[0]!, cardOf('thump', 110, 1));
    expect(f).toMatchObject({ loop: true, channels: 1, samplerate: 44100, bits: 16, tag: ['drum'], source: 'file', name: 'thump' });
    expect(f.dur).toBeCloseTo(1, 1);
    expect(sampleFacts(list[1]!, undefined).dur).toBe(1);
  });
});

describe('a row\'s numbers', () => {
  it('length, loudness and the note: the root when the sample has one, else the pitch it sounds at', () => {
    const c = cardOf('x', 440, 1);
    expect(rowNumbers(1, undefined, undefined)).toBe('1.00 s');
    expect(rowNumbers(12.34, undefined, 'C4')).toBe('12.3 s · C4');
    expect(rowNumbers(1, c, undefined)).toMatch(/^1\.00 s · −\d+\.\d LUFS · A4$/);
    expect(rowNumbers(1, c, 'C3')).toMatch(/ · C3$/);
  });
});

describe('the violet mark', () => {
  const store = (names: [string, string | undefined][]) => ({ project: { name: `p${Math.random()}`, dir: '/x' }, status: 'open' as const, samples: names.map(([n, a]) => info(n, a ? { author: a } : {})) });
  beforeEach(() => { try { localStorage.clear(); } catch { /* none here */ } });
  it('what was there when the page first opened is not news; a sample the agent adds later is, until it is seen', () => {
    // without a browser store there is no localStorage: the module keeps its set in memory
    const s = store([['old_agent', 'agent:claude'], ['old_mine', 'human:ana']]);
    expect([...newSampleNames(s)]).toEqual([]);
    s.samples = [...s.samples, info('fresh', { author: 'agent:claude' }), info('mine', { author: 'human:ana' })];
    expect([...newSampleNames(s)]).toEqual(['fresh']);
    markSampleSeen(s, 'fresh');
    expect([...newSampleNames(s)]).toEqual([]);
  });
});
