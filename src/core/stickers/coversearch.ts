/**
 * Cover search for audio plays and albums: iTunes, Deezer and MusicBrainz
 * with the Cover Art Archive, merged and ranked. Also loads the chosen
 * cover, and finds covers embedded in audio files and cover images in a
 * folder.
 *
 * iTunes and Deezer are asked at the same time; MusicBrainz is slow (one
 * request a second for the whole app) and asked along with them, or with
 * `musicBrainz: 'rest'` only when the other two found nothing good enough.
 * Every request goes through the polite queues of src/core/covers/net.ts.
 * Names are cleaned first (src/core/covers/names.ts): "Disc 1", "[Bonus
 * Tracks]", "(Remastered 2009)" and downloader names are not searched for.
 *
 * Ranking knows German audio-play conventions: umlauts and punctuation are
 * normalised, "Die drei ???" and "Die drei !!!" stay different series, and an
 * episode number in the query ("Folge 12", "TKKG 125") must match.
 */

import type { IPicture } from 'music-metadata';
import { cleanForSearch, prepareQuery, variantOf, variantsFit, type PreparedQuery } from '../covers/names';
import {
  abortError,
  FormatError,
  HttpError,
  isDown,
  serviceJson,
  SERVICE_HOSTS,
  ServiceDownError,
  TimeoutError,
  withTimeout,
  type Limiter,
} from '../covers/net';
import { parseReleaseName } from '../library/releasename';
import { blobPart, isAbortError, sniffImageType, type FetchLike } from './image';

export { RateLimiter } from '../covers/net';

export type CoverSource = 'itunes' | 'deezer' | 'musicbrainz';

/**
 * What the cover belongs to: "cd" (the usual square covers of any edition)
 * or "cassette" (the inlay of a cassette edition, taller than wide, much like
 * a card turned upright). Only MusicBrainz knows the format of an edition.
 */
export type CoverKind = 'cd' | 'cassette';

export interface CoverQuery {
  artist?: string;
  album?: string;
  title?: string;
  /** Free text, e.g. "Die drei ??? Folge 12". */
  query?: string;
}

export interface CoverCandidate {
  /** Stable id, e.g. "itunes:1440871234", "deezer:302127" or "musicbrainz:<release-group mbid>". */
  id: string;
  source: CoverSource;
  title: string;
  artist: string;
  year?: number;
  /** About 250 px, for result lists. */
  thumbUrl: string;
  /** About 500 to 600 px, for previews. */
  mediumUrl?: string;
  /** About 1000 to 1200 px, for printing at 300 dpi. */
  fullUrl: string;
  /** Requested edge length of fullUrl in px; the server may deliver less if the original is smaller. */
  sizeHint?: number;
  /**
   * The single edition this picture shows (a MusicBrainz release id), for
   * cassette covers: editions of the same album often have different inlays,
   * so they are not merged into one hit.
   */
  edition?: string;
  /** Other services that had the same album under the same name (merged into this hit). */
  alsoFrom?: CoverSource[];
  /** Match quality, higher is better (roughly -1 … 1.5). */
  score: number;
}

export interface CoverSearchResult {
  candidates: CoverCandidate[];
  /**
   * German messages, only when no service answered at all: one that does
   * not answer while others do is left out without a word (a web filter on
   * Frank's computer blocks some, #110).
   */
  warnings: string[];
  /** Hints that are no failure, e.g. that there is no cassette photo. */
  notes?: string[];
  /** Services asked. */
  asked?: CoverSource[];
  /** Services that did not answer (or were left out because they did not answer before). */
  failed?: CoverSource[];
}

export interface CoverSearchOptions {
  fetchFn?: FetchLike;
  signal?: AbortSignal;
  /** Per request, default 12 s. */
  timeoutMs?: number;
  /** Default all three; for cassettes MusicBrainz, with iTunes and Deezer for the name and as a fallback. */
  sources?: readonly CoverSource[];
  /** Default "cd". */
  kind?: CoverKind;
  /** MusicBrainz' turns; the app's shared queue unless given. */
  rateLimiter?: Limiter;
  /** Turns per service; the app's shared queues unless given (tests: ones that never wait). */
  limiters?: Partial<Record<CoverSource, Limiter>>;
  /** Maximum number of results, default 20. */
  limit?: number;
  /**
   * "always" (default): MusicBrainz along with the others. "rest": only
   * when iTunes and Deezer found nothing that `enough` takes.
   */
  musicBrainz?: 'always' | 'rest';
  /** With musicBrainz "rest": whether the hits of iTunes and Deezer do. Default: any hit. */
  enough?: (partial: CoverSearchResult) => boolean;
  /** Reuse answers given a little earlier (default true). */
  cache?: boolean;
  /** How often a busy answer (503, 429) is asked again, default 3. */
  retries?: number;
  /**
   * Called with the results so far whenever a source has answered while
   * another is still running, so the first hits can show without waiting for
   * the slowest source. The returned promise still has the complete result.
   */
  onProgress?: (partial: CoverSearchResult) => void;
}

export interface CoverDownloadOptions {
  fetchFn?: FetchLike;
  signal?: AbortSignal;
  /** Per image size, default 12 s. */
  timeoutMs?: number;
}

