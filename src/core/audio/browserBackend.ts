/**
 * AudioBackend for the browser build.
 *
 * analyze() and openPcm() run in a Web Worker (analyze.worker.ts), one
 * worker per job, so long files never block the page and an abort simply
 * terminates the worker. The worker streams MP3 through mpg123-decoder,
 * WAV/AIFF directly and MP4/M4B, AAC, FLAC and Ogg through WebCodecs;
 * nothing is held decoded in memory, so a 10-hour audiobook works.
 *
 * Formats the worker cannot stream (WebM, codecs this browser's WebCodecs
 * lacks) fall back to AudioContext.decodeAudioData on the page, which holds
 * the whole file and the whole decoded file in memory: allowed up to 45
 * minutes and 1 GiB (a video in MKV or WebM brings its pictures along), other
 * files get the German 'too-long' or 'too-big' error. Only one file is held like that at a
 * time, and all readers of it share it (the lanes of convertToMp3Parts).
 * analyze() decodes those at 22.05 kHz to halve the memory. The desktop app
 * passes its own Rust AudioBackend to the same functions instead.
 */
import type { AudioAnalysis, AudioBackend, ByteSource, PcmChunk, PcmReader } from '../../platform/types';
import { abortable, AudioError, checkAborted, deserializeError, isAbortError, type AudioErrorDetails } from './errors';
import { analyzePcm, ArrayPcmReader, PcmQueue, withSampleRate } from './pcm';
import { readRange } from './source';
import { sourceRef, type AnalysisRequest, type AnalysisResponse } from './workerProtocol';

/** The parts of a Worker the backend uses (a fake can stand in for tests). */
export interface WorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (e: Event) => void): void;
  terminate(): void;
}

export interface InMemoryAudio {
  channels: Float32Array[];
  sampleRate: number;
}

export interface BrowserAudioBackendOptions {
  /** Starts an analysis worker; default: the bundled analyze.worker.ts. */
  createWorker?: () => WorkerLike;
  /** analyze() jobs running at the same time (default: cores - 1, 1 to 4). */
  maxParallel?: number;
  /** Longest file decoded completely in memory, in seconds (default 45 minutes). */
  maxInMemorySec?: number;
  /** Largest file read completely into memory for that, in bytes (default MAX_IN_MEMORY_FILE_BYTES). */
  maxInMemoryBytes?: number;
  /** In-memory decoder for the fallback; default: OfflineAudioContext.decodeAudioData. */
  decodeInMemory?: (data: ArrayBuffer, sampleRate: number) => Promise<InMemoryAudio>;
  /** Playing time for the fallback's length check; default: music-metadata. */
  probeDuration?: (source: ByteSource) => Promise<number | undefined>;
  /** Whether the page's own decoder knows a MIME type; default: HTMLMediaElement.canPlayType (true without a DOM). */
  canPlayType?: (mime: string) => boolean;
  /** Analysis window in seconds (default 0.01). */
  windowSec?: number;
}

export const MAX_IN_MEMORY_SEC = 45 * 60;

/** Size limit for the fallback when the playing time is unknown (≈ 45 min of FLAC). */
const MAX_IN_MEMORY_BYTES = 400 << 20;

/**
 * Largest file the fallback reads into memory, whatever its playing time: a
 * short video can be gigabytes. Chromium cannot read 2 GiB or more into one
 * ArrayBuffer at all (NotReadableError); 1 GiB stays clear of that and of
 * what a phone can hold next to the decoded sound. A 1 GiB MKV of 5 minutes
 * took 2.4 s in Chromium.
 */
export const MAX_IN_MEMORY_FILE_BYTES = 1 << 30;

/**
 * Bytes the page's decoder tries when it is not clear whether it knows a file
 * (unknown kind or codec) or how long the file plays.
 */
const TRIAL_BYTES = 512 << 10;

/**
 * Rate the fallback decodes at for analyze(): half the memory of 44.1 kHz,
 * and loudness and pauses come out the same (speech has little energy above 11 kHz).
 */
const FALLBACK_ANALYSIS_RATE = 22050;

function defaultWorker(): WorkerLike {
  return new Worker(new URL('./analyze.worker.ts', import.meta.url), { type: 'module' });
}

