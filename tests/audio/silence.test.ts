import { describe, expect, it } from 'vitest';
import { cutsFromChapters, findPauses, levelStats, planSplits, type Pause } from '../../src/core/audio/silence';

const WS = 0.01;

/** Deterministic pseudo random numbers in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Section {
  sec: number;
  /** 'speech' fluctuates around the level with syllables and short word gaps. */
  kind: 'speech' | 'pause';
  db: number;
}

/** Power envelope (10 ms windows) of a speech-like recording. */
function envelope(sections: Section[], seed = 1): Float32Array {
  const rand = rng(seed);
  const n = sections.reduce((a, s) => a + Math.round(s.sec / WS), 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const s of sections) {
    const len = Math.round(s.sec / WS);
    for (let i = 0; i < len; i++) {
      let db: number;
      if (s.kind === 'speech') {
        // syllables (~200 ms) with dips; every ~1.5 s a short word gap of 120 ms
        const syll = Math.sin((2 * Math.PI * i) / 20);
        db = s.db + 6 * syll + (rand() - 0.5) * 6;
        if (i % 150 >= 138 && i > 30 && i < len - 30) db = s.db - 25 + rand() * 4;
      } else {
        db = s.db + (rand() - 0.5) * 4;
      }
      out[o + i] = 10 ** ((db + 0.691) / 10);
    }
    o += len;
  }
  return out;
}

function speechWithPauses(total: number, pauses: [number, number][], speechDb: number, pauseDb: number, seed = 1): Float32Array {
  const sections: Section[] = [];
  let t = 0;
  for (const [s, e] of pauses) {
    if (s > t) sections.push({ sec: s - t, kind: 'speech', db: speechDb });
    sections.push({ sec: e - s, kind: 'pause', db: pauseDb });
    t = e;
  }
  if (total > t) sections.push({ sec: total - t, kind: 'speech', db: speechDb });
  return envelope(sections, seed);
}

const KNOWN: [number, number][] = [
  [10, 11],
  [25, 26.5],
  [40, 40.8],
  [52.3, 53.1],
];

function expectPausesNear(found: Pause[], expected: [number, number][]) {
  expect(found).toHaveLength(expected.length);
  found.forEach((p, i) => {
    expect(Math.abs(p.startSec - expected[i][0])).toBeLessThan(0.08);
    expect(Math.abs(p.endSec - expected[i][1])).toBeLessThan(0.08);
    expect(p.cutSec).toBeGreaterThan(p.startSec);
    expect(p.cutSec).toBeLessThan(p.endSec);
    expect(p.score).toBeGreaterThan(0);
    expect(p.score).toBeLessThanOrEqual(1);
  });
}

describe('findPauses', () => {
  it('finds sentence pauses but not word gaps (clean studio recording)', () => {
    const power = speechWithPauses(60, KNOWN, -20, -62);
    const found = findPauses(power, WS);
    expectPausesNear(found, KNOWN);
    expect(found[1].score).toBeGreaterThan(found[2].score); // 1.5 s beats 0.8 s
    expect(found[0].meanDb).toBeCloseTo(-62, 0);
  });

  it('works for quiet recordings', () => {
    const power = speechWithPauses(60, KNOWN, -42, -80);
    expectPausesNear(findPauses(power, WS), KNOWN);
  });

  it('works with a music bed under the speech', () => {
    const power = speechWithPauses(60, KNOWN, -18, -33, 7);
    const stats = levelStats(power, WS);
    expect(stats.thresholdDb).toBeGreaterThan(-33);
    expect(stats.thresholdDb).toBeLessThan(-22);
    expectPausesNear(findPauses(power, WS), KNOWN);
  });

  it('bridges a breath inside a pause', () => {
    const sections: Section[] = [
      { sec: 5, kind: 'speech', db: -20 },
      { sec: 0.5, kind: 'pause', db: -65 },
      { sec: 0.25, kind: 'pause', db: -40 }, // breath
      { sec: 0.5, kind: 'pause', db: -65 },
      { sec: 5, kind: 'speech', db: -20 },
    ];
    const found = findPauses(envelope(sections), WS);
    expect(found).toHaveLength(1);
    expect(found[0].startSec).toBeCloseTo(5, 1);
    expect(found[0].endSec).toBeCloseTo(6.25, 1);
    // the cut goes into one of the quiet stretches, not into the breath
    expect(found[0].cutSec < 5.5 || found[0].cutSec > 5.75).toBe(true);
  });

  it('respects minPauseSec and a fixed threshold', () => {
    const power = speechWithPauses(60, KNOWN, -20, -62);
    expect(findPauses(power, WS, { minPauseSec: 1.2 }).map((p) => Math.round(p.startSec))).toEqual([25]);
    expect(findPauses(power, WS, { thresholdDb: -70 })).toHaveLength(0);
  });

  it('treats digital silence as pause', () => {
    const power = speechWithPauses(30, [[12, 14]], -20, -200);
    for (let i = 1200; i < 1400; i++) power[i] = 0;
    const found = findPauses(power, WS);
    expect(found).toHaveLength(1);
    expect(found[0].meanDb).toBeLessThan(-95);
    expect(found[0].cutSec).toBeCloseTo(13, 1);
  });
});

