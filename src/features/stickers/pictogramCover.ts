/**
 * An ARASAAC pictogram as a card's cover (TODO #113, Frank 22.10.2026: „Piktogramm-Suche neben
 * Kassette“): chosen in "Cover auswählen", it is the card's picture like any cover, so it goes with
 * every style (Kassette, Klassisch, Vollbild), on the shelf and in the box.
 *
 * The cover is the pictogram as ARASAAC gives it on white, only its size changed (the licence allows no
 * more without sharing the result as an adaptation), with its source: a cover has no other place for
 * the credit the licence asks for. The cover has the shape of the card, so "Vollbild" shows all of it
 * but the lower quarter, where its band lies; an upright sticker shows its middle. Credit and pictogram
 * keep inside that part.
 */
import { PICTOGRAM_CREDIT } from '../../core/stickers/arasaac';
import { canvasToBlob, createCanvas, get2d, imageSize, type Context2D, type DrawableImage, type FetchLike } from '../../core/stickers/image';
import { fontCss, loadStickerFont, type StickerFont } from './fonts';
import { keepPictogram, pictogramImage } from './pictograms';

/**
 * The cover in pixels: the shape of the card lying (85.6 × 54 mm), so "Vollbild" shows all of it; sharp
 * up to about 85 mm at 300 dpi.
 */
export const PLATE_W = 1600;
export const PLATE_H = 1000;

/**
 * Of the width, the share every style shows, centred: an upright sticker on "Vollbild" keeps about
 * the middle 40 % of a lying cover.
 */
export const PLATE_SAFE = 0.38;

export interface PlateLayout {
  /** The pictogram's square: left, top, edge in pixels. */
  pictogram: { x: number; y: number; size: number };
  /** The credit in two lines, their baselines and the type size in pixels. */
  credit: { lines: [string, string]; baselines: [number, number]; size: number; maxWidth: number };
}

/** "Piktogramm: Sergio Palao, ARASAAC" / "(arasaac.org), CC BY-NC-SA": two short lines fit where one long one would not. */
export function creditLines(credit = PICTOGRAM_CREDIT): [string, string] {
  const at = credit.indexOf(' (');
  return at > 0 ? [credit.slice(0, at), credit.slice(at + 1)] : [credit, ''];
}

/**
 * Where pictogram and credit sit on the cover: the credit at the top, the pictogram under it in the
 * middle, the lower quarter free (the band of "Vollbild" lies there).
 */
export function plateLayout(w = PLATE_W, h = PLATE_H): PlateLayout {
  const type = Math.round(h * 0.028);
  const first = Math.round(h * 0.1);
  const second = first + Math.round(type * 1.3);
  const top = second + Math.round(type * 1.4);
  const size = Math.round(h * 0.75) - top;
  return {
    pictogram: { x: Math.round((w - size) / 2), y: top, size },
    credit: { lines: creditLines(), baselines: [first, second], size: type, maxWidth: Math.round(PLATE_SAFE * w) },
  };
}

/** Draws the cover: white, the pictogram whole (never cut, never tinted), its source under it. */
export function drawPictogramPlate(ctx: Context2D, image: DrawableImage, font: StickerFont, w = PLATE_W, h = PLATE_H): void {
  const l = plateLayout(w, h);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const { width: iw, height: ih } = imageSize(image);
  const k = l.pictogram.size / Math.max(iw, ih, 1);
  const dw = iw * k;
  const dh = ih * k;
  ctx.drawImage(image, l.pictogram.x + (l.pictogram.size - dw) / 2, l.pictogram.y + (l.pictogram.size - dh) / 2, dw, dh);
  ctx.fillStyle = '#5a5a5a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  l.credit.lines.forEach((line, i) => {
    let size = l.credit.size;
    ctx.font = fontCss(font.text, size);
    // A wider type than expected: smaller, not cut.
    const width = ctx.measureText(line).width;
    if (width > l.credit.maxWidth) size = Math.floor((size * l.credit.maxWidth) / width);
    ctx.font = fontCss(font.text, size);
    ctx.fillText(line, w / 2, l.credit.baselines[i]);
  });
}

/** Loads the pictogram (kept on this device, pictograms.ts) and makes its cover as a PNG. */
export async function pictogramCover(id: number, fetchFn: FetchLike, signal?: AbortSignal): Promise<Blob> {
  await keepPictogram(id, fetchFn, signal);
  const [image, font] = await Promise.all([pictogramImage(id), loadStickerFont('round')]);
  if (!image) throw new Error('Das Piktogramm ließ sich nicht laden.');
  const canvas = createCanvas(PLATE_W, PLATE_H);
  drawPictogramPlate(get2d(canvas), image, font);
  return canvasToBlob(canvas, 'image/png');
}
