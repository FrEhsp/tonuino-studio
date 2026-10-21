import type { jsPDF } from 'jspdf';
import { androidAppSupport, phoneAppSteps, READ_CRASH_SHEET_NOTE } from '../../core/tonuino/androidapp';
import { cardToQrLine, type CardData } from '../../core/tonuino/card';
import { toWinAnsi } from '../../core/stickers/calibration';

/** What a code needs of a card: its bytes and its title. */
export interface QrCard {
  title: string;
  data: CardData;
  /** A further card: its own name. For a folder the title is "Ordnername · name". */
  extra?: { label: string };
}

const ELLIPSIS = '…';

/**
 * A card's line in the list under a code, cut to `width` (measured with
 * `measure`). The name of a further card for a folder stays whole and its
 * folder is shortened ("Bibi Blocksberg – Hex… · Das Hexenfest"), so lines
 * of the same folder still differ; any other line ends on "…" when cut.
 */
export function fitSheetLine(number: string, item: Pick<QrCard, 'title' | 'extra'>, width: number, measure: (text: string) => number): string {
  const whole = number + item.title;
  if (measure(whole) <= width) return whole;
  /** The longest start of `text` that fits with `after`, at a space when one is near the end. */
  const startOf = (text: string, before: string, after: string) => {
    let n = text.length;
    while (n > 0 && measure(before + text.slice(0, n).trimEnd() + after) > width) n--;
    const cut = text.slice(0, n);
    const space = cut.lastIndexOf(' ');
    return (space > cut.length * 0.6 ? cut.slice(0, space) : cut).trimEnd().replace(/[-–,;:]$/, '').trimEnd();
  };
  const cutEnd = (text: string) => startOf(text, '', ELLIPSIS) + ELLIPSIS;
  const suffix = item.extra ? ` · ${item.extra.label}` : '';
  if (!suffix || !item.title.endsWith(suffix) || item.title.length === suffix.length) return cutEnd(whole);
  const folder = item.title.slice(0, -suffix.length);
  // The name alone is too long: it is what tells the cards apart, so it goes first, cut at its end.
  if (measure(number + ELLIPSIS + suffix) > width) return cutEnd(number + item.extra!.label);
  return number + startOf(folder, number, ELLIPSIS + suffix) + ELLIPSIS + suffix;
}

/** One line per card for "TonUINO NFC Tools": hex bytes, then the title. */
export function linesFor(items: QrCard[]): string[] {
  return items.map((i) => cardToQrLine(i.data, i.title));
}

export interface QrSheetOptions {
  /** Name of the box, at the top of the sheet. */
  boxName?: string;
  /** When the sheet was made, next to the name. */
  date?: Date;
}

const INK = '#2a1f16';
const PENCIL = '#8a7866';
const LEFT = 15;
const WIDTH = 180;
const BOTTOM = 290;
const CELL_W = 90;
const CELL_H = 88;
/** Where a code's frame ends, below its top (mm): the code, then eight lines of cards. */
const FRAME_END = 82;
const LINE = 3.3;
/** The code stays this big (mm): small enough for six on a page, big enough for any phone camera. */
const CODE = 52;

/** Text set in one of the app's own fonts, as a picture: jsPDF only embeds TTF, the app has WOFF2. */
interface Drawn {
  url: string;
  /** Width by height. */
  ratio: number;
}

/** The handwriting of the app, loaded before a canvas draws with it (else it falls back quietly). */
async function fontsReady(): Promise<void> {
  try {
    if (typeof document !== 'undefined' && document.fonts) await document.fonts.load("700 64px 'Shantell Sans'");
  } catch {
    // Without them the canvas uses its fallback font; the sheet still works.
  }
}

/** Null without a canvas (tests, very old browsers): then the sheet uses Helvetica. */
function drawn(text: string, font: (px: number) => string, px: number): Drawn | null {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.font = font(px);
    const w = Math.ceil(ctx.measureText(text).width + px * 0.3);
    const h = Math.ceil(px * 1.4);
    canvas.width = w;
    canvas.height = h;
    ctx.font = font(px);
    ctx.fillStyle = INK;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, px * 0.15, px * 1.05);
    return { url: canvas.toDataURL('image/png'), ratio: w / h };
  } catch {
    return null;
  }
}

