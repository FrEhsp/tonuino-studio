import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { isCompact, orientGeometry, type Orientation } from '../../core/stickers/layout';
import { slotRects, type SlotRect } from '../../core/stickers/slots';
import type { CanvasLike } from '../../core/stickers/image';
import type { LabelTemplate } from '../../core/stickers/templates';
import type { Spot } from '../../core/stickers/placement';
import type { StickerItem } from './content';
import { usePageShown } from '../../app/pageAlive';
import { inQuietTurn } from '../../ui/quiet';
import { canvasEpoch } from '../../ui/repaint';
import { labelGeometry, renderKey, renderPreview, type RenderSetup } from './pipeline';
import { useSheetMove, type CarryVia } from './sheetMove';

/**
 * One sticker as the finished, cut label (no bleed). `size` is the CSS length
 * of its longer side, so landscape and portrait stickers take the same room.
 * `fluid`: as wide as its box instead (`size` then only sets the resolution).
 * The shelf has its own (FolderSticker).
 */
export function StickerThumb({ item, setup, size, label, fluid }: { item: StickerItem; setup: RenderSetup; size: number; label?: string; fluid?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const plain = labelGeometry(setup.template, setup.bleedMm);
  const longMm = Math.max(plain.widthMm, plain.heightMm);
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  const k = quantize((size * dpr) / longMm);
  const key = renderKey(item, setup, k);
  const [failed, setFailed] = useState(false);
  // "auto" turns a sticker like its picture: known once it is drawn.
  const [drawn, setDrawn] = useState<Orientation | null>(null);
  const render = useRender();
  const g = orientGeometry(plain, drawn ?? item.orientation ?? (setup.design.orientation === 'portrait' ? 'portrait' : 'landscape'));

  useEffect(() => {
    let alive = true;
    setFailed(false);
    render(() => (alive ? renderPreview(item, setup, k) : Promise.reject(new Error('gone')))).then(
      (c) => {
        const el = ref.current;
        if (alive && el) {
          const art = orientGeometry(plain, c.width >= c.height ? 'landscape' : 'portrait');
          setDrawn(art.widthMm >= art.heightMm ? 'landscape' : 'portrait');
          el.width = Math.round(art.widthMm * k);
          el.height = Math.round(art.heightMm * k);
          const ctx = el.getContext('2d');
          ctx?.drawImage(c as CanvasImageSource, setup.bleedMm * k, setup.bleedMm * k, el.width, el.height, 0, 0, el.width, el.height);
        }
      },
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [key, canvasEpoch.value]);

  const width = (size * g.widthMm) / longMm;
  const round = g.shape === 'round';
  const radius = round
    ? '50%'
    : fluid
      ? `${(setup.template.label.cornerRadiusMm / g.widthMm) * 100}% / ${(setup.template.label.cornerRadiusMm / g.heightMm) * 100}%`
      : `${(setup.template.label.cornerRadiusMm / g.widthMm) * width}px`;
  const style = { width: fluid ? '100%' : width, aspectRatio: `${g.widthMm} / ${g.heightMm}`, borderRadius: radius };
  return (
    <canvas
      ref={ref}
      class={`sticker-thumb ${failed ? 'failed' : ''}`}
      role="img"
      aria-label={label ?? item.title}
      style={style}
    />
  );
}

/**
 * A page built ahead stays hidden behind the shelf (App.tsx): its stickers
 * are drawn one by one in quiet moments, not while the shelf scrolls.
 */
function useRender(): <T>(run: () => Promise<T>) => Promise<T> {
  const shown = useRef(true);
  shown.current = usePageShown();
  return (run) => (shown.current ? run() : inQuietTurn(run));
}

/** Rounds the resolution so small layout changes reuse cached renderings. */
function quantize(k: number): number {
  return Math.max(1, Math.round(k * 4) / 4);
}

/**
 * A whole sheet as it will come out of the printer: stickers in their labels,
 * labels that are gone already crossed out, empty labels as outlines. With
 * `onPlace` the stickers can be dragged onto another label (sheetMove.ts).
 */
export function SheetPreview({
  template,
  pages,
  sheet,
  used,
  setup,
  onEdit,
  onToggleUsed,
  onPlace,
  onSheet,
  onCarry,
  maxHeight = Infinity,
}: {
  template: LabelTemplate;
  /** All sheets; `sheet` is the one shown. */
  pages: (StickerItem | null)[][];
  sheet: number;
  /** Labels on the first sheet that are gone already. */
  used: number[];
  setup: RenderSetup;
  onEdit: (item: StickerItem) => void;
  onToggleUsed?: (slot: number) => void;
  onPlace?: (from: Spot, to: Spot) => boolean;
  onSheet?: (sheet: number) => void;
  onCarry?: (via: CarryVia | null) => void;
  /** Without it the sheet takes the whole width of its box (the page scrolls). */
  maxHeight?: number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const { widthMm: pw, heightMm: ph } = template.page;
  const cssW = Math.max(0, Math.min(width, maxHeight * (pw / ph)));
  const rects = slotRects(template);
  const render = useRender();
  const page = pages[sheet] ?? rects.map(() => null);
  const usedHere = sheet === 0 ? used : [];
  const move = useSheetMove({ template, pages, sheet, used, onSheet, onPlace, onCarry });
  const canvas = move.canvas;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  const s = (cssW * dpr) / pw;
  const k = quantize(s);
  const keys = page.map((it) => (it ? renderKey(it, setup, k) : '')).join('\n');
  const usedKey = usedHere.join(',');
  // The user's own size keeps its id when only the margins or gaps change.
  const sheetKey = JSON.stringify([template.page, template.grid, template.label]);

  // Before the browser paints: a dropped sticker shows in its new place in the same frame in which the
  // hole of the old one goes. A plain effect came a frame later (WebKitGTK: up to 170 ms), and the sticker
  // jumped back to where it was for that long (TODO #83). Moved stickers come from the cache, so their
  // drawing is done in the same task, before the paint.
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el || cssW <= 0) return;
    let alive = true;
    el.width = Math.round(pw * s);
    el.height = Math.round(ph * s);
    const ctx = el.getContext('2d')!;
    const draw = (stickers: (CanvasLike | null)[]) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, el.width, el.height);
      const usedSet = new Set(usedHere);
      rects.forEach((slot, i) => {
        const sticker = stickers[i];
        if (sticker) drawSticker(ctx, sticker, slot, template, setup, s, k);
        else drawEmpty(ctx, slot, template, s, usedSet.has(i));
      });
    };
    // Outlines first, stickers as soon as they are ready. Moved stickers come
    // from the cache: nothing is rendered anew for a drop.
    draw(rects.map(() => null));
    Promise.all(page.map((it) => (it ? render(() => (alive ? renderPreview(it, setup, k) : Promise.reject(new Error('gone')))).catch(() => null) : Promise.resolve(null)))).then((stickers) => {
      if (alive) draw(stickers);
    });
    return () => {
      alive = false;
    };
  }, [keys, usedKey, cssW, sheetKey, canvasEpoch.value]);

  const slotStyle = (slot: SlotRect) => ({
    left: `${(slot.x / pw) * 100}%`,
    top: `${(slot.y / ph) * 100}%`,
    width: `${(slot.width / pw) * 100}%`,
    height: `${(slot.height / ph) * 100}%`,
    borderRadius: template.label.shape === 'round' ? '50%' : undefined,
  });
  const lifted = move.lifted;

  return (
    <div class="sheet-preview-wrap" ref={wrap}>
      <div
        class={`sheet-preview ${move.movable ? 'movable' : ''} ${lifted ? 'is-moving' : ''}`}
        style={{ width: cssW, aspectRatio: `${pw} / ${ph}` }}
        ref={move.box}
        tabIndex={-1}
        onKeyDown={move.onSheetKey}
        onBlur={move.onSheetBlur}
      >
        <canvas ref={canvas} aria-hidden="true" />
        {lifted && lifted.sheet === sheet ? <div class="sheet-hole" style={slotStyle(rects[lifted.slot])} aria-hidden="true" /> : null}
        {rects.map((slot, i) => {
          const item = page[i];
          const style = slotStyle(slot);
          if (item) {
            return (
              <button
                type="button"
                class="sheet-hit"
                style={style}
                key={i}
                data-slot={i}
                // No tooltip while carrying: WebKitGTK showed it over the sticker in hand.
                title={lifted ? undefined : move.movable ? 'Klicken: anpassen. Ziehen: verschieben.' : 'Sticker anpassen'}
                aria-label={`Etikett ${i + 1}: ${item.title}. Anpassen`}
                aria-describedby={move.movable ? 'sheet-move-hint' : undefined}
                onClick={() => move.isClick() && onEdit(item)}
                onPointerDown={move.onPointerDown(i)}
                onKeyDown={move.onStickerKey(i)}
              >
                <span class="sheet-hit-tag" aria-hidden="true">
                  Anpassen
                </span>
              </button>
            );
          }
          if (!onToggleUsed) return null;
          const isUsed = usedHere.includes(i);
          return (
            <button
              type="button"
              class={`sheet-hit empty ${isUsed ? 'used' : ''}`}
              style={style}
              key={i}
              data-slot={i}
              title={lifted ? undefined : isUsed ? 'Doch frei' : 'Etikett fehlt schon'}
              aria-label={`Etikett ${i + 1}: ${isUsed ? 'fehlt schon. Wieder als frei markieren' : 'frei. Als fehlend markieren'}`}
              onClick={() => move.isClick() && onToggleUsed(i)}
            />
          );
        })}
        <div class="sheet-drop" ref={move.mark} aria-hidden="true">
          <span class="sheet-drop-tag">
            <span class="when-move">Hierhin</span>
            <span class="when-swap">
              Tauschen
            </span>
          </span>
        </div>
      </div>
      {move.movable ? (
        <>
          <span id="sheet-move-hint" class="visually-hidden">
            Mit den Pfeiltasten verschieben.
          </span>
          <p class="visually-hidden" aria-live="assertive" aria-atomic="true" ref={move.live} />
        </>
      ) : null}
    </div>
  );
}

