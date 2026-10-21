/**
 * The back of a sticker (extra "Sticker-Rückseite"): what its card plays,
 * as a list of numbered titles or as a QR code of that list, on white like a
 * cassette's inlay. Drawn in millimetres at any resolution, like the front
 * (render.ts); where the backs go on the sheet is in core/stickers/backside.ts.
 */
import { computed } from '@preact/signals';
import { backListLayout, fitTrackTitle, moreLine, trackListText, wrappedBackList, type BackMode, type BackTrack } from '../../core/stickers/backside';
import { createCanvas, get2d, type CanvasLike, type Context2D } from '../../core/stickers/image';
import type { StickerGeometry } from '../../core/stickers/layout';
import { ellipsize, fitLine, fitText, tokenize, wrap, type Measure } from '../../core/stickers/text';
import { trackRows } from '../../core/tonuino/catalog';
import { MODIFIER_HOWTO, modeByCode, specialSummary } from '../../core/tonuino/modes';
import { folderName } from '../../core/tonuino/sd';
import { boxScan, catalog, profile, settings } from '../../app/state';
import { cardItems } from '../cards/items';
import type { StickerItem } from './content';
import { design, printSetup, template } from './design';
import { pictogramKnown } from './pictograms';
import { PICTOGRAM_CREDIT } from '../../core/stickers/arasaac';
import { isCompact } from '../../core/stickers/layout';
import { fontCss, type StickerFont } from './fonts';

/** What goes on the back of each sticker now: only with the extra switched on, and only for paper printed at home. */
export const backMode = computed<BackMode>(() => (settings.value.stickerBacks && template.value.output === 'pdf' ? (printSetup.value.back ?? 'none') : 'none'));

/** Everything one back side shows. */
export interface BackContent {
  /** Folder number, "05". */
  number?: string;
  heading: string;
  /** A second line, e.g. the folder an episode is part of. */
  subheading?: string;
  /** The tracks the card plays, in order. */
  tracks?: BackTrack[];
  /** For a card without tracks: what it does. */
  text?: string;
  /** The source of a pictogram on the front (Bildkarte with an ARASAAC pictogram), in a fine line at the foot. */
  credit?: string;
}

/**
 * The back of a sticker of the cards list: the titles its card plays (the
 * whole folder, or "von … bis …", or one track), or for a special card what
 * it does. Stickers from own pictures have no card, so their back stays white.
 */
export function backContentFor(item: StickerItem): BackContent | undefined {
  const content = backContentOf(item);
  return content && showsPictogram(item) ? { ...content, credit: PICTOGRAM_CREDIT } : content;
}

/** The front shows an ARASAAC pictogram: style "Bildkarte" on a label that is not round or square, the card without a picture. */
function showsPictogram(item: StickerItem): boolean {
  if (!item.pictogram || item.picture || design.value.style !== 'bild') return false;
  const l = template.value.label;
  return !isCompact({ widthMm: l.widthMm, heightMm: l.heightMm, bleedMm: 0, safeMm: 0, shape: l.shape }) && pictogramKnown(item.pictogram) !== false;
}

function backContentOf(item: StickerItem): BackContent | undefined {
  if (item.loose) return undefined;
  const c = cardItems.value.find((x) => x.key === item.key);
  if (!c) return undefined;
  const d = c.data;
  if (d.folder >= 1 && d.folder <= 99) {
    const name = folderName(d.folder);
    const f = boxScan.value?.folders.find((x) => x.number === d.folder);
    const rows = f ? trackRows(f, catalog.value?.folders[name]) : [];
    const params = modeByCode(d.mode)?.params;
    const shown = params === 'range' ? rows.filter((r) => r.number >= d.special && r.number <= d.special2) : params === 'track' ? rows.filter((r) => r.number === d.special) : rows;
    return {
      number: name,
      heading: item.title,
      subheading: item.subtitle,
      tracks: shown.map((r) => ({ number: r.number, title: r.title })),
      text: shown.length ? undefined : 'Die Titel stehen fest, sobald die SD-Karte eingelesen ist.',
    };
  }
  // Special cards: what they do, and how.
  const says = d.folder === 0 ? `${specialSummary(d, profile.value)} ${MODIFIER_HOWTO}` : (item.subtitle ?? '');
  return { heading: item.title, text: says.trim() };
}

