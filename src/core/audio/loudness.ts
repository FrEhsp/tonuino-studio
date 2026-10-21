/**
 * Loudness after ITU-R BS.1770-4 / EBU R128.
 *
 * PowerEnvelope streams PCM through the K-weighting filter (high shelf +
 * RLB high-pass, coefficients derived for the actual sample rate with the
 * bilinear-transform design used by libebur128 and pyloudnorm) and stores the
 * mean-square power per window (normally 10 ms), summed over channels with
 * weight 1.0. That envelope is AudioAnalysis.power; integrated loudness and
 * pause detection are computed from it.
 */
import type { PcmChunk } from '../../platform/types';
import { GAIN_STEP_DB } from './mp3gain';

/** Offset in BS.1770: L = -0.691 + 10·log10(power). */
export const LUFS_OFFSET = -0.691;
export const ABSOLUTE_GATE_LUFS = -70;
export const RELATIVE_GATE_LU = -10;

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** The two K-weighting stages (pre-filter shelf, RLB high-pass) for a sample rate. */
export function kWeightingFilters(sampleRate: number): [Biquad, Biquad] {
  // Stage 1: high shelf modelling the head (libebur128 parameters).
  let f0 = 1681.974450955533;
  const gainDb = 3.999843853973347;
  let q = 0.7071752369554196;
  let k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = 10 ** (gainDb / 20);
  const vb = vh ** 0.4996667741545416;
  let a0 = 1 + k / q + k * k;
  const shelf: Biquad = {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
  // Stage 2: RLB high-pass; numerator 1, -2, 1 as in BS.1770.
  f0 = 38.13547087602444;
  q = 0.5003270373238773;
  k = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + k / q + k * k;
  const highpass: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (k * k - 1)) / a0, a2: (1 - k / q + k * k) / a0 };
  return [shelf, highpass];
}

/** BS.1770 channel weights: 1.0 for L, R, C; 0 for LFE; 1.41 for surrounds (5.1 order L R C LFE Ls Rs). */
export function channelWeights(channels: number): Float64Array {
  const w = new Float64Array(channels).fill(1);
  if (channels === 6) {
    w[3] = 0;
    w[4] = 1.41;
    w[5] = 1.41;
  }
  return w;
}

/* ------------------------------------------------------------------ clipping */

/** Neighbouring samples this close count as the same value (half a step of 16-bit audio). */
const CLIP_SAME = 2 ** -16;
/** Equal samples in a row that make a flat top. */
const CLIP_RUN = 3;
/**
 * A cut-off top starts or ends with a jump at least this big. The top of a
 * slow wave (a deep bass tone) can also give equal samples, but reaches
 * them gently.
 */
const CLIP_EDGE = 1e-3;
/** Flat tops count from this level (-12 dBFS); which level was cut off is decided at the end. */
const CLIP_FLOOR = 0.25;
const CLIP_BIN_DB = 0.1;
const CLIP_BINS = 180; // -12 .. +6 dBFS
/** Flat tops this close under the loudest sample are at the level where the file was cut off. */
const CLIP_NEAR_PEAK_DB = 0.3;

/**
 * Counts flat tops: three or more equal samples in a row, entered or left
 * with a jump. A file that was turned up too far before it was saved
 * (clipping) has them at its loudest level, again and again; music that is
 * merely loud does not. Lossy files (MP3, AAC, Opus) smear the flat tops
 * into small waves, so this finds clipping in files that were saved
 * losslessly (WAV, FLAC, CD) or whose decoder cut them off.
 */
export class ClipCounter {
  private readonly prev: Float64Array;
  /** Jump into the run of equal samples that ends at prev. */
  private readonly entry: Float64Array;
  private readonly run: Int32Array;
  private readonly bins = new Float64Array(CLIP_BINS);

  constructor(readonly channels: number) {
    this.prev = new Float64Array(channels);
    this.entry = new Float64Array(channels);
    this.run = new Int32Array(channels);
  }

  push(c: number, x: Float32Array, n = x.length): void {
    let prev = this.prev[c];
    let entry = this.entry[c];
    let run = this.run[c];
    for (let i = 0; i < n; i++) {
      const v = x[i];
      const jump = v > prev ? v - prev : prev - v;
      if (jump <= CLIP_SAME) {
        run++;
      } else {
        if (run >= CLIP_RUN && (entry >= CLIP_EDGE || jump >= CLIP_EDGE)) this.add(prev);
        entry = jump;
        run = 1;
      }
      prev = v;
    }
    this.prev[c] = prev;
    this.entry[c] = entry;
    this.run[c] = run;
  }

