/** PCM plumbing shared by all decoders: queues, readers, channel mixing, analysis. */
import type { AudioAnalysis, PcmChunk, PcmReader } from '../../platform/types';
import { checkAborted } from './errors';
import { integratedLoudness, PowerEnvelope } from './loudness';
import { Resampler, type ResamplerOptions } from './resample';

/**
 * FIFO of decoded PCM that hands out blocks of a requested size. Returned
 * arrays are always fresh copies, so consumers may transfer them to workers.
 */
export class PcmQueue {
  private blocks: Float32Array[][] = [];
  private offset = 0;
  /** Frames waiting in the queue. */
  available = 0;

  constructor(readonly channels: number) {}

  push(channels: readonly Float32Array[]): void {
    const len = channels[0]?.length ?? 0;
    if (len === 0) return;
    const block: Float32Array[] = [];
    for (let c = 0; c < this.channels; c++) block.push(channels[Math.min(c, channels.length - 1)]);
    this.blocks.push(block);
    this.available += len;
  }

  /** Takes up to `max` frames, or null when the queue is empty. */
  take(max: number): Float32Array[] | null {
    if (this.available === 0 || max <= 0) return null;
    const n = Math.min(Math.floor(max), this.available);
    const out: Float32Array[] = [];
    for (let c = 0; c < this.channels; c++) out.push(new Float32Array(n));
    let filled = 0;
    while (filled < n) {
      const block = this.blocks[0];
      const blockLen = block[0].length;
      const take = Math.min(n - filled, blockLen - this.offset);
      for (let c = 0; c < this.channels; c++) out[c].set(block[c].subarray(this.offset, this.offset + take), filled);
      filled += take;
      this.offset += take;
      if (this.offset >= blockLen) {
        this.blocks.shift();
        this.offset = 0;
      }
    }
    this.available -= n;
    return out;
  }

  clear(): void {
    this.blocks = [];
    this.offset = 0;
    this.available = 0;
  }
}

/** A PcmReader over signals already in memory (e.g. an AudioBuffer). */
export class ArrayPcmReader implements PcmReader {
  readonly channels: number;
  readonly durationSec: number;
  private pos = 0;

  constructor(
    private data: readonly Float32Array[],
    readonly sampleRate: number,
  ) {
    this.channels = data.length;
    this.durationSec = (data[0]?.length ?? 0) / sampleRate;
  }

  async next(maxFrames: number): Promise<PcmChunk | null> {
    const len = this.data[0]?.length ?? 0;
    if (this.pos >= len) return null;
    const end = Math.min(len, this.pos + Math.max(1, Math.floor(maxFrames)));
    const channels = this.data.map((x) => x.slice(this.pos, end));
    this.pos = end;
    return { channels, sampleRate: this.sampleRate };
  }

  async close(): Promise<void> {
    this.pos = Number.POSITIVE_INFINITY;
    this.data = []; // a closed reader does not keep a decoded file alive
  }
}

/** Wraps a reader and converts it to another sample rate on the fly. */
export class ResamplingPcmReader implements PcmReader {
  readonly channels: number;
  readonly durationSec: number;
  private readonly resampler: Resampler;
  private readonly queue: PcmQueue;
  private ended = false;

  constructor(
    private readonly inner: PcmReader,
    readonly sampleRate: number,
    opts: ResamplerOptions = {},
  ) {
    this.channels = inner.channels;
    this.durationSec = inner.durationSec;
    this.resampler = new Resampler(inner.sampleRate, sampleRate, inner.channels, opts);
    this.queue = new PcmQueue(inner.channels);
  }

  async next(maxFrames: number): Promise<PcmChunk | null> {
    while (this.queue.available < maxFrames && !this.ended) {
      const want = Math.max(1024, Math.ceil((maxFrames * this.inner.sampleRate) / this.sampleRate));
      const chunk = await this.inner.next(want);
      if (!chunk) {
        this.queue.push(this.resampler.flush());
        this.ended = true;
        break;
      }
      this.queue.push(this.resampler.process(chunk.channels));
    }
    const out = this.queue.take(maxFrames);
    return out ? { channels: out, sampleRate: this.sampleRate } : null;
  }

  close(): Promise<void> {
    this.queue.clear();
    return this.inner.close();
  }
}