/* ------------------------------------------------------------------ drawing */

const INK = '#2a1f16';
const PENCIL = '#8a7866';
const RULE = '#d8cdbb';

/** Colours of a back side: by default white like an inlay, else those of the sticker's front (BackInk of render.ts). */
export interface BackInk {
  paper: string;
  /** The number's plate and its digits. */
  plate: string;
  digits: string;
  /** Heading and titles; numbers and the line under the heading. */
  text: string;
  soft: string;
  rule: string;
}

export const WHITE_BACK: BackInk = { paper: '#ffffff', plate: INK, digits: '#ffffff', text: INK, soft: PENCIL, rule: RULE };

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Drawing in millimetres from the label's top left corner, as render.ts does: positions and sizes times `k`, past the bleed. */
interface Pen {
  ctx: Context2D;
  k: number;
  X: (mm: number) => number;
  Y: (mm: number) => number;
  font: StickerFont;
  title: Measure;
  text: Measure;
  ink: BackInk;
}

/** The part of the label text may use: inside the safe margin, for round labels the square inside the circle. */
function textArea(g: StickerGeometry): Box {
  const pad = Math.max(g.safeMm, 2.5);
  if (g.shape === 'round') {
    const side = Math.min(g.widthMm, g.heightMm) / Math.SQRT2 - 1;
    return { x: (g.widthMm - side) / 2, y: (g.heightMm - side) / 2, width: side, height: side };
  }
  return { x: pad, y: pad, width: g.widthMm - 2 * pad, height: g.heightMm - 2 * pad };
}

let qrLib: typeof import('qrcode') | undefined;

/** Loads the QR library (its own file of the build): before renderBack with mode 'qr', which draws synchronously. */
export async function loadBackQr(): Promise<void> {
  qrLib ??= await import('qrcode');
}

/**
 * One back side with its bleed, white, at `pxPerMm`. `geometry` is the label
 * as it lies on the sheet (not turned), so the back fills its slot straight.
 * Mode 'qr' needs loadBackQr() first.
 */
