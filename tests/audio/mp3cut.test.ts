import { describe, expect, it } from 'vitest';
import { readBits } from '../../src/core/audio/bits';
import { buildSmallId3, parseId3v2 } from '../../src/core/audio/id3';
import { buildXingFrame, cutMp3, cutMp3Parts, snapCuts } from '../../src/core/audio/mp3cut';
import { applyGain } from '../../src/core/audio/mp3gain';
import { decodeHeader, parseXingFrame, readU32, scanMp3, type MpegVersion } from '../../src/core/audio/mp3frames';
import { loadMp3Encoder, Mp3StreamEncoder } from '../../src/core/audio/mp3encoder';
import { bufferSource } from '../../src/core/audio/source';
import { BURSTS, lsfMp3, mono96Mp3, monoMp3, SR, stereoMp3 } from './fixtures';
import { blobBytes, concat, decodeMp3, makeReservoirStream, rmsDb, synth } from './helpers';

await loadMp3Encoder();

/** Hides the Xing/Info magic so that decoders play the tag frame as an ordinary (silent) frame. */
function hideXingMagic(part: Uint8Array): Uint8Array {
  const out = part.slice();
  for (let i = 0; i + 4 <= 64; i++) {
    const m = String.fromCharCode(out[i], out[i + 1], out[i + 2], out[i + 3]);
    if (m === 'Info' || m === 'Xing') out.set([0x58, 0x58, 0x58, 0x58], i);
  }
  return out;
}

/** Real audio work: a test takes a second or two alone, much longer while the whole suite keeps the machine busy. */
const SLOW = { timeout: 30_000 };

describe('buildXingFrame', () => {
  it('builds valid silent tag frames for MPEG1/2/2.5, mono and stereo', () => {
    const cases: [MpegVersion, number, number][] = [
      [1, 44100, 3],
      [1, 48000, 1],
      [2, 22050, 3],
      [2, 24000, 0],
      [2.5, 11025, 3],
      [2.5, 8000, 1],
    ];
    for (const [version, sampleRate, channelMode] of cases) {
      const frame = buildXingFrame(
        { version, sampleRate, channelMode, bitrateKbps: 8 },
        { kind: 'Xing', frames: 1234, audioBytes: 100000, reservoir: new Uint8Array([1, 2, 3]) },
      );
      const h = decodeHeader(readU32(frame, 0));
      expect(h).toMatchObject({ version, sampleRate, channelMode, layer: 3, crc: false, frameLength: frame.length });
      const parsed = parseXingFrame(frame, h!, 0);
      expect(parsed?.xing).toMatchObject({ kind: 'Xing', frames: 1234, bytes: 100000 + frame.length });
      expect(parsed?.xing.toc?.length).toBe(100);
      // side information is all zero: a silent frame
      expect(frame.subarray(4, 4 + h!.sideInfoSize).every((b) => b === 0)).toBe(true);
      expect([...frame.subarray(frame.length - 3)]).toEqual([1, 2, 3]);
    }
  });

  it('keeps the CBR bitrate when the data fits and grows it otherwise', () => {
    const small = buildXingFrame({ version: 1, sampleRate: 44100, channelMode: 3, bitrateKbps: 64 }, { kind: 'Info', frames: 10, audioBytes: 2080 });
    expect(decodeHeader(readU32(small, 0))?.bitrateKbps).toBe(64);
    const big = buildXingFrame(
      { version: 1, sampleRate: 44100, channelMode: 3, bitrateKbps: 64 },
      { kind: 'Info', frames: 10, audioBytes: 2080, reservoir: new Uint8Array(300) },
    );
    expect(decodeHeader(readU32(big, 0))?.bitrateKbps).toBe(160); // 4 + 17 + 120 + 300 bytes > 64 and 128 kbps frames
  });
});