const ITUNES_SEARCH = 'https://itunes.apple.com/search';
const DEEZER_SEARCH = 'https://api.deezer.com/search/album';
const MUSICBRAINZ_RELEASE_SEARCH = 'https://musicbrainz.org/ws/2/release/';
const COVER_ART_ARCHIVE = 'https://coverartarchive.org';
export const SOURCE_NAME: Record<CoverSource, string> = { itunes: 'iTunes', deezer: 'Deezer', musicbrainz: 'MusicBrainz' };

export const NO_CASSETTE_SEARCH = 'Kassettenfotos gibt es nur bei MusicBrainz, und MusicBrainz antwortet gerade nicht. Blockiert vielleicht ein Filter musicbrainz.org? Hier siehst du die CD-Cover. Sie passen auch zum Stil „Kassette“.';
export const NO_CASSETTE_PHOTO = 'Bei MusicBrainz gibt es für diesen Titel kein Kassettenfoto. Nimm das CD-Cover: Es passt auch zum Stil „Kassette“.';

// ---------------------------------------------------------------------------
// Search

interface SourceResult {
  source: CoverSource;
  candidates: (CoverCandidate & { mbScore?: number })[];
  failed?: boolean;
  /** Not needed any more: another service found enough first. */
  skipped?: boolean;
  warning?: string;
}

/**
 * Searches the services and returns the merged, ranked and de-duplicated
 * candidates. A service that fails is left out without a word as long as
 * another answers; only when none does, the result has German warnings.
 * `onProgress` gets the hits of the first service that answers. Aborting
 * via `signal` rejects with an AbortError.
 */
export async function searchCovers(query: CoverQuery, options: CoverSearchOptions = {}): Promise<CoverSearchResult> {
  const prepared = prepareQuery(query);
  if (!prepared.text) {
    return { candidates: [], warnings: ['Gib einen Namen ein, zum Beispiel „Die drei ??? Folge 12“.'] };
  }
  if (options.signal?.aborted) throw abortError();
  const fetchFn: FetchLike = options.fetchFn ?? ((url, init) => fetch(url, init));
  const kind = options.kind ?? 'cd';
  const sources = options.sources ?? (['itunes', 'deezer', 'musicbrainz'] as const);
  const limit = options.limit ?? 20;
  const ctx: SearchContext = { fetchFn, options, prepared, kind, signal: options.signal };

  // By source position, so the ranking does not depend on which source answered first.
  const order: CoverSource[] = ['itunes', 'deezer', 'musicbrainz'];
  const done = new Map<CoverSource, SourceResult>();
  const summary = (): CoverSearchResult => summarize(query, prepared, order.flatMap((s) => (done.has(s) ? [done.get(s)!] : [])), limit, kind);

  const run = async (source: CoverSource, others: () => boolean) => {
    const result = await askSource(ctx, source);
    if (options.signal?.aborted) throw abortError();
    done.set(source, result);
    if (others()) options.onProgress?.(summary());
  };

  if (kind === 'cassette') {
    await searchCassette(ctx, sources, done);
    if (options.signal?.aborted) throw abortError();
    return summary();
  }

  let fast: CoverSource[] = sources.filter((s) => s !== 'musicbrainz');
  let slow = sources.includes('musicbrainz');
  // A service that does not answer (a web filter) leaves its place to MusicBrainz right away.
  if (options.musicBrainz === 'rest' && slow && fast.some(isDown)) {
    fast = [...fast, 'musicbrainz'];
    slow = false;
  }
  if (options.musicBrainz === 'rest') {
    const enough = options.enough ?? ((r: CoverSearchResult) => r.candidates.length > 0);
    // A service whose turn has not come yet is not needed any more once the other found enough: its turn goes to the next folder.
    const own = new Map(fast.map((s) => [s, new AbortController()]));
    let pending = fast.length;
    await Promise.all(
      fast.map(async (s) => {
        const result = await askSource({ ...ctx, skip: own.get(s)!.signal }, s);
        pending--;
        if (options.signal?.aborted) throw abortError();
        if (result.skipped) return;
        done.set(s, result);
        if (!pending) return;
        const partial = summary();
        if (!result.failed && enough(partial)) own.forEach((c, o) => o !== s && c.abort());
        else options.onProgress?.(partial);
      }),
    );
    const partial = summary();
    const answered = fast.some((s) => done.has(s) && !done.get(s)!.failed);
    if (slow && !(answered && enough(partial))) {
      if (fast.length) options.onProgress?.(partial);
      await run('musicbrainz', () => false);
    }
  } else {
    const all = [...fast, ...(slow ? (['musicbrainz'] as const) : [])];
    let pending = all.length;
    await Promise.all(all.map((s) => run(s, () => --pending > 0)));
  }
  if (options.signal?.aborted) throw abortError();
  return summary();
}

interface SearchContext {
  fetchFn: FetchLike;
  options: CoverSearchOptions;
  prepared: PreparedQuery;
  kind: CoverKind;
  signal?: AbortSignal;
  /** Aborts when this service is not needed any more: gives up its turn if it has not come yet. */
  skip?: AbortSignal;
}

function limiterFor(ctx: SearchContext, source: CoverSource): Limiter | undefined {
  return ctx.options.limiters?.[source] ?? (source === 'musicbrainz' ? ctx.options.rateLimiter : undefined);
}

