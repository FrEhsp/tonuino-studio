/**
 * The three flows of the import pipeline, written the way the app uses the
 * audio core (the code between the "example" markers is what the docs show).
 * The browser backend runs with fake workers and a fake AAC decoder here.
 */
import { ID3Writer } from 'browser-id3-writer';
import { describe, expect, it } from 'vitest';
import {
  albumLoudness,
  analyzeAudio,
  applyGain,
  buildSmallId3,
  convertToMp3,
  convertToMp3Parts,
  createBrowserAudioBackend,
  cutMp3,
  cutsFromChapters,
  fileSource,
  findPauses,
  GAIN_STEP_DB,
  measureTags,
  parseId3v2,
  planSplits,
  scanMp3,
  stepsForTarget,
  tagBytes,
} from '../../src/core/audio';
import type { ByteSource } from '../../src/platform/types';
import { buildMp4, fakeWebCodecs, pcmPackets } from './containers';
import { workers } from './fakeWorkers';
import { monoMp3, SR, stereoMp3 } from './fixtures';
import { blobBytes, concat, decodeMp3, synth, toneAmplitude } from './helpers';

const audio = createBrowserAudioBackend({ createWorker: workers({ webCodecs: fakeWebCodecs() }).create });

function blobSource(bytes: Uint8Array | Blob, name: string): ByteSource {
  return fileSource(bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart]), name);
}

function withCover(mp3: Uint8Array): Uint8Array {
  const w = new ID3Writer(new ArrayBuffer(0));
  const jpeg = new Uint8Array(200_000);
  jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
  w.setFrame('TIT2', 'Alter Titel').setFrame('APIC', { type: 3, data: jpeg.buffer, description: 'Cover' });
  return concat([new Uint8Array(w.addTag()), mp3]);
}

/** Real audio work: a test takes a second or two alone, much longer while the whole suite keeps the machine busy. */
const SLOW = { timeout: 30_000 };

