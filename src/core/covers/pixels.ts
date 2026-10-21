/**
 * Plain RGBA pixels (the shape of ImageData) and the few measurements the
 * cover recipes need on them. No canvas here, so all of it runs in tests.
 */
import type { RGB } from '../stickers/color';

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, row by row. */
  data: Uint8ClampedArray;
}

/** A rectangle in pixels. */
export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A rectangle in parts of a whole (0…1). */
export type Frac = [x: number, y: number, w: number, h: number];

export function makePixels(width: number, height: number, fill: RGB = { r: 0, g: 0, b: 0 }): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill.r;
    data[i + 1] = fill.g;
    data[i + 2] = fill.b;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

export function pixelAt(p: Pixels, x: number, y: number): RGB {
  const i = (Math.min(p.height - 1, Math.max(0, y)) * p.width + Math.min(p.width - 1, Math.max(0, x))) * 4;
  return { r: p.data[i], g: p.data[i + 1], b: p.data[i + 2] };
}

/** Euclidean distance of two colours in RGB (0 … 441). */
export function colorDistance(a: RGB, b: RGB): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** The rectangle `f` (parts of the picture) in whole pixels, at least one pixel big, inside the picture. */
export function fracToPx(p: Pick<Pixels, 'width' | 'height'>, f: Frac): PxRect {
  const x = Math.max(0, Math.min(p.width - 1, Math.round(f[0] * p.width)));
  const y = Math.max(0, Math.min(p.height - 1, Math.round(f[1] * p.height)));
  const w = Math.max(1, Math.min(p.width - x, Math.round(f[2] * p.width)));
  const h = Math.max(1, Math.min(p.height - y, Math.round(f[3] * p.height)));
  return { x, y, w, h };
}

/** Colours of the pixels in a rectangle, every `step`-th pixel in both directions. */
export function sampleRect(p: Pixels, r: PxRect, step = 1): RGB[] {
  const out: RGB[] = [];
  const x1 = Math.min(p.width, r.x + r.w);
  const y1 = Math.min(p.height, r.y + r.h);
  for (let y = Math.max(0, r.y); y < y1; y += step) {
    for (let x = Math.max(0, r.x); x < x1; x += step) {
      const i = (y * p.width + x) * 4;
      out.push({ r: p.data[i], g: p.data[i + 1], b: p.data[i + 2] });
    }
  }
  return out;
}

/** Colours on the border of a rectangle, `band` pixels deep. */
export function sampleRing(p: Pixels, r: PxRect, band: number): RGB[] {
  const b = Math.max(1, Math.min(band, Math.floor(Math.min(r.w, r.h) / 2)));
  return [
    ...sampleRect(p, { x: r.x, y: r.y, w: r.w, h: b }),
    ...sampleRect(p, { x: r.x, y: r.y + r.h - b, w: r.w, h: b }),
    ...sampleRect(p, { x: r.x, y: r.y + b, w: b, h: r.h - 2 * b }),
    ...sampleRect(p, { x: r.x + r.w - b, y: r.y + b, w: b, h: r.h - 2 * b }),
  ];
}

/** Channel-wise median: robust against stars, letters and JPEG specks on a plain ground. */
export function medianColor(colors: readonly RGB[]): RGB {
  if (!colors.length) return { r: 0, g: 0, b: 0 };
  if (colors.length < 256) {
    // Few colours, maybe averages with fractions: sorted.
    const med = (k: 'r' | 'g' | 'b') => {
      const v = Float64Array.from(colors, (c) => c[k]).sort();
      return v[v.length >> 1];
    };
    return { r: med('r'), g: med('g'), b: med('b') };
  }
  // Many pixels (whole numbers 0…255): counted, not sorted, the same value many times quicker.
  const hr = new Uint32Array(256);
  const hg = new Uint32Array(256);
  const hb = new Uint32Array(256);
  const at8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  for (const c of colors) {
    hr[at8(c.r)]++;
    hg[at8(c.g)]++;
    hb[at8(c.b)]++;
  }
  const at = colors.length >> 1;
  const med = (h: Uint32Array) => {
    let n = 0;
    for (let v = 0; v < 256; v++) {
      n += h[v];
      if (n > at) return v;
    }
    return 255;
  };
  return { r: med(hr), g: med(hg), b: med(hb) };
}

