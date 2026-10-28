/**
 * The trim editor's edits on the file (src/core/audio/trimedit.ts) and the
 * rough levels read during the frame scan (src/core/audio/mp3levels.ts).
 */
import { describe, expect, it } from 'vitest';
import { buildSmallId3, parseId3v2 } from '../../src/core/audio/id3';
import { loadMp3Encoder, Mp3StreamEncoder } from '../../src/core/audio/mp3encoder';
import { FRAME_PEEK_BYTES, readU32, scanMp3 } from '../../src/core/audio/mp3frames';
import { FrameLevels, SILENT_FRAME_DB, frameLevelDb } from '../../src/core/audio/mp3levels';
import { trimMp3 } from '../../src/core/audio/mp3trim';
import { findPauses } from '../../src/core/audio/silence';
import { bufferSource } from '../../src/core/audio/source';
import { isUntouched, keptSec, keptStretches, planTrimEdit, sameEndsFor, wholeTrack, writeTrimEdit } from '../../src/core/audio/trimedit';
import { BURSTS, SR, monoMp3, stereoMp3 } from './fixtures';
import { blobBytes, concat, decodeMp3, synth } from './helpers';

await loadMp3Encoder();

const SLOW = { timeout: 30_000 };

/** 12 s of tone bursts (440, 660, 550, 880 Hz with a second of silence between) as LAME writes them, behind a tag. */
function episode(): Uint8Array {
  const enc = new Mp3StreamEncoder({ inputChannels: 1, sampleRate: SR, bitrateKbps: 64 });
  enc.push({ channels: [synth(SR, BURSTS)], sampleRate: SR });
  const frames = [...enc.takeOutput(), ...enc.finish()];
  return concat([buildSmallId3({ title: 'Folge 7' }), enc.infoFrame(), ...frames]);
}

/** Main frequency of a stretch of samples, from its zero crossings. */
function frequencyAt(x: Float32Array, fromSec: number, sec = 0.3): number {
  const a = Math.round(fromSec * SR);
  const b = a + Math.round(sec * SR);
  let crossings = 0;
  for (let i = a + 1; i < b; i++) if (x[i - 1] < 0 !== x[i] < 0) crossings++;
  return crossings / 2 / sec;
}

describe('a trim edit', () => {
  it('keeps the stretches between the cuts', () => {
    const edit = { startSec: 1, endSec: 11, cuts: [{ fromSec: 3, toSec: 4 }, { fromSec: 6, toSec: 8 }] };
    expect(keptStretches(edit)).toEqual([
      { fromSec: 1, toSec: 3 },
      { fromSec: 4, toSec: 6 },
      { fromSec: 8, toSec: 11 },
    ]);
    expect(keptSec(edit)).toBe(7);
    expect(isUntouched(wholeTrack(12), 12)).toBe(true);
    expect(isUntouched(edit, 12)).toBe(false);
    // The same seconds off both ends of a longer episode; a piece from the middle stays with its own track.
    expect(sameEndsFor(edit, 12, 30)).toEqual({ startSec: 1, endSec: 29, cuts: [] });
  });

  it('lands on frame boundaries, joins what a too thin cut leaves, and refuses to leave less than a second', async () => {
    const idx = await scanMp3(bufferSource(episode()));
    const frame = idx.samplesPerFrame / SR;
    const p = planTrimEdit(idx, { startSec: 1, endSec: 11, cuts: [{ fromSec: 2.5, toSec: 6.5 }] })!;
    expect(p.parts).toHaveLength(2);
    expect(Math.abs(p.cutStartSec - 1)).toBeLessThanOrEqual(frame / 2 + 1e-9);
    expect(Math.abs(p.durationSec - 6)).toBeLessThanOrEqual(2 * frame);
    // A cut of a few milliseconds cuts nothing.
    expect(planTrimEdit(idx, { startSec: 0, endSec: idx.durationSec, cuts: [{ fromSec: 5, toSec: 5.004 }] })!.parts).toEqual([{ startFrame: 0, endFrame: idx.frameCount }]);
    expect(planTrimEdit(idx, { startSec: 5, endSec: 5.5, cuts: [] })).toBeNull();
    expect(planTrimEdit(idx, { startSec: 0, endSec: 12, cuts: [{ fromSec: 0.5, toSec: 11.8 }] })).toBeNull();
  });
});

