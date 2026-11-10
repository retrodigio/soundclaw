import { describe, expect, it } from 'vitest';
import { QUERY_KEYS, formatQuery, matchQuery, parseQuery } from '../src/numquery.ts';
import { readFileSync, existsSync } from 'node:fs';

const t = (s: string) => parseQuery(s).terms[0]!;

describe('numbers query: parsing', () => {
  it('parses the full example query', () => {
    const q = parseQuery('"creak" dur=0.8-2.5 lufs>-30 centroid<2.5k attack<20ms pitched=no onsets=1 loop=no channels=1 tag=wood source=library licence=shippable');
    expect(q.words).toEqual(['creak']);
    expect(q.terms.map((x) => x.key)).toEqual(['dur', 'lufs', 'centroid', 'attack', 'pitched', 'onsets', 'loop', 'channels', 'tag', 'source', 'licence']);
    expect(q.terms[0]).toMatchObject({ lo: 0.8, hi: 2.5, op: '=' });
    expect(q.terms[2]).toMatchObject({ lo: 2500, op: '<' });
    expect(parseQuery(formatQuery(q))).toEqual(q);
  });
  it('converts units into each key\'s own unit', () => {
    expect(t('attack<0.02s').lo).toBe(20);
    expect(t('dur<500ms').lo).toBe(0.5);
    expect(t('silence-start<1s').lo).toBe(1000);
    expect(t('centroid>2kHz').lo).toBe(2000);
    expect(t('centroid>800Hz').lo).toBe(800);
    expect(t('samplerate=44.1k').lo).toBe(44100);
    expect(t('lufs>-30LU').lo).toBe(-30);
    expect(t('peak<-1dB').lo).toBe(-1);
    expect(t('tempo=90-120bpm').hi).toBe(120);
  });
  it('knows every operator', () => {
    for (const op of ['=', '<', '>', '<=', '>=', '!=']) expect(t(`dur${op}2`).op).toBe(op);
  });
  it('reads negative numbers and ranges', () => {
    expect(t('lufs=-30--20')).toMatchObject({ lo: -30, hi: -20 });
    expect(t('lufs=-30-20')).toMatchObject({ lo: -30, hi: 20 });
    expect(t('lufs=-12')).toMatchObject({ lo: -12, hi: -12 });
    expect(t('noise<-60')).toMatchObject({ lo: -60 });
  });
  it('reads notes and ranges of notes', () => {
    expect(t('note=C4')).toMatchObject({ key: 'pitch', lo: 60, hi: 60 });
    expect(t('pitch=C3-C5')).toMatchObject({ lo: 48, hi: 72 });
    expect(t('pitch>F#3').lo).toBe(54);
    expect(t('pitch=Bb2').lo).toBe(46);
    expect(t('pitch=60-72')).toMatchObject({ lo: 60, hi: 72 });
    expect(t('pitch=C-1').lo).toBe(0);
  });
  it('reads booleans, text and aliases', () => {
    expect(t('pitched=yes').bool).toBe(true);
    expect(t('loop=false').bool).toBe(false);
    expect(t('pitched!=no')).toMatchObject({ op: '!=', bool: false });
    expect(t('duration=1').key).toBe('dur');
    expect(t('loudness<-20').key).toBe('lufs');
    expect(t('brightness<1k').key).toBe('centroid');
    expect(t('sr=48000').key).toBe('samplerate');
    expect(t('license=CC0-1.0')).toMatchObject({ key: 'licence', text: 'cc0-1.0' });
    expect(t('name="door 2"').text).toBe('door 2');
  });
  it('takes bare and quoted words', () => {
    expect(parseQuery('door "wooden door" creak').words).toEqual(['door', 'wooden door', 'creak']);
  });
  it('says what is wrong', () => {
    expect(() => parseQuery('loudnes<3')).toThrow(/no key 'loudnes'.*keys: dur,/);
    expect(() => parseQuery('attack<20hz')).toThrow(/'hz' is a frequency; attack takes ms or s/);
    expect(() => parseQuery('centroid<20ms')).toThrow(/'ms' is a time; centroid takes Hz or k/);
    expect(() => parseQuery('dur<2furlongs')).toThrow(/unknown unit 'furlongs'.*s or ms/);
    expect(() => parseQuery('dur=abc')).toThrow(/dur=abc: 'abc' is not a number in s/);
    expect(() => parseQuery('pitched=maybe')).toThrow(/yes or no/);
    expect(() => parseQuery('pitched>yes')).toThrow(/takes = or !=/);
    expect(() => parseQuery('dur<')).toThrow(/give a value/);
    expect(() => parseQuery('dur=3-1')).toThrow(/backwards/);
    expect(() => parseQuery('pitch=H4')).toThrow(/not a note/);
    expect(() => parseQuery('dur<2k')).toThrow(/thousands/);
    expect(() => parseQuery('"open')).toThrow(/quote/);
  });
});

