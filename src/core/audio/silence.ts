/**
 * Pause detection and split planning for long recordings.
 *
 * The DFPlayer cannot seek inside a file and TNG's audiobook mode only
 * remembers the track number, so long audiobooks are split into parts of a
 * few minutes, preferably in speech pauses. Everything here is pure and
 * deterministic; it works on the power envelope of AudioAnalysis.
 */
import { LUFS_OFFSET, smoothPower } from './loudness';

export interface Pause {
  startSec: number;
  endSec: number;
  /** Mean level of the pause in dB (LUFS scale, floor -100). */
  meanDb: number;
  /** 0..1: longer and deeper pauses score higher. */
  score: number;
  /** Where to cut: middle of the longest quiet stretch inside the pause. */
  cutSec: number;
}

export interface PauseOptions {
  /** Shortest pause to report (default 0.6 s). */
  minPauseSec?: number;
  /** Fixed threshold in dB (LUFS scale); automatic when omitted. */
  thresholdDb?: number;
  /** Level smoothing before thresholding (default 0.05 s). */
  smoothSec?: number;
  /** Breaths and clicks up to this length inside a pause are bridged (default 0.35 s). */
  bridgeSec?: number;
}

export interface LevelStats {
  /** Windows quieter than this count as pause. */
  thresholdDb: number;
  /** Typical speech level (90th percentile of the audible windows). */
  speechDb: number;
  /** Background level (10th percentile of all windows). */
  floorDb: number;
}

const FLOOR_DB = -100;
const BIN_DB = 0.25;
const HIST_MIN = FLOOR_DB;
const HIST_MAX = 20;

function levelsDb(power: Float32Array, windowSec: number, smoothSec: number): Float32Array {
  const sm = smoothPower(power, Math.max(1, Math.round(smoothSec / windowSec)));
  const out = new Float32Array(sm.length);
  for (let i = 0; i < sm.length; i++) {
    const p = sm[i];
    out[i] = p > 0 ? Math.max(FLOOR_DB, LUFS_OFFSET + 10 * Math.log10(p)) : FLOOR_DB;
  }
  return out;
}

/** Percentiles (0..1) of the values above `minDb`, by histogram (0.25 dB resolution). */
function percentiles(levels: Float32Array, ps: readonly number[], minDb = -Infinity): number[] | null {
  const bins = new Float64Array(Math.ceil((HIST_MAX - HIST_MIN) / BIN_DB) + 1);
  let count = 0;
  for (let i = 0; i < levels.length; i++) {
    const v = levels[i];
    if (v <= minDb) continue;
    const b = Math.min(bins.length - 1, Math.max(0, Math.floor((v - HIST_MIN) / BIN_DB)));
    bins[b]++;
    count++;
  }
  if (count === 0) return null;
  return ps.map((p) => {
    const want = p * count;
    let acc = 0;
    for (let b = 0; b < bins.length; b++) {
      acc += bins[b];
      if (acc >= want) return HIST_MIN + (b + 0.5) * BIN_DB;
    }
    return HIST_MAX;
  });
}

function statsFromLevels(levels: Float32Array): LevelStats {
  const all = percentiles(levels, [0.1, 0.9]) ?? [FLOOR_DB, FLOOR_DB];
  const audible = levels.reduce((n, v) => (v > -70 ? n + 1 : n), 0);
  const speech = audible >= Math.max(1, levels.length * 0.01) ? (percentiles(levels, [0.9], -70) as number[])[0] : all[1];
  const floor = Math.min(all[0], speech);
  const margin = Math.min(30, Math.max(6, 0.65 * (speech - floor)));
  return { thresholdDb: speech - margin, speechDb: speech, floorDb: floor };
}

/**
 * Automatic pause threshold from the level distribution: the speech level
 * (90th percentile of audible windows) minus a margin that adapts to the
 * distance to the background level (6 to 30 dB). Works for quiet and loud
 * recordings and keeps music beds under speech below the threshold.
 */
