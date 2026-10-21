import { describe, expect, it } from 'vitest';
import {
  blobPart,
  cropFocus,
  cropRect,
  dataUrlToBlob,
  DEFAULT_FOCUS_Y,
  dataUrlToBytes,
  fitContain,
  fitWithin,
  isAbortError,
  jpegInfo,
  LOW_PRINT_DPI,
  pictureSizeFromHead,
  placedDpi,
  placePicture,
  readJpegOrientation,
  readPictureSize,
  setJpegDpi,
  sizeSvg,
  sniffImageType,
  stackBlur,
  stackRadiusForSigma,
  stepDownSizes,
  supportsCanvasFilter,
} from '../../src/core/stickers/image';
import { stickerLayout, type StickerGeometry } from '../../src/core/stickers/layout';
import { TINY_JPEG_BASE64, TINY_PNG_BASE64, tinyJpeg, tinyPng } from './fixtures';

/** Deterministic pseudo-random numbers (LCG) for property checks. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const CARD_ASPECT = 85.6 / 54;

describe('cropRect', () => {
  it('takes the largest crop with the target aspect, centred across and a little above the middle', () => {
    expect(DEFAULT_FOCUS_Y).toBeLessThan(0.5);
    expect(cropRect(400, 200, 1)).toEqual({ x: 100, y: 0, width: 200, height: 200 });
    expect(cropRect(200, 400, 2)).toEqual({ x: 0, y: 400 * DEFAULT_FOCUS_Y - 50, width: 200, height: 100 });
    expect(cropRect(200, 400, 2, 0.5, 0.5)).toEqual({ x: 0, y: 150, width: 200, height: 100 });
    expect(cropRect(300, 200, 1.5)).toEqual({ x: 0, y: 0, width: 300, height: 200 });
    const card = cropRect(3000, 4000, CARD_ASPECT);
    expect(card.x).toBe(0);
    expect(card.width).toBe(3000);
    expect(card.height).toBeCloseTo(3000 / CARD_ASPECT, 9);
    // A tall cover cut to a card keeps more of its top, where the name is written.
    expect(card.y).toBeCloseTo(4000 * DEFAULT_FOCUS_Y - 3000 / CARD_ASPECT / 2, 9);
    expect(cropRect(3000, 4000, CARD_ASPECT, 0.5, 0.5).y).toBeCloseTo((4000 - 3000 / CARD_ASPECT) / 2, 9);
  });

  it('follows the focus point but never leaves the image', () => {
    expect(cropRect(400, 200, 1, 0.3)).toEqual({ x: 20, y: 0, width: 200, height: 200 });
    expect(cropRect(400, 200, 1, 0)).toEqual({ x: 0, y: 0, width: 200, height: 200 });
    expect(cropRect(400, 200, 1, 1)).toEqual({ x: 200, y: 0, width: 200, height: 200 });
    expect(cropRect(400, 200, 1, -3, 7)).toEqual({ x: 0, y: 0, width: 200, height: 200 });
    // The vertical focus has no room to move when the crop has the full height.
    expect(cropRect(400, 200, 1, 0.5, 0.9)).toEqual(cropRect(400, 200, 1));
  });

  it('zooms in around the focus point', () => {
    expect(cropRect(400, 200, 1, 0.5, 0.5, 2)).toEqual({ x: 150, y: 50, width: 100, height: 100 });
    expect(cropRect(400, 200, 1, 0.9, 0.1, 2)).toEqual({ x: 300, y: 0, width: 100, height: 100 });
    expect(cropRect(400, 200, 1, 0.25, 0.75, 4)).toEqual({ x: 75, y: 125, width: 50, height: 50 });
  });

  it('treats broken input safely', () => {
    expect(cropRect(400, 200, 0)).toEqual({ x: 0, y: 0, width: 400, height: 200 });
    expect(cropRect(400, 200, Number.NaN)).toEqual({ x: 0, y: 0, width: 400, height: 200 });
    expect(cropRect(400, 200, Number.POSITIVE_INFINITY)).toEqual({ x: 0, y: 0, width: 400, height: 200 });
    expect(cropRect(400, 200, 1, Number.NaN, Number.NaN)).toEqual(cropRect(400, 200, 1));
    expect(cropRect(400, 200, 1, 0.5, 0.5, 0.25)).toEqual(cropRect(400, 200, 1));
    expect(cropRect(400, 200, 1, 0.5, 0.5, Number.NaN)).toEqual(cropRect(400, 200, 1));
    expect(cropRect(0, 200, 1)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(cropRect(400, -1, 1)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('always keeps the aspect, stays inside the source and fills one side at zoom 1', () => {
    const rnd = random(42);
    for (let i = 0; i < 500; i++) {
      const srcW = 1 + rnd() * 5000;
      const srcH = 1 + rnd() * 5000;
      const aspect = 0.2 + rnd() * 4.8;
      const fx = rnd() * 2 - 0.5;
      const fy = rnd() * 2 - 0.5;
      const zoom = 1 + rnd() * 3;
      const base = cropRect(srcW, srcH, aspect, fx, fy);
      const r = cropRect(srcW, srcH, aspect, fx, fy, zoom);
      for (const c of [base, r]) {
        expect(c.width / c.height).toBeCloseTo(aspect, 9);
        expect(c.x).toBeGreaterThanOrEqual(-1e-9);
        expect(c.y).toBeGreaterThanOrEqual(-1e-9);
        expect(c.x + c.width).toBeLessThanOrEqual(srcW + 1e-6);
        expect(c.y + c.height).toBeLessThanOrEqual(srcH + 1e-6);
      }
      expect(Math.abs(base.width - srcW) < 1e-6 || Math.abs(base.height - srcH) < 1e-6).toBe(true);
      expect(r.width).toBeCloseTo(base.width / zoom, 6);
    }
  });

  it('gives back the focus point of a crop', () => {
    expect(cropFocus(cropRect(400, 200, 1, 0.3), 400, 200)).toEqual({ focusX: 0.3, focusY: 0.5 });
    expect(cropFocus(cropRect(400, 200, 1, 0.75, 0.25, 4), 400, 200)).toEqual({ focusX: 0.75, focusY: 0.25 });
    expect(cropFocus({ x: 0, y: 0, width: 0, height: 0 }, 0, 0)).toEqual({ focusX: 0.5, focusY: 0.5 });
  });
});

describe('placePicture', () => {
  it('crops like cropRect from zoom 1 on', () => {
    for (const zoom of [1, 1.5, 3]) {
      const p = placePicture(1600, 900, 50, 50, { focusX: 0.3, focusY: 0.6, zoom });
      expect(p.src).toEqual(cropRect(1600, 900, 1, 0.3, 0.6, zoom));
      expect(p.dest).toEqual({ x: 0, y: 0, width: 50, height: 50 });
    }
    expect(placePicture(1600, 900, 50, 50).src).toEqual(cropRect(1600, 900, 1));
  });

  it('shows a 16:9 picture whole in a square at zoom 0', () => {
    const p = placePicture(1600, 900, 50, 50, { zoom: 0 });
    expect(p.src).toEqual({ x: 0, y: 0, width: 1600, height: 900 });
    expect(p.dest.x).toBe(0);
    expect(p.dest.width).toBe(50);
    expect(p.dest.height).toBeCloseTo(28.125, 9);
    expect(p.dest.y).toBeCloseTo((50 - 28.125) / 2, 9);
    // A portrait drawing on a landscape sticker: full height, centred.
    const tall = placePicture(900, 1200, 86, 54, { zoom: 0 });
    expect(tall.src).toEqual({ x: 0, y: 0, width: 900, height: 1200 });
    expect(tall.dest).toEqual({ x: (86 - 40.5) / 2, y: 0, width: 40.5, height: 54 });
  });

  it('scales smoothly between whole and filled, cutting off only what does not fit', () => {
    const half = placePicture(1600, 900, 50, 50, { zoom: 0.5, focusX: 0 });
    // Scale halfway (geometric) between 50/1600 and 50/900.
    const scale = Math.sqrt((50 / 1600) * (50 / 900));
    expect(half.dest.width).toBe(50);
    expect(half.dest.height).toBeCloseTo(900 * scale, 9);
    expect(half.src.height).toBe(900);
    expect(half.src.width).toBeCloseTo(50 / scale, 9);
    // The focus picks the visible part where something is cut off.
    expect(half.src.x).toBe(0);
    let last = 0;
    for (const zoom of [0, 0.25, 0.5, 0.75, 1]) {
      const p = placePicture(1600, 900, 50, 50, { zoom });
      expect(p.dest.height).toBeGreaterThanOrEqual(last);
      last = p.dest.height;
    }
    expect(last).toBe(50);
  });

  it('fills the box at any zoom when the picture has its shape', () => {
    for (const zoom of [0, 0.4, 1]) {
      expect(placePicture(1000, 1000, 40, 40, { zoom })).toEqual({ src: { x: 0, y: 0, width: 1000, height: 1000 }, dest: { x: 0, y: 0, width: 40, height: 40 } });
    }
  });

  it('treats broken input safely', () => {
    const none = { x: 0, y: 0, width: 0, height: 0 };
    expect(placePicture(0, 900, 50, 50)).toEqual({ src: none, dest: none });
    expect(placePicture(1600, 900, 50, Number.NaN)).toEqual({ src: none, dest: none });
    expect(placePicture(1600, 900, 50, 50, { zoom: Number.NaN })).toEqual(placePicture(1600, 900, 50, 50));
    expect(placePicture(1600, 900, 50, 50, { zoom: -2 })).toEqual(placePicture(1600, 900, 50, 50, { zoom: 0 }));
  });
});

describe('placedDpi', () => {
  // HERMA 5028 with 1.5 mm bleed, as the sheet is drawn.
  const herma: StickerGeometry = { widthMm: 83.8, heightMm: 50.8, bleedMm: 1.5, safeMm: 2.5, shape: 'rect' };
  const box = (style: 'blur' | 'full') => stickerLayout(herma, { style, title: false, badge: true, logo: false }).picture;

  it('finds a small cover from the MP3 tags too coarse for the print', () => {
    // Klassisch: a 45.8 mm square picture; 160 px give about 89 dpi, 541 px are needed for 300 dpi.
    const classic = box('blur');
    expect(classic.width).toBeCloseTo(45.8, 9);
    expect(placedDpi(160, 160, classic.width, classic.height)).toBeCloseTo(88.7, 1);
    expect(placedDpi(541, 541, classic.width, classic.height)).toBeCloseTo(300, 0);
    // Vollbild: the picture covers 86.8 × 53.8 mm with the bleed, about 47 dpi.
    const full = box('full');
    expect(placedDpi(160, 160, full.width, full.height)).toBeCloseTo(46.8, 1);
    expect(placedDpi(160, 160, full.width, full.height)).toBeLessThan(LOW_PRINT_DPI);
    expect(placedDpi(1200, 1200, full.width, full.height)).toBeGreaterThan(300);
  });

  it('follows the zoom: closer means coarser, the whole picture finer', () => {
    const at = (zoom: number) => placedDpi(1600, 900, 50, 50, { zoom });
    expect(at(2)).toBeCloseTo(at(1) / 2, 9);
    // Filled, the 900 px height covers 50 mm; whole, the 1600 px width does.
    expect(at(1)).toBeCloseTo((900 / 50) * 25.4, 9);
    expect(at(0)).toBeCloseTo((1600 / 50) * 25.4, 9);
  });

  it('gives 0 for broken input', () => {
    expect(placedDpi(0, 100, 50, 50)).toBe(0);
    expect(placedDpi(100, 100, 0, 50)).toBe(0);
  });
});

describe('fitWithin', () => {
  it('shrinks the longer side to the limit and keeps the aspect', () => {
    expect(fitWithin(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(3000, 4000, 2048)).toEqual({ width: 1536, height: 2048 });
    expect(fitWithin(9000, 10, 2048)).toEqual({ width: 2048, height: 2 });
  });

  it('leaves pictures that fit alone', () => {
    expect(fitWithin(2048, 1000, 2048)).toEqual({ width: 2048, height: 1000 });
    expect(fitWithin(600, 600, 2048)).toEqual({ width: 600, height: 600 });
    expect(fitWithin(4000, 3000, 0)).toEqual({ width: 4000, height: 3000 });
  });
});

describe('fitContain and stepDownSizes', () => {
  it('fits the whole image into a box', () => {
    expect(fitContain(400, 200, 100, 100)).toEqual({ x: 0, y: 25, width: 100, height: 50 });
    expect(fitContain(400, 200, 100, 100, 0.5, 0)).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(fitContain(100, 400, 200, 200, 1)).toEqual({ x: 150, y: 0, width: 50, height: 200 });
    expect(fitContain(0, 200, 100, 100)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('halves until the last step shrinks by at most 2×', () => {
    expect(stepDownSizes(4000, 3000, 500, 375)).toEqual([
      { width: 2000, height: 1500 },
      { width: 1000, height: 750 },
    ]);
    expect(stepDownSizes(4000, 100, 500, 100)).toEqual([
      { width: 2000, height: 100 },
      { width: 1000, height: 100 },
    ]);
    expect(stepDownSizes(1000, 1000, 600, 600)).toEqual([]);
    expect(stepDownSizes(500, 500, 1000, 1000)).toEqual([]);
    expect(stepDownSizes(1001, 1001, 1, 1).at(-1)).toEqual({ width: 2, height: 2 });
  });
});

describe('stackBlur', () => {
  const rgba = (w: number, h: number, fill: [number, number, number, number]) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) d.set(fill, i * 4);
    return d;
  };

  it('leaves a plain colour unchanged, also at the edges', () => {
    const d = rgba(13, 7, [200, 100, 50, 255]);
    stackBlur(d, 13, 7, 4);
    expect(d).toEqual(rgba(13, 7, [200, 100, 50, 255]));
  });

  it('spreads a bright pixel symmetrically with the triangle kernel', () => {
    const d = rgba(9, 9, [0, 0, 0, 255]);
    d[(4 * 9 + 4) * 4] = 255;
    stackBlur(d, 9, 9, 2);
    const red = (x: number, y: number) => d[(y * 9 + x) * 4];
    // Kernel (1 2 3 2 1) / 9 in both directions: centre 255 · 3/9 · 3/9.
    expect(red(4, 4)).toBe(28);
    expect(red(3, 4)).toBe(19);
    expect(red(4, 3)).toBe(19);
    for (let k = 1; k <= 2; k++) {
      expect(red(4 - k, 4)).toBe(red(4 + k, 4));
      expect(red(4, 4 - k)).toBe(red(4, 4 + k));
      expect(red(4 - k, 4)).toBe(red(4, 4 - k));
    }
    expect(red(1, 4)).toBe(0);
    expect(red(0, 0)).toBe(0);
    // Green, blue and alpha stay untouched.
    expect(d[(4 * 9 + 4) * 4 + 1]).toBe(0);
    expect(d[(4 * 9 + 4) * 4 + 3]).toBe(255);
  });

  it('matches a Gaussian of the requested sigma after two passes', () => {
    const w = 61;
    const d = rgba(w, 1, [0, 0, 0, 255]);
    const centre = 30;
    d[centre * 4] = 255;
    const r = stackRadiusForSigma(3);
    stackBlur(d, w, 1, r);
    stackBlur(d, w, 1, r);
    let sum = 0;
    let variance = 0;
    for (let x = 0; x < w; x++) {
      sum += d[x * 4];
      variance += d[x * 4] * (x - centre) ** 2;
    }
    expect(Math.abs(sum - 255)).toBeLessThanOrEqual(6);
    expect(Math.sqrt(variance / sum)).toBeCloseTo(3, 0);
  });

  it('ignores radius 0 and rejects short data', () => {
    const d = rgba(3, 3, [10, 20, 30, 255]);
    d[0] = 250;
    const copy = d.slice();
    stackBlur(d, 3, 3, 0);
    expect(d).toEqual(copy);
    expect(() => stackBlur(new Uint8ClampedArray(8), 3, 3, 2)).toThrow(RangeError);
  });

  it('picks the stack radius for a Gaussian sigma', () => {
    expect(stackRadiusForSigma(1)).toBe(1);
    expect(stackRadiusForSigma(4)).toBe(6);
    expect(stackRadiusForSigma(0)).toBe(1);
  });
});

describe('image bytes', () => {
  const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

  it('recognises image types by their first bytes', () => {
    expect(sniffImageType(tinyJpeg())).toBe('image/jpeg');
    expect(sniffImageType(tinyPng())).toBe('image/png');
    expect(sniffImageType(ascii('GIF89a\u0001\u0000'))).toBe('image/gif');
    expect(sniffImageType(ascii('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(ascii('BM\u0000\u0000'))).toBe('image/bmp');
    expect(sniffImageType(ascii('\u0000\u0000\u0000\u0018ftypheic\u0000\u0000'))).toBe('image/heic');
    expect(sniffImageType(ascii('\u0000\u0000\u0000\u001cftypavif\u0000\u0000'))).toBe('image/avif');
    expect(sniffImageType(ascii('ID3\u0004\u0000'))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });

  /** The tiny JPEG with an EXIF APP1 segment (orientation tag only) after the SOI marker. */
  function withExifOrientation(orientation: number, littleEndian: boolean): Uint8Array {
    const tiff = littleEndian
      ? [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, 0, 0, 0, 0]
      : [0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, 0, 0, 0, 0];
    const payload = [...ascii('Exif\u0000\u0000'), ...tiff];
    const app1 = [0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
    const jpeg = tinyJpeg();
    return Uint8Array.from([...jpeg.subarray(0, 2), ...app1, ...jpeg.subarray(2)]);
  }

  it('reads size and EXIF orientation from a JPEG header', () => {
    expect(jpegInfo(tinyJpeg())).toEqual({ orientation: 1, width: 8, height: 5 });
    expect(jpegInfo(withExifOrientation(6, false))).toEqual({ orientation: 6, width: 8, height: 5 });
    expect(jpegInfo(withExifOrientation(8, true))).toEqual({ orientation: 8, width: 8, height: 5 });
    expect(readJpegOrientation(withExifOrientation(3, true))).toBe(3);
    // Invalid orientation values are ignored.
    expect(readJpegOrientation(withExifOrientation(9, false))).toBe(1);
    expect(jpegInfo(tinyPng())).toBeNull();
    expect(readJpegOrientation(tinyPng())).toBe(1);
    // Truncated data does not throw.
    expect(jpegInfo(tinyJpeg().subarray(0, 30))).toEqual({ orientation: 1 });
  });

  it('reads the pixel size of a picture from its first bytes', () => {
    const bytes = (...parts: (string | number[])[]) => Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...ascii(p)] : p)));
    const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
    const le24 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
    const le32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
    expect(pictureSizeFromHead(tinyJpeg())).toEqual({ width: 8, height: 5 });
    // A phone photo taken upright: stored landscape, shown portrait.
    expect(pictureSizeFromHead(withExifOrientation(6, true))).toEqual({ width: 5, height: 8 });
    expect(pictureSizeFromHead(withExifOrientation(3, false))).toEqual({ width: 8, height: 5 });
    expect(pictureSizeFromHead(tinyPng())).toEqual({ width: 4, height: 3 });
    expect(pictureSizeFromHead(bytes('GIF89a', le16(320), le16(240)))).toEqual({ width: 320, height: 240 });
    const riff = (chunk: string, data: number[]) => bytes('RIFF', le32(4 + 8 + data.length), 'WEBP', chunk, le32(data.length), data);
    expect(pictureSizeFromHead(riff('VP8 ', [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(1200), ...le16(900), 0, 0]))).toEqual({ width: 1200, height: 900 });
    expect(pictureSizeFromHead(riff('VP8L', [0x2f, ...le32((600 - 1) | ((400 - 1) << 14)), 0, 0, 0, 0, 0]))).toEqual({ width: 600, height: 400 });
    expect(pictureSizeFromHead(riff('VP8X', [0x10, 0, 0, 0, ...le24(2000 - 1), ...le24(1500 - 1)]))).toEqual({ width: 2000, height: 1500 });
    const bmp = (header: number, size: number[]) => bytes('BM', le32(0), le32(0), le32(54), le32(header), size, [0, 0, 0, 0]);
    expect(pictureSizeFromHead(bmp(40, [...le32(640), ...le32(-480)]))).toEqual({ width: 640, height: 480 });
    expect(pictureSizeFromHead(bmp(12, [...le16(100), ...le16(50)]))).toEqual({ width: 100, height: 50 });
    // Cut off, unknown or not readable from the header.
    expect(pictureSizeFromHead(tinyPng().subarray(0, 20))).toBeNull();
    expect(pictureSizeFromHead(tinyJpeg().subarray(0, 30))).toBeNull();
    expect(pictureSizeFromHead(riff('VP8 ', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(pictureSizeFromHead(ascii('\u0000\u0000\u0000\u0018ftypheic\u0000\u0000'))).toBeNull();
    expect(pictureSizeFromHead(ascii('ID3\u0004\u0000'))).toBeNull();
    expect(pictureSizeFromHead(new Uint8Array(0))).toBeNull();
  });

  it('reads the pixel size from a Blob, a data URL or a download without decoding', async () => {
    expect(await readPictureSize(new Blob([tinyPng()]))).toEqual({ width: 4, height: 3 });
    expect(await readPictureSize(`data:image/png;base64,${TINY_PNG_BASE64}`)).toEqual({ width: 4, height: 3 });
    const fetchFn = async () => new Response(blobPart(withExifOrientation(8, false)));
    expect(await readPictureSize('https://example.org/cover.jpg', { fetchFn })).toEqual({ width: 5, height: 8 });
  });

  it('stores the print resolution in the JFIF header', () => {
    const jpeg = tinyJpeg();
    const out = setJpegDpi(jpeg, 300);
    expect(out).toHaveLength(jpeg.length);
    expect([...out.subarray(13, 18)]).toEqual([1, 0x01, 0x2c, 0x01, 0x2c]);
    expect(jpeg[13]).toBe(0); // the input is not changed
    expect(jpegInfo(out)).toEqual({ orientation: 1, width: 8, height: 5 });

    // Without a JFIF segment (as some encoders write) one is added after SOI.
    const bare = Uint8Array.from([...jpeg.subarray(0, 2), ...jpeg.subarray(20)]);
    const added = setJpegDpi(bare, 600);
    expect(added).toHaveLength(bare.length + 18);
    expect(String.fromCharCode(...added.subarray(6, 11))).toBe('JFIF\u0000');
    expect([...added.subarray(13, 18)]).toEqual([1, 0x02, 0x58, 0x02, 0x58]);
    expect(jpegInfo(added)).toEqual({ orientation: 1, width: 8, height: 5 });

    const png = tinyPng();
    expect(setJpegDpi(png, 300)).toBe(png);
  });

  it('decodes data URLs without fetch', async () => {
    const jpeg = dataUrlToBytes(`data:image/jpeg;base64,${TINY_JPEG_BASE64}`);
    expect(jpeg.mime).toBe('image/jpeg');
    expect(jpeg.bytes).toEqual(tinyJpeg());
    const wrapped = TINY_JPEG_BASE64.replace(/(.{60})/g, '$1\n');
    expect(dataUrlToBytes(`data:image/JPEG;charset=x;base64,${wrapped}`).bytes).toEqual(tinyJpeg());
    const text = dataUrlToBytes('data:text/plain,Gr%C3%BC%C3%9Fe');
    expect(text.mime).toBe('text/plain');
    expect(new TextDecoder().decode(text.bytes)).toBe('Grüße');
    expect(dataUrlToBytes('data:,abc').mime).toBe('application/octet-stream');
    expect(() => dataUrlToBytes('kein bild')).toThrow('ungültige Daten-URL');

    // The Blob type comes from the bytes when the URL does not tell.
    const blob = dataUrlToBlob(`data:application/octet-stream;base64,${TINY_JPEG_BASE64}`);
    expect(blob.type).toBe('image/jpeg');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(tinyJpeg());
  });

  it('hands out ArrayBuffer-backed bytes for Blob parts', () => {
    const plain = tinyJpeg();
    expect(blobPart(plain)).toBe(plain);
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    const copy = blobPart(shared);
    expect(copy).not.toBe(shared);
    expect(copy.buffer).toBeInstanceOf(ArrayBuffer);
  });
});

