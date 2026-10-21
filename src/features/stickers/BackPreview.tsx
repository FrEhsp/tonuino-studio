import { useEffect, useRef, useState } from 'preact/hooks';
import { mirrorPage, mirrorTemplate, type BackMode } from '../../core/stickers/backside';
import { slotRects } from '../../core/stickers/slots';
import type { LabelTemplate } from '../../core/stickers/templates';
import type { StickerItem } from './content';
import { loadStickerFont } from './fonts';
import { backContentFor, loadBackQr, renderBack } from './backside';
import { backInkFor, fontFor, inMargin, labelGeometry, type RenderSetup } from './pipeline';
import { canvasEpoch } from '../../ui/repaint';

/**
 * The sheet of back sides as it comes out of the printer (extra
 * "Sticker-Rückseite"): mirrored left to right, so after turning the paper
 * over the long edge every back lies behind its front.
 */
export function BackSheetPreview({ template, page, setup, mode, maxHeight = Infinity }: { template: LabelTemplate; page: (StickerItem | null)[]; setup: RenderSetup; mode: Exclude<BackMode, 'none'>; maxHeight?: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const { widthMm: pw, heightMm: ph } = template.page;
  const cssW = Math.max(0, Math.min(width, maxHeight * (pw / ph)));
  const mirrored = mirrorTemplate(template);
  const rects = slotRects(mirrored);
  const backs = mirrorPage(page, template);
  const contents = backs.map((it) => (it ? backContentFor(it) : undefined));
  // The backs of "Kassette" take the colours of their fronts: what changes those changes the backs.
  const looks = backs.map((it) => it && [it.key, it.color, it.work?.id, it.picture?.kind === 'url' ? it.picture.url : it.picture?.id]);
  const key = JSON.stringify([contents, looks, mode, setup.design.font, setup.design.style, setup.marginMm ?? 0, template.page, template.grid, template.label, cssW]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!el || cssW <= 0) return;
    let alive = true;
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    const s = (cssW * dpr) / pw;
    el.width = Math.round(pw * s);
    el.height = Math.round(ph * s);
    const ctx = el.getContext('2d')!;
    const fonts = Promise.all(backs.map((it) => loadStickerFont(it ? fontFor(it, setup.design) : setup.design.font)));
    const inks = Promise.all(backs.map((it) => (it ? backInkFor(it, setup, s).catch(() => undefined) : undefined)));
    void Promise.all([fonts, inks, mode === 'qr' && loadBackQr()]).then(([fonts, inks]) => {
      if (!alive) return;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, el.width, el.height);
      const geometry = labelGeometry(template, 0);
      rects.forEach((slot, i) => {
        ctx.save();
        ctx.beginPath();
        if (template.label.shape === 'round') ctx.ellipse((slot.x + slot.width / 2) * s, (slot.y + slot.height / 2) * s, (slot.width / 2) * s, (slot.height / 2) * s, 0, 0, Math.PI * 2);
        else ctx.rect(slot.x * s, slot.y * s, slot.width * s, slot.height * s);
        if (backs[i]) {
          ctx.clip();
          const back = inMargin(setup, geometry, s, (g) => renderBack(contents[i], mode, g, s, fonts[i], inks[i]));
          ctx.drawImage(back as CanvasImageSource, slot.x * s, slot.y * s, slot.width * s, slot.height * s);
          ctx.restore();
          ctx.strokeStyle = 'rgb(0 0 0 / 0.12)';
          ctx.lineWidth = Math.max(1, s * 0.15);
          ctx.stroke();
        } else {
          ctx.setLineDash([2 * s, 1.5 * s]);
          ctx.strokeStyle = '#c6ccd9';
          ctx.lineWidth = Math.max(1, s * 0.25);
          ctx.stroke();
          ctx.restore();
        }
      });
    });
    return () => {
      alive = false;
    };
  }, [key, canvasEpoch.value]);

  return (
    <div class="sheet-preview-wrap" ref={wrap}>
      <div class="sheet-preview" style={{ width: cssW, aspectRatio: `${pw} / ${ph}` }}>
        <canvas ref={canvas} role="img" aria-label="Rückseiten dieses Bogens, spiegelverkehrt angeordnet" />
      </div>
    </div>
  );
}
