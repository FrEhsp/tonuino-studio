/**
 * Streaming sample-rate conversion with a polyphase Kaiser-windowed sinc
 * filter. Rational ratios (44.1k↔48k, 22.05k→44.1k, 32k→44.1k, …) use an
 * exact phase table; other ratios interpolate between 4096 phases.
 *
 * "high": 32 zero crossings per side, Kaiser β 8.5 (≈ 85 dB stopband),
 * passband to ~0.9 of the lower Nyquist frequency. "fast": 8 crossings.
 */

export type ResampleQuality = 'high' | 'fast';

export interface ResamplerOptions {
  quality?: ResampleQuality;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const y = (x * x) / 4;
  for (let k = 1; k < 100; k++) {
    term *= y / (k * k);
    sum += term;
    if (term < sum * 1e-15) break;
  }
  return sum;
}

interface FilterBank {
  /** Number of phase rows (plus one extra row for interpolation). */
  phases: number;
  /** Taps per phase (2·K). */
  taps: number;
  /** Taps on the left of the output time: input offsets -(K-1) … K. */
  half: number;
  table: Float32Array;
  /** True when phases = L, so no interpolation is needed. */
  exact: boolean;
}

const MAX_PHASES = 4096;

function designBank(inRate: number, outRate: number, l: number, quality: ResampleQuality): FilterBank {
  const zeroCrossings = quality === 'fast' ? 8 : 32;
  const beta = quality === 'fast' ? 6 : 8.5;
  const cutoff = (quality === 'fast' ? 0.9 : 0.94) * Math.min(1, outRate / inRate); // fraction of the input Nyquist
  const width = zeroCrossings / cutoff; // half length in input samples
  const half = Math.ceil(width);
  const taps = 2 * half;
  const exact = l <= MAX_PHASES;
  const phases = exact ? l : MAX_PHASES;
  const table = new Float32Array((phases + 1) * taps);
  const i0beta = besselI0(beta);
  for (let p = 0; p <= phases; p++) {
    const frac = p / phases;
    let sum = 0;
    const row = p * taps;
    for (let j = 0; j < taps; j++) {
      const tau = frac - (j - (half - 1)); // output time minus input sample time
      let h = 0;
      if (Math.abs(tau) < width) {
        const x = cutoff * tau;
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const r = tau / width;
        h = cutoff * sinc * (besselI0(beta * Math.sqrt(1 - r * r)) / i0beta);
      }
      table[row + j] = h;
      sum += h;
    }
    for (let j = 0; j < taps; j++) table[row + j] /= sum; // unity gain at DC for every phase
  }
  return { phases, taps, half, table, exact };
}

const bankCache = new Map<string, FilterBank>();

function getBank(inRate: number, outRate: number, l: number, quality: ResampleQuality): FilterBank {
  const key = `${inRate}/${outRate}/${quality}`;
  let bank = bankCache.get(key);
  if (!bank) {
    bank = designBank(inRate, outRate, l, quality);
    if (bankCache.size > 16) bankCache.clear();
    bankCache.set(key, bank);
  }
  return bank;
}

export class Resampler {
  readonly inRate: number;
  readonly outRate: number;
  readonly channels: number;
  private readonly bank: FilterBank;
  /** Output step in input samples is M/L. */
  private readonly l: number;
  private readonly m: number;
  private hist: Float32Array[];
  /** Absolute input index of hist[c][0]. */
  private histStart: number;
  /** Input index and phase (0..L-1) of the next output sample. */
  private n = 0;
  private rem = 0;
  private inCount = 0;
  private outCount = 0;
  private flushed = false;

  constructor(inRate: number, outRate: number, channels: number, opts: ResamplerOptions = {}) {
    if (!(inRate > 0) || !(outRate > 0) || !Number.isInteger(inRate) || !Number.isInteger(outRate)) throw new RangeError('Sample rates must be positive integers');
    this.inRate = inRate;
    this.outRate = outRate;
    this.channels = channels;
    const g = gcd(inRate, outRate);
    this.l = outRate / g;
    this.m = inRate / g;
    this.bank = getBank(inRate, outRate, this.l, opts.quality ?? 'high');
    const pre = this.bank.half - 1;
    this.hist = Array.from({ length: channels }, () => new Float32Array(pre));
    this.histStart = -pre;
  }

