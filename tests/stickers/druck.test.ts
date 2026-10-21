/**
 * The print helps of 0.4.1 from the sticker audit (16.10.2026): the white
 * margin set from the start on sheets without a gap, the warning from about
 * 1 % off in size, the 10 cm line of the test page, the outlines of a trial
 * print on plain paper, and 3 mm of picture past the card edge on the papers
 * to cut at the card.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTestPagePdf,
  calibrationFromReadings,
  canvasPen,
  drawTestPage,
  measureBox,
  measureLinePlacement,
  measureLineText,
  scaleOff,
  validateCalibration,
  type TestPagePen,
} from '../../src/core/stickers/calibration';
import { AUTO_MARGIN_MM, autoMarginMm, chosenMargin } from '../../src/core/stickers/margin';
import { buildSheetPdf, printBleeds, type StickerBitmap } from '../../src/core/stickers/pdf';
import { rectsOverlap, slotRects } from '../../src/core/stickers/slots';
import { BUILTIN_TEMPLATES, customTemplate, getTemplate, stickerPixelSize, type LabelTemplate } from '../../src/core/stickers/templates';
import { printOptions, printSetup } from '../../src/features/stickers/design';
import { linesMm, near, pdfSource, pdfText, strokedRectsMm, tinyJpeg } from './fixtures';

const template = (id: string): LabelTemplate => {
  const t = getTemplate(id);
  if (!t) throw new Error(`missing template ${id}`);
  return t;
};
const herma = template('herma-5028');
const labelident = template('labelident-85x55');

describe('the white margin from the start', () => {
  it('is 1 mm on pre-cut sheets whose labels lie closer than 2 mm', () => {
    expect(autoMarginMm(herma)).toBe(AUTO_MARGIN_MM);
    expect(autoMarginMm(labelident)).toBe(1);
    expect(autoMarginMm(customTemplate({ kind: 'die-cut', labelWidthMm: 70, labelHeightMm: 37, gapXMm: 0, gapYMm: 1.5 }))).toBe(1);
  });

  it('is none where the labels have room, the user cuts, or there is one label', () => {
    expect(autoMarginMm(customTemplate({ kind: 'die-cut', labelWidthMm: 70, labelHeightMm: 37, gapXMm: 2, gapYMm: 2 }))).toBe(0);
    for (const id of ['card-a4', 'film-a4', 'round-30', 'round-25', 'selphy-card', 'photo-13x18', 'photo-sticker-82x57']) {
      expect(autoMarginMm(template(id)), id).toBe(0);
    }
    // A label too small for a 1 mm margin gets none.
    expect(autoMarginMm(customTemplate({ kind: 'die-cut', shape: 'round', labelWidthMm: 8, labelHeightMm: 8, gapXMm: 0, gapYMm: 0 }))).toBe(0);
  });

  it('gives way to what the user chose for this paper, also "Ohne"', () => {
    expect(chosenMargin(undefined, herma)).toBe(1);
    expect(chosenMargin({ 'card-a4': 2 }, herma)).toBe(1);
    expect(chosenMargin({ 'herma-5028': 0 }, herma)).toBe(0);
    expect(chosenMargin({ 'herma-5028': 3 }, herma)).toBe(3);
    expect(chosenMargin(undefined, template('card-a4'))).toBe(0);
  });

  describe('in the print settings', () => {
    const before = printSetup.value;
    afterEach(() => {
      printSetup.value = before;
    });

    it('prints HERMA 5028 with 1 mm and without bleed until the user picks another margin', () => {
      printSetup.value = { templateId: 'herma-5028', cutMarks: null };
      expect(printOptions.value.marginMm).toBe(1);
      expect(printOptions.value.bleedMm).toBe(0);
      printSetup.value = { templateId: 'herma-5028', cutMarks: null, margins: { 'herma-5028': 0 } };
      expect(printOptions.value.marginMm).toBe(0);
      expect(printOptions.value.bleedMm).toBe(1.5);
    });
  });
});

describe('the warning from about 1 % off in size', () => {
  it('names how far and which way the print is off', () => {
    // A correction of 1.031 makes up for a print of 97 %.
    expect(scaleOff({ offsetXMm: 0, offsetYMm: 0, scaleX: 1 / 0.97 })).toEqual({ percent: 3, smaller: true });
    expect(scaleOff({ offsetXMm: 0, offsetYMm: 0, scaleY: 1 / 1.02 })).toEqual({ percent: 2, smaller: false });
    expect(scaleOff({ offsetXMm: 0, offsetYMm: 0, scaleX: 1.004, scaleY: 0.997 })).toBeNull();
    expect(scaleOff(null)).toBeNull();
  });

  it('takes 2.5 mm over the height of a HERMA sheet, but not 1 mm', () => {
    // The real bottom edge of the last label lies at +2.5 on the ruler: the print came out shorter.
    const smaller = calibrationFromReadings(herma, null, { x: 0, y: 0 }, { y: 2.5 });
    expect(scaleOff(smaller)).toEqual({ percent: 1, smaller: true });
    expect(validateCalibration(smaller).join(' ')).toContain('etwa 1 % zu klein');
    expect(validateCalibration(smaller).join(' ')).toContain('„Tatsächliche Größe“');
    const slight = calibrationFromReadings(herma, null, { x: 0, y: 0 }, { y: 1 });
    expect(scaleOff(slight)).toBeNull();
    expect(validateCalibration(slight)).toEqual([]);
  });

  it('warns for a print of 97 % (the usual "An Seite anpassen")', () => {
    // HERMA at 97 % about the middle of the page: the outer edges are read about 2.7 and 3.9 mm off.
    const cal = calibrationFromReadings(herma, null, { x: -2.67, y: -3.93 }, { x: 2.67, y: 3.93 });
    expect(validateCalibration(cal)).toEqual([expect.stringContaining('etwa 3 % zu klein')]);
  });
});

describe('the 10 cm line on the test page', () => {
  const sheets = [...BUILTIN_TEMPLATES, customTemplate({ labelWidthMm: 60, labelHeightMm: 40 }), customTemplate({ kind: 'die-cut', labelWidthMm: 63.5, labelHeightMm: 38.1, cols: 3, rows: 7, gapXMm: 2.5, gapYMm: 0 })];

  it.each(sheets.map((t) => [t.id, t] as const))('stays clear of the labels and the page edge on %s', (_id, t) => {
    const m = measureLinePlacement(t);
    if (!m) return;
    const box = measureBox(m);
    expect(box.x).toBeGreaterThanOrEqual(6 - 1e-9);
    expect(box.y).toBeGreaterThanOrEqual(6 - 1e-9);
    expect(box.x + box.width).toBeLessThanOrEqual(t.page.widthMm - 6 + 1e-9);
    expect(box.y + box.height).toBeLessThanOrEqual(t.page.heightMm - 6 + 1e-9);
    for (const r of slotRects(t)) expect(rectsOverlap(box, r), `label ${r.index + 1}`).toBe(false);
  });

  it('is 10 cm on every A4 paper, and left out where the page has no room', () => {
    for (const t of BUILTIN_TEMPLATES.filter((x) => x.page.widthMm === 210)) {
      expect(measureLinePlacement(t)?.lengthMm, t.id).toBe(100);
    }
    // The SELPHY page is the label plus 2 mm: nothing free.
    expect(measureLinePlacement(template('selphy-card'))).toBeNull();
    // HERMA 5028: across in the margin above the labels.
    expect(measureLinePlacement(herma)).toMatchObject({ axis: 'x', lengthMm: 100 });
    // Labelident: the rows reach almost to the page edge, so it stands in the side margin.
    expect(measureLinePlacement(labelident)).toMatchObject({ axis: 'y', lengthMm: 100 });
  });

  it('is printed 10 cm long with its question, also with a size correction', async () => {
    const pdf = await pdfSource(await buildTestPagePdf(herma, { offsetXMm: 1, offsetYMm: -1, scaleX: 1.006, scaleY: 1.006 }, { compress: false }));
    expect(pdfText(pdf)).toContain(measureLineText(100));
    expect(measureLineText(100)).toBe('Ist diese Linie genau 10 cm lang? Sonst stelle im Druckdialog 100 % ein.');
    const lines = linesMm(pdf, 297).filter((l) => near(l.y1, l.y2) && near(Math.abs(l.x2 - l.x1), 100, 0.001));
    expect(lines).toHaveLength(1);
  });

  it('draws the same page with any pen', () => {
    const texts: string[] = [];
    const lines: number[] = [];
    const pen: TestPagePen = {
      lineWidth: () => undefined,
      line: (x1, y1, x2, y2) => void lines.push(Math.hypot(x2 - x1, y2 - y1)),
      circle: () => undefined,
      labelShape: () => undefined,
      whiteBox: () => undefined,
      font: () => undefined,
      textWidth: (t) => t.length * 1.2,
      split: (t) => [t],
      text: (t) => void texts.push(t),
    };
    drawTestPage(pen, labelident);
    expect(texts).toContain(measureLineText(100));
    expect(texts).toContain('Testseite: Labelident 85 × 55 mm');
    expect(lines.filter((l) => near(l, 100))).toHaveLength(1);
  });

  it('wraps text on a canvas by its measured width', () => {
    const calls: string[] = [];
    const ctx = {
      measureText: (t: string) => ({ width: t.length * 10 }),
      set font(v: string) {
        calls.push(v);
      },
    } as unknown as CanvasRenderingContext2D;
    // 10 px per mm: a character is 1 mm wide.
    const pen = canvasPen(ctx, 10);
    pen.font(6, true);
    expect(calls[0]).toMatch(/^bold 21\.17px Helvetica/);
    expect(pen.split('eins zwei drei vier', 10)).toEqual(['eins zwei', 'drei vier']);
  });
});

describe('the trial print on plain paper', () => {
  const sticker = (t: LabelTemplate): StickerBitmap => {
    const { widthPx, heightPx } = stickerPixelSize(t, 300, 0);
    return { image: tinyJpeg(), widthPx, heightPx, bleedMm: 0 };
  };

  it('outlines every label of the sheet where it is expected, printed or not', async () => {
    const cal = { offsetXMm: 1.5, offsetYMm: -1, scaleX: 1.004 };
    const pdf = await pdfSource(
      await buildSheetPdf({ template: labelident, pages: [[sticker(labelident), sticker(labelident)]], calibration: cal, bleedMm: 0, cutMarks: false, outlines: true, title: 'Probedruck', compress: false }),
    );
    const outlines = strokedRectsMm(pdf, 297);
    const cx = labelident.page.widthMm / 2;
    expect(outlines).toHaveLength(10);
    slotRects(labelident).forEach((r, i) => {
      expect(near(outlines[i].x, cx + (r.x - cx) * 1.004 + 1.5, 0.01), `label ${i + 1}`).toBe(true);
      expect(outlines[i].width).toBeCloseTo(85 * 1.004, 2);
    });
  });

  it('draws no outlines on the real print', async () => {
    const pdf = await pdfSource(await buildSheetPdf({ template: labelident, pages: [[sticker(labelident)]], bleedMm: 0, cutMarks: false, title: 'Sticker', compress: false }));
    expect(strokedRectsMm(pdf, 297)).toHaveLength(0);
  });
});

describe('papers to cut at the card edge', () => {
  it.each(['card-a4', 'film-a4'])('%s prints 3 mm past the card where the gap has room, and says how to cut', (id) => {
    const t = template(id);
    expect(t.defaultBleedMm).toBe(3);
    expect(t.notes).toContain('lege die Karte darauf und schneide an der Kartenkante entlang');
    const [first] = slotRects(t);
    // Left and between the columns (8 mm) the full 3 mm; between the rows (3 mm) half the gap.
    expect(printBleeds(t, first, t.defaultBleedMm)).toEqual({ left: 3, right: 3, top: 3, bottom: 1.5 });
  });

  it('every paper says in one sentence how long its stickers last', () => {
    for (const t of BUILTIN_TEMPLATES) expect(t.notes, t.id).toMatch(/Nässe|Pigmenttinte|Klarlack|laminiert|abwischbar/);
  });
});
