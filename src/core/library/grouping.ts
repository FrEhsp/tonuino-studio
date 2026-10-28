import type { ByteSource } from '../../platform/types';
import type { TrimEdit } from '../audio/trimedit';
import type { TrackOrigin } from '../sources/origin';
import type { ContentKind } from '../tonuino/catalog';
import { MAX_TRACKS } from '../tonuino/sd';
import { extensionOf, type TrackInfo } from './tags';
import { pickArtist, tidyName, titlesFromArtistField } from './tidy';
import { cleanDownloadName } from './releasename';

/**
 * Turns a pile of dropped files into albums: one album per TonUINO folder.
 * Tags decide first, the folder structure second, file names last.
 */

export interface InputFile {
  source: ByteSource;
  info?: TrackInfo;
  /** Why the file cannot be used (not audio, damaged, a format this computer cannot convert), in words for the user. */
  error?: string;
  /** Source and licence of a file from "Entdecken". */
  origin?: TrackOrigin;
}

export interface DraftTrack {
  source: ByteSource;
  info?: TrackInfo;
  title: string;
  /** The title is a guess (from the artist field or a shop's track list), shown as "automatisch erkannt" until someone edits it. */
  titleAuto?: boolean;
  origin?: TrackOrigin;
  /** A whole album in one file: where its tracks start and what they are called (see albumcut.ts). */
  albumCuts?: AlbumCuts;
  /**
   * Cut before it went to the card („Zuschneiden …“ in the list, src/core/library/trimmed.ts):
   * `source` and `info` are the cut file in memory, this is the file as it came and the edit, to cut it again.
   */
  trimmed?: TrimmedFrom;
}

/** A title as it was before „Zuschneiden …“: the picked file and what was cut. */
export interface TrimmedFrom {
  source: ByteSource;
  info?: TrackInfo;
  albumCuts?: AlbumCuts;
  edit: TrimEdit;
}

/** The tracks of an album that came as one file, with the cuts already moved into the pauses. */
export interface AlbumCuts {
  /** Where the track list came from: "iTunes", "MusicBrainz" or "Cue-Datei". */
  from: string;
  /** In order; the first starts at 0. */
  tracks: { title: string; startSec: number }[];
}

/** "tracks": a file with albumCuts is cut at them, other long files at pauses. */
export type SplitMode = 'none' | 'chapters' | 'pauses' | 'tracks';

export interface AlbumDraft {
  id: string;
  title: string;
  artist?: string;
  kind: ContentKind;
  tracks: DraftTrack[];
  /** Cover found in the tags. */
  cover?: { data: Uint8Array; mimeType: string };
  durationSec?: number;
  /** How to cut long files (see isLongTrack) into shorter tracks. */
  split: SplitMode;
  /** Approximate track length in minutes when cutting at pauses. */
  splitMinutes: number;
  /** Part n of an album that had more than 255 tracks. */
  part?: { index: number; of: number };
  /** The publisher allows no changes: the files go to the card byte for byte (no loudness, tags, cutting or converting). */
  unchanged?: boolean;
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/** "01 - Intro_Teil 1.mp3" → "Intro Teil 1". */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '');
  const stripped = base.replace(/^\s*(cd\s*\d+\s*[-_.]\s*)?(track\s*)?\d{1,3}(?=[\s\-_.)]|$)\s*[-_.)]*\s*/i, '');
  const t = (stripped || base).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return t || base;
}

/** "Bibi Blocksberg/CD 2" → "Bibi Blocksberg"; drops disc folders. */
function albumFolder(relativePath: string | undefined): string | undefined {
  if (!relativePath) return undefined;
  const parts = relativePath.split('/').slice(0, -1);
  while (parts.length && /^(cd|disc|disk|teil|part)\s*\d+$/i.test(parts[parts.length - 1].trim())) parts.pop();
  return parts.length ? parts.join('/') : undefined;
}

function discFromPath(relativePath: string | undefined): number | undefined {
  const parts = relativePath?.split('/').slice(0, -1) ?? [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = /^(?:cd|disc|disk|teil|part)\s*(\d+)$/i.exec(parts[i].trim());
    if (m) return Number(m[1]);
  }
  return undefined;
}