  private add(level: number): void {
    const a = level < 0 ? -level : level;
    if (a < CLIP_FLOOR) return;
    this.bins[Math.min(CLIP_BINS - 1, Math.floor((20 * Math.log10(a) + 12) / CLIP_BIN_DB))]++;
  }

  /** Flat tops at the file's loudest level (`peak`, 1 = full scale), counted per channel. */
  count(peak: number): number {
    for (let c = 0; c < this.channels; c++) {
      // A flat top at the very end of the file.
      if (this.run[c] >= CLIP_RUN && this.entry[c] >= CLIP_EDGE) this.add(this.prev[c]);
      this.run[c] = 0;
    }
    if (!(peak >= CLIP_FLOOR)) return 0;
    const from = Math.max(0, Math.floor((20 * Math.log10(peak) - CLIP_NEAR_PEAK_DB + 12) / CLIP_BIN_DB));
    let sum = 0;
    for (let b = from; b < CLIP_BINS; b++) sum += this.bins[b];
    return sum;
  }
}

/** Flat tops per minute from which a file counts as clipped (see isClipped). */
export const CLIPS_PER_MINUTE = 30;
/** And at least this many: a short file with a few is not worth a word. */
export const MIN_CLIPS = 20;

/**
 * The file was already clipped before it came here: cut-off tops again and
 * again (ClipCounter). That crackles on every player; turning it down does
 * not take it out.
 */
export function isClipped(analysis: { clips?: number; durationSec: number }): boolean {
  const clips = analysis.clips ?? 0;
  return clips >= MIN_CLIPS && clips / (Math.max(1, analysis.durationSec) / 60) >= CLIPS_PER_MINUTE;
}

/** Keeps IIR states out of the denormal range during digital silence (inaudible: ~-400 dBFS). */
const ANTI_DENORMAL = 1e-20;

export class PowerEnvelope {
  readonly sampleRate: number;
  readonly channels: number;
  readonly windowSec: number;
  private readonly samplesPerWindow: number;
  private readonly shelf: Biquad;
  private readonly hp: Biquad;
  private readonly weights: Float64Array;
  /** Per channel: z1, z2 (shelf), z3, z4 (high-pass). */
  private readonly state: Float64Array;
  private scratch = new Float64Array(0);
  private acc = 0;
  private accCount = 0;
  private windowIndex = 0;
  private sampleIndex = 0;
  private nextBoundary: number;
  private out = new Float32Array(4096);
  private outLength = 0;
  private maxAbs = 0;
  private readonly clipCounter: ClipCounter;

  constructor(sampleRate: number, channels: number, windowSec = 0.01) {
    if (!(sampleRate > 0) || !(channels > 0) || !(windowSec > 0)) throw new RangeError('Invalid PowerEnvelope parameters');
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.windowSec = windowSec;
    this.samplesPerWindow = Math.max(1, windowSec * sampleRate);
    [this.shelf, this.hp] = kWeightingFilters(sampleRate);
    this.weights = channelWeights(channels);
    this.state = new Float64Array(channels * 4);
    this.clipCounter = new ClipCounter(channels);
    this.nextBoundary = Math.max(1, Math.round(this.samplesPerWindow));
  }

  /** Number of samples (per channel) pushed so far. */
  get samples(): number {
    return this.sampleIndex;
  }

  /** Largest absolute sample value pushed so far (1 = full scale). */
  get peak(): number {
    return this.maxAbs;
  }

  /** Flat tops at the loudest level so far (see ClipCounter); call after the last push. */
  clips(): number {
    return this.clipCounter.count(this.maxAbs);
  }

