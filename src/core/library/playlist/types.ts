/**
 * A track list the user brings along (a Spotify data export, a CSV file, an
 * M3U playlist or plain text) and how its entries match the user's own
 * audio files. The app never talks to Spotify: it only reads files the user
 * chose, so nothing here touches a streaming service.
 */
import type { ByteSource } from '../../../platform/types';
import type { TrackInfo } from '../tags';

/** One entry of a track list, in list order. */
export interface ListEntry {
  /** 1-based position in the list. */
  position: number;
  title: string;
  /** Artists as the list names them, in order ("A, B" split up). */
  artists: string[];
  album?: string;
  durationSec?: number;
  isrc?: string;
  /** File name the list names (M3U), when there is one: the base name, without folders. */
  fileHint?: string;
  /** The whole path the list names (M3U), with "/" between folders, when it has folders. */
  filePath?: string;
}

/** A list found in what the user loaded. A Spotify export holds several. */
export interface TrackList {
  /** Stable within one load, e.g. "Playlist1.json#3". */
  id: string;
  name: string;
  /** Where it came from, for the user: "Spotify-Export", "CSV-Datei", "M3U-Playlist", "Text". */
  origin: string;
  entries: ListEntry[];
  /** Entries left out on purpose (podcast episodes, audiobooks, lines without a title, the rest over the limit), counted for a note. */
  skipped: number;
  /** Of the skipped ones: entries over the limit per list (songs, but too many). */
  truncated?: number;
}

/** Result of reading one chosen file (or pasted text). */
export interface ParseResult {
  lists: TrackList[];
  /** Why nothing could be read, in words for the user (German). Set when lists is empty. */
  problem?: string;
  /** Lists left out because there were too many of them. */
  omittedLists?: number;
}

/** One of the user's own audio files, as the matcher sees it. */
export interface LibraryFile {
  source: ByteSource;
  info?: TrackInfo & { isrc?: string };
}

export type MatchQuality = 'sicher' | 'unsicher' | 'fehlt';

export interface Candidate {
  file: LibraryFile;
  /** 0..1 */
  score: number;
  /** Why it matched: 'isrc' | 'name' | 'tags'. */
  reason: 'isrc' | 'name' | 'tags';
}

export interface EntryMatch {
  entry: ListEntry;
  quality: MatchQuality;
  /** The file chosen for this entry (best candidate, or the user's choice). None when missing. */
  chosen?: LibraryFile;
  /** Up to 5 best candidates, best first (for "unsicher" the user picks). */
  candidates: Candidate[];
  /** This entry repeats an earlier one of the list (same song twice): it is left out. */
  duplicateOf?: number;
}

/** A shop search for a missing entry. */
export interface ShopLink {
  shop: string;
  url: string;
}