export function levelStats(power: Float32Array, windowSec: number, smoothSec = 0.05): LevelStats {
  return statsFromLevels(levelsDb(power, windowSec, smoothSec));
}

/** Finds speech pauses in a power envelope (AudioAnalysis.power). */
export function findPauses(power: Float32Array, windowSec: number, opts: PauseOptions = {}): Pause[] {
  const minPause = opts.minPauseSec ?? 0.6;
  const levels = levelsDb(power, windowSec, opts.smoothSec ?? 0.05);
  const stats = statsFromLevels(levels);
  const thr = opts.thresholdDb ?? stats.thresholdDb;
  // Gaps louder than this are words, not breaths or clicks.
  const bridgeMax = Math.min(stats.speechDb - 12, thr + 20);
  const bridgeW = Math.round((opts.bridgeSec ?? 0.35) / windowSec);
  const n = levels.length;

  // Raw runs below the threshold.
  const runs: [number, number][] = [];
  for (let i = 0; i < n; ) {
    if (levels[i] < thr) {
      const s = i;
      while (i < n && levels[i] < thr) i++;
      runs.push([s, i]);
    } else {
      i++;
    }
  }

  // Merge runs separated by short, quiet gaps (breaths, clicks).
  const groups: [number, number][][] = [];
  for (const run of runs) {
    const last = groups[groups.length - 1];
    if (last) {
      const prevEnd = last[last.length - 1][1];
      const gap = run[0] - prevEnd;
      if (gap <= bridgeW) {
        let loud = -Infinity;
        for (let i = prevEnd; i < run[0]; i++) if (levels[i] > loud) loud = levels[i];
        if (loud < bridgeMax) {
          last.push(run);
          continue;
        }
      }
    }
    groups.push([run]);
  }

  const pauses: Pause[] = [];
  for (const group of groups) {
    const s = group[0][0];
    const e = group[group.length - 1][1];
    const dur = (e - s) * windowSec;
    if (dur < minPause) continue;
    const inside = levels.subarray(s, e);
    let sumDb = 0;
    for (let i = 0; i < inside.length; i++) sumDb += inside[i];
    const meanDb = sumDb / inside.length;
    const depthScore = Math.min(1, Math.max(0, (thr - meanDb) / 20));
    const durScore = Math.min(1, Math.max(0, (dur - 0.3) / 1.7));
    pauses.push({
      startSec: s * windowSec,
      endSec: e * windowSec,
      meanDb,
      score: 0.7 * durScore + 0.3 * depthScore,
      cutSec: (s + quietestStretchCenter(inside, thr)) * windowSec,
    });
  }
  return pauses;
}

/**
 * Center (in windows, relative to the pause) of the longest stretch close to
 * the pause's own floor: a breath or click inside the pause never gets cut.
 */
function quietestStretchCenter(levels: Float32Array, thr: number): number {
  const floor = (percentiles(levels, [0.2]) ?? [FLOOR_DB])[0];
  const deep = Math.min(thr, floor + 6);
  let bestStart = 0;
  let bestLen = 0;
  for (let i = 0; i < levels.length; ) {
    if (levels[i] < deep) {
      const start = i;
      while (i < levels.length && levels[i] < deep) i++;
      if (i - start > bestLen) {
        bestLen = i - start;
        bestStart = start;
      }
    } else {
      i++;
    }
  }
  return bestLen > 0 ? bestStart + bestLen / 2 : levels.length / 2;
}

/* ------------------------------------------------------------ split planning */

export type CutKind = 'pause' | 'chapter' | 'quietest';

export interface Cut {
  timeSec: number;
  kind: CutKind;
  /** 0..1: how sure we are that this is a good place to cut. */
  confidence: number;
}

export interface SplitPart {
  startSec: number;
  endSec: number;
}

export interface SplitPlan {
  cuts: Cut[];
  parts: SplitPart[];
}

export interface ChapterMark {
  startSec: number;
  title?: string;
}

