import { describe, expect, it } from 'vitest';
import type { AudioBackend, PcmChunk, PcmReader } from '../../src/platform/types';
import { analyzeAudio, openAudio } from '../../src/core/audio/decode';
import { convertToMp3, convertToMp3Parts, encodeFromReader } from '../../src/core/audio/encode';
import { AudioError } from '../../src/core/audio/errors';
import { buildSmallId3, parseId3v2 } from '../../src/core/audio/id3';
import { albumLoudness, playbackLufs } from '../../src/core/audio/loudness';
import {
  createEncoderWorkerHandler,
  effectiveBitrate,
  LAME_ENCODER_DELAY,
  loadMp3Encoder,
  Mp3StreamEncoder,
  PeakLimiter,
  type EncoderRequest,
  type LimiterOptions,
  type EncoderResponse,
} from '../../src/core/audio/mp3encoder';
import { decodeHeader, readU32, scanMp3 } from '../../src/core/audio/mp3frames';
import { ArrayPcmReader, readAllPcm } from '../../src/core/audio/pcm';
import { bufferSource } from '../../src/core/audio/source';
import { encodeWav16 } from '../../src/core/audio/wav';
import type { WorkerLike } from '../../src/core/audio/browserBackend';
import { blobBytes, concat, decodeMp3, rmsDb, sine, synth, toneAmplitude } from './helpers';

await loadMp3Encoder();

const SR = 44100;

function encodeAll(channels: Float32Array[], opts: { bitrateKbps?: number; mono?: boolean; gainDb?: number }): { file: Uint8Array; enc: Mp3StreamEncoder } {
  const enc = new Mp3StreamEncoder({ inputChannels: channels.length, sampleRate: SR, ...opts });
  const parts: Uint8Array[] = [];
  const n = channels[0].length;
  for (let i = 0; i < n; i += 10000) {
    enc.push({ channels: channels.map((c) => c.subarray(i, i + 10000)), sampleRate: SR });
    parts.push(...enc.takeOutput());
  }
  parts.push(...enc.finish());
  return { file: concat([enc.infoFrame(), ...parts]), enc };
}

/** First 1 ms window whose RMS exceeds half of `level`. */
function onsetSec(x: Float32Array, level: number, from = 0): number {
  const w = Math.round(SR / 1000);
  for (let i = Math.floor(from * SR); i + w <= x.length; i += 8) {
    let s = 0;
    for (let k = i; k < i + w; k++) s += x[k] * x[k];
    if (Math.sqrt(s / w) > level / 2) return i / SR;
  }
  return Number.NaN;
}

/** Real audio work: a test takes a second or two alone, much longer while the whole suite keeps the machine busy. */
const SLOW = { timeout: 30_000 };

describe('effectiveBitrate', () => {
  it('keeps lamejs at 44.1 kHz and snaps to valid rates', () => {
    expect(effectiveBitrate(32, 1)).toBe(64);
    expect(effectiveBitrate(96, 1)).toBe(96);
    expect(effectiveBitrate(96, 2)).toBe(112);
    expect(effectiveBitrate(100, 2)).toBe(112);
    expect(effectiveBitrate(129, 2)).toBe(160);
    expect(effectiveBitrate(999, 2)).toBe(320);
  });
});