function json(ctx: SearchContext, source: CoverSource, url: string): Promise<unknown> {
  return serviceJson(source, url, {
    fetchFn: ctx.fetchFn,
    signal: ctx.signal,
    timeoutMs: ctx.options.timeoutMs,
    limiter: limiterFor(ctx, source),
    cache: ctx.options.cache,
    retries: ctx.options.retries,
    skip: ctx.skip,
  });
}

/** One service, with a second try without the artist when the first finds nothing (an artist tag may be a track's title, #110). */
async function askSource(ctx: SearchContext, source: CoverSource, prepared = ctx.prepared, kind: CoverKind = ctx.kind): Promise<SourceResult> {
  try {
    if (isDown(source)) throw new ServiceDownError(source);
    const once = async (p: PreparedQuery) => {
      if (source === 'itunes') return parseItunesResults(await json(ctx, source, buildItunesUrl(p)));
      if (source === 'deezer') return parseDeezerResults(await json(ctx, source, buildDeezerUrl(p)));
      return parseMusicBrainzResults(await json(ctx, source, buildMusicBrainzUrl(p, kind)), kind);
    };
    let candidates = await once(prepared);
    const relevant = candidates.filter((c) => isRelevant(prepared, c));
    // Nothing with the artist: once more without it.
    if (!relevant.length && prepared.artist && prepared.album && normalizeForMatch(prepared.album) !== normalizeForMatch(prepared.text)) {
      candidates = [...candidates, ...(await once({ ...prepared, artist: undefined, text: prepared.album }))];
    }
    return { source, candidates };
  } catch (err) {
    if (ctx.signal?.aborted) throw abortError();
    if (ctx.skip?.aborted && isAbortError(err)) return { source, candidates: [], skipped: true };
    return { source, candidates: [], failed: true, warning: failureMessage(source, err) };
  }
}

/**
 * Cassette covers (TODO #115): only MusicBrainz knows cassette editions,
 * and few of them have a photo. A name with only a series and a number
 * ("TKKG Folge 7") learns the episode's title from iTunes or Deezer first,
 * because the cassettes carry the title, not the number. When MusicBrainz
 * has no cassette, the CD covers follow with a note.
 */
async function searchCassette(ctx: SearchContext, sources: readonly CoverSource[], done: Map<CoverSource, SourceResult>) {
  const fast = sources.filter((s) => s !== 'musicbrainz');
  const cds = await Promise.all(fast.map((s) => askSource(ctx, s, ctx.prepared, 'cd')));
  let prepared = ctx.prepared;
  const parsed = parseReleaseName(prepared.album, prepared.artist);
  if (!parsed.title && parsed.episode !== undefined) {
    const named = rankCandidates(prepared, cds.flatMap((r) => r.candidates)).find((c) => episodeNumbers(c.title).includes(parsed.episode!));
    const title = named ? parseReleaseName(named.title, named.artist).title : '';
    if (title) prepared = { ...prepared, album: `${parsed.series ?? named!.artist} ${title}`, artist: parsed.series ?? named!.artist };
  }
  if (sources.includes('musicbrainz')) done.set('musicbrainz', await askSource(ctx, 'musicbrainz', prepared, 'cassette'));
  // The CD covers as a fallback, behind the cassettes.
  for (const r of cds) done.set(r.source, { ...r, candidates: r.candidates.map((c) => ({ ...c, cdFallback: true })) });
}

function summarize(query: CoverQuery, prepared: PreparedQuery, results: SourceResult[], limit: number, kind: CoverKind): CoverSearchResult {
  const asked = results.map((r) => r.source);
  const failed = results.filter((r) => r.failed).map((r) => r.source);
  const warnings = failed.length === asked.length ? results.flatMap((r) => (r.warning ? [r.warning] : [])) : [];
  // Relevant to the whole name, or to the album alone (an artist tag may be the title of a track, #110).
  const albumOnly = prepared.artist && prepared.album ? { ...prepared, artist: undefined, text: prepared.album } : null;
  const all = results.flatMap((r) => r.candidates).filter((c) => isRelevant(prepared, c) || (!!albumOnly && isRelevant(albumOnly, c)));
  let candidates: CoverCandidate[];
  const notes: string[] = [];
  if (kind === 'cassette') {
    const tapes = rankCandidates(query, all.filter((c) => !(c as { cdFallback?: boolean }).cdFallback));
    const cds = rankCandidates(query, all.filter((c) => (c as { cdFallback?: boolean }).cdFallback)).map(({ cdFallback: _cd, ...c }: CoverCandidate & { cdFallback?: boolean }) => c);
    if (!tapes.length && asked.includes('musicbrainz') && !failed.includes('musicbrainz')) notes.push(NO_CASSETTE_PHOTO);
    else if (cds.length && failed.includes('musicbrainz')) notes.push(NO_CASSETTE_SEARCH);
    candidates = [...tapes, ...cds].slice(0, limit);
  } else {
    candidates = rankCandidates(query, all).slice(0, limit);
  }
  return { candidates, warnings, asked, failed, ...(notes.length ? { notes } : {}) };
}

/**
 * A service that does not answer at all may be blocked by a web filter (a child-safe filter, a firewall
 * at school or at work): which addresses to allow there (Hilfe: „Internetfilter und Firewall“).
 */
