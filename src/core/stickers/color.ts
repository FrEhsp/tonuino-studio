/**
 * Colour helpers for sticker artwork: a palette from the cover (k-means),
 * WCAG contrast, text and accent colours.
 *
 * Pure functions on numbers and Uint8ClampedArray RGBA data (e.g. from
 * ctx.getImageData), so everything runs and is tested in Node. Clustering
 * works in OKLab, where distances match perceived colour differences.
 */

/** sRGB colour, channels 0–255. */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface Swatch {
  color: RGB;
  /** Share of the (opaque) image, 0…1. */
  population: number;
}

export interface Palette {
  /** Most frequent colour. */
  dominant: RGB;
  /** Colourful, medium-light accent. */
  vibrant: RGB;
  /** Greyish mid tone. */
  muted: RGB;
  dark: RGB;
  light: RGB;
  /** All clusters, most frequent first. */
  swatches: Swatch[];
}

export interface PaletteOptions {
  /** Number of clusters, default 8. */
  k?: number;
  /** The image is reduced to at most size × size cells first, default 64. */
  size?: number;
}

export const WHITE: RGB = Object.freeze({ r: 255, g: 255, b: 255 });
export const BLACK: RGB = Object.freeze({ r: 0, g: 0, b: 0 });
/** Text colour on light backgrounds: softer than pure black. */
export const NEAR_BLACK: RGB = Object.freeze({ r: 18, g: 18, b: 18 });

/** WCAG 2.x minimum contrast for small text (AA). */
export const MIN_TEXT_CONTRAST = 4.5;

// ---------------------------------------------------------------------------
// Conversions

export function toHex(c: RGB): string {
  const h = (v: number) => clampByte(v).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** Parses "#abc", "#aabbcc" or "#aabbccdd" (alpha ignored), with or without "#". */
export function fromHex(hex: string): RGB {
  const s = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-f]+$/i.test(s) || ![3, 4, 6, 8].includes(s.length)) {
    throw new Error(`„${hex}“ ist keine gültige Farbe. Erwartet wird zum Beispiel #1a2b3c.`);
  }
  const full = s.length <= 4 ? [...s.slice(0, 3)].map((ch) => ch + ch).join('') : s.slice(0, 6);
  return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) };
}

export function toCss(c: RGB, alpha = 1): string {
  const rgb = `${clampByte(c.r)} ${clampByte(c.g)} ${clampByte(c.b)}`;
  return alpha >= 1 ? `rgb(${rgb})` : `rgb(${rgb} / ${Math.max(0, alpha)})`;
}

/** Linear interpolation in sRGB; t = 0 gives a, t = 1 gives b. */
export function mix(a: RGB, b: RGB, t: number): RGB {
  const k = clamp(t, 0, 1);
  return {
    r: Math.round(a.r + (b.r - a.r) * k),
    g: Math.round(a.g + (b.g - a.g) * k),
    b: Math.round(a.b + (b.b - a.b) * k),
  };
}

/** Mixes with white; amount 0…1. */
export function lighten(c: RGB, amount: number): RGB {
  return mix(c, WHITE, amount);
}

/** Mixes with black; amount 0…1. */
export function darken(c: RGB, amount: number): RGB {
  return mix(c, BLACK, amount);
}

