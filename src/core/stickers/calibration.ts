/**
 * Printer calibration for label sheets and the printable test page.
 *
 * Home printers rarely put the image exactly where the PDF says: typical
 * offsets are 0.5–2 mm, and some printers scale by a fraction of a percent.
 * A Calibration is a correction applied to everything we print:
 *
 *   x' = cx + (x - cx) * scaleX + offsetXMm      (cx = page centre)
 *   y' = cy + (y - cy) * scaleY + offsetYMm
 *
 * Positive offsets move the print right/down. Scaling is about the page centre,
 * so changing the scale does not shift the middle of the sheet.
 *
 * The jsPDF helpers at the end are shared with pdf.ts.
 */

import type { jsPDF } from 'jspdf';
import { canvasToBlob, createCanvas, get2d, type Context2D } from './image';
import { slotRects, type RectMm, type SlotRect } from './slots';
import { MM_PER_INCH, type LabelGeometry, type LabelTemplate, type PageSize } from './templates';

export interface Calibration {
  offsetXMm: number;
  offsetYMm: number;
  /** 1 = no scaling. */
  scaleX?: number;
  scaleY?: number;
}

export const NO_CALIBRATION: Readonly<Calibration> = Object.freeze({ offsetXMm: 0, offsetYMm: 0 });

/** Calibrations by `calibrationKey(printer, templateId)`; plain JSON, safe to persist. */
export type CalibrationStore = Record<string, Calibration>;

/** Template id used for a printer-wide fallback calibration. */
export const ANY_TEMPLATE = '*';

export function calibrationKey(printer: string, templateId: string): string {
  const p = printer.trim().replace(/\s+/g, ' ').toLowerCase() || 'standard';
  return `${p}::${templateId}`;
}

/** Exact printer + template entry, else the printer-wide entry, else no correction. */
export function getCalibration(store: Readonly<CalibrationStore>, printer: string, templateId: string): Calibration {
  return store[calibrationKey(printer, templateId)] ?? store[calibrationKey(printer, ANY_TEMPLATE)] ?? { ...NO_CALIBRATION };
}

/** Returns a new store; an identity calibration removes the entry. */
export function setCalibration(
  store: Readonly<CalibrationStore>,
  printer: string,
  templateId: string,
  calibration: Calibration,
): CalibrationStore {
  const key = calibrationKey(printer, templateId);
  const next: CalibrationStore = { ...store };
  const tidy = tidyCalibration(calibration);
  if (isIdentityCalibration(tidy)) delete next[key];
  else next[key] = tidy;
  return next;
}

