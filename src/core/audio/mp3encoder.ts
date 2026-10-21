/**
 * The MP3 encoder core: lamejs with channel mixing, gain and a look-ahead
 * peak limiter, plus the message handler of the encoder worker. Plain
 * synchronous code without worker or DOM dependencies (runs in Node too);
 * the pipeline around it is in encode.ts.
 *
 * lamejs picks a lower output sample rate on its own for small bitrates, so
 * the bitrate is raised to the smallest value that keeps the input rate
 * (at 44.1 kHz: mono 64 kbps, stereo 112 kbps); see effectiveBitrate.
 *
 * lamejs is big and only needed for converting: it comes as its own file of
 * the build, loaded by loadMp3Encoder() before the first Mp3StreamEncoder.
 */
import type { Mp3Encoder } from '@breezystack/lamejs';
import type { PcmChunk } from '../../platform/types';
import { crc16Arc } from './bits';
import { AudioError, serializeError, type SerializedError } from './errors';
import { buildXingFrame } from './mp3cut';
import { bitrateTable, decodeHeader, readU32, type FrameHeader } from './mp3frames';
import { downmix } from './pcm';
import { LIMITER_CEILING_DB } from './loudness';
import { transferList } from './source';

/** Sample rate of every MP3 we write for the SD card. */
export const MP3_SAMPLE_RATE = 44100;

/** Encoder delay of LAME (and lamejs) in samples, as stored in the LAME tag. */
export const LAME_ENCODER_DELAY = 576;

const LAME_VERSION = 'LAME3.98r';

/* ------------------------------------------------------------ limiter */

// Ceiling of the converter's limiter: kept with the loudness rules, which use it too.
export { LIMITER_CEILING_DB } from './loudness';

export interface LimiterOptions {
  /** Ceiling in dB (default LIMITER_CEILING_DB); with `truePeak` it applies to the true peak. */
  thresholdDb?: number;
  /** Look-ahead in ms (default 5). */
  lookaheadMs?: number;
  /** Release time constant in ms (default 150). */
  releaseMs?: number;
  /** Measure peaks between the samples too, 4 times oversampled (default true). */
  truePeak?: boolean;
}

/** Input samples on each side of the point the true-peak detector interpolates. */
const TP_HALF = 6;
const TP_TAPS = 2 * TP_HALF;

/**
 * The three in-between phases (1/4, 2/4, 3/4) of a 4 times oversampling
 * interpolator, one after the other: Hann-windowed sinc over 12 input
 * samples, like the 48-tap filter of ITU-R BS.1770-4 Annex 2. Each phase
 * sums to 1.
 */
const TP_FILTER = (() => {
  const f = new Float64Array(3 * TP_TAPS);
  for (let p = 1; p <= 3; p++) {
    const t = p / 4;
    const h = f.subarray((p - 1) * TP_TAPS, p * TP_TAPS);
    let sum = 0;
    for (let k = 0; k < TP_TAPS; k++) {
      // Tap k weighs the input sample at offset k - (TP_HALF - 1) from the left neighbour of the point.
      const d = t - (k - (TP_HALF - 1));
      h[k] = (Math.sin(Math.PI * d) / (Math.PI * d)) * (0.5 + 0.5 * Math.cos((Math.PI * d) / TP_HALF));
      sum += h[k];
    }
    for (let k = 0; k < TP_TAPS; k++) h[k] /= sum;
  }
  return f;
})();

/** Largest sum of magnitudes of a phase: no point between samples is louder than this times the loudest sample around it. */
const TP_GAIN = Math.max(...[0, 1, 2].map((p) => TP_FILTER.subarray(p * TP_TAPS, (p + 1) * TP_TAPS).reduce((a, v) => a + Math.abs(v), 0)));

/**
 * Look-ahead peak limiter. The gain is the sliding minimum of the needed
 * gain over the look-ahead window, recovering with an exponential release
 * and smoothed by a moving average of the same length, so it is already
 * down when a peak arrives and never above what any sample needs. The
 * output is delayed internally but returned aligned: n samples in give n
 * samples out after flush(). Below the ceiling the signal passes unchanged.
 *
 * With `truePeak` the peaks between the samples count as well (4 times
 * oversampled): an MP3 decoder rebuilds the wave from its frequencies, and
 * a wave whose samples stay under 0 dBFS can come out above it. The box's
 * decoder then clips, which crackles. The detector looks TP_HALF samples
 * ahead, so the audio waits that much longer.
 */