export function filterQuestion(source: CoverSource): string {
  return `Blockiert vielleicht ein Filter? Dann gib dort ${SERVICE_HOSTS[source].join(', ')} frei.`;
}

function failureMessage(source: CoverSource, err: unknown): string {
  const name = SOURCE_NAME[source];
  if (err instanceof HttpError) {
    if (err.status === 503 || err.status === 429) return `${name} ist gerade ausgelastet. Warte ein paar Minuten und suche noch einmal.`;
    return `${name} hat mit einem Fehler geantwortet (${err.status}). Versuche es später noch einmal.`;
  }
  if (err instanceof TimeoutError) return `${name} antwortet gerade nicht. ${filterQuestion(source)} Sonst versuche es später noch einmal.`;
  if (err instanceof FormatError) return `${name} hat eine unerwartete Antwort geschickt. Versuche es später noch einmal.`;
  if (err instanceof ServiceDownError) return `${name} ist von diesem Computer aus gerade nicht erreichbar. ${filterQuestion(source)} Sonst versuche es später noch einmal.`;
  return `Die Suche bei ${name} hat nicht geklappt. Prüfe die Internetverbindung. ${filterQuestion(source)}`;
}

// ---------------------------------------------------------------------------
// Download

/**
 * Loads the largest size of a cover that the server delivers: full size, then
 * medium, then the thumbnail. A size that fails, is no picture or takes longer
 * than `timeoutMs` makes way for the next one. Aborting via `signal` rejects
 * with an AbortError at once, so a cover chosen later is never overtaken.
 */
export async function downloadCoverImage(
  candidate: Pick<CoverCandidate, 'fullUrl' | 'mediumUrl' | 'thumbUrl'>,
  options: CoverDownloadOptions = {},
): Promise<Blob> {
  const fetchFn: FetchLike = options.fetchFn ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 12_000;
  const urls = [...new Set([candidate.fullUrl, candidate.mediumUrl, candidate.thumbUrl])].filter((u): u is string => !!u);
  let timedOut = false;
  for (const url of urls) {
    if (options.signal?.aborted) throw abortError();
    try {
      const bytes = await withTimeout(options.signal, timeoutMs, async (timed) => {
        const res = await fetchFn(url, { signal: timed });
        if (!res.ok) throw new HttpError(res.status);
        return new Uint8Array(await res.arrayBuffer());
      });
      const type = sniffImageType(bytes);
      if (type) return new Blob([blobPart(bytes)], { type });
    } catch (err) {
      if (options.signal?.aborted) throw abortError();
      if (err instanceof TimeoutError) timedOut = true;
      // Next size: some mirrors refuse large pictures or do not have them.
    }
  }
  throw new Error(
    timedOut
      ? 'Der Server antwortet gerade nicht. Blockiert vielleicht ein Filter? Versuche es gleich noch einmal oder nimm ein anderes Bild.'
      : 'Der Server gibt das Bild nicht heraus. Speichere es selbst auf deinem Computer und wähle es dann unter „Eigenes Bild“ aus.',
  );
}

// ---------------------------------------------------------------------------
// Request URLs

function prepared(q: CoverQuery | PreparedQuery): PreparedQuery {
  return 'text' in q && 'variant' in q ? q : prepareQuery(q);
}

export function buildItunesUrl(q: CoverQuery | PreparedQuery): string {
  const params = new URLSearchParams({ term: prepared(q).text, entity: 'album', limit: '12', country: 'DE' });
  return `${ITUNES_SEARCH}?${params.toString()}`;
}

/** Deezer's album search: free, without a key, many German audio plays, pictures up to 1000 px. */
export function buildDeezerUrl(q: CoverQuery | PreparedQuery): string {
  const params = new URLSearchParams({ q: prepared(q).text, limit: '12' });
  return `${DEEZER_SEARCH}?${params.toString()}`;
}

/**
 * Lucene query for the MusicBrainz release index; for cassettes only
 * editions on cassette. With an artist (or a series, for cassettes) the
 * artist field and the words of the title; else the words anywhere.
 */
export function buildMusicBrainzQuery(q: CoverQuery | PreparedQuery, kind: CoverKind = 'cd'): string {
  const p = prepared(q);
  let artist = p.artist ?? '';
  let title = p.album;
  if (kind === 'cassette' || !artist) {
    // "Benjamin Blümchen Folge 87 Das Laternenfest": cassettes carry the series as artist and the title without the number.
    const parsed = parseReleaseName(p.album, p.artist);
    if (kind === 'cassette' && parsed.series && parsed.title) {
      artist = parsed.series;
      title = parsed.title;
    }
  }
  if (artist && normalizeForMatch(title).startsWith(normalizeForMatch(artist))) title = title.slice(artist.length);
  const release = luceneTerms(title);
  let lucene = '';
  if (artist) {
    const phrase = `artist:"${artist.replace(/["\\]/g, (ch) => `\\${ch}`)}"`;
    lucene = release ? `${phrase} AND release:(${release})` : phrase;
  } else if (release) {
    // Without articles: "der" alone brought "Der Tod" and "Der böse Wolf" for "Der Räuber Hotzenplotz".
    // The whole name as typed counts most.
    const words = release.split(' ');
    const content = words.filter((w) => !ARTICLES.has(w)).join(' ') || release;
    const phrase = words.length > 1 ? `release:"${release}"^3 OR ` : '';
    lucene = `${phrase}release:(${content}) OR artist:(${content})`;
  }
  return lucene && kind === 'cassette' ? `(${lucene}) AND format:cassette` : lucene;
}

