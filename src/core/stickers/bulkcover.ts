/**
 * Finding covers for many folders at once: which folders need one, what to
 * search for, which hits are good enough to take without a second look, and
 * the state of each row while the user goes through the proposals.
 *
 * Nothing here touches the card. The dialog shows the proposals; covers are
 * saved only after the user confirms (see setCovers in app/state.ts).
 */

import { commercialSeriesIn } from '../sources/commercial';
import { cleanArtist, cleanForSearch, isDoubtfulVersion, isVariousArtists, prepareQuery, variantOf, variantsFit, type PreparedQuery } from '../covers/names';
import { abortError, RateLimiter, type Limiter } from '../covers/net';
import { compareRelease } from '../library/releasename';
import type { Catalog, CatalogFolder } from '../tonuino/catalog';
import { folderName, type SdScan } from '../tonuino/sd';
import { episodeNumbers, normalizeForMatch, type CoverCandidate, type CoverQuery, type CoverSearchResult } from './coversearch';
import { isAbortError } from './image';

// ---------------------------------------------------------------------------
// Which folders

export interface BulkTarget {
  folder: number;
  /** As the shelf shows it. */
  title: string;
  /** Series or artist, when the title does not say it. */
  detail?: string;
  /** What is searched for; empty when the name says too little to search. */
  query: string;
  /** The same in parts (artist or series, and the album), as the services get it; missing: `query` as free text. */
  search?: CoverQuery;
  /**
   * The name points at one album, not just at an artist, a series or a kind
   * of music ("Kinderlieder"). Only then can a hit start ticked.
   */
  specific: boolean;
}

/** True when the folder's catalog entry names a picture that is in the cover zip. */
export function folderHasCover(entry: Pick<CatalogFolder, 'cover'> | undefined, covers: { has(name: string): boolean }): boolean {
  return !!entry?.cover && covers.has(entry.cover);
}

/**
 * Folders on the card that the catalog knows and that have no cover yet, in
 * folder order. Folders the app does not know yet (copied with another
 * program) are left out: "Übernehmen" on Meine Box gives them a name first.
 * `only` limits the list to these folder numbers.
 */