export class PeakLimiter {
  private readonly threshold: number;
  private readonly look: number;
  private readonly release: number;
  /** Look-ahead of the true-peak detector (0 without it). */
  private readonly tpDelay: number;
  /** The last TP_TAPS input samples per channel, twice in a row, so a window is always contiguous. */
  private readonly history: Float64Array[];
  private histPos = 0;
  private readonly delayLine: Float32Array[];
  private readonly delayLength: number;
  private delayPos = 0;
  // Monotonic deque for the sliding minimum (indices and values).
  private readonly dqIdx: Float64Array;
  private readonly dqVal: Float32Array;
  private dqHead = 0;
  private dqLen = 0;
  // Moving average of the released minimum.
  private readonly avgRing: Float32Array;
  private avgPos = 0;
  private avgSum: number;
  private nonUnity = 0;
  private held = 1;
  private index = 0;
  /** Output samples still to drop to compensate the delay. */
  private toDrop: number;
  private flushed = false;

  constructor(
    sampleRate: number,
    readonly channels: number,
    opts: LimiterOptions = {},
  ) {
    this.threshold = 10 ** ((opts.thresholdDb ?? LIMITER_CEILING_DB) / 20);
    this.look = Math.max(1, Math.round(((opts.lookaheadMs ?? 5) / 1000) * sampleRate));
    this.release = 1 - Math.exp(-1 / (((opts.releaseMs ?? 150) / 1000) * sampleRate));
    this.tpDelay = opts.truePeak === false ? 0 : TP_HALF;
    this.history = Array.from({ length: channels }, () => new Float64Array(2 * TP_TAPS));
    this.delayLength = this.look + this.tpDelay;
    this.delayLine = Array.from({ length: channels }, () => new Float32Array(this.delayLength));
    this.dqIdx = new Float64Array(this.look + 1);
    this.dqVal = new Float32Array(this.look + 1);
    this.avgRing = new Float32Array(this.look).fill(1);
    this.avgSum = this.look;
    this.toDrop = this.delayLength - 1;
  }

  /** Processes a block; returns the aligned output available so far. */
  process(input: readonly Float32Array[]): Float32Array[] {
    if (this.flushed) throw new Error('PeakLimiter already flushed');
    return this.run(input, input[0]?.length ?? 0);
  }

  /** Returns the remaining delayed samples. */
  flush(): Float32Array[] {
    if (this.flushed) return this.delayLine.map(() => new Float32Array(0));
    this.flushed = true;
    const pad = this.delayLength - 1; // pushes every real sample out of the delay line
    return this.run(
      this.delayLine.map(() => new Float32Array(pad)),
      pad,
    );
  }

  /**
   * The largest magnitude around the sample TP_HALF steps back: the sample
   * itself and the three points after it, once `v` (the newest sample of
   * channel c) is in the history.
   */
  private truePeak(c: number, v: number): number {
    const h = this.history[c];
    const p = this.histPos;
    h[p] = v;
    h[p + TP_TAPS] = v;
    // Oldest of the window first: h[p + 1 .. p + TP_TAPS].
    const o = p + 1;
    let peak = Math.abs(h[o + TP_HALF - 1]);
    // Quiet around here: nothing in between can reach the ceiling (most of the time, so this saves the filter).
    let around = 0;
    for (let k = 0; k < TP_TAPS; k++) {
      const a = Math.abs(h[o + k]);
      if (a > around) around = a;
    }
    if (around * TP_GAIN <= this.threshold) return peak;
    const f = TP_FILTER;
    for (let q = 0; q < 3 * TP_TAPS; q += TP_TAPS) {
      let y = 0;
      for (let k = 0; k < TP_TAPS; k++) y += f[q + k] * h[o + k];
      if (y > peak) peak = y;
      else if (-y > peak) peak = -y;
    }
    return peak;
  }

