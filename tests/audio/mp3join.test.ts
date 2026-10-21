import { describe, expect, it } from 'vitest';
import type { AudioBackend } from '../../src/platform/types';
import { analyzeAudio, openAudio } from '../../src/core/audio/decode';
import { AudioError } from '../../src/core/audio/errors';
import { buildSmallId3, parseId3v2 } from '../../src/core/audio/id3';
import { cutMp3 } from '../../src/core/audio/mp3cut';
import { loadMp3Encoder, Mp3StreamEncoder } from '../../src/core/audio/mp3encoder';
import { decodeHeader, readU32, scanMp3, type Mp3Index } from '../../src/core/audio/mp3frames';
import { bridgeFrame, joinMp3, joinProblem, mergeMp3Files } from '../../src/core/audio/mp3join';
import { bufferSource } from '../../src/core/audio/source';
import { encodeWav16 } from '../../src/core/audio/wav';
import { mono96Mp3, monoMp3, SR, stereoMp3 } from './fixtures';
import { blobBytes, concat, decodeMp3, makeReservoirStream, synth, type Segment } from './helpers';

await loadMp3Encoder();

const SLOW = { timeout: 30_000 };

/** A chapter as LAME writes it: Info frame with encoder delay and padding, then the frames. */
function chapter(segments: Segment[], kbps = 64): Uint8Array {
  const enc = new Mp3StreamEncoder({ inputChannels: 1, sampleRate: SR, bitrateKbps: kbps });
  enc.push({ channels: [synth(SR, segments)], sampleRate: SR });
  const frames = [...enc.takeOutput(), ...enc.finish()];
  return concat([enc.infoFrame(), ...frames]);
}

/** A big ID3 tag with a picture in front, as shops deliver chapters. */
function tagged(mp3: Uint8Array, title: string): Uint8Array {
  return concat([buildSmallId3({ title, comment: 'x'.repeat(3000) }), mp3]);
}

async function inputs(files: Uint8Array[]): Promise<{ source: ReturnType<typeof bufferSource>; index: Mp3Index }[]> {
  return Promise.all(files.map(async (f, i) => ({ source: bufferSource(f, `${i}.mp3`), index: await scanMp3(bufferSource(f)) })));
}

/** The bytes of all audio frames of a file, without tags and tag frame. */
function frameBytes(file: Uint8Array, index: Mp3Index): Uint8Array {
  return file.subarray(index.frameOffsets[0], index.audioEnd);
}

function nodeBackend(): AudioBackend {
  return {
    analyze: (input, onProgress, signal) => analyzeAudio(input, { onProgress, signal, env: { webCodecs: null } }),
    openPcm: async (input, opts) => (await openAudio(input, { targetSampleRate: opts?.targetSampleRate, env: { webCodecs: null } })).reader,
  };
}

describe('joinProblem', () => {
  const like = { layer: 3, version: 1, sampleRate: 44100, channels: 1 } as const;
  it('allows the same format and names what differs', () => {
    expect(joinProblem([like, like])).toBeNull();
    expect(joinProblem([])).toBeNull();
    expect(joinProblem([like, { ...like, channels: 2 }])).toBe('format');
    expect(joinProblem([like, { ...like, sampleRate: 48000 }])).toBe('format');
    expect(joinProblem([like, { ...like, version: 2 }])).toBe('format');
    expect(joinProblem([like, { ...like, layer: 2 }])).toBe('layer');
  });
});

