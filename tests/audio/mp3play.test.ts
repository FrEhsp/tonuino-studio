/**
 * "Anhören" of MP3s (src/core/audio/mp3play.ts): the length the list shows,
 * and for VBR files without a Xing frame a copy with a table of contents, so
 * browsers neither guess the length nor jump to a guessed place.
 */
import { describe, expect, it } from 'vitest';
import { mp3PlaybackInfo, seekTableFrame, tocOffsets, withSeekTable } from '../../src/core/audio/mp3play';
import { scanMp3 } from '../../src/core/audio/mp3frames';
import { bufferSource } from '../../src/core/audio/source';
import { buildSmallId3 } from '../../src/core/audio/id3';
import type { ByteSource } from '../../src/platform/types';
import { mono96Mp3, monoMp3, withInfoFrame } from './fixtures';
import { concat } from './helpers';

const SLOW = { timeout: 30_000 };

function counting(bytes: Uint8Array): { source: ByteSource; read: () => number } {
  let n = 0;
  return { source: { name: 'a.mp3', size: bytes.length, read: async (s, l) => ((n += l), bytes.subarray(s, s + l)) }, read: () => n };
}

describe('MP3s for "Anhören"', SLOW, () => {
  it('needs no copy for a file with a Xing/Info frame or a constant bitrate, and reads little of it', async () => {
    const one = monoMp3();
    const frames = (await scanMp3(bufferSource(one))).frameCount;
    const tagged = withInfoFrame(one, frames);
    const c = counting(tagged);
    const info = await mp3PlaybackInfo(c.source, 11.8);
    expect(info).toEqual({ durationSec: 11.8 });
    expect(c.read()).toBeLessThan(tagged.length / 2);
    const cbr = counting(one);
    expect((await mp3PlaybackInfo(cbr.source, undefined)).index).toBeUndefined();
    expect(cbr.read()).toBeLessThan(one.length / 2);
  });

  it('measures a VBR file without a Xing frame by its frames and builds a copy the browser can seek in', async () => {
    const one = monoMp3();
    const vbr = concat([buildSmallId3({ title: 'Eule' }), one, mono96Mp3(), mono96Mp3(), one]);
    const real = (await scanMp3(bufferSource(vbr))).durationSec;
    const info = await mp3PlaybackInfo(bufferSource(vbr), (vbr.length * 8) / 64000);
    expect(info.durationSec).toBeCloseTo(real, 9);
    expect(info.index).toBeDefined();

    const copy = new Uint8Array(await withSeekTable(new Blob([vbr as BlobPart]), info.index!).arrayBuffer());
    expect(copy.length).toBe(vbr.length + seekTableFrame(info.index!).length);
    const again = await scanMp3(bufferSource(copy));
    // The same frames, now with a Xing frame that counts them all and points into them.
    expect(again.frameCount).toBe(info.index!.frameCount);
    expect(again.xing?.frames).toBe(info.index!.frameCount);
    expect(again.xing?.toc).toBeDefined();
    expect(again.tags.audioStart).toBe(info.index!.tags.audioStart);
    expect(again.durationSec).toBeCloseTo(real, 1);
    // The copy needs no copy.
    expect((await mp3PlaybackInfo(bufferSource(copy), info.durationSec)).index).toBeUndefined();
  });

  it('points the table of contents at the frame at each percent of the time', async () => {
    const vbr = concat([monoMp3(), mono96Mp3()]);
    const index = await scanMp3(bufferSource(vbr));
    const toc = tocOffsets(index);
    expect(toc).toHaveLength(100);
    expect(toc[0]).toBe(0);
    for (let i = 1; i < 100; i++) expect(toc[i]).toBeGreaterThanOrEqual(toc[i - 1]);
    // Half the time is not half the bytes: the second part has the higher bitrate.
    const half = index.frameOffsets[Math.floor(index.frameCount / 2)] - index.frameOffsets[0];
    expect(toc[50]).toBe(half);
    expect(toc[50]).toBeLessThan((index.audioEnd - index.frameOffsets[0]) / 2);
  });
});
