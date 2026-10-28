/**
 * The trim editor's rules (src/features/trim/model.ts) and its wave picture
 * (peaks.ts), without a screen.
 */
import { describe, expect, it } from 'vitest';
import { MIN_TRIMMED_SEC } from '../../src/core/audio/mp3trim';
import { wholeTrack } from '../../src/core/audio/trimedit';
import {
  addCut,
  clockTime,
  commit,
  MIN_CUT_SEC,
  MIN_GAP_SEC,
  MIN_VIEW_SEC,
  moveGrip,
  panView,
  playableFrom,
  redo,
  removeCut,
  showTime,
  snapToPause,
  startHistory,
  undo,
  wholeView,
  zoomView,
} from '../../src/features/trim/model';
import { heightOf, PeakPyramid } from '../../src/features/trim/peaks';

const D = 600;

describe('the grips', () => {
  it('keep start and end apart, inside the track, and outside the pieces cut out', () => {
    let e = wholeTrack(D);
    e = moveGrip(e, { kind: 'start' }, -5, D);
    expect(e.startSec).toBe(0);
    e = moveGrip(e, { kind: 'start' }, 30, D);
    e = moveGrip(e, { kind: 'end' }, 700, D);
    expect(e.endSec).toBe(D);
    e = moveGrip(e, { kind: 'end' }, 10, D);
    expect(e.endSec).toBe(30 + MIN_TRIMMED_SEC);
    e = moveGrip(e, { kind: 'end' }, 500, D);
    e = addCut(e, 100, 20)!;
    expect(e.cuts).toEqual([{ fromSec: 90, toSec: 110 }]);
    // The start stops before the piece, the end after it.
    expect(moveGrip(e, { kind: 'start' }, 200, D).startSec).toBe(90 - MIN_GAP_SEC);
    expect(moveGrip(e, { kind: 'end' }, 50, D).endSec).toBe(110 + MIN_GAP_SEC);
    // The edges of a piece stay in order and between its neighbours.
    expect(moveGrip(e, { kind: 'from', cut: 0 }, 200, D).cuts[0].fromSec).toBe(110 - MIN_CUT_SEC);
    expect(moveGrip(e, { kind: 'from', cut: 0 }, 0, D).cuts[0].fromSec).toBe(30 + MIN_GAP_SEC);
    expect(moveGrip(e, { kind: 'to', cut: 0 }, 900, D).cuts[0].toSec).toBe(500 - MIN_GAP_SEC);
  });

  it('cut a new piece out where there is room, never inside another one', () => {
    let e = wholeTrack(D);
    e = addCut(e, 300, 40)!;
    e = addCut(e, 100, 40)!;
    expect(e.cuts.map((c) => c.fromSec)).toEqual([80, 280]);
    expect(addCut(e, 300, 10)).toBeNull();
    // Squeezed in between: narrower than asked.
    const between = addCut(e, 200, 500)!;
    expect(between.cuts[1].fromSec).toBeCloseTo(120 + MIN_GAP_SEC, 9);
    expect(between.cuts[1].toSec).toBeCloseTo(280 - MIN_GAP_SEC, 9);
    // Near the start: moved inside.
    expect(addCut(wholeTrack(D), 1, 20)!.cuts[0].fromSec).toBeCloseTo(MIN_GAP_SEC, 9);
    // Never everything.
    expect(addCut({ startSec: 0, endSec: 1.2, cuts: [] }, 0.6, 1)).toBeNull();
    expect(removeCut(e, 0).cuts).toEqual([{ fromSec: 280, toSec: 320 }]);
  });

  it('snap to the nearest pause within the tolerance', () => {
    const places = [10, 20.5, 31, 47];
    expect(snapToPause(20, places, 1)).toEqual({ sec: 20.5, snapped: true });
    expect(snapToPause(25, places, 1)).toEqual({ sec: 25, snapped: false });
    expect(snapToPause(46.2, places, 1)).toEqual({ sec: 47, snapped: true });
    expect(snapToPause(0, places, 20)).toEqual({ sec: 10, snapped: true });
    expect(snapToPause(5, [], 20)).toEqual({ sec: 5, snapped: false });
  });
});

