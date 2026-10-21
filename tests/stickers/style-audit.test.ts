/**
 * What the sticker style audit of 20.10.2026 (TODO #91) kept, blind and at print size:
 * Klassisch writes the series or artist and the cassette's line ("Folge 50 · 44 Min.") under the
 * title, Vollbild always fills the sticker and its band has no light stripe above it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Music } from 'lucide-preact';
import { type Palette, type RGB } from '../../src/core/stickers/color';
import { stickerLayout, type StickerGeometry } from '../../src/core/stickers/layout';
import type { StickerItem } from '../../src/features/stickers/content';
import { DEFAULT_DESIGN, type StickerDesign } from '../../src/features/stickers/design';
import { stickerFont } from '../../src/features/stickers/fonts';
import { designZoom, renderSticker, stickerZoom } from '../../src/features/stickers/render';

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

const LABEL: StickerGeometry = { widthMm: 83.8, heightMm: 50.8, bleedMm: 2, safeMm: 3, shape: 'rect' };
const K = 300 / 25.4;
const GREY: RGB = { r: 120, g: 140, b: 160 };
const palette: Palette = { dominant: GREY, vibrant: { r: 40, g: 120, b: 200 }, muted: GREY, dark: { r: 20, g: 30, b: 40 }, light: { r: 230, g: 235, b: 240 }, swatches: [{ color: GREY, population: 1 }] };

/** The fake font is wide (0.6 em a letter): short titles keep each text on one line. */
function draw(item: Partial<StickerItem>, design: Partial<StickerDesign>) {
  const full: StickerItem = { key: 'f1', title: 'Das Kürbisfest', number: '01', icon: Music, flatColor: '#0e76bd', picture: { kind: 'url', url: 'x' }, ...item };
  const image = new FakeCanvas(600, 600) as unknown as OffscreenCanvas;
  const canvas = renderSticker({ item: full, picture: { image, palette, base: GREY, generated: false }, design: { ...DEFAULT_DESIGN, ...design }, geometry: LABEL, pxPerMm: K, font: stickerFont('round') });
  return (canvas as unknown as FakeCanvas).ctx;
}

const BIBI: Partial<StickerItem> = { title: 'Fest', subtitle: 'Bibi & Tina, Folge 50', series: 'Bibi & Tina, Folge 50', length: { tracks: 12, durationSec: 44 * 60, story: true } };

describe('Klassisch: the lines under the title', () => {
  it('names the series without the episode, then episode and running time in one line', () => {
    const texts = draw(BIBI, { style: 'blur' }).texts.map((t) => t.text);
    expect(texts).toContain('Fest');
    expect(texts).toContain('Bibi & Tina');
    expect(texts.some((t) => t.replace(/\u00a0/g, ' ') === 'Folge 50 · 44 Min.')).toBe(true);
    expect(texts.some((t) => t.includes('Bibi & Tina,'))).toBe(false);
  });

  it('does not repeat what the title says', () => {
    const texts = draw({ title: 'Bett 8', subtitle: 'Bett, Folge 8', series: 'Bett, Folge 8', length: { tracks: 9, durationSec: 46 * 60, story: false } }, { style: 'blur' }).texts.map((t) => t.text.replace(/\u00a0/g, ' '));
    expect(texts).not.toContain('Bett');
    expect(texts).toContain('Folge 8 · 46 Min.');
  });

  it('counts the songs of an album', () => {
    const texts = draw({ title: 'Herd', subtitle: 'Zaches', length: { tracks: 14, durationSec: 52 * 60, story: false } }, { style: 'blur' }).texts.map((t) => t.text.replace(/\u00a0/g, ' '));
    expect(texts).toContain('Zaches');
    expect(texts).toContain('14 Titel · 52 Min.');
  });

  it('a further card of a folder keeps its own subtitle', () => {
    const texts = draw({ ...BIBI, part: '3–5', subtitle: 'Das Kürbisfest' }, { style: 'blur' }).texts.map((t) => t.text);
    expect(texts.some((t) => t.includes('Min.'))).toBe(false);
  });
});

describe('Vollbild: the cover fills the sticker', () => {
  it('fills whatever "Ganz gezeigt" says; the other styles follow it', () => {
    expect(designZoom({ style: 'full', wholePicture: true })).toBe(1);
    expect(designZoom({ style: 'full', wholePicture: false })).toBe(1);
    expect(designZoom({ style: 'blur', wholePicture: true })).toBe(0);
    expect(designZoom({ style: 'tape', wholePicture: false })).toBe(1);
  });

  it("a sticker's own zoom still wins, a sticker without a picture is shown whole", () => {
    const d = { ...DEFAULT_DESIGN, style: 'full' as const, wholePicture: true };
    expect(stickerZoom({ key: 'a', title: 'x', icon: Music, flatColor: '#000000', picture: { kind: 'url', url: 'x' } }, d)).toBe(1);
    expect(stickerZoom({ key: 'a', title: 'x', icon: Music, flatColor: '#000000', picture: { kind: 'url', url: 'x' }, zoom: 0.4 }, d)).toBe(0.4);
    expect(stickerZoom({ key: 'a', title: 'x', icon: Music, flatColor: '#000000' }, d)).toBe(0);
  });

  it('draws the band straight against the picture, without a light stripe above it', () => {
    const layout = stickerLayout(LABEL, { style: 'full', title: true, badge: true, logo: false, pictureAspect: 1 });
    const bandTop = (layout.band!.y + LABEL.bleedMm) * K;
    const ctx = draw(BIBI, { style: 'full', logo: 'none' });
    // Nothing is filled in the few millimetres over the band (the picture is drawn, not filled).
    expect(ctx.rects.filter((r) => r.box.y < bandTop - 0.5 && r.box.y + r.box.h > bandTop - 4 * K && r.box.w > LABEL.widthMm * K * 0.9)).toEqual([]);
  });
});