async function decodeWithAudioContext(data: ArrayBuffer, sampleRate: number): Promise<InMemoryAudio> {
  if (typeof OfflineAudioContext === 'undefined') throw new AudioError('unsupported-format');
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(data);
  } catch (err) {
    throw new AudioError('unsupported-format', undefined, { cause: err });
  }
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return { channels, sampleRate: buffer.sampleRate };
}

async function durationFromMetadata(source: ByteSource): Promise<number | undefined> {
  if (!source.blob) return undefined;
  try {
    const { parseBlob } = await import('music-metadata');
    const meta = await parseBlob(source.blob, { duration: false, skipCovers: true });
    return meta.format.duration;
  } catch {
    return undefined;
  }
}

/** Limits how many jobs run at once. */
class Slots {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        signal?.removeEventListener('abort', onAbort);
        this.active++;
        resolve();
      };
      const onAbort = () => {
        this.waiting = this.waiting.filter((w) => w !== go);
        reject(signal?.reason ?? new DOMException('Abgebrochen.', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(go);
    });
  }

  release(): void {
    this.active--;
    this.waiting.shift()?.();
  }
}

/** A file decoded completely in memory, with everyone who reads it. */
interface HeldFile {
  input: ByteSource;
  sampleRate: number;
  users: number;
  /** The slot is taken (from the start of the decode until the file is let go). */
  holding: boolean;
  stop: AbortController;
  audio: Promise<InMemoryAudio>;
}

/**
 * Files decoded completely in memory for the fallback. A decoded file can
 * take a gigabyte, so there is one at a time: readers of the same file at the
 * same rate share it, readers of other files wait until it is let go.
 */
class InMemoryFiles {
  private readonly slot = new Slots(1);
  private readonly files: HeldFile[] = [];

  /** The decoded file (decoded by `load` unless it is held already) and the function that lets go of it. */
  async use(
    input: ByteSource,
    sampleRate: number,
    load: (signal: AbortSignal) => Promise<InMemoryAudio>,
    signal?: AbortSignal,
  ): Promise<{ audio: InMemoryAudio; release: () => void }> {
    checkAborted(signal);
    const file = this.files.find((f) => f.input === input && f.sampleRate === sampleRate) ?? this.start(input, sampleRate, load);
    file.users++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.leave(file);
    };
    try {
      return { audio: await abortable(file.audio, signal), release };
    } catch (err) {
      release();
      throw err;
    }
  }

  private start(input: ByteSource, sampleRate: number, load: (signal: AbortSignal) => Promise<InMemoryAudio>): HeldFile {
    const stop = new AbortController();
    const file: HeldFile = { input, sampleRate, users: 0, holding: false, stop, audio: Promise.resolve({ channels: [], sampleRate }) };
    file.audio = (async () => {
      await this.slot.acquire(stop.signal);
      file.holding = true;
      const audio = await load(stop.signal);
      checkAborted(stop.signal); // everyone gave up while it was decoded
      return audio;
    })();
    file.audio.catch(() => {
      this.forget(file);
      this.free(file);
    });
    this.files.push(file);
    return file;
  }

  private leave(file: HeldFile): void {
    if (--file.users > 0) return;
    this.forget(file);
    file.stop.abort();
    void file.audio.then(
      () => this.free(file),
      () => this.free(file),
    );
    // A reader that is kept after close() must not keep the decoded file alive.
    file.audio = Promise.resolve({ channels: [], sampleRate: file.sampleRate });
  }

  private forget(file: HeldFile): void {
    const i = this.files.indexOf(file);
    if (i >= 0) this.files.splice(i, 1);
  }

  private free(file: HeldFile): void {
    if (!file.holding) return;
    file.holding = false;
    this.slot.release();
  }
}

/** One worker for one job, with request/response helpers. */
class WorkerJob {
  private listeners = new Set<(msg: AnalysisResponse) => void>();
  private failure: Error | null = null;
  private terminated = false;

  constructor(private readonly worker: WorkerLike) {
    worker.addEventListener('message', (e: MessageEvent) => {
      for (const l of [...this.listeners]) l(e.data as AnalysisResponse);
    });
    worker.addEventListener('error', (e: Event) => {
      this.failure = new AudioError('worker-failed', undefined, { cause: e });
      for (const l of [...this.listeners]) l({ type: 'error', id: -1, error: { name: 'AudioError', message: this.failure.message, code: 'worker-failed' } });
    });
  }

