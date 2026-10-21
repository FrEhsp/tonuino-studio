import type { Catalog, CatalogFolder } from '../../core/tonuino/catalog';
import { folderName } from '../../core/tonuino/sd';

/** A track row as the folder page shows it (see trackRows). */
export interface ShownRow {
  file: string;
  title: string;
  durationSec?: number;
}

export function emptyEntry(n: number): CatalogFolder {
  const now = Date.now();
  return { title: `Ordner ${folderName(n)}`, tracks: [], addedAt: now, updatedAt: now };
}

/**
 * Notes the rows shown now in the catalog. New tracks get the title and
 * length shown, swapped ones (`replaced`, file names) get them anew, since
 * the old title belonged to the old file. With `fill`, the other tracks keep
 * the title shown now too, even when it only came from the file name: needed
 * before the files get new names. "Übernehmen" and "Lücken schließen" both
 * use this, so closing a gap in a folder changed elsewhere takes over the new
 * state as well.
 */
export function applyShownRows(c: Catalog, folder: number, rows: readonly ShownRow[], opts: { replaced?: readonly string[]; fill?: boolean } = {}): void {
  const name = folderName(folder);
  const e = c.folders[name] ?? (c.folders[name] = emptyEntry(folder));
  const swapped = new Set((opts.replaced ?? []).map((x) => x.toLowerCase()));
  for (const r of rows) {
    const t = e.tracks.find((x) => x.file.toLowerCase() === r.file.toLowerCase());
    if (!t) e.tracks.push({ file: r.file, title: r.title, durationSec: r.durationSec });
    else if (swapped.has(r.file.toLowerCase())) {
      t.title = r.title;
      t.durationSec = r.durationSec;
    } else if (opts.fill) {
      t.title ||= r.title;
      t.durationSec ??= r.durationSec;
    }
  }
}