describe('PeakLimiter', () => {
  it('passes quiet audio unchanged and keeps the length', () => {
    const x = sine(SR, 440, 0.3, 0.5);
    const lim = new PeakLimiter(SR, 1);
    const out = concat([
      ...[0, 5000, 9000].map((s, k, a) => new Uint8Array(lim.process([x.subarray(s, a[k + 1] ?? x.length)])[0].buffer)),
      new Uint8Array(lim.flush()[0].buffer),
    ]);
    const y = new Float32Array(out.buffer);
    expect(y.length).toBe(x.length);
    expect(Array.from(y)).toEqual(Array.from(x));
  });

  it('keeps boosted peaks under the ceiling', () => {
    const x = synth(SR, [{ sec: 0.2, freq: 300, amp: 0.2 }, { sec: 0.3, freq: 300, amp: 1.8 }, { sec: 0.5, freq: 300, amp: 0.2 }]);
    const lim = new PeakLimiter(SR, 1, { thresholdDb: -1 });
    const a = lim.process([x])[0];
    const b = lim.flush()[0];
    const y = new Float32Array(a.length + b.length);
    y.set(a);
    y.set(b, a.length);
    expect(y.length).toBe(x.length);
    let peak = 0;
    for (const v of y) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(10 ** (-1 / 20) + 1e-6);
    // The quiet part before the loud burst is untouched (apart from the 5 ms look-ahead).
    expect(y[1000]).toBeCloseTo(x[1000], 6);
    // After the release the level comes back.
    expect(rmsDb(y, Math.round(0.9 * SR), x.length)).toBeCloseTo(rmsDb(x, Math.round(0.9 * SR), x.length), 0);
  });

  it('counts the peaks between the samples', () => {
    // A quarter of the sample rate at 45 degrees: the samples reach 0.71, the wave 1.0.
    const x = Float32Array.from({ length: SR / 2 }, (_, i) => Math.sin((Math.PI / 2) * i + Math.PI / 4));
    const samplesOnly = new PeakLimiter(SR, 1, { truePeak: false });
    const plain = [...samplesOnly.process([x])[0], ...samplesOnly.flush()[0]];
    expect(Math.max(...plain.map(Math.abs))).toBeCloseTo(Math.SQRT1_2, 5);
    const lim = new PeakLimiter(SR, 1);
    const y = [...lim.process([x])[0], ...lim.flush()[0]];
    expect(y.length).toBe(x.length);
    // Wave peak = sample peak · √2 for this tone: under -1.5 dBTP, with the filter's small error.
    const samplePeak = Math.max(...y.slice(2000).map(Math.abs));
    expect(samplePeak * Math.SQRT2).toBeLessThan(10 ** (-1.5 / 20) * 1.01);
    expect(samplePeak * Math.SQRT2).toBeGreaterThan(10 ** (-1.5 / 20) * 0.95);
  });

  it('works for very short inputs', () => {
    const lim = new PeakLimiter(SR, 2);
    const a = lim.process([new Float32Array([0.1, 0.2]), new Float32Array([0.3, 0.4])]);
    const b = lim.flush();
    expect(a[0].length + b[0].length).toBe(2);
    expect(Array.from(b[1])).toEqual([Math.fround(0.3), Math.fround(0.4)]);
  });
});

