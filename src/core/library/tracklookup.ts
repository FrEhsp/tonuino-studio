/**
 * Track names for an album whose files carry none: the track list of the
 * same album at iTunes or MusicBrainz, taken only when it has as many tracks
 * as the folder and their lengths fit (a few seconds apart). The shop's
 * spelling also repairs broken Title Case of the album ("Igel Sucht Den
 * Mond"). Asks the internet only when called, i.e. when someone clicks.
 *
 * A whole album in one file (lookupWholeAlbum) has no count to compare:
 * there the track lengths must add up to the file's length.
 */
import { gates, serviceJson, type Limiter } from '../covers/net';
import type { FetchLike } from '../stickers/image';
import { compareRelease, parseReleaseName, releaseSearchText } from './releasename';
import { stripDownloaderNoise } from './tidy';

export interface LookupTrack {
  title: string;
  /** Seconds, when the shop tells. */
  durationSec?: number;
}

export interface LookupAlbum {
  source: 'iTunes' | 'MusicBrainz';
  album: string;
  artist?: string;
  tracks: LookupTrack[];
  /**
   * What the shop files it under: iTunes' genre ("Hörspiele", "Kindermusik"),
   * MusicBrainz' kind of release ("Audio drama", "Audiobook") or genre.
   */
  genre?: string;
}

export interface TrackLookupOptions {
  fetchFn: FetchLike;
  signal?: AbortSignal;
  /**
   * Turns for the requests; unless given, the app's shared queues of
   * iTunes and MusicBrainz (one request a second there), the same ones the
   * cover search uses. Tests give one that never waits.
   */
  rateLimiter?: Limiter;
  timeoutMs?: number;
  /** How often a busy answer (503, 429) is asked again, default 2. */
  retries?: number;
}

/** What the folder knows: its name, maybe the artist, and the length of each track (undefined where unknown). */
export interface LookupQuery {
  album: string;
  artist?: string;
  durations: (number | undefined)[];
}

/** Lengths may differ by this much per track (other masters, silence cut, rounding). */
const TRACK_TOLERANCE_SEC = 6;

/**
 * True when a shop's track list belongs to the folder: the same number of
 * tracks, and where both know the lengths, at least four in five within a
 * few seconds and the middle difference small. Without any lengths, the
 * count and the name must do.
 */
export function tracksFit(ours: readonly (number | undefined)[], theirs: readonly LookupTrack[]): boolean {
  if (!ours.length || ours.length !== theirs.length) return false;
  const diffs: number[] = [];
  ours.forEach((d, i) => {
    const t = theirs[i].durationSec;
    if (d !== undefined && t !== undefined) diffs.push(Math.abs(d - t));
  });
  if (!diffs.length) return true;
  // Lengths known for only a few tracks prove little: then most of them have to be known.
  if (diffs.length * 2 < ours.length) return false;
  diffs.sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)];
  const close = diffs.filter((x) => x <= TRACK_TOLERANCE_SEC).length;
  return median <= 3 && close * 5 >= diffs.length * 4;
}

/**
 * True when a shop's album name is the folder's, apart from spelling,
 * edition notes and download leftovers, also with series, episode number and
 * title in another order ("Das Kürbisfest (Folge 50)" by "Bibi & Tina" and
 * "Folge 50: Das Kürbisfest" by "Bibi und Tina"; compareRelease).
 */
export function sameAlbum(ours: string, theirs: string, artists: { ours?: string; theirs?: string } = {}): boolean {
  return compareRelease({ album: ours, artist: artists.ours }, { album: theirs, artist: artists.theirs }).same;
}

function searchText(q: Pick<LookupQuery, 'album' | 'artist'>): string {
  return releaseSearchText(q.album, q.artist);
}

/**
 * Looks for the folder's album at iTunes, then at MusicBrainz, and returns
 * the first whose name and track list fit. Null when none does. Network
 * errors of one service let the other try; when both fail, the error of the
 * last one is thrown.
 */
