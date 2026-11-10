import { describe, expect, it } from 'vitest';
import { arcSpan, formatValue, midiToNote, noteToMidi, parseValue, plural, snap } from '../src/studio/values.ts';

describe('typed values with units', () => {
  it('seconds accept ms, s and a bare number', () => {
    expect(parseValue('110ms', { unit: 's' })).toBeCloseTo(0.11, 10);
    expect(parseValue('0.11', { unit: 's' })).toBe(0.11);
    expect(parseValue('1.5 s', { unit: 's' })).toBe(1.5);
    expect(parseValue('3dB', { unit: 's' })).toBeNull();
  });
  it('frequency accepts k, kHz, Hz and note names', () => {
    expect(parseValue('1.8k', { unit: 'hz' })).toBe(1800);
    expect(parseValue('2kHz', { unit: 'hz' })).toBe(2000);
    expect(parseValue('440hz', { unit: 'hz' })).toBe(440);
    expect(parseValue('C6', { unit: 'hz' })).toBeCloseTo(1046.5, 1);
    expect(parseValue('A4', { unit: 'hz' })).toBeCloseTo(440, 6);
  });
  it('percent, decibels with a true minus, semitones', () => {
    expect(parseValue('18%', { unit: 'pct' })).toBeCloseTo(0.18, 10);
    expect(parseValue('0.4', { unit: 'pct' })).toBe(0.4);
    expect(parseValue('−3dB', { unit: 'db' })).toBe(-3);
    expect(parseValue('-3 dB', { unit: 'db' })).toBe(-3);
    expect(parseValue('+5st', { unit: 'st' })).toBe(5);
    expect(parseValue('18%', { unit: 'plain' })).toBeCloseTo(0.18, 10);
    expect(parseValue('1.8k', { unit: 'plain' })).toBe(1800);
  });
  it('rejects text that is not a value', () => {
    for (const t of ['', 'abc', '1..2', '5 parsecs']) expect(parseValue(t, { unit: 'plain' })).toBeNull();
  });
  it('note names', () => {
    expect(noteToMidi('C4')).toBe(60);
    expect(noteToMidi('F#3')).toBe(54);
    expect(noteToMidi('Bb2')).toBe(46);
    expect(midiToNote(84)).toBe('C6');
    expect(parseValue('C6', { unit: 'note' })).toBe(84);
  });
});

describe('formatting', () => {
  it('uses the true minus and units', () => {
    expect(formatValue(-0.42, { unit: 'plain' })).toBe('−0.42');
    expect(formatValue(2400, { unit: 'hz' })).toBe('2.40 kHz');
    expect(formatValue(440, { unit: 'hz' })).toBe('440 Hz');
    expect(formatValue(0.31, { unit: 's' })).toBe('0.31 s');
    expect(formatValue(0.05, { unit: 's' })).toBe('50 ms');
    expect(formatValue(0.18, { unit: 'pct' })).toBe('18%');
    expect(formatValue(-3, { unit: 'db' })).toBe('−3.0 dB');
    expect(formatValue(5, { unit: 'st' })).toBe('+5 st');
  });
  it('round-trips what it shows', () => {
    for (const [v, spec] of [[0.31, { unit: 's' }], [2400, { unit: 'hz' }], [0.18, { unit: 'pct' }], [-3, { unit: 'db' }]] as const) {
      const shown = formatValue(v, spec).replace(/ ?(kHz|Hz|dB|st|ms|s)$/, (m) => (m.trim() === 'kHz' ? 'k' : m.trim()));
      expect(parseValue(shown, spec)).toBeCloseTo(v, 1);
    }
  });
});

describe('arcs and steps', () => {
  it('fills from the minimum, or from the centre when bipolar', () => {
    expect(arcSpan(0.3, false)).toEqual([0, 0.3]);
    expect(arcSpan(0.3, true)).toEqual([0.3, 0.5]);
    expect(arcSpan(0.8, true)).toEqual([0.5, 0.8]);
  });
  it('snaps to a step from the minimum', () => {
    expect(snap(0.14, 0.05, 0)).toBeCloseTo(0.15, 10);
    expect(snap(7.4, 0, 0)).toBe(7.4);
  });
});

describe('counts with their noun', () => {
  it('say one thing in the singular and everything else in the plural', () => {
    expect(plural(1, 'sound')).toBe('1 sound');
    expect(plural(0, 'sound')).toBe('0 sounds');
    expect(plural(2, 'song')).toBe('2 songs');
    expect(plural(1, 'member')).toBe('1 member');
    expect(plural(3, 'copy', 'copies')).toBe('3 copies');
    expect(plural(1, 'copy', 'copies')).toBe('1 copy');
  });
});
