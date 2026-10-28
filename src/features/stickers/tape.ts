/**
 * The style "Kassette": a sticker built like the inlay of a children's
 * cassette. A band in the work's colour carries the series and the number
 * (the head of a portrait sticker, the spine of a landscape one), thin white
 * lines part it from the original cover, and the title sits in a field of the
 * band's colour or on a paper flap. The number sits on a light rounded plate
 * as on Vollbild, in the colours of the work (src/core/stickers/works.ts) or,
 * for a work the app does not know, in colours taken from the cover. Only
 * drawing code; the places come from the layout (TapeParts).
 */
import type { Box, TapeParts } from '../../core/stickers/layout';
import { BLACK, bestTextColor, colorDistance, colourfulness, contrast, coverAccents, coverColor, ensureContrast, fromHex, luminance, mix, rgbToOklab, toCss, WHITE, type Palette, type RGB } from '../../core/stickers/color';
import type { WorkColors } from '../../core/stickers/works';
import type { Context2D } from '../../core/stickers/image';

/** "Folge 50", episode of a series written as "Bibi & Tina, Folge 50" (folderSeries). */
export function splitEpisode(series: string): { name: string; episode?: string } {
  const m = series.match(/^(.*?),\s*Folge\s+(\d+)$/);
  return m ? { name: m[1], episode: m[2] } : { name: series };
}

/** A running time as on a cassette: "52 Min.", from 100 minutes on in hours ("2,5 Std."). */
export function runningTime(sec: number): string {
  const min = Math.max(1, Math.round(sec / 60));
  if (min < 100) return `${min} Min.`;
  const h = Math.round((min / 60) * 2) / 2;
  return `${String(h).replace('.', ',')} Std.`;
}

/**
 * The flap's small line under the title: the episode (when the spine does
 * not say it), else the number of songs (not for a story, whose tracks are
 * parts), and the running time. Empty when nothing is known.
 */
export function flapParts(o: { series?: string; length?: { tracks: number; durationSec?: number; story: boolean } }, withEpisode: boolean): string[] {
  const episode = withEpisode && o.series ? splitEpisode(o.series).episode : undefined;
  const l = o.length;
  // Beside an episode the songs are not counted: "Folge 8 · 46 Min." fits the flap in one line.
  const songs = l && !l.story && !episode && l.tracks > 1 ? `${l.tracks} Titel` : undefined;
  return [episode && `Folge ${episode}`, songs, l?.durationSec ? runningTime(l.durationSec) : undefined].filter((x): x is string => !!x);
}

/** The parts in one line; a part never breaks ("16 Titel"), a line break comes after a dot (tokenize). */
export function flapLine(o: Parameters<typeof flapParts>[0], withEpisode: boolean): string | undefined {
  const parts = flapParts(o, withEpisode).map((p) => p.replace(/ /g, '\u00a0'));
  return parts.length ? parts.join(' · ') : undefined;
}

const SEPARATOR_END = /[-–—:,|/·]$/u;
const SEPARATOR_START = /^\s*[-–—:,|/·]+\s*/u;
/** "Folge 61", "Nr. 3", "Teil 2", or a bare number followed by a separator ("12 - "). */
const EPISODE_START = /^\s*(?:(?:Folge|Nr\.?|Teil)\s*\d+\b|\d+\s*(?=[-–—:,|/·]))\s*/iu;

/** Folds a name for comparing: lower case, "&" as "und", "ß" as "ss", no punctuation, single spaces. */
function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' und ')
    .replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}?!]+/gu, ' ')
    .trim();
}

/**
 * The title for the flap of "Kassette" without the series it starts with, when the spine says that
 * series already (TODO #117, #127: „Bibi und Tina, Folge 61 Bibi und Tina retten die Biber“, „Benjamin
 * Blümchen - Geburtstag im Zoo - …“ from file names). Also takes off "Folge 61" right after the name.
 * The title stays as it is when nothing would be left of it, or when the name is part of the episode's
 * own title with no separator after it ("Bibi und Tina retten die Biber" keeps its "Bibi und Tina").
 */
