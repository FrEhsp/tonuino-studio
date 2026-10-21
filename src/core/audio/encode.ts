/**
 * MP3 encoding for files that are not MP3 yet (M4B, FLAC, WAV…).
 *
 * - Mp3StreamEncoder (mp3encoder.ts, re-exported here): the synchronous
 *   lamejs encoder: push PCM at 44.1 kHz, get MP3 frames; optional mono
 *   downmix, gain and a look-ahead true-peak limiter against clipping.
 * - encodeFromReader: encodes a whole PcmReader, in a Web Worker
 *   (encode.worker.ts) when the environment has workers, inline otherwise.
 * - convertToMp3: the complete job for one file with any AudioBackend:
 *   decode, resample to 44.1 kHz, optional mono, gain for a loudness target,
 *   small ID3 tag, and an "Info" frame with the LAME encoder delay and
 *   padding, so decoded time 0 is the first input sample and cut positions
 *   from the source's analysis apply unchanged to the MP3.
 * - convertToMp3Parts: converting and splitting in one go, with sample-exact
 *   cuts and several parts encoded at the same time. lamejs is the slow step
 *   (about 17× realtime for mono 64 kbps, 9× for stereo 128 kbps per core),
 *   so this is the fast way for long audiobooks. The parts are made roughly
 *   in order, so a consumer that writes them in order never waits long and
 *   can keep the number of finished parts in memory small (beforePart).
 */
import type { AudioAnalysis, AudioBackend, ByteSource, PcmChunk, PcmReader } from '../../platform/types';
import type { WorkerLike } from './browserBackend';
import { abortable, AudioError, checkAborted, deserializeError, isAbortError } from './errors';
import { buildSmallId3, type SmallTags } from './id3';
import { playbackLufs } from './loudness';
import { loadMp3Encoder, MP3_SAMPLE_RATE, Mp3StreamEncoder, type EncoderRequest, type EncoderResponse, type Mp3EncoderOptions } from './mp3encoder';
import { withSampleRate } from './pcm';
import { BlobCollector, transferList } from './source';

export {
  createEncoderWorkerHandler,
  effectiveBitrate,
  LAME_ENCODER_DELAY,
  loadMp3Encoder,
  minBitrateFor,
  MP3_SAMPLE_RATE,
  Mp3StreamEncoder,
  PeakLimiter,
  type EncoderRequest,
  type EncoderResponse,
  type LimiterOptions,
  type Mp3EncoderOptions,
} from './mp3encoder';

/** The encoder as the pipeline sees it: inline or in a worker. start() begins the next file. */
interface EncoderSink {
  start(options: Mp3EncoderOptions): Promise<void>;
  push(chunk: PcmChunk): Promise<Uint8Array[]>;
  finish(): Promise<{ frames: Uint8Array[]; info: Uint8Array }>;
  close(): void;
}

class InlineSink implements EncoderSink {
  private enc: Mp3StreamEncoder | null = null;

  async start(options: Mp3EncoderOptions): Promise<void> {
    await loadMp3Encoder();
    this.enc = new Mp3StreamEncoder(options);
  }

  private encoder(): Mp3StreamEncoder {
    if (!this.enc) throw new AudioError('worker-failed');
    return this.enc;
  }

  async push(chunk: PcmChunk): Promise<Uint8Array[]> {
    const enc = this.encoder();
    enc.push(chunk);
    return enc.takeOutput();
  }

  async finish(): Promise<{ frames: Uint8Array[]; info: Uint8Array }> {
    const enc = this.encoder();
    const frames = enc.finish();
    return { frames, info: enc.infoFrame() };
  }

  close(): void {
    this.enc = null;
  }
}

class WorkerSink implements EncoderSink {
  private seq = 0;
  private readonly waiting = new Map<number, { resolve: (m: EncoderResponse) => void; reject: (e: Error) => void }>();
  private failure: Error | null = null;