function srgbToLinear(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(v: number): number {
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return s * 255;
}

export interface Oklab {
  L: number;
  a: number;
  b: number;
}

export function rgbToOklab(c: RGB): Oklab {
  const r = srgbToLinear(c.r);
  const g = srgbToLinear(c.g);
  const b = srgbToLinear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToLinear(c: Oklab): [number, number, number] {
  const l = (c.L + 0.3963377774 * c.a + 0.2158037573 * c.b) ** 3;
  const m = (c.L - 0.1055613458 * c.a - 0.0638541728 * c.b) ** 3;
  const s = (c.L - 0.0894841775 * c.a - 1.291485548 * c.b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLab to sRGB; out-of-gamut colours keep lightness and hue and lose chroma. */
export function oklabToRgb(c: Oklab): RGB {
  const inGamut = (lab: Oklab) => oklabToLinear(lab).every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let lab = { L: clamp(c.L, 0, 1), a: c.a, b: c.b };
  if (!inGamut(lab)) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut({ L: lab.L, a: c.a * mid, b: c.b * mid })) lo = mid;
      else hi = mid;
    }
    lab = { L: lab.L, a: c.a * lo, b: c.b * lo };
  }
  const [r, g, b] = oklabToLinear(lab);
  return {
    r: clampByte(linearToSrgb(clamp(r, 0, 1))),
    g: clampByte(linearToSrgb(clamp(g, 0, 1))),
    b: clampByte(linearToSrgb(clamp(b, 0, 1))),
  };
}

function chroma(c: Oklab): number {
  return Math.hypot(c.a, c.b);
}

/** Same hue, new lightness and chroma (gamut-mapped). */
function withLightnessChroma(c: Oklab, L: number, C: number): RGB {
  const cur = chroma(c);
  const f = cur > 1e-6 ? C / cur : 0;
  return oklabToRgb({ L, a: c.a * f, b: c.b * f });
}

// ---------------------------------------------------------------------------
// WCAG contrast

/** Relative luminance per WCAG 2.x (0 = black, 1 = white). */
export function luminance(c: RGB): number {
  return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
}

/** WCAG 2.x contrast ratio, 1 … 21, symmetric. */
export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * White or near-black text, whichever contrasts more with the background.
 * On mid-tone backgrounds (luminance about 0.18–0.19) neither reaches 4.5:1,
 * but pure black does, so pure black is returned there. Every background
 * gets at least 4.5:1.
 */
export function bestTextColor(bg: RGB): RGB {
  const white = contrast(WHITE, bg);
  const dark = contrast(NEAR_BLACK, bg);
  if (Math.max(white, dark) < MIN_TEXT_CONTRAST && contrast(BLACK, bg) >= MIN_TEXT_CONTRAST) return { ...BLACK };
  return white >= dark ? { ...WHITE } : { ...NEAR_BLACK };
}

/** Contrast a mark drawn straight onto a photo needs, as for other graphics (WCAG 1.4.11). */
const PHOTO_MARK_CONTRAST = 3;

/**
 * Ink for a mark drawn straight onto a photo, such as a logo with nothing
 * calming the picture under it, from the mean colour of the spot. White with
 * a shadow is the usual look and stays as long as it keeps 3:1; on light
 * parts of the picture near-black takes over.
 */
export function inkOnPhoto(under: RGB): RGB {
  return contrast(WHITE, under) >= PHOTO_MARK_CONTRAST ? { ...WHITE } : { ...NEAR_BLACK };
}

/**
 * The lightest part of an RGBA pixel region. The region is split into
 * cols × rows cells; each cell gives the colour lighter than three quarters
 * of its pixels, and the lightest cell wins. Text over the region must stay
 * readable there too: a small light spot (a white letter of the cover, a
 * yellow triangle) counts, not only the average.
 */
export function lightestCell(data: ArrayLike<number>, width: number, height: number, cols = 8, rows = 3): RGB {
  let best: RGB = { r: 0, g: 0, b: 0 };
  let bestL = -1;
  for (let cy = 0; cy < rows; cy++) {
    const y0 = Math.floor((cy * height) / rows);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor(((cy + 1) * height) / rows)));
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor((cx * width) / cols);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor(((cx + 1) * width) / cols)));
      // Pixels of the cell, lightest last (rough luma is enough to rank them).
      const cell: number[] = [];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cell.push((y * width + x) * 4);
      if (!cell.length) continue;
      const luma = (i: number) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      cell.sort((a, b) => luma(a) - luma(b));
      const i = cell[Math.floor(cell.length * 0.75)];
      const c = { r: data[i], g: data[i + 1], b: data[i + 2] };
      const l = luminance(c);
      if (l > bestL) {
        best = c;
        bestL = l;
      }
    }
  }
  return best;
}

/**
 * How much black (0…1) to lay over a spot of a picture so that white text on
 * it reaches `ratio`: nothing on a dark spot, more the lighter it is. On
 * white even full black is needed.
 */
