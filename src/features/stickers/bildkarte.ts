/**
 * The sticker style "Bildkarte" (style audit 20.10.2026, TODO #91; it took the
 * place of "Farbig"): for cards without an album cover (special cards, Kita
 * and word cards, own recordings) one big motif of our own
 * (core/stickers/motifs.ts) on a calm colour, one word under it, the number
 * small in a corner, the logo small in the other. With a cover the cover
 * stands there instead, the title under it. Drawn here on its own, not laid
 * out by core/stickers/layout.ts.
 */
import type { StickerGeometry } from '../../core/stickers/layout';
import { bestTextColor, contrast, fromHex, mix, toCss, WHITE, type RGB } from '../../core/stickers/color';
import { createCanvas, drawImageHQ, get2d, imageSize, placePicture, type CanvasLike, type Context2D, type DrawableImage } from '../../core/stickers/image';
import { fitLine, fitText, type Measure } from '../../core/stickers/text';
import { motifFor, motifParts, PEN, type MotifId } from '../../core/stickers/motifs';
import { PICTOGRAM_CREDIT } from '../../core/stickers/arasaac';
import type { Pt } from '../../core/stickers/keysymbols';
import { fontCss, wordmarkFont, type StickerFont } from './fonts';
import type { PreparedPicture, StickerItem } from './content';
import { drawNumberPlate } from './tape';
import { hasClearBackground, tinted } from './render';

/** Calm colours of the motifs: muted, never neon, light enough to print without banding. */
const MOTIF_COLORS: Record<MotifId, string> = {
  moon: '#34507f',
  stop: '#b8473c',
  louder: '#3d7a68',
  quieter: '#3d7a68',
  pause: '#56708f',
  next: '#56708f',
  prev: '#56708f',
  dice: '#45607d',
  repeat: '#3d6f8f',
  lock: '#7a6a5a',
  note: '#c4623f',
  sing: '#b85a7a',
  mic: '#3f4a5a',
  book: '#7a5a8c',
  headphones: '#4a5a8a',
  blocks: '#6a8f3a',
  cat: '#b8733a',
  dog: '#a0673e',
  bird: '#5a8fb8',
  fish: '#2f7f8f',
  pig: '#c0675a',
  tree: '#2f6b4a',
  cake: '#9a4f6e',
};

/** The ground a motif stands on when the card has no colour of its own. */
export function motifGround(id: MotifId): RGB {
  return fromHex(MOTIF_COLORS[id]);
}

/** The ink of motif and word on a ground: white where it reads, else the dark felt pen. */
export function motifInk(ground: RGB): RGB {
  return contrast(WHITE, ground) >= 3 ? WHITE : bestTextColor(ground) === WHITE ? WHITE : DARK_INK;
}

/** Dark ink for light grounds: warm, like the app's felt pen. */
const DARK_INK: RGB = fromHex('#2b2118');

export interface BildkarteOptions {
  item: StickerItem;
  /** The real picture; null for a card without one. */
  picture: PreparedPicture | null;
  geometry: StickerGeometry;
  pxPerMm: number;
  font: StickerFont;
  showNumber: boolean;
  showTitle: boolean;
  /** The logo (the official one or the family's own picture), drawn small at the top right; null: none. */
  logo?: DrawableImage | null;
  /** Draw the logo in the ink of the card (always for the official one, black on transparent). */
  tintLogo?: boolean;
  /** The family's own word in place of a logo picture ("Unsere Box"); empty: none. */
  word?: string;
  /** The ARASAAC pictogram chosen for this card (item.pictogram), stored on this device; null: the own motif. */
  pictogram?: DrawableImage | null;
  /** Backs are printed: the pictogram's source goes there (backside.ts), not small on the front. */
  creditOnBack?: boolean;
}

/** The motif of a card without a picture (by its title and symbol), else none. */
export function motifOf(item: StickerItem): MotifId | undefined {
  return motifFor({ title: item.title, symbol: item.icon.displayName ?? item.icon.name });
}

