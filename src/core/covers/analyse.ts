/**
 * What a cover is made of, measured on a small copy: a printed frame around
 * it, which of its edges are one flat colour (only those may be extended),
 * and whether a part sits on plain ground (only then may it be moved).
 */
import { extractPalette, panelColor, type RGB } from '../stickers/color';
import {
  colorDistance,
  cropPixels,
  distanceQuantile,
  fracToPx,
  medianColor,
  rmsDistance,
  sampleRect,
  sampleRing,
  shareFarther,
  type Frac,
  type Pixels,
  type PxRect,
} from './pixels';

export type Side = 'top' | 'bottom' | 'left' | 'right';
export const SIDES: readonly Side[] = ['top', 'bottom', 'left', 'right'];

/** A flat edge: one colour with a little grain, nothing else. */
export interface Edge {
  flat: boolean;
  color: RGB;
  /** Grain of the edge (RMS distance to its colour), drawn into extended areas. */
  grain: number;
}

export interface CoverAnalysis {
  /** Size of the analysed copy. */
  width: number;
  height: number;
  /** Printed frame around the cover (parts of the whole picture per side), or none. */
  frame: { top: number; bottom: number; left: number; right: number; color: RGB } | null;
  /** The cover without its frame, in parts of the whole picture. */
  inner: Frac;
  /** Pixels of the cover without its frame (analysis size). */
  pixels: Pixels;
  edges: Record<Side, Edge>;
  /** A rich colour of the cover for a panel when nothing better is there. */
  panel: RGB;
}

/* ------------------------------------------------------------------ frame */

/** Mean and spread of one line of pixels. */
function lineStats(p: Pixels, side: Side, k: number): { mean: RGB; spread: number } {
  const horizontal = side === 'top' || side === 'bottom';
  const n = horizontal ? p.width : p.height;
  const at = (i: number) => {
    const x = horizontal ? i : side === 'left' ? k : p.width - 1 - k;
    const y = horizontal ? (side === 'top' ? k : p.height - 1 - k) : i;
    const o = (y * p.width + x) * 4;
    return { r: p.data[o], g: p.data[o + 1], b: p.data[o + 2] };
  };
  // Leave out the corners: a frame meets another frame there.
  const from = Math.floor(n * 0.08);
  const to = n - from;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = from; i < to; i++) {
    const c = at(i);
    r += c.r;
    g += c.g;
    b += c.b;
  }
  const m = to - from;
  const mean = { r: r / m, g: g / m, b: b / m };
  let s = 0;
  for (let i = from; i < to; i++) s += colorDistance(at(i), mean);
  return { mean, spread: s / m };
}

/** Thickness in pixels of a plain printed band along one side, 0 when there is none. */
function frameSide(p: Pixels, side: Side): { size: number; color: RGB } {
  const n = side === 'top' || side === 'bottom' ? p.height : p.width;
  const limit = Math.max(4, Math.round(n * 0.09));
  // The outermost line is often a JPEG or scanning edge.
  const ref = lineStats(p, side, 1);
  if (ref.spread > 14) return { size: 0, color: ref.mean };
  for (let k = 2; k < limit; k++) {
    const line = lineStats(p, side, k);
    if (colorDistance(line.mean, ref.mean) > 22 || line.spread > 22) {
      // At least two plain lines, else it is the picture's own edge.
      return k >= 3 ? { size: k, color: ref.mean } : { size: 0, color: ref.mean };
    }
  }
  return { size: 0, color: ref.mean };
}

/**
 * A frame printed around the cover (white, coloured): the same plain colour
 * on all four sides, about equally thick. One plain side alone is no frame
 * but a plain sky or ground and stays.
 */
