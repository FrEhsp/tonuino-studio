import { describe, expect, it } from 'vitest';
import { rectInside, rectsOverlap, slotRects } from '../../src/core/stickers/slots';
import {
  A4,
  BUILTIN_TEMPLATES,
  cardOverhangMm,
  customTemplate,
  defaultPrintOptions,
  fmtMm,
  getTemplate,
  stickerPixelSize,
  templateForBleed,
  validateTemplate,
  type LabelTemplate,
} from '../../src/core/stickers/templates';

const byId = (id: string): LabelTemplate => {
  const t = getTemplate(id);
  if (!t) throw new Error(`missing template ${id}`);
  return t;
};

describe('built-in templates', () => {
  it('has the expected templates with unique ids', () => {
    const ids = BUILTIN_TEMPLATES.map((t) => t.id);
    expect(ids).toEqual([
      'herma-5028',
      'labelident-85x55',
      'card-a4',
      'film-a4',
      'selphy-card',
      'photo-13x18',
      'photo-sticker-82x57',
      'round-30',
      'round-25',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getTemplate('gibt-es-nicht')).toBeUndefined();
  });

  it.each(BUILTIN_TEMPLATES.map((t) => [t.id, t] as const))('%s is valid', (_id, t) => {
    expect(validateTemplate(t)).toEqual([]);
    const page = { x: 0, y: 0, width: t.page.widthMm, height: t.page.heightMm };
    const rects = slotRects(t);
    expect(rects).toHaveLength(t.grid.cols * t.grid.rows);
    for (const r of rects) expect(rectInside(r, page), `label ${r.index + 1} inside the page`).toBe(true);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(rectsOverlap(rects[i], rects[j]), `labels ${i + 1} and ${j + 1}`).toBe(false);
      }
    }
    // German texts for the picker.
    expect(t.name.length).toBeGreaterThan(3);
    expect(t.description.length).toBeGreaterThan(10);
    expect(t.safeMarginMm).toBeGreaterThan(0);
    // Single pictures for a photo service keep the sticker's proportions: no bleed.
    if (t.output === 'images') expect(t.defaultBleedMm).toBe(0);
    else expect(t.defaultBleedMm).toBeGreaterThan(0);
    // Where a label sticks out over the card, text keeps clear of the part that is cut off.
    expect(t.safeMarginMm).toBeGreaterThanOrEqual(cardOverhangMm(t.label.widthMm, t.label.heightMm) + 2);
  });

  it.each(BUILTIN_TEMPLATES.map((t) => [t.id, t] as const))('%s is centred on the page', (_id, t) => {
    const rects = slotRects(t);
    const left = Math.min(...rects.map((r) => r.x));
    const right = t.page.widthMm - Math.max(...rects.map((r) => r.x + r.width));
    const top = Math.min(...rects.map((r) => r.y));
    const bottom = t.page.heightMm - Math.max(...rects.map((r) => r.y + r.height));
    expect(Math.abs(left - right)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(top - bottom)).toBeLessThanOrEqual(0.05);
  });

  it('uses the exact HERMA 5028 geometry of the TonUINO Card Creator', () => {
    const t = byId('herma-5028');
    expect(t.page).toEqual(A4);
    expect(t.label).toMatchObject({ widthMm: 83.8, heightMm: 50.8, shape: 'rect' });
    expect(t.grid).toMatchObject({ cols: 2, rows: 5, marginLeftMm: 18.64, marginTopMm: 21.5 });
    expect(t.grid.pitchXMm).toBeCloseTo(88.88, 10);
    expect(t.grid.pitchYMm).toBe(50.8);
    const r = slotRects(t);
    expect(r[0]).toMatchObject({ index: 0, row: 0, col: 0, x: 18.64, y: 21.5, width: 83.8, height: 50.8 });
    expect(r[1]).toMatchObject({ index: 1, row: 0, col: 1, x: 107.52, y: 21.5 });
    expect(r[2]).toMatchObject({ index: 2, row: 1, col: 0, x: 18.64, y: 72.3 });
    expect(r[9]).toMatchObject({ index: 9, row: 4, col: 1, x: 107.52, y: 224.7 });
    // Margins: right 18.68 mm, bottom 21.5 mm.
    expect(210 - (r[9].x + r[9].width)).toBeCloseTo(18.68, 6);
    expect(297 - (r[9].y + r[9].height)).toBeCloseTo(21.5, 6);
    expect(t.kind).toBe('die-cut');
    expect(t.verified).toBe(true);
  });

  it('places the card templates with room for crop marks', () => {
    const card = byId('card-a4');
    const r = slotRects(card);
    expect(r[0]).toMatchObject({ x: 15.4, y: 7.5, width: 85.6, height: 54 });
    expect(r[1].x - (r[0].x + r[0].width)).toBeCloseTo(8, 6);
    expect(r[2].y - (r[0].y + r[0].height)).toBeCloseTo(3, 6);
    expect(byId('film-a4').grid).toEqual(card.grid);
  });

  it('describes the photo print as a 300 dpi JPEG on 18 × 13 cm', () => {
    const t = byId('photo-13x18');
    expect(t.output).toBe('jpeg');
    expect(t.kind).toBe('photo');
    expect(t.page).toEqual({ widthMm: 180, heightMm: 130 });
    expect(slotRects(t)).toHaveLength(4);
    expect(BUILTIN_TEMPLATES.filter((x) => x.output === 'jpeg').map((x) => x.id)).toEqual(['photo-13x18']);
  });

  it('exports photo stickers as single pictures in the sticker proportions', () => {
    const t = byId('photo-sticker-82x57');
    expect(t).toMatchObject({ kind: 'single', output: 'images', defaultBleedMm: 0, verified: false });
    expect(t.label).toMatchObject({ widthMm: 82, heightMm: 57, shape: 'rect' });
    expect(t.page).toEqual({ widthMm: 82, heightMm: 57 });
    expect(slotRects(t)).toEqual([{ index: 0, row: 0, col: 0, x: 0, y: 0, width: 82, height: 57 }]);
    expect(templateForBleed(t, 0)).toBe(t);
    // 300 dpi in the proportions of the sticker, not of the card (85,6 × 54 would be 1,59).
    const px = stickerPixelSize(t, 300, 0);
    expect(px).toEqual({ widthPx: 969, heightPx: 673 });
    expect(px.widthPx / px.heightPx).toBeCloseTo(82 / 57, 2);
    // 1.5 mm stick out over the card at the top and bottom; text keeps 2.5 mm more for what the service cuts.
    expect(cardOverhangMm(82, 57)).toBe(1.5);
    expect(t.safeMarginMm).toBe(4);
    expect(t.notes).toContain('Kartenkante');
  });

  it('makes the SELPHY page the label plus bleed', () => {
    const t = byId('selphy-card');
    expect(t.kind).toBe('single');
    expect(t.page).toEqual({ widthMm: 90, heightMm: 58 });
    expect(slotRects(t)).toEqual([{ index: 0, row: 0, col: 0, x: 2, y: 2, width: 86, height: 54 }]);
  });

  it('has round templates with circles', () => {
    for (const [id, d, n] of [
      ['round-30', 30, 40],
      ['round-25', 25, 54],
    ] as const) {
      const t = byId(id);
      expect(t.label).toEqual({ widthMm: d, heightMm: d, cornerRadiusMm: d / 2, shape: 'round' });
      expect(slotRects(t)).toHaveLength(n);
    }
  });
});

