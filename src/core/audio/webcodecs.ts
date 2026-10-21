/**
 * Decoding with the browser's WebCodecs AudioDecoder. Packets from a demuxer
 * (mp4.ts, ogg.ts, flac.ts, demux.ts) go in, PCM comes out as a PcmReader.
 *
 * Priming and padding are trimmed with the demuxer's skip/total values, so
 * time 0 is the first real sample and chapter marks line up. Only a few
 * packets are in flight at any time, so memory stays small for long books.
 * The WebCodecs objects are injected (WebCodecsApi), which lets the tests
 * run this logic in Node with a fake decoder.
 */
import type { PcmChunk, PcmReader } from '../../platform/types';
import type { PacketReader } from './demux';
import { AudioError, checkAborted } from './errors';
import { PcmQueue } from './pcm';
import { Resampler } from './resample';

/** The parts of WebCodecs' AudioData we use. */
export interface AudioDataLike {
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  copyTo(destination: Float32Array, options: AudioDataCopyToOptions): void;
  close(): void;
}

/** The parts of WebCodecs' AudioDecoder we use. */
export interface AudioDecoderLike {
  readonly decodeQueueSize: number;
  configure(config: AudioDecoderConfig): void;
  decode(chunk: EncodedAudioChunk): void;
  flush(): Promise<void>;
  close(): void;
  addEventListener?(type: 'dequeue', listener: () => void): void;
}

export interface WebCodecsApi {
  isConfigSupported(config: AudioDecoderConfig): Promise<boolean>;
  createDecoder(output: (data: AudioDataLike) => void, error: (err: unknown) => void): AudioDecoderLike;
  createChunk(init: { type: 'key'; timestamp: number; duration?: number; data: Uint8Array }): EncodedAudioChunk;
}

/** The real WebCodecs of this browser or worker, or null when there is none (Node, older browsers). */
export function browserWebCodecs(): WebCodecsApi | null {
  if (typeof AudioDecoder === 'undefined' || typeof EncodedAudioChunk === 'undefined') return null;
  return {
    async isConfigSupported(config) {
      try {
        return (await AudioDecoder.isConfigSupported(config)).supported === true;
      } catch {
        return false;
      }
    },
    createDecoder(output, error) {
      return new AudioDecoder({ output: (d) => output(d), error: (e) => error(e) });
    },
    createChunk(init) {
      return new EncodedAudioChunk(init);
    },
  };
}

/** WebCodecs decoder configuration for a demuxed track; null when WebCodecs has no codec name for it. */
export function decoderConfig(packets: PacketReader): AudioDecoderConfig | null {
  const info = packets.info;
  if (!info.webCodecs) return null;
  const config: AudioDecoderConfig = { codec: info.webCodecs, sampleRate: info.sampleRate, numberOfChannels: info.channels };
  if (info.description) config.description = info.description;
  return config;
}

/** Packets submitted to the decoder ahead of its output. */
const MAX_DECODE_QUEUE = 24;

export class WebCodecsPcmReader implements PcmReader {
  sampleRate = 0;
  channels = 0;
  readonly durationSec: number;
  private queue: PcmQueue = new PcmQueue(1);
  private readonly decoder: AudioDecoderLike;
  private failure: unknown = null;
  private wake: (() => void) | null = null;
  private formatKnown = false;
  private inputDone = false;
  private finished = false;
  private closed = false;
  private skipLeft = 0;
  private remaining = Number.POSITIVE_INFINITY;
  private resampler: Resampler | null = null;

  private constructor(
    private readonly packets: PacketReader,
    private readonly api: WebCodecsApi,
    config: AudioDecoderConfig,
    private readonly signal?: AbortSignal,
  ) {
    this.durationSec = packets.info.durationSec;
    this.decoder = api.createDecoder(
      (d) => this.onOutput(d),
      (e) => {
        this.failure = e ?? new Error('decoder error');
        this.wake?.();
      },
    );
    this.decoder.addEventListener?.('dequeue', () => this.wake?.());
    this.decoder.configure(config);
  }

  /**
   * Opens a decoder for the packets. Throws 'unsupported-format' when this
   * browser cannot decode the codec, 'decode-failed' when the data is bad.
   */
  static async open(packets: PacketReader, api: WebCodecsApi, signal?: AbortSignal): Promise<WebCodecsPcmReader> {
    const config = decoderConfig(packets);
    if (!config || !(await api.isConfigSupported(config))) throw new AudioError('unsupported-format');
    const reader = new WebCodecsPcmReader(packets, api, config, signal);
    try {
      await reader.fill(0); // decode until the first output tells the real sample rate and channel count
    } catch (err) {
      await reader.close();
      throw err;
    }
    if (!reader.formatKnown) {
      await reader.close();
      throw new AudioError('no-audio');
    }
    return reader;
  }

