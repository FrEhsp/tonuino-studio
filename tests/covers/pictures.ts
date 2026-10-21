/**
 * Generated test pictures for the cover recipes: plain night, stars,
 * clouds, a fence, a frame, round blobs. Only for tests; the app never draws
 * covers of its own.
 */
import type { RGB } from '../../src/core/stickers/color';
import { makePixels, seededRandom, type Pixels } from '../../src/core/covers/pixels';

const set = (p: Pixels, x: number, y: number, c: RGB) => {
  if (x < 0 || y < 0 || x >= p.width || y >= p.height) return;
  p.data.set([c.r, c.g, c.b, 255], (y * p.width + x) * 4);
};

/** Near black with a little JPEG-like noise. */
export function night(w: number, h: number, seed = 1): Pixels {
  const p = makePixels(w, h, { r: 8, g: 8, b: 10 });
  const rnd = seededRandom(seed);
  for (let i = 0; i < p.data.length; i += 4) {
    const n = (rnd() - 0.5) * 6;
    p.data[i] += n;
    p.data[i + 1] += n;
    p.data[i + 2] += n;
  }
  return p;
}

/** Small white stars (2 × 2 pixels) scattered over the picture. */
export function stars(p: Pixels, n: number, seed: number): Pixels {
  const rnd = seededRandom(seed);
  for (let k = 0; k < n; k++) {
    const x = Math.floor(rnd() * (p.width - 2));
    const y = Math.floor(rnd() * (p.height - 2));
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) set(p, x + dx, y + dy, { r: 250, g: 250, b: 240 });
  }
  return p;
}

/** Blue sky with soft white clouds: never flat. */
export function clouds(w: number, h: number): Pixels {
  const p = makePixels(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = Math.max(0, Math.sin(x / 9) * Math.cos(y / 7) + Math.sin((x + y) / 13)) * 0.6;
      set(p, x, y, { r: 40 + 200 * c, g: 170 + 80 * c, b: 225 + 30 * c });
    }
  }
  return p;
}

/** Brown fence boards with dark gaps: a pattern. */
export function fence(w: number, h: number): Pixels {
  const p = makePixels(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(p, x, y, x % 20 < 3 ? { r: 30, g: 20, b: 10 } : { r: 150 + (y % 7) * 4, g: 90, b: 40 });
  return p;
}

/** A plain frame `t` pixels thick around the picture. */
export function frame(p: Pixels, t: number, c: RGB): Pixels {
  for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) if (x < t || y < t || x >= p.width - t || y >= p.height - t) set(p, x, y, c);
  return p;
}

/** A filled disc. */
export function blob(p: Pixels, cx: number, cy: number, r: number, c: RGB): Pixels {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) set(p, x, y, c);
  return p;
}

/** A busy patch (checkerboard), like a detailed drawing. */
export function busy(p: Pixels, x0: number, y0: number, w: number, h: number): Pixels {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(p, x, y, (x >> 2) % 2 === (y >> 2) % 2 ? { r: 220, g: 60, b: 40 } : { r: 30, g: 120, b: 200 });
  return p;
}