describe('sizeSvg', () => {
  it('gives an SVG with only a viewBox a fixed size in its aspect', () => {
    const svg = '<?xml version="1.0"?>\n<!-- Logo -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50"><rect width="200" height="50"/></svg>';
    const sized = sizeSvg(svg, 1024)!;
    expect(sized).toMatchObject({ width: 1024, height: 256 });
    expect(sized.svg).toBe(
      '<?xml version="1.0"?>\n<!-- Logo -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50" width="1024" height="256"><rect width="200" height="50"/></svg>',
    );
    // Portrait viewBox with commas; relative sizes count as no size.
    const tall = sizeSvg("<svg width='100%' height='100%' viewBox='0,0,10,20'><circle r='5'/></svg>", 1024)!;
    expect(tall).toMatchObject({ width: 512, height: 1024 });
    expect(tall.svg).toBe("<svg viewBox='0,0,10,20' width=\"512\" height=\"1024\"><circle r='5'/></svg>");
  });

  it('scales an SVG with width and height but no viewBox as a whole', () => {
    const icon = sizeSvg('<svg width="24" height="24" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h24v24"/></svg>', 1024)!;
    expect(icon.svg).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1024" height="1024"><path d="M0 0h24v24"/></svg>');
    const mm = sizeSvg('<svg height="10mm" width="30mm"/>', 900)!;
    expect(mm).toMatchObject({ width: 900, height: 300 });
    expect(mm.svg).toBe('<svg viewBox="0 0 113.3858 37.7953" width="900" height="300"/>');
    // Width and height win over a viewBox of another shape, as in the browser.
    expect(sizeSvg('<svg width="300" height="100" viewBox="0 0 10 10"></svg>', 600)).toMatchObject({ width: 600, height: 200 });
  });

  it('falls back to the browser size 300 × 150 and needs an svg element', () => {
    expect(sizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><text>Hi</text></svg>', 1000)).toMatchObject({ width: 1000, height: 500 });
    expect(sizeSvg('<html><body>kein Bild</body></html>', 1000)).toBeNull();
    // A stroke width is no width.
    expect(sizeSvg('<svg viewBox="0 0 40 10" stroke-width="2"></svg>', 400)!.svg).toBe('<svg viewBox="0 0 40 10" stroke-width="2" width="400" height="100"></svg>');
  });
});

describe('browser features in Node', () => {
  it('reports no canvas filter support when there is no canvas (stack blur fallback)', () => {
    expect(supportsCanvasFilter()).toBe(false);
  });

  it('recognises abort errors', () => {
    expect(isAbortError(new DOMException('stop', 'AbortError'))).toBe(true);
    expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isAbortError(new Error('x'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
