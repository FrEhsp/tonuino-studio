/**
 * Draws one sticker: background, picture, title, number and logo, following
 * the layout of the chosen style. Works in millimetres and converts to pixels
 * at the requested resolution, so the preview and the 300-dpi print come out
 * identical.
 */
import { isCompact, pictureFrame, placementBox, stickerLayout, type Box, type Slot, type StickerGeometry, type StickerLayout } from '../../core/stickers/layout';
import { ellipsize, fitLine, fitText, type Measure } from '../../core/stickers/text';
import { BLACK, bestTextColor, contrast, paperOf, darkeningFor, ensureContrast, inkOnPhoto, lightestCell, luminance, mix, toCss, WHITE, type RGB } from '../../core/stickers/color';
import { blurredBackground, createCanvas, drawContain, drawImageHQ, fitContain, get2d, imageSize, placePicture, type CanvasLike, type Context2D, type DrawableImage, type RectPx } from '../../core/stickers/image';
import { EDGE_STRIP, flatness } from '../../core/covers/analyse';
import { analyseImage } from '../../core/covers/build';
import { paintCard } from '../../core/covers/paint';
import { planCard } from '../../core/covers/plan';
import { resolveLayout } from '../../core/covers/recipe';
import { fontCss, wordmarkFont, type StickerFont } from './fonts';
import type { StickerItem, PreparedPicture } from './content';
import type { StickerDesign } from './design';
import type { BackInk } from './backside';
import { cassetteColors, drawNumberPlate, drawTapeLines, drawTapeParts, flapLine, PAPER, splitEpisode, tapeColors } from './tape';

/**
 * Version of the sticker drawing. Raise it whenever a sticker comes out
 * different for the same contents (this file, tape.ts, the layout, the
 * fonts): shelf stickers kept on this computer are then drawn again instead
 * of showing the old look.
 */
export const STICKER_LOOK = 10;

export interface RenderOptions {
  item: StickerItem;
  picture: PreparedPicture;
  design: StickerDesign;
  /** Artwork geometry (already turned for portrait). */
  geometry: StickerGeometry;
  pxPerMm: number;
  font: StickerFont;
  /** Picture logo, when the design asks for one. */
  logo?: DrawableImage | null;
}

const MIN_TITLE_MM = 2.6;
const PILL_TEXT = { r: 20, g: 26, b: 40 };

/**
 * "Bild unten abdunkeln": the darkening behind the text, as black over the
 * picture. At least a little, at most SCRIM_MAX; a picture that would need
 * more than SCRIM_LIMIT is too light under the text and gets the colour band.
 */
const SCRIM_MIN = 0.2;
const SCRIM_LIMIT = 0.45;
const SCRIM_MAX = 0.66;
/** The darkening fades in over this distance above the text, mm. */
const SCRIM_FADE_MM = 6;

/** Zoom of the picture: the sticker's own, else whole pictures (0) or filled (1) as the design says. */
export function stickerZoom(item: StickerItem, design: StickerDesign): number {
  // A generated picture is always shown whole: its number and title strip must not be cut off; around it is the same flat colour.
  if (!item.picture) return 0;
  return item.zoom ?? designZoom(design);
}

/**
 * The zoom a sticker without one of its own follows. Vollbild always fills the sticker: shown whole, a square
 * cover stood small between two colour panels, which a blind audit at print size called a layout error
 * (sticker style audit 20.10.2026, TODO #91); "Ganz gezeigt" is for the other styles.
 */
export function designZoom(design: Pick<StickerDesign, 'style' | 'wholePicture'>): number {
  return design.style !== 'full' && design.wholePicture ? 0 : 1;
}

export function badgeText(item: StickerItem, design: StickerDesign, compact = false): string | undefined {
  // A round or square sticker shows no title: one of several cards of a folder says which part it plays.
  if (compact && item.part) return item.part;
  // A card for some tracks of a folder (an episode of a packed series, one title) names folder and tracks:
  // "05 · 12–24". Without a picture of its own the number is written big on the generated one already.
  if (item.part && item.number && /^\d/.test(item.part)) return item.picture || !design.showNumber ? `${item.number} · ${item.part}` : `Titel ${item.part}`;
  return item.detail ?? (design.showNumber && item.picture ? item.number : undefined);
}

/** A badge of numbers only ("05", "05 · 12–24"): written as large as the room allows, a word stays modest. */
function numeric(badge: string): boolean {
  return /^[\d\s·–-]+$/.test(badge);
}

/** The title is on: for the design, or always for one of several cards of a folder (StickerItem.part). */
export function titleShown(item: StickerItem, design: StickerDesign): boolean {
  return design.showTitle || !!item.part;
}

/** `pictureAspect`: width / height of the picture, so tall pictures (cassette covers) lose less. */
export function layoutFor(item: StickerItem, design: StickerDesign, geometry: StickerGeometry, hasLogo: boolean, pictureAspect?: number): StickerLayout {
  return stickerLayout(geometry, {
    // Bildkarte draws itself (bildkarte.ts); on round and square labels, and for the print check of its
    // picture, it is placed as on Klassisch.
    style: design.style === 'bild' ? 'blur' : design.style,
    title: titleShown(item, design) && !!item.title.trim(),
    badge: !!badgeText(item, design, isCompact(geometry)),
    badgeWide: /·/.test(badgeText(item, design, isCompact(geometry)) ?? ''),
    logo: hasLogo,
    pictureAspect,
    darken: design.darken,
  });
}

/**
 * What a sticker of "Kassette" writes besides its title (audit 20.10.2026, TODO #91): the series or
 * artist on the spine, without the episode, so the sticker carries one number only (the folder's, on the
 * plate); and the flap's small line under the title, "Folge 50 · 44 Min." or "14 Titel · 52 Min.", so
 * the flap says what is on the card as the inlay of a real cassette does.
 */
export function tapeText(item: StickerItem): { spine?: string; meta?: string } {
  const named = (item.series ?? item.subtitle)?.trim();
  // A further card of a folder keeps the folder on the spine and its own title alone.
  if (item.part) return { spine: named };
  const split = item.series ? splitEpisode(item.series.trim()) : undefined;
  return { spine: split ? split.name : named, meta: flapLine(item, !!split?.episode) };
}

export function hasLogo(design: StickerDesign, logo?: DrawableImage | null): boolean {
  return design.logo === 'text' ? !!design.logoText.trim() : design.logo === 'image' || design.logo === 'tonuino' ? !!logo : false;
}

