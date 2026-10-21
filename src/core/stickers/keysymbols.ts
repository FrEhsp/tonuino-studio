/**
 * Stickers for the keys of the box (forum 2130, 9551): one round label per
 * key with its symbol, on the round 25 or 30 mm sheets of Sticker drucken.
 *
 * The symbols are our own and plain, as a felt pen draws them on a cap:
 * triangle, two bars, two triangles, plus and minus. Not Lucide: on stickers
 * those read as made by a machine (sticker style audit 20.10.2026). Each
 * edge strays a little from the straight line, the same way every time, and
 * the corners round off like a pen's. Pure geometry here; the canvas
 * drawing is in features/stickers/keystickers.ts.
 */
import type { KeyCount, KeyName } from '../tonuino/adminkeys';

export type KeySymbol = 'playpause' | 'next' | 'prev' | 'plus' | 'minus';

/** What one sticker shows: a big symbol and, for a key with two jobs, a small one under it. */
export interface KeyMark {
  main: KeySymbol;
  small?: KeySymbol;
}

export interface KeySticker {
  key: KeyName;
  mark: KeyMark;
}

/**
 * Vor and Zurück on a box with three keys do two things: a short press
 * changes the volume (from the factory) or the title, a long press the other.
 * - `both`: the short press big, the long press small under it
 * - `skip`: only the two triangles
 * - `volume`: only plus and minus
 */
export type ThreeKeyMarks = 'both' | 'skip' | 'volume';

/**
 * The stickers for one box, in the order the keys usually sit (Zurück left
 * of Play/Pause, Vor right of it; Leiser and Lauter after them). On the 30 mm
 * sheet five go into one row, so a box with five keys gets a row per set.
 */
export function keyStickers(buttons: KeyCount, opts: { marks?: ThreeKeyMarks; shortPressVolume?: boolean } = {}): KeySticker[] {
  if (buttons === 5) {
    return [
      { key: 'Zurück', mark: { main: 'prev' } },
      { key: 'Play/Pause', mark: { main: 'playpause' } },
      { key: 'Vor', mark: { main: 'next' } },
      { key: 'Leiser', mark: { main: 'minus' } },
      { key: 'Lauter', mark: { main: 'plus' } },
    ];
  }
  const marks = opts.marks ?? 'both';
  const volumeFirst = opts.shortPressVolume ?? true;
  const twoJobs = (skip: KeySymbol, volume: KeySymbol): KeyMark => {
    if (marks === 'skip') return { main: skip };
    if (marks === 'volume') return { main: volume };
    return volumeFirst ? { main: volume, small: skip } : { main: skip, small: volume };
  };
  return [
    { key: 'Zurück', mark: twoJobs('prev', 'minus') },
    { key: 'Play/Pause', mark: { main: 'playpause' } },
    { key: 'Vor', mark: twoJobs('next', 'plus') },
  ];
}

/**
 * A whole sheet, one row after the other: each row holds as many complete
 * sets as fit, so every set lies side by side as on the box. The labels left
 * over at the end of the rows (three keys on five columns: two per row) take
 * further sets, read row by row across those columns, so no label stays
 * empty, as on the sheets of Sticker drucken; what is left of the last set
 * is a spare.
 */
export function fillSheet<T>(set: readonly T[], grid: { cols: number; rows: number }): (T | null)[] {
  const perRow = setsPerRow(set.length, grid.cols);
  if (!perRow) return [];
  const used = perRow * set.length;
  const out: (T | null)[] = [];
  let rest = 0;
  for (let r = 0; r < grid.rows; r++) {
    for (let i = 0; i < perRow; i++) out.push(...set);
    for (let c = used; c < grid.cols; c++) out.push(set[rest++ % set.length]);
  }
  return out;
}

function setsPerRow(setSize: number, cols: number): number {
  return setSize > 0 ? Math.floor(cols / setSize) : 0;
}

/** How many complete sets one sheet holds, and how many stickers are spare (see fillSheet). */
export function sheetSets(setSize: number, grid: { cols: number; rows: number }): { sets: number; spare: number } {
  const perRow = setsPerRow(setSize, grid.cols);
  if (!perRow) return { sets: 0, spare: 0 };
  const rest = (grid.cols - perRow * setSize) * grid.rows;
  return { sets: perRow * grid.rows + Math.floor(rest / setSize), spare: rest % setSize };
}

