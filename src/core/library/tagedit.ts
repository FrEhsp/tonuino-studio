/**
 * Track infos (ID3 tags) of a folder on the card, edited on the folder page
 * (TODO 0.3 #46): what the dialog suggests, what it writes into each MP3,
 * and which files change at all. Pure functions; reading and writing the
 * files is the dialog's job (features/box/TagsDialog.tsx).
 *
 * Suggestions come from what is there already: the names the folder page
 * shows, the tags without downloader names (tidyName), the artist the folder
 * page found (album artist or most tracks), a shop's track list (withLookup).
 * They are marked `auto` ("automatisch erkannt") until someone types.
 */
import type { BasicTags, SmallTags } from '../audio/id3';
import type { CatalogFolder } from '../tonuino/catalog';
import { normalizeForMatch } from '../stickers/coversearch';
import { isNamelessTitle, looksBrokenTitleCase, recase, stripDownloaderNoise, tidyName } from './tidy';
import type { LookupAlbum } from './tracklookup';

/** One field of the dialog. */
export interface TagField {
  value: string;
  /** Filled in by the app ("automatisch erkannt"), not typed. */
  auto?: boolean;
  /** Typed in the dialog. */
  edited?: boolean;
  /** The tracks say different things: the field stays empty and each track keeps its own. */
  mixed?: boolean;
}

export interface TrackTagDraft {
  file: string;
  /** Number on the card (001.mp3 → 1). */
  number: number;
  /** Only MP3s whose tags could be read get new ones; others are shown as they are. */
  writable: boolean;
  title: TagField;
  /** The title is only a guess or a number: a shop's name may replace it (withLookup). */
  guessed?: boolean;
  track: TagField;
  /** Own artist; null: the folder's. */
  artist: TagField | null;
  /** Own album; null: the folder's. */
  album: TagField | null;
}

export interface TagDraft {
  artist: TagField;
  album: TagField;
  /** The rare ones behind "Mehr": written to every track only once filled in or typed. */
  albumArtist: TagField;
  year: TagField;
  genre: TagField;
  tracks: TrackTagDraft[];
}

/** What is known of a track when the dialog opens. */
export interface TagSource {
  file: string;
  number: number;
  /** An MP3 file. */
  mp3: boolean;
  /** What the file's tags say now; undefined when they could not be read (or no MP3). */
  tags?: BasicTags;
  /** The title the list shows. */
  title: string;
  /** That title is a guess (artist field, a shop's list). */
  titleAuto?: boolean;
  /** That title is only the number or the file name. */
  untitled?: boolean;
}

export type FolderTagField = 'artist' | 'album' | 'albumArtist' | 'year' | 'genre';
export type TrackTagField = 'title' | 'track' | 'artist' | 'album';

const same = (a: string | undefined, b: string | undefined) => !!a && !!b && normalizeForMatch(a) === normalizeForMatch(b);
const trimmed = (s: string | undefined) => s?.replace(/\s+/g, ' ').trim() ?? '';

/** The value most tracks name (case and punctuation aside), with how many name it and how many name any. */
function common(values: readonly (string | undefined)[]): { value?: string; count: number; present: number; agree: boolean } {
  const map = new Map<string, { value: string; count: number }>();
  let present = 0;
  for (const v of values) {
    if (!v) continue;
    present++;
    const key = normalizeForMatch(v) || v;
    const e = map.get(key);
    if (e) e.count++;
    else map.set(key, { value: v, count: 1 });
  }
  let best: { value: string; count: number } | undefined;
  for (const e of map.values()) if (!best || e.count > best.count) best = e;
  return { value: best?.value, count: best?.count ?? 0, present, agree: map.size <= 1 };
}

/**
 * recase, also when ours says more at the end: "Igel Sucht Den Mond
 * (Musik-Hörspiel)" with the catalog's "Igel sucht den Mond" becomes "Igel
 * sucht den Mond (Musik-Hörspiel)". Only for broken Title Case.
 */
export function recaseStart(ours: string, theirs: string | undefined): string {
  const whole = recase(ours, theirs);
  if (whole !== ours || !theirs || !looksBrokenTitleCase(ours)) return whole;
  const key = normalizeForMatch(theirs);
  if (!key) return ours;
  for (let i = 1; i < ours.length; i++) {
    // Only where a word ends.
    if (/[\p{L}\p{N}]/u.test(ours[i]) || !/[\p{L}\p{N}]/u.test(ours[i - 1])) continue;
    if (normalizeForMatch(ours.slice(0, i)) === key) return theirs.trim() + ours.slice(i);
  }
  return ours;
}

