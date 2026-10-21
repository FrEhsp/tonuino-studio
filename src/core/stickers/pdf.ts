/**
 * Print-ready output for sticker sheets: a PDF built with jsPDF (works in the
 * browser, the desktop app and Node), and for photo-service templates a JPEG
 * of the sheet (browser only, see exportPhotoSheetJpeg).
 *
 * The artwork renderer delivers finished bitmaps that already contain bleed;
 * this module only places them. Every bitmap is positioned so its trim box
 * lies exactly on the label, then clipped to the label plus the printed bleed.
 * Bleed never reaches a neighbouring label: it is limited to half the gap.
 * Pages are created at the template's exact size, nothing is scaled.
 */

import type { jsPDF } from 'jspdf';
import {
  addPdfPage,
  calibrationTransform,
  createPdfDocument,
  drawLabelShape,
  PT_MM,
  toWinAnsi,
  type Calibration,
  type CalibrationTransform,
} from './calibration';
import { blobPart, canvasToBlob, createCanvas, dataUrlToBytes, get2d, setJpegDpi, sniffImageType, type Context2D } from './image';
import { mirrorPage, mirrorTemplate } from './backside';
import { growRect, slotRects, type RectMm, type SlotRect } from './slots';
import { MM_PER_INCH, templateForBleed, type LabelGeometry, type LabelTemplate } from './templates';

export interface StickerBitmap {
  /** Finished sticker: JPEG or PNG bytes, or a data URL of one. */
  image: Blob | Uint8Array | string;
  widthPx: number;
  heightPx: number;
  /** Bleed the bitmap already contains on every side, in mm. */
  bleedMm: number;
}

export interface SheetPdfOptions {
  template: LabelTemplate;
  /** One array per sheet in slot order (see slotRects / paginate); null leaves a label empty. */
  pages: readonly (readonly (StickerBitmap | null)[])[];
  calibration?: Partial<Calibration> | null;
  /** Bleed printed beyond the label edge; at most the bitmap's own bleed. Default: template.defaultBleedMm. */
  bleedMm?: number;
  /** Crop marks at the label corners (for templates the user cuts). */
  cutMarks: boolean;
  /** Thin contour on the label edge (rounded corners, circles), for scissors or a punch. */
  cutLines?: boolean;
  /**
   * "Erst auf Normalpapier probieren": a thin outline around every label of
   * the sheet, printed or not, where the labels are expected (calibrated).
   * Held against the light on a label sheet, it shows at once whether the
   * stickers will land on their labels.
   */
  outlines?: boolean;
  /** Document title (PDF metadata and footer). */
  title: string;
  /** Small hint under the labels when the margin has room. Default true. */
  footer?: boolean;
  /** Deflate content streams. Default true; tests turn it off to read the drawing commands. */
  compress?: boolean;
  /**
   * Back sides for printing on both sides (turned over the long edge): one
   * array per sheet, in the slot order of `pages`, the back of each sticker
   * where its front is. Each sheet is then followed by a page with the backs,
   * mirrored left to right (see mirrorTemplate), without marks or lines.
   */
  backs?: readonly (readonly (StickerBitmap | null)[])[];
}

/** Printable area of a label: trim plus bleed (rectangle, or ellipse for round labels). */
export type PrintClip =
  | { kind: 'rect'; rect: RectMm }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number };

export interface Placement {
  slot: SlotRect;
  bitmap: StickerBitmap;
  /** Page area covered by the (possibly rotated) bitmap, in template mm. Larger than the clip when the aspect differs. */
  box: RectMm;
  /** 90: the bitmap is turned clockwise (portrait artwork on a landscape label or vice versa). */
  rotation: 0 | 90;
  clip: PrintClip;
}

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface CropMarkOptions {
  /** Space between the bleed edge and the start of a mark. Default 0.5 mm. */
  gapMm?: number;
  /** Default 5 mm. */
  lengthMm?: number;
  /** Marks stop this far before any other label's printed area. Default 0.5 mm. */
  clearanceMm?: number;
  /** Shorter marks are dropped. Default 1.5 mm. */
  minLengthMm?: number;
}

