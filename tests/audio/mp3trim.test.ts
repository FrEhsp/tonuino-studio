import { describe, expect, it } from 'vitest';
import { buildSmallId3, parseId3v2 } from '../../src/core/audio/id3';
import { loadMp3Encoder, Mp3StreamEncoder } from '../../src/core/audio/mp3encoder';
import { scanMp3 } from '../../src/core/audio/mp3frames';
import { leadingTags, MIN_TRIMMED_SEC, planTrim, trimMp3 } from '../../src/core/audio/mp3trim';
import { bufferSource } from '../../src/core/audio/source';
import { BURSTS, SR, stereoMp3 } from './fixtures';
import { blobBytes, concat, decodeMp3, synth } from './helpers';

await loadMp3Encoder();

const SLOW = { timeout: 30_000 };

/** 12 s of tone bursts as LAME writes them (Info frame, delay, padding), behind a tag. */
function episode(): { file: Uint8Array; tag: Uint8Array } {
  const enc = new Mp3StreamEncoder({ inputChannels: 1, sampleRate: SR, bitrateKbps: 64 });
  enc.push({ channels: [synth(SR, BURSTS)], sampleRate: SR });
  const frames = [...enc.takeOutput(), ...enc.finish()];
  const tag = buildSmallId3({ title: 'Folge 7', artist: 'Erzählerin' });
  return { file: concat([tag, enc.infoFrame(), ...frames]), tag };
}

describe('planTrim', () => {
  it('moves the cuts to frame boundaries and says what is left', async () => {
    const idx = await scanMp3(bufferSource(episode().file));
    const p = planTrim(idx, 3, 2)!;
    expect(p.startFrame).toBeGreaterThan(0);
    expect(p.endFrame).toBeLessThan(idx.frameCount);
    // Within half a frame of what was asked.
    expect(Math.abs(p.cutStartSec - 3)).toBeLessThanOrEqual(1152 / SR / 2 + 1e-9);
    expect(Math.abs(p.cutEndSec - 2)).toBeLessThanOrEqual(1152 / SR / 2 + 1e-9);
    expect(p.durationSec).toBeCloseTo(idx.durationSec - p.cutStartSec - p.cutEndSec, 9);
    // Nothing to cut: the whole file.
    expect(planTrim(idx, 0, 0)).toMatchObject({ startFrame: 0, endFrame: idx.frameCount, cutStartSec: 0, cutEndSec: 0 });
    expect(planTrim(idx, Number.NaN, -1)).toMatchObject({ startFrame: 0, endFrame: idx.frameCount });
  });

  it('refuses to leave less than a second', async () => {
    const idx = await scanMp3(bufferSource(episode().file));
    expect(planTrim(idx, 6, 6)).toBeNull();
    expect(planTrim(idx, 20, 0)).toBeNull();
    expect(planTrim(idx, idx.durationSec - MIN_TRIMMED_SEC + 0.1, 0)).toBeNull();
    expect(planTrim(idx, idx.durationSec - MIN_TRIMMED_SEC - 0.1, 0)?.durationSec).toBeGreaterThanOrEqual(MIN_TRIMMED_SEC);
  });
});

describe('trimMp3', SLOW, () => {
  it('cuts start and end at frame boundaries and keeps the tag', async () => {
    const { file, tag } = episode();
    const src = bufferSource(file);
    const idx = await scanMp3(src);
    expect(await leadingTags(src, idx)).toEqual(tag);
    const plan = planTrim(idx, 3, 2)!;
    const out = await blobBytes(await trimMp3(src, idx, 3, 2));
    expect(parseId3v2(out)?.tags.title).toBe('Folge 7');
    const t = await scanMp3(bufferSource(out));
    expect(t.frameCount).toBe(plan.endFrame - plan.startFrame);
    expect(t.xing).toMatchObject({ kind: 'Info', frames: t.frameCount });
    expect(t.xing!.bytes).toBe(out.length - tag.length);
    // The kept frames, byte for byte.
    expect(out.subarray(t.frameOffsets[0], t.audioEnd)).toEqual(file.subarray(idx.frameOffsets[plan.startFrame], idx.frameOffsets[plan.endFrame]));
    // Both ends cut: neither encoder delay nor padding is left to trim.
    expect([t.lame?.encoderDelay, t.lame?.padding]).toEqual([0, 0]);
    const decoded = await decodeMp3(out);
    expect(decoded.samplesDecoded).toBe(Math.round(t.durationSec * SR));
    // 529 samples of decoder delay go at the start, as after every cut.
    expect(Math.abs(t.durationSec - plan.durationSec)).toBeLessThan(600 / SR);
  });

  it('keeps the encoder delay when only the end goes, and the padding when only the start goes', async () => {
    const { file } = episode();
    const src = bufferSource(file);
    const idx = await scanMp3(src);
    const endOnly = await scanMp3(bufferSource(await blobBytes(await trimMp3(src, idx, 0, 2))));
    expect([endOnly.lame?.encoderDelay, endOnly.lame?.padding]).toEqual([idx.lame!.encoderDelay, 0]);
    expect(endOnly.frameOffsets.length).toBeGreaterThan(0);
    const startOnly = await scanMp3(bufferSource(await blobBytes(await trimMp3(src, idx, 2, 0))));
    expect([startOnly.lame?.encoderDelay, startOnly.lame?.padding]).toEqual([0, idx.lame!.padding]);
    const plan = planTrim(idx, 2, 0)!;
    expect(startOnly.frameCount).toBe(idx.frameCount - plan.startFrame);
    // The new start sounds as the old file did there (after the first frame, which overlaps nothing now).
    const whole = (await decodeMp3(file)).channelData[0];
    const cut = (await decodeMp3(await blobBytes(await trimMp3(src, idx, 2, 0)))).channelData[0];
    const shift = plan.startFrame * 1152 - 529 - idx.lame!.encoderDelay + 529;
    let maxDiff = 0;
    for (let i = 1152; i < cut.length; i++) maxDiff = Math.max(maxDiff, Math.abs(cut[i] - whole[shift + i]));
    expect(maxDiff).toBeLessThan(1e-6);
  });

  it('writes the tag it is given, or none', async () => {
    const src = bufferSource(stereoMp3());
    const idx = await scanMp3(src);
    const none = await blobBytes(await trimMp3(src, idx, 0.5, 0.5));
    expect(parseId3v2(none)).toBeNull();
    const own = await blobBytes(await trimMp3(src, idx, 0.5, 0.5, { tag: buildSmallId3({ title: 'Neu' }) }));
    expect(parseId3v2(own)?.tags.title).toBe('Neu');
    expect((await scanMp3(bufferSource(own))).channels).toBe(2);
  });

  it('refuses to cut everything away', async () => {
    const src = bufferSource(stereoMp3());
    const idx = await scanMp3(src);
    await expect(trimMp3(src, idx, 2, 2)).rejects.toMatchObject({ code: 'no-audio' });
  });
});