export function withoutSeries(title: string, names: readonly (string | undefined)[]): string {
  const t = title.trim();
  for (const raw of names) {
    const name = raw?.trim();
    if (!name) continue;
    const want = fold(name);
    if (!want) continue;
    // Find the shortest beginning of the title that reads as the name (any spelling of "&", case, punctuation).
    const words = t.split(/\s+/);
    for (let n = 1; n <= words.length; n++) {
      const head = words.slice(0, n).join(' ');
      const folded = fold(head);
      if (folded.length > want.length) break;
      if (folded !== want) continue;
      let rest = t.slice(head.length);
      // The name must end at a separator ("-", ":", ",", "|", "–") or before "Folge 12"; else it is part of the title.
      const ends = SEPARATOR_END.test(head) || SEPARATOR_START.test(rest) || EPISODE_START.test(rest);
      if (!ends) break;
      rest = rest.replace(SEPARATOR_START, '').replace(EPISODE_START, '').replace(SEPARATOR_START, '').trim();
      if (rest.length >= 3) return rest;
      break;
    }
  }
  return t;
}

/** Warm off-white of inlay paper. */
export const PAPER: RGB = fromHex('#fbf6ea');

/** Title and logo on the field beside the cover: clearly above 4.5:1, for small type on matt paper. */
const TITLE_CONTRAST = 5.5;

/** Digits on the plate stay at least this readable (WCAG, as large text). */
const PLATE_DIGITS_CONTRAST = 3;

export interface TapeColors {
  band: RGB;
  /** Text and logo on the band and the title field. */
  onBand: RGB;
  /** Title and wordmark on the paper flap. */
  onPaper: RGB;
  /** The number plate and its digits. */
  plate: RGB;
  digits: RGB;
  /** The flap beside the cover, and the room above and below a cover shown whole. */
  field: RGB;
}

/**
 * The colours of a cassette sticker. `base` is the band's colour (the one
 * chosen for the sticker, the work's, or the cover's); `work` gives the
 * plate and its digits of a known work, else they follow the band.
 */
export function tapeColors(base: RGB, work?: Pick<WorkColors, 'plate' | 'digits'>): TapeColors {
  // A nearly white colour would vanish next to the white lines: the band keeps some strength. A light
  // colour (a yellow ground) stays as it is: it is the cover's own.
  let band = luminance(base) > 0.85 ? mix(base, BLACK, 0.15) : base;
  // White writing a little short of 4.5:1 (an orange): the band a touch darker, rather than dark writing.
  for (let i = 0; i < 6 && contrast(WHITE, band) >= 2.8 && contrast(WHITE, band) < 4.5; i++) band = mix(band, BLACK, 0.04);
  const own = work ? safeHex(work.plate) : undefined;
  // Cool white with a breath of the band: a warm white turned greenish grey beside a blue (audit 17.10.2026).
  const plate = own ?? mix(WHITE, band, 0.06);
  const digits = ensureContrast((own && safeHex(work!.digits)) || band, plate, own ? PLATE_DIGITS_CONTRAST : 4.5);
  return { band, onBand: bestTextColor(band), onPaper: ensureContrast(mix(band, BLACK, 0.25), PAPER, 6), plate, digits, field: band };
}

/**
 * The colours of a cassette sticker around a real cover (Frank, 17.10.2026: „Könnte man dieses leichte Pink
 * nicht rechts weiterlaufen lassen?“; final audit the same day), like the artwork colours of music apps: a
 * ground and an accent from the cover, at most those two, one writing colour and white.
 * - Field: a calm cover edge runs on in its colour (`calm`, already made paper-like); else a light tint of
 *   the accent (a fifth of it in white), and on a dark cover the dark accent itself.
 * - Spine: the accent; next to a field of nearly the same colour (a yellow ground) the cover's next accent,
 *   e.g. the pink of its title, so the spine still reads as a spine.
 * - Title and logo on the field: the spine's colour, darkened until it reads at 2 mm on matt labels from a
 *   home printer (5.5:1, a margin over 4.5:1); on a dark field the
 *   cover's lightest colour or white.
 * `own`: a colour chosen for the sticker or a known work's band, which keeps the spine.
 */
export function cassetteColors(o: { palette: Palette; calm?: RGB; own?: RGB; work?: Pick<WorkColors, 'plate' | 'digits'> }): TapeColors {
  const main = o.own ?? coverColor(o.palette);
  const darkCover = luminance(o.palette.dominant) < 0.1 || luminance(main) < 0.05;
  const field = o.calm ?? (darkCover ? main : mix(main, WHITE, 0.8));
  let spine = main;
  // Beside a coloured ground the spine takes the cover's strongest other colour, not a soft one (skin).
  const loud = o.calm && colourfulness(o.calm) >= 0.06 && colourfulness(spine) < 0.13;
  if (!o.own && o.calm && luminance(field) >= 0.1 && (loud || colorDistance(spine, field) < 0.2)) {
    const other = coverAccents(o.palette).find((c) => colorDistance(c, field) >= 0.2 && (!loud || colourfulness(c) >= 0.13));
    spine = other ?? (colorDistance(spine, field) < 0.2 ? mix(field, BLACK, 0.4) : spine);
  }
  const t = tapeColors(spine, o.work);
  const light = o.palette.light;
  const onPaper =
    contrast(WHITE, field) >= contrast(BLACK, field) ? (contrast(light, field) >= TITLE_CONTRAST ? { ...light } : { ...WHITE }) : ensureContrast(t.band, field, TITLE_CONTRAST);
  return { ...t, onPaper, field };
}

