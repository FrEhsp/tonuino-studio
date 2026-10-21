/**
 * Cover search for audio plays and albums: iTunes Search API and MusicBrainz
 * with the Cover Art Archive, run in parallel, merged and ranked. Also loads
 * the chosen cover, and finds covers embedded in audio files and cover images
 * in a folder.
 *
 * Ranking knows German audio-play conventions: umlauts and punctuation are
 * normalised, "Die drei ???" and "Die drei !!!" stay different series, and an
 * episode number in the query ("Folge 12", "TKKG 125") must match.
 */

import type { IPicture } from 'music-metadata';
import { blobPart, isAbortError, sniffImageType, type FetchLike } from './image';

export type CoverSource = 'itunes' | 'musicbrainz';

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
  /** Stable id, e.g. "itunes:1440871234" or "musicbrainz:<release-group mbid>". */
  id: string;
  source: CoverSource;
  title: string;
  artist: string;
  year?: number;
  /** About 250 px, for result lists. */
  thumbUrl: string;
  /** About 600 px (iTunes) or 500 px (Cover Art Archive), for previews. */
  mediumUrl?: string;
  /** About 1200 px, for printing at 300 dpi. */
  fullUrl: string;
  /** Requested edge length of fullUrl in px; the server may deliver less if the original is smaller. */
  sizeHint?: number;
  /**
   * The single edition this picture shows (a MusicBrainz release id), for
   * cassette covers: editions of the same album often have different inlays,
   * so they are not merged into one hit.
   */
  edition?: string;
  /** Match quality, higher is better (roughly -1 … 1.5). */
  score: number;
}

export interface CoverSearchResult {
  candidates: CoverCandidate[];
  /** German messages for sources that failed; the candidates of the others are still returned. */
  warnings: string[];
}

export interface CoverSearchOptions {
  fetchFn?: FetchLike;
  signal?: AbortSignal;
  /** Per source, default 12 s. */
  timeoutMs?: number;
  /** Default both; for cassettes MusicBrainz only. */
  sources?: readonly CoverSource[];
  /** Default "cd". */
  kind?: CoverKind;
  /** Shared MusicBrainz limiter (1 request per second) unless given. */
  rateLimiter?: RateLimiter;
  /** Maximum number of results, default 20. */
  limit?: number;
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
const MUSICBRAINZ_RELEASE_SEARCH = 'https://musicbrainz.org/ws/2/release/';
const COVER_ART_ARCHIVE = 'https://coverartarchive.org';
const SOURCE_NAME: Record<CoverSource, string> = { itunes: 'iTunes', musicbrainz: 'MusicBrainz' };

// ---------------------------------------------------------------------------
// Rate limiting

/**
 * Spaces calls at least `intervalMs` apart (MusicBrainz allows one request per
 * second per client). Slots are reserved synchronously, so concurrent callers
 * queue up. A caller that gives up while waiting returns its slot when nobody
 * queued behind it, so an abandoned search does not delay the next one.
 */
export class RateLimiter {
  private nextSlot = 0;

  constructor(
    readonly intervalMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = sleepMs,
  ) {}

  async wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError();
    const t = this.now();
    const start = Math.max(t, this.nextSlot);
    const end = start + this.intervalMs;
    this.nextSlot = end;
    if (start <= t) return;
    try {
      await this.sleep(start - t, signal);
    } catch (err) {
      if (this.nextSlot === end) this.nextSlot = start;
      throw err;
    }
  }
}

const musicBrainzLimiter = new RateLimiter(1100);

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  return typeof DOMException !== 'undefined'
    ? new DOMException('Die Suche wurde abgebrochen.', 'AbortError')
    : Object.assign(new Error('Die Suche wurde abgebrochen.'), { name: 'AbortError' });
}

// ---------------------------------------------------------------------------
// Search

interface SourceResult {
  source: CoverSource;
  candidates: CoverCandidate[];
  warning?: string;
}

/**
 * Searches iTunes and MusicBrainz in parallel and returns the merged, ranked
 * and de-duplicated candidates. A failing source adds a German warning, the
 * other's results still come back; `onProgress` gets the hits of the first
 * source that answers. Aborting via `signal` rejects with an AbortError.
 */
