/**
 * Folder and album names made fit for a cover search (TODO #133, #134):
 * without what downloads, shops and rips add to a name ("SpotiDownloader.com
 * - ", "(2000-09-05)", "Disc 1", "[Bonus Tracks]", "(Remastered 2009)",
 * " - EP", ".mp3"), so the services find the album and its name compares
 * cleanly with theirs. What such a note said about the kind of album
 * (audio play, reading, soundtrack, karaoke …) is kept apart as its
 * `variant`: "Voll verhext! (Der Original-Soundtrack zum Kinofilm)" is
 * searched as "Voll verhext!", and the soundtrack wins over the audio play
 * of the same name.
 *
 * Pure functions. The rules follow the measurement script of 27.10.2026
 * (recherche/cover-quellen-test, `saeubern`).
 */

import { stripDownloaderNoise } from '../library/tidy';
import { episodeNumbers, normalizeForMatch, type CoverQuery } from '../stickers/coversearch';

export type AlbumVariant = '' | 'hoerspiel' | 'lesung' | 'soundtrack' | 'live' | 'karaoke' | 'instrumental';

/** Words of a note about the edition: they say nothing about which album it is (compared after normalizeForMatch). */
const EDITION_WORDS = new Set([
  'remaster', 'remastered', 'remasters', 'remasterd', 'digitally', 'digital', 'bonus', 'track', 'tracks', 'deluxe', 'edition', 'version',
  'versions', 'expanded', 'anniversary', 'jubilaeum', 'jubilaeumsausgabe', 'jubilaeumsedition', 'explicit', 'clean', 'ep', 'single',
  'mono', 'stereo', 'disc', 'disk', 'cd', 'neuauflage', 'neuaufnahme', 'neuausgabe', 'special', 'collector', 'collectors', 'super',
  'premium', 'limited', 'jahre', 'years', 'vinyl', 'lp', 'album', 'full', 'komplett', 'complete', 'original', 'originale', 'originals',
  'offizielle', 'offizielles', 'official', 'neu', 'new', 'hq', 'hd',
]);
/** Words of a note about the kind of album; also say nothing about which one, but which kind. */
const VARIANT_WORDS: Readonly<Record<string, Exclude<AlbumVariant, ''>>> = {
  hoerspiel: 'hoerspiel',
  hoerspiele: 'hoerspiel',
  hoerspielserie: 'hoerspiel',
  musikhoerspiel: 'hoerspiel',
  hoerbuch: 'lesung',
  hoerbuecher: 'lesung',
  lesung: 'lesung',
  ungekuerzt: 'lesung',
  ungekuerzte: 'lesung',
  gekuerzt: 'lesung',
  gekuerzte: 'lesung',
  autorenlesung: 'lesung',
  soundtrack: 'soundtrack',
  ost: 'soundtrack',
  score: 'soundtrack',
  filmmusik: 'soundtrack',
  kinofilm: 'soundtrack',
  motion: 'soundtrack',
  picture: 'soundtrack',
  musical: 'soundtrack',
  live: 'live',
  karaoke: 'karaoke',
  instrumental: 'instrumental',
  playback: 'instrumental',
};
/** Small words that may stand in such a note: "(Der Original-Soundtrack zum Kinofilm)", "(Music from the Motion Picture)". */
const NOTE_FILLERS = new Set(['der', 'die', 'das', 'zum', 'zur', 'vom', 'von', 'the', 'of', 'from', 'a', 'an', 'and', 'und', 'mit', 'music', 'musik', 'aus', 'dem', 'den', 'to', 'film', 'movie']);

const YEAR = /^(?:19|20)\d\d$/;
const ORDINAL = /^\d+(?:st|nd|rd|th|te|ten)$/;

function noteWord(w: string): boolean {
  return EDITION_WORDS.has(w) || w in VARIANT_WORDS || NOTE_FILLERS.has(w) || YEAR.test(w) || ORDINAL.test(w);
}

/** A piece of a name that only says which edition or kind it is ("Remastered 2009", "Ungekürzte Lesung", "EP"). */
function isNote(piece: string): boolean {
  const words = normalizeForMatch(piece).split(' ').filter(Boolean);
  return words.length > 0 && words.every(noteWord) && words.some((w) => !NOTE_FILLERS.has(w));
}

/** A later piece of a name that tells the kind with other words: "Die Mini Hörspielserie für ganz Kleine". */
function tellsKind(piece: string): boolean {
  return normalizeForMatch(piece)
    .split(' ')
    .some((w) => VARIANT_WORDS[w] === 'hoerspiel' || VARIANT_WORDS[w] === 'lesung' || VARIANT_WORDS[w] === 'soundtrack');
}

const FILE_EXTENSION = /\.(?:mp3|m4a|m4b|mp4|aac|flac|ogg|oga|opus|wav|wma|aiff?)$/i;
const LEADING_DATE = /^\s*(?:[([]\d{4}(?:-\d{2}){0,2}[)\]]|\d{4}-\d{2}-\d{2})\s*(?:[-–—]\s*)?/;
const DISC = /\s*[([]?\b(?:disc|disk|cd)\s*\d{1,2}\b(?:\s*(?:of|von|\/)\s*\d{1,2})?[)\]]?/gi;
const BRACKETS = /\s*[([{]([^()[\]{}]*)[)\]}]/g;