export function renderSticker(o: RenderOptions): CanvasLike {
  const { item, picture, design, geometry: g, font } = o;
  const k = o.pxPerMm;
  const B = g.bleedMm;
  const W = g.widthMm;
  const H = g.heightMm;
  const canvas = createCanvas((W + 2 * B) * k, (H + 2 * B) * k);
  const ctx = get2d(canvas, { willReadFrequently: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const X = (mm: number) => (mm + B) * k;
  const Y = (mm: number) => (mm + B) * k;
  const logoOn = hasLogo(design, o.logo);
  const source = imageSize(picture.image);
  let layout = layoutFor(item, design, g, logoOn, source.width / source.height);
  // A generated picture carries its title strip low down, where the wordmark of Vollbild would go: it moves to the top right.
  if (picture.generated && layout.logo && layout.background === 'picture' && !layout.band && !layout.scrim) {
    const l = layout.logo;
    layout = { ...layout, logo: { ...l, x: W - g.safeMm - l.width, y: g.safeMm, align: 'right', valign: 'top' } };
  }
  const focus = { focusX: item.focusX, focusY: item.focusY, zoom: stickerZoom(item, design) };
  // "Kassette" in flat colours: the colours of a calm cover edge run on, else the colour the cover is in.
  const flat = !!layout.tape && !picture.generated;
  const frame = flat ? { ...layout.picture, ...pictureFrame(layout.picture, g, focus.zoom) } : undefined;
  const upright = !!layout.tape?.foot;
  const coverSrc = frame ? placePicture(source.width, source.height, frame.width, frame.height, focus).src : undefined;
  // The right edge decides the colours in both orientations, so a sticker looks the same upright and across
  // (Frank 17.10.2026: „warum so anders“); upright, the bottom edge only decides the seam under the cover.
  // Upright the window crops the cover differently: its colours come from the whole cover's edge, as across.
  const coverEdge = coverSrc ? coverSide(picture.image, upright ? { x: 0, y: 0, width: source.width, height: source.height } : coverSrc, false) : undefined;
  const seamEdge = coverSrc && upright ? coverSide(picture.image, coverSrc, true) : coverEdge;
  // A light, colourless edge reads as paper: the strip is then plain white, not a creamy tint of it.
  const calmEdge = coverEdge && coverEdge.share >= EDGE_CALM ? paperOf(coverEdge.color) : undefined;
  // A colour chosen for the sticker or a known work's colour keeps the spine; else the cover decides.
  const own = !!item.color || !!item.work?.band;
  // The colours of a known work, unless a colour of its own was chosen: the plate then follows that colour.
  const work = item.color ? undefined : item.work;
  let tape = layout.tape
    ? flat
      ? cassetteColors({ palette: picture.palette, calm: calmEdge, own: own ? picture.base : undefined, work })
      : tapeColors(picture.base, work)
    : undefined;
  const base = tape && flat ? tape.band : picture.base;
  // Strong blur on a slightly enlarged picture: colour and light, no recognisable shapes behind the text.
  const blurred = () =>
    blurredBackground(picture.backdrop ?? picture.image, canvas.width, canvas.height, 5 * k, { ...focus, zoom: Math.max(1, focus.zoom) * 1.3 });
  // The picture as background, in its box (all of the sticker, or above the band of Vollbild).
  const drawPictureBackground = (l: StickerLayout) => {
    const box = l.picture;
    // Shown whole, the picture stays out of the bleed that is cut off. A cover cut out of
    // all of the sticker (pictureFit) keeps its section and is clipped above the band.
    const frame = placementBox(l, g, focus.zoom);
    const place = placePicture(source.width, source.height, frame.width, frame.height, focus);
    const d = { x: frame.x + place.dest.x, y: frame.y + place.dest.y, width: place.dest.width, height: place.dest.height };
    // The whole picture leaves room around it: a flat edge colour runs on there, else a flat panel colour (never smeared).
    if (leavesRoom(d, box)) edgeFill(ctx, picture.image, place.src, d, box, X, Y, k, base);
    // A square cover on a portrait Vollbild of a folder: built with its recipe, as the shelf's card.
    if (l.extend && recipeArea(ctx, picture.image, item, l, g, k, font, base)) return;
    // Else above it its top edge runs on when it is one flat colour, else the panel colour.
    if (l.extend) edgeFill(ctx, picture.image, place.src, d, { ...box, y: l.extend.y, height: box.y + box.height - l.extend.y }, X, Y, k, base);
    ctx.save();
    ctx.beginPath();
    ctx.rect(X(box.x), Y(box.y), box.width * k, box.height * k);
    ctx.clip();
    drawImageHQ(ctx, picture.image, place.src.x, place.src.y, place.src.width, place.src.height, X(d.x), Y(d.y), d.width * k, d.height * k);
    ctx.restore();
  };

  const measureWith =
    (face: StickerFont['title']): Measure =>
    (str, size) => {
      ctx.font = fontCss(face, size * k);
      return ctx.measureText(str).width / k;
    };
  const measureTitle = measureWith(font.title);
  const measureText = measureWith(font.text);

  // Background.
  switch (layout.background) {
    case 'blur':
      ctx.drawImage(blurred(), 0, 0);
      break;
    case 'paper':
      ctx.fillStyle = toCss(PAPER);
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (layout.tape && tape) drawTapeParts(ctx, layout.tape, tape, X, Y, k);
      break;
    case 'picture':
      drawPictureBackground(layout);
      break;
  }

  // Darkened Vollbild: only behind the text, only as much as the picture there needs. Too light there
  // (or a picture drawn here, one flat colour), and the sticker takes the colour band instead.
  let scrim: { top: number; alpha: number } | undefined;
  if (layout.scrim && layout.text) {
    const t = layout.text;
    const fitted = fitTitle(t, item, measureTitle, measureText);
    const top = Math.min(t.y + t.height - fitted.height, layout.badge?.y ?? Infinity);
    // Only where something is written: the lines as long as they are, and the number.
    const lines = [...fitted.title.lines.map((l) => measureTitle(l, fitted.title.size)), ...(fitted.subtitle?.lines.map((l) => measureText(l, fitted.subtitle!.size)) ?? [])];
    const right = layout.badge ? layout.badge.x + layout.badge.width : t.x + Math.min(t.width, Math.max(1, ...lines));
    const under = lightestRegion(ctx, X(t.x), Y(top), (right - t.x) * k, (t.y + t.height - top) * k);
    const need = darkeningFor(under);
    if (picture.generated || need > SCRIM_LIMIT) {
      layout = layoutFor(item, { ...design, darken: false }, g, logoOn, source.width / source.height);
      // The band takes the foot: the picture again, in the room above it.
      drawPictureBackground(layout);
    } else scrim = { top: Math.max(layout.scrim.y, top - SCRIM_FADE_MM), alpha: Math.max(SCRIM_MIN, need) };
  }

  // Colours of text and number.
  let text: RGB;
  let soft: RGB;
  let accent: RGB;
  if (tape) {
    // Portrait: the title in the field of the band's colour; landscape: on the paper flap.
    const onBand = !!(layout.text && layout.tape?.foot && inside(layout.text, layout.tape.foot));
    text = onBand && !flat ? tape.onBand : tape.onPaper;
    soft = text;
    accent = text;
  } else if (layout.surface === 'panel') {
    text = bestTextColor(base);
    soft = text;
    accent = text;
  } else if (layout.surface === 'blur') {
    // Text sits on the blurred picture: pick the colour from what is really there, then calm the background.
    const region = layout.text ?? layout.badge ?? layout.logo;
    const avg = region ? averageRegion(ctx, X(region.x), Y(region.y), region.width * k, region.height * k) : picture.palette.dominant;
    text = bestTextColor(avg);
    const lightText = text.r > 128;
    // A generated picture lies on its own flat colour: nothing to calm down there.
    if (!picture.generated) {
      ctx.fillStyle = lightText ? 'rgb(0 0 0 / 0.2)' : 'rgb(255 255 255 / 0.28)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    soft = text;
    accent = text;
  } else if (layout.band) {
    text = bestTextColor(base);
    soft = text;
    accent = text;
  } else {
    text = WHITE;
    soft = WHITE;
    accent = WHITE;
  }

  // The picture on its own (styles blur, color and tape). Shown whole, it keeps its own shape inside the area.
  if (layout.background !== 'picture') {
    const p = { ...layout.picture, ...pictureFrame(layout.picture, g, focus.zoom) };
    const place = placePicture(source.width, source.height, p.width, p.height, focus);
    const v = { x: p.x + place.dest.x, y: p.y + place.dest.y, width: place.dest.width, height: place.dest.height };
    const r = p.radius * k;
    // The cassette's cover fills its window; shown whole, flat edges run on around it, else the panel colour.
    if (layout.tape && leavesRoom(v, layout.picture)) edgeFill(ctx, picture.image, place.src, v, layout.picture, X, Y, k, tape?.field ?? base);
    if (p.shadow && !picture.generated) {
      ctx.save();
      ctx.shadowColor = 'rgb(0 0 0 / 0.32)';
      ctx.shadowBlur = 1.8 * k;
      ctx.shadowOffsetY = 0.5 * k;
      roundRect(ctx, X(v.x), Y(v.y), v.width * k, v.height * k, r);
      ctx.fillStyle = toCss(base);
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    roundRect(ctx, X(v.x), Y(v.y), v.width * k, v.height * k, r);
    ctx.clip();
    drawImageHQ(ctx, picture.image, place.src.x, place.src.y, place.src.width, place.src.height, X(v.x), Y(v.y), v.width * k, v.height * k);
    ctx.restore();
    // Plain paper next to the cover looked empty beside Klassisch (Frank, 17.10.2026): see drawFlap.
    if (layout.tape && tape && !picture.generated) {
      // A white cover edge beside the white field: a fine line in a pale tone of the spine keeps the cover's
      // edge (re-audit 17.10.2026: „HERD“ looked cut off); a field set in beside a busy edge: the spine's white line.
      const seam = !seamEdge || seamEdge.share < EDGE_CALM
        ? { width: (upright ? layout.tape.lines[0]?.height : layout.tape.lines[0]?.width) ?? 0.5, color: WHITE }
        : luminance(tape.field) > 0.95 && luminance(seamEdge.color) > 0.8
          ? { width: 0.3, color: mix(tape.band, WHITE, 0.55) }
          : undefined;
      if (upright) drawFoot(tape.field, seam, ctx, Y(v.y + v.height), canvas.width, canvas.height, k);
      else drawFlap(tape.field, seam, ctx, X(v.x + v.width), canvas.width, canvas.height, k);
      const spot = layout.logo ?? layout.text;
      if (spot) {
        // The writing colour of the field, kept readable on what is really under it.
        const under = averageRegion(ctx, X(spot.x), Y(spot.y), spot.width * k, spot.height * k);
        tape = { ...tape, onPaper: ensureContrast(tape.onPaper, under, 4.5) };
        text = soft = accent = tape.onPaper;
      }
    }
    // Upright on a cover, the line under it is the seam of the field (drawFoot), as beside it.
    if (layout.tape) drawTapeLines(ctx, upright && flat ? { ...layout.tape, lines: layout.tape.lines.slice(0, 1) } : layout.tape, X, Y, k);
  }

  // Vollbild: the colour band across the foot, straight against the picture (the light stripe above it
  // read as a leftover in the blind audit of 20.10.2026).
  const band = layout.band;
  if (band) {
    ctx.fillStyle = toCss(base);
    ctx.fillRect(X(band.x), Y(band.y), band.width * k, band.height * k);
  }

  if (layout.scrim && scrim) {
    const s = layout.scrim;
    const bottom = s.y + s.height;
    const grad = ctx.createLinearGradient(0, Y(scrim.top), 0, Y(bottom));
    grad.addColorStop(0, 'rgb(0 0 0 / 0)');
    grad.addColorStop(Math.min(1, SCRIM_FADE_MM / (bottom - scrim.top)), `rgb(0 0 0 / ${scrim.alpha})`);
    grad.addColorStop(1, `rgb(0 0 0 / ${Math.min(SCRIM_MAX, scrim.alpha + 0.08)})`);
    ctx.fillStyle = grad;
    ctx.fillRect(X(s.x), Y(scrim.top), s.width * k, (bottom - scrim.top) * k);
  }

  const onPicture = layout.surface === 'picture';
  // Title and number on the band are not on the photo: no shadow there.
  const textOnPicture = onPicture && !band;

  // Number or detail first: the logo in the same row must leave room for it.
  let badgeLeft = Infinity;
  const badge = badgeText(item, design, isCompact(g));
  if (layout.badge && badge) {
    const b = layout.badge;
    if (b.kind === 'plate' && layout.tape?.plate && tape) {
      // The number as on Vollbild, on a light rounded plate, in the colours of the work.
      const p = layout.tape.plate;
      drawNumberPlate(ctx, X(p.x), Y(p.y), p.width * k, p.height * k, tape.plate, k, tape.band);
      const digits = numeric(badge);
      // As large as the pill of Vollbild (0.58 of its height); a word such as "15 Min." smaller.
      const size = fitLine(badge, measureTitle, b.width, Math.min(p.height * (digits ? 0.62 : 0.42), b.height / 0.72), 1.4);
      ctx.font = fontCss(font.title, size * k);
      ctx.fillStyle = toCss(tape.digits);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(badge, X(b.x + b.width / 2), Y(p.y + p.height / 2 + capHeight(size) / 2));
      badgeLeft = p.x;
    } else if (b.kind === 'pill') {
      const h = b.height;
      let size = h * 0.58;
      const pad = h * 0.5;
      size = fitLine(badge, measureTitle, b.width - 2 * pad, size, h * 0.35);
      const w = Math.min(b.width, measureTitle(badge, size) + 2 * pad);
      const x = b.align === 'right' ? b.x + b.width - w : b.align === 'center' ? b.x + (b.width - w) / 2 : b.x;
      const y = b.y + b.height - h;
      ctx.save();
      ctx.shadowColor = 'rgb(0 0 0 / 0.25)';
      ctx.shadowBlur = 0.8 * k;
      roundRect(ctx, X(x), Y(y), w * k, h * k, (h / 2) * k);
      ctx.fillStyle = 'rgb(255 255 255 / 0.94)';
      ctx.fill();
      ctx.restore();
      ctx.font = fontCss(font.title, size * k);
      ctx.fillStyle = toCss(PILL_TEXT);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(badge, X(x + w / 2), Y(y + h / 2 + capHeight(size) / 2));
      badgeLeft = x;
    } else if (layout.background === 'blur' && numeric(badge)) {
      // Klassisch: the number on the same light plate as Kassette and Vollbild, in the work's colours
      // (Frank, 17.10.2026: „War hier das mit der Zahl nicht mal einheitlich zu Hörspiel?“).
      const own = tapeColors(base, item.color ? undefined : item.work);
      const h = Math.min(b.height, 8);
      const size = fitLine(badge, measureTitle, b.width - h * 0.6, h * 0.62, 1.4);
      const w = Math.max(h * 1.5, measureTitle(badge, size) + h * 0.6);
      const x = b.align === 'center' ? b.x + (b.width - w) / 2 : b.align === 'right' ? b.x + b.width - w : b.x;
      const y = b.y + b.height - h;
      drawNumberPlate(ctx, X(x), Y(y), w * k, h * k, own.plate, k);
      ctx.font = fontCss(font.title, size * k);
      ctx.fillStyle = toCss(own.digits);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(badge, X(x + w / 2), Y(y + h / 2 + capHeight(size) / 2));
      badgeLeft = x;
    } else {
      // Digits may be large; a word like "15 Min." stays modest next to the title.
      const digits = numeric(badge);
      const maxSize = digits ? Math.min(b.height * 0.95, 18) : Math.min(b.height * (b.valign === 'middle' ? 0.5 : 0.62), 7);
      const size = fitLine(badge, measureTitle, b.width, maxSize, 2);
      const w = measureTitle(badge, size);
      ctx.font = fontCss(font.title, size * k);
      ctx.fillStyle = toCss(accent, layout.surface === 'panel' ? 0.92 : 1);
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = b.align === 'right' ? 'right' : b.align === 'center' ? 'center' : 'left';
      const ax = b.align === 'right' ? b.x + b.width : b.align === 'center' ? b.x + b.width / 2 : b.x;
      const baseline = b.valign === 'bottom' ? b.y + b.height - size * 0.02 : b.valign === 'top' ? b.y + capHeight(size) : b.y + b.height / 2 + capHeight(size) / 2;
      withShadow(ctx, textOnPicture, k, () => ctx.fillText(badge, X(ax), Y(baseline)));
      badgeLeft = b.align === 'right' ? ax - w : b.align === 'center' ? ax - w / 2 : ax;
    }
  }

  // The series (or author) in the band of a cassette sticker, in full, also without a title;
  // the line under the title then goes when it says nothing more ("Folge 5"). Without a series
  // and without a title shown, the band says what is on the card.
  let titled = item;
  const head = layout.tape?.head;
  // Only with the flap's line shown does the episode leave the spine: it must stay on the sticker.
  const said = layout.tape && layout.text && !layout.text.up ? tapeText(item) : undefined;
  const named = said ? said.spine : (item.series ?? item.subtitle)?.trim();
  const series = named || (!layout.text ? item.title.trim() : '');
  if (head && tape && series) {
    ctx.save();
    let slot: Box = head;
    if (head.up) {
      // Along the spine, from bottom to top: the box turned a quarter to the left.
      ctx.translate(X(head.x), Y(head.y + head.height));
      ctx.rotate(-Math.PI / 2);
      ctx.translate(-X(0), -Y(0));
      slot = { x: 0, y: 0, width: head.height, height: head.width };
    }
    const fitted = headLines(series, measureTitle, slot);
    ctx.font = fontCss(font.title, fitted.size * k);
    ctx.fillStyle = toCss(tape.onBand);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const lh = fitted.size * HEAD_LINE_HEIGHT;
    const block = capHeight(fitted.size) + (fitted.lines.length - 1) * lh;
    const first = slot.y + (slot.height - block) / 2 + capHeight(fitted.size);
    fitted.lines.forEach((line, i) => ctx.fillText(line, X(slot.x), Y(first + i * lh)));
    ctx.restore();
    const sub = item.subtitle?.trim().toLowerCase();
    const full = (item.series ?? item.subtitle)?.trim().toLowerCase();
    if (named && (!sub || named.toLowerCase().includes(sub) || full?.includes(sub))) titled = { ...item, subtitle: undefined };
  }
  // Upright, the line stands on the wordmark's row, left of it, where the field is empty anyway: every
  // sticker then shows it in the same place, also under a title of two lines (final audit 20.10.2026).
  let footLine: { text: string; size: number } | undefined;
  const mark = layout.logo;
  if (said?.meta && layout.tape?.foot && layout.text && mark && logoOn && mark.align === 'right') {
    let left = mark.x;
    if (design.logo !== 'text' && o.logo) {
      const size = imageSize(o.logo);
      left = mark.x + mark.width - Math.min(mark.width, Math.min(mark.height * 0.8, 7.5) * (size.width / size.height));
    }
    const room = left - 1.5 - layout.text.x;
    const size = fitLine(said.meta, measureText, room, ASIDE_MIN_MM, 2.1);
    if (measureText(said.meta, size) <= room) footLine = { text: said.meta, size };
  }
  // Else the flap's small line takes the place of the subtitle, never making the title smaller.
  if (said?.meta && !footLine && layout.text && !layout.text.up && !titled.subtitle) {
    titled = { ...titled, subtitle: said.meta };
    layout = { ...layout, text: { ...layout.text, aside: true } };
  }

  // Klassisch: under the title the series or artist, then the line of the cassette's flap ("Folge 50 · 44 Min.",
  // "14 Titel · 52 Min."), filling the panel's empty middle (sticker style audit 20.10.2026: better, blind).
  let meta: string | undefined;
  if (design.style === 'blur' && layout.text && !item.part) {
    const t = tapeText(item);
    // Nothing the title already says ("Unter meinem Bett 8" over "Unter meinem Bett"), as folderSubtitle.
    const named = t.spine && !item.title.toLowerCase().includes(t.spine.toLowerCase()) ? t.spine : undefined;
    titled = { ...titled, subtitle: named };
    meta = t.meta;
  }
  // Title and subtitle.
  if (layout.text?.up && tape) {
    // Along the spine, from bottom to top: the box turned a quarter to the left.
    const t = layout.text;
    ctx.save();
    ctx.translate(X(t.x), Y(t.y + t.height));
    ctx.rotate(-Math.PI / 2);
    const local = (mm: number) => mm * k;
    const turned = { ...t, x: 0, y: 0, width: t.height, height: t.width };
    drawTitle(ctx, turned, titled, { measureTitle, measureText, font, k, X: local, Y: local, text: tape.onBand, soft: tape.onBand, onPicture: false });
    ctx.restore();
  } else if (layout.text) drawTitle(ctx, layout.text, titled, { measureTitle, measureText, font, k, X, Y, text, soft, onPicture: textOnPicture, meta });
  if (footLine && layout.text && mark) {
    ctx.font = fontCss(font.text, footLine.size * k);
    ctx.fillStyle = toCss(text);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    // On the wordmark's foot line, as one row with it.
    ctx.fillText(footLine.text, X(layout.text.x), Y(mark.y + mark.height - footLine.size * 0.04));
  }

  // Logo.
  if (layout.logo && logoOn) {
    const l = layout.logo;
    const sameRow = layout.badge && Math.abs(layout.badge.y + layout.badge.height - (l.y + l.height)) < 0.01;
    const avail = sameRow && Number.isFinite(badgeLeft) && l.align !== 'right' ? Math.min(l.width, badgeLeft - l.x - 2) : l.width;
    if (avail > 3) {
      // On a band or panel the logo takes the colour of the text there; straight on the photo the picture at that spot decides.
      const onFoot = !!(layout.tape?.foot && inside(l, layout.tape.foot));
      const onBand = !!(layout.band && inside(l, { ...layout.band, y: layout.band.y - 0.01 }));
      const photo = onPicture && !onBand;
      const inkAt = (spot: Box): RGB =>
        photo ? inkOnPhoto(averageRegion(ctx, X(spot.x), Y(spot.y), spot.width * k, spot.height * k)) : tape ? (onFoot && !flat ? tape.onBand : tape.onPaper) : text;
      if (design.logo === 'text') {
        const word = design.logoText.trim();
        const measureMark: Measure = (str, size) => {
          ctx.font = wordmarkFont(size * k, font);
          return ctx.measureText(str).width / k;
        };
        // Straight on the photo: white letters with a dark outline, as titles stand on real covers.
        const outline = photo ? mix(base, BLACK, 0.7) : undefined;
        drawWordmark(ctx, word, { ...l, width: avail, x: l.align === 'right' ? l.x + l.width - avail : l.x }, measureMark, photo ? WHITE : inkAt(l), outline, X, Y, k, font);
      } else if (o.logo) {
        const h = Math.min(l.height * 0.8, 7.5);
        const box = { x: l.align === 'right' ? l.x + l.width - avail : l.x, y: l.valign === 'top' ? l.y : l.valign === 'middle' ? l.y + (l.height - h) / 2 : l.y + l.height - h, width: avail, height: h };
        const align = { alignX: l.align === 'center' ? 0.5 : l.align === 'right' ? 1 : 0, alignY: l.valign === 'top' ? 0 : l.valign === 'middle' ? 0.5 : 1 };
        let img = o.logo;
        let ink: RGB | undefined;
        // The official logo is black on transparent: always in the colour of the writing around it.
        if ((design.logoTint || design.logo === 'tonuino') && hasClearBackground(img)) {
          const size = imageSize(img);
          const r = fitContain(size.width, size.height, box.width, box.height, align.alignX, align.alignY);
          ink = inkAt({ x: box.x + r.x, y: box.y + r.y, width: r.width, height: r.height });
          img = tinted(img, ink);
        }
        withShadow(ctx, photo, k, () => drawContain(ctx, img, X(box.x), Y(box.y), box.width * k, box.height * k, align), ink);
      }
    }
  }
  return canvas;
}

function drawTitle(
  ctx: Context2D,
  slot: Slot & { maxLines: number; aside?: boolean },
  item: StickerItem,
  c: {
    measureTitle: Measure;
    measureText: Measure;
    font: StickerFont;
    k: number;
    X: (mm: number) => number;
    Y: (mm: number) => number;
    text: RGB;
    soft: RGB;
    onPicture: boolean;
    meta?: string;
  },
) {
  const { title, subtitle, gap, height: blockH } = fitTitle(slot, item, c.measureTitle, c.measureText);
  let y = slot.valign === 'bottom' ? slot.y + slot.height - blockH : slot.valign === 'middle' ? slot.y + (slot.height - blockH) / 2 : slot.y;
  const ax = slot.align === 'center' ? slot.x + slot.width / 2 : slot.align === 'right' ? slot.x + slot.width : slot.x;
  ctx.textAlign = slot.align === 'center' ? 'center' : slot.align === 'right' ? 'right' : 'left';
  ctx.textBaseline = 'alphabetic';
  withShadow(ctx, c.onPicture, c.k, () => {
    ctx.font = fontCss(c.font.title, title.size * c.k);
    ctx.fillStyle = toCss(c.text);
    for (const line of title.lines) {
      ctx.fillText(line, c.X(ax), c.Y(y + lineBaseline(title.size, title.lineHeight)));
      y += title.size * title.lineHeight;
    }
    if (subtitle) {
      y += gap;
      ctx.font = fontCss(c.font.text, subtitle.size * c.k);
      ctx.fillStyle = toCss(c.soft, slot.aside ? 1 : 0.8);
      for (const line of subtitle.lines) {
        ctx.fillText(line, c.X(ax), c.Y(y + lineBaseline(subtitle.size, subtitle.lineHeight)));
        y += subtitle.size * subtitle.lineHeight;
      }
    }
    if (c.meta) {
      // As the subtitle, a breath smaller; a long line shrinks down to the flap's smallest size, never below.
      const size = fitLine(c.meta, c.measureText, slot.width * 0.98, Math.max(ASIDE_MIN_MM, (subtitle?.size ?? title.size * 0.62) * 0.92), ASIDE_MIN_MM);
      const top = y + (subtitle ? size * 0.25 : gap);
      if (top + size * 1.1 <= slot.y + slot.height && c.measureText(c.meta, size) <= slot.width) {
        ctx.font = fontCss(c.font.text, size * c.k);
        ctx.fillStyle = toCss(c.soft, 0.8);
        ctx.fillText(c.meta, c.X(ax), c.Y(top + lineBaseline(size, 1.1)));
      }
    }
  });
}

/**
 * Title and subtitle fitted into their slot; `height` is the whole block.
 * The title always wins: when room kept for the subtitle would cut the title
 * short, or the subtitle does not fit after all, the title gets all of the
 * slot and the subtitle is left out.
 */
export function fitTitle(slot: Slot & { maxLines: number; maxSize?: number; aside?: boolean }, item: Pick<StickerItem, 'title' | 'subtitle'>, measureTitle: Measure, measureText: Measure) {
  const maxSize = Math.min(5.4, slot.height * 0.42, slot.maxSize ?? Infinity);
  const sub = item.subtitle?.trim();
  const fit = (reserve: number) =>
    fitText(item.title.trim(), measureTitle, {
      maxWidth: slot.width,
      maxHeight: Math.max(slot.height - reserve, MIN_TITLE_MM * 1.1),
      maxLines: slot.maxLines,
      maxSize,
      minSize: MIN_TITLE_MM,
      lineHeight: 1.08,
      // In a narrow column (the flap of "Kassette") whole words read better than a larger, chopped title.
      hyphenGain: slot.width < 26 ? 1.6 : undefined,
    });
  // Reserve room for at least one subtitle line while fitting the title; a small aside (the flap's line
  // of "Kassette") never makes the title smaller: it goes where room is left, or not at all.
  let title = fit(sub && !slot.aside ? Math.max(2.2, maxSize * 0.62) * 1.6 : 0);
  let subtitle: ReturnType<typeof fitText> | null = null;
  if (sub) {
    const size = Math.min(3.3, Math.max(slot.aside ? ASIDE_MIN_MM : 2.1, title.size * 0.62));
    const room = slot.height - title.height - title.size * 0.38;
    if (room >= size * 1.15) {
      subtitle = fitText(sub, measureText, { maxWidth: slot.width, maxHeight: room, maxLines: 2, maxSize: size, minSize: Math.min(size, 2.1), lineHeight: 1.15 });
      if (!subtitle.lines.length) subtitle = null;
    }
    if (title.truncated || !subtitle) {
      title = fit(0);
      subtitle = null;
    }
  }
  const gap = title.size * 0.38;
  return { title, subtitle, gap, height: title.height + (subtitle ? gap + subtitle.height : 0) };
}

/** Baseline inside a line box of size × lineHeight. */
function lineBaseline(size: number, lineHeight: number): number {
  return size * 0.8 + ((lineHeight - 1) * size) / 2;
}

/** Height of capital letters and digits, roughly the same in all sticker fonts. */
function capHeight(size: number): number {
  return size * 0.7;
}

function inside(a: Box, b: Box): boolean {
  return a.x >= b.x - 1e-6 && a.y >= b.y - 1e-6 && a.x + a.width <= b.x + b.width + 1e-6 && a.y + a.height <= b.y + b.height + 1e-6;
}

/** Lifts text off a photo: a dark shadow under light ink, a light glow around dark ink. */
function withShadow(ctx: Context2D, on: boolean, k: number, draw: () => void, ink: RGB = WHITE) {
  if (!on) {
    draw();
    return;
  }
  const light = luminance(ink) > 0.5;
  ctx.save();
  ctx.shadowColor = light ? 'rgb(0 0 0 / 0.45)' : 'rgb(255 255 255 / 0.6)';
  ctx.shadowBlur = 0.9 * k;
  ctx.shadowOffsetY = light ? 0.15 * k : 0;
  draw();
  ctx.restore();
}

function roundRect(ctx: Context2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Colours of a canvas region, read from an 8 × 8 reduction. */
function sampleRegion(ctx: Context2D, x: number, y: number, w: number, h: number): RGB[] {
  const n = 8;
  const small = createCanvas(n, n);
  const s = get2d(small, { willReadFrequently: true });
  s.drawImage(ctx.canvas as CanvasImageSource, Math.max(0, x), Math.max(0, y), Math.max(1, w), Math.max(1, h), 0, 0, n, n);
  const d = s.getImageData(0, 0, n, n).data;
  const out: RGB[] = [];
  for (let i = 0; i < d.length; i += 4) out.push({ r: d[i], g: d[i + 1], b: d[i + 2] });
  return out;
}

/** Mean colour of a canvas region. */
function averageRegion(ctx: Context2D, x: number, y: number, w: number, h: number): RGB {
  const all = sampleRegion(ctx, x, y, w, h);
  const sum = all.reduce((a, c) => ({ r: a.r + c.r, g: a.g + c.g, b: a.b + c.b }), { r: 0, g: 0, b: 0 });
  return { r: sum.r / all.length, g: sum.g / all.length, b: sum.b / all.length };
}

/** The lightest part of a canvas region (see lightestCell): white text must stay readable there too, not only on average. */
function lightestRegion(ctx: Context2D, x: number, y: number, w: number, h: number): RGB {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(ctx.canvas.width, Math.ceil(x + w));
  const y1 = Math.min(ctx.canvas.height, Math.ceil(y + h));
  if (x1 - x0 < 1 || y1 - y0 < 1) return averageRegion(ctx, x, y, w, h);
  return lightestCell(ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data, x1 - x0, y1 - y0);
}

/** Coloured copies kept per logo; a sheet with several colours asks for a few. */
const TINTS_PER_LOGO = 8;
const tintCache = new WeakMap<object, Map<string, CanvasLike>>();

const clearCache = new WeakMap<object, boolean>();

/**
 * Whether a logo has a see-through background (a tenth of it or more),
 * looked at once in a small copy. Only such a logo can take one colour and
 * keep its shape: a JPG or a PNG on a white or coloured ground would become a
 * plain block of colour, so it stays in its own colours.
 */
export function hasClearBackground(img: DrawableImage): boolean {
  const known = clearCache.get(img);
  if (known !== undefined) return known;
  const w = 'naturalWidth' in img ? img.naturalWidth : img.width;
  const h = 'naturalHeight' in img ? img.naturalHeight : img.height;
  const s = Math.min(1, 64 / Math.max(w, h, 1));
  const cw = Math.max(1, Math.round(w * s));
  const ch = Math.max(1, Math.round(h * s));
  let clear = false;
  try {
    const c = createCanvas(cw, ch);
    const x = get2d(c);
    x.drawImage(img, 0, 0, cw, ch);
    const data = x.getImageData(0, 0, cw, ch).data;
    let see = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 200) see++;
    clear = see >= (cw * ch) / 10;
  } catch {
    clear = false;
  }
  clearCache.set(img, clear);
  return clear;
}

/** The logo in one colour, keeping its shape (transparent PNG or SVG). */
export function tinted(img: DrawableImage, color: RGB): DrawableImage {
  const key = toCss(color);
  let byColor = tintCache.get(img);
  if (!byColor) tintCache.set(img, (byColor = new Map()));
  const hit = byColor.get(key);
  if (hit) {
    // Most recently used last, so the copy unused for longest goes first.
    byColor.delete(key);
    byColor.set(key, hit);
    return hit;
  }
  const w = 'naturalWidth' in img ? img.naturalWidth : img.width;
  const h = 'naturalHeight' in img ? img.naturalHeight : img.height;
  const c = createCanvas(w, h);
  const x = get2d(c);
  x.drawImage(img, 0, 0, w, h);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = key;
  x.fillRect(0, 0, w, h);
  if (byColor.size >= TINTS_PER_LOGO) byColor.delete(byColor.keys().next().value!);
  byColor.set(key, c);
  return c;
}

/** The wordmark stands straight, like the TonUINO lettering (0.3 tried a tilt; the owner disliked it). */
const WORDMARK_TILT = 0;

/**
 * The wordmark ("TonUINO" or the family's own word) in the sticker's title
 * font, as large as its slot allows.
 */
function drawWordmark(ctx: Context2D, word: string, l: Slot, measure: Measure, ink: RGB, outline: RGB | undefined, X: (mm: number) => number, Y: (mm: number) => number, k: number, font: StickerFont) {
  const sin = Math.sin(WORDMARK_TILT);
  const cos = Math.cos(WORDMARK_TILT);
  // Height of the tilted word: letters (cap height 0.72, a little below the line) and the lean over its width.
  const extent = (size: number) => {
    const w = measure(word, size);
    const x0 = l.align === 'right' ? -w : l.align === 'center' ? -w / 2 : 0;
    const ys = [x0, x0 + w].flatMap((x) => [-0.74 * size, 0.1 * size].map((y) => x * sin + y * cos));
    return { min: Math.min(...ys), max: Math.max(...ys), w };
  };
  // Never louder than the number beside it: at most about half the row's height.
  let size = fitLine(word, measure, l.width * 0.98, Math.min(l.height * 0.62, 5.6), 1.6);
  for (let i = 0; i < 6; i++) {
    const e = extent(size);
    if (e.max - e.min <= l.height || size <= 1.6) break;
    size = Math.max(1.6, size * (l.height / (e.max - e.min)));
  }
  const e = extent(size);
  const ax = l.align === 'right' ? l.x + l.width : l.align === 'center' ? l.x + l.width / 2 : l.x;
  const ay = l.valign === 'top' ? l.y - e.min : l.valign === 'middle' ? l.y + l.height / 2 - (e.min + e.max) / 2 : l.y + l.height - e.max;
  ctx.save();
  ctx.translate(X(ax), Y(ay));
  ctx.rotate(WORDMARK_TILT);
  ctx.font = wordmarkFont(size * k, font);
  ctx.textAlign = l.align === 'center' ? 'center' : l.align === 'right' ? 'right' : 'left';
  ctx.textBaseline = 'alphabetic';
  if (outline) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = size * 0.2 * k;
    ctx.strokeStyle = toCss(outline);
    ctx.strokeText(word, 0, 0);
  }
  ctx.fillStyle = toCss(ink);
  ctx.fillText(word, 0, 0);
  ctx.restore();
}

/** True when a picture placed at `d` leaves part of its box `box` uncovered. */
function leavesRoom(d: Box, box: Box): boolean {
  const e = 0.01;
  return d.x > box.x + e || d.y > box.y + e || d.x + d.width < box.x + box.width - e || d.y + d.height < box.y + box.height - e;
}

/**
 * The room beside a picture shown whole. Only a truly flat edge (night sky,
 * black, plain paper) runs on there, in its own colour; anything else
 * (clouds, a fence, grass, a gradient) is never stretched or smeared out:
 * that room gets the sticker's flat colour instead, so the whole cover
 * stands next to a plain colour panel (the safe form of the cover recipes,
 * src/core/covers). `src` is the part of the image drawn at `d` (mm); `box`
 * the area to fill around it; `panel` the colour for edges that are not flat.
 */
/**
 * A square cover on a portrait Vollbild of a folder: the area above the band
 * is built like the shelf's cards (src/core/covers), with the folder's
 * recipe: the printed frame comes off, a flat edge runs on and real parts
 * move into the room where the check allows it, else the whole cover stands
 * next to a flat panel in its colour. Nothing is smeared or stretched.
 * Title and number stay the sticker's (on the band). False when there is no
 * recipe to build with: the plain edge fill then.
 */
function recipeArea(ctx: Context2D, img: DrawableImage, item: StickerItem, l: StickerLayout, g: StickerGeometry, k: number, font: StickerFont, band: RGB): boolean {
  const r = item.recipe;
  if (!r) return false;
  const B = g.bleedMm;
  const area = { w: g.widthMm + 2 * B, h: l.picture.y + l.picture.height + B };
  try {
    const layout = { ...resolveLayout(r.recipe, 'hoch', r.episode), titel: false, nummer: 'keine' as const };
    const seed = 1 + (item.folder ?? 0);
    const analysis = analyseImage(img);
    const plan = planCard({
      analysis,
      layout,
      format: 'hoch',
      geometry: { widthMm: area.w, heightMm: area.h, cutMm: B + g.safeMm },
      text: { title: item.title },
      sourceSize: imageSize(img),
      seed,
    });
    // A panel in a colour of its own (no flat edge running on, no colour set by the recipe, no printed
    // frame found for "rahmen") takes the band's colour: one plain area under the cover, not two colours.
    const ownColour = !layout.farbe || layout.farbe === 'auto' || (layout.farbe === 'rahmen' && !analysis.frame);
    if (plan.form === 'farbfeld' && !plan.seams.length && ownColour) plan.ground = band;
    const c = paintCard(plan, img, { pxPerMm: k, faces: () => ({ title: font.title, text: font.text }), seed });
    // X(-B) and Y(-B) are 0: the area starts in the bleed.
    ctx.drawImage(c as CanvasImageSource, 0, 0, area.w * k, area.h * k);
    return true;
  } catch {
    return false;
  }
}

function edgeFill(ctx: Context2D, img: DrawableImage, src: RectPx, d: Box, box: Box, X: (mm: number) => number, Y: (mm: number) => number, k: number, panel: RGB) {
  // How deep into the picture the edge is measured, as a share of it (as for the cover recipes).
  const depth = EDGE_STRIP;
  const fill = (sx: number, sy: number, sw: number, sh: number, to: Box, along: boolean) => {
    // Enough pixels to see stars, letters or a fence in the strip; no blur.
    const c = createCanvas(along ? 160 : 8, along ? 8 : 160);
    const g = get2d(c, { willReadFrequently: true });
    g.drawImage(img as CanvasImageSource, sx, sy, Math.max(1, sw), Math.max(1, sh), 0, 0, c.width, c.height);
    const edge = flatness(g.getImageData(0, 0, c.width, c.height), undefined, along);
    ctx.fillStyle = toCss(edge.flat ? edge.color : panel);
    ctx.fillRect(X(to.x), Y(to.y), to.width * k, to.height * k);
  };
  const dh = Math.max(1, src.height * depth);
  const dw = Math.max(1, src.width * depth);
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  // A hair under the picture, so no seam shows.
  const o = 0.05;
  if (d.y - box.y > 0.01) fill(src.x, src.y, src.width, dh, { x: box.x, y: box.y, width: box.width, height: d.y - box.y + o }, true);
  if (bottom - d.y - d.height > 0.01) fill(src.x, src.y + src.height - dh, src.width, dh, { x: box.x, y: d.y + d.height - o, width: box.width, height: bottom - d.y - d.height + o }, true);
  if (d.x - box.x > 0.01) fill(src.x, src.y, dw, src.height, { x: box.x, y: d.y, width: d.x - box.x + o, height: d.height }, false);
  if (right - d.x - d.width > 0.01) fill(src.x + src.width - dw, src.y, dw, src.height, { x: d.x + d.width - o, y: d.y, width: right - d.x - d.width + o, height: d.height }, false);
}

/** A cover edge counts as calm when this share of it is about its main colour (a logo in one corner is fine). */
const EDGE_CALM = 0.6;

/** The main colour of the cover's right edge, and how much of the edge is about that colour. */
function coverSide(img: DrawableImage, src: RectPx, bottom: boolean) {
  const probe = createCanvas(8, 160);
  const pg = get2d(probe, { willReadFrequently: true });
  if (bottom) {
    // The bottom strip turned a quarter, so it is read like the right one.
    const sh = Math.max(1, src.height * EDGE_STRIP);
    pg.translate(8, 0);
    pg.rotate(Math.PI / 2);
    pg.drawImage(img as CanvasImageSource, src.x, src.y + src.height - sh, src.width, sh, 0, 0, 160, 8);
    pg.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    const sw = Math.max(1, src.width * EDGE_STRIP);
    pg.drawImage(img as CanvasImageSource, src.x + src.width - sw, src.y, sw, src.height, 0, 0, 8, 160);
  }
  const px = pg.getImageData(0, 0, 8, 160);
  const edge = flatness(px, undefined, false);
  // Its colour from the middle of the edge, not from the corners (a cool sky, not a warm corner).
  const color = flatness(px, { x: 0, y: 32, w: 8, h: 96 }, false).color;
  let near = 0;
  for (let i = 0; i < px.data.length; i += 4) {
    const d = Math.hypot(px.data[i] - edge.color.r, px.data[i + 1] - edge.color.g, px.data[i + 2] - edge.color.b);
    if (d <= 40) near++;
  }
  return { color, share: near / (px.data.length / 4) };
}

/**
 * The paper flap next to the cover of "Kassette" (Frank, 17.10.2026, TODO #88): one flat colour, like the
 * inlay of a real Hörspiel cassette ("immer einfarbig mit perfekt gewählten Farben"); which one, see
 * cassetteColors. Blurred, mirrored, stretched or repeated cover content beside it failed with Frank and
 * in two audits at print size; research: recherche/kassette-klappe-loesungen.md, kartenseite-forum-2.md.
 * `seam`: the line at the cover (width in mm); a calm coloured edge runs on without one.
 */
function drawFlap(field: RGB, seam: { width: number; color: RGB } | undefined, ctx: Context2D, edgeX: number, width: number, height: number, k: number) {
  const x0 = Math.floor(edgeX - 0.5);
  const w = width - x0;
  if (w <= 1) return;
  ctx.fillStyle = toCss(field);
  ctx.fillRect(x0, 0, w, height);
  if (seam) {
    ctx.fillStyle = toCss(seam.color);
    ctx.fillRect(x0, 0, Math.max(1, seam.width * k), height);
  }
}

/** The same field under the cover of an upright cassette sticker (Frank 17.10.2026: „warum so anders“), seam on top. */
function drawFoot(field: RGB, seam: { width: number; color: RGB } | undefined, ctx: Context2D, edgeY: number, width: number, height: number, k: number) {
  const y0 = Math.floor(edgeY - 0.5);
  const h = height - y0;
  if (h <= 1) return;
  ctx.fillStyle = toCss(field);
  ctx.fillRect(0, y0, width, h);
  if (seam) {
    ctx.fillStyle = toCss(seam.color);
    ctx.fillRect(0, y0, width, Math.max(1, seam.width * k));
  }
}

/** True when white text would be the better choice on this colour (for previews of colour swatches). */
export function prefersLightText(c: RGB): boolean {
  return contrast(WHITE, c) >= contrast(BLACK, c);
}

/** Line height of the series in the head band. */
const HEAD_LINE_HEIGHT = 1.15;
/** The size the series is written in, mm: capitals 2.2 mm high. */
const HEAD_SIZE = 3.15;

/**
 * The series in the head band of a portrait cassette sticker: one line if it
 * fits, else "Bibi & Tina · 5", then a breath smaller, and only then the name cut
 * short. The number of the episode always stays: it is what tells two
 * stickers of a series apart (with a title shown it stands on the flap, see tapeText).
 */
export function headLines(series: string, measure: Measure, head: Pick<Box, 'width' | 'height'>): { size: number; lines: string[] } {
  // One size on every sticker of a sheet: a long series is shortened, not shrunk (final audit 17.10.2026).
  const maxSize = Math.min(head.height * 0.5, HEAD_SIZE);
  // A little room: text does not shrink exactly in step with its size, and must not be cut off for a hair.
  const one = (text: string, size = maxSize) => (measure(text, size) <= head.width * 0.97 ? { size, lines: [text] } : undefined);
  const m = series.match(/^(.*?),\s*Folge\s+(\d+)$/);
  const short = m ? `${m[1]} · ${m[2]}` : undefined;
  // Only a breath smaller for a long name, then cut short: never a second, smaller line.
  const small = maxSize * 0.9;
  const fitted = one(series) ?? (short ? one(short) : undefined) ?? one(series, small) ?? (short ? one(short, small) : undefined);
  if (fitted) return fitted;
  if (!m) return { size: small, lines: [ellipsize(series, small, head.width, measure)] };
  const tail = ` · ${m[2]}`;
  return { size: small, lines: [ellipsize(m[1], small, head.width - measure(tail, small), measure) + tail] };
}

/** The flap's line of "Kassette" is written at least this large, mm (audit 20.10.2026: 2.1 mm read too faint). */
const ASIDE_MIN_MM = 2.4;

/**
 * The back side in the colours of the front of "Kassette" (Frank, 17.10.2026: „ähnliche Farben wie vorn“;
 * audit 20.10.2026): the flap's colour as paper, a dark one as a light tint of the spine (a dark back read
 * worse and costs ink), the number on a plate in the spine's colour, the writing in the flap's colour.
 */
export function backInk(item: StickerItem, picture: PreparedPicture): BackInk {
  const { width, height } = imageSize(picture.image);
  const edge = picture.generated ? undefined : coverSide(picture.image, { x: 0, y: 0, width, height }, false);
  const calm = edge && edge.share >= EDGE_CALM ? paperOf(edge.color) : undefined;
  const own = !!item.color || !!item.work?.band;
  const work = item.color ? undefined : item.work;
  const t = picture.generated ? tapeColors(picture.base, work) : cassetteColors({ palette: picture.palette, calm, own: own ? picture.base : undefined, work });
  const light = luminance(t.field) > 0.6;
  // A dark front: a light tint of the spine on the warm paper of inlays, not a cold grey (final audit 20.10.2026).
  const paper = light ? t.field : mix(t.band, PAPER, 0.86);
  const text = ensureContrast(light ? t.onPaper : mix(t.band, BLACK, 0.35), paper, 7);
  // The track numbers stay readable on a yellow back too.
  const soft = ensureContrast(mix(text, paper, 0.35), paper, 4.5);
  return { paper: toCss(paper), plate: toCss(t.band), digits: toCss(t.onBand), text: toCss(text), soft: toCss(soft), rule: toCss(mix(t.band, paper, 0.6)) };
}
