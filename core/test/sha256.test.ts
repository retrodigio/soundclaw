import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { floatBytes, floatsFromBytes, sha256Hex, sha256Text, utf8 } from '../src/index.ts';

describe('sha256', () => {
  it('matches the published vectors', () => {
    expect(sha256Text('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Text('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });
  it('agrees with node:crypto for every length around the block boundaries, and for non-ASCII text', () => {
    for (let n = 0; n < 200; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 7 + n) & 255);
      expect(sha256Hex(b), `length ${n}`).toBe(createHash('sha256').update(b).digest('hex'));
    }
    const text = 'héllo ✓ 𝄞 sound';
    expect([...utf8(text)]).toEqual([...Buffer.from(text, 'utf8')]);
  });
  it('floats round-trip through their bytes', () => {
    const f = Float32Array.from([0, -0.5, 1, 0.1234567, -1e-30]);
    expect([...floatsFromBytes(floatBytes(f))]).toEqual([...f]);
  });
});
