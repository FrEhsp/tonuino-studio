/**
 * Image helpers for the sticker studio: loading (with EXIF orientation),
 * cropping, high-quality scaling, blurred backgrounds and encoding.
 *
 * Canvas and createImageBitmap are browser APIs and are only touched inside
 * functions, so the pure helpers below (cropRect, fitContain, stackBlur,
 * JPEG parsing, data URLs) can be imported and tested in Node.
 *
 * The desktop app runs in WebKitGTK, which may lack OffscreenCanvas or canvas
 * filters; both are feature-detected with fallbacks.
 */

import { MM_PER_INCH } from './templates';

export interface RectPx {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CanvasLike = HTMLCanvasElement | OffscreenCanvas;
export type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type DrawableImage = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas;
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Height of the default focus point (0 = top, 1 = bottom): a little above the
 * middle, so the name written at the top of a cover survives the crop.
 */
export const DEFAULT_FOCUS_Y = 0.3;

export interface CoverOptions {
  /** Point of the source (0…1) that should end up in the middle of the crop. Default 0.5 across, DEFAULT_FOCUS_Y down. */
  focusX?: number;
  focusY?: number;
  /**
   * 1 = largest crop that fits; 2 = half the width and height (zoomed in).
   * Values below 1 count as 1 for cropping; placePicture shows more of the
   * picture down to 0 (the whole picture).
   */
  zoom?: number;
}

// ---------------------------------------------------------------------------
// Pure geometry

/**
 * Source rectangle (in source pixels) for a "cover" crop with the given
 * aspect ratio (width / height). The crop is centred on the focus point but
 * never leaves the image, so near the border the focus moves off-centre.
 */
export function cropRect(
  srcW: number,
  srcH: number,
  targetAspect: number,
  focusX = 0.5,
  focusY = DEFAULT_FOCUS_Y,
  zoom = 1,
): RectPx {
  if (!(srcW > 0) || !(srcH > 0)) return { x: 0, y: 0, width: 0, height: 0 };
  const aspect = targetAspect > 0 && Number.isFinite(targetAspect) ? targetAspect : srcW / srcH;
  const z = Number.isFinite(zoom) && zoom > 1 ? zoom : 1;
  let w = srcW;
  let h = srcW / aspect;
  if (h > srcH) {
    h = srcH;
    w = srcH * aspect;
  }
  w /= z;
  h /= z;
  const x = clamp(clamp01(focusX) * srcW - w / 2, 0, srcW - w);
  const y = clamp(clamp01(focusY, DEFAULT_FOCUS_Y) * srcH - h / 2, 0, srcH - h);
  return { x, y, width: w, height: h };
}

export interface Placement {
  /** The part of the picture that is drawn, in source pixels. */
  src: RectPx;
  /** Where it goes, relative to the box; smaller than the box when the whole picture does not fill it. */
  dest: RectPx;
}

/**
 * Where a picture goes in a box. Zoom 1 and more crops like cropRect: the
 * picture fills the box and what sticks out is cut off. Zoom 0 shows the whole
 * picture inside the box; values in between scale smoothly from one to the
 * other and cut off only what does not fit. A picture with the aspect of the
 * box fills it at every zoom up to 1.
 */
export function placePicture(srcW: number, srcH: number, boxW: number, boxH: number, options: CoverOptions = {}): Placement {
  const none = { x: 0, y: 0, width: 0, height: 0 };
  if (!(srcW > 0) || !(srcH > 0) || !(boxW > 0) || !(boxH > 0)) return { src: none, dest: none };
  const zoom = typeof options.zoom === 'number' && Number.isFinite(options.zoom) ? Math.max(0, options.zoom) : 1;
  if (zoom >= 1) {
    return { src: cropRect(srcW, srcH, boxW / boxH, options.focusX, options.focusY, zoom), dest: { x: 0, y: 0, width: boxW, height: boxH } };
  }
  const contain = Math.min(boxW / srcW, boxH / srcH);
  const cover = Math.max(boxW / srcW, boxH / srcH);
  // Geometric steps feel even: each step of the slider scales by the same factor.
  const scale = contain * (cover / contain) ** zoom;
  const width = Math.min(boxW, srcW * scale);
  const height = Math.min(boxH, srcH * scale);
  const sw = Math.min(srcW, width / scale);
  const sh = Math.min(srcH, height / scale);
  const x = clamp(clamp01(options.focusX) * srcW - sw / 2, 0, srcW - sw);
  const y = clamp(clamp01(options.focusY, DEFAULT_FOCUS_Y) * srcH - sh / 2, 0, srcH - sh);
  return { src: { x, y, width: sw, height: sh }, dest: { x: (boxW - width) / 2, y: (boxH - height) / 2, width, height } };
}

/** Below this resolution a printed picture looks soft; stickers look best at 300 dpi. */
export const LOW_PRINT_DPI = 150;

/**
 * Print resolution of a picture placed into a box given in millimetres, the
 * way placePicture puts it there: picture pixels per inch on paper.
 */
export function placedDpi(srcW: number, srcH: number, boxWmm: number, boxHmm: number, options: CoverOptions = {}): number {
  const { src, dest } = placePicture(srcW, srcH, boxWmm, boxHmm, options);
  if (!(dest.width > 0) || !(dest.height > 0)) return 0;
  return Math.min(src.width / dest.width, src.height / dest.height) * MM_PER_INCH;
}

/** Focus point (0…1) of a crop rectangle, e.g. to store the result of dragging. */
export function cropFocus(rect: RectPx, srcW: number, srcH: number): { focusX: number; focusY: number } {
  return {
    focusX: srcW > 0 ? clamp01((rect.x + rect.width / 2) / srcW) : 0.5,
    focusY: srcH > 0 ? clamp01((rect.y + rect.height / 2) / srcH) : 0.5,
  };
}

/** Largest rectangle with the source aspect inside a box (relative to the box origin). */
export function fitContain(srcW: number, srcH: number, boxW: number, boxH: number, alignX = 0.5, alignY = 0.5): RectPx {
  if (!(srcW > 0) || !(srcH > 0) || !(boxW > 0) || !(boxH > 0)) return { x: 0, y: 0, width: 0, height: 0 };
  const scale = Math.min(boxW / srcW, boxH / srcH);
  const width = srcW * scale;
  const height = srcH * scale;
  return { x: (boxW - width) * clamp01(alignX), y: (boxH - height) * clamp01(alignY), width, height };
}

/**
 * Longest side a sticker picture keeps after loading: 300 dpi on the largest
 * sticker up to double zoom, still 150 dpi at the strongest zoom; a phone
 * photo shrinks from 48 to 12 MB.
 */
export const MAX_PICTURE_EDGE = 2048;

/** The size a picture is drawn with on a sticker: its own, at most MAX_PICTURE_EDGE long. */
export function usedPictureSize(size: { width: number; height: number }): { width: number; height: number } {
  return fitWithin(size.width, size.height, MAX_PICTURE_EDGE);
}

/** Size with the same aspect whose longer side is at most `maxEdge` (unchanged when it fits already). */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (!(long > maxEdge) || !(maxEdge > 0)) return { width, height };
  const scale = maxEdge / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Intermediate sizes for step-down scaling: each axis is halved while it is
 * more than twice the target, so the final draw shrinks by at most 2×.
 * Bilinear canvas scaling skips source pixels beyond 2× and aliases.
 */
export function stepDownSizes(srcW: number, srcH: number, dstW: number, dstH: number): { width: number; height: number }[] {
  const steps: { width: number; height: number }[] = [];
  let w = Math.round(srcW);
  let h = Math.round(srcH);
  const tw = Math.max(1, Math.round(dstW));
  const th = Math.max(1, Math.round(dstH));
  while (w > tw * 2 || h > th * 2) {
    w = w > tw * 2 ? Math.ceil(w / 2) : w;
    h = h > th * 2 ? Math.ceil(h / 2) : h;
    steps.push({ width: w, height: h });
  }
  return steps;
}

/**
 * Stack blur in place on RGBA pixels (triangle kernel, borders clamped so the
 * edges do not darken). Cost does not depend on the radius. Alpha is blurred
 * like the colour channels, so use it on opaque pixels.
 */
export function stackBlur(data: Uint8ClampedArray, width: number, height: number, radius: number): void {
  const r = Math.min(254, Math.max(0, Math.round(radius)));
  if (r < 1 || width < 1 || height < 1) return;
  if (data.length < width * height * 4) throw new RangeError('stackBlur: pixel data is smaller than width × height.');
  const tmp = new Uint8ClampedArray(width * height * 4);
  blurLines(data, tmp, height, width, 4, width * 4, r);
  blurLines(tmp, data, width, height, width * 4, 4, r);
}

/** Stack blur radius whose (two-pass) result matches a Gaussian with this standard deviation. */
export function stackRadiusForSigma(sigma: number): number {
  return Math.max(1, Math.round(-1 + Math.sqrt(1 + 3 * sigma * sigma)));
}

function blurLines(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  lines: number,
  length: number,
  stride: number,
  lineStep: number,
  r: number,
): void {
  // S(x) = Σ (r + 1 - |k|) p(x + k); S(x + 1) = S(x) + IN(x) - OUT(x) with
  // IN(x) = Σ p(x + 1 … x + r + 1) and OUT(x) = Σ p(x - r … x).
  const div = (r + 1) * (r + 1);
  const last = length - 1;
  for (let line = 0; line < lines; line++) {
    const base = line * lineStep;
    for (let ch = 0; ch < 4; ch++) {
      const at = (i: number) => src[base + (i < 0 ? 0 : i > last ? last : i) * stride + ch];
      let sum = 0;
      let sumIn = 0;
      let sumOut = 0;
      for (let k = -r; k <= r; k++) sum += (r + 1 - Math.abs(k)) * at(k);
      for (let j = 1; j <= r + 1; j++) sumIn += at(j);
      for (let j = -r; j <= 0; j++) sumOut += at(j);
      for (let x = 0; x < length; x++) {
        dst[base + x * stride + ch] = Math.round(sum / div);
        sum += sumIn - sumOut;
        const next = at(x + 1);
        sumIn += at(x + r + 2) - next;
        sumOut += next - at(x - r);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Bytes: type sniffing, JPEG header, data URLs

export type SniffedImageType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/bmp' | 'image/heic' | 'image/avif';

export function sniffImageType(bytes: Uint8Array): SniffedImageType | null {
  const b = bytes;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a) return 'image/png';
  if (b.length >= 6 && ascii(0, 4) === 'GIF8') return 'image/gif';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
  }
  return null;
}

export interface JpegInfo {
  /** Stored pixel size (before EXIF orientation); undefined when the frame header was not found. */
  width?: number;
  height?: number;
  /** EXIF orientation 1–8; 1 when there is none. */
  orientation: number;
}

/** Reads size and EXIF orientation from the start of a JPEG; null for non-JPEG data. */
export function jpegInfo(bytes: Uint8Array): JpegInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const info: JpegInfo = { orientation: 1 };
  let p = 2;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) {
      p++;
      continue;
    }
    const marker = bytes[p + 1];
    if (marker === 0xff) {
      p++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const len = (bytes[p + 2] << 8) | bytes[p + 3];
    if (len < 2) break;
    const seg = p + 4;
    if (marker === 0xe1 && seg + 6 <= bytes.length && String.fromCharCode(...bytes.subarray(seg, seg + 4)) === 'Exif') {
      const o = exifOrientation(bytes, seg + 6, Math.min(bytes.length, p + 2 + len));
      if (o) info.orientation = o;
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && seg + 5 <= bytes.length) {
      info.height = (bytes[seg + 1] << 8) | bytes[seg + 2];
      info.width = (bytes[seg + 3] << 8) | bytes[seg + 4];
      break;
    }
    p += 2 + len;
  }
  return info;
}

/**
 * Pixel size of a picture as it is shown (EXIF orientation applied), read
 * from its first bytes: JPEG, PNG, GIF, WebP or BMP. Null when the header is
 * cut off or the format is not one of these.
 */
export function pictureSizeFromHead(b: Uint8Array): { width: number; height: number } | null {
  const u16le = (o: number) => b[o] | (b[o + 1] << 8);
  const u24le = (o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  const u32le = (o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const u32be = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  let size: { width: number; height: number } | null = null;
  switch (sniffImageType(b)) {
    case 'image/jpeg': {
      const info = jpegInfo(b);
      if (!info?.width || !info.height) return null;
      // Orientations 5–8 turn the picture by a quarter.
      size = info.orientation >= 5 ? { width: info.height, height: info.width } : { width: info.width, height: info.height };
      break;
    }
    case 'image/png':
      if (b.length < 24 || ascii(12, 16) !== 'IHDR') return null;
      size = { width: u32be(16), height: u32be(20) };
      break;
    case 'image/gif':
      if (b.length < 10) return null;
      size = { width: u16le(6), height: u16le(8) };
      break;
    case 'image/webp': {
      if (b.length < 30) return null;
      const chunk = ascii(12, 16);
      if (chunk === 'VP8 ') {
        if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
        size = { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
      } else if (chunk === 'VP8L') {
        if (b[20] !== 0x2f) return null;
        const bits = u32le(21);
        size = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      } else if (chunk === 'VP8X') {
        size = { width: u24le(24) + 1, height: u24le(27) + 1 };
      }
      break;
    }
    case 'image/bmp': {
      if (b.length < 26) return null;
      // The old 12-byte header has 16-bit sizes; newer ones 32 bits, negative for top-down rows.
      if (u32le(14) === 12) size = { width: u16le(18), height: u16le(20) };
      else size = { width: Math.abs(u32le(18) | 0), height: Math.abs(u32le(22) | 0) };
      break;
    }
    default:
      return null;
  }
  return size && size.width > 0 && size.height > 0 ? size : null;
}

/** EXIF orientation of a JPEG (1 = upright, also for non-JPEG data). */
export function readJpegOrientation(bytes: Uint8Array): number {
  return jpegInfo(bytes)?.orientation ?? 1;
}

function exifOrientation(b: Uint8Array, tiff: number, end: number): number | null {
  if (tiff + 8 > end) return null;
  const le = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  const be = b[tiff] === 0x4d && b[tiff + 1] === 0x4d;
  if (!le && !be) return null;
  const u16 = (o: number) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o: number) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000 : b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]));
  if (u16(tiff + 2) !== 42) return null;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) break;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/**
 * Sets the JFIF pixel density to `dpi` (patching the APP0 segment, or adding
 * one), so image viewers print the photo sheet at its real size.
 */