  post(msg: AnalysisRequest, transfer: Transferable[] = []): void {
    if (this.terminated) throw new AudioError('worker-failed');
    this.worker.postMessage(msg, transfer);
  }

  /** Waits for the first message `pick` accepts; errors for this job reject. */
  wait<T>(id: number, pick: (msg: AnalysisResponse) => T | undefined, signal?: AbortSignal, onOther?: (msg: AnalysisResponse) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.failure || this.terminated) {
        reject(this.failure ?? new DOMException('Abgebrochen.', 'AbortError'));
        return;
      }
      const done = () => {
        this.listeners.delete(listener);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        done();
        this.terminate();
        reject(signal?.reason ?? new DOMException('Abgebrochen.', 'AbortError'));
      };
      const listener = (msg: AnalysisResponse) => {
        if (msg.type === 'error' && (msg.id === id || msg.id === -1)) {
          done();
          reject(deserializeError(msg.error));
          return;
        }
        if (msg.id !== id) return;
        const value = pick(msg);
        if (value !== undefined) {
          done();
          resolve(value);
        } else {
          onOther?.(msg);
        }
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.listeners.add(listener);
    });
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.worker.terminate();
    const stop: AnalysisResponse = { type: 'error', id: -1, error: { name: 'AbortError', message: 'Abgebrochen.' } };
    for (const l of [...this.listeners]) l(stop);
  }
}

/** PcmReader whose decoder runs in a worker; the next block is prefetched while the caller works. */
class WorkerPcmReader implements PcmReader {
  private readonly queue: PcmQueue;
  private pending: Promise<Float32Array[] | null> | null = null;
  private ended = false;
  private closed = false;
  private lastProgress = 0;

  constructor(
    private readonly job: WorkerJob,
    private readonly id: number,
    readonly sampleRate: number,
    readonly channels: number,
    readonly durationSec: number,
    private readonly cleanup: () => void,
  ) {
    this.queue = new PcmQueue(channels);
  }

  private request(maxFrames: number): Promise<Float32Array[] | null> {
    this.job.post({ type: 'read', id: this.id, maxFrames });
    const p = this.job.wait(this.id, (m) => (m.type === 'chunk' ? { channels: m.channels, progress: m.progress } : undefined)).then((m) => {
      this.lastProgress = m.progress;
      return m.channels;
    });
    p.catch(() => undefined); // a prefetch nobody waits for must not become an unhandled rejection
    return p;
  }

  async next(maxFrames: number): Promise<PcmChunk | null> {
    if (this.closed) return null;
    const want = Math.max(1, Math.floor(maxFrames));
    const block = Math.max(want, 16384);
    while (this.queue.available < want && !this.ended) {
      const chunk = await (this.pending ?? this.request(block));
      this.pending = null;
      if (!chunk) {
        this.ended = true;
        break;
      }
      this.queue.push(chunk);
      this.pending = this.request(block);
    }
    const data = this.queue.take(want);
    return data ? { channels: data, sampleRate: this.sampleRate } : null;
  }

  /** 0..1 of the file decoded so far. */
  progress(): number {
    return this.lastProgress;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.clear();
    this.job.terminate();
    this.cleanup();
  }
}

/** Yields to the page now and then while a long in-memory job runs on the main thread; `onClose` runs once on close(). */
function yieldingReader(inner: PcmReader, onClose?: () => void, everyMs = 30): PcmReader {
  let last = Date.now();
  let closed = false;
  return {
    sampleRate: inner.sampleRate,
    channels: inner.channels,
    durationSec: inner.durationSec,
    async next(maxFrames) {
      if (closed) return null;
      if (Date.now() - last > everyMs) {
        await new Promise((r) => setTimeout(r, 0));
        last = Date.now();
      }
      return inner.next(maxFrames);
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await inner.close();
      } finally {
        onClose?.();
      }
    },
  };
}

function isFallbackError(err: unknown): err is AudioError {
  return err instanceof AudioError && err.code === 'unsupported-format' && err.details?.fallback === true;
}