const MARK_WIDTH_MM = 0.25 * PT_MM;
/** White line under a gap mark, so the mark shows on a dark picture (see gapMarkSegments). */
const GAP_MARK_HALO_MM = 1 * PT_MM;
const CUT_LINE_WIDTH_MM = 0.4 * PT_MM;
const CUT_LINE_GREY = 110;
/** The outlines of a trial print: thin, and dark enough to see through a label sheet held against the light. */
const OUTLINE_WIDTH_MM = 0.5 * PT_MM;
const OUTLINE_GREY = 40;

// ---------------------------------------------------------------------------
// Pure geometry

/** Bleed per side for one slot: the requested bleed, limited to half the gap to a neighbour. */
export function printBleeds(
  template: LabelTemplate,
  slot: SlotRect,
  bleedMm: number,
): { left: number; top: number; right: number; bottom: number } {
  const b = Math.max(0, bleedMm);
  const halfGapX = Math.max(0, (template.grid.pitchXMm - template.label.widthMm) / 2);
  const halfGapY = Math.max(0, (template.grid.pitchYMm - template.label.heightMm) / 2);
  return {
    left: slot.col > 0 ? Math.min(b, halfGapX) : b,
    right: slot.col < template.grid.cols - 1 ? Math.min(b, halfGapX) : b,
    top: slot.row > 0 ? Math.min(b, halfGapY) : b,
    bottom: slot.row < template.grid.rows - 1 ? Math.min(b, halfGapY) : b,
  };
}

export function printClip(template: LabelTemplate, slot: SlotRect, bleedMm: number): PrintClip {
  const e = printBleeds(template, slot, bleedMm);
  if (template.label.shape === 'round') {
    const grow = Math.min(e.left, e.right, e.top, e.bottom);
    return {
      kind: 'ellipse',
      cx: slot.x + slot.width / 2,
      cy: slot.y + slot.height / 2,
      rx: slot.width / 2 + grow,
      ry: slot.height / 2 + grow,
    };
  }
  return { kind: 'rect', rect: growRect(slot, e.left, e.top, e.right, e.bottom) };
}

/**
 * Where each bitmap of one sheet goes. The bitmap's trim box (bitmap minus
 * its bleed) lands on the label. A bitmap whose aspect matches the label only
 * when turned is rotated clockwise; a remaining aspect mismatch is cropped
 * (centred), never stretched, unless it is within the one pixel that
 * rounding the bitmap size to whole pixels explains.
 */
export function planSheet(template: LabelTemplate, page: readonly (StickerBitmap | null)[], bleedMm: number): Placement[] {
  const rects = slotRects(template);
  if (page.length > rects.length) {
    throw new Error(`Auf einen Bogen passen nur ${rects.length} Sticker, hier sind es ${page.length}. Verteile sie auf mehrere Bögen.`);
  }
  const out: Placement[] = [];
  page.forEach((bitmap, i) => {
    if (!bitmap) return;
    if (!(bitmap.widthPx > 0) || !(bitmap.heightPx > 0) || !(bitmap.bleedMm >= 0)) {
      throw new Error(`Sticker ${i + 1} hat keine gültige Bildgröße. Erstelle die Sticker neu.`);
    }
    const slot = rects[i];
    const target = growRect(slot, bitmap.bleedMm);
    const targetAspect = target.width / target.height;
    const aspect = bitmap.widthPx / bitmap.heightPx;
    const errStraight = Math.abs(Math.log(aspect / targetAspect));
    const errTurned = Math.abs(Math.log(aspect * targetAspect));
    const rotation: 0 | 90 = errTurned + 0.01 < errStraight ? 90 : 0;
    const pageW = rotation === 90 ? bitmap.heightPx : bitmap.widthPx;
    const pageH = rotation === 90 ? bitmap.widthPx : bitmap.heightPx;
    const pageAspect = pageW / pageH;
    let width = target.width;
    let height = target.height;
    // A bitmap rendered for this label has whole-pixel sizes, so its aspect can be off by rounding;
    // within one pixel it fills the target exactly (trim box on the label). Otherwise: crop, centred.
    const roundingOnly = Math.abs(pageW - pageH * targetAspect) <= 1 || Math.abs(pageH - pageW / targetAspect) <= 1;
    if (!roundingOnly) {
      if (pageAspect > targetAspect) width = height * pageAspect;
      else height = width / pageAspect;
    }
    const box = { x: target.x + (target.width - width) / 2, y: target.y + (target.height - height) / 2, width, height };
    out.push({ slot, bitmap, box, rotation, clip: printClip(template, slot, Math.min(Math.max(0, bleedMm), bitmap.bleedMm)) });
  });
  return out;
}

