/**
 * The hint about pictures too small to print sharply counts with the size a
 * picture is drawn with: at most 2048 pixels long, however big the file is.
 */
import { describe, expect, it } from 'vitest';
import { MAX_PICTURE_EDGE, placedDpi, usedPictureSize } from '../../src/core/stickers/image';
import { blurryHint } from '../../src/features/stickers/blurry';

describe('the size a picture is printed with', () => {
  it('is at most 2048 pixels long', () => {
    expect(MAX_PICTURE_EDGE).toBe(2048);
    expect(usedPictureSize({ width: 8000, height: 6000 })).toEqual({ width: 2048, height: 1536 });
    expect(usedPictureSize({ width: 600, height: 600 })).toEqual({ width: 600, height: 600 });
  });

  it('decides whether a strongly zoomed photo prints sharply', () => {
    // A 12-megapixel photo zoomed in three times on a 100 mm sticker: plenty by the file, too little as drawn.
    const box = 100;
    const zoom = { zoom: 3 };
    const file = placedDpi(4000, 3000, box, box, zoom);
    const drawn = usedPictureSize({ width: 4000, height: 3000 });
    const printed = placedDpi(drawn.width, drawn.height, box, box, zoom);
    expect(file).toBeGreaterThan(150);
    expect(printed).toBeLessThan(150);
  });
});

describe('what the hint says', () => {
  it('asks for a bigger picture of a size that helps', () => {
    expect(blurryHint({ width: 300, height: 300 }, 90, true, false)).toBe(
      'Das Bild ist zu klein für diesen Sticker und wird unscharf gedruckt. Nimm mit „Anderes Bild“ ein größeres, am besten mindestens 1000 Pixel breit.',
    );
    expect(blurryHint({ width: 300, height: 300 }, 90, false, false)).toContain('Füge ein größeres Bild hinzu, am besten mindestens 1000 Pixel breit.');
  });

  it('never asks for more pixels than a picture is drawn with', () => {
    // Only 20 dpi: sharp would need 4800 pixels, but more than 2048 are never used.
    expect(blurryHint({ width: 320, height: 320 }, 20, true, false)).toContain('mindestens 2048 Pixel breit');
    const wide = blurryHint({ width: 1000, height: 250 }, 20, true, false);
    expect(wide).toContain('mindestens 2048 Pixel breit');
  });

  it('says only to zoom out when the picture is as big as it gets', () => {
    expect(blurryHint({ width: 2048, height: 1536 }, 120, true, true)).toBe('Für diesen Ausschnitt ist das Bild zu klein und wird unscharf gedruckt. Ziehe „Größe“ weiter nach links.');
    expect(blurryHint({ width: 800, height: 800 }, 120, true, true)).toBe(
      'Für diesen Ausschnitt ist das Bild zu klein und wird unscharf gedruckt. Ziehe „Größe“ weiter nach links oder nimm mit „Anderes Bild“ ein größeres.',
    );
  });
});