describe('writing a trim edit', SLOW, () => {
  it('writes only a new start and end exactly as "Anfang und Ende abschneiden" did', async () => {
    const file = episode();
    const src = bufferSource(file);
    const idx = await scanMp3(src);
    const edit = { startSec: 2.5, endSec: idx.durationSec - 1.5, cuts: [] };
    const before = await blobBytes(await trimMp3(src, idx, 2.5, 1.5));
    expect(await blobBytes(await writeTrimEdit(src, idx, edit))).toEqual(before);
  });

  it('cuts a piece out of the middle without converting, keeping the tag', async () => {
    const file = episode();
    const src = bufferSource(file);
    const idx = await scanMp3(src);
    // Away: the 660 Hz burst (3–6 s) with half of each pause around it.
    const edit = { startSec: 0, endSec: idx.durationSec, cuts: [{ fromSec: 2.5, toSec: 6.5 }] };
    const plan = planTrimEdit(idx, edit)!;
    const fractions: number[] = [];
    const out = await blobBytes(await writeTrimEdit(src, idx, edit, { onProgress: (x) => fractions.push(x) }));
    expect(parseId3v2(out)?.tags.title).toBe('Folge 7');
    const t = await scanMp3(bufferSource(out));
    // The kept frames, and at most a silent frame at the seam for the bytes the second part reaches back for.
    const kept = plan.parts.reduce((n, p) => n + p.endFrame - p.startFrame, 0);
    expect(t.frameCount - kept).toBeGreaterThanOrEqual(0);
    expect(t.frameCount - kept).toBeLessThanOrEqual(1);
    expect(t.durationSec).toBeCloseTo(plan.durationSec + ((t.frameCount - kept) * idx.samplesPerFrame) / SR, 2);
    // The first frames of each part, byte for byte.
    const at = t.frameOffsets[0];
    expect(out.subarray(at, at + 200)).toEqual(file.subarray(idx.frameOffsets[0], idx.frameOffsets[0] + 200));
    const decoded = (await decodeMp3(out)).channelData[0];
    expect(frequencyAt(decoded, 1)).toBeCloseTo(440, -1);
    // 7.5 s of the original is 4 s later now: the 550 Hz burst. No 660 Hz anywhere.
    expect(frequencyAt(decoded, 3.5)).toBeCloseTo(550, -1);
    expect(frequencyAt(decoded, 6.5)).toBeCloseTo(880, -1);
    // Between them one pause of a second, where the 660 Hz burst was.
    for (let s = 2.1; s < 2.8; s += 0.1) expect(frequencyAt(decoded, s, 0.1)).toBeLessThan(100);
    expect(fractions.at(-1)).toBe(1);
    for (let i = 1; i < fractions.length; i++) expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
  });

  it('cuts two pieces and a new end in one go', async () => {
    const src = bufferSource(episode());
    const idx = await scanMp3(src);
    const edit = { startSec: 0.5, endSec: 11, cuts: [{ fromSec: 2.5, toSec: 3.5 }, { fromSec: 6.5, toSec: 9.5 }] };
    const t = await scanMp3(bufferSource(await blobBytes(await writeTrimEdit(src, idx, edit))));
    expect(Math.abs(t.durationSec - keptSec(edit))).toBeLessThan(0.1);
    expect(t.lame?.padding ?? 0).toBe(0);
  });
});

describe('rough levels from the frame scan', () => {
  it('scans the same index with and without them, also in small reads', async () => {
    const file = stereoMp3();
    const plain = await scanMp3(bufferSource(file));
    const levels = new FrameLevels();
    const withLevels = await scanMp3(bufferSource(file), { onFrame: levels.onFrame, chunkSize: 64 });
    expect(withLevels).toEqual(plain);
    expect(levels.length).toBe(plain.frameCount);
    expect(FRAME_PEEK_BYTES).toBeLessThan(Math.min(...[...Array(plain.frameCount).keys()].slice(0, -1).map((k) => plain.frameOffsets[k + 1] - plain.frameOffsets[k])));
  });

  it('are low in the pauses and high in the bursts, so the pauses show at once', async () => {
    const file = monoMp3();
    const levels = new FrameLevels();
    const idx = await scanMp3(bufferSource(file), { onFrame: levels.onFrame });
    const windowSec = idx.samplesPerFrame / SR;
    const power = levels.power();
    const pauses = findPauses(power, windowSec, { minPauseSec: 0.5 });
    // The three silences of BURSTS: 2–3 s, 6–7 s, 9–10 s.
    expect(pauses.map((p) => Math.round(p.cutSec * 2) / 2)).toEqual([2.5, 6.5, 9.5]);
    const db = (t: number) => {
      const at = idx.frameOffsets[Math.round(t / windowSec)];
      return frameLevelDb(file, at, readU32(file, at));
    };
    expect(db(1)).toBeGreaterThan(-30);
    expect(db(2.5)).toBe(SILENT_FRAME_DB);
  });
});