  private run(input: readonly Float32Array[], n: number): Float32Array[] {
    const ch = this.channels;
    const look = this.look;
    const len = this.delayLength;
    const tp = this.tpDelay > 0;
    const drop = Math.min(this.toDrop, n);
    const out = this.delayLine.map(() => new Float32Array(n - drop));
    const cap = this.dqIdx.length;
    for (let i = 0; i < n; i++) {
      // With the true peak: the need of the sample TP_HALF steps back, which the audio waits for.
      let peak = 0;
      for (let c = 0; c < ch; c++) {
        const x = (input[c] ?? input[0])[i];
        const v = tp ? this.truePeak(c, x) : Math.abs(x);
        if (v > peak) peak = v;
      }
      if (tp) this.histPos = (this.histPos + 1) % TP_TAPS;
      const need = peak > this.threshold ? this.threshold / peak : 1;
      // Sliding minimum over the last `look` values.
      while (this.dqLen > 0 && this.dqVal[(this.dqHead + this.dqLen - 1) % cap] >= need) this.dqLen--;
      const slot = (this.dqHead + this.dqLen) % cap;
      this.dqIdx[slot] = this.index;
      this.dqVal[slot] = need;
      this.dqLen++;
      while (this.dqIdx[this.dqHead] <= this.index - look) {
        this.dqHead = (this.dqHead + 1) % cap;
        this.dqLen--;
      }
      const min = this.dqVal[this.dqHead];
      // Release towards 1, never above the minimum.
      const rel = this.held + this.release * (1 - this.held);
      this.held = min < rel ? min : rel >= 0.9999999 && min === 1 ? 1 : rel;
      // Moving average over `look` samples.
      const old = this.avgRing[this.avgPos];
      if (old !== 1) this.nonUnity--;
      if (this.held !== 1) this.nonUnity++;
      this.avgRing[this.avgPos] = this.held;
      this.avgPos = (this.avgPos + 1) % look;
      this.avgSum += this.held - old;
      if (this.nonUnity === 0) this.avgSum = look;
      const gain = Math.min(1, this.avgSum / look);
      // Delay line: write now, read the sample from len - 1 steps ago.
      const w = this.delayPos;
      const r = (w + 1) % len;
      const o = i - drop;
      for (let c = 0; c < ch; c++) {
        const line = this.delayLine[c];
        line[w] = (input[c] ?? input[0])[i];
        if (o >= 0) out[c][o] = (len === 1 ? line[w] : line[r]) * gain;
      }
      this.delayPos = r;
      this.index++;
    }
    this.toDrop -= drop;
    return out;
  }
}

/* ------------------------------------------------------------ encoder */

/** Smallest bitrate (kbps) at which lamejs keeps the sample rate instead of resampling down. */
export function minBitrateFor(channels: 1 | 2, sampleRate: number): number {
  if (sampleRate >= 48000) return channels === 1 ? 64 : 128;
  if (sampleRate >= 44100) return channels === 1 ? 64 : 112;
  if (sampleRate >= 32000) return channels === 1 ? 48 : 80;
  return channels === 1 ? 32 : 48;
}

/** The bitrate the encoder really uses: a valid MPEG-1 Layer III rate, at least minBitrateFor. */
export function effectiveBitrate(kbps: number, channels: 1 | 2, sampleRate = MP3_SAMPLE_RATE): number {
  const want = Math.max(kbps, minBitrateFor(channels, sampleRate));
  const rates = bitrateTable(sampleRate >= 32000 ? 1 : 2, 3).map((r) => r.kbps);
  return rates.find((r) => r >= want) ?? rates[rates.length - 1];
}

export interface Mp3EncoderOptions {
  /** Channels of the PCM that will be pushed. */
  inputChannels: number;
  /** Sample rate of the pushed PCM; the MP3 gets the same (default 44100). */
  sampleRate?: number;
  /** Default 128; raised when lamejs would otherwise lower the sample rate. */
  bitrateKbps?: number;
  /** Mix down to one channel (a good choice for speech, e.g. at 64–96 kbps). */
  mono?: boolean;
  /** Volume change in dB; the limiter keeps the true peak below LIMITER_CEILING_DB. */
  gainDb?: number;
}

