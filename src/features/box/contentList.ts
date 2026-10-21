/**
 * "Inhaltsliste drucken": what each folder of the SD card holds, on one
 * page to stick inside the lid of the box. Number, name, how many tracks,
 * how long, and how its card plays when the app knows the card.
 *
 * Usually two lists side by side on an A4 sheet across (A5 each, to cut in
 * half like the Bedienkarte: one for the lid, one for the drawer). A card
 * with very many folders gets the whole sheet upright instead.
 */
import type { ShelfItem } from '../../core/tonuino/catalog';
import { formatDuration, plural } from '../../app/format';
import { cardSummary, folderCardData } from '../cards/items';

export interface ContentRow {
  number: number;
  /** The folder's name on the card, e.g. "04". */
  name: string;
  title: string;
  tracks: number;
  /** Total length in whole minutes; missing when a track's length is not known. */
  minutes?: number;
  /** How the folder's card plays, e.g. "Hörbuch"; only for folders the app knows. */
  card?: string;
}

/** The folders on the card, in their order; folders only the app remembers are left out. */
export function contentRows(shelf: readonly ShelfItem[]): ContentRow[] {
  return shelf
    .filter((i) => i.state !== 'missing')
    .map((i) => {
      const row: ContentRow = { number: i.number, name: i.name, title: i.title, tracks: i.trackCount };
      // A short folder counts as one minute: "0 Min." would read as empty.
      if (i.trackCount && i.durationSec !== undefined) row.minutes = Math.max(1, Math.round(i.durationSec / 60));
      if (i.entry) row.card = cardSummary(folderCardData(i.number, i.entry.card, i.entry.kind));
      return row;
    });
}

/** A length to read at a glance: "52 Min.", "1 Std. 5 Min.". */
export function lengthText(minutes: number): string {
  return formatDuration(minutes * 60, { long: true });
}

/** The small line under a folder's name: "14 Titel · 52 Min. · Karte: Hörbuch". */
export function rowDetails(row: ContentRow): string {
  const parts = [row.tracks ? plural(row.tracks, 'Titel', 'Titel') : 'leer'];
  if (row.minutes !== undefined) parts.push(lengthText(row.minutes));
  if (row.card) parts.push(`Karte: ${row.card}`);
  return parts.join(' · ');
}

/** Under the title: how many folders, how long all together (when known), and the date. */
export function contentAbout(rows: readonly ContentRow[], date: Date): string {
  const parts = [plural(rows.length, 'Ordner', 'Ordner')];
  const playing = rows.filter((r) => r.tracks);
  // Only when every folder's length is known: one missing would make the sum too short.
  if (playing.length && playing.every((r) => r.minutes !== undefined)) {
    // Summed from the rounded lengths, so the total matches the lines.
    parts.push(lengthText(playing.reduce((sum, r) => sum + r.minutes!, 0)));
  }
  parts.push(`Stand ${date.getDate()}.${date.getMonth() + 1}.${date.getFullYear()}`);
  return parts.join(' · ');
}

/* ---------------------------------------------------------------- layout */

export interface ContentLayout {
  /** Two lists on an A4 sheet across (A5 each), or one on the whole sheet upright. */
  sheet: 'a5x2' | 'a4';
  columns: 1 | 2 | 3;
  /** Size of the folder names (pt); the line under them is 1.5 pt smaller. */
  pt: number;
}

/** Paper of the sheet (mm). */
export const SHEET = {
  a5x2: { widthMm: 297, heightMm: 210 },
  a4: { widthMm: 210, heightMm: 297 },
} as const;

/** Margin around one list (mm). */
export const LIST_MARGIN = 12;
/** Title and line under it (mm), above the folders. */
export const LIST_HEAD = 24;
/** Space between two columns (mm). */
export const COLUMN_GAP = 6;

/** Height of one folder (mm): its name, the line under it, and some air. */
export function rowHeight(pt: number): number {
  return pt * 0.42 + (pt - 1.5) * 0.42 + 2;
}

/** The size of one list on the sheet (mm). */
export function listBox(sheet: ContentLayout['sheet']): { width: number; height: number } {
  const page = SHEET[sheet];
  const width = (sheet === 'a5x2' ? page.widthMm / 2 : page.widthMm) - 2 * LIST_MARGIN;
  return { width, height: page.heightMm - 2 * LIST_MARGIN };
}

/**
 * The biggest type that fits: one column on A5 while the names stay easy to
 * read, then two; a card with too many folders for that gets the whole A4
 * sheet in two or three columns. 99 folders, the most a box plays, fit there.
 */
export function contentLayout(count: number): ContentLayout {
  const tries: ContentLayout[] = [
    ...[12, 11, 10, 9].map((pt) => ({ sheet: 'a5x2' as const, columns: 1 as const, pt })),
    ...[9, 8.5, 8, 7.5].map((pt) => ({ sheet: 'a5x2' as const, columns: 2 as const, pt })),
    ...[10, 9, 8, 7.5].map((pt) => ({ sheet: 'a4' as const, columns: 2 as const, pt })),
    ...[8.5, 8, 7.5, 7].map((pt) => ({ sheet: 'a4' as const, columns: 3 as const, pt })),
  ];
  const fits = (l: ContentLayout) => Math.ceil(count / l.columns) * rowHeight(l.pt) <= listBox(l.sheet).height - LIST_HEAD;
  return tries.find(fits) ?? tries[tries.length - 1];
}
