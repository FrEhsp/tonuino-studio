/**
 * Werkstatt › Tasten-Sticker: draws the key symbols (core/stickers/keysymbols.ts)
 * onto round stickers and lays a whole sheet out with the same code as
 * Sticker drucken (buildSheetPdf, exportPhotoSheetJpeg): same templates,
 * bleed, cut lines and the printer correction of "Drucker ausrichten", so the
 * stickers come out in their real size.
 */
import { buildSheetPdf, exportPhotoSheetJpeg, type StickerBitmap } from '../../core/stickers/pdf';
import { canvasToBlob, createCanvas, get2d, type CanvasLike } from '../../core/stickers/image';
import { handDrawn, markShapes, type KeyMark, type KeySticker, type Pt } from '../../core/stickers/keysymbols';
import { defaultPrintOptions, MM_PER_INCH, type LabelTemplate } from '../../core/stickers/templates';
import type { Calibration } from '../../core/stickers/calibration';

/** Colours of the sticker: white paper, or the caps of arcade buttons (tokens.css --arcade-*). */
export type KeyColor = 'white' | 'black' | 'red' | 'yellow' | 'green' | 'blue';

export const KEY_COLORS: Record<KeyColor, { name: string; bg: string; ink: string }> = {
  white: { name: 'Weiß', bg: '#ffffff', ink: '#1f1a16' },
  black: { name: 'Schwarz', bg: '#1f1a16', ink: '#ffffff' },
  red: { name: 'Rot', bg: '#e5483b', ink: '#ffffff' },
  yellow: { name: 'Gelb', bg: '#f6c12c', ink: '#1f1a16' },
  green: { name: 'Grün', bg: '#58ad46', ink: '#ffffff' },
  blue: { name: 'Blau', bg: '#3f8fd6', ink: '#ffffff' },
};

/** 300 dpi, as for every sticker (pipeline.ts PRINT_DPI); not imported, so this page does not load the sticker renderer. */
const PRINT_PX_PER_MM = 300 / MM_PER_INCH;

/** The symbol takes about half the diameter: big enough to feel, clear of the cut. */
const SYMBOL_PART = 0.5;
/** The pen's width in the symbol's unit box; it rounds the corners. */
const PEN = 0.05;

function markKey(mark: KeyMark): string {
  return `${mark.main}/${mark.small ?? ''}`;
}

/** One sticker with its bleed, at `pxPerMm`. */
export function renderKeySticker(mark: KeyMark, template: LabelTemplate, color: KeyColor, pxPerMm: number, bleedMm = template.defaultBleedMm): CanvasLike {
  const d = template.label.widthMm;
  const side = Math.round((d + 2 * bleedMm) * pxPerMm);
  const canvas = createCanvas(side, side);
  const ctx = get2d(canvas);
  const { bg, ink } = KEY_COLORS[color];
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, side, side);
  ctx.save();
  ctx.translate(side / 2, side / 2);
  const s = SYMBOL_PART * d * pxPerMm;
  ctx.scale(s, s);
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  ctx.lineWidth = PEN;
  ctx.lineJoin = 'round';
  markShapes(mark).forEach((shape, i) => {
    const pts = handDrawn(shape, `${markKey(mark)}#${i}`);
    ctx.beginPath();
    smoothClosed(ctx, pts);
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();
  return canvas;
}

/** A closed line through the points, each corner pulled a little round (as wobbly.ts does for the Lötplan). */
function smoothClosed(ctx: { moveTo(x: number, y: number): void; quadraticCurveTo(cx: number, cy: number, x: number, y: number): void; closePath(): void }, pts: Pt[]): void {
  const n = pts.length;
  const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(pts[n - 1], pts[0]);
  ctx.moveTo(start[0], start[1]);
  for (let i = 0; i < n; i++) {
    const q = mid(pts[i], pts[(i + 1) % n]);
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], q[0], q[1]);
  }
  ctx.closePath();
}

export interface KeySheet {
  template: LabelTemplate;
  /** The stickers in slot order, null for an empty label (see fillSheet). */
  stickers: readonly (KeySticker | null)[];
  color: KeyColor;
  calibration: Calibration;
}

/** Each different sticker once at print resolution, then the sheet in slot order (identical stickers share one picture). */
async function sheetBitmaps(sheet: KeySheet): Promise<(StickerBitmap | null)[]> {
  const bleedMm = sheet.template.defaultBleedMm;
  const made = new Map<string, Promise<StickerBitmap>>();
  const bitmapOf = (mark: KeyMark) => {
    const key = markKey(mark);
    let p = made.get(key);
    if (!p) {
      p = (async () => {
        const canvas = renderKeySticker(mark, sheet.template, sheet.color, PRINT_PX_PER_MM, bleedMm);
        // PNG: flat colour and sharp edges, no JPEG fringes around the symbol.
        return { image: await canvasToBlob(canvas, 'image/png'), widthPx: canvas.width, heightPx: canvas.height, bleedMm };
      })();
      made.set(key, p);
    }
    return p;
  };
  return Promise.all(sheet.stickers.map((s) => (s ? bitmapOf(s.mark) : null)));
}

export const KEY_SHEET_TITLE = 'Tasten-Sticker';

/** The sheet as a PDF in real size, like "PDF speichern" in Sticker drucken. */
export async function keySheetPdf(sheet: KeySheet): Promise<Blob> {
  const page = await sheetBitmaps(sheet);
  const { cutMarks, cutLines, bleedMm } = defaultPrintOptions(sheet.template);
  return buildSheetPdf({ template: sheet.template, pages: [page], calibration: sheet.calibration, bleedMm, cutMarks, cutLines, title: KEY_SHEET_TITLE });
}

/** The sheet as a picture for the page, drawn the same way as for printing. */
export async function keySheetPicture(sheet: KeySheet, dpi = 110): Promise<Blob> {
  const page = await sheetBitmaps(sheet);
  const { cutMarks, cutLines, bleedMm } = defaultPrintOptions(sheet.template);
  return exportPhotoSheetJpeg({ template: sheet.template, page, calibration: sheet.calibration, bleedMm, cutMarks, cutLines, dpi, quality: 0.9 });
}