export function darkeningFor(under: RGB, ratio = MIN_TEXT_CONTRAST): number {
  if (contrast(WHITE, under) >= ratio) return 0;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(WHITE, mix(under, BLACK, mid)) >= ratio) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The colour itself if it reaches `minContrast` against bg, otherwise the
 * smallest step towards white or black that does (keeping the hue as long as
 * possible). Falls back to the better of white and black.
 */
export function ensureContrast(fg: RGB, bg: RGB, minContrast = MIN_TEXT_CONTRAST): RGB {
  if (contrast(fg, bg) >= minContrast) return { ...fg };
  const targets = contrast(WHITE, bg) >= contrast(BLACK, bg) ? [WHITE, BLACK] : [BLACK, WHITE];
  for (const target of targets) {
    if (contrast(target, bg) < minContrast) continue;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (contrast(mix(fg, target, mid), bg) >= minContrast) hi = mid;
      else lo = mid;
    }
    const out = mix(fg, target, hi);
    if (contrast(out, bg) >= minContrast) return out;
  }
  return contrast(WHITE, bg) >= contrast(BLACK, bg) ? { ...WHITE } : { ...BLACK };
}

/**
 * Accent colour from the palette that is readable as small text on bg
 * (≥ 4.5:1). Prefers the vibrant colour, then the others as they are, then a
 * lightened or darkened vibrant colour.
 */
export function pickAccent(palette: Palette, bg: RGB, minContrast = MIN_TEXT_CONTRAST): RGB {
  const candidates = [palette.vibrant, palette.light, palette.dark, palette.muted, palette.dominant];
  // A colour that is merely a lighter/darker shade of the background is a weak accent; prefer distinct hues.
  const bgLab = rgbToOklab(bg);
  const distinct = candidates.filter((c) => {
    const lab = rgbToOklab(c);
    return Math.hypot(lab.a - bgLab.a, lab.b - bgLab.b) > 0.04 || chroma(lab) < 0.03;
  });
  for (const c of [...distinct, ...candidates]) {
    if (contrast(c, bg) >= minContrast) return { ...c };
  }
  return ensureContrast(palette.vibrant, bg, minContrast);
}

/** Hue of warm sand (OKLCh, radians): the panel colour of a picture without any colour. */
const SAND_HUE = (70 * Math.PI) / 180;

/**
 * A rich background colour for a sticker panel, taken from the picture's
 * palette: the vibrant colour when it really is colourful, else the dominant
 * one, with the lightness kept in a range where it looks saturated and either
 * white or dark text reads well. A pale or grey picture gets the hue of its
 * most colourful part (or sand) with some colour added, never plain grey.
 */
export function panelColor(palette: Palette): RGB {
  const vibrant = rgbToOklab(palette.vibrant);
  const dominant = rgbToOklab(palette.dominant);
  const base = chroma(vibrant) >= 0.06 ? vibrant : chroma(dominant) >= 0.04 ? dominant : undefined;
  if (base) return withLightnessChroma(base, clamp(base.L, 0.4, 0.74), chroma(base));
  const best = [palette.vibrant, palette.dominant, palette.muted, palette.light, palette.dark].map(rgbToOklab).reduce((a, b) => (chroma(b) > chroma(a) ? b : a));
  const hue = chroma(best) > 0.01 ? Math.atan2(best.b, best.a) : SAND_HUE;
  const C = Math.max(0.05, chroma(best));
  return oklabToRgb({ L: clamp(best.L, 0.62, 0.7), a: C * Math.cos(hue), b: C * Math.sin(hue) });
}

/**
 * The colour a cover is "in", for large flat fields next to it (spine and side of "Kassette"): of its
 * clearly coloured clusters covering at least 6 % of it the one with most area × chroma (chroma capped,
 * so a loud detail does not win over the picture's own ground). `maxL` keeps it darker, e.g. beside a
 * white field. A cover without such a colour (dark, grey) gets a dark tone of its main colour, for white
 * writing (audit 17.10.2026).
 */
export function coverColor(palette: Palette, maxL = 0.9): RGB {
  let best: Oklab | undefined;
  let score = 0;
  for (const s of palette.swatches) {
    const o = rgbToOklab(s.color);
    const C = chroma(o);
    if (s.population < 0.06 || C < 0.06 || o.L < 0.25 || o.L > maxL) continue;
    const v = Math.pow(s.population, 0.6) * Math.min(C, 0.15);
    if (v > score) {
      score = v;
      best = o;
    }
  }
  if (best) return withLightnessChroma(best, clamp(best.L, 0.38, maxL), chroma(best));
  const main = rgbToOklab(palette.dominant);
  return withLightnessChroma(main, 0.33, Math.min(chroma(main), 0.04));
}

