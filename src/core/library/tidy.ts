/**
 * Tidies names from tags and catalogs: downloader web sites in front of or
 * behind album and track names ("SpotiDownloader.com - …"), an artist that
 * is really the title of one track, Title Case that a downloader put on
 * every word ("Igel Sucht Den Mond"). Pure functions, used when importing
 * (Hinzufügen) and when showing folders that are on the card already.
 */
import { normalizeForMatch } from '../stickers/coversearch';

/** Endings of web addresses that downloaders put into tags. Not ".de": German shops and artists use it in real names. */
const TLD = '(?:com|net|org|io|is|to|cc|me|app|co|ws|xyz|tv|biz|info|online|site|live|pro|la|lol|nu|vip|mobi|top|cx|ch)';
/** "SpotiDownloader.com", "www.y2mate.is", "MP3Juices.cc". */
const DOMAIN = `(?:www\\.)?[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.${TLD}`;
/** Downloaders that also sign without the ending: "SpotiDownloader - …", "[SpotifyDown]". */
const NAMED = '(?:spoti(?:fy)?[ -]?(?:song)?[ -]?down(?:loader)?|spotifymate|y2mate|ytmp3|mp3juices?|savefrom|yt2mp3)';
const SITE = `(?:${DOMAIN}|${NAMED})`;
const SEP = '[-–—_|:~•]';

const PREFIX = new RegExp(`^\\s*(?:[\\[(]\\s*${SITE}\\s*[\\])]\\s*(?:${SEP}+\\s*)?|${SITE}\\s*${SEP}+\\s*)`, 'i');
const SUFFIX = new RegExp(`\\s*(?:(?:${SEP}+\\s*)?[\\[(]\\s*${SITE}\\s*[\\])]|${SEP}+\\s*${SITE})\\s*$`, 'i');

/** Takes downloader web sites off the front and the end of a name. Keeps the name when nothing else is left. */
export function stripDownloaderNoise(s: string): string {
  let t = s;
  for (let i = 0; i < 3; i++) {
    const next = t.replace(PREFIX, '').replace(SUFFIX, '');
    if (next === t) break;
    t = next;
  }
  t = t.replace(/\s+/g, ' ').trim();
  return t || s.trim();
}

/** stripDownloaderNoise for a name that may be missing; empty stays missing. */
export function tidyName(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const t = stripDownloaderNoise(s);
  return t ? t : undefined;
}

/**
 * Small German words that stand in lower case inside a title. When one of
 * them starts with a capital letter in the middle of a name in which every
 * word does, someone capitalised every word ("Igel Sucht Den Mond"). English
 * titles are left alone: there every word may start with a capital letter.
 */
const SMALL_WORDS = new Set([
  'den', 'dem', 'der', 'des', 'und', 'oder', 'mit', 'von', 'vom', 'im', 'am', 'auf', 'aus', 'bei', 'für', 'zum', 'zur', 'zu', 'ist',
  'sind', 'ein', 'eine', 'einen', 'einem', 'einer', 'nicht', 'nach', 'über', 'unter', 'wie', 'sich', 'auch', 'noch', 'schon', 'ins', 'ans',
  'beim', 'durch', 'gegen', 'ohne', 'um', 'hat', 'kann', 'wird',
]);