const hand = (px: number) => `700 ${px}px 'Shantell Sans', 'Comic Sans MS', sans-serif`;

/** Places drawn text with its top left at x, y and this height; returns its width. */
function place(doc: jsPDF, d: Drawn, x: number, y: number, h: number): number {
  doc.addImage(d.url, 'PNG', x, y, h * d.ratio, h);
  return h * d.ratio;
}

/** A small random walk that is the same on every run, so the frames look drawn but the sheet does not change. */
function wobble(seed: number): () => number {
  let s = (seed * 9301 + 49297) % 233280;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280 - 0.5;
  };
}

/** A frame as drawn with a pencil: straight-ish lines with a slight wobble, corners overshooting a little. */
function pencilFrame(doc: jsPDF, x: number, y: number, w: number, h: number, seed: number): void {
  const r = wobble(seed);
  doc.setDrawColor(PENCIL);
  doc.setLineWidth(0.35);
  const side = (x1: number, y1: number, x2: number, y2: number) => {
    const steps = Math.max(2, Math.round(Math.hypot(x2 - x1, y2 - y1) / 12));
    let px = x1 + r() * 0.8;
    let py = y1 + r() * 0.8;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const nx = x1 + (x2 - x1) * t + r() * 0.6;
      const ny = y1 + (y2 - y1) * t + r() * 0.6;
      doc.line(px, py, nx, ny);
      px = nx;
      py = ny;
    }
  };
  side(x - 1, y, x + w + 0.8, y);
  side(x + w, y - 1, x + w, y + h + 0.8);
  side(x + w + 1, y + h, x - 0.8, y + h);
  side(x, y + h + 1, x, y - 0.8);
}