export function buildMusicBrainzUrl(q: CoverQuery | PreparedQuery, kind: CoverKind = 'cd'): string {
  // Many cassette editions have no picture in the Cover Art Archive (their tiles are left out), so ask for more.
  const limit = kind === 'cassette' ? 50 : 8;
  return `${MUSICBRAINZ_RELEASE_SEARCH}?query=${encodeURIComponent(buildMusicBrainzQuery(q, kind))}&fmt=json&limit=${limit}`;
}

/** Words left out of a free search: they match nearly every release. */
const ARTICLES = new Set(['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'und', 'the', 'a', 'an', 'and']);

/** Words only, lower case (so "AND"/"OR" typed by the user are not operators), no Lucene syntax. */
function luceneTerms(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Response parsing

interface ItunesCollection {
  wrapperType?: string;
  collectionId?: number;
  artistName?: string;
  collectionName?: string;
  artworkUrl100?: string;
  artworkUrl60?: string;
  releaseDate?: string;
}

/** iTunes artwork URLs end in ".../100x100bb.jpg"; any size can be requested. */
export function itunesArtworkUrl(url: string, size: number): string {
  return url.replace(/\/\d+x\d+bb(\.[a-z]+)$/i, `/${size}x${size}bb$1`).replace(/\b100x100bb\b/, `${size}x${size}bb`);
}

export function parseItunesResults(json: unknown): CoverCandidate[] {
  const results = isRecord(json) && Array.isArray(json.results) ? (json.results as unknown[]) : null;
  if (!results) throw new FormatError();
  const out: CoverCandidate[] = [];
  results.forEach((raw, i) => {
    if (!isRecord(raw)) return;
    const item = raw as ItunesCollection;
    if (item.wrapperType && item.wrapperType !== 'collection') return;
    const art = item.artworkUrl100 ?? item.artworkUrl60;
    const title = item.collectionName?.trim();
    if (!art || !title) return;
    const resizable = /\d+x\d+bb/.test(art);
    out.push({
      id: `itunes:${item.collectionId ?? i}`,
      source: 'itunes',
      title,
      artist: item.artistName?.trim() ?? '',
      year: yearOf(item.releaseDate),
      thumbUrl: resizable ? itunesArtworkUrl(art, 250) : art,
      mediumUrl: resizable ? itunesArtworkUrl(art, 600) : art,
      fullUrl: resizable ? itunesArtworkUrl(art, 1200) : art,
      sizeHint: resizable ? 1200 : undefined,
      score: 0,
    });
  });
  return out;
}

interface DeezerAlbum {
  id?: number;
  title?: string;
  cover_small?: string;
  cover_medium?: string;
  cover_big?: string;
  cover_xl?: string;
  release_date?: string;
  record_type?: string;
  artist?: { name?: string };
}

/** Deezer's album search: cover_medium is 250 px, cover_big 500 px, cover_xl 1000 px. */
export function parseDeezerResults(json: unknown): CoverCandidate[] {
  if (isRecord(json) && isRecord(json.error)) {
    // {"error":{"type":"Exception","message":"Quota limit exceeded","code":4}}: as busy as a 429.
    throw new HttpError(json.error.code === 4 ? 429 : 500);
  }
  const data = isRecord(json) && Array.isArray(json.data) ? (json.data as unknown[]) : null;
  if (!data) throw new FormatError();
  const out: CoverCandidate[] = [];
  data.forEach((raw, i) => {
    if (!isRecord(raw)) return;
    const item = raw as DeezerAlbum;
    const title = item.title?.trim();
    const thumb = item.cover_medium ?? item.cover_big ?? item.cover_xl;
    if (!title || !thumb) return;
    out.push({
      id: `deezer:${item.id ?? i}`,
      source: 'deezer',
      title,
      artist: item.artist?.name?.trim() ?? '',
      year: yearOf(item.release_date),
      thumbUrl: thumb,
      mediumUrl: item.cover_big ?? thumb,
      fullUrl: item.cover_xl ?? item.cover_big ?? thumb,
      sizeHint: item.cover_xl ? 1000 : undefined,
      score: 0,
    });
  });
  return out;
}

interface MusicBrainzRelease {
  id?: string;
  score?: number | string;
  title?: string;
  date?: string;
  'artist-credit'?: { name?: string; joinphrase?: string; artist?: { name?: string } }[];
  'release-group'?: { id?: string };
  media?: { format?: string }[];
}

/** Cassette editions shown per album: the inlays of re-releases often differ, but not always. */
const CASSETTES_PER_GROUP = 3;

/**
 * For CDs one candidate per release group (several editions of an album share
 * one). Images come from the Cover Art Archive via the release group, which
 * picks a representative front cover from any release in the group (many
 * single editions have no own artwork); without a group id the release itself
 * is used. That picture is mostly the CD's, so for cassettes each cassette
 * edition brings its own front cover (up to CASSETTES_PER_GROUP per album);
 * editions without one fail to load and are left out by the search.
 */
export function parseMusicBrainzResults(json: unknown, kind: CoverKind = 'cd'): CoverCandidate[] {
  const releases = isRecord(json) && Array.isArray(json.releases) ? (json.releases as unknown[]) : null;
  if (!releases) throw new FormatError();
  const out: (CoverCandidate & { mbScore: number })[] = [];
  const groups = new Map<string, number>();
  const cassette = kind === 'cassette';
  for (const raw of releases) {
    if (!isRecord(raw)) continue;
    const rel = raw as MusicBrainzRelease;
    if (!rel.id || !rel.title) continue;
    // The search may still bring editions with a cassette among other media; one without any is not wanted.
    if (cassette && Array.isArray(rel.media) && rel.media.length > 0 && !rel.media.some((m) => /cassette/i.test(m?.format ?? ''))) continue;
    const groupId = rel['release-group']?.id;
    if (groupId) {
      const seen = groups.get(groupId) ?? 0;
      if (seen >= (cassette ? CASSETTES_PER_GROUP : 1)) continue;
      groups.set(groupId, seen + 1);
    }
    const base = groupId && !cassette ? `${COVER_ART_ARCHIVE}/release-group/${groupId}` : `${COVER_ART_ARCHIVE}/release/${rel.id}`;
    const artist = (rel['artist-credit'] ?? [])
      .map((c) => `${c.name ?? c.artist?.name ?? ''}${c.joinphrase ?? ''}`)
      .join('')
      .trim();
    const mbScore = Number(rel.score);
    out.push({
      id: `musicbrainz:${cassette ? rel.id : (groupId ?? rel.id)}`,
      source: 'musicbrainz',
      ...(cassette ? { edition: rel.id } : {}),
      title: rel.title.trim(),
      artist,
      year: yearOf(rel.date),
      thumbUrl: `${base}/front-250`,
      mediumUrl: `${base}/front-500`,
      fullUrl: `${base}/front-1200`,
      sizeHint: 1200,
      score: 0,
      mbScore: Number.isFinite(mbScore) ? mbScore : 0,
    });
  }
  return out;
}

function yearOf(date: string | undefined): number | undefined {
  const m = /^(\d{4})/.exec(date ?? '');
  return m ? Number(m[1]) : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// ---------------------------------------------------------------------------
// Matching and ranking

const SERIES_ALIASES: [RegExp, string][] = [
  [/\b(?:die )?(?:3|drei) fragezeichen\b/g, 'die drei fragezeichen'],
  [/\b(?:die )?(?:3|drei) ausrufezeichen\b/g, 'die drei ausrufezeichen'],
  [/\bddf\b/g, 'die drei fragezeichen'],
  [/\b(?:5|fuenf) freunde\b/g, 'fuenf freunde'],
  [/\bt k k g\b/g, 'tkkg'],
];

/**
 * Lower case, umlauts as ae/oe/ue/ss, accents removed, "???" → "fragezeichen",
 * "!!!" → "ausrufezeichen", "&" → "und", punctuation removed, leading zeros of
 * numbers removed, known series spellings unified.
 */
export function normalizeForMatch(s: string): string {
  let t = s
    // NFC first: macOS file names and some tags store "ä" as "a" + combining diaeresis.
    .normalize('NFC')
    .toLowerCase()
    .replace(/\?{3,}/g, ' fragezeichen ')
    .replace(/!{3,}/g, ' ausrufezeichen ')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[&+]/g, ' und ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b0+(\d)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [re, to] of SERIES_ALIASES) t = t.replace(re, to);
  return t;
}

const EPISODE_WORDS = new Set(['folge', 'folgen', 'episode', 'teil', 'fall', 'band', 'nr', 'nummer', 'no', 'vol', 'volume', 'kapitel', 'box']);
const STOP_WORDS = new Set([
  'die', 'der', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'und', 'the', 'a', 'an', 'of', 'von', 'vom', 'im', 'in', 'mit',
  'zum', 'zur', 'am', 'cd', 'hoerspiel', 'hoerbuch', 'audio', ...EPISODE_WORDS,
]);
const COLLECTION_WORDS = /\b(box|sammelbox|hoerspielbox|best of|die besten|collection|sammlung|jubilaeumsbox|kollektion|staffel|folgen)\b/;
const RANGE = /\b(\d{1,4})\s*(?:-|–|—|bis)\s*(\d{1,4})\b/;

/** Episode-like numbers (years 1900–2099 only after words like "Folge"). */
export function episodeNumbers(text: string): number[] {
  const tokens = normalizeForMatch(text).split(' ');
  const out: number[] = [];
  tokens.forEach((tok, i) => {
    if (!/^\d+$/.test(tok)) return;
    const n = Number(tok);
    const afterWord = i > 0 && EPISODE_WORDS.has(tokens[i - 1]);
    if (!afterWord && (n > 999 || (n >= 1900 && n <= 2099))) return;
    if (!out.includes(n)) out.push(n);
  });
  return out;
}

function isCollection(raw: string): boolean {
  return RANGE.test(raw) || COLLECTION_WORDS.test(normalizeForMatch(raw));
}

function contentTokens(normalized: string): string[] {
  return normalized.split(' ').filter((t) => t && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
}

/** 1 for an exact word, 0.6 for a clear part of a word (≥ 4 letters), else 0. */
function tokenMatch(token: string, inTokens: readonly string[]): number {
  if (inTokens.includes(token)) return 1;
  if (token.length >= 4 && inTokens.some((t) => t.length >= 4 && (t.includes(token) || token.includes(t)))) return 0.6;
  return 0;
}

function coverage(needles: readonly string[], haystack: readonly string[]): number {
  if (needles.length === 0) return 0;
  return needles.reduce((s, t) => s + tokenMatch(t, haystack), 0) / needles.length;
}

/** The query as cleaned for the search (names.ts); a prepared one as it is. */
function preparedOf(query: CoverQuery | PreparedQuery): PreparedQuery {
  return 'text' in query && 'variant' in query ? query : prepareQuery(query);
}

/**
 * Whether a hit is about what was searched at all: at least half of the
 * searched words (articles and numbers aside) in its title or artist.
 * "Der Tod" or "Der unheimliche Phantoll" for "Der Räuber Hotzenplotz" are not.
 */
export function isRelevant(query: CoverQuery | PreparedQuery, candidate: Pick<CoverCandidate, 'title' | 'artist'>): boolean {
  const qTokens = contentTokens(normalizeForMatch(preparedOf(query).text));
  if (!qTokens.length) return true;
  return coverage(qTokens, [...contentTokens(normalizeForMatch(candidate.title)), ...contentTokens(normalizeForMatch(candidate.artist))]) >= 0.5;
}

/**
 * Match quality of one candidate for the query, roughly -1 … 1.5. Both
 * names are compared cleaned (no "Disc 1", "[Bonus Tracks]", "(Remastered
 * 2009)"); a hit of the kind the name asks for ("Ungekürzte Lesung",
 * "Soundtrack") gets a little more, one of another kind less.
 */
export function scoreCandidate(query: CoverQuery | PreparedQuery, candidate: Pick<CoverCandidate, 'title' | 'artist' | 'source'> & { mbScore?: number }): number {
  const p = preparedOf(query);
  const text = p.text;
  const qTokens = contentTokens(normalizeForMatch(text));
  const cleanTitle = cleanForSearch(candidate.title);
  const titleTokens = contentTokens(normalizeForMatch(cleanTitle));
  const artistTokens = contentTokens(normalizeForMatch(candidate.artist));
  const all = [...titleTokens, ...artistTokens];

  let score: number;
  if (p.artist) {
    // Album and artist each by themselves: "Winterkinder" by Rolf Zuckowski is not "Im Kindergarten" by Rolf Zuckowski.
    const albumTokens = contentTokens(normalizeForMatch(p.album));
    const ourArtist = contentTokens(normalizeForMatch(p.artist));
    const albumCov = albumTokens.length ? coverage(albumTokens, all) : coverage(qTokens, all);
    const titleCov = coverage(titleTokens, [...albumTokens, ...ourArtist]);
    const artistCov = Math.max(coverage(ourArtist, [...artistTokens, ...titleTokens]), coverage(artistTokens, ourArtist));
    score = 0.5 * albumCov + 0.2 * titleCov + 0.2 * artistCov;
  } else {
    score = 0.55 * coverage(qTokens, all) + 0.15 * coverage(titleTokens, qTokens);
  }

  const wanted = p.episodes;
  const collection = isCollection(cleanTitle);
  if (wanted.length > 0) {
    const found = episodeNumbers(cleanTitle);
    // The right number only helps as far as the series matches too: "Die drei !!! Folge 12" is a
    // poor hit for "Die drei ??? Folge 12". A wrong number always costs.
    const seriesMatch = qTokens.length > 0 ? coverage(qTokens, all) ** 2 : 1;
    if (found.some((n) => wanted.includes(n))) score += (collection ? 0.1 : 0.35) * seriesMatch;
    else score -= found.length > 0 ? 0.35 : 0.1;
  }
  if (collection && !isCollection(text)) score -= 0.12;
  const kind = variantOf(candidate.title);
  if (p.variant && kind === p.variant) score += 0.05;
  else if (!variantsFit(p.variant, kind)) score -= 0.15;
  score += candidate.source === 'musicbrainz' ? 0.02 * ((candidate.mbScore ?? 0) / 100) - 0.01 : candidate.source === 'itunes' ? 0.02 : 0.015;
  return Math.round(score * 1000) / 1000;
}

const SOURCE_ORDER: Record<CoverSource, number> = { itunes: 0, deezer: 1, musicbrainz: 2 };

/**
 * Scores, removes duplicates (same artist and title; the better one stays,
 * iTunes before Deezer before MusicBrainz on a tie because their artwork
 * always exists) and sorts best first. A duplicate from another service is
 * noted in `alsoFrom`: two services agree.
 */
export function rankCandidates(query: CoverQuery | PreparedQuery, candidates: readonly (CoverCandidate & { mbScore?: number })[]): CoverCandidate[] {
  const p = preparedOf(query);
  const scored = candidates.map((c, order) => {
    const { mbScore: _ignored, ...rest } = c;
    return { candidate: { ...rest, score: scoreCandidate(p, c) }, order };
  });
  scored.sort((a, b) => b.candidate.score - a.candidate.score || SOURCE_ORDER[a.candidate.source] - SOURCE_ORDER[b.candidate.source] || a.order - b.order);
  const kept = new Map<string, CoverCandidate>();
  const out: CoverCandidate[] = [];
  for (const { candidate } of scored) {
    const key = sameAlbumKey(candidate);
    const first = kept.get(key);
    if (first) {
      if (candidate.source !== first.source && !first.alsoFrom?.includes(candidate.source)) first.alsoFrom = [...(first.alsoFrom ?? []), candidate.source];
      continue;
    }
    kept.set(key, candidate);
    out.push(candidate);
  }
  return out;
}

/**
 * Hits with this key show the same album (rankCandidates keeps only one of
 * them): the same artist and name, apart from notes about the edition
 * ("Remastered", "40th Anniversary Edition"), and of the same kind (the
 * soundtrack and the audio play of a film stay apart). Editions of
 * cassettes stay apart.
 */
export function sameAlbumKey(c: Pick<CoverCandidate, 'artist' | 'title' | 'edition'>): string {
  const key = `${normalizeForMatch(c.artist)}|${normalizeForMatch(cleanForSearch(c.title))}|${variantOf(c.title)}`;
  return c.edition ? `${key}|${c.edition}` : key;
}

/**
 * The hits of a search merged into the tiles already on the screen: those
 * keep their place, so nothing jumps away under the pointer while a slower
 * service answers. New hits follow in their ranking, at most `limit` tiles
 * in all. With nothing shown yet, this is the ranking itself.
 */
export function keepShownOrder(shown: readonly CoverCandidate[], ranked: readonly CoverCandidate[], limit = 30): CoverCandidate[] {
  if (!shown.length) return ranked.slice(0, limit);
  const out = [...shown];
  const onScreen = new Set(shown.map(sameAlbumKey));
  for (const c of ranked) {
    if (out.length >= limit) break;
    if (onScreen.has(sameAlbumKey(c))) continue;
    onScreen.add(sameAlbumKey(c));
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Covers from files

/**
 * The front cover embedded in an audio file (ID3 APIC, MP4 covr, FLAC/Vorbis
 * picture), or null when there is none or the file cannot be read.
 */
export async function embeddedCover(source: Blob): Promise<Blob | null> {
  const mm = await import('music-metadata');
  let pictures: IPicture[] | undefined;
  try {
    const meta = await mm.parseBlob(source, { duration: false, skipPostHeaders: true });
    pictures = meta.common.picture;
  } catch {
    return null;
  }
  const picture = mm.selectCover(pictures);
  if (!picture || picture.data.length === 0) return null;
  const type = sniffImageType(picture.data) ?? mimeFromFormat(picture.format);
  return new Blob([blobPart(picture.data)], { type });
}

function mimeFromFormat(format: string | undefined): string {
  const f = (format ?? '').toLowerCase().trim();
  if (f.includes('/')) return f === 'image/jpg' ? 'image/jpeg' : f;
  if (f === 'jpg' || f === 'jpeg') return 'image/jpeg';
  if (f === 'png') return 'image/png';
  return 'image/jpeg';
}

const IMAGE_FILE = /\.(jpe?g|png|webp|gif|bmp)$/i;
const NOT_A_FRONT_COVER = /(back|rueck|rück|inlay|booklet|disc|label|tray|inside|innen)/i;

/**
 * Picks the cover image from the file names of a folder (names or relative
 * paths): cover.* before folder.* before front.* before AlbumArt*.jpg
 * (Windows Media Player; "Large" before "Small"), then other names with
 * "cover" or "front". Hidden files such as macOS "._cover.jpg" are ignored.
 * A single image without a telling name is used as a last resort. Returns
 * the name as given, or null.
 */
export function pickFolderImage(names: readonly string[]): string | null {
  const images = names.filter((n) => {
    const base = baseName(n);
    return IMAGE_FILE.test(base) && !base.startsWith('.');
  });
  const extRank = (base: string) => (/\.jpe?g$/i.test(base) ? 0 : /\.png$/i.test(base) ? 1 : 2);
  const tier = (name: string): number | null => {
    const base = baseName(name).toLowerCase();
    const stem = base.replace(IMAGE_FILE, '');
    if (stem === 'cover') return 0 + extRank(base) / 10;
    if (stem === 'folder') return 1 + extRank(base) / 10;
    if (stem === 'front') return 2 + extRank(base) / 10;
    if (/^albumart/.test(stem) && /\.jpe?g$/.test(base)) return /large/.test(stem) ? 3 : /small/.test(stem) ? 3.5 : 3.2;
    if (/(cover|front)/.test(stem) && !NOT_A_FRONT_COVER.test(stem)) return 4 + extRank(base) / 10;
    return null;
  };
  const ranked = images
    .map((name, order) => ({ name, order, tier: tier(name), depth: name.split(/[\\/]/).length }))
    .filter((e): e is { name: string; order: number; tier: number; depth: number } => e.tier !== null)
    .sort((a, b) => a.tier - b.tier || a.depth - b.depth || a.order - b.order);
  if (ranked.length > 0) return ranked[0].name;
  const plain = images.filter((n) => !NOT_A_FRONT_COVER.test(baseName(n)));
  return plain.length === 1 ? plain[0] : null;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
