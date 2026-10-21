import { describe, expect, it } from 'vitest';
import { buildSmallId3 } from '../../src/core/audio/id3';
import { buildXingFrame } from '../../src/core/audio/mp3cut';
import {
  checkMp3,
  decodeHeader,
  decodedTooShort,
  frameAtTime,
  frameLengthFor,
  isDamagedMp3,
  leadingTrimSamples,
  looksJoined,
  mp3DurationOf,
  mp3DurationSec,
  parseFrameHeader,
  probeMp3,
  readU32,
  rebuildReason,
  scanMp3,
  timeOfFrame,
} from '../../src/core/audio/mp3frames';
import { Mp3PcmReader, rateChangeAt } from '../../src/core/audio/mp3decode';
import { readAllPcm } from '../../src/core/audio/pcm';
import { bufferSource } from '../../src/core/audio/source';
import type { ByteSource } from '../../src/platform/types';
import { lsfMp3, mono96Mp3, monoMp3, SR, stereoMp3, withInfoFrame } from './fixtures';
import { concat, decodeMp3, encodeMp3, synth } from './helpers';

function frameBytes(mp3: Uint8Array, offsets: ArrayLike<number>, i: number): Uint8Array {
  const h = decodeHeader(readU32(mp3, offsets[i]));
  if (!h) throw new Error('bad frame');
  return mp3.subarray(offsets[i], offsets[i] + h.frameLength);
}

/** Real audio work: a test takes a second or two alone, much longer while the whole suite keeps the machine busy. */
const SLOW = { timeout: 30_000 };

describe('MPEG frame headers', () => {
  it('decodes versions, layers and frame lengths', () => {
    const h = decodeHeader(0xfffb9064);
    expect(h).toMatchObject({ version: 1, layer: 3, bitrateKbps: 128, sampleRate: 44100, frameLength: 417, channels: 2, crc: false, sideInfoSize: 32 });
    expect(decodeHeader(0xfffb9264)?.frameLength).toBe(418); // padding
    expect(decodeHeader(0xfff340c4)).toMatchObject({ version: 2, sampleRate: 22050, bitrateKbps: 32, samplesPerFrame: 576, frameLength: 104, channels: 1, sideInfoSize: 9 });
    expect(decodeHeader(0xffe340c4)).toMatchObject({ version: 2.5, sampleRate: 11025, samplesPerFrame: 576 });
    expect(decodeHeader(0xfffda404)).toMatchObject({ version: 1, layer: 2, bitrateKbps: 192, sampleRate: 48000, frameLength: 576 });
    expect(frameLengthFor(1, 1, 384, 32000, 0)).toBe(576);
    expect(decodeHeader(0xfffb0064)).toBeNull(); // free format
    expect(decodeHeader(0xfffbf064)).toBeNull(); // bad bitrate
    expect(decodeHeader(0xfffb9c64)).toBeNull(); // reserved sample rate
    expect(decodeHeader(0xffeb9064)).toBeNull(); // reserved version
    expect(decodeHeader(0xfff99064)).toBeNull(); // reserved layer
    expect(decodeHeader(0xfffb9066)).toBeNull(); // reserved emphasis
    expect(parseFrameHeader(new Uint8Array([0xff, 0xfb, 0x90]), 0)).toBeNull();
  });
});