  constructor(private readonly worker: WorkerLike) {
    worker.addEventListener('message', (e: MessageEvent) => {
      const msg = e.data as EncoderResponse;
      const w = this.waiting.get(msg.seq);
      if (msg.type === 'error') {
        const err = deserializeError(msg.error);
        if (w) {
          this.waiting.delete(msg.seq);
          w.reject(err);
        } else this.fail(err);
        return;
      }
      if (w) {
        this.waiting.delete(msg.seq);
        w.resolve(msg);
      }
    });
    worker.addEventListener('error', (e: Event) => this.fail(new AudioError('worker-failed', undefined, { cause: e })));
  }

  private fail(err: Error): void {
    this.failure ??= err;
    for (const w of this.waiting.values()) w.reject(err);
    this.waiting.clear();
  }

  async start(options: Mp3EncoderOptions): Promise<void> {
    if (this.failure) throw this.failure;
    this.worker.postMessage({ type: 'init', options } satisfies EncoderRequest, []);
  }

  private request(msg: EncoderRequest, transfer: Transferable[], seq: number): Promise<EncoderResponse> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting.set(seq, { resolve, reject });
      this.worker.postMessage(msg, transfer);
    });
  }

  async push(chunk: PcmChunk): Promise<Uint8Array[]> {
    const seq = ++this.seq;
    const r = await this.request({ type: 'push', seq, channels: chunk.channels, sampleRate: chunk.sampleRate }, transferList(chunk.channels), seq);
    return r.type === 'frames' ? r.frames : [];
  }

  async finish(): Promise<{ frames: Uint8Array[]; info: Uint8Array }> {
    const seq = ++this.seq;
    const r = await this.request({ type: 'finish', seq }, [], seq);
    if (r.type !== 'done') throw new AudioError('worker-failed');
    return { frames: r.frames, info: r.info };
  }

  close(): void {
    this.worker.terminate();
    this.fail(new DOMException('Abgebrochen.', 'AbortError'));
  }
}

function defaultEncoderWorker(): WorkerLike {
  return new Worker(new URL('./encode.worker.ts', import.meta.url), { type: 'module' });
}

export interface EncodeOptions {
  /** Default 128 kbps (raised to 64 mono / 112 stereo, see effectiveBitrate). */
  bitrateKbps?: number;
  /** Mix down to mono (speech). */
  mono?: boolean;
  /** Volume change in dB before encoding (the true peak is limited to -1.5 dBTP, see LIMITER_CEILING_DB). */
  gainDb?: number;
  /** Small text tag for the start of the file. */
  tags?: SmallTags;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Encode in a Web Worker; default: whenever the environment has `Worker`. */
  useWorker?: boolean;
  /** Starts the encoder worker (default: the bundled encode.worker.ts). */
  createWorker?: () => WorkerLike;
}

/** PCM blocks sent to the encoder at once (about 1.5 s). */
const ENCODE_BLOCK = 65536;

function createSink(opts: { useWorker?: boolean; createWorker?: () => WorkerLike }): EncoderSink {
  const useWorker = opts.useWorker ?? (typeof Worker !== 'undefined' || opts.createWorker !== undefined);
  return useWorker ? new WorkerSink((opts.createWorker ?? defaultEncoderWorker)()) : new InlineSink();
}

function encoderOptions(opts: EncodeOptions, inputChannels: number): Mp3EncoderOptions {
  return {
    inputChannels,
    sampleRate: MP3_SAMPLE_RATE,
    bitrateKbps: opts.bitrateKbps ?? 128,
    mono: opts.mono ?? false,
    gainDb: opts.gainDb ?? 0,
  };
}

function asAudioError(err: unknown): unknown {
  if (isAbortError(err) || err instanceof AudioError) return err;
  return new AudioError('decode-failed', undefined, { cause: err });
}