  push(chunk: PcmChunk): void {
    if (chunk.sampleRate !== this.sampleRate) throw new RangeError(`Expected ${this.sampleRate} Hz, got ${chunk.sampleRate} Hz`);
    const n = chunk.channels[0]?.length ?? 0;
    if (n === 0) return;
    if (this.scratch.length < n) this.scratch = new Float64Array(Math.max(n, this.scratch.length * 2));
    const sq = this.scratch;
    sq.fill(0, 0, n);
    const { b0, b1, b2, a1, a2 } = this.shelf;
    const ha1 = this.hp.a1;
    const ha2 = this.hp.a2;
    for (let c = 0; c < this.channels; c++) {
      const w = this.weights[c];
      const x = chunk.channels[Math.min(c, chunk.channels.length - 1)];
      if (x) this.clipCounter.push(c, x, n);
      if (w === 0 || !x) continue;
      const o = c * 4;
      let z1 = this.state[o];
      let z2 = this.state[o + 1];
      let z3 = this.state[o + 2];
      let z4 = this.state[o + 3];
      let pk = this.maxAbs;
      for (let i = 0; i < n; i++) {
        const v = x[i];
        if (v > pk) pk = v;
        else if (-v > pk) pk = -v;
        const xi = v + (i & 1 ? ANTI_DENORMAL : -ANTI_DENORMAL);
        const y1 = b0 * xi + z1;
        z1 = b1 * xi - a1 * y1 + z2;
        z2 = b2 * xi - a2 * y1;
        const y2 = y1 + z3;
        z3 = -2 * y1 - ha1 * y2 + z4;
        z4 = y1 - ha2 * y2;
        sq[i] += w * y2 * y2;
      }
      this.state[o] = z1;
      this.state[o + 1] = z2;
      this.state[o + 2] = z3;
      this.state[o + 3] = z4;
      this.maxAbs = pk;
    }
    let i = 0;
    while (i < n) {
      const take = Math.min(this.nextBoundary - this.sampleIndex, n - i);
      let s = 0;
      for (let j = i; j < i + take; j++) s += sq[j];
      this.acc += s;
      this.accCount += take;
      this.sampleIndex += take;
      i += take;
      if (this.sampleIndex >= this.nextBoundary) {
        this.emit(this.acc / this.accCount);
        this.acc = 0;
        this.accCount = 0;
        this.windowIndex++;
        this.nextBoundary = Math.max(this.sampleIndex + 1, Math.round((this.windowIndex + 1) * this.samplesPerWindow));
      }
    }
  }

  /** Ends the stream (a last partial window is kept) and returns the envelope. */
  finish(): Float32Array {
    if (this.accCount > 0) {
      this.emit(this.acc / this.accCount);
      this.acc = 0;
      this.accCount = 0;
    }
    return this.out.slice(0, this.outLength);
  }

  private emit(p: number): void {
    if (this.outLength === this.out.length) {
      const next = new Float32Array(this.out.length * 2);
      next.set(this.out);
      this.out = next;
    }
    this.out[this.outLength++] = p;
  }
}

/** Loudness in LUFS of a mean-square power value. */
export function powerToLufs(p: number): number {
  return p > 0 ? LUFS_OFFSET + 10 * Math.log10(p) : -Infinity;
}

/**
 * Integrated loudness (EBU R128): 400 ms blocks with 75 % overlap, absolute
 * gate -70 LUFS, relative gate -10 LU. -Infinity for silence. Clips shorter
 * than one block are measured as a single block.
 */
export function integratedLoudness(power: Float32Array, windowSec = 0.01): number {
  const n = power.length;
  if (n === 0) return -Infinity;
  const blockW = Math.max(1, Math.round(0.4 / windowSec));
  const stepW = Math.max(1, Math.round(0.1 / windowSec));
  const absGate = 10 ** ((ABSOLUTE_GATE_LUFS - LUFS_OFFSET) / 10);
  if (n < blockW) {
    let s = 0;
    for (let i = 0; i < n; i++) s += power[i];
    const z = s / n;
    return z > absGate ? powerToLufs(z) : -Infinity;
  }
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + power[i];
  const count = Math.floor((n - blockW) / stepW) + 1;
  const blocks = new Float64Array(count);
  let sum1 = 0;
  let n1 = 0;
  for (let j = 0; j < count; j++) {
    const s = j * stepW;
    const z = (prefix[s + blockW] - prefix[s]) / blockW;
    blocks[j] = z;
    if (z > absGate) {
      sum1 += z;
      n1++;
    }
  }
  if (n1 === 0) return -Infinity;
  const relGate = Math.max(absGate, (sum1 / n1) * 10 ** (RELATIVE_GATE_LU / 10));
  let sum2 = 0;
  let n2 = 0;
  for (let j = 0; j < count; j++) {
    if (blocks[j] > relGate) {
      sum2 += blocks[j];
      n2++;
    }
  }
  return n2 > 0 ? powerToLufs(sum2 / n2) : -Infinity;
}

