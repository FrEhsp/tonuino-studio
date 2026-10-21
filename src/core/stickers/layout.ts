/**
 * Where things go on a sticker: picture, title, number and logo, for each
 * style, in landscape, portrait and for round or square labels.
 *
 * Pure geometry in millimetres relative to the trim box (0, 0 is the top-left
 * corner of the label, y down). Backgrounds and full-bleed pictures reach into
 * the bleed; text, number and logo stay inside the safe margin.
 */

/** The styles laid out here; "Bildkarte" ('bild') draws itself (features/stickers/bildkarte.ts). */
export type LayoutStyle = 'blur' | 'full' | 'tape';
export type StickerStyle = LayoutStyle | 'bild';

/**
 * The styles in the order the page offers them: "Kassette" right after
 * "Klassisch" (Frank's favourite, 14.10.2026). "Hell" ("light") went in 0.4:
 * with colours that suit each work there was nothing left to save. "Farbig"
 * ("color") went in 0.5 for "Bildkarte" (style audit 20.10.2026, TODO #91):
 * blind it was hardly told from "Kassette", and Bildkarte serves the cards
 * without a cover that no other style did.
 */
export const STICKER_STYLES: readonly StickerStyle[] = ['blur', 'tape', 'bild', 'full'];

/** The styles stickerLayout() places. */
export const LAYOUT_STYLES: readonly LayoutStyle[] = ['blur', 'tape', 'full'];

/**
 * A style read from storage. "Farbig" becomes "Kassette": the nearest style for a cover
 * (cover, colour, title and number), and the standard. The draft "Leerkassette" of the
 * audit was not taken; it becomes "Kassette" too. Any other style that is gone (such as
 * "light") becomes "Klassisch".
 */
export function knownStyle(style: unknown): StickerStyle {
  if (style === 'color' || style === 'leer') return 'tape';
  return STICKER_STYLES.includes(style as StickerStyle) ? (style as StickerStyle) : 'blur';
}

export interface StickerGeometry {
  widthMm: number;
  heightMm: number;
  bleedMm: number;
  /** Keep text this far from the edge. */
  safeMm: number;
  shape: 'rect' | 'round';
}