function mostCommon(values: (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}

/** Genres of music, as tags and stores name them. */
const MUSIC_GENRES = /pop|rock|jazz|klassik|classical|soundtrack|schlager|folk|country|metal|indie|dance|electro|techno|house|hip ?hop|rap|r&b|soul|blues|reggae|punk|musical|latin|world|instrumental|alternative/;

/** What a name says about the album: "Hörbücher", "Hörspiele", "Schlaflieder", "Musik". Spoken words first, a name may hold both. */
function kindFromName(name: string): ContentKind | undefined {
  const n = name.toLowerCase();
  if (/hörspiel|hoerspiel/.test(n)) return 'hoerspiel';
  if (/hörb[uü]ch|hoerbu(e)?ch|audio ?book/.test(n)) return 'hoerbuch';
  if (/kinderlied|(?<!\bf)lieder/.test(n)) return 'lieder'; // not "Flieder"
  if (/\b(musik|music|songs?|hits|playlist|mixtape)\b/.test(n)) return 'musik';
  return undefined;
}

/**
 * Guesses what an album is: from the genre tag, then from its own name
 * (`name`: its folder and title, e.g. "Kinderlieder zum Mitsingen"), then
 * from long tracks and chapters, then from the folders around it
 * (`around`, innermost first: a book in "Musik/Hörbücher/…" is no music;
 * a collecting folder like "Musik" alone tells nothing), then from short tracks.
 */
export function guessKind(tracks: DraftTrack[], name = '', around: readonly string[] = []): ContentKind {
  const genre = mostCommon(tracks.map((t) => t.info?.genre?.toLowerCase())) ?? '';
  if (/hörspiel|hoerspiel|radio ?play/.test(genre)) return 'hoerspiel';
  if (/hörbuch|hoerbuch|audiobook|audio book|spoken|lesung|speech/.test(genre)) return 'hoerbuch';
  if (/kinderlied|children|kids|kinder/.test(genre)) return 'lieder';
  if (MUSIC_GENRES.test(genre)) return 'musik';
  const named = kindFromName(name);
  if (named) return named;
  const durations = tracks.map((t) => t.info?.durationSec).filter((d): d is number => d !== undefined);
  const total = durations.reduce((a, b) => a + b, 0);
  const avg = durations.length ? total / durations.length : 0;
  if (avg > 12 * 60 || (tracks.length <= 3 && total > 40 * 60)) return 'hoerbuch';
  if (tracks.some((t) => t.info?.chapters?.length)) return 'hoerbuch';
  for (const folder of around) {
    const kind = kindFromName(folder);
    // "Musik" or "Music" around an album is where everything lands, Hörspiele too: it says nothing about this one.
    if (kind && kind !== 'musik') return kind;
  }
  if (durations.length && avg < 6 * 60 && tracks.length >= 5) return 'musik';
  return 'hoerspiel';
}

let draftCounter = 0;

export function groupIntoAlbums(files: InputFile[], opts: { splitMinutes?: number } = {}): AlbumDraft[] {
  const usable = files.filter((f) => !f.error);
  // Without an album artist tag, the artist all files of an album in one folder share keeps
  // "Greatest Hits" of two artists apart; a compilation (several artists) stays together.
  const place = (f: InputFile) => `${albumFolder(f.source.relativePath)?.toLowerCase() ?? ''}|${tidyName(f.info?.album)?.toLowerCase()}`;
  const artistsAt = new Map<string, Set<string>>();
  for (const f of usable) {
    if (!f.info?.album || f.info.albumArtist) continue;
    const seen = artistsAt.get(place(f)) ?? new Set<string>();
    seen.add(f.info.artist?.toLowerCase() ?? '');
    artistsAt.set(place(f), seen);
  }
  const groups = new Map<string, InputFile[]>();
  for (const f of usable) {
    const album = tidyName(f.info?.album);
    const shared = album && !f.info?.albumArtist ? artistsAt.get(place(f)) : undefined;
    const artist = f.info?.albumArtist ?? (shared?.size === 1 ? [...shared][0] : undefined);
    const folder = albumFolder(f.source.relativePath);
    const key = album ? `tag:${(artist ?? '').toLowerCase()}|${album.toLowerCase()}` : folder ? `dir:${folder.toLowerCase()}` : 'loose';
    const g = groups.get(key) ?? [];
    g.push(f);
    groups.set(key, g);
  }

  const drafts: AlbumDraft[] = [];
  for (const [key, members] of groups) {
    members.sort((a, b) => {
      const da = a.info?.discNo ?? discFromPath(a.source.relativePath) ?? 1;
      const db = b.info?.discNo ?? discFromPath(b.source.relativePath) ?? 1;
      if (da !== db) return da - db;
      const ta = a.info?.trackNo;
      const tb = b.info?.trackNo;
      if (ta !== undefined && tb !== undefined && ta !== tb) return ta - tb;
      return collator.compare(a.source.relativePath ?? a.source.name, b.source.relativePath ?? b.source.name);
    });
    const names = members.map((m) => ({ title: m.info?.title, artist: m.info?.artist, albumArtist: m.info?.albumArtist }));
    // No title tags, but every track names another "artist": a downloader put the titles there.
    const fromArtist = titlesFromArtistField(names);
    const tracks: DraftTrack[] = members.map((f, i) => {
      const tagged = tidyName(f.info?.title);
      const guessed = tagged ? undefined : fromArtist?.[i];
      const t: DraftTrack = { source: f.source, info: f.info, title: tagged ?? guessed ?? titleFromFileName(f.source.name) };
      if (guessed) t.titleAuto = true;
      if (f.origin) t.origin = f.origin;
      return t;
    });
    const folder = albumFolder(members[0].source.relativePath);
    const folderTitle = folder?.split('/').pop();
    const named =
      mostCommon(members.map((m) => tidyName(m.info?.album))) ??
      (key.startsWith('dir:') ? folderTitle : undefined) ??
      (tracks.length === 1 ? tracks[0].title : 'Neues Album');
    // One file from a video site: its name without "| HÖRSPIEL DES MONATS OKTOBER [Xq7Lm2Pz9Rt]" (TODO 0.5 #81).
    const title = tracks.length === 1 && named === tracks[0].title ? cleanDownloadName(named) : named;
    // The album artist or what most tracks name; never the artist of track 1 alone, nor a title put into the artist field.
    const artist = fromArtist ? pickArtist(names.map((n) => ({ ...n, artist: undefined }))) : pickArtist(names);
    const cover = members.map((m) => m.info?.picture).find(Boolean);
    const durations = tracks.map((t) => t.info?.durationSec);
    const durationSec = durations.every((d) => d !== undefined) ? (durations as number[]).reduce((a, b) => a + b, 0) : undefined;
    const kind = guessKind(tracks, `${folderTitle ?? ''} ${named}`, folder?.split('/').slice(0, -1).reverse());
    const long = tracks.filter(isLongTrack);
    const split: SplitMode = long.length ? (long.every((t) => (t.info?.chapters?.length ?? 0) > 1) ? 'chapters' : 'pauses') : 'none';
    const base = { title, artist, kind, cover, split, splitMinutes: opts.splitMinutes ?? 5 };

    // The player plays at most 255 tracks per folder: spread bigger albums over several folders.
    const parts = Math.ceil(tracks.length / MAX_TRACKS);
    for (let p = 0; p < parts; p++) {
      const slice = tracks.slice(p * MAX_TRACKS, (p + 1) * MAX_TRACKS);
      drafts.push({
        ...base,
        id: `draft-${++draftCounter}`,
        title: parts > 1 ? `${title} (Teil ${p + 1})` : title,
        tracks: slice,
        durationSec: parts > 1 ? undefined : durationSec,
        part: parts > 1 ? { index: p + 1, of: parts } : undefined,
      });
    }
  }
  return drafts.sort((a, b) => collator.compare(a.title, b.title));
}

/** Files this long are worth cutting: the box only remembers the track, not the minute. */
export const LONG_TRACK_SEC = 20 * 60;

export function isLongTrack(t: DraftTrack): boolean {
  return (t.info?.durationSec ?? 0) > LONG_TRACK_SEC;
}

/** The file is a whole album whose track list is known. */
export function hasAlbumCuts(t: DraftTrack): boolean {
  return (t.albumCuts?.tracks.length ?? 0) > 1;
}

/** Files the cutting choice is about: long ones, and whole albums of any length. */
export function isCuttable(t: DraftTrack): boolean {
  return isLongTrack(t) || hasAlbumCuts(t);
}

/** A file up to this much longer than the wanted length stays whole when cutting at pauses. */
export const SPLIT_TOLERANCE = 0.35;

/** True when the file becomes several tracks: cut at its album's tracks or its chapters, or at pauses when it is clearly longer than the wanted length. */
export function isSplit(album: Pick<AlbumDraft, 'split' | 'splitMinutes'>, t: DraftTrack): boolean {
  if (cutAtTracks(album, t)) return true;
  if (album.split === 'none' || !isLongTrack(t)) return false;
  if (album.split === 'chapters' && (t.info?.chapters?.length ?? 0) > 1) return true;
  return (t.info?.durationSec ?? 0) > album.splitMinutes * 60 * (1 + SPLIT_TOLERANCE);
}

/** True when the file is cut at its album's tracks: their number is known, not estimated. */
export function cutAtTracks(album: Pick<AlbumDraft, 'split'>, t: DraftTrack): boolean {
  return album.split === 'tracks' && hasAlbumCuts(t);
}

/** Rough number of tracks after cutting, for the review screen. */
export function estimateTrackCount(album: Pick<AlbumDraft, 'tracks' | 'split' | 'splitMinutes'>): number {
  let n = 0;
  for (const t of album.tracks) {
    if (!isSplit(album, t)) n += 1;
    else if (cutAtTracks(album, t)) n += t.albumCuts!.tracks.length;
    else if (album.split === 'chapters' && (t.info?.chapters?.length ?? 0) > 1) n += t.info!.chapters!.length;
    else n += Math.max(2, Math.round((t.info?.durationSec ?? 0) / (album.splitMinutes * 60)));
  }
  return n;
}

/** True when the track can go to the card as it is (MP3), false when it has to be converted. */
export function isPlayableAsIs(t: DraftTrack): boolean {
  const codec = t.info?.codec;
  if (codec) return codec === 'mp3';
  return extensionOf(t.source.name) === 'mp3';
}