describe('print defaults', () => {
  it('suits the kind of template', () => {
    expect(defaultPrintOptions(byId('herma-5028'))).toEqual({ bleedMm: 1.5, cutMarks: false, cutLines: false });
    expect(defaultPrintOptions(byId('selphy-card'))).toEqual({ bleedMm: 2, cutMarks: false, cutLines: false });
    expect(defaultPrintOptions(byId('card-a4'))).toEqual({ bleedMm: 3, cutMarks: true, cutLines: false });
    expect(defaultPrintOptions(byId('round-30'))).toEqual({ bleedMm: 1.5, cutMarks: false, cutLines: true });
    expect(defaultPrintOptions(byId('photo-13x18'))).toEqual({ bleedMm: 1, cutMarks: true, cutLines: false });
    expect(defaultPrintOptions(byId('photo-sticker-82x57'))).toEqual({ bleedMm: 0, cutMarks: false, cutLines: false });
  });
});

describe('cardOverhangMm', () => {
  it('is what sticks out over the card on each side, in either orientation', () => {
    expect(cardOverhangMm(83.8, 50.8)).toBe(0);
    expect(cardOverhangMm(85, 55)).toBe(0.5);
    expect(cardOverhangMm(86, 54)).toBe(0.2);
    expect(cardOverhangMm(82, 57)).toBe(1.5);
    expect(cardOverhangMm(57, 82)).toBe(1.5);
    expect(cardOverhangMm(80, 60)).toBe(3);
    expect(cardOverhangMm(30, 30)).toBe(0);
  });
});

