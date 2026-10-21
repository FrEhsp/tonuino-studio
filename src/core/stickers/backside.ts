/**
 * Back sides of stickers (extra "Sticker-Rückseite", forum 1216 and 10468):
 * after every sheet comes a sheet with the back of each sticker, the track
 * list or a QR code of it. Printed on both sides and turned over the long
 * edge, the paper's left edge becomes its right edge, top stays top: so the
 * back sheet has its labels mirrored left to right, each back exactly behind
 * its front.
 *
 * Pure geometry and text in millimetres; the drawing is in
 * features/stickers/backside.ts.
 */
import { round4, type LabelTemplate } from './templates';
import type { Measure } from './text';
import { ellipsize, tokenize, wrap } from './text';

export type BackMode = 'none' | 'list' | 'qr';

/**
 * The template for a sheet of back sides: the same labels, with the columns
 * starting from the other side of the page, so the back of slot (row, col)
 * lies at x' = page width − x − label width. Rows stay where they are.
 */
export function mirrorTemplate(t: LabelTemplate): LabelTemplate {
  const { cols, marginLeftMm, pitchXMm } = t.grid;
  const right = t.page.widthMm - (marginLeftMm + (Math.max(1, cols) - 1) * pitchXMm + t.label.widthMm);
  return { ...t, id: `${t.id}~rueckseite`, grid: { ...t.grid, marginLeftMm: round4(right) } };
}

/**
 * One sheet of back sides in the slot order of mirrorTemplate: the back of
 * the sticker in slot (row, col) of the front goes to (row, cols − 1 − col).
 */
export function mirrorPage<T>(page: readonly (T | null)[], t: Pick<LabelTemplate, 'grid'>): (T | null)[] {
  const { cols } = t.grid;
  const out = new Array<T | null>(page.length).fill(null);
  page.forEach((item, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    out[row * cols + (cols - 1 - col)] = item ?? null;
  });
  return out;
}

/* ------------------------------------------------------------------ track list */

export interface BackTrack {
  number: number;
  title: string;
}

export interface BackListLayout {
  /** Columns side by side. */
  columns: number;
  /** Lines per column. */
  rows: number;
  /** Font size and line distance, mm. */
  sizeMm: number;
  lineMm: number;
  /** Tracks shown; when fewer than all, the last line says how many more there are. */
  shown: number;
}

export interface BackListOptions {
  maxSizeMm?: number;
  minSizeMm?: number;
  /** Line distance as a factor of the font size. */
  lineHeight?: number;
  /** A column is at least this many font sizes wide, so titles keep a few words. */
  columnEms?: number;
}

/**
 * How `count` track lines fit into a box: the largest font that fits them
 * all, in as few columns as needed (a column stays wide enough for a few
 * words). When not even the smallest font fits them all, the list stops one
 * line early and that line says "… und N weitere".
 */
export function backListLayout(count: number, box: { widthMm: number; heightMm: number }, o: BackListOptions = {}): BackListLayout {
  const max = o.maxSizeMm ?? 3;
  const min = o.minSizeMm ?? 1.7;
  const lh = o.lineHeight ?? 1.28;
  const ems = o.columnEms ?? 11;
  const fit = (size: number) => {
    const rows = Math.max(1, Math.floor(box.heightMm / (size * lh) + 1e-6));
    const maxColumns = Math.max(1, Math.floor(box.widthMm / (size * ems) + 1e-6));
    return { rows, maxColumns };
  };
  for (let size = max; size >= min - 1e-9; size = Math.round((size - 0.1) * 100) / 100) {
    const { rows, maxColumns } = fit(size);
    const columns = Math.max(1, Math.ceil(count / rows));
    if (columns <= maxColumns) return { columns, rows: Math.min(rows, Math.max(1, Math.ceil(count / columns))), sizeMm: size, lineMm: size * lh, shown: count };
  }
  const { rows, maxColumns } = fit(min);
  const room = rows * maxColumns;
  return { columns: maxColumns, rows, sizeMm: min, lineMm: min * lh, shown: Math.max(0, Math.min(count, room - 1)) };
}

export interface WrappedBackList {
  columns: number;
  sizeMm: number;
  lineMm: number;
  /** Width of a column and of the number in front of each title, gap between columns, mm. */
  columnMm: number;
  numberMm: number;
  gapMm: number;
  /** Each track with its lines, its column and the line of the column it starts on. */
  items: { track: BackTrack; lines: string[]; column: number; line: number }[];
}

/**
 * The track list with whole titles: a title too long for its column goes on
 * over a second or third line (Frank 2026-10-13: "Bei den Titeln auf der
 * Rückseite lässt sich nicht alles lesen bei den langen Titeln"). Takes the
 * largest font at which every title fits whole, and at that font the columns
 * that need the fewest lines. A track never splits across columns.
 * Undefined when not even the smallest font fits them all: then the list is
 * cut as in backListLayout.
 */
