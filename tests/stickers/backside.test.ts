import { describe, expect, it } from 'vitest';
import { BACK_QR_MAX_BYTES, backListLayout, fitTrackTitle, mirrorPage, mirrorTemplate, moreLine, trackListText, wrappedBackList } from '../../src/core/stickers/backside';
import { buildSheetPdf, type StickerBitmap } from '../../src/core/stickers/pdf';
import { paginate, slotRects } from '../../src/core/stickers/slots';
import { getTemplate, stickerPixelSize, type LabelTemplate } from '../../src/core/stickers/templates';
import { imagePlacementsMm, near, pageCount, pdfSource, pdfText, tinyJpeg, tinyPng } from './fixtures';

const template = (id: string): LabelTemplate => {
  const t = getTemplate(id);
  if (!t) throw new Error(`missing template ${id}`);
  return t;
};
const herma = template('herma-5028');
const card = template('card-a4');
const labelident = template('labelident-85x55');

/** A fixed advance per character, as in the other text tests. */
const measure = (text: string, size: number) => [...text].length * size * 0.5;

describe('the sheet of back sides', () => {
  it('puts every back where its front is once the paper is turned over the long edge', () => {
    for (const t of [herma, card, labelident]) {
      const front = slotRects(t);
      const back = slotRects(mirrorTemplate(t));
      const order = mirrorPage(front.map((s) => s.index), t);
      back.forEach((slot, i) => {
        const of = order[i]!;
        // Turned over the long edge: x runs the other way, y stays.
        expect(near(slot.x, t.page.widthMm - front[of].x - front[of].width, 1e-3), `${t.id} slot ${i}`).toBe(true);
        expect(slot.y).toBeCloseTo(front[of].y, 6);
        expect(slot.row).toBe(front[of].row);
      });
    }
  });

  it('keeps empty labels empty and a symmetric sheet in place', () => {
    expect(mirrorPage(['a', null, 'c', 'd'], { grid: { ...herma.grid, cols: 2 } })).toEqual([null, 'a', 'd', 'c']);
    // HERMA 5028 is nearly centred: 18.64 mm on the left, 18.68 mm on the right.
    expect(mirrorTemplate(herma).grid.marginLeftMm).toBeCloseTo(18.68, 3);
    // An own size with a wider left margin moves to the right.
    const lopsided: LabelTemplate = { ...herma, grid: { ...herma.grid, marginLeftMm: 10 } };
    expect(mirrorTemplate(lopsided).grid.marginLeftMm).toBeCloseTo(210 - 10 - 83.8 - 88.88, 3);
  });

  it('follows every sheet with its back page in the PDF, mirrored, with a hint how to print', async () => {
    const size = stickerPixelSize(herma, 300, 1.5);
    const front: StickerBitmap = { image: tinyJpeg(), bleedMm: 1.5, ...size };
    const back: StickerBitmap = { image: tinyPng(), bleedMm: 1.5, ...size };
    const pages = paginate(new Array<StickerBitmap>(11).fill(front), herma);
    const backs = paginate([back, ...new Array<StickerBitmap | null>(10).fill(null)], herma);
    // The second sheet has one sticker but no back: its back page is still there, empty.
    const blob = await buildSheetPdf({ template: herma, pages, backs: [backs[0], []], bleedMm: 1.5, cutMarks: false, title: 'Regal', compress: false });
    const pdf = await pdfSource(blob);
    expect(pageCount(pdf)).toBe(4);
    const placed = imagePlacementsMm(pdf, 297);
    // 10 fronts, the one back, 1 front.
    expect(placed).toHaveLength(12);
    const first = slotRects(herma)[0];
    const backBox = placed[10];
    // The back of label 1 (top left) is top right on its page.
    expect(near(backBox.x + 1.5, 210 - first.x - first.width, 0.01)).toBe(true);
    expect(near(backBox.y + 1.5, first.y, 0.01)).toBe(true);
    expect(pdfText(pdf)).toContain('Rückseite: Regal');
    expect(pdfText(pdf)).toContain('an der langen Kante wenden');
  });

  it('adds no pages without back sides', async () => {
    const size = stickerPixelSize(herma, 300, 1.5);
    const pages = paginate([{ image: tinyJpeg(), bleedMm: 1.5, ...size }], herma);
    expect(pageCount(await pdfSource(await buildSheetPdf({ template: herma, pages, bleedMm: 1.5, cutMarks: false, title: 't', compress: false })))).toBe(1);
  });
});

