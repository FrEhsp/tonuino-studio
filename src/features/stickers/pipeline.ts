/**
 * From sticker items to pixels and files: rendering with a cache for the
 * preview, and the print files (PDF sheets, JPEG for photo services, single
 * pictures as ZIP).
 */
import { isCompact, orientGeometry, placementBox, stickerOrientation, type StickerGeometry } from '../../core/stickers/layout';
import { motifFrame } from '../../core/stickers/margin';
import { buildSheetPdf, exportPhotoSheetJpeg, type StickerBitmap } from '../../core/stickers/pdf';
import { canvasToBlob, createCanvas, get2d, imageSize, loadImageBitmap, LOW_PRINT_DPI, placedDpi, setJpegDpi, sizeSvg, type CanvasLike, type DrawableImage } from '../../core/stickers/image';
import { slotsPerSheet } from '../../core/stickers/slots';
import { layOut, place, type Moved } from '../../core/stickers/placement';
import { MM_PER_INCH, type LabelTemplate } from '../../core/stickers/templates';
import type { Calibration } from '../../core/stickers/calibration';
import { mirrorPage, mirrorTemplate, type BackMode } from '../../core/stickers/backside';
import { loadStickerFont } from './fonts';
import { backContentFor, loadBackQr, renderBack, type BackInk } from './backside';
import { GENERATED_EDGE, leasePicture, pictureSizeOf, type PixelSize, type StickerItem } from './content';
import type { LogoImage, StickerDesign } from './design';
import type { FontId } from './fonts';
import { backInk, layoutFor, renderSticker, stickerZoom, titleShown } from './render';
import { DEFAULT_DESIGN } from './design';
import { renderBildkarte } from './bildkarte';
import { pictogramImage, pictogramRev } from './pictograms';
import { onCanvasesLost } from '../../ui/repaint';
import { nextTask } from '../../ui/quiet';
import officialLogoUrl from './tonuino-logo.png?url';

export const PRINT_DPI = 300;
export const PRINT_PX_PER_MM = PRINT_DPI / MM_PER_INCH;

export function labelGeometry(t: LabelTemplate, bleedMm: number): StickerGeometry {
  return { widthMm: t.label.widthMm, heightMm: t.label.heightMm, bleedMm, safeMm: t.safeMarginMm, shape: t.label.shape };
}

/* ------------------------------------------------------------------ logo picture */

let logoCache: { source: LogoImage; image: Promise<DrawableImage | null> } | null = null;

let officialLogoImage: Promise<DrawableImage | null> | null = null;

/** The official TonUINO logo (black on transparent, tinted on the sticker), loaded once. */
export function officialLogo(): Promise<DrawableImage | null> {
  officialLogoImage ??= fetch(officialLogoUrl)
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
    .then((blob) => loadImageBitmap(blob))
    .catch(() => {
      officialLogoImage = null;
      return null;
    });
  return officialLogoImage;
}

/** Longer side of an SVG logo as a picture: sharp at 300 dpi across a whole label. */
const SVG_LOGO_EDGE = 1024;

export function logoDrawable(logo: LogoImage | null): Promise<DrawableImage | null> {
  if (!logo) return Promise.resolve(null);
  if (logoCache?.source !== logo) {
    const image =
      logo.type === 'image/svg+xml'
        ? svgLogo(logo.data)
        : loadImageBitmap(new Blob([logo.data as BlobPart], { type: logo.type })).catch(() => null);
    logoCache = { source: logo, image };
  }
  return logoCache.image;
}

/**
 * An SVG logo drawn once into a picture of fixed size, so the preview and the
 * print show the same thing, also for SVGs without width and height.
 */
