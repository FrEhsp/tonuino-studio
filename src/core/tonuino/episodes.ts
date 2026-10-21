/**
 * "Mehr als 99 Hörspiele" (extra of the settings page, forum 14858 and
 * 7980): a box plays only 99 folders, so several episodes (Folgen) go into
 * one folder, one after the other, and every episode gets a card of its own
 * that plays only its tracks ("von … bis …", modes 7, 8, 9 and 16).
 *
 * An episode is a run of tracks in a row. The catalog notes the episode's
 * name on each of its tracks (CatalogTrack.episode), so the episodes stay
 * with their files when tracks are deleted or moved; tracks without a noted
 * name are grouped by where they came from ("Entdecken") or by the album in
 * their tags.
 *
 * The limits come from the firmware: TNG plays at most 255 tracks of a
 * folder (maxTracksInFolder in src/constants.hpp, numTracksInFolder is
 * capped at 0xff in tonuino.cpp), the DFPlayer numbers tracks of a folder
 * with one byte, and the card keeps first and last track in one byte each
 * (special, special2). So no episode can start or end after track 255.
 */
import type { CardData, FirmwareProfile } from './card';
import { modeByCode, type ModeInfo } from './modes';
import { MAX_TRACKS } from './sd';

export interface Episode {
  /** Name of the episode, e.g. "Folge 12: Der Schatz im See". */
  title: string;
  /** First and last track number of the folder, both included. */
  first: number;
  last: number;
}

/** What tells the episodes of a folder apart, per track. */
export interface EpisodeTrack {
  number: number;
  /** The name noted in the catalog. Wins over everything else. */
  episode?: string;
  /** The title of the item the track came from in "Entdecken" (FolderOrigin.title). */
  origin?: string;
  /** The album the track's tags name. */
  album?: string;
}

/** A name compared without case and extra spaces. */
function key(name: string | undefined): string | undefined {
  const k = name?.trim().replace(/\s+/g, ' ').toLocaleLowerCase('de');
  return k || undefined;
}

/** "Titel 4 bis 9", or "Titel 4" for one track. */
export function rangeName(first: number, last: number): string {
  return first === last ? `Titel ${first}` : `Titel ${first} bis ${last}`;
}

/**
 * The episodes of a folder, from its tracks: tracks in a row with the same
 * name are one episode. A track's name is the one noted in the catalog, else
 * its origin, else the album of its tags. Tracks without any name in a row
 * are one episode as well; the first of them is named after the folder (it
 * held one album before more were added), any later one after its tracks.
 */
export function detectEpisodes(tracks: readonly EpisodeTrack[], folderTitle?: string): Episode[] {
  const sorted = [...new Map(tracks.map((t) => [t.number, t])).values()].filter((t) => t.number >= 1).sort((a, b) => a.number - b.number);
  const out: (Episode & { named: boolean })[] = [];
  let current: (Episode & { named: boolean; key?: string }) | undefined;
  for (const t of sorted) {
    const name = [t.episode, t.origin, t.album].find((n) => key(n));
    const k = key(name);
    if (current && current.key === k) {
      current.last = t.number;
      continue;
    }
    current = { title: name?.trim().replace(/\s+/g, ' ') ?? '', first: t.number, last: t.number, named: !!k, key: k };
    out.push(current);
  }
  return out.map((e, i) => ({
    title: e.named ? e.title : i === 0 && folderTitle?.trim() ? folderTitle.trim() : rangeName(e.first, e.last),
    first: e.first,
    last: e.last,
  }));
}

/* ------------------------------------------------------------------ editing */

/**
 * Splits episode `index` so a new one starts at track `at` (inside the
 * episode, not its first track). The new one is named after its tracks
 * until it gets a name of its own.
 */
export function splitEpisode(episodes: readonly Episode[], index: number, at: number): Episode[] {
  const e = episodes[index];
  if (!e || at <= e.first || at > e.last) return [...episodes];
  return [...episodes.slice(0, index), { ...e, last: at - 1 }, { title: rangeName(at, e.last), first: at, last: e.last }, ...episodes.slice(index + 1)];
}

/** The track where a split of the episode is most useful: the middle. Undefined for an episode of one track. */
export function splitPoint(e: Episode): number | undefined {
  return e.last > e.first ? e.first + Math.ceil((e.last - e.first) / 2) : undefined;
}

/** Episode `index` joins the one before it, which keeps its name. */
export function mergeWithPrevious(episodes: readonly Episode[], index: number): Episode[] {
  if (index <= 0 || index >= episodes.length) return [...episodes];
  const before = episodes[index - 1];
  return [...episodes.slice(0, index - 1), { ...before, last: episodes[index].last }, ...episodes.slice(index + 1)];
}

/**
 * Episode `index` starts at track `first` instead: the one before ends right
 * before it. Kept between the start of the one before (which keeps at least
 * one track) and the episode's own end.
 */