/**
 * Encodes what `pull` delivers (44.1 kHz) with a started sink into one file:
 * [tag] [Info frame with LAME delay/padding] [frames]. A few blocks stay in
 * flight, so decoding and encoding overlap; the results stay in order.
 */
async function encodePcm(
  pull: (maxFrames: number) => Promise<PcmChunk | null>,
  sink: EncoderSink,
  tag: Uint8Array | null,
  signal: AbortSignal | undefined,
  onSamples: (n: number) => void,
): Promise<Blob> {
  const out = new BlobCollector();
  const inFlight: Promise<Uint8Array[]>[] = [];
  let samples = 0;
  for (;;) {
    checkAborted(signal);
    const chunk = await pull(ENCODE_BLOCK);
    if (!chunk) break;
    const n = chunk.channels[0]?.length ?? 0;
    if (n === 0) continue;
    samples += n;
    const p = sink.push(chunk);
    p.catch(() => undefined);
    inFlight.push(p);
    while (inFlight.length > 3) out.push(await (inFlight.shift() as Promise<Uint8Array[]>));
    onSamples(n);
  }
  while (inFlight.length > 0) out.push(await (inFlight.shift() as Promise<Uint8Array[]>));
  checkAborted(signal);
  if (samples === 0) throw new AudioError('no-audio');
  const { frames, info } = await sink.finish();
  out.push(frames);
  return out.toBlob([tag ?? new Uint8Array(0), info]);
}

/**
 * Encodes everything a PcmReader delivers into one MP3 file:
 * [small ID3 tag] [Info frame with LAME delay/padding] [frames]. The reader
 * is resampled to 44.1 kHz when needed, read to the end and closed.
 */
export async function encodeFromReader(reader: PcmReader, opts: EncodeOptions = {}): Promise<Blob> {
  const { signal, onProgress } = opts;
  const source = withSampleRate(reader, MP3_SAMPLE_RATE);
  const sink = createSink(opts);
  const expected = Math.max(1, source.durationSec * MP3_SAMPLE_RATE);
  let done = 0;
  try {
    await sink.start(encoderOptions(opts, source.channels));
    const tag = opts.tags ? buildSmallId3(opts.tags) : null;
    const blob = await encodePcm((n) => source.next(n), sink, tag, signal, (n) => {
      done += n;
      onProgress?.(Math.min(0.99, done / expected));
    });
    onProgress?.(1);
    return blob;
  } catch (err) {
    throw asAudioError(err);
  } finally {
    sink.close();
    await source.close().catch(() => undefined);
  }
}

export interface ConvertOptions extends EncodeOptions {
  /**
   * Loudness target in LUFS (e.g. -18). The file's loudness comes from
   * `analysis` or is measured first (one extra decoding pass). Mono sources
   * count as heard on a player (see playbackLufs).
   */
  targetLufs?: number;
  /** backend.analyze() result for this input, when already at hand. */
  analysis?: AudioAnalysis;
  /** Largest boost for the loudness target in dB (default 20). */
  maxBoostDb?: number;
}

/** Share of the progress bar for measuring the loudness first. */
const ANALYSIS_SHARE = 0.3;

/** Gain for the loudness target plus opts.gainDb; measures the file when no analysis was given. */
async function gainFor(backend: AudioBackend, input: ByteSource, opts: ConvertOptions): Promise<{ gainDb: number; analysis?: AudioAnalysis; measured: boolean }> {
  let gainDb = opts.gainDb ?? 0;
  let analysis = opts.analysis;
  let measured = false;
  if (opts.targetLufs !== undefined) {
    if (!analysis) {
      measured = true;
      analysis = await backend.analyze(input, (f) => opts.onProgress?.(f * ANALYSIS_SHARE), opts.signal);
    }
    const current = playbackLufs(analysis);
    if (current !== undefined) gainDb += Math.max(-30, Math.min(opts.maxBoostDb ?? 20, opts.targetLufs - current));
  }
  return { gainDb, analysis, measured };
}

