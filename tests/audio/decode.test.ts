import { ID3Writer } from 'browser-id3-writer';
import { describe, expect, it } from 'vitest';
import { analyzeAudio, openAudio } from '../../src/core/audio/decode';
import { integratedLoudness, PowerEnvelope } from '../../src/core/audio/loudness';
import { readAllPcm } from '../../src/core/audio/pcm';
import { bufferSource } from '../../src/core/audio/source';
import { encodeWav16 } from '../../src/core/audio/wav';
import { buildAiff, buildMp4, fakeWebCodecs, smallM4b } from './containers';
import { monoMp3, SR } from './fixtures';
import { concat, decodeMp3, sine, toneAmplitude } from './helpers';

function chapterTag(): Uint8Array {
  const w = new ID3Writer(new ArrayBuffer(0));
  w.setFrame('TIT2', 'Buch')
    .setFrame('CHAP', { id: 'c1', startTime: 0, endTime: 6000, subFrames: { TIT2: 'Eins' } })
    .setFrame('CHAP', { id: 'c2', startTime: 6000, endTime: 12000, subFrames: { TIT2: 'Zwei' } });
  return new Uint8Array(w.addTag());
}

const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...new Array<number>(60).fill(0)]);
const wma = Uint8Array.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, ...new Array<number>(60).fill(0)]);

/** Real audio work: a test takes a second or two alone, much longer while the whole suite keeps the machine busy. */
const SLOW = { timeout: 30_000 };

describe('openAudio', SLOW, () => {
  it('opens an MP3 and reads its ID3 chapters', async () => {
    const opened = await openAudio(bufferSource(concat([chapterTag(), monoMp3()]), 'buch.mp3'));
    expect(opened).toMatchObject({
      container: 'mp3',
      codec: 'mp3',
      bitrateKbps: 64,
      chapters: [
        { startSec: 0, title: 'Eins' },
        { startSec: 6, title: 'Zwei' },
      ],
    });
    expect(opened.reader).toMatchObject({ sampleRate: SR, channels: 1 });
    expect(opened.reader.durationSec).toBeGreaterThan(12);
    expect(opened.reader.durationSec).toBeLessThan(12.1);
    const pcm = await readAllPcm(opened.reader);
    expect(Math.abs(pcm[0].length - opened.reader.durationSec * SR)).toBeLessThan(1200);
    expect(opened.progress()).toBe(1);
    await opened.reader.close();
  });

  it('opens WAV and resamples on request', async () => {
    const x = sine(48000, 1000, 1, 0.5);
    const opened = await openAudio(bufferSource(encodeWav16([x, x], 48000), 'a.wav'), { targetSampleRate: 44100 });
    expect(opened).toMatchObject({ container: 'wav', codec: 'pcm', bitrateKbps: 1536 });
    expect(opened.reader.sampleRate).toBe(44100);
    const pcm = await readAllPcm(opened.reader);
    expect(Math.abs(pcm[0].length - 44100)).toBeLessThanOrEqual(1);
    expect(toneAmplitude(pcm[1], 44100, 1000, 4410, 39690)).toBeCloseTo(0.5, 2);
  });

  it('decodes MP4 through WebCodecs', async () => {
    const { file, samples } = smallM4b();
    const opened = await openAudio(bufferSource(file, 'buch.m4b'), { env: { webCodecs: fakeWebCodecs() } });
    expect(opened).toMatchObject({ container: 'mp4', codec: 'aac', chapters: [{ startSec: 0, title: 'Anfang' }, { startSec: 0.5, title: 'Schluss' }] });
    const pcm = await readAllPcm(opened.reader);
    expect(pcm.map((c) => c.length)).toEqual([samples, samples]);
    expect(opened.progress()).toBe(1);
  });

  it('says when the browser decoder may still open a file', async () => {
    const { file, samples } = smallM4b();
    await expect(openAudio(bufferSource(file, 'a.m4a'), { env: { webCodecs: null } })).rejects.toMatchObject({
      code: 'unsupported-format',
      details: { fallback: true, container: 'mp4', codec: 'aac', durationSec: samples / SR },
    });
    await expect(openAudio(bufferSource(file, 'a.m4a'), { env: { webCodecs: fakeWebCodecs({ supported: [] }) } })).rejects.toMatchObject({
      code: 'unsupported-format',
      details: { fallback: true, container: 'mp4' },
    });
    await expect(openAudio(bufferSource(webm, 'a.webm'))).rejects.toMatchObject({ code: 'unsupported-format', details: { container: 'webm', fallback: true } });
    // WMA: no browser decodes it, so no fallback.
    await expect(openAudio(bufferSource(wma, 'a.wma'))).rejects.toMatchObject({ code: 'unsupported-format', details: { container: 'asf', fallback: false } });
  });

  it('refuses copy-protected files with a German message', async () => {
    const drm = buildMp4({ sampleRate: SR, channels: 2, packets: [new Uint8Array(4096)], frameSamples: 1024, entryType: 'drms' });
    const err = await openAudio(bufferSource(drm, 'a.m4p'), { env: { webCodecs: fakeWebCodecs() } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'AudioError', code: 'drm-protected' });
    expect((err as Error).message).toContain('kopiergeschützt');
  });

  it('rejects files that are not audio', async () => {
    await expect(openAudio(bufferSource(new TextEncoder().encode('kein Ton '.repeat(20)), 'a.txt'))).rejects.toMatchObject({ code: 'unsupported-format' });
  });
});

describe('analyzeAudio', SLOW, () => {
  it('measures an MP3 like decoding it at once, with progress', async () => {
    const mp3 = monoMp3();
    const progress: number[] = [];
    const a = await analyzeAudio(bufferSource(mp3, 'a.mp3'), { onProgress: (f) => progress.push(f) });
    const ref = await decodeMp3(mp3);
    const env = new PowerEnvelope(SR, 1);
    env.push({ channels: ref.channelData, sampleRate: SR });
    const power = env.finish();
    expect(a).toMatchObject({ sampleRate: SR, channels: 1, windowSec: 0.01, codec: 'mp3', bitrateKbps: 64 });
    expect(a.durationSec).toBeCloseTo(ref.samplesDecoded / SR, 6);
    expect(a.power.length).toBe(power.length);
    expect(a.lufs).toBeCloseTo(integratedLoudness(power), 3);
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress.every((f, i) => i === 0 || f >= progress[i - 1])).toBe(true);
  });

  it('analyzes AIFF and MP4 files', async () => {
    const x = sine(22050, 500, 1.5, 0.25);
    const aiff = await analyzeAudio(bufferSource(buildAiff([x], 22050), 'a.aiff'));
    expect(aiff).toMatchObject({ sampleRate: 22050, channels: 1, codec: 'pcm' });
    expect(aiff.durationSec).toBeCloseTo(1.5, 6);
    const { file, samples } = smallM4b();
    const m4b = await analyzeAudio(bufferSource(file, 'a.m4b'), { env: { webCodecs: fakeWebCodecs() } });
    expect(m4b).toMatchObject({ sampleRate: SR, channels: 2, codec: 'aac', chapters: [{ startSec: 0 }, { startSec: 0.5 }] });
    expect(m4b.durationSec).toBeCloseTo(samples / SR, 6);
    expect(m4b.bitrateKbps).toBeGreaterThan(0);
  });

  it('stops on abort', async () => {
    const ac = new AbortController();
    const p = analyzeAudio(bufferSource(monoMp3()), {
      signal: ac.signal,
      onProgress: (f) => {
        if (f > 0.2) ac.abort();
      },
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