/** The kind of album a name says it is, from its notes and words. */
export function variantOf(name: string): AlbumVariant {
  const words = normalizeForMatch(name).split(' ');
  const found = new Set(words.map((w) => VARIANT_WORDS[w]).filter(Boolean));
  // "Das Original-Hörspiel zum Kinofilm" is an audio play, "Der Original-Soundtrack zum Kinofilm" music.
  for (const v of ['karaoke', 'instrumental', 'hoerspiel', 'lesung', 'soundtrack', 'live'] as const) if (found.has(v)) return v;
  return '';
}

/** Two albums of these kinds can be the same: the same kind, or one of them does not say. */
export function variantsFit(a: AlbumVariant, b: AlbumVariant): boolean {
  return !a || !b || a === b;
}

/**
 * A name as a search finds it: no downloader, no date in front, no disc
 * number, no file ending, no notes about the edition or the kind. Keeps
 * "(Folge 50)" and other brackets with a name in them. Never empty when the
 * name was not.
 */
export function cleanForSearch(name: string): string {
  let t = stripDownloaderNoise(name.normalize('NFC')).replace(FILE_EXTENSION, '').replace(/_/g, ' ');
  t = t.replace(LEADING_DATE, '');
  t = t.replace(DISC, ' ');
  t = t.replace(BRACKETS, (all, inner: string) => (isNote(inner) ? ' ' : all));
  const pieces = t
    .split(/\s+[-–—]+\s+|\s+[-–—]+$/)
    .map((p) => p.trim())
    .filter(Boolean);
  const keep = pieces.filter((p, i) => !isNote(p) && !(i > 0 && pieces.length > 1 && tellsKind(p) && !/\d/.test(p)));
  const out = (keep.length ? keep : pieces)
    .join(' - ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.:;)\]])/g, '$1')
    .replace(/^[\s,:;/|–—-]+|[\s,:;/|–—-]+$/g, '')
    .trim();
  return out || name.trim();
}

/** Artist tags that name no one. */
const NO_ARTIST = /^(?:various(?: artists)?|va|diverse(?: interpreten)?|verschiedene(?: interpreten)?|unbekannt|unknown(?: artist)?|interpret|artist)$/i;

/** The artist as a search may use it, or undefined for tags that name no one. */
export function cleanArtist(artist: string | undefined): string | undefined {
  const a = stripDownloaderNoise((artist ?? '').normalize('NFC')).replace(/\s+/g, ' ').trim();
  return a && !NO_ARTIST.test(a) ? a : undefined;
}

/** True for "Various Artists" and the like: a compilation, whose title has to do the work. */
export function isVariousArtists(artist: string | undefined): boolean {
  const a = (artist ?? '').trim();
  return !a || NO_ARTIST.test(a);
}

/** Words of a hit that make it something else than the album itself. */
const DOUBTFUL = /\b(?:karaoke|tribute|cover version|covers?|made famous|in the style of|originally performed|instrumental(?:s)?|playback|remix(?:es)?|lullaby|sped up|slowed|8 bit|klavierversion|spieluhr|hoerprobe|leseprobe|reaction|sampler)\b/;

/** True when the hit is a karaoke, tribute, remix … version and the name did not ask for one. */
export function isDoubtfulVersion(hit: string, asked: string): boolean {
  const h = normalizeForMatch(hit);
  const m = DOUBTFUL.exec(h);
  return !!m && !normalizeForMatch(asked).includes(m[0]);
}

export interface PreparedQuery {
  /** What iTunes and Deezer get: artist (when not in the name) and the cleaned name. */
  text: string;
  /** The cleaned album name, without the artist. */
  album: string;
  artist?: string;
  /** What the name says about the kind of album. */
  variant: AlbumVariant;
  /** Episode-like numbers of the name ("Folge 12", "Unter meinem Bett 3"). */
  episodes: number[];
  /** The name as given, all parts. */
  raw: string;
}

/** True when every word of `inner` appears as a word in `outer` (normalised). */
function containsWords(outer: string, inner: string): boolean {
  const o = ` ${normalizeForMatch(outer)} `;
  const i = normalizeForMatch(inner);
  return !!i && o.includes(` ${i} `);
}

/** The parts of a query, cleaned, as the services get them. */
export function prepareQuery(q: CoverQuery): PreparedQuery {
  const raw = [q.artist, q.album, q.title, q.query]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' ');
  const names = [q.album, q.title, q.query].map((s) => (s ?? '').trim()).filter(Boolean);
  const album = names
    .map(cleanForSearch)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const artist = cleanArtist(q.artist);
  const lead = artist && !containsWords(album, artist) ? artist : undefined;
  return {
    text: [lead, album].filter(Boolean).join(' ').slice(0, 200),
    album,
    artist,
    variant: variantOf(names.join(' ')),
    episodes: episodeNumbers(album),
    raw,
  };
}