describe('Mp3StreamEncoder', SLOW, () => {
  it('writes an Info frame with LAME delay and padding, so gapless decoding is sample exact', async () => {
    const x = synth(SR, [{ sec: 0.5 }, { sec: 1, freq: 440, amp: 0.5 }, { sec: 0.5 }]);
    const { file, enc } = encodeAll([x], { bitrateKbps: 64 });
    const idx = await scanMp3(bufferSource(file));
    expect(idx).toMatchObject({ sampleRate: SR, channels: 1, cbr: true, bitrateKbps: 64, version: 1 });
    expect(idx.xing).toMatchObject({ kind: 'Info', frames: idx.frameCount });
    expect(idx.lame?.encoderDelay).toBe(LAME_ENCODER_DELAY);
    expect(idx.lame?.encoder).toBe('LAME3.98r');
    expect(idx.frameCount).toBe(enc.frames);
    expect(idx.durationSec).toBeCloseTo(x.length / SR, 9);
    const dec = await decodeMp3(file);
    expect(dec.samplesDecoded).toBe(x.length);
    expect(onsetSec(dec.channelData[0], 0.5 / Math.SQRT2)).toBeCloseTo(0.5, 2);
  });

  it('keeps 44.1 kHz stereo when a too small bitrate is asked for', async () => {
    const l = sine(SR, 440, 1, 0.3);
    const r = sine(SR, 660, 1, 0.3);
    const { file, enc } = encodeAll([l, r], { bitrateKbps: 64 });
    expect(enc.bitrateKbps).toBe(112);
    const h = decodeHeader(readU32(file, 0));
    expect(h).toMatchObject({ sampleRate: SR, channels: 2, bitrateKbps: 112 });
    const dec = await decodeMp3(file);
    expect(dec.samplesDecoded).toBe(l.length);
  });

  it('mixes to mono and applies gain', async () => {
    const x = sine(SR, 500, 1, 0.4);
    const ref = encodeAll([x, x], { mono: true });
    const quiet = encodeAll([x, x], { mono: true, gainDb: -6 });
    expect(decodeHeader(readU32(ref.file, 0))?.channelMode).toBe(3);
    const a = (await decodeMp3(ref.file)).channelData[0];
    const b = (await decodeMp3(quiet.file)).channelData[0];
    expect(rmsDb(a, 4410, 40000)).toBeCloseTo(rmsDb(x, 4410, 40000), 0);
    expect(rmsDb(a, 4410, 40000) - rmsDb(b, 4410, 40000)).toBeCloseTo(6, 0);
  });

  it('limits a big boost instead of clipping', async () => {
    const x = sine(SR, 300, 1, 0.5);
    const { file } = encodeAll([x], { gainDb: 12 });
    const y = (await decodeMp3(file)).channelData[0];
    let peak = 0;
    for (let i = 2000; i < y.length - 2000; i++) peak = Math.max(peak, Math.abs(y[i]));
    expect(peak).toBeLessThan(1);
    // The ceiling is -1.5 dBTP (0.84); the codec takes a little off a pure tone.
    expect(peak).toBeGreaterThan(0.75);
  });

  it('keeps the decoded MP3 under 0 dBFS where the wave goes higher between its samples', async () => {
    // Bass, a bright tone and noise, driven hard into the ceiling and cut off there:
    // flat tops whose wave rises above the samples, as in a loud download.
    const n = SR * 4;
    const x = new Float32Array(n);
    let seed = 7;
    let noise = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      noise += 0.3 * (seed / 2 ** 32 - 0.5 - noise);
      let saw = 0;
      for (let k = 1; k <= 30; k++) saw += Math.sin(2 * Math.PI * 220 * k * t) / k;
      const beat = t % 0.5 < 0.1 ? 1 : 0.5;
      x[i] = Math.max(-1, Math.min(1, 4 * (0.45 * Math.sin(2 * Math.PI * 55 * t) * beat + 0.2 * saw + 0.5 * noise)));
    }
    const decodedPeak = async (limiter?: LimiterOptions) => {
      const enc = new Mp3StreamEncoder({ inputChannels: 1, sampleRate: SR });
      // The limiter as it was up to 0.4 (samples only, -1 dBFS) for the comparison.
      if (limiter) (enc as unknown as { limiter: PeakLimiter }).limiter = new PeakLimiter(SR, 1, limiter);
      enc.push({ channels: [x], sampleRate: SR });
      const frames = enc.finish();
      expect(enc.bitrateKbps).toBe(128);
      const y = (await decodeMp3(concat([enc.infoFrame(), ...frames]))).channelData[0];
      let peak = 0;
      for (let i = 3000; i < y.length - 3000; i++) peak = Math.max(peak, Math.abs(y[i]));
      return peak;
    };
    expect(await decodedPeak({ truePeak: false, thresholdDb: -1 })).toBeGreaterThan(1);
    expect(await decodedPeak()).toBeLessThan(10 ** (-0.3 / 20));
  });
});

/** A WorkerLike running the encoder handler in this thread over a MessageChannel. */
function fakeEncoderWorker(): WorkerLike & { terminated: boolean } {
  const channel = new MessageChannel();
  const handle = createEncoderWorkerHandler((msg, transfer) => channel.port2.postMessage(msg, transfer));
  channel.port2.onmessage = (e: MessageEvent<EncoderRequest>) => handle(e.data);
  const w = {
    terminated: false,
    postMessage: (m: unknown, t: Transferable[]) => channel.port1.postMessage(m, t),
    addEventListener: (type: string, l: (e: MessageEvent) => void) => {
      if (type === 'message') channel.port1.addEventListener('message', l as (e: MessageEvent<EncoderResponse>) => void);
      channel.port1.start();
    },
    terminate: () => {
      w.terminated = true;
      channel.port1.close();
    },
  };
  return w as WorkerLike & { terminated: boolean };
}