export function renderBack(content: BackContent | undefined, mode: Exclude<BackMode, 'none'>, geometry: StickerGeometry, pxPerMm: number, font: StickerFont, ink: BackInk = WHITE_BACK): CanvasLike {
  const k = pxPerMm;
  const B = geometry.bleedMm;
  const canvas = createCanvas(Math.round((geometry.widthMm + 2 * B) * k), Math.round((geometry.heightMm + 2 * B) * k));
  const ctx = get2d(canvas);
  ctx.fillStyle = ink.paper;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!content) return canvas;
  const measureWith =
    (face: StickerFont['title']): Measure =>
    (str, size) => {
      ctx.font = fontCss(face, size * k);
      return ctx.measureText(str).width / k;
    };
  const pen: Pen = { ctx, k, X: (mm) => (mm + B) * k, Y: (mm) => (mm + B) * k, font, title: measureWith(font.title), text: measureWith(font.text), ink };
  const { X, Y } = pen;
  const area = textArea(geometry);
  if (content.credit) {
    // The source of the pictogram at the foot; the rest keeps above it.
    const size = fitLine(content.credit, pen.text, area.width, 1.4, 0.9);
    ctx.font = fontCss(font.text, size * k);
    ctx.fillStyle = ink.soft;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(content.credit, X(area.x), Y(area.y + area.height - size * 0.25));
    area.height -= size * 1.5;
  }
  ctx.textBaseline = 'alphabetic';
  let y = area.y;

  // Head: the number in a small dark box, then the heading on one line.
  let x = area.x;
  const headSize = Math.min(4.2, Math.max(2.4, area.height * 0.13));
  const baseline = y + headSize * 0.95;
  if (content.number) {
    const size = headSize * 0.8;
    const w = pen.title(content.number, size) + headSize * 0.7;
    ctx.fillStyle = ink.plate;
    roundRect(ctx, X(x), Y(y), w * k, headSize * 1.25 * k, headSize * 0.3 * k);
    ctx.fill();
    ctx.font = fontCss(font.title, size * k);
    ctx.fillStyle = ink.digits;
    ctx.textAlign = 'center';
    ctx.fillText(content.number, X(x + w / 2), Y(baseline));
    x += w + headSize * 0.5;
  }
  const headRoom = area.x + area.width - x;
  let size = fitLine(content.heading, pen.title, headRoom, headSize, headSize * 0.62);
  // Too long for one line even small: two lines, the second cut with "…" only if it must.
  let lines = [content.heading];
  if (pen.title(content.heading, size) > headRoom) {
    let wrapped: string[] | null = null;
    for (size = headSize * 0.8; size >= headSize * 0.55; size -= headSize * 0.05) {
      wrapped = wrap(tokenize(content.heading), size, headRoom, pen.title, 'syllables');
      if (wrapped && wrapped.length <= 2) break;
    }
    size = Math.max(size, headSize * 0.55);
    wrapped ??= [content.heading];
    lines = wrapped.length <= 2 ? wrapped : [wrapped[0], wrapped.slice(1).join(' ')];
    lines = lines.map((l) => (pen.title(l, size) > headRoom ? ellipsize(l, size, headRoom, pen.title) : l));
  }
  ctx.font = fontCss(font.title, size * k);
  ctx.fillStyle = ink.text;
  ctx.textAlign = 'left';
  lines.forEach((l, i) => ctx.fillText(l, X(x), Y(baseline + i * size * 1.15)));
  y += headSize * 1.25 + 1 + (lines.length - 1) * size * 1.15;
  if (content.subheading) {
    const sub = Math.max(1.8, headSize * 0.55);
    const line = pen.text(content.subheading, sub) > area.width ? ellipsize(content.subheading, sub, area.width, pen.text) : content.subheading;
    ctx.font = fontCss(font.text, sub * k);
    ctx.fillStyle = ink.soft;
    ctx.fillText(line, X(area.x), Y(y + sub * 0.9));
    y += sub * 1.3;
  }
  ctx.strokeStyle = ink.rule;
  ctx.lineWidth = Math.max(1, 0.25 * k);
  ctx.beginPath();
  ctx.moveTo(X(area.x), Y(y + 0.6));
  ctx.lineTo(X(area.x + area.width), Y(y + 0.6));
  ctx.stroke();
  y += 1.8;
  const body: Box = { x: area.x, y, width: area.width, height: area.y + area.height - y };
  if (body.height < 3) return canvas;

  const tracks = content.tracks ?? [];
  if (!tracks.length) {
    if (content.text) drawParagraph(pen, content.text, body);
  } else if (mode === 'qr') drawQr(pen, content, tracks, body);
  else drawList(pen, tracks, body);
  return canvas;
}

