import { describe, expect, it } from 'vitest';
import type { ByteSource } from '../../src/platform/types';
import { createBrowserAudioBackend, type BrowserAudioBackendOptions, type InMemoryAudio } from '../../src/core/audio/browserBackend';
import { analyzeAudio, openAudio, type DecodeEnv } from '../../src/core/audio/decode';
import { convertToMp3Parts } from '../../src/core/audio/encode';
import { readAllPcm } from '../../src/core/audio/pcm';
import { bufferSource, fileSource } from '../../src/core/audio/source';
import { buildMp4, buildOgg, buildWebm, fakeWebCodecs, opusFile, smallM4b, webmClusters } from './containers';
import { workers } from './fakeWorkers';
import { lsfMp3, monoMp3, SR } from './fixtures';
import { concat, sine } from './helpers';

function backendWith(env?: DecodeEnv, opts: BrowserAudioBackendOptions = {}) {
  const w = workers(env);
  return { w, backend: createBrowserAudioBackend({ createWorker: w.create, ...opts }) };
}

function blobSource(bytes: Uint8Array, name: string): ByteSource {
  return fileSource(new Blob([bytes as BlobPart]), name);
}

/** A WebM with Opus audio that tells no playing time (the fakes below decide it). */
const webm = buildWebm();

const tick = () => new Promise((r) => setTimeout(r, 10));

/** Real audio work: a test takes a second or two alone, much longer while the whole suite keeps the machine busy. */
const SLOW = { timeout: 30_000 };

