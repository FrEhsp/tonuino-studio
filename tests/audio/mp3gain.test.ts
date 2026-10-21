import { describe, expect, it } from 'vitest';
import { crc16, readBits, writeBits } from '../../src/core/audio/bits';
import { decodeHeader, readU32, scanMp3, type Mp3Index } from '../../src/core/audio/mp3frames';
import { adjustFrameGain, applyGain, GAIN_STEP_DB, globalGainBitOffsets, readGlobalGains, stepsForTarget } from '../../src/core/audio/mp3gain';
import { ID3Writer } from 'browser-id3-writer';
import { buildSmallId3, measureTags, parseId3v2, replaceTags, tagBytes } from '../../src/core/audio/id3';
import { bufferSource, fileSource } from '../../src/core/audio/source';
import { lsfMp3, monoMp3, stereoMp3 } from './fixtures';
import { blobBytes, concat, decodeMp3, rawBytesPerBlob, rmsDb } from './helpers';

/** Bit-by-bit CRC-16 (x^16 + x^15 + x^2 + 1, start 0xFFFF) as written in ISO 11172-3. */
function referenceCrc(bits: number[]): number {
  let crc = 0xffff;
  for (const bit of bits) {
    const top = (crc >> 15) & 1;
    crc = (crc << 1) & 0xffff;
    if (top ^ bit) crc ^= 0x8005;
  }
  return crc;
}

function protectedBits(frame: Uint8Array, offset: number, sideInfoSize: number): number[] {
  const bits: number[] = [];
  for (let i = 16; i < 32; i++) bits.push(readBits(frame, offset * 8 + i, 1));
  for (let i = 0; i < sideInfoSize * 8; i++) bits.push(readBits(frame, (offset + 6) * 8 + i, 1));
  return bits;
}

/** Turns lamejs frames into CRC-protected ones (moving 2 unused trailing bytes to the CRC field). */
function withCrc(mp3: Uint8Array): Uint8Array {
  const frames: Uint8Array[] = [];
  for (let p = 0; p + 4 <= mp3.length; ) {
    const h = decodeHeader(readU32(mp3, p))!;
    const f = mp3.subarray(p, p + h.frameLength);
    const base = h.channels === 1 ? 18 : 20;
    let bits = 0;
    for (let i = 0; i < 2 * h.channels; i++) bits += readBits(f, 32 + base + i * 59, 12);
    const region = 4 + h.sideInfoSize;
    if (Math.ceil(bits / 8) <= h.frameLength - region - 2) {
      const g = new Uint8Array(h.frameLength);
      g.set(f.subarray(0, 4));
      g[1] &= 0xfe;
      g.set(f.subarray(4, region), 6);
      g.set(f.subarray(region, h.frameLength - 2), region + 2);
      const crc = referenceCrc(protectedBits(g, 0, h.sideInfoSize));
      g[4] = crc >> 8;
      g[5] = crc & 0xff;
      frames.push(g);
    } else {
      frames.push(f.slice());
    }
    p += h.frameLength;
  }
  return concat(frames);
}

function allGains(bytes: Uint8Array, idx: Mp3Index): number[][] {
  return Array.from(idx.frameOffsets, (o) => readGlobalGains(bytes, o));
}

/** Real audio work: a test takes a second or two alone, much longer while the whole suite keeps the machine busy. */
const SLOW = { timeout: 30_000 };