export interface PlanOptions {
  durationSec: number;
  pauses: readonly Pause[];
  /** Desired part length in seconds (e.g. 300–600). */
  targetSec: number;
  /** Allowed deviation from the target, as a fraction (default 0.35). */
  toleranceRatio?: number;
  /** No part may be shorter (default 60 s). */
  minPartSec?: number;
  /** Chapter marks; used as preferred cut positions. */
  chapters?: readonly ChapterMark[];
  /** Power envelope for the quietest-window fallback (recommended). */
  power?: Float32Array;
  windowSec?: number;
}

interface Candidate {
  t: number;
  kind: CutKind;
  cost: number;
  confidence: number;
}

const KIND_ORDER: Record<CutKind, number> = { chapter: 0, pause: 1, quietest: 2 };

function partsFromCuts(start: number, end: number, cuts: readonly Cut[]): SplitPart[] {
  const parts: SplitPart[] = [];
  let s = start;
  for (const c of cuts) {
    parts.push({ startSec: s, endSec: c.timeSec });
    s = c.timeSec;
  }
  parts.push({ startSec: s, endSec: end });
  return parts;
}

/** Length penalty: quadratic inside the tolerance, very steep outside. */
function lengthCost(len: number, target: number, tol: number): number {
  const d = Math.abs(len - target) / (target * tol);
  if (d <= 1) return d * d;
  const x = d - 1;
  return 1 + 20 * x + 20 * x * x;
}

interface QuietFinder {
  find(a: number, b: number): { t: number; confidence: number };
}

function quietFinder(power: Float32Array | undefined, windowSec: number | undefined): QuietFinder {
  if (!power || !windowSec || power.length === 0) {
    return { find: (a, b) => ({ t: (a + b) / 2, confidence: 0 }) };
  }
  const ws = windowSec;
  const smooth = smoothPower(power, Math.max(1, Math.round(0.4 / ws)));
  const levels = new Float32Array(smooth.length);
  for (let i = 0; i < smooth.length; i++) levels[i] = smooth[i] > 0 ? Math.max(FLOOR_DB, LUFS_OFFSET + 10 * Math.log10(smooth[i])) : FLOOR_DB;
  const median = (percentiles(levels, [0.5]) ?? [FLOOR_DB])[0];
  return {
    find(a, b) {
      const i0 = Math.max(0, Math.ceil(a / ws));
      const i1 = Math.min(levels.length, Math.floor(b / ws));
      if (i1 <= i0) return { t: (a + b) / 2, confidence: 0 };
      let best = i0;
      for (let i = i0 + 1; i < i1; i++) if (levels[i] < levels[best]) best = i;
      const confidence = Math.min(0.3, Math.max(0, ((median - levels[best]) / 40) * 0.3));
      return { t: (best + 0.5) * ws, confidence };
    },
  };
}