/**
 * A mono file plays at full level on both channels of a player, while
 * BS.1770 counts a mono channel once. Adding this offset (3.01 dB) makes
 * mono and stereo files comparable on the box.
 */
export const MONO_PLAYBACK_OFFSET_DB = 10 * Math.log10(2);

/**
 * Loudness as heard on a player: the integrated loudness, plus 3.01 dB for
 * mono files. Measured from the power envelope when the backend did not
 * compute `lufs`; undefined for silent files.
 */
export function playbackLufs(analysis: { lufs?: number; channels: number; power?: Float32Array; windowSec?: number }): number | undefined {
  let lufs = analysis.lufs;
  if (lufs === undefined && analysis.power && analysis.windowSec) lufs = integratedLoudness(analysis.power, analysis.windowSec);
  if (lufs === undefined || !Number.isFinite(lufs)) return undefined;
  return analysis.channels === 1 ? lufs + MONO_PLAYBACK_OFFSET_DB : lufs;
}

/**
 * Loudness of several files played one after another (an album or the parts
 * of a book), gated over all their 400 ms blocks together as EBU R128
 * describes for programmes. Mono files count as heard on a player (see
 * playbackLufs). Use the result with stepsForTarget and apply the same steps
 * to every file, so the levels between the tracks stay as they were.
 */
export function albumLoudness(tracks: readonly { power: Float32Array; windowSec: number; channels: number }[]): number {
  const blocks: number[] = [];
  for (const t of tracks) {
    const n = t.power.length;
    const blockW = Math.max(1, Math.round(0.4 / t.windowSec));
    const stepW = Math.max(1, Math.round(0.1 / t.windowSec));
    const scale = t.channels === 1 ? 2 : 1;
    if (n === 0) continue;
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + t.power[i];
    if (n < blockW) {
      blocks.push((prefix[n] / n) * scale);
      continue;
    }
    for (let s = 0; s + blockW <= n; s += stepW) blocks.push(((prefix[s + blockW] - prefix[s]) / blockW) * scale);
  }
  const absGate = 10 ** ((ABSOLUTE_GATE_LUFS - LUFS_OFFSET) / 10);
  let sum1 = 0;
  let n1 = 0;
  for (const z of blocks) {
    if (z > absGate) {
      sum1 += z;
      n1++;
    }
  }
  if (n1 === 0) return -Infinity;
  const relGate = Math.max(absGate, (sum1 / n1) * 10 ** (RELATIVE_GATE_LU / 10));
  let sum2 = 0;
  let n2 = 0;
  for (const z of blocks) {
    if (z > relGate) {
      sum2 += z;
      n2++;
    }
  }
  return n2 > 0 ? powerToLufs(sum2 / n2) : -Infinity;
}

/** Per-window loudness in LUFS (10·log10(p) - 0.691), floored at -120. */
export function momentaryDb(power: Float32Array): Float32Array {
  const out = new Float32Array(power.length);
  for (let i = 0; i < power.length; i++) {
    const p = power[i];
    out[i] = p > 1e-12 ? LUFS_OFFSET + 10 * Math.log10(p) : -120;
  }
  return out;
}

/** Centered moving average of the power over `windows` windows. */
export function smoothPower(power: Float32Array, windows: number): Float32Array {
  const w = Math.max(1, Math.floor(windows));
  if (w === 1) return power.slice();
  const n = power.length;
  const out = new Float32Array(n);
  const half = Math.floor(w / 2);
  let sum = 0;
  let lo = 0;
  let hi = 0; // window is [lo, hi)
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, a + w);
    while (hi < b) sum += power[hi++];
    while (lo < a) sum -= power[lo++];
    out[i] = Math.max(0, sum / (hi - lo));
  }
  return out;
}

/* ------------------------------------------------------------------ album gain */

/** Ceiling of the converter's limiter (mp3encoder.ts, PeakLimiter), in dB of the true peak (dBTP). */
export const LIMITER_CEILING_DB = -1.5;

/** Loudness every album is brought to, in LUFS as heard on the box. */
export const TARGET_LUFS = -16;
/** Largest boost for quiet recordings, in dB. */
export const MAX_BOOST_DB = 12;
/** A quiet MP3 album that whole gain steps leave at least this far under its level is converted instead (when allowed). */
export const QUIET_SHORTFALL_DB = 3;

