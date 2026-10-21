import { describe, expect, it } from 'vitest';
import {
  averageColor,
  BLACK,
  bestTextColor,
  contrast,
  darken,
  darkeningFor,
  ensureContrast,
  extractPalette,
  fromHex,
  inkOnPhoto,
  lightestCell,
  lighten,
  luminance,
  MIN_TEXT_CONTRAST,
  mix,
  NEAR_BLACK,
  oklabToRgb,
  pickAccent,
  rgbToOklab,
  toCss,
  toHex,
  WHITE,
  type Palette,
  type RGB,
} from '../../src/core/stickers/color';

function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** RGBA image made of horizontal bands: [colour, rows, alpha?]. */
function bands(width: number, spec: [RGB, number, number?][]): { data: Uint8ClampedArray; width: number; height: number } {
  const height = spec.reduce((s, [, rows]) => s + rows, 0);
  const data = new Uint8ClampedArray(width * height * 4);
  let y = 0;
  for (const [c, rows, alpha = 255] of spec) {
    for (let r = 0; r < rows; r++, y++) {
      for (let x = 0; x < width; x++) data.set([c.r, c.g, c.b, alpha], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

const distance = (a: RGB, b: RGB) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
const RED: RGB = { r: 220, g: 30, b: 40 };
const PAPER: RGB = { r: 245, g: 245, b: 245 };
const NAVY: RGB = { r: 20, g: 30, b: 70 };

describe('colour conversions', () => {
  it('converts to and from hex', () => {
    expect(toHex({ r: 255, g: 128, b: 0 })).toBe('#ff8000');
    expect(toHex({ r: 300, g: -5, b: 12.4 })).toBe('#ff000c');
    expect(fromHex('#ff8000')).toEqual({ r: 255, g: 128, b: 0 });
    expect(fromHex('F80')).toEqual({ r: 255, g: 136, b: 0 });
    expect(fromHex(' #1a2b3c80 ')).toEqual({ r: 26, g: 43, b: 60 });
    expect(fromHex('#abcd')).toEqual({ r: 170, g: 187, b: 204 });
    for (const c of [RED, PAPER, NAVY, BLACK, WHITE]) expect(fromHex(toHex(c))).toEqual(c);
    expect(() => fromHex('#12345')).toThrow('ist keine gültige Farbe');
    expect(() => fromHex('blau')).toThrow('Erwartet wird zum Beispiel #1a2b3c.');
  });

  it('writes CSS colours', () => {
    expect(toCss(RED)).toBe('rgb(220 30 40)');
    expect(toCss(RED, 0.5)).toBe('rgb(220 30 40 / 0.5)');
  });

  it('mixes, lightens and darkens in sRGB', () => {
    expect(mix(BLACK, WHITE, 0.5)).toEqual({ r: 128, g: 128, b: 128 });
    expect(mix(RED, NAVY, 0)).toEqual(RED);
    expect(mix(RED, NAVY, 1)).toEqual(NAVY);
    expect(mix(RED, NAVY, 7)).toEqual(NAVY);
    expect(lighten({ r: 100, g: 0, b: 200 }, 0.5)).toEqual({ r: 178, g: 128, b: 228 });
    expect(darken({ r: 100, g: 0, b: 200 }, 0.25)).toEqual({ r: 75, g: 0, b: 150 });
  });

  it('round-trips through OKLab', () => {
    const rnd = random(7);
    for (let i = 0; i < 200; i++) {
      const c = { r: Math.floor(rnd() * 256), g: Math.floor(rnd() * 256), b: Math.floor(rnd() * 256) };
      const back = oklabToRgb(rgbToOklab(c));
      expect(distance(back, c)).toBeLessThanOrEqual(1.8);
    }
    expect(rgbToOklab(WHITE).L).toBeCloseTo(1, 4);
    expect(rgbToOklab(BLACK).L).toBeCloseTo(0, 6);
    // Out of gamut: keeps lightness and hue, loses chroma.
    const mapped = oklabToRgb({ L: 0.7, a: 0.4, b: 0.4 });
    for (const v of [mapped.r, mapped.g, mapped.b]) expect(v >= 0 && v <= 255).toBe(true);
    expect(rgbToOklab(mapped).L).toBeCloseTo(0.7, 2);
  });
});

describe('WCAG contrast', () => {
  it('computes relative luminance and contrast ratios', () => {
    expect(luminance(WHITE)).toBeCloseTo(1, 10);
    expect(luminance(BLACK)).toBe(0);
    expect(contrast(BLACK, WHITE)).toBeCloseTo(21, 10);
    expect(contrast(WHITE, BLACK)).toBeCloseTo(21, 10);
    expect(contrast(RED, RED)).toBe(1);
    // Well-known reference values: #767676 is the lightest grey with 4.5:1 on white.
    expect(contrast(fromHex('#767676'), WHITE)).toBeCloseTo(4.54, 2);
    expect(contrast(fromHex('#777777'), WHITE)).toBeLessThan(MIN_TEXT_CONTRAST);
    expect(contrast(fromHex('#0000ff'), WHITE)).toBeCloseTo(8.59, 2);
    expect(contrast(fromHex('#ff0000'), WHITE)).toBeCloseTo(4.0, 2);
    expect(contrast(NEAR_BLACK, WHITE)).toBeCloseTo(18.73, 1);
  });

  it('picks white or near-black text with at least 4.5:1 on every background', () => {
    expect(bestTextColor(NAVY)).toEqual(WHITE);
    expect(bestTextColor(fromHex('#ffd400'))).toEqual(NEAR_BLACK);
    expect(bestTextColor(PAPER)).toEqual(NEAR_BLACK);
    // Mid greys where neither white nor near-black reach 4.5:1: pure black does.
    expect(bestTextColor({ r: 120, g: 120, b: 120 })).toEqual(BLACK);
    for (let v = 0; v < 256; v++) {
      const grey = { r: v, g: v, b: v };
      expect(contrast(bestTextColor(grey), grey), `grey ${v}`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
    const rnd = random(99);
    for (let i = 0; i < 2000; i++) {
      const bg = { r: Math.floor(rnd() * 256), g: Math.floor(rnd() * 256), b: Math.floor(rnd() * 256) };
      expect(contrast(bestTextColor(bg), bg)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
  });

  it('draws a logo on a photo white on dark parts and dark on light ones', () => {
    expect(inkOnPhoto(BLACK)).toEqual(WHITE);
    expect(inkOnPhoto(NAVY)).toEqual(WHITE);
    // A mid-tone photo keeps the usual white logo with its shadow.
    expect(inkOnPhoto({ r: 128, g: 128, b: 128 })).toEqual(WHITE);
    // White paper, a pale sky, a yellow background: the white logo would vanish.
    expect(inkOnPhoto(fromHex('#fafbf7'))).toEqual(NEAR_BLACK);
    expect(inkOnPhoto(fromHex('#c8dcf0'))).toEqual(NEAR_BLACK);
    expect(inkOnPhoto(fromHex('#ffd400'))).toEqual(NEAR_BLACK);
    const rnd = random(7);
    for (let i = 0; i < 2000; i++) {
      const under = { r: Math.floor(rnd() * 256), g: Math.floor(rnd() * 256), b: Math.floor(rnd() * 256) };
      expect(contrast(inkOnPhoto(under), under)).toBeGreaterThanOrEqual(3);
    }
  });

  it('darkens a photo under white text only as much as needed', () => {
    expect(darkeningFor(NAVY)).toBe(0);
    expect(darkeningFor(BLACK)).toBe(0);
    const grey = { r: 128, g: 128, b: 128 };
    const a = darkeningFor(grey);
    expect(a).toBeGreaterThan(0);
    expect(contrast(WHITE, mix(grey, BLACK, a))).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(contrast(WHITE, mix(grey, BLACK, a - 0.03))).toBeLessThan(MIN_TEXT_CONTRAST);
    // The lighter the picture, the more black: a cream picture needs far more than a mid-tone one.
    expect(darkeningFor(fromHex('#f6efe0'))).toBeGreaterThan(a + 0.2);
  });

  it('finds a small light spot under the title, not only the average ("Bild unten abdunkeln")', () => {
    // A dark picture, 80 × 12 px, with a white letter of 6 × 6 px somewhere under the text.
    const w = 80;
    const h = 12;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) data.set([30, 30, 50, 255], i);
    for (let y = 3; y < 9; y++) for (let x = 52; x < 58; x++) data.set([255, 255, 255, 255], (y * w + x) * 4);
    const spot = lightestCell(data, w, h);
    expect(luminance(spot)).toBeGreaterThan(0.2);
    // Too light there for white on a little darkening: the sticker takes the colour band (SCRIM_LIMIT 0.45).
    expect(darkeningFor(spot)).toBeGreaterThan(0.45);
    // Without the spot a little darkening is enough.
    const plain = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < plain.length; i += 4) plain.set([30, 30, 50, 255], i);
    expect(darkeningFor(lightestCell(plain, w, h))).toBe(0);
    // Smaller than its cells, the region still gives a colour.
    expect(lightestCell(new Uint8ClampedArray([200, 100, 0, 255]), 1, 1)).toEqual({ r: 200, g: 100, b: 0 });
  });

  it('nudges a colour towards white or black until it is readable', () => {
    expect(ensureContrast(NAVY, WHITE)).toEqual(NAVY);
    const onWhite = ensureContrast({ r: 255, g: 200, b: 0 }, WHITE);
    expect(contrast(onWhite, WHITE)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(onWhite.r).toBeGreaterThan(onWhite.b); // still a warm, darker yellow
    const onNavy = ensureContrast(RED, NAVY);
    expect(contrast(onNavy, NAVY)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(onNavy.r).toBeGreaterThan(onNavy.g);
    // Only just as far as needed: one step less would miss the target.
    expect(contrast(mix(onWhite, { r: 255, g: 200, b: 0 }, 0.05), WHITE)).toBeLessThan(MIN_TEXT_CONTRAST + 0.15);
    expect(contrast(ensureContrast(RED, WHITE, 7), WHITE)).toBeGreaterThanOrEqual(7);
  });
});

describe('extractPalette', () => {
  const image = bands(64, [
    [RED, 30],
    [PAPER, 15],
    [NAVY, 5],
  ]);

  it('finds the colours of a cover and gives them roles', () => {
    const p = extractPalette(image.data, image.width, image.height);
    expect(p.swatches).toHaveLength(3);
    expect(p.swatches.map((s) => s.population)).toEqual([0.6, 0.3, 0.1].map((v) => expect.closeTo(v, 9)));
    expect(distance(p.swatches[0].color, RED)).toBeLessThanOrEqual(2);
    expect(distance(p.dominant, RED)).toBeLessThanOrEqual(2);
    expect(distance(p.vibrant, RED)).toBeLessThanOrEqual(2);
    expect(distance(p.light, PAPER)).toBeLessThanOrEqual(2);
    expect(distance(p.dark, NAVY)).toBeLessThanOrEqual(2);
    // No greyish mid tone in the image: derived from the dominant colour, low chroma.
    const muted = rgbToOklab(p.muted);
    expect(Math.hypot(muted.a, muted.b)).toBeLessThanOrEqual(0.051);
    expect(muted.L).toBeCloseTo(0.6, 1);
  });

  it('is deterministic', () => {
    const rnd = random(3);
    const noise = new Uint8ClampedArray(200 * 150 * 4);
    for (let i = 0; i < noise.length; i++) noise[i] = i % 4 === 3 ? 255 : Math.floor(rnd() * 256);
    const a = extractPalette(noise, 200, 150);
    const b = extractPalette(noise.slice(), 200, 150);
    expect(a).toEqual(b);
    expect(a.swatches.length).toBeLessThanOrEqual(8);
    expect(a.swatches.reduce((s, x) => s + x.population, 0)).toBeCloseTo(1, 9);
    expect(extractPalette(noise, 200, 150, { k: 3 }).swatches.length).toBeLessThanOrEqual(3);
  });

  it('ignores transparent pixels', () => {
    const half = bands(32, [
      [{ r: 0, g: 200, b: 0 }, 20, 0],
      [{ r: 30, g: 60, b: 200 }, 12],
    ]);
    const p = extractPalette(half.data, half.width, half.height);
    expect(p.swatches).toHaveLength(1);
    expect(distance(p.dominant, { r: 30, g: 60, b: 200 })).toBeLessThanOrEqual(2);
    expect(averageColor(half.data, half.width, half.height)).toEqual({ r: 30, g: 60, b: 200 });
  });

  it('fills every role for a plain grey or an empty image', () => {
    const grey = bands(10, [[{ r: 128, g: 128, b: 128 }, 10]]);
    const p = extractPalette(grey.data, 10, 10);
    for (const role of ['dominant', 'vibrant', 'muted', 'dark', 'light'] as const) {
      expect(p[role]).toEqual(expect.objectContaining({ r: expect.any(Number), g: expect.any(Number), b: expect.any(Number) }));
    }
    expect(luminance(p.dark)).toBeLessThan(luminance(p.dominant));
    expect(luminance(p.light)).toBeGreaterThan(luminance(p.dominant));
    const empty = extractPalette(new Uint8ClampedArray(0), 0, 0);
    expect(empty.swatches).toEqual([]);
    expect(empty.dominant).toEqual({ r: 128, g: 128, b: 128 });
    expect(averageColor(new Uint8ClampedArray(0), 0, 0)).toEqual({ r: 128, g: 128, b: 128 });
  });
});

describe('pickAccent', () => {
  const palette = (() => {
    const img = bands(64, [
      [RED, 30],
      [PAPER, 15],
      [NAVY, 5],
    ]);
    return extractPalette(img.data, img.width, img.height);
  })();

  it('prefers the vibrant colour when it is readable', () => {
    expect(contrast(palette.vibrant, WHITE)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(pickAccent(palette, WHITE)).toEqual(palette.vibrant);
  });

  it('falls back to another palette colour, then to an adjusted vibrant colour', () => {
    // Red on navy is too weak (about 3.3:1); the light paper colour is readable.
    expect(contrast(palette.vibrant, NAVY)).toBeLessThan(MIN_TEXT_CONTRAST);
    expect(pickAccent(palette, NAVY)).toEqual(palette.light);
    const flat: Palette = {
      dominant: { r: 130, g: 120, b: 110 },
      vibrant: { r: 200, g: 60, b: 60 },
      muted: { r: 140, g: 130, b: 120 },
      dark: { r: 110, g: 100, b: 90 },
      light: { r: 160, g: 150, b: 140 },
      swatches: [],
    };
    const accent = pickAccent(flat, { r: 128, g: 128, b: 128 });
    expect(contrast(accent, { r: 128, g: 128, b: 128 })).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  it('always reaches 4.5:1', () => {
    const rnd = random(5);
    for (let i = 0; i < 500; i++) {
      const bg = { r: Math.floor(rnd() * 256), g: Math.floor(rnd() * 256), b: Math.floor(rnd() * 256) };
      expect(contrast(pickAccent(palette, bg), bg)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
  });
});