export async function lookupAlbumTracks(q: LookupQuery, opts: TrackLookupOptions): Promise<LookupAlbum | null> {
  if (!stripDownloaderNoise(q.album).trim() || !q.durations.length) return null;
  return searchBoth(wantedFor(q), opts);
}

/**
 * A whole album in one file: looks for the album by name, whatever its
 * number of tracks, and takes the one whose track lengths add up to the
 * file's length best (wholeAlbumMisfit). iTunes first; MusicBrainz too when
 * iTunes has nothing within a percent. Errors as lookupAlbumTracks.
 */
export async function lookupWholeAlbum(q: { album: string; artist?: string; totalSec: number }, opts: TrackLookupOptions): Promise<LookupAlbum | null> {
  if (!stripDownloaderNoise(q.album).trim() || !(q.totalSec > 0)) return null;
  return searchBoth({ album: q.album, artist: q.artist, misfit: (tracks, sure) => wholeAlbumMisfit(q.totalSec, tracks, sure), good: (m) => m <= wholeTolerance(q.totalSec, false) }, opts);
}

/**
 * The whole file may be this much longer or shorter than the tracks together: a fraction of its length, within these bounds.
 * `loose` when the name leaves no doubt (the episode number agrees, or the album was chosen by its cover): a version from
 * a video site may have a few seconds more at both ends, and the cuts are moved into the pauses anyway.
 */
const WHOLE_TOLERANCE = { strict: { ratio: 0.01, minSec: 4, maxSec: 20 }, loose: { ratio: 0.025, minSec: 6, maxSec: 60 } };

/** Seconds the tracks together may differ from a file of `totalSec`. */
export function wholeTolerance(totalSec: number, loose: boolean): number {
  const t = loose ? WHOLE_TOLERANCE.loose : WHOLE_TOLERANCE.strict;
  return Math.min(t.maxSec, Math.max(t.minSec, totalSec * t.ratio));
}

/** The length of a shop's track list together, when every length is known. */
export function tracksTotal(tracks: readonly LookupTrack[]): number | undefined {
  let sum = 0;
  for (const t of tracks) {
    if (t.durationSec === undefined || !(t.durationSec > 0)) return undefined;
    sum += t.durationSec;
  }
  return sum;
}

/**
 * A part of a shop's track list that may be all the file holds: the whole
 * list, or the list without its first piece (an intro or title song a
 * version from a video site leaves out, TODO 0.3 #129), without its last
 * (an outro), or without both. `from` and `to` (exclusive) index the list;
 * `misfit` is how many seconds their lengths together are off the file's.
 */
export interface WholeAlbumPart {
  from: number;
  to: number;
  misfit: number;
}

/** A piece left out is short (an intro, a title song, credits): at most this long, and a quarter of the list. */
export const DROPPABLE_MAX_SEC = 300;

/** A list fitting only without a piece counts this much worse (seconds of misfit per piece) when shop albums are compared. */
const DROP_PENALTY_SEC = 5;

/**
 * The parts of a shop's list (WholeAlbumPart) whose lengths add up to the
 * file's, best fitting first: at least two tracks, every length known, the
 * sum within about a percent (4 to 20 seconds; rips differ in the silence at
 * both ends and between tracks), or 2.5 % (at most a minute) when `loose`.
 */