/** The work's band suits the cover when this much of the cover is in a colour of about the band's hue… */
const BAND_SHARE = 0.1;
/** …within this angle of hue (Oklab), counting only colours with at least BAND_CHROMA of colour in them. */
const BAND_HUE_DEG = 40;
const BAND_CHROMA = 0.05;
/** A grey or black band: colours this close (Oklab distance) count. */
const BAND_NEAR = 0.15;
/** …or when the colour the cover would choose itself is this close to the band (Oklab distance). */
const BAND_LIKE_COVER = 0.12;

/**
 * Whether a known work's fixed band colour suits this episode's cover (Frank, 24.10.2026, TODO #117:
 * „Das Pinke passt bei Bibi und Tina gar nicht immer“): a tenth of the cover or more is in about the
 * band's hue (the reds and pinks of an autumn Bibi & Tina cover beside its pink; not its small pink logo
 * on a green meadow), or the cover rule would pick about that colour anyway. Else the cover decides,
 * as for a work nobody knows.
 */
export function bandFitsCover(band: RGB, palette: Palette, coverSpine: RGB): boolean {
  if (colorDistance(band, coverSpine) < BAND_LIKE_COVER) return true;
  const b = rgbToOklab(band);
  const hue = (o: { a: number; b: number }) => (Math.atan2(o.b, o.a) * 180) / Math.PI;
  // A band of hardly any colour (the black of a detective series) suits a cover with that much of about its colour.
  const grey = Math.hypot(b.a, b.b) < BAND_CHROMA;
  const share = palette.swatches.reduce((sum, s) => {
    if (grey) return colorDistance(s.color, band) < BAND_NEAR ? sum + s.population : sum;
    const o = rgbToOklab(s.color);
    if (Math.hypot(o.a, o.b) < BAND_CHROMA) return sum;
    const d = Math.abs(((hue(o) - hue(b) + 540) % 360) - 180);
    return d <= BAND_HUE_DEG ? sum + s.population : sum;
  }, 0);
  return share >= BAND_SHARE;
}

function safeHex(hex: string): RGB | undefined {
  return /^#[0-9a-f]{6}$/i.test(hex) ? fromHex(hex) : undefined;
}

type Mm = (mm: number) => number;

/** Band, title field and the white lines between them and the cover. */
export function drawTapeParts(ctx: Context2D, t: TapeParts, c: TapeColors, X: Mm, Y: Mm, k: number) {
  const fill = (b: Box, color: RGB) => {
    ctx.fillStyle = toCss(color);
    // Overlap by a hair, so no paper line shows between neighbours.
    ctx.fillRect(X(b.x), Y(b.y), b.width * k + 0.5, b.height * k + 0.5);
  };
  fill(t.band, c.band);
  // Upright, the foot is the field under the cover, as the flap is beside it.
  if (t.foot) fill(t.foot, c.field);
}

/** The white lines, drawn over the cover's edge so they stay crisp. */
export function drawTapeLines(ctx: Context2D, t: TapeParts, X: Mm, Y: Mm, k: number) {
  ctx.fillStyle = toCss(WHITE);
  for (const l of t.lines) ctx.fillRect(X(l.x), Y(l.y), l.width * k, l.height * k);
}

/**
 * The number plate, in pixels: rounded at both ends like the number of
 * Vollbild, with the same soft shadow. A plate close to the band's colour
 * gets a thin darker edge, so it does not melt into the band.
 */
export function drawNumberPlate(ctx: Context2D, x: number, y: number, w: number, h: number, color: RGB, k: number, band?: RGB) {
  const r = Math.min(h / 2, w / 2);
  const shape = () => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };
  ctx.save();
  ctx.shadowColor = 'rgb(0 0 0 / 0.25)';
  ctx.shadowBlur = 0.8 * k;
  shape();
  ctx.fillStyle = toCss(color);
  ctx.fill();
  ctx.restore();
  if (band && contrast(color, band) < 1.6) {
    shape();
    ctx.lineWidth = Math.max(1, 0.18 * k);
    ctx.strokeStyle = toCss(mix(color, BLACK, 0.35));
    ctx.stroke();
  }
}