export function normalizeCalibration(cal?: Partial<Calibration> | null): Required<Calibration> {
  const num = (v: number | undefined, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const scale = (v: number | undefined) => {
    const s = num(v, 1);
    return s > 0 ? s : 1;
  };
  return {
    offsetXMm: num(cal?.offsetXMm, 0),
    offsetYMm: num(cal?.offsetYMm, 0),
    scaleX: scale(cal?.scaleX),
    scaleY: scale(cal?.scaleY),
  };
}

export function isIdentityCalibration(cal?: Partial<Calibration> | null): boolean {
  const c = normalizeCalibration(cal);
  return c.offsetXMm === 0 && c.offsetYMm === 0 && c.scaleX === 1 && c.scaleY === 1;
}

export interface CalibrationTransform {
  readonly scaleX: number;
  readonly scaleY: number;
  x(v: number): number;
  y(v: number): number;
  rect(r: RectMm): RectMm;
}

export function calibrationTransform(cal: Partial<Calibration> | null | undefined, page: PageSize): CalibrationTransform {
  const c = normalizeCalibration(cal);
  const cx = page.widthMm / 2;
  const cy = page.heightMm / 2;
  const x = (v: number) => cx + (v - cx) * c.scaleX + c.offsetXMm;
  const y = (v: number) => cy + (v - cy) * c.scaleY + c.offsetYMm;
  return {
    scaleX: c.scaleX,
    scaleY: c.scaleY,
    x,
    y,
    rect: (r) => ({ x: x(r.x), y: y(r.y), width: r.width * c.scaleX, height: r.height * c.scaleY }),
  };
}

export function applyCalibration(rect: RectMm, cal: Partial<Calibration> | null | undefined, page: PageSize): RectMm {
  return calibrationTransform(cal, page).rect(rect);
}

export function calibratedSlotRects(template: LabelTemplate, cal?: Partial<Calibration> | null): SlotRect[] {
  const tf = calibrationTransform(cal, template.page);
  return slotRects(template).map((s) => ({ ...s, ...tf.rect(s) }));
}

/** Numbers read on the test page rulers: where the real label edge lies, in mm. */
export interface RulerReading {
  /** Horizontal ruler (crossing the left edge of label 1, or the right edge of the last label). */
  x: number;
  /** Vertical ruler (crossing the top edge of label 1, or the bottom edge of the last label). */
  y: number;
}

/**
 * New calibration from the ruler readings of a test page printed with
 * `current`. With only the top-left reading the offsets change; with both
 * readings the scale is corrected as well. A bottom-right value left out
 * (undefined) leaves the scale of that axis as it is.
 */
export function calibrationFromReadings(
  template: LabelTemplate,
  current: Partial<Calibration> | null | undefined,
  topLeft: RulerReading,
  bottomRight?: Partial<RulerReading>,
): Calibration {
  const cal = normalizeCalibration(current);
  const rects = slotRects(template);
  const first = rects[0];
  const last = rects[rects.length - 1];
  if (!first || !last) return tidyCalibration(cal);
  const solve = (e1: number, e2: number, r1: number, r2: number | undefined, s: number, o: number, c: number) => {
    // Printer + current correction is affine: T(x) = m·x + n. The readings say T(e1 + r1) = e1 and
    // T(e2 + r2) = e2, so m = (e2 - e1) / (e2 + r2 - e1 - r1). The new scale cancels m, the new
    // offset makes T'(e1) = e1.
    const read1 = Number.isFinite(r1) ? r1 : 0;
    let s2 = s;
    const span = e2 - e1;
    if (r2 !== undefined && Number.isFinite(r2) && span > 1) {
      const printed = span + r2 - read1;
      if (printed > 0) s2 = (s * printed) / span;
    }
    return { scale: s2, offset: o + (e1 + read1 - c) * s - (e1 - c) * s2 };
  };
  const cx = template.page.widthMm / 2;
  const cy = template.page.heightMm / 2;
  const sx = solve(first.x, last.x + last.width, topLeft.x, bottomRight?.x, cal.scaleX, cal.offsetXMm, cx);
  const sy = solve(first.y, last.y + last.height, topLeft.y, bottomRight?.y, cal.scaleY, cal.offsetYMm, cy);
  return tidyCalibration({ offsetXMm: sx.offset, offsetYMm: sy.offset, scaleX: sx.scale, scaleY: sy.scale });
}

/**
 * The readings typed into the four fields (label 1: x, y; last label: x, y),
 * undefined where a field is empty. An empty field at label 1 counts as 0
 * (the edge lies on the zero). An empty field at the last label means "not
 * read", so that axis keeps its scale: it must not count as 0, which would
 * claim the last label sits exactly and invent a scale from the first reading.
 * Null when nothing was entered at all.
 */
export function readingsFromFields(
  values: readonly (number | undefined)[],
): { topLeft: RulerReading; bottomRight?: Partial<RulerReading> } | null {
  const [x, y, x2, y2] = values;
  if ([x, y, x2, y2].every((v) => v === undefined)) return null;
  const topLeft = { x: x ?? 0, y: y ?? 0 };
  return x2 === undefined && y2 === undefined ? { topLeft } : { topLeft, bottomRight: { x: x2, y: y2 } };
}

/** "waagerecht +1,0 mm, senkrecht –0,5 mm", plus the scale when there is one. */
export function describeCalibration(cal: Partial<Calibration> | null | undefined): string {
  const c = normalizeCalibration(cal);
  const scale = c.scaleX !== 1 || c.scaleY !== 1 ? `, Maßstab ${formatPercent(c.scaleX)} / ${formatPercent(c.scaleY)}` : '';
  return `waagerecht ${formatSignedMm(c.offsetXMm)} mm, senkrecht ${formatSignedMm(c.offsetYMm)} mm${scale}`;
}

/**
 * From about this far off in size (1 %) a correction is not saved silently.
 * A printer itself is rarely off by more than half a percent; 2–6 % come from
 * the print dialog ("An Seite anpassen", Letter instead of A4, borderless),
 * and the dialog can be set differently next time (sticker audit 16.10.2026).
 */
export const SCALE_WARN = 0.01;

export interface ScaleOff {
  /** How far the printed size is off, in whole percent (at least 1). */
  percent: number;
  /** true: the print comes out smaller than it should. */
  smaller: boolean;
}

/**
 * How far the print is off in size when `cal` makes it fit, if that is about
 * 1 % or more on one axis; else null. A scale s corrects a print of 1/s.
 */
export function scaleOff(cal: Partial<Calibration> | null | undefined): ScaleOff | null {
  const c = normalizeCalibration(cal);
  const printed = [1 / c.scaleX, 1 / c.scaleY];
  const worst = printed.reduce((a, b) => (Math.abs(b - 1) > Math.abs(a - 1) ? b : a));
  // Rounded to a tenth of a percent: 2.5 mm over the 254 mm of a HERMA sheet is 0.98 %, about 1 %.
  if (Math.round(Math.abs(worst - 1) * 1000) < SCALE_WARN * 1000) return null;
  return { percent: Math.max(1, Math.round(Math.abs(worst - 1) * 100)), smaller: worst < 1 };
}

/** The warning for a print that is off in size: the print dialog scales, so set it to 100 % and print again. */
export function scaleWarning(off: ScaleOff): string {
  return (
    `Dein Drucker druckt etwa ${off.percent} % ${off.smaller ? 'zu klein' : 'zu groß'}. ` +
    'Das macht fast immer der Druckdialog, etwa mit „An Seite anpassen“ oder dem Papierformat Letter. ' +
    'Stelle dort „Tatsächliche Größe“ oder 100 % und A4 ein und drucke die Testseite noch einmal.'
  );
}

/** German messages for implausible values; an empty list means the calibration looks fine. */
export function validateCalibration(cal: Partial<Calibration>): string[] {
  const problems: string[] = [];
  const finite = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v));
  if (![cal.offsetXMm, cal.offsetYMm, cal.scaleX, cal.scaleY].every(finite)) {
    return ['Die Korrektur enthält keine gültige Zahl. Gib die Werte in Millimetern ein, z. B. 1,5 oder -0,5.'];
  }
  const c = normalizeCalibration(cal);
  if (Math.abs(c.offsetXMm) > 15 || Math.abs(c.offsetYMm) > 15) {
    problems.push('Die Verschiebung ist größer als 15 mm. Prüfe, ob der Drucker mit „Tatsächliche Größe“ (100 %) druckt.');
  }
  const off = scaleOff(c);
  if (off) problems.push(scaleWarning(off));
  return problems;
}