export function wholeAlbumParts(totalSec: number, tracks: readonly LookupTrack[], loose = false): WholeAlbumPart[] {
  const sum = tracksTotal(tracks);
  if (!(totalSec > 0) || tracks.length < 2 || sum === undefined) return [];
  const tolerance = wholeTolerance(totalSec, loose);
  const n = tracks.length;
  const droppable = (i: number) => tracks[i].durationSec! <= Math.min(DROPPABLE_MAX_SEC, sum / 4);
  const out: WholeAlbumPart[] = [];
  for (const [from, to] of [
    [0, n],
    [1, n],
    [0, n - 1],
    [1, n - 1],
  ]) {
    if (to - from < 2 || (from > 0 && !droppable(0)) || (to < n && !droppable(n - 1))) continue;
    let part = 0;
    for (let i = from; i < to; i++) part += tracks[i].durationSec!;
    const misfit = Math.abs(part - totalSec);
    if (misfit <= tolerance) out.push({ from, to, misfit });
  }
  return out.sort((a, b) => a.misfit - b.misfit);
}

/**
 * How many seconds a shop's track list is off the file's length, when it
 * fits (wholeAlbumParts): the best part, a part without a piece a little
 * worse than the whole list. Undefined when no part fits.
 */
export function wholeAlbumMisfit(totalSec: number, tracks: readonly LookupTrack[], loose = false): number | undefined {
  let best: number | undefined;
  for (const p of wholeAlbumParts(totalSec, tracks, loose)) {
    const m = p.misfit + DROP_PENALTY_SEC * (p.from + tracks.length - p.to);
    if (best === undefined || m < best) best = m;
  }
  return best;
}

/** True when a shop's track list adds up to the file's length (wholeAlbumMisfit). */
export function wholeAlbumFits(totalSec: number, tracks: readonly LookupTrack[], loose = false): boolean {
  return wholeAlbumMisfit(totalSec, tracks, loose) !== undefined;
}

/** A track list that fits, and how far it is off (0 for a folder's tracks that fit). */
interface Fitting {
  album: LookupAlbum;
  misfit: number;
}

function better(a: Fitting | null, b: Fitting | null): Fitting | null {
  if (!a) return b;
  if (!b) return a;
  return b.misfit < a.misfit ? b : a;
}

async function searchBoth(q: Wanted, opts: TrackLookupOptions): Promise<LookupAlbum | null> {
  let failure: unknown;
  let answered = false;
  let best: Fitting | null = null;
  for (const search of [searchItunes, searchMusicBrainz]) {
    try {
      best = better(best, await search(q, opts));
      answered = true;
      // Good enough: no need to ask the next service (it is slow: one request per second).
      if (best && (!q.good || q.good(best.misfit))) return best.album;
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      failure = e;
    }
  }
  if (!answered && failure) throw failure;
  return best?.album ?? null;
}

/**
 * The album whose cover was chosen in an online search (CoverSearch), when
 * its track list adds up to the file's length: someone picked that album by
 * its picture, so the name needs no checking and the length a little less.
 * `id` is the cover's ("itunes:<collection>" or "musicbrainz:<release
 * group>"); `edition` a single MusicBrainz release (a cassette's cover).
 */
export async function lookupCoverAlbum(hit: { id: string; edition?: string }, totalSec: number, opts: TrackLookupOptions): Promise<LookupAlbum | null> {
  if (!(totalSec > 0)) return null;
  const [service, id] = [hit.id.slice(0, hit.id.indexOf(':')), hit.id.slice(hit.id.indexOf(':') + 1)];
  const fit = (album: LookupAlbum | null): Fitting | null => {
    const misfit = album ? wholeAlbumMisfit(totalSec, album.tracks, true) : undefined;
    return album && misfit !== undefined ? { album, misfit } : null;
  };
  if (service === 'itunes' && /^\d+$/.test(id)) {
    let best: Fitting | null = null;
    for (const album of await lookupItunes([id], opts)) best = better(best, fit(album));
    return best?.album ?? null;
  }
  if (service !== 'musicbrainz' || !id) return null;
  let ids = [hit.edition ?? ''].filter(Boolean);
  if (!ids.length) {
    const json = (await getJson(`https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(`rgid:${id.replace(/[^0-9a-f-]/gi, '')}`)}&fmt=json&limit=10`, opts)) as { releases?: MbRelease[] };
    ids = (json.releases ?? []).map((r) => r.id).filter((x): x is string => !!x);
  }
  let best: Fitting | null = null;
  for (const rid of ids.slice(0, 3)) {
    best = better(best, fit(await lookupMusicBrainz(rid, opts)));
    if (best && best.misfit <= wholeTolerance(totalSec, false)) break;
  }
  return best?.album ?? null;
}