describe('templateForBleed', () => {
  it('grows the page of single-label templates with the bleed', () => {
    const selphy = byId('selphy-card');
    expect(templateForBleed(selphy, 2)).toBe(selphy);
    const t3 = templateForBleed(selphy, 3);
    expect(t3.page).toEqual({ widthMm: 92, heightMm: 60 });
    expect(slotRects(t3)[0]).toMatchObject({ x: 3, y: 3, width: 86, height: 54 });
    const t0 = templateForBleed(selphy, 0);
    expect(t0.page).toEqual({ widthMm: 86, heightMm: 54 });
    expect(validateTemplate(t3)).toEqual([]);
  });

  it('leaves sheets unchanged', () => {
    const herma = byId('herma-5028');
    expect(templateForBleed(herma, 3)).toBe(herma);
  });
});

describe('stickerPixelSize', () => {
  it('includes the bleed on every side', () => {
    expect(stickerPixelSize(byId('herma-5028'), 300, 1.5)).toEqual({ widthPx: 1025, heightPx: 635 });
    expect(stickerPixelSize(byId('card-a4'), 300, 0)).toEqual({ widthPx: 1011, heightPx: 638 });
    expect(stickerPixelSize(byId('round-30'), 600, 1.5)).toEqual({ widthPx: 780, heightPx: 780 });
    // Default bleed of the template.
    expect(stickerPixelSize(byId('card-a4'))).toEqual(stickerPixelSize(byId('card-a4'), 300, 3));
  });
});

