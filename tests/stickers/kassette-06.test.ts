/**
 * "Kassette" in 0.6 (TODO #114, #117, #118, #127): one clear type for the numbers, the series' band only
 * where it suits the episode's cover, the logo always at the foot of the flap, and the flap's title
 * without the series the spine names already, in as many lines as the flap holds.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Music } from 'lucide-preact';
import { fromHex, toCss, type Palette, type RGB } from '../../src/core/stickers/color';
import { stickerLayout, type StickerGeometry } from '../../src/core/stickers/layout';
import { workColorsByTitle } from '../../src/core/stickers/works';
import type { StickerItem } from '../../src/features/stickers/content';
import { DEFAULT_DESIGN } from '../../src/features/stickers/design';
import { stickerFont } from '../../src/features/stickers/fonts';
import { renderSticker } from '../../src/features/stickers/render';
import { bandFitsCover, withoutSeries } from '../../src/features/stickers/tape';

describe('withoutSeries', () => {
  it('takes the series and its episode off the start of a title made from a file name', () => {
    expect(withoutSeries('Bibi und Tina, Folge 61 Bibi und Tina retten die Biber', ['Bibi & Tina'])).toBe('Bibi und Tina retten die Biber');
    expect(withoutSeries('Benjamin Blümchen - Geburtstag im Zoo - Die Mini Hörspielserie für ganz Kleine', ['Benjamin Blümchen'])).toBe('Geburtstag im Zoo - Die Mini Hörspielserie für ganz Kleine');
    expect(withoutSeries('TKKG: 12 - Die Jagd nach den Millionendieben', [undefined, 'TKKG'])).toBe('Die Jagd nach den Millionendieben');
    expect(withoutSeries('Bibi & Tina, Das Kürbisfest', ['Bibi und Tina'])).toBe('Das Kürbisfest');
  });

  it('keeps a title whose series is part of the words, or that would be nothing without it', () => {
    expect(withoutSeries('Bibi und Tina retten die Biber', ['Bibi & Tina'])).toBe('Bibi und Tina retten die Biber');
    expect(withoutSeries('Die drei ??? und der Super-Papagei', ['Die drei ???'])).toBe('Die drei ??? und der Super-Papagei');
    expect(withoutSeries('Unter meinem Bett 8', ['Unter meinem Bett'])).toBe('Unter meinem Bett 8');
    expect(withoutSeries('Conni - 5', ['Conni'])).toBe('Conni - 5');
    expect(withoutSeries('Das Kürbisfest', [])).toBe('Das Kürbisfest');
  });
});

describe('bandFitsCover', () => {
  const pink = fromHex('#e2007a');
  const pal = (swatches: [string, number][]): Palette => {
    const s = swatches.map(([c, population]) => ({ color: fromHex(c), population }));
    return { dominant: s[0].color, vibrant: s[0].color, muted: s[0].color, dark: s[0].color, light: s[0].color, swatches: s };
  };

  it('keeps the pink of Bibi & Tina beside a cover with reds and pinks', () => {
    const autumn = pal([['#ead46f', 0.18], ['#c7a33e', 0.16], ['#b12429', 0.11], ['#cb979e', 0.11], ['#f8f5e8', 0.12]]);
    expect(bandFitsCover(pink, autumn, fromHex('#ead46f'))).toBe(true);
  });

  it('drops it beside a green cover with only a small pink logo', () => {
    const meadow = pal([['#60a03c', 0.5], ['#aad7f0', 0.32], ['#785028', 0.09], ['#e3187f', 0.02]]);
    expect(bandFitsCover(pink, meadow, fromHex('#60a03c'))).toBe(false);
  });

  it('keeps a black band on a dark cover, and any band the cover would choose anyway', () => {
    const night = pal([['#141416', 0.7], ['#3c465a', 0.2], ['#c8a03c', 0.1]]);
    expect(bandFitsCover(fromHex('#141414'), night, fromHex('#3c465a'))).toBe(true);
    expect(bandFitsCover(pink, pal([['#60a03c', 1]]), fromHex('#e0107a'))).toBe(true);
  });
});

describe('the flap of a landscape cassette sticker', () => {
  const g: StickerGeometry = { widthMm: 83.8, heightMm: 50.8, bleedMm: 0, safeMm: 2.5, shape: 'rect' };
  it('has the logo at its foot in the same corner with and without a title', () => {
    const titled = stickerLayout(g, { style: 'tape', title: true, badge: true, logo: true, pictureAspect: 1 });
    const bare = stickerLayout(g, { style: 'tape', title: false, badge: true, logo: true, pictureAspect: 1 });
    for (const l of [titled, bare]) {
      expect(l.logo!.valign).toBe('bottom');
      expect(l.logo!.align).toBe('left');
      expect(l.logo!.y + l.logo!.height).toBeCloseTo(g.heightMm - g.safeMm, 6);
    }
    expect(bare.logo!.height).toBeCloseTo(titled.logo!.height, 6);
  });

  it('lets a long title take as many lines as the flap holds', () => {
    const l = stickerLayout(g, { style: 'tape', title: true, badge: true, logo: true, pictureAspect: 1 });
    expect(l.text!.maxLines).toBeGreaterThanOrEqual(7);
  });
});

/* ------------------------------------------------------------------ drawing */