describe('joinMp3', SLOW, () => {
  it('puts the frames one after the other behind one tag and one Info frame', async () => {
    const a = tagged(chapter([{ sec: 2, freq: 440 }, { sec: 0.5 }]), 'Kapitel 1');
    const b = tagged(chapter([{ sec: 0.5 }, { sec: 3, freq: 660 }]), 'Kapitel 2');
    const parts = await inputs([a, b]);
    const tag = buildSmallId3({ title: 'Folge 1', artist: 'Erzähler' });
    const steps: number[] = [];
    const joined = await joinMp3(parts, { tag, onProgress: (f) => steps.push(f) });
    const out = await blobBytes(joined.blob);
    expect(joined.bridges).toBe(0);

    // One small tag in front: the title given, nothing of the chapters' big tags.
    const t = parseId3v2(out)!;
    expect(t.tags.title).toBe('Folge 1');
    expect(t.size).toBe(tag.length);
    expect(out.length).toBeLessThan(a.length + b.length - 6000);

    // The Info frame counts every frame and every byte, the frames are those of the chapters, byte for byte.
    const idx = await scanMp3(bufferSource(out));
    const [ia, ib] = parts.map((p) => p.index);
    expect(idx.frameCount).toBe(ia.frameCount + ib.frameCount);
    expect(joined.frames).toBe(idx.frameCount);
    expect(idx.xing).toMatchObject({ kind: 'Info', frames: idx.frameCount, bytes: out.length - tag.length });
    expect(idx.innerTags).toBe(0);
    expect(idx.junkBytes).toBe(0);
    expect(idx.frameOffsets[0]).toBe(tag.length + idx.xing!.frameLength);
    expect(frameBytes(out, idx)).toEqual(concat([frameBytes(a, ia), frameBytes(b, ib)]));
    // Every frame starts where the one before ends.
    for (let k = 1; k < idx.frameCount; k++) expect(idx.frameOffsets[k] - idx.frameOffsets[k - 1]).toBe(decodeHeader(readU32(out, idx.frameOffsets[k - 1]))!.frameLength);

    // The encoder delay of the first chapter and the padding of the last: the length is the sum, plus the short silences at the seam.
    expect(idx.lame).toMatchObject({ encoderDelay: ia.lame!.encoderDelay, padding: ib.lame!.padding });
    const seam = ia.lame!.padding + ib.lame!.encoderDelay;
    expect(idx.durationSec * SR).toBeCloseTo(ia.durationSec * SR + ib.durationSec * SR + seam, 6);
    const decoded = await decodeMp3(out);
    expect(decoded.samplesDecoded).toBe(Math.round(idx.durationSec * SR));
    expect(steps.at(-1)).toBe(1);
  });

  it('plays each chapter as before', async () => {
    const a = chapter([{ sec: 1.5, freq: 440 }]);
    const b = chapter([{ sec: 1.5, freq: 660 }]);
    const parts = await inputs([a, b]);
    const out = await blobBytes((await joinMp3(parts)).blob);
    const [ia, ib] = parts.map((p) => p.index);
    const whole = (await decodeMp3(out)).channelData[0];
    const da = (await decodeMp3(a)).channelData[0];
    const db = (await decodeMp3(b)).channelData[0];
    const maxDiff = (x: Float32Array, y: Float32Array) => x.reduce((m, v, i) => Math.max(m, Math.abs(v - y[i])), 0);
    // The first chapter up to its last frame (the seam overlaps one frame).
    expect(maxDiff(da.subarray(0, da.length - 2304), whole)).toBeLessThan(1e-6);
    // The second one from its second frame on, where its frames lie in the joined file.
    const at = ia.frameCount * 1152 - ia.lame!.encoderDelay + ib.lame!.encoderDelay;
    expect(maxDiff(db.subarray(2304), whole.subarray(at + 2304))).toBeLessThan(1e-6);
  });

  it('writes a Xing frame with a growing seek table when the bitrates differ', async () => {
    const parts = await inputs([monoMp3(), mono96Mp3()]);
    const out = await blobBytes((await joinMp3(parts, { tag: null })).blob);
    const idx = await scanMp3(bufferSource(out));
    expect(idx.xing?.kind).toBe('Xing');
    expect(idx.cbr).toBe(false);
    expect(idx.frameCount).toBe(parts[0].index.frameCount + parts[1].index.frameCount);
    const toc = [...idx.xing!.toc!];
    expect(toc).toEqual([...toc].sort((x, y) => x - y));
    // At half the frames the 64 kbit/s file (12 s) is far from over: the table says less than half the bytes.
    expect(toc[50]).toBeLessThan(128);
    // No tag: the file starts with the Xing frame.
    expect(idx.audioStart).toBe(0);
  });

  it('refuses files of different formats', async () => {
    const parts = await inputs([monoMp3(), stereoMp3()]);
    await expect(joinMp3(parts)).rejects.toMatchObject({ code: 'mixed-format' });
    await expect(joinMp3([])).rejects.toBeInstanceOf(AudioError);
  });

  it('puts a silent frame with the reservoir bytes in front of a part that reaches back', async () => {
    // A cut part of a stream with bit reservoir: its first frame needs bytes from before the cut.
    const packed = makeReservoirStream(monoMp3());
    const src = bufferSource(packed);
    const pieces = await Promise.all((await cutMp3(src, await scanMp3(src), [4])).map(blobBytes));
    const second = pieces[1];
    const parts = await inputs([chapter([{ sec: 1, freq: 300 }]), second]);
    const joined = await joinMp3(parts, { tag: null });
    expect(joined.bridges).toBe(1);
    const out = await blobBytes(joined.blob);
    const idx = await scanMp3(bufferSource(out));
    expect(idx.frameCount).toBe(parts[0].index.frameCount + 1 + parts[1].index.frameCount);
    expect(idx.xing?.frames).toBe(idx.frameCount);
    // The bridge is a silent frame of the same format, its main data ends with what the part's tag frame carried.
    const bridgeAt = idx.frameOffsets[parts[0].index.frameCount];
    const h = decodeHeader(readU32(out, bridgeAt))!;
    expect([h.sampleRate, h.channels, h.layer]).toEqual([SR, 1, 3]);
    const bridge = out.subarray(bridgeAt, bridgeAt + h.frameLength);
    expect(bridge.subarray(4, 4 + h.sideInfoSize).every((x) => x === 0)).toBe(true);
    const ownTag = second.subarray(parts[1].index.xing!.offset, parts[1].index.xing!.offset + parts[1].index.xing!.frameLength);
    expect(bridge.subarray(bridge.length - 40)).toEqual(ownTag.subarray(ownTag.length - 40));
    // After the silent frame the part sounds as in the stream it was cut from, from its second frame on (the first overlaps the silence).
    const whole = (await decodeMp3(out)).channelData[0];
    const original = (await decodeMp3(packed, false)).channelData[0];
    const cutFrame = (await scanMp3(bufferSource(pieces[0]))).frameCount;
    const ia = parts[0].index;
    const at = (ia.frameCount + 1) * 1152 - 529 - ia.lame!.encoderDelay;
    const n = parts[1].index.frameCount * 1152;
    let maxDiff = 0;
    for (let i = 1152; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(original[cutFrame * 1152 + i] - whole[at + i]));
    expect(maxDiff).toBeLessThan(1e-6);
  });

  it('builds bridge frames that hold up to the whole reservoir', () => {
    const like = decodeHeader(readU32(monoMp3(), 0))!;
    const small = bridgeFrame(like, new Uint8Array(10).fill(7));
    expect(decodeHeader(readU32(small, 0))!.bitrateKbps).toBe(like.bitrateKbps);
    const big = bridgeFrame(like, new Uint8Array(511).fill(9));
    const hb = decodeHeader(readU32(big, 0))!;
    expect(hb.bitrateKbps).toBeGreaterThan(like.bitrateKbps);
    expect(hb.frameLength - 4 - hb.sideInfoSize).toBeGreaterThanOrEqual(511);
    expect(big.subarray(big.length - 511).every((x) => x === 9)).toBe(true);
  });
});