describe('customTemplate', () => {
  it('fits as many labels as possible and centres them', () => {
    const t = customTemplate({ labelWidthMm: 50, labelHeightMm: 30 });
    expect(t.grid).toEqual({ cols: 3, rows: 8, marginLeftMm: 26, marginTopMm: 14.5, pitchXMm: 54, pitchYMm: 34 });
    expect(t.id).toBe('custom-50x30-3x8');
    expect(t.name).toBe('Eigene Größe 50 × 30 mm');
    expect(t.kind).toBe('cut-yourself');
    expect(t.output).toBe('pdf');
    expect(validateTemplate(t)).toEqual([]);
  });

  it('builds die-cut sheets without gaps by default', () => {
    const t = customTemplate({ labelWidthMm: 70, labelHeightMm: 37, kind: 'die-cut', cols: 3, rows: 8, marginLeftMm: 0, marginTopMm: 0.5 });
    expect(t.grid).toEqual({ cols: 3, rows: 8, marginLeftMm: 0, marginTopMm: 0.5, pitchXMm: 70, pitchYMm: 37 });
    expect(t.verified).toBe(false);
    expect(validateTemplate(t)).toEqual([]);
  });

  it('builds round labels and single labels', () => {
    const round = customTemplate({ labelWidthMm: 40, labelHeightMm: 99, shape: 'round' });
    expect(round.label).toEqual({ widthMm: 40, heightMm: 40, cornerRadiusMm: 20, shape: 'round' });
    expect(round.grid).toMatchObject({ cols: 4, rows: 6 });
    expect(round.id).toBe('custom-rund-40x40-4x6');

    const single = customTemplate({ labelWidthMm: 86, labelHeightMm: 54, kind: 'single', name: '  Mein Drucker ' });
    expect(single.page).toEqual({ widthMm: 90, heightMm: 58 });
    expect(single.grid).toMatchObject({ cols: 1, rows: 1, marginLeftMm: 2, marginTopMm: 2 });
    expect(single.name).toBe('Mein Drucker');
    expect(single.description).toBe('1 Etikett mit 86 × 54 mm pro Seite.');
  });

  it('builds single pictures for photo stickers without bleed, text clear of the overhang', () => {
    const t = customTemplate({ labelWidthMm: 80, labelHeightMm: 60, kind: 'single', output: 'images' });
    expect(t.page).toEqual({ widthMm: 80, heightMm: 60 });
    expect(t.grid).toMatchObject({ cols: 1, rows: 1, marginLeftMm: 0, marginTopMm: 0 });
    expect(t.defaultBleedMm).toBe(0);
    // 3 mm plus the 3 mm that stick out over the card at the top and bottom.
    expect(t.safeMarginMm).toBe(6);
    expect(t.description).toBe('Jeder Sticker wird ein eigenes Bild mit 80 × 60 mm.');
    expect(t.notes).toContain('ZIP-Datei');
    expect(t.notes).toContain('Der Sticker ist größer als die Karte: Klebe ihn mittig auf und schneide den Rand an der Kartenkante ab.');
    expect(defaultPrintOptions(t)).toEqual({ bleedMm: 0, cutMarks: false, cutLines: false });
    // A label sheet slightly larger than the card gets the same advice.
    const sheet = customTemplate({ labelWidthMm: 89, labelHeightMm: 57, kind: 'die-cut', cols: 2, rows: 5 });
    expect(sheet.safeMarginMm).toBeCloseTo(4.7, 6);
    expect(sheet.notes).toBe('Das Etikett ist größer als die Karte: Klebe es mittig auf und schneide den Rand an der Kartenkante ab. Titel und Nummer bleiben auf der Karte.');
    // Labels the size of the card or smaller keep the usual margin and say nothing about cutting.
    const small = customTemplate({ labelWidthMm: 50, labelHeightMm: 30 });
    expect(small.safeMarginMm).toBe(3);
    expect(small.notes).toBe('');
    // A huge label never gets a margin that leaves no room.
    expect(validateTemplate(customTemplate({ labelWidthMm: 200, labelHeightMm: 60 }))).toEqual([]);
  });

  it('rejects impossible sizes with German messages', () => {
    expect(() => customTemplate({ labelWidthMm: 0, labelHeightMm: 30 })).toThrow('breiter und höher als 0 mm');
    expect(() => customTemplate({ labelWidthMm: 250, labelHeightMm: 30 })).toThrow('passt nicht auf die Seite');
    expect(() => customTemplate({ labelWidthMm: 50, labelHeightMm: 30, cols: 5 })).toThrow('ragt über den Seitenrand');
    expect(() => customTemplate({ labelWidthMm: 50, labelHeightMm: 30, cornerRadiusMm: 20 })).toThrow('Eckenradius');
  });
});

describe('validateTemplate', () => {
  it('reports overlapping labels and labels outside the page', () => {
    const herma = byId('herma-5028');
    const overlapping: LabelTemplate = { ...herma, grid: { ...herma.grid, pitchXMm: 80 } };
    expect(validateTemplate(overlapping).join(' ')).toContain('überlappen');
    const tooLow: LabelTemplate = { ...herma, grid: { ...herma.grid, marginTopMm: 45 } };
    expect(validateTemplate(tooLow).join(' ')).toContain('Etikett 9 ragt über den Seitenrand');
    const empty: LabelTemplate = { ...herma, grid: { ...herma.grid, cols: 0 } };
    expect(validateTemplate(empty)).toEqual(['Es muss mindestens eine Spalte und eine Zeile geben.']);
  });

  it('formats millimetres the German way', () => {
    expect(fmtMm(83.8)).toBe('83,8');
    expect(fmtMm(18.64 + 88.88)).toBe('107,52');
    expect(fmtMm(54)).toBe('54');
  });
});
