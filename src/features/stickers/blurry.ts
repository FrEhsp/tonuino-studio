import { MAX_PICTURE_EDGE } from '../../core/stickers/image';

/** Resolution a sticker picture should reach on paper. */
const SHARP_DPI = 300;

/**
 * What to do about a picture too small for its printed size: zoom out, or
 * take a bigger picture of about this width. `size` is the size the picture
 * is drawn with (see pictureSizeOf), so a picture at MAX_PICTURE_EDGE gets
 * no advice to take a bigger one: that would be shrunk to the same size.
 */
export function blurryHint(size: { width: number; height: number }, dpi: number, canChange: boolean, zoomedIn: boolean): string {
  const long = Math.max(size.width, size.height);
  const atMost = long >= MAX_PICTURE_EDGE;
  if (zoomedIn) {
    if (atMost) return 'Für diesen Ausschnitt ist das Bild zu klein und wird unscharf gedruckt. Ziehe „Größe“ weiter nach links.';
    const bigger = canChange ? 'nimm mit „Anderes Bild“ ein größeres' : 'füge ein größeres Bild hinzu';
    return `Für diesen Ausschnitt ist das Bild zu klein und wird unscharf gedruckt. Ziehe „Größe“ weiter nach links oder ${bigger}.`;
  }
  const bigger = canChange ? 'Nimm mit „Anderes Bild“ ein größeres' : 'Füge ein größeres Bild hinzu';
  // Wide enough for 300 dpi, but no wider than a picture is drawn anyway.
  const sharp = (size.width * SHARP_DPI) / dpi;
  const widest = (size.width * MAX_PICTURE_EDGE) / long;
  const wanted = Math.min(Math.ceil(sharp / 50) * 50, Math.floor(widest));
  if (atMost) return 'Das Bild ist zu klein für diesen Sticker und wird unscharf gedruckt. Ziehe „Größe“ weiter nach links.';
  if (wanted <= size.width) return `Das Bild ist zu klein für diesen Sticker und wird unscharf gedruckt. ${bigger}.`;
  return `Das Bild ist zu klein für diesen Sticker und wird unscharf gedruckt. ${bigger}, am besten mindestens ${wanted} Pixel breit.`;
}