describe('browser audio backend', SLOW, () => {
  it('analyzes an MP3 in a worker exactly like in-process', async () => {
    const mp3 = monoMp3();
    const { w, backend } = backendWith();
    const progress: number[] = [];
    const a = await backend.analyze(blobSource(mp3, 'a.mp3'), (f) => progress.push(f));
    const direct = await analyzeAudio(bufferSource(mp3, 'a.mp3'));
    expect(a.power).toEqual(direct.power);
    expect(a).toMatchObject({ durationSec: direct.durationSec, lufs: direct.lufs, codec: 'mp3', bitrateKbps: 64, channels: 1 });
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(1);
    expect(w.created).toHaveLength(1);
    expect(w.created[0].terminated).toBe(true);
  });

  it('reads sources without a Blob through a message port', async () => {
    const mp3 = lsfMp3();
    let reads = 0;
    const inner = bufferSource(mp3, 'b.mp3');
    const source: ByteSource = { name: inner.name, size: inner.size, read: (s, l) => (reads++, inner.read(s, l)) };
    const { backend } = backendWith();
    const a = await backend.analyze(source);
    expect(reads).toBeGreaterThan(0);
    expect(a.power).toEqual((await analyzeAudio(inner)).power);
    await expect(
      backend.analyze({ name: 'kaputt.mp3', size: 1000, read: () => Promise.reject(new Error('USB-Stick entfernt')) }),
    ).rejects.toMatchObject({ name: 'AudioError' });
  });

  it('streams PCM from the worker, resampled', async () => {
    const mp3 = monoMp3();
    const { w, backend } = backendWith();
    const reader = await backend.openPcm(blobSource(mp3, 'a.mp3'), { targetSampleRate: 22050 });
    expect(reader).toMatchObject({ sampleRate: 22050, channels: 1 });
    const pcm = await readAllPcm(reader, 5000);
    const direct = await readAllPcm((await openAudio(bufferSource(mp3), { targetSampleRate: 22050 })).reader, 5000);
    expect(pcm[0].length).toBe(direct[0].length);
    let maxDiff = 0;
    for (let i = 0; i < pcm[0].length; i++) maxDiff = Math.max(maxDiff, Math.abs(pcm[0][i] - direct[0][i]));
    expect(maxDiff).toBeLessThan(1e-6);
    await reader.close();
    expect(w.created[0].terminated).toBe(true);
    expect(await reader.next(100)).toBeNull();
  });

  it('terminates the worker on abort', async () => {
    const { w, backend } = backendWith();
    const ac = new AbortController();
    const p = backend.analyze(
      blobSource(monoMp3(), 'a.mp3'),
      (f) => {
        if (f > 0.2) ac.abort();
      },
      ac.signal,
    );
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(w.created[0].terminated).toBe(true);
  });

  it('runs at most maxParallel analyses at once', async () => {
    const { w, backend } = backendWith(undefined, { maxParallel: 2 });
    const results = await Promise.all([1, 2, 3, 4].map(() => backend.analyze(blobSource(lsfMp3(), 'c.mp3'))));
    expect(results.map((r) => r.codec)).toEqual(['mp3', 'mp3', 'mp3', 'mp3']);
    expect(w.created).toHaveLength(4);
    expect(w.maxActive).toBe(2);
    // A queued job that is aborted never starts a worker.
    const busy = backend.analyze(blobSource(monoMp3(), 'd.mp3'));
    const busy2 = backend.analyze(blobSource(monoMp3(), 'e.mp3'));
    const ac = new AbortController();
    const queued = backend.analyze(blobSource(monoMp3(), 'f.mp3'), undefined, ac.signal);
    ac.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.all([busy, busy2]);
    expect(w.created).toHaveLength(6);
  });

  it('decodes MP4 with WebCodecs in the worker', async () => {
    const { file, samples } = smallM4b();
    const { backend } = backendWith({ webCodecs: fakeWebCodecs() });
    const a = await backend.analyze(blobSource(file, 'buch.m4b'));
    expect(a).toMatchObject({ codec: 'aac', channels: 2, sampleRate: SR, chapters: [{ startSec: 0, title: 'Anfang' }, { startSec: 0.5, title: 'Schluss' }] });
    expect(a.durationSec).toBeCloseTo(samples / SR, 6);
    const reader = await backend.openPcm(blobSource(file, 'buch.m4b'), { targetSampleRate: 48000 });
    const pcm = await readAllPcm(reader);
    expect(Math.abs(pcm[0].length - (samples * 48000) / SR)).toBeLessThanOrEqual(1);
  });

  it('falls back to the in-memory decoder for formats the worker cannot stream', async () => {
    const calls: number[] = [];
    const decodeInMemory = async (data: ArrayBuffer, sampleRate: number): Promise<InMemoryAudio> => {
      calls.push(data.byteLength);
      return { channels: [sine(sampleRate, 500, 2, 0.3)], sampleRate };
    };
    const { backend } = backendWith(undefined, { decodeInMemory, probeDuration: async () => 2 });
    const a = await backend.analyze(blobSource(webm, 'a.webm'));
    expect(a).toMatchObject({ sampleRate: 22050, channels: 1 }); // analysis decodes at 22.05 kHz to save memory
    expect(a.durationSec).toBeCloseTo(2, 6);
    expect(a.lufs).toBeLessThan(-10);
    const reader = await backend.openPcm(bufferSource(webm, 'a.webm'), { targetSampleRate: 22050 });
    expect(reader.sampleRate).toBe(22050);
    expect((await readAllPcm(reader))[0].length).toBe(44100);
    expect(calls).toEqual([webm.length, webm.length]);
  });

  it('refuses big files for the in-memory fallback before reading them, and says why', async () => {
    let decoded = 0;
    const decodeInMemory = async (): Promise<InMemoryAudio> => {
      decoded++;
      return { channels: [new Float32Array(10)], sampleRate: 44100 };
    };
    // A short video in MKV: few minutes, but its pictures make it far too big to hold.
    const big = backendWith(undefined, { decodeInMemory, probeDuration: async () => 5 * 60, maxInMemoryBytes: webm.length - 1 }).backend;
    const err = await big.check!(blobSource(webm, 'Video.mkv')).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'AudioError', code: 'too-big' });
    // The desktop app does not read WebM either: no word about it.
    expect((err as Error).message).toBe('Diese Datei ist zu groß, um sie im Browser zu öffnen (über 1\u00a0GB). Ist es ein Video, speichere zuerst nur seinen Ton als eigene Datei, zum Beispiel als M4A. Oder wandle die Datei mit einem anderen Programm in MP3 um.');
    await expect(big.analyze(blobSource(webm, 'Video.mkv'))).rejects.toMatchObject({ code: 'too-big' });
    await expect(big.openPcm(blobSource(webm, 'Video.mkv'))).rejects.toMatchObject({ code: 'too-big' });
    expect(decoded).toBe(0);
    // Too big for one piece of memory after all (Chromium from 2 GiB): said in words, not in the browser's.
    const unreadable: ByteSource = { ...blobSource(webm, 'Video.webm'), blob: { slice: (a: number, b: number) => new Blob([webm.slice(a, b) as BlobPart]), arrayBuffer: () => Promise.reject(new DOMException('The requested file could not be read', 'NotReadableError')) } as unknown as Blob };
    const fits = backendWith(undefined, { decodeInMemory, probeDuration: async () => 5 * 60 }).backend;
    await expect(fits.openPcm(unreadable)).rejects.toMatchObject({ name: 'AudioError', code: 'read-failed' });
  });

  it('refuses long files for the in-memory fallback with a German message', async () => {
    let decoded = 0;
    const decodeInMemory = async (): Promise<InMemoryAudio> => {
      decoded++;
      return { channels: [new Float32Array(10)], sampleRate: 44100 };
    };
    const long = backendWith(undefined, { decodeInMemory, probeDuration: async () => 46 * 60 }).backend;
    const err = await long.analyze(blobSource(webm, 'lang.webm')).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'AudioError', code: 'too-long' });
    expect((err as Error).message).toContain('45 Minuten');
    await expect(long.openPcm(blobSource(webm, 'lang.webm'))).rejects.toMatchObject({ code: 'too-long' });
    expect(decoded).toBe(0);
    // Unknown playing time: decoding the start of the file tells it (here 128 kbit/s).
    const huge: ByteSource = {
      name: 'riesig.webm',
      size: 500 << 20,
      read: async (start, length) => {
        const b = new Uint8Array(Math.max(0, Math.min(length, (500 << 20) - start, 1 << 20)));
        if (start === 0) b.set(webm.subarray(0, 4));
        return b;
      },
    };
    const tried: number[] = [];
    const byBytes = async (data: ArrayBuffer, sampleRate: number): Promise<InMemoryAudio> => {
      tried.push(data.byteLength);
      return { channels: [new Float32Array(Math.round((data.byteLength / 16000) * sampleRate))], sampleRate };
    };
    const unknown = backendWith(undefined, { decodeInMemory: byBytes, probeDuration: async () => undefined }).backend;
    await expect(unknown.analyze(huge)).rejects.toMatchObject({ code: 'too-long' });
    expect(tried).toHaveLength(1);
    expect(tried[0]).toBeLessThan(1 << 20); // only the start
  });

  it('passes WMA and copy protection errors through', async () => {
    let decoded = 0;
    const decodeInMemory = async (): Promise<InMemoryAudio> => {
      decoded++;
      return { channels: [new Float32Array(10)], sampleRate: 44100 };
    };
    const { backend } = backendWith({ webCodecs: fakeWebCodecs() }, { decodeInMemory, probeDuration: async () => 1 });
    const wma = Uint8Array.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, ...new Array<number>(60).fill(0)]);
    await expect(backend.analyze(blobSource(wma, 'a.wma'))).rejects.toMatchObject({ code: 'unsupported-format', details: { fallback: false } });
    const drm = buildMp4({ sampleRate: SR, channels: 2, packets: [new Uint8Array(4096)], frameSamples: 1024, entryType: 'drms' });
    await expect(backend.analyze(blobSource(drm, 'a.m4p'))).rejects.toMatchObject({ code: 'drm-protected' });
    await expect(backend.openPcm(blobSource(drm, 'a.m4p'))).rejects.toMatchObject({ code: 'drm-protected' });
    expect(decoded).toBe(0);
  });

  it('checks whether a file can be decoded, without decoding it', async () => {
    let decoded = 0;
    const decodeInMemory = async (): Promise<InMemoryAudio> => {
      decoded++;
      return { channels: [new Float32Array(10)], sampleRate: 44100 };
    };
    const { w, backend } = backendWith({ webCodecs: fakeWebCodecs() }, { decodeInMemory, probeDuration: async () => 60 });
    const mp3 = await backend.check!(blobSource(monoMp3(), 'a.mp3'));
    expect(mp3).toMatchObject({ channels: 1, sampleRate: SR, codec: 'mp3' });
    expect(mp3.durationSec).toBeCloseTo(12, 1);
    await expect(backend.check!(blobSource(smallM4b().file, 'b.m4b'))).resolves.toMatchObject({ codec: 'aac', channels: 2 });
    const drm = buildMp4({ sampleRate: SR, channels: 2, packets: [new Uint8Array(4096)], frameSamples: 1024, entryType: 'drms' });
    await expect(backend.check!(blobSource(drm, 'c.m4p'))).rejects.toMatchObject({ code: 'drm-protected' });
    expect(w.created.every((x) => x.terminated)).toBe(true);

    // A browser without AAC: the page's own decoder does not know it either, so the file is refused right away.
    const noAac = backendWith({ webCodecs: null }, { decodeInMemory, probeDuration: async () => 60, canPlayType: (mime) => !mime.startsWith('audio/mp4') }).backend;
    await expect(noAac.check!(blobSource(smallM4b().file, 'b.m4b'))).rejects.toMatchObject({ code: 'unsupported-format', details: { fallback: false } });
    await expect(noAac.analyze(blobSource(smallM4b().file, 'b.m4b'))).rejects.toMatchObject({ code: 'unsupported-format' });
    await expect(noAac.check!(blobSource(webm, 'd.webm'))).resolves.toEqual({ durationSec: 60, codec: 'opus' });
    const long = backendWith(undefined, { decodeInMemory, probeDuration: async () => 46 * 60, canPlayType: () => true }).backend;
    await expect(long.check!(blobSource(webm, 'e.webm'))).rejects.toMatchObject({ code: 'too-long' });
    expect(decoded).toBe(0);
  });

  it('holds one fallback file in memory at a time, shared by all readers of it', async () => {
    const calls: number[] = [];
    const decodeInMemory = async (_data: ArrayBuffer, sampleRate: number): Promise<InMemoryAudio> => {
      calls.push(sampleRate);
      return { channels: [sine(sampleRate, 500, 2, 0.3)], sampleRate };
    };
    const { backend } = backendWith(undefined, { decodeInMemory, probeDuration: async () => 2 });
    // Two readers of the same file (the lanes of one conversion) share one decoded copy.
    const a = blobSource(webm, 'a.webm');
    const r1 = await backend.openPcm(a, { targetSampleRate: SR });
    const r2 = await backend.openPcm(a, { targetSampleRate: SR });
    expect(calls).toEqual([SR]);
    expect((await readAllPcm(r1))[0].length).toBe(2 * SR);
    expect((await readAllPcm(r2))[0].length).toBe(2 * SR);
    // Another file waits until nobody reads the first one any more.
    let opened = false;
    const next = backend.openPcm(blobSource(webm, 'b.webm'), { targetSampleRate: SR }).then((r) => {
      opened = true;
      return r;
    });
    await tick();
    expect(opened).toBe(false);
    await r1.close();
    await tick();
    expect(opened).toBe(false);
    await r2.close();
    const r3 = await next;
    expect(calls).toEqual([SR, SR]);
    // A wait can be given up.
    const ac = new AbortController();
    const given = backend.openPcm(blobSource(webm, 'c.webm'), { targetSampleRate: SR, signal: ac.signal });
    await tick();
    ac.abort();
    await expect(given).rejects.toMatchObject({ name: 'AbortError' });
    await r3.close();
    // Nothing is held any more.
    await backend.analyze(blobSource(webm, 'd.webm'));
    expect(calls).toEqual([SR, SR, 22050]);
  });

  it('decodes a fallback file once for all lanes of a conversion', async () => {
    const calls: number[] = [];
    const decodeInMemory = async (_data: ArrayBuffer, sampleRate: number): Promise<InMemoryAudio> => {
      calls.push(sampleRate);
      return { channels: [sine(sampleRate, 500, 4, 0.3)], sampleRate };
    };
    const { backend } = backendWith(undefined, { decodeInMemory, probeDuration: async () => 4 });
    const parts = await convertToMp3Parts(backend, blobSource(webm, 'a.webm'), [1, 2, 3], { parallel: 4 });
    expect(parts).toHaveLength(4);
    expect(calls).toEqual([SR]);
    // Let go afterwards: the next file opens right away.
    const reader = await backend.openPcm(blobSource(webm, 'b.webm'));
    expect(calls).toEqual([SR, SR]);
    await reader.close();
  });

  it('hands chained Ogg files to the page decoder with the playing time of all their streams', async () => {
    const lengths: number[] = [];
    const decodeInMemory = async (data: ArrayBuffer, sampleRate: number): Promise<InMemoryAudio> => {
      lengths.push(data.byteLength);
      return { channels: [sine(sampleRate, 440, 8, 0.3)], sampleRate };
    };
    // The tags tell the length of the first stream only.
    const { backend } = backendWith({ webCodecs: fakeWebCodecs() }, { decodeInMemory, probeDuration: async () => 2 });
    const chain = concat([opusFile(1, 2), opusFile(2, 6)]);
    expect((await backend.check!(blobSource(chain, 'buch.opus'))).durationSec).toBeCloseTo((8 * 48000 - 2 * 312) / 48000, 6);
    const pcm = await readAllPcm(await backend.openPcm(blobSource(chain, 'buch.opus'), { targetSampleRate: SR }));
    expect(pcm[0].length).toBe(8 * SR);
    expect(lengths).toEqual([chain.length]);
    const long = concat([opusFile(1, 0.1, 25 * 60 * 48000), opusFile(2, 0.1, 25 * 60 * 48000)]);
    await expect(backend.check!(blobSource(long, 'lang.opus'))).rejects.toMatchObject({ code: 'too-long' });
  });

  it('finds the playing time of WebM recordings whose header does not tell it', async () => {
    let decoded = 0;
    const decodeInMemory = async (): Promise<InMemoryAudio> => {
      decoded++;
      return { channels: [new Float32Array(10)], sampleRate: 44100 };
    };
    const { backend } = backendWith(undefined, { decodeInMemory, probeDuration: async () => undefined });
    // Like MediaRecorder: no Duration element, segment and clusters of unknown size.
    const long = buildWebm({ live: true, clusters: webmClusters(50 * 60) });
    await expect(backend.check!(blobSource(long, 'gute-nacht.webm'))).rejects.toMatchObject({ code: 'too-long' });
    await expect(backend.openPcm(blobSource(long, 'gute-nacht.webm'))).rejects.toMatchObject({ code: 'too-long' });
    const short = await backend.check!(blobSource(buildWebm({ live: true, clusters: webmClusters(30 * 60) }), 'kurz.webm'));
    expect(short.codec).toBe('opus');
    expect(Math.abs((short.durationSec ?? 0) - 30 * 60)).toBeLessThan(2);
    // From a converter: Duration in the header.
    await expect(backend.check!(blobSource(buildWebm({ duration: 46 * 60 * 1000 }), 'lang.webm'))).rejects.toMatchObject({ code: 'too-long' });
    expect(decoded).toBe(0);
  });

  it('refuses already while reading what the page decoder cannot open either', async () => {
    let decoded = 0;
    const decodeInMemory = async (): Promise<InMemoryAudio> => {
      decoded++;
      throw new DOMException('Unable to decode audio data', 'EncodingError');
    };
    // Chrome's answers: a container alone is "maybe", unknown codecs "".
    const canPlayType = (mime: string) => !/codecs="(ac-3|ec-3|samr|speex)"/.test(mime);
    const env = { webCodecs: fakeWebCodecs({ supported: ['mp4a.40.2', 'opus'] }) };
    const { backend } = backendWith(env, { decodeInMemory, probeDuration: async () => 30, canPlayType });
    const mp4 = (entryType: string) => buildMp4({ sampleRate: SR, channels: 2, packets: [new Uint8Array(4096)], frameSamples: 1536, entryType, entryChildren: [] });
    await expect(backend.check!(blobSource(mp4('ac-3'), 'film.m4a'))).rejects.toMatchObject({ code: 'unsupported-format', details: { codec: 'ac3', fallback: false } });
    await expect(backend.check!(blobSource(mp4('samr'), 'memo.m4a'))).rejects.toMatchObject({ code: 'unsupported-format', details: { codec: 'samr', fallback: false } });
    const speexHead = Uint8Array.from([...'Speex   '].map((c) => c.charCodeAt(0)).concat(new Array<number>(72).fill(0)));
    const speex = buildOgg([{ data: speexHead, granule: 0 }, { data: new Uint8Array(40), granule: 0 }, { data: new Uint8Array(38), granule: 320 }], { headerCount: 2 });
    await expect(backend.check!(blobSource(speex, 'alt.ogg'))).rejects.toMatchObject({ code: 'unsupported-format', details: { codec: 'speex', fallback: false } });
    // A file of unknown kind: the page's decoder tries the start of it.
    await expect(backend.check!(blobSource(new Uint8Array(3000).fill(0x42), 'komisch.aac'))).rejects.toMatchObject({ code: 'unsupported-format', details: { fallback: false } });
    expect(decoded).toBe(1);
    await expect(backend.analyze(blobSource(mp4('ac-3'), 'film.m4a'))).rejects.toMatchObject({ code: 'unsupported-format' });
    expect(decoded).toBe(1);
  });

  it('sends people to the desktop app only with files it opens', async () => {
    const never = async (): Promise<InMemoryAudio> => Promise.reject(new Error('not decoded'));
    const reason = async (backend: ReturnType<typeof createBrowserAudioBackend>, code: string, bytes: Uint8Array, name: string) => {
      const err = await backend.check!(blobSource(bytes, name)).catch((e: unknown) => e);
      expect(err).toMatchObject({ code });
      return (err as Error).message;
    };
    // Too long for the page's decoder (a browser without WebCodecs): the desktop app reads M4B, but no WebM or Opus.
    const long = backendWith({ webCodecs: null }, { decodeInMemory: never, probeDuration: async () => 46 * 60, canPlayType: () => true }).backend;
    const book = buildMp4({ sampleRate: SR, channels: 2, packets: [new Uint8Array(400), new Uint8Array(400)], frameSamples: 23 * 60 * SR });
    expect(await reason(long, 'too-long', book, 'buch.m4b')).toContain('Desktop-App');
    expect(await reason(long, 'too-long', webm, 'lang.webm')).not.toContain('Desktop-App');
    expect(await reason(long, 'too-long', opusFile(1, 0.1, 46 * 60 * 48000), 'lang.opus')).not.toContain('Desktop-App');
    // Formats the page's decoder cannot open: the desktop app reads ALAC, but no Opus, AC-3, WMA or unknown files.
    const canPlayType = (mime: string) => !/codecs="(alac|ac-3|opus)"/.test(mime);
    const none = backendWith({ webCodecs: null }, { decodeInMemory: never, probeDuration: async () => 30, canPlayType }).backend;
    const mp4 = (entryType: string) => buildMp4({ sampleRate: SR, channels: 2, packets: [new Uint8Array(4096)], frameSamples: 1024, entryType, entryChildren: [] });
    const refused = (bytes: Uint8Array, name: string) => reason(none, 'unsupported-format', bytes, name);
    expect(await refused(mp4('alac'), 'cd.m4a')).toContain('Desktop-App');
    expect(await refused(opusFile(1, 2), 'a.opus')).not.toContain('Desktop-App');
    expect(await refused(mp4('ac-3'), 'film.m4a')).not.toContain('Desktop-App');
    expect(await refused(Uint8Array.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, ...new Array<number>(60).fill(0)]), 'a.wma')).not.toContain('Desktop-App');
    expect(await refused(new Uint8Array(3000).fill(0x42), 'komisch.aac')).not.toContain('Desktop-App');
  });

  it('accepts a file of unknown kind when the page decoder plays its start, and estimates its length', async () => {
    const decodeInMemory = async (data: ArrayBuffer, sampleRate: number): Promise<InMemoryAudio> => ({
      channels: [new Float32Array(Math.round((data.byteLength / 16000) * sampleRate))], // 128 kbit/s
      sampleRate,
    });
    const { backend } = backendWith(undefined, { decodeInMemory, probeDuration: async () => undefined });
    const short = await backend.check!(blobSource(new Uint8Array(160_000).fill(0x42), 'x.aac'));
    expect(short.durationSec).toBeCloseTo(10, 3);
    const size = 60 * 60 * 16000; // one hour
    const hour: ByteSource = { name: 'stunde.aac', size, read: async (start, length) => new Uint8Array(Math.max(0, Math.min(length, size - start))).fill(0x42) };
    await expect(backend.check!(hour)).rejects.toMatchObject({ code: 'too-long' });
  });

  it('reports a crashed worker', async () => {
    const w = workers(undefined, { crash: true });
    const backend = createBrowserAudioBackend({ createWorker: w.create });
    await expect(backend.analyze(blobSource(lsfMp3(), 'a.mp3'))).rejects.toMatchObject({ code: 'worker-failed' });
    await expect(backend.openPcm(blobSource(lsfMp3(), 'a.mp3'))).rejects.toMatchObject({ code: 'worker-failed' });
    expect(w.created.every((x) => x.terminated)).toBe(true);
  });
});