describe('mergeMp3Files', SLOW, () => {
  it('joins MP3s of one format without converting', async () => {
    const a = chapter([{ sec: 1, freq: 440 }]);
    const b = chapter([{ sec: 1, freq: 550 }]);
    const backend: AudioBackend = {
      analyze: () => Promise.reject(new Error('not used')),
      openPcm: () => Promise.reject(new Error('not used')),
    };
    const merged = await mergeMp3Files(backend, [bufferSource(a), bufferSource(b)], { tags: { title: 'Ganz' } });
    expect(merged.lossless).toBe(true);
    const out = await blobBytes(merged.blob);
    expect(parseId3v2(out)?.tags.title).toBe('Ganz');
  });

  it('converts files of different formats together', async () => {
    const wav = encodeWav16([synth(48000, [{ sec: 1, freq: 300 }])], 48000);
    const steps: number[] = [];
    const merged = await mergeMp3Files(nodeBackend(), [bufferSource(stereoMp3(), 'a.mp3'), bufferSource(wav, 'b.wav')], {
      tags: { title: 'Zusammen' },
      bitrateKbps: 128,
      useWorker: false,
      onProgress: (f) => steps.push(f),
    });
    expect(merged.lossless).toBe(false);
    const out = await blobBytes(merged.blob);
    expect(parseId3v2(out)?.tags.title).toBe('Zusammen');
    const idx = await scanMp3(bufferSource(out));
    expect([idx.sampleRate, idx.channels]).toEqual([SR, 2]);
    // 3 s and 1 s, give or take the encoder's frames.
    expect(Math.abs(idx.durationSec - 4)).toBeLessThan(0.1);
    expect(steps.at(-1)).toBe(1);
  });
});
