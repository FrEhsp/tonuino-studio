/**
 * Shared test data for the sticker tests: tiny images and a minimal reader for
 * the uncompressed PDFs jsPDF writes (page boxes, image placements, clip
 * rectangles, lines and text).
 */

/** 8 × 5 px baseline JPEG (JFIF, red), 287 bytes. */
export const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAFAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCCAMXT/9k=';

/** 4 × 3 px RGBA PNG (blue, 80 % opaque). */
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAFUlEQVQI12NUSDhwhgEJMDGgAQwBAGLgAhJuWPAnAAAAAElFTkSuQmCC';

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const tinyJpeg = (): Uint8Array<ArrayBuffer> => base64ToBytes(TINY_JPEG_BASE64);
export const tinyPng = (): Uint8Array<ArrayBuffer> => base64ToBytes(TINY_PNG_BASE64);

export const PT_PER_MM = 72 / 25.4;

// Windows-1252 differs from ISO-8859-1 in 0x80–0x9F. Node's TextDecoder decodes
// "windows-1252" as ISO-8859-1, so the table is applied by hand.
const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

function cp1252Char(byte: number): string {
  return String.fromCharCode(CP1252_HIGH[byte] ?? byte);
}

/** PDF bytes as text, decoded as WinAnsi (Windows-1252) like the standard fonts' text. */
export async function pdfSource(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    out += Array.from(bytes.subarray(i, i + 8192), cp1252Char).join('');
  }
  return out;
}

export function pageCount(pdf: string): number {
  return (pdf.match(/\/Type \/Page(?!s)/g) ?? []).length;
}

/** MediaBox of every page in mm. */
export function pageSizesMm(pdf: string): { width: number; height: number }[] {
  return [...pdf.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => ({
    width: Number(m[1]) / PT_PER_MM,
    height: Number(m[2]) / PT_PER_MM,
  }));
}

export interface BoxMm {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImagePlacement extends BoxMm {
  /** Where the top-left corner of the image ended up (top-left page origin, mm). */
  imageTopLeft: { x: number; y: number };
}

type Matrix = [number, number, number, number, number, number];

/**
 * Every image draw ("… cm" operators followed by "/I0 Do") as the page area
 * it covers, in mm with a top-left origin. Handles jsPDF's rotated draws,
 * which use a chain of cm operators.
 */
export function imagePlacementsMm(pdf: string, pageHeightMm: number): ImagePlacement[] {
  const num = '(-?[\\d.]+)';
  const cmRe = new RegExp(`${num} ${num} ${num} ${num} ${num} ${num} cm`, 'g');
  const blocks = [...pdf.matchAll(/q\s+((?:[-\d. ]+ cm\s+)+)\/I\d+ Do/g)];
  return blocks.map((block) => {
    const matrices = [...block[1].matchAll(cmRe)].map((m) => m.slice(1, 7).map(Number) as Matrix);
    const apply = (u: number, v: number) => {
      let x = u;
      let y = v;
      // The last cm applies first (CTM' = M × CTM).
      for (const [a, b, c, d, e, f] of [...matrices].reverse()) {
        [x, y] = [a * x + c * y + e, b * x + d * y + f];
      }
      return { x: x / PT_PER_MM, y: pageHeightMm - y / PT_PER_MM };
    };
    const corners = [apply(0, 0), apply(1, 0), apply(0, 1), apply(1, 1)];
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, imageTopLeft: apply(0, 1) };
  });
}

function rectsBefore(pdf: string, pageHeightMm: number, operator: string): BoxMm[] {
  const re = new RegExp(`(-?[\\d.]+) (-?[\\d.]+) (-?[\\d.]+) (-?[\\d.]+) re\\s+${operator}`, 'g');
  return [...pdf.matchAll(re)].map((m) => {
    const [x, y, w, h] = m.slice(1, 5).map((v) => Number(v) / PT_PER_MM);
    // jsPDF writes rectangles with a negative height (from the top edge downwards).
    const top = pageHeightMm - y;
    return h < 0 ? { x, y: top, width: w, height: -h } : { x, y: top - h, width: w, height: h };
  });
}

/** Clip rectangles ("x y w h re W n") as top-left mm boxes. */
export function clipRectsMm(pdf: string, pageHeightMm: number): BoxMm[] {
  return rectsBefore(pdf, pageHeightMm, 'W\\s+n');
}

/** Stroked rectangles ("x y w h re S") as top-left mm boxes. */
export function strokedRectsMm(pdf: string, pageHeightMm: number): BoxMm[] {
  return rectsBefore(pdf, pageHeightMm, 'S');
}

/** Straight stroked lines ("x1 y1 m x2 y2 l S") in top-left mm coordinates. */
export function linesMm(pdf: string, pageHeightMm: number): { x1: number; y1: number; x2: number; y2: number }[] {
  const re = /(-?[\d.]+) (-?[\d.]+) m\s+(-?[\d.]+) (-?[\d.]+) l\s+S/g;
  return [...pdf.matchAll(re)].map((m) => {
    const [x1, y1, x2, y2] = m.slice(1, 5).map((v) => Number(v) / PT_PER_MM);
    return { x1, y1: pageHeightMm - y1, x2, y2: pageHeightMm - y2 };
  });
}

/** Text shown with Tj, one entry per call, PDF string escapes resolved. */
export function pdfTextLines(pdf: string): string[] {
  return [...pdf.matchAll(/\(((?:\\[\s\S]|[^\\)])*)\)\s*Tj/g)].map((m) =>
    m[1].replace(/\\([0-7]{1,3}|[\s\S])/g, (_, c: string) => {
      if (/^[0-7]+$/.test(c)) return cp1252Char(parseInt(c, 8));
      return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[c] ?? c;
    }),
  );
}

/** All shown text joined with spaces (lines split by jsPDF become one paragraph again). */
export function pdfText(pdf: string): string {
  return pdfTextLines(pdf).join(' ').replace(/\s+/g, ' ');
}

export function imageObjectCount(pdf: string): number {
  return (pdf.match(/\/Subtype \/Image/g) ?? []).length;
}

export function near(actual: number, expected: number, tolerance = 0.01): boolean {
  return Math.abs(actual - expected) <= tolerance;
}