  private onOutput(d: AudioDataLike): void {
    try {
      if (this.closed) return;
      const n = d.numberOfFrames;
      if (!this.formatKnown) {
        this.formatKnown = true;
        this.sampleRate = d.sampleRate;
        this.channels = d.numberOfChannels;
        this.queue = new PcmQueue(this.channels);
        const info = this.packets.info;
        const ratio = info.sampleRate > 0 ? d.sampleRate / info.sampleRate : 1;
        this.skipLeft = Math.round(info.skipSamples * ratio);
        if (info.totalSamples !== undefined) this.remaining = Math.round(info.totalSamples * ratio);
      }
      if (n === 0 || this.remaining <= 0) return;
      let planes: Float32Array[] = [];
      for (let c = 0; c < d.numberOfChannels; c++) {
        const plane = new Float32Array(n);
        d.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        planes.push(plane);
      }
      // Rare mid-stream changes: keep the format announced at the start.
      while (planes.length < this.channels) planes.push(planes[planes.length - 1]);
      if (planes.length > this.channels) planes = planes.slice(0, this.channels);
      if (d.sampleRate !== this.sampleRate) {
        if (!this.resampler || this.resampler.inRate !== d.sampleRate) this.resampler = new Resampler(d.sampleRate, this.sampleRate, this.channels);
        planes = this.resampler.process(planes);
      }
      this.accept(planes);
    } catch (err) {
      this.failure = err;
    } finally {
      d.close();
      this.wake?.();
    }
  }

  private accept(planes: Float32Array[]): void {
    let start = 0;
    let len = planes[0]?.length ?? 0;
    if (this.skipLeft > 0) {
      const drop = Math.min(this.skipLeft, len);
      this.skipLeft -= drop;
      start = drop;
      len -= drop;
    }
    len = Math.min(len, this.remaining);
    if (len <= 0) return;
    this.remaining -= len;
    this.queue.push(start === 0 && len === planes[0].length ? planes : planes.map((p) => p.subarray(start, start + len)));
  }

  private waitForActivity(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, 15);
      this.wake = done;
    });
  }

  /** Decodes until `minFrames` frames are queued (or, with 0, until the format is known) or the stream ends. */
  private async fill(minFrames: number): Promise<void> {
    const enough = () => (minFrames === 0 ? this.formatKnown : this.queue.available >= minFrames);
    while (!enough() && !this.finished) {
      checkAborted(this.signal);
      if (this.failure) throw new AudioError('decode-failed', undefined, { cause: this.failure });
      if (this.remaining <= 0) {
        this.finished = true;
        break;
      }
      let submitted = false;
      while (!this.inputDone && this.decoder.decodeQueueSize < MAX_DECODE_QUEUE && !enough()) {
        const p = await this.packets.next();
        if (!p) {
          this.inputDone = true;
          break;
        }
        try {
          this.decoder.decode(this.api.createChunk({ type: 'key', timestamp: p.timestampUs, duration: p.durationUs, data: p.data }));
        } catch (err) {
          throw new AudioError('decode-failed', undefined, { cause: err });
        }
        submitted = true;
      }
      if (this.inputDone && !submitted) {
        try {
          await this.decoder.flush(); // every output arrives before flush resolves
        } catch (err) {
          throw new AudioError('decode-failed', undefined, { cause: this.failure ?? err });
        }
        if (this.failure) throw new AudioError('decode-failed', undefined, { cause: this.failure });
        if (this.resampler) this.accept(this.resampler.flush());
        this.finished = true;
        break;
      }
      if (!enough()) await this.waitForActivity();
    }
  }

  async next(maxFrames: number): Promise<PcmChunk | null> {
    if (this.closed) return null;
    const want = Math.max(1, Math.floor(maxFrames));
    await this.fill(want);
    const data = this.queue.take(want);
    return data ? { channels: data, sampleRate: this.sampleRate } : null;
  }

  /** 0..1 of the file read so far (1 once every packet is decoded). */
  progress(): number {
    return this.finished ? 1 : this.packets.progress();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.clear();
    try {
      this.decoder.close();
    } catch {
      // already closed after an error
    }
    await this.packets.close();
  }
}
