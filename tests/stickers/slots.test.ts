import { describe, expect, it } from 'vitest';
import {
  growRect,
  paginate,
  rectInside,
  rectsOverlap,
  sheetCount,
  slotRect,
  slotRects,
  slotsPerSheet,
} from '../../src/core/stickers/slots';
import { getTemplate, type LabelTemplate } from '../../src/core/stickers/templates';

const herma = getTemplate('herma-5028') as LabelTemplate;
const round25 = getTemplate('round-25') as LabelTemplate;
const n = (count: number, from = 1) => Array.from({ length: count }, (_, i) => i + from);

describe('slotRects', () => {
  it('numbers the slots row by row', () => {
    const rects = slotRects(herma);
    expect(slotsPerSheet(herma)).toBe(10);
    expect(rects.map((r) => [r.row, r.col])).toEqual([
      [0, 0], [0, 1],
      [1, 0], [1, 1],
      [2, 0], [2, 1],
      [3, 0], [3, 1],
      [4, 0], [4, 1],
    ]);
    expect(rects.map((r) => r.index)).toEqual(n(10, 0));
    // Same x within a column, increasing y down the rows.
    for (const r of rects) {
      expect(r.x).toBe(rects[r.col].x);
      if (r.row > 0) expect(r.y).toBeGreaterThan(rects[r.index - 2].y);
    }
  });

  it('keeps sums free of float noise', () => {
    const r = slotRects(round25);
    expect(r[5].x).toBe(167.5);
    expect(r[53].y).toBe(256);
  });

  it('returns a single slot or a German range error', () => {
    expect(slotRect(herma, 9)).toEqual(slotRects(herma)[9]);
    expect(() => slotRect(herma, 10)).toThrow(RangeError);
    expect(() => slotRect(herma, 10)).toThrow('Etikett 11 gibt es auf diesem Bogen nicht (1 bis 10).');
    expect(() => slotRect(herma, 1.5)).toThrow(RangeError);
  });
});

describe('paginate', () => {
  it('fills sheets in slot order', () => {
    const sheets = paginate(n(12), herma);
    expect(sheets).toEqual([n(10), [11, 12, null, null, null, null, null, null, null, null]]);
  });

  it('continues a half-used sheet at the start slot', () => {
    const sheets = paginate(n(12), herma, 3);
    expect(sheets).toHaveLength(2);
    expect(sheets[0]).toEqual([null, null, null, 1, 2, 3, 4, 5, 6, 7]);
    expect(sheets[1]).toEqual([8, 9, 10, 11, 12, null, null, null, null, null]);
    expect(sheets.every((s) => s.length === 10)).toBe(true);
  });

  it('clamps the start slot', () => {
    expect(paginate(['a'], herma, 99)).toEqual([[null, null, null, null, null, null, null, null, null, 'a']]);
    expect(paginate(['a'], herma, -4)[0][0]).toBe('a');
    expect(paginate(['a'], herma, Number.NaN)[0][0]).toBe('a');
    expect(paginate(['a', 'b'], herma, 2.7)[0].slice(0, 4)).toEqual([null, null, 'a', 'b']);
  });

  it('skips used slots on the first sheet only', () => {
    const sheets = paginate(n(10), herma, 0, { skipSlots: [0, 4, 99, -1] });
    expect(sheets[0]).toEqual([null, 1, 2, 3, null, 4, 5, 6, 7, 8]);
    expect(sheets[1]).toEqual([9, 10, null, null, null, null, null, null, null, null]);
    // Skipping combines with the start slot.
    expect(paginate(['a', 'b'], herma, 2, { skipSlots: [2, 3] })[0].slice(0, 6)).toEqual([null, null, null, null, 'a', 'b']);
  });

  it('keeps empty slots for null items and drops sheets without stickers', () => {
    expect(paginate(['a', null, undefined, 'b'], herma)[0].slice(0, 5)).toEqual(['a', null, null, 'b', null]);
    expect(paginate([], herma)).toEqual([]);
    expect(paginate([null, null], herma)).toEqual([]);
    const items = [...new Array<null>(10).fill(null), 'x'];
    expect(paginate(items, herma)).toEqual([['x', null, null, null, null, null, null, null, null, null]]);
  });

  it('handles a full start sheet exactly', () => {
    expect(paginate(n(7), herma, 3)).toHaveLength(1);
    expect(paginate(n(8), herma, 3)).toHaveLength(2);
  });
});

describe('sheetCount', () => {
  it('matches paginate', () => {
    expect(sheetCount(0, herma)).toBe(0);
    expect(sheetCount(10, herma)).toBe(1);
    expect(sheetCount(11, herma)).toBe(2);
    expect(sheetCount(12, herma, 3)).toBe(2);
    expect(sheetCount(7, herma, 3)).toBe(1);
    expect(sheetCount(54, round25)).toBe(1);
    expect(sheetCount(55, round25)).toBe(2);
    expect(sheetCount(9, herma, 0, { skipSlots: [0] })).toBe(1);
    expect(sheetCount(10, herma, 0, { skipSlots: [0] })).toBe(2);
  });
});

describe('rect helpers', () => {
  const r = { x: 10, y: 20, width: 30, height: 40 };

  it('grows per side', () => {
    expect(growRect(r, 1)).toEqual({ x: 9, y: 19, width: 32, height: 42 });
    expect(growRect(r, 1, 2, 3, 4)).toEqual({ x: 9, y: 18, width: 34, height: 46 });
  });

  it('treats touching rectangles as not overlapping', () => {
    expect(rectsOverlap(r, { x: 40, y: 20, width: 5, height: 5 })).toBe(false);
    expect(rectsOverlap(r, { x: 39.9, y: 20, width: 5, height: 5 })).toBe(true);
    expect(rectsOverlap(r, { x: 10, y: 60, width: 5, height: 5 })).toBe(false);
  });

  it('checks containment with a tolerance', () => {
    expect(rectInside(r, r)).toBe(true);
    expect(rectInside(growRect(r, 1e-9), r)).toBe(true);
    expect(rectInside(growRect(r, 0.01), r)).toBe(false);
  });
});