/** "Ordner 05": the name the app gives a folder it knows nothing about. */
function isDefaultFolderTitle(title: string | undefined): boolean {
  return !title || /^Ordner \d+$/.test(title.trim());
}

/** A field the tracks may disagree on: the value they all name, else empty and `mixed`. */
function rareField(raws: readonly (string | undefined)[]): TagField {
  const raw = common(raws.map((v) => trimmed(v) || undefined));
  if (!raw.present) return { value: '' };
  const tidy = common(raws.map((v) => tidyName(trimmed(v) || undefined)));
  if (!tidy.agree) return { value: '', mixed: true };
  const value = tidy.value ?? '';
  // Only a downloader's name taken off counts as a suggestion; a value most tracks have stays theirs.
  return raw.agree && value === raw.value ? { value } : { value, auto: true };
}

/**
 * The fields as the dialog opens: titles as the list shows them, the
 * folder's artist (`artist`, as the folder page found it) and album for all
 * tracks, own artists and albums only where a track really names another one.
 */
export function suggestTags(sources: readonly TagSource[], folder: { title?: string; artist?: string }): TagDraft {
  const tagged = sources.filter((s) => s.mp3 && s.tags);
  const raw = (k: keyof BasicTags) => tagged.map((s) => trimmed(s.tags![k]) || undefined);

  // Artist: the one the folder page shows (album artist or most tracks, see checkedArtist).
  const artistValue = tidyName(trimmed(folder.artist) || undefined) ?? '';
  const rawArtist = common(raw('artist'));
  const artist: TagField = { value: artistValue, ...(artistValue && artistValue !== rawArtist.value ? { auto: true } : {}) };

  // Album: what most tracks say, in the catalog's spelling when that is the same name; else the folder's name.
  const albums = common(raw('album').map((a) => tidyName(a)));
  const rawAlbum = common(raw('album'));
  let albumValue = albums.value && albums.count * 2 >= albums.present ? albums.value : '';
  if (!albumValue && !isDefaultFolderTitle(folder.title)) albumValue = stripDownloaderNoise(folder.title!);
  else if (albumValue && folder.title) albumValue = recaseStart(albumValue, folder.title);
  const album: TagField = { value: albumValue, ...(albumValue && albumValue !== rawAlbum.value ? { auto: true } : {}) };

  const tracks = sources.map((s): TrackTagDraft => {
    const t = s.tags ?? {};
    const rawTitle = trimmed(t.title);
    // The name the list shows; a mere number stays out of the file. Whatever differs from the file is a suggestion.
    const titleValue = s.untitled ? (tidyName(rawTitle || undefined) ?? '') : trimmed(s.title);
    const title: TagField = { value: titleValue, ...(titleValue !== rawTitle ? { auto: true } : {}) };
    const rawTrack = trimmed(t.track);
    const track: TagField = rawTrack ? { value: rawTrack } : { value: String(s.number), auto: true };
    const ownArtist = tidyName(trimmed(t.artist) || undefined);
    // An artist that is the track's own title was put there by a downloader: the folder's goes in.
    const keepArtist = !!ownArtist && !same(ownArtist, artist.value) && !same(ownArtist, title.value) && !same(ownArtist, rawTitle);
    const ownAlbum = tidyName(trimmed(t.album) || undefined);
    const keepAlbum = !!ownAlbum && !same(ownAlbum, album.value);
    return {
      file: s.file,
      number: s.number,
      writable: s.mp3 && !!s.tags,
      title,
      guessed: !!s.titleAuto || !!s.untitled || isNamelessTitle(title.value),
      track,
      artist: keepArtist ? { value: ownArtist!, ...(ownArtist !== trimmed(t.artist) ? { auto: true } : {}) } : null,
      album: keepAlbum ? { value: ownAlbum!, ...(ownAlbum !== trimmed(t.album) ? { auto: true } : {}) } : null,
    };
  });

  return {
    artist,
    album,
    albumArtist: rareField(raw('albumArtist')),
    year: rareField(raw('year')),
    genre: rareField(raw('genre')),
    tracks,
  };
}

/* ------------------------------------------------------------ typing */

/** A field of the whole folder, as typed. */
export function setFolderField(d: TagDraft, key: FolderTagField, value: string): TagDraft {
  return { ...d, [key]: { value, edited: true } };
}

