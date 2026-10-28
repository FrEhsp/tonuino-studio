import { describe, expect, it } from 'vitest';
import { calibrationTransform, toWinAnsi } from '../../src/core/stickers/calibration';
import {
  buildSheetPdf,
  cropMarkSegments,
  exportPhotoSheetJpeg,
  gapMarkSegments,
  planSheet,
  printBleeds,
  type Segment,
  type StickerBitmap,
  FOOTER_GREY,
  FOOTER_PT,
} from '../../src/core/stickers/pdf';
import { growRect, paginate, rectInside, rectsOverlap, slotRects, type RectMm } from '../../src/core/stickers/slots';
import {
  BUILTIN_TEMPLATES,
  defaultPrintOptions,
  getTemplate,
  stickerPixelSize,
  templateForBleed,
  type LabelTemplate,
} from '../../src/core/stickers/templates';
import {
  clipRectsMm,
  imageObjectCount,
  imagePlacementsMm,
  linesMm,
  near,
  pageCount,
  pageSizesMm,
  pdfSource,
  pdfText,
  pdfTextLines,
  TINY_JPEG_BASE64,
  tinyJpeg,
  tinyPng,
} from './fixtures';

const template = (id: string): LabelTemplate => {
  const t = getTemplate(id);
  if (!t) throw new Error(`missing template ${id}`);
  return t;
};
const herma = template('herma-5028');
const card = template('card-a4');
const round30 = template('round-30');

/** A sticker of the right pixel size for the template; the tiny JPEG stands in for the artwork. */
function sticker(t: LabelTemplate, bleedMm = t.defaultBleedMm, image: StickerBitmap['image'] = tinyJpeg()): StickerBitmap {
  return { image, bleedMm, ...stickerPixelSize(t, 300, bleedMm) };
}

function expectBox(actual: RectMm | undefined, expected: RectMm, label = '', tolerance = 0.01): void {
  const ok =
    !!actual &&
    near(actual.x, expected.x, tolerance) &&
    near(actual.y, expected.y, tolerance) &&
    near(actual.width, expected.width, tolerance) &&
    near(actual.height, expected.height, tolerance);
  expect(ok, `${label}: ${JSON.stringify(actual)} should be ${JSON.stringify(expected)}`).toBe(true);
}

function printedArea(t: LabelTemplate, slot: RectMm & { row: number; col: number; index: number }, bleed: number): RectMm {
  const b = printBleeds(t, slot, bleed);
  return growRect(slot, b.left, b.top, b.right, b.bottom);
}

