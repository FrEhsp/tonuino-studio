import { describe, expect, it } from 'vitest';
import {
  ANY_TEMPLATE,
  applyCalibration,
  buildTestPagePdf,
  calibratedSlotRects,
  calibrationFromReadings,
  calibrationKey,
  calibrationTransform,
  describeCalibration,
  formatSignedMm,
  getCalibration,
  isIdentityCalibration,
  normalizeCalibration,
  readingsFromFields,
  setCalibration,
  TEST_PAGE_INSTRUCTIONS,
  validateCalibration,
  type Calibration,
  type CalibrationStore,
} from '../../src/core/stickers/calibration';
import { slotRects } from '../../src/core/stickers/slots';
import { A4, BUILTIN_TEMPLATES, customTemplate, getTemplate, type LabelTemplate } from '../../src/core/stickers/templates';
import { near, pageCount, pageSizesMm, pdfSource, pdfText, strokedRectsMm } from './fixtures';

const herma = getTemplate('herma-5028') as LabelTemplate;
const labelident = getTemplate('labelident-85x55') as LabelTemplate;

describe('calibration store', () => {
  it('builds keys from printer and template', () => {
    expect(calibrationKey('  HP   OfficeJet 3830 ', 'herma-5028')).toBe('hp officejet 3830::herma-5028');
    expect(calibrationKey('', 'card-a4')).toBe('standard::card-a4');
  });

  it('falls back to the printer-wide entry, then to no correction', () => {
    let store: CalibrationStore = {};
    store = setCalibration(store, 'Canon', ANY_TEMPLATE, { offsetXMm: 1, offsetYMm: -0.5 });
    store = setCalibration(store, 'Canon', 'herma-5028', { offsetXMm: 0.8, offsetYMm: 0.2, scaleX: 1.002 });
    expect(getCalibration(store, 'canon', 'herma-5028')).toEqual({ offsetXMm: 0.8, offsetYMm: 0.2, scaleX: 1.002 });
    expect(getCalibration(store, 'Canon', 'card-a4')).toEqual({ offsetXMm: 1, offsetYMm: -0.5 });
    expect(getCalibration(store, 'Brother', 'card-a4')).toEqual({ offsetXMm: 0, offsetYMm: 0 });
  });

  it('returns a new store, tidies values and removes identity entries', () => {
    const before: CalibrationStore = {};
    const store = setCalibration(before, 'Epson', 'card-a4', { offsetXMm: 0.123456, offsetYMm: -0.004, scaleX: 1, scaleY: 0.9999999 });
    expect(before).toEqual({});
    expect(store).toEqual({ 'epson::card-a4': { offsetXMm: 0.12, offsetYMm: 0 } });
    expect(setCalibration(store, 'Epson', 'card-a4', { offsetXMm: 0, offsetYMm: 0 })).toEqual({});
  });

  it('normalises missing or broken values', () => {
    expect(normalizeCalibration(undefined)).toEqual({ offsetXMm: 0, offsetYMm: 0, scaleX: 1, scaleY: 1 });
    expect(normalizeCalibration({ offsetXMm: Number.NaN, offsetYMm: 2, scaleX: 0, scaleY: -1 })).toEqual({
      offsetXMm: 0,
      offsetYMm: 2,
      scaleX: 1,
      scaleY: 1,
    });
    expect(isIdentityCalibration({ offsetXMm: 0, offsetYMm: 0, scaleX: 1 })).toBe(true);
    expect(isIdentityCalibration({ offsetXMm: 0, offsetYMm: 0.1 })).toBe(false);
  });
});

describe('applying a calibration', () => {
  const rect = { x: 10, y: 20, width: 30, height: 40 };

  it('moves right and down for positive offsets', () => {
    expect(applyCalibration(rect, { offsetXMm: 1.5, offsetYMm: -2 }, A4)).toEqual({ x: 11.5, y: 18, width: 30, height: 40 });
    expect(applyCalibration(rect, null, A4)).toEqual(rect);
  });

  it('scales about the page centre', () => {
    const tf = calibrationTransform({ offsetXMm: 0, offsetYMm: 0, scaleX: 1.01, scaleY: 0.99 }, A4);
    expect(tf.x(105)).toBeCloseTo(105, 10);
    expect(tf.y(148.5)).toBeCloseTo(148.5, 10);
    const r = tf.rect(rect);
    expect(r.x).toBeCloseTo(105 + (10 - 105) * 1.01, 10);
    expect(r.y).toBeCloseTo(148.5 + (20 - 148.5) * 0.99, 10);
    expect(r.width).toBeCloseTo(30.3, 10);
    expect(r.height).toBeCloseTo(39.6, 10);
  });

  it('keeps slot numbers on calibrated slots', () => {
    const rects = calibratedSlotRects(herma, { offsetXMm: 1, offsetYMm: 1 });
    expect(rects[9]).toMatchObject({ index: 9, row: 4, col: 1, width: 83.8, height: 50.8 });
    expect(rects[9].x).toBeCloseTo(108.52, 9);
    expect(rects[9].y).toBeCloseTo(225.7, 9);
  });
});