/* ------------------------------------------------------------ iTunes */

interface ItunesItem {
  wrapperType?: string;
  kind?: string;
  collectionId?: number;
  collectionName?: string;
  artistName?: string;
  trackCount?: number;
  trackName?: string;
  trackTimeMillis?: number;
  trackNumber?: number;
  discNumber?: number;
  primaryGenreName?: string;
}

/** What a search looks for: an album of this name, maybe with this many tracks, whose track list passes `misfit`. */
interface Wanted {
  album: string;
  artist?: string;
  /** Number of tracks, when known. */
  count?: number;
  /** How far a track list is off, smaller is better; undefined when it does not fit. `sure`: the name leaves no doubt. */
  misfit: (tracks: readonly LookupTrack[], sure: boolean) => number | undefined;
  /** A misfit this small ends the search; without it, the first that fits does. */
  good?: (misfit: number) => boolean;
}

function wantedFor(q: LookupQuery): Wanted {
  return { album: q.album, artist: q.artist, count: q.durations.length, misfit: (tracks) => (tracksFit(q.durations, tracks) ? 0 : undefined) };
}

/** Albums of the same name looked at per service: one request at iTunes, one a second at MusicBrainz. */
const ITUNES_CANDIDATES = 6;
const MUSICBRAINZ_CANDIDATES = 3;

async function searchItunes(q: Wanted, opts: TrackLookupOptions): Promise<Fitting | null> {
  const params = new URLSearchParams({ term: searchText(q), entity: 'album', limit: '25', country: 'DE' });
  const found = itunesResults(await getJson(`https://itunes.apple.com/search?${params}`, opts));
  const sure = new Map<number, boolean>();
  for (const r of found) {
    if (!r.collectionId || !r.collectionName || sure.has(r.collectionId) || (q.count !== undefined && r.trackCount !== q.count)) continue;
    const m = compareRelease({ album: q.album, artist: q.artist }, { album: r.collectionName, artist: r.artistName });
    if (m.same) sure.set(r.collectionId, m.strong);
  }
  const ids = [...sure.keys()].slice(0, q.count === undefined ? ITUNES_CANDIDATES : 3);
  if (!ids.length) return null;
  let best: Fitting | null = null;
  // Several albums in one request; then the one whose lengths fit best (another edition, a box, a live album do not).
  for (const album of await lookupItunes(ids.map(String), opts)) {
    const misfit = q.misfit(album.tracks, sure.get(Number(album.id)) ?? false);
    if (misfit === undefined) continue;
    best = better(best, { album: withoutId(album), misfit });
    if (!q.good && best) break;
  }
  return best;
}

/** iTunes' lookup of albums by id with their songs: one request for several albums, in the order asked. */
async function lookupItunes(ids: readonly string[], opts: TrackLookupOptions): Promise<(LookupAlbum & { id?: string })[]> {
  const lookup = new URLSearchParams({ id: ids.join(','), entity: 'song', country: 'DE' });
  const albums = parseItunesAlbums(await getJson(`https://itunes.apple.com/lookup?${lookup}`, opts));
  const order = (a: { id?: string }) => (ids.indexOf(a.id ?? '') + ids.length + 1) % (ids.length + 1);
  return albums.sort((a, b) => order(a) - order(b));
}

function withoutId<T extends { id?: string }>(a: T): Omit<T, 'id'> {
  const { id: _id, ...rest } = a;
  return rest;
}