/**
 * Converts any file the backend can decode into an MP3 for the SD card:
 * 44.1 kHz, constant bitrate, optional mono, loudness target, small tag.
 * Pass the browser backend (createBrowserAudioBackend) or the desktop one.
 */
export async function convertToMp3(backend: AudioBackend, input: ByteSource, opts: ConvertOptions = {}): Promise<Blob> {
  const { gainDb, measured } = await gainFor(backend, input, opts);
  checkAborted(opts.signal);
  const reader = await backend.openPcm(input, { targetSampleRate: MP3_SAMPLE_RATE, signal: opts.signal });
  const base = measured ? ANALYSIS_SHARE : 0;
  return encodeFromReader(reader, {
    ...opts,
    gainDb,
    onProgress: opts.onProgress ? (f) => opts.onProgress?.(base + f * (1 - base)) : undefined,
  });
}

export interface ConvertPartsOptions extends Omit<ConvertOptions, 'tags'> {
  /** Small ID3 tag for each part (e.g. from buildSmallId3), or null for none. */
  tagFor?: (partIndex: number, partCount: number) => Uint8Array | null;
  /**
   * Parts encoded at the same time (default: processor cores - 1, 1 to 4).
   * Each lane takes the next part nobody works on yet. It decodes the file
   * from the start and skips the parts of the other lanes, which costs
   * little next to encoding.
   */
  parallel?: number;
  /**
   * Receives every part as soon as it is done, so it can be written while
   * the others are still being encoded. Parts of different lanes arrive out
   * of order. With onPart the parts are not kept, and the result is empty.
   */
  onPart?: (partIndex: number, blob: Blob) => void;
  /** 0..1 of a part encoded so far. */
  onPartProgress?: (partIndex: number, fraction: number) => void;
  /**
   * Asked before a part is encoded; its lane waits for the promise. A
   * consumer that takes the parts in order resolves it when part
   * `partIndex - n` has been taken, so at most n finished parts wait for it.
   */
  beforePart?: (partIndex: number) => Promise<void>;
}

/** PCM of one reader, handed out up to given sample positions. */
class RangeCursor {
  pos = 0;
  private carry: Float32Array[] | null = null;

  constructor(private readonly reader: PcmReader) {}

  /** The next block that ends at or before `end` (absolute sample position); null at `end` or at the end of the stream. */
  async next(maxFrames: number, end: number): Promise<PcmChunk | null> {
    const room = end - this.pos;
    if (room <= 0) return null;
    const limit = Math.min(Math.max(1, Math.floor(maxFrames)), room);
    let block = this.carry;
    this.carry = null;
    if (!block) {
      const chunk = await this.reader.next(limit);
      if (!chunk) return null;
      block = chunk.channels;
    }
    if ((block[0]?.length ?? 0) > limit) {
      this.carry = block.map((c) => c.subarray(limit));
      block = block.map((c) => c.subarray(0, limit));
    }
    this.pos += block[0]?.length ?? 0;
    return { channels: block, sampleRate: this.reader.sampleRate };
  }
}

/** Frames read at once while a lane skips to its first part. */
const SKIP_BLOCK = 1 << 18;

function defaultParallel(): number {
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  return Math.max(1, Math.min(4, cores - 1));
}

/**
 * Converts a file into several MP3 parts in one go, cut at `cutTimesSec`
 * (seconds of the source, e.g. from planSplits or cutsFromChapters). Like
 * convertToMp3 followed by cutMp3, but the cuts are sample exact, every part
 * is a complete MP3 with its own Info frame, and up to `parallel` parts are
 * encoded at the same time. Returns one Blob per part, in order.
 */
