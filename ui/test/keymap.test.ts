// The key-map's arithmetic: the keys shown, positions, dragging an edge, dropping a sample, the computer keyboard and MIDI messages.
import { describe, expect, it } from 'vitest';
import { boundaryAtX, dragTo, COMPUTER_KEYS, computerNote, dropZone, geometry, keyAtX, keyRange, keysText, moveEdge, parseMidiMessage, velAtY, xOfKey, yOfVel, zoneSetCommand } from '../src/instruments/keymap.ts';

const z = (lo: number, hi: number, hit: string | null = null) => ({ keys: [lo, hi] as [number, number], hit });

describe('the grid', () => {
  it('shows whole octaves around the zones and the range, at least three octaves, inside 0..127', () => {
    expect(keyRange([z(48, 59), z(60, 71)], null)).toEqual([36, 71]);
    expect(keyRange([z(60, 62)], [48, 72])).toEqual([48, 83]);
    expect(keyRange([], null)).toEqual([48, 95]);
    expect(keyRange([z(0, 127)], null)).toEqual([0, 127]);
    const [lo, hi] = keyRange([z(120, 127)], null);
    expect(hi).toBe(127);
    expect(hi - lo + 1).toBeGreaterThanOrEqual(36);
    const [kl, kh] = keyRange([z(10, 12, 'kick')], null);
    expect(kh).toBeGreaterThan(kl);
  });
  it('maps keys and velocities to places and back', () => {
    const g = geometry(48, 83);
    for (const m of [48, 60, 83]) expect(keyAtX(g, xOfKey(g, m) + g.keyW / 2)).toBe(m);
    expect(keyAtX(g, -50)).toBe(48);
    expect(keyAtX(g, 5000)).toBe(83);
    for (const v of [1, 40, 127]) expect(velAtY(g, yOfVel(g, v))).toBe(v);
    expect(velAtY(g, -100)).toBe(127);
    expect(velAtY(g, 5000)).toBe(1);
  });
});

describe('dragging an edge', () => {
  const s = { keys: [50, 60] as [number, number], vel: [20, 100] as [number, number] };
  it('moves one edge and stops at the other', () => {
    expect(moveEdge(s, 'left', 44, 0).keys).toEqual([44, 60]);
    expect(moveEdge(s, 'left', 70, 0).keys).toEqual([60, 60]);
    expect(moveEdge(s, 'right', 40, 0).keys).toEqual([50, 50]);
    expect(moveEdge(s, 'right', 200, 0).keys).toEqual([50, 127]);
    expect(moveEdge(s, 'top', 0, 127).vel).toEqual([20, 127]);
    expect(moveEdge(s, 'top', 0, 5).vel).toEqual([20, 20]);
    expect(moveEdge(s, 'bottom', 0, 0).vel).toEqual([1, 100]);
    expect(moveEdge(s, 'bottom', 0, 120).vel).toEqual([100, 100]);
  });
  it('writes one command with only what changed, in the notes the tape uses', () => {
    const after = moveEdge(s, 'left', 44, 0);
    expect(zoneSetCommand('harp', 2, s, after)).toBe('instrument zone set harp 2 keys=G#2-C4');
    expect(zoneSetCommand('harp', 1, s, moveEdge(s, 'top', 0, 127))).toBe('instrument zone set harp 1 vel=20-127');
    expect(zoneSetCommand('harp', 1, s, s)).toBeNull();
    expect(keysText([60, 60])).toBe('C4');
  });
});

describe('dropping a sample on a key', () => {
  it('uses the sample\'s own root, else the measured pitch with the tuning that cancels it, else the key', () => {
    expect(dropZone('harp', { name: 'c3', root: 'C3' }, 50)).toMatchObject({ command: 'instrument zone add harp sample=c3 keys=C#3-D#3' });
    const measured = dropZone('harp', { name: 'g3', pitch: { note: 'G3', cents: 10 }, pitched: true }, 55);
    expect(measured.command).toBe('instrument zone add harp sample=g3 root=G3 tune=-10 keys=F#3-G#3');
    expect(dropZone('harp', { name: 'g3', pitch: { note: 'G3', cents: 0 }, pitched: true }, 55).command).toBe('instrument zone add harp sample=g3 root=G3 keys=F#3-G#3');
    const none = dropZone('drums', { name: 'hit', pitch: null }, 36, 60);
    expect(none.command).toBe('instrument zone add drums sample=hit root=C2 keys=B1-C#2 vel=60-127');
    expect(none.note).toMatch(/no steady pitch.*C2/);
    expect(dropZone('x', { name: 'noise', pitch: { note: 'A2', cents: 3 }, pitched: false }, 40).note).toMatch(/no steady pitch/);
    expect(dropZone('x', { name: 'a', root: 'A4' }, 0).command).toContain('keys=C-1-C#-1');
  });
});

describe('letting go of an edge on the grid', () => {
  const g = geometry(48, 83);
  const s = { keys: [50, 60] as [number, number], vel: [20, 100] as [number, number] };
  it('puts a left edge on the nearest line and a right edge on the line after its last key', () => {
    expect(boundaryAtX(g, xOfKey(g, 52) + 1)).toBe(52);
    expect(boundaryAtX(g, xOfKey(g, 52) + g.keyW * 0.6)).toBe(53);
    expect(dragTo(g, s, 'left', xOfKey(g, 44 + 4), 0).keys).toEqual([48, 60]);
    expect(dragTo(g, s, 'left', xOfKey(g, 55), 0).keys).toEqual([55, 60]);
    expect(dragTo(g, s, 'right', xOfKey(g, 70), 0).keys).toEqual([50, 69]);
    expect(dragTo(g, s, 'right', xOfKey(g, 50), 0).keys).toEqual([50, 50]);
  });
  it('puts a velocity edge on the band it was let go in', () => {
    expect(dragTo(g, s, 'top', 0, yOfVel(g, 90)).vel).toEqual([20, 90]);
    expect(dragTo(g, s, 'bottom', 0, yOfVel(g, 29)).vel).toEqual([30, 100]);
    expect(dragTo(g, s, 'top', 0, -50).vel).toEqual([20, 127]);
  });
});

describe('playing', () => {
  it('maps the home row to a piano and shifts by octave', () => {
    expect(computerNote('a', 4)).toBe(60);
    expect(computerNote('K', 4)).toBe(72);
    expect(computerNote('w', 3)).toBe(49);
    expect(computerNote('z', 4)).toBeNull();
    expect(computerNote('a', 10)).toBeNull();
    expect(new Set(Object.values(COMPUTER_KEYS)).size).toBe(Object.keys(COMPUTER_KEYS).length);
  });
  it('reads note on and off messages, a note on with velocity 0 as an off, and nothing else', () => {
    expect(parseMidiMessage([0x90, 60, 100])).toEqual({ on: true, midi: 60, vel: 100 });
    expect(parseMidiMessage([0x93, 61, 0])).toEqual({ on: false, midi: 61, vel: 0 });
    expect(parseMidiMessage([0x80, 62, 64])).toEqual({ on: false, midi: 62, vel: 64 });
    expect(parseMidiMessage([0xb0, 64, 127])).toBeNull();
    expect(parseMidiMessage([0x90, 60])).toBeNull();
  });
});