/** Codec strings for MIME types, by the codec names the demuxers use. */
const MP4_CODECS: Record<string, string> = { aac: 'mp4a.40.2', alac: 'alac', mp3: 'mp4a.6B', ac3: 'ac-3', eac3: 'ec-3', opus: 'opus', flac: 'flac' };

/**
 * MIME type with codec for asking the page's decoder, from what the worker
 * found out. Undefined when the container or its codec is not known: a bare
 * "audio/mp4" gets a "maybe" for any codec, so only a test decode can tell.
 */
export function fallbackMime(details: AudioErrorDetails | undefined): string | undefined {
  const codec = details?.codec?.toLowerCase();
  switch (details?.container) {
    case 'mp4':
      if (!codec) return undefined;
      return `audio/mp4; codecs="${codec.startsWith('mp4a') ? 'mp4a.40.2' : (MP4_CODECS[codec] ?? codec)}"`;
    case 'aac':
      return 'audio/aac';
    case 'flac':
      return 'audio/flac';
    case 'ogg':
      return codec ? `audio/ogg; codecs="${codec}"` : undefined;
    case 'webm':
      // Matroska can hold almost anything; the page's decoder is asked about the WebM codecs only.
      return codec === 'opus' || codec === 'vorbis' ? `audio/webm; codecs="${codec}"` : undefined;
    default:
      return undefined;
  }
}

function defaultCanPlayType(mime: string): boolean {
  if (typeof document === 'undefined') return true;
  return document.createElement('audio').canPlayType(mime) !== '';
}