/** Returns `reader` itself when it already runs at `sampleRate`, otherwise a resampling wrapper. */
export function withSampleRate(reader: PcmReader, sampleRate: number | undefined, opts: ResamplerOptions = {}): PcmReader {
  if (!sampleRate || reader.sampleRate === sampleRate) return reader;
  return new ResamplingPcmReader(reader, sampleRate, opts);
}

/**
 * Mixes to one or two channels. Layouts with more channels use the ITU-R
 * BS.775 downmix (centre and surrounds at -3 dB, LFE dropped) in the usual
 * order L R C LFE Ls Rs (5 channels: L R C Ls Rs, 4: L R Ls Rs, 3: L R C).
 * A mono source stays mono unless two channels are asked for.
 */
export function downmix(channels: readonly Float32Array[], target: 1 | 2): Float32Array[] {
  const n = channels.length;
  if (n === 0) return [];
  if (n === target) return [...channels];
  if (target === 1) return [downmixToMono(n > 2 ? downmix(channels, 2) : channels)];
  if (n === 1) return [channels[0], channels[0]];
  const len = channels[0].length;
  const l = new Float32Array(len);
  const r = new Float32Array(len);
  l.set(channels[0].subarray(0, len));
  r.set(channels[1].subarray(0, len));
  const k = Math.SQRT1_2;
  const add = (dst: Float32Array, src: Float32Array | undefined) => {
    if (!src) return;
    for (let i = 0; i < len; i++) dst[i] += k * src[i];
  };
  if (n === 3 || n >= 5) {
    add(l, channels[2]);
    add(r, channels[2]);
  }
  if (n === 4) {
    add(l, channels[2]);
    add(r, channels[3]);
  } else if (n === 5) {
    add(l, channels[3]);
    add(r, channels[4]);
  } else if (n >= 6) {
    add(l, channels[4]);
    add(r, channels[5]);
  }
  return [l, r];
}

/** Average of all channels. */
export function downmixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0]?.length ?? 0;
  const out = new Float32Array(n);
  const g = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] * g;
  return out;
}

export interface AnalyzePcmOptions {
  windowSec?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Custom progress (0..1), e.g. from bytes read; default: samples / duration. */
  progressOf?: () => number;
  /** Frames requested per read. */
  blockFrames?: number;
}

/** Streams a reader through the K-weighted power envelope and measures loudness. */
export async function analyzePcm(reader: PcmReader, opts: AnalyzePcmOptions = {}): Promise<AudioAnalysis> {
  const windowSec = opts.windowSec ?? 0.01;
  const env = new PowerEnvelope(reader.sampleRate, reader.channels, windowSec);
  const expected = Math.max(1, reader.durationSec * reader.sampleRate);
  const block = opts.blockFrames ?? 1 << 16;
  let lastReport = 0;
  for (;;) {
    checkAborted(opts.signal);
    const chunk = await reader.next(block);
    if (!chunk) break;
    env.push(chunk);
    if (opts.onProgress) {
      const f = Math.min(0.999, opts.progressOf ? opts.progressOf() : env.samples / expected);
      if (f - lastReport >= 0.002) {
        lastReport = f;
        opts.onProgress(f);
      }
    }
  }
  const power = env.finish();
  const lufs = integratedLoudness(power, windowSec);
  opts.onProgress?.(1);
  return {
    durationSec: env.samples / reader.sampleRate,
    sampleRate: reader.sampleRate,
    channels: reader.channels,
    windowSec,
    power,
    lufs: Number.isFinite(lufs) ? lufs : undefined,
    peak: env.peak,
    clips: env.clips(),
  };
}

/** Reads a whole reader into memory (for tests and short clips). */
export async function readAllPcm(reader: PcmReader, blockFrames = 1 << 16): Promise<Float32Array[]> {
  const parts: Float32Array[][] = [];
  let total = 0;
  for (let chunk = await reader.next(blockFrames); chunk; chunk = await reader.next(blockFrames)) {
    parts.push(chunk.channels);
    total += chunk.channels[0]?.length ?? 0;
  }
  const out: Float32Array[] = [];
  for (let c = 0; c < reader.channels; c++) {
    const ch = new Float32Array(total);
    let o = 0;
    for (const p of parts) {
      ch.set(p[c], o);
      o += p[c].length;
    }
    out.push(ch);
  }
  return out;
}