/** Plans cuts inside [start, end] by dynamic programming over candidate positions. */
function planRange(start: number, end: number, opts: PlanOptions, quiet: QuietFinder, pauseCands: readonly Candidate[], chapterCands: readonly Candidate[]): Cut[] {
  const target = opts.targetSec;
  const tol = opts.toleranceRatio ?? 0.35;
  const minPart = opts.minPartSec ?? 60;
  const span = end - start;
  if (!(target > 0) || span <= target * (1 + tol)) return [];

  const inside = (c: Candidate) => c.t > start && c.t < end;
  const cands: Candidate[] = [...chapterCands.filter(inside), ...pauseCands.filter(inside)];
  // Fallback: the quietest moment of every grid cell, so that each tolerance range has one.
  const cell = Math.max(5, target * tol);
  for (let a = start; a < end; a += cell) {
    const b = Math.min(end, a + cell);
    const q = quiet.find(a, b);
    if (q.t > start && q.t < end) cands.push({ t: q.t, kind: 'quietest', cost: 3, confidence: q.confidence });
  }
  cands.sort((x, y) => x.t - y.t || KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || x.cost - y.cost);

  const nodes: Candidate[] = [{ t: start, kind: 'chapter', cost: 0, confidence: 1 }, ...cands, { t: end, kind: 'chapter', cost: 0, confidence: 1 }];
  const n = nodes.length;
  const best = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  best[0] = 0;
  const maxLen = Math.max(target * (1 + tol) * 2.5, minPart * 2);
  let lo = 0;
  for (let i = 1; i < n; i++) {
    const ti = nodes[i].t;
    while (lo < i && ti - nodes[lo].t > maxLen) lo++;
    const cutCost = i === n - 1 ? 0 : nodes[i].cost;
    for (let j = lo; j < i; j++) {
      const len = ti - nodes[j].t;
      if (len < minPart) break; // later j are even closer
      if (best[j] === Infinity) continue;
      const c = best[j] + lengthCost(len, target, tol) + cutCost;
      if (c < best[i] - 1e-9) {
        best[i] = c;
        prev[i] = j;
      }
    }
  }
  if (best[n - 1] === Infinity) return [];
  const cuts: Cut[] = [];
  for (let i = prev[n - 1]; i > 0; i = prev[i]) {
    const c = nodes[i];
    cuts.push({ timeSec: c.t, kind: c.kind, confidence: c.confidence });
  }
  return cuts.reverse();
}

function pauseCandidates(pauses: readonly Pause[]): Candidate[] {
  return pauses.map((p) => {
    const score = Math.min(1, Math.max(0, p.score));
    return { t: p.cutSec ?? (p.startSec + p.endSec) / 2, kind: 'pause' as const, cost: 1 - score, confidence: 0.4 + 0.6 * score };
  });
}

function chapterCandidates(chapters: readonly ChapterMark[] | undefined): Candidate[] {
  return (chapters ?? []).map((c) => ({ t: c.startSec, kind: 'chapter' as const, cost: 0, confidence: 1 }));
}

/**
 * Chooses cuts near multiples of the target length: prefers long and deep
 * pauses and chapter marks, keeps the parts balanced, never makes a part
 * shorter than `minPartSec`, and falls back to the quietest moment when no
 * pause lies within the tolerance. Files up to target·(1 + tolerance) stay whole.
 */
export function planSplits(opts: PlanOptions): SplitPlan {
  const d = opts.durationSec;
  const quiet = quietFinder(opts.power, opts.windowSec);
  const cuts = planRange(0, d, opts, quiet, pauseCandidates(opts.pauses), chapterCandidates(opts.chapters));
  return { cuts, parts: partsFromCuts(0, d, cuts) };
}

export interface ChapterSplitOptions {
  /** Chapters shorter than this are merged into the next one (default 60 s). */
  minPartSec?: number;
  /**
   * When given, chapters longer than targetSec·(1 + toleranceRatio) are
   * split further with planSplits rules (pauses, quietest fallback).
   */
  targetSec?: number;
  toleranceRatio?: number;
  pauses?: readonly Pause[];
  power?: Float32Array;
  windowSec?: number;
}

/**
 * One part per chapter. Very short chapters (intros, credits) are merged into
 * the following chapter, a short last chapter into the previous one.
 */
