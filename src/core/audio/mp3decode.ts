/**
 * Streaming MP3 decoding with mpg123-decoder (WASM; browsers, workers, Node).
 * The file is fed in small chunks and decoded PCM is handed out on demand,
 * so a 10-hour audiobook never sits decoded in memory.
 */
import { MPEGDecoder } from 'mpg123-decoder';
import type { AudioAnalysis, ByteSource, PcmChunk, PcmReader } from '../../platform/types';
import { AudioError, checkAborted } from './errors';
import { chaptersFromId3, readTags } from './id3';
import { decodeHeader, probeMp3, readU32, type Mp3Probe } from './mp3frames';
import { analyzePcm } from './pcm';
import { PcmQueue } from './pcm';
import { Resampler } from './resample';
import { readChunks } from './source';

/** The part of mpg123-decoder's MPEGDecoder we use (lets tests and workers inject one). */
export interface MpegDecoderLike {
  ready: Promise<void>;
  decode(data: Uint8Array): { channelData: Float32Array[]; samplesDecoded: number; sampleRate: number };
  free(): void;
}

export type MpegDecoderFactory = () => MpegDecoderLike;

export const defaultMpegDecoderFactory: MpegDecoderFactory = () => new MPEGDecoder();

export interface Mp3ReaderOptions {
  signal?: AbortSignal;
  decoderFactory?: MpegDecoderFactory;
  /** Bytes fed to the decoder at once (default 128 KiB ≈ 8 s at 128 kbps). */
  chunkSize?: number;
}

/**
 * The first place in `data` where frames at another sample rate than `rate`
 * begin: a header and the one or two after it agree on version, layer and
 * rate. Files joined from parts at 44.1 and 48 kHz change there. mpg123
 * reports one rate for all samples of a decode call, so the reader feeds the
 * parts in calls of their own.
 */
export function rateChangeAt(data: Uint8Array, rate: number): { at: number; rate: number } | null {
  for (let i = 0; i + 4 <= data.length; i++) {
    if (data[i] !== 0xff || (data[i + 1] & 0xe0) !== 0xe0) continue;
    const h = decodeHeader(readU32(data, i));
    if (!h || h.sampleRate === rate) continue;
    let q = i + h.frameLength;
    let agree = 0;
    while (agree < 2 && q + 4 <= data.length) {
      const next = decodeHeader(readU32(data, q));
      if (!next || next.sampleRate !== h.sampleRate || next.layer !== h.layer || next.version !== h.version) break;
      agree++;
      q += next.frameLength;
    }
    // Near the end of the data one header after it has to do; the next data shows the rest.
    if (agree === 2 || (agree === 1 && q + 4 > data.length)) return { at: i, rate: h.sampleRate };
  }
  return null;
}

export class Mp3PcmReader implements PcmReader {
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationSec: number;
  /** Bytes of the file fed to the decoder so far. */
  bytesRead = 0;
  readonly totalBytes: number;
  private readonly queue: PcmQueue;
  private ended = false;
  private decodedAny = false;
  private resampler: Resampler | null = null;
  /** Sample rate of the frames fed last (see rateChangeAt). */
  private feedRate: number;

  private constructor(
    readonly probe: Mp3Probe,
    private readonly decoder: MpegDecoderLike,
    private readonly chunks: AsyncGenerator<Uint8Array, void, undefined>,
    private readonly signal?: AbortSignal,
  ) {
    this.sampleRate = probe.header.sampleRate;
    this.channels = probe.header.channels;
    this.durationSec = probe.durationSec;
    this.totalBytes = Math.max(1, probe.tags.audioEnd - probe.firstFrame);
    this.queue = new PcmQueue(this.channels);
    this.feedRate = probe.header.sampleRate;
  }