type Ctx = CanvasRenderingContext2D;

function labelPath(ctx: Ctx, slot: SlotRect, template: LabelTemplate, s: number) {
  ctx.beginPath();
  if (template.label.shape === 'round') {
    ctx.ellipse((slot.x + slot.width / 2) * s, (slot.y + slot.height / 2) * s, (slot.width / 2) * s, (slot.height / 2) * s, 0, 0, Math.PI * 2);
  } else {
    const x = slot.x * s;
    const y = slot.y * s;
    const w = slot.width * s;
    const h = slot.height * s;
    const r = Math.min(template.label.cornerRadiusMm * s, w / 2, h / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

function drawSticker(ctx: Ctx, sticker: CanvasLike, slot: SlotRect, template: LabelTemplate, setup: RenderSetup, s: number, k: number) {
  const label = labelGeometry(template, setup.bleedMm);
  // Each sticker may be turned on its own: read it from the drawing.
  const art = orientGeometry(label, sticker.width >= sticker.height ? 'landscape' : 'portrait');
  const turned = !isCompact(label) && art.widthMm >= art.heightMm !== label.widthMm >= label.heightMm;
  const B = setup.bleedMm * k;
  const sw = art.widthMm * k;
  const sh = art.heightMm * k;
  ctx.save();
  labelPath(ctx, slot, template, s);
  ctx.clip();
  ctx.imageSmoothingQuality = 'high';
  if (turned) {
    ctx.translate((slot.x + slot.width / 2) * s, (slot.y + slot.height / 2) * s);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(sticker as CanvasImageSource, B, B, sw, sh, (-slot.height / 2) * s, (-slot.width / 2) * s, slot.height * s, slot.width * s);
  } else {
    ctx.drawImage(sticker as CanvasImageSource, B, B, sw, sh, slot.x * s, slot.y * s, slot.width * s, slot.height * s);
  }
  ctx.restore();
  // A hairline around the label, as on a real sheet.
  labelPath(ctx, slot, template, s);
  ctx.strokeStyle = 'rgb(0 0 0 / 0.12)';
  ctx.lineWidth = Math.max(1, s * 0.15);
  ctx.stroke();
}

function drawEmpty(ctx: Ctx, slot: SlotRect, template: LabelTemplate, s: number, used: boolean) {
  labelPath(ctx, slot, template, s);
  if (used) {
    ctx.fillStyle = '#eceef3';
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = 'rgb(20 26 40 / 0.12)';
    ctx.lineWidth = Math.max(1, s * 0.5);
    const step = 3.5 * s;
    for (let d = -slot.height * s; d < slot.width * s; d += step) {
      ctx.beginPath();
      ctx.moveTo(slot.x * s + d, (slot.y + slot.height) * s);
      ctx.lineTo(slot.x * s + d + slot.height * s, slot.y * s);
      ctx.stroke();
    }
    ctx.restore();
  } else {
    ctx.save();
    ctx.setLineDash([2 * s, 1.5 * s]);
    ctx.strokeStyle = '#c6ccd9';
    ctx.lineWidth = Math.max(1, s * 0.25);
    ctx.stroke();
    ctx.restore();
  }
}