  /** Output samples that `inputSamples` input samples will produce in total. */
  outputLength(inputSamples: number): number {
    return Math.ceil((inputSamples * this.l) / this.m);
  }

  /** Resamples a block; returns every output sample that can already be computed. */
  process(input: readonly Float32Array[]): Float32Array[] {
    if (this.flushed) throw new Error('Resampler already flushed');
    const len = input[0]?.length ?? 0;
    if (len > 0) {
      this.append(input, len);
      this.inCount += len;
    }
    return this.run(this.inCount, Infinity);
  }

  /** Ends the stream and returns the remaining output. */
  flush(): Float32Array[] {
    if (this.flushed) return this.hist.map(() => new Float32Array(0));
    this.flushed = true;
    const pad = this.bank.half + 1;
    this.append(
      this.hist.map(() => new Float32Array(pad)),
      pad,
    );
    return this.run(this.inCount + pad, this.outputLength(this.inCount) - this.outCount);
  }

  /** Drops history the next output no longer needs and appends `len` new samples. */
  private append(input: readonly Float32Array[], len: number): void {
    const oldLength = this.hist[0]?.length ?? 0;
    const drop = Math.min(oldLength, Math.max(0, this.n - (this.bank.half - 1) - this.histStart));
    for (let c = 0; c < this.channels; c++) {
      const kept = this.hist[c].subarray(drop);
      const merged = new Float32Array(kept.length + len);
      merged.set(kept);
      merged.set((input[c] ?? input[0]).subarray(0, len), kept.length);
      this.hist[c] = merged;
    }
    this.histStart += drop;
  }

  private run(availEnd: number, maxOut: number): Float32Array[] {
    const { taps, half, table, exact, phases } = this.bank;
    const l = this.l;
    const m = this.m;
    // Outputs with n + half < availEnd can be computed.
    const lastN = availEnd - half - 1;
    let count = 0;
    if (lastN >= this.n) {
      count = Math.floor(((lastN - this.n) * l + (l - 1 - this.rem)) / m) + 1;
      // the formula counts outputs whose input index stays <= lastN
    }
    count = Math.max(0, Math.min(count, maxOut));
    const out = this.hist.map(() => new Float32Array(count));
    const coef = new Float32Array(taps);
    let n = this.n;
    let rem = this.rem;
    for (let o = 0; o < count; o++) {
      let row: Float32Array;
      if (exact) {
        row = table.subarray(rem * taps, rem * taps + taps);
      } else {
        const pf = (rem / l) * phases;
        const p0 = Math.floor(pf);
        const a = pf - p0;
        const r0 = p0 * taps;
        const r1 = r0 + taps;
        for (let j = 0; j < taps; j++) coef[j] = table[r0 + j] + a * (table[r1 + j] - table[r0 + j]);
        row = coef;
      }
      const off = n - (half - 1) - this.histStart;
      for (let c = 0; c < this.channels; c++) {
        const h = this.hist[c];
        let s = 0;
        for (let j = 0; j < taps; j++) s += h[off + j] * row[j];
        out[c][o] = s;
      }
      rem += m;
      if (rem >= l) {
        n += Math.floor(rem / l);
        rem %= l;
      }
    }
    this.n = n;
    this.rem = rem;
    this.outCount += count;
    return out;
  }
}

/** Resamples complete signals in one go. */
export function resampleBuffer(input: readonly Float32Array[], inRate: number, outRate: number, opts: ResamplerOptions = {}): Float32Array[] {
  if (inRate === outRate) return input.map((x) => x.slice());
  const r = new Resampler(inRate, outRate, input.length, opts);
  const a = r.process(input);
  const b = r.flush();
  return a.map((x, c) => {
    const out = new Float32Array(x.length + b[c].length);
    out.set(x);
    out.set(b[c], x.length);
    return out;
  });
}
