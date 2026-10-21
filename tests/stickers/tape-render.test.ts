/**
 * What the style "Kassette" really draws, recorded on a stand-in canvas:
 * the band in the work's colour, the light number plate exactly where the
 * layout puts it (in mm, at print resolution), and its digits in the work's
 * colour; for a work nobody knows the colours come from the cover, and a
 * colour chosen for the sticker wins.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Music } from 'lucide-preact';
import { WHITE, contrast, fromHex, luminance, mix, toCss, type Palette, type RGB } from '../../src/core/stickers/color';
import { stickerLayout, type StickerGeometry } from '../../src/core/stickers/layout';
import { workColorsByTitle } from '../../src/core/stickers/works';
import type { StickerItem } from '../../src/features/stickers/content';
import { DEFAULT_DESIGN } from '../../src/features/stickers/design';
import { stickerFont } from '../../src/features/stickers/fonts';
import { backInk, renderSticker } from '../../src/features/stickers/render';
import { tapeColors } from '../../src/features/stickers/tape';
import { loadBackQr, renderBack, WHITE_BACK } from '../../src/features/stickers/backside';
import { fontFor } from '../../src/features/stickers/pipeline';

interface Fill {
  style: string;
  box: { x: number; y: number; w: number; h: number };
}
interface Text {
  text: string;
  style: string;
  font: string;
  x: number;
  y: number;
}

/** A 2D context that draws nothing and remembers the fills, rectangles and texts. */
class Recorder {
  fillStyle = '#000';
  strokeStyle = '#000';
  font = '10px sans-serif';
  fills: Fill[] = [];
  rects: Fill[] = [];
  texts: Text[] = [];
  private path: [number, number][] = [];
  private stack: { fillStyle: string; font: string }[] = [];
  constructor(readonly canvas: FakeCanvas) {}
  getTransform() {
    return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  }
  save() {
    this.stack.push({ fillStyle: this.fillStyle, font: this.font });
  }
  restore() {
    Object.assign(this, this.stack.pop());
  }
  beginPath() {
    this.path = [];
  }
  moveTo(x: number, y: number) {
    this.path.push([x, y]);
  }
  arcTo(x1: number, y1: number, x2: number, y2: number) {
    this.path.push([x1, y1], [x2, y2]);
  }
  rect(x: number, y: number, w: number, h: number) {
    this.path.push([x, y], [x + w, y + h]);
  }
  fill() {
    const xs = this.path.map((p) => p[0]);
    const ys = this.path.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    this.fills.push({ style: this.fillStyle, box: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y } });
  }
  fillRect(x: number, y: number, w: number, h: number) {
    this.rects.push({ style: this.fillStyle, box: { x, y, w, h } });
  }
  measureText(text: string) {
    const px = Number(/([\d.]+)px/.exec(this.font)?.[1] ?? 10);
    return { width: text.length * px * 0.6 };
  }
  fillText(text: string, x: number, y: number) {
    this.texts.push({ text, style: this.fillStyle, font: this.font, x, y });
  }
  /** What every read of pixels finds: a black picture unless a test paints another. */
  static pixels: (i: number) => [number, number, number] = () => [0, 0, 0];
  getImageData(_x: number, _y: number, w: number, h: number) {
    const data = new Uint8ClampedArray(Math.max(1, w * h) * 4);
    for (let i = 0; i < data.length / 4; i++) data.set([...Recorder.pixels(i), 255], i * 4);
    return { data, width: w, height: h };
  }
  createImageData(w: number, h: number) {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  }
  createPattern() {
    return null;
  }
  createLinearGradient() {
    return { addColorStop() {} };
  }
}
// Everything else a sticker may call (clip, translate, closePath, stroke …) does nothing here.
for (const name of ['clip', 'closePath', 'stroke', 'translate', 'rotate', 'drawImage', 'strokeText', 'arc', 'lineTo', 'setTransform', 'scale', 'putImageData']) {
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

const CARD: StickerGeometry = { widthMm: 85.6, heightMm: 54, bleedMm: 2, safeMm: 3, shape: 'rect' };
const K = 300 / 25.4;
const GREY: RGB = { r: 120, g: 140, b: 160 };
const palette: Palette = { dominant: GREY, vibrant: { r: 40, g: 120, b: 200 }, muted: GREY, dark: { r: 20, g: 30, b: 40 }, light: { r: 230, g: 235, b: 240 }, swatches: [] };

/** The cover is in the colour `base`, as its only swatch. */
function draw(item: Partial<StickerItem>, base: RGB, geometry = CARD, whole = false) {
  const full: StickerItem = { key: 'f5', title: 'Folge 1', number: '05', icon: Music, flatColor: '#0e76bd', picture: { kind: 'url', url: 'x' }, ...item };
  const image = new FakeCanvas(600, 600) as unknown as OffscreenCanvas;
  const canvas = renderSticker({ item: full, picture: { image, palette: { ...palette, swatches: [{ color: base, population: 1 }] }, base, generated: false }, design: { ...DEFAULT_DESIGN, style: 'tape', wholePicture: whole }, geometry, pxPerMm: K, font: stickerFont('round') });
  return (canvas as unknown as FakeCanvas).ctx;
}

/** The plate of the layout, in pixels of the sticker with its bleed. */
function platePx(g: StickerGeometry) {
  const p = stickerLayout(g, { style: 'tape', title: false, badge: true, logo: false, pictureAspect: 1 }).tape!.plate!;
  return { x: (p.x + g.bleedMm) * K, y: (p.y + g.bleedMm) * K, w: p.width * K, h: p.height * K };
}

const closeBox = (a: Fill['box'], b: Fill['box']) => {
  for (const key of ['x', 'y', 'w', 'h'] as const) expect(a[key]).toBeCloseTo(b[key], 6);
};

describe('the number plate of "Kassette"', () => {
  it('draws a known work in its own colours: band, light plate in its place, digits', () => {
    const work = workColorsByTitle('Die drei ???')!;
    const ctx = draw({ title: 'Die drei ??? 1', work }, fromHex(work.band!));
    // The spine reaches from the bleed's edge, in the band's colour.
    expect(ctx.rects.some((r) => r.style === toCss(fromHex('#141414')) && r.box.x === 0 && r.box.y === 0)).toBe(true);
    const plate = ctx.fills.find((f) => f.style === toCss(fromHex(work.plate)));
    expect(plate).toBeDefined();
    closeBox(plate!.box, platePx(CARD));
    const digits = ctx.texts.find((t) => t.text === '05')!;
    expect(digits.style).toBe(toCss(fromHex(work.digits)));
    // In the middle of the plate.
    expect(digits.x).toBeCloseTo(plate!.box.x + plate!.box.w / 2, 0);
    expect(digits.y).toBeGreaterThan(plate!.box.y);
    expect(digits.y).toBeLessThan(plate!.box.y + plate!.box.h);
    // No yellow dot any more.
    expect(ctx.fills.some((f) => f.style === toCss(fromHex('#fdd459')))).toBe(false);
  });

  it('puts the plate in the head band of a portrait sticker, exactly as laid out', () => {
    const portrait: StickerGeometry = { ...CARD, widthMm: CARD.heightMm, heightMm: CARD.widthMm };
    const work = workColorsByTitle('Pumuckl')!;
    const ctx = draw({ title: 'Pumuckl', work }, fromHex(work.band!), portrait);
    closeBox(ctx.fills.find((f) => f.style === toCss(fromHex(work.plate)))!.box, platePx(portrait));
    expect(ctx.texts.find((t) => t.text === '05')!.style).toBe(toCss(fromHex(work.digits)));
  });

  it('takes the colours of an unknown work from its cover: a light plate, readable digits', () => {
    const base = { r: 40, g: 120, b: 200 };
    const ctx = draw({ title: 'Urlaub am Meer' }, base);
    const c = tapeColors(base);
    expect(luminance(c.plate)).toBeGreaterThan(0.85);
    expect(contrast(c.digits, c.plate)).toBeGreaterThanOrEqual(4.5);
    closeBox(ctx.fills.find((f) => f.style === toCss(c.plate))!.box, platePx(CARD));
    expect(ctx.texts.find((t) => t.text === '05')!.style).toBe(toCss(c.digits));
  });

  it('follows a colour chosen for the sticker, not the work', () => {
    const work = workColorsByTitle('Die drei ???')!;
    const chosen = fromHex('#2a9d8f');
    const ctx = draw({ title: 'Die drei ??? 1', work, color: '#2a9d8f' }, chosen);
    const own = tapeColors(chosen);
    // The spine in the chosen colour, a touch darker where white writing needs it.
    expect(ctx.rects.some((r) => r.style === toCss(own.band))).toBe(true);
    expect(contrast(own.band, chosen)).toBeLessThan(1.5);
    expect(ctx.texts.find((t) => t.text === '05')!.style).toBe(toCss(own.digits));
    expect(own.digits).not.toEqual(fromHex(work.digits));
  });

  it('writes folder and tracks of an episode as large as a number alone, on a plate wide enough for them', () => {
    const px = (t: Text) => Number(/([\d.]+)px/.exec(t.font)![1]);
    for (const g of [CARD, { ...CARD, widthMm: CARD.heightMm, heightMm: CARD.widthMm }]) {
      const base = { r: 40, g: 120, b: 200 };
      const c = tapeColors(base);
      const alone = draw({ title: 'Folge 1' }, base, g);
      const episode = draw({ title: 'Folge 1', part: '12–24' }, base, g);
      const number = alone.texts.find((t) => t.text === '05')!;
      const both = episode.texts.find((t) => t.text === '05 · 12–24')!;
      expect(both).toBeDefined();
      expect(px(both)).toBeCloseTo(px(number), 6);
      const plate = episode.fills.find((f) => f.style === toCss(c.plate))!.box;
      // Wider than the plate of a number, inside the sticker, and the text fits on it.
      expect(plate.w).toBeGreaterThan(platePx(g).w * 1.5);
      expect(plate.x + plate.w).toBeLessThan((g.widthMm + g.bleedMm) * K);
      expect(both.text.length * px(both) * 0.6).toBeLessThan(plate.w);
    }
  });
});

describe('the side next to the cover of "Kassette"', () => {
  /** The flap: a rectangle from the cover to the sticker's right edge, over its whole height with the bleed. */
  const flap = (ctx: Recorder) => ctx.rects.filter((r) => Math.abs(r.box.x + r.box.w - (CARD.widthMm + 2 * CARD.bleedMm) * K) < 1 && r.box.x > 0 && r.box.y === 0 && r.box.h >= (CARD.heightMm + 2 * CARD.bleedMm) * K - 1).pop();

  it('carries on a calm cover edge in its own colour', () => {
    Recorder.pixels = () => [250, 230, 10];
    try {
      const ctx = draw({ title: 'Zehn kleine Zappelmänner' }, { r: 200, g: 40, b: 120 }, CARD, true);
      expect(flap(ctx)?.style).toBe(toCss({ r: 250, g: 230, b: 10 }));
    } finally {
      Recorder.pixels = () => [0, 0, 0];
    }
  });

  it('sets a light tint of the cover colour beside a busy edge, with a white line at the cover like the spine', () => {
    Recorder.pixels = (i) => (i % 2 ? [250, 250, 250] : [10, 60, 200]);
    try {
      const orange = { r: 200, g: 90, b: 30 };
      const ctx = draw({ title: 'Spuckepack' }, orange, CARD, true);
      const field = flap(ctx);
      // A fifth of the cover's colour in white: light, and still clearly orange.
      expect(field?.style).toBe(toCss(mix(orange, WHITE, 0.8)));
      // The line: narrow, white, full height, right at the cover.
      expect(ctx.rects.some((r) => r.box.x === field!.box.x && r.box.w <= 0.7 * K && r.box.h === field!.box.h && r.style === toCss(WHITE))).toBe(true);
    } finally {
      Recorder.pixels = () => [0, 0, 0];
    }
  });

  it('takes the colour of the spine next to a busy edge when the sticker wants one colour', () => {
    Recorder.pixels = (i) => (i % 2 ? [250, 250, 250] : [10, 60, 200]);
    try {
      const work = workColorsByTitle('Die drei ???')!;
      const ctx = draw({ title: 'Die drei ??? 1', work }, fromHex(work.band!), CARD, true);
      expect(flap(ctx)?.style).toBe(toCss(fromHex('#141414')));
    } finally {
      Recorder.pixels = () => [0, 0, 0];
    }
  });

  it('takes plain white beside a pale, colourless edge, not its creamy tint', () => {
    Recorder.pixels = () => [244, 244, 236];
    try {
      const ctx = draw({ title: 'LiBaTiBa' }, { r: 120, g: 170, b: 220 }, CARD, true);
      expect(flap(ctx)?.style).toBe(toCss(WHITE));
    } finally {
      Recorder.pixels = () => [0, 0, 0];
    }
  });
});

describe('one number and the flap line (audit 20.10.2026, TODO #91)', () => {
  const story = { series: 'Bibi & Tina, Folge 50', subtitle: 'Bibi & Tina, Folge 50', length: { tracks: 12, durationSec: 44 * 60, story: true } };
  const plain = (s: string) => s.replace(/ /g, ' ');

  it('names the series on the spine without the episode, which moves under the title with the running time', () => {
    for (const g of [CARD, { ...CARD, widthMm: CARD.heightMm, heightMm: CARD.widthMm }]) {
      const ctx = draw({ title: 'Das Kürbisfest', ...story }, { r: 226, g: 0, b: 122 }, g);
      const texts = ctx.texts.map((t) => plain(t.text));
      expect(texts).toContain('Bibi & Tina');
      expect(texts.some((t) => /Folge 50,|· 50$/.test(t))).toBe(false);
      // Under the title, maybe over two lines on a narrow flap.
      expect(texts.join(' ')).toContain('Kürbisfest Folge 50 · 44 Min.');
      // One number only: the folder's, on the plate.
      expect(texts.filter((t) => /^\d+$/.test(t))).toEqual(['05']);
    }
  });

  it('counts the songs of an album', () => {
    const ctx = draw({ title: 'Spuckepack', series: 'Sven van Thom', length: { tracks: 15, durationSec: 41 * 60, story: false } }, { r: 200, g: 90, b: 30 });
    expect(ctx.texts.map((t) => plain(t.text)).join(' ')).toContain('Spuckepack 15 Titel · 41 Min.');
  });

  it('keeps the episode on the spine when no title is shown', () => {
    const full: StickerItem = { key: 'f5', title: 'Das Kürbisfest', number: '05', icon: Music, flatColor: '#0e76bd', picture: { kind: 'url', url: 'x' }, ...story };
    const image = new FakeCanvas(600, 600) as unknown as OffscreenCanvas;
    const base = { r: 226, g: 0, b: 122 };
    const canvas = renderSticker({ item: full, picture: { image, palette: { ...palette, swatches: [{ color: base, population: 1 }] }, base, generated: false }, design: { ...DEFAULT_DESIGN, style: 'tape', showTitle: false }, geometry: CARD, pxPerMm: K, font: stickerFont('round') });
    const texts = (canvas as unknown as FakeCanvas).ctx.texts.map((t) => t.text);
    expect(texts.some((t) => t.includes('50'))).toBe(true);
  });
});

describe('the back of "Kassette" in the colours of its front (Frank 17.10.2026, audit 20.10.2026)', () => {
  const picture = (base: RGB) => ({ image: new FakeCanvas(600, 600) as unknown as OffscreenCanvas, palette: { ...palette, swatches: [{ color: base, population: 1 }] }, base, generated: false });
  const item: StickerItem = { key: 'f5', title: 'Spuckepack', number: '05', icon: Music, flatColor: '#0e76bd', picture: { kind: 'url', url: 'x' } };

  it('takes a light flap as its paper, the spine for the number, and stays easy to read', () => {
    Recorder.pixels = () => [250, 230, 10];
    try {
      const ink = backInk(item, picture({ r: 200, g: 40, b: 120 }));
      // The calm yellow edge runs on beside the cover: the back is that yellow.
      expect(ink.paper).toBe(toCss({ r: 250, g: 230, b: 10 }));
      expect(contrast(fromHex(cssHex(ink.text)), fromHex(cssHex(ink.paper)))).toBeGreaterThanOrEqual(7);
      expect(contrast(fromHex(cssHex(ink.soft)), fromHex(cssHex(ink.paper)))).toBeGreaterThanOrEqual(3);
    } finally {
      Recorder.pixels = () => [0, 0, 0];
    }
  });

  it('turns a dark front into a light tint of its spine, not a dark back', () => {
    const brown = { r: 58, g: 50, b: 40 };
    const ink = backInk(item, picture(brown));
    expect(luminance(fromHex(cssHex(ink.paper)))).toBeGreaterThan(0.6);
    // The number keeps the dark colour of the spine.
    expect(luminance(fromHex(cssHex(ink.plate)))).toBeLessThan(0.1);
    expect(contrast(fromHex(cssHex(ink.text)), fromHex(cssHex(ink.paper)))).toBeGreaterThanOrEqual(7);
  });

  it('draws the back with those colours; without them white as before', () => {
    const g: StickerGeometry = { ...CARD, bleedMm: 0 };
    const ink = { ...WHITE_BACK, paper: '#fde2e4', plate: '#e2007a', text: '#5a0030' };
    const c = (renderBack({ number: '05', heading: 'Das Kürbisfest', tracks: [{ number: 1, title: 'Teil 1' }] }, 'list', g, K, stickerFont('round'), ink) as unknown as FakeCanvas).ctx;
    expect(c.rects[0].style).toBe('#fde2e4');
    expect(c.fills.some((f) => f.style === '#e2007a')).toBe(true);
    expect(c.texts.find((t) => t.text === 'Das Kürbisfest')!.style).toBe('#5a0030');
    const white = (renderBack({ heading: 'Admin-Karte', text: 'Öffnet das Admin-Menü.' }, 'list', g, K, stickerFont('round')) as unknown as FakeCanvas).ctx;
    expect(white.rects[0].style).toBe('#ffffff');
  });

  it('draws the QR code of the back once its library is loaded (it comes as its own file)', async () => {
    const g: StickerGeometry = { ...CARD, bleedMm: 0 };
    await loadBackQr();
    const c = (renderBack({ number: '05', heading: 'Das Kürbisfest', tracks: [{ number: 1, title: 'Teil 1' }] }, 'qr', g, K, stickerFont('round')) as unknown as FakeCanvas).ctx;
    // White square, then a dark cell for every set module (a version-1 code alone has more than 100).
    expect(c.rects.filter((r) => r.style === '#ffffff').length).toBeGreaterThan(0);
    expect(c.rects.filter((r) => r.style !== '#ffffff').length).toBeGreaterThan(100);
    expect(c.texts.map((t) => t.text).join(' ')).toMatch(/1 Titel\./);
  });

  it('names the source of a pictogram in a fine line at the foot, below everything else', () => {
    const g: StickerGeometry = { ...CARD, bleedMm: 0 };
    const credit = 'Piktogramm: Sergio Palao, ARASAAC (arasaac.org), CC BY-NC-SA';
    const c = (renderBack({ heading: 'Tiere', text: 'Spielt den ganzen Ordner.', credit }, 'list', g, K, stickerFont('round')) as unknown as FakeCanvas).ctx;
    const line = c.texts.find((t) => t.text === credit)!;
    expect(line).toBeDefined();
    expect(Math.max(...c.texts.filter((t) => t.text !== credit).map((t) => t.y))).toBeLessThan(line.y);
    expect(line.y).toBeLessThanOrEqual(g.heightMm * K);
  });
});

describe('a series in its own type', () => {
  const work = workColorsByTitle('Die drei ???')!;

  it('writes a detective series of EUROPA narrow and black on "Kassette", "Klassisch" and "Vollbild", unless another font was chosen', () => {
    expect(work.font).toBe('detective');
    expect(fontFor({ work }, { ...DEFAULT_DESIGN, style: 'tape' })).toBe('detective');
    expect(fontFor({ work }, { ...DEFAULT_DESIGN, style: 'tape', font: 'comic' })).toBe('comic');
    // Better there too in the blind audit of 20.10.2026; "Bildkarte" keeps the chosen font for its word.
    expect(fontFor({ work }, { ...DEFAULT_DESIGN, style: 'full' })).toBe('detective');
    expect(fontFor({ work }, { ...DEFAULT_DESIGN, style: 'blur' })).toBe('detective');
    expect(fontFor({ work }, { ...DEFAULT_DESIGN, style: 'blur', font: 'book' })).toBe('book');
    expect(fontFor({ work }, { ...DEFAULT_DESIGN, style: 'bild' })).toBe(DEFAULT_DESIGN.font);
    expect(fontFor({ work: workColorsByTitle('Bibi & Tina') }, { ...DEFAULT_DESIGN, style: 'tape' })).toBe(DEFAULT_DESIGN.font);
  });
});

/** "rgb(r g b)" or "#rrggbb" as "#rrggbb". */
function cssHex(css: string): string {
  if (css.startsWith('#')) return css;
  const [r, g, b] = (css.match(/\d+(\.\d+)?/g) ?? []).map(Number);
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

describe('the flap line upright', () => {
  it('stands on the row of the logo, left of it, also under a title of two lines', () => {
    const portrait: StickerGeometry = { ...CARD, widthMm: 50.8, heightMm: 83.8 };
    const item: StickerItem = { key: 'f4', title: 'Zehn kleine Zappelmänner', series: 'Schnabi Schnabel', number: '04', icon: Music, flatColor: '#0e76bd', picture: { kind: 'url', url: 'x' }, length: { tracks: 22, durationSec: 48 * 60, story: false } };
    const base = { r: 200, g: 40, b: 120 };
    const logo = new FakeCanvas(2379, 425) as unknown as OffscreenCanvas;
    const canvas = renderSticker({ item, picture: { image: new FakeCanvas(600, 600) as unknown as OffscreenCanvas, palette: { ...palette, swatches: [{ color: base, population: 1 }] }, base, generated: false }, design: { ...DEFAULT_DESIGN, style: 'tape' }, geometry: portrait, pxPerMm: K, font: stickerFont('round'), logo });
    const ctx = (canvas as unknown as FakeCanvas).ctx;
    const line = ctx.texts.find((t) => t.text.replace(/ /g, ' ') === '22 Titel · 48 Min.')!;
    expect(line).toBeDefined();
    const l = stickerLayout(portrait, { style: 'tape', title: true, badge: true, logo: true, pictureAspect: 1 }).logo!;
    // On the logo's foot line, at the left edge of the title.
    expect(line.y).toBeCloseTo((l.y + l.height + portrait.bleedMm) * K, -1);
    expect(line.x).toBeCloseTo((portrait.safeMm + portrait.bleedMm) * K, 0);
    // Below every line of the title.
    for (const t of ctx.texts.filter((t) => /Zehn|Zappel/.test(t.text))) expect(t.y).toBeLessThan(line.y);
  });
});