describe('cutMp3', SLOW, () => {
  it('splits at frame boundaries into parts that scan and decode correctly', async () => {
    const mp3 = monoMp3();
    const src = bufferSource(mp3);
    const idx = await scanMp3(src);
    const cuts = [2.5, 6.5, 9.5];
    const progress: number[] = [];
    const blobs = await cutMp3(src, idx, cuts, {
      tagFor: (i, n) => buildSmallId3({ title: `Teil ${i + 1} von ${n}`, album: 'Hörbuch', track: i + 1 }),
      onProgress: (f) => progress.push(f),
    });
    expect(blobs).toHaveLength(4);
    expect(progress[progress.length - 1]).toBe(1);
    const { frames, timesSec } = snapCuts(idx, cuts);
    const bounds = [0, ...frames, idx.frameCount];
    const orig = await decodeMp3(mp3, false);
    let totalFrames = 0;
    for (let i = 0; i < blobs.length; i++) {
      const bytes = await blobBytes(blobs[i]);
      expect(blobs[i].type).toBe('audio/mpeg');
      const tag = parseId3v2(bytes);
      expect(tag?.tags).toMatchObject({ title: `Teil ${i + 1} von 4`, album: 'Hörbuch', track: String(i + 1) });
      const part = await scanMp3(bufferSource(bytes));
      const n = bounds[i + 1] - bounds[i];
      expect(part.frameCount).toBe(n);
      expect(part.xing).toMatchObject({ kind: 'Info', frames: n, bytes: part.audioEnd - part.audioStart });
      expect(part.cbr).toBe(true);
      // mpg123 drops its decoder delay (529 samples) when an Info frame gives the frame count.
      expect(part.durationSec).toBeCloseTo((n * 1152 - 529) / SR, 9);
      totalFrames += n;
      // The frames are byte-identical to the original ones.
      const first = idx.frameOffsets[bounds[i]];
      expect([...bytes.subarray(part.frameOffsets[0], part.frameOffsets[0] + 50)]).toEqual([...mp3.subarray(first, first + 50)]);
      // mpg123 skips the Info frame and plays the part's frames.
      const dec = await decodeMp3(bytes, true);
      expect(dec.samplesDecoded).toBe(n * 1152 - 529);
      expect(dec.samplesDecoded / SR).toBeCloseTo(part.durationSec, 9);
      const a = bounds[i] * 1152 + 529;
      const len = dec.samplesDecoded;
      // Away from the first frame (MDCT overlap) the audio equals the original decode.
      const ref = orig.channelData[0].subarray(a + 1152, a + len);
      const got = dec.channelData[0].subarray(1152, len);
      let maxDiff = 0;
      for (let j = 0; j < ref.length; j++) maxDiff = Math.max(maxDiff, Math.abs(ref[j] - got[j]));
      expect(maxDiff).toBeLessThan(1e-6);
    }
    expect(totalFrames).toBe(idx.frameCount);
    // Cut positions land within half a frame of the request.
    timesSec.forEach((t, i) => expect(Math.abs(t - cuts[i])).toBeLessThanOrEqual(1152 / SR / 2 + 1e-9));
  });

  it('keeps the LAME encoder delay in the first part and the padding in the last', async () => {
    const enc = new Mp3StreamEncoder({ inputChannels: 1, sampleRate: SR, bitrateKbps: 64 });
    enc.push({ channels: [synth(SR, BURSTS)], sampleRate: SR });
    const frames = [...enc.takeOutput(), ...enc.finish()];
    const mp3 = concat([enc.infoFrame(), ...frames]);
    const src = bufferSource(mp3);
    const idx = await scanMp3(src);
    expect(idx.lame).toMatchObject({ encoderDelay: 576 });
    const parts = await Promise.all((await cutMp3(src, idx, [2.5, 6.5])).map(blobBytes));
    const scans = await Promise.all(parts.map((p) => scanMp3(bufferSource(p))));
    expect(scans.map((x) => [x.lame?.encoderDelay, x.lame?.padding])).toEqual([
      [576, 0],
      [0, 0],
      [0, idx.lame?.padding],
    ]);
    const whole = await decodeMp3(mp3);
    const decoded = await Promise.all(parts.map((p) => decodeMp3(p)));
    decoded.forEach((d, i) => expect(d.samplesDecoded / SR).toBeCloseTo(scans[i].durationSec, 9));
    // Gapless players drop 529 samples at the start of every later part, nothing else.
    expect(decoded.reduce((n, d) => n + d.samplesDecoded, 0)).toBe(whole.samplesDecoded - 2 * 529);
    const maxDiff = (a: Float32Array, b: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
    // The first part starts and the last part ends exactly where the original does.
    const first = decoded[0].channelData[0];
    expect(maxDiff(first.subarray(0, first.length - 1152), whole.channelData[0])).toBeLessThan(1e-6);
    const last = decoded[2].channelData[0];
    expect(maxDiff(last.subarray(2304), whole.channelData[0].subarray(whole.samplesDecoded - last.length + 2304))).toBeLessThan(1e-6);
  });

  it('ignores cuts outside the file and duplicates', async () => {
    const src = bufferSource(stereoMp3());
    const idx = await scanMp3(src);
    const blobs = await cutMp3(src, idx, [-5, 0, 1.5, 1.5, 1.5001, 99]);
    expect(blobs).toHaveLength(2);
    const p1 = await scanMp3(bufferSource(await blobBytes(blobs[0])));
    const p2 = await scanMp3(bufferSource(await blobBytes(blobs[1])));
    expect(p1.channels).toBe(2);
    expect(p1.frameCount + p2.frameCount).toBe(idx.frameCount);
    expect(Math.abs((p1.frameCount * 1152) / SR - 1.5)).toBeLessThanOrEqual(1152 / SR / 2);
    // no cuts: one part with a fresh Info frame
    const whole = await cutMp3(src, idx, []);
    expect(whole).toHaveLength(1);
    expect((await scanMp3(bufferSource(await blobBytes(whole[0])))).frameCount).toBe(idx.frameCount);
  });

  it('writes a Xing frame with a seek table for VBR streams and handles MPEG2', async () => {
    const vbr = concat([monoMp3(), mono96Mp3()]);
    const src = bufferSource(vbr);
    const idx = await scanMp3(src);
    expect(idx.cbr).toBe(false);
    const blobs = await cutMp3(src, idx, [11]);
    const last = await blobBytes(blobs[1]);
    const part = await scanMp3(bufferSource(last));
    expect(part.xing?.kind).toBe('Xing');
    expect(part.xing?.frames).toBe(part.frameCount);
    const toc = part.xing?.toc as Uint8Array;
    for (let i = 1; i < 100; i++) expect(toc[i]).toBeGreaterThanOrEqual(toc[i - 1]);
    // Seek table entry at 50 % points near the frame in the middle of the part.
    const mid = part.frameOffsets[Math.floor(part.frameCount / 2)] - part.audioStart;
    expect(Math.abs((toc[50] / 256) * (part.audioEnd - part.audioStart) - mid)).toBeLessThan(600);

    const lsf = bufferSource(lsfMp3());
    const lidx = await scanMp3(lsf);
    const parts = await cutMp3(lsf, lidx, [2]);
    const p = await scanMp3(bufferSource(await blobBytes(parts[1])));
    expect(p).toMatchObject({ version: 2, sampleRate: 22050, channels: 1 });
    expect(p.xing?.frames).toBe(p.frameCount);
  });

  it('copies the bit reservoir into the Xing/Info frame', async () => {
    const packed = makeReservoirStream(monoMp3());
    const original = await decodeMp3(monoMp3(), false);
    const repacked = await decodeMp3(packed, false);
    // Sanity: the repacked stream really uses the reservoir and decodes identically.
    let mdbSum = 0;
    for (let p = 0; p + 4 <= packed.length; ) {
      const h = decodeHeader(readU32(packed, p))!;
      mdbSum += readBits(packed, (p + 4) * 8, 9);
      p += h.frameLength;
    }
    expect(mdbSum).toBeGreaterThan(1000);
    expect(repacked.samplesDecoded).toBe(original.samplesDecoded);
    expect(rmsDb(repacked.channelData[0])).toBeCloseTo(rmsDb(original.channelData[0]), 6);

    const src = bufferSource(packed);
    const idx = await scanMp3(src);
    const cutAt = 4.0; // inside a tone: the reservoir matters
    const blobs = await cutMp3(src, idx, [cutAt]);
    const f0 = snapCuts(idx, [cutAt]).frames[0];
    const part = await blobBytes(blobs[1]);
    const mdb = readBits(packed, (idx.frameOffsets[f0] + 4) * 8, 9);
    expect(mdb).toBeGreaterThan(0);
    // A decoder that plays the tag frame (like the DFPlayer) finds the reservoir.
    const asAudio = await decodeMp3(hideXingMagic(part), false);
    const ref = original.channelData[0];
    const got = asAudio.channelData[0];
    // tag frame (silence) + first frame (missing MDCT overlap) differ; from then on exact
    let maxDiff = 0;
    for (let j = 2 * 1152; j < 12 * 1152; j++) maxDiff = Math.max(maxDiff, Math.abs(got[j] - ref[(f0 - 1) * 1152 + j]));
    expect(maxDiff).toBeLessThan(1e-6);
    // Without the copied reservoir the same frames would be wrong.
    const naive = hideXingMagic(part);
    const xingLen = decodeHeader(readU32(naive, 0))!.frameLength;
    naive.fill(0, xingLen - mdb, xingLen);
    const broken = await decodeMp3(naive, false);
    let brokenDiff = 0;
    for (let j = 1152; j < 3 * 1152; j++) brokenDiff = Math.max(brokenDiff, Math.abs(broken.channelData[0][j] - ref[(f0 - 1) * 1152 + j]));
    expect(brokenDiff).toBeGreaterThan(1e-3);
  });

  it('gathers reservoir bytes across several earlier frames', async () => {
    // Synthetic frames: MPEG1 mono 64 kbps, 187 bytes of main data each.
    const frames: Uint8Array[] = [];
    for (let k = 0; k < 30; k++) {
      const f = new Uint8Array(208);
      f.set([0xff, 0xfb, 0x50, 0xc4]);
      const mdb = Math.min(300, 187 * k); // never reaches before the stream start
      f[4] = mdb >> 1;
      f[5] = (mdb & 1) << 7;
      for (let i = 21; i < 208; i++) f[i] = (k * 37 + i) & 0xff;
      frames.push(f);
    }
    const file = concat(frames);
    const src = bufferSource(file);
    const idx = await scanMp3(src);
    expect(idx.frameCount).toBe(30);
    const blobs = await cutMp3(src, idx, [(10 * 1152) / SR]);
    const part = await blobBytes(blobs[1]);
    const xing = part.subarray(0, decodeHeader(readU32(part, 0))!.frameLength);
    const expected = concat([frames[8].subarray(208 - 113), frames[9].subarray(21)]);
    expect([...xing.subarray(xing.length - 300)]).toEqual([...expected]);
    // The first part needs no reservoir and keeps the stream bitrate.
    const first = await blobBytes(blobs[0]);
    expect(decodeHeader(readU32(first, 0))?.bitrateKbps).toBe(64);
  });

  it('hands out the parts one by one and changes the gain on the way', async () => {
    const original = monoMp3().slice();
    const src = bufferSource(monoMp3());
    const index = await scanMp3(src);
    const cuts = [2.5, 6.5, 9.5];
    const gained = await blobBytes(await applyGain(src, index, -3));
    const expected = await cutMp3(bufferSource(gained), await scanMp3(bufferSource(gained)), cuts);
    const parts: Uint8Array[] = [];
    for await (const part of cutMp3Parts(src, index, cuts, { gainSteps: -3 })) parts.push(await blobBytes(part));
    expect(parts).toHaveLength(4);
    for (const [i, part] of parts.entries()) expect(part).toEqual(await blobBytes(expected[i]));
    expect(monoMp3()).toEqual(original); // the source bytes are not touched
  });

  it('rejects Layer II files', async () => {
    const frame = new Uint8Array(576);
    frame.set([0xff, 0xfd, 0xa4, 0x04]);
    const file = concat(Array.from({ length: 10 }, () => frame));
    const idx = await scanMp3(bufferSource(file));
    expect(idx.layer).toBe(2);
    await expect(cutMp3(bufferSource(file), idx, [0.1])).rejects.toMatchObject({ code: 'unsupported-layer' });
  });
});