function drawList(pen: Pen, tracks: BackTrack[], body: Box) {
  const { ctx, k, X, Y, font, ink } = pen;
  // Whole titles over more lines where they fit; else one line each, cut with "…".
  const w = wrappedBackList(tracks, { widthMm: body.width, heightMm: body.height }, pen.text);
  if (w) {
    ctx.font = fontCss(font.text, w.sizeMm * k);
    for (const it of w.items) {
      const x = body.x + it.column * (w.columnMm + w.gapMm);
      const y = body.y + it.line * w.lineMm + w.sizeMm;
      ctx.fillStyle = ink.soft;
      ctx.textAlign = 'right';
      ctx.fillText(String(it.track.number), X(x + w.numberMm - w.sizeMm * 0.6), Y(y));
      ctx.fillStyle = ink.text;
      ctx.textAlign = 'left';
      it.lines.forEach((line, j) => ctx.fillText(line, X(x + w.numberMm), Y(y + j * w.lineMm)));
    }
    return;
  }
  const l = backListLayout(tracks.length, { widthMm: body.width, heightMm: body.height });
  const gap = l.sizeMm * 1.2;
  const colWidth = (body.width - gap * (l.columns - 1)) / l.columns;
  const numWidth = pen.text(String(Math.max(...tracks.map((t) => t.number))), l.sizeMm) + l.sizeMm * 0.6;
  const lines: ({ kind: 'track'; t: BackTrack } | { kind: 'more'; rest: number })[] = tracks.slice(0, l.shown).map((t) => ({ kind: 'track', t }));
  if (l.shown < tracks.length) lines.push({ kind: 'more', rest: tracks.length - l.shown });
  ctx.font = fontCss(font.text, l.sizeMm * k);
  lines.forEach((line, i) => {
    const x = body.x + Math.floor(i / l.rows) * (colWidth + gap);
    const y = body.y + (i % l.rows) * l.lineMm + l.sizeMm;
    if (line.kind === 'more') {
      ctx.fillStyle = ink.soft;
      ctx.textAlign = 'left';
      ctx.fillText(moreLine(line.rest), X(x), Y(y));
      return;
    }
    ctx.fillStyle = ink.soft;
    ctx.textAlign = 'right';
    ctx.fillText(String(line.t.number), X(x + numWidth - l.sizeMm * 0.6), Y(y));
    ctx.fillStyle = ink.text;
    ctx.textAlign = 'left';
    ctx.fillText(fitTrackTitle(line.t, colWidth - numWidth, l.sizeMm, pen.text), X(x + numWidth), Y(y));
    // measureText in fitTrackTitle set another size: back to the list's.
    ctx.font = fontCss(font.text, l.sizeMm * k);
  });
}

function drawQr(pen: Pen, content: BackContent, tracks: BackTrack[], body: Box) {
  const { ctx, k, X, Y } = pen;
  const heading = [content.number, content.heading].filter(Boolean).join(' ');
  if (!qrLib) throw new Error('loadBackQr() first');
  const qr = qrLib.create(trackListText(heading, tracks), { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const side = Math.min(body.height, body.width * 0.55);
  // Two cells of white all round: phones find the code more easily.
  const cell = side / (n + 4);
  const at = 2 * cell;
  // Dark on white, whatever the back's colour: phones read that best.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(X(body.x), Y(body.y), side * k, side * k);
  ctx.fillStyle = INK;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      // A hair larger, so neighbouring cells close up without seams.
      if (qr.modules.get(r, c)) ctx.fillRect(X(body.x + at + c * cell), Y(body.y + at + r * cell), cell * k + 0.5, cell * k + 0.5);
    }
  }
  const x = body.x + side + Math.min(2, body.width * 0.03);
  const say = `${tracks.length === 1 ? '1 Titel' : `${tracks.length} Titel`}. Halte die Handy-Kamera auf den Code, dann zeigt sie die Liste.`;
  drawParagraph(pen, say, { x, y: body.y, width: body.x + body.width - x, height: body.height });
}

function drawParagraph(pen: Pen, words: string, box: Box) {
  const { ctx, k, X, Y, font, ink } = pen;
  const fit = fitText(words, pen.text, { maxWidth: box.width, maxHeight: box.height, maxLines: 8, maxSize: 3, minSize: 1.7, lineHeight: 1.3, balance: false });
  ctx.font = fontCss(font.text, fit.size * k);
  ctx.fillStyle = ink.text;
  ctx.textAlign = 'left';
  fit.lines.forEach((line, i) => ctx.fillText(line, X(box.x), Y(box.y + fit.size + i * fit.size * fit.lineHeight)));
}

function roundRect(ctx: Context2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
