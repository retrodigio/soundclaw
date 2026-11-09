// The sample store's audio: the canonical hash, and the WAV, AIFF and FLAC decoders. Every fixture is written by test code
// (audio-fixtures.ts); the same audio in any container must give the same stored audio and the same hash.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeAudio, pcmHash, pcmToSampleData, pcmToWav, readSampleWav, sniffContainer, type PcmAudio, type PcmFormat } from '../src/index.ts';
import { acidChunk, aiffBytes, channelInts, cueChunk, flacBytes, infoChunk, makeAudio, riffChunk, smplChunk, wavBytes, type FlacKind, type FlacStereo } from './audio-fixtures.ts';

const same = (a: PcmAudio, b: PcmAudio) => {
  expect(b.rate).toBe(a.rate);
  expect(b.channels).toBe(a.channels);
  expect(b.format).toBe(a.format);
  expect(b.frames).toBe(a.frames);
  expect(Array.from(b.data)).toEqual(Array.from(a.data));
};

describe('the canonical hash', () => {
  it('is fixed: this audio has this hash on every machine, for ever (changing it would change every stored name)', () => {
    const a = makeAudio('pcm16', 2, 100, 44100, 1);
    expect(pcmHash(a)).toBe('272e68ec362b4e18a144e65c248801338dafeb3fc49ee124d5a1e18fcb8902bb');
    // and it is what the definition says: SHA-256 of the header text and the interleaved little-endian samples, here by the platform's own SHA-256
    const head = Buffer.from('soundclaw-pcm 1\nrate=44100\nchannels=2\nformat=pcm16\n');
    expect(createHash('sha256').update(head).update(a.data).digest('hex')).toBe(pcmHash(a));
  });
  it('covers the audio and its rate, channels and format, not the file around it', () => {
    const a = makeAudio('pcm16', 2, 500);
    const plain = wavBytes(a);
    const decorated = wavBytes(a, { before: [infoChunk({ INAM: 'a title', ICMT: 'a comment' })], after: [smplChunk({ note: 60 }), cueChunk([10, 20]), riffChunk('bext', new Array(602).fill(0))] });
    expect(decorated.length).toBeGreaterThan(plain.length);
    expect(pcmHash(decodeAudio(decorated).audio)).toBe(pcmHash(decodeAudio(plain).audio));
    expect(pcmHash({ ...a, rate: 48000 })).not.toBe(pcmHash(a));
    expect(pcmHash({ ...a, channels: 1, frames: 1000 })).not.toBe(pcmHash(a));
    expect(pcmHash({ ...a, format: 'pcm24' })).not.toBe(pcmHash(a));
    const b = { ...a, data: a.data.slice() };
    b.data[17] = b.data[17]! ^ 1;
    expect(pcmHash(b)).not.toBe(pcmHash(a));
  });
  it('is the same audio in the store form and back', () => {
    for (const f of ['pcm8', 'pcm16', 'pcm24', 'pcm32', 'f32'] as PcmFormat[]) {
      const a = makeAudio(f, 3, 300, 22050);
      same(a, decodeAudio(pcmToWav(a)).audio);
    }
  });
});