describe('calibrationFromReadings', () => {
  it('takes the top-left reading as the offset to add', () => {
    expect(calibrationFromReadings(herma, null, { x: 0.8, y: -1.2 })).toEqual({ offsetXMm: 0.8, offsetYMm: -1.2 });
    expect(calibrationFromReadings(herma, { offsetXMm: 0.5, offsetYMm: 0.5 }, { x: 0.3, y: -0.2 })).toEqual({
      offsetXMm: 0.8,
      offsetYMm: 0.3,
    });
    expect(calibrationFromReadings(herma, { offsetXMm: 1, offsetYMm: 1 }, { x: 0, y: 0 })).toEqual({ offsetXMm: 1, offsetYMm: 1 });
  });

  /**
   * A simulated printer puts design coordinate v at paper position a·v + b.
   * The test page is printed with `current` applied; the user reads, on each
   * ruler, the tick that lands on the real label edge.
   */
  function simulate(template: LabelTemplate, printer: { ax: number; bx: number; ay: number; by: number }, current: Calibration) {
    const tf = calibrationTransform(current, template.page);
    const paperX = (v: number) => printer.ax * tf.x(v) + printer.bx;
    const paperY = (v: number) => printer.ay * tf.y(v) + printer.by;
    // Find r with paper(edge + r) = edge (bisection over the ±6 mm ruler).
    const reading = (paper: (v: number) => number, edge: number) => {
      let lo = -6;
      let hi = 6;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (paper(edge + mid) < edge) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    };
    const rects = slotRects(template);
    const first = rects[0];
    const last = rects[rects.length - 1];
    const edges = { left: first.x, top: first.y, right: last.x + last.width, bottom: last.y + last.height };
    return {
      edges,
      topLeft: { x: reading(paperX, edges.left), y: reading(paperY, edges.top) },
      bottomRight: { x: reading(paperX, edges.right), y: reading(paperY, edges.bottom) },
    };
  }

  it.each([
    ['offset only', { ax: 1, bx: 1.3, ay: 1, by: -0.9 }, { offsetXMm: 0, offsetYMm: 0 }],
    ['offset and scale', { ax: 1.004, bx: -0.7, ay: 0.997, by: 1.1 }, { offsetXMm: 0, offsetYMm: 0 }],
    ['with an existing correction', { ax: 0.996, bx: 0.4, ay: 1.003, by: -1.5 }, { offsetXMm: 0.5, offsetYMm: -0.3, scaleX: 1.001 }],
  ] as const)('solves a printer with %s', (_name, printer, current) => {
    const sim = simulate(herma, printer, current);
    const next = calibrationFromReadings(herma, current, sim.topLeft, sim.bottomRight);
    const tf = calibrationTransform(next, herma.page);
    // With the new calibration all outer label edges print where they belong (to 0.01 mm).
    const { left, right, top, bottom } = sim.edges;
    for (const x of [left, right]) expect(Math.abs(printer.ax * tf.x(x) + printer.bx - x)).toBeLessThan(0.01);
    for (const y of [top, bottom]) expect(Math.abs(printer.ay * tf.y(y) + printer.by - y)).toBeLessThan(0.01);
    // A second round on the corrected print reads (almost) zero everywhere.
    const again = simulate(herma, printer, next);
    for (const v of [again.topLeft.x, again.topLeft.y, again.bottomRight.x, again.bottomRight.y]) {
      expect(Math.abs(v)).toBeLessThan(0.01);
    }
  });

  it('omits the scale when only the top-left ruler is read', () => {
    const next = calibrationFromReadings(herma, { offsetXMm: 0, offsetYMm: 0, scaleX: 1.002 }, { x: 0.5, y: 0.5 });
    expect(next.scaleX).toBe(1.002);
    expect(next.scaleY).toBeUndefined();
  });

  it('keeps the scale of an axis whose field at the last label stays empty', () => {
    // The printer prints 1 mm too low and 0.8 % too wide. Both horizontal rulers are read, of the
    // vertical ones only the top one: the empty field must not count as 0 and invent a scale.
    const printer = { ax: 1.008, bx: 105 * (1 - 1.008), ay: 1, by: 1 };
    const sim = simulate(herma, printer, { offsetXMm: 0, offsetYMm: 0 });
    const readings = readingsFromFields([sim.topLeft.x, sim.topLeft.y, sim.bottomRight.x, undefined]);
    expect(readings?.bottomRight).toEqual({ x: sim.bottomRight.x, y: undefined });
    const next = calibrationFromReadings(herma, null, readings!.topLeft, readings!.bottomRight);
    expect(next.offsetYMm).toBe(-1);
    expect(next.scaleY).toBeUndefined();
    expect(next.scaleX).toBeCloseTo(1 / 1.008, 4);
    const again = simulate(herma, printer, next);
    for (const v of [again.topLeft.x, again.topLeft.y, again.bottomRight.x, again.bottomRight.y]) {
      expect(Math.abs(v)).toBeLessThan(0.01);
    }
  });
});

