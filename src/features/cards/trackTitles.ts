import { useEffect, useMemo, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { trackRows, type CatalogFolder, type CatalogTrack } from '../../core/tonuino/catalog';
import { readTrackInfo } from '../../core/library/tags';
import { checkedArtist, tidyName, titlesFromArtistField, type TrackNames } from '../../core/library/tidy';
import type { SdFolder } from '../../core/tonuino/sd';
import { card } from '../../app/state';
import { quietMoment } from '../../ui/quiet';

export type TagInfo = {
  title?: string;
  /** Length as the tags tell it (for VBR files without a Xing frame a guess). */
  durationSec?: number;
  artist?: string;
  albumArtist?: string;
  /** Length from the MP3 frames: the same the player shows (mp3DurationSec with the catalog's length). */
  exactSec?: number;
};
export type TrackRow = ReturnType<typeof trackRows>[number] & {
  /** The title is a guess ("automatisch erkannt"): from a shop's list or the artist field. */
  titleAuto?: boolean;
  /** The title is only the file's number ("Titel 3") or its name: worth a look in the internet. */
  untitled?: boolean;
  /** The length was checked against the MP3's frames just now. */
  durationExact?: boolean;
};

/**
 * What the files say, kept for the session: opening the folder again reads
 * nothing anew. Keyed by drive, folder, file and size, so a swapped file is
 * read again.
 */
const seen = new Map<string, TagInfo>();
const seenKey = (volume: string, folder: string, file: string, size: number) => `${volume}|${folder}|${file.toLowerCase()}|${size}`;

/** What the session knows of a file's tags, if it read them (or wrote them). */
export function knownTags(volume: string, folder: string, file: string, size: number): TagInfo | undefined {
  return seen.get(seenKey(volume, folder, file, size));
}

/** Counts tag edits in the app: an open folder takes the new tags then, also when a file kept its size. */
const tagEdits = signal(0);

/**
 * The app wrote new tags into these files ("Titel-Infos bearbeiten"): what
 * is kept of them now says what was written, under the new size, so the
 * folder page shows the new names and artist at once and reads nothing
 * again. The lengths stay, the sound did not change.
 */
export function noteWrittenTags(volume: string, folder: string, files: readonly { file: string; oldSize: number; size: number; title?: string; artist?: string; albumArtist?: string }[]): void {
  for (const f of files) {
    const before = seen.get(seenKey(volume, folder, f.file, f.oldSize));
    seen.delete(seenKey(volume, folder, f.file, f.oldSize));
    seen.set(seenKey(volume, folder, f.file, f.size), { ...before, title: f.title || undefined, artist: f.artist || undefined, albumArtist: f.albumArtist || undefined });
  }
  tagEdits.value++;
}

/**
 * Reads titles, artists and lengths from the files themselves, one after the
 * other, while the list shows what the catalog knows. For MP3s the length
 * comes from their frames, the same the player shows; the catalog's length
 * stays when the file confirms it (mp3DurationSec). Only kept in memory; the
 * folder page notes new findings in the catalog (useNoteFindings).
 */
function useFileTags(f: SdFolder | undefined, entry: CatalogFolder | undefined): { tags: Map<string, TagInfo>; done: boolean } {
  const [state, setState] = useState<{ tags: Map<string, TagInfo>; done: boolean }>({ tags: new Map(), done: false });
  const s = card.value;
  const root = s?.volume.root;
  const volume = s?.volume.id ?? '';
  // Read here, so a tag edit draws the folder again (see noteWrittenTags).
  const edits = tagEdits.value;
  useEffect(() => {
    if (!f || !root) {
      setState({ tags: new Map(), done: true });
      return;
    }
    const known = new Map((entry?.tracks ?? []).map((t) => [t.file.toLowerCase(), t]));
    const found = new Map<string, TagInfo>();
    for (const t of f.tracks) {
      const hit = seen.get(seenKey(volume, f.name, t.name, t.size));
      if (hit) found.set(t.name.toLowerCase(), hit);
    }
    // Tracks the catalog knows by name and exact length need no look: a folder opened before opens at once.
    const todo = f.tracks.filter((t) => {
      if (found.has(t.name.toLowerCase())) return false;
      const c = known.get(t.name.toLowerCase());
      return !(c?.title && c.durationExact && c.durationSec !== undefined && !swapped(c, t.size));
    });
    setState({ tags: new Map(found), done: !todo.length });
    if (!todo.length) return;
    const ctrl = new AbortController();
    void (async () => {
      const dir = await root.dir(f.name);
      const { mp3DurationSec } = await import('../../core/audio/mp3frames');
      let last = performance.now();
      for (const t of todo) {
        await quietMoment();
        if (ctrl.signal.aborted) return;
        const info: TagInfo = {};
        try {
          const source = await dir.source(t.name);
          try {
            const tags = await readTrackInfo(source, { cover: false, signal: ctrl.signal });
            Object.assign(info, { title: tags.title?.trim() || undefined, durationSec: tags.durationSec, artist: tags.artist, albumArtist: tags.albumArtist });
          } catch {
            // Unreadable tags are fine, the file name stays.
          }
          if (/\.mp3$/i.test(t.name)) {
            const c = known.get(t.name.toLowerCase());
            const listed = c && !swapped(c, t.size) ? c.durationSec : undefined;
            info.exactSec = await mp3DurationSec(source, listed ?? info.durationSec, ctrl.signal).catch(() => undefined);
          }
        } catch {
          // A file that cannot be opened keeps what the catalog says.
        }
        if (ctrl.signal.aborted) return;
        found.set(t.name.toLowerCase(), info);
        seen.set(seenKey(volume, f.name, t.name, t.size), info);
        // Shown in batches: each one draws the whole list again.
        if (performance.now() - last > 1500) {
          last = performance.now();
          setState({ tags: new Map(found), done: false });
        }
      }
      if (!ctrl.signal.aborted) setState({ tags: new Map(found), done: true });
    })().catch(() => undefined);
    return () => ctrl.abort();
    // Re-read when the files or their tags change, not on every catalog edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f, edits]);
  return state;
}

/** A file swapped elsewhere for another of the same name: the catalog knows another size. */
function swapped(c: CatalogTrack | undefined, size: number): boolean {
  return c?.size !== undefined && c.size !== size;
}

/**
 * The tracks of a folder with their titles: from the catalog, else from the
 * files' own tags (by lower-case file name), else from the artist field when
 * a downloader put the titles there (titlesFromArtistField), else from the
 * file name. Downloader names come off (tidyName). A track swapped elsewhere
 * takes the title and length of the new file; without a title in it, the
 * old name stays. The length from the frames wins over the catalog's.
 */
export function rowsWithTags(f: SdFolder, entry: CatalogFolder | undefined, tags: Map<string, TagInfo>): TrackRow[] {
  const base = trackRows(f, entry);
  const names: TrackNames[] = base.map((r) => tags.get(r.file.toLowerCase()) ?? {});
  const fromArtist = names.length && names.every((n, i) => n !== undefined && tags.has(base[i].file.toLowerCase())) ? titlesFromArtistField(names) : undefined;
  return base.map((r, i): TrackRow => {
    const t = tags.get(r.file.toLowerCase());
    const c = entry?.tracks.find((x) => x.file.toLowerCase() === r.file.toLowerCase());
    const own = tidyName(c?.title);
    const tagged = tidyName(t?.title);
    const guessed = fromArtist?.[i];
    if (swapped(c, r.size)) {
      const title = tagged || own || r.title;
      return { ...r, title, durationSec: t?.exactSec ?? t?.durationSec, untitled: nameless(title, r), durationExact: t?.exactSec !== undefined };
    }
    const title = own ?? tagged ?? guessed ?? r.title;
    return {
      ...r,
      title,
      durationSec: t?.exactSec ?? r.durationSec ?? t?.durationSec,
      durationExact: t?.exactSec !== undefined,
      titleAuto: own ? c?.titleAuto === true : !tagged && !!guessed,
      untitled: !guessed && nameless(title, r),
    };
  });
}

/** "Titel 3", "03", "003": a number, no name. */
function nameless(title: string, r: { number: number; file: string }): boolean {
  const t = title.trim();
  return !t || t === `Titel ${r.number}` || /^\d+$/.test(t) || t.toLowerCase() === r.file.replace(/\.[^.]+$/, '').toLowerCase();
}

/** rowsWithTags with the tags read from the card. Empty without a folder. */
export function useTrackRows(f: SdFolder | undefined, entry: CatalogFolder | undefined): TrackRow[] {
  return useTrackInfo(f, entry).rows;
}

/**
 * Rows plus what the files say about the folder: its artist checked against
 * all tracks (checkedArtist), and whether every file has been read.
 */
export function useTrackInfo(f: SdFolder | undefined, entry: CatalogFolder | undefined): { rows: TrackRow[]; tags: Map<string, TagInfo>; done: boolean; artist: string | undefined } {
  const { tags, done } = useFileTags(f, entry);
  const rows = useMemo(() => (!f ? [] : rowsWithTags(f, entry, tags)), [f, entry, tags]);
  const artist = useMemo(() => {
    // Only with every file read: a few tracks say nothing about the album's artist.
    if (!f || !done || f.tracks.some((t) => !tags.has(t.name.toLowerCase()))) return tidyName(entry?.artist);
    const names = f.tracks.map((t) => tags.get(t.name.toLowerCase()) ?? {});
    return checkedArtist(entry?.artist, names);
  }, [f, entry, tags, done]);
  return { rows, tags, done, artist };
}
