/**
 * The wave picture of the trim editor from a power envelope (one value per
 * window, as AudioAnalysis.power or the rough levels of the frame scan).
 * A pyramid of maxima answers "the loudest window of each pixel column" in
 * a few steps per column, also for a three-hour book seen as a whole, so
 * dragging and zooming stay smooth.
 */

export class PeakPyramid {
  /** levels[0] is the envelope; each next level holds the maximum of two of the one before. */
  private readonly levels: Float32Array[];
  /** Running sums of the envelope, for the mean of a column. */
  private readonly sums: Float64Array;
  /** The loud end of the track (a high percentile), for the height of the picture. */
  readonly loud: number;

  constructor(
    power: Float32Array,
    readonly windowSec: number,
  ) {
    const levels = [power];
    while (levels[levels.length - 1].length > 1) {
      const prev = levels[levels.length - 1];
      const next = new Float32Array(Math.ceil(prev.length / 2));
      for (let i = 0; i < next.length; i++) {
        const a = prev[2 * i];
        const b = 2 * i + 1 < prev.length ? prev[2 * i + 1] : a;
        next[i] = a > b ? a : b;
      }
      levels.push(next);
    }
    this.levels = levels;
    this.sums = new Float64Array(power.length + 1);
    for (let i = 0; i < power.length; i++) this.sums[i + 1] = this.sums[i] + power[i];
    this.loud = loudOf(power);
  }

  get length(): number {
    return this.levels[0].length;
  }

  get durationSec(): number {
    return this.length * this.windowSec;
  }

  /** The largest power in windows [a, b). */
  max(a: number, b: number): number {
    const n = this.length;
    let lo = Math.max(0, Math.floor(a));
    let hi = Math.min(n, Math.ceil(b));
    if (hi <= lo) return lo < n && lo >= 0 ? this.levels[0][lo] : 0;
    let best = 0;
    let level = 0;
    // Climb while whole blocks fit: two pieces at the edges per level.
    while (lo < hi) {
      const arr = this.levels[level];
      if (lo & 1) {
        if (arr[lo] > best) best = arr[lo];
        lo++;
      }
      if (hi & 1) {
        hi--;
        if (arr[hi] > best) best = arr[hi];
      }
      lo >>= 1;
      hi >>= 1;
      level++;
      if (level >= this.levels.length) break;
    }
    return best;
  }

  /** The mean power of windows [a, b). */
  mean(a: number, b: number): number {
    const lo = Math.max(0, Math.min(this.length, Math.floor(a)));
    const hi = Math.max(lo + 1, Math.min(this.length, Math.ceil(b)));
    if (lo >= this.length) return 0;
    return (this.sums[hi] - this.sums[lo]) / (hi - lo);
  }

  /**
   * The height (0..1) of each of `columns` columns showing [fromSec, toSec):
   * the loudest window in it, as amplitude against the loud end of the
   * track. With `mean`, that array gets the height of the columns' mean
   * power (the body of the wave inside its peaks).
   */
  columns(fromSec: number, toSec: number, columns: number, out = new Float32Array(columns), mean?: Float32Array): Float32Array {
    const per = (toSec - fromSec) / this.windowSec / Math.max(1, columns);
    const start = fromSec / this.windowSec;
    for (let c = 0; c < columns; c++) {
      const a = start + c * per;
      const b = Math.max(a + per, Math.floor(a) + 1);
      out[c] = heightOf(this.max(a, b), this.loud);
      if (mean) mean[c] = heightOf(this.mean(a, b), this.loud);
    }
    return out;
  }
}

/** Amplitude against `loud`, a little compressed so that quiet speech still shows next to loud music. */
export function heightOf(power: number, loud: number): number {
  if (!(power > 0) || !(loud > 0)) return 0;
  return Math.min(1, 0.92 * Math.pow(power / loud, 0.4));
}

/** The 99.5th percentile of the audible windows (a few loud bangs do not flatten the rest). */
function loudOf(power: Float32Array): number {
  const step = Math.max(1, Math.floor(power.length / 20000));
  const sample: number[] = [];
  for (let i = 0; i < power.length; i += step) if (power[i] > 0) sample.push(power[i]);
  if (!sample.length) return 0;
  sample.sort((a, b) => a - b);
  return sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.995))];
}
