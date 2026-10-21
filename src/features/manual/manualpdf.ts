/**
 * The Bedienkarte as a PDF: an A4 sheet across, with the card twice (A5
 * each), to cut in half: one for the box, one for the drawer. Drawn like
 * the app: a handwritten title, headings stamped in Permanent Marker (the
 * stamp of the folder numbers), pencil frames, no logo.
 * jsPDF only embeds TTF fonts and the app's handwriting is WOFF2, so the
 * headings are drawn on a canvas and placed as pictures (as on the QR sheet).
 */
import type { jsPDF } from 'jspdf';
import { toWinAnsi } from '../../core/stickers/calibration';
import type { ManualSection } from '../../core/tonuino/manual';

export interface ManualPdfOptions {
  /** Big at the top, e.g. "So geht Emmas Box". */
  title: string;
  /** Small under the title, e.g. "TonUINO TNG · 3 Tasten". */
  about?: string;
  /** At the bottom: who to ask. Left empty, a line to write on. */
  contact?: string;
}

const INK = '#2a1f16';
const PENCIL = '#8a7866';
/** Stamp ink: the dull blue of a rubber stamp pad. */
const STAMP = '#2f4f86';
const PAGE_W = 297;
const PAGE_H = 210;
const HALF = PAGE_W / 2;
const MARGIN = 12;

interface Drawn {
  url: string;
  ratio: number;
}

async function fontsReady(): Promise<void> {
  try {
    if (typeof document !== 'undefined' && document.fonts) await Promise.all([document.fonts.load("700 64px 'Shantell Sans'"), document.fonts.load("400 64px 'Permanent Marker'")]);
  } catch {
    // The canvas falls back to another font; the card still works.
  }
}

/** Handwriting as a picture; null without a canvas (tests), then Helvetica stands in. */
const HAND = (px: number) => `700 ${px}px 'Shantell Sans', 'Comic Sans MS', sans-serif`;
/** The stamp of the app (folder numbers on stickers): Permanent Marker. */
const MARKER = (px: number) => `400 ${px}px 'Permanent Marker', 'Shantell Sans', sans-serif`;

function drawn(text: string, color: string, px = 64, face: (px: number) => string = HAND): Drawn | null {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const font = face(px);
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width + px * 0.3);
    const h = Math.ceil(px * 1.4);
    canvas.width = w;
    canvas.height = h;
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.fillText(text, px * 0.15, px * 1.05);
    return { url: canvas.toDataURL('image/png'), ratio: w / h };
  } catch {
    return null;
  }
}

function wobble(seed: number): () => number {
  let s = (seed * 9301 + 49297) % 233280;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280 - 0.5;
  };
}

/** A pencil frame: slightly wobbly lines, corners overshooting a little. Same on every run. */
function pencilFrame(doc: jsPDF, x: number, y: number, w: number, h: number, seed: number, color = PENCIL): void {
  const r = wobble(seed);
  doc.setDrawColor(color);
  doc.setLineWidth(0.35);
  const side = (x1: number, y1: number, x2: number, y2: number) => {
    const steps = Math.max(2, Math.round(Math.hypot(x2 - x1, y2 - y1) / 12));
    let px = x1 + r() * 0.8;
    let py = y1 + r() * 0.8;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const nx = x1 + (x2 - x1) * t + r() * 0.6;
      const ny = y1 + (y2 - y1) * t + r() * 0.6;
      doc.line(px, py, nx, ny);
      px = nx;
      py = ny;
    }
  };
  side(x - 1, y, x + w + 0.8, y);
  side(x + w, y - 1, x + w, y + h + 0.8);
  side(x + w + 1, y + h, x - 0.8, y + h);
  side(x, y + h + 1, x, y - 0.8);
}

/** Lines the contact may take at the foot of the card; ManualTool limits its length to fit them. */
const CONTACT_LINES = 2;

/** Line height (mm) for a font size (pt). */
const lineH = (pt: number) => pt * 0.42;

interface Layout {
  pt: number;
  whatW: number;
}

/** Height of the sections at this font size, measured with the document's font. */
function sectionsHeight(doc: jsPDF, sections: ManualSection[], width: number, l: Layout): number {
  doc.setFontSize(l.pt);
  let h = 0;
  for (const s of sections) {
    h += 9;
    for (const row of s.rows) {
      doc.setFont('helvetica', 'bold');
      const what = doc.splitTextToSize(toWinAnsi(row.what), l.whatW) as string[];
      doc.setFont('helvetica', 'normal');
      const does = doc.splitTextToSize(toWinAnsi(row.does), width - l.whatW - 8) as string[];
      h += Math.max(what.length, does.length) * lineH(l.pt) + 1.4;
    }
    h += 5;
  }
  return h;
}

