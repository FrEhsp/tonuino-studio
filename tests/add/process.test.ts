/**
 * The import pipeline from album draft to files for the card, with the
 * browser audio backend on fake workers (as in tests/audio/flows.test.ts).
 */
import { ID3Writer } from 'browser-id3-writer';
import { describe, expect, it, vi } from 'vitest';
import { albumLoudness, analyzeAudio, buildSmallId3, bufferSource, createBrowserAudioBackend, encodeWav16, fileSource, GAIN_STEP_DB, parseId3v2, scanMp3, type InMemoryAudio } from '../../src/core/audio';
import type { AlbumDraft, DraftTrack } from '../../src/core/library/grouping';
import type { TrackInfo } from '../../src/core/library/tags';
import { conversionFor, estimateAlbumBytes, FileError, MAX_BOOST_DB, prepareAlbum, TARGET_LUFS, UNREADABLE, type AlbumGain, type PreparedAlbum, type ProcessOptions, type TrackJob } from '../../src/features/add/process';
import { memSource } from '../../src/platform/memory';
import type { AudioBackend } from '../../src/platform/types';
import { buildMp4, buildWebm, fakeWebCodecs, pcmPackets, webmClusters } from '../audio/containers';
import { workers } from '../audio/fakeWorkers';
import { BURSTS, lsfMp3, monoMp3, SR, stereoMp3, withInfoFrame } from '../audio/fixtures';
import { blobBytes, concat, decodeMp3, encodeMp3, rawBytesPerBlob, sine, synth } from '../audio/helpers';

const audio = createBrowserAudioBackend({ createWorker: workers({ webCodecs: fakeWebCodecs() }).create });

function track(bytes: Uint8Array, name: string, info: TrackInfo = {}): DraftTrack {
  const codec = name.endsWith('.mp3') ? 'mp3' : name.endsWith('.wav') ? 'pcm' : 'aac';
  return { source: fileSource(new Blob([bytes as BlobPart]), name), info: { codec, ...info }, title: name.replace(/\.\w+$/, '') };
}

function album(tracks: DraftTrack[], patch: Partial<AlbumDraft> = {}): AlbumDraft {
  return { id: 'a1', title: 'Das Album', artist: 'Anna', kind: 'hoerbuch', tracks, split: 'none', splitMinutes: 5, ...patch };
}

function options(patch: Partial<ProcessOptions> = {}): ProcessOptions {
  return { audio, normalizeLoudness: false, stripTags: false, bitrateKbps: 128, signal: new AbortController().signal, ...patch };
}

/** Prepares the album and produces every file, as the session does. */
async function run(a: AlbumDraft, opts: ProcessOptions): Promise<{ jobs: TrackJob[]; files: Uint8Array[]; gain: AlbumGain; rebuilt: PreparedAlbum['rebuilt'] }> {
  const prepared = await prepareAlbum(a, opts);
  try {
    const files: Uint8Array[] = [];
    for (const job of prepared.jobs) files.push(await blobBytes(await job.produce(() => undefined, opts.signal)));
    return { jobs: prepared.jobs, files, gain: prepared.gain, rebuilt: prepared.rebuilt };
  } finally {
    prepared.close();
  }
}

/** The audio backend, counting how often a file is measured. */
function countingAnalyze(): { backend: AudioBackend; analyzed: string[] } {
  const analyzed: string[] = [];
  const backend: AudioBackend = {
    analyze: (source, ...rest) => {
      analyzed.push(source.name);
      return audio.analyze(source, ...rest);
    },
    openPcm: (...args) => audio.openPcm(...args),
  };
  return { backend, analyzed };
}

function withCover(mp3: Uint8Array): Uint8Array {
  const w = new ID3Writer(new ArrayBuffer(0));
  const jpeg = new Uint8Array(200_000);
  jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
  w.setFrame('TIT2', 'Alter Titel').setFrame('APIC', { type: 3, data: jpeg.buffer, description: 'Cover' });
  return concat([new Uint8Array(w.addTag()), mp3]);
}

const analyzeBytes = (bytes: Uint8Array, name = 'x.mp3') => analyzeAudio(fileSource(new Blob([bytes as BlobPart]), name));

/** Real audio work: a test takes a second or two alone, much longer while the whole suite keeps the machine busy. */
const SLOW = { timeout: 30_000 };