/** How far apart two colours look, in OKLab (0.2: clearly different side by side). */
export function colorDistance(a: RGB, b: RGB): number {
  return distance(rgbToOklab(a), rgbToOklab(b));
}

/**
 * The colourful colours of a cover, the most telling first, also small ones from `minShare` of it on (the
 * pink of a title or of fingernails): scored by strength more than by area, for a second colour beside
 * the cover's own ground.
 */
export function coverAccents(palette: Palette, minShare = 0.02): RGB[] {
  const all = palette.swatches
    .map((s) => ({ s, o: rgbToOklab(s.color) }))
    .filter(({ s, o }) => s.population >= minShare && chroma(o) >= 0.08 && o.L >= 0.3 && o.L <= 0.85)
    .map(({ s, o }) => ({ color: s.color, C: chroma(o), v: Math.pow(s.population, 0.35) * Math.min(chroma(o), 0.25) }))
    .sort((x, y) => y.v - x.v);
  // Strong colours first (a pink title before the skin of a hand), then the softer ones.
  return [...all.filter((x) => x.C >= 0.13), ...all.filter((x) => x.C < 0.13)].map((x) => x.color);
}

/**
 * A pale colour as the paper beside a cover: colourless becomes plain white, a faint tint goes halfway to
 * white, so it does not print like yellowed or dirty paper (audit 17.10.2026: #e4dadc).
 */
export function paperOf(c: RGB): RGB {
  const o = rgbToOklab(c);
  if (o.L < 0.84) return { ...c };
  const C = chroma(o);
  return C < 0.035 ? { ...WHITE } : C < 0.07 ? mix(c, WHITE, 0.5) : { ...c };
}

/** How colourful a colour is (OKLab chroma: 0 grey, about 0.06 clearly coloured, 0.13 strong). */
export function colourfulness(c: RGB): number {
  return chroma(rgbToOklab(c));
}

/** True when a colour is clearly coloured (not white, grey or black), e.g. to carry a cover's ground on. */
export function isColourful(c: RGB): boolean {
  return chroma(rgbToOklab(c)) >= 0.06;
}

// ---------------------------------------------------------------------------
// Palette extraction

/**
 * Palette of an image: the RGBA pixels are averaged down to at most 64 × 64
 * cells, clustered with k-means in OKLab (deterministic seeding from a colour
 * histogram), and the clusters are assigned to the roles dominant, vibrant,
 * muted, dark and light. Missing roles are derived from the dominant colour,
 * so every role is always set. Transparent pixels are ignored.
 */
export function extractPalette(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  options: PaletteOptions = {},
): Palette {
  const k = Math.round(clamp(options.k ?? 8, 1, 16));
  const cells = downsample(data, width, height, Math.max(1, Math.round(options.size ?? 64)));
  if (cells.weights.length === 0) return neutralPalette();

  const n = cells.weights.length;
  const points = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const lab = rgbToOklab({ r: cells.rgb[i * 3], g: cells.rgb[i * 3 + 1], b: cells.rgb[i * 3 + 2] });
    points[i * 3] = lab.L;
    points[i * 3 + 1] = lab.a;
    points[i * 3 + 2] = lab.b;
  }
  const seeds = histogramSeeds(cells.rgb, points, cells.weights, k);
  const clusters = kmeans(points, cells.weights, seeds);
  const total = clusters.reduce((s, c) => s + c.weight, 0) || 1;
  const swatches = clusters
    .map((c) => ({ lab: c.centroid, population: c.weight / total }))
    .sort((a, b) => b.population - a.population || a.lab.L - b.lab.L);
  return assignRoles(swatches);
}

