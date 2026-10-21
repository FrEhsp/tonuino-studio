/**
 * Cover analysis (src/core/covers/analyse.ts) on generated test pictures:
 * a printed frame, flat and patterned edges, parts on plain ground.
 */
import { describe, expect, it } from 'vitest';
import { analyseCover, findFrame, flatness, groundAround, measureEdge, partAlpha } from '../../src/core/covers/analyse';
import { busyGrid, largestRect, makePixels, medianColor, shrinkPixels, type Pixels } from '../../src/core/covers/pixels';
import { blob, busy, clouds, fence, frame, night, stars } from './pictures';

describe('findFrame', () => {
  it('finds a frame printed all around and its colour', () => {
    const p = frame(night(200, 200), 8, { r: 50, g: 168, b: 224 });
    const f = findFrame(p)!;
    expect(f).not.toBeNull();
    expect(f.top * 200).toBeGreaterThanOrEqual(8);
    expect(f.top * 200).toBeLessThan(11);
    expect(f.color.b).toBeGreaterThan(200);
    expect(f.color.r).toBeLessThan(80);
  });

  it('takes one plain side for sky, not for a frame', () => {
    const p = night(200, 200);
    // A coloured picture below a plain band at the top only.
    for (let y = 20; y < 200; y++) for (let x = 0; x < 200; x++) p.data.set([(x * 7) % 255, (y * 5) % 255, 90, 255], (y * 200 + x) * 4);
    expect(findFrame(p)).toBeNull();
  });

  it('finds no frame on a picture without one', () => {
    expect(findFrame(clouds(200, 200))).toBeNull();
  });
});

describe('measureEdge', () => {
  it('calls a night sky with a few small stars flat', () => {
    const p = stars(night(300, 300), 12, 1);
    expect(measureEdge(p, 'top').flat).toBe(true);
    expect(measureEdge(p, 'top').color.r).toBeLessThan(25);
  });

  it('never calls clouds, a fence or a gradient flat', () => {
    expect(measureEdge(clouds(300, 300), 'top').flat).toBe(false);
    expect(measureEdge(fence(300, 300), 'bottom').flat).toBe(false);
    const g = makePixels(300, 300);
    for (let y = 0; y < 300; y++) for (let x = 0; x < 300; x++) g.data.set([x * 0.6, 40, 120, 255], (y * 300 + x) * 4);
    expect(measureEdge(g, 'top').flat).toBe(false);
  });

  it('measures any strip with flatness', () => {
    expect(flatness(night(160, 8)).flat).toBe(true);
    expect(flatness(fence(160, 8)).flat).toBe(false);
  });
});

describe('parts', () => {
  it('knows a part on plain ground from one on a pattern', () => {
    const p = blob(night(300, 300), 150, 150, 30, { r: 120, g: 130, b: 130 });
    expect(groundAround(p, [0.3, 0.3, 0.4, 0.4]).plain).toBe(true);
    const c = blob(clouds(300, 300), 150, 150, 30, { r: 120, g: 130, b: 130 });
    expect(groundAround(c, [0.3, 0.3, 0.4, 0.4]).plain).toBe(false);
  });

  it('lifts a part off its ground: opaque inside, clear around', () => {
    const p = blob(night(100, 100), 50, 50, 20, { r: 240, g: 240, b: 240 });
    const a = partAlpha(p, { r: 8, g: 8, b: 10 });
    expect(a[50 * 100 + 50]).toBe(255);
    expect(a[5 * 100 + 5]).toBe(0);
  });
});

describe('analyseCover', () => {
  it('measures edges on the cover without its frame', () => {
    const a = analyseCover(frame(stars(night(240, 240), 10, 2), 9, { r: 255, g: 255, b: 255 }));
    expect(a.frame).not.toBeNull();
    expect(a.edges.top.flat).toBe(true);
    expect(a.edges.top.color.r).toBeLessThan(30);
    expect(a.pixels.width).toBeLessThan(240);
  });
});

describe('pixel helpers', () => {
  it('shrinks by averaging', () => {
    const p: Pixels = makePixels(10, 10, { r: 200, g: 0, b: 0 });
    const s = shrinkPixels(p, 5);
    expect(s.width).toBe(5);
    expect(s.data[0]).toBe(200);
  });

  it('finds the largest rectangle of true cells', () => {
    // 4 × 3 grid with a 2 × 3 block on the right.
    const cells = [0, 0, 1, 1, 0, 1, 1, 1, 0, 0, 1, 1];
    expect(largestRect(cells, 4, 3).area).toBe(6);
  });

  it('sees busy cells where there are edges', () => {
    const b = busyGrid(busy(night(100, 100), 0, 0, 50, 50), 4, 4);
    expect(b[0]).toBeGreaterThan(20);
    expect(b[15]).toBeLessThan(3);
  });
});

describe('medianColor', () => {
  it('gives the middle value of few colours with fractions and of many pixels alike', () => {
    expect(medianColor([{ r: 10.5, g: 1, b: 2 }, { r: 3.25, g: 9, b: 2 }, { r: 200, g: 5, b: 2 }])).toEqual({ r: 10.5, g: 5, b: 2 });
    const many = Array.from({ length: 1001 }, (_, i) => ({ r: i % 256, g: 7, b: 255 - (i % 256) }));
    const sorted = (k: 'r' | 'g' | 'b') => many.map((c) => c[k]).sort((a, b) => a - b)[500];
    expect(medianColor(many)).toEqual({ r: sorted('r'), g: sorted('g'), b: sorted('b') });
  });
});
