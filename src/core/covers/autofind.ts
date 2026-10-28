/**
 * Finding the cover of a folder without one, in the order that is fastest
 * and most often right (TODO #125, #134):
 *
 * 1. a picture lying in the folder (cover.jpg, folder.jpg …) or embedded in
 *    its files (ID3 APIC; FLAC, Ogg and MP4 pictures): offline, at once, and
 *    the folder's own;
 * 2. iTunes and Deezer at the same time;
 * 3. MusicBrainz with the Cover Art Archive only when those two found
 *    nothing sure.
 *
 * A hit is "sure" by isConfident (bulkcover.ts); anything else that was
 * found is offered to choose from. Nothing here writes: the caller decides
 * what to do with a find (src/features/covers/autoCovers.ts saves sure ones
 * on the card, never over a cover that is there).
 */

import { isConfident, isUnreachable, type BulkTarget } from '../stickers/bulkcover';
import { pickFolderImage, type CoverCandidate, type CoverQuery, type CoverSearchOptions, type CoverSearchResult } from '../stickers/coversearch';
import { sniffImageType } from '../stickers/image';
import { abortError } from './net';

export interface LocalPicture {
  data: Uint8Array;
  mimeType: string;
  /** "ordner": an image file in the folder; "datei": embedded in a track. */
  from: 'ordner' | 'datei';
}

export type FolderFind =
  /** The folder brings its own picture. */
  | { kind: 'local'; picture: LocalPicture }
  /** A hit good enough to take without a look; the others to choose from instead. */
  | { kind: 'sure'; candidate: CoverCandidate; candidates: CoverCandidate[] }
  /** Hits, none sure: to choose from. */
  | { kind: 'unsure'; candidates: CoverCandidate[] }
  /** The services answered, but had nothing. */
  | { kind: 'nothing' }
  /** No service answered. */
  | { kind: 'unreachable' }
  /** The name says too little to search. */
  | { kind: 'noName' };

/** What reading a folder needs: its file names and a way to read them. */
export interface FolderFiles {
  /** Track file names in track order. */
  tracks: readonly string[];
  /** Other files of the folder (pictures, playlists …). */
  others: readonly string[];
  /** The whole file. */
  read(name: string, signal?: AbortSignal): Promise<Uint8Array>;
  /** The picture embedded in a track, or null (readTrackInfo with covers). */
  embedded(name: string, signal?: AbortSignal): Promise<{ data: Uint8Array; mimeType: string } | null>;
}

/** Tracks whose tags are read for a picture: the first few are enough, the rest share the album's. */
const TRACKS_LOOKED_AT = 3;
/** A picture file larger than this is no cover (a scan of a booklet, a poster). */
const MAX_PICTURE_BYTES = 12 * 1024 * 1024;

/**
 * The folder's own picture: an image file with a telling name
 * (pickFolderImage), else the one embedded in its first tracks. Null when
 * there is none or nothing could be read.
 */
export async function localCover(files: FolderFiles, signal?: AbortSignal): Promise<LocalPicture | null> {
  const image = pickFolderImage(files.others);
  if (image) {
    try {
      const data = await files.read(image, signal);
      const type = sniffImageType(data);
      if (type && data.length <= MAX_PICTURE_BYTES) return { data, mimeType: type, from: 'ordner' };
    } catch (e) {
      if (signal?.aborted) throw abortError();
      void e;
    }
  }
  for (const name of files.tracks.slice(0, TRACKS_LOOKED_AT)) {
    if (signal?.aborted) throw abortError();
    try {
      const picture = await files.embedded(name, signal);
      if (picture && picture.data.length > 0 && picture.data.length <= MAX_PICTURE_BYTES) {
        return { data: picture.data, mimeType: sniffImageType(picture.data) ?? picture.mimeType, from: 'datei' };
      }
    } catch (e) {
      if (signal?.aborted) throw abortError();
      void e;
    }
  }
  return null;
}

/** The search of one folder: searchCovers with the app's fetch, here with the options the run sets. */
export type FolderSearch = (query: CoverQuery, options: Pick<CoverSearchOptions, 'signal' | 'musicBrainz' | 'enough' | 'limit'>) => Promise<CoverSearchResult>;

/** Options for one folder's search: MusicBrainz only for the rest, done once the hits are sure. */
export function searchOptionsFor(target: Pick<BulkTarget, 'query' | 'specific' | 'search'>, signal?: AbortSignal): Pick<CoverSearchOptions, 'signal' | 'musicBrainz' | 'enough' | 'limit'> {
  return {
    signal,
    musicBrainz: 'rest',
    limit: 8,
    enough: (r) => isConfident(target, r.candidates[0], r.candidates),
  };
}

