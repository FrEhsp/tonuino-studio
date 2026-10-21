/**
 * The Inhaltsliste on paper, drawn like the Bedienkarte: a handwritten
 * title, folder numbers stamped in Permanent Marker, pencil lines, no logo.
 *
 * The sheet is one picture, drawn on a canvas: the app's fonts are WOFF2 and
 * jsPDF only embeds TTF, and the same picture serves "Drucken" (straight to
 * the print dialog, as the sticker sheets do) and the PDF, so both look the
 * same on paper.
 */
import type { jsPDF } from 'jspdf';
import { COLUMN_GAP, LIST_HEAD, LIST_MARGIN, SHEET, listBox, rowDetails, rowHeight, type ContentLayout, type ContentRow } from './contentList';

export interface ContentSheet {
  canvas: HTMLCanvasElement;
  layout: ContentLayout;
  widthMm: number;
  heightMm: number;
}

const INK = '#2a1f16';
const PENCIL = '#8a7866';
/** Stamp ink: the dull blue of a rubber stamp pad (as on the Bedienkarte). */
const STAMP = '#2f4f86';
/** Pixels per millimetre: about 250 dpi, sharp on paper, small enough for a PDF. */
const K = 10;
const PT = 0.3528;

const HAND = (mm: number) => `700 ${mm * K}px 'Shantell Sans', 'Comic Sans MS', sans-serif`;
const MARKER = (mm: number) => `400 ${mm * K}px 'Permanent Marker', 'Shantell Sans', sans-serif`;
const TEXT = (mm: number, weight = 400) => `${weight} ${mm * K}px 'Fira Sans', system-ui, sans-serif`;

async function fontsReady(): Promise<void> {
  try {
    await Promise.all(
      ["700 64px 'Shantell Sans'", "400 64px 'Permanent Marker'", "400 32px 'Fira Sans'", "600 32px 'Fira Sans'"].map((f) => document.fonts.load(f)),
    );
  } catch {
    // The canvas falls back to another font; the list still reads.
  }
}

function wobble(seed: number): () => number {
  let s = (seed * 9301 + 49297) % 233280;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280 - 0.5;
  };
}

/** A pencil line (mm): a little wobbly, the same on every run. */
function pencilLine(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, seed: number, width = 0.25): void {
  const r = wobble(seed);
  const steps = Math.max(2, Math.round(Math.hypot(x2 - x1, y2 - y1) / 12));
  ctx.beginPath();
  ctx.moveTo((x1 + r() * 0.6) * K, (y1 + r() * 0.4) * K);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    ctx.lineTo((x1 + (x2 - x1) * t + r() * 0.5) * K, (y1 + (y2 - y1) * t + r() * 0.35) * K);
  }
  ctx.lineWidth = width * K;
  ctx.lineCap = 'round';
  ctx.stroke();
}