/** The head of every page: a handwritten title, the box and the day on the right. */
function pageHead(doc: jsPDF, title: Drawn | null, opts: QrSheetOptions): void {
  if (title) place(doc, title, LEFT - 1, 7, 10);
  else {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(INK);
    doc.text(toWinAnsi('TonUINO-Karten fürs Handy'), LEFT, 14);
  }
  const about = [opts.boxName?.trim(), opts.date?.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' })].filter(Boolean).join(' · ');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(PENCIL);
  if (about) doc.text(toWinAnsi(about), LEFT + WIDTH, 11, { align: 'right' });
  doc.text(toWinAnsi('App: TonUINO NFC Tools (F-Droid)'), LEFT + WIDTH, 15.5, { align: 'right' });
  doc.setTextColor(INK);
}

/** The steps in the app, numbered, under the head of the first page. Returns where the codes can start. */
function stepsBlock(doc: jsPDF, steps: string[], top: number): number {
  let y = top;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  steps.forEach((step, i) => {
    doc.setFont('helvetica', 'bold');
    doc.text(`${i + 1}.`, LEFT, y);
    doc.setFont('helvetica', 'normal');
    const lines = doc.splitTextToSize(toWinAnsi(step), WIDTH - 7) as string[];
    doc.text(lines, LEFT + 6, y);
    y += lines.length * 4.3 + 1.2;
  });
  return y;
}

/** The star note, when a card of this page carries a star. Returns where the codes can start. */
function starNote(doc: jsPDF, y: number): number {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  const lines = doc.splitTextToSize(toWinAnsi(READ_CRASH_SHEET_NOTE), WIDTH) as string[];
  doc.text(lines, LEFT, y);
  return y + lines.length * 3.4;
}

/**
 * A printable sheet: the steps in the app at the top, then the codes, each
 * with a big handwritten number and its cards to tick off. Up to six codes on a
 * page, four on the first. Cards the phone app cannot read back carry a
 * star, and every page with such a card says what the star means: the
 * family may write the cards from the paper, away from the screen and its
 * notes.
 */
export async function qrSheetPdf(groups: QrCard[][], opts: QrSheetOptions = {}): Promise<Blob> {
  const [{ jsPDF }, QRCode] = await Promise.all([import('jspdf'), import('qrcode')]);
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  await fontsReady();
  const title = drawn('TonUINO-Karten fürs Handy', hand, 64);
  const starred = (item: QrCard) => androidAppSupport(item.data) === 'readCrash';
  const several = groups.length > 1;

  const rowsFrom = (top: number) => Math.max(1, Math.floor((BOTTOM - top - FRAME_END) / CELL_H) + 1);

  let i = 0;
  for (let page = 0; i < groups.length; page++) {
    if (page > 0) doc.addPage();
    pageHead(doc, title, opts);
    const head = page === 0 ? stepsBlock(doc, phoneAppSteps(several, true), 25) : 21;
    let top = Math.max(24, head + 4);
    let onPage = groups.slice(i, i + rowsFrom(top) * 2);
    if (onPage.some((g) => g.some(starred))) {
      top = Math.max(24, starNote(doc, head + 0.5) + 4);
      onPage = groups.slice(i, i + rowsFrom(top) * 2);
    }

    for (let slot = 0; slot < onPage.length; slot++, i++) {
      const x = LEFT + (slot % 2) * CELL_W;
      const y = top + Math.floor(slot / 2) * CELL_H;
      const cards = groups[i];
      pencilFrame(doc, x - 2.5, y - 2.5, CELL_W - 6, FRAME_END + 2.5, i + 1);
      const png = await QRCode.toDataURL(linesFor(cards).join('\n'), { margin: 1, errorCorrectionLevel: 'M', scale: 8 }).catch(() => {
        throw new Error(`Code ${i + 1} ließ sich nicht erzeugen, die Titel sind zu lang. Wähle weniger Karten pro Code.`);
      });
      doc.addImage(png, 'PNG', x, y, CODE, CODE);

      // Next to the code its number, big and handwritten. A single code has none, as on screen. The
      // handwriting, not the marker: its 1 looks like a bracket.
      const nx = x + CODE + 5;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(PENCIL);
      doc.text('Code', nx, y + 4);
      doc.setTextColor(INK);
      if (several) {
        const num = drawn(String(i + 1), hand, 120);
        if (num) place(doc, num, nx - 1, y + 5, 19);
        else {
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(36);
          doc.text(String(i + 1), nx, y + 19);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(9);
        }
      }
      doc.setTextColor(PENCIL);
      if (several) doc.text(`von ${groups.length}`, nx, y + 28.5);
      doc.text(cards.length === 1 ? '1 Karte' : `${cards.length} Karten`, nx, y + (several ? 33 : 8.5));
      doc.setTextColor(INK);

      // Eight lines fit under a code; a longer list ends with how many are left out.
      const shown = cards.length > 8 ? cards.slice(0, 7) : cards;
      doc.setDrawColor(PENCIL);
      doc.setLineWidth(0.3);
      const lineY = (j: number) => y + 57.5 + j * LINE;
      shown.forEach((item, j) => {
        const ansi = { title: toWinAnsi(item.title), extra: item.extra && { label: toWinAnsi(item.extra.label) } };
        const first = fitSheetLine(`${j + 1}. `, ansi, CELL_W - 18 - (starred(item) ? doc.getTextWidth(' *') : 0), (t) => doc.getTextWidth(t));
        // A box to tick once the card is written.
        doc.rect(x, lineY(j) - 2.4, 2.5, 2.5);
        doc.text(first + (starred(item) ? ' *' : ''), x + 4.2, lineY(j));
      });
      const hidden = cards.slice(shown.length);
      if (hidden.length) {
        const star = hidden.some(starred) ? ' *' : '';
        doc.text(toWinAnsi(`… und ${hidden.length} weitere Karten`) + star, x + 4.2, lineY(shown.length));
      }
    }
  }
  return doc.output('blob');
}