export interface LayoutInput {
  style: LayoutStyle;
  /** Show a title (and subtitle). */
  title: boolean;
  /** Show the folder number or a short detail such as "15 Min.". */
  badge: boolean;
  /**
   * The badge names tracks as well ("02 · 12–24", an episode of a packed
   * series, since 0.4.1): the number plate of "Kassette" grows wide enough
   * to write it as large as a number alone.
   */
  badgeWide?: boolean;
  logo: boolean;
  /** Width / height of the picture, when known: a tall picture gets a taller box where the style allows. */
  pictureAspect?: number;
  /** Vollbild: title in white on a darkened picture instead of on a colour band. */
  darken?: boolean;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type HAlign = 'left' | 'center' | 'right';
export type VAlign = 'top' | 'middle' | 'bottom';

export interface Slot extends Box {
  align: HAlign;
  valign: VAlign;
}

export type Background = 'blur' | 'picture' | 'paper';

/** What the text sits on; decides the text colour. "light": the paper flap of a cassette sticker. */
export type Surface = 'panel' | 'light' | 'blur' | 'picture';

export interface StickerLayout {
  background: Background;
  /** The picture. With background "picture" it covers the whole sticker including bleed. */
  picture: Box & { radius: number; shadow: boolean };
  /**
   * Vollbild with its band: where a cover filling the sticker is cut out
   * (all of it, as without the band); `picture` then only clips it above the
   * band. So the section and the focus stay as they were, and the logo at the
   * top of a cover is not cut off. A picture shown smaller fits into `picture`.
   */
  pictureFit?: Box;
  /** Title and subtitle; "up" writes them along the box from bottom to top (the spine of a cassette). */
  /** `maxSize`: largest font size, mm, where the default would shout (the narrow flap of "Kassette"). */
  /** `aside`: the subtitle is a small line that never makes the title smaller (the flap of "Kassette"). */
  text?: Slot & { maxLines: number; up?: boolean; maxSize?: number; aside?: boolean };
  /**
   * "big": large digits on the background; "pill": small label with its own
   * background; "plate": on the number plate of the style "Kassette"
   * (TapeParts.plate), drawn like the pill of Vollbild.
   */
  badge?: Slot & { kind: 'big' | 'pill' | 'plate' };
  logo?: Slot;
  /**
   * Vollbild: room above a picture shown whole across a portrait sticker
   * (instead of cutting a square cover to the sticker's shape): the top edge's
   * colour runs on when it is one flat colour, else a flat panel colour.
   */
  extend?: Box;
  /** Darkening gradient behind text on the picture, transparent at its top edge; the most it may cover. */
  scrim?: Box;
  /** Vollbild: a band in the sticker's colour across the foot, with the title on it (instead of the scrim), as on real audio play covers. */
  band?: Box;
  surface: Surface;
  /** Style "Kassette": the coloured parts of a cassette inlay around the cover. */
  tape?: TapeParts;
}

/**
 * The style "Kassette" (tape), built like the inlay of a children's cassette:
 * a band in the work's colour with the series and the number plate (across the
 * head of a portrait sticker, as the spine on the left of a landscape one),
 * the original cover without a border, thin white lines between them, and the
 * title in a field of the band's colour (portrait) or on a narrow paper flap
 * (landscape). How it looks is up to the renderer (tape.ts).
 */
export interface TapeParts {
  /** Head band (portrait) or spine (landscape), reaching into the bleed. */
  band: Box;
  /** Portrait: the title field under the cover, in the band's colour, reaching into the bleed. */
  foot?: Box;
  /** Thin white lines between the band, the cover and the title field. */
  lines: Box[];
  /**
   * The light rounded plate behind the number, like the number of Vollbild
   * (Frank, 14.10.2026, instead of the yellow dot). It may reach into the
   * safe margin, never closer than PLATE_EDGE to the trim; the digits stay
   * inside the safe area (the badge slot).
   */
  plate?: Box;
  /** Series or author in the band; "up" writes along the spine from bottom to top. */
  head?: Slot & { up?: boolean };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Pictures narrower than this (width / height) count as tall, like a cassette cover; they get a portrait sticker in "auto". */
const TALL_PICTURE = 0.9;

export function isCompact(g: StickerGeometry): boolean {
  const aspect = g.widthMm / g.heightMm;
  return g.shape === 'round' || (aspect > 0.87 && aspect < 1.15);
}

export function stickerLayout(g: StickerGeometry, input: LayoutInput): StickerLayout {
  if (isCompact(g)) return compactLayout(g, input);
  return g.widthMm >= g.heightMm ? landscapeLayout(g, input) : portraitLayout(g, input);
}

/** Round and square labels have room for a logo only when square and at least this wide, mm. */
const COMPACT_LOGO_MIN_MM = 35;

/** A round or square label with room for a logo. */
export function compactLogoFits(g: Pick<StickerGeometry, 'widthMm' | 'shape'>): boolean {
  return g.shape !== 'round' && g.widthMm >= COMPACT_LOGO_MIN_MM;
}

/**
 * Round and square labels: the picture fills the label, the number sits at
 * the bottom. Every style looks the same here; the page says so instead of
 * offering the styles.
 */
function compactLayout(g: StickerGeometry, input: LayoutInput): StickerLayout {
  const W = g.widthMm;
  const H = g.heightMm;
  const B = g.bleedMm;
  const S = g.safeMm;
  const round = g.shape === 'round';
  const layout: StickerLayout = {
    background: 'picture',
    picture: { x: -B, y: -B, width: W + 2 * B, height: H + 2 * B, radius: 0, shadow: false },
    surface: 'picture',
  };
  if (input.badge) {
    const h = clamp(H * 0.2, 4, 7);
    // On a circle the bottom gets narrow: keep the pill clear of the edge.
    const y = round ? H - S - h - H * 0.03 : H - S - h;
    const width = round ? W * 0.5 : W * 0.45;
    layout.badge = { x: round ? (W - width) / 2 : W - S - width, y, width, height: h, align: round ? 'center' : 'right', valign: 'bottom', kind: 'pill' };
  }
  if (input.logo && compactLogoFits(g)) {
    layout.logo = { x: S, y: S, width: W * 0.45, height: clamp(H * 0.1, 3.5, 6), align: 'left', valign: 'top' };
  }
  return layout;
}

/**
 * A text panel: title at the top, logo and number in a row at the bottom.
 * Without a title the number becomes larger and centred, but never fills
 * the panel: Frank found the big numbers far too big (13.10.2026).
 */
function panel(p: Box, input: LayoutInput, maxLines: number): Pick<StickerLayout, 'text' | 'badge' | 'logo'> {
  const kind = 'big';
  const out: Pick<StickerLayout, 'text' | 'badge' | 'logo'> = {};
  const row = input.badge || input.logo ? clamp(p.height * 0.24, 6, 10) : 0;
  const bottom = p.y + p.height;
  if (!input.title) {
    const logoRow = input.logo ? clamp(p.height * 0.16, 5, 7) : 0;
    if (input.badge) {
      const h = Math.min(p.height - logoRow - (logoRow ? 1 : 0), Math.max(row * 1.3, p.height * 0.34));
      const top = p.y + (p.height - logoRow - h) / 2;
      out.badge = { x: p.x, y: top, width: p.width, height: h, align: 'center', valign: 'middle', kind };
    }
    if (input.logo) out.logo = { x: p.x, y: bottom - logoRow, width: p.width, height: logoRow, align: 'center', valign: 'bottom' };
    return out;
  }
  const gap = row ? Math.min(2, p.height * 0.05) : 0;
  out.text = { x: p.x, y: p.y, width: p.width, height: p.height - row - gap, align: 'left', valign: 'top', maxLines };
  if (input.logo && input.badge) {
    out.logo = { x: p.x, y: bottom - row, width: p.width * 0.62, height: row, align: 'left', valign: 'bottom' };
    out.badge = { x: p.x + p.width * 0.5, y: bottom - row, width: p.width * 0.5, height: row, align: 'right', valign: 'bottom', kind };
  } else if (input.badge) {
    out.badge = { x: p.x, y: bottom - row, width: p.width, height: row, align: 'right', valign: 'bottom', kind };
  } else if (input.logo) {
    out.logo = { x: p.x, y: bottom - row, width: p.width, height: row, align: 'left', valign: 'bottom' };
  }
  return out;
}

function landscapeLayout(g: StickerGeometry, input: LayoutInput): StickerLayout {
  const W = g.widthMm;
  const H = g.heightMm;
  const S = g.safeMm;
  const side = H - 2 * S;

  switch (input.style) {
    case 'full':
      return fullLayout(g, input);
    case 'tape':
      return tapeLandscape(g, input);
    case 'blur': {
      const background = 'blur';
      const surface = 'blur';
      const centred = !input.title;
      if (centred) {
        // The classic TonUINO sticker: picture in the middle of a blurred copy of itself.
        const x = (W - side) / 2;
        const picture = { x, y: S, width: side, height: side, radius: 1.5, shadow: true };
        const strip = x - S - 1.2;
        const layout: StickerLayout = { background, picture, surface };
        const row = clamp(H * 0.18, 6, 10);
        if (strip >= 8) {
          if (input.badge) layout.badge = { x: W - S - strip, y: H - S - row, width: strip, height: row, align: 'right', valign: 'bottom', kind: 'big' };
          if (input.logo) layout.logo = { x: S, y: H - S - row, width: strip, height: row, align: 'left', valign: 'bottom' };
        } else {
          const h = clamp(H * 0.13, 5, 7);
          if (input.badge) layout.badge = { x: x + side * 0.45, y: S + side - h - 1.5, width: side * 0.55 - 1.5, height: h, align: 'right', valign: 'bottom', kind: 'pill' };
        }
        return layout;
      }
      const picture = { x: S, y: S, width: side, height: side, radius: 1.5, shadow: true };
      const gap = Math.max(S, 2.5);
      const p = { x: S + side + gap, y: S, width: W - 2 * S - side - gap, height: side };
      return { background, picture, surface, ...panel(p, input, 4) };
    }
  }
}

function portraitLayout(g: StickerGeometry, input: LayoutInput): StickerLayout {
  const W = g.widthMm;
  const H = g.heightMm;
  const S = g.safeMm;
  const side = W - 2 * S;

  switch (input.style) {
    case 'full':
      return fullLayout(g, input);
    case 'tape':
      return tapePortrait(g, input);
    case 'blur': {
      const background = 'blur';
      const surface = 'blur';
      // Picture and, right under it, the wordmark and the number in one row; together in the middle.
      const row = clamp(H * 0.17, 8, 15);
      const gap = 1.5;
      if (!input.title && (input.badge || input.logo) && H - 2 * S - side >= row + gap) {
        const y = S + (H - 2 * S - side - gap - row) / 2;
        const picture = { x: S, y, width: side, height: side, radius: 1.5, shadow: true };
        const layout: StickerLayout = { background, picture, surface };
        const rowY = y + side + gap;
        if (input.badge) layout.badge = { x: S + side * 0.35, y: rowY, width: side * 0.65, height: row, align: 'right', valign: 'bottom', kind: 'big' };
        if (input.logo) layout.logo = { x: S, y: rowY, width: side * 0.62, height: row, align: 'left', valign: 'bottom' };
        return layout;
      }
      if (!input.title) {
        const y = (H - side) / 2;
        const picture = { x: S, y, width: side, height: side, radius: 1.5, shadow: true };
        const strip = y - S - 1.2;
        const layout: StickerLayout = { background, picture, surface };
        if (input.logo && strip >= 4) layout.logo = { x: S, y: S, width: side, height: Math.min(strip, 7), align: 'left', valign: 'top' };
        if (input.badge && strip >= 6) {
          const h = Math.min(strip, 11);
          layout.badge = { x: S, y: H - S - h, width: side, height: h, align: 'right', valign: 'bottom', kind: 'big' };
        }
        return layout;
      }
      const picture = { x: S, y: S, width: side, height: side, radius: 1.5, shadow: true };
      const space = Math.max(S * 0.8, 2.5);
      const p = { x: S, y: S + side + space, width: side, height: H - 2 * S - side - space };
      return { background, picture, surface, ...panel(p, input, 3) };
    }
  }
}

/** The number plate of a cassette sticker keeps this far from the trim, mm (as the dot before it). */
export const PLATE_EDGE = 1.2;

/**
 * The digits' slot on a number plate: inside the plate less its padding
 * (rounded ends, a little air above and below), and inside the safe area.
 */
function plateBadge(plate: Box, g: StickerGeometry): Slot & { kind: 'plate' } {
  const S = g.safeMm;
  const padX = plate.height * 0.3;
  const padY = plate.height * 0.18;
  const x = Math.max(plate.x + padX, S);
  const y = Math.max(plate.y + padY, S);
  const right = Math.min(plate.x + plate.width - padX, g.widthMm - S);
  const bottom = Math.min(plate.y + plate.height - padY, g.heightMm - S);
  return { x, y, width: Math.max(0.5, right - x), height: Math.max(0.5, bottom - y), align: 'center', valign: 'middle', kind: 'plate' };
}

/**
 * Largest title on the flap of "Kassette", per mm of its width: short titles stay as large as a
 * two-word one (Frank, 17.10.2026: „Schriftgröße bei Bibi find ich gut, danach wirds riesig“).
 */
const FLAP_TITLE = 0.16;

/** Width of the thin white lines between the parts of a cassette inlay, mm. */
function inlayLine(g: StickerGeometry): number {
  return clamp(Math.min(g.widthMm, g.heightMm) * 0.012, 0.35, 0.7);
}

/** Width / height of the picture for the cassette style; unknown counts as square, very wide ones are capped. */
function inlayAspect(input: LayoutInput): number {
  const a = input.pictureAspect;
  return a && a > 0 && Number.isFinite(a) ? Math.min(a, 1.3) : 1;
}

/**
 * Landscape cassette sticker, an opened inlay: on the left the spine in the
 * work's colour with the number plate at the top and the series written from
 * bottom to top, then a thin white line and the cover over the full height,
 * on the right a narrow paper flap with the title at the top and the wordmark
 * at the bottom. On a label too small for the flap the title goes on the spine.
 */
function tapeLandscape(g: StickerGeometry, input: LayoutInput): StickerLayout {
  const W = g.widthMm;
  const H = g.heightMm;
  const B = g.bleedMm;
  const S = g.safeMm;
  const line = inlayLine(g);
  const spine = clamp(W * 0.13, 2 * S + 4, 13);
  const band = { x: -B, y: -B, width: spine + B, height: H + 2 * B };
  const left = spine + line;
  // The flap wants room for a title in two lines; a square cover gives up a few per cent of its width for it.
  const flapMin = input.title ? clamp(W * 0.3, 14, 30) : input.logo ? clamp(W * 0.2, 12, 20) : 0;
  let width = Math.min(H * inlayAspect(input), W - left - flapMin);
  // No room for a flap worth having: the cover runs to the edge, the title goes on the spine.
  const flap = (input.title || input.logo) && width >= H * 0.6;
  if (!flap || W - left - width < 6) width = W + B - left;
  const picture = { x: left, y: -B, width, height: H + 2 * B, radius: 0, shadow: false };
  const layout: StickerLayout = {
    background: 'paper',
    picture,
    surface: 'light',
    tape: { band, lines: [{ x: spine, y: -B, width: line, height: H + 2 * B }] },
  };
  const tape = layout.tape!;
  // The plate across the spine at its top; its digits inside the safe area.
  if (input.badge) {
    const narrow = spine - 2 * PLATE_EDGE;
    // Big enough for children who cannot read yet to find the number (final audit 17.10.2026).
    const height = Math.min(narrow * 0.7, 7);
    // Folder and tracks: the plate reaches from the spine onto the cover, like a label stuck across it.
    const width = input.badgeWide ? Math.max(narrow, Math.min(height * 5.2, W * 0.45)) : narrow;
    // The digits start at the safe margin, the plate a little above them.
    const y = Math.max(PLATE_EDGE, S - 0.3);
    tape.plate = { x: PLATE_EDGE, y, width, height };
    layout.badge = plateBadge(tape.plate, g);
  }
  const from = tape.plate ? tape.plate.y + tape.plate.height + 1.2 : S;
  const along = { x: S, y: from, width: Math.max(1, spine - 2 * S), height: Math.max(1, H - S - from), align: 'left' as const, valign: 'middle' as const };
  if (flap) {
    const fx = left + width + 1.6;
    const fw = Math.max(1, W - S - fx);
    const logoH = clamp(H * 0.12, 4, 6.5);
    if (input.logo && !input.title) {
      // The logo alone: larger, in the middle of the flap, like the maker's mark on a cassette inlay.
      const h = Math.min(fw * 0.5, H - 2 * S);
      layout.logo = { x: fx, y: (H - h) / 2, width: fw, height: h, align: 'center', valign: 'middle' };
    } else if (input.logo) layout.logo = { x: fx, y: H - S - logoH, width: fw, height: logoH, align: 'left', valign: 'bottom' };
    if (input.title) {
      const top = S + 0.4;
      layout.text = { x: fx, y: top, width: fw, height: Math.max(1, H - S - top - (input.logo ? logoH + 1 : 0)), align: 'left', valign: 'top', maxLines: 5, maxSize: FLAP_TITLE * fw };
    }
    tape.head = { ...along, up: true };
  } else if (input.title) {
    // The title along the spine, read from the bottom like a cassette on the shelf.
    layout.text = { ...along, maxLines: 2, up: true };
  } else {
    tape.head = { ...along, up: true };
  }
  return layout;
}

/**
 * Portrait cassette sticker, the front of a cassette: a head band in the
 * work's colour with the series on the left and the number plate on the right,
 * a thin white line, the cover without a border over the whole width, another
 * line, and a title field in the band's colour with the wordmark at its
 * bottom right. A tall cover gets more height where the title field can spare it.
 */
function tapePortrait(g: StickerGeometry, input: LayoutInput): StickerLayout {
  const W = g.widthMm;
  const H = g.heightMm;
  const B = g.bleedMm;
  const S = g.safeMm;
  const line = inlayLine(g);
  const headH = clamp(H * 0.14, 2 * S + 4, 14);
  const band = { x: -B, y: -B, width: W + 2 * B, height: headH + B };
  const top = headH + line;
  const logoH = clamp(H * 0.049, 3, 4.6);
  const footMin = input.title ? clamp(H * 0.19, S + 6, 18) : input.logo ? S + logoH + 1 : clamp(H * 0.05, 2, 5);
  const room = H - top - line - footMin;
  const height = Math.max(Math.min(W / inlayAspect(input), room), Math.min(room, 8));
  const picture = { x: -B, y: top, width: W + 2 * B, height, radius: 0, shadow: false };
  const footY = top + height + line;
  const foot = { x: -B, y: footY, width: W + 2 * B, height: H - footY + B };
  const layout: StickerLayout = {
    background: 'paper',
    picture,
    surface: 'panel',
    tape: { band, foot, lines: [{ x: -B, y: headH, width: W + 2 * B, height: line }, { x: -B, y: top + height, width: W + 2 * B, height: line }] },
  };
  const tape = layout.tape!;
  // The plate in the middle of the band, at the right, a little wider than high; its digits inside the safe area.
  if (input.badge) {
    const height = Math.min(headH - 2 * PLATE_EDGE, 7.5);
    const width = Math.min(height * (input.badgeWide ? 4.6 : 1.6), W * (input.badgeWide ? 0.62 : 0.4));
    // Flush with the wordmark below, clear of the die cut when the sheet runs a little off.
    const right = W - S;
    tape.plate = { x: right - width, y: (headH - height) / 2, width, height };
    layout.badge = plateBadge(tape.plate, g);
  }
  const headRight = tape.plate ? tape.plate.x - 1.5 : W - S;
  tape.head = { x: S, y: S, width: Math.max(1, headRight - S), height: Math.max(1, headH - 0.8 - S), align: 'left', valign: 'middle' };
  const footRoom = H - S - footY;
  const textTop = footY + clamp(footRoom * 0.08, 0.8, 1.3);
  // The wordmark only where it leaves the title a line.
  const logo = input.logo && footRoom >= logoH + (input.title ? MIN_LINE_MM + 1.5 : 0.8);
  if (logo) layout.logo = { x: S + (W - 2 * S) * 0.3, y: H - S - logoH, width: (W - 2 * S) * 0.7, height: logoH, align: 'right', valign: 'bottom' };
  if (input.title) {
    // A title in two lines keeps clear of the wordmark (final audit 17.10.2026: 1.7 mm were too close).
    layout.text = { x: S, y: textTop, width: W - 2 * S, height: Math.max(1, H - S - textTop - (logo ? logoH + 1.2 : 0)), align: 'left', valign: 'top', maxLines: 3 };
  }
  return layout;
}

/** Height a title line needs at the smallest size, mm (fitTitle: 2.6 mm × 1.1). */
const MIN_LINE_MM = 2.9;

/** A portrait sticker shows a picture wider than this, relative to its own shape, whole instead of cutting it. */
const STACK_RATIO = 1.3;

/**
 * The picture covers the whole sticker. The title sits on a band in the
 * sticker's colour across the foot, as on real audio play covers, so the
 * picture stays as bright as it is; the picture then ends at the band, so the
 * band hides nothing of it. With "darken" the title is white on a dark
 * gradient over the picture instead. A square cover on a portrait sticker
 * would lose a third of its width: it is shown whole across the sticker
 * instead, with room above it (extend): a flat top edge runs on there, any
 * other gets a flat panel colour; never stretched or smeared.
 */
function fullLayout(g: StickerGeometry, input: LayoutInput): StickerLayout {
  const W = g.widthMm;
  const H = g.heightMm;
  const B = g.bleedMm;
  const S = g.safeMm;
  const land = W >= H;
  const layout: StickerLayout = {
    background: 'picture',
    picture: { x: -B, y: -B, width: W + 2 * B, height: H + 2 * B, radius: 0, shadow: false },
    surface: 'picture',
  };
  // Narrower on small labels, so the title keeps most of the width.
  const badgeW = Math.min(land ? 16 : 14, W * 0.25);
  const badgeH = land ? 9 : 8;
  if (input.title && !input.darken) {
    // On a small label the band stays a third of it, with room for one line above the safe margin.
    const share = land ? 0.26 : input.logo ? 0.25 : 0.2;
    const height = clamp(H * share, Math.min(11, Math.max(H * 0.3, S + 3.7)), land ? 17 : 22);
    const band = { x: -B, y: H - height, width: W + 2 * B, height: height + B };
    layout.band = band;
    // A little under the band, so no gap shows between them.
    layout.pictureFit = { x: layout.picture.x, y: layout.picture.y, width: layout.picture.width, height: layout.picture.height };
    layout.picture = { ...layout.picture, height: band.y + B + 0.3 };
    const right = input.badge ? badgeW + 2 : 0;
    const top = band.y + clamp(height * 0.1, 0.6, 1.8);
    const bottom = H - S;
    if (input.badge) layout.badge = { x: W - S - badgeW, y: top, width: badgeW, height: bottom - top, align: 'right', valign: 'middle', kind: 'big' };
    let textRight = W - S - right;
    let textBottom = bottom;
    if (input.logo) {
      // The wordmark in the band: beside the title on a wide sticker, under it on a tall one.
      const markW = Math.min(W * 0.22, 19);
      const markH = clamp(height * 0.34, 3.6, 5.5);
      if (land && textRight - markW - 1.5 - S >= W * 0.45) {
        layout.logo = { x: textRight - markW, y: top, width: markW, height: bottom - top, align: 'right', valign: 'middle' };
        textRight -= markW + 1.5;
      } else if (bottom - top - markH >= MIN_LINE_MM + 0.5) {
        layout.logo = { x: S, y: bottom - markH, width: textRight - S, height: markH, align: 'left', valign: 'bottom' };
        textBottom = bottom - markH - 0.3;
      }
    }
    layout.text = { x: S, y: top, width: textRight - S, height: textBottom - top, align: 'left', valign: 'middle', maxLines: land ? 2 : 3 };
  } else if (input.title) {
    const textTop = H * (land ? 0.5 : 0.62);
    // At most from a little above the text; the renderer starts it above the lines really written.
    const top = textTop - 6;
    layout.scrim = { x: -B, y: top, width: W + 2 * B, height: H - top + B };
    const right = input.badge ? badgeW + 2 : 0;
    const markH = clamp(H * 0.08, 3.6, 5.5);
    const logo = input.logo && H - S - textTop - markH >= MIN_LINE_MM + 0.5;
    if (logo) layout.logo = { x: S, y: H - S - markH, width: W - 2 * S - right, height: markH, align: 'left', valign: 'bottom' };
    layout.text = { x: S, y: textTop, width: W - 2 * S - right, height: H - S - textTop - (logo ? markH + 0.4 : 0), align: 'left', valign: 'bottom', maxLines: 2 };
    if (input.badge) layout.badge = { x: W - S - badgeW, y: H - S - badgeH, width: badgeW, height: badgeH, align: 'right', valign: 'bottom', kind: 'big' };
  } else {
    // No title: the number at the bottom right, the wordmark level with it at the bottom left.
    const h = clamp(H * 0.15, 5.5, 8);
    const w = Math.min(24, W - 2 * S);
    if (input.badge) layout.badge = { x: W - S - w, y: H - S - h, width: w, height: h, align: 'right', valign: 'bottom', kind: 'pill' };
    if (input.logo) layout.logo = { x: S, y: H - S - h, width: Math.min(W * (land ? 0.42 : 0.55), W - 2 * S - (input.badge ? Math.min(w, W * 0.3) + 1 : 0)), height: h, align: 'left', valign: 'middle' };
  }
  // A picture much wider than a portrait sticker (a square cover) is not cut to its shape: it sits
  // whole on the band (or the foot of the sticker); above it a flat top edge runs on, else a flat panel.
  const a = input.pictureAspect;
  if (!land && a && a > 0 && a > (W / H) * STACK_RATIO) {
    const end = layout.band ? layout.band.y + 0.3 : H + B;
    const picH = Math.min(W / a + (layout.band ? 0.3 : B), end + B);
    if (end + B - picH > 0.5) {
      delete layout.pictureFit;
      layout.picture = { ...layout.picture, y: end - picH, height: picH };
      layout.extend = { x: -B, y: -B, width: W + 2 * B, height: end - picH + B };
    }
  }
  return layout;
}

/**
 * The area the picture is fitted into. Filled or zoomed in (zoom 1 and up)
 * that is its box, bleed included. Shown whole (zoom 0) it stays inside the
 * trim box: the bleed is cut off, and with it 1 to 2 mm of a picture that
 * reached into it. In between the area grows back into the bleed, so the
 * slider moves without a jump.
 */
export function pictureFrame(box: Box, g: Pick<StickerGeometry, 'widthMm' | 'heightMm'>, zoom: number): Box {
  const z = Number.isFinite(zoom) ? clamp(zoom, 0, 1) : 1;
  if (z >= 1) return box;
  const left = Math.max(box.x, 0);
  const top = Math.max(box.y, 0);
  const right = Math.min(box.x + box.width, g.widthMm);
  const bottom = Math.min(box.y + box.height, g.heightMm);
  if (right <= left || bottom <= top) return box;
  const towards = (inside: number, outside: number) => inside + (outside - inside) * z;
  const x = towards(left, box.x);
  const y = towards(top, box.y);
  return { x, y, width: towards(right, box.x + box.width) - x, height: towards(bottom, box.y + box.height) - y };
}

/**
 * The box a picture is placed into (section, focus, zoom): pictureFit for a
 * cover that fills the sticker, else the picture's own box, both as
 * pictureFrame keeps a picture shown whole out of the bleed. Render, print
 * resolution and the edit dialog all use this.
 */
export function placementBox(layout: Pick<StickerLayout, 'picture' | 'pictureFit'>, g: Pick<StickerGeometry, 'widthMm' | 'heightMm'>, zoom: number): Box {
  const z = Number.isFinite(zoom) ? zoom : 1;
  return pictureFrame(layout.pictureFit && z >= 1 ? layout.pictureFit : layout.picture, g, zoom);
}

export type Orientation = 'landscape' | 'portrait';

/**
 * The orientation of one sticker: its own setting, else the design's. "auto"
 * follows the picture, so a portrait drawing gets a portrait sticker and a
 * square cover the usual landscape one.
 */
export function stickerOrientation(own: Orientation | undefined, design: Orientation | 'auto', pictureAspect: number): Orientation {
  const o = own ?? design;
  if (o !== 'auto') return o;
  return pictureAspect > 0 && pictureAspect < TALL_PICTURE ? 'portrait' : 'landscape';
}

/** Turns label geometry into the artwork geometry for an orientation (portrait swaps width and height). */
export function orientGeometry(g: StickerGeometry, orientation: Orientation): StickerGeometry {
  if (isCompact(g)) return g;
  const land = g.widthMm >= g.heightMm;
  if ((orientation === 'landscape') === land) return g;
  return { ...g, widthMm: g.heightMm, heightMm: g.widthMm };
}

/** All boxes of a layout that must stay inside the safe area (for tests and debugging). */
export function contentBoxes(l: StickerLayout): Box[] {
  return [l.text, l.badge, l.logo].filter((b): b is NonNullable<typeof b> => !!b);
}
