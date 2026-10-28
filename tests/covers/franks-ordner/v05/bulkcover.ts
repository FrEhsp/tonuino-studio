// Frozen copy of src/core/stickers/bulkcover.ts as of 0.5.1 (commit 0f1ab0a3), for the before/after measurement only.
/**
 * Finding covers for many folders at once: which folders need one, what to
 * search for, which hits are good enough to take without a second look, and
 * the state of each row while the user goes through the proposals.
 *
 * Nothing here touches the card. The dialog shows the proposals; covers are
 * saved only after the user confirms (see setCovers in app/state.ts).
 */

import type { Catalog, CatalogFolder } from '../../../../src/core/tonuino/catalog';
import { folderName, type SdScan } from '../../../../src/core/tonuino/sd';
import { episodeNumbers, normalizeForMatch, RateLimiter, type CoverCandidate, type CoverQuery, type CoverSearchResult } from './coversearch';
import { isAbortError } from '../../../../src/core/stickers/image';

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
    out.push({ folder: f.number, title, detail: lead && !containsWords(title, lead) ? lead : undefined, query, specific: !!query && namesOneAlbum(entry) });
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
  const lead = series || artist;
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

/** True when the text has at least one word that tells audio plays apart (not just "Folge 1"). */
export function isSearchable(query: string): boolean {
  return normalizeForMatch(query)
    .split(' ')
    .some((w) => w.length >= 2 && !/^\d+$/.test(w) && !GENERIC_WORDS.has(w));
}

// ---------------------------------------------------------------------------
// Good enough to take?

/**
 * Score (see scoreCandidate) from which the best hit is ticked right away.
 * Below it a row starts unticked with "Unsicher – bitte prüfen". Calibrated
 * with tests/stickers/bulkcover.test.ts: the right episode of the right
 * series scores about 0.9 to 1.1, the right album of an artist about 0.7, a
 * hit that shares one word with the name 0.4 or less.
 */
export const CONFIDENT_SCORE = 0.6;

/** The best hit plus up to four others to choose from. */
export const MAX_CHOICES = 5;

/**
 * True when the hit can be ticked without a second look: the folder name
 * points at one album (see namesOneAlbum), the score is high enough and,
 * when the name has an episode number, the hit has the same number.
 */
export function isConfident(target: Pick<BulkTarget, 'query' | 'specific'>, candidate: Pick<CoverCandidate, 'title' | 'score'> | undefined): boolean {
  if (!candidate || !target.specific || candidate.score < CONFIDENT_SCORE) return false;
  const wanted = episodeNumbers(target.query);
  return !wanted.length || episodeNumbers(candidate.title).some((n) => wanted.includes(n));
}

/** True when no service answered at all (as opposed to answering "nothing found"). */
export function isUnreachable(result: CoverSearchResult, sourceCount = 2): boolean {
  return result.candidates.length === 0 && result.warnings.length >= sourceCount;
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
  return result.candidates.length === 0 && result.warnings.length > 0;
}

/** The row once its search has answered. A choice the user made meanwhile (own picture) stays. */
export function withResult(row: BulkRow, result: CoverSearchResult): BulkRow {
  if (searchFailed(result)) return { ...row, status: 'failed', candidates: [], confident: false, ...(row.touched ? {} : { choice: { kind: 'none' }, checked: false }) };
  return autoChoose({ ...row, status: result.candidates.length ? 'found' : 'nothing', candidates: result.candidates.slice(0, MAX_CHOICES) });
}

/** Proposes the best hit; ticked only when it is a confident one. Rows the user touched keep their choice. */
function autoChoose(row: BulkRow): BulkRow {
  const best = row.candidates[0];
  const confident = isConfident(row.target, best);
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
  if (!wasChoice) return { ...next, confident: isConfident(row.target, candidates[0]) };
  if (row.touched) return { ...next, choice: { kind: 'none' }, checked: false, confident: isConfident(row.target, candidates[0]) };
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
 * Spacing between two searches. Every search asks iTunes once, and Apple
 * allows about 20 requests a minute; MusicBrainz keeps its own limit of one
 * request a second inside searchCovers.
 */
export const SEARCH_SPACING_MS = 3000;
export const searchSpacing = new RateLimiter(SEARCH_SPACING_MS);

/** At most this many searches run at the same time. */
export const SEARCH_CONCURRENCY = 2;

export const UNREACHABLE_MESSAGE = 'Ich erreiche gerade weder iTunes noch MusicBrainz, oder beide sind ausgelastet. Prüfe die Internetverbindung und versuche es in ein paar Minuten noch einmal. Geändert wurde nichts.';
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
  /** Runs one search, normally searchCovers with the app's fetch. */
  search: (query: CoverQuery, signal: AbortSignal) => Promise<CoverSearchResult>;
  signal?: AbortSignal;
  concurrency?: number;
  /** Spaces the searches; the shared limiter unless given. */
  spacing?: RateLimiter;
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
        result = await opts.search({ query: target.query }, inner.signal);
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

function abortError(): Error {
  return typeof DOMException !== 'undefined'
    ? new DOMException('Die Suche wurde abgebrochen.', 'AbortError')
    : Object.assign(new Error('Die Suche wurde abgebrochen.'), { name: 'AbortError' });
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