/** Counts MP3 frames in a byte stream that arrives in pieces. */
class FrameCounter {
  frames = 0;
  first: FrameHeader | null = null;
  private left = 0;
  private readonly head = new Uint8Array(4);
  private headFill = 0;

  feed(b: Uint8Array): void {
    let i = 0;
    while (i < b.length) {
      if (this.left > 0) {
        const take = Math.min(this.left, b.length - i);
        this.left -= take;
        i += take;
        continue;
      }
      while (this.headFill < 4 && i < b.length) this.head[this.headFill++] = b[i++];
      if (this.headFill < 4) return;
      this.headFill = 0;
      const h = decodeHeader(readU32(this.head, 0));
      if (!h) throw new AudioError('decode-failed', undefined, { cause: new Error('Encoder produced an invalid frame') });
      this.first ??= h;
      this.frames++;
      this.left = h.frameLength - 4;
    }
  }
}

const BLOCK = 1152 * 16;

let lame: typeof import('@breezystack/lamejs') | undefined;

/** Loads lamejs; Mp3StreamEncoder needs it. */
export async function loadMp3Encoder(): Promise<void> {
  lame ??= await import('@breezystack/lamejs');
}

/**
 * Synchronous MP3 encoder (lamejs, after loadMp3Encoder()). push() PCM,
 * take the frames with takeOutput() as you go (or all at once from
 * finish()), then put infoFrame() in front of them.
 */
export class Mp3StreamEncoder {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly bitrateKbps: number;
  private readonly lame: Mp3Encoder;
  private readonly limiter: PeakLimiter;
  private readonly gain: number;
  private readonly left = new Int16Array(BLOCK);
  private readonly right = new Int16Array(BLOCK);
  private fill = 0;
  private out: Uint8Array[] = [];
  private readonly counter = new FrameCounter();
  private inputSamples = 0;
  private audioBytes = 0;
  private musicCrc = 0;
  private finished = false;

  constructor(readonly options: Mp3EncoderOptions) {
    this.sampleRate = options.sampleRate ?? MP3_SAMPLE_RATE;
    this.channels = options.mono || options.inputChannels === 1 ? 1 : 2;
    this.bitrateKbps = effectiveBitrate(options.bitrateKbps ?? 128, this.channels, this.sampleRate);
    if (!lame) throw new Error('loadMp3Encoder() first');
    this.lame = new lame.Mp3Encoder(this.channels, this.sampleRate, this.bitrateKbps);
    this.gain = 10 ** ((options.gainDb ?? 0) / 20);
    this.limiter = new PeakLimiter(this.sampleRate, this.channels);
  }

  /** Encodes a block of PCM (any channel count; mixed as configured). */
  push(chunk: PcmChunk): void {
    if (this.finished) throw new Error('Mp3StreamEncoder already finished');
    if (chunk.sampleRate !== this.sampleRate) throw new RangeError(`Expected ${this.sampleRate} Hz, got ${chunk.sampleRate} Hz`);
    const n = chunk.channels[0]?.length ?? 0;
    if (n === 0) return;
    let pcm = downmix(chunk.channels, this.channels);
    if (this.gain !== 1) {
      pcm = pcm.map((x) => {
        const y = new Float32Array(x.length);
        for (let i = 0; i < x.length; i++) y[i] = x[i] * this.gain;
        return y;
      });
    }
    this.inputSamples += n;
    this.feed(this.limiter.process(pcm));
  }

  private feed(pcm: Float32Array[]): void {
    const n = pcm[0]?.length ?? 0;
    let i = 0;
    while (i < n) {
      const take = Math.min(BLOCK - this.fill, n - i);
      for (let c = 0; c < this.channels; c++) {
        const src = pcm[c];
        const dst = c === 0 ? this.left : this.right;
        for (let k = 0; k < take; k++) {
          const v = src[i + k] * 32767;
          dst[this.fill + k] = v >= 32767 ? 32767 : v <= -32768 ? -32768 : Math.round(v);
        }
      }
      this.fill += take;
      i += take;
      if (this.fill === BLOCK) this.encodeBlock();
    }
  }