function itunesResults(json: unknown): ItunesItem[] {
  if (typeof json !== 'object' || json === null || !Array.isArray((json as { results?: unknown }).results)) throw new Error('unexpected response');
  return ((json as { results: unknown[] }).results ?? []).filter((r): r is ItunesItem => typeof r === 'object' && r !== null);
}

/** The answer of iTunes' lookup with entity=song: the album first, then its songs. */
export function parseItunesTracks(json: unknown): LookupAlbum | null {
  const first = parseItunesAlbums(json)[0];
  return first ? withoutId(first) : null;
}

/**
 * The answer of iTunes' lookup of several albums with entity=song: each
 * album with its songs (by collectionId; an answer without ids is one album).
 */
export function parseItunesAlbums(json: unknown): (LookupAlbum & { id?: string })[] {
  const items = itunesResults(json);
  const albums = items.filter((r) => r.wrapperType === 'collection' && r.collectionName);
  return albums.flatMap((album) => {
    const songs = items
      .filter((r) => r.wrapperType === 'track' && typeof r.trackName === 'string' && (albums.length === 1 || r.collectionId === album.collectionId))
      .sort((a, b) => (a.discNumber ?? 1) - (b.discNumber ?? 1) || (a.trackNumber ?? 0) - (b.trackNumber ?? 0));
    if (!songs.length) return [];
    return [
      {
        id: album.collectionId === undefined ? undefined : String(album.collectionId),
        source: 'iTunes' as const,
        album: album.collectionName!,
        artist: album.artistName,
        genre: album.primaryGenreName,
        tracks: songs.map((s) => ({ title: s.trackName!.trim(), durationSec: s.trackTimeMillis ? s.trackTimeMillis / 1000 : undefined })),
      },
    ];
  });
}

/* ------------------------------------------------------------ MusicBrainz */

interface MbRelease {
  id?: string;
  title?: string;
  'track-count'?: number;
  'artist-credit'?: { name?: string; joinphrase?: string }[];
  'release-group'?: { 'primary-type'?: string; 'secondary-types'?: string[]; genres?: { name?: string; count?: number }[] };
  genres?: { name?: string; count?: number }[];
  media?: { position?: number; tracks?: { position?: number; title?: string; length?: number | null }[] }[];
}

/** Words only, lower case (so "AND"/"OR" in a name are no operators), no Lucene syntax, without articles. */
function luceneWords(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w && !/^(?:der|die|das|den|dem|des|ein|eine|und|the|a|an|and|or|not)$/.test(w))
    .join(' ');
}

/**
 * The MusicBrainz query for a name: the title as a phrase or its words (a
 * shop's "Folge 50: Das Kürbisfest" holds "Das Kürbisfest"), and the series
 * or artist. The number is left to the check of the names afterwards.
 */