describe('prepareAlbum', SLOW, () => {
  it('copies MP3 files unchanged when there is nothing to do', async () => {
    const a = album([track(monoMp3(), '01.mp3'), track(stereoMp3(), '02.mp3')]);
    const { jobs, files, rebuilt } = await run(a, options());
    expect(jobs.map((j) => j.work)).toEqual(['copy', 'copy']);
    expect(rebuilt).toEqual([]);
    expect(files[0]).toEqual(monoMp3());
    expect(files[1]).toEqual(stereoMp3());
  });

  it('replaces pictures and big tags with a small text tag', async () => {
    const big = withCover(monoMp3());
    const { jobs, files } = await run(album([track(big, '01 Anfang.mp3')]), options({ stripTags: true }));
    expect(jobs[0].work).toBe('copy');
    const tag = parseId3v2(files[0]);
    expect(tag?.tags).toEqual({ title: '01 Anfang', artist: 'Anna', album: 'Das Album' });
    expect(tag?.pictures).toEqual([]);
    expect(files[0].length).toBeLessThan(monoMp3().length + 200);
  });

  it('brings an album to the target loudness with the same change for every MP3', async () => {
    const tracks = [track(monoMp3(), '01.mp3'), track(stereoMp3(), '02.mp3')];
    const before = await Promise.all([analyzeBytes(monoMp3()), analyzeBytes(stereoMp3())]);
    const { jobs, files } = await run(album(tracks), options({ normalizeLoudness: true }));
    expect(jobs.map((j) => j.work)).toEqual(['adjust', 'adjust']);
    const after = await Promise.all(files.map((f) => analyzeBytes(f)));
    expect(Math.abs(albumLoudness(after) - TARGET_LUFS)).toBeLessThan(GAIN_STEP_DB / 2 + 0.3);
    const changes = after.map((x, i) => x.lufs! - before[i].lufs!);
    expect(changes[0]).toBeLessThan(0); // the fixtures are loud
    expect(Math.abs(changes[0] - changes[1])).toBeLessThan(0.15);
  });

  it('gives tracks added to a folder made quieter on purpose the level of that folder', async () => {
    const tracks = [track(monoMp3(), '01.mp3'), track(stereoMp3(), '02.mp3')];
    const before = await Promise.all([analyzeBytes(monoMp3()), analyzeBytes(stereoMp3())]);
    const { files } = await run(album(tracks), options({ normalizeLoudness: true, levelOffsetDb: -8 }));
    const after = await Promise.all(files.map((f) => analyzeBytes(f)));
    expect(Math.abs(albumLoudness(after) - (TARGET_LUFS - 8))).toBeLessThan(GAIN_STEP_DB / 2 + 0.3);
    const changes = after.map((x, i) => x.lufs! - before[i].lufs!);
    expect(Math.abs(changes[0] - changes[1])).toBeLessThan(0.15);
  });

  it('boosts quiet MP3s, but never past the point where they would clip', async () => {
    const quiet = encodeMp3([synth(SR, [{ sec: 4, freq: 440, amp: 0.03 }])], SR, 64);
    const before = await analyzeBytes(quiet);
    const boosted = await run(album([track(quiet, 'leise.mp3')]), options({ normalizeLoudness: true }));
    expect(boosted.jobs[0].work).toBe('adjust');
    // Whole steps get there: it stays lossless also when quiet MP3s may be converted.
    const steps = await prepareAlbum(album([track(quiet, 'leise.mp3')]), options({ normalizeLoudness: true, boostQuietMp3: true }));
    steps.close();
    expect(steps.jobs[0].work).toBe('adjust');
    expect(steps.gain.boosted).toBeFalsy();
    const after = await analyzeBytes(boosted.files[0]);
    expect(after.lufs! - before.lufs!).toBeGreaterThan(9); // 12 dB at most, in 1.5 dB steps
    expect(after.peak!).toBeLessThan(1);

    // Quiet, but with one full-scale click: stays as it is.
    const clicky = encodeMp3([synth(SR, [{ sec: 3, freq: 440, amp: 0.03 }, { sec: 0.05, freq: 1000, amp: 0.98 }])], SR, 64);
    const kept = await run(album([track(clicky, 'klick.mp3')]), options({ normalizeLoudness: true }));
    expect(kept.jobs[0].work).toBe('copy');
    expect(kept.files[0]).toEqual(clicky);
    // It stays far under the level of the other albums, and says so.
    expect(kept.gain.shortfallDb).toBeGreaterThan(9);
    expect(kept.gain.boosted).toBeFalsy();
  });

  it('converts the MP3s of a quiet album when whole steps would leave it too quiet', async () => {
    const clicky = encodeMp3([synth(SR, [{ sec: 3, freq: 440, amp: 0.03 }, { sec: 0.05, freq: 1000, amp: 0.98 }])], SR, 64);
    const before = await analyzeBytes(clicky);
    const boosted = await run(album([track(clicky, 'klick.mp3')]), options({ normalizeLoudness: true, boostQuietMp3: true }));
    expect(boosted.jobs[0].work).toBe('convert');
    expect(boosted.gain).toMatchObject({ steps: 0, boosted: true, shortfallDb: 0 });
    expect(boosted.rebuilt).toEqual([]); // nothing broken about it
    const after = await analyzeBytes(boosted.files[0]);
    expect(Math.abs(after.lufs! - before.lufs! - MAX_BOOST_DB)).toBeLessThan(1.5);
    expect(after.peak!).toBeLessThan(1);
    // Going on with the transfer: the rest is converted the same way, without measuring again.
    const { backend, analyzed } = countingAnalyze();
    const rest = await run(album([track(clicky, 'klick 2.mp3')]), options({ audio: backend, normalizeLoudness: true, gain: boosted.gain }));
    expect(analyzed).toEqual([]);
    expect(rest.jobs[0].work).toBe('convert');
    expect(Math.abs((await analyzeBytes(rest.files[0])).lufs! - after.lufs!)).toBeLessThan(0.3);
  });

  it('cuts a long MP3 at speech pauses, losslessly', async () => {
    // 12 s with pauses at 2–3, 6–7 and 9–10 s; the tags claim 25 minutes so it counts as long.
    const book = track(monoMp3(), 'Buch.mp3', { durationSec: 1500 });
    const steps: string[] = [];
    const { jobs, files } = await run(album([book], { split: 'pauses', splitMinutes: 4 / 60 }), options({ minPartSec: 1, onPrepare: (label) => steps.push(label) }));
    expect(steps).toContain('Sucht Sprechpausen');
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    expect(jobs.map((j) => j.title)).toEqual(jobs.map((_, i) => `Buch – Teil ${i + 1}`));
    expect(jobs.every((j) => j.work === 'cut')).toBe(true);
    let start = 0;
    for (const [i, bytes] of files.entries()) {
      const idx = await scanMp3(fileSource(new Blob([bytes as BlobPart]), 'teil.mp3'));
      expect(idx.durationSec).toBeCloseTo(jobs[i].durationSec!, 1);
      expect(parseId3v2(bytes)?.tags.title).toBe(`Buch – Teil ${i + 1}`);
      // Every cut lies inside a pause.
      if (i > 0) expect([2, 6, 9].some((p) => start > p + 0.2 && start < p + 0.8)).toBe(true);
      start += jobs[i].durationSec!;
    }
    expect(start).toBeCloseTo(12, 1);
  });

  it('cuts a whole album in one MP3 at its tracks, losslessly, with their names, measured once in the review', async () => {
    // 12 s with pauses at 2–3, 6–7 and 9–10 s; the review put the cuts into them.
    const mp3 = monoMp3();
    const measured = await analyzeBytes(mp3, 'Album.mp3');
    const names = ['Guten Morgen, Apfelbaum', 'Regenbogenlied', 'Schaukelpferd', 'Gute Nacht, Apfelbaum'];
    const starts = [0, 2.5, 6.5, 9.5];
    const t: DraftTrack = { ...track(mp3, 'Album.mp3', { durationSec: 12 }), albumCuts: { from: 'iTunes', tracks: names.map((title, i) => ({ title, startSec: starts[i] })) } };
    const { backend, analyzed } = countingAnalyze();
    const steps: string[] = [];
    const { jobs, files } = await run(album([t], { split: 'tracks' }), options({ audio: backend, analysisOf: (src) => (src === t.source ? measured : undefined), onPrepare: (label) => steps.push(label) }));
    expect(analyzed).toEqual([]);
    expect(steps).not.toContain('Sucht Sprechpausen');
    expect(jobs.map((j) => j.title)).toEqual(names);
    expect(jobs.every((j) => j.work === 'cut')).toBe(true);
    const lengths = [2.5, 4, 3, 2.5];
    for (const [i, bytes] of files.entries()) {
      const idx = await scanMp3(fileSource(new Blob([bytes as BlobPart]), 'teil.mp3'));
      // Frame boundaries: 26 ms at most off.
      expect(Math.abs(idx.durationSec - lengths[i])).toBeLessThan(0.03);
      expect(parseId3v2(bytes)?.tags).toEqual({ title: names[i], artist: 'Anna', album: 'Das Album' });
    }
    // "Nicht teilen": the file goes whole, the cuts stay for later.
    const whole = await run(album([t], { split: 'none' }), options());
    expect(whole.jobs.map((j) => j.title)).toEqual(['Album']);
  });

  it('converts a whole album in one WAV and cuts it at its tracks', async () => {
    const tones = [
      { sec: 2, freq: 440, amp: 0.2 },
      { sec: 2.5, freq: 660, amp: 0.2 },
      { sec: 1.5, freq: 880, amp: 0.2 },
    ];
    const wav = encodeWav16([synth(SR, tones)], SR);
    const t: DraftTrack = { ...track(wav, 'Album.wav', { durationSec: 6 }), albumCuts: { from: 'Cue-Datei', tracks: [{ title: 'Eins', startSec: 0 }, { title: 'Zwei', startSec: 2 }, { title: 'Drei', startSec: 4.5 }] } };
    const { jobs, files } = await run(album([t], { split: 'tracks' }), options({ parallel: 2 }));
    expect(jobs.map((j) => j.title)).toEqual(['Eins', 'Zwei', 'Drei']);
    expect(jobs.every((j) => j.work === 'convert')).toBe(true);
    for (const [i, bytes] of files.entries()) {
      expect((await decodeMp3(bytes)).samplesDecoded).toBe(Math.round(tones[i].sec * SR));
      expect(parseId3v2(bytes)?.tags.title).toBe(['Eins', 'Zwei', 'Drei'][i]);
    }
  });

  it('converts a long MP3 that changes its format halfway instead of cutting off the rest', async () => {
    const mixed = concat([monoMp3(), stereoMp3(), stereoMp3()]); // 12 s mono, then 6 s stereo
    const { jobs, files } = await run(album([track(mixed, 'Buch.mp3', { durationSec: 1500 })], { split: 'pauses', splitMinutes: 4 / 60 }), options({ minPartSec: 1 }));
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    expect(jobs.every((j) => j.work === 'convert')).toBe(true);
    let total = 0;
    for (const f of files) {
      const d = await decodeMp3(f);
      total += d.samplesDecoded / d.sampleRate;
    }
    const frames = (await scanMp3(bufferSource(monoMp3()))).frameCount + 2 * (await scanMp3(bufferSource(stereoMp3()))).frameCount;
    expect(total).toBeCloseTo((frames * 1152) / SR, 1); // all of it, about 18 s
  });

  it('converts an MP3 joined from 44.1 and 48 kHz parts at its full length when it is copied, adjusted or cut', async () => {
    const joined = concat([encodeMp3([synth(SR, BURSTS)], SR, 64), encodeMp3([synth(48000, BURSTS)], 48000, 64)]); // 24 s
    const length = async (files: Uint8Array[]) => {
      let sec = 0;
      for (const f of files) {
        const d = await decodeMp3(f);
        sec += d.samplesDecoded / d.sampleRate;
      }
      return sec;
    };
    const copied = await run(album([track(joined, 'zusammen.mp3')]), options());
    expect(copied.jobs.map((j) => j.work)).toEqual(['convert']);
    expect(copied.rebuilt.map((r) => r.reason)).toEqual(['joined']);
    expect(await length(copied.files)).toBeCloseTo(24, 0);
    const adjusted = await run(album([track(joined, 'zusammen.mp3')]), options({ normalizeLoudness: true }));
    expect(adjusted.jobs.map((j) => j.work)).toEqual(['convert']);
    expect(await length(adjusted.files)).toBeCloseTo(24, 0);
    const cut = await run(album([track(joined, 'zusammen.mp3', { durationSec: 1500 })], { split: 'pauses', splitMinutes: 6 / 60 }), options({ minPartSec: 1 }));
    expect(cut.jobs.length).toBeGreaterThanOrEqual(3);
    expect(cut.jobs.every((j) => j.work === 'convert')).toBe(true);
    expect(cut.rebuilt.map((r) => r.reason)).toEqual(['joined']);
    expect(await length(cut.files)).toBeCloseTo(24, 0);
  });

  it('gives the parts of MP3s joined byte for byte their real lengths', async () => {
    const one = monoMp3();
    const first = withInfoFrame(one, (await scanMp3(bufferSource(one))).frameCount);
    const joined = concat([first, first, first]); // 36 s, but the Info frame counts 12 s
    const { jobs, files } = await run(album([track(joined, 'Buch.mp3', { durationSec: 1500 })], { split: 'pauses', splitMinutes: 8 / 60 }), options({ minPartSec: 1 }));
    expect(jobs.length).toBeGreaterThanOrEqual(3);
    for (const [i, job] of jobs.entries()) {
      const idx = await scanMp3(bufferSource(files[i]));
      expect(job.durationSec).toBeCloseTo(idx.durationSec, 1);
    }
    expect(jobs.reduce((sum, j) => sum + (j.durationSec ?? 0), 0)).toBeCloseTo((await scanMp3(bufferSource(joined))).durationSec, 1);
  });

  it('copies a long MP3 that has no Blob behind it without holding it in the JS heap (desktop)', async () => {
    const book = concat(Array.from({ length: 512 }, () => stereoMp3())); // about 24 MB
    const t: DraftTrack = { source: bufferSource(book, 'Buch.mp3'), info: { codec: 'mp3', durationSec: 1536 }, title: 'Buch' };
    const prepared = await prepareAlbum(album([t]), options({ stripTags: false }));
    try {
      let out: Blob | undefined;
      expect(await rawBytesPerBlob(async () => (out = await prepared.jobs[0].produce(() => undefined, new AbortController().signal)))).toBeLessThan(12 << 20);
      expect(Buffer.compare(Buffer.from(await blobBytes(out!)), Buffer.from(book))).toBe(0);
    } finally {
      prepared.close();
    }
  });

  it('applies the album gain while cutting', async () => {
    const book = track(monoMp3(), 'Buch.mp3', { durationSec: 1500 });
    const before = await analyzeBytes(monoMp3());
    const { files } = await run(album([book], { split: 'pauses', splitMinutes: 4 / 60 }), options({ minPartSec: 1, normalizeLoudness: true }));
    const after = albumLoudness(await Promise.all(files.map((f) => analyzeBytes(f))));
    expect(Math.abs(after - TARGET_LUFS)).toBeLessThan(GAIN_STEP_DB / 2 + 0.3);
    expect(after).toBeLessThan(before.lufs! + 3.01); // quieter than the loud original as played (mono +3 dB)
  });

  it('converts an M4B and cuts it at its chapters', async () => {
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
    const m4b = buildMp4({ sampleRate: SR, channels: 2, packets: pcmPackets([pcm, pcm], 1024), frameSamples: 1024, chapters });
    const book = track(m4b, 'Buch.m4b', { durationSec: 1500, chapters });
    const { jobs, files } = await run(album([book], { split: 'chapters' }), options({ minPartSec: 1, parallel: 2 }));
    expect(jobs.map((j) => j.title)).toEqual(['Kapitel 1', 'Kapitel 2', 'Kapitel 3']);
    expect(jobs.every((j) => j.work === 'convert')).toBe(true);
    for (const [i, bytes] of files.entries()) {
      expect(parseId3v2(bytes)?.tags).toEqual({ title: chapters[i].title, artist: 'Anna', album: 'Das Album' });
      expect((await decodeMp3(bytes)).samplesDecoded).toBe(Math.round(tones[i].sec * SR));
      expect(jobs[i].durationSec).toBeCloseTo(tones[i].sec, 3);
    }
  });

  it('tells how far the work on every part is, also on parts converted ahead', async () => {
    const pcm = synth(SR, [{ sec: 6, freq: 440, amp: 0.2 }]);
    const chapters = [
      { startSec: 0, title: 'Eins' },
      { startSec: 2, title: 'Zwei' },
      { startSec: 4, title: 'Drei' },
    ];
    const m4b = buildMp4({ sampleRate: SR, channels: 1, packets: pcmPackets([pcm], 1024), frameSamples: 1024, chapters });
    const prepared = await prepareAlbum(album([track(m4b, 'Buch.m4b', { durationSec: 1500, chapters })], { split: 'chapters' }), options({ minPartSec: 1, parallel: 2 }));
    try {
      const { jobs } = prepared;
      expect(jobs.map((j) => j.worked())).toEqual([0, 0, 0]);
      const seen: number[] = [];
      await jobs[0].produce((f) => seen.push(f), new AbortController().signal);
      expect(seen.length).toBeGreaterThan(1);
      expect(seen.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= seen[i - 1]))).toBe(true);
      expect(jobs[0].worked()).toBe(1);
      // The second lane works on the later parts while the first part is written.
      await vi.waitFor(() => expect(jobs[1].worked() + jobs[2].worked()).toBeGreaterThan(0));
      for (const job of jobs.slice(1)) await job.produce(() => undefined, new AbortController().signal);
      expect(jobs.map((j) => j.worked())).toEqual([1, 1, 1]);
    } finally {
      prepared.close();
    }
  });

  it('converts other formats and starts the next conversion while one is written', async () => {
    let opened = 0;
    const counting: AudioBackend = {
      analyze: (...args) => audio.analyze(...args),
      openPcm: (...args) => {
        opened++;
        return audio.openPcm(...args);
      },
    };
    const wav = (freq: number) => encodeWav16([synth(SR, [{ sec: 1, freq, amp: 0.2 }])], SR);
    const a = album([track(wav(440), '01 Eins.wav'), track(wav(660), '02 Zwei.wav'), track(wav(880), '03 Drei.wav')]);
    const prepared = await prepareAlbum(a, options({ audio: counting, parallel: 2 }));
    try {
      expect(prepared.jobs.map((j) => j.work)).toEqual(['convert', 'convert', 'convert']);
      const first = await blobBytes(await prepared.jobs[0].produce(() => undefined, new AbortController().signal));
      expect(opened).toBe(2); // the second file was started together with the first
      expect(prepared.jobs[0].worked()).toBe(1);
      await vi.waitFor(() => expect(prepared.jobs[1].worked()).toBeGreaterThan(0));
      expect(prepared.jobs[2].worked()).toBe(0); // two at a time
      expect(parseId3v2(first)?.tags.title).toBe('01 Eins');
      const idx = await scanMp3(fileSource(new Blob([first as BlobPart]), '01.mp3'));
      expect(idx).toMatchObject({ sampleRate: 44100, channels: 1, cbr: true });
      for (const job of prepared.jobs.slice(1)) await job.produce(() => undefined, new AbortController().signal);
      expect(opened).toBe(3);
    } finally {
      prepared.close();
    }
  });

  it('decodes a long file the browser can only decode in memory once for all its parts', async () => {
    const rates: number[] = [];
    const decodeInMemory = async (_data: ArrayBuffer, sampleRate: number): Promise<InMemoryAudio> => {
      rates.push(sampleRate);
      const tone = { sec: 2, freq: 440, amp: 0.2 };
      return { channels: [synth(sampleRate, [tone, { sec: 1 }, tone, { sec: 1 }, tone, { sec: 1 }, tone])], sampleRate };
    };
    const backend = createBrowserAudioBackend({ createWorker: workers().create, decodeInMemory, probeDuration: async () => 11 });
    const book: DraftTrack = { source: fileSource(new Blob([buildWebm() as BlobPart]), 'Hörspiel.webm'), info: { codec: 'opus', durationSec: 1500 }, title: 'Hörspiel' };
    const { jobs } = await run(album([book], { split: 'pauses', splitMinutes: 2.5 / 60 }), options({ audio: backend, minPartSec: 1, parallel: 4 }));
    expect(jobs.length).toBeGreaterThanOrEqual(3);
    expect(rates).toEqual([22050, 44100]); // once for the pauses, once for all parts
  });

  it('converts files the browser can only decode in memory one after the other, in order', async () => {
    let prepared: PreparedAlbum | undefined;
    const files = [1, 2, 3].map((k) => buildWebm({ clusters: webmClusters(k) }));
    const decodes: number[] = [];
    const decodeInMemory = async (data: ArrayBuffer, sampleRate: number): Promise<InMemoryAudio> => {
      const k = files.findIndex((f) => f.length === data.byteLength);
      // Each file is decoded only when the ones before it are converted (and let go).
      if (prepared?.jobs.slice(0, k).some((j) => j.worked() < 1)) throw new Error(`Datei ${k + 1} zu früh entpackt`);
      decodes.push(k);
      return { channels: [sine(sampleRate, 440, 1, 0.2)], sampleRate };
    };
    const backend = createBrowserAudioBackend({ createWorker: workers().create, decodeInMemory });
    const tracks = files.map((f, k): DraftTrack => ({ source: fileSource(new Blob([f as BlobPart]), `0${k + 1}.webm`), info: { codec: 'opus', durationSec: k + 1 }, title: `0${k + 1}` }));
    prepared = await prepareAlbum(album(tracks), options({ audio: backend, parallel: 3 }));
    try {
      for (const job of prepared.jobs) expect((await blobBytes(await job.produce(() => undefined, new AbortController().signal))).length).toBeGreaterThan(1000);
      expect(decodes).toEqual([0, 1, 2]);
    } finally {
      prepared.close();
    }
  });

  it('keeps few converted parts waiting in memory while one is written', async () => {
    const chapters = Array.from({ length: 12 }, (_, i) => ({ startSec: i, title: `Kapitel ${i + 1}` }));
    const pcm = synth(SR, [{ sec: 12, freq: 440, amp: 0.2 }]);
    const m4b = buildMp4({ sampleRate: SR, channels: 1, packets: pcmPackets([pcm], 1024), frameSamples: 1024, chapters });
    const prepared = await prepareAlbum(album([track(m4b, 'Buch.m4b', { durationSec: 1500, chapters })], { split: 'chapters' }), options({ minPartSec: 0.1, parallel: 2 }));
    try {
      const { jobs } = prepared;
      expect(jobs).toHaveLength(12);
      await jobs[0].produce(() => undefined, new AbortController().signal);
      // Part 1 is taken: parts 2 and 3 may be made now, the rest waits for the writer.
      await vi.waitFor(() => expect(jobs[1].worked() + jobs[2].worked()).toBe(2));
      await new Promise((r) => setTimeout(r, 300));
      expect(jobs.slice(3).map((j) => j.worked())).toEqual(new Array(9).fill(0));
      for (const job of jobs.slice(1)) await job.produce(() => undefined, new AbortController().signal);
      expect(jobs.map((j) => j.worked())).toEqual(new Array(12).fill(1));
    } finally {
      prepared.close();
    }
  });

  it('shows the progress of each converted part itself, never going back', { timeout: 30_000 }, async () => {
    const chapters = Array.from({ length: 6 }, (_, i) => ({ startSec: i, title: `Kapitel ${i + 1}` }));
    const pcm = synth(SR, [{ sec: 6, freq: 440, amp: 0.2 }]);
    const m4b = buildMp4({ sampleRate: SR, channels: 1, packets: pcmPackets([pcm], 1024), frameSamples: 1024, chapters });
    const prepared = await prepareAlbum(album([track(m4b, 'Buch.m4b', { durationSec: 1500, chapters })], { split: 'chapters' }), options({ minPartSec: 0.5, parallel: 3 }));
    try {
      for (const job of prepared.jobs) {
        const seen: number[] = [];
        await job.produce((f) => seen.push(f), new AbortController().signal);
        expect(seen.every((f, i) => i === 0 || f >= seen[i - 1])).toBe(true);
        expect(seen[seen.length - 1]).toBe(1);
      }
      // The first part was waited for from the start: its bar went all the way.
      expect(prepared.jobs[0].worked()).toBe(1);
    } finally {
      prepared.close();
    }
  });

  it('stops all work on close()', async () => {
    const chapters = [
      { startSec: 0, title: 'Eins' },
      { startSec: 2, title: 'Zwei' },
    ];
    const pcm = synth(SR, [{ sec: 4, freq: 440, amp: 0.2 }]);
    const m4b = buildMp4({ sampleRate: SR, channels: 1, packets: pcmPackets([pcm], 1024), frameSamples: 1024, chapters });
    const prepared = await prepareAlbum(album([track(m4b, 'Buch.m4b', { durationSec: 1500, chapters })], { split: 'chapters' }), options({ minPartSec: 1 }));
    expect(prepared.jobs).toHaveLength(2);
    prepared.close();
    await expect(prepared.jobs[0].produce(() => undefined, new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('names the file when it cannot be read', async () => {
    const broken = track(new Uint8Array(4096).fill(7), 'kaputt.m4a', { durationSec: 60 });
    const prepared = await prepareAlbum(album([broken]), options());
    try {
      await expect(prepared.jobs[0].produce(() => undefined, new AbortController().signal)).rejects.toThrow(/^„kaputt\.m4a“: /);
    } finally {
      prepared.close();
    }
  });

  it('goes on with a cut MP3 after the parts on the card, cut the same way', async () => {
    const book = track(monoMp3(), 'Buch.mp3', { durationSec: 1500 });
    const a = album([book], { split: 'pauses', splitMinutes: 4 / 60 });
    const whole = await run(a, options({ minPartSec: 1 }));
    expect(whole.jobs.length).toBeGreaterThanOrEqual(3);
    expect(whole.jobs.map((j) => [j.source, j.part, j.parts])).toEqual(whole.jobs.map((_, i) => [book.source, i, whole.jobs.length]));
    // The first part is on the card already.
    const rest = await run(a, options({ minPartSec: 1, skipParts: new Map([[book.source, 1]]) }));
    expect(rest.jobs.map((j) => [j.part, j.parts, j.title])).toEqual(whole.jobs.slice(1).map((j) => [j.part, j.parts, j.title]));
    expect(rest.files).toEqual(whole.files.slice(1));
  });

  it('goes on with a converted file after the chapters on the card', async () => {
    const tones = [
      { sec: 2, freq: 440, amp: 0.2 },
      { sec: 2.5, freq: 660, amp: 0.2 },
      { sec: 1.5, freq: 880, amp: 0.2 },
    ];
    const chapters = [
      { startSec: 0, title: 'Kapitel 1' },
      { startSec: 2, title: 'Kapitel 2' },
      { startSec: 4.5, title: 'Kapitel 3' },
    ];
    const m4b = buildMp4({ sampleRate: SR, channels: 1, packets: pcmPackets([synth(SR, tones)], 1024), frameSamples: 1024, chapters });
    const book = track(m4b, 'Buch.m4b', { durationSec: 1500, chapters });
    const { jobs, files } = await run(album([book], { split: 'chapters' }), options({ minPartSec: 1, parallel: 2, skipParts: new Map([[book.source, 1]]) }));
    expect(jobs.map((j) => [j.title, j.part, j.parts])).toEqual([
      ['Kapitel 2', 1, 3],
      ['Kapitel 3', 2, 3],
    ]);
    for (const [i, bytes] of files.entries()) expect((await decodeMp3(bytes)).samplesDecoded).toBe(Math.round(tones[i + 1].sec * SR));
  });

  it('tells what the loudness became, and which files were clipped before they came', async () => {
    // A tone turned up 6 dB past full scale and saved cut off, next to a clean one.
    const clipped = encodeWav16([sine(SR, 220, 3, 2).map((v) => Math.max(-1, Math.min(1, v)))], SR);
    const clean = encodeWav16([sine(SR, 220, 3, 0.5)], SR);
    const tracks = [track(clipped, '01 Laut.wav'), track(clean, '02 Sauber.wav')];
    const prepared = await prepareAlbum(album(tracks), options({ normalizeLoudness: true }));
    prepared.close();
    expect(prepared.clipped).toEqual([tracks[0]]);
    // The album is far too loud: turned down, and that change is told.
    expect(prepared.levelDb).toBe(prepared.gain.convertDb);
    expect(prepared.levelDb).toBeLessThan(-3);
    // Without „Gleiche Lautstärke“ nothing is measured, so nothing is told.
    const plain = await prepareAlbum(album(tracks), options());
    plain.close();
    expect(plain.levelDb).toBeUndefined();
    expect(plain.clipped).toEqual([]);
    // Going on with a transfer: the change is the earlier one, not measured now.
    const rest = await prepareAlbum(album(tracks), options({ normalizeLoudness: true, gain: prepared.gain }));
    rest.close();
    expect(rest.levelDb).toBeUndefined();
  });

  it('keeps the loudness change of the transfer it goes on with, without measuring again', async () => {
    const first = track(monoMp3(), '01.mp3');
    const second = track(stereoMp3(), '02.mp3');
    const whole = await run(album([first, second]), options({ normalizeLoudness: true }));
    expect(whole.gain.steps).not.toBe(0);
    // The first file is on the card; the second one gets the same change as in the whole album.
    const { backend, analyzed } = countingAnalyze();
    const rest = await run(album([second]), options({ audio: backend, normalizeLoudness: true, gain: whole.gain }));
    expect(analyzed).toEqual([]);
    expect(rest.gain).toEqual(whole.gain);
    expect(rest.files).toEqual(whole.files.slice(1));
    // Measured on its own, it would have got another change.
    const alone = await run(album([second]), options({ normalizeLoudness: true }));
    expect(alone.gain).not.toEqual(whole.gain);
  });

  it('names the file with its path in the picked folder, where many files share a name', async () => {
    const broken: DraftTrack = { source: memSource('02.m4a', new Uint8Array(4096).fill(7), 'Sammlung/B Zweites/02.m4a'), info: { codec: 'aac', durationSec: 60 }, title: '02' };
    const prepared = await prepareAlbum(album([broken]), options());
    try {
      const e = await prepared.jobs[0].produce(() => undefined, new AbortController().signal).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(FileError);
      expect(e).toMatchObject({ file: 'Sammlung/B Zweites/02.m4a', track: broken });
      expect((e as Error).message).toMatch(/^„Sammlung\/B Zweites\/02\.m4a“: /);
    } finally {
      prepared.close();
    }
  });

  it('leaves out a long file it cannot read and prepares the others', async () => {
    const broken: DraftTrack = { source: memSource('Buch.m4a', new Uint8Array(4096).fill(7), 'Hörbuch/Buch.m4a'), info: { codec: 'aac', durationSec: 1500 }, title: 'Buch' };
    const prepared = await prepareAlbum(album([track(monoMp3(), '01.mp3'), broken], { split: 'pauses' }), options());
    try {
      expect(prepared.jobs.map((j) => j.title)).toEqual(['01']);
      expect(prepared.skipped.map((e) => [e.file, e.track])).toEqual([['Hörbuch/Buch.m4a', broken]]);
    } finally {
      prepared.close();
    }
  });

  it('gives up right away when the import was cancelled', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(prepareAlbum(album([track(monoMp3(), '01.mp3')]), options({ normalizeLoudness: true, signal: ctl.signal }))).rejects.toMatchObject({ name: 'AbortError' });
  });
});

/** Bytes that never form a chain of frame headers. */
function garbage(n: number): Uint8Array {
  return new Uint8Array(n).map((_, i) => (i % 89 === 0 ? 0xff : (i * 37 + 11) & 0x7f));
}

/** Playing time of an MP3 as mpg123 decodes it. */
async function playingTime(bytes: Uint8Array): Promise<number> {
  const d = await decodeMp3(bytes);
  return d.samplesDecoded / d.sampleRate;
}

describe('damaged and joined MP3s', SLOW, () => {
  it('converts an MP3 with garbage in the middle anew', async () => {
    const mp3 = monoMp3();
    const at = (await scanMp3(bufferSource(mp3))).frameOffsets[200];
    const damaged = concat([mp3.subarray(0, at), garbage(5000), mp3.subarray(at)]);
    const labels: string[] = [];
    const { jobs, files, rebuilt } = await run(album([track(damaged, 'kaputt.mp3')]), options({ onPrepare: (label) => labels.push(label) }));
    expect(labels).toContain('Prüft die Dateien');
    expect(jobs.map((j) => j.work)).toEqual(['convert']);
    expect(rebuilt).toEqual([{ track: expect.objectContaining({ title: 'kaputt' }), reason: 'damaged' }]);
    const out = await scanMp3(bufferSource(files[0]));
    expect(out).toMatchObject({ innerJunkBytes: 0, resyncs: 0, sampleRate: 44100, cbr: true });
    expect(await playingTime(files[0])).toBeCloseTo(12, 0);
  });

  it('converts files joined from several MP3s, at their whole length', async () => {
    const tag = (title: string) => buildSmallId3({ title }, { padding: 1500 });
    const one = monoMp3();
    // Two tagged files, joined with copy /b.
    const tagged = concat([tag('Teil 1'), one, tag('Teil 2'), one]);
    const a = await run(album([track(tagged, 'zwei.mp3')]), options());
    expect(a.jobs.map((j) => j.work)).toEqual(['convert']);
    expect(a.rebuilt.map((r) => r.reason)).toEqual(['joined']);
    expect((await scanMp3(bufferSource(a.files[0]))).junkBytes).toBe(0);
    expect(Math.abs((await playingTime(a.files[0])) - 2 * (await playingTime(one)))).toBeLessThan(0.1);
    // Two LAME files with their Info frames.
    const frames = (await scanMp3(bufferSource(one))).frameCount;
    const lame = concat([withInfoFrame(one, frames), withInfoFrame(one, frames)]);
    const b = await run(album([track(lame, 'lame.mp3')]), options());
    expect(b.jobs.map((j) => j.work)).toEqual(['convert']);
    expect(Math.abs((await playingTime(b.files[0])) - (await scanMp3(bufferSource(lame))).durationSec)).toBeLessThan(0.1);
    // 44.1 kHz and 22.05 kHz, joined.
    const c = await run(album([track(concat([one, lsfMp3()]), 'gemischt.mp3')]), options());
    expect(c.jobs.map((j) => j.work)).toEqual(['convert']);
    expect(c.rebuilt.map((r) => r.reason)).toEqual(['joined']);
    expect(await playingTime(c.files[0])).toBeCloseTo(16, 0);
    // Two files with a small tag each and no Info frame (as ffmpeg writes them), joined with copy /b.
    const small = buildSmallId3({ title: 'A' });
    const d = await run(album([track(concat([small, one, small, one]), 'klein.mp3')]), options());
    expect(d.jobs.map((j) => j.work)).toEqual(['convert']);
    expect(d.rebuilt.map((r) => r.reason)).toEqual(['joined']);
  });

  it('copies normal MP3s with tags at both ends and junk in front of the first frame', async () => {
    const one = monoMp3();
    const ape = new Uint8Array(64);
    const magic = [...'APETAGEX'].map((ch) => ch.charCodeAt(0));
    for (const at of [0, 32]) {
      ape.set(magic, at);
      new DataView(ape.buffer).setUint32(at + 8, 2000, true);
      new DataView(ape.buffer).setUint32(at + 12, 32, true);
      new DataView(ape.buffer).setUint32(at + 20, 0x80000000, true);
    }
    const id3v1 = new Uint8Array(128);
    id3v1.set([0x54, 0x41, 0x47]);
    const tagged = concat([buildSmallId3({ title: 'Lied' }, { padding: 3000 }), one, ape, id3v1]);
    const leading = concat([buildSmallId3({ title: 'Lied' }), garbage(3000), one]); // a tag whose size is wrong
    const { jobs, files, rebuilt } = await run(album([track(tagged, '01.mp3'), track(leading, '02.mp3')]), options());
    expect(jobs.map((j) => j.work)).toEqual(['copy', 'copy']);
    expect(rebuilt).toEqual([]);
    expect(files).toEqual([tagged, leading]);
  });

  it('copies an MP3 whose frames are whole, with more than 4 KiB of something else after them', async () => {
    const id3v1 = new Uint8Array(128);
    id3v1.set([0x54, 0x41, 0x47]);
    const padded = concat([monoMp3(), new Uint8Array(8192), id3v1]);
    const { jobs, files, rebuilt } = await run(album([track(padded, '01.mp3')]), options());
    expect(jobs.map((j) => j.work)).toEqual(['copy']);
    expect(rebuilt).toEqual([]);
    expect(files).toEqual([padded]);
  });

  it('leaves out a file that is neither MP3 nor anything the converter can read, with the usual words', async () => {
    const broken = track(garbage(20000), 'kaputt.mp3');
    const prepared = await prepareAlbum(album([broken, track(monoMp3(), '02.mp3')]), options());
    try {
      expect(prepared.jobs.map((j) => j.work)).toEqual(['convert', 'copy']);
      const e = await prepared.jobs[0].produce(() => undefined, new AbortController().signal).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(FileError);
      expect(e).toMatchObject({ file: 'kaputt.mp3', reason: UNREADABLE });
    } finally {
      prepared.close();
    }
  });

  it('uses what reading the files found, without reading them again', async () => {
    const one = monoMp3();
    const labels: string[] = [];
    const checked = (name: string, rebuild?: 'damaged' | 'joined') => track(one, name, { mp3Check: rebuild ? { rebuild } : { durationSec: 12 } });
    const { jobs, rebuilt } = await run(album([checked('01.mp3'), checked('02.mp3', 'joined')]), options({ onPrepare: (label) => labels.push(label) }));
    expect(jobs.map((j) => j.work)).toEqual(['copy', 'convert']);
    expect(rebuilt.map((r) => [r.track.title, r.reason])).toEqual([['02', 'joined']]);
    expect(labels).not.toContain('Prüft die Dateien');
  });

  it('counts frames the decoder had to drop as damage', async () => {
    const one = monoMp3();
    const short: AudioBackend = {
      analyze: async (...args) => ({ ...(await audio.analyze(...args)), durationSec: 9 }),
      openPcm: (...args) => audio.openPcm(...args),
    };
    const { jobs, rebuilt } = await run(album([track(one, '01.mp3', { mp3Check: { durationSec: 12 } })]), options({ audio: short, normalizeLoudness: true }));
    expect(jobs.map((j) => j.work)).toEqual(['convert']);
    expect(rebuilt.map((r) => r.reason)).toEqual(['damaged']);
  });

  it('leaves the files of a publisher that allows no changes as they are', async () => {
    const mp3 = monoMp3();
    const at = (await scanMp3(bufferSource(mp3))).frameOffsets[200];
    const damaged = concat([mp3.subarray(0, at), garbage(5000), mp3.subarray(at)]);
    const { jobs, files } = await run(album([track(damaged, 'kaputt.mp3', { mp3Check: { rebuild: 'damaged' } })], { unchanged: true }), options());
    expect(jobs.map((j) => j.work)).toEqual(['copy']);
    expect(files[0]).toEqual(damaged);
  });
});

describe('Hörspiele in Mono (extra)', SLOW, () => {
  it('halves the bitrate of spoken albums only, and only when switched on', () => {
    expect(conversionFor('hoerspiel', 128, true)).toEqual({ bitrateKbps: 64, mono: true });
    expect(conversionFor('hoerbuch', 192, true)).toEqual({ bitrateKbps: 96, mono: true });
    expect(conversionFor('musik', 128, true)).toEqual({ bitrateKbps: 128, mono: false });
    expect(conversionFor('lieder', 128, true)).toEqual({ bitrateKbps: 128, mono: false });
    expect(conversionFor('hoerspiel', 128, false)).toEqual({ bitrateKbps: 128, mono: false });
  });

  it('converts a stereo Hörspiel to mono at half the size, and leaves its MP3s alone', async () => {
    const stereo = encodeWav16([synth(SR, [{ sec: 2, freq: 440, amp: 0.2 }]), synth(SR, [{ sec: 2, freq: 660, amp: 0.2 }])], SR);
    const info = { durationSec: 2, channels: 2 };
    const a = album([track(stereo, '01 Kapitel.wav', info), track(stereoMp3(), '02 Kapitel.mp3')], { kind: 'hoerspiel' });
    const { jobs, files } = await run(a, options({ monoSpeech: true }));
    expect(jobs.map((j) => j.work)).toEqual(['convert', 'copy']);
    const idx = await scanMp3(bufferSource(files[0]));
    expect(idx).toMatchObject({ channels: 1, bitrateKbps: 64 });
    expect(files[1]).toEqual(stereoMp3());
    // The space check expects the smaller file too.
    const plain = estimateAlbumBytes({ ...a, tracks: [a.tracks[0]] }, 128);
    const mono = estimateAlbumBytes({ ...a, tracks: [a.tracks[0]] }, 128, true);
    expect(mono).toBe(Math.round(plain / 2));
    // Music stays stereo with the extra on.
    const music = await run(album([track(stereo, '01 Lied.wav', info)], { kind: 'musik' }), options({ monoSpeech: true }));
    expect((await scanMp3(bufferSource(music.files[0]))).channels).toBe(2);
  });
});

describe('spoken titles (extra "Titelansagen")', SLOW, () => {
  /** Stands in for announceTrack: a marker in front, 1.5 seconds more. */
  const announce = vi.fn(async (title: string, mp3: Blob) => ({ blob: new Blob([new TextEncoder().encode(`[${title}]`) as BlobPart, mp3]), addedSec: 1.5 }));

  it('puts each title in front of its finished file and counts the added time', async () => {
    announce.mockClear();
    const a = album([track(monoMp3(), '01 Der Hund.mp3', { durationSec: 2 }), track(stereoMp3(), '02 Die Katze.mp3', { durationSec: 3 })]);
    const { jobs, files } = await run(a, options({ announce }));
    expect(announce.mock.calls.map((c) => c[0])).toEqual(['01 Der Hund', '02 Die Katze']);
    expect(new TextDecoder().decode(files[0].subarray(0, 13))).toBe('[01 Der Hund]');
    expect(files[1].subarray(14)).toEqual(stereoMp3());
    expect(jobs.map((j) => j.durationSec)).toEqual([3.5, 4.5]);
  });

  it('keeps the file without when the voice fails, and says which', async () => {
    const failed = vi.fn();
    const broken = vi.fn(async () => {
      throw new Error('Keine Stimme');
    });
    const { files } = await run(album([track(monoMp3(), '01.mp3')]), options({ announce: broken, onAnnounceFailed: failed }));
    expect(files[0]).toEqual(monoMp3());
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0][0].title).toBe('01');
    expect((failed.mock.calls[0][1] as Error).message).toBe('Keine Stimme');
  });

  it('leaves files from "Entdecken" and albums that must stay unchanged alone', async () => {
    announce.mockClear();
    const free = { ...track(monoMp3(), '01 Frei.mp3'), origin: { sourceId: 'x' } as unknown as DraftTrack['origin'] };
    await run(album([free, track(monoMp3(), '02 Eigen.mp3')]), options({ announce }));
    expect(announce.mock.calls.map((c) => c[0])).toEqual(['02 Eigen']);
    announce.mockClear();
    await run(album([track(monoMp3(), '01.mp3')], { unchanged: true } as Partial<AlbumDraft>), options({ announce }));
    expect(announce).not.toHaveBeenCalled();
  });
});