/* ------------------------------------------------------------------ shapes */

export type Pt = readonly [number, number];
/** A closed outline, filled. */
export type Shape = readonly Pt[];

/**
 * The outlines of a symbol in a box from -0.5 to 0.5 (y down), centred by
 * eye: a triangle sits a little right of the middle, as its weight is on the
 * left. Straight edges; the hand comes in with handDrawn().
 */
export function symbolShapes(symbol: KeySymbol): Shape[] {
  switch (symbol) {
    case 'playpause':
      return [
        [
          [-0.5, -0.31],
          [0.06, 0],
          [-0.5, 0.31],
        ],
        rect(0.17, -0.31, 0.12, 0.62),
        rect(0.38, -0.31, 0.12, 0.62),
      ];
    case 'next':
      return [
        [
          [-0.5, -0.3],
          [0.02, 0],
          [-0.5, 0.3],
        ],
        [
          [-0.02, -0.3],
          [0.5, 0],
          [-0.02, 0.3],
        ],
      ];
    case 'prev':
      return symbolShapes('next').map((s) => s.map(([x, y]) => [-x, y] as Pt).reverse());
    case 'plus':
      return [rect(-0.4, -0.095, 0.8, 0.19), rect(-0.095, -0.4, 0.19, 0.8)];
    case 'minus':
      return [rect(-0.4, -0.095, 0.8, 0.19)];
  }
}

function rect(x: number, y: number, w: number, h: number): Shape {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

/** The outlines of a sticker: the big symbol, and a small one under it for a key with two jobs. */
export function markShapes(mark: KeyMark): Shape[] {
  if (!mark.small) return symbolShapes(mark.main);
  const big = symbolShapes(mark.main).map((s) => place(s, 0.58, 0, -0.16));
  const small = symbolShapes(mark.small).map((s) => place(s, 0.46, 0, 0.3));
  return [...big, ...small];
}

function place(shape: Shape, scale: number, dx: number, dy: number): Shape {
  return shape.map(([x, y]) => [x * scale + dx, y * scale + dy] as Pt);
}

/** A small seeded random: the same key always strays the same way. */
function random(key: string): () => number {
  let s = 2166136261;
  for (let i = 0; i < key.length; i++) s = Math.imul(s ^ key.charCodeAt(i), 16777619);
  s >>>= 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** How far an edge may bow away from the straight line, in the symbol's box: a steady hand with a felt pen. */
export const HAND_AMP = 0.02;

/**
 * The outline as a pen draws it: each edge one slightly bowed stroke (as the
 * frames of the app, ui/drawnFrames.ts), each corner a little off its place.
 * No jitter along the edge, that would look like a filter, not a hand.
 * Seeded by `key`, so a symbol looks the same on every sticker and print.
 */
export function handDrawn(shape: Shape, key: string, amp = HAND_AMP, step = 0.05): Pt[] {
  const rnd = random(key);
  const off = () => (rnd() - 0.5) * amp;
  const corners: Pt[] = shape.map(([x, y]) => [x + off(), y + off()]);
  const out: Pt[] = [];
  corners.forEach((a, i) => {
    const b = corners[(i + 1) % corners.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    // Bow outwards or inwards, at most amp, less on short edges.
    const bow = (rnd() - 0.5) * 2 * amp * Math.min(1, len / 0.4);
    const nx = len ? dy / len : 0;
    const ny = len ? -dx / len : 0;
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const h = bow * Math.sin(Math.PI * t);
      out.push([a[0] + dx * t + nx * h, a[1] + dy * t + ny * h]);
    }
  });
  return out;
}

/** Width and height a mark takes in its unit box (for the size on the sticker). */
export function markBounds(mark: KeyMark): { minX: number; maxX: number; minY: number; maxY: number } {
  const pts = markShapes(mark).flat();
  return {
    minX: Math.min(...pts.map((p) => p[0])),
    maxX: Math.max(...pts.map((p) => p[0])),
    minY: Math.min(...pts.map((p) => p[1])),
    maxY: Math.max(...pts.map((p) => p[1])),
  };
}