describe('numbers query: matching', () => {
  const facts = { dur: 1.5, lufs: -24, centroid: 1800, attack: 12, pitched: false, onsets: 1, loop: false, channels: 1, source: 'library', licence: ['shippable', 'CC0-1.0'] };
  const q = 'creak dur=0.8-2.5 lufs>-30 centroid<2.5k attack<20ms pitched=no onsets=1 loop=no channels=1 tag=wood source=library licence=shippable';
  it('matches the example', () => {
    const r = matchQuery(parseQuery(q), facts, 'door_creak', ['wood', 'door']);
    expect(r).toMatchObject({ match: true, closeness: 0, failed: [], unknown: [] });
  });
  it('fails each part and names it', () => {
    const r = matchQuery(parseQuery(q), { ...facts, dur: 3, licence: 'blocked' }, 'door_creak', ['metal']);
    expect(r.match).toBe(false);
    expect(r.failed).toEqual(['dur=0.8-2.5', 'tag=wood', 'licence=shippable']);
  });
  it('words match names and tags, ignoring case', () => {
    expect(matchQuery(parseQuery('CREAK'), {}, 'door_creak', []).match).toBe(true);
    expect(matchQuery(parseQuery('rain'), {}, 'x', ['Rain']).match).toBe(true);
    expect(matchQuery(parseQuery('rain'), {}, 'x', ['wind']).match).toBe(false);
  });
  it('a missing measure fails the term and is reported', () => {
    const r = matchQuery(parseQuery('dur<2 tempo>80'), { dur: 1 }, 'a', []);
    expect(r.match).toBe(false);
    expect(r.unknown).toEqual(['tempo>80']);
  });
  it('tags are all-of, name is a substring, != negates', () => {
    expect(matchQuery(parseQuery('tag=a tag=b'), {}, 'x', ['a', 'b', 'c']).match).toBe(true);
    expect(matchQuery(parseQuery('tag=a tag=z'), {}, 'x', ['a', 'b']).match).toBe(false);
    expect(matchQuery(parseQuery('name=door'), {}, 'big_door_2', []).match).toBe(true);
    expect(matchQuery(parseQuery('source!=generated'), { source: 'file' }, 'x', []).match).toBe(true);
    expect(matchQuery(parseQuery('dur!=1-2'), { dur: 1.5 }, 'x', []).match).toBe(false);
    expect(matchQuery(parseQuery('pitch=C3-C5'), { pitch: 60 }, 'x', []).match).toBe(true);
  });
  it('edges: <= and >= include the bound, < and > do not', () => {
    expect(matchQuery(parseQuery('dur<=2'), { dur: 2 }, 'x', []).match).toBe(true);
    expect(matchQuery(parseQuery('dur<2'), { dur: 2 }, 'x', []).match).toBe(false);
    expect(matchQuery(parseQuery('dur>=2'), { dur: 2 }, 'x', []).match).toBe(true);
    expect(matchQuery(parseQuery('dur>2'), { dur: 2 }, 'x', []).match).toBe(false);
  });
  it('closeness grows with the distance outside the range', () => {
    const p = parseQuery('dur=1-2 centroid<2k');
    const c = (f: Record<string, number>) => matchQuery(p, f, 'x', []).closeness;
    expect(c({ dur: 1.5, centroid: 1000 })).toBe(0);
    expect(c({ dur: 2.2, centroid: 1000 })).toBeGreaterThan(0);
    expect(c({ dur: 3, centroid: 1000 })).toBeGreaterThan(c({ dur: 2.2, centroid: 1000 }));
    expect(c({ dur: 1.5, centroid: 4000 })).toBeGreaterThan(c({ dur: 1.5, centroid: 2100 }));
  });
});

describe('numbers query: keys table', () => {
  it('has a unique key each, and the docs list every key when they describe the query', () => {
    expect(new Set(QUERY_KEYS.map((x) => x.key)).size).toBe(QUERY_KEYS.length);
    const f = new URL('../../docs/commands.md', import.meta.url);
    if (!existsSync(f)) return;
    const docs = readFileSync(f, 'utf8');
    if (!docs.includes('numbers query')) return;
    for (const x of QUERY_KEYS) expect(docs, `docs/commands.md should list the query key ${x.key}`).toContain(`\`${x.key}\``);
  });
});