function tidyCalibration(cal: Partial<Calibration>): Calibration {
  const c = normalizeCalibration(cal);
  const out: Calibration = { offsetXMm: round(c.offsetXMm, 100), offsetYMm: round(c.offsetYMm, 100) };
  const sx = round(c.scaleX, 1e5);
  const sy = round(c.scaleY, 1e5);
  if (sx !== 1) out.scaleX = sx;
  if (sy !== 1) out.scaleY = sy;
  return out;
}

function round(v: number, factor: number): number {
  const r = Math.round(v * factor) / factor;
  return Object.is(r, -0) ? 0 : r;
}

// ---------------------------------------------------------------------------
// Test page

export const TEST_PAGE_INSTRUCTIONS =
  'Drucke diese Seite auf normales Papier mit „Tatsächliche Größe“ oder 100 %. ' +
  'Lege sie gegen das Licht auf einen Etikettenbogen. ' +
  'Liegen die Linien nicht genau auf den Etikettenrändern, miss den Versatz und trage ihn ein.';

export interface TestPageOptions {
  /** Deflate content streams (default true). Tests turn it off to read the drawing commands. */
  compress?: boolean;
}

const RULER_HALF_MM = 6;

/**
 * What the test page is drawn with: the PDF (jsPDF) or a picture of the page
 * (canvas) for "Testseite drucken", which goes to the printer the way the
 * stickers do (features/stickers/print.ts). Lengths in mm, text sizes in pt.
 */
export interface TestPagePen {
  lineWidth(mm: number): void;
  line(x1: number, y1: number, x2: number, y2: number): void;
  circle(cx: number, cy: number, r: number): void;
  /** Outline of a label at an already calibrated rectangle. */
  labelShape(r: RectMm, label: LabelGeometry, scale: { scaleX: number; scaleY: number }): void;
  /** A white area, with a thin outline when `outline`. */
  whiteBox(x: number, y: number, width: number, height: number, outline: boolean): void;
  font(sizePt: number, bold: boolean): void;
  textWidth(text: string): number;
  /** `text` broken into lines no wider than `width`. */
  split(text: string, width: number): string[];
  /**
   * Text in the current font. Turned (angle 90: running upwards), it starts
   * at x, y on its baseline; align and baseline then do not apply.
   */
  text(text: string, x: number, y: number, options?: { align?: 'left' | 'center' | 'right'; baseline?: 'top' | 'middle'; angle?: 0 | 90 }): void;
}

/**
 * A test page: label outlines as thin lines, a crosshair in every label,
 * label numbers, millimetre rulers across the edges of the first and the last
 * label, a 10 cm line to measure the size, and German instructions. Printed
 * with `calibration` applied, so it also verifies a correction.
 */
export async function buildTestPagePdf(
  template: LabelTemplate,
  calibration: Partial<Calibration> = NO_CALIBRATION,
  options: TestPageOptions = {},
): Promise<Blob> {
  const doc = await createPdfDocument(
    template.page,
    { title: `Testseite – ${template.name}`, subject: 'Druckversatz prüfen' },
    options.compress ?? true,
  );
  doc.setDrawColor(0, 0, 0);
  doc.setTextColor(0, 0, 0);
  drawTestPage(pdfPen(doc), template, calibration);
  return doc.output('blob');
}

/**
 * The test page as a picture of the whole page (PNG, `dpi`), for printing it
 * the way the stickers are printed: a test page that went another way than
 * the stickers may be scaled differently, and a correction measured on it
 * would then put the stickers off (sticker audit 16.10.2026). Browser only.
 */
export async function testPagePicture(template: LabelTemplate, calibration: Partial<Calibration> = NO_CALIBRATION, dpi = 300): Promise<Blob> {
  const k = dpi / MM_PER_INCH;
  const canvas = createCanvas(template.page.widthMm * k, template.page.heightMm * k);
  const ctx = get2d(canvas);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawTestPage(canvasPen(ctx, canvas.width / template.page.widthMm), template, calibration);
  return canvasToBlob(canvas, 'image/png');
}