  private encodeBlock(): void {
    if (this.fill === 0) return;
    const l = this.left.subarray(0, this.fill);
    const r = this.channels === 2 ? this.right.subarray(0, this.fill) : undefined;
    this.collect(this.lame.encodeBuffer(l, r));
    this.fill = 0;
  }

  private collect(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const b = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
    this.counter.feed(b);
    this.musicCrc = crc16Arc(b, 0, b.length, this.musicCrc);
    this.audioBytes += b.length;
    this.out.push(b);
  }

  /** MP3 frames produced since the last call. */
  takeOutput(): Uint8Array[] {
    const o = this.out;
    this.out = [];
    return o;
  }

  /** Flushes the encoder; returns the frames not taken yet. */
  finish(): Uint8Array[] {
    if (!this.finished) {
      this.finished = true;
      this.feed(this.limiter.flush());
      this.encodeBlock();
      this.collect(this.lame.flush());
    }
    return this.takeOutput();
  }

  /** Samples pushed so far (per channel). */
  get samples(): number {
    return this.inputSamples;
  }

  get frames(): number {
    return this.counter.frames;
  }

  /**
   * The "Info" frame (CBR) for the start of the file: frame and byte counts,
   * seek table and LAME tag with encoder delay and padding. Call after finish().
   */
  infoFrame(): Uint8Array {
    if (!this.finished) throw new Error('Call finish() first');
    const h = this.counter.first;
    const channelMode = h ? h.channelMode : this.channels === 1 ? 3 : 0;
    const spf = h ? h.samplesPerFrame : 1152;
    const padding = this.counter.frames * spf - LAME_ENCODER_DELAY - this.inputSamples;
    return buildXingFrame(
      { version: h?.version ?? 1, sampleRate: this.sampleRate, channelMode, bitrateKbps: this.bitrateKbps },
      {
        kind: 'Info',
        frames: this.counter.frames,
        audioBytes: this.audioBytes,
        lame: padding >= 0 && padding < 4096 ? { encoderDelay: LAME_ENCODER_DELAY, padding, encoder: LAME_VERSION, musicCrc: this.musicCrc } : undefined,
      },
    );
  }
}

/* ------------------------------------------------------------ worker */

export type EncoderRequest =
  | { type: 'init'; options: Mp3EncoderOptions }
  | { type: 'push'; seq: number; channels: Float32Array[]; sampleRate: number }
  | { type: 'finish'; seq: number };

export type EncoderResponse =
  | { type: 'frames'; seq: number; frames: Uint8Array[] }
  | { type: 'done'; seq: number; frames: Uint8Array[]; info: Uint8Array }
  | { type: 'error'; seq: number; error: SerializedError };

/** The encoder worker's message handler (encode.worker.ts wires it to the worker). */
export function createEncoderWorkerHandler(post: (msg: EncoderResponse, transfer: Transferable[]) => void): (msg: EncoderRequest) => void {
  let encoder: Mp3StreamEncoder | null = null;
  // Messages wait in order until lamejs is there; without it 'init' answers with the error.
  let queue: Promise<unknown> = loadMp3Encoder().catch(() => undefined);
  return (msg) => {
    queue = queue.then(() => handle(msg));
  };
  function handle(msg: EncoderRequest): void {
    const seq = msg.type === 'init' ? 0 : msg.seq;
    try {
      if (msg.type === 'init') {
        encoder = new Mp3StreamEncoder(msg.options);
      } else if (!encoder) {
        throw new AudioError('worker-failed');
      } else if (msg.type === 'push') {
        encoder.push({ channels: msg.channels, sampleRate: msg.sampleRate });
        const frames = encoder.takeOutput();
        post({ type: 'frames', seq, frames }, transferList(frames));
      } else {
        const frames = encoder.finish();
        const info = encoder.infoFrame();
        post({ type: 'done', seq, frames, info }, transferList([...frames, info]));
      }
    } catch (err) {
      post({ type: 'error', seq, error: serializeError(err) }, []);
    }
  }
}