/** The calm ground of a Bildkarte: the colour chosen, else the motif's, the work's, the cover's. */
export function groundOf(item: StickerItem, picture: PreparedPicture | null): RGB {
  const hex = item.color ?? (picture ? undefined : (() => { const m = motifOf(item); return m ? MOTIF_COLORS[m] : undefined; })()) ?? item.work?.band;
  if (hex && /^#[0-9a-f]{6}$/i.test(hex)) return fromHex(hex);
  if (picture) return picture.base;
  return fromHex(item.flatColor);
}

export function renderBildkarte(o: BildkarteOptions): CanvasLike {
  const g = o.geometry;
  const k = o.pxPerMm;
  const B = g.bleedMm;
  const canvas = createCanvas((g.widthMm + 2 * B) * k, (g.heightMm + 2 * B) * k);
  const ctx = get2d(canvas);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const X = (mm: number) => (mm + B) * k;
  const Y = (mm: number) => (mm + B) * k;
  drawPictureCard(ctx, o, X, Y);
  return canvas;
}

type Mm = (mm: number) => number;

function measureWith(ctx: Context2D, face: StickerFont['title'], k: number): Measure {
  return (str, size) => {
    ctx.font = fontCss(face, size * k);
    return ctx.measureText(str).width / k;
  };
}

/**
 * A motif in a square box (mm), in `ink` on `ground`: filled outlines, the pen's width rounding their
 * corners, and lines with the motif's one pen; cut parts and gaps in the colour of the ground.
 */
export function drawMotif(ctx: Context2D, id: MotifId, x: number, y: number, side: number, ink: RGB, X: Mm, Y: Mm, k: number, ground: RGB) {
  ctx.save();
  ctx.translate(X(x + side / 2), Y(y + side / 2));
  ctx.scale(side * k, side * k);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const part of motifParts(id)) {
    const colour = toCss(part.cut ? ground : ink);
    if (part.outline && part.gap) {
      ctx.beginPath();
      smoothClosed(ctx, part.outline);
      ctx.strokeStyle = toCss(ground);
      ctx.lineWidth = 0.03 + 2 * part.gap;
      ctx.stroke();
    }
    ctx.fillStyle = colour;
    ctx.strokeStyle = colour;
    if (part.outline) {
      ctx.beginPath();
      smoothClosed(ctx, part.outline);
      for (const h of part.holes ?? []) smoothClosed(ctx, h);
      ctx.fill('evenodd');
      // The pen goes round the outline only, so the holes keep their size.
      ctx.beginPath();
      smoothClosed(ctx, part.outline);
      ctx.lineWidth = 0.03;
      ctx.stroke();
    }
    if (part.line) {
      ctx.beginPath();
      if (part.closed) smoothClosed(ctx, part.line);
      else smoothOpen(ctx, part.line);
      ctx.lineWidth = part.width ?? PEN;
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** An open line through the points, each corner pulled a little round. */
function smoothOpen(ctx: Context2D, pts: Pt[]) {
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const q: Pt = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], q[0], q[1]);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
}

/** A closed line through the points, each corner pulled a little round (as keystickers.ts). */
function smoothClosed(ctx: Context2D, pts: Pt[]) {
  const n = pts.length;
  const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(pts[n - 1], pts[0]);
  ctx.moveTo(start[0], start[1]);
  for (let i = 0; i < n; i++) {
    const q = mid(pts[i], pts[(i + 1) % n]);
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], q[0], q[1]);
  }
  ctx.closePath();
}

/** A rounded rectangle as the path (pixels); by hand, as ctx.roundRect is missing in older web views. */
function roundedRect(ctx: Context2D, px: number, py: number, pw: number, ph: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(px + r, py);
  ctx.arcTo(px + pw, py, px + pw, py + ph, r);
  ctx.arcTo(px + pw, py + ph, px, py + ph, r);
  ctx.arcTo(px, py + ph, px, py, r);
  ctx.arcTo(px, py, px + pw, py, r);
  ctx.closePath();
}

/** Size (mm) of the source line of a pictogram on the front: small, but readable in print. */
function creditLine(ctx: Context2D, width: number, font: StickerFont, k: number): { size: number } {
  const measure: Measure = (str, size) => {
    ctx.font = fontCss(font.text, size * k);
    return ctx.measureText(str).width / k;
  };
  return { size: fitLine(PICTOGRAM_CREDIT, measure, width, 1.25, 0.9) };
}

/**
 * An ARASAAC pictogram as ARASAAC gives it, on a white plate: only its size
 * changes and the colour behind it (the licence allows no more without
 * sharing the result as an adaptation). Whole, never cut, never tinted.
 */
function drawPictogram(ctx: Context2D, image: DrawableImage, x: number, y: number, side: number, X: Mm, Y: Mm, k: number) {
  const r = 1.6;
  ctx.save();
  ctx.fillStyle = '#ffffff';
  roundedRect(ctx, X(x), Y(y), side * k, side * k, r * k);
  ctx.fill();
  const pad = side * 0.05;
  const inner = side - 2 * pad;
  const src = imageSize(image);
  const scale = Math.min(inner / src.width, inner / src.height);
  const w = src.width * scale;
  const h = src.height * scale;
  drawImageHQ(ctx, image, 0, 0, src.width, src.height, X(x + (side - w) / 2), Y(y + (side - h) / 2), w * k, h * k);
  ctx.restore();
}

/** The small number in a corner, on a light plate like the other styles. */
function smallNumber(ctx: Context2D, number: string, x: number, y: number, h: number, ground: RGB, font: StickerFont, X: Mm, Y: Mm, k: number, measure: Measure) {
  const size = h * 0.62;
  const w = Math.max(h * 1.5, measure(number, size) + h * 0.6);
  const plate = mix(WHITE, ground, 0.06);
  drawNumberPlate(ctx, X(x), Y(y), w * k, h * k, plate, k);
  ctx.font = fontCss(font.title, size * k);
  ctx.fillStyle = toCss(contrast(ground, plate) >= 3 ? ground : DARK_INK);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(number, X(x + w / 2), Y(y + h / 2 + size * 0.35));
}