describe('WAV', () => {
  it('reads PCM 8, 16, 24 and 32 bit and float 32, mono to eight channels, to the audio it holds', () => {
    for (const f of ['pcm8', 'pcm16', 'pcm24', 'pcm32', 'f32'] as PcmFormat[]) {
      for (const ch of [1, 2, 5, 8]) {
        const a = makeAudio(f, ch, 123, 48000);
        const d = decodeAudio(wavBytes(a));
        same(a, d.audio);
        expect(d.container).toBe('wav');
      }
    }
  });
  it('reads WAVE_FORMAT_EXTENSIBLE and stores 64-bit float as 32-bit float, saying so', () => {
    const a = makeAudio('f32', 2, 200);
    same(a, decodeAudio(wavBytes(a, { extensible: true })).audio);
    const d = decodeAudio(wavBytes(a, { float64: true }));
    same(a, d.audio);
    expect(d.sourceFormat).toBe('float 64');
    expect(d.notes.join(' ')).toMatch(/64-bit float.*stored as 32-bit float/);
    same(makeAudio('pcm24', 2, 99), decodeAudio(wavBytes(makeAudio('pcm24', 2, 99), { extensible: true })).audio);
  });
  it('gives the renderer exactly the floats its sample layers have always read (readSampleWav)', () => {
    for (const f of ['pcm8', 'pcm16', 'pcm24', 'pcm32', 'f32'] as PcmFormat[]) {
      for (const ch of [1, 2, 3]) {
        const bytes = wavBytes(makeAudio(f, ch, 777, 22050));
        const old = readSampleWav(bytes);
        const now = pcmToSampleData(decodeAudio(bytes).audio);
        expect(now.rate).toBe(old.rate);
        expect(Array.from(now.data)).toEqual(Array.from(old.data));
        expect(Array.from(now.left ?? [])).toEqual(Array.from(old.left ?? []));
        expect(Array.from(now.right ?? [])).toEqual(Array.from(old.right ?? []));
      }
    }
  });
  it('reads what the file says about itself: root note and fine tuning, a loop, the one-shot flag, tempo, cue points and text', () => {
    const a = makeAudio('pcm16', 1, 2000);
    const bytes = wavBytes(a, {
      before: [infoChunk({ INAM: 'Thin bell', ICMT: 'made by test code', ICOP: 'public domain' })],
      after: [smplChunk({ note: 69, fraction: Math.round(0.25 * 4294967296), loop: { start: 100, end: 1500, type: 1 } }), acidChunk({ oneShot: true, root: 60, tempo: 120 }), cueChunk([400, 800, 1200])],
    });
    const d = decodeAudio(bytes);
    expect(d.meta).toMatchObject({ root: 69, tune: 25, loop: { start: 100, end: 1500, type: 'alternate' }, oneShot: true, tempo: 120, cues: [400, 800, 1200], info: { title: 'Thin bell', comment: 'made by test code', copyright: 'public domain' } });
    expect(d.notes.join('\n')).toContain('read root note A4 +25 cents');
    expect(d.notes.join('\n')).toContain('read a alternate loop, frames 100-1500');
    expect(d.notes.join('\n')).toContain('read 3 cue points');
    // a fraction above half a semitone is the note above, minus the rest
    expect(decodeAudio(wavBytes(a, { after: [smplChunk({ note: 60, fraction: Math.round(0.75 * 4294967296) })] })).meta).toMatchObject({ root: 61, tune: -25 });
    // the acid root is used when there is no smpl
    expect(decodeAudio(wavBytes(a, { after: [acidChunk({ root: 57 })] })).meta.root).toBe(57);
    // no chunks, no metadata
    expect(decodeAudio(wavBytes(a)).meta).toEqual({});
  });
  it('says what is wrong: the limits, a format it does not read, damage', () => {
    expect(() => decodeAudio(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toThrow(/not a WAV, AIFF or FLAC/);
    expect(() => decodeAudio(wavBytes(makeAudio('pcm16', 1, 100, 4000)))).toThrow(/4000 Hz \(samples are 8000-192000 Hz\)/);
    expect(decodeAudio(wavBytes(makeAudio('pcm16', 1, 100, 4000)), { lenient: true }).audio.rate).toBe(4000);
    expect(() => decodeAudio(wavBytes(makeAudio('pcm16', 9, 100)))).toThrow(/9 channels/);
    expect(() => decodeAudio(wavBytes(makeAudio('pcm16', 1, 1)))).toThrow(/no audio/);
    // a 601 s file
    const long = makeAudio('pcm8', 1, 8000 * 601, 8000);
    expect(() => decodeAudio(wavBytes(long))).toThrow(/601\.0 s long \(at most 600 s\)/);
    const adpcm = wavBytes(makeAudio('pcm16', 1, 10));
    adpcm[20] = 2; // format 2: ADPCM
    expect(() => decodeAudio(adpcm)).toThrow(/only PCM.*format 2/);
  });
  it('reads a file whose data chunk claims more than it has (a stream cut short)', () => {
    const a = makeAudio('pcm16', 1, 100);
    const bytes = wavBytes(a);
    const cut = bytes.slice(0, bytes.length - 20);
    const d = decodeAudio(cut);
    expect(d.audio.frames).toBe(90);
  });
});

describe('AIFF and AIFF-C', () => {
  it('read to the same audio and the same hash as the WAV of it, for every width, channel count and byte order', () => {
    for (const f of ['pcm8', 'pcm16', 'pcm24', 'pcm32'] as PcmFormat[]) {
      for (const ch of [1, 2]) {
        const a = makeAudio(f, ch, 400, 48000);
        for (const compression of [undefined, 'NONE', 'sowt'] as const) {
          const d = decodeAudio(aiffBytes(a, { compression }));
          same(a, d.audio);
          expect(pcmHash(d.audio)).toBe(pcmHash(a));
          expect(d.container).toBe('aiff');
        }
      }
    }
  });
  it('reads 32-bit float AIFF-C and the 80-bit sample rate of any common rate', () => {
    const a = makeAudio('f32', 2, 100, 96000);
    same(a, decodeAudio(aiffBytes(a, { compression: 'fl32' })).audio);
    for (const rate of [8000, 11025, 22050, 44100, 48000, 88200, 176400, 192000]) expect(decodeAudio(aiffBytes(makeAudio('pcm16', 1, 50, rate))).audio.rate).toBe(rate);
  });
  it('reads the instrument chunk (root, detune, sustain loop) and the text chunks', () => {
    const a = makeAudio('pcm16', 1, 1000);
    const d = decodeAudio(aiffBytes(a, { inst: { note: 64, detune: -12, loop: { start: 200, end: 800 } }, text: { NAME: 'Wood block', AUTH: 'test code' } }));
    expect(d.meta).toMatchObject({ root: 64, tune: -12, loop: { start: 200, end: 800, type: 'forward' }, info: { title: 'Wood block', author: 'test code' } });
  });
  it('refuses compressed AIFF-C by name', () => {
    const b = aiffBytes(makeAudio('pcm16', 1, 50), { compression: 'NONE' });
    const at = b.findIndex((_, i) => String.fromCharCode(b[i]!, b[i + 1]!, b[i + 2]!, b[i + 3]!) === 'NONE');
    b.set([...'ulaw'].map((c) => c.charCodeAt(0)), at);
    expect(() => decodeAudio(b)).toThrow(/only uncompressed AIFF.*'ulaw'/);
  });
});

describe('FLAC', () => {
  const KINDS: FlacKind[] = ['verbatim', 'fixed0', 'fixed1', 'fixed2', 'fixed3', 'fixed4', 'lpc'];
  const STEREO: FlacStereo[] = ['independent', 'left-side', 'right-side', 'mid-side'];

  it('reads every subframe kind, in 8, 16, 24 bits, to the audio of the WAV (and the same hash)', () => {
    for (const [bits, format] of [[8, 'pcm8'], [16, 'pcm16'], [24, 'pcm24']] as const) {
      const a = makeAudio(format, 1, 3000, 44100, bits);
      const ints = [channelInts(a, 0)];
      for (const kind of KINDS) {
        const d = decodeAudio(flacBytes(ints, bits, 44100, { kind, blockSize: 1000 }));
        same(a, d.audio);
        expect(pcmHash(d.audio), `${bits} ${kind}`).toBe(pcmHash(a));
        expect(d.container).toBe('flac');
        expect(d.sourceFormat).toBe(`FLAC ${bits}-bit`);
      }
    }
  });
  it('reads every stereo mode, block sizes that do not divide the length, rice partitions and escape codes', () => {
    const a = makeAudio('pcm16', 2, 2560, 48000, 5);
    const ints = [channelInts(a, 0), channelInts(a, 1)];
    for (const stereo of STEREO) {
      for (const [blockSize, partitionOrder, riceMethod, escape] of [[1152, 0, 0, false], [700, 2, 1, false], [1024, 3, 0, true], [96, 1, 0, false]] as const) {
        const d = decodeAudio(flacBytes(ints, 16, 48000, { kind: 'fixed2', stereo, blockSize, partitionOrder, riceMethod, escape }));
        same(a, d.audio);
      }
    }
  });
  it('reads constant blocks, wasted bits, and 32-bit and 12-bit streams (stored at the width that holds them)', () => {
    const silent = [new Array(900).fill(1234)];
    expect(channelInts(decodeAudio(flacBytes(silent, 16, 44100, { kind: 'constant' })).audio, 0)).toEqual(silent[0]);
    // every sample a multiple of 8: three wasted bits
    const a = makeAudio('pcm16', 1, 600);
    const ints = [channelInts(a, 0).map((x) => Math.floor(x / 8) * 8)];
    const d = decodeAudio(flacBytes(ints, 16, 44100, { kind: 'fixed1' }));
    expect(channelInts(d.audio, 0)).toEqual(ints[0]);
    // 32-bit
    const big = makeAudio('pcm32', 2, 800, 96000, 3);
    same(big, decodeAudio(flacBytes([channelInts(big, 0), channelInts(big, 1)], 32, 96000, { kind: 'lpc', stereo: 'mid-side', riceMethod: 1 })).audio);
    // 12-bit values are stored as 16-bit, left-justified, and the note says so
    const twelve = Array.from({ length: 500 }, (_, i) => ((i * 37) % 4096) - 2048);
    const d12 = decodeAudio(flacBytes([twelve], 12, 44100, { kind: 'fixed1' }));
    expect(d12.audio.format).toBe('pcm16');
    expect(channelInts(d12.audio, 0)).toEqual(twelve.map((x) => x * 16));
    expect(d12.notes.join(' ')).toContain('12-bit samples are stored as 16-bit');
  });
  it('reads the comment block, and notices damage (a checksum that does not match, a truncated file)', () => {
    const a = makeAudio('pcm16', 1, 500);
    const ints = [channelInts(a, 0)];
    expect(decodeAudio(flacBytes(ints, 16, 44100, { comments: { TITLE: 'A title', COPYRIGHT: 'None' } })).meta.info).toEqual({ title: 'A title', copyright: 'None' });
    const bytes = flacBytes(ints, 16, 44100, { kind: 'fixed2' });
    const bad = bytes.slice();
    bad[bad.length - 40] = bad[bad.length - 40]! ^ 0x55;
    expect(() => decodeAudio(bad)).toThrow(/FLAC/);
    expect(() => decodeAudio(bytes.slice(0, bytes.length - 100))).toThrow(/FLAC/);
  });
});

describe('what a container is', () => {
  it('is told from its first bytes, not its name', () => {
    expect(sniffContainer(wavBytes(makeAudio('pcm16', 1, 10)))).toBe('wav');
    expect(sniffContainer(aiffBytes(makeAudio('pcm16', 1, 10)))).toBe('aiff');
    expect(sniffContainer(flacBytes([[1, 2, 3, 4]], 16, 44100, { kind: 'verbatim' }))).toBe('flac');
    expect(sniffContainer(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(null); // OggS
  });
});

// Cross-checks against programs outside this repository, when they are installed: ffmpeg reads the test files to the same samples
// (so the fixtures are real FLAC and AIFF), and the reference FLAC encoder's output reads back to the audio it was given.
const has = (cmd: string): boolean => !spawnSync(cmd, ['--version'], { stdio: 'ignore' }).error;

describe.skipIf(!has('ffmpeg'))('ffmpeg agrees', () => {
  it('reads the FLAC and AIFF fixtures to the samples they were made from', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-xcheck-'));
    try {
      const a = makeAudio('pcm16', 2, 2560, 48000, 5);
      const ints = [channelInts(a, 0), channelInts(a, 1)];
      const raw = (file: string): Buffer => spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-'], { maxBuffer: 1 << 26 }).stdout;
      for (const stereo of ['independent', 'left-side', 'mid-side'] as const) {
        for (const kind of ['fixed2', 'lpc', 'verbatim'] as const) {
          const f = join(dir, `${stereo}-${kind}.flac`);
          writeFileSync(f, flacBytes(ints, 16, 48000, { kind, stereo, blockSize: 1152 }));
          expect(Buffer.compare(raw(f), Buffer.from(a.data)), `${stereo} ${kind}`).toBe(0);
        }
      }
      const aiff = join(dir, 'a.aiff');
      writeFileSync(aiff, aiffBytes(a));
      expect(Buffer.compare(raw(aiff), Buffer.from(a.data))).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!has('flac'))('the reference FLAC encoder agrees', () => {
  it('its files (16 and 24 bit, mono and stereo, levels 0 and 8) read back to the audio they were made from', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-xcheck-'));
    try {
      for (const [format, ch] of [['pcm16', 1], ['pcm16', 2], ['pcm24', 2]] as const) {
        const a = makeAudio(format, ch, 9000, 44100, 11);
        const wav = join(dir, `${format}-${ch}.wav`);
        writeFileSync(wav, wavBytes(a));
        for (const level of [0, 8]) {
          const out = join(dir, `${format}-${ch}-${level}.flac`);
          const r = spawnSync('flac', ['-s', '-f', `-${level}`, '-o', out, wav]);
          expect(r.status, String(r.stderr)).toBe(0);
          same(a, decodeAudio(new Uint8Array(readFileSync(out))).audio);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