export async function searchCovers(query: CoverQuery, options: CoverSearchOptions = {}): Promise<CoverSearchResult> {
  if (!queryText(query)) {
    return { candidates: [], warnings: ['Gib einen Namen ein, zum Beispiel „Die drei ??? Folge 12“.'] };
  }
  if (options.signal?.aborted) throw abortError();
  const fetchFn: FetchLike = options.fetchFn ?? ((url, init) => fetch(url, init));
  const kind = options.kind ?? 'cd';
  // iTunes has no cassettes: its covers are those of the download, square.
  const sources = (options.sources ?? (['itunes', 'musicbrainz'] as const)).filter((s) => kind === 'cd' || s === 'musicbrainz');
  const timeoutMs = options.timeoutMs ?? 12_000;

  // By source position, so the ranking does not depend on which source answered first.
  const done: (SourceResult | undefined)[] = sources.map(() => undefined);
  const summary = (): CoverSearchResult => {
    const results = done.filter((r): r is SourceResult => r !== undefined);
    const warnings: string[] = [];
    const succeeded = results.filter((r) => !r.warning).map((r) => SOURCE_NAME[r.source]);
    for (const r of results) {
      if (!r.warning) continue;
      warnings.push(succeeded.length > 0 ? `${r.warning} Es werden nur Treffer von ${succeeded.join(' und ')} gezeigt.` : r.warning);
    }
    const candidates = rankCandidates(query, results.flatMap((r) => r.candidates).filter((c) => isRelevant(query, c))).slice(0, options.limit ?? 20);
    return { candidates, warnings };
  };

  const runs = sources.map(async (source, i) => {
    let result: SourceResult;
    try {
      const candidates =
        source === 'itunes'
          ? parseItunesResults(await getJson(fetchFn, buildItunesUrl(query), options.signal, timeoutMs))
          : await searchMusicBrainz(fetchFn, query, options, timeoutMs, kind);
      result = { source, candidates };
    } catch (err) {
      if (options.signal?.aborted) throw abortError();
      result = { source, candidates: [], warning: failureMessage(source, err) };
    }
    if (options.signal?.aborted) throw abortError();
    done[i] = result;
    if (done.includes(undefined)) options.onProgress?.(summary());
  });
  await Promise.all(runs);
  if (options.signal?.aborted) throw abortError();
  return summary();
}

async function searchMusicBrainz(
  fetchFn: FetchLike,
  query: CoverQuery,
  options: CoverSearchOptions,
  timeoutMs: number,
  kind: CoverKind,
): Promise<CoverCandidate[]> {
  await (options.rateLimiter ?? musicBrainzLimiter).wait(options.signal);
  return parseMusicBrainzResults(await getJson(fetchFn, buildMusicBrainzUrl(query, kind), options.signal, timeoutMs), kind);
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}

class TimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'TimeoutError';
  }
}

class FormatError extends Error {
  constructor() {
    super('unexpected response');
    this.name = 'FormatError';
  }
}

/**
 * Runs `request` with a signal that follows the caller's `signal` and also
 * aborts after `timeoutMs`; running out of time rejects with a TimeoutError.
 */