export function moveStart(episodes: readonly Episode[], index: number, first: number): Episode[] {
  const e = episodes[index];
  const before = episodes[index - 1];
  if (!e || !before || !Number.isFinite(first)) return [...episodes];
  const start = Math.min(e.last, Math.max(before.first + 1, Math.round(first)));
  return episodes.map((x, i) => (i === index - 1 ? { ...x, last: start - 1 } : i === index ? { ...x, first: start } : x));
}

export function renameEpisode(episodes: readonly Episode[], index: number, title: string): Episode[] {
  return episodes.map((e, i) => (i === index ? { ...e, title } : e));
}

/** Two lists that say the same, names compared as typed. */
export function sameEpisodes(a: readonly Episode[], b: readonly Episode[]): boolean {
  return a.length === b.length && a.every((e, i) => e.title === b[i].title && e.first === b[i].first && e.last === b[i].last);
}

/**
 * What keeps the episodes from being saved or written onto cards, in plain
 * German. Two episodes in a row with the same name would be one after
 * saving, since the catalog tells them apart by name.
 */
export function episodeProblems(episodes: readonly Episode[]): string[] {
  const out: string[] = [];
  episodes.forEach((e, i) => {
    const n = i + 1;
    if (!e.title.trim()) out.push(`Folge ${n} hat keinen Namen.`);
    if (e.first < 1 || e.last < e.first) out.push(`Folge ${n} hat keine gültigen Titel.`);
    else if (e.last > MAX_TRACKS) out.push(`Folge ${n} endet bei Titel ${e.last}. Eine Karte kann nur Titel bis ${MAX_TRACKS} spielen.`);
    const before = episodes[i - 1];
    if (before && e.first <= before.last) out.push(`Folge ${n} fängt an, bevor Folge ${i} aufhört.`);
    if (before && key(before.title) && key(before.title) === key(e.title)) out.push(`Folge ${i} und ${n} heißen gleich. Gib ihnen verschiedene Namen, sonst werden sie eine Folge.`);
  });
  return out;
}

/** The name of the episode each track belongs to, by track number. Tracks of no episode are missing. */
export function episodeLabels(episodes: readonly Episode[], numbers: Iterable<number>): Map<number, string> {
  const out = new Map<number, string>();
  for (const n of numbers) {
    const e = episodes.find((x) => n >= x.first && n <= x.last);
    if (e) out.set(n, e.title.trim().replace(/\s+/g, ' '));
  }
  return out;
}

/* ------------------------------------------------------------------ cards */

/**
 * How an episode's card can play it: the "Teil eines Ordners" modes of the
 * box. Album first: it plays the episode from its start, as children expect
 * of a Hörspiel. Hörbuch only with TNG (since 3.3.3); it remembers one place
 * per folder, shared by all episodes of the folder.
 */
export const EPISODE_MODES = [8, 16, 7, 9] as const;

export function episodeModesFor(profile: FirmwareProfile): ModeInfo[] {
  return EPISODE_MODES.flatMap((code) => {
    const m = modeByCode(code);
    return m && m.profiles.includes(profile) ? [m] : [];
  });
}

/**
 * The mode for episode cards that comes closest to how the folder's own card
 * plays: random and party stay so, everything else plays the episode as an
 * album.
 */
export function episodeModeFor(folderMode: number): number {
  if (folderMode === 1 || folderMode === 7) return 7;
  if (folderMode === 3 || folderMode === 9) return 9;
  return 8;
}

/** One card per episode, named after it. */
export function episodeCards(folder: number, episodes: readonly Episode[], mode: number): { data: CardData; label: string }[] {
  return episodes.map((e) => ({ data: { folder, mode, special: e.first, special2: e.last }, label: e.title.trim() || rangeName(e.first, e.last) }));
}

/* ------------------------------------------------------------------ room */

/** Below this many free places the app warns that a folder is nearly full. */
export const ROOM_WARN = 25;

export interface FolderRoom {
  /** Tracks in the folder afterwards. */
  total: number;
  /** Places left afterwards (negative: too many). */
  free: number;
  state: 'ok' | 'near' | 'full' | 'over';
}

/**
 * How full a folder whose last track is `last` gets with `adding` more:
 * "near" below ROOM_WARN free places, "full" at exactly MAX_TRACKS, "over"
 * past it (the box would not play those tracks, and a card cannot name them).
 */
export function folderRoom(last: number, adding = 0): FolderRoom {
  const total = Math.max(0, last) + Math.max(0, adding);
  const free = MAX_TRACKS - total;
  return { total, free, state: free < 0 ? 'over' : free === 0 ? 'full' : free < ROOM_WARN ? 'near' : 'ok' };
}

/**
 * The tracks albums get when they go onto the end of a folder one after the
 * other: the first starts after `last`, the existing tracks keep their
 * numbers. `fits` is false for an album that would end past MAX_TRACKS.
 */
export function appendRanges(last: number, counts: readonly number[]): (Pick<Episode, 'first' | 'last'> & { fits: boolean })[] {
  let next = Math.max(0, last) + 1;
  return counts.map((count) => {
    const first = next;
    const end = first + Math.max(0, count) - 1;
    next = end + 1;
    return { first, last: end, fits: end <= MAX_TRACKS };
  });
}