export function setJpegDpi(bytes: Uint8Array, dpi: number): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const d = Math.min(65535, Math.max(1, Math.round(dpi)));
  const isJfif =
    bytes.length >= 20 &&
    bytes[2] === 0xff &&
    bytes[3] === 0xe0 &&
    String.fromCharCode(...bytes.subarray(6, 11)) === 'JFIF\0';
  if (isJfif) {
    const out = new Uint8Array(bytes);
    out[13] = 1; // units: dots per inch
    out[14] = d >> 8;
    out[15] = d & 0xff;
    out[16] = d >> 8;
    out[17] = d & 0xff;
    return out;
  }
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, d >> 8, d & 0xff, d >> 8, d & 0xff, 0x00, 0x00];
  const out = new Uint8Array(bytes.length + app0.length);
  out.set(bytes.subarray(0, 2), 0);
  out.set(app0, 2);
  out.set(bytes.subarray(2), 2 + app0.length);
  return out;
}

/** Decodes a data URL without fetch (works under strict CSP and in Node). */
export function dataUrlToBytes(dataUrl: string): { mime: string; bytes: Uint8Array<ArrayBuffer> } {
  const m = /^data:([^,]*?),(.*)$/s.exec(dataUrl.trim());
  if (!m) throw new Error('Das Bild ist beschädigt (ungültige Daten-URL). Wähle das Bild noch einmal aus.');
  const params = m[1].split(';').map((s) => s.trim());
  const base64 = params.includes('base64');
  const mime = params[0] && params[0].includes('/') ? params[0].toLowerCase() : 'application/octet-stream';
  if (base64) {
    const bin = atob(m[2].replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mime, bytes };
  }
  return { mime, bytes: new TextEncoder().encode(decodeURIComponent(m[2])) };
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const { mime, bytes } = dataUrlToBytes(dataUrl);
  return new Blob([bytes], { type: sniffImageType(bytes) ?? mime });
}