/** One card on one half of the sheet. */
function drawCard(doc: jsPDF, left: number, sections: ManualSection[], opts: ManualPdfOptions, title: Drawn | null, heads: Map<string, Drawn | null>): void {
  const width = HALF - 2 * MARGIN;
  let y = MARGIN;
  if (title) {
    const h = Math.min(11, (width / title.ratio) * 0.98);
    doc.addImage(title.url, 'PNG', left - 1, y - 1, h * title.ratio, h);
    y += h + 1;
  } else {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(17);
    doc.setTextColor(INK);
    doc.text(toWinAnsi(opts.title), left, y + 7);
    y += 10;
  }
  if (opts.about) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(PENCIL);
    doc.text(toWinAnsi(opts.about), left, y + 2);
    y += 5;
  }
  y += 2;

  // The biggest type that still fits above the footer.
  const footer = 14;
  const room = PAGE_H - MARGIN - footer - y;
  let layout: Layout = { pt: 10, whatW: 40 };
  for (const pt of [10, 9.5, 9, 8.5, 8, 7.5, 7]) {
    layout = { pt, whatW: pt >= 9 ? 40 : 36 };
    if (sectionsHeight(doc, sections, width, layout) <= room) break;
  }

  sections.forEach((s, si) => {
    const head = heads.get(s.title) ?? null;
    if (head) doc.addImage(head.url, 'PNG', left - 0.5, y, 6 * head.ratio, 6);
    else {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(STAMP);
      doc.text(toWinAnsi(s.title), left, y + 4.6);
    }
    y += 7.5;
    const top = y;
    doc.setFontSize(layout.pt);
    doc.setTextColor(INK);
    for (const row of s.rows) {
      doc.setFont('helvetica', 'bold');
      const what = doc.splitTextToSize(toWinAnsi(row.what), layout.whatW) as string[];
      doc.text(what, left + 2.5, y + lineH(layout.pt) + 0.6);
      doc.setFont('helvetica', 'normal');
      const does = doc.splitTextToSize(toWinAnsi(row.does), width - layout.whatW - 8) as string[];
      doc.text(does, left + layout.whatW + 5, y + lineH(layout.pt) + 0.6);
      y += Math.max(what.length, does.length) * lineH(layout.pt) + 1.4;
    }
    pencilFrame(doc, left, top - 1, width, y - top + 2, si * 7 + (left > HALF ? 31 : 3), PENCIL);
    y += 5;
  });

  // Who to ask: filled in, or a line to write on.
  const fy = PAGE_H - MARGIN - 3;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(PENCIL);
  const ask = toWinAnsi('Fragen? ');
  const askW = doc.getTextWidth(ask);
  if (opts.contact?.trim()) {
    // A long name with two numbers takes two lines (the footer has room for them), not a cut-off number.
    const lines = (doc.splitTextToSize(toWinAnsi(opts.contact.trim()), width - askW) as string[]).slice(0, CONTACT_LINES);
    const y0 = fy - (lines.length - 1) * lineH(8.5);
    doc.text(ask, left, y0);
    doc.setTextColor(INK);
    doc.text(lines, left + askW, y0, { lineHeightFactor: 1.19 });
  } else {
    doc.text(ask, left, fy);
    doc.setDrawColor(PENCIL);
    doc.setLineWidth(0.25);
    doc.line(left + askW + 1, fy + 0.8, left + width, fy + 0.8);
  }
  doc.setTextColor(INK);
}

export async function manualPdf(sections: ManualSection[], opts: ManualPdfOptions): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  await fontsReady();
  const title = drawn(opts.title, INK, 72);
  const heads = new Map(sections.map((s) => [s.title, drawn(s.title, STAMP, 56, MARKER)] as const));
  drawCard(doc, MARGIN, sections, opts, title, heads);
  drawCard(doc, HALF + MARGIN, sections, opts, title, heads);
  // Where to cut: a dashed line down the middle.
  doc.setDrawColor(PENCIL);
  doc.setLineWidth(0.2);
  doc.setLineDashPattern([2, 2], 0);
  doc.line(HALF, 6, HALF, PAGE_H - 6);
  doc.setLineDashPattern([], 0);
  doc.setFontSize(7);
  doc.setTextColor(PENCIL);
  doc.text(toWinAnsi('hier durchschneiden'), HALF + 1.2, PAGE_H - 7, { angle: 90 });
  return doc.output('blob');
}