/** The text cut to fit `width` (mm), with "…" at the end. */
function fitted(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width * K) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid).trimEnd()}…`).width <= width * K) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

/** One list, its top left corner at (left, top) in mm. */
function drawList(ctx: CanvasRenderingContext2D, left: number, top: number, rows: readonly ContentRow[], layout: ContentLayout, title: string, about: string, seed: number): void {
  const box = listBox(layout.sheet);
  ctx.textBaseline = 'alphabetic';

  // The title in handwriting, as big as fits on one line (at most 9 mm).
  let size = 9;
  ctx.font = HAND(size);
  while (size > 5 && ctx.measureText(title).width > box.width * K) ctx.font = HAND((size -= 0.5));
  ctx.fillStyle = INK;
  ctx.fillText(fitted(ctx, title, box.width), left * K, (top + size * 0.85) * K);
  ctx.font = TEXT(8.5 * PT);
  ctx.fillStyle = PENCIL;
  ctx.fillText(fitted(ctx, about, box.width), left * K, (top + 15) * K);
  ctx.strokeStyle = PENCIL;
  pencilLine(ctx, left - 1, top + 18.5, left + box.width + 1, top + 18.5, seed, 0.35);

  const rowH = rowHeight(layout.pt);
  const perColumn = Math.ceil(rows.length / layout.columns);
  const colW = (box.width - (layout.columns - 1) * COLUMN_GAP) / layout.columns;
  const name = layout.pt * PT;
  const small = (layout.pt - 1.5) * PT;
  ctx.font = MARKER(name * 1.45);
  // As wide as the widest number in the stamp's font ("02" is wider than "11"), and some air.
  const numW = Math.max(...rows.map((r) => ctx.measureText(r.name).width), ctx.measureText('00').width) / K + 2.5;
  rows.forEach((row, i) => {
    const col = Math.floor(i / perColumn);
    const x = left + col * (colW + COLUMN_GAP);
    const y = top + LIST_HEAD + (i % perColumn) * rowH;
    const nameBase = y + layout.pt * 0.42 * 0.85;
    const smallBase = nameBase + (layout.pt - 1.5) * 0.42 + 0.5;
    ctx.font = MARKER(name * 1.45);
    ctx.fillStyle = STAMP;
    ctx.fillText(row.name, x * K, smallBase * K);
    ctx.font = TEXT(name, 600);
    ctx.fillStyle = INK;
    ctx.fillText(fitted(ctx, row.title, colW - numW), (x + numW) * K, nameBase * K);
    ctx.font = TEXT(small);
    ctx.fillStyle = PENCIL;
    ctx.fillText(fitted(ctx, rowDetails(row), colW - numW), (x + numW) * K, smallBase * K);
    if ((i + 1) % perColumn && i < rows.length - 1) {
      ctx.globalAlpha = 0.45;
      pencilLine(ctx, x, y + rowH - 0.9, x + colW, y + rowH - 0.9, seed + i + 1, 0.18);
      ctx.globalAlpha = 1;
    }
  });
}

/** The whole sheet: the list twice side by side with a line to cut, or once upright. */
export async function drawContentSheet(rows: readonly ContentRow[], layout: ContentLayout, title: string, about: string): Promise<ContentSheet> {
  await fontsReady();
  const page = SHEET[layout.sheet];
  const canvas = document.createElement('canvas');
  canvas.width = page.widthMm * K;
  canvas.height = page.heightMm * K;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Der Browser kann gerade nicht zeichnen.');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (layout.sheet === 'a5x2') {
    const half = page.widthMm / 2;
    drawList(ctx, LIST_MARGIN, LIST_MARGIN, rows, layout, title, about, 3);
    drawList(ctx, half + LIST_MARGIN, LIST_MARGIN, rows, layout, title, about, 31);
    // Where to cut: a dashed line down the middle.
    ctx.strokeStyle = PENCIL;
    ctx.lineWidth = 0.2 * K;
    ctx.setLineDash([2 * K, 2 * K]);
    ctx.beginPath();
    ctx.moveTo(half * K, 6 * K);
    ctx.lineTo(half * K, (page.heightMm - 6) * K);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.save();
    ctx.translate((half + 1.2 + 7 * PT) * K, (page.heightMm - 7) * K);
    ctx.rotate(-Math.PI / 2);
    ctx.font = TEXT(7 * PT);
    ctx.fillStyle = PENCIL;
    ctx.fillText('hier durchschneiden', 0, 0);
    ctx.restore();
  } else {
    drawList(ctx, LIST_MARGIN, LIST_MARGIN, rows, layout, title, about, 3);
  }
  return { canvas, layout, widthMm: page.widthMm, heightMm: page.heightMm };
}

/** The sheet as a picture, for the print dialog and the preview. */
export function sheetPng(sheet: ContentSheet): Promise<Blob> {
  return new Promise((resolve, reject) => sheet.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Das Bild ließ sich nicht erstellen.'))), 'image/png'));
}

/** The sheet as a PDF, the picture filling the page. */
export async function sheetPdf(sheet: ContentSheet): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const doc: jsPDF = new jsPDF({ unit: 'mm', format: 'a4', orientation: sheet.layout.sheet === 'a5x2' ? 'landscape' : 'portrait' });
  doc.addImage(sheet.canvas, 'PNG', 0, 0, sheet.widthMm, sheet.heightMm, undefined, 'FAST');
  return doc.output('blob');
}