export function wrappedBackList(tracks: readonly BackTrack[], box: { widthMm: number; heightMm: number }, measure: Measure, o: BackListOptions & { maxLinesPerTitle?: number } = {}): WrappedBackList | undefined {
  if (!tracks.length) return undefined;
  const max = o.maxSizeMm ?? 3;
  const min = o.minSizeMm ?? 1.7;
  const lh = o.lineHeight ?? 1.28;
  const ems = o.columnEms ?? 11;
  const most = o.maxLinesPerTitle ?? 3;
  const widest = String(Math.max(...tracks.map((t) => t.number)));
  for (let size = max; size >= min - 1e-9; size = Math.round((size - 0.1) * 100) / 100) {
    const rows = Math.floor(box.heightMm / (size * lh) + 1e-6);
    const maxColumns = Math.max(1, Math.floor(box.widthMm / (size * ems) + 1e-6));
    const gapMm = size * 1.2;
    const numberMm = measure(widest, size) + size * 0.6;
    let best: WrappedBackList | undefined;
    let bestLines = Infinity;
    for (let columns = 1; columns <= maxColumns; columns++) {
      const columnMm = (box.widthMm - gapMm * (columns - 1)) / columns;
      const room = columnMm - numberMm;
      if (room <= 0) break;
      const wrapped: string[][] = [];
      for (const t of tracks) {
        const title = t.title.replace(/\s+/g, ' ').trim() || `Titel ${t.number}`;
        const lines = wrap(tokenize(title), size, room, measure, 'syllables') ?? wrap(tokenize(title), size, room, measure, 'chars');
        if (!lines || lines.length > most) break;
        wrapped.push(lines);
      }
      if (wrapped.length < tracks.length) continue;
      const total = wrapped.reduce((n, l) => n + l.length, 0);
      if (total >= bestLines) continue;
      // Columns of about equal length: the fewest lines per column that holds them all.
      for (let cap = Math.ceil(total / columns); cap <= rows; cap++) {
        const items: WrappedBackList['items'] = [];
        let column = 0;
        let line = 0;
        for (let i = 0; i < tracks.length && column < columns; i++) {
          const n = wrapped[i].length;
          if (line + n > cap) {
            column++;
            line = 0;
          }
          if (column >= columns || n > cap) break;
          items.push({ track: tracks[i], lines: wrapped[i], column, line });
          line += n;
        }
        if (items.length === tracks.length) {
          best = { columns, sizeMm: size, lineMm: size * lh, columnMm, numberMm, gapMm, items };
          bestLines = total;
          break;
        }
      }
    }
    if (best) return best;
  }
  return undefined;
}

/** "… und 12 weitere": the line that ends a list cut short. */
export function moreLine(rest: number): string {
  return rest === 1 ? '… und 1 weiterer Titel' : `… und ${rest} weitere Titel`;
}

/**
 * A line of the list: the title cut to the room after its number, ending on
 * "…" when cut. Empty titles read "Titel n".
 */
export function fitTrackTitle(t: BackTrack, width: number, size: number, measure: Measure): string {
  const title = t.title.replace(/\s+/g, ' ').trim() || `Titel ${t.number}`;
  return measure(title, size) <= width ? title : ellipsize(title, size, width, measure);
}

/* ------------------------------------------------------------------ QR code */

/** Most bytes in the QR code of a back side: small enough that a phone reads it off a sticker of 3 to 4 cm. */
export const BACK_QR_MAX_BYTES = 350;

const encoder = new TextEncoder();
const bytesOf = (text: string) => encoder.encode(text).length;

/**
 * The text of the QR code: the heading, then one line per track ("3 Title").
 * When that is too long, titles get shorter step by step, then the list
 * stops early with a line saying how many more there are.
 */
export function trackListText(heading: string, tracks: readonly BackTrack[], maxBytes = BACK_QR_MAX_BYTES): string {
  const head = heading.replace(/\s+/g, ' ').trim();
  const line = (t: BackTrack, max: number) => {
    const title = t.title.replace(/\s+/g, ' ').trim() || `Titel ${t.number}`;
    const chars = [...title];
    return `${t.number} ${chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…` : title}`;
  };
  const build = (max: number, shown: number) => {
    const lines = [head, ...tracks.slice(0, shown).map((t) => line(t, max))];
    if (shown < tracks.length) lines.push(moreLine(tracks.length - shown));
    return lines.filter(Boolean).join('\n');
  };
  for (const max of [60, 40, 30, 24, 18, 12]) {
    const text = build(max, tracks.length);
    if (bytesOf(text) <= maxBytes) return text;
  }
  let shown = tracks.length;
  while (shown > 0 && bytesOf(build(12, shown)) > maxBytes) shown--;
  return build(12, shown);
}