describe('encodeFromReader', SLOW, () => {
  it('resamples, tags and encodes a reader (inline)', async () => {
    const x = sine(48000, 440, 2, 0.3);
    const progress: number[] = [];
    const blob = await encodeFromReader(new ArrayPcmReader([x, x], 48000), {
      bitrateKbps: 128,
      tags: { title: 'Kapitel 1', album: 'Buch' },
      onProgress: (f) => progress.push(f),
      useWorker: false,
    });
    const bytes = await blobBytes(blob);
    const tag = parseId3v2(bytes);
    expect(tag?.tags).toMatchObject({ title: 'Kapitel 1', album: 'Buch' });
    const idx = await scanMp3(bufferSource(bytes));
    expect(idx.audioStart).toBe(tag?.size);
    expect(idx).toMatchObject({ sampleRate: 44100, channels: 2, cbr: true, bitrateKbps: 128 });
    expect(idx.durationSec).toBeCloseTo(2, 3);
    expect(progress[progress.length - 1]).toBe(1);
  });

  it('runs the encoder in a worker and gives the same result', async () => {
    const x = sine(SR, 330, 1.5, 0.3);
    const worker = fakeEncoderWorker();
    const viaWorker = await blobBytes(await encodeFromReader(new ArrayPcmReader([x], SR), { bitrateKbps: 96, createWorker: () => worker }));
    const inline = await blobBytes(await encodeFromReader(new ArrayPcmReader([x], SR), { bitrateKbps: 96, useWorker: false }));
    expect(worker.terminated).toBe(true);
    expect(viaWorker).toEqual(inline);
  });

  it('stops on abort', async () => {
    const x = sine(SR, 330, 3, 0.3);
    const ac = new AbortController();
    const p = encodeFromReader(new ArrayPcmReader([x], SR), {
      useWorker: false,
      signal: ac.signal,
      onProgress: (f) => {
        if (f > 0.3) ac.abort();
      },
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

/** An AudioBackend built from the Node-capable decoders (WAV, MP3). */
function nodeBackend(): AudioBackend {
  return {
    analyze: (input, onProgress, signal) => analyzeAudio(input, { onProgress, signal, env: { webCodecs: null } }),
    openPcm: async (input, opts) => (await openAudio(input, { targetSampleRate: opts?.targetSampleRate, env: { webCodecs: null } })).reader,
  };
}

describe('convertToMp3', SLOW, () => {
  const speech = synth(48000, [
    { sec: 1.5, freq: 300, amp: 0.05 },
    { sec: 0.5 },
    { sec: 2, freq: 500, amp: 0.08 },
    { sec: 0.5 },
    { sec: 1.5, freq: 400, amp: 0.06 },
  ]);
  const wav = encodeWav16([speech, speech], 48000);

  it('converts WAV to a 44.1 kHz MP3 at a loudness target', async () => {
    const backend = nodeBackend();
    const steps: number[] = [];
    const blob = await convertToMp3(backend, bufferSource(wav, 'kapitel.wav'), {
      bitrateKbps: 128,
      targetLufs: -20,
      tags: { title: 'Kapitel', track: 1 },
      onProgress: (f) => steps.push(f),
    });
    const mp3 = bufferSource(await blobBytes(blob), 'kapitel.mp3');
    const idx = await scanMp3(mp3);
    expect(idx).toMatchObject({ sampleRate: 44100, channels: 2 });
    expect(idx.durationSec).toBeCloseTo(speech.length / 48000, 2);
    const after = await analyzeAudio(mp3);
    expect(playbackLufs(after)).toBeCloseTo(-20, 0);
    expect(steps.every((v, i) => i === 0 || v >= steps[i - 1])).toBe(true);
    expect(steps[steps.length - 1]).toBe(1);
  });

  it('keeps the heard loudness when mixing to mono, and reuses a given analysis', async () => {
    const backend = nodeBackend();
    const input = bufferSource(wav, 'kapitel.wav');
    const analysis = await backend.analyze(input);
    let analyzed = 0;
    const counting: AudioBackend = { ...backend, analyze: async (...a) => (analyzed++, backend.analyze(...a)) };
    const blob = await convertToMp3(counting, input, { mono: true, bitrateKbps: 64, targetLufs: -18, analysis });
    expect(analyzed).toBe(0);
    const mp3 = bufferSource(await blobBytes(blob));
    const after = await analyzeAudio(mp3);
    expect(after.channels).toBe(1);
    expect(playbackLufs(after)).toBeCloseTo(-18, 0);
  });
});

describe('convertToMp3Parts', SLOW, () => {
  const tones = [
    { sec: 1.2, freq: 440, amp: 0.2 },
    { sec: 0.9, freq: 660, amp: 0.2 },
    { sec: 1.4, freq: 880, amp: 0.2 },
    { sec: 0.7, freq: 550, amp: 0.2 },
  ];
  const x = synth(48000, tones); // resampled to 44.1 kHz on the way
  const wav = encodeWav16([x, x], 48000);
  const cuts = [1.2, 2.1, 3.5];
  const options = { bitrateKbps: 64, mono: true, useWorker: false, tagFor: (i: number, n: number) => buildSmallId3({ title: `Teil ${i + 1}`, track: `${i + 1}/${n}` }) };

  /** Backend that counts opened and closed readers. */
  function counting(inner: AudioBackend) {
    const stats = { opened: 0, closed: 0 };
    const backend: AudioBackend = {
      analyze: (...a) => inner.analyze(...a),
      openPcm: async (input, opts) => {
        const r = await inner.openPcm(input, opts);
        stats.opened++;
        return { sampleRate: r.sampleRate, channels: r.channels, durationSec: r.durationSec, next: (n) => r.next(n), close: () => (stats.closed++, r.close()) };
      },
    };
    return { backend, stats };
  }

  it('cuts sample exactly and encodes parts in parallel lanes', async () => {
    const { backend, stats } = counting(nodeBackend());
    const progress: number[] = [];
    const parts = await convertToMp3Parts(backend, bufferSource(wav, 'buch.wav'), [...cuts, 99, -1, 2.1], {
      ...options,
      parallel: 3,
      onProgress: (f) => progress.push(f),
    });
    expect(parts).toHaveLength(4);
    expect(stats).toEqual({ opened: 3, closed: 3 });
    expect(progress.every((v, i) => i === 0 || v >= progress[i - 1])).toBe(true);
    expect(progress[progress.length - 1]).toBe(1);
    const total = (await readAllPcm((await openAudio(bufferSource(wav), { targetSampleRate: 44100 })).reader))[0].length;
    const bounds = [0, ...cuts.map((t) => Math.round(t * 44100)), total];
    for (const [i, part] of parts.entries()) {
      const bytes = await blobBytes(part);
      expect(parseId3v2(bytes)?.tags).toEqual({ title: `Teil ${i + 1}`, track: `${i + 1}/4` });
      const idx = await scanMp3(bufferSource(bytes));
      expect(idx).toMatchObject({ sampleRate: 44100, channels: 1, bitrateKbps: 64, lame: { encoderDelay: 576 } });
      const dec = await decodeMp3(bytes);
      expect(dec.samplesDecoded).toBe(bounds[i + 1] - bounds[i]); // sample exact
      const y = dec.channelData[0];
      const mid = [Math.round(y.length * 0.2), Math.round(y.length * 0.8)] as const;
      const own = toneAmplitude(y, 44100, tones[i].freq, ...mid);
      expect(own).toBeGreaterThan(0.15);
      for (const t of tones) if (t !== tones[i]) expect(toneAmplitude(y, 44100, t.freq, ...mid)).toBeLessThan(own / 20);
    }
    // The lanes do not change the result.
    const single = await convertToMp3Parts(nodeBackend(), bufferSource(wav), cuts, { ...options, parallel: 1 });
    for (let i = 0; i < 4; i++) expect(await blobBytes(single[i])).toEqual(await blobBytes(parts[i]));
  });

  it('hands each part over as soon as it is done', async () => {
    const handed: Blob[] = [];
    const order: number[] = [];
    const result = await convertToMp3Parts(nodeBackend(), bufferSource(wav), cuts, {
      ...options,
      parallel: 2,
      onPart: (i, blob) => {
        order.push(i);
        handed[i] = blob;
      },
    });
    expect(result).toEqual([]);
    expect([...order].sort()).toEqual([0, 1, 2, 3]);
    const kept = await convertToMp3Parts(nodeBackend(), bufferSource(wav), cuts, { ...options, parallel: 2 });
    for (let i = 0; i < 4; i++) expect(await blobBytes(handed[i])).toEqual(await blobBytes(kept[i]));
  });

  it('uses one encoder worker per lane and reaches the loudness target', async () => {
    const created: (WorkerLike & { terminated: boolean })[] = [];
    const backend = nodeBackend();
    const input = bufferSource(wav, 'buch.wav');
    const analysis = await backend.analyze(input);
    const parts = await convertToMp3Parts(backend, input, cuts, {
      ...options,
      useWorker: undefined,
      parallel: 2,
      targetLufs: -20,
      analysis,
      createWorker: () => {
        const w = fakeEncoderWorker();
        created.push(w);
        return w;
      },
    });
    expect(created).toHaveLength(2);
    expect(created.every((w) => w.terminated)).toBe(true);
    // One gain for the whole file: together the parts sound as loud as the target.
    const analyses = await Promise.all(parts.map(async (p) => analyzeAudio(bufferSource(await blobBytes(p)))));
    expect(albumLoudness(analyses)).toBeCloseTo(-20, 0);
  });

  it('stops every lane on abort and closes all readers', async () => {
    const { backend, stats } = counting(nodeBackend());
    const ac = new AbortController();
    const p = convertToMp3Parts(backend, bufferSource(wav), cuts, {
      ...options,
      parallel: 2,
      signal: ac.signal,
      onProgress: (f) => {
        if (f > 0.3) ac.abort();
      },
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(stats.opened).toBe(stats.closed);
  });

  it('reports the error of a failing lane', async () => {
    const inner = nodeBackend();
    let opened = 0;
    const backend: AudioBackend = {
      analyze: inner.analyze,
      openPcm: async (input, opts) => {
        if (++opened === 2) throw new AudioError('read-failed');
        return inner.openPcm(input, opts);
      },
    };
    await expect(convertToMp3Parts(backend, bufferSource(wav), cuts, { ...options, parallel: 2 })).rejects.toMatchObject({ code: 'read-failed' });
  });
});

describe('time alignment after conversion', SLOW, () => {
  it('pauses found in the source are at the same time in the MP3', async () => {
    const x = synth(SR, [{ sec: 1, freq: 440 }, { sec: 1 }, { sec: 1, freq: 440 }]);
    const reader: PcmReader = new ArrayPcmReader([x], SR);
    const bytes = await blobBytes(await encodeFromReader(reader, { useWorker: false, bitrateKbps: 64 }));
    const dec = await decodeMp3(bytes);
    // The silence starts at 1.0 s and the tone returns at 2.0 s in the decoded MP3, too.
    expect(onsetSec(dec.channelData[0], 0.3 / Math.SQRT2, 1.5)).toBeCloseTo(2, 2);
    expect(rmsDb(dec.channelData[0], Math.round(1.05 * SR), Math.round(1.95 * SR))).toBeLessThan(-60);
  });

  it('accepts chunks of any size', () => {
    const enc = new Mp3StreamEncoder({ inputChannels: 1 });
    const chunk = (n: number): PcmChunk => ({ channels: [new Float32Array(n)], sampleRate: SR });
    for (const n of [1, 7, 1152, 30000, 3]) enc.push(chunk(n));
    enc.finish();
    expect(enc.samples).toBe(1 + 7 + 1152 + 30000 + 3);
    expect(() => enc.push(chunk(5))).toThrow();
  });
});