/** The q-quantile (0…1) of the distances of `colors` to `to`. */
export function distanceQuantile(colors: readonly RGB[], to: RGB, q: number): number {
  if (!colors.length) return 0;
  const d = new Float64Array(colors.length);
  for (let i = 0; i < colors.length; i++) d[i] = colorDistance(colors[i], to);
  d.sort();
  return d[Math.min(d.length - 1, Math.floor(q * d.length))];
}

/** Share of `colors` farther than `limit` from `to`. */
export function shareFarther(colors: readonly RGB[], to: RGB, limit: number): number {
  if (!colors.length) return 0;
  let n = 0;
  for (const c of colors) if (colorDistance(c, to) > limit) n++;
  return n / colors.length;
}

/** Root mean square distance of `colors` to `to`, for grain that matches the picture's own. */
export function rmsDistance(colors: readonly RGB[], to: RGB): number {
  if (!colors.length) return 0;
  let s = 0;
  for (const c of colors) {
    const d = colorDistance(c, to);
    s += d * d;
  }
  return Math.sqrt(s / colors.length);
}

/** A part of the pixels as new pixels. */
export function cropPixels(p: Pixels, r: PxRect): Pixels {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const from = ((r.y + y) * p.width + r.x) * 4;
    out.set(p.data.subarray(from, from + r.w * 4), y * r.w * 4);
  }
  return { width: r.w, height: r.h, data: out };
}

/** Smaller copy by averaging boxes; for analysis only. */
export function shrinkPixels(p: Pixels, maxEdge: number): Pixels {
  const s = Math.min(1, maxEdge / Math.max(p.width, p.height));
  if (s >= 1) return p;
  const w = Math.max(1, Math.round(p.width * s));
  const h = Math.max(1, Math.round(p.height * s));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * p.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * p.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * p.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * p.width) / w));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * p.width + xx) * 4;
          r += p.data[i];
          g += p.data[i + 1];
          b += p.data[i + 2];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * How busy each cell of a grid is: the mean colour change to the right and
 * below neighbour (edges of letters, faces, logos). 0 = flat.
 */
export function busyGrid(p: Pixels, cols: number, rows: number): Float32Array {
  const out = new Float32Array(cols * rows);
  const count = new Float32Array(cols * rows);
  for (let y = 0; y < p.height - 1; y++) {
    const cy = Math.min(rows - 1, Math.floor((y * rows) / p.height));
    for (let x = 0; x < p.width - 1; x++) {
      const cx = Math.min(cols - 1, Math.floor((x * cols) / p.width));
      const i = (y * p.width + x) * 4;
      const j = i + 4;
      const k = i + p.width * 4;
      const d =
        Math.abs(p.data[i] - p.data[j]) + Math.abs(p.data[i + 1] - p.data[j + 1]) + Math.abs(p.data[i + 2] - p.data[j + 2]) +
        Math.abs(p.data[i] - p.data[k]) + Math.abs(p.data[i + 1] - p.data[k + 1]) + Math.abs(p.data[i + 2] - p.data[k + 2]);
      out[cy * cols + cx] += d / 6;
      count[cy * cols + cx]++;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = count[i] ? out[i] / count[i] : 0;
  return out;
}

/** Small deterministic random numbers (mulberry32), so a card looks the same every time it is built. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Area of the largest axis-aligned rectangle of true cells in a grid (cells). */
export function largestRect(cells: ArrayLike<boolean | number>, cols: number, rows: number): { area: number; x: number; y: number; w: number; h: number } {
  const heights = new Int32Array(cols);
  let best = { area: 0, x: 0, y: 0, w: 0, h: 0 };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) heights[x] = cells[y * cols + x] ? heights[x] + 1 : 0;
    // Largest rectangle in the histogram of this row.
    const stack: number[] = [];
    for (let x = 0; x <= cols; x++) {
      const h = x < cols ? heights[x] : 0;
      while (stack.length && heights[stack[stack.length - 1]] >= h) {
        const top = stack.pop()!;
        const height = heights[top];
        const left = stack.length ? stack[stack.length - 1] + 1 : 0;
        const width = x - left;
        if (height * width > best.area) best = { area: height * width, x: left, y: y - height + 1, w: width, h: height };
      }
      stack.push(x);
    }
  }
  return best;
}