describe('readingsFromFields', () => {
  it('is null while nothing is entered', () => {
    expect(readingsFromFields([undefined, undefined, undefined, undefined])).toBeNull();
    expect(readingsFromFields([])).toBeNull();
  });

  it('counts empty fields at label 1 as 0 and leaves empty fields at the last label out', () => {
    expect(readingsFromFields([0.5, undefined, undefined, undefined])).toEqual({ topLeft: { x: 0.5, y: 0 } });
    expect(readingsFromFields([undefined, undefined, undefined, -1])).toEqual({
      topLeft: { x: 0, y: 0 },
      bottomRight: { x: undefined, y: -1 },
    });
    expect(readingsFromFields([1, -1, 0.5, 0])).toEqual({ topLeft: { x: 1, y: -1 }, bottomRight: { x: 0.5, y: 0 } });
  });
});

describe('describeCalibration', () => {
  it('names offsets and, when there is one, the scale', () => {
    expect(describeCalibration(null)).toBe('waagerecht 0,0 mm, senkrecht 0,0 mm');
    expect(describeCalibration({ offsetXMm: 1, offsetYMm: -0.5 })).toBe('waagerecht +1,0 mm, senkrecht –0,5 mm');
    expect(describeCalibration({ offsetXMm: 0.2, offsetYMm: 0, scaleX: 0.99206 })).toBe(
      'waagerecht +0,2 mm, senkrecht 0,0 mm, Maßstab 99,21 % / 100,00 %',
    );
  });
});

describe('validateCalibration', () => {
  it('accepts plausible values', () => {
    expect(validateCalibration({ offsetXMm: 1.5, offsetYMm: -2, scaleX: 1.003 })).toEqual([]);
  });

  it('explains implausible values in German', () => {
    expect(validateCalibration({ offsetXMm: 20, offsetYMm: 0 })[0]).toContain('größer als 15 mm');
    // A correction of 0.94 means the print came out about 6 % too large.
    expect(validateCalibration({ offsetXMm: 0, offsetYMm: 0, scaleY: 0.94 })[0]).toContain('etwa 6 % zu groß');
    expect(validateCalibration({ offsetXMm: Number.NaN, offsetYMm: 0 })[0]).toContain('keine gültige Zahl');
  });

  it('formats signed millimetres', () => {
    expect(formatSignedMm(1.5)).toBe('+1,5');
    expect(formatSignedMm(-0.5)).toBe('–0,5');
    expect(formatSignedMm(0)).toBe('0,0');
    expect(formatSignedMm(-0.04)).toBe('0,0');
  });
});