/** True when every word starts with a capital letter, small German words in the middle too. */
export function looksBrokenTitleCase(s: string): boolean {
  const words = s.split(/[\s\-–—/,.:;!?()"„“]+/).filter((w) => /^\p{L}/u.test(w));
  if (words.length < 3) return false;
  if (!words.every((w) => /^\p{Lu}/u.test(w))) return false;
  // "UNTER MEINEM BETT" is shouting, not Title Case.
  if (words.every((w) => w === w.toUpperCase())) return false;
  return words.slice(1).some((w) => SMALL_WORDS.has(w.toLowerCase()));
}

/**
 * The spelling of a shop or database for the same name: only when both say
 * the same apart from capital letters and punctuation, and ours is broken
 * (Title Case everywhere, all capitals or all small letters).
 */
export function recase(ours: string, theirs: string | undefined): string {
  if (!theirs) return ours;
  if (normalizeForMatch(ours) !== normalizeForMatch(theirs)) return ours;
  const broken = looksBrokenTitleCase(ours) || (/\p{L}{3}/u.test(ours) && (ours === ours.toUpperCase() || ours === ours.toLowerCase()));
  return broken && theirs !== ours ? theirs.trim() : ours;
}

/* ------------------------------------------------------------ artist */

export interface TrackNames {
  title?: string;
  artist?: string;
  albumArtist?: string;
}

const NO_ARTIST = /^(?:various(?: artists)?|va|diverse(?: interpreten)?|verschiedene(?: interpreten)?|unbekannt|unknown(?: artist)?|interpret|artist)$/i;
/** Placeholders that are never an artist. "Verschiedene Interpreten" as album artist is a sampler's, so it stays there. */
const UNKNOWN = /^(?:unbekannt|unknown(?: artist)?|interpret|artist)$/i;

function counts(values: (string | undefined)[]): { value?: string; count: number; present: number } {
  const map = new Map<string, { value: string; count: number }>();
  let present = 0;
  for (const v of values) {
    if (!v) continue;
    present++;
    const key = normalizeForMatch(v);
    const e = map.get(key);
    if (e) e.count++;
    else map.set(key, { value: v, count: 1 });
  }
  let best: { value: string; count: number } | undefined;
  for (const e of map.values()) if (!best || e.count > best.count) best = e;
  return { value: best?.value, count: best?.count ?? 0, present };
}

/**
 * The artist of an album: the album artist (TPE2) most tracks name (also
 * "Verschiedene Interpreten" of a sampler), else the
 * artist more than half of the tracks name. Never the title of a track: some
 * downloaders put each song's title into its artist field, and the artist of
 * track 1 alone says nothing. Undefined when the tracks do not agree.
 */
export function pickArtist(tracks: readonly TrackNames[]): string | undefined {
  const n = tracks.length;
  if (!n) return undefined;
  const titles = new Set(tracks.map((t) => tidyName(t.title)).filter((t): t is string => !!t).map(normalizeForMatch));
  const usable = (v: string | undefined, none = NO_ARTIST) => !!v && !none.test(v) && !titles.has(normalizeForMatch(v));
  const album = counts(tracks.map((t) => tidyName(t.albumArtist)));
  if (album.value && usable(album.value, UNKNOWN) && album.count * 2 >= album.present) return album.value;
  const artist = counts(tracks.map((t) => tidyName(t.artist)));
  if (!artist.value || !usable(artist.value)) return undefined;
  // One track: its artist, unless it is its title. More: a clear majority.
  if (n === 1 || artist.count * 2 > n) return artist.value;
  return undefined;
}

/**
 * Titles for tracks without a title tag, when the artist field holds them:
 * most tracks have no title, and their artists are all different (an album
 * has one artist, not one per track). Undefined where the guess does not hold.
 */
export function titlesFromArtistField(tracks: readonly TrackNames[]): (string | undefined)[] | undefined {
  const n = tracks.length;
  if (n < 3) return undefined;
  const untitled = tracks.filter((t) => !tidyName(t.title)).length;
  if (untitled * 5 < n * 4) return undefined;
  const artists = tracks.map((t) => tidyName(t.artist));
  const present = artists.filter((a): a is string => !!a);
  if (present.length * 5 < n * 4) return undefined;
  if (new Set(present.map(normalizeForMatch)).size !== present.length) return undefined;
  return tracks.map((t, i) => (tidyName(t.title) ? undefined : artists[i]));
}

/* ------------------------------------------------------------ catalog folders */

/** What tidyFolder looks at and changes: a catalog folder's names. */
export interface FolderNames {
  title: string;
  artist?: string;
  tracks: { title?: string }[];
}

/**
 * A folder's names without downloader noise, and without an artist that is
 * one of its own track titles. Returns the same object when nothing changes.
 */
export function tidyFolder<T extends FolderNames>(entry: T): T {
  const title = stripDownloaderNoise(entry.title);
  let artist = tidyName(entry.artist);
  const trackTitles = entry.tracks.map((t) => tidyName(t.title));
  if (artist && entry.tracks.length > 1 && trackTitles.some((t) => t && normalizeForMatch(t) === normalizeForMatch(artist!))) artist = undefined;
  const tracksChanged = trackTitles.some((t, i) => t !== entry.tracks[i].title);
  if (title === entry.title && artist === entry.artist && !tracksChanged) return entry;
  return {
    ...entry,
    title,
    artist,
    tracks: tracksChanged ? entry.tracks.map((t, i) => ({ ...t, title: trackTitles[i] })) : entry.tracks,
  };
}

/**
 * The artist a folder on the card shows, checked against the tags of its
 * files: an artist that only track 1 names (its song title, put there by a
 * downloader) gives way to the album artist or the majority of the tracks.
 */
export function checkedArtist(artist: string | undefined, tags: readonly TrackNames[]): string | undefined {
  const own = tidyName(artist);
  if (tags.length < 2) return own;
  const picked = pickArtist(tags);
  if (!own) return picked;
  if (picked && normalizeForMatch(picked) === normalizeForMatch(own)) return own;
  // An artist no track names was typed by hand: it stays. One that is a track's title goes.
  const key = normalizeForMatch(own);
  const naming = tags.filter((t) => [t.albumArtist, t.artist].some((a) => normalizeForMatch(tidyName(a) ?? '') === key)).length;
  if (tags.some((t) => normalizeForMatch(tidyName(t.title) ?? '') === key)) return picked;
  if (!naming) return own;
  // Only track 1 named it, and every track names another one: a downloader's titles (0.2 took track 1's).
  const named = tags.map((t) => tidyName(t.albumArtist) ?? tidyName(t.artist)).filter((a): a is string => !!a);
  if (tags.length >= 3 && naming === 1 && new Set(named.map(normalizeForMatch)).size === named.length) return picked;
  // The tracks agree on another one (album artist, or most of them), and few name ours.
  if (picked && naming * 2 <= tags.length) return picked;
  return own;
}

/** "03", "Track 7", "Titel 3", "Kapitel 12": a number, no name. */
export function isNamelessTitle(title: string | undefined): boolean {
  const t = title?.trim() ?? '';
  return !t || /^\d+$/.test(t) || /^(?:track|titel|title|kapitel|chapter|teil|part)[\s_-]*\d+$/i.test(t);
}
