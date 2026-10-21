/**
 * Stickers of folders without a picture: the picture drawn for them, how it
 * is cached, and what the design's switches do to it.
 */
import { describe, expect, it } from 'vitest';
import { Music } from 'lucide-preact';
import { contrast, fromHex } from '../../src/core/stickers/color';
import { COVER_COLORS } from '../../src/ui/components/Cover';
import { GENERATED_EDGE, generatedKey, measureTitleStrip, symbolBox, type GeneratedLook, type StickerItem } from '../../src/features/stickers/content';
import { DEFAULT_DESIGN } from '../../src/features/stickers/design';
import { badgeText, stickerZoom } from '../../src/features/stickers/render';

const folder = (number: string, title: string, flatColor = '#0e76bd'): StickerItem => ({ key: `f${number}`, title, number, icon: Music, flatColor });
const look = (over: Partial<GeneratedLook> = {}): GeneratedLook => ({ strip: false, number: true, edge: GENERATED_EDGE.print, ...over });

describe('the cache key of a generated picture', () => {
  it('holds only what is drawn: equal stickers share one picture', () => {
    expect(generatedKey(folder('03', 'Pumuckl'), look())).toBe(generatedKey(folder('03', 'Ein anderer Titel'), look()));
    expect(generatedKey(folder('03', 'A'), look())).not.toBe(generatedKey(folder('04', 'A'), look()));
    expect(generatedKey(folder('03', 'A', '#f7941d'), look())).not.toBe(generatedKey(folder('03', 'A'), look()));
  });

  it('shares one picture per colour when numbers are hidden', () => {
    expect(generatedKey(folder('03', 'A'), look({ number: false }))).toBe(generatedKey(folder('17', 'B'), look({ number: false })));
    expect(generatedKey(folder('03', 'A'), look({ number: false }))).not.toBe(generatedKey(folder('03', 'A'), look()));
  });

  it('adds the title only with the title strip', () => {
    expect(generatedKey(folder('03', 'A'), look({ strip: true }))).not.toBe(generatedKey(folder('03', 'B'), look({ strip: true })));
    expect(generatedKey(folder('03', 'A'), look({ strip: true }))).not.toBe(generatedKey(folder('03', 'A'), look()));
  });

  it('gives special cards the title strip too, so the admin card says what it is', () => {
    const special = (title: string): StickerItem => ({ key: 'admin', title, icon: Music, flatColor: '#8c6238' });
    expect(generatedKey(special('Admin-Karte'), look({ strip: true }))).toContain('Admin-Karte');
    expect(generatedKey(special('Admin-Karte'), look({ strip: true }))).not.toBe(generatedKey(special('Nochmal'), look({ strip: true })));
    expect(generatedKey(special('Admin-Karte'), look())).toBe(generatedKey(special('Nochmal'), look()));
  });

  it('keeps previews and print apart, previews at a quarter of the pixels', () => {
    expect(generatedKey(folder('03', 'A'), look({ edge: GENERATED_EDGE.preview }))).not.toBe(generatedKey(folder('03', 'A'), look()));
    expect(GENERATED_EDGE.preview ** 2 * 4).toBe(GENERATED_EDGE.print ** 2);
  });
});

describe('a sticker without a picture', () => {
  const item = folder('05', 'Alice im Wunderland');

  it('has no number badge: the number is written on the picture, or hidden', () => {
    expect(badgeText(item, { ...DEFAULT_DESIGN, showNumber: true })).toBeUndefined();
    expect(badgeText(item, { ...DEFAULT_DESIGN, showNumber: false })).toBeUndefined();
    expect(badgeText({ ...item, picture: { kind: 'url', url: 'x' } }, { ...DEFAULT_DESIGN, showNumber: true })).toBe('05');
  });

  it('shows its generated picture whole, so number and title strip are never cut off', () => {
    expect(stickerZoom(item, { ...DEFAULT_DESIGN, wholePicture: false })).toBe(0);
    // Also with a zoom saved for a cover that is gone since.
    expect(stickerZoom({ ...item, zoom: 2 }, { ...DEFAULT_DESIGN, wholePicture: false })).toBe(0);
    expect(stickerZoom({ ...item, picture: { kind: 'url', url: 'x' } }, { ...DEFAULT_DESIGN, wholePicture: false })).toBe(1);
  });
});

describe('the folder colours', () => {
  it('each come with an ink that reads on them (WCAG AA, 4.5:1)', () => {
    for (const c of COVER_COLORS) expect(contrast(fromHex(c.bg), fromHex(c.fg)), c.bg).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the symbol of a special card', () => {
  const size = 1000;
  // Like the strip font: about half the font size per letter.
  const ctx = {
    font: '',
    measureText(text: string) {
      return { width: text.length * 0.5 * Number(/^(\d+)px/.exec(this.font)?.[1] ?? 0) };
    },
  };
  const stripTop = (strip: { w: number; h: number }) => size * 0.91 - strip.h - strip.w * Math.sin((2 * Math.PI) / 180);

  it('stays where it was above a one-line name', () => {
    const strip = measureTitleStrip(ctx, 'Pause', size);
    expect(strip.lines).toHaveLength(1);
    expect(symbolBox(size, strip)).toEqual({ x: size * 0.28, y: size * 0.16, side: size * 0.44 });
  });

  it('moves up above a two-line name instead of being covered by it', () => {
    const strip = measureTitleStrip(ctx, 'Feuer, Wasser, Luft', size);
    expect(strip.lines).toHaveLength(2);
    const box = symbolBox(size, strip);
    expect(box.y + box.side).toBeLessThanOrEqual(stripTop(strip));
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.side).toBeGreaterThan(size * 0.3);
    expect(box.x + box.side / 2).toBeCloseTo(size / 2);
  });

  it('is bigger and in the middle without a strip', () => {
    expect(symbolBox(size)).toEqual({ x: size * 0.24, y: size * 0.24, side: size * 0.52 });
  });
});