export function findFrame(p: Pixels): CoverAnalysis['frame'] {
  const sides = SIDES.map((s) => ({ side: s, ...frameSide(p, s) }));
  if (sides.some((s) => s.size === 0)) return null;
  const c0 = sides[0].color;
  if (sides.some((s) => colorDistance(s.color, c0) > 30)) return null;
  const sizes = sides.map((s) => s.size);
  if (Math.max(...sizes) > 2.6 * Math.min(...sizes)) return null;
  // A little more than measured: the band blurs into the picture over a pixel or two.
  const extra = Math.max(1, Math.round(Math.min(p.width, p.height) * 0.004));
  const get = (s: Side) => (sides.find((x) => x.side === s)!.size + extra) / (s === 'top' || s === 'bottom' ? p.height : p.width);
  return { top: get('top'), bottom: get('bottom'), left: get('left'), right: get('right'), color: medianColor(sides.map((s) => s.color)) };
}

/* ------------------------------------------------------------------ edges */

/** Depth of the strip that decides whether an edge is flat, in parts of the cover. */
export const EDGE_STRIP = 0.035;
/** Most pixels of a flat strip are this close to its colour … */
const FLAT_P90 = 16;
/** … and only a few (small stars, specks) are far off. */
const FLAT_OUTLIERS = 0.02;
/** Along the edge the colour may not drift more than this (a gradient is no flat colour). */
const FLAT_DRIFT = 10;

export function edgeRect(p: Pick<Pixels, 'width' | 'height'>, side: Side, depth = EDGE_STRIP): PxRect {
  const dw = Math.max(2, Math.round(p.width * depth));
  const dh = Math.max(2, Math.round(p.height * depth));
  switch (side) {
    case 'top':
      return { x: 0, y: 0, w: p.width, h: dh };
    case 'bottom':
      return { x: 0, y: p.height - dh, w: p.width, h: dh };
    case 'left':
      return { x: 0, y: 0, w: dw, h: p.height };
    default:
      return { x: p.width - dw, y: 0, w: dw, h: p.height };
  }
}

/**
 * Whether one edge of the cover is a single flat colour (night sky, black,
 * plain paper): only then may the card continue it. Clouds, fences, grass
 * and gradients are not flat and are never continued.
 */
export function measureEdge(p: Pixels, side: Side): Edge {
  return flatness(p, edgeRect(p, side), side === 'top' || side === 'bottom');
}

/**
 * Whether a box of pixels is one flat colour: nearly all pixels close to its
 * colour, only a few specks off, and no drift from one end to the other
 * (`along`: its long side runs horizontally).
 */
export function flatness(p: Pixels, r: PxRect = { x: 0, y: 0, w: p.width, h: p.height }, along = r.w >= r.h): Edge {
  const colors = sampleRect(p, r);
  const color = medianColor(colors);
  const p90 = distanceQuantile(colors, color, 0.9);
  const outliers = shareFarther(colors, color, 48);
  // Drift: the first and the last third of the edge.
  const third = (k: number): PxRect =>
    along ? { x: r.x + Math.round((r.w * k) / 3), y: r.y, w: Math.max(1, Math.round(r.w / 3)), h: r.h } : { x: r.x, y: r.y + Math.round((r.h * k) / 3), w: r.w, h: Math.max(1, Math.round(r.h / 3)) };
  const drift = colorDistance(medianColor(sampleRect(p, third(0))), medianColor(sampleRect(p, third(2))));
  const flat = p90 <= FLAT_P90 && outliers <= FLAT_OUTLIERS && drift <= FLAT_DRIFT;
  const quiet = colors.filter((c) => colorDistance(c, color) <= 48);
  return { flat, color, grain: Math.min(12, rmsDistance(quiet, color)) };
}

/* ------------------------------------------------------------------ parts */

export interface Ground {
  /** The part lies on one plain colour all around: it can be lifted off and the gap closed with that colour. */
  plain: boolean;
  color: RGB;
}

/**
 * The ground around a part of the cover: the border of its box. Plain when
 * nearly all of the border is one colour, so taking the part away leaves
 * nothing to invent.
 */
export function groundAround(p: Pixels, box: Frac, shape: PartShape = 'rect'): Ground {
  const r = fracToPx(p, box);
  const ring = shape === 'ellipse' ? sampleAnnulus(p, r) : sampleRing(p, r, Math.max(1, Math.round(Math.min(r.w, r.h) * 0.06)));
  const color = medianColor(ring);
  const plain = distanceQuantile(ring, color, 0.92) <= 22 && shareFarther(ring, color, 60) <= 0.04;
  return { plain, color };
}

