/**
 * "Weißer Rand" (core/stickers/margin.ts): every motif printed smaller by the
 * margin, white around it, without bleed. A sticker the printer sets off by
 * up to the margin stays on its own label; text, number and logo stay in the
 * label's safe area and inside the motif; every style, the backs and the PDF
 * treat it the same.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Music } from 'lucide-preact';
import { contentBoxes, orientGeometry, LAYOUT_STYLES, stickerLayout, type StickerGeometry } from '../../src/core/stickers/layout';
import { labelsTouch, marginChoices, MOTIF_SAFE_MIN_MM, motifFrame, usableMargin } from '../../src/core/stickers/margin';
import { buildSheetPdf, planSheet, type StickerBitmap } from '../../src/core/stickers/pdf';
import { rectInside, rectsOverlap, slotRects, type RectMm } from '../../src/core/stickers/slots';
import { BUILTIN_TEMPLATES, getTemplate, type LabelTemplate } from '../../src/core/stickers/templates';
import type { Palette, RGB } from '../../src/core/stickers/color';
import type { StickerItem } from '../../src/features/stickers/content';
import { DEFAULT_DESIGN } from '../../src/features/stickers/design';
import { stickerFont } from '../../src/features/stickers/fonts';
import { renderBack } from '../../src/features/stickers/backside';
import { inMargin, labelGeometry } from '../../src/features/stickers/pipeline';
import { renderSticker } from '../../src/features/stickers/render';
import { clipRectsMm, imagePlacementsMm, near, pdfSource, tinyJpeg } from './fixtures';

const template = (id: string): LabelTemplate => {
  const t = getTemplate(id);
  if (!t) throw new Error(`missing template ${id}`);
  return t;
};
const EPS = 1e-6;

const shifted = (r: RectMm, dx: number, dy: number): RectMm => ({ ...r, x: r.x + dx, y: r.y + dy });
const offsets = (m: number): [number, number][] => [
  [m, 0],
  [-m, 0],
  [0, m],
  [0, -m],
  [m, m],
  [-m, -m],
  [m, -m],
  [-m, m],
];

describe('the margins on offer', () => {
  it('offers 0 to 3 mm on ordinary labels, less on small round ones', () => {
    expect(marginChoices(template('herma-5028').label)).toEqual([0, 1, 2, 3]);
    expect(marginChoices(template('round-30').label)).toEqual([0, 1, 2, 3]);
    expect(marginChoices(template('round-25').label)).toEqual([0, 1, 2]);
    expect(marginChoices({ widthMm: 15, heightMm: 15 })).toEqual([0, 1]);
  });

  it('reads a stored margin as one the paper offers, else none', () => {
    const herma = template('herma-5028').label;
    expect(usableMargin(undefined, herma)).toBe(0);
    expect(usableMargin('2', herma)).toBe(0);
    expect(usableMargin(Number.NaN, herma)).toBe(0);
    expect(usableMargin(-1, herma)).toBe(0);
    expect(usableMargin(2, herma)).toBe(2);
    expect(usableMargin(2.5, herma)).toBe(2);
    // A small round label keeps a motif worth having.
    expect(usableMargin(3, template('round-25').label)).toBe(2);
  });

  it('knows the papers whose labels touch, where a margin matters most', () => {
    // HERMA 5028: the rows lie right on each other.
    expect(labelsTouch(template('herma-5028'))).toBe(true);
    expect(labelsTouch(template('round-30'))).toBe(false);
    expect(labelsTouch(template('photo-sticker-82x57'))).toBe(false);
  });
});

describe('the motif inside the margin', () => {
  const herma: StickerGeometry = { widthMm: 83.8, heightMm: 50.8, bleedMm: 1.5, safeMm: 2.5, shape: 'rect' };

  it('is the label less the margin, without bleed, its corners the margin further in', () => {
    const f = motifFrame(herma, 3, 2);
    expect(f.box).toEqual({ x: 2, y: 2, width: 79.8, height: 46.8 });
    expect(f.geometry).toMatchObject({ widthMm: 79.8, heightMm: 46.8, bleedMm: 0, shape: 'rect' });
    expect(f.radius).toBe(1);
    expect(motifFrame(herma, 3, 3).radius).toBe(0);
    const round = motifFrame({ ...herma, widthMm: 30, heightMm: 30, shape: 'round' }, 15, 2);
    expect(round.radius).toBe(13);
    expect(round.geometry.shape).toBe('round');
  });

  it('keeps text as far from the label edge as without a margin, and clear of the motif edge', () => {
    for (const m of [1, 2, 3]) {
      const f = motifFrame(herma, 3, m);
      expect(m + f.geometry.safeMm).toBeGreaterThanOrEqual(herma.safeMm - EPS);
      expect(f.geometry.safeMm).toBeGreaterThanOrEqual(MOTIF_SAFE_MIN_MM);
    }
  });
});

describe('every style inside the margin, on every paper', () => {
  const inputs = [
    { title: true, badge: true, logo: true },
    { title: true, badge: true, logo: false },
    { title: false, badge: true, logo: true },
    { title: false, badge: true, logo: false },
    { title: true, badge: false, logo: false },
  ];

  it('puts text, number and logo inside the label safe area and inside the motif, also with the printer off by the margin', () => {
    let checked = 0;
    for (const t of BUILTIN_TEMPLATES) {
      for (const m of marginChoices(t.label).filter((x) => x > 0)) {
        for (const orientation of ['landscape', 'portrait'] as const) {
          const label = orientGeometry(labelGeometry(t, 0), orientation);
          const f = motifFrame(label, t.label.cornerRadiusMm, m);
          const own: RectMm = { x: 0, y: 0, width: label.widthMm, height: label.heightMm };
          const safe: RectMm = { x: label.safeMm, y: label.safeMm, width: label.widthMm - 2 * label.safeMm, height: label.heightMm - 2 * label.safeMm };
          const motifSafe: RectMm = { x: m + MOTIF_SAFE_MIN_MM, y: m + MOTIF_SAFE_MIN_MM, width: f.box.width - 2 * MOTIF_SAFE_MIN_MM, height: f.box.height - 2 * MOTIF_SAFE_MIN_MM };
          for (const style of LAYOUT_STYLES) {
            for (const input of inputs) {
              for (const pictureAspect of [1, 0.7, 1.6]) {
                const layout = stickerLayout(f.geometry, { style, ...input, pictureAspect });
                for (const b of contentBoxes(layout)) {
                  const onLabel = shifted(b, m, m);
                  const where = `${t.id} ${m} mm ${orientation} ${style} ${JSON.stringify(input)} ${pictureAspect}`;
                  expect(rectInside(onLabel, safe, 1e-6), where).toBe(true);
                  expect(rectInside(onLabel, motifSafe, 1e-6), where).toBe(true);
                  // The printer sets the sticker off by up to the margin: the text is still on the label, clear of its edge.
                  for (const [dx, dy] of offsets(m)) {
                    const moved = shifted(onLabel, dx, dy);
                    expect(rectInside(moved, { x: MOTIF_SAFE_MIN_MM, y: MOTIF_SAFE_MIN_MM, width: own.width - 2 * MOTIF_SAFE_MIN_MM, height: own.height - 2 * MOTIF_SAFE_MIN_MM }, 1e-6), where).toBe(true);
                  }
                  checked++;
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});

describe('the print sheet with a margin', () => {
  /** A bitmap as the pipeline delivers it with a margin: the label without bleed. */
  const bitmap = (t: LabelTemplate): StickerBitmap => ({ image: tinyJpeg(), widthPx: Math.round(t.label.widthMm * 10), heightPx: Math.round(t.label.heightMm * 10), bleedMm: 0 });

  it('never puts ink on a neighbouring label when the printer sets stickers off by up to the margin', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const rects = slotRects(t);
      if (rects.length < 2) continue;
      for (const m of marginChoices(t.label).filter((x) => x > 0)) {
        const placements = planSheet(t, rects.map(() => bitmap(t)), 0);
        expect(placements).toHaveLength(rects.length);
        for (const p of placements) {
          // Nothing printed past the label (no bleed); the motif itself the margin further in.
          expect(p.clip.kind === 'rect' ? p.clip.rect : null).toEqual(t.label.shape === 'round' ? null : { x: p.slot.x, y: p.slot.y, width: p.slot.width, height: p.slot.height });
          const f = motifFrame(labelGeometry(t, 0), t.label.cornerRadiusMm, m);
          const ink: RectMm = { x: p.box.x + f.box.x, y: p.box.y + f.box.y, width: f.box.width, height: f.box.height };
          for (const [dx, dy] of offsets(m)) {
            const moved = shifted(ink, dx, dy);
            expect(rectInside(moved, p.slot), `${t.id} ${m} mm slot ${p.slot.index}`).toBe(true);
            for (const other of rects) if (other.index !== p.slot.index) expect(rectsOverlap(moved, other)).toBe(false);
          }
        }
      }
    }
  });

  it('clips every sticker to its label in the PDF, with the image exactly on it', async () => {
    const t = template('herma-5028');
    const rects = slotRects(t);
    const pdf = await pdfSource(await buildSheetPdf({ template: t, pages: [rects.map(() => bitmap(t))], bleedMm: 0, cutMarks: false, title: 'Rand', compress: false }));
    const images = imagePlacementsMm(pdf, t.page.heightMm);
    const clips = clipRectsMm(pdf, t.page.heightMm);
    expect(images).toHaveLength(rects.length);
    for (const r of rects) {
      expect(images.some((i) => near(i.x, r.x) && near(i.y, r.y) && near(i.width, r.width) && near(i.height, r.height))).toBe(true);
      expect(clips.some((c) => near(c.x, r.x) && near(c.y, r.y) && near(c.width, r.width) && near(c.height, r.height))).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ drawing, on a stand-in canvas */

interface Draw {
  w: number;
  h: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

class Recorder {
  fillStyle = '#000';
  strokeStyle = '#000';
  font = '10px sans-serif';
  rects: { style: string; x: number; y: number; w: number; h: number }[] = [];
  draws: Draw[] = [];
  texts: { text: string; x: number; y: number }[] = [];
  clips: number[][] = [];
  private path: number[] = [];
  constructor(readonly canvas: FakeCanvas) {}
  getTransform() {
    return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  }
  beginPath() {
    this.path = [];
  }
  moveTo(x: number, y: number) {
    this.path.push(x, y);
  }
  arcTo(x1: number, y1: number, x2: number, y2: number) {
    this.path.push(x1, y1, x2, y2);
  }
  rect(x: number, y: number, w: number, h: number) {
    this.path.push(x, y, x + w, y + h);
  }
  ellipse(cx: number, cy: number, rx: number, ry: number) {
    this.path.push(cx - rx, cy - ry, cx + rx, cy + ry);
  }
  clip() {
    this.clips.push([...this.path]);
  }
  fillRect(x: number, y: number, w: number, h: number) {
    this.rects.push({ style: this.fillStyle, x, y, w, h });
  }
  drawImage(img: { width: number; height: number }, ...a: number[]) {
    const [dx, dy, dw, dh] = a.length >= 8 ? a.slice(4) : a.length === 4 ? a : [a[0], a[1], img.width, img.height];
    this.draws.push({ w: img.width, h: img.height, dx, dy, dw, dh });
  }
  measureText(text: string) {
    const px = Number(/([\d.]+)px/.exec(this.font)?.[1] ?? 10);
    return { width: text.length * px * 0.6 };
  }
  fillText(text: string, x: number, y: number) {
    this.texts.push({ text, x, y });
  }
  getImageData(_x: number, _y: number, w: number, h: number) {
    return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h };
  }
  createLinearGradient() {
    return { addColorStop() {} };
  }
}
for (const name of ['save', 'restore', 'closePath', 'stroke', 'fill', 'translate', 'rotate', 'strokeText', 'arc', 'lineTo', 'setTransform', 'scale', 'putImageData', 'quadraticCurveTo', 'bezierCurveTo']) {
  (Recorder.prototype as unknown as Record<string, () => void>)[name] = () => undefined;
}

class FakeCanvas {
  ctx: Recorder;
  constructor(
    public width: number,
    public height: number,
  ) {
    this.ctx = new Recorder(this);
  }
  getContext() {
    return this.ctx;
  }
}

beforeAll(() => vi.stubGlobal('OffscreenCanvas', FakeCanvas));
afterAll(() => vi.unstubAllGlobals());

describe('drawing with a margin', () => {
  const K = 10;
  const GREY: RGB = { r: 120, g: 140, b: 160 };
  const palette: Palette = { dominant: GREY, vibrant: { r: 40, g: 120, b: 200 }, muted: GREY, dark: { r: 20, g: 30, b: 40 }, light: { r: 230, g: 235, b: 240 }, swatches: [] };
  const item: StickerItem = { key: 'f5', title: 'Die Sendung mit der Maus', number: '05', icon: Music, flatColor: '#0e76bd', picture: { kind: 'url', url: 'x' } };
  const t = template('herma-5028');

  const drawSticker = (style: (typeof LAYOUT_STYLES)[number], marginMm: number) => {
    const label = labelGeometry(t, marginMm ? 0 : t.defaultBleedMm);
    let inner: FakeCanvas | undefined;
    let innerSize = { width: 0, height: 0 };
    const canvas = inMargin({ template: t, marginMm }, label, K, (g) => {
      const image = new FakeCanvas(600, 600) as unknown as OffscreenCanvas;
      const c = renderSticker({ item, picture: { image, palette, base: GREY, generated: false }, design: { ...DEFAULT_DESIGN, style, showTitle: true }, geometry: g, pxPerMm: K, font: stickerFont('round') });
      inner = c as unknown as FakeCanvas;
      innerSize = { width: c.width, height: c.height };
      return c;
    }) as unknown as FakeCanvas;
    return { canvas, inner: inner!, innerSize };
  };

  it('draws as before without a margin', () => {
    const { canvas, inner } = drawSticker('tape', 0);
    expect(canvas).toBe(inner);
    expect(canvas.width).toBe(Math.round((83.8 + 3) * K));
  });

  it('draws every style for the smaller motif and puts it on white, inside the label', () => {
    const m = 2;
    for (const style of LAYOUT_STYLES) {
      const { canvas, inner, innerSize } = drawSticker(style, m);
      // The label without bleed, white all over, the motif placed the margin in and clipped to rounded corners.
      expect(canvas.width).toBe(Math.round(83.8 * K));
      expect(canvas.height).toBe(Math.round(50.8 * K));
      expect(canvas.ctx.rects[0]).toMatchObject({ style: '#ffffff', x: 0, y: 0, w: canvas.width, h: canvas.height });
      const placed = canvas.ctx.draws.at(-1)!;
      expect(placed).toMatchObject({ dx: m * K, dy: m * K });
      expect(placed.dw).toBeCloseTo((83.8 - 2 * m) * K, 6);
      expect(placed.dh).toBeCloseTo((50.8 - 2 * m) * K, 6);
      const clip = canvas.ctx.clips.at(-1)!;
      expect(Math.min(...clip.filter((_, i) => i % 2 === 0))).toBeCloseTo(m * K, 6);
      expect(Math.max(...clip.filter((_, i) => i % 2 === 0))).toBeCloseTo((83.8 - m) * K, 6);
      // The motif drawn at its own size, its text inside it (scaled to fit the smaller room).
      expect(innerSize).toEqual({ width: Math.round((83.8 - 2 * m) * K), height: Math.round((50.8 - 2 * m) * K) });
      expect(inner.ctx.texts.length, style).toBeGreaterThan(0);
      for (const tx of inner.ctx.texts) {
        expect(tx.x, style).toBeGreaterThanOrEqual(0);
        expect(tx.x, style).toBeLessThanOrEqual(innerSize.width);
        expect(tx.y, style).toBeGreaterThan(0);
        expect(tx.y, style).toBeLessThanOrEqual(innerSize.height);
      }
      // Its memory is given back once placed.
      expect(inner.width).toBe(0);
    }
  });

  it('puts the backs inside the same margin', () => {
    const m = 3;
    let inner: FakeCanvas | undefined;
    const back = inMargin({ template: t, marginMm: m }, labelGeometry(t, 0), K, (g) => {
      const c = renderBack({ number: '05', heading: 'Die Sendung mit der Maus', text: 'Spielt die ganze Folge.' }, 'list', g, K, stickerFont('round'));
      inner = c as unknown as FakeCanvas;
      return c;
    }) as unknown as FakeCanvas;
    expect(back.width).toBe(Math.round(83.8 * K));
    expect(back.ctx.draws.at(-1)).toMatchObject({ dx: m * K, dy: m * K });
    expect(inner!.ctx.texts.length).toBeGreaterThan(0);
    // Left-aligned text starts inside the label's safe area.
    for (const tx of inner!.ctx.texts) expect(tx.x + m * K).toBeGreaterThanOrEqual(t.safeMarginMm * K - EPS);
  });
});