/** The test page drawn with any pen (see buildTestPagePdf). */
export function drawTestPage(pen: TestPagePen, template: LabelTemplate, calibration: Partial<Calibration> = NO_CALIBRATION): void {
  const tf = calibrationTransform(calibration, template.page);
  const rects = slotRects(template);

  pen.lineWidth(0.1);
  for (const r of rects) {
    pen.labelShape(tf.rect(r), template.label, tf);
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    pen.line(tf.x(cx - 4), tf.y(cy), tf.x(cx + 4), tf.y(cy));
    pen.line(tf.x(cx), tf.y(cy - 4), tf.x(cx), tf.y(cy + 4));
    pen.circle(tf.x(cx), tf.y(cy), 1);
    pen.font(6, true);
    pen.text(String(r.index + 1), tf.x(cx + 6), tf.y(cy + 6), { align: 'center', baseline: 'middle' });
  }

  const first = rects[0];
  const last = rects[rects.length - 1];
  if (first && last) {
    // Captions only where the label leaves room next to the crosshair.
    const xCaption = template.label.widthMm >= 40 ? 'waagerecht' : null;
    const yCaption = template.label.heightMm >= 40 ? 'senkrecht' : null;
    const fcx = first.x + first.width / 2;
    const fcy = first.y + first.height / 2;
    drawRuler(pen, tf, 'x', first.x, fcy, -1, xCaption, 1);
    drawRuler(pen, tf, 'y', first.y, fcx, 1, yCaption, 1);
    const lcx = last.x + last.width / 2;
    const lcy = last.y + last.height / 2;
    drawRuler(pen, tf, 'x', last.x + last.width, lcy, -1, xCaption, -1);
    drawRuler(pen, tf, 'y', last.y + last.height, lcx, 1, yCaption, -1);
  }

  drawInstructions(pen, template, rects, calibration);
  const measure = measureLinePlacement(template);
  if (measure) drawMeasureLine(pen, tf, measure);
}

/**
 * Ruler across a label edge. Tick k sits k millimetres from the expected edge;
 * the number at the real edge is the correction to enter (see
 * calibrationFromReadings). `inward` is +1 when the label lies on the
 * positive side of the edge, -1 otherwise (used for the caption).
 */
function drawRuler(
  pen: TestPagePen,
  tf: CalibrationTransform,
  axis: 'x' | 'y',
  edge: number,
  across: number,
  tickSide: 1 | -1,
  caption: string | null,
  inward: 1 | -1,
): void {
  const pt = (along: number, off: number): [number, number] =>
    axis === 'x' ? [tf.x(along), tf.y(across + off)] : [tf.x(across + off), tf.y(along)];
  const seg = (a1: number, o1: number, a2: number, o2: number) => {
    const [x1, y1] = pt(a1, o1);
    const [x2, y2] = pt(a2, o2);
    pen.line(x1, y1, x2, y2);
  };
  pen.lineWidth(0.08);
  seg(edge - RULER_HALF_MM, 0, edge + RULER_HALF_MM, 0);
  const steps = RULER_HALF_MM * 2;
  pen.font(4, false);
  for (let k = -steps; k <= steps; k++) {
    const mm = k / 2;
    const len = k === 0 ? 3 : k % 10 === 0 ? 2.2 : k % 2 === 0 ? 1.4 : 0.8;
    seg(edge + mm, 0, edge + mm, tickSide * len);
    if (k % 4 === 0) {
      const label = mm === 0 ? '0' : mm > 0 ? `+${mm}` : `–${-mm}`;
      const [tx, ty] = pt(edge + mm, -tickSide * 1.6);
      // White backing so the label outline does not strike through the numbers.
      const w = pen.textWidth(label) + 0.3;
      const h = 4 * PT_MM;
      pen.whiteBox(tx - w / 2, ty - h / 2, w, h, false);
      pen.text(label, tx, ty, { align: 'center', baseline: 'middle' });
    }
  }
  if (caption) {
    // Horizontal rulers: the caption continues the ruler line into the label. Vertical rulers: beside
    // the inner end of the ruler, next to the ticks, so text below the ruler (instructions) stays clear.
    const [cx, cy] =
      axis === 'x' ? pt(edge + inward * (RULER_HALF_MM + 1), 0) : pt(edge + inward * (RULER_HALF_MM - 1), tickSide * 3.6);
    const forward = axis === 'x' ? inward : tickSide;
    pen.text(caption, cx, cy, { align: forward > 0 ? 'left' : 'right', baseline: 'middle' });
  }
  pen.lineWidth(0.1);
}

/**
 * Where the rulers of drawRuler reach, with their numbers: kept free of the
 * measuring line. Template mm, without the calibration.
 */
function rulerZones(rects: readonly SlotRect[]): RectMm[] {
  const first = rects[0];
  const last = rects[rects.length - 1];
  if (!first || !last) return [];
  const reach = RULER_HALF_MM + 0.5;
  // Horizontal rulers: ticks up to 3 mm above the line, numbers 1.6 mm below it. Vertical ones: ticks right, numbers left.
  const across = (edge: number, at: number): RectMm => ({ x: edge - reach, y: at - 3.5, width: 2 * reach, height: 5.5 });
  const along = (edge: number, at: number): RectMm => ({ x: at - 3, y: edge - reach, width: 6.5, height: 2 * reach });
  return [
    across(first.x, first.y + first.height / 2),
    along(first.y, first.x + first.width / 2),
    across(last.x + last.width, last.y + last.height / 2),
    along(last.y + last.height, last.x + last.width / 2),
  ];
}