/** Bytes as a Blob part (Blob wants an ArrayBuffer-backed view; copies only when needed). */
export function blobPart(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
}

export interface SizedSvg {
  svg: string;
  width: number;
  height: number;
}

const SVG_UNIT_PX: Record<string, number> = { '': 1, px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };

/**
 * The SVG with a fixed pixel size on its root element: `longEdge` pixels on
 * the longer side, in the aspect of its own width and height or else of its
 * viewBox. An SVG without width and height has no size of its own; browsers
 * then report 300 × 150 but draw it at another scale, so parts of it come out
 * too small or cut off. Null when the text has no <svg> element.
 */
export function sizeSvg(text: string, longEdge: number): SizedSvg | null {
  const root = /<svg\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i.exec(text);
  if (!root) return null;
  let attrs = root[1];
  const selfClosing = /\/\s*$/.test(attrs);
  if (selfClosing) attrs = attrs.replace(/\/\s*$/, '');
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(attrs)?.[2];
  const length = (v: string | undefined) => {
    const m = /^\s*([0-9]*\.?[0-9]+(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in)?\s*$/i.exec(v ?? '');
    const n = m ? Number(m[1]) * SVG_UNIT_PX[(m[2] ?? '').toLowerCase()] : NaN;
    return n > 0 && Number.isFinite(n) ? n : undefined;
  };
  const box = (attr('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const hasViewBox = box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0;
  const w = length(attr('width'));
  const h = length(attr('height'));
  // Browsers fall back to 300 × 150 for an SVG without any size.
  const aspect = w && h ? w / h : hasViewBox ? box[2] / box[3] : 2;
  const edge = Math.max(1, Math.round(longEdge));
  const width = aspect >= 1 ? edge : Math.max(1, Math.round(edge * aspect));
  const height = aspect >= 1 ? Math.max(1, Math.round(edge / aspect)) : edge;
  attrs = attrs.replace(/\s(?:width|height)\s*=\s*(["']).*?\1/gi, '');
  // Without a viewBox the drawing would keep its old scale inside the new size.
  if (!hasViewBox && w && h) attrs += ` viewBox="0 0 ${round4(w)} ${round4(h)}"`;
  const tag = `<svg${attrs} width="${width}" height="${height}"${selfClosing ? '/' : ''}>`;
  return { svg: text.slice(0, root.index) + tag + text.slice(root.index + root[0].length), width, height };
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

// ---------------------------------------------------------------------------
// Canvas (browser only)

let offscreenUsable: boolean | undefined;

/** OffscreenCanvas when it has a 2D context, else a <canvas> element. */
export function createCanvas(width: number, height: number): CanvasLike {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (offscreenUsable === undefined) {
    try {
      offscreenUsable = typeof OffscreenCanvas !== 'undefined' && new OffscreenCanvas(1, 1).getContext('2d') !== null;
    } catch {
      offscreenUsable = false;
    }
  }
  if (offscreenUsable) return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  throw new Error('Bilder können hier nicht bearbeitet werden, weil keine Zeichenfläche (Canvas) verfügbar ist.');
}

export function get2d(canvas: CanvasLike, options?: CanvasRenderingContext2DSettings): Context2D {
  let ctx: Context2D | null;
  if (isOffscreen(canvas)) ctx = canvas.getContext('2d', options);
  else ctx = (canvas as HTMLCanvasElement).getContext('2d', options);
  if (!ctx) throw new Error('Bilder können hier nicht bearbeitet werden, weil die Zeichenfläche nicht startet.');
  return ctx;
}

function isOffscreen(canvas: CanvasLike): canvas is OffscreenCanvas {
  return typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas;
}

export function imageSize(img: DrawableImage): { width: number; height: number } {
  if ('naturalWidth' in img) return { width: img.naturalWidth, height: img.naturalHeight };
  return { width: img.width, height: img.height };
}

/**
 * Loads an image honouring its EXIF orientation. Accepts a Blob, a data URL,
 * a blob: URL or an http(s) URL (the server must allow CORS).
 */
export async function loadImageBitmap(
  source: Blob | string,
  options: { fetchFn?: FetchLike; signal?: AbortSignal } = {},
): Promise<ImageBitmap> {
  const blob = typeof source === 'string' ? await blobFromUrl(source, options) : source;
  const head = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
  const type = sniffImageType(head);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (err) {
    // Engines that predate imageOrientation 'from-image' throw a TypeError for the option.
    // <img> applies EXIF orientation in all current engines.
    try {
      bitmap = await decodeViaImageElement(blob);
    } catch {
      throw new Error(decodeErrorMessage(type), { cause: err });
    }
  }
  return fixIgnoredOrientation(bitmap, head);
}

/**
 * Pixel size of a picture as it is shown, from its header; only pictures whose
 * header says nothing are decoded for it.
 */
export async function readPictureSize(
  source: Blob | string,
  options: { fetchFn?: FetchLike; signal?: AbortSignal } = {},
): Promise<{ width: number; height: number }> {
  const blob = typeof source === 'string' ? await blobFromUrl(source, options) : source;
  const size = pictureSizeFromHead(new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer()));
  if (size) return size;
  const bitmap = await loadImageBitmap(blob);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

export async function imageFromDataUrl(dataUrl: string): Promise<ImageBitmap> {
  return loadImageBitmap(dataUrlToBlob(dataUrl));
}

async function blobFromUrl(url: string, options: { fetchFn?: FetchLike; signal?: AbortSignal }): Promise<Blob> {
  if (url.startsWith('data:')) return dataUrlToBlob(url);
  const fetchFn: FetchLike = options.fetchFn ?? ((u, init) => fetch(u, init));
  let res: Response;
  try {
    res = await fetchFn(url, { signal: options.signal });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new Error('Das Bild konnte nicht geladen werden. Prüfe die Internetverbindung oder wähle ein anderes Bild.', { cause: err });
  }
  if (!res.ok) throw new Error(`Das Bild konnte nicht geladen werden (Fehler ${res.status}). Wähle ein anderes Bild.`);
  return res.blob();
}

function decodeErrorMessage(type: SniffedImageType | null): string {
  if (type === 'image/heic') {
    return 'iPhone-Fotos im HEIC-Format kann der Browser nicht öffnen. Speichere das Foto als JPEG und versuche es noch einmal.';
  }
  return 'Das Bild konnte nicht geöffnet werden. Nimm ein JPEG-, PNG- oder WebP-Bild.';
}

async function decodeViaImageElement(blob: Blob): Promise<ImageBitmap> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const canvas = createCanvas(img.naturalWidth, img.naturalHeight);
    get2d(canvas).drawImage(img, 0, 0);
    return await createImageBitmap(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * For EXIF orientations 5–8 the decoded size must be the stored size with
 * width and height swapped. If it is not, the engine ignored the orientation
 * and we rotate ourselves. (1–4 cannot be detected this way; engines that
 * accept 'from-image' apply them.)
 */
async function fixIgnoredOrientation(bitmap: ImageBitmap, head: Uint8Array): Promise<ImageBitmap> {
  const info = jpegInfo(head);
  if (!info || info.orientation < 5 || !info.width || !info.height || info.width === info.height) return bitmap;
  if (bitmap.width !== info.width || bitmap.height !== info.height) return bitmap;
  const fixed = await applyOrientation(bitmap, info.orientation);
  bitmap.close();
  return fixed;
}

/** Draws an image with an EXIF orientation applied (1–8). */
export async function applyOrientation(img: DrawableImage, orientation: number): Promise<ImageBitmap> {
  const { width: w, height: h } = imageSize(img);
  const swap = orientation >= 5 && orientation <= 8;
  const canvas = createCanvas(swap ? h : w, swap ? w : h);
  const ctx = get2d(canvas);
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, h, w); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
    default: break;
  }
  ctx.drawImage(img, 0, 0);
  return createImageBitmap(canvas);
}

/**
 * drawImage with step-down halving when the source is more than twice the
 * size of the destination (measured in device pixels, so transforms count).
 */
export function drawImageHQ(
  ctx: Context2D,
  img: DrawableImage,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  if (!(sw > 0) || !(sh > 0) || !(dw > 0) || !(dh > 0)) return;
  const m = ctx.getTransform();
  const deviceW = Math.abs(dw * Math.hypot(m.a, m.b));
  const deviceH = Math.abs(dh * Math.hypot(m.c, m.d));
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (sw > deviceW * 2 || sh > deviceH * 2) {
    const small = resizeImage(img, deviceW, deviceH, { x: sx, y: sy, width: sw, height: sh });
    ctx.drawImage(small, 0, 0, small.width, small.height, dx, dy, dw, dh);
    return;
  }
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

/** High-quality resize of an image (or a part of it) to a new canvas. */
export function resizeImage(img: DrawableImage, width: number, height: number, crop?: RectPx): CanvasLike {
  const size = imageSize(img);
  const src = crop ?? { x: 0, y: 0, width: size.width, height: size.height };
  const tw = Math.max(1, Math.round(width));
  const th = Math.max(1, Math.round(height));
  let current: DrawableImage = img;
  let cx = src.x;
  let cy = src.y;
  let cw = src.width;
  let ch = src.height;
  for (const step of stepDownSizes(cw, ch, tw, th)) {
    const c = createCanvas(step.width, step.height);
    const g = get2d(c);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(current, cx, cy, cw, ch, 0, 0, step.width, step.height);
    current = c;
    cx = 0;
    cy = 0;
    cw = step.width;
    ch = step.height;
  }
  const out = createCanvas(tw, th);
  const g = get2d(out);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(current, cx, cy, cw, ch, 0, 0, tw, th);
  return out;
}

/** Fills the box with the image, cropping what does not fit. Returns the source rectangle used. */
export function drawCover(
  ctx: Context2D,
  img: DrawableImage,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  options: CoverOptions = {},
): RectPx {
  const { width, height } = imageSize(img);
  const src = cropRect(width, height, dw / dh, options.focusX, options.focusY, options.zoom);
  drawImageHQ(ctx, img, src.x, src.y, src.width, src.height, dx, dy, dw, dh);
  return src;
}

/** Fits the whole image into the box without cropping. Returns the destination rectangle. */
export function drawContain(
  ctx: Context2D,
  img: DrawableImage,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  options: { alignX?: number; alignY?: number } = {},
): RectPx {
  const { width, height } = imageSize(img);
  const r = fitContain(width, height, dw, dh, options.alignX ?? 0.5, options.alignY ?? 0.5);
  const dest = { x: dx + r.x, y: dy + r.y, width: r.width, height: r.height };
  drawImageHQ(ctx, img, 0, 0, width, height, dest.x, dest.y, dest.width, dest.height);
  return dest;
}

let canvasFilterSupport: boolean | undefined;

/**
 * True when `ctx.filter = 'blur(…)'` really blurs. Checked by drawing, because
 * some WebKit versions accept the property but ignore it.
 */
export function supportsCanvasFilter(): boolean {
  if (canvasFilterSupport !== undefined) return canvasFilterSupport;
  try {
    const src = createCanvas(9, 9);
    const s = get2d(src);
    s.fillStyle = '#000';
    s.fillRect(0, 0, 9, 9);
    s.fillStyle = '#fff';
    s.fillRect(4, 4, 1, 1);
    const dst = createCanvas(9, 9);
    const d = get2d(dst, { willReadFrequently: true });
    if (typeof d.filter !== 'string') return (canvasFilterSupport = false);
    d.filter = 'blur(1.5px)';
    d.drawImage(src, 0, 0);
    d.filter = 'none';
    const px = d.getImageData(0, 0, 9, 9).data;
    const centre = px[(4 * 9 + 4) * 4];
    const near = px[(4 * 9 + 2) * 4];
    canvasFilterSupport = centre < 250 && near > 0;
  } catch {
    canvasFilterSupport = false;
  }
  return canvasFilterSupport;
}

/**
 * The image as a blurred, cropped ("cover") background of width × height.
 * `radiusPx` is the blur strength as in CSS `blur()` (standard deviation, in
 * output pixels). Uses the canvas filter when it works and a JavaScript
 * stack blur otherwise; blurs on a reduced copy for speed, with a margin of
 * real image content so the edges do not fade.
 */
export function blurredBackground(
  img: DrawableImage,
  width: number,
  height: number,
  radiusPx: number,
  options: CoverOptions = {},
): CanvasLike {
  const W = Math.max(1, Math.round(width));
  const H = Math.max(1, Math.round(height));
  const out = createCanvas(W, H);
  const octx = get2d(out);
  octx.fillStyle = '#fff';
  octx.fillRect(0, 0, W, H);
  const sigma = Math.max(0, radiusPx || 0);
  if (sigma < 0.5) {
    drawCover(octx, img, 0, 0, W, H, options);
    return out;
  }
  const factor = Math.max(1, sigma / 6);
  const workSigma = sigma / factor;
  const pad = Math.ceil(3 * workSigma);
  const ww = Math.max(1, Math.round(W / factor));
  const wh = Math.max(1, Math.round(H / factor));
  const useFilter = supportsCanvasFilter();
  const work = createCanvas(ww + 2 * pad, wh + 2 * pad);
  const wctx = get2d(work, { willReadFrequently: !useFilter });
  wctx.fillStyle = '#fff';
  wctx.fillRect(0, 0, work.width, work.height);
  drawCover(wctx, img, 0, 0, work.width, work.height, options);

  let blurred: CanvasLike = work;
  if (useFilter) {
    blurred = createCanvas(work.width, work.height);
    const bctx = get2d(blurred);
    bctx.filter = `blur(${workSigma.toFixed(2)}px)`;
    bctx.drawImage(work, 0, 0);
    bctx.filter = 'none';
  } else {
    const data = wctx.getImageData(0, 0, work.width, work.height);
    // stackRadiusForSigma already accounts for the two passes.
    const r = stackRadiusForSigma(workSigma);
    stackBlur(data.data, work.width, work.height, r);
    stackBlur(data.data, work.width, work.height, r);
    wctx.putImageData(data, 0, 0);
  }
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(blurred, pad, pad, ww, wh, 0, 0, W, H);
  return out;
}

/** Encodes a canvas; uses convertToBlob for OffscreenCanvas and toBlob otherwise. */
export async function canvasToBlob(canvas: CanvasLike, type = 'image/jpeg', quality = 0.92): Promise<Blob> {
  if (isOffscreen(canvas)) return canvas.convertToBlob({ type, quality });
  const html = canvas;
  return new Promise<Blob>((resolve, reject) => {
    html.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Das Bild konnte nicht gespeichert werden. Versuche es noch einmal.'))),
      type,
      quality,
    );
  });
}

export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number | undefined, fallback = 0.5): number {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : fallback;
}