describe('buildTestPagePdf', () => {
  it('draws one page at the template size with the instructions', async () => {
    const pdf = await pdfSource(await buildTestPagePdf(herma, undefined, { compress: false }));
    expect(pageCount(pdf)).toBe(1);
    const [size] = pageSizesMm(pdf);
    expect(size.width).toBeCloseTo(210, 3);
    expect(size.height).toBeCloseTo(297, 3);
    const text = pdfText(pdf);
    expect(TEST_PAGE_INSTRUCTIONS).toBe(
      'Drucke diese Seite auf normales Papier mit „Tatsächliche Größe“ oder 100 %. ' +
        'Lege sie gegen das Licht auf einen Etikettenbogen. ' +
        'Liegen die Linien nicht genau auf den Etikettenrändern, miss den Versatz und trage ihn ein.',
    );
    expect(text).toContain(TEST_PAGE_INSTRUCTIONS);
    expect(text).toContain('Testseite: HERMA 5028 (83,8 × 50,8 mm)');
    expect(text).toContain('Aktuelle Korrektur: waagerecht 0,0 mm, senkrecht 0,0 mm.');
    // Label numbers 1 … 10 and ruler numbers.
    for (let i = 1; i <= 10; i++) expect(pdfText(pdf).split(' ')).toContain(String(i));
    expect(text).toContain('–6');
    expect(text).toContain('+6');
    expect(pdf).toContain('/Creator (TonUINO Studio)');
    expect(pdf).toContain('/PrintScaling /None');
  });

  it('prints the outlines with the calibration applied', async () => {
    const cal = { offsetXMm: 2, offsetYMm: 3 };
    const pdf = await pdfSource(await buildTestPagePdf(labelident, cal, { compress: false }));
    const outlines = strokedRectsMm(pdf, 297);
    const expected = slotRects(labelident).map((r) => applyCalibration(r, cal, labelident.page));
    expect(outlines).toHaveLength(10);
    outlines.forEach((o, i) => {
      expect(near(o.x, expected[i].x) && near(o.y, expected[i].y), `outline ${i + 1}`).toBe(true);
      expect(o.width).toBeCloseTo(85, 2);
      expect(o.height).toBeCloseTo(55, 2);
    });
    const text = pdfText(pdf);
    expect(text).toContain('Aktuelle Korrektur: waagerecht +2,0 mm, senkrecht +3,0 mm.');
    expect(text).toContain('noch nicht mit einem echten Bogen geprüft');
  });

  it.each(BUILTIN_TEMPLATES.map((t) => [t.id, t] as const))('builds the test page for %s', async (_id, t) => {
    const pdf = await pdfSource(await buildTestPagePdf(t, { offsetXMm: -0.5, offsetYMm: 0.5, scaleX: 1.002 }, { compress: false }));
    expect(pageCount(pdf)).toBe(1);
    const [size] = pageSizesMm(pdf);
    expect(size.width).toBeCloseTo(t.page.widthMm, 3);
    expect(size.height).toBeCloseTo(t.page.heightMm, 3);
    expect(pdfText(pdf)).toContain(TEST_PAGE_INSTRUCTIONS);
    expect(pdfText(pdf)).toContain('Maßstab 100,20 % / 100,00 %');
  });

  it('writes umlauts and German quotes as WinAnsi bytes that the standard font shows', async () => {
    const bytes = new Uint8Array(await (await buildTestPagePdf(herma, undefined, { compress: false })).arrayBuffer());
    const raw = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    // „ = 0x84, “ = 0x93, ä = 0xE4, ö = 0xF6, ß = 0xDF, × = 0xD7, – = 0x96 in Windows-1252.
    expect(raw).toContain('\x84Tats\xE4chliche');
    expect(raw).toContain('Gr\xF6\xDFe\x93');
    expect(raw).toContain('Etikettenr\xE4ndern');
    expect(raw).toContain('HERMA 5028 \\(83,8 \xD7 50,8 mm\\)');
    expect(raw).toContain('(\x966) Tj');
    expect(raw).toContain('/Encoding /WinAnsiEncoding');
    // No text line fell back to two-byte characters (jsPDF does that when one character is not in WinAnsi).
    const shown = [...raw.matchAll(/\(((?:\\[\s\S]|[^\\)])*)\)\s*Tj/g)].map((m) => m[1]);
    expect(shown.length).toBeGreaterThan(20);
    for (const s of shown) expect(s).not.toMatch(/[\x00\xFE]/);
  });

  it('keeps custom template names with unusual characters readable', async () => {
    const custom = customTemplate({ name: 'Dvořák → Etiketten 🎵', labelWidthMm: 60, labelHeightMm: 40 });
    const pdf = await pdfSource(await buildTestPagePdf(custom, undefined, { compress: false }));
    expect(pdfText(pdf)).toContain('Testseite: Dvorák -> Etiketten');
    expect(pdfText(pdf)).toContain(TEST_PAGE_INSTRUCTIONS);
  });

  it('compresses by default', async () => {
    const blob = await buildTestPagePdf(herma);
    expect(blob.type).toBe('application/pdf');
    const pdf = await pdfSource(blob);
    expect(pdf.startsWith('%PDF-')).toBe(true);
    expect(pdf).toContain('/FlateDecode');
  });
});