async function withTimeout<T>(signal: AbortSignal | undefined, timeoutMs: number, request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await request(controller.signal);
  } catch (err) {
    if (timedOut) throw new TimeoutError();
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function getJson(fetchFn: FetchLike, url: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<unknown> {
  return withTimeout(signal, timeoutMs, async (timed) => {
    const res = await fetchFn(url, { signal: timed, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new HttpError(res.status);
    try {
      return await res.json();
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new FormatError();
    }
  });
}

function failureMessage(source: CoverSource, err: unknown): string {
  const name = SOURCE_NAME[source];
  if (err instanceof HttpError) {
    if (err.status === 503 || err.status === 429) return `${name} ist gerade ausgelastet. Warte ein paar Sekunden und suche noch einmal.`;
    return `${name} hat mit einem Fehler geantwortet (${err.status}). Versuche es später noch einmal.`;
  }
  if (err instanceof TimeoutError) return `${name} antwortet gerade nicht. Versuche es später noch einmal.`;
  if (err instanceof FormatError) return `${name} hat eine unerwartete Antwort geschickt. Versuche es später noch einmal.`;
  return `Die Suche bei ${name} hat nicht geklappt. Prüfe die Internetverbindung und versuche es noch einmal.`;
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
      ? 'Der Server antwortet gerade nicht. Versuche es gleich noch einmal oder nimm ein anderes Bild.'
      : 'Der Server gibt das Bild nicht heraus. Speichere es selbst auf deinem Computer und wähle es dann unter „Eigenes Bild“ aus.',
  );
}

// ---------------------------------------------------------------------------
// Request URLs

function queryText(q: CoverQuery): string {
  return [q.artist, q.album, q.title, q.query]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

export function buildItunesUrl(q: CoverQuery): string {
  const params = new URLSearchParams({ term: queryText(q), entity: 'album', limit: '12', country: 'DE' });
  return `${ITUNES_SEARCH}?${params.toString()}`;
}

/** Lucene query for the MusicBrainz release index; for cassettes only editions on cassette. */
export function buildMusicBrainzQuery(q: CoverQuery, kind: CoverKind = 'cd'): string {
  const artist = (q.artist ?? '').trim();
  const release = luceneTerms([q.album, q.title, q.query].map((s) => (s ?? '').trim()).filter(Boolean).join(' '));
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

export function buildMusicBrainzUrl(q: CoverQuery, kind: CoverKind = 'cd'): string {
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

/**
 * Whether a hit is about what was searched at all: at least half of the
 * searched words (articles and numbers aside) in its title or artist.
 * "Der Tod" or "Der unheimliche Phantoll" for "Der Räuber Hotzenplotz" are not.
 */
export function isRelevant(query: CoverQuery, candidate: Pick<CoverCandidate, 'title' | 'artist'>): boolean {
  const qTokens = contentTokens(normalizeForMatch(queryText(query)));
  if (!qTokens.length) return true;
  return coverage(qTokens, [...contentTokens(normalizeForMatch(candidate.title)), ...contentTokens(normalizeForMatch(candidate.artist))]) >= 0.5;
}

/** Match quality of one candidate for the query, roughly -1 … 1.5. */
export function scoreCandidate(query: CoverQuery, candidate: Pick<CoverCandidate, 'title' | 'artist' | 'source'> & { mbScore?: number }): number {
  const text = queryText(query);
  const qTokens = contentTokens(normalizeForMatch(text));
  const titleTokens = contentTokens(normalizeForMatch(candidate.title));
  const artistTokens = contentTokens(normalizeForMatch(candidate.artist));
  const all = [...titleTokens, ...artistTokens];

  let score = 0.55 * coverage(qTokens, all) + 0.15 * coverage(titleTokens, qTokens);
  if (query.artist?.trim()) score += 0.2 * coverage(contentTokens(normalizeForMatch(query.artist)), artistTokens);

  const wanted = episodeNumbers([query.album, query.title, query.query].filter(Boolean).join(' '));
  const collection = isCollection(candidate.title);
  if (wanted.length > 0) {
    const found = episodeNumbers(candidate.title);
    // The right number only helps as far as the series matches too: "Die drei !!! Folge 12" is a
    // poor hit for "Die drei ??? Folge 12". A wrong number always costs.
    const seriesMatch = qTokens.length > 0 ? coverage(qTokens, all) ** 2 : 1;
    if (found.some((n) => wanted.includes(n))) score += (collection ? 0.1 : 0.35) * seriesMatch;
    else score -= found.length > 0 ? 0.35 : 0.1;
  }
  if (collection && !isCollection(text)) score -= 0.12;
  score += candidate.source === 'itunes' ? 0.02 : 0.02 * ((candidate.mbScore ?? 0) / 100) - 0.01;
  return Math.round(score * 1000) / 1000;
}

/**
 * Scores, removes duplicates (same artist and title; the better one stays,
 * iTunes on a tie because its artwork always exists) and sorts best first.
 */
export function rankCandidates(query: CoverQuery, candidates: readonly (CoverCandidate & { mbScore?: number })[]): CoverCandidate[] {
  const scored = candidates.map((c, order) => {
    const { mbScore: _ignored, ...rest } = c;
    return { candidate: { ...rest, score: scoreCandidate(query, c) }, order };
  });
  scored.sort(
    (a, b) =>
      b.candidate.score - a.candidate.score ||
      (a.candidate.source === b.candidate.source ? 0 : a.candidate.source === 'itunes' ? -1 : 1) ||
      a.order - b.order,
  );
  const seen = new Set<string>();
  const out: CoverCandidate[] = [];
  for (const { candidate } of scored) {
    const key = sameAlbumKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

/** Hits with this key show the same album (rankCandidates keeps only one of them); editions of cassettes stay apart. */
export function sameAlbumKey(c: Pick<CoverCandidate, 'artist' | 'title' | 'edition'>): string {
  const key = `${normalizeForMatch(c.artist)}|${normalizeForMatch(c.title)}`;
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