/** Mean colour of the opaque pixels (e.g. as a plain background). */
export function averageColor(data: Uint8ClampedArray | Uint8Array, width: number, height: number): RGB {
  let r = 0;
  let g = 0;
  let b = 0;
  let w = 0;
  const n = Math.min(width * height, Math.floor(data.length / 4));
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3];
    if (a < 128) continue;
    r += data[i * 4];
    g += data[i * 4 + 1];
    b += data[i * 4 + 2];
    w++;
  }
  return w === 0 ? { r: 128, g: 128, b: 128 } : { r: Math.round(r / w), g: Math.round(g / w), b: Math.round(b / w) };
}

interface Cells {
  /** Mean sRGB per cell, 3 values each. */
  rgb: Float64Array;
  /** Number of opaque source pixels per cell. */
  weights: Float64Array;
}

function downsample(data: Uint8ClampedArray | Uint8Array, width: number, height: number, size: number): Cells {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  if (w === 0 || h === 0 || data.length < w * h * 4) return { rgb: new Float64Array(0), weights: new Float64Array(0) };
  const scale = Math.min(1, size / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const sums = new Float64Array(tw * th * 3);
  const counts = new Float64Array(tw * th);
  const totals = new Float64Array(tw * th);
  for (let y = 0; y < h; y++) {
    const ty = Math.min(th - 1, Math.floor((y * th) / h));
    for (let x = 0; x < w; x++) {
      const tx = Math.min(tw - 1, Math.floor((x * tw) / w));
      const cell = ty * tw + tx;
      const p = (y * w + x) * 4;
      totals[cell]++;
      if (data[p + 3] < 128) continue;
      sums[cell * 3] += data[p];
      sums[cell * 3 + 1] += data[p + 1];
      sums[cell * 3 + 2] += data[p + 2];
      counts[cell]++;
    }
  }
  const rgb: number[] = [];
  const weights: number[] = [];
  for (let c = 0; c < tw * th; c++) {
    // Cells that are mostly transparent are left out.
    if (counts[c] === 0 || counts[c] * 2 < totals[c]) continue;
    rgb.push(sums[c * 3] / counts[c], sums[c * 3 + 1] / counts[c], sums[c * 3 + 2] / counts[c]);
    weights.push(counts[c]);
  }
  return { rgb: Float64Array.from(rgb), weights: Float64Array.from(weights) };
}

/**
 * Deterministic seeds: the most populated 4-bit-per-channel histogram buckets
 * (ties by bucket number), skipping buckets too close to an existing seed.
 */
function histogramSeeds(rgb: Float64Array, points: Float64Array, weights: Float64Array, k: number): Oklab[] {
  const buckets = new Map<number, { weight: number; L: number; a: number; b: number }>();
  for (let i = 0; i < weights.length; i++) {
    const key = (Math.min(15, rgb[i * 3] >> 4) << 8) | (Math.min(15, rgb[i * 3 + 1] >> 4) << 4) | Math.min(15, rgb[i * 3 + 2] >> 4);
    const w = weights[i];
    const e = buckets.get(key) ?? { weight: 0, L: 0, a: 0, b: 0 };
    e.weight += w;
    e.L += points[i * 3] * w;
    e.a += points[i * 3 + 1] * w;
    e.b += points[i * 3 + 2] * w;
    buckets.set(key, e);
  }
  const ranked = [...buckets.entries()]
    .sort((x, y) => y[1].weight - x[1].weight || x[0] - y[0])
    .map(([, e]) => ({ L: e.L / e.weight, a: e.a / e.weight, b: e.b / e.weight }));
  const seeds: Oklab[] = [];
  for (const minDist of [0.08, 0.04, 0.015]) {
    for (const c of ranked) {
      if (seeds.length >= k) break;
      if (seeds.every((s) => distance(s, c) >= minDist)) seeds.push(c);
    }
    if (seeds.length >= k) break;
  }
  return seeds;
}

interface Cluster {
  centroid: Oklab;
  weight: number;
}

function kmeans(points: Float64Array, weights: Float64Array, seeds: Oklab[], maxIterations = 24): Cluster[] {
  const n = weights.length;
  const k = seeds.length;
  const centroids = seeds.map((s) => ({ ...s }));
  const assignment = new Int32Array(n).fill(-1);
  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const dL = points[i * 3] - centroids[c].L;
        const da = points[i * 3 + 1] - centroids[c].a;
        const db = points[i * 3 + 2] - centroids[c].b;
        const d = dL * dL + da * da + db * db;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assignment[i] !== best) {
        assignment[i] = best;
        changed++;
      }
    }
    const sums = Array.from({ length: k }, () => ({ L: 0, a: 0, b: 0, w: 0 }));
    for (let i = 0; i < n; i++) {
      const s = sums[assignment[i]];
      const w = weights[i];
      s.L += points[i * 3] * w;
      s.a += points[i * 3 + 1] * w;
      s.b += points[i * 3 + 2] * w;
      s.w += w;
    }
    sums.forEach((s, c) => {
      if (s.w > 0) centroids[c] = { L: s.L / s.w, a: s.a / s.w, b: s.b / s.w };
    });
    if (changed === 0) break;
  }
  const clusterWeights = new Float64Array(k);
  for (let i = 0; i < n; i++) clusterWeights[assignment[i]] += weights[i];
  return centroids.map((centroid, c) => ({ centroid, weight: clusterWeights[c] })).filter((c) => c.weight > 0);
}