export function cutsFromChapters(chapters: readonly ChapterMark[], durationSec: number, opts: ChapterSplitOptions = {}): SplitPlan {
  const minPart = opts.minPartSec ?? 60;
  const starts = [...new Set(chapters.map((c) => c.startSec).filter((t) => Number.isFinite(t) && t > 0.5 && t < durationSec - 0.5))].sort(
    (a, b) => a - b,
  );
  const boundaries: number[] = [];
  let partStart = 0;
  for (const b of starts) {
    if (b - partStart >= minPart) {
      boundaries.push(b);
      partStart = b;
    }
  }
  if (boundaries.length > 0 && durationSec - boundaries[boundaries.length - 1] < minPart) boundaries.pop();

  let cuts: Cut[] = boundaries.map((t) => ({ timeSec: t, kind: 'chapter' as const, confidence: 1 }));
  if (opts.targetSec && opts.targetSec > 0) {
    const planOpts: PlanOptions = {
      durationSec,
      pauses: opts.pauses ?? [],
      targetSec: opts.targetSec,
      toleranceRatio: opts.toleranceRatio,
      minPartSec: minPart,
      power: opts.power,
      windowSec: opts.windowSec,
    };
    const quiet = quietFinder(opts.power, opts.windowSec);
    const pauseCands = pauseCandidates(opts.pauses ?? []);
    const edges = [0, ...boundaries, durationSec];
    const all: Cut[] = [];
    for (let i = 0; i + 1 < edges.length; i++) {
      all.push(...planRange(edges[i], edges[i + 1], planOpts, quiet, pauseCands, []));
      if (i + 1 < edges.length - 1) all.push({ timeSec: edges[i + 1], kind: 'chapter', confidence: 1 });
    }
    cuts = all;
  }
  return { cuts, parts: partsFromCuts(0, durationSec, cuts) };
}

/* ------------------------------------------------------------ cuts from a track list */

export interface TrackCut {
  /** Where the cut goes. */
  timeSec: number;
  /** Where the track list put it. */
  expectedSec: number;
  /** In a pause near it, at the quietest moment near it (no pause there), or where the list put it (nothing measured). */
  kind: 'pause' | 'quietest' | 'exact';
}

export interface SnapOptions {
  durationSec: number;
  /** How far on each side of the expected place to look for a pause (default 6 s). */
  searchSec?: number;
  /** Cuts stay at least this far apart and away from both ends (default 5 s). */
  minGapSec?: number;
  /** Power envelope for the quietest-moment fallback. */
  power?: Float32Array;
  windowSec?: number;
}

/**
 * Moves the cuts of a known track list (a whole album in one file) into the
 * pauses between the tracks. A pause counts more the deeper and longer it
 * is and the closer to where the list puts the cut. The shift of one cut
 * carries over to the next: a rip with two seconds of silence in front has
 * every track two seconds later. Where no pause is near (live albums,
 * songs that run into each other) the cut goes to the quietest moment
 * close by, and without an envelope it stays where the list says.
 */
export function snapCutsToPauses(expected: readonly number[], pauses: readonly Pause[], opts: SnapOptions): TrackCut[] {
  const search = opts.searchSec ?? 6;
  const gap = opts.minGapSec ?? 5;
  const end = opts.durationSec;
  const quiet = opts.power && opts.windowSec ? quietFinder(opts.power, opts.windowSec) : undefined;
  const sorted = [...pauses].sort((a, b) => a.cutSec - b.cutSec);
  const out: TrackCut[] = [];
  let shift = 0;
  let prev = 0;
  for (const e of expected) {
    const lo = prev + gap;
    const hi = end - gap;
    if (lo > hi) break;
    const center = Math.min(hi, Math.max(lo, e + shift));
    let best: Pause | undefined;
    let bestValue = -Infinity;
    for (const p of sorted) {
      if (p.cutSec < lo || p.cutSec > hi) continue;
      const dist = Math.abs(p.cutSec - center);
      if (dist > search) continue;
      const value = Math.min(1, Math.max(0, p.score)) - 0.6 * (dist / search);
      if (value > bestValue) {
        bestValue = value;
        best = p;
      }
    }
    let cut: TrackCut;
    if (best) {
      cut = { timeSec: best.cutSec, expectedSec: e, kind: 'pause' };
      shift = best.cutSec - e;
    } else if (quiet) {
      const q = quiet.find(Math.max(lo, center - search / 2), Math.min(hi, center + search / 2));
      cut = { timeSec: Math.min(hi, Math.max(lo, q.t)), expectedSec: e, kind: 'quietest' };
    } else {
      cut = { timeSec: center, expectedSec: e, kind: 'exact' };
    }
    out.push(cut);
    prev = cut.timeSec;
  }
  return out;
}
