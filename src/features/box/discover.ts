import type { Catalog, CatalogFolder, CatalogTrack } from '../../core/tonuino/catalog';
import { pickArtist, tidyName, titlesFromArtistField } from '../../core/library/tidy';
import { CONTENT_KINDS } from '../../core/tonuino/catalog';
import { guessKind, titleFromFileName } from '../../core/library/grouping';
import { readTrackInfo, type TrackInfo } from '../../core/library/tags';
import { folderName, type SdFolder, type SdScan } from '../../core/tonuino/sd';
import type { Dir } from '../../platform/types';

/**
 * Folders copied with other programs have no catalog entry. Their tags often
 * know the album, artist and cover: read them and suggest an entry.
 */

export interface Discovered {
  folder: number;
  entry: CatalogFolder;
  cover?: { data: Uint8Array; mimeType: string };
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function discoverFolder(root: Dir, scan: SdScan, n: number, signal?: AbortSignal): Promise<Discovered | null> {
  const folder = scan.folders.find((f) => f.number === n);
  if (!folder || !folder.tracks.length) return null;
  const dir = await root.dir(folder.name);
  const infos = await pool(folder.tracks, 4, async (t) => {
    signal?.throwIfAborted();
    try {
      // Only the first track needs its cover.
      return await readTrackInfo(await dir.source(t.name), { cover: t === folder.tracks[0] });
    } catch {
      return {} as TrackInfo;
    }
  });
  return { folder: n, entry: entryFromTags(folder, infos), cover: infos[0]?.picture };
}

/**
 * The suggested entry for a folder from its tracks' tags (`infos`, in track
 * order). The album's name helps guessing what is in it ("Kinderlieder" is
 * no Hörspiel), the same way as when adding; a genre tag still comes first.
 */
export function entryFromTags(folder: SdFolder, infos: readonly TrackInfo[]): CatalogFolder {
  const first = infos[0] ?? {};
  const album = tidyName(first.album) ?? infos.map((i) => tidyName(i.album)).find(Boolean);
  const now = Date.now();
  const names = infos.map((i) => ({ title: i.title, artist: i.artist, albumArtist: i.albumArtist }));
  // No title tags, but each track names another "artist": a downloader put the titles there.
  const fromArtist = titlesFromArtistField(names);
  const tracks: CatalogTrack[] = folder.tracks.map((t, i) => {
    const tagged = tidyName(infos[i]?.title);
    const guessed = tagged ? undefined : fromArtist?.[i];
    const track: CatalogTrack = {
      file: t.name,
      title: tagged ?? guessed ?? (titleFromFileName(t.name) !== t.name.replace(/\.[^.]+$/, '') ? titleFromFileName(t.name) : undefined),
      durationSec: infos[i]?.durationSec,
    };
    if (guessed) track.titleAuto = true;
    return track;
  });
  const kind = guessKind(
    tracks.map((t, i) => ({ source: { name: t.file, size: 0, read: async () => new Uint8Array() }, info: infos[i], title: t.title ?? '' })),
    album ?? '',
  );
  return {
    title: album ?? `Ordner ${folderName(folder.number)}`,
    // The album artist or what most tracks name, never the artist of track 1 alone (often its title).
    artist: pickArtist(fromArtist ? names.map((n) => ({ ...n, artist: undefined })) : names),
    kind,
    card: { mode: CONTENT_KINDS.find((k) => k.id === kind)?.defaultMode ?? 2 },
    tracks,
    addedAt: now,
    updatedAt: now,
  };
}

export function unknownFolders(scan: SdScan, catalog: Catalog | null): number[] {
  return scan.folders.filter((f) => !catalog?.folders[f.name] && f.tracks.length).map((f) => f.number);
}