export function createBrowserAudioBackend(options: BrowserAudioBackendOptions = {}): AudioBackend {
  const createWorker = options.createWorker ?? defaultWorker;
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  const slots = new Slots(Math.max(1, options.maxParallel ?? Math.min(4, cores - 1)));
  const maxSec = options.maxInMemorySec ?? MAX_IN_MEMORY_SEC;
  const maxBytes = options.maxInMemoryBytes ?? MAX_IN_MEMORY_FILE_BYTES;
  const decodeInMemory = options.decodeInMemory ?? decodeWithAudioContext;
  const probeDuration = options.probeDuration ?? durationFromMetadata;
  const canPlayType = options.canPlayType ?? defaultCanPlayType;
  const inMemory = new InMemoryFiles();
  let nextId = 1;

  const refuse = (err: AudioError) => new AudioError('unsupported-format', undefined, { details: { ...err.details, fallback: false } });

  /**
   * Decodes the start of the file with the page's decoder. Throws when it
   * cannot; returns the playing time estimated from the part it decoded.
   */
  async function trialDecode(input: ByteSource, err: AudioError, signal?: AbortSignal): Promise<number> {
    const n = Math.min(input.size, TRIAL_BYTES);
    const data = input.blob ? await input.blob.slice(0, n).arrayBuffer() : (await readRange(input, 0, n)).slice().buffer;
    checkAborted(signal);
    let decoded: InMemoryAudio | undefined;
    try {
      decoded = await decodeInMemory(data, FALLBACK_ANALYSIS_RATE);
    } catch {
      // Not a format the page knows.
    }
    checkAborted(signal);
    const frames = decoded?.channels[0]?.length ?? 0;
    if (!decoded || frames === 0) throw refuse(err);
    return (frames / decoded.sampleRate) * (input.size / n);
  }

  /**
   * Throws when the page's own decoder cannot help: it does not know the
   * format, or the file is too long for memory. Returns the playing time when known.
   */
  async function checkFallback(input: ByteSource, err: AudioError, signal?: AbortSignal): Promise<number | undefined> {
    const mime = fallbackMime(err.details);
    if (mime && !canPlayType(mime)) throw refuse(err);
    let duration = err.details?.durationSec ?? (await probeDuration(input));
    checkAborted(signal);
    // Unknown kind, codec or length: decoding the start shows whether the page's decoder knows the file, and how long it plays.
    if (!mime || duration === undefined) {
      const estimate = await trialDecode(input, err, signal);
      duration ??= estimate;
    }
    if (duration !== undefined ? duration > maxSec : input.size > MAX_IN_MEMORY_BYTES) throw new AudioError('too-long', undefined, { details: err.details });
    if (input.size > maxBytes) throw new AudioError('too-big', undefined, { details: err.details });
    return duration;
  }

  async function loadInMemory(input: ByteSource, err: AudioError, sampleRate: number, signal?: AbortSignal): Promise<InMemoryAudio> {
    await checkFallback(input, err, signal);
    let data: ArrayBuffer;
    try {
      data = input.blob ? await input.blob.arrayBuffer() : (await readRange(input, 0, input.size)).slice().buffer;
    } catch (e) {
      // The browser's own words ("NotReadableError …") say nothing to the user.
      throw e instanceof AudioError ? e : new AudioError('read-failed', undefined, { cause: e });
    }
    checkAborted(signal);
    const decoded = await decodeInMemory(data, sampleRate);
    if (decoded.channels.length === 0 || decoded.channels[0].length === 0) throw new AudioError('no-audio');
    return decoded;
  }

  async function analyzeInWorker(input: ByteSource, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<AudioAnalysis> {
    const id = nextId++;
    const job = new WorkerJob(createWorker());
    const src = sourceRef(input);
    try {
      job.post({ type: 'analyze', id, source: src.ref, windowSec: options.windowSec }, src.transfer);
      return await job.wait(
        id,
        (m) => (m.type === 'analysis' ? m.analysis : undefined),
        signal,
        (m) => {
          if (m.type === 'progress') onProgress?.(m.fraction);
        },
      );
    } finally {
      job.terminate();
      src.close();
    }
  }

  return {
    async analyze(input, onProgress, signal) {
      await slots.acquire(signal);
      try {
        try {
          return await analyzeInWorker(input, onProgress, signal);
        } catch (err) {
          if (!isFallbackError(err)) throw err;
          const { audio, release } = await inMemory.use(input, FALLBACK_ANALYSIS_RATE, (s) => loadInMemory(input, err, FALLBACK_ANALYSIS_RATE, s), signal);
          try {
            onProgress?.(0.5);
            const reader = yieldingReader(new ArrayPcmReader(audio.channels, audio.sampleRate));
            const analysis = await analyzePcm(reader, { windowSec: options.windowSec, signal, onProgress: (f) => onProgress?.(0.5 + f / 2) });
            return { ...analysis, codec: err.details?.codec, bitrateKbps: analysis.durationSec > 0 ? Math.round((input.size * 8) / analysis.durationSec / 1000) : undefined };
          } finally {
            release();
          }
        }
      } catch (err) {
        if (isAbortError(err)) throw err;
        throw err instanceof AudioError ? err : new AudioError('decode-failed', undefined, { cause: err });
      } finally {
        slots.release();
      }
    },

    async check(input, signal) {
      const id = nextId++;
      const job = new WorkerJob(createWorker());
      const src = sourceRef(input);
      try {
        job.post({ type: 'open', id, source: src.ref }, src.transfer);
        const m = await job.wait(id, (r) => (r.type === 'opened' ? r : undefined), signal);
        return { durationSec: m.durationSec > 0 ? m.durationSec : undefined, sampleRate: m.sampleRate, channels: m.channels, codec: m.codec };
      } catch (err) {
        if (!isFallbackError(err)) throw err;
        return { durationSec: await checkFallback(input, err, signal), codec: err.details?.codec };
      } finally {
        job.terminate();
        src.close();
      }
    },

    async openPcm(input, opts = {}) {
      const { signal } = opts;
      checkAborted(signal);
      const id = nextId++;
      const job = new WorkerJob(createWorker());
      const src = sourceRef(input);
      try {
        job.post({ type: 'open', id, source: src.ref, targetSampleRate: opts.targetSampleRate }, src.transfer);
        const meta = await job.wait(id, (m) => (m.type === 'opened' ? m : undefined), signal);
        return new WorkerPcmReader(job, id, meta.sampleRate, meta.channels, meta.durationSec, () => src.close());
      } catch (err) {
        job.terminate();
        src.close();
        if (!isFallbackError(err)) throw err;
        const rate = opts.targetSampleRate ?? 44100;
        const { audio, release } = await inMemory.use(input, rate, (s) => loadInMemory(input, err, rate, s), signal);
        return withSampleRate(yieldingReader(new ArrayPcmReader(audio.channels, audio.sampleRate), release), opts.targetSampleRate);
      }
    },
  };
}