describe('the track list on a back side', () => {
  const box = { widthMm: 76, heightMm: 34 };

  it('takes the largest type that fits all tracks, in more columns when needed', () => {
    const few = backListLayout(6, box);
    expect(few).toMatchObject({ columns: 1, shown: 6, sizeMm: 3 });
    expect(few.rows).toBe(6);
    const many = backListLayout(24, box);
    expect(many.shown).toBe(24);
    expect(many.columns).toBeGreaterThan(1);
    expect(many.columns * many.rows).toBeGreaterThanOrEqual(24);
    expect(many.rows * many.lineMm).toBeLessThanOrEqual(box.heightMm + 1e-6);
    expect(many.columns * many.sizeMm * 11).toBeLessThanOrEqual(box.widthMm + 1e-6);
  });

  it('stops one line early when not all fit, for the line with how many more there are', () => {
    const l = backListLayout(200, box);
    expect(l.sizeMm).toBeCloseTo(1.7, 6);
    expect(l.shown).toBe(l.rows * l.columns - 1);
    expect(moreLine(200 - l.shown)).toMatch(/^… und \d+ weitere Titel$/);
    expect(moreLine(1)).toBe('… und 1 weiterer Titel');
  });

  it('shortens long titles with "…" and names tracks without a title', () => {
    expect(fitTrackTitle({ number: 3, title: 'Kurz' }, 30, 2, measure)).toBe('Kurz');
    const long = fitTrackTitle({ number: 3, title: 'Ein sehr langer Titel einer Folge mit vielen Wörtern' }, 30, 2, measure);
    expect(long.endsWith('…')).toBe(true);
    expect(measure(long, 2)).toBeLessThanOrEqual(30);
    expect(fitTrackTitle({ number: 7, title: '  ' }, 30, 2, measure)).toBe('Titel 7');
  });

  it('shows long titles whole, over more lines, every line inside its column and the box', () => {
    // Frank's folder 49: twelve titles, some long.
    const titles = ['Die Eule mit der Beule', 'Das Einhorn ohne Horn vorn', 'Der Hummer hat Kummer', 'Das Einhorn sucht den Regenbogen', 'Die kleine Eule mag nicht baden', 'Warum brummt der Bär nicht mehr?', 'Der kleine Fuchs hört nicht zu', 'Die Maus mit der Laus', 'Gute Nacht, kleine Eule', 'Der Biber hat Fieber', 'Happy Birthday, liebe Eule', 'Das kleine Einhorn will nicht schlafen'];
    const tracks = titles.map((title, i) => ({ number: i + 1, title }));
    const w = wrappedBackList(tracks, box, measure)!;
    expect(w).toBeDefined();
    expect(w.items.map((it) => it.lines.join(' ').replace(/- /g, '-'))).toEqual(titles.map((t) => t));
    for (const it of w.items) {
      expect(it.column).toBeLessThan(w.columns);
      expect((it.line + it.lines.length) * w.lineMm).toBeLessThanOrEqual(box.heightMm + 1e-6);
      for (const line of it.lines) expect(measure(line, w.sizeMm)).toBeLessThanOrEqual(w.columnMm - w.numberMm + 1e-6);
    }
    expect(w.columns * w.columnMm + (w.columns - 1) * w.gapMm).toBeCloseTo(box.widthMm, 6);
  });

  it('keeps short titles on one line each at the largest type, and gives up when too many', () => {
    const short = wrappedBackList([1, 2, 3].map((n) => ({ number: n, title: `Teil ${n}` })), box, measure)!;
    expect(short).toMatchObject({ columns: 1, sizeMm: 3 });
    expect(short.items.every((it) => it.lines.length === 1)).toBe(true);
    expect(wrappedBackList(Array.from({ length: 200 }, (_, i) => ({ number: i + 1, title: 'Ein ziemlich langer Titel' })), box, measure)).toBeUndefined();
  });
});

describe('the QR code of a back side', () => {
  const bytes = (s: string) => new TextEncoder().encode(s).length;

  it('holds the heading and every track while they fit', () => {
    expect(trackListText('05 Bibi', [{ number: 1, title: 'Anfang' }, { number: 2, title: 'Ende' }])).toBe('05 Bibi\n1 Anfang\n2 Ende');
  });

  it('shortens titles, then stops early with how many more there are', () => {
    const tracks = Array.from({ length: 40 }, (_, i) => ({ number: i + 1, title: `Kapitel ${i + 1}: Die lange Reise über die sieben Meere und zurück` }));
    const text = trackListText('12 Großes Hörbuch', tracks);
    expect(bytes(text)).toBeLessThanOrEqual(BACK_QR_MAX_BYTES);
    expect(text.startsWith('12 Großes Hörbuch\n1 Kapitel')).toBe(true);
    expect(text).toMatch(/… und \d+ weitere Titel$/);
    const few = trackListText('x', tracks.slice(0, 6));
    expect(few.split('\n')).toHaveLength(7);
    expect(few).toContain('…');
  });
});
