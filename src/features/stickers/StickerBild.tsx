/**
 * One sticker as it will be printed, drawn by the sticker printer itself
 * (pipeline.ts), for the screens of 0.6: on the card of „Karte beschreiben“
 * and as the small stickers to pick a style from. Without bleed: the shape
 * of the label. The sticker keeps its own fonts and look; only its size is
 * the screen's.
 */
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { orientGeometry, type StickerStyle } from '../../core/stickers/layout';
import { changedDesign, design, loadLogoImage, logoImage, template } from './design';
import type { StickerItem } from './content';
import { finishedPreview, labelGeometry, renderKey, renderPreview, type RenderSetup } from './pipeline';
import type { CanvasLike } from '../../core/stickers/image';
import { pageSettled } from '../../ui/quiet';

/** The sticker's size on screen: its label turned the way the design stands, in mm. */
export function stickerSizeMm(): { widthMm: number; heightMm: number } {
  const g = orientGeometry(labelGeometry(template.value, 0), design.value.orientation === 'portrait' ? 'portrait' : 'landscape');
  return { widthMm: g.widthMm, heightMm: g.heightMm };
}

/** What a sticker of `widthPx` on screen is drawn with: its setup, its pixels per mm and the key of the drawing. */
function drawing(item: StickerItem, widthPx: number, style?: StickerStyle) {
  // Another style as it would really print: with the title that style brings (changedDesign), not this style's title.
  const setup: RenderSetup = { design: style ? changedDesign(design.value, { style }) : design.value, template: template.value, bleedMm: 0, logo: logoImage.value };
  const { widthMm } = stickerSizeMm();
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  // Steps of a quarter pixel per mm, so a window a few pixels wider draws no new sticker.
  const k = Math.max(1, Math.round(((widthPx * dpr) / widthMm) * 4) / 4);
  return { setup, k, key: renderKey(item, setup, k) };
}

/**
 * Draws a sticker ahead, in a quiet moment, as StickerBild will show it at `widthPx`: then it is
 * there in the first frame, not an empty place that fills a moment later (Prüfrunde 2, webkit W1).
 */
export async function drawStickerAhead(item: StickerItem, widthPx: number): Promise<void> {
  await loadLogoImage();
  const { setup, k, key } = drawing(item, widthPx);
  if (!finishedPreview(key)) await renderPreview(item, setup, k).catch(() => undefined);
}

export function StickerBild({ item, widthPx, style, name }: { item: StickerItem; widthPx: number; style?: StickerStyle; name?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    void loadLogoImage();
  }, []);
  const { setup, k, key } = drawing(item, widthPx, style);
  const { widthMm, heightMm } = stickerSizeMm();
  const draw = (src: CanvasLike) => {
    const c = canvas.current;
    if (!c) return;
    c.width = src.width;
    c.height = src.height;
    // A sticker standing the other way („auto“ turns it like its picture) keeps its own shape.
    c.style.aspectRatio = `${src.width} / ${src.height}`;
    c.getContext('2d')?.drawImage(src as CanvasImageSource, 0, 0);
  };
  // Drawn before, it shows in the first frame: no empty place that fills a moment later.
  const ready = finishedPreview(key);
  useLayoutEffect(() => {
    if (ready) draw(ready);
  }, [key]);
  useEffect(() => {
    if (ready) return undefined;
    let on = true;
    // A page just come to the front is painted first (quiet.ts).
    const settled = pageSettled();
    (settled ? settled.then(() => (on ? renderPreview(item, setup, k) : Promise.reject(new Error('gone')))) : renderPreview(item, setup, k))
      .then((src) => {
        if (on) draw(src);
      })
      .catch(() => {
        // The place stays empty and calm; the sticker page says what went wrong when it prints.
      });
    return () => {
      on = false;
    };
  }, [key]);
  const label = template.value.label;
  const corner = label.shape === 'round' ? '50%' : `${(label.cornerRadiusMm / widthMm) * widthPx}px`;
  return (
    <canvas
      ref={canvas}
      class="sticker-bild"
      role={name ? 'img' : undefined}
      aria-label={name}
      aria-hidden={name ? undefined : 'true'}
      style={{ width: `${widthPx}px`, aspectRatio: `${widthMm} / ${heightMm}`, borderRadius: corner }}
    />
  );
}