/** True when an axis-aligned segment runs through the inside of the rectangle (touching does not count). */
function hits(s: Segment, r: RectMm, eps = 1e-6): boolean {
  const [minX, maxX] = [Math.min(s.x1, s.x2), Math.max(s.x1, s.x2)];
  const [minY, maxY] = [Math.min(s.y1, s.y2), Math.max(s.y1, s.y2)];
  return minX < r.x + r.width - eps && maxX > r.x + eps && minY < r.y + r.height - eps && maxY > r.y + eps;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

describe('buildSheetPdf', () => {
  it('writes one page per sheet at the template size, with metadata and footer', async () => {
    const bitmap = sticker(herma, 1.5);
    const pages = paginate(new Array<StickerBitmap>(12).fill(bitmap), herma);
    const blob = await buildSheetPdf({ template: herma, pages, bleedMm: 1.5, cutMarks: false, title: 'Regal im Kinderzimmer', compress: false });
    expect(blob.type).toBe('application/pdf');
    const pdf = await pdfSource(blob);
    expect(pdf.startsWith('%PDF-1.')).toBe(true);
    expect(pageCount(pdf)).toBe(2);
    const sizes = pageSizesMm(pdf);
    expect(sizes).toHaveLength(2);
    for (const size of sizes) {
      expect(size.width).toBeCloseTo(210, 3);
      expect(size.height).toBeCloseTo(297, 3);
    }
    // 12 placements of one image: embedded once.
    expect(imagePlacementsMm(pdf, 297)).toHaveLength(12);
    expect(imageObjectCount(pdf)).toBe(1);
    expect(pdf).toContain('/Title (Regal im Kinderzimmer)');
    expect(pdf).toContain('/Subject (Sticker für HERMA 5028 \\(83,8 × 50,8 mm\\))');
    expect(pdf).toContain('/Creator (TonUINO Studio)');
    expect(pdf).toContain('/PrintScaling /None');
    const text = pdfText(pdf);
    expect(text).toContain(
      'Regal im Kinderzimmer · Bogen 1 von 2 · HERMA 5028 (83,8 × 50,8 mm) · mit „Tatsächliche Größe“ (100 %) drucken',
    );
    expect(text).toContain('Bogen 2 von 2');
  });

  it('puts the trim box of every bitmap on its label and clips to the printed bleed', async () => {
    const bitmap = sticker(herma, 1.5);
    const pdf = await pdfSource(
      await buildSheetPdf({ template: herma, pages: [new Array<StickerBitmap>(10).fill(bitmap)], bleedMm: 1.5, cutMarks: false, title: 't', compress: false }),
    );
    const slots = slotRects(herma);
    const placed = imagePlacementsMm(pdf, 297);
    const clips = clipRectsMm(pdf, 297);
    expect(placed).toHaveLength(10);
    expect(clips).toHaveLength(10);
    slots.forEach((slot, i) => {
      expectBox(placed[i], growRect(slot, 1.5), `image ${i + 1}`);
      expectBox(clips[i], printedArea(herma, slot, 1.5), `clip ${i + 1}`);
    });
    // HERMA 5028 has no gap between the rows: bleed goes outwards and into the column gap only.
    expectBox(clips[0], { x: 17.14, y: 20, width: 86.8, height: 52.3 }, 'clip 1');
    expectBox(clips[2], { x: 17.14, y: 72.3, width: 86.8, height: 50.8 }, 'clip 3');
    expectBox(clips[9], { x: 106.02, y: 224.7, width: 86.8, height: 52.3 }, 'clip 10');
    for (let i = 0; i < clips.length; i++) {
      for (let j = i + 1; j < clips.length; j++) expect(rectsOverlap(clips[i], clips[j], 0.005), `clips ${i + 1}/${j + 1}`).toBe(false);
    }
  });

  it('applies the calibration to images, clips and crop marks', async () => {
    const cal = { offsetXMm: 1.2, offsetYMm: -0.8, scaleX: 1.004 };
    const pdf = await pdfSource(
      await buildSheetPdf({ template: card, pages: [[sticker(card, 2)]], calibration: cal, bleedMm: 2, cutMarks: true, title: 'c', compress: false }),
    );
    const tf = calibrationTransform(cal, card.page);
    const slot = slotRects(card)[0];
    expectBox(imagePlacementsMm(pdf, 297)[0], tf.rect(growRect(slot, 2)), 'image');
    expectBox(clipRectsMm(pdf, 297)[0], tf.rect(printedArea(card, slot, 2)), 'clip');
    // White lines under the gap marks first, then all marks in black.
    const gap = gapMarkSegments(card, [0], 2);
    expect(gap).toHaveLength(2);
    const expected = [...gap, ...cropMarkSegments(card, [0], 2), ...gap].map((s) => ({ x1: tf.x(s.x1), y1: tf.y(s.y1), x2: tf.x(s.x2), y2: tf.y(s.y2) }));
    const lines = linesMm(pdf, 297);
    expect(expected.length).toBeGreaterThanOrEqual(12);
    expect(lines).toHaveLength(expected.length);
    lines.forEach((l, i) => {
      const e = expected[i];
      expect(near(l.x1, e.x1) && near(l.y1, e.y1) && near(l.x2, e.x2) && near(l.y2, e.y2), `mark ${i + 1}`).toBe(true);
    });
  });

  it('turns portrait artwork clockwise onto a landscape label', async () => {
    const { widthPx, heightPx } = stickerPixelSize(herma, 300, 1.5);
    const portrait: StickerBitmap = { image: tinyJpeg(), widthPx: heightPx, heightPx: widthPx, bleedMm: 1.5 };
    const target = growRect(slotRects(herma)[0], 1.5);
    const [placement] = planSheet(herma, [portrait], 1.5);
    expect(placement.rotation).toBe(90);
    expectBox(placement.box, target, 'planned');

    const pdf = await pdfSource(await buildSheetPdf({ template: herma, pages: [[portrait]], bleedMm: 1.5, cutMarks: false, title: 'r', compress: false }));
    const [drawn] = imagePlacementsMm(pdf, 297);
    expectBox(drawn, target, 'drawn');
    // The top-left corner of the artwork ends up at the top-right corner of the label.
    expect(near(drawn.imageTopLeft.x, target.x + target.width) && near(drawn.imageTopLeft.y, target.y)).toBe(true);
  });

  it('crops artwork with another aspect ratio (centred) instead of stretching it', () => {
    const square: StickerBitmap = { image: tinyJpeg(), widthPx: 1000, heightPx: 1000, bleedMm: 2 };
    const target = growRect(slotRects(card)[0], 2); // 89.6 × 58
    const [p] = planSheet(card, [square], 2);
    expect(p.rotation).toBe(0);
    expect(p.box.width).toBeCloseTo(89.6, 9);
    expect(p.box.height).toBeCloseTo(89.6, 9);
    expect(p.box.x).toBeCloseTo(target.x, 9);
    expect(p.box.y + p.box.height / 2).toBeCloseTo(target.y + target.height / 2, 9);
    // The clip still limits the print to the label plus bleed.
    expect(p.clip).toEqual({ kind: 'rect', rect: printedArea(card, slotRects(card)[0], 2) });
  });

  it('makes SELPHY pages the label plus bleed, covered edge to edge', async () => {
    const selphy = template('selphy-card');
    const blob = await buildSheetPdf({
      template: selphy,
      pages: [[sticker(selphy, 3)], [sticker(selphy, 3)]],
      bleedMm: 3,
      cutMarks: false,
      title: 's',
      compress: false,
    });
    const pdf = await pdfSource(blob);
    expect(pageCount(pdf)).toBe(2);
    for (const size of pageSizesMm(pdf)) {
      expect(size.width).toBeCloseTo(92, 3);
      expect(size.height).toBeCloseTo(60, 3);
    }
    for (const p of imagePlacementsMm(pdf, 60)) expectBox(p, { x: 0, y: 0, width: 92, height: 60 }, 'image');
    // No footer on borderless single stickers.
    expect(pdfTextLines(pdf)).toEqual([]);
  });

  it.each(BUILTIN_TEMPLATES.map((t) => [t.id, t] as const))('prints a full sheet for %s', async (_id, t) => {
    const opts = defaultPrintOptions(t);
    const n = slotRects(t).length;
    const pages = paginate(new Array<StickerBitmap>(n).fill(sticker(t, opts.bleedMm)), t);
    const blob = await buildSheetPdf({ template: t, pages, bleedMm: opts.bleedMm, cutMarks: opts.cutMarks, cutLines: opts.cutLines, title: 'Alle', compress: false });
    const pdf = await pdfSource(blob);
    const page = templateForBleed(t, opts.bleedMm).page;
    expect(pageCount(pdf)).toBe(1);
    const [size] = pageSizesMm(pdf);
    expect(size.width).toBeCloseTo(page.widthMm, 3);
    expect(size.height).toBeCloseTo(page.heightMm, 3);
    expect(imagePlacementsMm(pdf, page.heightMm)).toHaveLength(n);
    const sheet = { x: 0, y: 0, width: page.widthMm, height: page.heightMm };
    for (const c of clipRectsMm(pdf, page.heightMm)) expect(rectInside(c, sheet, 0.01)).toBe(true);
    for (const l of linesMm(pdf, page.heightMm)) {
      expect(rectInside({ x: Math.min(l.x1, l.x2), y: Math.min(l.y1, l.y2), width: Math.abs(l.x2 - l.x1), height: Math.abs(l.y2 - l.y1) }, sheet, 0.01)).toBe(true);
    }
  });

  it('accepts JPEG and PNG as bytes, Blob or data URL, skips empty slots and embeds each image once', async () => {
    const jpeg = tinyJpeg();
    const base = sticker(herma, 1.5);
    const pages = [
      [
        { ...base, image: jpeg },
        null,
        { ...base, image: new Blob([tinyPng()], { type: 'image/png' }) },
        { ...base, image: `data:image/jpeg;base64,${TINY_JPEG_BASE64}` },
        { ...base, image: jpeg },
      ],
    ];
    const pdf = await pdfSource(await buildSheetPdf({ template: herma, pages, bleedMm: 1.5, cutMarks: false, title: 'm', compress: false }));
    const slots = slotRects(herma);
    const placed = imagePlacementsMm(pdf, 297);
    expect(placed).toHaveLength(4);
    [0, 2, 3, 4].forEach((slot, i) => expectBox(placed[i], growRect(slots[slot], 1.5), `image in slot ${slot + 1}`));
    // JPEG bytes (used twice), PNG plus its alpha mask, JPEG from the data URL.
    expect(imageObjectCount(pdf)).toBe(4);
    expect(pdf).toContain('/DCTDecode');
    expect(pdf).toContain('/SMask');
  });

  it('explains bad input in German', async () => {
    const base = { template: herma, cutMarks: false, title: 'x' };
    const ok = sticker(herma);
    await expect(buildSheetPdf({ ...base, pages: [] })).rejects.toThrow('Es gibt nichts zu drucken. Wähle mindestens einen Sticker aus.');
    await expect(buildSheetPdf({ ...base, pages: [new Array<StickerBitmap>(11).fill(ok)] })).rejects.toThrow(
      'Auf einen Bogen passen nur 10 Sticker, hier sind es 11.',
    );
    await expect(buildSheetPdf({ ...base, pages: [[{ ...ok, widthPx: 0 }]] })).rejects.toThrow('Sticker 1 hat keine gültige Bildgröße');
    const gif = new TextEncoder().encode('GIF89a\u0001\u0000\u0001\u0000');
    await expect(buildSheetPdf({ ...base, pages: [[null, { ...ok, image: gif }]] })).rejects.toThrow(
      'Das Bild für Etikett 2 ist kein JPEG oder PNG.',
    );
    await expect(buildSheetPdf({ ...base, pages: [[{ ...ok, image: 'https://example.org/cover.jpg' }]] })).rejects.toThrow(
      'Das Stickerbild fehlt.',
    );
  });

  it('prints titles with characters the PDF font lacks without garbling the line', async () => {
    const pdf = await pdfSource(
      await buildSheetPdf({ template: herma, pages: [[sticker(herma)]], cutMarks: false, title: 'Bibi → Tina 🐴 Łódź', compress: false }),
    );
    const [footer] = pdfTextLines(pdf);
    expect(footer).toBe('Bibi -> Tina Lódz · HERMA 5028 (83,8 × 50,8 mm) · mit „Tatsächliche Größe“ (100 %) drucken');
    // The document title keeps every character: jsPDF stores it as UTF-16 (byte order mark FE FF).
    expect(pdf).toContain('/Title (þÿ');
  });

  it('writes the hint under the labels small and light (TODO #127)', async () => {
    const pdf = await pdfSource(await buildSheetPdf({ template: herma, pages: [[sticker(herma)]], cutMarks: false, title: 'z', compress: false }));
    const grey = (FOOTER_GREY / 255).toFixed(3).replace(/0+$/, '');
    // jsPDF writes the grey as "g" and the size as "Tf" right before the line.
    expect(pdf).toMatch(new RegExp(`${grey.replace('.', '\\.')}\\d* g`));
    expect(pdf).toMatch(new RegExp(`/F\\d+ ${FOOTER_PT} Tf`));
    expect(FOOTER_PT).toBeLessThan(6.5);
    expect(FOOTER_GREY).toBeGreaterThan(120);
  });

  it('compresses by default', async () => {
    const pdf = await pdfSource(await buildSheetPdf({ template: herma, pages: [[sticker(herma)]], cutMarks: false, title: 'z' }));
    expect(pdf).toContain('/FlateDecode');
    expect(pageCount(pdf)).toBe(1);
  });
});

describe('cut marks and cut lines', () => {
  it.each(['card-a4', 'film-a4', 'photo-13x18', 'herma-5028'])(
    'keeps crop marks on the cut lines, outside every printed card and inside the page (%s)',
    (id) => {
      const t = template(id);
      const bleed = t.defaultBleedMm;
      const slots = slotRects(t);
      const marks = cropMarkSegments(t, slots.map((s) => s.index), bleed);
      const printed = slots.map((s) => printedArea(t, s, bleed));
      const xs = new Set(slots.flatMap((s) => [round3(s.x), round3(s.x + s.width)]));
      const ys = new Set(slots.flatMap((s) => [round3(s.y), round3(s.y + s.height)]));
      expect(marks.length).toBeGreaterThan(0);
      for (const m of marks) {
        const vertical = m.x1 === m.x2;
        expect(vertical || m.y1 === m.y2, 'axis-aligned').toBe(true);
        expect(vertical ? xs.has(round3(m.x1)) : ys.has(round3(m.y1)), `mark ${JSON.stringify(m)} on a cut line`).toBe(true);
        const length = Math.hypot(m.x2 - m.x1, m.y2 - m.y1);
        expect(length).toBeGreaterThanOrEqual(1.5);
        expect(length).toBeLessThanOrEqual(5 + 1e-9);
        for (const v of [m.x1, m.x2]) expect(v >= 0 && v <= t.page.widthMm).toBe(true);
        for (const v of [m.y1, m.y2]) expect(v >= 0 && v <= t.page.heightMm).toBe(true);
        // 0.5 mm away from every printed area, its own included.
        for (const p of printed) expect(hits(m, growRect(p, 0.499)), `mark ${JSON.stringify(m)} too close to a card`).toBe(false);
      }
      // Every cut line can be found from the sheet border: marks at both ends of each column and row.
      const left = Math.min(...slots.map((s) => s.x));
      const right = Math.max(...slots.map((s) => s.x + s.width));
      const top = Math.min(...slots.map((s) => s.y));
      const bottom = Math.max(...slots.map((s) => s.y + s.height));
      for (const x of xs) {
        expect(marks.some((m) => m.x1 === m.x2 && round3(m.x1) === x && Math.max(m.y1, m.y2) < top)).toBe(true);
        expect(marks.some((m) => m.x1 === m.x2 && round3(m.x1) === x && Math.min(m.y1, m.y2) > bottom)).toBe(true);
      }
      for (const y of ys) {
        expect(marks.some((m) => m.y1 === m.y2 && round3(m.y1) === y && Math.max(m.x1, m.x2) < left)).toBe(true);
        expect(marks.some((m) => m.y1 === m.y2 && round3(m.y1) === y && Math.min(m.x1, m.x2) > right)).toBe(true);
      }
    },
  );

  it('marks a full card sheet at the borders and in the column gap', () => {
    const marks = cropMarkSegments(card, slotRects(card).map((s) => s.index), 2);
    // 4 vertical cut lines × 2 ends, 10 horizontal cut lines × (left, right, column gap).
    expect(marks).toHaveLength(38);
    expect(marks).toContainEqual({ x1: 12.9, y1: 7.5, x2: 7.9, y2: 7.5 });
    expect(marks).toContainEqual({ x1: 15.4, y1: 5, x2: 15.4, y2: 0 });
    // In the 8 mm column gap: from the bleed of one card to the bleed of the next, less 0.5 mm each side.
    expect(marks).toContainEqual({ x1: 103.5, y1: 7.5, x2: 106.5, y2: 7.5 });
    // Nothing in the 3 mm row gap, which the bleed fills: that is where the gap marks go.
    expect(marks.filter((m) => m.x1 === m.x2 && Math.min(m.y1, m.y2) > 7.5 && Math.max(m.y1, m.y2) < 289.5)).toEqual([]);
    const gap = gapMarkSegments(card, slotRects(card).map((s) => s.index), 2);
    // 4 vertical cut lines × 4 row gaps, 2 mm each, 0.5 mm away from the cards.
    expect(gap).toHaveLength(16);
    expect(gap).toContainEqual({ x1: 15.4, y1: 62, x2: 15.4, y2: 64 });
    expect(gap).toContainEqual({ x1: 194.6, y1: 233, x2: 194.6, y2: 235 });
    expect(gap.every((m) => m.x1 === m.x2)).toBe(true);
  });

  it.each(
    BUILTIN_TEMPLATES.filter((t) => t.kind === 'cut-yourself' || (t.kind === 'photo' && slotRects(t).length > 1)).map((t) => [t.id, t] as const),
  )('gives every cut line on %s a mark that printers and photo labs do not cut off', (_id, t) => {
    const opts = defaultPrintOptions(t);
    if (!opts.cutMarks) {
      // Round labels get their contour printed instead, inside the label.
      expect(opts.cutLines).toBe(true);
      return;
    }
    // Home printers leave about 4–5 mm blank at the edges, photo labs trim 1–2 mm.
    const band = t.output === 'jpeg' ? 3 : 6;
    const { widthMm: pw, heightMm: ph } = t.page;
    const slots = slotRects(t);
    for (const printed of [slots.map((s) => s.index), ...slots.map((s) => [s.index])]) {
      const marks = [...cropMarkSegments(t, printed, opts.bleedMm), ...gapMarkSegments(t, printed, opts.bleedMm)];
      const kept = marks.filter(
        (m) =>
          Math.min(m.x1, m.x2) >= band &&
          Math.max(m.x1, m.x2) <= pw - band &&
          Math.min(m.y1, m.y2) >= band &&
          Math.max(m.y1, m.y2) <= ph - band &&
          Math.hypot(m.x2 - m.x1, m.y2 - m.y1) >= 1.5 - 1e-9,
      );
      for (const i of printed) {
        const s = slots[i];
        for (const x of [s.x, s.x + s.width]) {
          expect(kept.some((m) => m.x1 === m.x2 && near(m.x1, x, 1e-6)), `label ${i + 1} of [${printed}], cut x = ${x}`).toBe(true);
        }
        for (const y of [s.y, s.y + s.height]) {
          expect(kept.some((m) => m.y1 === m.y2 && near(m.y1, y, 1e-6)), `label ${i + 1} of [${printed}], cut y = ${y}`).toBe(true);
        }
      }
    }
  });

  it('puts gap marks on the cut lines, inside the gaps and clear of every label', () => {
    for (const t of [card, template('photo-13x18')]) {
      const bleed = defaultPrintOptions(t).bleedMm;
      const slots = slotRects(t);
      for (const printed of [slots.map((s) => s.index), [0], [slots.length - 1]]) {
        const gap = gapMarkSegments(t, printed, bleed);
        expect(gap.length).toBeGreaterThan(0);
        const xs = new Set(slots.flatMap((s) => [round3(s.x), round3(s.x + s.width)]));
        const ys = new Set(slots.flatMap((s) => [round3(s.y), round3(s.y + s.height)]));
        for (const m of gap) {
          const vertical = m.x1 === m.x2;
          expect(vertical ? xs.has(round3(m.x1)) : ys.has(round3(m.y1))).toBe(true);
          // At least 0.2 mm from the trim box of every label, printed or not.
          for (const s of slots) expect(hits(m, growRect(s, 0.199)), `mark ${JSON.stringify(m)} touches label ${s.index + 1}`).toBe(false);
        }
      }
    }
    // The photo print: 1.5 mm across the 2 mm column gap on each horizontal cut line.
    const photo = template('photo-13x18');
    expect(gapMarkSegments(photo, [0, 1, 2, 3], 1)).toEqual([
      { x1: 89.25, y1: 7, x2: 90.75, y2: 7 },
      { x1: 89.25, y1: 61, x2: 90.75, y2: 61 },
      { x1: 89.25, y1: 69, x2: 90.75, y2: 69 },
      { x1: 89.25, y1: 123, x2: 90.75, y2: 123 },
    ]);
    // Where ordinary marks fit (wide gaps) or there is no gap at all, nothing is added.
    expect(gapMarkSegments(card, [0, 1], 0)).toEqual([]);
    const labelident = template('labelident-85x55');
    expect(gapMarkSegments(labelident, slotRects(labelident).map((s) => s.index), 1.5)).toEqual([]);
    expect(gapMarkSegments(round30, [0, 1, 5], 1.5)).toEqual([]);
    // HERMA 5028: the 5.08 mm column gap is too narrow for ordinary marks beside 1.5 mm bleed.
    expect(gapMarkSegments(herma, [0, 1], 1.5)).toEqual([
      { x1: 102.94, y1: 21.5, x2: 107.02, y2: 21.5 },
      { x1: 102.94, y1: 72.3, x2: 107.02, y2: 72.3 },
    ]);
  });

  it('marks a single card in the middle of the sheet at its corners and the sheet border', () => {
    const marks = cropMarkSegments(card, [4], 2); // row 3, left column
    const slot = slotRects(card)[4];
    expect(marks).toContainEqual({ x1: slot.x - 2.5, y1: slot.y, x2: slot.x - 7.5, y2: slot.y });
    expect(marks).toContainEqual({ x1: slot.x, y1: 5, x2: slot.x, y2: 0 });
    expect(marks).toContainEqual({ x1: slot.x, y1: 292, x2: slot.x, y2: 297 });
    expect(marks.some((m) => m.y1 === slot.y && Math.min(m.x1, m.x2) > 194.6)).toBe(true);
  });

  it('draws thin black crop marks of 0.25 pt, gap marks on a white line of 1 pt', async () => {
    const pdf = await pdfSource(await buildSheetPdf({ template: card, pages: [[sticker(card, 2)]], bleedMm: 2, cutMarks: true, title: 'm', compress: false }));
    expect(pdf).toMatch(/\n1\.? w\n1\.? G\n/);
    expect(pdf).toMatch(/\n0\.25 w\n0\.? G\n/);
    expect(linesMm(pdf, 297)).toHaveLength(cropMarkSegments(card, [0], 2).length + 2 * gapMarkSegments(card, [0], 2).length);
    // Without gap marks (room for ordinary marks, or no gap at all) there is no white line.
    const labelident = template('labelident-85x55');
    const plain = await pdfSource(
      await buildSheetPdf({ template: labelident, pages: [[sticker(labelident, 1.5)]], bleedMm: 1.5, cutMarks: true, title: 'l', compress: false }),
    );
    expect(linesMm(plain, 297).length).toBeGreaterThan(0);
    expect(plain).not.toMatch(/\n1\.? G\n/);
  });

  it('draws grey cut contours (circles, rounded corners) only when asked', async () => {
    const pages = [[sticker(round30, 1.5), sticker(round30, 1.5)]];
    const curves = (pdf: string) => (pdf.match(/ c$/gm) ?? []).length;
    const withLines = await pdfSource(await buildSheetPdf({ template: round30, pages, bleedMm: 1.5, cutMarks: false, cutLines: true, title: 'r', compress: false }));
    const without = await pdfSource(await buildSheetPdf({ template: round30, pages, bleedMm: 1.5, cutMarks: false, cutLines: false, title: 'r', compress: false }));
    expect(withLines).toMatch(/\n0\.4 w\n0\.43\d* G\n/);
    expect(without).not.toMatch(/0\.43\d* G/);
    // Each circle is four Bézier curves: two clip paths, plus two contours when asked.
    expect(curves(without)).toBe(8);
    expect(curves(withLines)).toBe(16);
    expect(linesMm(withLines, 297)).toEqual([]);

    const rounded = await pdfSource(await buildSheetPdf({ template: herma, pages: [[sticker(herma)]], cutMarks: false, cutLines: true, title: 'h', compress: false }));
    expect(curves(rounded)).toBe(4);
  });
});

describe('photo sheet JPEG', () => {
  it('needs a canvas and says so in German outside the browser', async () => {
    const photo = template('photo-13x18');
    await expect(exportPhotoSheetJpeg({ template: photo, page: [sticker(photo, 1)], cutMarks: true })).rejects.toThrow(
      'keine Zeichenfläche (Canvas)',
    );
  });
});

describe('toWinAnsi', () => {
  it('keeps German text as it is', () => {
    const german = 'Größe „Tatsächlich“ – 100 % · 3 × 5 mm · 2 € … Ø 30 mm\nÄÖÜß';
    expect(toWinAnsi(german)).toBe(german);
  });

  it('replaces or drops what the standard PDF font lacks', () => {
    expect(toWinAnsi('A → B ≥ C − D')).toBe('A -> B >= C - D');
    expect(toWinAnsi('Łódź, Dvořák, Ångström')).toBe('Lódz, Dvorák, Ångström');
    expect(toWinAnsi('Tina 🐴 und 👨‍👩‍👧 Pferde')).toBe('Tina und Pferde');
    expect(toWinAnsi('ﬁx 12 mm')).toBe('fix 12 mm');
    // Decomposed umlauts (macOS file names) are composed first.
    expect(toWinAnsi('Märchen')).toBe('Märchen');
    expect(toWinAnsi('日本')).toBe('');
  });
});