export function musicBrainzQuery(q: { album: string; artist?: string; count?: number }): string {
  const parsed = parseReleaseName(q.album, q.artist);
  const title = parsed.title || (parsed.episode !== undefined ? `Folge ${parsed.episode}` : parsed.clean);
  const phrase = title.replace(/["\\]/g, ' ').trim();
  const loose = luceneWords(title);
  const release = loose && loose !== phrase.toLowerCase() ? `(release:"${phrase}"^3 OR release:(${loose}))` : `release:"${phrase}"`;
  const series = parsed.series ? luceneWords(parsed.series) : '';
  return [release, series ? `artist:(${series})` : '', q.count === undefined ? '' : `tracks:${q.count}`].filter(Boolean).join(' AND ');
}

async function searchMusicBrainz(q: Wanted, opts: TrackLookupOptions): Promise<Fitting | null> {
  const json = (await getJson(`https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(musicBrainzQuery(q))}&fmt=json&limit=15`, opts)) as { releases?: MbRelease[] };
  const releases = (json.releases ?? []).flatMap((r) => {
    if (!r.id || !r.title || (q.count !== undefined && r['track-count'] !== q.count)) return [];
    const m = compareRelease({ album: q.album, artist: q.artist }, { album: r.title, artist: creditOf(r) });
    return m.same ? [{ id: r.id, sure: m.strong }] : [];
  });
  let best: Fitting | null = null;
  for (const r of releases.slice(0, MUSICBRAINZ_CANDIDATES)) {
    const album = await lookupMusicBrainz(r.id, opts);
    const misfit = album ? q.misfit(album.tracks, r.sure) : undefined;
    if (!album || misfit === undefined) continue;
    best = better(best, { album, misfit });
    if (!q.good || q.good(misfit)) break;
  }
  return best;
}

async function lookupMusicBrainz(id: string, opts: TrackLookupOptions): Promise<LookupAlbum | null> {
  return parseMusicBrainzTracks(await getJson(`https://musicbrainz.org/ws/2/release/${encodeURIComponent(id)}?inc=recordings+artist-credits+release-groups+genres&fmt=json`, opts));
}

function creditOf(r: MbRelease): string | undefined {
  return (r['artist-credit'] ?? []).map((c) => `${c.name ?? ''}${c.joinphrase ?? ''}`).join('').trim() || undefined;
}

/** "Audio drama" or "Audiobook" when MusicBrainz says so, else the genre most people gave it. */
function genreOf(r: MbRelease): string | undefined {
  const types = r['release-group']?.['secondary-types'] ?? [];
  if (types.length) return types.join(', ');
  const genres = [...(r.genres ?? []), ...(r['release-group']?.genres ?? [])].filter((g) => g.name).sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  return genres[0]?.name;
}

/** A MusicBrainz release with its recordings: the tracks of all its media in order. */
export function parseMusicBrainzTracks(json: unknown): LookupAlbum | null {
  const r = json as MbRelease;
  if (typeof r !== 'object' || r === null || !r.title || !Array.isArray(r.media)) return null;
  const tracks = [...r.media]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .flatMap((m) => [...(m.tracks ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)))
    .filter((t) => typeof t.title === 'string')
    .map((t) => ({ title: t.title!.trim(), durationSec: typeof t.length === 'number' ? t.length / 1000 : undefined }));
  if (!tracks.length) return null;
  return { source: 'MusicBrainz', album: r.title, artist: creditOf(r), tracks, genre: genreOf(r) };
}

/* ------------------------------------------------------------ fetch */

/**
 * GET of a JSON answer, in the service's shared queue, again after a busy
 * answer, and from memory when the same was asked a little earlier
 * (src/core/covers/net.ts). Throws HttpError ("HTTP 503") and the like.
 */
function getJson(url: string, opts: TrackLookupOptions): Promise<unknown> {
  const service = url.startsWith('https://musicbrainz.org/') ? 'musicbrainz' : 'itunes';
  return serviceJson(service, url, {
    fetchFn: opts.fetchFn,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    limiter: opts.rateLimiter ?? gates[service],
    retries: opts.retries ?? 2,
  });
}

/* ------------------------------------------------------------ using a match */

export interface RowForLookup {
  file: string;
  title: string;
  /** Only a number or a file name so far. */
  untitled?: boolean;
  /** A guess already (artist field, an earlier lookup): a shop's name is better. */
  titleAuto?: boolean;
}

/**
 * The names a match gives the folder's tracks, by position: only for tracks
 * without a real title or with a guessed one. Titles from the files' tags or
 * typed by someone stay. Empty when the match has another number of tracks.
 */
export function titlesFromMatch(rows: readonly RowForLookup[], found: Pick<LookupAlbum, 'tracks'>): { file: string; title: string }[] {
  if (rows.length !== found.tracks.length) return [];
  return rows.flatMap((r, i) => {
    const title = found.tracks[i].title.trim();
    return (r.untitled || r.titleAuto) && title && title !== r.title ? [{ file: r.file, title }] : [];
  });
}