/**
 * Crop marks for the printed slots: two short lines at every label corner,
 * on the extension of the trim lines, starting outside the bleed. Marks stop
 * before any other label's printed area (so they never run into a
 * neighbouring card) and at the page edge; marks that get too short are left
 * out. Every cut line of a printed label also gets marks at both ends of its
 * column or row, so a label between other labels can still be cut with a
 * ruler or trimmer. Gaps full of bleed get their marks from gapMarkSegments.
 * Coordinates are template mm (apply the calibration when drawing).
 */
export function cropMarkSegments(
  template: LabelTemplate,
  printedSlots: readonly number[],
  bleedMm: number,
  options: CropMarkOptions = {},
): Segment[] {
  const gap = options.gapMm ?? 0.5;
  const length = options.lengthMm ?? 5;
  const clearance = options.clearanceMm ?? 0.5;
  const minLength = options.minLengthMm ?? 1.5;
  const bleed = Math.max(0, bleedMm);
  const { widthMm: pw, heightMm: ph } = template.page;
  const { cols, rows } = template.grid;
  const rects = slotRects(template);
  const keepOut = rects.map((r) => growClip(printClip(template, r, bleed), clearance));
  const offset = bleed + gap;
  const seen = new Set<string>();
  const out: Segment[] = [];

  const addMark = (own: number, x0: number, y0: number, dx: number, dy: number): void => {
    let len = Math.min(length, dx > 0 ? pw - x0 : dx < 0 ? x0 : dy > 0 ? ph - y0 : y0);
    if (!(len > 0)) return;
    for (let j = 0; j < keepOut.length; j++) {
      if (j === own) continue;
      const t = entryDistance(keepOut[j], x0, y0, dx, dy);
      if (t === 0) return;
      if (t !== null) len = Math.min(len, t);
    }
    if (len < minLength) return;
    const seg = { x1: round4(x0), y1: round4(y0), x2: round4(x0 + dx * len), y2: round4(y0 + dy * len) };
    const key = [Math.min(seg.x1, seg.x2), Math.min(seg.y1, seg.y2), Math.max(seg.x1, seg.x2), Math.max(seg.y1, seg.y2)].join(',');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(seg);
  };

  for (const index of new Set(printedSlots)) {
    const r = rects[index];
    if (!r) continue;
    const corners: [number, number, 1 | -1, 1 | -1][] = [
      [r.x, r.y, -1, -1],
      [r.x + r.width, r.y, 1, -1],
      [r.x, r.y + r.height, -1, 1],
      [r.x + r.width, r.y + r.height, 1, 1],
    ];
    for (const [cx, cy, sx, sy] of corners) {
      addMark(index, cx + sx * offset, cy, sx, 0);
      addMark(index, cx, cy + sy * offset, 0, sy);
    }
    // Between printed neighbours the corner marks have no room (the gap is bleed), so the
    // vertical cut lines also get marks above the column and below it, the horizontal ones
    // left and right of the row. Duplicates of corner marks are dropped below.
    const top = rects[r.col];
    const bottom = rects[(rows - 1) * cols + r.col];
    const left = rects[r.row * cols];
    const right = rects[r.row * cols + cols - 1];
    for (const x of [r.x, r.x + r.width]) {
      addMark(top.index, x, top.y - offset, 0, -1);
      addMark(bottom.index, x, bottom.y + bottom.height + offset, 0, 1);
    }
    for (const y of [r.y, r.y + r.height]) {
      addMark(left.index, left.x - offset, y, -1, 0);
      addMark(right.index, right.x + right.width + offset, y, 1, 0);
    }
  }
  return out;
}