interface Paragraph {
  text: string;
  bold?: boolean;
}

function drawInstructions(
  pen: TestPagePen,
  template: LabelTemplate,
  rects: SlotRect[],
  calibration: Partial<Calibration>,
): void {
  const cal = normalizeCalibration(calibration);
  const n = rects.length;
  const paragraphs: Paragraph[] = [
    { text: `Testseite: ${template.name}`, bold: true },
    { text: TEST_PAGE_INSTRUCTIONS },
    {
      text:
        (n > 1 ? `Die Skalen an Etikett 1 und ${n} zeigen Millimeter. ` : 'Die Skalen zeigen Millimeter. ') +
        (isIdentityCalibration(cal)
          ? 'Lies an der echten Etikettenkante die Zahl ab und trage sie ein.'
          : 'Lies an der echten Etikettenkante die Zahl ab und trage sie ein; sie wird zur aktuellen Korrektur dazugerechnet.'),
    },
    { text: `Aktuelle Korrektur: ${describeCalibration(cal)}.` },
  ];
  if (!template.verified) {
    paragraphs.push({ text: 'Die Maße dieser Vorlage sind noch nicht mit einem echten Bogen geprüft.' });
  }

  const { region, boxed } = instructionRegion(template, rects);
  const fitted = fitParagraphs(pen, paragraphs, region.width, region.height, 7, 4.5);
  if (boxed) {
    const pad = INSTRUCTION_PAD_MM;
    pen.lineWidth(0.1);
    pen.whiteBox(region.x - pad, region.y - pad, region.width + 2 * pad, fitted.height + 2 * pad, true);
  }
  pen.font(fitted.sizePt, false);
  let y = region.y;
  for (const l of fitted.lines) {
    pen.font(fitted.sizePt, l.bold);
    pen.text(l.text, region.x, y, { baseline: 'top' });
    y += fitted.lineHeightMm;
  }
}

/** White border around the instructions where they stand in a box. */
const INSTRUCTION_PAD_MM = 2;

/** Free area for the instructions: a page margin, the upper half of a label, or a box in the middle. */
function instructionRegion(template: LabelTemplate, rects: SlotRect[]): { region: RectMm; boxed: boolean } {
  const { widthMm: pw, heightMm: ph } = template.page;
  const edge = PAGE_EDGE_MM;
  const rulerZone = RULER_HALF_MM + 1.5;
  const top = Math.min(...rects.map((r) => r.y));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  const bands: RectMm[] = [
    { x: edge + 4, y: edge, width: pw - 2 * edge - 8, height: top - rulerZone - edge },
    { x: edge + 4, y: bottom + rulerZone, width: pw - 2 * edge - 8, height: ph - edge - bottom - rulerZone },
  ];
  for (const b of bands) if (b.height >= 14 && b.width >= 60) return { region: b, boxed: false };

  if (template.label.shape === 'rect') {
    const slot = rects[Math.floor((rects.length - 1) / 2)];
    // The first and last labels carry rulers that reach 6 mm into the label.
    const hasRulers = slot === rects[0] || slot === rects[rects.length - 1];
    const inset = hasRulers ? rulerZone : 3;
    const region = {
      x: slot.x + inset,
      y: slot.y + inset,
      width: slot.width - 2 * inset,
      height: slot.height / 2 - 5 - inset,
    };
    if (region.height >= 12 && region.width >= 40) return { region, boxed: false };
  }
  const width = Math.min(pw - 30, 150);
  const height = Math.min(ph - 30, 45);
  return { region: { x: (pw - width) / 2, y: (ph - height) / 2, width, height }, boxed: true };
}

interface FittedText {
  lines: { text: string; bold: boolean }[];
  sizePt: number;
  lineHeightMm: number;
  height: number;
}

function fitParagraphs(pen: TestPagePen, paragraphs: Paragraph[], width: number, height: number, maxPt: number, minPt: number): FittedText {
  let result: FittedText | undefined;
  for (let pt = maxPt; pt >= minPt - 1e-9; pt -= 0.5) {
    const lines: { text: string; bold: boolean }[] = [];
    for (const p of paragraphs) {
      pen.font(pt, !!p.bold);
      for (const text of pen.split(p.text, width)) lines.push({ text, bold: !!p.bold });
    }
    const lineHeightMm = pt * PT_MM * 1.25;
    result = { lines, sizePt: pt, lineHeightMm, height: lines.length * lineHeightMm };
    if (result.height <= height) break;
  }
  return result!;
}

/* ---------------------------------------------------------------- the 10 cm line */

/** Most home printers cannot print the outermost few millimetres of a page. */
const PAGE_EDGE_MM = 6;

/** The measuring line: 10 cm, or 5 cm where 10 do not fit (the SELPHY page). */
const MEASURE_LENGTHS_MM = [100, 50];

/** Room the line takes across: its ticks and the sentence beside it. */
const MEASURE_THICK_MM = 5.5;

/** Labels keep this much room from the line. */
const MEASURE_CLEAR_MM = 1;