describe('mp3gain', SLOW, () => {
  it('uses the standard CRC-16 (check value of "123456789")', () => {
    expect(crc16(new TextEncoder().encode('123456789'))).toBe(0xaee7);
  });

  it('locates global_gain for every MPEG version and channel layout', () => {
    expect(globalGainBitOffsets(1, 1)).toEqual([39, 98]);
    expect(globalGainBitOffsets(1, 2)).toEqual([41, 100, 159, 218]);
    expect(globalGainBitOffsets(2, 1)).toEqual([30]);
    expect(globalGainBitOffsets(2, 2)).toEqual([31, 94]);
  });

  for (const [name, make, steps] of [
    ['MPEG1 mono', monoMp3, 3],
    ['MPEG1 stereo', stereoMp3, -2],
    ['MPEG2 mono', lsfMp3, 4],
  ] as const) {
    it(`changes every global_gain by exactly N (${name})`, async () => {
      const mp3 = make();
      const src = bufferSource(mp3);
      const idx = await scanMp3(src);
      const before = allGains(mp3, idx);
      let clamped = -1;
      const out = await blobBytes(await applyGain(src, idx, steps, { onClamped: (n) => (clamped = n) }));
      expect(out.length).toBe(mp3.length);
      const idx2 = await scanMp3(bufferSource(out));
      expect([...idx2.frameOffsets]).toEqual([...idx.frameOffsets]);
      const after = allGains(out, idx2);
      const expected = before.map((g) => g.map((v) => Math.max(0, Math.min(255, v + steps))));
      expect(after).toEqual(expected);
      expect(clamped).toBe(0);
      // Only the global_gain bits changed.
      let changedBytes = 0;
      for (let i = 0; i < mp3.length; i++) if (mp3[i] !== out[i]) changedBytes++;
      expect(changedBytes).toBeLessThanOrEqual(idx.frameCount * before[0].length * 2);
      // Still decodes, louder or quieter by N · 1.505 dB.
      const a = await decodeMp3(mp3, false);
      const b = await decodeMp3(out, false);
      expect(b.samplesDecoded).toBe(a.samplesDecoded);
      expect(rmsDb(b.channelData[0]) - rmsDb(a.channelData[0])).toBeCloseTo(steps * GAIN_STEP_DB, 1);
    });
  }

  it('is reversible', async () => {
    const mp3 = monoMp3();
    const idx = await scanMp3(bufferSource(mp3));
    const up = await blobBytes(await applyGain(bufferSource(mp3), idx, 5));
    const down = await blobBytes(await applyGain(bufferSource(up), await scanMp3(bufferSource(up)), -5));
    expect(down).toEqual(mp3);
  });

  it('keeps tags and junk untouched', async () => {
    const mp3 = monoMp3();
    const head = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5]);
    const tail = new Uint8Array(128);
    tail.set([0x54, 0x41, 0x47, 0x41, 0x42]);
    const file = concat([head, mp3, tail]);
    const idx = await scanMp3(bufferSource(file));
    const out = await blobBytes(await applyGain(bufferSource(file), idx, 2));
    expect([...out.subarray(0, head.length)]).toEqual([...head]);
    expect([...out.subarray(out.length - 128)]).toEqual([...tail]);
  });

  it('replaces big tags with a small one in the same pass', async () => {
    const mp3 = stereoMp3();
    const cover = new Uint8Array(300_000);
    cover.set([0xff, 0xd8, 0xff, 0xe0]);
    const w = new ID3Writer(new ArrayBuffer(0));
    w.setFrame('TIT2', 'Alt').setFrame('APIC', { type: 3, data: cover.buffer, description: 'Cover' });
    const big = new Uint8Array(w.addTag());
    const v1 = new Uint8Array(128);
    v1.set([0x54, 0x41, 0x47]);
    const file = concat([big, new Uint8Array(77), mp3, v1]); // junk before the first frame, ID3v1 at the end
    const src = fileSource(new Blob([file as BlobPart]), 'a.mp3');
    const layout = await measureTags(src);
    expect(tagBytes(layout)).toBe(big.length + 128);
    const idx = await scanMp3(src);
    const small = buildSmallId3({ title: 'Kapitel 1', album: 'Buch', track: 1 });
    const out = await blobBytes(await applyGain(src, idx, 2, { tag: small }));
    expect(out.length).toBe(small.length + (idx.audioEnd - idx.audioStart));
    expect(parseId3v2(out)?.tags).toEqual({ title: 'Kapitel 1', album: 'Buch', track: '1' });
    expect(parseId3v2(out)?.pictures).toEqual([]);
    const idx2 = await scanMp3(bufferSource(out));
    expect(idx2).toMatchObject({ audioStart: small.length, frameCount: idx.frameCount, audioEnd: out.length });
    expect(allGains(out, idx2)).toEqual(allGains(file, idx).map((g) => g.map((v) => v + 2)));
    // No tag at all, and the plain copy without gain.
    const bare = await blobBytes(await applyGain(src, idx, 0, { tag: null }));
    expect(bare).toEqual(file.subarray(idx.audioStart, idx.audioEnd));
    const copy = await blobBytes(await replaceTags(src, small, layout));
    expect(copy.subarray(0, small.length)).toEqual(small);
    expect((await measureTags(bufferSource(copy))).audioEnd).toBe(copy.length);
    expect(await scanMp3(bufferSource(copy))).toMatchObject({ frameCount: idx.frameCount });
  });

  it('keeps a long book out of the JS heap when it reads it piece by piece (desktop)', async () => {
    const book = concat(Array.from({ length: 512 }, () => stereoMp3())); // about 24 MB
    const src = bufferSource(book, 'Buch.mp3'); // no Blob behind it, as on the desktop
    const idx = await scanMp3(src);
    const small = buildSmallId3({ title: 'Buch' });
    let out: Blob | undefined;
    expect(await rawBytesPerBlob(async () => (out = await applyGain(src, idx, 2, { tag: small })))).toBeLessThan(12 << 20);
    expect(out?.size).toBe(small.length + book.length);
    let copy: Blob | undefined;
    expect(await rawBytesPerBlob(async () => (copy = await replaceTags(src, small)))).toBeLessThan(12 << 20);
    expect(Buffer.compare(Buffer.from(await blobBytes(copy!)), Buffer.from(concat([small, book])))).toBe(0);
  });

  it('recomputes valid CRCs and leaves broken ones broken', async () => {
    const file = withCrc(monoMp3());
    const idx = await scanMp3(bufferSource(file));
    // Break the CRC of frame 5 on purpose.
    const broken = file.slice();
    broken[idx.frameOffsets[5] + 4] ^= 0xff;
    const out = await blobBytes(await applyGain(bufferSource(broken), idx, 7));
    let checked = 0;
    for (let k = 0; k < idx.frameCount; k++) {
      const o = idx.frameOffsets[k];
      const h = decodeHeader(readU32(out, o))!;
      if (!h.crc) continue;
      const stored = (out[o + 4] << 8) | out[o + 5];
      const valid = referenceCrc(protectedBits(out, o, h.sideInfoSize)) === stored;
      expect(valid).toBe(k !== 5);
      checked++;
    }
    expect(checked).toBeGreaterThan(idx.frameCount * 0.9);
    const a = await decodeMp3(file, false);
    const b = await decodeMp3(out, false);
    expect(rmsDb(b.channelData[0]) - rmsDb(a.channelData[0])).toBeCloseTo(7 * GAIN_STEP_DB, 1);
  });

  it('clamps at 0 and 255 and reports it', () => {
    const f = new Uint8Array(208);
    f.set([0xff, 0xfb, 0x50, 0xc4]);
    writeBits(f, 32 + 39, 8, 253);
    writeBits(f, 32 + 98, 8, 2);
    expect(adjustFrameGain(f, 0, 5)).toBe(1);
    expect(readGlobalGains(f, 0)).toEqual([255, 7]);
    expect(adjustFrameGain(f, 0, -10)).toBe(1);
    expect(readGlobalGains(f, 0)).toEqual([245, 0]);
  });

  it('computes steps for a loudness target', () => {
    expect(stepsForTarget(-30, -20)).toBe(7);
    expect(stepsForTarget(-14, -20)).toBe(-4);
    expect(stepsForTarget(-20.5, -20)).toBe(0);
    expect(stepsForTarget(Number.NEGATIVE_INFINITY, -20)).toBe(0);
    expect(GAIN_STEP_DB).toBeCloseTo(1.50515, 5);
  });

  it('rejects Layer II', async () => {
    const frame = new Uint8Array(576);
    frame.set([0xff, 0xfd, 0xa4, 0x04]);
    const file = concat(Array.from({ length: 10 }, () => frame));
    const idx = await scanMp3(bufferSource(file));
    await expect(applyGain(bufferSource(file), idx, 1)).rejects.toMatchObject({ code: 'unsupported-layer' });
  });
});
