/** Which colours of a cover go where on a "Kassette" sticker (final audit 17.10.2026). */
import { describe, expect, it } from 'vitest';
import { colorDistance, contrast, fromHex, luminance, mix, paperOf, WHITE, type Palette, type RGB } from '../../src/core/stickers/color';
import { cassetteColors } from '../../src/features/stickers/tape';

const palette = (dominant: RGB, swatches: [string, number][]): Palette => ({
  dominant,
  vibrant: dominant,
  muted: dominant,
  dark: fromHex('#202020'),
  light: fromHex('#f4f0e8'),
  swatches: swatches.map(([hex, population]) => ({ color: fromHex(hex), population })),
});

describe('the colours of a cassette sticker', () => {
  it('sets a light tint of the cover colour beside a busy edge, with the title dark enough to read', () => {
    const magenta = fromHex('#e2007a');
    const c = cassetteColors({ palette: palette(fromHex('#f0c060'), [['#e2007a', 0.3], ['#f0c060', 0.2], ['#3a7bd5', 0.1]]) });
    expect(c.band).toEqual(magenta);
    expect(c.field).toEqual(mix(magenta, WHITE, 0.8));
    expect(contrast(c.onPaper, c.field)).toBeGreaterThanOrEqual(4.5);
    expect(colorDistance(c.onPaper, magenta)).toBeLessThan(0.25);
  });

  it('gives the spine the strongest other colour beside a coloured ground, not a soft one', () => {
    const yellow = fromHex('#feed02');
    const c = cassetteColors({ palette: palette(yellow, [['#feed02', 0.64], ['#ca746c', 0.2], ['#c92675', 0.03]]), calm: yellow });
    expect(c.field).toEqual(yellow);
    expect(colorDistance(c.band, fromHex('#c92675'))).toBeLessThan(0.05);
    expect(contrast(c.onPaper, yellow)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps a dark cover dark and writes light on it', () => {
    const c = cassetteColors({ palette: palette(fromHex('#2a2620'), [['#2a2620', 0.6], ['#5a5040', 0.3]]) });
    expect(luminance(c.field)).toBeLessThan(0.1);
    expect(contrast(c.onPaper, c.field)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the colour chosen for the sticker on the spine', () => {
    const own = fromHex('#2a9d8f');
    const c = cassetteColors({ palette: palette(fromHex('#feed02'), [['#feed02', 0.9]]), calm: fromHex('#feed02'), own });
    // A touch darker at most, for white writing on it.
    expect(colorDistance(c.band, own)).toBeLessThan(0.12);
  });
});

describe('a pale cover edge as paper', () => {
  it('turns greyish and creamy whites into white, softens a faint tint, and keeps real colours', () => {
    expect(paperOf(fromHex('#e4dadc'))).toEqual(WHITE);
    expect(paperOf(fromHex('#faf6ea'))).toEqual(WHITE);
    expect(paperOf(fromHex('#feed02'))).toEqual(fromHex('#feed02'));
    expect(paperOf(fromHex('#3a7bd5'))).toEqual(fromHex('#3a7bd5'));
  });
});