/**
 * A field of one track, as typed. An artist or album typed the same as the
 * folder's goes back to following the folder.
 */
export function setTrackField(d: TagDraft, index: number, key: TrackTagField, value: string): TagDraft {
  const tracks = d.tracks.slice();
  const t = tracks[index];
  if (!t) return d;
  if (key === 'artist' || key === 'album') {
    const own = value.trim() === d[key].value.trim() ? null : { value, edited: true };
    tracks[index] = { ...t, [key]: own };
  } else {
    tracks[index] = { ...t, [key]: { value, edited: true }, ...(key === 'title' ? { guessed: false } : {}) };
  }
  return { ...d, tracks };
}

/** After saving: the fields of these files are in them now, no longer suggestions. */
export function settled(d: TagDraft, files: ReadonlySet<string>): TagDraft {
  const plain = (f: TagField): TagField => (f.auto ? { ...f, auto: false } : f);
  return {
    ...d,
    tracks: d.tracks.map((t) => (files.has(t.file) ? { ...t, title: plain(t.title), track: plain(t.track), artist: t.artist && plain(t.artist), album: t.album && plain(t.album) } : t)),
  };
}

/* ------------------------------------------------------------ the shop's list */

/**
 * Takes what a shop knows about the album (lookupAlbumTracks, same number of
 * tracks in the same order): names for tracks that only have a number or a
 * guess, the shop's spelling where ours is broken Title Case, the album's
 * spelling and an artist where none is given. Typed fields stay.
 */
export function withLookup(d: TagDraft, found: Pick<LookupAlbum, 'album' | 'artist' | 'tracks'>): { draft: TagDraft; titles: number; album: boolean; artist: boolean } {
  if (found.tracks.length !== d.tracks.length) return { draft: d, titles: 0, album: false, artist: false };
  let titles = 0;
  const tracks = d.tracks.map((t, i) => {
    const theirs = found.tracks[i].title.trim();
    if (!t.writable || !theirs || t.title.edited) return t;
    const ours = t.title.value.trim();
    const next = !ours || t.guessed || isNamelessTitle(ours) ? theirs : recase(ours, theirs);
    if (next === ours) return t;
    titles++;
    return { ...t, title: { value: next, auto: true }, guessed: true };
  });
  let album = d.album;
  if (!album.edited) {
    const ours = album.value.trim();
    const next = ours ? recaseStart(ours, found.album) : stripDownloaderNoise(found.album);
    if (next && next !== ours) album = { value: next, auto: true };
  }
  let artist = d.artist;
  const theirArtist = tidyName(found.artist?.trim() || undefined);
  if (!artist.edited && !artist.value.trim() && theirArtist) artist = { value: theirArtist, auto: true };
  return { draft: { ...d, tracks, album, artist }, titles, album: album !== d.album, artist: artist !== d.artist };
}

/* ------------------------------------------------------------ what gets written */

/** The tag set for one track: the dialog's fields, plus what the file had that the dialog does not show (CD, licence). */
export function tagsFor(d: TagDraft, index: number, current: BasicTags = {}): SmallTags {
  const t = d.tracks[index];
  // A rare field nobody filled in keeps each track's own value.
  const rare = (f: TagField, own: string | undefined) => (f.edited || f.auto ? f.value : own);
  const out: SmallTags = {
    title: t.title.value,
    artist: (t.artist ?? d.artist).value,
    albumArtist: rare(d.albumArtist, current.albumArtist),
    album: (t.album ?? d.album).value,
    track: t.track.value,
    disc: current.disc,
    year: rare(d.year, current.year),
    genre: rare(d.genre, current.genre),
    comment: keptComment(current.comment),
    copyright: current.copyright,
    copyrightUrl: current.copyrightUrl,
    sourceUrl: current.sourceUrl,
    // A spoken title in front of the sound stays noted, so it can be cut off again.
    announcement: current.announcement,
  };
  for (const k of Object.keys(out) as (keyof SmallTags)[]) {
    const v = trimmed(out[k] === undefined ? undefined : String(out[k]));
    if (v) (out as Record<string, string>)[k] = v;
    else delete out[k];
  }
  return out;
}

/** Comments worth keeping: not the numbers iTunes keeps there (iTunNORM and the like). */
function keptComment(c: string | undefined): string | undefined {
  const t = trimmed(c);
  return t && !/^[\s0-9a-f]+$/i.test(t) ? t : undefined;
}

