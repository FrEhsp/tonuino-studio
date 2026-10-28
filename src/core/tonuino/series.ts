/**
 * A series spread over several folders ("Die drei ??? 012 – Der
 * Super-Papagei", "Bibi Blocksberg – Folge 3", "Paw Patrol 1"): each
 * episode takes one of the 99 numbers a box plays. Packing them into one
 * folder (pack.ts) frees all but one, so "Meine Box" names a series it
 * finds and offers to pack it.
 *
 * Only a title with an episode number counts: the common beginning before
 * the number is the series ("Die drei ???"). A folder titled exactly like
 * the series (one packed before) belongs to it too, and so does a folder
 * whose catalog names the series (CatalogFolder.series, e.g. from
 * "Entdecken"). Titles without a number ("Rolf Zuckowski – Starke Kinder")
 * are never guessed into a series: that would be the artist, not a series.
 */

/** A folder as the detection needs it. */
export interface SeriesCandidate {
  number: number;
  title: string;
  /** The series the catalog names for the folder, when it knows one. */
  series?: string;
}

export interface FoundSeries {
  /** The series as most folders spell it, e.g. "Die drei ???". */
  name: string;
  /** The name compared without case, spaces and most punctuation. */
  key: string;
  /** Folder numbers, in order. */
  folders: number[];
}

/** A folder counts as a series only from this many folders on (Frank: "mindestens 3 Ordner"). */
export const MIN_SERIES_FOLDERS = 3;

/**
 * A name compared without case and punctuation: "Bibi & Tina" and "bibi und
 * tina" are the same. Question marks stay, they are the name of "Die drei ???".
 */
export function seriesKey(name: string): string {
  return name
    .toLocaleLowerCase('de')
    .replace(/&/g, ' und ')
    .replace(/[^\p{L}\p{N}?]+/gu, ' ')
    .trim();
}

/** An episode number, alone or after "Folge", "Teil" …, between separators. */
const NUMBER = /(^|[\s\-–—:,(/_#.])((?:folge|teil|episode|band|fall|nr\.?|no\.?|vol\.?)\s*)?(\d{1,4})(?=$|[\s\-–—:,)./_!?])/giu;

/** What may stand between the series and its number, cut off the end of the series. */
const TRAIL = /[\s\-–—:,(/_#.]+$/u;

/**
 * The series of a title with an episode number, as written: the text before
 * the first number that has a name in front of it ("5 Freunde 120" → "5
 * Freunde"). Undefined for a title without one.
 */
export function seriesOfTitle(title: string): string | undefined {
  return splitTitle(title)?.series;
}

/** The episode number of a title, the one after its series ("Die drei ??? 012 – …" → 12). */
export function episodeNumber(title: string): number | undefined {
  return splitTitle(title)?.number;
}

/**
 * A name the app or the system gives a folder it knows nothing about
 * („Ordner 03“, „Neuer Ordner 12“, „Folder 7“): never a series (Prüfrunde 1,
 * bastler 17). Packing those would throw strangers' content together.
 */
export function isPlaceholderTitle(title: string): boolean {
  return /^\s*(neuer\s+ordner|ordner|new\s+folder|folder)(\s*(nr\.?|no\.?)?\s*\d{1,3})?\s*$/iu.test(title);
}

function splitTitle(title: string): { series: string; number: number } | undefined {
  if (isPlaceholderTitle(title)) return undefined;
  const t = title.trim();
  for (const m of t.matchAll(NUMBER)) {
    const stem = t.slice(0, (m.index ?? 0) + m[1].length).replace(TRAIL, '').trim();
    // Two words, or one of four letters or more: "Die 3 ??? 012" is no series "Die", "CD 2" none at all.
    const words = stem.split(/\s+/).filter(Boolean).length;
    const letters = (stem.match(/\p{L}/gu) ?? []).length;
    if (letters >= 2 && (words >= 2 || letters >= 4)) return { series: stem, number: Number(m[3]) };
  }
  return undefined;
}

/**
 * The order of the episodes when packing: by the numbers in the titles when
 * they carry them ("Unter meinem Bett 2" before "… 7"; a title without one,
 * like a first episode named just like the series, counts as 1), else by
 * folder number. Folders with the same episode number keep the order of
 * their numbers.
 */
export function episodeOrder(folders: readonly { number: number; title: string }[]): number[] {
  const numbered = folders.map((f) => ({ number: f.number, episode: episodeNumber(f.title) }));
  const any = numbered.some((f) => f.episode !== undefined);
  return numbered.sort((a, b) => (any ? (a.episode ?? 1) - (b.episode ?? 1) : 0) || a.number - b.number).map((f) => f.number);
}

/**
 * The series spread over at least `min` folders, the one with the most
 * folders first (then by its first folder). Each folder belongs to one
 * series at most: the one its catalog names, else the one of its title.
 */
export function findSeries(folders: readonly SeriesCandidate[], min = MIN_SERIES_FOLDERS): FoundSeries[] {
  const groups = new Map<string, { names: Map<string, number>; folders: Set<number> }>();
  const note = (key: string, name: string, n: number) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { names: new Map(), folders: new Set() }));
    g.folders.add(n);
    g.names.set(name, (g.names.get(name) ?? 0) + 1);
  };
  const plain: SeriesCandidate[] = [];
  for (const f of folders) {
    const named = f.series?.trim();
    const stem = named || seriesOfTitle(f.title);
    if (stem && seriesKey(stem)) note(seriesKey(stem), stem, f.number);
    else plain.push(f);
  }
  // A folder titled just like a series found (packed before, or the first episode without a number) joins it.
  for (const f of plain) {
    if (isPlaceholderTitle(f.title)) continue;
    const g = groups.get(seriesKey(f.title));
    if (g) g.folders.add(f.number);
  }
  const out: FoundSeries[] = [];
  for (const [key, g] of groups) {
    if (g.folders.size < min) continue;
    const name = [...g.names].sort((a, b) => b[1] - a[1])[0][0];
    out.push({ name, key, folders: [...g.folders].sort((a, b) => a - b) });
  }
  return out.sort((a, b) => b.folders.length - a.folders.length || a.folders[0] - b.folders[0]);
}