describe('scanMp3', SLOW, () => {
  it('indexes a CBR file like the decoder sees it', async () => {
    const mp3 = monoMp3();
    const idx = await scanMp3(bufferSource(mp3));
    const dec = await decodeMp3(mp3);
    expect(idx.frameCount).toBe(dec.samplesDecoded / 1152);
    expect(idx).toMatchObject({ sampleRate: SR, channels: 1, version: 1, layer: 3, cbr: true, bitrateKbps: 64, junkBytes: 0, audioStart: 0, audioEnd: mp3.length });
    expect(idx.durationSec).toBeCloseTo(dec.samplesDecoded / SR, 6);
    expect(idx.avgBitrateKbps).toBeCloseTo(64, 0);
    expect(idx.xing).toBeUndefined();
    expect(idx.frameOffsets[0]).toBe(0);
    expect(idx.frameOffsets).toBeInstanceOf(Uint32Array);
  });

  it('handles stereo and MPEG2 streams', async () => {
    const st = await scanMp3(bufferSource(stereoMp3()));
    expect(st).toMatchObject({ channels: 2, sampleRate: 44100, bitrateKbps: 128, samplesPerFrame: 1152 });
    const lsf = await scanMp3(bufferSource(lsfMp3()));
    expect(lsf).toMatchObject({ version: 2, channels: 1, sampleRate: 22050, samplesPerFrame: 576, bitrateKbps: 32 });
    const dec = await decodeMp3(lsfMp3());
    expect(lsf.frameCount * 576).toBe(dec.samplesDecoded);
  });

  it('skips tags and junk and resynchronises', async () => {
    const mp3 = monoMp3();
    const ref = await scanMp3(bufferSource(mp3));
    const tag = buildSmallId3({ title: 'Kapitel 1', artist: 'Erzähler' }, { padding: 100 });
    // Junk with false sync bytes that do not form a chain.
    const junk1 = new Uint8Array(1234).map((_, i) => (i % 97 === 0 ? 0xff : (i * 31) & 0xfb));
    const junk2 = new Uint8Array(333).fill(0xff);
    const split = ref.frameOffsets[200];
    const ape = new Uint8Array(64);
    const apeFooter = [...'APETAGEX'].map((c) => c.charCodeAt(0));
    ape.set(apeFooter, 32); // footer at the end of the block
    new DataView(ape.buffer).setUint32(32 + 8, 2000, true); // version
    new DataView(ape.buffer).setUint32(32 + 12, 32, true); // size without header
    new DataView(ape.buffer).setUint32(32 + 20, 0x80000000, true); // has header
    ape.set(apeFooter, 0);
    const id3v1 = new Uint8Array(128);
    id3v1.set([0x54, 0x41, 0x47]);
    const file = concat([tag, junk1, mp3.subarray(0, split), junk2, mp3.subarray(split), ape, id3v1]);
    const idx = await scanMp3(bufferSource(file));
    expect(idx.frameCount).toBe(ref.frameCount);
    expect(idx.tags.id3v2[0]).toMatchObject({ offset: 0, size: tag.length });
    expect(idx.tags.ape).toEqual({ offset: file.length - 128 - 64, size: 64 });
    expect(idx.tags.id3v1).toEqual({ offset: file.length - 128, size: 128 });
    expect(idx.audioStart).toBe(tag.length + junk1.length);
    expect(idx.audioEnd).toBe(file.length - 128 - 64);
    expect(idx.junkBytes).toBe(junk1.length + junk2.length);
    expect(idx.frameOffsets[200]).toBe(tag.length + junk1.length + split + junk2.length);
    // Same result with tiny read windows (chunk boundaries everywhere).
    const small = await scanMp3(bufferSource(file), { chunkSize: 100 });
    expect([...small.frameOffsets]).toEqual([...idx.frameOffsets]);
  });

  it('drops a truncated last frame and stops at trailing garbage', async () => {
    const mp3 = monoMp3();
    const ref = await scanMp3(bufferSource(mp3));
    const cut = await scanMp3(bufferSource(mp3.subarray(0, mp3.length - 50)));
    expect(cut.frameCount).toBe(ref.frameCount - 1);
    const garbage = await scanMp3(bufferSource(concat([mp3, new Uint8Array(500).fill(0x55)])));
    expect(garbage.frameCount).toBe(ref.frameCount);
    expect(garbage.audioEnd).toBe(mp3.length);
  });

  it('excludes the Xing/Info frame and applies LAME delay and padding', async () => {
    const mp3 = monoMp3();
    const ref = await scanMp3(bufferSource(mp3));
    const info = buildXingFrame({ version: 1, sampleRate: SR, channelMode: 3, bitrateKbps: 64 }, { kind: 'Info', frames: ref.frameCount, audioBytes: mp3.length });
    const xingAt = 4 + 17;
    const lameAt = xingAt + 120;
    const withLame = info.slice();
    [...'LAME3.100'].forEach((c, i) => (withLame[lameAt + i] = c.charCodeAt(0)));
    const delay = 576;
    const padding = 1500;
    withLame[lameAt + 21] = delay >> 4;
    withLame[lameAt + 22] = ((delay & 15) << 4) | (padding >> 8);
    withLame[lameAt + 23] = padding & 0xff;
    const file = concat([withLame, mp3]);
    const idx = await scanMp3(bufferSource(file));
    expect(idx.frameCount).toBe(ref.frameCount);
    expect(idx.xing).toMatchObject({ kind: 'Info', frames: ref.frameCount, bytes: info.length + mp3.length, offset: 0 });
    expect(idx.lame).toEqual({ encoder: 'LAME3.100', encoderDelay: delay, padding });
    expect(idx.frameOffsets[0]).toBe(info.length);
    expect(idx.durationSec).toBeCloseTo((ref.frameCount * 1152 - delay - padding) / SR, 9);
    // mpg123 trims exactly the same amount (gapless decoding).
    const dec = await decodeMp3(file, true);
    expect(dec.samplesDecoded).toBe(ref.frameCount * 1152 - delay - padding);
    expect(leadingTrimSamples(idx)).toBe(delay + 529);
    const probe = await probeMp3(bufferSource(file));
    expect(probe.durationSec).toBeCloseTo(idx.durationSec, 9);
  });

  it('maps times to frame boundaries', async () => {
    const idx = await scanMp3(bufferSource(monoMp3()));
    expect(frameAtTime(idx, 0)).toBe(0);
    expect(frameAtTime(idx, 1)).toBe(Math.round(SR / 1152));
    expect(frameAtTime(idx, 1e9)).toBe(idx.frameCount);
    expect(timeOfFrame(idx, 100)).toBeCloseTo((100 * 1152) / SR, 9);
  });

  it('rejects free-format and non-MP3 data with German messages', async () => {
    const free = new Uint8Array(300 * 40);
    for (let i = 0; i < 40; i++) free.set([0xff, 0xfb, 0x00, 0xc4], i * 300);
    await expect(scanMp3(bufferSource(free))).rejects.toMatchObject({ code: 'free-format' });
    const noise = new Uint8Array(20000).map((_, i) => (i * 7919) & 0xff);
    await expect(scanMp3(bufferSource(noise))).rejects.toMatchObject({ code: 'not-mp3', message: expect.stringContaining('MP3') });
    await expect(scanMp3(bufferSource(new Uint8Array(0)))).rejects.toMatchObject({ code: 'not-mp3' });
  });

  it('blames broken data, not the rare free format, for a single header that only looks like one', async () => {
    // Any data holds such byte pairs now and then: one alone, or two at odd distances, is no stream.
    const junk = new Uint8Array(50_000).map((_, i) => (i * 7919) & 0x7f);
    junk.set([0xff, 0xfb, 0x00, 0xc4], 1000);
    junk.set([0xff, 0xfb, 0x00, 0xc4], 1300);
    junk.set([0xff, 0xfb, 0x00, 0xc4], 9000);
    await expect(scanMp3(bufferSource(junk))).rejects.toMatchObject({ code: 'not-mp3', message: expect.stringContaining('beschädigt') });
    // Three at the same distance are a free-format stream.
    junk.set([0xff, 0xfb, 0x00, 0xc4], 1600);
    await expect(scanMp3(bufferSource(junk))).rejects.toMatchObject({ code: 'free-format' });
  });

  it('reports progress and can be aborted', async () => {
    const mp3 = concat([monoMp3(), monoMp3()]);
    const seen: number[] = [];
    await scanMp3(bufferSource(mp3), { chunkSize: 4096, onProgress: (f) => seen.push(f) });
    expect(seen.length).toBeGreaterThan(3);
    expect(seen[seen.length - 1]).toBe(1);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(scanMp3(bufferSource(mp3), { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects a stream that changes its format halfway instead of dropping the rest', async () => {
    const tag = buildSmallId3({ title: 'Kapitel 2' });
    const mixed = [
      concat([monoMp3(), stereoMp3()]), // mono intro, stereo chapters
      concat([stereoMp3(), tag, monoMp3()]), // joined files with a tag in between
      concat([monoMp3(), lsfMp3(), monoMp3()]), // another sample rate in the middle
    ];
    for (const file of mixed) await expect(scanMp3(bufferSource(file))).rejects.toMatchObject({ code: 'mixed-format', message: expect.stringContaining('MP3') });
    // The same format after a tag still goes on.
    const same = await scanMp3(bufferSource(concat([monoMp3(), tag, mono96Mp3()])));
    expect(same.frameCount).toBe((await scanMp3(bufferSource(monoMp3()))).frameCount + (await scanMp3(bufferSource(mono96Mp3()))).frameCount);
  });

  it('plays MP3s joined byte for byte to the end, as mpg123 does', async () => {
    const one = monoMp3();
    const frames = (await scanMp3(bufferSource(one))).frameCount;
    const joined = concat([withInfoFrame(one, frames), withInfoFrame(one, frames), withInfoFrame(one, frames)]);
    const idx = await scanMp3(bufferSource(joined));
    expect(idx.xing?.frames).toBe(frames); // the first part's Info frame
    const dec = await decodeMp3(joined, true);
    expect(Math.round(idx.durationSec * SR)).toBe(dec.samplesDecoded);
    expect(idx.durationSec).toBeGreaterThan(35);
  });

  it('measures the playing time when the header tells none or only that of the first part', async () => {
    const one = monoMp3();
    const frames = (await scanMp3(bufferSource(one))).frameCount;
    const first = withInfoFrame(one, frames);
    const joined = concat([first, first, first]);
    const tagged = (await scanMp3(bufferSource(first))).durationSec; // what the tags of the joined file say
    expect(await mp3DurationSec(bufferSource(joined), tagged)).toBeCloseTo((await scanMp3(bufferSource(joined))).durationSec, 9);
    // VBR without a Xing frame: the tags tell no time.
    const vbr = concat([one, mono96Mp3(), one]);
    expect(await mp3DurationSec(bufferSource(vbr), undefined)).toBeCloseTo((await scanMp3(bufferSource(vbr))).durationSec, 9);
    // A header that covers the file is trusted without reading all of it.
    let read = 0;
    const counting: ByteSource = { name: 'a.mp3', size: first.length, read: async (start, length) => ((read += length), first.subarray(start, start + length)) };
    expect(await mp3DurationSec(counting, 11.5)).toBe(11.5);
    expect(read).toBeLessThan(first.length / 2);
  });

  it('does not trust a length from the tags of a VBR file without a Xing frame', async () => {
    // Tags and browsers guess the length of such a file from its first frame.
    const one = monoMp3();
    const vbr = concat([one, mono96Mp3(), mono96Mp3(), one]);
    const real = (await scanMp3(bufferSource(vbr))).durationSec;
    const guessed = (vbr.length * 8) / 64000;
    expect(guessed - real).toBeGreaterThan(1);
    expect(await mp3DurationSec(bufferSource(vbr), guessed)).toBeCloseTo(real, 9);
    const index = (await checkMp3(bufferSource(vbr))).index!;
    expect(mp3DurationOf(index, guessed)).toBeCloseTo(real, 9);
  });

  it('takes the length of a constant bitrate from the file size, reading only a few places', async () => {
    const one = monoMp3();
    const real = (await scanMp3(bufferSource(one))).durationSec;
    let read = 0;
    const counting: ByteSource = { name: 'a.mp3', size: one.length, read: async (start, length) => ((read += length), one.subarray(start, start + length)) };
    // The tags agree: kept as they are.
    expect(await mp3DurationSec(counting, real - 0.2)).toBe(real - 0.2);
    expect(read).toBeLessThan(one.length / 2);
    // The tags are far off: the size tells.
    expect(await mp3DurationSec(bufferSource(one), real + 30)).toBeCloseTo(real, 1);
    expect(await mp3DurationSec(bufferSource(one), undefined)).toBeCloseTo(real, 1);
  });

  it('keeps frame data untouched (offsets point to real frames)', async () => {
    const mp3 = stereoMp3();
    const idx = await scanMp3(bufferSource(mp3));
    let total = 0;
    for (let i = 0; i < idx.frameCount; i++) total += frameBytes(mp3, idx.frameOffsets, i).length;
    expect(total).toBe(idx.audioBytes);
    expect(total).toBe(mp3.length);
  });
});

/** Bytes that never form a chain of frame headers. */
function garbage(n: number): Uint8Array {
  return new Uint8Array(n).map((_, i) => (i % 89 === 0 ? 0xff : (i * 37 + 11) & 0x7f));
}

/** ID3v2 at the start, then the audio, APE and ID3v1 at the end: a normal tagged download. */
function fullyTagged(mp3: Uint8Array): Uint8Array {
  const tag = buildSmallId3({ title: 'Kapitel 1', artist: 'Erzähler' }, { padding: 2000 });
  const ape = new Uint8Array(64);
  const apeMagic = [...'APETAGEX'].map((c) => c.charCodeAt(0));
  ape.set(apeMagic, 0);
  ape.set(apeMagic, 32);
  for (const at of [0, 32]) {
    new DataView(ape.buffer).setUint32(at + 8, 2000, true);
    new DataView(ape.buffer).setUint32(at + 12, 32, true);
    new DataView(ape.buffer).setUint32(at + 20, 0x80000000, true);
  }
  const id3v1 = new Uint8Array(128);
  id3v1.set([0x54, 0x41, 0x47]);
  return concat([tag, mp3, ape, id3v1]);
}

describe('damaged and joined MP3s', SLOW, () => {
  it('counts junk and resyncs only inside the audio', async () => {
    const mp3 = monoMp3();
    const clean = await scanMp3(bufferSource(fullyTagged(mp3)));
    expect(clean).toMatchObject({ innerJunkBytes: 0, resyncs: 0, innerTags: 0 });
    expect(isDamagedMp3(clean)).toBe(false);
    expect(looksJoined(clean)).toBe(false);

    const ref = await scanMp3(bufferSource(mp3));
    const split = ref.frameOffsets[200];
    const broken = await scanMp3(bufferSource(concat([mp3.subarray(0, split), garbage(5000), mp3.subarray(split)])));
    expect(broken.resyncs).toBe(1);
    expect(broken.innerJunkBytes).toBeGreaterThanOrEqual(5000);
    expect(broken.innerJunkBytes).toBeLessThan(5000 + 2 * 417);
    expect(isDamagedMp3(broken)).toBe(true);
    expect(rebuildReason(broken)).toBe('damaged');

    // Only junk in front of the first frame (a tag with a wrong size): nothing inside.
    const lead = await scanMp3(bufferSource(concat([garbage(3000), mp3])));
    expect(lead).toMatchObject({ innerJunkBytes: 0, resyncs: 0 });
    expect(lead.junkBytes).toBeGreaterThan(2000);
    expect(rebuildReason(lead)).toBeUndefined();

    // Small holes in two places count as damage too.
    const twice = await scanMp3(bufferSource(concat([mp3.subarray(0, ref.frameOffsets[100]), garbage(300), mp3.subarray(ref.frameOffsets[100], split), garbage(300), mp3.subarray(split)])));
    expect(twice.resyncs).toBe(2);
    expect(twice.innerJunkBytes).toBeLessThan(1024);
    expect(isDamagedMp3(twice)).toBe(true);
  });

  it('finds the seams of joined files', async () => {
    const one = monoMp3();
    const frames = (await scanMp3(bufferSource(one))).frameCount;
    // Two LAME files joined byte for byte: the first Info frame counts half.
    const lame = await scanMp3(bufferSource(concat([withInfoFrame(one, frames), withInfoFrame(one, frames)])));
    expect(looksJoined(lame)).toBe(true);
    expect(rebuildReason(lame)).toBe('joined');
    // Two tagged files: the second tag sits between the frames.
    const tag = buildSmallId3({ title: 'Kapitel 2' }, { padding: 1500 });
    const tagged = await scanMp3(bufferSource(concat([tag, one, tag, one])));
    expect(tagged).toMatchObject({ resyncs: 1, innerTags: 1 });
    expect(tagged.innerJunkBytes).toBe(tag.length);
    expect(rebuildReason(tagged)).toBe('joined');
    // A different sample rate after the first part: the frame index cannot hold it, the check calls it joined.
    await expect(scanMp3(bufferSource(concat([one, lsfMp3()])))).rejects.toMatchObject({ code: 'mixed-format' });
    expect((await checkMp3(bufferSource(concat([one, lsfMp3()])))).check).toEqual({ rebuild: 'joined' });
    // copy /b of two files with a small tag each (as ffmpeg writes it) and no Info frame: the tag alone gives the seam away.
    const small = buildSmallId3({ title: 'A' }, { padding: 0 });
    expect(small.length).toBeLessThan(100);
    const plain = await scanMp3(bufferSource(concat([small, one, small, one])));
    expect(plain).toMatchObject({ resyncs: 1, innerTags: 1, innerJunkBytes: small.length });
    expect(looksJoined(plain)).toBe(true);
    expect(rebuildReason(plain)).toBe('joined');
    // A cut-off download keeps an Info frame that counts more frames than are there: not joined.
    const cut = await scanMp3(bufferSource(withInfoFrame(one.subarray(0, one.length >> 1), frames)));
    expect(looksJoined(cut)).toBe(false);
  });

  it('leaves a file alone whose frames are whole, whatever follows them', async () => {
    const one = monoMp3();
    const id3v1 = new Uint8Array(128);
    id3v1.set([0x54, 0x41, 0x47]);
    // An old text block (MusicMatch style) or zero bytes between the last frame and the ID3v1 tag.
    const block = new Uint8Array(6144).fill(0x20);
    block.set(new TextEncoder().encode('18273645Brava Software Inc.'), 0);
    for (const tail of [block, new Uint8Array(8192)]) {
      const idx = await scanMp3(bufferSource(concat([one, tail, id3v1])));
      expect(idx).toMatchObject({ innerJunkBytes: 0, resyncs: 0, innerTags: 0 });
      expect(idx.tags.audioEnd - idx.audioEnd).toBeGreaterThan(4096);
      expect(rebuildReason(idx)).toBeUndefined();
    }
    expect((await checkMp3(bufferSource(concat([one, block, id3v1])))).check.rebuild).toBeUndefined();
  });

  it('counts frames a decoder had to drop as damage', async () => {
    const idx = await scanMp3(bufferSource(monoMp3()));
    expect(isDamagedMp3(idx, { durationSec: idx.durationSec })).toBe(false);
    expect(isDamagedMp3(idx, { durationSec: idx.durationSec - 0.5 })).toBe(false);
    expect(isDamagedMp3(idx, { durationSec: idx.durationSec - 1.5 })).toBe(true);
    expect(decodedTooShort(3600, 3600 - 60)).toBe(false); // 2 % of an hour
    expect(decodedTooShort(3600, 3600 - 80)).toBe(true);
  });

  it('checks a whole file in one read, and tells its playing time', async () => {
    const one = monoMp3();
    const ok = await checkMp3(bufferSource(fullyTagged(one)));
    expect(ok.check.rebuild).toBeUndefined();
    expect(ok.check.durationSec).toBeCloseTo(12, 1);
    expect(mp3DurationOf(ok.index!, 11.9)).toBe(11.9);
    const frames = ok.index!.frameCount;
    const joined = await checkMp3(bufferSource(concat([withInfoFrame(one, frames), withInfoFrame(one, frames)])));
    expect(mp3DurationOf(joined.index!, 12)).toBeCloseTo(joined.index!.durationSec, 9);
    expect((await checkMp3(bufferSource(garbage(20000)))).check).toEqual({ rebuild: 'damaged' });
  });

  it('decodes a file joined from 44.1 and 48 kHz parts at its full length', async () => {
    const a = encodeMp3([synth(SR, [{ sec: 3, freq: 440, amp: 0.3 }])], SR, 128);
    const b = encodeMp3([synth(48000, [{ sec: 3, freq: 660, amp: 0.3 }])], 48000, 128);
    const joined = concat([a, b]);
    expect(rateChangeAt(joined, SR)).toEqual({ at: a.length, rate: 48000 });
    expect(rateChangeAt(a, SR)).toBeNull();
    // mpg123 alone reports one rate for the whole call, and the 44.1 kHz part comes out too short.
    const plain = await decodeMp3(joined);
    expect(plain.samplesDecoded / plain.sampleRate).toBeLessThan(5.9);
    for (const chunkSize of [1 << 20, 3000]) {
      const reader = await Mp3PcmReader.open(bufferSource(joined), { chunkSize });
      try {
        const pcm = await readAllPcm(reader);
        expect(reader.sampleRate).toBe(SR);
        expect(pcm[0].length / SR).toBeGreaterThan(5.95);
        expect(pcm[0].length / SR).toBeLessThan(6.1);
      } finally {
        await reader.close();
      }
    }
  });
});