/** Finds the cover of one folder; `files` when the folder can be read (an open card). */
export async function findFolderCover(target: BulkTarget, deps: { search: FolderSearch; files?: FolderFiles | null; signal?: AbortSignal }): Promise<FolderFind> {
  const { signal } = deps;
  if (deps.files) {
    const own = await localCover(deps.files, signal);
    if (own) return { kind: 'local', picture: own };
  }
  if (!target.query) return { kind: 'noName' };
  if (signal?.aborted) throw abortError();
  const result = await deps.search(target.search ?? { query: target.query }, searchOptionsFor(target, signal));
  if (isUnreachable(result)) return { kind: 'unreachable' };
  const candidates = result.candidates;
  if (!candidates.length) return { kind: 'nothing' };
  if (isConfident(target, candidates[0], candidates)) return { kind: 'sure', candidate: candidates[0], candidates };
  return { kind: 'unsure', candidates };
}

export interface RunOptions {
  search: FolderSearch;
  /** The files of a folder, or null when they cannot be read. */
  files?: (folder: number) => Promise<FolderFiles | null>;
  signal?: AbortSignal;
  /** Folders at the same time, default 4. */
  concurrency?: number;
  onFind?: (target: BulkTarget, find: FolderFind) => void | Promise<void>;
}

/**
 * Finds covers for the folders, a few at a time (each service keeps its own
 * pace). Stops when `signal` aborts (rejects with an AbortError) and, like
 * the dialog, after the first two folders when no service answers at all:
 * returns "unreachable" then and leaves the rest for later.
 */
export async function findCovers(targets: readonly BulkTarget[], opts: RunOptions): Promise<'done' | 'unreachable'> {
  let next = 0;
  let answered = 0;
  let unreachable = 0;
  const stop = new AbortController();
  const follow = () => stop.abort();
  if (opts.signal?.aborted) throw abortError();
  opts.signal?.addEventListener('abort', follow, { once: true });
  const worker = async () => {
    while (next < targets.length && !stop.signal.aborted) {
      const target = targets[next++];
      let find: FolderFind;
      try {
        const files = opts.files ? await opts.files(target.folder).catch(() => null) : null;
        find = await findFolderCover(target, { search: opts.search, files, signal: stop.signal });
      } catch (e) {
        if (stop.signal.aborted) break;
        void e;
        find = { kind: 'unreachable' };
      }
      if (stop.signal.aborted) break;
      if (find.kind === 'unreachable') unreachable++;
      else if (find.kind !== 'local' && find.kind !== 'noName') answered++;
      await opts.onFind?.(target, find);
      if (!answered && unreachable >= 2) stop.abort();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(Math.max(1, opts.concurrency ?? 4), targets.length) }, worker));
  } finally {
    opts.signal?.removeEventListener('abort', follow);
  }
  if (opts.signal?.aborted) throw abortError();
  return !answered && unreachable >= 2 ? 'unreachable' : 'done';
}

// ---------------------------------------------------------------------------
// What the automatic run remembers per card

/** How a folder's last automatic try ended. */
export type TriedOutcome = 'saved' | 'local' | 'unsure' | 'nothing' | 'declined' | 'noName';

/** Per folder name ("05"): the name searched for, when, and how it ended. */
export type TriedFolders = Record<string, { q: string; at: number; outcome: TriedOutcome }>;

/** After this long a folder is tried again: hits to choose from may have become sure, a service may know the album now. */
const TRY_AGAIN_MS: Readonly<Record<TriedOutcome, number>> = {
  // A cover the run put on the card and that is gone now was taken off by someone: never again.
  saved: Infinity,
  local: Infinity,
  declined: Infinity,
  unsure: 24 * 3600_000,
  nothing: 7 * 24 * 3600_000,
  // Only a picture in the files could help; a new name is a new try anyway.
  noName: 7 * 24 * 3600_000,
};

/**
 * The folders worth a try now: not tried with this name, or long enough
 * ago for an outcome that may change. A folder whose name changed is a new
 * folder for this.
 */
export function foldersToTry<T extends Pick<BulkTarget, 'folder' | 'query'>>(targets: readonly T[], tried: TriedFolders, now: number, nameOf: (folder: number) => string): T[] {
  return targets.filter((t) => {
    const last = tried[nameOf(t.folder)];
    if (!last || last.q !== t.query) return true;
    return now - last.at >= TRY_AGAIN_MS[last.outcome];
  });
}

/** The outcome to remember for a find, or null for one not worth remembering (no service answered: next time). */
export function outcomeOf(find: FolderFind): TriedOutcome | null {
  switch (find.kind) {
    case 'local':
      return 'local';
    case 'sure':
      return 'saved';
    case 'unsure':
      return 'unsure';
    case 'nothing':
      return 'nothing';
    case 'noName':
      return 'noName';
    default:
      return null;
  }
}