describe('planSplits', () => {
  it('keeps short files whole', () => {
    const plan = planSplits({ durationSec: 700, pauses: [], targetSec: 600 });
    expect(plan.cuts).toEqual([]);
    expect(plan.parts).toEqual([{ startSec: 0, endSec: 700 }]);
  });

  it('cuts in pauses near multiples of the target and keeps parts balanced', () => {
    const rand = rng(42);
    const pauses: Pause[] = [];
    for (let t = 3; t < 3600; t += 2 + rand() * 12) {
      const dur = 0.6 + rand() * 1.5;
      pauses.push({ startSec: t, endSec: t + dur, meanDb: -60, score: Math.min(1, (dur - 0.3) / 1.7), cutSec: t + dur / 2 });
    }
    const plan = planSplits({ durationSec: 3600, pauses, targetSec: 600 });
    expect(plan.parts).toHaveLength(6);
    for (const p of plan.parts) {
      const len = p.endSec - p.startSec;
      expect(len).toBeGreaterThan(600 * 0.65);
      expect(len).toBeLessThan(600 * 1.35);
    }
    for (const c of plan.cuts) {
      expect(c.kind).toBe('pause');
      expect(pauses.some((p) => p.cutSec === c.timeSec)).toBe(true);
      expect(c.confidence).toBeGreaterThan(0.4);
    }
    expect(plan.parts[0].startSec).toBe(0);
    expect(plan.parts[plan.parts.length - 1].endSec).toBe(3600);
    // deterministic and independent of the order of the pauses
    const shuffled = [...pauses].reverse();
    expect(planSplits({ durationSec: 3600, pauses: shuffled, targetSec: 600 })).toEqual(plan);
  });

  it('prefers long pauses within the tolerance', () => {
    const p = (t: number, score: number): Pause => ({ startSec: t - 0.5, endSec: t + 0.5, meanDb: -60, score, cutSec: t });
    const pauses = [p(560, 0.2), p(590, 0.25), p(650, 1), p(1180, 0.3), p(1260, 0.95)];
    const plan = planSplits({ durationSec: 1800, pauses, targetSec: 600 });
    expect(plan.cuts.map((c) => c.timeSec)).toEqual([650, 1260]);
  });

  it('handles unevenly spaced pauses', () => {
    // pauses only in a few irregular clusters
    const pauses: Pause[] = [];
    for (const center of [300, 430, 1020, 1100, 1480, 1890]) {
      for (let k = -3; k <= 3; k++) {
        const t = center + k * 4;
        pauses.push({ startSec: t - 0.4, endSec: t + 0.4, meanDb: -55, score: 0.5, cutSec: t });
      }
    }
    const plan = planSplits({ durationSec: 2000, pauses, targetSec: 500, toleranceRatio: 0.35 });
    for (const part of plan.parts) {
      const len = part.endSec - part.startSec;
      expect(len).toBeGreaterThanOrEqual(500 * 0.65 - 1);
      expect(len).toBeLessThanOrEqual(500 * 1.35 + 1);
    }
    expect(plan.cuts.every((c) => c.kind === 'pause')).toBe(true);
  });

  it('falls back to the quietest moment when no pause qualifies', () => {
    // continuous sound at -20 with two quiet dips (-40) at 610 s and 1190 s
    const n = 1800 / WS;
    const power = new Float32Array(n).fill(10 ** ((-20 + 0.691) / 10));
    for (const t of [610, 1190]) for (let i = (t - 0.2) / WS; i < (t + 0.2) / WS; i++) power[Math.round(i)] = 10 ** ((-40 + 0.691) / 10);
    const plan = planSplits({ durationSec: 1800, pauses: [], targetSec: 600, power, windowSec: WS });
    expect(plan.cuts).toHaveLength(2);
    expect(plan.cuts.every((c) => c.kind === 'quietest')).toBe(true);
    expect(plan.cuts[0].timeSec).toBeCloseTo(610, 0);
    expect(plan.cuts[1].timeSec).toBeCloseTo(1190, 0);
    expect(plan.cuts[0].confidence).toBeLessThanOrEqual(0.3);
    // without an envelope it still cuts, near the targets
    const blind = planSplits({ durationSec: 1800, pauses: [], targetSec: 600 });
    expect(blind.cuts).toHaveLength(2);
    expect(blind.cuts.every((c) => c.confidence === 0)).toBe(true);
  });

  it('never makes parts shorter than minPartSec', () => {
    const pauses: Pause[] = [{ startSec: 95, endSec: 96, meanDb: -60, score: 1, cutSec: 95.5 }];
    const plan = planSplits({ durationSec: 150, pauses, targetSec: 60, minPartSec: 60 });
    for (const p of plan.parts) expect(p.endSec - p.startSec).toBeGreaterThanOrEqual(60);
  });

  it('uses chapter marks as preferred cuts', () => {
    const pauses: Pause[] = [580, 600, 620, 1190, 1210].map((t) => ({ startSec: t - 0.5, endSec: t + 0.5, meanDb: -60, score: 0.8, cutSec: t }));
    const chapters = [{ startSec: 0 }, { startSec: 640, title: 'Kapitel 2' }, { startSec: 1250, title: 'Kapitel 3' }];
    const plan = planSplits({ durationSec: 1800, pauses, targetSec: 600, chapters });
    expect(plan.cuts.map((c) => [c.timeSec, c.kind])).toEqual([
      [640, 'chapter'],
      [1250, 'chapter'],
    ]);
    expect(plan.cuts[0].confidence).toBe(1);
  });
});