/** The fields the dialog shows, as a file has them now and as they would be written. */
const SHOWN: readonly (keyof SmallTags & keyof BasicTags)[] = ['title', 'artist', 'albumArtist', 'album', 'track', 'year', 'genre'];

/** One file that gets new tags. */
export interface TagChange {
  file: string;
  tags: SmallTags;
}

/**
 * The files whose tags change: writable tracks where one of the shown fields
 * differs from what the file says now. `current` are the tags read from the
 * files, by file name.
 */
export function changedFiles(d: TagDraft, current: ReadonlyMap<string, BasicTags>): TagChange[] {
  const out: TagChange[] = [];
  d.tracks.forEach((t, i) => {
    if (!t.writable) return;
    const now = current.get(t.file) ?? {};
    const tags = tagsFor(d, i, now);
    if (SHOWN.some((k) => trimmed(tags[k] === undefined ? undefined : String(tags[k])) !== trimmed(now[k]))) out.push({ file: t.file, tags });
  });
  return out;
}

/* ------------------------------------------------------------ checks */

/** Track number as "3" or "3/12". */
export function validTrackNumber(v: string): boolean {
  const t = v.trim();
  return !t || /^\d{1,4}(?:\s*\/\s*\d{1,4})?$/.test(t);
}

/** A year: four digits. */
export function validYear(v: string): boolean {
  const t = v.trim();
  return !t || /^\d{4}$/.test(t);
}

/** True when every field can be written as it is. */
export function draftValid(d: TagDraft): boolean {
  return !draftProblem(d);
}

/**
 * The field that keeps the draft from being saved, for the line next to
 * „Speichern“: the year first (it hides behind „Mehr“), then the first track
 * number that is not one. Undefined when everything can be written.
 */
export function draftProblem(d: TagDraft): { field: 'year' } | { field: 'track'; file: string } | undefined {
  if (!validYear(d.year.value)) return { field: 'year' };
  const bad = d.tracks.find((t) => t.writable && !validTrackNumber(t.track.value));
  return bad ? { field: 'track', file: bad.file } : undefined;
}

/* ------------------------------------------------------------ the app's catalog */

/** A file that got new tags: its size before and after, and the title it has now. */
export interface Retagged {
  file: string;
  oldSize: number;
  size: number;
  title: string;
}

/**
 * Notes new tags in the catalog folder: titles as written (no longer a
 * guess), the new sizes so the files do not look swapped, and the folder's
 * new fingerprint when the old one matched the card before the write
 * (`fingerprint.before`); a folder changed elsewhere stays marked as such. `names` are the folder's new
 * name and artist, where they change (folderNamesAfter).
 */
export function noteRetagged(e: CatalogFolder, written: readonly Retagged[], opts: { fingerprint?: { before: string; after: string }; names?: { title?: string; artist?: string | null } } = {}): void {
  for (const w of written) {
    const t = e.tracks.find((x) => x.file.toLowerCase() === w.file.toLowerCase());
    const title = w.title.trim() || undefined;
    if (!t) {
      e.tracks.push({ file: w.file, ...(title ? { title } : {}), size: w.size });
      continue;
    }
    if (title) t.title = title;
    else delete t.title;
    delete t.titleAuto;
    if (t.size === undefined || t.size === w.oldSize) t.size = w.size;
  }
  if (opts.fingerprint && e.fingerprint === opts.fingerprint.before) e.fingerprint = opts.fingerprint.after;
  if (opts.names?.title) e.title = opts.names.title;
  if (opts.names && opts.names.artist !== undefined) {
    if (opts.names.artist) e.artist = opts.names.artist;
    else delete e.artist;
  }
  e.updatedAt = Date.now();
}

/**
 * The folder's name and artist after saving: the album typed in the dialog
 * becomes the folder's name when the folder was named after the album (or
 * had no name); the artist typed becomes the folder's. Untouched fields
 * change nothing.
 */
export function folderNamesAfter(folderTitle: string | undefined, start: TagDraft, d: TagDraft): { title?: string; artist?: string | null } {
  const out: { title?: string; artist?: string | null } = {};
  const album = d.album.value.trim();
  if (
    d.album.edited &&
    album &&
    album !== start.album.value.trim() &&
    (isDefaultFolderTitle(folderTitle) || same(folderTitle, start.album.value) || same(folderTitle, stripDownloaderNoise(start.album.value)))
  ) {
    out.title = album;
  }
  const artist = d.artist.value.trim();
  if (d.artist.edited && artist !== start.artist.value.trim()) out.artist = artist || null;
  return out;
}