export interface GapMarkOptions {
  /** Space between a label edge and the end of a gap mark. Shrinks in narrow gaps, down to 0.2 mm. Default 0.5 mm. */
  clearanceMm?: number;
  /** Shorter marks are left out. Default 1 mm. */
  minLengthMm?: number;
}

/**
 * Marks between labels where cropMarkSegments finds no room: when the bleed
 * fills the gap between two labels (the rows of the card sheets, the columns
 * of the photo print), a short mark across the gap on every cut line that
 * runs through it. Without these, such cut lines are only marked at the
 * sheet border, which many printers leave blank and photo labs trim off.
 * The marks lie on paper that is cut away, but on top of the bleed, so they
 * are drawn on a white line (see buildSheetPdf). Only for rectangular labels.
 */
export function gapMarkSegments(
  template: LabelTemplate,
  printedSlots: readonly number[],
  bleedMm: number,
  options: GapMarkOptions = {},
): Segment[] {
  if (template.label.shape !== 'rect') return [];
  const clearance = options.clearanceMm ?? 0.5;
  const minLength = options.minLengthMm ?? 1;
  const eps = 1e-6;
  const rects = slotRects(template);
  const { cols, rows } = template.grid;
  const regular = cropMarkSegments(template, printedSlots, bleedMm);
  const marked = (vertical: boolean, line: number, from: number, to: number) =>
    regular.some((m) =>
      vertical
        ? m.x1 === m.x2 && Math.abs(m.x1 - line) < eps && Math.min(m.y1, m.y2) > from - eps && Math.max(m.y1, m.y2) < to + eps
        : m.y1 === m.y2 && Math.abs(m.y1 - line) < eps && Math.min(m.x1, m.x2) > from - eps && Math.max(m.x1, m.x2) < to + eps,
    );
  const seen = new Set<string>();
  const out: Segment[] = [];
  /** A mark on `line` across the gap from `from` to `to` (perpendicular to the line), unless one is there. */
  const across = (vertical: boolean, line: number, from: number, to: number) => {
    const span = to - from;
    // Prefer 1.5 mm or more; in a narrow gap move closer to the label edges instead of dropping the mark.
    const c = Math.max(0.2, Math.min(clearance, (span - 1.5) / 2));
    if (span - 2 * c < minLength - eps || marked(vertical, line, from, to)) return;
    const a = round4(from + c);
    const b = round4(to - c);
    const seg = vertical ? { x1: round4(line), y1: a, x2: round4(line), y2: b } : { x1: a, y1: round4(line), x2: b, y2: round4(line) };
    const key = `${seg.x1},${seg.y1},${seg.x2},${seg.y2}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(seg);
  };

  for (const index of new Set(printedSlots)) {
    const r = rects[index];
    if (!r) continue;
    const below = r.row < rows - 1 ? rects[index + cols] : undefined;
    const above = r.row > 0 ? rects[index - cols] : undefined;
    const right = r.col < cols - 1 ? rects[index + 1] : undefined;
    const left = r.col > 0 ? rects[index - 1] : undefined;
    for (const x of [r.x, r.x + r.width]) {
      if (below) across(true, x, r.y + r.height, below.y);
      if (above) across(true, x, above.y + above.height, r.y);
    }
    for (const y of [r.y, r.y + r.height]) {
      if (right) across(false, y, r.x + r.width, right.x);
      if (left) across(false, y, left.x + left.width, r.x);
    }
  }
  return out;
}

function growClip(c: PrintClip, by: number): PrintClip {
  return c.kind === 'rect' ? { kind: 'rect', rect: growRect(c.rect, by) } : { ...c, rx: c.rx + by, ry: c.ry + by };
}

/**
 * Distance along an axis-aligned ray until it enters the shape: null if it
 * never does, 0 if it starts inside. Touching the boundary does not count.
 */
function entryDistance(shape: PrintClip, x0: number, y0: number, dx: number, dy: number): number | null {
  const eps = 1e-9;
  const horizontal = dx !== 0;
  const pos = horizontal ? x0 : y0;
  const dir = horizontal ? dx : dy;
  const cross = horizontal ? y0 : x0;
  let lo: number;
  let hi: number;
  if (shape.kind === 'rect') {
    const r = shape.rect;
    const [cLo, cHi] = horizontal ? [r.y, r.y + r.height] : [r.x, r.x + r.width];
    if (!(cross > cLo + eps && cross < cHi - eps)) return null;
    [lo, hi] = horizontal ? [r.x, r.x + r.width] : [r.y, r.y + r.height];
  } else {
    const [c, rAcross, center, rAlong] = horizontal
      ? [shape.cy, shape.ry, shape.cx, shape.rx]
      : [shape.cx, shape.rx, shape.cy, shape.ry];
    const d = (cross - c) / rAcross;
    if (!(Math.abs(d) < 1 - eps)) return null;
    const half = rAlong * Math.sqrt(1 - d * d);
    lo = center - half;
    hi = center + half;
  }
  if (dir > 0) {
    if (pos >= hi - eps) return null;
    if (pos > lo + eps) return 0;
    return lo - pos;
  }
  if (pos <= lo + eps) return null;
  if (pos < hi - eps) return 0;
  return pos - hi;
}

// ---------------------------------------------------------------------------
// PDF

/**
 * Builds the print PDF. Page size comes from the template (for `single`
 * templates: label plus bleed), nothing is scaled, and the PDF asks viewers
 * to print at actual size.
 */
export async function buildSheetPdf(options: SheetPdfOptions): Promise<Blob> {
  if (options.pages.length === 0) throw new Error('Es gibt nichts zu drucken. Wähle mindestens einen Sticker aus.');
  const bleed = Math.max(0, options.bleedMm ?? options.template.defaultBleedMm);
  const template = templateForBleed(options.template, bleed);
  const tf = calibrationTransform(options.calibration, template.page);
  const doc = await createPdfDocument(
    template.page,
    { title: options.title, subject: `Sticker für ${template.name}` },
    options.compress ?? true,
  );
  const images = new ImageCache();

  for (let p = 0; p < options.pages.length; p++) {
    if (p > 0) addPdfPage(doc, template.page);
    const placements = planSheet(template, options.pages[p], bleed);
    for (const placement of placements) {
      drawPlacementPdf(doc, placement, tf, await images.get(placement.bitmap, placement.slot.index));
    }
    if (options.cutLines) {
      doc.setLineWidth(CUT_LINE_WIDTH_MM);
      doc.setDrawColor(CUT_LINE_GREY, CUT_LINE_GREY, CUT_LINE_GREY);
      for (const placement of placements) drawLabelShape(doc, tf.rect(placement.slot), template.label, tf, 'S');
    }
    if (options.outlines) {
      doc.setLineWidth(OUTLINE_WIDTH_MM);
      doc.setDrawColor(OUTLINE_GREY, OUTLINE_GREY, OUTLINE_GREY);
      for (const slot of slotRects(template)) drawLabelShape(doc, tf.rect(slot), template.label, tf, 'S');
      doc.setDrawColor(0, 0, 0);
    }
    if (options.cutMarks) {
      const printed = placements.map((pl) => pl.slot.index);
      const gapMarks = gapMarkSegments(template, printed, bleed);
      if (gapMarks.length > 0) {
        // Gap marks cross the bleed: a white line underneath keeps them visible on dark pictures.
        doc.setLineWidth(GAP_MARK_HALO_MM);
        doc.setDrawColor(255, 255, 255);
        for (const s of gapMarks) doc.line(tf.x(s.x1), tf.y(s.y1), tf.x(s.x2), tf.y(s.y2));
      }
      doc.setLineWidth(MARK_WIDTH_MM);
      doc.setDrawColor(0, 0, 0);
      for (const s of [...cropMarkSegments(template, printed, bleed), ...gapMarks]) doc.line(tf.x(s.x1), tf.y(s.y1), tf.x(s.x2), tf.y(s.y2));
    }
    if (options.footer ?? true) drawFooter(doc, template, tf, bleed, options.title, p, options.pages.length);
    if (options.backs) {
      // Every sheet gets its back page, also an empty one: else the fronts and backs after it would not pair up.
      addPdfPage(doc, template.page);
      const mirrored = mirrorTemplate(template);
      for (const placement of planSheet(mirrored, mirrorPage(options.backs[p] ?? [], template), bleed)) {
        drawPlacementPdf(doc, placement, tf, await images.get(placement.bitmap, placement.slot.index));
      }
      if (options.footer ?? true) drawFooter(doc, mirrored, tf, bleed, `Rückseite: ${options.title}`, p, options.pages.length, 'beidseitig, an der langen Kante wenden');
    }
  }
  return doc.output('blob');
}

interface PdfImage {
  alias: string;
  data: Uint8Array;
  format: 'JPEG' | 'PNG';
}

/** Embeds every distinct image once (same Blob, byte array or data URL → same PDF object). */
class ImageCache {
  private readonly entries = new Map<Blob | Uint8Array | string, Promise<PdfImage>>();

  get(bitmap: StickerBitmap, slotIndex: number): Promise<PdfImage> {
    let entry = this.entries.get(bitmap.image);
    if (!entry) {
      const alias = `sticker-${this.entries.size + 1}`;
      entry = imageBytes(bitmap.image).then((data) => {
        const type = sniffImageType(data);
        if (type !== 'image/jpeg' && type !== 'image/png') {
          throw new Error(`Das Bild für Etikett ${slotIndex + 1} ist kein JPEG oder PNG. Erstelle den Sticker neu.`);
        }
        return { alias, data, format: type === 'image/png' ? 'PNG' : 'JPEG' };
      });
      this.entries.set(bitmap.image, entry);
    }
    return entry;
  }
}

async function imageBytes(image: Blob | Uint8Array | string): Promise<Uint8Array> {
  if (typeof image === 'string') {
    if (!image.startsWith('data:')) throw new Error('Das Stickerbild fehlt. Erstelle den Sticker neu.');
    return dataUrlToBytes(image).bytes;
  }
  if (image instanceof Uint8Array) return image;
  return new Uint8Array(await image.arrayBuffer());
}

function calibrateClip(clip: PrintClip, tf: CalibrationTransform): PrintClip {
  if (clip.kind === 'rect') return { kind: 'rect', rect: tf.rect(clip.rect) };
  return { kind: 'ellipse', cx: tf.x(clip.cx), cy: tf.y(clip.cy), rx: clip.rx * tf.scaleX, ry: clip.ry * tf.scaleY };
}

function drawPlacementPdf(doc: jsPDF, placement: Placement, tf: CalibrationTransform, image: PdfImage): void {
  const box = tf.rect(placement.box);
  const clip = calibrateClip(placement.clip, tf);
  const compression = image.format === 'PNG' ? 'FAST' : 'NONE';
  doc.saveGraphicsState();
  if (clip.kind === 'rect') doc.rect(clip.rect.x, clip.rect.y, clip.rect.width, clip.rect.height, null);
  else doc.ellipse(clip.cx, clip.cy, clip.rx, clip.ry, null);
  doc.clip();
  doc.discardPath();
  if (placement.rotation === 90) {
    // jsPDF rotates around the bottom-left corner of (x, y, w, h); -90° turns the image
    // clockwise into the area x … x + h, y + h … y + h + w. Solve for the box.
    doc.addImage(image.data, image.format, box.x, box.y - box.width, box.height, box.width, image.alias, compression, -90);
  } else {
    doc.addImage(image.data, image.format, box.x, box.y, box.width, box.height, image.alias, compression);
  }
  doc.restoreGraphicsState();
}

function drawFooter(
  doc: jsPDF,
  template: LabelTemplate,
  tf: CalibrationTransform,
  bleed: number,
  title: string,
  pageIndex: number,
  pageCount: number,
  how = 'mit „Tatsächliche Größe“ (100 %) drucken',
): void {
  if (template.kind === 'single' || template.kind === 'photo') return;
  const rects = slotRects(template);
  const lowest = Math.max(...rects.map((r) => r.y + r.height)) + bleed + 1;
  const free = template.page.heightMm - lowest;
  if (free < 9) return;
  const y = Math.min(template.page.heightMm - 5, lowest + free / 2);
  // The standard font only knows WinAnsi characters (see toWinAnsi); a title of emoji alone drops out.
  const parts = [
    title,
    pageCount > 1 ? `Bogen ${pageIndex + 1} von ${pageCount}` : '',
    template.name,
    how,
  ]
    .map((s) => toWinAnsi(s).trim())
    .filter(Boolean);
  const text = parts.join(' · ');
  const maxWidth = template.page.widthMm - 30;
  let size = 6.5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(size);
  while (size > 4.5 && doc.getTextWidth(text) > maxWidth) {
    size -= 0.5;
    doc.setFontSize(size);
  }
  doc.setTextColor(120, 120, 120);
  doc.text(text, tf.x(template.page.widthMm / 2), tf.y(y), { align: 'center', baseline: 'middle', maxWidth });
  doc.setTextColor(0, 0, 0);
}

// ---------------------------------------------------------------------------
// Photo sheet as JPEG (browser only: needs canvas and createImageBitmap)

export interface PhotoSheetOptions {
  template: LabelTemplate;
  /** One sheet in slot order; null leaves a label empty. */
  page: readonly (StickerBitmap | null)[];
  calibration?: Partial<Calibration> | null;
  bleedMm?: number;
  cutMarks: boolean;
  cutLines?: boolean;
  /** Thin outlines around every label, for a trial print (see SheetPdfOptions.outlines). */
  outlines?: boolean;
  /** Default 300. */
  dpi?: number;
  /** JPEG quality 0…1. Default 0.92. */
  quality?: number;
}

/**
 * Renders one sheet as a JPEG for a photo service (e.g. the 13 × 18 cm
 * template). Same placement, clipping and marks as the PDF; the JPEG carries
 * the dpi so viewers print it at its real size. Call once per sheet.
 */
export async function exportPhotoSheetJpeg(options: PhotoSheetOptions): Promise<Blob> {
  const bleed = Math.max(0, options.bleedMm ?? options.template.defaultBleedMm);
  const template = templateForBleed(options.template, bleed);
  const dpi = options.dpi ?? 300;
  const pxPerMm = dpi / MM_PER_INCH;
  const width = Math.round(template.page.widthMm * pxPerMm);
  const height = Math.round(template.page.heightMm * pxPerMm);
  const canvas = createCanvas(width, height);
  const ctx = get2d(canvas);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.setTransform(width / template.page.widthMm, 0, 0, height / template.page.heightMm, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const tf = calibrationTransform(options.calibration, template.page);
  const placements = planSheet(template, options.page, bleed);

  for (const placement of placements) {
    const bytes = await imageBytes(placement.bitmap.image);
    const bitmap = await createImageBitmap(new Blob([blobPart(bytes)], { type: sniffImageType(bytes) ?? 'image/jpeg' }));
    try {
      const box = tf.rect(placement.box);
      ctx.save();
      ctx.beginPath();
      canvasClipPath(ctx, calibrateClip(placement.clip, tf));
      ctx.clip();
      if (placement.rotation === 90) {
        ctx.translate(box.x + box.width / 2, box.y + box.height / 2);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(bitmap, -box.height / 2, -box.width / 2, box.height, box.width);
      } else {
        ctx.drawImage(bitmap, box.x, box.y, box.width, box.height);
      }
      ctx.restore();
    } finally {
      bitmap.close();
    }
  }

  const onePx = 1 / pxPerMm;
  if (options.cutLines) {
    ctx.lineWidth = Math.max(CUT_LINE_WIDTH_MM, onePx);
    ctx.strokeStyle = `rgb(${CUT_LINE_GREY}, ${CUT_LINE_GREY}, ${CUT_LINE_GREY})`;
    for (const placement of placements) {
      ctx.beginPath();
      canvasLabelPath(ctx, tf.rect(placement.slot), template.label, tf);
      ctx.stroke();
    }
  }
  if (options.outlines) {
    ctx.lineWidth = Math.max(OUTLINE_WIDTH_MM, onePx);
    ctx.strokeStyle = `rgb(${OUTLINE_GREY}, ${OUTLINE_GREY}, ${OUTLINE_GREY})`;
    for (const slot of slotRects(template)) {
      ctx.beginPath();
      canvasLabelPath(ctx, tf.rect(slot), template.label, tf);
      ctx.stroke();
    }
  }
  if (options.cutMarks) {
    const printed = placements.map((p) => p.slot.index);
    const gapMarks = gapMarkSegments(template, printed, bleed);
    const stroke = (segments: Segment[]) => {
      ctx.beginPath();
      for (const s of segments) {
        ctx.moveTo(tf.x(s.x1), tf.y(s.y1));
        ctx.lineTo(tf.x(s.x2), tf.y(s.y2));
      }
      ctx.stroke();
    };
    ctx.lineWidth = Math.max(GAP_MARK_HALO_MM, 3 * onePx);
    ctx.strokeStyle = '#ffffff';
    stroke(gapMarks);
    ctx.lineWidth = Math.max(MARK_WIDTH_MM, onePx);
    ctx.strokeStyle = '#000000';
    stroke([...cropMarkSegments(template, printed, bleed), ...gapMarks]);
  }

  const blob = await canvasToBlob(canvas, 'image/jpeg', options.quality ?? 0.92);
  const jpeg = setJpegDpi(new Uint8Array(await blob.arrayBuffer()), dpi);
  return new Blob([blobPart(jpeg)], { type: 'image/jpeg' });
}

function canvasClipPath(ctx: Context2D, clip: PrintClip): void {
  if (clip.kind === 'rect') ctx.rect(clip.rect.x, clip.rect.y, clip.rect.width, clip.rect.height);
  else ctx.ellipse(clip.cx, clip.cy, clip.rx, clip.ry, 0, 0, Math.PI * 2);
}

function canvasLabelPath(ctx: Context2D, r: RectMm, label: LabelGeometry, tf: CalibrationTransform): void {
  if (label.shape === 'round') {
    ctx.ellipse(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2, 0, 0, Math.PI * 2);
    return;
  }
  const rad = Math.min(label.cornerRadiusMm * Math.min(tf.scaleX, tf.scaleY), r.width / 2, r.height / 2);
  if (rad <= 0) {
    ctx.rect(r.x, r.y, r.width, r.height);
    return;
  }
  // arcTo instead of roundRect: older WebKitGTK versions lack roundRect.
  ctx.moveTo(r.x + rad, r.y);
  ctx.arcTo(r.x + r.width, r.y, r.x + r.width, r.y + r.height, rad);
  ctx.arcTo(r.x + r.width, r.y + r.height, r.x, r.y + r.height, rad);
  ctx.arcTo(r.x, r.y + r.height, r.x, r.y, rad);
  ctx.arcTo(r.x, r.y, r.x + r.width, r.y, rad);
  ctx.closePath();
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}