describe('import flows', SLOW, () => {
  it('(a) copies an MP3 with a small tag and the album gain', async () => {
    const tracks = [blobSource(withCover(monoMp3()), '01.mp3'), blobSource(stereoMp3(), '02.mp3')];

    // example (a)
    const analyses = await Promise.all(tracks.map((t) => audio.analyze(t)));
    const steps = stepsForTarget(albumLoudness(analyses), -16); // the same steps for every track of the album
    const src = tracks[0];
    const bigTags = tagBytes(await measureTags(src)) > 64 * 1024; // worth mentioning in the UI
    const blob = await applyGain(src, await scanMp3(src), steps, {
      tag: buildSmallId3({ title: 'Kapitel 1', album: 'Das Hörbuch', track: 1 }),
    });
    // end of example

    expect(bigTags).toBe(true);
    const out = await blobBytes(blob);
    expect(parseId3v2(out)?.tags).toEqual({ title: 'Kapitel 1', album: 'Das Hörbuch', track: '1' });
    expect(out.length).toBeLessThan(monoMp3().length + 100);
    const after = await analyzeAudio(blobSource(out, '01.mp3'));
    expect(after.lufs! - analyses[0].lufs!).toBeCloseTo(steps * GAIN_STEP_DB, 0);
    const second = await analyzeAudio(blobSource(await applyGain(tracks[1], await scanMp3(tracks[1]), steps), '02.mp3'));
    expect(Math.abs(albumLoudness([after, second]) + 16)).toBeLessThan(GAIN_STEP_DB / 2 + 0.2);
  });

  it('(b) splits a long MP3 at pauses', async () => {
    const src = blobSource(monoMp3(), 'buch.mp3'); // 12 s with pauses at 2-3, 6-7 and 9-10 s
    const targetSec = 4; // the app uses about 6 * 60
    const minPartSec = 1; // the app keeps the default (60 s)

    // example (b)
    const analysis = await audio.analyze(src);
    const pauses = findPauses(analysis.power, analysis.windowSec);
    const plan = planSplits({ durationSec: analysis.durationSec, pauses, targetSec, minPartSec, power: analysis.power, windowSec: analysis.windowSec });
    const parts = await cutMp3(src, await scanMp3(src), plan.cuts.map((c) => c.timeSec), {
      tagFor: (i, n) => buildSmallId3({ title: `Das Hörbuch – Teil ${i + 1} von ${n}`, album: 'Das Hörbuch', track: `${i + 1}/${n}` }),
    });
    // end of example

    const pauseRanges = [2, 6, 9].map((s) => [s, s + 1]);
    expect(plan.cuts.length).toBeGreaterThanOrEqual(2);
    for (const c of plan.cuts) {
      expect(c.kind).toBe('pause');
      expect(pauseRanges.some(([a, b]) => c.timeSec > a + 0.2 && c.timeSec < b - 0.2)).toBe(true);
    }
    expect(parts).toHaveLength(plan.parts.length);
    let total = 0;
    for (const [i, part] of parts.entries()) {
      const bytes = await blobBytes(part);
      expect(parseId3v2(bytes)?.tags.track).toBe(`${i + 1}/${parts.length}`);
      const idx = await scanMp3(blobSource(bytes, `teil${i + 1}.mp3`));
      expect(idx.durationSec).toBeCloseTo(plan.parts[i].endSec - plan.parts[i].startSec, 1);
      total += idx.durationSec;
    }
    // Gapless decoders drop their 529-sample delay at the start of every part.
    expect(total).toBeCloseTo((await scanMp3(src)).durationSec - (parts.length * 529) / SR, 6);
  });

  it('(c) converts an M4B to MP3 and splits it at its chapters', async () => {
    // 6 s book, one tone per chapter: 0-2 s 440 Hz, 2-4.5 s 660 Hz, 4.5-6 s 880 Hz.
    const tones = [
      { sec: 2, freq: 440, amp: 0.2 },
      { sec: 2.5, freq: 660, amp: 0.2 },
      { sec: 1.5, freq: 880, amp: 0.2 },
    ];
    const pcm = synth(SR, tones);
    const chapters = [
      { startSec: 0, title: 'Kapitel 1' },
      { startSec: 2, title: 'Kapitel 2' },
      { startSec: 4.5, title: 'Kapitel 3' },
    ];
    const m4b = blobSource(buildMp4({ sampleRate: SR, channels: 2, packets: pcmPackets([pcm, pcm], 1024), frameSamples: 1024, chapters }), 'buch.m4b');
    const minPartSec = 1; // the app keeps the default (60 s)

    // example (c)
    const analysis = await audio.analyze(m4b);
    const mp3 = blobSource(await convertToMp3(audio, m4b, { bitrateKbps: 96, mono: true, targetLufs: -18, analysis, tags: { album: 'Das Hörbuch' } }), 'buch.mp3');
    const plan = cutsFromChapters(analysis.chapters ?? [], analysis.durationSec, { minPartSec });
    const titleAt = (t: number) => [...(analysis.chapters ?? [])].reverse().find((c) => c.startSec <= t + 0.5)?.title;
    const parts = await cutMp3(mp3, await scanMp3(mp3), plan.cuts.map((c) => c.timeSec), {
      tagFor: (i, n) => buildSmallId3({ title: titleAt(plan.parts[i].startSec), album: 'Das Hörbuch', track: `${i + 1}/${n}` }),
    });
    // end of example

    expect(analysis.chapters).toEqual(chapters);
    expect(plan.cuts.map((c) => c.timeSec)).toEqual([2, 4.5]);
    expect(parts).toHaveLength(3);
    for (const [i, part] of parts.entries()) {
      const bytes = await blobBytes(part);
      expect(parseId3v2(bytes)?.tags.title).toBe(chapters[i].title);
      const idx = await scanMp3(blobSource(bytes, 'teil.mp3'));
      expect(idx).toMatchObject({ sampleRate: 44100, channels: 1, cbr: true, bitrateKbps: 96 });
      // Cuts snap to frames (±13 ms); later parts lose the 529-sample decoder delay (12 ms).
      expect(Math.abs(idx.durationSec - tones[i].sec)).toBeLessThan(0.04);
      expect(idx.lame?.encoderDelay).toBe(i === 0 ? 576 : 0);
      // Each part holds its own chapter's tone, so the MP3 timeline matches the M4B's.
      const decoded = (await decodeMp3(bytes)).channelData[0];
      const mid = [Math.round(decoded.length * 0.2), Math.round(decoded.length * 0.8)] as const;
      const own = toneAmplitude(decoded, SR, tones[i].freq, ...mid);
      for (const other of tones) if (other !== tones[i]) expect(toneAmplitude(decoded, SR, other.freq, ...mid)).toBeLessThan(own / 20);
    }

    // The faster way for long books: convert and split in one go, several parts at once, sample exact.
    const fast = await convertToMp3Parts(audio, m4b, plan.cuts.map((c) => c.timeSec), {
      bitrateKbps: 96,
      mono: true,
      targetLufs: -18,
      analysis,
      parallel: 3,
      tagFor: (i, n) => buildSmallId3({ title: titleAt(plan.parts[i].startSec), album: 'Das Hörbuch', track: `${i + 1}/${n}` }),
    });
    expect(fast).toHaveLength(3);
    for (const [i, part] of fast.entries()) {
      const bytes = await blobBytes(part);
      expect(parseId3v2(bytes)?.tags.title).toBe(chapters[i].title);
      expect((await decodeMp3(bytes)).samplesDecoded).toBe(Math.round(tones[i].sec * SR));
    }
  });
});