  static async open(source: ByteSource, opts: Mp3ReaderOptions = {}): Promise<Mp3PcmReader> {
    const probe = await probeMp3(source, opts.signal);
    const decoder = (opts.decoderFactory ?? defaultMpegDecoderFactory)();
    await decoder.ready;
    const chunks = readChunks(source, opts.chunkSize ?? 128 * 1024, opts.signal, probe.firstFrame, probe.tags.audioEnd);
    return new Mp3PcmReader(probe, decoder, chunks, opts.signal);
  }

  async next(maxFrames: number): Promise<PcmChunk | null> {
    while (this.queue.available < maxFrames && !this.ended) {
      checkAborted(this.signal);
      const r = await this.chunks.next();
      if (r.done) {
        this.ended = true;
        if (this.resampler) this.queue.push(this.resampler.flush());
        if (!this.decodedAny) throw new AudioError('decode-failed');
        break;
      }
      this.bytesRead += r.value.length;
      // A joined file that changes its sample rate: each rate in a decode call of its own.
      let rest = r.value;
      for (let change = rateChangeAt(rest, this.feedRate); change; change = rateChangeAt(rest, this.feedRate)) {
        if (change.at > 0) this.decode(rest.subarray(0, change.at));
        rest = rest.subarray(change.at);
        this.feedRate = change.rate;
      }
      this.decode(rest);
    }
    const data = this.queue.take(maxFrames);
    return data ? { channels: data, sampleRate: this.sampleRate } : null;
  }

  private decode(bytes: Uint8Array): void {
    let out: { channelData: Float32Array[]; samplesDecoded: number; sampleRate: number };
    try {
      out = this.decoder.decode(bytes);
    } catch (err) {
      throw new AudioError('decode-failed', undefined, { cause: err });
    }
    if (out.samplesDecoded === 0) return;
    this.decodedAny = true;
    // mpg123 always outputs two channels; a mono stream repeats channel 0.
    let channels = out.channelData.slice(0, this.channels).map((c) => (c.length === out.samplesDecoded ? c : c.subarray(0, out.samplesDecoded)));
    if (out.sampleRate !== this.sampleRate) {
      // Rare: a stream that changes its sample rate. Keep one rate for the consumer.
      this.resampler ??= new Resampler(out.sampleRate, this.sampleRate, this.channels);
      if (this.resampler.inRate !== out.sampleRate) {
        this.queue.push(this.resampler.flush());
        this.resampler = new Resampler(out.sampleRate, this.sampleRate, this.channels);
      }
      channels = this.resampler.process(channels);
    }
    this.queue.push(channels);
  }

  /** Fraction of the file decoded so far. */
  progress(): number {
    return Math.min(1, this.bytesRead / this.totalBytes);
  }

  async close(): Promise<void> {
    this.ended = true;
    this.queue.clear();
    await this.chunks.return(undefined);
    try {
      this.decoder.free();
    } catch {
      // already freed
    }
  }
}

export interface AnalyzeOptions {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  windowSec?: number;
  decoderFactory?: MpegDecoderFactory;
}

/** Decodes an MP3 file chunk by chunk and measures power envelope, loudness and chapters. */
export async function analyzeMp3(source: ByteSource, opts: AnalyzeOptions = {}): Promise<AudioAnalysis> {
  const tags = await readTags(source, { maxTagBytes: 16 << 20 });
  const reader = await Mp3PcmReader.open(source, { signal: opts.signal, decoderFactory: opts.decoderFactory });
  try {
    const analysis = await analyzePcm(reader, {
      windowSec: opts.windowSec,
      onProgress: opts.onProgress,
      signal: opts.signal,
      progressOf: () => reader.progress(),
    });
    const chapters = tags.id3v2 ? chaptersFromId3(tags.id3v2).map((c) => ({ startSec: c.startSec, title: c.title })) : [];
    const audioBytes = reader.probe.tags.audioEnd - reader.probe.firstFrame;
    return {
      ...analysis,
      chapters: chapters.length > 0 ? chapters : undefined,
      codec: 'mp3',
      bitrateKbps: analysis.durationSec > 0 ? Math.round((audioBytes * 8) / analysis.durationSec / 1000) : undefined,
    };
  } finally {
    await reader.close();
  }
}