/** rect: everything in the box that is not ground; ellipse: only inside the ellipse in the box (a round badge next to other things). */
export type PartShape = 'rect' | 'ellipse';

/** Pixels just outside the ellipse inscribed in `r` (1.04 to 1.12 of its radii). */
function sampleAnnulus(p: Pixels, r: PxRect): RGB[] {
  const out: RGB[] = [];
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const steps = Math.max(48, Math.round((r.w + r.h) * 1.5));
  for (const f of [1.04, 1.08, 1.12]) {
    for (let i = 0; i < steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      const x = Math.round(cx + Math.cos(t) * (r.w / 2) * f);
      const y = Math.round(cy + Math.sin(t) * (r.h / 2) * f);
      if (x < 0 || y < 0 || x >= p.width || y >= p.height) continue;
      const o = (y * p.width + x) * 4;
      out.push({ r: p.data[o], g: p.data[o + 1], b: p.data[o + 2] });
    }
  }
  return out;
}

/** Cuts an alpha mask to the ellipse inscribed in its box (a pixel of soft edge). */
export function ellipseCut(a: Uint8ClampedArray, w: number, h: number, scale = 1.02): Uint8ClampedArray {
  const cx = w / 2;
  const cy = h / 2;
  const rx = (w / 2) * scale;
  const ry = (h / 2) * scale;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.sqrt(((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2);
      const edge = 1.5 / Math.min(rx, ry);
      const f = d <= 1 - edge ? 1 : d >= 1 ? 0 : (1 - d) / edge;
      a[y * w + x] = Math.round(a[y * w + x] * f);
    }
  }
  return a;
}

/** Whether a box of the picture is all ground of this colour (somewhere a part may land). */
export function isGround(p: Pixels, r: PxRect, color: RGB, tolerance = 26): boolean {
  const colors = sampleRect(p, r, Math.max(1, Math.round(Math.min(r.w, r.h) / 24)));
  return distanceQuantile(colors, color, 0.97) <= tolerance;
}

/**
 * Opacity of a part lifted off its plain ground: how far each pixel is from
 * the ground colour, a little grown, so outlines and glow come along.
 */
export function partAlpha(p: Pixels, ground: RGB, low = 14, high = 40): Uint8ClampedArray {
  const n = p.width * p.height;
  const a = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = colorDistance({ r: p.data[o], g: p.data[o + 1], b: p.data[o + 2] }, ground);
    a[i] = Math.round(255 * Math.min(1, Math.max(0, (d - low) / (high - low))));
  }
  return growAlpha(a, p.width, p.height, Math.max(1, Math.round(Math.min(p.width, p.height) / 90)));
}

/** Grows opaque areas by `r` pixels (max filter), so no fringe of the old ground is cut. */
export function growAlpha(a: Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray {
  if (r < 1) return a;
  const tmp = new Uint8ClampedArray(a.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, a[y * w + k]);
      tmp[y * w + x] = m;
    }
  }
  const out = new Uint8ClampedArray(a.length);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, tmp[k * w + x]);
      out[y * w + x] = m;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ the whole cover */

/** Measures a cover (any size; a copy of about 400 pixels is enough). */
export function analyseCover(whole: Pixels): CoverAnalysis {
  const frame = findFrame(whole);
  const inner: Frac = frame ? [frame.left, frame.top, 1 - frame.left - frame.right, 1 - frame.top - frame.bottom] : [0, 0, 1, 1];
  const pixels = frame ? cropPixels(whole, fracToPx(whole, inner)) : whole;
  const edges = Object.fromEntries(SIDES.map((s) => [s, measureEdge(pixels, s)])) as Record<Side, Edge>;
  const palette = extractPalette(pixels.data, pixels.width, pixels.height, { size: 48, k: 6 });
  return { width: whole.width, height: whole.height, frame, inner, pixels, edges, panel: panelColor(palette) };
}