interface LabSwatch {
  lab: Oklab;
  population: number;
}

function assignRoles(swatches: LabSwatch[]): Palette {
  const dominant = swatches[0];
  const used = new Set<LabSwatch>([dominant]);
  const pick = (accept: (s: LabSwatch) => boolean, score: (s: LabSwatch) => number): LabSwatch | undefined => {
    let best: LabSwatch | undefined;
    let bestScore = -Infinity;
    for (const s of swatches) {
      if (!accept(s)) continue;
      const v = score(s) - (used.has(s) ? 0.3 : 0);
      if (v > bestScore) {
        bestScore = v;
        best = s;
      }
    }
    if (best) used.add(best);
    return best;
  };
  const C = (s: LabSwatch) => chroma(s.lab);
  const vibrant = pick(
    (s) => C(s) >= 0.07 && s.lab.L >= 0.35 && s.lab.L <= 0.9,
    (s) => C(s) / 0.2 + 0.5 * Math.sqrt(s.population) - 0.6 * Math.abs(s.lab.L - 0.65),
  );
  const dark = pick(
    (s) => s.lab.L <= 0.45,
    (s) => Math.sqrt(s.population) + (0.5 * C(s)) / 0.2 - 0.5 * Math.abs(s.lab.L - 0.3),
  );
  const light = pick(
    (s) => s.lab.L >= 0.75,
    (s) => Math.sqrt(s.population) + (0.3 * C(s)) / 0.2 - 0.5 * Math.abs(s.lab.L - 0.9),
  );
  const muted = pick(
    (s) => C(s) < 0.08 && s.lab.L >= 0.3 && s.lab.L <= 0.85,
    (s) => Math.sqrt(s.population) - 0.4 * Math.abs(s.lab.L - 0.6),
  );

  const d = dominant.lab;
  const dC = chroma(d);
  return {
    dominant: oklabToRgb(d),
    vibrant: vibrant
      ? oklabToRgb(vibrant.lab)
      : dC < 0.02
        ? withLightnessChroma(d, 0.6, 0)
        : withLightnessChroma(d, clamp(d.L, 0.55, 0.7), Math.max(dC * 1.5, 0.12)),
    muted: muted ? oklabToRgb(muted.lab) : withLightnessChroma(d, 0.6, Math.min(dC * 0.4, 0.05)),
    dark: dark ? oklabToRgb(dark.lab) : withLightnessChroma(d, 0.28, dC * 0.8),
    light: light ? oklabToRgb(light.lab) : withLightnessChroma(d, 0.93, Math.min(dC, 0.04)),
    swatches: swatches.map((s) => ({ color: oklabToRgb(s.lab), population: s.population })),
  };
}

function neutralPalette(): Palette {
  const grey = { r: 128, g: 128, b: 128 };
  return {
    dominant: grey,
    vibrant: { ...grey },
    muted: { ...grey },
    dark: { r: 40, g: 40, b: 40 },
    light: { r: 235, g: 235, b: 235 },
    swatches: [],
  };
}

function distance(x: Oklab, y: Oklab): number {
  return Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clampByte(v: number): number {
  return Math.round(clamp(Number.isFinite(v) ? v : 0, 0, 255));
}