describe('cutsFromChapters', () => {
  it('cuts at chapters and merges very short ones', () => {
    const chapters = [
      { startSec: 0, title: 'Ansage' },
      { startSec: 12, title: 'Kapitel 1' },
      { startSec: 400, title: 'Kapitel 2' },
      { startSec: 430, title: 'Zwischenspiel' },
      { startSec: 445, title: 'Kapitel 3' },
      { startSec: 900, title: 'Abspann' },
    ];
    const plan = cutsFromChapters(chapters, 930);
    // "Ansage" joins chapter 1, "Kapitel 2" + "Zwischenspiel" join chapter 3, the short end joins the last part
    expect(plan.cuts.map((c) => c.timeSec)).toEqual([400]);
    expect(plan.parts).toEqual([
      { startSec: 0, endSec: 400 },
      { startSec: 400, endSec: 930 },
    ]);
    expect(cutsFromChapters(chapters, 930, { minPartSec: 10 }).cuts.map((c) => c.timeSec)).toEqual([12, 400, 430, 445, 900]);
  });

  it('splits very long chapters further when a target is given', () => {
    const chapters = [{ startSec: 0 }, { startSec: 300 }, { startSec: 2100 }];
    const pauses: Pause[] = [];
    for (let t = 310; t < 2400; t += 7) pauses.push({ startSec: t, endSec: t + 1, meanDb: -60, score: 0.6, cutSec: t + 0.5 });
    const plan = cutsFromChapters(chapters, 2400, { targetSec: 600, pauses });
    expect(plan.cuts.filter((c) => c.kind === 'chapter').map((c) => c.timeSec)).toEqual([300, 2100]);
    const inner = plan.cuts.filter((c) => c.kind === 'pause');
    expect(inner.length).toBe(2); // 1800 s chapter → 3 parts
    for (const p of plan.parts) expect(p.endSec - p.startSec).toBeLessThanOrEqual(600 * 1.35);
  });
});