export interface MeasureLine {
  axis: 'x' | 'y';
  /** Start of the line (left end, or lower end of an upright line), template mm. */
  x: number;
  y: number;
  lengthMm: number;
}

/**
 * Where the measuring line fits without touching a label, a ruler or the
 * instructions: across in the margin above or below the labels or between two
 * rows, else upright in a side margin or between two columns. Null when
 * nothing is free (labels up to the page edge, as on the SELPHY page).
 */
export function measureLinePlacement(template: LabelTemplate): MeasureLine | null {
  const rects = slotRects(template);
  if (!rects.length) return null;
  const { widthMm: pw, heightMm: ph } = template.page;
  const instructions = instructionRegion(template, rects);
  const obstacles = [
    ...rects.map((r) => grow(r, MEASURE_CLEAR_MM)),
    ...rulerZones(rects),
    grow(instructions.region, instructions.boxed ? INSTRUCTION_PAD_MM : 0.5),
  ];
  const xs = unique(rects.map((r) => r.x)).sort((a, b) => a - b);
  const ys = unique(rects.map((r) => r.y)).sort((a, b) => a - b);
  const { label } = template;
  // Free strips between the page edge band, the rows and the columns: [from, to].
  const strips = (starts: number[], size: number, page: number): [number, number][] => {
    const out: [number, number][] = [[PAGE_EDGE_MM, starts[0]]];
    for (let i = 1; i < starts.length; i++) out.push([starts[i - 1] + size, starts[i]]);
    out.push([starts[starts.length - 1] + size, page - PAGE_EDGE_MM]);
    return out;
  };
  for (const lengthMm of MEASURE_LENGTHS_MM) {
    const candidates: MeasureLine[] = [];
    // Across a strip: in its middle, else close to one of its sides (a ruler may reach into the middle).
    const spots = (from: number, to: number) => [(from + to) / 2, from + 0.5 + MEASURE_THICK_MM / 2, to - 0.5 - MEASURE_THICK_MM / 2];
    if (lengthMm <= pw - 2 * PAGE_EDGE_MM) {
      for (const [from, to] of strips(ys, label.heightMm, ph)) {
        // The sentence sits above the line.
        for (const mid of spots(from, to)) candidates.push({ axis: 'x', x: (pw - lengthMm) / 2, y: mid + MEASURE_THICK_MM / 2 - 1.5, lengthMm });
      }
    }
    if (lengthMm <= ph - 2 * PAGE_EDGE_MM) {
      for (const [from, to] of strips(xs, label.widthMm, pw)) {
        // The sentence sits left of the line.
        for (const mid of spots(from, to)) candidates.push({ axis: 'y', x: mid + MEASURE_THICK_MM / 2 - 1.5, y: (ph + lengthMm) / 2, lengthMm });
      }
    }
    const fits = candidates.find((c) => {
      const box = measureBox(c);
      return (
        box.x >= PAGE_EDGE_MM - 1e-9 &&
        box.y >= PAGE_EDGE_MM - 1e-9 &&
        box.x + box.width <= pw - PAGE_EDGE_MM + 1e-9 &&
        box.y + box.height <= ph - PAGE_EDGE_MM + 1e-9 &&
        !obstacles.some((o) => rectsOverlap(box, o))
      );
    });
    if (fits) return fits;
  }
  return null;
}

/** Everything the measuring line draws: the line, its ticks, and the sentence above it or to its left. */
export function measureBox(m: MeasureLine): RectMm {
  return m.axis === 'x'
    ? { x: m.x - 0.5, y: m.y - (MEASURE_THICK_MM - 1.5), width: m.lengthMm + 1, height: MEASURE_THICK_MM }
    : { x: m.x - (MEASURE_THICK_MM - 1.5), y: m.y - m.lengthMm - 0.5, width: MEASURE_THICK_MM, height: m.lengthMm + 1 };
}

/** The question printed with the line. */
export function measureLineText(lengthMm: number): string {
  return `Ist diese Linie genau ${lengthMm / 10} cm lang? Sonst stelle im Druckdialog 100 % ein.`;
}

/**
 * The measuring line, with a tick every centimetre. It moves with the
 * calibration but keeps its length: it tells how big the printer and its
 * dialog print, before any correction (a correction of the size is what it
 * is there to make unnecessary).
 */
function drawMeasureLine(pen: TestPagePen, tf: CalibrationTransform, m: MeasureLine): void {
  const x0 = tf.x(m.x);
  const y0 = tf.y(m.y);
  const cm = m.lengthMm / 10;
  pen.lineWidth(0.2);
  if (m.axis === 'x') {
    pen.line(x0, y0, x0 + m.lengthMm, y0);
    pen.lineWidth(0.12);
    for (let i = 0; i <= cm; i++) {
      const end = i === 0 || i === cm;
      pen.line(x0 + i * 10, y0 - (end ? 1.5 : 0.8), x0 + i * 10, y0 + (end ? 1.5 : 0));
    }
  } else {
    pen.line(x0, y0, x0, y0 - m.lengthMm);
    pen.lineWidth(0.12);
    for (let i = 0; i <= cm; i++) {
      const end = i === 0 || i === cm;
      pen.line(x0 - (end ? 1.5 : 0.8), y0 - i * 10, x0 + (end ? 1.5 : 0), y0 - i * 10);
    }
  }
  pen.lineWidth(0.1);
  const text = measureLineText(m.lengthMm);
  let size = 6;
  pen.font(size, false);
  while (size > 4.5 && pen.textWidth(text) > m.lengthMm - 4) {
    size -= 0.5;
    pen.font(size, false);
  }
  const w = pen.textWidth(text);
  if (m.axis === 'x') pen.text(text, x0 + m.lengthMm / 2, y0 - 1.6, { align: 'center' });
  else pen.text(text, x0 - 1.6, y0 - (m.lengthMm - w) / 2, { angle: 90 });
}