export function coverlessFolders(
  scan: Pick<SdScan, 'folders'>,
  catalog: Pick<Catalog, 'folders'> | null | undefined,
  covers: { has(name: string): boolean },
  only?: readonly number[],
): BulkTarget[] {
  const out: BulkTarget[] = [];
  for (const f of [...scan.folders].sort((a, b) => a.number - b.number)) {
    if (only && !only.includes(f.number)) continue;
    const entry = catalog?.folders[f.name];
    if (!entry || folderHasCover(entry, covers)) continue;
    const query = buildFolderQuery(entry);
    const title = entry.title?.trim() || `Ordner ${folderName(f.number)}`;
    const lead = (entry.series ?? entry.artist ?? '').trim();
    out.push({
      folder: f.number,
      title,
      detail: lead && !containsWords(title, lead) ? lead : undefined,
      query,
      ...(query ? { search: buildFolderSearch(entry) } : {}),
      specific: !!query && namesOneAlbum(entry),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// What to search for

/** Titles the app gives folders it knows nothing about. */
const PLACEHOLDER_TITLE = /^(?:ordner|folder)\s*\d{1,3}$/i;
/** Artist tags that name no one. */
const NO_ARTIST = /^(?:various(?: artists)?|va|diverse(?: interpreten)?|verschiedene(?: interpreten)?|unbekannt|unknown(?: artist)?|interpret)$/i;
/** Words that say nothing about which audio play it is. */
const GENERIC_WORDS = new Set([
  'folge', 'folgen', 'teil', 'kapitel', 'episode', 'band', 'vol', 'volume', 'nr', 'nummer', 'no', 'cd', 'mp3', 'track', 'titel',
  'ordner', 'folder', 'hoerspiel', 'hoerspiele', 'hoerbuch', 'hoerbuecher', 'audio', 'musik', 'lieder', 'album', 'neu',
  'die', 'der', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'und', 'mit', 'von', 'the', 'a', 'of',
]);

/**
 * Words that many albums share: a title made only of them ("Kinderlieder",
 * "Gute Nacht Geschichten") fits dozens of compilations. Compared after
 * normalizeForMatch (ä → ae and so on).
 */
const COMMON_TITLE_WORDS = new Set([
  'kinder', 'kids', 'baby', 'gute', 'nacht', 'gutenacht', 'schlafen', 'einschlafen', 'traeumen', 'mitsingen', 'singen', 'tanzen',
  'spielen', 'lernen', 'beste', 'besten', 'best', 'top', 'hit', 'party', 'disco', 'spass', 'lustige', 'lustigsten', 'schoene',
  'schoenste', 'schoensten', 'neue', 'neuen', 'alte', 'alle', 'grosse', 'kleine', 'meine', 'mein', 'unsere', 'deine', 'fuer', 'zum',
  'zur', 'im', 'in', 'am', 'an', 'auf', 'weihnachten', 'weihnacht', 'advent', 'ostern', 'sommer', 'winter', 'herbst', 'fruehling',
  'geburtstag', 'klassik', 'klassiker', 'sammlung', 'collection', 'compilation', 'mix', 'playlist',
]);
/** Compounds like "Weihnachtslieder", "Einschlafgeschichten", "Kinderhits". */
const COMMON_WORD_END = /(?:lieder|liedern|songs|hits|geschichten|maerchen|musik|reime|verse)$/;

function contentWords(text: string): string[] {
  return normalizeForMatch(text)
    .split(' ')
    .filter((w) => w.length >= 2 && !/^\d+$/.test(w) && !GENERIC_WORDS.has(w));
}

const isCommonWord = (w: string) => COMMON_TITLE_WORDS.has(w) || COMMON_WORD_END.test(w);

/**
 * True when the folder name points at one album, so that a hit with a good
 * score may start ticked. Not so when the name is only an artist or a series
 * (a folder "Ordner 05" with the artist tag "Rolf Zuckowski": every album of
 * his scores well), or only common words ("Kinderlieder"). A series with an
 * episode number ("TKKG Folge 7") does name one album.
 */
export function namesOneAlbum(entry: Pick<CatalogFolder, 'title' | 'artist' | 'series' | 'episode'>): boolean {
  const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  let title = clean(entry.title);
  if (PLACEHOLDER_TITLE.test(title)) title = '';
  const series = clean(entry.series);
  const artist = NO_ARTIST.test(clean(entry.artist)) ? '' : clean(entry.artist);
  let lead = series || artist;
  // An artist tag that repeats the album's name ("Unter meinem Bett" by "Unter meinem Bett") says nothing more,
  // unless the name is that of a well-known series ("Bibi Blocksberg" by "Bibi Blocksberg": any episode would fit).
  if (lead && normalizeForMatch(lead) === normalizeForMatch(title) && !isSeriesName(title)) lead = '';
  const leadWords = new Set(contentWords(lead));
  const titleWords = contentWords(title);
  // At least one word of the title says which album it is, and the whole name has two such words.
  const own = titleWords.filter((w) => !leadWords.has(w) && !isCommonWord(w));
  const all = new Set([...leadWords, ...titleWords.filter((w) => !isCommonWord(w))]);
  if (own.length >= 1 && all.size >= 2) return true;
  // A series and an episode number name one episode, also when both are in the title ("TKKG Folge 7").
  const episode = (entry.episode && entry.episode > 0) || episodeNumbers(title).length > 0;
  return episode && (!!lead || own.length > 0);
}

/** True when the name is just that of a well-known series ("Bibi Blocksberg", "TKKG"). */
function isSeriesName(name: string): boolean {
  const series = commercialSeriesIn(name);
  const n = normalizeForMatch(name);
  return !!series && [series.name, ...series.match, ...(series.alone ?? [])].some((m) => normalizeForMatch(m) === n);
}

/** True when every word of `inner` appears as a word in `outer` (after normalising umlauts, "???" and so on). */
function containsWords(outer: string, inner: string): boolean {
  const o = ` ${normalizeForMatch(outer)} `;
  const i = normalizeForMatch(inner);
  return !!i && o.includes(` ${i} `);
}

/**
 * The search text for a folder, like the folder page builds it: series (or
 * else artist) and title, plus "Folge N" when the episode number is not in
 * the title yet. Empty for folders without a real name ("Ordner 05").
 */
export function buildFolderQuery(entry: Pick<CatalogFolder, 'title' | 'artist' | 'series' | 'episode'>): string {
  const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  let title = clean(entry.title);
  if (PLACEHOLDER_TITLE.test(title)) title = '';
  const series = clean(entry.series);
  const artist = NO_ARTIST.test(clean(entry.artist)) ? '' : clean(entry.artist);
  const parts: string[] = [];
  const lead = series || artist;
  if (lead && !containsWords(title, lead)) parts.push(lead);
  if (title) parts.push(title);
  const episode = entry.episode;
  if (episode && episode > 0 && (parts.length || series) && !episodeNumbers(parts.join(' ')).includes(episode)) parts.push(`Folge ${episode}`);
  const query = parts.join(' ').trim();
  return isSearchable(query) ? query.slice(0, 150) : '';
}

/**
 * The search for a folder in parts: the series (or else the artist tag) as
 * artist, and the title with "Folge N" when the number is not in it yet.
 * The services get the artist and the cleaned title (names.ts); a service
 * that finds nothing with the artist is asked once more without it, for
 * artist tags that are the title of a track.
 */
export function buildFolderSearch(entry: Pick<CatalogFolder, 'title' | 'artist' | 'series' | 'episode'>): CoverQuery {
  const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  let title = clean(entry.title);
  if (PLACEHOLDER_TITLE.test(title)) title = '';
  const lead = clean(entry.series) || cleanArtist(entry.artist) || '';
  const episode = entry.episode;
  const album = episode && episode > 0 && (title || lead) && !episodeNumbers(`${lead} ${title}`).includes(episode) ? `${title} Folge ${episode}`.trim() : title;
  return lead ? { artist: lead, album: album || lead } : { album };
}

/** True when the text has at least one word that tells audio plays apart (not just "Folge 1"). */
export function isSearchable(query: string): boolean {
  return normalizeForMatch(query)
    .split(' ')
    .some((w) => w.length >= 2 && !/^\d+$/.test(w) && !GENERIC_WORDS.has(w));
}

// ---------------------------------------------------------------------------
// Good enough to take?

/**
 * Score (see scoreCandidate) a hit needs at least to be taken without a
 * look. Only a floor: the checks of isConfident decide. The right episode
 * of the right series scores about 0.9 to 1.1, the right album of an
 * artist about 0.9, one with an artist tag that is really a track's title
 * (TODO #110) about 0.5, a hit that shares one word with the name 0.3 or
 * less.
 */
export const CONFIDENT_SCORE = 0.35;

/** The best hit plus up to four others to choose from. */
export const MAX_CHOICES = 5;

export interface ConfidenceTarget {
  query: string;
  specific: boolean;
  search?: CoverQuery;
}

/** The artist of the folder in the hit: in its artist (word for word, either way round), or as the series in its title. */
function artistFits(artist: string, hit: Pick<CoverCandidate, 'title' | 'artist'>): boolean {
  const words = (s: string) => normalizeForMatch(s).split(' ').filter((w) => w.length >= 2 && !ARTIST_FILLERS.has(w));
  const ours = words(artist);
  if (!ours.length) return true;
  const theirs = words(hit.artist);
  const share = (a: string[], b: string[]) => (a.length ? a.filter((w) => b.includes(w)).length / a.length : 0);
  // "Die drei ???" is not "Die drei !!!": half the words are not enough.
  if (Math.max(share(ours, theirs), share(theirs, ours)) >= 0.6) return true;
  return share(ours, words(hit.title)) === 1;
}
const ARTIST_FILLERS = new Set(['the', 'die', 'der', 'das', 'und', 'and', 'feat', 'featuring', 'mit', 'seine', 'ihre', 'freunde', 'friends', 'band', 'orchester', 'ensemble']);

/** An episode label in front of a title: "Folge 3: ", "003 - ", "Teil 2/". */
const EPISODE_LABEL = /^\s*(?:(?:folge|episode|teil|band|nr\.?|no\.?|vol\.?)\s*)?\d{1,4}\s*[:./–—-]\s+/i;

/**
 * Whether the hit can be the folder's album at all: the same episode number
 * (none the name does not have), not a karaoke or tribute version the name
 * did not ask for, of a kind that fits ("Lesung" is no "Hörspiel"), by the
 * folder's artist or series (or a compilation of various artists).
 */
function fitsName(p: PreparedQuery, hit: Pick<CoverCandidate, 'title' | 'artist'>): boolean {
  const title = cleanForSearch(hit.title);
  const found = episodeNumbers(title);
  if (p.episodes.length) {
    if (!found.some((n) => p.episodes.includes(n))) return false;
  } else {
    // "Folge 3: Hexen gibt es doch" is the folder "Hexen gibt es doch"; "Unter meinem Bett 3" is not "Unter meinem Bett".
    const inName = episodeNumbers(title.replace(EPISODE_LABEL, ''));
    if (inName.some((n) => !episodeNumbers(p.raw).includes(n))) return false;
  }
  if (isDoubtfulVersion(`${hit.title} ${hit.artist}`, p.raw)) return false;
  const kind = variantOf(hit.title);
  if (!variantsFit(p.variant, kind)) return false;
  // A reading, a soundtrack, a live album says so in its name; most audio plays do not.
  if (p.variant && p.variant !== 'hoerspiel' && kind !== p.variant) return false;
  return !p.artist || isVariousArtists(hit.artist) || artistFits(p.artist, hit);
}

/**
 * The name of the folder and the hit name the same release, word for word
 * or with the same episode number (compareRelease). Also the names alone,
 * when the artist is called like the album ("Die Eule findet den Beat" by
 * "Eule findet den Beat"): fitsName has checked the artist then.
 */
function matchesName(p: PreparedQuery, hit: Pick<CoverCandidate, 'title' | 'artist'>) {
  const album = p.album || p.text;
  const title = cleanForSearch(hit.title);
  const withArtists = compareRelease({ album, artist: p.artist }, { album: title, artist: isVariousArtists(hit.artist) ? undefined : hit.artist });
  if (withArtists.same || !p.artist) return withArtists;
  const names = compareRelease({ album }, { album: title });
  return names.strong ? names : withArtists;
}

/** Two hits show the same release: the same artist, the same name and a kind that fits. Cassette editions count apart. */
export function sameRelease(a: Pick<CoverCandidate, 'title' | 'artist'> & Partial<Pick<CoverCandidate, 'edition'>>, b: Pick<CoverCandidate, 'title' | 'artist'> & Partial<Pick<CoverCandidate, 'edition'>>): boolean {
  if (a.edition && b.edition && a.edition !== b.edition) return false;
  if (!variantsFit(variantOf(a.title), variantOf(b.title))) return false;
  if (!(isVariousArtists(a.artist) && isVariousArtists(b.artist)) && !artistFits(a.artist, b)) return false;
  return compareRelease({ album: cleanForSearch(a.title), artist: a.artist }, { album: cleanForSearch(b.title), artist: b.artist }).strong;
}

/**
 * True when the hit can be taken without a second look (TODO #133):
 *
 * - the folder name points at one album (namesOneAlbum), not only at an
 *   artist or a series;
 * - the hit can be it (fitsName: number, version, kind, artist);
 * - its name is the folder's word for word or with the same episode number
 *   (both cleaned, so "Disc 1" or "(Remastered 2009)" do not matter), or
 *   two services have it under the same name;
 * - no other hit of another album fits just as well (the soundtrack and the
 *   audio play of a film, when the name does not say which);
 * - and its score is not low.
 *
 * `others`: the other hits of the search, for agreement and rivals.
 */
export type ConfidenceHit = Pick<CoverCandidate, 'title' | 'score'> & Partial<Pick<CoverCandidate, 'artist' | 'source' | 'alsoFrom' | 'edition'>>;

export function isConfident(target: ConfidenceTarget, hit: ConfidenceHit | undefined, hits: readonly ConfidenceHit[] = []): boolean {
  if (!hit || !target.specific || hit.score < CONFIDENT_SCORE) return false;
  const candidate = { artist: '', ...hit };
  const others = hits.map((o) => (o === hit ? candidate : { artist: '', ...o }));
  const p = prepareQuery(target.search ?? { query: target.query });
  if (!fitsName(p, candidate)) return false;
  const match = matchesName(p, candidate);
  if (!match.same) return false;
  const agreed = !!candidate.alsoFrom?.length || others.some((o) => o !== candidate && o.source !== candidate.source && sameRelease(o, candidate));
  if (!match.strong && !agreed) return false;
  const preferred = !!p.variant && variantOf(candidate.title) === p.variant;
  const rival = others.some(
    (o) =>
      o !== candidate &&
      !sameRelease(o, candidate) &&
      !(preferred && variantOf(o.title) !== p.variant) &&
      fitsName(p, o) &&
      matchesName(p, o).strong &&
      // A compilation of the same name only rivals another compilation.
      (isVariousArtists(o.artist) === isVariousArtists(candidate.artist) || !p.artist),
  );
  return !rival;
}

/** True when no service answered at all (as opposed to answering "nothing found"). */
export function isUnreachable(result: CoverSearchResult, sourceCount = 2): boolean {
  if (result.candidates.length) return false;
  if (result.asked) return result.asked.length > 0 && (result.failed?.length ?? 0) >= result.asked.length;
  return result.warnings.length >= sourceCount;
}

// ---------------------------------------------------------------------------
// Rows

export type RowStatus =
  /** Not searched yet. */
  | 'waiting'
  | 'searching'
  /** Hits to choose from. */
  | 'found'
  /** The services answered, but had nothing. */
  | 'nothing'
  /**
   * No hits, and at least one service did not answer: maybe that one would
   * have had something. Worth searching again.
   */
  | 'failed'
  /** The name says too little to search. */
  | 'noName'
  /** The search was stopped before this folder. */
  | 'stopped';

export type RowChoice = { kind: 'candidate'; id: string } | { kind: 'own' } | { kind: 'none' };

export interface BulkRow {
  target: BulkTarget;
  status: RowStatus;
  /** Best first, at most MAX_CHOICES; hits whose picture does not load are taken out. */
  candidates: CoverCandidate[];
  choice: RowChoice;
  /** Take this row's cover when the user confirms. */
  checked: boolean;
  /** The best hit was good enough to start ticked. */
  confident: boolean;
  /** The user picked something in this row: automatic changes leave it alone. */
  touched: boolean;
  /** Saved on the card. */
  saved: boolean;
  /** Why saving this row did not work, and what to do. */
  error?: string;
}

export function newRows(targets: readonly BulkTarget[]): BulkRow[] {
  return targets.map((target) => ({
    target,
    status: target.query ? 'waiting' : 'noName',
    candidates: [],
    choice: { kind: 'none' },
    checked: false,
    confident: false,
    touched: false,
    saved: false,
  }));
}

/** True when the search found nothing because a service did not answer, not because there is nothing. */
export function searchFailed(result: CoverSearchResult): boolean {
  // With hits, a service that did not answer is left out without a word (TODO #110: a web filter).
  if (result.candidates.length) return false;
  return result.asked ? (result.failed?.length ?? 0) > 0 : result.warnings.length > 0;
}

/** The row once its search has answered. A choice the user made meanwhile (own picture) stays. */
export function withResult(row: BulkRow, result: CoverSearchResult): BulkRow {
  if (searchFailed(result)) return { ...row, status: 'failed', candidates: [], confident: false, ...(row.touched ? {} : { choice: { kind: 'none' }, checked: false }) };
  return autoChoose({ ...row, status: result.candidates.length ? 'found' : 'nothing', candidates: result.candidates.slice(0, MAX_CHOICES) });
}

/** Proposes the best hit; ticked only when it is a confident one. Rows the user touched keep their choice. */
function autoChoose(row: BulkRow): BulkRow {
  const best = row.candidates[0];
  const confident = isConfident(row.target, best, row.candidates);
  if (row.touched) return { ...row, confident };
  return { ...row, confident, choice: best ? { kind: 'candidate', id: best.id } : { kind: 'none' }, checked: !!best && confident };
}

export function withStatus(row: BulkRow, status: RowStatus): BulkRow {
  return { ...row, status };
}

/** The user picked this hit: it becomes the choice and is ticked. */
export function pickCandidate(row: BulkRow, id: string): BulkRow {
  if (!row.candidates.some((c) => c.id === id)) return row;
  return { ...row, choice: { kind: 'candidate', id }, checked: true, touched: true, error: undefined };
}

/** "Kein passendes": nothing is saved for this folder. */
export function pickNone(row: BulkRow): BulkRow {
  return { ...row, choice: { kind: 'none' }, checked: false, touched: true, error: undefined };
}

/** "Eigenes Bild …": a picture from the computer, ticked. */
export function pickOwn(row: BulkRow): BulkRow {
  return { ...row, choice: { kind: 'own' }, checked: true, touched: true, error: undefined };
}

/** Ticking needs something to take; unticking keeps the choice for later. */
export function setChecked(row: BulkRow, checked: boolean): BulkRow {
  if (checked && row.choice.kind === 'none') return row;
  return { ...row, checked, touched: true };
}

/**
 * A hit whose picture does not load (MusicBrainz often has none) leaves the
 * row. Was it the choice, the next best becomes the proposal and is judged
 * again; a row the user touched is not ticked again by itself.
 */
export function dropCandidate(row: BulkRow, id: string): BulkRow {
  if (!row.candidates.some((c) => c.id === id)) return row;
  const candidates = row.candidates.filter((c) => c.id !== id);
  const wasChoice = row.choice.kind === 'candidate' && row.choice.id === id;
  const next: BulkRow = { ...row, candidates, status: candidates.length || row.status !== 'found' ? row.status : 'nothing' };
  if (!wasChoice) return { ...next, confident: isConfident(row.target, candidates[0], candidates) };
  if (row.touched) return { ...next, choice: { kind: 'none' }, checked: false, confident: isConfident(row.target, candidates[0], candidates) };
  return autoChoose(next);
}

export function chosenCandidate(row: BulkRow): CoverCandidate | undefined {
  const choice = row.choice;
  return choice.kind === 'candidate' ? row.candidates.find((c) => c.id === choice.id) : undefined;
}

/** Rows to save on "Ausgewählte übernehmen". */
export function rowsToSave(rows: readonly BulkRow[]): BulkRow[] {
  return rows.filter((r) => r.checked && !r.saved && (r.choice.kind === 'own' || !!chosenCandidate(r)));
}

/** Folders searched so far, for "12 von 30". */
export function searchProgress(rows: readonly BulkRow[]): { done: number; total: number } {
  const searchable = rows.filter((r) => r.target.query);
  return { done: searchable.filter((r) => r.status !== 'waiting' && r.status !== 'searching').length, total: searchable.length };
}

/** The row has a proposal that needs a look: a weak best hit nobody decided on yet. */
export function needsLook(row: BulkRow): boolean {
  return row.status === 'found' && !row.confident && !row.touched && !row.saved;
}

/** The line above the rows once the search is through. */
export function reviewSummary(rows: readonly BulkRow[]): string {
  if (!rows.some((r) => r.target.query)) return 'Für diese Ordner suche ich nicht, weil genaue Namen fehlen. Nimm für jeden ein eigenes Bild.';
  const total = rows.length;
  const proposed = rows.filter((r) => r.status === 'found' && r.candidates.length).length;
  const unsure = rows.filter(needsLook).length;
  const failed = rows.filter((r) => r.status === 'failed' && !r.saved).length;
  const notAnswered = !failed
    ? ''
    : `Bei ${failed === 1 ? 'einem Ordner' : `${failed} Ordnern`} hat die Suche nicht geklappt, weil ein Dienst nicht geantwortet hat.`;
  if (!proposed) {
    return failed
      ? `${notAnswered} Versuche es noch einmal oder nimm ein eigenes Bild.`
      : 'Für keinen Ordner gab es einen Treffer. Nimm ein eigenes Bild oder gib den Ordnern genauere Namen.';
  }
  const head =
    proposed === total
      ? total === 1
        ? 'Für den Ordner gibt es einen Vorschlag.'
        : `Für alle ${total} Ordner gibt es einen Vorschlag.`
      : `Für ${proposed} von ${total} Ordnern gibt es einen Vorschlag.`;
  const look = !unsure ? '' : unsure === 1 ? ' Einer ist unsicher: Sieh ihn dir an und hake ihn an, wenn er passt.' : ` ${unsure} sind unsicher: Sieh sie dir an und hake sie an, wenn sie passen.`;
  return `${head}${look}${notAnswered ? ` ${notAnswered}` : ''} Ein anderes Bild nimmst du, indem du es anklickst.`;
}

// ---------------------------------------------------------------------------
// Searching politely

/**
 * Spacing between two searches of a run. None any more: each service keeps
 * its own pace for the whole app (src/core/covers/net.ts), so iTunes and
 * Deezer answer folder after folder while MusicBrainz takes its turns.
 */
export const SEARCH_SPACING_MS = 0;
export const searchSpacing = new RateLimiter(SEARCH_SPACING_MS);

/** About this long per folder, for the time the dialog announces (measured with tests/covers/franks-ordner). */
export const SEARCH_SECONDS_PER_FOLDER = 1.5;

/** At most this many searches run at the same time. */
export const SEARCH_CONCURRENCY = 4;

export const UNREACHABLE_MESSAGE = 'Ich erreiche gerade keinen der Dienste (iTunes, Deezer, MusicBrainz), oder sie sind ausgelastet. Prüfe die Internetverbindung. Blockiert vielleicht ein Filter? Welche Adressen frei sein müssen, steht in der Hilfe unter „Internetfilter und Firewall“. Versuche es in ein paar Minuten noch einmal. Geändert wurde nichts.';
export const OFFLINE_MESSAGE = 'Dein Computer ist gerade nicht mit dem Internet verbunden. Verbinde ihn und versuche es noch einmal. Geändert wurde nichts.';
export const BUSY_MESSAGE = 'iTunes und MusicBrainz sind gerade ausgelastet. Warte ein paar Minuten und versuche es dann noch einmal. Geändert wurde nichts.';

/** The message for a failed name or track search (lookupAlbumTracks and friends): busy (429, 503) or not reachable. */
export function lookupFailureMessage(e: unknown): string {
  return e instanceof Error && /^HTTP (429|503)\b/.test(e.message) ? BUSY_MESSAGE : UNREACHABLE_MESSAGE;
}

/** Neither service answered for the first searches: the whole run stops with UNREACHABLE_MESSAGE. */
export class UnreachableError extends Error {
  constructor() {
    super(UNREACHABLE_MESSAGE);
    this.name = 'UnreachableError';
  }
}

export interface BulkSearchOptions {
  /** Runs one search, normally searchCovers with the app's fetch (and searchOptionsFor the target). */
  search: (query: CoverQuery, signal: AbortSignal, target: BulkTarget) => Promise<CoverSearchResult>;
  signal?: AbortSignal;
  concurrency?: number;
  /** Spaces the searches; none unless given (the services keep their own pace). */
  spacing?: Limiter;
  /** Services asked per search, to tell "nobody answered" from "nothing found". */
  sourceCount?: number;
  onStart?: (folder: number) => void;
  onResult?: (folder: number, result: CoverSearchResult) => void;
}

/**
 * Searches the targets that have a query, at most `concurrency` at a time,
 * spaced by `spacing`. Each answer goes to `onResult` right away. Aborting
 * via `signal` rejects with an AbortError. When the first two searches find
 * neither service (or all searches do, if there are fewer), the run stops
 * and rejects with an UnreachableError: offline, there is no point in going
 * on, and one message says it better than thirty failed rows.
 */
export async function runBulkSearch(targets: readonly BulkTarget[], opts: BulkSearchOptions): Promise<void> {
  const queue = targets.filter((t) => t.query);
  const concurrency = Math.max(1, opts.concurrency ?? SEARCH_CONCURRENCY);
  const spacing = opts.spacing ?? searchSpacing;
  const sourceCount = opts.sourceCount ?? 2;
  // Stops the other searches when the run gives up or the caller cancels.
  const inner = new AbortController();
  const follow = () => inner.abort();
  if (opts.signal?.aborted) throw abortError();
  opts.signal?.addEventListener('abort', follow, { once: true });
  let next = 0;
  let answered = 0;
  let unreachable = 0;
  let gaveUp = false;
  const worker = async () => {
    while (next < queue.length && !inner.signal.aborted) {
      const target = queue[next++];
      await spacing.wait(inner.signal);
      opts.onStart?.(target.folder);
      let result: CoverSearchResult;
      try {
        result = await opts.search(target.search ?? { query: target.query }, inner.signal, target);
      } catch (err) {
        if (inner.signal.aborted || isAbortError(err)) throw err;
        // searchCovers reports failing services as warnings; anything else counts as "nobody answered".
        result = { candidates: [], warnings: new Array<string>(sourceCount).fill('Die Suche hat nicht geklappt.') };
      }
      if (inner.signal.aborted) break;
      if (isUnreachable(result, sourceCount)) unreachable++;
      else answered++;
      opts.onResult?.(target.folder, result);
      if (!answered && unreachable >= Math.min(2, queue.length)) {
        gaveUp = true;
        inner.abort();
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  } catch (err) {
    if (!gaveUp && !(isAbortError(err) && inner.signal.aborted)) throw err;
  } finally {
    opts.signal?.removeEventListener('abort', follow);
  }
  if (gaveUp) throw new UnreachableError();
  if (opts.signal?.aborted) throw abortError();
}


// ---------------------------------------------------------------------------
// Small helpers

/** Runs `fn` for every item, at most `limit` at a time; results in item order. */
export async function inPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}