async function svgLogo(data: Uint8Array): Promise<DrawableImage | null> {
  const text = new TextDecoder().decode(data);
  const sized = sizeSvg(text, SVG_LOGO_EDGE);
  const url = URL.createObjectURL(new Blob([sized?.svg ?? text], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const width = sized?.width ?? img.naturalWidth;
    const height = sized?.height ?? img.naturalHeight;
    if (!(width > 0) || !(height > 0)) return null;
    const canvas = createCanvas(width, height);
    // Whole picture into the whole canvas: the one form of drawImage that every engine scales correctly for SVG.
    get2d(canvas).drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ------------------------------------------------------------------ rendering */

export interface RenderSetup {
  design: StickerDesign;
  template: LabelTemplate;
  /** Bleed of the bitmaps; 0 with a white margin. */
  bleedMm: number;
  /** "Weißer Rand" (core/stickers/margin.ts): the motif this much smaller on every side, white around it. Missing: none. */
  marginMm?: number;
  logo: LogoImage | null;
  /**
   * Extra "Sticker-Rückseite": what goes on the backs printed with the
   * fronts. With backs, a Bildkarte names the source of its pictogram there,
   * else small on its front.
   */
  back?: BackMode;
}

/**
 * Draws a sticker or back side for `geometry` (the label, turned): as it is
 * without a white margin, else drawn for the motif's smaller geometry and put
 * on white, inside the label's shape the margin further in. The result has
 * the size of `geometry` with its bleed either way.
 */
export function inMargin(setup: Pick<RenderSetup, 'template' | 'marginMm'>, geometry: StickerGeometry, pxPerMm: number, draw: (g: StickerGeometry) => CanvasLike): CanvasLike {
  const m = setup.marginMm ?? 0;
  if (!(m > 0)) return draw(geometry);
  const frame = motifFrame(geometry, setup.template.label.cornerRadiusMm, m);
  const art = draw(frame.geometry);
  const k = pxPerMm;
  const B = geometry.bleedMm;
  const canvas = createCanvas((geometry.widthMm + 2 * B) * k, (geometry.heightMm + 2 * B) * k);
  const ctx = get2d(canvas);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const { x, y, width, height } = frame.box;
  const r = frame.radius;
  ctx.save();
  ctx.beginPath();
  if (geometry.shape === 'round') ctx.ellipse((B + x + width / 2) * k, (B + y + height / 2) * k, (width / 2) * k, (height / 2) * k, 0, 0, Math.PI * 2);
  else if (r > 0) {
    // arcTo instead of roundRect: older WebKitGTK versions lack roundRect.
    const [l, t, w, h, rr] = [(B + x) * k, (B + y) * k, width * k, height * k, r * k];
    ctx.moveTo(l + rr, t);
    ctx.arcTo(l + w, t, l + w, t + h, rr);
    ctx.arcTo(l + w, t + h, l, t + h, rr);
    ctx.arcTo(l, t + h, l, t, rr);
    ctx.arcTo(l, t, l + w, t, rr);
    ctx.closePath();
  } else ctx.rect((B + x) * k, (B + y) * k, width * k, height * k);
  ctx.clip();
  ctx.drawImage(art as CanvasImageSource, (B + x) * k, (B + y) * k, width * k, height * k);
  ctx.restore();
  // Nobody else holds the motif: give its memory back now.
  art.width = 0;
  art.height = 0;
  return canvas;
}

/** Below this resolution (pixels per mm) a sticker is a preview: a generated picture is drawn smaller. */
const PREVIEW_PX_PER_MM = 8;

/**
 * The styles on which a known series brings its own type: "Kassette", and since the sticker style audit
 * of 20.10.2026 also "Klassisch" and "Vollbild" (better there too, blind). "Bildkarte" keeps the font chosen:
 * its word is for children, in one round type on every card.
 */
const SERIES_FONT_STYLES: readonly string[] = ['tape', 'blur', 'full'];

/**
 * The font of a sticker: a known series brings its own type (narrow and black for the detective series),
 * unless another font than the default was chosen.
 */
export function fontFor(item: Pick<StickerItem, 'work'>, design: StickerDesign): FontId {
  return SERIES_FONT_STYLES.includes(design.style) && design.font === DEFAULT_DESIGN.font && item.work?.font ? item.work.font : design.font;
}

/**
 * The number on the plate of "Kassette" is always written in this font, the sticker's default ("Rund"):
 * the serif and narrow types of some series made the numbers of one sheet look restless (TODO #114).
 */
export const NUMBER_FONT: FontId = 'round';

/** Renders one sticker at the given resolution. */
export async function renderItem(item: StickerItem, setup: RenderSetup, pxPerMm: number): Promise<CanvasLike> {
  // Bildkarte draws itself; on round and square labels every style looks the same (layout.ts compactLayout).
  if (setup.design.style === 'bild' && !isCompact(labelGeometry(setup.template, setup.bleedMm))) return renderBildkarteItem(item, setup, pxPerMm);
  const assets = Promise.all([
    loadStickerFont(fontFor(item, setup.design)),
    setup.design.logo === 'image' ? logoDrawable(setup.logo) : setup.design.logo === 'tonuino' ? officialLogo() : null,
    setup.design.style === 'tape' ? loadStickerFont(NUMBER_FONT) : undefined,
  ]);
  // Handled below; this only keeps an early failure from being reported as unhandled.
  assets.catch(() => undefined);
  const lease = await leasePicture(item, {
    // Without a title of its own, a sticker without a picture gets the title strip of the shelf sticker.
    strip: !titleShown(item, setup.design),
    number: setup.design.showNumber,
    edge: pxPerMm < PREVIEW_PX_PER_MM ? GENERATED_EDGE.preview : GENERATED_EDGE.print,
  });
  try {
    const [font, logo, numberFont] = await assets;
    // Drawn in a task of its own: stickers whose pictures came together do not hold back the next frame together.
    await nextTask();
    const { width, height } = imageSize(lease.picture.image);
    const orientation = stickerOrientation(item.orientation, setup.design.orientation, width / height);
    const geometry = orientGeometry(labelGeometry(setup.template, setup.bleedMm), orientation);
    return inMargin(setup, geometry, pxPerMm, (g) => renderSticker({ item, picture: lease.picture, design: setup.design, geometry: g, pxPerMm, font, logo, numberFont }));
  } finally {
    lease.release();
  }
}

/**
 * A Bildkarte (bildkarte.ts): its real picture when it has one, else its motif; no picture is made up for it.
 * A sticker from an own picture shows its chosen pictogram instead (StickerItem.pictogram).
 */
async function renderBildkarteItem(item: StickerItem, setup: RenderSetup, pxPerMm: number): Promise<CanvasLike> {
  const d = setup.design;
  const [font, logo] = await Promise.all([loadStickerFont(fontFor(item, d)), d.logo === 'image' ? logoDrawable(setup.logo) : d.logo === 'tonuino' ? officialLogo() : null]);
  // Only what is stored on this device: printing never goes online (pictograms.ts). Missing, the own picture stays.
  const instead = item.loose && item.pictogram ? await pictogramImage(item.pictogram) : null;
  const lease = item.picture && !instead ? await leasePicture(item, { strip: false, number: false, edge: GENERATED_EDGE.preview }) : undefined;
  try {
    const picture = lease && !lease.picture.generated ? lease.picture : null;
    const pictogram = instead ?? (!picture && item.pictogram ? await pictogramImage(item.pictogram) : null);
    await nextTask();
    const size = picture ? imageSize(picture.image) : { width: 1, height: 1 };
    const orientation = stickerOrientation(item.orientation, d.orientation, size.width / size.height);
    const geometry = orientGeometry(labelGeometry(setup.template, setup.bleedMm), orientation);
    // An own picture has no card and so no back (backside.ts): its pictogram names the source on the front.
    return inMargin(setup, geometry, pxPerMm, (g) =>
      renderBildkarte({ item, picture, geometry: g, pxPerMm, font, showNumber: d.showNumber, showTitle: titleShown(item, d), logo, tintLogo: d.logoTint || d.logo === 'tonuino', word: d.logo === 'text' ? d.logoText.trim() : '', pictogram, creditOnBack: hasBacks(setup) && !item.loose }),
    );
  } finally {
    lease?.release();
  }
}

/** Backs are printed with the fronts (extra "Sticker-Rückseite"). */
export function hasBacks(setup: Pick<RenderSetup, 'back'>): boolean {
  return !!setup.back && setup.back !== 'none';
}

/**
 * Print resolution of a sticker's picture in dpi for a picture of this pixel
 * size, placed as renderItem places it (orientation, style, section).
 */
export function stickerDpi(item: StickerItem, setup: RenderSetup, size: PixelSize): number {
  const orientation = stickerOrientation(item.orientation, setup.design.orientation, size.width / size.height);
  const label = orientGeometry(labelGeometry(setup.template, setup.bleedMm), orientation);
  // With a white margin the picture is printed smaller, so it needs fewer pixels.
  const geometry = setup.marginMm ? motifFrame(label, setup.template.label.cornerRadiusMm, setup.marginMm).geometry : label;
  const logo = setup.design.logo === 'text' ? !!setup.design.logoText.trim() : setup.design.logo === 'tonuino' || (setup.design.logo === 'image' && !!setup.logo);
  const zoom = stickerZoom(item, setup.design);
  const box = placementBox(layoutFor(item, setup.design, geometry, logo, size.width / size.height), geometry, zoom);
  return placedDpi(size.width, size.height, box.width, box.height, { focusX: item.focusX, focusY: item.focusY, zoom });
}

/** True when the sticker's picture is measured and too small for its printed size. */
export function printsBlurry(item: StickerItem, setup: RenderSetup): boolean {
  const size = pictureSizeOf(item);
  return !!size && !pictogramInstead(item, setup) && stickerDpi(item, setup, size) < LOW_PRINT_DPI;
}

/** A sticker from an own picture shows its pictogram, not the picture (Bildkarte, see renderBildkarteItem). */
export function pictogramInstead(item: Pick<StickerItem, 'loose' | 'pictogram'>, setup: RenderSetup): boolean {
  return !!item.loose && !!item.pictogram && setup.design.style === 'bild' && !isCompact(labelGeometry(setup.template, setup.bleedMm));
}

/** Key for everything that changes the look of a sticker. */
export function renderKey(item: StickerItem, setup: RenderSetup, pxPerMm: number): string {
  return JSON.stringify([
    item.key,
    item.title,
    item.subtitle,
    item.series,
    item.number,
    item.part,
    item.detail,
    item.picture?.kind === 'url' ? item.picture.url : item.picture?.kind === 'blob' ? item.picture.id : '',
    item.color,
    item.work?.id,
    // The symbol and colour of a special card follow the firmware chosen.
    item.icon.displayName ?? item.icon.name,
    item.flatColor,
    item.focusX,
    item.focusY,
    item.zoom,
    item.orientation,
    item.recipe?.id,
    item.recipe?.episode,
    // A pictogram drawn again once it is stored here; its credit goes on the back or the front.
    item.pictogram,
    item.pictogram ? pictogramRev.value : 0,
    item.pictogram ? hasBacks(setup) : false,
    // The flap of "Kassette" says how many tracks and how long.
    item.length?.tracks,
    item.length?.durationSec,
    item.length?.story,
    setup.design,
    setup.template.id,
    setup.template.label,
    setup.template.safeMarginMm,
    setup.bleedMm,
    setup.marginMm ?? 0,
    setup.logo?.name,
    setup.logo?.data.length,
    Math.round(pxPerMm * 100),
  ]);
}

const previewCache = new Map<string, Promise<CanvasLike>>();
const PREVIEW_CACHE_MAX = 240;
// After the print dialog the cached renderings may be blank too (ui/repaint.ts).
/** The finished ones of previewCache, to draw at once when a page comes back (Prüfrunde 1 Aussehen 2). */
const previewDone = new Map<string, CanvasLike>();
onCanvasesLost(() => {
  previewCache.clear();
  previewDone.clear();
});

/** A preview already drawn, or undefined. */
export function finishedPreview(key: string): CanvasLike | undefined {
  return previewDone.get(key);
}

/** Cached rendering for previews. */
export function renderPreview(item: StickerItem, setup: RenderSetup, pxPerMm: number): Promise<CanvasLike> {
  const key = renderKey(item, setup, pxPerMm);
  let p = previewCache.get(key);
  if (!p) {
    if (previewCache.size >= PREVIEW_CACHE_MAX) {
      // Oldest first: Map keeps insertion order.
      for (const k of [...previewCache.keys()].slice(0, PREVIEW_CACHE_MAX / 2)) {
        previewCache.delete(k);
        previewDone.delete(k);
      }
    }
    p = renderItem(item, setup, pxPerMm);
    p.then(
      (c) => {
        if (previewCache.get(key) === p) previewDone.set(key, c);
      },
      () => previewCache.delete(key),
    );
    previewCache.set(key, p);
  }
  return p;
}

/** Shelf stickers rendered at the same time; the others wait, and are dropped when their tile is gone. */
const PARALLEL_THUMBS = 2;
let thumbsRunning = 0;
const thumbQueue: (() => void)[] = [];

/**
 * A sticker for a short-lived thumbnail (the shelf): not kept in the preview
 * cache, at most PARALLEL_THUMBS at once, and skipped when `signal` is
 * aborted while it waits. The caller copies it and lets it go.
 */
export async function renderThumb(item: StickerItem, setup: RenderSetup, pxPerMm: number, signal?: AbortSignal): Promise<CanvasLike> {
  while (thumbsRunning >= PARALLEL_THUMBS) await new Promise<void>((resolve) => thumbQueue.push(resolve));
  thumbsRunning++;
  try {
    signal?.throwIfAborted();
    return await renderItem(item, setup, pxPerMm);
  } finally {
    thumbsRunning--;
    thumbQueue.shift()?.();
  }
}

/* ------------------------------------------------------------------ files */

export interface Progress {
  done: number;
  total: number;
}

async function printBitmaps(items: StickerItem[], setup: RenderSetup, onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<StickerBitmap[]> {
  const out: StickerBitmap[] = [];
  onProgress({ done: 0, total: items.length });
  for (const item of items) {
    signal?.throwIfAborted();
    const canvas = await renderItem(item, setup, PRINT_PX_PER_MM);
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
    out.push({ image: blob, widthPx: canvas.width, heightPx: canvas.height, bleedMm: setup.bleedMm });
    onProgress({ done: out.length, total: items.length });
    // Let the page breathe between stickers.
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

function calibrationOfSetup(s: Pick<SheetSetup, 'calibration'>): Calibration {
  return typeof s.calibration === 'function' ? s.calibration() : s.calibration;
}

export interface SheetSetup extends RenderSetup {
  usedSlots: number[];
  /** Stickers moved by hand (core/stickers/placement.ts); missing: in order. */
  pins?: Moved | null;
  /**
   * The printer correction; as a function it is read when the file is made, so the desktop app's
   * print dialog can choose the printer first (its own correction, TODO #128).
   */
  calibration: Calibration | (() => Calibration);
  cutMarks: boolean;
  cutLines: boolean;
  /** "Erst auf Normalpapier probieren": thin outlines around every label (see SheetPdfOptions.outlines). */
  outlines?: boolean;
  title: string;
}

/**
 * The back side of every sticker at print resolution (backside.ts); null
 * where a sticker has none. Progress goes on from `done` of `total`.
 */
async function backBitmaps(items: StickerItem[], s: SheetSetup, mode: Exclude<BackMode, 'none'>, progress: (done: number) => void, signal?: AbortSignal): Promise<(StickerBitmap | null)[]> {
  const out: (StickerBitmap | null)[] = [];
  for (const item of items) {
    signal?.throwIfAborted();
    const canvas = await renderBackItem(item, s, PRINT_PX_PER_MM, mode);
    if (!canvas) out.push(null);
    else {
      out.push({ image: await canvasToBlob(canvas, 'image/jpeg', 0.92), widthPx: canvas.width, heightPx: canvas.height, bleedMm: s.bleedMm });
    }
    progress(out.length);
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

/** The colours of a sticker's back: on "Kassette" those of its front (render.ts backInk), else white. */
export async function backInkFor(item: StickerItem, setup: Pick<RenderSetup, 'design'>, pxPerMm: number): Promise<BackInk | undefined> {
  if (setup.design.style !== 'tape') return undefined;
  const lease = await leasePicture(item, { strip: !titleShown(item, setup.design), number: setup.design.showNumber, edge: pxPerMm < PREVIEW_PX_PER_MM ? GENERATED_EDGE.preview : GENERATED_EDGE.print });
  try {
    return backInk(item, lease.picture);
  } finally {
    lease.release();
  }
}

/** The back side of one sticker (backside.ts), with the label as it lies on the sheet; null when it has none. */
export async function renderBackItem(item: StickerItem, setup: RenderSetup, pxPerMm: number, mode: Exclude<BackMode, 'none'>): Promise<CanvasLike | null> {
  const content = backContentFor(item);
  if (!content) return null;
  const [font, ink] = await Promise.all([loadStickerFont(fontFor(item, setup.design)), backInkFor(item, setup, pxPerMm), mode === 'qr' && loadBackQr()]);
  return inMargin(setup, labelGeometry(setup.template, setup.bleedMm), pxPerMm, (g) => renderBack(content, mode, g, pxPerMm, font, ink));
}

/**
 * Fronts and, with back sides, backs in sheets: both laid out together, so
 * each back stays on the sheet of its front (a sheet whose stickers all lack
 * a back still gets its back page), on the labels chosen in the preview.
 */
async function sheetsOf(items: StickerItem[], s: SheetSetup, onProgress: (p: Progress) => void, signal?: AbortSignal) {
  const mode = s.back && s.back !== 'none' ? s.back : undefined;
  const total = mode ? items.length * 2 : items.length;
  const fronts = await printBitmaps(items, s, ({ done }) => onProgress({ done, total }), signal);
  const backs = mode ? await backBitmaps(items, s, mode, (done) => onProgress({ done: items.length + done, total }), signal) : undefined;
  const perSheet = slotsPerSheet(s.template);
  const spots = place(items.map((i) => i.key), perSheet, s.usedSlots, s.pins);
  const sheets = layOut(fronts.map((front, i) => ({ front, back: backs?.[i] ?? null })), spots, perSheet);
  return {
    pages: sheets.map((sheet) => sheet.map((x) => x?.front ?? null)),
    backs: backs ? sheets.map((sheet) => sheet.map((x) => x?.back ?? null)) : undefined,
  };
}

export async function buildPdf(items: StickerItem[], s: SheetSetup, onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<Blob> {
  const { pages, backs } = await sheetsOf(items, s, onProgress, signal);
  return buildSheetPdf({ template: s.template, pages, backs, calibration: calibrationOfSetup(s), bleedMm: s.bleedMm, cutMarks: s.cutMarks, cutLines: s.cutLines, outlines: s.outlines, title: s.title });
}

/**
 * One JPEG per sheet, for photo services and for printing straight away.
 * With back sides every sheet is followed by its back, mirrored as in the
 * PDF, without marks.
 */
export async function buildPhotoSheets(items: StickerItem[], s: SheetSetup, onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<Blob[]> {
  const { pages, backs } = await sheetsOf(items, s, onProgress, signal);
  const out: Blob[] = [];
  for (const [i, page] of pages.entries()) {
    signal?.throwIfAborted();
    out.push(await exportPhotoSheetJpeg({ template: s.template, page, calibration: calibrationOfSetup(s), bleedMm: s.bleedMm, cutMarks: s.cutMarks, cutLines: s.cutLines, outlines: s.outlines, dpi: PRINT_DPI }));
    if (backs) {
      out.push(await exportPhotoSheetJpeg({ template: mirrorTemplate(s.template), page: mirrorPage(backs[i], s.template), calibration: calibrationOfSetup(s), bleedMm: s.bleedMm, cutMarks: false, cutLines: false, dpi: PRINT_DPI }));
    }
  }
  return out;
}

/** Every sticker as its own picture (with bleed), e.g. for a photo service app or a print shop. */
export async function buildZip(items: StickerItem[], setup: RenderSetup, onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<Blob> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const used = new Set<string>();
  onProgress({ done: 0, total: items.length });
  let done = 0;
  for (const item of items) {
    signal?.throwIfAborted();
    const canvas = await renderItem(item, setup, PRINT_PX_PER_MM);
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.94);
    // With its resolution written in, a picture viewer prints the sticker at its real size.
    const jpeg = setJpegDpi(new Uint8Array(await blob.arrayBuffer()), PRINT_DPI);
    let name = fileName(item);
    for (let i = 2; used.has(name); i++) name = `${fileName(item)} (${i})`;
    used.add(name);
    zip.file(`${name}.jpg`, jpeg);
    onProgress({ done: ++done, total: items.length });
    await new Promise((r) => setTimeout(r, 0));
  }
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

function fileName(item: StickerItem): string {
  const title = item.title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Sticker';
  return item.number ? `${item.number} ${title}` : title;
}