interface Text {
  text: string;
  style: string;
  font: string;
}

/** A 2D context that draws nothing and remembers texts and fill colours. */
function recorder(canvas: { width: number; height: number }) {
  const texts: Text[] = [];
  const fills: string[] = [];
  const state: Record<string, unknown> = { fillStyle: '#000', font: '10px sans-serif', canvas };
  const stack: Record<string, unknown>[] = [];
  const methods: Record<string, (...a: never[]) => unknown> = {
    save: () => stack.push({ ...state }),
    restore: () => Object.assign(state, stack.pop()),
    fillText: (text: string) => texts.push({ text, style: String(state.fillStyle), font: String(state.font) }),
    fillRect: () => fills.push(String(state.fillStyle)),
    fill: () => fills.push(String(state.fillStyle)),
    measureText: (text: string) => ({ width: text.length * Number(/([\d.]+)px/.exec(String(state.font))?.[1] ?? 10) * 0.6 }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(1, w * h) * 4).fill(255), width: w, height: h }),
    createLinearGradient: () => ({ addColorStop() {} }),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  };
  const ctx = new Proxy(state, {
    get: (t, key: string) => (key in methods ? methods[key] : key in t ? t[key] : () => undefined),
    set: (t, key: string, v) => ((t[key] = v), true),
  });
  return { ctx, texts, fills };
}

class FakeCanvas {
  rec: ReturnType<typeof recorder>;
  constructor(
    public width: number,
    public height: number,
  ) {
    this.rec = recorder(this);
  }
  getContext() {
    return this.rec.ctx;
  }
}

beforeAll(() => vi.stubGlobal('OffscreenCanvas', FakeCanvas));
afterAll(() => vi.unstubAllGlobals());

const G: StickerGeometry = { widthMm: 83.8, heightMm: 50.8, bleedMm: 1.5, safeMm: 2.5, shape: 'rect' };

function draw(item: Partial<StickerItem>, swatches: [RGB, number][], numberFont = stickerFont('round')) {
  const full: StickerItem = { key: 'f5', title: 'Folge 1', number: '05', icon: Music, flatColor: '#0e76bd', picture: { kind: 'url', url: 'x' }, ...item };
  const image = new FakeCanvas(600, 600) as unknown as OffscreenCanvas;
  const s = swatches.map(([color, population]) => ({ color, population }));
  const palette: Palette = { dominant: s[0].color, vibrant: s[0].color, muted: s[0].color, dark: { r: 20, g: 20, b: 20 }, light: { r: 240, g: 240, b: 240 }, swatches: s };
  const base = item.work?.band ? fromHex(item.work.band) : s[0].color;
  const canvas = renderSticker({ item: full, picture: { image, palette, base, generated: false }, design: { ...DEFAULT_DESIGN, style: 'tape' }, geometry: G, pxPerMm: 300 / 25.4, font: stickerFont('storybook'), numberFont });
  return (canvas as unknown as FakeCanvas).rec;
}

describe('a cassette sticker drawn', () => {
  const green: [RGB, number][] = [[fromHex('#60a03c'), 0.6], [fromHex('#aad7f0'), 0.38], [fromHex('#e3187f'), 0.02]];
  const pinkCover: [RGB, number][] = [[fromHex('#e2007a'), 0.5], [fromHex('#f8f5e8'), 0.5]];

  it('writes the number in the one number font, not in the title font of the series', () => {
    const r = draw({ title: 'Das Schlossgespenst' }, green);
    const digits = r.texts.find((t) => t.text === '05')!;
    expect(digits.font).toContain(stickerFont('round').title.family);
    expect(r.texts.find((t) => t.text.startsWith('Das'))!.font).toContain(stickerFont('storybook').title.family);
  });

  it('keeps the band of Bibi & Tina on a pink cover and leaves it off a green one', () => {
    const work = workColorsByTitle('Bibi & Tina')!;
    const band = toCss(fromHex(work.band!));
    expect(draw({ title: 'Das Kürbisfest', series: 'Bibi & Tina, Folge 50', work }, pinkCover).fills).toContain(band);
    expect(draw({ title: 'Der Pferdedieb', series: 'Bibi & Tina, Folge 61', work }, green).fills).not.toContain(band);
  });

  it('names the series on the spine and leaves it out of the flap title', () => {
    const work = workColorsByTitle('Benjamin Blümchen')!;
    const r = draw({ title: 'Benjamin Blümchen - Geburtstag im Zoo', work }, [[fromHex('#2f8ad3'), 1]]);
    const all = r.texts.map((t) => t.text);
    expect(all).toContain('Benjamin Blümchen');
    expect(all.join(' ')).toContain('Geburtstag');
    expect(all.some((t) => t.includes('Blümchen -'))).toBe(false);
  });
});