function grow(r: RectMm, by: number): RectMm {
  return { x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by };
}

function rectsOverlap(a: RectMm, b: RectMm): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function unique(values: number[]): number[] {
  return [...new Set(values.map((v) => Math.round(v * 1e4) / 1e4))];
}

/* ---------------------------------------------------------------- pens */

/** The jsPDF pen: black lines and text, the standard font (see toWinAnsi). */
function pdfPen(doc: jsPDF): TestPagePen {
  return {
    lineWidth: (mm) => doc.setLineWidth(mm),
    line: (x1, y1, x2, y2) => doc.line(x1, y1, x2, y2),
    circle: (cx, cy, r) => doc.circle(cx, cy, r, 'S'),
    labelShape: (r, label, scale) => drawLabelShape(doc, r, label, scale, 'S'),
    whiteBox: (x, y, width, height, outline) => {
      doc.setFillColor(255, 255, 255);
      doc.rect(x, y, width, height, outline ? 'FD' : 'F');
    },
    font: (sizePt, bold) => {
      doc.setFont('helvetica', bold ? 'bold' : 'normal');
      doc.setFontSize(sizePt);
    },
    textWidth: (text) => doc.getTextWidth(toWinAnsi(text)),
    split: (text, width) => {
      const split: unknown = doc.splitTextToSize(toWinAnsi(text), width);
      return Array.isArray(split) ? split.map(String) : [String(split)];
    },
    text: (text, x, y, options = {}) => {
      if (options.angle) doc.text(toWinAnsi(text), x, y, { angle: options.angle });
      else doc.text(toWinAnsi(text), x, y, { align: options.align, baseline: options.baseline });
    },
  };
}

/** Font of the test page as a picture: the PDF's Helvetica, or what the system has like it. */
const CANVAS_FONT = 'Helvetica, Arial, "Liberation Sans", "DejaVu Sans", sans-serif';

/**
 * A pen on a canvas of `pxPerMm`: the test page as a picture, white, black
 * lines no thinner than one pixel.
 */
export function canvasPen(ctx: Context2D, pxPerMm: number): TestPagePen {
  const k = pxPerMm;
  let width = 0.1;
  let fontPx = 0;
  ctx.strokeStyle = '#000000';
  ctx.fillStyle = '#000000';
  ctx.lineCap = 'butt';
  const stroke = () => {
    ctx.lineWidth = Math.max(1, width * k);
    ctx.stroke();
  };
  const measure = (text: string) => ctx.measureText(text).width / k;
  return {
    lineWidth: (mm) => {
      width = mm;
    },
    line: (x1, y1, x2, y2) => {
      ctx.beginPath();
      ctx.moveTo(x1 * k, y1 * k);
      ctx.lineTo(x2 * k, y2 * k);
      stroke();
    },
    circle: (cx, cy, r) => {
      ctx.beginPath();
      ctx.arc(cx * k, cy * k, r * k, 0, Math.PI * 2);
      stroke();
    },
    labelShape: (r, label, scale) => {
      ctx.beginPath();
      if (label.shape === 'round') {
        ctx.ellipse((r.x + r.width / 2) * k, (r.y + r.height / 2) * k, (r.width / 2) * k, (r.height / 2) * k, 0, 0, Math.PI * 2);
      } else {
        const rad = Math.min(label.cornerRadiusMm * Math.min(scale.scaleX, scale.scaleY), r.width / 2, r.height / 2) * k;
        const [l, t, w, h] = [r.x * k, r.y * k, r.width * k, r.height * k];
        if (rad <= 0) ctx.rect(l, t, w, h);
        else {
          // arcTo instead of roundRect: older WebKitGTK versions lack roundRect.
          ctx.moveTo(l + rad, t);
          ctx.arcTo(l + w, t, l + w, t + h, rad);
          ctx.arcTo(l + w, t + h, l, t + h, rad);
          ctx.arcTo(l, t + h, l, t, rad);
          ctx.arcTo(l, t, l + w, t, rad);
          ctx.closePath();
        }
      }
      stroke();
    },
    whiteBox: (x, y, w, h, outline) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x * k, y * k, w * k, h * k);
      ctx.fillStyle = '#000000';
      if (outline) {
        ctx.beginPath();
        ctx.rect(x * k, y * k, w * k, h * k);
        stroke();
      }
    },
    font: (sizePt, bold) => {
      fontPx = sizePt * PT_MM * k;
      ctx.font = `${bold ? 'bold ' : ''}${fontPx.toFixed(2)}px ${CANVAS_FONT}`;
    },
    textWidth: measure,
    split: (text, maxWidth) => {
      const lines: string[] = [];
      let line = '';
      for (const word of text.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (line && measure(next) > maxWidth) {
          lines.push(line);
          line = word;
        } else line = next;
      }
      if (line) lines.push(line);
      return lines;
    },
    text: (text, x, y, options = {}) => {
      ctx.save();
      if (options.angle) {
        ctx.translate(x * k, y * k);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(text, 0, 0);
      } else {
        ctx.textAlign = options.align ?? 'left';
        ctx.textBaseline = options.baseline ?? 'alphabetic';
        ctx.fillText(text, x * k, y * k);
      }
      ctx.restore();
    },
  };
}

