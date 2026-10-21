import { describe, expect, it } from 'vitest';
import { fillSheet, HAND_AMP, handDrawn, keyStickers, markBounds, markShapes, sheetSets, symbolShapes, type KeySymbol } from '../../src/core/stickers/keysymbols';
import { slotsPerSheet } from '../../src/core/stickers/slots';
import { getTemplate } from '../../src/core/stickers/templates';

const SYMBOLS: KeySymbol[] = ['playpause', 'next', 'prev', 'plus', 'minus'];

describe('Tasten-Sticker (TODO 0.3 #94, forum 2130/9551)', () => {
  it('one sticker per key, as many as the box has keys', () => {
    expect(keyStickers(5).map((s) => s.key)).toEqual(['Zurück', 'Play/Pause', 'Vor', 'Leiser', 'Lauter']);
    expect(keyStickers(5).map((s) => s.mark.main)).toEqual(['prev', 'playpause', 'next', 'minus', 'plus']);
    expect(keyStickers(3).map((s) => s.key)).toEqual(['Zurück', 'Play/Pause', 'Vor']);
  });

  it('three keys: the short press big, the long press small (core/tonuino/manual.ts keyRows)', () => {
    // From the factory a short press changes the volume, a long one the title.
    expect(keyStickers(3)[2].mark).toEqual({ main: 'plus', small: 'next' });
    expect(keyStickers(3)[0].mark).toEqual({ main: 'minus', small: 'prev' });
    expect(keyStickers(3, { shortPressVolume: false })[2].mark).toEqual({ main: 'next', small: 'plus' });
    expect(keyStickers(3, { marks: 'skip' })[2].mark).toEqual({ main: 'next' });
    expect(keyStickers(3, { marks: 'volume' })[0].mark).toEqual({ main: 'minus' });
    expect(keyStickers(3)[1].mark).toEqual({ main: 'playpause' });
  });

  it('a sheet holds complete sets, one row beside the other; on 30 mm a box with five keys gets one row per set', () => {
    const r30 = getTemplate('round-30')!;
    const r25 = getTemplate('round-25')!;
    expect(r30.grid).toMatchObject({ cols: 5, rows: 8 });
    expect(r25.grid).toMatchObject({ cols: 6, rows: 9 });
    expect(sheetSets(5, r30.grid)).toEqual({ sets: 8, spare: 0 });
    expect(sheetSets(3, r30.grid)).toEqual({ sets: 13, spare: 1 });
    expect(sheetSets(3, r25.grid)).toEqual({ sets: 18, spare: 0 });
    expect(sheetSets(5, r25.grid)).toEqual({ sets: 10, spare: 4 });
    const sheet = fillSheet(keyStickers(5), r30.grid);
    expect(sheet).toHaveLength(slotsPerSheet(r30));
    for (let row = 0; row < 8; row++) expect(sheet.slice(row * 5, row * 5 + 5).map((s) => s?.key)).toEqual(['Zurück', 'Play/Pause', 'Vor', 'Leiser', 'Lauter']);
    // Three keys on five columns: a set at the start of every row, the two labels after it take further sets, row by row; none stays empty.
    const three = fillSheet(keyStickers(3), r30.grid);
    expect(three).toHaveLength(40);
    expect(three.every(Boolean)).toBe(true);
    for (let row = 0; row < 8; row++) expect(three.slice(row * 5, row * 5 + 3).map((s) => s?.key)).toEqual(['Zurück', 'Play/Pause', 'Vor']);
    const rest = Array.from({ length: 8 }, (_, row) => three.slice(row * 5 + 3, row * 5 + 5)).flat().map((s) => s?.key);
    expect(rest.slice(0, 6)).toEqual(['Zurück', 'Play/Pause', 'Vor', 'Zurück', 'Play/Pause', 'Vor']);
    const count = (k: string) => three.filter((s) => s?.key === k).length;
    expect([count('Zurück'), count('Play/Pause'), count('Vor')]).toEqual([14, 13, 13]);
    // Five keys on six columns: the sixth column holds one more set and four spares.
    const five = fillSheet(keyStickers(5), r25.grid);
    expect(five).toHaveLength(54);
    expect(five.every(Boolean)).toBe(true);
    const small = fillSheet(keyStickers(3), r25.grid);
    expect(small.slice(0, 6).map((s) => s?.key)).toEqual(['Zurück', 'Play/Pause', 'Vor', 'Zurück', 'Play/Pause', 'Vor']);
    expect(small.filter(Boolean)).toHaveLength(54);
    expect(fillSheet([], r30.grid)).toEqual([]);
  });

  it('every symbol stays in its box, so it stays clear of the cut', () => {
    for (const s of SYMBOLS) {
      for (const shape of symbolShapes(s)) {
        expect(shape.length, s).toBeGreaterThanOrEqual(3);
        for (const [x, y] of shape) {
          expect(Math.abs(x), s).toBeLessThanOrEqual(0.5);
          expect(Math.abs(y), s).toBeLessThanOrEqual(0.5);
        }
      }
    }
    for (const sticker of [...keyStickers(3), ...keyStickers(3, { shortPressVolume: false })]) {
      const b = markBounds(sticker.mark);
      expect(Math.max(-b.minX, b.maxX, -b.minY, b.maxY)).toBeLessThanOrEqual(0.5);
    }
  });

  it('Zurück is Vor turned round, Leiser is part of Lauter', () => {
    const next = symbolShapes('next').flat();
    const prev = symbolShapes('prev').flat();
    expect(prev.map(([x]) => x).sort()).toEqual(next.map(([x]) => -x).sort());
    expect(symbolShapes('minus')).toEqual([symbolShapes('plus')[0]]);
    expect(markShapes({ main: 'plus', small: 'next' })).toHaveLength(4);
  });

  it('drawn by hand: a little off the line, the same way every time', () => {
    const tri = symbolShapes('next')[0];
    const a = handDrawn(tri, 'next#0');
    expect(handDrawn(tri, 'next#0')).toEqual(a);
    expect(handDrawn(tri, 'next#1')).not.toEqual(a);
    expect(a.length).toBeGreaterThan(tri.length * 3);
    // At most 2 % of the symbol off: a steady pen, not a scribble.
    expect(HAND_AMP).toBeLessThanOrEqual(0.02);
    const corner = a[0];
    expect(Math.abs(corner[0] - tri[0][0])).toBeLessThanOrEqual(HAND_AMP / 2);
    expect(Math.abs(corner[1] - tri[0][1])).toBeLessThanOrEqual(HAND_AMP / 2);
    expect(corner).not.toEqual(tri[0]);
    // Every point close to the straight outline: bowed a little, never a scribble.
    const toEdge = ([x, y]: readonly [number, number]) =>
      Math.min(
        ...tri.map((p, i) => {
          const q = tri[(i + 1) % tri.length];
          const [dx, dy] = [q[0] - p[0], q[1] - p[1]];
          const t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / (dx * dx + dy * dy)));
          return Math.hypot(x - p[0] - t * dx, y - p[1] - t * dy);
        }),
      );
    for (const p of a) expect(toEdge(p)).toBeLessThanOrEqual(HAND_AMP * 1.5);
    expect(Math.max(...a.map(toEdge))).toBeGreaterThan(HAND_AMP / 10);
  });
});
