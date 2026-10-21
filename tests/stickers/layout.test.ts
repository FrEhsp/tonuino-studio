import { describe, expect, it } from 'vitest';
import { placePicture } from '../../src/core/stickers/image';
import { orientGeometry, pictureFrame, placementBox, stickerLayout, stickerOrientation, type StickerGeometry } from '../../src/core/stickers/layout';

const herma: StickerGeometry = { widthMm: 83.8, heightMm: 50.8, bleedMm: 1.5, safeMm: 2.5, shape: 'rect' };
const round: StickerGeometry = { widthMm: 30, heightMm: 30, bleedMm: 1.5, safeMm: 2.5, shape: 'round' };

describe('sticker orientation', () => {
  it('follows the sticker, then the design', () => {
    expect(stickerOrientation(undefined, 'landscape', 0.5)).toBe('landscape');
    expect(stickerOrientation(undefined, 'portrait', 1.8)).toBe('portrait');
    expect(stickerOrientation('portrait', 'landscape', 1.8)).toBe('portrait');
    expect(stickerOrientation('landscape', 'auto', 0.5)).toBe('landscape');
  });

  it('turns stickers like their pictures in "auto"', () => {
    // Portrait drawing (3:4) and photo (2:3): portrait. Square covers and landscape photos: landscape.
    expect(stickerOrientation(undefined, 'auto', 3 / 4)).toBe('portrait');
    expect(stickerOrientation(undefined, 'auto', 2 / 3)).toBe('portrait');
    expect(stickerOrientation(undefined, 'auto', 1)).toBe('landscape');
    expect(stickerOrientation(undefined, 'auto', 0.95)).toBe('landscape');
    expect(stickerOrientation(undefined, 'auto', 16 / 9)).toBe('landscape');
    expect(stickerOrientation(undefined, 'auto', Number.NaN)).toBe('landscape');
  });

  it('swaps width and height for portrait, never for round or square labels', () => {
    expect(orientGeometry(herma, 'portrait')).toEqual({ ...herma, widthMm: 50.8, heightMm: 83.8 });
    expect(orientGeometry(herma, 'landscape')).toBe(herma);
    expect(orientGeometry(round, 'portrait')).toBe(round);
  });
});

describe('the area of a whole picture', () => {
  const card: StickerGeometry = { widthMm: 85.6, heightMm: 54, bleedMm: 2, safeMm: 3, shape: 'rect' };
  const placedWhole = (g: StickerGeometry, style: 'full', srcW: number, srcH: number) => {
    const box = stickerLayout(g, { style, title: false, badge: false, logo: false }).picture;
    const frame = pictureFrame(box, g, 0);
    const p = placePicture(srcW, srcH, frame.width, frame.height, { zoom: 0 });
    return { left: frame.x + p.dest.x, top: frame.y + p.dest.y, right: frame.x + p.dest.x + p.dest.width, bottom: frame.y + p.dest.y + p.dest.height };
  };

  it('keeps a picture shown whole out of the bleed that is cut off ("Vollbild")', () => {
    // A wide photo fills the width: before, its edges reached 2 mm into the bleed on both sides.
    const wide = placedWhole(card, 'full', 3000, 1000);
    expect(wide.left).toBeCloseTo(0, 6);
    expect(wide.right).toBeCloseTo(card.widthMm, 6);
    // A square cover on a landscape sticker: top and bottom at the cut line, not beyond.
    const square = placedWhole(card, 'full', 1000, 1000);
    expect(square.top).toBeCloseTo(0, 6);
    expect(square.bottom).toBeCloseTo(card.heightMm, 6);
    // Also on round stickers.
    const r = placedWhole(round, 'full', 1000, 1000);
    expect([r.left, r.top, r.right, r.bottom].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0, 30, 30]);
  });

  it('reaches into the bleed again as the picture fills the sticker, without a jump', () => {
    const box = { x: -2, y: -2, width: 89.6, height: 58 };
    expect(pictureFrame(box, card, 1)).toBe(box);
    expect(pictureFrame(box, card, 2.5)).toBe(box);
    expect(pictureFrame(box, card, 0)).toEqual({ x: 0, y: 0, width: 85.6, height: 54 });
    const half = pictureFrame(box, card, 0.5);
    expect(half.x).toBeCloseTo(-1, 6);
    expect(half.width).toBeCloseTo(87.6, 6);
    const almost = pictureFrame(box, card, 0.999);
    expect(almost.width).toBeCloseTo(box.width, 2);
  });

  it('leaves pictures alone that sit inside the sticker anyway (styles Klassisch and Hell)', () => {
    const box = { x: 2.5, y: 2.5, width: 45.8, height: 45.8 };
    expect(pictureFrame(box, herma, 0)).toEqual(box);
  });
});

describe('Vollbild with its band', () => {
  const layout = stickerLayout(herma, { style: 'full', title: true, badge: true, logo: false });

  it('cuts a cover out of all of the sticker, so the top of it (the series logo) stays', () => {
    expect(layout.band).toBeDefined();
    const box = placementBox(layout, herma, 1);
    expect(box).toEqual({ x: -1.5, y: -1.5, width: 86.8, height: 53.8 });
    const p = placePicture(1000, 1000, box.width, box.height, { zoom: 1 });
    expect(p.src.y).toBe(0);
    // The picture itself still ends at the band: only that part is drawn.
    expect(layout.picture.y + layout.picture.height).toBeLessThan(herma.heightMm);
  });

  it('fits a picture shown smaller above the band, as before', () => {
    expect(placementBox(layout, herma, 0)).toEqual(pictureFrame(layout.picture, herma, 0));
  });
});