/** "+1,5", "–0,5", "0,0" (German decimal comma, en dash as minus). */
export function formatSignedMm(v: number): string {
  const r = round(v, 10);
  const s = Math.abs(r).toFixed(1).replace('.', ',');
  return r > 0 ? `+${s}` : r < 0 ? `–${s}` : s;
}

function formatPercent(scale: number): string {
  return `${(scale * 100).toFixed(2).replace('.', ',')} %`;
}

// ---------------------------------------------------------------------------
// jsPDF helpers shared with pdf.ts

/** One PostScript point in millimetres. */
export const PT_MM = 25.4 / 72;

/** Characters Windows-1252 (the PDF WinAnsiEncoding) has in 0x80–0x9F, by code point. */
const WIN_ANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018,
  0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

const WIN_ANSI_SUBSTITUTES: Record<string, string> = {
  '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '≥': '>=', '≤': '<=', '≠': '!=', '≈': '~', '−': '-',
  '‐': '-', '‑': '-', '‒': '–', '―': '—', '′': "'", '″': '"', '‛': '‘', '‟': '“', '⁄': '/', '✓': 'x', '✔': 'x',
  'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', 'ı': 'i', 'ħ': 'h', 'Ħ': 'H', 'ŧ': 't', 'Ŧ': 'T', 'ẞ': 'SS',
};

function isWinAnsi(cp: number): boolean {
  return cp === 0x0a || cp === 0x09 || (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRA.has(cp);
}

/**
 * Text that the PDF standard fonts (Helvetica, WinAnsiEncoding) can show.
 * jsPDF writes a whole line as two-byte text as soon as one character is
 * missing from that encoding, which prints as garbage; so characters like
 * "→" are replaced, accents WinAnsi lacks are dropped ("ő" → "o"), other
 * spaces become plain spaces and everything else (emoji, other scripts) is
 * left out. German text (ä ö ü ß „ “ – € ×) is kept as it is.
 */
export function toWinAnsi(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isWinAnsi(cp)) {
      out += ch;
      continue;
    }
    const substitute = WIN_ANSI_SUBSTITUTES[ch];
    if (substitute !== undefined) {
      out += substitute;
      continue;
    }
    const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    if (base && [...base].every((c) => isWinAnsi(c.codePointAt(0) ?? 0))) out += base;
    else if (/\s/u.test(ch)) out += ' ';
  }
  // Left-out emoji would leave double spaces behind.
  return out.replace(/ {2,}/g, ' ');
}

export function pageOrientation(page: PageSize): 'portrait' | 'landscape' {
  return page.widthMm > page.heightMm ? 'landscape' : 'portrait';
}

/**
 * New jsPDF document with the exact page size (jsPDF swaps width and height
 * unless the orientation matches), creator metadata, and "print at actual
 * size" as the viewer's default.
 */
export async function createPdfDocument(
  page: PageSize,
  meta: { title: string; subject?: string },
  compress = true,
): Promise<jsPDF> {
  const { jsPDF: JsPdf } = await import('jspdf');
  const doc = new JsPdf({
    unit: 'mm',
    format: [page.widthMm, page.heightMm],
    orientation: pageOrientation(page),
    compress,
    putOnlyUsedFonts: true,
  });
  doc.setProperties({ title: meta.title, subject: meta.subject ?? '', creator: 'TonUINO Studio' });
  doc.viewerPreferences({ PrintScaling: 'None' });
  return doc;
}

export function addPdfPage(doc: jsPDF, page: PageSize): void {
  doc.addPage([page.widthMm, page.heightMm], pageOrientation(page));
}

/**
 * Outline of a label at an already calibrated rectangle. `style` null only
 * builds the path (for clipping).
 */
export function drawLabelShape(
  doc: jsPDF,
  r: RectMm,
  label: LabelGeometry,
  scale: { scaleX: number; scaleY: number },
  style: 'S' | 'F' | 'FD' | null,
): void {
  if (label.shape === 'round') {
    doc.ellipse(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2, style);
  } else if (label.cornerRadiusMm > 0) {
    doc.roundedRect(r.x, r.y, r.width, r.height, label.cornerRadiusMm * scale.scaleX, label.cornerRadiusMm * scale.scaleY, style);
  } else {
    doc.rect(r.x, r.y, r.width, r.height, style);
  }
}