function drawPictureCard(ctx: Context2D, o: BildkarteOptions, X: Mm, Y: Mm) {
  const { item, picture, geometry: g, pxPerMm: k, font } = o;
  const W = g.widthMm;
  const H = g.heightMm;
  const S = g.safeMm;
  const ground = groundOf(item, picture);
  const ink = motifInk(ground);
  ctx.fillStyle = toCss(ground);
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const land = W >= H;
  const word = o.showTitle || !picture ? item.title.trim() : '';
  const measure = measureWith(ctx, font.title, k);
  const pictogram = picture ? null : (o.pictogram ?? null);
  const motif = picture || pictogram ? undefined : motifOf(item);
  // No picture and no motif for its words: the word alone, bigger, on the calm ground (no stand-in symbol).
  const bare = !picture && !pictogram && !motif;
  // A pictogram names its source (CC BY-NC-SA): on the back when backs are printed, else in a fine line at the foot.
  const credit = pictogram && !o.creditOnBack ? creditLine(ctx, W - 2 * S, font, k) : undefined;
  const footH = credit ? credit.size * 1.6 : 0;
  // The motif about 60 % of the height, the word under it; together in the middle.
  const side0 = bare ? 0 : land ? H * 0.58 : Math.min(W - 2 * S - 6, H * 0.5);
  const wordMax = bare ? (land ? H * 0.24 : W * 0.2) : land ? H * 0.17 : W * 0.15;
  const fitted = word ? fitText(word, measure, { maxWidth: W - 2 * S, maxHeight: wordMax * (bare ? 3.3 : 2.3), maxLines: bare ? 3 : 2, maxSize: wordMax, minSize: 2.6, lineHeight: 1.05 }) : undefined;
  const gap = fitted && !bare ? (land ? 2.2 : 3.5) : 0;
  // A title of two lines takes its room from the motif, so nothing runs off the sticker.
  const side = Math.max(0, Math.min(side0, H - 2 * S - gap - (fitted?.height ?? 0) - footH));
  const block = side + gap + (fitted?.height ?? 0);
  const top = Math.max(S, (H - footH - block) / 2);
  const x = (W - side) / 2;
  if (picture) {
    const src = imageSize(picture.image);
    // The whole cover, unless it was cut on its own ("Sticker anpassen").
    const p = placePicture(src.width, src.height, side, side, { zoom: item.zoom ?? 0, focusX: item.focusX, focusY: item.focusY });
    const r = 1 * k;
    ctx.save();
    const [px, py, pw, ph] = [X(x + p.dest.x), Y(top + p.dest.y), p.dest.width * k, p.dest.height * k];
    roundedRect(ctx, px, py, pw, ph, r);
    ctx.clip();
    drawImageHQ(ctx, picture.image as DrawableImage, p.src.x, p.src.y, p.src.width, p.src.height, px, py, pw, ph);
    ctx.restore();
  } else if (pictogram) drawPictogram(ctx, pictogram, x, top, side, X, Y, k);
  else if (motif) drawMotif(ctx, motif, x, top, side, ink, X, Y, k, ground);
  if (fitted) {
    ctx.font = fontCss(font.title, fitted.size * k);
    ctx.fillStyle = toCss(ink);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    let y = top + side + gap;
    for (const line of fitted.lines) {
      ctx.fillText(line, X(W / 2), Y(y + fitted.size * 0.8));
      y += fitted.size * 1.05;
    }
  }
  if (credit) {
    ctx.font = fontCss(font.text, credit.size * k);
    ctx.fillStyle = toCss(ink);
    ctx.globalAlpha = 0.85;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(PICTOGRAM_CREDIT, X(W / 2), Y(H - S + 0.6 - credit.size * 0.3));
    ctx.globalAlpha = 1;
  }
  if (item.number && o.showNumber) smallNumber(ctx, item.number, S - 0.5, S - 0.5, 5.5, ground, font, X, Y, k, measure);
  // The small TonUINO mark in the corner, as the other styles carry it (review of the draft, 20.10.2026):
  // top right, level with the number, so the word below has the whole width (it ran into the mark at the foot).
  const markH = 3.2;
  const markTop = S - 0.5 + (5.5 - markH) / 2;
  const markMax = W * 0.3;
  if (o.logo) {
    const size = imageSize(o.logo);
    const w = Math.min(markMax, markH * (size.width / size.height));
    const h = w * (size.height / size.width);
    const img = o.tintLogo && hasClearBackground(o.logo) ? tinted(o.logo, ink) : o.logo;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.drawImage(img as CanvasImageSource, X(W - S + 0.5 - w), Y(markTop + (markH - h) / 2), w * k, h * k);
    ctx.restore();
  } else if (o.word) {
    const size = fitLine(o.word, (str, sz) => {
      ctx.font = wordmarkFont(sz * k, font);
      return ctx.measureText(str).width / k;
    }, markMax, markH, 1.6);
    ctx.font = wordmarkFont(size * k, font);
    ctx.fillStyle = toCss(ink);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(o.word, X(W - S + 0.5), Y(markTop + markH / 2 + size * 0.36));
  }
}