describe('undo and redo', () => {
  it('go back and forth one step at a time, and a new step forgets what was undone', () => {
    let h = startHistory(wholeTrack(D));
    const a = moveGrip(h.edit, { kind: 'start' }, 10, D);
    h = commit(h, a);
    h = commit(h, a); // the same again is no step
    const b = moveGrip(a, { kind: 'end' }, 500, D);
    h = commit(h, b);
    expect(h.past).toHaveLength(2);
    h = undo(h);
    expect(h.edit).toEqual(a);
    h = undo(h);
    expect(h.edit).toEqual(wholeTrack(D));
    expect(undo(h)).toBe(h);
    h = redo(h);
    expect(h.edit).toEqual(a);
    h = commit(h, addCut(a, 100, 10)!);
    expect(h.future).toHaveLength(0);
    expect(redo(h)).toBe(h);
  });
});

describe('the part that shows', () => {
  it('zooms around the pointer, pans, and stays inside the track', () => {
    const v = wholeView(D);
    const z = zoomView(v, 0.5, 150, D);
    // 150 s stays a quarter in from the left.
    expect(z).toEqual({ fromSec: 75, toSec: 375 });
    expect(zoomView(z, 1e-6, 100, D).toSec - zoomView(z, 1e-6, 100, D).fromSec).toBe(MIN_VIEW_SEC);
    expect(zoomView(z, 100, 100, D)).toEqual(v);
    expect(panView(z, -500, D)).toEqual({ fromSec: 0, toSec: 300 });
    expect(panView(z, 500, D)).toEqual({ fromSec: 300, toSec: 600 });
    expect(showTime({ fromSec: 100, toSec: 200 }, 250, D)).toEqual({ fromSec: 160, toSec: 260 });
    expect(showTime({ fromSec: 100, toSec: 200 }, 150, D)).toEqual({ fromSec: 100, toSec: 200 });
  });
});

describe('playing the track as it will be', () => {
  it('starts at the new start, jumps over pieces cut out, and stops at the new end', () => {
    const e = { startSec: 5, endSec: 100, cuts: [{ fromSec: 20, toSec: 30 }] };
    expect(playableFrom(e, 0)).toBe(5);
    expect(playableFrom(e, 25)).toBe(30);
    expect(playableFrom(e, 40)).toBe(40);
    expect(playableFrom(e, 100)).toBeNull();
  });

  it('writes times with tenths, and hours only for long books', () => {
    expect(clockTime(65.24)).toBe('1:05,2');
    expect(clockTime(3 * 3600 + 62)).toBe('3:01:02,0');
    expect(clockTime(59.96)).toBe('1:00,0');
    expect(clockTime(12, false)).toBe('0:12');
  });
});

describe('the wave picture', () => {
  it('finds the loudest window of each column quickly, also for a three-hour book', () => {
    // Three hours of 10 ms windows: speech for an hour and a half, then silence with one loud second at 2:00:00.
    const n = 3 * 3600 * 100;
    const power = new Float32Array(n);
    power.fill(1e-2, 0, n / 2);
    for (let i = 720000; i < 720100; i++) power[i] = 1;
    const p = new PeakPyramid(power, 0.01);
    expect(p.max(0, n)).toBe(1);
    expect(p.max(0, 720000)).toBeCloseTo(1e-2, 9);
    expect(p.max(720099, 720100)).toBe(1);
    expect(p.max(720100, n)).toBe(0);
    expect(p.max(n / 2 - 1, n / 2 + 1)).toBeCloseTo(1e-2, 9);
    const started = performance.now();
    const cols = p.columns(0, 3 * 3600, 2000);
    expect(performance.now() - started).toBeLessThan(50);
    expect(cols.slice(0, 1000).every((c) => c === cols[0] && c > 0.9)).toBe(true);
    expect(cols.slice(1000).filter((c) => c > 0)).toHaveLength(1);
    expect(cols[1333]).toBe(1);
    // Zoomed far in: one window spreads over several columns.
    const close = p.columns(7199.5, 7200.5, 400);
    expect(close[0]).toBeLessThan(0.1);
    expect(close[399]).toBe(1);
  });

  it('draws silence flat and keeps quiet speech visible', () => {
    expect(heightOf(0, 1)).toBe(0);
    expect(heightOf(1, 1)).toBeCloseTo(0.92, 6);
    // 20 dB quieter: still a seventh of the height.
    expect(heightOf(0.01, 1)).toBeGreaterThan(0.14);
    expect(heightOf(3, 1)).toBe(1);
  });
});