export async function convertToMp3Parts(
  backend: AudioBackend,
  input: ByteSource,
  cutTimesSec: readonly number[],
  opts: ConvertPartsOptions = {},
): Promise<Blob[]> {
  const ctl = new AbortController();
  const outer = opts.signal;
  const onOuterAbort = () => ctl.abort(outer?.reason);
  if (outer?.aborted) ctl.abort(outer.reason);
  else outer?.addEventListener('abort', onOuterAbort, { once: true });
  const signal = ctl.signal;
  const readers = new Set<PcmReader>();
  const open = async (): Promise<PcmReader> => {
    const reader = withSampleRate(await backend.openPcm(input, { targetSampleRate: MP3_SAMPLE_RATE, signal }), MP3_SAMPLE_RATE);
    readers.add(reader);
    return reader;
  };
  const close = async (reader: PcmReader) => {
    readers.delete(reader);
    await reader.close().catch(() => undefined);
  };
  let firstError: unknown = null;
  try {
    const { gainDb, analysis, measured } = await gainFor(backend, input, { ...opts, signal });
    checkAborted(signal);
    const first = await open();
    const total = Math.max(1, Math.round((analysis?.durationSec ?? first.durationSec) * MP3_SAMPLE_RATE));
    const cuts = [...new Set(cutTimesSec.filter((t) => Number.isFinite(t)).map((t) => Math.round(t * MP3_SAMPLE_RATE)))]
      .filter((s) => s > 0 && s < total)
      .sort((a, b) => a - b);
    const starts = [0, ...cuts];
    const ends = [...cuts, Number.POSITIVE_INFINITY];
    const count = starts.length;
    const lengths = starts.map((s, i) => (i < cuts.length ? ends[i] : total) - s);
    const lanes = Math.max(1, Math.min(count, Math.floor(opts.parallel ?? defaultParallel())));
    const encOptions = encoderOptions({ ...opts, gainDb }, first.channels);
    const base = measured ? ANALYSIS_SHARE : 0;
    const blobs: Blob[] = new Array<Blob>(count);
    let encoded = 0;
    let nextPart = 0;
    // One decoder per lane, all opened now: a file the backend holds decoded in memory is then decoded once for all of them.
    const opened = await Promise.allSettled(Array.from({ length: lanes - 1 }, () => open()));
    for (const r of opened) if (r.status === 'rejected') throw r.reason;
    const pool = [first, ...opened.map((r) => (r as PromiseFulfilledResult<PcmReader>).value)];

    // Every lane takes the next part nobody works on yet, so the parts are done about in order.
    const runLane = async (reader: PcmReader): Promise<void> => {
      const cursor = new RangeCursor(reader);
      const sink = createSink(opts);
      try {
        for (let i = nextPart++; i < count; i = nextPart++) {
          const allowed = opts.beforePart?.(i);
          allowed?.catch(() => undefined); // awaited below, after skipping to the part
          while (await cursor.next(SKIP_BLOCK, starts[i])) checkAborted(signal);
          if (allowed) await abortable(allowed, signal);
          let done = 0;
          await sink.start(encOptions);
          const blob = await encodePcm((n) => cursor.next(n, ends[i]), sink, opts.tagFor?.(i, count) ?? null, signal, (n) => {
            done += n;
            encoded += n;
            opts.onPartProgress?.(i, Math.min(0.99, done / Math.max(1, lengths[i])));
            opts.onProgress?.(base + (1 - base) * Math.min(0.99, encoded / total));
          });
          if (opts.onPart) opts.onPart(i, blob);
          else blobs[i] = blob;
        }
      } finally {
        sink.close();
        // A lane that is done lets go of its decoder right away.
        await close(reader);
      }
    };
    await Promise.all(
      pool.map((reader) =>
        runLane(reader).catch((err: unknown) => {
          firstError ??= err;
          ctl.abort();
        }),
      ),
    );
    if (firstError !== null) throw firstError;
    opts.onProgress?.(1);
    return opts.onPart ? [] : blobs;
  } catch (err) {
    throw asAudioError(err);
  } finally {
    outer?.removeEventListener('abort', onOuterAbort);
    await Promise.all([...readers].map(close));
  }
}