/**
 * The level a folder is brought to: TARGET_LUFS, plus its offset when it was
 * made quieter or louder on purpose (CatalogFolder.levelOffsetDb). With an
 * offset, lossless steps keep the loudest sample under the limiter's ceiling
 * as a converted file is: a folder made louder never clips, and one made
 * quieter only ever loses level, the same for every track.
 */
export function levelTarget(offsetDb = 0): { targetLufs: number; ceilingDb: number } {
  return { targetLufs: TARGET_LUFS + offsetDb, ceilingDb: offsetDb ? LIMITER_CEILING_DB : 0 };
}

/** The loudness change of an album: gain steps for the MP3 files it copies, decibels for the files it converts. */
export interface AlbumGain {
  /** Lossless global_gain steps for every copied MP3 (see applyGain). */
  steps: number;
  /** Change in dB for every converted file, so they match the MP3s. */
  convertDb: number;
  /**
   * How many dB the album stays under its wanted change, because more
   * whole steps would make the loudest MP3 sample clip. 0 when it gets there.
   */
  shortfallDb?: number;
  /**
   * How many dB the album stays under the level it should get
   * (targetLufs), with the steps it gets, or with the boost. Unlike
   * shortfallDb it also counts what lies beyond MAX_BOOST_DB.
   */
  quietDb?: number;
  /** The MP3 files are converted too, with a limiter, so the album reaches its level. */
  boosted?: boolean;
}

export interface AlbumGainInput {
  /** The album's loudness as heard on the box (albumLoudness). */
  lufs: number;
  /** Peak (0..1) of every MP3 that would be copied; undefined when not measured. Empty: no MP3s to copy. */
  mp3Peaks: readonly (number | undefined)[];
  /** Convert quiet MP3 albums when whole steps leave them QUIET_SHORTFALL_DB or more under their level. */
  boostQuietMp3?: boolean;
  /** Level to reach (default TARGET_LUFS); a folder made quieter or louder on purpose has its own. */
  targetLufs?: number;
  /** Highest peak (dBFS) lossless steps may lift the loudest MP3 sample to (default 0: just under clipping). */
  ceilingDb?: number;
}

/**
 * One gain for the whole album, so the levels between its tracks stay as
 * they were. MP3 files change in steps of 1.5 dB without a limiter, so they
 * are never boosted past the point where their loudest sample would clip.
 * When that keeps a quiet album far below its level, `boostQuietMp3`
 * converts its MP3s instead; the converter's limiter keeps the true peak
 * under -1.5 dBTP (LIMITER_CEILING_DB), so the decoded MP3 stays under 0 dBFS
 * (harshly clipped noise at 128 kbit/s can still go a little over).
 */
export function planAlbumGain({ lufs, mp3Peaks, boostQuietMp3, targetLufs = TARGET_LUFS, ceilingDb = 0 }: AlbumGainInput): AlbumGain {
  const wanted = Math.max(-30, Math.min(MAX_BOOST_DB, targetLufs - lufs));
  if (!mp3Peaks.length) return { steps: 0, convertDb: wanted, shortfallDb: 0 };
  let steps = Math.round(wanted / GAIN_STEP_DB);
  if (steps > 0) {
    const peak = mp3Peaks.every((p): p is number => p !== undefined) ? Math.max(...mp3Peaks) : undefined;
    const room = peak !== undefined && peak > 0 ? Math.floor((ceilingDb - 20 * Math.log10(peak)) / GAIN_STEP_DB + 1e-9) : 0;
    steps = Math.min(steps, Math.max(0, room));
  }
  if (steps === 0) steps = 0; // no -0
  const shortfallDb = Math.max(0, wanted - steps * GAIN_STEP_DB);
  // The boost goes up to MAX_BOOST_DB: a very quiet album still stays a little quieter.
  if (boostQuietMp3 && shortfallDb >= QUIET_SHORTFALL_DB) return { steps: 0, convertDb: wanted, shortfallDb: 0, quietDb: Math.max(0, targetLufs - lufs - wanted), boosted: true };
  // Converted files of the same album get the same change, so they match the MP3s.
  const quietDb = Math.max(0, targetLufs - lufs - steps * GAIN_STEP_DB);
  return { steps, convertDb: steps * GAIN_STEP_DB, shortfallDb, quietDb };
}
